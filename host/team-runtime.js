/**
 * Runtime for teams of bits: makes a team executable inside DeepSeek Harness
 * sessions.
 *
 * - Resolution: a session belongs to a team when it is a child created by
 *   `team_delegate` (binding stored before the child exists), a root session
 *   handed off with `team_handoff`, or a root session whose working directory
 *   is inside the workspace of a `bindWorkspace` team (the lead).
 * - Every team member references a bit (`member.bitId`); the bit record is read
 *   from the injected bit store and supplies the persona (`instructions`),
 *   `isOrchestrator`, model and effort. There is no model/provider pinning on
 *   the member itself anymore.
 * - The lead is an orchestrator bit on a DSH route. Orchestrator bits run as
 *   DSH agents (root/child) and get a prompt section (persona, roster, flow,
 *   harness rules, glossary, applyTo index), tool restrictions, `team_delegate`
 *   with the members they may launch, `team_handoff` for root leads, and the
 *   MCP servers configured for the member. Worker bits are never agents: they
 *   are single-shot invocations through `bitRuntime.invokeWorker`.
 * - Global hooks, filtered by team agents: a skill provider exposing the
 *   harness pack skills, `tools/pre-execute` running the pack guard
 *   (`git-guard.cjs` in Claude Code format) plus the lead read policy,
 *   `tools/post-execute` attaching `applyTo` instructions once per agent, and
 *   `DSH_*` shell variables (`DSH_HARNESS_PACK_ROOT`, `DSH_TEAM_ID`,
 *   `DSH_TEAM_MEMBER`).
 *
 * @module host/team-runtime
 */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, promises as fsp, readFileSync, statSync, watch as fsWatch } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { readPack } from './harness.js'
import { TeamBindingStore } from './team-bindings.js'
import { UNGUARDED_TOOLS, guardEvent, leadMayRead, runGuard, teamToolAllowed } from './team-guard.js'
import { leadPromptText, memberPromptText } from './team-prompt.js'

/** Prompt section order: after the team policy, before tool guidance. */
const TEAM_SECTION_ORDER = 700
const SKILL_PROVIDER = 'bits-team-harness'
const MAX_DEPTH = 4

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code })
}

function stripFrontmatter(text) {
  return String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  const a = path.resolve(root)
  const b = path.resolve(target)
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep)
}

/** Locate a package of the DSH installation from the host entry path. */
function findDshPackage(name) {
  const candidates = [...process.argv, process.env.DSH_INSTALL_ROOT || '']
  for (const entry of candidates) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry)) continue
    const marker = `${path.sep}node_modules${path.sep}`
    const index = entry.lastIndexOf(marker)
    if (index < 0) continue
    const dir = path.join(entry.slice(0, index + marker.length), name)
    if (existsSync(path.join(dir, 'package.json'))) return dir
  }
  return null
}

/**
 * Install the team runtime.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ teams: any, teamsReady: Promise<void>, bits: any, models: any, bitRuntime: any, botsRoot: string, log?: (message: string) => void }} deps
 */
