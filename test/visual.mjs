#!/usr/bin/env node
/**
 * Visual + interaction check for the Bits tab (V5-CONTRACT.md §8).
 *
 * Boots a throwaway DSH Web host (isolated DSH_HOME, never the user's profile)
 * with this bundle, seeds sample bits through the real routes, then drives a
 * headless Chrome over the DevTools Protocol to capture screenshots of:
 *   1. the bit list, 2. the bit picker, 3. the filtered picker, 4. the form
 *   prefilled from a bit, 5. the edit dialog, 6. the Run dialog, 7. delete.
 * Before that it covers the new-session hero: it switches the preset to
 * "Bit mode", checks the orchestrating-bit chip sits right after the mode chip,
 * captures the candidate menu (avatar + name + description), and picks the
 * catalog Coordinator (asserting the Host provisioned the bit and persisted it).
 * Hero screenshots use the `bit-*` prefix so the Bit page numbering stays put.
 * It creates one bit through the UI, checks the v5 record fields through the API,
 * runs a worker ad-hoc (checking `readOnly` reached the route) and asserts the
 * orchestrator card does not offer the ad-hoc Run action.
 * Screenshots land in `test/screenshots/` (light or dark via --theme).
 *
 * Usage: node test/visual.mjs [--theme dark|light] [--width 1440] [--height 900]
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_DIR = path.resolve(HERE, '..')
const OUT_DIR = path.join(HERE, 'screenshots')
const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? path.join(os.homedir(), '.local', 'opt', 'deepseek-harness')
const RUNTIME = path.join(INSTALL_ROOT, 'resources', 'runtime', 'primary-runtime')
const RUNTIME_NODE = path.join(RUNTIME, 'dependencies', 'node', 'bin', 'node')
const RUNTIME_PNPM = path.join(RUNTIME, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome-stable'
const PROFILE = 'bots-visual'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const THEME = option('theme', 'dark')
const WIDTH = Number(option('width', '1440'))
const HEIGHT = Number(option('height', '900'))

let tempHome
let host
let chrome
let chromeDir
let origin
let cookie

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { out += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} timed out`)) }, options.timeoutMs ?? 300000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }) })
  })
}

async function installProfile() {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bits-visual-home-'))
  const dir = path.join(tempHome, 'profiles', PROFILE)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'cordis.yml'), '[]\n')
  await fs.writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-bits-visual',
    private: true,
    dependencies: { '@dsh-burn-plugins/dsh-bots': `file:${BUNDLE_DIR}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-burn-plugins/dsh-bots'] } },
  }, null, 2))
  // Pin the UI language so screenshots are deterministic.
  await fs.writeFile(path.join(dir, 'cordis.patch.yml'), `- id: locale\n  name: '@deepseek-ai/dsh-client-locale'\n  config:\n    preference: ${option('lang', 'en')}\n`)
  const installed = await run(RUNTIME_NODE, [RUNTIME_PNPM, 'install', '--silent'], { cwd: dir, env: { ...process.env, DSH_HOME: tempHome } })
  assert.equal(installed.code, 0, installed.out)
}

function bootHost(port) {
  return new Promise((resolve, reject) => {
    host = spawn('dsh', ['--profile', PROFILE, '--no-open', '--port', String(port)], {
      env: { ...process.env, DSH_HOME: tempHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`host did not start:\n${buffer}`)), 120000)
    const onData = (chunk) => {
      buffer += chunk
      const match = buffer.match(/dsh web: (http:\/\/\S+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    }
    host.stdout.on('data', onData)
    host.stderr.on('data', onData)
    host.on('exit', (code) => reject(new Error(`host exited ${code}:\n${buffer}`)))
  })
}

async function api(route, body) {
  const response = await fetch(`${origin}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json()
  assert.equal(payload.ok, true, `${route}: ${JSON.stringify(payload)}`)
  return payload
}

/**
 * Call one remote endpoint through the authenticated HTTP bridge, using the
 * same `client-request`/`server-response` envelope the Web client uses.
 *
 * @param {string} endpoint remote method name, e.g. `session/prompt`.
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
  const payload = JSON.parse(text)
  assert.equal(payload.type, 'server-response', `${endpoint} answered an unexpected envelope: ${text.slice(0, 400)}`)
  assert.equal(payload.result.ok, true, `${endpoint} failed: ${JSON.stringify(payload.result).slice(0, 800)}`)
  return payload.result.value
}

/** Minimal Chrome DevTools Protocol client over Node's global WebSocket. */
async function openCdp(port) {
  let targets
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      if (targets.some((target) => target.type === 'page')) break
    } catch {
      // Chrome still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const page = targets.find((target) => target.type === 'page')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let nextId = 1
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { send, close: () => socket.close() }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails).slice(0, 600)}`)
  return result.result.value
}

async function waitFor(cdp, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function screenshot(cdp, name) {
  await new Promise((resolve) => setTimeout(resolve, 400))
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(OUT_DIR, `${THEME}-${name}.png`)
  await fs.writeFile(file, Buffer.from(data, 'base64'))
  console.log(`   saved ${path.relative(BUNDLE_DIR, file)}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function setInput(cdp, selector, text) {
  await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(120)
}

async function setSelect(cdp, selector, value) {
  await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await sleep(150)
}

