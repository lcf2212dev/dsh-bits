/**
 * Tests for projects (CONTRACT §12): `normalizeProject`, `ProjectStore`
 * persistence and limits, `/api/bots.projects*` routes (including delete
 * detaching teams), the team `shared`/`projectIds` rules, the project reference
 * validation done by the team routes and `teams.fromPack`'s optional project.
 *
 * Teams reference bits since V5-CONTRACT §5.1, so the team/harness route
 * fixtures inject a local fake bit store; project behavior itself is unchanged.
 *
 * Plain `node test/projects.test.mjs`; Node built-ins only.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ProjectStore, normalizeProject } from '../host/projects.js'
import { registerProjectRoutes } from '../host/project-routes.js'
import { TeamStore, normalizeTeam } from '../host/teams.js'
import { registerTeamRoutes } from '../host/team-routes.js'
import { registerHarnessRoutes } from '../host/harness-routes.js'

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

/**
 * Minimal in-memory BitStore: enough for the team/harness route fixtures
 * (project behavior does not depend on bits).
 */
function fakeBitStore() {
  let counter = 0
  const clone = (value) => JSON.parse(JSON.stringify(value))
  const records = []
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
      if (record === undefined) throw Object.assign(new Error(`bit "${id}" not found`), { code: 'BOT_NOT_FOUND' })
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

const tempRoots = []
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bits-projects-'))
  tempRoots.push(dir)
  return dir
}

async function newProjectStore(root) {
  const store = new ProjectStore({ botsRoot: root ?? (await tempDir()) })
  await store.init()
  return store
}

async function newTeamStore(root) {
  const store = new TeamStore({ botsRoot: root ?? (await tempDir()), bits: fakeBitStore() })
  await store.init()
  return store
}

function expectProjectInvalid(fn, fieldPattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'PROJECT_INVALID', `expected PROJECT_INVALID, got ${error.code}: ${error.message}`)
    if (fieldPattern) assert.match(error.message, fieldPattern)
    return true
  })
}

function expectTeamInvalid(fn, fieldPattern) {
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

const sampleProject = (extra = {}) => ({
  name: 'DSC',
  description: 'CAIXA React Native design system',
  ...extra,
})

/** A fake connection registry, like the one the teams tests use. */
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
  return { ctx, routes, call }
}

// ---------------------------------------------------------------------------
// normalizeProject
// ---------------------------------------------------------------------------

await test('normalizeProject applies defaults in create mode', () => {
  const project = normalizeProject({ name: '  DSC  ' })
  assert.deepEqual(project, {
    name: 'DSC',
    description: '',
    emoji: '📁',
    color: '#2563eb',
  })
  assert.deepEqual(normalizeProject(sampleProject({ emoji: '🚀', color: '#FF0000' })), {
    name: 'DSC',
    description: 'CAIXA React Native design system',
    emoji: '🚀',
    color: '#ff0000',
  })
  assert.equal(normalizeProject({ name: 'A', emoji: '' }).emoji, '')
  assert.equal(normalizeProject({ name: 'A', description: null }).description, '')
})

await test('normalizeProject ignores store-owned and unknown fields', () => {
  const project = normalizeProject({
    id: 'zz',
    createdAt: 'x',
    updatedAt: 'y',
    name: 'A',
    extra: 1,
    members: [],
  })
  assert.deepEqual(project, { name: 'A', description: '', emoji: '📁', color: '#2563eb' })
  for (const key of ['id', 'createdAt', 'updatedAt', 'extra', 'members']) assert.equal(key in project, false)
})

