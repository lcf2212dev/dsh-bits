/**
 * Desktop notifications for bots.
 *
 * Sends one notification to the user's desktop session through the
 * freedesktop notification service: `notify-send` when present, otherwise a
 * direct `gdbus` call to `org.freedesktop.Notifications.Notify`. Every child
 * process is spawned with an argv array (never a shell string) and bounded by
 * a timeout, so model-supplied text cannot inject commands or hang the Host.
 *
 * @module @local/dsh-bots/host/notify
 */

import { spawn } from 'node:child_process'

/** Longest title/body accepted; notification servers truncate long text anyway. */
export const MAX_TITLE = 120
export const MAX_BODY = 1000
/** Upper bound for one notification child process. */
const NOTIFY_TIMEOUT_MS = 5000
const URGENCIES = new Set(['low', 'normal', 'critical'])
/** freedesktop urgency byte values for the gdbus fallback. */
const URGENCY_BYTE = { low: 0, normal: 1, critical: 2 }

/**
 * Trim and bound one notification field; strip control characters except newlines.
 *
 * @param {unknown} value candidate text.
 * @param {number} max maximum length in code points.
 * @returns {string} sanitized text.
 */
export function cleanText(value, max) {
  const text = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .trim()
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text
}

/**
 * Run one bounded child process.
 *
 * @param {string} command executable.
 * @param {string[]} args argv.
 * @returns {Promise<{ code: number | null, stderr: string, error: Error | null }>} outcome; never rejects.
 */
function runBounded(command, args) {
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    let child
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    try {
      child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], env: process.env })
    } catch (error) {
      resolve({ code: null, stderr: '', error })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ code: null, stderr, error: new Error(`${command} timed out after ${NOTIFY_TIMEOUT_MS} ms`) })
    }, NOTIFY_TIMEOUT_MS)
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += String(chunk)
    })
    child.on('error', (error) => finish({ code: null, stderr, error }))
    child.on('close', (code) => finish({ code, stderr, error: null }))
  })
}

/**
 * Build the `notify-send` argv.
 *
 * @param {{ title: string, body: string, urgency: string, appName: string, icon?: string }} note notification.
 * @returns {string[]} argv (the `--` guard keeps text from being read as options).
 */
export function notifySendArgs(note) {
  const args = ['--app-name', note.appName, '--urgency', note.urgency]
  if (note.icon) args.push('--icon', note.icon)
  args.push('--', note.title, note.body)
  return args
}

/**
 * Build the `gdbus` fallback argv for `org.freedesktop.Notifications.Notify`.
 *
 * GVariant text literals are produced with JSON string escaping, which GVariant
 * accepts for double-quoted strings, so quotes and backslashes in model text
 * stay inside the literal.
 *
 * @param {{ title: string, body: string, urgency: string, appName: string, icon?: string }} note notification.
 * @returns {string[]} argv.
 */
export function gdbusArgs(note) {
  const literal = (text) => JSON.stringify(text)
  return [
    'call', '--session',
    '--dest', 'org.freedesktop.Notifications',
    '--object-path', '/org/freedesktop/Notifications',
    '--method', 'org.freedesktop.Notifications.Notify',
    literal(note.appName), '0', literal(note.icon ?? ''), literal(note.title), literal(note.body),
    '[]', `{"urgency": <byte ${URGENCY_BYTE[note.urgency]}>}`, '-1',
  ]
}

/**
 * Create a notifier bound to its configuration.
 *
 * @param {object} [options] notifier options.
 * @param {string} [options.appName] application name shown by the desktop.
 * @param {string} [options.icon] absolute icon path.
 * @param {(command: string, args: string[]) => Promise<{ code: number | null, stderr: string, error: Error | null }>} [options.run] process runner (tests).
 * @returns {{ notify: (input: { title: unknown, body: unknown, urgency?: unknown }) => Promise<{ ok: boolean, method: string | null, error: string | null }> }} notifier.
 */
export function createNotifier({ appName = 'DeepSeek Harness · Bots', icon, run = runBounded } = {}) {
  return {
    async notify(input) {
      const title = cleanText(input.title, MAX_TITLE) || appName
      const body = cleanText(input.body, MAX_BODY)
      const urgency = typeof input.urgency === 'string' && URGENCIES.has(input.urgency) ? input.urgency : 'normal'
      const note = { title, body, urgency, appName, icon }
      const errors = []
      const viaNotifySend = await run('notify-send', notifySendArgs(note))
      if (viaNotifySend.error === null && viaNotifySend.code === 0) return { ok: true, method: 'notify-send', error: null }
      errors.push(`notify-send: ${viaNotifySend.error?.message ?? (viaNotifySend.stderr.trim() || `exit ${viaNotifySend.code}`)}`)
      const viaGdbus = await run('gdbus', gdbusArgs(note))
      if (viaGdbus.error === null && viaGdbus.code === 0) return { ok: true, method: 'gdbus', error: null }
      errors.push(`gdbus: ${viaGdbus.error?.message ?? (viaGdbus.stderr.trim() || `exit ${viaGdbus.code}`)}`)
      return { ok: false, method: null, error: errors.join('; ') }
    },
  }
}
