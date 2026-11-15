# spikes/otel

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10, item "OTel"; contexto em [docs/11](../../docs/11-TELEMETRIA-E-ATIF.md)). Pergunta: o Claude Code, o Codex e o OpenCode exportam OpenTelemetry para um receptor local, com os atributos de correlação do OTheater (`otheater.run_id`, `otheater.step_id`, `otheater.executor_id`)? O que chega, o que vaza e o que o daemon precisa redigir?

Marcas usadas em todo o documento:

- **[V]** = verificado localmente, por execução nesta máquina em 2026-11-15 (UTC-3), com a saída em `out/` (ignorado pelo git).
- **[S]** = fonte secundária (documentação ou código lido, não executado).
- **[N]** = não confirmado ou hipótese.

Os termos de uso dos provedores não foram consultados. Nada aqui afirma o que o provedor permite. Valores pessoais (e-mail, UUID da conta, nome do host, caminhos com o nome do usuário) ficam só em `out/`; este README os omite ou mascara (`<host>`).

## O que foi medido, onde e com quê

| | |
|---|---|
| Data | 2026-11-15 (UTC-3) |
| Máquina | AMD Cezanne (integrada), 12 threads, 30 GB de RAM |
| Sistema | Fedora Linux 45, kernel 7.3.3-300.fc45.x86_64 |
| Node | v24.18.0 (TypeScript rodado direto; `tsc --noEmit` passa) |
| Claude Code | 2.1.325, modelo `haiku`, esforço `low` |
| `claude-agent-acp` | 0.107.0 |
| Codex | `codex-cli` 0.169.0 (PATH) nos testes diretos; 0.166.0 (empacotado) por trás do `codex-acp` 2.6.0; modelo `gpt-6-luna`, esforço `low` |
| OpenCode | 1.19.5, `google/gemini-3.1-flash-lite` |
| Receptor | Node, `src/receiver.ts`: OTLP/HTTP `/v1/{metrics,logs,traces}`, JSON e protobuf, gzip/deflate. Sem contêiner e sem otelcol. Decodifica protobuf com `@opentelemetry/otlp-transformer` 0.57.2 (Apache-2.0) e `protobufjs` 7.5.4 (BSD-3-Clause) |
| Contas | logins já existentes dos clientes; nenhum login novo; nenhum arquivo de credencial foi lido |

Ambiente dos filhos: `cleanEnv()` (`src/common.ts`) passa só PATH, HOME, USER etc.; nenhuma variável `CLAUDE_*`, `ANTHROPIC_*` ou `OTEL_*` da sessão que lançou o spike vaza para os testes.

Documentação consultada em 2026-11-15:

- Claude Code: <https://code.claude.com/docs/en/monitoring-usage> [S].
- Codex: <https://learn.chatgpt.com/docs/config-file/config-advanced> e `.../config-reference` (o endereço `developers.openai.com` redireciona para lá) [S].
- OpenCode: código-fonte em <https://github.com/anomalyco/opencode> (`packages/cli/src/index.ts`, via Context7) [S].

## Resultado por item

