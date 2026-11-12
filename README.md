# Bits — workers that receive a request and return a response

A package (bundle) for the **DeepSeek Harness** Web interface that adds the **Bits** page:
definitions of AI workers with their own context, a model and a reasoning effort, that **run
in flows** (the teams) and return a response to whoever asked.

A bit is no longer a personal agent and does not use a virtual machine. It is a definition:

- **Context/instructions** — the role, the method, the limits and the report format;
- **`isOrchestrator`** — whether it is a flow orchestrator or a worker;
- **Model and effort** — chosen among the models available in a normal chat, and can be
  switched at any time in the editor.

> Interface in English, code in English. Built for the `desktop` profile of this
> installation, but it works in any profile with the Web interface.

---

## How a bit runs

The execution mode comes from `isOrchestrator`:

| | **Orchestrator** (`isOrchestrator: true`) | **Worker** (`isOrchestrator: false`) |
|---|---|---|
| What it does | Runs a **team flow**: understands the request, decides the order, delegates steps and returns the final report. | Receives **one request** (one flow step) and returns **one response**. |
| Where it runs | DeepSeek Harness agent, on a chat-route model (default **DeepSeek-V4.1-Flash**, effort **Max**). | One-shot invocation: by default in the **Claude Code of your subscription**, via the `claude_delegate` tool of the **`@dsh-burn-plugins/dsh-claude-delegate`** plugin (the "plugin we created"); or a single model call, if the bit is pointed at a chat route. |
| Tools | Has the Harness tools and delegates to the team members. | In subscription mode, runs with the Claude Code tools in the flow directory (read/edit/execute). In chat-route mode, returns text (no tools). |
| Memory | Flow session (durable). | None between calls: what the bit "remembers" is the `task`/context the orchestrator sends. |

The economic rule: **orchestrating is cheap and happens on the DeepSeek route; working uses
the subscription**. You can still change the model and effort of any bit — the editor lists
your chat models (profile providers/accounts) and the subscription ones.

## What each bit has

| Resource | How it works |
|---|---|
| **Context** | Name, emoji, color and permanent instructions: the role, the method, what never to do and the report format. |
| **Classification** | Orchestrator or worker (`isOrchestrator`), with the default coming from the character chosen in the catalog. |
| **Model/Effort** | Model and reasoning effort, editable; defaults per character in the catalog. |
| **Workspace** | Its own directory (`$DSH_HOME/bots/<id>/workspace`), used as the working directory when the bit is run standalone. In flows, the directory is the team's. |
| **Run** | Workers can be run standalone on the page: you write a request (with a **read-only** option) and see the response. Orchestrators run inside a flow. |

## Bits: the characters

Every bit is born from a **catalog bit**, one of the 53 illustrated characters
(`bits/catalog.json` + `bits/avatars/*.webp`). When you click **New bit**, the page opens the
gallery (with search by function, name or skill, accent-insensitive). The form already comes
with name, description, **orchestrator/worker**, **model** and **effort** suggested for that
role; everything can be changed. **Restore default description** goes back to the original
text.

| Group | Bits |
|---|---|
| General | Bit (mascot, generic worker) |
| Management & product | Manager, Product Owner, Coordinator, Sub-coordinator (orchestrators), Systems Analyst, Product Analyst, User Researcher |
| Workers (tasks) | Scout, Researcher, Architect, Builder, Runner, Reviewer, Debugger, CI Triager, Writer |
| Quality & testing | QA, Web Tester, Android Tester, iOS Tester |
| Engineering | Frontend, Backend, Android, iOS, Flutter, React Native, Cloud, SRE, Deployer, Integration, Performance, Database, Data Engineer, Data Scientist, LLM, Cybersecurity |
| Design | UX Designer, UI Designer, Design System Expert, Accessibility Expert, Pixel Artist |
| Business & growth | Growth Marketer, SEO Expert, Copywriter, i18n / Localization, CRM Specialist, Sales, Sales Assistant, Customer Success, Support, Finance Analyst, Privacy & Compliance |

