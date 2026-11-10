/**
 * Bit mode orchestrating-bit selection (host/orchestrator-selection.js) and its
 * two HTTP operations on host/routes.js (`/api/bots.orchestrator`).
 *
 * Covers: the durable global preference (atomic 0600 orchestrator.json, corrupt
 * and unknown documents started empty, reloaded in a new instance), selecting an
 * existing bit by id/name, provisioning catalog orchestrator characters with
 * their catalog defaults, worker refusal, clearing, candidate order/dedupe/cap,
 * view shape/summary fallback, serialized selections, and the GET/POST route
 * envelope (including the route being absent without `deps.selection`).
 *
 * Plain `node test/orchestrator-selection.test.mjs`; only Node built-ins are
 * used. Routes are captured through a fake `ctx.connection.fetch.register` and
 * driven with real Fetch `Request`/`Response` objects.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BitStore } from '../host/store.js'
import { loadBitCatalog } from '../host/catalog.js'
import { createOrchestratorSelection } from '../host/orchestrator-selection.js'
import { registerBotRoutes } from '../host/routes.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG = loadBitCatalog(path.join(ROOT, 'bits'))
const ORCHESTRATOR_IDS = CATALOG.bits.filter((bit) => bit.isOrchestrator === true).map((bit) => bit.id)
const ORCHESTRATOR_MODEL = 'deepseek-account/deepseek-flash'
const ROUTE = '/api/bots.orchestrator'

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

/* ------------------------------ fixtures ------------------------------ */

/** Fresh bots root with an initialized bit store and an initialized selection. */
async function makeSelection(prefix = 'dsh-bits-selection-') {
  const botsRoot = await tempDir(prefix)
  const bits = new BitStore({ botsRoot, catalog: CATALOG })
  await bits.init()
  const selection = createOrchestratorSelection({ botsRoot, bits, catalog: CATALOG })
  await selection.init()
  return { botsRoot, bits, selection, file: path.join(botsRoot, 'orchestrator.json') }
}

/** @param {string} file @returns {Promise<Record<string, any>>} */
async function readSelectionFile(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

/**
 * Assert the complete candidate/view contract shape.
 *
 * @param {Record<string, any>} view
 * @param {{ id: string, isExisting: boolean }} expected
 */
function assertViewShape(view, { id, isExisting }) {
  for (const key of ['id', 'target', 'name', 'character', 'emoji', 'color', 'avatar', 'summary', 'model', 'effort', 'isExisting']) {
    assert.ok(key in view, `view has field "${key}"`)
  }
  assert.equal(view.id, id)
  assert.equal(view.target, id)
  assert.match(view.avatar, /^\/api\/bots\.avatar\?id=/)
  assert.equal(typeof view.name, 'string')
  assert.equal(typeof view.summary, 'string')
  assert.equal(typeof view.model, 'string')
  assert.equal(typeof view.effort, 'string')
  assert.equal(view.isExisting, isExisting)
}

/** Fake fetch registry: one exact route per path, like the DSH connection. */
function createRouteContext() {
  const routes = new Map()
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          assert.equal(typeof route.path, 'string')
          assert.ok(!routes.has(route.path), `duplicate route ${route.path}`)
          routes.set(route.path, route)
          return () => {
            routes.delete(route.path)
          }
        },
      },
    },
  }
  return { ctx, routes }
}

/** Fresh bots root + selection + registered Bit routes. */
async function setupRoutes() {
  const env = await makeSelection('dsh-bits-selection-routes-')
  const { ctx, routes } = createRouteContext()
  const dispose = registerBotRoutes(ctx, {
    bits: env.bits,
    catalog: CATALOG,
    ready: Promise.resolve(),
    selection: env.selection,
    log: () => {},
  })
  return { ...env, routes, dispose }
}

/**
 * Invoke one registered route and parse its JSON envelope.
 *
 * @param {Map<string, any>} routes
 * @param {string} routePath
 * @param {{ method?: string, body?: unknown }} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function callRoute(routes, routePath, { method = 'GET', body } = {}) {
  const route = routes.get(routePath)
  assert.ok(route, `route ${routePath} is registered`)
  const request = new Request(`http://127.0.0.1:46181${routePath}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const response = await route.fetch(request)
  assert.equal(response.status, 200, 'handler-level responses are always HTTP 200')
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
  return response.json()
}

/* --------------------------- selection store --------------------------- */

