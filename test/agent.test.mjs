import assert from 'node:assert/strict'
import { installBotAgents, buildPersonaText, renderVmExecResult } from '../host/agent.js'

/** Minimal Cordis-like context recording every registration the integration makes. */
function fakeCtx() {
  const events = new Map()
  const tools = []
  const agents = []
  const ctx = {
    logger: { warn: () => {} },
    workingDirectory: { get: (session) => session.cwd },
    agents: { list: () => agents },
    tools: {
      register(definition, options) {
        tools.push({ definition, options })
        return () => {
          tools.splice(tools.findIndex((entry) => entry.definition === definition), 1)
        }
      },
      guard(guard) {
        tools.guards.push(guard)
        return () => {
          const index = tools.guards.indexOf(guard)
          if (index >= 0) tools.guards.splice(index, 1)
        }
      },
    },
    on(event, listener) {
      events.set(event, listener)
      return () => events.delete(event)
    },
    effects: [],
    effect(setup) {
      const dispose = setup()
      ctx.effects.push(dispose)
      return dispose
    },
  }
  tools.guards = []
  return { ctx, events, tools, agents }
}

/** Minimal live-agent stand-in with a scoped-context surface. */
function fakeAgent(id, cwd) {
  const personaLabels = []
  const restrictions = []
  const disposers = []
  const agent = {
    id,
    session: { id: `session-${id}`, cwd },
    ctx: {
      systemPrompt: {
        section(section) {
          personaLabels.push(section)
          const dispose = () => {
            const index = personaLabels.indexOf(section)
            if (index >= 0) personaLabels.splice(index, 1)
          }
          disposers.push(dispose)
          return dispose
        },
      },
      tools: {
        get(name) {
          return ['bash', 'pwsh'].includes(name) ? { name } : undefined
        },
        restrict(filter) {
          restrictions.push(filter)
          const dispose = () => {
            const index = restrictions.indexOf(filter)
            if (index >= 0) restrictions.splice(index, 1)
          }
          disposers.push(dispose)
          return dispose
        },
      },
    },
    personaLabels,
    restrictions,
    disposers,
  }
  return agent
}

/** Flush pending microtasks so the `ready.then(...)` scan completes. */
async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

/** @returns {object} one bot record fixture. */
function bot(overrides = {}) {
  return {
    id: 'a1b2c3d4e5',
    name: 'Pesquisador',
    emoji: '🕵️',
    color: '#7c3aed',
    instructions: 'Você é um pesquisador meticuloso.',
    workspaceDir: '/tmp/bots/a1b2c3d4e5/workspace',
    vm: { enabled: true, image: 'ubuntu:24.04' },
    createdAt: '2026-11-08T20:00:00.000Z',
    updatedAt: '2026-11-08T20:00:00.000Z',
    ...overrides,
  }
}

async function testPersonaText() {
  const withVm = buildPersonaText(bot(), true)
  assert.match(withVm, /Bot identity: Pesquisador/)
  assert.match(withVm, /🕵️/)
  assert.match(withVm, /Você é um pesquisador meticuloso\./)
  assert.match(withVm, /vm_bash/)
  assert.match(withVm, /dsh-bot-a1b2c3d4e5/)
  assert.match(withVm, /ubuntu:24\.04/)
  assert.match(withVm, /\/tmp\/bots\/a1b2c3d4e5\/workspace/)
  const withoutVm = buildPersonaText(bot({ instructions: '' }), false)
  assert.match(withoutVm, /Bot identity: Pesquisador/)
  assert.doesNotMatch(withoutVm, /vm_bash/)
  assert.match(withoutVm, /no VM/)
  const withoutInstructions = buildPersonaText(bot({ instructions: '   ' }), false)
  assert.doesNotMatch(withoutInstructions, /standing instructions/)
  console.log('ok persona text')
}

