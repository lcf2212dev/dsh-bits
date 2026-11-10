# Bits — workers que recebem uma requisição e devolvem uma resposta

Um pacote (bundle) para a interface Web do **DeepSeek Harness** que adiciona a página
**Bits**: definições de trabalhadores de IA com contexto próprio, um modelo e um esforço de
raciocínio, que **executam em fluxos** (os times) e devolvem uma resposta a quem pediu.

Um bit não é mais um agente pessoal e não usa máquina virtual. Ele é uma definição:

- **Contexto/instruções** — o papel, o método, os limites e o formato do relatório;
- **`isOrchestrator`** — se é um orquestrador de fluxo ou um worker;
- **Modelo e esforço** — escolhidos entre os modelos disponíveis num chat normal, podendo
  ser trocados a qualquer momento no editor.

> Interface em português (fallback inglês), código em inglês. Feito para o perfil
> `desktop` desta instalação, mas funciona em qualquer perfil com a interface Web.

---

## Como um bit executa

O modo de execução vem de `isOrchestrator`:

| | **Orquestrador** (`isOrchestrator: true`) | **Worker** (`isOrchestrator: false`) |
|---|---|---|
| O que faz | Conduz um **fluxo de time**: entende o pedido, decide a ordem, delega etapas e devolve o relatório final. | Recebe **uma requisição** (uma etapa do fluxo) e devolve **uma resposta**. |
| Onde roda | Agente do DeepSeek Harness, num modelo de rota do chat (padrão **DeepSeek-V4.1-Flash**, esforço **Max**). | Invocação única: por padrão no **Claude Code da sua assinatura**, via a tool `claude_delegate` do plugin **`@local/dsh-claude-delegate`** (o "plugin que criamos"); ou uma chamada única de modelo, se o bit for apontado para uma rota do chat. |
| Ferramentas | Tem as ferramentas do Harness e delega aos membros do time. | No modo assinatura, roda com as ferramentas do Claude Code na pasta do fluxo (ler/editar/executar). No modo rota do chat, devolve texto (sem ferramentas). |
| Memória | Sessão do fluxo (durável). | Nenhuma entre chamadas: o que o bit "lembra" é o `task`/contexto que o orquestrador envia. |

A regra econômica: **orquestrar é barato e acontece na rota do DeepSeek; trabalhar usa a
assinatura**. Você continua podendo trocar o modelo e o esforço de qualquer bit — o editor
lista os modelos do seu chat (provedores/contas do perfil) e os da assinatura.

## O que cada bit tem

| Recurso | Como funciona |
|---|---|
| **Contexto** | Nome, emoji, cor e instruções permanentes: o papel, o método, o que nunca fazer e o formato do relatório. |
| **Classificação** | Orquestrador ou worker (`isOrchestrator`), com o padrão vindo do personagem escolhido no catálogo. |
| **Modelo/Esforço** | Modelo e esforço de raciocínio, editáveis; padrões por personagem no catálogo. |
| **Área de trabalho** | Diretório próprio (`$DSH_HOME/bots/<id>/workspace`), usado como diretório de trabalho quando o bit é executado avulso. Nos fluxos, o diretório é o do time. |
| **Executar** | Workers podem ser executados avulsos na página: você escreve uma requisição (com opção **somente leitura**) e vê a resposta. Orquestradores executam dentro de um fluxo. |

## Bits: os personagens

Todo bit nasce de um **bit do catálogo**, um dos 52 personagens ilustrados
(`bits/catalog.json` + `bits/avatars/*.webp`). Ao clicar em **Novo bit**, a página abre a
galeria (com busca por função, nome ou habilidade, sem diferenciar acentos). O formulário já
vem com nome, descrição, **orquestrador/worker**, **modelo** e **esforço** sugeridos para
aquele papel; tudo pode ser alterado. **Restaurar descrição padrão** volta ao texto original.

| Grupo | Bits |
|---|---|
| Geral | Bit (mascote, worker genérico) |
| Gestão e produto | Manager, Product Owner, Coordinator, Sub-coordinator (orquestradores), Systems Analyst, Product Analyst, User Researcher |
| Workers (tarefas) | Scout, Researcher, Architect, Builder, Runner, Reviewer, Debugger, CI Triager, Writer |
| Qualidade e testes | QA, Web Tester, Android Tester, iOS Tester |
| Engenharia | Frontend, Backend, Android, iOS, Flutter, React Native, Cloud, SRE, Deployer, Integration, Performance, Database, Data Engineer, Data Scientist, LLM, Cybersecurity |
| Design | UX Designer, UI Designer, Design System Expert, Accessibility Expert |
| Negócio e crescimento | Growth Marketer, SEO Expert, Copywriter, i18n / Localization, CRM Specialist, Sales, Sales Assistant, Customer Success, Support, Finance Analyst, Privacy & Compliance |