await test('an untouched bots root starts empty and advertises the catalog orchestrator characters', async () => {
  const env = await makeSelection()
  assert.equal(env.selection.currentBitId(), null)
  assert.equal(env.selection.currentBit(), null)
  assert.ok(env.selection.ready instanceof Promise)
  const candidates = env.selection.candidates()
  assert.deepEqual(candidates.map((candidate) => candidate.id), ORCHESTRATOR_IDS)
  for (const [index, candidate] of candidates.entries()) {
    const character = CATALOG.get(ORCHESTRATOR_IDS[index])
    assertViewShape(candidate, { id: character.id, isExisting: false })
    assert.equal(candidate.name, character.name)
    assert.equal(candidate.character, character.id)
    assert.equal(candidate.emoji, character.emoji)
    assert.equal(candidate.color, character.color)
    assert.equal(candidate.avatar, `/api/bots.avatar?id=${character.id}`)
    assert.equal(candidate.summary, character.summary.en)
    assert.equal(candidate.model, character.model)
    assert.equal(candidate.effort, character.effort)
    assert.equal(candidate.isExisting, false)
  }
  // Clearing when nothing is selected still persists the empty preference.
  assert.deepEqual(await env.selection.select(null), { bit: null, view: null })
  assert.deepEqual(await readSelectionFile(env.file), { version: 1, bitId: null })
})

await test('select by id/name persists an atomic 0600 document and reloads in a new instance', async () => {
  const env = await makeSelection()
  const appPo = await env.bits.create({
    name: 'App PO',
    character: 'bit-manager',
    isOrchestrator: true,
    model: ORCHESTRATOR_MODEL,
    effort: 'max',
  })
  const selected = await env.selection.select(appPo.id)
  assert.equal(selected.bit.id, appPo.id)
  assertViewShape(selected.view, { id: appPo.id, isExisting: true })
  assert.equal(selected.view.name, 'App PO')
  assert.equal(selected.view.character, 'bit-manager')
  assert.equal(selected.view.avatar, '/api/bots.avatar?id=bit-manager')
  assert.equal(selected.view.summary, CATALOG.get('bit-manager').summary.en)
  assert.equal(selected.view.model, ORCHESTRATOR_MODEL)
  assert.equal(selected.view.effort, 'max')
  assert.equal(env.selection.currentBitId(), appPo.id)
  assert.equal(env.selection.currentBit().id, appPo.id)
  assert.deepEqual(await readSelectionFile(env.file), { version: 1, bitId: appPo.id })
  const stat = await fs.stat(env.file)
  assert.equal(stat.mode & 0o777, 0o600, 'the preference document is mode 0600')

  // The same bit by case-insensitive trimmed name.
  const byName = await env.selection.select('  app po  ')
  assert.equal(byName.bit.id, appPo.id)

  // Persisted preference reloaded by a brand-new selection instance.
  const bits2 = new BitStore({ botsRoot: env.botsRoot, catalog: CATALOG })
  await bits2.init()
  const selection2 = createOrchestratorSelection({ botsRoot: env.botsRoot, bits: bits2, catalog: CATALOG })
  const ready = selection2.ready
  assert.equal(selection2.init(), ready, 'ready is the init() promise')
  await ready
  assert.equal(selection2.currentBitId(), appPo.id)
  assert.equal(selection2.currentBit().id, appPo.id)
})

await test('selecting a catalog orchestrator character provisions its bit with the catalog defaults', async () => {
  const env = await makeSelection()
  const character = CATALOG.get('bit-manager')
  const before = env.bits.list().length
  const selected = await env.selection.select('bit-manager')
  const created = env.bits.list().find((record) => record.character === 'bit-manager')
  assert.ok(created, 'the catalog character was provisioned through the bit store')
  assert.equal(env.bits.list().length, before + 1)
  assert.equal(created.name, character.name)
  assert.equal(created.instructions, character.instructions)
  assert.equal(created.isOrchestrator, true)
  assert.equal(created.model, character.model)
  assert.equal(created.effort, character.effort)
  assert.equal(selected.bit.id, created.id)
  assert.equal(selected.view.isExisting, true)
  assert.equal(env.selection.currentBitId(), created.id)
  assert.deepEqual(await readSelectionFile(env.file), { version: 1, bitId: created.id })

  // The provisioned bit is the first candidate and the catalog row is not duplicated.
  const candidates = env.selection.candidates()
  assert.equal(candidates[0].id, created.id)
  assert.equal(candidates[0].isExisting, true)
  assert.equal(candidates.filter((candidate) => candidate.character === 'bit-manager').length, 1)

  // Selecting the same character again (name or id) reuses the bit.
  await env.selection.select('Manager')
  await env.selection.select('bit-manager')
  assert.equal(env.bits.list().filter((record) => record.character === 'bit-manager').length, 1)
})

