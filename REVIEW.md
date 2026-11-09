# Independent review — Bots bundle (`@local/dsh-bots` v0.1.0)

Reviewer: `verifier` (independent, read-only on code; only this file was written).
Scope: `bots-plugin/` as of 2026-11-08. Target: DSH Desktop profile (`desktop`, DSH 0.2.2-rc.1,
Node 24.21.0). Method: source audit of `index.js`, `host/*.js`, `client.js`, `package.json`,
`cordis.patch.yml` against the **installed** package sources under
`~/.local/opt/deepseek-harness/resources/app/dsh/node_modules/@deepseek-ai/`
(`dsh-tools`, `dsh-system-prompt`, `dsh-agent`, `dsh-agent-loop`,
`dsh-agent-preset-registry`, `dsh-working-directory`, `dsh-workspace`,
`dsh-client-connection`, `dsh-client-modules`, `dsh-client-locale`,
`dsh-client-ui-layout`, `dsh-client-ui-sidebar`, `dsh-client-ui-renderer`,
`dsh-web-app`, `dsh-base`) plus the bundled plugin-development references, and a full rerun
of every test in `test/`. The host plugin was **not** installed into the running profile,
no `dsh plugin`/profile changes were made, and no bundle code was edited.

## Rerun results (exact)

| Command | Result |
|---|---|
| `node test/store.test.mjs` | **PASS** — `store: 22 tests passed` (exit 0) |
| `node test/routes.test.mjs` | **PASS** — `routes: 26 tests passed` (exit 0) |
| `node test/agent.test.mjs` | **PASS** — `agent tests PASS` (exit 0) |
| `node test/vm.test.mjs` (1st run, real Docker 29.8.2) | **FAIL** — 20/22: `dispose() aborts an in-flight exec and settles as aborted` (`null !== 'aborted'`), `stop() stops the running container` (`unexpected state after stop(): missing`) |
| `node test/vm.test.mjs` (immediate rerun) | **PASS** — `PASS (22/22 checks)`, `cleanup: no test containers left behind` (exit 0) |
| `node test/e2e-web.mjs` | **PASS** — `E2E PASS`; throwaway profile, authenticated host, client bundle served, bot CRUD, real session + persona attach, VM lifecycle, cleanup |

The vm test failure is **not** purely incidental: at least the `dispose()` half is explained by
a real race in `host/vm.js` (finding M2). The `stop()` "missing" half is consistent with two test
processes sharing the module's fixed container name (finding T1). Both failures must be treated as
signals, not noise.

---

## Findings

### BLOCKER

#### B1. Bot persona is interpolated as a prompt template — `{{…}}` in a name/instruction kills every turn — `host/agent.js:229-233`
`agent.ctx.systemPrompt.section({ name, order, text: buildPersonaText(...) })` omits
`interpolate: false`. `buildPersonaText()` (`host/agent.js:33-72`) embeds user-authored data:
the bot name, emoji, `instructions` (0..20000 chars) and `workspaceDir`. `dsh-system-prompt`
interpolates sections by default and **throws** on any unresolved `{{name}}` reference
(`dsh-system-prompt/lib/index.js:119-121,160-187`; README: “an unknown reference … throws”).
Failure scenario: a user writes a persona containing a common template placeholder
(`Você é {{nome}}, o pesquisador…`, `Responda a {{user}}`, `{{ name }}`) — the exact use case
this feature advertises (“instruções permanentes”). The first model request in that bot session
fails during prompt assembly with `unknown prompt variable "{{nome}}" in section
"bots:persona:<id>"`; every turn fails, and the error surfaces as a broken conversation with no
indication that the persona text is the cause. Data is not corrupted but the bot is unusable and
the failure looks like a harness bug.
Fix: register the section with `interpolate: false` (this is the documented mechanism for
user-generated/directory text) and add an agent test that registers a persona containing `{{x}}`
and asserts the assembled section text is preserved literally.

### MAJOR

#### M1. VM mode changes after agent creation are not reflected: enabling VM leaves host shell unrestricted — `host/agent.js:226-246, 343-347`
`vmEnabled` and the `ctx.tools.restrict({ deny })` are decided once, in the `agent/created`
listener. `vm_bash`’s `when` condition, however, reads the **live** record
(`botForSession()` → `store.getByWorkspace()`), so after the user opens a session and then turns
the bot’s VM on (a first-class operation in the UI — `POST /api/bots.update`), the next step
admits `vm_bash` while the host `bash`/`pwsh` restriction was never installed. The model then
has both shells and the persona claims “The host shell tool is intentionally unavailable”.
The inverse toggle (VM off on a live VM-bot session) leaves the restriction installed and
`vm_bash` gone: the agent has **no** shell. Editing a bot also changes what `when` sees for
instructions? No — instructions are frozen at attach; the machine rules go stale too.
Failure scenario: `Conversar` → `Editar` → enable “Máquina virtual” → next message: agent can run
host `bash` (danger-full-access in this profile) while the product UI/README says commands run in
the container. That is the isolation boundary the feature sells, weakened by a supported UI action.
Fix (choose one): (a) on `POST /api/bots.update` re-install/refresh the agent registration for the
bot’s live sessions (or emit a `bots/change` event that triggers re-install); (b) decide the
restriction per model step rather than per agent (e.g. an agent-scoped dynamic restriction is not
available, so pair the `when` gate with a `ctx.tools.guard()` denying `bash`/`pwsh` for agents
whose current record has `vm.enabled === true`); (c) at minimum, make `vm_bash`’s `when` require
that the same step also has the host shell restricted and document the toggle limitation.
Add a test: create live session for a non-VM bot, `store.update` to enable VM, assert the agent’s
visible tool set contains `vm_bash` and not `bash`.

