/**
 * Durable session → team bindings for runnable teams.
 *
 * - Children created by `team_delegate` are bound `{ teamId, memberId, role: 'member' }`
 *   before the child exists (reserved child id), so `agent/created` already
 *   finds them, also on cold resume after a restart.
 * - Root sessions handed off by `team_handoff` are bound `{ teamId, role: 'lead' }`.
 * - Unbound root sessions fall back to the workspace-bound team (resolved by
 *   the runtime, not stored here).
 *
 * File: `<botsRoot>/team-bindings.json` (atomic tmp + rename, 0600). Reads are
 * synchronous from memory (tool guards and prompt sections are synchronous).
 *
 * @module host/team-bindings
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const MAX_BINDINGS = 5000
const ROLES = new Set(['lead', 'member'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate one stored binding; null when malformed. */
function cleanBinding(value) {
  if (!isPlainObject(value)) return null
  if (typeof value.teamId !== 'string' || value.teamId === '') return null
  const role = ROLES.has(value.role) ? value.role : 'member'
  return {
    teamId: value.teamId,
    memberId: typeof value.memberId === 'string' && value.memberId !== '' ? value.memberId : null,
    role,
    parentSession: typeof value.parentSession === 'string' ? value.parentSession : null,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
  }
}

export class TeamBindingStore {
  #file
  #bindings = new Map()
  #queue = Promise.resolve()

  /** @param {{ botsRoot: string }} options */
  constructor({ botsRoot }) {
    if (typeof botsRoot !== 'string' || !path.isAbsolute(botsRoot)) throw new TypeError('botsRoot must be absolute')
    this.#file = path.join(botsRoot, 'team-bindings.json')
  }

  get file() {
    return this.#file
  }

  async init() {
    await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 })
    let text
    try {
      text = await fs.readFile(this.#file, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      throw error
    }
    try {
      const parsed = JSON.parse(text)
      const sessions = isPlainObject(parsed) && isPlainObject(parsed.sessions) ? parsed.sessions : {}
      for (const [sessionId, raw] of Object.entries(sessions)) {
        const binding = cleanBinding(raw)
        if (binding) this.#bindings.set(sessionId, binding)
      }
    } catch {
      await fs.rename(this.#file, `${this.#file}.corrupt-${Date.now()}`).catch(() => {})
    }
  }

  /** @returns {{ teamId: string, memberId: string | null, role: 'lead' | 'member', parentSession: string | null, createdAt: string } | undefined} */
  get(sessionId) {
    const binding = this.#bindings.get(sessionId)
    return binding ? { ...binding } : undefined
  }

  list() {
    return [...this.#bindings.entries()].map(([sessionId, binding]) => ({ sessionId, ...binding }))
  }

  /** Bind (or rebind) a session; persists before resolving. */
  set(sessionId, binding) {
    const clean = cleanBinding({ createdAt: new Date().toISOString(), ...binding })
    if (!clean || typeof sessionId !== 'string' || sessionId === '') throw new TypeError('invalid team binding')
    this.#bindings.set(sessionId, clean)
    this.#prune()
    return this.#flush()
  }

  delete(sessionId) {
    if (!this.#bindings.delete(sessionId)) return Promise.resolve()
    return this.#flush()
  }

  /** Drop bindings of a deleted team. */
  forgetTeam(teamId) {
    let changed = false
    for (const [sessionId, binding] of this.#bindings) {
      if (binding.teamId === teamId) {
        this.#bindings.delete(sessionId)
        changed = true
      }
    }
    return changed ? this.#flush() : Promise.resolve()
  }

  #prune() {
    if (this.#bindings.size <= MAX_BINDINGS) return
    const ordered = [...this.#bindings.entries()].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt))
    for (const [sessionId] of ordered.slice(0, this.#bindings.size - MAX_BINDINGS)) this.#bindings.delete(sessionId)
  }

  #flush() {
    const run = async () => {
      const sessions = Object.fromEntries(this.#bindings)
      const body = JSON.stringify({ statusVersion: 1, sessions }, null, 2) + '\n'
      const tmp = `${this.#file}.tmp-${process.pid}-${Date.now()}`
      await fs.writeFile(tmp, body, { mode: 0o600 })
      await fs.rename(tmp, this.#file)
    }
    this.#queue = this.#queue.then(run, run)
    return this.#queue
  }
}
