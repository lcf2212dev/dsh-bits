/**
 * Docker VM manager for Bots.
 *
 * `BotVm` owns the persistent Linux container of one bot: it creates/starts/
 * stops the container, reports its live `VmStatus`, lists local images, and
 * executes shell commands inside it through `docker exec` with bounded
 * deadlines and capped output. Every Docker invocation is spawned with an argv
 * array (never through a shell), carries a bounded timeout, and can be aborted
 * through a caller `AbortSignal` or {@link BotVm#dispose}.
 *
 * Containers are labelled `dsh.bots.managed=true`, `dsh.bots.id=<id>` and
 * `dsh.bots.workspace=<workspaceDir>`, are named `dsh-bot-<id>`, run
 * `sleep infinity`, and bind-mount the bot workspace at the same absolute path
 * inside the container. There is no `--privileged` flag and the Docker socket
 * is never mounted.
 *
 * The module only uses Node.js built-ins and has no import-time side effects.
 *
 * @module @local/dsh-bots/host/vm
 */

import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

/** Container-name prefix for bot containers (`dsh-bot-<id>`). */
const CONTAINER_PREFIX = 'dsh-bot-'

/** Default Docker image proposed to new VMs. */
const DEFAULT_IMAGE = 'ubuntu:24.04'

/** Same image-reference grammar the bot store validates in CONTRACT.md §2. */
const IMAGE_REFERENCE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/

/** Bot ids are lowercase hex in the store; be a little lenient but Docker-name safe. */
const BOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** POSIX environment variable name. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Container labels (CONTRACT.md §2/§4). */
const LABEL_MANAGED = 'dsh.bots.managed'
const LABEL_ID = 'dsh.bots.id'
const LABEL_WORKSPACE = 'dsh.bots.workspace'

/** Appended to a stream that hit the per-stream output cap. */
const TRUNCATION_MARKER = '\n[truncated]'

/**
 * Model-friendly environment overrides (mirrors `@deepseek-ai/dsh-bash-local`):
 * no ANSI colors and no pagers in captured tool output. Caller entries win.
 */
const ENV_OVERRIDES = Object.freeze({
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
})

/** SIGTERM → SIGKILL escalation delay for a killed docker child (CONTRACT.md §4). */
const KILL_GRACE_MS = 2000

/** Last-resort deadline to give up on a SIGKILLed child (never leave a promise hanging). */
const ABANDON_GRACE_MS = 2000

/** Bounds for non-model-facing docker control commands. */
const DOCKER_VERSION_TIMEOUT_MS = 5000
const DOCKER_INSPECT_TIMEOUT_MS = 10000
const DOCKER_LIFECYCLE_TIMEOUT_MS = 30000
const DOCKER_PULL_TIMEOUT_MS = 600000
const SHELL_PROBE_TIMEOUT_MS = 10000

/** Output caps for control commands (must be generous enough for `docker images` JSON). */
const CONTROL_OUTPUT_CAP_BYTES = 1024 * 1024
const IMAGE_LIST_OUTPUT_CAP_BYTES = 8 * 1024 * 1024

/** Docker error fragments that mean "the container is not there". */
const NO_SUCH_CONTAINER_RE = /no such (?:container|object)/i

/** Docker error fragments that mean "the image is not there". */
const NO_SUCH_IMAGE_RE = /no such image|no such object/i

/** Docker states that map onto the first-class `VmStatus.state` values. */
const KNOWN_DOCKER_STATES = new Set([
  'running',
  'restarting',
  'paused',
  'created',
  'exited',
  'dead',
  'removing',
  'stopped',
])

/**
 * Create an `Error` carrying a stable machine-readable `code`.
 *
 * @param {string} code stable code (`VM_*`).
 * @param {string} message human-readable message.
 * @param {object} [extra] additional own properties (e.g. `{ image }`).
 * @returns {Error} coded error.
 */
function codeError(code, message, extra) {
  const error = new Error(message)
  error.code = code
  if (extra !== undefined) Object.assign(error, extra)
  return error
}

/**
 * Coerce any thrown value to an `Error`.
 *
 * @param {unknown} value thrown value.
 * @returns {Error} error instance.
 */
function asError(value) {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * First non-empty line of a text blob (Docker errors are multi-line).
 *
 * @param {unknown} value text.
 * @returns {string} trimmed first non-empty line, or `''`.
 */
function firstLine(value) {
  const text = typeof value === 'string' ? value : ''
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

/**
 * Last non-empty line of a text blob (Docker pull reports progress line by line).
 *
 * @param {unknown} value text.
 * @returns {string} trimmed last non-empty line, or `''`.
 */
function lastLine(value) {
  const text = typeof value === 'string' ? value : ''
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index].trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

/**
 * Normalize a Docker RFC3339Nano timestamp to a JS ISO string.
 * Docker reports the zero time (`0001-01-01T00:00:00Z`) for never-started containers.
 *
 * @param {unknown} value timestamp from `docker inspect`.
 * @returns {string | null} ISO timestamp or `null`.
 */
function toIsoOrNull(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.startsWith('0001-01-01')) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  const date = new Date(milliseconds)
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1) return null
  return date.toISOString()
}

/**
 * Project a Docker `.State` object onto the `VmStatus` fields of CONTRACT.md §2.
 *
 * @param {object | undefined} state `docker inspect … .State`.
 * @returns {{ state: string, running: boolean, startedAt: string | null, exitCode: number | null, detail: string | null, error: string | null }} status projection.
 */
function describeContainerState(state) {
  const raw = state !== null && typeof state === 'object' && typeof state.Status === 'string'
    ? state.Status.toLowerCase()
    : ''
  let mapped
  switch (raw) {
    case 'running':
    case 'restarting':
      mapped = 'running'
      break
    case 'paused':
      mapped = 'paused'
      break
    case 'created':
      mapped = 'created'
      break
    case 'exited':
    case 'dead':
      mapped = 'exited'
      break
    case 'removing':
      mapped = 'error'
      break
    case 'stopped':
      mapped = 'stopped'
      break
    default:
      mapped = state !== null && typeof state === 'object' && state.Running === true ? 'running' : 'error'
      break
  }

  const running = state !== null && typeof state === 'object' && state.Running === true
  const startedAt = toIsoOrNull(state !== null && typeof state === 'object' ? state.StartedAt : undefined)
  const exitCode = state !== null && typeof state === 'object' && Number.isInteger(state.ExitCode)
    ? state.ExitCode
    : null
  const dockerError = state !== null && typeof state === 'object' && typeof state.Error === 'string'
    ? state.Error.trim()
    : ''

  let detail = null
  if (dockerError.length > 0) detail = `${raw || 'container'}: ${firstLine(dockerError)}`
  else if (!KNOWN_DOCKER_STATES.has(raw) && raw.length > 0) detail = raw

  const error = mapped === 'error'
    ? (dockerError.length > 0
      ? firstLine(dockerError)
      : `unexpected docker container state "${raw || 'unknown'}"`)
    : null

  return { state: mapped, running, startedAt, exitCode, detail, error }
}