| # | Item | Resultado | Marca |
|---|---|---|---|
| 1 | `claude -p`, `http/json` e `http/protobuf` | Os dois protocolos funcionam. Métricas, eventos (logs) e traces chegam. `OTEL_RESOURCE_ATTRIBUTES` com os 3 atributos `otheater.*` aparece no recurso de 100% dos registros (63/63, 62/62, 68/68 nas execuções) e, por padrão, também em cada ponto de métrica e em cada evento. | [V] |
| 1 | Intervalos | Padrão (métricas 60 s, logs 5 s, traces 5 s): num `-p` curto os logs saem a ~5 s e métricas e traces só saem na saída do processo (~7,5 s). Nada se perde, mas "tempo real" exige intervalos curtos (`OTEL_*_EXPORT_INTERVAL`). Usei 1-2 s para observar vários envios. | [V] |
| 1 | Vazamento padrão | Prompt, `prompt_text` e `response` chegam como `[REDACTED]`. Chegam sempre: `user.email`, `user.id`, `user.account_uuid`, `user.account_id`, `organization.id`, `session.id`. Conteúdo do arquivo lido não aparece. | [V] |
| 1 | Com `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` | O prompt, a resposta, `tool_input`, `file_path` e o conteúdo da ferramenta aparecem em claro (o valor do arquivo de teste foi achado em 3 arquivos de `out/claude-leak`). Manter desligadas. | [V] |
| 1 | `OTEL_METRICS_INCLUDE_RESOURCE_ATTRIBUTES=false` | Os `otheater.*` somem dos pontos de métrica, mas continuam no recurso. `..._SESSION_ID=false` e `..._ACCOUNT_UUID=false` removem esses atributos das métricas. `user.email` e `organization.id` continuam. | [V] |
| 2 | `claude-agent-acp` com as variáveis | As variáveis do adaptador chegam ao `claude` filho (sessão que não declara nada herda `run-ADAPTER`). | [V] |
| 2 | Atributos por sessão | Funciona: `session/new` com `_meta.claudeCode.options.env` = `{OTEL_RESOURCE_ATTRIBUTES, OTEL_EXPORTER_OTLP_ENDPOINT}` troca a correlação (e até o endpoint) por sessão, no mesmo adaptador. Três sessões, três `run_id`; `session.id` do evento = `sessionId` do ACP. Não é preciso um adaptador por run. | [V] |
| 3 | `codex exec`, `-c otel.*` | `otel.exporter`, `otel.trace_exporter` e `otel.metrics_exporter` com `otlp-http`, `protocol = "json"` ou `"binary"`, `otel.environment`, sem tocar em `~/.codex/config.toml`. Chegam logs (eventos `codex.*`), traces (175 nomes de span, centenas de spans) e métricas (70 nomes, `codex.*`, 1 envio, na saída). | [V] |
| 3 | Correlação no Codex | `OTEL_RESOURCE_ATTRIBUTES` funciona nos 3 sinais (1348/1348 registros). A documentação não cita essa variável; foi medido. `otel.span_attributes` cobre só traces/spans e os põe no registro, não no recurso: eventos `codex.*` ficaram sem correlação (1778/2046 com). | [V] |
| 3 | Vazamento padrão no Codex | `codex.user_prompt.prompt` vem `[REDACTED]`. Mas `codex.tool_result` exporta `arguments` e `output` em claro por padrão (o conteúdo do arquivo lido apareceu). Sempre chegam `user.email` e `user.account_id`; o recurso traz `host.name`. `otel.tool_result.max_bytes=0` removeu o conteúdo de `output`; `arguments` continuou. `otel.log_user_prompt=true` mostra o prompt. | [V] |
| 3 | `codex-acp`, modo A: `CODEX_CONFIG` com `{"otel": ...}` | Nada chegou ao receptor (4 sessões em 2 execuções, 0 requisições). Causa em "Segunda rodada", item A. | [V] (resultado); causa [V] no `app-server`, [S] no código do adaptador |
| 3 | `codex-acp`, modo B: `CODEX_PATH` apontando para um wrapper `sh` que roda `codex -c otel.*=... "$@"` | Funciona: ~9,8 MB, 8 envios de traces, 10 de logs e 1 de métricas para 2 sessões curtas. `service.name=codex-app-server`. `OTEL_RESOURCE_ATTRIBUTES` do ambiente do adaptador chega ao recurso. | [V] |
| 3 | Atributos por sessão no `codex-acp` | Não. O ambiente e o `-c` valem para o processo `codex app-server`, que atende todas as sessões do adaptador. As 2 sessões saíram com o mesmo `run_id`. `conversation.id` dos eventos = `sessionId` do ACP, mas apareceram 4 `conversation.id` para 2 sessões, isto é, **1 thread extra por sessão** (não 2; função em "Segunda rodada", item B). O daemon precisa de um adaptador por run, ou correlacionar por `conversation.id`. | [V] |
| 4 | OpenCode (bônus), `opencode run` | `OTEL_EXPORTER_OTLP_ENDPOINT` basta: sai tráfego de logs e traces (sem métricas). `OTEL_RESOURCE_ATTRIBUTES` e `OTEL_SERVICE_NAME` são respeitados: os 3 `otheater.*` estão no recurso de 376/376 registros. São spans internos (SQLite, Config, Git, `Provider.*`, `Session.*`; 110 nomes, ~340 spans) e logs de inicialização; no prompt curto **não vi** span de chamada ao modelo, nem tokens, nem custo, nem prompt. Os logs trazem caminhos com o nome do usuário. | [V] |
| 4 | OpenCode com ferramenta, `opencode acp` | Ver "Segunda rodada", item C: sem a chave `experimental.openTelemetry` não há span de chamada ao modelo (nem tokens); com ela há, e **o prompt, a resposta, os argumentos e o resultado da ferramenta saem em claro**. A suposição anterior, de que prompts e saídas de ferramenta não entravam nos spans, estava errada para esse modo. | [V] |
| 5 | Sobrecarga | Mediana de 3 repetições intercaladas, `-p`/`exec` com "Responda apenas: ok": Claude 9,33 s sem, 9,79 s com (+0,47 s); Codex 3,56 s sem, 3,98 s com (+0,42 s). A variação entre repetições do mesmo modo (até 1,5 s) é maior que a diferença: **não distinguível do ruído**. | [V] |
| 5 | Volume | Claude: ~50-65 KB por run curto em protobuf (~130 KB em JSON). Codex, prompt curto: ~3,0 MB em JSON; no prompt com ferramenta, 3,8 MB em JSON contra 0,73 MB em protobuf (`binary`). `codex-acp`, 2 sessões: 9,8 MB em JSON. | [V] |

