/**
 * Bit mode: a chat Agent preset that delegates to Bits (v5.2).
 *
 * A Session whose *effective* Agent preset is `bits-orchestrator` becomes an
 * orchestrator chat: the runtime adds one agent-scoped prompt section (role,
 * delegation rules and the worker roster of the shipped catalog) and one
 * agent-scoped tool, `bit_delegate`, which runs one worker bit one-shot through
 * the bit runtime.
 *
 * The effective preset is the creation header (`session.header.agentPreset`)
 * advanced by every `agent-preset/selected` session event: DSH lets the user
 * pick the preset of a session that has not started its first turn yet, and
 * that selection is recorded in the log while the frozen creation header keeps
 * the old value. The preset registry exposes the recorded value
 * (`agentPresets.presetForSession(session)`); the runtime reads it on install
 * and reacts to the registry's `agent-preset/selected` host event, so a Bit mode
 * picked on an already-created blank chat is honored before its first turn.
 *
 * The user can also pick which orchestrator bit orchestrates new chats. That
 * pick is a single global preference owned by `host/orchestrator-selection.js`;
 * the prompt section text is rebuilt per turn, so the selected bit's persona,
 * summary and instructions apply from the next turn without re-installing the
 * section or pinning the chat's model/reasoning effort.
 *
 * Catalog characters are provisioned automatically with their preset model and
 * reasoning effort the first time they are delegated to; an existing bit of the
 * same character (or an existing bit with the same name) is reused as-is, with
 * the user's own model/effort edits. Orchestrator characters and orchestrator
 * bits are refused: the chat itself is the orchestrator and `bit_delegate` only
 * runs workers.
 *
 * The chat's own model and reasoning effort selection is never touched: the
 * mode only contributes prompt text and a tool.
 *
 * @module host/orchestrator
 */

/** Agent preset id a Session must record to become the orchestrator chat. */
export const ORCHESTRATOR_PRESET = 'bits-orchestrator'

/** Agent-scoped prompt section name. */
const SECTION_NAME = 'bits:orchestrator'
/** Prompt section order (same plane as the team policy: after persona, before tools). */
const SECTION_ORDER = 700
/** Agent-scoped tool that delegates one self-contained task to one worker bit. */
const TOOL_NAME = 'bit_delegate'
/** Diagnostics keeps only the most recent failures. */
const MAX_ERRORS = 40
/** Diagnostics keeps only the most recent notes. */
const MAX_NOTES = 20

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Display name of a bit record (falls back to its id). */
function nameOf(bit) {
  const name = bit && typeof bit.name === 'string' ? bit.name.trim() : ''
  return name !== '' ? name : (bit && typeof bit.id === 'string' ? bit.id : 'bit')
}

/**
 * The Agent preset id the creation header of a Session records, or `null` when
 * none was selected. The header is a creation fact: a preset selected later
 * lives in the session log and is read through the preset registry instead
 * (see {@link effectivePresetIdOfSession}).
 *
 * @param {any} session live Session (`agent.session`).
 * @returns {string | null} trimmed preset id.
 */
export function presetIdOfSession(session) {
  const header = session && typeof session === 'object' ? session.header : null
  const preset = header && typeof header === 'object' ? header.agentPreset : null
  return typeof preset === 'string' && preset.trim() !== '' ? preset.trim() : null
}

/**
 * Effective (recorded) Agent preset id of a live Agent's Session, or `null`.
 *
 * Prefers the preset registry projection, which starts at the creation header
 * and advances with every `agent-preset/selected` event, so a preset chosen on
 * an already-created blank chat is returned. Falls back to the creation header
 * when the registry is absent or cannot answer (e.g. a broken projection).
 *
 * @param {any} agent live Agent.
 * @param {any} [agentPresets] `agentPresets` service (`presetForSession`).
 * @returns {string | null} trimmed preset id.
 */
export function effectivePresetIdOfSession(agent, agentPresets = null) {
  const session = agent && typeof agent === 'object' ? agent.session : null
  if (agentPresets && typeof agentPresets.presetForSession === 'function') {
    try {
      const recorded = agentPresets.presetForSession(session)
      const preset = typeof recorded === 'string' ? recorded.trim() : ''
      if (preset !== '') return preset
    } catch {
      // A broken projection must never hide the creation header.
    }
  }
  return presetIdOfSession(session)
}

