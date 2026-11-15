# spikes/acp-claude: ACP com o Claude Code

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10). Código **descartável**: um cliente ACP mínimo em TypeScript que sobe `@agentclientprotocol/claude-agent-acp` como subprocesso e registra toda mensagem em JSONL (`out/`, ignorado pelo git).

Medido em 2026-11-14 (UTC-3), uso pessoal, na assinatura do dono. Nenhum login foi feito, nenhuma credencial foi lida, `~/.claude/settings.json` não foi tocado. Marcas: **[V]** verificado localmente, **[S]** fonte secundária (leitura do código/doc do pacote, não executada), **[N]** não confirmado.

## Máquina e versões

| Item | Valor |
|---|---|
| Sistema | Fedora 45, kernel 7.3.3-300.fc45.x86_64 [V] |
| Node | v24.18.0 (roda `.ts` direto, type stripping) [V] |
| Claude Code (CLI instalado) | 2.1.325 [V] |
| Adaptador | `@agentclientprotocol/claude-agent-acp` 0.107.0, Apache-2.0 [V] |
| Base do adaptador | `@anthropic-ai/claude-agent-sdk` 0.3.323 (licença proprietária) + binário nativo `claude-agent-sdk-linux-x64` 0.3.323 [V] |
| SDK ACP do cliente | `@agentclientprotocol/sdk` 2.7.0 (entrypoint v1) [V] |
| MCP | `@modelcontextprotocol/sdk` 1.32.2, zod 4.6.7, HTTP streamable sem estado em 127.0.0.1 [V] |
| Protocolo | ACP `protocolVersion: 1` [V] |
| Modelo usado | `haiku` (`claude-haiku-5-5`), esforço `low`, aplicados por `session/set_config_option` [V] |

## Resultado por item