As descrições seguem o formato dos agentes do Claude Code (`~/.claude/agents`): uma frase
com o papel, o método e os limites, terminando com o formato do relatório
("Report back with …"). O catálogo também guarda o **modelo/esforço padrão** de
cada personagem e quais são **orquestradores** (os quatro papéis de coordenação), para que
um fluxo funcione bem desde o primeiro uso.

## Times e fluxos

Um **time** agrupa bits em papéis (membros) e desenha o fluxo como um grafo editável
(nós + setas). A página **Times** tem o editor visual: arraste para mover, conecte etapas,
agrupe fases, adicione decisões e pausas, desfaça e salve.

- **Membros = bits.** Cada membro aponta para um bit (o mesmo bit pode ser usado em vários
  fluxos). O membro guarda o que é específico do fluxo: papel, acesso (leitura/escrita),
  quem ele pode lançar, time referenciado, MCP e skills.
- **Líder = orquestrador.** Só um bit com `isOrchestrator: true` pode liderar um time: ele
  recebe o pedido e conduz o fluxo. O editor só oferece orquestradores na lista de líderes.
- **Worker = requisição → resposta.** O líder chama o worker com uma tarefa autocontida; o
  worker roda como uma invocação única e devolve o relatório. É por isso que o worker não
  "lembra" da etapa anterior: o líder manda todo o contexto necessário.
- **Orquestrador membro** (ex.: um membro que representa outro time) roda como agente filho,
  com o modelo de rota dele, e pode delegar de novo.
- **Enviar pedido** executa o fluxo: abre a sessão do time no repositório, entrega o pedido
  ao líder e acompanha o trabalho. O líder pode passar a sessão para outro time
  (`team_handoff`) quando o pedido pertence a outro fluxo.

### Modelos de time

A página Times traz modelos prontos (`bits/teams/*.json`, ex.: **Engenharia (Claude Code)**)
e permite transformar um harness importado de um repositório em time. O modelo de
**Engenharia** cria um time com um orquestrador e os workers do Claude Code (scout,
researcher, architect, builder, debugger, reviewer, writer, runner, CI triager…), já com
papéis, acessos e fluxo TDD revisado.

## Projetos

A aba **Projetos** agrupa times por produto/repositório. Um projeto pode conter times
compartilháveis (que também aparecem na aba Times) e times internos. Excluir um projeto
desvincula os times antes, sem apagá-los.

## Times executáveis e harness

Um time com **líder**, **repositório** e (opcionalmente) um **pacote de harness** roda de
verdade no DeepSeek Harness:

- **Harness transpilado:** o botão **Harness** da aba Times importa o harness de um
  repositório (estilo GitHub Copilot / Claude Code: `AGENTS.md`, `.github/agents`,
  `.github/skills`, `.github/instructions`, `.github/hooks`, `.github/scripts`, `.mcp.json`)
  para `<botsRoot>/harness/<id>/`. O repositório pode até não ter mais o harness: o time o
  carrega. Os comandos dos textos passam a apontar para o pacote, e patches ancorados fazem
  os scripts funcionarem de fora do repositório (`DSH_HARNESS_PACK_ROOT`).
- **Criar time deste harness** gera um time com um orquestrador e um bit por preset
  (persona, modelo, esforço, somente leitura, quem cada um pode lançar e as skills que lê
  antes).
- **Líder:** quem recebe o pedido. Com **Toda sessão neste workspace é do time** ligado,
  toda sessão aberta no repositório (inclusive `worktrees/…`) é do líder. Um líder com
  acesso somente leitura só orquestra: não tem terminal, escrita, busca nem web, e só lê o
  pacote do harness e arquivos `.dsc/`.
- **Delegação:** o líder chama `team_delegate({ member, task })`; o worker roda a
  invocação única (assinatura/rota do chat) e o relatório final volta como resultado. Um
  membro orquestrador roda como agente filho. Um membro só lança quem está em "pode lançar".
