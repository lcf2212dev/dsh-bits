/**
 * Prompt text for runnable teams (pure functions, no I/O).
 *
 * The lead and every member get: who they are in the team, the roster, the
 * harness rules (AGENTS.md of the pack) and conduct, a glossary that maps the
 * original Copilot/Claude harness vocabulary onto the DeepSeek Harness team
 * runtime, and the `applyTo` instruction index. The lead also gets the team
 * flow (the graph edited on the Bits page) rendered as ordered text.
 *
 * @module host/team-prompt
 */

const TYPE_TEXT = {
  start: 'Início',
  end: 'Fim',
  step: 'Etapa',
  decision: 'Decisão',
  pause: 'PAUSA (dev)',
  note: 'Nota',
  team: 'Outro time',
  group: 'Fase',
}

const EDGE_TEXT = {
  flow: '',
  loop: ' (retorno/correção)',
  delegate: ' (delegação)',
  handoff: ' (passagem ao outro time)',
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

function memberLabel(member) {
  return member ? `${member.name} (\`${member.id}\`)` : 'sem membro'
}

/**
 * The team flow as ordered Markdown: phases (frames) in reading order, the
 * nodes inside each phase, then loose nodes; each node lists its outgoing
 * connections. Node ids are shown so connections can be followed.
 *
 * @param {Record<string, any>} team
 * @param {Record<string, any>} teamsById
 * @returns {string}
 */
export function flowText(team, teamsById = {}) {
  const nodes = Array.isArray(team?.flow?.nodes) ? team.flow.nodes : []
  const edges = Array.isArray(team?.flow?.edges) ? team.flow.edges : []
  if (nodes.length === 0) return '(o time ainda não tem fluxo desenhado)'
  const members = Object.fromEntries((team.members || []).map((member) => [member.id, member]))
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]))
  const outgoing = {}
  for (const edge of edges) (outgoing[edge.from] = outgoing[edge.from] || []).push(edge)

  const groups = nodes.filter((node) => node.type === 'group').sort(groupOrder)
  const placed = new Set()
  const lines = []

  const describe = (node) => {
    const label = node.label ? `«${node.label}»` : '«sem título»'
    let who = ''
    if (node.type === 'step') {
      const member = members[node.memberId]
      who = ` — ${memberLabel(member)}`
      if (member && member.teamRef) {
        const other = teamsById[member.teamRef]
        who += ` → time ${other ? `«${other.name}»` : member.teamRef}`
      }
    }
    if (node.type === 'team') {
      const other = teamsById[node.teamRef]
      who = ` — time ${other ? `«${other.name}»` : (node.teamRef || '?')}`
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
    lines.push('', `### ${group.label || 'Fase'}${group.detail ? ` — ${group.detail}` : ''}`)
    for (const node of children) {
      placed.add(node.id)
      lines.push(...describe(node))
    }
  }
  const loose = nodes.filter((node) => node.type !== 'group' && node.type !== 'note' && !placed.has(node.id)).sort(byPosition)
  if (loose.length > 0) {
    lines.push('', '### Fora das fases')
    for (const node of loose) lines.push(...describe(node))
  }
  const notes = nodes.filter((node) => node.type === 'note').sort(byPosition)
  if (notes.length > 0) {
    lines.push('', '### Notas')
    for (const note of notes) lines.push(`- **${note.label || 'Nota'}:** ${String(note.detail || '').replace(/\s*\n\s*/g, ' ')}`)
  }
  return lines.join('\n').trim()
}

/**
 * Roster as a Markdown table.
 *
 * @param {Record<string, any>} team
 * @param {Record<string, any>} teamsById
 * @param {Record<string, string>} [providers] provider id → display name, for
 *   members whose model is pinned to one provider (`member.provider`)
 * @returns {string}
 */
