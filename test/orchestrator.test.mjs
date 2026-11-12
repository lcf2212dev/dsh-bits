/**
 * Bit mode runtime (v5.2) against a fake host context.
 *
 * Covers: preset detection from the Session header, per-Agent installation
 * (prompt section + `bit_delegate` tool), the English Bit mode prompt and its
 * worker roster (generic and with a selected orchestrating bit, rebuilt per
 * turn), delegation to existing bits and to catalog characters (auto-
 * provisioning with the catalog preset, reuse, concurrency dedupe),
 * orchestrator/unknown target errors, diagnostics and disposal.
 *
 * Plain `node test/orchestrator.test.mjs`; only Node built-ins are used.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BitStore } from '../host/store.js'
import { loadBitCatalog } from '../host/catalog.js'
import { createOrchestratorSelection } from '../host/orchestrator-selection.js'
import {
  ORCHESTRATOR_PRESET,
  effectivePresetIdOfSession,
  isOrchestratorSession,
  installOrchestrator,
  presetIdOfSession,
} from '../host/orchestrator.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG = loadBitCatalog(path.join(ROOT, 'bits'))
const WORKER_TOTAL = CATALOG.bits.filter((bit) => bit.isOrchestrator !== true).length

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const temps = []
async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

const execOf = (agent, name, args, signal) => ({
  name,
  arguments: args,
  agent,
  callId: 'call-1',
  signal: signal || new AbortController().signal,
})

const coded = (code, message) => Object.assign(new Error(message), { code })

/* ------------------------------ fixtures ------------------------------ */

async function makeBits() {
  const botsRoot = await tempDir('dsh-bits-orchestrator-bots-')
  const bits = new BitStore({ botsRoot, catalog: CATALOG })
  await bits.init()
  return { botsRoot, bits }
}

/**
 * Minimal host context: event bus, live Agent list, working directories and the
 * Agent-scoped prompt/tool registries. `bitRuntime.invokeWorker` records every
 * call and answers from `state.nextResult`, throws `state.nextError`, or returns
 * a default claude-code report. `failWorkingDirectory` and the per-Agent
 * `failSection`/`failRegister` switches feed the error-containment cases.
 *
 * `presets: true` adds an `agentPresets` service whose `presetForSession` answers
 * from `state.projections` (session id -> recorded preset), mirroring the DSH
 * projection that advances with `agent-preset/selected`; `failPresets` makes the
 * service throw instead.
 */
function fakeHost({ workspace, failWorkingDirectory = false, presets = false, failPresets = false }) {
  const listeners = {}
  const sections = new Map()
  const tools = new Map()
  const agents = []
  const calls = []
  const state = { nextResult: null, nextError: null, projections: new Map() }
  const agentPresets = presets === true
    ? {
        presetForSession(session) {
          if (failPresets) throw new Error('agentPresets projection unavailable')
          const id = session && typeof session === 'object' ? session.id : undefined
          return id === undefined ? null : state.projections.get(id) ?? null
        },
      }
    : null
  const ctx = {
    get(name) {
      return name === 'agentPresets' ? agentPresets : null
    },
    on(name, fn) {
      ;(listeners[name] = listeners[name] || []).push(fn)
      return () => {
        listeners[name] = listeners[name].filter((item) => item !== fn)
      }
    },
    agents: { list: () => [...agents] },
    workingDirectory: {
      get(session) {
        if (failWorkingDirectory) throw new Error('working directory service unavailable')
        return session && typeof session.cwd === 'string' ? session.cwd : undefined
      },
    },
  }
  const bitRuntime = {
    async invokeWorker(input) {
      calls.push(input)
      if (state.nextError !== null) {
        const error = state.nextError
        state.nextError = null
        throw error
      }
      if (state.nextResult !== null) {
        const result = state.nextResult
        state.nextResult = null
        return result
      }
      return {
        text: `report from ${input.bit.name}`,
        meta: { backend: 'claude-code', model: 'subscription/sonnet', effort: 'high' },
      }
    },
  }
  const emit = async (name, ...args) => {
    for (const fn of listeners[name] || []) await fn(...args)
  }
  function makeAgent(id, { preset = null, cwd = workspace, failSection = false, failRegister = false } = {}) {
    const agent = {
      id,
      session: {
        id,
        cwd,
        header: {
          ...(cwd === undefined ? {} : { cwd }),
          ...(preset === null ? {} : { agentPreset: preset }),
        },
      },
      ctx: {
        systemPrompt: {
          section(section) {
            if (failSection) throw new Error(`prompt registry unavailable for ${id}`)
            sections.set(id, section)
            return () => sections.delete(id)
          },
        },
        tools: {
          register(definition) {
            if (failRegister) throw new Error(`tool registry unavailable for ${id}`)
            const map = tools.get(id) || new Map()
            map.set(definition.name, definition)
            tools.set(id, map)
            return () => map.delete(definition.name)
          },
        },
      },
    }
    agents.push(agent)
    return agent
  }
  return { ctx, bitRuntime, state, sections, tools, agents, calls, emit, makeAgent, agentPresets }
}

/** A fresh bits store + host + runtime for the isolated edge cases. */
async function makeEdgeRuntime(hostOptions = {}) {
  const env2 = await makeBits()
  const workspace2 = await tempDir('dsh-bits-orchestrator-edge-')
  const host2 = fakeHost({ workspace: workspace2, ...hostOptions })
  const runtime2 = installOrchestrator(host2.ctx, {
    bits: env2.bits,
    catalog: CATALOG,
    models: {},
    bitRuntime: host2.bitRuntime,
    log: () => {},
  })
  return { env: env2, workspace: workspace2, host: host2, runtime: runtime2 }
}

