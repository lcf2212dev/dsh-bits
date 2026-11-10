#!/usr/bin/env node
/**
 * Visual + interaction check for the Bits tab (V5-CONTRACT.md §8).
 *
 * Boots a throwaway DSH Web host (isolated DSH_HOME, never the user's profile)
 * with this bundle, seeds sample bits through the real routes, then drives a
 * headless Chrome over the DevTools Protocol to capture screenshots of:
 *   1. the bit list, 2. the bit picker, 3. the filtered picker, 4. the form
 *   prefilled from a bit, 5. the edit dialog, 6. the Run dialog, 7. delete.
 * It creates one bit through the UI, checks the v5 record fields through the API,
 * runs a worker ad-hoc (checking `readOnly` reached the route) and asserts the
 * orchestrator card does not offer the ad-hoc Run action.
 * Screenshots land in `test/screenshots/` (light or dark via --theme).
 *
 * Usage: node test/visual.mjs [--theme dark|light] [--width 1440] [--height 900]
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

async function main() {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}`)
  await fs.mkdir(OUT_DIR, { recursive: true })
  console.log('1/4 profile + host')
  await installProfile()
  const tokenUrl = await bootHost(await freePort())
  const exchange = await fetch(tokenUrl, { redirect: 'manual' })
  cookie = exchange.headers.getSetCookie()[0].split(';', 1)[0]
  origin = new URL(tokenUrl).origin

  console.log('2/4 seed bits')
  const { bits: catalogBits } = await api('/api/bots.catalog')
  assert.equal(catalogBits.length, 52, 'catalog served by the real host')
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

  console.log('3/4 chrome')
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

  console.log('4/4 screenshots + interactions')
  const entry = `[...document.querySelectorAll('nav button, nav a, [role="button"], button')].find((el) => /^\\s*Bits\\s*$/.test(el.textContent || el.getAttribute('aria-label') || ''))`
  await waitFor(cdp, entry, 'Bits sidebar entry', 60000)
  await evaluate(cdp, `${entry}.click()`)
  // A fresh profile shows the host's one-time preview notice; dismiss it.
  await waitFor(cdp, `document.querySelector('.dsh-bots-tabs')`, 'page tabs')
  await sleep(800)
  for (let round = 0; round < 4; round += 1) {
    await evaluate(cdp, `(() => {
      const outside = (el) => !el.closest('.dsh-bots-root')
      const next = [...document.querySelectorAll('button')].filter(outside).find((el) => /^Continue$/.test(el.textContent.trim()))
        ?? [...document.querySelectorAll('[role="dialog"] button[aria-label], [aria-modal="true"] button[aria-label]')].filter(outside).find((el) => /close/i.test(el.getAttribute('aria-label')))
      if (next) next.click()
    })()`)
    await sleep(400)
  }
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 4`, 'bit cards')
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
  assert.ok(/Claude Haiku 5\.5 \(subscription\) · low/.test(scoutText), `model label + effort on the card: ${scoutText}`)
  assert.ok(!/Executes in flows/.test(scoutText), 'workers do not show the flows note')
  const orchestratorText = await evaluate(cdp, `${orchestratorCard}.textContent`)
  assert.ok(/Orchestrator/.test(orchestratorText), `orchestrator badge: ${orchestratorText}`)
  assert.ok(/Executes in flows/.test(orchestratorText), `orchestrator flows note: ${orchestratorText}`)
  assert.ok(/Lead of: PO Flow/.test(orchestratorText), `lead team named: ${orchestratorText}`)
  assert.equal(await evaluate(cdp, `[...${orchestratorCard}.querySelectorAll('button')].some((el) => /^Run$/.test(el.textContent.trim()))`), false, 'no ad-hoc Run on an orchestrator')
  await screenshot(cdp, '1-list')

  // New bit -> catalog picker.
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-toolbar button')].at(-1).click()`)
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-bit-tile').length === 52`, 'picker tiles')
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
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-bit-tile').length > 0 && document.querySelectorAll('.dsh-bots-bit-tile').length < 52`, 'filtered tiles')
  const filtered = await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-bit-name')].map((el) => el.textContent)`)
  console.log('   search "test" ->', filtered.join(', '))
  assert.ok(filtered.includes('Web Tester') && filtered.includes('QA'), 'testers found')
  await sleep(600)
  await screenshot(cdp, '3-picker-search')

  // Pick Builder (worker): name/instructions/model/effort are prefilled from the bit.
  await setInput(cdp, '.dsh-bots-picker-search input', '')
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-bit-tile').length === 52`, 'all tiles again')
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
  assert.equal(prefilled.effort, 'high')
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
  await setSelect(cdp, '#dsh-bots-effort-input', 'high')

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
  assert.equal(created.effort, 'high', 'catalog effort saved')
  assert.equal('vm' in created, false, 'v5 record has no vm')
  console.log('   created through UI:', created.name, created.character, created.model, created.effort)

  // Edit the legacy bit: no character yet, the custom name/description are kept.
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 5`, 'five cards')
  await evaluate(cdp, `document.querySelector('.dsh-bots-card[data-bit-id="${legacy.id}"] .dsh-bots-button-outline').click()`)
  await waitFor(cdp, `document.querySelector('.dsh-bots-bit-hero')`, 'edit dialog')
  await screenshot(cdp, '5-edit-legacy')
  await evaluate(cdp, `document.querySelector('.dsh-bots-bit-hero button').click()`)
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-bit-tile').length === 52`, 'picker from edit')
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
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 5`, 'back on the bits list')

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
