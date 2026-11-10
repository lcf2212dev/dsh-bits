/**
 * Tests for the harness transpiler (`host/harness.js`) and the harness→team
 * projection (`host/harness-routes.js`, V5-CONTRACT §5.3): a fixture repository
 * with a Copilot-style harness is transpiled into a pack; checks the manifest,
 * the Markdown rewrites, the anchored script patches and atomic replacement;
 * `teamFromPack` returns `{ bits, team }` (lead bit on the orchestrator route,
 * one worker bit per preset) and `/api/bots.teams.fromPack` creates the bits
 * and the team. When the real DSC harness is available (DSC_HARNESS_SOURCE or
 * the default path), it is transpiled too and its guard is exercised from the
 * pack.
 *
 * Plain `node test/harness.test.mjs`; Node built-ins only.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { listPacks, modelTier, parseFrontmatter, readPack, rewriteMarkdown, transpileHarness } from '../host/harness.js'
import { registerHarnessRoutes, teamFromPack } from '../host/harness-routes.js'
import { TeamStore } from '../host/teams.js'

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
  const file = path.join(root, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

async function fixtureRepo() {
  const repo = await tempDir('dsh-bits-harness-src-')
  await write(repo, 'AGENTS.md', '# Regras\n\nRode `node .github/scripts/where.mjs --card <n>` antes.\nVeja `.github/skills/tdd/SKILL.md` e `packages/ui/src`.\n')
  await write(repo, '.github/harness.json', '{ "versao": 7 }\n')
  await write(repo, '.github/copilot-instructions.md', '# Conduta\n')
  await write(repo, '.github/agents/scout.agent.md', [
    '---', 'name: scout', 'description: Localiza.', 'model: Claude Haiku 5.5 (copilot)', 'reasoning-effort: low', 'user-invocable: false',
    'hooks:', '  PreToolUse:', '    - type: command', '      command: node .github/hooks/scripts/git-guard.cjs --read-only --launches -', '---', '', '# Scout', '', 'Busca.', '',
  ].join('\n'))
  await write(repo, '.github/agents/builder.agent.md', [
    '---', 'name: builder', 'description: Implementa.', 'model: Claude Sonnet 5.5 (copilot)', 'reasoning-effort: medium',
    'hooks:', '  PreToolUse:', '    - type: command', '      command: node .github/hooks/scripts/git-guard.cjs --launches scout', '---', '',
    '**Skills:** leia antes a [`tdd`](../skills/tdd/SKILL.md).', '', 'Código.', '',
  ].join('\n'))
  await write(repo, '.github/skills/tdd/SKILL.md', '---\nname: tdd\ndescription: Teste antes.\n---\n\n# TDD\n\nRode `node .github/skills/tdd/scripts/run.mjs`.\n')
  await write(repo, '.github/skills/tdd/scripts/run.mjs', 'console.log("ok")\n')
  await write(repo, '.github/instructions/ui.instructions.md', "---\nname: ui\ndescription: UI.\napplyTo: '**/packages/ui/**/*.ts,**/packages/ui/**/*.tsx'\n---\n\n# UI\n")
  await write(repo, '.github/scripts/where.mjs', "const v = readFileSync(path.join(dir, '.github', 'harness.json'), 'utf8')\n")
  await write(repo, '.github/workflows/ci.yml', 'name: ci\n')
  await write(repo, '.mcp.json', JSON.stringify({ mcpServers: { files: { type: 'stdio', command: 'node', args: ['.github/scripts/mcp-files.mjs'] } } }))
  await write(repo, 'packages/ui/src/index.ts', 'export {}\n')
  await write(repo, '.env', 'SECRET=1\n')
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'add', '-A'])
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  return repo
}

await test('parseFrontmatter and modelTier', () => {
  const parsed = parseFrontmatter('---\nname: x\nmodel: "Claude Opus 5.5 (copilot)"\nhooks:\n  a: b\n---\nbody\n')
  assert.equal(parsed.fields.name, 'x')
  assert.equal(parsed.fields.model, 'Claude Opus 5.5 (copilot)')
  assert.equal(parsed.body, 'body\n')
  assert.deepEqual(modelTier('Claude Opus 5.5 (copilot)'), { tier: 'strong', label: 'Claude Opus 5.5' })
  assert.equal(modelTier('Claude Sonnet 5.5').tier, 'balanced')
  assert.equal(modelTier('haiku').tier, 'fast')
  assert.equal(modelTier('').tier, null)
})

