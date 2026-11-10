/**
 * Request → response runtime for one bit (v5).
 *
 * A bit is a definition: `instructions` (its context), `isOrchestrator`, a
 * model and an effort. This module performs the invocation:
 *
 * - **Worker with a subscription model** (`backend: 'claude-code'`): calls the
 *   registered `claude_delegate` tool of `@dsh-burn-plugins/dsh-claude-delegate` through
 *   the host tool pipeline — one unattended Claude Code run, with the worker's
 *   cwd and `readOnly` when the member access is `read`. The tool returns only
 *   its final answer string.
 * - **Worker with a DSH chat route** (`backend: 'dsh'`): one-shot
 *   `ctx.llm.stream` call (no tools); the response is the concatenated text.
 * - **Ad-hoc run** (`runBit`): the “Run” path of the Bits page; workers
 *   only (orchestrators execute inside flows), read-only by default.
 *
 * Errors are coded (`BIT_MODEL_*`, `BIT_IS_ORCHESTRATOR`, `BIT_DELEGATE_UNAVAILABLE`,
 * `BIT_MODEL_CALL_FAILED`) and model/route-visible.
 *
 * @module host/bit-runtime
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** Appended when the bit has no instructions of its own. */
const REPORT_INSTRUCTION = 'At the end, respond with an objective report of what was done: outcome, files changed and pending items.'
/** Request limit for ad-hoc runs (`POST /api/bots.run`). */
const MAX_REQUEST_CHARS = 20000

function codedError(code, message) {
  return Object.assign(new Error(message), { code })
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function isAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value)
}

function isInside(root, target) {
  if (!isAbsolutePath(root) || !isAbsolutePath(target)) return false
  const a = path.resolve(root)
  const b = path.resolve(target)
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep)
}

function nameOf(bit) {
  const name = bit && typeof bit.name === 'string' ? bit.name.trim() : ''
  return name !== '' ? name : (bit && typeof bit.id === 'string' ? bit.id : 'bit')
}

/**
 * Compose the prompt of one invocation: the bit instructions, a separator and
 * the request/task. A bit without instructions still asks for a report.
 *
 * @param {any} bit bit record.
 * @param {string} input request (ad-hoc) or task (delegation).
 * @returns {string}
 */
export function composePrompt(bit, input) {
  const instructions = bit && typeof bit.instructions === 'string' ? bit.instructions.trim() : ''
  const body = String(input === undefined || input === null ? '' : input).trim()
  if (instructions === '') {
    if (body === '') return REPORT_INSTRUCTION
    return `${body}\n\n---\n\n${REPORT_INSTRUCTION}`
  }
  if (body === '') return instructions
  return `${instructions}\n\n---\n\n${body}`
}

/** Human/model-facing model identifier of a resolved model. */
function modelIdOf(resolved) {
  return resolved.backend === 'claude-code' ? `subscription/${resolved.alias}` : `${resolved.provider}/${resolved.model}`
}

/** The route text of a resolved model: `<backend>/<model>`. */
export function routeLabelOf(meta) {
  const backend = meta && meta.backend === 'claude-code' ? 'subscription' : 'dsh'
  return `${backend}/${meta && typeof meta.model === 'string' ? meta.model.replace(/^subscription\//, '').replace(/^dsh\//, '') : '?'}`
}

/**
 * Classify one `finish` chunk reason. The contract asks for `kind === 'success'`;
 * the DSH runtime installed here (`dsh-llm@0.2.2-rc.1`) reports a successful
 * stop as `{ kind: 'stop' }`, so both count as success. Everything else
 * (`error`, `aborted`, `max-tokens`, `tool-calls`, unknown) is a failed call.
 *
 * @param {{ kind?: string, failure?: { message?: string, code?: string } }} [reason]
 * @returns {Error | null} coded error, or null on success.
 */
function finishFailure(reason) {
  const kind = reason && typeof reason.kind === 'string' ? reason.kind : ''
  if (kind === 'success' || kind === 'stop') return null
  const failure = reason && reason.failure && typeof reason.failure === 'object' ? reason.failure : {}
  const detail = typeof failure.message === 'string' && failure.message !== '' ? failure.message : String(kind || 'no reason')
  const code = typeof failure.code === 'string' && failure.code !== '' ? ` (${failure.code})` : ''
  return codedError('BIT_MODEL_CALL_FAILED', `The model call failed${code}: ${detail}`)
}

