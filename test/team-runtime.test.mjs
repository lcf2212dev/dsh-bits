/**
 * Team runtime against a fake host context: resolution, prompt, restrictions,
 * delegation (route resolution + child binding), guard, handoff, skills,
 * applyTo and shell variables. Uses a fixture harness pack with a tiny guard.
 *
 * Plain `node test/team-runtime.test.mjs`.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { transpileHarness } from '../host/harness.js'
import { TeamStore } from '../host/teams.js'
import { installTeamRuntime } from '../host/team-runtime.js'
import { flowText, rosterText } from '../host/team-prompt.js'
import { guardEvent, leadMayRead, toClaudeTool } from '../host/team-guard.js'
import { teamFromPack } from '../host/harness-routes.js'

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
  if (readOnly && /^(Write|Edit)$/.test(event.tool_name)) deny('Regra do repositório: agente somente leitura.')
  if (!process.env.DSH_HARNESS_PACK_ROOT) deny('pack root missing')
  process.stdout.write('{}')
})
`

async function fixture() {
  const source = await tempDir('dsh-bits-rt-src-')
  await write(source, 'AGENTS.md', '# Regras DSC\n\nSessão principal só orquestra. Rode `node .github/scripts/where.mjs`.\n')
  await write(source, '.github/copilot-instructions.md', '# Conduta\n\nResponda em pt-BR.\n')
  await write(source, '.github/harness.json', '{ "versao": 6 }\n')
  await write(source, '.github/hooks/scripts/git-guard.cjs', GUARD)
  await write(source, '.github/agents/runner.agent.md', '---\nname: runner\ndescription: Executa.\nmodel: Claude Haiku 5.5 (copilot)\nreasoning-effort: low\nhooks:\n  PreToolUse:\n    - command: node .github/hooks/scripts/git-guard.cjs --launches -\n---\n\n# Runner\n\nExecute comandos.\n')
  await write(source, '.github/agents/scout.agent.md', '---\nname: scout\ndescription: Localiza.\nmodel: Claude Haiku 5.5 (copilot)\nreasoning-effort: low\nhooks:\n  PreToolUse:\n    - command: node .github/hooks/scripts/git-guard.cjs --read-only --launches -\n---\n\n# Scout\n\nSó leitura.\n')
  await write(source, '.github/skills/tdd/SKILL.md', '---\nname: tdd\ndescription: Teste primeiro.\n---\n\n# TDD\n\nVermelho, verde.\n')
  await write(source, '.github/skills/tdd/references/x.md', 'ref\n')
  await write(source, '.github/instructions/ui.instructions.md', "---\nname: ui-components\ndescription: UI.\napplyTo: '**/packages/ui/src/**/*.tsx'\n---\n\n# UI\n\nUse tokens.\n")
  execFileSync('git', ['init', '-q', source])
  execFileSync('git', ['-C', source, 'add', '-A'])
  execFileSync('git', ['-C', source, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  const botsRoot = await tempDir('dsh-bits-rt-bots-')
  const workspace = await tempDir('dsh-bits-rt-ws-')
  const manifest = await transpileHarness({ sourceDir: source, packsRoot: path.join(botsRoot, 'harness'), packId: 'demo', name: 'Demo', patches: [] })
  const teams = new TeamStore({ botsRoot })
  await teams.init()
  const validation = await teams.create({
    name: 'Validação', workspaceDir: workspace, harness: 'demo', lead: 'validator',
    members: [
      { id: 'validator', name: 'Validator', access: 'write', model: 'Claude Sonnet 5.5', launches: ['scout', 'haiku-2', 'opus-1', 'ghost-provider', 'missing-model'] },
      { id: 'scout', name: 'Scout', access: 'read', instructions: 'Só leitura.' },
      // Members whose account is pinned in the team (the profile has two Anthropic accounts).
      { id: 'haiku-2', name: 'Haiku conta 2', access: 'write', model: 'Claude Haiku 5.5', provider: 'anthropic-2', effort: 'low' },
      { id: 'opus-1', name: 'Opus conta 1', access: 'write', model: 'Claude Opus 5.5', provider: 'anthropic', effort: 'xhigh' },
      { id: 'ghost-provider', name: 'Ghost', access: 'write', model: 'Claude Haiku 5.5', provider: 'nope' },
      { id: 'missing-model', name: 'Missing', access: 'write', model: 'Claude 9000', provider: 'anthropic-2' },
    ],
  })
  const main = await teams.create({
    name: 'Implementação', workspaceDir: workspace, harness: 'demo', lead: 'lider', bindWorkspace: true, rules: 'Regra extra do time.',
    members: [
      { id: 'lider', name: 'Orquestrador', access: 'read', instructions: 'Só orquestre.', launches: ['runner', 'scout', 'validacao'], skills: ['tdd'] },
      { id: 'runner', name: 'Runner', access: 'write', model: 'Claude Haiku 5.5', effort: 'low', instructions: 'Execute comandos.' },
      { id: 'scout', name: 'Scout', access: 'read', model: 'Claude Haiku 5.5', effort: 'low', instructions: 'Só leitura.' },
      { id: 'validacao', name: 'Time Validação', teamRef: validation.id },
    ],
    flow: {
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, w: 300, h: 400, label: '1. Fase' },
        { id: 's', type: 'start', x: 40, y: 50, label: 'Pedido' },
        { id: 'r', type: 'step', x: 30, y: 150, label: 'Rodar where', memberId: 'runner' },
        { id: 't', type: 'team', x: 30, y: 250, label: 'Validar', teamRef: validation.id },
      ],
      edges: [{ id: 'e1', from: 's', to: 'r' }, { id: 'e2', from: 'r', to: 't', label: 'pronto', kind: 'handoff' }],
    },
  })
  return { manifest, teams, botsRoot, workspace, validation, main }
}

