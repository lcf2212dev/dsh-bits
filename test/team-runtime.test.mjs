/**
 * Team runtime (v5) against a fake host context: resolution, lead route and
 * persona from the referenced bit, prompt composition (roster with bit
 * name/backend/model/effort), restrictions, delegation to worker bits through
 * the `claude_delegate` tool, delegation to orchestrator bits through the
 * child-agent path, guard, handoff, skills, applyTo, shell variables and
 * missions.
 *
 * Plain `node test/team-runtime.test.mjs`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createBitRuntime } from '../host/bit-runtime.js'
import { createModelCatalog } from '../host/models.js'
import { ORCHESTRATOR_PRESET } from '../host/orchestrator.js'
import { installTeamRuntime } from '../host/team-runtime.js'
import { flowText, rosterText } from '../host/team-prompt.js'
import { guardEvent, leadMayRead, toClaudeTool } from '../host/team-guard.js'

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
async function write(root, rel, text) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), text)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function codedOf(error) {
  return error && typeof error.code === 'string' ? error.code : null
}

/* ------------------------------ fixtures ------------------------------ */

const GUARD = `#!/usr/bin/env node
let input = ''
process.stdin.on('data', (c) => { input += c })
process.stdin.on('end', () => {
  const event = JSON.parse(input || '{}')
  const readOnly = process.argv.includes('--read-only')
  const command = (event.tool_input && event.tool_input.command) || ''
  const deny = (reason) => { process.stdout.write(JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason })); process.stderr.write(reason); process.exit(2) }
  if (/git stash/.test(command)) deny('Repository rule: git stash is forbidden.')
  if (readOnly && /^(Write|Edit)$/.test(event.tool_name)) deny('Repository rule: read-only bit.')
  if (!process.env.DSH_HARNESS_PACK_ROOT) deny('pack root missing')
  process.stdout.write('{}')
})
`

const FULL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