await test('rewriteMarkdown points harness commands and files at the pack only', () => {
  const out = rewriteMarkdown('Rode `node .github/scripts/where.mjs`. Leia `.github/skills/x/SKILL.md`. Não toque `.github/workflows/ci.yml` nem packages/.', '/p')
  assert.match(out, /`node \/p\/\.github\/scripts\/where\.mjs`/)
  assert.match(out, /`\/p\/\.github\/skills\/x\/SKILL\.md`/)
  assert.match(out, /`\.github\/workflows\/ci\.yml`/)
})

await test('transpileHarness builds the pack, manifest, rewrites and patches', async () => {
  const repo = await fixtureRepo()
  const packsRoot = await tempDir('dsh-bits-packs-')
  const patches = [
    { id: 'where', file: '.github/scripts/where.mjs', from: "path.join(dir, '.github', 'harness.json')", to: "path.join(process.env.DSH_HARNESS_PACK_ROOT || dir, '.github', 'harness.json')", why: 'x' },
    { id: 'missing', file: '.github/nope.cjs', from: 'a', to: 'b', why: 'y' },
  ]
  const manifest = await transpileHarness({ sourceDir: repo, packsRoot, packId: 'demo', name: 'Demo', patches })
  const pack = path.join(packsRoot, 'demo')
  assert.equal(manifest.packDir, pack)
  assert.equal(manifest.harnessVersion, 7)
  assert.equal(manifest.rules, 'AGENTS.md')
  assert.equal(manifest.conduct, '.github/copilot-instructions.md')
  assert.deepEqual(manifest.agents.map((agent) => [agent.name, agent.tier, agent.effort, agent.readOnly, agent.launches]), [
    ['builder', 'balanced', 'medium', false, ['scout']],
    ['scout', 'fast', 'low', true, []],
  ])
  assert.deepEqual(manifest.agents[0].skills, ['tdd'])
  assert.equal(manifest.agents[1].userInvocable, false)
  assert.deepEqual(manifest.skills.map((skill) => [skill.name, skill.resources]), [['tdd', ['.github/skills/tdd/scripts/run.mjs']]])
  assert.deepEqual(manifest.instructions[0].applyTo, ['**/packages/ui/**/*.ts', '**/packages/ui/**/*.tsx'])
  assert.deepEqual(manifest.mcp.files.args, [path.join(pack, '.github/scripts/mcp-files.mjs')])
  assert.deepEqual(manifest.patches.map((patch) => [patch.id, patch.applied]), [['where', true], ['missing', false]])
  // Copied files, exclusions and rewrites.
  assert.equal(existsSync(path.join(pack, '.github/workflows/ci.yml')), false, 'CI is not harness')
  assert.equal(existsSync(path.join(pack, 'packages')), false)
  assert.equal(existsSync(path.join(pack, '.env')), false)
  const rules = await fs.readFile(path.join(pack, 'AGENTS.md'), 'utf8')
  assert.match(rules, new RegExp(`node ${pack.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.github/scripts/where\\.mjs`))
  assert.match(rules, /`packages\/ui\/src`/)
  const where = await fs.readFile(path.join(pack, '.github/scripts/where.mjs'), 'utf8')
  assert.match(where, /DSH_HARNESS_PACK_ROOT/)
  assert.equal((await readPack(packsRoot, 'demo')).id, 'demo')
  assert.deepEqual((await listPacks(packsRoot)).map((item) => item.id), ['demo'])
})

