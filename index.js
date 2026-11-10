/**
 * Bits bundle — host half (v5).
 *
 * Bits are no longer personal agents and no longer run a Docker VM. A bit is a
 * definition (context/instructions + `isOrchestrator` + model + effort) that
 * receives a request and returns a response, used by the flows (teams) of the
 * Web page:
 *
 * - orchestrator bits run as DeepSeek Harness agents on the DeepSeek-V4.1-Flash
 *   Max route and coordinate a team flow;
 * - worker bits are one-shot invocations — by default through the
 *   `claude_delegate` tool of `@dsh-burn-plugins/dsh-claude-delegate` (Claude
 *   subscription), or a single model call when the user points them at a DSH
 *   chat route.
 *
 * This module wires the durable stores (bits, teams, projects), the model
 * catalog, the bit runtime, the team runtime, the harness packs and the
 * authenticated routes used by the Web page. No Docker, no per-session
 * persona injection, no notifications.
 *
 * @module @dsh-burn-plugins/dsh-bots
 */

import fs from 'node:fs/promises'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BitStore } from './host/store.js'
import { registerBotRoutes } from './host/routes.js'
import { loadBitCatalog } from './host/catalog.js'
import { TeamStore } from './host/teams.js'
import { registerTeamRoutes, loadTeamTemplates } from './host/team-routes.js'
import { ProjectStore } from './host/projects.js'
import { registerProjectRoutes } from './host/project-routes.js'
import { installTeamRuntime } from './host/team-runtime.js'
import { installOrchestrator } from './host/orchestrator.js'
import { createOrchestratorSelection } from './host/orchestrator-selection.js'
import { registerHarnessRoutes } from './host/harness-routes.js'
import { createModelCatalog } from './host/models.js'
import { createBitRuntime } from './host/bit-runtime.js'
import { fileURLToPath } from 'node:url'

/** Services this bundle needs before it can activate. */
export const inject = [
  'connection',
  'workspaceRegistry',
  'tools',
  'agents',
  'workingDirectory',
  'systemPrompt',
  'skills',
  'subagents',
  'llm',
  'shellEnv',
]

/** Plugin name used in diagnostics. */
export const name = 'bots'

