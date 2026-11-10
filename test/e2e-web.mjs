#!/usr/bin/env node
/**
 * End-to-end verification for the Bits bundle (v5).
 *
 * Boots a throwaway DeepSeek Harness Web profile in an isolated DSH_HOME with
 * this bundle installed from its local directory, authenticates with the launch
 * token printed at startup, and exercises the real `/api/bots.*` routes:
 * catalog v2, bits CRUD, model catalog, worker "Executar" (request → response),
 * team templates (bits + flow), team member/lead rules, team execution error
 * paths, the projects layer and diagnostics. Also asserts that the v4 VM/chat
 * routes are gone.
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
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_DIR = path.resolve(HERE, '..')
const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? path.join(os.homedir(), '.local', 'opt', 'deepseek-harness')
const RUNTIME = path.join(INSTALL_ROOT, 'resources', 'runtime', 'primary-runtime')
const RUNTIME_NODE = path.join(RUNTIME, 'dependencies', 'node', 'bin', 'node')
const RUNTIME_PNPM = path.join(RUNTIME, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
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
  assert.ok(existsSync(path.join(profileDir, 'node_modules', '@local', 'dsh-bots')), 'bundle was not linked into the profile')
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
  console.log('1/9 install throwaway profile')
  await installProfile()
  const port = await freePort()
  console.log(`2/9 boot isolated web host on port ${port}`)
  const tokenized = await bootServer(port)
  await authenticate(tokenized)
  console.log(`   authenticated at ${origin}`)

  console.log('3/9 client bundle is served')
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
    assert.ok(!/Máquina virtual/i.test(body), 'served bundle still contains the v4 VM copy')
    console.log(`   served ${bundleHref} (${body.length} bytes)`)
  }

  console.log('4/9 bits catalog v2 + model catalog')
  {
    const catalog = await api('/api/bots.catalog')
    assert.equal(catalog.ok, true, `catalog failed: ${JSON.stringify(catalog).slice(0, 400)}`)
    assert.equal(catalog.version, 2)
    assert.ok(Array.isArray(catalog.bits) && catalog.bits.length === 52, `expected 52 bits, got ${catalog.bits?.length}`)
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
    for (const id of ['subscription/opus', 'subscription/sonnet', 'subscription/haiku']) {
      assert.ok(models.models.some((option) => option.id === id), `model catalog lacks ${id}`)
    }
    const opus = models.models.find((option) => option.id === 'subscription/opus')
    assert.equal(opus.backend, 'claude-code')
    assert.equal(opus.supportsOrchestrator, false)
    assert.deepEqual(opus.efforts, ['low', 'medium', 'high', 'xhigh', 'max'])
    console.log(`   ${catalog.bits.length} catalog bits (${orchestrators.length} orchestrators), ${models.models.length} model options`)
  }

  console.log('5/9 bits CRUD')
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
  assert.equal(builder.effort, 'high')
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

  console.log('6/9 worker Executar (request → response)')
  {
    // Orchestrators execute inside flows only.
    await expectError('/api/bots.run', { id: orchestrator.id, request: 'faça algo' }, 'BIT_IS_ORCHESTRATOR')
    // Request validation.
    await expectError('/api/bots.run', { id: builder.id, request: '' }, 'BAD_REQUEST')
    await expectError('/api/bots.run', { id: 'deadbeef01', request: 'oi' }, 'BOT_NOT_FOUND')
    // Without @dsh-burn-plugins/dsh-claude-delegate installed, the subscription backend
    // fails with an actionable coded error instead of hanging or crashing.
    if (DELEGATE_DIR === '') {
      const unavailable = await api('/api/bots.run', { body: { id: builder.id, request: 'Responda apenas: ok', readOnly: true } })
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
    const dshRun = await api('/api/bots.run', { body: { id: dshBit.bit.id, request: 'Responda apenas: ok', readOnly: true } })
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
          instructions: 'Responda em uma linha curta.',
        },
      })
      assert.equal(realBit.ok, true, `real-run bit create failed: ${JSON.stringify(realBit)}`)
      createdBitIds.push(realBit.bit.id)
      const startedAt = Date.now()
      const realRun = await api('/api/bots.run', { body: { id: realBit.bit.id, request: 'Responda exatamente: ok', readOnly: true } })
      assert.equal(realRun.ok, true, `real subscription run failed: ${JSON.stringify(realRun).slice(0, 800)}`)
      assert.equal(typeof realRun.response, 'string')
      assert.ok(realRun.response.trim().length > 0, 'real subscription run returned an empty answer')
      assert.equal(realRun.meta.backend, 'claude-code')
      assert.match(String(realRun.meta.model), /^subscription\/haiku$/)
      console.log(`   REAL subscription run answered in ${Date.now() - startedAt}ms: ${realRun.response.trim().slice(0, 80)}`)
    }
  }

  console.log('7/9 teams: templates, bit-referencing members, lead rule, run error paths')
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
          { id: 'start', type: 'start', x: 0, y: 0, label: 'Pedido' },
          { id: 'lead', type: 'step', x: 0, y: 100, label: 'Orquestrar', memberId: 'lead' },
          { id: 'builder', type: 'step', x: 0, y: 200, label: 'Implementar', memberId: 'builder' },
          { id: 'end', type: 'end', x: 0, y: 300, label: 'Entrega' },
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

  console.log('8/9 projects layer (unchanged)')
  {
    const none = await api('/api/bots.projects')
    assert.equal(none.ok, true, `projects list failed: ${JSON.stringify(none)}`)
    assert.deepEqual(none.projects, [])

    const first = await api('/api/bots.projects.create', {
      body: {
        project: {
          name: '  E2E Project  ',
          description: 'Projeto de verificação end-to-end.',
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
    assert.equal(project.description, 'Projeto de verificação end-to-end.')
    assert.equal(project.emoji, '📁')
    assert.equal(project.color, '#2563eb')

    const second = await api('/api/bots.projects.create', {
      body: { project: { name: 'E2E Second', description: 'Outro projeto.', emoji: '🧪', color: '#16a34a' } },
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

  console.log('9/9 diagnostics + removed v4 surface')
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