await test('transpileHarness replaces an existing pack atomically and validates input', async () => {
  const repo = await fixtureRepo()
  const packsRoot = await tempDir('dsh-bits-packs-')
  await transpileHarness({ sourceDir: repo, packsRoot, packId: 'demo', patches: [] })
  await fs.writeFile(path.join(packsRoot, 'demo', 'stale.txt'), 'x')
  await write(repo, 'AGENTS.md', '# Regras v2\n')
  await transpileHarness({ sourceDir: repo, packsRoot, packId: 'demo', patches: [] })
  assert.equal(existsSync(path.join(packsRoot, 'demo', 'stale.txt')), false)
  assert.match(await fs.readFile(path.join(packsRoot, 'demo', 'AGENTS.md'), 'utf8'), /v2/)
  assert.deepEqual((await fs.readdir(packsRoot)).filter((entry) => entry.startsWith('.')), [])
  await assert.rejects(transpileHarness({ sourceDir: 'relative', packsRoot, packId: 'x' }), { code: 'HARNESS_INVALID_SOURCE' })
  await assert.rejects(transpileHarness({ sourceDir: repo, packsRoot, packId: 'Bad Id' }), { code: 'HARNESS_INVALID_ID' })
  const empty = await tempDir('dsh-bits-empty-')
  await assert.rejects(transpileHarness({ sourceDir: empty, packsRoot, packId: 'x' }), { code: 'HARNESS_NOT_FOUND' })
})

const DSC = process.env.DSC_HARNESS_SOURCE || path.join(os.homedir(), 'Development/work/dsc')
if (existsSync(path.join(DSC, '.github/hooks/scripts/git-guard.cjs'))) {
  await test('real DSC harness: transpiles, patches apply and the guard runs from the pack', async () => {
    const packsRoot = await tempDir('dsh-bits-packs-dsc-')
    const manifest = await transpileHarness({ sourceDir: DSC, packsRoot, packId: 'dsc', name: 'DSC' })
    assert.ok(manifest.agents.length >= 10)
    assert.ok(manifest.skills.length >= 15)
    assert.ok(manifest.patches.every((patch) => patch.applied), JSON.stringify(manifest.patches))
    const guard = path.join(manifest.packDir, manifest.hooks.guard)
    const decide = (command, flags = []) => {
      const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: DSC }
      const result = spawnSync(process.execPath, [guard, ...flags], {
        input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, DSH_HARNESS_PACK_ROOT: manifest.packDir }, timeout: 15000,
      })
      return result.status
    }
    assert.equal(decide('git stash'), 2)
    assert.equal(decide('git push --force origin x'), 2)
    assert.equal(decide('ls -la'), 0)
    assert.equal(decide(`node ${manifest.packDir}/.github/scripts/where.mjs --card 1`, ['--read-only']), 0, 'pack scripts are trusted')
    assert.equal(decide('yarn test Button', ['--read-only']), 2)
  })
}


// ---------------------------------------------------------------------------
// Harness → team (V5-CONTRACT §5.3)
// ---------------------------------------------------------------------------

/** Minimal in-memory BitStore (only what the team/fromPack paths use). */
function fakeBitStore({ initial = [] } = {}) {
  let counter = 0
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const records = initial.map((bit) => ({
    id: bit.id,
    name: bit.name,
    character: bit.character ?? null,
    emoji: bit.emoji ?? '🤖',
    color: bit.color ?? '#475569',
    instructions: bit.instructions ?? '',
    isOrchestrator: bit.isOrchestrator === true,
    model: bit.model ?? 'subscription/sonnet',
    effort: bit.effort ?? 'high',
  }))
  return {
    records,
    list: () => clone(records),
    get(id) {
      const record = records.find((item) => item.id === id)
      return record === undefined ? undefined : clone(record)
    },
    async create(input) {
      counter += 1
      const record = {
        id: counter.toString(16).padStart(10, '0'),
        name: String(input.name ?? 'Bit').trim(),
        character: input.character ?? null,
        emoji: input.emoji ?? '🤖',
        color: String(input.color ?? '#475569').toLowerCase(),
        instructions: typeof input.instructions === 'string' ? input.instructions : '',
        isOrchestrator: input.isOrchestrator === true,
        model: typeof input.model === 'string' && input.model !== '' ? input.model : 'subscription/sonnet',
        effort: typeof input.effort === 'string' && input.effort !== '' ? input.effort : 'high',
      }
      records.push(record)
      return clone(record)
    },
    async update(id, patch) {
      const record = records.find((item) => item.id === id)
      Object.assign(record, patch)
      return clone(record)
    },
    async remove(id) {
      const index = records.findIndex((item) => item.id === id)
      if (index < 0) return undefined
      return clone(records.splice(index, 1)[0])
    },
  }
}

