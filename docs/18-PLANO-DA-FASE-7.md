# 18. Plano da Fase 7

Versão 2, de 2026-11-20 (a onda 1 está concluída; cada passo feito leva o PR e as divergências). Este é o plano de passos da Fase 7 da [arquitetura](framework-ideas/arquitetura.md), §10, "TUI (interface principal)". A arquitetura continua sendo a referência: este plano só divide a fase em passos, diz o que pode correr em paralelo e dá o aceite de cada passo. Se os dois divergirem, vale a arquitetura, e este documento é corrigido.

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
| P3 | Registro de comandos `/` no daemon (N44) | P2 | P4 a P11 | a fazer |
| P4 | Assistente de configuração no daemon (§5.7) | P0 | P1, P2, P5 a P8 | concluído (PR #212) |
| P5 | Login oficial pela API (N186) | P0 | P1, P2, P4, P6 a P8 | concluído (PR #207) |
| P6 | Comando `!` do Produtor no daemon (N43, N187) | P0 | P1, P2, P4, P5, P7, P8 | concluído (PR #208) |
| P7 | Registro de interface e chaves `ui.*` no `packages/client` | P0 | P1, P2, P4 a P6, P8 | concluído (PR #206) |
| P8 | `packages/tui`: base, desempenho e testes | P0 | P1, P2, P4 a P7 | concluído (PR #210) |
| P9 | Layout: lateral, chat, painel de abas, rolagem e paleta | P7, P8 | P3, P10, P11 | a fazer |
| P10 | Caixa de texto do Produtor (N35) | P7, P8 | P3, P9, P11 | a fazer |
| P11 | Mouse e cópia (N34, N36) | P9 | P3, P10 | a fazer |
| P12 | Chat: conversa, decisões e comandos `/` | P3, P9, P10 | P13 a P16 | a fazer |
| P13 | Visão geral e Consumo | P1, P9 | P12, P14 a P16 | a fazer |
| P14 | Trajetórias | P9 | P12, P13, P15, P16 | a fazer |
| P15 | Ordens | P9 | P12 a P14, P16 | a fazer |
| P16 | Configurações: Assinaturas, Executores, Papéis e Limites | P5, P9, N188 | P12 a P15 | a fazer |
| P17 | Assistente de configuração na TUI | P4, P16 | P18, P19 | a fazer |
| P18 | `!` na TUI | P6, P12 | P17, P19 | a fazer |
| P19 | Sessão direta com um Ator (N190) | P12 | P17, P18 | a fazer |
| P20 | Terminais: testes de fumaça e roteiro manual (N191) | P12 | P17 a P19 | a fazer |
| P21 | Aceite da fase | todos | nada | a fazer |

Ordem em ondas **[proposta]** (a onda 1 terminou em 2026-11-20; os sete PRs estão nas linhas dos passos):
1. P1, P2, P4, P5, P6, P7 e P8. Os cinco primeiros são do daemon; P7 e P8 abrem o lado da TUI. Sete passos de uma vez passam do limite de dois subagentes com a suíte completa: os do daemon rodam a suíte em fila, e P7 e P8 testam só os pacotes deles até o PR.
2. P3, P9 e P10.
3. P11, P12, P13, P14, P15 e P16.
4. P17, P18, P19 e P20.
5. P21.

Marco interno **[proposta]**: ao fim da onda 3, a TUI já acompanha uma peça e conversa com o Diretor contra o `fake-agent`. É o ponto em que o dono pode abrir a TUI e mudar o rumo antes das telas de configuração e do aceite.

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
- chaves `chat.slash_commands: on | off` (padrão `on`) e `chat.client_commands: on | off | allowlist` (padrão `on`), com `chat.client_commands.allow`.

**Aceite:** a lista muda com o tipo e o estado do cenário; um comando de consulta responde sem chamar o modelo (nenhum turno do Diretor no log); `/cancel` pede confirmação; um comando do cliente com o Diretor em turno é recusado com `conflict`; o catálogo de rotas está regenerado.

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

### P10. Caixa de texto do Produtor (N35; §5.13)

**Escopo:** o comportamento da caixa dos agentes de código, como na §5.13: Enter envia; Ctrl+J e Shift+Enter (onde o terminal distingue) fazem nova linha; a edição do readline; o histórico com ↑/↓, Ctrl+R e Ctrl+G no `$EDITOR` (a TUI se suspende e volta); a colagem por bracketed paste, com a colagem longa virando marcador `[Pasted text #n]` e anexo; Ctrl+V com imagem pela ferramenta do sistema, virando anexo `A<n>`; caminho de arquivo existente colado virando anexo.

**Aceite:** cada tecla da tabela da N35 tem teste; uma colagem de 2.000 linhas vira marcador e o anexo guarda o texto inteiro; sem a ferramenta de imagem instalada, o Ctrl+V diz o que falta e não trava.

### P11. Mouse e cópia (N34, N36; §5.13)

**Escopo:** a camada de mouse própria (liga `?1000h` e `?1006h`, lê os eventos SGR, acha a caixa clicada pelo `useBoxMetrics` descontando a rolagem, e não deixa sequência cortada vazar para a caixa de texto): roda, clique em abas, seções, lateral e opções de decisão, e arrasto da borda do chat. A seleção própria dentro de uma área, copiada por OSC 52 ou pela ferramenta do sistema (`ui.clipboard.copy`). `ui.mouse: wheel | off` devolve a seleção normal do terminal.

**Aceite:** sequências SGR gravadas (incluindo cortadas ao meio) chegam como eventos e nada delas aparece na caixa de texto; o clique em cada área faz a ação; a cópia sai como OSC 52 válido.

### P12. Chat: conversa, decisões e comandos `/` (§5.3, §5.13, §5.20)

**Escopo:** o chat com o Diretor pelo `ChatSocket`, com resposta em fluxo, estado do Diretor (ativo, em turno, adormecido) e os dados da peça no topo (título, etapa, decisão pendente); as decisões do Produtor como lista navegável (setas ou número, Espaço na escolha múltipla, Enter); o `/` com autocompletar a partir do `GET /v1/commands` (P3), a confirmação dos comandos que pedem e a resposta dos comandos do daemon na própria conversa; os anexos do P10; a troca de cenário pela lateral; a fila quando o Diretor está em turno; e o Esc parando a resposta do Diretor, sem pausar a peça.

**Aceite:** contra o `fake-agent`, uma necessidade pedida no chat vira peça, uma decisão é respondida por tecla e a peça segue; `/status` responde sem turno do Diretor; uma queda do socket no meio da resposta volta sem perder nem repetir texto.

### P13. Visão geral e Consumo (§5.13)

**Escopo:** a Visão geral com pipeline, demandas em lista com dependências (`D4 ← D2, D3`), Atores ativos com tempo restante, eventos recentes e cota por assinatura, alimentada pelos stores (P1); os controles de pausar e retomar a peça e o Ator (P2), com confirmação. A aba Consumo com `/v1/usage` e `/v1/budget`. Os painéis de telemetria são da Fase 8.

**Aceite:** a Visão geral acompanha uma peça inteira do `fake-agent` sem leitura REST a cada evento; pausar pela aba produz o mesmo efeito do `/pause`.

### P14. Trajetórias (§5.11, §5.13)

**Escopo:** a aba Trajetórias, ao vivo e histórica, com os passos expansíveis (turnos, chamadas de ferramenta, permissões, saída de terminal do Ator quando o cliente a manda) e os diffs, a partir dos eventos e do blackboard. O formato ATIF é da Fase 8. O comando `/trajectory` entra aqui.

**Aceite:** a trajetória de uma peça do `fake-agent` mostra todos os turnos, abre e fecha cada passo e mostra o diff da demanda.

### P15. Ordens (§5.17)

**Escopo:** a aba Ordens: vigentes, agendadas e encerradas por escopo, a linha do tempo da vigência e os prazos; criar, prorrogar, suspender e revogar pelas rotas `/v1/orders` que já existem.

**Aceite:** cada ação muda o estado na aba pelo evento `directive.*`, sem recarregar.

### P16. Configurações: Assinaturas, Executores, Papéis e Limites (§5.13; N186, N188)

**Escopo:**
- **Assinaturas:** estado, cota, reset, adicionar e remover (as rotas de perfis), e o login oficial pelo P5 num painel da TUI (URL e código na tela, campo para o código do navegador); no modo `terminal`, a TUI se suspende e roda o login no próprio terminal;
- **Executores:** modelo e esforço a partir das config options;
- **Papéis:** a lista ordenada por prioridade, reordenada com Shift+↑↓, e a regra `next`/`wait`;
- **Limites:** a predefinição e as chaves de `limits`;
- o escopo global com override por projeto;
- a gravação pelo `PUT /v1/config`, com o efeito da N188.

**Aceite:** com perfis falsos, o login pelo painel termina; reordenar papéis grava a ordem nova; uma configuração inválida mostra a chave que falhou e não grava.

### P17. Assistente de configuração na TUI (§5.7)

**Escopo:** a TUI desenha os passos que o daemon manda (P4), com voltar e retomar; a primeira execução, sem configuração, abre nele; o mesmo desenho serve para adicionar conta e trocar a predefinição.

**Aceite:** do zero, com perfis falsos, o assistente vai até a confirmação só pela TUI; fechar a TUI no meio e abrir de novo volta ao mesmo passo.

### P18. `!` na TUI (N43, N187)

**Escopo:** o `!` na caixa de texto, com o estado do comando em curso, a saída como `terminal_snippet` na conversa, a pergunta da `chat.shell_command.context: ask` e o aviso de que o comando pediu entrada.

**Aceite:** `!ls` mostra a saída na conversa; com `ask`, a TUI pergunta antes de anexar.

### P19. Sessão direta com um Ator (N44, N190; §5.20)

**Escopo** (mantida nesta fase pela N190, fora do aceite): a aba de sessão direta no cenário, com o Executor escolhido da lista do perfil, a chave `direct_session.workspace: worktree | readonly | scenario` (padrão `worktree`; `scenario` pede confirmação), a cota e o orçamento do perfil, o lançador e a sandbox, o log e as trajetórias, as permissões pedidas na própria aba, os comandos do cliente e a promoção do resultado a demanda ou peça. Daemon e TUI no mesmo passo, porque um não se testa sem o outro **[proposta]**.

**Aceite:** com o `fake-agent`, a sessão abre, conversa, roda um comando do cliente e é promovida a demanda; com `readonly`, uma escrita é barrada.

### P20. Terminais: testes de fumaça e roteiro manual (N191; §5.13)

**Escopo** (na forma escolhida na N191):
- um teste de fumaça na CI Linux que abre a TUI num tmux de verdade (instalado no job), manda as teclas do mapa e confere os quadros, como o `spikes/tui-keys`;
- os testes do `ink-testing-library` também nos jobs `cross` (Windows e macOS), que já rodam o `pnpm check`;
- um roteiro manual curto (`tools/acceptance/tui-terminals.md` **[proposta]**) para o dono passar no Windows Terminal e num terminal de macOS ou Linux: teclas, mouse, cópia, colagem, redimensionar, Option como Meta no macOS e SSH. O que não for conferido fica **[N]** na tabela de terminais.

**Aceite:** o teste de fumaça passa na CI; o roteiro existe e foi passado pelo menos no terminal Linux do dono.

### P21. Aceite da fase

O critério da §10: criar um projeto, adicionar uma assinatura (com o login oficial dentro da TUI), configurar papéis, pedir uma necessidade no chat, responder a uma decisão e acompanhar até o PR só pela TUI, no Windows Terminal e num terminal de macOS ou Linux, nos dois idiomas.

- **Com o `fake-agent`** (automático, como na Fase 6): o caminho inteiro por `ink-testing-library`, com o CodeHost falso, em `en` e em `pt-BR`, três rodadas seguidas sem falha.
- **Real** (pelo orquestrador, com as rodadas autorizadas): o mesmo caminho com o Claude Code (haiku) num tmux, com a entrega no CodeHost falso. O login oficial real fica com o dono ao teclado, porque o orquestrador não faz login.
- **Terminais:** o roteiro do P20 no Windows Terminal e num terminal de macOS ou Linux, pelo dono.

## Fora desta fase

- **Sistema de plugins e a aba Plugins:** Fase 9 (N189). O registro de abas do P7 já aceita a aba.
- **Agenda e tarefas agendadas:** Fase 9b, com a aba Agenda.
- **Painéis de telemetria da aba Consumo, ATIF e OTLP:** Fase 8.
- **`ot init` e o serviço de logon:** Fase 10. Aqui, a primeira execução abre o assistente quando o daemon já está rodando.
- **Painel de Terminal (xterm.js), ferramentas de terminal do Ator, tela dividida, chat lateral, bifurcar cenário e voltar ou editar mensagem:** Fases 12 e 13 (§5.13).
- **`!` interativo com PTY:** quando houver PTY, pela N187.
- **Mover cenário e federação (N134, níveis 2 e 3):** depois da v1.

## Decisões que surgem deste plano

Abertas e decididas em 2026-11-20 ([docs/13](13-DECISOES-EM-ABERTO.md)), pelo dono, por múltipla escolha. Nas oito, a escolha foi a recomendação, que vem primeiro em cada item. Ao abrir a onda 1, no mesmo dia, vieram a N193 (`pause.mode`, padrão `drain`), a N194 (prazo do `!`, padrão 5 min) e a N195 (`ot` sem argumento abre a TUI), também iguais à recomendação. A onda 1 implementou as três: a N193 no PR #211, a N194 no PR #208 e a N195 no PR #210:
- **N185, dependências novas:** `ink` 8.0.0, `react` 19.3.1, `@types/react` 19.3.0, `@inkjs/ui` 2.0.0, `ink-testing-library` 4.0.0 e `react-i18next` 17.1.13, todas MIT. Alternativas: sem o `@inkjs/ui` (componentes próprios); sem o `react-i18next` (um gancho próprio sobre o i18next).
- **N186, login oficial na TUI:** o daemon expõe o `LoginFlow` pela REST, e o modo `terminal` suspende a TUI e roda o login no próprio terminal. Alternativas: sempre suspender a TUI e rodar o CLI; ou o daemon com PTY transmitindo o login (exige `node-pty`).
- **N187, `!` nesta fase:** no daemon, sem PTY e com a entrada fechada; o caso interativo fica para quando houver PTY. Alternativas: `node-pty` já nesta fase, com a TUI entregando o terminal; ou o `!` inteiro na Fase 12.
- **N188, configuração editada pela TUI:** recarga a quente das chaves que podem mudar sem reiniciar (`ui.*`, `chat.*`, `limits.*`, `roles.*`), com o evento `config.changed`, e as outras marcadas "vale no reinício" na tela. Alternativas: tudo no reinício, com a TUI oferecendo reiniciar o daemon; ou recarga a quente de tudo.
- **N189, aba Plugins:** vai para a Fase 9, junto com o sistema de plugins. Alternativa: a aba vazia já nesta fase.
- **N190, sessão direta:** nesta fase, num passo próprio (P19), fora do critério de aceite. Alternativas: dentro do aceite; ou na Fase 12.
- **N191, terminais do aceite:** teste de fumaça com tmux na CI Linux, `ink-testing-library` também no Windows e no macOS, e um roteiro manual para o dono nos terminais reais. Alternativa: só a CI, com os terminais reais **[N]** até a Fase 11.
- **N192, merge da Fase 7:** a autorização das Fases 3 a 6 (N171) vale também para a Fase 7, com a CI verde e squash pelo `merge-pr.sh`. Alternativa: ok do dono em cada PR.
