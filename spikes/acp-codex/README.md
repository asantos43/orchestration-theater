# spikes/acp-codex

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10): um cliente ACP mínimo em TypeScript que sobe `@agentclientprotocol/codex-acp` como subprocesso, registra em JSONL cada mensagem trocada e mede 9 itens. Código descartável; nada daqui segue para a Fase 1.

Marcas usadas em todo o documento:

- **[verificado]** = verificado localmente, por execução nesta máquina em 2026-11-14 (UTC-3), com a saída em `out/`.
- **[secundária]** = vem de fonte secundária (leitura do código do adaptador instalado, não de documentação oficial).
- **[não confirmado]** = hipótese ou causa não testada.

Os termos de uso dos provedores não foram consultados neste spike. Nada aqui afirma o que o provedor permite.

## O que foi medido, onde e com quê

| | |
|---|---|
| Data e hora | 2026-11-14, execuções entre 22:37 e 22:45 (UTC-3) |
| Máquina | AMD Eng Sample 100-000000296-40, 12 threads, 30 GB de RAM |
| Sistema | Fedora Linux 45, kernel 7.3.3-300.fc45.x86_64 |
| Node / npm | v24.18.0 / 11.16.0 (TypeScript rodado direto, sem build; `tsc --noEmit` passa) |
| `@agentclientprotocol/sdk` | 2.7.0 (API v1: `client()`, `connect()`, `ndJsonStream`, `methods`) |
| `@agentclientprotocol/codex-acp` | 2.6.0 |
| `@openai/codex` (empacotado, usado em tudo) | 0.166.0 |
| `codex` do PATH (não usado nos testes) | codex-cli 0.169.0 |
| `@modelcontextprotocol/sdk` / `zod` | 1.32.2 / 4.6.7 |
| Conta | assinatura ChatGPT do dono (login já existente em `~/.codex`; nenhum login novo; `auth.json` nunca foi lido) |
| Modelo dos testes | `gpt-6-luna`, esforço `low`, modo `workspace-write` (o mais barato da lista, pelo nome; preço relativo [não confirmado]) |

A worktree git, as três worktrees da concorrência e a pasta do sandbox ficaram na scratchpad da sessão (`<scratchpad>/acp-codex/`), fora do repositório.

## Prompts e tokens

- Envios `session/prompt` no total: **21** (limite do dono: 25). Conferido contando as mensagens no JSONL de cada execução.
  - 18 prompts de modelo, todos triviais, só dentro de worktrees de teste.
  - 3 envios de `/status`, que o adaptador resolve localmente, sem chamar o modelo [verificado: `token_count: null` na resposta].
- O `out/prompts-count.jsonl` tem 22 linhas porque o `s4-resume.ts` registrou o follow-up do item 6A duas vezes; foi um erro de contagem do log, não um envio a mais.
- Tokens: um prompt trivial custou ~52 mil tokens no total (6,2 mil de entrada, 45,7 mil de entrada em cache, ~100 de saída) [verificado]. Isso é o contexto-base do Codex, não o prompt. Somatório total não calculado; por estimativa, 18 prompts × ~52 mil ≈ 0,9 milhão de tokens, quase tudo em cache [não confirmado].
- Dois follow-ups do item 6 (depois do `session/load`) rodaram em `gpt-6.1-sol` esforço `high` por engano: o `session/load` devolve os config options ao padrão e o script não chamou `set_config_option` antes. Foram 2 prompts mais caros que os demais.
- Cota depois de tudo, lida direto no `codex app-server` (item 8): janela de 5 h com 1% usado, janela semanal com 0% [verificado].

## Resultado por item

