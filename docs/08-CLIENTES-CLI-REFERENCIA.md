# 08. Referência dos clientes

O documento tem duas partes:
1. **Como o OTheater usa os clientes**, por ACP. Vem da arquitetura v0.32 (§5.2, §5.6, §5.7 e §5.11), de 2026-11-14. **Não foi verificado localmente**, salvo onde a arquitetura registra verificação: os itens marcados **[a confirmar]** na arquitetura continuam assim, e a Fase 0 mede o resto.
2. **Referência dos CLIs**, **verificada localmente** em 2026-11-08 com `--help`. Versões: **Claude Code 2.1.319** e **codex-cli 0.167.0**. Hoje ela serve para a **saída de emergência** (modo headless) e para o `prepareProfile`. As versões mudam; refaça a verificação antes de implementar.

## Parte 1. Como o OTheater usa os clientes (arquitetura, não verificado localmente)

### Adaptadores ACP

O daemon é cliente ACP (`@agentclientprotocol/sdk` v2). Ele sobe o processo do adaptador e usa:
- `initialize`;
- `session/new`, com `cwd` = worktree e os servidores MCP do framework em HTTP;
- `session/prompt` e `session/update`;
- `session/request_permission` e `session/cancel`;
- `session/load`, quando o adaptador tiver.

| Cliente | Adaptador | O que a arquitetura registra |
|---|---|---|
| Claude Code | `@agentclientprotocol/claude-agent-acp` (Apache-2.0) | Usa o Agent SDK (ver o risco R1 em [07](07-ASSINATURAS-E-TERMOS.md)). Cada sessão sobe um processo `claude`. Anuncia MCP HTTP e `loadSession`. |
| Codex | `@agentclientprotocol/codex-acp` (Apache-2.0, JetBrains) | Inclui `@openai/codex` e conversa com o `codex app-server`. Várias sessões por processo **[a confirmar]**. |
| OpenCode | `opencode acp` (nativo) | Concorrência e config options **[a confirmar]**. Fixar a versão: a API mudou da V1 para a V2. |
| Gemini CLI | `gemini --acp` (nativo, opcional) | Parte do ACP ainda é `unstable`. |

- Modelo, esforço e modo são definidos por `session/set_config_option`, nas categorias `model`, `thought_level`, `mode` e `model_config`. O adaptador anuncia o que aceita.
- O que o ACP não cobre fica na `ClientAdapter`, desde a v0.43 uma classe-base abstrata com um descendente por cliente (**[proposta]**, §5.2): comando, ambiente do perfil, `prepareProfile`, login, logout, sonda de cota, `processModel` e o catálogo de modelos `ModelCatalog` (lista, sugestão de campos e validação dos Executores; §5.7, v0.23).
  - Claude Code e Codex: descoberta automática dos modelos.
  - OpenCode: cadastro assistido a partir do `opencode models --verbose`; o daemon só valida.
- **Saída de emergência:** trocar o adaptador pelo modo headless do cliente (Parte 2) sem mexer no resto:
  - `claude -p --output-format stream-json`;
  - `codex exec --json` ou `@openai/codex-sdk`.

### Isolamento de perfil