/**
 * Resolve the DeepSeek Harness home directory the same way the installation
 * does: `$DSH_HOME` when defined, otherwise `~/.dsh`.
 *
 * @returns {string} absolute harness home.
 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/**
 * Host plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} [config] profile row configuration.
 * @param {string} [config.botsRoot] absolute directory holding bits, teams, projects and harness packs.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const options = config !== null && typeof config === 'object' ? config : {}
  const logger = ctx.logger
  const botsRoot = typeof options.botsRoot === 'string' && options.botsRoot.trim().length > 0
    ? path.resolve(options.botsRoot)
    : path.join(resolveDshHome(), 'bots')
  // Local log file: the host logger is not visible outside the app, and team
  // runs need a trace the dev (and maintainers) can read.
  const logFile = path.join(botsRoot, 'bits.log')
  const log = (message) => {
    try {
      logger?.warn?.(`bots: ${message}`)
    } catch {
      // Logging must never break the plugin.
    }
    try {
      mkdirSync(botsRoot, { recursive: true, mode: 0o700 })
      try {
        if (statSync(logFile).size > 2_000_000) renameSync(logFile, `${logFile}.1`)
      } catch {
        // No log yet.
      }
      appendFileSync(logFile, `${new Date().toISOString()} ${String(message).replace(/\n/g, '\n  ')}\n`, { mode: 0o600 })
    } catch {
      // Logging must never break the plugin.
    }
  }

  log(`plugin loaded (pid ${process.pid})`)

  const pluginDir = path.dirname(fileURLToPath(import.meta.url))

  // Bit characters (picker, default instructions, default model/effort,
  // avatars) shipped with the bundle. Loaded before the stores so a bit created
  // from a character inherits its defaults.
  const catalog = loadBitCatalog(path.join(pluginDir, 'bits'))
  if (catalog.error !== null) log(`bit catalog unavailable: ${catalog.error}`)

  const bits = new BitStore({ botsRoot, catalog, log })
  const ready = bits.init()

  // Bit mode orchestrating-bit selection: one durable global preference
  // (`orchestrator.json`) read per turn by the prompt section. Loaded in
  // parallel; the routes await `selection.ready` before answering.
  const selection = createOrchestratorSelection({ botsRoot, bits, catalog, log })
  const selectionReady = selection.init()
  selectionReady.catch((error) => log(`orchestrator selection init failed: ${error instanceof Error ? error.message : String(error)}`))

  // Teams reference bits, so the team store loads (and migrates) after the bit
  // store is readable. A broken teams.json must never block the bits page.
  const teams = new TeamStore({ botsRoot, bits, catalog, log })
  const teamsReady = (async () => {
    await ready
    await teams.init()
  })()
  teamsReady.catch((error) => log(`team store init failed: ${error instanceof Error ? error.message : String(error)}`))

  const projects = new ProjectStore({ botsRoot })
  // Separate readiness too: a broken projects.json must never block bits or teams.
  const projectsReady = projects.init()
  projectsReady.catch((error) => log(`project store init failed: ${error instanceof Error ? error.message : String(error)}`))
  // Project routes need teams; a broken projects.json must not take the team
  // routes down with it.
  const projectRoutesReady = Promise.all([projectsReady, teamsReady])
  projectRoutesReady.catch(() => {})
  // Team/harness routes validate project ids, so they wait for the project
  // store to load too.
  const teamRoutesReady = Promise.all([teamsReady, projectsReady.catch(() => undefined)])

  /**
   * Register any directory as a Harness workspace (idempotent) and return its id.
   *
   * @param {string} directory absolute directory.
   * @param {string} title workspace title used when it is created.
   * @returns {Promise<string | null>} workspace id or null.
   */
  async function ensureDirectoryWorkspace(directory, title) {
    let canonical = directory
    try {
      canonical = await fs.realpath(directory)
    } catch {
      throw Object.assign(new Error(`Directory not found: ${directory}`), { code: 'TEAM_NO_WORKSPACE' })
    }
    try {
      const existing = ctx.workspaceRegistry.list().find((workspace) => workspace.path === canonical)
      if (existing) return typeof existing.id === 'string' ? existing.id : String(existing.id)
    } catch {
      // Fall through to create.
    }
    const workspace = await ctx.workspaceRegistry.create(canonical, title)
    if (!workspace) return null
    return typeof workspace.id === 'string' ? workspace.id : String(workspace.id)
  }

  // Model catalog (subscription aliases + the profile's DSH chat routes) and
  // the request→response runtime used by both the ad-hoc "Run" route and
  // team delegation.
  const models = createModelCatalog(ctx)
  const bitRuntime = createBitRuntime(ctx, { bits, catalog, models, log })

  // Bit mode chat mode: a Session created with the bundle's Agent preset gets
  // the orchestrator prompt section and the `bit_delegate` tool; the prompt
  // adopts the currently selected orchestrating bit. The preset itself is
  // declared by `cordis.patch.yml`.
  let orchestrator = null
  try {
    orchestrator = installOrchestrator(ctx, { bits, catalog, models, bitRuntime, selection, log })
  } catch (error) {
    log(`orchestrator installation failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Runnable teams: lead/member bits, delegation, harness skills, guard and MCP.
  let teamRuntime = null
  try {
    teamRuntime = installTeamRuntime(ctx, { teams, teamsReady, bits, models, bitRuntime, botsRoot, log })
  } catch (error) {
    log(`team runtime installation failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Team mutations re-apply live agents of that team (roster, lead, launches, restrictions).
  for (const method of ['create', 'update', 'remove']) {
    const original = teams[method].bind(teams)
    teams[method] = async (...args) => {
      const result = await original(...args)
      try {
        if (method === 'remove' && teamRuntime) await teamRuntime.bindings.forgetTeam(result.id)
        if (teamRuntime) teamRuntime.refreshTeam(method === 'remove' ? null : result.id)
      } catch (error) {
        log(`team runtime refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return result
    }
  }

  // Teams of bits: durable flow graphs edited by the Web page.
  let disposeTeamRoutes = () => {}
  let disposeHarnessRoutes = () => {}
  try {
    const templates = loadTeamTemplates(path.join(pluginDir, 'bits', 'teams'), (message) => log(`team template skipped: ${message}`))
    disposeTeamRoutes = registerTeamRoutes(ctx, { teams, projects, bits, ready: teamRoutesReady, catalog, templates, log }) ?? (() => {})
    disposeHarnessRoutes = registerHarnessRoutes(ctx, {
      teams,
      projects,
      bits,
      ready: teamRoutesReady,
      botsRoot,
      runtime: teamRuntime,
      catalog,
      ensureDirectoryWorkspace,
      log,
    }) ?? (() => {})
  } catch (error) {
    log(`team route registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Projects: the level above teams, kept in its own durable file so a broken
  // projects.json never blocks the teams routes (and vice versa).
  let disposeProjectRoutes = () => {}
  try {
    disposeProjectRoutes = registerProjectRoutes(ctx, { projects, teams, ready: projectRoutesReady, log }) ?? (() => {})
  } catch (error) {
    log(`project route registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  let disposeRoutes = () => {}
  try {
    disposeRoutes = registerBotRoutes(ctx, {
      bits,
      catalog,
      ready,
      runtime: bitRuntime,
      selection,
      log,
    }) ?? (() => {})
  } catch (error) {
    log(`route registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Diagnostics: read-only state for troubleshooting (also exercised by the E2E suite).
  let disposeDiagnostics = () => {}
  try {
    disposeDiagnostics = ctx.connection.fetch.register({
      path: '/api/bots.diagnostics',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        let storeReady = true
        try {
          await ready
        } catch {
          storeReady = false
        }
        let bitRecords = []
        let bitRecordsError = null
        try {
          bitRecords = bits.list().map((record) => ({
            id: record.id,
            name: record.name,
            character: record.character,
            isOrchestrator: record.isOrchestrator,
            model: record.model,
            effort: record.effort,
            workspaceDir: record.workspaceDir,
          }))
        } catch (error) {
          bitRecordsError = error instanceof Error ? error.message : String(error)
        }
        const agents = teamRuntime && typeof teamRuntime.diagnostics === 'function'
          ? teamRuntime.diagnostics()
          : { agents: [], errors: [] }
        const orchestratorDiagnostics = orchestrator && typeof orchestrator.diagnostics === 'function'
          ? orchestrator.diagnostics()
          : { presetId: 'bits-orchestrator', installed: [], errors: [], notes: [] }
        let selectionBitId = null
        try {
          selectionBitId = selection.currentBitId()
        } catch (error) {
          log(`orchestrator selection diagnostics failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        return Response.json({
          ok: true,
          bitsPath: bits.file,
          storeReady,
          bitRecordsError,
          bits: bitRecords,
          agents: agents.agents,
          errors: agents.errors,
          orchestrator: { ...orchestratorDiagnostics, selection: { bitId: selectionBitId } },
        })
      },
    }) ?? (() => {})
  } catch (error) {
    log(`diagnostics route registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  ctx.effect(() => () => {
    try {
      disposeHarnessRoutes()
    } catch (error) {
      log(`harness route disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      if (teamRuntime) teamRuntime.dispose()
    } catch (error) {
      log(`team runtime disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      if (orchestrator) orchestrator.dispose()
    } catch (error) {
      log(`orchestrator disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      if (selection && typeof selection.dispose === 'function') selection.dispose()
    } catch (error) {
      log(`orchestrator selection disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      disposeTeamRoutes()
    } catch (error) {
      log(`team route disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      disposeProjectRoutes()
    } catch (error) {
      log(`project route disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      disposeDiagnostics()
    } catch (error) {
      log(`diagnostics disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      disposeRoutes()
    } catch (error) {
      log(`route disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, 'bots: teardown')
}
