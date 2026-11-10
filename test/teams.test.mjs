/**
 * Tests for teams v5 (V5-CONTRACT §3.2, §5.1, §5.2, §5.4): `normalizeTeam`
 * with bit-id members, `TeamStore` persistence + the v4→v5 migration, the
 * `/api/bots.teams*` routes, `loadTeamTemplates` and the new
 * `/api/bots.teams.fromTemplate` instantiation.
 *
 * The bit store is a local fake implementing the contract API used by the team
 * store (`list/get/create/update/remove`); no dependency on `host/store.js`.
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

const clone = (value) => JSON.parse(JSON.stringify(value))

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

// ---------------------------------------------------------------------------
// Fake BitStore (contract API used by TeamStore: list/get/create/update/remove)
// ---------------------------------------------------------------------------

const BUILDER = 'aaaaaaaaaa'
const SCOUT = 'bbbbbbbbbb'
const LEAD = 'cccccccccc'
const RUNNER = 'dddddddddd'
const ORPHAN = 'eeeeeeeeee'

function fakeBitRecord(bit, fallbackId) {
  return {
    id: bit.id ?? fallbackId,
    name: bit.name ?? 'Bit',
    character: bit.character ?? null,
    emoji: bit.emoji ?? '🤖',
    color: String(bit.color ?? '#475569').toLowerCase(),
    instructions: bit.instructions ?? '',
    isOrchestrator: bit.isOrchestrator === true,
    model: bit.model ?? 'subscription/sonnet',
    effort: bit.effort ?? 'high',
    workspaceDir: null,
    createdAt: bit.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: bit.updatedAt ?? '2026-01-01T00:00:00.000Z',
  }
}

/**
 * Minimal in-memory `BitStore` with the semantics TeamStore relies on: ids are
 * 10 hex chars, `create` applies worker defaults unless fields are given (the
 * real store adds catalog defaults; tests pass explicit lead overrides).
 */
function fakeBitStore({ initial = [] } = {}) {
  const records = []
  let counter = 0
  for (const [index, bit] of initial.entries()) records.push(fakeBitRecord(bit, (index + 1).toString(16).padStart(10, '0')))
  const find = (id) => records.find((record) => record.id === id)
  const removals = []
  return {
    records,
    removals,
    list() {
      return clone(records)
    },
    get(id) {
      const record = find(id)
      return record === undefined ? undefined : clone(record)
    },
    async create(input) {
      counter += 1
      const record = fakeBitRecord(
        {
          ...input,
          model: typeof input?.model === 'string' && input.model !== '' ? input.model : 'subscription/sonnet',
          effort: typeof input?.effort === 'string' && input.effort !== '' ? input.effort : 'high',
        },
        counter.toString(16).padStart(10, '0'),
      )
      records.push(record)
      return clone(record)
    },
    async update(id, patch) {
      const record = find(id)
      if (record === undefined) throw Object.assign(new Error(`bit "${id}" not found`), { code: 'BOT_NOT_FOUND' })
      for (const [key, value] of Object.entries(patch)) record[key] = value
      record.updatedAt = new Date().toISOString()
      return clone(record)
    },
    async remove(id, options) {
      removals.push({ id, options })
      const index = records.findIndex((record) => record.id === id)
      if (index < 0) return undefined
      return clone(records.splice(index, 1)[0])
    },
  }
}

/** The bits every team test can reference. */
function seedBits() {
  return [
    { id: BUILDER, name: 'Builder', character: 'bit-builder' },
    { id: SCOUT, name: 'Scout', character: 'bit-scout' },
    { id: LEAD, name: 'Coordinator', character: 'bit-coordinator', isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'max' },
    { id: RUNNER, name: 'Runner', character: 'bit-runner' },
  ]
}

function bitLookup(store) {
  return { get: (id) => store.get(id) }
}

async function newStore({ root, bits, catalog = null, log } = {}) {
  const dir = root ?? (await tempDir())
  const store = new TeamStore({ botsRoot: dir, bits: bits ?? fakeBitStore({ initial: seedBits() }), catalog, log })
  await store.init()
  return store
}

/** Team store + fake bit store sharing one root. */
async function newFixture({ root, initialBits = seedBits(), catalog = null } = {}) {
  const dir = root ?? (await tempDir())
  const bits = fakeBitStore({ initial: initialBits })
  const logs = []
  const teams = new TeamStore({ botsRoot: dir, bits, catalog, log: (message) => logs.push(message) })
  await teams.init()
  return { dir, bits, teams, logs }
}

const member = (id, bitId = BUILDER, extra = {}) => ({ id, bitId, ...extra })

function sampleTeam(ids = {}) {
  return {
    name: 'DSC',
    description: 'Time do design system',
    members: [
      member('builder', ids.builder ?? BUILDER, { role: 'Implementa', launches: ['scout'] }),
      member('scout', ids.scout ?? SCOUT, { access: 'read' }),
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
    shared: false,
    projectIds: [],
  })
  const bits = fakeBitStore({ initial: seedBits() })
  const full = normalizeTeam(sampleTeam(), { bits: bitLookup(bits) })
  // v5 member: only the bit reference plus per-team fields; legacy embedded
  // fields do not exist any more (V5-CONTRACT §5.1).
  assert.deepEqual(full.members[0], {
    id: 'builder',
    bitId: BUILDER,
    role: 'Implementa',
    access: 'write',
    launches: ['scout'],
    skills: [],
    teamRef: null,
    mcp: [],
  })
  assert.equal(full.members[1].access, 'read')
  assert.equal(full.members[1].bitId, SCOUT)
  assert.deepEqual(full.flow.nodes[0], { id: 'n1', type: 'start', x: 0, y: 0, label: '', detail: '' })
  assert.equal(full.flow.nodes[1].memberId, 'builder')
  assert.equal(full.flow.nodes[2].color, '#2563eb')
  assert.deepEqual(full.flow.edges[0], { id: 'e1', from: 'n1', to: 'n2', label: '', kind: 'flow' })
})

