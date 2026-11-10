# Bits v5 — build contract (read first)

Rebuild of `@dsh-burn-plugins/dsh-bots` (product name **Bits**). Supersedes the v1–v4 contract in
`CONTRACT.md` for the parts listed here. `CONTRACT.md` stays as historical reference; when
this file conflicts with it, **this file wins**.

## 0. Product pivot

- A **bit** is no longer a personal agent and no longer has a Docker VM. A bit is a
  definition: context (instructions) + `isOrchestrator` + model + effort.
- Every bit **receives a request and returns a response**. There is no chat, no persona
  injected into Harness sessions, no reminders/notifications owned by the plugin.
- Bits are used **in flows**: a **team** is a flow whose members reference bits.
  - `isOrchestrator: true` bits coordinate: they run as DSH agents on the
    **DeepSeek-V4.1-Flash Max** route (default `deepseek-account/deepseek-flash`, effort
    `max`) and are the only bits allowed to be a team **lead**.
  - `isOrchestrator: false` bits are workers: a single invocation (request → response),
    executed **through the `claude_delegate` tool of `@dsh-burn-plugins/dsh-claude-delegate`** (Claude
    subscription / Claude Code CLI) by default. A worker may be re-pointed to a DSH chat
    model; then the invocation is a one-shot `ctx.llm.stream` call (no tools).
- Users may change a bit's model/effort, from the models available to a normal chat
  (profile LLM providers/models + efforts) plus the subscription models of the delegate
  plugin.
- Bits no longer open sessions from the Bits page. The Bits page creates/edits bits and has
  **Run** (ad-hoc worker invocation: request → response). Orchestrators execute inside
  a flow (Teams tab → execute the flow), not ad-hoc.
- Teams/flows keep their editor, projects layer and harness packs. Runtime changes: the
  lead is an orchestrator bit on the DeepSeek route; workers are invoked one-shot; members
  of a team **reference bits by id**.

Non-goals: VM, chat with bits, notifications/reminders from the plugin, changes to the DSH
core, installing/enabling anything in a profile from a worker.

---

## 1. Model catalog and model strings

Two model families:

1. **Subscription (Claude Code, via `claude_delegate`)**
   - Stored as `subscription/<alias>` with `alias ∈ {opus, sonnet, haiku}`.
   - Display labels: `Claude Opus 5.5 (subscription)`, `Claude Sonnet 5.5 (subscription)`,
     `Claude Haiku 5.5 (subscription)`.
   - Efforts: `low | medium | high | xhigh | max`.
   - Runs with the worker's cwd and Claude Code tools; read-only workers pass
     `readOnly: true` (see §6).
2. **DSH chat routes (profile LLM providers)**
   - Stored as `<provider>/<modelId>`, e.g. `deepseek-account/deepseek-flash`.
   - Display label = the model name reported by `ctx.llm` (e.g. `DeepSeek V4.1 Flash`).
   - Efforts = the model's supported reasoning efforts from `ctx.llm.resolveModelInfo()`;
     when it reports none, offer `low | medium | high | xhigh | max` (the value is applied
     best-effort, like the old team runtime did).
   - Orchestrators **must** use this family (an agent needs a route). Default:
     `deepseek-account/deepseek-flash` + `max` ("DeepSeek-V4.1-Flash Max").
   - Workers may use this family; their invocation is a **single model call** through
     `ctx.llm.stream` (no tools; the response is text).

Resolution helpers live in a new `host/models.js`:

```js
export function createModelCatalog(ctx) // { list(), resolve(bit), effortFor(model, wanted), routeFor(bit) }
// list() -> { models: ModelOption[] }  (route GET /api/bots.models)
// resolve(bit) -> { backend: 'claude-code', alias, modelId, effort }
//              | { backend: 'dsh', provider, model, effort }
//              | throws coded Error (BIT_MODEL_INVALID / BIT_MODEL_MISSING)
// ModelOption = { id, label, group: 'subscription'|'routes', backend, provider?, model?,
//                 alias?, efforts: string[], tools: boolean, supportsOrchestrator: boolean }
```

`list()` caches for ~60 s. It never throws: a profile whose providers cannot be listed
returns the subscription group only. Models whose efforts cannot be resolved still appear
with the fallback effort list. `resolve("DeepSeek-V4.1-Flash")` (bare label) is accepted for
backward compatibility/migration: match a profile model by name or id tokens; resolve to
`<provider>/<modelId>`. `subscription/opus` resolves via the alias table; also accept a bare
`opus`/`sonnet`/`haiku` for legacy data.

`effortFor(model, wished)` maps aliases the way the old runtime did
(`xhigh → xhigh|max|high`, `high → high|max`, `medium → medium|high|low`,
`low → low|minimal|medium`, `max → max|xhigh|high`) and returns the first supported id, or
undefined when the model reports no efforts.

---

## 2. Bit record (host/store.js — `BitStore`)

Persisted in `<botsRoot>/bits.json` (atomic write, tmp+rename, 0600). `botsRoot` default
`$DSH_HOME/bots` (unchanged). Migration from v4 `bots.json`: if `bits.json` is missing and
`bots.json` exists, convert it (see §3) and keep `bots.json` renamed to
`bots.json.migrated-<ts>`. Corrupt JSON → `bits.json.corrupt-<ts>`, start empty (same as v4).

```json
{
  "statusVersion": 2,
  "bits": [
    {
      "id": "3f9a1c2b7e",
      "name": "Builder",
      "character": "bit-builder",
      "emoji": "🛠️",
      "color": "#7c3aed",
      "instructions": "Bit context (persona/briefing)...",
      "isOrchestrator": false,
      "model": "subscription/sonnet",
      "effort": "high",
      "workspaceDir": "/home/me/.dsh/bots/3f9a1c2b7e/workspace",
      "createdAt": "ISO",
      "updatedAt": "ISO"
    }
  ]
}
```

- `id`: 10 lowercase hex, generated by the store.
- `name`: trimmed 1..60, required.
- `character`: catalog bit id (`/^[a-z0-9][a-z0-9-]{0,63}$/`) or `null`. Routes reject ids
  missing from `bits/catalog.json` (`BIT_INVALID_CHARACTER`); the store only checks syntax.