#### M2. `BotVm.dispose()` is not sticky: an exec can start *after* dispose and run for its full deadline — `host/vm.js:876-884, 724-790, 1380-1400`
`dispose()` cancels only `#active` records at that instant. `exec()` checks `signal`/abort only
around `ensure()` and `#shellFor()`; there is no disposed flag. A call that has passed those waits
but has not yet spawned (`#run` registers the child at `host/vm.js:1392`) starts its `docker exec`
after `dispose()` returned. Same for lifecycle calls and for any call issued after disposal.
Failure scenario: plugin unload/HMR while `vm_bash` is starting (cold shell probe, slow Docker):
dispose returns, a `docker exec …sleep inf` child runs up to the 120 s/600 s deadline; the tool
promise resolves normally (`signal: null`) instead of `aborted`. This is exactly the observed
first-run failure `dispose() aborts an in-flight exec … null !== 'aborted'` (test asserts
`test/vm.test.mjs:438-450`); the rerun passed only because the shell probe was warm.
Fix: add `#disposed` and an internal `AbortController`; check it at the start of every public
method and immediately before `spawn` in `#run` (settle `aborted: true`); call `dispose()` inside
the plugin teardown before/while agents are disposed (already done in `index.js:191-196`).
Make the test deterministic (e.g. assert the exec actually spawned via a long command + output
marker before calling dispose; or call dispose before exec and assert a coded rejection/aborted
result).

#### M3. Deleting a bot mid-session can orphan a container that no surface can manage — `host/routes.js:410-434`, `host/agent.js:312-339`, `host/store.js:545-565`
Delete removes the record first (`store.remove`) and only then best-effort `vm.remove(removed)`.
A `vm_bash` call already executing (or starting between the two) holds the old record and calls
`vm.ensure(bot)`, which recreates/starts `dsh-bot-<id>`; after that it can create files and a
container for a bot that no longer exists. The route cannot later manage it (no record → every
`/api/bots.*` returns `BOT_NOT_FOUND`), the UI never shows it, and `dsh-bot-<id>` plus its
workspace volume state leaks. Also `vm.remove` failure is only logged.
Failure scenario: user types a message and clicks “Excluir bot” before the turn’s first
`vm_bash` finishes: orphan container remains running indefinitely.
Fix: add a deleted/tombstone set consulted by `vm_bash` (`when` and `execute`) and by
`installBotAgents`; make `ensure()` carry a record-existence check (inject a `isKnownBot(id)`
callback) so a deleted bot cannot recreate a container; after deleting the record, retry/collect
container removal and surface a warning in the diagnostics/log. Add a test for
delete-while-exec-running.

### MINOR

#### m1. Concurrent `ensure()` reports a false `VM_NAME_CONFLICT` — `host/vm.js:547-570`
Two concurrent first-time starts (UI “Iniciar VM” + first `vm_bash`, or two windows) both see the
container missing; the loser’s `docker run` fails with “already in use” and is mapped to
`VM_NAME_CONFLICT` (“refusing to touch it”) although the winner is the plugin’s own labelled
container. The model receives a scary conflict message; retry usually recovers.
Fix: on “already in use”, re-inspect; if `#assertManaged` passes, `start`/return the current
status; only report a conflict when the inspected container is foreign.

#### m2. `GET /api/bots.list` is a side-effectful, unbounded fan-out probe — `host/routes.js:356-359, 279-283`
Every poll (5 s while the page is visible) runs `composeView()` per bot: `ensureWorkspaceId()` →
`ctx.workspaceRegistry.create()` (a durable registry mutation on a GET) **and** a `docker inspect`
per bot, plus a `docker version` probe. Twenty bots ⇒ ~21 docker CLI spawns + 20 registry
mutations every 5 s. A GET that mutates (and can resurrect a workspace the user deleted) is
surprising; on slow Docker the `withTimeout` calls (`host/routes.js:128, 279, 315, 475`) return
degraded state but **do not cancel** the underlying vm promises, so timed-out probes keep running
up to their own 10 s bound.
Fix: cache/reuse VM status server-side with a short TTL, do the workspace lookup read-only
(`workspaceRegistry.list()/getByDirectory` if available) and only `create` from create/chat paths,
and pass an AbortSignal into the probes when the route times out.