| # | Item | Resultado medido |
|---|------|------------------|
| 1 | `initialize` | **[verificado]** 630 ms. `agentInfo` = `@agentclientprotocol/codex-acp` 2.6.0, protocolo v1. `loadSession: true`; `sessionCapabilities`: `resume`, `list`, `close`, `delete`, `fork`, `title`, `additionalDirectories`, `subagents`, `systemPrompt`. `promptCapabilities`: imagem e `embeddedContext`. `mcpCapabilities`: `http: true`, `sse: false`, `acp: false`. `authMethods`: `api-key` e `chat-gpt`. `auth.logout` existe. |
| 2 | `session/new` + MCP HTTP | **[verificado]** `cwd` de worktree aceito; 4 modos (`read-only`, `workspace-write`, `agent` = "Auto review", `agent-full-access`), 8 modelos e 5 config options (`mode`, `collaboration_mode`, `model`, `reasoning_effort`, `fast-mode`). Padrão ao criar: modo `agent`, `gpt-6.1-sol`, esforço `high`. O servidor MCP HTTP recebeu `initialize`, `notifications/initialized` e `tools/list` logo no `session/new`. O agente **chamou** `ping` e `submit_result({summary:"ok"})` quando o `request_permission` foi aprovado; com rejeição, as duas chamadas falharam com "user cancelled MCP tool call" e o servidor não recebeu nenhuma. Em `workspace-write`, a chamada de ferramenta MCP gera `request_permission` com `_meta.is_mcp_tool_approval` e 4 opções (Allow, Allow for this session, Always allow, Cancel). Não testei MCP no modo `agent`/`agent-full-access`. |
| 3 | Streaming | **[verificado]** Tipos de `session/update` vistos: `session_info_update`, `usage_update`, `tool_call`, `tool_call_update`, `agent_message_chunk`, `available_commands_update` (no `session/load`, também `user_message_chunk`). Primeiro update em 180 a 211 ms; primeira chamada de ferramenta em ~6,0 s; primeiro texto do agente em ~6,6 s com ferramentas e em 2,4 s num prompt sem ferramentas (história longa); fim do prompt em ~6,8 s. Não apareceu `agent_thought_chunk` (esforço `low`; causa [não confirmado]). A resposta traz `usage` e `_meta.quota.token_count` por prompt. |
| 4 | Cancelamento | **[verificado]** `session/cancel` com 83 chunks já recebidos: o `session/prompt` respondeu `stopReason: "cancelled"` 13 ms depois; nenhum chunk chegou depois do cancel. A sessão continuou viva: o prompt seguinte terminou em `end_turn`. |
| 5 | `request_permission` e sandbox | **[verificado]** **read-only**: criar arquivo na worktree é recusado pelo sandbox e o modelo desiste ("workspace is read-only"); não houve `request_permission`, nem com allow nem com reject. **workspace-write**: escrever num caminho da scratchpad fora da worktree, mas sob `/tmp`, **funcionou sem `request_permission`** (arquivos `c.txt` e `d.txt` criados) — o sandbox deixou `/tmp` gravável; **não impede** esse caso. Escrever fora da worktree e fora de `/tmp` (na pasta `out/` deste spike): o sandbox bloqueou, o adaptador mandou `request_permission` (`kind: execute`, opções `allow_once`, `allow_always` = emenda de execpolicy, `reject_once` com `optionId: "cancel"`). **Allow** → comando reexecutado fora do sandbox, arquivo criado. **Reject** → o turno terminou com `stopReason: "cancelled"` e o arquivo não existe. Que `/tmp` seja gravável por padrão em `workspace-write` vem do comportamento medido; a documentação do Codex não foi consultada [não confirmado como regra documentada]. Ou seja: para impedir escrita na scratchpad do dono em `/tmp`, o `workspace-write` do Codex sozinho não basta. |
| 6 | Retomada | **[verificado]** `session/load` com processo novo, 0,65 a 0,87 s; o histórico volta por replay de updates (mensagem do usuário, chamadas de ferramenta, resposta). Os config options **voltam ao padrão** (`agent`, `gpt-6.1-sol`, `high`): é preciso chamar `set_config_option` depois de cada load. O modelo lembra a conversa (follow-up respondeu sobre o `ping` e o `submit_result`). Ele avisa no texto que a sessão foi gravada com `gpt-6-luna` e retomada com `gpt-6.1-sol`. **`kill -9` no meio da tarefa**: 1,5 s depois do envio; o `session/prompt` falhou com "ACP connection closed"; nenhum processo sobrevivente na árvore (nem os MCPs); o arquivo da sessão já estava em disco (132 KB); `session/load` funcionou e repete só a mensagem do usuário (sem resposta parcial); o follow-up mostrou que o modelo sabe que não terminou. A tarefa **não é retomada sozinha**. Arquivos: `~/.codex/sessions/AAAA/MM/DD/rollout-<data-hora>-<sessionId>.jsonl`, ~141 KB depois de um prompt trivial (131,9 KB logo após o kill; 141,2 e 141,8 KB nas duas sessões do item 2/3); o arquivo cresce ~2,3 KB no load + follow-up (141,8 → 144,2 KB). Há estado global compartilhado em `~/.codex` (`state_5.sqlite` ~23,7 MB, `logs_2.sqlite` ~7,2 MB), que não é por sessão. Conteúdo nunca lido. |
| 7 | Concorrência | **[verificado]** Ver subseção abaixo. Resumo: `processModel` = **um adaptador → um `codex app-server` → N sessões (threads)**; 3 sessões no mesmo processo funcionaram em paralelo. |
| 8 | Cota | **[verificado]** O adaptador **não repassa a cota de forma estruturada**: `_meta.quota` na resposta do prompt só traz tokens (`token_count`, `model_usage`). A cota aparece só no texto do comando local `/status` (janela de 5 h e semanal, % restante e hora de reset; créditos). **[secundária]** No código do adaptador, o `/status` chama `account/rateLimits/read` e guarda as notificações `account/rateLimits/updated` no estado da sessão; nada vai para o cliente ACP além do texto. **Consulta direta**: `codex app-server` (stdio, `initialize` + `initialized` + `account/rateLimits/read`) respondeu em 751 ms, sem prompt de modelo, com `primary` (janela de 300 min, `usedPercent`, `resetsAt`), `secondary` (10080 min), `credits`, `planType`, `rateLimitReachedType`, `rateLimitsByLimitId`. O `codex app-server --help` só lista `daemon`, `proxy`, `generate-ts` e `generate-json-schema`; o protocolo foi usado como o adaptador usa. A resposta traz um `accountId`; fica só no `out/` (fora do git). |
| 9 | Perfil isolado | **[verificado]** `CODEX_HOME` numa pasta vazia, só com `config.toml` contendo `cli_auth_credentials_store = "file"`, e `OPENAI_API_KEY`/`CODEX_API_KEY` vazias. O `initialize` funciona normalmente e lista `api-key` e `chat-gpt` em `authMethods`. O `session/new` falha com o erro JSON-RPC **-32000 "Authentication required"**. Nenhuma mensagem em stderr. O adaptador **não abre login sozinho**: espera um `authenticate` do cliente (não chamado). O `codex` criou na pasta vazia seus arquivos de estado (SQLite, `installation_id`, `skills/`), sem `auth.json`. O login real num perfil isolado (segundo login) ficou **pendente**. |