/**
 * Docker-backed VM manager for Bots.
 *
 * One instance manages every bot container created by the bundle. Containers
 * are addressed by the bot id (`record.id`) or the record itself; the name is
 * always `dsh-bot-<id>`.
 */
export class BotVm {
  /** @type {Set<{ child: import('node:child_process').ChildProcess, cancel: () => void, botId: string | null }>} */
  #active = new Set()

  /** Sticky disposal flag: once set, no Docker child may be spawned. */
  #disposed = false

  /** Bot ids whose VM must never be (re)created; used after bot deletion. @type {Set<string>} */
  #forgotten = new Set()

  /** @type {Map<string, '/bin/bash' | '/bin/sh'>} */
  #shellCache = new Map()

  /**
   * @param {object} [options] configuration.
   * @param {string} [options.dockerBin] Docker executable name or absolute path.
   * @param {string} [options.defaultImage] image used when a record does not name one.
   * @param {boolean} [options.pullMissingImage] reserved; ignored for now. `ensure()` never
   *   pulls implicitly — only {@link BotVm#pullImage} does (CONTRACT.md §4).
   * @param {number} [options.execTimeoutMs] default `exec()` deadline.
   * @param {number} [options.maxExecTimeoutMs] cap for per-call `exec()` deadlines.
   * @param {number} [options.maxOutputBytes] per-stream output cap for `exec()`.
   * @param {string | null} [options.network] optional `--network` for created containers.
   * @param {string[]} [options.extraRunArgs] extra `docker run` arguments prepended to the image.
   */
  constructor({
    dockerBin = 'docker',
    defaultImage = DEFAULT_IMAGE,
    pullMissingImage = false,
    execTimeoutMs = 120000,
    maxExecTimeoutMs = 600000,
    maxOutputBytes = 65536,
    network = null,
    extraRunArgs = [],
  } = {}) {
    if (typeof dockerBin !== 'string' || dockerBin.trim().length === 0) {
      throw new TypeError('BotVm: dockerBin must be a non-empty string')
    }
    if (typeof defaultImage !== 'string' || !IMAGE_REFERENCE_RE.test(defaultImage)) {
      throw new TypeError('BotVm: defaultImage must be a valid Docker image reference')
    }
    for (const [name, value] of [
      ['execTimeoutMs', execTimeoutMs],
      ['maxExecTimeoutMs', maxExecTimeoutMs],
      ['maxOutputBytes', maxOutputBytes],
    ]) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new TypeError(`BotVm: ${name} must be a positive finite number`)
      }
    }
    if (network !== null && (typeof network !== 'string' || network.trim().length === 0)) {
      throw new TypeError('BotVm: network must be null or a non-empty string')
    }
    if (!Array.isArray(extraRunArgs) || extraRunArgs.some((argument) => typeof argument !== 'string')) {
      throw new TypeError('BotVm: extraRunArgs must be an array of strings')
    }

    /** @type {string} Docker executable. */
    this.dockerBin = dockerBin.trim()
    /** @type {string} fallback image reference. */
    this.defaultImage = defaultImage
    /**
     * Reserved/ignored: `ensure()` never pulls implicitly (CONTRACT.md §4).
     * @type {boolean}
     */
    this.pullMissingImage = pullMissingImage === true
    /** @type {number} default command deadline. */
    this.execTimeoutMs = Math.floor(execTimeoutMs)
    /** @type {number} per-call deadline cap. */
    this.maxExecTimeoutMs = Math.floor(maxExecTimeoutMs)
    /** @type {number} per-stream output cap. */
    this.maxOutputBytes = Math.floor(maxOutputBytes)
    /** @type {string | null} optional Docker network for created containers. */
    this.network = network === null ? null : network.trim()
    /** @type {string[]} extra `docker run` arguments. */
    this.extraRunArgs = [...extraRunArgs]
  }

  /**
   * Canonical container name for a bot record or bot id.
   *
   * @param {object | string} recordOrId bot record (`{ id }`) or bot id string.
   * @returns {string} `dsh-bot-<id>`.
   * @throws {Error} `VM_INVALID_RECORD` when the record/id is unusable.
   */
  containerName(recordOrId) {
    return `${CONTAINER_PREFIX}${this.#botId(recordOrId)}`
  }

  /**
   * Probe the local Docker daemon.
   *
   * Runs `docker version --format {{.Server.Version}}` with a ~5 s bound and
   * never throws: availability problems are reported in the result.
   *
   * @returns {Promise<{ available: boolean, version: string | null, error: string | null }>} probe result.
   */
  async available() {
    const result = await this.#run(['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: DOCKER_VERSION_TIMEOUT_MS,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 64 * 1024,
    })
    if (result.spawnError) {
      return { available: false, version: null, error: `Docker is not available: ${result.spawnError.message}` }
    }
    if (result.aborted) {
      return { available: false, version: null, error: 'The Docker version probe was cancelled' }
    }
    if (result.timedOut) {
      return { available: false, version: null, error: `docker version timed out after ${DOCKER_VERSION_TIMEOUT_MS} ms` }
    }
    const version = result.stdout.trim()
    if (result.code === 0 && version.length > 0) {
      return { available: true, version, error: null }
    }
    return {
      available: false,
      version: null,
      error: firstLine(result.stderr) || `docker version exited with code ${result.code}`,
    }
  }

  /**
   * List locally available Docker images (never pulls).
   *
   * @returns {Promise<Array<{ name: string, tag: string, id: string, size: string, reference: string }>>} local images.
   * @throws {Error} `VM_DOCKER_UNAVAILABLE` when the daemon cannot be queried.
   */
  async listImages() {
    const result = await this.#run(['images', '--no-trunc', '--format', '{{json .}}'], {
      timeoutMs: DOCKER_INSPECT_TIMEOUT_MS,
      maxStdoutBytes: IMAGE_LIST_OUTPUT_CAP_BYTES,
      maxStderrBytes: 64 * 1024,
    })
    if (result.spawnError) {
      throw codeError('VM_DOCKER_UNAVAILABLE', `Docker is not available: ${result.spawnError.message}`)
    }
    if (result.aborted) throw codeError('VM_ABORTED', 'docker images was cancelled')
    if (result.timedOut) {
      throw codeError('VM_DOCKER_UNAVAILABLE', `docker images timed out after ${DOCKER_INSPECT_TIMEOUT_MS} ms`)
    }
    if (result.code !== 0) {
      const availability = await this.available()
      throw codeError(
        'VM_DOCKER_UNAVAILABLE',
        availability.error || firstLine(result.stderr) || `docker images exited with code ${result.code}`,
      )
    }

    const images = []
    const seen = new Set()
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let row
      try {
        row = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (row === null || typeof row !== 'object') continue
      const repository = typeof row.Repository === 'string' ? row.Repository.trim() : ''
      const tag = typeof row.Tag === 'string' ? row.Tag.trim() : ''
      if (repository.length === 0 || repository === '<none>') continue
      const reference = tag.length > 0 && tag !== '<none>' ? `${repository}:${tag}` : repository
      if (seen.has(reference)) continue
      seen.add(reference)
      images.push({
        name: repository,
        tag: tag.length > 0 ? tag : '<none>',
        id: typeof row.ID === 'string' ? row.ID : '',
        size: typeof row.Size === 'string' ? row.Size : '',
        reference,
      })
    }
    images.sort((left, right) => left.reference.localeCompare(right.reference))
    return images
  }

  /**
   * Read the live `VmStatus` of one bot's container.
   *
   * Never throws for Docker problems: a missing container is `state: 'missing'`,
   * an unreachable daemon is `state: 'unavailable'` (with `error`), and an
   * unexpected probe failure is `state: 'error'`.
   *
   * @param {object} record bot record (`{ id, vm: { enabled, image }, workspaceDir }`).
   * @returns {Promise<object>} `VmStatus` (CONTRACT.md §2).
   */
  async status(record) {
    const info = this.#botInfo(record)
    let inspection
    try {
      inspection = await this.#inspect(info.name)
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'VM_ABORTED') {
        return this.#degradedStatus(info, 'error', 'The Docker status probe was cancelled')
      }
      throw error
    }
    if (inspection.kind === 'missing') return this.#missingStatus(info)
    if (inspection.kind === 'unavailable') return this.#degradedStatus(info, 'unavailable', inspection.error)
    if (inspection.kind === 'error') return this.#degradedStatus(info, 'error', inspection.error)
    return this.#statusFromInspect(info, inspection.data)
  }

  /**
   * Read the live `VmStatus` of many bots at once.
   *
   * Probes each container in parallel (`docker inspect` per record; per-record is
   * explicitly allowed by CONTRACT.md §4) and never rejects for Docker problems —
   * a failed probe degrades that entry to `state: 'error'`.
   *
   * @param {object[]} records bot records.
   * @returns {Promise<Map<string, object>>} map keyed by bot id -> `VmStatus`.
   */
  async statuses(records) {
    const list = Array.isArray(records)
      ? records.filter((record) => record !== null && typeof record === 'object')
      : []
    const entries = await Promise.all(list.map(async (record) => {
      const id = typeof record.id === 'string' ? record.id : 'unknown'
      try {
        return [id, await this.status(record)]
      } catch (error) {
        return [id, {
          id,
          containerName: `${CONTAINER_PREFIX}${id}`,
          enabled: record.vm !== null && typeof record.vm === 'object' && record.vm.enabled === true,
          state: 'error',
          running: false,
          image: record.vm !== null && typeof record.vm === 'object' && typeof record.vm.image === 'string'
            ? record.vm.image
            : this.defaultImage,
          startedAt: null,
          exitCode: null,
          detail: null,
          error: asError(error).message,
        }]
      }
    }))
    const statuses = new Map()
    for (const [id, status] of entries) {
      if (!statuses.has(id)) statuses.set(id, status)
    }
    return statuses
  }

  /**
   * Ensure the bot container exists and is running.
   *
   * - Docker missing/unreachable -> `VM_DOCKER_UNAVAILABLE`.
   * - Missing local image -> `VM_IMAGE_MISSING`; never pulls implicitly (even
   *   with `pullMissingImage: true`). `pullImage()` is the only pull path.
   * - Foreign container with the same name -> `VM_NAME_CONFLICT`; it is never
   *   modified or deleted.
   * - Existing managed container -> started when stopped.
   * - Missing container -> workspace directory created, then `docker run -d`
   *   with the CONTRACT.md §4 argv (labels, workdir, same-path bind mount,
   *   `sleep infinity`).
   *
   * @param {object} record bot record.
   * @param {{ signal?: AbortSignal, env?: Record<string, string> }} [options] abort signal and
   *   optional extra container environment (only applied when the container is created).
   * @returns {Promise<object>} resulting `VmStatus` (normally `state: 'running'`).
   * @throws {Error} coded `VM_*` error for infrastructure failures.
   */
  async ensure(record, { signal, env } = {}) {
    const info = this.#botInfo(record)
    this.#assertNotForgotten(info.id)
    if (info.workspaceDir === null) {
      throw codeError('VM_INVALID_WORKSPACE', `Bot "${info.id}" needs an absolute workspaceDir before its VM can be created`)
    }
    const envArgs = this.#envArgs(env)
    const inspection = await this.#inspect(info.name, { signal })

    if (inspection.kind === 'unavailable') {
      throw codeError('VM_DOCKER_UNAVAILABLE', inspection.error || 'Docker is not available')
    }
    if (inspection.kind === 'error') {
      throw codeError('VM_ENSURE_FAILED', inspection.error || `Could not inspect container "${info.name}"`)
    }

    if (inspection.kind === 'ok') {
      this.#assertManaged(inspection.data, info)
      if (inspection.data.State !== null && typeof inspection.data.State === 'object' && inspection.data.State.Running === true) {
        return this.#statusFromInspect(info, inspection.data)
      }
      const result = await this.#run(['start', info.name], {
        timeoutMs: DOCKER_LIFECYCLE_TIMEOUT_MS,
        signal,
        botId: info.id,
      })
      this.#throwOnLifecycleFailure(result, 'VM_START_FAILED', `Starting container "${info.name}"`, DOCKER_LIFECYCLE_TIMEOUT_MS)
      return this.status(record)
    }

    // Container is missing: validate prerequisites, then create it.
    try {
      await mkdir(info.workspaceDir, { recursive: true })
    } catch (error) {
      throw codeError('VM_WORKSPACE_FAILED', `Could not create workspace directory "${info.workspaceDir}": ${asError(error).message}`)
    }
    await this.#assertImageAvailable(info, { signal })

    const runArgv = [
      'run',
      '-d',
      '--name', info.name,
      '--label', `${LABEL_MANAGED}=true`,
      '--label', `${LABEL_ID}=${info.id}`,
      '--label', `${LABEL_WORKSPACE}=${info.workspaceDir}`,
      '-w', info.workspaceDir,
      '-v', `${info.workspaceDir}:${info.workspaceDir}`,
      ...envArgs,
      ...(this.network === null ? [] : ['--network', this.network]),
      ...this.extraRunArgs,
      info.image,
      'sleep', 'infinity',
    ]
    const result = await this.#run(runArgv, { timeoutMs: DOCKER_LIFECYCLE_TIMEOUT_MS, signal, botId: info.id })
    if (result.spawnError) {
      throw codeError('VM_DOCKER_UNAVAILABLE', `Docker is not available: ${result.spawnError.message}`)
    }
    if (result.aborted) throw codeError('VM_ABORTED', `Creating container "${info.name}" was cancelled`)
    if (result.timedOut) {
      throw codeError('VM_CREATE_FAILED', `Creating container "${info.name}" timed out after ${DOCKER_LIFECYCLE_TIMEOUT_MS} ms`)
    }
    if (result.code !== 0) {
      if (/already in use/i.test(result.stderr)) {
        // A concurrent ensure() may have won the race: reuse our own managed
        // container instead of reporting a foreign-name conflict.
        const retry = await this.#inspect(info.name, { signal })
        if (retry.kind === 'ok') {
          this.#assertManaged(retry.data, info)
          const running = retry.data.State !== null && typeof retry.data.State === 'object' && retry.data.State.Running === true
          if (!running) {
            const startResult = await this.#run(['start', info.name], {
              timeoutMs: DOCKER_LIFECYCLE_TIMEOUT_MS,
              signal,
              botId: info.id,
            })
            this.#throwOnLifecycleFailure(startResult, 'VM_START_FAILED', `Starting container "${info.name}"`, DOCKER_LIFECYCLE_TIMEOUT_MS)
          }
          return this.status(record)
        }
        throw codeError(
          'VM_NAME_CONFLICT',
          `Container name "${info.name}" is already in use by another Docker container; refusing to touch it`,
        )
      }
      throw codeError(
        'VM_CREATE_FAILED',
        `Could not create container "${info.name}" (docker run exited with code ${result.code}): ${firstLine(result.stderr) || 'no stderr from docker'}`,
        { stderr: result.stderr },
      )
    }
    this.#shellCache.delete(info.name)
    return this.status(record)
  }

  /**
   * Start (or create and start) a bot container. Alias of {@link BotVm#ensure};
   * a removed VM is recreated from its record.
   *
   * @param {object} record bot record.
   * @param {{ signal?: AbortSignal }} [options] abort signal.
   * @returns {Promise<object>} resulting `VmStatus`.
   */
  async start(record, { signal } = {}) {
    return this.ensure(record, { signal })
  }

  /**
   * Stop a bot container. A missing container is not an error: the returned
   * status is `state: 'missing'`. Never touches foreign containers.
   *
   * @param {object} record bot record.
   * @param {{ signal?: AbortSignal }} [options] abort signal.
   * @returns {Promise<object>} resulting `VmStatus`.
   * @throws {Error} coded `VM_*` error for infrastructure failures.
   */
  async stop(record, { signal } = {}) {
    const info = this.#botInfo(record)
    this.#assertNotForgotten(info.id)
    const inspection = await this.#inspect(info.name, { signal })
    if (inspection.kind === 'missing') return this.#missingStatus(info)
    if (inspection.kind === 'unavailable') {
      throw codeError('VM_DOCKER_UNAVAILABLE', inspection.error || 'Docker is not available')
    }
    if (inspection.kind === 'error') {
      throw codeError('VM_STOP_FAILED', inspection.error || `Could not inspect container "${info.name}"`)
    }
    this.#assertManaged(inspection.data, info)
    if (!(inspection.data.State !== null && typeof inspection.data.State === 'object' && inspection.data.State.Running === true)) {
      return this.#statusFromInspect(info, inspection.data)
    }
    const result = await this.#run(['stop', info.name], {
      botId: info.id,
      timeoutMs: DOCKER_LIFECYCLE_TIMEOUT_MS,
      signal,
    })
    if (result.spawnError || result.aborted || result.timedOut) {
      this.#throwOnLifecycleFailure(result, 'VM_STOP_FAILED', `Stopping container "${info.name}"`, DOCKER_LIFECYCLE_TIMEOUT_MS)
    }
    if (result.code !== 0) {
      if (NO_SUCH_CONTAINER_RE.test(result.stderr)) return this.#missingStatus(info)
      throw codeError(
        'VM_STOP_FAILED',
        `Could not stop container "${info.name}" (docker stop exited with code ${result.code}): ${firstLine(result.stderr) || 'no stderr from docker'}`,
      )
    }
    return this.status(record)
  }

  /**
   * Restart a bot container. Creates it when missing and starts it when stopped
   * (delegating to {@link BotVm#ensure} in those cases).
   *
   * @param {object} record bot record.
   * @param {{ signal?: AbortSignal }} [options] abort signal.
   * @returns {Promise<object>} resulting `VmStatus`.
   * @throws {Error} coded `VM_*` error for infrastructure failures.
   */
  async restart(record, { signal } = {}) {
    const info = this.#botInfo(record)
    this.#assertNotForgotten(info.id)
    const inspection = await this.#inspect(info.name, { signal })
    if (inspection.kind === 'missing') return this.ensure(record, { signal })
    if (inspection.kind === 'unavailable') {
      throw codeError('VM_DOCKER_UNAVAILABLE', inspection.error || 'Docker is not available')
    }
    if (inspection.kind === 'error') {
      throw codeError('VM_RESTART_FAILED', inspection.error || `Could not inspect container "${info.name}"`)
    }
    this.#assertManaged(inspection.data, info)
    if (!(inspection.data.State !== null && typeof inspection.data.State === 'object' && inspection.data.State.Running === true)) {
      return this.ensure(record, { signal })
    }
    const result = await this.#run(['restart', info.name], {
      botId: info.id,
      timeoutMs: DOCKER_LIFECYCLE_TIMEOUT_MS,
      signal,
    })
    this.#throwOnLifecycleFailure(result, 'VM_RESTART_FAILED', `Restarting container "${info.name}"`, DOCKER_LIFECYCLE_TIMEOUT_MS)
    return this.status(record)
  }

  /**
   * Remove a bot container (never the workspace directory). A missing container
   * is not an error: the returned status is `state: 'missing'`. Foreign
   * containers that merely share the name are refused with `VM_NAME_CONFLICT`
   * and left untouched.
   *
   * @param {object} record bot record.
   * @param {{ signal?: AbortSignal }} [options] abort signal.
   * @returns {Promise<object>} resulting `VmStatus` (`state: 'missing'`).
   * @throws {Error} coded `VM_*` error for infrastructure failures.
   */
  async remove(record, { signal } = {}) {
    // Removal stays allowed after forget(): it is the cleanup path for a
    // deleted bot and must still be able to delete a leftover container.
    const info = this.#botInfo(record)
    const inspection = await this.#inspect(info.name, { signal })
    if (inspection.kind === 'missing') return this.#missingStatus(info)
    if (inspection.kind === 'unavailable') {
      throw codeError('VM_DOCKER_UNAVAILABLE', inspection.error || 'Docker is not available')
    }
    if (inspection.kind === 'error') {
      throw codeError('VM_REMOVE_FAILED', inspection.error || `Could not inspect container "${info.name}"`)
    }
    this.#assertManaged(inspection.data, info)
    const result = await this.#run(['rm', '-f', info.name], {
      botId: info.id,
      timeoutMs: DOCKER_LIFECYCLE_TIMEOUT_MS,
      signal,
    })
    if (result.spawnError || result.aborted || result.timedOut) {
      this.#throwOnLifecycleFailure(result, 'VM_REMOVE_FAILED', `Removing container "${info.name}"`, DOCKER_LIFECYCLE_TIMEOUT_MS)
    }
    if (result.code !== 0 && !NO_SUCH_CONTAINER_RE.test(result.stderr)) {
      throw codeError(
        'VM_REMOVE_FAILED',
        `Could not remove container "${info.name}" (docker rm exited with code ${result.code}): ${firstLine(result.stderr) || 'no stderr from docker'}`,
      )
    }
    this.#shellCache.delete(info.name)
    // A `docker run` cancelled concurrently with this removal can still
    // materialize the container a moment later; one follow-up pass closes that
    // window without racing the caller.
    await new Promise((resolve) => setTimeout(resolve, 250))
    const leftover = await this.#inspect(info.name, { signal })
    if (leftover.kind === 'ok') {
      try {
        this.#assertManaged(leftover.data, info)
        await this.#run(['rm', '-f', info.name], {
          botId: info.id,
          timeoutMs: DOCKER_LIFECYCLE_TIMEOUT_MS,
          signal,
        })
      } catch {
        // A foreign container appeared meanwhile: never touch it.
      }
    }
    return this.#missingStatus(info)
  }

  /**
   * Execute a shell command inside the bot container.
   *
   * The container is ensured running first; the command runs as
   * `docker exec -w <workdir> [-e K=V …] <name> <shell> -lc <command>`, where
   * `<shell>` is `/bin/bash` when the container has it, otherwise `/bin/sh`
   * (probed once per container and cached). stdout/stderr are captured
   * separately and each capped at `maxOutputBytes` (with a `[truncated]`
   * marker). A nonzero exit, a deadline, or a cancellation resolves normally —
   * only infrastructure failures reject.
   *
   * Deadline: the `docker exec` child is killed (SIGTERM, then SIGKILL after
   * ~2 s) and the result has `timedOut: true`; timeouts are classified before
   * any nonzero exit.
   *
   * Cancellation: an aborted `signal` (or {@link BotVm#dispose}) kills the
   * child and **resolves** with `timedOut: false, signal: 'aborted'` — it never
   * rejects for cancellation. The same applies to `docker exec`/`ensure`
   * infrastructure that was cancelled mid-flight.
   *
   * @param {object} record bot record.
   * @param {object} options execution options.
   * @param {string} options.command shell command (required, non-empty).
   * @param {string} [options.workdir] absolute working directory; defaults to the bot workspace.
   * @param {number} [options.timeoutMs] deadline; default `execTimeoutMs`, capped at `maxExecTimeoutMs`.
   * @param {AbortSignal} [options.signal] external cancellation.
   * @param {Record<string, string>} [options.env] extra environment variables.
   * @returns {Promise<{ exitCode: number | null, signal: string | null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean, durationMs: number, containerName: string }>} exec result.
   * @throws {Error} coded `VM_*` error for infrastructure failures only.
   */
  async exec(record, { command, workdir, timeoutMs, signal, env } = {}) {
    const info = this.#botInfo(record)
    this.#assertNotForgotten(info.id)
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw codeError('VM_INVALID_COMMAND', 'exec() requires a non-empty command string')
    }
    const requestedWorkdir = workdir === undefined || workdir === null ? info.workspaceDir : workdir
    if (typeof requestedWorkdir !== 'string' || !path.isAbsolute(requestedWorkdir)) {
      throw codeError('VM_INVALID_WORKDIR', 'exec() workdir must be an absolute path')
    }
    const envArgs = this.#envArgs(env)
    const effectiveTimeoutMs = this.#clampExecTimeout(timeoutMs)
    const startedAt = Date.now()
    const elapsed = () => Date.now() - startedAt
    const abortedResult = () => ({
      exitCode: null,
      signal: 'aborted',
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      durationMs: elapsed(),
      containerName: info.name,
    })

    if (signal !== undefined && signal !== null && signal.aborted === true) return abortedResult()

    try {
      await this.ensure(record, { signal })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'VM_ABORTED') return abortedResult()
      throw error
    }
    if (signal !== undefined && signal !== null && signal.aborted === true) return abortedResult()

    let shell
    try {
      shell = await this.#shellFor(info.name, { signal })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'VM_ABORTED') return abortedResult()
      throw error
    }
    if (signal !== undefined && signal !== null && signal.aborted === true) return abortedResult()

    const argv = [
      'exec',
      '-w', path.resolve(requestedWorkdir),
      ...envArgs,
      info.name,
      shell,
      '-lc', command,
    ]
    const result = await this.#run(argv, {
      timeoutMs: effectiveTimeoutMs,
      signal,
      botId: info.id,
      maxStdoutBytes: this.maxOutputBytes,
      maxStderrBytes: this.maxOutputBytes,
    })
    if (result.spawnError) {
      throw codeError('VM_EXEC_FAILED', `Could not run docker exec in container "${info.name}": ${result.spawnError.message}`)
    }

    const stdout = result.stdoutTruncated ? result.stdout + TRUNCATION_MARKER : result.stdout
    const stderr = result.stderrTruncated ? result.stderr + TRUNCATION_MARKER : result.stderr
    const truncated = result.stdoutTruncated || result.stderrTruncated
    const durationMs = elapsed()

    if (result.aborted) {
      return {
        exitCode: null,
        signal: 'aborted',
        stdout,
        stderr,
        timedOut: false,
        truncated,
        durationMs,
        containerName: info.name,
      }
    }
    if (result.timedOut) {
      return {
        exitCode: null,
        signal: result.signal === null ? 'SIGTERM' : result.signal,
        stdout,
        stderr,
        timedOut: true,
        truncated,
        durationMs,
        containerName: info.name,
      }
    }
    return {
      exitCode: result.code,
      signal: result.signal,
      stdout,
      stderr,
      timedOut: false,
      truncated,
      durationMs,
      containerName: info.name,
    }
  }

  /**
   * Pull a Docker image. This is the only method that pulls; `ensure()` never
   * pulls implicitly.
   *
   * Resolves `{ ok: false, detail }` for Docker/network failures and bounded
   * timeouts — it does not reject for them. Only an invalid image reference
   * throws (`VM_INVALID_IMAGE`).
   *
   * @param {string} image Docker image reference.
   * @param {{ signal?: AbortSignal }} [options] abort signal (bounded pull deadline).
   * @returns {Promise<{ ok: boolean, detail: string }>} pull outcome.
   * @throws {Error} `VM_INVALID_IMAGE` for a malformed image reference.
   */
  async pullImage(image, { signal } = {}) {
    if (typeof image !== 'string' || !IMAGE_REFERENCE_RE.test(image)) {
      throw codeError('VM_INVALID_IMAGE', `Invalid Docker image reference "${String(image)}"`)
    }
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, detail: 'docker pull was cancelled before it started' }
    }
    const result = await this.#run(['pull', image], {
      timeoutMs: DOCKER_PULL_TIMEOUT_MS,
      signal,
      maxStdoutBytes: CONTROL_OUTPUT_CAP_BYTES,
      maxStderrBytes: CONTROL_OUTPUT_CAP_BYTES,
    })
    if (result.spawnError) {
      return { ok: false, detail: `Docker is not available: ${result.spawnError.message}` }
    }
    if (result.aborted) return { ok: false, detail: 'docker pull was cancelled' }
    if (result.timedOut) {
      return { ok: false, detail: `docker pull timed out after ${DOCKER_PULL_TIMEOUT_MS} ms` }
    }
    if (result.code !== 0) {
      return {
        ok: false,
        detail: lastLine(result.stderr) || lastLine(result.stdout) || `docker pull exited with code ${result.code}`,
      }
    }
    return { ok: true, detail: lastLine(result.stdout) || `Pulled image ${image}` }
  }

  /**
   * Mark one bot as deleted: its container must never be recreated, and any
   * in-flight Docker child for it is cancelled. Idempotent; removal of a
   * leftover container stays allowed.
   *
   * @param {object | string} recordOrId bot record or id.
   * @returns {void}
   */
  forget(recordOrId) {
    let id
    try {
      id = this.#botId(recordOrId)
    } catch {
      return
    }
    this.#forgotten.add(id)
    this.#shellCache.delete(`${CONTAINER_PREFIX}${id}`)
    for (const record of [...this.#active]) {
      // Only cancel children attributable to this exact bot; long-lived control
      // probes belong to no bot and must not be disturbed by one deletion.
      if (record.botId !== id) continue
      try {
        record.cancel()
      } catch {
        // Cancellation is best-effort.
      }
    }
  }

  /**
   * Abort every in-flight Docker child process.
   *
   * Awaited execs settle as aborted; lifecycle calls waiting on Docker reject
   * with `VM_ABORTED`. Idempotent, and safe to call on plugin teardown.
   *
   * @returns {Promise<void>} resolves once cancellation was requested.
   */
  async dispose() {
    this.#disposed = true
    for (const record of [...this.#active]) {
      try {
        record.cancel()
      } catch {
        // Cancellation is best-effort.
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Reject operations for a bot whose record was deleted.
   *
   * @param {object | string} recordOrId bot record or id.
   * @returns {void}
   * @throws {Error} coded `VM_BOT_DELETED` once the bot is forgotten.
   */
  #assertNotForgotten(recordOrId) {
    let id
    try {
      id = this.#botId(recordOrId)
    } catch {
      return
    }
    if (this.#forgotten.has(id)) {
      throw codeError('VM_BOT_DELETED', `Bot "${id}" was deleted; its VM cannot be started again`)
    }
  }

  /**
   * Extract a validated bot id from a record or id string.
   *
   * @param {object | string} recordOrId record or id.
   * @returns {string} bot id.
   * @throws {Error} `VM_INVALID_RECORD` for unusable input.
   */
  #botId(recordOrId) {
    const id = typeof recordOrId === 'string'
      ? recordOrId
      : recordOrId !== null && typeof recordOrId === 'object'
        ? recordOrId.id
        : undefined
    if (typeof id !== 'string' || !BOT_ID_RE.test(id)) {
      throw codeError('VM_INVALID_RECORD', 'A bot record with a valid id (letters, digits, ".", "_" or "-") is required')
    }
    return id
  }

  /**
   * Normalized record facts used by every public method.
   *
   * @param {object} record bot record.
   * @returns {{ id: string, name: string, workspaceDir: string | null, image: string, enabled: boolean }} facts.
   */
  #botInfo(record) {
    const id = this.#botId(record)
    const isRecord = record !== null && typeof record === 'object'
    const rawWorkspace = isRecord ? record.workspaceDir : undefined
    const workspaceDir = typeof rawWorkspace === 'string' && path.isAbsolute(rawWorkspace)
      ? path.resolve(rawWorkspace)
      : null
    const vm = isRecord && record.vm !== null && typeof record.vm === 'object' ? record.vm : {}
    const image = typeof vm.image === 'string' && vm.image.trim().length > 0
      ? vm.image.trim()
      : this.defaultImage
    return {
      id,
      name: `${CONTAINER_PREFIX}${id}`,
      workspaceDir,
      image,
      enabled: vm.enabled === true,
    }
  }

  /**
   * Shared VmStatus identity/enablement fields.
   *
   * @param {{ id: string, name: string, image: string, enabled: boolean }} info bot facts.
   * @returns {{ id: string, containerName: string, enabled: boolean, image: string }} status base.
   */
  #statusBase(info) {
    return {
      id: info.id,
      containerName: info.name,
      enabled: info.enabled,
      image: info.image,
    }
  }

  /**
   * `VmStatus` for a container that does not exist.
   *
   * @param {{ id: string, name: string, image: string, enabled: boolean }} info bot facts.
   * @returns {object} status.
   */
  #missingStatus(info) {
    return {
      ...this.#statusBase(info),
      state: 'missing',
      running: false,
      startedAt: null,
      exitCode: null,
      detail: null,
      error: null,
    }
  }

  /**
   * `VmStatus` for a degraded probe (`unavailable`/`error`).
   *
   * @param {{ id: string, name: string, image: string, enabled: boolean }} info bot facts.
   * @param {'unavailable' | 'error'} state degraded state.
   * @param {string | null} error diagnostic message.
   * @returns {object} status.
   */
  #degradedStatus(info, state, error) {
    return {
      ...this.#statusBase(info),
      state,
      running: false,
      startedAt: null,
      exitCode: null,
      detail: null,
      error: typeof error === 'string' && error.length > 0 ? error : null,
    }
  }

  /**
   * `VmStatus` from a parsed `docker inspect` document.
   *
   * @param {{ id: string, name: string, image: string, enabled: boolean }} info bot facts.
   * @param {object} data container inspect document.
   * @returns {object} status.
   */
  #statusFromInspect(info, data) {
    const described = describeContainerState(data !== null && typeof data === 'object' ? data.State : undefined)
    return {
      ...this.#statusBase(info),
      state: described.state,
      running: described.running,
      startedAt: described.startedAt,
      exitCode: described.exitCode,
      detail: described.detail,
      error: described.error,
    }
  }

  /**
   * Inspect one container by name.
   *
   * @param {string} name container name.
   * @param {{ signal?: AbortSignal }} [options] abort signal.
   * @returns {Promise<{ kind: 'ok', data: object } | { kind: 'missing' } | { kind: 'unavailable', error: string } | { kind: 'error', error: string }>} inspection outcome.
   * @throws {Error} `VM_ABORTED` when cancelled while in flight.
   */
  async #inspect(name, { signal } = {}) {
    const result = await this.#run(
      ['inspect', '--type', 'container', '--format', '{{json .}}', name],
      {
        timeoutMs: DOCKER_INSPECT_TIMEOUT_MS,
        signal,
        maxStdoutBytes: CONTROL_OUTPUT_CAP_BYTES,
        maxStderrBytes: CONTROL_OUTPUT_CAP_BYTES,
      },
    )
    if (result.spawnError) {
      return { kind: 'unavailable', error: `Docker is not available: ${result.spawnError.message}` }
    }
    if (result.aborted) {
      throw codeError('VM_ABORTED', `docker inspect for container "${name}" was cancelled`)
    }
    if (result.timedOut) {
      return { kind: 'error', error: `docker inspect for container "${name}" timed out after ${DOCKER_INSPECT_TIMEOUT_MS} ms` }
    }
    if (result.code === 0) {
      let parsed
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        return { kind: 'error', error: 'docker inspect returned malformed JSON' }
      }
      const container = Array.isArray(parsed) ? parsed[0] : parsed
      if (container === null || typeof container !== 'object') {
        return { kind: 'error', error: `docker inspect returned no data for container "${name}"` }
      }
      return { kind: 'ok', data: container }
    }
    if (NO_SUCH_CONTAINER_RE.test(result.stderr) || NO_SUCH_CONTAINER_RE.test(result.stdout)) {
      return { kind: 'missing' }
    }
    const availability = await this.available()
    if (!availability.available) {
      return {
        kind: 'unavailable',
        error: availability.error || firstLine(result.stderr) || `docker inspect exited with code ${result.code}`,
      }
    }
    return {
      kind: 'error',
      error: firstLine(result.stderr) || `docker inspect exited with code ${result.code}`,
    }
  }

  /**
   * Refuse to touch a container whose labels do not declare it as this bot's VM.
   *
   * @param {object} data container inspect document.
   * @param {{ id: string, name: string }} info bot facts.
   * @returns {void}
   * @throws {Error} `VM_NAME_CONFLICT` when the container is not managed by this plugin.
   */
  #assertManaged(data, info) {
    const labels = data !== null && typeof data === 'object'
      && data.Config !== null && typeof data.Config === 'object'
      && data.Config.Labels !== null && typeof data.Config.Labels === 'object'
      ? data.Config.Labels
      : {}
    const managed = labels[LABEL_MANAGED] === 'true'
    const sameBot = labels[LABEL_ID] === info.id
    if (managed && sameBot) return
    throw codeError(
      'VM_NAME_CONFLICT',
      `Container "${info.name}" already exists but is not managed by the Bots plugin `
      + `(expected labels ${LABEL_MANAGED}=true and ${LABEL_ID}=${info.id}); refusing to modify it`,
    )
  }

  /**
   * Throw `VM_IMAGE_MISSING` unless the image is present locally. Never pulls.
   *
   * @param {{ image: string }} info bot facts.
   * @param {{ signal?: AbortSignal }} [options] abort signal.
   * @returns {Promise<void>} resolves when the image exists locally.
   * @throws {Error} coded `VM_*` error otherwise.
   */
  async #assertImageAvailable(info, { signal } = {}) {
    const image = info.image
    if (typeof image !== 'string' || !IMAGE_REFERENCE_RE.test(image)) {
      throw codeError('VM_INVALID_IMAGE', `Invalid Docker image reference "${String(image)}"`)
    }
    const result = await this.#run(['image', 'inspect', '--format', '{{.Id}}', image], {
      timeoutMs: DOCKER_INSPECT_TIMEOUT_MS,
      signal,
      maxStdoutBytes: CONTROL_OUTPUT_CAP_BYTES,
      maxStderrBytes: CONTROL_OUTPUT_CAP_BYTES,
    })
    if (result.spawnError) {
      throw codeError('VM_DOCKER_UNAVAILABLE', `Docker is not available: ${result.spawnError.message}`)
    }
    if (result.aborted) throw codeError('VM_ABORTED', `Checking Docker image "${image}" was cancelled`)
    if (result.timedOut) {
      throw codeError('VM_CREATE_FAILED', `Checking Docker image "${image}" timed out after ${DOCKER_INSPECT_TIMEOUT_MS} ms`)
    }
    if (result.code === 0) return
    if (NO_SUCH_IMAGE_RE.test(result.stderr) || NO_SUCH_IMAGE_RE.test(result.stdout)) {
      throw codeError(
        'VM_IMAGE_MISSING',
        `Docker image "${image}" is not available locally. Pull it first with "docker pull ${image}" `
        + '(the Bots page can download it), then start the VM again.',
        { image },
      )
    }
    const availability = await this.available()
    if (!availability.available) {
      throw codeError('VM_DOCKER_UNAVAILABLE', availability.error || `Could not check Docker image "${image}"`)
    }
    throw codeError(
      'VM_CREATE_FAILED',
      `Could not check Docker image "${image}": ${firstLine(result.stderr) || `docker image inspect exited with code ${result.code}`}`,
      { image },
    )
  }

  /**
   * Build `docker exec`/`docker run -e` argv pairs for an environment object,
   * with the model-friendly overrides as defaults (caller entries win).
   *
   * @param {Record<string, string> | undefined} env requested environment.
   * @returns {string[]} argv fragment of `-e KEY=VALUE` pairs.
   * @throws {Error} `VM_INVALID_ENV` for invalid keys/values.
   */
  #envArgs(env) {
    /** @type {Record<string, string>} */
    const merged = { ...ENV_OVERRIDES }
    if (env !== undefined && env !== null) {
      if (typeof env !== 'object' || Array.isArray(env)) {
        throw codeError('VM_INVALID_ENV', 'env must be a plain object of string values')
      }
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== 'string') {
          throw codeError('VM_INVALID_ENV', `Environment value for "${key}" must be a string`)
        }
        merged[key] = value
      }
    }
    const args = []
    for (const [key, value] of Object.entries(merged)) {
      if (!ENV_KEY_RE.test(key)) {
        throw codeError('VM_INVALID_ENV', `Invalid environment variable name "${key}"`)
      }
      if (value.includes('\u0000')) {
        throw codeError('VM_INVALID_ENV', `Environment value for "${key}" contains a NUL byte`)
      }
      args.push('-e', `${key}=${value}`)
    }
    return args
  }

  /**
   * Clamp an `exec()` deadline to the configured default/cap.
   *
   * @param {unknown} timeoutMs requested deadline.
   * @returns {number} positive integer milliseconds.
   */
  #clampExecTimeout(timeoutMs) {
    const candidate = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : this.execTimeoutMs
    return Math.max(1, Math.min(candidate, this.maxExecTimeoutMs))
  }

  /**
   * Detect (once) which shell the container has, preferring `/bin/bash`.
   *
   * @param {string} name container name.
   * @param {{ signal?: AbortSignal }} [options] abort signal.
   * @returns {Promise<'/bin/bash' | '/bin/sh'>} shell path inside the container.
   * @throws {Error} `VM_DOCKER_UNAVAILABLE` / `VM_ABORTED` for infrastructure failures.
   */
  async #shellFor(name, { signal } = {}) {
    const cached = this.#shellCache.get(name)
    if (cached !== undefined) return cached
    const result = await this.#run(['exec', name, '/bin/sh', '-c', 'test -x /bin/bash'], {
      timeoutMs: SHELL_PROBE_TIMEOUT_MS,
      signal,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
    })
    if (result.spawnError) {
      throw codeError('VM_DOCKER_UNAVAILABLE', `Docker is not available: ${result.spawnError.message}`)
    }
    if (result.aborted) throw codeError('VM_ABORTED', `Shell detection for container "${name}" was cancelled`)
    const shell = result.code === 0 ? '/bin/bash' : '/bin/sh'
    this.#shellCache.set(name, shell)
    return shell
  }

  /**
   * Classify a completed lifecycle docker command and throw for failures.
   *
   * @param {{ code: number | null, stderr: string, spawnError: Error | null, aborted: boolean, timedOut: boolean }} result settled run.
   * @param {string} code coded error to throw for a docker failure.
   * @param {string} label human-readable operation label.
   * @param {number} timeoutMs bound used for the command.
   * @returns {void}
   * @throws {Error} coded error for spawn/abort/timeout/nonzero exits.
   */
  #throwOnLifecycleFailure(result, code, label, timeoutMs) {
    if (result.spawnError) {
      throw codeError('VM_DOCKER_UNAVAILABLE', `Docker is not available: ${result.spawnError.message}`)
    }
    if (result.aborted) throw codeError('VM_ABORTED', `${label} was cancelled`)
    if (result.timedOut) throw codeError(code, `${label} timed out after ${timeoutMs} ms`)
    if (result.code !== 0) {
      throw codeError(
        code,
        `${label} failed (docker exited with code ${result.code}): ${firstLine(result.stderr) || 'no stderr from docker'}`,
        { stderr: result.stderr },
      )
    }
  }

  /**
   * Spawn one docker invocation with bounded output, a deadline, and abort
   * support. Resolves for every outcome (including spawn failures and
   * timeouts); never rejects.
   *
   * Kill sequence: caller abort or deadline -> SIGTERM, then SIGKILL after
   * `KILL_GRACE_MS`; a last-resort timer settles the promise even if Node never
   * reports the close, so no caller can hang on a wedged docker client.
   *
   * @param {string[]} argv docker arguments (argv array, never a shell string).
   * @param {object} [options] bounds.
   * @param {number} [options.timeoutMs] deadline in milliseconds.
   * @param {AbortSignal | null} [options.signal] external cancellation.
   * @param {number} [options.maxStdoutBytes] stdout capture cap.
   * @param {number} [options.maxStderrBytes] stderr capture cap.
   * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string, stdoutTruncated: boolean, stderrTruncated: boolean, timedOut: boolean, aborted: boolean, durationMs: number, spawnError: Error | null }>} settled run.
   */
  #run(argv, {
    timeoutMs = DOCKER_LIFECYCLE_TIMEOUT_MS,
    signal = null,
    maxStdoutBytes = CONTROL_OUTPUT_CAP_BYTES,
    maxStderrBytes = CONTROL_OUTPUT_CAP_BYTES,
    botId = null,
  } = {}) {
    if (this.#disposed) {
      return Promise.resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        aborted: true,
        durationMs: 0,
        spawnError: null,
      })
    }
    const startedAt = Date.now()
    return new Promise((resolve) => {
      /** @type {Buffer[]} */
      const stdoutChunks = []
      /** @type {Buffer[]} */
      const stderrChunks = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let stdoutTruncated = false
      let stderrTruncated = false
      /** @type {import('node:child_process').ChildProcess | null} */
      let child = null
      /** @type {{ child: import('node:child_process').ChildProcess, cancel: () => void } | null} */
      let activeRecord = null
      let settled = false
      let timedOut = false
      let aborted = false
      /** @type {'timeout' | 'abort' | null} */
      let cause = null
      /** @type {Error | null} */
      let spawnError = null
      /** @type {ReturnType<typeof setTimeout> | null} */
      let timeoutTimer = null
      /** @type {ReturnType<typeof setTimeout> | null} */
      let killTimer = null
      /** @type {ReturnType<typeof setTimeout> | null} */
      let abandonTimer = null
      let removeAbortListener = () => {}

      const settle = (code, termSignal) => {
        if (settled) return
        settled = true
        if (timeoutTimer !== null) clearTimeout(timeoutTimer)
        if (killTimer !== null) clearTimeout(killTimer)
        if (abandonTimer !== null) clearTimeout(abandonTimer)
        removeAbortListener()
        if (activeRecord !== null) this.#active.delete(activeRecord)
        resolve({
          code,
          signal: termSignal,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdoutTruncated,
          stderrTruncated,
          timedOut,
          aborted,
          durationMs: Date.now() - startedAt,
          spawnError,
        })
      }

      /**
       * First-cause termination: once a cause is recorded, later causes never
       * overwrite it (a timeout is classified before the kill's nonzero exit).
       *
       * @param {'timeout' | 'abort'} reason termination cause.
       * @returns {void}
       */
      const terminate = (reason) => {
        if (settled || cause !== null) return
        cause = reason
        if (reason === 'timeout') timedOut = true
        else aborted = true
        if (child === null) return
        try {
          child.kill('SIGTERM')
        } catch {
          // Child already gone.
        }
        killTimer = setTimeout(() => {
          if (settled || child === null) return
          try {
            child.kill('SIGKILL')
          } catch {
            // Child already gone.
          }
          abandonTimer = setTimeout(() => settle(null, 'SIGKILL'), ABANDON_GRACE_MS)
        }, KILL_GRACE_MS)
      }

      const onAbort = () => terminate('abort')

      const collectStdout = (chunk) => {
        if (settled) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        const room = maxStdoutBytes - stdoutBytes
        if (room <= 0) {
          stdoutTruncated = true
          return
        }
        if (buffer.length > room) {
          stdoutChunks.push(buffer.subarray(0, room))
          stdoutBytes = maxStdoutBytes
          stdoutTruncated = true
          return
        }
        stdoutChunks.push(buffer)
        stdoutBytes += buffer.length
      }

      const collectStderr = (chunk) => {
        if (settled) return
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        const room = maxStderrBytes - stderrBytes
        if (room <= 0) {
          stderrTruncated = true
          return
        }
        if (buffer.length > room) {
          stderrChunks.push(buffer.subarray(0, room))
          stderrBytes = maxStderrBytes
          stderrTruncated = true
          return
        }
        stderrChunks.push(buffer)
        stderrBytes += buffer.length
      }

      if (signal !== null && signal.aborted === true) {
        terminate('abort')
        settle(null, null)
        return
      }

      if (this.#disposed) {
        terminate('abort')
        settle(null, null)
        return
      }

      try {
        child = spawn(this.dockerBin, argv, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        })
      } catch (error) {
        spawnError = asError(error)
        settle(null, null)
        return
      }

      activeRecord = { child, cancel: () => terminate('abort'), botId }
      this.#active.add(activeRecord)

      child.stdout?.on('data', collectStdout)
      child.stderr?.on('data', collectStderr)
      child.on('error', (error) => {
        spawnError = spawnError ?? asError(error)
        // A spawn failure (no pid) never produces useful output; settle now in
        // case Node does not emit `close` for it.
        if (child !== null && child.pid === undefined) settle(null, null)
      })
      child.on('close', (code, termSignal) => settle(code, termSignal))

      timeoutTimer = setTimeout(() => terminate('timeout'), Math.max(1, timeoutMs))

      if (signal !== null) {
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', onAbort)
        if (signal.aborted === true) onAbort()
      }
    })
  }
}
