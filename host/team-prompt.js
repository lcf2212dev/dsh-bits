/**
 * Prompt text for runnable teams of bits (pure functions, no I/O).
 *
 * The lead and every orchestrator member get: who they are in the team (the
 * persona comes from the referenced bit's `instructions`), the roster, the
 * harness rules (AGENTS.md of the pack), a glossary that maps the original
 * Copilot/Claude harness vocabulary onto the DeepSeek Harness team runtime, and
 * the `applyTo` instruction index. The lead also gets the team flow (the graph
 * edited on the Bits page) rendered as ordered text.
 *
 * Worker bits (`isOrchestrator: false`) never render a team prompt: they are
 * single-shot invocations whose prompt is composed by `host/bit-runtime.js`.
 *
 * @module host/team-prompt
 */

const TYPE_TEXT = {
  start: 'Start',
  end: 'End',
  step: 'Step',
  decision: 'Decision',
  pause: 'PAUSE (dev)',
  note: 'Note',
  team: 'Other team',
  group: 'Phase',
}

const EDGE_TEXT = {
  flow: '',
  loop: ' (loop/fix)',
  delegate: ' (delegation)',
  handoff: ' (handoff to the other team)',
}

function sizeOf(node) {
  if (node.type === 'group') return [node.w || 360, node.h || 420]
  if (node.type === 'note') return [node.w || 232, node.h || 128]
  if (node.type === 'start' || node.type === 'end') return [184, 48]
  if (node.type === 'decision' || node.type === 'pause') return [216, 60]
  return [236, 72]
}

function inside(group, node) {
  const [gw, gh] = sizeOf(group)
  const [w, h] = sizeOf(node)
  const cx = node.x + w / 2
  const cy = node.y + h / 2
  return cx >= group.x && cx <= group.x + gw && cy >= group.y && cy <= group.y + gh
}

const byPosition = (a, b) => (a.y - b.y) || (a.x - b.x)

/** Reading order for groups: rows (by y band), then columns. */
function groupOrder(a, b) {
  const band = 120
  const rowA = Math.round(a.y / band)
  const rowB = Math.round(b.y / band)
  return rowA - rowB || a.x - b.x
}

/** Display name of a bit referenced by a member (falls back to the member id). */
export function bitNameOf(bit, member) {
  const name = bit && typeof bit.name === 'string' ? bit.name.trim() : ''
  if (name !== '') return name
  return member && typeof member.id === 'string' ? member.id : 'bit'
}

/** Persona/context text of a bit (empty when missing). */
export function bitInstructionsOf(bit) {
  return bit && typeof bit.instructions === 'string' ? bit.instructions.trim() : ''
}

/** Backend family of a bit's stored model. */
export function backendOf(bit) {
  if (bit && bit.isOrchestrator === true) return 'dsh'
  const model = bit && typeof bit.model === 'string' ? bit.model.trim() : ''
  if (model.startsWith('subscription/') || model === 'fable' || model === 'opus' || model === 'sonnet' || model === 'haiku') return 'claude-code'
  return model === '' ? '?' : 'dsh'
}

/** `backend · model · effort` text shown in the roster. */
export function modelTextOf(bit) {
  if (!bit) return '—'
  const backend = backendOf(bit)
  const model = typeof bit.model === 'string' && bit.model.trim() !== '' ? bit.model.trim() : 'default model'
  const effort = typeof bit.effort === 'string' && bit.effort.trim() !== '' ? bit.effort.trim() : 'default'
  return `${backend} · ${model} · ${effort}`
}

function memberBit(bitsById, member) {
  if (!member || !bitsById) return null
  return bitsById[member.bitId] || null
}

function memberLabel(member, bitsById) {
  if (!member) return 'no bit'
  return `${bitNameOf(memberBit(bitsById, member), member)} (\`${member.id}\`)`
}

/**
 * The team flow as ordered Markdown: phases (frames) in reading order, the
 * nodes inside each phase, then loose nodes; each node lists its outgoing
 * connections. Node ids are shown so connections can be followed.
 *
 * @param {Record<string, any>} team
 * @param {Record<string, any>} teamsById
 * @param {Record<string, any>} [bitsById] bit id → bit record
 * @returns {string}
 */
