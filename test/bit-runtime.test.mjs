/**
 * Bit runtime + model catalog against a fake host context.
 *
 * Covers: model catalog (subscription + DSH routes, cache, never throws),
 * resolution (stored ids, bare labels, legacy aliases, efforts, coded errors),
 * prompt composition, the subscription backend through the registered
 * `claude_delegate` tool, the DSH one-shot backend through `ctx.llm.stream`,
 * read-only flags, ad-hoc vs team-delegation paths and error mapping.
 *
 * Plain `node test/bit-runtime.test.mjs`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createBitRuntime, composePrompt } from '../host/bit-runtime.js'
import { createModelCatalog, effortFor } from '../host/models.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const temps = []
async function tempDir(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

function codedOf(error) {
  return error && typeof error.code === 'string' ? error.code : null
}

/* ------------------------------ fake host ------------------------------ */

const FULL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Fake `ctx.llm`: one DeepSeek provider by default; the model reports the five
 * reasoning efforts. Providers can be made to throw to exercise list().
 */
function fakeLlm(options = {}) {
  const {
    providers = [{ id: 'deepseek-account', name: 'DeepSeek Account' }],
    models = [{ provider: 'deepseek-account', id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }],
    efforts = FULL_EFFORTS,
    failListProviders = false,
    failListModels = false,
    resolveCallConfig = async (config) => config,
    stream = null,
  } = options
  const counts = { listProviders: 0, listModels: 0, resolveModelInfo: 0, stream: 0 }
  const calls = { stream: [], resolveCallConfig: [] }
  return {
    counts,
    calls,
    listProviders() {
      counts.listProviders += 1
      if (failListProviders) throw new Error('profile llm unavailable')
      return providers
    },
    async listModels(provider) {
      counts.listModels += 1
      if (failListModels) throw new Error(`no models for ${provider}`)
      return models.filter((model) => model.provider === provider)
    },
    async resolveModelInfo(provider, model) {
      counts.resolveModelInfo += 1
      const found = models.find((item) => item.provider === provider && item.id === model)
      if (!found) throw new Error(`unknown model ${provider}/${model}`)
      return {
        provider,
        id: model,
        name: found.name,
        ...(efforts.length > 0 ? { reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } } : {}),
      }
    },
    async resolveCallConfig(config) {
      calls.resolveCallConfig.push({ ...config })
      return resolveCallConfig(config)
    },
    stream(options) {
      counts.stream += 1
      calls.stream.push(options)
      if (typeof stream === 'function') return stream(options)
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'hello' }
        yield { type: 'finish', reason: { kind: 'success' } }
      })()
    },
  }
}

/** Fake tool pipeline: records the raw calls and settles a canonical result. */
function fakeTools() {
  const state = { calls: [], settle: null }
  return {
    state,
    async execute(input) {
      state.calls.push(input)
      const settle = state.settle || ((call) => ({ results: [{ callId: call.id, result: { isError: false, value: 'Claude response' } }] }))
      return settle(input.calls[0], input)
    },
  }
}

function fakeCtx({ llm = fakeLlm(), tools = fakeTools() } = {}) {
  return { llm, tools, workingDirectory: { get: () => process.cwd() } }
}

function subscriptionBit(extra = {}) {
  return {
    id: 'bit-1',
    name: 'Builder',
    isOrchestrator: false,
    instructions: 'You build with tests first.',
    model: 'subscription/sonnet',
    effort: 'high',
    workspaceDir: '/tmp/bit-workspace',
    ...extra,
  }
}

/* -------------------------------- fixtures -------------------------------- */

const workspace = await tempDir('dsh-bits-br-ws-')

/* -------------------------------- catalog -------------------------------- */

await test('model catalog: subscription aliases + profile routes with efforts, cached', async () => {
  const llm = fakeLlm()
  const ctx = fakeCtx({ llm })
  const models = createModelCatalog(ctx)
  const { models: list } = await models.list()
  assert.equal(list.length, 4)
  const subscription = list.filter((option) => option.group === 'subscription')
  assert.deepEqual(subscription.map((option) => option.id), ['subscription/opus', 'subscription/sonnet', 'subscription/haiku'])
  assert.equal(subscription[1].label, 'Claude Sonnet 5.5 (subscription)')
  assert.equal(subscription[0].backend, 'claude-code')
  assert.equal(subscription[0].alias, 'opus')
  assert.deepEqual(subscription[0].efforts, FULL_EFFORTS)
  assert.equal(subscription[0].tools, true)
  assert.equal(subscription[0].supportsOrchestrator, false)
  const route = list.find((option) => option.group === 'routes')
  assert.deepEqual(route, {
    id: 'deepseek-account/deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    group: 'routes',
    backend: 'dsh',
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    efforts: FULL_EFFORTS,
    tools: false,
    supportsOrchestrator: true,
  })
  // Cached for ~60 s: a second read does not touch the profile.
  const before = { ...llm.counts }
  await models.list()
  assert.equal(llm.counts.listProviders, before.listProviders)
  assert.equal(llm.counts.listModels, before.listModels)
  assert.equal(llm.counts.resolveModelInfo, before.resolveModelInfo)
})