async function testRenderVmExecResult() {
  assert.equal(renderVmExecResult({ stdout: 'hello\n', stderr: '', exitCode: 0, timedOut: false, truncated: false, signal: null }), 'hello\n')
  assert.equal(renderVmExecResult({ stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, signal: null }), '(no output)')
  assert.equal(
    renderVmExecResult({ stdout: 'out', stderr: 'err', exitCode: 2, timedOut: false, truncated: false, signal: null }),
    'out\n[stderr]\nerr\n[exit code: 2]',
  )
  assert.equal(
    renderVmExecResult({ stdout: '', stderr: '', exitCode: null, timedOut: true, truncated: false, signal: 'SIGTERM' }),
    '(no output)\n[timed out in the bot VM]',
  )
  assert.equal(
    renderVmExecResult({ stdout: 'x', stderr: '', exitCode: 137, timedOut: false, truncated: true, signal: 'SIGKILL' }),
    'x\n[output truncated]\n[killed by signal: SIGKILL]',
  )
  console.log('ok vm exec rendering')
}

async function testAgentIntegration() {
  const { ctx, events, tools, agents } = fakeCtx()
  const records = new Map()
  const vmBot = bot()
  const plainBot = bot({
    id: 'ffffffffff',
    name: 'Escritor',
    workspaceDir: '/tmp/bots/ffffffffff/workspace',
    vm: { enabled: false, image: 'ubuntu:24.04' },
  })
  records.set(vmBot.workspaceDir, vmBot)
  records.set(plainBot.workspaceDir, plainBot)
  const store = {
    getByWorkspace: (dir) => records.get(dir),
    get: (id) => [...records.values()].find((entry) => entry.id === id),
    set: (record) => records.set(record.workspaceDir, record),
  }
  const calls = []
  const vm = {
    ensure: async (record) => {
      calls.push(['ensure', record.id])
      return { running: true, state: 'running' }
    },
    exec: async (record, request) => {
      calls.push(['exec', record.id, request.command, request.workdir])
      return { stdout: 'vm says hi\n', stderr: '', exitCode: 0, timedOut: false, truncated: false, signal: null }
    },
  }
  const integration = installBotAgents(ctx, { store, vm, ready: Promise.resolve(), log: () => {} })

  const vmAgent = fakeAgent('agent-vm', vmBot.workspaceDir)
  const plainAgent = fakeAgent('agent-plain', plainBot.workspaceDir)
  const strangerAgent = fakeAgent('agent-host', '/tmp/elsewhere')
  agents.push(vmAgent, plainAgent, strangerAgent)
  await flush()

  assert.equal(vmAgent.personaLabels.length, 1, 'VM bot agent got no persona section')
  const personaSection = vmAgent.personaLabels[0]
  assert.equal(personaSection.interpolate, false, 'persona section must not interpolate user text (B1 regression)')
  assert.equal(typeof personaSection.text, 'function', 'persona text must resolve the live record')
  assert.match(personaSection.text(), /vm_bash/)
  // Regression for B1: literal `{{...}}` in user-authored instructions must survive.
  store.set(bot({ id: 'a1b2c3d4e5', instructions: 'Responda como {{nome}} e cite {{fonte}}.' }))
  assert.match(personaSection.text(), /\{\{nome\}\}/)
  assert.match(personaSection.text(), /\{\{fonte\}\}/)
  store.set(vmBot)
  assert.equal(vmAgent.restrictions.length, 1, 'VM bot agent got no shell restriction')
  assert.deepEqual(vmAgent.restrictions[0].deny, ['bash', 'pwsh'])

  assert.equal(plainAgent.personaLabels.length, 1, 'plain bot agent got no persona section')
  assert.doesNotMatch(plainAgent.personaLabels[0].text(), /vm_bash/)
  assert.equal(plainAgent.restrictions.length, 0, 'plain bot agent must keep the host shell')
  assert.equal(strangerAgent.personaLabels.length, 0, 'non-bot agent got a persona section')

  assert.equal(tools.length, 1, 'vm_bash was not registered exactly once')
  assert.equal(tools.guards.length, 1, 'host shell guard was not registered')
  const guard = tools.guards[0]
  assert.match(String(guard({ name: 'bash', agent: vmAgent })), /use the vm_bash tool/)
  assert.equal(guard({ name: 'bash', agent: plainAgent }), undefined)
  assert.equal(guard({ name: 'read', agent: vmAgent }), undefined)
  assert.equal(guard({ name: 'bash', agent: strangerAgent }), undefined)

  const registered = tools[0]
  assert.equal(registered.definition.name, 'vm_bash')
  const when = registered.options.when
  assert.equal(when({ agent: vmAgent }), true)
  assert.equal(when({ agent: plainAgent }), false)
  assert.equal(when({ agent: strangerAgent }), false)
  assert.equal(when({}), false)

  const text = await registered.definition.execute({ command: 'echo hi' }, { agent: vmAgent, signal: new AbortController().signal })
  assert.match(text, /vm says hi/)
  assert.deepEqual(calls, [
    ['ensure', 'a1b2c3d4e5'],
    ['exec', 'a1b2c3d4e5', 'echo hi', vmBot.workspaceDir],
  ])

  // Unknown agent and plain bot are rejected.
  await assert.rejects(registered.definition.execute({ command: 'x' }, { agent: strangerAgent }), /only available inside a bot session/)
  await assert.rejects(registered.definition.execute({ command: 'x' }, { agent: plainAgent }), /no VM enabled/)

  // Agent disposal and plugin unload remove contributions.
  events.get('agent/disposed')({ agent: vmAgent })
  assert.equal(vmAgent.personaLabels.length, 0)
  assert.equal(vmAgent.restrictions.length, 0)
  integration.dispose()
  assert.equal(tools.length, 0, 'vm_bash survived plugin disposal')
  console.log('ok agent integration')
}