await test('normalizeTeam ignores id/createdAt/updatedAt and legacy member fields', () => {
  const bits = fakeBitStore({ initial: seedBits() })
  const team = normalizeTeam(
    {
      id: 'zz',
      createdAt: 'x',
      updatedAt: 'y',
      name: 'A',
      extra: 1,
      members: [
        member('a', BUILDER, {
          character: 'bit-builder',
          name: 'Embedded',
          model: 'DeepSeek-V4.1-Flash',
          provider: 'anthropic-2',
          effort: 'max',
          instructions: 'Legacy text',
          secret: true,
        }),
      ],
      flow: { nodes: [{ id: 'n', type: 'note', x: 1, y: 2, junk: 'x' }], edges: [], viewport: { zoom: 2 } },
    },
    { bits: bitLookup(bits) },
  )
  assert.equal('id' in team, false)
  assert.equal('createdAt' in team, false)
  assert.equal('extra' in team, false)
  for (const key of ['character', 'name', 'model', 'provider', 'effort', 'instructions', 'secret']) {
    assert.equal(key in team.members[0], false, `${key} must be dropped from v5 members`)
  }
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

await test('normalizeTeam validates members (bitId required, must resolve)', () => {
  const bits = fakeBitStore({ initial: seedBits() })
  const options = { bits: bitLookup(bits) }
  const base = (members) => ({ name: 'A', members })
  // Missing/invalid bitId is rejected in v5...
  expectInvalid(() => normalizeTeam(base([{ id: 'a' }]), options), /^members\[0\]\.bitId: is required/)
  expectInvalid(() => normalizeTeam(base([{ id: 'a', bitId: '' }]), options), /^members\[0\]\.bitId: is required/)
  expectInvalid(() => normalizeTeam(base([{ id: 'a', bitId: 'not-a-bit' }]), options), /^members\[0\]\.bitId: must be a bit id/)
  expectInvalid(() => normalizeTeam(base([{ id: 'a', bitId: 'ABC1234567' }]), options), /^members\[0\]\.bitId: must be a bit id/)
  // ...and must reference an existing bit when the store is available.
  expectInvalid(() => normalizeTeam(base([{ id: 'a', bitId: '0123456789' }]), options), /^members\[0\]\.bitId: unknown bit "0123456789"/)
  // Structural rules are unchanged.
  expectInvalid(() => normalizeTeam(base([member('a'), member('b'), member('a')]), options), /^members\[2\]\.id: duplicate id "a"/)
  expectInvalid(() => normalizeTeam(base([member('Bad Id')]), options), /^members\[0\]\.id:/)
  expectInvalid(() => normalizeTeam(base([member('a', BUILDER, { access: 'admin' })]), options), /^members\[0\]\.access:/)
  expectInvalid(() => normalizeTeam(base([member('a', BUILDER, { role: 'x'.repeat(201) })]), options), /^members\[0\]\.role:/)
  expectInvalid(() => normalizeTeam(base([member('a', BUILDER, { launches: ['ghost'] })]), options), /^members\[0\]\.launches: unknown member id "ghost"/)
  // Without a bit store only the syntax is checked (pure validation).
  assert.equal(normalizeTeam(base([member('a', '0123456789')])).members[0].bitId, '0123456789')
  // Two members may reference the same bit (same bit, two team roles).
  const shared = normalizeTeam(base([member('a', BUILDER), member('b', BUILDER)]), options)
  assert.deepEqual(shared.members.map((item) => item.bitId), [BUILDER, BUILDER])
  const deduped = normalizeTeam(base([member('a', BUILDER, { launches: ['b', 'a', 'b'] }), member('b')]), options)
  assert.deepEqual(deduped.members[0].launches, ['b', 'a'])
})

await test('normalizeTeam enforces the lead-orchestrator rule (TEAM_LEAD_NOT_ORCHESTRATOR)', () => {
  const bits = fakeBitStore({ initial: seedBits() })
  const options = { bits: bitLookup(bits) }
  // A lead that is not a member is still TEAM_INVALID.
  expectInvalid(
    () => normalizeTeam({ name: 'A', members: [member('a', BUILDER)], lead: 'ghost' }, options),
    /^lead: unknown member "ghost"/,
  )
  // A worker bit cannot lead a team.
  assert.throws(
    () => normalizeTeam({ name: 'A', members: [member('a', BUILDER)], lead: 'a' }, options),
    (error) => {
      assert.equal(error.code, 'TEAM_LEAD_NOT_ORCHESTRATOR')
      assert.match(error.message, /lead: bit "aaaaaaaaaa" of member "a" is not an orchestrator/)
      return true
    },
  )
  // An orchestrator bit can lead; a team without a lead is valid.
  assert.equal(normalizeTeam({ name: 'A', members: [member('lead', LEAD)], lead: 'lead' }, options).lead, 'lead')
  assert.equal(normalizeTeam({ name: 'A', members: [member('lead', LEAD)] }, options).lead, null)
  // Without a bit store the rule cannot apply.
  assert.equal(normalizeTeam({ name: 'A', members: [member('a', BUILDER)], lead: 'a' }).lead, 'a')
})

await test('normalizeTeam validates runtime fields (lead, harness, skills, entry, teamRef)', () => {
  const bits = fakeBitStore({ initial: seedBits() })
  const base = (extra) => ({ name: 'A', members: [member('lead', LEAD), member('b', RUNNER)], ...extra })
  const ok = normalizeTeam(
    base({
      lead: 'lead',
      harness: 'dsc',
      bindWorkspace: true,
      rules: 'Regra',
      skills: ['tdd', 'tdd', 'implement-card'],
      entry: [{ id: 'impl', label: 'Implementar', template: 'implemente o AB {n}' }],
      members: [member('lead', LEAD, { skills: ['subagent-routing'] }), member('val', RUNNER, { teamRef: 'abcdef0123', mcp: ['playwright', 'playwright'] })],
      flow: {
        nodes: [{ id: 't', type: 'team', teamRef: '0123456789' }, { id: 's', type: 'start' }],
        edges: [{ id: 'e', from: 's', to: 't', kind: 'handoff' }],
      },
    }),
    { bits: bitLookup(bits) },
  )
  assert.equal(ok.lead, 'lead')
  assert.equal(ok.harness, 'dsc')
  assert.equal(ok.bindWorkspace, true)
  assert.deepEqual(ok.skills, ['tdd', 'implement-card'])
  assert.deepEqual(ok.members[0].skills, ['subagent-routing'])
  assert.equal(ok.members[1].teamRef, 'abcdef0123')
  assert.deepEqual(ok.members[1].mcp, ['playwright'])
  assert.equal('provider' in ok.members[0], false, 'provider pinning is gone')
  expectInvalid(() => normalizeTeam(base({ members: [member('x', RUNNER, { mcp: ['bad name!'] })] }), { bits: bitLookup(bits) }), /^members\[0\]\.mcp\[0\]:/)
  assert.equal(ok.flow.nodes[0].teamRef, '0123456789')
  assert.equal(ok.flow.edges[0].kind, 'handoff')
  expectInvalid(() => normalizeTeam(base({ lead: 'ghost' }), { bits: bitLookup(bits) }), /^lead: unknown member "ghost"/)
  expectInvalid(() => normalizeTeam(base({ harness: 'Bad Pack' })), /^harness:/)
  expectInvalid(() => normalizeTeam(base({ skills: ['Bad Skill'] })), /^skills\[0\]:/)
  expectInvalid(() => normalizeTeam(base({ entry: [{ id: 'a', label: 'A', template: '  ' }] })), /^entry\[0\]\.template:/)
  expectInvalid(() => normalizeTeam(base({ members: [member('x', RUNNER, { teamRef: 'nope' })] })), /^members\[0\]\.teamRef:/)
  const partial = normalizeTeam({ lead: null, harness: '', bindWorkspace: true }, { partial: true })
  assert.deepEqual(partial, { lead: null, harness: null, bindWorkspace: true })
})

await test('normalizeTeam validates shared and projectIds (CONTRACT §12.1)', () => {
  const p1 = '1111111111'
  const p2 = '2222222222'
  const defaults = normalizeTeam({ name: 'A' })
  assert.equal(defaults.shared, false)
  assert.deepEqual(defaults.projectIds, [])
  // shared is only true for an actual boolean true.
  assert.equal(normalizeTeam({ name: 'A', shared: 'true' }).shared, false)
  assert.equal(normalizeTeam({ name: 'A', shared: true }).shared, true)
  // ≤ 20 entries, each 10 lowercase hex, deduplicated keeping the order.
  const deduped = normalizeTeam({ name: 'A', shared: true, projectIds: [p2, p1, p2] })
  assert.equal(deduped.shared, true)
  assert.deepEqual(deduped.projectIds, [p2, p1])
  assert.equal(normalizeTeam({ name: 'A', shared: true, projectIds: [] }).shared, true)
  expectInvalid(() => normalizeTeam({ name: 'A', projectIds: ['zzzzzzzzzz'] }), /^projectIds\[0\]: must be a project id/)
  expectInvalid(() => normalizeTeam({ name: 'A', projectIds: [42] }), /^projectIds\[0\]:/)
  expectInvalid(() => normalizeTeam({ name: 'A', projectIds: 'nope' }), /^projectIds: must be an array/)
  const many = Array.from({ length: 21 }, (_, i) => i.toString(16).padStart(10, '0'))
  expectInvalid(() => normalizeTeam({ name: 'A', shared: true, projectIds: many }), /^projectIds: must contain at most 20 entries/)
  assert.equal(normalizeTeam({ name: 'A', shared: true, projectIds: many.slice(0, 20) }).projectIds.length, 20)
  // A non-shared team can belong to at most one project (checked on the full record).
  expectInvalid(
    () => normalizeTeam({ name: 'A', projectIds: [p1, p2] }),
    /^projectIds: a non-shared team can belong to only one project/,
  )
  assert.deepEqual(normalizeTeam({ name: 'A', projectIds: [p1] }).projectIds, [p1])
  assert.deepEqual(normalizeTeam({ name: 'A', shared: true, projectIds: [p1, p2] }).projectIds, [p1, p2])
  // Partial mode normalizes the present fields only; the cross-field check runs on merge.
  assert.deepEqual(normalizeTeam({ shared: true, projectIds: [p1, p1] }, { partial: true }), { shared: true, projectIds: [p1] })
  assert.deepEqual(normalizeTeam({ projectIds: [p2] }, { partial: true }), { projectIds: [p2] })
  expectInvalid(() => normalizeTeam({ projectIds: ['bad'] }, { partial: true }), /^projectIds\[0\]:/)
})

await test('normalizeTeam validates flow nodes', () => {
  const bits = fakeBitStore({ initial: seedBits() })
  const base = (nodes, edges = []) => ({ name: 'A', members: [member('builder', BUILDER)], flow: { nodes, edges } })
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

  const { flow } = normalizeTeam(
    base([
      { id: 'a', type: 'decision', x: 1.6, y: -250000, memberId: 'builder', w: 100, h: 100 },
      { id: 'b', type: 'group', x: 250000, y: -0.4, w: 10, h: 99999.7 },
      { id: 'c', type: 'note', x: 3, y: 4, w: 55.5 },
      { id: 'd', type: 'step', memberId: 'builder' },
      { id: 'e', type: 'step', memberId: null },
    ]),
  )
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
  assert.equal(bits.records.length, 4)
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
  const bits = fakeBitStore({ initial: seedBits() })
  const members = Array.from({ length: 65 }, (_, i) => member(`m${i}`))
  expectInvalid(() => normalizeTeam({ name: 'A', members }, { bits: bitLookup(bits) }), /^members:.*64/)
  const launches = Array.from({ length: 65 }, () => 'a')
  expectInvalid(() => normalizeTeam({ name: 'A', members: [member('a', BUILDER, { launches })] }), /^members\[0\]\.launches:.*64/)
  const nodes = Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, type: 'note' }))
  expectInvalid(() => normalizeTeam({ name: 'A', flow: { nodes } }), /^flow\.nodes:.*500/)
  const edges = Array.from({ length: 1001 }, (_, i) => ({ id: `e${i}`, from: 'a', to: 'b' }))
  expectInvalid(() => normalizeTeam({ name: 'A', flow: { nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'end' }], edges } }), /^flow\.edges:.*1000/)
  assert.equal(normalizeTeam({ name: 'A', members: members.slice(0, 64) }, { bits: bitLookup(bits) }).members.length, 64)
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

