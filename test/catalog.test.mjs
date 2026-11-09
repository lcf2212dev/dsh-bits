/**
 * Tests for the bit character catalog: the shipped `bits/` assets, the
 * `character` field of the store, and the `/api/bots.catalog` +
 * `/api/bots.avatar` routes (real store in a temp dir, fake VM).
 *
 * Plain `node test/catalog.test.mjs`; Node built-ins only.
 */

import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadBitCatalog, normalizeCatalog } from '../host/catalog.js'
import { BotStore } from '../host/store.js'
import { registerBotRoutes } from '../host/routes.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BITS_DIR = path.join(ROOT, 'bits')

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

const fakeVm = {
  defaultImage: 'ubuntu:24.04',
  async available() { return { available: true, version: 'test', error: null } },
  async status(record) {
    return { id: record.id, containerName: `dsh-bot-${record.id}`, enabled: record.vm.enabled, state: 'missing', running: false, image: record.vm.image, startedAt: null, exitCode: null, detail: null, error: null }
  },
  async listImages() { return [] },
  async remove() {},
}

async function setupRoutes(catalog) {
  const store = new BotStore({ botsRoot: await tempDir() })
  await store.init()
  const routes = new Map()
  const ctx = { connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } } } }
  const logs = []
  registerBotRoutes(ctx, {
    store,
    vm: fakeVm,
    ready: Promise.resolve(),
    ensureWorkspaceId: async (record) => `ws-${record.id}`,
    catalog,
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

const catalog = loadBitCatalog(BITS_DIR)

await test('shipped catalog loads 52 bits in 7 groups without errors', async () => {
  assert.equal(catalog.error, null)
  assert.equal(catalog.groups.length, 7)
  assert.equal(catalog.bits.length, 52)
  const groupIds = new Set(catalog.groups.map((group) => group.id))
  for (const bit of catalog.bits) {
    assert.match(bit.id, /^bit-[a-z0-9-]+$/, bit.id)
    assert.ok(groupIds.has(bit.group), `${bit.id} group`)
    assert.match(bit.color, /^#[0-9a-f]{6}$/, `${bit.id} color`)
    assert.ok(bit.summary.pt && bit.summary.en, `${bit.id} summaries`)
    assert.ok(bit.instructions.length > 100 && bit.instructions.length <= 1500, `${bit.id} instructions length`)
    assert.match(bit.instructions, /Report back in Portuguese \(pt-BR\)/, `${bit.id} report line`)
  }
  for (const id of ['bit-mascot', 'bit-scout', 'bit-product-owner', 'bit-android-engineer', 'bit-crm-specialist', 'bit-user-researcher']) {
    assert.ok(catalog.has(id), id)
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
})

await test('normalizeCatalog drops malformed rows and duplicates', async () => {
  const result = normalizeCatalog({
    groups: [{ id: 'g', label: { pt: 'G' } }, { id: 'g' }, { id: 'Bad Id' }],
    bits: [
      { id: 'bit-a', name: 'A', group: 'g', color: '#ABCDEF' },
      { id: 'bit-a', name: 'dup' },
      { id: '../x', name: 'X' },
      { id: 'bit-b', name: '   ' },
      { id: 'bit-c', name: 'C', group: 'missing', emoji: 'way too long emoji' },
    ],
  })
  assert.deepEqual(result.groups, [{ id: 'g', label: { pt: 'G', en: 'G' } }])
  assert.deepEqual(result.bits.map((bit) => bit.id), ['bit-a', 'bit-c'])
  assert.equal(result.bits[0].color, '#abcdef')
  assert.equal(result.bits[1].group, null)
  assert.equal(result.bits[1].emoji, '🤖')
})

// ---------------------------------------------------------------------------
// Store `character` field
// ---------------------------------------------------------------------------

await test('store persists, patches, clears and reloads the character', async () => {
  const botsRoot = await tempDir()
  const store = new BotStore({ botsRoot })
  await store.init()
  const plain = await store.create({ name: 'Legacy' })
  assert.equal(plain.character, null)
  const scout = await store.create({ name: 'Scout', character: 'bit-scout' })
  assert.equal(scout.character, 'bit-scout')
  const patched = await store.update(scout.id, { character: 'bit-reviewer' })
  assert.equal(patched.character, 'bit-reviewer')
  const untouched = await store.update(scout.id, { name: 'Renamed' })
  assert.equal(untouched.character, 'bit-reviewer', 'other patches keep the character')
  await assert.rejects(store.update(scout.id, { character: '../etc' }), (error) => error.code === 'BOT_INVALID_PATCH')
  await assert.rejects(store.create({ name: 'X', character: 42 }), (error) => error.code === 'BOT_INVALID_PATCH')
  const cleared = await store.update(scout.id, { character: null })
  assert.equal(cleared.character, null)
  await store.update(scout.id, { character: 'bit-builder' })

  const reloaded = new BotStore({ botsRoot })
  await reloaded.init()
  assert.equal(reloaded.get(scout.id).character, 'bit-builder')
  assert.equal(reloaded.get(plain.id).character, null)
})

await test('a persisted record without or with a bad character loads as null', async () => {
  const botsRoot = await tempDir()
  await fs.writeFile(path.join(botsRoot, 'bots.json'), JSON.stringify({
    statusVersion: 1,
    bots: [
      { id: 'aaaaaaaaaa', name: 'Old', emoji: '🦊', color: '#123456', instructions: '', vm: { enabled: false, image: 'ubuntu:24.04' } },
      { id: 'bbbbbbbbbb', name: 'Bad', character: 'Not Valid!', vm: {} },
    ],
  }))
  const store = new BotStore({ botsRoot })
  await store.init()
  assert.equal(store.get('aaaaaaaaaa').character, null)
  assert.equal(store.get('aaaaaaaaaa').emoji, '🦊')
  assert.equal(store.get('bbbbbbbbbb').character, null)
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

await test('GET /api/bots.catalog returns groups and bits with avatar URLs', async () => {
  const app = await setupRoutes(catalog)
  const response = await app.call('/api/bots.catalog')
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.groups.length, 7)
  assert.equal(payload.bits.length, 52)
  const scout = payload.bits.find((bit) => bit.id === 'bit-scout')
  assert.equal(scout.avatar, '/api/bots.avatar?id=bit-scout')
  assert.equal(scout.instructions, catalog.get('bit-scout').instructions)
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
  assert.equal(created.bot.character, 'bit-scout')

  const badPatch = await (await app.call('/api/bots.update', { id: created.bot.id, patch: { character: 'bit-unknown' } })).json()
  assert.equal(badPatch.error.code, 'BOT_INVALID_CHARACTER')

  const patched = await (await app.call('/api/bots.update', { id: created.bot.id, patch: { character: 'bit-reviewer' } })).json()
  assert.equal(patched.bot.character, 'bit-reviewer')

  const cleared = await (await app.call('/api/bots.update', { id: created.bot.id, patch: { character: null } })).json()
  assert.equal(cleared.bot.character, null)

  const legacy = await (await app.call('/api/bots.create', { name: 'No bit' })).json()
  assert.equal(legacy.ok, true)
  assert.equal(legacy.bot.character, null)
})

await test('routes without a catalog dependency degrade gracefully', async () => {
  const app = await setupRoutes(undefined)
  const payload = await (await app.call('/api/bots.catalog')).json()
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.bits, [])
  assert.equal((await app.call('/api/bots.avatar?id=bit-scout')).status, 404)
})

await test('package.json ships the catalog and avatars', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.files.includes('bits/catalog.json'))
  assert.ok(pkg.files.includes('bits/avatars/*.webp'))
  assert.ok(existsSync(path.join(ROOT, 'host', 'catalog.js')))
})

for (const dir of tempRoots) await fs.rm(dir, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.log(`catalog: ${failures.length} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`catalog: ${passed} tests passed`)