async function fixture() {
  const botsRoot = await tempDir('dsh-bits-tr-bots-')
  const workspace = await tempDir('dsh-bits-tr-ws-')
  const elsewhere = await tempDir('dsh-bits-tr-out-')
  const packDir = path.join(botsRoot, 'harness', 'demo')
  await write(packDir, 'AGENTS.md', '# DSC Rules\n\nThe main session only orchestrates. Run `node .github/scripts/where.mjs`.\n')
  await write(packDir, '.github/copilot-instructions.md', '# Conduct\n\nAnswer in English.\n')
  await write(packDir, '.github/hooks/scripts/git-guard.cjs', GUARD)
  await write(packDir, '.github/skills/tdd/SKILL.md', '---\nname: tdd\ndescription: Test first.\n---\n\n# TDD\n\nRed, green.\n')
  await write(packDir, '.github/skills/tdd/references/x.md', 'ref\n')
  await write(packDir, '.github/instructions/ui.instructions.md', "---\nname: ui-components\ndescription: UI.\napplyTo: '**/packages/ui/src/**/*.tsx'\n---\n\n# UI\n\nUse tokens.\n")
  await fs.writeFile(path.join(packDir, 'manifest.json'), JSON.stringify({
    id: 'demo',
    name: 'Demo',
    harnessVersion: 6,
    packDir,
    source: { dir: await tempDir('dsh-bits-tr-src-') },
    rules: 'AGENTS.md',
    conduct: '.github/copilot-instructions.md',
    instructions: [{
      name: 'ui-components',
      description: 'UI.',
      applyTo: ['**/packages/ui/src/**/*.tsx'],
      path: '.github/instructions/ui.instructions.md',
    }],
    skills: [{
      name: 'tdd',
      description: 'Test first.',
      path: '.github/skills/tdd/SKILL.md',
      dir: '.github/skills/tdd',
    }],
    hooks: { guard: '.github/hooks/scripts/git-guard.cjs' },
  }, null, 2))

  const bits = new Map(Object.entries({
    'bit-lead': { id: 'bit-lead', name: 'Orchestrator', isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'max', instructions: 'Only orchestrate and delegate.' },
    'bit-runner': { id: 'bit-runner', name: 'Runner', isOrchestrator: false, model: 'subscription/haiku', effort: 'low', instructions: 'Run commands.', workspaceDir: workspace },
    'bit-scout': { id: 'bit-scout', name: 'Scout', isOrchestrator: false, model: 'subscription/haiku', effort: 'low', instructions: 'Read and research only.', workspaceDir: workspace },
    'bit-analyst': { id: 'bit-analyst', name: 'Analyst', isOrchestrator: false, model: 'deepseek-account/deepseek-flash', effort: 'high', instructions: 'Analyze the code.', workspaceDir: workspace },
    'bit-reviewer': { id: 'bit-reviewer', name: 'Reviewer', isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'high', instructions: 'Review the step.' },
    'bit-validator': { id: 'bit-validator', name: 'Validator', isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'xhigh', instructions: 'Validate the work.' },
    'bit-haiku-2': { id: 'bit-haiku-2', name: 'Haiku account 2', isOrchestrator: false, model: 'subscription/haiku', effort: 'high', instructions: 'Run fast.', workspaceDir: workspace },
  }))

  const validation = {
    id: 'team-val',
    name: 'Validation',
    description: 'Validates deliveries',
    harness: 'demo',
    workspaceDir: workspace,
    lead: 'validator',
    members: [
      { id: 'validator', bitId: 'bit-validator', role: 'Validates the work', access: 'read', launches: ['haiku-2'], skills: [] },
      { id: 'haiku-2', bitId: 'bit-haiku-2', role: 'Runs the tests', access: 'write' },
    ],
  }
  const main = {
    id: 'team-main',
    name: 'Implementation',
    description: 'Implements the request',
    emoji: '👥',
    harness: 'demo',
    workspaceDir: workspace,
    lead: 'lead',
    bindWorkspace: true,
    rules: 'Extra team rule.',
    members: [
      { id: 'lead', bitId: 'bit-lead', role: 'Orchestrates the flow', access: 'read', launches: ['runner', 'scout', 'analyst', 'reviewer', 'validacao'], skills: ['tdd'] },
      { id: 'runner', bitId: 'bit-runner', role: 'Run commands', access: 'write' },
      { id: 'scout', bitId: 'bit-scout', role: 'Locates code', access: 'read' },
      { id: 'analyst', bitId: 'bit-analyst', role: 'Analyzes the code', access: 'read' },
      { id: 'reviewer', bitId: 'bit-reviewer', role: 'Reviews the step', access: 'write' },
      { id: 'validacao', teamRef: 'team-val', role: 'Validation team' },
    ],
    flow: {
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, w: 300, h: 400, label: '1. Phase' },
        { id: 's', type: 'start', x: 40, y: 50, label: 'Request' },
        { id: 'r', type: 'step', x: 30, y: 150, label: 'Run where', memberId: 'runner' },
        { id: 't', type: 'team', x: 30, y: 250, label: 'Validate', teamRef: 'team-val' },
      ],
      edges: [{ id: 'e1', from: 's', to: 'r' }, { id: 'e2', from: 'r', to: 't', label: 'ready', kind: 'handoff' }],
    },
  }
  const broken = {
    id: 'team-broken',
    name: 'Broken',
    harness: 'demo',
    workspaceDir: elsewhere,
    lead: 'runner',
    members: [{ id: 'runner', bitId: 'bit-runner', role: 'Runs things', access: 'write' }],
    flow: { nodes: [], edges: [] },
  }
  const orphan = {
    id: 'team-orphan',
    name: 'Orphan',
    harness: 'demo',
    workspaceDir: elsewhere,
    lead: 'ghost',
    members: [
      { id: 'ghost', bitId: 'bit-gone', role: 'Fleeting', access: 'write' },
      { id: 'gone', bitId: 'bit-gone', role: 'Vanished', access: 'write' },
    ],
    flow: { nodes: [], edges: [] },
  }
  const teams = { file: path.join(botsRoot, 'teams.json'), list: () => [validation, main, broken, orphan] }
  const bitsStore = { get: (id) => bits.get(id) }
  return { botsRoot, workspace, elsewhere, packDir, bits, teams, bitsStore, validation, main, broken, orphan }
}

/* ------------------------------ fake host ------------------------------ */