export function flowText(team, teamsById = {}, bitsById = {}) {
  const nodes = Array.isArray(team?.flow?.nodes) ? team.flow.nodes : []
  const edges = Array.isArray(team?.flow?.edges) ? team.flow.edges : []
  if (nodes.length === 0) return '(the team has no flow drawn yet)'
  const members = Object.fromEntries((team.members || []).map((member) => [member.id, member]))
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]))
  const outgoing = {}
  for (const edge of edges) (outgoing[edge.from] = outgoing[edge.from] || []).push(edge)

  const groups = nodes.filter((node) => node.type === 'group').sort(groupOrder)
  const placed = new Set()
  const lines = []

  const describe = (node) => {
    const label = node.label ? `«${node.label}»` : '«untitled»'
    let who = ''
    if (node.type === 'step') {
      const member = members[node.memberId]
      who = ` — ${memberLabel(member, bitsById)}`
      if (member && member.teamRef) {
        const other = teamsById[member.teamRef]
        who += ` → team ${other ? `«${other.name}»` : member.teamRef}`
      }
    }
    if (node.type === 'team') {
      const other = teamsById[node.teamRef]
      who = ` — team ${other ? `«${other.name}»` : (node.teamRef || '?')}`
    }
    const detail = node.detail ? ` ${node.detail.replace(/\s+/g, ' ').trim()}` : ''
    const out = [`- [${node.id}] ${TYPE_TEXT[node.type] || node.type} ${label}${who}.${detail}`]
    for (const edge of outgoing[node.id] || []) {
      const target = byId[edge.to]
      const targetText = target ? `[${target.id}] ${target.label ? `«${target.label}»` : TYPE_TEXT[target.type]}` : edge.to
      out.push(`  → ${edge.label ? `“${edge.label}”: ` : ''}${targetText}${EDGE_TEXT[edge.kind] || ''}`)
    }
    return out
  }

  for (const group of groups) {
    const children = nodes.filter((node) => node.type !== 'group' && node.type !== 'note' && !placed.has(node.id) && inside(group, node)).sort(byPosition)
    lines.push('', `### ${group.label || 'Phase'}${group.detail ? ` — ${group.detail}` : ''}`)
    for (const node of children) {
      placed.add(node.id)
      lines.push(...describe(node))
    }
  }
  const loose = nodes.filter((node) => node.type !== 'group' && node.type !== 'note' && !placed.has(node.id)).sort(byPosition)
  if (loose.length > 0) {
    lines.push('', '### Outside the phases')
    for (const node of loose) lines.push(...describe(node))
  }
  const notes = nodes.filter((node) => node.type === 'note').sort(byPosition)
  if (notes.length > 0) {
    lines.push('', '### Notes')
    for (const note of notes) lines.push(`- **${note.label || 'Note'}:** ${String(note.detail || '').replace(/\s*\n\s*/g, ' ')}`)
  }
  return lines.join('\n').trim()
}

/**
 * Roster as a Markdown table: each member's bit name, role, access, backend,
 * model/effort and what it may launch / read first.
 *
 * @param {Record<string, any>} team
 * @param {Record<string, any>} [teamsById]
 * @param {Record<string, any>} [bitsById] bit id → bit record
 * @returns {string}
 */
export function rosterText(team, teamsById = {}, bitsById = {}) {
  const rows = ['| bit (member `id`) | role | backend · model · effort | access | may launch | read first |', '|---|---|---|---|---|---|']
  for (const member of team.members || []) {
    const bit = memberBit(bitsById, member)
    const other = member.teamRef ? teamsById[member.teamRef] : null
    const lead = member.id === team.lead ? ' **(lead)**' : ''
    const name = other ? `team «${other.name}»` : bitNameOf(bit, member)
    const role = other ? (member.role || other.description || '') : member.role
    const route = other ? '—' : modelTextOf(bit)
    const access = other ? '—' : member.access === 'read' ? 'read-only' : 'read and write'
    const launches = member.launches && member.launches.length ? member.launches.map((id) => `\`${id}\``).join(', ') : '—'
    const skills = member.skills && member.skills.length ? member.skills.map((name) => `\`${name}\``).join(', ') : '—'
    rows.push(`| ${name} (\`${member.id}\`)${lead} | ${String(role || '').replace(/\|/g, '/')} | ${route} | ${access} | ${launches} | ${skills} |`)
  }
  return rows.join('\n')
}

/**
 * `applyTo` instruction index of a pack.
 *
 * @param {Record<string, any> | null} pack manifest
 * @returns {string}
 */
