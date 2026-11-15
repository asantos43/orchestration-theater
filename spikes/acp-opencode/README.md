# spikes/acp-opencode

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10): um cliente ACP mínimo em TypeScript que sobe `opencode acp` como subprocesso, registra em JSONL cada mensagem trocada e mede 9 itens. Código descartável; nada daqui segue para a Fase 1.

Marcas usadas em todo o documento:

- **[verificado]** = verificado localmente, por execução nesta máquina em 2026-11-14 (UTC-3), com a saída em `out/` (ignorada pelo git).
- **[secundária]** = vem de fonte secundária (leitura de strings do binário ou do código instalado, não de documentação oficial).
- **[não confirmado]** = hipótese ou causa não testada.

Os termos de uso dos provedores não foram consultados neste spike. Nada aqui afirma o que o provedor permite.

## O que foi medido, onde e com quê

| | |
|---|---|
| Data e hora | 2026-11-14, execuções entre 22:36 e 22:55 (UTC-3) |
| Sistema | Fedora Linux 45, kernel 7.3.3-300.fc45.x86_64 |
| Node | v24.18.0 (TypeScript rodado direto, sem build; `npx tsc -p .` passa) |
| `opencode` | 1.19.5 (`opencode acp`; agentInfo: `OpenCode` 1.19.5) |
| `@agentclientprotocol/sdk` | 2.7.0 (entrada `/unstable`, necessária para `configOptions` e `usage`) |
| `@modelcontextprotocol/sdk` / `zod` / `typescript` | 1.32.2 / 4.6.7 / 7.0.2 |
| Conta e provedor | conta do dono, provedor **Google** (chave de API; só nome e tipo foram lidos, o `auth.json` nunca foi lido nem impresso). Nenhum login novo. |
| Modelo dos testes | `google/gemini-3.1-flash-lite`, esforço `low` (troca de modelo explicada abaixo) |

A repo git de teste e as worktrees `wt1`, `wt2`, `wt3` ficaram na scratchpad da sessão (`<scratchpad>/acp-opencode/`), fora do repositório. O `~/.config/opencode` não foi alterado. O `opencode serve` do dono (porta 4096) não foi usado nem encerrado.

### Histórico do modelo (e por que alguns itens têm duas fontes)

1. `opencode/*` (chave Zen do dono): erro "This API key has expired" (1 prompt perdido). [verificado]
2. `google/gemma-4-26b-a4b-it`: o teto gratuito do Google é 16 000 tokens de entrada por minuto e o OpenCode manda 13 a 15 mil por requisição; deu "Internal error encountered" e o uso de ferramentas foi pouco confiável. Os itens 3 (parcial) e 4 e parte do 5 foram medidos nele. Os logs ficaram em `out/gemma-attempt/`. [verificado]
3. `google/gemini-3.1-flash-lite`: usado em tudo o resto. Os itens 1, 2 e 3 foram refeitos nele; o item 4 (cancelamento) **só** vale para o Gemma, porque no flash-lite a resposta chegou toda em rajada e o turno acabou antes do cancel (`out/s2-flashlite-no-cancel.result.json`).

## Prompts e tokens

- Contador (`out/prompt-count.json`): **24 de 25** envios de `session/prompt`, todos triviais e só em worktrees de teste. Inclui 1 perdido pela chave Zen expirada e as tentativas no Gemma. Lista completa em `out/prompts.jsonl`.
- Um prompt trivial custou **~16 a 18,7 mil tokens no total**, dos quais ~14 mil são contexto-base do OpenCode lido do cache (`cachedReadTokens`), 2 a 6 mil de entrada nova e de 1 a ~310 de saída [verificado, campo `usage` da resposta]. Somatório exato não calculado; por estimativa, 24 × ~17 mil ≈ 0,4 milhão de tokens, quase tudo em cache [não confirmado]. Custo em dólar: o `usage_update` traz `cost` (ex.: 0,0027 USD num prompt de 310 tokens de saída) [verificado].

## Resultado por item