export function installTeamRuntime(ctx, deps) {
  const { teams, botsRoot, bits, models, bitRuntime } = deps
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const packsRoot = path.join(botsRoot, 'harness')
  const bindings = new TeamBindingStore({ botsRoot })
  const ready = Promise.all([deps.teamsReady, bindings.init()])
  let readyDone = false
  ready.then(() => { readyDone = true }, () => {})
  const errors = []
  /** @type {Map<object, { key: string, disposers: Array<() => void>, sent: Set<string> }>} */
  const installed = new Map()
  const hooksInstalled = new Set()
  let skillControl = null
  let disposed = false

  function noteError(message) {
    errors.push(`${new Date().toISOString()} ${message}`)
    if (errors.length > 40) errors.shift()
    log(message)
  }

  /* ------------------------------- bits --------------------------------- */

  /** Bit record of one team member (null when the member/bit is stale). */
  function lookupBit(member) {
    if (!member || typeof member.bitId !== 'string' || member.bitId === '') return null
    try {
      const bit = bits && typeof bits.get === 'function' ? bits.get(member.bitId) : null
      return bit !== null && typeof bit === 'object' ? bit : null
    } catch {
      return null
    }
  }

  /** Bit record behind a resolved binding (lead or member). */
  function bitOfBinding(binding) {
    return binding ? lookupBit(binding.member) : null
  }

  function isOrchestratorBit(bit) {
    return !!bit && bit.isOrchestrator === true
  }

  function bitNameOf(bit, member) {
    const name = bit && typeof bit.name === 'string' ? bit.name.trim() : ''
    return name !== '' ? name : (member && typeof member.id === 'string' ? member.id : 'bit')
  }

  /** Display name of a member's bit (used in tools, prompts and errors). */
  function memberNameOf(member) {
    return bitNameOf(lookupBit(member), member)
  }

  /** Bit records of a team's members, keyed by bit id (for the prompt text). */
  function bitsByIdFor(team) {
    const map = {}
    for (const member of team && Array.isArray(team.members) ? team.members : []) {
      const bit = lookupBit(member)
      if (bit && typeof bit.id === 'string') map[bit.id] = bit
    }
    return map
  }

  /* ---------------------------- teams cache ----------------------------- */

  let teamCache = { revision: '', byId: new Map() }
  function teamMap() {
    // Never cache before the store has loaded: an early empty list would stick
    // until the file changes.
    if (!readyDone) return new Map()
    let revision = 'missing'
    try {
      const info = statSync(teams.file)
      revision = `${info.mtimeMs}:${info.size}`
    } catch {
      revision = 'missing'
    }
    if (revision !== teamCache.revision) {
      let list = []
      try {
        list = teams.list()
      } catch {
        list = []
      }
      teamCache = { revision, byId: new Map(list.map((team) => [team.id, team])) }
    }
    return teamCache.byId
  }

  function teamsById() {
    return Object.fromEntries(teamMap())
  }

  /* ---------------------------- packs cache ----------------------------- */

  /** @type {Map<string, { stamp: string, pack: any, rules: string, conduct: string, instructions: any[], skills: any[] }>} */
  const packCache = new Map()
  function loadPack(packId) {
    if (!packId) return null
    const manifestFile = path.join(packsRoot, packId, 'manifest.json')
    let stamp
    try {
      stamp = String(statSync(manifestFile).mtimeMs)
    } catch {
      return null
    }
    const cached = packCache.get(packId)
    if (cached && cached.stamp === stamp) return cached
    let pack
    try {
      pack = JSON.parse(readFileSync(manifestFile, 'utf8'))
    } catch (error) {
      noteError(`pack ${packId} unreadable: ${messageOf(error)}`)
      return null
    }
    const read = (rel) => {
      if (!rel) return ''
      try {
        return readFileSync(path.join(pack.packDir, rel), 'utf8')
      } catch {
        return ''
      }
    }
    const value = {
      stamp,
      pack,
      rules: read(pack.rules),
      conduct: read(pack.conduct),
      instructions: (pack.instructions || []).map((item) => ({ ...item, body: stripFrontmatter(read(item.path)).trim() })),
      skills: (pack.skills || []).map((item) => ({
        ...item,
        file: path.join(pack.packDir, item.path),
        base: path.join(pack.packDir, item.dir),
      })),
    }
    packCache.set(packId, value)
    return value
  }

  /* ----------------------------- resolution ----------------------------- */

  function memberOf(team, id) {
    return (team.members || []).find((member) => member.id === id) || null
  }

  function sessionCwd(agent) {
    try {
      return ctx.workingDirectory.get(agent.session)
    } catch {
      return agent.session && agent.session.header && agent.session.header.cwd
    }
  }

  /**
   * Team binding of an agent, resolved live.
   *
   * @returns {null | { team: any, member: any, role: 'lead' | 'member', child: boolean, sessionId: string }}
   */
  function resolve(agent) {
    if (!agent || !agent.session) return null
    const sessionId = agent.session.id || agent.id
    const header = agent.session.header || {}
    const child = header.origin === 'subagent'
    const map = teamMap()
    const stored = bindings.get(sessionId)
    if (stored) {
      const team = map.get(stored.teamId)
      if (!team) return null
      if (stored.role === 'lead') return { team, member: memberOf(team, team.lead), role: 'lead', child, sessionId }
      const member = memberOf(team, stored.memberId)
      return member ? { team, member, role: 'member', child, sessionId } : null
    }
    if (child) return null
    const cwd = sessionCwd(agent)
    if (typeof cwd !== 'string') return null
    let best = null
    for (const team of map.values()) {
      if (!team.bindWorkspace || !team.workspaceDir || !isInside(team.workspaceDir, cwd)) continue
      if (!best || team.workspaceDir.length > best.workspaceDir.length) best = team
    }
    return best ? { team: best, member: memberOf(best, best.lead), role: 'lead', child: false, sessionId } : null
  }

  function bindingKey(binding) {
    return binding ? `${binding.team.id}:${binding.role}:${binding.member ? binding.member.id : '-'}` : ''
  }

  /** A binding "orchestrates" when its bit is an orchestrator (the team lead is always one). */
  function orchestrates(binding) {
    if (!binding) return false
    if (binding.role === 'lead') return true
    return isOrchestratorBit(bitOfBinding(binding))
  }

  /**
   * Role seen by tool policies and the guard. Kept from v4: a read-only lead
   * only orchestrates (write tools are hidden/denied); a write-access binding
   * keeps the member tools. Orchestrator membership is now decided by the bit.
   */
  function roleOf(binding) {
    const readOnly = !!binding && !!binding.member && binding.member.access === 'read'
    return { orchestrator: orchestrates(binding) && readOnly, readOnly, child: !!binding && !!binding.child }
  }

  /* ------------------------------- prompt -------------------------------- */

  function promptFor(agent) {
    const binding = resolve(agent)
    if (!binding) return ''
    const packData = loadPack(binding.team.harness)
    const input = {
      team: binding.team,
      member: binding.member,
      bit: bitOfBinding(binding),
      bitsById: bitsByIdFor(binding.team),
      teamsById: teamsById(),
      pack: packData ? packData.pack : null,
      rules: packData ? packData.rules : '',
      conduct: packData ? packData.conduct : '',
    }
    if (binding.role === 'lead') {
      const text = leadPromptText(input)
      return binding.child
        ? `${text}\n\n## Você foi chamado por outro time\n\nEsta sessão é o líder de outro time que delegou a você a etapa do seu time. Siga o seu fluxo, delegue aos seus bits e ponha o relatório completo na sua mensagem final: ela volta a quem chamou. Você não fala com o dev: devolva perguntas e PAUSAs no relatório.`
        : text
    }
    return memberPromptText(input)
  }

  /* ------------------------------ delegation ------------------------------ */

  function spawnProvider() {
    const subagents = ctx.subagents
    if (!subagents) return null
    let names = []
    try {
      names = subagents.list()
    } catch {
      names = []
    }
    const ordered = names.includes('spawn') ? ['spawn', ...names.filter((name) => name !== 'spawn')] : names
    for (const name of ordered) {
      const provider = subagents.getProvider(name)
      if (provider && provider.capabilities && provider.capabilities.agentOptions && !provider.inheritsParentContext) return name
    }
    return null
  }

  function launchableFor(binding) {
    const team = binding.team
    const self = binding.member ? binding.member.id : null
    let ids = binding.member && binding.member.launches && binding.member.launches.length ? binding.member.launches : []
    if (binding.role === 'lead' && ids.length === 0) ids = (team.members || []).map((member) => member.id).filter((id) => id !== self)
    return ids.map((id) => memberOf(team, id)).filter(Boolean)
  }

  /** Caller cwd when it is inside the team workspace; otherwise the team workspace. */
  function delegationCwd(agent, team) {
    const callerCwd = sessionCwd(agent)
    if (typeof callerCwd === 'string' && callerCwd !== '' && typeof team.workspaceDir === 'string' && isInside(team.workspaceDir, callerCwd)) return callerCwd
    if (typeof team.workspaceDir === 'string' && team.workspaceDir !== '') return team.workspaceDir
    return typeof callerCwd === 'string' && callerCwd !== '' ? callerCwd : undefined
  }

  /** `<backend>/<model> · <effort>` text of a worker invocation result. */
  function resultRouteText(meta) {
    const backend = meta && meta.backend === 'claude-code' ? 'claude-code' : 'dsh'
    const model = meta && typeof meta.model === 'string' && meta.model !== '' ? meta.model : 'modelo'
    const short = backend === 'claude-code' ? model.replace(/^subscription\//, '') : model
    return meta && typeof meta.effort === 'string' && meta.effort !== '' ? `${backend}/${short} · ${meta.effort}` : `${backend}/${short}`
  }

  /**
   * Delegate to an orchestrator bit: the v4 child-agent path, with the route
   * coming from the target bit (`teamRef` targets run the other team's lead).
   */
  async function delegateToAgent(agent, binding, target, targetBit, task, exec) {
    const provider = spawnProvider()
    if (!provider) throw codedError('TEAM_DELEGATE_UNAVAILABLE', 'Nenhum provedor de subagentes com rota própria está disponível neste perfil.')
    let childBinding
    let routeBit = targetBit
    let label = bitNameOf(targetBit, target)
    let routeTeam = null
    if (target.teamRef) {
      const other = teamMap().get(target.teamRef)
      if (!other) throw codedError('TEAM_INVALID', `O time referenciado por "${target.id}" não existe mais.`)
      const otherLead = memberOf(other, other.lead)
      routeBit = lookupBit(otherLead)
      if (!routeBit) throw codedError('TEAM_INVALID', `O time "${other.name}" não tem um bit de liderança válido.`)
      childBinding = { teamId: other.id, role: 'lead', parentSession: binding.sessionId }
      label = other.name
      routeTeam = other
    } else {
      childBinding = { teamId: binding.team.id, memberId: target.id, role: 'member', parentSession: binding.sessionId }
    }
    if (!isOrchestratorBit(routeBit)) {
      throw codedError('TEAM_LEAD_NOT_ORCHESTRATOR', `O bit "${bitNameOf(routeBit, target)}"${routeTeam ? ` (líder do time «${routeTeam.name}»)` : ''} precisa ser um orquestrador para rodar como agente.`)
    }
    const route = await models.routeFor(routeBit)
    const childId = randomUUID()
    await bindings.set(childId, childBinding)
    const caller = binding.member ? memberNameOf(binding.member) : 'o líder'
    const prompt = `Tarefa delegada por ${caller} (time ${binding.team.name}):\n\n${task}`
    let run
    try {
      run = await ctx.subagents.startActivation({
        provider,
        childId,
        delivery: 'caller',
        signal: exec.signal,
        label: `${label}: ${task.replace(/\s+/g, ' ').slice(0, 60)}`,
        request: {
          parent: agent,
          prompt: [{ type: 'text', text: prompt }],
          maxDepth: MAX_DEPTH,
          agentOptions: route,
        },
      })
    } catch (error) {
      await bindings.delete(childId).catch(() => {})
      throw codedError('TEAM_DELEGATE_FAILED', `Não foi possível iniciar ${label}: ${messageOf(error)}`)
    }
    const stop = () => {
      try { run.dispose() } catch { /* already settled */ }
    }
    exec.signal.addEventListener('abort', stop, { once: true })
    try {
      const result = await run.result
      const blocks = Array.isArray(result.output) ? result.output : []
      const text = blocks.filter((block) => block && block.type === 'text').map((block) => block.text).join('\n').trim()
      const routeText = `${route.provider}/${route.model}${route.reasoningEffort ? ` · ${route.reasoningEffort}` : ''}`
      return [
        `[${label} · ${result.stopReason} · ${routeText} · sessão ${run.childId}]`,
        text || '(o bit terminou sem mensagem final)',
        result.diagnostic ? `\nDiagnóstico: ${result.diagnostic}` : '',
      ].join('\n')
    } finally {
      exec.signal.removeEventListener('abort', stop)
    }
  }

  /**
   * Delegate to a worker bit: one-shot invocation through the bit runtime
   * (`claude_delegate` for subscription models, a single DSH model call for
   * chat routes). The result header is `[<bit> · <model> · <effort>]`.
   */
  async function delegateToWorker(agent, binding, target, targetBit, task, exec) {
    if (!bitRuntime || typeof bitRuntime.invokeWorker !== 'function') {
      throw codedError('BIT_DELEGATE_UNAVAILABLE', 'O runtime dos bits não está disponível neste Harness: não é possível executar bits workers.')
    }
    const cwd = delegationCwd(agent, binding.team)
    const readOnly = target.access === 'read'
    let result
    try {
      result = await bitRuntime.invokeWorker({ bit: targetBit, task, cwd, readOnly, signal: exec.signal })
    } catch (error) {
      if (exec.signal && exec.signal.aborted) throw error
      throw codedError(error && typeof error.code === 'string' ? error.code : 'BIT_RUN_FAILED', `O bit "${bitNameOf(targetBit, target)}" falhou: ${messageOf(error)}`)
    }
    const text = result && typeof result.text === 'string' && result.text.trim() !== '' ? result.text.trim() : '(o bit terminou sem resposta)'
    const meta = (result && result.meta) || {}
    return [`[${bitNameOf(targetBit, target)} · ${resultRouteText(meta)}]`, text].join('\n')
  }

  async function delegate(agent, args, exec) {
    const binding = resolve(agent)
    if (!binding) throw codedError('TEAM_DELEGATE_INVALID', 'team_delegate só existe em sessões de um time.')
    const allowed = launchableFor(binding)
    const target = allowed.find((member) => member.id === args.member)
    if (!target) {
      throw codedError('TEAM_DELEGATE_INVALID', `"${args.member}" não pode ser lançado por ${binding.member ? memberNameOf(binding.member) : 'este agente'}. Permitidos: ${allowed.map((member) => member.id).join(', ') || 'nenhum'}.`)
    }
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    if (!task) throw codedError('TEAM_DELEGATE_INVALID', 'team_delegate: "task" é obrigatório e precisa ser autocontido.')
    // teamRef targets always run the other team's lead as a child agent.
    if (target.teamRef) return delegateToAgent(agent, binding, target, null, task, exec)
    const targetBit = lookupBit(target)
    if (!targetBit) throw codedError('TEAM_INVALID', `O bit do membro "${target.id}" (bitId "${target.bitId || '?'}") não existe mais.`)
    // Orchestrator bits run as child agents; worker bits are single-shot invocations.
    if (isOrchestratorBit(targetBit)) return delegateToAgent(agent, binding, target, targetBit, task, exec)
    return delegateToWorker(agent, binding, target, targetBit, task, exec)
  }

  function delegateTool(binding) {
    const allowed = launchableFor(binding)
    if (allowed.length === 0) return null
    const lines = allowed.map((member) => {
      if (member.teamRef) {
        const other = teamMap().get(member.teamRef)
        return `- ${member.id}: time «${other ? other.name : member.teamRef}» (o líder dele executa e devolve o relatório)`
      }
      const bit = lookupBit(member)
      const kind = isOrchestratorBit(bit) ? 'orquestrador, roda como agente filho' : 'worker, invocação única'
      return `- ${member.id}: ${memberNameOf(member)} — ${member.role || ''}${member.access === 'read' ? ' (somente leitura)' : ''} · ${kind}${bit ? ` · ${bit.model || 'modelo padrão'}${bit.effort ? ` · ${bit.effort}` : ''}` : ''}`
    })
    return {
      name: 'team_delegate',
      description: [
        'Delegate one self-contained step of the team flow to a bit and wait for its result (returned as this tool result).',
        'Worker bits (isOrchestrator: false) are single-shot invocations: they do not see this conversation and return only a text report; the task must be complete (goal and done criteria, the working tree (<WT>), what is already decided, files, skills to read, prohibitions and the report format).',
        'Orchestrator bits (isOrchestrator: true) run as child agents with their own roster, flow, tool access and harness guard.',
        'Independent delegations can be issued in the same response; they run in parallel.',
        'Bits you may launch:',
        ...lines,
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          member: { type: 'string', enum: allowed.map((member) => member.id), description: 'Member id from the roster.' },
          task: { type: 'string', description: 'Complete, self-contained task for the bit (pt-BR), including the expected report format.' },
        },
        required: ['member', 'task'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (!exec.agent) throw new Error('team_delegate requires an owning agent')
        return delegate(exec.agent, args, exec)
      },
    }
  }

  /** Teams reachable by handoff from a team: referenced by members or team nodes, plus same-workspace teams. */
  function handoffTargets(team) {
    const map = teamMap()
    const ids = new Set()
    for (const member of team.members || []) if (member.teamRef) ids.add(member.teamRef)
    for (const node of (team.flow && team.flow.nodes) || []) if (node.type === 'team' && node.teamRef) ids.add(node.teamRef)
    for (const other of map.values()) if (other.id !== team.id && other.workspaceDir && other.workspaceDir === team.workspaceDir) ids.add(other.id)
    ids.delete(team.id)
    // A handoff target must be led by an orchestrator bit (both sides are).
    return [...ids].map((id) => map.get(id)).filter((other) => other && other.lead && isOrchestratorBit(lookupBit(memberOf(other, other.lead))))
  }

  function handoffTool(binding) {
    const targets = handoffTargets(binding.team)
    if (targets.length === 0) return null
    return {
      name: 'team_handoff',
      description: [
        'Pass this whole session to the lead of another team (a different flow). From the next step on, this session follows that team\'s persona, roster, flow and rules; keep going with the request.',
        'Use it when the request belongs to another team\'s flow, never to run one step and come back (use team_delegate for that).',
        'Teams:',
        ...targets.map((other) => `- ${other.id}: ${other.name} — ${String(other.description || '').slice(0, 160)}`),
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string', enum: targets.map((other) => other.id), description: 'Target team id.' },
          request: { type: 'string', description: 'The developer request (literal) plus what is already known (card number, type, links, decisions).' },
        },
        required: ['team', 'request'],
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
        const current = resolve(agent)
        if (!current || current.role !== 'lead' || current.child) throw new Error('team_handoff é só do líder da sessão principal.')
        const target = handoffTargets(current.team).find((other) => other.id === args.team)
        if (!target) throw new Error(`Time "${args.team}" não é alcançável a partir de ${current.team.name}.`)
        await bindings.set(current.sessionId, { teamId: target.id, role: 'lead', parentSession: null })
        // New team: new persona, roster, tools and skills from the next step on.
        reinstall(agent)
        invalidateSkills()
        const lead = memberOf(target, target.lead)
        return [
          `Sessão passada ao time «${target.name}». A partir de agora você é ${lead ? `**${memberNameOf(lead)}** (\`${lead.id}\`)` : 'o líder'} desse time: siga o fluxo e as skills dele.`,
          `Pedido: ${String(args.request || '').trim()}`,
        ].join('\n')
      },
    }
  }

  /* ------------------------------- install -------------------------------- */

  /** Names a restriction may mask for this agent (inherited global tools). */
  function restrictableNames(agent) {
    const tools = agent.ctx.tools
    try {
      if (typeof tools.view === 'function') return [...tools.view(agent).restrictableNames]
    } catch {
      // Fall back to the visible schemas.
    }
    try {
      return tools.schemas(agent).map((schema) => schema && schema.name).filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * Hide every tool the team role does not allow (allow-list). One batched
   * restriction when possible; per-name otherwise, so a single scope-local
   * name cannot void the whole mask. Tools that stay visible are still denied
   * at execution by the pre-execute policy.
   */
  function restrictTools(agent, binding, entry) {
    const role = roleOf(binding)
    const deny = restrictableNames(agent).filter((name) => name !== 'run_code' && !teamToolAllowed(name, role))
    if (deny.length === 0) return
    try {
      entry.disposers.push(agent.ctx.tools.restrict({ deny }))
      return
    } catch (error) {
      log(`batched tool restriction for ${agent.id} failed, retrying per tool: ${messageOf(error)}`)
    }
    const failed = []
    for (const name of deny) {
      try {
        entry.disposers.push(agent.ctx.tools.restrict({ deny: [name] }))
      } catch {
        failed.push(name)
      }
    }
    if (failed.length > 0) log(`tools not maskable for ${agent.id} (denied at execution): ${failed.join(', ')}`)
  }

  let mcpModule = null
  let mcpModuleError = null
  async function mcpClient() {
    if (mcpModule || mcpModuleError) return mcpModule
    const dir = findDshPackage('@deepseek-ai/dsh-mcp-client')
    if (!dir) {
      mcpModuleError = 'dsh-mcp-client not found'
      return null
    }
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
      const entry = typeof pkg.exports === 'string' ? pkg.exports : (pkg.exports && (pkg.exports['.']?.import || pkg.exports['.']?.default || pkg.exports['.'])) || pkg.main || 'lib/index.js'
      mcpModule = await import(pathToFileURL(path.join(dir, typeof entry === 'string' ? entry : 'lib/index.js')).href)
    } catch (error) {
      mcpModuleError = messageOf(error)
      noteError(`MCP client unavailable: ${mcpModuleError}`)
    }
    return mcpModule
  }

  async function mountMcp(agent, binding, entry) {
    const names = binding.member && Array.isArray(binding.member.mcp) ? binding.member.mcp : []
    if (names.length === 0) return
    const packData = loadPack(binding.team.harness)
    const servers = packData && packData.pack && packData.pack.mcp ? packData.pack.mcp : {}
    const McpClient = await mcpClient()
    if (!McpClient) return
    for (const name of names) {
      const server = servers[name]
      if (!server) continue
      const serverName = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
      let config
      try {
        if (server.type === 'http' || server.url) {
          config = McpClient.Config({ transport: 'streamable-http', serverName, url: server.url, headers: server.headers || {} })
        } else {
          config = McpClient.Config({ transport: 'stdio', serverName, command: server.command, args: server.args || [], env: server.env || {}, cwd: sessionCwd(agent) || binding.team.workspaceDir || '' })
        }
        const fiber = agent.ctx.plugin(McpClient, config)
        entry.disposers.push(() => {
          try { fiber.dispose() } catch { /* already disposed */ }
        })
        entry.mcp.push(serverName)
      } catch (error) {
        noteError(`MCP ${name} for ${binding.member.id} failed: ${messageOf(error)}`)
      }
    }
  }

  function installGitHooks(binding) {
    const packData = loadPack(binding.team.harness)
    const workspace = binding.team.workspaceDir
    if (!packData || !packData.pack.hooks || !packData.pack.hooks.gitInstaller || !workspace) return
    const key = `${packData.pack.id}:${workspace}`
    if (hooksInstalled.has(key)) return
    hooksInstalled.add(key)
    const script = path.join(packData.pack.packDir, packData.pack.hooks.gitInstaller)
    const env = { ...process.env, DSH_HARNESS_PACK_ROOT: packData.pack.packDir }
    if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    execFile(process.execPath, [script, '--auto', '--dir', workspace], { cwd: workspace, env, timeout: 60000 }, (error, stdout, stderr) => {
      if (error) noteError(`git hooks install (${workspace}) failed: ${messageOf(error)} ${String(stderr).slice(0, 300)}`)
      else log(`git hooks of pack ${packData.pack.id} checked for ${workspace}: ${String(stdout || stderr).trim().slice(0, 200)}`)
    })
  }

  async function install(agent) {
    if (disposed || !agent || installed.has(agent)) return
    const binding = resolve(agent)
    if (!binding) return
    const entry = { key: bindingKey(binding), disposers: [], sent: new Set(), mcp: [], role: binding.role, teamId: binding.team.id, memberId: binding.member ? binding.member.id : null, bitId: binding.member && binding.member.bitId ? binding.member.bitId : null }
    installed.set(agent, entry)
    try {
      entry.disposers.push(agent.ctx.systemPrompt.section({
        name: 'bits:team',
        order: TEAM_SECTION_ORDER,
        interpolate: false,
        text: () => promptFor(agent),
      }))
    } catch (error) {
      noteError(`team prompt for ${agent.id} failed: ${messageOf(error)}`)
    }
    restrictTools(agent, binding, entry)
    for (const definition of [delegateTool(binding), binding.role === 'lead' && !binding.child ? handoffTool(binding) : null]) {
      if (!definition) continue
      try {
        entry.disposers.push(agent.ctx.tools.register(definition))
      } catch (error) {
        noteError(`${definition.name} for ${agent.id} failed: ${messageOf(error)}`)
      }
    }
    if (binding.role === 'lead' && !binding.child) installGitHooks(binding)
    try {
      await mountMcp(agent, binding, entry)
    } catch (error) {
      noteError(`MCP mount for ${agent.id} failed: ${messageOf(error)}`)
    }
    log(`team ${binding.team.name}: agent ${agent.id} as ${binding.role}${binding.member ? ` ${binding.member.id}` : ''}${binding.child ? ' (child)' : ''}`)
  }

  function uninstall(agent) {
    const entry = installed.get(agent)
    if (!entry) return
    installed.delete(agent)
    for (const dispose of entry.disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        log(`team disposer failed: ${messageOf(error)}`)
      }
    }
  }

  function reinstall(agent) {
    uninstall(agent)
    install(agent).catch((error) => noteError(`team reinstall failed: ${messageOf(error)}`))
  }

  /** Re-apply after team edits (roster, lead, launches…) for live agents of that team. */
  function refreshTeam(teamId) {
    let count = 0
    for (const [agent, entry] of [...installed]) {
      if (teamId && entry.teamId !== teamId) continue
      reinstall(agent)
      count += 1
    }
    // Agents that were not team agents may become one (bindWorkspace toggled).
    let agents = []
    try {
      agents = ctx.agents.list()
    } catch {
      agents = []
    }
    for (const agent of agents) if (!installed.has(agent)) install(agent).catch(() => {})
    invalidateSkills()
    return count
  }

  /* ------------------------------- missions ------------------------------- */

  function findTeam(ref) {
    const map = teamMap()
    if (map.has(ref)) return map.get(ref)
    const wanted = String(ref || '').trim().toLowerCase()
    return [...map.values()].find((team) => team.name.toLowerCase() === wanted)
      || [...map.values()].find((team) => team.name.toLowerCase().includes(wanted))
      || null
  }

  /**
   * Start a team session: a new root session in the team workspace, bound to
   * the team lead, with the request delivered as the first user message.
   *
   * @param {{ team: string, prompt: string, title?: string }} input team id or name
   * @returns {Promise<{ sessionId: string, teamId: string, teamName: string, cwd: string }>}
   */
  async function startMission({ team: ref, prompt, title }) {
    await ready
    const team = findTeam(ref)
    if (!team) throw Object.assign(new Error(`Time "${ref}" não encontrado.`), { code: 'TEAM_NOT_FOUND' })
    if (!team.lead) throw Object.assign(new Error(`O time ${team.name} não tem líder.`), { code: 'TEAM_NO_LEAD' })
    const leadMember = memberOf(team, team.lead)
    if (!leadMember) throw Object.assign(new Error(`O líder do time ${team.name} ("${team.lead}") não existe.`), { code: 'TEAM_NO_LEAD' })
    const leadBit = lookupBit(leadMember)
    if (!leadBit) throw codedError('TEAM_INVALID', `O bit do líder do time ${team.name} (bitId "${leadMember.bitId || '?'}") não existe mais.`)
    if (!isOrchestratorBit(leadBit)) throw codedError('TEAM_LEAD_NOT_ORCHESTRATOR', `O líder do time ${team.name} (${bitNameOf(leadBit, leadMember)}) precisa ser um bit orquestrador.`)
    if (!team.workspaceDir || !existsSync(team.workspaceDir)) throw Object.assign(new Error(`O time ${team.name} não tem um repositório ou pasta válido.`), { code: 'TEAM_NO_WORKSPACE' })
    const text = String(prompt || '').trim()
    if (!text) throw Object.assign(new Error('O pedido está vazio.'), { code: 'BAD_REQUEST' })
    const controller = ctx.get('sessionController')
    if (!controller) throw Object.assign(new Error('Este Harness não cria sessões por plugin (sem sessionController).'), { code: 'SESSIONS_UNAVAILABLE' })
    // The lead agent runs on the lead bit's DSH route (DeepSeek-V4.1-Flash Max
    // by default); fail before creating the session when the route is invalid.
    const leadRoute = await models.routeFor(leadBit)
    const sessionId = randomUUID()
    // Bind first: agent/created must already see the lead binding.
    await bindings.set(sessionId, { teamId: team.id, role: 'lead', parentSession: null })
    let agent
    try {
      await controller.create({ sessionId, cwd: team.workspaceDir })
      const resolved = await controller.resolveAgent(sessionId)
      if (resolved && resolved.error) throw resolved.error
      agent = resolved && resolved.agent
      if (!agent) throw new Error('session agent unavailable')
    } catch (error) {
      await bindings.delete(sessionId).catch(() => {})
      throw error
    }
    await install(agent)
    try {
      if (agent.model && typeof agent.model.select === 'function') agent.model.select(leadRoute)
    } catch (error) {
      noteError(`mission ${sessionId} lead route was not selected: ${messageOf(error)}`)
    }
    try {
      const registry = ctx.get('workspaceRegistry')
      let workspace = registry ? await registry.resolveByPath(team.workspaceDir) : null
      if (registry && !workspace) workspace = await registry.create(team.workspaceDir, team.name)
      if (workspace && typeof workspace.attachSession === 'function') await workspace.attachSession(sessionId)
    } catch (error) {
      noteError(`mission ${sessionId} did not join the workspace: ${messageOf(error)}`)
    }
    try {
      const titles = ctx.get('sessionTitle')
      if (titles) titles.rename(agent.session, String(title || `${team.emoji || '👥'} ${team.name}: ${text.replace(/\s+/g, ' ').slice(0, 60)}`).slice(0, 120))
    } catch (error) {
      noteError(`mission ${sessionId} was not named: ${messageOf(error)}`)
    }
    const message = Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: Object.freeze([Object.freeze({ type: 'text', text })]),
      source: Object.freeze({ kind: 'bits-team' }),
    })
    agent.followup(message)
    try {
      const sessions = ctx.get('sessions')
      if (sessions && typeof sessions.flush === 'function') await sessions.flush(agent.session)
    } catch (error) {
      noteError(`mission ${sessionId} flush failed: ${messageOf(error)}`)
    }
    log(`mission started: team ${team.name} session ${sessionId}`)
    return { sessionId, teamId: team.id, teamName: team.name, cwd: team.workspaceDir }
  }

  /**
   * Continue a team session (answer a PAUSA, add a request): the message is
   * delivered to the session's lead as a new user message.
   *
   * @param {{ sessionId: string, prompt: string }} input
   */
  async function continueMission({ sessionId, prompt }) {
    const text = String(prompt || '').trim()
    if (!text) throw Object.assign(new Error('A resposta está vazia.'), { code: 'BAD_REQUEST' })
    await ready
    const stored = bindings.get(String(sessionId || ''))
    if (!stored || stored.role !== 'lead' || stored.parentSession) {
      throw Object.assign(new Error(`A sessão ${sessionId} não é a sessão principal de um time.`), { code: 'TEAM_SESSION_NOT_FOUND' })
    }
    const controller = ctx.get('sessionController')
    if (!controller) throw Object.assign(new Error('Este Harness não retoma sessões por plugin (sem sessionController).'), { code: 'SESSIONS_UNAVAILABLE' })
    const resolved = await controller.resolveAgent(sessionId)
    if (resolved && resolved.error) throw resolved.error
    const agent = resolved && resolved.agent
    if (!agent) throw new Error('session agent unavailable')
    await install(agent)
    agent.followup(Object.freeze({
      id: randomUUID(),
      role: 'user',
      content: Object.freeze([Object.freeze({ type: 'text', text })]),
      source: Object.freeze({ kind: 'bits-team' }),
    }))
    const team = teamMap().get(stored.teamId)
    log(`mission continued: session ${sessionId} (${team ? team.name : stored.teamId})`)
    return { sessionId, teamId: stored.teamId, teamName: team ? team.name : stored.teamId }
  }

  /* -------------------------- request queue folder -------------------------- */

  // `<botsRoot>/team-inbox/*.json` with { team, request, title? } starts a mission
  // ({ session, request } continues one, e.g. the answer to a PAUSA);
  // the file moves to processed/ (with the session id) or failed/ (with the error).
  const inboxDir = path.join(botsRoot, 'team-inbox')
  let inboxBusy = false
  async function drainInbox() {
    if (disposed || inboxBusy) return
    inboxBusy = true
    try {
      await fsp.mkdir(path.join(inboxDir, 'processed'), { recursive: true, mode: 0o700 })
      await fsp.mkdir(path.join(inboxDir, 'failed'), { recursive: true, mode: 0o700 })
      const entries = (await fsp.readdir(inboxDir)).filter((name) => name.endsWith('.json')).sort()
      for (const name of entries) {
        const file = path.join(inboxDir, name)
        let outcome
        try {
          const request = JSON.parse(await fsp.readFile(file, 'utf8'))
          const started = request.session
            ? await continueMission({ sessionId: request.session, prompt: request.request })
            : await startMission({ team: request.team, prompt: request.request, title: request.title })
          outcome = { dir: 'processed', body: { ...request, ...started, startedAt: new Date().toISOString() } }
        } catch (error) {
          outcome = { dir: 'failed', body: { file: name, error: messageOf(error), failedAt: new Date().toISOString() } }
          noteError(`team inbox ${name}: ${messageOf(error)}`)
        }
        await fsp.writeFile(path.join(inboxDir, outcome.dir, name), JSON.stringify(outcome.body, null, 2) + '\n', { mode: 0o600 })
        await fsp.rm(file, { force: true })
      }
    } catch (error) {
      noteError(`team inbox scan failed: ${messageOf(error)}`)
    } finally {
      inboxBusy = false
    }
  }

  /* ---------------------------- global hooks ----------------------------- */

  const disposers = []

  ready.then(async () => {
    await fsp.mkdir(inboxDir, { recursive: true, mode: 0o700 }).catch(() => {})
    if (disposed) return
    let watcher = null
    try {
      watcher = fsWatch(inboxDir, () => { drainInbox() })
    } catch (error) {
      noteError(`team inbox watch failed: ${messageOf(error)}`)
    }
    const timer = setInterval(() => { drainInbox() }, 15000)
    if (typeof timer.unref === 'function') timer.unref()
    disposers.push(() => {
      clearInterval(timer)
      if (watcher) watcher.close()
    })
    drainInbox()
  }, () => {})

  // team_send: any conversation can hand a request (e.g. an AB) to a team.
  try {
    disposers.push(ctx.tools.register({
      name: 'team_send',
      description: [
        'Send a request (for example "implemente o AB 160047") to a team of bits: opens a new session in the team repository, led by the team lead, and starts it right away.',
        'Use only when the user asks to hand work to a team. Returns the new session id; the team works there on its own (PAUSA questions appear in that session).',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          team: { type: 'string', description: 'Team id or name (e.g. "DSC", "DSC · Implementação"). Ignored when `session` is given.' },
          request: { type: 'string', description: 'The request exactly as the user wants it delivered to the team lead (pt-BR).' },
          session: { type: 'string', description: 'Optional id of an existing team session to continue (for example the answer to a PAUSA) instead of opening a new one.' },
        },
        required: ['request'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render(_args, value) {
          return [{ type: 'text', text: String(value) }]
        },
      },
      async execute(args) {
        if (args.session) {
          const continued = await continueMission({ sessionId: args.session, prompt: args.request })
          return `Mensagem entregue à sessão ${continued.sessionId} do time «${continued.teamName}».`
        }
        if (!args.team) throw new Error('team_send: informe "team" (ou "session" para continuar uma sessão).')
        const started = await startMission({ team: args.team, prompt: args.request })
        return `Pedido entregue ao time «${started.teamName}». Sessão ${started.sessionId} aberta em ${started.cwd} (aparece na barra lateral, no workspace do repositório).`
      },
    }, {
      when: ({ agent }) => {
        if (!agent || resolve(agent)) return false
        for (const team of teamMap().values()) if (team.lead && team.workspaceDir) return true
        return false
      },
    }))
  } catch (error) {
    noteError(`team_send registration failed: ${messageOf(error)}`)
  }

  // Skills: the harness pack skills of the agent's team.
  function invalidateSkills() {
    try {
      if (skillControl) skillControl.invalidate()
    } catch {
      // Nothing cached yet.
    }
  }

  if (ctx.skills && typeof ctx.skills.registerProvider === 'function') {
    try {
      disposers.push(ctx.skills.registerProvider((control) => {
        skillControl = control
        return {
          name: SKILL_PROVIDER,
          async list(options = {}) {
            const agent = options.scope
            const binding = agent && agent.session ? resolve(agent) : null
            if (!binding) return []
            const packData = loadPack(binding.team.harness)
            if (!packData) return []
            const visible = Array.isArray(binding.team.skills) && binding.team.skills.length > 0 ? new Set(binding.team.skills) : null
            return packData.skills
              .filter((skill) => !visible || visible.has(skill.name))
              .map((skill) => ({
                name: skill.name,
                description: skill.description,
                invocation: { modelInvocable: true, userInvocable: true },
                source: 'custom',
                provider: SKILL_PROVIDER,
                path: skill.file,
                resourceBase: { kind: 'directory', path: skill.base },
                rank: 150,
                locator: skill.file,
              }))
          },
          async get(candidate) {
            let content = ''
            try {
              content = stripFrontmatter(readFileSync(String(candidate.locator), 'utf8'))
            } catch (error) {
              return undefined
            }
            const { rank, locator, metadata, ...summary } = candidate
            return { ...summary, content }
          },
        }
      }))
    } catch (error) {
      noteError(`skill provider registration failed: ${messageOf(error)}`)
    }
  }

  // Shell variables for the harness scripts.
  if (ctx.shellEnv && typeof ctx.shellEnv.register === 'function') {
    try {
      disposers.push(ctx.shellEnv.register({
        name: 'dsh-bits-teams',
        variables: {
          DSH_HARNESS_PACK_ROOT: { description: 'Directory of the harness pack carried by the team (scripts, skills, hooks).' },
          DSH_TEAM_ID: { description: 'Id of the team this agent belongs to.' },
          DSH_TEAM_MEMBER: { description: 'Member id of this agent in its team (the lead for the main session).' },
        },
        resolve(exec) {
          const binding = exec && exec.agent ? resolve(exec.agent) : null
          if (!binding) return {}
          const packData = loadPack(binding.team.harness)
          const out = { DSH_TEAM_ID: binding.team.id }
          if (binding.member) out.DSH_TEAM_MEMBER = binding.member.id
          if (packData) out.DSH_HARNESS_PACK_ROOT = packData.pack.packDir
          return out
        },
      }))
    } catch (error) {
      noteError(`shell env registration failed: ${messageOf(error)}`)
    }
  }

  // Guard: native lead policy + the harness pack guard, for team agents only.
  try {
    disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
      const agent = exec.agent
      if (!agent) return next()
      const binding = resolve(agent)
      if (!binding) return next()
      const role = roleOf(binding)
      if (!teamToolAllowed(exec.name, role)) {
        const label = binding.member ? memberNameOf(binding.member) : 'o líder'
        return {
          kind: 'deny',
          reason: role.orchestrator
            ? `Regra do time: ${label} só orquestra. Delegue a etapa a um bit com team_delegate.`
            : role.readOnly && ['write', 'edit', 'apply_patch', 'str_replace_editor'].includes(exec.name)
              ? `Regra do repositório: ${label} é um bit somente leitura e não edita arquivos. Devolva a edição a quem chamou.`
              : `Regra do time: a ferramenta ${exec.name} não faz parte do bit ${binding.member ? binding.member.id : ''}. Devolva a etapa a quem chamou se ela exigir outra ferramenta.`,
        }
      }
      if (UNGUARDED_TOOLS.has(exec.name)) return next()
      const packData = loadPack(binding.team.harness)
      if (role.orchestrator) {
        if (exec.name === 'read') {
          const file = exec.arguments && exec.arguments.file_path
          const absolute = typeof file === 'string' ? path.resolve(sessionCwd(agent) || '/', file) : ''
          if (!leadMayRead(absolute, { packDir: packData ? packData.pack.packDir : null, dataDir: botsRoot })) {
            return { kind: 'deny', reason: 'Regra do time: o líder só lê o pacote do harness e arquivos .dsc/ (contexto, validação). Leitura de código, card, logs ou web vai a um bit (team_delegate).' }
          }
        }
      }
      if (packData && packData.pack.hooks && packData.pack.hooks.guard) {
        const event = guardEvent(exec, {
          sessionId: binding.sessionId,
          cwd: sessionCwd(agent) || binding.team.workspaceDir || process.cwd(),
          agentType: binding.member ? binding.member.id : 'lead',
        })
        const result = await runGuard({
          guardPath: path.join(packData.pack.packDir, packData.pack.hooks.guard),
          packDir: packData.pack.packDir,
          event,
          readOnly: role.readOnly,
          signal: exec.signal,
        })
        if (result.error && result.error !== 'aborted') noteError(`guard (${exec.name}) for ${binding.member ? binding.member.id : 'lead'}: ${result.error}`)
        if (result.decision === 'deny') return { kind: 'deny', reason: result.reason }
      }
      return next()
    }, { prepend: true }))
  } catch (error) {
    noteError(`pre-execute hook registration failed: ${messageOf(error)}`)
  }

  // applyTo: attach matching instructions after read/write/edit, once per agent.
  try {
    disposers.push(ctx.on('tools/post-execute', async (exec, result, next) => {
      const downstream = await next()
      const agent = exec.agent
      if (!agent || !['read', 'write', 'edit'].includes(exec.name) || (result && result.isError)) return downstream
      const entry = installed.get(agent)
      const binding = entry ? resolve(agent) : null
      if (!binding) return downstream
      const packData = loadPack(binding.team.harness)
      if (!packData || packData.instructions.length === 0) return downstream
      const file = exec.arguments && exec.arguments.file_path
      if (typeof file !== 'string') return downstream
      const absolute = path.resolve(sessionCwd(agent) || '/', file).split(path.sep).join('/')
      const hits = packData.instructions.filter((item) => !entry.sent.has(item.name) && item.applyTo.some((glob) => {
        try {
          return path.matchesGlob(absolute, glob)
        } catch {
          return false
        }
      }))
      if (hits.length === 0) return downstream
      hits.forEach((item) => entry.sent.add(item.name))
      const message = Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `<system-reminder>\nInstruções do harness para arquivos como \`${file}\`:\n\n${hits.map((item) => `### ${item.name} (${item.applyTo.join(', ')})\n\n${item.body}`).join('\n\n')}\n</system-reminder>` }],
        source: { kind: 'bits-team-instructions', form: 'notice', summary: hits.map((item) => item.name).join(', ') },
      })
      return { ...downstream, additionalContexts: [...(downstream.additionalContexts || []), message] }
    }))
  } catch (error) {
    noteError(`post-execute hook registration failed: ${messageOf(error)}`)
  }

  disposers.push(ctx.on('agent/created', async ({ agent }) => {
    try {
      await ready
    } catch (error) {
      noteError(`team runtime not ready: ${messageOf(error)}`)
      return
    }
    try {
      await install(agent)
    } catch (error) {
      noteError(`team install failed for ${agent && agent.id}: ${messageOf(error)}`)
    }
  }))
  disposers.push(ctx.on('agent/disposed', ({ agent }) => uninstall(agent)))

  ready.then(() => {
    let agents = []
    try {
      agents = ctx.agents.list()
    } catch {
      agents = []
    }
    for (const agent of agents) install(agent).catch((error) => noteError(`team install failed: ${messageOf(error)}`))
  }, (error) => noteError(`team runtime init failed: ${messageOf(error)}`))

  return {
    ready,
    bindings,
    refreshTeam,
    startMission,
    continueMission,
    invalidateSkills,
    resolveSession(sessionId) {
      let agent = null
      try {
        agent = ctx.agents.get(sessionId)
      } catch {
        agent = null
      }
      return agent ? resolve(agent) : null
    },
    diagnostics() {
      const agents = []
      for (const [agent, entry] of installed) {
        agents.push({ sessionId: agent.id, teamId: entry.teamId, memberId: entry.memberId, bitId: entry.bitId, role: entry.role, mcp: entry.mcp, cwd: sessionCwd(agent) || null })
      }
      return { agents, errors: [...errors], mcpClient: mcpModule ? 'loaded' : mcpModuleError, packsRoot }
    },
    dispose() {
      disposed = true
      for (const agent of [...installed.keys()]) uninstall(agent)
      for (const dispose of disposers.reverse()) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (error) {
          log(`team runtime disposer failed: ${messageOf(error)}`)
        }
      }
    },
  }
}

export { readPack }