| # | Item | Resultado | Marca |
|---|---|---|---|
| 1 | `initialize` | `agentInfo` = claude-agent-acp 0.107.0. `loadSession: true`; `promptCapabilities` image + embeddedContext; `mcpCapabilities` http + sse; `sessionCapabilities`: additionalDirectories, close, delete, fork, list, options, resume, status, systemPrompt (override), title; `auth` logout + status; `_meta.claudeCode.promptQueueing`, `_meta.steering.supported`. **`authMethods: []`** (nenhum método de login anunciado; a conta vem do perfil do `claude`). | V |
| 2 | `session/new` com worktree + MCP HTTP | cwd = worktree (wt1). O servidor MCP HTTP foi conectado (`status: connected`) e o agente chamou `ping` e `submit_result {summary:"ok"}` (2 chamadas registradas no servidor). Config options: `mode` (default, acceptEdits, plan, auto, bypassPermissions; **padrão `auto`**), `model` (default, opus, claude-fable-5-2[1m], sonnet, haiku; padrão sonnet), `effort` (default, low, medium, high, xhigh, max; padrão high), `ultracode` (on/off), `agent` (default + agentes do perfil). Ressalva: o init da sessão mostrou também plugins, conectores claude.ai (Gmail, Docs) e `.mcp.json` do projeto (ver item 8). | V |
| 3 | Streaming | Tipos de `session/update` vistos: `agent_message_chunk`, `tool_call`, `tool_call_update`, `usage_update`, `available_commands_update`, `session_info_update`, `user_message_chunk` (só no replay do load). Tempo até o 1º chunk com Haiku/low: 1,76 a 2,36 s (mediana ~1,9 s). `PromptResponse.usage` traz inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens. | V |
| 4 | `session/cancel` | `stopReason: "cancelled"` nos dois casos. Latência do `session/cancel` até a resposta do prompt: **89 ms** (cancelando texto em streaming, após 293 linhas) e **42 ms** (cancelando uma ferramenta `sleep 45`). A árvore de processos manteve só `node` + `claude`; o processo `sleep` filho não foi observado nas amostras, então **não está confirmado** que o cancelamento mate o filho da ferramenta. | V (latência e stopReason); N (filho `sleep`) |
| 5 | `request_permission` | Só aparece em modo `default` (no padrão `auto` não houve pedido algum). Payload: `toolCall` com título (`Write a.txt`) e `kind: edit`; opções `allow-once` (allow_once, "Yes"), `allow-with-updates` (allow_always, "Yes, allow all edits during this session"), `reject` (reject_once, "No"). Responder `allow-once`: arquivo criado. Responder `reject`: arquivo não criado, o agente seguiu e terminou com `end_turn`. `echo hi` (Bash) rodou **sem** pedido em modo `default`. | V |
| 6 | Retomada | (a) `session/load` em processo novo de sessão terminada: 3,7 s, faz replay de `user_message_chunk`, `tool_call`, `tool_call_update` e `agent_message_chunk`; a pergunta seguinte ("quais dois arquivos pedi?") foi respondida certo ("a.txt and b.txt"). (b) `kill -9` do adaptador no meio de uma contagem 1..400: o prompt falhou com "ACP connection closed" em 2,5 s e o `claude` filho **ficou órfão e vivo por ~7,3 s**, depois terminou sozinho. (c) `session/load` depois do kill: 3,8 s; o replay trouxe só a mensagem do usuário, sem texto do agente, mas a pergunta seguinte ("qual o último número?") respondeu **"400"**, ou seja, o contexto carregado já tinha a resposta completa. Arquivo de sessão: `~/.claude/projects/<cwd com `/` e `.` trocados por `-`>/<sessionId>.jsonl`; 583.683 bytes (wt1, 3 prompts + load), 371.271 bytes (sessão do kill, após o follow-up; 235.565 bytes logo após o kill). Conteúdo não lido nem copiado. | V |
| 7 | Concorrência | 3 sessões simultâneas (wt1, wt2, wt3) **no mesmo processo do adaptador**, 1 prompt cada, 11,0 s de parede, todas `end_turn`. Árvore: 1 `node` (adaptador) + **1 `claude` por sessão**; durante o prompt, cada `claude` abriu `zsh -c` + `sleep` (10 processos no pico). RSS ocioso (3 sessões): adaptador 130 MB, cada `claude` 296 a 297 MB, total **1.018 MB** (PSS 758 MB). Pico durante o prompt: `claude` 314 a 326 MB cada, total 1.099 MB (PSS 811 MB). Depois dos prompts: 1.079 MB. Adaptador sozinho depois do `initialize`: 126 MB (PSS 98). Ver conclusão abaixo. | V |
| 8 | Permissões via ACP | Ver a seção própria. Mecanismo testado ponta a ponta: **Bash removido**. | V |
| 9 | Cota | O adaptador repassa o `rate_limit_event` do SDK como `usage_update._meta["_claude/rateLimit"]`: `status` (allowed), `resetsAt` (epoch s), `rateLimitType` (five_hour), `overageStatus`, `overageDisabledReason`, `isUsingOverage`, `unifiedWindows.five_hour` e `unifiedWindows.seven_day`, cada um com `utilization`, `resetsAt`, `status`. Observado crescendo de 0,03 para 0,04 na janela de 5 h ao longo dos 16 prompts. A unidade de `utilization` (fração ou percentual) **não está confirmada**. Também há `_meta["_claude/model"]` e `_meta["_claude/origin"]`. | V (campos); N (unidade) |

### Conclusão do item 7: `processModel`

**`process-per-session`** para o executor: cada sessão ACP é um processo `claude` próprio. O adaptador (`node dist/index.js`) é **um só** e serve várias sessões, mas é só um intermediário de ~130 MB; o trabalho do agente roda no `claude` filho.

Custo de RAM por sessão, medido com o `claude` ocioso logo após `session/new`:
- **~296 MB RSS** (~221 MB PSS) por sessão, subindo a ~320 MB (RSS) em atividade;
- mais ~130 MB (RSS) do adaptador, fixos, divididos entre as sessões;
- o total de 3 sessões ficou em ~1,0 a 1,1 GB RSS (~0,76 a 0,81 GB PSS).

Ressalva: essas sessões carregaram plugins, conectores e MCPs do perfil do dono (ver item 8); com `strictMcpConfig` e menos plugins o custo pode ser menor. Isso **não foi medido**.

Ainda sobre processos: o `SIGTERM` no adaptador **não** encerra o `claude` filho (todas as execuções deixaram filhos vivos 0,5 s depois; o harness os mata com `SIGKILL`). O Supervisor precisa matar a árvore, não só o adaptador.

## Item 8: entregar `tools` sem Bash

Código: `src/s8-permissions.ts`; resultado em `out/s8-summary.json` (local, não versionado).

Fonte [S/V]: lendo o adaptador 0.107.0, `_meta.claudeCode.options` é espalhado nas opções do SDK (`tools`, `disallowedTools`, `strictMcpConfig`, `settings`, `env`, `extraArgs`, `allowDangerouslySkipPermissions`; `mcpServers` é mesclado), mas `permissionMode`, `cwd` e `canUseTool` são controlados pelo ACP. `settingSources` é fixo em `user`, `project`, `local`. [S]