| # | Item | Resultado medido |
|---|------|------------------|
| 1 | `initialize` | **[verificado]** 0,8 s. `agentInfo` = OpenCode 1.19.5. `loadSession: true`; `mcpCapabilities`: `http` e `sse`; `promptCapabilities`: `image` e `embeddedContext`; `sessionCapabilities`: `close`, `fork`, `list`, `resume` (sem `delete`, `title`, `additionalDirectories`). `authMethods`: um só, `opencode-login` ("Run `opencode auth login` in the terminal"), isto é, o login é feito fora do ACP. |
| 2 | `session/new` + MCP HTTP | **[verificado]** `cwd` de worktree aceito; 4,7 a 5,3 s (inclui subir os MCPs do dono). Resposta traz só `sessionId` e `configOptions`: `model` (532 opções, padrão do dono `minimax/MiniMax-M3`), `effort` (categoria `thought_level`; valores dependem do modelo, no flash-lite: `minimal`, `low`, `medium`, `high`, `default`) e `mode` (`build` e `plan`; `plan` "disallows all edit tools"). O MCP HTTP (`mcpServers` com `type: http`) foi conectado: o agente **viu e chamou** `ping` e `submit_result({summary:"ping ok"})`, e o servidor MCP recebeu as duas chamadas com os argumentos certos. As ferramentas aparecem para o agente como `otheater_ping` e `otheater_submit_result` (prefixo = nome do servidor MCP + `_`). |
| 3 | Streaming | **[verificado]** Tipos de `session/update` vistos: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update`, `available_commands_update` e, no `session/load`, `user_message_chunk`. No flash-lite: primeiro update em ~3,2 s e primeiro texto em 6,3 a 6,4 s (inclui o raciocínio; o texto veio em 1 a 14 chunks, em rajada no fim). No Gemma o texto veio em chunks a cada ~0,5 s a partir de 2,9 s. O tempo até o primeiro chunk depende do modelo e do limite do provedor, não do adaptador [não confirmado: não isolei o overhead do adaptador]. |
| 4 | Cancelamento | **[verificado, no Gemma]** `session/cancel` com 6 chunks já recebidos: o `session/prompt` respondeu `stopReason: "cancelled"` **103 ms** depois. Não repetido no flash-lite (ver acima). |
| 5 | `request_permission` e política | **[verificado]** **Sem config, o padrão é permitir tudo**: no Gemma, `edit` e `bash` rodaram sem nenhum `request_permission`. Com `OPENCODE_PERMISSION='{"edit":"ask","bash":"ask"}'` no ambiente do processo, o agente envia `session/request_permission` com `toolCall` (`kind` `edit` com `content` em diff e `rawInput`, ou `execute` com `rawInput.command`) e 3 opções: `once` (`allow_once`), `always` (`allow_always`) e `reject` (`reject_once`). Escolhendo `once` o arquivo foi criado; escolhendo `reject` o `tool_call` terminou `failed` e o turno fechou em `end_turn`. **`opencode.json` no `cwd`** com `"permission": {"bash": "deny", "edit": "allow"}`: nenhum `request_permission`; o `bash` deixou de existir para o modelo (a chamada virou "Invalid Tool", o comando não rodou e o modelo respondeu que não tinha `bash`). Ou seja, `deny` age retirando a ferramenta, não por recusa em tempo de execução [verificado, 1 execução]. `OPENCODE_CONFIG_CONTENT` aparece como string no binário, mas **não foi testado** [secundária]. |
| 6 | Retomada e armazenamento | **[verificado]** `session/load` em processo novo, mesmo `cwd`: 6,3 s; o histórico volta por replay (`user_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `agent_message_chunk`; o número 4242 gravado antes aparece no replay) e o contexto funciona (o modelo respondeu "4242"). A resposta do `load` traz só `configOptions`; o modelo escolhido voltou (`google/gemini-3.1-flash-lite`). `session/load` com **outro `cwd`** também funcionou; com `sessionId` inexistente dá `-32603 "OpenCode service failure"`. **`kill -9` de verdade no meio da tarefa** (`s4e`, 5 chunks já recebidos): o `session/prompt` pendente falhou com "ACP connection closed" (não houve `stopReason`); o filho `codebase-memory` morreu junto (sem órfãos). `session/load` depois disso funcionou, mas só voltou a mensagem do usuário e o raciocínio; **o texto parcial da resposta não foi persistido**. (Um primeiro teste, `s4c`, matou 2 s depois e a tarefa já tinha acabado: não vale como crash.) **Armazenamento**: um banco SQLite compartilhado em `~/.local/share/opencode/opencode.db` (+ `-wal` e `-shm`), ~6,68 GB no total, 417 sessões, ~2 milhões de linhas em `part` e 4,1 milhões em `event`; o conteúdo não foi lido. |
| 7 | Concorrência | **[verificado]** Ver subseção abaixo. **`processModel` = um processo `opencode acp` → N sessões.** 3 sessões simultâneas no mesmo processo, cada uma escrevendo na sua worktree, com IDs distintos. |
| 8 | Perfil isolado | **[verificado]** Com `XDG_DATA_HOME`, `XDG_CONFIG_HOME` e `OPENCODE_DB` apontando para pastas vazias na scratchpad: `opencode auth list` = "0 credentials"; o `initialize` funciona e lista o mesmo `opencode-login`; `opencode models` mostra só o provedor `opencode` (12 modelos `*-free`), nenhum `google`/`minimax`/`openai`/`openrouter` do dono; `session/list` devolve só a sessão recém-criada (não as 417 do dono). O processo criou seu próprio `opencode.db` (~250 KB, +WAL) e um `snapshot/` na pasta isolada. **Sem login nenhum, o `session/new` e um prompt funcionaram** (modelo padrão `opencode/big-pickle`, resposta "ok", 2 s): o OpenCode oferece modelos gratuitos do seu gateway sem chave [verificado localmente; limites e termos dessa oferta [não confirmado]]. Nenhum erro de autenticação ocorreu. |
| 9 | Catálogo (`opencode models --verbose`) | **[verificado]** 532 modelos. O campo `family` está **vazio ou ausente em 42** (opencode 1: `iceman-free`, minimax 1: `MiniMax-M3.1-Flash-Preview`, openrouter 40); 91 famílias distintas nos demais. Google 36, openai 36 e opencode 88 têm `family` em todos (menos o `iceman-free`). Consequência para o §5.7: `family` não pode ser tratado como obrigatório; precisa de valor padrão ou de fallback pelo id. Cada modelo traz também `variants` (os níveis de esforço) e janela de contexto. |