await test('TeamStore constructor requires botsRoot and a bit store', () => {
  assert.throws(() => new TeamStore({ botsRoot: 'relative/dir', bits: fakeBitStore() }), TypeError)
  assert.throws(() => new TeamStore({ bits: fakeBitStore() }), TypeError)
  assert.throws(() => new TeamStore({ botsRoot: '/tmp/x' }), TypeError)
  assert.throws(() => new TeamStore({ botsRoot: '/tmp/x', bits: {} }), TypeError)
})

await test('create applies defaults, generates id and timestamps, persists', async () => {
  const { teams, dir } = await newFixture()
  const team = await teams.create({ name: 'Time' })
  assert.match(team.id, /^[0-9a-f]{10}$/)
  assert.equal(team.emoji, '👥')
  assert.equal(team.color, '#2563eb')
  assert.equal(team.workspaceDir, null)
  assert.deepEqual(team.members, [])
  assert.deepEqual(team.flow, { nodes: [], edges: [] })
  assert.equal(team.createdAt, team.updatedAt)
  assert.ok(!Number.isNaN(Date.parse(team.createdAt)))
  assert.equal(teams.file, path.join(dir, 'teams.json'))
  const doc = JSON.parse(await fs.readFile(teams.file, 'utf8'))
  assert.equal(doc.statusVersion, 2)
  assert.equal(doc.teams[0].id, team.id)
  const stat = await fs.stat(teams.file)
  assert.equal(stat.mode & 0o777, 0o600)
  await expectRejects(teams.create({ name: '' }), 'TEAM_INVALID', /^name:/)
  assert.equal(teams.list().length, 1)
})

await test('create validates members against the bit store', async () => {
  const { teams } = await newFixture()
  const team = await teams.create(sampleTeam())
  assert.deepEqual(team.members.map((item) => [item.id, item.bitId]), [['builder', BUILDER], ['scout', SCOUT]])
  await expectRejects(teams.create({ name: 'Bad', members: [member('ghost', ORPHAN)] }), 'TEAM_INVALID', /members\[0\]\.bitId: unknown bit "eeeeeeeeee"/)
  await expectRejects(teams.create({ name: 'Bad', members: [member('runner', RUNNER)], lead: 'runner' }), 'TEAM_LEAD_NOT_ORCHESTRATOR')
  const lead = await teams.create({ name: 'Lead', members: [member('lead', LEAD)], lead: 'lead' })
  assert.equal(lead.lead, 'lead')
  assert.equal(teams.list().length, 2)
})

await test('list/get return deep copies', async () => {
  const { teams } = await newFixture()
  const team = await teams.create(sampleTeam())
  const copy = teams.get(team.id)
  copy.members[0].role = 'mutated'
  copy.flow.nodes.length = 0
  teams.list()[0].name = 'mutated'
  assert.equal(teams.get(team.id).members[0].role, 'Implementa')
  assert.equal(teams.get(team.id).flow.nodes.length, 3)
  assert.equal(teams.get(team.id).name, 'DSC')
  assert.equal(teams.get('nope'), undefined)
})

await test('update replaces members/flow and checks the merged record', async () => {
  const { teams, bits } = await newFixture()
  const team = await teams.create(sampleTeam())
  await new Promise((resolve) => setTimeout(resolve, 5))
  const updated = await teams.update(team.id, { name: 'DSC 2', id: 'ffffffffff', createdAt: '2000-01-01T00:00:00.000Z', bogus: 1 })
  assert.equal(updated.id, team.id)
  assert.equal(updated.name, 'DSC 2')
  assert.equal(updated.createdAt, team.createdAt)
  assert.notEqual(updated.updatedAt, team.updatedAt)
  assert.equal(updated.members.length, 2)
  assert.equal('bogus' in updated, false)

  // removing "builder" while step n2 still references it -> TEAM_INVALID
  await expectRejects(teams.update(team.id, { members: [member('scout', SCOUT)] }), 'TEAM_INVALID', /memberId: unknown member "builder"/)
  // removing "scout" while builder launches it -> TEAM_INVALID
  await expectRejects(
    teams.update(team.id, { members: [member('builder', BUILDER, { launches: ['scout'] })] }),
    'TEAM_INVALID',
    /launches: unknown member id "scout"/,
  )
  // flow-only patch referencing an unknown member is rejected on merge
  await expectRejects(
    teams.update(team.id, { flow: { nodes: [{ id: 'x', type: 'step', memberId: 'ghost' }] } }),
    'TEAM_INVALID',
    /memberId: unknown member "ghost"/,
  )
  // a member patch must reference a real bit
  await expectRejects(teams.update(team.id, { members: [member('solo', ORPHAN)] }), 'TEAM_INVALID', /unknown bit "eeeeeeeeee"/)
  assert.equal(teams.get(team.id).members.length, 2, 'failed updates leave the record untouched')

  const replaced = await teams.update(team.id, {
    members: [member('solo', RUNNER)],
    flow: { nodes: [{ id: 's', type: 'step', memberId: 'solo' }] },
  })
  assert.deepEqual(replaced.members.map((item) => item.id), ['solo'])
  assert.deepEqual(replaced.members[0].bitId, RUNNER)
  assert.deepEqual(replaced.flow.edges, [])
  const cleared = await teams.update(team.id, { workspaceDir: '/tmp/x' })
  assert.equal(cleared.workspaceDir, '/tmp/x')
  assert.equal((await teams.update(team.id, { workspaceDir: null })).workspaceDir, null)
  // a patch can change the lead to another orchestrator member
  assert.equal(bits.records.find((bit) => bit.id === LEAD).isOrchestrator, true)

  await expectRejects(teams.update('0000000000', { name: 'x' }), 'TEAM_NOT_FOUND')
  await expectRejects(teams.update(team.id, null), 'TEAM_INVALID')
})

