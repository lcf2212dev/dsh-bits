/**
 * Routes for harness packs and the team runtime (V5-CONTRACT §5.3, §5.4).
 *
 * Same conventions as `host/routes.js`: HTTP 200, `{ ok: true, ... }` or
 * `{ ok: false, error: { code, message } }`, coded errors pass through,
 * unexpected ones become `INTERNAL`.
 *
 * A harness pack is turned into a team of bits: one worker bit per preset plus
 * an orchestrating lead bit (DeepSeek-V4.1-Flash Max). `teamFromPack` returns
 * `{ bits, team }` in the team-template shape (the team members reference the
 * definitions by local `bitKey`); `/api/bots.teams.fromPack` creates the bits
 * first and then the team, returning `{ team, bits }`.
 *
 * @module host/harness-routes
 */

import path from 'node:path'

import { PACK_ID_PATTERN, listPacks, readPack, transpileHarness } from './harness.js'
import { instantiateTeamTemplate } from './team-routes.js'

const CODED = /^[A-Z][A-Z0-9_]{1,63}$/

/** Efforts accepted by the Claude Code CLI (V5-CONTRACT §1). */
const CLI_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
/** Defaults for a worker bit when the catalog has no entry for its character. */
const FALLBACK_WORKER_MODEL = 'subscription/sonnet'
const FALLBACK_WORKER_EFFORT = 'high'
/** Orchestrator route: DeepSeek-V4.1-Flash Max (V5-CONTRACT §1). */
const ORCHESTRATOR_MODEL = 'deepseek-account/deepseek-flash'
const ORCHESTRATOR_EFFORT = 'max'

function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  let base = String(name).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'member'
  if (!/^[a-z0-9]/.test(base)) base = `m-${base}`
  let id = base
  for (let index = 2; taken.has(id); index += 1) id = `${base}-${index}`
  taken.add(id)
  return id
}

/**
 * The lead instructions of a harness-generated team: the orchestrator only
 * plans and delegates, it never runs commands or edits files.
 *
 * @returns {string}
 */
export function harnessLeadInstructions() {
  return [
    'You are the harness main session and you only orchestrate: you understand the request, choose the right flow (skill), delegate each step to the appropriate member with `team_delegate`, check the reports and answer the dev.',
    'Read the flow skill before the first step. You do not run commands or edit files.',
  ].join('\n\n')
}

/**
 * A generic runnable team from a pack (V5-CONTRACT §5.3): one bit per preset
 * (instructions/model/effort/read-only/launches/skills), an orchestrating lead
 * bit on the DeepSeek route, a simple flow (request → lead → members → report),
 * and the team members referencing those bits.
 *
 * Worker bits use the catalog defaults for their character; when the catalog
 * has no entry, they fall back to `subscription/sonnet` and the preset effort
 * (a valid CLI effort) or `high`. The lead is always
 * `bit-coordinator`/orchestrator/DeepSeek-V4.1-Flash Max.
 *
 * @param {Record<string, any>} manifest
 * @param {{ name?: string, workspaceDir?: string | null, has?: (bit: string) => boolean,
 *   catalog?: { get?: (id: string) => object | undefined } | null }} options
 * @returns {{ bits: Array<Record<string, any>>, team: Record<string, any> }}
 */
