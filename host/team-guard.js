/**
 * Team guard: runs the harness pack's own PreToolUse guard (e.g. DSC
 * `git-guard.cjs`) for every tool call of a team agent, in the Claude Code
 * hook format it already understands, plus the native team policies (the
 * lead only orchestrates).
 *
 * @module host/team-guard
 */

import { spawn } from 'node:child_process'
import path from 'node:path'

/** DSH tool → Claude Code tool name and input mapping. */
export function toClaudeTool(name, args) {
  const input = args && typeof args === 'object' ? args : {}
  switch (name) {
    case 'bash':
    case 'bash_persistent':
      return { tool: 'Bash', input: { command: String(input.command ?? '') } }
    case 'pwsh':
    case 'pwsh_persistent':
      return { tool: 'PowerShell', input: { command: String(input.command ?? '') } }
    case 'read':
      return { tool: 'Read', input: { file_path: input.file_path } }
    case 'write':
      return { tool: 'Write', input: { file_path: input.file_path, content: typeof input.content === 'string' ? input.content.slice(0, 20000) : '' } }
    case 'edit':
      return { tool: 'Edit', input: { file_path: input.file_path, old_string: input.old_string, new_string: input.new_string } }
    case 'glob':
      return { tool: 'Glob', input: { pattern: input.pattern, path: input.path } }
    case 'grep':
      return { tool: 'Grep', input: { pattern: input.pattern, path: input.path, glob: input.include } }
    case 'web_fetch':
      return { tool: 'WebFetch', input: { url: input.url } }
    case 'web_search':
      return { tool: 'WebSearch', input: { query: Array.isArray(input.queries) ? input.queries.join(' | ') : String(input.query ?? '') } }
    default:
      return { tool: name, input }
  }
}

/** Tools that never touch the repository: skip the subprocess. */
export const UNGUARDED_TOOLS = new Set([
  'skill', 'todo_write', 'team_delegate', 'team_handoff', 'ask_user_question', 'present', 'working_directory',
  'get_goal', 'create_goal', 'update_goal', 'job_list', 'job_output', 'job_kill', 'list_agents', 'send_message', 'wait_agent',
  'structured_output', 'list_subagent_models',
])

/** Node runner for the guard subprocess (the host may be Electron-as-Node). */
function nodeRunner() {
  const env = {}
  if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return { command: process.execPath, env }
}

/**
 * Run the pack guard once.
 *
 * @param {{ guardPath: string, packDir: string, event: Record<string, any>, readOnly?: boolean, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<{ decision: 'deny' | 'none', reason: string | null, error: string | null }>}
 */
export function runGuard({ guardPath, packDir, event, readOnly = false, timeoutMs = 10000, signal }) {
  return new Promise((resolve) => {
    const runner = nodeRunner()
    const args = [guardPath]
    if (readOnly) args.push('--read-only')
    let child
    try {
      child = spawn(runner.command, args, {
        cwd: typeof event.cwd === 'string' && path.isAbsolute(event.cwd) ? event.cwd : undefined,
        env: { ...process.env, ...runner.env, DSH_HARNESS_PACK_ROOT: packDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ decision: 'none', reason: null, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ decision: 'none', reason: null, error: 'aborted' })
    }
    // Same contract as the Copilot hook: a timeout lets the call through.
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ decision: 'none', reason: null, error: `guard timed out after ${timeoutMs} ms` })
    }, timeoutMs)
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (chunk) => { if (stdout.length < 65536) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < 65536) stderr += chunk })
    child.on('error', (error) => finish({ decision: 'none', reason: null, error: error.message }))
    child.on('close', (code) => {
      let parsed = null
      try {
        parsed = JSON.parse(stdout.trim() || '{}')
      } catch {
        parsed = null
      }
      const decision = parsed && (parsed.permissionDecision || (parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecision))
      if (code === 2 || decision === 'deny') {
        const reason = (parsed && (parsed.permissionDecisionReason || (parsed.hookSpecificOutput && parsed.hookSpecificOutput.permissionDecisionReason))) || stderr.trim() || 'Negado pelo guarda do harness.'
        finish({ decision: 'deny', reason, error: null })
        return
      }
      finish({ decision: 'none', reason: null, error: code === 0 ? null : `guard exited ${code}: ${stderr.trim().slice(0, 300)}` })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(event))
  })
}

