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
  if (/git stash/.test(command)) deny('Regra do repositório: git stash é proibido.')
  if (readOnly && /^(Write|Edit)$/.test(event.tool_name)) deny('Regra do repositório: bit somente leitura.')
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
  await write(packDir, 'AGENTS.md', '# Regras DSC\n\nSessão principal só orquestra. Rode `node .github/scripts/where.mjs`.\n')
  await write(packDir, '.github/copilot-instructions.md', '# Conduta\n\nResponda em pt-BR.\n')
  await write(packDir, '.github/hooks/scripts/git-guard.cjs', GUARD)
  await write(packDir, '.github/skills/tdd/SKILL.md', '---\nname: tdd\ndescription: Teste primeiro.\n---\n\n# TDD\n\nVermelho, verde.\n')
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
      description: 'Teste primeiro.',
      path: '.github/skills/tdd/SKILL.md',
      dir: '.github/skills/tdd',
    }],
    hooks: { guard: '.github/hooks/scripts/git-guard.cjs' },
  }, null, 2))

  const bits = new Map(Object.entries({
    'bit-lider': { id: 'bit-lider', name: 'Orquestrador', isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'max', instructions: 'Só orquestre e delegue.' },
    'bit-runner': { id: 'bit-runner', name: 'Runner', isOrchestrator: false, model: 'subscription/haiku', effort: 'low', instructions: 'Execute comandos.', workspaceDir: workspace },
    'bit-scout': { id: 'bit-scout', name: 'Scout', isOrchestrator: false, model: 'subscription/haiku', effort: 'low', instructions: 'Só leitura e pesquisa.', workspaceDir: workspace },
    'bit-analyst': { id: 'bit-analyst', name: 'Analyst', isOrchestrator: false, model: 'deepseek-account/deepseek-flash', effort: 'high', instructions: 'Analise o código.', workspaceDir: workspace },
    'bit-reviewer': { id: 'bit-reviewer', name: 'Reviewer', isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'high', instructions: 'Revise a etapa.' },
    'bit-validator': { id: 'bit-validator', name: 'Validator', isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'xhigh', instructions: 'Valide o trabalho.' },
    'bit-haiku-2': { id: 'bit-haiku-2', name: 'Haiku conta 2', isOrchestrator: false, model: 'subscription/haiku', effort: 'high', instructions: 'Execute rápido.', workspaceDir: workspace },
  }))

  const validation = {
    id: 'team-val',
    name: 'Validação',
    description: 'Valida entregas',
    harness: 'demo',
    workspaceDir: workspace,
    lead: 'validator',
    members: [
      { id: 'validator', bitId: 'bit-validator', role: 'Valida o trabalho', access: 'read', launches: ['haiku-2'], skills: [] },
      { id: 'haiku-2', bitId: 'bit-haiku-2', role: 'Roda os testes', access: 'write' },
    ],
  }
  const main = {
    id: 'team-main',
    name: 'Implementação',
    description: 'Implementa o pedido',
    emoji: '👥',
    harness: 'demo',
    workspaceDir: workspace,
    lead: 'lider',
    bindWorkspace: true,
    rules: 'Regra extra do time.',
    members: [
      { id: 'lider', bitId: 'bit-lider', role: 'Orquestra o fluxo', access: 'read', launches: ['runner', 'scout', 'analyst', 'reviewer', 'validacao'], skills: ['tdd'] },
      { id: 'runner', bitId: 'bit-runner', role: 'Executa comandos', access: 'write' },
      { id: 'scout', bitId: 'bit-scout', role: 'Localiza código', access: 'read' },
      { id: 'analyst', bitId: 'bit-analyst', role: 'Analisa o código', access: 'read' },
      { id: 'reviewer', bitId: 'bit-reviewer', role: 'Revisa a etapa', access: 'write' },
      { id: 'validacao', teamRef: 'team-val', role: 'Time de validação' },
    ],
    flow: {
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, w: 300, h: 400, label: '1. Fase' },
        { id: 's', type: 'start', x: 40, y: 50, label: 'Pedido' },
        { id: 'r', type: 'step', x: 30, y: 150, label: 'Rodar where', memberId: 'runner' },
        { id: 't', type: 'team', x: 30, y: 250, label: 'Validar', teamRef: 'team-val' },
      ],
      edges: [{ id: 'e1', from: 's', to: 'r' }, { id: 'e2', from: 'r', to: 't', label: 'pronto', kind: 'handoff' }],
    },
  }
  const broken = {
    id: 'team-broken',
    name: 'Quebrado',
    harness: 'demo',
    workspaceDir: elsewhere,
    lead: 'runner',
    members: [{ id: 'runner', bitId: 'bit-runner', role: 'Executor', access: 'write' }],
    flow: { nodes: [], edges: [] },
  }
  const orphan = {
    id: 'team-orphan',
    name: 'Órfão',
    harness: 'demo',
    workspaceDir: elsewhere,
    lead: 'ghost',
    members: [
      { id: 'ghost', bitId: 'bit-gone', role: 'Some', access: 'write' },
      { id: 'gone', bitId: 'bit-gone', role: 'Sumiu', access: 'write' },
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
    claudeSettle: (call) => ({ results: [{ callId: call.id, result: { isError: false, value: 'relatório do Runner' } }] }),
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
        yield { type: 'text-delta', index: 0, text: 'análise ' }
        yield { type: 'text-delta', index: 0, text: 'pronta' }
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
          result: Promise.resolve({ output: [{ type: 'text', text: `relatório de ${spec.childId}` }], stopReason: 'completed' }),
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
      { id: 'b', bitId: 'bit-b', role: 'Implementa', access: 'write', launches: ['l'], skills: ['tdd'] },
    ],
    flow: {
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, w: 300, h: 300, label: 'Fase A', detail: 'det' },
        { id: 'a', type: 'start', x: 20, y: 50, label: 'Pedido' },
        { id: 'b1', type: 'step', x: 20, y: 150, label: 'Fazer', memberId: 'b', detail: 'com testes' },
        { id: 'n', type: 'note', x: 900, y: 0, label: 'Regra', detail: 'linha 1\nlinha 2' },
      ],
      edges: [{ id: 'e', from: 'a', to: 'b1', label: 'ok', kind: 'loop' }],
    },
  }
  const bitsById = {
    'bit-l': { id: 'bit-l', name: 'Líder', isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'max', instructions: 'x' },
    'bit-b': { id: 'bit-b', name: 'Builder', isOrchestrator: false, model: 'subscription/sonnet', effort: 'medium', instructions: 'y' },
  }
  const text = flowText(team, {}, bitsById)
  assert.match(text, /### Fase A — det/)
  assert.match(text, /\[b1\] Etapa «Fazer» — Builder \(`b`\)\. com testes/)
  assert.match(text, /→ “ok”: \[b1\] «Fazer» \(retorno\/correção\)/)
  assert.match(text, /\*\*Regra:\*\* linha 1 linha 2/)
  const roster = rosterText(team, {}, bitsById)
  assert.match(roster, /Líder \(`l`\) \*\*\(líder\)\*\* .* dsh · deepseek-account\/deepseek-flash · max \| somente leitura/)
  assert.match(roster, /Builder \(`b`\) \| Implementa \| claude-code · subscription\/sonnet · medium \| leitura e escrita \| `l` \| `tdd`/)
  assert.deepEqual(toClaudeTool('bash', { command: 'ls' }), { tool: 'Bash', input: { command: 'ls' } })
  assert.equal(toClaudeTool('edit', { file_path: '/a', old_string: 'x', new_string: 'y' }).tool, 'Edit')
  const event = guardEvent({ name: 'bash', arguments: { command: 'ls', workdir: '/w' } }, { sessionId: 's', cwd: '/c', agentType: 'runner' })
  assert.equal(event.cwd, '/w')
  assert.equal(event.agent_type, 'runner')
  assert.equal(event.hook_event_name, 'PreToolUse')
  assert.equal(leadMayRead('/p/.github/skills/x/SKILL.md', { packDir: '/p', dataDir: '/d' }), true)
  assert.equal(leadMayRead('/repo/worktrees/AB-1/.dsc/contexto.md', { packDir: '/p', dataDir: '/d' }), true)
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
  assert.match(text, /# Time de bits: Implementação/)
  assert.match(text, /Você é \*\*Orquestrador\*\* \(`lider`\)/)
  // Persona/context comes from the referenced bit.
  assert.match(text, /Só orquestre e delegue\./)
  // Roster shows the bit name, role, access, backend and model/effort.
  assert.match(text, /Runner \(`runner`\) \| Executa comandos \| claude-code · subscription\/haiku · low \| leitura e escrita/)
  assert.match(text, /Analyst \(`analyst`\) \| Analisa o código \| dsh · deepseek-account\/deepseek-flash · high/)
  assert.match(text, /time «Validação» \(`validacao`\) \| Time de validação \| — \| —/)
  // The lead text explains single-shot workers and child-agent orchestrators.
  assert.match(text, /Bits worker.*são invocações de uma vez/)
  assert.match(text, /Bits orquestradores.*rodam como agente filho/s)
  assert.match(text, /# Regras DSC/)
  assert.match(text, /# Conduta/)
  assert.match(text, /Regra extra do time\./)
  assert.match(text, /\[r\] Etapa «Rodar where» — Runner \(`runner`\)/)
  assert.match(text, /→ “pronto”: \[t\] «Validar» \(passagem ao outro time\)/)
  assert.match(text, /`ui-components` \(\*\*\/packages\/ui\/src\/\*\*\/\*\.tsx\)/)
  assert.match(text, /carregue com `skill`: `tdd`/)
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
  assert.match(description, /Runner — Executa comandos/)
})

await test('the lead may only read the pack and .dsc files; it cannot run tools it does not have', async () => {
  const packFile = path.join(env.packDir, '.github/skills/tdd/SKILL.md')
  assert.equal((await host.preExecute(execOf(lead, 'read', { file_path: packFile }))).kind, 'allow')
  assert.equal((await host.preExecute(execOf(lead, 'read', { file_path: '.dsc/contexto.md' }))).kind, 'allow')
  const denied = await host.preExecute(execOf(lead, 'read', { file_path: 'packages/a.ts' }))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /só lê o pacote do harness/)
  assert.equal((await host.preExecute(execOf(lead, 'bash', { command: 'ls' }))).kind, 'deny')
})

let runnerOutput
await test('delegating to a worker bit calls the registered claude_delegate tool (prompt/model/effort/cwd/readOnly)', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  runnerOutput = await delegateDef.execute({ member: 'runner', task: 'Implemente o botão' }, execOf(lead, 'team_delegate', {}))
  assert.equal(host.state.started.length, 0, 'a worker never starts a child agent')
  assert.equal(host.state.claudeCalls.length, 1)
  const call = host.state.claudeCalls[0].call
  assert.equal(call.name, 'claude_delegate')
  const args = JSON.parse(call.arguments)
  assert.deepEqual(args, {
    task: 'Execute comandos.\n\n---\n\nImplemente o botão',
    model: 'haiku',
    effort: 'low',
    cwd: env.workspace,
    readOnly: false,
  })
  assert.match(runnerOutput, /^\[Runner · claude-code\/haiku · low\]\nrelatório do Runner$/)
  await assert.rejects(delegateDef.execute({ member: 'ghost', task: 'x' }, execOf(lead, 'team_delegate', {})), /não pode ser lançado/)
})

