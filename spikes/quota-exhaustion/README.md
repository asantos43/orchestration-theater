# spikes/quota-exhaustion

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10, item "Retomada nativa"; §5.4 failover; §5.11 cotas): o que cada adaptador ACP faz quando a cota acaba **no meio da tarefa**, e se o `session/load` traz a conversa de volta depois.

Para provocar o erro de forma repetível, os três clientes (Claude Code, Codex, OpenCode) falam com um **mock local do provedor** (`src/mock.ts`), com uma chave **falsa** gerada a cada execução. Nenhum login foi feito, nenhuma credencial do dono foi lida e nenhuma chamada de modelo real foi paga.

Marcas usadas em todo o documento:

- **[V]** = verificado localmente, por execução nesta máquina em 2026-11-15 (UTC-3), com a saída bruta em `out/` (ignorada pelo git).
- **[S]** = fonte secundária: leitura de código instalado (não executado) ou de documentação.
- **[N]** = não confirmado, hipótese ou não medido.

Os termos de uso dos provedores **não** foram consultados. Nada aqui afirma o que o provedor permite ou cobra.

## O que foi medido, onde e com quê

| | |
|---|---|
| Data e hora | 2026-11-15, execuções entre 08:30 e 09:15 (UTC-3) |
| Máquina | AMD Eng Sample (Cezanne), 12 threads, 30 GB de RAM |
| Sistema | Fedora Linux 45, kernel 7.3.3-300.fc45.x86_64 |
| Node / TypeScript | v24.18.0 (TypeScript rodado direto, sem build) / 7.0.2 (`tsc --noEmit` passa) |
| `@agentclientprotocol/sdk` | 2.7.0 |
| `@agentclientprotocol/claude-agent-acp` | 0.107.0 (sobe um `claude` por sessão; UA `claude-cli/2.1.323`) |
| `@agentclientprotocol/codex-acp` | 2.6.0 (um `codex app-server`, codex 0.166.0 empacotado) |
| OpenCode | 1.19.5 (`opencode acp`, Bun 1.4.4 embutido) |
| Provedor | mock local, portas 47200 (Anthropic Messages), 47210 (OpenAI Responses), 47220 (chat completions) |
| Modelos | nomes do mock (`mock-1`; no Claude, o alias `haiku` com esforço `low`). Não há custo. |
| Chave | falsa (`sk-fake-quota-spike-<aleatório>`), gerada na hora, só por variável de ambiente |

Perfis isolados (nada de `~/.claude`, `~/.codex` nem `~/.config/opencode`; o `opencode serve` do dono na porta 4096 não foi tocado):

| Cliente | Como foi apontado para o mock |
|---|---|
| Claude | `CLAUDE_CONFIG_DIR` vazio + `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` falsa. Modo `default`, modelo `haiku`, esforço `low`. |
| Codex | `CODEX_HOME` vazio com `config.toml` próprio: provedor `mock` (`wire_api = "responses"`), chave em `MOCK_API_KEY` falsa. Valores de retentativa nos **padrões** do Codex. |
| OpenCode | `OPENCODE_CONFIG_CONTENT` com `@ai-sdk/openai-compatible` apontando para o mock; `XDG_*` e banco (`data/opencode.db`) numa pasta própria. |

Cada cenário apaga o perfil antes de começar, para que o texto parcial achado em disco venha só dele. Os perfis (`profiles/`) são gitignored e foram apagados no fim.

Todos os três clientes **aceitaram o provedor falso sem login** [V]. Nada precisou ser marcado como impossível.

Limite importante: só foi medida **chave de API falsa**. O comportamento com assinatura/OAuth (cabeçalhos `anthropic-ratelimit-unified-*` reais, `rate_limit_event`, `resetsAt`, janela de 5 h) pode ser diferente [N].

## Como o mock simula a cota

`src/mock.ts` fala três dialetos (Messages, Responses, chat completions) e executa um roteiro por requisição. Ações:

