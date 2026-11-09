/**
 * Routes for harness packs and the team runtime (CONTRACT §11.3).
 *
 * Same conventions as `host/routes.js`: HTTP 200, `{ ok: true, ... }` or
 * `{ ok: false, error: { code, message } }`, coded errors pass through,
 * unexpected ones become `INTERNAL`.
 *
 * @module host/harness-routes
 */

import path from 'node:path'

import { PACK_ID_PATTERN, listPacks, readPack, transpileHarness } from './harness.js'

const CODED = /^[A-Z][A-Z0-9_]{1,63}$/

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function json(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function body(request) {
  let value
  try {
    value = await request.json()
  } catch {
    throw codedError('BAD_REQUEST', 'Request body must be valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw codedError('BAD_REQUEST', 'Request body must be a JSON object')
  return value
}

/** Public projection of a pack manifest. */
export function packSummary(manifest) {
  return {
    id: manifest.id,
    name: manifest.name,
    source: manifest.source || { dir: null, commit: null },
    packDir: manifest.packDir,
    harnessVersion: manifest.harnessVersion ?? null,
    createdAt: manifest.createdAt,
    files: manifest.files,
    agents: (manifest.agents || []).map((agent) => ({
      name: agent.name, description: agent.description, model: agent.model, tier: agent.tier, effort: agent.effort,
      readOnly: agent.readOnly, launches: agent.launches, skills: agent.skills,
    })),
    skills: (manifest.skills || []).map((skill) => ({ name: skill.name, description: skill.description })),
    instructions: (manifest.instructions || []).map((item) => ({ name: item.name, applyTo: item.applyTo })),
    mcp: Object.keys(manifest.mcp || {}),
    patches: (manifest.patches || []).map((patch) => ({ id: patch.id, applied: patch.applied, reason: patch.reason })),
  }
}

/** Bit character for a preset name (heuristic, falls back to the mascot). */
export function bitForPreset(name, has) {
  const key = String(name).toLowerCase()
  const table = [
    ['scout', 'bit-scout'], ['runner', 'bit-runner'], ['research', 'bit-researcher'], ['architect', 'bit-architect'],
    ['builder', 'bit-builder'], ['review', 'bit-reviewer'], ['debug', 'bit-debugger'], ['writer', 'bit-writer'],
    ['doc', 'bit-writer'], ['tester', 'bit-web-tester'], ['test', 'bit-qa'], ['valid', 'bit-qa'], ['qa', 'bit-qa'],
    ['ci', 'bit-ci-triager'], ['deploy', 'bit-deployer'], ['release', 'bit-deployer'], ['secur', 'bit-cybersecurity-expert'],
    ['design', 'bit-ui-designer'], ['a11y', 'bit-accessibility-expert'], ['access', 'bit-accessibility-expert'],
  ]
  for (const [needle, bit] of table) if (key.includes(needle) && (!has || has(bit))) return bit
  return has && !has('bit-mascot') ? null : 'bit-mascot'
}

function slugMember(name, taken) {
  let base = String(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'membro'
  if (!/^[a-z0-9]/.test(base)) base = `m-${base}`
  let id = base
  for (let index = 2; taken.has(id); index += 1) id = `${base}-${index}`
  taken.add(id)
  return id
}

/**
 * A generic runnable team from a pack: an orchestrating lead plus one member
 * per preset (instructions, model, effort, read-only, launches, skills), and a
 * simple flow (request → lead → members → report).
 *
 * @param {Record<string, any>} manifest
 * @param {{ name?: string, workspaceDir?: string | null, has?: (bit: string) => boolean }} options
 */
export function teamFromPack(manifest, { name, workspaceDir = null, has } = {}) {
  const taken = new Set(['lider'])
  const presets = (manifest.agents || []).filter((agent) => agent.instructions)
  const idOf = new Map(presets.map((agent) => [agent.name, slugMember(agent.name, taken)]))
  const members = presets.map((agent) => ({
    id: idOf.get(agent.name),
    character: bitForPreset(agent.name, has),
    name: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
    role: String(agent.description || '').slice(0, 200),
    model: String(agent.model || '').slice(0, 60),
    effort: String(agent.effort || '').slice(0, 20),
    access: agent.readOnly ? 'read' : 'write',
    instructions: String(agent.instructions || '').slice(0, 40000),
    launches: (agent.launches || []).map((launch) => idOf.get(launch)).filter(Boolean),
    skills: (agent.skills || []).filter((skill) => (manifest.skills || []).some((item) => item.name === skill)),
    teamRef: null,
    mcp: [],
  }))
  const lead = {
    id: 'lider',
    character: has && !has('bit-coordinator') ? null : 'bit-coordinator',
    name: 'Orquestrador',
    role: 'Sessão principal: conversa com o dev, decide e delega cada etapa a um membro',
    model: '',
    effort: '',
    access: 'read',
    instructions: [
      'Você é a sessão principal do harness e só orquestra: entende o pedido, escolhe o fluxo (skill) certo, delega cada etapa ao membro adequado com `team_delegate`, confere os relatórios e responde ao dev.',
      'Leia a skill do fluxo antes do primeiro passo. Você não roda comandos nem edita arquivos.',
    ].join('\n\n'),
    launches: members.map((member) => member.id),
    skills: [],
    teamRef: null,
    mcp: [],
  }
  const nodes = [
    { id: 'start', type: 'start', x: 0, y: 0, label: 'Pedido do dev', detail: '' },
    { id: 'lead', type: 'step', x: -26, y: 104, label: 'Entender e escolher o fluxo', detail: 'Ler a skill do fluxo.', memberId: 'lider' },
  ]
  const edges = [{ id: 'e-start', from: 'start', to: 'lead', label: '', kind: 'flow' }]
  members.forEach((member, index) => {
    const column = index % 3
    const row = Math.floor(index / 3)
    const node = { id: `m-${member.id}`, type: 'step', x: -320 + column * 288, y: 240 + row * 104, label: member.role ? member.role.slice(0, 80) : member.name, detail: '', memberId: member.id }
    nodes.push(node)
    edges.push({ id: `e-${member.id}`, from: 'lead', to: node.id, label: '', kind: 'delegate' })
  })
  const lastY = 240 + Math.ceil(members.length / 3) * 104 + 24
  nodes.push({ id: 'end', type: 'end', x: 0, y: lastY, label: 'Relatório ao dev', detail: '' })
  edges.push({ id: 'e-end', from: 'lead', to: 'end', label: '', kind: 'flow' })
  return {
    name: String(name || manifest.name || manifest.id).slice(0, 60),
    description: `Time gerado do harness ${manifest.name || manifest.id}: ${members.length} presets, ${(manifest.skills || []).length} skills.`,
    emoji: '🧭',
    color: '#0891b2',
    workspaceDir,
    members: [lead, ...members],
    flow: { nodes, edges },
    lead: 'lider',
    harness: manifest.id,
    bindWorkspace: false,
    rules: '',
    skills: [],
    entry: [{ id: 'request', label: 'Pedido', template: '{pedido}' }],
  }
}

/**
 * @param {any} ctx host context (only `ctx.connection.fetch.register` is used)
 * @param {{ teams: any, ready: Promise<void>, botsRoot: string, runtime?: any, catalog?: any, ensureDirectoryWorkspace?: (dir: string, title: string) => Promise<string | null>, log?: (m: string) => void }} deps
 * @returns {() => void}
 */
export function registerHarnessRoutes(ctx, deps) {
  const packsRoot = path.join(deps.botsRoot, 'harness')
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const define = (route, methods, handler) => ({
    path: route,
    methods,
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        if (deps.ready) await deps.ready
        return json({ ok: true, ...(await handler(request)) })
      } catch (error) {
        const code = error && typeof error.code === 'string' && CODED.test(error.code) ? error.code : 'INTERNAL'
        if (code === 'INTERNAL') {
          log(`bots: route ${route} failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
          return json({ ok: false, error: { code, message: 'Internal server error' } })
        }
        return json({ ok: false, error: { code, message: error.message } })
      }
    },
  })

  const routes = [
    define('/api/bots.harness', ['GET'], async () => ({ packs: (await listPacks(packsRoot)).map(packSummary) })),
    define('/api/bots.harness.import', ['POST'], async (request) => {
      const input = await body(request)
      const sourceDir = typeof input.sourceDir === 'string' ? input.sourceDir.trim() : ''
      const id = typeof input.id === 'string' ? input.id.trim() : ''
      if (!sourceDir || !path.isAbsolute(sourceDir)) throw codedError('BAD_REQUEST', '"sourceDir" must be an absolute path')
      if (!PACK_ID_PATTERN.test(id)) throw codedError('BAD_REQUEST', '"id" must match /^[a-z0-9][a-z0-9_-]{0,63}$/')
      const manifest = await transpileHarness({ sourceDir, packsRoot, packId: id, name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : undefined })
      if (deps.runtime) deps.runtime.refreshTeam(null)
      return { pack: packSummary(manifest) }
    }),
    define('/api/bots.teams.fromPack', ['POST'], async (request) => {
      const input = await body(request)
      const manifest = await readPack(packsRoot, input.packId)
      if (!manifest) throw codedError('HARNESS_NOT_FOUND', `Harness pack "${String(input.packId)}" was not found`)
      const has = deps.catalog && typeof deps.catalog.has === 'function' ? (bit) => deps.catalog.has(bit) : undefined
      const workspaceDir = typeof input.workspaceDir === 'string' && input.workspaceDir.trim() ? input.workspaceDir.trim() : (manifest.source && manifest.source.dir) || null
      const team = await deps.teams.create(teamFromPack(manifest, { name: input.name, workspaceDir, has }))
      return { team }
    }),
    define('/api/bots.teams.workspace', ['POST'], async (request) => {
      const input = await body(request)
      const team = deps.teams.get(typeof input.id === 'string' ? input.id : '')
      if (!team) throw codedError('TEAM_NOT_FOUND', `Team "${String(input.id)}" was not found`)
      if (!team.workspaceDir) throw codedError('TEAM_NO_WORKSPACE', 'O time não tem repositório ou pasta definido.')
      if (typeof deps.ensureDirectoryWorkspace !== 'function') throw codedError('WORKSPACE_UNAVAILABLE', 'Workspace registry unavailable')
      const workspaceId = await deps.ensureDirectoryWorkspace(team.workspaceDir, team.name)
      if (!workspaceId) throw codedError('WORKSPACE_UNAVAILABLE', `Could not register ${team.workspaceDir} as a workspace`)
      return { workspaceId, workspaceDir: team.workspaceDir }
    }),
    define('/api/bots.teams.run', ['POST'], async (request) => {
      const input = await body(request)
      if (!deps.runtime) throw codedError('RUNTIME_UNAVAILABLE', 'Team runtime unavailable')
      const started = await deps.runtime.startMission({ team: typeof input.id === 'string' ? input.id : '', prompt: typeof input.prompt === 'string' ? input.prompt : '' })
      let workspaceId = null
      if (typeof deps.ensureDirectoryWorkspace === 'function') {
        try {
          workspaceId = await deps.ensureDirectoryWorkspace(started.cwd, started.teamName)
        } catch {
          workspaceId = null
        }
      }
      return { ...started, workspaceId }
    }),
    define('/api/bots.teams.runtime', ['GET'], async () => (deps.runtime ? deps.runtime.diagnostics() : { agents: [], errors: ['runtime unavailable'] })),
  ]
  const disposers = routes.map((route) => ctx.connection.fetch.register(route))
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) {
        log(`bots: harness route disposer failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