await test('a worker delegation uses the team workspace when the caller cwd is outside it', async () => {
  await runtime.bindings.set('outside-lead', { teamId: env.main.id, role: 'lead', parentSession: null })
  const outside = host.makeAgent('outside-lead', { cwd: '/tmp' })
  await host.emit('agent/created', { agent: outside, source: 'startup' })
  const before = host.state.claudeCalls.length
  await host.state.tools.get('outside-lead').get('team_delegate').execute({ member: 'runner', task: 'Rode' }, execOf(outside, 'team_delegate', {}))
  const args = JSON.parse(host.state.claudeCalls[before].call.arguments)
  assert.equal(args.cwd, env.workspace, 'outside the team workspace, the team workspace is the cwd')
})

await test('read-only workers pass readOnly: true; the bit instructions compose the task', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  const before = host.state.claudeCalls.length
  const output = await delegateDef.execute({ member: 'scout', task: 'Ache o componente X' }, execOf(lead, 'team_delegate', {}))
  const args = JSON.parse(host.state.claudeCalls[before].call.arguments)
  assert.equal(args.readOnly, true)
  assert.match(args.task, /Só leitura e pesquisa\.\n\n---\n\nAche o componente X/)
  assert.match(output, /^\[Scout · claude-code\/haiku · low\]/)
})

