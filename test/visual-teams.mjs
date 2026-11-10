#!/usr/bin/env node
/**
 * Visual + interaction check for the Teams (flows) tab and its editor.
 *
 * Boots a throwaway DSH Web host (isolated DSH_HOME, never the user profile),
 * instantiates the shipped "engineering" template through the real route, opens
 * the editor in headless Chrome and drives real pointer/keyboard input: move a
 * node, connect two nodes, add from the palette, delete, undo and save. v5
 * additionally exercises teams of bits: a team created from a template through
 * the UI (fresh bits + `bitId` members), the member bit picker with the
 * read-only route, the orchestrator-only lead rule, and "Enviar pedido" through
 * `POST /api/bots.teams.run` (mocked at the fetch layer; the flow runtime is
 * covered by the host suites). Screenshots go to --out (default
 * test/screenshots/).
 *
 * Usage: node test/visual-teams.mjs [--theme dark|light] [--out dir] [--width 1440] [--height 900]
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
const OUT_DIR = path.resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : path.join(HERE, "screenshots"))
const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? path.join(os.homedir(), '.local', 'opt', 'deepseek-harness')
const RUNTIME = path.join(INSTALL_ROOT, 'resources', 'runtime', 'primary-runtime')
const RUNTIME_NODE = path.join(RUNTIME, 'dependencies', 'node', 'bin', 'node')
const RUNTIME_PNPM = path.join(RUNTIME, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome-stable'
const PROFILE = 'bots-visual-teams'

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
  await fs.writeFile(path.join(dir, 'cordis.patch.yml'), `- id: locale\n  name: '@deepseek-ai/dsh-client-locale'\n  config:\n    preference: ${option('lang', 'pt')}\n`)
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

async function rectOf(cdp, selector) {
  const rect = await evaluate(cdp, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } })()`)
  assert.ok(rect, `element not found: ${selector}`)
  return rect
}

async function drag(cdp, from, to, steps = 12) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
  for (let index = 1; index <= steps; index += 1) {
    const x = from.x + ((to.x - from.x) * index) / steps
    const y = from.y + ((to.y - from.y) * index) / steps
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await sleep(16)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(150)
}

async function click(cdp, point) {
  await drag(cdp, point, point, 1)
}

async function key(cdp, keyName, code, keyCode, modifiers = 0) {
  const base = { key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
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
  await sleep(250)
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

async function typeInto(cdp, selector, text) {
  await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).focus()`)
  await cdp.send('Input.insertText', { text })
  await sleep(150)
}

const CTRL = 2
const SHIFT = 8
const PACK_ID = 'demo'
let harnessRoutes = false
let harnessDir = null

/** Minimal harness (not a git checkout): 1 preset, 2 skills, 1 MCP server, version 7, no patch anchors. */
async function writeFakeHarness(dir) {
  const files = {
    'AGENTS.md': '# Regras do repositório\n\nSempre rode os testes.\n',
    '.github/harness.json': JSON.stringify({ versao: 7 }) + '\n',
    '.github/agents/builder.agent.md': [
      '---', 'name: builder', 'description: Implementa a partir dos testes vermelhos', 'model: Claude Sonnet 5.5 (copilot)', 'reasoning-effort: medium', '---',
      '**Skills:** leia antes a [`tdd`](../skills/tdd/SKILL.md).', '', 'Você implementa o mínimo para os testes passarem.', '',
    ].join('\n'),
    '.github/skills/tdd/SKILL.md': '---\nname: tdd\ndescription: Ciclo vermelho, verde, refatorar\n---\n\n# TDD\n',
    '.github/skills/review/SKILL.md': '---\nname: review\ndescription: Revisão adversarial do diff\n---\n\n# Review\n',
    '.mcp.json': JSON.stringify({ mcpServers: { figma: { command: 'node', args: ['.github/scripts/figma.mjs'] } } }) + '\n',
  }
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await fs.writeFile(path.join(dir, rel), text)
  }
}