await test('worker targets are refused and unknown targets report the available candidates', async () => {
  const env = await makeSelection()
  const worker = await env.bits.create({
    name: 'Explicit Worker',
    character: null,
    instructions: 'A worker.',
    model: 'subscription/sonnet',
    effort: 'high',
  })
  const before = env.bits.list().length
  for (const target of [worker.id, 'explicit worker', 'Scout', 'bit-scout']) {
    await assert.rejects(
      env.selection.select(target),
      (error) => error.code === 'BIT_NOT_ORCHESTRATOR' && /Bit mode chats are orchestrated by orchestrator bits/.test(error.message),
      `target ${target}`,
    )
  }
  assert.equal(env.bits.list().length, before, 'a refused worker catalog character is never provisioned')
  assert.equal(env.selection.currentBitId(), null)
  await assert.rejects(
    env.selection.select('Definitely not a bit'),
    (error) => error.code === 'BIT_UNKNOWN' && /Available: /.test(error.message),
  )
  await assert.rejects(env.selection.select('   '), (error) => error.code === 'BIT_UNKNOWN')
  // The picker never lists worker bits or worker catalog characters.
  const candidates = env.selection.candidates()
  assert.equal(candidates.some((candidate) => candidate.id === worker.id), false)
  assert.equal(candidates.some((candidate) => candidate.id === 'bit-scout'), false)
})

await test('corrupt, unknown-version and malformed documents start empty', async () => {
  // Corrupt JSON: renamed aside (like the stores do) and the selection starts empty.
  const corrupt = await makeSelection()
  await fs.writeFile(corrupt.file, '{ not json', 'utf8')
  const corruptSelection = createOrchestratorSelection({ botsRoot: corrupt.botsRoot, bits: corrupt.bits, catalog: CATALOG })
  await corruptSelection.init()
  assert.equal(corruptSelection.currentBitId(), null)
  assert.deepEqual(corruptSelection.candidates().map((candidate) => candidate.id), ORCHESTRATOR_IDS)
  const entries = await fs.readdir(corrupt.botsRoot)
  assert.ok(
    entries.some((entry) => entry.startsWith('orchestrator.json.corrupt-')),
    'the corrupt document was renamed aside',
  )

  // Unsupported version / malformed bitId / non-object documents: empty, no crash.
  for (const document of [{ version: 99, bitId: 'abc' }, { version: 1, bitId: 42 }, { version: 1 }, [1, 2], 'text', null]) {
    const env = await makeSelection()
    await fs.writeFile(env.file, JSON.stringify(document), 'utf8')
    const selection = createOrchestratorSelection({ botsRoot: env.botsRoot, bits: env.bits, catalog: CATALOG })
    await selection.init()
    assert.equal(selection.currentBitId(), null, `document ${JSON.stringify(document)}`)
    assert.equal(selection.currentBit(), null)
  }
})

await test('a throwing logger cannot break init or selection', async () => {
  const env = await makeSelection()
  await fs.writeFile(env.file, '{ not json', 'utf8')
  const selection = createOrchestratorSelection({
    botsRoot: env.botsRoot,
    bits: env.bits,
    catalog: CATALOG,
    log: () => {
      throw new Error('logger exploded')
    },
  })
  await selection.init()
  assert.equal(selection.currentBitId(), null)
  assert.deepEqual(selection.candidates().map((candidate) => candidate.id), ORCHESTRATOR_IDS)
  const selected = await selection.select('Manager')
  assert.equal(selected.bit.character, 'bit-manager')
  assert.equal(selection.currentBitId(), selected.bit.id)
})