### Item 7: processos e RAM

Medido por `/proc` (árvore de filhos do `opencode acp`, RSS e PSS em MB, amostras a cada 500 ms), 3 worktrees, 1 prompt trivial (criar um arquivo) por sessão, todos disparados ao mesmo tempo. Cada sessão sobe um filho `codebase-memory-mcp` (~16 MB), por causa do MCP **do config do dono**; ele não faz parte do OpenCode e só existe com a sessão.

| Cenário | Sem sessão | 1 sessão | 3 sessões ociosas | Depois dos 3 prompts | Pico |
|---|---|---|---|---|---|
| A: 1 processo, 3 sessões | 252 RSS / 250 PSS (1 processo) | 337 / 328 (2 processos) | 401 / 377 (4 processos) | 717 / 691 (4 processos) | 835 / 763 (9 processos) |
| B: 3 processos, 1 sessão cada | 755 / 637 (3 processos) | ~340 cada | 1020 / 872 (6 processos) | 1520 / 1332 (6 processos) | 1652 / 1464 |

- Paralelismo real: no cenário A os 3 prompts levaram 18,5, 19,9 e 7,3 s e o tempo total foi 19,9 s (o do mais lento), logo rodaram juntos. No B, 13,5 s no total. Os arquivos caíram nas worktrees certas nos dois cenários [verificado].
- **RAM por sessão adicional (cenário A)**: ~50 MB de RSS por sessão ociosa (337 → 386 → 401, já com o filho MCP), e ~150 MB de RSS (PSS ~147) por sessão depois de rodar um prompt, mais o piso de ~250 MB do processo.
- **RAM por sessão (cenário B)**: ~340 MB ociosa e ~500 MB (PSS ~440) depois de rodar um prompt, porque cada processo paga o piso de ~250 MB.
- O custo por sessão em 1 processo é ~3 vezes menor que em 1 processo por sessão. O efeito do uso real (prompts longos, vários arquivos) [não confirmado]: o pico de 835 MB no cenário A mostra que a memória cresce durante o prompt e só parte volta.
- **Conclusão do `processModel`**: o OpenCode aceita várias sessões em um só processo, cada uma com seu `cwd`. Para o OTheater, isso permite 1 processo por conta/perfil com N sessões. O preço é que um crash derruba todas as sessões do processo (o `kill -9` do item 6 mata a árvore toda). A decisão entre "1 processo por sessão" e "1 por perfil" fica com o dono; os números acima são o insumo. Para contas diferentes é preciso 1 processo por perfil de qualquer jeito, pois o isolamento é por variáveis de ambiente do processo (item 8).

### Item 8 (permissões pelo ACP): bypass, `OPENCODE_CONFIG_CONTENT` e precedência (2026-11-15, UTC-3)

Script: `src/s7-bypass-and-config-precedence.ts` (`catalog` e `prec`). Saídas em `out/s7.catalog.json`, `out/s7.prec.json` e `out/s7-*.jsonl`. Modelo `google/gemini-3.1-flash-lite`, `opencode` 1.19.5, worktrees de teste na scratchpad; os `opencode.json` de teste foram criados e apagados pelo próprio script. Nada foi tocado em `~/.config/opencode` nem no `opencode serve` do dono.