await test('model catalog: never throws — subscriptions only when providers fail', async () => {
  const list = await createModelCatalog(fakeCtx({ llm: fakeLlm({ failListProviders: true }) })).list()
  assert.deepEqual(list.models.map((option) => option.id), ['subscription/opus', 'subscription/sonnet', 'subscription/haiku'])
  const brokenModels = await createModelCatalog(fakeCtx({ llm: fakeLlm({ failListModels: true }) })).list()
  assert.equal(brokenModels.models.filter((option) => option.group === 'routes').length, 0)
  const noLlm = await createModelCatalog({}).list()
  assert.equal(noLlm.models.length, 3)
  // A model without reasoning metadata still appears with the fallback efforts.
  const noEfforts = await createModelCatalog(fakeCtx({ llm: fakeLlm({ efforts: [] }) })).list()
  assert.deepEqual(noEfforts.models.find((option) => option.group === 'routes').efforts, FULL_EFFORTS)
})

await test('resolve: stored ids, legacy aliases, bare labels, efforts and coded errors', async () => {
  const models = createModelCatalog(fakeCtx())
  const sonnet = await models.resolve({ model: 'subscription/sonnet', effort: 'high', name: 'Builder' })
  assert.deepEqual(sonnet, { backend: 'claude-code', alias: 'sonnet', modelId: 'subscription/sonnet', effort: 'high' })
  // Legacy bare alias.
  const opus = await models.resolve({ model: 'opus', effort: 'xhigh' })
  assert.deepEqual(opus, { backend: 'claude-code', alias: 'opus', modelId: 'subscription/opus', effort: 'xhigh' })
  // DSH stored route.
  const dsh = await models.resolve({ model: 'deepseek-account/deepseek-flash', effort: 'max', name: 'Coordinator' })
  assert.deepEqual(dsh, { backend: 'dsh', provider: 'deepseek-account', model: 'deepseek-flash', effort: 'max' })
  // Bare display label (migration/backward compatibility).
  const label = await models.resolve({ model: 'DeepSeek-V4.1-Flash', effort: 'high' })
  assert.deepEqual(label, { backend: 'dsh', provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high' })
  // Effort the model cannot map: the model default applies (no reasoningEffort).
  const unmapped = await models.resolve({ model: 'DeepSeek-V4.1-Flash', effort: 'ultra' })
  assert.equal('effort' in unmapped, false)
  await assert.rejects(models.resolve({ model: '', name: 'X' }), (error) => codedOf(error) === 'BIT_MODEL_MISSING')
  await assert.rejects(models.resolve({ model: 'Claude 9000', name: 'X' }), (error) => codedOf(error) === 'BIT_MODEL_INVALID' && /Claude 9000/.test(error.message))
  await assert.rejects(models.resolve({ model: 'nope/nope', name: 'X' }), (error) => codedOf(error) === 'BIT_MODEL_INVALID')
  // No profile routes at all: the DSH family is reported as unavailable.
  const offline = createModelCatalog(fakeCtx({ llm: fakeLlm({ failListProviders: true }) }))
  await assert.rejects(offline.resolve({ model: 'deepseek-account/deepseek-flash' }), (error) => codedOf(error) === 'BIT_MODEL_INVALID' && /no DSH chat route/.test(error.message))
})

await test('effortFor maps the v4 aliases and reports undefined without efforts', async () => {
  const option = { efforts: ['low', 'medium', 'high', 'xhigh'] }
  assert.equal(effortFor(option, 'xhigh'), 'xhigh')
  assert.equal(effortFor(option, 'low'), 'low')
  assert.equal(effortFor({ efforts: ['high', 'max'] }, 'xhigh'), 'max')
  assert.equal(effortFor({ reasoning: { efforts: [{ id: 'high' }, { id: 'max' }] } }, 'medium'), 'high')
  assert.equal(effortFor(option, 'ultra'), undefined)
  assert.equal(effortFor({ efforts: [] }, 'high'), undefined)
  assert.equal(effortFor(null, 'high'), undefined)
})

await test('routeFor: orchestrators need a DSH route; missing model defaults to DeepSeek-V4.1-Flash Max', async () => {
  const models = createModelCatalog(fakeCtx())
  const route = await models.routeFor({ isOrchestrator: true, name: 'Lead', model: 'deepseek-account/deepseek-flash', effort: 'max' })
  assert.deepEqual(route, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' })
  // No stored model: the contract default.
  const fallback = await models.routeFor({ isOrchestrator: true, name: 'Lead', model: '', effort: '' })
  assert.deepEqual(fallback, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' })
  await assert.rejects(models.routeFor({ isOrchestrator: true, name: 'Lead', model: 'subscription/opus' }), (error) => codedOf(error) === 'BIT_MODEL_INVALID' && /subscription model/.test(error.message))
  await assert.rejects(models.routeFor({ isOrchestrator: false, name: 'Worker', model: 'deepseek-account/deepseek-flash' }), (error) => codedOf(error) === 'BIT_MODEL_INVALID' && /not an orchestrator/.test(error.message))
  // An effort the route rejects is dropped; an invalid route becomes coded.
  const picky = createModelCatalog(fakeCtx({
    llm: fakeLlm({
      resolveCallConfig: async (config) => {
        if (config.reasoningEffort === 'max') throw Object.assign(new Error('unsupported effort'), { code: 'UNSUPPORTED_REASONING_EFFORT' })
        return config
      },
    }),
  }))
  assert.deepEqual(await picky.routeFor({ isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'max' }), { provider: 'deepseek-account', model: 'deepseek-flash' })
  const invalid = createModelCatalog(fakeCtx({ llm: fakeLlm({ resolveCallConfig: async () => { throw new Error('route refused') } }) }))
  await assert.rejects(invalid.routeFor({ isOrchestrator: true, model: 'deepseek-account/deepseek-flash', effort: 'max' }), (error) => codedOf(error) === 'BIT_MODEL_INVALID' && /was not accepted/.test(error.message))
})

/* ----------------------------- prompt composition ----------------------------- */

await test('prompt composition: instructions + separator + request, report when there are none', async () => {
  const bit = { instructions: 'You are the Builder.', name: 'Builder' }
  assert.equal(composePrompt(bit, 'Implement X'), 'You are the Builder.\n\n---\n\nImplement X')
  assert.equal(composePrompt(bit, '  Implement X  '), 'You are the Builder.\n\n---\n\nImplement X')
  assert.equal(composePrompt({ instructions: '' }, 'Just the request'), 'Just the request\n\n---\n\nAt the end, respond with an objective report of what was done: outcome, files changed and pending items.')
  assert.equal(composePrompt({ instructions: '   ' }, 'Task'), composePrompt({ instructions: '' }, 'Task'))
})

/* ------------------------------ subscription ------------------------------ */

await test('runBit (subscription): calls claude_delegate with prompt/model/effort/cwd/readOnly', async () => {
  const llm = fakeLlm()
  const tools = fakeTools()
  const runtime = createBitRuntime(fakeCtx({ llm, tools }), { models: createModelCatalog(fakeCtx({ llm })) })
  const bit = subscriptionBit({ workspaceDir: workspace })
  const result = await runtime.runBit({ bit, request: 'Implement the feature' })
  assert.equal(result.response, 'Claude response')
  assert.equal(result.meta.backend, 'claude-code')
  assert.equal(result.meta.model, 'subscription/sonnet')
  assert.equal(result.meta.effort, 'high')
  assert.equal(typeof result.meta.durationMs, 'number')
  assert.equal(tools.state.calls.length, 1)
  const call = tools.state.calls[0].calls[0]
  assert.equal(call.name, 'claude_delegate')
  const args = JSON.parse(call.arguments)
  assert.deepEqual(args, {
    task: 'You build with tests first.\n\n---\n\nImplement the feature',
    model: 'sonnet',
    effort: 'high',
    cwd: workspace,
    readOnly: true, // ad-hoc runs are read-only by default
  })
  // An explicit readOnly: false reaches the tool.
  await runtime.runBit({ bit, request: 'Implement', readOnly: false })
  assert.equal(JSON.parse(tools.state.calls[1].calls[0].arguments).readOnly, false)
  // The tool call carries a unique id and the request abort signal.
  const signal = new AbortController().signal
  await runtime.runBit({ bit, request: 'Implement', signal })
  assert.equal(tools.state.calls[2].signal, signal)
  assert.match(call.id, /^claude-delegate-/)
})

await test('runBit refuses orchestrators, validates the request and the cwd', async () => {
  const models = createModelCatalog(fakeCtx())
  const runtime = createBitRuntime(fakeCtx(), { models })
  await assert.rejects(runtime.runBit({ bit: subscriptionBit({ isOrchestrator: true }), request: 'x' }), (error) => codedOf(error) === 'BIT_IS_ORCHESTRATOR' && /flows/.test(error.message))
  await assert.rejects(runtime.runBit({ bit: subscriptionBit(), request: '   ' }), (error) => codedOf(error) === 'BOT_INVALID' && /request/.test(error.message))
  await assert.rejects(runtime.runBit({ bit: subscriptionBit(), request: 'x'.repeat(20001) }), (error) => codedOf(error) === 'BOT_INVALID')
  const bit = subscriptionBit({ workspaceDir: workspace })
  await assert.rejects(runtime.runBit({ bit, request: 'x', cwd: path.join(workspace, '..', 'outside') }), (error) => codedOf(error) === 'BOT_INVALID' && /workspace/.test(error.message))
  await assert.rejects(runtime.runBit({ bit, request: 'x', cwd: 'relative/dir' }), (error) => codedOf(error) === 'BOT_INVALID' && /absolute/.test(error.message))
  // A cwd inside the workspace is accepted and reaches the tool.
  const tools = fakeTools()
  const insideRuntime = createBitRuntime(fakeCtx({ tools }), { models })
  const nested = path.join(workspace, 'sub')
  await fs.mkdir(nested, { recursive: true })
  await insideRuntime.runBit({ bit, request: 'x', cwd: nested })
  assert.equal(JSON.parse(tools.state.calls[0].calls[0].arguments).cwd, nested)
})

await test('delegate unavailable/failed maps to BIT_DELEGATE_UNAVAILABLE with actionable text', async () => {
  const models = createModelCatalog(fakeCtx())
  const tools = fakeTools()
  tools.state.settle = (call) => ({
    results: [{ callId: call.id, result: { isError: true, error: { message: 'unknown tool "claude_delegate": install the plugin', info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } } } }],
  })
  const runtime = createBitRuntime(fakeCtx({ tools }), { models })
  await assert.rejects(runtime.runBit({ bit: subscriptionBit({ workspaceDir: workspace }), request: 'x' }), (error) => codedOf(error) === 'BIT_DELEGATE_UNAVAILABLE'
    && /@dsh-burn-plugins\/dsh-claude-delegate/.test(error.message)
    && /claude/.test(error.message)
    && /UNKNOWN_TOOL/.test(error.message))
  // The pipeline itself throws.
  const throwing = createBitRuntime({ llm: fakeLlm(), tools: { execute: async () => { throw new Error('tools executor offline') } } }, { models })
  await assert.rejects(throwing.runBit({ bit: subscriptionBit({ workspaceDir: workspace }), request: 'x' }), (error) => codedOf(error) === 'BIT_DELEGATE_UNAVAILABLE' && /offline/.test(error.message))
  // No tools service at all.
  const missing = createBitRuntime({ llm: fakeLlm() }, { models })
  await assert.rejects(missing.runBit({ bit: subscriptionBit({ workspaceDir: workspace }), request: 'x' }), (error) => codedOf(error) === 'BIT_DELEGATE_UNAVAILABLE')
})

/* --------------------------------- dsh --------------------------------- */

const dshBit = { id: 'bit-dsh', name: 'Analyst', isOrchestrator: false, instructions: 'Analyze the code.', model: 'deepseek-account/deepseek-flash', effort: 'high', workspaceDir: workspace }

await test('runBit (dsh): one-shot llm.stream, text-delta concatenation and metadata', async () => {
  const llm = fakeLlm({
    stream: () => (async function* () {
      yield { type: 'text-delta', index: 0, text: 'First ' }
      yield { type: 'text-delta', index: 0, text: 'response.' }
      yield { type: 'finish', reason: { kind: 'success' } }
    })(),
  })
  const tools = fakeTools()
  const runtime = createBitRuntime(fakeCtx({ llm, tools }), { models: createModelCatalog(fakeCtx({ llm })) })
  const result = await runtime.runBit({ bit: dshBit, request: 'Analyze the function X' })
  assert.equal(result.response, 'First response.')
  assert.deepEqual({ backend: result.meta.backend, model: result.meta.model, effort: result.meta.effort }, { backend: 'dsh', model: 'deepseek-account/deepseek-flash', effort: 'high' })
  assert.equal(llm.counts.stream, 1)
  assert.equal(tools.state.calls.length, 0, 'no tools on the DSH path')
  const options = llm.calls.stream[0]
  assert.equal(options.provider, 'deepseek-account')
  assert.equal(options.model, 'deepseek-flash')
  assert.equal(options.reasoningEffort, 'high')
  assert.deepEqual(options.messages, [{ role: 'user', content: [{ type: 'text', text: 'Analyze the code.\n\n---\n\nAnalyze the function X' }] }])
})

await test('runBit (dsh): the runtime finish vocabulary is understood (stop success, failures coded)', async () => {
  // dsh-llm 0.2.2-rc.1 reports a successful stop as `{ kind: 'stop' }`.
  const stopRuntime = createBitRuntime(fakeCtx({
    llm: fakeLlm({
      stream: () => (async function* () {
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    }),
  }), { models: createModelCatalog(fakeCtx()) })
  assert.equal((await stopRuntime.runBit({ bit: dshBit, request: 'x' })).response, 'ok')
  const truncated = createBitRuntime(fakeCtx({
    llm: fakeLlm({
      stream: () => (async function* () {
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      })(),
    }),
  }), { models: createModelCatalog(fakeCtx()) })
  await assert.rejects(truncated.runBit({ bit: dshBit, request: 'x' }), (error) => codedOf(error) === 'BIT_MODEL_CALL_FAILED' && /max-tokens/.test(error.message))
})

await test('runBit (dsh): a failed finish chunk or a throwing stream maps to BIT_MODEL_CALL_FAILED', async () => {
  const failedFinish = createBitRuntime(fakeCtx({
    llm: fakeLlm({
      stream: () => (async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial' }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider timeout', code: 'TIMEOUT' } } }
      })(),
    }),
  }), { models: createModelCatalog(fakeCtx()) })
  await assert.rejects(failedFinish.runBit({ bit: dshBit, request: 'x' }), (error) => codedOf(error) === 'BIT_MODEL_CALL_FAILED' && /provider timeout/.test(error.message) && /TIMEOUT/.test(error.message))
  const aborted = createBitRuntime(fakeCtx({
    llm: fakeLlm({
      stream: () => (async function* () {
        yield { type: 'finish', reason: { kind: 'aborted' } }
      })(),
    }),
  }), { models: createModelCatalog(fakeCtx()) })
  await assert.rejects(aborted.runBit({ bit: dshBit, request: 'x' }), (error) => codedOf(error) === 'BIT_MODEL_CALL_FAILED')
  const throwing = createBitRuntime(fakeCtx({ llm: fakeLlm({ stream: () => { throw new Error('adapter exploded') } }) }), { models: createModelCatalog(fakeCtx()) })
  await assert.rejects(throwing.runBit({ bit: dshBit, request: 'x' }), (error) => codedOf(error) === 'BIT_MODEL_CALL_FAILED' && /adapter exploded/.test(error.message))
})

/* ------------------------------ delegation path ------------------------------ */

await test('invokeWorker: one-shot with readOnly/cwd from the team and the same prompt composition', async () => {
  const llm = fakeLlm()
  const tools = fakeTools()
  const runtime = createBitRuntime(fakeCtx({ llm, tools }), { models: createModelCatalog(fakeCtx({ llm })) })
  const teamCwd = await tempDir('dsh-bits-br-team-')
  const result = await runtime.invokeWorker({ bit: subscriptionBit(), task: 'Run the tests', cwd: teamCwd, readOnly: true })
  assert.equal(result.text, 'Claude response')
  assert.equal(result.meta.model, 'subscription/sonnet')
  const args = JSON.parse(tools.state.calls[0].calls[0].arguments)
  assert.equal(args.task, 'You build with tests first.\n\n---\n\nRun the tests')
  assert.equal(args.cwd, teamCwd)
  assert.equal(args.readOnly, true)
  // A worker bit never goes through the child-agent path.
  await assert.rejects(runtime.invokeWorker({ bit: subscriptionBit({ isOrchestrator: true }), task: 'x' }), (error) => codedOf(error) === 'BIT_IS_ORCHESTRATOR')
  await assert.rejects(runtime.invokeWorker({ bit: subscriptionBit(), task: '  ' }), (error) => codedOf(error) === 'BAD_REQUEST')
  // listModels is the catalog (`GET /api/bots.models`).
  const listed = await runtime.listModels()
  assert.equal(listed.models.length, 4)
})

for (const dir of temps) await fs.rm(dir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\nbit-runtime: ${failures.length} failed, ${passed} passed`)
  process.exitCode = 1
} else {
  console.log(`\nbit-runtime: ${passed} tests passed`)
}
