#!/usr/bin/env node
/**
 * Visual + interaction check for the Projects tab (CONTRACT §12).
 *
 * Boots a throwaway DSH Web host (isolated DSH_HOME, never the user profile),
 * drives headless Chrome over CDP and walks the whole v4 flow through the UI:
 * creates a project, adds existing teams, creates a team inside the project,
 * toggles `shared` and the project assignment in the team editor, verifies a
 * non-shared team already in another project cannot be picked, removes a team
 * from the project and deletes the project (teams are detached, not deleted).
 * Every step is also checked through /api/bots.projects and /api/bots.teams.
 * Screenshots go to --out (default test/screenshots/).
 *
 * Usage: node test/visual-projects.mjs [--theme dark|light] [--lang pt|en] [--out dir]
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
const OUT_DIR = path.resolve(process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(HERE, 'screenshots'))
const INSTALL_ROOT = process.env.DSH_INSTALL_ROOT ?? path.join(os.homedir(), '.local', 'opt', 'deepseek-harness')
const RUNTIME = path.join(INSTALL_ROOT, 'resources', 'runtime', 'primary-runtime')
const RUNTIME_NODE = path.join(RUNTIME, 'dependencies', 'node', 'bin', 'node')
const RUNTIME_PNPM = path.join(RUNTIME, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
const CHROME = process.env.CHROME_BIN ?? '/usr/bin/google-chrome-stable'
const PROFILE = 'bots-visual-projects'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const THEME = option('theme', 'dark')
const WIDTH = Number(option('width', '1280'))
const HEIGHT = Number(option('height', '860'))

const PT = option('lang', 'pt') !== 'en'
const txt = (pt, en) => (PT ? pt : en)

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

const listProjects = async () => (await api('/api/bots.projects')).projects
const listTeams = async () => (await api('/api/bots.teams')).teams

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

async function key(cdp, keyName, code, keyCode, modifiers = 0) {
  const base = { key: keyName, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(150)
}

const CTRL = 2

async function typeInto(cdp, selector, text) {
  await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).focus()`)
  await cdp.send('Input.insertText', { text })
  await sleep(150)
}

async function clearAndType(cdp, selector, text) {
  await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    el.focus()
    if (typeof el.setSelectionRange === 'function') el.setSelectionRange(0, el.value.length)
    else el.select()
  })()`)
  await cdp.send('Input.insertText', { text })
  await sleep(150)
}

/** Click the first toolbar button whose text or aria-label matches `label`. */
async function clickToolbar(cdp, label) {
  const ok = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('.dsh-bots-toolbar button')].find((el) => {
      const text = (el.textContent || '').trim()
      const aria = el.getAttribute('aria-label') || ''
      return new RegExp(${JSON.stringify(label)}).test(text) || new RegExp(${JSON.stringify(label)}).test(aria)
    })
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.ok(ok, `toolbar button ${label}`)
  await sleep(250)
}

/** Click a page tab by label. */
async function clickTab(cdp, label) {
  const ok = await evaluate(cdp, `(() => {
    const tab = [...document.querySelectorAll('.dsh-bots-tab')].find((el) => new RegExp(${JSON.stringify(label)}).test(el.textContent || ''))
    if (!tab) return false
    tab.click()
    return true
  })()`)
  assert.ok(ok, `tab ${label}`)
  await sleep(400)
}

/** Click the modal footer button matching `label`. */
async function clickDialogFooter(cdp, label) {
  const ok = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('.dsh-bots-root [role="dialog"] .dsh-bots-dialog-footer button')]
      .find((el) => new RegExp(${JSON.stringify(label)}).test(el.textContent || ''))
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.ok(ok, `dialog footer ${label}`)
  await sleep(250)
}