function fakeHost({ workspace, botsRoot }) {
  const listeners = {}
  const sections = new Map()
  const state = {
    started: [],
    restricts: new Map(),
    tools: new Map(),
    provider: null,
    shell: null,
    invalidations: 0,
    agents: [],
    selected: [],
    claudeCalls: [],
    claudeSettle: (call) => ({ results: [{ callId: call.id, result: { isError: false, value: 'Runner report' } }] }),
    streams: [],
    toolExecuteThrows: null,
  }
  const KNOWN = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'subagent', 'skill', 'spawn_teammate', 'send_message', 'plugin_manager', 'create_goal', 'ask_user_question', 'todo_write', 'working_directory', 'schedule_create'])
  function makeAgent(id, { cwd = workspace, origin, options } = {}) {
    const agent = {
      id,
      options: options || { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
      session: { id, header: { cwd, ...(origin ? { origin } : {}) }, cwd },
      cwd,
      model: {
        select(selection) { state.selected.push({ id, selection: { ...selection } }) },
      },
      ctx: {
        systemPrompt: { section(section) { sections.set(id, section); return () => sections.delete(id) } },
        tools: {
          get: (name) => (KNOWN.has(name) ? {} : undefined),
          view: () => ({ restrictableNames: new Set(KNOWN) }),
          restrict(rule) { state.restricts.set(id, rule); return () => state.restricts.delete(id) },
          register(def) {
            const map = state.tools.get(id) || new Map()
            map.set(def.name, def)
            state.tools.set(id, map)
            return () => map.delete(def.name)
          },
          execute: async (input) => {
            if (state.toolExecuteThrows) throw state.toolExecuteThrows
            const call = input.calls[0]
            state.claudeCalls.push({ call, signal: input.signal })
            return state.claudeSettle(call)
          },
        },
        plugin() { return { dispose() {} } },
      },
    }
    state.agents.push(agent)
    return agent
  }
  const emit = async (name, ...args) => {
    for (const fn of listeners[name] || []) await fn(...args)
  }
  const llm = {
    providers: [{ id: 'deepseek-account', name: 'DeepSeek Account' }],
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek Account' }],
    listModels: async (provider) => [
      { provider, id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
      { provider, id: 'deepseek-pro', name: 'DeepSeek V4.1 Pro' },
    ],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model, reasoning: { efforts: FULL_EFFORTS.map((id) => ({ id, name: id })) } }),
    resolveCallConfig: async (config) => config,
    stream(options) {
      state.streams.push(options)
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'analysis ' }
        yield { type: 'text-delta', index: 0, text: 'ready' }
        yield { type: 'finish', reason: { kind: 'success' } }
      })()
    },
  }
  const ctx = {
    on(name, fn) {
      ;(listeners[name] = listeners[name] || []).push(fn)
      return () => { listeners[name] = listeners[name].filter((item) => item !== fn) }
    },
    tools: {
      // Root tool pipeline used by the bit runtime (ad-hoc + worker delegation).
      async execute(input) {
        if (state.toolExecuteThrows) throw state.toolExecuteThrows
        const call = input.calls[0]
        state.claudeCalls.push({ call, signal: input.signal })
        return state.claudeSettle(call)
      },
    },
    workingDirectory: { get: (session) => session.cwd },
    agents: { list: () => state.agents, get: (id) => state.agents.find((agent) => agent.id === id) },
    skills: { registerProvider(create) { state.provider = create({ invalidate() { state.invalidations += 1 }, signal: new AbortController().signal }); return () => {} } },
    shellEnv: { register(contributor) { state.shell = contributor; return () => {} } },
    llm,
    subagents: {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: { agentOptions: true, depthLimit: true }, inheritsParentContext: false }),
      async startActivation(spec) {
        state.started.push(spec)
        const child = makeAgent(spec.childId, { origin: 'subagent', cwd: spec.request.parent.session.cwd })
        await emit('agent/created', { agent: child, source: 'startup' })
        return {
          childId: spec.childId,
          result: Promise.resolve({ output: [{ type: 'text', text: `report from ${spec.childId}` }], stopReason: 'completed' }),
          dispose() {},
        }
      },
    },
    get: () => undefined,
  }
  const preExecute = async (exec) => {
    let decision = { kind: 'allow' }
    for (const fn of listeners['tools/pre-execute'] || []) decision = await fn(exec, async () => ({ kind: 'allow' }))
    return decision
  }
  const postExecute = async (exec, result = { isError: false }) => {
    let decision = { kind: 'accept' }
    for (const fn of listeners['tools/post-execute'] || []) decision = await fn(exec, result, async () => ({ kind: 'accept' }))
    return decision
  }
  return { ctx, state, sections, makeAgent, emit, preExecute, postExecute, llm, bitsRoot: botsRoot }
}

const execOf = (agent, name, args) => ({ name, arguments: args, agent, callId: 'c', signal: new AbortController().signal })

/* -------------------------------- tests -------------------------------- */

