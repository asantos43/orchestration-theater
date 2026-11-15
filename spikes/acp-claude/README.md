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
| 4 | `session/cancel` | `stopReason: "cancelled"` nos dois casos. Latência do `session/cancel` até a resposta do prompt: **89 ms** (cancelando texto em streaming, após 293 linhas) e **42 ms** (cancelando uma ferramenta `sleep 45`). A árvore de processos manteve só `node` + `claude`; o processo `sleep` filho não foi observado nas amostras. O item 8c mediu isso com um filho que a árvore enxerga: no primeiro plano o `session/cancel` mata o filho; em segundo plano (`run_in_background`) ele sobrevive. | V (latência e stopReason); ver item 8c (filho) |
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

Ressalva: essas sessões carregaram plugins, conectores e MCPs do perfil do dono (ver item 8); com `strictMcpConfig` e menos plugins o custo pode ser menor. O item 8c mediu isso: com `strictMcpConfig` e `settingSources: []` o `claude` fica 70 a 75 MB menor (ver tabela lá).

Ainda sobre processos: o `SIGTERM` no adaptador **não** encerra o `claude` filho (todas as execuções deixaram filhos vivos 0,5 s depois; o harness os mata com `SIGKILL`). O Supervisor precisa matar a árvore, não só o adaptador.

## Item 8: entregar `tools` sem Bash

Código: `src/s8-permissions.ts`; resultado em `out/s8-summary.json` (local, não versionado).

Fonte [S/V]: lendo o adaptador 0.107.0, `_meta.claudeCode.options` é espalhado nas opções do SDK (`tools`, `disallowedTools`, `strictMcpConfig`, `settings`, `env`, `extraArgs`, `allowDangerouslySkipPermissions`; `mcpServers` é mesclado), mas `permissionMode`, `cwd` e `canUseTool` são controlados pelo ACP. `settingSources` vem `user`, `project`, `local` por padrão, mas o cliente pode trocá-lo: o padrão é posto **antes** do espalhamento de `_meta.claudeCode.options` (correção de 2026-11-15, medida no item 8b). [S/V]

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
- `tools` e `disallowedTools` foram enviados juntos; **não** se separou qual dos dois removeu o Bash. O item 8b separou.
- O `permissionMode` no init continuou `auto` nas duas sessões: o `defaultMode: "dontAsk"` das `settings` não apareceu no init (o adaptador controla o modo). O item 8b explica por quê.
- Na sessão A o init ainda listou 12 plugins, 46 skills, 88 slash commands e 22 agentes do perfil; se são usáveis não foi testado. [N]
- Perfil isolado por `CLAUDE_CONFIG_DIR` (via `_meta.claudeCode.options.env` ou ambiente do adaptador): só testado vazio e **sem login**: `initialize` devolve `authMethods: []` e `session/new` **funciona** sem credencial (o erro de autenticação, se houver, viria no prompt, que não foi enviado). [V]

## Item 8b: cada chave de permissão isolada (2026-11-15)

Código: `src/s10-permissions-isolated.ts`; resultado em `out/s10-summary*.json` (local, não versionado). Cada caso sobe um adaptador novo e muda **uma** coisa. A prova é `touch bash-<caso>.txt` no worktree de teste: não é só leitura, então o modo `default` pergunta. 7 prompts, Haiku/low.

Resultados [V]:

| Caso (só isto muda) | Bash no init | Pedido de permissão | Arquivo criado | Leitura |
|---|---|---|---|---|
| Controle, modo `default` | sim | 1 (`execute`) | sim | O modo `default` pergunta antes do `touch`. |
| `tools: [Read, Glob, Grep, Edit, Write]` | não | 0 | não | Remove o Bash. O modelo ainda tentou uma chamada; ela saiu `failed`. |
| `disallowedTools: [Bash]` | não | 0 | não | Remove o Bash sozinho. |
| `settings.permissions.deny: [Bash]` | não | 0 | não | Uma regra `deny` da ferramenta inteira também tira o Bash da lista. |
| `settings.permissions.defaultMode: dontAsk` no `_meta`, depois modo `default` | sim | 1 | sim | **Sem efeito**: o modo do ACP vence, e o pedido chega ao cliente. |
| `settings.permissions.disableBypassPermissionsMode: disable` no `_meta` | sim | 0 (modo `auto`) | sim | O catálogo **ainda oferece** `bypassPermissions`, mas `set_config_option` falha com `-32603`, *"Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration"*. A sessão segue em `auto`, e o `touch` rodou sem pedido, porque o `auto` aprova. |
| `allowDangerouslySkipPermissions: false` (0 prompts) | — | — | — | O catálogo **some** com `bypassPermissions`; pedir esse modo dá `Invalid value`. |
| `settings.local.json` do cwd com `defaultMode: dontAsk` (0 prompts) | — | — | — | A sessão começa em `default`: `dontAsk` não está no catálogo do adaptador, que cai para `default`. |
| `settings.local.json` do cwd com `defaultMode: acceptEdits` e `disableBypassPermissionsMode: disable` (0 prompts) | — | — | — | Começa em `acceptEdits` e o catálogo vem **sem** `bypassPermissions`. |
| `settingSources: []` | sim | — | — | Prompt "ok". Ferramentas de 76 para 30, plugins de 12 para 5 (sobram só os `@builtin` do app), skills de 46 para 22, agentes de 22 para 7, slash commands de 88 para 58, e 0 ferramentas MCP. Os conectores claude.ai ainda aparecem em `mcp_servers`, `pending`. O total de tokens caiu de ~84 mil para ~30 mil no prompt trivial. |

