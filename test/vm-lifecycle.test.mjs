/**
 * Lifecycle-safety checks for `BotVm`: sticky plugin disposal (M2) and the
 * delete-bot tombstone that prevents container recreation (M3).
 *
 * Real Docker, isolated temp workspace, unique container ids; every container
 * and directory is removed in `finally`.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { BotVm } from '../host/vm.js'
import { BotStore } from '../host/store.js'

const execFileAsync = promisify(execFile)
const IMAGE = 'ubuntu:24.04'
const created = []
const tempDirs = []

/**
 * Create one bot record with a workspace directory.
 *
 * @param {string} label test label.
 * @returns {Promise<object>} bot record.
 */
async function makeRecord(label) {
  const id = `t${process.pid.toString(16)}${randomBytes(3).toString('hex')}`
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `dsh-bots-lifecycle-${label}-`))
  tempDirs.push(dir)
  const workspaceDir = path.join(dir, 'workspace')
  await fs.mkdir(workspaceDir, { recursive: true })
  created.push(id)
  return {
    id,
    name: `Lifecycle ${label}`,
    emoji: '🤖',
    color: '#2563eb',
    instructions: '',
    workspaceDir,
    vm: { enabled: true, image: IMAGE },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Assert that a container does not exist.
 *
 * @param {string} name container name.
 * @returns {Promise<void>}
 */
async function assertNoContainer(name) {
  try {
    await execFileAsync('docker', ['inspect', name], { timeout: 15000 })
  } catch {
    return
  }
  assert.fail(`container ${name} still exists`)
}

async function cleanup() {
  for (const id of created) {
    try {
      await execFileAsync('docker', ['rm', '-f', `dsh-bot-${id}`], { timeout: 30000 })
    } catch {
      // Already gone.
    }
  }
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true })
}

async function testStickyDispose() {
  const record = await makeRecord('dispose')
  const vm = new BotVm({ defaultImage: IMAGE })
  await vm.ensure(record)
  const inflight = vm.exec(record, { command: 'sleep 20', timeoutMs: 60000 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const startedAt = Date.now()
  await vm.dispose()
  const result = await inflight
  assert.equal(result.timedOut, false)
  assert.equal(result.signal, 'aborted', `in-flight exec did not settle aborted: ${JSON.stringify(result)}`)
  assert.ok(Date.now() - startedAt < 5000, 'dispose did not cancel the in-flight exec promptly')

  // A disposed executor must not spawn anything new, and must settle instead
  // of waiting for a Docker deadline.
  const afterStart = Date.now()
  let afterFailure = null
  try {
    const after = await vm.exec(record, { command: 'sleep 20', timeoutMs: 60000 })
    if (after.signal !== 'aborted') afterFailure = new Error(`unexpected post-dispose result: ${JSON.stringify(after)}`)
  } catch (error) {
    if (!/VM_/.test(String(error.code ?? error.message))) afterFailure = error
  }
  assert.equal(afterFailure, null)
  assert.ok(Date.now() - afterStart < 5000, 'post-dispose exec was not short-circuited')
  // Disposal must not destroy the user's VM: the container stays until the
  // user removes it (cleanup removes it here).
  await execFileAsync('docker', ['inspect', vm.containerName(record)], { timeout: 15000 })
  console.log('ok sticky dispose (M2)')
}

async function testDeleteTombstone() {
  const record = await makeRecord('forget')
  const vm = new BotVm({ defaultImage: IMAGE })
  const running = await vm.ensure(record)
  assert.equal(running.state, 'running')
  await execFileAsync('docker', ['inspect', vm.containerName(record)], { timeout: 15000 })

  vm.forget(record)
  await assert.rejects(vm.ensure(record), (error) => error.code === 'VM_BOT_DELETED')
  await assert.rejects(vm.exec(record, { command: 'echo nope' }), (error) => error.code === 'VM_BOT_DELETED')
  // Removal must still be allowed after forget(), so a leftover container can
  // always be cleaned up.
  await vm.remove(record)
  await assertNoContainer(vm.containerName(record))
  await vm.dispose()
  console.log('ok delete tombstone (M3)')
}

async function testStoreDeletePathUsesValidatedTarget() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-bots-store-lifecycle-'))
  tempDirs.push(root)
  const store = new BotStore({ botsRoot: path.join(root, 'bots') })
  await store.init()
  const record = await store.create({ name: 'Delete Me', vm: { enabled: false } })
  const workspace = await store.ensureWorkspace(record)
  await fs.writeFile(path.join(workspace, 'file.txt'), 'hello')
  await store.remove(record.id, { deleteWorkspace: true })
  await assert.rejects(fs.access(workspace), 'workspace survived a deleteWorkspace removal')
  console.log('ok validated deleteWorkspace target')
}

try {
  await testStickyDispose()
  await testDeleteTombstone()
  await testStoreDeletePathUsesValidatedTarget()
  console.log('\nvm lifecycle tests PASS')
} finally {
  await cleanup()
}