/**
 * Mutable selection double: `bit` can be swapped between prompt builds to prove
 * the section text is dynamic. Mirrors the `host/orchestrator-selection.js` API
 * surface used by the runtime.
 */
function fakeSelection(bit = null) {
  const state = { bit }
  return {
    ready: Promise.resolve(),
    get bit() {
      return state.bit
    },
    set bit(next) {
      state.bit = next
    },
    currentBitId() {
      return state.bit === null ? null : state.bit.id
    },
    currentBit() {
      return state.bit
    },
    candidates() {
      return []
    },
  }
}

/** A fresh bits store + host + runtime installed with an orchestrating-bit selection. */
async function makeSelectionRuntime(selection) {
  const env2 = await makeBits()
  const workspace2 = await tempDir('dsh-bits-orchestrator-selected-')
  const host2 = fakeHost({ workspace: workspace2 })
  const runtime2 = installOrchestrator(host2.ctx, {
    bits: env2.bits,
    catalog: CATALOG,
    models: {},
    bitRuntime: host2.bitRuntime,
    selection,
    log: () => {},
  })
  return { env: env2, workspace: workspace2, host: host2, runtime: runtime2 }
}

/* -------------------------------- tests -------------------------------- */

await test('presetIdOfSession/isOrchestratorSession read the recorded Session preset only', () => {
  assert.equal(presetIdOfSession({ header: { agentPreset: ORCHESTRATOR_PRESET } }), 'bits-orchestrator')
  assert.equal(presetIdOfSession({ header: { agentPreset: '  bits-orchestrator  ' } }), 'bits-orchestrator')
  assert.equal(presetIdOfSession({ header: {} }), null)
  assert.equal(presetIdOfSession({}), null)
  assert.equal(presetIdOfSession(null), null)
  assert.equal(presetIdOfSession({ header: { agentPreset: '' } }), null)
  assert.equal(isOrchestratorSession({ session: { header: { agentPreset: ORCHESTRATOR_PRESET } } }), true)
  assert.equal(isOrchestratorSession({ session: { header: { agentPreset: 'standard' } } }), false)
  assert.equal(isOrchestratorSession({ session: { header: {} } }), false)
  assert.equal(isOrchestratorSession({}), false)
  assert.equal(isOrchestratorSession(null), false)
})

await test('the effective preset advances with agent-preset/selected beyond the creation header', () => {
  // DSH freezes the creation header but records a later pick in the log: the
  // registry projection is the truth for a blank session whose preset changed.
  const registry = {
    presetForSession(session) {
      if (session.id === 'picked') return ORCHESTRATOR_PRESET
      if (session.id === 'unpicked') return 'standard'
      return null
    },
  }
  const picked = { session: { id: 'picked', header: { agentPreset: 'standard' } } }
  const unpicked = { session: { id: 'unpicked', header: { agentPreset: ORCHESTRATOR_PRESET } } }
  assert.equal(presetIdOfSession(picked.session), 'standard', 'the header stays the creation fact')
  assert.equal(effectivePresetIdOfSession(picked, registry), ORCHESTRATOR_PRESET)
  assert.equal(isOrchestratorSession(picked, registry), true)
  assert.equal(effectivePresetIdOfSession(unpicked, registry), 'standard')
  assert.equal(isOrchestratorSession(unpicked, registry), false)
  // No registry / a broken projection falls back to the header.
  assert.equal(effectivePresetIdOfSession(picked), 'standard')
  assert.equal(effectivePresetIdOfSession(picked, null), 'standard')
  assert.equal(effectivePresetIdOfSession(picked, { presetForSession() { return null } }), 'standard')
  assert.equal(
    effectivePresetIdOfSession(picked, { presetForSession() { throw new Error('projection unavailable') } }),
    'standard',
  )
  assert.equal(effectivePresetIdOfSession(null, registry), null)
})

await test('a preset picked on an already-created blank Session installs and uninstalls the runtime', async () => {
  const env2 = await makeBits()
  const workspace2 = await tempDir('dsh-bits-orchestrator-picked-')
  const host2 = fakeHost({ workspace: workspace2, presets: true })
  const runtime2 = installOrchestrator(host2.ctx, {
    bits: env2.bits,
    catalog: CATALOG,
    models: {},
    bitRuntime: host2.bitRuntime,
    log: () => {},
  })
  try {
    // Created as a normal chat: no header preset, so nothing is installed yet.
    const blank = host2.makeAgent('picked-after-creation', { preset: 'standard' })
    await host2.emit('agent/created', { agent: blank, source: 'startup' })
    assert.equal(host2.sections.get(blank.id), undefined)
    assert.equal(host2.tools.get(blank.id)?.has('bit_delegate') ?? false, false)

    // The user selects Bit mode on the still-blank chat: the projection advances
    // and the registry announces the committed preset on the host event.
    host2.state.projections.set(blank.id, ORCHESTRATOR_PRESET)
    await host2.emit('agent-preset/selected', blank.id, ORCHESTRATOR_PRESET)
    assert.ok(host2.sections.get(blank.id), 'the Bit mode prompt section was not installed')
    assert.ok(host2.tools.get(blank.id)?.get('bit_delegate'), 'bit_delegate was not installed')
    assert.deepEqual(
      runtime2.diagnostics().installed,
      [{ sessionId: blank.id, tools: ['bit_delegate'] }],
      'diagnostics does not report the picked session',
    )

    // Switching back before the first turn removes the section and the tool.
    host2.state.projections.set(blank.id, 'standard')
    await host2.emit('agent-preset/selected', blank.id, 'standard')
    assert.equal(host2.sections.get(blank.id), undefined, 'the section survived the preset switch')
    assert.equal(host2.tools.get(blank.id)?.has('bit_delegate') ?? false, false, 'the tool survived the preset switch')
    assert.deepEqual(runtime2.diagnostics().installed, [])
  } finally {
    runtime2.dispose()
  }
})