async function testNewAgentsAfterLoad() {
  const { ctx, events, tools, agents } = fakeCtx()
  const record = bot({ id: '1122334455', workspaceDir: '/tmp/bots/1122334455/workspace' })
  const store = { getByWorkspace: (dir) => (dir === record.workspaceDir ? record : undefined) }
  const vm = { ensure: async () => ({ running: true }), exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, signal: null }) }
  const integration = installBotAgents(ctx, { store, vm, ready: Promise.resolve(), log: () => {} })
  await flush()
  agents.push(fakeAgent('new-agent', record.workspaceDir))
  const created = events.get('agent/created')
  assert.equal(typeof created, 'function')
  await created({ agent: agents[0] })
  assert.equal(agents[0].personaLabels.length, 1)
  assert.deepEqual(tools[0].options.when({ agent: agents[0] }), true)
  integration.dispose()
  console.log('ok agents created after plugin load')
}

async function testVmToggleOnLiveAgent() {
  const { ctx, events, tools, agents } = fakeCtx()
  const record = bot({ id: '99aabbccdd', name: 'Alternador', workspaceDir: '/tmp/bots/99aabbccdd/workspace', vm: { enabled: false, image: 'ubuntu:24.04' } })
  const records = new Map([[record.workspaceDir, record]])
  const store = {
    getByWorkspace: (dir) => records.get(dir),
    get: (id) => [...records.values()].find((entry) => entry.id === id),
    set: (next) => records.set(next.workspaceDir, next),
  }
  const vm = { ensure: async () => ({ running: true }), exec: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, signal: null }) }
  const integration = installBotAgents(ctx, { store, vm, ready: Promise.resolve(), log: () => {} })
  await flush()
  const agent = fakeAgent('toggle-agent', record.workspaceDir)
  agents.push(agent)
  await events.get('agent/created')({ agent })
  assert.equal(agent.personaLabels.length, 1)
  assert.equal(agent.restrictions.length, 0, 'non-VM bot must keep the host shell')
  assert.doesNotMatch(agent.personaLabels[0].text(), /vm_bash/)

  // User enables the VM in the Bots page; routes call onBotChanged -> refreshBot.
  store.set({ ...record, vm: { enabled: true, image: 'ubuntu:24.04' } })
  const refreshed = integration.refreshBot(record.id)
  assert.equal(refreshed, 1, 'refreshBot did not refresh the live agent')
  assert.equal(agent.restrictions.length, 1, 'VM enable did not restrict the host shell')
  assert.deepEqual(agent.restrictions[0].deny, ['bash', 'pwsh'])
  assert.match(agent.personaLabels[0].text(), /vm_bash/)
  assert.equal(tools[0].options.when({ agent }), true)

  // User disables the VM again: the agent gets its host shell back.
  store.set({ ...record, vm: { enabled: false, image: 'ubuntu:24.04' } })
  integration.refreshBot(record.id)
  assert.equal(agent.restrictions.length, 0, 'VM disable did not lift the host shell restriction')
  assert.doesNotMatch(agent.personaLabels[0].text(), /vm_bash/)
  assert.equal(tools[0].options.when({ agent }), false)

  integration.dispose()
  console.log('ok VM toggle refresh on live agent')
}