- `emoji` 1..8 chars (default `🤖`), `color` `#rrggbb` (palette default when omitted).
- `instructions`: 0..20000, default `""` (the description/context of the bit; kept).
- `isOrchestrator`: boolean, default `false`. When `character` is given and the field is
  omitted, inherit the catalog default.
- `model`: 0..120 chars; `effort`: 0..20 chars. When omitted and `character` is known,
  inherit catalog defaults; otherwise default `subscription/sonnet` / `high`
  (workers) or `deepseek-account/deepseek-flash` / `max` (orchestrators).
- `workspaceDir`: absolute (≤1024), default `<botsRoot>/<id>/workspace`; created on create.
  Used as cwd for ad-hoc worker runs. Never escapes `botsRoot` for destructive operations.
- Max 200 bits (`BOT_LIMIT` → keep the existing code names for routes: the public route
  names stay `/api/bots.*`; the product/UI calls them Bits). Methods: `list`, `get`,
  `getByWorkspace`, `create`, `update`, `remove`, `ensureWorkspace`, `deleteWorkspace`,
  `flush`, `file`.

Validation errors keep coded errors (`BOT_INVALID`-style) with the field in the message.

---

## 3. Migration of persisted data (v4 → v5)

### 3.1 `bots.json` (BitStore.init)

For every v4 bot: copy `id, name, character, emoji, color, instructions, workspaceDir,
createdAt, updatedAt`; drop `vm`; fill `isOrchestrator`, `model`, `effort` from the catalog
bit for `character` (when known), else `false` / `subscription/sonnet` / `high`. Write
`statusVersion: 2` with the key `bits`. Do it once, before the store is readable; log a line.

### 3.2 `teams.json` (TeamStore.init, needs the bit store)

For every v4 team whose members have no `bitId`:

1. For each member, compute a dedupe key `character|name|instructions` (missing → id).
   Reuse/create a bit:
   - Bit fields: `name` = member.name, `character` = member.character, `instructions` =
     member.instructions, `emoji`/`color` = catalog/catalog default.
   - Lead member → `isOrchestrator: true`, `model: "deepseek-account/deepseek-flash"`,
     `effort: "max"`.
   - Other members → catalog default for the character when known, else
     `subscription/sonnet` / `high`.
   - Reuse an existing bit with the same dedupe key (including bits created earlier in this
     migration) so shared harness presets become one bit, not six.
2. Replace the member with `{ id, bitId, role, access, launches, teamRef, mcp, skills }`
   (missing optional fields normalized by the normal team validator). Member `id` must not
   change (`team-bindings.json` refers to it).
3. Keep `lead` (member id), `flow`, harness/project fields untouched.
4. Back up the old file as `teams.json.bak-<ts>`, write the migrated `teams.json` atomically.
   Idempotent: a file that already uses `bitId` members is not touched.

Migration must never lose a team and must not throw when the catalog or a character is
missing (fallback values above). Log a summary (`N teams, M bits created`).

---

## 4. Bit catalog (`bits/catalog.json`, `host/catalog.js`)

Schema version 2. Each of the 52 bits keeps `id, name, group, emoji, color, summary,
instructions` and gains:

```json
{ "isOrchestrator": false, "model": "subscription/sonnet", "effort": "high" }
```

Defaults to assign (exact table — the Lead owns it, implementers must not invent others):

| bit | isOrchestrator | model | effort |
|---|---|---|---|
| bit-mascot | false | subscription/sonnet | high |
| bit-manager | **true** | deepseek-account/deepseek-flash | max |
| bit-product-owner | **true** | deepseek-account/deepseek-flash | max |
| bit-coordinator | **true** | deepseek-account/deepseek-flash | max |
| bit-sub-coordinator | **true** | deepseek-account/deepseek-flash | max |
| bit-systems-analyst | false | subscription/opus | high |
| bit-product-analyst | false | subscription/sonnet | medium |
| bit-user-researcher | false | subscription/sonnet | medium |
| bit-scout | false | subscription/haiku | low |
| bit-researcher | false | subscription/sonnet | medium |
| bit-architect | false | subscription/opus | xhigh |
| bit-builder | false | subscription/sonnet | high |
| bit-runner | false | subscription/haiku | low |
| bit-reviewer | false | subscription/opus | high |
| bit-debugger | false | subscription/opus | xhigh |
| bit-ci-triager | false | subscription/sonnet | medium |
| bit-writer | false | subscription/sonnet | medium |
| bit-qa | false | subscription/sonnet | high |
| bit-web-tester | false | subscription/sonnet | high |
| bit-android-tester | false | subscription/sonnet | high |
| bit-ios-tester | false | subscription/sonnet | high |
| bit-frontend-engineer | false | subscription/sonnet | high |
| bit-backend-engineer | false | subscription/sonnet | high |
| bit-android-engineer | false | subscription/sonnet | high |
| bit-ios-engineer | false | subscription/sonnet | high |
| bit-flutter-engineer | false | subscription/sonnet | high |
| bit-react-native-engineer | false | subscription/sonnet | high |
| bit-cloud-engineer | false | subscription/sonnet | high |
| bit-sre | false | subscription/opus | high |
| bit-deployer | false | subscription/sonnet | medium |
| bit-integration-engineer | false | subscription/sonnet | high |
| bit-performance-engineer | false | subscription/opus | high |
| bit-database-expert | false | subscription/opus | high |
| bit-data-engineer | false | subscription/sonnet | high |
| bit-data-scientist | false | subscription/opus | high |
| bit-llm-expert | false | subscription/opus | high |
| bit-cybersecurity-expert | false | subscription/opus | xhigh |
| bit-ux-designer | false | subscription/sonnet | medium |
| bit-ui-designer | false | subscription/sonnet | medium |
| bit-design-system-expert | false | subscription/sonnet | high |
| bit-accessibility-expert | false | subscription/sonnet | medium |
| bit-growth-marketer | false | subscription/sonnet | medium |
| bit-seo-expert | false | subscription/sonnet | medium |
| bit-copywriter | false | subscription/sonnet | medium |
| bit-i18n | false | subscription/haiku | low |
| bit-crm-specialist | false | subscription/haiku | low |
| bit-sales | false | subscription/sonnet | medium |
| bit-sales-assistant | false | subscription/haiku | low |
| bit-customer-success | false | subscription/sonnet | medium |
| bit-support | false | subscription/haiku | low |
| bit-finance-analyst | false | subscription/sonnet | medium |
| bit-privacy-compliance | false | subscription/opus | high |