await test('candidates list existing orchestrator bits first, then catalog orchestrators, without duplicates', async () => {
  const env = await makeSelection()
  const first = await env.bits.create({
    name: 'First',
    character: null,
    isOrchestrator: true,
    model: ORCHESTRATOR_MODEL,
    effort: 'max',
  })
  const second = await env.bits.create({
    name: 'Second',
    character: 'bit-product-owner',
    isOrchestrator: true,
    model: ORCHESTRATOR_MODEL,
    effort: 'max',
  })
  const worker = await env.bits.create({ name: 'Worker', character: null, instructions: 'A worker.' })
  const third = await env.bits.create({
    name: 'My Coordinator',
    character: 'bit-coordinator',
    isOrchestrator: true,
    model: ORCHESTRATOR_MODEL,
    effort: 'max',
  })
  const ids = env.selection.candidates().map((candidate) => candidate.id)
  // Existing orchestrator bits in store order, then the remaining catalog
  // orchestrator characters in catalog order (Manager, Sub-coordinator).
  assert.deepEqual(ids, [first.id, second.id, third.id, 'bit-manager', 'bit-sub-coordinator'])
  assert.equal(ids.includes(worker.id), false, 'worker bits are not candidates')
  assert.equal(ids.includes('bit-scout'), false, 'worker catalog characters are not candidates')
  // Existing views first, catalog-only views last.
  const existingFlags = env.selection.candidates().map((candidate) => candidate.isExisting)
  assert.deepEqual(existingFlags, [true, true, true, false, false])
})

await test('the candidate list is capped at 50 entries', async () => {
  const env = await makeSelection()
  const created = []
  for (let index = 0; index < 55; index += 1) {
    created.push(
      await env.bits.create({
        name: `Orchestrator ${index}`,
        character: null,
        isOrchestrator: true,
        model: ORCHESTRATOR_MODEL,
        effort: 'max',
      }),
    )
  }
  const candidates = env.selection.candidates()
  assert.equal(candidates.length, 50)
  assert.deepEqual(candidates.map((candidate) => candidate.id), created.slice(0, 50).map((record) => record.id))
})

await test('viewFor summarizes a bit without catalog character from its instructions', async () => {
  const env = await makeSelection()
  const sentence = await env.bits.create({
    name: 'Sentence',
    character: null,
    instructions: 'First sentence here. Second one follows.',
    isOrchestrator: true,
    model: ORCHESTRATOR_MODEL,
    effort: 'max',
  })
  const view = env.selection.viewFor(sentence)
  assertViewShape(view, { id: sentence.id, isExisting: true })
  assert.equal(view.character, null)
  assert.equal(view.summary, 'First sentence here.')
  assert.equal(view.avatar, `/api/bots.avatar?id=${sentence.id}`)

  // A long instruction without sentence punctuation is capped around 160 chars.
  const long = await env.bits.create({
    name: 'Long',
    character: null,
    instructions: 'word '.repeat(80).trim(),
    isOrchestrator: true,
    model: ORCHESTRATOR_MODEL,
    effort: 'max',
  })
  const longView = env.selection.viewFor(long)
  assert.ok(longView.summary.length <= 160, `summary length ${longView.summary.length}`)
  assert.ok(longView.summary.endsWith('…'), 'truncated summaries end with an ellipsis')
})

await test('concurrent selections are serialized and the last one wins', async () => {
  const env = await makeSelection()
  const [first, second] = await Promise.all([env.selection.select('Manager'), env.selection.select('Coordinator')])
  assert.equal(first.bit.character, 'bit-manager')
  assert.equal(second.bit.character, 'bit-coordinator')
  assert.equal(env.selection.currentBitId(), second.bit.id)
  assert.deepEqual(await readSelectionFile(env.file), { version: 1, bitId: second.bit.id })
})

/* ------------------------------- routes -------------------------------- */