- `429` (corpo e cabeçalhos no estilo de cada provedor; com ou sem `retry-after`; `retry-after: 3600` para "volta em 1 h"; corpo genérico `rate_limit_exceeded` ou `insufficient_quota`);
- `tool` (o modelo pede uma ferramenta; a ferramenta roda de verdade no cliente);
- `cut` (stream cortado depois de 5 pedaços de texto `PARTE-01 PARTE-02 …`: evento de erro, `response.failed` ou conexão derrubada);
- `ok` (resposta normal) e `stall`.

| Cenário | O que acontece | Para que serve |
|---|---|---|
| `s1` | 429 antes do 1º token, `retry-after: 1`, sempre | item 4 (antes do 1º token) |
| `s1b`, `s1c` | o mesmo sem `retry-after` / com `retry-after: 3600` | efeito do cabeçalho |
| `s2`, `s2c` | uma ferramenta roda e a requisição seguinte leva 429 (`s2c`: `retry-after: 3600`) | cota acabando no meio da tarefa |
| `s3` / `s5` | stream cortado (erro `overloaded` / conexão derrubada) e a tentativa seguinte funciona | falha transitória |
| `s4` / `s6` | o mesmo corte, mas sempre | falha persistente |
| `s7` | corte com erro `rate_limit_error`, sempre | erro de cota no meio do stream |
| `s8` | ferramenta roda e a 2ª requisição é cortada, sempre | corte depois de trabalho feito |
| `s9` a `s11` | `response.failed` (`insufficient_quota`, `rate_limit_exceeded`, `server_is_overloaded`); só Codex | códigos do provedor da OpenAI |
| `s12`, `s13` | 429 genérico `rate_limit_exceeded` / `insufficient_quota` (estilo API da OpenAI); só Codex | idem |

Cada cenário roda em três fases, no mesmo repositório git de teste:

1. **P1**: um prompt que pede para ler `README.txt` (e responder `PARTE-…`), sob o roteiro. Mede o que chega pelo ACP.
2. **P2**: o mock volta ao normal e a **mesma sessão** recebe outro prompt (`Responda apenas: pronto.`).
3. **P3**: o adaptador é parado, outro processo sobe, faz `session/load` da mesma sessão e recebe um prompt que só uma sessão restaurada responde ("qual foi o meu primeiro pedido?"). O mock confere se o pedido P1 chegou no histórico enviado ao modelo.

## Resultado por item

### Item 1 — o que chega pelo ACP quando a cota acaba

429 antes do 1º token (`s1`, `s1b`) e cota acabando no meio da tarefa (`s2`, depois de uma ferramenta já executada). Sem a extensão tipada (cliente ACP "simples").