#### m3. `deleteWorkspace` realpath check is TOCTOU-separated from the delete — `host/store.js:554, 563, 742-775`
`#assertWorkspaceInsideRoot()` validates `realpath(workspaceDir)` but the subsequent
`fs.rm(workspaceDir)` uses the un-canonicalized path. A same-user process (the bot’s own host
shell in a non-VM bot, or anything in the workspace) can swap a parent directory for a symlink
between check and remove; `rm` then resolves through the new symlink.
Fix: after validation, `fs.rm` the validated `realTarget`; reject records whose workspace path is
a symlink (or whose parent chain gained a symlink) when `deleteWorkspace` is requested.

#### m4. `vm.image` edits are not reconciled with an existing container — `host/vm.js:496-575`, `host/routes.js:407`
`#assertManaged` only checks `managed` + `id` labels; the image is not compared. After the user
edits the image (UI allows any reference), the status/`BotView.vmStatus.image` reports the new
image while the running container still uses the old one (the UI badge says “Rodando” with the
new image). Silent divergence from the record; re-creating requires manually removing the VM.
Fix: compare `Config.Image`/container labels with the record and either report a `detail`/state
mismatch or offer/require `remove` before the next start.

#### m5. `stop()`/`remove()` can race a concurrent `restart()`/`ensure()` — `host/vm.js:592-655`
Inspect → act is not serialized per container. `stop()` may inspect “running”, then `remove()`
runs, then `stop`’s `docker stop` fails with “no such container” and is treated as `missing`
(handled), but `restart()` can re-create after a `remove()` returns, leaving the UI saying “missing”
while a container runs. No cross-surface lock (route actions and `vm_bash` `ensure()` can overlap).
Fix: per-container async mutex in `BotVm` around lifecycle operations (`ensure/start/stop/restart/
remove`) so probes and actions serialize.

### NITS

- n1. `host/vm.js:283-286` (tool description) says “fresh non-login bash process”, but the exec
  command uses `bash -lc` (`host/vm.js:776-784`), a **login** shell; model-facing description is
  inaccurate (profile files can run). Either say “login shell” or drop `-l`.
- n2. `host/vm.js:1082-1094` `#assertManaged` never verifies `LABEL_WORKSPACE` and `ensure()` does
  not compare the image, so a same-named container carrying the two checked labels is trusted.
  Same-user Docker access makes this a convention check, not a boundary — document it as such.
- n3. `host/vm.js:540-548` `-v ${workspaceDir}:${workspaceDir}` breaks if `botsRoot` contains a
  colon; not reachable from routes today (workspaceDir is not client-settable — good), but a
  colon in configured `botsRoot` yields a confusing Docker mount error. Validate at construction.
- n4. `client.js:1830` registers dictionaries as `{ en, pt, 'pt-BR': pt }`. Runtime accepts it
  (`dsh-client-locale/lib/client.js:1675-1706`) and the shipped `pt` language pack
  (`fallback: 'en'`) covers the active locale; the documented typed contract asks for `zh`+`en`
  and `'pt-BR'` is a redundant entry. Harmless, but registering `{ zh?, en, pt }` (or the
  per-locale form) is cleaner. No functional defect found.
- n5. `host/agent.js:167-171` diagnostics ring keeps only 20 entries and `installAgent` records an
  agent in `attached` even if both persona and restriction registration failed (`host/agent.js:248-254`),
  so `/api/bots.diagnostics` can report “attached” for an agent that got no persona. Record the
  failure state on the attached entry.
- n6. `routes.js:430` reports `workspaceRemoved: true` whenever `deleteWorkspace` was requested,
  even if the directory did not exist (`fs.rm … force`). Cosmetic.

---

## Verified as correct (with the authority checked)

Host/agent integration
- `ctx.on('agent/created', ({ agent }) => …)` and `agent/disposed` payloads match the real
  emitter (`dsh-agent/lib/index.js:710-714`; serial dispatch with `{ agent, source, signal? }`),
  and awaiting `ready` inside the serial creation listener is legal.
- `agent.ctx` is the agent-scoped registration boundary; `agent.id`/`agent.session`/`agent.ctx`
  exist. Registration through `agent.ctx.systemPrompt.section({ name, order, text })` matches
  `SystemPrompt.section()` (`dsh-system-prompt/lib/index.js:255-258`), and order 120 is a free
  external order.
- Bot resolution from the session: `ctx.workingDirectory.get(session)` is the committed
  projection and reads the session header on first use (`dsh-working-directory/lib/index.js:80-86`;
  projection `init: header => header.cwd ?? null`), so a session created in the bot workspace
  resolves correctly at `agent/created` — corroborated by the E2E diagnostics assertion.
- VM shell restriction is API-correct: `ctx.tools.restrict({ deny })` requires a scoped context
  (the code calls it on `agent.ctx`), and the names passed are filtered through
  `agent.ctx.tools.get(name, agent)` first. Preset tools are registered in the preset generation
  scope, which the agent scope inherits via `bindScopeParent` when the preset is mounted on
  `agent.ctx` (`dsh-agent-preset-registry/lib/index.js:219-239, 702-716`), so they are
  “restrictable inherited” names, not scope-local ones; the E2E’s `diagnostics.errors === []`
  in a profile that composes `dsh-web-app`’s standard preset (tool-bash/tool-pwsh as preset rows;
  host-plane rows disabled in `dsh-web-app/cordis.patch.yml:487-491`) is consistent with the
  restriction succeeding rather than failing silently.