await test('pure helpers: flowText/rosterText with bits, guard mapping, lead read policy', async () => {
  const team = {
    lead: 'l',
    members: [
      { id: 'l', bitId: 'bit-l', access: 'read', launches: ['b'] },
      { id: 'b', bitId: 'bit-b', role: 'Implements', access: 'write', launches: ['l'], skills: ['tdd'] },
    ],
    flow: {
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, w: 300, h: 300, label: 'Phase A', detail: 'det' },
        { id: 'a', type: 'start', x: 20, y: 50, label: 'Request' },
        { id: 'b1', type: 'step', x: 20, y: 150, label: 'Do it', memberId: 'b', detail: 'with tests' },
        { id: 'n', type: 'note', x: 900, y: 0, label: 'Rule', detail: 'line 1\nline 2' },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b1', label: 'ok', kind: 'loop' }],
    },
  }
  const bitsById = {
    'bit-l': { id: 'bit-l', name: 'Lead', isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'max', instructions: 'x' },
    'bit-b': { id: 'bit-b', name: 'Builder', isOrchestrator: false, model: 'subscription/sonnet', effort: 'medium', instructions: 'y' },
  }
  const text = flowText(team, {}, bitsById)
  assert.match(text, /### Phase A — det/)
  assert.match(text, /\[b1\] Step «Do it» — Builder \(`b`\)\. with tests/)
  assert.match(text, /→ “ok”: \[b1\] «Do it» \(loop\/fix\)/)
  assert.match(text, /\*\*Rule:\*\* line 1 line 2/)
  const roster = rosterText(team, {}, bitsById)
  assert.match(roster, /Lead \(`l`\) \*\*\(lead\)\*\* .* dsh · deepseek-account\/deepseek-flash · max \| read-only/)
  assert.match(roster, /Builder \(`b`\) \| Implements \| claude-code · subscription\/sonnet · medium \| read and write \| `l` \| `tdd`/)
  assert.deepEqual(toClaudeTool('bash', { command: 'ls' }), { tool: 'Bash', input: { command: 'ls' } })
  assert.equal(toClaudeTool('edit', { file_path: '/a', old_string: 'x', new_string: 'y' }).tool, 'Edit')
  const event = guardEvent({ name: 'bash', arguments: { command: 'ls', workdir: '/w' } }, { sessionId: 's', cwd: '/c', agentType: 'runner' })
  assert.equal(event.cwd, '/w')
  assert.equal(event.agent_type, 'runner')
  assert.equal(event.hook_event_name, 'PreToolUse')
  assert.equal(leadMayRead('/p/.github/skills/x/SKILL.md', { packDir: '/p', dataDir: '/d' }), true)
  assert.equal(leadMayRead('/repo/worktrees/AB-1/.dsc/context.md', { packDir: '/p', dataDir: '/d' }), true)
  assert.equal(leadMayRead('/repo/packages/a.ts', { packDir: '/p', dataDir: '/d' }), false)
})

const env = await fixture()
const host = fakeHost(env)
const models = createModelCatalog(host.ctx)
const bitRuntime = createBitRuntime(host.ctx, { bits: env.bitsStore, catalog: null, models, log: () => {} })
let releaseTeams
const teamsReady = new Promise((resolve) => { releaseTeams = resolve })
const runtime = installTeamRuntime(host.ctx, { teams: env.teams, teamsReady, bits: env.bitsStore, models, bitRuntime, botsRoot: env.botsRoot, log: () => {} })
// Hooks may fire before the store is ready: nothing resolves, and nothing stale is cached.
await sleep(10)
assert.deepEqual(await host.state.provider.list({ scope: host.makeAgent('early') }), [])
releaseTeams()
await runtime.ready
const lead = host.makeAgent('root-1')
await host.emit('agent/created', { agent: lead, source: 'startup' })