/**
 * Build the Claude Code PreToolUse event for one DSH tool execution.
 *
 * @param {{ name: string, arguments: any }} exec
 * @param {{ sessionId: string, cwd: string, agentType: string }} context
 * @returns {Record<string, any>}
 */
export function guardEvent(exec, { sessionId, cwd, agentType }) {
  const mapped = toClaudeTool(exec.name, exec.arguments)
  const workdir = exec.arguments && typeof exec.arguments.workdir === 'string' && path.isAbsolute(exec.arguments.workdir)
    ? exec.arguments.workdir
    : cwd
  return {
    session_id: sessionId,
    transcript_path: '',
    hook_event_name: 'PreToolUse',
    tool_name: mapped.tool,
    tool_input: mapped.input,
    cwd: workdir,
    agent_type: agentType,
  }
}

/** Tools hidden from the lead (it only orchestrates). */
export const LEAD_HIDDEN_TOOLS = [
  'bash', 'bash_persistent', 'pwsh', 'pwsh_persistent', 'terminal', 'write', 'edit', 'apply_patch', 'str_replace_editor',
  'glob', 'grep', 'web_fetch', 'web_search', 'subagent', 'subagent_fork', 'workflow', 'spawn_teammate', 'run_code',
]

/** Built-in delegation tools hidden from every team agent (they use team_delegate). */
export const TEAM_HIDDEN_TOOLS = ['subagent', 'subagent_fork', 'spawn_teammate', 'workflow']

/** Write tools hidden from read-only members. */
export const READ_ONLY_HIDDEN_TOOLS = ['write', 'edit', 'apply_patch', 'str_replace_editor']

/**
 * Allow-lists (the Copilot harness gives each preset only its own tools; the
 * profile adds many more, such as Agent Teams, schedules, plugin manager and
 * goals, that a team agent must not see).
 */
export const TEAM_TOOLS = new Set(['team_delegate', 'team_handoff'])

/** The orchestrating lead: talk to the dev, plan, read the pack and `.dsc/`, delegate. */
export const LEAD_ALLOWED_TOOLS = new Set(['read', 'skill', 'todo_write', 'ask_user_question', 'working_directory', 'structured_output'])

/** Members with write access (read-only members also lose READ_ONLY_HIDDEN_TOOLS). */
export const MEMBER_ALLOWED_TOOLS = new Set([
  'bash', 'bash_persistent', 'pwsh', 'pwsh_persistent', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'read', 'read_image', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'glob', 'grep',
  'web_fetch', 'web_search', 'skill', 'todo_write', 'job_list', 'job_output', 'job_kill', 'structured_output',
])

/**
 * Whether a team agent may see and call a tool.
 *
 * @param {string} name tool name
 * @param {{ orchestrator: boolean, readOnly: boolean, child?: boolean }} role
 */
export function teamToolAllowed(name, { orchestrator, readOnly, child = false }) {
  if (TEAM_TOOLS.has(name)) return true
  // Only the session the dev talks to asks; delegated agents return questions.
  if (child && name === 'ask_user_question') return false
  if (orchestrator) return LEAD_ALLOWED_TOOLS.has(name)
  if (name.startsWith('mcp__')) return true
  if (readOnly && READ_ONLY_HIDDEN_TOOLS.includes(name)) return false
  return MEMBER_ALLOWED_TOOLS.has(name)
}

/**
 * Native lead policy: which paths may the lead read.
 *
 * @param {string} file absolute path
 * @param {{ packDir: string | null, dataDir: string }} roots
 * @returns {boolean}
 */
export function leadMayRead(file, { packDir, dataDir }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false
  const norm = path.resolve(file)
  const within = (root) => !!root && (norm === root || norm.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
  if (within(packDir) || within(dataDir)) return true
  return norm.split(path.sep).includes('.dsc')
}
