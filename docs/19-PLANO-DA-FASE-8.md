# 19. Plano da Fase 8

Versão 1, de 2026-11-21. Este é o plano de passos da Fase 8 da [arquitetura](framework-ideas/arquitetura.md), §10, "Fase 8 — Observabilidade", com o desenho da §5.11. A arquitetura continua sendo a referência: este plano só divide a fase em passos, diz o que pode correr em paralelo e dá o aceite de cada passo. Se os dois divergirem, vale a arquitetura, e este documento é corrigido.

A fase começa depois da onda 6 de acertos da Fase 7 (P22 a P27, docs/18, N208). O fechamento da Fase 7 depende do roteiro dos terminais e do login oficial pelo dono (N209), mas isso não segura a Fase 8: os passos desta fase não mexem na TUI até o P10. O plano também leva dois itens que a Fase 7 deixou para cá: o `terminal.output` e a lateral com as peças terminadas (N200, itens 3 e 5). Ele levanta nove decisões novas, N211 a N219 ([docs/13](13-DECISOES-EM-ABERTO.md)), abertas, com a recomendação primeiro; o resumo está em "Decisões que surgem deste plano", no fim. A N55 (a análise do sistema) fecha aqui, pela N217.

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
- **Nenhum download novo sem decisão do dono.** As candidatas desta fase estão em "Dependências novas" e na N211 e na N215.
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

Dados do registro npm e do PyPI, consultados em 2026-11-21 **[S]**. Nenhuma está aprovada: a escolha é a N211 (OTLP) e a N215 (Harbor). A regra é a das fases anteriores: versão publicada há pelo menos duas semanas.

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
| P0 | Plano e decisões (este documento) | nada | nada | por fazer |
| P1 | Base de telemetria: porta, adaptador e chaves (N54) | P0, N211 | P3, P5, P11 | por fazer |
| P2 | Receptor OTLP e redação (N212) | P1 | P4, P6 | por fazer |
| P3 | Clientes e `fake-agent` mandam ao receptor (N213) | P0, N212 | P1, P5, P11 | por fazer |
| P4 | Spans do daemon (N214) | P1 | P2, P6 | por fazer |
| P5 | ATIF: schema zod e exportador (N219) | P0 | P1, P3, P11 | por fazer |
| P6 | Validação pelo `TrajectoryValidator` do Harbor (N215) | P5 | P2, P4 | por fazer |
| P7 | Exportação: OTLP para fora e `/metrics` (N70, N218) | P2, P4 | P9 | por fazer |
| P8 | Retenção e expurgo (N216) | P9 | P10, P12 | por fazer |
| P9 | Análise do sistema (N55, N217) | P4 | P7 | por fazer |
| P10 | Painéis de telemetria na aba Consumo | P2, P9 | P8, P12 | por fazer |
| P11 | `terminal.output` e peças terminadas na lateral (N200, itens 3 e 5) | P0 | P1, P3, P5 | por fazer |
| P12 | Phoenix opcional: receita | P7 | P8, P10 | por fazer |
| P13 | Aceite da fase | todos | nada | por fazer |

Ordem em ondas **[proposta]**:
1. P1, P3, P5 e P11. O P1 abre a base; o P3 mexe só nos três adaptadores dos clientes e no `fake-agent`, e testa contra um receptor falso até o P2 chegar; o P5 mexe só no protocolo e no exportador; o P11 é da Fase 7 e não depende do resto.
2. P2, P4 e P6.
3. P7 e P9.
4. P8, P10 e P12.
5. P13.

Marco interno **[proposta]**: ao fim da onda 2, uma peça contra o `fake-agent` deixa na `telemetry.sqlite` os spans do daemon e os registros OTLP do cliente simulado, com a mesma correlação, e o arquivo ATIF dela passa no validador do Harbor. É o ponto em que o dono pode olhar os dados antes da exportação, da análise e dos painéis.

**Estimativa:** 1 semana, como na §10. Pelo ritmo das Fases 6 e 7, com agentes, fica perto de 3 a 4 dias **[proposta]**. São 14 passos.

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

### P3. Clientes e `fake-agent` mandam ao receptor (N213; §5.11)

