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
node test/vm.test.mjs        # Docker real: 22 checks (usa ubuntu:24.04 local, limpa tudo)
node test/vm-lifecycle.test.mjs  # Docker real: dispose pegajoso, tombstone de bot excluído
node test/agent.test.mjs     # persona/vm_bash/notify_user/restrição/refresh ao vivo com contexto falso
node test/notify.test.mjs    # notificações: argv seguro, fallback gdbus, sanitização
node test/e2e-web.mjs        # E2E: perfil descartável isolado + host Web real + rotas + VM
node test/visual.mjs --theme dark   # capturas reais (Chrome headless) em test/screenshots/
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
