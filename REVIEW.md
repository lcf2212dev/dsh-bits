# Independent review — Bots bundle (`@dsh-burn-plugins/dsh-bots` v0.1.0)

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
(`You are {{name}}, the researcher…`, `Reply to {{user}}`, `{{ name }}`) — the exact use case
this feature advertises (“permanent instructions”). The first model request in that bot session
fails during prompt assembly with `unknown prompt variable "{{name}}" in section
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
Failure scenario: `Chat` → `Edit` → enable “Virtual machine” → next message: agent can run
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
Failure scenario: user types a message and clicks “Delete bot” before the turn’s first
`vm_bash` finishes: orphan container remains running indefinitely.
Fix: add a deleted/tombstone set consulted by `vm_bash` (`when` and `execute`) and by
`installBotAgents`; make `ensure()` carry a record-existence check (inject a `isKnownBot(id)`
callback) so a deleted bot cannot recreate a container; after deleting the record, retry/collect
container removal and surface a warning in the diagnostics/log. Add a test for
delete-while-exec-running.

### MINOR

#### m1. Concurrent `ensure()` reports a false `VM_NAME_CONFLICT` — `host/vm.js:547-570`
Two concurrent first-time starts (UI “Start VM” + first `vm_bash`, or two windows) both see the
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
image while the running container still uses the old one (the UI badge says “Running” with the
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
- n4. `client.js` registers a single dictionary: `ctx.locale.register(NS, { en: EN })`
  (`client.js:6938`), with the team strings (`TEAM_EN`, `client.js:1802`) merged into `EN`
  (`client.js:2097`). The earlier bilingual registration (two dictionaries, regional locale
  aliases and a language pack) is gone; the runtime is satisfied with the single `en` entry,
  which is the expected documented form. No functional defect found.
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
- Dictionaries: the single English dictionary (`EN`, absorbing `TEAM_EN`) covers every key the
  CONTRACT requires; reported errors are localized through `t`.
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
  boundary (“the host bash tool is hidden”): today it is only true at the moment the
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
| **B1** persona interpolation | **FIXED** | `host/agent.js:231-243` now registers the section with `interpolate: false` and a `text()` callback reading the live record. `test/agent.test.mjs` asserts `interpolate === false`, `typeof text === 'function'`, and that literal `{{name}}`/`{{source}}` in instructions survive. Correct: `dsh-system-prompt` only interpolates when `interpolate !== false` (`lib/index.js:119-121, 160-187`). |
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
| **n4** locale dict shape | **FIXED** (English-only) | `client.js:6938` registers `{ en: EN }`; the earlier bilingual registration and its locale aliases are gone. |
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

---

# Independent review — Projects layer (v4, 2026-11-10)

Fresh-eyes review of CONTRACT §12 (projects above teams, `shared` teams) on the uncommitted
working tree (HEAD `445eee5`), run in parallel with the implementation by a verifier teammate
that did not write the feature. Scope: `host/projects.js`, `host/project-routes.js`, the team
`shared`/`projectIds` fields and validation, route wiring, `client.js` (Projects tab, editor
fields), docs and tests.

## Rerun results (exact)

| Suite | Result |
|---|---|
| `test/projects.test.mjs` | PASS 31/31 |
| `test/teams.test.mjs` | PASS 28/28 (+ shared/projectIds cases) |
| `test/catalog.test.mjs` / `store.test.mjs` / `routes.test.mjs` | PASS 12 / 22 / 26 |
| `test/agent.test.mjs` / `notify.test.mjs` | PASS / 6 |
| `test/team-runtime.test.mjs` / `harness.test.mjs` | PASS 12 / 5 |
| `test/e2e-web.mjs` | PASS (isolated profile + real host + VM; new `5e/7` section exercises project CRUD, membership round-trip, unknown-project rejection, delete/detach on the real routes) |
| `test/visual-teams.mjs` | PASS (editor flow, no v4 regression) |
| `test/visual-projects.mjs` | PASS (Projects tab end-to-end in headless Chrome: create/edit/delete project, add teams, new team in project, shared toggle, blocked non-shared team, detach, badges) |

## Findings

- **L1 — `.gitignore` (`/projects.json` missing). Fixed by the Lead after the review:**
  `/projects.json` and both `*.bak-*` backup patterns are now ignored beside `/teams.json`.
- **L2 — Projects list card shows the team count as the role line, not only as a badge
  (cosmetic, accepted).** The duplicate badge was removed in review; the count stays visible
  once. CONTRACT §12.4 wording says "badge" but the detail header does use a badge.
- **L3 — team/harness routes validated project ids while awaiting only `teamsReady`
  (theoretical boot race). Fixed by the Lead:** both now await
  `Promise.all([teamsReady, projectsReady.catch(() => undefined)])`, so a broken
  `projects.json` still never blocks the team routes.
- Coverage gaps accepted (code-reviewed, not automated): `fromPack` + `projectId` is covered by
  `test/projects.test.mjs` but not the e2e (no harness pack fixture in a fresh profile);
  client-side export/import project-id handling and the "projects route missing (404)"
  degradation have no automated test.

Data model/route invariants verified against the contract: atomic ProjectStore persistence,
limits and corrupt-file quarantine; `shared: false` teams limited to one project on the merged
record; unknown project ids rejected with coded errors on create/update; project deletion
detaches teams first (aborts before removing the project if a detach fails) and reports
`detachedTeams`; v1–v3 `teams.json` loads unchanged with `shared: false` / `projectIds: []`.

## Verdict

**SHIP** — no blocking findings. All suites green; three LOW-polish items either fixed by the
Lead or accepted as cosmetic. Live profile migration (DSC project + six DSC teams) and the
in-process plugin reload were verified by the Lead afterwards.

---

# Independent review — Bits v5 (2026-11-10)

Fresh-eyes, read-only review of the v5 rebuild of `@dsh-burn-plugins/dsh-bots` (working tree at HEAD
`445eee5`, still uncommitted), written by the verifier teammate that wrote none of the v5
code. Audited against `V5-CONTRACT.md` (the whole file), with the severity/style conventions
of the reviews above. The only file this verifier wrote is this section; no code, test,
profile or git change was made. All suites and probes below were re-run by me — no teammate
claim was taken on trust.

Scope exercised: `host/store.js`, `host/catalog.js`, `host/routes.js`, `host/models.js`,
`host/bit-runtime.js`, `host/teams.js`, `host/team-routes.js`, `host/harness-routes.js`,
`host/team-runtime.js`, `host/team-prompt.js`, `host/team-guard.js`, untouched
`host/team-bindings.js` + projects layer, `index.js`, `client.js`, `bits/catalog.json`,
`bits/teams/engineering.json`, package/locale/cordis config, docs, the claude-delegate
plugin change, and the real persisted state under `~/.dsh/bots`.

## Rerun results (exact)

| Command | Result |
|---|---|
| `node test/store.test.mjs` | **PASS** — `store: 33 tests passed`, exit 0 |
| `node test/catalog.test.mjs` | **PASS** — `catalog: 16 tests passed`, exit 0 |
| `node test/routes.test.mjs` | **PASS** — `routes: 36 tests passed`, exit 0 |
| `node test/teams.test.mjs` | **PASS** — `teams: 46 tests passed`, exit 0 |
| `node test/projects.test.mjs` | **PASS** — `projects: 31 tests passed`, exit 0 |
| `node test/harness.test.mjs` | **PASS** — `harness: 9 tests passed`, exit 0 (incl. real DSC harness) |
| `node test/bit-runtime.test.mjs` | **PASS** — `bit-runtime: 13 tests passed`, exit 0 |
| `node test/team-runtime.test.mjs` | **PASS** — `team-runtime: 16 tests passed`, exit 0 |
| `node test/e2e-web.mjs` | **PASS** — 9/9 sections, throwaway `DSH_HOME`, temp profile removed; without the delegate plugin the subscription run fails with the actionable `BIT_DELEGATE_UNAVAILABLE` and a DSH-route worker with `BIT_MODEL_INVALID`; 52 catalog bits/4 orchestrators, 3 subscription model options, team template instantiates 11 bits+members, removed v4 routes answer non-200 |
| `BITS_E2E_DELEGATE_DIR=/home/leandro/Documents/deepseek-harness/default-workspace/dsh-claude-delegate node test/e2e-web.mjs` | **PASS** — real subscription worker: `REAL subscription run answered in 4923ms: ok`, `meta.backend = claude-code`, `meta.model = subscription/haiku`; delegate plugin installed from its local dir into the throwaway profile |
| `node test/visual.mjs --width 1440 --height 900` | **PASS** — `VISUAL DONE`, exit 0 (7 dark screenshots + card/dialog/Run interactions) |
| `node test/visual-teams.mjs --width 1440 --height 900` | **PASS** — 2/2 checks (fromTemplate in the UI/fresh bitId members/orchestrator-only lead/`teams.run` wiring; editor interactions incl. member bit picker/read-only route) |
| `node test/visual-projects.mjs --width 1440 --height 900` | **PASS** — project CRUD/membership/shared rule/detach/badges, exit 0 |
| adversarial probe scripts (`/tmp/v5verify/adversarial1.mjs`, `adversarial2.mjs`; not part of the repo) | **PASS** 26/26 and 32/32 — see "Adversarial checks executed" below |
| `node --check` on `index.js`, `client.js`, `host/*.js`; JSON parse of catalog/templates/locale/package | **PASS** — syntax and documents valid |

Counts match the `await test(...)` declarations exactly (33/16/36/46/31/9/13/16): no test is
skipped, stubbed out or silently short-circuited, and every suite is exit-0.

Independent checks beyond the shipped tests:

- **§4 catalog table**: parsed the contract table and compared it byte-for-byte with
  `bits/catalog.json` → 52/52 rows **EXACT MATCH**, `version: 2`, exactly four
  orchestrators (bit-manager/product-owner/coordinator/sub-coordinator), only
  `isOrchestrator`/`model`/`effort` added versus `HEAD` — groups, names, emoji, colors,
  summaries and instructions are identical; no orphan avatar.
- **Live migration state** (`~/.dsh/bots`, read-only): `bits.json` is `statusVersion 2` with
  21 bits and **no `vm` field**; the one v4 bot (`210cd64d6a` Debugger) was copied with
  id/name/character/emoji/color/instructions/workspaceDir/createdAt/updatedAt byte-identical
  and catalog defaults (`subscription/opus`, `xhigh`); the log line
  `migrated 1 bot(s) from bots.json to bits.json (backup bots.json.migrated-...)` is present.
  `teams.json` has 6 teams, 0 members without `bitId`, 0 stale references, 0 invalid leads;
  all 9 orchestrator bits use `deepseek-account/deepseek-flash`/`max`; migration summary
  `6 teams, 20 bits created`, backup `teams.json.bak-1794325922486`; later plugin loads
  logged no second migration. `projects.json` and `team-bindings.json` untouched by v5.
- **Host API surface cross-check against the installed DSH runtime**, not just the fixture:
  `ctx.tools.execute` returns `{ results: [{ callId, result }] }` with the canonical success
  result carrying `value` (`dsh-tools/lib/types/batch.js:229`,
  `dsh-tools/lib/types/pipeline.js:735`), `agent.model.select({provider, model,
  reasoningEffort})` (`dsh-agent/lib/index.js:198`), `subagents.startActivation` with
  `delivery: 'caller'` (`dsh-subagent/lib/index.js:1401`), `sessionController.create`/
  `resolveAgent`, `sessionTitle.rename(session, title)` and `workspaceRegistry`
  `resolveByPath/create/attachSession` all exist with those signatures.
- **Finish vocabulary**: installed adapters report a normal stop as `{kind: 'stop'}`
  (`dsh-llm-pi-ai/lib/index.js:1506`, `dsh-llm-deepseek/lib/index.js:1930`); the assembler
  normalizes a stream that ends without a `finish` chunk to `{kind: 'stop'}`. The runtime's
  "stop counts as success" is therefore required by this DSH build, not a shortcut.
- **claude-delegate diff**: only the `readOnly` parameter, the `--permission-mode plan`
  branch (default still `--dangerously-skip-permissions`) and the README/description
  paragraphs changed; nothing else. The desktop profile links both
  `@dsh-burn-plugins/dsh-bots` and `@dsh-burn-plugins/dsh-claude-delegate` from these working trees
  (`~/.dsh/profiles/desktop/node_modules/@dsh-burn-plugins/*` are symlinks), so the flag is live
  after a plugin reload — no reinstall step needed.

## Findings

**0 BLOCKER, 0 MAJOR, 2 MINOR, 5 NIT. None of them blocks shipping.**

### F1. MINOR — a failed template instantiation rolls back the bits but leaves their workspace directories behind — `host/team-routes.js:472-481`, `host/store.js:670`
`instantiateTeamTemplate` creates one bit per template entry; `BitStore.create()` always
mkdirs `<botsRoot>/<id>/workspace` (`host/store.js:670`). If the team creation then fails,
the rollback loop removes the *records* with `deps.bits.remove(bit.id)` but not their
workspaces. Reproduced independently: forcing `teams.create()` to throw left **11 orphan
directories** under a clean `botsRoot` with 0 bit records. Reachable when `teams.create`
fails after the bits exist — e.g. a profile already at the 200-team `TEAM_LIMIT`, or a
project/team validation failure that is not caught before instantiation. Retrying leaks
another 11 directories each time; the UI has no way to see or delete them. No data loss and
no security impact (they are under the managed root and empty). Suggested fix:
`deps.bits.remove(bit.id, { deleteWorkspace: true })` in the rollback (workspaces created by
this path are always the default one under `botsRoot`, so the store's realpath guard still
applies). **Does not block shipping.**

### F2. MINOR — a team lead whose member `access` is `write` is not held to the lead-only toolset its prompt describes (inherited v4 policy) — `host/team-runtime.js:283-286`, `host/team-prompt.js:236`, `client.js:6899`, `host/teams.js:412-416`
`roleOf(binding)` treats a lead as "orchestrator" only when its member access is `read`
(`orchestrator: orchestrates(binding) && readOnly`); a lead with `access: 'write'` instead
gets `MEMBER_ALLOWED_TOOLS` (`bash`, `write`, `edit`, glob/web/…) and the lead-only read
boundary in the pre-execute policy (`host/team-runtime.js:1071-1078`) is skipped. Yet
`leadPromptText`/glossary always tells the lead it "only orchestrates: the terminal, write,
search and web tools are out of its reach" (`host/team-prompt.js:236`), and
v5 now requires the lead to be an orchestrator bit (§5.1). The editor does not prevent it:
the member access select is rendered for every member including the lead
(`client.js:6899`) and `normalizeTeam` has no lead-access rule
(`host/teams.js:412-416`). Concrete scenario: a user opens `DSC · Delivery`, changes the
lead member's access to "read and write", saves (accepted), and the next root session of
that team can run `bash`/`write` while its own prompt and flow skills say it cannot. The
policy is deliberately "kept from v4" (comment at `host/team-runtime.js:279-282`) and is
user-initiated, so this is a consistency/UX defect, not a privilege escalation. Suggested
fix: force `access: 'read'` for the lead in `normalizeTeam`, or treat `role === 'lead'` as
orchestrating regardless of access. **Does not block shipping.**

### F3. NIT — `.gitignore` misses the `.migrated-*`/`.corrupt-*` runtime artifacts (and `team-bindings.json`) — `.gitignore:10-22`
The added rules cover `bits.json`/`bots.json`/`teams.json`/`projects.json` and the
`*.bak-*` pattern, but not the other suffixes the stores actually write:
`bots.json.migrated-*` (contract §2 backup), `bits.json.corrupt-*`,
`bots.json.corrupt-*`, `teams.json.corrupt-*`, `projects.json.corrupt-*`, the
`bits.json.tmp-<serial>` write temporaries (the `*.tmp` rule does not match `.tmp-<n>`), and
`team-bindings.json`. Verified with `git check-ignore -v --no-index`: all of those are
reported as not ignored. Concrete scenario: the common local setup the comment describes
(`botsRoot` pointing at the repository while developing) leaves `bots.json.migrated-<ts>`
or a quarantined copy as untracked files a `git add -A` would commit. This is the same class
as L1 in the projects review. **Does not block shipping.**

### F4. NIT — §5.3 wording vs `teamFromPack`'s intermediate shape — `host/harness-routes.js:134-223`
`V5-CONTRACT.md` §5.3 says the pack→team helper returns `{ bits, team }` with "Team members
reference those bits (`bitId`)". The exported `teamFromPack` returns a *template* shape whose
members carry `bitKey` (the bits do not exist yet); only
`instantiateTeamTemplate`/`POST /api/bots.teams.fromPack` produce the contracted
`{ team, bits }` with `bitId` members, and that final response is correct (verified by
`test/harness.test.mjs` and `test/projects.test.mjs`). No behavioral failure; if anything
the intermediate shape is the only possible one before `bits.create`. Worth a doc sentence
naming the helper as template-shaped so external callers do not misread §5.3. **Does not
block shipping.**

### F5. NIT — `teams.json` keeps `statusVersion: 1` — `host/teams.js:39`
The teams document shape changed (members are bit references), but the store still writes
`statusVersion: 1` (confirmed in the live migrated `teams.json`). Migration is detected from
the member shape (`hasLegacyMembers`) and is idempotent, so this is purely a
versioning/diagnostics gap: a reader cannot tell a v4 from a v5 teams file by the version
field, and a future format bump will have to infer the generation from payload shape. The
contract does not require a bump, so this is a nit only (`bits.json` correctly uses 2).
**Does not block shipping.**

### F6. NIT — `access: 'read'` on a `teamRef` member is not propagated to the other team's lead child agent — `host/team-runtime.js:360-378, 435`
For a worker member the read-only intent is enforced through `readOnly: true` in the
delegate call (`:435`). For a `teamRef` member (a stand-in for another team) the child agent
is bound as that team's *lead*, so the child's guard uses the other lead member's access,
not the referencing member's. Concrete (narrow) scenario: mark a `teamRef` member as
read-only but the target team's lead has `access: write` — the delegated child can still
write. Inherited from v4 (the v4 runtime had the same teamRef binding), leads in shipped
templates are read-only, and the delegation is still within the same user's teams.
**Does not block shipping.**

### F7. NIT — a persisted orchestrator whose model is a subscription model loads and is listed; only execution fails — `host/store.js:949-1001`
`create`/`update` reject orchestrator+subscription (`assertOrchestratorModel`) and migration
cannot produce that pair, but `#normalizeLoadedRecord` performs no family check, so a
hand-edited `bits.json` record (or one written by a future/older tool) loads, appears in
`/api/bots.list`, can be chosen as a team lead, and only fails when a mission/delegation
calls `models.routeFor` (`BIT_MODEL_INVALID`). The failure is coded and actionable, and the
contract only requires validation on the write path; noted as a consistency nit, not a bug.
**Does not block shipping.**

## Verified as correct (with the authority checked)

- **§0 pivot**: no VM machinery anywhere in the working tree — `host/vm.js`, `host/agent.js`,
  `host/notify.js` and their tests are deleted; repository-wide grep finds `docker`/`vm`/
  `notify`/`Chat` only in historical `CONTRACT.md`, absence assertions in tests, or
  doc comments saying they were removed. `client.js` has no VM/chat/notify/`bots.images`/
  `bots.vm` string or call left (`test/visual.mjs` asserts the rendered page text too).
- **§1 models** (`host/models.js`): exact subscription labels/aliases/efforts; DSH route
  options carry label/backend/provider/model/tools/supportsOrchestrator; `list()` caches
  ~60 s (independently observed one `listProviders` call for two `list()` calls), never
  throws with zero providers / throwing registries / no `ctx.llm`, and still lists models
  without reasoning metadata with the contract fallback effort list; `resolve` accepts
  stored ids, bare legacy aliases and bare labels (`DeepSeek-V4.1-Flash`), is coded
  `BIT_MODEL_MISSING`/`BIT_MODEL_INVALID`; `effortFor` implements the exact
  `xhigh→xhigh|max|high`, `high→high|max`, `medium→medium|high|low`,
  `low→low|minimal|medium`, `max→max|xhigh|high` mapping and returns `undefined` when the
  model reports no efforts; `routeFor` refuses non-orchestrators and subscription routes,
  defaults to DeepSeek-V4.1-Flash Max, and drops an effort the profile rejects before
  judging the route (verified against a fake `resolveCallConfig`).
- **§2 store** (`host/store.js`): record shape/limits enforced with coded `BOT_*` errors;
  atomic tmp+rename+fsync write with `0600` (fixture mode check), serialized mutations and
  writes (no lost concurrent updates), deep-copied reads, `BOT_LIMIT` at 200, workspace
  deletion refused outside the root **and through a symlink** (independently re-verified),
  corrupt `bits.json`/`bots.json` quarantined without throwing.
- **§3.1 bots migration**: independent v4 fixture with `vm`, unknown character, missing
  character and an existing `bits.json` — fields copied, `vm` dropped, catalog defaults
  applied (incl. orchestrator lift for `bit-manager`), `bots.json.migrated-*` kept,
  `statusVersion: 2`, idempotent across boots, `bits.json` wins over a leftover
  `bots.json`, corrupt legacy file quarantined.
- **§3.2 teams migration**: independent v4 fixture (2 teams sharing a coordinator + builder,
  a third with an unknown character, 30 000-char member instructions) — 5 members deduped
  into 3 bits, member ids/roles/access/launches/lead/flow/harness preserved, lead bit forced
  to orchestrator/DeepSeek Max, instructions truncated to 20 000 (not lost), catalog
  emoji/color used, `teams.json.bak-*` written, idempotent on the second boot, unknown
  character falls back to `subscription/sonnet`/`high`, and a team whose conversion fails is
  preserved raw (in memory and in the rewritten file) and retried — never lost or throwing.
- **§5 teams**: unknown `bitId` → `TEAM_INVALID` naming `members[i].bitId`; lead rule
  enforced on create **and** update (`TEAM_LEAD_NOT_ORCHESTRATOR`); deleting a referenced
  bit does not make the team disappear, while re-sending the stale reference is refused;
  `teams.providers` gone (E2E gets a non-200 for it); `GET teams.templates` returns the new
  format including `bits`; `fromTemplate` creates fresh bits every time and links
  `bitKey→bitId`, and fails with full rollback on unknown character/team failure (F1 aside);
  `fromPack` creates bits first and returns `{ team, bits }`; the rewritten
  `bits/teams/engineering.json` preserves all 11 members' roles/access/launches, the 22-node
  flow/23 edges (identical to `HEAD`) and the team text, with the coordinator as
  orchestrator lead.
- **§6.1 bit runtime** (`host/bit-runtime.js`): subscription path calls
  `ctx.tools.execute({calls:[{id,name:'claude_delegate',arguments}]})` and reads the
  canonical `value`, with `task = instructions + '\n\n---\n\n' + request` (plus the report
  instruction when the bit has no instructions), `model` alias, mapped `effort`, `cwd`,
  `readOnly`; wired into the real DSH API (shape cross-checked against the runtime). All
  failure modes are coded/actionable (`BIT_DELEGATE_UNAVAILABLE` names the plugin and the
  `claude` login; missing `ctx.tools` covered). Ad-hoc `runBit` refuses orchestrators
  (`BIT_IS_ORCHESTRATOR`), enforces 1..20 000 chars, defaults `readOnly: true`, and only
  accepts an alternate cwd inside the bit workspace. DSH path is a single
  `ctx.llm.stream` call with the exact contract `messages` shape, concatenated
  `text-delta`s, `stop`/`success` success and coded `BIT_MODEL_CALL_FAILED` otherwise;
  `invokeWorker` composes the same prompt and propagates `readOnly` only for read access.
  Every one of these was re-driven with a fake host, including a real 4.9 s subscription
  invocation through the actual `claude_delegate` tool.
- **§6.2 team runtime** (`host/team-runtime.js`, `team-prompt.js`, `team-guard.js`):
  lead persona/route come from the lead bit (route validated by `models.routeFor`, applied
  with `agent.model.select` before `followup`); workers are one-shot through
  `bitRuntime.invokeWorker` with the contract cwd rule (caller cwd only inside the team
  workspace), `readOnly = member.access === 'read'` and the
  `[bit · backend/model · effort]` header; orchestrator members and `teamRef` targets keep
  the child-agent `startActivation` path with the target bit's route; provider pinning/
  label matching is gone; `team_handoff`, the pack guard, lead read policy, bindings,
  `team_send`, inbox drain, skills provider, `applyTo` post-execute, shell variables and
  diagnostics are all still present with the v5 wording. Verified again against the shipped
  `test/team-runtime.test.mjs`, which exercises these through the real
  `models`/`bitRuntime` implementation over a fake host.
- **§6.3 claude-delegate**: minimal diff (readOnly parameter → `--permission-mode plan`,
  default bypass preserved, README/description updated); the real subscription run through
  the installed tool returned a normal answer with `readOnly: true`, so the new path does
  not break the CLI invocation.
- **§7 routes** (`host/routes.js`): exactly the eight contracted `/api/bots.*` routes for
  the bit store (+ diagnostics registered by `index.js`), all HTTP-200 `{ok}` conventions,
  `bots`/`bot` aliases, no VM/images/notify routes, `BIT_RUN_TIMEOUT` with a configurable
  guard that also aborts the runtime signal, transport-abort forwarding, coded pass-through
  and uncoded→`BIT_RUN_FAILED`. Independently re-verified with a real `AbortController`
  harness.
- **§8 client**: verified by code read plus the three real-Chrome suites: cards show
  avatar/name/character/group/orchestrator-worker badge/model label·effort, no VM badge;
  the editor has the isOrchestrator switch, model select from `/api/bots.models` and effort
  select, snaps model+effort atomically in one state update when the family changes, offers
  "Restore default description", blocks orchestrator+subscription; workers get "Run"
  (request textarea, read-only default **on**, busy state, response/error panel) and
  orchestrators show "Executes in flows" + the teams they lead and no Run button;
  member editor picks a bit grouped by catalog group with role/access/launches/teamRef/mcp/
  skills and read-only model/effort badges, lead selector only offers orchestrator members,
  an invalid current lead is shown inline, save is blocked with a toast; templates create via
  `POST /api/bots.teams.fromTemplate`; "Send request" calls `POST /api/bots.teams.run`,
  shows busy/created-session and opens it through `uiWorkspace.openSession` when possible;
  the flow editor and Projects tab are behaviourally unchanged; the single English dictionary
  covers the new keys (no missing key). The served bundle renders
  in the real host (E2E) and in headless Chrome (visual suites).
- **§9 files/config/docs**: deletions done; `package.json` v0.4.0 description/keywords have
  no VM terms; `cordis.patch.yml` `bots` row config is empty (`botsRoot` only, as allowed);
  locale metadata says Bits/flows; README is truthful against the code (execution matrix,
  migration, requirements incl. the `claude_delegate` dependency and
  `BIT_DELEGATE_UNAVAILABLE`, paths, routes, tests, diagnostics, security limits);
  `CONTRACT.md` now opens with a v5 pointer and is labelled historical.
- **§10 per-owner suites** all green as listed above; the only repo files my runs touched
  are the regenerated `test/screenshots/*.png` (expected deliverables of the visual suites)
  — no source, store or fixture file changed.
- **Projects layer untouched**: `host/projects.js` / `host/project-routes.js` still carry
  their pre-v5 mtimes and `host/team-bindings.js` is identical to `HEAD`; the projects suites
  and E2E project section pass unchanged.

## Adversarial checks executed (not part of the repo)

Independent fixtures driven directly against the shipped modules:

1. **v4 `bots.json` migration**: fields/backup/`vm` drop/catalog defaults/unknown character/
   idempotency/existing-`bits.json`-wins/corrupt quarantine/`0600` mode; workspace directory
   creation left to `ensureWorkspace` (create-time) rather than migration.
2. **v4 `teams.json` migration**: cross-team dedupe (3 bits for 5 members), lead upgrade,
   20 000-char instruction truncation, member-id/lead/flow preservation, backup+idempotency,
   failed-conversion preservation, unknown-character fallback.
3. **Stale/deleted bit**: persisted team with a deleted bit still loads and is listed, while
   create/update with the stale `bitId` fails `TEAM_INVALID`; deleted-bit delegation would
   fail coded (also covered by the shipped fake-host test).
4. **Model family coherence**: orchestrator+subscription rejected on create/update; a
   hand-written persisted orchestrator+subscription record loads but `routeFor` fails
   `BIT_MODEL_INVALID`; lead rule refused on create/update.
5. **Model catalog**: no `ctx.llm`, zero providers, throwing `listProviders`/`listModels`,
   unresolved efforts, caching, bare-label resolution, effort-alias mapping, effort-dropping
   by `resolveCallConfig`.
6. **Bit runtime**: canonical pipeline result shapes (matching/missing callId, `isError`,
   undefined `value`, non-string value, `execute` throw, aborted signal), prompt composition,
   cwd containment, request bounds, both backends, `readOnly` true/false propagation,
   one-shot option shape (no tools/readOnly key) and error-code mapping.
7. **Route guard**: `BIT_RUN_TIMEOUT` fires and aborts the runtime signal with a
   never-settling runtime; transport abort reaches the runtime; coded/uncoded/malformed
   runtime results; eight-route registration list; runtime-unavailable paths.
8. **Template/rollback**: fresh bits per instantiation, rollback with a failing team store,
   unknown-character rollback, malformed/`bits`-less templates skipped, shipped engineering
   template validation (11 bits, lead orchestrator route/max).
9. **Path escapes**: workspace deletion outside the root and through a symlinked workspace
   both refused without deleting the target.

## Security and operational notes (accepted, per contract)

- **Write-access subscription workers run with `--dangerously-skip-permissions`** by design
  (contract §0/§6.3): the Harness guard does not apply inside Claude Code; the effective
  boundaries are the cwd (team workspace) and the permission mode, and repo/web content in
  the prompt can steer the subscribed CLI. The contract explicitly keeps bypass as the
  default; members marked `access: read` get `readOnly: true` → `--permission-mode plan`,
  which the real E2E invocation exercised. Documented in README's "Security and limits";
  no change requested.
- No new network/auth surface: routes stay on the authenticated host connection registry
  (same convention as v4); the avatar route stays id-whitelisted (no path escape); the
  diagnostics route exposes paths/errors but keeps the v4 owner-only auth and reports no VM
  fields; deleting a bit cannot delete a directory outside `botsRoot` (realpath-checked).
- Ad-hoc runs are bounded (1..20 000 chars request, read-only default on, 15 min route guard
  with abort) and delegation results are plain text; huge worker output relies on the
  delegate plugin's own 8 MB stream cap, as in v4.

## Coverage gaps accepted

- **No end-to-end run of a real lead mission** (`teams.run` success) or a real
  orchestrator→worker delegation through the Harness: the isolated E2E profile has no LLM
  provider/credentials, so only the deterministic error paths run there; the fake-host
  `test/team-runtime.test.mjs` drives the real `models`/`bitRuntime`/`team-prompt`/guard
  code for those paths, and the real subscription *worker* is exercised over HTTP. A live
  mission remains manually verified only.
- **No E2E coverage of the DSH one-shot backend with a real provider** (same reason — the
  profile has no providers); covered by fixture streams only.
- **Team inbox drain** (`<botsRoot>/team-inbox`) has no automated test (pre-existing v4 gap;
  the feature is unchanged).
- **UI `openSession` happy path** (navigate to the created mission) is only wired/visual-
  checked; the visual suites do not open a real session.
- **`teamFromPack` + `projectId`** covered by unit tests, not by the E2E (no harness pack in
  a fresh profile).
- A route-level test cannot prove that `--permission-mode plan` blocks writes inside Claude
  Code (that is Claude Code's contract); the flag construction is diff-reviewed and the
  invocation succeeds.
- F1/F2/F6 are code-reviewed edge cases; no regression tests were added for them (this
  verifier may not edit tests).

## Verdict

**SHIP.** The v5 rebuild is contract-compliant on every numbered section I could verify
(§0–§10): the product pivot is complete (no Docker/VM/chat/notify remnants, deleted files,
removed routes), the bit/team/model data model and both migrations match the contract
(verified independently and on the live migrated profile), the model catalog and both
runtime backends behave as specified against the *real* installed DSH APIs (including one
real Claude-subscription invocation), the team runtime keeps delegation/handoff/guard/skills/
bindings semantics with the v5 lead routing, the client implements §8 and renders correctly
in real Chrome, and every shipped suite is green with its full declared test count.
Two minor robustness/consistency findings (F1 orphan workspaces on a failed template
instantiation, F2 write-access lead vs. its prompt/guard) and five nits (F3 `.gitignore`,
F4 teamFromPack intermediate shape, F5 teams `statusVersion`, F6 teamRef read-only
propagation, F7 load-time family validation) remain; none is a data-integrity, security or
shipping blocker, and F1/F2 are cheap follow-ups. My runs also left the working tree in its
expected deliverable state (regenerated screenshots only).

---

## Lead addendum (post-sign-off fixes, Bits v5)

The Lead applied the cheap items from the v5 review after the sign-off:

- **F1 (fixed)** — a failed `fromTemplate` instantiation now rolls back each created bit
  with `{ deleteWorkspace: true }` (`host/team-routes.js`), so no orphan workspace
  directories remain; `test/teams.test.mjs` records the `remove(id, options)` calls of the
  rollback and asserts the workspace deletion.
- **F3 (fixed)** — `.gitignore` now covers `.tmp-*` atomic-write leftovers,
  `*.migrated-*`/`*.corrupt-*` quarantine files, `team-bindings.json` (+ backups) and
  `team-inbox/`.
- **F4 (fixed in `V5-CONTRACT.md`)** — §5.3 now states that `teamFromPack` returns the
  intermediate `{ bits, team }` with template-local `bitKey` members and that the route
  resolves them to `bitId` when creating the team.
- **F5 (fixed)** — `host/teams.js` persists `statusVersion: 2` for the v5 member shape
  (the loader keeps ignoring the field, so old files still load); the persistence unit test
  was updated accordingly.
- **F2, F6, F7 (accepted, documented)** — a `write`-access lead keeps the inherited v4
  member toolset; `teamRef` read-only does not propagate to the other team's lead; and a
  hand-edited orchestrator record with a subscription model is rejected at execution with
  the coded `BIT_MODEL_INVALID` (create/update already reject it at the boundary). None is
  a data-integrity or security blocker; they remain as known edge cases.

Final verification after the fixes (Lead): `node test/teams.test.mjs` →
`teams: 46 tests passed`; the full suite and E2E were re-run green before the addendum, and
the fixed code paths are covered by the updated tests. The installed desktop profile was
remounted with the final v5 host plugin (`include:bots` disable/enable) after the review,
with the live data already migrated on first load.


# Independent review — Bits Orchestrator chat preset (2026-11-10)

Fresh-eyes, read-only review of the Bits Orchestrator chat-preset increment (working tree at
HEAD `5b17dea`, feature still uncommitted), written by the verifier teammate who wrote none of
it. Audited against `/tmp/bits-orchestrator/PLAN.md` (the Lead's contract), the recon report and
spike evidence in `/tmp/bits-orchestrator/`, and the final source itself; no teammate report was
taken on trust. The only file this verifier wrote is this section. No commit/push, no
source/test/doc/profile edit, no touch of the real `~/.dsh` or the running app: every proof
below boots its **own** throwaway `DSH_HOME` under `/tmp` and removes it, and the helper scripts
live in `/tmp/orch-verify/` (not in the repo).

Scope exercised: new `host/orchestrator.js` (556 lines); diffs of `host/team-runtime.js` (+4),
`index.js` (+20), `cordis.patch.yml` (+137), `test/team-runtime.test.mjs` (+15),
`test/e2e-web.mjs` (+151/-13), `README.md` (+67), `V5-CONTRACT.md` (+227); new
`test/orchestrator.test.mjs` (395 lines); the installed DSH app `0.2.2-rc.1` APIs the runtime
relies on.

**Verdict: SHIP — 0 BLOCKER, 0 MAJOR, 1 MINOR, 4 NIT.** None blocks shipping; the MINOR is a
maintenance risk in the preset child-list copy, not a defect in the shipped behaviour.

## Rerun results (exact, re-run by this review)

| Command | Result |
|---|---|
| `node test/store.test.mjs` | **PASS** — `store: 33 tests passed`, exit 0 |
| `node test/catalog.test.mjs` | **PASS** — `catalog: 16 tests passed`, exit 0 |
| `node test/routes.test.mjs` | **PASS** — `routes: 36 tests passed`, exit 0 |
| `node test/teams.test.mjs` | **PASS** — `teams: 46 tests passed`, exit 0 |
| `node test/projects.test.mjs` | **PASS** — `projects: 31 tests passed`, exit 0 |
| `node test/harness.test.mjs` | **PASS** — `harness: 9 tests passed`, exit 0 |
| `node test/bit-runtime.test.mjs` | **PASS** — `bit-runtime: 13 tests passed`, exit 0 |
| `node test/team-runtime.test.mjs` | **PASS** — `team-runtime: 17 tests passed`, exit 0 (16 + the new preset-session test) |
| `node test/orchestrator.test.mjs` | **PASS** — `orchestrator: 9 tests passed`, exit 0 |
| `node test/e2e-web.mjs` | **PASS** — `E2E PASS`, exit 0, **10/10 sections**, throwaway profile removed by its cleanup; section 10 printed `roster: standard, ptc, minimal, cordis, bits-orchestrator`, `session … created with agentPreset=bits-orchestrator`, `installed=[session-…:bit_delegate]` |
| `node --check` on `index.js`, `host/orchestrator.js`, `host/team-runtime.js`, `test/orchestrator.test.mjs`, `test/team-runtime.test.mjs`, `test/e2e-web.mjs` | **PASS** — all 6 parse |
| JSON parse of `bits/catalog.json` + `package.json` | **PASS** — 52 bits, 7 groups, 4 orchestrators |
| `/tmp/orch-verify/validate-yaml.mjs` (app's own `loadOverlayPatches` + `composeEntries`, installed `standard.patch.yml`) | **PASS** — bundle patch parses; `bots` row id/name/config unchanged; preset `id/name/order/isDefault` correct; `config.plugins` **deep-equal** to the installed `preset-standard` child list (22 top-level entries, 3 `!!js` expressions: `process.platform === 'win32'`, `process.platform !== 'win32'`, `!ctx.get('profileContext')`); composition over `[base, web-app, bundle]` yields 194 entries including both rows |
| `/tmp/orch-verify/fresh-profile.mjs` (verifier's own fresh profile, not the repo e2e) | **PASS** — see item 2 below |
| `/tmp/orch-verify/fresh-team-separation.mjs` (real host, throwaway profile) | **PASS** — a normal chat in a `bindWorkspace` team directory becomes the team lead (positive control) while a `bits-orchestrator` chat in the same directory only gets `bit_delegate` (item 3) |
| `/tmp/orch-verify/adversarial.mjs` (verifier's fake-host probes, real `BitStore`/catalog/`installTeamRuntime`) | **PASS** — 21/21 probes |
| `/tmp/orch-verify/duplicate-preset.mjs` (second same-id preset row in the profile patch) | **PASS** — host still boots; exactly one healthy `bits-orchestrator` (the bundle row); the duplicate row is rejected with `Duplicate agent preset: bits-orchestrator` in the boot log |
| `git diff --check` / `git status --porcelain` | **PASS** — no whitespace errors; only the 7 expected modified + 2 expected new paths (no scope creep, no stray artifacts) |

All counts match the contract exactly (33/16/36/46/31/9/13/17/9, e2e 10/10); e2e was run twice end-to-end
during the review, green each time, and its cleanup removed its temporary profile.

## Independent verification (by checklist item)

### 1. Rerun of every suite, syntax and the preset declaration

- Every command in the table ran in this session; no test was skipped or filtered. `team-runtime`
  is 17 because of the additive preset test; `orchestrator` is the new suite. Both new files pass
  `node --check`.
- `cordis.patch.yml` was parsed with the **DSH app's own loader schema** (not a plain YAML
  library), so the `!!js` nodes were parsed exactly as boot parses them, and the bundle patch was
  applied with the app's own `composeEntries` over `[dsh-base, dsh-web-app, dsh-bots]` — both
  rows mount. The preset child list is semantically identical to the installed
  `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` (22 entries; the 4 `disabled` values
  compare equal, including the 3 parsed `{ "__jsExpr": … }` nodes), and the `bots` row's
  id/name/config are unchanged from `HEAD`.
- The app's installed `standard.patch.yml` child count is **exactly** the 22 rows the preset
  declares; the README/V5 claim "48 worker entries" matches `bits/catalog.json` (52 − 4
  orchestrators).

### 2. Fresh-profile proof from the verifier's own script (`/tmp/orch-verify/fresh-profile.mjs`)

Built a new throwaway `DSH_HOME`, a profile with `@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-web-app` + the working-tree bundle (`file:` dep), `pnpm install` with the
installation's own runtime node/pnpm, booted the real web host (`dsh --profile … --no-open
--port <free>`), authenticated with the launch token, and asserted over the authenticated HTTP
bridge:

- `agentPresets/list` (`args {}`): roster `standard, ptc, minimal, cordis, bits-orchestrator`,
  orders exactly `[1,2,3,4,5]` and sorted; `bits-orchestrator` has name **Bits Orchestrator**,
  order **5**, `isDefault: false`, no `broken` field, and the description is **byte-exact** to
  the intended text; `standard` is still `isDefault: true`; **no** preset in the roster is
  broken.
- Control: `session/create` **without** `agentPreset` still records `standard` (the profile
  default was not changed).
- `session/create` with `agentPreset: 'bits-orchestrator'` returns
  `{ sessionId: 'session-…', agentPreset: 'bits-orchestrator' }`; `session/list` (`args
  {"_request":{}}`) projects `projections.values.agentPreset === 'bits-orchestrator'` for that
  session; `session/prompt` (`mode: 'queue'`) returns `accepted: true`.
- `GET /api/bots.diagnostics`: `orchestrator.presetId === 'bits-orchestrator'`,
  `installed === [{ sessionId, tools: ['bit_delegate'] }]` for **that** session, `errors: []`,
  `notes: []`; the standard control session is **not** instrumented. The reported `sessionId`
  equals the `session/create` id (diagnostics identity: DSH enforces
  `agent.id === agent.session.id` in `@deepseek-ai/dsh-agent/lib/index.js:643`, and the live host
  observation confirms it).
- Independently re-read the profile-**installed** `cordis.patch.yml` and compared its preset
  `config.plugins` to the installed `standard.patch.yml`: deep-equal, 22 entries, 3 `!!js`.
- Isolation: the session persisted only under the throwaway `$DSH_HOME`; no `verify-orch`
  profile under real `~/.dsh/profiles`; no session of this run under real `~/.dsh/sessions`; the
  real `~/.dsh` top-level metadata snapshot was unchanged. All temp homes/sessions removed.

### 3. Adversarial probes (`/tmp/orch-verify/adversarial.mjs`, 21/21 PASS; plus the real-host team proof)

Using the exported `presetIdOfSession`/`isOrchestratorSession`/`installOrchestrator`/
`installTeamRuntime`, the real `BitStore` and the real catalog (fake host whose `agent/created`
dispatch is **serial and awaited, rejecting on listener rejection**, like `agents.announce`):

- **Detection:** trimmed header preset only; non-string/blank/other presets → null; exact
  `bits-orchestrator` id only (not `Bits-Orchestrator`, not `bits-orchestrator-2`).
- **Installation:** already-live agents are swept at install; standard/no-preset agents get no
  section/tool; duplicate `agent/created` events do not double-register; `agent/disposed`
  removes the section and the tool; `dispose()` clears all installed agents, is idempotent, and
  a post-dispose `agent/created` is inert.
- **Prompt:** role text, "the chat's model and effort are the user's — this mode never changes
  them", `bit_delegate({ bit, task, read_only })`, one-shot semantics, `read_only` default
  `true`, parallel calls, auto-provision/reuse, the roster shows **exactly the 48 worker
  characters** with each one's catalog `model · effort`, the 4 orchestrator characters are
  excluded from the roster, and group headings are unique; the section has name
  `bits:orchestrator`, order `700`, `interpolate: false`, and stable text.
- **Delegation:** existing bit by id and by trimmed/case-insensitive name → the runtime receives
  that bit, the session cwd, the exec signal identity, `readOnly: true` by default and `false`
  when forwarded; `exec.agent` (tool run in another agent scope) wins for the cwd over the
  captured agent; cwd falls back to `session.header.cwd` when
  `workingDirectory.get` throws. Result header is
  `[<bit> · <backend>/<model> · <effort>]` in all shapes (claude-code short alias, dsh
  provider/model, no-effort omitted, empty text placeholder) and mirrors
  `resultRouteText` in `host/team-runtime.js`. `presentCall` titles resolve cheaply and fall
  back to `Bit delegate`.
- **Catalog auto-provisioning:** delegating to `Scout`/`bit-scout`/`sCoUt` creates exactly one
  bit whose `name/emoji/color/instructions` are the catalog's and whose `model`/`effort` are the
  catalog preset values (passed explicitly); later delegations by name and id reuse it; **6
  concurrent mixed name/id calls create exactly one bit** and all invocations use that bit; a
  deleted/edited model/effort stays as the user edited it (no overwrite); an existing bit by
  name wins over the catalog (no duplicate created).
- **Refusals:** all 4 orchestrator catalog characters (by name and id) and any bit with
  `isOrchestrator: true` (by id, name and whitespace/case variants) are refused with coded
  `BIT_IS_ORCHESTRATOR` and **create nothing**; unknown target → coded `BIT_UNKNOWN` with
  suggestions; empty `bit`/`task` → `BIT_DELEGATE_INVALID` and never reaches the runtime; missing
  `bitRuntime` (and missing bits store when provisioning) → `BIT_DELEGATE_UNAVAILABLE`.
- **Cancellation:** the exec signal is forwarded to `invokeWorker`; an aborted invocation's
  original error propagates unchanged (not swallowed, not recoded); a non-aborted coded failure
  keeps its code, an uncoded one is wrapped as `BIT_RUN_FAILED`.
- **Diagnostics/dispose:** exact shape `{presetId, installed:[{sessionId, tools}], errors,
  notes}`, timestamped errors/notes, ambiguous-name note is capped (≤20) while the
  first-in-store-order bit is used, `installed` lists only instrumented orchestrator sessions.
- **Hook safety:** with an agent whose `systemPrompt.section` **and** `tools.register` both
  throw, and an agent whose header `agentPreset` getter throws, the awaited serial
  `agent/created` dispatch **resolved** (never rejected); failures landed in
  `diagnostics().errors`; a partial install (tool only) is still reported; a throwing
  `ctx.agents.list()` sweep is reported and does not break later installs.
- **No model/effort override:** a Proxy on the chat's `session`/`header` and a spy on
  `agent.model.select` recorded **zero** writes/selection calls during install and a real
  delegation; a source scan of `host/orchestrator.js`/`index.js` finds no
  `model.select`/`setModel`/`modelSelection`/`reasoningEffort`/session-or-header model/effort/
  preset write; the ONLY `agent.model.select` in the plugin is the pre-existing
  `startMission` team-lead route path (`host/team-runtime.js:806`), which a preset session can
  never reach because `resolve()` returns `null` before any binding lookup; the preset id is
  read/compared only, never written.
- **Team separation (real host, `/tmp/orch-verify/fresh-team-separation.mjs`):** created a real
  bit + `bindWorkspace` team in a throwaway profile, then created a **normal** session with cwd
  inside the team repo → `/api/bots.diagnostics.agents` installs it as `role: 'lead'`
  (positive control); created a **preset** session with the same cwd → it appears under
  `orchestrator.installed` with `bit_delegate` and is **absent** from the team agents (no team
  prompt, no `team_delegate`, no binding); a chat outside the dir is not a team agent either.
  The fake-host probe additionally asserts `runtime.bindings.get(presetSession) === undefined`
  and no restrictions/`team_delegate`/team section on the preset agent, while the normal
  session in the same directory gets all three.
- **Duplicate preset declaration:** a profile patch declaring a second
  `@deepseek-ai/dsh-agent-preset` row with `config.id: bits-orchestrator` does **not** break the
  host: the web host boots, the roster has exactly one healthy `bits-orchestrator` (the bundle
  row), and DSH rejects the duplicate row (`Duplicate agent preset: bits-orchestrator` in the
  boot log). No plugin-side guard is needed because the bundle ships exactly one row.

### 4. Docs accuracy and English-only

- `README.md` "Chats in orchestrator mode" (`README.md:133`) matches the implementation on every
  checkable point: selectable and not the default; standard-child-list chat plus the
  orchestrator prompt and `bit_delegate`; the chat's own model/effort are never pinned; one-shot
  workers in the chat's cwd; `read_only` default `true` / `false` for edits and commands;
  parallel calls; first-use creation from the catalog preset and later reuse with the user's
  edits; the four orchestrator characters and any orchestrator bit refused; never a team lead;
  created bits stay normal bits. The "Settings → presets" / new-session picker wording matches
  the installed UI packages (`dsh-client-ui-agent-preset` renders "Agent presets" in Settings
  and the per-session preset picker).
- `V5-CONTRACT.md` §12 (`V5-CONTRACT.md:551`) matches the code: preset id/row id/order/standard
  child-list copy rationale and version pin; header-only detection and the sweep; prompt section
  name/order/`interpolate: false`; tool parameter table/defaults; resolution order
  id → name → catalog → `BIT_UNKNOWN`; catalog reuse/creation with explicit preset model/effort
  and the in-flight dedupe; `BIT_IS_ORCHESTRATOR`; cwd chain; result header mirroring team
  delegation; `BIT_DELEGATE_INVALID`/`BIT_DELEGATE_UNAVAILABLE`; `agent/disposed`/`dispose` and
  the diagnostics payload; team-mode separation; the three test layers; the files table; and
  the claim that this extends v5 (new §12 after §11).
- English-only: a grep for accented Latin characters and common Portuguese words over every
  changed file found **none**; the only non-ASCII character in the changed files is a
  pre-existing `256×256` README line that is not part of the diff. No Portuguese in code,
  comments, prompt text, tests or docs.

### 5. Quality, scope and regression review

- Existing behaviour: the 9 pre-existing suites and the 9 pre-existing e2e sections are green;
  `host/team-runtime.js` changes are exactly the import + two comment lines + the `resolve()`
  early return, with no other behaviour change; `bots` row untouched; no dependency/version/
  client/route changes beyond the documented diagnostics key.
- No regression in normal chats: the runtime only acts on sessions whose header records
  `bits-orchestrator`; a preset-less session (standard) is not instrumented (verified in both
  the fresh profile and the unit probes), and the standard preset roster/default are unchanged.
- Diagnostics identity is correct (`agent.id` is the session id in DSH); the e2e observes the
  same id it created.
- Live-profile interaction: the feature's only runtime write path is the existing
  `bits.log`; under a throwaway `DSH_HOME` nothing outside it was written. This was verified by
  the ownership snapshot (real `~/.dsh` metadata unchanged) and by the absence of the run's
  profile/session under the real home.
- Worktree hygiene: `git status` shows only the expected 7 modified + 2 new files; no test
  artifacts, screenshots, logs or temp files were left in the repo; `git diff --check` clean.

## Findings

**0 BLOCKER, 0 MAJOR, 1 MINOR, 4 NIT. None blocks shipping.**

### F1. MINOR — the preset's standard child-list copy silently drifts on a DSH upgrade — `cordis.patch.yml:4-6`, `V5-CONTRACT.md:586-600`
`config.plugins` is a verbatim copy of the 22 children of the installed
`@deepseek-ai/dsh-web-app/presets/standard.patch.yml` for DSH **0.2.2-rc.1** (header pins the
version). That copy is currently exactly equal (verified with the app's own YAML loader), and
the 22 child names all exist in this installation. The risk is future-facing: when a DSH
upgrade changes the standard preset (adds/removes/renames child plugins, or changes a `!!js`
condition), the Bits Orchestrator mode keeps the old list. A *stale* list still boots and the
roster stays healthy, so no existing test catches it (the repo e2e only asserts the preset is
not `broken`); the mode would silently lag the standard chat. If an upgrade instead removes a
child package the preset references, that child row fails and DSH marks the preset `broken`,
which the e2e *would* catch. Repro: on a scratch copy of the repo, append a no-op child row to a
scratch copy of the installed `standard.patch.yml` and boot a throwaway profile with the
current bundle: the roster is unchanged and no test fails. Mitigation: keep the header's version
pin as the refresh trigger (already done) and consider a release-checklist item or an e2e
assertion that compares the preset row against the installed standard patch with the app's
loader; do not ship a stale copy blindly. **Does not block shipping** — the current copy is
verified correct for the installed app.

### F2. NIT — the README comparison table overstates "Team tools: None: only `bit_delegate`" — `README.md:171`, `host/team-runtime.js:966-970`
A `bits-orchestrator` session is correctly excluded from the team runtime, but the plugin's
pre-existing **global** `team_send` tool remains visible to it when the profile has any runnable
team: its visibility predicate is `if (!agent || resolve(agent)) return false; for (const team
of teamMap().values()) if (team.lead && team.workspaceDir) return true`, and
`resolve(presetAgent)` is `null`, so the predicate is satisfied exactly as for any other
non-team chat. That is consistent with "normal chat" behaviour and is not a team binding (no
team prompt/`team_delegate`), but the table row can be read as "only `bit_delegate` exists".
Suggested wording: the chat gets no team-mode tools (`team_delegate`/`team_handoff`); the
global `team_send` handoff stays available like in any non-team chat. No code change needed.

### F3. NIT — `V5-CONTRACT.md` §12.4 documents `isConcurrencySafe: true`, the code (and the DSH tool type) uses a function — `V5-CONTRACT.md:695`, `host/orchestrator.js:440`
The installed DSH tool contract is `isConcurrencySafe?(args: unknown): boolean`
(`@deepseek-ai/dsh-tools/lib/index.js:354`, and the installed `api-catalog` type text), and the
implementation — like `host/team-runtime.js:508` — uses `isConcurrencySafe: () => true`, which is
correct (`orchestrator.test.mjs` calls it as a function). The contract's `isConcurrencySafe:
true` is shorthand that a future implementer could copy literally; say
`isConcurrencySafe: () => true`. Behaviour is correct today.

### F4. NIT — new unit tests do not cover the error-containment path nor a few contract edges the docs promise — `test/orchestrator.test.mjs` (395 lines, 9 tests; `test/team-runtime.test.mjs:617`)
The suite covers the core contract well, but it does not cover: (a) the "`agent/created` never
throws" rule — no test injects a failing `systemPrompt.section`/`tools.register` (the failure
containment and `diagnostics().errors` path is exercised only by this reviewer's probe);
(b) the cwd fallback chain (`workingDirectory.get` throwing → header cwd → `process.cwd()`);
(c) cancellation forwarding/aborted-error passthrough; (d) the duplicated-name note and its cap;
(e) `presentCall`; (f) the team test has no positive control in the same test (a normal session
in the same directory resolving as lead) — the suite covers binding elsewhere, so the negative
assertion is not vacuous overall, but a same-test control would make it self-proving. Suggested
additive tests; none of these is a behaviour defect.

### F5. NIT — e2e section 10 has no "standard chat is not instrumented" control and no preset-order assertion — `test/e2e-web.mjs:810-902`
The new section verifies roster/health/default, `session/create`/`session/prompt` and the
`orchestrator.installed` entry, all correct. It does not assert that the preset's `order` is 5,
nor create a preset-less session to prove it is absent from `orchestrator.installed`; this
review's fresh-profile script covered both. Low risk (the unit suite and the roster assertions
cover the default), but a control session costs two extra lines and makes the section prove the
"other sessions untouched" claim end-to-end. No behaviour defect.

## Residual risks

- **DSH-upgrade drift of the preset child list** (F1): acceptable for the pinned
  `0.2.2-rc.1` installation; needs a refresh deliberately when the app's `standard` preset
  changes. The header comment names the origin and version, which is the right trigger.
- **Live-profile/recomposition timing:** the preset row is a *bundle patch* row, so it exists
  only after the profile is composed with the new bundle. The repo e2e and this review boot a
  fresh profile; in a running app the plugin-manager install either recomposes live (HMR) or
  reports that a restart is required. The README does not mention a possible restart; if the
  product wants to promise "install and it is immediately there", add that sentence/verify on a
  profile without HMR.
- **Duplicate preset declaration:** the bundle ships exactly one row; a *profile* that declares
  a second row with the same preset id is rejected by DSH (host still boots, first row wins —
  verified). Conversely, saving the preset from the Settings editor writes its definition by row
  id into the profile patch, which (per the recon report, not re-tested here) can override the
  shipped child list; users who edit the preset can therefore diverge from the standard chat
  layout. Not a defect, but do not promise in docs that UI edits keep the shipped child list.
- **Concurrent provisioning dedupe is per plugin instance** (`creating` map in
  `host/orchestrator.js:200`): two live instances during an HMR reload could each provision the
  same catalog character if a delegation runs exactly in that window. Very narrow; the single-
  instance path is deduped and verified under 6 concurrent calls.
- **No regression test for the "never selects the chat model/effort" invariant**: the guarantee
  holds by absence of selection calls (verified by source scan + runtime spy in this review).
  A future change could reintroduce a `model.select` in the orchestrator runtime without any
  repo test failing; the source-scan probe in `/tmp/orch-verify/adversarial.mjs` is the only
  thing that would catch it. Consider folding that grep into a repo test if the invariant is
  considered load-bearing.
- **Read-only default is a policy, not a sandbox for DSH-route workers:** `read_only: true` is
  forwarded to the worker runtime, and the subscription backend maps it to plan mode
  (`bit-runtime.js` + claude-delegate), but a DSH chat-route worker still runs one model call
  with no tools; if a future DSH worker backend gains tools, the default must be re-checked.
  Existing v5 behaviour, unchanged by this increment.

---

## Lead addendum (post-review hardening, Bits Orchestrator chat preset)

The Lead applied the cheap, non-behavioural items from the review above after the sign-off:

- **F1 (fixed)** — `test/e2e-web.mjs` section 10 now parses the repo bundle patch and the
  installed `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` with the app's own
  `loadOverlayPatches` and `assert.deepEqual`s the preset `config.plugins` (22 children,
  3 `!!js` expression nodes), so a DSH upgrade that changes the standard preset fails the
  suite instead of silently drifting; the `bots` row id/name/config and the preset row
  id/plugin/order 5 are pinned in the same guard.
- **F2 (fixed in `README.md`)** — the comparison table now says the chat gets no
  `team_delegate`/`team_handoff` while the global `team_send` stays visible as in any
  non-team chat; the section also states that an install/update appears when the profile
  recomposes (HMR) or after an app restart.
- **F3 (fixed in `V5-CONTRACT.md`)** — §12.4 says `isConcurrencySafe: () => true` (a function,
  as the installed DSH tool contract requires).
- **F4 (fixed in the tests)** — `test/orchestrator.test.mjs` is now 13 tests: the awaited
  `agent/created` hook cannot throw (section/tool/header failures land in `errors`, partial
  installs stay listed), the cwd fallback chain, cancellation/error pass-through, duplicate
  name notes and their cap, and `presentCall`. The team-runtime preset test gained its
  positive control (a normal session in the same `bindWorkspace` directory resolves as lead).
- **F5 (fixed)** — e2e section 10 asserts the preset `order` and, as a control, creates a
  preset-less session that must not appear in `orchestrator.installed`.

Final verification after the addendum (Lead): all 9 suites → **214 tests passed** (store 33,
catalog 16, routes 36, teams 46, projects 31, harness 9, bit-runtime 13, team-runtime 17,
orchestrator 13), `node --check` on every changed JS file, and `node test/e2e-web.mjs` →
**E2E PASS 10/10, exit 0** (drift guard, preset session and standard control green). Nothing
committed or pushed. The live desktop profile was recomposed with the final bundle
(`include:bots` toggle, then the profile patch restored to its original bytes); the live
composition now lists the `preset-bits-orchestrator` row and the profile patch hash is back to
its pre-change value.

---

## Lead addendum — Bit mode increment (v5.2)

User request (after v5.1 shipped): rename the chat mode **Bits Orchestrator** → **Bit mode**, and,
while that mode is the chosen preset of a new session, add a selector beside the mode chip to pick
**which bit orchestrates** the chat, showing each candidate's image, name and short English
description.

### What changed

| Area | Change |
|---|---|
| `cordis.patch.yml` | preset display name `Bit mode` (id stays `bits-orchestrator`; description unchanged) |
| `host/orchestrator-selection.js` (new) | durable global preference `<botsRoot>/orchestrator.json` (`{version:1,bitId}`, atomic 0600); candidates = existing orchestrator bits + catalog orchestrator characters without a bit (worker characters excluded, cap 50); selecting a catalog character provisions the bit through `bits.create` with catalog defaults; worker targets refused `BIT_NOT_ORCHESTRATOR`, unknown `BIT_UNKNOWN`; `select(null)` clears |
| `host/orchestrator.js` | prompt heading renamed; section text is now a per-turn function `buildPromptText(catalog, selection.currentBit())`; with a bit it inserts `## Orchestrating bit: <name>` + catalog summary + the bit's instructions after the intro; generic text unchanged; model/effort still never touched |
| `host/routes.js` | one exact route `/api/bots.orchestrator` with `GET` (read) and `POST { target }` (select/clear), registered only when `deps.selection` exists; returns `{ bitId, bit, candidates }` |
| `index.js` | builds/init/disposes the selection store, passes it to the runtime and routes, reports `orchestrator.selection.bitId` in `/api/bots.diagnostics` |
| `client.js` | `ModeBitSeat` registered in `conversation.hero.options` (list slot next to the single `conversation.hero.agentPreset`); renders only when the blank session's `projectionValues.agentPreset === 'bits-orchestrator'`; chip with mascot/bit avatar + name; menu rows with 32px avatar, name, 2-line summary; generic "No specific bit" first (`target:null`); loading/error/busy states, Escape/outside-click close; own `<style>` (theme-token fallbacks) plus the placement rule `div:has(> [data-slot="conversation.hero.options"]){margin-left:0}` so the chip sits immediately after the mode chip; 404/absent route → chip renders nothing |
| docs | README "Chats in Bit mode" + selector paragraph; V5-CONTRACT §12 renamed and §13 (v5.2) added |

### Verification (Lead)

- `node --check` on every changed JS file → OK.
- All **10 unit suites → 232 tests passed** (store 33, catalog 16, routes 36, teams 46, projects 31,
  harness 9, bit-runtime 13, team-runtime 17, orchestrator 17, orchestrator-selection 14).
- `node test/e2e-web.mjs` → **E2E PASS 11/11, exit 0**: preset roster names `bits-orchestrator`
  `Bit mode` (healthy, not default, order 5); the drift guard still deep-equals the installed
  `standard.patch.yml` children; the new section reads the fresh selection (`bitId:null`,
  candidates include all four orchestrator roles), selects the catalog Manager (provisions the bit
  with catalog model/effort/instructions, persists, diagnostics reports it), refuses a worker bit
  (`BIT_NOT_ORCHESTRATOR`) and an unknown target (`BIT_UNKNOWN`), and clears the selection.
- `node test/visual.mjs --theme dark` and `--theme light` → **VISUAL DONE, exit 0** each: preset
  menu offers "Bit mode"; the new chip renders right after the mode chip (geometry:
  preset right 741.56 → chip left 743.56, same centre line, inside the hero row); the menu lists
  the generic row + App PO + Manager + Coordinator + Sub-coordinator, every candidate with a loaded
  256px avatar and a non-empty description; picking Coordinator provisions the bit and the chip
  shows its avatar + name; the Bits page scenario still passes.
  Screenshots: `test/screenshots/dark-bit-1-mode.png`, `dark-bit-2-menu.png`,
  `dark-bit-3-selected.png` (+ light equivalents); `dark-1..7` regenerated (the pick provisions one
  more bit) and light counterparts added.
- Live desktop profile: the previously appended `preset-bits-orchestrator` override row in
  `~/.dsh/profiles/desktop/cordis.patch.yml` had its display name updated to `Bit mode` (backup:
  `cordis.patch.yml.bak-bitmode-20261110-182740`). The profile-patch config watch recomposed the
  profile; `~/.dsh/bots/bits.log` recorded `plugin loaded` immediately after (2026-11-10T21:27:42Z)
  with no route/runtime errors, so the new host half (selection store, routes, dynamic prompt) is
  live. The browser half is served from the linked package; an open page picks the new bundle up on
  the client HMR graph sync, otherwise a window reload shows the chip.

### Residual risks

- **Global, not per-session, selection:** one preference drives every Bit-mode chat (the chip only
  exists on the new-session hero, where the mode itself is chosen). Changing it while another
  Bit-mode chat is mid-conversation changes that chat's persona on its next turn; there is no
  per-session binding by design (the session header has no room for one).
- **Hero placement depends on DSH's slot DOM:** the chip is only in `conversation.hero.options` and
  the after-the-mode-chip placement relies on the child slot wrapper
  `[data-slot="conversation.hero.options"]` and the `:has()` rule. A DSH upgrade that renames the
  slot or removes the wrapper needs a small follow-up; the chip simply loses its position (the
  preset chip and the Bits page keep working).
- **Preset projection dependency:** the chip's visibility reads
  `ctx.sessions.list` summaries' `projectionValues.agentPreset`; if a future DSH stops projecting
  the preset id, the chip disappears (no breakage of the rest of the page).
- **Persona vs. mode rules:** the selected bit's instructions can ask for behaviour (e.g. team
  delegation) that Bit mode does not provide; the mode prompt's invariant sections (bit_delegate,
  worker roster, model/effort untouched) remain authoritative and follow the bit block.
- **Live override row:** the desktop profile contains a shadow row for the preset id (from v5.1) so
  the mode is available without a restart. It duplicates the preset's child plugin list; a DSH
  upgrade should refresh or drop it, exactly as its own comment says.
- **Legacy evidence:** bits created by the selector are normal records and appear on the Bits page;
  nothing marks them as "chosen by Bit mode" beyond the `orchestrator.json` preference.
---

## Independent review — follow-up fixes (v5.3) — 2026-11-11

Independent verifier (fresh eyes, adversarial), task `task-4` on the team board. The repo was
read-only for this review except this section; nothing was committed. Every host/Chrome instance
this review started used a throwaway `DSH_HOME` under `/tmp` (the real `~/.dsh` and the running
desktop app on `127.0.0.1:42733` were never touched); all spawned processes were killed, no
listener was left behind, and no scratch file was written inside the repo. The two visual runs
regenerated `test/screenshots/*.png` **byte-identically** (sha256 of all 45 screenshots before and
after are equal), so the screenshots on disk match this code. The verified worktree stayed
byte-identical for the whole review (`git diff` sha256
`8c90628aad0e932cb6a8cd5cbbaa86045b1624db981419a3686e10dff47f0d96` at start and end), so nothing
below is stale; `git status` is the expected 34 modified + the 2 new catalog screenshots.

**Verdict: SHIP — 0 BLOCKER, 0 MAJOR, 1 MINOR, 4 NIT.** Both user-reported problems are fixed end
to end on the real host, including the cold-restart case the Lead asked for; the MINOR (F1) is a
team-workspace interaction of the host fix that leaves stale team state on a chat switched to Bit
mode after creation — it does not block the reported flows.

### Where the two user problems stand

1. **"Selecting Bit mode on an existing blank chat used no bits" — fixed, proven on the real
   host.** `test/e2e-web.mjs` section 12 and this review's own cold-restart probe show the whole
   path: a blank session whose frozen header says `standard` is switched through
   `agentPresets/select` to `bits-orchestrator`; the runtime installs the prompt section and
   `bit_delegate` (persisted turn-1 `request/header` lists `bit_delegate`); switching back to
   `standard` removes them. The cold case also works: after killing the host and booting a fresh
   one on the same `DSH_HOME`, the stored projection already reads `bits-orchestrator` before any
   Agent is live, and prompting the session resumes it with the runtime installed. The
   effective-preset read, not the header, is what drives detection (the persisted header stayed
   `standard` in every probe).
2. **"The Bits page must show all 52 catalog bits" — fixed, proven in the real DOM.** A fresh
   throwaway profile with **zero** created bits renders no "No bits yet" empty state and an
   **All bits** grid with exactly 52 catalog cards in catalog order (avatar, name,
   Orchestrator/Worker badge, group, summary, `model · effort`, `New bit`). Name-only duplicates
   are suppressed: a bit created without a character but named "Scout" reduces the grid to 51 and
   hides the catalog Scout while the created card keeps its normal Run/Edit/Delete bit actions.
   With created bits present the existing `.dsh-bots-card` list is unchanged and the catalog
   section sits below it (48 / 46 cards in the visual run). Clicking a catalog card's `New bit`
   opens the create form prefilled from that character on the form step (not the gallery), and a
   create from it persists the catalog model/effort (visual run: Architect → `subscription/fable`
   · `high`).

### Commands run by this review (all executed here)

| Command | Result |
|---|---|
| `node test/store.test.mjs` | **PASS** — `store: 33 tests passed` |
| `node test/catalog.test.mjs` | **PASS** — `catalog: 17 tests passed` (new "workers never delegate" test included) |
| `node test/routes.test.mjs` | **PASS** — `routes: 36 tests passed` |
| `node test/teams.test.mjs` | **PASS** — `teams: 46 tests passed` |
| `node test/projects.test.mjs` | **PASS** — `projects: 31 tests passed` |
| `node test/harness.test.mjs` | **PASS** — `harness: 9 tests passed` |
| `node test/bit-runtime.test.mjs` | **PASS** — `bit-runtime: 13 tests passed` |
| `node test/team-runtime.test.mjs` | **PASS** — `team-runtime: 18 tests passed` |
| `node test/orchestrator.test.mjs` | **PASS** — `orchestrator: 21 tests passed` |
| `node test/orchestrator-selection.test.mjs` | **PASS** — `orchestrator-selection: 14 tests passed` |
| **unit suites total** | **238 tests passed** across 10 suites, exit 0 each |
| `node test/e2e-web.mjs` | **PASS** — `E2E PASS`, exit 0, **12/12 sections**; section 10 roster + drift guard + preset/control greens; section 12 printed the picked blank session instrumented and cleaned up; its cleanup removed the throwaway home |
| `node test/visual.mjs --theme dark` | **PASS** — `VISUAL DONE`, exit 0; catalog 52-tile picker, 48-card "All bits" grid, prefilled create from a card, fable/effort assertions, screenshots saved |
| `node test/visual.mjs --theme light` | **PASS** — `VISUAL DONE`, exit 0 (same assertions) |
| `node --check` on `client.js` + `index.js` + 8 changed `host/*.js` + 9 changed `test/*.mjs` | **PASS** — all parse |
| `git diff --check`; JSON parse of `bits/catalog.json` + `package.json` | **PASS** — no whitespace errors; 52 bits, 7 groups, 4 orchestrators |
| sha256 of `test/screenshots/*.png` before → after both visual runs | **PASS** — all 45 files identical (regenerated outputs match the tree; no stale screenshots) |
| `/tmp/fix-verify/host-probes.mjs` (own fake-host adversarial probe) | **PASS — 18/18** |
| `/tmp/fix-verify/bits-page-probe.mjs` (own catalog/DOM-source probe) | **PASS — 11/11** |
| `/tmp/fix-verify/visual-zero-catalog.mjs` (own headless-Chrome DOM probe, zero created bits) | **PASS** — 52 cards, no empty state, name dedupe → 51, created card unchanged, prefilled form step |
| `/tmp/fix-verify/cold-restart.mjs` (own two-boot real-host probe) | **PASS** — first-turn `request/header` contains `bit_delegate`; after restart the fresh host resumes the session and instruments it |
| `/tmp/fix-verify/team-effective-preset.mjs` (own real-host team probe) | **PASS with finding F1** — normal chat in the bindWorkspace dir is the lead; the picked Bit mode chat is instrumented AND still listed as a team lead (evidence `/tmp/fix-verify/team-effective-preset.json`) |
| leftover processes/listeners/temp homes after the review | **PASS** — none from this review; only the pre-existing desktop app (`127.0.0.1:42733`) and the user's own Chrome processes remain |

### Independent adversarial probe coverage (written under `/tmp/fix-verify`, not in the repo)

- **Effective-preset helper:** projection wins over the frozen header (both directions); absent
  registry and throwing projection fall back to the header; non-string/blank/malformed agents are
  inert.
- **Install lifecycle (fake host):** standard session not instrumented; header-preset session
  instrumented exactly once; duplicate `agent/created` and duplicate `agent-preset/selected`
  events do not double-register; switch away uninstalls only that agent; `agent/disposed`,
  `runtime.dispose()` and post-dispose events clean up; **plugin reinstall (dispose + new install
  with the same live agents) re-instruments without duplicate-registration errors** (since
  agent-scoped registrations outlive the registering plugin, the disposers are load-bearing);
  partial install (failing tool) keeps the section and reports the error; hooks never throw out of
  the plugin; `ctx.get`/`ctx.inject` throwing are contained.
- **Registry timing:** the `agentPresets`-ready `ctx.inject` sweep installs a live agent whose
  recorded selection predates the plugin load; an event for an unknown session is inert;
  trimmed-exact-id only (`Bits-Orchestrator` and `bits-orchestrator-2` are not accepted).
- **Real host, picked after creation:** created blank (`standard`) → selected
  `bits-orchestrator` → diagnostics `orchestrator.installed = [{sessionId, tools:
  ["bit_delegate"]}]`; switched back → removed (repo e2e section 12, and this review's cold
  probe for the post-restart variant).
- **Real host, cold restart:** host A creates a blank session, selects the preset, prompts (the
  second `agentPresets/select` then fails `agent-preset/locked` — the turn really started), the
  persisted log keeps `header.agentPreset: "standard"` + `agent-preset/selected`, and turn 1's
  `request/header` lists `bit_delegate`; killing the host and booting a fresh process on the same
  home makes `session/projections` read `agentPreset: "bits-orchestrator"` before any Agent is
  live, and the resumed session is instrumented again.
- **Read-only / model-effort invariant:** the changed runtime contains no `model.select`,
  `setModel`, model/effort/session-header writes; the only `agent.model.select` in the plugin is
  the pre-existing `startMission` lead-route selection (`host/team-runtime.js:822`), which a Bit
  mode session never reaches because `resolve()` returns `null` first.
- **Bits page:** `availableCatalogBits` extracted from the shipped `client.js` and run against the
  real 52-character catalog (catalog order, character-id dedupe, case-insensitive trimmed
  name dedupe, duplicates/blank names, all-taken → 0, first-sentence summary); source checks that
  catalog cards use `dsh-bots-catalog-card`/`data-catalog-character` (not `.dsh-bots-card`), carry
  only a `New bit` action, and that the created list/empty-state/catalog-section render
  conditions match the docs.

### App-semantics spot checks (installed DSH 0.2.2-rc.1, not the research report)

- `AgentPresetRegistry.select` recomposes the Agent context first
  (`recompose(agent.ctx, preset)`), then appends `agent-preset/selected`
  (`dsh-agent-preset-registry/lib/index.js:766-786`); `recompose`/`bind` only re-point the scope
  parent, so the Agent and `agent.ctx` identities survive.
- The registry re-emits the committed session event on the shared host bus as
  `agent-preset/selected(session.id, preset)` (`…preset-registry/lib/index.js:463-468`), and the
  `agentPreset` projection is initialized from the creation header and advanced by that event
  (`…preset-registry/lib/types/session.js:30-36`), so a cold session's stored projection is the
  recorded selection.
- `agent.id === agent.session.id` is enforced when an Agent is entered
  (`dsh-agent/lib/index.js:659-663`), and `agents.list()` returns live Agents only
  (`dsh-agent/lib/index.js:743-745`), which is what the event handler's session-id lookup relies on.
- A cold session is resumed with the preset read from the observed projection
  (`dsh-api-session-controller/lib/index.js:283-317`, `presetForObservation` at 459-462), i.e. the
  same effective-preset semantics the fix uses; `session/prompt` on an existing session goes
  through that resume path.
- `ctx.inject(deps, callback)` is `ctx.plugin({inject, apply})` (`cordis/lib/index.js:1672-1683`):
  the callback runs when the dependencies are available, and `ctx.on` returns a disposer used by
  `dispose()` (`cordis/lib/index.js:951-965`), so the ready-sweep and hook teardown are sound.

### Findings

**0 BLOCKER, 0 MAJOR, 1 MINOR, 4 NIT.**

#### F1. MINOR — a chat switched to Bit mode after creation in a `bindWorkspace` team directory keeps the team runtime's lead installation — `host/team-runtime.js:694-731,1157-1168`, `README.md:215,220`, `V5-CONTRACT.md:730-731`

The v5.3 change makes `resolve()` read the effective preset (`host/team-runtime.js:257-263`), so
the team runtime *refuses to resolve* the chat as a lead. But the team runtime installs its prompt
section (`bits:team`), `team_delegate`/`team_handoff` tool registrations and the role's
`tools.restrict` deny mask on `agent/created` — i.e. **before** the user picks the preset — and it
has no `agent-preset/selected` listener to uninstall/reinstall. Agent-scoped registrations live
until their disposers run, so after the pick the chat keeps the old team registrations while the
orchestrator runtime also installs `bit_delegate`. Real-host repro (this review's
`/tmp/fix-verify/team-effective-preset.mjs`, throwaway profile):

1. create an orchestrator lead bit + worker bit and a team with `bindWorkspace: true` over a
   scratch workspace;
2. `session/create { request: { cwd: <workspace>/nested } }` → recorded `standard`; the team
   runtime installs it as `role: "lead"` (this is the documented normal-chat behaviour);
3. `agentPresets/select { agentId, agentPreset: "bits-orchestrator" }`;
4. `GET /api/bots.diagnostics` now shows the session in **both** `orchestrator.installed` (with
   `bit_delegate`, correct) **and** `agents` as `{ role: "lead", teamId, bitId }` — the team entry
   was never removed. The positive control in the same run still lists the normal chat as lead.

Impact: the chat works in Bit mode, but it also keeps the stale `team_delegate`/`team_handoff`
tools (calling them throws `TEAM_DELEGATE_INVALID` / “team_handoff is only for the lead”), the team
section (its per-turn text now resolves to an empty string) and the role's tool-restriction mask,
and diagnostics/the team surface still report it as a team lead. That contradicts
`README.md:215` (“No `team_delegate`/`team_handoff`”) and `README.md:220` / `V5-CONTRACT.md:730-731`
(“never a team lead … gets no team prompt and no `team_delegate`/`team_handoff`”) for this one
path. It does not block either reported user problem (the Bit mode side is correct) and it needs a
team-managed repository plus a post-creation pick. Suggested fix (Lead owns it): listen to
`agent-preset/selected` in `host/team-runtime.js` and `uninstall()` (or `reinstall()`) the affected
live Agent, mirroring the orchestrator hook; a repo unit test plus the diagnostic assertion from
this probe would lock it.

#### F2. NIT — e2e section counter still prints “2/11” in a 12-section run — `test/e2e-web.mjs:409`

Every other label was updated to `/12`; the boot line still says
`2/11 boot isolated web host on port …`. Cosmetic output only (`E2E PASS` and the 12 sections are
correct).

#### F3. NIT — V5 contract table names the host event `agent-presets/selected` — `V5-CONTRACT.md:958`

The actual event (and every other mention in the docs/code) is `agent-preset/selected`
(`host/orchestrator.js:726`); the §14.3 table row has a stray hyphen. Docs typo only.

#### F4. NIT — two `BIT_DELEGATE_UNAVAILABLE` messages do not mention updating the delegate plugin for `fable` — `host/bit-runtime.js:156,165` vs `:144`, `README.md:251-255`

The missing-tool message and the README now say install **and update** the
`@dsh-burn-plugins/dsh-claude-delegate` plugin (needed for `subscription/fable`, which rejects on
older builds), but the two tool-failure messages still say only “Install/enable the … plugin”. A
user with an outdated delegate that rejects the `fable` alias therefore gets no update hint in the
error path that would actually fire. Message-only; no behaviour defect.

#### F5. NIT — V5 §14.2 wording about the empty state is narrower than the code — `V5-CONTRACT.md:944-952` vs `client.js:6976-6980,7046`

The contract says “the old empty state stays only for a host whose catalog is unavailable”; the
code keeps it when `bits.length === 0` **and** the catalog has no characters (including a
successfully loaded empty catalog: `const catalogSection = (catalog.phase === 'ready' &&
!catalogHasBits) ? null : …`). The shipped catalog always has 52 characters, so this is
theoretical; the behaviour (all bits visible when the catalog has characters; empty state only
without them) is the one the task asked for and is what the zero-bit DOM probe observed. Docs
wording only.

### Docs and scope

- README “Chats in Bit mode” paragraph, the “How to use” Bits-page paragraph and §14 of
  `V5-CONTRACT.md` match the observed behaviour: a preset picked on a still-blank existing chat
  runs in Bit mode from its first message and switching back before it starts removes the runtime
  (real host); the Bits page lists created bits followed by **All bits**, including with zero
  created bits, and the empty state is gone while catalog characters exist (real DOM); `New bit`
  opens the prefilled form step (real DOM + visual suite); the 52-character catalog and the
  `model · effort` defaults shown on the cards match `bits/catalog.json`.
- The working tree also carries a catalog/Fable-5.2 rebalance (`bits/catalog.json`,
  `host/models.js`, `host/store.js`, `host/harness.js`, `host/bit-runtime.js`,
  `host/team-prompt.js` and their tests) that the task brief did not name. It is documented
  (README “Model and effort presets”, V5 §1/§4) and covered by the updated suites; this review
  cross-checked every README/V5 model/effort claim against the catalog (23 exact id/model/effort
  spot checks all match; the README's "LLM evals" is the `bit-llm-expert` at Opus/high), the catalog instructions reference only known bits, and 0.2.2-rc.1's catalog/model
  routes accept the values. It reads as part of the same release, not stray scope creep — no
  defect found in it; the Lead should just confirm it is intended to ship with v5.3.
- Added lines contain no accented Latin text and no Portuguese words (only typographic characters
  `— · ≥ ∈ … →`); the changed code/prompt strings are English.
- `git diff --check` is clean, added files are only the two catalog screenshots, and the visual
  runs regenerate every screenshot byte-identically.

### Residual risks

- **F1's team-workspace interaction** is the one real gap; Bit mode itself is unaffected, but a
  team-repo user who switches an existing blank chat to Bit mode will see stale team tools and a
  “lead” row in diagnostics until the team runtime learns to uninstall on preset changes.
- **Cold restart was proven through the `session/prompt` resume path** (the same
  `ApiSessionAgentController.resolve()` → `agents.resume` path the UI uses to open a cold
  session), not through a literal browser click; the plugin side is covered, but a UI-open-path
  check over the remote bridge alone was not possible.
- **No real model route/credential in the throwaway profile:** the turn recorded its
  `request/header` (which lists `bit_delegate`) and then ended on the missing provider, so the
  exact model completion was not exercised; subscription/`fable` and `claude` behaviour remain
  untested end to end here (the sibling delegate repo at 0.2.0 documents `fable` and the same
  Claude Code ≥ 2.1.321 gate, and the unit tests accept the alias).
- **Projection fallback is best-effort:** if `agentPresets.presetForSession` throws, detection
  falls back to the frozen header, which cannot see a recorded selection (documented; a broken
  registry is not expected in a healthy profile).
- **Global orchestrating-bit selection is unchanged** from v5.2 (one preference for every Bit
  mode chat); it was not re-reviewed here.
- The **`fable` cost/plan caveat** in the README is an external product claim (usage credits,
  model lineup) that cannot be verified from this machine.

### Hygiene

Only this section was written to the repo. All probe scripts/evidence live outside it under
`/tmp/fix-verify/` (`host-probes.mjs` 18/18, `bits-page-probe.mjs` 11/11,
`visual-zero-catalog.mjs`, `cold-restart.mjs`, `team-effective-preset.mjs` +
`team-effective-preset.json`, `worktree-start/end.diff`). Every host/Chrome process this review
started was stopped, every throwaway home was removed, and the real `~/.dsh`/desktop app were
never touched. No fix was applied by this verifier: F1 is reported for the Lead to decide/fix.
---

### Follow-up (v5.3.1) — re-verification of the F1/NIT fixes — 2026-11-11

Re-check requested by the Lead after the fixes below; task-4 was reopened, worked and completed
again. Read-only except this note; no commit. Only five files changed since the v5.3 review above
(`host/team-runtime.js`, `test/team-runtime.test.mjs`, `test/e2e-web.mjs`,
`host/bit-runtime.js`, `V5-CONTRACT.md`); `client.js`, `host/orchestrator.js`, README and the
screenshots are untouched since that review, so the Bits-page and orchestrator evidence above
still stands. The worktree was byte-identical for this whole re-check (`git diff` sha256
`0f831fd92898abe98e193a9cc3c34a7c7ba6e20c63d05c2faf6e43b1e297c886`), all hosts were throwaway
`DSH_HOME`s, and every spawned process was killed (no leftover listeners/temp homes; real `~/.dsh`
and the desktop app untouched).

**Verdict: SHIP — 0 BLOCKER, 0 MAJOR, 0 MINOR, 0 NIT.** All four NITs are fixed and the F1 MINOR
is fixed and verified in both directions on a real host; no new defect found.

#### F1 fix verified — team install follows the committed preset (`host/team-runtime.js:1189-1208`)

The new `agent-preset/selected` hook (with `liveAgentOf`/`agentPresetsService` helpers) uninstalls
the team install on a committed Bit mode preset and re-applies it on a committed normal preset
when the Agent is not installed. Evidence:

- **Own real-host probe, both directions on one live still-blank chat** (extended
  `/tmp/fix-verify/team-effective-preset.mjs`; output `team-effective-preset.json`): create a
  `bindWorkspace` team, create a blank session in its directory (installed as team lead), then
  `agentPresets/select bits-orchestrator` → session is under `orchestrator.installed` with
  `bit_delegate` and **absent from `agents`**, `errors: []`; select back to `standard` → team lead
  entry back (`role: "lead"`) and `orchestrator.installed` no longer lists it; re-pick Bit mode →
  team entry gone again and `bit_delegate` back. The normal-chat lead positive control stayed
  installed throughout; a chat outside the team directory switched to another normal preset
  (`cordis`) never got team state and reported no errors; the real `~/.dsh` was untouched.
- **Own fake-host hook probe** (`/tmp/fix-verify/team-hook-probes.mjs`, 9/9 checks; derived from
  the repo test's fake host): lead install at `agent/created`; Bit mode commit removes prompt
  section, `team_delegate`, restrict mask and the diagnostics entry; duplicate Bit-mode events are
  inert; a committed normal preset re-installs; duplicate switch-back events do not
  double-install (install log count unchanged); blank/non-string preset ids fall back to the
  effective projection in both directions; events for a non-team chat install nothing; unknown
  sessions are inert; **the async install-rejection path is caught** (forced a rejection inside
  `installGitHooks` after partial registration → handler logs `team install after preset change
  failed for …`, no unhandled rejection); **teardown disposes the hook** (registered-listener
  count returns to 0, later events inert) and removes the install.
- **Repo suites:** `test/team-runtime.test.mjs` **18/18** (the extended
  "a blank session switched to the Bit mode preset…" test now asserts lead install → Bit mode
  pick removes section/tools/restrict/diagnostics → switch back reinstalls); `test/e2e-web.mjs`
  → **E2E PASS, 12/12 sections**, exit 0, throwaway home removed; all other unit suites unchanged
  and green (238 tests total: store 33, catalog 17, routes 36, teams 46, projects 31, harness 9,
  bit-runtime 13, team-runtime 18, orchestrator 21, orchestrator-selection 14).
- Docs: V5 §14.1 now describes the mirrored team-runtime fix, §14.3 lists the new hook, and the
  observed behaviour matches both.

#### NITs re-checked

| Finding | State | Evidence |
|---|---|---|
| F2 e2e `2/11` counter | **fixed** | `test/e2e-web.mjs:409` prints `2/12`; full run prints 12 sections |
| F3 V5 `agent-presets/selected` typo | **fixed** | no `agent-presets/selected` left; V5-CONTRACT.md:966/967 use `agent-preset/selected` |
| F4 delegate-unavailable messages lack the update hint | **fixed** | `host/bit-runtime.js:156,165` now say “Install/enable (and update) …” like :144 |
| F5 V5 §14.2 empty-state wording | **fixed** | V5-CONTRACT.md:958 now says the empty state stays “when the catalog itself has no characters (or is unavailable)”, matching `client.js:6976-6980,7046` |

`node --check` on `host/team-runtime.js`, `host/bit-runtime.js`, `test/team-runtime.test.mjs`,
`test/e2e-web.mjs` → OK; `git diff --check` clean; added lines of this fix contain no accented
Latin text or Portuguese (only typographic `∈ ≥ — · →` in the docs).

#### Residual risks (unchanged by the fix)

- The cold-restart and preset flows are proven through the remote `session/prompt` resume path
  (the same `ApiSessionAgentController.resolve → agents.resume` path the UI uses), not a literal
  browser click; no real model completion was exercised (the throwaway profile has no LLM route),
  so the `fable`/subscription alias end to end remains untested here.
- The team hook was exercised on the real host for install/uninstall/re-install; the MCP remount
  branch and the plugin-teardown path were exercised in the fake host only (the real host has no
  MCP-equipped team in the throwaway profile) — the code path is the same `install`/`uninstall`
  pair verified on the real host.
- An async install rejection after partial registration leaves the partial install in place (the
  hook reports it in diagnostics instead of crashing); only reachable through a defect in a
  package/mount step, and it is contained.
---

### Follow-up (v5.3.2) — bit picker in an already-open conversation — 2026-11-11

Re-check requested for the client-only increment that shows/switches the orchestrating bit in an
**already-open** Bit mode conversation (second seat in `conversation.session.header.actions`,
compact variant, `document.body` portal for the menu), after the Lead addressed one defect and the
NITs this review found in the interim pass. Read-only except this note; no commit. Besides this section and the regenerated screenshots, only
`client.js`, `test/visual.mjs`, `README.md` and `V5-CONTRACT.md` changed since the v5.3.1 re-check
(host code, unit suites and the e2e are untouched); the code+docs worktree stayed byte-identical
for this whole final pass (`git diff` without screenshots/REVIEW sha256
`c6cdb6ae6d0482828d0469354533e84dc37817e5f984eb8810665af2ce287420`), so nothing below is stale.
All hosts were throwaway `DSH_HOME`s; no listener/temp home was left and the real `~/.dsh` /
desktop app were never touched.

**Verdict: SHIP — 0 BLOCKER, 0 MAJOR, 0 MINOR, 1 NIT (stale comment/doc wording only).** The
interim **F1 defect (portaled header menu rendered unstyled) is fixed and verified**, the two
alignment/docs NITs are fixed, and no new defect was found.

#### F1 (interim, fixed) — portaled header menu lost its theme tokens

Before the fix the header menu was portaled to `document.body` while the `--dsh-mode-*` variables
were declared only on `.dsh-bots-mode-root`; the live computed style was `background:
rgba(0,0,0,0)`, `borderTopStyle: none`, `boxShadow: none`, `borderRadius: 0px`, selected-row
background transparent (token value on the seat root was `#303136a3`, on the menu `''`), so the
dropdown had no panel surface in either theme — visible in `dark-bit-5-header-menu.png` as rows
painted straight over the chat. The fix declares the token block on `.dsh-bots-mode-root,
.dsh-bots-mode-menu` (root layout properties stay on the root rule). Re-checked on the final tree
with the same Chrome probe: the portaled header menu now computes `background:
rgba(48,49,54,0.64)`, `border: 1px solid rgba(255,255,255,0.12)`, non-empty `boxShadow`,
`borderRadius: 16px`, selected row `rgba(255,255,255,0.14)` — identical token values to the hero
menu. Pixel check of the regenerated screenshots: panel fill is distinct from the page background
in dark and light; the menu is opaque, bordered, rounded and highlighted in both themes
(`test/screenshots/{dark,light}-bit-5-header-menu.png`). `test/visual.mjs` now pins this: it
asserts the portaled menu's computed background is not transparent, `borderTopStyle === 'solid'`,
non-zero radius, `boxShadow !== 'none'` and a non-transparent selected-row background.

#### Functional evidence (final tree)

- **Repo visual suite, both themes: PASS** (`node test/visual.mjs --theme dark` and
  `--theme light`, exit 0, `VISUAL DONE`). Full flow: hero chip/geometry/avatar/menu unchanged;
  pick Coordinator; a real `session/prompt` through the authenticated bridge; hero seat unmounts;
  compact header seat appears bound to the same session (`phase=ready`, 22px chip, avatar loaded,
  header still shows "Bit mode"); header menu opens with 5 rows and the "Orchestrating bit" label,
  fixed position, viewport containment, style assertions above; **narrow (480×900) pass** reopens
  the menu, asserts it stays inside the viewport and that the alignment matches the component's
  free-space rule (both wide and narrow layouts left-align/left-clamp in this run); clearing →
  `/api/bots.orchestrator` `bitId: null`, restoring → the previous bit; screenshots
  `bit-4-in-chat.png` / `bit-5-header-menu.png`; the Bits-page catalog assertions
  (48/46 cards, prefilled create, created cards) still pass in the same run.
- **Own headless-Chrome probe** (`/tmp/fix-verify/visual-v532-probe.mjs`, final tree): hero seat
  unchanged (hero variant, 28px, adjacent to the preset chip, 5-row in-place menu, avatar loaded);
  header seat on the same session, compact 22px; menu is a real `document.body` portal
  (`parentElement === body`, not inside the clipping header slot), `position: fixed`, fully
  unclipped (hit-testing at the menu centre, last row and bottom edge returns the menu); at a
  480px viewport it left-clamps to `left: 132px` and stays fully on screen; clear → restore
  persists; outside mousedown closes the menu; after navigating away **no portal node and no
  header seat remain**; a standard-mode conversation started through the UI composer shows **no
  chip/seat** (and the standard-mode hero shows none either).
- **Portal fallback**: `require('react-dom')` is wrapped in try/catch at the factory, every portal
  use is guarded by `typeof createPortal === 'function' && typeof document !== 'undefined'`, and
  the in-place `menuNode` is the fallback, so a host without the shared module cannot break the
  bundle (the menu may be clipped there — documented). On this 0.2.2-rc.1 host `react-dom` is a
  platform seed word and the portal was live in every run.
- **Outside-click handler**: clicks inside the portaled menu are treated as inside
  (`menu.contains(target)`), Escape/outside mousedown close it, and the document listeners are
  removed in the effect cleanup (verified live; no leftovers after unmount).
- **Docs**: README "In a conversation that is already open…" matches the observed behaviour; V5
  §13.4/§15 now describe the chip position after the title/preset label (not a fixed right edge),
  the right-align-or-left-clamp rule, the token-on-menu requirement and the portal rationale; the
  global-selection caveat is unchanged and accurate.

#### Findings

**0 BLOCKER, 0 MAJOR, 0 MINOR, 1 NIT.**

- **NIT — two stale "right edge / right alignment" leftovers contradict the corrected behaviour.**
  `test/visual.mjs:535-536` still comments "(the header sits at the right edge, so the menu
  right-aligns)" while the run actually left-aligns (the chip follows the session title and the
  preset label; the assertion itself now correctly uses the free-space rule). The V5 §15 "Tests and
  files" sentence still says the assertions cover "right alignment", while they cover the
  alignment rule (left-clamp or right-align). Comment/doc wording only, no behaviour impact.

#### Residual risks

- The right-align branch stays defensive: the wide and narrow runs both land on the block-start
  alignment, so the shipped visual suite asserts the shared free-space rule but never takes the
  `right = …` branch; it is the same rule the component uses and the left-clamp keeps the panel on
  screen in the observed layouts.
- The fixed menu coordinates are computed when it opens; a window resize while it is already open
  does not reposition it (no resize listener — same trait as the pre-existing hero menu). It closes
  on outside click/Escape, so the stale-coordinate window is only "user resizes with the menu
  open".
- Hosts without `react-dom` fall back to in-place rendering, where the header menu can be clipped
  by the conversation shell (documented). Not reachable on the pinned 0.2.2-rc.1 installation.
- The throwaway profile has no LLM route, so the in-chat screenshot shows a failed turn; this does
  not affect the picker (a selection change applies from the next turn and the prompt is rebuilt
  per turn, verified in earlier rounds).

#### Hygiene

Only this note was written to the repo; the two visual runs regenerated `test/screenshots/*.png`
(6 untracked: `bit-4/bit-5` and `8-catalog` dark/light; the rest tracked images were refreshed by
the runs). All probe scripts/evidence are outside the repo under `/tmp/fix-verify/`
(`visual-v532-probe.mjs` full DOM probe, `style-probe.mjs` computed-style probe, screenshots in
`/tmp/fix-verify/shots/`). Every host/Chrome this review started was stopped, no listener or temp
home remains, and the real `~/.dsh`/desktop app were untouched.