/** Click a button inside the project/team card whose text contains `card`. */
async function clickCardAction(cdp, card, label) {
  const ok = await evaluate(cdp, `(() => {
    const cardEl = [...document.querySelectorAll('.dsh-bots-card')]
      .find((el) => new RegExp(${JSON.stringify(card)}).test(el.textContent || ''))
    if (!cardEl) return 'no-card'
    const button = [...cardEl.querySelectorAll('button')].find((el) => {
      const text = (el.textContent || '').trim()
      const aria = el.getAttribute('aria-label') || ''
      return new RegExp(${JSON.stringify(label)}).test(text) || new RegExp(${JSON.stringify(label)}).test(aria)
    })
    if (!button) return 'no-button'
    button.click()
    return 'ok'
  })()`)
  assert.equal(ok, 'ok', `card action ${card} / ${label}`)
  await sleep(250)
}

/** Toggle the checkbox (inside `.dsh-bots-check`) whose label matches `label` in `scope`. */
async function toggleCheckbox(cdp, scope, label) {
  const ok = await evaluate(cdp, `(() => {
    const root = document.querySelector(${JSON.stringify(scope)})
    if (!root) return false
    const item = [...root.querySelectorAll('.dsh-bots-check')].find((el) => new RegExp(${JSON.stringify(label)}).test(el.textContent || ''))
    if (!item) return false
    item.querySelector('input[type="checkbox"]').click()
    return true
  })()`)
  assert.ok(ok, `checkbox ${label} in ${scope}`)
  await sleep(250)
}