- `vm_bash` definition shape is valid for `ToolsService.register`:
  `{ name, description, parameters, output: { schema, render }, execute }` matches what
  `dsh-tools` requires (`lib/types/index.js:87-127`, `lib/types/index.js:362-368`) and what
  `dsh-tool-bash` itself registers; `render` returning `[{ type: 'text', text }]` is the accepted
  content block shape. `when({ agent, modelSelection, signal })` is the real condition signature,
  and the `execute(args, exec)` context really carries `exec.agent` and a cancellation `exec.signal`
  (`dsh-tools/lib/types/pipeline.js:199-217`). `botForSession()` is synchronous, so the synchronous
  `when` is fine.
- Disposal: per-agent disposers are kept by agent and disposed on `agent/disposed` **and** on
  plugin unload, covering the documented “unloading the plugin does not dispose agent.ctx
  registrations by itself” requirement. Event listeners and the global `vm_bash` registration are
  ctx effects and are disposed through `index.js:175-197`.
- `index.js` `inject` list uses real service names (`connection`, `workspaceRegistry`, `tools`,
  `agents`, `workingDirectory`, `systemPrompt`); `ctx.logger.warn` exists on Cordis contexts;
  `ctx.workspaceRegistry.create(absDir, title)` matches `dsh-workspace/lib/index.js:408` and its
  documented idempotent “existing project unchanged” semantics.

Docker VM
- All Docker invocations use argv arrays (`node:child_process.spawn` with no shell), so command,
  workdir, env, image and id data cannot inject flags; `command` is the final `-lc` argument.
- Image reference regex enforced at store, `BotVm` and `#assertImageAvailable`; bot id constrained
  before building `dsh-bot-<id>`; env keys/values validated; workdir must be absolute and is
  `path.resolve`d (so it starts with `/` and cannot become a flag).
- No `--privileged`, no Docker socket mount, default bridge unless configured; no implicit pulls
  (`ensure()` requires a local image and says so; `pullImage()` is the only pull).
- Managed-container safety: `#assertManaged` before start/stop/restart/remove; foreign name
  conflict is reported without touching the container; missing container is not an error for
  stop/remove; `remove()` never deletes the workspace.
- `exec()`: deadline kill SIGTERM→SIGKILL with an abandon timer; per-stream caps with truncation
  marker; nonzero exit/timeout/abort resolve (never reject); only spawn/infrastructure failures
  reject with `VM_*` codes; an aborted external signal settles `signal: 'aborted'` as documented.
- `status()`/`statuses()` never throw for Docker problems and degrade to `unavailable`/`error`
  (the route also wraps this in a timeout, `routes.js:279`).

Store and routes
- Atomic persistence: temp file + `fsync` + rename, mode 0600, root dir 0700, serialized write and
  mutation chains, corrupt-file quarantine, deep-copied reads, coded errors; `BOT_NOT_FOUND`
  behavior verified by tests.
- `remove(deleteWorkspace)` validates the path against the real `botsRoot` (including realpath of
  the target) and throws `BOT_WORKSPACE_OUTSIDE_ROOT` otherwise; `ensureWorkspace` only mkdirs the
  record’s own absolute workspace. Create input from the route is whitelisted
  (`pickCreateInput`, `routes.js:344-351`), so a remote client cannot set `workspaceDir`/`id`.
- Routes match `dsh-client-connection` exactly: exact `/api/...` paths, non-empty unique methods,
  `requestBody: 'buffered'`, handler-only invocation with the owner Peer (403 for other principals),
  registration dedupe throws, and the returned disposers are effect-owned. Handler contract
  (`{ ok: true, … }` / `{ ok: false, error: { code, message } }`, malformed JSON → `BAD_REQUEST`,
  unexpected → `INTERNAL` + log) is implemented and unit-tested.

Client
- Module format matches the loader contract: `window.__ModuleLoader__.load({ id, factory })` whose
  factory returns the module object (`{ inject, apply }` is accepted; first-party bundles export
  the same fields). No top-level `window` access outside the call; no JSX/imports/Harness requires.
- `inject` lists real service keys; `uiWorkspace` is the real service name
  (`dsh-client-ui-workspace/lib/client.js:1382 super(ctx, "uiWorkspace")`).
- Registrations match the first-party reference exactly (compared to
  `dsh-client-ui-schedule/lib/client.js:19360-19393`): `main` with `{ name, key, locale, inject }`,
  `sidebar.panellist` with `{ name, id, order, locale, label }`; `ctx.slots.inject(...)` used for
  both (required by the renderer/layout contract); the `panelInfo` source passed as a hook is the
  real `{ getSnapshot, subscribe }` pair from `dsh-client-ui-layout` (`lib/client.js:697-703`).
  The page tolerates a missing hook/service (`readService`, fallback `t`, null guards).
- React rules: all hooks are called unconditionally at component top level (page, dialogs, toast,
  modal); Escape/backdrop close, focus trap, `role="dialog"`/`aria-modal`, focus restore, disabled
  states. Polling (5 s) starts only while the panel is active and skips `document.hidden`, keeps
  the old list on poll errors, and clears its interval; Toast clears its 4 s timer; Modal clears
  its keydown listener. No state update after unmount feeds visible data (guarded by `aliveRef`).