| | Claude (`claude-agent-acp`) | Codex (`codex-acp`) | OpenCode (`opencode acp`) |
|---|---|---|---|
| `stopReason` de P1 | **nenhum**: o `session/prompt` responde com erro JSON-RPC [V] | com `usage_limit_reached` / `insufficient_quota`: **nenhum** (erro JSON-RPC). Com 429 genérico `rate_limit_exceeded`: `end_turn` **sem erro** [V] | **nenhum**: erro JSON-RPC [V] |
| Erro JSON-RPC | `-32603` "Internal error: API Error: Request rejected (429) · …", `data.errorKind: "rate_limit"` [V] | `-32603`, `data.codexErrorInfo: "usageLimitExceeded"`, mensagem "You've hit your usage limit … try again at 9:31 AM" [V] | `-32603` "Internal error: <mensagem do provedor>", `data: {service: "session", errorName: "APIError"}` [V] |
| Texto do erro como `agent_message_chunk` | sim, 1 pedaço "API Error: Request rejected (429) …" [V] | sim ("You've hit your usage limit …"); no 429 genérico, só o aviso "Model metadata … not found" (artefato do modelo `mock-1`) [V] | não [V] |
| Cota estruturada (`usage_update`, `_meta`) | nenhuma. `usage_update` só aparece com tokens (meio da tarefa) [V]. `rateLimit.resetsAt` **não veio** com chave de API [V]; com assinatura [N] | nenhuma. `_meta.quota` só traz contagem de tokens. Horário de volta só **dentro do texto** ("9:31 AM", sem data, no relógio local) [V] | nenhuma. `usage_update` com `used: 0` [V] |
| Sinal extra | nenhum | `session_info_update._meta.codex.threadStatus.type = "systemError"` no fim; durante as retentativas, `_meta.codex.error {message: "Reconnecting… n/5", willRetry: true}` [V] | nenhum. Durante a espera de retentativa **não chega nada** [V] |
| Tentativas automáticas até desistir | 11 requisições (1 + 10), espera ≈ dobra: 1,0 / 1,2 / 2,2 / 4,8 / 9,8 / 18 / 37 / 34 / 39 / 36 s. **Ignora** `retry-after: 1` [V]. Com `retry-after: 3600`: 1 requisição, desiste em 0,3 s [V] | `usage_limit_reached` e `insufficient_quota`: 1 requisição, 0,25 a 0,87 s, **sem retentativa** [V]. 429 genérico `rate_limit_exceeded`: 6 requisições (1 + 5), 1,0 s entre elas [V] | 6 requisições (1 + 5). Com `retry-after: 1`: 1,0 / 1,1 / 1,0 / 2,4 / 1,5 s. Sem o cabeçalho: 2,5 / 4,7 / 9,9 / 17,7 / 39 s. Com `retry-after: 3600`: **espera sem limite visível** (1 requisição; nada chegou em 300 s) [V] |
| Tempo até P1 terminar | ver tabela de tempos abaixo | 0,3 s (cota) ou 5,3 s (429 genérico, 3 repetições) | 8,4 a 10,6 s (`retry-after: 1`), 75,6 s (sem cabeçalho), > 300 s (`retry-after: 3600`; cancelado por nós) |

Tempos (P1 até terminar), 3 repetições onde a espera é longa, em ms:

| Cenário | Claude | Codex | OpenCode |
|---|---|---|---|
| `s1` 429 antes do 1º token (`retry-after: 1`) | 183390 / 174343 / 182280 (11 req.) | 341 / 282 / 313 (1 req.) | 8790 / 8383 / 10643 (6 req.) |
| `s3` corte transitório (erro de stream) | 1004 (1 execução; 2 req.) | 2447 / 2681 / 2624 (2 req.) | 6829 / 7012 / 8465 (2 req.) |
| `s4` corte persistente (erro de stream) | 137237 / 146579 / 143490 (11 req.) | 10773 / 10255 / 9910 (6 req.) | 74950 / 69814 / 71780 (6 req.) |
| `s12` 429 genérico `rate_limit_exceeded` | — | 5329 / 5404 / 5361 (6 req.) | — |
| `s1b` 429 sem `retry-after` (1 execução) | 188472 (11 req.) | 375 (1 req.) | 75579 (6 req.) |
| `s1c` 429 com `retry-after: 3600` (1 execução) | 312 (1 req.) | 423 (1 req.) | 300076, cancelado por nós (1 req.) |
| `s2` 429 depois de uma ferramenta (1 execução) | 181874 (12 req.) | 534 (2 req.) | 12275 (7 req.) |
| Modo tipado `s1` / `s4` (1 execução) | 180984 / 139103 | 156 / 10442 | — |

A coluna do Codex em `s1` é o `usage_limit_reached` (sem retentativa). Com `s1b` e `s1c` o Codex também recebeu o corpo de `usage_limit_reached`, daí o mesmo comportamento.

### Item 2 — a sessão continua viva e aceita novo prompt?

**Sim, nos três clientes e em todos os cenários** [V]. O adaptador continuou vivo depois de P1 e a mesma sessão respondeu P2 (`pronto`) em 0,4 a 0,9 s quando o mock voltou ao normal.

