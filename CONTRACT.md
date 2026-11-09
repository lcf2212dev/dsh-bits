# Bots plugin — build contract (read first)

A DeepSeek Harness (DSH) **bundle** that adds "Bots": named AI teammates, each with a
persona, a dedicated workspace directory, and optionally its own **Docker VM** (a
persistent Linux container) where its shell commands run. Chatting with a bot opens a
normal DSH session in the bot's workspace; a system-prompt section carries the persona;
for VM bots the host `bash` tool is hidden and replaced by `vm_bash`, which executes
inside the bot's container.

Target installation: the running DSH Desktop app, profile `desktop`
(`http://127.0.0.1:46181`). The Lead installs the finished bundle with the
`plugin_manager` tool (`action: install_bundle`, target = the absolute package
directory). **Teammates never install, enable, or modify the profile.**

Workspace root: `<workspace>`
Bundle directory: `<workspace>/bots-plugin/` (this directory).

---

## 1. Bundle layout

```
bots-plugin/
  package.json          (Lead)
  cordis.patch.yml      (Lead)
  icon.svg              (Lead)
  locale/en.json        (Lead)  bundle display metadata only
  locale/pt.json        (Lead)
  index.js              (Lead)  host plugin entry: apply(ctx, config)
  host/store.js         (host-store worker: task-1)
  host/routes.js        (host-store worker: task-1)
  host/vm.js            (vm worker: task-2)
  host/agent.js         (Lead)  per-agent persona/VM integration + vm_bash tool
  client.js             (ui worker: task-3)
  test/                 (workers: tests they own)
  README.md             (Lead)
```

Rules: plain ESM (`"type": "module"`), Node built-ins only (no npm packages, no
`@deepseek-ai/*` imports). Host modules are imported by `index.js` by relative path and
must have no side effects at import time. Tests run with plain `node` (v24 on PATH).

Only edit the files assigned to you. If a contract change is needed, message the Lead (`lead`)
instead of editing another owner's file.

## 2. Bot record and views

Persisted record (JSON in `$DSH_HOME/bots/bots.json`, `$DSH_HOME` = `~/.dsh`):

```json
{
  "statusVersion": 1,
  "bots": [
    {
      "id": "3f9a1c2b7e",
      "name": "Pesquisador",
      "emoji": "🤖",
      "color": "#7c3aed",
      "instructions": "Você é o Pesquisador...",
      "workspaceDir": "~/.dsh/bots/3f9a1c2b7e/workspace",
      "vm": { "enabled": true, "image": "ubuntu:24.04" },
      "createdAt": "2026-11-08T20:00:00.000Z",
      "updatedAt": "2026-11-08T20:00:00.000Z"
    }
  ]
}
```

- `id`: 10 lowercase hex chars (`crypto.randomBytes(5).toString('hex')`).
- `name`: trimmed, 1..60 chars, required.
- `emoji`: 1..8 chars, default `🤖`.
- `color`: `#rrggbb`, from a fixed palette chosen by store when omitted.
- `instructions`: 0..20000 chars (persona / system instructions), default `""`.
- `workspaceDir`: absolute; default `<botsRoot>/<id>/workspace`; must never escape
  `botsRoot` for destructive operations.
- `vm.enabled`: boolean; `vm.image`: non-empty docker image reference, default
  `ubuntu:24.04` (validated with `/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/`).

`BotView` = record + live additions used by routes/UI:

```json
{
  "...record fields...",
  "workspaceId": "workspace id string or null",
  "workspaceError": "message or null",
  "vmStatus": {
    "id": "3f9a1c2b7e",
    "containerName": "dsh-bot-3f9a1c2b7e",
    "enabled": true,
    "state": "running | created | exited | stopped | paused | missing | unavailable | error",
    "running": true,
    "image": "ubuntu:24.04",
    "startedAt": "ISO or null",
    "exitCode": 0,
    "detail": "extra docker state text or null",
    "error": "message or null"
  }
}
```

`containerName` is always `dsh-bot-<id>`; containers carry labels
`dsh.bots.managed=true`, `dsh.bots.id=<id>`, `dsh.bots.workspace=<workspaceDir>`.

