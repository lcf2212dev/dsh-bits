/**
 * Durable orchestrating-bit selection for the Bit mode chat preset (v5.2).
 *
 * Bit mode (`bits-orchestrator`) is one Agent preset, but the user picks which
 * orchestrator bit orchestrates new chats. The pick is a single global
 * preference — not a per-session binding — persisted as
 * `<botsRoot>/orchestrator.json`:
 *
 *     { "version": 1, "bitId": "<bit id>" | null }
 *
 * The document is written atomically (sibling temporary file + fsync + rename)
 * with mode 0600, mirroring `host/store.js`. A missing, corrupt or
 * unknown-version document is ignored (corrupt files are renamed aside) and the
 * selection starts empty, so a broken preference can never take the plugin down.
 *
 * Candidates are the existing orchestrator bits plus the catalog orchestrator
 * characters that do not have a bit yet. Selecting a catalog character
 * provisions its bit through the normal bit store with the catalog defaults —
 * the same rule `bit_delegate` follows. Only orchestrator bits can orchestrate:
 * a worker target is refused with `BIT_NOT_ORCHESTRATOR`.
 *
 * The module never selects or pins a model/reasoning effort: the chosen bit
 * only contributes prompt text to the chat.
 *
 * @module host/orchestrator-selection
 */

import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Schema version of `orchestrator.json` this module understands. */
export const SELECTION_VERSION = 1

/** Document name inside `<botsRoot>`. */
export const SELECTION_FILE_NAME = 'orchestrator.json'

/** Hard cap of the candidate list advertised to the picker. */
const MAX_CANDIDATES = 50

/** Maximum length of the summary built from a bit's instructions. */
const MAX_SUMMARY_LENGTH = 160

/** Maximum number of candidate names suggested by a BIT_UNKNOWN error. */
const MAX_SUGGESTED_NAMES = 8

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
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Non-empty trimmed string, or `''`.
 *
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Candidate name of a bit/character record, falling back to its id.
 *
 * @param {Record<string, any>} record
 * @returns {string}
 */
function nameOf(record) {
  const name = isPlainObject(record) ? textOf(record.name) : ''
  if (name !== '') return name
  return isPlainObject(record) ? textOf(record.id) : ''
}

/**
 * First sentence of a free-form text (trimmed, whitespace collapsed, capped).
 * Falls back to the whole text when it has no sentence punctuation.
 *
 * @param {unknown} value
 * @returns {string}
 */
function firstSentence(value) {
  const text = textOf(value)
  if (text === '') return ''
  const match = text.match(/^[\s\S]*?[.!?](?=\s|$)/)
  const sentence = (match ? match[0] : text).replace(/\s+/g, ' ').trim()
  if (sentence.length <= MAX_SUMMARY_LENGTH) return sentence
  return `${sentence.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`
}

/**
 * English summary of a catalog character (`summary.en`), or `''`.
 *
 * @param {Record<string, any>} character
 * @returns {string}
 */
function catalogSummaryOf(character) {
  const summary = isPlainObject(character) && isPlainObject(character.summary) ? character.summary : null
  return summary !== null ? textOf(summary.en) : ''
}

/**
 * Avatar URL of a candidate: the catalog character when known, else the bit.
 *
 * @param {string} id
 * @returns {string}
 */
function avatarOf(id) {
  return `/api/bots.avatar?id=${encodeURIComponent(id)}`
}

/**
 * Create the durable Bit mode orchestrating-bit selection.
 *
 * `init()` loads the preference and never rejects. `ready` is the same promise,
 * so route handlers can just `await selection.ready` before answering.
 *
 * @param {{
 *   botsRoot: string,
 *   bits: any,
 *   catalog?: any,
 *   log?: (message: string) => void,
 * }} options
 *   `botsRoot` must be the absolute directory holding `orchestrator.json`
 *   (the same one the bit store uses); `catalog` is the loaded bit catalog.
 * @returns {{
 *   init: () => Promise<void>,
 *   ready: Promise<void>,
 *   currentBitId: () => string | null,
 *   currentBit: () => Record<string, any> | null,
 *   candidates: () => Array<Record<string, any>>,
 *   viewFor: (bitRecord: Record<string, any>) => Record<string, any>,
 *   select: (target: string | null) => Promise<{ bit: Record<string, any> | null, view: Record<string, any> | null }>,
 *   dispose: () => void,
 * }}
 */