- O pedido que falhou **continua no histórico**: a requisição de P2 ao modelo trazia o texto de P1 nos três [V].
- Nos cenários com ferramenta (`s2`, `s8`), a chamada e o resultado da ferramenta também ficam no histórico (Claude `assistant:tool_use` + `user:tool_result`; Codex `function_call` + `function_call_output`; OpenCode `assistant:tool_calls` + `tool`) [V]. O efeito colateral da ferramenta já aconteceu e não é desfeito.
- O texto **parcial** da resposta cortada não entra no histórico de P2 em nenhum cliente (a requisição seguinte não tinha mensagem `assistant`) [V].

### Item 3 — `session/load` em processo novo depois do erro

**Funciona nos três, em todos os cenários** [V] (inclusive depois de 429 e de corte no meio do stream). Tempo: Claude 0,8 a 2,0 s; Codex 0,09 a 0,56 s; OpenCode 0,57 a 1,7 s. No P3, o histórico enviado ao modelo trazia P1 e P2 nos três, então a conversa voltou [V].

O que cada um grava e repete no `session/load`:

| | Claude | Codex | OpenCode |
|---|---|---|---|
| Prompt que falhou (P1) | volta como `user_message_chunk` [V] | volta [V] | volta [V] |
| Texto de erro | **volta como mensagem do agente** ("API Error: Request rejected (429) …" ou "API Error: 529 …") [V] | não volta [V] | não volta [V] |
| Texto parcial de uma resposta que depois falhou (`s4` a `s8`) | **não é gravado**: a busca por `PARTE-05` nos arquivos do perfil não achou nada [V] | **não é gravado** no replay (só a resposta de P2 aparece) [V] | **é gravado** (`data/opencode.db`) e volta no replay: `PARTE-01 … PARTE-05` uma vez, antes da resposta de P2 [V] |
| Texto de uma resposta que **terminou bem** depois de retentativa (`s3`, `s5`) | gravado e repetido no replay [V] | repetido no replay [V] (a busca por arquivo achou o texto só em `s5`; use o replay, não a busca [N]) | gravado e repetido [V] |
| Ferramentas já executadas (`s2`, `s8`) | `tool_call` + `tool_call_update` no replay [V] | idem [V] | idem [V] |

### Item 4 — 429 antes do 1º token x corte no meio do stream

| | 429 antes do 1º token (`s1`) | Corte no meio, transitório (`s3`, `s5`) | Corte no meio, persistente (`s4`, `s6`, `s7`, `s8`) |
|---|---|---|---|
| Claude | erro `rate_limit`, 11 requisições, ~3 min | **recupera dentro do mesmo prompt**. Erro de stream: a 2ª tentativa é **sem stream** e traz o texto inteiro (`s3`, 1,0 s). Conexão derrubada: nova tentativa com stream, o texto parcial chega **duas vezes** (`s5`, 2,8 s) [V] | 11 a 12 requisições, 137 a 189 s. O texto parcial chega 1 vez (erro de stream, depois as tentativas são sem stream) ou 11 vezes (conexão derrubada). Erro final `server_error` (529); com `rate_limit_error` no stream o erro final é `rate_limit` (429) [V]. O texto do erro é anexado ao parcial ("PARTE-05 API Error: 529 …") |
| Codex | usage limit: erro `usageLimitExceeded` em 0,3 s, sem retentativa | recupera dentro do prompt, ~2,5 s; o parcial chega duas vezes [V] | 6 requisições, 10 a 11 s. O parcial chega **6 vezes** (32 pedaços). Termina com `end_turn` **sem erro** [V]. `response.failed` com `insufficient_quota` vira erro `usageLimitExceeded` (0,9 s, sem retentativa); `server_is_overloaded` vira `end_turn` sem retentativa (0,7 s); `rate_limit_exceeded` ("try again in 1.5s") faz 6 requisições espaçadas ~2,1 s (11,6 s) [V] |
| OpenCode | erro `APIError` depois de 6 requisições | recupera dentro do prompt, 6,8 a 8,5 s; o parcial chega duas vezes [V] | 6 requisições, ~70 a 75 s (1+5; esperas 3,3 / 6 / 10 / 18,6 / 30,6 s). Parcial chega 6 vezes. Erro `UnknownError` (stream cortado com erro) ou `APIError` ("Connection reset by server") [V] |

