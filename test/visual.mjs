#!/usr/bin/env node
/**
 * Visual check for the Bots page.
 *
 * Boots a throwaway DSH Web host (isolated DSH_HOME, never the user's profile)
 * with this bundle, seeds sample bots through the real routes, then drives a
 * headless Chrome over the DevTools Protocol to capture screenshots of:
 *   1. the bot list, 2. the "New bot" dialog, 3. the delete confirmation.
 * Screenshots land in `test/screenshots/` (light or dark via --theme).
 *
 * Usage: node test/visual.mjs [--theme dark|light] [--width 1280] [--height 860]
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

async function main() {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}`)
  await fs.mkdir(OUT_DIR, { recursive: true })
  console.log('1/4 profile + host')
  await installProfile()
  const tokenUrl = await bootHost(await freePort())
  const exchange = await fetch(tokenUrl, { redirect: 'manual' })
  cookie = exchange.headers.getSetCookie()[0].split(';', 1)[0]
  origin = new URL(tokenUrl).origin

  console.log('2/4 seed bots')
  await api('/api/bots.create', {
    name: 'Pesquisador',
    emoji: '🔬',
    color: '#2563eb',
    instructions: 'Você é um pesquisador meticuloso. Cite fontes, compare evidências e resuma em português claro, com uma conclusão objetiva no final de cada resposta.',
    vm: { enabled: true, image: 'ubuntu:24.04' },
  })
  await api('/api/bots.create', {
    name: 'Escritor',
    emoji: '✍️',
    color: '#db2777',
    instructions: 'Escreve textos curtos, revisa gramática e adapta o tom ao público.',
    vm: { enabled: false },
  })
  await api('/api/bots.create', {
    name: 'DevOps',
    emoji: '🛠️',
    color: '#059669',
    instructions: '',
    vm: { enabled: true, image: 'imagem-que-nao-existe:latest' },
  })

  console.log('3/4 chrome')
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

  console.log('4/4 screenshots')
  // Open the Bots panel from the sidebar entry (matched by its accessible label).
  await waitFor(cdp, `[...document.querySelectorAll('nav button, nav a, [role="button"], button')].some((el) => /^\\s*Bots\\s*$/.test(el.textContent || el.getAttribute('aria-label') || ''))`, 'Bots sidebar entry', 60000)
  await evaluate(cdp, `[...document.querySelectorAll('nav button, nav a, [role="button"], button')].find((el) => /^\\s*Bots\\s*$/.test(el.textContent || el.getAttribute('aria-label') || '')).click()`)
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length >= 3`, 'bot cards')
  // A fresh profile shows the host's one-time preview notice; dismiss it.
  await new Promise((resolve) => setTimeout(resolve, 800))
  for (let round = 0; round < 4; round += 1) {
    await evaluate(cdp, `(() => {
      const outside = (el) => !el.closest('.dsh-bots-root')
      const next = [...document.querySelectorAll('button')].filter(outside).find((el) => /^(Continuar|Continue)$/.test(el.textContent.trim()))
        ?? [...document.querySelectorAll('[role="dialog"] button[aria-label], [aria-modal="true"] button[aria-label]')].filter(outside).find((el) => /fechar|close/i.test(el.getAttribute('aria-label')))
      if (next) next.click()
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  await screenshot(cdp, '1-list')

  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-toolbar button')].at(-1).click()`)
  await waitFor(cdp, `document.querySelector('.dsh-bots-dialog')`, 'create dialog')
  await screenshot(cdp, '2-create-dialog')
  // Sanity: the dialog must paint an opaque surface over a dimmed backdrop.
  const surfaces = await evaluate(cdp, `(() => {
    const dialog = getComputedStyle(document.querySelector('.dsh-bots-dialog'))
    const overlay = getComputedStyle(document.querySelector('.dsh-bots-overlay'))
    const input = getComputedStyle(document.querySelector('.dsh-bots-dialog .dsh-bots-input'))
    return { dialog: dialog.backgroundColor, overlay: overlay.backgroundColor, inputBorder: input.borderTopColor + ' ' + input.borderTopWidth }
  })()`)
  console.log('   computed', JSON.stringify(surfaces))
  assert.notEqual(surfaces.dialog, 'rgba(0, 0, 0, 0)', 'dialog surface is transparent')
  assert.notEqual(surfaces.overlay, 'rgba(0, 0, 0, 0)', 'overlay backdrop is transparent')

  await evaluate(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await evaluate(cdp, `document.querySelector('.dsh-bots-dialog') && document.querySelector('.dsh-bots-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await waitFor(cdp, `!document.querySelector('.dsh-bots-dialog')`, 'dialog closed')
  await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-card .dsh-bots-button-danger')][0].click()`)
  await waitFor(cdp, `document.querySelector('.dsh-bots-dialog')`, 'delete dialog')
  await screenshot(cdp, '3-delete-dialog')
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
  // No VM is started by this script, so there is no container to clean up;
  // never sweep `dsh-bot-*` containers here, they may be the user's real bots.
  for (const dir of [chromeDir, tempHome]) if (dir) await fs.rm(dir, { recursive: true, force: true })
}