## 3. `host/store.js` — `BotStore` (task-1)

```js
export class BotStore {
  constructor({ botsRoot, defaultImage = 'ubuntu:24.04' })
  get botsRoot()                 // absolute
  get file()                     // <botsRoot>/bots.json
  async init()                   // mkdir -p botsRoot; load harness file; corrupt file -> rename to bots.json.corrupt-<ts> and start empty (never throw for corrupt JSON; throw for unreadable dir/permission)
  list()                         // deep-copied array, stable creation order
  get(id)                        // deep copy or undefined
  getByWorkspace(dir)            // canonical-ish compare (path.resolve both sides); folder name of the bot dir may be a symlink target — also compare realpath when available
  async create({ name, emoji, color, instructions, vm, workspaceDir } = {})
  async update(id, patch)        // patch: { name?, emoji?, color?, instructions?, vm?: { enabled?, image? } }; unknown id -> throw coded error; returns updated copy
  async remove(id, { deleteWorkspace = false } = {})  // returns removed record copy; deletes record then optionally removes workspace dir recursively but only if it resolves inside botsRoot (refuse otherwise, throw BOT_WORKSPACE_OUTSIDE_ROOT)
  async ensureWorkspace(record)  // mkdir -p(workspaceDir); returns absolute path
  async flush()                  // atomic write: tmp file + rename, mode 0600, dir 0700
}
```

Errors: throw `Error` with a stable `code` property: `BOT_NOT_FOUND`,
`BOT_INVALID_NAME`, `BOT_INVALID_IMAGE`, `BOT_WORKSPACE_OUTSIDE_ROOT`,
`BOT_ID_EXISTS` (id collision cannot happen in practice; only if create is given one),
`BOT_INVALID_PATCH` (unknown/immutable fields). All public mutators persist before
resolving. JSON writes are serialized (one write at a time); concurrent `update()` calls
must not lose each other. `list()/get()` must return copies so callers cannot mutate the
store in memory.

## 4. `host/vm.js` — `BotVm` (task-2)

```js
export class BotVm {
  constructor({ dockerBin = 'docker', defaultImage = 'ubuntu:24.04', pullMissingImage = false,
                execTimeoutMs = 120000, maxExecTimeoutMs = 600000, maxOutputBytes = 65536,
                network = null, extraRunArgs = [] })
  containerName(recordOrId)                 // 'dsh-bot-<id>'
  async available()                         // { available: bool, version: string|null, error: string|null }
  async listImages()                        // [{ name, tag, id, size, reference }] (local images only)
  async status(record)                      // VmStatus (see below)
  async statuses(records)                   // Map/plain object keyed by id -> VmStatus (one `docker ps -a`-based probe if practical; per-record is allowed)
  async ensure(record, { signal } = {})     // create if missing + start if not running; returns VmStatus; throws coded errors
  async start(record), stop(record), restart(record), remove(record)   // remove only the container, never the workspace dir; missing container is not an error for remove/stop
  async exec(record, { command, workdir, timeoutMs, signal, env })    // ExecResult
  async pullImage(image, { signal } = {})   // { ok, detail }; uses docker pull with bounded timeout
  async dispose()                           // abort/cancel in-flight docker child processes
}
```

`VmStatus` fields exactly as in §2 `vmStatus`. `state` mapping: no container -> `missing`;
container running -> `running`; exited/stopped -> `exited`/`stopped`; paused -> `paused`;
docker unavailable -> `unavailable` (with `error`); unexpected failure -> `error`.

`ensure()` behavior:
- docker missing/unreachable -> throw `Error` code `VM_DOCKER_UNAVAILABLE`.
- image absent locally -> throw code `VM_IMAGE_MISSING` with message naming the image and
  `docker pull` (never pull implicitly even if `pullMissingImage` is set — only `pullImage()`
  pulls; `pullMissingImage: true` is reserved/ignored for now).