await test('normalizeProject validates fields', () => {
  expectProjectInvalid(() => normalizeProject({}), /^name:/)
  expectProjectInvalid(() => normalizeProject({ name: '   ' }), /^name: must be 1-60 characters/)
  expectProjectInvalid(() => normalizeProject({ name: 42 }), /^name:/)
  expectProjectInvalid(() => normalizeProject({ name: 'x'.repeat(61) }), /^name: must be 1-60 characters/)
  expectProjectInvalid(() => normalizeProject({ name: 'A', description: 'x'.repeat(2001) }), /^description:/)
  expectProjectInvalid(() => normalizeProject({ name: 'A', description: 42 }), /^description:/)
  expectProjectInvalid(() => normalizeProject({ name: 'A', emoji: '123456789' }), /^emoji:/)
  expectProjectInvalid(() => normalizeProject({ name: 'A', emoji: 42 }), /^emoji:/)
  expectProjectInvalid(() => normalizeProject({ name: 'A', color: 'blue' }), /^color: must be a #rrggbb hex color/)
  expectProjectInvalid(() => normalizeProject(null), /^project: must be an object/)
  expectProjectInvalid(() => normalizeProject([]), /^project: must be an object/)
})

await test('normalizeProject partial mode returns only present fields', () => {
  assert.deepEqual(normalizeProject({ description: 'x', id: 'ignored' }, { partial: true }), { description: 'x' })
  assert.deepEqual(normalizeProject({ color: null }, { partial: true }), { color: '#2563eb' })
  assert.deepEqual(normalizeProject({ name: '  New  ', emoji: '📦' }, { partial: true }), { name: 'New', emoji: '📦' })
  expectProjectInvalid(() => normalizeProject({ name: '' }, { partial: true }), /^name:/)
  expectProjectInvalid(() => normalizeProject({ color: 'red' }, { partial: true }), /^color:/)
  expectProjectInvalid(() => normalizeProject('nope', { partial: true }), /^patch: must be an object/)
})

// ---------------------------------------------------------------------------
// ProjectStore
// ---------------------------------------------------------------------------

await test('create applies defaults, generates id and timestamps, persists', async () => {
  const store = await newProjectStore()
  const project = await store.create({ name: 'DSC' })
  assert.match(project.id, /^[0-9a-f]{10}$/)
  assert.equal(project.name, 'DSC')
  assert.equal(project.description, '')
  assert.equal(project.emoji, '📁')
  assert.equal(project.color, '#2563eb')
  assert.equal(project.createdAt, project.updatedAt)
  assert.ok(!Number.isNaN(Date.parse(project.createdAt)))
  assert.equal(store.file, path.join(store.botsRoot, 'projects.json'))
  const doc = JSON.parse(await fs.readFile(store.file, 'utf8'))
  assert.equal(doc.statusVersion, 1)
  assert.equal(doc.projects[0].id, project.id)
  assert.deepEqual(Object.keys(doc.projects[0]).sort(), ['color', 'createdAt', 'description', 'emoji', 'id', 'name', 'updatedAt'])
  const stat = await fs.stat(store.file)
  assert.equal(stat.mode & 0o777, 0o600)
  await expectRejects(store.create({ name: '' }), 'PROJECT_INVALID', /^name:/)
  assert.equal(store.list().length, 1)
})

await test('list/get return deep copies', async () => {
  const store = await newProjectStore()
  const project = await store.create(sampleProject())
  const copy = store.get(project.id)
  copy.name = 'mutated'
  store.list()[0].description = 'mutated'
  assert.equal(store.get(project.id).name, 'DSC')
  assert.equal(store.get(project.id).description, 'CAIXA React Native design system')
  assert.equal(store.get('nope'), undefined)
  assert.equal(store.get(null), undefined)
})

await test('update patches the record and checks the merged result', async () => {
  const store = await newProjectStore()
  const project = await store.create(sampleProject())
  await new Promise((resolve) => setTimeout(resolve, 5))
  const updated = await store.update(project.id, {
    name: '  City Hall  ',
    emoji: '🏛️',
    color: '#10B981',
    id: 'ffffffffff',
    createdAt: '2000-01-01T00:00:00.000Z',
    bogus: 1,
  })
  assert.equal(updated.id, project.id)
  assert.equal(updated.name, 'City Hall')
  assert.equal(updated.emoji, '🏛️')
  assert.equal(updated.color, '#10b981')
  assert.equal(updated.description, project.description)
  assert.equal(updated.createdAt, project.createdAt)
  assert.notEqual(updated.updatedAt, project.updatedAt)
  assert.equal('bogus' in updated, false)
  // Clearing the optional description is a normal patch.
  assert.equal((await store.update(project.id, { description: '' })).description, '')
  await expectRejects(store.update(project.id, { name: '' }), 'PROJECT_INVALID', /^name:/)
  await expectRejects(store.update(project.id, null), 'PROJECT_INVALID')
  await expectRejects(store.update('0000000000', { name: 'x' }), 'PROJECT_NOT_FOUND', /was not found/)
  assert.equal(store.get(project.id).name, 'City Hall', 'failed updates leave the record untouched')
})

await test('remove deletes and returns the record', async () => {
  const store = await newProjectStore()
  const a = await store.create({ name: 'A' })
  const b = await store.create({ name: 'B' })
  const removed = await store.remove(a.id)
  assert.equal(removed.id, a.id)
  assert.deepEqual(store.list().map((project) => project.id), [b.id])
  await expectRejects(store.remove(a.id), 'PROJECT_NOT_FOUND')
  const doc = JSON.parse(await fs.readFile(store.file, 'utf8'))
  assert.deepEqual(doc.projects.map((project) => project.id), [b.id])
})

await test('records persist across ProjectStore instances in creation order', async () => {
  const root = await tempDir()
  const store = await newProjectStore(root)
  const a = await store.create(sampleProject())
  const b = await store.create({ name: 'B' })
  const reloaded = await newProjectStore(root)
  assert.deepEqual(reloaded.list(), store.list())
  assert.deepEqual(reloaded.list().map((project) => project.id), [a.id, b.id])
})

await test('missing file starts empty; corrupt file is quarantined', async () => {
  const root = await tempDir()
  const empty = await newProjectStore(root)
  assert.deepEqual(empty.list(), [])
  await fs.writeFile(path.join(root, 'projects.json'), '{ not json')
  const store = await newProjectStore(root)
  assert.deepEqual(store.list(), [])
  const files = await fs.readdir(root)
  assert.ok(files.some((name) => /^projects\.json\.corrupt-\d+$/.test(name)), files.join(','))
  assert.ok(!files.includes('projects.json'))
  await store.create({ name: 'fresh' })
  // Wrong shape is quarantined too, and the store still starts empty.
  await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ projects: 'nope' }))
  const again = await newProjectStore(root)
  assert.deepEqual(again.list(), [])
  await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify([]))
  const arrayDoc = await newProjectStore(root)
  assert.deepEqual(arrayDoc.list(), [])
})