export function teamFromPack(manifest, { name, workspaceDir = null, has, catalog = null } = {}) {
  const taken = new Set(['lead'])
  const presets = (manifest.agents || []).filter((agent) => agent.instructions)
  const idOf = new Map(presets.map((agent) => [agent.name, slugMember(agent.name, taken)]))
  const catalogOf = (character) => {
    if (character === null || character === undefined || !isPlainObject(catalog) || typeof catalog.get !== 'function') return undefined
    const row = catalog.get(character)
    return isPlainObject(row) ? row : undefined
  }
  const bits = []
  const members = presets.map((agent) => {
    const id = idOf.get(agent.name)
    const character = bitForPreset(agent.name, has)
    const row = catalogOf(character)
    const presetEffort = typeof agent.effort === 'string' && CLI_EFFORTS.has(agent.effort) ? agent.effort : FALLBACK_WORKER_EFFORT
    const model = row !== undefined && typeof row.model === 'string' && row.model !== '' ? row.model : FALLBACK_WORKER_MODEL
    const effort = row !== undefined && typeof row.effort === 'string' && row.effort !== '' ? row.effort : presetEffort
    bits.push({
      key: id,
      name: String(agent.name || id).slice(0, 60),
      character,
      instructions: String(agent.instructions || '').slice(0, 20000),
      isOrchestrator: false,
      model,
      effort,
    })
    return {
      id,
      bitKey: id,
      role: String(agent.description || '').slice(0, 200),
      access: agent.readOnly ? 'read' : 'write',
      launches: (agent.launches || []).map((launch) => idOf.get(launch)).filter(Boolean),
      skills: (agent.skills || []).filter((skill) => (manifest.skills || []).some((item) => item.name === skill)),
      teamRef: null,
      mcp: [],
    }
  })
  const lead = {
    id: 'lead',
    bitKey: 'lead',
    role: 'Main session: talks to the dev, decides and delegates each step to a member',
    access: 'read',
    launches: members.map((member) => member.id),
    skills: [],
    teamRef: null,
    mcp: [],
  }
  bits.unshift({
    key: 'lead',
    name: 'Orchestrator',
    character: has && !has('bit-coordinator') ? null : 'bit-coordinator',
    instructions: harnessLeadInstructions(),
    isOrchestrator: true,
    model: ORCHESTRATOR_MODEL,
    effort: ORCHESTRATOR_EFFORT,
  })
  const nodes = [
    { id: 'start', type: 'start', x: 0, y: 0, label: 'Dev request', detail: '' },
    { id: 'lead', type: 'step', x: -26, y: 104, label: 'Understand and choose the flow', detail: 'Read the flow skill.', memberId: 'lead' },
  ]
  const edges = [{ id: 'e-start', from: 'start', to: 'lead', label: '', kind: 'flow' }]
  members.forEach((member, index) => {
    const column = index % 3
    const row = Math.floor(index / 3)
    const node = { id: `m-${member.id}`, type: 'step', x: -320 + column * 288, y: 240 + row * 104, label: member.role ? member.role.slice(0, 80) : member.id, detail: '', memberId: member.id }
    nodes.push(node)
    edges.push({ id: `e-${member.id}`, from: 'lead', to: node.id, label: '', kind: 'delegate' })
  })
  const lastY = 240 + Math.ceil(members.length / 3) * 104 + 24
  nodes.push({ id: 'end', type: 'end', x: 0, y: lastY, label: 'Report to the dev', detail: '' })
  edges.push({ id: 'e-end', from: 'lead', to: 'end', label: '', kind: 'flow' })
  return {
    bits,
    team: {
      name: String(name || manifest.name || manifest.id).slice(0, 60),
      description: `Team generated from the harness ${manifest.name || manifest.id}: ${members.length} presets, ${(manifest.skills || []).length} skills.`,
      emoji: '🧭',
      color: '#0891b2',
      workspaceDir,
      members: [lead, ...members],
      flow: { nodes, edges },
      lead: 'lead',
      harness: manifest.id,
      bindWorkspace: false,
      rules: '',
      skills: [],
      entry: [{ id: 'request', label: 'Request', template: '{request}' }],
    },
  }
}

/**
 * @param {any} ctx host context (only `ctx.connection.fetch.register` is used)
 * @param {{ teams: any, bits: any, projects?: any, ready: Promise<void>, botsRoot: string, runtime?: any, catalog?: any, ensureDirectoryWorkspace?: (dir: string, title: string) => Promise<string | null>, log?: (m: string) => void }} deps
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
      if (!isPlainObject(deps.bits) || typeof deps.bits.create !== 'function') {
        throw codedError('BIT_STORE_UNAVAILABLE', 'Bit store unavailable')
      }
      // Optional project the new team starts in (CONTRACT §12.3); it must exist.
      const projectId = typeof input.projectId === 'string' && input.projectId.trim() !== '' ? input.projectId.trim() : null
      if (projectId !== null) {
        const project = deps.projects && typeof deps.projects.get === 'function' ? deps.projects.get(projectId) : undefined
        if (!project) throw codedError('PROJECT_NOT_FOUND', `Project "${projectId}" was not found`)
      }
      const has = deps.catalog && typeof deps.catalog.has === 'function' ? (bit) => deps.catalog.has(bit) : undefined
      const workspaceDir = typeof input.workspaceDir === 'string' && input.workspaceDir.trim() ? input.workspaceDir.trim() : (manifest.source && manifest.source.dir) || null
      const template = teamFromPack(manifest, { name: input.name, workspaceDir, has, catalog: deps.catalog })
      const instantiated = await instantiateTeamTemplate(deps, template, { name: input.name, projectId })
      return { team: instantiated.team, bits: instantiated.bits }
    }),
    define('/api/bots.teams.workspace', ['POST'], async (request) => {
      const input = await body(request)
      const team = deps.teams.get(typeof input.id === 'string' ? input.id : '')
      if (!team) throw codedError('TEAM_NOT_FOUND', `Team "${String(input.id)}" was not found`)
      if (!team.workspaceDir) throw codedError('TEAM_NO_WORKSPACE', 'The team has no repository or folder defined.')
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