Teste feito [V], sessão A (restrita) em wt2, com `_meta.claudeCode.options`:
- `tools: ["Read","Glob","Grep","Edit","Write"]`
- `disallowedTools: ["Bash"]`
- `strictMcpConfig: true`
- `allowDangerouslySkipPermissions: false`
- `settings: { permissions: { defaultMode: "dontAsk", disableBypassPermissionsMode: "disable", deny: ["Bash"] } }`

Resultado da sessão A:
- A lista de ferramentas do `system/init` (via `emitRawSDKMessages`) ficou: Edit, Glob, Grep, Read, Write e as 2 do MCP do spike. **Bash ausente.**
- Pedido "rode `echo hi` com Bash": o agente respondeu `NO_BASH` e listou exatamente essas 7 ferramentas. 0 pedidos de permissão.
- `mcp_servers` ficou só com o MCP do spike: `strictMcpConfig` cortou conectores claude.ai e MCP de plugin.

Controle, sessão B em wt3 (sem opções, com `.mcp.json` no cwd): lista com **Bash** e dezenas de ferramentas, MCP do projeto `projmcp` conectado (`source: project`), `context7` (plugin) e **conectores claude.ai (Gmail e Docs) do perfil do dono**. Ou seja, sem restrição o perfil do dono vaza para a sessão.

Limites do que se mostrou:
- `tools` e `disallowedTools` foram enviados juntos; **não** se separou qual dos dois removeu o Bash.
- O `permissionMode` no init continuou `auto` nas duas sessões: o `defaultMode: "dontAsk"` das `settings` não apareceu no init (o adaptador controla o modo). `dontAsk` e `disableBypassPermissionsMode` ficaram **sem efeito observável isolado** neste teste. [N]
- Na sessão A o init ainda listou 12 plugins, 46 skills, 88 slash commands e 22 agentes do perfil; se são usáveis não foi testado. [N]
- Perfil isolado por `CLAUDE_CONFIG_DIR` (via `_meta.claudeCode.options.env` ou ambiente do adaptador): só testado vazio e **sem login**: `initialize` devolve `authMethods: []` e `session/new` **funciona** sem credencial (o erro de autenticação, se houver, viria no prompt, que não foi enviado). [V]

## Prompts e tokens

**16 prompts de 25** (contados em `out/prompts.log`), todos triviais, só nos worktrees de teste, Haiku/low. O adaptador informa tokens em `PromptResponse.usage`: de ~7 mil a ~165 mil `totalTokens` por prompt, quase tudo cache (leitura e escrita); `outputTokens` de 3 a 428 por prompt. Detalhe por prompt em `out/*-summary.json`.

## Como rodar

Precisa do repositório de teste com 3 worktrees (ver `src/paths.ts`) e, no mesmo dia, da assinatura do `claude` já logada na máquina.

```
npm install
npx tsc --noEmit
node src/s1-basic.ts          # itens 1, 2, 3
node src/s5-perms.ts          # item 5
node src/s4-cancel.ts         # itens 3 e 4
node src/s6-resume.ts a b c   # item 6 (estágios)
node src/s7-concurrency.ts    # item 7
node src/s8-permissions.ts    # item 8
node src/s9-nologin.ts <pasta-vazia>   # perfil vazio, 0 prompts
```

## Pendências (não medido)

- Handoff da sessão para outro cliente (carregar no Claude Code interativo uma sessão criada pelo ACP, e o inverso).
- Segundo login/segunda conta (`CLAUDE_CONFIG_DIR` com outro perfil logado); aqui só se viu o perfil vazio.
- Windows (só foi medido em Linux).
- Se o cancelamento mata o filho da ferramenta (`sleep`).
- Efeito isolado de `disallowedTools`, `deny`, `dontAsk` e `disableBypassPermissionsMode`; como mudar o `permissionMode` real por ACP além dos modos de `session/set_config_option`.
- Unidade de `utilization` no `_claude/rateLimit`.
- RAM por sessão com `strictMcpConfig` e sem plugins.
- Comportamento de `session/new` sem login quando se envia um prompt (erro de autenticação).
- Licença do `@anthropic-ai/claude-agent-sdk` (proprietária) e o que ela permite redistribuir; conferir termos vigentes antes de empacotar. [N]
- `/tmp` do dono estava perto da cota (tmpfs) durante o spike, por arquivos que não são deste spike.