/** Tiny async-iterable reader used by the DSH one-shot call. */
async function readTextStream(chunks) {
  const parts = []
  for await (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') {
      if (typeof chunk.text === 'string') parts.push(chunk.text)
      continue
    }
    if (chunk.type === 'finish') {
      const failure = finishFailure(chunk.reason)
      if (failure) throw failure
    }
  }
  return { text: parts.join('') }
}

/**
 * Build the bit runtime for one host context.
 *
 * @param {any} ctx host context (`ctx.tools`, `ctx.llm`, `ctx.workingDirectory`).
 * @param {{ bits?: any, catalog?: any, models: any, log?: (message: string) => void }} deps
 */
export function createBitRuntime(ctx, deps = {}) {
  const { bits = null, models, log = () => {} } = deps || {}
  if (!models || typeof models.resolve !== 'function') throw new TypeError('createBitRuntime: deps.models (createModelCatalog) is required')

  function warn(message) {
    try {
      log(message)
    } catch {
      // Logging must never break an invocation.
    }
  }

  /* --------------------------- invocation backends --------------------------- */

  /** Call the registered claude_delegate tool and return its answer text. */
  async function runSubscription(bit, prompt, resolved, { cwd, readOnly, signal }) {
    const tools = ctx && ctx.tools
    if (!tools || typeof tools.execute !== 'function') {
      throw codedError('BIT_DELEGATE_UNAVAILABLE', 'The claude_delegate tool is not available in this Harness: install/enable the @dsh-burn-plugins/dsh-claude-delegate plugin in the profile and log in with `claude`.')
    }
    const args = { task: prompt, model: resolved.alias }
    if (resolved.effort !== undefined) args.effort = resolved.effort
    if (typeof cwd === 'string' && cwd !== '') args.cwd = cwd
    args.readOnly = readOnly === true
    const call = { id: `claude-delegate-${randomUUID()}`, name: 'claude_delegate', arguments: JSON.stringify(args) }
    let settled
    try {
      settled = await tools.execute({ calls: [call], signal })
    } catch (error) {
      if (signal && signal.aborted) throw codedError('ABORTED', 'Execution cancelled.')
      throw codedError('BIT_DELEGATE_UNAVAILABLE', `The claude_delegate tool is not available: ${messageOf(error)}. Install/enable the @dsh-burn-plugins/dsh-claude-delegate plugin in the profile and log in with \`claude\`.`)
    }
    const entries = settled && Array.isArray(settled.results) ? settled.results : []
    const entry = entries.find((item) => item && item.callId === call.id) || entries[0] || null
    const result = entry ? entry.result : null
    if (!result || result.isError === true || result.value === undefined) {
      if (signal && signal.aborted) throw codedError('ABORTED', 'Execution cancelled.')
      const detail = result && result.error && typeof result.error.message === 'string' ? result.error.message : ''
      const code = result && result.error && result.error.info && typeof result.error.info.code === 'string' ? result.error.info.code : ''
      throw codedError('BIT_DELEGATE_UNAVAILABLE', `The claude_delegate tool failed${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}. Install/enable the @dsh-burn-plugins/dsh-claude-delegate plugin in the profile and log in with \`claude\`.`)
    }
    return typeof result.value === 'string' ? result.value : String(result.value)
  }

  /** One-shot DSH chat model call (no tools); returns the response text. */
  async function runDsh(bit, prompt, resolved, { signal }) {
    const llm = ctx && ctx.llm
    if (!llm || typeof llm.stream !== 'function') {
      throw codedError('BIT_MODEL_CALL_FAILED', 'This Harness has no model service (ctx.llm): it is not possible to run the bit with a DSH chat route.')
    }
    const options = {
      provider: resolved.provider,
      model: resolved.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      signal,
    }
    if (resolved.effort !== undefined) options.reasoningEffort = resolved.effort
    let stream
    try {
      stream = llm.stream(options)
      if (stream && typeof stream.then === 'function') stream = await stream
    } catch (error) {
      if (signal && signal.aborted) throw codedError('ABORTED', 'Execution cancelled.')
      throw codedError('BIT_MODEL_CALL_FAILED', `Could not call ${resolved.provider}/${resolved.model} for bit "${nameOf(bit)}": ${messageOf(error)}`)
    }
    try {
      const { text } = await readTextStream(stream)
      return text
    } catch (error) {
      // A terminal `finish` failure is already the coded error the contract asks for.
      if (error && error.code === 'BIT_MODEL_CALL_FAILED') throw error
      if (signal && signal.aborted) throw codedError('ABORTED', 'Execution cancelled.')
      throw codedError('BIT_MODEL_CALL_FAILED', `The call to ${resolved.provider}/${resolved.model} for bit "${nameOf(bit)}" failed: ${messageOf(error)}`)
    }
  }

  /** Run one resolved invocation and return `{ text, meta }`. */
  async function invoke(bit, prompt, { cwd, readOnly, signal }) {
    const resolved = await models.resolve(bit)
    const startedAt = Date.now()
    let text
    if (resolved.backend === 'claude-code') {
      text = await runSubscription(bit, prompt, resolved, { cwd, readOnly, signal })
    } else {
      text = await runDsh(bit, prompt, resolved, { signal })
    }
    const meta = {
      backend: resolved.backend,
      model: modelIdOf(resolved),
      effort: resolved.effort !== undefined ? resolved.effort : null,
      durationMs: Date.now() - startedAt,
    }
    return { text, meta }
  }

  /* ------------------------------- public API ------------------------------- */

  /** Model catalog for the Bits editor (`GET /api/bots.models`). */
  async function listModels() {
    return models.list()
  }

  /**
   * Ad-hoc invocation of a worker bit (Bits page → Run).
   *
   * @param {{ bit: any, request: string, readOnly?: boolean, cwd?: string, signal?: AbortSignal }} input
   * @returns {Promise<{ response: string, meta: any }>}
   */
  async function runBit({ bit, request, readOnly, cwd, signal } = {}) {
    if (!bit || typeof bit !== 'object') throw codedError('BOT_NOT_FOUND', 'Bit not found.')
    if (bit.isOrchestrator === true) throw codedError('BIT_IS_ORCHESTRATOR', `Bit "${nameOf(bit)}" is an orchestrator: orchestrators run in flows (Teams tab), not in ad-hoc runs.`)
    const input = String(request === undefined || request === null ? '' : request).trim()
    if (input.length < 1 || input.length > MAX_REQUEST_CHARS) throw codedError('BOT_INVALID', `request: the request must be between 1 and ${MAX_REQUEST_CHARS} characters.`)
    // The bit workspace is the run cwd; a different cwd is only accepted inside it.
    let workspaceDir = typeof bit.workspaceDir === 'string' && bit.workspaceDir !== '' ? bit.workspaceDir : ''
    if (bits && typeof bits.ensureWorkspace === 'function') {
      try {
        const ensured = await bits.ensureWorkspace(bit)
        if (typeof ensured === 'string' && ensured !== '') workspaceDir = ensured
      } catch (error) {
        warn(`bit ${bit.id}: workspace unavailable: ${messageOf(error)}`)
      }
    }
    let effectiveCwd = workspaceDir
    if (cwd !== undefined && cwd !== null && String(cwd).trim() !== '') {
      const requested = String(cwd).trim()
      if (!isAbsolutePath(requested)) throw codedError('BOT_INVALID', 'cwd: the directory must be absolute.')
      if (workspaceDir !== '' && !isInside(workspaceDir, requested)) throw codedError('BOT_INVALID', 'cwd: the directory must be inside the bit workspace.')
      effectiveCwd = requested
    }
    const prompt = composePrompt(bit, input)
    const { text, meta } = await invoke(bit, prompt, {
      cwd: effectiveCwd !== '' ? effectiveCwd : undefined,
      readOnly: readOnly !== false,
      signal,
    })
    return { response: text, meta }
  }

  /**
   * Team-delegation invocation of a worker bit (called by `host/team-runtime`):
   * one-shot, read-only when the member access is `read`, cwd resolved by the
   * team runtime (caller session cwd inside the team workspace, else the
   * team workspace).
   *
   * @param {{ bit: any, task: string, cwd?: string, readOnly?: boolean, signal?: AbortSignal }} input
   * @returns {Promise<{ text: string, meta: any }>}
   */
  async function invokeWorker({ bit, task, cwd, readOnly, signal } = {}) {
    if (!bit || typeof bit !== 'object') throw codedError('BOT_NOT_FOUND', 'Bit not found.')
    if (bit.isOrchestrator === true) throw codedError('BIT_IS_ORCHESTRATOR', `Bit "${nameOf(bit)}" is an orchestrator: orchestrator agents run as child agents, not as a one-shot invocation.`)
    const input = String(task === undefined || task === null ? '' : task).trim()
    if (input === '') throw codedError('BAD_REQUEST', 'team_delegate: the bit task must be self-contained and cannot be empty.')
    const prompt = composePrompt(bit, input)
    return invoke(bit, prompt, {
      cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined,
      readOnly: readOnly === true,
      signal,
    })
  }

  return { listModels, runBit, invokeWorker }
}
