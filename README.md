# Bots — assistentes de IA com máquina própria no DeepSeek Harness

Um pacote (bundle) para a interface Web do **DeepSeek Harness** que adiciona a página
**Bots**: assistentes de IA nomeados, com persona própria, uma área de trabalho dedicada e,
opcionalmente, **sua própria máquina virtual Docker** persistente.

A inspiração é o Grok Bot: cada bot é um "colega de trabalho" permanente com quem você
conversa em sessões normais do Harness, e que — quando a VM está ligada — executa todos os
comandos dentro do seu próprio contêiner Linux, podendo instalar pacotes, rodar servidores e
manter estado entre conversas sem tocar na sua máquina.

> Interface em português (fallback inglês), código em inglês. Feito para o perfil `desktop`
> desta instalação, mas funciona em qualquer perfil com a interface Web.

---

## O que cada bot tem

| Recurso | Como funciona |
|---|---|
| **Persona** | Nome, emoji, cor e instruções permanentes entram no prompt de sistema de toda sessão aberta na área de trabalho do bot. |
| **Área de trabalho** | Diretório dedicado (`$DSH_HOME/bots/<id>/workspace`), registrado como Workspace no Harness. Os arquivos ficam seus: o bot lê/escreve neles como qualquer sessão normal. |
| **Chat** | O botão **Conversar** cria/retoma uma sessão nesse Workspace (mesma UI de conversa, ferramentas, approvals, histórico e busca do Harness). |
| **VM opcional** | Um contêiner Docker persistente (`dsh-bot-<id>`, imagem configurável) com o Workspace montado no mesmo caminho absoluto. Comandos do bot rodam via ferramenta `vm_bash` dentro da VM. |
| **Controles da VM** | Iniciar, parar, reiniciar, remover; estado ao vivo (rodando/desligada/criada) na página. |
| **Ciclo de vida** | A VM é criada no primeiro uso, guarda pacotes e processos enquanto existir e só é removida quando você manda. |

Quando o bot tem VM:

- a ferramenta `bash` do host fica **oculta** para esse agente (e para os subagentes dele);
  um guard de execução também recusa o shell do host caso a VM seja ligada depois que a
  conversa já estava aberta (a sessão viva é atualizada na hora ao salvar o bot);
- entra no lugar a ferramenta `vm_bash`, que roda dentro do contêiner;
- o mesmo Workspace aparece dentro e fora da VM, então o que o bot cria/edita é visível na
  sua máquina (e vice-versa);
- a VM não tem `--privileged`, não monta o socket do Docker e usa a rede padrão do Docker.

Sem VM, o bot é uma persona com área de trabalho própria rodando direto no seu ambiente
(mesmo `bash` e ferramentas normais do Harness).

## Bits: os personagens

Todo bot nasce de um **bit**, um dos 52 personagens ilustrados do catálogo
(`bits/catalog.json` + `bits/avatars/*.webp`). Ao clicar em **Novo bot**, a página abre a
galeria de bits (com busca por função, nome ou habilidade, sem diferenciar acentos). Ao
escolher um bit, o formulário já vem com o **nome** e a **descrição** pré-definidos daquele
papel; os dois podem ser alterados. **Restaurar descrição padrão** volta ao texto original.

| Grupo | Bits |
|---|---|
| Geral | Bit (mascote, colega genérico sem papel definido) |
| Gestão e produto | Manager, Product Owner, Coordinator, Sub-coordinator, Systems Analyst, Product Analyst, User Researcher |
| Workers (tarefas) | Scout, Researcher, Architect, Builder, Runner, Reviewer, Debugger, CI Triager, Writer |
| Qualidade e testes | QA, Web Tester, Android Tester, iOS Tester |
| Engenharia | Frontend, Backend, Android, iOS, Flutter, React Native, Cloud, SRE, Deployer, Integration, Performance, Database, Data Engineer, Data Scientist, LLM, Cybersecurity |
| Design | UX Designer, UI Designer, Design System Expert, Accessibility Expert |
| Negócio e crescimento | Growth Marketer, SEO Expert, Copywriter, i18n / Localization, CRM Specialist, Sales, Sales Assistant, Customer Success, Support, Finance Analyst, Privacy & Compliance |