## Mapa atributo do cliente → campo do OTheater [proposta]

| Dado | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Correlação (run, step, executor) | recurso `otheater.*` (também em cada ponto/evento) | recurso `otheater.*` (só no recurso) | recurso `otheater.*` |
| Sessão do cliente | `session.id` (= `sessionId` do ACP) | `conversation.id` (= `sessionId` do ACP) | `opencode.run` / `service.instance.id` (por processo) |
| Uso de tokens e custo | métricas `claude_code.token.usage` (`type`), `claude_code.cost.usage`; evento `api_request` (`input_tokens`, `output_tokens`, `cache_*`, `cost_usd`, `duration_ms`, `ttft_ms`, `model`) | evento `codex.sse_event` (`input_token_count`, `output_token_count`, `cached_token_count`, `reasoning_token_count`, `ttft_ms`); sem custo em USD | só com `experimental.openTelemetry`: span `ai.streamText[.doStream]` com `ai.usage.inputTokens`, `...outputTokens`, `...cachedInputTokens`, `gen_ai.usage.*`; sem custo em USD |
| Chamada de ferramenta | eventos `tool_decision` e `tool_result` (`tool_name`, `success`, `duration_ms`, `tool_use_id`); spans `claude_code.tool*` | eventos `codex.tool_decision` e `codex.tool_result` (`tool_name`, `success`, `duration_ms`, `call_id`) | só com a chave: span `ai.toolCall` (`ai.toolCall.args`, `ai.toolCall.result`, em claro); sempre: spans `SessionProcessor.*ToolCall` sem atributos |
| Pedido ao modelo | span `claude_code.llm_request`; evento `api_request` | `codex.websocket_request`, `codex.api_request`, `codex.turn_ttft` | sempre: `LLM.run`, `LLMRequestPrep.prepare` (sem atributos); só com a chave: `ai.streamText`, `ai.streamText.doStream` |
| Modelo e esforço | `model`, `effort` | `model`, `reasoning_effort` | só com a chave: `ai.model.id`, `ai.model.provider`, `gen_ai.request.model`, `gen_ai.response.model` |

