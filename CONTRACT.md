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
      "character": "bit-researcher",
      "emoji": "🔬",
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
- `character`: bit catalog id (`/^[a-z0-9][a-z0-9-]{0,63}$/`) or `null` (legacy bot with
  an emoji avatar). The store checks syntax; `/api/bots.create|update` reject ids missing
  from `bits/catalog.json` with `BOT_INVALID_CHARACTER`. `null` clears it.
- `emoji`: 1..8 chars, default `🤖` (the UI sends the chosen bit's emoji).
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
| `/api/bots.catalog` | GET | – | `{ version, groups: [{ id, label: { pt, en } }], bits: [{ id, name, group, emoji, color, summary: { pt, en }, instructions, avatar }], error }` |
| `/api/bots.avatar?id=<bit>` | GET | – | binary `image/webp` (HTTP 404 for an unknown id; the only non-JSON route) |

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

---

## 10. Teams of bits (v2)

A **team** groups bits into roles (members) and describes how work flows between them as an
editable graph (nodes + edges). The Web UI shows a "Times" tab with a visual flow editor.
Teams are pure data in v2: no agent runtime uses them yet.

### 10.1 Record (`<botsRoot>/teams.json`)

```json
{
  "statusVersion": 1,
  "teams": [
    {
      "id": "a1b2c3d4e5",
      "name": "DSC",
      "description": "Time do design system...",
      "emoji": "👥",
      "color": "#2563eb",
      "workspaceDir": "/home/me/dsc",
      "members": [
        {
          "id": "builder",
          "character": "bit-builder",
          "name": "Builder",
          "role": "Implementa a partir dos testes vermelhos",
          "model": "Sonnet 5.5",
          "provider": "anthropic-2",
          "effort": "medium",
          "access": "write",
          "instructions": "...",
          "launches": ["scout"]
        }
      ],
      "flow": {
        "nodes": [
          { "id": "n1", "type": "step", "x": 120, "y": 80, "label": "Verde", "detail": "...", "memberId": "builder" },
          { "id": "g1", "type": "group", "x": 0, "y": 0, "w": 320, "h": 400, "label": "3. Implementar", "color": "#2563eb" }
        ],
        "edges": [
          { "id": "e1", "from": "n1", "to": "n2", "label": "", "kind": "flow" }
        ]
      },
      "createdAt": "ISO", "updatedAt": "ISO"
    }
  ]
}
```

Field rules (store validates; violations throw coded `TEAM_INVALID` with a message naming the
field, e.g. `members[2].id: duplicate id "builder"`):

- team `id`: 10 lowercase hex (`/^[0-9a-f]{10}$/`), generated by the store.
- `name`: trimmed, 1..60, required. `description`: 0..2000, default `""`.
- `emoji`: 0..8 code points, default `"👥"`. `color`: `#rrggbb`, default `#2563eb`.
- `workspaceDir`: `null` or an absolute path string ≤ 1024 (informational; never used for
  destructive operations). Empty string → `null`.
- `members`: array ≤ 64. Member `id`: `/^[a-z0-9][a-z0-9_-]{0,63}$/`, unique within the team.
  `character`: bit id syntax `/^[a-z0-9][a-z0-9-]{0,63}$/` or `null`. `name`: 1..60.
  `role`: 0..200. `model`: 0..60. `provider`: 0..64, profile provider id that pins the account
  the model resolves in (default `""` = automatic: the caller's provider, then registration
  order). `effort`: 0..20. `access`: `"read" | "write"` (default
  `"write"`). `instructions`: 0..20000. `launches`: array ≤ 64 of member ids of the same team
  (unknown id → `TEAM_INVALID`; duplicates removed; self allowed).
- `flow.nodes`: array ≤ 500. Node `id`: `/^[A-Za-z0-9_-]{1,64}$/`, unique. `type`: one of
  `start | end | step | decision | pause | group | note`. `x`, `y`: finite numbers, clamped to
  ±100000 and rounded to integers. `w`, `h`: only meaningful for `group` and `note`; optional
  numbers clamped to 40..4000 and rounded (omitted when absent). `label`: 0..200 (default `""`).
  `detail`: 0..4000 (default `""`). `memberId`: only for `step`, `null` or an existing member id
  (unknown → `TEAM_INVALID`); other types drop it. `color`: optional `#rrggbb` (omitted when absent).
- `flow.edges`: array ≤ 1000. Edge `id`: same pattern as node ids, unique among edges.
  `from`/`to`: existing node ids, `from !== to`. `label`: 0..120 (default `""`). `kind`:
  `flow | loop | delegate` (default `flow`).
- Unknown fields anywhere are dropped silently (not an error), so newer clients stay compatible.
- Store keeps ≤ 200 teams (`TEAM_LIMIT` when exceeded).

### 10.2 `host/teams.js` — `TeamStore`

```js
export class TeamStore {
  constructor({ botsRoot })
  get file()            // <botsRoot>/teams.json
  async init()          // mkdir -p; missing file -> empty; corrupt JSON -> rename to teams.json.corrupt-<ts>, start empty
  list()                // deep copies, creation order
  get(id)               // deep copy | undefined
  async create(input)   // input: { name, description?, emoji?, color?, workspaceDir?, members?, flow? } -> record copy
  async update(id, patch) // patch: any of name/description/emoji/color/workspaceDir/members/flow (members/flow replace whole); TEAM_NOT_FOUND
  async remove(id)      // returns removed copy; TEAM_NOT_FOUND
  async flush()
}
export function normalizeTeam(input, { partial } = {}) // pure validator used by the store (exported for tests)
```

Same persistence guarantees as `BotStore`: serialized atomic writes (tmp + rename, file 0600,
dir 0700), mutators persist before resolving, copies out. Cross-field checks (member ids in
`launches`, `memberId`, edge endpoints) run on the merged record after a patch.

### 10.3 `host/team-routes.js` — `registerTeamRoutes(ctx, deps)`

`deps = { teams: TeamStore, ready: Promise, catalog?, templates?: Template[], llm?, log? }`
(`llm` feeds `/api/bots.teams.providers`; without it the route answers `{ providers: [] }`). Same
conventions as §5 (HTTP 200, `{ ok }`, coded errors pass through, `INTERNAL` otherwise, awaits
`ready`). When `deps.catalog.has` exists, a member `character` missing from the catalog →
`TEAM_INVALID`.

| path | method | request | response |
|---|---|---|---|
| `/api/bots.teams` | GET | – | `{ teams: Team[] }` |
| `/api/bots.teams.create` | POST | `{ team: {...} }` | `{ team }` |
| `/api/bots.teams.update` | POST | `{ id, patch }` | `{ team }` |
| `/api/bots.teams.delete` | POST | `{ id }` | `{ deleted: true, id }` |
| `/api/bots.teams.templates` | GET | – | `{ templates: [{ id, name, description, emoji, team }] }` |
| `/api/bots.teams.providers` | GET | – | `{ providers: [{ id, name, models: [{ id, name }] }] }` (profile providers/accounts, for the member model picker) |

Templates are JSON files `bits/teams/<id>.json` (`{ id, name, description, emoji, team }`),
loaded once by `index.js` through `loadTeamTemplates(dir)` exported from `host/team-routes.js`
(invalid files are skipped and logged; missing dir → `[]`).

---

## 11. Runnable teams and harness packs (v3)

Teams become executable: a session whose team is resolved gets the team's rules, the lead or
member persona, the flow as text, the roster, the harness skills, the `applyTo` instructions,
the harness guard and MCP servers. The lead delegates with `team_delegate` (a child agent
running a member) and passes the whole session to another team with `team_handoff`.

### 11.1 New team fields (store: `host/teams.js`, already implemented)

| field | type | meaning |
|---|---|---|
| `lead` | member id \| null | member that receives requests (orchestrator). |
| `harness` | pack id \| null | harness pack carried by the team (`<botsRoot>/harness/<id>/`). |
| `bindWorkspace` | boolean | root sessions opened inside `workspaceDir` (any subdirectory, e.g. `worktrees/AB-<n>`) belong to this team's lead. At most one team per workspace should set it. |
| `rules` | string ≤ 40000 | extra team rules appended after the pack rules. |
| `skills` | skill names[] | pack skills visible to the team; `[]` = all pack skills. |
| `entry` | `{ id, label ≤ 60, template ≤ 2000 }[]` ≤ 20 | request templates for "Enviar pedido"; placeholders `{n}` (card number) and `{pedido}` (free text). |
| `members[].provider` | provider id \| `""` | pins the profile provider (account) the member model resolves in; empty = caller's provider. |
| `members[].skills` | skill names[] | skills the member reads first (from the preset "**Skills:**" line). |
| `members[].teamRef` | team id \| null | the member stands for another team: delegating to it runs that team's lead. |
| `members[].mcp` | server names[] ≤ 8 | MCP servers of the pack mounted for the member. |
| node `type: 'team'` + `teamRef` | | a step handled by another team. |
| edge `kind: 'handoff'` | | the session passes to another team. |

Member `instructions` max is now 40000.

### 11.2 Harness packs (`host/harness.js`, implemented)

`transpileHarness({ sourceDir, packsRoot, packId, name })` copies the harness (`AGENTS.md`,
`.github/{agents,skills,instructions,hooks,scripts,copilot-instructions.md,harness.json}`,
`.mcp.json`) to `<botsRoot>/harness/<packId>/`, rewrites Markdown commands to the pack
(`node .github/x` → `node <pack>/.github/x`), applies anchored script patches (guard trusts the
pack; `where.mjs` reads the pack version) and writes `manifest.json`
(`agents[] {name, description, model, tier, effort, readOnly, launches, userInvocable, skills,
instructions}`, `skills[] {name, description, path, dir, resources}`, `instructions[] {name,
description, applyTo[], path}`, `mcp {name: server}`, `hooks {guard, gitInstaller}`,
`patches[]`). Scripts read `DSH_HARNESS_PACK_ROOT`.

### 11.3 Routes (host)

| path | method | request | response |
|---|---|---|---|
| `/api/bots.harness` | GET | – | `{ packs: PackSummary[] }` |
| `/api/bots.harness.import` | POST | `{ sourceDir, id, name? }` | `{ pack: PackSummary }` |
| `/api/bots.teams.fromPack` | POST | `{ packId, name?, workspaceDir? }` | `{ team }` (lead + one member per preset + simple flow) |
| `/api/bots.teams.workspace` | POST | `{ id }` | `{ workspaceId, workspaceDir }` (registers the team workspace in the Harness) |
| `/api/bots.teams.runtime` | GET | – | `{ agents: [{ sessionId, teamId, memberId, role, cwd }], errors: string[] }` |

`PackSummary = { id, name, source: { dir, commit }, packDir, harnessVersion, createdAt, files,
agents: [{ name, description, model, tier, effort, readOnly, launches, skills }],
skills: [{ name, description }], instructions: [{ name, applyTo }], mcp: string[],
patches: [{ id, applied, reason }] }`.

### 11.4 Sending a request ("Enviar pedido")

Client only: `POST /api/bots.teams.workspace {id}` → `ctx.uiWorkspace.startSession(workspaceId,
{ prompt, whenDraftExists: 'replace' })`. The new session opens with the request in the
composer; the user sends it. The prompt is the chosen `entry.template` with `{n}`/`{pedido}`
filled. When the target team is not the workspace-bound team, the prompt is prefixed with
`[Time: <team name>] ` and the bound team's lead hands the session off to it.

### 11.5 Runtime (`host/team-runtime.js`)

- Resolution: child sessions created by `team_delegate` are bound `{ teamId, memberId }`
  (persisted in `<botsRoot>/team-bindings.json`); root sessions use their own binding (set by
  `team_handoff`) or the `bindWorkspace` team of their cwd (lead).
- Lead: orchestrates only. Shell, write/edit, search, web and built-in subagent tools are
  hidden; `read` is limited to the pack, `.dsc/` files and the bits data directory. Tools:
  `team_delegate({ member, task })`, `team_handoff({ team, request })`, `skill`, `todo_write`,
  `ask_user_question`, `working_directory`.
- Member: the preset persona; `access: read` hides write/edit and runs the guard with
  `--read-only`; `team_delegate` only lists the members in `launches` (a `teamRef` member runs
  the other team's lead). Built-in `subagent` tools are hidden.
- Guard: every tool call of a team agent runs the pack `git-guard.cjs` (Claude Code event
  format) with `DSH_HARNESS_PACK_ROOT`; exit 2 → deny with its reason.
- `applyTo`: after `read`/`write`/`edit` on a matching file, the instruction body is added
  once per agent as a reminder message.
- Models: member `model` labels (`Claude Opus 5.5`) resolve to the profile's provider/model; `effort`
  maps to the reasoning effort when supported; otherwise the parent's route is kept.
  `members[].provider` (`anthropic-2`) pins the account: the label is resolved **only** in that
  provider, so a second account for the same model names is never confused with the first; an
  unknown provider or a label missing from it fails the delegation with a coded message instead of
  silently falling back to another account. The roster shows the pinned account
  (`Claude Opus 5.5 — Anthropic (conta 2) · xhigh`).