- create: `docker run -d --name <name> --label dsh.bots.managed=true --label dsh.bots.id=<id>
  --label dsh.bots.workspace=<dir> -w <workspaceDir> -v <workspaceDir>:<workspaceDir>
  [-e KEY=VAL ...] [--network <network>] <image> sleep infinity` (extraRunArgs appended).
  Ensure workspace dir exists first (fs.mkdir recursive).
- Name collision from a foreign container -> throw code `VM_NAME_CONFLICT` naming it
  (do not delete it).
- Reuse an existing managed container (same labels) by starting it.

`exec()` behavior:
- ensures the container is running first (`ensure`), then runs
  `docker exec -w <workdir> [-e K=V] <name> <shell> -lc <command>` where `<shell>` is
  `/bin/bash` if available in the container, otherwise `/bin/sh` (probe once per container,
  cache).
- `workdir` defaults to the bot workspace dir; must be absolute.
- Result: `{ exitCode, signal, stdout, stderr, timedOut, truncated, durationMs, containerName }`.
  stdout/stderr are captured separately; each capped at `maxOutputBytes` (set `truncated`
  when cut, append a short `[truncated]` marker); never reject for a nonzero exit, timeout or
  timeout kill. Reject only for infrastructure failures (docker spawn ENOENT, container
  creation failure) with a coded error.
- Deadline: kill the docker child (SIGTERM, then SIGKILL after ~2 s) and resolve with
  `timedOut: true`; classify the timeout before nonzero exit.
- Honour an external `signal` (abort kills and resolves with `timedOut: false` and
  `signal: 'aborted'` — or rejects with coded `VM_ABORTED`; document the choice in JSDoc and
  keep it consistent).
- All child processes bounded; `dispose()` cancels any in-flight ones.

No `--privileged`, never mount the Docker socket, default bridge network. All shell
arguments passed as argv arrays (never a shell string built from user data).

## 5. `host/routes.js` — `registerBotRoutes` (task-1)

```js
export function registerBotRoutes(ctx, deps) // returns disposer; registers all routes
// deps = {
//   store, vm, ready,                 // ready: Promise<void> resolving after store.init()
//   ensureWorkspaceId: async (record) => string|null,  // workspace registry, provided by Lead
//   log?: (message) => void,
// }
```

Registration API (host side, authenticated owner-only fetch routes):

```js
ctx.connection.fetch.register({
  path: '/api/bots.list',
  methods: ['GET'],
  requestBody: 'buffered',
  fetch: (request) => Promise.resolve(Response.json(payload)),
})
```

Every handler awaits `deps.ready` first, then runs. Every JSON response is
`{ ok: true, ... }` or `{ ok: false, error: { code, message } }`; **always HTTP 200** for
handler-level success/failure (the framework itself returns 404/403). Malformed JSON body
-> `{ ok: false, error: { code: 'BAD_REQUEST', message } }`. Unknown bot id -> code
`BOT_NOT_FOUND`. Wrap handlers so unexpected throws return code `INTERNAL` (log the real
error through `deps.log`), never crash the route.

Routes (paths are exact; methods as listed; body is JSON):

| path | method | request | response (besides `ok`) |
|---|---|---|---|
| `/api/bots.list` | GET | – | `{ bots: BotView[], docker: { available, version, error }, defaultImage }` |
| `/api/bots.create` | POST | `{ name, emoji?, color?, instructions?, vm?: { enabled?, image? } }` | `{ bot: BotView }` |
| `/api/bots.update` | POST | `{ id, patch: { name?, emoji?, color?, instructions?, vm?: { enabled?, image? } } }` | `{ bot: BotView }` |
| `/api/bots.delete` | POST | `{ id, deleteWorkspace?: boolean }` | `{ deleted: true, workspaceRemoved: boolean, workspaceDir }` (also removes the VM container best-effort) |
| `/api/bots.vm` | POST | `{ id, action: 'start'|'stop'|'restart'|'remove'|'status' }` | `{ bot: BotView }` |
| `/api/bots.images` | GET | – | `{ images: [...], defaultImage }` |
| `/api/bots.docker` | GET | – | `{ available, version, error }` |