Correspondência com os campos do docs/11 (`usage.*`, `tool.called`): `cost_usd`, tokens e `duration_ms` viram `usage.*`; `tool_name`, `success` e `duration_ms` viram `tool.called` [proposta].

## Consequências para o OTel do daemon [proposta]

1. **Receptor próprio, um por daemon.** Um OTLP/HTTP em Node (como `src/receiver.ts`) basta; aceitar JSON e protobuf, gzip e as três rotas. Protobuf reduz o volume do Codex a ~1/5 do JSON; preferir `binary` no Codex e `http/protobuf` no Claude [V].
2. **Caminho por run.** Os dois clientes aceitam endpoint com caminho, então o daemon pode usar `http://127.0.0.1:<porta>/<run_id>` e correlacionar mesmo se o atributo de recurso faltar (o cliente acrescenta `/v1/<sinal>` ao caminho; foi o que o receptor viu) [V].
3. **Correlação.** Claude: `OTEL_RESOURCE_ATTRIBUTES` no ambiente do processo, ou por sessão ACP via `_meta.claudeCode.options.env`; um adaptador atende vários runs [V]. Codex: `OTEL_RESOURCE_ATTRIBUTES` + `-c otel.*` por processo; no `codex-acp` isso exige wrapper em `CODEX_PATH`, e como o `app-server` é um processo por adaptador, o daemon precisa de um adaptador por run (ou correlacionar por `conversation.id`) [V]. A chave `otel` em `CODEX_CONFIG` não exporta porque o `app-server` só monta o exportador na partida (`-c` ou `config.toml`) [V]. Em um `.codex/config.toml` de projeto o Codex ignora `otel` [S].
4. **Formato do valor.** `OTEL_RESOURCE_ATTRIBUTES` é `k=v,k=v`, sem espaços [S]; ids do OTheater não podem ter vírgula, igual ou espaço.
5. **Redação obrigatória no receptor.** Atributos pessoais que chegam sempre: `user.email`, `user.id`, `user.account_uuid`, `user.account_id`, `organization.id`, `host.name` (Codex), caminhos com o nome do usuário (OpenCode, `cwd`). O daemon descarta ou troca por hash antes de gravar [V que chegam; proposta de tratamento].
6. **Conteúdo.** Claude: manter `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` e `OTEL_LOG_RAW_API_BODIES` desligadas (padrão) [V para `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS` e `OTEL_LOG_TOOL_CONTENT`; as outras: [S]]. Codex: `arguments` e `output` de `codex.tool_result` saem em claro por padrão; o daemon os remove no receptor ou usa `otel.tool_result.max_bytes=0` (remove só `output`) [V]. Nunca ligar `otel.log_user_prompt` nem `otel.log_agent_responses` [V para o primeiro].
7. **Dimensionamento.** Codex: ~1350 registros e 3 MB em JSON para um prompt trivial, a maior parte spans de `fs.*` e `auth`. Filtrar por nome de span/evento na entrada e guardar só eventos `codex.sse_event`, `codex.tool_*`, `codex.api_request`, `codex.turn_ttft` e as métricas `*.duration_ms` de interesse [proposta].
8. **Tempo real.** Com intervalos padrão, as métricas do Claude saem só ao fim de um processo curto. Se o daemon precisa de uso em tempo quase real, fixar `OTEL_METRIC_EXPORT_INTERVAL` (ex.: 5000) e `OTEL_LOGS_EXPORT_INTERVAL`; as métricas do Codex saíram uma vez, no encerramento, em todas as execuções [V].
9. **Temporalidade.** Métricas do Claude vêm em `DELTA` (soma por envio); o daemon soma, não toma o último valor [V no protobuf: `AGGREGATION_TEMPORALITY_DELTA`].
10. **OpenCode.** Sem `experimental.openTelemetry` não há tokens nem modelo por chamada; com a chave há, mas saem prompt, resposta e resultado de ferramenta em claro: só ligar com redação de `ai.prompt*`, `ai.response.*`, `ai.toolCall.*` no receptor [V, n=2].
11. **Threads extras do Codex.** Sessão sem título explícito gera 1 thread de título (560 caracteres, `read-only`) por sessão; descartá-la na contagem por sessão ou definir o título com `session/set_title` [V, n=3 por braço].
12. **Sobrecarga.** Não distinguível do ruído em runs curtos (< 0,5 s de diferença em 3 repetições) [V]; não medido em runs longos.

