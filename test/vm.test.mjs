/**
 * Real-Docker end-to-end test for `host/vm.js` (`BotVm`).
 *
 * Exercises the actual local Docker daemon (no mocks, no pulls, no npm):
 *
 *  - `available()` / `listImages()` probes;
 *  - `status()` of a missing container;
 *  - `ensure()` creating + running a labelled, same-path-bind-mounted container;
 *  - `exec()` stdout/stderr/exit codes/env/default+explicit workdir/output caps;
 *  - `exec()` deadline enforcement (bounded duration, `timedOut: true`);
 *  - `dispose()` aborting an in-flight exec;
 *  - `stop()` / `start()` / `restart()` / `remove()` lifecycle;
 *  - error paths: missing local image (`VM_IMAGE_MISSING`, never pulled) and a
 *    foreign container colliding with the bot name (`VM_NAME_CONFLICT`, never
 *    deleted).
 *
 * An isolated temp workspace under the OS temp dir is used and a unique
 * test-only bot id builds the container name. In `finally` the test removes
 * every container it created, rm -rf's the temp workspace, and verifies nothing
 * was left behind. Prints a PASS/FAIL summary and exits nonzero on failure.
 *
 * Run with: `node test/vm.test.mjs`
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { BotVm } from '../host/vm.js'

const execFileAsync = promisify(execFile)

/** Image present locally on the host; the test must never pull it. */
const IMAGE = 'ubuntu:24.04'
/** Deliberately absent image; used to exercise VM_IMAGE_MISSING without pulling. */
const MISSING_IMAGE = 'dsh-bot-image-does-not-exist:2026-e2e'
/** Hard cap on the whole test run (docker children are bounded on their own). */
const WATCHDOG_MS = 240000

/** Test-only bot id: `t` + random hex, so `dsh-bot-<id>` cannot collide. */
const TEST_ID = `t${crypto.randomBytes(5).toString('hex')}`
const CONTAINER = `dsh-bot-${TEST_ID}`
/** Second id used to prove name-collision handling of a non-managed container. */
const FOREIGN_ID = `f${crypto.randomBytes(5).toString('hex')}`
const FOREIGN_CONTAINER = `dsh-bot-${FOREIGN_ID}`

/** `maxOutputBytes` given to the tested BotVm so truncation is cheap to trigger. */
const MAX_OUTPUT_BYTES = 8192

let passed = 0
/** @type {Array<{ name: string, error: Error }>} */
const failures = []

/**
 * Run one named check; a throw records a failure instead of aborting the run.
 *
 * @param {string} name check label.
 * @param {() => Promise<void>} fn check body.
 * @returns {Promise<void>} resolves after recording the outcome.
 */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`PASS  ${name}`)
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    failures.push({ name, error: failure })
    console.error(`FAIL  ${name}`)
    const stack = String(failure.stack ?? failure).split('\n').slice(0, 8)
    for (const line of stack) console.error(`      ${line}`)
  }
}

/**
 * Sleep helper.
 *
 * @param {number} milliseconds delay.
 * @returns {Promise<void>} resolves after the delay.
 */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Run a raw docker command for setup/verification (argv array, bounded).
 *
 * @param {string[]} args docker argv.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>} outcome; never rejects.
 */
async function docker(args) {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : String(error.message ?? error),
    }
  }
}

/**
 * Whether a container with exactly this name exists (running or not).
 *
 * @param {string} name container name.
 * @returns {Promise<boolean>} true when present.
 */
async function containerExists(name) {
  const result = await docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])
  if (result.code !== 0) return false
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).includes(name)
}

/**
 * Remove a container, ignoring errors (cleanup path).
 *
 * @param {string} name container name.
 * @returns {Promise<void>} resolves when done.
 */
async function cleanupContainer(name) {
  await docker(['rm', '-f', name])
}

/**
 * Whether a filesystem path exists.
 *
 * @param {string} candidate path to test.
 * @returns {Promise<boolean>} true when it exists.
 */
async function pathExists(candidate) {
  try {
    await fs.stat(candidate)
    return true
  } catch {
    return false
  }
}

/**
 * Print the PASS/FAIL summary and cleanup verification; sets `process.exitCode`.
 *
 * @param {object} context summary inputs.
 * @param {string[]} context.containers container names that must be gone.
 * @param {string} context.workspace temp workspace that must be removed.
 * @param {string | null} context.dockerVersion probed server version.
 * @returns {Promise<void>} resolves after printing.
 */