As descrições seguem o formato dos agentes do Claude Code (`~/.claude/agents`): uma frase
com o papel, o método e os limites (o que o bit nunca faz, para quem ele repassa) e o
fechamento *Report back in Portuguese (pt-BR) with …*. Os workers (scout, builder, reviewer,
…) reaproveitam esses agentes quase literalmente; os demais seguem o mesmo estilo.

- O bit escolhido define o avatar, a cor e o emoji do bot (o emoji aparece no prompt de
  persona e nas notificações). Trocar de bit depois mantém o nome e a descrição se você os
  tiver personalizado; caso contrário, eles acompanham o novo bit.
- Bots criados antes dos bits continuam com o avatar de emoji; **Editar → Escolher bit** dá
  um personagem a eles.
- Limite atual: modelo, esforço e restrição de ferramentas por bit (ex.: Scout/Reviewer só
  leitura) **ainda não são aplicados pelo plugin**; os limites estão apenas descritos nas
  instruções.

## Times de bits

A aba **Times** (ao lado de **Bits**, no topo da página) monta **times de bits** e desenha
o fluxo de trabalho entre eles num quadro editável.

- **Membros**: cada membro é um bit do catálogo com nome, papel, modelo, provedor (conta),
  esforço, acesso (somente leitura ou escrita), instruções e a lista de membros que ele
  **pode lançar**. O campo **Provedor** vem da lista de provedores do perfil (a mesma do seletor
  de modelo do chat, com os nomes das contas): escolhido, ele fixa em qual conta o modelo do
  membro é resolvido; vazio, o membro herda a conta do agente que o chama.
- **Fluxo**: um grafo com *Início*, *Etapa* (atribuída a um membro), *Decisão*, *PAUSA*
  (decisão humana), *Fim*, *Fase* (moldura que agrupa etapas) e *Nota*. As conexões têm
  rótulo e tipo: **sequência** (linha cheia), **retorno/correção** (tracejada laranja) e
  **delegação** (pontilhada azul).
- **Edição**: arraste elementos e membros da barra lateral para o quadro (ou clique para
  adicionar no centro); arraste nós para mover (arrastar uma fase leva o que está dentro;
  com Alt, só a moldura); arraste de uma das bolinhas de um nó até outro para conectar;
  Shift + arrastar no fundo seleciona uma área; Delete exclui; Ctrl+D duplica;
  Ctrl+Z / Ctrl+Shift+Z desfazem/refazem; setas movem; Ctrl+roda dá zoom; arrastar o fundo
  move o quadro; duplo clique no fundo cria uma etapa. O painel da direita edita o item
  selecionado (time, nó, conexão ou membro). Selecionar um membro destaca as etapas dele.
- **Salvar**: botão **Salvar** ou Ctrl+S; sair com alterações pendentes pede confirmação.
- **Modelos**: *Em branco* e *Engenharia (Claude Code)*, este feito a partir dos agentes de
  `~/.claude/agents`, com os bits em **DeepSeek-V4.1-Flash** (esforços `low`, `high` e `max`;
  `xhigh`→`max`, `medium`→`high`). Os modelos são arquivos `bits/teams/<id>.json`.
- **Importar/Exportar**: cada time pode ser exportado como JSON (`*.team.json`) e importado
  em outro perfil.

Os times ficam em `<botsRoot>/teams.json`.

## Times executáveis e harness

Um time com **líder**, **repositório** e (opcionalmente) um **pacote de harness** roda de
verdade no DeepSeek Harness:

- **Harness transpilado:** o botão **Harness** da aba Times importa o harness de um
  repositório (estilo GitHub Copilot / Claude Code: `AGENTS.md`, `.github/agents`,
  `.github/skills`, `.github/instructions`, `.github/hooks`, `.github/scripts`, `.mcp.json`)
  para `<botsRoot>/harness/<id>/`. O repositório pode até não ter mais o harness: o time o
  carrega. Os comandos dos textos passam a apontar para o pacote, e patches ancorados fazem
  os scripts funcionarem de fora do repositório (`DSH_HARNESS_PACK_ROOT`). **Criar time deste
  harness** gera um time com um orquestrador e um membro por preset (persona, modelo, esforço,
  somente leitura, quem cada um pode lançar e as skills que lê antes).