await test('a root session in the bound workspace becomes the team lead, on the lead bit persona and route', async () => {
  const section = host.sections.get('root-1')
  assert.ok(section, 'prompt section installed')
  const text = section.text()
  assert.match(text, /# Team of bits: Implementation/)
  assert.match(text, /You are \*\*Orchestrator\*\* \(`lead`\)/)
  // Persona/context comes from the referenced bit.
  assert.match(text, /Only orchestrate and delegate\./)
  // Roster shows the bit name, role, access, backend and model/effort.
  assert.match(text, /Runner \(`runner`\) \| Run commands \| claude-code · subscription\/haiku · low \| read and write/)
  assert.match(text, /Analyst \(`analyst`\) \| Analyzes the code \| dsh · deepseek-account\/deepseek-flash · high/)
  assert.match(text, /team «Validation» \(`validacao`\) \| Validation team \| — \| —/)
  // The lead text explains single-shot workers and child-agent orchestrators.
  assert.match(text, /Worker bits.*one-shot invocations/)
  assert.match(text, /Orchestrator bits.*run as a child agent/s)
  assert.match(text, /# DSC Rules/)
  assert.match(text, /# Conduct/)
  assert.match(text, /Extra team rule\./)
  assert.match(text, /\[r\] Step «Run where» — Runner \(`runner`\)/)
  assert.match(text, /→ “ready”: \[t\] «Validate» \(handoff to the other team\)/)
  assert.match(text, /`ui-components` \(\*\*\/packages\/ui\/src\/\*\*\/\*\.tsx\)/)
  assert.match(text, /load with `skill`: `tdd`/)
  const deny = host.state.restricts.get('root-1').deny
  for (const name of ['bash', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'subagent', 'spawn_teammate', 'send_message', 'plugin_manager', 'create_goal', 'schedule_create']) assert.ok(deny.includes(name), `lead hides ${name}`)
  for (const name of ['read', 'skill', 'todo_write', 'ask_user_question', 'working_directory']) assert.ok(!deny.includes(name), `lead keeps ${name}`)
  const goal = await host.preExecute(execOf(lead, 'create_goal', { objective: 'x' }))
  assert.equal(goal.kind, 'deny', 'tools outside the allow-list are denied at execution too')
  const tools = host.state.tools.get('root-1')
  assert.deepEqual(tools.get('team_delegate').parameters.properties.member.enum, ['runner', 'scout', 'analyst', 'reviewer', 'validacao'])
  assert.deepEqual(tools.get('team_handoff').parameters.properties.team.enum, [env.validation.id])
  // The delegate description distinguishes worker from orchestrator bits.
  const description = tools.get('team_delegate').description
  assert.match(description, /Worker bits \(isOrchestrator: false\) are single-shot invocations/)
  assert.match(description, /Runner — Run commands/)
})

await test('the lead may only read the pack and .dsc files; it cannot run tools it does not have', async () => {
  const packFile = path.join(env.packDir, '.github/skills/tdd/SKILL.md')
  assert.equal((await host.preExecute(execOf(lead, 'read', { file_path: packFile }))).kind, 'allow')
  assert.equal((await host.preExecute(execOf(lead, 'read', { file_path: '.dsc/contexto.md' }))).kind, 'allow')
  const denied = await host.preExecute(execOf(lead, 'read', { file_path: 'packages/a.ts' }))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /only reads the harness pack/)
  assert.equal((await host.preExecute(execOf(lead, 'bash', { command: 'ls' }))).kind, 'deny')
})

let runnerOutput
await test('delegating to a worker bit calls the registered claude_delegate tool (prompt/model/effort/cwd/readOnly)', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  runnerOutput = await delegateDef.execute({ member: 'runner', task: 'Implement the button' }, execOf(lead, 'team_delegate', {}))
  assert.equal(host.state.started.length, 0, 'a worker never starts a child agent')
  assert.equal(host.state.claudeCalls.length, 1)
  const call = host.state.claudeCalls[0].call
  assert.equal(call.name, 'claude_delegate')
  const args = JSON.parse(call.arguments)
  assert.deepEqual(args, {
    task: 'Run commands.\n\n---\n\nImplement the button',
    model: 'haiku',
    effort: 'low',
    cwd: env.workspace,
    readOnly: false,
  })
  assert.match(runnerOutput, /^\[Runner · claude-code\/haiku · low\]\nRunner report$/)
  await assert.rejects(delegateDef.execute({ member: 'ghost', task: 'x' }, execOf(lead, 'team_delegate', {})), /cannot be launched/)
})

await test('a worker delegation uses the team workspace when the caller cwd is outside it', async () => {
  await runtime.bindings.set('outside-lead', { teamId: env.main.id, role: 'lead', parentSession: null })
  const outside = host.makeAgent('outside-lead', { cwd: '/tmp' })
  await host.emit('agent/created', { agent: outside, source: 'startup' })
  const before = host.state.claudeCalls.length
  await host.state.tools.get('outside-lead').get('team_delegate').execute({ member: 'runner', task: 'Run' }, execOf(outside, 'team_delegate', {}))
  const args = JSON.parse(host.state.claudeCalls[before].call.arguments)
  assert.equal(args.cwd, env.workspace, 'outside the team workspace, the team workspace is the cwd')
})

await test('read-only workers pass readOnly: true; the bit instructions compose the task', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  const before = host.state.claudeCalls.length
  const output = await delegateDef.execute({ member: 'scout', task: 'Find component X' }, execOf(lead, 'team_delegate', {}))
  const args = JSON.parse(host.state.claudeCalls[before].call.arguments)
  assert.equal(args.readOnly, true)
  assert.match(args.task, /Read and research only\.\n\n---\n\nFind component X/)
  assert.match(output, /^\[Scout · claude-code\/haiku · low\]/)
})

await test('a worker pointing at a DSH route runs a one-shot model call', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  const before = host.state.streams.length
  const output = await delegateDef.execute({ member: 'analyst', task: 'Analyze X' }, execOf(lead, 'team_delegate', {}))
  assert.equal(host.state.streams.length, before + 1)
  const options = host.state.streams.at(-1)
  assert.equal(options.provider, 'deepseek-account')
  assert.equal(options.model, 'deepseek-flash')
  assert.equal(options.reasoningEffort, 'high')
  assert.deepEqual(options.messages, [{ role: 'user', content: [{ type: 'text', text: 'Analyze the code.\n\n---\n\nAnalyze X' }] }])
  assert.match(output, /^\[Analyst · dsh\/deepseek-account\/deepseek-flash · high\]\nanalysis ready$/)
})

await test('a failed worker invocation becomes a model-visible coded tool error', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  host.state.claudeSettle = (call) => ({ results: [{ callId: call.id, result: { isError: true, error: { message: 'claude is not logged in', info: { code: 'UNKNOWN_TOOL' } } } }] })
  await assert.rejects(
    delegateDef.execute({ member: 'runner', task: 'Run' }, execOf(lead, 'team_delegate', {})),
    (error) => error.code === 'BIT_DELEGATE_UNAVAILABLE' && /The bit "Runner" failed/.test(error.message) && /claude is not logged in/.test(error.message),
  )
  host.state.claudeSettle = (call) => ({ results: [{ callId: call.id, result: { isError: false, value: 'Runner report' } }] })
})

