#!/usr/bin/env node
/**
 * End-to-end verification for the Bits bundle (v5).
 *
 * Boots a throwaway DeepSeek Harness Web profile in an isolated DSH_HOME with
 * this bundle installed from its local directory, authenticates with the launch
 * token printed at startup, and exercises the real `/api/bots.*` routes:
 * catalog v2, bits CRUD, model catalog, worker "Run" (request → response),
 * team templates (bits + flow), team member/lead rules, team execution error
 * paths, the projects layer and diagnostics. Also asserts that the v4 VM/chat
 * routes are gone. The final section proves the bundle installs a real "Bit mode"
 * chat mode: the `agentPresets/list` remote roster lists the
 * `bits-orchestrator` preset healthy, a session created with that preset
 * records it, and after prompting the session `/api/bots.diagnostics` reports
 * the orchestrator runtime installed on that session with the `bit_delegate`
 * tool (the remote calls use the same `client-request`/`server-response`
 * envelope as the Web client, over the authenticated bridge). That section also
 * guards the preset's plugin child list against silently drifting from the
 * installed app's `standard.patch.yml` (parsed with the app's own patch loader)
 * and proves a session created without the preset keeps the `standard` preset
 * and never gets the orchestrator runtime.
 *
 * Nothing here touches the user's `~/.dsh` or the running Desktop profile.
 *
 * Usage: node test/e2e-web.mjs
 * Env:
 *   DSH_INSTALL_ROOT          default ~/.local/opt/deepseek-harness
 *   BITS_E2E_DELEGATE_DIR     optional @dsh-burn-plugins/dsh-claude-delegate package dir;
 *                             when set, the profile installs it and the suite
 *                             runs one REAL subscription worker invocation
 *                             (needs `claude` installed and logged in).
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_DIR = path.resolve(HERE, '..')
const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? path.join(os.homedir(), '.local', 'opt', 'deepseek-harness')
const RUNTIME = path.join(INSTALL_ROOT, 'resources', 'runtime', 'primary-runtime')
const RUNTIME_NODE = path.join(RUNTIME, 'dependencies', 'node', 'bin', 'node')
const RUNTIME_PNPM = path.join(RUNTIME, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
/** Installed DSH app: its own patch loader and web-app presets are the drift reference. */
const APP_DIR = path.join(INSTALL_ROOT, 'resources', 'app', 'dsh')
const APP_BOOT_LOADER = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
const STANDARD_PATCH = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
const PROFILE = 'bots-e2e'
const DELEGATE_DIR = process.env.BITS_E2E_DELEGATE_DIR ?? ''

/** @type {string[]} */
const cleanupNotes = []
let bootChild
let tempHome
let origin
let cookie
/** Bits created by this run, deleted in cleanup. */
const createdBitIds = []
/** Teams created by this run, deleted in cleanup. */
const createdTeamIds = []
/** Projects created by this run, deleted in cleanup. */
const createdProjectIds = []
/** Temp directories created by this run. */
const createdDirs = []

/**
 * Run one child process to completion with a bounded timeout.
 *
 * @param {string} command executable.
 * @param {string[]} args arguments.
 * @param {object} options spawn options.
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>} settled output.
 */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timeoutMs = options.timeoutMs ?? 120000
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * Pick one free TCP port on loopback.
 *
 * @returns {Promise<number>} free port.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

/**
 * Write the throwaway profile that composes the shipped Web bundles plus this
 * local bundle (and the delegate plugin when requested).
 *
 * @returns {Promise<void>} resolves when the profile is installed.
 */
async function installProfile() {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bits-e2e-home-'))
  const profileDir = path.join(tempHome, 'profiles', PROFILE)
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(path.join(profileDir, 'cordis.yml'), '# e2e profile\n[]\n')
  await fs.writeFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const dependencies = { '@dsh-burn-plugins/dsh-bots': `file:${BUNDLE_DIR}` }
  const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-burn-plugins/dsh-bots']
  if (DELEGATE_DIR !== '') {
    dependencies['@dsh-burn-plugins/dsh-claude-delegate'] = `file:${DELEGATE_DIR}`
    bundles.push('@dsh-burn-plugins/dsh-claude-delegate')
  }
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-bots-e2e',
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }, null, 2))
  const node = existsSync(RUNTIME_NODE) ? RUNTIME_NODE : process.execPath
  const pnpm = existsSync(RUNTIME_PNPM) ? RUNTIME_PNPM : null
  assert.ok(pnpm !== null, `runtime pnpm not found at ${RUNTIME_PNPM}`)
  const installed = await run(node, [pnpm, 'install', '--silent'], {
    cwd: profileDir,
    env: { ...process.env, DSH_HOME: tempHome },
    timeoutMs: 300000,
  })
  assert.equal(installed.code, 0, `pnpm install failed:\n${installed.stdout}\n${installed.stderr}`)
  assert.ok(existsSync(path.join(profileDir, 'node_modules', '@dsh-burn-plugins', 'dsh-bots')), 'bundle was not linked into the profile')
}

/**
 * Boot the profile's Web server and wait for its tokenized startup URL.
 *
 * @param {number} port listener port.
 * @returns {Promise<string>} authenticated root URL.
 */
function bootServer(port) {
  return new Promise((resolve, reject) => {
    bootChild = spawn('dsh', ['--profile', PROFILE, '--no-open', '--port', String(port)], {
      env: { ...process.env, DSH_HOME: tempHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      bootChild.kill('SIGKILL')
      reject(new Error(`Web host did not print a URL within 120s. Output:\n${buffer}`))
    }, 120000)
    const onData = (chunk) => {
      buffer += String(chunk)
      const match = buffer.match(/dsh web: (http:\/\/\S+)/)
      if (match !== null && !settled) {
        settled = true
        clearTimeout(timer)
        resolve(match[1])
      }
    }
    bootChild.stdout.on('data', onData)
    bootChild.stderr.on('data', onData)
    bootChild.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`Web host exited before startup (code ${code}). Output:\n${buffer}`))
    })
    bootChild.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * Exchange the launch token for the signed browser cookie.
 *
 * @param {string} tokenizedUrl printed startup URL.
 * @returns {Promise<void>} resolves once `origin` and `cookie` are set.
 */
async function authenticate(tokenizedUrl) {
  const response = await fetch(tokenizedUrl, { redirect: 'manual' })
  assert.ok([302, 303, 307].includes(response.status), `unexpected token exchange status ${response.status}`)
  const setCookie = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  assert.ok(setCookie.length > 0, 'token exchange returned no cookie')
  cookie = String(setCookie[0]).split(';', 1)[0]
  assert.ok(cookie.includes('='), `malformed cookie: ${cookie}`)
  origin = new URL(tokenizedUrl).origin
}

/**
 * Call one bots route through the authenticated HTTP bridge.
 *
 * @param {string} routePath absolute path such as `/api/bots.list`.
 * @param {object} [options] request options.
 * @returns {Promise<any>} decoded JSON payload.
 */
