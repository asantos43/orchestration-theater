# 08. Referência dos clientes CLI

Tudo abaixo foi **verificado localmente** em 2026-11-08 com `--help`, salvo quando marcado. Versões: **Claude Code 2.1.319** e **codex-cli 0.167.0**. As versões mudam; refaça a verificação antes de implementar.

## Claude Code (`claude`)

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

`--permission-prompts host`: com `--print`, quem responde aos pedidos de permissão é o anfitrião (o SDK ou o `--permission-prompt-tool`); `none` nega automaticamente tudo que perguntaria. Esse é o gancho para o núcleo decidir pela política.

## Codex (`codex`)

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

Observado: o sandbox do Codex impediu `listen` em `127.0.0.1` e `spawnSync` durante os testes do D151 (`listen EPERM`). Isso é motivo de o Runner de B rodar as verificações fora do sandbox do cliente.

## OpenCode (`opencode`)

Não verificado nesta conversa além do uso pelo kit (`opencode --model <modelo>` chamado por `kit run`). Pelas fontes secundárias: aceita login do ChatGPT, não aceita a assinatura do Claude, e funciona com outros provedores por chave ou plano (como a MiniMax, que o kit já usa). Verifique `opencode --help` e `opencode run --help` antes de escrever o adaptador.

## Não verificado (a testar antes de implementar)

- Formato exato dos eventos de `claude -p --output-format stream-json` e de `codex exec --json` (tipos, campos de uso de tokens, id da sessão).
- Se `claude auth status` tem saída em JSON (`--json`).
- Como o `--permission-prompts host` entrega o pedido (esquema) e como se responde.
- O esquema do protocolo do `codex app-server` (`generate-json-schema`) e se ele cobre aprovações por requisição.
- Quanta cota cada chamada "só decisão" consome (a Fase 0 mede isso).
- Suporte dos sandboxes nativos de cada cliente no Windows.
- Duração real do token do `claude setup-token` e do `--with-access-token`.