- **Passagem:** `team_handoff` passa a sessão inteira ao líder de outro time.
- **Guarda:** antes de cada ferramenta de cada agente do time roda o hook do próprio harness
  (o `git-guard.cjs`, no formato de evento do Claude Code), com `--read-only` para membros
  de leitura. A negação chega ao modelo como "Regra do repositório: …". Workers executados
  na assinatura em modo somente leitura recebem `--permission-mode plan` do Claude Code.
- **Contexto:** regras do `AGENTS.md`, conduta, roster, o **fluxo desenhado** (em texto, na
  ordem das fases), glossário Copilot → DeepSeek Harness, skills e as instructions
  `applyTo`, anexadas quando um arquivo que casa é lido ou editado.
- **MCP:** os servidores do `.mcp.json` do pacote são montados só nos membros marcados.

## Como usar

1. Clique em **Bits** na barra lateral (ícone de robô).
2. **Novo bit**: escolha um personagem, ajuste nome/descrição e decida **orquestrador** ou
   **worker**, **modelo** e **esforço**.
3. **Executar** (workers): escreva uma requisição, escolha se é somente leitura e veja a
   resposta.
4. Aba **Times**: crie um time do zero ou de um modelo/ harness, adicione bits como membros,
   escolha o líder orquestrador e desenhe o fluxo. **Enviar pedido** executa.
5. Aba **Projetos**: agrupe os times por produto.

## Requisitos e o plugin da assinatura

- Perfil com a camada Web (`@deepseek-ai/dsh-web-app`).
- Para workers no modo assinatura: o plugin **`@local/dsh-claude-delegate`** instalado no
  perfil e o **Claude Code** instalado e logado na máquina (`claude` no PATH do Harness).
  Esse plugin expõe a tool `claude_delegate` (modelo e esforço por chamada); o bundle dos
  Bits a invoca pela pipeline de ferramentas do Harness, sem importar o pacote.
- Sem o plugin, workers apontados para a assinatura falham com uma mensagem clara
  (`BIT_DELEGATE_UNAVAILABLE`); workers apontados para uma **rota do chat** continuam
  funcionando como chamada única de modelo.
- Não há mais dependência de Docker.

## Como instalar / atualizar

O bundle já é instalado no perfil pelo Lead da sessão via **Plugins → Add plugin** (ou pelo
gerenciador de plugins do Harness). Para instalar em outro perfil:

```bash
# na interface: Plugins → Add plugin → caminho local absoluto
# ou, na CLI, com um alvo de instalação:
dsh plugin --profile <perfil> add /caminho/para/bots-plugin
```

## Configuração

O patch do bundle (`cordis.patch.yml`) aceita, na linha `bots`, um `config` opcional:

```yaml
- insert:
    - id: bots
      name: '@local/dsh-bots'
      config:
        botsRoot: /caminho/absoluto/para/bits   # padrão: $DSH_HOME/bots
```

Os bits ficam em `<botsRoot>/bits.json`, os times em `<botsRoot>/teams.json`, os projetos em
`<botsRoot>/projects.json` e os pacotes de harness em `<botsRoot>/harness/`. Cada bit tem
`<botsRoot>/<id>/workspace`. Gravação atômica, modo 0600.

## Migração da versão anterior

- Um `bots.json` antigo (agentes pessoais + VM) é convertido para `bits.json`: o VM é
  descartado, `isOrchestrator`/modelo/esforço vêm do catálogo do personagem e o
  `workspaceDir` é mantido. O arquivo antigo é preservado como `bots.json.migrated-<data>`.
- Um `teams.json` antigo (membros embutidos) é convertido: cada membro vira/usa um bit
  (deduplicado por personagem+nome+instruções), o líder vira orquestrador
  (DeepSeek-V4.1-Flash Max) e os demais usam os padrões do catálogo. O arquivo antigo é
  preservado como `teams.json.bak-<data>`.
- Sessões antigas de times continuam funcionando: os ids de membros são preservados.

## Arquitetura