- XSS: no `dangerouslySetInnerHTML` anywhere; bot name/emoji/instructions/workspace text render as
  React text nodes; the only user-controlled style value is `bot.color`, regex-validated
  (`/^#[0-9a-fA-F]{6}$/`) in `normalizeBot`; CSS is a static `<style>` string using theme tokens
  with fallbacks.
- Dictionaries: complete parity `en`/`pt` (83 keys each) and cover every key the CONTRACT requires;
  reported errors are localized through `t`.
- `package.json` `dsh` manifest is valid for the installed validators: `bundle.patch`,
  `client.platform: "web"`, `client.immediately: true` (boolean accepted,
  `dsh-client-modules/lib/index.js:88-99`), `client.inject` package list.

---

## Test gaps (worth closing before/after install)

- T1. `test/vm.test.mjs` uses a fixed container name and workspace; two concurrent test processes
  (e.g. reviewer + Lead rerunning the suite) collide and one sees the other’s cleanup as
  “missing”/`VM_NAME_CONFLICT`. Make names unique per run (`dsh-bot-test-<pid>-<rand>`) or
  serialize via a lock file; the first-run `stop()` failure is consistent with this.
- T2. `vm_bash` is never executed through a **real Agent**. `e2e-web.mjs` only checks that the
  agent attached (`test/e2e-web.mjs:443-461`) and the VM lifecycle; `agent.test.mjs` uses a fake
  `ctx`. Nothing exercises actual tool admission (`when`), argument validation, `exec.agent`,
  cancellation through `exec.signal`, or the rendered tool text against a real tool registry.
  Add an E2E step that runs `vm_bash` via a real session turn (or a host-side
  `ctx.tools.execute` with an admitted tool set) and asserts `[exit code: 0]` plus the
  absence of `bash` in that step’s schemas.
- T3. No test for the B1 interpolation case; no test that a persona `{{…}}` is preserved.
- T4. No test for M1 (VM toggle on a live session), M2 (dispose during each exec phase), M3
  (delete while executing) or m1 (concurrent ensure).
- T5. No client-side DOM/behaviour test at all: the E2E proves the bundle is served and the
  module graph loads, but the page is never mounted/rendered, so slot rendering, dialog
  behaviour and polling are review-only. If a jsdom-style test is acceptable in this repo,
  render `BotsPage` with a fake `t`/`uiWorkspace` and assert the three states (loading/empty/list)
  and dialog submit shape.
- T6. No assertion that the assembled **real system prompt** contains the persona text and the VM
  rules for a VM bot (E2E asserts only `/api/bots.diagnostics`), which would also have caught B1.

## Verdict / install recommendation

I found **one blocker (B1)** and **three major issues (M1–M3)**; no data-corruption, privilege-
escalation or secret-leak defect was found in the reviewed code, and the routes are authenticated
owner-only through `dsh-client-connection`. However, the bundle is **not ready to be signed off**
as-is:

- **Do not install before fixing B1** (one-line `interpolate: false` plus a regression test).
  With B1 present, any persona that contains a `{{…}}` template — a plausible first-day edit —
  makes that bot’s sessions fail every turn with an unrelated-looking prompt-assembly error.
- M1 should be fixed or explicitly documented before the feature is presented as an isolation
  boundary (“a ferramenta bash do host fica oculta”): today it is only true at the moment the
  agent was created, not after the user edits the bot.
- M2/M3 are lifecycle/teardown races that a long-running Desktop profile will eventually hit
  (HMR/unload, delete-while-busy) but they do not endanger existing user data; schedule them as
  follow-ups if time is short.

If the Lead accepts the above as follow-ups, installation itself is low-risk: the plugin writes
only under `$DSH_HOME/bots`, adds authenticated `/api/bots.*` routes, and does not touch existing
profile rows (`cordis.patch.yml` is a single insert row). I would treat it as an **experimental
install**, not yet a “safe for daily use” one, until at least B1 is fixed and T2 is added.

---

# Post-fix re-review (2026-11-08, after Lead’s fixes)

Scope: re-reviewed the changed code (`host/agent.js`, `host/vm.js`, `host/store.js`,
`host/routes.js`, `index.js`, new `test/vm-lifecycle.test.mjs`, updated `test/agent.test.mjs`,
`test/e2e-web.mjs`) against the installed DSH sources, and re-ran every suite. Again: no bundle
code was edited, nothing was installed, the profile was not touched. Only this file changed.

## Status of the original findings