await test('the orchestrator route is registered only with a selection dependency', async () => {
  const env = await makeSelection()
  // Without deps.selection the eight contracted routes stay unchanged.
  const without = createRouteContext()
  const disposeWithout = registerBotRoutes(without.ctx, { bits: env.bits, catalog: CATALOG, ready: Promise.resolve() })
  assert.equal(without.routes.size, 8)
  assert.equal(without.routes.has(ROUTE), false)
  disposeWithout()
  assert.equal(without.routes.size, 0)
  // With deps.selection the read/select operations share the exact route path.
  const withSelection = createRouteContext()
  const disposeWith = registerBotRoutes(withSelection.ctx, {
    bits: env.bits,
    catalog: CATALOG,
    ready: Promise.resolve(),
    selection: env.selection,
  })
  assert.equal(withSelection.routes.size, 9)
  const route = withSelection.routes.get(ROUTE)
  assert.deepEqual(route.methods, ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
  disposeWith()
  assert.equal(withSelection.routes.size, 0)
})

await test('GET reports the selection and POST selects/clears through the envelope', async () => {
  const app = await setupRoutes()
  try {
    const empty = await callRoute(app.routes, ROUTE)
    assert.equal(empty.ok, true)
    assert.equal(empty.bitId, null)
    assert.equal(empty.bit, null)
    assert.deepEqual(empty.candidates.map((candidate) => candidate.id), ORCHESTRATOR_IDS)

    const picked = await callRoute(app.routes, ROUTE, { method: 'POST', body: { target: 'bit-manager' } })
    const created = app.bits.list().find((record) => record.character === 'bit-manager')
    assert.ok(created, 'POST provisioned the catalog character')
    assert.equal(picked.ok, true)
    assert.equal(picked.bitId, created.id)
    assertViewShape(picked.bit, { id: created.id, isExisting: true })
    assert.equal(picked.bit.name, CATALOG.get('bit-manager').name)
    assert.equal(picked.candidates[0].id, created.id)

    // GET reflects the persisted choice.
    const current = await callRoute(app.routes, ROUTE)
    assert.equal(current.bitId, created.id)
    assert.equal(current.bit.id, created.id)

    // Selecting the same bit with a padded name keeps the selection.
    const named = await callRoute(app.routes, ROUTE, { method: 'POST', body: { target: ' manager ' } })
    assert.equal(named.bitId, created.id)

    // Clears: `target: null` and an omitted target.
    const cleared = await callRoute(app.routes, ROUTE, { method: 'POST', body: { target: null } })
    assert.equal(cleared.ok, true)
    assert.equal(cleared.bitId, null)
    assert.equal(cleared.bit, null)
    assert.deepEqual((await callRoute(app.routes, ROUTE)).bitId, null)
    const omitted = await callRoute(app.routes, ROUTE, { method: 'POST', body: {} })
    assert.equal(omitted.bitId, null)
  } finally {
    app.dispose()
  }
})

await test('POST passes coded failures through and validates its body', async () => {
  const app = await setupRoutes()
  try {
    const unknown = await callRoute(app.routes, ROUTE, { method: 'POST', body: { target: 'Nope' } })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'BIT_UNKNOWN')
    assert.match(unknown.error.message, /Available: /)

    const worker = await app.bits.create({
      name: 'Route Worker',
      character: null,
      instructions: 'A worker.',
      model: 'subscription/sonnet',
      effort: 'high',
    })
    const refused = await callRoute(app.routes, ROUTE, { method: 'POST', body: { target: worker.id } })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'BIT_NOT_ORCHESTRATOR')

    for (const body of [undefined, '{ broken', '[]', '"text"', { target: 42 }, { target: '' }, { target: '   ' }]) {
      const payload = await callRoute(app.routes, ROUTE, { method: 'POST', body })
      assert.equal(payload.ok, false, `body ${JSON.stringify(body)}`)
      assert.equal(payload.error.code, 'BAD_REQUEST', `body ${JSON.stringify(body)}`)
    }
    assert.equal(app.selection.currentBitId(), null, 'invalid requests never change the selection')
  } finally {
    app.dispose()
  }
})

await test('a failed selection init surfaces as ORCHESTRATOR_UNAVAILABLE', async () => {
  const env = await makeSelection()
  const { ctx, routes } = createRouteContext()
  let rejectReady
  const ready = new Promise((_resolve, reject) => {
    rejectReady = reject
  })
  const selection = {
    ready,
    currentBitId: () => null,
    currentBit: () => null,
    candidates: () => [],
    viewFor: () => null,
    select: async () => ({ bit: null, view: null }),
  }
  const dispose = registerBotRoutes(ctx, { bits: env.bits, catalog: CATALOG, ready: Promise.resolve(), selection, log: () => {} })
  try {
    const pendingGet = callRoute(routes, ROUTE)
    rejectReady(new Error('selection init failed'))
    const payload = await pendingGet
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'ORCHESTRATOR_UNAVAILABLE')
    assert.match(payload.error.message, /selection init failed/)

    const posted = await callRoute(routes, ROUTE, { method: 'POST', body: { target: 'Manager' } })
    assert.equal(posted.error.code, 'ORCHESTRATOR_UNAVAILABLE')
  } finally {
    dispose()
  }
})

/* ------------------------------- summary ------------------------------- */

for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\norchestrator-selection: ${failures.length} failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\norchestrator-selection: ${passed} tests passed`)
}