await test('remove deletes and returns the record', async () => {
  const { teams } = await newFixture()
  const a = await teams.create({ name: 'A' })
  const b = await teams.create({ name: 'B' })
  const removed = await teams.remove(a.id)
  assert.equal(removed.id, a.id)
  assert.deepEqual(teams.list().map((team) => team.id), [b.id])
  await expectRejects(teams.remove(a.id), 'TEAM_NOT_FOUND')
  const doc = JSON.parse(await fs.readFile(teams.file, 'utf8'))
  assert.deepEqual(doc.teams.map((team) => team.id), [b.id])
})

await test('records persist across TeamStore instances in creation order', async () => {
  const root = await tempDir()
  const { teams, bits } = await newFixture({ root })
  const a = await teams.create(sampleTeam())
  const b = await teams.create({ name: 'B' })
  const reloaded = new TeamStore({ botsRoot: root, bits })
  await reloaded.init()
  assert.deepEqual(reloaded.list(), teams.list())
  assert.deepEqual(reloaded.list().map((team) => team.id), [a.id, b.id])
})

await test('missing file starts empty; corrupt file is quarantined', async () => {
  const root = await tempDir()
  const bits = fakeBitStore({ initial: seedBits() })
  const empty = await newStore({ root, bits })
  assert.deepEqual(empty.list(), [])
  await fs.writeFile(path.join(root, 'teams.json'), '{ not json')
  const store = await newStore({ root, bits })
  assert.deepEqual(store.list(), [])
  const files = await fs.readdir(root)
  assert.ok(files.some((name) => /^teams\.json\.corrupt-\d+$/.test(name)), files.join(','))
  assert.ok(!files.includes('teams.json'))
  await store.create({ name: 'fresh' })
  // wrong shape is also quarantined
  await fs.writeFile(path.join(root, 'teams.json'), JSON.stringify({ teams: 'nope' }))
  const again = await newStore({ root, bits })
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
  const store = await newStore({ root })
  const list = store.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'aaaaaaaaaa')
  assert.equal(list[0].createdAt, '2026-01-01T00:00:00.000Z')
  assert.match(list[1].id, /^[0-9a-f]{10}$/)
  assert.notEqual(list[1].id, 'aaaaaaaaaa')
})

await test('members referencing a removed bit still load (no silent team loss)', async () => {
  const root = await tempDir()
  await fs.writeFile(path.join(root, 'teams.json'), JSON.stringify({
    statusVersion: 1,
    teams: [{ id: 'aaaaaaaaaa', name: 'Orphan', members: [{ id: 'a', bitId: ORPHAN }] }],
  }))
  const store = await newStore({ root })
  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0].members[0].bitId, ORPHAN)
  // …but the authoritative checks still run on update.
  await expectRejects(store.update('aaaaaaaaaa', { name: 'x' }), 'TEAM_INVALID', /unknown bit "eeeeeeeeee"/)
})

await test('shared/projectIds patches merge and persist; old records load with defaults', async () => {
  const root = await tempDir()
  const p1 = '1111111111'
  const p2 = '2222222222'
  const { teams: store, bits } = await newFixture({ root })
  const shared = await store.create({ name: 'Shared', shared: true, projectIds: [p1, p2] })
  // Dropping `shared` while two projects remain is rejected by the merged check...
  await expectRejects(store.update(shared.id, { shared: false }), 'TEAM_INVALID', /^projectIds: a non-shared team can belong to only one project/)
  assert.equal(store.get(shared.id).shared, true, 'failed updates leave the record untouched')
  // ...and the matching patch succeeds and persists.
  const single = await store.update(shared.id, { shared: false, projectIds: [p2] })
  assert.equal(single.shared, false)
  assert.deepEqual(single.projectIds, [p2])
  await expectRejects(store.update(single.id, { projectIds: [p1, p2] }), 'TEAM_INVALID', /^projectIds:/)
  await expectRejects(store.create({ name: 'Bad', projectIds: ['zzzzzzzzzz'] }), 'TEAM_INVALID', /^projectIds\[0\]:/)
  const reloaded = new TeamStore({ botsRoot: root, bits })
  await reloaded.init()
  assert.deepEqual(reloaded.get(shared.id).projectIds, [p2])
  assert.equal(reloaded.get(shared.id).shared, false)

  // A v1/v2/v3 teams.json (no shared/projectIds) loads with the new defaults.
  await fs.writeFile(path.join(root, 'teams.json'), JSON.stringify({ statusVersion: 1, teams: [{ id: 'aaaaaaaaaa', name: 'Legacy' }] }))
  const legacy = await newStore({ root })
  assert.equal(legacy.get('aaaaaaaaaa').shared, false)
  assert.deepEqual(legacy.get('aaaaaaaaaa').projectIds, [])
})