const nodeCount = (cdp) => evaluate(cdp, `document.querySelectorAll('.dsh-flow-node, .dsh-flow-group').length`)
const listTeams = async () => (await api('/api/bots.teams')).teams
const listBits = async () => (await api('/api/bots.list')).bits

async function main() {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}`)
  await fs.mkdir(OUT_DIR, { recursive: true })
  console.log('1/6 profile + host')
  await installProfile()
  const tokenUrl = await bootHost(await freePort())
  const exchange = await fetch(tokenUrl, { redirect: 'manual' })
  cookie = exchange.getSetCookie ? exchange.headers.getSetCookie()[0].split(';', 1)[0] : (exchange.headers.getSetCookie()[0].split(';', 1)[0])
  origin = new URL(tokenUrl).origin

  console.log('2/6 seed teams')
  const { templates } = await api('/api/bots.teams.templates')
  const template = templates.find((entry) => entry.id === 'engineering')
  assert.ok(template, 'engineering template served by the real host')
  assert.ok(Array.isArray(template.bits) && template.bits.length >= 2, 'template ships its own bits')
  assert.ok(template.team.members.every((member) => typeof member.bitKey === 'string' && member.bitKey), 'template members reference bits by local key')
  const templateBits = template.bits.length

  // Instantiate once through the route: fresh bits + a team whose members carry bitId.
  const instantiated = await api('/api/bots.teams.fromTemplate', { templateId: 'engineering' })
  const team = instantiated.team
  assert.equal(instantiated.bits.length, templateBits, 'fromTemplate creates one bit per template bit')
  assert.ok(team.members.length > 0 && team.members.every((member) => typeof member.bitId === 'string' && member.bitId), 'members reference bits by id')
  assert.ok(team.members.every((member) => instantiated.bits.some((bit) => bit.id === member.bitId)), 'member bitIds point at the fresh bits')
  assert.equal(team.lead, 'coordinator', 'template lead preserved')
  const leadMember = team.members.find((member) => member.id === team.lead)
  assert.ok(leadMember, 'lead member exists')
  const leadBit = instantiated.bits.find((bit) => bit.id === leadMember.bitId)
  assert.equal(leadBit.isOrchestrator, true, 'lead bit is an orchestrator')

  // Make the first team runnable (workspace + lead + request templates).
  const repoDir = path.join(tempHome, 'repo')
  await fs.mkdir(repoDir, { recursive: true })
  const requestEntries = [
    { id: 'pimpl', label: 'Implementar card', template: 'Implemente o card AB-{n}. {pedido}' },
    { id: 'pfree', label: 'Revisar PR', template: 'Revise o PR aberto: {pedido}' },
  ]
  const runnable = await api('/api/bots.teams.update', { id: team.id, patch: { workspaceDir: repoDir, lead: leadMember.id, entry: requestEntries } })
  assert.equal(runnable.team.lead, leadMember.id, 'host stores the lead')

  // A second team binds the same workspace: the card shows the bound badge.
  const { bit: platformLeadBit } = await api('/api/bots.create', {
    name: 'Líder da plataforma',
    character: 'bit-coordinator',
    isOrchestrator: true,
    model: 'deepseek-account/deepseek-flash',
    effort: 'max',
  })
  const { team: platform } = await api('/api/bots.teams.create', {
    team: {
      name: 'Plataforma', emoji: '🛰️', color: '#0891b2', workspaceDir: repoDir, bindWorkspace: true, lead: 'lead',
      members: [{ id: 'lead', bitId: platformLeadBit.id, role: 'Líder da plataforma', access: 'read' }],
      flow: { nodes: [{ id: 'start', type: 'start', x: 0, y: 0, label: 'Pedido' }], edges: [] },
    },
  })
  assert.equal(platform.bindWorkspace, true, 'host stores bindWorkspace')

  // A worker bit used by the UI member-picker test.
  const { bit: workerBit } = await api('/api/bots.create', { name: 'Builder visual', character: 'bit-builder' })
  assert.equal(workerBit.isOrchestrator, false)
  const bitsBeforeUiCreate = (await listBits()).length

  // Harness packs are optional on the Host side: probe the route, skip pack checks without it.
  harnessDir = path.join(tempHome, 'harness-src')
  await writeFakeHarness(harnessDir)
  try {
    const probe = await (await fetch(`${origin}/api/bots.harness`, { headers: { cookie } })).json()
    harnessRoutes = probe && probe.ok === true
  } catch {
    harnessRoutes = false
  }
  console.log(`   harness routes: ${harnessRoutes ? 'present' : 'absent (pack checks skipped)'}`)

  console.log('3/6 chrome')
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

  console.log('4/6 teams tab')
  const entry = `[...document.querySelectorAll('nav button, nav a, [role="button"], button')].find((el) => /^\\s*Bits\\s*$/.test(el.textContent || el.getAttribute('aria-label') || ''))`
  await waitFor(cdp, entry, 'Bits sidebar entry', 60000)
  await evaluate(cdp, `${entry}.click()`)
  await waitFor(cdp, `document.querySelector('.dsh-bots-tabs')`, 'page tabs')
  await sleep(800)
  for (let round = 0; round < 4; round += 1) {
    await evaluate(cdp, `(() => {
      const outside = (el) => !el.closest('.dsh-bots-root')
      const next = [...document.querySelectorAll('button')].filter(outside).find((el) => /^(Continuar|Continue)$/.test(el.textContent.trim()))
        ?? [...document.querySelectorAll('[role="dialog"] button[aria-label], [aria-modal="true"] button[aria-label]')].filter(outside).find((el) => /fechar|close/i.test(el.getAttribute('aria-label')))
      if (next) next.click()
    })()`)
    await sleep(400)
  }
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-tab')].find((el) => /Times|Teams/.test(el.textContent)).click()`)
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length >= 2`, 'team cards')
  await sleep(600)
  await screenshot(cdp, 'teams-1-list')

  // Card badges: the lead bit name and the workspace binding.
  const engCard = `document.querySelector('.dsh-bots-card[data-team-id="${team.id}"]')`
  const platformCard = `document.querySelector('.dsh-bots-card[data-team-id="${platform.id}"]')`
  const engCardText = await evaluate(cdp, `${engCard}.textContent`)
  assert.ok(new RegExp('Líder: ' + leadBit.name).test(engCardText), `lead bit name on the first card: ${engCardText.slice(0, 240)}`)
  const platformCardText = await evaluate(cdp, `${platformCard}.textContent`)
  assert.ok(/Workspace vinculado/.test(platformCardText), 'bound-workspace badge on the second card')

  console.log('5/6 template, harness, send request')
  // v5: create a team from a template through the UI (fresh bits created server-side).
  await clickButtonByText(cdp, '.dsh-bots-toolbar', 'Novo time')
  await waitFor(cdp, `document.querySelector('[data-template-id="engineering"]')`, 'template choices')
  await evaluate(cdp, `document.querySelector('[data-template-id="engineering"]').click()`)
  await sleep(200)
  await evaluate(cdp, `(() => {
    const input = document.querySelector('#dsh-team-name')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'Engenharia UI')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await clickButtonByText(cdp, '.dsh-bots-root [role="dialog"] .dsh-bots-dialog-footer', 'Criar time')
  // fromTemplate opens the created team in the editor.
  await waitFor(cdp, `document.querySelector('.dsh-team-editor')`, 'editor from template', 30000)
  const uiTeam = (await listTeams()).find((item) => item.name === 'Engenharia UI')
  assert.ok(uiTeam, 'team created from a template through the UI')
  assert.ok(uiTeam.members.length > 0 && uiTeam.members.every((member) => member.bitId), 'UI instantiation created bitId members')
  assert.ok(uiTeam.lead && uiTeam.members.some((member) => member.id === uiTeam.lead), 'UI instantiation kept the lead')
  const bitsAfterUiCreate = (await listBits()).length
  assert.equal(bitsAfterUiCreate - bitsBeforeUiCreate, templateBits, 'fresh bits created for the UI team')
  // Back to the list.
  await evaluate(cdp, `document.querySelector('.dsh-team-bar [aria-label]').click()`)
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 3`, 'three team cards')

  // Harness dialog opens even when the Host lacks /api/bots.harness.
  await clickButtonByText(cdp, '.dsh-bots-toolbar', 'Harness')
  await waitFor(cdp, `document.querySelector('.dsh-bots-root [role="dialog"] #dsh-harness-source')`, 'harness dialog')
  await waitFor(cdp, `!/Carregando harness|Loading harness/.test(document.querySelector('.dsh-bots-root [role="dialog"]').textContent)`, 'harness list settled')
  if (harnessRoutes) {
    await evaluate(cdp, `document.querySelector('#dsh-harness-source').focus()`)
    await cdp.send('Input.insertText', { text: harnessDir })
    await evaluate(cdp, `document.querySelector('#dsh-harness-id').select()`)
    await cdp.send('Input.insertText', { text: PACK_ID })
    await evaluate(cdp, `document.querySelector('#dsh-harness-name').focus()`)
    await cdp.send('Input.insertText', { text: 'Harness demo' })
    await evaluate(cdp, `document.querySelector('.dsh-bots-root [role="dialog"] form button[type="submit"]').click()`)
    await waitFor(cdp, `document.querySelector('.dsh-team-okbox') && document.querySelectorAll('.dsh-team-pack').length === 1`, 'pack imported and listed', 60000)
    const packText = await evaluate(cdp, `document.querySelector('.dsh-team-pack').textContent`)
    assert.ok(/v7/.test(packText) && /1 presets/.test(packText) && /2 skills/.test(packText) && /1 MCP/.test(packText), `pack summary: ${packText}`)
    assert.ok(/0\/2/.test(packText), `skipped patches reported: ${packText}`)
  }
  await screenshot(cdp, 'teams-1b-harness')
  if (harnessRoutes) {
    await evaluate(cdp, `[...document.querySelectorAll('.dsh-team-pack button')].find((el) => /Criar time|Create team/.test(el.textContent)).click()`)
    // fromPack creates the bits then opens the new team in the editor.
    await waitFor(cdp, `document.querySelector('.dsh-team-editor')`, 'editor from the harness pack', 30000)
    assert.equal((await listTeams()).length, 4, 'team created from the harness pack')
    await evaluate(cdp, `document.querySelector('.dsh-team-bar [aria-label]').click()`)
    await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 4`, 'four team cards')
    // The engineering team carries the pack too (badge + editor checklists).
    await api('/api/bots.teams.update', { id: team.id, patch: { harness: PACK_ID } })
    await evaluate(cdp, `document.querySelector('.dsh-bots-toolbar [aria-label="Atualizar"]').click()`)
    await waitFor(cdp, `${engCard} && /Harness ${PACK_ID} v7/.test(${engCard}.textContent)`, 'harness badge on the card')
    await screenshot(cdp, 'teams-1d-list-harness')
  } else {
    await evaluate(cdp, `document.querySelector('.dsh-bots-root [role="dialog"] .dsh-bots-dialog-head button').click()`)
    await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]')`, 'harness dialog closed')
  }

  // "Enviar pedido": the client must call POST /api/bots.teams.run with the
  // composed prompt. Mock the route at the fetch layer so this stays focused on
  // the UI wiring (the mission runtime is covered by the host suites).
  await evaluate(cdp, `window.__teamRunCalls = []; (() => {
    window.__originalFetch = window.fetch
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || ''
      if (url.indexOf('/api/bots.teams.run') >= 0) {
        window.__teamRunCalls.push({ url: url, body: init && init.body })
        return Promise.resolve(new Response(JSON.stringify({
          ok: true, sessionId: 'visual-session', teamId: 'x', teamName: 'Engenharia', cwd: '/tmp', workspaceId: null,
        }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return window.__originalFetch.apply(this, arguments)
    }
  })()`)
  await evaluate(cdp, `${engCard}.querySelector('.dsh-bots-button-primary').click()`)
  await waitFor(cdp, `document.querySelector('.dsh-bots-root [role="dialog"] #dsh-send-number')`, 'send dialog')
  const sendButton = `[...document.querySelectorAll('.dsh-bots-root [role="dialog"] .dsh-bots-dialog-footer button')].pop()`
  assert.equal(await evaluate(cdp, `${sendButton}.disabled`), true, 'submit disabled while the card number is empty')
  await evaluate(cdp, `document.querySelector('#dsh-send-number').focus()`)
  await cdp.send('Input.insertText', { text: 'AB-482' })
  await sleep(150)
  await evaluate(cdp, `document.querySelector('#dsh-send-details').focus()`)
  await cdp.send('Input.insertText', { text: 'Corrigir o alinhamento do botão.' })
  await waitFor(cdp, `/482/.test(document.querySelector('#dsh-send-preview').textContent)`, 'preview with the AB number')
  const preview = await evaluate(cdp, `document.querySelector('#dsh-send-preview').textContent`)
  assert.equal(await evaluate(cdp, `document.querySelector('#dsh-send-number').value`), '482', 'AB-482 normalised to digits')
  assert.ok(preview.includes('AB-482') && preview.includes('Corrigir o alinhamento'), `template filled: ${preview}`)
  assert.ok(!preview.startsWith('[Time:'), `no draft/handoff prefix in v5: ${preview}`)
  assert.equal(await evaluate(cdp, `${sendButton}.disabled`), false, 'submit enabled once the number is set')
  await screenshot(cdp, 'teams-1c-send')
  await evaluate(cdp, `${sendButton}.click()`)
  await waitFor(cdp, `document.querySelector('.dsh-bots-root [role="dialog"] .dsh-team-okbox') && /visual-session/.test(document.querySelector('.dsh-bots-root [role="dialog"]').textContent)`, 'started session shown in the dialog', 30000)
  const runCalls = await evaluate(cdp, `window.__teamRunCalls`)
  assert.equal(runCalls.length, 1, 'one teams.run call')
  const runBody = JSON.parse(runCalls[0].body)
  assert.equal(runBody.id, team.id)
  assert.ok(runBody.prompt.includes('AB-482') && runBody.prompt.includes('Corrigir o alinhamento'), `prompt sent: ${runBody.prompt}`)
  await evaluate(cdp, `document.querySelector('.dsh-bots-root [role="dialog"] .dsh-bots-dialog-footer button').click()`)
  await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]')`, 'send dialog closed')

  console.log('6/6 editor + flow interactions')
  await clickButtonByText(cdp, `[data-team-id="${team.id}"]`, 'Abrir fluxo')
  await waitFor(cdp, `document.querySelectorAll('.dsh-flow-node').length > 5`, 'flow nodes')
  await waitFor(cdp, `[...document.querySelectorAll('.dsh-flow-node img')].every((img) => img.complete && img.naturalWidth > 0)`, 'node avatars')
  const total = await nodeCount(cdp)
  assert.equal(total, team.flow.nodes.length, 'every node rendered')
  const edgesDrawn = await evaluate(cdp, `document.querySelectorAll('.dsh-flow-edge').length`)
  assert.equal(edgesDrawn, team.flow.edges.length, 'every edge rendered')
  await screenshot(cdp, 'teams-2-editor')

  // Move: drag "red" 80 px right / 40 px down.
  const before = team.flow.nodes.find((node) => node.id === 'red')
  assert.ok(await evaluate(cdp, `parseFloat(document.querySelector('.dsh-team-zoom').textContent)`) >= 60, 'initial zoom is legible')
  await evaluate(cdp, `document.querySelector('[aria-label^="Mostrar/ocultar elementos"]').click()`)
  await sleep(150)
  assert.equal(await evaluate(cdp, `!!document.querySelector('.dsh-team-side')`), false, 'palette hidden')
  await evaluate(cdp, `document.querySelector('[aria-label^="Mostrar/ocultar elementos"]').click()`)
  await sleep(150)
  assert.equal(await evaluate(cdp, `!!document.querySelector('.dsh-team-side')`), true, 'palette restored')
  await evaluate(cdp, `document.querySelector('[aria-label="Ajustar à tela"]').click()`)
  await sleep(200)
  const zoom = await evaluate(cdp, `parseFloat(document.querySelector('.dsh-team-zoom').textContent) / 100`)
  const red = await rectOf(cdp, '[data-flow-node="red"]')
  await drag(cdp, { x: red.x, y: red.y }, { x: red.x + 80, y: red.y + 40 })
  assert.equal(await evaluate(cdp, `document.querySelector('[data-flow-node="red"]').classList.contains('is-selected')`), true, 'dragged node is selected')

  // Connect: from the right handle of "locate" to "review".
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...(await rectOf(cdp, '[data-flow-node="locate"]')) })
  const handle = await rectOf(cdp, '[data-flow-node="locate"] [data-flow-handle="right"]')
  const review = await rectOf(cdp, '[data-flow-node="review"]')
  const edgesBefore = await evaluate(cdp, `document.querySelectorAll('.dsh-flow-edge').length`)
  await drag(cdp, handle, review, 20)
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.dsh-flow-edge').length`), edgesBefore + 1, 'new edge drawn')
  await waitFor(cdp, `document.querySelector('#dsh-edge-label')`, 'edge inspector')
  await evaluate(cdp, `document.querySelector('#dsh-edge-label').focus()`)
  await cdp.send('Input.insertText', { text: 'atalho' })
  await sleep(150)

  // Add from the palette (click = add at the centre) and name it.
  const nodesBefore = await nodeCount(cdp)
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-team-palette-item')].find((el) => /Decisão|Decision/.test(el.textContent)).click()`)
  await waitFor(cdp, `document.activeElement && document.activeElement.id === 'dsh-node-label'`, 'label focused for new node')
  await cdp.send('Input.insertText', { text: 'Precisa de segurança?' })
  await sleep(150)
  assert.equal(await nodeCount(cdp), nodesBefore + 1, 'palette node added')

  // Delete "research" with the keyboard, then undo and redo.
  const research = await rectOf(cdp, '[data-flow-node="research"]')
  await click(cdp, research)
  await key(cdp, 'Delete', 'Delete', 46)
  assert.equal(await evaluate(cdp, `!!document.querySelector('[data-flow-node="research"]')`), false, 'deleted')
  await key(cdp, 'z', 'KeyZ', 90, CTRL)
  assert.equal(await evaluate(cdp, `!!document.querySelector('[data-flow-node="research"]')`), true, 'undo restores')
  await key(cdp, 'z', 'KeyZ', 90, CTRL | SHIFT)
  assert.equal(await evaluate(cdp, `!!document.querySelector('[data-flow-node="research"]')`), false, 'redo deletes again')
  await screenshot(cdp, 'teams-3-edited')

  // Save (Ctrl+S) and check the record.
  await click(cdp, await rectOf(cdp, '.dsh-flow-legend'))
  await key(cdp, 's', 'KeyS', 83, CTRL)
  await waitFor(cdp, `/Salvo|Saved/.test(document.querySelector('.dsh-team-bar .dsh-bots-badge').textContent)`, 'saved badge')
  let { teams } = await api('/api/bots.teams')
  let saved = teams.find((entryTeam) => entryTeam.id === team.id)
  const moved = saved.flow.nodes.find((node) => node.id === 'red')
  assert.ok(Math.abs(moved.x - before.x - 80 / zoom) <= 16 && Math.abs(moved.y - before.y - 40 / zoom) <= 16, `moved by the drag (${before.x},${before.y} -> ${moved.x},${moved.y}, zoom ${zoom})`)
  assert.ok(saved.flow.edges.some((edge) => edge.from === 'locate' && edge.to === 'review' && edge.label === 'atalho'), 'connected + labelled edge saved')
  assert.ok(saved.flow.nodes.some((node) => node.type === 'decision' && node.label === 'Precisa de segurança?'), 'palette node saved')
  assert.ok(!saved.flow.nodes.some((node) => node.id === 'research'), 'deleted node saved')

  // v5: add a member by picking an existing bit (grouped picker).
  const membersBefore = await evaluate(cdp, `document.querySelectorAll('.dsh-team-member').length`)
  await clickButtonByText(cdp, '.dsh-team-side', 'Adicionar bit')
  await waitFor(cdp, `document.querySelector('#dsh-add-member-bit')`, 'add-member bit picker')
  assert.ok(await evaluate(cdp, `document.querySelectorAll('#dsh-add-member-bit optgroup').length > 0`), 'bit picker groups by catalog group')
  await setSelect(cdp, '#dsh-add-member-bit', workerBit.id)
  await clickButtonByText(cdp, '.dsh-bots-root [role="dialog"] .dsh-bots-dialog-footer', 'Adicionar')
  await waitFor(cdp, `document.querySelectorAll('.dsh-team-member').length === ${membersBefore + 1}`, 'member added from a bit')
  // The editor selects the new member: the inspector opens on it directly.
  await waitFor(cdp, `document.querySelector('#dsh-member-bit') && document.querySelector('#dsh-member-bit').value === ${JSON.stringify(workerBit.id)}`, 'member inspector of the new bit')
  assert.ok(await evaluate(cdp, `[...document.querySelectorAll('.dsh-team-member')].some((el) => /Builder visual/.test(el.textContent))`), 'new member shown in the side list')
  await evaluate(cdp, `document.querySelector('.dsh-team-inspector').scrollTop = 0`)
  const memberView = await evaluate(cdp, `({
    bit: document.querySelector('#dsh-member-bit').value,
    route: document.querySelector('.dsh-bots-bit-hero').textContent,
    hasModelInput: !!document.querySelector('#dsh-member-model'),
    hasProviderInput: !!document.querySelector('#dsh-member-provider'),
    hasNameInput: !!document.querySelector('#dsh-member-name'),
    hasInstructionsInput: !!document.querySelector('#dsh-member-instructions'),
    hasRole: !!document.querySelector('#dsh-member-role'),
    hasAccess: !!document.querySelector('#dsh-member-access'),
    makeLeadDisabled: (() => { const b = [...document.querySelectorAll('.dsh-team-lead-row button')].find((el) => /Tornar líder|Make lead/.test(el.textContent)); return b ? b.disabled : null })(),
    leadHint: document.querySelector('.dsh-team-lead-row').textContent,
    trim: document.querySelector('.dsh-team-inspector').scrollTop === 0,
  })`)
  assert.equal(memberView.bit, workerBit.id, 'member references the picked bit')
  assert.ok(/Worker/.test(memberView.route) && /Claude Sonnet 5\.5 \(assinatura\)/.test(memberView.route) && /high/.test(memberView.route), `read-only route in the member hero: ${memberView.route}`)
  assert.equal(memberView.hasModelInput, false, 'no member model input')
  assert.equal(memberView.hasProviderInput, false, 'no member provider input')
  assert.equal(memberView.hasNameInput, false, 'no member name input')
  assert.equal(memberView.hasInstructionsInput, false, 'no member instructions input')
  assert.ok(memberView.hasRole && memberView.hasAccess, 'role and access stay editable')
  assert.equal(memberView.makeLeadDisabled, true, 'a worker bit cannot become lead')
  assert.ok(/precisa ser um bit orquestrador|must be an orchestrator bit/.test(memberView.leadHint), `lead rule hint: ${memberView.leadHint}`)
  await screenshot(cdp, 'teams-4-member-v5')

  // Lead rule in the team inspector: only orchestrator members are offered.
  await evaluate(cdp, `document.querySelector('.dsh-flow-canvas').focus()`)
  await key(cdp, 'Escape', 'Escape', 27)
  await waitFor(cdp, `document.querySelector('#dsh-team-prop-lead')`, 'team inspector lead select')
  const leadUi = await evaluate(cdp, `(() => {
    const select = document.querySelector('#dsh-team-prop-lead')
    return { value: select.value, options: [...select.options].map((option) => option.value) }
  })()`)
  assert.equal(leadUi.value, leadMember.id, 'lead select shows the stored lead')
  assert.ok(leadUi.options.includes(leadMember.id), 'orchestrator lead offered')
  assert.ok(!leadUi.options.includes('builder') && !leadUi.options.includes('scout'), `worker members are not lead options: ${JSON.stringify(leadUi.options)}`)
  assert.ok(await evaluate(cdp, `document.querySelectorAll('.dsh-team-entry').length === 2`), 'request templates rows')
  if (harnessRoutes) {
    assert.equal(await evaluate(cdp, `document.querySelector('#dsh-team-prop-harness').value`), PACK_ID, 'harness select shows the pack')
    assert.equal(await evaluate(cdp, `document.querySelectorAll('#dsh-team-prop-skills input[type="checkbox"]').length`), 2, 'visible-skills checklist')
  }
  await evaluate(cdp, `document.querySelector('#dsh-team-prop-lead').closest('.dsh-team-section').scrollIntoView({ block: 'start' })`)
  await screenshot(cdp, 'teams-7-team-inspector')

  // Team node round-trip (unchanged) + save the new member.
  await evaluate(cdp, `document.querySelector('.dsh-flow-canvas').focus()`)
  await key(cdp, 's', 'KeyS', 83, CTRL)
  await waitFor(cdp, `/Salvo|Saved/.test(document.querySelector('.dsh-team-bar .dsh-bots-badge').textContent)`, 'saved badge (v5)')
  teams = await listTeams()
  saved = teams.find((entryTeam) => entryTeam.id === team.id)
  assert.ok(saved.members.some((member) => member.bitId === workerBit.id), 'new member bitId saved')
  assert.equal(saved.lead, leadMember.id, 'lead kept by the editor save')
  assert.equal(saved.workspaceDir, repoDir, 'workspace kept')
  assert.deepEqual(saved.entry, requestEntries, 'request templates kept')
  if (harnessRoutes) assert.equal(saved.harness, PACK_ID, 'harness kept')
  assert.ok(saved.flow.nodes.some((node) => node.type === 'decision' && node.label === 'Precisa de segurança?'), 'palette node round-trips')
  assert.ok(!saved.flow.nodes.some((node) => node.id === 'research'), 'deleted node stays deleted')

  console.log('ok - teams v5: fromTemplate in the UI, fresh bitId members, orchestrator-only lead, teams.run wiring')
  console.log('ok - teams editor: render, move, connect, label, add, delete, undo/redo, save, member bit picker, read-only route')
}

let failed = false
try {
  await main()
} catch (error) {
  failed = true
  console.error(error)
} finally {
  if (chrome) chrome.kill('SIGKILL')
  if (host) {
    host.removeAllListeners('exit')
    host.kill('SIGTERM')
    await sleep(500)
    host.kill('SIGKILL')
  }
  for (const dir of [chromeDir, tempHome]) if (dir) await fs.rm(dir, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