export function instructionIndexText(pack) {
  const list = pack && Array.isArray(pack.instructions) ? pack.instructions : []
  if (list.length === 0) return ''
  const lines = [
    'When you read, create or edit a file matching one of these patterns, the instruction text is attached to the conversation automatically (once). Before editing, you can read it directly:',
  ]
  for (const item of list) {
    lines.push(`- \`${item.name}\` (${item.applyTo.join(', ')}): \`${pack.packDir}/${item.path}\`${item.description ? ` — ${item.description}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * Glossary: original harness vocabulary → this runtime.
 *
 * @param {'lead' | 'member'} role
 * @param {{ packDir?: string | null }} options
 * @returns {string}
 */
export function glossaryText(role, { packDir = null } = {}) {
  const common = [
    'The harness was written for GitHub Copilot (VS Code Agents window) and Claude Code. Here it runs as a **team of bits in the DeepSeek Harness**. Read the harness texts like this:',
    '- "preset", "subagent", "launch `x`", "`task` with `agent_type`", "`runSubagent`" → **team bit**: `team_delegate({ member: "x", task: "…" })`. The harness presets are the bits of the roster above. A **worker** bit (`isOrchestrator: false`) is a one-shot invocation: it does not see this conversation, runs in the flow workspace and returns only a text report — write the task self-contained (goal and done criteria, `<WT>`, what has already been decided, files, skills to read, prohibitions, return format), as the "How to write the prompt" section of the `subagent-routing` skill says.',
    '- An **orchestrator** bit (`isOrchestrator: true`) runs as a child agent with its own roster, flow and rules; its report comes back whole as the `team_delegate` result. Independent delegations can go in the same response (they run in parallel).',
    '- "the hook denies", "git-guard", "`--read-only`", "`--launches`" → the **team guard** runs the same harness `git-guard.cjs` before every tool of every agent (read-only mode applies to read bits, and invoking a read worker calls Claude Code with `readOnly`), and `team_delegate` only accepts the members listed in "may launch". The denial arrives as the error "Repository rule: …"; do not try to work around it.',
    packDir
      ? `- Harness \`.github/...\` paths (skills, scripts, hooks, instructions, agents, \`harness.json\`) and the \`AGENTS.md\` live in the **team pack** \`${packDir}\`, not in the repository; the commands in the texts already point there. The scripts still receive the WT via \`--dir <WT>\`, and the \`.env\` stays in the root of the main checkout.`
      : '- This team does not load a harness pack.',
    '- Skills: use the `skill` tool with the name (it returns the base directory; `references/` and `scripts/` live in it).',
    '- MCP: the harness `.mcp.json` servers only exist in the bits configured for them (tools `mcp__<server>__*`). Without the tool, follow the alternative path in the skill (e.g. REST script) or return the case.',
    '- "Copilot Fusion", "Local harness", "Customizations", "This Computer"/"Branch mode", MCP `dsc-files` and the absence of `create`/`edit` do not apply: every bit with write access has `write` and `edit`.',
    '- Models and effort ("Claude Opus 5.5 (subscription)", `reasoning-effort`) are already configured in each bit of the roster; do not pass them in the delegation.',
  ]
  if (role === 'lead') {
    common.push(
      '- "main session" → **this session**, the session of the team lead. You only orchestrate: the terminal, write, search and web tools are out of your reach, and the guard only lets you read the harness pack and `.dsc/` files.',
      '- "PAUSE" → ask the dev with the options and a recommendation and **end the response** (or use `ask_user_question`). Do not keep going assuming the answer.',
      '- "Where to run": `create-wt` and `open-wt` do **not** ask for a new session. Once a bit creates (or finds) the WT, change the directory of this session to `worktrees/AB-<n>` with `working_directory` and continue in this session; the worker bits you launch inherit that directory. `work-here` and `operate-from-root` stay as they are. `pause` remains PAUSE.',
      '- Another flow (another team of the roster or of the flow): `team_handoff({ team: "<team member id or team name>", request: "literal request + what is already known" })` passes **this session** to the lead of that team. To use another team as a step and receive the report back (e.g. validation), delegate to the member that represents it with `team_delegate`.',
      '- A message that starts with `[Team: <name>]` was sent by the Bits page to that team: pass the session to it with `team_handoff` without doing anything else.',
    )
  } else {
    common.push(
      '- You are an **orchestrator** bit called by `team_delegate` and run as a child agent. "Return to the agent that called you" = put the question, with options and recommendation, in your final report and stop. You do not talk to the dev.',
      '- Your **final message is the report** that goes back to the caller: put everything that matters in it (`file:line`, pasted outputs, what you delegated and what came back). Intermediate messages do not arrive.',
      '- Operate in the directory received in the task (`git -C <WT>`, `yarn --cwd <WT>`, `--dir <WT>`).',
    )
  }
  return common.join('\n')
}

function section(title, body) {
  const text = String(body || '').trim()
  return text ? `## ${title}\n\n${text}` : ''
}

/**
 * Full prompt for the lead of a team (an orchestrator bit running in the
 * session the dev talks to).
 *
 * @param {{ team: any, member: any, bit?: any, bitsById?: Record<string, any>, teamsById?: Record<string, any>, pack?: any, rules?: string, conduct?: string }} input
 * @returns {string}
 */
export function leadPromptText({ team, member, bit = null, bitsById = {}, teamsById = {}, pack = null, rules = '', conduct = '' }) {
  const lead = member || { id: 'lead', name: 'Lead', skills: [] }
  const name = bitNameOf(bit, lead)
  const header = [
    `# Team of bits: ${team.name}`,
    '',
    `You are **${name}** (\`${lead.id}\`), lead of the team **${team.name}**${team.description ? `: ${team.description}` : '.'}`,
    team.workspaceDir ? `Team repository: \`${team.workspaceDir}\`.` : '',
    pack ? `Harness: pack \`${pack.id}\` (version ${pack.harnessVersion ?? '?'}) at \`${pack.packDir}\`, transpiled from \`${pack.source && pack.source.dir}\`.` : '',
  ].filter(Boolean).join('\n')
  const skills = lead.skills && lead.skills.length
    ? `Before the first step, load with \`skill\`: ${lead.skills.map((skillName) => `\`${skillName}\``).join(', ')}.`
    : ''
  const delegation = [
    'Delegate with `team_delegate({ member, task })`.',
    '**Worker bits** (`isOrchestrator: false`) are one-shot invocations: they do not see this conversation, run in the flow workspace (or in the directory of this session when it is inside the workspace) and return only a text report — the task must be self-contained (goal and done criteria, `<WT>`, what has already been decided, files, skills to read, prohibitions, report format).',
    '**Orchestrator bits** (`isOrchestrator: true`) run as a child agent with their own roster, flow and rules; their report comes back whole. A "team «X»" member runs the lead of that team and returns its report.',
  ].join('\n')
  return [
    header,
    section('Your role', [bitInstructionsOf(bit), skills].filter(Boolean).join('\n\n')),
    section('The team', `${rosterText(team, teamsById, bitsById)}\n\n${delegation}`),
    section('The team flow', `Drawn on the Bits page → Teams (the dev can edit it). Follow it; it summarizes the skills, and in case of conflict the skill wins.\n\n${flowText(team, teamsById, bitsById)}`),
    section('Repository rules (AGENTS.md of the harness)', rules),
    section('Conduct', conduct),
    section('Extra team rules', team.rules),
    section('Translation of the harness to the DeepSeek Harness', glossaryText('lead', { packDir: pack ? pack.packDir : null })),
    section('Instructions by file type', instructionIndexText(pack)),
  ].filter(Boolean).join('\n\n')
}

/**
 * Full prompt for an orchestrator member (child agent) of a team. Worker bits
 * are single-shot invocations and never see a team prompt.
 *
 * @param {{ team: any, member: any, bit?: any, bitsById?: Record<string, any>, teamsById?: Record<string, any>, pack?: any, rules?: string, conduct?: string }} input
 * @returns {string}
 */
export function memberPromptText({ team, member, bit = null, bitsById = {}, teamsById = {}, pack = null, rules = '', conduct = '' }) {
  const name = bitNameOf(bit, member)
  const launches = member.launches && member.launches.length
    ? `You may launch, with \`team_delegate\`: ${member.launches.map((id) => {
      const other = (team.members || []).find((item) => item.id === id)
      return other ? `${bitNameOf(memberBit(bitsById, other), other)} (\`${id}\`)` : `\`${id}\``
    }).join(', ')}. Any other is denied.`
    : 'You do not launch other bits: the step is yours.'
  const access = member.access === 'read'
    ? 'Read-only: `write` and `edit` do not exist for you, and the guard denies in the terminal everything that changes the tree (git that changes the tree, tests without `--ci`, writes to the repository).'
    : 'Read and write, within the guard rules.'
  const skills = member.skills && member.skills.length
    ? `Before starting, load with \`skill\`: ${member.skills.map((skillName) => `\`${skillName}\``).join(', ')}.`
    : ''
  const role = bit && bit.isOrchestrator === true
    ? 'You are an **orchestrator** bit of this step: you run as a child agent, coordinate the step and return the complete report in your final message.'
    : `You are **${name}** (\`${member.id}\`), a bit of the team **${team.name}**.`
  return [
    `# ${name} — bit of the team ${team.name}`,
    `${role} ${member.role || ''}`.trim(),
    section('Your role', [bitInstructionsOf(bit), skills].filter(Boolean).join('\n\n')),
    section('Access and delegation', `${access}\n\n${launches}`),
    section('The team', rosterText(team, teamsById, bitsById)),
    section('Repository rules (AGENTS.md of the harness)', rules),
    section('Conduct', conduct),
    section('Extra team rules', team.rules),
    section('Translation of the harness to the DeepSeek Harness', glossaryText('member', { packDir: pack ? pack.packDir : null })),
    section('Instructions by file type', instructionIndexText(pack)),
  ].filter(Boolean).join('\n\n')
}