`host/catalog.js` passes the three fields through (`has`, `get`, `list`, avatars as today)
and validates them (defaults for old files: false / subscription/sonnet / high). Nothing
else in the catalog changes; instructions stay exactly as they are.

---

## 5. Teams v5 (host/teams.js, host/team-routes.js, host/harness-routes.js)

### 5.1 Record

Unchanged fields: `id, name, description, emoji, color, workspaceDir, lead, harness,
bindWorkspace, rules, skills, entry, shared, projectIds, flow, createdAt, updatedAt`.

Members change to **references to bits**:

```json
"members": [
  {
    "id": "builder",
    "bitId": "3f9a1c2b7e",
    "role": "Implements from the red tests",
    "access": "write",
    "launches": ["scout"],
    "teamRef": null,
    "mcp": [],
    "skills": []
  }
]
```

- `member.id` keeps its syntax and uniqueness rules.
- `bitId`: required, string id of an existing bit. Unknown → `TEAM_INVALID`
  (`members[i].bitId: unknown bit "..."`). The team store validates through the injected bit
  store.
- `role` 0..200; `access` `read|write` (default `write`); `launches` as today; `teamRef`,
  `mcp`, `skills` as today.
- Removed from members (ignored if present in old data; migration converts): `character`,
  `name`, `model`, `provider`, `effort`, `instructions`.
- `lead`: member id or null. When set, its bit must have `isOrchestrator: true`
  (`TEAM_LEAD_NOT_ORCHESTRATOR`). A team may exist without a lead (template/registry only),
  but executing it fails with the existing coded errors.
- `TeamStore` constructor: `new TeamStore({ botsRoot, bits })`; `bits` is the `BitStore`
  (used by validation and migration).
- The rest of the validation/limits/persistence stays exactly as v4 (atomic writes, ≤200
  teams, ≤64 members, flow rules, `shared`/`projectIds`, corrupt-file quarantine).

### 5.2 Team templates (`bits/teams/*.json`)

New format: template bits plus members that reference them by a local key.

```json
{
  "id": "engineering",
  "name": "Engineering (Claude Code)",
  "description": "...",
  "emoji": "🛠️",
  "bits": [
    { "key": "coordinator", "name": "Coordinator", "character": "bit-coordinator",
      "instructions": "", "isOrchestrator": true,
      "model": "deepseek-account/deepseek-flash", "effort": "max" }
  ],
  "team": {
    "name": "...", "description": "...", "emoji": "👥", "color": "#2563eb",
    "workspaceDir": null, "lead": "coordinator",
    "members": [ { "id": "coordinator", "bitKey": "coordinator",
                   "role": "...", "access": "read", "launches": ["scout"] } ],
    "flow": { "nodes": [], "edges": [] }
  }
}
```

- `loadTeamTemplates(dir)` validates and returns templates; a template without `bits` is
  invalid and logged/skipped.
- New route `POST /api/bots.teams.fromTemplate` (`{ templateId, name?, projectId? }`)
  creates the bits (catalog defaults for the character + template overrides, `instructions`
  default: catalog instructions) and the team (`bitKey → bitId`), returns
  `{ team, bits }`. A one-time template instantiation always creates fresh bits.
- Existing `GET /api/bots.teams.templates` returns templates as loaded, including `bits`.
- Rewrite `bits/teams/engineering.json` to the new format, preserving its current members
  (roles, access, launches), flow, name/description and the lead role ("Orchestrator" /
  coordinator). Worker bits get their roles from the current member `role`; the lead bit
  keeps its current lead instructions.

### 5.3 Harness → team (`teamFromPack` in host/harness-routes.js)

Returns `{ bits, team }` instead of a team with embedded members:
- One bit per harness preset: `name` = preset name, `character` = mapped catalog bit,
  `instructions` = preset instructions, `isOrchestrator: false`, model/effort = catalog
  defaults for the character (fallback `subscription/sonnet` / preset effort when it is a
  valid CLI effort, else `high`).
- Lead bit: `name: "Orchestrator"`, `character: "bit-coordinator"` (or null when missing),
  `isOrchestrator: true`, `model: "deepseek-account/deepseek-flash"`, `effort: "max"`,
  instructions = the current lead text.
- The helper returns `{ bits, team }` where the team members still carry the
  template-local `bitKey` (bit ids only exist after creation); the
  `/api/bots.teams.fromPack` route creates the bits, resolves `bitKey → bitId`, creates
  the team and answers `{ team, bits }`.

### 5.4 Team routes

- `teams.create/update`: normal team payload but with `bitId` members (the client no longer
  sends embedded member data). Cross-store checks run before saving.
- `teams.providers` is **removed** (model/provider pinning is gone). The model picker data
  comes from `GET /api/bots.models`.
- Keep: `teams`, `teams.templates`, `teams.fromPack`, `teams.workspace`, `teams.run`,
  `teams.runtime`. `registerTeamRoutes` deps gain `bits`; `registerHarnessRoutes` deps gain
  `bits` and `catalog`.

---

## 6. Execution runtime

### 6.1 New `host/bit-runtime.js`

```js
export function createBitRuntime(ctx, { bits, catalog, models, log })
// returns:
//   listModels({ signal })                  -> { models }   (GET /api/bots.models)
//   runBit({ bit, request, readOnly, cwd, signal }) -> { response, meta }
//   invokeWorker({ bit, task, cwd, readOnly, signal }) -> { text, meta }  (team delegation)
```

- **Worker invocation** (`isOrchestrator === false`):
  - Resolve the model with `models.resolve(bit)`.
  - `backend: 'claude-code'`: call the `claude_delegate` tool through the tool pipeline:
    `ctx.tools.execute({ calls: [{ id, name: 'claude_delegate', arguments: JSON.stringify({
    task: prompt, model: alias, effort, cwd, readOnly }) }], signal })`.
    The answer is the settled canonical `value` (a string). `readOnly: true` is passed only
    when the member access is `read`; ad-hoc runs pass the request's `readOnly` flag.
    When the tool is unavailable/failed, throw a coded error with an actionable message
    (`BIT_DELEGATE_UNAVAILABLE`): install/enable `@dsh-burn-plugins/dsh-claude-delegate`, log in with
    `claude`.
  - `backend: 'dsh'`: one-shot `ctx.llm.stream({ provider, model, reasoningEffort, messages:
    [{ role: 'user', content: [{ type: 'text', text: prompt }] }], signal })`; concatenate
    `text-delta` chunks; a `finish` chunk with `reason.kind !== 'success'` throws
    (`BIT_MODEL_CALL_FAILED`). No tools in this mode.
  - Prompt = `bit.instructions` + blank line + separator + the request/task, plus a short
    report instruction if the bit has no instructions. Metadata returned:
    `{ backend, model, effort, durationMs, usage? }`.
