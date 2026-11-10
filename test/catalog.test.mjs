/**
 * Tests for the bit character catalog (schema v2): the shipped `bits/` assets,
 * the `character` defaults of the bit store, and the `/api/bots.catalog` +
 * `/api/bots.avatar` routes (real store in a temp dir, no runtime needed).
 *
 * Plain `node test/catalog.test.mjs`; Node built-ins only.
 */

import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadBitCatalog, normalizeCatalog, CATALOG_SCHEMA_VERSION } from '../host/catalog.js'
import { BitStore } from '../host/store.js'
import { registerBotRoutes } from '../host/routes.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BITS_DIR = path.join(ROOT, 'bits')
const CATALOG_FILE = path.join(BITS_DIR, 'catalog.json')

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bits-catalog-'))
  tempRoots.push(dir)
  return dir
}

/**
 * The exact defaults table from V5-CONTRACT.md §4. The shipped catalog must
 * match it bit by bit; implementers must not invent different defaults.
 */
const EXPECTED_DEFAULTS = Object.freeze({
  'bit-mascot': [false, 'subscription/sonnet', 'high'],
  'bit-manager': [true, 'deepseek-account/deepseek-flash', 'max'],
  'bit-product-owner': [true, 'deepseek-account/deepseek-flash', 'max'],
  'bit-coordinator': [true, 'deepseek-account/deepseek-flash', 'max'],
  'bit-sub-coordinator': [true, 'deepseek-account/deepseek-flash', 'max'],
  'bit-systems-analyst': [false, 'subscription/opus', 'high'],
  'bit-product-analyst': [false, 'subscription/sonnet', 'medium'],
  'bit-user-researcher': [false, 'subscription/sonnet', 'medium'],
  'bit-scout': [false, 'subscription/haiku', 'low'],
  'bit-researcher': [false, 'subscription/sonnet', 'medium'],
  'bit-architect': [false, 'subscription/opus', 'xhigh'],
  'bit-builder': [false, 'subscription/sonnet', 'high'],
  'bit-runner': [false, 'subscription/haiku', 'low'],
  'bit-reviewer': [false, 'subscription/opus', 'high'],
  'bit-debugger': [false, 'subscription/opus', 'xhigh'],
  'bit-ci-triager': [false, 'subscription/sonnet', 'medium'],
  'bit-writer': [false, 'subscription/sonnet', 'medium'],
  'bit-qa': [false, 'subscription/sonnet', 'high'],
  'bit-web-tester': [false, 'subscription/sonnet', 'high'],
  'bit-android-tester': [false, 'subscription/sonnet', 'high'],
  'bit-ios-tester': [false, 'subscription/sonnet', 'high'],
  'bit-frontend-engineer': [false, 'subscription/sonnet', 'high'],
  'bit-backend-engineer': [false, 'subscription/sonnet', 'high'],
  'bit-android-engineer': [false, 'subscription/sonnet', 'high'],
  'bit-ios-engineer': [false, 'subscription/sonnet', 'high'],
  'bit-flutter-engineer': [false, 'subscription/sonnet', 'high'],
  'bit-react-native-engineer': [false, 'subscription/sonnet', 'high'],
  'bit-cloud-engineer': [false, 'subscription/sonnet', 'high'],
  'bit-sre': [false, 'subscription/opus', 'high'],
  'bit-deployer': [false, 'subscription/sonnet', 'medium'],
  'bit-integration-engineer': [false, 'subscription/sonnet', 'high'],
  'bit-performance-engineer': [false, 'subscription/opus', 'high'],
  'bit-database-expert': [false, 'subscription/opus', 'high'],
  'bit-data-engineer': [false, 'subscription/sonnet', 'high'],
  'bit-data-scientist': [false, 'subscription/opus', 'high'],
  'bit-llm-expert': [false, 'subscription/opus', 'high'],
  'bit-cybersecurity-expert': [false, 'subscription/opus', 'xhigh'],
  'bit-ux-designer': [false, 'subscription/sonnet', 'medium'],
  'bit-ui-designer': [false, 'subscription/sonnet', 'medium'],
  'bit-design-system-expert': [false, 'subscription/sonnet', 'high'],
  'bit-accessibility-expert': [false, 'subscription/sonnet', 'medium'],
  'bit-growth-marketer': [false, 'subscription/sonnet', 'medium'],
  'bit-seo-expert': [false, 'subscription/sonnet', 'medium'],
  'bit-copywriter': [false, 'subscription/sonnet', 'medium'],
  'bit-i18n': [false, 'subscription/haiku', 'low'],
  'bit-crm-specialist': [false, 'subscription/haiku', 'low'],
  'bit-sales': [false, 'subscription/sonnet', 'medium'],
  'bit-sales-assistant': [false, 'subscription/haiku', 'low'],
  'bit-customer-success': [false, 'subscription/sonnet', 'medium'],
  'bit-support': [false, 'subscription/haiku', 'low'],
  'bit-finance-analyst': [false, 'subscription/sonnet', 'medium'],
  'bit-privacy-compliance': [false, 'subscription/opus', 'high'],
})