export function createOrchestratorSelection({ botsRoot, bits, catalog = null, log = null } = {}) {
  if (typeof botsRoot !== 'string' || botsRoot.trim() === '' || !path.isAbsolute(botsRoot)) {
    throw new TypeError('createOrchestratorSelection: botsRoot must be an absolute path string')
  }
  if (!isPlainObject(bits) || typeof bits.list !== 'function' || typeof bits.get !== 'function') {
    throw new TypeError('createOrchestratorSelection: bits store with list()/get() is required')
  }
  const root = path.resolve(botsRoot)
  const file = path.join(root, SELECTION_FILE_NAME)
  const logMessage = (message) => {
    try {
      if (typeof log === 'function') log(message)
    } catch {
      // Logging must never break the selection.
    }
  }

  /** @type {string | null} */
  let bitId = null
  /** @type {Promise<void> | null} */
  let readyPromise = null
  /** Serializes selections so two POSTs can never interleave their writes. */
  let mutationChain = Promise.resolve()
  let disposed = false

  /* ------------------------------- loading -------------------------------- */

  /**
   * Rename an unusable document aside (`orchestrator.json.corrupt-<ts>`).
   *
   * @returns {Promise<void>}
   */
  async function renameAside() {
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      await fs.rename(file, backup)
      logMessage(`orchestrator selection: orchestrator.json was corrupt; moved it to ${backup}`)
    } catch (error) {
      logMessage(`orchestrator selection: could not move the corrupt orchestrator.json aside: ${messageOf(error)}`)
    }
  }

  /**
   * Load `<botsRoot>/orchestrator.json`. Missing/corrupt/unknown documents start
   * empty; the function never rejects (a broken preference is never fatal).
   *
   * @returns {Promise<void>}
   */
  async function load() {
    bitId = null
    try {
      await fs.mkdir(root, { recursive: true, mode: 0o700 })
    } catch (error) {
      logMessage(`orchestrator selection: could not create ${root}: ${messageOf(error)}`)
      return
    }
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logMessage(`orchestrator selection: could not read orchestrator.json: ${messageOf(error)}`)
      }
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = undefined
    }
    if (!isPlainObject(parsed)) {
      await renameAside()
      return
    }
    if (parsed.version !== SELECTION_VERSION) {
      logMessage(`orchestrator selection: unsupported orchestrator.json version ${JSON.stringify(parsed.version)}; started empty`)
      return
    }
    if (parsed.bitId === null) return
    if (typeof parsed.bitId !== 'string' || parsed.bitId.trim() === '') {
      logMessage('orchestrator selection: malformed bitId in orchestrator.json; started empty')
      return
    }
    bitId = parsed.bitId.trim()
  }

  /**
   * Start (once) and return the load promise.
   *
   * @returns {Promise<void>}
   */
  function init() {
    if (readyPromise === null) readyPromise = load()
    return readyPromise
  }

  /* ------------------------------- lookup --------------------------------- */

  /** @returns {Array<Record<string, any>>} deep copies, in store order */
  function listBits() {
    try {
      const records = bits.list()
      return Array.isArray(records) ? records.filter((record) => isPlainObject(record)) : []
    } catch (error) {
      logMessage(`orchestrator selection: bits.list() failed: ${messageOf(error)}`)
      return []
    }
  }

  /**
   * @param {string} id
   * @returns {Record<string, any> | null}
   */
  function getBit(id) {
    try {
      const record = bits.get(id)
      return isPlainObject(record) ? record : null
    } catch (error) {
      logMessage(`orchestrator selection: bits.get(${JSON.stringify(id)}) failed: ${messageOf(error)}`)
      return null
    }
  }

  /**
   * Catalog character by exact id, then by case-insensitive name.
   *
   * @param {string} raw trimmed target
   * @returns {Record<string, any> | null}
   */
  function resolveCharacter(raw) {
    if (!isPlainObject(catalog)) return null
    try {
      if (typeof catalog.get === 'function') {
        const exact = catalog.get(raw)
        if (isPlainObject(exact)) return exact
      }
    } catch {
      // Fall through to the flat list.
    }
    const rows = Array.isArray(catalog.bits) ? catalog.bits.filter((row) => isPlainObject(row)) : []
    const byId = rows.find((row) => row.id === raw)
    if (byId) return byId
    const wanted = raw.toLowerCase()
    return rows.find((row) => typeof row.name === 'string' && row.name.trim().toLowerCase() === wanted) || null
  }

  /**
   * Known catalog character of a record (`character` id), or `null`.
   *
   * @param {unknown} characterId
   * @returns {Record<string, any> | null}
   */
  function catalogCharacterOf(characterId) {
    const id = textOf(characterId)
    if (id === '' || !isPlainObject(catalog)) return null
    if (Array.isArray(catalog.bits)) {
      const row = catalog.bits.find((entry) => isPlainObject(entry) && entry.id === id)
      if (row) return row
    }
    try {
      if (typeof catalog.get === 'function') {
        const row = catalog.get(id)
        if (isPlainObject(row)) return row
      }
    } catch {
      // A broken catalog is not fatal here.
    }
    return null
  }

  /**
   * Existing bit of a catalog character (same normalized name preferred).
   *
   * @param {Record<string, any>} character
   * @returns {Record<string, any> | null}
   */
  function bitForCharacter(character) {
    const characterId = textOf(character.id)
    if (characterId === '') return null
    const matches = listBits().filter((record) => record.character === characterId)
    if (matches.length === 0) return null
    const wanted = nameOf(character).toLowerCase()
    return matches.find((record) => nameOf(record).toLowerCase() === wanted) || matches[0]
  }

  /* ------------------------------- views ---------------------------------- */

  /**
   * Candidate-shaped view of one stored bit record.
   *
   * @param {Record<string, any>} bitRecord
   * @returns {Record<string, any>}
   */
  function viewFor(bitRecord) {
    const record = isPlainObject(bitRecord) ? bitRecord : {}
    const id = textOf(record.id)
    const characterId = textOf(record.character)
    const character = catalogCharacterOf(characterId)
    const summary = character !== null ? catalogSummaryOf(character) : firstSentence(record.instructions)
    return {
      id,
      target: id,
      name: nameOf(record),
      character: characterId !== '' ? characterId : null,
      emoji: textOf(record.emoji),
      color: textOf(record.color),
      avatar: avatarOf(characterId !== '' ? characterId : id),
      summary,
      model: textOf(record.model),
      effort: textOf(record.effort),
      isExisting: true,
    }
  }

  /**
   * Candidate-shaped view of a catalog character that has no bit yet.
   *
   * @param {Record<string, any>} character
   * @returns {Record<string, any>}
   */
  function catalogCandidate(character) {
    const id = textOf(character.id)
    return {
      id,
      target: id,
      name: nameOf(character),
      character: id,
      emoji: textOf(character.emoji),
      color: textOf(character.color),
      avatar: avatarOf(id),
      summary: catalogSummaryOf(character),
      model: textOf(character.model),
      effort: textOf(character.effort),
      isExisting: false,
    }
  }

  /** @returns {Array<Record<string, any>>} catalog orchestrator characters, catalog order */
  function catalogOrchestratorCharacters() {
    if (!isPlainObject(catalog) || !Array.isArray(catalog.bits)) return []
    return catalog.bits.filter(
      (row) => isPlainObject(row) && row.isOrchestrator === true && typeof row.id === 'string' && typeof row.name === 'string',
    )
  }

  /**
   * Candidates advertised to the picker: existing orchestrator bits first (store
   * order), then catalog orchestrator characters without a bit (catalog order).
   * Catalog worker characters are never candidates; the list is capped.
   *
   * @returns {Array<Record<string, any>>}
   */
  function candidates() {
    const records = listBits()
    const represented = new Set()
    for (const record of records) {
      if (typeof record.character === 'string' && record.character !== '') represented.add(record.character)
    }
    const views = []
    for (const record of records) {
      if (record.isOrchestrator !== true) continue
      views.push(viewFor(record))
      if (views.length >= MAX_CANDIDATES) return views
    }
    for (const character of catalogOrchestratorCharacters()) {
      if (represented.has(character.id)) continue
      views.push(catalogCandidate(character))
      if (views.length >= MAX_CANDIDATES) break
    }
    return views
  }

  /* ----------------------------- selection -------------------------------- */

  /** @returns {string} candidate names for a BIT_UNKNOWN message */
  function availableNames() {
    const names = []
    for (const candidate of candidates()) {
      if (typeof candidate.name === 'string' && candidate.name !== '') names.push(candidate.name)
    }
    const unique = [...new Set(names)].slice(0, MAX_SUGGESTED_NAMES)
    return unique.length > 0 ? unique.join(', ') : 'none'
  }

  /**
   * Resolve a target string to an orchestrator bit, provisioning catalog
   * characters on first use.
   *
   * @param {string} wanted trimmed non-empty target
   * @returns {Promise<Record<string, any>>}
   */
  async function resolveTarget(wanted) {
    // 1. Existing bit by exact id.
    const direct = getBit(wanted)
    if (direct !== null) return direct
    // 2. Existing bit by case-insensitive name (first in store order).
    const lower = wanted.toLowerCase()
    const byName = listBits().find((record) => nameOf(record).toLowerCase() === lower)
    if (byName !== undefined) return byName
    // 3. Catalog character by exact id then case-insensitive name. An existing
    // bit of that character is reused; otherwise a worker character is refused
    // before provisioning, so an invalid pick never creates a bit as a side
    // effect.
    const character = resolveCharacter(wanted)
    if (character !== null) {
      const existing = bitForCharacter(character)
      if (existing !== null) return existing
      assertOrchestrator(character)
      if (typeof bits.create !== 'function') {
        throw codedError('ORCHESTRATOR_UNAVAILABLE', 'The bits store cannot create bits: it is not possible to provision this catalog character.')
      }
      const created = await bits.create({
        name: character.name,
        character: character.id,
        emoji: character.emoji,
        color: character.color,
        instructions: character.instructions,
        isOrchestrator: character.isOrchestrator === true,
        model: character.model,
        effort: character.effort,
      })
      logMessage(`orchestrator selection: provisioned catalog character ${character.id} as bit ${created && created.id}`)
      return created
    }
    throw codedError('BIT_UNKNOWN', `Unknown orchestrator bit "${wanted}". Available: ${availableNames()}.`)
  }

  /**
   * Refuse a resolved record that is not an orchestrator bit.
   *
   * @param {Record<string, any>} record
   * @returns {Record<string, any>}
   */
  function assertOrchestrator(record) {
    if (!isPlainObject(record) || record.isOrchestrator !== true) {
      throw codedError(
        'BIT_NOT_ORCHESTRATOR',
        `"${nameOf(record)}" is not an orchestrator bit: Bit mode chats are orchestrated by orchestrator bits. Available: ${availableNames()}.`,
      )
    }
    return record
  }

  /**
   * Persist the selection atomically (0600) and only then adopt it in memory.
   *
   * @param {string | null} nextBitId
   * @returns {Promise<void>}
   */
  async function persist(nextBitId) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    const contents = `${JSON.stringify({ version: SELECTION_VERSION, bitId: nextBitId }, null, 2)}\n`
    const serial = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
    const temporary = `${file}.tmp-${serial}`
    /** @type {import('node:fs/promises').FileHandle | undefined} */
    let handle
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.chmod(0o600)
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await fs.rename(temporary, file)
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch {
          // The original write error is the interesting one.
        }
      }
      try {
        await fs.rm(temporary, { force: true })
      } catch {
        // Best-effort cleanup; never mask the write error.
      }
      throw error
    }
    bitId = nextBitId
  }

  /**
   * Resolve, validate and persist a target (`null` clears the selection).
   *
   * @param {string | null} target
   * @returns {Promise<{ bit: Record<string, any> | null, view: Record<string, any> | null }>}
   */
  async function doSelect(target) {
    await init()
    if (target === null || target === undefined) {
      await persist(null)
      return { bit: null, view: null }
    }
    const wanted = typeof target === 'string' ? target.trim() : ''
    if (wanted === '') {
      throw codedError('BIT_UNKNOWN', `Unknown orchestrator bit ${JSON.stringify(String(target))}. Available: ${availableNames()}.`)
    }
    const record = assertOrchestrator(await resolveTarget(wanted))
    await persist(record.id)
    return { bit: record, view: viewFor(record) }
  }

  /**
   * Select one target (bit id/name or catalog character id/name) or clear the
   * selection. Selections are serialized so their writes never interleave.
   *
   * @param {string | null} target
   * @returns {Promise<{ bit: Record<string, any> | null, view: Record<string, any> | null }>}
   */
  function select(target) {
    const result = mutationChain.then(() => doSelect(target))
    mutationChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  return {
    init,
    get ready() {
      return init()
    },
    /** @returns {string | null} stored bit id (whether or not the bit still exists) */
    currentBitId() {
      return bitId
    },
    /** @returns {Record<string, any> | null} the selected bit record, if it still exists */
    currentBit() {
      if (bitId === null) return null
      return getBit(bitId)
    },
    candidates,
    viewFor,
    select,
    /** Release the in-memory selection (the persisted preference is kept). */
    dispose() {
      if (disposed) return
      disposed = true
      bitId = null
    },
  }
}