let reviewerChild
await test('delegating to an orchestrator bit keeps the DSH child-agent path with the bit route', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  const before = host.state.claudeCalls.length
  const output = await delegateDef.execute({ member: 'reviewer', task: 'Review the change' }, execOf(lead, 'team_delegate', {}))
  assert.equal(host.state.claudeCalls.length, before, 'an orchestrator bit does not go through claude_delegate')
  const spec = host.state.started.at(-1)
  assert.deepEqual(spec.request.agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.maxDepth, 4)
  assert.match(spec.request.prompt[0].text, /Task delegated by Orchestrator \(team Implementation\):\n\nReview the change/)
  assert.match(output, /\[Reviewer · completed · deepseek-account\/deepseek-flash · high · session [^\]]+\]\nreport from/)
  reviewerChild = host.state.agents.find((agent) => agent.id === spec.childId)
  const text = host.sections.get(spec.childId).text()
  assert.match(text, /# Reviewer — bit of the team Implementation/)
  assert.match(text, /Review the step\./)
  assert.match(text, /You are an \*\*orchestrator\*\* bit of this step/)
  assert.match(text, /You do not launch other bits: the step is yours\./)
  assert.equal(runtime.bindings.get(spec.childId).memberId, 'reviewer')
  // The reviewer has write access: the v4 rule (a write lead keeps its shell) still holds.
  const deny = host.state.restricts.get(spec.childId).deny
  assert.ok(!deny.includes('bash'), 'a write orchestrator member keeps its shell')
  assert.ok(deny.includes('subagent') && deny.includes('spawn_teammate') && deny.includes('plugin_manager'))
  assert.ok(deny.includes('team_delegate') === false, 'team_delegate is always visible')
})

await test('the harness guard runs for agent bits (deny git stash) with the pack root', async () => {
  const stash = await host.preExecute(execOf(reviewerChild, 'bash', { command: 'git stash' }))
  assert.equal(stash.kind, 'deny')
  assert.match(stash.reason, /git stash is forbidden/)
  assert.equal((await host.preExecute(execOf(reviewerChild, 'bash', { command: 'ls' }))).kind, 'allow')
  const write = await host.preExecute(execOf(reviewerChild, 'write', { file_path: path.join(env.workspace, 'a.txt'), content: 'x' }))
  assert.equal(write.kind, 'allow')
})

let validationChild
await test('delegating to a teamRef member runs the other team lead with its own bit route', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  await delegateDef.execute({ member: 'validacao', task: 'Validate AB 1' }, execOf(lead, 'team_delegate', {}))
  const spec = host.state.started.at(-1)
  assert.deepEqual(spec.request.agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'xhigh' })
  const binding = runtime.bindings.get(spec.childId)
  assert.equal(binding.teamId, env.validation.id)
  assert.equal(binding.role, 'lead')
  const text = host.sections.get(spec.childId).text()
  assert.match(text, /# Team of bits: Validation/)
  assert.match(text, /You were called by another team/)
  assert.match(text, /Validate the work\./)
  const tools = host.state.tools.get(spec.childId)
  assert.deepEqual(tools.get('team_delegate').parameters.properties.member.enum, ['haiku-2'])
  assert.equal(tools.get('team_handoff'), undefined, 'child leads cannot hand off')
  // A read-only orchestrator lead only orchestrates.
  const bash = await host.preExecute(execOf(host.state.agents.find((agent) => agent.id === spec.childId), 'bash', { command: 'ls' }))
  assert.equal(bash.kind, 'deny')
  assert.match(bash.reason, /only orchestrates/)
  validationChild = host.state.agents.find((agent) => agent.id === spec.childId)
})

await test('a stale member bit fails with a coded, model-visible error', async () => {
  await runtime.bindings.set('orphan-session', { teamId: env.orphan.id, role: 'lead', parentSession: null })
  const orphanAgent = host.makeAgent('orphan-session', { cwd: env.elsewhere })
  await host.emit('agent/created', { agent: orphanAgent, source: 'startup' })
  const delegateDef = host.state.tools.get('orphan-session').get('team_delegate')
  await assert.rejects(delegateDef.execute({ member: 'gone', task: 'x' }, execOf(orphanAgent, 'team_delegate', {})), (error) => codedOf(error) === 'TEAM_INVALID' && /no longer exists/.test(error.message))
})