**1. Catálogo de modos e opções do `opencode acp`** (`session/new`, sem prompt):

- **[verificado]** O `session/new` não traz o campo `modes`; só `configOptions`, com 3 itens: `model` (532 opções), `effort` (`none`, `thinking`, `default` no modelo padrão do dono) e `mode` com **dois valores, `build` e `plan`**. Não há modo nem opção de bypass, "yolo" ou "permitir tudo".
- **[verificado]** `session/set_mode` com `bypassPermissions`, `bypass`, `yolo`, `auto` e `allow-all` falhou com `Invalid params: mode not found`; `build` e `plan` funcionaram. `set_config_option` com `permission=allow` falhou com `unknown config option: permission`; `mode=bypass` falhou do mesmo jeito.
- **[verificado]** `opencode acp --help` (1.19.5) não tem flag de permissão. O `opencode run --help` tem `--auto` ("auto-approve permissions that are not explicitly denied (dangerous!)"). Ou seja, existe um bypass na CLI `run`, mas não no `acp`. Não testei o `--auto` (é outro comando, fora do ACP).
- **Conclusão para o `bypass: forbidden`**: pelo ACP, a sessão e o modelo **não têm como ligar "permitir tudo"**; o cliente também não. O único jeito de relaxar o que o daemon definiu é a configuração do processo (env, `opencode.json`), que o modelo pode tentar mexer **se tiver `edit` na worktree** (ver o item 3 abaixo). **[verificado]** o que existe; "isso basta para a RolePolicy `bypass: forbidden`" é inferência [não confirmado].

**2. `OPENCODE_CONFIG_CONTENT` e precedência** (5 prompts, tarefa `touch <caso>.txt` pelo `bash`, política do cliente `allow`; resultado de 1 execução por caso, estado final do arquivo conferido no disco):

| Caso | Configuração | Resultado |
|---|---|---|
| e1 | só `OPENCODE_CONFIG_CONTENT={"permission":{"bash":"deny","edit":"allow"}}` | `bash` sumiu: chamada virou "Invalid Tool", 0 `request_permission`, o modelo respondeu `NOBASH`, arquivo **não** criado. Igual ao `opencode.json` do cwd **[verificado]** |
| e2 | `opencode.json` do cwd `bash: allow` + `OPENCODE_CONFIG_CONTENT` `bash: deny` | `deny` vence: `bash` sumiu, arquivo não criado **[verificado]** |
| e3 | `opencode.json` do cwd `bash: allow` + `OPENCODE_PERMISSION` `{"bash":"deny"}` | `deny` vence: `bash` sumiu, arquivo não criado **[verificado]** |
| e4 | `OPENCODE_PERMISSION` `bash: allow` + `OPENCODE_CONFIG_CONTENT` `bash: deny` (as duas por env) | **`allow` vence**: o `bash` rodou (`ls -F` e `touch`), arquivo criado, 0 `request_permission` **[verificado]**. O `OPENCODE_PERMISSION` tem precedência sobre o `OPENCODE_CONFIG_CONTENT` |
| e5 | `opencode.json` do cwd `bash: deny` + `OPENCODE_DISABLE_PROJECT_CONFIG=1` | o `opencode.json` do cwd **foi ignorado**: o `bash` rodou, arquivo criado **[verificado]** |