| ID | Status | Evidence / residual note |
|---|---|---|
| **B1** persona interpolation | **FIXED** | `host/agent.js:231-243` now registers the section with `interpolate: false` and a `text()` callback reading the live record. `test/agent.test.mjs` asserts `interpolate === false`, `typeof text === 'function'`, and that literal `{{nome}}`/`{{fonte}}` in instructions survive. Correct: `dsh-system-prompt` only interpolates when `interpolate !== false` (`lib/index.js:119-121, 160-187`). |
| **M1** live VM toggle | **FIXED** (with one residual, see R5) | `refreshBot()` (`host/agent.js:279-295`) re-registers for every live agent of the bot; wired through `onBotChanged` from `routes.js:372-376, 404-408` and `index.js:141-144`; persona `text()` is dynamic. Defense-in-depth `ctx.tools.guard()` added (`host/agent.js:398-415`). API verified against `dsh-tools`: `guard(exec)` is checked after pre-execute policy (`lib/types/pipeline.js:154, lib/types/index.js:314-330`), gets the real `exec` with `.name`/`.agent`, and a returned string is the denial reason (`Error: <reason>` content). Guard no-ops for non-VM bots, non-bot agents, and non-shell tools (unit test asserts all three). `test/agent.test.mjs` covers enable→disable→re-enable on a live agent (restriction present/absent/present, persona text, `when`); `test/e2e-web.mjs:460-484` (new step 5c) verifies the same through the real host: `restricted` flips false/true, `errors === []`. |
| **M2** non-sticky dispose | **FIXED** | `#disposed` sticky flag (`host/vm.js:239`), set first in `dispose()` (`:936-946`), short-circuited at `#run` entry (`:1337-1350`) and again immediately before `spawn` (`:1475-1480`). `test/vm-lifecycle.test.mjs` covers in-flight abort + post-dispose short-circuit against real Docker. Post-dispose `status()` degrades through its existing `VM_ABORTED` catch, `available()` reports a cancelled probe; no throw escapes during teardown. **Caveat:** this correct behavior makes the old `test/vm.test.mjs` red — see R1 (test file must be updated). |
| **M3** orphan container on delete | **FIXED (residual edge R3)** | `forget()` tombstone (`host/vm.js:909-925`) + `#assertNotForgotten` in `ensure`/`stop`/`restart`/`exec` (`:504, 619, 661, 757`); `remove()` deliberately unguarded as the cleanup path (`:695-698`) and `routes.js:435-448` calls `forget()` then `remove()`. `test/vm-lifecycle.test.mjs` asserts `VM_BOT_DELETED` for ensure/exec after forget and that `remove()` still works. Legit re-create after `remove()` is **not** broken: only `forget()` sets the tombstone, `remove()` does not, bot ids are not reusable (`BOT_ID_EXISTS`), and vms are per-instance. |
| **m1** false VM_NAME_CONFLICT | **FIXED** | `host/vm.js:564-594`: on “already in use” it re-inspects; if `#assertManaged` passes it starts/reuses and returns status, and only a non-managed/missing retry yields `VM_NAME_CONFLICT`. Narrow residual: if the winning container disappears between the failed run and the retry inspect (`retry.kind !== 'ok'`), the (now stale) “already in use” message claims a foreign container exists — cosmetic. |
| **m2** list fan-out / GET side effects | **PARTIAL** | `index.js:108-130` now does a read-only `ctx.workspaceRegistry.list()` lookup first (verified: `list()` returns entities with `.path`/`.id`, canonicalized, so the comparison is valid) and only falls back to `create()`. List still runs `ensureWorkspace` (mkdir) + one `docker inspect` per bot + `docker version` per poll, and `withTimeout` still does not abort the underlying probes. Unchanged, acknowledged. |
| **m3** deleteWorkspace TOCTOU | **FIXED** | `#assertWorkspaceInsideRoot` now returns the validated realpath (`host/store.js:743-775`) and `#removeRecord` deletes exactly that target (`host/store.js:555, 564`). `test/vm-lifecycle.test.mjs` exercises the delete path; existing store tests cover containment refusal. |
| **m4** image/container divergence | **OPEN** (acknowledged) | `#assertManaged` still checks only `managed`+`id` labels; `Config.Image` is never compared with `vm.image`. Editing the image keeps reporting the new image for the running container; requires manual remove. |
| **m5** lifecycle races | **OPEN** (acknowledged) | No per-container mutex yet; `stop/remove/restart/ensure` can still interleave. |
| **n1** login-shell description | **FIXED** | `host/vm.js:324` now says “fresh `bash -lc` process”. |
| **n2** label trust | **OPEN** (should be documented as convention, not boundary) | unchanged. |
| **n3** colon in `botsRoot` mount | **OPEN** (cosmetic, trusted config only) | unchanged. |
| **n4** locale dict shape | **OPEN** (harmless) | runtime still accepts `{en, pt, 'pt-BR'}`; shipped `pt` pack covers the active locale. |
| **n5** diagnostics flags | **FIXED** | `host/agent.js:260-268` records `restricted`/`personaOk`; E2E asserts `restricted` transitions. |
| **n6** workspaceRemoved flag | **OPEN** (cosmetic) | unchanged. |

## New findings from the re-review