await test('skills, applyTo and shell variables follow the team', async () => {
  const skills = await host.state.provider.list({ scope: reviewerChild })
  assert.deepEqual(skills.map((skill) => skill.name), ['tdd'])
  assert.equal(skills[0].resourceBase.path, path.join(env.packDir, '.github/skills/tdd'))
  const definition = await host.state.provider.get(skills[0])
  assert.match(definition.content, /^\n?# TDD/)
  assert.deepEqual(await host.state.provider.list({ scope: host.makeAgent('elsewhere', { cwd: '/tmp' }) }), [])
  const file = path.join(env.workspace, 'packages/ui/src/Button/Button.tsx')
  const first = await host.postExecute(execOf(reviewerChild, 'edit', { file_path: file }))
  assert.equal(first.additionalContexts.length, 1)
  assert.match(first.additionalContexts[0].content[0].text, /Use tokens\./)
  const second = await host.postExecute(execOf(reviewerChild, 'read', { file_path: file }))
  assert.equal(second.additionalContexts, undefined, 'once per agent')
  const vars = host.state.shell.resolve(execOf(reviewerChild, 'bash', { command: 'x' }))
  assert.equal(vars.DSH_HARNESS_PACK_ROOT, env.packDir)
  assert.equal(vars.DSH_TEAM_ID, env.main.id)
  assert.equal(vars.DSH_TEAM_MEMBER, 'reviewer')
  assert.deepEqual(host.state.shell.resolve(execOf(host.makeAgent('other', { cwd: '/tmp' }), 'bash', {})), {})
})

await test('team_handoff rebinds the session to the other team lead', async () => {
  const handoff = host.state.tools.get('root-1').get('team_handoff')
  const output = await handoff.execute({ team: env.validation.id, request: 'validate AB 1' }, execOf(lead, 'team_handoff', {}))
  assert.match(output, /Session passed to the team «Validation»/)
  assert.match(output, /Validator/)
  await sleep(20)
  assert.equal(runtime.bindings.get('root-1').teamId, env.validation.id)
  assert.match(host.sections.get('root-1').text(), /# Team of bits: Validation/)
  assert.ok(host.state.invalidations > 0, 'skills catalog invalidated')
  const diag = runtime.diagnostics()
  const entry = diag.agents.find((agent) => agent.sessionId === 'root-1')
  assert.equal(entry.teamId, env.validation.id)
  assert.equal(entry.bitId, 'bit-validator')
})

await test('a blank session switched to the Bit mode preset is never resolved as a team lead', async () => {
  // DSH records a preset picked before the first turn in the session log while
  // the creation header keeps the old preset; the guard must read the effective
  // preset (agentPresets.presetForSession), not the frozen header.
  const projections = new Map()
  const originalGet = host.ctx.get
  host.ctx.get = (name) => (name === 'agentPresets'
    ? { presetForSession: (session) => projections.get(session && session.id) ?? null }
    : originalGet(name))
  try {
    const picked = host.makeAgent('picked-standard-header', { cwd: env.workspace })
    picked.session.header.agentPreset = 'cordis'
    projections.set(picked.id, ORCHESTRATOR_PRESET)
    await host.emit('agent/created', { agent: picked, source: 'startup' })
    assert.equal(runtime.resolveSession(picked.id), null, 'the picked Bit mode session was resolved as a team lead')
    assert.equal(host.sections.get(picked.id), undefined, 'no team prompt section on the picked session')
    assert.equal(host.state.tools.get(picked.id), undefined, 'no team tools on the picked session')

    // Positive control: the same header without the recorded Bit mode selection
    // is a normal chat and still becomes the lead inside the bound workspace.
    const control = host.makeAgent('control-standard-header', { cwd: env.workspace })
    control.session.header.agentPreset = 'cordis'
    await host.emit('agent/created', { agent: control, source: 'startup' })
    assert.ok(runtime.resolveSession(control.id), 'a normal chat in the same workspace stopped resolving as the lead')
    assert.ok(host.sections.get(control.id), 'the lead got its team prompt section')

    // Switching that live, still-blank chat to Bit mode must drop the team
    // install made at agent/created (prompt, team tools and restrict mask).
    projections.set(control.id, ORCHESTRATOR_PRESET)
    await host.emit('agent-preset/selected', control.id, ORCHESTRATOR_PRESET)
    assert.equal(runtime.resolveSession(control.id), null)
    assert.equal(host.sections.get(control.id), undefined, 'the team section survived the Bit mode pick')
    assert.equal(host.state.tools.get(control.id)?.get('team_delegate') ?? undefined, undefined, 'the team tools survived the Bit mode pick')
    assert.equal(host.state.restricts.get(control.id), undefined, 'the restrict mask survived the Bit mode pick')
    assert.equal(runtime.diagnostics().agents.some((agent) => agent.sessionId === control.id), false, 'diagnostics still lists the team lead')

    // Switching it back (still blank) re-applies the team install.
    projections.set(control.id, 'cordis')
    await host.emit('agent-preset/selected', control.id, 'cordis')
    await sleep(20)
    assert.ok(runtime.resolveSession(control.id), 'the chat did not resolve as the lead again')
    assert.ok(host.sections.get(control.id), 'the team section was not re-installed')
    assert.ok(host.state.tools.get(control.id)?.get('team_delegate'), 'the team tools were not re-installed')
    assert.equal(runtime.diagnostics().agents.some((agent) => agent.sessionId === control.id), true)
  } finally {
    host.ctx.get = originalGet
  }
})

await test('startMission creates a lead session in the team workspace, selects the bit route and delivers the request', async () => {
  const created = []
  const followups = []
  const attached = []
  const renamed = []
  host.ctx.get = (name) => {
    if (name === 'sessionController') {
      return {
        async create(request) { created.push(request) },
        async resolveAgent(sessionId) {
          const agent = host.makeAgent(sessionId, { cwd: env.workspace })
          agent.followup = (message) => followups.push(message)
          await host.emit('agent/created', { agent, source: 'startup' })
          return { agent }
        },
      }
    }
    if (name === 'workspaceRegistry') return { resolveByPath: async () => ({ attachSession: async (id) => attached.push(id) }) }
    if (name === 'sessions') return { flush: async () => true }
    if (name === 'sessionTitle') return { rename: (_session, text) => renamed.push(text) }
    return undefined
  }
  const started = await runtime.startMission({ team: 'Implementation', prompt: 'implement AB 123' })
  assert.equal(created[0].cwd, env.workspace)
  assert.equal(created[0].sessionId, started.sessionId)
  assert.deepEqual(attached, [started.sessionId])
  // Lead route comes from the lead bit (DeepSeek-V4.1-Flash Max).
  const selection = host.state.selected.find((item) => item.id === started.sessionId)
  assert.deepEqual(selection.selection, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' })
  assert.equal(followups[0].content[0].text, 'implement AB 123')
  assert.equal(followups[0].role, 'user')
  assert.equal(runtime.bindings.get(started.sessionId).role, 'lead')
  assert.match(host.sections.get(started.sessionId).text(), /# Team of bits: Implementation/)
  assert.match(renamed[0], /👥 Implementation: implement AB 123/)
  // Continue: the message reaches the same lead session.
  const continued = await runtime.continueMission({ sessionId: started.sessionId, prompt: 'answer the PAUSE' })
  assert.equal(continued.teamId, env.main.id)
  assert.equal(followups.at(-1).content[0].text, 'answer the PAUSE')
  await assert.rejects(runtime.startMission({ team: 'nope', prompt: 'x' }), /not found/)
  await assert.rejects(runtime.startMission({ team: 'Broken', prompt: 'x' }), (error) => codedOf(error) === 'TEAM_LEAD_NOT_ORCHESTRATOR' && /must be an orchestrator bit/.test(error.message))
  await assert.rejects(runtime.startMission({ team: 'Implementation', prompt: '   ' }), (error) => codedOf(error) === 'BAD_REQUEST')
})

await test('a Bits Orchestrator preset session is never resolved or bound as a team lead', async () => {
  // The cwd is inside the bindWorkspace team workspace: without the preset
  // guard this session would become the lead of team Implementation.
  const preset = host.makeAgent('preset-session', { cwd: env.workspace })
  preset.session.header.agentPreset = ORCHESTRATOR_PRESET
  await host.emit('agent/created', { agent: preset, source: 'startup' })
  assert.equal(runtime.resolveSession('preset-session'), null)
  assert.equal(host.sections.get('preset-session'), undefined, 'no team prompt section')
  assert.equal(host.state.tools.get('preset-session'), undefined, 'no team tools')
  assert.equal(host.state.restricts.get('preset-session'), undefined, 'no team tool restrictions')
  assert.equal(runtime.diagnostics().agents.some((agent) => agent.sessionId === 'preset-session'), false)
  assert.equal(runtime.bindings.get('preset-session'), undefined)

  // Positive control: the same cwd without the preset IS resolved as the lead.
  const control = host.makeAgent('control-session', { cwd: env.workspace })
  await host.emit('agent/created', { agent: control, source: 'startup' })
  const binding = runtime.resolveSession('control-session')
  assert.ok(binding, 'a normal session in the same workspace resolves as a team lead')
  assert.equal(binding.role, 'lead')
  assert.equal(binding.team.id, env.main.id)
  assert.equal(binding.member.id, env.main.lead)
  assert.equal(binding.child, false)
  assert.match(host.sections.get('control-session').text(), /# Team of bits: Implementation/)
  assert.ok(host.state.tools.get('control-session').get('team_delegate'))
  assert.ok(runtime.diagnostics().agents.some((agent) => agent.sessionId === 'control-session'))
})

await test('the runtime disposes cleanly', async () => {
  assert.equal(typeof runtime.refreshTeam, 'function')
  assert.equal(typeof runtime.bindings.forgetTeam, 'function')
  assert.equal(typeof runtime.resolveSession, 'function')
  runtime.dispose()
  assert.equal(host.sections.get('root-1'), undefined)
})

for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\nteam-runtime: ${failures.length} failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\nteam-runtime: ${passed} tests passed`)
}