Pedir o modo `dontAsk` por `set_config_option` também dá `Invalid value`: o adaptador 0.107.0 não oferece `dontAsk` ao cliente ACP.

Por quê (lendo `dist/v1/acp-agent.js` e `dist/session-mode.js` do 0.107.0) [S/V]:
- O modo inicial sai de `resolveInitialPermissionMode`: um modo explícito interno, o do transcript retomado, ou o `permissions.defaultMode` dos **arquivos** de settings (usuário, `.claude/settings.json` e `.claude/settings.local.json` do cwd, e a política gerenciada). As `settings` do `_meta` chegam ao SDK (o `deny` funcionou por elas), mas não entram nessa conta. Depois o adaptador passa `permissionMode` explícito ao SDK, e isso vence o `defaultMode`.
- O `allowBypass` do catálogo também vem dos arquivos e de `allowDangerouslySkipPermissions !== false`. Por isso o `disableBypassPermissionsMode` do `_meta` não tira o modo do catálogo. Quem recusa é o CLI, só na hora de trocar o modo.
- O catálogo só tem `default`, `acceptEdits`, `plan`, `auto` (se permitido) e `bypassPermissions` (se permitido).

O que isso sugere para o OTheater [proposta, não decidido]:
- **Remover o Bash com `tools`**, como a arquitetura já diz. Usar `disallowedTools` ou `deny` como segunda camada.
- O efeito do `dontAsk` ("nega tudo que pediria permissão") pelo ACP se obtém com o modo `default` mais o **cliente** do OTheater respondendo `reject` a todo `request_permission` do Executor headless. O `dontAsk` em si não chega.
- **Bloquear o bypass com `allowDangerouslySkipPermissions: false`**, que tira o modo do catálogo. O `disableBypassPermissionsMode` no `_meta` só recusa na troca, e o catálogo continua mentindo.
- **`settingSources: []`** (ou só `project`) corta o vazamento do perfil do dono e reduz o contexto. Os conectores claude.ai continuam listados; `strictMcpConfig` (item 8) os tirava.

## Item 8c: `deny` por padrão de comando, RAM por sessão e cancelamento do filho (2026-11-15, UTC-3)

Script: `src/s11-permissions-deny-ram-cancel.ts` (fases `deny`, `ram`, `cancel`). Haiku/low, 17 prompts, só em worktrees de teste em pasta temporária da scratchpad (`<tmpdir>`). Nada em `~/.claude`. Saídas brutas em `out/s11-*.json` e `out/s11-*.jsonl`.

### 1. `permissions.deny` por padrão de comando [V]

Regra enviada por `_meta.claudeCode.options.settings.permissions.deny: ["Bash(touch *)"]`, modo `default`, política do cliente `allow` (aprova qualquer `request_permission`). Formato da regra conferido na documentação oficial, https://code.claude.com/docs/en/permissions, lida em 2026-11-15 [S]: `Bash(touch *)` e a forma antiga `Bash(touch:*)` são equivalentes.

| Variante pedida ao modelo | Pedidos de permissão ao cliente | Arquivo criado | Resultado |
|---|---|---|---|
| `touch a.txt` | 0 | não | negado pela regra (`Permission denied ... has been denied`) |
| `sh -c "touch b.txt"` | 1 | **sim** | **a regra não pegou**; o cliente com `allow` deixou passar |
| `/usr/bin/touch c.txt` | 0 | não | negado |
| `env touch d.txt` | 0 | não | negado |
| `bash -c 'touch e.txt'` | 1 | **sim** | **a regra não pegou** |
| `touch f.txt` com a regra `Bash(touch:*)` | 0 | não | negado (formato com dois pontos vale) |

- A regra `deny` é aplicada antes do `request_permission`: quando pega, o cliente nem é consultado. [V]
- **Só `sh -c` e `bash -c` furam.** O comando interno de um shell embrulhado não é analisado. A documentação oficial diz que `Bash(rm *)` não cobre `/bin/rm`, `bash -c` nem `env` [S]; aqui só o `sh -c` e o `bash -c` divergiram a favor da documentação: caminho absoluto e `env` foram negados. [V para o `claude` 2.1.325; pode mudar de versão.]
- Consequência: `deny` por padrão é segunda camada, não fronteira. Os dois furos geraram `request_permission`, então com política `reject` do cliente (a do OTheater) eles fecham; com `allow`, não. [V para o caso medido; outros comandos e embrulhos são [N]]