### R1. MAJOR — the committed `test/vm.test.mjs` is now red because it reuses a disposed `BotVm` — `test/vm.test.mjs:245-246, 442-452+`
`vm.test.mjs` instantiates `vm` once and calls `await vm.dispose()` mid-file in the M2 test
(`:442`); the eight checks that follow (`stop/start/restart/remove`, missing-container, image
missing, no-pull, foreign container) now hit the (correct) sticky short-circuit. Observed:
`node test/vm.test.mjs` → **FAIL 14/22**, failures all “docker inspect … was cancelled” /
`VM_ABORTED` instead of the expected state or `VM_IMAGE_MISSING`/`VM_NAME_CONFLICT`. This is a
**test-suite regression, not a production regression** — sticky dispose is the intended fix, and
`vm-lifecycle.test.mjs` creates a fresh instance per scenario. It must still be fixed before
sign-off because the bundle’s own README advertises this command (`README.md:139`, “Docker real:
22 checks”) and the deliverable’s acceptance is a green suite.
Fix: in `vm.test.mjs`, create a fresh `BotVm` before the lifecycle section (or move the dispose
test to the end, or give the dispose scenario its own instance); also re-check the README count.

### R2. MINOR — the delete tombstone cancels unrelated in-flight Docker children (null `botId`) — `host/vm.js:909-925` + omitted `botId` call sites
`forget()` cancels every active child whose `botId` is `null` as well as the deleted bot’s ones
(`:919`). Several per-bot calls still omit `botId`: `#inspect` (`:1097-1102`), `#shellFor`
(`:1273`), `#assertImageAvailable` (`:1181`), the `start` branch (`:523`), plus global
`available()`/`listImages()`. Deleting one bot can therefore transiently abort another bot’s
in-flight ensure/stop/start (`VM_ABORTED: docker inspect … was cancelled`) or a list poll’s
Docker probe. Low impact (transient, retryable, single-user), but it is a new cross-bot coupling.
Fix: thread `botId` through `#inspect`/`#shellFor`/`#assertImageAvailable` (and the `:523` start),
and make `forget()` cancel only exact non-null `botId` matches.

### R3. MINOR — residual orphan window for a `docker run` racing the delete — `host/routes.js:430-448`, `host/vm.js:547-560`
`forget()` cancels the create child (`botId` set), but cancellation SIGTERMs the Docker CLI; a
container can still be materialized by the daemon as `created` in the small window after
`remove()`’s inspect/rm completes. `remove()` is a single pass, so the leftover is not retried.
Fix: after cancel settles, verify with a second inspect/`docker rm -f` (or retry removal once).
Behaviour is already vastly better than pre-fix (no *recreation* after tombstone); this is the
last sliver of the original M3 scenario.

### R4. NIT — agents whose install failed are never refreshed — `host/agent.js:259-268, 279-295`
`refreshBot()` iterates `agentDisposers.keys()`; an agent recorded in `attached` with zero
disposers (e.g. persona registration failed) is skipped, and if re-install throws during a
refresh the old registration is already disposed and the agent is dropped from `attached`. Both
are unlikely; consider keeping a per-agent record even with zero disposers and/or retrying.

### R5. NIT — guard/`botForSession` cost per shell call — `host/agent.js:404-411`
Every `bash`/`pwsh`/… call anywhere in the host now runs `workingDirectory.get` +
`store.getByWorkspace`, and `getByWorkspace` does a `path.resolve` plus `realpathSync` scan over
all records. Fine for a handful of bots; for dozens it adds synchronous fs work to every shell
call. The early `exec.name` filter keeps non-shell calls cheap. Optional: cache workspace→bot
resolution or match by prefix before realpath.

## Answering the specific regression questions

1. **Does the guard break non-VM bots or subagents?** No. It is a global guard but returns
   `undefined` unless the calling agent’s session resolves to a bot whose **live** record has
   `vm.enabled === true` (`host/agent.js:404-411`); unit tests assert plain-bot and stranger-agent
   calls are allowed and `read` is untouched. Subagents inherit the parent’s cwd
   (`dsh-subagent/lib/index.js:1530` resolveDirectory → parent cwd; child header carries `cwd`),
   so a VM-bot subagent is correctly denied the host shell and keeps `vm_bash` (its `when` also
   resolves through the same working directory), while a non-VM bot’s subagent is unaffected.
2. **Does `refreshBot` dispose/re-register cleanly without duplicate sections?** Yes.
   `uninstallAgent` disposes the section and restriction before `installAgent` registers the same
   section name; section registry insert after disposal is legal. `test/agent.test.mjs` verifies
   exactly one persona/restriction through toggle cycles, and the E2E step 5c verifies the real
   host flips `restricted` without integration errors.
3. **Does the tombstone break legit re-create after `remove`?** No. `remove()` never calls
   `forget()`; ids are not reused (`BOT_ID_EXISTS` guard in the store), so only a deleted bot’s id
   is tombstoned — and `remove()` remains allowed after `forget()` by design and by test.
   Residual: tombstone entries live for the lifetime of the `BotVm` instance (one short string
   per deleted bot) — negligible.
4. **Does the dispose short-circuit break `available()`/`status()` on plugin unload?** No.
   Teardown order is routes → agent integration → `vm.dispose()` (`index.js:196-218`), so no new
   route work starts after disposal; an in-flight `status()` catches `VM_ABORTED` and returns a
   degraded `error`/`unavailable` status, `available()` returns a cancelled-probe error, and
   `#inspect`’s abort path is already handled. The only breakage was the stale test file (R1).