## Segunda rodada (2026-11-15): as três pendências do Codex e do OpenCode

Cada afirmação traz a marca e o n. Dados em `out/cdx-as-*`, `out/codex-acp-threads*`, `out/oc-acp-*` (ignorados pelo git).

### A. Por que `CODEX_CONFIG={"otel":...}` não exporta (`src/run-codex-appserver-otel.ts`)

Teste direto no `codex app-server` 0.166.0 (o processo que o `codex-acp` sobe), sem adaptador, sem chamada ao modelo e com `CODEX_HOME` vazio e temporário (sem `auth.json`; nada foi copiado). Cada variante é um processo novo, com `initialize`, `initialized` e 2 `thread/start`.

| Variante | Onde o `otel` entra | Requisições / registros |
|---|---|---|
| `none` | em lugar nenhum (controle) | 0 / 0 |
| `thread` | no campo `config` do `thread/start` (o que o `CODEX_CONFIG` do adaptador faz) | 0 / 0 |
| `env` | `OTEL_EXPORTER_OTLP_*` no ambiente | 0 / 0 |
| `toml` | `[otel]` em `$CODEX_HOME/config.toml` | 5 / 452 (logs, traces, métricas), 452/452 com `otheater.run_id` |
| `cli` | `-c otel.*` na linha de comando do `app-server` | 5 / 452, 452/452 com `otheater.run_id` |

- **[V]** (n=4 para `none`, `thread`, `toml`, `cli`; n=2 para `env`; mesmo resultado em todas): o exportador do Codex é montado na partida do processo, a partir de `config.toml` ou de `-c`. O `otel` dentro do `config` de um `thread/start` é aceito e ignorado, sem erro. O `app-server` encerra com código 0 ao fechar o stdin e esvazia os exportadores.
- **[V]** (n=4 sessões em 2 execuções, 0 requisições): pelo adaptador, o modo A não exporta nada.
- **[S]** (leitura de `node_modules/@agentclientprotocol/codex-acp/dist/index.js`, não executada à parte): o adaptador só converte as chaves `hooks` e `model_provider(s)` de `CODEX_CONFIG` em argumentos `-c` de partida; o resto vai para o `config` por thread do `thread/start`. Isso explica a variante `thread`.
- **Forma correta:** `-c otel.*` (o wrapper em `CODEX_PATH`, modo B, já medido) ou `config.toml` no `CODEX_HOME` do processo. **[V]** que as duas formas funcionam no `app-server` direto; **[N]** o fluxo completo `codex-acp` + `config.toml` com chamada ao modelo, porque exigiria um `CODEX_HOME` com `auth.json`, e copiar credencial é proibido neste spike. O modo B mantém a recomendação.

### B. A thread `conversation.id` extra por sessão (`src/run-codex-acp-threads.ts`)

Modo B, 6 sessões (3 pares), prompt "Responda apenas: ok". Em cada par, a 1a sessão é normal e a 2a chama `session/set_title` antes do 1o prompt.

| Sessão | `conversation.id` extra nos logs | `prompt_length` / modelo / sandbox da extra |
|---|---|---|
| normal (n=3) | 1 por sessão (3 de 3) | 560 / `gpt-5.6-luna` / `read-only` |
| com `session/set_title` antes do 1o prompt (n=3) | 0 (0 de 3) | |