async function api(routePath, options = {}) {
  const init = {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: { cookie },
  }
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${origin}${routePath}`, init)
  const text = await response.text()
  assert.equal(response.status, 200, `${routePath} answered HTTP ${response.status}: ${text.slice(0, 400)}`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    assert.fail(`${routePath} did not answer JSON: ${text.slice(0, 400)}`)
  }
  return payload
}

/**
 * Call one remote endpoint through the authenticated HTTP bridge, using the
 * same `client-request`/`server-response` envelope the Web client uses.
 *
 * @param {string} endpoint remote method name, e.g. `agentPresets/list`.
 * @param {object} [args] method arguments object.
 * @returns {Promise<any>} the `result.value` of a successful answer.
 */
async function remote(endpoint, args = {}) {
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
  })
  const text = await response.text()
  assert.equal(response.status, 200, `${endpoint} answered HTTP ${response.status}: ${text.slice(0, 400)}`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    assert.fail(`${endpoint} did not answer JSON: ${text.slice(0, 400)}`)
  }
  assert.equal(payload.type, 'server-response', `${endpoint} answered an unexpected envelope: ${text.slice(0, 400)}`)
  assert.equal(payload.rpcId, rpcId, `${endpoint} echoed rpcId ${JSON.stringify(payload.rpcId)} instead of ${rpcId}`)
  assert.ok(payload.result && typeof payload.result === 'object', `${endpoint} answered no result envelope: ${text.slice(0, 600)}`)
  assert.equal(payload.result.ok, true, `${endpoint} failed: ${JSON.stringify(payload.result).slice(0, 800)}`)
  return payload.result.value
}

/**
 * Raw authenticated request, used to assert that a route is gone.
 *
 * @param {string} routePath absolute path.
 * @param {string} [method] HTTP method.
 * @returns {Promise<{ status: number, body: string }>} status and text.
 */
async function raw(routePath, method = 'GET') {
  const response = await fetch(`${origin}${routePath}`, { method, headers: { cookie } })
  return { status: response.status, body: await response.text() }
}

/**
 * Assert a route answered a coded failure.
 *
 * @param {string} routePath route path.
 * @param {object} body request body.
 * @param {string} code expected error code.
 * @returns {Promise<any>} the payload.
 */
async function expectError(routePath, body, code) {
  const payload = await api(routePath, { body })
  assert.equal(payload.ok, false, `${routePath} unexpectedly succeeded: ${JSON.stringify(payload).slice(0, 600)}`)
  assert.equal(payload.error.code, code, `${routePath} answered ${payload.error.code} (${payload.error.message}) instead of ${code}`)
  return payload
}

/**
 * Create one bit from a catalog character and remember it for cleanup.
 *
 * @param {object} fields create payload.
 * @returns {Promise<any>} bit record.
 */
async function createBit(fields) {
  const created = await api('/api/bots.create', { body: fields })
  assert.equal(created.ok, true, `bit create failed: ${JSON.stringify(created)}`)
  createdBitIds.push(created.bit.id)
  return created.bit
}

/**
 * Create one team and remember it for cleanup.
 *
 * @param {object} team team payload.
 * @returns {Promise<any>} team record.
 */
async function createTeam(team) {
  const created = await api('/api/bots.teams.create', { body: { team } })
  assert.equal(created.ok, true, `team create failed: ${JSON.stringify(created).slice(0, 800)}`)
  createdTeamIds.push(created.team.id)
  return created.team
}

/**
 * Stop the booted host, remove created records best-effort and delete the
 * throwaway home.
 *
 * @returns {Promise<void>} resolves after cleanup.
 */
async function cleanup() {
  if (origin !== undefined) {
    for (const id of createdTeamIds) {
      try {
        await api('/api/bots.teams.delete', { body: { id } })
      } catch {
        // Best effort (the host may already be down).
      }
    }
    for (const id of createdBitIds) {
      try {
        await api('/api/bots.delete', { body: { id, deleteWorkspace: true } })
      } catch {
        // Best effort.
      }
    }
    for (const id of createdProjectIds) {
      try {
        await api('/api/bots.projects.delete', { body: { id } })
      } catch {
        // Best effort.
      }
    }
  }
  if (bootChild !== undefined && bootChild.exitCode === null) {
    bootChild.kill('SIGTERM')
    const exited = new Promise((resolve) => {
      const timer = setTimeout(() => {
        bootChild.kill('SIGKILL')
        resolve()
      }, 8000)
      bootChild.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await exited
  }
  for (const dir of createdDirs) {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }
  if (tempHome !== undefined) {
    try {
      await fs.rm(tempHome, { recursive: true, force: true })
      cleanupNotes.push(`removed ${tempHome}`)
    } catch (error) {
      cleanupNotes.push(`failed to remove ${tempHome}: ${error.message}`)
    }
  }
}

/** Run the whole suite. */
async function main() {
  if (!existsSync(path.join(BUNDLE_DIR, 'host', 'bit-runtime.js')) || !existsSync(path.join(BUNDLE_DIR, 'host', 'models.js'))) {
    throw new Error(`bundle is incomplete at ${BUNDLE_DIR}`)
  }
  console.log(`bundle: ${BUNDLE_DIR}`)
  console.log(`install root: ${INSTALL_ROOT}`)
  console.log(`delegate plugin: ${DELEGATE_DIR === '' ? '(not installed; real run skipped)' : DELEGATE_DIR}`)
  console.log('1/12 install throwaway profile')
  await installProfile()
  const port = await freePort()
  console.log(`2/12 boot isolated web host on port ${port}`)
  const tokenized = await bootServer(port)
  await authenticate(tokenized)
  console.log(`   authenticated at ${origin}`)

  console.log('3/12 client bundle is served')
  {
    const indexResponse = await fetch(`${origin}/`, { headers: { cookie } })
    assert.equal(indexResponse.status, 200, `index answered HTTP ${indexResponse.status}`)
    const indexHtml = await indexResponse.text()
    const hrefs = [...indexHtml.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((match) => match[1].replaceAll('&amp;', '&'))
      .filter((href) => href.includes('@dsh-burn-plugins/dsh-bots/client.js'))
    assert.ok(hrefs.length > 0, 'the boot payload does not reference the Bits client bundle')
    const bundleHref = hrefs.find((href) => href.includes('??')) ?? hrefs[0]
    const response = await fetch(new URL(bundleHref, `${origin}/`), { headers: { cookie } })
    assert.equal(response.status, 200, `client bundle ${bundleHref} answered HTTP ${response.status}`)
    const body = await response.text()
    assert.ok(body.includes('__ModuleLoader__'), 'served bundle does not contain the module loader registration')
    assert.ok(body.includes('@dsh-burn-plugins/dsh-bots'), 'served bundle does not register the bundle id')
    assert.ok(body.includes('Bits'), 'served bundle does not contain the Bits page code')
    assert.ok(body.includes('New bit') && body.includes('Send request'), 'served bundle does not contain the English UI copy')
    assert.ok(!/Docker/i.test(body), 'served bundle still contains the v4 VM copy')
    console.log(`   served ${bundleHref} (${body.length} bytes)`)
  }

  console.log('4/12 bits catalog v2 + model catalog')
  {
    const catalog = await api('/api/bots.catalog')
    assert.equal(catalog.ok, true, `catalog failed: ${JSON.stringify(catalog).slice(0, 400)}`)
    assert.equal(catalog.version, 2)
    assert.ok(Array.isArray(catalog.bits) && catalog.bits.length === 53, `expected 53 bits, got ${catalog.bits?.length}`)
    assert.ok(Array.isArray(catalog.groups) && catalog.groups.length >= 1)
    for (const bit of catalog.bits) {
      assert.equal(typeof bit.isOrchestrator, 'boolean', `catalog bit ${bit.id} has no isOrchestrator`)
      assert.equal(typeof bit.model, 'string', `catalog bit ${bit.id} has no model`)
      assert.ok(bit.model.length > 0)
      assert.equal(typeof bit.effort, 'string', `catalog bit ${bit.id} has no effort`)
      assert.ok(bit.effort.length > 0)
    }
    const orchestrators = catalog.bits.filter((bit) => bit.isOrchestrator === true).map((bit) => bit.id).sort()
    assert.deepEqual(orchestrators, ['bit-coordinator', 'bit-manager', 'bit-product-owner', 'bit-sub-coordinator'])
    const coordinator = catalog.bits.find((bit) => bit.id === 'bit-coordinator')
    assert.equal(coordinator.model, 'deepseek-account/deepseek-flash')
    assert.equal(coordinator.effort, 'max')
    const builder = catalog.bits.find((bit) => bit.id === 'bit-builder')
    assert.equal(builder.isOrchestrator, false)
    assert.equal(builder.model, 'subscription/sonnet')

    const models = await api('/api/bots.models')
    assert.equal(models.ok, true, `models failed: ${JSON.stringify(models).slice(0, 400)}`)
    assert.ok(Array.isArray(models.models) && models.models.length >= 3)
    for (const option of models.models) {
      assert.equal(typeof option.id, 'string')
      assert.equal(typeof option.label, 'string')
      assert.ok(['subscription', 'routes'].includes(option.group))
      assert.ok(['claude-code', 'dsh'].includes(option.backend))
      assert.ok(Array.isArray(option.efforts))
    }
    for (const id of ['subscription/fable', 'subscription/opus', 'subscription/sonnet', 'subscription/haiku']) {
      assert.ok(models.models.some((option) => option.id === id), `model catalog lacks ${id}`)
    }
    const opus = models.models.find((option) => option.id === 'subscription/opus')
    assert.equal(opus.backend, 'claude-code')
    assert.equal(opus.supportsOrchestrator, false)
    assert.deepEqual(opus.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
    console.log(`   ${catalog.bits.length} catalog bits (${orchestrators.length} orchestrators), ${models.models.length} model options`)
  }

  console.log('5/12 bits CRUD')
  let baseline = await api('/api/bots.list')
  assert.equal(baseline.ok, true)
  assert.ok(Array.isArray(baseline.bits))
  assert.deepEqual(baseline.bots, baseline.bits, 'list does not expose the legacy `bots` alias')
  const baselineCount = baseline.bits.length

  const builder = await createBit({
    name: 'E2E Builder',
    character: 'bit-builder',
    emoji: '🛠️',
    color: '#7c3aed',
    instructions: 'You are the end-to-end verification worker.',
  })
  assert.match(builder.id, /^[0-9a-f]{10}$/)
  assert.equal(builder.character, 'bit-builder')
  assert.equal(builder.isOrchestrator, false)
  assert.equal(builder.model, 'subscription/sonnet')
  assert.equal(builder.effort, 'medium')
  assert.ok(typeof builder.workspaceDir === 'string' && path.isAbsolute(builder.workspaceDir))
  await fs.access(builder.workspaceDir)

  const orchestrator = await createBit({ name: 'E2E Coordinator', character: 'bit-coordinator', emoji: '🗂️', color: '#346dca' })
  assert.equal(orchestrator.isOrchestrator, true)
  assert.equal(orchestrator.model, 'deepseek-account/deepseek-flash')
  assert.equal(orchestrator.effort, 'max')

  const updated = await api('/api/bots.update', {
    body: { id: builder.id, patch: { name: 'E2E Builder Renamed', instructions: 'Updated instructions.', effort: 'max' } },
  })
  assert.equal(updated.ok, true, `bit update failed: ${JSON.stringify(updated)}`)
  assert.equal(updated.bit.name, 'E2E Builder Renamed')
  assert.equal(updated.bit.instructions, 'Updated instructions.')
  assert.equal(updated.bit.effort, 'max')
  assert.equal(updated.bit.character, 'bit-builder')

  await expectError('/api/bots.update', { id: 'deadbeef01', patch: { name: 'nope' } }, 'BOT_NOT_FOUND')
  const emptyName = await api('/api/bots.create', { body: { name: '', character: 'bit-builder' } })
  assert.equal(emptyName.ok, false, `empty name was accepted: ${JSON.stringify(emptyName)}`)
  assert.match(emptyName.error.code, /^BOT_INVALID/, `unexpected empty-name error: ${JSON.stringify(emptyName.error)}`)
  await expectError('/api/bots.create', { name: 'Unknown', character: 'bit-does-not-exist' }, 'BOT_INVALID_CHARACTER')
  await expectError('/api/bots.create', { name: 'Bad Orchestrator', character: 'bit-builder', isOrchestrator: true, model: 'subscription/opus' }, 'BOT_INVALID')

  baseline = await api('/api/bots.list')
  assert.equal(baseline.bits.length, baselineCount + 2)
  console.log('   create/update/list/validation respected catalog defaults')

  console.log('6/12 worker Run (request → response)')
  {
    // Orchestrators execute inside flows only.
    await expectError('/api/bots.run', { id: orchestrator.id, request: 'do something' }, 'BIT_IS_ORCHESTRATOR')
    // Request validation.
    await expectError('/api/bots.run', { id: builder.id, request: '' }, 'BAD_REQUEST')
    await expectError('/api/bots.run', { id: 'deadbeef01', request: 'oi' }, 'BOT_NOT_FOUND')
    // Without @dsh-burn-plugins/dsh-claude-delegate installed, the subscription backend
    // fails with an actionable coded error instead of hanging or crashing.
    if (DELEGATE_DIR === '') {
      const unavailable = await api('/api/bots.run', { body: { id: builder.id, request: 'Answer only: ok', readOnly: true } })
      assert.equal(unavailable.ok, false, `subscription run without the delegate plugin unexpectedly succeeded: ${JSON.stringify(unavailable).slice(0, 600)}`)
      assert.ok(
        ['BIT_DELEGATE_UNAVAILABLE', 'BIT_MODEL_INVALID'].includes(unavailable.error.code),
        `unexpected run error: ${JSON.stringify(unavailable.error)}`,
      )
      console.log(`   coded failure without the delegate plugin: ${unavailable.error.code}`)
    }

    // One-shot DSH route backend: no chat providers exist in this throwaway
    // profile, so the bit route is invalid at catalog resolution; when the
    // profile does expose a route this becomes a real call. Either way the
    // route must answer a coded error, never a 500/hang.
    const dshBit = await api('/api/bots.create', {
      body: { name: 'E2E DSH Worker', character: 'bit-scout', isOrchestrator: false, model: 'deepseek-account/deepseek-flash', effort: 'low' },
    })
    createdBitIds.push(dshBit.bit.id)
    const dshRun = await api('/api/bots.run', { body: { id: dshBit.bit.id, request: 'Answer only: ok', readOnly: true } })
    if (dshRun.ok === false) {
      assert.ok(['BIT_MODEL_INVALID', 'BIT_MODEL_CALL_FAILED', 'BIT_DELEGATE_UNAVAILABLE'].includes(dshRun.error.code), `unexpected error: ${JSON.stringify(dshRun.error)}`)
      console.log(`   coded failure for a DSH-route worker: ${dshRun.error.code}`)
    } else {
      assert.equal(typeof dshRun.response, 'string')
      assert.ok(dshRun.response.length > 0)
      console.log(`   one-shot DSH route answered (${dshRun.response.length} chars)`)
    }

    // Real subscription invocation when the delegate plugin is installed.
    if (DELEGATE_DIR !== '') {
      const realBit = await api('/api/bots.create', {
        body: {
          name: 'E2E Subscription Worker',
          character: 'bit-scout',
          isOrchestrator: false,
          model: 'subscription/haiku',
          effort: 'low',
          instructions: 'Answer in one short line.',
        },
      })
      assert.equal(realBit.ok, true, `real-run bit create failed: ${JSON.stringify(realBit)}`)
      createdBitIds.push(realBit.bit.id)
      const startedAt = Date.now()
      const realRun = await api('/api/bots.run', { body: { id: realBit.bit.id, request: 'Answer exactly: ok', readOnly: true } })
      assert.equal(realRun.ok, true, `real subscription run failed: ${JSON.stringify(realRun).slice(0, 800)}`)
      assert.equal(typeof realRun.response, 'string')
      assert.ok(realRun.response.trim().length > 0, 'real subscription run returned an empty answer')
      assert.equal(realRun.meta.backend, 'claude-code')
      assert.match(String(realRun.meta.model), /^subscription\/haiku$/)
      console.log(`   REAL subscription run answered in ${Date.now() - startedAt}ms: ${realRun.response.trim().slice(0, 80)}`)
    }
  }

  console.log('7/12 teams: templates, bit-referencing members, lead rule, run error paths')
  {
    const templates = await api('/api/bots.teams.templates')
    assert.equal(templates.ok, true, `templates failed: ${JSON.stringify(templates).slice(0, 400)}`)
    const engineering = templates.templates.find((entry) => entry.id === 'engineering')
    assert.ok(engineering !== undefined, 'engineering template missing')
    assert.ok(Array.isArray(engineering.bits) && engineering.bits.length > 0, 'template has no bits')
    assert.ok(Array.isArray(engineering.team.members) && engineering.team.members.length > 0)
    assert.ok(engineering.team.members.every((member) => typeof member.bitKey === 'string'), 'template members do not reference bitKey')
    assert.equal(typeof engineering.team.lead, 'string')

    const before = (await api('/api/bots.list')).bits.length
    const instantiated = await api('/api/bots.teams.fromTemplate', { body: { templateId: 'engineering' } })
    assert.equal(instantiated.ok, true, `fromTemplate failed: ${JSON.stringify(instantiated).slice(0, 800)}`)
    createdTeamIds.push(instantiated.team.id)
    for (const bit of instantiated.bits) createdBitIds.push(bit.id)
    const listedBits = await api('/api/bots.list')
    assert.equal(listedBits.bits.length, before + instantiated.bits.length)
    const team = instantiated.team
    const memberBitIds = new Set(instantiated.bits.map((bit) => bit.id))
    assert.ok(team.members.length > 0)
    for (const member of team.members) {
      assert.ok(memberBitIds.has(member.bitId), `member ${member.id} references an unknown bit`)
      assert.ok(!('instructions' in member) && !('model' in member) && !('character' in member), `member ${member.id} still embeds v4 fields`)
    }
    assert.ok(team.lead, 'fromTemplate team has no lead')
    const leadMember = team.members.find((member) => member.id === team.lead)
    assert.ok(leadMember !== undefined, 'team lead is not a member')
    assert.equal(leadMember.access, 'read')
    const leadBit = instantiated.bits.find((bit) => bit.id === leadMember.bitId)
    assert.equal(leadBit.isOrchestrator, true, 'template lead bit is not an orchestrator')
    assert.ok(Array.isArray(team.flow.nodes) && team.flow.nodes.length > 1)
    assert.ok(team.flow.nodes.some((node) => node.memberId === team.lead))

    // Members must reference existing bits.
    const unknownMember = await api('/api/bots.teams.update', {
      body: { id: team.id, patch: { members: [{ id: 'ghost', bitId: 'deadbeef01' }] } },
    })
    assert.equal(unknownMember.ok, false, `unknown bitId was accepted: ${JSON.stringify(unknownMember).slice(0, 400)}`)
    assert.equal(unknownMember.error.code, 'TEAM_INVALID')
    assert.match(unknownMember.error.message, /bitId/)

    // A worker bit cannot lead a team.
    const workerLead = await api('/api/bots.teams.create', {
      body: { team: { name: 'E2E Worker Lead', members: [{ id: 'builder', bitId: builder.id, access: 'write' }], lead: 'builder' } },
    })
    assert.equal(workerLead.ok, false, `worker bit accepted as team lead: ${JSON.stringify(workerLead).slice(0, 400)}`)
    assert.equal(workerLead.error.code, 'TEAM_LEAD_NOT_ORCHESTRATOR')

    // A manually built team with an orchestrator lead is accepted.
    const manual = await createTeam({
      name: 'E2E Manual Flow',
      members: [
        { id: 'lead', bitId: orchestrator.id, access: 'read', launches: ['builder'] },
        { id: 'builder', bitId: builder.id, access: 'write' },
      ],
      lead: 'lead',
      flow: {
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0, label: 'Request' },
          { id: 'lead', type: 'step', x: 0, y: 100, label: 'Orquestrar', memberId: 'lead' },
          { id: 'builder', type: 'step', x: 0, y: 200, label: 'Implementar', memberId: 'builder' },
          { id: 'end', type: 'end', x: 0, y: 300, label: 'Delivery' },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'lead' },
          { id: 'e2', from: 'lead', to: 'builder', kind: 'delegate' },
          { id: 'e3', from: 'builder', to: 'end' },
        ],
      },
    })
    assert.equal(manual.lead, 'lead')

    // Run error paths are deterministic without a workspace/session setup.
    await expectError('/api/bots.teams.run', { id: 'deadbeef01', prompt: 'oi' }, 'TEAM_NOT_FOUND')
    const noLead = await createTeam({ name: 'E2E No Lead' })
    await expectError('/api/bots.teams.run', { id: noLead.id, prompt: 'oi' }, 'TEAM_NO_LEAD')
    await expectError('/api/bots.teams.run', { id: manual.id, prompt: '' }, 'TEAM_NO_WORKSPACE')

    // A team with a real workspace registers it through the workspace route.
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bits-e2e-repo-'))
    createdDirs.push(repoDir)
    const withRepo = await createTeam({ name: 'E2E With Repo', workspaceDir: repoDir, lead: 'lead', members: [{ id: 'lead', bitId: orchestrator.id, access: 'read' }] })
    const workspace = await api('/api/bots.teams.workspace', { body: { id: withRepo.id } })
    assert.equal(workspace.ok, true, `teams.workspace failed: ${JSON.stringify(workspace)}`)
    assert.ok(typeof workspace.workspaceId === 'string' && workspace.workspaceId.length > 0)
    assert.equal(workspace.workspaceDir, repoDir)
    await expectError('/api/bots.teams.run', { id: withRepo.id, prompt: '   ' }, 'BAD_REQUEST')

    const deletedTeam = await api('/api/bots.teams.delete', { body: { id: noLead.id } })
    assert.equal(deletedTeam.ok, true)
    const stillListed = (await api('/api/bots.teams')).teams.some((entry) => entry.id === noLead.id)
    assert.equal(stillListed, false, 'deleted team still listed')
    console.log(`   template instantiated ${instantiated.bits.length} bits + ${team.members.length} members; lead/bitId rules and run errors verified`)
  }

  console.log('8/12 projects layer (unchanged)')
  {
    const none = await api('/api/bots.projects')
    assert.equal(none.ok, true, `projects list failed: ${JSON.stringify(none)}`)
    assert.deepEqual(none.projects, [])

    const first = await api('/api/bots.projects.create', {
      body: {
        project: {
          name: '  E2E Project  ',
          description: 'End-to-end verification project.',
          id: 'ffffffffff',
          createdAt: '2000-01-01T00:00:00.000Z',
          updatedAt: '2000-01-01T00:00:00.000Z',
        },
      },
    })
    assert.equal(first.ok, true, `project create failed: ${JSON.stringify(first)}`)
    const project = first.project
    createdProjectIds.push(project.id)
    assert.match(project.id, /^[0-9a-f]{10}$/)
    assert.notEqual(project.id, 'ffffffffff', 'project create kept the client-supplied id')
    assert.equal(project.name, 'E2E Project')
    assert.equal(project.description, 'End-to-end verification project.')
    assert.equal(project.emoji, '📁')
    assert.equal(project.color, '#2563eb')

    const second = await api('/api/bots.projects.create', {
      body: { project: { name: 'E2E Second', description: 'Another project.', emoji: '🧪', color: '#16a34a' } },
    })
    assert.equal(second.ok, true, `second project create failed: ${JSON.stringify(second)}`)
    const other = second.project
    createdProjectIds.push(other.id)
    assert.match(other.id, /^[0-9a-f]{10}$/)
    assert.notEqual(other.id, project.id)

    const listedProjects = await api('/api/bots.projects')
    assert.equal(listedProjects.projects.length, 2, `expected two projects: ${JSON.stringify(listedProjects)}`)

    const updatedProject = await api('/api/bots.projects.update', {
      body: { id: project.id, patch: { name: 'E2E Project Renamed', color: '#dc2626' } },
    })
    assert.equal(updatedProject.ok, true, `project update failed: ${JSON.stringify(updatedProject)}`)
    assert.equal(updatedProject.project.id, project.id)
    assert.equal(updatedProject.project.name, 'E2E Project Renamed')
    assert.equal(updatedProject.project.color, '#dc2626')
    assert.equal(updatedProject.project.description, project.description)

    const invalidProject = await api('/api/bots.projects.create', { body: { project: { name: '' } } })
    assert.equal(invalidProject.ok, false, `empty project name was accepted: ${JSON.stringify(invalidProject)}`)
    assert.equal(invalidProject.error.code, 'PROJECT_INVALID')
    assert.match(invalidProject.error.message, /name:/)
    await expectError('/api/bots.projects.update', { id: 'deadbeef01', patch: { name: 'nope' } }, 'PROJECT_NOT_FOUND')
    await expectError('/api/bots.projects.delete', { id: 'deadbeef01' }, 'PROJECT_NOT_FOUND')

    // A non-shared team belongs to a single project by default.
    const teamA = await createTeam({ name: 'E2E Team A', projectIds: [project.id] })
    assert.equal(teamA.shared, false)
    assert.deepEqual(teamA.projectIds, [project.id])
    const teamB = await createTeam({ name: 'E2E Team B' })
    assert.equal(teamB.shared, false)
    assert.deepEqual(teamB.projectIds, [])
    const teamBShared = await api('/api/bots.teams.update', {
      body: { id: teamB.id, patch: { shared: true, projectIds: [project.id, other.id] } },
    })
    assert.equal(teamBShared.ok, true, `shared team update failed: ${JSON.stringify(teamBShared)}`)
    assert.equal(teamBShared.team.shared, true)
    assert.deepEqual(teamBShared.team.projectIds, [project.id, other.id])

    const unknownOnCreate = await api('/api/bots.teams.create', { body: { team: { name: 'E2E Team X', projectIds: ['deadbeef01'] } } })
    assert.equal(unknownOnCreate.ok, false, `team with unknown project was accepted: ${JSON.stringify(unknownOnCreate)}`)
    assert.equal(unknownOnCreate.error.code, 'TEAM_INVALID')
    assert.match(unknownOnCreate.error.message, /projectIds\[0\]: unknown project "deadbeef01"/)
    const unknownOnUpdate = await api('/api/bots.teams.update', { body: { id: teamA.id, patch: { projectIds: ['deadbeef01'] } } })
    assert.equal(unknownOnUpdate.ok, false)
    assert.equal(unknownOnUpdate.error.code, 'TEAM_INVALID')
    let teams = await api('/api/bots.teams')
    const teamAUnchanged = teams.teams.find((entry) => entry.id === teamA.id)
    assert.ok(teamAUnchanged !== undefined, 'team A missing from the teams list')
    assert.deepEqual(teamAUnchanged.projectIds, [project.id], 'rejected patch still changed the team')

    const twoProjects = await api('/api/bots.teams.update', {
      body: { id: teamA.id, patch: { shared: false, projectIds: [project.id, other.id] } },
    })
    assert.equal(twoProjects.ok, false, `non-shared team accepted two projects: ${JSON.stringify(twoProjects)}`)
    assert.equal(twoProjects.error.code, 'TEAM_INVALID')

    const deletedOther = await api('/api/bots.projects.delete', { body: { id: other.id } })
    assert.equal(deletedOther.ok, true, `second project delete failed: ${JSON.stringify(deletedOther)}`)
    assert.equal(deletedOther.detachedTeams, 1, `expected one detached team: ${JSON.stringify(deletedOther)}`)
    teams = await api('/api/bots.teams')
    const teamBAfterDetach = teams.teams.find((entry) => entry.id === teamB.id)
    assert.ok(teamBAfterDetach !== undefined)
    assert.deepEqual(teamBAfterDetach.projectIds, [project.id], 'deleted project id remained in the shared team')

    const deletedFirst = await api('/api/bots.projects.delete', { body: { id: project.id } })
    assert.equal(deletedFirst.ok, true, `first project delete failed: ${JSON.stringify(deletedFirst)}`)
    assert.equal(deletedFirst.detachedTeams, 2, `expected two detached teams: ${JSON.stringify(deletedFirst)}`)
    teams = await api('/api/bots.teams')
    for (const id of [teamA.id, teamB.id]) {
      const view = teams.teams.find((entry) => entry.id === id)
      assert.ok(view !== undefined, `team ${id} disappeared when its project was deleted`)
      assert.deepEqual(view.projectIds, [], `team ${id} still lists the deleted project`)
    }
    assert.deepEqual((await api('/api/bots.projects')).projects, [])
    console.log('   projects CRUD, shared/non-shared membership, unknown-id rejection and delete/detach verified')
  }

  console.log('9/12 diagnostics + removed v4 surface')
  {
    const diagnostics = await api('/api/bots.diagnostics')
    assert.equal(diagnostics.ok, true, `diagnostics failed: ${JSON.stringify(diagnostics).slice(0, 400)}`)
    assert.equal(diagnostics.storeReady, true)
    assert.ok(typeof diagnostics.bitsPath === 'string' && diagnostics.bitsPath.endsWith('bits.json'))
    assert.ok(Array.isArray(diagnostics.bits))
    for (const bit of diagnostics.bits) {
      assert.equal(typeof bit.isOrchestrator, 'boolean')
      assert.equal(typeof bit.model, 'string')
      assert.ok(!('vm' in bit) && !('vmEnabled' in bit), `diagnostics still reports VM fields: ${JSON.stringify(bit)}`)
    }
    assert.deepEqual(diagnostics.errors, [], `team integration reported errors: ${JSON.stringify(diagnostics.errors)}`)
    assert.ok(Array.isArray(diagnostics.agents))

    for (const [routePath, method] of [
      ['/api/bots.images', 'GET'],
      ['/api/bots.vm', 'POST'],
      ['/api/bots.notify-test', 'POST'],
      ['/api/bots.teams.providers', 'GET'],
    ]) {
      const response = await raw(routePath, method)
      assert.notEqual(response.status, 200, `${routePath} still answers 200: ${response.body.slice(0, 200)}`)
    }
    console.log('   diagnostics reports bits/agents only; v4 VM/chat/provider routes are gone')
  }

  console.log('10/12 Bit mode preset + session wiring (remote RPC)')
  {
    // Drift guard (review F1): the preset's `config.plugins` is a verbatim copy
    // of the installed web-app standard preset. A DSH upgrade could change that
    // list without anything else failing, so compare both files with the app's
    // own patch loader (the `!!js` checks must parse identically too).
    const hasAppBootLoader = existsSync(APP_BOOT_LOADER)
    if (hasAppBootLoader) {
      assert.ok(existsSync(STANDARD_PATCH), `installed standard preset patch not found at ${STANDARD_PATCH}`)
      const { loadOverlayPatches } = await import(pathToFileURL(APP_BOOT_LOADER).href)
      assert.equal(typeof loadOverlayPatches, 'function', `${APP_BOOT_LOADER} does not export loadOverlayPatches`)
      const bundlePatch = loadOverlayPatches('dsh-bits-e2e', path.join(BUNDLE_DIR, 'cordis.patch.yml'))
      const standardPatch = loadOverlayPatches('dsh-web-app-e2e', STANDARD_PATCH)
      const rowsOf = (entries) => entries.flatMap((entry) => (Array.isArray(entry.insert) ? entry.insert : []))
      const bundleRows = rowsOf(bundlePatch)
      const standardRows = rowsOf(standardPatch)
      const presetRow = bundleRows.find((row) => row.id === 'preset-bits-orchestrator')
      assert.ok(
        presetRow !== undefined,
        `bundle patch has no preset-bits-orchestrator row: ${bundleRows.map((row) => row.id).join(', ')}`,
      )
      assert.equal(presetRow.name, '@deepseek-ai/dsh-agent-preset', `unexpected preset row plugin: ${JSON.stringify(presetRow.name)}`)
      assert.equal(presetRow.config.id, 'bits-orchestrator', `unexpected preset row id: ${JSON.stringify(presetRow.config.id)}`)
      assert.equal(presetRow.config.name, 'Bit mode', `unexpected preset row name: ${JSON.stringify(presetRow.config.name)}`)
      assert.equal(presetRow.config.order, 5, `unexpected preset row order: ${JSON.stringify(presetRow.config.order)}`)
      assert.equal(presetRow.config.isDefault, undefined, 'the preset row sets isDefault')
      const botsRow = bundleRows.find((row) => row.id === 'bots')
      assert.ok(botsRow !== undefined, 'bundle patch lost the bots row')
      assert.equal(botsRow.name, '@dsh-burn-plugins/dsh-bots', `unexpected bots row plugin: ${JSON.stringify(botsRow.name)}`)
      assert.deepEqual(botsRow.config, {}, 'the bots row config changed')
      const standardRow = standardRows.find((row) => row.id === 'preset-standard')
      assert.ok(standardRow !== undefined, `installed standard.patch.yml has no preset-standard row: ${standardRows.map((row) => row.id).join(', ')}`)
      assert.equal(standardRow.config.id, 'standard', `unexpected installed standard preset id: ${JSON.stringify(standardRow.config.id)}`)
      const bundleChildren = presetRow.config.plugins
      const standardChildren = standardRow.config.plugins
      assert.ok(Array.isArray(bundleChildren) && Array.isArray(standardChildren), 'preset plugin child lists are not arrays')
      assert.deepEqual(
        bundleChildren,
        standardChildren,
        'the Bit mode preset child list drifted from the installed standard.patch.yml; re-copy the standard child list',
      )
      const jsExpressions = []
      const collectJsExpressions = (value) => {
        if (Array.isArray(value)) {
          for (const child of value) collectJsExpressions(child)
          return
        }
        if (value === null || typeof value !== 'object') return
        if (typeof value.__jsExpr === 'string') jsExpressions.push(value.__jsExpr)
        for (const child of Object.values(value)) collectJsExpressions(child)
      }
      collectJsExpressions(bundleChildren)
      assert.equal(
        jsExpressions.length,
        3,
        `expected the three copied !!js checks in config.plugins, parsed ${jsExpressions.length}: ${JSON.stringify(jsExpressions)}`,
      )
      console.log(`   drift guard: preset children deep-equal installed standard.patch.yml (${bundleChildren.length} children, ${jsExpressions.length} !!js checks)`)
    } else {
      console.log(`   drift guard skipped: app patch loader not found at ${APP_BOOT_LOADER}`)
    }

    const roster = await remote('agentPresets/list', {})
    assert.ok(
      roster !== null && typeof roster === 'object' && Array.isArray(roster.presets) && roster.presets.length > 0,
      `agentPresets/list returned no roster: ${JSON.stringify(roster).slice(0, 600)}`,
    )
    const presets = roster.presets
    const orchestratorPreset = presets.find((preset) => preset.id === 'bits-orchestrator')
    assert.ok(
      orchestratorPreset !== undefined,
      `agentPresets/list has no bits-orchestrator: ${presets.map((preset) => preset.id).join(', ')}`,
    )
    assert.equal(orchestratorPreset.name, 'Bit mode', `unexpected Bit mode name: ${JSON.stringify(orchestratorPreset)}`)
    assert.equal(orchestratorPreset.isDefault, false, 'the Bit mode preset became the profile default')
    assert.equal(orchestratorPreset.order, 5, `Bit mode preset order is ${JSON.stringify(orchestratorPreset.order)} instead of 5`)
    assert.equal(orchestratorPreset.broken, undefined, `the Bit mode preset is marked broken: ${JSON.stringify(orchestratorPreset.broken)}`)
    for (const preset of presets) {
      assert.equal(preset.broken, undefined, `agentPresets/list reports broken preset ${preset.id}: ${JSON.stringify(preset.broken)}`)
    }
    const standardPreset = presets.find((preset) => preset.id === 'standard')
    assert.ok(standardPreset !== undefined, `agentPresets/list lost the builtin standard preset: ${presets.map((preset) => preset.id).join(', ')}`)
    assert.equal(standardPreset.isDefault, true, 'the builtin standard preset is no longer the profile default')
    console.log(`   roster: ${presets.map((preset) => preset.id).join(', ')}`)

    const sessionCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bits-e2e-orchestrator-'))
    createdDirs.push(sessionCwd)
    const created = await remote('session/create', { request: { cwd: sessionCwd, agentPreset: 'bits-orchestrator' } })
    assert.ok(created !== null && typeof created === 'object', `session/create returned no value: ${JSON.stringify(created)}`)
    assert.equal(created.agentPreset, 'bits-orchestrator', `session/create returned agentPreset ${JSON.stringify(created.agentPreset)}`)
    assert.ok(
      typeof created.sessionId === 'string' && created.sessionId !== '',
      `session/create returned no sessionId: ${JSON.stringify(created).slice(0, 600)}`,
    )
    const sessionId = created.sessionId
    console.log(`   session ${sessionId} created with agentPreset=${created.agentPreset}`)

    const prompted = await remote('session/prompt', {
      request: {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'Hello from the Bit mode e2e.' }],
      },
    })
    assert.ok(prompted !== null && typeof prompted === 'object', `session/prompt returned no value: ${JSON.stringify(prompted)}`)
    assert.equal(prompted.accepted, true, `session/prompt was not accepted: ${JSON.stringify(prompted).slice(0, 600)}`)

    // The runtime installs on `agent/created`, which fires while the session is
    // created; poll diagnostics for a short while anyway. The model turn itself
    // may fail asynchronously in this throwaway profile (no credentials), which
    // is irrelevant here: admission/activation is what this section proves.
    let installedEntry
    let orchestratorDiagnostics
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const diagnostics = await api('/api/bots.diagnostics')
      orchestratorDiagnostics = diagnostics.orchestrator
      if (
        orchestratorDiagnostics !== null
        && typeof orchestratorDiagnostics === 'object'
        && Array.isArray(orchestratorDiagnostics.installed)
      ) {
        installedEntry = orchestratorDiagnostics.installed.find((entry) => entry.sessionId === sessionId)
        if (installedEntry !== undefined) break
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.ok(
      orchestratorDiagnostics !== null && typeof orchestratorDiagnostics === 'object',
      `diagnostics reports no orchestrator runtime: ${JSON.stringify(orchestratorDiagnostics).slice(0, 800)}`,
    )
    assert.equal(
      orchestratorDiagnostics.presetId,
      'bits-orchestrator',
      `diagnostics orchestrator presetId is ${JSON.stringify(orchestratorDiagnostics.presetId)}`,
    )
    assert.ok(
      installedEntry !== undefined,
      `diagnostics never reported the orchestrator runtime for session ${sessionId}: ${JSON.stringify(orchestratorDiagnostics).slice(0, 1200)}`,
    )
    assert.ok(
      Array.isArray(installedEntry.tools) && installedEntry.tools.includes('bit_delegate'),
      `session ${sessionId} orchestrator tools are ${JSON.stringify(installedEntry.tools)}`,
    )
    assert.deepEqual(
      orchestratorDiagnostics.errors,
      [],
      `orchestrator runtime reported errors: ${JSON.stringify(orchestratorDiagnostics.errors)}`,
    )
    console.log(
      `   diagnostics: presetId=${orchestratorDiagnostics.presetId} `
      + `installed=[${orchestratorDiagnostics.installed.map((entry) => `${entry.sessionId}:${entry.tools.join(',')}`).join('; ')}]`,
    )

    // Control: a session created without the preset must stay a normal
    // `standard` session and must never get the orchestrator runtime installed.
    const controlCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bits-e2e-standard-'))
    createdDirs.push(controlCwd)
    const control = await remote('session/create', { request: { cwd: controlCwd } })
    assert.ok(control !== null && typeof control === 'object', `control session/create returned no value: ${JSON.stringify(control)}`)
    assert.equal(control.agentPreset, 'standard', `preset-less session/create returned agentPreset ${JSON.stringify(control.agentPreset)}`)
    assert.ok(
      typeof control.sessionId === 'string' && control.sessionId !== '',
      `control session/create returned no sessionId: ${JSON.stringify(control).slice(0, 600)}`,
    )
    assert.notEqual(control.sessionId, sessionId, 'the control session reused the orchestrator session id')
    // `agent/created` fires on creation, so a short settle is enough before
    // checking that the runtime hook ignored this session.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const controlDiagnostics = await api('/api/bots.diagnostics')
    assert.ok(
      controlDiagnostics.orchestrator !== null
      && typeof controlDiagnostics.orchestrator === 'object'
      && Array.isArray(controlDiagnostics.orchestrator.installed),
      `diagnostics reports no orchestrator installed list after the control session: ${JSON.stringify(controlDiagnostics.orchestrator)}`,
    )
    assert.equal(
      controlDiagnostics.orchestrator.installed.some((entry) => entry.sessionId === control.sessionId),
      false,
      `the standard session ${control.sessionId} got the orchestrator runtime: ${JSON.stringify(controlDiagnostics.orchestrator.installed)}`,
    )
    console.log(`   control: session ${control.sessionId} agentPreset=standard, absent from orchestrator.installed`)
  }


  console.log('11/12 Bit mode orchestrating-bit selection (routes)')
  {
    const fresh = await api('/api/bots.orchestrator')
    assert.equal(fresh.ok, true, `orchestrator selection read failed: ${JSON.stringify(fresh).slice(0, 400)}`)
    assert.equal(fresh.bitId, null, `a fresh profile still has a selected orchestrator bit: ${JSON.stringify(fresh.bitId)}`)
    assert.equal(fresh.bit, null, `a fresh profile reports a selected bit view: ${JSON.stringify(fresh.bit)}`)
    assert.ok(Array.isArray(fresh.candidates) && fresh.candidates.length >= 4, `expected the orchestrator candidates, got ${JSON.stringify(fresh.candidates)}`)
    const roleIds = new Set(fresh.candidates.map((candidate) => candidate.character ?? candidate.target))
    for (const character of ['bit-manager', 'bit-product-owner', 'bit-coordinator', 'bit-sub-coordinator']) {
      assert.ok(roleIds.has(character), `the ${character} orchestrator is missing from the picker (${[...roleIds].join(', ')})`)
    }
    for (const candidate of fresh.candidates) {
      assert.equal(typeof candidate.id, 'string', `candidate without id: ${JSON.stringify(candidate)}`)
      assert.equal(typeof candidate.target, 'string', `candidate without target: ${JSON.stringify(candidate)}`)
      assert.equal(typeof candidate.name, 'string', `candidate without name: ${JSON.stringify(candidate)}`)
      assert.ok(candidate.avatar.startsWith('/api/bots.avatar?id='), `candidate without avatar URL: ${JSON.stringify(candidate)}`)
      assert.ok(/[.!?]/.test(candidate.summary) || candidate.summary.length > 0, `candidate without an English summary: ${JSON.stringify(candidate)}`)
      assert.equal(typeof candidate.isExisting, 'boolean', `candidate without isExisting: ${JSON.stringify(candidate)}`)
      const record = (await api('/api/bots.list')).bits.find((bit) => bit.id === candidate.id)
      if (candidate.isExisting) assert.ok(record !== undefined, `existing candidate ${candidate.id} is not listed as a bit`)
      else assert.equal(record, undefined, `catalog candidate ${candidate.id} already has a bit record`)
    }
    console.log(`   candidates: ${fresh.candidates.map((candidate) => `${candidate.name}${candidate.isExisting ? '' : ' (catalog)'}`).join(', ')}`)

    const picked = await api('/api/bots.orchestrator', { body: { target: 'bit-manager' } })
    assert.equal(picked.ok, true, `selecting the Manager failed: ${JSON.stringify(picked).slice(0, 600)}`)
    assert.ok(typeof picked.bitId === 'string' && picked.bitId !== '', `selecting returned no bitId: ${JSON.stringify(picked.bitId)}`)
    assert.equal(picked.bit.name, 'Manager', `selected bit name is ${JSON.stringify(picked.bit.name)}`)
    assert.equal(picked.bit.character, 'bit-manager')
    assert.equal(picked.bit.isExisting, true)
    assert.equal(picked.bit.avatar, '/api/bots.avatar?id=bit-manager')
    const provisioned = (await api('/api/bots.list')).bits.find((bit) => bit.id === picked.bitId)
    assert.ok(provisioned !== undefined, `selecting the Manager did not provision its bit: ${picked.bitId}`)
    assert.equal(provisioned.character, 'bit-manager')
    assert.equal(provisioned.isOrchestrator, true, 'the provisioned Manager bit is not an orchestrator')
    const managerCharacter = (await api('/api/bots.catalog')).bits.find((bit) => bit.id === 'bit-manager')
    assert.equal(provisioned.model, managerCharacter.model, 'the provisioned bit lost the catalog model')
    assert.equal(provisioned.effort, managerCharacter.effort, 'the provisioned bit lost the catalog effort')
    assert.equal(provisioned.instructions, managerCharacter.instructions, 'the provisioned bit lost the catalog instructions')

    const reread = await api('/api/bots.orchestrator')
    assert.equal(reread.bitId, picked.bitId, 'the selection did not persist')
    assert.equal(reread.bit.id, picked.bitId, 'the selection view does not match the stored bit')

    const diagnostics = await api('/api/bots.diagnostics')
    assert.equal(diagnostics.orchestrator.selection.bitId, picked.bitId, 'diagnostics does not report the selected orchestrator bit')

    const worker = await api('/api/bots.orchestrator', { body: { target: 'bit-builder' } })
    assert.equal(worker.ok, false, `a worker bit was accepted as the orchestrating bit: ${JSON.stringify(worker).slice(0, 400)}`)
    assert.equal(worker.error.code, 'BIT_NOT_ORCHESTRATOR', `unexpected worker-refusal code: ${JSON.stringify(worker.error)}`)

    const unknown = await api('/api/bots.orchestrator', { body: { target: 'bit-does-not-exist' } })
    assert.equal(unknown.ok, false, `an unknown target was accepted: ${JSON.stringify(unknown).slice(0, 400)}`)
    assert.equal(unknown.error.code, 'BIT_UNKNOWN', `unexpected unknown-target code: ${JSON.stringify(unknown.error)}`)

    const cleared = await api('/api/bots.orchestrator', { body: { target: null } })
    assert.equal(cleared.ok, true, `clearing the selection failed: ${JSON.stringify(cleared).slice(0, 400)}`)
    assert.equal(cleared.bitId, null, 'clearing did not clear bitId')
    assert.equal(cleared.bit, null, 'clearing did not clear the bit view')
    assert.equal((await api('/api/bots.orchestrator')).bitId, null, 'the cleared selection still persists')
    console.log(`   selection: Manager provisioned (${provisioned.id}), worker/unknown refused, clear persisted`)
  }

  console.log('12/12 Bit mode picked on an already-created blank session')
  {
    // DSH lets a session that has not started its first turn select a preset
    // after creation: the pick is recorded as `agent-preset/selected` while the
    // frozen creation header keeps the old preset. The runtime must judge the
    // session by its effective preset, not by the header alone.
    const pickedCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bits-e2e-picked-'))
    createdDirs.push(pickedCwd)
    const blank = await remote('session/create', { request: { cwd: pickedCwd } })
    assert.ok(blank !== null && typeof blank === 'object', `picked scenario session/create returned no value: ${JSON.stringify(blank)}`)
    assert.equal(blank.agentPreset, 'standard', `picked scenario session started as ${JSON.stringify(blank.agentPreset)}`)
    const pickedId = blank.sessionId
    assert.ok(typeof pickedId === 'string' && pickedId !== '', `picked scenario returned no sessionId: ${JSON.stringify(blank).slice(0, 600)}`)

    const committed = await remote('agentPresets/select', { agentId: pickedId, agentPreset: 'bits-orchestrator' })
    assert.equal(committed, 'bits-orchestrator', `agentPresets/select committed ${JSON.stringify(committed)}`)
    let pickedEntry
    let pickedDiagnostics
    for (let attempt = 0; attempt < 60; attempt += 1) {
      pickedDiagnostics = (await api('/api/bots.diagnostics')).orchestrator
      pickedEntry = pickedDiagnostics.installed.find((entry) => entry.sessionId === pickedId)
      if (pickedEntry !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.ok(
      pickedEntry !== undefined,
      `the Bit mode picked on the blank session ${pickedId} was not instrumented: ${JSON.stringify(pickedDiagnostics).slice(0, 1200)}`,
    )
    assert.ok(
      Array.isArray(pickedEntry.tools) && pickedEntry.tools.includes('bit_delegate'),
      `picked session orchestrator tools are ${JSON.stringify(pickedEntry.tools)}`,
    )

    // Switching the still-blank session back to a normal preset drops the
    // runtime again (no section/tool left behind).
    const reverted = await remote('agentPresets/select', { agentId: pickedId, agentPreset: 'standard' })
    assert.equal(reverted, 'standard', `agentPresets/select back to standard committed ${JSON.stringify(reverted)}`)
    let stillInstalled = true
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const orchestrator = (await api('/api/bots.diagnostics')).orchestrator
      stillInstalled = orchestrator.installed.some((entry) => entry.sessionId === pickedId)
      if (!stillInstalled) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.equal(stillInstalled, false, `session ${pickedId} kept the orchestrator runtime after switching to standard`)
    console.log(`   picked on blank session: ${pickedId} instrumented as bits-orchestrator, then cleaned up on standard`)
  }

  console.log('\nE2E PASS')
}

try {
  await main()
} catch (error) {
  console.error('\nE2E FAIL')
  console.error(error)
  process.exitCode = 1
} finally {
  await cleanup()
  for (const note of cleanupNotes) console.log(`cleanup: ${note}`)
}