await test('concurrent updates do not lose writes', async () => {
  const root = await tempDir()
  const { teams: store } = await newFixture({ root })
  const team = await store.create({ name: 'A' })
  const others = await Promise.all(Array.from({ length: 5 }, (_, i) => store.create({ name: `T${i}` })))
  await Promise.all([
    store.update(team.id, { description: 'desc' }),
    store.update(team.id, { emoji: '🚀' }),
    store.update(team.id, { color: '#ff0000' }),
    store.update(team.id, { members: [member('a', BUILDER)] }),
    ...others.map((item, i) => store.update(item.id, { description: `d${i}` })),
  ])
  const reloaded = await newStore({ root })
  const got = reloaded.get(team.id)
  assert.equal(got.description, 'desc')
  assert.equal(got.emoji, '🚀')
  assert.equal(got.color, '#ff0000')
  assert.equal(got.members.length, 1)
  others.forEach((item, i) => assert.equal(reloaded.get(item.id).description, `d${i}`))
  const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

await test('store enforces the 200 team limit', async () => {
  const root = await tempDir()
  const teams = Array.from({ length: 200 }, (_, i) => ({ id: i.toString(16).padStart(10, '0'), name: `T${i}` }))
  await fs.writeFile(path.join(root, 'teams.json'), JSON.stringify({ statusVersion: 1, teams }))
  const store = await newStore({ root })
  assert.equal(store.list().length, 200)
  await expectRejects(store.create({ name: 'one too many' }), 'TEAM_LIMIT')
  await store.remove(store.list()[0].id)
  await store.create({ name: 'fits again' })
})

// ---------------------------------------------------------------------------
// v4 → v5 migration (V5-CONTRACT §3.2)
// ---------------------------------------------------------------------------

const COORDINATOR_INSTRUCTIONS = 'You orchestrate the team.'

function v4Member(id, character, name, fields = {}) {
  return {
    id,
    character,
    name,
    role: `${name} role`,
    model: 'DeepSeek-V4.1-Flash',
    effort: 'high',
    access: character === 'bit-coordinator' || character === 'bit-scout' ? 'read' : 'write',
    instructions: `${name} instructions.`,
    launches: [],
    ...fields,
  }
}

function v4Team(overrides = {}) {
  return {
    id: 'aaaaaaaaaa',
    name: 'Time A',
    description: 'Primeiro time',
    emoji: '🛠️',
    color: '#7c3aed',
    workspaceDir: '/tmp/time-a',
    lead: 'coordinator',
    harness: 'dsc',
    bindWorkspace: true,
    rules: 'Regras do time',
    skills: ['tdd'],
    entry: [{ id: 'impl', label: 'Implementar', template: 'implemente {pedido}' }],
    shared: true,
    projectIds: ['1111111111', '2222222222'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    members: [
      v4Member('coordinator', 'bit-coordinator', 'Coordinator', { instructions: COORDINATOR_INSTRUCTIONS, launches: ['builder', 'scout'] }),
      v4Member('builder', 'bit-builder', 'Builder'),
      v4Member('scout', 'bit-scout', 'Scout'),
    ],
    flow: {
      nodes: [
        { id: 'n1', type: 'start', x: 0, y: 0 },
        { id: 'n2', type: 'step', x: 0, y: 100, memberId: 'builder' },
      ],
      edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
    },
    ...overrides,
  }
}

function v4TeamB() {
  return {
    id: 'bbbbbbbbbb',
    name: 'Time B',
    lead: 'coordinator',
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    members: [
      v4Member('coordinator', 'bit-coordinator', 'Coordinator', { instructions: COORDINATOR_INSTRUCTIONS, launches: ['builder', 'runner'] }),
      v4Member('builder', 'bit-builder', 'Builder'),
      v4Member('runner', 'bit-runner', 'Runner', { access: 'write' }),
    ],
    flow: { nodes: [], edges: [] },
  }
}

async function seedV4(root, teams = [v4Team()]) {
  await fs.writeFile(path.join(root, 'teams.json'), JSON.stringify({ statusVersion: 1, teams }))
}

await test('migration: v4 members become deduplicated bits and the file is backed up', async () => {
  const root = await tempDir()
  await seedV4(root, [v4Team(), v4TeamB()])
  const bits = fakeBitStore()
  const logs = []
  const store = new TeamStore({ botsRoot: root, bits, log: (message) => logs.push(message) })
  await store.init()

  // One bit per distinct character|name|instructions, shared across teams.
  assert.equal(bits.records.length, 4, bits.records.map((bit) => bit.name).join(','))
  assert.deepEqual(bits.records.map((bit) => bit.name).sort(), ['Builder', 'Coordinator', 'Runner', 'Scout'])
  const bitId = (name) => bits.records.find((bit) => bit.name === name).id
  const coordinatorBit = bits.records.find((bit) => bit.name === 'Coordinator')
  assert.equal(coordinatorBit.isOrchestrator, true)
  assert.equal(coordinatorBit.model, 'deepseek-account/deepseek-flash')
  assert.equal(coordinatorBit.effort, 'max')
  assert.equal(coordinatorBit.instructions, COORDINATOR_INSTRUCTIONS)
  const worker = bits.records.find((bit) => bit.name === 'Builder')
  assert.equal(worker.isOrchestrator, false)
  assert.equal(worker.model, 'subscription/sonnet')
  assert.equal(worker.effort, 'high')

  const list = store.list()
  assert.equal(list.length, 2)
  const [teamA, teamB] = list
  // member ids never change; the ordered bit references are shared.
  assert.deepEqual(teamA.members.map((item) => item.id), ['coordinator', 'builder', 'scout'])
  assert.deepEqual(teamA.members.map((item) => item.bitId), [bitId('Coordinator'), bitId('Builder'), bitId('Scout')])
  assert.deepEqual(teamB.members.map((item) => item.bitId), [bitId('Coordinator'), bitId('Builder'), bitId('Runner')])
  for (const memberItem of [...teamA.members, ...teamB.members]) {
    for (const key of ['character', 'name', 'model', 'provider', 'effort', 'instructions']) {
      assert.equal(key in memberItem, false, `${key} must be gone from migrated member ${memberItem.id}`)
    }
  }
  // Everything that is not a member is preserved untouched.
  assert.equal(teamA.lead, 'coordinator')
  assert.equal(teamA.harness, 'dsc')
  assert.equal(teamA.bindWorkspace, true)
  assert.equal(teamA.rules, 'Regras do time')
  assert.deepEqual(teamA.skills, ['tdd'])
  assert.deepEqual(teamA.entry, [{ id: 'impl', label: 'Implementar', template: 'implemente {pedido}' }])
  assert.equal(teamA.shared, true)
  assert.deepEqual(teamA.projectIds, ['1111111111', '2222222222'])
  assert.equal(teamA.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(teamA.updatedAt, '2026-01-02T00:00:00.000Z')
  assert.deepEqual(teamA.flow.nodes[1].memberId, 'builder')
  assert.equal(teamA.members[0].role, 'Coordinator role')
  assert.equal(teamA.members[1].access, 'write')
  assert.deepEqual(teamA.members[0].launches, ['builder', 'scout'])

  // Backup + rewritten file + summary.
  const files = await fs.readdir(root)
  assert.ok(files.some((name) => /^teams\.json\.bak-\d+$/.test(name)), files.join(','))
  const doc = JSON.parse(await fs.readFile(path.join(root, 'teams.json'), 'utf8'))
  assert.deepEqual(doc.teams.map((team) => team.id), ['aaaaaaaaaa', 'bbbbbbbbbb'])
  assert.match(doc.teams[0].members[0].bitId, /^[0-9a-f]{10}$/)
  assert.ok(logs.some((message) => message.includes('migrated teams.json: 2 teams, 4 bits created')), logs.join('\n'))
  assert.deepEqual(store.lastMigration, { teams: 2, bitsCreated: 4, bitsUpdated: 0, failed: 0 })
})

await test('migration: idempotent (v5 file is not touched again)', async () => {
  const root = await tempDir()
  await seedV4(root, [v4Team(), v4TeamB()])
  const bits = fakeBitStore()
  const first = new TeamStore({ botsRoot: root, bits })
  await first.init()
  const firstList = first.list()
  const backups = (await fs.readdir(root)).filter((name) => name.startsWith('teams.json.bak-'))
  assert.equal(backups.length, 1)

  const logs = []
  const second = new TeamStore({ botsRoot: root, bits, log: (message) => logs.push(message) })
  await second.init()
  assert.deepEqual(second.list(), firstList)
  assert.equal(bits.records.length, 4, 'no new bits on the second boot')
  assert.equal((await fs.readdir(root)).filter((name) => name.startsWith('teams.json.bak-')).length, 1)
  assert.equal(second.lastMigration, null)
  assert.deepEqual(logs, [])
})

await test('migration: catalog emoji/color are used for migrated bits', async () => {
  const root = await tempDir()
  await seedV4(root, [v4Team()])
  const bits = fakeBitStore()
  const catalog = {
    get(character) {
      if (character === 'bit-builder') return { id: character, emoji: '🎯', color: '#123456' }
      if (character === 'bit-scout') return { id: character, emoji: '🔎', color: '#abcdef' }
      return undefined
    },
  }
  const store = new TeamStore({ botsRoot: root, bits, catalog })
  await store.init()
  const builder = bits.records.find((bit) => bit.name === 'Builder')
  assert.equal(builder.emoji, '🎯')
  assert.equal(builder.color, '#123456')
  const scout = bits.records.find((bit) => bit.name === 'Scout')
  assert.equal(scout.emoji, '🔎')
  assert.equal(scout.color, '#abcdef')
  const coordinator = bits.records.find((bit) => bit.name === 'Coordinator')
  assert.equal(coordinator.emoji, '🤖', 'unknown catalog row falls back to the bit defaults')
  assert.equal(coordinator.color, '#475569')
})

await test('migration: missing character/catalog never throws and keeps the team', async () => {
  const root = await tempDir()
  const legacy = v4Team()
  legacy.members = [
    { id: 'coordinator', character: 'bit-coordinator', name: 'Coordinator', access: 'read', instructions: COORDINATOR_INSTRUCTIONS, launches: ['mystery'] },
    { id: 'mystery', character: 'bit-not-in-catalog', name: 'Mystery', access: 'write', instructions: 'Be mysterious.', launches: [] },
    { id: 'plain', name: 'Plain', access: 'write', launches: [] },
  ]
  legacy.lead = 'coordinator'
  legacy.flow = { nodes: [], edges: [] }
  await seedV4(root, [legacy])
  const bits = fakeBitStore()
  const store = new TeamStore({ botsRoot: root, bits })
  await store.init()
  const team = store.list()[0]
  assert.equal(team.members.length, 3)
  assert.deepEqual(team.members.map((item) => item.id), ['coordinator', 'mystery', 'plain'])
  assert.equal(team.lead, 'coordinator')
  assert.equal(store.lastMigration.teams, 1)
  assert.equal(store.lastMigration.bitsCreated, 3)
})

await test('migration: the lead bit is forced to orchestrator even when a worker bit is reused', async () => {
  const root = await tempDir()
  const teamA = {
    id: 'aaaaaaaaaa',
    name: 'A',
    lead: 'coordinator',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    members: [
      v4Member('coordinator', 'bit-coordinator', 'Coordinator', { instructions: COORDINATOR_INSTRUCTIONS }),
      v4Member('builder', 'bit-builder', 'Builder', { instructions: 'Shared builder.' }),
    ],
    flow: { nodes: [], edges: [] },
  }
  // Team B is led by the same builder member: its bit must become the lead bit.
  const teamB = {
    id: 'bbbbbbbbbb',
    name: 'B',
    lead: 'builder',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    members: [v4Member('builder', 'bit-builder', 'Builder', { instructions: 'Shared builder.' })],
    flow: { nodes: [], edges: [] },
  }
  await seedV4(root, [teamA, teamB])
  const bits = fakeBitStore()
  const store = new TeamStore({ botsRoot: root, bits })
  await store.init()
  const builderBit = bits.records.find((bit) => bit.name === 'Builder')
  assert.equal(builderBit.isOrchestrator, true, 'the reused lead bit was upgraded')
  assert.equal(builderBit.model, 'deepseek-account/deepseek-flash')
  assert.equal(builderBit.effort, 'max')
  assert.equal(store.lastMigration.bitsUpdated, 1)
  assert.equal(store.list()[1].lead, 'builder')
  assert.equal(store.list()[1].members[0].bitId, builderBit.id)
})

await test('migration: a team whose conversion fails is preserved raw (never lost)', async () => {
  const root = await tempDir()
  await seedV4(root, [v4Team(), v4TeamB()])
  const bits = fakeBitStore()
  const failing = {
    ...bits,
    async create(input) {
      if (input.name === 'Runner') throw Object.assign(new Error('Bit limit reached'), { code: 'BOT_LIMIT' })
      return bits.create(input)
    },
  }
  const logs = []
  const store = new TeamStore({ botsRoot: root, bits: failing, log: (message) => logs.push(message) })
  await store.init()
  const list = store.list()
  assert.equal(list.length, 2, 'no team is lost')
  // Team A migrated; team B kept its legacy members so a later boot retries.
  assert.equal(list[0].members[0].bitId, bits.records.find((bit) => bit.name === 'Coordinator').id)
  assert.equal(typeof list[1].members[0].bitId, 'undefined')
  assert.equal(list[1].members[0].name, 'Coordinator')
  assert.deepEqual(store.lastMigration, { teams: 1, bitsCreated: 3, bitsUpdated: 0, failed: 1 })
  assert.ok(logs.some((message) => message.includes('could not migrate team')))
  assert.ok(logs.some((message) => message.includes('kept unmigrated')))
  // The mixed document was written (backup exists) and the next boot retries.
  assert.ok((await fs.readdir(root)).some((name) => name.startsWith('teams.json.bak-')))
})

await test('migration: teams that already use bitId are left untouched', async () => {
  const root = await tempDir()
  const v5Team = {
    id: 'cccccccccc',
    name: 'Already migrated',
    lead: 'lead',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    members: [{ id: 'lead', bitId: LEAD }],
    flow: { nodes: [], edges: [] },
  }
  await fs.writeFile(
    path.join(root, 'teams.json'),
    JSON.stringify({ statusVersion: 1, teams: [v5Team, v4Team()] }),
  )
  const bits = fakeBitStore({ initial: seedBits() })
  const store = new TeamStore({ botsRoot: root, bits })
  await store.init()
  assert.equal(store.list().length, 2)
  assert.deepEqual(store.list()[0], {
    ...v5Team,
    description: '',
    emoji: '👥',
    color: '#2563eb',
    workspaceDir: null,
    harness: null,
    bindWorkspace: false,
    rules: '',
    skills: [],
    entry: [],
    shared: false,
    projectIds: [],
    members: [{ id: 'lead', bitId: LEAD, role: '', access: 'write', launches: [], skills: [], teamRef: null, mcp: [] }],
    flow: { nodes: [], edges: [] },
  })
  const coordinatorBits = bits.records.filter((bit) => bit.name === 'Coordinator')
  assert.equal(coordinatorBits.length, 2, 'the seeded bit has different instructions; a new one is created')
  assert.equal(store.list()[1].members[0].bitId, coordinatorBits[1].id)
  assert.equal(store.lastMigration.teams, 1)
})

// ---------------------------------------------------------------------------
// Routes + templates
// ---------------------------------------------------------------------------

function fakeConnection() {
  const routes = new Map()
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }
  async function call(routePath, payload, raw) {
    const request = new Request(`http://x${routePath}`, {
      method: payload === undefined && raw === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw !== undefined ? raw : payload === undefined ? undefined : JSON.stringify(payload),
    })
    const route = routes.get(routePath)
    assert.ok(route !== undefined, `route ${routePath} is not registered`)
    const response = await route.fetch(request)
    assert.equal(response.status, 200)
    return response.json()
  }
  return { ctx, routes, call }
}

async function setupRoutes({ root, initialBits = seedBits(), bits, catalog = null, templates, projects, log } = {}) {
  const dir = root ?? (await tempDir())
  const bitStore = bits ?? fakeBitStore({ initial: initialBits })
  const logs = []
  const teams = new TeamStore({ botsRoot: dir, bits: bitStore, catalog, log: (message) => logs.push(message) })
  await teams.init()
  const { ctx, routes, call } = fakeConnection()
  const dispose = registerTeamRoutes(ctx, {
    teams,
    bits: bitStore,
    projects,
    catalog,
    templates,
    ready: Promise.resolve(),
    log: (message) => logs.push(message),
  })
  return { dir, bits: bitStore, teams, routes, call, logs, dispose }
}

await test('registerTeamRoutes requires the connection registry, the team store and the bit store', () => {
  const teams = {}
  assert.throws(() => registerTeamRoutes({}, { teams, bits: {} }), TypeError)
  assert.throws(() => registerTeamRoutes({ connection: { fetch: { register() {} } } }, { bits: {} }), TypeError)
  assert.throws(() => registerTeamRoutes({ connection: { fetch: { register() {} } } }, { teams, ready: Promise.resolve() }), TypeError)
})

await test('routes register exact paths (providers removed, fromTemplate added)', async () => {
  const app = await setupRoutes()
  assert.deepEqual([...app.routes.keys()].sort(), [
    '/api/bots.teams',
    '/api/bots.teams.create',
    '/api/bots.teams.delete',
    '/api/bots.teams.fromTemplate',
    '/api/bots.teams.templates',
    '/api/bots.teams.update',
  ])
  assert.equal(app.routes.has('/api/bots.teams.providers'), false)
  for (const route of app.routes.values()) assert.equal(route.requestBody, 'buffered')
  assert.deepEqual(app.routes.get('/api/bots.teams').methods, ['GET'])
  assert.deepEqual(app.routes.get('/api/bots.teams.create').methods, ['POST'])
  assert.deepEqual(app.routes.get('/api/bots.teams.fromTemplate').methods, ['POST'])
  app.dispose()
  assert.equal(app.routes.size, 0)
})

await test('routes CRUD flow (bitId members)', async () => {
  const app = await setupRoutes()
  assert.deepEqual(await app.call('/api/bots.teams'), { ok: true, teams: [] })
  const created = await app.call('/api/bots.teams.create', {
    team: { ...sampleTeam(), id: 'ffffffffff', createdAt: '2000-01-01T00:00:00.000Z', updatedAt: 'x' },
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.notEqual(created.team.id, 'ffffffffff')
  assert.notEqual(created.team.createdAt, '2000-01-01T00:00:00.000Z')
  assert.deepEqual(created.team.members.map((item) => item.bitId), [BUILDER, SCOUT])
  const id = created.team.id

  const listed = await app.call('/api/bots.teams')
  assert.equal(listed.teams.length, 1)

  const updated = await app.call('/api/bots.teams.update', { id, patch: { name: 'Novo', id: 'ffffffffff', createdAt: 'x', updatedAt: 'y' } })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.equal(updated.team.name, 'Novo')
  assert.equal(updated.team.id, id)

  const invalid = await app.call('/api/bots.teams.update', { id, patch: { members: [member('scout', SCOUT)] } })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'TEAM_INVALID')

  const unknownBit = await app.call('/api/bots.teams.create', { team: { name: 'X', members: [member('a', ORPHAN)] } })
  assert.equal(unknownBit.error.code, 'TEAM_INVALID')
  assert.match(unknownBit.error.message, /unknown bit "eeeeeeeeee"/)

  const deleted = await app.call('/api/bots.teams.delete', { id })
  assert.deepEqual(deleted, { ok: true, deleted: true, id })
  assert.equal((await app.call('/api/bots.teams.delete', { id })).error.code, 'TEAM_NOT_FOUND')
  assert.equal((await app.call('/api/bots.teams.update', { id, patch: { name: 'x' } })).error.code, 'TEAM_NOT_FOUND')
})

await test('routes enforce the lead-orchestrator rule', async () => {
  const app = await setupRoutes()
  const workerLead = await app.call('/api/bots.teams.create', {
    team: { name: 'X', members: [member('runner', RUNNER)], lead: 'runner' },
  })
  assert.equal(workerLead.ok, false)
  assert.equal(workerLead.error.code, 'TEAM_LEAD_NOT_ORCHESTRATOR')
  const ok = await app.call('/api/bots.teams.create', { team: { name: 'Y', members: [member('lead', LEAD)], lead: 'lead' } })
  assert.equal(ok.ok, true, JSON.stringify(ok))
})

await test('routes reject malformed bodies with BAD_REQUEST', async () => {
  const app = await setupRoutes()
  for (const routePath of ['/api/bots.teams.create', '/api/bots.teams.update', '/api/bots.teams.delete', '/api/bots.teams.fromTemplate']) {
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

await test('unexpected errors become INTERNAL and are logged', async () => {
  const { ctx, routes, call } = fakeConnection()
  const logs = []
  const teams = { list() { throw new Error('boom') } }
  registerTeamRoutes(ctx, { teams, bits: { create: async () => ({}) }, ready: Promise.resolve(), log: (message) => logs.push(message) })
  const payload = await call('/api/bots.teams')
  assert.deepEqual(payload, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } })
  assert.ok(logs.some((message) => message.includes('boom')))
  assert.equal(routes.size, 6)
})

await test('handlers wait for deps.ready', async () => {
  const teams = await newStore()
  const { ctx, routes } = fakeConnection()
  let release
  const ready = new Promise((resolve) => { release = resolve })
  registerTeamRoutes(ctx, { teams, bits: { create: async () => ({}) }, ready })
  let settled = false
  const pending = routes.get('/api/bots.teams').fetch(new Request('http://x/api/bots.teams')).then((response) => {
    settled = true
    return response.json()
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false)
  release()
  assert.deepEqual(await pending, { ok: true, teams: [] })
})

await test('routes validate project ids when a project store is available', async () => {
  const projectId = '1111111111'
  const projects = { get: (id) => (id === projectId ? { id } : undefined) }
  const app = await setupRoutes({ projects })
  const created = await app.call('/api/bots.teams.create', { team: { name: 'DSC', projectIds: [projectId] } })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.deepEqual(created.team.projectIds, [projectId])
  const bad = await app.call('/api/bots.teams.create', { team: { name: 'X', projectIds: ['2222222222'] } })
  assert.equal(bad.error.code, 'TEAM_INVALID')
  assert.equal(bad.error.message, 'projectIds[0]: unknown project "2222222222"')
})

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

function sampleTemplate(overrides = {}) {
  return {
    id: 'eng',
    name: 'Engenharia (template)',
    description: 'Time de teste',
    emoji: '🛠️',
    bits: [
      { key: 'coordinator', name: 'Coordinator', character: 'bit-coordinator', instructions: 'Orquestre.', isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'max' },
      { key: 'builder', name: 'Builder', character: 'bit-builder', instructions: 'Implemente.' },
    ],
    team: {
      name: 'Engenharia',
      description: 'x',
      emoji: '👥',
      color: '#2563eb',
      workspaceDir: null,
      lead: 'coordinator',
      members: [
        { id: 'coordinator', bitKey: 'coordinator', role: 'Orquestra', access: 'read', launches: ['builder'] },
        { id: 'builder', bitKey: 'builder', role: 'Implementa', access: 'write', launches: [] },
      ],
      flow: {
        nodes: [{ id: 'n1', type: 'start' }, { id: 'n2', type: 'step', memberId: 'builder' }],
        edges: [{ id: 'e1', from: 'n1', to: 'n2' }],
      },
    },
    ...overrides,
  }
}

const testCatalog = {
  has: (id) => ['bit-coordinator', 'bit-builder', 'bit-scout', 'bit-runner'].includes(id),
  get(id) {
    if (!this.has(id)) return undefined
    return {
      id,
      emoji: '🎯',
      color: '#123456',
      instructions: `Catalog instructions for ${id}.`,
      isOrchestrator: id === 'bit-coordinator',
    }
  },
}

await test('loadTeamTemplates loads the new format and skips invalid templates', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'eng.json'), JSON.stringify(sampleTemplate()))
  // Missing bits is invalid.
  await fs.writeFile(path.join(dir, 'nobits.json'), JSON.stringify({ id: 'nobits', name: 'No bits', team: sampleTemplate().team }))
  // Unknown bitKey reference is invalid.
  const unknownRef = sampleTemplate({ id: 'unknown-ref' })
  unknownRef.team.members[1].bitKey = 'ghost'
  await fs.writeFile(path.join(dir, 'unknown-ref.json'), JSON.stringify(unknownRef))
  // A lead bit explicitly marked as a worker is invalid.
  const workerLead = sampleTemplate({ id: 'worker-lead' })
  workerLead.bits[0].isOrchestrator = false
  await fs.writeFile(path.join(dir, 'worker-lead.json'), JSON.stringify(workerLead))
  await fs.writeFile(path.join(dir, 'garbage.json'), '{ nope')
  await fs.writeFile(path.join(dir, 'readme.txt'), 'ignored')
  const logs = []
  const templates = loadTeamTemplates(dir, (message) => logs.push(message))
  assert.equal(templates.length, 1)
  assert.equal(templates[0].id, 'eng')
  assert.equal(templates[0].name, 'Engenharia (template)')
  assert.equal(templates[0].bits.length, 2)
  assert.deepEqual(templates[0].bits.map((bit) => bit.key), ['coordinator', 'builder'])
  assert.equal(templates[0].team.lead, 'coordinator')
  assert.deepEqual(templates[0].team.members.map((item) => item.bitKey), ['coordinator', 'builder'])
  assert.equal(logs.length, 4, logs.join('\n'))
  assert.ok(logs.some((message) => message.includes('nobits.json') && message.includes('bits')))
  assert.ok(logs.some((message) => message.includes('unknown-ref.json') && message.includes('ghost')))
  assert.ok(logs.some((message) => message.includes('worker-lead.json') && message.includes('orchestrator')))
  assert.ok(logs.some((message) => message.includes('garbage.json')))

  assert.deepEqual(loadTeamTemplates(path.join(dir, 'missing')), [])
})

await test('the shipped engineering template loads with the v5 format', async () => {
  const dir = path.join(process.cwd(), 'bits', 'teams')
  const templates = loadTeamTemplates(dir)
  const engineering = templates.find((template) => template.id === 'engineering')
  assert.ok(engineering !== undefined, 'engineering template must be valid')
  assert.equal(engineering.bits.length, 11)
  assert.equal(engineering.team.members.length, 11)
  assert.equal(engineering.team.lead, 'coordinator')
  assert.equal(engineering.bits[0].isOrchestrator, true)
  assert.equal(engineering.bits[0].model, 'deepseek-account/deepseek-flash')
  assert.equal(engineering.bits[0].effort, 'max')
  assert.equal(engineering.bits.find((bit) => bit.key === 'scout').character, 'bit-scout')
  assert.equal(engineering.team.members.find((item) => item.id === 'coordinator').launches.length, 10)
})

await test('GET /api/bots.teams.templates returns templates including bits', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'eng.json'), JSON.stringify(sampleTemplate()))
  const templates = loadTeamTemplates(dir)
  const app = await setupRoutes({ templates })
  const payload = await app.call('/api/bots.teams.templates')
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.templates, templates)
  payload.templates[0].bits[0].name = 'mutated'
  assert.equal((await app.call('/api/bots.teams.templates')).templates[0].bits[0].name, 'Coordinator')
  const none = await setupRoutes()
  assert.deepEqual(await none.call('/api/bots.teams.templates'), { ok: true, templates: [] })
})