- **`runBit`** is the ad-hoc path (`POST /api/bots.run`): refuses orchestrator bits with
  `BIT_IS_ORCHESTRATOR` ("orchestrators run in flows"). `request` is 1..20000 chars.
  Worker cwd = `bit.workspaceDir`; the route may pass a different cwd only if it is inside
  the bit workspace. `readOnly` defaults to true for ad-hoc runs (UI toggle can send false).
- **`invokeWorker`** is the team-delegation path used by `team-runtime`: cwd = the caller
  session's cwd when inside the team workspace, else `team.workspaceDir`; `readOnly =
  member.access === 'read'`; returns text plus metadata. The team runtime formats the
  result for the orchestrator (see 6.2) and converts errors into model-visible tool errors.

### 6.2 Team runtime (`host/team-runtime.js`)

- The lead is resolved from the team `lead` member's bit: it must be `isOrchestrator: true`
  and its model must resolve to a DSH route (`backend: 'dsh'`); otherwise `startMission` /
  delegation fails with a coded message. The lead agent's route comes from the lead bit
  (`{ provider, model, reasoningEffort }`), defaulting to DeepSeek-V4.1-Flash Max.
- `team_delegate`:
  - Target member whose bit `isOrchestrator === true` → today's DSH child-agent path
    (`ctx.subagents.startActivation`) with the route from that bit (used for teamRef /
    nested orchestration). Its prompt is the bit instructions + member prompt text.
  - Target member whose bit `isOrchestrator === false` → `bitRuntime.invokeWorker(...)`
    (one-shot). Result format returned to the model:
    `[<bit name> · <backend/model> · <effort>]` + response text (or the coded error).
    The existing tool-result header style (`[label · stopReason · route · session]`) is
    replaced by this for workers.
- `startMission` unchanged in mechanics (persisted binding → `sessionController.create` →
  `agent.followup(request)`), but the lead persona and route come from the bit.
- `team_handoff` unchanged (root lead to another team's lead; both are orchestrator bits).
- Remove provider pinning: no `members[].provider` resolution, no `routeFor` label matching
  for members. `team-runtime` uses `models.routeFor(bit)` for DSH routes.
- `team-prompt.js`: texts updated — the roster shows each member's bit name, role, access,
  backend and model/effort; the lead text explains that workers are single-shot invocations
  (the task must be self-contained; they run in the flow workspace; they return a text
  report) and that orchestrator members run as child agents; the flow text and harness rules
  stay. The persona of the lead/member comes from the referenced bit's `instructions`.
- `team-guard.js`: tool policies for agent bindings stay; wording changes from "member" to
  "bit" where user-visible. `access: read` for orchestrator members still denies writes;
  for workers it is enforced through `readOnly: true` in the delegate call.
- `host/team-bindings.js`, project layer: unchanged.

### 6.3 Wire `claude_delegate`'s read-only capability

`@dsh-burn-plugins/dsh-claude-delegate` (repo `/home/leandro/Documents/deepseek-harness/default-workspace/dsh-claude-delegate`,
already installed in the desktop profile) gets a small addition: an optional
`readOnly: boolean` tool parameter. When true, the child runs with
`--permission-mode plan` instead of `--dangerously-skip-permissions`; the default stays
bypass. Update its README and keep its tool description accurate. No other behavior change;
`@dsh-burn-plugins/dsh-bots` does not import that package — it invokes the registered tool.

---

## 7. Host routes (host/routes.js — `registerBotRoutes`)

Same conventions as v4 (HTTP 200, `{ ok }`, coded errors pass through, `INTERNAL`
otherwise, awaits `ready`). Public path prefix stays `/api/bots.*`.

| path | method | request | response |
|---|---|---|---|
| `/api/bots.list` | GET | – | `{ bits: Bit[] }` (add `bits`; keep `bots` alias for older clients) |
| `/api/bots.create` | POST | `{ name?, character?, emoji?, color?, instructions?, isOrchestrator?, model?, effort? }` | `{ bit }` (and `bot` alias) |
| `/api/bots.update` | POST | `{ id, patch }` | `{ bit }` |
| `/api/bots.delete` | POST | `{ id, deleteWorkspace? }` | `{ deleted: true, id }` |
| `/api/bots.catalog` | GET | – | `{ groups, bits }` (with the new fields) |
| `/api/bots.avatar` | GET | `?id=` | avatar bytes (unchanged) |
| `/api/bots.models` | GET | – | `{ models: ModelOption[] }` |
| `/api/bots.run` | POST | `{ id, request, readOnly? }` | `{ response, meta }` |

Removed: `/api/bots.images`, `/api/bots.vm`, `/api/bots.notify-test` and the VM/`workspaceId`
fields in list. `GET /api/bots.diagnostics` keeps working but reports bits (id, name,
isOrchestrator, model, effort) and the team-runtime agent diagnostics; no VM fields.
Route errors: `BOT_NOT_FOUND`, `BOT_INVALID`, `BOT_INVALID_CHARACTER`, `BIT_IS_ORCHESTRATOR`,
`BIT_MODEL_INVALID`, `BIT_RUN_FAILED`.

`POST /api/bots.run` is synchronous (an invocation may take minutes); pass the request
abort signal into the runtime when the transport exposes one. Set a generous route-level
guard (e.g. 15 min) and return `BIT_RUN_TIMEOUT` if exceeded.

---

## 8. Client (client.js)

Keep the single-file React-via-module-loader style. Tabs: **Bits**, **Teams**, **Projects**.

Bits tab:
- Cards: avatar, name, character name, group, badges `Orchestrator`/`Worker` and
  `<model label> · <effort>`; no VM badge/status.
- New bit: catalog gallery unchanged, but the form now shows `isOrchestrator` (toggle),
  `Model` (select from `/api/bots.models`) and `Effort` (select), pre-filled from the
  chosen catalog bit; "Restore default description" stays.
- Editor validates: orchestrator → only `routes` models (dsh); toggling isOrchestrator
  snaps the model to a valid default of the new family when the current one is invalid.
- Bit detail: no "Chat", no VM controls. Workers get **Run**: a dialog with a
  request textarea, a "read-only" toggle (default on), run button with busy state,
  response panel (and error). Orchestrators show "Executes in flows (Teams tab)" plus the
  teams where the bit is the lead, if any.
- Remove every VM string/section/poll (`/api/bots.images`, `/api/bots.vm`, docker hints),
  the notify-test bell, and chat buttons.

Teams tab:
- Member editor: pick the bit (select from `/api/bots.list`, grouped by catalog group),
  then edit `role`, `access`, `launches`, `teamRef`, `mcp`, `skills`; the bit's model/effort/
  isOrchestrator shown read-only (link "edit bit" if easy). Remove model/provider/effort/
  character/instructions inputs from members.
- Lead selector lists only members whose bit is an orchestrator; if the current lead is not
  one, show the error inline.
- Templates: creating a team from a template calls `POST /api/bots.teams.fromTemplate`.
- "Send request" / run: use `POST /api/bots.teams.run` (auto-started mission) instead of
  pre-filling a session draft; show a busy state and the created session when it returns
  (open it if the UI allows, like the previous flow).
- Flow editor itself (nodes, edges, groups, drag, undo, save) is unchanged.

Projects tab: unchanged except team cards may show the lead bit name.

Locale: update `client.js`'s single embedded English dictionary (`EN`, which absorbs the
team strings from `TEAM_EN`) and the `locale/en.json` metadata (title/description = Bits/flows).

---

## 9. Files

Delete: `host/vm.js`, `host/agent.js`, `host/notify.js`, `test/vm.test.mjs`,
`test/vm-lifecycle.test.mjs`, `test/agent.test.mjs`, `test/notify.test.mjs`.
Add: `host/bit-runtime.js`, `host/models.js`, `test/bit-runtime.test.mjs`,
`test/models.test.mjs` (optional if covered), `V5-CONTRACT.md` (this file).
Update: every other host file, `index.js`, `client.js`, `bits/catalog.json`,
`bits/teams/engineering.json`, `package.json` (description/keywords, no vm terms),
`cordis.patch.yml` (drop vm config), `README.md`, `CONTRACT.md` (point to v5),
`locale/*.json`, all remaining tests.
`REVIEW.md` gets a new independent v5 review appended (verifier only).

Package/config: remove `defaultImage`, `dockerBin`, `execTimeoutMs`, `maxOutputBytes` from
the `bots` row config; keep `botsRoot` (and maybe `bitsRoot` alias). No Docker dependency
anywhere.

---

## 10. Tests each owner must keep green

- `test/store.test.mjs` — bits record, validation, persistence, migration (fixture with a
  v4 `bots.json`), workspace deletion safety.
- `test/catalog.test.mjs` — 52 bits, new fields/types/defaults per §4, avatars/route.
- `test/routes.test.mjs` — bits CRUD, catalog, avatar, models, run (worker success + refusal
  for orchestrator + model error + readonly flag reaching the runtime), no removed routes.
- `test/teams.test.mjs` — v5 members with `bitId`, validation, lead orchestrator rule,
  migration of a v4 `teams.json` fixture (dedupe members → bits), templates, fromTemplate.
- `test/projects.test.mjs` — unchanged behavior, adapted server fixtures.
- `test/harness.test.mjs` — `teamFromPack` returns `{ bits, team }` with lead/orchestrator
  defaults; fromPack route creates bits.
- `test/team-runtime.test.mjs` — fake host: lead route from the lead bit; worker delegation
  goes through the fake `claude_delegate` tool with the composed prompt/model/effort/cwd/
  readOnly; orchestrator member still uses `startActivation`; guard behavior retained.
- `test/bit-runtime.test.mjs` — model resolution, subscription path (fake tools pipeline),
  dsh one-shot path (fake `llm.stream` chunks), prompt composition, readOnly, errors.
- `test/e2e-web.mjs` — updated by the Lead after integration (isolated profile: bits CRUD,
  catalog/models routes, team from template, team run wiring, no VM routes).
- Visual suites — updated by the client owner (`visual.mjs`, `visual-teams.mjs`,
  `visual-projects.mjs`).

Tests run with plain `node test/<file>.test.mjs` (Node 24). No Docker required anymore.
Every worker must run the suites it touches and report the exact commands/results.

---

## 11. Ownership (write scopes)

| owner | files |
|---|---|
| Lead | `index.js`, `cordis.patch.yml`, `package.json`, `locale/*`, `V5-CONTRACT.md`, `README.md`, `CONTRACT.md`, `REVIEW.md`, `test/e2e-web.mjs`, deletions of vm/agent/notify files |
| bits-domain | `host/store.js`, `host/catalog.js`, `host/routes.js`, `bits/catalog.json`, `test/store.test.mjs`, `test/catalog.test.mjs`, `test/routes.test.mjs` |
| teams-domain | `host/teams.js`, `host/team-routes.js`, `host/harness-routes.js`, `host/harness.js` (only if needed), `bits/teams/engineering.json`, `test/teams.test.mjs`, `test/harness.test.mjs`, `test/projects.test.mjs` |
| runtime | `host/team-runtime.js`, `host/team-prompt.js`, `host/team-guard.js`, `host/team-bindings.js` (only if needed), new `host/models.js`, new `host/bit-runtime.js`, `test/team-runtime.test.mjs`, new `test/bit-runtime.test.mjs`, claude-delegate repo `index.js`/`README.md` |
| client | `client.js`, `test/visual.mjs`, `test/visual-teams.mjs`, `test/visual-projects.mjs` |
| verifier | `REVIEW.md` only (independent, read-only on code) |

Never edit another owner's file. Cross-owner needs go through the Lead. Never install,
enable, disable or modify a DSH profile; never commit to git.

## 12. Chat preset: Bit mode (v5.1, renamed in v5.2)

**This section extends v5**; it is the **v5.1 increment**, not a replacement. Sections 0–11 keep
their meaning, and a profile that does not install the new preset row behaves exactly as
documented there. The increment adds an optional **chat agent preset**: a chat created with it
runs as an orchestrator that delegates self-contained tasks to catalog bits, one-shot, each bit
with its own preset model and reasoning effort. The preset is selectable, never the default, and
it never changes the chat session's own model/effort.

### 12.1 Preset declaration (`cordis.patch.yml`)

The bundle patch keeps the `bots` row unchanged and puts both rows in one `insert` list:

```yaml
- insert:
    - id: bots
      name: '@dsh-burn-plugins/dsh-bots'
      config: {}
    - id: preset-bits-orchestrator
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: bits-orchestrator
        name: Bit mode
        description: "Chat as an orchestrator of Bits: delegates self-contained tasks to catalog bits and applies each bit's preset model and reasoning effort. The chat's own model and effort stay as selected."
        order: 5
        plugins:
          # Verbatim copy of the installed
          # @deepseek-ai/dsh-web-app/presets/standard.patch.yml config.plugins
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            # …every entry, config value and !!js condition of the installed list…
```

- Row id `preset-bits-orchestrator`; preset id `bits-orchestrator`; display name
  `Bit mode`; `order: 5` (the display name; the preset id stays `bits-orchestrator`).
- `config.plugins` is a **verbatim copy** of the installed
  `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` child list (every entry, config value
  and `!!js` condition). An agent preset is defined by the child plugins it declares: keeping
  the list verbatim makes the mode a **full normal chat** (persona, instructions, tools,
  skills, plan mode, compaction, subagents) and the runtime adds the orchestration prompt/tool
  on top. A header comment in the file names the origin and the installed DSH version
  (`0.2.2-rc.1`) so the copy is refreshed when the app's standard preset changes.
- The `bots` row keeps its id/name/config; no built-in preset row and no profile default preset
  is changed. After install the preset appears in `agentPresets/list` healthy (`broken` absent)
  with `isDefault: false` (a preset-less session still resolves to the profile default, which is
  `standard` in the installed app), and `session/create` with `agentPreset: bits-orchestrator`
  records that id on the session (`session.header.agentPreset`).

### 12.2 Runtime (`host/orchestrator.js`)

```js
export const ORCHESTRATOR_PRESET = 'bits-orchestrator'
export function presetIdOfSession(session) // session.header.agentPreset trimmed; null when absent/blank
export function isOrchestratorSession(agent) // presetIdOfSession(agent.session) === ORCHESTRATOR_PRESET
export function installOrchestrator(ctx, deps) // -> { diagnostics(), dispose() }
```

- `deps = { bits, catalog, models, bitRuntime, log }` — the live objects already built by
  `index.js`. `models` is accepted for parity with the other runtimes and is not needed here:
  the catalog is the one loaded at plugin apply and `bitRuntime` performs the one-shot
  invocation.
- **Detection is by the session header only** (`session.header.agentPreset`), never by the
  working directory or a team binding. Sessions in any other preset are not touched at all.
- `installOrchestrator` subscribes to `agent/created` and also sweeps `ctx.agents.list()` once at
  install (guarded try/catch), so agents created before the hook and agents from an HMR reload
  are covered. Each agent is instrumented once. Per agent it registers:
  - an agent-scoped system prompt section `bits:orchestrator`, order `700`,
    `interpolate: false`, with the text built once from the loaded catalog (no file I/O per
    turn, so it is stable and cache-friendly);
  - an agent-scoped `bit_delegate` tool through `agent.ctx.tools.register`.
- `agent/disposed` uninstalls the section and the tool of that agent; `dispose()` removes the
  remaining ones and the hooks. Errors go to `log` and `diagnostics().errors` (timestamped,
  capped); the `agent/created` hook never throws out of the plugin.
- `index.js` installs the runtime right after `createBitRuntime(...)` inside try/catch (an
  installation failure is logged and does not stop the rest of the plugin), adds its
  `diagnostics()` to `/api/bots.diagnostics` under `orchestrator`, and calls `dispose()` in the
  teardown effect.

### 12.3 Prompt section (`bits:orchestrator`)

The text states the mode and its invariants (v5.2 makes the text a function of the selected orchestrating bit, §13.3):

- **Role:** the chat is a Bit-mode orchestrator: it receives the request, decides what to delegate
  and returns the final answer. The model and reasoning effort of the chat are the ones the
  user selected — **the mode never changes them**.
- **Delegation:** `bit_delegate({ bit, task, read_only })` runs **one worker bit, one-shot**
  (request → response). The worker does not see this chat, so the task must be self-contained
  (goal and done criteria, workspace, context, files, constraints, return format). Workers run
  in this chat's working directory and return a text report. `read_only` defaults to `true`;
  `read_only: false` is for tasks that change files or run commands in the workspace.
  Independent delegations may be issued in parallel.
- **Automatic bits:** each catalog character already has a preset model and reasoning effort.
  Delegating to a catalog name/id creates that bit with its catalog preset when no bit for that
  character exists; an existing bit for the same character (or same name) is reused with the
  user's own model/effort edits. Bits can be customized later on the **Bits** page.
- **Work split:** answer conversation, planning and questions directly; delegate
  implementation/research/review/execution to the right bits; synthesize their reports; do not
  delegate trivial replies. Orchestrator catalog characters (Manager, Product Owner,
  Coordinator, Sub-coordinator) cannot be delegated — the mode itself is the orchestrator, use
  worker bits.
- **Roster:** built once from the `bits/catalog.json` object already loaded by the plugin,
  grouped by catalog group (`### <group label>`), one line per **worker** character, e.g.
  `- **Builder** (`bit-builder`) — <summary> · preset: subscription/sonnet · high`.
  The four orchestrator characters are not part of the worker roster (48 worker entries).

### 12.4 Tool `bit_delegate`

A plain tool-definition object in the `delegateTool` style of `host/team-runtime.js` (not
`defineTool`; no new dependency).

| parameter | type | required | meaning |
|---|---|---|---|
| `bit` | string | yes | catalog character name or id (`Builder`, `bit-builder`) or the name/id of an existing bit |
| `task` | string | yes | self-contained task; the worker never sees this session |
| `read_only` | boolean | no (default `true`) | `false` lets the bit edit files and run commands in the workspace |

`execute(args, exec)`:

1. Validate `bit` and `task` (non-empty after trimming) with coded `BIT_DELEGATE_INVALID`
   errors; a missing `bitRuntime` — and a missing bits store when a catalog bit has to be
   provisioned — is reported as coded `BIT_DELEGATE_UNAVAILABLE`.
2. Resolve the target, in this order:
   1. an existing bit by exact id;
   2. an existing bit by case-insensitive trimmed name (first in store order when duplicated;
      the ambiguity is only noted in diagnostics);
   3. a catalog character by exact id or case-insensitive name;
   4. otherwise a coded `BIT_UNKNOWN` listing some available names.
3. Catalog character:
   - an existing bit whose `character` is that id is reused (preferring the one whose name
     matches the character name, else the first) with its **own stored model/effort**;
   - otherwise the bit is created from the catalog with its preset **`model` and `effort`
     passed explicitly** (`name`, `character`, `emoji`, `color`, `instructions`,
     `isOrchestrator` from the catalog, `workspaceDir: undefined` so the store creates the
     per-bit workspace); concurrent creations for the same character are deduplicated by an
     in-flight promise map;
   - a resolved bit with `isOrchestrator === true` is refused with a coded
     `BIT_IS_ORCHESTRATOR`: worker bits are one-shot and the chat itself is the orchestrator.
4. `cwd` = this session's working directory (`ctx.workingDirectory.get(agent.session)`, then
   `agent.session.header.cwd`, then `process.cwd()`).
5. `bitRuntime.invokeWorker({ bit, task, cwd, readOnly: args.read_only !== false,
   signal: exec.signal })`; the tool result is
   `[<bit name> · <backend>/<model> · <effort>]` + blank line + the report text, with
   `backend` = `claude-code` (subscription alias) or `dsh` (`<provider>/<model>`), exactly
   mirroring `resultRouteText` in `host/team-runtime.js`.
6. Coded errors stay model-visible; cancellation is not swallowed. `isConcurrencySafe: () => true`;
   `presentCall` returns a generic card titled `Bit delegate · <bit> · <model>/<effort>` when
   the target can be resolved cheaply from the existing bits/catalog, otherwise
   `Bit delegate`.
- The tool never touches the chat session's model/effort: each worker runs with its bit's
  preset model/effort.

### 12.5 Team-mode separation

`host/team-runtime.js` `resolve(agent)` returns `null` immediately for orchestrator-preset
sessions (`isOrchestratorSession(agent)`, helpers imported from `./orchestrator.js`), before any
binding lookup. Consequences:

- a preset chat in a repository whose team has `bindWorkspace` is **never** a team lead (or
  member): it gets no team prompt and no `team_delegate`/`team_handoff`;
- teams/flows remain the only multi-bit path (drawn flow, roles, access/launches, orchestrator
  members, handoff, harness guard/MCP/skills);
- no other team-runtime behaviour changes.

### 12.6 Diagnostics

`GET /api/bots.diagnostics` (§7) gains an `orchestrator` key:

```json
{
  "orchestrator": {
    "presetId": "bits-orchestrator",
    "installed": [{ "sessionId": "<agent/session id>", "tools": ["bit_delegate"] }],
    "errors": [],
    "notes": []
  }
}
```

`installed` lists the agents currently instrumented (with the tools registered on them);
`errors` and `notes` are timestamped lists (installation/hook failures and advisory notes such
as a duplicate bit name). When the runtime failed to install, `index.js` answers the same shape
with an empty `installed`. It is the first stop for "the chat in orchestrator mode has no
`bit_delegate`".

### 12.7 Tests

- **New `test/orchestrator.test.mjs`** (plain `node`, no npm deps; real `BitStore` +
  `loadBitCatalog` in a temp `botsRoot`, fake host `ctx` and fake `bitRuntime.invokeWorker`):
  `presetIdOfSession`/`isOrchestratorSession`; install on a `bits-orchestrator` session
  registers one prompt section and one `bit_delegate` tool (a standard session gets nothing);
  prompt content (role, delegation rules, read-only default, roster group headings, several
  names with their preset model/effort, orchestrator characters excluded); delegation by
  existing bit id and by name (the invocation receives that bit, the session cwd and
  `readOnly: true` by default / `false` when requested; header matches the meta); catalog
  character by name and by id (creates exactly one bit with the catalog preset
  model/effort/emoji/color/instructions, second delegation reuses it, concurrent delegations
  dedupe); existing custom bit for the same character reused with its own model/effort;
  orchestrator-character target → coded `BIT_IS_ORCHESTRATOR` (no bit created); unknown bit →
  coded error; diagnostics lists the installed session and `dispose()` clears it.
- **`test/team-runtime.test.mjs`** — additive test: a `bits-orchestrator` session in a
  `bindWorkspace` repository is not resolved as team lead and gets no team tools.
- **`test/e2e-web.mjs`** — final section (10/10) in the throwaway profile over the authenticated
  HTTP bridge: `agentPresets/list` contains `bits-orchestrator` named `Bit mode`, with
  `isDefault: false`, no `broken` and the builtin `standard` preset still the default;
  `session/create` with `agentPreset: 'bits-orchestrator'` returns the preset and a session id;
  `session/prompt` is accepted and `/api/bots.diagnostics` eventually lists the session under
  `orchestrator.installed` with `bit_delegate` and empty `errors` (a model-call failure in the
  throwaway profile is irrelevant: admission and activation are what matters).
- All suites of §10 stay green; `node --check` on every touched JS file.

### 12.8 Files of this increment

| file | change |
|---|---|
| `host/orchestrator.js` | **new**: preset constant/detection, prompt section, `bit_delegate` tool, diagnostics, dispose |
| `index.js` | install the runtime after `createBitRuntime`, `orchestrator` diagnostics key, teardown dispose |
| `host/team-runtime.js` | `resolve()` skips orchestrator-preset sessions |
| `cordis.patch.yml` | second insert row `preset-bits-orchestrator` (standard child list copy) |
| `test/orchestrator.test.mjs` | **new** unit suite |
| `test/team-runtime.test.mjs` | additive preset-session test |
| `test/e2e-web.mjs` | preset roster, preset session and installed-orchestrator section |
| `README.md` | "Chats in orchestrator mode" |

No `package.json` dependency or version change; no client/route/UI change beyond the diagnostics
payload. The bits created on demand by `bit_delegate` are normal v5 bits (store record of §2):
they appear on the Bits page and can be used in flows like any other bit.


---

## 13. Bit mode: orchestrating-bit selector (v5.2)

**This section extends v5.1**; sections 0–12 keep their meaning. The displayed chat-mode name
becomes **Bit mode** (preset id unchanged: `bits-orchestrator`), and, while that preset is the one
selected for a new session, the new-session hero shows a second chip beside the mode chip that
picks **which bit orchestrates** the chat. The chosen bit contributes its instructions to the
orchestrator prompt; it never changes the chat's model or reasoning effort.

### 13.1 Selection store (`host/orchestrator-selection.js`)

`createOrchestratorSelection({ botsRoot, bits, catalog, log })` → an object with
`init()`, `ready`, `currentBitId()`, `currentBit()`, `candidates()`, `viewFor(bit)`,
`select(target)` and `dispose()`.

- Durable preference `<botsRoot>/orchestrator.json`, mode 0600, atomic write (temporary sibling
  + fsync + rename), document `{ version: 1, bitId: string | null }`. A missing file starts
  empty; a corrupt document is renamed aside and starts empty (same policy as the stores).
- The preference is **global**: every Bit-mode chat uses the current selection. It is read when
  the prompt text is composed (per turn), so edits to the selected bit on the Bits page apply to
  the next turn.
- `select(target)` resolves, in order: an existing bit by exact id; an existing bit by
  case-insensitive name; a catalog character by exact id or case-insensitive name. A catalog
  character with no bit yet is provisioned through `bits.create` with the catalog defaults
  (`name`, `character`, `emoji`, `color`, `instructions`, `isOrchestrator`, `model`, `effort`),
  reusing an existing bit for that character when present. The resolved record must have
  `isOrchestrator === true`, otherwise a coded `BIT_NOT_ORCHESTRATOR` is thrown; an unknown
  target is a coded `BIT_UNKNOWN`. `select(null)` clears the preference.
- `candidates()` = existing orchestrator bits (store order) then catalog orchestrator characters
  not represented by an existing bit (catalog order); cap 50. A candidate view is
  `{ id, target, name, character, emoji, color, avatar, summary, model, effort, isExisting }`:
  `avatar` = `/api/bots.avatar?id=<character id>` when a catalog character is known, else
  `/api/bots.avatar?id=<bit id>` (the client falls back to the emoji); `summary` = catalog
  `summary.en` else the first sentence of the instructions, capped at ~160 chars; `target` is the
  value the client posts back (`id`).

### 13.2 Routes (`host/routes.js`)

Registered only when `registerBotRoutes` receives `deps.selection` (older fixtures keep working):

- `GET /api/bots.orchestrator` → `{ ok: true, bitId, bit, candidates }`.
- `POST /api/bots.orchestrator` `{ target }` (`target` is a trimmed non-empty string, or
  `null`/omitted to clear) → the same payload after `select(target)`.
- Both handlers await `selection.ready`; coded store errors pass through the envelope; bad bodies
  are `BAD_REQUEST`; a failed store initialization is `ORCHESTRATOR_UNAVAILABLE`.

### 13.3 Prompt (`host/orchestrator.js`)

The `bits:orchestrator` section stays `interpolate: false` and order 700, but its `text` is now a
function returning `buildPromptText(catalog, selection.currentBit())` (generic when the selection
is empty). The renamed base text keeps the v5.1 invariants (delegation rules, worker roster, work
split, model/effort untouched). With a bit, the section inserts, right after the intro paragraph:

```markdown
## Orchestrating bit: <name>

<catalog summary, when present>

<the bit's instructions>
```

`installOrchestrator` accepts `selection` optionally; without it the prompt is the generic one.
`diagnostics()` reports `selection.bitId`. `index.js` builds the store next to the bit store,
passes it to the runtime and the routes, and disposes it on teardown.

### 13.4 Client (`client.js`)

A `ModeBitSeat` component registers into the existing `conversation.hero.options` list slot
(`conversation.hero.agentPreset` is single-owner, so the new chip uses the options list of the
same hero row and removes its right-alignment with
`div:has(> [data-slot="conversation.hero.options"]) { margin-left: 0; }`). It reads the current
preset from the session list projection (`projectionValues.agentPreset`) and renders only for
`bits-orchestrator`. The chip shows the selected bit's avatar + name (or "Choose bit"); the menu
shows rows with a 32px avatar, name and the 2-line English description, plus a first
"No specific bit" row that clears the selection. Picking calls `POST /api/bots.orchestrator` and
updates the chip; loading/error/empty/busy states are handled inline. The component brings its
own `<style>` (the page token block does not apply outside the Bits page) and its own defensive
`GET /api/bots.orchestrator` load; an older host without the routes makes the chip render
nothing.

### 13.5 Tests

- `test/orchestrator.test.mjs`: renamed heading, generic vs. bit prompt, dynamic text between
  turns, no model/effort selection.
- `test/orchestrator-selection.test.mjs` (or additions to `test/routes.test.mjs`): store
  persistence/corrupt-file/validation/provisioning/candidates, and both routes' payloads and
  coded errors.
- `test/visual.mjs`: hero scenario — pick **Bit mode**, assert the chip appears right of the mode
  chip (geometry), the menu rows carry avatars and descriptions, picking a catalog orchestrator
  provisions the bit and the chip/GET reflect it; screenshots saved under `test/screenshots/`.
- `test/e2e-web.mjs`: Bit-mode name assertions (updated) and the selection routes against the
  throwaway profile.

### 13.6 Files of this increment

| file | change |
|---|---|
| `host/orchestrator-selection.js` | **new**: durable orchestrating-bit preference, candidate views, provisioning |
| `host/orchestrator.js` | dynamic prompt text with the selected bit; renamed heading |
| `host/routes.js` | `GET`/`POST /api/bots.orchestrator` |
| `index.js` | build/pass/dispose the selection store; diagnostics |
| `client.js` | hero chip + picker, styles, placement rule, API helpers, EN strings |
| `cordis.patch.yml` | preset display name `Bit mode` |
| tests / docs | renamed assertions, new store/route/visual coverage, README / this section / REVIEW addendum |
