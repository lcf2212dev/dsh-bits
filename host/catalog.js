/**
 * Bit character catalog for the Bots plugin.
 *
 * Every bot is created from one illustrated character ("bit"). The catalog
 * ships with the bundle in `bits/catalog.json` (display name, group, emoji,
 * accent color, picker summaries and the default instructions each bit starts
 * with) plus one avatar per bit in `bits/avatars/<id>.webp`.
 *
 * The module has no import-time side effects: `loadBitCatalog()` reads the
 * catalog synchronously when the plugin applies, and avatars are read lazily
 * and cached in memory.
 *
 * @module host/catalog
 */

import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Character id accepted by the store and the catalog: `bit-...`, lowercase. */
export const CHARACTER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Upper bound for one avatar file kept in memory. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {{ pt: string, en: string }}
 */
function localized(value) {
  const source = isPlainObject(value) ? value : {}
  const en = typeof source.en === 'string' ? source.en : ''
  const pt = typeof source.pt === 'string' ? source.pt : en
  return { pt, en: en || pt }
}

/**
 * Validate and normalize the parsed catalog document. Invalid entries are
 * dropped (never thrown) so one bad row cannot hide the whole picker.
 *
 * @param {unknown} document parsed `catalog.json`
 * @returns {{ version: number, groups: Array<Record<string, any>>, bits: Array<Record<string, any>> }}
 */
export function normalizeCatalog(document) {
  const source = isPlainObject(document) ? document : {}
  const groups = []
  const groupIds = new Set()
  for (const raw of Array.isArray(source.groups) ? source.groups : []) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || !CHARACTER_PATTERN.test(raw.id)) continue
    if (groupIds.has(raw.id)) continue
    groupIds.add(raw.id)
    groups.push({ id: raw.id, label: localized(raw.label) })
  }
  const bits = []
  const bitIds = new Set()
  for (const raw of Array.isArray(source.bits) ? source.bits : []) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || !CHARACTER_PATTERN.test(raw.id)) continue
    if (bitIds.has(raw.id)) continue
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : ''
    if (name === '') continue
    bitIds.add(raw.id)
    const emoji = typeof raw.emoji === 'string' && Array.from(raw.emoji).length >= 1 && Array.from(raw.emoji).length <= 8
      ? raw.emoji
      : '🤖'
    bits.push({
      id: raw.id,
      name,
      group: typeof raw.group === 'string' && groupIds.has(raw.group) ? raw.group : null,
      emoji,
      color: typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color) ? raw.color.toLowerCase() : '#475569',
      summary: localized(raw.summary),
      instructions: typeof raw.instructions === 'string' ? raw.instructions.slice(0, 20000) : '',
    })
  }
  return {
    version: typeof source.version === 'number' && Number.isFinite(source.version) ? source.version : 1,
    groups,
    bits,
  }
}

/**
 * Load the bit catalog shipped in `<directory>/catalog.json`.
 *
 * A missing or corrupt catalog yields an empty catalog plus `error`, so the
 * plugin keeps working (bots then fall back to their emoji avatar).
 *
 * @param {string} directory absolute directory holding `catalog.json` and `avatars/`
 * @returns {{
 *   version: number,
 *   groups: Array<Record<string, any>>,
 *   bits: Array<Record<string, any>>,
 *   error: string | null,
 *   has: (id: unknown) => boolean,
 *   get: (id: unknown) => Record<string, any> | undefined,
 *   readAvatar: (id: unknown) => Promise<Buffer>,
 * }}
 */
export function loadBitCatalog(directory) {
  let normalized = { version: 1, groups: [], bits: [] }
  let error = null
  try {
    normalized = normalizeCatalog(JSON.parse(readFileSync(path.join(directory, 'catalog.json'), 'utf8')))
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }
  const byId = new Map(normalized.bits.map((bit) => [bit.id, bit]))
  const avatarsDir = path.join(directory, 'avatars')
  /** @type {Map<string, Promise<Buffer>>} */
  const avatarCache = new Map()

  return {
    version: normalized.version,
    groups: normalized.groups,
    bits: normalized.bits,
    error,
    has(id) {
      return typeof id === 'string' && byId.has(id)
    },
    get(id) {
      return typeof id === 'string' ? byId.get(id) : undefined
    },
    /**
     * Read one avatar (WebP bytes). Only catalog ids are accepted, so the path
     * can never escape `avatars/`.
     */
    readAvatar(id) {
      if (typeof id !== 'string' || !byId.has(id)) {
        return Promise.reject(codedError('BIT_NOT_FOUND', `Unknown bit "${String(id)}"`))
      }
      let pending = avatarCache.get(id)
      if (pending === undefined) {
        pending = (async () => {
          const file = path.join(avatarsDir, `${id}.webp`)
          const stat = await fs.stat(file)
          if (!stat.isFile() || stat.size > MAX_AVATAR_BYTES) {
            throw codedError('BIT_AVATAR_INVALID', `Avatar for "${id}" is not a usable file`)
          }
          return fs.readFile(file)
        })()
        avatarCache.set(id, pending)
        // A failed read is not cached: the next request retries.
        pending.catch(() => avatarCache.delete(id))
      }
      return pending
    },
  }
}
