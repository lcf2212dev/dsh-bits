#!/usr/bin/env node
/**
 * Smoke checker for one real Bit mode mission.
 *
 * Reads a recorded DSH session (plain JSONL or `session.v4.jsonl.zstd`) and
 * reports which bits the orchestrator delegated to, how many invocations each
 * received, any failed delegation and any use of another delegation tool
 * (`spawn_teammate`, `subagent`, `team_delegate`, or a direct `claude_delegate`
 * call) instead of a bit. With `--require`, it exits non-zero when a required
 * bit was missing, so a mission can be gated on the work split it should follow
 * (for example: recon with Scout, implementation with Builder, independent
 * review with Reviewer).
 *
 * Usage:
 *   node test/bit-usage.mjs <session-id | path/session.v4.jsonl[.zstd]> \
 *        [--require Scout,Builder,Reviewer] [--json] [--bots-root DIR]
 *   node test/bit-usage.mjs --self-test
 *
 * Node built-ins only.
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEVIATION_TOOLS = new Set(['spawn_teammate', 'subagent', 'subagent_fork', 'team_delegate', 'team_handoff', 'claude_delegate'])
const REQUIRED_USAGE = 'usage: node test/bit-usage.mjs <session-id|log-path> [--require Bit,Bit] [--json] [--bots-root DIR] | --self-test'

/** Normalize a bit reference (name, `bit-character` id or character id) for matching. */
function normalizeBit(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/^bit/, '')
}

/**
 * Resolve a session id (or id prefix) to its log file.
 *
 * @param {string} target session id, id prefix, or an existing file path.
 * @param {string} dshHome root that holds `sessions/`.
 * @returns {string} absolute log path.
 */
function resolveLogPath(target, dshHome) {
  if (existsSync(target) && statSync(target).isFile()) return path.resolve(target)
  const sessionsRoot = path.join(dshHome, 'sessions')
  const matches = []
  if (existsSync(sessionsRoot)) {
    for (const bucket of readdirSync(sessionsRoot)) {
      const bucketDir = path.join(sessionsRoot, bucket)
      if (!existsSync(bucketDir) || !statSync(bucketDir).isDirectory()) continue
      for (const name of readdirSync(bucketDir)) {
        if (!name.startsWith(target)) continue
        for (const file of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
          const candidate = path.join(bucketDir, name, file)
          if (existsSync(candidate)) matches.push(candidate)
        }
      }
    }
  }
  if (matches.length === 0) throw new Error(`session "${target}" not found under ${sessionsRoot} (pass the log path instead)`)
  const unique = [...new Set(matches)]
  if (unique.length > 1) throw new Error(`session prefix "${target}" matches ${unique.length} logs; pass the full id or the log path`)
  return unique[0]
}

/**
 * Read a session log. DSH appends multiple zstd frames to the session file and
 * `zlib.zstdDecompressSync` decodes only the first one, so the `zstd` CLI is
 * used when available; Node's zlib is the last-resort fallback (first frame).
 */
async function readLog(file) {
  if (!file.endsWith('.zstd')) return fs.readFile(file, 'utf8')
  const child = spawnSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 })
  if (child.status === 0 && child.stdout.length > 0) return child.stdout.toString('utf8')
  const compressed = await fs.readFile(file)
  try {
    return zlib.zstdDecompressSync(compressed).toString('utf8')
  } catch {
    throw new Error(`could not decompress ${file}: ${String(child.stderr ?? '').trim() || 'zstd failed and zlib has no zstd support'}`)
  }
}

/**
 * Load the local bit store so a delegated bit name/id can be traced to its
 * catalog character (`Builder` → `bit-builder`); a mission may use names only.
 *
 * @param {string} botsRoot directory that holds `bits.json`.
 * @returns {Record<string, string[]>} normalized reference → normalized candidates.
 */
async function loadBitStore(botsRoot) {
  const table = new Map()
  const add = (value, candidate) => {
    const key = normalizeBit(value)
    if (key === '') return
    const list = table.get(key) ?? []
    if (!list.includes(candidate)) list.push(candidate)
    table.set(key, list)
  }
  try {
    const doc = JSON.parse(await fs.readFile(path.join(botsRoot, 'bits.json'), 'utf8'))
    for (const bit of Array.isArray(doc.bits) ? doc.bits : []) {
      const candidates = [normalizeBit(bit.name), normalizeBit(bit.character)].filter((value) => value !== '')
      for (const key of [normalizeBit(bit.name), normalizeBit(bit.id)]) {
        if (key === '') continue
        for (const candidate of candidates) add(key, candidate)
      }
    }
  } catch {
    // No store available: matching stays on the delegated name/id alone.
  }
  return table
}