/** Every key one catalog bit is allowed to have (schema v2). */
const BIT_KEYS = Object.freeze([
  'id',
  'name',
  'group',
  'emoji',
  'color',
  'summary',
  'instructions',
  'isOrchestrator',
  'model',
  'effort',
])

const catalog = loadBitCatalog(BITS_DIR)
const rawCatalog = JSON.parse(await fs.readFile(CATALOG_FILE, 'utf8'))

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Set up the bot routes on a fake fetch registry, backed by a real BitStore.
 *
 * @param {Record<string, any> | undefined} catalogDependency
 * @returns {Promise<{ store: BitStore, routes: Map<string, any>, call: Function, logs: string[] }>}
 */
async function setupRoutes(catalogDependency) {
  const store = new BitStore({ botsRoot: await tempDir(), catalog: catalogDependency })
  await store.init()
  const routes = new Map()
  const ctx = {
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }
  const logs = []
  registerBotRoutes(ctx, {
    bits: store,
    catalog: catalogDependency,
    ready: Promise.resolve(),
    log: (message) => logs.push(message),
  })
  async function call(routePath, body) {
    const request = new Request(`http://127.0.0.1:1${routePath}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return routes.get(routePath.split('?')[0]).fetch(request)
  }
  return { store, routes, call, logs }
}

// ---------------------------------------------------------------------------
// Shipped assets
// ---------------------------------------------------------------------------

await test('shipped catalog is schema v2 with 52 bits in 7 groups', async () => {
  assert.equal(catalog.error, null)
  assert.equal(catalog.version, 2)
  assert.equal(CATALOG_SCHEMA_VERSION, 2)
  assert.equal(catalog.groups.length, 7)
  assert.equal(catalog.bits.length, 52)
  assert.equal(Object.keys(EXPECTED_DEFAULTS).length, 52)
  assert.equal(rawCatalog.version, 2)
  assert.equal(rawCatalog.bits.length, 52)

  const groupIds = new Set(catalog.groups.map((group) => group.id))
  assert.equal(groupIds.size, 7)
  for (const group of catalog.groups) {
    assert.notEqual(group.label.en, '')
  }
  const seen = new Set()
  for (const bit of catalog.bits) {
    assert.match(bit.id, /^bit-[a-z0-9-]+$/, bit.id)
    assert.ok(!seen.has(bit.id), `duplicate bit ${bit.id}`)
    seen.add(bit.id)
    assert.ok(groupIds.has(bit.group), `${bit.id} group`)
    assert.match(bit.color, /^#[0-9a-f]{6}$/, `${bit.id} color`)
    assert.ok(bit.summary.en, `${bit.id} summaries`)
    assert.ok(bit.instructions.length > 100 && bit.instructions.length <= 1500, `${bit.id} instructions length`)
    assert.match(bit.instructions, /Report back with /, `${bit.id} report line`)
    assert.ok(!bit.instructions.includes('Portuguese'), `${bit.id} has no language mention`)
  }
  for (const id of ['bit-mascot', 'bit-scout', 'bit-product-owner', 'bit-android-engineer', 'bit-crm-specialist', 'bit-user-researcher']) {
    assert.ok(catalog.has(id), id)
  }
})

await test('every bit matches the exact §4 defaults table and keeps only v2 keys', async () => {
  for (const bit of catalog.bits) {
    const expected = EXPECTED_DEFAULTS[bit.id]
    assert.ok(expected !== undefined, `${bit.id} is in the contract table`)
    assert.equal(bit.isOrchestrator, expected[0], `${bit.id} isOrchestrator`)
    assert.equal(bit.model, expected[1], `${bit.id} model`)
    assert.equal(bit.effort, expected[2], `${bit.id} effort`)
    assert.equal(typeof bit.isOrchestrator, 'boolean', `${bit.id} isOrchestrator type`)
    assert.equal(typeof bit.model, 'string', `${bit.id} model type`)
    assert.equal(typeof bit.effort, 'string', `${bit.id} effort type`)
  }
  const rawById = new Map(rawCatalog.bits.map((bit) => [bit.id, bit]))
  for (const bit of catalog.bits) {
    const raw = rawById.get(bit.id)
    assert.ok(raw, `${bit.id} exists in the shipped JSON`)
    assert.deepEqual(Object.keys(raw), [...BIT_KEYS], `${bit.id} raw keys`)
    assert.equal(raw.isOrchestrator, EXPECTED_DEFAULTS[bit.id][0])
    assert.equal(raw.model, EXPECTED_DEFAULTS[bit.id][1])
    assert.equal(raw.effort, EXPECTED_DEFAULTS[bit.id][2])
  }
})

await test('instructions and summaries are kept exactly as shipped (catalog.js is a passthrough)', async () => {
  const rawById = new Map(rawCatalog.bits.map((bit) => [bit.id, bit]))
  for (const bit of catalog.bits) {
    const raw = rawById.get(bit.id)
    assert.equal(bit.instructions, raw.instructions, `${bit.id} instructions unchanged`)
    assert.deepEqual(bit.summary, raw.summary, `${bit.id} summary unchanged`)
    assert.equal(bit.name, raw.name, `${bit.id} name unchanged`)
    assert.equal(bit.emoji, raw.emoji, `${bit.id} emoji unchanged`)
    assert.equal(bit.color, raw.color, `${bit.id} color unchanged`)
    assert.equal(bit.group, raw.group, `${bit.id} group unchanged`)
  }
})

await test('exactly four orchestrators, all on the DeepSeek route with max effort', async () => {
  const orchestrators = catalog.bits.filter((bit) => bit.isOrchestrator === true)
  assert.deepEqual(
    orchestrators.map((bit) => bit.id).sort(),
    ['bit-coordinator', 'bit-manager', 'bit-product-owner', 'bit-sub-coordinator'],
  )
  for (const bit of orchestrators) {
    assert.equal(bit.model, 'deepseek-account/deepseek-flash', `${bit.id} orchestrator route`)
    assert.equal(bit.effort, 'max', `${bit.id} orchestrator effort`)
  }
  for (const bit of catalog.bits.filter((bit) => !bit.isOrchestrator)) {
    assert.notEqual(bit.model, 'deepseek-account/deepseek-flash', `${bit.id} worker model family`)
  }
})

await test('every bit has a WebP avatar and no avatar is orphaned', async () => {
  const files = (await fs.readdir(path.join(BITS_DIR, 'avatars'))).sort()
  assert.deepEqual(files, catalog.bits.map((bit) => `${bit.id}.webp`).sort())
  for (const file of files) {
    const size = statSync(path.join(BITS_DIR, 'avatars', file)).size
    assert.ok(size > 1000 && size < 200 * 1024, `${file} size ${size}`)
  }
})

await test('readAvatar returns WebP bytes, caches, and refuses non-catalog ids', async () => {
  const bytes = await catalog.readAvatar('bit-scout')
  assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF')
  assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP')
  assert.equal(await catalog.readAvatar('bit-scout'), bytes, 'cached buffer')
  for (const bad of ['../catalog', 'bit-nope', '', null, '../../index']) {
    await assert.rejects(catalog.readAvatar(bad), (error) => error.code === 'BIT_NOT_FOUND')
  }
})

await test('a missing catalog degrades to an empty catalog with an error', async () => {
  const empty = loadBitCatalog(await tempDir())
  assert.equal(empty.bits.length, 0)
  assert.ok(typeof empty.error === 'string' && empty.error.length > 0)
  assert.equal(empty.has('bit-scout'), false)
  assert.equal(empty.get('bit-scout'), undefined)
  assert.equal(empty.has(42), false)
})

await test('normalizeCatalog drops malformed rows and duplicates', async () => {
  const result = normalizeCatalog({
    version: 2,
    groups: [{ id: 'g', label: { en: 'G' } }, { id: 'g' }, { id: 'Bad Id' }],
    bits: [
      { id: 'bit-a', name: 'A', group: 'g', color: '#ABCDEF' },
      { id: 'bit-a', name: 'dup' },
      { id: '../x', name: 'X' },
      { id: 'bit-b', name: '   ' },
      { id: 'bit-c', name: 'C', group: 'missing', emoji: 'way too long emoji' },
    ],
  })
  assert.equal(result.version, 2)
  assert.deepEqual(result.groups, [{ id: 'g', label: { en: 'G' } }])
  assert.deepEqual(result.bits.map((bit) => bit.id), ['bit-a', 'bit-c'])
  assert.equal(result.bits[0].color, '#abcdef')
  assert.equal(result.bits[1].group, null)
  assert.equal(result.bits[1].emoji, '🤖')
})

await test('normalizeCatalog fills schema v2 defaults for old (v1) rows', async () => {
  const result = normalizeCatalog({
    version: 1,
    groups: [{ id: 'general', label: { en: 'General' } }],
    bits: [
      { id: 'bit-old', name: 'Old', group: 'general' },
      {
        id: 'bit-orch',
        name: 'Orch',
        group: 'general',
        isOrchestrator: true,
        model: '  deepseek-account/deepseek-flash  ',
        effort: ' max ',
      },
      { id: 'bit-bad', name: 'Bad', isOrchestrator: 'yes', model: 42, effort: 7 },
      { id: 'bit-blank', name: 'Blank', isOrchestrator: false, model: '   ', effort: '' },
    ],
  })
  assert.equal(result.version, 1)
  const byId = new Map(result.bits.map((bit) => [bit.id, bit]))
  assert.equal(byId.get('bit-old').isOrchestrator, false)
  assert.equal(byId.get('bit-old').model, 'subscription/sonnet')
  assert.equal(byId.get('bit-old').effort, 'high')
  assert.equal(byId.get('bit-orch').isOrchestrator, true)
  assert.equal(byId.get('bit-orch').model, 'deepseek-account/deepseek-flash', 'model is trimmed')
  assert.equal(byId.get('bit-orch').effort, 'max', 'effort is trimmed')
  assert.equal(byId.get('bit-bad').isOrchestrator, false, 'non-boolean isOrchestrator falls back')
  assert.equal(byId.get('bit-bad').model, 'subscription/sonnet', 'non-string model falls back')
  assert.equal(byId.get('bit-bad').effort, 'high', 'non-string effort falls back')
  assert.equal(byId.get('bit-blank').model, 'subscription/sonnet', 'blank model falls back')
  assert.equal(byId.get('bit-blank').effort, 'high', 'blank effort falls back')
})

// ---------------------------------------------------------------------------
// Store `character` field and catalog defaults
// ---------------------------------------------------------------------------

await test('store persists, patches, clears and reloads the character with its v5 defaults', async () => {
  const botsRoot = await tempDir()
  const store = new BitStore({ botsRoot, catalog })
  await store.init()
  const plain = await store.create({ name: 'Legacy' })
  assert.equal(plain.character, null)
  const scout = await store.create({ name: 'Scout', character: 'bit-scout' })
  assert.equal(scout.character, 'bit-scout')
  assert.equal(scout.isOrchestrator, false)
  assert.equal(scout.model, 'subscription/haiku')
  assert.equal(scout.effort, 'low')

  const manager = await store.create({ name: 'Manager', character: 'bit-manager' })
  assert.equal(manager.character, 'bit-manager')
  assert.equal(manager.isOrchestrator, true)
  assert.equal(manager.model, 'deepseek-account/deepseek-flash')
  assert.equal(manager.effort, 'max')

  const patched = await store.update(scout.id, { character: 'bit-reviewer' })
  assert.equal(patched.character, 'bit-reviewer')
  assert.equal(patched.model, 'subscription/haiku', 'a character patch keeps the explicit model')
  const untouched = await store.update(scout.id, { name: 'Renamed' })
  assert.equal(untouched.character, 'bit-reviewer', 'other patches keep the character')
  await assert.rejects(store.update(scout.id, { character: '../etc' }), (error) => error.code === 'BOT_INVALID_PATCH')
  await assert.rejects(store.create({ name: 'X', character: 42 }), (error) => error.code === 'BOT_INVALID_PATCH')
  const cleared = await store.update(scout.id, { character: null })
  assert.equal(cleared.character, null)
  await store.update(scout.id, { character: 'bit-builder' })

  const reloaded = new BitStore({ botsRoot, catalog })
  await reloaded.init()
  assert.equal(reloaded.get(scout.id).character, 'bit-builder')
  assert.equal(reloaded.get(plain.id).character, null)
  assert.equal(reloaded.get(manager.id).isOrchestrator, true)
  assert.equal(reloaded.get(manager.id).model, 'deepseek-account/deepseek-flash')
})

await test('a persisted record without or with a bad character loads as null', async () => {
  const botsRoot = await tempDir()
  await fs.writeFile(path.join(botsRoot, 'bits.json'), JSON.stringify({
    statusVersion: 2,
    bits: [
      { id: 'aaaaaaaaaa', name: 'Old', emoji: '🦊', color: '#123456', instructions: '' },
      { id: 'bbbbbbbbbb', name: 'Bad', character: 'Not Valid!' },
    ],
  }))
  const store = new BitStore({ botsRoot, catalog })
  await store.init()
  assert.equal(store.get('aaaaaaaaaa').character, null)
  assert.equal(store.get('aaaaaaaaaa').emoji, '🦊')
  assert.equal(store.get('aaaaaaaaaa').model, 'subscription/sonnet', 'unknown character uses worker defaults')
  assert.equal(store.get('bbbbbbbbbb').character, null)
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

await test('GET /api/bots.catalog returns groups and v2 bits with avatar URLs', async () => {
  const app = await setupRoutes(catalog)
  assert.equal(app.routes.has('/api/bots.catalog'), true)
  const response = await app.call('/api/bots.catalog')
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.version, 2)
  assert.equal(payload.groups.length, 7)
  assert.equal(payload.bits.length, 52)
  const scout = payload.bits.find((bit) => bit.id === 'bit-scout')
  assert.equal(scout.avatar, '/api/bots.avatar?id=bit-scout')
  assert.equal(scout.instructions, catalog.get('bit-scout').instructions)
  assert.equal(scout.isOrchestrator, false)
  assert.equal(scout.model, 'subscription/haiku')
  assert.equal(scout.effort, 'low')
  const coordinator = payload.bits.find((bit) => bit.id === 'bit-coordinator')
  assert.equal(coordinator.isOrchestrator, true)
  assert.equal(coordinator.model, 'deepseek-account/deepseek-flash')
  assert.equal(coordinator.effort, 'max')
  assert.equal(payload.error, null)
})

await test('GET /api/bots.avatar serves WebP and 404s unknown or traversal ids', async () => {
  const app = await setupRoutes(catalog)
  const ok = await app.call('/api/bots.avatar?id=bit-mascot')
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get('content-type'), 'image/webp')
  assert.match(ok.headers.get('cache-control'), /max-age/)
  const bytes = Buffer.from(await ok.arrayBuffer())
  assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP')
  for (const query of ['?id=bit-nope', '?id=..%2Fcatalog', '?id=', '']) {
    const missing = await app.call(`/api/bots.avatar${query}`)
    assert.equal(missing.status, 404, `404 for "${query}"`)
  }
})

await test('create/update accept catalog characters and reject unknown ones', async () => {
  const app = await setupRoutes(catalog)
  const bad = await (await app.call('/api/bots.create', { name: 'X', character: 'bit-unknown' })).json()
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'BOT_INVALID_CHARACTER')
  assert.equal(app.store.list().length, 0, 'nothing created')

  const created = await (await app.call('/api/bots.create', { name: 'Scout', character: 'bit-scout', emoji: '🔎', color: '#c88f36' })).json()
  assert.equal(created.ok, true)
  assert.equal(created.bit.character, 'bit-scout')
  assert.equal(created.bit.model, 'subscription/haiku', 'route create inherits the catalog defaults')
  assert.equal(created.bit.effort, 'low')

  const manager = await (await app.call('/api/bots.create', { name: 'Boss', character: 'bit-manager' })).json()
  assert.equal(manager.ok, true)
  assert.equal(manager.bit.isOrchestrator, true)
  assert.equal(manager.bit.model, 'deepseek-account/deepseek-flash')
  assert.equal(manager.bit.effort, 'max')

  // An orchestrator pinned to a subscription model is refused by the real store
  // (through the route) with the coded BOT_INVALID error.
  const badOrchestrator = await (await app.call('/api/bots.create', {
    name: 'Bad Orchestrator',
    isOrchestrator: true,
    model: 'subscription/opus',
  })).json()
  assert.equal(badOrchestrator.ok, false)
  assert.equal(badOrchestrator.error.code, 'BOT_INVALID')
  assert.match(badOrchestrator.error.message, /orchestrator bit needs a DSH chat route/)

  const badPatch = await (await app.call('/api/bots.update', { id: created.bit.id, patch: { character: 'bit-unknown' } })).json()
  assert.equal(badPatch.error.code, 'BOT_INVALID_CHARACTER')

  const patched = await (await app.call('/api/bots.update', { id: created.bit.id, patch: { character: 'bit-reviewer' } })).json()
  assert.equal(patched.bit.character, 'bit-reviewer')

  const cleared = await (await app.call('/api/bots.update', { id: created.bit.id, patch: { character: null } })).json()
  assert.equal(cleared.bit.character, null)

  const legacy = await (await app.call('/api/bots.create', { name: 'No bit' })).json()
  assert.equal(legacy.ok, true)
  assert.equal(legacy.bit.character, null)
  assert.equal(legacy.bit.isOrchestrator, false)
  assert.equal(legacy.bit.model, 'subscription/sonnet')
})

await test('routes without a catalog dependency degrade gracefully', async () => {
  const app = await setupRoutes(undefined)
  const payload = await (await app.call('/api/bots.catalog')).json()
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.bits, [])
  assert.equal(payload.version, 2)
  assert.equal((await app.call('/api/bots.avatar?id=bit-scout')).status, 404)

  const created = await (await app.call('/api/bots.create', { name: 'No catalog', character: 'bit-not-in-catalog' })).json()
  assert.equal(created.ok, true, 'the route lets the store validate a syntactically valid character')
})

await test('package.json ships the catalog and avatars', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('bits/catalog.json'))
  assert.ok(pkg.files.includes('bits/avatars/*.webp'))
  assert.ok(existsSync(path.join(ROOT, 'host', 'catalog.js')))
  assert.ok(existsSync(path.join(BITS_DIR, 'catalog.json')))
})

for (const dir of tempRoots) await fs.rm(dir, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.log(`catalog: ${failures.length} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`catalog: ${passed} tests passed`)
