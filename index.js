/**
 * Bots bundle — host half.
 *
 * Adds a bot registry (named AI teammates with a persona, a dedicated
 * workspace and an optional Docker VM), authenticated JSON routes used by the
 * Web page, a per-session persona prompt section, and the `vm_bash` tool that
 * runs commands inside the bot's own container.
 *
 * The Client half lives in `client.js`; the storage and Docker mechanics live
 * in `host/store.js` and `host/vm.js`; the agent integration lives in
 * `host/agent.js`.
 *
 * @module @local/dsh-bots
 */

import fs from 'node:fs/promises'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BotStore } from './host/store.js'
import { BotVm } from './host/vm.js'
import { registerBotRoutes } from './host/routes.js'
import { installBotAgents } from './host/agent.js'
import { createNotifier } from './host/notify.js'
import { loadBitCatalog } from './host/catalog.js'
import { TeamStore } from './host/teams.js'
import { registerTeamRoutes, loadTeamTemplates } from './host/team-routes.js'
import { installTeamRuntime } from './host/team-runtime.js'
import { registerHarnessRoutes } from './host/harness-routes.js'
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
 * Normalize an optional configuration value to a positive integer.
 *
 * @param {unknown} value candidate.
 * @param {number} fallback default.
 * @returns {number} positive integer.
 */
function positiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Host plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} [config] profile row configuration.
 * @param {string} [config.botsRoot] absolute directory holding bot records and workspaces.
 * @param {string} [config.defaultImage] Docker image proposed to new bots.
 * @param {string} [config.dockerBin] Docker executable name or absolute path.
 * @param {number} [config.execTimeoutMs] default `vm_bash` deadline.
 * @param {number} [config.maxOutputBytes] per-stream output cap for `vm_bash`.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const options = config !== null && typeof config === 'object' ? config : {}
  const logger = ctx.logger
  const defaultImage = typeof options.defaultImage === 'string' && options.defaultImage.trim().length > 0
    ? options.defaultImage.trim()
    : 'ubuntu:24.04'
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

  const store = new BotStore({ botsRoot, defaultImage })
  const vm = new BotVm({
    dockerBin: typeof options.dockerBin === 'string' && options.dockerBin.trim().length > 0 ? options.dockerBin.trim() : 'docker',
    defaultImage,
    execTimeoutMs: positiveInteger(options.execTimeoutMs, 120000),
    maxOutputBytes: positiveInteger(options.maxOutputBytes, 65536),
  })

  const teams = new TeamStore({ botsRoot })
  const ready = store.init()
  // Separate readiness: a broken teams.json must never block the bots.
  const teamsReady = teams.init()
  teamsReady.catch((error) => log(`team store init failed: ${error instanceof Error ? error.message : String(error)}`))

  /**
   * Ensure one bot's directory exists and is registered as a Harness
   * workspace, so the Web UI can open a session there.
   *
   * @param {object} record bot record.
   * @returns {Promise<string | null>} workspace id or null.
   */
  async function ensureWorkspaceId(record) {
    const directory = await store.ensureWorkspace(record)
    // Read-only lookup first: a list poll must not mutate the durable registry.
    let canonical = directory
    try {
      canonical = await fs.realpath(directory)
    } catch {
      // The directory is created just above; fall back to the resolved path.
    }
    try {
      const existing = ctx.workspaceRegistry.list().find((workspace) => workspace.path === canonical)
      if (existing !== undefined && existing !== null) {
        const id = existing.id
        return typeof id === 'string' ? id : String(id)
      }
    } catch {
      // Fall through to the idempotent create path.
    }
    const workspace = await ctx.workspaceRegistry.create(directory, record.name)
    if (workspace === undefined || workspace === null) return null
    const id = workspace.id
    return typeof id === 'string' ? id : String(id)
  }

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
      throw Object.assign(new Error(`Diretório não encontrado: ${directory}`), { code: 'TEAM_NO_WORKSPACE' })
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

  const pluginDir = path.dirname(fileURLToPath(import.meta.url))
  const notifier = createNotifier({
    icon: path.join(pluginDir, 'icon.svg'),
  })

  // Bit characters (picker, default instructions, avatars) shipped with the bundle.
  const catalog = loadBitCatalog(path.join(pluginDir, 'bits'))
  if (catalog.error !== null) log(`bit catalog unavailable: ${catalog.error}`)

  // Runnable teams: lead/member personas, delegation, harness skills, guard and MCP.
  let teamRuntime = null
  try {
    teamRuntime = installTeamRuntime(ctx, { teams, teamsReady, botsRoot, log })
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
    disposeTeamRoutes = registerTeamRoutes(ctx, { teams, ready: teamsReady, catalog, templates, llm: ctx.llm, log }) ?? (() => {})
    disposeHarnessRoutes = registerHarnessRoutes(ctx, {
      teams,
      ready: teamsReady,
      botsRoot,
      runtime: teamRuntime,
      catalog,
      ensureDirectoryWorkspace,
      log,
    }) ?? (() => {})
  } catch (error) {
    log(`team route registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const disposeAgents = installBotAgents(ctx, { store, vm, ready, log, notifier })

  let disposeRoutes = () => {}
  try {
    disposeRoutes = registerBotRoutes(ctx, {
      store,
      vm,
      ready,
      ensureWorkspaceId,
      onBotChanged: (record) => {
        const refreshed = disposeAgents.refreshBot(record)
        if (refreshed > 0) log(`refreshed ${refreshed} live agent(s) for bot ${record.id}`)
      },
      defaultImage,
      catalog,
      log,
    }) ?? (() => {})
  } catch (error) {
    log(`route registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Test notification: lets the user confirm desktop notifications work for a bot.
  let disposeNotifyTest = () => {}
  try {
    disposeNotifyTest = ctx.connection.fetch.register({
      path: '/api/bots.notify-test',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        const fail = (code, message) => Response.json({ ok: false, error: { code, message } })
        try {
          await ready
          let body
          try {
            body = await request.json()
          } catch {
            return fail('BAD_REQUEST', 'Request body must be valid JSON')
          }
          const id = body !== null && typeof body === 'object' && typeof body.id === 'string' ? body.id : ''
          const bot = id ? store.get(id) : undefined
          if (bot === undefined) return fail('BOT_NOT_FOUND', `Bot "${id}" was not found`)
          const result = await notifier.notify({
            title: `${bot.emoji || '🤖'} ${bot.name}`,
            body: typeof body.message === 'string' && body.message.trim() ? body.message : 'Notificações funcionando: vou te avisar por aqui quando você pedir um lembrete.',
          })
          if (!result.ok) return fail('NOTIFY_FAILED', result.error ?? 'Desktop notification failed')
          return Response.json({ ok: true, method: result.method })
        } catch (error) {
          log(`notify-test failed: ${error instanceof Error ? error.message : String(error)}`)
          return fail('INTERNAL', 'Internal server error')
        }
      },
    }) ?? (() => {})
  } catch (error) {
    log(`notify-test route registration failed: ${error instanceof Error ? error.message : String(error)}`)
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
        let bots = []
        let botRecordsError = null
        try {
          bots = store.list().map((record) => ({
            id: record.id,
            name: record.name,
            vmEnabled: record.vm !== undefined && record.vm.enabled === true,
            workspaceDir: record.workspaceDir,
          }))
        } catch (error) {
          botRecordsError = error instanceof Error ? error.message : String(error)
        }
        const agents = typeof disposeAgents.diagnostics === 'function'
          ? disposeAgents.diagnostics()
          : { agents: [], errors: [] }
        return Response.json({
          ok: true,
          botsPath: store.file,
          storeReady,
          botRecordsError,
          bots,
          agents: agents.agents,
          errors: agents.errors,
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
      disposeTeamRoutes()
    } catch (error) {
      log(`team route disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      disposeNotifyTest()
    } catch (error) {
      log(`notify-test disposal failed: ${error instanceof Error ? error.message : String(error)}`)
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
    try {
      disposeAgents.dispose()
    } catch (error) {
      log(`agent integration disposal failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const disposal = vm.dispose()
      if (disposal && typeof disposal.catch === 'function') disposal.catch(() => {})
    } catch {
      // Best-effort cleanup.
    }
  }, 'bots: teardown')
}
