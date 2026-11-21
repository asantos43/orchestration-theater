# 18. Plano da Fase 7

Versão 6, de 2026-11-21 (as cinco ondas estão concluídas; o P21, o aceite, está na main no PR #231 (7debaa8) [V: `git log`]; cada passo feito leva o PR e as divergências). Este é o plano de passos da Fase 7 da [arquitetura](framework-ideas/arquitetura.md), §10, "TUI (interface principal)". A arquitetura continua sendo a referência: este plano só divide a fase em passos, diz o que pode correr em paralelo e dá o aceite de cada passo. Se os dois divergirem, vale a arquitetura, e este documento é corrigido.

O plano também leva as duas decisões da Fase 6 que ficaram para esta fase: os eventos que faltam (N173) e o controle de peça e de Ator pela REST (N176). Ele levantou oito decisões novas, N185 a N192 ([docs/13](13-DECISOES-EM-ABERTO.md)), tomadas pelo dono em 2026-11-20, todas iguais à recomendação; o resumo está em "Decisões que surgem deste plano", no fim.

## Como usar

- Cada passo tem uma branch e um PR com título "Fase 7: ...". O PR que conclui um passo também muda o estado dele na tabela de passos.
- O merge é feito pelo `merge-pr.sh`, com squash, depois da CI verde e com a branch atualizada com a main. Nunca com `gh pr merge --auto`. A autorização sem ok por PR das Fases 3 a 6 (N171) vale também para a Fase 7 (N192).
- Todo passo exige, além do aceite próprio, `build`, `lint`, `format:check`, `test`, `verify` e `deps` verdes na máquina e na CI. O job `linux` roda em todo PR. Os jobs `cross` e `windows-launcher` rodam nos PRs que mexem em código (N162).
- O que está marcado **[proposta]** é detalhe deste plano, ainda sem decisão. Todo padrão novo vira uma chave de configuração, com um padrão e os seus modos. Se a chave mudar algum comportamento visível, a escolha vai ao dono, por múltipla escolha, ao abrir o passo.
- Paralelismo:
  - passos sem dependência entre si correm ao mesmo tempo, cada um no seu worktree;
  - dois passos nunca mexem nos mesmos arquivos. Há quatro exceções, em que cada passo acrescenta só o seu bloco e o conflito se resolve no merge da main na branch:
    - o `DaemonConfigSchema` (`daemon/src/config.ts`);
    - o índice do protocolo (`protocol/src/index.ts`) e o registro de rotas (`protocol/src/api/registry.ts`), com o catálogo `docs/reference/api-routes.json` regenerado por `pnpm api:catalog`;
    - o `compose.ts`;
    - os catálogos `locales/<idioma>/tui.json`, com as chaves de cada tela num bloco próprio;
  - na TUI, cada aba e cada componente ficam num arquivo próprio em `tui/src/tabs/` e `tui/src/components/`, e a aba entra no registro (P7) por uma linha;
  - no máximo dois subagentes rodam a suíte completa ao mesmo tempo, por causa da memória da máquina.
- **Nada real roda nos testes (N57).** A TUI é testada com o `ink-testing-library` contra o daemon com o `fake-agent`, o relógio falso e o store em memória ou num SQLite temporário. Nenhum teste abre porta fora do loopback, lê credencial ou faz login.
- **Nenhum download novo sem decisão do dono.** Cada download vira uma linha no docs/13 antes de entrar. Os candidatos desta fase estão em "Dependências novas".
- **Texto de tela só pelo catálogo (§5.22, N50).** Nenhum componente escreve texto direto. Toda chave nova entra em `en` e em `pt-BR` no mesmo PR, e a CI já reprova chave presente num catálogo e ausente no outro.

## Ponto de partida

O que já existe foi conferido no código em 2026-11-20, no commit `29af929` **[V]**. Os caminhos são relativos a `packages/`.

- **Pacotes:** `protocol`, `core`, `daemon`, `client`, `sdk`, `fake-agent` e 17 adaptadores. **Não há** `packages/tui`. O `pnpm-workspace.yaml` cobre `packages/*`, `packages/adapters/*` e `tools/*`, então um `packages/tui` entra sem mudar o workspace.
- **Bibliotecas de TUI:** `ink`, `@inkjs/ui`, `react`, `@types/react` e `ink-testing-library` **não estão** em nenhum `package.json` de `packages/` nem no `pnpm-lock.yaml`. Só existem nos spikes, com `package-lock.json` próprio: `spikes/tui-ink` e `spikes/tui-mockup-ink` usam ink 8.0.0, @inkjs/ui 2.0.0, react 19.3.1 e @types/react 19.3.0, e `spikes/licenses/stacks/core` acrescenta o ink-testing-library 4.0.0. Os spikes são descartáveis e ficam fora do lint e do `pnpm check`.
- **Já no monorepo:** `zustand` 5.1.0 (`client`) e `i18next` 26.6.0 (`daemon`).
- **`packages/client`** (`client/src/index.ts`; roda no Node e no navegador):
  - `ApiClient` (`client.ts`), com `status()`, `connect()`, `events()`, `chat()`, `scenarioRef()` e as chamadas tipadas das rotas;
  - `EventStream` (SSE com reconexão e cursor) e `ChatSocket` (WebSocket com reconexão), sobre o `ReconnectingConnection`;
  - os stores em zustand *vanilla* (`stores/`): `DaemonStores` com `scenarios`, `plays`, `demands`, `decisions`, `quotas`, `events` e `status`;
  - o `LayoutStore` (`layout/store.ts`: lateral, largura do chat, abas, seções), com persistência no daemon ou local;
  - o `DaemonDirectory` (vários daemons, N168), com a parte de arquivos em `@otheater/client/node`.
- **REST** (schemas em `protocol/src/api/*.ts`, rotas em `daemon/src/api/routes/`): estado e eventos (`/v1/status`, `/v1/events`), chat (`/v1/chat-tickets` e o WebSocket), layout, rotação do token, `GET`/`PUT /v1/config`, cenários, anexos, peças (com `cancel`), blackboard, decisões, executores, papéis, ideias, ordens (`/v1/orders`, com `extend`, `suspend` e `revoke`), perfis (cadastro, `drain`, remoção) e consumo (`/v1/usage`, `/v1/budget`).
  - O `PUT /v1/config` edita o `config.yaml` preservando os comentários, valida como a subida validaria e recusa valor que possa ser segredo. **O daemon em execução continua com a configuração da subida**: a edição vale no reinício (`protocol/src/api/config-view.ts`). Ver a N188.
- **Login oficial:** a porta `LoginFlow` (`core/src/ports/client-adapter.ts`) tem os modos `browser`, `device_code` e `terminal`, com `url`, `code`, `submitCode` (N158), `complete` e `cancel`, e os três adaptadores a implementam (`official-login.ts`). **Nenhuma rota a expõe**: hoje o login é `ot profile exec <cliente>/<perfil> login`, que roda o CLI oficial no terminal da pessoa. A REST de perfis traz só o estado (`login: logged_in | logged_out | unknown`). Ver a N186.
- **Assistente de configuração (§5.7) e `ot init`:** não existem. O `ot` tem `daemon`, `backup`, `restore`, `directives`, `chat`, `profile`, `executor` e `api`. Existem peças soltas: `ot executor add`, `GET /v1/executors`, `GET /v1/roles` e `core/src/executor-roles/resolve.ts`. A N121 mandou a tela do assistente para esta fase e o `ot init` para a Fase 10.
- **Ordens (§5.17):** completas no daemon (`daemon/src/directives/`), na CLI e na REST (seis rotas `/v1/orders`), com os eventos `directive.*`.
- **Comandos `/` (N44) e `!` (N43):** não existem. O WebSocket aceita `{type: 'command', text}` (`protocol/src/api/chat.ts`), mas só repassa o texto ao Diretor como mensagem. Não há `chat.slash_commands`, `chat.client_commands`, `chat.shell_command` nem `terminal_snippet` no código.
- **Sessão direta (N44):** não existe. Não há a chave `direct_session.workspace`.
- **Plugins (§5.14):** só o prefixo de evento `plugin.<id>.<nome>` em `core/src/registries/events.ts`. Não há carregador, manifesto, rota nem chave `plugins`. O sistema de plugins é da Fase 9.
- **i18n:** `daemon/src/i18n.ts` usa o i18next 26.6.0 (`createInstance`, `LOCALES = ['en', 'pt-BR']`, `resolveLocale`, `detectSystemLocale`), com o namespace `cli`. Os catálogos ficam em `locales/<idioma>/{cli,common}.json`, na raiz. `client`, `protocol` e `core` não têm catálogo de tela.
- **Chaves `ui.*`:** só `ui.locale` e `ui.layout.{store, write_delay, sync}`. As chaves `ui.keymap`, `ui.clipboard`, `ui.render`, `ui.runtime` e `ui.mouse` da §5.13 **não existem**, e o schema é `strictObject`, então entram com os passos que as usam.
- **N173 e N176:** `decision.created`, `decision.answered`, `scenario.archived` e `demand.transitioned` não existem (há `scenario.decision_answered`, `play.transitioned`, `demand.waiting` e `demand.resumed`). Os stores do cliente dependem de `play.transitioned` e de leituras REST (`client/src/stores/decisions.ts`, linha 18). O `PlayRunner` só aceita `CANCEL`, e `daemon/src/api/routes/play-commands.ts` só tem `cancelPlay`.
- **`ot chat`** (`daemon/src/chat-command.ts`, 905 linhas): de linha de comando, com `readline`, sobre o `@otheater/client`. Continua existindo depois da TUI, para scripts e terminais sem tela cheia **[proposta]**.
- **Spikes da Fase 0** (`spikes/RELATORIO-FASE-0.md`, §2.9; ADR `docs/adr/0002-framework-da-tui-ink.md`):
  - o Ink otimizado digitou em p50 de 10,1 ms sob 50 msg/s, com CPU de 23,6% e RSS de 142 MB, usando `flush`, memoização, `--max-semi-space-size=2` e o patch do `output.js` do Ink 8.0.0 (`spikes/tui-ink/patches/ink-output.patch`). A arquitetura (§5.13, N37) já decidiu que o patch fica, com a versão travada; a trava ainda não existe;
  - teclas (`spikes/tui-keys`, 41 teclas do mapa da N35): só tmux no Linux. O Ctrl+J chega como `\n`, diferente do Enter; o Ink 8.0.0 lê `CSI u` (Shift+Enter), mas não o modifyOtherKeys; no tmux, o Ctrl+B é engolido pelo prefixo;
  - mouse: precisou de um leitor próprio no stdin (`filter` ou `tap`), com sequência cortada vazando para a entrada; funcionou só no tmux;
  - **terminais não testados:** Windows Terminal, terminal do VS Code, Terminal.app, iTerm2, GNOME Terminal e Konsole, SSH e IME.
- **Mockup:** `docs/framework-ideas/mockup/tui.html`, gerado por `tui-render.js` (grade de 140x42), com quatro telas (principal, Trajetórias com a lateral recolhida, Configurações aberta como aba, só o chat). `spikes/tui-mockup-ink` reproduz as quatro em Ink, célula a célula. O rodapé do mockup ainda mostra os atalhos com Ctrl da v0.7; vale o mapa da §5.13 (N35).
- **CI** (`.github/workflows/ci.yml`): `linux` (`pnpm check` e o Rust), `changes`, `cross` (Windows e macOS, `pnpm check`) e `windows-launcher`. Nenhum job testa uma TUI: não há pty, tmux nem `ink-testing-library`.

## Dependências novas

Dados do registro npm, consultados em 2026-11-20 **[S]**. Todas são MIT. Aprovadas pelo dono na N185 (2026-11-20).

| Pacote | Versão | Licença | Publicada | Passo | Observação |
|---|---|---|---|---|---|
| `ink` | 8.0.0 | MIT | 2026-10-03 | P8 | Travada nesta versão por causa do patch (N37). Pede `react` >= 19.3.0 e Node >= 22. Traz 23 dependências diretas: entre elas `yoga-layout` e `react-reconciler` (MIT), `type-fest` (MIT ou CC0-1.0) e `signal-exit` (ISC). A lista inteira passa pelo `pnpm deps` no P8 |
| `react` | 19.3.1 | MIT | 2026-10-14 | P8 | A mesma do spike |
| `@types/react` | 19.3.0 | MIT | — | P8 | Só tipos, em `devDependencies`. A mesma do spike |
| `@inkjs/ui` | 2.0.0 | MIT | 2024-05-22 | P9 | Campos, listas e seletores (§5.13). Sem versão nova há dois anos; pede `ink` >= 5. Funcionou com o Ink 8.0.0 no spike `tui-mockup-ink` **[V: Fase 0]** |
| `ink-testing-library` | 4.0.0 | MIT | 2024-05-22 | P8 | Testes da §10. Pede só `@types/react`. Com o Ink 8.0.0 só foi instalado no spike de licenças, não usado **[N]** |
| `react-i18next` | 17.1.13 | MIT | 2026-11-05 | P8 | A §5.22 (N49) o pede na TUI. A 18.x (18.0.3, de 2026-11-19) pede o `i18next` >= 27.0.1, e o repositório tem a 26.6.0; a 17.1.13 pede o `i18next` >= 26.2.0 e tem duas semanas em 2026-11-19. Uma dependência: `html-parse-stringify` (MIT) |

Não entram **[proposta]**:
- o `node-pty` (MIT, nativo), salvo se a N187 escolher o `!` com PTY já nesta fase;
- o `@opentui/*`, reprovado na Fase 0 (LGPL e só Bun);
- uma biblioteca de mouse ou de área de transferência: a camada de mouse e a cópia por OSC 52 são código próprio (§5.13, N34 e N36), e a cópia de imagem chama a ferramenta do sistema que estiver instalada (`wl-paste`, `xclip`, `osascript`), sem empacotá-la;
- a subida do `i18next` para a 27.x: a 27.2.2 é de 2026-11-19 e não cumpre a regra de duas semanas.

## Passos

| Passo | Título | Depende de | Pode correr junto com | Estado |
|---|---|---|---|---|
| P0 | Plano e decisões (este documento) | nada | nada | concluído (PR #203) |
| P1 | Eventos que faltam (N173) | P0 | P2, P4, P5, P6, P7, P8 | concluído (PR #209) |
| P2 | Pausar e retomar peça; pausar, retomar e cancelar Ator (N176) | P0 | P1, P4, P5, P6, P7, P8 | concluído (PR #211) |
| P3 | Registro de comandos `/` no daemon (N44) | P2 | P4 a P11 | concluído (PR #215) |
| P4 | Assistente de configuração no daemon (§5.7) | P0 | P1, P2, P5 a P8 | concluído (PR #212) |
| P5 | Login oficial pela API (N186) | P0 | P1, P2, P4, P6 a P8 | concluído (PR #207) |
| P6 | Comando `!` do Produtor no daemon (N43, N187) | P0 | P1, P2, P4, P5, P7, P8 | concluído (PR #208) |
| P7 | Registro de interface e chaves `ui.*` no `packages/client` | P0 | P1, P2, P4 a P6, P8 | concluído (PR #206) |
| P8 | `packages/tui`: base, desempenho e testes | P0 | P1, P2, P4 a P7 | concluído (PR #210) |
| P9 | Layout: lateral, chat, painel de abas, rolagem e paleta | P7, P8 | P3, P10, P11 | concluído (PR #216) |
| P10 | Caixa de texto do Produtor (N35) | P7, P8 | P3, P9, P11 | concluído (PR #213) |
| P11 | Mouse e cópia (N34, N36) | P9 | P3, P10 | concluído (PR #218) |
| P12 | Chat: conversa, decisões e comandos `/` | P3, P9, P10 | P13 a P16 | concluído (PR #220) |
| P13 | Visão geral e Consumo | P1, P9 | P12, P14 a P16 | concluído (PR #219) |
| P14 | Trajetórias | P9 | P12, P13, P15, P16 | concluído (PR #224) |
| P15 | Ordens | P9 | P12 a P14, P16 | concluído (PR #221) |
| P16 | Configurações: Assinaturas, Executores, Papéis e Limites | P5, P9, N188 | P12 a P15 | concluído (PR #222) |
| P17 | Assistente de configuração na TUI | P4, P16 | P18, P19 | concluído (PR #227) |
| P18 | `!` na TUI | P6, P12 | P17, P19 | concluído (PR #223) |
| P19 | Sessão direta com um Ator (N190) | P12 | P17, P18 | concluído (PR #228) |
| P20 | Terminais: testes de fumaça e roteiro manual (N191) | P12 | P17 a P19 | concluído (PR #226) |
| P21 | Aceite da fase | todos | nada | concluído (PR #231) |

Ordem em ondas **[proposta]** (a onda 1 terminou em 2026-11-20 e as ondas 2, 3, 4 e 5 em 2026-11-21; os PRs estão nas linhas dos passos; os PRs #222 e #224, que estavam abertos quando a onda 3 foi documentada, estão na main [V: `git log`]; os PRs #226, #227 e #228 da onda 4 também estão na main [V: `git log`], e os passos foram descritos pela descrição dos PRs e, em parte, pelo código [S]):
1. P1, P2, P4, P5, P6, P7 e P8. Os cinco primeiros são do daemon; P7 e P8 abrem o lado da TUI. Sete passos de uma vez passam do limite de dois subagentes com a suíte completa: os do daemon rodam a suíte em fila, e P7 e P8 testam só os pacotes deles até o PR.
2. P3, P9 e P10.
3. P11, P12, P13, P14, P15 e P16.
4. P17, P18, P19 e P20.
5. P21.

Marco interno **[proposta]**: ao fim da onda 3, a TUI já acompanha uma peça e conversa com o Diretor contra o `fake-agent`. É o ponto em que o dono pode abrir a TUI e mudar o rumo antes das telas de configuração e do aceite. **Atingido em 2026-11-21** [S: os testes de aceite dos PRs #218 a #221, #222 e do P14 rodam contra o `fake-agent`]. A onda 4 (P17 a P20) fechou as telas que faltavam (o assistente, o `!` e a sessão direta) e pôs a TUI num tmux de verdade na CI Linux (P20). A onda 5 (P21, PR #231) fechou o aceite em dois níveis: o automático, pela TUI e só pelas teclas contra o `fake-agent`, em `en` e `pt-BR`, e o real, com o Claude Code (haiku) num tmux, que passou na rodada do orquestrador de 2026-11-21 [V]. Falta o dono abrir a TUI num terminal real e passar o roteiro `tools/acceptance/tui-terminals.md` (Windows Terminal e macOS ou Linux), e fazer o login oficial dentro da TUI: nenhum teste rodou num terminal de verdade além do tmux, e o orquestrador não faz login [N]. As lacunas do aceite estão na N208, e o fechamento da fase, na N209.

**Estimativa:** 2,5 a 3 semanas, como na §10. Pelo ritmo medido nas Fases 1 a 6, com agentes, fica mais perto de 1,5 semana **[proposta]**. São 22 passos, contra 14 da Fase 6 e 23 da Fase 5.

### P1. Eventos que faltam (N173; §5.12)

**Escopo:**
- os eventos `decision.created`, `decision.answered`, `scenario.archived` e `demand.transitioned`, v1, no catálogo do protocolo, com `scenarioId` no envelope e `playId` quando houver. Os nomes estão como **[proposta]** na N173 e ficam assim, salvo objeção no PR;
- quem os emite: a criação e a resposta de uma decisão do Produtor (onde hoje sai `scenario.decision_answered`, que continua, para não quebrar quem lê **[proposta]**), o arquivamento do cenário e cada transição de demanda na máquina;
- os stores `decisions`, `demands` e `scenarios` do `packages/client` passam a se montar por esses eventos, sem leitura REST a cada transição, e o comentário de `client/src/stores/decisions.ts` sai;
- o filtro `scenario` do SSE vê os quatro.

**Aceite:** o teste que monta os stores por eventos e compara com a REST (o mesmo do aceite da Fase 6) passa sem as leituras extras; cada evento tem teste de emissão com o `fake-agent`; o catálogo `api-routes.json` e o de eventos estão regenerados.

**Estado:** feito em 2026-11-20, PR #209. Os quatro eventos saem pelo decorador `recordFeedStore`, na mesma transação do registro (N177). Sem chave nova.

**Divergências:**
- não há rota para arquivar cenário: o `scenario.archived` sai em qualquer `scenarios.update` que mude `active` para `archived`;
- `decision.answered` leva `decisionId`, `kind`, `state` e `decidedBy`, mas não o texto da resposta;
- `demand.transitioned` leva o registro da demanda só no nascimento (`from` nulo); nas outras transições leva `from` e `to`;
- as etapas não ganharam evento, e o `scenario.created` ainda marca o cenário como velho (`stale`);
- `scenario.decision_answered` continua, como previsto.

### P2. Pausar e retomar peça; pausar, retomar e cancelar Ator (N176; §5.12, §5.16)

**Escopo:**
- `PAUSE` e `RESUME` no `PlayRunner`, com a semântica da §5.16: a pausa não abre etapa nova nem tentativa nova; a etapa em curso termina ou é interrompida, conforme `pause.mode: drain | interrupt`, padrão `drain` (N193). A peça pausada sobrevive ao reinício do daemon (§5.21);
- pausar, retomar e cancelar um Ator (uma tentativa em curso): pausar interrompe com a causa `paused` da tabela da §5.16 e guarda o checkpoint; retomar segue a política de retomada da causa; cancelar termina a tentativa como `cancelled`, e o Diretor julga;
- rotas `POST /v1/plays/:playId/pause`, `/resume` e `POST /v1/attempts/:attemptId/pause`, `/resume` e `/cancel` **[proposta]**, com `Idempotency-Key` e atrás do `RecoveryGate`, como o `cancel` da peça;
- eventos: as transições saem como `play.transitioned` e pelos eventos da tentativa que já existem; o que faltar entra como evento novo, aditivo.

**Aceite:** com o `fake-agent`, pausar uma peça em `EXECUTING` não abre tentativa nova, retomar continua do ponto, e a peça pausada continua pausada depois do reinício do daemon; pausar e retomar um Ator retoma a sessão pela política da causa; a mesma `Idempotency-Key` não repete o efeito; durante a reconciliação, as rotas esperam o fim dela.

**Estado:** feito em 2026-11-20, PR #211. Chave nova: `pause.mode: drain | interrupt`, padrão `drain` (N193), no topo do `DaemonConfigSchema`; o corpo do `pause` da peça pode trazer `mode` para valer só naquela pausa. Eventos novos: `attempt.paused`, `attempt.resumed` e `attempt.cancelled`; o `play.transitioned` ganha `held`.

**Divergências:**
- **durante a reconciliação, as rotas esperam (`await gate.wait()`) em vez de responder `recovering`**; `recovering` só aparece em `/v1/status`. O aceite acima já está corrigido para isso;
- a pausa de Ator não sobrevive ao reinício do daemon (a tentativa fica `interrupted/paused` e a peça reabre a demanda); só a pausa da peça sobrevive;
- a pausa durante a espera de reset (`when_exhausted: wait`) é descartada ou dá conflito;
- a pausa de um Ator não congela o prazo por demanda; no modo `interrupt` só os prazos da peça congelam;
- no `drain`, um Executor adquirido enquanto a peça está pausada guarda vaga e lease até o `RESUME`;
- o julgamento do Diretor não é pausado;
- o resultado de uma tentativa retomada não volta para a peça (lacuna que já existia);
- não há teste que reinicie o daemon inteiro; o reinício é testado no nível do `PlayRunner`;
- as telas de pausa ficam no P13, e não no P3, como o texto do PR diz.

### P3. Registro de comandos `/` no daemon (N44; §5.13)

**Escopo:**
- o registro de ações do daemon, com uma entrada por comando: id, descrição (chave de catálogo), argumentos com schema zod, onde vale (tipo de cenário e estado), permissão e se pede confirmação;
- rotas `GET /v1/commands?scenario=` (a lista que vale naquele cenário, com os comandos do cliente) e `POST /v1/scenarios/:scenarioId/commands` (executa, com `Idempotency-Key`) **[proposta]**. A mensagem `{type: 'command'}` do WebSocket passa a ir ao registro, e só os modelos para o Diretor (os terminados em "…") viram mensagem;
- a lista inicial da §5.13, só com o que o daemon já faz: consultar (`/status`, `/quota`, `/cost`, `/executors`, `/plays`, `/logs`, `/doctor`), controlar a peça (`/pause`, `/resume` e `/cancel` sobre o P2; `/retry` e `/approve` onde o daemon já tem a ação), sessão e cenário (`/new`, `/attach`, `/export`), configurar (`/model`, `/effort`, `/profile`, `/directives`, `/config`) e `/help`. Os que não têm ação no daemon (`/fork`, `/direct` antes do P19, `/trajectory` antes do P14, `/keys`) ficam de fora até o passo que os traz;
- os comandos do cliente, vindos do `available_commands_update` do ACP, com o prefixo do cliente (`/claude:compact`), na sessão do Diretor só fora de turno; os Atores de uma peça nunca os recebem;
- chaves `chat.slash_commands: on | off` (padrão `on`) e `chat.client_commands: on | off | allowlist` (padrão `on`), com `chat.client_commands.allow` (no código, `chat.client_commands_allow`: ver as divergências).

**Aceite:** a lista muda com o tipo e o estado do cenário; um comando de consulta responde sem chamar o modelo (nenhum turno do Diretor no log); `/cancel` pede confirmação; um comando do cliente com o Diretor em turno é recusado com `conflict`; o catálogo de rotas está regenerado.

**Estado:** feito em 2026-11-21, PR #215 [S: descrição do PR; os nomes das chaves, as rotas, o quadro `command_result` e o prefixo conferidos no código da main]. Registro em `packages/daemon/src/slash/`, rotas `GET /v1/commands?scenario=&lang=` e `POST /v1/scenarios/:scenarioId/commands` (com `Idempotency-Key`; resposta `{status: done | confirm | forwarded, command, text, data?}`), quadro `command_result` no WebSocket do chat (`eventId: null`) e catálogo `locales/<idioma>/commands.json` (namespace `commands`). Nenhum tipo de evento novo. Chaves, todas **[proposta]** e com modos e padrão documentados: `chat.slash_commands` (`on`), `chat.client_commands` (`on`), `chat.client_commands_allow` (`[]`), `chat.slash_confirm: always | never` (`always`), `chat.slash_logs_lines` (1 a 500; 20), `chat.slash_access: full | read_only` (`full`) e `chat.slash_templates` (mapa nome para texto; `plan`, `explain` e `review`).

**Divergências:**
- **a lista de permitidos é `chat.client_commands_allow`**, plana, e não `chat.client_commands.allow`: uma chave YAML não pode ser valor (`on | off | allowlist`) e mapa ao mesmo tempo [V: comentário do schema em `packages/daemon/src/config.ts`];
- o prefixo dos comandos do cliente é o nome curto do cliente: `claude` para o `claude-code` (`/claude:compact`), e o nome do cliente nos outros [V: `clientPrefixOf`, em `slash/parse.ts`]. Não há chave para isso;
- `/retry` e `/approve` ficaram de fora: o daemon ainda não tem a ação pronta. `/fork`, `/direct`, `/trajectory` (entra no P14) e `/keys` seguem de fora, como no plano;
- `/model`, `/effort`, `/profile` e `/config` são só de leitura; mudar a configuração por comando fica para depois. `/export` devolve os dados na resposta e não grava arquivo; `/cost` mostra os tetos só quando estouraram; `/doctor` é básico;
- `/new` cria um cenário do tipo `chat` [V: `slash/builtin.ts`], e `/logs` varre os últimos 5.000 eventos (`LOGS_SCAN_EVENTS`) [V]. As duas são escolhas sem chave;
- os comandos do cliente valem só na sessão do Diretor, só fora de turno e depois do primeiro turno; com o Diretor em turno, antes do primeiro turno ou sem sessão, a resposta é `conflict` (409) [S]. Com `chat.slash_commands: off`, a lista vem vazia e a linha vai ao Diretor como mensagem, como antes [S];
- só os modelos para o Diretor (os que terminam em "…") viram mensagem na fila de prompts [S];
- a falha ao carregar o catálogo `commands` (erro de empacotamento) derruba a partida do daemon, em vez de degradar [S];
- `scenarioOf` e `playOf` saíram de `scenarios.ts` para `api/routes/projections.ts`, que `scenarios.ts` reexporta, para não criar ciclo de imports [S];
- o `eslint .` precisa de `NODE_OPTIONS=--max-old-space-size=8192` (com 4 GB estoura o heap) [S].

### P4. Assistente de configuração no daemon (§5.7; N121)

**Escopo:**
- o fluxo de passos no daemon: cada passo tem schema de entrada e de saída, guarda o estado no store, é validado antes de seguir e pode ser retomado depois de a TUI fechar ou o daemon reiniciar. Nada entra na configuração antes da confirmação final, que grava tudo de uma vez pelo mesmo editor do `PUT /v1/config`;
- os passos da primeira execução da §5.7: detectar clientes, logins e chaves de API; aplicar `roles.preset` e tirar os Executores que não existem; acrescentar o Executor por API com o teto de gasto; mostrar o resultado para confirmar. O cadastro do Executor do OpenCode reaproveita o `ot executor add`;
- rotas `GET /v1/setup`, `POST /v1/setup/:flow/start`, `POST /v1/setup/:runId/step`, `POST /v1/setup/:runId/back`, `POST /v1/setup/:runId/confirm` e `POST /v1/setup/:runId/cancel` **[proposta]**, com eventos `setup.*`;
- o mesmo mecanismo para adicionar uma conta e trocar a predefinição (§5.7, reuso) **[proposta]**.

**Aceite:** com perfis falsos, o fluxo inteiro vai do começo à confirmação e grava a configuração esperada; parar no meio, reiniciar o daemon e retomar volta ao mesmo passo; `back` desfaz só o estado do passo; cancelar não deixa nada no `config.yaml`.

**Estado:** feito em 2026-11-20, PR #212. Porta do store 0.7.0, com o registro `setupRuns` (migração 0010). Eventos `setup.started`, `setup.step`, `setup.back`, `setup.confirmed` e `setup.cancelled`. Chaves **[proposta]**: `setup.role_lists: explicit | preset` (padrão `explicit`) e `setup.suggested_budget.daily_usd` (20) e `.monthly_usd` (200).

**Divergências:**
- as rotas são seis, como no plano (um `GET` e cinco de ação); não houve mudança real;
- `executors.on_register: ask` vira `preset_only` no assistente, porque a revisão do passo final já é a pergunta;
- o fluxo `first_run` é completo; `add_account` e `change_preset` usam o mesmo mecanismo, só com os passos e os testes de aceite;
- com `roles.api_fallback` ativo, os Executores por API vão ao fim das listas; `explicit` troca as listas do Produtor (nota `lists_replaced`) e avisa do formato antigo `orchestration.executor/roles` (nota `legacy_executors`); o plano é recalculado na confirmação;
- a confirmação roda numa cadeia de promessas própria, e pode correr com um `PUT /v1/config` (o último vence);
- o modo `preset` de `role_lists` usa a ordem do store;
- `notes[].message` fica em inglês;
- o cadastro do Executor do OpenCode e a sessão de teste do Executor (`testSession: 'off'`) ficam fora; a tela é do P17.

### P5. Login oficial pela API (N186; §5.6, N158)

**Escopo** (na forma escolhida na N186):
- rotas `POST /v1/profiles/:client/:name/login` (abre o `LoginFlow` do adaptador e devolve o modo, a URL e o código), `POST .../login/code` (o `submitCode`), `POST .../login/cancel` e o fim do login por evento **[proposta]**;
- eventos `profile.login.started`, `profile.login.completed` e `profile.login.failed`, sem token, sem código e sem URL no log. A URL e o código vão só na resposta da rota a quem abriu o login;
- no modo `terminal`, que exige um terminal de verdade (o `opencode auth login`, N155), a rota responde que o login é local, e a TUI suspende a tela e roda `ot profile exec <cliente>/<perfil> login` no próprio terminal (P16).

**Aceite:** com um adaptador falso que simula os três modos, o login abre, recebe o código e termina; cancelar mata o processo do login; nenhum log, evento ou resposta além da primeira traz URL, código ou token.

**Estado:** feito em 2026-11-20, PR #207. Serviço `ProfileLoginService`; eventos `profile.login.started`, `.completed` e `.failed`; porta `ClientAdapter` 0.3.3, com `loginMode()` opcional. Sem chave nova: o modo já é `clients.<id>.login.mode`.

**Divergências:**
- um login por perfil; perfil `api`, `draining` ou `removed` dá `conflict`, e cliente sem adaptador dá `unavailable`;
- no modo `terminal`, a rota responde `status: local` com o comando `ot profile exec <cliente>/<perfil> login`, sem rodar nada e sem evento. Sem `loginMode`, o serviço abre o login, vê `terminal`, cancela e responde `local`;
- o cache de idempotência, em memória, guarda a resposta com URL e código; a mesma `Idempotency-Key` devolve a resposta inteira, o que vai além do "só na primeira resposta" do aceite;
- não há tempo limite para o login aberto;
- o `FakeLoginFlow` ficou em `@otheater/core/testing`.

### P6. Comando `!` do Produtor no daemon (N43, N187; §5.13)

**Escopo** (na forma escolhida na N187):
- uma mensagem do chat que começa com `!` roda como comando, no worktree do cenário, pelo `ProcessLauncher`, sob o modo de `app.terminal` (`sandbox`, padrão, `host` ou `off`), com a entrada padrão fechada e sem PTY. Não vai ao Diretor;
- a saída vira um anexo `terminal_snippet` (5.19), com `terminal.snippet.max_lines` (padrão 200) e o arquivo inteiro no log da sessão. Pela `chat.shell_command.context` (`auto | ask | never`, padrão `auto`), entra na conversa sempre, depois de perguntar ou nunca;
- um comando que espera entrada recebe fim de arquivo e termina; a conversa registra que ele pediu entrada. O caso interativo, com a TUI entregando o terminal, fica para quando houver PTY (N187);
- chaves `chat.shell_command: on | off` (padrão `on`) e um prazo por comando, `chat.shell_command.timeout`, padrão 5 min ou `off` (N194);
- eventos `chat.shell_command.started` e `.finished`, com o código de saída e sem a saída.

**Aceite:** com `app.terminal: sandbox`, um comando que escreve fora do worktree é barrado; `off` recusa; a saída longa é cortada em `max_lines`; um `read` termina por fim de arquivo; o prazo mata a árvore do processo.

**Estado:** feito em 2026-11-20, PR #208. Serviço `ShellCommandService`, com `/bin/sh -c` (no Windows, `cmd.exe /d /s /c`) pelo `ProcessLauncher`. Chaves: `chat.shell_command` (`on`), `chat.shell_command.timeout` (`5m`, N194), `chat.shell_command.context` (`auto`), `app.terminal` (`sandbox`), `terminal.snippet.max_lines` (200), e, **[proposta]**, `chat.shell_command.max_running` (4), `terminal.snippet.keep` (`tail`) e `terminal.log_max_size` (`16MB`). Mensagens novas do WebSocket: `shell_started` e `shell_finished`.

**Divergências:**
- "pediu entrada" é uma heurística, e na sandbox não há rede (`app.terminal: host` para ter rede);
- `!` com anexos pendentes é recusado (`InvalidInput`);
- o `terminal_snippet` é um anexo de texto comum, sem registro de indicações tipado;
- os textos da pergunta (`context: ask`) e da mensagem ao Diretor estão em inglês e não passam pelo catálogo;
- acima de `max_running` o comando dá `Conflict`;
- o `!` na TUI é do P18; os comandos `/` são do P3.

### P7. Registro de interface e chaves `ui.*` no `packages/client` (§5.13, §5.18; N35, N39)

**Escopo:**
- o registro de interface: abas, comandos da paleta e ações do mapa de teclas, uma entrada por ação (id, chave de catálogo, grupo, combinações por plataforma e superfície). A paleta, a ajuda (F1) e a barra de atalhos são geradas dele;
- o mapa de teclas da TUI (§5.13): presets `agents` (padrão) e `classic`, padrões por ambiente (macOS, `TMUX`, `TERM_PROGRAM=vscode`), `ui.keymap.overrides` e a checagem de conflito (rejeita repetido e avisa sobre a lista de colisões);
- as chaves `ui.keymap`, `ui.clipboard.copy` (`osc52 | system | off`), `ui.mouse` (`full | wheel | off`), `ui.render` (`keyRender`, `maxFps`, `coalesceMs`, `memo`, `inkPatches`, `historyWindow`) e `ui.runtime` (`maxSemiSpaceMB`, `maxOldSpaceMB`) no `DaemonConfigSchema`, com os padrões da §5.13. O `maxOldSpaceMB` fica sem teto por padrão até a medição do P8 **[proposta]** (a medição saiu no PR #210: ver o P8);
- o carregamento do catálogo de tela, `locales/<idioma>/tui.json`, pelo `packages/client`, para a TUI e depois a web.

**Aceite:** o mapa sai certo nos três ambientes simulados; um atalho repetido é recusado; toda ação do registro tem texto em `en` e `pt-BR`; as chaves novas passam pela validação da subida.

**Estado:** feito em 2026-11-20, PR #206. O registro e o mapa de teclas ficam em `packages/client/src/ui/`, a gramática de combinação em `packages/protocol/src/key-combo.ts`, e os catálogos em `locales/<idioma>/tui.json`; `@otheater/client/node` traz o `loadUiCatalogs`.

**Divergências:**
- as chaves de `ui.render` e `ui.runtime` usam camelCase, como a arquitetura, e não o snake_case do daemon;
- chave nova **[proposta]**: `ui.keymap.environment: auto | none` (padrão `auto`); faixas **[proposta]**: `ui.render.maxFps` de 1 a 240 e `coalesceMs` de 0 a 1000;
- um atalho repetido, ou um id desconhecido em `overrides`, impede a subida do daemon (o `superRefine` roda o `resolveKeymap`);
- no `classic`, a largura do chat usa Ctrl+←/→ **[proposta]**; os contextos de atalho são `global` e `decision` **[proposta]**;
- os avisos de ambiente (Option e Fn no macOS, Ctrl+B no tmux, VS Code) são **[hipótese: não confirmada em terminal real]**;
- `maxOldSpaceMB` ficou sem teto, como no plano; a medição e a proposta de padrão vieram no P8;
- as superfícies `web` e `desktop` existem só como tipo, e as abas Agenda e Plugins não entraram.

### P8. `packages/tui`: base, desempenho e testes (N37; N185)

**Escopo:**
- o pacote `packages/tui`, com `ink` 8.0.0 e `react` 19.3.1 travados, e o comando de abrir: `ot tui`, e `ot` sem argumento abre a TUI quando o terminal é interativo, numa chave `ui.*` de modos `tui | help` (N195);
- tela cheia no buffer alternativo, redesenho ao redimensionar e a volta limpa do terminal na saída, no Ctrl+Q, no erro e no sinal;
- desempenho da N37: `keyRender: flush`, memoização, o lançador com `--max-semi-space-size` e `--max-old-space-size` de `ui.runtime`, e o patch do `output.js` carregado por gancho de módulos, **recusado se a versão do Ink não for 8.0.0** (a trava que faltava no spike);
- `react-i18next` com o catálogo do P7, trocando por `ui.locale` sem reiniciar;
- a base de testes: `ink-testing-library` com um daemon de teste (`fake-agent`, store em memória) e um auxiliar que escreve teclas e lê quadros;
- a regra de lint de texto de tela fora do catálogo (N50) no `packages/tui`;
- a medição do `maxOldSpaceMB` com um histórico de conversa grande, para propor o padrão.

**Aceite:** a TUI abre, mostra o estado do daemon e fecha devolvendo o terminal como estava; com outra versão do Ink, o patch é recusado e a TUI roda sem ele; trocar `ui.locale` muda o texto na hora; a regra de lint reprova um texto escrito direto num componente.

**Estado:** feito em 2026-11-20, PR #210. Pacote `packages/tui` com `ink` 8.0.0, `react` 19.3.1, `react-i18next` 17.1.13 e `i18next` 26.6.0; de desenvolvimento, `@types/react` 19.3.0 e `ink-testing-library` 4.0.0. Chave nova: `ui.bare_command: tui | help`, padrão `tui` (N195). 61 testes no pacote e 8 da regra de lint.

**Divergências:**
- **`maxOldSpaceMB`: proposta de 256, medida** (Node v24.18.0, `--max-semi-space-size=2`). Uma janela de 1.000 mensagens tem pico de 122 MB (passa com 128 MB e aborta com 96 MB); 200 mensagens, 46 a 61 MB; 50, 33 a 49 MB; desenhar as 5.000 chega a cerca de 1,5 GB, com 0,9 a 2,8 s por atualização, e é inviável. O padrão é decisão do dono, e a chave segue sem teto até lá;
- o `@inkjs/ui` não entrou (entra no P9), nem `zod` nem `zustand` no pacote;
- a TUI só lê `ui.render` e `ui.runtime` de forma tolerante, com os padrões repetidos em `settings.ts`, porque o P8 correu junto com o P7; `coalesceMs` e `historyWindow` são lidas e ainda não usadas. A ligação ao `loadUiCatalogs` do P7 é um ajuste que resta;
- o patch `cache,grid` não mostrou ganho na carga sintética **[N]** (o ganho do spike era no eco de teclas);
- a ligação daemon→TUI é só pelo `cli.ts`, com `import('@otheater/tui/launcher')`; o lançador é leve (sem ink nem react) e dá `spawn` de `node [flags V8] <tui>/dist/main.js --data-dir <dir>`, com a configuração `ui` em JSON na variável `OT_TUI_UI`. As regras do depcruise `tui-never-daemon` e `tui-launcher-only-from-cli` guardam essa fronteira;
- o patch do Ink é recusado fora da 8.0.0 (`version_mismatch`, com aviso na tela); o arquivo copiado entra em `tools/verify/copied-code.json`;
- o `eslint .` passou a usar 5 a 6 GB, e o lint importa `tools/eslint-rules/dist`: o `build` vem antes do `lint` (o `pnpm check` já faz nessa ordem);
- a base de testes usa um daemon real em processo, sem clientes; a jogada com o `fake-agent` fica para o P12.

### P9. Layout: lateral, chat, painel de abas, rolagem e paleta (§5.13)

**Escopo:** o layout comum da §5.13 e do mockup: a lateral retrátil (Alt+S) que vira trilho com os cenários e as barrinhas de cota; o chat em altura total com largura ajustável (Ctrl+Shift+←/→ e foco na borda); o painel de abas que abrem e fecham (Alt+A, Alt+W, Alt+J); as seções recolhíveis (Enter); a rolagem virtualizada; a paleta (Alt+K, F1); a barra de atalhos com as teclas ativas; os formulários e seletores sobre o `@inkjs/ui`; o estado persistido pelo `LayoutStore`. As abas entram vazias e cada passo seguinte preenche a sua.

**Aceite:** com `ink-testing-library`, as quatro telas do mockup saem no layout esperado; a rolagem de 5.000 mensagens desenha só o que cabe na tela; o layout volta igual depois de fechar e abrir a TUI.

**Estado:** feito em 2026-11-21, PR #216 [S: descrição do PR; a chave, os contextos, o grupo e os marcadores conferidos no código da main]. Layout em `packages/tui/src/layout/` (`shell.tsx`, `geometry.ts`, `sidebar.tsx`, `chat.tsx`, `panel.tsx`, `scroll-list.tsx`, `overlays.tsx` e outros); leitura de teclas em `packages/tui/src/keys/`. O `LayoutStore` é o de `packages/client/src/layout/store.ts`, aberto pelo TUI ao conectar (`openLayout`) e gravado ao sair; `ui.layout.store: daemon` (padrão) grava pela rota REST e `local` grava `layout.tui.json` na pasta de configuração do cliente. Sem o daemon, a tela de status do P8 continua. Entrou a dependência `@inkjs/ui` 2.0.0 (N185), com `pnpm-lock.yaml` e `THIRD_PARTY_NOTICES.md`. Chave nova `ui.tuiLayout` **[proposta]**: `sidebarWidth` (30; 16 a 80), `railWidth` (5; 3 a 16), `minChatWidth` e `minPanelWidth` (30; 20 a 200), `chatStep` (2; 1 a 20) e `scrollStep: page | half | line` (`half`). No registro de interface: contextos novos `chat`, `edge`, `sidebar`, `panel` e `overlay`, grupo `navigation` (19 ações) e `layout.focusNext` e `layout.focusPrev`.

**Divergências:**
- **o painel fechado (Alt+J) e a aba ativa ficam como marcadores em `collapsedSections`** (`layout.panelClosed` e `layout.activeTab.<id>`), porque o registro de preferências do `LayoutStore` não tem campo para eles; o painel não os enxerga como seções dobradas [V: `use-layout.ts`]. Dar campos próprios muda o protocolo e o daemon: **ponto aberto para o dono**, não decidido aqui;
- as abas entram vazias, com o conteúdo no mapa `TAB_CONTENT` (`layout/tab-content.ts`), que cada passo seguinte preenche [V];
- a única tecla fixa é Ctrl+C (interrupção do terminal); todas as outras passam pelo mapa de teclas do P7 [S]. F1 abre a paleta, e a ajuda completa sai por ela (`help.show`); Tab e Shift+Tab percorrem chat, borda, painel e barra lateral; na borda, as setas movem a largura do chat [S];
- marcadores da barra lateral: `!` decisão, `●` rodando, `✓` concluído, `○` parado; não há `✗` porque os stores não trazem jogada que falhou. Barras de cota: `█` para 5h e `━` para 7d [S];
- o sinal de fluxo perdido tem texto (`layout.link.syncing` e `layout.link.lost`), e o aviso do mapa de teclas ocupa a linha da barra até a primeira tecla [S];
- o chat não acompanha a última mensagem enquanto a pessoa rolou para cima [S];
- a entrada de texto é provisória, de uma linha (`input-slot.tsx`), e as mensagens vêm por prop: o P12 troca pela caixa do P10 e pelo `/v1/chat`. O cartão de decisão é do P12 [V: `input-slot.tsx`];
- F6 (Plugins) fora, como no registro do P7, e sem mouse (P11);
- o `eslint .` precisa de `NODE_OPTIONS=--max-old-space-size=8192` nesta máquina [S].

### P10. Caixa de texto do Produtor (N35; §5.13)

**Escopo:** o comportamento da caixa dos agentes de código, como na §5.13: Enter envia; Ctrl+J e Shift+Enter (onde o terminal distingue) fazem nova linha; a edição do readline; o histórico com ↑/↓, Ctrl+R e Ctrl+G no `$EDITOR` (a TUI se suspende e volta); a colagem por bracketed paste, com a colagem longa virando marcador `[Pasted text #n]` e anexo; Ctrl+V com imagem pela ferramenta do sistema, virando anexo `A<n>`; caminho de arquivo existente colado virando anexo.

**Aceite:** cada tecla da tabela da N35 tem teste; uma colagem de 2.000 linhas vira marcador e o anexo guarda o texto inteiro; sem a ferramenta de imagem instalada, o Ctrl+V diz o que falta e não trava.

**Estado:** feito em 2026-11-21, PR #213 [S: descrição do PR; as chaves, o contexto e as ações conferidos no código da main]. Componente `TextBox` em `packages/tui/src/input/` (reducer `reduceBox` com efeitos, edição por grafema com anel de recortes, histórico, marcadores, imagem da área de transferência e editor externo). Contexto novo `textBox` e ações `input.*` (grupo `input`) no registro de interface, para o preset (`agents` ou `classic`), o ambiente e `ui.keymap.overrides` valerem para elas. Chaves `ui.input.*` **[proposta]**: `paste.mode: marker | inline` (`marker`), `paste.lines` (10) e `paste.chars` (2.000), `dropPaths: attach | text` (`attach`), `history.store: file | memory` (`file`) e `history.size` (500), `editor: auto | off` (`auto`), `maxVisibleLines` (8) e `image.tool: auto | wl-paste | xclip | osascript | powershell | off` (`auto`), `image.timeoutMs` (3.000) e `image.maxBytes` (20 MiB).

**Divergências:**
- **as chaves ficam em `ui.input.*` (inclusive `ui.input.image.*`), e não em `ui.clipboard`**; `ui.clipboard.copy` continua sendo só a cópia de texto do P11 (N36) [V: `UiInputConfigSchema`, em `packages/protocol/src/ui-config.ts`];
- a caixa não envia anexos: o dono do componente (P12) chama `bindAttachments` com o id do cenário, que troca o número do marcador pelo `A<n>`. Imagem e arquivo vão como `{path, mode: 'copy'}`, e a colagem longa como `{text, name}` [S];
- o histórico guarda só o texto, então os marcadores de anexo não sobrevivem a um reinício [S]. O arquivo do histórico vem da pasta de dados, nunca do HOME real [S];
- o arquivo temporário da imagem só é apagado ao desmontar a caixa, para a recuperação pelo histórico valer na sessão [S];
- Shift+Enter só se distingue de Enter com o protocolo kitty de teclado [V: `input/keys.ts`]. O PR diz que a opção `kittyKeyboard` do Ink, em `run.tsx`, fica com o P9 ou o P12, mas ela **não existe na main** [V: busca em `packages/tui/src`]: ligar o protocolo é um item pendente. Sem ele, Ctrl+J e Alt+Enter fazem a nova linha. Esc (`input.cancel`) só age dentro da busca do histórico [S];
- vários caracteres que chegam juntos, sem colagem entre colchetes, são tratados como colagem, inclusive na busca do Ctrl+R [S];
- só o `wl-paste` foi exercitado, e só em parte; `xclip`, `osascript` e PowerShell foram escritos pela documentação e não rodaram **[hipótese]** [S]. Os testes usam portas falsas (área de transferência, editor e sistema de arquivos);
- ligar a caixa ao layout e ao envio real é do P12.

### P11. Mouse e cópia (N34, N36; §5.13)

**Escopo:** a camada de mouse própria (liga `?1000h` e `?1006h`, lê os eventos SGR, acha a caixa clicada pelo `useBoxMetrics` descontando a rolagem, e não deixa sequência cortada vazar para a caixa de texto): roda, clique em abas, seções, lateral e opções de decisão, e arrasto da borda do chat. A seleção própria dentro de uma área, copiada por OSC 52 ou pela ferramenta do sistema (`ui.clipboard.copy`). `ui.mouse: wheel | off` devolve a seleção normal do terminal.

**Aceite:** sequências SGR gravadas (incluindo cortadas ao meio) chegam como eventos e nada delas aparece na caixa de texto; o clique em cada área faz a ação; a cópia sai como OSC 52 válido.

**Estado:** feito em 2026-11-21, PR #218 (mesclado às 05:45 UTC) [S: descrição do PR; os modos, o `auto`, os limites e a cópia conferidos no código da main]. Camada em `packages/tui/src/mouse/`: `sgr.ts` (`SgrMouseParser`, que segura prefixos cortados), `stdin-tap.ts` (o Ink descarta CSI que não vira tecla, então a camada se põe no `stdin.read`; um Esc solto passa depois de 20 ms), `modes.ts`, `registry.ts` (hit-test por `measureElement`, com recorte pelos `overflow: hidden`), `selection.ts`, `clipboard.ts` e `target.tsx` (`useMouseTarget`, `ClickTarget` e `MouseModalScope`). Ligações: roda no chat, no painel e no `ScrollList`; clique em aba, ✕, `+` e `⟩`; cabeçalhos de seção; cenários, seções, configurações e `«` da lateral; arrasto da borda do chat; seleção e cópia nas listas; overlays modais. Chaves: `ui.mouse` (`full` padrão, `wheel`, `off`; já existia no protocolo), `ui.clipboard.copy` (`osc52` padrão, `system`, `auto`, `off`; o `auto` é novo) e o bloco novo `ui.tuiMouse` **[proposta]**: `wheelLines` (3; 1 a 50) e `copyMaxBytes` (100.000; 1 a 10.000.000) [V: `ui-config.ts`].

**Divergências:**
- **correção da N36: só `off` devolve a seleção normal do terminal.** No modo `wheel` o rastreio continua ligado (`?1000h` e `?1006h`) e o terminal só deixa selecionar com Shift+arrasto, que funciona na maioria dos terminais [V: `mouse/modes.ts`; o Shift+arrasto não foi testado num terminal real, [N]]. O texto da N36 dizia que `wheel` e `off` devolviam; ele foi corrigido em [docs/13](13-DECISOES-EM-ABERTO.md);
- o modo `full` liga também `?1002h`, para o arrasto; o `wheel` liga só `?1000h` e `?1006h`; desligar é idempotente [V: `modes.ts`];
- **o modo `auto` da cópia faz o contrário do que o PR diz.** O PR descreve "OSC 52 e, se o terminal não for confiável, a ferramenta do sistema"; o código escolhe a **ferramenta do sistema quando a sessão não é remota (sem `SSH_*`) e há uma ferramenta instalada**, e o OSC 52 nos outros casos [V: `mouse/clipboard.ts`]. O padrão continua `osc52`. O OSC 52 passa pelo tmux embrulhado em `\x1bPtmux;...` (`tmuxPassthrough`), e a cópia devolve `too_long`, `no_tool` ou `tool_failed` [V];
- `ClickTarget` é o ponto de registro genérico, e o PR diz que o P12 o usa nas opções de decisão. **O código do chat não o usa**: não há uso de mouse em `packages/tui/src/chat/` [V: busca no código da main]. O clique nas opções de decisão ficou sem ligação (a decisão responde por tecla); ver a N200;
- `SectionControl` ganhou o campo opcional `toggle`, compatível com o contrato anterior [V: `layout/section.tsx`];
- fora: mouse X10 legado, duplo e triplo clique; seleção dentro das abas do painel (cada aba teria de informar `rows`); clique nas opções da paleta e do seletor de abas (os overlays são modais, só a roda da ajuda); a região viva é suposta na origem do terminal [S];
- não verificado num terminal real: Shift+arrasto, OSC 52 nos terminais e no tmux, e as ferramentas do sistema **[N]**. Os testes usam bytes exatos (`Copied 17 characters.`) e a árvore Ink real [S].

### P12. Chat: conversa, decisões e comandos `/` (§5.3, §5.13, §5.20)

**Escopo:** o chat com o Diretor pelo `ChatSocket`, com resposta em fluxo, estado do Diretor (ativo, em turno, adormecido) e os dados da peça no topo (título, etapa, decisão pendente); as decisões do Produtor como lista navegável (setas ou número, Espaço na escolha múltipla, Enter); o `/` com autocompletar a partir do `GET /v1/commands` (P3), a confirmação dos comandos que pedem e a resposta dos comandos do daemon na própria conversa; os anexos do P10; a troca de cenário pela lateral; a fila quando o Diretor está em turno; e o Esc parando a resposta do Diretor, sem pausar a peça.

**Aceite:** contra o `fake-agent`, uma necessidade pedida no chat vira peça, uma decisão é respondida por tecla e a peça segue; `/status` responde sem turno do Diretor; uma queda do socket no meio da resposta volta sem perder nem repetir texto.

**Estado:** feito em 2026-11-21, PR #220 (mesclado às 06:25 UTC) [S: descrição do PR; as chaves, o `/stop` e o cartão conferidos no código da main]. Chat em `packages/tui/src/chat/` (`model.ts`, `session.ts`, `card.ts`, `lines.ts`, `suggest.ts`, `use-chat-panel.tsx`) sobre o `ChatSocket` do `packages/client`: resposta em fluxo por `replyId`, estado do Diretor, dados do cenário no topo, decisões (`producer_question`, `producer_menu`, `ideas.group`) como cartão com setas, número, Espaço e Enter, `/` com autocompletar por `GET /v1/commands` e confirmação, fila e Esc. O `input-slot.tsx` provisório saiu; a caixa é o `TextBox` do P10 com `bindAttachments`, mais as props `complete` e `onRows`. **`/stop`** é um comando embutido do daemon (`deps.directors?.interrupt`): interrompe só o turno do Diretor, sem pausar a peça [V: `slash/builtin.ts`]. Chaves `ui.chat.*` **[proposta]**: `queue` (`daemon` padrão, ou `hold`, em que a TUI retém a mensagem até o Diretor liberar), `suggestions` (6; 0 a 30; 0 desliga), `decisionFocus` (`auto` padrão, em que o cartão toma o teclado ao chegar, ou `manual`, só depois de abrir com Ctrl+O) e `esc` (`stop` padrão, ou `off`) [V: `UiChatConfigSchema`].

**Divergências:**
- **o cartão de decisão lê as teclas direto pela combinação**, e não pelas teclas remapeáveis de `decision.answer` [V: `cardKeyOf`, em `chat/card.ts`]. O `ui.keymap` não muda as teclas do cartão; ver a N203;
- **na primeira abertura de um cenário não há histórico**: o socket novo nasce no fim do log. O cursor guardado entre quedas evita perder ou repetir texto, mas não recupera o que veio antes [S];
- o `busy` do Diretor é aproximado para "em turno" [S];
- a resposta de múltipla escolha vai como uma só string, com os itens unidos por `", "` **[proposta]** [S];
- Enter completa a sugestão de `/`, sem tecla separada para aceitar; com a busca do histórico ativa, o Esc cancela a busca e pode também enviar `/stop`; o menu só oferece motivo opcional para `refuse` (e texto obrigatório para `redefine_need`) [S];
- o clique nas opções de decisão (`ClickTarget`, P11) **não foi ligado**: o P12 diz "não depende do mouse" [S] e o código não o usa [V]. O histórico da caixa fica em `<dados>/tui/input-history.json`, e a linha de estado do chat é cortada na largura do chat [S];
- o teste de aceite fica no pacote da TUI, porque a regra `tui-launcher-only-from-cli` proíbe o daemon de importar a TUI [S].
- **o `chat.e2e.test.tsx` falhava de vez em quando na CI** (Linux e macOS, nas ondas 3 e 4), por asserções lidas logo depois da tecla: a espera do cartão casava com quase qualquer quadro, o eco da resposta casava com o próprio cartão, e a linha de estado tem tique próprio (`state_interval`). O PR #229 (mesclado em 2026-11-21, 706a1b9 [V: `git log`]) fez as esperas aguardarem o cartão, o eco e os dois textos no mesmo quadro, só no teste; não se achou corrida no produto [S]. Passou 10 de 10 seguidas e 10 de 10 sob carga, local, e a CI ficou verde nos três sistemas [V]. A falha antiga não foi reproduzida no código anterior, então a causa vem da leitura do código e dos quadros [S].

### P13. Visão geral e Consumo (§5.13)

**Escopo:** a Visão geral com pipeline, demandas em lista com dependências (`D4 ← D2, D3`), Atores ativos com tempo restante, eventos recentes e cota por assinatura, alimentada pelos stores (P1); os controles de pausar e retomar a peça e o Ator (P2), com confirmação. A aba Consumo com `/v1/usage` e `/v1/budget`. Os painéis de telemetria são da Fase 8.

**Aceite:** a Visão geral acompanha uma peça inteira do `fake-agent` sem leitura REST a cada evento; pausar pela aba produz o mesmo efeito do `/pause`.

**Estado:** feito em 2026-11-21, PR #219 (mesclado às 06:04 UTC) [S: descrição do PR; os stores, as chaves e o contrato conferidos no código da main]. Cliente: store `activity` (`stores/activity.ts`, montado só pelos eventos), `views/overview.ts`, `views/usage.ts` e `views/controls.ts` (`runControl` traduz o erro em resultado, sem lançar). TUI: `tabs/overview/` e `tabs/usage/`, registradas em `TAB_CONTENT`, e **o contrato de aba**: `layout/tab-types.ts` (`TabContentProps`, `TabDefinition`, tirados de `tab-content.ts`, que os reexporta, para não fechar um ciclo no `pnpm deps`) e `layout/tab-host.tsx` (`TabHostProvider` e `useTabHost()` entregam à aba `{stores, client, keymap, settings, now}`) [V]. Chaves **[proposta]**: `ui.overview.confirm` (`always` padrão, ou `off`), `ui.overview.recentEvents` (8; 1 a 100), `ui.overview.hiddenEvents` (`['session.update']`), `ui.usage.groupBy` (`profile` padrão; `executor`, `play`, `session`, `none`) e `ui.usage.refreshSeconds` (30; 0 a 3.600; 0 é só ao abrir e sob demanda) [V: `ui-config.ts`]. Teclas no contexto `panel`: Shift+P e Shift+R (pausar e retomar a peça), Shift+N (próximo Ator), Shift+A e Shift+U (pausar e retomar o Ator) e Shift+L (atualizar o Consumo) [S].

**Divergências:**
- **não há rota que liste tentativas**: o store `activity` só conhece Atores abertos depois que a TUI conectou, e o mesmo vale para uma pausa anterior à conexão [S: o PR]. Ver a N200;
- **`ApiPlay` não traz o flag de pausa**; por isso "retomar" é oferecido sempre que a peça está aberta, e um 409 aparece como mensagem ("nada a fazer") [S];
- o **tempo restante do Ator é uma estimativa** **[proposta]**: `startedAt + timeoutMin * 60000 - now`, com `startedAt` do primeiro `session.opened` da tentativa; o cronômetro do daemon é quem decide [V: `views/overview.ts`];
- **`session.closed` com `interrupted` chega antes de `attempt.paused`** (o runner escreve nessa ordem), então o store mantém a tentativa em curso nesse caso, para o Ator não sumir da lista ao pausar [V: `stores/activity.ts`];
- as teclas Shift+P/R/N/A/U/L eram escolha da onda, não do plano; a linha de controles rola junto com o conteúdo, e o Ator se escolhe por Shift+N, sem clique [S];
- o aceite foi provado em `overview-tab.e2e.test.ts` (daemon de teste e `fake-agent`, contando as chamadas REST depois do snapshot) e a pausa pela aba produz as mesmas listas de eventos que o `/pause` [S].

### P14. Trajetórias (§5.11, §5.13)

**Escopo:** a aba Trajetórias, ao vivo e histórica, com os passos expansíveis (turnos, chamadas de ferramenta, permissões, saída de terminal do Ator quando o cliente a manda) e os diffs, a partir dos eventos e do blackboard. O formato ATIF é da Fase 8. O comando `/trajectory` entra aqui.

**Aceite:** a trajetória de uma peça do `fake-agent` mostra todos os turnos, abre e fecha cada passo e mostra o diff da demanda.

**Estado:** feito em 2026-11-21, PR #224, mesclado em 2026-11-21 (22b271d) [V: `git log`] [S: descrição do PR; o detalhe abaixo não foi conferido linha a linha no código]. Protocolo: `buildTrajectory` (função pura que dobra os eventos de uma peça em tentativas, turnos e entradas: mensagem, pensamento, chamada de ferramenta, resultado, permissão, plano e saída de terminal), os esquemas das rotas e `ui.trajectories`. Daemon: serviço de trajetória, rotas `GET /v1/plays/:playId/trajectory` (paginada, com cursor) e `GET /v1/plays/:playId/demands/:demandId/diff` (por `Vcs.diffBetween`), o bloco `trajectory` no registro de comandos `/` (**`/trajectory`**) e o catálogo `api-routes.json` regenerado. Cliente: store `trajectories` (reducers puros, histórico paginado e eventos ao vivo), `loadTrajectory`, `loadDemandDiff` e `setTrajectoryKeep`. TUI: `packages/tui/src/tabs/trajectories/`, em `TAB_CONTENT`. Chaves `ui.trajectories.*` **[proposta]**: `open` (`last` padrão, `all`, `none`: quais passos começam abertos), `keep` (5.000; 100 a 100.000: eventos de trajetória guardados por peça no cliente) e `diff_lines` (200; 10 a 10.000: linhas do diff antes do corte).

**Divergências:**
- **o contrato de aba foi estendido** [S]: `TabContext {stores, scenarioId, settings}`; `TabContentProps` o estende; `TabDefinition.sections` pode ser uma função `(context, folded)`, e `TabDefinition.watch` lista os stores que reavaliam as seções; o `shell.tsx` ganhou a prop `settings` e o gancho `use-watched.ts`. Isso convive com o `TabHost` do P13 e com o `capture` do P15; a unificação é da N199;
- ids de seção curtos por posição (`trajectories.a<n>`, `.a<n>.t<m>`, `.a<n>.diff` e `trajectories.transitions`); o estado final é o padrão `open` com a inversão dos toggles guardados no `LayoutStore` **[proposta]** [S];
- a peça mostrada é a mais recente do cenário selecionado, e o diff pende da última tentativa de cada demanda **[proposta]** [S]. Peças terminadas só aparecem na barra lateral se a opção `plays` do hub for `all`; senão, vale `/trajectory <peça>` [S];
- **a saída de terminal do Ator não aparece**: o construtor reconhece `terminal.output`, mas nada no daemon emite esse evento [S]. A aba a mostrará quando o cliente a mandar (ver a N200);
- ATIF ficou de fora (Fase 8), como no plano [S].

### P15. Ordens (§5.17)

**Escopo:** a aba Ordens: vigentes, agendadas e encerradas por escopo, a linha do tempo da vigência e os prazos; criar, prorrogar, suspender e revogar pelas rotas `/v1/orders` que já existem.

**Aceite:** cada ação muda o estado na aba pelo evento `directive.*`, sem recarregar.

**Estado:** feito em 2026-11-21, PR #221 (mesclado às 06:49 UTC) [S: descrição do PR; o campo `order` e o contexto conferidos no código da main]. Aba `directives` (rótulo "Diretrizes") em `packages/tui/src/tabs/directives/` (`view.ts`, `form.ts`, `line-input.ts`, `directives-tab.tsx`): ordens vigentes, agendadas e encerradas por escopo, com a linha do tempo da vigência e os prazos, e quatro formulários (dar, prorrogar, suspender, revogar) pelas rotas `/v1/orders` que já existiam. Cliente: store `orders` (`reduceOrders`, `installOrders`, `settleOrder`, `orderStateAt`, `ordersInOrder`), `DaemonStores.orders` e `DaemonStores.client`, e `ApiClient.createOrder`, `extendOrder`, `suspendOrder` e `revokeOrder`, todos com `Idempotency-Key`. **O evento `directive.created` passou a levar a ordem inteira no campo opcional `order`** **[proposta]**, para a lista se montar só dos eventos [V: `directive-events.ts`, `order: DirectiveRecordSchema.optional()`]; sem ele, o store marca a ordem como defasada e relê só ela (`getOrder`), nunca a lista [S]. **Nenhuma chave de configuração nova**: as teclas são ações do registro, trocáveis por `ui.keymap`; no contexto `panel`: `n` (nova), `e` (prorrogar), `s` (suspender), `r` (revogar), `Shift+↑` ou `k` (anterior) e `Shift+↓` ou `j` (próxima) [S].

**Divergências:**
- **`capture` do teclado**: o Shell dá a uma aba que age o `TabEnvironment` (`layout/tab-environment.tsx`: stores, mapa de teclas e `capture`), com retorno antecipado quando um formulário tem o teclado, e o `focused` da aba passou a excluir sobreposição aberta (paleta, ajuda, seletor) [S]. **Os arquivos `tab-environment.tsx` e `tab-props.ts` não existem na main**: o PR #221 mexeu no `tab-host.tsx` do P13, que ganhou o `capture`, e `TabContentProps` ficou em `tab-types.ts` [V: `git log` e a listagem de `packages/tui/src/layout/`]. O contrato final está na N199;
- o formulário de ordem nova cobre instrução e regra; a suspensão sai pela ação "suspender"; **o campo de papéis (`roles`) e a substituição de uma ordem (`replaces`) não são oferecidos** [S]. O campo de uma linha é próprio (`line-input.ts`), não o `TextBox` do Produtor [S];
- a aba não tem tecla própria para abrir (abre pela paleta ou por Alt+A) [S];
- as teclas `n`, `e`, `s`, `r` e `j`/`k` podiam colidir com as de P13, P14 e P16 no contexto `panel`; o orquestrador resolveu com um contexto por aba, no PR #222 (**[proposta]**, N199). Os testes de integração rodam num daemon de teste em memória e provam que não há `GET` depois da ação [S];
- as ações ficam no grupo `navigation`, porque `derive.test.ts` fixa a lista de grupos [S].

### P16. Configurações: Assinaturas, Executores, Papéis e Limites (§5.13; N186, N188)

**Escopo:**
- **Assinaturas:** estado, cota, reset, adicionar e remover (as rotas de perfis), e o login oficial pelo P5 num painel da TUI (URL e código na tela, campo para o código do navegador); no modo `terminal`, a TUI se suspende e roda o login no próprio terminal;
- **Executores:** modelo e esforço a partir das config options;
- **Papéis:** a lista ordenada por prioridade, reordenada com Shift+↑↓, e a regra `next`/`wait`;
- **Limites:** a predefinição e as chaves de `limits`;
- o escopo global com override por projeto;
- a gravação pelo `PUT /v1/config`, com o efeito da N188.

**Aceite:** com perfis falsos, o login pelo painel termina; reordenar papéis grava a ordem nova; uma configuração inválida mostra a chave que falhou e não grava.

**Estado:** feito em 2026-11-21, PR #222, **ainda aberto ao escrever isto** [S: descrição do PR; nada foi conferido no código da main [N]]. Duas partes. **N188 (reload a quente):** `packages/daemon/src/config-hot.ts` com as seções quentes `ui`, `chat`, `limits` e `roles`, `splitByReload` e `applyHotSections`; o `PUT /v1/config` responde `{appliesOn: hot|restart|mixed, set, removed, hot, restart}`, emite `config.edited` (com `appliesOn`) e, quando há chave quente, `config.changed {hot, restart}`, evento novo no catálogo; fila de promessas por arquivo em `config-edit.ts`, contra a corrida com o assistente de configuração (P4); getters nos consumidores (`deps.ts`, `wiring.ts`, `execution/settings.ts`) para seguir os valores quentes. **N186 (login oficial):** a aba `settings` em `packages/tui/src/tabs/settings/`: **Assinaturas** (estado, cota viva do store `quotas`, reset, adicionar com `A` e remover com `X`, com confirmação; chave de API em campo mascarado; `needs_notice` pede confirmação e reenvia com `acceptNotice`), **login oficial** com `L` (só `token_plan`: modo, URL, código e campo para o código do navegador; o fim vem por `profile.login.completed` ou `failed`; no modo `terminal` a rota responde `local` e a TUI se suspende e roda o login no próprio terminal), **Executores** (lista com validade e papéis, **somente leitura**), **Papéis** (`Shift+↑/↓` move o Executor e grava a lista inteira; `E` alterna `next` e `wait`; `U` volta ao padrão) e **Limites** (`preset`, contagens, durações e `on_turn_timeout`; `E` e `U`), com `S` alternando o escopo global e o de projeto. A aba recarrega só quando um evento diz que o que ela mostra mudou (`profile.*`, `executor.changed`, `config.changed`, `config.edited`), com debounce. Ações `settings.*` no contexto `panel`, só TUI, remapeáveis por `ui.keymap` (`K`, `J`, `Shift+↑`, `Shift+↓`, `L`, `A`, `X`, `E`, `U`, `S`). **Nenhuma chave nova no `config.yaml`**: a aba edita `roles.*` e `limits.*`, que já existem.

**Divergências:**
- **só o `PUT /v1/config` emite `config.changed`**: as gravações do assistente (P4), as do serviço de Executores e a edição à mão só entram nas seções quentes no próximo `PUT` (que ressincroniza as seções do arquivo) ou no reinício; uma peça em andamento mantém os limites com que abriu [S]. Ver a N202;
- **`appliesOn`** (`hot`, `restart` ou `mixed`) diz, em cada gravação, o que vale já e o que vale no reinício, como a N188 pedia [S];
- **o override por projeto é só leitura**: a aba mostra o `configOverride` do cenário, mas nenhuma rota o grava. **O modelo e o esforço dos Executores não se editam**: a aba lista, mas não há rota de catálogo de config options. O escopo do plano ("modelo e esforço a partir das config options") fica, então, em leitura [S]. Ver a N202;
- os valores de `limits` vêm de `GET /v1/config` já resolvidos, e a aba não distingue o valor escrito do valor da predefinição [S];
- **contextos de tecla por aba, [proposta] do orquestrador**: cada aba ganhou o seu contexto no registro (`overview`, `usage`, `trajectories`, `directives` e `settings`, em `packages/client/src/ui/keys.ts` e `default-registry.ts`), para a mesma tecla ter ações diferentes em cada aba sem colidir. O orquestrador decidiu isso ao integrar as abas da onda 3, e a arquitetura não fixa o desenho [S: o PR; na main, `UI_CONTEXTS` ainda tem só `global`, `decision`, `textBox`, `chat`, `edge`, `sidebar`, `panel` e `overlay` [V]]. Ver a N199;
- a infraestrutura `PanelContext` (stores, mapa de teclas, `capture` e id do cenário) é fornecida pelo `shell.tsx`, e `capture(true)` faz o shell largar as teclas enquanto um campo de texto está aberto [S]. É a terceira forma do contrato de aba (depois do `TabHost` do P13 e do `TabContext` do P14), e o orquestrador as unificou no PR [S];
- a corrida do P4 com o `PUT` foi resolvida por fila de promessas por arquivo, e não por trava de arquivo [S].

### P17. Assistente de configuração na TUI (§5.7)

**Escopo:** a TUI desenha os passos que o daemon manda (P4), com voltar e retomar; a primeira execução, sem configuração, abre nele; o mesmo desenho serve para adicionar conta e trocar a predefinição.

**Aceite:** do zero, com perfis falsos, o assistente vai até a confirmação só pela TUI; fechar a TUI no meio e abrir de novo volta ao mesmo passo.

**Estado:** feito em 2026-11-21, PR #227, mesclado em 2026-11-21 (f0e8f0d) [V: `git log`] [S: descrição do PR; da branch `fase7/p17-assistente` só foi lido o esquema `UiSetupConfigSchema`, com `open: auto` e `readTimeoutMs: 5000` de 100 a 60.000 [V na branch]]. Em `packages/tui/src/setup/`: `api.ts` (`SetupApi`, a face tipada das seis rotas do P4, com `Idempotency-Key` por comando), `model.ts` (o rascunho de cada passo, puro), `lines.ts` (as linhas de cada passo, o plano da revisão e as telas de fim), `setup-screen.tsx` (progresso, passo, prompts de Executor e de teto, cancelar com `y/n`, ler de novo com `R`) e `first-run.ts` (lê `firstRunNeeded` com prazo). A TUI lê `GET /v1/setup` ao abrir e, com `firstRunNeeded` e `ui.setup.open: auto`, entra direto no assistente (`first_run`); `ot` e `ot tui` abrem a TUI (N195), então o primeiro uso cai aqui. Na aba Configurações: `W` (adicionar conta, `add_account`), `P` (trocar preset, `change_preset`) e `Shift+W` (primeira execução, que retoma a que ficou no meio). **Voltar:** `Esc` volta um passo (o daemon desfaz só o estado do passo que sai, e a TUI traz o rascunho de volta); no primeiro passo, `Esc` sai e a execução fica guardada no daemon. **Retomar:** ao abrir, a tela lê `GET /v1/setup`, pega a execução ativa do fluxo (aviso "Retomando...") e só inicia outra se não houver; um `Conflict` no start pega a execução que já existe, e um `Conflict` em outro comando relê a execução e mostra a recusa. O que o daemon recusa aparece com as palavras dele. Nada vai para o `config.yaml` antes do confirm. Contexto de teclas próprio `setup` (avançar `Enter`, voltar `Esc`, item `↑/K` e `↓/J`, marcar `Espaço`, mover conta `Shift+↑/↓`, adicionar `A`, teto `E`, remover `X`, reler `R`, cancelar `C`), com as ações `setup.*` no registro e a barra de atalhos derivada dele; textos só nos catálogos `en` e `pt-BR`. Chaves **[proposta]**: `ui.setup.open` (`auto` padrão, ou `never`: nunca abre sozinho, e a aba Configurações continua abrindo por tecla) e `ui.setup.readTimeoutMs` (5.000; 100 a 60.000: quanto a TUI espera o daemon dizer se precisa de primeira execução; passado o prazo, segue sem o assistente e avisa). Sem rota, evento nem `pnpm api:catalog`: o que não é lido (prazo ou falha do gate) vira o aviso `setup.gateFailed` na TUI, e o daemon não participa dessa leitura. Os testes existentes que passam as configurações padrão ao `renderApp` agora partem de `TEST_UI_SETTINGS` (`setup.open: never`), para o gate não ocupar a tela dos que não são do assistente [S].

**Divergências:**
- **tela própria, e não aba**: o plano dizia "aba/tela"; o assistente ocupa o terminal inteiro, com o contexto `setup`, porque na primeira execução o layout ainda não tem o que mostrar e os três fluxos são a mesma tela **[proposta]** [S]. Ver a N204;
- **o gate não bloqueia**: o layout é desenhado na hora e o assistente toma a tela quando o daemon responde, então pode haver um instante do layout antes do assistente **[proposta]**; a alternativa é segurar o layout até a resposta, ao custo de uma TUI parada num daemon lento [S]. Ver a N204;
- **padrões dos passos [proposta]**: a detecção parte com toda conta usável marcada, na ordem que o daemon lista; o preset parte no que está em uso, ou em `balanced` (o do meio) se o arquivo não nomeia nenhum; nenhum Executor por padrão [S]. Ver a N204;
- **o passo de Executors é um campo de uma linha** (`<conta> <modelo> [esforço]`), e o teto é outro (`<dia> <mês>` em USD, `-` para sem teto), em vez de um formulário. É o mínimo que o daemon aceita: `localUrl`, `localServer`, `family` e `alias` do `SetupExecutorRequest` ficam de fora, e o daemon usa o que a conta tem [S]. **Isso deixa de fora o cadastro do Executor do OpenCode**, que o P4 deixou "para a tela do P17" (acima);
- **fica de fora**: o login oficial (P5: a tela de detecção avisa que não há conta e manda para a aba Configurações), o cadastro de Executor local (URL e servidor), a edição de uma linha de Executor já adicionada (apaga-se com `X` e adiciona-se de novo), o mouse na tela do assistente e reordenar contas depois da detecção (é voltar ao passo e mexer de novo) [S];
- **corrida do gate, corrigida no próprio PR**: na primeira versão o gate decidia com as configurações do processo antes de ler o `ui.setup` do daemon, e um `open: never` do daemon perdia a corrida; a fumaça do P20 pegou isso (os 9 testes abriam no assistente). Agora a TUI espera o `ui.setup` do daemon (`GET /v1/config`, depois que o estado fica `live`), um `never` do processo fecha o gate sem esperar e, se a leitura falha, o gate segue com as configurações do processo **[proposta]** [V: `app.tsx` e `use-daemon.ts` na main];
- **Esc no Windows**: o Ink só conclui um ESC solto depois de uma pausa, e os testes que liam o quadro logo após a tecla falhavam no Windows; os testes passaram a esperar o quadro [V: CI do PR];
- o teste ponta a ponta (`setup.e2e.test.tsx`) roda contra o daemon real, em processo, com HOME e pasta de dados temporários e perfis falsos no store, sem login [S].

### P18. `!` na TUI (N43, N187)

**Escopo:** o `!` na caixa de texto, com o estado do comando em curso, a saída como `terminal_snippet` na conversa, a pergunta da `chat.shell_command.context: ask` e o aviso de que o comando pediu entrada.

**Aceite:** `!ls` mostra a saída na conversa; com `ask`, a TUI pergunta antes de anexar.

**Estado:** feito em 2026-11-21, PR #223, já na main [V: `git log`] [S: descrição do PR; os módulos e os textos do catálogo conferidos no código da main [V]]. O daemon não mudou, e não há chave, evento, rota nem mensagem de WebSocket novos: a TUI usa os frames que já existiam (`message`, `shell_started`, `shell_finished`, `ask`/`answer` e `error`) e as chaves do P6 (`chat.shell_command` e `.timeout`, `.context`, `.max_running`, `app.terminal`, `terminal.snippet.max_lines`). Em `packages/tui/src/chat/`: `shell.ts` (puro: `isShellLine`, `shellCommandOf`, `isShellQuestion`, `oneLine`, `outputLines`, que tira sequências de escape e controles que sobrarem), o `model.ts` (o comando em andamento, o bloco que nasce em `shell_started` e é trocado no mesmo lugar por `shell_finished`, a recusa por código de erro e a ligação entre o `shell_finished` com `context: asked` e a `ask` seguinte), o `session.ts` (`sendShell`: a linha com `!` não espera atrás do turno do Diretor, qualquer que seja `ui.chat.queue`, e não aceita anexo nem comando vazio), `lines.ts` e `layout/chat.tsx` (linha `! comando`, saída atrás de uma barra `│`, notas de código de saída, corte, entrada pedida e o que houve com a saída em relação ao Diretor; quebra dura `breakLine`, em `layout/text.ts`, que preserva colunas e indentação), `card.ts` (`shellModel`, o cartão da pergunta do `ask` com `Send` e `Keep`, sem "Outra") e `use-chat-panel.tsx` (a linha `!` com anexo é recusada antes do upload, e a linha de estado mostra `running: ! comando` ou `N commands running`). Textos em `layout.chat.entry.shell*`, `layout.chat.card.shell.*`, `layout.chat.shellRunning` e `layout.chat.shellNoAttachments`, nos dois idiomas. Testes: unitários de cada módulo e `chat.e2e.test.tsx` contra o daemon com o `fake-agent` (`!ls` na conversa sem virar mensagem ao Diretor; comando em andamento; `ask` com `Send` e com `Keep`; comando que pede entrada; `chat.shell_command: off`), com `app.terminal: host` por não haver sandbox no ambiente de teste [S].

**Divergências:**
- **a pergunta do `context: ask` chega como `producer_question` simples**, em inglês e sem marca de origem. Para não mudar o daemon, a TUI a reconhece pela forma (uma pergunta com as opções `Send` e `Keep`, nessa ordem) e só a trata como a do `!` se um `shell_finished` com `context: asked` a anunciou [V: `isShellQuestion` e `PendingAsk.shell`]. Uma marca no `ask` (por exemplo `source: 'shell'` no `input`) a tornaria explícita; é **[proposta]** e nada foi mudado. Ver a N205;
- **a recusa do `!` chega como um frame `error` genérico**, em inglês, sem dizer que veio do `!` (vale para `chat.shell_command: off`, `conflict`, `unavailable`, `invalid_input` e `not_found`). A TUI a liga ao `!` por um contador de linhas `!` em voo, zerado quando o soquete cai, e mostra a mensagem do catálogo (`shellRefused.<código>`, com `other` de reserva) [V: `chat/lines.ts`]. Ver a N205;
- **a linha digitada (`!ls`) não vira uma entrada "Você"**: o bloco do comando já traz a linha `! ls`, e as duas juntas repetiriam o texto; a recusa aparece como entrada de sistema [S]. Ver a N205;
- **fica de fora**: cancelar um comando em andamento (não há frame para isso no daemon), rolagem ou "ver tudo" da saída além de `terminal.snippet.max_lines` (o resto fica no log do comando, e o bloco diz quantas linhas foram cortadas) e realce da sintaxe ou cores ANSI (o daemon já tira as cores; a TUI tira o que sobrar) [S]. O `!` interativo, com PTY, segue para a N187 e fica fora desta fase.

### P19. Sessão direta com um Ator (N44, N190; §5.20)

**Escopo** (mantida nesta fase pela N190, fora do aceite): a aba de sessão direta no cenário, com o Executor escolhido da lista do perfil, a chave `direct_session.workspace: worktree | readonly | scenario` (padrão `worktree`; `scenario` pede confirmação), a cota e o orçamento do perfil, o lançador e a sandbox, o log e as trajetórias, as permissões pedidas na própria aba, os comandos do cliente e a promoção do resultado a demanda ou peça. Daemon e TUI no mesmo passo, porque um não se testa sem o outro **[proposta]**.

**Aceite:** com o `fake-agent`, a sessão abre, conversa, roda um comando do cliente e é promovida a demanda; com `readonly`, uma escrita é barrada.

**Estado:** feito em 2026-11-21, PR #228, mesclado em 2026-11-21 (15191b6) [V: `git log`] [S: descrição do PR; da branch `fase7/p19-sessao-direta` foram lidos só os padrões de `direct_session` em `config.ts`, o tipo `direct_worktree_stayed` em `notice-events.ts` e a aba no `default-registry.ts` [V na branch]]. Daemon, protocolo, cliente e TUI no mesmo passo, como o plano propunha. **Protocolo:** 9 eventos `direct.session.*` (`opened`, `message`, `tool`, `permission`, `command`, `turn_finished`, `closed`, `promoted`, `refused`, com os códigos de recusa `no_executor`, `waiting`, `not_available`, `too_many` e `failed`), o tipo `direct_worktree_stayed` de `scenario.notice` e 8 rotas com os esquemas em `packages/protocol/src/api/direct.ts` (`POST` e `GET /v1/scenarios/:scenarioId/direct`, `GET /v1/direct/:sessionId`, `POST /v1/direct/:sessionId/messages`, `/commands`, `/cancel`, `/close` e `/promote`); `docs/reference/api-routes.json` regenerado. **Daemon** (`packages/daemon/src/direct/service.ts`, `DirectSessionService`): abre a sessão pelo `RoleSelection` (Executor fora da lista do perfil vira 400 `not_available`; sem cota ou orçamento, 429 `quota_exhausted`; sem Executor, 503), o `SessionPool` conta a cota do perfil, e `directPolicyOf` aplica a política por modo; os turnos correm em segundo plano e a resposta cresce no item da sessão, e vai ao log como um único `direct.session.message` ao fim do turno. `worktree` (padrão): worktree em `<worktreeRoot>/direct/<id>`, ramo `direct/<id>`; ao fechar, commit de tudo, `diffStat`, remoção da worktree, e o ramo fica ou some por `direct_session.on_close`. `readonly`: só `read` e `search`, `editInWorktree: ask` com `onAsk: reject`, sem regras; uma escrita é barrada (decisão `reject`, ferramenta `failed`, arquivo intacto, evento `direct.session.permission`). `scenario`: pede confirmação (`status: confirm`, e o reenvio com `confirm: true`). Em todos os modos, sem `mcpServers`, `mcpTools` nem `nativeShell`, e `bypass` é proibido. Os comandos do cliente (`/fake:fake-command`) passam pelo mesmo filtro do chat (`chat.client_commands`, `_allow` e `chat.slash_access`). **Promoção:** `demand` vira ideia da fila (`ideas.add`, fonte `tui`); `piece` abre uma play (`openPlayFromNeed`; se não puder, 409); o ramo mantido é anexado ao texto. Ação `/direct [executor]` no registro de `/`: abre a sessão e aponta para a aba (para `scenario`, só manda confirmar na aba). **TUI** (`packages/tui/src/tabs/direct/`): aba `direct` (ordem 40, contexto de teclas `direct` em `UI_TAB_CONTEXTS`, entradas no `default-registry.ts`, textos nos catálogos), com o formulário de nova sessão (Executor da lista de perfis válidos, ou "o primeiro que puder"; pasta: a configurada, worktree, somente leitura ou a do cenário), a lista de sessões, a linha de informação, os comandos do cliente anunciados, a conversa (mensagens que crescem, ferramentas, decisões da política, comandos, avisos) e a caixa de texto (linha com `/` vai como comando do cliente). Teclas **[proposta]** no contexto `direct`: `N` nova, `T` escrever, `C` parar o turno, `X` fechar, `D` mandar o resultado à fila de demandas, `P` abrir peça e `Shift+↑/↓` ou `K/J` para escolher a sessão; em modo de escrita ou formulário, a aba toma o teclado (`capture`) e solta com Esc. A recusa por cota ou orçamento aparece como mensagem na aba; a lista é relida nos eventos `direct.session.*`, e a conversa de uma sessão em turno, a cada 400 ms. **Cliente:** `ApiClient.openDirectSession`, `listDirectSessions`, `getDirectSession`, `sendDirectMessage`, `runDirectCommand`, `cancelDirectTurn`, `closeDirectSession` e `promoteDirectSession`. Bloco `direct_session` do config do daemon (sem sobrescrita por cenário): `workspace` `worktree | readonly | scenario` (padrão `worktree`, do plano), `confirm_scenario` `ask | never` (`ask`), `max_open` (3), `on_close` `keep | discard` (`keep`), `history_max` (200), `closed_kept` (10) e `idle_timeout` `off` ou duração (`30m`); todos **[proposta]** menos o `workspace` [V na branch: `max_open` 3, `history_max` 200, `closed_kept` 10, `idle_timeout` com padrão próprio; o resto [S]]. Os contadores dos testes de registro foram atualizados na integração com a main (128 eventos em `registries.test.ts`, 126 em `event-registry.test.ts`) [S]. Testes: `direct.e2e.test.ts` (12, daemon real com `fake-agent`: fluxo completo em `worktree`, `readonly` barrado, `scenario` com confirmação, escolha do Executor e recusa, cota, cancelamento, 404 e 400, promoção a peça numa conversa genérica, ação `/direct`, `max_open` e ociosidade, filtros dos comandos do cliente, `on_close: discard`), `direct-tab.test.tsx` (9), `view.test.ts` (6) e `direct.e2e.test.tsx` (3, TUI contra o daemon real) [S].

**Divergências:**
- **a aprovação de permissões na própria aba não é possível neste passo**: as decisões da camada 2 são síncronas no núcleo, então não há como pausar a sessão esperando o Produtor sem mexer numa porta do core. A aba mostra as decisões da política (itens `decision` e eventos `direct.session.permission`). Aprovar na aba pede uma **porta assíncrona de permissão no core**: decisão do dono. Ver a N206;
- **promoção**: o PR interpretou "demanda" como ideia da fila (`ideas.add`) e "peça" como uma play aberta por `openPlayFromNeed`. A peça só foi exercitada no caminho de falha (409 numa conversa genérica), não de ponta a ponta [S]. Ver a N206;
- **trajetórias**: o P14 já está na main, mas a sessão direta **não alimenta a aba Trajetórias** nem exporta trajetória; grava eventos no log [S]. O plano pedia "o log e as trajetórias". Ver a N206;
- **as teclas da aba** (`N`, `T`, `C`, `X`, `D`, `P`) são escolha do passo, **[proposta]**; mudam pelo registro de ações como as das outras abas [S]. Ver a N204;
- **não há shell em sessão direta**: os shells MCP do daemon e o shell do cliente ficam fora, pela política `directPolicyOf` [S];
- **limite do `readonly`**: um cliente que escreve sem pedir permissão (como o script `write-file` do `fake-agent`) não é barrado pela camada 2; o cwd fica dentro da pasta do cenário. É um risco residual a avaliar [S]. Ver a N206;
- **orçamento**: a recusa passa pelo mesmo mapeamento do `RoleSelection.once` que a cota, mas só a cota tem teste [S];
- **as sessões ficam em memória**: morrem com o daemon (404 depois de reiniciar), e uma worktree órfã pode sobrar depois de uma queda; não há teste ponta a ponta do `shutdown` do daemon fechando as sessões [S];
- **fica de fora**: a exportação de trajetória, a aprovação interativa na aba e as chaves de `direct_session` por cenário [S].

### P20. Terminais: testes de fumaça e roteiro manual (N191; §5.13)

**Escopo** (na forma escolhida na N191):
- um teste de fumaça na CI Linux que abre a TUI num tmux de verdade (instalado no job), manda as teclas do mapa e confere os quadros, como o `spikes/tui-keys`;
- os testes do `ink-testing-library` também nos jobs `cross` (Windows e macOS), que já rodam o `pnpm check`;
- um roteiro manual curto (`tools/acceptance/tui-terminals.md` **[proposta]**) para o dono passar no Windows Terminal e num terminal de macOS ou Linux: teclas, mouse, cópia, colagem, redimensionar, Option como Meta no macOS e SSH. O que não for conferido fica **[N]** na tabela de terminais.

**Aceite:** o teste de fumaça passa na CI; o roteiro existe e foi passado pelo menos no terminal Linux do dono.

**Estado:** feito em 2026-11-21, PR #226, mesclado em 2026-11-21 (40ee0e7) [V: `git log`], com a CI verde e a fumaça 9 de 9 no job linux [V] [S: descrição do PR; da branch `fase7/p20-terminais` foram lidos o esquema `UiRuntimeConfigSchema` (`exitGraceMs` 2.000, de 0 a 60.000), o `ci.yml` (`OT_REQUIRE_TMUX: '1'`) e a lista de arquivos, e o roteiro `tools/acceptance/tui-terminals.md` (as seções 1 a 8 e a tabela, toda **[N]**) [V na branch]]. **Teste de fumaça** `packages/tui/src/tmux.smoke.test.ts` (9 testes) num tmux de socket próprio (`tmux -L <nome único>`), com conf própria, `HOME` temporário, `TERM=xterm-256color` e janela de 120x36, que manda as teclas do mapa por `send-keys` e lê os quadros por `capture-pane`: abre com a lateral, o chat e o painel; troca as abas pelas teclas do registro; esconde e mostra o painel (`Alt+J`) e a lateral (`Alt+S`); abre a paleta, roda um comando e abre a ajuda; manda uma mensagem ao Diretor do `fake-agent` e confere a resposta e o `chat.director_reply` no log; acompanha o redimensionamento (80, 50 e 150 colunas); `Ctrl+Q` encerra sem processo sobrando; `ot` sem argumento abre a TUI (N195); e a **regressão do pty que some** (derruba o servidor do tmux sem `Ctrl+Q` e confere que o processo sai em até 8 s). Cada teste sobe o próprio daemon. Apoio: `tmux.test-support.ts` (`TmuxSession`; o `kill()` mata só o servidor próprio, falha o teste se algum processo sobreviveu e apaga a pasta temporária e o arquivo de socket em `/tmp/tmux-<uid>`) e a `startChatDaemon()` + `dispose()` em `chat/fake-agent.test-support.ts`. Pula, com o motivo no título, no Windows, sem `tmux` no PATH e sem o lançador ou o build. **CI:** o job `linux` instala o `tmux` (`sudo apt-get install -y tmux`, só na CI, como aprovado na N191) e roda o `pnpm check` com **`OT_REQUIRE_TMUX=1`** **[proposta]**, que faz o teste **falhar** em vez de pular. Os testes do `ink-testing-library` já rodavam nos jobs `cross` (Windows e macOS), porque o `pnpm check` roda o `pnpm test` inteiro: conferido no `ci.yml`, nada foi acrescentado [S]; a CI não tinha sido disparada quando o PR foi escrito, e depois rodou verde, com a fumaça 9 de 9 no job linux [V]. **Roteiro** `tools/acceptance/tui-terminals.md` **[proposta]**, em pt-BR, para o Windows Terminal e um terminal de macOS ou Linux: abertura, teclas, mouse, cópia (inclusive OSC 52 no tmux), colagem, redimensionar, Option como Meta e SSH, cada item com o que fazer e o que esperar; a tabela final deixa tudo **[N]**: nada foi marcado como conferido. **Chave nova [proposta]:** `ui.runtime.exitGraceMs` (2.000; 0 a 60.000), a folga que o processo da TUI espera pelo próprio fim, para o `layoutStore.flush()` assíncrono do desmonte terminar, antes de forçar o `process.exit`; `0` sai na hora [V na branch: o esquema]. Sem evento, rota nem log novo.

**A TUI órfã (achado do passo, corrigido no mesmo PR):** quando o pty fecha, o `stdout` recebe `EIO`; sem ouvinte de `error`, isso virava `uncaughtException`, o `installExitGuards` chamava `onFatal`, que escrevia `app.crash` no `stderr`, que falhava com `EIO`, e assim num laço sem fim a **100% de CPU**; o `main.ts` também só gravava `process.exitCode` e nunca chamava `process.exit` [S: causa confirmada no PR com um espião nos fluxos; o teste 9 falhou com o código antigo e passou com o novo]. Correção em `terminal.ts`, `run.tsx` e `main.ts`: `isTerminalGone` (`EIO`, `EPIPE` e `ENXIO`) leva a um caminho que não escreve nada e termina com o **código 129**, o do `SIGHUP`; `startTuiApp` ouve `error` em `stdin`, `stdout` e `stderr`; a escrita do `app.crash` e a do desligamento do mouse ficam protegidas; outros erros (`ENOSPC`, por exemplo) seguem sendo falha com código 1; e o `main.ts` chama `endProcess(code, ui.runtime.exitGraceMs)`. Não há evento nem log para "terminal foi embora": o processo da TUI não tem canal de eventos, só o `stderr`, que é justamente o que sumiu. Ver a N207.

**Divergências:**
- **"o teste de fumaça passa na CI"**: quando o PR foi escrito, o YAML só tinha sido validado e a CI não tinha sido disparada; depois ela rodou verde (9 de 9 no job linux) [V]; o aceite do roteiro ("passado ao menos no terminal Linux do dono") fica com o dono [S];
- **um daemon por teste**, e não um por arquivo: o layout (abas abertas, seções dobradas) persiste no daemon entre sessões da TUI, e o segundo teste herdava as abas do primeiro [S];
- **a correção da TUI órfã e dos sockets** que os testes deixavam em `/tmp/tmux-<uid>` entrou no passo por pedido do orquestrador; a primeira versão só contornava (fechava com `Ctrl+Q` antes do `kill()`), e isso foi retirado [S];
- **a última linha da tela inicial no tmux** é o aviso de que `Ctrl+B` é o prefixo do tmux (a TUI detecta o tmux), e não a barra de teclas; o teste confere esse aviso, o que cobre o "aviso de ambiente" do tmux, que a arquitetura marca como [hipótese: não confirmada em terminal real] [S];
- **o clique nas opções de decisão (N200, item 4) não foi ligado**: a recomendação da N200 era ligá-lo no P20, junto com o roteiro, e o PR não o menciona [S]; segue aberto;
- **fica de fora**: o roteiro nos terminais reais (com o dono; a tabela é toda **[N]**); mouse e cópia no tmux (o tmux do teste não envia eventos de mouse nem lê OSC 52, então só o roteiro, itens 3, 4 e 8, os confere); Windows e macOS no teste de fumaça (o tmux não roda no Windows, e no macOS a CI não o instala: o teste pula, ou roda se o runner já o tiver); e o **item 8.4 do roteiro, o SSH que cai**, porque o teste cobre o pty do tmux, não uma conexão SSH real [S].

### P21. Aceite da fase

O critério da §10: criar um projeto, adicionar uma assinatura (com o login oficial dentro da TUI), configurar papéis, pedir uma necessidade no chat, responder a uma decisão e acompanhar até o PR só pela TUI, no Windows Terminal e num terminal de macOS ou Linux, nos dois idiomas.

- **Com o `fake-agent`** (automático, como na Fase 6): o caminho inteiro por `ink-testing-library`, com o CodeHost falso, em `en` e em `pt-BR`, três rodadas seguidas sem falha.
- **Real** (pelo orquestrador, com as rodadas autorizadas): o mesmo caminho com o Claude Code (haiku) num tmux, com a entrega no CodeHost falso. O login oficial real fica com o dono ao teclado, porque o orquestrador não faz login.
- **Terminais:** o roteiro do P20 no Windows Terminal e num terminal de macOS ou Linux, pelo dono.

**Estado:** feito em 2026-11-21, PR #231, mesclado em 2026-11-21 (7debaa8), com a CI verde [V: `git log`, `gh pr checks`]; o conteúdo vem da descrição do PR e dos arquivos [S]. Nenhuma mudança de código de produto; nenhuma chave, evento ou rota nova (`api-routes.json` igual). **Nível automático** `packages/tui/src/phase7-acceptance.e2e.test.tsx` (roda no `pnpm test`): `ink-testing-library` contra o daemon real em processo, com o `fake-agent` em todos os papéis, o CodeHost falso, HOME, SQLite e pasta de dados temporários, só loopback, sem credencial e com relógio falso, em `en` e em `pt-BR`, com os textos vindos do catálogo: (1) a primeira execução abre o assistente (P17), que passa por detectar, preset, Executores e revisão e confirma (`setup.started`, `setup.step`, `setup.confirmed`, `config.yaml` escrito); (2) em Configurações, `a` adiciona uma conta (`profile.added`); (3) nos papéis, `e` troca o `when_exhausted` do Diretor para `wait` (recarga a quente, `config.edited` e `config.changed`); (4) a necessidade é digitada no chat; (5) o cartão da entrega é respondido com `1`; (6) a peça chega a DONE, com 1 PR no CodeHost falso e `delivery.completed` com `mode: pr` e `requestedBy: producer`. Três rodadas seguidas sem falha no PR e mais três do orquestrador, 2 de 2 em cada [V]; sob carga (24 laços na CPU, o dobro dos núcleos), passou depois da correção abaixo [S]. **Nível real** `packages/tui/src/phase7-acceptance.real.test.ts` e o nível `phase7` do `tools/acceptance/real-acceptance.sh`: a TUI compilada num tmux de socket próprio, contra um daemon com o Claude Code (haiku) em todos os papéis, com o perfil de teste já logado só apontado; digita a necessidade, responde às perguntas do Diretor com a primeira opção, escolhe "pull request" no cartão da entrega, espera DONE e o PR, sai por `Ctrl+Q` e confere que nenhum processo sobrou. Rodado pelo orquestrador em 2026-11-21 às 07:13 e **passou** [V]: a peça `play-6682cdee` chegou a DONE em 72,6 s, com 485 eventos, o menu de entrega respondido com "pull request" pelas teclas aos 70,4 s, 1 PR no CodeHost falso, 9 processos abertos e 0 sobrando e pico de memória de ≈ 1,5 GB [V: log `real-acceptance-phase7-20261121-071346.log`]. O caminho foi PLANNING, REVIEWING_PLAN, SCRIPTING, REVIEWING_SCRIPT, EXECUTING (duas vezes), INTEGRATING, CRITIQUING, DELIVERING, AWAITING_PRODUCER, DELIVERING e DONE [V]. Variáveis e teto só de teste **[proposta]**: `OT_TEST_REAL_PHASE7=1` liga o nível (com `OT_TEST_REAL_CLIENTS`, `OT_TEST_REAL_PROMPTS`, `OT_TEST_CLAUDE_PROFILE_DIR` e `OT_TEST_CLAUDE_MODEL`, sem padrão), `OT_TEST_PLAY_TIMEOUT_MS` (25 min, a do nível `play`) e o teto `OT_ACCEPT_TIMEOUT` de **40m** no nível. Apoio só de teste em `chat/fake-agent.test-support.ts`: as opções `persistConfig` (grava a configuração também em `<data>/config.yaml`, para que o assistente e Configurações editem o arquivo e a recarga a quente bata com a memória) e `real`.

**Divergências:**
- **o login oficial não é exercitado** em nenhum dos dois níveis: o automático usa um perfil de mentira no armazenamento, e o real aponta o perfil que o dono já logou; nada lê credencial. Fica com o dono ao teclado [N];
- **a TUI não cria projeto nem cenário**: não há ação de teclas para isso (o `ot chat --type project --repo .` e a rota `openScenario` fazem); nos dois níveis o cenário é aberto pelo daemon (`producer.openChat({ repo })`). É lacuna do produto, na N208;
- **a confirmação do assistente não vale a quente**: grava `config.yaml` e emite `setup.confirmed`, mas o daemon só relê o arquivo ao reiniciar; o teste mostra o arquivo escrito, não o efeito (N208);
- **o passo Executores do assistente não registra Executor** no teste (não há cliente real para detectar); os papéis são cobertos pela regra do Diretor em Configurações (N208);
- **sob carga, a primeira tecla do chat se perdia**: a caixa de texto ainda não estava ligada às teclas quando a tela já aparecia, e os dois idiomas falharam; o teste agora confere que a primeira tecla apareceu e, se não, a repete (até 5 vezes, 4 s cada), como uma pessoa faria. O produto não mudou (N208) [S];
- **no nível real, o teste responde a primeira opção** de cada pergunta do Diretor, como o `phase6`; outro cartão (um limite que acabou) falha o teste;
- **fica de fora**: os terminais reais (roteiro do P20, com o dono, tabela toda **[N]**), o login oficial, Windows e macOS no nível real (o tmux não roda no Windows; o teste pula ali) e a confirmação do assistente a quente.

## Fora desta fase

- **Sistema de plugins e a aba Plugins:** Fase 9 (N189). O registro de abas do P7 já aceita a aba.
- **Agenda e tarefas agendadas:** Fase 9b, com a aba Agenda.
- **Painéis de telemetria da aba Consumo, ATIF e OTLP:** Fase 8.
- **`ot init` e o serviço de logon:** Fase 10. Aqui, a primeira execução abre o assistente quando o daemon já está rodando.
- **Painel de Terminal (xterm.js), ferramentas de terminal do Ator, tela dividida, chat lateral, bifurcar cenário e voltar ou editar mensagem:** Fases 12 e 13 (§5.13).
- **`!` interativo com PTY:** quando houver PTY, pela N187.
- **Mover cenário e federação (N134, níveis 2 e 3):** depois da v1.

## Decisões que surgem deste plano

Abertas e decididas em 2026-11-20 ([docs/13](13-DECISOES-EM-ABERTO.md)), pelo dono, por múltipla escolha. Nas oito, a escolha foi a recomendação, que vem primeiro em cada item. Ao abrir a onda 1, no mesmo dia, vieram a N193 (`pause.mode`, padrão `drain`), a N194 (prazo do `!`, padrão 5 min) e a N195 (`ot` sem argumento abre a TUI), também iguais à recomendação. A onda 1 implementou as três: a N193 no PR #211, a N194 no PR #208 e a N195 no PR #210. A onda 2 implementou a N44 (os comandos `/` do daemon, PR #215) e a N35 (a caixa de texto, PR #213), e o PR #216 trouxe o `@inkjs/ui` da N185. A onda 3 implementou a N34 e a N36 (mouse e cópia, PR #218, com a correção da N36: só `off` devolve a seleção do terminal), a N186 (o login oficial na aba Configurações, PR #222) e a N188 (a recarga a quente e o evento `config.changed`, PR #222), e levantou as perguntas N198 a N203 ([docs/13](13-DECISOES-EM-ABERTO.md)), ainda abertas. A onda 4 implementou a N43 e a N187 na TUI (o `!`, PR #223), a N121 (a tela do assistente, PR #227), a N190 (a sessão direta, PR #228, com a N44) e a N191 (o teste de fumaça no tmux e o roteiro, PR #226), e levantou as perguntas N204 a N207, também abertas. A onda 5 (P21, o aceite, PR #231) não implementou decisão e levantou a N208 (lacunas do aceite) e a N209 (fechamento da fase), abertas:
- **N185, dependências novas:** `ink` 8.0.0, `react` 19.3.1, `@types/react` 19.3.0, `@inkjs/ui` 2.0.0, `ink-testing-library` 4.0.0 e `react-i18next` 17.1.13, todas MIT. Alternativas: sem o `@inkjs/ui` (componentes próprios); sem o `react-i18next` (um gancho próprio sobre o i18next).
- **N186, login oficial na TUI:** o daemon expõe o `LoginFlow` pela REST, e o modo `terminal` suspende a TUI e roda o login no próprio terminal. Alternativas: sempre suspender a TUI e rodar o CLI; ou o daemon com PTY transmitindo o login (exige `node-pty`).
- **N187, `!` nesta fase:** no daemon, sem PTY e com a entrada fechada; o caso interativo fica para quando houver PTY. Alternativas: `node-pty` já nesta fase, com a TUI entregando o terminal; ou o `!` inteiro na Fase 12.
- **N188, configuração editada pela TUI:** recarga a quente das chaves que podem mudar sem reiniciar (`ui.*`, `chat.*`, `limits.*`, `roles.*`), com o evento `config.changed`, e as outras marcadas "vale no reinício" na tela. Alternativas: tudo no reinício, com a TUI oferecendo reiniciar o daemon; ou recarga a quente de tudo.
- **N189, aba Plugins:** vai para a Fase 9, junto com o sistema de plugins. Alternativa: a aba vazia já nesta fase.
- **N190, sessão direta:** nesta fase, num passo próprio (P19), fora do critério de aceite. Alternativas: dentro do aceite; ou na Fase 12.
- **N191, terminais do aceite:** teste de fumaça com tmux na CI Linux, `ink-testing-library` também no Windows e no macOS, e um roteiro manual para o dono nos terminais reais. Alternativa: só a CI, com os terminais reais **[N]** até a Fase 11.
- **N192, merge da Fase 7:** a autorização das Fases 3 a 6 (N171) vale também para a Fase 7, com a CI verde e squash pelo `merge-pr.sh`. Alternativa: ok do dono em cada PR.