await test('invalid persisted projects are dropped, ids regenerated', async () => {
  const root = await tempDir()
  await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({
    statusVersion: 1,
    projects: [
      { id: 'aaaaaaaaaa', name: 'Good', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'bbbbbbbbbb', name: '' },
      'garbage',
      { id: 'aaaaaaaaaa', name: 'Dup id' },
    ],
  }))
  const store = await newProjectStore(root)
  const list = store.list()
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'aaaaaaaaaa')
  assert.equal(list[0].createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(list[0].emoji, '📁')
  assert.equal(list[1].name, 'Dup id')
  assert.match(list[1].id, /^[0-9a-f]{10}$/)
  assert.notEqual(list[1].id, 'aaaaaaaaaa')
})

await test('concurrent writes do not lose updates and leave no temp files', async () => {
  const root = await tempDir()
  const store = await newProjectStore(root)
  const first = await store.create({ name: 'A' })
  const others = await Promise.all(Array.from({ length: 5 }, (_, i) => store.create({ name: `P${i}` })))
  await Promise.all([
    store.update(first.id, { description: 'desc' }),
    store.update(first.id, { emoji: '🚀' }),
    store.update(first.id, { color: '#ff0000' }),
    ...others.map((project, i) => store.update(project.id, { description: `d${i}` })),
  ])
  const reloaded = await newProjectStore(root)
  const got = reloaded.get(first.id)
  assert.equal(got.description, 'desc')
  assert.equal(got.emoji, '🚀')
  assert.equal(got.color, '#ff0000')
  others.forEach((project, i) => assert.equal(reloaded.get(project.id).description, `d${i}`))
  const leftovers = (await fs.readdir(root)).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
})