Observação: o erro do provedor no meio do stream **não** muda de classe no Claude por causa do tipo (`overloaded_error` ou `rate_limit_error`): as tentativas são as mesmas; só a requisição final sem stream decide o `errorKind` (ver Pendências sobre o mock).

### Extensão tipada de falhas (`sessionFailure`)

Descoberta durante o spike [S, lida no código dos adaptadores] e confirmada em execução [V]: se o cliente declara em `initialize` a capacidade

```json
{ "_meta": { "jetbrains": { "air": { "version": 1, "capabilities": ["sessionFailure"] } } } }
```

os adaptadores `claude-agent-acp` e `codex-acp` publicam uma falha **tipada** em `session/prompt` (`PromptResponse._meta.jetbrains.air.sessionFailure`) e em `session_info_update._meta`: `{id, revision, category, severity, title, details?, actions[]}`. O OpenCode **não tem** a extensão (a string `sessionFailure` não existe no binário 1.19.5 [S]; não foi testado com a capacidade declarada [N]).

Com a capacidade declarada, o `session/prompt` responde **`end_turn` mesmo na falha** (nada de erro JSON-RPC) e a falha vem em `_meta`:

| Situação | Claude (`category` / `actions`) | Codex (`category` / `actions`) |
|---|---|---|
| 429 de cota (usage limit) | `limit` / `["retry"]`; antes disso, 10 avisos `severity: warning` "Retrying Claude, attempt n of 10." com `details: "HTTP 429 (rate limited). Next attempt in 18s."` [V] | `limit` / `[]` (título com o texto "try again at 9:35 AM") [V] |
| `insufficient_quota` | — | `limit` / `[]` ("Quota exceeded…") [V] |
| 429 genérico `rate_limit_exceeded` | — | `limit` / `["retry"]` (`revision: 6`) [V] |
| `rate_limit_exceeded` em `response.failed` | — | `limit` / `["retry"]` [V] |
| Sobrecarga (`overloaded`, 529; `server_is_overloaded`) | `service` / `["retry"]`, avisos "attempt n of 9", `details: "HTTP 529 (overloaded)…"` [V] | `service` / `["retry"]` [V] |
| Conexão cortada / stream cortado | (`service`, ver `s4`) [V] | `service` / `["retry"]` ("stream disconnected before completion…") [V] |

Sem a capacidade, o Codex **fica calado** (`end_turn`, sem erro) em tudo que não é `usageLimitExceeded`. Nesse caso o aviso é `session_info_update._meta.codex.threadStatus.type = "systemError"` (e `_meta.codex.error` durante as retentativas). Atenção: o aviso "Model metadata for `mock-1` not found" (artefato do modelo falso) aparece como `notice` com `category: "unknown"`, `severity: "warning"`; filtre pelo `id` terminado em `:error`.

## Pendências (não medido)