/** Every normalized identity of one delegated bit: raw argument plus store aliases. */
function bitIdentities(bitValue, store) {
  const identities = new Set()
  const raw = normalizeBit(bitValue)
  if (raw !== '') identities.add(raw)
  for (const alias of store.get(raw) ?? []) identities.add(alias)
  return identities
}

/**
 * Summarize the delegation behavior of parsed session records.
 *
 * @param {any[]} records session records.
 * @param {{store?: Map<string, string[]>}} [deps]
 * @returns {any}
 */
export function summarizeRecords(records, deps = {}) {
  const store = deps.store ?? new Map()
  const session = records.find((record) => record.type === 'session') ?? null
  const presetEvents = records.filter((record) => record.type === 'agent-preset/selected')
  const results = new Map()
  for (const record of records) {
    if (record.type !== 'tool/result') continue
    const message = record.data?.message ?? {}
    const callId = message.toolCallId ?? message.source?.callId
    if (typeof callId !== 'string') continue
    const text = (Array.isArray(message.content) ? message.content : [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    results.set(callId, { time: record.time, text, isError: message.isError === true || /^Error:/.test(text) })
  }
  const calls = records.filter((record) => record.type === 'tool/call')
  const delegations = []
  const deviations = []
  const toolCounts = new Map()
  for (const record of calls) {
    const name = record.data?.name
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
    if (DEVIATION_TOOLS.has(name)) deviations.push({ tool: name, step: record.data?.step, time: record.time })
    if (name !== 'bit_delegate') continue
    let args = {}
    try {
      args = JSON.parse(record.data?.arguments ?? '{}')
    } catch {
      args = {}
    }
    const result = results.get(record.data?.callId) ?? null
    const bitValue = typeof args.bit === 'string' && args.bit.trim() !== '' ? args.bit.trim() : null
    const task = typeof args.task === 'string' ? args.task : ''
    delegations.push({
      step: record.data?.step ?? null,
      time: record.time,
      callId: record.data?.callId ?? null,
      bit: bitValue,
      identities: [...bitIdentities(bitValue, store)],
      readOnly: args.read_only !== false,
      taskFirstLine: task.split('\n').find((line) => line.trim() !== '')?.trim().slice(0, 160) ?? '',
      durationSeconds: result ? Math.round((result.time - record.time) / 1000) : null,
      resultFirstLine: result ? (result.text.split('\n')[0] ?? '').slice(0, 160) : '',
      error: result === null ? 'no result recorded' : result.isError ? (result.text.split('\n')[0] ?? 'error') : null,
    })
  }
  const byBit = new Map()
  for (const delegation of delegations) {
    const key = delegation.bit === null ? '(missing "bit")' : delegation.bit
    const row = byBit.get(key) ?? { bit: key, calls: 0, errors: 0, readOnly: 0, readsWrite: 0, steps: [], identities: new Set() }
    row.calls += 1
    if (delegation.error !== null) row.errors += 1
    if (delegation.readOnly) row.readOnly += 1
    else row.readsWrite += 1
    if (delegation.step !== null) row.steps.push(delegation.step)
    for (const identity of delegation.identities) row.identities.add(identity)
    byBit.set(key, row)
  }
  return {
    session: session === null ? null : { id: session.id, cwd: session.cwd, createdAt: session.createdAt, headerPreset: session.agentPreset ?? null },
    preset: {
      header: session?.agentPreset ?? null,
      events: presetEvents.map((record) => ({ time: record.time, preset: record.data?.agentPreset })),
      effective: presetEvents.length === 0 ? (session?.agentPreset ?? null) : presetEvents[presetEvents.length - 1].data?.agentPreset ?? null,
    },
    delegations,
    bits: [...byBit.values()].map((row) => ({ ...row, identities: [...row.identities] })).sort((a, b) => b.calls - a.calls),
    totalCalls: delegations.length,
    failedCalls: delegations.filter((delegation) => delegation.error !== null).length,
    deviations,
    toolCounts: [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).map(([tool, count]) => ({ tool, count })),
  }
}

/** Normalize the --require list into entries. */
function requiredBitsOf(values) {
  const entries = []
  for (const value of values) {
    for (const part of String(value).split(',')) {
      const trimmed = part.trim()
      if (trimmed !== '') entries.push(trimmed)
    }
  }
  return entries
}

/** Required entry → delegations that satisfy it. */
function requirementMatches(summary, required) {
  const wanted = normalizeBit(required)
  const matches = summary.delegations.filter((delegation) => delegation.identities.includes(wanted))
  return matches.length > 0
}

function clockOf(time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return '?'
  return new Date(time).toLocaleTimeString('pt-BR', { hour12: false })
}

function formatReport(summary, required, logPath) {
  const lines = []
  lines.push(`session: ${summary.session?.id ?? '?'}  (${logPath})`)
  if (summary.session !== null) lines.push(`cwd: ${summary.session.cwd ?? '?'}`)
  lines.push(`preset: header=${summary.preset.header ?? '?'} effective=${summary.preset.effective ?? '?'} (${summary.preset.events.length} selection event(s))`)
  lines.push(`bit_delegate calls: ${summary.totalCalls}  failed: ${summary.failedCalls}  other delegation tools: ${summary.deviations.length}`)
  lines.push('')
  if (summary.bits.length === 0) {
    lines.push('bits delegated: (none)')
  } else {
    lines.push('bits delegated:')
    for (const row of summary.bits) {
      const steps = row.steps.length > 0 ? ` steps ${Math.min(...row.steps)}–${Math.max(...row.steps)}` : ''
      lines.push(`  ${row.bit}  calls=${row.calls} errors=${row.errors} read_only=${row.readOnly} writes=${row.readsWrite}${steps}`)
    }
  }
  lines.push('')
  lines.push('delegation log:')
  for (const delegation of summary.delegations) {
    const state = delegation.error === null ? 'ok' : 'ERROR'
    const readOnly = delegation.readOnly ? 'ro' : 'rw'
    const seconds = delegation.durationSeconds === null ? '?' : `${delegation.durationSeconds}s`
    lines.push(`  step ${String(delegation.step ?? '?').padStart(3)} ${clockOf(delegation.time)} ${String(delegation.bit ?? '(missing)').padEnd(14)} ${readOnly} ${seconds.padStart(5)} ${state}  ${delegation.error ?? delegation.resultFirstLine}`)
  }
  if (summary.deviations.length > 0) {
    lines.push('')
    lines.push('WARNING — delegation outside the Bits:')
    for (const deviation of summary.deviations) lines.push(`  ${deviation.tool} at step ${deviation.step ?? '?'}`)
  }
  if (required.length > 0) {
    lines.push('')
    lines.push('required bits:')
    let missing = 0
    for (const entry of required) {
      const ok = requirementMatches(summary, entry)
      if (!ok) missing += 1
      lines.push(`  ${ok ? 'ok' : 'MISSING'} — ${entry}`)
    }
    lines.push(missing === 0 ? 'result: PASS' : `result: FAIL (${missing} required bit(s) not used)`)
    return { text: lines.join('\n'), missing }
  }
  lines.push('')
  lines.push('result: reported (no --require given)')
  return { text: lines.join('\n'), missing: 0 }
}

const SELF_TEST_RECORDS = [
  { type: 'session', id: 'session-self-test', cwd: '/tmp/project', createdAt: 1_700_000_000_000, agentPreset: 'standard' },
  { type: 'agent-preset/selected', time: 1_700_000_001_000, data: { agentPreset: 'bits-orchestrator' } },
  { type: 'tool/call', time: 1_700_000_010_000, data: { step: 1, callId: 'c1', name: 'bit_delegate', arguments: JSON.stringify({ bit: 'Scout', read_only: true, task: 'Mapeie o projeto e devolva os arquivos de arte.' }) } },
  { type: 'tool/result', time: 1_700_000_040_000, data: { step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: '[Scout · claude-code/haiku · medium]\nMapa pronto.' }] } } },
  { type: 'tool/call', time: 1_700_000_050_000, data: { step: 2, callId: 'c2', name: 'bit_delegate', arguments: JSON.stringify({ bit: 'Builder', read_only: false, task: 'Implemente o passe de arte.' }) } },
  { type: 'tool/result', time: 1_700_000_110_000, data: { step: 2, message: { toolCallId: 'c2', content: [{ type: 'text', text: '[Builder · claude-code/sonnet · medium]\nFeito.' }] } } },
  { type: 'tool/call', time: 1_700_000_120_000, data: { step: 3, callId: 'c3', name: 'bit_delegate', arguments: JSON.stringify({ bit: 'Reviewer', read_only: true, task: 'Revise a entrega.' }) } },
  { type: 'tool/result', time: 1_700_000_150_000, data: { step: 3, message: { toolCallId: 'c3', content: [{ type: 'text', text: '[Reviewer · claude-code/opus · high]\nAprovado com 1 ressalva.' }] } } },
  { type: 'tool/call', time: 1_700_000_160_000, data: { step: 4, callId: 'c4', name: 'bit_delegate', arguments: JSON.stringify({ bit: 'Builder', read_only: true, task: 'Corrija a ressalva.' }) } },
  { type: 'tool/result', time: 1_700_000_170_000, data: { step: 4, message: { toolCallId: 'c4', content: [{ type: 'text', text: 'Error: bit_delegate: task is too short.' }], isError: true } } },
]