await test('a picked Bit mode Agent live at install time is picked up by the sweep', async () => {
  const env2 = await makeBits()
  const workspace2 = await tempDir('dsh-bits-orchestrator-sweep-')
  const host2 = fakeHost({ workspace: workspace2, presets: true })
  const live = host2.makeAgent('live-picked', { preset: 'standard' })
  host2.state.projections.set(live.id, ORCHESTRATOR_PRESET)
  const runtime2 = installOrchestrator(host2.ctx, {
    bits: env2.bits,
    catalog: CATALOG,
    models: {},
    bitRuntime: host2.bitRuntime,
    log: () => {},
  })
  try {
    assert.ok(host2.sections.get(live.id), 'the sweep did not install the live picked Agent')
    assert.ok(host2.tools.get(live.id)?.get('bit_delegate'))
  } finally {
    runtime2.dispose()
  }
})

await test('a preset event for an unknown Session is inert and a broken registry falls back to the header', async () => {
  const edge = await makeEdgeRuntime({ presets: true, failPresets: true })
  try {
    await edge.host.emit('agent-preset/selected', 'does-not-exist', ORCHESTRATOR_PRESET)
    edge.host.state.projections.set('does-not-exist', ORCHESTRATOR_PRESET)
    assert.deepEqual(edge.runtime.diagnostics().installed, [])
    // The registry projection throws, the creation header still selects Bit mode.
    const byHeader = edge.host.makeAgent('header-orchestrator', { preset: ORCHESTRATOR_PRESET })
    await edge.host.emit('agent/created', { agent: byHeader, source: 'startup' })
    assert.ok(edge.host.tools.get(byHeader.id)?.get('bit_delegate'), 'header detection was lost when the registry throws')
    assert.deepEqual(edge.runtime.diagnostics().errors, [], 'a broken projection must be contained, not reported as an error')
  } finally {
    edge.runtime.dispose()
  }
})

const env = await makeBits()
const workspace = await tempDir('dsh-bits-orchestrator-ws-')
const host = fakeHost({ workspace })
// Already live before installation: the initial sweep must pick them up.
const earlyOrchestrator = host.makeAgent('orch-early', { preset: ORCHESTRATOR_PRESET })
const earlyStandard = host.makeAgent('standard-early', { preset: 'standard' })
const runtime = installOrchestrator(host.ctx, {
  bits: env.bits,
  catalog: CATALOG,
  models: {},
  bitRuntime: host.bitRuntime,
  log: () => {},
})

await test('only orchestrator Sessions get the prompt section and the bit_delegate tool', async () => {
  // Initial sweep (agent created before the plugin applied).
  assert.ok(host.sections.get('orch-early'), 'the sweep installed the already-live orchestrator session')
  assert.deepEqual([...host.tools.get('orch-early').keys()], ['bit_delegate'])
  assert.equal(host.sections.get('standard-early'), undefined)
  assert.equal(host.tools.get('standard-early'), undefined)
  // Later Agents through the agent/created hook.
  const later = host.makeAgent('orch-1', { preset: ORCHESTRATOR_PRESET })
  await host.emit('agent/created', { agent: later, source: 'startup' })
  const standard = host.makeAgent('standard-1', { preset: 'standard' })
  await host.emit('agent/created', { agent: standard, source: 'startup' })
  assert.ok(host.sections.get('orch-1'))
  assert.ok(host.tools.get('orch-1').get('bit_delegate'))
  assert.equal(host.sections.get('standard-1'), undefined)
  assert.equal(host.tools.get('standard-1'), undefined)
  // Agent-scoped prompt section configuration.
  const section = host.sections.get('orch-1')
  assert.equal(section.name, 'bits:orchestrator')
  assert.equal(section.order, 700)
  assert.equal(section.interpolate, false)
  assert.equal(typeof section.text, 'function')
})