await test('store enforces the 100 project limit', async () => {
  const root = await tempDir()
  const projects = Array.from({ length: 100 }, (_, i) => ({ id: i.toString(16).padStart(10, '0'), name: `P${i}` }))
  await fs.writeFile(path.join(root, 'projects.json'), JSON.stringify({ statusVersion: 1, projects }))
  const store = await newProjectStore(root)
  assert.equal(store.list().length, 100)
  await expectRejects(store.create({ name: 'one too many' }), 'PROJECT_LIMIT')
  await store.remove(store.list()[0].id)
  await store.create({ name: 'fits again' })
  assert.equal(store.list().length, 100)
})

await test('constructor rejects a relative botsRoot', () => {
  assert.throws(() => new ProjectStore({ botsRoot: 'relative/dir' }), TypeError)
  assert.throws(() => new ProjectStore({}), TypeError)
})

// ---------------------------------------------------------------------------
// Project routes
// ---------------------------------------------------------------------------

async function setupProjectRoutes({ teams } = {}) {
  const projects = await newProjectStore()
  const teamStore = teams ?? (await newTeamStore())
  const { ctx, routes, call } = fakeConnection()
  const logs = []
  const dispose = registerProjectRoutes(ctx, {
    projects,
    teams: teamStore,
    ready: Promise.resolve(),
    log: (message) => logs.push(message),
  })
  return { projects, teams: teamStore, routes, call, logs, dispose }
}

await test('project routes register exact paths and the disposer removes them', async () => {
  const app = await setupProjectRoutes()
  assert.deepEqual([...app.routes.keys()].sort(), [
    '/api/bots.projects',
    '/api/bots.projects.create',
    '/api/bots.projects.delete',
    '/api/bots.projects.update',
  ])
  for (const route of app.routes.values()) assert.equal(route.requestBody, 'buffered')
  assert.deepEqual(app.routes.get('/api/bots.projects').methods, ['GET'])
  assert.deepEqual(app.routes.get('/api/bots.projects.create').methods, ['POST'])
  assert.deepEqual(app.routes.get('/api/bots.projects.update').methods, ['POST'])
  assert.deepEqual(app.routes.get('/api/bots.projects.delete').methods, ['POST'])
  app.dispose()
  assert.equal(app.routes.size, 0)
})

await test('project routes CRUD flow', async () => {
  const app = await setupProjectRoutes()
  assert.deepEqual(await app.call('/api/bots.projects'), { ok: true, projects: [] })

  const created = await app.call('/api/bots.projects.create', {
    project: {
      ...sampleProject(),
      id: 'ffffffffff',
      createdAt: '2000-01-01T00:00:00.000Z',
      updatedAt: 'x',
      extra: 'ignored',
    },
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.notEqual(created.project.id, 'ffffffffff')
  assert.notEqual(created.project.createdAt, '2000-01-01T00:00:00.000Z')
  assert.equal('extra' in created.project, false)
  const id = created.project.id

  const listed = await app.call('/api/bots.projects')
  assert.deepEqual(listed.projects.map((project) => project.id), [id])

  const updated = await app.call('/api/bots.projects.update', {
    id,
    patch: { name: 'New', emoji: '🏗️', id: 'ffffffffff', createdAt: 'x', updatedAt: 'y', bogus: 1 },
  })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.equal(updated.project.name, 'New')
  assert.equal(updated.project.emoji, '🏗️')
  assert.equal(updated.project.id, id)
  const invalid = await app.call('/api/bots.projects.update', { id, patch: { name: '' } })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'PROJECT_INVALID')
  assert.match(invalid.error.message, /^name:/)

  const deleted = await app.call('/api/bots.projects.delete', { id })
  assert.deepEqual(deleted, { ok: true, deleted: true, id, detachedTeams: 0 })
  assert.equal((await app.call('/api/bots.projects.delete', { id })).error.code, 'PROJECT_NOT_FOUND')
  assert.equal((await app.call('/api/bots.projects.update', { id, patch: { name: 'x' } })).error.code, 'PROJECT_NOT_FOUND')
})

await test('project routes reject malformed bodies with BAD_REQUEST', async () => {
  const app = await setupProjectRoutes()
  for (const routePath of ['/api/bots.projects.create', '/api/bots.projects.update', '/api/bots.projects.delete']) {
    const payload = await app.call(routePath, undefined, '{ broken')
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'BAD_REQUEST', routePath)
  }
  assert.equal((await app.call('/api/bots.projects.create', {})).error.code, 'BAD_REQUEST')
  assert.equal((await app.call('/api/bots.projects.create', [1])).error.code, 'BAD_REQUEST')
  assert.equal((await app.call('/api/bots.projects.create', { project: 'x' })).error.code, 'BAD_REQUEST')
  assert.equal((await app.call('/api/bots.projects.update', { id: 'abc' })).error.code, 'BAD_REQUEST')
  assert.equal((await app.call('/api/bots.projects.update', { patch: {} })).error.code, 'BAD_REQUEST')
  assert.equal((await app.call('/api/bots.projects.delete', {})).error.code, 'BAD_REQUEST')
  const invalid = await app.call('/api/bots.projects.create', { project: { name: '   ' } })
  assert.equal(invalid.error.code, 'PROJECT_INVALID')
})