export function rosterText(team, teamsById = {}, providers = {}) {
  const rows = ['| membro (`id`) | papel | modelo · esforço | acesso | pode lançar | ler antes |', '|---|---|---|---|---|---|']
  for (const member of team.members || []) {
    const other = member.teamRef ? teamsById[member.teamRef] : null
    const lead = member.id === team.lead ? ' **(líder)**' : ''
    const role = other ? `time «${other.name}»: ${member.role || other.description || ''}` : member.role
    const providerName = member.provider ? providers[member.provider] || member.provider : ''
    const model = [member.model, providerName ? `— ${providerName}` : ''].filter(Boolean).join(' ')
    const route = other ? '—' : [model, member.effort].filter(Boolean).join(' · ') || 'padrão'
    const access = other ? '—' : member.access === 'read' ? 'somente leitura' : 'leitura e escrita'
    const launches = member.launches && member.launches.length ? member.launches.map((id) => `\`${id}\``).join(', ') : '—'
    const skills = member.skills && member.skills.length ? member.skills.map((name) => `\`${name}\``).join(', ') : '—'
    rows.push(`| ${member.name} (\`${member.id}\`)${lead} | ${String(role || '').replace(/\|/g, '/')} | ${route} | ${access} | ${launches} | ${skills} |`)
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
    'Ao ler, criar ou editar um arquivo que casa com um destes padrões, o texto da instrução é anexado automaticamente à conversa (uma vez). Antes de editar, você pode lê-la direto:',
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
    'O harness foi escrito para o GitHub Copilot (janela Agents do VS Code) e o Claude Code. Aqui ele roda como um **time de bits no DeepSeek Harness**. Leia os textos do harness assim:',
    '- "preset", "subagente", "lançar o `x`", "`task` com `agent_type`", "`runSubagent`" → **membro do time**: `team_delegate({ member: "x", task: "…" })`. Os presets do harness são os membros do roster acima. O membro só sabe o que está na tarefa: escreva-a autocontida (objetivo, `<WT>`, o que já foi decidido, arquivos, skills a ler, proibições, formato do retorno), como manda "Como escrever o prompt" da skill `subagent-routing`.',
    '- O relatório final do membro volta inteiro como resultado do `team_delegate`. Delegações independentes podem ir na mesma resposta (rodam em paralelo).',
    '- "o hook nega", "git-guard", "`--read-only`", "`--launches`" → o **guarda do time** roda o mesmo `git-guard.cjs` do harness antes de cada ferramenta de cada membro (o modo somente leitura vale para os membros de leitura), e o `team_delegate` só aceita os membros de "pode lançar". A negação chega como erro "Regra do repositório: …"; não tente contorná-la.',
    packDir
      ? `- Caminhos \`.github/...\` do harness (skills, scripts, hooks, instructions, agents, \`harness.json\`) e o \`AGENTS.md\` ficam no **pacote do time** \`${packDir}\`, não no repositório; os comandos dos textos já apontam para lá. Os scripts seguem recebendo a WT por \`--dir <WT>\`, e o \`.env\` continua na raiz do checkout principal.`
      : '- Este time não carrega pacote de harness.',
    '- Skills: use a ferramenta `skill` com o nome (ela devolve o diretório base; `references/` e `scripts/` ficam nele).',
    '- MCP: os servidores do `.mcp.json` do harness só existem nos membros configurados para eles (ferramentas `mcp__<servidor>__*`). Sem a ferramenta, siga o caminho alternativo da skill (ex.: script REST) ou devolva o caso.',
    '- "Copilot Fusion", "harness Local", "Customizations", "This Computer"/"modo Branch", MCP `dsc-files` e a falta de `create`/`edit` não se aplicam: todo membro com escrita tem `write` e `edit`.',
    '- Modelos e esforço ("Claude Opus 5.5 (copilot)", `reasoning-effort`) já estão configurados em cada membro; não os passe na delegação.',
  ]
  if (role === 'lead') {
    common.push(
      '- "sessão principal" → **esta sessão**, a do líder do time. Você só orquestra: as ferramentas de terminal, escrita, busca e web ficam fora do seu alcance, e o guarda só deixa você ler o pacote do harness e arquivos `.dsc/`.',
      '- "PAUSA" → pergunte ao dev com as opções e uma recomendação e **encerre a resposta** (ou use `ask_user_question`). Não siga supondo a resposta.',
      '- "Onde rodar": `create-wt` e `open-wt` **não** pedem sessão nova. Depois que o membro criar (ou achar) a WT, mude o diretório desta sessão para `worktrees/AB-<n>` com `working_directory` e siga nesta sessão; os membros que você lançar herdam esse diretório. `work-here` e `operate-from-root` seguem como estão. `pause` continua sendo PAUSA.',
      '- Outro fluxo (outro time do roster ou do fluxo): `team_handoff({ team: "<id do membro do time ou nome do time>", request: "pedido literal + o que já se sabe" })` passa **esta sessão** ao líder daquele time. Para usar outro time como etapa e receber o relatório de volta (ex.: validação), delegue ao membro que o representa com `team_delegate`.',
      '- Mensagem que começa com `[Time: <nome>]` foi enviada pela página Bits para aquele time: passe a sessão a ele com `team_handoff` sem fazer mais nada.',
    )
  } else {
    common.push(
      '- Você é um **membro** chamado por `team_delegate`. "Devolva ao agente que chamou" = ponha a pergunta, com opções e recomendação, no seu relatório final e encerre. Você não fala com o dev.',
      '- Sua **mensagem final é o relatório** que volta a quem chamou: ponha nela tudo o que importa (`arquivo:linha`, saídas coladas, o que delegou e o que voltou). Mensagens intermediárias não chegam.',
      '- Opere no diretório recebido na tarefa (`git -C <WT>`, `yarn --cwd <WT>`, `--dir <WT>`).',
    )
  }
  return common.join('\n')
}