async function summarize({ containers, workspace, dockerVersion }) {
  const leftoverContainers = []
  for (const name of containers) {
    let exists = false
    try {
      exists = await containerExists(name)
    } catch {
      exists = true
    }
    if (exists) leftoverContainers.push(name)
  }
  let workspaceRemoved = true
  try {
    workspaceRemoved = !(await pathExists(workspace))
  } catch {
    workspaceRemoved = false
  }

  if (leftoverContainers.length > 0) {
    failures.push({
      name: 'cleanup: containers',
      error: new Error(`test containers left behind: ${leftoverContainers.join(', ')}`),
    })
  }
  if (!workspaceRemoved) {
    failures.push({
      name: 'cleanup: temp workspace',
      error: new Error(`temp workspace left behind: ${workspace}`),
    })
  }

  const total = passed + failures.length
  const ok = failures.length === 0
  console.log('')
  console.log(`== BotVm Docker E2E: ${ok ? 'PASS' : 'FAIL'} (${passed}/${total} checks) ==`)
  if (typeof dockerVersion === 'string') console.log(`docker server: ${dockerVersion}`)
  console.log(
    ok
      ? 'cleanup: no test containers left behind; temp workspace removed'
      : 'cleanup: see failures above',
  )
  if (!ok) {
    console.log('failed checks:')
    for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error.message}`)
    process.exitCode = 1
  } else {
    process.exitCode = 0
  }
}

/**
 * Test entry point: sets up temp dirs/instances, runs the checks, always cleans up.
 *
 * @returns {Promise<void>} resolves after the summary.
 */
async function main() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-vm-test-'))
  const foreignWorkspace = path.join(workspace, 'foreign-workspace')

  /** Main bot record under test. */
  const record = {
    id: TEST_ID,
    name: 'VM E2E bot',
    workspaceDir: workspace,
    vm: { enabled: true, image: IMAGE },
  }
  /** Same bot, image that is not present locally (no pull allowed). */
  const missingImageRecord = {
    id: TEST_ID,
    name: 'VM E2E bot',
    workspaceDir: workspace,
    vm: { enabled: true, image: MISSING_IMAGE },
  }
  /** Foreign-bot record whose container name the test will occupy manually. */
  const foreignRecord = {
    id: FOREIGN_ID,
    name: 'Foreign bot',
    workspaceDir: foreignWorkspace,
    vm: { enabled: true, image: IMAGE },
  }
  /** Disabled-VM record used to check `VmStatus.enabled`. */
  const disabledRecord = {
    id: FOREIGN_ID,
    name: 'Disabled bot',
    workspaceDir: foreignWorkspace,
    vm: { enabled: false, image: IMAGE },
  }

  let vm = new BotVm({ maxOutputBytes: MAX_OUTPUT_BYTES })
  const vmOptingIntoPulls = new BotVm({ pullMissingImage: true })
  const containers = new Set([CONTAINER, FOREIGN_CONTAINER])
  let dockerVersion = null

  const watchdog = setTimeout(() => {
    console.error(`\nFAIL  watchdog: the E2E test exceeded ${WATCHDOG_MS} ms`)
    process.exit(1)
  }, WATCHDOG_MS)
  watchdog.unref()

  try {
    // ---------------------------------------------------------------- probes
    await test('available() reports the Docker server version', async () => {
      const availability = await vm.available()
      assert.equal(availability.available, true, `expected Docker to be available: ${availability.error}`)
      assert.equal(availability.error, null)
      assert.match(availability.version ?? '', /^\d+\.\d+/, `unexpected Docker version ${availability.version}`)
      dockerVersion = availability.version
    })

    await test('listImages() lists local images and includes ubuntu:24.04', async () => {
      const images = await vm.listImages()
      assert.ok(Array.isArray(images), 'listImages() must return an array')
      assert.ok(images.length > 0, 'expected at least one local image')
      for (const image of images) {
        for (const field of ['name', 'tag', 'id', 'size', 'reference']) {
          assert.equal(typeof image[field], 'string', `image.${field} must be a string`)
        }
        assert.ok(image.reference.length > 0, 'image.reference must not be empty')
      }
      const ubuntu = images.find((image) => image.reference === IMAGE)
      assert.ok(
        ubuntu !== undefined,
        `expected ${IMAGE} in local images, found: ${images.map((image) => image.reference).join(', ')}`,
      )
    })

    // ------------------------------------------------------- missing status
    await test('status() of a bot without a container is "missing"', async () => {
      const status = await vm.status(record)
      assert.equal(status.id, TEST_ID)
      assert.equal(status.containerName, CONTAINER)
      assert.equal(status.enabled, true)
      assert.equal(status.image, IMAGE)
      assert.equal(status.state, 'missing')
      assert.equal(status.running, false)
      assert.equal(status.startedAt, null)
      assert.equal(status.exitCode, null)
      assert.equal(status.detail, null)
      assert.equal(status.error, null)
      assert.equal(await containerExists(CONTAINER), false, 'precondition: container must not exist yet')
    })

    // ------------------------------------------------------ create + labels
    await test('ensure() creates and starts a labelled, bind-mounted container', async () => {
      const status = await vm.ensure(record)
      assert.equal(status.state, 'running')
      assert.equal(status.running, true)
      assert.equal(status.containerName, CONTAINER)
      assert.equal(await containerExists(CONTAINER), true, 'container must exist after ensure()')
      assert.equal(await pathExists(workspace), true, 'workspace directory must exist after ensure()')

      const inspected = await docker([
        'inspect',
        '--format',
        '{{json .Config.Labels}}|{{json .Mounts}}|{{json .Config.WorkingDir}}|{{.Config.Image}}|{{.HostConfig.Privileged}}',
        CONTAINER,
      ])
      assert.equal(inspected.code, 0, `docker inspect failed: ${inspected.stderr}`)
      const parts = inspected.stdout.trim().split('|')
      assert.equal(parts.length, 5, `unexpected inspect output: ${inspected.stdout}`)
      const labels = JSON.parse(parts[0])
      const mounts = JSON.parse(parts[1])
      const workdir = JSON.parse(parts[2])
      const image = parts[3]
      const privileged = parts[4]

      assert.equal(labels['dsh.bots.managed'], 'true')
      assert.equal(labels['dsh.bots.id'], TEST_ID)
      assert.equal(labels['dsh.bots.workspace'], workspace)
      assert.equal(image, IMAGE)
      assert.equal(privileged, 'false', 'bot containers must never be privileged')
      assert.equal(workdir, workspace, 'container workdir must be the bot workspace')

      const mount = mounts.find((entry) => entry.Destination === workspace)
      assert.ok(mount !== undefined, `expected a mount at ${workspace}, got ${JSON.stringify(mounts)}`)
      assert.equal(mount.Type, 'bind')
      assert.equal(mount.Source, workspace, 'workspace must be bind-mounted at the same absolute path')
      for (const entry of mounts) {
        assert.ok(!String(entry.Source ?? '').includes('docker.sock'), 'the Docker socket must never be mounted')
      }
    })

    await test('ensure() is idempotent and reuses the running container', async () => {
      const first = await vm.ensure(record)
      const second = await vm.ensure(record)
      assert.equal(first.state, 'running')
      assert.equal(second.state, 'running')
      assert.equal(second.containerName, CONTAINER)
      const listed = await docker(['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.ID}}'])
      assert.equal(listed.code, 0, listed.stderr)
      const ids = listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      assert.equal(ids.length, 1, `expected exactly one container named ${CONTAINER}, got ${ids.length}`)
    })

    await test('status() reports running with a startedAt timestamp', async () => {
      const status = await vm.status(record)
      assert.equal(status.state, 'running')
      assert.equal(status.running, true)
      assert.equal(status.error, null)
      assert.equal(typeof status.startedAt, 'string')
      assert.ok(!Number.isNaN(Date.parse(status.startedAt)), `startedAt is not a date: ${status.startedAt}`)
    })

    await test('statuses() returns one VmStatus per record keyed by bot id', async () => {
      const statuses = await vm.statuses([record, disabledRecord])
      assert.ok(statuses instanceof Map, 'statuses() must return a Map keyed by bot id')
      assert.equal(statuses.size, 2)
      const running = statuses.get(TEST_ID)
      assert.equal(running.state, 'running')
      const disabled = statuses.get(FOREIGN_ID)
      assert.equal(disabled.state, 'missing')
      assert.equal(disabled.enabled, false)
    })

    // ---------------------------------------------------------- exec paths
    await test('exec() captures stdout and runs in the workspace by default', async () => {
      const result = await vm.exec(record, { command: 'echo hello-vm && pwd' })
      assert.equal(result.exitCode, 0)
      assert.equal(result.signal, null)
      assert.equal(result.timedOut, false)
      assert.equal(result.truncated, false)
      assert.equal(result.containerName, CONTAINER)
      assert.equal(typeof result.durationMs, 'number')
      assert.ok(result.durationMs >= 0)
      const lines = result.stdout.trim().split('\n')
      assert.equal(lines[0], 'hello-vm')
      assert.equal(lines[1], workspace, 'exec() must default to the bot workspace workdir')
      assert.equal(result.stderr, '')
    })

    await test('exec() reports nonzero exit codes and stderr separately', async () => {
      const result = await vm.exec(record, { command: 'echo failing >&2; exit 7' })
      assert.equal(result.exitCode, 7)
      assert.equal(result.timedOut, false)
      assert.equal(result.signal, null)
      assert.match(result.stderr, /failing/)
      assert.equal(result.stdout, '')
    })

    await test('exec() forwards environment variables', async () => {
      const result = await vm.exec(record, {
        command: 'printf %s "$DSH_VM_TEST_VALUE"',
        env: { DSH_VM_TEST_VALUE: 'env-ok-42' },
      })
      assert.equal(result.exitCode, 0)
      assert.equal(result.stdout, 'env-ok-42')
    })

    await test('exec() supports a workdir outside the bot workspace', async () => {
      const result = await vm.exec(record, { command: 'pwd; cat /etc/hostname', workdir: '/tmp' })
      assert.equal(result.exitCode, 0, `stderr: ${result.stderr}`)
      const lines = result.stdout.trim().split('\n').filter((line) => line.length > 0)
      assert.equal(lines[0], '/tmp')
      assert.ok(lines.length >= 2 && lines[1].length > 0, 'expected /etc/hostname content')
    })

    await test('exec() enforces a bounded deadline and reports timedOut', async () => {
      const startedAt = Date.now()
      const result = await vm.exec(record, { command: 'sleep 10', timeoutMs: 500 })
      const wallMs = Date.now() - startedAt
      assert.equal(result.timedOut, true)
      assert.equal(result.containerName, CONTAINER)
      assert.ok(wallMs >= 400, `deadline fired too early (${wallMs} ms)`)
      assert.ok(wallMs < 8000, `timed-out exec must return promptly, took ${wallMs} ms`)
      assert.ok(result.durationMs < 8000, `durationMs ${result.durationMs} must stay bounded`)
    })

    await test('exec() caps output at maxOutputBytes and marks truncation', async () => {
      const result = await vm.exec(record, {
        command: "dd if=/dev/zero bs=1024 count=64 2>/dev/null | tr '\\0' 'x'",
      })
      assert.equal(result.exitCode, 0)
      assert.equal(result.truncated, true)
      assert.ok(result.stdout.includes('[truncated]'), 'truncated stdout must carry a [truncated] marker')
      const markerIndex = result.stdout.indexOf('\n[truncated]')
      assert.ok(markerIndex > 0)
      const payloadBytes = Buffer.byteLength(result.stdout.slice(0, markerIndex))
      assert.ok(payloadBytes <= MAX_OUTPUT_BYTES, `stdout payload ${payloadBytes} exceeds cap ${MAX_OUTPUT_BYTES}`)
      assert.ok(payloadBytes > 0, 'expected some output before truncation')
    })

    await test('dispose() aborts an in-flight exec and settles as aborted', async () => {
      const running = vm.exec(record, { command: 'sleep 20', timeoutMs: 20000 })
      await delay(500)
      const startedAt = Date.now()
      await vm.dispose()
      const result = await running
      const wallMs = Date.now() - startedAt
      assert.equal(result.timedOut, false)
      assert.equal(result.signal, 'aborted')
      assert.equal(result.containerName, CONTAINER)
      assert.ok(wallMs < 8000, `dispose() must settle the exec promptly, took ${wallMs} ms`)
      // disposal is sticky by design, so the remaining lifecycle checks need a
      // fresh executor (the container itself survives disposal).
      vm = new BotVm({ maxOutputBytes: MAX_OUTPUT_BYTES })
    })

    // ----------------------------------------------------------- lifecycle
    await test('stop() stops the running container', async () => {
      const status = await vm.stop(record)
      assert.ok(
        status.state === 'exited' || status.state === 'stopped',
        `unexpected state after stop(): ${status.state}`,
      )
      assert.equal(status.running, false)
      assert.equal(status.containerName, CONTAINER)
      assert.equal(typeof status.exitCode, 'number', 'a stopped container should report its exit code')
      assert.equal(await containerExists(CONTAINER), true, 'stop() must not remove the container')
    })

    await test('start() restarts the stopped container', async () => {
      const status = await vm.start(record)
      assert.equal(status.state, 'running')
      assert.equal(status.running, true)
      assert.equal(status.containerName, CONTAINER)
    })

    await test('restart() keeps the container running with a fresh startedAt', async () => {
      const status = await vm.restart(record)
      assert.equal(status.state, 'running')
      assert.equal(status.running, true)
      assert.equal(typeof status.startedAt, 'string')
      assert.ok(!Number.isNaN(Date.parse(status.startedAt)), `startedAt is not a date: ${status.startedAt}`)
    })

    await test('remove() deletes the container but keeps the workspace directory', async () => {
      const status = await vm.remove(record)
      assert.equal(status.state, 'missing')
      assert.equal(status.running, false)
      assert.equal(await containerExists(CONTAINER), false, 'container must be gone after remove()')
      assert.equal(await pathExists(workspace), true, 'remove() must never delete the workspace directory')
    })

    await test('stop() and remove() on a missing container are not errors', async () => {
      const stopped = await vm.stop(record)
      assert.equal(stopped.state, 'missing')
      const removed = await vm.remove(record)
      assert.equal(removed.state, 'missing')
      assert.equal(await containerExists(CONTAINER), false)
    })

    // --------------------------------------------------------- error paths
    await test('ensure() with an absent image throws VM_IMAGE_MISSING without pulling', async () => {
      const startedAt = Date.now()
      await assert.rejects(
        () => vm.ensure(missingImageRecord),
        (error) => {
          assert.equal(error.code, 'VM_IMAGE_MISSING')
          assert.ok(error.message.includes(MISSING_IMAGE), `message must name the image: ${error.message}`)
          assert.match(error.message, /docker pull/)
          return true
        },
      )
      assert.ok(Date.now() - startedAt < 30000, 'an absent image must fail fast (no implicit pull)')
      assert.equal(await containerExists(CONTAINER), false, 'no container may be created for an absent image')
      const images = await vm.listImages()
      assert.equal(
        images.some((image) => image.reference === MISSING_IMAGE),
        false,
        'ensure() must never pull the missing image',
      )
      const status = await vm.status(missingImageRecord)
      assert.equal(status.state, 'missing')
    })

    await test('ensure() never pulls even with pullMissingImage: true', async () => {
      await assert.rejects(
        () => vmOptingIntoPulls.ensure(missingImageRecord),
        (error) => {
          assert.equal(error.code, 'VM_IMAGE_MISSING')
          return true
        },
      )
      const images = await vmOptingIntoPulls.listImages()
      assert.equal(
        images.some((image) => image.reference === MISSING_IMAGE),
        false,
        'pullMissingImage must not trigger an implicit pull (reserved/ignored)',
      )
    })

    await test('ensure() refuses to manage a foreign container with the bot name', async () => {
      const created = await docker(['run', '-d', '--name', FOREIGN_CONTAINER, IMAGE, 'sleep', 'infinity'])
      assert.equal(created.code, 0, `failed to create the foreign container: ${created.stderr}`)
      try {
        await assert.rejects(
          () => vm.ensure(foreignRecord),
          (error) => {
            assert.equal(error.code, 'VM_NAME_CONFLICT')
            assert.ok(error.message.includes(FOREIGN_CONTAINER), `message must name the container: ${error.message}`)
            return true
          },
        )
        assert.equal(
          await containerExists(FOREIGN_CONTAINER),
          true,
          'a foreign container must never be started, stopped or deleted by ensure()',
        )
      } finally {
        await cleanupContainer(FOREIGN_CONTAINER)
      }
    })
  } finally {
    clearTimeout(watchdog)
    try {
      await vm.dispose()
    } catch {
      // Best-effort test teardown.
    }
    try {
      await vmOptingIntoPulls.dispose()
    } catch {
      // Best-effort test teardown.
    }
    for (const name of containers) await cleanupContainer(name)
    await fs.rm(workspace, { recursive: true, force: true })
  }

  await summarize({ containers: [...containers], workspace, dockerVersion })
}

main().catch((error) => {
  console.error('FAIL  harness:', error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