- **[V]** (n=6 sessões, 3 por braço): a thread extra existe só quando a sessão não tem título explícito. Cada thread extra tem 2 eventos `codex.sse_event` (uma chamada ao modelo), 560 caracteres de prompt (as sessões normais têm 19), outro modelo (`gpt-5.6-luna`, não o `gpt-6-luna` pedido) e sandbox `read-only`.
- **[V]**: as sessões normais recebem 2 `session_info_update` com título (o 1o é o próprio prompt; o 2o é um título gerado, ex.: "Confirmar resposta ok"); as com título explícito recebem só o explícito.
- **[S]** (código do `codex-acp` 2.6.0, classe `TitleGenerator`): a extra é uma thread `ephemeral` aberta depois do 1o turno só para gerar o título da sessão. Os dados medidos coincidem com isso; a leitura do código não foi repetida em execução à parte.
- Consequência: cada sessão sem título explícito custa uma chamada extra ao modelo, que aparece nos tokens e nos logs com `conversation.id` que não é um `sessionId` do ACP. Contas por sessão devem descartar ou atribuir essas threads (prompt de 560 caracteres, `read-only`). Com título explícito (`session/set_title`) a chamada extra não ocorre. **[N]** se existe opção do adaptador para desligar a geração sem definir título.

### C. OpenCode: span de chamada ao modelo com ferramenta (`src/run-opencode-acp.ts`)

`opencode acp --port 47530` (processo meu, encerrado ao fim; nenhuma conexão à porta 4096 do dono: `ss -tnp` não mostrou conexão para ela depois da execução, e o processo dela não foi tocado), modelo escolhido por `session/set_config_option`, prompt "Leia o arquivo hello.txt (use a ferramenta Read) e responda so com o conteudo.", `permission=allow`, 2 sessões por cenário (n=2). `off` = só as variáveis `OTEL_*`; `on` = mais `OPENCODE_CONFIG_CONTENT={"experimental":{"openTelemetry":true}}` (configuração por ambiente; `~/.config/opencode` não foi lido nem alterado).

| | off | on |
|---|---|---|
| Resposta | `azul-7391` (correto), ferramenta `read` concluída, 2 de 2 | igual |
| Requisições / registros (todos com `otheater.run_id` no recurso) | 15 / 1723 (10 de logs, 5 de traces) | 15 / 1739 |
| Spans `ai.streamText`, `ai.streamText.doStream`, `ai.toolCall` | 0 | 5, 9, 2 |
| Spans `LLM.run`, `LLMRequestPrep.prepare` (sem atributos) | 6, 6 | 6, 6 |
| Tokens, modelo, `finishReason` | não | sim (`ai.usage.*`, `gen_ai.usage.*`, `ai.model.id`, `gen_ai.response.model`, `finish_reasons`) |
| Conteúdo do arquivo lido (`azul-7391`) em claro | 0 arquivos de 15 | 2 arquivos de 15 |

- **[V]** (n=2 por cenário): sem a chave, **não há** span de chamada ao modelo nem tokens, mesmo com ferramenta; só os spans internos do OpenCode. Com a chave, há span do AI SDK por chamada, com tokens de entrada, saída e cache e com o modelo.
- **[V]** (n=2): com a chave, saem em claro: `ai.prompt` (~33 mil caracteres, com o prompt de sistema), `ai.prompt.messages`, `ai.response.text`, `ai.response.toolCalls`, `ai.toolCall.args` e `ai.toolCall.result` (o conteúdo do arquivo). Também saem `session.id`, `ai.telemetry.metadata.userId` e os cabeçalhos `x-opencode-session-id`. Ligar a chave exige redação no receptor.
- **[V]** (n=2): há `doStream` com um segundo modelo (`gemini-3.8-flash`, o "small model" do OpenCode, em `Provider.getSmallModel`), que não é o pedido; provavelmente é a geração de título, **[N]** a causa.
- **[V]**: os spans `SessionProcessor.*ToolCall` e `LLM.run` existem sempre e não têm atributos; não servem para tokens nem custo.
- **[N]** custo em USD (não apareceu em nenhum atributo), `opencode serve` (só `opencode acp` foi medido) e se a chave `experimental.openTelemetry` é uma interface estável.
- Duração por prompt (informativa, n=2, sem valor estatístico): `off` 2,6 s e 2,1 s; `on` 2,7 s e 2,6 s.