// ---------------------------------------------------------------------------
// POST /api/bots.teams.fromTemplate
// ---------------------------------------------------------------------------

await test('fromTemplate creates fresh bits and the team referencing them', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'eng.json'), JSON.stringify(sampleTemplate()))
  const templates = loadTeamTemplates(dir)
  const app = await setupRoutes({ templates, catalog: testCatalog, initialBits: [] })

  const created = await app.call('/api/bots.teams.fromTemplate', { templateId: 'eng' })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.bits.length, 2)
  assert.equal(created.team.name, 'Engenharia')
  assert.equal(created.team.lead, 'coordinator')
  assert.deepEqual(
    created.team.members.map((item) => [item.id, item.bitId]),
    [['coordinator', created.bits[0].id], ['builder', created.bits[1].id]],
  )
  // Catalog defaults for the character + template overrides.
  assert.equal(created.bits[0].name, 'Coordinator')
  assert.equal(created.bits[0].instructions, 'Orquestre.')
  assert.equal(created.bits[0].model, 'deepseek-account/deepseek-flash')
  assert.equal(created.bits[0].effort, 'max')
  assert.equal(created.bits[0].isOrchestrator, true)
  assert.equal(created.bits[0].emoji, '🎯')
  assert.equal(created.bits[0].color, '#123456')
  assert.equal(created.bits[1].instructions, 'Implemente.')
  assert.equal(app.teams.list().length, 1)
  assert.equal(app.bits.records.length, 2)

  // A one-time instantiation always creates fresh bits.
  const again = await app.call('/api/bots.teams.fromTemplate', { templateId: 'eng' })
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.notDeepEqual(again.bits.map((bit) => bit.id), created.bits.map((bit) => bit.id))
  assert.equal(app.bits.records.length, 4)
  assert.equal(app.teams.list().length, 2)
})