The descriptions follow the Claude Code agents format (`~/.claude/agents`): one sentence with
the role, the method and the limits, ending with the report format ("Report back with …").
Because a worker runs one shot with nobody to answer questions, the descriptions of the
longer-running workers tell them to finish the whole task, and a worker names in the report
the bit that should take work outside its scope — a worker cannot call another bit. The
catalog also stores the **default model/effort** of each character and which ones are
**orchestrators** (the four coordination roles), so that a flow works well from the first use.

### Model and effort presets

The presets follow Anthropic's guidance for the current lineup
([models overview](https://platform.claude.com/docs/en/models/overview),
[effort](https://platform.claude.com/docs/en/build-with-claude/effort)):

- **Fable 5.2** (`subscription/fable`) is the most capable and most expensive model, worth it
  on ambiguous, long-horizon work. The Architect and the Debugger run it at `high`, the
  documented starting level; `xhigh` only where a measured gain justifies its cost, and `max`
  to measure the ceiling rather than as a default.
- **Opus 5.5** runs at `medium` — its default, which matches Opus 5 at `high` — for
  document-shaped work (specification, SRE process, privacy review), and at `high` where
  precision matters: review, data science, databases, LLM evals, performance. Cybersecurity
  stays on Opus at `xhigh`: Fable costs twice as much there and flagged security requests are
  rerouted to an older Opus anyway, and the deepest level is kept because a missed
  vulnerability costs more than the extra tokens.
- **Sonnet 5.5** runs well-specified implementation and test writing at `medium`, and
  specialist engineering, research and analysis at `high`, where the orchestrator acts on the
  report without re-checking it.
- **Haiku 5.5** keeps `low` only for the Runner (purely mechanical execution). The Scout runs
  at `medium`, because Haiku at `low` tends to skip searches and a false "not found" derails
  the flow; the bits bound by strict rules and knowledge work — Support, Sales Assistant, CRM
  Specialist — run at `high`, where Haiku follows instructions closely at a fraction of
  Sonnet's price.

## Teams and flows

A **team** groups bits into roles (members) and draws the flow as an editable graph (nodes +
arrows). The **Teams** page has the visual editor: drag to move, connect steps, group phases,
add decisions and pauses, undo and save.

- **Members = bits.** Each member points to a bit (the same bit can be used in several
  flows). The member stores what is specific to the flow: role, access (read/write), who it
  can launch, referenced team, MCP and skills.
- **Lead = orchestrator.** Only a bit with `isOrchestrator: true` can lead a team: it receives
  the request and runs the flow. The editor only offers orchestrators in the lead list.
- **Worker = request → response.** The lead calls the worker with a self-contained task; the
  worker runs as a one-shot invocation and returns the report. That is why the worker does not
  "remember" the previous step: the lead sends all the necessary context.
- **Orchestrator member** (e.g., a member that represents another team) runs as a child agent,
  with its own route model, and can delegate again.
- **Send request** runs the flow: it opens the team session in the repository, delivers the
  request to the lead and follows the work. The lead can hand the session over to another team
  (`team_handoff`) when the request belongs to another flow.

### Team models

The Teams page includes ready-made models (`bits/teams/*.json`, e.g. **Engineering (Claude
Code)**) and lets you turn a harness imported from a repository into a team. The
**Engineering** model creates a team with an orchestrator and the Claude Code workers (scout,
researcher, architect, builder, debugger, reviewer, writer, runner, CI triager…), already
with roles, access and a reviewed TDD flow.

## Projects

The **Projects** tab groups teams by product/repository. A project can contain shareable
teams (which also appear in the Teams tab) and internal teams. Deleting a project unlinks the
teams first, without deleting them.

## Executable teams and harness

A team with a **lead**, a **repository** and (optionally) a **harness package** really runs in
DeepSeek Harness:

- **Transpiled harness:** the **Harness** button in the Teams tab imports a repository's
  harness (GitHub Copilot / Claude Code style: `AGENTS.md`, `.github/agents`,
  `.github/skills`, `.github/instructions`, `.github/hooks`, `.github/scripts`, `.mcp.json`)
  to `<botsRoot>/harness/<id>/`. The repository may even no longer have the harness: the team
  carries it. The commands in the texts then point to the package, and anchored patches make
  the scripts work from outside the repository (`DSH_HARNESS_PACK_ROOT`).
- **Create team from this harness** generates a team with an orchestrator and one bit per
  preset (persona, model, effort, read-only, who each one can launch and the skills it reads
  beforehand).
- **Lead:** the one that receives the request. With **Every session in this workspace belongs
  to the team** enabled, every session opened in the repository (including `worktrees/…`)
  belongs to the lead. A read-only lead only orchestrates: it has no terminal, write, search
  or web, and only reads the harness package and `.dsc/` files.
- **Delegation:** the lead calls `team_delegate({ member, task })`; the worker runs the
  one-shot invocation (subscription/chat route) and the final report comes back as the result.
  An orchestrator member runs as a child agent. A member only launches those in "can launch".
- **Handoff:** `team_handoff` hands the entire session over to the lead of another team.
- **Guard:** before each tool of each team agent, the harness's own hook runs (the
  `git-guard.cjs`, in the Claude Code event format), with `--read-only` for read members. The
  denial reaches the model as "Repository rule: …". Workers run on the subscription in
  read-only mode receive `--permission-mode plan` from Claude Code.
- **Context:** `AGENTS.md` rules, conduct, roster, the **drawn flow** (in text, in phase
  order), Copilot → DeepSeek Harness glossary, skills and the `applyTo` instructions, attached
  when a matching file is read or edited.
- **MCP:** the package's `.mcp.json` servers are mounted only on the marked members.

## Chats in Bit mode

Installing the plugin also adds a selectable chat mode, **Bit mode**. It appears with
the other presets under **Settings → presets** and in the preset picker of a new session; it is
not made the profile default, so you choose it per chat. A session in this mode is a normal
chat (the standard preset's tools, skills, plan mode and compaction) plus the orchestration
prompt and one extra tool, `bit_delegate`. Install or update the bundle while the app is
running and the mode appears when the profile recomposes (the plugin manager applies it live
with HMR); without HMR it appears after the app restarts.

A chat keeps the mode it was created with, but DSH also lets you pick a preset for a session
that has not started its first turn yet: choose **Bit mode** for an existing, still-empty chat
and it runs in Bit mode from its first message (the plugin reads the recorded selection, not the
frozen creation header). Switching back to a normal mode before the first message removes the
orchestration prompt and `bit_delegate` again.

With **Bit mode** selected, a second chip appears right next to the mode chip: it picks **which
bit orchestrates** this chat. The menu lists the orchestrator bits (avatar, name and the short
English description); picking a catalog orchestrator character provisions its bit on first use,
like a delegation does. The chosen bit's instructions become the chat's persona at the next
turn — pick **No specific bit** to keep the generic orchestrator prompt. The choice is stored in
`<botsRoot>/orchestrator.json` and shared by every Bit-mode chat; it never changes the chat's
model or effort.

In a conversation that is already open, the same picker is not hidden: the compact chip sits in
the session header right after the read-only **Bit mode** label, so you can see which bit is
orchestrating and switch it at any point. The switch applies from the next turn (the prompt is
rebuilt per turn) and still does not touch the session's preset, model or effort.

The chat's own model and reasoning effort are the ones you select in the composer. The mode
never pins or overrides them: the chat only orchestrates, and the bits it delegates to run with
their own preset model and effort.

`bit_delegate({ bit, task, read_only })` runs **one worker bit, one-shot** (request →
response):

- `bit` — a catalog character (`Builder`, `bit-builder`) or the name/id of an existing bit.
- `task` — the self-contained task. The bit does not see the conversation, so include the goal
  and done criteria, the workspace, the context, the files, the constraints and the report
  format.
- `read_only` — defaults to `true` (no edits and no commands that need approval); pass
  `read_only: false` for a task that changes files or runs commands in the workspace.

The bit runs in the chat's working directory and returns a text report, which the chat receives
as the tool result. Independent delegations can be issued in the same response and run in
parallel. Each catalog character already carries a preset model and reasoning effort: the first
delegation to a character **creates that bit automatically** with its catalog preset, and later
delegations reuse it (with any model/effort/instructions edits made on the **Bits** page). The
four orchestrator characters of the catalog (Manager, Product Owner, Coordinator,
Sub-coordinator) — and any bit marked as an orchestrator — cannot be delegated: the chat itself
is the orchestrator, so delegate to worker bits.

The difference from a team is deliberate and is the reason to keep both paths:

| | **Chat in orchestrator mode** | **Team (executable flow)** |
|---|---|---|
| Who decides the steps | The chat, per request | The drawn flow and the lead |
| Bits involved | Any worker bit (catalog or existing), one-shot; catalog bits are created on first use | The team members, with role, access and launches |
| Route of the coordinator | Your session model/effort | The lead bit |
| Team-mode tools | No `team_delegate`/`team_handoff` (the global `team_send` stays visible like in any non-team chat) | `team_delegate` and `team_handoff` |
| Nested orchestration | No: one level of one-shot workers | Orchestrator members |
| Harness guard, MCP, skills | No | Yes, from the harness package |
| Session | The chat's own session and working directory; never bound to a team | Sessions bound to the team (`bindWorkspace`) |

A chat in orchestrator mode is never treated as a team lead, even in a repository where every
session belongs to a team. The bits it creates from the catalog are normal bits: they appear on
the **Bits** page, can be run standalone and can be reused in flows.

The Bit mode prompt also spells out the **delegation policy**: keep planning, brief writing,
integration and the user-facing answer in the chat and delegate the work itself — research and
recon to **Scout**, plans to **Architect**, implementation to **Builder** or the matching
specialist (the **Pixel Artist** character for pixel-art game visuals, the engineer bits for
their platforms), mechanical commands to **Runner** — and verify non-trivial deliveries with a
**different bit than the author**: the final review to **Reviewer** and the tests to **QA** /
the tester bits when the project has no automated gate. A review by the bit that wrote the
change is not independent. The bundled **Coordinator** persona repeats the policy. To audit a
real mission afterwards, use the smoke checker `test/bit-usage.mjs` (below): it lists which bits
were delegated and can fail when the required roles were not used.

## How to use

1. Click **Bits** in the sidebar (robot icon). The page lists the bits created in this profile
   and, below them, **All bits**: every character of the shipped catalog (53) that does not have
   a bit yet, with its avatar, role, group and preset model/effort. **New bit** on one of those
   cards opens the create form prefilled from that character, so all bits are visible and usable
   without hunting through the gallery first.
2. **New bit**: choose a character, adjust name/description and decide **orchestrator** or
   **worker**, **model** and **effort**.
3. **Run** (workers): write a request, choose whether it is read-only and see the response.
4. **Teams** tab: create a team from scratch or from a model/harness, add bits as members,
   choose the orchestrator lead and draw the flow. **Send request** runs it.
5. **Projects** tab: group the teams by product.
6. **New chat**: choose the **Bit mode** preset, pick the bit that orchestrates in the chip
   next to it, and delegate tasks to any bit from the conversation (see **Chats in Bit mode**).

## Requirements and the subscription plugin

- Profile with the Web layer (`@deepseek-ai/dsh-web-app`).
- For workers in subscription mode: the **`@dsh-burn-plugins/dsh-claude-delegate`** plugin
  installed in the profile and **Claude Code** installed and logged in on the machine
  (`claude` in the Harness PATH). That plugin exposes the `claude_delegate` tool (model and
  effort per call); the Bits bundle invokes it through the Harness tool pipeline, without
  importing the package.
- Without the plugin, workers pointed at the subscription fail with a clear message
  (`BIT_DELEGATE_UNAVAILABLE`); workers pointed at a **chat route** keep working as a single
  model call.
- **Worker reports are not replaced by background-task notices.** That plugin reads Claude
  Code's `stream-json` result events and returns the answer of the task itself, so a shell
  command that finishes after the worker answered can no longer turn the report into a short
  "the background task finished" acknowledgement. Use
  `@dsh-burn-plugins/dsh-claude-delegate` **≥ 0.2.1** (the version that selects the real
  result); older builds print the last `result` of the CLI run, which is that acknowledgement.
- **`fable`** (`Claude Fable 5.2 (subscription)`, the default of the Architect and Debugger
  characters) needs `@dsh-burn-plugins/dsh-claude-delegate` **≥ 0.1.1** (the version that
  accepts the alias) and **Claude Code ≥ 2.1.321**;
  older CLIs resolve `fable` to an earlier Fable, and depending on the plan it bills usage
  credits instead of the included limits. Any worker bit can be re-pointed to it, or away
  from it, on the Bits page; orchestrators need a DSH chat route.
- There is no longer a Docker dependency.

## How to install / update

The bundle is already installed in the profile by the session Lead via **Plugins → Add
plugin** (or the Harness plugin manager). To install it in another profile:

```bash
# in the interface: Plugins → Add plugin → absolute local path
# or, on the CLI, with an install target:
dsh plugin --profile <profile> add /path/to/bots-plugin
```

## Configuration

The bundle patch (`cordis.patch.yml`) accepts, on the `bots` line, an optional `config`:

```yaml
- insert:
    - id: bots
      name: '@dsh-burn-plugins/dsh-bots'
      config:
        botsRoot: /absolute/path/to/bits   # default: $DSH_HOME/bots
```

Bits live in `<botsRoot>/bits.json`, teams in `<botsRoot>/teams.json`, projects in
`<botsRoot>/projects.json` and harness packages in `<botsRoot>/harness/`. Each bit has
`<botsRoot>/<id>/workspace`. Atomic writes, mode 0600.

## Migration from the previous version

- An old `bots.json` (personal agents + VM) is converted to `bits.json`: the VM is discarded,
  `isOrchestrator`/model/effort come from the character catalog and the `workspaceDir` is
  kept. The old file is preserved as `bots.json.migrated-<date>`.
- An old `teams.json` (embedded members) is converted: each member becomes/uses a bit
  (deduplicated by character+name+instructions), the lead becomes an orchestrator
  (DeepSeek-V4.1-Flash Max) and the others use the catalog defaults. The old file is
  preserved as `teams.json.bak-<date>`.
- Old team sessions keep working: member ids are preserved.

## Architecture

```
bots-plugin/
├── index.js               # host plugin: stores, model catalog, runtimes, routes
├── host/
│   ├── store.js           # BitStore: durable bit registry (v4 migration)
│   ├── routes.js          # /api/bots.* (CRUD, catalog, models, run, avatar)
│   ├── catalog.js         # bit catalog (loading, validation, avatars)
│   ├── models.js          # model catalog: subscription + chat routes, resolution
│   ├── bit-runtime.js     # request→response: claude_delegate (subscription) or 1 call
│   ├── teams.js           # TeamStore: teams/flows (members reference bits)
│   ├── team-routes.js     # /api/bots.teams* routes and team models
│   ├── projects.js        # ProjectStore: projects that group teams
│   ├── project-routes.js  # /api/bots.projects* routes
│   ├── harness.js         # harness → package transpiler
│   ├── harness-routes.js  # package routes, team from package, run and diagnostics
│   ├── team-runtime.js    # executable teams: lead, delegation, handoff, skills, guard
│   ├── team-prompt.js     # lead and member texts (flow, roster, glossary)
│   ├── team-guard.js      # bridge to the harness hook and lead policies
│   ├── team-bindings.js   # session → team/member (durable)
│   ├── orchestrator.js    # chat preset runtime: orchestrator prompt, bit_delegate
│   └── orchestrator-selection.js  # Bit mode: which bit orchestrates (durable preference)
├── bits/
│   ├── catalog.json       # 53 bits: name, group, emoji, color, summary, description,
│   │                      #   isOrchestrator, default model and effort
│   ├── avatars/           # one 256×256 WebP avatar per bit
│   └── teams/             # team models (JSON)
├── client.js              # Web page (React via module loader, no JSX/imports)
├── cordis.patch.yml       # plugin line in the profile
├── locale/en.json         # bundle display metadata
└── test/                  # unit tests, runtime with fake host, E2E and visual
```

Flow of a team run: page → `/api/bots.teams.run` → `startMission` (session in the team
workspace, durable binding) → the orchestrator lead receives the request and calls
`team_delegate` → worker: `bit-runtime.invokeWorker` → `claude_delegate` (subscription) or a
chat route call → report back to the lead → final response to the dev.

Flow of a Bit-mode chat: new session with the `bits-orchestrator` preset → the hero chip stores
the orchestrating bit (`/api/bots.orchestrator`) → `host/orchestrator.js` adds the prompt (with
the bit's instructions when one is chosen) and the `bit_delegate` tool to that agent →
`bit_delegate` resolves (or creates from the catalog) the bit → `bit-runtime.invokeWorker` →
the text report comes back as the tool result.

## Tests

```bash
cd bots-plugin
node test/store.test.mjs        # bits: durable registry, validation, migration
node test/catalog.test.mjs      # catalog v2 (53 bits, orchestrators, default models)
node test/routes.test.mjs       # /api/bots.* routes (CRUD, catalog, models, run, orchestrator)
node test/teams.test.mjs        # teams: members by bit, orchestrator lead, migration, models
node test/projects.test.mjs     # projects and team unlinking
node test/harness.test.mjs      # transpiler and team from the harness
node test/team-runtime.test.mjs # runtime with fake host: lead, one-shot workers, guard
node test/orchestrator.test.mjs # chat preset: detection, prompt, bit_delegate, auto-provision
node test/orchestrator-selection.test.mjs # Bit mode picker: durable selection, provisioning, routes
node test/bit-runtime.test.mjs  # req→response: subscription, chat route, read-only
node test/bit-usage.mjs --self-test  # smoke checker for a real Bit mode mission (see below)
node test/e2e-web.mjs           # E2E: isolated profile + real Web host + routes + UI
node test/visual-teams.mjs --width 1440 --height 900   # flow editor in headless Chrome
node test/visual-projects.mjs --width 1440 --height 900 # Projects tab in headless Chrome
node test/visual.mjs --theme dark   # real screenshots (headless Chrome) in test/screenshots/
                                    #   (--theme light also supported)
```

**Smoke checker for a real mission:** run a Bit mode mission in the app, then

```bash
node test/bit-usage.mjs <session-id> --require Scout,Builder,Reviewer
```

It reads the session log (compressed or not), prints which bits were delegated, how many calls
each received, the errors, and any `spawn_teammate`/`subagent` use instead of a bit. With
`--require` it exits non-zero when a required bit was not delegated, so a mission can be gated
on the work split it was supposed to follow. `--self-test` runs the parser against a synthetic
session instead.

Example: a review-and-improve mission should delegate a recon brief to **Scout**, the change to
**Builder** (or **Pixel Artist** for pixel art), and the final review to **Reviewer**; running
`node test/bit-usage.mjs <session-id> --require Scout,Builder,Reviewer` then prints PASS. The
checker cannot force the model to choose those bits — the prompt and the Coordinator persona
ask for that split; the checker is the smoke test that proves a real mission followed it.

The E2E creates a temporary `DSH_HOME`, installs the bundle, starts the real Web host on a
free port, authenticates with the launch token and exercises the routes — it never touches
the active `desktop` profile. The bundle's independent review is in `REVIEW.md`.

## Diagnostics

`GET /api/bots.diagnostics` (authenticated) returns the registry path, the bits, the team
agents that received prompt/tools from the runtime, the orchestrator chats that received the
mode's prompt and `bit_delegate` (`orchestrator.installed`), the selected orchestrating bit
(`orchestrator.selection.bitId`) and the latest integration errors.
It is the first stop for "the team did not run" / "the worker failed" / "the chat has no
`bit_delegate`".

## Security and limits

- Orchestrators run as Harness agents, with the profile's tools and sandbox.
- Workers in subscription mode run in Claude Code with bypass permissions (or
  `--permission-mode plan` when the member is read-only), in the flow directory.
  Claude Code does **not** apply the Harness tool restrictions: the effective limit is the
  working directory + the permission mode.
- Workers in chat-route mode make a single model call, without tools.
- The orchestrator receives the worker's text; structured outputs are best effort.
- A worker run can take a while (Claude Code works until it finishes); the route accepts
  cancellation through the HTTP request and has a 15-minute limit.
- Harness secrets are not passed to Claude Code beyond the host environment (the subscription
  plugin isolates the API credentials so the OAuth login applies).
- A chat in orchestrator mode runs with the session's own model/effort and the profile's tools;
  its delegations are read-only by default (`--permission-mode plan` for subscription workers),
  and `read_only: false` grants the bypass described above.
- Deleting a bit removes the registry entry and, optionally, the workspace; directory removal
  is refused if the path escapes `botsRoot`.