- **Claude Code:** no `env` da sessão ACP (`_meta.claudeCode.options.env`), `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, o endpoint, o cabeçalho com o token e o `OTEL_RESOURCE_ATTRIBUTES` com os ids `otheater.*` da tentativa. Os traces do Claude Code ainda são beta: ligados só com `telemetry.clients.claude-code.traces: on` **[proposta]**, padrão `off`.
- **Codex:** a configuração `[otel]` vai por `-c otel.*` no comando do `app-server` (o wrapper em `CODEX_PATH` que o spike validou), nunca no `config.toml` do perfil do dono; o `session/set_title` antes do primeiro prompt, para evitar a thread extra de título [V: Fase 0]. A correlação é por processo e por `conversation.id` (P2).
- **OpenCode:** `OTEL_EXPORTER_OTLP_ENDPOINT`, o cabeçalho e os atributos de recurso. O `experimental.openTelemetry`, que dá tokens e modelo mas manda o prompt em claro, é a N213, padrão `off` na recomendação.
- **Chaves:** `telemetry.clients.<cliente>: on | off` (padrão `on` quando `telemetry.enabled: on`) **[proposta]**. Nada disso toca o `~/.claude`, o `~/.codex` ou o `~/.config/opencode` da pessoa: tudo vai pelo ambiente e pelos argumentos do processo que o daemon lança.
- **`fake-agent`:** com as variáveis `OTEL_*` presentes, manda OTLP/JSON ao endpoint (um span por turno, métricas de tokens, um log por ferramenta), com os atributos de recurso que receber. É o que os testes e o aceite usam no lugar dos clientes reais (N57).
- **Aceite:** testes de cada adaptador conferem o ambiente e os argumentos gerados, sem rodar o cliente; o `fake-agent` manda a um receptor falso do teste, com a correlação certa; com `telemetry.enabled: off`, nenhum cliente recebe variável OTel.

### P4. Spans do daemon (N214; §5.11)

- **Árvore:** peça → etapa → tentativa → sessão → chamada de ferramenta, com as convenções GenAI de agentes: `invoke_agent` na tentativa e na sessão (com `gen_ai.agent.name` = papel, `gen_ai.request.model`, `gen_ai.provider.name`), `execute_tool` na chamada de ferramenta (com `gen_ai.tool.name` e `gen_ai.tool.call.id`) e spans próprios `otheater.play`, `otheater.stage` e `otheater.wait` **[proposta]**. As convenções ainda estão em "Development": os nomes ficam numa tabela só, num arquivo, para mudar num lugar.
- **Como nascem** (N214 (a)) **[proposta]**: um projetor lê o log de eventos com cursor próprio e grava os spans na `telemetry.sqlite`. O span abre num evento (`play.transitioned`, `attempt.started`, `session.started`, `tool.called`) e fecha noutro, com o horário do evento. É idempotente: perder a base de telemetria e reprojetar dá os mesmos spans, com ids derivados dos ids do log.
- **Espera** (item da N55): span `otheater.wait` para a espera na `prompt_queue`, nos semáforos de concorrência e por cota, com o motivo. Sem evento novo no log, para não inflá-lo (N217 (a)).
- **Ligação com os clientes:** o `trace_id` da tentativa vai ao cliente como atributo de recurso (`otheater.trace_id`), e os spans do cliente que chegarem pelo P2 com o atributo ficam filhos da sessão. Sem propagação W3C pelo ACP, que nenhum dos três aceita hoje **[N]**.
- **Aceite:** uma peça contra o `fake-agent` gera a árvore completa, com pais certos e tempos coerentes (relógio falso); reprojetar depois de apagar a base dá os mesmos spans; uma espera por cota simulada aparece como `otheater.wait`.

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

### P6. Validação pelo `TrajectoryValidator` do Harbor (N215)

- `tools/atif-validate/`: um script Python pequeno que chama o `TrajectoryValidator` do Harbor nos arquivos que receber e devolve JSON com os erros.
- **Instalação** (N215 (a)) **[proposta]**: um ambiente do `uv` com a versão fixada do `harbor`, a mais nova com duas semanas que aceite `ATIF-v1.8`, criado só na CI e, na máquina, só com `OT_TEST_HARBOR=1`. O passo tenta primeiro o pacote sem as dependências pesadas (`--no-deps`, mais o `pydantic`), e só cai para a instalação completa se o validador não importar sem elas **[N]**.
- **CI:** um job `atif` no Linux, que roda quando mudam `protocol/src/atif/`, `daemon/src/atif/` ou `tools/atif-validate/`, gera as trajetórias de teste do P5 e as passa no validador.
- **Confirmações** que fecham aqui: a ligação da tentativa ao passo do Diretor (`llm_call_count: 0` e `subagent_trajectory_ref`) e os três modos de `unit`. Se o validador recusar o desenho da §5.11, o passo volta ao dono antes de mudar o formato.
- **Aceite:** o job `atif` verde com as trajetórias das três unidades e dos dois modos de conteúdo; um arquivo quebrado de propósito reprova.

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

### P8. Retenção e expurgo (N216; §5.11)

- **Telemetria:** `telemetry.retention.days` (padrão 30) e `telemetry.retention.max_mb` (padrão 1024) **[proposta]**; o expurgo roda na subida e uma vez por dia, só depois de o P9 guardar os agregados do período, e emite `telemetry.purged` (linhas, bytes, período).
- **Store:** nesta fase, nada sai do store (N216 (a)). O log de eventos é a fonte única do estado e da reconciliação (§5.21), e a compactação dos `session.update` de uma tentativa terminada em trajetória (a frase da §5.11) fica para depois, com a sua própria decisão.
- **`daemon.log`:** gira por tamanho, `log.rotate.max_mb` (padrão 20) e `log.rotate.keep` (padrão 5) **[proposta]**.
- **Aceite:** com o relógio falso, o expurgo apaga só o que passou do prazo e mantém os agregados; o teto de tamanho apaga do mais antigo; o `daemon.log` gira e mantém só as cópias da chave.

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

### P10. Painéis de telemetria na aba Consumo (§5.13)

- Seções novas na aba Consumo, cada uma num componente próprio em `tui/src/tabs/usage/` e com as chaves de texto em `en` e `pt-BR`:
  - **tendência:** tokens, custo real e equivalente em API por dia, a partir do P9;
  - **gargalos:** os maiores tempos por estado e as maiores esperas, com a cobertura dos dados;
  - **peça:** a árvore de spans da peça selecionada (duração por etapa, tentativa e ferramenta), com a seleção da aba Trajetórias;
  - **telemetria:** o estado do receptor, os lotes recusados, o descarte e a exportação.
- **Chaves:** `ui.usage.sections` passa a aceitar as seções novas, e `ui.usage.trendDays` (padrão 14) **[proposta]**.
- **Aceite:** testes com o `ink-testing-library` contra o daemon com o `fake-agent`, em `en` e `pt-BR`, e o orçamento de desempenho da aba (N37) mantido.

### P11. `terminal.output` e peças terminadas na lateral (N200, itens 3 e 5)

- **`terminal.output`:** o daemon passa a emitir o evento com a saída dos terminais da sessão (o ACP `terminal/output`), em blocos com teto e com a mesma redação de segredo dos outros eventos, para a aba Trajetórias e o ATIF mostrarem a saída. Chave `events.terminal_output: on | off | truncated` (padrão `truncated`, 64 KB por terminal) **[proposta]**.
- **Lateral:** as peças terminadas aparecem na lateral sem precisar de `plays: all`, numa seção recolhida "Terminadas", com `ui.sidebar.finishedPlays: collapsed | hidden | expanded` (padrão `collapsed`) **[proposta]**.
- **Aceite:** o `fake-agent` com um terminal gera `terminal.output` e a aba Trajetórias mostra a saída; a lateral mostra a peça terminada na seção recolhida.

### P12. Phoenix opcional: receita (§5.11)

- `docs/reference/phoenix.md`: como apontar o `telemetry.otlp.endpoint` para um Phoenix local e importar um arquivo ATIF, com a licença (ELv2, para uso local) e o aviso de que o OTheater não o instala nem o embute.
- Nenhum download, e nenhum teste roda o Phoenix. O teste do P7 cobre o formato OTLP que o Phoenix recebe.
- **Aceite:** a receita está revisada contra a documentação do Phoenix, marcada como **[S]**, com data.

### P13. Aceite da fase

- **Automático** (`daemon/src/phase8-acceptance.e2e.test.ts`) **[proposta]**: uma peça completa contra o `fake-agent`, com `telemetry.export: both`:
  - a `telemetry.sqlite` tem a árvore de spans do daemon e os registros OTLP do cliente simulado, com a mesma correlação, e sem nenhum dado pessoal;
  - o arquivo ATIF da peça passa no schema zod e, no job `atif`, no `TrajectoryValidator`;
  - o trace chega ao receptor OTLP de teste e o `/metrics` responde;
  - o relatório do P9 tem o dia da peça.
- **Real** (`tools/acceptance/real-acceptance.sh --level phase8`): uma peça com o Claude Code (haiku), com o mesmo roteiro, conferindo que os spans e métricas do cliente chegam com a correlação e que o e-mail não foi gravado. O Codex e o OpenCode entram se a rodada couber na janela do dia, também com `free -h` e `df -h /tmp` antes e com prazo.
- **Aceite:** os dois níveis verdes; o relatório do PR não traz conteúdo de registro real.

## Fora desta fase

- **Sistema de plugins, a aba Plugins e a porta `EventSink` para plugins:** Fase 9. O P7 usa só a exportação OTLP e o `/metrics`.
- **Compactar os `session.update` do store em trajetória e expurgar o log de eventos:** depois desta fase, com decisão própria (N216).
- **Protobuf e gRPC no receptor e na exportação:** modos futuros das chaves, se a N211 ficar com (a).
- **Propagação W3C de trace pelo ACP:** depende dos clientes.
- **Painel de traces gráfico próprio:** o Phoenix e o Grafana cumprem esse papel (§5.11).
- **N200 (4) e N206 (1)(4):** continuam com o dono; a N206 (1)(4) vai para a Fase 12.

## Decisões que surgem deste plano

Abertas em 2026-11-21 ([docs/13](13-DECISOES-EM-ABERTO.md)), para o dono, por múltipla escolha. A recomendação vem primeiro em cada item:
- **N211, OTLP e dependências:** (a) código próprio, OTLP/HTTP em JSON na entrada e na saída e o `/metrics` em texto, sem dependência nova; o protobuf e o gRPC ficam como modos futuros (a §5.11 fala no "exportador do OpenTelemetry JS" e em `http/protobuf` **[proposta]**, que mudariam); (b) `protobufjs` 8.8.1 para o protobuf na entrada e na saída, o resto próprio; (c) o OpenTelemetry JS 3.x (`api` 1.10.0, SDK 3.1.x, exportadores 0.301.x), como diz a §5.11, depois de 2026-11-23; (d) o OpenTelemetry JS 2.x (SDK 2.12.0, exportadores 0.223.0).
- **N212, porta do receptor OTLP:** (a) porta própria em loopback, com token por subida, como o servidor MCP; (b) a mesma porta da API, com uma exceção no guard.
- **N213, `experimental.openTelemetry` do OpenCode:** (a) desligado por padrão, numa chave, e a falta de tokens aparece como cobertura parcial; (b) ligado, com a redação do receptor tirando o conteúdo.
- **N214, como nascem os spans do daemon:** (a) projetados do log de eventos, idempotentes e refeitos se a base se perder; (b) instrumentação ao vivo no código da peça.
- **N215, validador do Harbor:** (a) job de CI com o `uv` e a versão fixada (a mais nova com duas semanas), primeiro sem as dependências pesadas, e na máquina só com `OT_TEST_HARBOR=1`; (b) instalação completa do `harbor` na CI; (c) sem Python: só o schema zod e os exemplos da RFC.
- **N216, retenção:** (a) expurgo só na `telemetry.sqlite`, por idade e por tamanho, depois dos agregados, e o giro do `daemon.log`; o store fica como está; (b) também compactar os `session.update` das tentativas terminadas no store; (c) só a telemetria, sem o giro do log.
- **N217, análise do sistema (fecha a N55):** (a) agregados diários na `telemetry.sqlite` guardados por 365 dias, a espera como span (sem evento novo), relatório por rota, comando e painel, e a falta de dados como cobertura parcial; (b) relatório calculado na hora a partir do log, sem agregados; (c) só os agregados, com o relatório depois.
- **N218, métricas do `/metrics`:** (a) a lista do P7, com o prefixo `otheater_` e o perfil pelo nome; (b) só as de cota e de consumo nesta fase.
- **N219, quando o ATIF é gravado:** (a) `on: play_end`, com o `manual` sempre disponível, e o `attempt_end` só para `unit: attempt` ou `play_files`; (b) `on: attempt_end` para todas as unidades, regravando o arquivo da peça a cada tentativa (o **[proposta]** atual da §5.11); (c) só `manual`.