await test('delete detaches the project from every team and reports detachedTeams', async () => {
  const app = await setupProjectRoutes()
  const p1 = (await app.call('/api/bots.projects.create', { project: { name: 'DSC' } })).project
  const p2 = (await app.call('/api/bots.projects.create', { project: { name: 'City Hall' } })).project
  const single = await app.teams.create({ name: 'Single', projectIds: [p1.id] })
  const shared = await app.teams.create({ name: 'Shared', shared: true, projectIds: [p1.id, p2.id] })
  const unrelated = await app.teams.create({ name: 'Unrelated' })
  const unrelatedShared = await app.teams.create({ name: 'Other', shared: true, projectIds: [p2.id] })

  const payload = await app.call('/api/bots.projects.delete', { id: p1.id })
  assert.deepEqual(payload, { ok: true, deleted: true, id: p1.id, detachedTeams: 2 })
  assert.equal(app.projects.get(p1.id), undefined)
  assert.deepEqual(app.teams.get(single.id).projectIds, [])
  assert.deepEqual(app.teams.get(shared.id).projectIds, [p2.id])
  assert.equal(app.teams.get(shared.id).shared, true)
  assert.deepEqual(app.teams.get(unrelated.id).projectIds, [])
  assert.deepEqual(app.teams.get(unrelatedShared.id).projectIds, [p2.id])
  assert.equal(app.teams.list().length, 4, 'teams are detached, never deleted')
  const list = await app.call('/api/bots.projects')
  assert.deepEqual(list.projects.map((project) => project.id), [p2.id])
})

await test('a failed team detach keeps the project so a retry can finish', async () => {
  const projects = await newProjectStore()
  const project = await projects.create({ name: 'DSC' })
  const { ctx, routes, call } = fakeConnection()
  const attempts = []
  const failingTeams = {
    list: () => [{ id: 'aaaaaaaaaa', projectIds: [project.id] }],
    async update(id, patch) {
      attempts.push({ id, patch })
      throw Object.assign(new Error('team store busy'), { code: 'TEAM_INVALID' })
    },
  }
  registerProjectRoutes(ctx, { projects, teams: failingTeams, ready: Promise.resolve() })
  const payload = await call('/api/bots.projects.delete', { id: project.id })
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'TEAM_INVALID')
  assert.match(payload.error.message, /team store busy/)
  assert.equal(attempts.length, 1)
  assert.deepEqual(attempts[0].patch, { projectIds: [] })
  assert.ok(projects.get(project.id), 'the project is not removed when a detach fails')
})

