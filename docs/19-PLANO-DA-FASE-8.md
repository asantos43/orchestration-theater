# 19. Plano da Fase 8

Versão 3, de 2026-11-21 (a versão 2 fechou as decisões N211 a N219; a versão 1, do mesmo dia, as tinha abertas). A versão 3 acrescenta o "Como ficou" de cada passo feito ou em PR, com as chaves, os eventos, as rotas e as divergências do que foi para o código; o que está em PR vem da descrição do PR **[S]** e só vale depois do merge. Este é o plano de passos da Fase 8 da [arquitetura](framework-ideas/arquitetura.md), §10, "Fase 8 — Observabilidade", com o desenho da §5.11. A arquitetura continua sendo a referência: este plano só divide a fase em passos, diz o que pode correr em paralelo e dá o aceite de cada passo. Se os dois divergirem, vale a arquitetura, e este documento é corrigido.

A fase começa depois da onda 6 de acertos da Fase 7 (P22 a P27, docs/18, N208). O fechamento da Fase 7 depende do roteiro dos terminais e do login oficial pelo dono (N209), mas isso não segura a Fase 8: os passos desta fase não mexem na TUI até o P10. O plano também leva dois itens que a Fase 7 deixou para cá: o `terminal.output` e a lateral com as peças terminadas (N200, itens 3 e 5). Ele levantou nove decisões novas, N211 a N219 ([docs/13](13-DECISOES-EM-ABERTO.md)), que o dono tomou no mesmo dia, todas iguais à recomendação; o resumo está em "Decisões que surgem deste plano", no fim. A N55 (a análise do sistema) fechou pela N217.

## Como usar

- Cada passo tem uma branch e um PR com título "Fase 8: ...". O PR que conclui um passo também muda o estado dele na tabela de passos.
- O merge é feito pelo `merge-pr.sh`, com squash, depois da CI verde e com a branch atualizada com a main. Nunca com `gh pr merge --auto`. Os PRs desta fase mesclam sem ok por PR (N210).
- Todo passo exige, além do aceite próprio, `build`, `lint`, `format:check`, `test`, `verify` e `deps` verdes na máquina e na CI. O job `linux` roda em todo PR. Os jobs `cross` e `windows-launcher` rodam nos PRs que mexem em código (N162).
- O que está marcado **[proposta]** é detalhe deste plano, ainda sem decisão. Todo padrão novo vira uma chave de configuração, com um padrão e os seus modos. Se a chave mudar algum comportamento visível, a escolha vai ao dono, por múltipla escolha, ao abrir o passo.
- Paralelismo:
  - passos sem dependência entre si correm ao mesmo tempo, cada um no seu worktree;
  - dois passos nunca mexem nos mesmos arquivos. As exceções são as mesmas da Fase 7, e em cada uma o passo acrescenta só o seu bloco, e o conflito se resolve no merge da main na branch:
    - o `DaemonConfigSchema` (`daemon/src/config.ts`);
    - o índice do protocolo (`protocol/src/index.ts`), o registro de rotas (`protocol/src/api/registry.ts`) e o catálogo `docs/reference/api-routes.json`, regenerado por `pnpm api:catalog`;
    - o catálogo de eventos (`protocol/src/events.ts`);
    - o `compose.ts`;
    - os catálogos `locales/<idioma>/*.json`;
  - no máximo dois subagentes rodam a suíte completa ao mesmo tempo, por causa da memória da máquina.
- **Nada real roda nos testes (N57).** Os clientes são simulados pelo `fake-agent`, que passa a mandar OTLP no P3. O coletor OTLP "de fora" do aceite é um receptor de teste no próprio processo do teste, em loopback. Nenhum teste lê credencial nem faz login. As rodadas reais (Claude Code com haiku, Codex, OpenCode com modelos OpenAI) ficam no nível real do aceite, como nas Fases 6 e 7.
- **Nenhum download novo sem decisão do dono.** Pela N211 (a), nenhum pacote npm entra; pela N215 (a), só o `harbor`, no job `atif` e com `OT_TEST_HARBOR=1` (ver "Dependências novas").
- **Redação primeiro.** Tudo o que entra pelo receptor passa pela redação antes de ser gravado (§5.11): o Codex manda `user.email`, `user.account_id` e o resultado das ferramentas em claro [V: Fase 0]. Nenhum teste e nenhum relatório de PR imprime o conteúdo de um registro real.

## Ponto de partida

Conferido no código em 2026-11-21, no commit `392dcad` **[V]**. Os caminhos são relativos a `packages/`.

- **OTel no produto:** não existe. Não há receptor, `@opentelemetry/*` no `pnpm-lock.yaml`, chave `telemetry.*` nem `telemetry.sqlite`. O `DaemonConfigSchema` é `strictObject` (`daemon/src/config.ts`), então as chaves entram com os passos que as usam. Os payloads `session.*`, `permission.*` e `workspace.*` já levam `playId`, `demandId` e `attemptId` "para a base de telemetria" (`protocol/src/session-events.ts`).
- **Adaptadores dos clientes:** o `profileEnv` do Claude Code só devolve `CLAUDE_CONFIG_DIR` (`adapters/client-claude-code/src/claude-code-adapter.ts`), e o `sessionSetup` já passa `_meta.claudeCode.options`, o caminho que o spike validou para o `env` por sessão. O do Codex só devolve `CODEX_HOME`, e o `writeProfileConfig` (`adapters/client-codex/src/profile.ts`) não escreve `[otel]`. O do OpenCode não passa nada de OTel.
- **Spike `spikes/otel`** (2026-11-15, README de 182 linhas) **[V: Fase 0]**:
  - receptor Node em OTLP/HTTP (`/v1/{metrics,logs,traces}`), JSON e protobuf, com gzip, sobre `@opentelemetry/otlp-transformer` 0.57.2 e `protobufjs` 7.5.4, com `package-lock.json` próprio, fora do pnpm;
  - Claude Code 2.1.325: aceita `http/json` e `http/protobuf`; métricas, logs e traces chegam; o `OTEL_RESOURCE_ATTRIBUTES` com `otheater.*` chega em todos os registros;
  - Codex 0.169: o `-c otel.*` com `otlp-http` (JSON ou binário) funciona por processo, e um `app-server` atende todas as sessões do adaptador, então a correlação por sessão usa o `conversation.id`; sem `session/set_title`, cada sessão gera uma thread extra de título;
  - OpenCode 1.19.5: o `OTEL_EXPORTER_OTLP_ENDPOINT` basta para logs e traces, mas sem `experimental.openTelemetry` não há tokens nem modelo; com a chave, o prompt e o resultado das ferramentas saem em claro;
  - sobrecarga não distinguível do ruído em execuções curtas; o volume do Codex foi de 3 MB em JSON contra 0,73 MB em protobuf;
  - não medido: execuções longas, ACP completo com `config.toml` no `CODEX_HOME`, custo no OpenCode, cardinalidade e retenção, mapeamento ATIF.
- **Trajetórias (P14 da Fase 7):** `protocol/src/trajectory.ts` monta uma visão própria (`buildTrajectory`: tentativas → turnos → entradas `message`, `thought`, `tool_call`, `tool`, `permission`, `plan` e `terminal`), longe do ATIF: não tem `step_id`, `source`, `observation`, métricas por passo nem `subagent_trajectory_ref`. O `TrajectoryService` (`daemon/src/trajectory/service.ts`) varre o log em blocos de 1000, sem índice por peça. A rota `GET /v1/plays/:playId/trajectory` devolve os eventos crus, e a dobra é feita no cliente. Nada emite `terminal.output` (N200, item 3).
- **Consumo:** a aba (`tui/src/tabs/usage/`) mostra totais, grupos e orçamento, a partir de `GET /v1/usage` e `GET /v1/budget`. O `UsageService` (`daemon/src/usage/service.ts`) grava a tabela `usage` a partir do uso que o cliente informa pelo ACP, não pelo OTel, e soma em memória. A `quota_snapshots` aparece na Visão geral. `client/src/views/usage.ts` já diz que os painéis de telemetria são da Fase 8.
- **Retenção:** só a do backup (`backup.retention`, `daemon/src/recovery/retention.ts`, N51). A porta `EventLog` nunca apaga. O `daemon.log` não gira (`daemon/src/logger.ts`).
- **`/metrics` e exportação:** não existem. Não há a porta `EventSink` da §5.18.
- **Store:** `adapters/store-sqlite`, com Kysely 0.29.9 sobre `better-sqlite3` 13.2.0 (padrão) ou `node:sqlite` (`store.driver`), um escritor e um leitor, WAL, migrações versionadas e `PRAGMA synchronous` por configuração. É o molde do adaptador da base de telemetria.
- **Servidor HTTP:** Hono 4.13.16 e `@hono/node-server` 2.1.6 (`daemon/src/api/server.ts`), em `127.0.0.1`. Um `app.use('*')` aplica a todas as rotas o token, a checagem de Host e de Origin, o CORS e o limite de corpo, e as rotas vêm do registro zod e JSON (`API_ROUTE_LIST`, 90 rotas). O OTLP (corpo binário ou JSON grande, com gzip) e o `/metrics` (texto) não cabem nesse molde. O servidor MCP (`daemon/src/mcp/server.ts`) já é um segundo Hono em loopback, com porta própria: é o precedente da N212.
- **Python e Harbor:** nunca rodaram no repositório. A CI (`.github/workflows/ci.yml`) só tem Node 24, pnpm e cargo. Há `uv` na máquina do dono, fora do repositório [V].
- **ATIF:** a RFC 0001 do `harbor-framework/harbor` dá a **v1.8** como a atual (acrescentou o tipo `audio`), e a v1.7 trouxe `subagent_trajectories`, `trajectory_id` e `llm_call_count`, com `llm_call_count = 0` num passo `source: "agent"` para "despacho determinístico, sem LLM" [S: RFC lida em 2026-11-21 pelo `gh api`]. É a resposta provável ao **[a confirmar]** da §5.11 (como ligar a tentativa lançada pelo daemon ao passo do Diretor), a conferir contra o validador no P6. O validador fica em `src/harbor/utils/trajectory_validator.py`, e os modelos em `src/harbor/models/trajectories/` [S: árvore do repositório em 2026-11-21].