### 2. RAM por sessão com `strictMcpConfig` e `settingSources: []` [V]

Método do `s7-concurrency.ts` (RSS e PSS por `/proc`), 1 sessão por variante, 1 prompt trivial, amostra 6 s depois do prompt. RSS do processo `claude` e soma de adaptador + `claude`:

| Variante | Ferramentas no init | Servidores MCP | Plugins / skills | `claude` RSS | Árvore RSS | Árvore PSS |
|---|---|---|---|---|---|---|
| base | 76 | 3 | 12 / 46 | 315 MB | 446 MB | 349 MB |
| base, repetição | 76 | 3 | 12 / 46 | 313 MB | 442 MB | 345 MB |
| `strictMcpConfig` | 32 | 0 | 12 / 46 | 300 MB | 397 MB | 300 MB |
| `settingSources: []` | 69 | 2 (claude.ai) | 5 / 22 | 254 MB | 378 MB | 285 MB |
| os dois | 30 | 0 | 5 / 22 | 242 MB | 374 MB | 296 MB |

- Ganho do `claude` (RSS): `strictMcpConfig` -15 MB, `settingSources: []` -61 MB, os dois -73 MB. A repetição da base variou 2 MB, então o ganho do `strictMcpConfig` sozinho (15 MB) está perto do ruído; o dos outros dois não. [V, uma rodada por variante]
- O adaptador (Node) fica em ~100 a 130 MB em todas as variantes. [V]
- Tokens do prompt: 41,8 mil (base) contra 30,0 mil (os dois): o corte também tira ~12 mil tokens de contexto por sessão. [V]
- O PSS oscila mais que o RSS no mesmo estado (285 a 349 MB); não usar como número de planejamento sem mais rodadas. [N para a variância]

### 3. `session/cancel` mata o filho de uma ferramenta Bash longa? [V]

Comando: `timeout 117 tail -f /dev/null` (o `sleep` é bloqueado pelo Claude Code; este roda até 117 s e fica visível na árvore: `claude` > `zsh` > `timeout` > `tail`). Processos amostrados em `/proc` (estado e pai) aos 0, 0,5, 1,5, 4 e 9 s depois do fim do prompt.

| Caso | `stopReason` | Latência do cancelamento | Filho depois do cancel |
|---|---|---|---|
| primeiro plano | `cancelled` | 25 ms | **morto** (`zsh`, `timeout` e `tail` sumiram; sem zumbi) |
| segundo plano (`run_in_background`) | `cancelled` | 1546 ms | **vivo** nas 5 amostras (até 9 s); matei os 3 PIDs ao fim (só os que o teste criou) |

- O `session/cancel` não mata a tarefa em segundo plano do Claude Code. O OTheater precisa, ao cancelar, encerrar a árvore do `claude` e conferir que não sobrou filho, em vez de confiar no cancelamento do ACP. [V]
- Se a tarefa em segundo plano também sobrevive ao fechamento do adaptador não foi isolado. [N]

## Prompts e tokens

**40 prompts** no total (contados em `out/prompts.log`; 16 até o item 8, 7 no item 8b, 17 no item 8c; o item 8c passou do limite de 25 do item 8b, por pedido da tarefa da rodada de 2026-11-15), todos triviais, só nos worktrees de teste, Haiku/low. O adaptador informa tokens em `PromptResponse.usage`: de ~7 mil a ~165 mil `totalTokens` por prompt, quase tudo cache (leitura e escrita); `outputTokens` de 3 a 428 por prompt. Detalhe por prompt em `out/*-summary.json`.

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
node src/s10-permissions-isolated.ts [caso ...]   # item 8b (7 prompts; sem argumento roda todos)
node src/s9-nologin.ts <pasta-vazia>   # perfil vazio, 0 prompts
SPIKE_SCRATCH=<tmpdir> node src/s11-permissions-deny-ram-cancel.ts deny|ram|cancel   # item 8c (17 prompts)
```

## Pendências (não medido)

- Handoff da sessão para outro cliente (carregar no Claude Code interativo uma sessão criada pelo ACP, e o inverso).
- Segundo login/segunda conta (`CLAUDE_CONFIG_DIR` com outro perfil logado); aqui só se viu o perfil vazio.
- Windows (só foi medido em Linux).
- Se o filho em segundo plano continua vivo quando o adaptador é fechado (o item 8c só mediu `session/cancel`), e se `deny` cobre outros embrulhos (`xargs`, `find -exec`, `python -c`).
- Variância da RAM (uma rodada por variante, repetição só da base).
- Se os 5 plugins `@builtin` e os conectores `pending` que sobram com `settingSources: []` são usáveis.
- Unidade de `utilization` no `_claude/rateLimit`.
- Comportamento de `session/new` sem login quando se envia um prompt (erro de autenticação).
- Licença do `@anthropic-ai/claude-agent-sdk` (proprietária) e o que ela permite redistribuir; conferir termos vigentes antes de empacotar. [N]
- `/tmp` do dono estava perto da cota (tmpfs) durante o spike, por arquivos que não são deste spike.