function fakeHost({ workspace }) {
  const listeners = {}
  const sections = new Map()
  const state = { started: [], restricts: new Map(), tools: new Map(), provider: null, shell: null, invalidations: 0, agents: [] }
  const KNOWN = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'subagent', 'skill', 'spawn_teammate', 'send_message', 'plugin_manager', 'create_goal', 'ask_user_question', 'todo_write', 'working_directory', 'schedule_create'])
  function makeAgent(id, { cwd = workspace, origin } = {}) {
    const agent = {
      id,
      options: { provider: 'anthropic-2', model: 'claude-opus-5-5', reasoningEffort: 'xhigh' },
      session: { id, header: { cwd, ...(origin ? { origin } : {}) }, cwd },
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
  const ctx = {
    on(name, fn) {
      ;(listeners[name] = listeners[name] || []).push(fn)
      return () => { listeners[name] = listeners[name].filter((item) => item !== fn) }
    },
    workingDirectory: { get: (session) => session.cwd },
    agents: { list: () => state.agents, get: (id) => state.agents.find((agent) => agent.id === id) },
    skills: { registerProvider(create) { state.provider = create({ invalidate() { state.invalidations += 1 }, signal: new AbortController().signal }); return () => {} } },
    shellEnv: { register(contributor) { state.shell = contributor; return () => {} } },
    llm: {
      listProviders: () => [{ id: 'anthropic', name: 'Anthropic' }, { id: 'anthropic-2', name: 'Anthropic (conta 2)' }],
      listModels: async (provider) => [
        { provider: provider, id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
        { provider: provider, id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
        { provider: provider, id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      ],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }] } }),
      resolveCallConfig: async (config) => config,
    },
    subagents: {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: { agentOptions: true, depthLimit: true }, inheritsParentContext: false }),
      async startActivation(spec) {
        state.started.push(spec)
        const child = makeAgent(spec.childId, { origin: 'subagent', cwd: spec.request.parent.session.cwd })
        await emit('agent/created', { agent: child, source: 'startup' })
        return { childId: spec.childId, result: Promise.resolve({ output: [{ type: 'text', text: `relatório de ${spec.childId}` }], stopReason: 'completed' }), dispose() {} }
      },
    },
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
  return { ctx, state, sections, makeAgent, emit, preExecute, postExecute }
}

const execOf = (agent, name, args) => ({ name, arguments: args, agent, callId: 'c', signal: new AbortController().signal })

/* -------------------------------- tests -------------------------------- */