await test('fromTemplate: instructions default to the catalog instructions', async () => {
  const dir = await tempDir()
  const template = sampleTemplate({ id: 'docs' })
  delete template.bits[1].instructions
  await fs.writeFile(path.join(dir, 'docs.json'), JSON.stringify(template))
  const templates = loadTeamTemplates(dir)
  const app = await setupRoutes({ templates, catalog: testCatalog })
  const created = await app.call('/api/bots.teams.fromTemplate', { templateId: 'docs' })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.bits[1].instructions, 'Catalog instructions for bit-builder.')
})

await test('fromTemplate: name override and optional project', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'eng.json'), JSON.stringify(sampleTemplate()))
  const templates = loadTeamTemplates(dir)
  const projectId = '1111111111'
  const projects = { get: (id) => (id === projectId ? { id } : undefined) }
  const app = await setupRoutes({ templates, catalog: testCatalog, projects })
  const created = await app.call('/api/bots.teams.fromTemplate', { templateId: 'eng', name: 'Meu time', projectId })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.team.name, 'Meu time')
  assert.deepEqual(created.team.projectIds, [projectId])
  assert.equal(created.team.shared, false)

  const unknownProject = await app.call('/api/bots.teams.fromTemplate', { templateId: 'eng', projectId: '2222222222' })
  assert.equal(unknownProject.ok, false)
  assert.equal(unknownProject.error.code, 'PROJECT_NOT_FOUND')
})