## Dependências novas

Dados do registro npm e do PyPI, consultados em 2026-11-21 **[S]**. Pela N211 (a), nenhum pacote npm entra nesta fase; as linhas do `protobufjs` e do OpenTelemetry JS ficam como registro das opções recusadas. Pela N215 (a), o `harbor` entra só no job `atif` da CI e no modo opcional da máquina. A regra é a das fases anteriores: versão publicada há pelo menos duas semanas.

| Pacote | Versão | Licença | Publicada | Passo | Observação |
|---|---|---|---|---|---|
| `protobufjs` | 8.8.1 | BSD-3-Clause | 2026-10-11 | P2, P7 | Só na N211 (b). Uma dependência (`long`, Apache-2.0). Precisa dos `.proto` do OTLP (Apache-2.0), copiados com a licença |
| `@opentelemetry/api` | 1.10.0 | Apache-2.0 | 2026-10-20 | P4, P7 | Só na N211 (c) |
| `@opentelemetry/sdk-trace-base`, `core`, `resources`, `sdk-metrics`, `sdk-logs` | 3.1.1 | Apache-2.0 | 2026-11-09 | P4, P7 | Só na N211 (c). A linha 3.x saiu em 2026-10-20 (3.0.0); a 3.1.1 completa duas semanas em 2026-11-23. Pede `@opentelemetry/api` >= 1.10.0 e < 1.11.0 |
| `@opentelemetry/exporter-{trace,metrics,logs}-otlp-proto`, `otlp-transformer` | 0.301.2 | Apache-2.0 | 2026-11-12 | P7 | Só na N211 (c); casa com a 3.1.1. A 0.300.0 (2026-10-20) casa com a 3.0.0 |
| `@opentelemetry/semantic-conventions` | 1.45.0 | Apache-2.0 | 2026-11-06 | P4 | Só na N211 (c). As convenções GenAI ainda estão em "Development" |
| `harbor` (PyPI) | a fixar no P6 | Apache-2.0 | 0.25.0 em 2026-10-25, 0.26.0 em 2026-11-13, 0.27.0 em 2026-11-21 | P6 | Nível D, só na CI e opcional na máquina (N215). Python >= 3.12. As dependências obrigatórias são pesadas (`litellm`, `fastapi`, `uvicorn`, `fastmcp`, `cryptography`, entre outras); o P6 tenta primeiro só o pacote com o `pydantic` (`--no-deps`) **[N: não testado]** |

Não entram **[proposta]**:
- o `prom-client` (Apache-2.0, última versão de 2024): o formato de texto do Prometheus é pequeno e sai de código próprio no P7;
- o Arize Phoenix (ELv2): é visualizador externo opcional, que a pessoa instala por conta própria; o P12 só documenta a receita e não baixa nada;
- o `@opentelemetry/sdk-node` e as autoinstrumentações: o daemon não instrumenta bibliotecas, só a peça (§5.11).

## Passos