## Rerun results after the fixes (this re-review)

| Command | Result |
|---|---|
| `node test/store.test.mjs` | **PASS** 22/22 |
| `node test/routes.test.mjs` | **PASS** 26/26 |
| `node test/agent.test.mjs` | **PASS** — now includes B1 interpolation + M1 live-toggle tests |
| `node test/vm-lifecycle.test.mjs` (new) | **PASS** — sticky dispose (M2), delete tombstone (M3), validated delete target, real Docker, no leftovers |
| `node test/e2e-web.mjs` | **PASS** — new step 5c verifies live Agent refresh on VM disable/re-enable through the real host |
| `node test/vm.test.mjs` (bonus, not in Lead’s list) | **FAIL 14/22** — stale test file after the M2 fix (R1); leftover cleanup still ran (no containers left) |

## Updated test gaps

- **T1** (fixed-container-name collisions in `vm.test.mjs`) now also matters less because the
  new lifecycle test uses unique ids; still update `vm.test.mjs` names when fixing R1.
- **T2** (highest value, still open): `vm_bash` is never executed through a real Agent/tool
  admission; E2E only inspects `/api/bots.diagnostics`. The new guard is also only unit-tested
  against a fake tool registry — a real-tool test would pin both.
- **T5** (no DOM test) still open.
- New: no test for delete-while-a-container-is-running and no test for cross-bot cancellation
  (R2); E2E removes the VM before deleting the bot, so `forget()`+running-container cleanup is
  only covered at the `BotVm` unit level.
- New: no regression test that `node test/vm.test.mjs` stays green after M2 (would have caught R1);
  consider documenting the per-instance dispose contract in the test header.

## Final install recommendation (updated)

The blocker and all three original majors are genuinely fixed, verified against the real installed
APIs and re-tested (unit, real-Docker lifecycle, and real-host E2E). The new code is materially
safer: user persona text is literal, live VM toggles propagate, the host shell is blocked at
execution even if a refresh is missed, teardown cannot spawn new Docker children, and deleted bots
cannot recreate containers.

Remaining before I would call the deliverable “done” (ordered):
1. **R1 (required, test-only):** update `test/vm.test.mjs` so it uses a fresh `BotVm` after the
   dispose scenario (and refresh the README count). Right now the documented suite is red.
2. M4/m5/n2/n3/n4/n6 and R2/R3/R4/R5 are follow-ups; none blocks installation for a single-user
   Desktop profile.
3. T2 remains the most valuable missing test (real `vm_bash` turn + real guard denial).

With R1 fixed, I consider the bundle **safe to install into the Desktop profile as an experimental
local plugin**: writes are confined to `$DSH_HOME/bots`, routes are authenticated owner-only, and
the remaining issues are UX/robustness edges rather than security or data-integrity defects.
Without R1, installation is still functionally safe but the bundle ships a failing test command,
so finishing that one-line test fix first is strongly recommended.

---

## Lead addendum (post-sign-off fixes)

The Lead applied the remaining items after the re-review:

- **R1 (fixed)** — `test/vm.test.mjs` creates a fresh `BotVm` right after the sticky-dispose
  check, so the later lifecycle checks run on a live executor. Full suite is green again:
  `BotVm Docker E2E: PASS (22/22 checks)`.
- **R2 (fixed)** — `BotVm.forget()` now cancels only children attributable to that exact bot
  (`record.botId === id`); long-lived control probes (`available`/`listImages`/`inspect`/
  shell probe) carry no bot id and are no longer disturbed by one bot's deletion.
- **R3 (fixed, moved)** — the post-delete orphan sliver is closed inside `BotVm.remove()`:
  after `docker rm -f` it waits 250 ms, re-inspects once, and removes a container that a
  racing `docker run` materialized (never touching a foreign one). `routes.handleDelete`
  stays a single `vm.remove()` call, so the route contract/tests are unchanged.
- R4 remains a documented minor (an agent whose reinstall throws loses its registration; the
  failure is recorded in `/api/bots.diagnostics` `errors`), and m2/m4/m5/n2/n3/n4/n6 remain
  open as acknowledged above.

Final verification after these fixes (Lead):

| Suite | Result |
|---|---|
| `store.test.mjs` | PASS 22/22 |
| `routes.test.mjs` | PASS 26/26 |
| `agent.test.mjs` | PASS (persona, `interpolate:false`, `{{…}}` literal, live VM-toggle refresh, shell guard) |
| `vm.test.mjs` | PASS 22/22 (real Docker 29.8.2, no leftovers) |
| `vm-lifecycle.test.mjs` | PASS (sticky dispose, delete tombstone, validated delete target) |
| `e2e-web.mjs` | PASS (throwaway profile: client bundle served, bot CRUD, real Agent persona/VM attach, live VM toggle refresh, VM lifecycle, delete) |

Install recommendation carried forward: safe to install as an experimental local plugin. T2
(vm_bash exercised through a real model turn) and T5 (DOM rendering) remain the top test gaps;
the UI page's visual/slot rendering is verified only by registration-shape review and the
served-bundle/module-graph E2E.