### Item 7: processos e RAM

Medido por `/proc` (árvore de filhos do adaptador, RSS em MB), com 3 worktrees, um prompt trivial por sessão. Cada sessão carregou, por causa do `~/.codex/config.toml` do dono, um MCP `playwright` (~210 MB por sessão, em 2 processos). Separei isso do restante porque não faz parte do Codex.

| Cenário | Árvore sem sessão | Depois de 1 sessão | Depois de 3 sessões | Pico durante os prompts |
|---|---|---|---|---|
| Mesmo processo (1 adaptador, 3 sessões) | 2 proc., 222 MB (adaptador 89 + codex 133) | 4 proc., 510 MB | 8 proc., 968 MB (adaptador 92 + codex 241 + MCPs do dono 634) | 24 proc., 1190 MB |
| 3 processos (1 sessão cada) | 2 proc., ~219 MB cada | 4 proc., ~508 MB cada | 3 × ~508 MB | 16 proc., 1750 MB (soma) |

- **`processModel`**: um adaptador sobe um único `codex app-server` e multiplexa as sessões nele. 3 sessões em paralelo no mesmo processo funcionaram.
- **RAM por sessão sem os MCPs do dono**: marginal de ~37 MB por sessão adicional no mesmo processo ((334 − 222) / 3 = 37), contra ~296 MB por sessão quando cada uma tem seu processo (adaptador ~90 + codex ~205). Custo fixo de um adaptador vazio: ~220 MB.
- **Com os MCPs do dono**: ~210 MB a mais por sessão, em dois processos (`npm exec` + node). Em produção isso depende de como o OTheater monta os `mcpServers`: aqui eles vieram do `config.toml` global do dono, não do `session/new`.
- Depois dos prompts apareceram `codex-code-mode` (~22 MB) e shells filhos (o Codex rodou `zsh -lc`, que carregou os completions do `kubectl` e do `docker`: 141 MB de "shell/outros" naquele instante).
- Tempo dos 3 prompts em paralelo: ~10,9 s no mesmo processo contra ~4,2 s nos 3 processos. Causa não investigada (serialização no app-server, partida dos MCPs ou prompts diferentes): [não confirmado].
- Os picos foram amostrados por intervalo, então o pico real pode ser maior (o instante final do mesmo processo mediu 27 proc. e 1402 MB).