- **Assinatura/OAuth.** Só chave de API falsa. Cabeçalhos reais `anthropic-ratelimit-unified-*`, `rate_limit_event`/`_claude/rateLimit` com `resetsAt`, janela de 5 h e `x-codex-*` reais não foram observados. O mock mandou esses cabeçalhos, mas o Claude com chave de API não repassou `resetsAt` [V]; com assinatura [N].
- **Mensagens reais do provedor.** O corpo dos erros é do mock (imitando o formato). O texto "You've hit your usage limit …" do Codex é do próprio cliente, mas disparado por um corpo imitado.
- **Mock no meio do stream.** Depois de um stream cortado, o Claude refaz a requisição **sem stream**; o mock responde 529 (e, desde a correção feita neste spike, 429 para `rate_limit_error`). O `s7` do Claude tem duas linhas em `out/claude-results.jsonl`: a primeira (anterior à correção) termina em 529; a segunda, em 429 `rate_limit`. As duas são citadas acima.
- **Tráfego para hosts reais.** Os clientes foram apontados para o mock, mas não monitorei se telemetria ou verificação de versão saem para a internet [N].
- **OpenCode com a capacidade `sessionFailure`.** Não testado (não há a extensão no binário [S]).
- **Cancelamento durante a espera de retentativa.** Só medido no OpenCode (`s1c`): `session/cancel` respondeu em 56 ms, com `stopReason: end_turn` (não `cancelled`). Claude e Codex [N].
- **Repetições.** 3 repetições só em `s1`, `s3`, `s4` (e `s12` no Codex). Os demais números de tempo vêm de 1 execução.
- **Processo que sobrevive ao `stop`.** `leftoverAfterStop` foi 1 em vários cenários do Claude e do Codex (um filho ainda vivo no instante da checagem, sem esperar). Não investiguei se é encerramento lento ou processo órfão [N]; os processos do spike foram confirmados parados no fim.
- **Failover entre contas.** Não testei `session/load` com **outro** perfil/conta nem em outro cliente (isso é do spike `acp-handoff`).
- **Janela de reset.** Nenhum cliente expôs o horário de volta de forma estruturada com chave de API; para assinatura [N].
- **Efeito de `retry-after` alto no Codex.** `retry-after` não foi variado nos erros 429 genéricos (só `1`).

## Consequências para o failover (§5.4)

**[proposta]**, a partir do que foi medido. Nada disso muda a arquitetura; é insumo para a decisão do dono.

1. **`stopReason` sozinho não diz que a cota acabou.** No Claude e no OpenCode o prompt termina com **erro JSON-RPC** (sem `stopReason`); no Codex sem a extensão tipada termina com `end_turn` **sem erro** (menos no usage limit); com a extensão tipada, os dois (Claude e Codex) terminam com `end_turn` e a falha vai em `_meta`. O daemon precisa olhar três canais em cada cliente, nesta ordem:
   - `PromptResponse._meta.jetbrains.air.sessionFailure` (Claude e Codex, só se o daemon declarar a capacidade no `initialize`);
   - erro JSON-RPC `-32603` e o seu `data` (`errorKind` no Claude, `codexErrorInfo` no Codex, `errorName` no OpenCode);
   - `session_info_update._meta.codex.threadStatus.type == "systemError"` no Codex, para o caso sem a capacidade.
2. **Declarar a capacidade `sessionFailure` para Claude e Codex.** Ela dá `category` (`limit` x `service` x `unknown`), `actions` e, no Claude, **um aviso a cada retentativa** (tentativa n de 10, espera até a próxima). Dá para agir cedo. Sem ela, o Claude fica ~3 min calado antes do erro.
3. **Não esperar o fim das retentativas internas.** Tempo até o erro (mock, chave de API): Claude ~3 min (429 e corte persistente), OpenCode 70 a 75 s (8 a 10 s com `retry-after: 1`), Codex 0,3 s (usage limit) a 11 s. Regra possível: ao primeiro aviso `category: limit` do Claude (0,5 s), ou ao primeiro `Reconnecting 1/5` do Codex, o daemon decide o failover e manda `session/cancel` (o cancelamento durante a espera respondeu em 56 ms no OpenCode).
4. **OpenCode precisa de relógio próprio.** Não há evento durante a espera, e com `retry-after` longo a espera passou de 300 s sem sinal. O daemon deve ter um limite de tempo sem nenhum `session/update` (ex.: 30 s) e tratar como "quase certo limite" [N: valor do limite não medido].
5. **O horário de volta não vem estruturado.** Claude (chave de API) não manda `resetsAt`; o Codex só traz "try again at 9:31 AM" no texto (sem data; relógio local); o OpenCode não traz nada. O daemon precisa do próprio relógio (janela do provedor configurada ou lida de outra fonte, como o `account/rateLimits` do Codex, spike `acp-codex`, item 8).
6. **Texto parcial se repete.** Em retentativa com stream, o mesmo trecho chega várias vezes (Claude até 11, Codex e OpenCode até 6). A tela e o log do daemon precisam descartar o que já recebeu naquele turno, ou marcar o turno como "interrompido".
7. **Trabalho já feito não é desfeito.** Nos cenários com ferramenta, a ferramenta rodou e o resultado ficou no histórico. No failover para outro Executor, o prompt novo deve dizer o que já foi feito (e o diff da worktree é a fonte da verdade), não repetir o pedido original às cegas.
8. **A mesma sessão serve depois da cota voltar.** Em todos os clientes, o P2 na mesma sessão funcionou quando o provedor voltou, e o `session/load` em processo novo trouxe a conversa (incluindo o pedido que falhou). Se o failover for **esperar** a janela e não trocar de conta, nada precisa ser recriado. Troca de conta/cliente: ver `acp-handoff` [N aqui].
9. **O Claude grava o erro como mensagem do agente.** Se o transcript do Claude for usado para entregar contexto a outro Executor, filtre as mensagens que começam com "API Error:" [V] (elas voltam no `session/load`).
10. **O que o daemon deve detectar em cada cliente** (resumo):

