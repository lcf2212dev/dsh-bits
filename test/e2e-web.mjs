#!/usr/bin/env node
/**
 * End-to-end verification for the Bots bundle.
 *
 * Boots a throwaway DeepSeek Harness Web profile in an isolated DSH_HOME with
 * this bundle installed from its local directory, authenticates with the
 * launch token printed at startup, and exercises the real `/api/bots.*`
 * routes (CRUD + Docker VM lifecycle) plus the served client bundle URL.
 *
 * Nothing here touches the user's `~/.dsh`, the running Desktop profile, or
 * the workspace registry of the real installation. The only shared resource
 * is the local Docker daemon, and every container created is labelled and
 * removed again.
 *
 * Usage: node test/e2e-web.test.mjs
 * Env:   DSH_INSTALL_ROOT (default ~/.local/opt/deepseek-harness)
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
const TEST_IMAGE = 'ubuntu:24.04'

/** @type {string[]} */
const cleanupNotes = []
let bootChild
let bootOutput = ''
let tempHome
let createdBotId
let createdSessionId
let origin
let cookie

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
 * local bundle.
 *
 * @returns {Promise<void>} resolves when the profile is installed.
 */
async function installProfile() {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bots-e2e-home-'))
  const profileDir = path.join(tempHome, 'profiles', PROFILE)
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(path.join(profileDir, 'cordis.yml'), '# e2e profile\n[]\n')
  await fs.writeFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  await fs.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-bots-e2e',
    private: true,
    dependencies: {
      '@local/dsh-bots': `file:${BUNDLE_DIR}`,
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          '@local/dsh-bots',
        ],
      },
    },
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
      bootOutput += String(chunk)
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
 * Call one Gateway Remote endpoint through the authenticated HTTP bridge.
 *
 * @param {string} endpoint Remote endpoint such as `session/create`.
 * @param {object} payload named-argument payload.
 * @returns {Promise<any>} the decoded `value` of a successful result.
 */
async function remote(endpoint, payload) {
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: endpoint,
      payload: { args: payload },
    }),
  })
  const text = await response.text()
  assert.equal(response.status, 200, `${endpoint} answered HTTP ${response.status}: ${text.slice(0, 400)}`)
  const body = JSON.parse(text)
  assert.equal(body.type, 'server-response', `${endpoint} answered a non-response envelope: ${text.slice(0, 400)}`)
  const result = body.result
  if (result.ok !== true) {
    assert.fail(`${endpoint} failed: ${JSON.stringify(result.error ?? result).slice(0, 800)}`)
  }
  return result.value
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
  assert.equal(response.status, 200, `${routePath} answered HTTP ${response.status}: ${text}`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    assert.fail(`${routePath} did not answer JSON: ${text.slice(0, 400)}`)
  }
  return payload
}

/**
 * Read one bot's live VM state from the list route.
 *
 * @param {string} id bot id.
 * @returns {Promise<object>} BotView for the id.
 */
async function botView(id) {
  const listed = await api('/api/bots.list')
  assert.equal(listed.ok, true, `list failed: ${JSON.stringify(listed)}`)
  const view = listed.bots.find((bot) => bot.id === id)
  assert.ok(view !== undefined, `bot ${id} missing from list`)
  return view
}

/**
 * Poll one bot until its VM reaches a state.
 *
 * @param {string} id bot id.
 * @param {(state: string) => boolean} predicate state test.
 * @param {number} timeoutMs deadline.
 * @returns {Promise<object>} the matching BotView.
 */
async function waitForVmState(id, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  let view = await botView(id)
  while (!predicate(view.vmStatus?.state ?? 'missing')) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for VM state; last state ${JSON.stringify(view.vmStatus)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
    view = await botView(id)
  }
  return view
}

/**
 * Remove every test container this run created.
 *
 * @returns {Promise<void>} resolves after best-effort cleanup.
 */
async function cleanupContainers() {
  if (createdBotId !== undefined) {
    try {
      await run('docker', ['rm', '-f', `dsh-bot-${createdBotId}`], { timeoutMs: 30000 })
    } catch {
      // Best effort.
    }
  }
  // Also remove anything else this suite may have left behind by label.
  try {
    const listed = await run('docker', ['ps', '--format', '{{.Names}}', '--filter', 'label=dsh.bots.managed=true'], { timeoutMs: 30000 })
    for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
      await run('docker', ['rm', '-f', name], { timeoutMs: 30000 })
    }
  } catch {
    // Best effort.
  }
}