async function clickButtonByText(cdp, scope, regex) {
  const ok = await evaluate(cdp, `(() => {
    const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document'}
    if (!root) return false
    const button = [...root.querySelectorAll('button')].find((el) => new RegExp(${JSON.stringify(regex)}).test((el.textContent || '').trim()))
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.ok(ok, `button ${regex} in ${scope || 'document'}`)
  await sleep(200)
}

/**
 * Dismiss the profile's startup modals: the versioned preview notice
 * ("Continue") and the API-key onboarding ("Get started", closed with X).
 * While one is open the app behind it is inert, so even programmatic clicks on
 * the hero are ignored; this must run before interacting with the first screen.
 */
async function dismissStartupModals(cdp) {
  const modalOpen = `[...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].some((el) => !el.closest('.dsh-bots-root'))`
  for (let round = 0; round < 6; round += 1) {
    if (!(await evaluate(cdp, `Boolean(${modalOpen})`))) return true
    await evaluate(cdp, `(() => {
      const outside = (el) => !el.closest('.dsh-bots-root')
      const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(outside)
      for (const dialog of dialogs) {
        const primary = [...dialog.querySelectorAll('button')].find((el) => /^(Continue|Got it|Dismiss)$/i.test((el.textContent || '').trim()))
        if (primary) { primary.click(); return }
        const close = [...dialog.querySelectorAll('button[aria-label]')].find((el) => /close/i.test(el.getAttribute('aria-label')))
        if (close) { close.click(); return }
      }
    })()`)
    await sleep(600)
  }
  return !(await evaluate(cdp, `Boolean(${modalOpen})`))
}

async function main() {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}`)
  await fs.mkdir(OUT_DIR, { recursive: true })
  console.log('1/5 profile + host')
  await installProfile()
  const tokenUrl = await bootHost(await freePort())
  const exchange = await fetch(tokenUrl, { redirect: 'manual' })
  cookie = exchange.headers.getSetCookie()[0].split(';', 1)[0]
  origin = new URL(tokenUrl).origin

  console.log('2/5 seed bits')
  const { bits: catalogBits } = await api('/api/bots.catalog')
  assert.equal(catalogBits.length, 53, 'catalog served by the real host')
  const bit = (id) => catalogBits.find((entry) => entry.id === id)
  const createBit = async (fields) => (await api('/api/bots.create', fields)).bit

  const scout = await createBit({
    name: 'Scout',
    character: 'bit-scout',
    emoji: bit('bit-scout').emoji,
    color: bit('bit-scout').color,
    instructions: bit('bit-scout').instructions,
  })
  const builder = await createBit({
    name: 'Builder',
    character: 'bit-builder',
    emoji: bit('bit-builder').emoji,
    color: bit('bit-builder').color,
    instructions: bit('bit-builder').instructions,
  })
  // Orchestrator: runs inside flows (Teams) and is offered as a team lead.
  const orchestrator = await createBit({
    name: 'App PO',
    character: 'bit-product-owner',
    emoji: bit('bit-product-owner').emoji,
    color: bit('bit-product-owner').color,
    instructions: bit('bit-product-owner').instructions,
    isOrchestrator: true,
    model: 'deepseek-account/deepseek-flash',
    effort: 'max',
  })
  // A bit created before catalog characters existed keeps its emoji avatar.
  const legacy = await createBit({
    name: 'Legacy',
    emoji: '🦊',
    color: '#ea580c',
    instructions: 'Old bit, no character.',
    isOrchestrator: false,
    model: 'subscription/sonnet',
    effort: 'high',
  })
  assert.equal(legacy.character, null)

  // A flow led by the orchestrator bit: the card lists "Lead of: PO Flow".
  const { team: leadTeam } = await api('/api/bots.teams.create', {
    team: {
      name: 'PO Flow',
      emoji: '🎯',
      color: '#7243aa',
      members: [{ id: 'po', bitId: orchestrator.id, role: 'Orchestrates the request', access: 'read' }],
      lead: 'po',
      flow: {
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0, label: 'Request' },
          { id: 'po', type: 'step', x: 0, y: 96, label: 'Coordinate', memberId: 'po' },
        ],
        edges: [{ id: 'e1', from: 'start', to: 'po', label: '', kind: 'flow' }],
      },
    },
  })
  assert.equal(leadTeam.lead, 'po')

  console.log('3/5 chrome')
  const cdpPort = await freePort()
  chromeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bits-visual-chrome-'))
  chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${chromeDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--window-size=${WIDTH},${HEIGHT}`, 'about:blank',
  ], { stdio: 'ignore' })
  const cdp = await openCdp(cdpPort)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: THEME }] })
  await cdp.send('Network.enable')
  await cdp.send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: origin })
  await cdp.send('Page.navigate', { url: `${origin}/` })

  // --- Hero: Bit mode chip + orchestrating-bit picker --------------------
  // A fresh profile opens on the new-session hero. The Bit mode preset owns a
  // second chip right after the mode chip; its menu lists the orchestrating
  // candidates (the seeded App PO bit + catalog characters) with avatar, name
  // and description, and picking one persists the choice on the Host.
  console.log('4/5 hero: Bit mode chip')
  const presetButton = `document.querySelector('[data-slot="conversation.hero.agentPreset"] button')`
  await waitFor(cdp, presetButton, 'hero preset chip', 60000)
  console.log('   startup modals dismissed:', await dismissStartupModals(cdp))

  const presetLabel = await evaluate(cdp, `(${presetButton}).textContent`)
  console.log('   current preset:', presetLabel.trim())
  let presetMenuOpen = false
  for (let attempt = 0; attempt < 3 && !presetMenuOpen; attempt += 1) {
    await evaluate(cdp, `${presetButton}.click()`)
    try {
      await waitFor(cdp, `document.querySelector('[role="menu"] [role="menuitem"]')`, 'preset picker menu', 5000)
      presetMenuOpen = true
    } catch (error) {
      await sleep(400)
    }
  }
  assert.ok(presetMenuOpen, 'the hero preset picker menu opens')
  const pickedBitMode = await evaluate(cdp, `(() => {
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]')]
    const item = items.find((el) => /Bit mode/i.test(el.textContent || ''))
    if (!item) return false
    item.click()
    return true
  })()`)
  assert.ok(pickedBitMode, 'the preset picker offers Bit mode')
  const chipSelector = '[data-slot="conversation.hero.options"] .dsh-bots-mode-chip'
  await waitFor(cdp, `document.querySelector(${JSON.stringify(chipSelector)})`, 'Bit mode chip', 30000)
  await waitFor(cdp, `document.querySelector('.dsh-bots-mode-root') && document.querySelector('.dsh-bots-mode-root').getAttribute('data-bots-mode-phase') === 'ready'`, 'Bit mode chip loaded', 30000)
  const chipEmptyLabel = await evaluate(cdp, `document.querySelector(${JSON.stringify(chipSelector)}).textContent`)
  assert.ok(/Choose bit/i.test(chipEmptyLabel), `empty chip label: ${chipEmptyLabel}`)
  const chipEmptyAvatar = await evaluate(cdp, `(() => {
    const img = document.querySelector(${JSON.stringify(chipSelector)}).querySelector('img')
    return img ? { src: img.getAttribute('src'), width: img.naturalWidth } : null
  })()`)
  assert.ok(chipEmptyAvatar && /bit-mascot/.test(chipEmptyAvatar.src) && chipEmptyAvatar.width > 0, `empty chip shows the mascot avatar: ${JSON.stringify(chipEmptyAvatar)}`)

  // Placement: the chip sits immediately after the mode chip in the same row.
  const geometry = await evaluate(cdp, `(() => {
    const preset = ${presetButton}.getBoundingClientRect()
    const chip = document.querySelector(${JSON.stringify(chipSelector)}).getBoundingClientRect()
    const row = document.querySelector('[data-slot="conversation.hero.agentPreset"]').parentElement.getBoundingClientRect()
    return {
      preset: { left: preset.left, right: preset.right, top: preset.top, bottom: preset.bottom, centerY: (preset.top + preset.bottom) / 2 },
      chip: { left: chip.left, right: chip.right, top: chip.top, bottom: chip.bottom, centerY: (chip.top + chip.bottom) / 2 },
      row: { left: row.left, right: row.right, top: row.top, bottom: row.bottom },
    }
  })()`)
  console.log('   hero geometry', JSON.stringify(geometry))
  assert.ok(geometry.chip.left >= geometry.preset.right, `bit chip sits after the mode chip: ${JSON.stringify(geometry)}`)
  assert.ok(geometry.chip.left - geometry.preset.right <= 40, `bit chip keeps a small gap after the mode chip: ${JSON.stringify(geometry)}`)
  assert.ok(Math.abs(geometry.chip.centerY - geometry.preset.centerY) <= 8, `bit chip aligns with the mode chip: ${JSON.stringify(geometry)}`)
  assert.ok(geometry.chip.top >= geometry.row.top - 1 && geometry.chip.bottom <= geometry.row.bottom + 1, `bit chip stays inside the hero row: ${JSON.stringify(geometry)}`)
  await screenshot(cdp, 'bit-1-mode')

  // Menu: generic row first, then App PO + the three catalog orchestrators.
  await evaluate(cdp, `document.querySelector(${JSON.stringify(chipSelector)}).click()`)
  await waitFor(cdp, `document.querySelector('.dsh-bots-mode-menu')`, 'bit picker menu')
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-mode-item').length === 5`, 'bit picker rows', 30000)
  await waitFor(cdp, `[...document.querySelectorAll('.dsh-bots-mode-item img')].length >= 4 && [...document.querySelectorAll('.dsh-bots-mode-item img')].every((img) => img.complete && img.naturalWidth > 0)`, 'bit picker avatars', 30000)
  const menuRows = await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-mode-item')].map((row) => ({
    name: row.querySelector('.dsh-bots-mode-item-name') ? row.querySelector('.dsh-bots-mode-item-name').textContent.trim() : '',
    summary: row.querySelector('.dsh-bots-mode-item-summary') ? row.querySelector('.dsh-bots-mode-item-summary').textContent.trim() : '',
    target: row.getAttribute('data-target'),
    generic: row.getAttribute('data-generic') === 'true',
    checked: row.getAttribute('aria-checked'),
    avatar: row.querySelector('img') ? { src: row.querySelector('img').getAttribute('src'), width: row.querySelector('img').naturalWidth } : null,
  }))`)
  console.log('   bit candidates', JSON.stringify(menuRows.map((row) => row.name)))
  assert.equal(menuRows.length, 5, `five orchestrating options: ${JSON.stringify(menuRows.map((row) => row.name))}`)
  assert.equal(menuRows[0].generic, true, 'the generic option is the first row')
  assert.equal(menuRows[0].name, 'No specific bit')
  assert.ok(menuRows[0].summary.length > 0, 'the generic option carries its hint')
  assert.equal(menuRows[0].checked, 'true', 'generic option checked while no bit is selected')
  assert.ok(menuRows[0].avatar && /bit-mascot/.test(menuRows[0].avatar.src) && menuRows[0].avatar.width > 0, `generic option shows the mascot avatar: ${JSON.stringify(menuRows[0].avatar)}`)
  const candidateNames = menuRows.filter((row) => !row.generic).map((row) => row.name)
  for (const expected of ['App PO', 'Manager', 'Coordinator', 'Sub-coordinator']) {
    assert.ok(candidateNames.includes(expected), `candidate ${expected} listed: ${candidateNames.join(', ')}`)
  }
  for (const row of menuRows.filter((entry) => !entry.generic)) {
    assert.ok(row.avatar && row.avatar.width > 0, `avatar loaded for ${row.name}: ${JSON.stringify(row.avatar)}`)
    assert.ok(row.summary.length > 0, `description for ${row.name}`)
    assert.ok(row.target && row.target.length > 0, `selection target for ${row.name}`)
  }
  await screenshot(cdp, 'bit-2-menu')

  // Pick a catalog-only candidate: the Host provisions the bit and persists it.
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-mode-item')].find((row) => row.getAttribute('data-target') === 'bit-coordinator').click()`)
  await waitFor(cdp, `!document.querySelector('.dsh-bots-mode-menu')`, 'bit picker menu closed after pick', 30000)
  await waitFor(cdp, `document.querySelector(${JSON.stringify(chipSelector)}) && /Coordinator/.test(document.querySelector(${JSON.stringify(chipSelector)}).textContent)`, 'chip shows the picked bit', 30000)
  await waitFor(cdp, `document.querySelector('.dsh-bots-mode-root') && document.querySelector('.dsh-bots-mode-root').getAttribute('data-bots-mode-phase') === 'ready'`, 'chip settled after pick', 30000)
  const chipPicked = await evaluate(cdp, `(() => {
    const chip = document.querySelector(${JSON.stringify(chipSelector)})
    const img = chip.querySelector('img')
    return { label: chip.textContent, expanded: chip.getAttribute('aria-expanded'), avatar: img ? { src: img.getAttribute('src'), width: img.naturalWidth } : null }
  })()`)
  assert.ok(/Coordinator/.test(chipPicked.label), `chip label follows the pick: ${JSON.stringify(chipPicked)}`)
  assert.equal(chipPicked.expanded, 'false', 'menu closed after the pick')
  assert.ok(chipPicked.avatar && chipPicked.avatar.width > 0, `chip avatar loaded: ${JSON.stringify(chipPicked.avatar)}`)

  const orchestratorView = await api('/api/bots.orchestrator')
  assert.ok(orchestratorView.bitId, `selection persisted: ${JSON.stringify(orchestratorView)}`)
  assert.equal(orchestratorView.bit.name, 'Coordinator')
  assert.equal(orchestratorView.bit.isExisting, true)
  const provisioned = (await api('/api/bots.list')).bits.find((entryBit) => entryBit.id === orchestratorView.bitId)
  assert.ok(provisioned, `catalog pick provisions the bit: ${JSON.stringify(orchestratorView.bitId)}`)
  assert.equal(provisioned.name, 'Coordinator')
  assert.equal(provisioned.character, 'bit-coordinator')
  assert.equal(provisioned.isOrchestrator, true, 'the provisioned bit can orchestrate')
  assert.equal(provisioned.model, bit('bit-coordinator').model, 'catalog model')
  assert.equal(provisioned.effort, bit('bit-coordinator').effort, 'catalog effort')
  const persisted = await api('/api/bots.orchestrator')
  assert.equal(persisted.bitId, orchestratorView.bitId, 'selection survives a second GET')
  const persistedNames = persisted.candidates.map((row) => row.name)
  for (const expected of ['App PO', 'Manager', 'Coordinator', 'Sub-coordinator']) {
    assert.ok(persistedNames.includes(expected), `candidate ${expected} still listed: ${persistedNames.join(', ')}`)
  }
  const coordinatorCandidate = persisted.candidates.find((row) => row.name === 'Coordinator')
  assert.equal(coordinatorCandidate.isExisting, true, 'the provisioned bit joins the candidates')

  await screenshot(cdp, 'bit-3-selected')

  // Existing-conversation seat: after the Bit-mode chat gets its first message
  // the hero (and its chip) unmount, and a compact chip appears in the session
  // header next to the read-only "Bit mode" label, so the orchestrating bit can
  // still be seen and switched mid-conversation.
  console.log('   in-conversation bit chip')
  const heroChipSession = await evaluate(cdp, `(() => {
    const root = document.querySelector('[data-slot="conversation.hero.options"] .dsh-bots-mode-root')
    return root ? root.getAttribute('data-bots-mode-session') : null
  })()`)
  assert.ok(typeof heroChipSession === 'string' && heroChipSession !== '', `hero seat reports its session: ${JSON.stringify(heroChipSession)}`)
  const prompted = await remote('session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId: heroChipSession,
      mode: 'queue',
      content: [{ type: 'text', text: 'Plan the bits for this session.' }],
    },
  })
  assert.equal(prompted.accepted, true, `session/prompt was not accepted: ${JSON.stringify(prompted)}`)
  const headerChipSelector = '[data-slot="conversation.session.header.actions"] .dsh-bots-mode-root[data-bots-mode-variant="header"]'
  // The header menu is portaled to document.body (fixed positioning) so the
  // conversation shell cannot clip it.
  const headerMenuSelector = '.dsh-bots-mode-menu[data-bots-mode-menu="header"]'
  const headerItems = `${headerMenuSelector} .dsh-bots-mode-item`
  await waitFor(cdp, `document.querySelector(${JSON.stringify(headerChipSelector)})`, 'in-conversation Bit mode chip', 60000)
  await waitFor(cdp, `!document.querySelector('[data-slot="conversation.hero.options"] .dsh-bots-mode-root')`, 'hero seat unmounted', 30000)
  await waitFor(cdp, `document.querySelector(${JSON.stringify(headerChipSelector)}).getAttribute('data-bots-mode-phase') === 'ready'`, 'header chip loaded', 30000)
  const headerChip = await evaluate(cdp, `(() => {
    const root = document.querySelector(${JSON.stringify(headerChipSelector)})
    const chip = root.querySelector('.dsh-bots-mode-chip')
    const rect = chip.getBoundingClientRect()
    return {
      label: chip.textContent,
      phase: root.getAttribute('data-bots-mode-phase'),
      compact: chip.classList.contains('dsh-bots-mode-chip-compact'),
      height: rect.height,
      session: root.getAttribute('data-bots-mode-session'),
      headerText: document.querySelector('[data-slot="conversation.session.header.actions"]').textContent,
      avatar: chip.querySelector('img') ? { src: chip.querySelector('img').getAttribute('src'), width: chip.querySelector('img').naturalWidth } : null,
    }
  })()`)
  assert.equal(headerChip.session, heroChipSession, 'the header seat is bound to the same session')
  assert.ok(/Coordinator/.test(headerChip.label), `header chip shows the selected bit: ${JSON.stringify(headerChip)}`)
  assert.equal(headerChip.compact, true, 'the header seat uses the compact chip')
  assert.ok(headerChip.height <= 24, `the compact chip fits the header row: ${headerChip.height}`)
  assert.ok(/Bit mode/.test(headerChip.headerText), `the header still names the session preset: ${headerChip.headerText}`)
  assert.ok(headerChip.avatar && headerChip.avatar.width > 0, `header chip avatar loaded: ${JSON.stringify(headerChip.avatar)}`)
  await screenshot(cdp, 'bit-4-in-chat')

  // The header chip opens the same picker; it must stay inside the viewport,
  // right-aligning when a right-anchored panel fits and left-clamping otherwise.
  await waitFor(cdp, `document.querySelector(${JSON.stringify(headerChipSelector)}).querySelector('.dsh-bots-mode-chip').getAttribute('aria-expanded') === 'false'`, 'header chip idle')
  await evaluate(cdp, `document.querySelector(${JSON.stringify(headerChipSelector)}).querySelector('.dsh-bots-mode-chip').click()`)
  await waitFor(cdp, `document.querySelectorAll(${JSON.stringify(headerItems)}).length === 5`, 'header menu rows', 30000)
  await waitFor(cdp, `getComputedStyle(document.querySelector(${JSON.stringify(headerMenuSelector)})).position === 'fixed'`, 'header menu fixed positioning', 10000)
  await waitFor(cdp, `[...document.querySelectorAll(${JSON.stringify(headerItems)})].filter((row) => row.querySelector('img')).length >= 4 && [...document.querySelectorAll(${JSON.stringify(headerItems)})].filter((row) => row.querySelector('img')).every((row) => { const img = row.querySelector('img'); return img.complete && img.naturalWidth > 0 })`, 'header menu avatars', 30000)
  const headerMenu = await evaluate(cdp, `(() => {
    const menu = document.querySelector(${JSON.stringify(headerMenuSelector)})
    const rect = menu.getBoundingClientRect()
    const chip = document.querySelector(${JSON.stringify(headerChipSelector)}).querySelector('.dsh-bots-mode-chip')
    const chipRect = chip.getBoundingClientRect()
    const header = document.querySelector('[data-slot="conversation.session.header.actions"]').getBoundingClientRect()
    const style = getComputedStyle(menu)
    const checkedRow = menu.querySelector('.dsh-bots-mode-item[aria-checked="true"]')
    return {
      position: style.position,
      backgroundColor: style.backgroundColor,
      borderTopStyle: style.borderTopStyle,
      borderRadius: style.borderRadius,
      boxShadow: style.boxShadow,
      checkedRowBackground: checkedRow ? getComputedStyle(checkedRow).backgroundColor : '',
      alignsRight: menu.style.left === 'auto' && menu.style.right !== 'auto',
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width },
      chip: { left: chipRect.left, right: chipRect.right },
      header: { top: header.top, bottom: header.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      label: menu.querySelector('.dsh-bots-mode-menu-label') ? menu.querySelector('.dsh-bots-mode-menu-label').textContent : '',
      names: [...menu.querySelectorAll('.dsh-bots-mode-item-name')].map((el) => el.textContent.trim()),
    }
  })()`)
  assert.equal(headerMenu.label, 'Orchestrating bit', `header menu label: ${JSON.stringify(headerMenu.label)}`)
  assert.deepEqual(headerMenu.names.slice(0, 1), ['No specific bit'], `header menu starts with the generic row: ${JSON.stringify(headerMenu.names)}`)
  assert.equal(headerMenu.position, 'fixed', 'the header menu is fixed so the conversation shell cannot clip it')
  // The portal escapes the seat's themed subtree, so the menu must carry the
  // --dsh-mode-* tokens itself: an unstyled panel would be transparent.
  assert.notEqual(headerMenu.backgroundColor, 'rgba(0, 0, 0, 0)', `the portaled header menu keeps its surface: ${JSON.stringify(headerMenu.backgroundColor)}`)
  assert.equal(headerMenu.borderTopStyle, 'solid', `the portaled header menu keeps its border: ${JSON.stringify(headerMenu.borderTopStyle)}`)
  assert.notEqual(headerMenu.borderRadius, '0px', `the portaled header menu keeps its rounded corners: ${JSON.stringify(headerMenu.borderRadius)}`)
  assert.notEqual(headerMenu.boxShadow, 'none', `the portaled header menu keeps its elevation: ${JSON.stringify(headerMenu.boxShadow)}`)
  assert.notEqual(headerMenu.checkedRowBackground, 'rgba(0, 0, 0, 0)', `the selected row keeps its highlight: ${JSON.stringify(headerMenu.checkedRowBackground)}`)
  const needsRightAlign = headerMenu.chip.left + headerMenu.rect.width > headerMenu.viewport.width - 16
    && headerMenu.chip.right - headerMenu.rect.width >= 8
  assert.equal(headerMenu.alignsRight, needsRightAlign, `the header menu alignment matches the free space: ${JSON.stringify(headerMenu)}`)
  assert.ok(headerMenu.rect.left >= 0 && headerMenu.rect.right <= headerMenu.viewport.width, `header menu inside the viewport: ${JSON.stringify(headerMenu.rect)}`)
  assert.ok(headerMenu.rect.top >= headerMenu.header.bottom, `header menu opens below the header row: ${JSON.stringify(headerMenu)}`)
  assert.ok(headerMenu.rect.top >= 0 && headerMenu.rect.bottom <= headerMenu.viewport.height, `header menu vertically inside the viewport: ${JSON.stringify(headerMenu.rect)}`)
  await screenshot(cdp, 'bit-5-header-menu')

  // Narrow viewport: when a left-aligned 340px panel would overflow, the header
  // menu must right-align (the wide layout keeps it left-aligned, so this is the
  // only way to exercise the clamp branch). Skipped when the narrow layout hides
  // the header seat.
  const closeHeaderMenu = `(() => {
    const chip = document.querySelector(${JSON.stringify(headerChipSelector)})
    const button = chip ? chip.querySelector('.dsh-bots-mode-chip') : null
    if (button && button.getAttribute('aria-expanded') === 'true') button.click()
    return true
  })()`
  await evaluate(cdp, closeHeaderMenu)
  await waitFor(cdp, `!document.querySelector(${JSON.stringify(headerMenuSelector)})`, 'header menu closed before the narrow check')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
  const narrowChip = await evaluate(cdp, `Boolean(document.querySelector(${JSON.stringify(headerChipSelector)}))`)
  if (narrowChip) {
    await evaluate(cdp, `document.querySelector(${JSON.stringify(headerChipSelector)}).querySelector('.dsh-bots-mode-chip').click()`)
    await waitFor(cdp, `document.querySelectorAll(${JSON.stringify(headerItems)}).length === 5`, 'narrow header menu rows', 30000)
    await waitFor(cdp, `getComputedStyle(document.querySelector(${JSON.stringify(headerMenuSelector)})).position === 'fixed'`, 'narrow header menu fixed positioning', 10000)
    const narrowMenu = await evaluate(cdp, `(() => {
      const menu = document.querySelector(${JSON.stringify(headerMenuSelector)})
      const rect = menu.getBoundingClientRect()
      const chip = document.querySelector(${JSON.stringify(headerChipSelector)}).querySelector('.dsh-bots-mode-chip')
      const chipRect = chip.getBoundingClientRect()
      return {
        alignsRight: menu.style.left === 'auto' && menu.style.right !== 'auto',
        rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width },
        chip: { left: chipRect.left, right: chipRect.right },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }
    })()`)
    assert.ok(narrowMenu.rect.left >= 0 && narrowMenu.rect.right <= narrowMenu.viewport.width, `narrow header menu inside the viewport: ${JSON.stringify(narrowMenu)}`)
    // Left-clamp wins when a right-anchored 340px panel would also overflow to
    // the left; either way the panel must stay inside the viewport.
    const narrowNeedsRight = narrowMenu.chip.left + narrowMenu.rect.width > narrowMenu.viewport.width - 16
      && narrowMenu.chip.right - narrowMenu.rect.width >= 8
    assert.equal(narrowMenu.alignsRight, narrowNeedsRight, `narrow header menu alignment matches the free space: ${JSON.stringify(narrowMenu)}`)
    console.log('   narrow header menu:', JSON.stringify(narrowMenu.alignsRight), '| needs right align:', narrowNeedsRight)
    await evaluate(cdp, closeHeaderMenu)
    await waitFor(cdp, `!document.querySelector(${JSON.stringify(headerMenuSelector)})`, 'narrow header menu closed')
  } else {
    console.log('   narrow viewport hides the header seat; right-align branch stays defensive')
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  await sleep(600)

  // Clear the selection from the header, then restore the existing bit: the
  // global preference changes, but the session preset itself is untouched.
  await waitFor(cdp, `document.querySelector(${JSON.stringify(headerChipSelector)}).querySelector('.dsh-bots-mode-chip').getAttribute('aria-expanded') === 'false'`, 'header chip idle after the narrow check')
  await evaluate(cdp, `document.querySelector(${JSON.stringify(headerChipSelector)}).querySelector('.dsh-bots-mode-chip').click()`)
  await waitFor(cdp, `document.querySelectorAll(${JSON.stringify(headerItems)}).length === 5`, 'header menu rows before clearing', 30000)
  await evaluate(cdp, `[...document.querySelectorAll(${JSON.stringify(headerItems)})].find((row) => row.getAttribute('data-generic') === 'true').click()`)
  await waitFor(cdp, `!/Coordinator/.test(document.querySelector(${JSON.stringify(headerChipSelector)}).textContent) && /Choose bit/i.test(document.querySelector(${JSON.stringify(headerChipSelector)}).textContent)`, 'header chip cleared', 30000)
  await waitFor(cdp, `!document.querySelector(${JSON.stringify(headerMenuSelector)})`, 'header menu closed after clearing', 30000)
  const clearedSelection = await api('/api/bots.orchestrator')
  assert.equal(clearedSelection.bitId, null, `clearing from the header persists: ${JSON.stringify(clearedSelection.bitId)}`)
  await waitFor(cdp, `document.querySelector(${JSON.stringify(headerChipSelector)}).querySelector('.dsh-bots-mode-chip').getAttribute('aria-expanded') === 'false'`, 'header chip idle after clearing')
  await evaluate(cdp, `document.querySelector(${JSON.stringify(headerChipSelector)}).querySelector('.dsh-bots-mode-chip').click()`)
  await waitFor(cdp, `document.querySelectorAll(${JSON.stringify(headerItems)}).length === 5`, 'header menu rows after clearing', 30000)
  await evaluate(cdp, `[...document.querySelectorAll(${JSON.stringify(headerItems)})].find((row) => row.getAttribute('data-target') === ${JSON.stringify(orchestratorView.bitId)}).click()`)
  await waitFor(cdp, `/Coordinator/.test(document.querySelector(${JSON.stringify(headerChipSelector)}).textContent)`, 'header chip shows the restored bit', 30000)
  const restored = await api('/api/bots.orchestrator')
  assert.equal(restored.bitId, orchestratorView.bitId, `restoring from the header persists: ${JSON.stringify(restored.bitId)}`)
  console.log('   header chip:', JSON.stringify(headerChip.label.trim()), '| menu rows:', headerMenu.names.length, '| right-aligned:', headerMenu.alignsRight)

  console.log('5/5 screenshots + interactions')
  const entry = `[...document.querySelectorAll('nav button, nav a, [role="button"], button')].find((el) => /^\\s*Bits\\s*$/.test(el.textContent || el.getAttribute('aria-label') || ''))`
  await waitFor(cdp, entry, 'Bits sidebar entry', 60000)
  await evaluate(cdp, `${entry}.click()`)
  // Startup modals were dismissed on the hero; this is a no-op safety net.
  await waitFor(cdp, `document.querySelector('.dsh-bots-tabs')`, 'page tabs')
  await sleep(800)
  await dismissStartupModals(cdp)
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 5`, 'bit cards')
  await sleep(1500)
  const avatarDebug = await evaluate(cdp, `({
    cards: document.querySelectorAll('.dsh-bots-card').length,
    imgs: [...document.querySelectorAll('.dsh-bots-card img')].map((img) => ({ src: img.getAttribute('src'), complete: img.complete, w: img.naturalWidth })),
    text: document.querySelector('.dsh-bots-body') ? document.querySelector('.dsh-bots-body').textContent.slice(0, 400) : '',
  })`)
  console.log('   avatars', JSON.stringify(avatarDebug))
  await waitFor(cdp, `[...document.querySelectorAll('.dsh-bots-card img')].length >= 2 && [...document.querySelectorAll('.dsh-bots-card img')].every((img) => img.complete && img.naturalWidth > 0)`, 'card avatars loaded')
  const pageText = await evaluate(cdp, `document.querySelector('.dsh-bots-root').innerText`)
  assert.ok(!/Docker|\bChat\b/i.test(pageText), 'no VM/chat strings in the page')

  // Cards: family badge + model/effort route; orchestrators point to flows.
  const scoutCard = `document.querySelector('.dsh-bots-card[data-bit-id="${scout.id}"]')`
  const orchestratorCard = `document.querySelector('.dsh-bots-card[data-bit-id="${orchestrator.id}"]')`
  const scoutText = await evaluate(cdp, `${scoutCard}.textContent`)
  assert.ok(/Worker/.test(scoutText), `worker badge: ${scoutText}`)
  assert.ok(/Claude Haiku 5\.5 \(subscription\) · medium/.test(scoutText), `model label + effort on the card: ${scoutText}`)
  assert.ok(!/Executes in flows/.test(scoutText), 'workers do not show the flows note')
  const orchestratorText = await evaluate(cdp, `${orchestratorCard}.textContent`)
  assert.ok(/Orchestrator/.test(orchestratorText), `orchestrator badge: ${orchestratorText}`)
  assert.ok(/Executes in flows/.test(orchestratorText), `orchestrator flows note: ${orchestratorText}`)
  assert.ok(/Lead of: PO Flow/.test(orchestratorText), `lead team named: ${orchestratorText}`)
  assert.equal(await evaluate(cdp, `[...${orchestratorCard}.querySelectorAll('button')].some((el) => /^Run$/.test(el.textContent.trim()))`), false, 'no ad-hoc Run on an orchestrator')
  await screenshot(cdp, '1-list')

  // Catalog section: every catalog character without a bit is listed as an
  // available bit (catalog order), below the created cards.
  await waitFor(cdp, `document.querySelector('.dsh-bots-catalog-section')`, 'catalog section')
  const usedCharacters = ['bit-scout', 'bit-builder', 'bit-product-owner', 'bit-coordinator']
  const expectedAvailable = catalogBits.filter((entry) => !usedCharacters.includes(entry.id))
  assert.equal(expectedAvailable.length, 49, 'the seeded bits leave 49 catalog characters')
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-catalog-card').length === ${expectedAvailable.length}`, 'catalog available cards')
  const catalogSection = await evaluate(cdp, `(() => {
    const section = document.querySelector('.dsh-bots-catalog-section')
    const readCard = (id) => {
      const card = document.querySelector('.dsh-bots-catalog-card[data-catalog-character="' + id + '"]')
      if (!card) return null
      const avatar = card.querySelector('img')
      return {
        name: card.querySelector('.dsh-bots-name').textContent.trim(),
        badges: [...card.querySelectorAll('.dsh-bots-badge')].map((el) => el.textContent.trim()),
        group: card.querySelector('.dsh-bots-catalog-group') ? card.querySelector('.dsh-bots-catalog-group').textContent.trim() : '',
        summary: card.querySelector('.dsh-bots-persona') ? card.querySelector('.dsh-bots-persona').textContent.trim() : '',
        route: card.querySelector('.dsh-bots-meta') ? card.querySelector('.dsh-bots-meta').textContent.trim() : '',
        action: card.querySelector('.dsh-bots-button-primary') ? card.querySelector('.dsh-bots-button-primary').textContent.trim() : '',
        avatar: avatar ? avatar.getAttribute('src') : '',
      }
    }
    const cards = [...document.querySelectorAll('.dsh-bots-catalog-card')]
    return {
      title: section.querySelector('.dsh-bots-catalog-title') ? section.querySelector('.dsh-bots-catalog-title').textContent.trim() : '',
      hint: section.querySelector('.dsh-bots-catalog-hint') ? section.querySelector('.dsh-bots-catalog-hint').textContent.trim() : '',
      ids: cards.map((card) => card.getAttribute('data-catalog-character')),
      manager: readCard('bit-manager'),
      architect: readCard('bit-architect'),
    }
  })()`)
  assert.equal(catalogSection.title, 'All bits')
  assert.ok(catalogSection.hint.length > 0, 'catalog section has an intro')
  assert.deepEqual(catalogSection.ids, expectedAvailable.map((entry) => entry.id), 'catalog cards keep the catalog order')
  assert.ok(!catalogSection.ids.includes('bit-scout'), 'Scout already has a bit and is not offered twice')
  assert.equal(catalogSection.manager.name, 'Manager')
  assert.deepEqual(catalogSection.manager.badges, ['Orchestrator'], 'orchestrator family badge')
  assert.equal(catalogSection.manager.group, 'Management & product', 'catalog group label')
  assert.ok(catalogSection.manager.summary.length > 0, 'orchestrator summary shown')
  assert.ok(/·\s*max$/.test(catalogSection.manager.route), `orchestrator preset route: ${catalogSection.manager.route}`)
  assert.ok(/\/api\/bots\.avatar\?id=bit-manager/.test(catalogSection.manager.avatar), `catalog avatar: ${catalogSection.manager.avatar}`)
  assert.deepEqual(catalogSection.architect.badges, ['Worker'], 'worker family badge')
  assert.equal(catalogSection.architect.group, 'Workers (tasks)')
  assert.ok(catalogSection.architect.summary.length > 0, 'worker summary shown')
  assert.ok(/·\s*high$/.test(catalogSection.architect.route), `worker preset route: ${catalogSection.architect.route}`)
  assert.equal(catalogSection.architect.action, 'New bit')

  // Scroll to the section so the screenshot shows the available catalog bits.
  await sleep(400)
  await evaluate(cdp, `document.querySelector('.dsh-bots-catalog-section').scrollIntoView({ block: 'start' })`)
  await sleep(500)
  await waitFor(cdp, `(() => {
    const images = [...document.querySelectorAll('.dsh-bots-catalog-card img')].slice(0, 4)
    return images.length === 4 && images.every((img) => img.complete && img.naturalWidth > 0)
  })()`, 'catalog avatars loaded')
  await screenshot(cdp, '8-catalog')

  // A card action opens the create form on the form step, prefilled from the
  // character (family included) — not on the gallery step.
  await evaluate(cdp, `document.querySelector('.dsh-bots-catalog-card[data-catalog-character="bit-manager"] .dsh-bots-button-primary').click()`)
  await waitFor(cdp, `document.querySelector('#dsh-bots-name-input')`, 'prefilled form from a catalog card')
  const catalogPrefilled = await evaluate(cdp, `({
    name: document.querySelector('#dsh-bots-name-input').value,
    description: document.querySelector('#dsh-bots-instructions-input').value,
    family: document.querySelector('.dsh-bots-box [role="switch"]').getAttribute('aria-checked'),
    familyLabel: document.querySelector('.dsh-bots-box [role="switch"]').textContent.trim(),
    galleryTiles: document.querySelectorAll('.dsh-bots-bit-tile').length,
    focused: document.activeElement && document.activeElement.id,
  })`)
  assert.equal(catalogPrefilled.name, 'Manager')
  assert.equal(catalogPrefilled.description, bit('bit-manager').instructions)
  assert.equal(catalogPrefilled.galleryTiles, 0, 'opens on the form step, not the gallery')
  assert.equal(catalogPrefilled.family, 'true', 'family badge matches the orchestrator character')
  assert.ok(/Orchestrator/.test(catalogPrefilled.familyLabel), catalogPrefilled.familyLabel)
  assert.equal(catalogPrefilled.focused, 'dsh-bots-name-input')
  await evaluate(cdp, `document.querySelector('.dsh-bots-dialog-footer button').click()`)
  await waitFor(cdp, `!document.querySelector('.dsh-bots-dialog')`, 'catalog form closed without creating')

  // A worker character prefills the worker family as well.
  await evaluate(cdp, `document.querySelector('.dsh-bots-catalog-card[data-catalog-character="bit-architect"] .dsh-bots-button-primary').click()`)
  await waitFor(cdp, `document.querySelector('#dsh-bots-name-input')`, 'prefilled worker form')
  const catalogWorkerPrefilled = await evaluate(cdp, `({
    name: document.querySelector('#dsh-bots-name-input').value,
    description: document.querySelector('#dsh-bots-instructions-input').value,
    family: document.querySelector('.dsh-bots-box [role="switch"]').getAttribute('aria-checked'),
  })`)
  assert.equal(catalogWorkerPrefilled.name, 'Architect')
  assert.equal(catalogWorkerPrefilled.description, bit('bit-architect').instructions)
  assert.equal(catalogWorkerPrefilled.family, 'false')
  await evaluate(cdp, `document.querySelector('.dsh-bots-dialog-footer button').click()`)
  await waitFor(cdp, `!document.querySelector('.dsh-bots-dialog')`, 'worker catalog form closed')
  // Back to the top: the rest of the run frames the created bit cards as before.
  await evaluate(cdp, `document.querySelector('.dsh-bots-page').scrollTo({ top: 0 })`)
  await sleep(300)

  // New bit -> catalog picker.
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-toolbar button')].at(-1).click()`)
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-bit-tile').length === 53`, 'picker tiles')
  await sleep(1200)
  await screenshot(cdp, '2-picker')
  const surfaces = await evaluate(cdp, `(() => {
    const dialog = getComputedStyle(document.querySelector('.dsh-bots-dialog'))
    const overlay = getComputedStyle(document.querySelector('.dsh-bots-overlay'))
    return { dialog: dialog.backgroundColor, overlay: overlay.backgroundColor, focused: document.activeElement && document.activeElement.type }
  })()`)
  console.log('   computed', JSON.stringify(surfaces))
  assert.notEqual(surfaces.dialog, 'rgba(0, 0, 0, 0)', 'dialog surface is transparent')
  assert.notEqual(surfaces.overlay, 'rgba(0, 0, 0, 0)', 'overlay backdrop is transparent')
  assert.equal(surfaces.focused, 'search', 'search field focused on open')

  // Search matches the tester bits.
  await setInput(cdp, '.dsh-bots-picker-search input', 'test')
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-bit-tile').length > 0 && document.querySelectorAll('.dsh-bots-bit-tile').length < 53`, 'filtered tiles')
  const filtered = await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-bit-name')].map((el) => el.textContent)`)
  console.log('   search "test" ->', filtered.join(', '))
  assert.ok(filtered.includes('Web Tester') && filtered.includes('QA'), 'testers found')
  await sleep(600)
  await screenshot(cdp, '3-picker-search')

  // Pick Builder (worker): name/instructions/model/effort are prefilled from the bit.
  await setInput(cdp, '.dsh-bots-picker-search input', '')
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-bit-tile').length === 53`, 'all tiles again')
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-bit-tile')].find((el) => el.querySelector('.dsh-bots-bit-name').textContent === 'Builder').click()`)
  await waitFor(cdp, `document.querySelector('#dsh-bots-name-input')`, 'form step')
  const prefilled = await evaluate(cdp, `({
    name: document.querySelector('#dsh-bots-name-input').value,
    description: document.querySelector('#dsh-bots-instructions-input').value,
    model: document.querySelector('#dsh-bots-model-input').value,
    effort: document.querySelector('#dsh-bots-effort-input').value,
    orchestrator: document.querySelector('.dsh-bots-box [role="switch"]').getAttribute('aria-checked'),
    focused: document.activeElement && document.activeElement.id,
  })`)
  assert.equal(prefilled.name, 'Builder')
  assert.equal(prefilled.description, bit('bit-builder').instructions)
  assert.equal(prefilled.model, 'subscription/sonnet')
  assert.equal(prefilled.effort, bit('bit-builder').effort)
  assert.equal(prefilled.orchestrator, 'false')
  assert.equal(prefilled.focused, 'dsh-bots-name-input')

  // Toggling the family snaps the model to the family default and back.
  await evaluate(cdp, `document.querySelector('.dsh-bots-box [role="switch"]').click()`)
  const asOrchestrator = await evaluate(cdp, `({ model: document.querySelector('#dsh-bots-model-input').value, effort: document.querySelector('#dsh-bots-effort-input').value, checked: document.querySelector('.dsh-bots-box [role="switch"]').getAttribute('aria-checked') })`)
  assert.equal(asOrchestrator.checked, 'true')
  assert.equal(asOrchestrator.model, 'deepseek-account/deepseek-flash')
  assert.equal(asOrchestrator.effort, 'max')
  await evaluate(cdp, `document.querySelector('.dsh-bots-box [role="switch"]').click()`)
  const asWorker = await evaluate(cdp, `({ model: document.querySelector('#dsh-bots-model-input').value, effort: document.querySelector('#dsh-bots-effort-input').value, checked: document.querySelector('.dsh-bots-box [role="switch"]').getAttribute('aria-checked') })`)
  assert.equal(asWorker.checked, 'false')
  // A DSH route is valid for workers too (V5-CONTRACT.md §1): toggling off may
  // keep it; the model must never be empty.
  assert.ok(asWorker.model === 'deepseek-account/deepseek-flash' || asWorker.model === 'subscription/sonnet', `worker model after toggling off: ${JSON.stringify(asWorker)}`)
  // Deterministic record for the save below: back to the catalog worker default.
  await setSelect(cdp, '#dsh-bots-model-input', 'subscription/sonnet')
  await setSelect(cdp, '#dsh-bots-effort-input', bit('bit-builder').effort)

  // Rename and create through the UI.
  await setInput(cdp, '#dsh-bots-name-input', 'Store Builder')
  await screenshot(cdp, '4-form-prefilled')
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-dialog-footer button')].at(-1).click()`)
  await waitFor(cdp, `!document.querySelector('.dsh-bots-dialog')`, 'dialog closed after create', 30000)
  const created = (await api('/api/bots.list')).bits.find((entryBit) => entryBit.name === 'Store Builder')
  assert.ok(created, 'bit created through the UI')
  assert.equal(created.character, 'bit-builder')
  assert.equal(created.instructions, bit('bit-builder').instructions)
  assert.equal(created.emoji, bit('bit-builder').emoji)
  assert.equal(created.color, bit('bit-builder').color)
  assert.equal(created.isOrchestrator, false, 'worker family saved')
  assert.equal(created.model, 'subscription/sonnet', 'catalog model saved')
  assert.equal(created.effort, bit('bit-builder').effort, 'catalog effort saved')
  assert.equal('vm' in created, false, 'v5 record has no vm')
  console.log('   created through UI:', created.name, created.character, created.model, created.effort)

  // Edit the legacy bit: no character yet, the custom name/description are kept.
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 6`, 'six cards')
  // Creating a bit through the gallery keeps the catalog section in place.
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-catalog-card').length === ${expectedAvailable.length}`, 'catalog available cards after a creation')
  await evaluate(cdp, `document.querySelector('.dsh-bots-card[data-bit-id="${legacy.id}"] .dsh-bots-button-outline').click()`)
  await waitFor(cdp, `document.querySelector('.dsh-bots-bit-hero')`, 'edit dialog')
  await screenshot(cdp, '5-edit-legacy')
  await evaluate(cdp, `document.querySelector('.dsh-bots-bit-hero button').click()`)
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-bit-tile').length === 53`, 'picker from edit')
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-bit-tile')].find((el) => el.querySelector('.dsh-bots-bit-name').textContent === 'Writer').click()`)
  await waitFor(cdp, `document.querySelector('#dsh-bots-name-input')`, 'back to form')
  const kept = await evaluate(cdp, `({
    name: document.querySelector('#dsh-bots-name-input').value,
    description: document.querySelector('#dsh-bots-instructions-input').value,
    restore: !!document.querySelector('.dsh-bots-link-button'),
    model: document.querySelector('#dsh-bots-model-input').value,
    effort: document.querySelector('#dsh-bots-effort-input').value,
  })`)
  assert.equal(kept.name, 'Legacy')
  assert.equal(kept.description, 'Old bit, no character.')
  assert.equal(kept.restore, true, 'restore default offered')
  assert.equal(kept.model, 'subscription/sonnet')
  assert.equal(kept.effort, 'medium', 'catalog effort of the Writer bit')
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-dialog-footer button')].at(-1).click()`)
  await waitFor(cdp, `!document.querySelector('.dsh-bots-dialog')`, 'dialog closed after edit', 30000)
  const editedLegacy = (await api('/api/bots.list')).bits.find((entryBit) => entryBit.id === legacy.id)
  assert.equal(editedLegacy.character, 'bit-writer')
  assert.equal(editedLegacy.effort, 'medium')
  assert.equal(editedLegacy.isOrchestrator, false)
  // The legacy bit now uses the Writer character: the catalog section drops it.
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-catalog-card').length === ${expectedAvailable.length - 1}`, 'catalog drops the created character')

  // Run: worker request → response. The route records the readOnly flag; in
  // this isolated profile the delegate backend is unavailable, so the dialog
  // settles on the coded error (the client must show it instead of hanging).
  await evaluate(cdp, `window.__bitsRunCalls = []; (() => {
    const original = window.fetch
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (url.indexOf('/api/bots.run') >= 0) window.__bitsRunCalls.push({ url: url, body: init && init.body })
      } catch (error) { /* spy is best effort */ }
      return original.apply(this, arguments)
    }
  })()`)
  await evaluate(cdp, `document.querySelector('.dsh-bots-card[data-bit-id="${scout.id}"]').querySelector('.dsh-bots-button-primary').click()`)
  await waitFor(cdp, `document.querySelector('#dsh-bots-run-request')`, 'run dialog')
  const readOnlyDefault = await evaluate(cdp, `document.querySelector('.dsh-bots-dialog [role="switch"]').getAttribute('aria-checked')`)
  assert.equal(readOnlyDefault, 'true', 'read-only defaults on')
  assert.ok(await evaluate(cdp, `document.querySelector('.dsh-bots-card[data-bit-id="${scout.id}"] .dsh-bots-button-primary') && true`))
  await setInput(cdp, '#dsh-bots-run-request', 'What is the backlog priority?')
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-dialog-footer button')].at(-1).click()`)
  await waitFor(cdp, `document.querySelector('.dsh-bots-dialog .dsh-bots-error') || (document.querySelector('#dsh-bots-run-response') && document.querySelector('#dsh-bots-run-response').getAttribute('aria-busy') !== 'true' && !/The response shows up here/.test(document.querySelector('#dsh-bots-run-response').textContent))`, 'run settled', 60000)
  const calls = await evaluate(cdp, `window.__bitsRunCalls`)
  assert.equal(calls.length, 1, 'one run request sent')
  const runBody = JSON.parse(calls[0].body)
  assert.equal(runBody.id, scout.id)
  assert.equal(runBody.request, 'What is the backlog priority?')
  assert.equal(runBody.readOnly, true, 'readOnly true reaches the route')
  const settled = await evaluate(cdp, `({
    response: document.querySelector('#dsh-bots-run-response') ? document.querySelector('#dsh-bots-run-response').textContent : '',
    error: document.querySelector('.dsh-bots-dialog .dsh-bots-error') ? document.querySelector('.dsh-bots-dialog .dsh-bots-error').textContent : '',
  })`)
  assert.ok(settled.response || settled.error, 'the dialog shows the response or the error')
  console.log('   run settled:', JSON.stringify(settled).slice(0, 220))
  await screenshot(cdp, '6-run')
  await evaluate(cdp, `document.querySelector('.dsh-bots-dialog-footer button').click()`)
  await waitFor(cdp, `!document.querySelector('.dsh-bots-dialog')`, 'run dialog closed')

  // The orchestrator card links to the flows tab instead of running ad-hoc.
  await clickButtonByText(cdp, `.dsh-bots-card[data-bit-id="${orchestrator.id}"]`, 'Open Teams')
  await waitFor(cdp, `document.querySelector('.dsh-bots-tabs') && /Teams/.test(document.querySelector('.dsh-bots-tabs').textContent)`, 'teams tab from the orchestrator card')
  assert.ok(await evaluate(cdp, `document.querySelectorAll('.dsh-bots-tab[aria-selected="true"]').length === 1`), 'one tab selected')
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-tab')].find((el) => /Bits/.test(el.textContent)).click()`)
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 6`, 'back on the bits list')

  // Creating a bit from a catalog card uses the same create route and moves the
  // character from the catalog section into the created list.
  await waitFor(cdp, `document.querySelector('.dsh-bots-catalog-card[data-catalog-character="bit-architect"]')`, 'available Architect card')
  await evaluate(cdp, `document.querySelector('.dsh-bots-catalog-card[data-catalog-character="bit-architect"] .dsh-bots-button-primary').click()`)
  await waitFor(cdp, `document.querySelector('#dsh-bots-name-input')`, 'catalog prefilled form')
  assert.equal(await evaluate(cdp, `document.querySelector('#dsh-bots-name-input').value`), 'Architect')
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-dialog-footer button')].at(-1).click()`)
  await waitFor(cdp, `!document.querySelector('.dsh-bots-dialog')`, 'dialog closed after the catalog create', 30000)
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 7`, 'the catalog bit joins the created cards')
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-catalog-card').length === ${expectedAvailable.length - 2}`, 'the catalog section drops the created character')
  const catalogCreated = (await api('/api/bots.list')).bits.find((entryBit) => entryBit.character === 'bit-architect')
  assert.ok(catalogCreated, 'the catalog card created a bit through the create route')
  assert.equal(catalogCreated.name, 'Architect')
  assert.equal(catalogCreated.isOrchestrator, false)
  assert.equal(catalogCreated.model, bit('bit-architect').model, 'catalog preset model saved')
  assert.equal(catalogCreated.effort, bit('bit-architect').effort, 'catalog preset effort saved')

  // Delete confirmation.
  await evaluate(cdp, `document.querySelector('.dsh-bots-card[data-bit-id="${scout.id}"] .dsh-bots-button-danger').click()`)
  await waitFor(cdp, `document.querySelector('.dsh-bots-dialog')`, 'delete dialog')
  await screenshot(cdp, '7-delete-dialog')
  cdp.close()
  console.log('\nVISUAL DONE')
}

try {
  await main()
} catch (error) {
  console.error('\nVISUAL FAIL')
  console.error(error)
  process.exitCode = 1
} finally {
  if (chrome) chrome.kill('SIGKILL')
  if (host && host.exitCode === null) {
    host.kill('SIGTERM')
    await new Promise((resolve) => { const t = setTimeout(() => { host.kill('SIGKILL'); resolve() }, 8000); host.once('exit', () => { clearTimeout(t); resolve() }) })
  }
  for (const dir of [chromeDir, tempHome]) if (dir) await fs.rm(dir, { recursive: true, force: true })
}
