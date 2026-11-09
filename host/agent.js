/**
 * Per-agent bot integration: resolves the Bot record that owns an agent's
 * session from its working directory and gives that agent a persona prompt
 * section plus — for VM-enabled bots — an isolated shell.
 *
 * This module is imported by `index.js` and only uses plain JavaScript; every
 * DeepSeek Harness capability arrives through the plugin `ctx`.
 *
 * @module @local/dsh-bots/host/agent
 */

import { MAX_BODY, MAX_TITLE } from './notify.js'

/** Shell tools an agent can inherit from its preset. Host shell is denied for VM bots. */
const HOST_SHELL_TOOLS = [
  'bash',
  'pwsh',
  'bash_persistent',
  'pwsh_persistent',
  'terminal',
  'terminal_bash',
  'terminal_pwsh',
]

/** A bot's persona section sits right after the deployment persona (order 0). */
const PERSONA_SECTION_ORDER = 120

/**
 * Build the model-facing identity and machine rules for one bot.
 *
 * @param {object} bot persisted bot record.
 * @param {boolean} vm whether the bot VM is enabled.
 * @returns {string} prompt section text.
 */
export function buildPersonaText(bot, vm) {
  const name = bot.name
  const emoji = bot.emoji || '🤖'
  const instructions = (bot.instructions || '').trim()
  const lines = [
    `# Bot identity: ${name}`,
    '',
    `You are ${emoji} **${name}**, a persistent AI teammate the user created in DeepSeek Harness.`,
    'This conversation runs in your own workspace; everything here belongs to you.',
    'Stay in character as this bot for the entire conversation, and do not pretend to be a different bot or the generic deployment assistant.',
    `Your workspace directory is \`${bot.workspaceDir}\`.`,
  ]

  if (instructions.length > 0) {
    lines.push('', '## Your standing instructions', '', instructions)
  }

  if (vm) {
    lines.push(
      '',
      '## Your machine',
      '',
      `You have your own Docker VM (container \`dsh-bot-${bot.id}\`, image \`${bot.vm.image}\`) that belongs only to you.`,
      'Run every terminal command through the `vm_bash` tool: installing packages, running servers, builds, git, scripts, and long-lived processes.',
      'The host shell tool is intentionally unavailable in this session; never ask the user to run commands for you on their machine.',
      'Your workspace directory is mounted at the same absolute path inside the VM, so files you create there survive between conversations and appear on the user\'s machine too.',
      'Software you install inside the VM stays installed while the container exists. Long-running servers you start in the VM keep running for you between tool calls.',
      'Check the `[exit code: N]` marker on every `vm_bash` result; investigate failures before moving on.',
    )
  } else {
    lines.push(
      '',
      '## Your machine',
      '',
      'You run directly on the user\'s machine (this bot has no VM). Use the shell normally, and keep destructive operations inside your workspace unless the user asks otherwise.',
    )
  }

  lines.push(
    '',
    '## Scheduling and reminders',
    '',
    'You can schedule future work with the `schedule_create` tool (and inspect or change it with `schedule_list`, `schedule_view`, `schedule_edit`). Create or change tasks only when the user asks for it.',
    'Write each task `prompt` as a self-contained instruction to your future self, because it is delivered later as a new message. Use the user\'s time zone for `DTSTART` unless they say otherwise.',
    'For a reminder ("me lembre de…", "remind me…"): create a task whose prompt starts with "Scheduled reminder:" and tells you to call `notify_user` with the reminder text and then reply with one short line in the conversation. Prefer `target: "this_session"` so the reminder lands in this conversation; for one-off reminders use `RRULE:FREQ=DAILY;COUNT=1`.',
    'When you receive a scheduled reminder, call `notify_user` first (a desktop notification on the user\'s computer), then confirm briefly. Use `notify_user` on your own only for things the user asked to be alerted about, or when a long task they asked you to finish is done.',
  )

  return lines.join('\n')
}

/**
 * Shape one `BotVm.exec()` result into the model-facing text of `vm_bash`,
 * following the Harness bash convention (`[stderr]` section + exit markers).
 *
 * @param {object} result exec result from `host/vm.js`.
 * @returns {string} rendered tool text.
 */