```
bots-plugin/
├── index.js               # plugin host: stores, catálogo de modelos, runtimes, rotas
├── host/
│   ├── store.js           # BitStore: registro durável de bits (migração do v4)
│   ├── routes.js          # /api/bots.* (CRUD, catálogo, modelos, executar, avatar)
│   ├── catalog.js         # catálogo de bits (carregamento, validação, avatares)
│   ├── models.js          # catálogo de modelos: assinatura + rotas do chat, resolução
│   ├── bit-runtime.js     # requisição→resposta: claude_delegate (assinatura) ou 1 chamada
│   ├── teams.js           # TeamStore: times/fluxos (membros referenciam bits)
│   ├── team-routes.js     # rotas /api/bots.teams* e modelos de time
│   ├── projects.js        # ProjectStore: projetos que agrupam times
│   ├── project-routes.js  # rotas /api/bots.projects*
│   ├── harness.js         # transpilador de harness → pacote
│   ├── harness-routes.js  # rotas de pacotes, time a partir do pacote, run e diagnóstico
│   ├── team-runtime.js    # times executáveis: líder, delegação, passagem, skills, guarda
│   ├── team-prompt.js     # textos do líder e dos membros (fluxo, roster, glossário)
│   ├── team-guard.js      # ponte para o hook do harness e políticas do líder
│   └── team-bindings.js   # sessão → time/membro (durável)
├── bits/
│   ├── catalog.json       # 52 bits: nome, grupo, emoji, cor, resumo, descrição,
│   │                      #   isOrchestrator, modelo e esforço padrão
│   ├── avatars/           # um avatar WebP 256×256 por bit
│   └── teams/             # modelos de time (JSON)
├── client.js              # página Web (React via module loader, sem JSX/imports)
├── cordis.patch.yml       # linha do plugin no perfil
├── locale/{en,pt}.json    # metadados de exibição do bundle
└── test/                  # testes unitários, runtime com host falso, E2E e visual
```

Fluxo de uma execução de time: página → `/api/bots.teams.run` → `startMission` (sessão no
workspace do time, binding durável) → o líder orquestrador recebe o pedido e chama
`team_delegate` → worker: `bit-runtime.invokeWorker` → `claude_delegate` (assinatura) ou uma
chamada de rota do chat → relatório de volta ao líder → resposta final ao dev.

## Testes

```bash
cd bots-plugin
node test/store.test.mjs        # bits: registro durável, validação, migração
node test/catalog.test.mjs      # catálogo v2 (52 bits, orquestradores, modelos padrão)
node test/routes.test.mjs       # rotas /api/bots.* (CRUD, catálogo, modelos, executar)
node test/teams.test.mjs        # times: membros por bit, líder orquestrador, migração, modelos
node test/projects.test.mjs     # projetos e desvinculação de times
node test/harness.test.mjs      # transpilador e time a partir do harness
node test/team-runtime.test.mjs # runtime com host falso: líder, workers one-shot, guarda
node test/bit-runtime.test.mjs  # req→resposta: assinatura, rota do chat, somente leitura
node test/e2e-web.mjs           # E2E: perfil isolado + host Web real + rotas + UI
node test/visual-teams.mjs --width 1440 --height 900   # editor de fluxo no Chrome headless
node test/visual-projects.mjs --width 1440 --height 900 # aba Projetos no Chrome headless
node test/visual.mjs --theme dark   # capturas reais (Chrome headless) em test/screenshots/
```

O E2E cria um `DSH_HOME` temporário, instala o bundle, sobe o host Web real em uma porta
livre, autentica pelo token de lançamento e exercita as rotas — nunca toca no perfil
`desktop` ativo. A revisão independente do bundle está em `REVIEW.md`.

## Diagnóstico

`GET /api/bots.diagnostics` (autenticado) devolve o caminho do registro, os bits, os agentes
de time que receberam prompt/tools do runtime e os últimos erros de integração. É a primeira
parada para "o time não executou" / "o worker falhou".

## Segurança e limites

- Orquestradores rodam como agentes do Harness, com as ferramentas e o sandbox do perfil.
- Workers no modo assinatura rodam no Claude Code com permissões de bypass (ou
  `--permission-mode plan` quando o membro é somente leitura), no diretório do fluxo.
  O Claude Code **não** aplica as restrições de ferramenta do Harness: o limite efetivo é o
  diretório de trabalho + o modo de permissão.
- Workers no modo rota do chat fazem uma única chamada de modelo, sem ferramentas.
- O orquestrador recebe o texto do worker; saídas estruturadas são melhor esforço.
- Uma execução de worker pode demorar (o Claude Code trabalha até terminar); a rota aceita
  cancelamento pelo pedido HTTP e tem um limite de 15 minutos.
- Segredos do Harness não são repassados ao Claude Code além do ambiente do host (o plugin
  da assinatura isola as credenciais de API para valer o login OAuth).
- Excluir um bit remove o registro e, opcionalmente, o workspace; a remoção de diretório é
  recusada se o caminho escapar de `botsRoot`.
