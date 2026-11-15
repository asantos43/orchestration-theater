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
| 3 | `codex-acp`, modo A: `CODEX_CONFIG` com `{"otel": ...}` | Nada chegou ao receptor. O adaptador só repassa esse JSON como configuração de sessão; o exportador não foi ligado. Causa exata: não investigada. | [V] (resultado); [N] (causa) |
| 3 | `codex-acp`, modo B: `CODEX_PATH` apontando para um wrapper `sh` que roda `codex -c otel.*=... "$@"` | Funciona: ~9,8 MB, 8 envios de traces, 10 de logs e 1 de métricas para 2 sessões curtas. `service.name=codex-app-server`. `OTEL_RESOURCE_ATTRIBUTES` do ambiente do adaptador chega ao recurso. | [V] |
| 3 | Atributos por sessão no `codex-acp` | Não. O ambiente e o `-c` valem para o processo `codex app-server`, que atende todas as sessões do adaptador. As 2 sessões saíram com o mesmo `run_id`. `conversation.id` dos eventos = `sessionId` do ACP, mas apareceram 4 `conversation.id` para 2 sessões (as outras 2 são threads extras; função não investigada). O daemon precisa de um adaptador por run, ou correlacionar por `conversation.id`. | [V]; [N] (threads extras) |
| 4 | OpenCode (bônus) | `OTEL_EXPORTER_OTLP_ENDPOINT` basta: sai tráfego de logs e traces (sem métricas). `OTEL_RESOURCE_ATTRIBUTES` e `OTEL_SERVICE_NAME` são respeitados: os 3 `otheater.*` estão no recurso de 376/376 registros. São spans internos (SQLite, Config, Git, `Provider.*`, `Session.*`; 110 nomes, ~340 spans) e logs de inicialização; **não vi** span de chamada ao modelo, nem tokens, nem custo, nem prompt. Os logs trazem caminhos com o nome do usuário. Código lido sugere que prompts e saídas de ferramenta não entram nos atributos dos spans. | [V] (medição); [S] (código) |
| 5 | Sobrecarga | Mediana de 3 repetições intercaladas, `-p`/`exec` com "Responda apenas: ok": Claude 9,33 s sem, 9,79 s com (+0,47 s); Codex 3,56 s sem, 3,98 s com (+0,42 s). A variação entre repetições do mesmo modo (até 1,5 s) é maior que a diferença: **não distinguível do ruído**. | [V] |
| 5 | Volume | Claude: ~50-65 KB por run curto em protobuf (~130 KB em JSON). Codex, prompt curto: ~3,0 MB em JSON; no prompt com ferramenta, 3,8 MB em JSON contra 0,73 MB em protobuf (`binary`). `codex-acp`, 2 sessões: 9,8 MB em JSON. | [V] |

## Mapa atributo do cliente → campo do OTheater [proposta]

| Dado | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Correlação (run, step, executor) | recurso `otheater.*` (também em cada ponto/evento) | recurso `otheater.*` (só no recurso) | recurso `otheater.*` |
| Sessão do cliente | `session.id` (= `sessionId` do ACP) | `conversation.id` (= `sessionId` do ACP) | `opencode.run` / `service.instance.id` (por processo) |
| Uso de tokens e custo | métricas `claude_code.token.usage` (`type`), `claude_code.cost.usage`; evento `api_request` (`input_tokens`, `output_tokens`, `cache_*`, `cost_usd`, `duration_ms`, `ttft_ms`, `model`) | evento `codex.sse_event` (`input_token_count`, `output_token_count`, `cached_token_count`, `reasoning_token_count`, `ttft_ms`); sem custo em USD | não medido |
| Chamada de ferramenta | eventos `tool_decision` e `tool_result` (`tool_name`, `success`, `duration_ms`, `tool_use_id`); spans `claude_code.tool*` | eventos `codex.tool_decision` e `codex.tool_result` (`tool_name`, `success`, `duration_ms`, `call_id`) | não medido |
| Pedido ao modelo | span `claude_code.llm_request`; evento `api_request` | `codex.websocket_request`, `codex.api_request`, `codex.turn_ttft` | não vi |
| Modelo e esforço | `model`, `effort` | `model`, `reasoning_effort` | `gen_ai.*` não apareceu |

Correspondência com os campos do docs/11 (`usage.*`, `tool.called`): `cost_usd`, tokens e `duration_ms` viram `usage.*`; `tool_name`, `success` e `duration_ms` viram `tool.called` [proposta].

## Consequências para o OTel do daemon [proposta]