export function renderVmExecResult(result) {
  let body = typeof result.stdout === 'string' ? result.stdout : ''
  const err = typeof result.stderr === 'string' ? result.stderr : ''
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${err}`
  }
  if (body.length === 0) body = '(no output)'
  const markers = []
  if (result.truncated) markers.push('[output truncated]')
  if (result.timedOut) markers.push('[timed out in the bot VM]')
  if (!result.timedOut && result.signal !== null && result.signal !== undefined) markers.push(`[killed by signal: ${result.signal}]`)
  else if (!result.timedOut && result.exitCode !== 0) markers.push(`[exit code: ${result.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * Whether a tool error is an infrastructure problem worth surfacing as a
 * failed tool call rather than as a normal shell result.
 *
 * @param {unknown} error thrown value.
 * @returns {boolean} true for errors carrying a VM/Docker `code`.
 */
function isInfrastructureError(error) {
  return Boolean(error && typeof error === 'object' && typeof error.code === 'string' && error.code.startsWith('VM_'))
}

/**
 * Describe one VM tool error for the model without crashing the turn while
 * the infrastructure is unavailable.
 *
 * @param {unknown} error thrown value.
 * @returns {string} model-facing failure text.
 */
function describeVmFailure(error) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'VM_IMAGE_MISSING') {
    return `vm_bash failed: ${message}. Ask the user to download the image in the Bots page (the bot's VM cannot start until it exists).`
  }
  if (code === 'VM_DOCKER_UNAVAILABLE') {
    return `vm_bash failed: ${message}. Docker is not available on the host; tell the user their bot VM cannot start until Docker is running.`
  }
  return `vm_bash failed: ${message}`
}

/**
 * Install bot persona and VM behavior on every live agent.
 *
 * The integration resolves a bot from the agent session's working directory
 * (no filesystem I/O: `ctx.workingDirectory.get(session)` reads the committed
 * projection). It registers, per matching agent:
 *  - a system-prompt section carrying the persona and machine rules;
 *  - for VM-enabled bots, a tool restriction that removes the host shell;
 * and globally a `vm_bash` tool whose step-time `when` condition admits only
 * agents of VM-enabled bots.
 *
 * All registrations are disposed on agent disposal and on plugin unload.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {object} deps integration dependencies.
 * @param {object} deps.store BotStore instance (already loading or ready).
 * @param {object} deps.vm BotVm instance.
 * @param {Promise<void>} deps.ready resolves after `store.init()`.
 * @param {(message: string) => void} [deps.log] diagnostic logger.
 * @returns {{ dispose: () => void, botForSession: (session: object) => object | undefined }} disposer and resolver.
 */
export function installBotAgents(ctx, deps) {
  const { store, vm, ready } = deps
  const log = typeof deps.log === 'function' ? deps.log : () => {}

  /** @type {Map<object, Array<() => void>>} per-agent disposers */
  const agentDisposers = new Map()
  /** @type {Map<string, { id: string, botId: string, botName: string, vmEnabled: boolean, attachedAt: string }>} */
  const attached = new Map()
  /** @type {string[]} last integration failures, newest last (diagnostics only) */
  const errors = []

  /**
   * Record one integration failure for `/api/bots.diagnostics`.
   *
   * @param {string} message failure text.
   * @returns {void}
   */
  function noteError(message) {
    errors.push(`${new Date().toISOString()} ${message}`)
    if (errors.length > 20) errors.shift()
    log(message)
  }

  /**
   * Resolve the bot that owns a session, from the committed working directory.
   *
   * @param {object | undefined} session agent session.
   * @returns {object | undefined} bot record.
   */
  function botForSession(session) {
    if (!session) return undefined
    try {
      const directory = ctx.workingDirectory.get(session)
      if (typeof directory !== 'string' || directory.length === 0) return undefined
      return store.getByWorkspace(directory)
    } catch (error) {
      log(`bot lookup failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * Find inherited host-shell tools the agent currently sees, so the
   * restriction can name only registered tools.
   *
   * @param {object} agent live agent.
   * @returns {string[]} tool names to deny.
   */
  function inheritedShellTools(agent) {
    const names = []
    for (const name of HOST_SHELL_TOOLS) {
      try {
        if (agent.ctx.tools.get(name, agent) !== undefined) names.push(name)
      } catch {
        // A tool registry without that name simply has no shell to remove.
      }
    }
    return names
  }

  /** Tools whose presence matters for a bot, reported by diagnostics. */
  const DIAGNOSTIC_TOOLS = ['bash', 'vm_bash', 'notify_user', 'schedule_create', 'schedule_list', 'schedule_edit']

  /**
   * Which diagnostic tools this agent's registry exposes (registered
   * definitions, before step-time conditions).
   *
   * @param {object} agent live agent.
   * @returns {string[]} visible tool names.
   */
  function visibleTools(agent) {
    const names = []
    for (const name of DIAGNOSTIC_TOOLS) {
      try {
        if (agent.ctx.tools.get(name, agent) !== undefined) names.push(name)
      } catch {
        // Unknown in this registry.
      }
    }
    return names
  }

  /**
   * Register the bot contributions on one agent.
   *
   * @param {object} agent live agent.
   * @returns {void}
   */
  function installAgent(agent) {
    if (!agent || agentDisposers.has(agent)) return
    let bot
    try {
      bot = botForSession(agent.session)
    } catch (error) {
      log(`agent install lookup failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (!bot) return
    const vmEnabled = bot.vm !== undefined && bot.vm.enabled === true
    const disposers = []
    let personaOk = false
    let restricted = false
    try {
      disposers.push(agent.ctx.systemPrompt.section({
        name: `bots:persona:${bot.id}`,
        order: PERSONA_SECTION_ORDER,
        // Persona text is user-authored and may contain literal `{{...}}`;
        // prompt interpolation must never turn it into a template.
        interpolate: false,
        // Resolve the live record at every assembly so edits to the persona or
        // the VM toggle are visible without recreating the Agent.
        text: () => {
          const live = store.get(bot.id) ?? bot
          return buildPersonaText(live, live.vm !== undefined && live.vm.enabled === true)
        },
      }))
      personaOk = true
    } catch (error) {
      noteError(`persona section registration failed for bot ${bot.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (vmEnabled) {
      try {
        const denied = inheritedShellTools(agent)
        if (denied.length > 0) {
          disposers.push(agent.ctx.tools.restrict({ deny: denied }))
          restricted = true
        }
      } catch (error) {
        noteError(`host shell restriction failed for bot ${bot.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (disposers.length > 0) agentDisposers.set(agent, disposers)
    attached.set(agent.id, {
      id: agent.id,
      botId: bot.id,
      botName: bot.name,
      vmEnabled,
      restricted,
      personaOk,
      tools: visibleTools(agent),
      attachedAt: new Date().toISOString(),
    })
    log(`attached agent ${agent.id} to bot ${bot.id}${vmEnabled ? ' (VM)' : ''}`)
  }

  /**
   * Re-apply the bot contributions to every live agent of one bot, so a VM
   * toggle or persona edit is reflected in already-open sessions.
   *
   * @param {string | { id: string }} botOrId bot record or id.
   * @returns {number} number of agents reinstalled.
   */
  function refreshBot(botOrId) {
    const id = typeof botOrId === 'string' ? botOrId : botOrId?.id
    if (typeof id !== 'string' || id.length === 0) return 0
    let refreshed = 0
    for (const agent of [...agentDisposers.keys()]) {
      const entry = attached.get(agent.id)
      if (entry === undefined || entry.botId !== id) continue
      uninstallAgent(agent)
      try {
        installAgent(agent)
        refreshed += 1
      } catch (error) {
        noteError(`agent reinstall failed for bot ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return refreshed
  }

  /**
   * Remove one agent's registrations.
   *
   * @param {object} agent live or disposed agent.
   * @returns {void}
   */
  function uninstallAgent(agent) {
    const disposers = agentDisposers.get(agent)
    if (disposers === undefined) return
    agentDisposers.delete(agent)
    attached.delete(agent.id)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        log(`agent dispose failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Register `notify_user`: a desktop notification on the user's computer,
   * available to bot agents only (and to their subagents, which inherit the
   * bot's working directory).
   *
   * @returns {() => void} disposer.
   */
  function installNotifyTool() {
    if (deps.notifier === undefined || deps.notifier === null) return () => {}
    const definition = {
      name: 'notify_user',
      description:
        'Show a desktop notification on the user\'s computer, titled with this bot\'s name. '
        + 'Use it to deliver reminders the user asked for (including when a scheduled reminder arrives) and to tell the user that a long task they asked for has finished. '
        + 'Do not use it for ordinary replies. Keep the message short and self-explanatory.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: `Notification text (max ${MAX_BODY} characters).` },
          title: { type: 'string', description: `Optional short title (max ${MAX_TITLE} characters); defaults to the bot name.` },
          urgency: { type: 'string', enum: ['low', 'normal', 'critical'], description: 'Optional urgency; "critical" stays on screen until dismissed. Defaults to "normal".' },
        },
        required: ['message'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) throw new Error('notify_user requires an owning agent session')
        const bot = botForSession(agent.session)
        if (!bot) throw new Error('notify_user is only available inside a bot session')
        const prefix = `${bot.emoji || '🤖'} ${bot.name}`
        const title = typeof args.title === 'string' && args.title.trim().length > 0 ? `${prefix} · ${args.title.trim()}` : prefix
        const result = await deps.notifier.notify({ title, body: args.message, urgency: args.urgency })
        if (!result.ok) throw new Error(`notify_user failed: ${result.error}`)
        return `Notification shown on the user's desktop (${result.method}).`
      },
    }
    const when = ({ agent }) => agent !== undefined && agent !== null && botForSession(agent.session) !== undefined
    try {
      return ctx.tools.register(definition, { when })
    } catch (error) {
      noteError(`notify_user registration failed: ${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
  }

  /** Register `vm_bash`; the step-time condition limits it to VM bot agents. */
  function installVmBashTool() {
    const definition = {
      name: 'vm_bash',
      description:
        'Run a shell command inside this bot\'s own Docker VM. Use it for ALL terminal work: installing packages, building, running servers, git, scripts. '
        + 'The VM is a persistent Linux container that belongs only to this bot, and the bot workspace is mounted at the same absolute path inside it. '
        + 'The command runs as a fresh `bash -lc` process; state does not survive between calls except files and processes left running. '
        + 'Every result ends with a machine-readable exit marker; check it and investigate failures.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to run inside the VM.',
          },
          workdir: {
            type: 'string',
            description: 'Optional absolute working directory inside the VM; defaults to the bot workspace.',
          },
          timeout_ms: {
            type: 'integer',
            description: 'Optional foreground deadline in milliseconds (default 120000, capped by the deployment).',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) throw new Error('vm_bash requires an owning agent session')
        const bot = botForSession(agent.session)
        if (!bot) throw new Error('vm_bash is only available inside a bot session')
        if (bot.vm === undefined || bot.vm.enabled !== true) throw new Error(`bot ${bot.name} has no VM enabled`)
        let status
        try {
          status = await vm.ensure(bot, { signal: exec.signal })
        } catch (error) {
          if (isInfrastructureError(error)) throw new Error(describeVmFailure(error), { cause: error })
          throw error
        }
        if (status !== undefined && status.running === false && typeof status.error === 'string' && status.error.length > 0) {
          throw new Error(`vm_bash failed: ${status.error}`)
        }
        try {
          const result = await vm.exec(bot, {
            command: args.command,
            workdir: typeof args.workdir === 'string' && args.workdir.length > 0 ? args.workdir : bot.workspaceDir,
            timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
            signal: exec.signal,
          })
          return renderVmExecResult(result)
        } catch (error) {
          if (isInfrastructureError(error)) throw new Error(describeVmFailure(error), { cause: error })
          throw error
        }
      },
    }

    const when = ({ agent }) => {
      if (!agent) return false
      const bot = botForSession(agent.session)
      return bot !== undefined && bot.vm !== undefined && bot.vm.enabled === true
    }

    try {
      return ctx.tools.register(definition, { when })
    } catch (error) {
      log(`vm_bash registration failed: ${error instanceof Error ? error.message : String(error)}`)
      return () => {}
    }
  }

  const disposeVmBash = installVmBashTool()
  const disposeNotify = installNotifyTool()

  // Defense in depth for the VM toggle: a session created before the VM was
  // enabled has no static shell restriction yet (refreshBot installs it after
  // the next update), and a stale or missed refresh must never let the host
  // shell run for a VM bot. The guard is synchronous and uses the live record.
  let disposeShellGuard = () => {}
  try {
    disposeShellGuard = ctx.tools.guard((exec) => {
      if (exec === undefined || exec === null || typeof exec.name !== 'string') return undefined
      if (!HOST_SHELL_TOOLS.includes(exec.name)) return undefined
      const agent = exec.agent
      if (agent === undefined || agent === null) return undefined
      const bot = botForSession(agent.session)
      if (bot === undefined || bot.vm === undefined || bot.vm.enabled !== true) return undefined
      return `This bot runs terminal commands inside its own Docker VM: use the vm_bash tool instead of ${exec.name}.`
    }) ?? (() => {})
  } catch (error) {
    noteError(`host shell guard registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Attach to agents created after this plugin loaded.
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await ready
    } catch (error) {
      log(`bot store failed to initialize: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    installAgent(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    uninstallAgent(agent)
  })

  // Attach to agents that were already live when this plugin loaded.
  ready.then(() => {
    let agents = []
    try {
      agents = ctx.agents.list()
    } catch (error) {
      log(`live agent scan failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const agent of agents) {
      try {
        installAgent(agent)
      } catch (error) {
        log(`live agent install failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }, (error) => {
    log(`bot store failed to initialize: ${error instanceof Error ? error.message : String(error)}`)
  })

  return {
    dispose() {
      for (const agent of [...agentDisposers.keys()]) uninstallAgent(agent)
      try {
        disposeShellGuard()
      } catch (error) {
        log(`host shell guard disposal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        disposeNotify()
      } catch (error) {
        log(`notify_user disposal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        disposeVmBash()
      } catch (error) {
        log(`vm_bash disposal failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    botForSession,
    refreshBot,
    /**
     * Snapshot of the live integration state for `/api/bots.diagnostics`.
     *
     * @returns {{ agents: object[], errors: string[] }} attached agents and recent failures.
     */
    diagnostics() {
      return {
        agents: [...attached.values()].map((entry) => ({ ...entry })),
        errors: [...errors],
      }
    },
  }
}