/**
 * Stop the booted host and delete the throwaway home.
 *
 * @returns {Promise<void>} resolves after cleanup.
 */
async function cleanup() {
  await cleanupContainers()
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
  if (!existsSync(path.join(BUNDLE_DIR, 'host', 'vm.js'))) {
    throw new Error(`bundle is incomplete at ${BUNDLE_DIR}`)
  }
  console.log(`bundle: ${BUNDLE_DIR}`)
  console.log(`install root: ${INSTALL_ROOT}`)
  console.log('1/6 install throwaway profile')
  await installProfile()
  const port = await freePort()
  console.log(`2/6 boot isolated web host on port ${port}`)
  const tokenized = await bootServer(port)
  await authenticate(tokenized)
  console.log(`   authenticated at ${origin}`)

  console.log('3/6 client bundle is served')
  {
    const indexResponse = await fetch(`${origin}/`, { headers: { cookie } })
    assert.equal(indexResponse.status, 200, `index answered HTTP ${indexResponse.status}`)
    const indexHtml = await indexResponse.text()
    const hrefs = [...indexHtml.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((match) => match[1].replaceAll('&amp;', '&'))
      .filter((href) => href.includes('@local/dsh-bots/client.js'))
    assert.ok(hrefs.length > 0, 'the boot payload does not reference the Bots client bundle')
    const bundleHref = hrefs.find((href) => href.includes('??')) ?? hrefs[0]
    const response = await fetch(new URL(bundleHref, `${origin}/`), { headers: { cookie } })
    assert.equal(response.status, 200, `client bundle ${bundleHref} answered HTTP ${response.status}`)
    const body = await response.text()
    assert.ok(body.includes('__ModuleLoader__'), 'served bundle does not contain the module loader registration')
    assert.ok(body.includes('@local/dsh-bots'), 'served bundle does not register the bundle id')
    assert.ok(body.includes('Bots'), 'served bundle does not contain the Bots page code')
    console.log(`   served ${bundleHref} (${body.length} bytes)`)
  }

  console.log('4/6 docker discovery + images')
  {
    const docker = await api('/api/bots.docker')
    assert.equal(docker.ok, true, `docker probe failed: ${JSON.stringify(docker)}`)
    assert.equal(docker.available, true, `docker unavailable: ${JSON.stringify(docker)}`)
    assert.equal(typeof docker.version, 'string')
    const images = await api('/api/bots.images')
    assert.equal(images.ok, true)
    assert.ok(Array.isArray(images.images), 'images route returned no list')
    assert.ok(images.images.some((image) => `${image.name}:${image.tag}` === TEST_IMAGE), `local image ${TEST_IMAGE} missing from discovery`)
  }

  console.log('5/6 bot CRUD')
  let listed = await api('/api/bots.list')
  assert.equal(listed.ok, true)
  assert.ok(Array.isArray(listed.bots))
  const baselineCount = listed.bots.length

  const created = await api('/api/bots.create', {
    body: {
      name: 'E2E Bot',
      emoji: '🤖',
      instructions: 'You are the end-to-end verification bot.',
      vm: { enabled: true, image: TEST_IMAGE },
    },
  })
  assert.equal(created.ok, true, `create failed: ${JSON.stringify(created)}`)
  assert.equal(created.bot.name, 'E2E Bot')
  assert.match(created.bot.id, /^[0-9a-f]{10}$/)
  assert.equal(created.bot.vm.enabled, true)
  assert.equal(created.bot.vm.image, TEST_IMAGE)
  assert.ok(typeof created.bot.workspaceDir === 'string' && path.isAbsolute(created.bot.workspaceDir))
  assert.ok(typeof created.bot.workspaceId === 'string' && created.bot.workspaceId.length > 0, 'bot has no registered workspace id')
  createdBotId = created.bot.id
  await fs.access(created.bot.workspaceDir)

  listed = await api('/api/bots.list')
  assert.equal(listed.bots.length, baselineCount + 1)

  const updated = await api('/api/bots.update', {
    body: { id: createdBotId, patch: { name: 'E2E Bot Renamed', instructions: 'Updated instructions.' } },
  })
  assert.equal(updated.ok, true, `update failed: ${JSON.stringify(updated)}`)
  assert.equal(updated.bot.name, 'E2E Bot Renamed')
  assert.equal(updated.bot.instructions, 'Updated instructions.')

  const unknown = await api('/api/bots.update', { body: { id: 'deadbeef01', patch: { name: 'nope' } } })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'BOT_NOT_FOUND')

  const badRequest = await api('/api/bots.create', { body: { name: '' } })
  assert.equal(badRequest.ok, false)
  assert.ok(typeof badRequest.error.code === 'string')

  console.log('5b/7 create a chat session in the bot workspace (real Agent setup)')
  {
    const createdSession = await remote('session/create', { request: { workspaceId: created.bot.workspaceId } })
    assert.ok(typeof createdSession.sessionId === 'string' && createdSession.sessionId.length > 0, 'session/create returned no sessionId')
    // Agent creation is dispatched as a serial `agent/created` event; give the
    // persona/VM integration a moment to attach, then read its diagnostics.
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const diagnostics = await api('/api/bots.diagnostics')
    assert.equal(diagnostics.ok, true, 'diagnostics route failed')
    assert.equal(diagnostics.storeReady, true)
    assert.deepEqual(diagnostics.errors, [], `bot integration reported failures: ${JSON.stringify(diagnostics.errors)}`)
    const attachedAgent = diagnostics.agents.find((entry) => entry.id === createdSession.sessionId)
    assert.ok(attachedAgent !== undefined, `the new Agent did not attach to its bot. Diagnostics: ${JSON.stringify(diagnostics)}`)
    assert.equal(attachedAgent.botId, createdBotId)
    assert.equal(attachedAgent.vmEnabled, true)
    for (const name of ['vm_bash', 'notify_user', 'schedule_create', 'schedule_list', 'schedule_edit']) {
      assert.ok(attachedAgent.tools.includes(name), `bot agent lacks ${name}; tools: ${JSON.stringify(attachedAgent.tools)}`)
    }
    assert.ok(!attachedAgent.tools.includes('bash'), 'VM bot agent still sees the host bash tool')
    // The notification route is wired (an unknown bot never shows a notification).
    const notifyUnknown = await fetch(`${origin}/api/bots.notify-test`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'deadbeef01' }),
    }).then((response) => response.json())
    assert.equal(notifyUnknown.ok, false)
    assert.equal(notifyUnknown.error.code, 'BOT_NOT_FOUND')
    createdSessionId = createdSession.sessionId
    console.log(`   session ${createdSession.sessionId} created; bot agent attached (persona + host shell restriction + vm_bash)`)
  }

  console.log('5d/7 a scheduled task fires into a new session that runs as the bot')
  {
    const before = (await api('/api/bots.diagnostics')).agents.filter((entry) => entry.botId === createdBotId).map((entry) => entry.id)
    const task = await remote('schedule/create', {
      request: {
        title: 'Lembrete de teste do bot',
        prompt: 'Scheduled reminder: call notify_user with "teste" and reply with one short line.',
        timing: { kind: 'after', after_seconds: 3 },
        target: { kind: 'new', create: { cwd: created.bot.workspaceDir } },
      },
    })
    const taskId = task.id ?? task.task?.id
    assert.ok(typeof taskId === 'string', `schedule/create returned no id: ${JSON.stringify(task).slice(0, 300)}`)
    let fired
    const deadline = Date.now() + 45000
    while (Date.now() < deadline && fired === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const diagnostics = await api('/api/bots.diagnostics')
      fired = diagnostics.agents.find((entry) => entry.botId === createdBotId && !before.includes(entry.id))
    }
    assert.ok(fired !== undefined, 'the scheduled task did not open a session attached to the bot')
    assert.ok(fired.tools.includes('notify_user'), `scheduled bot session lacks notify_user: ${JSON.stringify(fired.tools)}`)
    assert.ok(fired.personaOk, 'scheduled bot session got no persona')
    console.log(`   task ${taskId} fired; session ${fired.id} runs as the bot with notify_user`)
    try {
      await remote('schedule/edit', { request: { id: taskId, action: 'delete' } })
    } catch {
      // A fired one-shot task may already be ended; cleanup is best-effort.
    }
  }

  console.log('5c/7 live VM toggle refreshes the running Agent (M1)')
  {
    // Disable the VM on the bot while its Agent is live: the host integration
    // must lift the shell restriction immediately.
    const disabled = await api('/api/bots.update', { body: { id: createdBotId, patch: { vm: { enabled: false } } } })
    assert.equal(disabled.ok, true, `vm disable failed: ${JSON.stringify(disabled)}`)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    let diagnostics = await api('/api/bots.diagnostics')
    let attachedAgent = diagnostics.agents.find((entry) => entry.id === createdSessionId)
    assert.ok(attachedAgent !== undefined, 'agent lost from diagnostics after VM toggle')
    assert.equal(attachedAgent.vmEnabled, false, 'live Agent still reports VM enabled after disabling the bot VM')
    assert.equal(attachedAgent.restricted, false, 'host shell restriction survived disabling the VM')
    assert.deepEqual(diagnostics.errors, [], `VM toggle reported integration errors: ${JSON.stringify(diagnostics.errors)}`)

    // Re-enable the VM: the restriction must come back for the live Agent.
    const enabled = await api('/api/bots.update', { body: { id: createdBotId, patch: { vm: { enabled: true } } } })
    assert.equal(enabled.ok, true, `vm re-enable failed: ${JSON.stringify(enabled)}`)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    diagnostics = await api('/api/bots.diagnostics')
    attachedAgent = diagnostics.agents.find((entry) => entry.id === createdSessionId)
    assert.ok(attachedAgent !== undefined)
    assert.equal(attachedAgent.vmEnabled, true, 'live Agent did not pick up the re-enabled VM')
    assert.equal(attachedAgent.restricted, true, 'host shell restriction was not re-installed for the live Agent')
    assert.deepEqual(diagnostics.errors, [])
    console.log('   live Agent refreshed on VM disable and re-enable')
  }

  console.log('6/6 VM lifecycle')
  {
    const before = await botView(createdBotId)
    assert.ok(['missing', 'created', 'exited', 'stopped', 'running'].includes(before.vmStatus.state), `unexpected initial state ${before.vmStatus.state}`)

    const started = await api('/api/bots.vm', { body: { id: createdBotId, action: 'start' } })
    assert.equal(started.ok, true, `vm start failed: ${JSON.stringify(started)}`)
    const running = await waitForVmState(createdBotId, (state) => state === 'running')
    assert.equal(running.vmStatus.running, true)
    assert.equal(running.vmStatus.containerName, `dsh-bot-${createdBotId}`)

    const pinged = await run('docker', ['exec', `dsh-bot-${createdBotId}`, 'sh', '-lc', 'echo bot-vm-ok'], { timeoutMs: 30000 })
    assert.equal(pinged.code, 0, `docker exec failed: ${pinged.stderr}`)
    assert.match(pinged.stdout, /bot-vm-ok/)

    const workspaceProbe = await run('docker', ['exec', `dsh-bot-${createdBotId}`, 'sh', '-lc', 'pwd'], { timeoutMs: 30000 })
    assert.equal(workspaceProbe.code, 0)
    assert.equal(workspaceProbe.stdout.trim(), created.bot.workspaceDir, 'VM did not start in the bot workspace')

    const stopped = await api('/api/bots.vm', { body: { id: createdBotId, action: 'stop' } })
    assert.equal(stopped.ok, true, `vm stop failed: ${JSON.stringify(stopped)}`)
    await waitForVmState(createdBotId, (state) => state !== 'running')

    const restarted = await api('/api/bots.vm', { body: { id: createdBotId, action: 'start' } })
    assert.equal(restarted.ok, true)
    await waitForVmState(createdBotId, (state) => state === 'running')

    const removed = await api('/api/bots.vm', { body: { id: createdBotId, action: 'remove' } })
    assert.equal(removed.ok, true, `vm remove failed: ${JSON.stringify(removed)}`)
    const afterRemove = await waitForVmState(createdBotId, (state) => state === 'missing')
    assert.equal(afterRemove.vmStatus.running, false)
    // The bot record and its workspace survive a VM removal.
    await fs.access(created.bot.workspaceDir)
  }

  console.log('7/7 delete bot')
  {
    const deleted = await api('/api/bots.delete', { body: { id: createdBotId, deleteWorkspace: true } })
    assert.equal(deleted.ok, true, `delete failed: ${JSON.stringify(deleted)}`)
    assert.equal(deleted.workspaceRemoved, true)
    await assert.rejects(fs.access(created.bot.workspaceDir), 'workspace directory still exists after delete')
    listed = await api('/api/bots.list')
    assert.equal(listed.bots.length, baselineCount, 'bot list did not return to baseline')
    createdBotId = undefined
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