| Passo | Título | Depende de | Pode correr junto com | Estado |
|---|---|---|---|---|
| P0 | Plano e decisões (este documento) | nada | nada | concluído (PR #233, decisões N211 a N219 em 2026-11-21) |
| P1 | Base de telemetria: porta, adaptador e chaves (N54) | P0, N211 | P3, P5, P11 | concluído (PR #242, f7d18e0) |
| P2 | Receptor OTLP e redação (N212) | P1 | P4, P6 | concluído (#250, 10e52a2) |
| P3 | Clientes e `fake-agent` mandam ao receptor (N213) | P0, N212 | P1, P5, P11 | concluído (PR #243, 803fb50) |
| P4 | Spans do daemon (N214) | P1 | P2, P6 | concluído (PR #249, 7fa8685) |
| P5 | ATIF: schema zod e exportador (N219) | P0 | P1, P3, P11 | concluído (PR #244, ad8bc79) |
| P6 | Validação pelo `TrajectoryValidator` do Harbor (N215) | P5 | P2, P4 | concluído (#252, d40b20d) |
| P7 | Exportação: OTLP para fora e `/metrics` (N70, N218) | P2, P4 | P9 | concluído (#255, aa20105) |
| P8 | Retenção e expurgo (N216) | P9 | P10, P12 | concluído (#257, 4c47d2a) |
| P9 | Análise do sistema (N55, N217) | P4 | P7 | concluído (#254, b1b3e36) |
| P10 | Painéis de telemetria na aba Consumo | P2, P9 | P8, P12 | concluído (#258, 8434d58) |
| P11 | `terminal.output` e peças terminadas na lateral (N200, itens 3 e 5) | P0 | P1, P3, P5 | concluído (PR #247, a232366) |
| P12 | Phoenix opcional: receita | P7 | P8, P10 | concluído (#256, 18715f2) |
| P13 | Aceite da fase | todos | nada | concluído (#260, c67814e) |
| P14 | Clique nas opções do cartão de decisão (N200, item 4) | nada | todos, menos P13 | concluído (#251, 1b52ae8) |
| P15 | Esperas fora do log viram eventos (N222) | P4 | P7, P9 | concluído (#253, b5e4e3d) |

Ordem em ondas **[proposta]**:
1. P1, P3, P5 e P11. O P1 abre a base; o P3 mexe só nos três adaptadores dos clientes e no `fake-agent`, e testa contra um receptor falso até o P2 chegar; o P5 mexe só no protocolo e no exportador; o P11 é da Fase 7 e não depende do resto.
2. P2, P4 e P6.
3. P7 e P9.
4. P8, P10 e P12.
5. P13.

O P14 e o P15 entraram depois do plano, pela segunda rodada de decisões de 2026-11-21 (N200, item 4, e N222). O P14 mexe só na TUI e corre junto de qualquer onda; o P15 vem depois do P4 e antes do P9, que lê as esperas.

Marco interno **[proposta]**: ao fim da onda 2, uma peça contra o `fake-agent` deixa na `telemetry.sqlite` os spans do daemon e os registros OTLP do cliente simulado, com a mesma correlação, e o arquivo ATIF dela passa no validador do Harbor. É o ponto em que o dono pode olhar os dados antes da exportação, da análise e dos painéis.

**Estimativa:** 1 semana, como na §10. Pelo ritmo das Fases 6 e 7, com agentes, fica perto de 3 a 4 dias **[proposta]**. São 16 passos, com o P14 e o P15.

### P1. Base de telemetria: porta, adaptador e chaves (N54; §5.11)

- **Porta** `TelemetryStore` em `core/src/ports/telemetry-store.ts`, com versão própria: gravar lotes de spans, de pontos de métrica e de registros de log; ler por peça, por tentativa e por janela de tempo; apagar por idade (para o P8); e um `health()`.
- **Adaptador** novo `adapters/telemetry-sqlite`, no molde do `store-sqlite` (Kysely, `better-sqlite3` ou `node:sqlite`, migrações versionadas), sem reaproveitar o arquivo do store. Esquema **[proposta]**:
  - `resources` (atributos do recurso, por hash, com `service.name`, cliente, perfil e os ids `otheater.*`);
  - `spans` (`trace_id`, `span_id`, `parent_span_id`, nome, tipo, início e fim em ns, status, atributos em JSON, `resource_id`, e as colunas de correlação `play_id`, `stage_id`, `attempt_id`, `session_id`, com índices);
  - `metric_points` (nome, tipo, unidade, tempo, valor, atributos, `resource_id` e a correlação);
  - `log_records` (tempo, severidade, nome do evento, corpo redigido, atributos, `resource_id` e a correlação);
  - `meta` (versão do esquema e o horário da criação).
- **Chaves** (N54, já decididas; entram agora): `telemetry.file` (padrão `telemetry.sqlite`, relativo à pasta de dados), `telemetry.synchronous` (`normal` | `full`), `telemetry.enabled` (`on` | `off`, padrão `on`) **[proposta]** e `backup.telemetry` (`exclude` | `include`, padrão `exclude`).
- **Falha:** base corrompida ou disco cheio não param o daemon. Ele renomeia o arquivo para `telemetry.sqlite.broken-<data>`, recria a base vazia, avisa no log e emite `telemetry.store_reset` (situações viram eventos). Sem base, a gravação vira descarte com contador.
- **Escrita:** em lotes, numa fila com teto (`telemetry.write.batch`, `telemetry.write.queue_max`) **[proposta]**; com a fila cheia, descarta o mais antigo e conta.
- **Aceite:** testes da porta contra o adaptador com os dois drivers; recriação depois de arquivo corrompido, com o evento; `backup.telemetry: exclude` deixa o arquivo fora do backup; o store continua em `FULL` e a telemetria em `NORMAL` (teste lê o `PRAGMA`).

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #242 (f7d18e0) [S: descrição do PR]. Porta `TelemetryStore` (`@otheater/core`) na versão 0.1.0, com escrita em lotes de spans, pontos de métrica e registros de log (assíncrona, nunca lança), leitura por cenário, peça, tentativa, sessão e janela `[de, até)`, `deleteOlderThan`, `health()` e tempo em `bigint` de ns. Adaptador `packages/adapters/telemetry-sqlite` (Kysely, `better-sqlite3` e `node:sqlite`, migração `0001_telemetry`) com `resources` (por hash), `spans`, `metric_points`, `log_records` e `meta`, WAL e `synchronous = NORMAL`. Fila de escrita com teto: cheia, descarta os mais antigos e conta. Arquivo corrompido, disco cheio ou migração que falha: o arquivo vira `telemetry.sqlite.broken-<data>`, a base é recriada, há aviso no log e o evento `telemetry.store_reset` (só o nome do arquivo). Evento novo: `telemetry.store_reset`. Chaves, todas **[proposta]** com o padrão em primeiro: `telemetry.enabled` (`on` | `off`), `telemetry.file` (`telemetry.sqlite`), `telemetry.synchronous` (`normal` | `full`), `telemetry.write.batch` (500), `telemetry.write.queue_max` (20.000), `telemetry.write.flush_interval` (1s), `telemetry.write.retry_after` (1m), `telemetry.clients.claude-code|codex|opencode` (`on` | `off`, ou objeto com `enabled`; `claude-code.traces` e `opencode.ai_spans` desligados) e `backup.telemetry` (`exclude` | `include`, padrão `exclude`; a N54 já decidira o nome e os modos).

**Divergências:**
- as chaves `telemetry.write.*` e `telemetry.clients.*` não estavam no plano **[proposta]**;
- a cópia com `backup.telemetry: include` que falha gera `recovery.notice` `backup_telemetry_failed` e não derruba o backup (o plano não dizia); `ot restore` devolve o arquivo;
- sem base, escrever vira descarte com contador, e a retenção real (`deleteOlderThan` em uso) ficou para o P8.

### P2. Receptor OTLP e redação (N211, N212; §5.11)

- **Receptor** OTLP/HTTP no daemon, com `POST /v1/traces`, `/v1/metrics` e `/v1/logs`, em loopback, numa porta própria (N212 (a)) **[proposta]**: `telemetry.receiver.port: auto`, um token por subida do daemon, conferido no cabeçalho `Authorization` que os clientes recebem por `OTEL_EXPORTER_OTLP_HEADERS` (P3). Sem CORS e sem Origin: só processos locais falam com ele.
- **Formatos:** JSON do OTLP, com `gzip` pelo `node:zlib`, validado por zod no que o daemon usa. O protobuf entra só se a N211 escolher (b) ou (c) (`telemetry.receiver.formats: json | json_protobuf`). Corpo acima de `telemetry.receiver.max_body` (padrão 8 MB) **[proposta]** recebe 413, e o cliente descarta o lote.
- **Correlação:** os atributos de recurso `otheater.play_id`, `otheater.stage_id`, `otheater.attempt_id`, `otheater.session_id`, `otheater.profile` e `otheater.client` (P3) viram as colunas do P1. No Codex, por processo: o receptor liga o registro à sessão pelo `conversation.id` (= `sessionId` do ACP), com a tabela de sessões abertas que o daemon já tem.
- **Redação** (`telemetry.redaction`, padrão `default`) **[proposta]**, antes de gravar:
  - sempre: `user.email`, `user.account_id`, `organization.id`, `host.name`, e todo valor que passe pelo `SecretVault` ou case com as chaves de segredo reconhecidas (as mesmas do ATIF, §5.11);
  - no modo `default`, também o conteúdo: o prompt e a resposta (`prompt`, `ai.prompt.*`, `ai.response.*`, `gen_ai.*.content`), e os `arguments` e o `output` do `codex.tool_result`, trocados por tamanho e hash;
  - no modo `full`, o conteúdo fica, e os segredos continuam mascarados;
  - os nomes dos atributos redigidos ficam numa lista no registro, para ninguém confundir ausência com redação.
- **Eventos:** `telemetry.receiver_started` (com a porta), `telemetry.batch_rejected` (formato, tamanho, token) e `telemetry.redacted` agregado por minuto **[proposta]**, nenhum com conteúdo.
- **Aceite:** testes com os registros reais do spike reduzidos a fixtures sem dado pessoal (os campos sensíveis trocados por valores falsos); a redação tira `user.email` e o resultado de ferramenta do Codex em `default`; token errado dá 401; gzip e JSON; corpo grande dá 413; nenhum teste abre porta fora do loopback.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #250 (10e52a2) [S: descrição do PR]. Receptor OTLP/HTTP JSON em `packages/daemon/src/telemetry/receiver.ts`: `POST /v1/traces`, `/v1/metrics` e `/v1/logs`, só em `127.0.0.1`, em porta própria (N212 (a)), com um token por subida no `Authorization`; sem CORS, e `Origin` ou `Host` estranho dá 403. gzip por `node:zlib`, validação por zod, 413 acima do teto (também contra bomba de gzip), 415 para protobuf e para `Content-Encoding` desconhecido; nenhum pacote novo (N211 (a)). Correlação por atributos `otheater.*` do recurso e, para o Codex (várias sessões por processo), por `conversation.id` ou `session.id` numa tabela das sessões abertas, que o pool preenche. Redação (`redaction.ts`): sempre as chaves de identidade, os valores do cofre e as chaves com cara de segredo; no modo `default` também o conteúdo, trocado por tamanho e hash; no `full` o conteúdo fica. Chaves **[proposta]**: `telemetry.receiver.port` (`auto` | número; `auto`), `telemetry.receiver.max_body` (8 MB) e `telemetry.redaction` (`default` | `full`; `default`). Eventos novos, sem conteúdo: `telemetry.receiver_started`, `telemetry.batch_rejected` e `telemetry.redacted` (os dois últimos agregados por minuto). Notice novo: `daemon.notice` com `kind: telemetry_receiver_unavailable`. Sem rota nova na API: o receptor tem as suas.

**Divergências:**
- a sessão não vem do recurso: o id da sessão ACP só existe depois do `session/new`, então o receptor a resolve pela tabela (`TelemetrySessions`) **[proposta]**;
- no Codex, o `ClientOtel` do processo leva só o estável (`otheater.client` e `otheater.profile`), para a `sharedProcessKey` não mudar entre tentativas e o compartilhamento de processos continuar; o recurso completo vai em `options.otel` de `openSessionOn` e `loadSessionOn`. Custo: registros que chegam antes do registro da sessão, ou de uma conversa desconhecida, ficam sem correlação (campos nulos);
- a redação ganhou chaves de conteúdo a mais (`ai.toolCall.*`, `tool_*`, `user_prompt`), uma lista branca de metadados `ai.response.*`, chaves de identidade a mais (`user.id`, `user.account_uuid`) e um mínimo de 8 caracteres para um valor do cofre entrar na comparação **[proposta]**;
- 403 por `Origin` ou `Host` conta sob o motivo `token` (os motivos de `batch_rejected` são `format`, `size` e `token`);
- o `otheater.trace_id` não foi gravado aqui: ficou o ponto de extensão `resourceExtras`, para o P4;
- risco: a tabela é indexada pelo id da sessão do cliente, e o `fake-agent` numera `fake-session-N` por processo, então duas tentativas simultâneas dele colidem na tabela (o teste de integração as roda em série); em clientes reais os ids são únicos. A redação por chave é heurística: no modo `full`, um segredo em texto livre sem relação com o cofre pode passar.

### P3. Clientes e `fake-agent` mandam ao receptor (N213; §5.11)

- **Claude Code:** no `env` da sessão ACP (`_meta.claudeCode.options.env`), `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, o endpoint, o cabeçalho com o token e o `OTEL_RESOURCE_ATTRIBUTES` com os ids `otheater.*` da tentativa. Os traces do Claude Code ainda são beta: ligados só com `telemetry.clients.claude-code.traces: on` **[proposta]**, padrão `off`.
- **Codex:** a configuração `[otel]` vai por `-c otel.*` no comando do `app-server` (o wrapper em `CODEX_PATH` que o spike validou), nunca no `config.toml` do perfil do dono; o `session/set_title` antes do primeiro prompt, para evitar a thread extra de título [V: Fase 0]. A correlação é por processo e por `conversation.id` (P2).
- **OpenCode:** `OTEL_EXPORTER_OTLP_ENDPOINT`, o cabeçalho e os atributos de recurso. O `experimental.openTelemetry`, que dá tokens e modelo mas manda o prompt em claro, é a N213, padrão `off` na recomendação.
- **Chaves:** `telemetry.clients.<cliente>: on | off` (padrão `on` quando `telemetry.enabled: on`) **[proposta]**. Nada disso toca o `~/.claude`, o `~/.codex` ou o `~/.config/opencode` da pessoa: tudo vai pelo ambiente e pelos argumentos do processo que o daemon lança.
- **`fake-agent`:** com as variáveis `OTEL_*` presentes, manda OTLP/JSON ao endpoint (um span por turno, métricas de tokens, um log por ferramenta), com os atributos de recurso que receber. É o que os testes e o aceite usam no lugar dos clientes reais (N57).
- **Aceite:** testes de cada adaptador conferem o ambiente e os argumentos gerados, sem rodar o cliente; o `fake-agent` manda a um receptor falso do teste, com a correlação certa; com `telemetry.enabled: off`, nenhum cliente recebe variável OTel.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #243 (803fb50) [S: descrição do PR]. Tipo único `ClientOtel` (`endpoint`, `headers`, `resource`, `traces?`, `experimental?`) em `core/src/ports/client-otel.ts`, entregue em `SessionStartOptions.otel` e no `launchSpec`; sem `otel`, nenhuma variável `OTEL_*` é passada. Claude Code: `_meta.claudeCode.options.env` com `CLAUDE_CODE_ENABLE_TELEMETRY=1`, exportadores `otlp` de métricas e logs em `http/json`, e traces só com `traces` ligado. Codex: `[otel]` por `-c otel.*` no `app-server`, por um wrapper em `CODEX_PATH` gravado na pasta do perfil, sem segredo no arquivo. OpenCode: `OTEL_EXPORTER_OTLP_*` e `OTEL_RESOURCE_ATTRIBUTES`, com `experimental.openTelemetry` só quando `experimental` está ligado (N213 (a)), por `OPENCODE_CONFIG_CONTENT`. O `session-acp` envia `session/set_title` depois de `session/new` ou `load`. O `fake-agent` manda OTLP/JSON por `fetch` quando recebe `OTEL_EXPORTER_OTLP_ENDPOINT`. Nada vai para `~/.claude`, `~/.codex` nem `~/.config/opencode`. Aviso novo `otel_unavailable` (log e `daemon.notice`); nenhum evento novo. Chaves **[proposta]**: `clients.codex.otel.codex_path` e `clients.codex.otel.platform`, opções do adaptador.

**Divergências:**
- o token do receptor vai no `argv` do `codex` real (por `-c otel.*`), visível no `ps` local, e não no arquivo do wrapper; o receptor só escuta no loopback. Registrado na N213 para o dono [S];
- a chave `headers` do `otlp-http` do Codex e a codificação de `OTEL_EXPORTER_OTLP_HEADERS` não rodaram contra um receptor que as confira; o P2 fechou o lado do receptor com o `fake-agent` **[N: nenhum cliente real foi rodado]**.
- o P13 acrescentou `ClientOtel.metricsIntervalMs` e a chave `telemetry.clients.claude-code.metrics_interval` (`5s` | duração | `client`) **[proposta]**, que vira `OTEL_METRIC_EXPORT_INTERVAL` no Claude Code: com os 60 s do cliente, nenhuma sessão curta mandava métrica antes do SIGTERM do fim da sessão [V: aceite real, 2026-11-21]; pergunta N230 (4).

### P4. Spans do daemon (N214; §5.11)

- **Árvore:** peça → etapa → tentativa → sessão → chamada de ferramenta, com as convenções GenAI de agentes: `invoke_agent` na tentativa e na sessão (com `gen_ai.agent.name` = papel, `gen_ai.request.model`, `gen_ai.provider.name`), `execute_tool` na chamada de ferramenta (com `gen_ai.tool.name` e `gen_ai.tool.call.id`) e spans próprios `otheater.play`, `otheater.stage` e `otheater.wait` **[proposta]**. As convenções ainda estão em "Development": os nomes ficam numa tabela só, num arquivo, para mudar num lugar.
- **Como nascem** (N214 (a)) **[proposta]**: um projetor lê o log de eventos com cursor próprio e grava os spans na `telemetry.sqlite`. O span abre num evento (`play.transitioned`, `attempt.started`, `session.started`, `tool.called`) e fecha noutro, com o horário do evento. É idempotente: perder a base de telemetria e reprojetar dá os mesmos spans, com ids derivados dos ids do log.
- **Espera** (item da N55): span `otheater.wait` para a espera na `prompt_queue`, nos semáforos de concorrência e por cota, com o motivo. Sem evento novo no log, para não inflá-lo (N217 (a)).
- **Ligação com os clientes:** o `trace_id` da tentativa vai ao cliente como atributo de recurso (`otheater.trace_id`), e os spans do cliente que chegarem pelo P2 com o atributo ficam filhos da sessão. Sem propagação W3C pelo ACP, que nenhum dos três aceita hoje **[N]**.
- **Aceite:** uma peça contra o `fake-agent` gera a árvore completa, com pais certos e tempos coerentes (relógio falso); reprojetar depois de apagar a base dá os mesmos spans; uma espera por cota simulada aparece como `otheater.wait`.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #249 (7fa8685) [S: descrição do PR]. Um projetor lê o log de eventos com cursor próprio e escreve na base a árvore `otheater.play` > `otheater.stage` > `invoke_agent` (tentativa) > `invoke_agent` (sessão) > `execute_tool`, mais `otheater.wait` (N214 (a), N217). Os ids saem dos ids do log (sha256), então reprojetar dá os mesmos spans; há um trace por peça, e a tentativa sem peça (a do Diretor) tem trace derivado do id dela. Arquivos em `packages/daemon/src/telemetry/`: `span-conventions.ts` (tabela única de nomes e atributos GenAI e `otheater.*`), `span-ids.ts` (inclui `traceIdForAttempt`), `span-projection.ts`, `daemon-spans.ts` e `wait-recorder.ts`. Porta `TelemetryStore` 0.2.0 (aditiva): `readCursor`, `writeCursor` e índice único `(trace_id, span_id)` com insert-or-ignore (migração `0002_span_identity`). O cursor é a marca d'água em `meta`; se a base for recriada, reprojeta do evento 0. Chave **[proposta]**: `telemetry.daemon_spans` (`on` | `off`, ou objeto `{enabled, waits: all | log | off}`; padrão `on` e `all`). Notice novo: `daemon.notice` com `kind: daemon_spans_failed`. Nenhum evento novo.

**Divergências:**
- as esperas que o log não conta (fila de prompts do `PromptDispatcher` e admissão do `SessionPool`) saíam direto por `DaemonSpans.recordWait`, sem evento, e não eram reprojetáveis; o P15 as trocou por eventos (abaixo e N222);
- a espera do pool começa antes do span da tentativa (não há evento de início); um `sessionId` reaproveitado (`session/load`, o `fake-session-1` do `fake-agent`) mantém só o primeiro span; um play longo prende a marca d'água.
- a ligação com os clientes ficou pela metade: o `otheater.trace_id` não vai ao cliente (o `resourceExtras` do P2 continua sem uso) e o receptor não põe os spans do cliente sob o span da sessão; a correlação é só por atributo [V: código, 2026-11-21]. A lacuna segue aberta, pergunta N230 (2).

### P5. ATIF: schema zod e exportador (N219; §5.11; Q11)

- **Schema** zod da ATIF v1.8 em `protocol/src/atif/`, a partir da RFC 0001 e dos modelos Pydantic do Harbor (`extra="forbid"`: nenhum campo fora do schema), com o bloco `extra.otheater` (`schema: 1`) em cada nível que a §5.11 lista.
- **Exportador** `daemon/src/atif/`: dobra o log de eventos e a `usage` da peça em ATIF, sobre a leitura do `buildTrajectory` do P14, e acrescenta:
  - `step_id` sequencial, `source` (`user`, `agent`, `system`), `message`, `reasoning_content`, `tool_calls` e `observation`;
  - métricas por passo e finais, com `cost_usd` só quando o custo é real (conta de API); numa assinatura, nulo, e o equivalente em API e o uso da cota vão no `extra.otheater` (§5.11);
  - a peça inteira como unidade: a raiz é a trajetória do Diretor, e cada tentativa entra em `subagent_trajectories`, com `trajectory_id` igual ao id da tentativa e um passo `source: "agent"` com `llm_call_count: 0` e `subagent_trajectory_ref` no ponto em que o daemon a lançou [S: RFC v1.7; a confirmar no P6];
  - o conteúdo completo por padrão, com os valores do `SecretVault` e as chaves de segredo sempre mascarados.
- **Chaves** (§5.11): `atif.export.unit` (`play` | `attempt` | `play_files`), `atif.export.content` (`full` | `redacted`), `atif.export.on` (N219) e `atif.export.dir` (padrão `<pasta de dados>/trajectories/`) **[proposta]**.
- **Saída:** um arquivo por peça (ou por tentativa), a rota `GET /v1/plays/:playId/atif` e o comando `ot trajectory export <peça>`, com o evento `atif.exported` (caminho e tamanho, sem conteúdo).
- **Aceite:** o schema zod aceita os exemplos da RFC (o `gemini-cli-trajectory.json` e os do repositório, guardados como fixtures com a licença) e recusa um campo solto; uma peça contra o `fake-agent` com Diretor, Ator e Revisor vira um arquivo que passa no schema; segredo de teste nunca aparece no arquivo, em nenhum modo.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #244 (ad8bc79) [S: descrição do PR]. Schema zod estrito da ATIF v1.8 em `packages/protocol/src/atif/` (as regras dos validadores do Harbor e o bloco `extra.otheater` com `schema: 1`), exportador em `packages/daemon/src/atif/` e uma peça por arquivo: a raiz é a trajetória do Diretor, e cada tentativa entra em `subagent_trajectories` com `trajectory_id` igual ao id dela, ligada a um passo do Diretor com `llm_call_count: 0` e `subagent_trajectory_ref`. `cost_usd` só com custo real (conta de API); em assinatura fica `null`, e o custo equivalente e o uso da cota vão em `extra.otheater`. Valores do `SecretVault` e chaves secretas são sempre mascarados, e o cofre trancado com `content: full` não grava nada. Chaves (a quente não; reinício) **[proposta]**, salvo os modos da N219: `atif.export.unit` (`play` | `attempt` | `play_files`; `play`), `atif.export.content` (`full` | `redacted`; `full`), `atif.export.on` (`play_end` | `attempt_end` | `manual`; `play_end`; `attempt_end` só com `unit` `attempt` ou `play_files`) e `atif.export.dir` (`trajectories` na pasta de dados). Rota `GET /v1/plays/:playId/atif` (consulta `content` e `attemptId`); comando `ot trajectory export <peça> [--unit] [--content] [--out]`, com o daemon parado ou no ar (no ar, só a unidade `play`). Eventos novos: `atif.exported` e `atif.export_failed`, sem conteúdo.

**Divergências:**
- dos exemplos do RFC, entraram o do próprio RFC e o `hello` do Harbor; gemini-cli, mini-swe-agent e openhands são formatos nativos, não ATIF, e o `pass.json` foi pulado por ser grande;
- o fluxo normalizado não guarda a entrada nem a saída crua das ferramentas: `arguments` leva o título e `observation` o estado e o desfecho (`extra.otheater.fidelity` registra isso);
- revisores e etapas aparecem como tentativas de papel `actor`, e `agent.version` é `unknown` para os clientes;
- a semântica de `cachedTokens` do `usage` não foi verificada contra cada cliente (o mapeamento parte de que `inputTokens` não o inclui) **[N]**;
- com o padrão `play_end`, todo jogo concluído num teste e2e grava um arquivo e emite `atif.exported`.

### P6. Validação pelo `TrajectoryValidator` do Harbor (N215)

- `tools/atif-validate/`: um script Python pequeno que chama o `TrajectoryValidator` do Harbor nos arquivos que receber e devolve JSON com os erros.
- **Instalação** (N215 (a)) **[proposta]**: um ambiente do `uv` com a versão fixada do `harbor`, a mais nova com duas semanas que aceite `ATIF-v1.8`, criado só na CI e, na máquina, só com `OT_TEST_HARBOR=1`. O passo tenta primeiro o pacote sem as dependências pesadas (`--no-deps`, mais o `pydantic`), e só cai para a instalação completa se o validador não importar sem elas **[N]**.
- **CI:** um job `atif` no Linux, que roda quando mudam `protocol/src/atif/`, `daemon/src/atif/` ou `tools/atif-validate/`, gera as trajetórias de teste do P5 e as passa no validador.
- **Confirmações** que fecham aqui: a ligação da tentativa ao passo do Diretor (`llm_call_count: 0` e `subagent_trajectory_ref`) e os três modos de `unit`. Se o validador recusar o desenho da §5.11, o passo volta ao dono antes de mudar o formato.
- **Aceite:** o job `atif` verde com as trajetórias das três unidades e dos dois modos de conteúdo; um arquivo quebrado de propósito reprova.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #252 (d40b20d) [S: descrição do PR]. `tools/atif-validate/` (`atif_validate.py`, `requirements.in` e `requirements.txt` com hashes, `run.sh`) chama o `TrajectoryValidator` do Harbor 0.25.0 sobre as trajetórias do exportador, com `uv` e sem Docker, instalando só `harbor` e `pydantic` com as dependências do `pydantic` (6 pacotes, nenhuma das pesadas do Harbor). O gerador é `packages/daemon/src/atif/atif-harbor.test.ts`, que só roda com `OT_ATIF_OUT=<pasta>` e escreve 6 pastas (32 arquivos: três unidades, dois modos) mais 5 cópias quebradas de propósito. Job novo `atif` no `.github/workflows/ci.yml` (Linux; roda em PR quando mudam os caminhos da ATIF e em `workflow_dispatch`; `setup-uv` fixado pelo commit). Fora do GitHub Actions, só baixa o pacote com `OT_TEST_HARBOR=1`. Sem chave, evento nem rota.

**Divergências:**
- **[V: no PR]** o Harbor aceitou as 32 trajetórias, e o desenho da §5.11 (passo do Diretor que lança a tentativa) não foi recusado: nenhum formato mudou. Reprovam, como devem, campo fora do schema, `schema_version` inexistente, `step_id` fora de sequência, passo de despacho com `metrics` e tentativa embutida sem `trajectory_id`;
- o validador não resolve `subagent_trajectory_ref` nem `trajectory_path` entre os arquivos; essa ligação é conferida pelo teste, não pelo Harbor;
- `harbor` 0.25.0 é a mais nova com duas semanas que aceita `ATIF-v1.8` [S: PyPI, 2026-11-21]; a 0.26.0 passa das duas semanas em 2026-11-27. Ao subir, regenerar o `requirements.txt` e rodar o `run.sh`;
- a licença PSF-2.0 do `typing-extensions` não está na lista do `policy.json`; é só ferramenta de CI e nada é distribuído (**[proposta]**: aceitar);
- a instalação completa (`OT_ATIF_HARBOR_FULL=1`) existe como reserva e não foi exercitada **[N]**.

### P7. Exportação: OTLP para fora e `/metrics` (N70, N211, N218; §5.11)

- **OTLP** (`telemetry.export: otlp | both`): um exportador lê a `telemetry.sqlite` por cursor e reenvia spans, métricas e logs ao `telemetry.otlp.endpoint`, com os cabeçalhos de `telemetry.otlp.headers` resolvidos pelo `SecretVault`. O protocolo segue a N211: na recomendação, `http/json` com código próprio, e `http/protobuf` e `grpc` ficam como modos futuros da chave `telemetry.otlp.protocol`. O que sai já saiu redigido do P2.
- **Falha do destino:** tentativas com recuo, depois descarta o lote, avisa no log e emite `telemetry.export_failed` (destino, quantidade, motivo) **[proposta]**. A gravação local nunca para.
- **Prometheus** (`telemetry.export: prometheus | both`): `GET /metrics` na API do daemon, com as mesmas regras de acesso dela (loopback e token), em formato de texto, por código próprio. Métricas (N218) **[proposta]**:
  - `otheater_quota_used_ratio{profile,client,window}` e `otheater_quota_resets_at_seconds{profile,client,window}`;
  - `otheater_usage_tokens_total{profile,executor,model,kind}` e `otheater_usage_cost_usd_total{profile,executor,source}` (real) e `otheater_usage_api_equivalent_usd_total{profile,executor}`;
  - `otheater_scheduler_queue_depth{queue}`, `otheater_attempts_total{executor,role,outcome}`, `otheater_resumes_total{executor,reason}` e `otheater_executor_failures_total{executor,kind}`;
  - `otheater_telemetry_dropped_total{reason}`;
  - os rótulos nunca levam e-mail nem id de conta: o perfil vai pelo nome.
- **Aceite:** com `export: both`, o trace de uma peça chega a um receptor OTLP de teste (o próprio código do P2 numa porta de teste) e o `/metrics` responde com as métricas acima; com o destino fora do ar, a peça termina e o evento aparece; com `export: off`, nada sai e o `/metrics` dá 404.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #255 (aa20105) [S: descrição do PR]. Dois caminhos para fora, nenhum ligado por padrão (N70, N211 (a), N218 (a)). **OTLP:** um exportador lê o `telemetry.sqlite` por cursor e reenvia spans, métricas e logs a `telemetry.otlp.endpoint` em `http/json`, com código próprio e zero pacotes novos; os cabeçalhos vêm de `telemetry.otlp.headers`, que mapeia o nome do cabeçalho para a chave de um segredo do cofre, lido a cada requisição; nada é redigido de novo (a base já foi redigida no recebimento). **Prometheus:** `GET /metrics` na API do daemon, com as mesmas regras de acesso (loopback e token), em texto 0.0.4 escrito à mão; com `export: off` devolve 404, e sem token 401. Falha do destino: retentativas com recuo, depois descarta o lote (ou o mantém, em `hold`), avisa no log e emite `telemetry.export_failed`; a escrita local nunca para. Uma passada final (`finish()`) roda depois dos spans do daemon, no desligamento. Porta `TelemetryStore` 0.3.0, com `readSince(signal, afterRowId, limit)`. Evento novo **[proposta]**: `telemetry.export_failed` (destino sem caminho nem credenciais, sinal, motivo, status HTTP, contagens e modo). Chaves: `telemetry.export` (`off` | `otlp` | `prometheus` | `both`; `off`), `telemetry.otlp.endpoint` (nulo; obrigatório com `otlp` ou `both`), `telemetry.otlp.protocol` (só `http/json`; `http/protobuf` e `grpc` são modos futuros e a configuração os recusa com mensagem clara) e `telemetry.otlp.headers` (`{}`), nomeadas pelo plano; **[proposta]**: `telemetry.otlp.compression` (`none` | `gzip`), `.timeout` e `.interval` (10s), `.batch` (500), `.signals.{traces,metrics,logs}` (`on`), `.retry.{retries,backoff,initial,max}` (3, `exponential` | `fixed`, 1s, 30s), `.on_failure` (`drop` | `hold`; `drop`), `.failure_report` (1m) e `telemetry.prometheus.cache_ttl` (5s). Métricas **[proposta]**: `otheater_quota_used_ratio`, `otheater_quota_resets_at_seconds`, `otheater_usage_tokens_total`, `otheater_usage_cost_usd_total`, `otheater_usage_api_equivalent_usd_total`, `otheater_scheduler_queue_depth`, `otheater_attempts_total`, `otheater_resumes_total`, `otheater_executor_failures_total` e `otheater_telemetry_dropped_total`.

**Divergências:**
- a configuração recusa `otlp` ou `both` sem endpoint ou com `telemetry.enabled: off`, e cabeçalhos por `http://` fora do loopback;
- a codificação OTLP perde onde a base não guardou o dado: escopo de instrumentação fixo `otheater`, ponto de métrica sempre `asDouble`, atributo `null` omitido, soma sem temporalidade como cumulativa e não monotônica;
- ficaram de fora, por falta de fonte: a fila de espera de seleção de Executor (o `scheduler_queue_depth` cobre a fila de prompts) e o contador de lotes recusados pelo receptor por motivo;
- os contadores por Executor contam desde o início do daemon e zeram no reinício; `paused` e `profile_removed` não contam como falha do Executor;
- sem cursor gravado, o exportador reenvia o histórico retido uma vez; `hold` é um modo extra de `on_failure`;
- `/metrics` é montada fora do registro de rotas, então o catálogo `api-routes.json` não muda;
- as perguntas ao dono estão na N225.

### P8. Retenção e expurgo (N216; §5.11)

- **Telemetria:** `telemetry.retention.days` (padrão 30) e `telemetry.retention.max_mb` (padrão 1024) **[proposta]**; o expurgo roda na subida e uma vez por dia, só depois de o P9 guardar os agregados do período, e emite `telemetry.purged` (linhas, bytes, período).
- **Store:** nesta fase, nada sai do store (N216 (a)). O log de eventos é a fonte única do estado e da reconciliação (§5.21), e a compactação dos `session.update` de uma tentativa terminada em trajetória (a frase da §5.11) fica para depois, com a sua própria decisão.
- **`daemon.log`:** gira por tamanho, `log.rotate.max_mb` (padrão 20) e `log.rotate.keep` (padrão 5) **[proposta]**.
- **Aceite:** com o relógio falso, o expurgo apaga só o que passou do prazo e mantém os agregados; o teto de tamanho apaga do mais antigo; o `daemon.log` gira e mantém só as cópias da chave.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #257 (4c47d2a) [S: descrição do PR]. Retenção da telemetria bruta (N216 (a)): o expurgo mexe só no `telemetry.sqlite`, e o log de eventos e o `usage` do store ficam como estão. Uma passada espera o `catchUp()` da análise (P9), apaga o que passou de `telemetry.retention.days`, enquanto os dados em uso passam de `max_mb` apaga a hora mais antiga e só compacta o arquivo se ele continua acima do teto; com `guard: rollups` nunca apaga o que os agregados `rollups_daily` ainda não cobrem (`AnalysisService.readyCutoff()`). Roda ao subir e a cada `interval`, no relógio injetado. Porta `TelemetryStore` 0.4.0: `footprint()` (`usedBytes`, `fileBytes` e `oldestUnixNano`) e `compact()` (checkpoint, `VACUUM`, checkpoint); o teto é medido nos dados em uso, porque o SQLite não encolhe o arquivo depois de um `DELETE`. Rotação do `daemon.log` em `packages/daemon/src/log-rotation.ts`: vira `daemon.log.1` ao passar de `max_mb`, até `keep` cópias, modo 0600, escrita síncrona; no Windows fecha o descritor antes de renomear. Chaves **[proposta]**, salvo os nomes e padrões do plano (`days` 30, `max_mb` 1024, `log.rotate.max_mb` 20 e `keep` 5): `telemetry.retention.mode` (`daily` | `startup` | `off`), `.interval` (24h), `.days` (30; 0 não apaga por idade), `.max_mb` (1024; 0 sem teto), `.guard` (`rollups` | `none`), `log.rotate.mode` (`size` | `off`), `log.rotate.max_mb` (20) e `log.rotate.keep` (5). Evento novo: `telemetry.purged` (linhas, bytes, período, motivo `age`, `size` ou `age_and_size`, tamanho do arquivo e se compactou), só quando algo foi apagado. Notices novos de `daemon.notice`: `telemetry_purge_failed`, `telemetry_purge_blocked` e `log_rotate_failed`.

**Divergências:**
- com `analysis.schedule.mode: off` e `guard: rollups`, nada é apagado (sai `telemetry_purge_blocked`), o comportamento mais conservador; quem não usa a análise escolhe `guard: none` **[proposta]**;
- a rotação no Windows segue a documentação do Node e do Win32 e não rodou lá **[S]**;
- as perguntas ao dono estão na N226.

### P9. Análise do sistema (N55, N217; §12, item 27)

- **Agregados** (N217 (a)) **[proposta]**: uma tabela `rollups_daily` na `telemetry.sqlite`, por dia, cenário, Executor e papel, com:
  - o tempo em cada estado da peça, da etapa e da tentativa (soma, p50 e p95);
  - as tentativas, as reprovações e os motivos de interrupção;
  - a espera por cota, pelo Produtor (decisão aberta) e na `prompt_queue` (dos spans `otheater.wait` do P4);
  - os tokens, o custo real, o equivalente em API e o custo por demanda aprovada;
  - a cobertura dos dados: a fração das tentativas com telemetria do cliente, e a origem de cada número (`client`, `otlp`, `pricing_table`), para o OpenCode sem tokens e o Codex por processo aparecerem como lacuna, e não como zero.
- **Retenção dos agregados:** `analysis.retention.days` (padrão 365) **[proposta]**, separada da telemetria crua.
- **Relatório:** `GET /v1/analysis?from&to&groupBy` e `ot analysis`, com os gargalos (os maiores tempos e esperas) e a comparação entre dois períodos ou duas peças.
- **Aceite:** com peças simuladas (o `fake-agent` e o relógio falso), o relatório mostra os tempos e as esperas esperados; um cliente sem tokens aparece como cobertura parcial; reprocessar um dia dá o mesmo agregado.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #254 (b1b3e36) [S: descrição do PR]. Agregados diários, relatório e comando de análise (N55, N217 (a)). A porta `TelemetryStore` vai a 0.3.0 com `replaceRollupDay`, `readRollups`, `readRollupsReadyThrough`, `markRollupsReady` e `deleteRollupsBefore`, e a migração `0003_rollups_daily` cria `rollups_daily` (chave: dia, cenário, Executor `<client>/<profile>`, papel, métrica, faceta e origem; dimensão desconhecida é texto vazio; número `NULL` é lacuna, nunca zero). O `AnalysisService` agrega por dia, cenário, Executor e papel o tempo em cada estado (soma, p50 e p95), tentativas, rejeições, motivos de interrupção, esperas (`quota`, Produtor e `prompt_queue`), tokens, custo real, custo equivalente em API e custo por demanda aprovada, com a cobertura e a origem (`client`, `otlp`, `pricing_table`, `daemon`); roda ao subir (os dias fechados que faltam) e a cada virada de dia, nunca no dia de hoje, e reprocessar um dia dá as mesmas linhas. Rota `GET /v1/analysis` (`from`, `to`, `groupBy`, `scenario`, `compareFrom`, `compareTo`, `compareScenario`; 400 para período inválido e 503 sem a base), comando `ot analysis [--from --to --group-by --scenario --compare-from --compare-to --compare-scenario --json]` (sem o daemon, ele mesmo constrói os dias que faltam) e o gancho `readyThrough()` que o P8 usa. O bloco `analysis` é frio (reinício). Chaves **[proposta]**: `analysis.schedule.mode` (`daily` | `startup` | `off`), `analysis.day_boundary` (`local` | `utc` | `+HH:MM`), `analysis.producer_wait_states` (`["AWAITING_PRODUCER"]`), `analysis.report.default_days` (7), `analysis.report.top` (5) e `analysis.retention.days` (365, valor do plano; 0 guarda para sempre). Nenhum evento novo; a falha vira `daemon.notice` com `kind: analysis_failed`.

**Divergências:**
- o dia de um span é o dia em que ele termina, e os percentis de várias linhas são aproximados (p50 média ponderada, p95 máximo; o relatório marca `percentilesApproximate`) **[proposta]**;
- como os agregados não têm a dimensão peça, a comparação é entre dois períodos ou dois cenários, e não entre peças **[proposta]**;
- a origem `daemon` entra como quarta, além das três da especificação; as rejeições são PLAN_REVIEWED para PLANNING, SCRIPT_REVIEWED para SCRIPTING e CRITIQUED para DECIDING;
- a CLI fala com a rota por `fetch`, sem método tipado em `packages/client`;
- as perguntas ao dono estão na N227.

### P10. Painéis de telemetria na aba Consumo (§5.13)

- Seções novas na aba Consumo, cada uma num componente próprio em `tui/src/tabs/usage/` e com as chaves de texto em `en` e `pt-BR`:
  - **tendência:** tokens, custo real e equivalente em API por dia, a partir do P9;
  - **gargalos:** os maiores tempos por estado e as maiores esperas, com a cobertura dos dados;
  - **peça:** a árvore de spans da peça selecionada (duração por etapa, tentativa e ferramenta), com a seleção da aba Trajetórias;
  - **telemetria:** o estado do receptor, os lotes recusados, o descarte e a exportação.
- **Chaves:** `ui.usage.sections` passa a aceitar as seções novas, e `ui.usage.trendDays` (padrão 14) **[proposta]**.
- **Aceite:** testes com o `ink-testing-library` contra o daemon com o `fake-agent`, em `en` e `pt-BR`, e o orçamento de desempenho da aba (N37) mantido.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #258 (8434d58) [S: descrição do PR]. A aba Consumo ganha quatro seções, cada uma em `packages/tui/src/tabs/usage/`: `trend` (tokens, custo real e custo equivalente por dia, dos agregados do P9; dia sem dado é lacuna `—`, nunca zero), `bottlenecks` (maiores tempos por estado e maiores esperas, com cobertura e origem), `play` (árvore de spans da peça seguida na aba Trajetórias) e `telemetry` (estado do receptor, lotes recusados, descartes e exportação). A trend e os gargalos saem de uma única chamada a `GET /v1/analysis` (`groupBy=day`). Rotas novas **[proposta]**: `GET /v1/plays/:playId/spans` (os spans do daemon da peça, em árvore, com `playClosed` e `truncated`) e `GET /v1/telemetry` (receptor, base e exportação; o receptor ganhou contadores de lotes aceitos e recusados); nenhuma registra evento, e o `api-routes.json` foi regenerado. Chaves **[proposta]**: `ui.usage.sections` (`totals, groups, budget, trend, bottlenecks, play, telemetry`; qualquer subconjunto e ordem; a seção fora da lista não é desenhada e a rota dela não é lida), `ui.usage.trendDays` (14; 1 a 90) e `ui.usage.spanRows` (40; 5 a 500). Nenhum evento novo. As leituras seguem o orçamento N37 da aba (só no cronômetro e na tecla de atualizar).

**Divergências:**
- os spans do daemon só são gravados ao fechar, então com a peça em curso a árvore lista só o que já fechou (`playClosed=false`) e o span da peça aparece depois;
- a seção `play` só acha a peça se a aba Trajetórias já carregou a sessão **[S]**;
- as perguntas ao dono estão na N228.

### P11. `terminal.output` e peças terminadas na lateral (N200, itens 3 e 5)

- **`terminal.output`:** o daemon passa a emitir o evento com a saída dos terminais da sessão (o ACP `terminal/output`), em blocos com teto e com a mesma redação de segredo dos outros eventos, para a aba Trajetórias e o ATIF mostrarem a saída. Chave `events.terminal_output: on | off | truncated` (padrão `truncated`, 64 KB por terminal) **[proposta]**.
- **Lateral:** as peças terminadas aparecem na lateral sem precisar de `plays: all`, numa seção recolhida "Terminadas", com `ui.sidebar.finishedPlays: collapsed | hidden | expanded` (padrão `collapsed`) **[proposta]**.
- **Aceite:** o `fake-agent` com um terminal gera `terminal.output` e a aba Trajetórias mostra a saída; a lateral mostra a peça terminada na seção recolhida.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #247 (a232366) [S: descrição do PR]. O daemon registra a saída dos terminais dos Executores pela convenção `_meta.terminal_output` e `terminal_output_delta` do ACP, em blocos de até 16 KB, com `maskSecrets` por linha e o corte marcado; o transporte declara `_meta.terminal_output_delta` no `initialize` só com a saída ligada (`terminal` continua `false`). Evento novo `terminal.output` (`sessionId`, `terminalId`, `toolCallId`, `text`, `truncated`, `omittedBytes`, `exitCode`, `signal` e a correlação `playId`, `demandId` e `attemptId`; a nota de fechamento vem com `text: ''`). `buildTrajectory` junta os blocos do mesmo terminal e a aba Trajetórias mostra a saída esmaecida e o aviso de corte; o `fake-agent` ganhou o roteiro `terminal`. A lateral ganha a seção recolhida "Terminadas" (✓ concluída, ✗ cancelada), mesmo sem `plays: all`, e `DaemonStores.loadFinishedPlays(limit)`. Chaves **[proposta]**: `events.terminal_output` (`on` | `off` | `truncated`; `truncated`), `events.terminal_output_max` (64KB), `ui.sidebar.finishedPlays` (`collapsed` | `hidden` | `expanded`; `collapsed`), `ui.sidebar.finishedLimit` (20; 1 a 500) e a tecla `F` (`sidebar.toggleFinished`, contexto da lateral, remapeável).

**Divergências:**
- o estado aberto ou fechado da seção vale só na sessão da TUI (o `LayoutStore` guarda só ids recolhidos), e a chave `finishedLimit` é extra;
- a convenção do terminal só foi confirmada no `claude-agent-acp` 0.107.0, lido localmente; Codex e OpenCode ficam sem confirmação **[N]**;
- ficaram de fora o `terminal/create` do ACP e as sessões diretas (o `direct/service.ts` ignora as atualizações de terminal).

### P12. Phoenix opcional: receita (§5.11)

- `docs/reference/phoenix.md`: como apontar o `telemetry.otlp.endpoint` para um Phoenix local e importar um arquivo ATIF, com a licença (ELv2, para uso local) e o aviso de que o OTheater não o instala nem o embute.
- Nenhum download, e nenhum teste roda o Phoenix. O teste do P7 cobre o formato OTLP que o Phoenix recebe.
- **Aceite:** a receita está revisada contra a documentação do Phoenix, marcada como **[S]**, com data.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #256 (18715f2), só documentação [S: descrição do PR]. Novo `docs/reference/phoenix.md` com a receita do Arize Phoenix (licença ELv2), ligado no README e com um ponteiro no docs/11. Nenhum código, chave, evento ou rota muda, e nenhum download nem teste rodou o Phoenix: o OTheater não o instala nem o embute (N211 (a)). Duas receitas: (1, a recomendada **[proposta]**) `ot trajectory export` (ou o arquivo que o daemon já grava ao fim da peça) com `upload_atif_trajectories_as_spans` do `arize-phoenix-client`; (2, opcional) um OpenTelemetry Collector no meio, que recebe OTLP/JSON e reenvia em protobuf, com o bloco `telemetry` do OTheater (`telemetry.otlp.signals.metrics: off` e `logs: off`).

**Divergências:**
- **o apontamento direto não funciona:** a rota `POST /v1/traces` do Phoenix só aceita `application/x-protobuf` e responde 415 ao resto, e o Phoenix só recebe traces por OTLP (sem rota de métricas nem de logs) **[S: `routers/v1/traces.py`, 2026-11-21]**; a issue #14991 do Phoenix, aberta em 2026-08-01, pede OTLP JSON e segue aberta **[S]**. O exportador do P7 conta o 415 como `rejected`, sem repetir. É o motivo concreto da pergunta N229 (modo `http/protobuf`) e da ressalva na N211;
- o Phoenix importa ATIF declarando suporte de v1.0 a v1.7 **[S]**, e o OTheater escreve v1.8: o arquivo não foi testado no Phoenix **[N]**, e os campos de áudio da v1.8 não são convertidos;
- as páginas `arize.com/docs/phoenix/*` responderam 403 ao leitor automático, então o que delas entra vem de resultados de busca **[S]**; o nome do parâmetro `base_url` do `Client`, o comportamento de spans sem atributos OpenInference e o `play_files` no Phoenix ficam **[N]**.

### P13. Aceite da fase

- **Automático** (`daemon/src/phase8-acceptance.e2e.test.ts`) **[proposta]**: uma peça completa contra o `fake-agent`, com `telemetry.export: both`:
  - a `telemetry.sqlite` tem a árvore de spans do daemon e os registros OTLP do cliente simulado, com a mesma correlação, e sem nenhum dado pessoal;
  - o arquivo ATIF da peça passa no schema zod e, no job `atif`, no `TrajectoryValidator`;
  - o trace chega ao receptor OTLP de teste e o `/metrics` responde;
  - o relatório do P9 tem o dia da peça.
- **Real** (`tools/acceptance/real-acceptance.sh --level phase8`): uma peça com o Claude Code (haiku), com o mesmo roteiro, conferindo que os spans e métricas do cliente chegam com a correlação e que o e-mail não foi gravado. O Codex e o OpenCode entram se a rodada couber na janela do dia, também com `free -h` e `df -h /tmp` antes e com prazo.
- **Aceite:** os dois níveis verdes; o relatório do PR não traz conteúdo de registro real.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #260 (c67814e) [S: descrição do PR]. **Automático:** `packages/daemon/src/phase8-acceptance.e2e.test.ts`, uma peça com o `fake-agent` (que exporta OTLP), `telemetry.export: both`, o receptor e um destino OTLP em loopback. Confere a correlação (cenário, peça, tentativa e sessão) nas linhas do daemon e do cliente, as rotas `GET /v1/plays/:id/spans` e `GET /v1/telemetry`, o `GET /metrics` (200 com token, 401 sem), o ATIF completo e o redigido (no job `atif`, também pelo Harbor), o dia do relatório da análise com o relógio falso passando a meia-noite UTC, o expurgo que não tira o que é novo, a ausência do segredo e do e-mail em todas as tabelas e os spans no destino OTLP. **Real:** nível `phase8` do `tools/acceptance/real-acceptance.sh` e `packages/daemon/src/api/phase8-acceptance.real.test.ts` (só com `OT_TEST_REAL_PHASE8=1`), com o Claude Code (haiku) e os traces ligados. O e-mail que o teste procura vem do próprio cliente (`claude auth status --json`), sem ler arquivo de credencial, e o log diz só "presente" ou "ausente". A rodada que passou [V: log local, 2026-11-21]: peça em DONE em 117,6 s, 40 spans do daemon; do cliente, 67 spans, 107 pontos de métrica e 182 registros de log; o e-mail ausente das tabelas e do ATIF, e 0 textos com forma de e-mail; 10 tentativas na análise do dia, 9 com telemetria do cliente; 40 spans no destino OTLP; os 13 processos iniciados terminados; pico de cerca de 1,1 GB. Nenhum evento novo (137 e 139). Correções achadas pela integração: o `SpanProjection` (P4) passa a pôr o `scenario_id` da peça nos spans de tentativa, sessão e ferramenta; dois testes do P10 (spans de 1970 que o expurgo do P8 apagava, e a tendência lida antes das linhas); `DaemonHandle.analysis` expõe o serviço de análise do P9, para o teste real pedir o dia de hoje; e a chave `telemetry.clients.claude-code.metrics_interval` do P3 (acima). Variáveis só de teste **[proposta]**: `OT_TEST_REAL_PHASE8`, `OT_TEST_PHASE8_CLIENTS` (padrão `claude-code`), `OT_TEST_PHASE8_TRACES` (`on` | `off`), `OT_TEST_PHASE8_TELEMETRY_WAIT_MS` e `OT_TEST_PHASE8_EDIT_RULES`.

**Divergências:**
- o Codex e o OpenCode não rodaram no nível real **[N]**; ficam por `OT_TEST_PHASE8_CLIENTS`, pergunta N230 (3);
- o aceite confere a correlação, não a árvore única de spans (lacuna do P4, acima; N230 (2));
- os traces do Claude Code são beta, e o teste real os exige por padrão (N230 (1));
- no teste automático, `export.interval` e `export.timeout` valem 30 dias, para o relógio falso não disparar as esperas do exportador ao passar o dia.

### P14. Clique nas opções do cartão de decisão (N200, item 4; N34)

- O chat liga o `ClickTarget` (já existente, da N34) às opções do cartão de decisão: o clique numa opção faz o mesmo que as teclas do registro (`decision.up`, `decision.down`, `decision.mark` e `decision.answer`), na resposta simples e na de múltipla escolha. Com `ui.mouse: off`, nada muda.
- Não há chave nova, a não ser que o passo precise de uma; nesse caso ela entra como **[proposta]**, com modos.
- **Aceite:** teste no `ink-testing-library` com o evento de mouse simulado, nas duas formas de resposta, e um caso na fumaça em tmux (`OT_REQUIRE_TMUX=1` no job linux).

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #251 (1b52ae8) [S: descrição do PR]. Cada linha de opção do cartão de decisão do chat vira um `ClickTarget` (N34), e o clique faz o mesmo que as teclas do registro de ações (`decision.up`, `decision.down`, `decision.mark` e `decision.answer`): na escolha simples responde com a opção; na múltipla marca ou desmarca (o Enter responde com as marcadas; um clique nunca responde sozinho uma múltipla); na opção que pede texto abre a linha de digitação. A linha de descrição também é alvo da própria opção. Só o modo `full` do mouse clica (regra do PR #218). Em `packages/tui/src/chat/`, `card.ts` ganhou `CardLine.option` e a função pura `cardClick(model, state, index, mode)`, e `use-chat-panel.tsx` o `applyCard`, comum a teclas e cliques. Chave **[proposta]**: `ui.chat.decisionClick` (`answer` | `select`; `answer`: um clique já age; `select`: o primeiro só move o cursor, o segundo age), no esquema de `packages/protocol/src/ui-config.ts`. Nenhum evento nem rota. O roteiro manual `tools/acceptance/tui-terminals.md` ganhou o passo e a linha da tabela, todos **[N]**. O N34 e o item 4 da N200 estão concluídos.

**Divergências:**
- a chave `ui.chat.decisionClick` é nova: o plano a permitia só se necessária, e ela é, porque "um clique age" e "um clique seleciona" são preferências legítimas. Se o dono preferir um comportamento só, basta remover a chave, e o padrão `answer` é o comportamento sem ela;
- a fumaça em tmux cobre só a escolha simples (o `fake-agent` não tem pergunta com `multi_select`); a múltipla fica no `ink-testing-library`.

### P15. Esperas fora do log viram eventos (N222; §5.11)

- A fila de prompts (`PromptDispatcher`) e a admissão do `SessionPool` (teto de sessões, vaga local, cota, RAM) passam a emitir eventos de início e fim de espera no log, só acima de um limiar configurável; nomes, campos e a chave do limiar (por exemplo, 1 s) **[proposta]**, com modos.
- O projetor do P4 passa a fazer os spans `otheater.wait` desses eventos, como os de `attempt.reset_wait_*`, e o caminho direto do `onWait` sai (ou fica só como modo, se o passo mostrar motivo). Com isso a base recriada reprojeta as esperas (N214) e hooks e plugins as veem.
- Os testes de contagem de eventos (`event-registry.test.ts` e `registries.test.ts`) somam os eventos novos.
- **Aceite:** uma espera acima do limiar gera os dois eventos e o span; abaixo, nada; a base apagada e reprojetada traz o mesmo span.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #253 (b5e4e3d) [S: descrição do PR]. N222 (a): a fila de prompts do Diretor (`PromptDispatcher`) e a admissão do `SessionPool` contam as esperas no log de eventos, só acima de um limiar, e o projetor do P4 faz os spans `otheater.wait` desses eventos, como já fazia com `attempt.reset_wait_*` e `demand.*`. O caminho direto (`onWait`, `WaitRecorder`, `directWaitSpan` e `DaemonSpans.recordWait`) sai. Eventos novos **[proposta]**, `schemaVersion` 1: `wait.started` (a espera chegou ao limiar e continua, ou já era mais velha quando o daemon a viu) e `wait.ended` (só existe se houve o `wait.started`), com `waitId`, `kind` (`prompt_queue` | `pool_admission`), `reasons[]`, `since`, os ids de cenário, peça e tentativa, e `thresholdMs`, `outcome` (`delivered`, `admitted`, `cancelled`, `pool_closed`) e `waitedMs`. Razões: `max_sessions`, `local_slot`, `quota`, `ram`, `ram_unknown` (pool) e `director_busy`, `no_director`, `queued`, `restart` (fila). Chave **[proposta]**: `events.wait_threshold` (`1s`; uma duração, `always` ou `off`; `0` é recusado), que vale mesmo com `telemetry.enabled: off`. Um temporizador (`clock.sleep` abortado pelo fim da espera) mantém o `wait.started` no log enquanto ela dura, para hooks e plugins avisarem o Produtor. Um `wait.started` sem `wait.ended` fecha com o fim da peça (`play_end`), da tentativa (`attempt_end`) ou, só no pool, com o próximo `daemon.started` (`daemon_restart`, valor novo de `otheater.closed_by`).

**Divergências:**
- o plano dizia a razão "sessions"; ficou `max_sessions`, que é o valor que o código já tinha **[V: PR]**;
- `telemetry.daemon_spans.waits` passa de `all | log | off` para `all | off` (o valor `log` é recusado), porque todo span de espera agora vem do log;
- o `onWait` foi removido, e não mantido como modo: com os eventos e o span direto a mesma espera daria dois spans, e o direto não volta quando a base é recriada. O detalhe fino das esperas curtas continua em `events.wait_threshold: always`;
- esperas de prompt, que não têm peça nem tentativa, ficam abertas até a entrega e têm trace próprio.

### Contagens de eventos e versões da porta (2026-11-21)

- **Eventos.** `packages/protocol/src/event-registry.test.ts` e `packages/daemon/src/registries.test.ts` contam os tipos. Na base da fase (392dcad): **126 e 128**. Na main (1b52ae8), com o que já entrou: **130 e 132** [V: lidos no código] (P1 +1, `telemetry.store_reset`; P5 +2, `atif.exported` e `atif.export_failed`; P11 +1, `terminal.output`). Os PRs abertos somam 7: P2 +3 (`telemetry.receiver_started`, `telemetry.batch_rejected`, `telemetry.redacted`), P7 +1 (`telemetry.export_failed`), P8 +1 (`telemetry.purged`) e P15 +2 (`wait.started`, `wait.ended`). **Com tudo junto, 137 e 139** [S: soma das descrições dos PRs; só vale depois dos merges, e cada PR conta a partir de uma base diferente]. Os avisos novos (`daemon.notice`, `recovery.notice`) não são tipos de evento e não entram na conta.
- **Porta `TelemetryStore`:** 0.1.0 (P1), 0.2.0 (P4, cursor e identidade do span), 0.3.0 (P7, `readSince`; P9, os agregados) e 0.4.0 (P8, `footprint` e `compact`).
- **Base de telemetria:** migrações `0001_telemetry` (P1), `0002_span_identity` (P4) e `0003_rollups_daily` (P9).

## Fora desta fase

- **Sistema de plugins, a aba Plugins e a porta `EventSink` para plugins:** Fase 9. O P7 usa só a exportação OTLP e o `/metrics`.
- **Compactar os `session.update` do store em trajetória e expurgar o log de eventos:** depois desta fase, com decisão própria (N216).
- **Protobuf e gRPC no receptor e na exportação:** modos futuros das chaves (a N211 ficou com (a)). O achado do P12 (o Phoenix só ingere OTLP em protobuf) abre a pergunta N229 sobre um modo `http/protobuf` de saída, sem pacote novo.
- **Propagação W3C de trace pelo ACP:** depende dos clientes.
- **Painel de traces gráfico próprio:** o Phoenix e o Grafana cumprem esse papel (§5.11).
- **N206 (1)(4):** continuam com o dono e vão para a Fase 12. A N200 (4) virou o P14.

## Decisões que surgem deste plano

Abertas e decididas em 2026-11-21 ([docs/13](13-DECISOES-EM-ABERTO.md)), pelo dono, por múltipla escolha: **todas ficaram com a opção (a), a recomendada**. As opções ficam registradas abaixo:
- **N211, OTLP e dependências:** (a) código próprio, OTLP/HTTP em JSON na entrada e na saída e o `/metrics` em texto, sem dependência nova; o protobuf e o gRPC ficam como modos futuros (a §5.11 fala no "exportador do OpenTelemetry JS" e em `http/protobuf` **[proposta]**, que mudariam); (b) `protobufjs` 8.8.1 para o protobuf na entrada e na saída, o resto próprio; (c) o OpenTelemetry JS 3.x (`api` 1.10.0, SDK 3.1.x, exportadores 0.301.x), como diz a §5.11, depois de 2026-11-23; (d) o OpenTelemetry JS 2.x (SDK 2.12.0, exportadores 0.223.0).
- **N212, porta do receptor OTLP:** (a) porta própria em loopback, com token por subida, como o servidor MCP; (b) a mesma porta da API, com uma exceção no guard.
- **N213, `experimental.openTelemetry` do OpenCode:** (a) desligado por padrão, numa chave, e a falta de tokens aparece como cobertura parcial; (b) ligado, com a redação do receptor tirando o conteúdo.
- **N214, como nascem os spans do daemon:** (a) projetados do log de eventos, idempotentes e refeitos se a base se perder; (b) instrumentação ao vivo no código da peça.
- **N215, validador do Harbor:** (a) job de CI com o `uv` e a versão fixada (a mais nova com duas semanas), primeiro sem as dependências pesadas, e na máquina só com `OT_TEST_HARBOR=1`; (b) instalação completa do `harbor` na CI; (c) sem Python: só o schema zod e os exemplos da RFC.
- **N216, retenção:** (a) expurgo só na `telemetry.sqlite`, por idade e por tamanho, depois dos agregados, e o giro do `daemon.log`; o store fica como está; (b) também compactar os `session.update` das tentativas terminadas no store; (c) só a telemetria, sem o giro do log.
- **N217, análise do sistema (fecha a N55):** (a) agregados diários na `telemetry.sqlite` guardados por 365 dias, a espera como span (sem evento novo), relatório por rota, comando e painel, e a falta de dados como cobertura parcial; (b) relatório calculado na hora a partir do log, sem agregados; (c) só os agregados, com o relatório depois.
- **N218, métricas do `/metrics`:** (a) a lista do P7, com o prefixo `otheater_` e o perfil pelo nome; (b) só as de cota e de consumo nesta fase.
- **N219, quando o ATIF é gravado:** (a) `on: play_end`, com o `manual` sempre disponível, e o `attempt_end` só para `unit: attempt` ou `play_files`; (b) `on: attempt_end` para todas as unidades, regravando o arquivo da peça a cada tentativa (o **[proposta]** atual da §5.11); (c) só `manual`.

**Abertas durante a fase (2026-11-21), para o dono decidir no fim dela:** as chaves, as rotas e as escolhas que os passos propuseram estão na N224; as perguntas de cada passo, com opções, estão na N225 (P7), N226 (P8), N227 (P9), N228 (P10), N229 (P12) e N230 (P13) ([docs/13](13-DECISOES-EM-ABERTO.md)). Nenhuma foi tomada por este plano. O dono decidiu todas no mesmo dia, iguais à recomendação (2026-11-21); o que pede código (N225 (2) e (3), N230 (2)) vai para a Fase 9.