await test('a worker pointing at a DSH route runs a one-shot model call', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  const before = host.state.streams.length
  const output = await delegateDef.execute({ member: 'analyst', task: 'Analise X' }, execOf(lead, 'team_delegate', {}))
  assert.equal(host.state.streams.length, before + 1)
  const options = host.state.streams.at(-1)
  assert.equal(options.provider, 'deepseek-account')
  assert.equal(options.model, 'deepseek-flash')
  assert.equal(options.reasoningEffort, 'high')
  assert.deepEqual(options.messages, [{ role: 'user', content: [{ type: 'text', text: 'Analise o código.\n\n---\n\nAnalise X' }] }])
  assert.match(output, /^\[Analyst · dsh\/deepseek-account\/deepseek-flash · high\]\nanálise pronta$/)
})

await test('a failed worker invocation becomes a model-visible coded tool error', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  host.state.claudeSettle = (call) => ({ results: [{ callId: call.id, result: { isError: true, error: { message: 'claude is not logged in', info: { code: 'UNKNOWN_TOOL' } } } }] })
  await assert.rejects(
    delegateDef.execute({ member: 'runner', task: 'Rode' }, execOf(lead, 'team_delegate', {})),
    (error) => error.code === 'BIT_DELEGATE_UNAVAILABLE' && /O bit "Runner" falhou/.test(error.message) && /claude is not logged in/.test(error.message),
  )
  host.state.claudeSettle = (call) => ({ results: [{ callId: call.id, result: { isError: false, value: 'relatório do Runner' } }] })
})