## Pendências (não medido)

Resolvidas nesta rodada: causa do modo A (item A), thread extra por sessão (item B) e span de chamada ao modelo do OpenCode com ferramenta (item C).

- Sobrecarga por ACP (Claude, Codex, OpenCode) e em runs longos: só `claude -p` e `codex exec` curtos, mais as durações de 2 prompts por cenário no OpenCode [N]. Não medida por falta de n; sem amostra suficiente para separar do ruído.
- Fluxo completo `codex-acp` com `config.toml` em `CODEX_HOME` e chamada ao modelo [N] (exigiria `auth.json` no `CODEX_HOME`).
- Opção do `codex-acp` para desligar a geração de título sem definir título [N].
- Origem do segundo modelo no OpenCode (`gemini-3.8-flash`) [N] e custo em USD no OpenCode [N].
- Cardinalidade de métricas em muitas sessões simultâneas e retenção no receptor.
- Mapeamento exato para o esquema ATIF do docs/11 (este spike só propõe).
- Variáveis adicionais do Claude (`OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_RAW_API_BODIES`) e `otel.log_agent_responses` do Codex: lidas na documentação, não exercitadas.

## Como rodar

```bash
cd spikes/otel
npm install --ignore-scripts          # ~940 MB: traz os binários nativos do claude e do codex
npm run typecheck
node src/selftest.ts                  # receptor: 6 envios (JSON/protobuf x 3 rotas), porta 47390
node src/run-claude.ts                # item 1: claude-json, claude-proto, claude-defint, claude-leak, claude-min
node src/run-claude-acp.ts            # item 2
node src/run-codex.ts                 # item 3: codex-json, codex-bin, codex-spanattr, codex-leak, codex-max0
node src/run-codex-acp.ts A B         # item 3 via ACP (A: CODEX_CONFIG; B: wrapper)
node src/run-opencode.ts              # item 4
node src/run-codex-appserver-otel.ts  # 2a rodada A: otel no app-server (none thread toml cli env), sem credencial
node src/run-codex-acp-threads.ts 3   # 2a rodada B: thread extra por sessao (3 pares, 6 prompts)
node src/run-opencode-acp.ts 2        # 2a rodada C: opencode acp, com e sem experimental.openTelemetry (porta 47530)
node src/run-overhead.ts              # item 5
node src/analyze.ts <tag>...          # resumo de out/<tag> (use -v só em Claude)
node src/group-by-session.ts <tag>... # agrupa por run_id / sessão
```

Variáveis: `OTEL_SPIKE_PORT` (padrão 47301; faixa 47300-47399; o `opencode acp` usa 47530), `OC_MODEL` (padrão `google/gemini-3.1-flash-lite`), `CODEX_MODEL` (padrão `gpt-6-luna`). O repositório git de teste fica em `<scratchpad>/otel/repo`. Saídas em `out/<tag>/` (um arquivo por requisição, `index.jsonl`, `run.json`) e `out/summary-*.json`; contêm e-mail, UUID e nome do host, e são ignoradas pelo git.

## Arquivos

- `src/receiver.ts`, `src/selftest.ts`: receptor OTLP/HTTP e seu teste.
- `src/common.ts`: ambiente limpo, execução de processos, prompts.
- `src/run-claude.ts`, `src/run-claude-acp.ts`, `src/run-codex.ts`, `src/run-codex-acp.ts`, `src/run-opencode.ts`, `src/run-overhead.ts`: cenários.
- `src/run-codex-appserver-otel.ts`, `src/run-codex-acp-threads.ts`, `src/run-opencode-acp.ts`: cenários da segunda rodada (`src/acp-codex/lib.ts` ganhou `command`/`commandArgs`/`cwd` para subir outro agente ACP).
- `src/analyze.ts`, `src/group-by-session.ts`: análise.
- `src/acp-claude/`, `src/acp-codex/`: cópias ajustadas das bibliotecas ACP dos spikes `acp-claude` e `acp-codex` (saída em `out/*-logs`).