- Ordem observada, do mais fraco ao mais forte: `opencode.json` do cwd < `OPENCODE_CONFIG_CONTENT` < `OPENCODE_PERMISSION`. Cada elo foi medido em par (e2, e3 e e4); a ordem completa é composição dessas três medidas, e a config global do dono (`~/.config/opencode`, que não li por regra) também estava ativa nos casos; se tiver `permission` próprio, ele pode ter influenciado [não confirmado].
- A documentação oficial de configuração (https://opencode.ai/docs/config/, lida em 2026-11-15) lista a precedência só entre arquivos (global, `opencode.json` da raiz, aninhados, `/etc/opencode/opencode.json` do sistema; "managed" acima de tudo) e **não cita** `OPENCODE_CONFIG_CONTENT`, `OPENCODE_PERMISSION` nem `OPENCODE_DISABLE_PROJECT_CONFIG` **[secundária: ausência na doc]**. Os nomes das três variáveis aparecem nas strings do binário **[secundária]**; o comportamento acima é o medido.
- A doc de permissões (https://opencode.ai/docs/permissions/, 2026-11-15) diz que, sem regra, o padrão é `ask`, e que `external_directory` vem **permitido** por padrão **[secundária]**. Isso **contradiz** o que medi no item 5 (sem config, `edit` e `bash` rodaram sem pedido). Vale o medido nesta máquina, com o `~/.config/opencode` do dono possivelmente influenciando [não confirmado].
- **Para o OTheater**: um `deny` posto pelo daemon só é firme se vier por `OPENCODE_PERMISSION` (vence as outras duas) e se `OPENCODE_DISABLE_PROJECT_CONFIG=1` impedir que um `opencode.json` plantado na worktree (por um agente com `edit`) o relaxe. O e2 mostra que o `OPENCODE_CONFIG_CONTENT` já vence o json do projeto, então o risco do json plantado só existe quando se usa só o json (e5 mostra que a variável o desliga). Um `allow` vindo de `OPENCODE_PERMISSION` num processo reaproveitado por outra role **vence** um `deny` em `OPENCODE_CONFIG_CONTENT` (e4): o env do processo precisa ser montado por role, nunca herdado.
- Não testado: `opencode.json` do cwd com `deny` e `OPENCODE_PERMISSION` com `allow` (só e4 testou o par de envs); granularidade `{"bash":{"*":"deny","git *":"allow"}}`; `/etc/opencode` (exigiria root); a variável `OPENCODE_TEST_MANAGED_CONFIG_DIR` (nome só visto em strings).
- Prompts: 5, com contador próprio (`out/prompt-count-item8.json`, 5 de 8). Somando os 24 anteriores, o spike passou de 25; o limite de 25 era do trabalho original e o item 8 tinha uma ordem própria de "poucas execuções".

## Pendências (não medidas neste spike)

- **Baton hand-off para outro cliente**: passar uma sessão do OpenCode a outro cliente ACP (ou outro executor) não foi testado. O `session/load` e o replay (item 6) são o que existe; o que se perde no crash também.
- **Segundo login**: não foi feito nenhum login (regra do spike). Como o OpenCode se comporta com duas contas do mesmo provedor num mesmo perfil, e o fluxo `opencode auth login` fora do ACP, ficam para depois.
- **Windows**: nada foi testado fora do Linux. É nele que `XDG_DATA_HOME`, `XDG_CONFIG_HOME` e `OPENCODE_DB` são o caso que a arquitetura pede; o item 8 só vale para Linux.
- `session/cancel` no flash-lite (item 4) e o overhead de latência do adaptador (item 3) também não foram medidos. O `OPENCODE_CONFIG_CONTENT` foi medido no item 8.
- Do item 8: o par `opencode.json` `deny` contra `OPENCODE_PERMISSION` `allow`, permissões granulares por padrão de comando, o `opencode run --auto` e o diretório do sistema `/etc/opencode`.

## Como rodar

```sh
cd spikes/acp-opencode
npm install
npx tsc -p .                       # checagem de tipos
node src/s1-session-mcp.ts         # itens 1, 2, 3 (1 prompt)
node src/s2-cancel.ts              # itens 3, 4 (1 prompt)
node src/s3-permissions.ts         # item 5 (4 prompts)
node src/s4-resume.ts              # item 6 (4 prompts); s4e-kill-midtask.ts: kill -9 real (1 prompt)
node src/s5-concurrency.ts         # item 7 (6 prompts)
node src/s6-isolated.ts            # item 8 (1 prompt)
# item 8 de permissões (contador próprio; exige as variáveis):
OT_COUNTER=$PWD/out/prompt-count-item8.json OT_MAX_PROMPTS=8 node src/s7-bypass-and-config-precedence.ts catalog   # sem prompt
OT_COUNTER=$PWD/out/prompt-count-item8.json OT_MAX_PROMPTS=8 node src/s7-bypass-and-config-precedence.ts prec      # 5 prompts
```

`OT_MODEL` troca o modelo (padrão `google/gemini-3.1-flash-lite`). `src/lib/budget.ts` bloqueia além de 25 prompts (contador em `out/prompt-count.json`); `OT_COUNTER` e `OT_MAX_PROMPTS` trocam o arquivo e o limite. Os caminhos da scratchpad ficam em `src/lib/paths.ts` e precisam ser ajustados em outra máquina; as worktrees são criadas à mão (`git worktree add`).

## Ferramentas

O LSP de TypeScript estava listado, mas falhou ao iniciar ("Could not find a valid TypeScript installation"; o TypeScript 7.0.2 do projeto não expõe o `tsserver` que ele procura). A verificação de tipos foi feita com `npx tsc -p .`.