let reviewerChild
await test('delegating to an orchestrator bit keeps the DSH child-agent path with the bit route', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  const before = host.state.claudeCalls.length
  const output = await delegateDef.execute({ member: 'reviewer', task: 'Revise a mudança' }, execOf(lead, 'team_delegate', {}))
  assert.equal(host.state.claudeCalls.length, before, 'an orchestrator bit does not go through claude_delegate')
  const spec = host.state.started.at(-1)
  assert.deepEqual(spec.request.agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.maxDepth, 4)
  assert.match(spec.request.prompt[0].text, /Tarefa delegada por Orquestrador \(time Implementação\):\n\nRevise a mudança/)
  assert.match(output, /\[Reviewer · completed · deepseek-account\/deepseek-flash · high · sessão [^\]]+\]\nrelatório de/)
  reviewerChild = host.state.agents.find((agent) => agent.id === spec.childId)
  const text = host.sections.get(spec.childId).text()
  assert.match(text, /# Reviewer — bit do time Implementação/)
  assert.match(text, /Revise a etapa\./)
  assert.match(text, /Você é um bit \*\*orquestrador\*\* desta etapa/)
  assert.match(text, /Você não lança outros bits: a etapa é sua\./)
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
  assert.match(stash.reason, /git stash é proibido/)
  assert.equal((await host.preExecute(execOf(reviewerChild, 'bash', { command: 'ls' }))).kind, 'allow')
  const write = await host.preExecute(execOf(reviewerChild, 'write', { file_path: path.join(env.workspace, 'a.txt'), content: 'x' }))
  assert.equal(write.kind, 'allow')
})