async function setSelect(cdp, selector, value) {
  await evaluate(cdp, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await sleep(200)
}

async function createTeamViaApi(name, description) {
  const { team } = await api('/api/bots.teams.create', {
    team: {
      name: name,
      description: description,
      emoji: '🤖',
      color: '#2563eb',
      members: [],
      flow: { nodes: [{ id: 'start', type: 'start', x: 0, y: 0, label: 'Pedido' }], edges: [] },
    },
  })
  return team
}

/** Open a project from the list by clicking its Abrir button. */
async function openProjectByCard(cdp, name) {
  await clickCardAction(cdp, name, txt('Abrir', 'Open'))
  await waitFor(cdp, `document.querySelector('.dsh-project-name') && new RegExp(${JSON.stringify(name)}).test(document.querySelector('.dsh-project-name').textContent)`, `project detail ${name}`)
}

async function main() {
  assert.ok(existsSync(CHROME), `Chrome not found at ${CHROME}`)
  await fs.mkdir(OUT_DIR, { recursive: true })
  console.log('1/8 profile + host')
  await installProfile()
  const tokenUrl = await bootHost(await freePort())
  const exchange = await fetch(tokenUrl, { redirect: 'manual' })
  cookie = exchange.headers.getSetCookie()[0].split(';', 1)[0]
  origin = new URL(tokenUrl).origin

  // Seed teams through the API; every project mutation below goes through the UI.
  console.log('2/8 seed teams')
  const alpha = await createTeamViaApi('Alpha', 'Time do design system')
  const beta = await createTeamViaApi('Beta', 'Time da plataforma')
  const gama = await createTeamViaApi('Gama', 'Time de revisão')
  assert.deepEqual((await listProjects()).length, 0, 'fresh profile has no projects')

  console.log('3/8 chrome')
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

  console.log('4/8 projects tab: empty state + create project through the UI')
  await clickTab(cdp, txt('Projetos|Projects', 'Projects|Projetos'))
  await waitFor(cdp, `document.querySelector('.dsh-bots-tabs') && /Projetos|Projects/.test(document.querySelector('.dsh-bots-tabs').textContent)`, 'projects tab selected')
  await waitFor(cdp, `(() => { const body = document.querySelector('.dsh-bots-body'); return Boolean(body && new RegExp(${JSON.stringify(txt('Nenhum projeto ainda', 'No projects yet'))}).test(body.textContent)) })()`, 'projects empty state')
  const tabLabels = await evaluate(cdp, `[...document.querySelectorAll('.dsh-bots-tab')].map((el) => el.textContent.trim())`)
  assert.deepEqual(tabLabels, PT ? ['Bits', 'Times', 'Projetos'] : ['Bits', 'Teams', 'Projects'], 'tab order Bits | Times | Projetos')
  await screenshot(cdp, 'projects-1-empty')

  await clickToolbar(cdp, txt('Novo projeto', 'New project'))
  await waitFor(cdp, `document.querySelector('#dsh-project-name')`, 'project dialog')
  await typeInto(cdp, '#dsh-project-name', 'DSC')
  await typeInto(cdp, '#dsh-project-description', 'Design system React Native da CAIXA')
  await evaluate(cdp, `document.querySelectorAll('#dsh-project-color .dsh-bots-swatch')[1].click()`)
  await clickDialogFooter(cdp, txt('Criar projeto', 'Create project'))
  await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]')`, 'project dialog closed')
  await waitFor(cdp, `[...document.querySelectorAll('.dsh-bots-card')].some((el) => /DSC/.test(el.textContent))`, 'project card')
  await waitFor(cdp, `new RegExp(${JSON.stringify(txt('Projeto criado', 'Project created'))}).test(document.querySelector('.dsh-bots-toast')?.textContent || '')`, 'project created toast')
  const dsc = (await listProjects()).find((project) => project.name === 'DSC')
  assert.ok(dsc, 'project persisted')
  assert.equal(dsc.description, 'Design system React Native da CAIXA', 'project description persisted')
  assert.match(dsc.id, /^[0-9a-f]{10}$/, 'project id is 10-hex')

  console.log('5/8 project detail: add teams, create a team inside the project')
  await openProjectByCard(cdp, 'DSC')
  await waitFor(cdp, `new RegExp(${JSON.stringify(txt('Nenhum time neste projeto', 'No teams in this project'))}).test(document.querySelector('.dsh-bots-body')?.textContent || '')`, 'empty project detail')
  await screenshot(cdp, 'projects-2-detail-empty')

  await clickToolbar(cdp, txt('Adicionar times', 'Add teams'))
  await waitFor(cdp, `document.querySelector('.dsh-project-picker')`, 'add-teams picker')
  await toggleCheckbox(cdp, '.dsh-project-picker', 'Alpha')
  await toggleCheckbox(cdp, '.dsh-project-picker', 'Beta')
  await screenshot(cdp, 'projects-3-add-teams')
  await clickDialogFooter(cdp, txt('Aplicar', 'Apply'))
  await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]')`, 'picker closed')
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 2`, 'two teams in the project')
  let teams = await listTeams()
  assert.deepEqual(teams.find((team) => team.name === 'Alpha').projectIds, [dsc.id], 'Alpha assigned to DSC')
  assert.deepEqual(teams.find((team) => team.name === 'Beta').projectIds, [dsc.id], 'Beta assigned to DSC')
  assert.deepEqual(teams.find((team) => team.name === 'Gama').projectIds, [], 'Gama untouched')

  await clickToolbar(cdp, txt('Novo time', 'New team'))
  await waitFor(cdp, `document.querySelector('#dsh-team-name')`, 'new-team dialog in project')
  await typeInto(cdp, '#dsh-team-name', 'Time do projeto')
  await clickDialogFooter(cdp, txt('Criar time', 'Create team'))
  await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]')`, 'new-team dialog closed')
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 3 && [...document.querySelectorAll('.dsh-bots-card')].some((el) => /Time do projeto/.test(el.textContent))`, 'created team card')
  const projectTeam = (await listTeams()).find((team) => team.name === 'Time do projeto')
  assert.ok(projectTeam, 'team created inside the project')
  assert.deepEqual(projectTeam.projectIds, [dsc.id], 'preset projectId applied on create')
  assert.equal(projectTeam.shared, false, 'new project team is not shared')
  await screenshot(cdp, 'projects-detail')

  console.log('6/8 team editor: shared toggle + project assignment')
  await clickCardAction(cdp, 'Alpha', txt('Abrir fluxo', 'Open flow'))
  await waitFor(cdp, `document.querySelector('.dsh-flow-canvas') && document.querySelector('#dsh-team-prop-shared input[type="checkbox"]')`, 'team editor properties panel')
  assert.equal(await evaluate(cdp, `document.querySelector('#dsh-team-prop-shared input[type="checkbox"]').checked`), false, 'team starts not shared')
  assert.equal(await evaluate(cdp, `document.querySelector('#dsh-team-prop-project').value`), dsc.id, 'single project select shows the assigned project')
  await screenshot(cdp, 'projects-4-editor-project')
  await toggleCheckbox(cdp, '#dsh-team-prop-shared', txt('Time compartilhado', 'Shared team'))
  await waitFor(cdp, `document.querySelector('#dsh-team-prop-projects') && !document.querySelector('#dsh-team-prop-project')`, 'shared team project checklist')
  const checkedNow = await evaluate(cdp, `[...document.querySelectorAll('#dsh-team-prop-projects .dsh-bots-check')].filter((el) => el.querySelector('input').checked).map((el) => el.textContent)`)
  assert.ok(checkedNow.some((text) => /DSC/.test(text)), `DSC checked in the shared checklist: ${JSON.stringify(checkedNow)}`)
  await evaluate(cdp, `document.querySelector('.dsh-flow-canvas').focus()`)
  await key(cdp, 's', 'KeyS', 83, CTRL)
  await waitFor(cdp, `new RegExp(${JSON.stringify(txt('Salvo', 'Saved'))}).test(document.querySelector('.dsh-team-bar .dsh-bots-badge')?.textContent || '')`, 'saved badge')
  teams = await listTeams()
  const alphaShared = teams.find((team) => team.id === alpha.id)
  assert.equal(alphaShared.shared, true, 'shared flag saved')
  assert.deepEqual(alphaShared.projectIds, [dsc.id], 'project assignment kept while saving')
  await screenshot(cdp, 'projects-5-editor-shared')
  await evaluate(cdp, `document.querySelector('.dsh-team-bar [aria-label]').click()`)
  await waitFor(cdp, `document.querySelector('.dsh-project-name')`, 'back to project detail')

  // Remove a team from the project: the team itself is untouched.
  await clickCardAction(cdp, 'Beta', txt('Remover do projeto', 'Remove from project'))
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 2 && ![...document.querySelectorAll('.dsh-bots-card')].some((el) => /Beta/.test(el.textContent))`, 'Beta removed from the detail')
  await waitFor(cdp, `new RegExp(${JSON.stringify(txt('Time removido do projeto', 'Team removed from the project'))}).test(document.querySelector('.dsh-bots-toast')?.textContent || '')`, 'detach toast')
  teams = await listTeams()
  assert.ok(teams.find((team) => team.id === beta.id), 'detached team is not deleted')
  assert.deepEqual(teams.find((team) => team.id === beta.id).projectIds, [], 'detached team lost the project id')

  console.log('7/8 second project: non-shared team cannot be added twice')
  await evaluate(cdp, `document.querySelector('.dsh-project-head [aria-label]').click()`)
  await waitFor(cdp, `(() => { const body = document.querySelector('.dsh-bots-body'); return Boolean(body && document.querySelectorAll('.dsh-bots-card').length === 1 && /DSC/.test(body.textContent)) })()`, 'back to projects list')
  await clickToolbar(cdp, txt('Novo projeto', 'New project'))
  await waitFor(cdp, `document.querySelector('#dsh-project-name')`, 'second project dialog')
  await typeInto(cdp, '#dsh-project-name', 'Prefeitura')
  await typeInto(cdp, '#dsh-project-description', 'Sistemas da prefeitura')
  await clickDialogFooter(cdp, txt('Criar projeto', 'Create project'))
  await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]') && document.querySelectorAll('.dsh-bots-card').length === 2`, 'two project cards')
  await screenshot(cdp, 'projects-list')
  const prefeitura = (await listProjects()).find((project) => project.name === 'Prefeitura')
  assert.ok(prefeitura, 'second project persisted')
  await openProjectByCard(cdp, 'Prefeitura')

  await clickToolbar(cdp, txt('Adicionar times', 'Add teams'))
  await waitFor(cdp, `document.querySelector('.dsh-project-picker')`, 'second add-teams picker')
  const picker = await evaluate(cdp, `[...document.querySelectorAll('.dsh-project-picker .dsh-bots-check')].map((label) => ({
    text: label.textContent,
    checked: label.querySelector('input').checked,
    disabled: label.querySelector('input').disabled,
  }))`)
  const blocked = picker.find((item) => /Time do projeto/.test(item.text))
  assert.ok(blocked, `non-shared team listed: ${JSON.stringify(picker)}`)
  assert.equal(blocked.disabled, true, 'non-shared team already in another project is disabled')
  assert.ok(/DSC/.test(blocked.text) && /Não compartilhado|Not shared/.test(blocked.text), `blocked hint names the other project: ${blocked.text}`)
  assert.equal(picker.find((item) => /Alpha/.test(item.text)).disabled, false, 'shared team can be added to another project')
  assert.equal(picker.find((item) => /Gama/.test(item.text)).disabled, false, 'free non-shared team stays selectable')
  await toggleCheckbox(cdp, '.dsh-project-picker', 'Alpha')
  await toggleCheckbox(cdp, '.dsh-project-picker', 'Gama')
  await screenshot(cdp, 'projects-7-add-teams-blocked')
  await clickDialogFooter(cdp, txt('Aplicar', 'Apply'))
  await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]') && document.querySelectorAll('.dsh-bots-card').length === 2`, 'teams added to the second project')
  teams = await listTeams()
  const alphaBoth = teams.find((team) => team.id === alpha.id)
  assert.deepEqual(alphaBoth.projectIds, [dsc.id, prefeitura.id], 'shared team belongs to both projects')
  assert.deepEqual(teams.find((team) => team.id === gama.id).projectIds, [prefeitura.id], 'free non-shared team moved into the project')

  // Edit the project through the UI.
  await clickToolbar(cdp, txt('Editar projeto', 'Edit project'))
  await waitFor(cdp, `document.querySelector('#dsh-project-description')`, 'edit project dialog')
  await clearAndType(cdp, '#dsh-project-description', 'Sistemas da prefeitura de Fortaleza')
  await clickDialogFooter(cdp, txt('Salvar', 'Save'))
  await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]')`, 'edit dialog closed')
  await waitFor(cdp, `new RegExp(${JSON.stringify(txt('Projeto salvo', 'Project saved'))}).test(document.querySelector('.dsh-bots-toast')?.textContent || '')`, 'project saved toast')
  assert.equal((await listProjects()).find((project) => project.id === prefeitura.id).description, 'Sistemas da prefeitura de Fortaleza', 'project update persisted')

  // The Teams tab keeps the shared team (and project-less ones) and hides the
  // unshared project teams, which are exclusive to their project (§12.4).
  await clickTab(cdp, txt('Times|Teams', 'Teams|Times'))
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 2`, 'teams list without the unshared project teams')
  const teamsTabText = await evaluate(cdp, `document.querySelector('.dsh-bots-body')?.textContent || ''`)
  assert.ok(/Alpha/.test(teamsTabText) && /Beta/.test(teamsTabText), `shared + project-less teams stay listed: ${teamsTabText.slice(0, 300)}`)
  assert.ok(!/Gama/.test(teamsTabText) && !/Time do projeto/.test(teamsTabText), `unshared project teams are hidden: ${teamsTabText.slice(0, 300)}`)
  assert.ok(new RegExp(txt('2 time\\(s\\) de projeto', '2 project team\\(s\\)')).test(teamsTabText), `projects notice counted: ${teamsTabText.slice(0, 300)}`)
  await waitFor(cdp, `[...document.querySelectorAll('.dsh-bots-card')].some((el) => /Alpha/.test(el.textContent) && new RegExp(${JSON.stringify(txt('Compartilhado', 'Shared'))}).test(el.textContent) && /DSC/.test(el.textContent) && /Prefeitura/.test(el.textContent))`, 'shared + project badges on the team card')
  await screenshot(cdp, 'teams-1-badges')
  // duplicate() copies `shared` and `projectIds`.
  await clickCardAction(cdp, 'Alpha', txt('Duplicar', 'Duplicate'))
  await waitFor(cdp, `new RegExp(${JSON.stringify(txt('Time duplicado', 'Team duplicated'))}).test(document.querySelector('.dsh-bots-toast')?.textContent || '')`, 'duplicate toast')
  teams = await listTeams()
  const copy = teams.find((team) => team.name === 'Alpha (cópia)' || team.name === 'Alpha (copy)')
  assert.ok(copy, 'duplicated team created')
  assert.equal(copy.shared, true, 'duplicate copies shared')
  assert.deepEqual(copy.projectIds, alphaBoth.projectIds, 'duplicate copies projectIds')
  await api('/api/bots.teams.delete', { id: copy.id })

  console.log('8/8 unsharing truncates to the first project + delete project detaches teams')
  await clickTab(cdp, txt('Projetos|Projects', 'Projects|Projetos'))
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 2`, 'projects list after tab switch')
  await openProjectByCard(cdp, 'DSC')
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 2`, 'DSC detail after reload')
  await clickCardAction(cdp, 'Alpha', txt('Abrir fluxo', 'Open flow'))
  await waitFor(cdp, `document.querySelector('#dsh-team-prop-shared input[type="checkbox"]')`, 'team editor reopened')
  assert.equal(await evaluate(cdp, `document.querySelector('#dsh-team-prop-shared input[type="checkbox"]').checked`), true, 'team is still shared')
  assert.equal(await evaluate(cdp, `[...document.querySelectorAll('#dsh-team-prop-projects .dsh-bots-check')].filter((el) => el.querySelector('input').checked).length`), 2, 'two projects checked')
  await toggleCheckbox(cdp, '#dsh-team-prop-shared', txt('Time compartilhado', 'Shared team'))
  await waitFor(cdp, `document.querySelector('#dsh-team-prop-project')`, 'single project select after unsharing')
  assert.equal(await evaluate(cdp, `document.querySelector('#dsh-team-prop-project').value`), dsc.id, 'unsharing keeps the first project')
  assert.ok(await evaluate(cdp, `new RegExp(${JSON.stringify(txt('mantivemos o primeiro', 'kept the first one'))}).test(document.querySelector('.dsh-team-inspector').textContent || '')`), 'truncation hint shown')
  await screenshot(cdp, 'projects-8-editor-single')
  await evaluate(cdp, `document.querySelector('.dsh-flow-canvas').focus()`)
  await key(cdp, 's', 'KeyS', 83, CTRL)
  await waitFor(cdp, `new RegExp(${JSON.stringify(txt('Salvo', 'Saved'))}).test(document.querySelector('.dsh-team-bar .dsh-bots-badge')?.textContent || '')`, 'saved after unsharing')
  teams = await listTeams()
  const alphaSingle = teams.find((team) => team.id === alpha.id)
  assert.equal(alphaSingle.shared, false, 'unshared saved')
  assert.deepEqual(alphaSingle.projectIds, [dsc.id], 'only the first project kept')
  await evaluate(cdp, `document.querySelector('.dsh-team-bar [aria-label]').click()`)
  await waitFor(cdp, `document.querySelector('.dsh-project-name')`, 'back to DSC detail')

  await clickToolbar(cdp, txt('Excluir projeto', 'Delete project'))
  await waitFor(cdp, `(() => { const dialog = document.querySelector('.dsh-bots-root [role="dialog"]'); return Boolean(dialog && /DSC/.test(dialog.textContent) && new RegExp(${JSON.stringify(txt('não são excluídos|apenas desvinculados', 'not deleted|only detached'))}).test(dialog.textContent)) })()`, 'delete project confirm')
  await screenshot(cdp, 'projects-9-delete')
  await clickDialogFooter(cdp, txt('Excluir projeto', 'Delete project'))
  await waitFor(cdp, `!document.querySelector('.dsh-bots-root [role="dialog"]') && !document.querySelector('.dsh-project-name')`, 'back to the projects list')
  await waitFor(cdp, `new RegExp(${JSON.stringify(txt('Projeto excluído', 'Project deleted'))}).test(document.querySelector('.dsh-bots-toast')?.textContent || '')`, 'project deleted toast')
  const toastText = await evaluate(cdp, `document.querySelector('.dsh-bots-toast')?.textContent || ''`)
  assert.ok(new RegExp(txt('2 time\\(s\\) desvinculado\\(s\\)', '2 team\\(s\\) detached')).test(toastText), `detached teams reported: ${toastText}`)
  await sleep(300)
  const projectsAfter = await listProjects()
  assert.deepEqual(projectsAfter.map((project) => project.name), ['Prefeitura'], 'only the second project remains')
  teams = await listTeams()
  for (const name of ['Alpha', 'Beta', 'Gama', 'Time do projeto']) {
    assert.ok(teams.some((team) => team.name === name), `${name} still exists after deleting the project`)
  }
  assert.deepEqual(teams.find((team) => team.id === alpha.id).projectIds, [], 'deleting the project detached Alpha')
  assert.deepEqual(teams.find((team) => team.id === projectTeam.id).projectIds, [], 'deleting the project detached the project team')
  assert.deepEqual(teams.find((team) => team.id === gama.id).projectIds, [prefeitura.id], 'the other project membership is untouched')
  await screenshot(cdp, 'projects-10-after-delete')

  // Detached teams come back to the Teams tab; the one still inside Prefeitura
  // stays exclusive to it.
  await clickTab(cdp, txt('Times|Teams', 'Teams|Times'))
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 3`, 'detached teams back in the Teams tab')
  const teamsAfterDelete = await evaluate(cdp, `document.querySelector('.dsh-bots-body')?.textContent || ''`)
  assert.ok(/Alpha/.test(teamsAfterDelete) && /Beta/.test(teamsAfterDelete) && /Time do projeto/.test(teamsAfterDelete), `detached teams listed again: ${teamsAfterDelete.slice(0, 300)}`)
  assert.ok(!/Gama/.test(teamsAfterDelete), `team still in Prefeitura hidden: ${teamsAfterDelete.slice(0, 300)}`)
  assert.ok(new RegExp(txt('1 time\\(s\\) de projeto', '1 project team\\(s\\)')).test(teamsAfterDelete), `notice follows the remaining project team: ${teamsAfterDelete.slice(0, 300)}`)
  await screenshot(cdp, 'teams-2-detached')

  // Every team inside one project: the Teams tab shows the projects empty state
  // and its button switches to the Projects tab.
  for (const team of [alpha, beta, projectTeam]) {
    await api('/api/bots.teams.update', { id: team.id, patch: { projectIds: [prefeitura.id] } })
  }
  // Leave and re-enter the tab so the Teams view reloads the teams it just lost.
  await clickTab(cdp, txt('Projetos|Projects', 'Projects|Projetos'))
  await clickTab(cdp, txt('Times|Teams', 'Teams|Times'))
  await waitFor(cdp, `(() => { const body = document.querySelector('.dsh-bots-body'); return Boolean(body && document.querySelectorAll('.dsh-bots-card').length === 0 && new RegExp(${JSON.stringify(txt('Nenhum time fora de projetos', 'No teams outside projects'))}).test(body.textContent)) })()`, 'Teams empty state when every team is in a project')
  const emptyText = await evaluate(cdp, `document.querySelector('.dsh-bots-body')?.textContent || ''`)
  assert.ok(new RegExp(txt('4 time\\(s\\) deste perfil', '4 team\\(s\\) of this profile')).test(emptyText), `hint counts every project team: ${emptyText.slice(0, 320)}`)
  await screenshot(cdp, 'teams-3-all-in-projects')
  const switchedTab = await evaluate(cdp, `(() => {
    const button = [...document.querySelectorAll('.dsh-bots-state button')].find((el) => new RegExp(${JSON.stringify(txt('Ver projetos', 'View projects'))}).test(el.textContent || ''))
    if (!button) return false
    button.click()
    return true
  })()`)
  assert.ok(switchedTab, 'projects button in the Teams empty state')
  await waitFor(cdp, `document.querySelectorAll('.dsh-bots-card').length === 1`, 'projects tab opened from the empty-state button')
  await screenshot(cdp, 'teams-4-projects-from-empty')

  console.log('ok - projects v4: tabs, create/ edit/ delete project, add teams, new team preset, shared toggle, blocked non-shared team, detach, badges, teams-tab exclusivity')
  console.log(`ok - screenshots in ${path.relative(BUNDLE_DIR, OUT_DIR)}`)
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
