/**
 * Tests for teams (CONTRACT §10): `normalizeTeam`, `TeamStore` persistence and
 * the `/api/bots.teams*` routes + `loadTeamTemplates`.
 *
 * Plain `node test/teams.test.mjs`; Node built-ins only.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { TeamStore, normalizeTeam } from '../host/teams.js'
import { loadTeamTemplates, registerTeamRoutes } from '../host/team-routes.js'

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

const tempRoots = []
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bits-teams-'))
  tempRoots.push(dir)
  return dir
}

async function newStore(root) {
  const store = new TeamStore({ botsRoot: root ?? (await tempDir()) })
  await store.init()
  return store
}

function expectInvalid(fn, fieldPattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'TEAM_INVALID', `expected TEAM_INVALID, got ${error.code}: ${error.message}`)
    if (fieldPattern) assert.match(error.message, fieldPattern)
    return true
  })
}

async function expectRejects(promise, code, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    if (pattern) assert.match(error.message, pattern)
    return true
  })
}

const member = (id, extra = {}) => ({ id, name: id.toUpperCase(), ...extra })

function sampleTeam() {
  return {
    name: 'DSC',
    description: 'Time do design system',
    members: [
      member('builder', { character: 'bit-builder', role: 'Implementa', launches: ['scout'] }),
      member('scout', { access: 'read' }),
    ],
    flow: {
      nodes: [
        { id: 'n1', type: 'start', x: 0, y: 0 },
        { id: 'n2', type: 'step', x: 100, y: 0, label: 'Verde', memberId: 'builder' },
        { id: 'g1', type: 'group', x: 0, y: 0, w: 320, h: 400, label: 'Grupo', color: '#2563EB' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    },
  }
}

// ---------------------------------------------------------------------------
// normalizeTeam
// ---------------------------------------------------------------------------

await test('normalizeTeam applies defaults in create mode', () => {
  const team = normalizeTeam({ name: '  Time  ' })
  assert.deepEqual(team, {
    name: 'Time',
    description: '',
    emoji: '👥',
    color: '#2563eb',
    workspaceDir: null,
    members: [],
    flow: { nodes: [], edges: [] },
    lead: null,
    harness: null,
    bindWorkspace: false,
    rules: '',
    skills: [],
    entry: [],
  })
  const full = normalizeTeam(sampleTeam())
  assert.deepEqual(full.members[0], {
    id: 'builder', character: 'bit-builder', name: 'BUILDER', role: 'Implementa', model: '', provider: '', effort: '',
    access: 'write', instructions: '', launches: ['scout'], skills: [], teamRef: null, mcp: [],
  })
  assert.equal(full.members[1].access, 'read')
  assert.equal(full.members[1].character, null)
  assert.deepEqual(full.flow.nodes[0], { id: 'n1', type: 'start', x: 0, y: 0, label: '', detail: '' })
  assert.equal(full.flow.nodes[1].memberId, 'builder')
  assert.equal(full.flow.nodes[2].color, '#2563eb')
  assert.deepEqual(full.flow.edges[0], { id: 'e1', from: 'n1', to: 'n2', label: '', kind: 'flow' })
})

await test('normalizeTeam ignores id/createdAt/updatedAt and unknown fields', () => {
  const team = normalizeTeam({
    id: 'zz', createdAt: 'x', updatedAt: 'y', name: 'A', extra: 1,
    members: [{ ...member('a'), secret: true }],
    flow: { nodes: [{ id: 'n', type: 'note', x: 1, y: 2, junk: 'x' }], edges: [], viewport: { zoom: 2 } },
  })
  assert.equal('id' in team, false)
  assert.equal('createdAt' in team, false)
  assert.equal('extra' in team, false)
  assert.equal('secret' in team.members[0], false)
  assert.equal('junk' in team.flow.nodes[0], false)
  assert.equal('viewport' in team.flow, false)
})

await test('normalizeTeam validates team fields', () => {
  expectInvalid(() => normalizeTeam({}), /^name:/)
  expectInvalid(() => normalizeTeam({ name: '   ' }), /^name:/)
  expectInvalid(() => normalizeTeam({ name: 'x'.repeat(61) }), /^name:/)
  expectInvalid(() => normalizeTeam({ name: 'A', description: 'x'.repeat(2001) }), /^description:/)
  expectInvalid(() => normalizeTeam({ name: 'A', emoji: '123456789' }), /^emoji:/)
  assert.equal(normalizeTeam({ name: 'A', emoji: '' }).emoji, '')
  expectInvalid(() => normalizeTeam({ name: 'A', color: 'blue' }), /^color:/)
  expectInvalid(() => normalizeTeam({ name: 'A', workspaceDir: 'relative/dir' }), /^workspaceDir:/)
  expectInvalid(() => normalizeTeam({ name: 'A', workspaceDir: '/' + 'x'.repeat(1024) }), /^workspaceDir:/)
  assert.equal(normalizeTeam({ name: 'A', workspaceDir: '' }).workspaceDir, null)
  assert.equal(normalizeTeam({ name: 'A', workspaceDir: '/home/me/dsc' }).workspaceDir, '/home/me/dsc')
  expectInvalid(() => normalizeTeam(null), /^team:/)
})

await test('normalizeTeam validates members', () => {
  const base = (members) => ({ name: 'A', members })
  expectInvalid(() => normalizeTeam(base([member('a'), member('b'), member('a')])), /^members\[2\]\.id: duplicate id "a"/)
  expectInvalid(() => normalizeTeam(base([member('Bad Id')])), /^members\[0\]\.id:/)
  expectInvalid(() => normalizeTeam(base([{ id: 'a' }])), /^members\[0\]\.name:/)
  expectInvalid(() => normalizeTeam(base([member('a', { character: 'Bit X' })])), /^members\[0\]\.character:/)
  expectInvalid(() => normalizeTeam(base([member('a', { access: 'admin' })])), /^members\[0\]\.access:/)
  expectInvalid(() => normalizeTeam(base([member('a', { role: 'x'.repeat(201) })])), /^members\[0\]\.role:/)
  expectInvalid(() => normalizeTeam(base([member('a', { model: 'x'.repeat(61) })])), /^members\[0\]\.model:/)
  expectInvalid(() => normalizeTeam(base([member('a', { provider: 'x'.repeat(65) })])), /^members\[0\]\.provider:/)
  expectInvalid(() => normalizeTeam(base([member('a', { provider: 42 })])), /^members\[0\]\.provider:/)
  expectInvalid(() => normalizeTeam(base([member('a', { effort: 'x'.repeat(21) })])), /^members\[0\]\.effort:/)
  expectInvalid(() => normalizeTeam(base([member('a', { instructions: 'x'.repeat(40001) })])), /^members\[0\]\.instructions:/)
  expectInvalid(() => normalizeTeam(base([member('a', { launches: ['ghost'] })])), /^members\[0\]\.launches: unknown member id "ghost"/)
  const ok = normalizeTeam(base([member('a', { launches: ['b', 'a', 'b'], character: '' }), member('b')]))
  assert.deepEqual(ok.members[0].launches, ['b', 'a'])
  assert.equal(ok.members[0].character, null)
})

await test('normalizeTeam validates runtime fields (lead, harness, skills, entry, teamRef)', () => {
  const base = (extra) => ({ name: 'A', members: [member('lead'), member('b')], ...extra })
  const ok = normalizeTeam(base({
    lead: 'lead', harness: 'dsc', bindWorkspace: true, rules: 'Regra', skills: ['tdd', 'tdd', 'implement-card'],
    entry: [{ id: 'impl', label: 'Implementar', template: 'implemente o AB {n}' }],
    members: [member('lead', { skills: ['subagent-routing'] }), member('val', { teamRef: 'abcdef0123', mcp: ['playwright', 'playwright'] })],
    flow: { nodes: [{ id: 't', type: 'team', teamRef: '0123456789' }, { id: 's', type: 'start' }], edges: [{ id: 'e', from: 's', to: 't', kind: 'handoff' }] },
  }))
  assert.equal(ok.lead, 'lead')
  assert.equal(ok.harness, 'dsc')
  assert.equal(ok.bindWorkspace, true)
  assert.deepEqual(ok.skills, ['tdd', 'implement-card'])
  assert.deepEqual(ok.members[0].skills, ['subagent-routing'])
  assert.equal(ok.members[0].provider, '', 'provider defaults to automatic')
  const pinned = normalizeTeam({ name: 'A', members: [member('a', { provider: '  anthropic-2  ' })] })
  assert.equal(pinned.members[0].provider, 'anthropic-2', 'provider id is trimmed')
  assert.equal(ok.members[1].teamRef, 'abcdef0123')
  assert.deepEqual(ok.members[1].mcp, ['playwright'])
  expectInvalid(() => normalizeTeam(base({ members: [member('x', { mcp: ['bad name!'] })] })), /^members\[0\]\.mcp\[0\]:/)
  assert.equal(ok.flow.nodes[0].teamRef, '0123456789')
  assert.equal(ok.flow.edges[0].kind, 'handoff')
  expectInvalid(() => normalizeTeam(base({ lead: 'ghost' })), /^lead: unknown member "ghost"/)
  expectInvalid(() => normalizeTeam(base({ harness: 'Bad Pack' })), /^harness:/)
  expectInvalid(() => normalizeTeam(base({ skills: ['Bad Skill'] })), /^skills\[0\]:/)
  expectInvalid(() => normalizeTeam(base({ entry: [{ id: 'a', label: 'A', template: '  ' }] })), /^entry\[0\]\.template:/)
  expectInvalid(() => normalizeTeam(base({ members: [member('x', { teamRef: 'nope' })] })), /^members\[0\]\.teamRef:/)
  const partial = normalizeTeam({ lead: null, harness: '', bindWorkspace: true }, { partial: true })
  assert.deepEqual(partial, { lead: null, harness: null, bindWorkspace: true })
})

await test('normalizeTeam validates flow nodes', () => {
  const base = (nodes, edges = []) => ({ name: 'A', members: [member('builder')], flow: { nodes, edges } })
  expectInvalid(() => normalizeTeam(base([{ id: 'n1', type: 'rocket' }])), /^flow\.nodes\[0\]\.type:/)
  expectInvalid(() => normalizeTeam(base([{ id: 'bad id', type: 'step' }])), /^flow\.nodes\[0\]\.id:/)
  expectInvalid(() => normalizeTeam(base([{ id: 'n', type: 'step' }, { id: 'n', type: 'end' }])), /^flow\.nodes\[1\]\.id: duplicate/)
  expectInvalid(() => normalizeTeam(base([{ id: 'n', type: 'step', memberId: 'ghost' }])), /^flow\.nodes\[0\]\.memberId: unknown member "ghost"/)
  expectInvalid(() => normalizeTeam(base([{ id: 'n', type: 'step', x: 'a' }])), /^flow\.nodes\[0\]\.x:/)
  expectInvalid(() => normalizeTeam(base([{ id: 'n', type: 'step', y: Number.NaN }])), /^flow\.nodes\[0\]\.y:/)
  expectInvalid(() => normalizeTeam(base([{ id: 'n', type: 'group', w: 'wide' }])), /^flow\.nodes\[0\]\.w:/)
  expectInvalid(() => normalizeTeam(base([{ id: 'n', type: 'note', label: 'x'.repeat(201) }])), /^flow\.nodes\[0\]\.label:/)
  expectInvalid(() => normalizeTeam(base([{ id: 'n', type: 'note', detail: 'x'.repeat(4001) }])), /^flow\.nodes\[0\]\.detail:/)
  expectInvalid(() => normalizeTeam(base([{ id: 'n', type: 'note', color: 'red' }])), /^flow\.nodes\[0\]\.color:/)

  const { flow } = normalizeTeam(base([
    { id: 'a', type: 'decision', x: 1.6, y: -250000, memberId: 'builder', w: 100, h: 100 },
    { id: 'b', type: 'group', x: 250000, y: -0.4, w: 10, h: 99999.7 },
    { id: 'c', type: 'note', x: 3, y: 4, w: 55.5 },
    { id: 'd', type: 'step', memberId: 'builder' },
    { id: 'e', type: 'step', memberId: null },
  ]))
  assert.deepEqual(flow.nodes[0], { id: 'a', type: 'decision', x: 2, y: -100000, label: '', detail: '' })
  assert.equal(flow.nodes[1].x, 100000)
  assert.equal(flow.nodes[1].y, 0)
  assert.equal(flow.nodes[1].w, 40)
  assert.equal(flow.nodes[1].h, 4000)
  assert.equal(flow.nodes[2].w, 56)
  assert.equal('h' in flow.nodes[2], false)
  assert.equal('color' in flow.nodes[2], false)
  assert.equal(flow.nodes[3].memberId, 'builder')
  assert.equal(flow.nodes[3].x, 0)
  assert.equal(flow.nodes[4].memberId, null)
})

await test('normalizeTeam validates flow edges', () => {
  const nodes = [{ id: 'n1', type: 'start' }, { id: 'n2', type: 'end' }]
  const base = (edges) => ({ name: 'A', flow: { nodes, edges } })
  expectInvalid(() => normalizeTeam(base([{ id: 'e1', from: 'n1', to: 'n9' }])), /^flow\.edges\[0\]\.to: unknown node "n9"/)
  expectInvalid(() => normalizeTeam(base([{ id: 'e1', from: 'nx', to: 'n2' }])), /^flow\.edges\[0\]\.from: unknown node/)
  expectInvalid(() => normalizeTeam(base([{ id: 'e1', from: 'n1', to: 'n1' }])), /^flow\.edges\[0\]\.to:.*itself/)
  expectInvalid(() => normalizeTeam(base([{ id: 'e1', from: 'n1', to: 'n2', kind: 'teleport' }])), /^flow\.edges\[0\]\.kind:/)
  expectInvalid(() => normalizeTeam(base([{ id: 'e1', from: 'n1', to: 'n2' }, { id: 'e1', from: 'n2', to: 'n1' }])), /^flow\.edges\[1\]\.id: duplicate/)
  expectInvalid(() => normalizeTeam(base([{ id: 'e1', from: 'n1', to: 'n2', label: 'x'.repeat(121) }])), /^flow\.edges\[0\]\.label:/)
  expectInvalid(() => normalizeTeam({ name: 'A', flow: [] }), /^flow:/)
  const ok = normalizeTeam(base([{ id: 'e1', from: 'n1', to: 'n2', kind: 'loop', label: 'volta' }]))
  assert.deepEqual(ok.flow.edges[0], { id: 'e1', from: 'n1', to: 'n2', label: 'volta', kind: 'loop' })
})

await test('normalizeTeam enforces array limits', () => {
  const members = Array.from({ length: 65 }, (_, i) => member(`m${i}`))
  expectInvalid(() => normalizeTeam({ name: 'A', members }), /^members:.*64/)
  const launches = Array.from({ length: 65 }, () => 'a')
  expectInvalid(() => normalizeTeam({ name: 'A', members: [member('a', { launches })] }), /^members\[0\]\.launches:.*64/)
  const nodes = Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, type: 'note' }))
  expectInvalid(() => normalizeTeam({ name: 'A', flow: { nodes } }), /^flow\.nodes:.*500/)
  const edges = Array.from({ length: 1001 }, (_, i) => ({ id: `e${i}`, from: 'a', to: 'b' }))
  expectInvalid(() => normalizeTeam({ name: 'A', flow: { nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'end' }], edges } }), /^flow\.edges:.*1000/)
  assert.equal(normalizeTeam({ name: 'A', members: members.slice(0, 64) }).members.length, 64)
})

await test('normalizeTeam partial mode returns only present fields', () => {
  assert.deepEqual(normalizeTeam({ description: 'x', id: 'ignored' }, { partial: true }), { description: 'x' })
  assert.deepEqual(normalizeTeam({ workspaceDir: '' }, { partial: true }), { workspaceDir: null })
  expectInvalid(() => normalizeTeam({ name: '' }, { partial: true }), /^name:/)
  // flow without members: memberId existence deferred to the merged check
  const out = normalizeTeam({ flow: { nodes: [{ id: 'n', type: 'step', memberId: 'ghost' }] } }, { partial: true })
  assert.equal(out.flow.nodes[0].memberId, 'ghost')
  expectInvalid(() => normalizeTeam({ members: [], flow: { nodes: [{ id: 'n', type: 'step', memberId: 'ghost' }] } }, { partial: true }), /memberId/)
})

// ---------------------------------------------------------------------------
// TeamStore
// ---------------------------------------------------------------------------

await test('create applies defaults, generates id and timestamps, persists', async () => {
  const store = await newStore()
  const team = await store.create({ name: 'Time' })
  assert.match(team.id, /^[0-9a-f]{10}$/)
  assert.equal(team.emoji, '👥')
  assert.equal(team.color, '#2563eb')
  assert.equal(team.workspaceDir, null)
  assert.deepEqual(team.members, [])
  assert.deepEqual(team.flow, { nodes: [], edges: [] })
  assert.equal(team.createdAt, team.updatedAt)
  assert.ok(!Number.isNaN(Date.parse(team.createdAt)))
  assert.equal(store.file, path.join(store.botsRoot, 'teams.json'))
  const doc = JSON.parse(await fs.readFile(store.file, 'utf8'))
  assert.equal(doc.statusVersion, 1)
  assert.equal(doc.teams[0].id, team.id)
  const stat = await fs.stat(store.file)
  assert.equal(stat.mode & 0o777, 0o600)
  await expectRejects(store.create({ name: '' }), 'TEAM_INVALID', /^name:/)
  assert.equal(store.list().length, 1)
})

await test('list/get return deep copies', async () => {
  const store = await newStore()
  const team = await store.create(sampleTeam())
  const copy = store.get(team.id)
  copy.members[0].name = 'mutated'
  copy.flow.nodes.length = 0
  store.list()[0].name = 'mutated'
  assert.equal(store.get(team.id).members[0].name, 'BUILDER')
  assert.equal(store.get(team.id).flow.nodes.length, 3)
  assert.equal(store.get(team.id).name, 'DSC')
  assert.equal(store.get('nope'), undefined)
})

await test('update replaces members/flow and checks the merged record', async () => {
  const store = await newStore()
  const team = await store.create(sampleTeam())
  await new Promise((resolve) => setTimeout(resolve, 5))
  const updated = await store.update(team.id, { name: 'DSC 2', id: 'ffffffffff', createdAt: '2000-01-01T00:00:00.000Z', bogus: 1 })
  assert.equal(updated.id, team.id)
  assert.equal(updated.name, 'DSC 2')
  assert.equal(updated.createdAt, team.createdAt)
  assert.notEqual(updated.updatedAt, team.updatedAt)
  assert.equal(updated.members.length, 2)
  assert.equal('bogus' in updated, false)

  // removing "builder" while step n2 still references it -> TEAM_INVALID
  await expectRejects(store.update(team.id, { members: [member('scout')] }), 'TEAM_INVALID', /memberId: unknown member "builder"/)
  // removing "scout" while builder launches it -> TEAM_INVALID
  await expectRejects(
    store.update(team.id, { members: [member('builder', { launches: ['scout'] })] }),
    'TEAM_INVALID',
    /launches: unknown member id "scout"/,
  )
  // flow-only patch referencing an unknown member is rejected on merge
  await expectRejects(
    store.update(team.id, { flow: { nodes: [{ id: 'x', type: 'step', memberId: 'ghost' }] } }),
    'TEAM_INVALID',
    /memberId: unknown member "ghost"/,
  )
  assert.equal(store.get(team.id).members.length, 2, 'failed updates leave the record untouched')

  const replaced = await store.update(team.id, {
    members: [member('solo')],
    flow: { nodes: [{ id: 's', type: 'step', memberId: 'solo' }] },
  })
  assert.deepEqual(replaced.members.map((m) => m.id), ['solo'])
  assert.deepEqual(replaced.flow.edges, [])
  const cleared = await store.update(team.id, { workspaceDir: '/tmp/x' })
  assert.equal(cleared.workspaceDir, '/tmp/x')
  assert.equal((await store.update(team.id, { workspaceDir: null })).workspaceDir, null)

  await expectRejects(store.update('0000000000', { name: 'x' }), 'TEAM_NOT_FOUND')
  await expectRejects(store.update(team.id, null), 'TEAM_INVALID')
})

await test('remove deletes and returns the record', async () => {
  const store = await newStore()
  const a = await store.create({ name: 'A' })
  const b = await store.create({ name: 'B' })
  const removed = await store.remove(a.id)
  assert.equal(removed.id, a.id)
  assert.deepEqual(store.list().map((t) => t.id), [b.id])
  await expectRejects(store.remove(a.id), 'TEAM_NOT_FOUND')
  const doc = JSON.parse(await fs.readFile(store.file, 'utf8'))
  assert.deepEqual(doc.teams.map((t) => t.id), [b.id])
})

await test('records persist across TeamStore instances in creation order', async () => {
  const root = await tempDir()
  const store = await newStore(root)
  const a = await store.create(sampleTeam())
  const b = await store.create({ name: 'B' })
  const reloaded = await newStore(root)
  assert.deepEqual(reloaded.list(), store.list())
  assert.deepEqual(reloaded.list().map((t) => t.id), [a.id, b.id])
})

await test('missing file starts empty; corrupt file is quarantined', async () => {
  const root = await tempDir()
  const empty = await newStore(root)
  assert.deepEqual(empty.list(), [])
  await fs.writeFile(path.join(root, 'teams.json'), '{ not json')
  const store = await newStore(root)
  assert.deepEqual(store.list(), [])
  const files = await fs.readdir(root)
  assert.ok(files.some((name) => /^teams\.json\.corrupt-\d+$/.test(name)), files.join(','))
  assert.ok(!files.includes('teams.json'))
  await store.create({ name: 'fresh' })
  // wrong shape is also quarantined
  await fs.writeFile(path.join(root, 'teams.json'), JSON.stringify({ teams: 'nope' }))
  const again = await newStore(root)
  assert.deepEqual(again.list(), [])
})

await test('invalid persisted entries are dropped on load', async () => {
  const root = await tempDir()
  await fs.writeFile(path.join(root, 'teams.json'), JSON.stringify({
    statusVersion: 1,
    teams: [
      { id: 'aaaaaaaaaa', name: 'Good', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'bbbbbbbbbb', name: '' },
      'garbage',
      { id: 'aaaaaaaaaa', name: 'Dup id' },
    ],
  }))
  const store = await newStore(root)
  const list = store.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'aaaaaaaaaa')
  assert.equal(list[0].createdAt, '2026-01-01T00:00:00.000Z')
  assert.match(list[1].id, /^[0-9a-f]{10}$/)
  assert.notEqual(list[1].id, 'aaaaaaaaaa')
})

await test('concurrent updates do not lose writes', async () => {
  const root = await tempDir()
  const store = await newStore(root)
  const team = await store.create({ name: 'A' })
  const others = await Promise.all(Array.from({ length: 5 }, (_, i) => store.create({ name: `T${i}` })))
  await Promise.all([
    store.update(team.id, { description: 'desc' }),
    store.update(team.id, { emoji: '🚀' }),
    store.update(team.id, { color: '#ff0000' }),
    store.update(team.id, { members: [member('a')] }),
    ...others.map((t, i) => store.update(t.id, { description: `d${i}` })),
  ])
  const reloaded = await newStore(root)
  const got = reloaded.get(team.id)
  assert.equal(got.description, 'desc')
  assert.equal(got.emoji, '🚀')
  assert.equal(got.color, '#ff0000')
  assert.equal(got.members.length, 1)
  others.forEach((t, i) => assert.equal(reloaded.get(t.id).description, `d${i}`))
  const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

await test('store enforces the 200 team limit', async () => {
  const root = await tempDir()
  const teams = Array.from({ length: 200 }, (_, i) => ({ id: i.toString(16).padStart(10, '0'), name: `T${i}` }))
  await fs.writeFile(path.join(root, 'teams.json'), JSON.stringify({ statusVersion: 1, teams }))
  const store = await newStore(root)
  assert.equal(store.list().length, 200)
  await expectRejects(store.create({ name: 'one too many' }), 'TEAM_LIMIT')
  await store.remove(store.list()[0].id)
  await store.create({ name: 'fits again' })
})

// ---------------------------------------------------------------------------
// Routes + templates
// ---------------------------------------------------------------------------

async function setupRoutes({ templates, llm, catalog = { has: (id) => id === 'bit-builder' } } = {}) {
  const teams = await newStore()
  const routes = new Map()
  const ctx = { connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } } }
  const logs = []
  const dispose = registerTeamRoutes(ctx, { teams, ready: Promise.resolve(), catalog, templates, llm, log: (m) => logs.push(m) })
  async function call(routePath, body, raw) {
    const request = new Request(`http://x${routePath}`, {
      method: body === undefined && raw === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    })
    const response = await routes.get(routePath).fetch(request)
    assert.equal(response.status, 200)
    return response.json()
  }
  return { teams, routes, call, logs, dispose }
}

await test('routes register exact paths and the disposer removes them', async () => {
  const app = await setupRoutes()
  assert.deepEqual([...app.routes.keys()].sort(), [
    '/api/bots.teams', '/api/bots.teams.create', '/api/bots.teams.delete', '/api/bots.teams.providers', '/api/bots.teams.templates', '/api/bots.teams.update',
  ])
  for (const route of app.routes.values()) assert.equal(route.requestBody, 'buffered')
  assert.deepEqual(app.routes.get('/api/bots.teams').methods, ['GET'])
  assert.deepEqual(app.routes.get('/api/bots.teams.create').methods, ['POST'])
  app.dispose()
  assert.equal(app.routes.size, 0)
})

await test('routes CRUD flow', async () => {
  const app = await setupRoutes()
  assert.deepEqual(await app.call('/api/bots.teams'), { ok: true, teams: [] })
  const created = await app.call('/api/bots.teams.create', {
    team: { ...sampleTeam(), id: 'ffffffffff', createdAt: '2000-01-01T00:00:00.000Z', updatedAt: 'x' },
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.notEqual(created.team.id, 'ffffffffff')
  assert.notEqual(created.team.createdAt, '2000-01-01T00:00:00.000Z')
  const id = created.team.id

  const listed = await app.call('/api/bots.teams')
  assert.equal(listed.teams.length, 1)

  const updated = await app.call('/api/bots.teams.update', { id, patch: { name: 'Novo', id: 'ffffffffff', createdAt: 'x', updatedAt: 'y' } })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.equal(updated.team.name, 'Novo')
  assert.equal(updated.team.id, id)

  const invalid = await app.call('/api/bots.teams.update', { id, patch: { members: [member('scout')] } })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'TEAM_INVALID')

  const deleted = await app.call('/api/bots.teams.delete', { id })
  assert.deepEqual(deleted, { ok: true, deleted: true, id })
  assert.equal((await app.call('/api/bots.teams.delete', { id })).error.code, 'TEAM_NOT_FOUND')
  assert.equal((await app.call('/api/bots.teams.update', { id, patch: { name: 'x' } })).error.code, 'TEAM_NOT_FOUND')
})

await test('routes reject malformed bodies with BAD_REQUEST', async () => {
  const app = await setupRoutes()
  for (const routePath of ['/api/bots.teams.create', '/api/bots.teams.update', '/api/bots.teams.delete']) {
    const payload = await app.call(routePath, undefined, '{ broken')
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'BAD_REQUEST', routePath)
  }
  assert.equal((await app.call('/api/bots.teams.create', {})).error.code, 'BAD_REQUEST')
  assert.equal((await app.call('/api/bots.teams.create', [1])).error.code, 'BAD_REQUEST')
  assert.equal((await app.call('/api/bots.teams.update', { id: 'abc' })).error.code, 'BAD_REQUEST')
  assert.equal((await app.call('/api/bots.teams.update', { patch: {} })).error.code, 'BAD_REQUEST')
  assert.equal((await app.call('/api/bots.teams.delete', {})).error.code, 'BAD_REQUEST')
  const invalid = await app.call('/api/bots.teams.create', { team: { name: '' } })
  assert.equal(invalid.error.code, 'TEAM_INVALID')
  assert.match(invalid.error.message, /^name:/)
})

await test('routes reject characters missing from the catalog', async () => {
  const app = await setupRoutes()
  const bad = await app.call('/api/bots.teams.create', { team: { name: 'A', members: [member('a', { character: 'bit-ghost' })] } })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'TEAM_INVALID')
  assert.match(bad.error.message, /members\[0\]\.character: unknown bit character "bit-ghost"/)
  const good = await app.call('/api/bots.teams.create', { team: { name: 'A', members: [member('a', { character: 'bit-builder' }), member('b', { character: null })] } })
  assert.equal(good.ok, true, JSON.stringify(good))
  const badPatch = await app.call('/api/bots.teams.update', { id: good.team.id, patch: { members: [member('a', { character: 'bit-ghost' })] } })
  assert.equal(badPatch.error.code, 'TEAM_INVALID')

  const noCatalog = await setupRoutes({ catalog: null })
  const anyChar = await noCatalog.call('/api/bots.teams.create', { team: { name: 'A', members: [member('a', { character: 'bit-ghost' })] } })
  assert.equal(anyChar.ok, true)
})

await test('unexpected errors become INTERNAL and are logged', async () => {
  const routes = new Map()
  const ctx = { connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } } }
  const logs = []
  const teams = { list() { throw new Error('boom') } }
  registerTeamRoutes(ctx, { teams, ready: Promise.resolve(), log: (m) => logs.push(m) })
  const payload = await (await routes.get('/api/bots.teams').fetch(new Request('http://x/api/bots.teams'))).json()
  assert.deepEqual(payload, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } })
  assert.ok(logs.some((m) => m.includes('boom')))
})

await test('handlers wait for deps.ready', async () => {
  const teams = await newStore()
  const routes = new Map()
  const ctx = { connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } } }
  let release
  const ready = new Promise((resolve) => { release = resolve })
  registerTeamRoutes(ctx, { teams, ready })
  let settled = false
  const pending = routes.get('/api/bots.teams').fetch(new Request('http://x/api/bots.teams')).then((r) => { settled = true; return r.json() })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false)
  release()
  assert.deepEqual(await pending, { ok: true, teams: [] })
})

await test('loadTeamTemplates loads valid files and skips invalid ones', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'dsc.json'), JSON.stringify({
    id: 'dsc', name: 'Design System', description: 'Modelo', emoji: '🎨',
    team: { ...sampleTeam(), extra: true },
  }))
  await fs.writeFile(path.join(dir, 'broken.json'), JSON.stringify({
    id: 'broken', name: 'Broken', team: { name: 'B', members: [member('a', { launches: ['ghost'] })] },
  }))
  await fs.writeFile(path.join(dir, 'garbage.json'), '{ nope')
  await fs.writeFile(path.join(dir, 'readme.txt'), 'ignored')
  const logs = []
  const templates = loadTeamTemplates(dir, (m) => logs.push(m))
  assert.ok(Array.isArray(templates))
  assert.equal(templates.length, 1)
  assert.equal(templates[0].id, 'dsc')
  assert.equal(templates[0].emoji, '🎨')
  assert.equal(templates[0].team.name, 'DSC')
  assert.equal('extra' in templates[0].team, false)
  assert.equal(logs.length, 2, logs.join('\n'))
  assert.ok(logs.some((m) => m.includes('broken.json') && m.includes('ghost')))
  assert.ok(logs.some((m) => m.includes('garbage.json')))

  assert.deepEqual(loadTeamTemplates(path.join(dir, 'missing')), [])

  const app = await setupRoutes({ templates })
  const payload = await app.call('/api/bots.teams.templates')
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.templates, templates)
  payload.templates[0].name = 'mutated'
  assert.equal((await app.call('/api/bots.teams.templates')).templates[0].name, 'Design System')
  const none = await setupRoutes()
  assert.deepEqual(await none.call('/api/bots.teams.templates'), { ok: true, templates: [] })
})

await test('routes expose the profile providers (accounts) for the model picker', async () => {
  const empty = await setupRoutes()
  assert.deepEqual(await empty.call('/api/bots.teams.providers'), { ok: true, providers: [] })

  const app = await setupRoutes({
    llm: {
      listProviders: () => [{ id: 'anthropic', name: 'Anthropic' }, { id: 'anthropic-2', name: 'Anthropic (conta 2)' }, { id: 'broken' }],
      async listModels(provider) {
        if (provider === 'broken') throw new Error('no adapter')
        return provider === 'anthropic-2'
          ? [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }, { id: 'claude-sonnet-5-5' }, { id: '' }]
          : [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }]
      },
    },
  })
  const payload = await app.call('/api/bots.teams.providers')
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.providers, [
    { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }] },
    { id: 'anthropic-2', name: 'Anthropic (conta 2)', models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }, { id: 'claude-sonnet-5-5', name: 'claude-sonnet-5-5' }] },
    { id: 'broken', name: 'broken', models: [] },
  ])
})

for (const dir of tempRoots) await fs.rm(dir, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.log(`teams: ${failures.length} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`teams: ${passed} tests passed`)