let validationChild
await test('delegating to a teamRef member runs the other team lead with its own bit route', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  await delegateDef.execute({ member: 'validacao', task: 'Valide o AB 1' }, execOf(lead, 'team_delegate', {}))
  const spec = host.state.started.at(-1)
  assert.deepEqual(spec.request.agentOptions, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'xhigh' })
  const binding = runtime.bindings.get(spec.childId)
  assert.equal(binding.teamId, env.validation.id)
  assert.equal(binding.role, 'lead')
  const text = host.sections.get(spec.childId).text()
  assert.match(text, /# Time de bits: Validação/)
  assert.match(text, /Você foi chamado por outro time/)
  assert.match(text, /Valide o trabalho\./)
  const tools = host.state.tools.get(spec.childId)
  assert.deepEqual(tools.get('team_delegate').parameters.properties.member.enum, ['haiku-2'])
  assert.equal(tools.get('team_handoff'), undefined, 'child leads cannot hand off')
  // A read-only orchestrator lead only orchestrates.
  const bash = await host.preExecute(execOf(host.state.agents.find((agent) => agent.id === spec.childId), 'bash', { command: 'ls' }))
  assert.equal(bash.kind, 'deny')
  assert.match(bash.reason, /só orquestra/)
  validationChild = host.state.agents.find((agent) => agent.id === spec.childId)
})

await test('a stale member bit fails with a coded, model-visible error', async () => {
  await runtime.bindings.set('orphan-session', { teamId: env.orphan.id, role: 'lead', parentSession: null })
  const orphanAgent = host.makeAgent('orphan-session', { cwd: env.elsewhere })
  await host.emit('agent/created', { agent: orphanAgent, source: 'startup' })
  const delegateDef = host.state.tools.get('orphan-session').get('team_delegate')
  await assert.rejects(delegateDef.execute({ member: 'gone', task: 'x' }, execOf(orphanAgent, 'team_delegate', {})), (error) => codedOf(error) === 'TEAM_INVALID' && /não existe mais/.test(error.message))
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
  const output = await handoff.execute({ team: env.validation.id, request: 'valide o AB 1' }, execOf(lead, 'team_handoff', {}))
  assert.match(output, /Sessão passada ao time «Validação»/)
  assert.match(output, /Validator/)
  await sleep(20)
  assert.equal(runtime.bindings.get('root-1').teamId, env.validation.id)
  assert.match(host.sections.get('root-1').text(), /# Time de bits: Validação/)
  assert.ok(host.state.invalidations > 0, 'skills catalog invalidated')
  const diag = runtime.diagnostics()
  const entry = diag.agents.find((agent) => agent.sessionId === 'root-1')
  assert.equal(entry.teamId, env.validation.id)
  assert.equal(entry.bitId, 'bit-validator')
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
  const started = await runtime.startMission({ team: 'Implementação', prompt: 'implemente o AB 123' })
  assert.equal(created[0].cwd, env.workspace)
  assert.equal(created[0].sessionId, started.sessionId)
  assert.deepEqual(attached, [started.sessionId])
  // Lead route comes from the lead bit (DeepSeek-V4.1-Flash Max).
  const selection = host.state.selected.find((item) => item.id === started.sessionId)
  assert.deepEqual(selection.selection, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' })
  assert.equal(followups[0].content[0].text, 'implemente o AB 123')
  assert.equal(followups[0].role, 'user')
  assert.equal(runtime.bindings.get(started.sessionId).role, 'lead')
  assert.match(host.sections.get(started.sessionId).text(), /# Time de bits: Implementação/)
  assert.match(renamed[0], /👥 Implementação: implemente o AB 123/)
  // Continue: the message reaches the same lead session.
  const continued = await runtime.continueMission({ sessionId: started.sessionId, prompt: 'responda a PAUSA' })
  assert.equal(continued.teamId, env.main.id)
  assert.equal(followups.at(-1).content[0].text, 'responda a PAUSA')
  await assert.rejects(runtime.startMission({ team: 'nope', prompt: 'x' }), /não encontrado/)
  await assert.rejects(runtime.startMission({ team: 'Quebrado', prompt: 'x' }), (error) => codedOf(error) === 'TEAM_LEAD_NOT_ORCHESTRATOR' && /precisa ser um bit orquestrador/.test(error.message))
  await assert.rejects(runtime.startMission({ team: 'Implementação', prompt: '   ' }), (error) => codedOf(error) === 'BAD_REQUEST')
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