await test('pure helpers: flowText, rosterText, guard mapping, lead read policy', async () => {
  const team = {
    lead: 'l',
    members: [{ id: 'l', name: 'Líder', access: 'read', launches: [], skills: [] }, { id: 'b', name: 'Builder', role: 'Implementa', model: 'Claude Sonnet 5.5', effort: 'medium', access: 'write', launches: ['l'], skills: ['tdd'] }],
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
  const text = flowText(team)
  assert.match(text, /### Fase A — det/)
  assert.match(text, /\[b1\] Etapa «Fazer» — Builder \(`b`\)\. com testes/)
  assert.match(text, /→ “ok”: \[b1\] «Fazer» \(retorno\/correção\)/)
  assert.match(text, /\*\*Regra:\*\* linha 1 linha 2/)
  const roster = rosterText(team)
  assert.match(roster, /Líder \(`l`\) \*\*\(líder\)\*\*/)
  assert.match(roster, /Claude Sonnet 5\.5 · medium \| leitura e escrita \| `l` \| `tdd`/)
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

await test('teamFromPack builds a runnable generic team from a manifest', async () => {
  const { manifest } = await fixture()
  const team = teamFromPack(manifest, { workspaceDir: '/w', has: () => true })
  assert.equal(team.lead, 'lider')
  assert.equal(team.harness, 'demo')
  assert.deepEqual(team.members.map((member) => [member.id, member.access, member.character]), [['lider', 'read', 'bit-coordinator'], ['runner', 'write', 'bit-runner'], ['scout', 'read', 'bit-scout']])
  assert.deepEqual(team.members[0].launches, ['runner', 'scout'])
  assert.equal(team.members[1].model, 'Claude Haiku 5.5')
  assert.ok(team.flow.edges.some((edge) => edge.kind === 'delegate'))
})

const env = await fixture()
const host = fakeHost(env)
let releaseTeams
const teamsReady = new Promise((resolve) => { releaseTeams = resolve })
const runtime = installTeamRuntime(host.ctx, { teams: env.teams, teamsReady, botsRoot: env.botsRoot, log: () => {} })
// Hooks may fire before the store is ready: nothing resolves, and nothing stale is cached.
await new Promise((resolve) => setTimeout(resolve, 10))
assert.deepEqual(await host.state.provider.list({ scope: host.makeAgent('early') }), [])
releaseTeams()
await runtime.ready
const lead = host.makeAgent('root-1')
await host.emit('agent/created', { agent: lead, source: 'startup' })

await test('a root session in the bound workspace becomes the lead', async () => {
  const section = host.sections.get('root-1')
  assert.ok(section, 'prompt section installed')
  const text = section.text()
  assert.match(text, /# Time de bits: Implementação/)
  assert.match(text, /Você é \*\*Orquestrador\*\* \(`lider`\)/)
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
  assert.deepEqual(tools.get('team_delegate').parameters.properties.member.enum, ['runner', 'scout', 'validacao'])
  assert.deepEqual(tools.get('team_handoff').parameters.properties.team.enum, [env.validation.id])
})

await test('the lead may only read the pack and .dsc files; it cannot run tools it does not have', async () => {
  const packFile = path.join(env.manifest.packDir, '.github/skills/tdd/SKILL.md')
  assert.equal((await host.preExecute(execOf(lead, 'read', { file_path: packFile }))).kind, 'allow')
  assert.equal((await host.preExecute(execOf(lead, 'read', { file_path: '.dsc/contexto.md' }))).kind, 'allow')
  const denied = await host.preExecute(execOf(lead, 'read', { file_path: 'packages/a.ts' }))
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /só lê o pacote do harness/)
  assert.equal((await host.preExecute(execOf(lead, 'bash', { command: 'ls' }))).kind, 'deny')
})

let runnerChild
let validationChild
await test('team_delegate runs a member with its resolved route and binding', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  const output = await delegateDef.execute({ member: 'runner', task: 'Rode o where.mjs' }, execOf(lead, 'team_delegate', {}))
  const spec = host.state.started.at(-1)
  assert.deepEqual(spec.request.agentOptions, { provider: 'anthropic-2', model: 'claude-haiku-5-5', reasoningEffort: 'low' })
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.maxDepth, 4)
  assert.match(spec.request.prompt[0].text, /Tarefa delegada por Orquestrador/)
  assert.match(output, /relatório de/)
  assert.match(output, /anthropic-2\/claude-haiku-5-5 · low/)
  runnerChild = host.state.agents.find((agent) => agent.id === spec.childId)
  const text = host.sections.get(spec.childId).text()
  assert.match(text, /# Runner — membro do time Implementação/)
  assert.match(text, /Execute comandos\./)
  assert.match(text, /Você não lança outros membros/)
  assert.match(text, /Você é um \*\*membro\*\* chamado por `team_delegate`/)
  assert.equal(host.state.tools.get(spec.childId), undefined, 'runner launches nobody: no team_delegate')
  assert.equal(runtime.bindings.get(spec.childId).memberId, 'runner')
  await assert.rejects(delegateDef.execute({ member: 'ghost', task: 'x' }, execOf(lead, 'team_delegate', {})), /não pode ser lançado/)
})

await test('the harness guard runs for members (deny git stash) with the pack root', async () => {
  const stash = await host.preExecute(execOf(runnerChild, 'bash', { command: 'git stash' }))
  assert.equal(stash.kind, 'deny')
  assert.match(stash.reason, /git stash é proibido/)
  assert.equal((await host.preExecute(execOf(runnerChild, 'bash', { command: 'ls' }))).kind, 'allow')
})

await test('read-only members lose write tools and run the guard in read-only mode', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  await delegateDef.execute({ member: 'scout', task: 'Ache X' }, execOf(lead, 'team_delegate', {}))
  const childId = host.state.started.at(-1).childId
  const scout = host.state.agents.find((agent) => agent.id === childId)
  const deny = host.state.restricts.get(childId).deny
  assert.ok(deny.includes('write') && deny.includes('edit') && deny.includes('subagent'))
  assert.ok(!deny.includes('bash'), 'members keep their shell')
  assert.ok(deny.includes('ask_user_question') && deny.includes('spawn_teammate') && deny.includes('plugin_manager'), 'members return questions and never see profile tools')
  const write = await host.preExecute(execOf(scout, 'write', { file_path: path.join(env.workspace, 'a.txt'), content: 'x' }))
  assert.equal(write.kind, 'deny')
  assert.match(write.reason, /somente leitura/)
})

await test('delegating to a team member runs the other team lead as a child', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  await delegateDef.execute({ member: 'validacao', task: 'Valide' }, execOf(lead, 'team_delegate', {}))
  const spec = host.state.started.at(-1)
  assert.equal(spec.request.agentOptions.model, 'claude-sonnet-5-5', 'route of the other team lead')
  const binding = runtime.bindings.get(spec.childId)
  assert.equal(binding.teamId, env.validation.id)
  assert.equal(binding.role, 'lead')
  const text = host.sections.get(spec.childId).text()
  assert.match(text, /# Time de bits: Validação/)
  assert.match(text, /Você foi chamado por outro time/)
  const tools = host.state.tools.get(spec.childId)
  assert.deepEqual(tools.get('team_delegate').parameters.properties.member.enum, ['scout', 'haiku-2', 'opus-1', 'ghost-provider', 'missing-model'])
  assert.equal(tools.get('team_handoff'), undefined, 'child leads cannot hand off')
  assert.ok(!host.state.restricts.get(spec.childId).deny.includes('bash'), 'a write lead (validator) keeps its shell')
  validationChild = host.state.agents.find((agent) => agent.id === spec.childId)
})

await test('member.provider pins the route to that profile account (and only that account)', async () => {
  const delegateDef = host.state.tools.get('root-1').get('team_delegate')
  // The caller (validation lead) runs on anthropic-2; a member pinned to
  // anthropic keeps its own account instead of inheriting the caller's.
  const validationTools = host.state.tools.get(validationChild.id)
  await validationTools.get('team_delegate').execute({ member: 'opus-1', task: 'Revise' }, execOf(validationChild, 'team_delegate', {}))
  let spec = host.state.started.at(-1)
  assert.equal(spec.request.agentOptions.provider, 'anthropic', 'pinned account beats the caller preference')
  assert.equal(spec.request.agentOptions.model, 'claude-opus-5-5')
  assert.equal(spec.request.agentOptions.reasoningEffort, 'xhigh')
  assert.match(host.sections.get(spec.childId).text(), /Claude Opus 5\.5 — Anthropic · xhigh/)

  await validationTools.get('team_delegate').execute({ member: 'haiku-2', task: 'Rode' }, execOf(validationChild, 'team_delegate', {}))
  spec = host.state.started.at(-1)
  assert.equal(spec.request.agentOptions.provider, 'anthropic-2')
  assert.equal(spec.request.agentOptions.model, 'claude-haiku-5-5')
  assert.equal(spec.request.agentOptions.reasoningEffort, 'low')
  assert.match(host.sections.get(spec.childId).text(), /Claude Haiku 5\.5 — Anthropic \(conta 2\) · low/)

  // A typo never falls back to another account: the delegate fails loudly.
  await assert.rejects(
    validationTools.get('team_delegate').execute({ member: 'ghost-provider', task: 'x' }, execOf(validationChild, 'team_delegate', {})),
    /O provedor "nope" do membro ghost-provider não existe neste perfil/,
  )
  await assert.rejects(
    validationTools.get('team_delegate').execute({ member: 'missing-model', task: 'x' }, execOf(validationChild, 'team_delegate', {})),
    /O modelo "Claude 9000" do membro missing-model não existe no provedor "anthropic-2"/,
  )
})

await test('skills, applyTo and shell variables follow the team', async () => {
  const skills = await host.state.provider.list({ scope: runnerChild })
  assert.deepEqual(skills.map((skill) => skill.name), ['tdd'])
  assert.equal(skills[0].resourceBase.path, path.join(env.manifest.packDir, '.github/skills/tdd'))
  const definition = await host.state.provider.get(skills[0])
  assert.match(definition.content, /^\n?# TDD/)
  assert.deepEqual(await host.state.provider.list({ scope: host.makeAgent('elsewhere', { cwd: '/tmp' }) }), [])
  const file = path.join(env.workspace, 'packages/ui/src/Button/Button.tsx')
  const first = await host.postExecute(execOf(runnerChild, 'edit', { file_path: file }))
  assert.equal(first.additionalContexts.length, 1)
  assert.match(first.additionalContexts[0].content[0].text, /Use tokens\./)
  const second = await host.postExecute(execOf(runnerChild, 'read', { file_path: file }))
  assert.equal(second.additionalContexts, undefined, 'once per agent')
  const vars = host.state.shell.resolve(execOf(runnerChild, 'bash', { command: 'x' }))
  assert.equal(vars.DSH_HARNESS_PACK_ROOT, env.manifest.packDir)
  assert.equal(vars.DSH_TEAM_MEMBER, 'runner')
  assert.deepEqual(host.state.shell.resolve(execOf(host.makeAgent('other', { cwd: '/tmp' }), 'bash', {})), {})
})

await test('team_handoff rebinds the session to the other team lead', async () => {
  const handoff = host.state.tools.get('root-1').get('team_handoff')
  const output = await handoff.execute({ team: env.validation.id, request: 'valide o AB 1' }, execOf(lead, 'team_handoff', {}))
  assert.match(output, /Sessão passada ao time «Validação»/)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(runtime.bindings.get('root-1').teamId, env.validation.id)
  assert.match(host.sections.get('root-1').text(), /# Time de bits: Validação/)
  assert.ok(host.state.invalidations > 0, 'skills catalog invalidated')
  const diag = runtime.diagnostics()
  assert.ok(diag.agents.some((agent) => agent.sessionId === 'root-1' && agent.teamId === env.validation.id))
})

await test('startMission creates a lead session in the team workspace and delivers the request', async () => {
  const created = []
  const followups = []
  const attached = []
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
    return undefined
  }
  const started = await runtime.startMission({ team: 'Implementação', prompt: 'implemente o AB 123' })
  assert.equal(created[0].cwd, env.workspace)
  assert.equal(created[0].sessionId, started.sessionId)
  assert.deepEqual(attached, [started.sessionId])
  assert.equal(followups[0].content[0].text, 'implemente o AB 123')
  assert.equal(followups[0].role, 'user')
  assert.equal(runtime.bindings.get(started.sessionId).role, 'lead')
  assert.match(host.sections.get(started.sessionId).text(), /# Time de bits: Implementação/)
  await assert.rejects(runtime.startMission({ team: 'nope', prompt: 'x' }), /não encontrado/)
})

runtime.dispose()
for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\nteam-runtime: ${failures.length} failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\nteam-runtime: ${passed} tests passed`)
}