`BotView` composition in routes: record + `workspaceId` (from `ensureWorkspaceId(record)`,
catch -> null + `workspaceError`) + `vmStatus` (from `deps.vm.status(record)`, catch ->
error status). `list` builds views for every bot; VM probes must be bounded (a slow/hanging
docker must not make the list unbounded: run per-bot statuses with a short overall timeout,
e.g. `Promise.all` where `vm.status` has bounded child timeouts; acceptable to degrade to
`state: 'unavailable'` on error). Delete must keep the record deleted even if container
removal fails. `vm action: 'remove'` only removes the container; the bot record and
workspace stay.

For tests: routes must be testable with a fake registrar object:
`const ctx = { connection: { fetch: { register: (route) => { routes.set(route.path, route); return () => {} } } } }`
plus fake `deps`. Export no other public API.

## 6. `host/agent.js` — per-agent integration (Lead)

Lead-owned. It resolves the bot by the agent's working directory
(`ctx.workingDirectory.ensure(agent)` then `store.getByWorkspace(cwd)`), registers on
`agent.ctx.inject(['systemPrompt','tools'], scope => ...)` a prompt section with the bot
persona (order 120, text includes name, instructions, and — when the VM is enabled — the VM
usage rules), and for VM bots restricts the host shell tools (`bash`, `pwsh`, and any known
`*_persistent`/terminal variants that exist) so `vm_bash` is the model's shell. It also
registers the global `vm_bash` tool with a `when` condition that is true only for agents of
a VM-enabled bot. Teammates do not edit this file; if `vm.js` needs changes to support it,
message the Lead.

## 7. `client.js` — Web UI (task-3)

Browser module format (exact wrapper; factory returns the plugin module):

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-bots',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // ...
    return { inject: [...], apply(ctx) { /* ... */ } }
  },
})
```

Module-level `inject` lists **service keys** (e.g. `['slots', 'locale', 'layout', 'uiWorkspace']`).
File must be self-contained ES2019-compatible JS (no JSX, no `import`, no top-level
`window` access outside the `__ModuleLoader__.load` call, no Harness package requires).

Registration (copy this shape):

```js
const PANEL_ID = 'bots'