function section(title, body) {
  const text = String(body || '').trim()
  return text ? `## ${title}\n\n${text}` : ''
}

/**
 * Full prompt for the lead of a team.
 *
 * @param {{ team: any, member: any, teamsById: Record<string, any>, pack: any, rules: string, conduct: string, providers?: Record<string, string> }} input
 * @returns {string}
 */
export function leadPromptText({ team, member, teamsById = {}, pack = null, rules = '', conduct = '', providers = {} }) {
  const lead = member || { id: 'lider', name: 'Líder', instructions: '', skills: [] }
  const header = [
    `# Time de bits: ${team.name}`,
    '',
    `Você é **${lead.name}** (\`${lead.id}\`), líder do time **${team.name}**${team.description ? `: ${team.description}` : '.'}`,
    team.workspaceDir ? `Repositório do time: \`${team.workspaceDir}\`.` : '',
    pack ? `Harness: pacote \`${pack.id}\` (versão ${pack.harnessVersion ?? '?'}) em \`${pack.packDir}\`, transpilado de \`${pack.source && pack.source.dir}\`.` : '',
  ].filter(Boolean).join('\n')
  const skills = lead.skills && lead.skills.length
    ? `Antes do primeiro passo, carregue com \`skill\`: ${lead.skills.map((name) => `\`${name}\``).join(', ')}.`
    : ''
  return [
    header,
    section('Sua função', [lead.instructions, skills].filter(Boolean).join('\n\n')),
    section('O time', `${rosterText(team, teamsById, providers)}\n\nDelegue com \`team_delegate({ member, task })\`. Um membro "time «X»" executa o líder daquele time e devolve o relatório dele.`),
    section('O fluxo do time', `Desenhado na página Bits → Times (o dev pode editá-lo). Siga-o; ele resume as skills, e em caso de conflito vale a skill.\n\n${flowText(team, teamsById)}`),
    section('Regras do repositório (AGENTS.md do harness)', rules),
    section('Conduta', conduct),
    section('Regras extras do time', team.rules),
    section('Tradução do harness para o DeepSeek Harness', glossaryText('lead', { packDir: pack ? pack.packDir : null })),
    section('Instruções por tipo de arquivo', instructionIndexText(pack)),
  ].filter(Boolean).join('\n\n')
}

/**
 * Full prompt for a member (child agent) of a team.
 *
 * @param {{ team: any, member: any, teamsById: Record<string, any>, pack: any, rules: string, conduct: string, providers?: Record<string, string> }} input
 * @returns {string}
 */
export function memberPromptText({ team, member, teamsById = {}, pack = null, rules = '', conduct = '', providers = {} }) {
  const launches = member.launches && member.launches.length
    ? `Você pode lançar, com \`team_delegate\`: ${member.launches.map((id) => {
      const other = (team.members || []).find((item) => item.id === id)
      return other ? `${other.name} (\`${id}\`)` : `\`${id}\``
    }).join(', ')}. Qualquer outro é negado.`
    : 'Você não lança outros membros: a etapa é sua.'
  const access = member.access === 'read'
    ? 'Somente leitura: `write` e `edit` não existem para você, e o guarda nega no terminal tudo o que altera a árvore (git que muda a árvore, testes sem `--ci`, gravação no repositório).'
    : 'Leitura e escrita, dentro das regras do guarda.'
  const skills = member.skills && member.skills.length
    ? `Antes de começar, carregue com \`skill\`: ${member.skills.map((name) => `\`${name}\``).join(', ')}.`
    : ''
  return [
    `# ${member.name} — membro do time ${team.name}`,
    `Você é **${member.name}** (\`${member.id}\`), membro do time **${team.name}**. ${member.role || ''}`.trim(),
    section('Sua função', [member.instructions, skills].filter(Boolean).join('\n\n')),
    section('Acesso e delegação', `${access}\n\n${launches}`),
    section('O time', rosterText(team, teamsById, providers)),
    section('Regras do repositório (AGENTS.md do harness)', rules),
    section('Conduta', conduct),
    section('Regras extras do time', team.rules),
    section('Tradução do harness para o DeepSeek Harness', glossaryText('member', { packDir: pack ? pack.packDir : null })),
    section('Instruções por tipo de arquivo', instructionIndexText(pack)),
  ].filter(Boolean).join('\n\n')
}
