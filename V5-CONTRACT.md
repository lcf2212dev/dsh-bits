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
  **Executar** (ad-hoc worker invocation: request → response). Orchestrators execute inside
  a flow (Times tab → execute the flow), not ad-hoc.
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
   - Display labels: `Claude Opus 5.5 (assinatura)`, `Claude Sonnet 5.5 (assinatura)`,
     `Claude Haiku 5.5 (assinatura)`.
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
      "instructions": "Contexto do bit (persona/briefing)...",
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
    "role": "Implementa a partir dos testes vermelhos",
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
  "name": "Engenharia (Claude Code)",
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
  (roles, access, launches), flow, name/description and the lead role ("Orquestrador" /
  coordinator). Worker bits get their roles from the current member `role`; the lead bit
  keeps its current lead instructions.

### 5.3 Harness → team (`teamFromPack` in host/harness-routes.js)

Returns `{ bits, team }` instead of a team with embedded members:
- One bit per harness preset: `name` = preset name, `character` = mapped catalog bit,
  `instructions` = preset instructions, `isOrchestrator: false`, model/effort = catalog
  defaults for the character (fallback `subscription/sonnet` / preset effort when it is a
  valid CLI effort, else `high`).
- Lead bit: `name: "Orquestrador"`, `character: "bit-coordinator"` (or null when missing),
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
  `BIT_IS_ORCHESTRATOR` ("orquestradores executam em fluxos"). `request` is 1..20000 chars.
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
- `team-guard.js`: tool policies for agent bindings stay; wording changes from "membro" to
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

Keep the single-file React-via-module-loader style. Tabs: **Bits**, **Times**, **Projetos**.

Bits tab:
- Cards: avatar, name, character name, group, badges `Orquestrador`/`Worker` and
  `<model label> · <effort>`; no VM badge/status.
- New bit: catalog gallery unchanged, but the form now shows `isOrchestrator` (toggle),
  `Modelo` (select from `/api/bots.models`) and `Esforço` (select), pre-filled from the
  chosen catalog bit; "Restaurar descrição padrão" stays.
- Editor validates: orchestrator → only `routes` models (dsh); toggling isOrchestrator
  snaps the model to a valid default of the new family when the current one is invalid.
- Bit detail: no "Conversar", no VM controls. Workers get **Executar**: a dialog with a
  request textarea, a "somente leitura" toggle (default on), run button with busy state,
  response panel (and error). Orchestrators show "Executa em fluxos (aba Times)" plus the
  teams where the bit is the lead, if any.
- Remove every VM string/section/poll (`/api/bots.images`, `/api/bots.vm`, docker hints),
  the notify-test bell, and chat buttons.

Times tab:
- Member editor: pick the bit (select from `/api/bots.list`, grouped by catalog group),
  then edit `role`, `access`, `launches`, `teamRef`, `mcp`, `skills`; the bit's model/effort/
  isOrchestrator shown read-only (link "editar bit" if easy). Remove model/provider/effort/
  character/instructions inputs from members.
- Lead selector lists only members whose bit is an orchestrator; if the current lead is not
  one, show the error inline.
- Templates: creating a team from a template calls `POST /api/bots.teams.fromTemplate`.
- "Enviar pedido" / run: use `POST /api/bots.teams.run` (auto-started mission) instead of
  pre-filling a session draft; show a busy state and the created session when it returns
  (open it if the UI allows, like the previous flow).
- Flow editor itself (nodes, edges, groups, drag, undo, save) is unchanged.

Projects tab: unchanged except team cards may show the lead bit name.

Locale: update `client.js`'s embedded pt/en dictionaries (it has both) and
`locale/{pt,en}.json` metadata (title/description = Bits/flows).

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