- **Líder:** quem recebe o pedido. Com **Toda sessão neste workspace é do time** ligado, toda
  sessão aberta no repositório (inclusive `worktrees/…`) é do líder. Um líder com acesso
  somente leitura só orquestra: não tem terminal, escrita, busca nem web, e só lê o pacote do
  harness e arquivos `.dsc/`.
- **Delegação:** o líder chama `team_delegate({ member, task })`; o membro roda como agente
  filho com a persona, o modelo e o esforço dele, as ferramentas do acesso dele, o guarda e
  as skills do harness, e o relatório final volta como resultado. Um membro só lança quem
  está em "pode lançar". Um membro que **representa outro time** executa o líder daquele time
  (ex.: a validação), que delega aos membros dele. O **Provedor** do membro (o campo do
  editor e `members[].provider` no time) fixa a conta em que o modelo é resolvido — útil
  quando o perfil tem duas contas do mesmo provedor; sem ele vale a conta do líder e, na
  falta dela, a ordem do perfil. O roster mostra a conta escolhida ao lado do modelo.
- **Passagem:** `team_handoff` passa a sessão inteira ao líder de outro time (ex.: o líder
  roteador entrega ao time de Implementação).
- **Guarda:** antes de cada ferramenta de cada agente do time roda o hook do próprio harness
  (o `git-guard.cjs`, no formato de evento do Claude Code), com `--read-only` para membros
  de leitura. A negação chega ao modelo como "Regra do repositório: …".
- **Contexto:** regras do `AGENTS.md`, conduta, roster, o **fluxo desenhado** (em texto, na
  ordem das fases), glossário Copilot → DeepSeek Harness, skills (ferramenta `skill`, com o
  diretório do pacote) e as instructions `applyTo`, anexadas quando um arquivo que casa é
  lido ou editado.
- **MCP:** os servidores do `.mcp.json` do pacote são montados só nos membros marcados.
- **Hooks git:** na primeira sessão do líder, o instalador do harness confere os hooks git
  do repositório (`install.mjs --auto`).
- **Enviar pedido:** no card do time, **Enviar pedido** abre uma sessão no repositório com o
  pedido no campo de mensagem (ex.: `implemente o AB 160047`). Em qualquer conversa, peça
  "mande o AB 160047 para o time DSC": a ferramenta `team_send` cria a sessão do time e já a
  inicia.

## Agendamentos e lembretes

Todo bot pode **agendar tarefas** e **te lembrar de coisas** com notificação no seu computador:

- Peça na conversa, por exemplo: *“me lembre amanhã às 9h de ligar para o contador”* ou
  *“toda segunda às 8h revise os PRs abertos e me mande um resumo”*.
- O bot usa as ferramentas nativas de agendamento do Harness (`schedule_create`,
  `schedule_list`, `schedule_view`, `schedule_edit`). As tarefas aparecem também em
  **Tarefas de automação**, onde dá para pausar, editar, rodar agora ou excluir.
- Quando a tarefa dispara, ela chega como mensagem para o bot. Se for um lembrete, o bot chama
  `notify_user`, que mostra uma **notificação do sistema** (GNOME/freedesktop, via `notify-send`,
  com fallback por `gdbus`) com o emoji e o nome do bot no título.
- Tarefas que abrem uma conversa nova rodam no workspace do bot, então a persona continua
  valendo.
- O sino 🔔 em cada card envia uma **notificação de teste**, para confirmar que elas aparecem.

Limites: os lembretes só disparam com o DeepSeek Harness aberto (se o app estiver fechado no
horário, o Harness entrega só a ocorrência perdida mais recente ao reabrir). A notificação
exige uma sessão gráfica com serviço de notificações (padrão no GNOME/KDE).

## Como usar

1. Clique em **Bots** na barra lateral (ícone de robô).
2. **Novo bot**: nome, emoji, cor, instruções (a persona) e, se quiser, ligue **Máquina
   virtual** e escolha a imagem Docker (as imagens locais aparecem na lista; também dá para
   digitar qualquer referência, ex. `node:24`).
3. **Conversar**: abre uma sessão no Workspace do bot. A persona já está no prompt.
4. Na página do bot: **Iniciar/Parar/Reiniciar VM**, **Remover VM** (o contêiner, sem apagar
   arquivos), **Editar** e **Excluir** (com opção de apagar os arquivos do Workspace).