await test('unexpected project route errors become INTERNAL and are logged', async () => {
  const { ctx, routes, call } = fakeConnection()
  const logs = []
  const projects = {
    list() {
      throw new Error('boom')
    },
    get: () => undefined,
    create: async () => ({}),
    update: async () => ({}),
    remove: async () => ({}),
  }
  registerProjectRoutes(ctx, { projects, teams: { list: () => [] }, ready: Promise.resolve(), log: (m) => logs.push(m) })
  const payload = await call('/api/bots.projects')
  assert.deepEqual(payload, { ok: false, error: { code: 'INTERNAL', message: 'Internal server error' } })
  assert.ok(logs.some((message) => message.includes('boom')))
  assert.equal(routes.size, 4)
})

await test('project handlers wait for deps.ready', async () => {
  const projects = await newProjectStore()
  const teams = await newTeamStore()
  const { ctx, routes, call } = fakeConnection()
  let release
  const ready = new Promise((resolve) => {
    release = resolve
  })
  registerProjectRoutes(ctx, { projects, teams, ready })
  let settled = false
  const pending = call('/api/bots.projects').then((payload) => {
    settled = true
    return payload
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false)
  release()
  assert.deepEqual(await pending, { ok: true, projects: [] })
})

await test('registerProjectRoutes requires the connection registry and both stores', async () => {
  const projects = await newProjectStore()
  const teams = await newTeamStore()
  assert.throws(() => registerProjectRoutes({}, { projects, teams, ready: Promise.resolve() }), TypeError)
  assert.throws(() => registerProjectRoutes({ connection: { fetch: { register() {} } } }, { teams, ready: Promise.resolve() }), TypeError)
  assert.throws(() => registerProjectRoutes({ connection: { fetch: { register() {} } } }, { projects, ready: Promise.resolve() }), TypeError)
})

// ---------------------------------------------------------------------------
// Team shared/projectIds rules
// ---------------------------------------------------------------------------

const P1 = '1111111111'
const P2 = '2222222222'
const projectIds = (count) => Array.from({ length: count }, (_, i) => i.toString(16).padStart(10, '0'))

await test('normalizeTeam defaults project fields (backward compatible)', () => {
  const team = normalizeTeam({ name: 'A' })
  assert.equal(team.shared, false)
  assert.deepEqual(team.projectIds, [])
  assert.equal(normalizeTeam({ name: 'A', projectIds: [] }).shared, false)
  // Only a real boolean true makes a team shared.
  assert.equal(normalizeTeam({ name: 'A', shared: 'true' }).shared, false)
  assert.equal(normalizeTeam({ name: 'A', shared: 1 }).shared, false)
})

await test('normalizeTeam validates projectIds syntax, limit and dedupe', () => {
  assert.deepEqual(normalizeTeam({ name: 'A', shared: true, projectIds: [P2, P1, P2] }).projectIds, [P2, P1])
  expectTeamInvalid(() => normalizeTeam({ name: 'A', projectIds: ['zzzzzzzzzz'] }), /^projectIds\[0\]: must be a project id/)
  expectTeamInvalid(() => normalizeTeam({ name: 'A', projectIds: [42] }), /^projectIds\[0\]:/)
  expectTeamInvalid(() => normalizeTeam({ name: 'A', projectIds: 'nope' }), /^projectIds: must be an array/)
  expectTeamInvalid(() => normalizeTeam({ name: 'A', shared: true, projectIds: projectIds(21) }), /^projectIds: must contain at most 20 entries/)
  assert.equal(normalizeTeam({ name: 'A', shared: true, projectIds: projectIds(20) }).projectIds.length, 20)
  // Partial mode normalizes present fields only.
  assert.deepEqual(normalizeTeam({ projectIds: [P1, P1] }, { partial: true }), { projectIds: [P1] })
  assert.deepEqual(normalizeTeam({ shared: true }, { partial: true }), { shared: true })
  expectTeamInvalid(() => normalizeTeam({ projectIds: ['bad'] }, { partial: true }), /^projectIds\[0\]:/)
})

await test('normalizeTeam enforces the non-shared single project rule on the full record', () => {
  expectTeamInvalid(
    () => normalizeTeam({ name: 'A', projectIds: [P1, P2] }),
    /^projectIds: a non-shared team can belong to only one project/,
  )
  assert.deepEqual(normalizeTeam({ name: 'A', projectIds: [P1] }).projectIds, [P1])
  assert.deepEqual(normalizeTeam({ name: 'A', shared: true, projectIds: [P1, P2] }).projectIds, [P1, P2])
  assert.equal(normalizeTeam({ name: 'A', projectIds: [P1] }).shared, false)
})

await test('TeamStore applies the merged shared/project rule and persists both fields', async () => {
  const root = await tempDir()
  const store = await newTeamStore(root)
  const shared = await store.create({ name: 'Shared', shared: true, projectIds: [P1, P2] })
  assert.equal(shared.shared, true)
  assert.deepEqual(shared.projectIds, [P1, P2])
  // Dropping the shared flag while two projects remain is rejected...
  await expectRejects(store.update(shared.id, { shared: false }), 'TEAM_INVALID', /^projectIds: a non-shared team can belong to only one project/)
  assert.equal(store.get(shared.id).shared, true, 'failed update leaves the record untouched')
  // ...but a matching patch succeeds and persists.
  const single = await store.update(shared.id, { shared: false, projectIds: [P2] })
  assert.equal(single.shared, false)
  assert.deepEqual(single.projectIds, [P2])
  await expectRejects(store.update(single.id, { projectIds: [P1, P2] }), 'TEAM_INVALID', /^projectIds:/)
  await expectRejects(store.create({ name: 'Bad', projectIds: ['zzzzzzzzzz'] }), 'TEAM_INVALID', /^projectIds\[0\]:/)
  const reloaded = await newTeamStore(root)
  const got = reloaded.get(shared.id)
  assert.equal(got.shared, false)
  assert.deepEqual(got.projectIds, [P2])
})

await test('v1/v2/v3 teams.json without project fields loads with defaults', async () => {
  const root = await tempDir()
  await fs.writeFile(path.join(root, 'teams.json'), JSON.stringify({
    statusVersion: 1,
    teams: [{ id: 'aaaaaaaaaa', name: 'Legacy', createdAt: '2026-01-01T00:00:00.000Z' }],
  }))
  const store = await newTeamStore(root)
  const legacy = store.get('aaaaaaaaaa')
  assert.equal(legacy.shared, false)
  assert.deepEqual(legacy.projectIds, [])
})

// ---------------------------------------------------------------------------
// Team routes validate project references
// ---------------------------------------------------------------------------

async function setupTeamRoutes(projects) {
  const teams = await newTeamStore()
  const bits = fakeBitStore()
  const { ctx, routes, call } = fakeConnection()
  const logs = []
  registerTeamRoutes(ctx, { teams, bits, projects, ready: Promise.resolve(), log: (message) => logs.push(message) })
  return { teams, routes, call, logs }
}

await test('team routes accept known project ids and reject unknown ones', async () => {
  const projects = await newProjectStore()
  const project = await projects.create({ name: 'DSC' })
  const app = await setupTeamRoutes(projects)

  const created = await app.call('/api/bots.teams.create', {
    team: { name: 'DSC', projectIds: [project.id] },
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.deepEqual(created.team.projectIds, [project.id])
  assert.equal(created.team.shared, false)

  const unknown = 'abcdef1234'
  const badCreate = await app.call('/api/bots.teams.create', { team: { name: 'X', projectIds: [unknown] } })
  assert.equal(badCreate.ok, false)
  assert.equal(badCreate.error.code, 'TEAM_INVALID')
  assert.equal(badCreate.error.message, `projectIds[0]: unknown project "${unknown}"`)

  const badUpdate = await app.call('/api/bots.teams.update', {
    id: created.team.id,
    patch: { projectIds: [project.id, unknown] },
  })
  assert.equal(badUpdate.ok, false)
  assert.equal(badUpdate.error.code, 'TEAM_INVALID')
  assert.equal(badUpdate.error.message, `projectIds[1]: unknown project "${unknown}"`)
  assert.deepEqual(app.teams.get(created.team.id).projectIds, [project.id], 'failed update leaves the team untouched')

  const detached = await app.call('/api/bots.teams.update', { id: created.team.id, patch: { projectIds: [] } })
  assert.equal(detached.ok, true, JSON.stringify(detached))
  assert.deepEqual(detached.team.projectIds, [])
})

await test('team routes reject a non-shared team with two projects', async () => {
  const projects = await newProjectStore()
  const p1 = await projects.create({ name: 'P1' })
  const p2 = await projects.create({ name: 'P2' })
  const app = await setupTeamRoutes(projects)
  const shared = await app.call('/api/bots.teams.create', { team: { name: 'Shared', shared: true, projectIds: [p1.id, p2.id] } })
  assert.equal(shared.ok, true, JSON.stringify(shared))
  const bad = await app.call('/api/bots.teams.update', { id: shared.team.id, patch: { shared: false } })
  assert.equal(bad.error.code, 'TEAM_INVALID')
  assert.match(bad.error.message, /^projectIds: a non-shared team can belong to only one project/)
})

await test('team routes skip the project check when no project store is available', async () => {
  const app = await setupTeamRoutes(undefined)
  const created = await app.call('/api/bots.teams.create', {
    team: { name: 'A', shared: true, projectIds: ['abcdef1234', '0123456789'] },
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.deepEqual(created.team.projectIds, ['abcdef1234', '0123456789'])
})

// ---------------------------------------------------------------------------
// Harness fromPack with a project
// ---------------------------------------------------------------------------

async function setupHarnessRoutes() {
  const botsRoot = await tempDir()
  const bits = fakeBitStore()
  const teams = new TeamStore({ botsRoot, bits })
  await teams.init()
  const projects = await newProjectStore(botsRoot)
  const catalog = { has: () => false, get: () => undefined }
  const packDir = path.join(botsRoot, 'harness', 'demo')
  await fs.mkdir(packDir, { recursive: true })
  await fs.writeFile(path.join(packDir, 'manifest.json'), JSON.stringify({
    format: 'dsh-bits-harness',
    id: 'demo',
    name: 'Demo',
    packDir,
    createdAt: '2026-01-01T00:00:00.000Z',
    agents: [
      { name: 'runner', description: 'Runs', model: '', effort: '', readOnly: false, launches: [], skills: [], instructions: 'Run.' },
    ],
    skills: [],
    instructions: [],
    mcp: {},
    patches: [],
    files: [],
    source: { dir: botsRoot, commit: null },
  }))
  const { ctx, routes, call } = fakeConnection()
  registerHarnessRoutes(ctx, { teams, bits, projects, catalog, ready: Promise.resolve(), botsRoot })
  return { botsRoot, bits, teams, projects, routes, call }
}

await test('teams.fromPack assigns the optional project and rejects unknown ones', async () => {
  const app = await setupHarnessRoutes()
  const project = await app.projects.create({ name: 'DSC' })

  const created = await app.call('/api/bots.teams.fromPack', { packId: 'demo', projectId: project.id })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.equal(created.bits.length, 2, 'lead bit + one bit per pack preset')
  assert.deepEqual(created.team.members.map((member) => member.bitId), created.bits.map((bit) => bit.id))
  assert.equal(created.team.harness, 'demo')
  assert.deepEqual(created.team.projectIds, [project.id])
  assert.equal(created.team.shared, false)

  const withoutProject = await app.call('/api/bots.teams.fromPack', { packId: 'demo' })
  assert.equal(withoutProject.ok, true, JSON.stringify(withoutProject))
  assert.deepEqual(withoutProject.team.projectIds, [])
  assert.equal(withoutProject.team.shared, false)

  const unknown = await app.call('/api/bots.teams.fromPack', { packId: 'demo', projectId: 'ffffffffff' })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'PROJECT_NOT_FOUND')
  assert.match(unknown.error.message, /Project "ffffffffff" was not found/)

  const missingPack = await app.call('/api/bots.teams.fromPack', { packId: 'nope', projectId: project.id })
  assert.equal(missingPack.error.code, 'HARNESS_NOT_FOUND')
})

// ---------------------------------------------------------------------------

for (const dir of tempRoots) await fs.rm(dir, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.log(`projects: ${failures.length} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`projects: ${passed} tests passed`)