## Não coberto (pendente)

- Passagem de bastão para outro cliente (retomar no Claude Code/OpenCode o que o Codex fez): não testado.
- O segundo login (outra conta num `CODEX_HOME` isolado, com `chat-gpt` ou `api-key`): não feito, pela ordem de não fazer login. Só foi verificado que o perfil vazio exige autenticação (item 9).
- Windows: tudo foi medido só no Linux.
- Modos `agent` e `agent-full-access` com `request_permission`; só `read-only` e `workspace-write` foram exercitados.
- Preço e custo relativo dos modelos; limites e termos da assinatura.

## Avisos

- O `/tmp` desta máquina é um tmpfs de 16 GB com cota por usuário; durante o item 7 o `/tmp` estourou a cota (EDQUOT) por causa de uma pasta de outra sessão em `/tmp/claude-1000` (~8,3 GB, não é deste spike e não foi apagada). Os resultados do item 7 foram regravados em `out/results.jsonl`.
- O `/status` imprime o e-mail da conta. O e-mail, o `accountId` e os caminhos reais da conta ficam só em `out/` (no `.gitignore`); este README os omite.
- O ambiente do dono (config global do Codex, MCPs do `config.toml`) influencia o RSS e o comportamento. Medir de novo num `CODEX_HOME` limpo e logado dará números do Codex puro.

## Como rodar

```sh
npm install
npx tsc --noEmit            # typecheck
node src/s0-new.ts          # itens 1 e 2, sem prompt
node src/s1-stream.ts s1b-stream allow   # itens 2, 3, 8 (gasta prompts)
node src/s2-cancel.ts       # item 4
node src/s3-perm.ts         # item 5 (e s3b-perm.ts)
node src/s4-resume.ts       # item 6
node src/s5-concurrency.ts  # item 7
node src/s6-profile.ts      # item 9, sem prompt, sem login
node src/s7-quota.ts        # item 8, consulta direta, sem prompt
```

Os scripts esperam o repositório de teste e as worktrees na scratchpad (`REPO`, `WT(n)` em `src/lib.ts`). As saídas ficam em `out/`: `results.jsonl` (resultados), `prompts-count.jsonl` e um `.jsonl` por execução com cada mensagem trocada.