5. Conversas antigas continuam na barra lateral, agrupadas no Workspace do bot.

Botões de VM só aparecem para bots com VM habilitada. Se a imagem não existir localmente, a
página mostra isto e explica como baixá-la (`docker pull <imagem>`); nada é baixado
automaticamente.

## Como instalar / atualizar

O bundle já é instalado no perfil pelo Lead desta sessão via **Plugins → Add plugin** (ou
pelo gerenciador de plugins do Harness). Para instalar em outro perfil:

```bash
# na interface: Plugins → Add plugin → caminho local absoluto
# ou, na CLI, com um alvo de instalação:
dsh plugin --profile <perfil> add /caminho/para/bots-plugin
```

Requisitos: perfil com a camada Web (`@deepseek-ai/dsh-web-app`), Docker acessível pelo
processo do Harness (`docker version`) e uma imagem de contêiner presente (por padrão
`ubuntu:24.04`).

## Configuração

O patch do bundle (`cordis.patch.yml`) aceita, na linha `bots`, um `config` opcional:

```yaml
- insert:
    - id: bots
      name: '@local/dsh-bots'
      config:
        botsRoot: /caminho/absoluto/para/bots   # padrão: $DSH_HOME/bots
        defaultImage: ubuntu:24.04              # imagem sugerida a novos bots
        dockerBin: docker                       # binário/path do Docker
        execTimeoutMs: 120000                   # timeout padrão do vm_bash
        maxOutputBytes: 65536                   # limite por stream no vm_bash
```

O registro dos bots fica em `<botsRoot>/bots.json` (gravação atômica, modo 0600). Cada bot
tem `<botsRoot>/<id>/workspace`.

## Segurança e limites (v1)

- A VM isola **execução**: pacotes, processos, rede e filesystem visível pelos comandos.
  As ferramentas de arquivo (`read`, `write`, `edit`, `glob`, `grep`) continuam rodando no
  host dentro do Workspace do bot — o isolamento delas segue a política de permissões do
  Harness (perfil, sandbox, approvals), não a VM.
- Trocar a imagem de um bot que já tem contêiner não recria a VM automaticamente: o
  contêiner continua com a imagem antiga até você usar **Remover VM** e iniciar de novo.
  Editar a persona e ligar/desligar a VM, por outro lado, atualiza as conversas abertas
  imediatamente.
- A página consulta o Docker a cada ~5 s enquanto aberta (um `docker inspect` por bot).
  Com muitos bots isso tem custo; o estado degrada para "indisponível" se o Docker travar,
  mas é esperado manter poucas dezenas de bots.
- O trabalho iniciado na VM (`nohup`, servidores) continua rodando entre conversas. O
  `vm_bash` encerra o comando quando o timeout estoura; processos filhos em background
  podem continuar (comportamento documentado no rodapé da ferramenta).
- A VM é um contêiner comum, não um microVM. Para isolamento mais forte, use uma imagem
  mínima e as políticas de rede do Docker.
- Segredos/credenciais do Harness não entram na VM; a página não expõe tokens.
- Excluir um bot remove o registro e, opcionalmente (`Também apagar os arquivos`), o
  Workspace; a remoção de diretório é recusada se o caminho escapar de `botsRoot`.

## Arquitetura