function fakeConnection() {
  const routes = new Map()
  const ctx = { connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } } }
  async function call(routePath, body) {
    const request = new Request(`http://x${routePath}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const response = await routes.get(routePath).fetch(request)
    assert.equal(response.status, 200)
    return response.json()
  }
  return { ctx, routes, call }
}

const packManifest = {
  format: 'dsh-bits-harness',
  id: 'demo',
  name: 'Demo',
  packDir: '/packs/demo',
  createdAt: '2026-01-01T00:00:00.000Z',
  agents: [
    { name: 'builder', description: 'Implementa', model: 'Claude Sonnet 5.5 (copilot)', effort: 'medium', readOnly: false, launches: ['scout'], skills: ['tdd', 'unknown'], instructions: 'Implemente.' },
    { name: 'scout', description: 'Busca', model: 'Claude Haiku 5.5 (copilot)', effort: 'low', readOnly: true, launches: [], skills: ['tdd'], instructions: 'Busque.' },
    { name: 'writer', description: 'Docs', model: '', effort: 'bogus', readOnly: false, launches: [], skills: [], instructions: 'Escreva.' },
  ],
  skills: [{ name: 'tdd', description: 'TDD' }],
  instructions: [],
  mcp: {},
  patches: [],
  files: [],
  source: { dir: '/repo', commit: null },
}

const harnessCatalog = {
  has: (id) => ['bit-builder', 'bit-scout', 'bit-writer', 'bit-coordinator', 'bit-mascot'].includes(id),
  get(id) {
    const table = {
      'bit-builder': { model: 'subscription/sonnet', effort: 'high', emoji: '🛠️', color: '#7c3aed' },
      'bit-scout': { model: 'subscription/haiku', effort: 'low', emoji: '🔎', color: '#0891b2' },
      'bit-writer': { model: 'subscription/sonnet', effort: 'medium', emoji: '✍️', color: '#059669' },
      'bit-coordinator': { model: 'deepseek-account/deepseek-flash', effort: 'max', isOrchestrator: true, emoji: '🧭', color: '#2655ae' },
    }
    return Object.assign({ id }, table[id] ?? {})
  },
}

await test('teamFromPack returns { bits, team }: lead orchestrator + one worker bit per preset', () => {
  const { bits, team } = teamFromPack(packManifest, { name: 'Meu time', workspaceDir: '/w', has: () => true })
  assert.ok(Array.isArray(bits))
  assert.equal(bits.length, 4, 'lead + one bit per preset')
  const lead = bits.find((bit) => bit.key === 'lider')
  assert.equal(lead.name, 'Orquestrador')
  assert.equal(lead.character, 'bit-coordinator')
  assert.equal(lead.isOrchestrator, true)
  assert.equal(lead.model, 'deepseek-account/deepseek-flash')
  assert.equal(lead.effort, 'max')
  assert.ok(lead.instructions.length > 0)

  const byKey = new Map(bits.map((bit) => [bit.key, bit]))
  assert.equal(byKey.get('builder').name, 'builder')
  assert.equal(byKey.get('builder').character, 'bit-builder')
  assert.equal(byKey.get('builder').isOrchestrator, false)
  assert.equal(byKey.get('builder').instructions, 'Implemente.')
  assert.equal(byKey.get('builder').model, 'subscription/sonnet', 'fallback worker model without a catalog')
  assert.equal(byKey.get('builder').effort, 'medium', 'preset effort when it is a valid CLI effort')
  assert.equal(byKey.get('scout').effort, 'low')
  assert.equal(byKey.get('writer').effort, 'high', 'invalid preset effort falls back to high')

  // The team references the definitions by local key (template shape).
  assert.equal(team.name, 'Meu time')
  assert.equal(team.harness, 'demo')
  assert.equal(team.workspaceDir, '/w')
  assert.equal(team.lead, 'lider')
  assert.equal(team.members.length, 4)
  assert.deepEqual(team.members.map((member) => member.id), ['lider', 'builder', 'scout', 'writer'])
  assert.deepEqual(team.members.map((member) => member.bitKey), ['lider', 'builder', 'scout', 'writer'])
  assert.equal(team.members[0].access, 'read')
  assert.deepEqual(team.members[0].launches, ['builder', 'scout', 'writer'])
  assert.equal(team.members.find((member) => member.id === 'scout').access, 'read')
  assert.equal(team.members.find((member) => member.id === 'builder').access, 'write')
  assert.deepEqual(team.members.find((member) => member.id === 'builder').skills, ['tdd'])
  assert.deepEqual(team.members.find((member) => member.id === 'writer').skills, [])
  assert.equal(team.members.every((member) => typeof member.role === 'string' && typeof member.bitId === 'undefined'), true)
  assert.deepEqual(team.flow.nodes.map((node) => node.id).slice(0, 3), ['start', 'lead', 'm-builder'])
  assert.equal(team.flow.nodes.find((node) => node.id === 'lead').memberId, 'lider')
  assert.ok(team.flow.edges.some((edge) => edge.from === 'lead' && edge.to === 'm-builder' && edge.kind === 'delegate'))
  assert.equal(team.flow.nodes.at(-1).id, 'end')
})

await test('teamFromPack uses the catalog defaults for the mapped characters', () => {
  const { bits } = teamFromPack(packManifest, { has: (id) => harnessCatalog.has(id), catalog: harnessCatalog })
  const byKey = new Map(bits.map((bit) => [bit.key, bit]))
  assert.equal(byKey.get('builder').model, 'subscription/sonnet')
  assert.equal(byKey.get('builder').effort, 'high', 'catalog effort wins over the preset effort')
  assert.equal(byKey.get('scout').model, 'subscription/haiku')
  assert.equal(byKey.get('scout').effort, 'low')
  assert.equal(byKey.get('lider').model, 'deepseek-account/deepseek-flash')
})

await test('teams.fromPack creates the bits and then the team, returning { team, bits }', async () => {
  const botsRoot = await tempDir('dsh-bits-packs-')
  const packsRoot = path.join(botsRoot, 'harness')
  await fs.mkdir(path.join(packsRoot, 'demo'), { recursive: true })
  await fs.writeFile(path.join(packsRoot, 'demo', 'manifest.json'), JSON.stringify(packManifest))
  const bits = fakeBitStore()
  const teams = new TeamStore({ botsRoot, bits })
  await teams.init()
  const { ctx, routes, call } = fakeConnection()
  registerHarnessRoutes(ctx, { teams, bits, ready: Promise.resolve(), botsRoot, catalog: harnessCatalog })

  const created = await call('/api/bots.teams.fromPack', { packId: 'demo' })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.bits.length, 4)
  assert.equal(created.team.harness, 'demo')
  assert.equal(created.team.lead, 'lider')
  assert.equal(created.team.members.length, 4)
  assert.deepEqual(created.team.members.map((member) => member.bitId), created.bits.map((bit) => bit.id))
  assert.equal(bits.records.length, 4, 'the bits are persisted by the route')
  const leadBit = bits.records.find((bit) => bit.id === created.team.members[0].bitId)
  assert.equal(leadBit.isOrchestrator, true)
  assert.equal(bits.records.find((bit) => bit.name === 'builder').isOrchestrator, false)
  assert.equal(teams.list().length, 1)
  assert.equal(teams.get(created.team.id).harness, 'demo')

  const missing = await call('/api/bots.teams.fromPack', { packId: 'nope' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'HARNESS_NOT_FOUND')
})

await test('teams.fromPack assigns the optional project and rejects unknown ones', async () => {
  const botsRoot = await tempDir('dsh-bits-packs-')
  const packsRoot = path.join(botsRoot, 'harness')
  await fs.mkdir(path.join(packsRoot, 'demo'), { recursive: true })
  await fs.writeFile(path.join(packsRoot, 'demo', 'manifest.json'), JSON.stringify(packManifest))
  const bits = fakeBitStore()
  const teams = new TeamStore({ botsRoot, bits })
  await teams.init()
  const projectId = '1111111111'
  const projects = { get: (id) => (id === projectId ? { id } : undefined) }
  const { ctx, call } = fakeConnection()
  registerHarnessRoutes(ctx, { teams, bits, projects, ready: Promise.resolve(), botsRoot, catalog: harnessCatalog })

  const created = await call('/api/bots.teams.fromPack', { packId: 'demo', projectId })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.deepEqual(created.team.projectIds, [projectId])
  assert.equal(created.team.shared, false)

  const unknown = await call('/api/bots.teams.fromPack', { packId: 'demo', projectId: '2222222222' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'PROJECT_NOT_FOUND')
})

for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\nharness: ${failures.length} failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\nharness: ${passed} tests passed`)
}