| | Cota/limite | Sobrecarga ou rede | Observação |
|---|---|---|---|
| Claude | `sessionFailure.category = limit` (tipado) ou erro `-32603` com `data.errorKind = "rate_limit"` | `category = service` ou `errorKind = "server_error"` | 3 min até o erro; avisos por tentativa só no modo tipado |
| Codex | erro `-32603` com `codexErrorInfo = "usageLimitExceeded"` (imediato) ou `category = limit` | `end_turn` + `threadStatus = "systemError"`, ou `category = service` | sem a capacidade, falhas de rede e `rate_limit_exceeded` **parecem sucesso** |
| OpenCode | erro `-32603` com `errorName = "APIError"` e texto de rate limit | `errorName = "UnknownError"` ou `APIError` com texto de conexão | sem `_meta`; distinguir só pelo texto [N: depende do provedor real] |

## Como rodar

```bash
cd spikes/quota-exhaustion
npm install --ignore-scripts
npx tsc --noEmit

# um cliente, vários cenários (o mock sobe na porta do cliente: 47200, 47210, 47220)
node src/run.ts claude   s1-429-first s4-cut-error-persistent
node src/run.ts codex    s1-429-first s9-failed-insufficient-quota s12-429-plain-rate-limit
node src/run.ts opencode s1-429-first s3-cut-error-transient

# extensão tipada de falhas (Claude e Codex) e repetições
QUOTA_TYPED=1 node src/run.ts codex s4-cut-error-persistent
QUOTA_REP=2   node src/run.ts opencode s1-429-first

# resumo legível e tempos
node src/summary.ts claude
node src/times.ts codex
```

Os cenários estão em `src/run.ts` (`SCENARIOS`). Tudo roda no repositório git de teste e nas worktrees `wt1` a `wt3`, na scratchpad da sessão (`<scratchpad>/quota-exhaustion/`). O Claude e o Codex rodam com permissão normal; nenhum modo irrestrito foi usado.

Cuidado: as execuções do Claude com 429 levam ~3 min cada; as do OpenCode, 70 a 75 s.

## Arquivos

| Arquivo | O que é |
|---|---|
| `src/mock.ts` | Mock do provedor (3 dialetos, roteiro por requisição, log JSONL sem cabeçalhos de autenticação) |
| `src/lib.ts` | Cliente ACP mínimo (`Adapter`), limpeza de ambiente, utilitários de `/proc`, máscara de dados sensíveis |
| `src/clients.ts` | Definição de Claude, Codex e OpenCode (perfil isolado, configuração do mock) |
| `src/run.ts` | Cenários e as três fases (P1, P2, P3); grava `out/<cliente>-results.jsonl` |
| `src/summary.ts`, `src/times.ts` | Resumo por cenário e tabela de tempos |
| `src/probe-*.ts` | Sondas usadas no início para descobrir como apontar cada cliente para o mock |
| `out/` | Saídas brutas (gitignorado): resultados, logs do mock, mensagens ACP por cenário |