```
bots-plugin/
├── index.js            # plugin host: monta store + VM + rotas + integração de agentes
├── host/
│   ├── store.js        # BotStore: registro JSON durável, workspaces, remoção segura
│   ├── vm.js           # BotVm: ciclo de vida Docker, docker exec, timeouts, limites
│   ├── routes.js       # rotas autenticadas /api/bots.* (Connection/Fetch)
│   ├── agent.js        # persona, restrição do bash, ferramentas vm_bash e notify_user
│   └── notify.js       # notificações de desktop (notify-send / gdbus)
├── host/catalog.js     # catálogo de bits (carregamento, validação, avatares)
├── host/teams.js       # TeamStore: times de bits (membros + fluxo), validação e gravação atômica
├── host/team-routes.js # rotas /api/bots.teams* e carregador de modelos
├── host/harness.js     # transpilador de harness → pacote (manifest, reescritas, patches)
├── host/harness-routes.js # rotas de pacotes, time a partir do pacote, run e diagnóstico
├── host/team-runtime.js   # times executáveis: líder, delegação, passagem, skills, guarda, MCP
├── host/team-prompt.js    # textos do líder e dos membros (fluxo, roster, glossário)
├── host/team-guard.js     # ponte para o hook do harness e políticas do líder
├── host/team-bindings.js  # sessão → time/membro (durável)
├── bits/
│   ├── catalog.json    # 52 bits: nome, grupo, emoji, cor, resumo pt/en, descrição padrão
│   ├── avatars/        # um avatar WebP 256×256 por bit
│   └── teams/          # modelos de time (JSON)
├── client.js           # página Web (React via module loader, sem JSX/imports)
├── cordis.patch.yml    # linha do plugin no perfil
├── locale/{en,pt}.json # metadados de exibição do bundle
└── test/               # testes unitários, Docker real e E2E com host isolado
```

Fluxo de uma conversa: página → `/api/bots.list` (sessão aberta no Workspace) →
`ctx.uiWorkspace.startSession(workspaceId)` → sessão normal do Harness. No host,
`agent/created` resolve o bot pelo diretório de trabalho da sessão, registra a persona e,
para bots com VM, restringe o shell do host e habilita `vm_bash`.

## Testes

```bash
cd bots-plugin
node test/store.test.mjs     # registro durável: 22 checks
node test/routes.test.mjs    # rotas HTTP: 26 checks
node test/catalog.test.mjs   # catálogo de bits, campo character, rotas catalog/avatar
node test/vm.test.mjs        # Docker real: 22 checks (usa ubuntu:24.04 local, limpa tudo)
node test/vm-lifecycle.test.mjs  # Docker real: dispose pegajoso, tombstone de bot excluído
node test/agent.test.mjs     # persona/vm_bash/notify_user/restrição/refresh ao vivo com contexto falso
node test/notify.test.mjs    # notificações: argv seguro, fallback gdbus, sanitização
node test/teams.test.mjs     # times: validação, persistência, rotas e modelos
node test/harness.test.mjs   # transpilador (fixture + harness real do DSC, se existir)
node test/team-runtime.test.mjs  # runtime com host falso: líder, delegação, guarda, passagem, skills, applyTo
node test/visual-teams.mjs --width 1440 --height 900   # editor de fluxo no Chrome headless: mover, conectar, adicionar, excluir, desfazer, salvar
node test/e2e-web.mjs        # E2E: perfil descartável isolado + host Web real + rotas + VM
node test/visual.mjs --theme dark   # capturas reais (Chrome headless) em test/screenshots/ + fluxo de criação pela UI
```

O E2E cria um `DSH_HOME` temporário, instala o bundle, sobe o host Web real em uma porta
livre, autentica pelo token de lançamento, exercita todas as rotas, cria uma sessão de chat
de verdade (validando a integração persona/VM via `/api/bots.diagnostics`), inicia/para/
remove a VM e apaga tudo — nunca toca no perfil `desktop` ativo. A revisão independente do bundle está em
`REVIEW.md` (achados e status pós-correção).

## Diagnóstico

`GET /api/bots.diagnostics` (autenticado) devolve o caminho do registro, os bots, os agentes
que receberam persona/VM e os últimos erros de integração. É a primeira parada para
"a persona não apareceu no chat".

## Roadmap (próximos passos naturais)

- Rotinas/agendamentos por bot (reaproveitando o plugin de Schedule) e "acordar" o bot para
  tarefas em segundo plano.
- Skills e arquivos de conhecimento por bot (pasta de skills no Workspace já funciona via
  `AGENTS.md`/skills do Harness).
- Isolamento de arquivos dentro da VM (provider de `ctx.fs` via `docker exec`) para que as
  ferramentas de leitura/escrita também rodem no contêiner.
- Computador gráfico (navegador/VNC) na VM, rotinas compartilhadas e bots compartilhados com
  a equipe.
- Modelo padrão por bot e presets de ferramentas por bot.

Inspiração de produto: [Grok Bot da xAI](https://docs.x.ai/grok-bot/bots) e
[como o Grok Bot funciona](https://docs.x.ai/grok-bot/how-grok-bot-works).