await test('fromTemplate: unknown template, unknown catalog character and rollback', async () => {
  const dir = await tempDir()
  await fs.writeFile(path.join(dir, 'eng.json'), JSON.stringify(sampleTemplate()))
  const templates = loadTeamTemplates(dir)
  const unknownTemplate = await (await setupRoutes({ templates })).call('/api/bots.teams.fromTemplate', { templateId: 'nope' })
  assert.equal(unknownTemplate.error.code, 'TEAM_TEMPLATE_NOT_FOUND')
  assert.match(unknownTemplate.error.message, /Team template "nope" was not found/)

  // A template character the catalog does not know is rejected before any bit is created.
  const strictCatalog = { ...testCatalog, has: () => false }
  const app = await setupRoutes({ templates, catalog: strictCatalog, initialBits: [] })
  const badCharacter = await app.call('/api/bots.teams.fromTemplate', { templateId: 'eng' })
  assert.equal(badCharacter.ok, false)
  assert.equal(badCharacter.error.code, 'BIT_INVALID_CHARACTER')
  assert.equal(app.bits.records.length, 0)

  // A team creation failure rolls the freshly created bits back.
  const failingTeams = { async create() { throw Object.assign(new Error('team store busy'), { code: 'TEAM_INVALID' }) } }
  const { ctx, routes, call } = fakeConnection()
  const bits = fakeBitStore({ initial: [] })
  registerTeamRoutes(ctx, { teams: failingTeams, bits, catalog: testCatalog, templates, ready: Promise.resolve() })
  const rolledBack = await call('/api/bots.teams.fromTemplate', { templateId: 'eng' })
  assert.equal(rolledBack.ok, false)
  assert.equal(rolledBack.error.code, 'TEAM_INVALID')
  assert.equal(bits.records.length, 0, 'created bits are removed when the team cannot be created')
  assert.ok(bits.removals.length > 0, 'rollback did not call remove')
  for (const removal of bits.removals) {
    assert.equal(removal.options?.deleteWorkspace, true, `rollback of ${removal.id} did not delete the workspace`)
  }
  assert.equal(routes.size, 6)
})

// ---------------------------------------------------------------------------

for (const dir of tempRoots) await fs.rm(dir, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.log(`teams: ${failures.length} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`teams: ${passed} tests passed`)
