import assert from 'node:assert/strict'
import { cleanText, createNotifier, gdbusArgs, notifySendArgs } from '../host/notify.js'

let passed = 0
async function test(name, fn) {
  await fn()
  passed += 1
  console.log(`ok - ${name}`)
}

/** Fake process runner recording calls; outcomes are consumed in order. */
function fakeRunner(outcomes) {
  const calls = []
  return {
    calls,
    run: async (command, args) => {
      calls.push([command, args])
      return outcomes.shift() ?? { code: 0, stderr: '', error: null }
    },
  }
}

await test('notify-send argv keeps model text after the -- guard', async () => {
  const args = notifySendArgs({ title: '--help', body: '-u critical; rm -rf ~', urgency: 'normal', appName: 'App', icon: '/x/icon.svg' })
  assert.deepEqual(args, ['--app-name', 'App', '--urgency', 'normal', '--icon', '/x/icon.svg', '--', '--help', '-u critical; rm -rf ~'])
})

await test('gdbus argv quotes text as GVariant string literals', async () => {
  const args = gdbusArgs({ title: 'Lembrete "café"', body: 'linha 1\nlinha \\2', urgency: 'critical', appName: 'App' })
  assert.equal(args[args.indexOf('org.freedesktop.Notifications.Notify') + 4], '"Lembrete \\"café\\""')
  assert.equal(args[args.indexOf('org.freedesktop.Notifications.Notify') + 5], '"linha 1\\nlinha \\\\2"')
  assert.ok(args.includes('{"urgency": <byte 2>}'))
})

await test('cleanText strips control characters and bounds length', async () => {
  assert.equal(cleanText('a\u0007b\u001bc', 50), 'a b c')
  assert.equal(cleanText('keep\nnewlines', 50), 'keep\nnewlines')
  const long = cleanText('x'.repeat(200), 10)
  assert.equal([...long].length, 10)
  assert.ok(long.endsWith('…'))
})

await test('notify uses notify-send first and reports the method', async () => {
  const runner = fakeRunner([{ code: 0, stderr: '', error: null }])
  const notifier = createNotifier({ appName: 'App', run: runner.run })
  const result = await notifier.notify({ title: '🤖 Bot', body: 'Hora da reunião', urgency: 'critical' })
  assert.deepEqual(result, { ok: true, method: 'notify-send', error: null })
  assert.equal(runner.calls.length, 1)
  assert.equal(runner.calls[0][0], 'notify-send')
  assert.ok(runner.calls[0][1].includes('critical'))
})

await test('notify falls back to gdbus and normalizes bad urgency', async () => {
  const runner = fakeRunner([{ code: null, stderr: '', error: new Error('spawn notify-send ENOENT') }, { code: 0, stderr: '', error: null }])
  const notifier = createNotifier({ appName: 'App', run: runner.run })
  const result = await notifier.notify({ title: 'T', body: 'B', urgency: 'extreme' })
  assert.deepEqual(result, { ok: true, method: 'gdbus', error: null })
  assert.equal(runner.calls[1][0], 'gdbus')
  assert.ok(runner.calls[1][1].includes('{"urgency": <byte 1>}'))
})

await test('notify reports both failures without throwing', async () => {
  const runner = fakeRunner([{ code: 1, stderr: 'no server', error: null }, { code: 1, stderr: 'no bus', error: null }])
  const notifier = createNotifier({ run: runner.run })
  const result = await notifier.notify({ title: 'T', body: 'B' })
  assert.equal(result.ok, false)
  assert.match(result.error, /notify-send: no server; gdbus: no bus/)
})

console.log(`\nnotify: ${passed} tests passed`)