1. **Receptor próprio, um por daemon.** Um OTLP/HTTP em Node (como `src/receiver.ts`) basta; aceitar JSON e protobuf, gzip e as três rotas. Protobuf reduz o volume do Codex a ~1/5 do JSON; preferir `binary` no Codex e `http/protobuf` no Claude [V].
2. **Caminho por run.** Os dois clientes aceitam endpoint com caminho, então o daemon pode usar `http://127.0.0.1:<porta>/<run_id>` e correlacionar mesmo se o atributo de recurso faltar (o cliente acrescenta `/v1/<sinal>` ao caminho; foi o que o receptor viu) [V].
3. **Correlação.** Claude: `OTEL_RESOURCE_ATTRIBUTES` no ambiente do processo, ou por sessão ACP via `_meta.claudeCode.options.env`; um adaptador atende vários runs [V]. Codex: `OTEL_RESOURCE_ATTRIBUTES` + `-c otel.*` por processo; no `codex-acp` isso exige wrapper em `CODEX_PATH`, e como o `app-server` é um processo por adaptador, o daemon precisa de um adaptador por run (ou correlacionar por `conversation.id`) [V]. A chave `otel` em `CODEX_CONFIG` não exportou [V]. Em um `.codex/config.toml` de projeto o Codex ignora `otel` [S].
4. **Formato do valor.** `OTEL_RESOURCE_ATTRIBUTES` é `k=v,k=v`, sem espaços [S]; ids do OTheater não podem ter vírgula, igual ou espaço.
5. **Redação obrigatória no receptor.** Atributos pessoais que chegam sempre: `user.email`, `user.id`, `user.account_uuid`, `user.account_id`, `organization.id`, `host.name` (Codex), caminhos com o nome do usuário (OpenCode, `cwd`). O daemon descarta ou troca por hash antes de gravar [V que chegam; proposta de tratamento].
6. **Conteúdo.** Claude: manter `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` e `OTEL_LOG_RAW_API_BODIES` desligadas (padrão) [V para `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_TOOL_DETAILS` e `OTEL_LOG_TOOL_CONTENT`; as outras: [S]]. Codex: `arguments` e `output` de `codex.tool_result` saem em claro por padrão; o daemon os remove no receptor ou usa `otel.tool_result.max_bytes=0` (remove só `output`) [V]. Nunca ligar `otel.log_user_prompt` nem `otel.log_agent_responses` [V para o primeiro].
7. **Dimensionamento.** Codex: ~1350 registros e 3 MB em JSON para um prompt trivial, a maior parte spans de `fs.*` e `auth`. Filtrar por nome de span/evento na entrada e guardar só eventos `codex.sse_event`, `codex.tool_*`, `codex.api_request`, `codex.turn_ttft` e as métricas `*.duration_ms` de interesse [proposta].
8. **Tempo real.** Com intervalos padrão, as métricas do Claude saem só ao fim de um processo curto. Se o daemon precisa de uso em tempo quase real, fixar `OTEL_METRIC_EXPORT_INTERVAL` (ex.: 5000) e `OTEL_LOGS_EXPORT_INTERVAL`; as métricas do Codex saíram uma vez, no encerramento, em todas as execuções [V].
9. **Temporalidade.** Métricas do Claude vêm em `DELTA` (soma por envio); o daemon soma, não toma o último valor [V no protobuf: `AGGREGATION_TEMPORALITY_DELTA`].
10. **Sobrecarga.** Não distinguível do ruído em runs curtos (< 0,5 s de diferença em 3 repetições) [V]; não medido em runs longos.

## Pendências (não medido)

- Sobrecarga por ACP (Claude e Codex) e em runs longos: só `claude -p` e `codex exec` curtos.
- Causa de `CODEX_CONFIG={"otel":...}` não exportar; investigar o código do `codex-acp` ou do `app-server` [N].
- As 2 threads extras (`conversation.id`) por sessão no `codex-acp` [N].
- OpenCode: nenhum span de chamada ao modelo apareceu no prompt curto; testar com ferramenta e `opencode serve`/ACP em porta própria. Não usei a porta 4096 do dono.
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
node src/run-overhead.ts              # item 5
node src/analyze.ts <tag>...          # resumo de out/<tag> (use -v só em Claude)
node src/group-by-session.ts <tag>... # agrupa por run_id / sessão
```

Variáveis: `OTEL_SPIKE_PORT` (padrão 47301; faixa 47300-47399), `CODEX_MODEL` (padrão `gpt-6-luna`). O repositório git de teste fica em `<scratchpad>/otel/repo`. Saídas em `out/<tag>/` (um arquivo por requisição, `index.jsonl`, `run.json`) e `out/summary-*.json`; contêm e-mail, UUID e nome do host, e são ignoradas pelo git.

## Arquivos

- `src/receiver.ts`, `src/selftest.ts`: receptor OTLP/HTTP e seu teste.
- `src/common.ts`: ambiente limpo, execução de processos, prompts.
- `src/run-claude.ts`, `src/run-claude-acp.ts`, `src/run-codex.ts`, `src/run-codex-acp.ts`, `src/run-opencode.ts`, `src/run-overhead.ts`: cenários.
- `src/analyze.ts`, `src/group-by-session.ts`: análise.
- `src/acp-claude/`, `src/acp-codex/`: cópias ajustadas das bibliotecas ACP dos spikes `acp-claude` e `acp-codex` (saída em `out/*-logs`).