async function testNotifyTool() {
  const { ctx, tools, agents } = fakeCtx()
  const record = bot({ id: 'abcabcabca', name: 'Lembrador', emoji: '⏰', workspaceDir: '/tmp/bots/abcabcabca/workspace', vm: { enabled: false, image: 'ubuntu:24.04' } })
  const records = new Map([[record.workspaceDir, record]])
  const store = { getByWorkspace: (dir) => records.get(dir), get: (id) => [...records.values()].find((entry) => entry.id === id) }
  const sent = []
  const notifier = { notify: async (note) => { sent.push(note); return { ok: true, method: 'notify-send', error: null } } }
  const integration = installBotAgents(ctx, { store, vm: {}, ready: Promise.resolve(), log: () => {}, notifier })
  await flush()
  const botAgent = fakeAgent('bot-agent', record.workspaceDir)
  const stranger = fakeAgent('plain-agent', '/tmp/not-a-bot')
  agents.push(botAgent, stranger)

  const entry = tools.find((item) => item.definition.name === 'notify_user')
  assert.ok(entry, 'notify_user was not registered')
  assert.equal(entry.options.when({ agent: botAgent }), true)
  assert.equal(entry.options.when({ agent: stranger }), false)
  assert.deepEqual(entry.definition.parameters.required, ['message'])

  const text = await entry.definition.execute({ message: 'Hora de tomar água', urgency: 'critical' }, { agent: botAgent })
  assert.match(text, /notify-send/)
  assert.deepEqual(sent[0], { title: '⏰ Lembrador', body: 'Hora de tomar água', urgency: 'critical' })
  await entry.definition.execute({ message: 'x', title: 'Reunião' }, { agent: botAgent })
  assert.equal(sent[1].title, '⏰ Lembrador · Reunião')
  await assert.rejects(entry.definition.execute({ message: 'x' }, { agent: stranger }), /only available inside a bot session/)

  notifier.notify = async () => ({ ok: false, method: null, error: 'no notification server' })
  await assert.rejects(entry.definition.execute({ message: 'x' }, { agent: botAgent }), /notify_user failed: no notification server/)

  // The persona teaches scheduling + reminder delivery.
  const persona = buildPersonaText(record, false)
  assert.match(persona, /schedule_create/)
  assert.match(persona, /notify_user/)
  assert.match(persona, /Scheduled reminder:/)

  integration.dispose()
  assert.equal(tools.some((item) => item.definition.name === 'notify_user'), false, 'notify_user survived plugin disposal')
  console.log('ok notify_user tool + scheduling persona')
}

await testPersonaText()
await testRenderVmExecResult()
await testAgentIntegration()
await testNewAgentsAfterLoad()
await testVmToggleOnLiveAgent()
await testNotifyTool()
console.log('\nagent tests PASS')