exports.apply = function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { en, 'pt-BR': pt, pt }), 'bots: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ t }),          // props passed to the page component, optional
  }, BotsPage))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 5,
    locale: NS,
    label: () => t('panel'),
  }, BotsIcon))
}
```

The page component receives the registered `inject()` props (verify at runtime; the page may
also read services with `ctx.get(...)` held in a closure). Navigation to a bot chat is
`ctx.uiWorkspace.startSession(workspaceId)` (client service key `uiWorkspace`, already the
navigating New-Session path); select the panel initially with `ctx.layout.selectPanel(PANEL_ID)`
only from controls, never on load.

Page requirements (Portuguese-first with English fallback; all copy through `t`):
- Header: title "Bots", one-line description, primary `Novo bot` button, refresh button and
  Docker availability pill (green `Docker pronto` / red `Docker indisponível: …`).
- Empty state with explanation + create button. Loading skeleton/text. Error state with retry.
- Bot cards: emoji avatar with `color` background, name, persona excerpt (2–3 lines),
  workspace path (monospace, truncated), VM state badge (`Rodando`/`Desligada`/`Criada`/`Sem
  VM`/`Imagem ausente`/`Docker indisponível`), and actions: `Conversar` (primary; disabled
  without `workspaceId`), `Editar`, overflow menu or buttons for `Iniciar VM`, `Parar VM`,
  `Reiniciar VM`, `Remover VM`, `Excluir bot`.
- Create/edit dialog: name, emoji (text input + small preset palette), color palette,
  instructions textarea (8+ rows), VM toggle; when enabled, image `<select>` populated from
  `/api/bots.images` plus a free-text field for any image reference; inline validation and
  server error text; Escape/backdrop closes; focus first field on open; disable while saving.
- Delete confirmation: states that workspace files are kept unless "Também apagar os
  arquivos do workspace" is checked; names the bot; confirm button destructive.
- Toasts for success/failure (auto-dismiss ~4 s), one at a time is fine.
- Data access: plain `fetch('/api/bots.list')` etc. relative to the app origin (cookie auth
  is automatic); JSON helpers: `fetchJson(path, body)` and verify `{ ok }`.
- Poll `/api/bots.list` every 5 s only while the panel is visible (`ctx.layout.panelInfo`),
  and always after each action; keep the existing list while polling.
- Styling: inline `style` objects (or a single `<style>` React element) using only theme
  tokens: `var(--dsw-alias-bg-base)`, `--dsw-alias-bg-layer-1/2/3`,
  `--dsw-alias-label-primary/secondary/tertiary/caption`, `--dsw-alias-border-l1/l2/l3/l4`,
  `--dsw-alias-state-business-primary`, `--dsw-alias-state-success-primary`,
  `--dsw-alias-state-error-primary`, `--dsw-alias-state-warn-primary`,
  `--dsw-alias-interactive-bg-hover`, `--dsw-alias-interactive-bg-active`,
  `--dsw-alias-button-primary-fill`, `--dsw-alias-button-primary-hover`. Add fallbacks like
  `var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08))`. Rounded 8–12 px, 13–14 px body text,
  match the Plugins page layout (title, subtitle, content insets 20–24 px, cards with 1 px
  border and subtle background). Icon: 16×16 stroke SVG (`currentColor`).
- Accessibility: buttons are `<button>` with `aria-label` where icon-only, dialog has
  `role="dialog"` and `aria-modal="true"`, Escape closes, destructive actions confirm.

Locale dictionaries: keys at least `panel`, `title`, `subtitle`, `newBot`, `editBot`,
`chat`, `edit`, `delete`, `deleteTitle`, `deleteBody`, `deleteFiles`, `cancel`, `save`,
`saving`, `name`, `emoji`, `color`, `instructions`, `instructionsHint`, `vm`, `vmEnable`,
`vmImage`, `vmRunning`, `vmStopped`, `vmMissing`, `vmNoVm`, `vmStart`, `vmStop`,
`vmRestart`, `vmRemove`, `vmImageMissing`, `dockerUnavailable`, `dockerReady`, `workspace`,
`loading`, `empty`, `emptyHint`, `error`, `retry`, `confirm`, `deleted`, `saved`, `created`,
`failed`, `refresh`. Both `pt` and `en` complete.

The component must be robust to any response shape mismatch (guard arrays/objects) so a
host bug shows an error state instead of a blank slot (`slot entry crashed`).

## 8. Verification each worker must do

- `node --check <file>` for every JS file you write.
- Host modules: run your `node test/<name>.test.mjs` (own file) until green.
- Docker worker: real Docker E2E test as described in the task; ensure cleanup
  (`docker rm -f` test container, remove temp dir) even on failure.
- Do not run `dsh`, pnpm, or the plugin manager; do not modify the profile, `~/.dsh`,
  or files outside `bots-plugin/`.
- When done: mark your shared task complete with a short report (files, tests, output
  highlights, open questions) and message the Lead with the same.

## 9. Local references

Installed DSH packages (read the READMEs for exact API behavior; do not import them):

- `~/.local/opt/deepseek-harness/resources/app/dsh/node_modules/@deepseek-ai/`
  — e.g. `dsh-bash-local/README.md` + `lib/index.js` (shell semantics, output caps),
  `dsh-tool-bash`, `dsh-connection/…` for routes? (host connection is
  `dsh-client-connection`: see its README section "browser authentication and request trust"),
  `dsh-client-ui-plugin-manager/README.md` (management page reference),
  `dsh-client-ui-sidebar/README.md` (panel slots), `dsh-client-ui-workspace/README.md`
  (`ctx.uiWorkspace`), `dsh-client-locale/README.md` (`ctx.locale.register/bind`).
- Plugin development guide:
  `.../dsh-agent-preset/skills/cordis-plugin-development/SKILL.md` +
  `references/host-plugin.md`, `references/ui-plugin.md`, `references/practices.md`.
- Working copy of node_modules? None needed: host modules must stay dependency-free.

DeepSeek Harness is English-first for code identifiers; user-visible copy in this bundle is
Portuguese and English.