function runSelfTest() {
  let checks = 0
  const check = (name, fn) => {
    fn()
    checks += 1
    console.log(`ok - ${name}`)
  }
  const summary = summarizeRecords(SELF_TEST_RECORDS)
  check('summarizes the delegations per bit', () => {
    assert.equal(summary.totalCalls, 4)
    assert.equal(summary.bits.length, 3)
    assert.deepEqual(summary.bits.map((row) => [row.bit, row.calls, row.errors]), [['Builder', 2, 1], ['Scout', 1, 0], ['Reviewer', 1, 0]].sort((a, b) => b[1] - a[1]))
    assert.equal(summary.failedCalls, 1)
    assert.equal(summary.preset.effective, 'bits-orchestrator')
  })
  check('matches required bits by name, id and catalog character', () => {
    for (const required of ['Scout', 'scout', 'bit-scout', 'Builder', 'bit-builder', 'Reviewer']) {
      assert.equal(requirementMatches(summary, required), true, required)
    }
    assert.equal(requirementMatches(summary, 'Pixel Artist'), false)
  })
  check('flags delegation outside the Bits', () => {
    const deviated = summarizeRecords([...SELF_TEST_RECORDS, { type: 'tool/call', time: 1_700_000_200_000, data: { step: 5, callId: 'c5', name: 'subagent', arguments: '{}' } }])
    assert.equal(deviated.deviations.length, 1)
    assert.equal(deviated.deviations[0].tool, 'subagent')
  })
  check('resolves missing "bit" calls without crashing', () => {
    const malformed = summarizeRecords([{ type: 'tool/call', time: 1_700_000_300_000, data: { step: 6, callId: 'c6', name: 'bit_delegate', arguments: '{"bit_delegate":"Builder"}' } }])
    assert.equal(malformed.delegations[0].bit, null)
    assert.equal(malformed.bits[0].bit, '(missing "bit")')
  })
  check('uses the store to map a bit name to its catalog character', () => {
    const store = new Map([['builder', ['builder']], ['43fd578b1f', ['builder']]])
    const withStore = summarizeRecords(SELF_TEST_RECORDS, { store })
    assert.equal(requirementMatches(withStore, 'Builder'), true)
  })
  console.log(`\nself-test: ${checks} checks passed`)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(REQUIRED_USAGE)
    return
  }
  if (argv.includes('--self-test')) {
    runSelfTest()
    return
  }
  const required = []
  let target = null
  let json = false
  let botsRoot = path.join(os.homedir(), '.dsh', 'bots')
  let dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') json = true
    else if (arg === '--require') {
      index += 1
      required.push(argv[index] ?? '')
    } else if (arg.startsWith('--require=')) required.push(arg.slice('--require='.length))
    else if (arg === '--bots-root') {
      index += 1
      botsRoot = argv[index] ?? botsRoot
    } else if (arg.startsWith('--bots-root=')) botsRoot = arg.slice('--bots-root='.length)
    else if (arg === '--dsh-home') {
      index += 1
      dshHome = argv[index] ?? dshHome
    } else if (arg.startsWith('--dsh-home=')) dshHome = arg.slice('--dsh-home='.length)
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n${REQUIRED_USAGE}`)
    else if (target === null) target = arg
    else throw new Error(`unexpected argument ${arg}\n${REQUIRED_USAGE}`)
  }
  if (target === null) throw new Error(REQUIRED_USAGE)
  const logPath = resolveLogPath(target, dshHome)
  const text = await readLog(logPath)
  const records = []
  let malformed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line))
    } catch {
      malformed += 1
    }
  }
  if (records.length === 0) throw new Error(`no session records in ${logPath}`)
  const store = await loadBitStore(botsRoot)
  const summary = summarizeRecords(records, { store })
  const requiredList = requiredBitsOf(required)
  if (json) {
    console.log(JSON.stringify({ logPath, malformedLines: malformed, required: requiredList, summary, requiredOk: requiredList.length === 0 ? null : requiredList.map((entry) => ({ bit: entry, ok: requirementMatches(summary, entry) })) }, null, 2))
    if (requiredList.some((entry) => !requirementMatches(summary, entry))) process.exitCode = 1
    return
  }
  const report = formatReport(summary, requiredList, logPath)
  console.log(report.text)
  if (malformed > 0) console.log(`note: ${malformed} malformed line(s) ignored`)
  if (report.missing > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`bit-usage: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  })
}