| Cliente | Como isolar | Cuidado |
|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` | Uma `ANTHROPIC_API_KEY` no ambiente sempre vence. O daemon remove do ambiente do processo as variáveis que não são do perfil. No Windows, a credencial fica em `<dir>\.credentials.json`. |
| Codex | `CODEX_HOME` + `cli_auth_credentials_store = "file"` | No modo keyring/auto, a entrada do cofre pode ser compartilhada entre perfis **[a confirmar]**. |
| OpenCode | `XDG_DATA_HOME`/`XDG_CONFIG_HOME` + `OPENCODE_DB` | Só há relatos de terceiros. Testar na Fase 0. |

A existência de `CLAUDE_CONFIG_DIR` e `CODEX_HOME` foi **verificada localmente** em 2026-11-08 (Parte 2). O comportamento descrito na coluna "Cuidado" não foi.

### Sondas de cota

| Cliente | Fonte |
|---|---|
| Claude Code | Comando de **statusline** gravado no `settings.json` do perfil. Ele salva `rate_limits.five_hour` e `seven_day` (`used_percentage`, `resets_at`). Complemento: evento `rate_limit_event` do Agent SDK, não documentado **[a confirmar]**. |
| Codex | `codex app-server`: `account/rateLimits/read` e a notificação `account/rateLimits/updated`. Os tipos saem de `codex app-server generate-ts`, cuja existência foi verificada localmente. |
| MiniMax | `GET /v1/token_plan/remains`. O schema não é documentado. |
| OpenCode | Não tem API de cota documentada: contabilidade local + erros de limite. |
| Todos | Erro 429 ou mensagem de limite com o horário do reset. |

O histórico de consumo vem do **ccusage**. Ele não informa a cota restante.

### Telemetria nativa

- **Claude Code:** `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*`.
- **Codex:** tabela `[otel]` no `config.toml` do perfil (`otlp-http`).

Os dois enviam ao receptor OTLP do daemon. Ver [11](11-TELEMETRIA-E-ATIF.md).

### Permissões gravadas pelo `prepareProfile`

Ver [09](09-ISOLAMENTO-E-SEGURANCA.md). Em resumo:
- **Claude:** `tools` sem o Bash nativo, regras `deny`, `--strict-mcp-config` e `allowDangerouslySkipPermissions: false`, todos em `_meta.claudeCode.options` do `session/new`. O Executor headless roda no modo `default`, e o daemon recusa cada `request_permission`: o `dontAsk` não chega pelo ACP (medido na Fase 0, arquitetura v0.42, §5.8).
- **OpenCode V2:** `shell` e `external_directory` negados explicitamente.
- **Codex:** `sandbox_mode` e `approval_policy`.

## Parte 2. Referência dos CLIs (verificado localmente em 2026-11-08)

### Claude Code (`claude`)

| Necessidade | Recurso |
|---|---|
| Uso não interativo | `-p` / `--print` |
| Entrada e saída estruturadas | `--input-format stream-json`, `--output-format stream-json` (só com `--print`) |
| Streaming parcial | `--include-partial-messages` |
| Reemitir mensagens do usuário | `--replay-user-messages` |
| Saída com esquema | `--json-schema <schema>` |
| Sessões | `--session-id <uuid>`, `--resume [id]`, `--fork-session`, `--no-session-persistence` |
| Sessões de fundo | `--bg` / `--background` (devolve um id); `claude attach`, `logs`, `stop`, `rm` operam sobre o id; `claude agents` lista |
| Modelo e esforço | `--model`, `--effort`, `--fallback-model` |
| Ferramentas | `--allowedTools`, `--disallowedTools`, `--tools` |
| Permissões | `--permission-mode`, `--permission-prompts <host\|none>`, `--permission-prompt-tool`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` |
| Prompt de sistema | `--append-system-prompt`, `--agent`, `--agents` |
| MCP | `--mcp-config`, `--strict-mcp-config` |
| Diretórios | `--add-dir` |
| Isolamento do cliente | `--bare` (pula hooks e outros), `--disable-slash-commands` |
| Janela | `--autocompact <auto\|tokens>` |
| Orçamento | `--max-budget-usd` (para uso por API) |
| Controle remoto | `--remote-control [nome]`, `--remote-control-session-name-prefix`, `--teleport`, `--cloud` |
| Autenticação | `claude auth login`, `logout`, `status`; `claude setup-token` (token de longa duração, exige assinatura) |
| Configuração por conta | `CLAUDE_CONFIG_DIR` (diretório de configuração separado) |

`--permission-prompts host`: com `--print`, quem responde aos pedidos de permissão é o anfitrião (o SDK ou o `--permission-prompt-tool`); `none` nega automaticamente tudo que perguntaria. No caminho ACP, os pedidos chegam como `session/request_permission` (camada 2 em [09](09-ISOLAMENTO-E-SEGURANCA.md)); esta flag vale para o modo headless.

### Codex (`codex`)