await test('the prompt describes the role, delegation rules, read-only default and the worker roster', () => {
  const text = host.sections.get('orch-1').text()
  assert.match(text, /^# Bit mode/)
  assert.match(text, /You are a Bits orchestrator\./)
  assert.match(text, /The model and reasoning effort of this chat are the ones the user selected — this mode never changes them/)
  assert.match(text, /`bit_delegate\(\{ bit, task, read_only \}\)` runs \*\*one worker bit, one-shot\*\*/)
  assert.match(text, /`read_only` defaults to `true`/)
  assert.match(text, /pass `read_only: false` when the task must change files or run commands/)
  assert.match(text, /Parallel calls are allowed/)
  assert.match(text, /creates that bit automatically with its catalog preset/)
  // Worker roster: catalog group headings, names and preset model/effort.
  assert.match(text, /### Workers \(tasks\)/)
  assert.match(text, /### Quality & testing/)
  assert.match(text, /### Engineering/)
  assert.match(text, /- \*\*Builder\*\* \(`bit-builder`\) — Implements specified features.*preset: subscription\/sonnet · medium/)
  assert.match(text, /- \*\*Scout\*\* \(`bit-scout`\) — Finds files.*preset: subscription\/haiku · medium/)
  assert.match(text, /- \*\*Reviewer\*\* \(`bit-reviewer`\) — Adversarial reviewer.*preset: subscription\/opus · high/)
  assert.match(text, /- \*\*Pixel Artist\*\* \(`bit-pixel-artist`\) — .*preset: subscription\/sonnet · high/)
  const roster = text.split('## Available bits')[1].split('## Work split')[0]
  const entries = roster.split('\n').filter((line) => line.startsWith('- **'))
  assert.equal(entries.length, WORKER_TOTAL, 'only delegable worker characters are listed')
  for (const id of ['bit-manager', 'bit-product-owner', 'bit-coordinator', 'bit-sub-coordinator']) {
    assert.ok(!roster.includes(id), `${id} is not delegable one-shot`)
  }
  assert.match(text, /Orchestrator catalog characters \(Manager, Product Owner, Coordinator, Sub-coordinator\) cannot be called one-shot — the mode itself is the orchestrator; use worker bits/)
  // Delegation policy: do the orchestration, not the work; independent review.
  assert.match(text, /Use the cheapest bit that fits each job: bit-scout for lookups and recon/)
  assert.match(text, /bit-pixel-artist for pixel-art visuals/)
  assert.match(text, /do not do the implementation here/)
  assert.match(text, /A review done by the same bit that implemented the change is not independent/)
})

await test('the section text is rebuilt per turn from the selected orchestrating bit', async () => {
  const selection = fakeSelection()
  const edge = await makeSelectionRuntime(selection)
  try {
    const agent = edge.host.makeAgent('orch-selected', { preset: ORCHESTRATOR_PRESET })
    await edge.host.emit('agent/created', { agent, source: 'startup' })
    const section = edge.host.sections.get('orch-selected')
    assert.ok(section, 'the selected runtime installed its prompt section')
    // No bit selected: the generic Bit mode prompt.
    const generic = section.text()
    assert.match(generic, /^# Bit mode/)
    assert.doesNotMatch(generic, /## Orchestrating bit:/)
    assert.match(generic, /You are a Bits orchestrator\. This chat runs Bit mode: you receive the request/)
    assert.match(generic, /### Workers \(tasks\)/)
    assert.match(generic, /## Work split/)

    // A selected catalog orchestrator character contributes heading, catalog
    // summary and its own instructions.
    const manager = CATALOG.get('bit-manager')
    selection.bit = {
      id: 'bit-selected',
      name: 'App PO',
      character: 'bit-manager',
      emoji: manager.emoji,
      color: manager.color,
      instructions: 'Prefer small, verifiable steps.\nAlways name the owner.',
      isOrchestrator: true,
      model: 'deepseek-account/deepseek-flash',
      effort: 'max',
    }
    const selected = section.text()
    assert.match(selected, /^# Bit mode/)
    assert.match(selected, /You are a Bits orchestrator\. This chat runs Bit mode and is orchestrated by the bit \*\*App PO\*\*/)
    assert.equal(edge.runtime.diagnostics().selection.bitId, 'bit-selected', 'diagnostics reports the selected bitId')
    assert.match(selected, /## Orchestrating bit: App PO\n\n/)
    assert.ok(selected.includes(manager.summary.en), 'the catalog summary of the selected bit is included')
    assert.match(selected, /Prefer small, verifiable steps\.\nAlways name the owner\./)
    // Never route the chat through the bit's model/effort: the persona block has
    // no model/effort reference at all.
    const persona = selected.split('## Orchestrating bit: App PO')[1].split('## How delegation works')[0]
    assert.doesNotMatch(persona, /deepseek-account\/deepseek-flash|effort|model/i)
    // The delegation sections stay unchanged after the persona.
    assert.match(selected, /## How delegation works/)
    assert.match(selected, /## Available bits/)
    assert.match(selected, /## Work split/)

    // The Coordinator catalog persona spells out the delegation policy.
    const coordinator = CATALOG.get('bit-coordinator')
    selection.bit = {
      id: 'bit-orchestrating',
      name: 'Coordinator',
      character: 'bit-coordinator',
      emoji: coordinator.emoji,
      color: coordinator.color,
      instructions: coordinator.instructions,
      isOrchestrator: true,
      model: 'deepseek-account/deepseek-flash',
      effort: 'max',
    }
    const orchestrated = section.text()
    assert.match(orchestrated, /Do the orchestration, not the work/)
    assert.match(orchestrated, /bit-pixel-artist for pixel-art visuals/)
    assert.match(orchestrated, /a review by the implementing bit is not independent/)
    assert.match(orchestrated, /who did what/)

    // Clearing the selection reverts to the generic prompt on the next turn.
    selection.bit = null
    assert.doesNotMatch(section.text(), /## Orchestrating bit:/)
  } finally {
    edge.runtime.dispose()
  }
})

await test('a real selection store drives the prompt between turns', async () => {
  const env2 = await makeBits()
  const workspace2 = await tempDir('dsh-bits-orchestrator-real-selection-')
  const host2 = fakeHost({ workspace: workspace2 })
  const selection = createOrchestratorSelection({ botsRoot: env2.botsRoot, bits: env2.bits, catalog: CATALOG })
  await selection.init()
  const runtime2 = installOrchestrator(host2.ctx, {
    bits: env2.bits,
    catalog: CATALOG,
    models: {},
    bitRuntime: host2.bitRuntime,
    selection,
    log: () => {},
  })
  try {
    const agent = host2.makeAgent('orch-real-selection', { preset: ORCHESTRATOR_PRESET })
    await host2.emit('agent/created', { agent, source: 'startup' })
    const section = host2.sections.get('orch-real-selection')
    assert.doesNotMatch(section.text(), /## Orchestrating bit:/)
    const selected = await selection.select('Coordinator')
    assert.equal(selected.bit.character, 'bit-coordinator')
    assert.match(section.text(), /## Orchestrating bit: Coordinator/)
    assert.match(section.text(), /Turns PO goals into a plan/)
    assert.equal(runtime2.diagnostics().selection.bitId, selected.bit.id)
    await selection.select(null)
    assert.doesNotMatch(section.text(), /## Orchestrating bit:/)
  } finally {
    runtime2.dispose()
    selection.dispose()
  }
})

await test('a selected bit without a catalog character omits the summary line', async () => {
  const selection = fakeSelection({
    id: 'bit-custom',
    name: 'Custom Orchestrator',
    character: null,
    instructions: 'Only use worker bits for file edits.',
    isOrchestrator: true,
    model: 'deepseek-account/deepseek-flash',
    effort: 'max',
  })
  const edge = await makeSelectionRuntime(selection)
  try {
    const agent = edge.host.makeAgent('orch-custom', { preset: ORCHESTRATOR_PRESET })
    await edge.host.emit('agent/created', { agent, source: 'startup' })
    const text = edge.host.sections.get('orch-custom').text()
    assert.match(text, /## Orchestrating bit: Custom Orchestrator\n\nOnly use worker bits for file edits\.\n\n## How delegation works/)
  } finally {
    edge.runtime.dispose()
  }
})

await test('a broken selection falls back to the generic prompt and is reported once', async () => {
  const selection = {
    ready: Promise.resolve(),
    currentBit() {
      throw new Error('selection exploded')
    },
  }
  const edge = await makeSelectionRuntime(selection)
  try {
    const agent = edge.host.makeAgent('orch-broken-selection', { preset: ORCHESTRATOR_PRESET })
    await edge.host.emit('agent/created', { agent, source: 'startup' })
    const section = edge.host.sections.get('orch-broken-selection')
    assert.match(section.text(), /^# Bit mode/)
    assert.doesNotMatch(section.text(), /## Orchestrating bit:/)
    const reported = edge.runtime.diagnostics().errors.filter((line) => line.includes('selection exploded'))
    assert.equal(reported.length, 1, 'a broken selection is reported exactly once')
  } finally {
    edge.runtime.dispose()
  }
})

await test('the bit_delegate definition documents the delegation contract', async () => {
  const definition = host.tools.get('orch-1').get('bit_delegate')
  assert.equal(definition.name, 'bit_delegate')
  assert.deepEqual(definition.parameters.required, ['bit', 'task'])
  assert.equal(definition.parameters.properties.bit.type, 'string')
  assert.equal(definition.parameters.properties.task.type, 'string')
  assert.equal(definition.parameters.properties.read_only.type, 'boolean')
  assert.equal(definition.parameters.additionalProperties, false)
  assert.match(definition.description, /one-shot worker/)
  assert.match(definition.description, /preset model and reasoning effort/)
  assert.match(definition.description, /read_only defaults to true/)
  assert.match(definition.description, /run in parallel/)
  assert.equal(definition.isConcurrencySafe(), true)
  assert.equal(definition.output.schema.type, 'string')
  assert.deepEqual(definition.output.render({}, 'answer'), [{ type: 'text', text: 'answer' }])
  const card = definition.presentCall({ bit: 'Scout' })
  assert.equal(card.card, 'generic')
  assert.equal(card.title, 'Bit delegate · Scout · subscription/haiku/medium')
  // An existing bit: title from its stored model/effort.
  const cardBit = await env.bits.create({
    name: 'Card Worker',
    character: null,
    instructions: 'Cards.',
    model: 'subscription/opus',
    effort: 'xhigh',
  })
  assert.equal(definition.presentCall({ bit: cardBit.id }).title, 'Bit delegate · Card Worker · subscription/opus/xhigh')
  assert.equal(definition.presentCall({ bit: '  card WORKER ' }).title, 'Bit delegate · Card Worker · subscription/opus/xhigh')
  // Unknown and malformed arguments use the generic title and never throw.
  assert.equal(definition.presentCall({ bit: 'definitely not a bit' }).title, 'Bit delegate')
  assert.equal(definition.presentCall({}).title, 'Bit delegate')
  assert.equal(definition.presentCall(null).title, 'Bit delegate')
  assert.equal(definition.presentCall(undefined).title, 'Bit delegate')
  assert.equal(definition.presentCall({ bit: 42 }).title, 'Bit delegate')
  assert.equal(definition.presentCall('nonsense').title, 'Bit delegate')
})

await test('install errors are contained: the awaited hook resolves and failures land in diagnostics', async () => {
  const edge = await makeEdgeRuntime()
  try {
    // Both registries unavailable: the awaited agent/created listener must resolve.
    const broken = edge.host.makeAgent('orch-broken', { preset: ORCHESTRATOR_PRESET, failSection: true, failRegister: true })
    await edge.host.emit('agent/created', { agent: broken, source: 'startup' })
    // Only the prompt fails: the tool-only install is still reported.
    const toolOnly = edge.host.makeAgent('orch-tool-only', { preset: ORCHESTRATOR_PRESET, failSection: true })
    await edge.host.emit('agent/created', { agent: toolOnly, source: 'startup' })
    // Only the tool fails: the prompt-only install is still reported.
    const promptOnly = edge.host.makeAgent('orch-prompt-only', { preset: ORCHESTRATOR_PRESET, failRegister: true })
    await edge.host.emit('agent/created', { agent: promptOnly, source: 'startup' })
    // A Session whose header getter throws must not reject the hook either.
    const headerThrows = edge.host.makeAgent('orch-header-throws', { preset: ORCHESTRATOR_PRESET })
    Object.defineProperty(headerThrows.session, 'header', {
      get() {
        throw new Error('frozen header unavailable')
      },
    })
    await edge.host.emit('agent/created', { agent: headerThrows, source: 'startup' })

    const diagnostics = edge.runtime.diagnostics()
    assert.ok(diagnostics.errors.some((line) => line.includes('orch-broken') && line.includes('prompt')), 'prompt failure reported')
    assert.ok(diagnostics.errors.some((line) => line.includes('orch-broken') && line.includes('bit_delegate')), 'tool failure reported')
    assert.ok(diagnostics.errors.some((line) => line.includes('orch-header-throws')), 'header getter failure reported')
    const installed = Object.fromEntries(diagnostics.installed.map((entry) => [entry.sessionId, entry]))
    assert.deepEqual(installed['orch-tool-only'], { sessionId: 'orch-tool-only', tools: ['bit_delegate'] }, 'tool-only install reported')
    assert.deepEqual(installed['orch-prompt-only'], { sessionId: 'orch-prompt-only', tools: [] }, 'prompt-only install reported')
    assert.equal(installed['orch-broken'], undefined, 'a fully failed install is never listed')
    assert.ok(edge.host.sections.get('orch-prompt-only'), 'the prompt section of the prompt-only install stays active')
    assert.equal(edge.host.tools.get('orch-prompt-only')?.has('bit_delegate') ?? false, false)
  } finally {
    edge.runtime.dispose()
  }
})

await test('bit_delegate falls back to the Session header cwd and then to the process cwd', async () => {
  const edge = await makeEdgeRuntime({ failWorkingDirectory: true })
  try {
    const worker = await edge.env.bits.create({
      name: 'Cwd Worker',
      character: null,
      instructions: 'Find the working directory.',
      model: 'subscription/haiku',
      effort: 'low',
    })
    const headerCwd = path.join(edge.workspace, 'header-cwd')
    const agent = edge.host.makeAgent('orch-cwd', { preset: ORCHESTRATOR_PRESET, cwd: headerCwd })
    agent.session.cwd = '/wrong/session/cwd' // ctx.workingDirectory.get throws: the header must win
    await edge.host.emit('agent/created', { agent, source: 'startup' })
    const definition = edge.host.tools.get('orch-cwd').get('bit_delegate')
    await definition.execute({ bit: worker.id, task: 'Where am I?' }, execOf(agent, 'bit_delegate', {}))
    assert.equal(edge.host.calls.at(-1).cwd, headerCwd)
    // Missing/blank Session cwd: the process cwd is used.
    agent.session.cwd = undefined
    agent.session.header.cwd = '   '
    await definition.execute({ bit: worker.id, task: 'Where am I?' }, execOf(agent, 'bit_delegate', {}))
    assert.equal(edge.host.calls.at(-1).cwd, process.cwd())
  } finally {
    edge.runtime.dispose()
  }
})

await test('bit_delegate uses an existing bit by id or name, the session cwd and the read-only default', async () => {
  const bit = await env.bits.create({
    name: 'Repo Builder',
    character: null,
    emoji: '🛠️',
    color: '#123456',
    instructions: 'Build the repository.',
    model: 'subscription/opus',
    effort: 'xhigh',
  })
  const definition = host.tools.get('orch-1').get('bit_delegate')
  const agent = host.agents.find((item) => item.id === 'orch-1')
  const signal = new AbortController().signal
  const output = await definition.execute({ bit: bit.id, task: 'Implement X' }, execOf(agent, 'bit_delegate', {}, signal))
  assert.equal(host.calls.length, 1)
  assert.equal(host.calls[0].bit.id, bit.id)
  assert.equal(host.calls[0].task, 'Implement X')
  assert.equal(host.calls[0].cwd, workspace)
  assert.equal(host.calls[0].readOnly, true)
  assert.equal(host.calls[0].signal, signal)
  assert.equal(output, '[Repo Builder · claude-code/sonnet · high]\n\nreport from Repo Builder')
  // Same bit by case-insensitive trimmed name; read_only: false is forwarded.
  await definition.execute({ bit: '  repo BUILDER  ', task: 'Implement Y', read_only: false }, execOf(agent, 'bit_delegate', {}))
  assert.equal(host.calls[1].bit.id, bit.id)
  assert.equal(host.calls[1].readOnly, false)
  // The header is the same one team delegation prints: backend/model · effort from the result meta.
  host.state.nextResult = { text: 'deep report', meta: { backend: 'dsh', model: 'deepseek-account/deepseek-flash', effort: 'max' } }
  const routed = await definition.execute({ bit: bit.id, task: 'Analyze' }, execOf(agent, 'bit_delegate', {}))
  assert.equal(routed, '[Repo Builder · dsh/deepseek-account/deepseek-flash · max]\n\ndeep report')
  host.state.nextResult = { text: '   ', meta: { backend: 'claude-code', model: 'subscription/haiku', effort: null } }
  const empty = await definition.execute({ bit: bit.id, task: 'Analyze' }, execOf(agent, 'bit_delegate', {}))
  assert.equal(empty, '[Repo Builder · claude-code/haiku]\n\n(the bit ended without a response)')
  // Invalid arguments are coded before any invocation.
  const callsBefore = host.calls.length
  await assert.rejects(definition.execute({ bit: '   ', task: 'x' }, execOf(agent, 'bit_delegate', {})), (error) => error.code === 'BIT_DELEGATE_INVALID')
  await assert.rejects(definition.execute({ bit: 'Scout', task: '  ' }, execOf(agent, 'bit_delegate', {})), (error) => error.code === 'BIT_DELEGATE_INVALID')
  assert.equal(host.calls.length, callsBefore, 'invalid arguments never reach the bit runtime')
})

await test('cancellation and worker errors pass through with their codes', async () => {
  const bit = env.bits.list().find((record) => record.name === 'Repo Builder')
  assert.ok(bit, 'the existing worker bit of the previous test is available')
  const definition = host.tools.get('orch-1').get('bit_delegate')
  const agent = host.agents.find((item) => item.id === 'orch-1')
  // An aborted exec.signal propagates the invokeWorker rejection unchanged.
  const aborted = new AbortController()
  const cancellation = coded('ABORTED', 'Execution cancelled.')
  host.state.nextError = cancellation
  aborted.abort()
  await assert.rejects(
    definition.execute({ bit: bit.id, task: 'Cancelled task' }, execOf(agent, 'bit_delegate', {}, aborted.signal)),
    (error) => error === cancellation,
    'the cancellation error is not wrapped',
  )
  // A non-aborted coded error keeps its code and gets the bit context.
  host.state.nextError = coded('BIT_MODEL_CALL_FAILED', 'model call exploded')
  await assert.rejects(
    definition.execute({ bit: bit.id, task: 'Failing task' }, execOf(agent, 'bit_delegate', {})),
    (error) => error.code === 'BIT_MODEL_CALL_FAILED' && /The bit "Repo Builder" failed: model call exploded/.test(error.message),
  )
  // An uncoded error is wrapped as BIT_RUN_FAILED.
  host.state.nextError = new Error('socket closed')
  await assert.rejects(
    definition.execute({ bit: bit.id, task: 'Failing task' }, execOf(agent, 'bit_delegate', {})),
    (error) => error.code === 'BIT_RUN_FAILED' && /The bit "Repo Builder" failed: socket closed/.test(error.message),
  )
  assert.equal(host.state.nextError, null)
})

await test('delegating to a catalog character creates it once with the catalog preset and dedupes concurrently', async () => {
  const definition = host.tools.get('orch-1').get('bit_delegate')
  const agent = host.agents.find((item) => item.id === 'orch-1')
  const catalogScout = CATALOG.get('bit-scout')
  const before = env.bits.list().length
  const output = await definition.execute({ bit: 'Scout', task: 'Find X' }, execOf(agent, 'bit_delegate', {}))
  const created = env.bits.list().find((record) => record.character === 'bit-scout')
  assert.ok(created, 'the catalog character was provisioned')
  assert.equal(env.bits.list().length, before + 1)
  assert.equal(created.name, catalogScout.name)
  assert.equal(created.emoji, catalogScout.emoji)
  assert.equal(created.color, catalogScout.color)
  assert.equal(created.instructions, catalogScout.instructions)
  assert.equal(created.isOrchestrator, false)
  assert.equal(created.model, catalogScout.model, 'catalog preset model passed explicitly')
  assert.equal(created.effort, catalogScout.effort, 'catalog preset effort passed explicitly')
  assert.equal(host.calls.at(-1).bit.id, created.id)
  assert.match(output, /^\[Scout · claude-code\/sonnet · high\]\n\nreport from Scout$/)
  // By catalog id: the same bit is reused, never duplicated.
  await definition.execute({ bit: 'bit-scout', task: 'Find Y' }, execOf(agent, 'bit_delegate', {}))
  assert.equal(env.bits.list().length, before + 1, 'second delegation reused the created bit')
  assert.equal(host.calls.at(-1).bit.id, created.id)
  // Concurrent delegations for a character that does not exist yet create exactly one bit.
  await Promise.all([
    definition.execute({ bit: 'Architect', task: 'Plan A' }, execOf(agent, 'bit_delegate', {})),
    definition.execute({ bit: 'bit-architect', task: 'Plan B' }, execOf(agent, 'bit_delegate', {})),
  ])
  const architects = env.bits.list().filter((record) => record.character === 'bit-architect')
  assert.equal(architects.length, 1, 'concurrent creations deduped')
  assert.equal(architects[0].model, CATALOG.get('bit-architect').model)
  assert.equal(architects[0].effort, CATALOG.get('bit-architect').effort)
  assert.equal(host.calls.at(-2).bit.id, architects[0].id)
  assert.equal(host.calls.at(-1).bit.id, architects[0].id)
})

await test('an existing bit of the same character is reused with its own model and effort', async () => {
  const scout = env.bits.list().find((record) => record.character === 'bit-scout')
  await env.bits.update(scout.id, { name: 'Repo Scout', model: 'subscription/opus', effort: 'xhigh' })
  const definition = host.tools.get('orch-1').get('bit_delegate')
  const agent = host.agents.find((item) => item.id === 'orch-1')
  const before = env.bits.list().length
  await definition.execute({ bit: 'Scout', task: 'Find Z' }, execOf(agent, 'bit_delegate', {}))
  const used = host.calls.at(-1).bit
  assert.equal(used.id, scout.id, 'the existing character bit was reused')
  assert.equal(used.name, 'Repo Scout')
  assert.equal(used.model, 'subscription/opus', 'the stored model was not overwritten')
  assert.equal(used.effort, 'xhigh', 'the stored effort was not overwritten')
  assert.equal(env.bits.list().length, before, 'no extra bit was created')
})

await test('orchestrator characters/bits are refused and unknown targets are coded errors', async () => {
  const definition = host.tools.get('orch-1').get('bit_delegate')
  const agent = host.agents.find((item) => item.id === 'orch-1')
  const before = env.bits.list().length
  for (const target of ['Manager', 'bit-manager', 'Coordinator']) {
    await assert.rejects(
      definition.execute({ bit: target, task: 'Do it' }, execOf(agent, 'bit_delegate', {})),
      (error) => error.code === 'BIT_IS_ORCHESTRATOR' && /orchestrator/.test(error.message),
    )
  }
  const boss = await env.bits.create({
    name: 'Boss',
    character: null,
    instructions: 'Manage.',
    isOrchestrator: true,
    model: 'deepseek-account/deepseek-flash',
    effort: 'max',
  })
  await assert.rejects(
    definition.execute({ bit: boss.id, task: 'Do it' }, execOf(agent, 'bit_delegate', {})),
    (error) => error.code === 'BIT_IS_ORCHESTRATOR' && /Boss/.test(error.message),
  )
  await assert.rejects(
    definition.execute({ bit: 'boss', task: 'Do it' }, execOf(agent, 'bit_delegate', {})),
    (error) => error.code === 'BIT_IS_ORCHESTRATOR',
  )
  assert.equal(env.bits.list().length, before + 1, 'only the explicit orchestrator bit exists; no catalog orchestrator was created')
  assert.equal(env.bits.list().some((record) => record.character === 'bit-manager'), false)
  await assert.rejects(
    definition.execute({ bit: 'Definitely not a bit', task: 'x' }, execOf(agent, 'bit_delegate', {})),
    (error) => error.code === 'BIT_UNKNOWN' && /Available: /.test(error.message),
  )
})

await test('duplicate names use the first bit in store order and are noted once in diagnostics', async () => {
  const edge = await makeEdgeRuntime()
  try {
    const first = await edge.env.bits.create({ name: 'Twin', character: null, instructions: 'First.', model: 'subscription/sonnet', effort: 'high' })
    const second = await edge.env.bits.create({ name: 'Twin', character: null, instructions: 'Second.', model: 'subscription/haiku', effort: 'low' })
    assert.notEqual(first.id, second.id)
    const agent = edge.host.makeAgent('orch-dup', { preset: ORCHESTRATOR_PRESET })
    await edge.host.emit('agent/created', { agent, source: 'startup' })
    const definition = edge.host.tools.get('orch-dup').get('bit_delegate')
    await definition.execute({ bit: 'twIn', task: 'Ambiguous' }, execOf(agent, 'bit_delegate', {}))
    assert.equal(edge.host.calls.at(-1).bit.id, first.id, 'the first bit in store order wins')
    const notes = edge.runtime.diagnostics().notes
    assert.equal(notes.length, 1, 'exactly one note for the ambiguous name')
    assert.match(notes[0], /2 bits are named "twIn"; using /)
    assert.ok(notes[0].includes(first.id))
    // The notes list is capped, so repeated ambiguities cannot grow unbounded.
    for (let index = 0; index < 24; index += 1) {
      await definition.execute({ bit: 'Twin', task: 'Ambiguous' }, execOf(agent, 'bit_delegate', {}))
    }
    assert.equal(edge.runtime.diagnostics().notes.length, 20, 'notes are capped at 20 entries')
    assert.match(edge.runtime.diagnostics().notes.at(-1), /2 bits are named "Twin"/)
  } finally {
    edge.runtime.dispose()
  }
})

await test('diagnostics lists the installed Sessions and their tools, and dispose clears everything', async () => {
  const transient = host.makeAgent('orch-transient', { preset: ORCHESTRATOR_PRESET })
  await host.emit('agent/created', { agent: transient, source: 'startup' })
  assert.ok(host.sections.get('orch-transient'))
  await host.emit('agent/disposed', { agent: transient })
  assert.equal(host.sections.get('orch-transient'), undefined)
  assert.equal(host.tools.get('orch-transient')?.has('bit_delegate') ?? false, false)

  const diagnostics = runtime.diagnostics()
  assert.equal(diagnostics.presetId, 'bits-orchestrator')
  assert.deepEqual(diagnostics.installed.map((entry) => entry.sessionId).sort(), ['orch-1', 'orch-early'])
  for (const entry of diagnostics.installed) assert.deepEqual(entry.tools, ['bit_delegate'])
  assert.deepEqual(diagnostics.errors, [])
  assert.deepEqual(diagnostics.notes, [])

  runtime.dispose()
  assert.deepEqual(runtime.diagnostics().installed, [])
  for (const id of ['orch-early', 'orch-1']) {
    assert.equal(host.sections.get(id), undefined)
    assert.equal(host.tools.get(id)?.has('bit_delegate') ?? false, false)
  }
})

for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\norchestrator: ${failures.length} failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\norchestrator: ${passed} tests passed`)
}
