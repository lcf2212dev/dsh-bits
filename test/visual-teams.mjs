#!/usr/bin/env node
/**
 * Visual + interaction check for the Teams tab and its flow editor.
 *
 * Boots a throwaway DSH Web host (isolated DSH_HOME, never the user profile),
 * creates a team from the shipped "engineering" template (or imports
 * --team-file <teams.json|export.json>), opens the editor in headless Chrome
 * and drives real pointer/keyboard input: move a node, connect two nodes,
 * add from the palette, delete, undo and save. The saved record is then
 * checked through /api/bots.teams. Screenshots go to --out (default
 * test/screenshots/).
 *
 * Usage: node test/visual-teams.mjs [--theme dark|light] [--team-file f] [--out dir]
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
const WIDTH = Number(option('width', '1280'))
const HEIGHT = Number(option('height', '860'))

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
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bots-visual-home-'))
  const dir = path.join(tempHome, 'profiles', PROFILE)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'cordis.yml'), '[]\n')
  await fs.writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-bots-visual',
    private: true,
    dependencies: { '@local/dsh-bots': `file:${BUNDLE_DIR}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@local/dsh-bots'] } },
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

async function main() {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}`)
  await fs.mkdir(OUT_DIR, { recursive: true })
  console.log('1/5 profile + host')
  await installProfile()
  const tokenUrl = await bootHost(await freePort())
  const exchange = await fetch(tokenUrl, { redirect: 'manual' })
  cookie = exchange.headers.getSetCookie()[0].split(';', 1)[0]
  origin = new URL(tokenUrl).origin

  console.log('2/5 seed team')
  const teamFile = option('team-file', null)
  let input
  if (teamFile) {
    const raw = JSON.parse(await fs.readFile(teamFile, 'utf8'))
    input = Array.isArray(raw.teams) ? raw.teams[0] : (raw.team ?? raw)
  } else {
    const { templates } = await api('/api/bots.teams.templates')
    const template = templates.find((entry) => entry.id === 'engineering')
    assert.ok(template, 'engineering template served by the real host')
    input = template.team
  }
  const { team } = await api('/api/bots.teams.create', { team: input })
  const usesTemplate = !teamFile

  // v3 (CONTRACT.md §11): make the first team runnable (workspace + lead + request
  // templates) and add a second team that owns the same workspace, so the
  // "Enviar pedido" preview must carry the `[Time: <name>] ` handoff prefix.
  const repoDir = path.join(tempHome, 'repo')
  await fs.mkdir(repoDir, { recursive: true })
  const leadId = team.members.some((member) => member.id === 'coordinator') ? 'coordinator' : team.members[0]?.id
  assert.ok(leadId, 'seed team has a member to lead')
  const requestEntries = [
    { id: 'pimpl', label: 'Implementar card', template: 'Implemente o card AB-{n}. {pedido}' },
    { id: 'pfree', label: 'Revisar PR', template: 'Revise o PR aberto: {pedido}' },
  ]
  const runnable = await api('/api/bots.teams.update', { id: team.id, patch: { workspaceDir: repoDir, lead: leadId, entry: requestEntries } })
  assert.equal(runnable.team.lead, leadId, 'host stores the lead (§11.1)')
  const { team: platform } = await api('/api/bots.teams.create', {
    team: {
      name: 'Plataforma', emoji: '🛰️', color: '#0891b2', workspaceDir: repoDir, bindWorkspace: true, lead: 'lead',
      members: [{ id: 'lead', name: 'Líder da plataforma', character: 'bit-coordinator' }],
      flow: { nodes: [{ id: 'start', type: 'start', x: 0, y: 0, label: 'Pedido' }], edges: [] },
    },
  })
  assert.equal(platform.bindWorkspace, true, 'host stores bindWorkspace (§11.1)')

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

  console.log('3/5 chrome')
  const cdpPort = await freePort()
  chromeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bots-visual-chrome-'))
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

  console.log('4/5 teams tab + editor')
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

  // Card badges: lead of the runnable team, workspace binding of the other one.
  const cardTexts = await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-card')].map((el) => el.textContent)`)
  assert.ok(/Líder: |Lead: /.test(cardTexts[0]), `lead badge on the first card: ${cardTexts[0].slice(0, 200)}`)
  assert.ok(/Workspace vinculado|Workspace bound/.test(cardTexts[1]), 'bound-workspace badge on the second card')

  // Harness dialog opens even when the Host lacks /api/bots.harness (it shows an error or the list).
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-toolbar button')].find((el) => el.textContent.trim() === 'Harness').click()`)
  await waitFor(cdp, `document.querySelector('.dsh-bots-root [role="dialog"] #dsh-harness-source')`, 'harness dialog')
  await waitFor(cdp, `!/Carregando harness|Loading harness/.test(document.querySelector('.dsh-bots-root [role="dialog"]').textContent)`, 'harness list settled')
  if (harnessRoutes) {
    // Import a tiny harness through the form, then create a team from it.
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
    await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]') && document.querySelectorAll('.dsh-bots-card').length === 3`, 'team created from the pack')
    // The engineering team carries the pack too (badge + editor checklists).
    await api('/api/bots.teams.update', { id: team.id, patch: { harness: PACK_ID } })
    await evaluate(cdp, `document.querySelector('.dsh-bots-toolbar [aria-label="Atualizar"]').click()`)
    await waitFor(cdp, `/Harness ${PACK_ID} v7/.test(document.querySelector('.dsh-bots-card').textContent)`, 'harness badge on the card')
    await screenshot(cdp, 'teams-1d-list-harness')
  } else {
    await evaluate(cdp, `document.querySelector('.dsh-bots-root [role="dialog"] .dsh-bots-dialog-head button').click()`)
    await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]')`, 'harness dialog closed')
  }

  // "Enviar pedido": template with {n}, AB number normalised, live preview with the handoff prefix. Never submitted.
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-card')][0].querySelector('.dsh-bots-actions .dsh-bots-button-primary').click()`)
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
  assert.ok(preview.startsWith(`[Time: ${runnable.team.name}] `), `handoff prefix in the preview: ${preview}`)
  assert.ok(preview.includes('AB-482') && preview.includes('Corrigir o alinhamento'), `template filled: ${preview}`)
  assert.equal(await evaluate(cdp, `${sendButton}.disabled`), false, 'submit enabled once the number is set')
  await screenshot(cdp, 'teams-1c-send')
  await evaluate(cdp, `document.querySelector('.dsh-bots-root [role="dialog"] .dsh-bots-dialog-footer button').click()`)
  await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]')`, 'send dialog closed')

  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-card button')].find((el) => /Abrir fluxo|Open flow/.test(el.textContent)).click()`)
  await waitFor(cdp, `document.querySelectorAll('.dsh-flow-node').length > 5`, 'flow nodes')
  await waitFor(cdp, `[...document.querySelectorAll('.dsh-flow-node img')].every((img) => img.complete && img.naturalWidth > 0)`, 'node avatars')
  const total = await nodeCount(cdp)
  assert.equal(total, team.flow.nodes.length, 'every node rendered')
  const edgesDrawn = await evaluate(cdp, `document.querySelectorAll('.dsh-flow-edge').length`)
  assert.equal(edgesDrawn, team.flow.edges.length, 'every edge rendered')
  await screenshot(cdp, 'teams-2-editor')

  if (!usesTemplate) {
    console.log('5/5 (imported team: interaction checks skipped)')
    return
  }

  console.log('5/5 interactions')
  // Move: drag "red" 80 px right / 40 px down.
  const before = team.flow.nodes.find((node) => node.id === 'red')
  assert.ok(await evaluate(cdp, `parseFloat(document.querySelector('.dsh-team-zoom').textContent)`) >= 60, 'initial zoom is legible')
  // Panel toggles hide and restore the side panels.
  await evaluate(cdp, `document.querySelector('[aria-label^="Mostrar/ocultar elementos"]').click()`)
  await sleep(150)
  assert.equal(await evaluate(cdp, `!!document.querySelector('.dsh-team-side')`), false, 'palette hidden')
  await evaluate(cdp, `document.querySelector('[aria-label^="Mostrar/ocultar elementos"]').click()`)
  await sleep(150)
  assert.equal(await evaluate(cdp, `!!document.querySelector('.dsh-team-side')`), true, 'palette restored')
  // Fit the whole flow for the pointer checks.
  await evaluate(cdp, `document.querySelector('[aria-label="Ajustar à tela"]').click()`)
  await sleep(200)
  const zoom = await evaluate(cdp, `parseFloat(document.querySelector('.dsh-team-zoom').textContent) / 100`)
  const red = await rectOf(cdp, '[data-flow-node="red"]')
  await drag(cdp, { x: red.x - 40, y: red.y }, { x: red.x + 40, y: red.y + 40 })
  assert.equal(await evaluate(cdp, `document.querySelector('[data-flow-node="red"]').classList.contains('is-selected')`), true, 'dragged node is selected')

  // Connect: from the right handle of "locate" to "review".
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...(await rectOf(cdp, '[data-flow-node="locate"]')) })
  const handle = await rectOf(cdp, '[data-flow-node="locate"] [data-flow-handle="right"]')
  const review = await rectOf(cdp, '[data-flow-node="review"]')
  const edgesBefore = await evaluate(cdp, `document.querySelectorAll('.dsh-flow-edge').length`)
  await drag(cdp, handle, review, 20)
  assert.equal(await evaluate(cdp, `document.querySelectorAll('.dsh-flow-edge').length`), edgesBefore + 1, 'new edge drawn')
  // The new edge is selected: label it through the inspector.
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
  const { teams } = await api('/api/bots.teams')
  const saved = teams.find((entry) => entry.id === team.id)
  const moved = saved.flow.nodes.find((node) => node.id === 'red')
  assert.ok(Math.abs(moved.x - before.x - 80 / zoom) <= 16 && Math.abs(moved.y - before.y - 40 / zoom) <= 16, `moved by the drag (${before.x},${before.y} -> ${moved.x},${moved.y}, zoom ${zoom})`)
  assert.ok(saved.flow.edges.some((edge) => edge.from === 'locate' && edge.to === 'review' && edge.label === 'atalho'), 'connected + labelled edge saved')
  assert.ok(saved.flow.nodes.some((node) => node.type === 'decision' && node.label === 'Precisa de segurança?'), 'palette node saved')
  assert.ok(!saved.flow.nodes.some((node) => node.id === 'research'), 'deleted node saved')
  assert.ok(!saved.flow.edges.some((edge) => edge.from === 'research' || edge.to === 'research'), 'incident edges removed')

  // Member focus: selecting a member dims the other steps.
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-team-member')].find((el) => /Builder/.test(el.textContent)).click()`)
  await waitFor(cdp, `document.querySelector('.dsh-flow-node.is-dimmed') && document.querySelector('#dsh-member-name')`, 'member highlight')
  await screenshot(cdp, 'teams-4-member')

  // Edge inspector through a label click.
  // Focus must never scroll the board (overflow:hidden boxes still scroll programmatically).
  await evaluate(cdp, `document.querySelector('.dsh-flow-edge-label').scrollIntoView()`)
  await sleep(100)
  assert.equal(await evaluate(cdp, `document.querySelector('.dsh-flow-canvas').scrollTop + document.querySelector('.dsh-flow-canvas').scrollLeft`), 0, 'board never scrolls')
  await click(cdp, await rectOf(cdp, '.dsh-flow-edge-label'))
  await waitFor(cdp, `document.querySelector('#dsh-edge-kind')`, 'edge inspector from label')
  await screenshot(cdp, 'teams-5-edge')

  // v3: handoff edge kind.
  await setSelect(cdp, '#dsh-edge-kind', 'handoff')
  await waitFor(cdp, `document.querySelector('.dsh-flow-edge.dsh-flow-edge-handoff')`, 'handoff edge drawn')
  assert.ok(await evaluate(cdp, `/passagem|handoff/.test(document.querySelector('.dsh-flow-legend').textContent)`), 'handoff legend item')

  // v3: "Time" palette element → team node → pick the other team.
  const teamItem = `[...document.querySelectorAll('.dsh-team-palette-item')].find((el) => /^(Time|Team)$/.test(el.textContent.trim()))`
  assert.ok(await evaluate(cdp, `Boolean(${teamItem})`), 'palette has the Time element')
  const teamNodesBefore = await evaluate(cdp, `document.querySelectorAll('.dsh-flow-node-team').length`)
  await evaluate(cdp, `${teamItem}.click()`)
  await waitFor(cdp, `document.querySelectorAll('.dsh-flow-node-team').length === ${teamNodesBefore + 1}`, 'team node rendered')
  await waitFor(cdp, `document.querySelector('#dsh-node-team')`, 'team node inspector')
  assert.ok(await evaluate(cdp, `[...document.querySelector('#dsh-node-team').options].some((option) => option.value === ${JSON.stringify(platform.id)})`), 'other team offered')
  await setSelect(cdp, '#dsh-node-team', platform.id)
  await waitFor(cdp, `[...document.querySelectorAll('.dsh-flow-node-team')].some((el) => /Plataforma/.test(el.textContent))`, 'team node shows the referenced team')
  assert.equal(await evaluate(cdp, `document.querySelector('#dsh-node-label').value`), 'Plataforma', 'default label follows the team name')
  // The node was added at the centre and zoom keeps the centre: zoom to ~100% to see it.
  for (let step = 0; step < 5; step += 1) await evaluate(cdp, `document.querySelector('[aria-label="Aproximar"]').click()`)
  await screenshot(cdp, 'teams-6-team-node')
  await evaluate(cdp, `document.querySelector('[aria-label="Ajustar à tela"]').click()`)

  // v3: team inspector (nothing selected) shows the lead select with the stored lead.
  await evaluate(cdp, `document.querySelector('.dsh-flow-canvas').focus()`)
  await key(cdp, 'Escape', 'Escape', 27)
  await waitFor(cdp, `document.querySelector('#dsh-team-prop-lead')`, 'team inspector lead select')
  assert.equal(await evaluate(cdp, `document.querySelector('#dsh-team-prop-lead').value`), leadId, 'lead select shows the lead')
  assert.ok(await evaluate(cdp, `Boolean(document.querySelector('#dsh-team-prop-harness')) && document.querySelectorAll('.dsh-team-entry').length === 2`), 'harness select + request rows')
  if (harnessRoutes) {
    assert.equal(await evaluate(cdp, `document.querySelector('#dsh-team-prop-harness').value`), PACK_ID, 'harness select shows the pack')
    const summary = await evaluate(cdp, `document.querySelector('#dsh-team-prop-harness').parentElement.textContent`)
    assert.ok(/v7 · 1 presets · 2 skills · 0 instruções · patches 0\/2/.test(summary), `pack summary line: ${summary}`)
    assert.equal(await evaluate(cdp, `document.querySelectorAll('#dsh-team-prop-skills input[type="checkbox"]').length`), 2, 'visible-skills checklist')
  }
  await evaluate(cdp, `document.querySelector('#dsh-team-prop-lead').closest('.dsh-team-section').scrollIntoView({ block: 'start' })`)
  await screenshot(cdp, 'teams-7-team-inspector')

  // v3: member inspector → lead badge / "Tornar líder" + team reference select.
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-team-member')].find((el) => /Builder/.test(el.textContent)).click()`)
  await waitFor(cdp, `document.querySelector('#dsh-member-teamref')`, 'member teamRef select')
  assert.ok(await evaluate(cdp, `/Tornar líder|Make lead/.test(document.querySelector('.dsh-team-lead-row').textContent)`), 'make-lead button for a non-lead')
  assert.ok(await evaluate(cdp, `[...document.querySelectorAll('.dsh-team-member')].some((el) => /Líder|Lead/.test(el.querySelector('.dsh-team-tag')?.textContent || ''))`), 'lead tag in the member list')
  assert.equal(await evaluate(cdp, `document.querySelector('.dsh-team-inspector').scrollTop`), 0, 'member inspector opens at its top')
  if (harnessRoutes) {
    assert.equal(await evaluate(cdp, `document.querySelectorAll('#dsh-member-skills input[type="checkbox"]').length`), 2, 'member skills from the pack')
    assert.ok(await evaluate(cdp, `/figma/.test(document.querySelector('#dsh-member-mcp').textContent)`), 'member MCP servers from the pack')
    await evaluate(cdp, `[...document.querySelectorAll('#dsh-member-skills label')].find((el) => el.textContent.trim() === 'tdd').querySelector('input').click()`)
    await evaluate(cdp, `[...document.querySelectorAll('#dsh-member-mcp label')].find((el) => el.textContent.trim() === 'figma').querySelector('input').click()`)
    await sleep(150)
    await evaluate(cdp, `document.querySelector('#dsh-member-skills').scrollIntoView({ block: 'center' })`)
  }
  await screenshot(cdp, 'teams-8-member-v3')

  // Save again: the new node, edge kind and the v3 team fields round-trip through the client payload.
  await evaluate(cdp, `document.querySelector('.dsh-flow-canvas').focus()`)
  await key(cdp, 's', 'KeyS', 83, CTRL)
  await waitFor(cdp, `/Salvo|Saved/.test(document.querySelector('.dsh-team-bar .dsh-bots-badge').textContent)`, 'saved badge (v3)')
  const after = (await api('/api/bots.teams')).teams.find((item) => item.id === team.id)
  assert.ok(after.flow.nodes.some((node) => node.type === 'team' && node.teamRef === platform.id), 'team node saved with teamRef')
  assert.ok(after.flow.edges.some((edge) => edge.kind === 'handoff'), 'handoff edge saved')
  assert.equal(after.lead, leadId, 'lead kept by the editor save')
  assert.equal(after.workspaceDir, repoDir, 'workspace kept')
  assert.deepEqual(after.entry, requestEntries, 'request templates kept')
  if (harnessRoutes) {
    assert.equal(after.harness, PACK_ID, 'harness kept')
    const builder = after.members.find((member) => member.id === 'builder')
    assert.deepEqual([builder.skills, builder.mcp], [['tdd'], ['figma']], 'member skills + MCP saved')
  }
  console.log('ok - teams editor: render, move, connect, label, add, delete, undo/redo, save, member focus, edge select')
  console.log('ok - teams v3: card badges, harness dialog, send-request preview, handoff edge, team node, lead select, round-trip save')
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