/**
 * Whether an Agent is a chat of the Bit mode preset (`bits-orchestrator`),
 * judged by its effective preset when the registry is available.
 *
 * @param {any} agent live Agent.
 * @param {any} [agentPresets] `agentPresets` service (`presetForSession`).
 * @returns {boolean}
 */
export function isOrchestratorSession(agent, agentPresets = null) {
  if (!agent || typeof agent !== 'object' || !agent.session) return false
  return effectivePresetIdOfSession(agent, agentPresets) === ORCHESTRATOR_PRESET
}

/**
 * `<backend>/<model> · <effort>` text of an invocation result. Mirrors
 * `resultRouteText` of `host/team-runtime.js` so both delegation paths report
 * the same header.
 *
 * @param {any} meta result metadata (`backend`, `model`, `effort`).
 * @returns {string}
 */
function resultRouteText(meta) {
  const backend = meta && meta.backend === 'claude-code' ? 'claude-code' : 'dsh'
  const model = meta && typeof meta.model === 'string' && meta.model !== '' ? meta.model : 'model'
  const short = backend === 'claude-code' ? model.replace(/^subscription\//, '') : model
  return meta && typeof meta.effort === 'string' && meta.effort !== '' ? `${backend}/${short} · ${meta.effort}` : `${backend}/${short}`
}

/** Catalog group display label, falling back to the group id. */
function groupLabelOf(catalog, groupId) {
  const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
  const group = groups.find((item) => item && item.id === groupId)
  const label = group && group.label && typeof group.label.en === 'string' ? group.label.en.trim() : ''
  return label !== '' ? label : 'Other'
}

/** One roster line: `- **Name** (`id`) — summary · preset: model · effort`. */
function rosterLine(bit) {
  const summary = bit && bit.summary && typeof bit.summary.en === 'string' ? bit.summary.en.trim() : ''
  const model = bit && typeof bit.model === 'string' && bit.model.trim() !== '' ? bit.model.trim() : 'default model'
  const effort = bit && typeof bit.effort === 'string' && bit.effort.trim() !== '' ? bit.effort.trim() : 'default'
  return `- **${bit.name}** (\`${bit.id}\`) — ${summary !== '' ? `${summary} · ` : ''}preset: ${model} · ${effort}`
}

/** Worker roster grouped by catalog group, in catalog order. */
function buildRoster(catalog) {
  const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
  const bits = catalog && Array.isArray(catalog.bits) ? catalog.bits : []
  const workers = bits.filter((bit) => bit && bit.isOrchestrator !== true && typeof bit.id === 'string' && typeof bit.name === 'string')
  const blocks = []
  const placed = new Set()
  for (const group of groups) {
    if (!group || typeof group.id !== 'string') continue
    const members = workers.filter((bit) => bit.group === group.id)
    if (members.length === 0) continue
    blocks.push([`### ${groupLabelOf(catalog, group.id)}`, ...members.map(rosterLine)])
    placed.add(group.id)
  }
  const ungrouped = workers.filter((bit) => !placed.has(bit.group))
  if (ungrouped.length > 0) blocks.push(['### Other', ...ungrouped.map(rosterLine)])
  return blocks.flat().join('\n')
}

/** Orchestrator character names of the catalog (they are never delegable). */
function orchestratorNamesOf(catalog) {
  const bits = catalog && Array.isArray(catalog.bits) ? catalog.bits : []
  return bits
    .filter((bit) => bit && bit.isOrchestrator === true && typeof bit.name === 'string' && bit.name.trim() !== '')
    .map((bit) => bit.name.trim())
}

/**
 * Catalog character of a selected bit (`character` id), or `null`.
 *
 * @param {any} catalog catalog returned by `loadBitCatalog` (may be empty).
 * @param {unknown} characterId bit record `character` field.
 * @returns {Record<string, any> | null}
 */
function catalogCharacterOf(catalog, characterId) {
  if (typeof characterId !== 'string' || characterId.trim() === '') return null
  try {
    if (catalog && typeof catalog.get === 'function') {
      const character = catalog.get(characterId)
      if (character && typeof character === 'object' && !Array.isArray(character)) return character
    }
  } catch {
    // Fall through to the flat list.
  }
  const rows = catalog && Array.isArray(catalog.bits) ? catalog.bits : []
  return rows.find((bit) => bit && typeof bit === 'object' && bit.id === characterId) || null
}

/** English summary of a catalog character (`summary.en`), or `''`. */
function summaryOfCharacter(character) {
  const summary = character && typeof character === 'object' ? character.summary : null
  return summary && typeof summary.en === 'string' ? summary.en.trim() : ''
}

/**
 * Full prompt section text of Bit mode, rebuilt per turn so the currently
 * selected orchestrating bit is reflected immediately.
 *
 * The selected bit contributes only its persona (heading + catalog summary +
 * instructions): its model/effort are never mentioned as the chat's route.
 *
 * @param {any} catalog catalog returned by `loadBitCatalog` (may be empty).
 * @param {Record<string, any> | null} [selectedBit] orchestrating bit record, or null.
 * @returns {string}
 */
function buildPromptText(catalog, selectedBit = null) {
  const roster = buildRoster(catalog)
  const orchestrators = orchestratorNamesOf(catalog)
  const orchestratorRule = orchestrators.length > 0
    ? `Orchestrator catalog characters (${orchestrators.join(', ')}) cannot be called one-shot — the mode itself is the orchestrator; use worker bits.`
    : 'Orchestrator catalog characters cannot be called one-shot — the mode itself is the orchestrator; use worker bits.'
  const bit = selectedBit && typeof selectedBit === 'object' && !Array.isArray(selectedBit) ? selectedBit : null
  const intro = bit === null
    ? 'You are a Bits orchestrator. This chat runs Bit mode: you receive the request, decide what to delegate, and return the final answer. The model and reasoning effort of this chat are the ones the user selected — this mode never changes them.'
    : `You are a Bits orchestrator. This chat runs Bit mode and is orchestrated by the bit **${nameOf(bit)}**: you assume its persona and instructions below, receive the request, decide what to delegate, and return the final answer. The model and reasoning effort of this chat are the ones the user selected — this mode never changes them.`
  /** @type {string[]} */
  let persona = []
  if (bit !== null) {
    const character = catalogCharacterOf(catalog, bit.character)
    const summary = summaryOfCharacter(character)
    const instructions = typeof bit.instructions === 'string' ? bit.instructions.trim() : ''
    persona = [`## Orchestrating bit: ${nameOf(bit)}`, '']
    if (summary !== '') persona.push(summary, '')
    if (instructions !== '') persona.push(instructions, '')
  }
  return [
    '# Bit mode',
    '',
    intro,
    '',
    ...persona,
    '## How delegation works',
    '',
    '`bit_delegate({ bit, task, read_only })` runs **one worker bit, one-shot** (request → response). The worker does **not** see this chat; write a self-contained task (goal + done criteria, workspace, context, files, constraints, return format). Workers run in this chat\'s working directory and return a text report.',
    '',
    '- `read_only` defaults to `true` (no edits/commands that need approval); pass `read_only: false` when the task must change files or run commands in the workspace.',
    '- Parallel calls are allowed when the tasks are independent.',
    '',
    '## Available bits',
    '',
    'Each catalog character already has a preset model and reasoning effort. Delegating to a catalog name/id **creates that bit automatically with its catalog preset** when no bit for that character exists; existing bits for the same character (or same name) are reused with the user\'s own model/effort edits. Bits can be customized later on the **Bits** page.',
    '',
    'Roster (worker bits you can delegate to, grouped by catalog group):',
    '',
    roster || '(the catalog is unavailable in this installation)',
    '',
    '## Work split',
    '',
    '- Answer the user directly for conversation, planning and questions; delegate implementation/research/review/execution to the right bits; synthesize their reports and state what was done. Do not delegate trivial replies.',
    '- Use the cheapest bit that fits each job: bit-scout for lookups and recon, bit-architect for plans, bit-builder or the matching specialist for implementation (bit-pixel-artist for pixel-art visuals), bit-runner for mechanical commands, bit-reviewer for an independent review and the tester bits for tests. Keep planning, brief writing, integration and the user-facing answer in this chat; do not do the implementation here (a one- or two-line fix you already fully understand is the only exception).',
    '- A review done by the same bit that implemented the change is not independent: for non-trivial deliveries delegate the final review (bit-reviewer) and the tests (bit-qa or a tester bit) to other bits, then integrate their evidence.',
    `- ${orchestratorRule}`,
    '',
  ].join('\n')
}

/**
 * Install the Bit mode runtime.
 *
 * Every Agent whose Session effective preset is `bits-orchestrator` — created
 * with the preset, created blank and switched to it before the first turn, or
 * already live when the plugin applies (HMR, resumed Sessions) — gets the
 * prompt section and the `bit_delegate` tool. Other Agents are untouched, and a
 * chat that switches away from the preset before its first turn is cleaned up.
 * All failures are logged and reported by `diagnostics()`; they never escape the
 * hooks.
 *
 * The effective preset is read from the `agentPresets` service projection
 * (`presetForSession`) when present, falling back to the creation header; the
 * registry's `agent-preset/selected` host event covers a preset picked on a
 * blank chat after its Agent already exists.
 *
 * The prompt section text is a function evaluated per turn, so a change of the
 * global orchestrating-bit selection applies from the next turn. Without a
 * `selection` dependency the generic prompt is used, exactly as before.
 *
 * @param {any} ctx host context (`ctx.on`, `ctx.agents`, `ctx.workingDirectory`, `ctx.get`).
 * @param {{
 *   bits: any,
 *   catalog: any,
 *   models: any,
 *   bitRuntime: any,
 *   selection?: { currentBit?: () => Record<string, any> | null } | null,
 *   log?: (message: string) => void,
 * }} deps
 *   live objects built by `index.js`; `models` is accepted for parity with the
 *   other runtimes and is not needed by this one; `selection` is the durable
 *   orchestrating-bit selection (`host/orchestrator-selection.js`).
 * @returns {{ diagnostics: () => { presetId: string, installed: Array<{ sessionId: string, tools: string[] }>, errors: string[], notes: string[] }, dispose: () => void }}
 */
export function installOrchestrator(ctx, deps = {}) {
  const { bits = null, catalog = null, bitRuntime = null, selection = null } = deps || {}
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const errors = []
  const notes = []
  /** @type {Map<object, { sessionId: string, tools: string[], disposers: Array<() => void> }>} */
  const installed = new Map()
  /** @type {Map<string, Promise<any>>} in-flight catalog provisioning per character id. */
  const creating = new Map()
  const disposers = []
  let disposed = false
  let selectionErrorNoted = false

  function noteError(message) {
    errors.push(`${new Date().toISOString()} ${message}`)
    if (errors.length > MAX_ERRORS) errors.shift()
    log(message)
  }

  function note(message) {
    notes.push(`${new Date().toISOString()} ${message}`)
    if (notes.length > MAX_NOTES) notes.shift()
    log(message)
  }

  /**
   * The profile's Agent preset registry, when the Host provides one. Read lazily
   * on every detection so the runtime works before/without it (the creation
   * header is the fallback) and so a reload picks up the live service.
   *
   * @returns {any | null}
   */
  function agentPresetsService() {
    try {
      const service = ctx && typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
      return service && typeof service.presetForSession === 'function' ? service : null
    } catch {
      return null
    }
  }

  /**
   * Live Agent of a Session id, when it is currently open. Used by the
   * `agent-preset/selected` hook, which reports the session id.
   *
   * @param {unknown} sessionId
   * @returns {any | null}
   */
  function liveAgentOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    try {
      const agents = ctx && ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
      if (!Array.isArray(agents)) return null
      return agents.find((agent) => agent && (agent.id === sessionId || (agent.session && agent.session.id === sessionId))) || null
    } catch {
      return null
    }
  }

  /**
   * Currently selected orchestrating bit, or `null`. Read on every prompt build,
   * so a selection change applies to the next turn; a broken selection must
   * never break prompt assembly (it is reported once).
   *
   * @returns {Record<string, any> | null}
   */
  function selectedBit() {
    if (!selection || typeof selection.currentBit !== 'function') return null
    try {
      const bit = selection.currentBit()
      return bit && typeof bit === 'object' && !Array.isArray(bit) ? bit : null
    } catch (error) {
      if (!selectionErrorNoted) {
        selectionErrorNoted = true
        noteError(`orchestrator selection failed: ${messageOf(error)}`)
      }
      return null
    }
  }

  /* ------------------------------- bit lookup ------------------------------- */

  function listBits() {
    try {
      return bits && typeof bits.list === 'function' ? bits.list() : []
    } catch {
      return []
    }
  }

  function getBit(id) {
    try {
      return bits && typeof bits.get === 'function' ? bits.get(id) : undefined
    } catch {
      return undefined
    }
  }

  /** Catalog character by exact id or case-insensitive name. */
  function catalogBit(raw) {
    if (typeof raw !== 'string' || raw === '' || catalog === null || typeof catalog !== 'object') return null
    try {
      if (typeof catalog.get === 'function') {
        const exact = catalog.get(raw)
        if (exact) return exact
      }
    } catch {
      // Fall through to the name lookup.
    }
    const wanted = raw.toLowerCase()
    const rows = Array.isArray(catalog.bits) ? catalog.bits : []
    return rows.find((bit) => bit && typeof bit.name === 'string' && bit.name.trim().toLowerCase() === wanted) || null
  }

  /** Existing bit provisioned for a catalog character (name match preferred). */
  function bitForCharacter(character) {
    if (!character || typeof character.id !== 'string' || character.id === '') return null
    const candidates = listBits().filter((bit) => bit && bit.character === character.id)
    if (candidates.length === 0) return null
    const wanted = typeof character.name === 'string' ? character.name.trim().toLowerCase() : ''
    return candidates.find((bit) => nameOf(bit).toLowerCase() === wanted) || candidates[0]
  }

  /** Worker bit or a coded error; the orchestrator chats never call orchestrators. */
  function assertWorker(bit) {
    if (bit && bit.isOrchestrator === true) {
      throw codedError(
        'BIT_IS_ORCHESTRATOR',
        `The bit "${nameOf(bit)}" is an orchestrator: bit_delegate only runs worker bits one-shot. This chat is already the orchestrator — delegate to a worker bit instead.`,
      )
    }
    return bit
  }

  /** Create (once per character) the bit of a catalog character with its preset. */
  async function ensureCatalogBit(character) {
    const existing = bitForCharacter(character)
    if (existing) return existing
    const pending = creating.get(character.id)
    if (pending !== undefined) return pending
    if (!bits || typeof bits.create !== 'function') {
      throw codedError('BIT_DELEGATE_UNAVAILABLE', 'The bits store is not available in this Harness: it is not possible to provision catalog bits.')
    }
    const creation = (async () => {
      // Re-check after entering the promise: another delegation may have created it.
      const current = bitForCharacter(character)
      if (current) return current
      return bits.create({
        name: character.name,
        character: character.id,
        emoji: character.emoji,
        color: character.color,
        instructions: character.instructions,
        isOrchestrator: character.isOrchestrator === true,
        model: character.model,
        effort: character.effort,
        workspaceDir: undefined,
      })
    })()
    creating.set(character.id, creation)
    creation.then(() => creating.delete(character.id), () => creating.delete(character.id))
    return creation
  }

  /** Suggested names for a BIT_UNKNOWN error. */
  function availableNames() {
    const names = listBits().map((bit) => nameOf(bit))
    for (const bit of Array.isArray(catalog && catalog.bits) ? catalog.bits : []) {
      if (bit && bit.isOrchestrator !== true && typeof bit.name === 'string' && bit.name.trim() !== '') names.push(bit.name.trim())
    }
    return [...new Set(names.filter(Boolean))].slice(0, 8).join(', ') || 'none'
  }

  /**
   * Resolve the `bit` argument to a worker bit record, provisioning catalog
   * characters on first use.
   *
   * @param {string} rawBit trimmed `bit` argument.
   * @returns {Promise<Record<string, any>>} worker bit record.
   */
  async function resolveTarget(rawBit) {
    // 1. Existing bit by exact id.
    const direct = getBit(rawBit)
    if (direct !== undefined && direct !== null) return assertWorker(direct)
    // 2. Existing bit by case-insensitive name (first in store order; ambiguity is only noted).
    const wanted = rawBit.toLowerCase()
    const byName = listBits().filter((bit) => bit && typeof bit.name === 'string' && bit.name.trim().toLowerCase() === wanted)
    if (byName.length > 0) {
      if (byName.length > 1) note(`bit_delegate: ${byName.length} bits are named "${rawBit}"; using ${byName[0].id}.`)
      return assertWorker(byName[0])
    }
    // 3. Catalog character: an orchestrator character is never a one-shot target.
    const character = catalogBit(rawBit)
    if (character) {
      if (character.isOrchestrator === true) {
        throw codedError(
          'BIT_IS_ORCHESTRATOR',
          `"${character.name}" is an orchestrator character (${character.id}): it cannot be delegated one-shot; this chat itself is the orchestrator. Delegate to a worker bit instead.`,
        )
      }
      return assertWorker(await ensureCatalogBit(character))
    }
    throw codedError('BIT_UNKNOWN', `Unknown bit "${rawBit}". Pass a catalog name or id, or the name/id of an existing bit. Available: ${availableNames()}.`)
  }

  /* ------------------------------ session cwd ------------------------------ */

  /** This chat's working directory (session cwd, falling back to the process cwd). */
  function sessionCwdOf(agent) {
    const session = agent && agent.session ? agent.session : null
    try {
      if (ctx.workingDirectory && typeof ctx.workingDirectory.get === 'function') {
        const cwd = ctx.workingDirectory.get(session)
        if (typeof cwd === 'string' && cwd.trim() !== '') return cwd
      }
    } catch {
      // Fall through to the Session header.
    }
    const header = session && session.header
    if (header && typeof header.cwd === 'string' && header.cwd.trim() !== '') return header.cwd
    return process.cwd()
  }

  /* ------------------------------ delegation ------------------------------ */

  /** One `bit_delegate` execution: validate, resolve/provision, invoke, format. */
  async function delegate(agent, args, exec) {
    const rawBit = typeof args.bit === 'string' ? args.bit.trim() : ''
    if (rawBit === '') {
      throw codedError('BIT_DELEGATE_INVALID', 'bit_delegate: "bit" is required (a catalog character name/id, or the name/id of an existing bit).')
    }
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    if (task === '') {
      throw codedError('BIT_DELEGATE_INVALID', 'bit_delegate: "task" is required and must be self-contained (goal, done criteria, context and the expected report format).')
    }
    if (!bitRuntime || typeof bitRuntime.invokeWorker !== 'function') {
      throw codedError('BIT_DELEGATE_UNAVAILABLE', 'The bits runtime is not available in this Harness: it is not possible to run worker bits.')
    }
    const bit = await resolveTarget(rawBit)
    const readOnly = args.read_only !== false
    const cwd = sessionCwdOf(agent)
    let result
    try {
      result = await bitRuntime.invokeWorker({ bit, task, cwd, readOnly, signal: exec ? exec.signal : undefined })
    } catch (error) {
      if (exec && exec.signal && exec.signal.aborted) throw error
      throw codedError(
        error && typeof error.code === 'string' ? error.code : 'BIT_RUN_FAILED',
        `The bit "${nameOf(bit)}" failed: ${messageOf(error)}`,
      )
    }
    const text = result && typeof result.text === 'string' && result.text.trim() !== '' ? result.text.trim() : '(the bit ended without a response)'
    const meta = (result && result.meta) || {}
    // Header from the result metadata, exactly the team-delegation route text:
    // `[<bit> · <backend>/<model> · <effort>]`, then the worker report.
    return `[${nameOf(bit)} · ${resultRouteText(meta)}]\n\n${text}`
  }

  /** Cheap target hint for the call card (existing bit or catalog preset). */
  function targetHint(rawBit) {
    const wanted = typeof rawBit === 'string' ? rawBit.trim() : ''
    if (wanted === '') return null
    const direct = getBit(wanted)
    if (direct !== undefined && direct !== null) return direct
    const lower = wanted.toLowerCase()
    const byName = listBits().find((bit) => bit && typeof bit.name === 'string' && bit.name.trim().toLowerCase() === lower)
    return byName || catalogBit(wanted) || null
  }

  /** Call card title: `Bit delegate · <bit> · <model>/<effort>` when cheap enough. */
  function presentTitle(args) {
    const bit = targetHint(args && args.bit)
    if (!bit) return 'Bit delegate'
    const model = typeof bit.model === 'string' && bit.model.trim() !== '' ? bit.model.trim() : 'model'
    const effort = typeof bit.effort === 'string' && bit.effort.trim() !== '' ? bit.effort.trim() : 'default'
    return `Bit delegate · ${nameOf(bit)} · ${model}/${effort}`
  }

  /** Agent-scoped `bit_delegate` tool definition (plain object, team-runtime style). */
  function delegateTool(agent) {
    return {
      name: TOOL_NAME,
      description: [
        'Delegate one self-contained task to one bit and return its text report. A bit is a one-shot worker: it does not see this chat, only the task.',
        'The bit runs with its preset model and reasoning effort; delegating to a catalog character creates its bit automatically on first use (an existing bit is reused with its own model/effort).',
        'read_only defaults to true (read and research only); pass read_only: false when the task must change files or run commands in the workspace.',
        'Workers run in this chat\'s working directory. Independent delegations can be issued in the same response; they run in parallel.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          bit: { type: 'string', description: 'Catalog character name or id (e.g. "Builder", "bit-builder"), or the name/id of an existing bit.' },
          task: { type: 'string', description: 'Complete, self-contained task: goal and done criteria, workspace, context, files, constraints and the expected report format.' },
          read_only: { type: 'boolean', description: 'Default true: the bit may not edit files or run commands that need approval. Pass false when the task must change files or run commands.' },
        },
        required: ['bit', 'task'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      isConcurrencySafe: () => true,
      presentCall(args) {
        try {
          return { card: 'generic', title: presentTitle(args), rawInput: args }
        } catch {
          return { card: 'generic', title: 'Bit delegate', rawInput: args }
        }
      },
      async execute(args, exec) {
        const owner = (exec && exec.agent) || agent
        return delegate(owner, args || {}, exec || {})
      },
    }
  }

  /* ------------------------------- install -------------------------------- */

  /**
   * Give one Agent the Bit mode prompt section and tool.
   *
   * @param {any} agent live Agent.
   * @param {string | null} [presetId] preset reported by an event; when absent
   *   the effective preset is read from the registry projection / creation header.
   * @returns {void}
   */
  function install(agent, presetId = null) {
    if (disposed || !agent || installed.has(agent)) return
    const explicit = typeof presetId === 'string' ? presetId.trim() : ''
    const effective = explicit !== '' ? explicit : effectivePresetIdOfSession(agent, agentPresetsService())
    if (effective !== ORCHESTRATOR_PRESET) return
    const entry = { sessionId: agent.id, tools: [], disposers: [] }
    installed.set(agent, entry)
    try {
      entry.disposers.push(agent.ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        interpolate: false,
        text: () => buildPromptText(catalog, selectedBit()),
      }))
    } catch (error) {
      noteError(`orchestrator prompt for ${agent.id} failed: ${messageOf(error)}`)
    }
    try {
      const definition = delegateTool(agent)
      entry.disposers.push(agent.ctx.tools.register(definition))
      entry.tools.push(definition.name)
    } catch (error) {
      noteError(`${TOOL_NAME} for ${agent.id} failed: ${messageOf(error)}`)
    }
    if (entry.disposers.length === 0) {
      installed.delete(agent)
      return
    }
    log(`bits-orchestrator: agent ${agent.id} ready (${entry.tools.join(', ') || 'prompt only'})`)
  }

  function uninstall(agent) {
    const entry = installed.get(agent)
    if (!entry) return
    installed.delete(agent)
    for (const dispose of entry.disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        log(`orchestrator disposer failed: ${messageOf(error)}`)
      }
    }
  }

  /**
   * React to one committed preset of a live Agent: install under the Bit mode
   * preset, drop the section/tool under any other one.
   *
   * @param {any} agent live Agent.
   * @param {unknown} presetId committed preset id.
   * @returns {void}
   */
  function applyPreset(agent, presetId) {
    if (disposed || !agent) return
    const preset = typeof presetId === 'string' ? presetId.trim() : ''
    if (preset === ORCHESTRATOR_PRESET) install(agent, preset)
    else if (installed.has(agent)) uninstall(agent)
  }

  /** Install for Agents that were already live when the plugin applied. */
  function sweep() {
    let agents = []
    try {
      agents = ctx && ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
    } catch (error) {
      noteError(`orchestrator agent sweep failed: ${messageOf(error)}`)
      agents = []
    }
    for (const agent of Array.isArray(agents) ? agents : []) {
      try {
        install(agent)
      } catch (error) {
        noteError(`orchestrator install failed for ${agent && agent.id}: ${messageOf(error)}`)
      }
    }
  }

  try {
    disposers.push(ctx.on('agent/created', async ({ agent }) => {
      try {
        install(agent)
      } catch (error) {
        noteError(`orchestrator install failed for ${agent && agent.id}: ${messageOf(error)}`)
      }
    }))
  } catch (error) {
    noteError(`orchestrator agent/created hook registration failed: ${messageOf(error)}`)
  }
  try {
    disposers.push(ctx.on('agent/disposed', ({ agent }) => uninstall(agent)))
  } catch (error) {
    noteError(`orchestrator agent/disposed hook registration failed: ${messageOf(error)}`)
  }
  // A preset picked for an already-created blank Session is committed to the
  // log as `agent-preset/selected` and announced by the preset registry on this
  // host event; the creation header keeps the old value, so this hook is what
  // makes Bit mode work on chats that existed before the pick.
  try {
    disposers.push(ctx.on('agent-preset/selected', (sessionId, presetId) => {
      try {
        applyPreset(liveAgentOf(sessionId), presetId)
      } catch (error) {
        noteError(`orchestrator preset selection handling failed: ${messageOf(error)}`)
      }
    }))
  } catch (error) {
    noteError(`orchestrator agent-preset/selected hook registration failed: ${messageOf(error)}`)
  }
  sweep()
  // The preset registry may activate after this bundle: sweep once more when it
  // becomes available so a reload with blank Bit mode chats already open still
  // installs them (the creation header alone cannot tell their preset).
  try {
    if (ctx && typeof ctx.inject === 'function') {
      ctx.inject(['agentPresets'], () => {
        if (disposed) return
        try {
          sweep()
        } catch (error) {
          noteError(`orchestrator preset-ready sweep failed: ${messageOf(error)}`)
        }
      })
    }
  } catch (error) {
    noteError(`orchestrator preset-ready hook registration failed: ${messageOf(error)}`)
  }

  return {
    diagnostics() {
      const agents = []
      for (const started of installed.values()) {
        agents.push({ sessionId: started.sessionId, tools: [...started.tools] })
      }
      let selectionBitId = null
      try {
        const current = selection && typeof selection.currentBitId === 'function' ? selection.currentBitId() : null
        if (typeof current === 'string' && current !== '') selectionBitId = current
      } catch {
        // Diagnostics must never fail; a broken selection is reported by the prompt path.
      }
      return {
        presetId: ORCHESTRATOR_PRESET,
        installed: agents,
        errors: [...errors],
        notes: [...notes],
        selection: { bitId: selectionBitId },
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const agent of [...installed.keys()]) uninstall(agent)
      for (const dispose of disposers.reverse()) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (error) {
          log(`orchestrator disposer failed: ${messageOf(error)}`)
        }
      }
      creating.clear()
    },
  }
}