| Necessidade | Recurso |
|---|---|
| Uso não interativo | `codex exec` (alias `e`) |
| Eventos em JSON Lines | `codex exec --json` |
| Resposta com esquema | `--output-schema <arquivo>`; `-o` grava a resposta final |
| Entrada | prompt como argumento ou pelo stdin (stdin com prompt vira bloco `<stdin>`) |
| Retomar | `codex exec resume <id>` (ou `--last`); `codex resume`, `fork`, `archive`, `delete` |
| Enfileirar mensagem | `codex queue` (numa sessão existente) |
| Modelo e configuração | `-m`, `-c chave=valor` (TOML), `--enable`, `--disable` |
| Sandbox e aprovação | `-s/--sandbox <modo>`, revisão automática das aprovações, `--dangerously-bypass-approvals-and-sandbox` |
| Sem repositório git | `--skip-git-repo-check` |
| Sessão efêmera | `--ephemeral` |
| Servidor | `codex app-server` (experimental): `daemon`, `proxy`, `generate-ts`, `generate-json-schema`; `codex remote-control` (experimental); `codex exec-server` (experimental) |
| Painéis e revisão | `codex agents`, `codex review` |
| Autenticação | `codex login` (assinatura ChatGPT), `--with-api-key`, `--with-access-token`, `codex login status`, `logout` |
| Configuração por conta | `CODEX_HOME` |
| Diagnóstico | `codex doctor` |

Observado: o sandbox do Codex impediu `listen` em `127.0.0.1` e `spawnSync` durante os testes do D151 (`listen EPERM`). Esse é um dos motivos de, no OTheater, testes e build rodarem pelas cascas do daemon (`run_tests`, `install_deps`) e não pelo shell do cliente (arquitetura §5.8).

### OpenCode (`opencode`)

A saída de `opencode models --verbose` foi **verificada localmente** em 2026-11-14, versão 1.19.5, segundo a arquitetura (§5.7): traz, por modelo, `providerID`, `family`, `api.url`, `cost`, `capabilities` e `variants`, e é a base do cadastro assistido dos Executores do OpenCode. O `opencode acp` **não foi verificado**, além do uso do OpenCode pelo kit (`opencode --model <modelo>` chamado por `kit run`).

Pelas fontes secundárias: aceita login do ChatGPT, não aceita a assinatura do Claude, e funciona com outros provedores por chave ou plano (como a MiniMax, que o kit já usa). Por padrão, o OTheater **não usa a assinatura do ChatGPT pelo OpenCode**: com assinatura, cada família só roda pelo seu cliente oficial, e um modelo fora do cliente oficial só entra num perfil de chave de API ou gateway (`executors.cross_client: api_only`, §5.7, v0.23).

O OTheater usa o `opencode acp` nativo, então não há adaptador a escrever. Verifique `opencode acp --help` e a versão antes da Fase 0.

## Não verificado (a testar antes de implementar)

Itens da Fase 0 da arquitetura (§10) que dizem respeito aos clientes:
- Estabilidade e concorrência de cada adaptador ACP; `processModel` de cada um (processo por sessão ou multissessão).
- Se `session/load` funciona em cada adaptador (retomada nativa, §5.16).
- Se `CLAUDE_CONFIG_DIR`, `CODEX_HOME` e XDG isolam de fato logins e credenciais entre perfis.
- Como as flags de permissão do Claude (`tools`, `dontAsk`, `--strict-mcp-config`) chegam pelo `claude-agent-acp`. Medido (item 8 do relatório da Fase 0): chegam por `_meta.claudeCode.options`, menos o `dontAsk`.
- Se a statusline do Claude e o `account/rateLimits/read` do Codex dão a cota de forma confiável; se o `rate_limit_event` é repassado.
- O que o `codex-acp` repassa do `app-server` (cotas, aprovações).
- Sandbox no Windows: `sandbox-runtime` em alpha, MXC do Codex, plano B por usuário de baixo privilégio.

Itens anteriores (2026-11-08), ainda válidos para o modo headless:
- Formato exato dos eventos de `claude -p --output-format stream-json` e de `codex exec --json` (tipos, campos de uso de tokens, id da sessão).
- Se `claude auth status` tem saída em JSON (`--json`).
- Como o `--permission-prompts host` entrega o pedido (esquema) e como se responde.
- Duração real do token do `claude setup-token` e do `--with-access-token`. A arquitetura não usa esses tokens.
