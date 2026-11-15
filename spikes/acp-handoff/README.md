# spikes/acp-handoff: passagem de bastão entre clientes ACP

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10 e §5.16). Código **descartável**. Mede a **passagem de bastão** (handoff), item que ficou pendente nos spikes [acp-claude](../acp-claude/README.md), [acp-codex](../acp-codex/README.md) e [acp-opencode](../acp-opencode/README.md):

1. continuar uma tarefa interrompida em **outro cliente**, por um pacote de continuação montado pelo harness (não pela memória do modelo);
2. retomar uma sessão ACP no **CLI do mesmo cliente** e o inverso (retomada nativa);
3. onde cada cliente guarda os arquivos de sessão e por quanto tempo.

Medido em 2026-11-15 (UTC-3), em duas rodadas (a rodada 1 é a primeira metade deste arquivo; a **Rodada 2** repete, amplia e corrige), uso pessoal, nas assinaturas do dono. Nenhum login foi feito, nenhuma credencial foi lida. Os arquivos de sessão do dono não foram abertos; só as sessões criadas pelo spike (e, para o item 3, metadados: contagem, datas e nomes de arquivo). Marcas: **[V]** verificado localmente, **[S]** fonte secundária (documentação), **[N]** não confirmado ou estimativa.

## Máquina e versões

| Item | Valor |
|---|---|
| Sistema | Fedora 45, kernel 7.3.3-300.fc45.x86_64, 12 núcleos [V] |
| Node | v24.18.0 (roda `.ts` direto) [V] |
| Claude Code / adaptador | 2.1.325 / `claude-agent-acp` 0.107.0 [V] |
| Codex / adaptador | codex-cli 0.169.0 / `codex-acp` 2.6.0 [V] |
| OpenCode | 1.19.5, `opencode acp` [V] |
| SDK ACP do cliente | `@agentclientprotocol/sdk` 2.7.0 [V] |
| Modelos (os mais baratos) | Claude `haiku`/low; Codex `gpt-6-luna`/low, modo `workspace-write`; OpenCode `google/gemini-3.1-flash-lite` [V] |

## A tarefa e como o harness mede

Repositório git de teste na scratchpad (worktree por tentativa), com `lib.mjs` e `lib.test.mjs` vazios. A tarefa é pequena e com estado verificável: 3 funções (`slugify`, `wordFreq`, `chunk`) mais testes, em **6 passos de uma edição de arquivo cada**, na ordem (função, testes, função, testes, ...), mais rodar os testes e responder `DONE`.

- **Interrupção**: o harness mata a árvore de processos do adaptador (SIGKILL, só descendentes do próprio PID, via `/proc`) quando há **3 ferramentas `edit` concluídas** [V].
- **Pacote**: montado por `src/package.ts` a partir de: as ordens (texto original), o diff da worktree contra o commit-base, e a trajetória capturada nos eventos ACP (arquivos lidos e editados, comandos com resultado, última mensagem do agente, ferramentas em voo). O progresso por passo é **calculado dos arquivos** (regex em `lib.mjs` e contagem de chamadas no teste), não vem do modelo [V].
- **Continuação**: nova worktree a partir do commit-ponto de controle, **sessão nova** em outro cliente, prompt = pacote.
- **Correção**: testes do próprio agente (`lib.test.mjs`) **e** 5 testes de aceitação escondidos (`fixtures/accept.test.mjs`), copiados só na avaliação. `ok` = os dois verdes **e** os 6 passos presentes.
- **Retrabalho**: linhas que a origem tinha adicionado e que sumiram do resultado final (`originLinesMissingInFinal`), e edições feitas além dos passos que faltavam.
- **Tamanho do pacote**: bytes e tokens estimados (caracteres/4) [N]; o `usage` real de cada resposta vem do adaptador.
- Duas variantes: **min** (cabeçalho + ordens + diff + instrução) e **full** (min + por que parou + progresso calculado + trajetória + o que falta).

## Resultado por item

### Item 1: bastão entre clientes pelo pacote [V]

Origem interrompida (1 execução por par):

| Par | Origem | Passos feitos ao matar (dos 6) | Edições concluídas | Tempo até matar |
|---|---|---|---|---|
| A | Claude → Codex | 3 | 3 | 14,6 s |
| B | Codex → OpenCode | 2 | 3 (uma não avançou nenhum passo) | 25,6 s |
| C | OpenCode → Claude | 2 (passos 2 e 3; o 1 faltou, fora de ordem) | 3 | 8,2 s |

Continuação (nova sessão no destino). "ok" exige testes próprios, aceitação 5/5 e 6 passos:

| Par | Pacote | Bytes (tokens est. [N]) | Tempo | ok | Testes próprios | Aceitação | Linhas da origem perdidas | Edições (faltavam) | Tokens totais do `usage` |
|---|---|---|---|---|---|---|---|---|---|
| A Claude→Codex | min | 3599 (899) | 26,2 s | sim | 11/11 | 5/5 | 0/24 | 3 (3) | 114 608 |
| A Claude→Codex | full | 4930 (1232) | 25,4 s | sim | 10/10 | 5/5 | 0/24 | 3 (3) | 112 204 |
| B Codex→OpenCode | min #1 | 3129 (782) | 184,4 s | **não** | 8/8 | 5/5 | **3/11** | 5 (4) | 22 396 |
| B Codex→OpenCode | min #2 | 3129 (782) | 45,3 s | **não** | 9/9 | **4/5** | 0/11 | 6 (4) | 24 720 |
| B Codex→OpenCode | full #1 | 4243 (1060) | 179,6 s | sim | 9/9 | 5/5 | 0/11 | 6 (4) | 26 011 |
| B Codex→OpenCode | full #2 | 4243 (1060) | 58,6 s | sim | 9/9 | 5/5 | 0/11 | 6 (4) | 23 595 |
| C OpenCode→Claude | min | 3107 (776) | 31,1 s | sim | 10/10 | 5/5 | 0/14 | 5 (4) | 350 961 |
| C OpenCode→Claude | full | 4156 (1038) | 26,6 s | sim | 7/7 | 5/5 | 0/14 | 4 (4) | 305 115 |

Leitura (com n muito pequeno: 1 execução por célula, 2 no par B; não é estatística):

- **Os três pares fecharam a tarefa** com a variante full: 4 de 4 execuções corretas. Com a min, 2 de 4 (as duas falhas foram no destino OpenCode/flash-lite). **[V]** nas execuções; a causa (pacote ou modelo fraco) é **[N]**: a falha do min #1 foi o destino reescrever os testes do passo 2 (3 linhas da origem perdidas); a do min #2 foi um `chunk` que não lança `RangeError` em todos os casos exigidos.
- **O que se perdeu**: no pacote min, o destino precisa deduzir o progresso lendo o diff, e o OpenCode errou nisso uma vez. No full, o checklist `[x]` calculado dos arquivos e a instrução "não refaça" evitaram a perda. Nenhuma execução full perdeu trabalho da origem.
- **Retrabalho**: Claude e Codex fizeram exatamente as edições que faltavam nos dois pacotes. Com o OpenCode como destino, mesmo o full fez 6 edições para 4 passos (correções após rodar testes). Claude como destino fez 1 edição a mais com o min e nenhuma com o full.
- **Custo do pacote**: full = +34% a +37% de bytes sobre o min (cerca de +1,1 KB, +260 a +330 tokens estimados). Desprezível diante do `usage` total das respostas (22 mil a 350 mil tokens, dominado por cache de leitura do prompt do sistema do cliente).
- **Tempo**: 25 a 31 s com Claude/Codex como destino. OpenCode como destino: 45 a 184 s, com muita variação entre execuções (45 s contra 184 s no mesmo pacote); o tempo do pacote em si (montagem) foi de 5 a 16 ms.
- O `usage` de OpenCode no ACP traz `outputTokens` = 3 em todas as execuções, o que não parece real; tratar o `usage` do OpenCode como **[N]**.
- A interrupção por SIGKILL do adaptador é limpa nos três: o spike não deixou processo órfão e o arquivo de worktree ficou consistente (as edições concluídas estão no disco; uma edição em voo pode ter ou não chegado) [V].

### Item 2: retomada nativa entre ACP e o CLI do mesmo cliente [V]

Sessão criada pedindo para guardar uma palavra-código aleatória; depois pergunta "qual foi a palavra?". 1 execução por célula.

| Cliente | ACP → CLI (retomada) | CLI → ACP (`session/load`) | Mesmo id de sessão | Contexto voltou |
|---|---|---|---|---|
| Claude | `claude -p --resume <sid>`: 11,2 s | CLI cria; ACP `session/load`: 3,6 s, 3 updates reproduzidos | sim | sim, nos dois sentidos |
| Codex | `codex exec resume <sid> --json`: 6,0 s | `session/load`: 1,6 s, 10 updates reproduzidos | sim | sim, nos dois sentidos |
| OpenCode | `opencode run -s <sid>`: 31,2 s | `session/load`: 8,3 s, 2 updates reproduzidos | sim | sim, nos dois sentidos |

- Os três adaptadores anunciam `loadSession: true` [V].
- O `session/load` **reproduz o histórico como `session/update`** antes de responder (`replayedUpdates` acima); o cliente ACP precisa descartar ou tratar esses eventos, senão a resposta ao follow-up vem concatenada com a mensagem reproduzida (vimos "OK" + palavra) [V].
- ~~A retomada é por `cwd`~~ **[corrigido na Rodada 2]**: a rodada 1 só testou o mesmo cwd e deduziu que o CLI teria de rodar nele. Medido depois, com cwd diferente, Claude e Codex retomam normalmente nos dois sentidos, e o OpenCode retoma por `session/load` mas o CLI `opencode run -s` trava (ver Rodada 2, item 4).
- Mesmo cliente, mesma conta: foi o que se testou. Retomar em **outro** cliente não é possível por este caminho (esse é o caso do item 1) [V].

### Item 3: onde ficam as sessões e quanto duram

| Cliente | Local | Retenção documentada | Observado (só metadados) |
|---|---|---|---|
| Claude | `~/.claude/projects/<cwd com não alfanuméricos trocados por ->/<sessionId>.jsonl` [V] | `cleanupPeriodDays`, padrão 30, mínimo 1 [S] | 422 arquivos; mais antigo por mtime = 2026-10-08 (38 dias), a chave não está no `settings.json` do dono [V]. Ultrapassa os 30 dias documentados; motivo não explicado (mtime vs criação, ou limpeza não ocorreu) [N] |
| Codex | `~/.codex/sessions/AAAA/MM/DD/rollout-<data-hora>-<sessionId>.jsonl` [V] | Nenhuma retenção de sessão documentada; há `history.max_bytes`, `history.persistence` e `memories.max_rollout_age_days` (outro assunto) [S] | 1004 arquivos; do 2026-09-05 (71 dias) ao dia de hoje, sem limpeza aparente [V] |
| OpenCode | SQLite `~/.local/share/opencode/opencode.db` (`OPENCODE_DB` muda o caminho) [S/V] | Nenhuma retenção documentada [S] | 428 sessões de 2026-07-11 a hoje; banco de ~6,6 GB [V] (consulta só de agregados, em modo somente leitura) |

Fontes (consultadas em 2026-11-15): https://code.claude.com/docs/en/claude-directory.md (`cleanupPeriodDays`), https://learn.chatgpt.com/docs/config-file/config-reference (Codex), https://opencode.ai/docs/troubleshooting/ (`opencode.db`, `OPENCODE_DB`).

Consequência de desenho: só o Claude tem expiração por padrão, e ela é curta o bastante para importar em retomadas de dias. Codex e OpenCode acumulam sem limite aparente. O OTheater não deve depender da sessão nativa para a continuação durável; o pacote com checkpoint e diff é a fonte da verdade, e a sessão nativa é só otimização de cache (arquitetura §5.16) [N: recomendação, decisão do dono].

## Rodada 2 (2026-11-15): repetições, três sentidos novos, modelo mais forte, `cwd` diferente

Objetivo: tirar o item 1 do n=1 e fechar o que a rodada 1 deixou em aberto. **Com n de 2 a 3 por célula continua não sendo estatística**: as execuções são na mesma máquina, no mesmo dia, contra serviços que variam (carga, cota), e o mesmo agente falha ou acerta por sorte. Tudo abaixo é **[V]** (medido aqui) salvo marca em contrário.

### Como foi feito (e o que mudou no método)

- **Origem reaproveitada.** O repositório de teste da rodada 1 tinha sido apagado da scratchpad, então os checkpoints das origens se perderam. `src/restore-origins.ts` os reconstruiu aplicando o diff gravado em `out/package-<par>-min.md` sobre um repositório novo (`out/origin-<par>.restored.json`) e conferiu que os pacotes min e full gerados são **idênticos byte a byte** aos gravados. As execuções r1 da rodada 1 usaram o checkpoint original; as repetições r2 e r3 usaram o restaurado (mesmo pacote, mesmo diff). O par B tem as duas primeiras execuções da rodada 1 como r1 e r2.
- **Segunda origem por par** (`origin2.sh`, sufixo "origem 2"): origem nova, também interrompida após 3 edições, para ver se o resultado depende do ponto de parada. A origem 2 do par B teve de ser refeita: na 1ª tentativa o Codex escreveu os arquivos por `cat <<EOF` no shell (ferramenta de tipo `execute`), o detector de `edit` não viu nenhuma edição, nunca matou e a origem terminou os 6 passos (guardada como `out/origin-codex-opencode-o2.try1.*`, descartada). **Achado [V]**: o detector de interrupção do spike depende do tipo `edit` da ferramenta; no Codex parte das escritas passa pelo shell. No produto, o progresso e a interrupção devem sair do estado dos arquivos (diff), não do tipo de ferramenta.
- **Escritas contadas incluem as feitas por shell** (marca † nas tabelas): `edits` do ACP mais comandos `execute` com heredoc, `>>`, `tee`, `sed -i` ou `apply_patch`. "Escritas a mais" = escritas menos os passos que faltavam (mínimo 0).
- **Dois fluxos em paralelo** (`rep3.sh`: X = destinos OpenCode, Y = destinos Claude/Codex) para caber no tempo. Isso carrega a máquina e a rede ao mesmo tempo, então **os tempos têm ruído extra**; comparar tempos entre células só em ordem de grandeza.
- **Vigia de 600 s** por execução (`cont.ts`) e `timeout` de 700 s no `rep3.sh`; ninguém estourou o vigia.
- **Execuções excluídas**: 2 execuções do Codex→OpenCode com `gemini-3.5-flash` na variante full (r2 e r3) falharam por **cota da API do Google** (erro "free tier ... limit: 20 ... per day", `usage` 0). São falha de infraestrutura, aparecem na tabela por execução como "excluída (cota)" e **não entram** nos agregados. Detalhe: a mensagem de erro cita `gemini-3.6-flash`, embora o log de fio mostre `google/gemini-3.5-flash` aplicado na sessão; por que o provedor cita outro nome é **[N]**. Não deu para repor: o erro diz para tentar de novo em cerca de 15 horas.
- Não foi aberto nenhum arquivo de sessão do dono, nenhuma credencial lida, e o `opencode serve` do dono (porta 4096) não foi tocado.

Convenção dos nomes: "Claude→Codex" etc. = origem→destino; "(origem 2)" = origem refeita; "(3.5-flash)" = destino OpenCode com `google/gemini-3.5-flash` em vez do padrão `google/gemini-3.1-flash-lite`. Os pares A, B e C da rodada 1 são Claude→Codex, Codex→OpenCode e OpenCode→Claude.

### Todas as execuções da continuação (rodada 1 e rodada 2)

"Escritas (faltavam)" = escritas feitas pelo destino e, entre parênteses, passos que faltavam. "Linhas perdidas" = linhas que a origem adicionou e sumiram do resultado; **conta também reescrita textual equivalente** (reformatação), não só perda funcional [N: a separação não foi automatizada].

| Par | Variante | Execução | ok | Próprios | Aceitação | Passos | Tempo | Linhas perdidas | Escritas (faltavam) | Tokens do usage |
|---|---|---|---|---|---|---|---|---|---|---|
| Claude→Codex (origem 2) | full | r1 | sim | 9/9 | 5/5 | 6/6 | 21,4 s | 0/25 | 3 (3) | 116749 |
| Claude→Codex (origem 2) | full | r2 | sim | 9/9 | 5/5 | 6/6 | 28,3 s | 0/25 | 1† (3) | 159172 |
| Claude→Codex (origem 2) | min | r1 | **não** | 8/9 | 5/5 | 6/6 | 27,9 s | 0/25 | 4 (3) | 134962 |
| Claude→Codex (origem 2) | min | r2 | sim | 9/9 | 5/5 | 6/6 | 15,7 s | 0/25 | 2† (3) | 56867 |
| Claude→Codex | full | r1 | sim | 10/10 | 5/5 | 6/6 | 25,4 s | 0/24 | 3 (3) | 112204 |
| Claude→Codex | full | r2 | sim | 10/10 | 5/5 | 6/6 | 22,3 s | 0/24 | 3 (3) | 117217 |
| Claude→Codex | full | r3 | sim | 10/10 | 5/5 | 6/6 | 24,5 s | 0/24 | 4 (3) | 119846 |
| Claude→Codex | min | r1 | sim | 11/11 | 5/5 | 6/6 | 26,2 s | 0/24 | 3 (3) | 114608 |
| Claude→Codex | min | r2 | **não** | 4/4 | 0/5 | 3/6 | 4,7 s | 0/24 | 0 (3) | 18243 |
| Claude→Codex | min | r3 | **não** | 9/10 | 5/5 | 6/6 | 20,1 s | 0/24 | 2 (3) | 114844 |
| Claude→OpenCode | full | r1 | sim | 10/10 | 5/5 | 6/6 | 232,5 s | 0/24 | 5 (3) | 24001 |
| Claude→OpenCode | full | r2 | sim | 9/9 | 5/5 | 6/6 | 16,2 s | 2/24 | 3 (3) | 20594 |
| Claude→OpenCode | min | r1 | sim | 10/10 | 5/5 | 6/6 | 78,9 s | 0/24 | 5 (3) | 22533 |
| Claude→OpenCode | min | r2 | sim | 10/10 | 5/5 | 6/6 | 88,6 s | 0/24 | 4 (3) | 21712 |
| Codex→Claude | full | r1 | sim | 9/9 | 5/5 | 6/6 | 18,2 s | 0/11 | 4 (4) | 304497 |
| Codex→Claude | full | r2 | sim | 9/9 | 5/5 | 6/6 | 19,1 s | 0/11 | 4 (4) | 305538 |
| Codex→Claude | min | r1 | sim | 9/9 | 5/5 | 6/6 | 18,2 s | 0/11 | 4 (4) | 301032 |
| Codex→Claude | min | r2 | sim | 9/9 | 5/5 | 6/6 | 19,2 s | 0/11 | 4 (4) | 301630 |
| Codex→OpenCode (3.5-flash) | full | r1 | sim | 9/9 | 5/5 | 6/6 | 48,7 s | 0/11 | 4 (4) | 21940 |
| Codex→OpenCode (3.5-flash) | full | r2 | excluída (cota) | 3/3 | 0/5 | 3/6 | 80,9 s | 0/11 | 1 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (3.5-flash) | full | r3 | excluída (cota) | 3/3 | 0/5 | 2/6 | 75,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (3.5-flash) | min | r1 | sim | 9/9 | 5/5 | 6/6 | 18,3 s | 0/11 | 4 (4) | 21604 |
| Codex→OpenCode (3.5-flash) | min | r2 | sim | 9/9 | 5/5 | 6/6 | 60,3 s | 0/11 | 4 (4) | 21613 |
| Codex→OpenCode (origem 2) | full | r1 | sim | 9/9 | 5/5 | 6/6 | 17,0 s | 0/15 | 3 (3) | 21894 |
| Codex→OpenCode (origem 2) | full | r2 | sim | 9/9 | 5/5 | 6/6 | 83,1 s | 0/15 | 3 (3) | 21331 |
| Codex→OpenCode (origem 2) | min | r1 | sim | 8/8 | 5/5 | 6/6 | 197,5 s | 0/15 | 6 (3) | 26213 |
| Codex→OpenCode (origem 2) | min | r2 | sim | 9/9 | 5/5 | 6/6 | 27,6 s | 0/15 | 3 (3) | 21859 |
| Codex→OpenCode | full | r1 | sim | 9/9 | 5/5 | 6/6 | 179,6 s | 0/11 | 6 (4) | 26011 |
| Codex→OpenCode | full | r2 | sim | 9/9 | 5/5 | 6/6 | 58,6 s | 0/11 | 6 (4) | 23595 |
| Codex→OpenCode | full | r3 | **não** | 8/8 | 4/5 | 5/6 | 86,6 s | 0/11 | 5 (4) | 25103 |
| Codex→OpenCode | min | r1 | **não** | 8/8 | 5/5 | 5/6 | 184,4 s | 3/11 | 5 (4) | 22396 |
| Codex→OpenCode | min | r2 | **não** | 9/9 | 4/5 | 6/6 | 45,3 s | 0/11 | 6 (4) | 24720 |
| Codex→OpenCode | min | r3 | sim | 9/9 | 5/5 | 6/6 | 106,0 s | 0/11 | 8 (4) | 24514 |
| OpenCode→Claude (origem 2) | full | r1 | sim | 10/10 | 5/5 | 6/6 | 23,5 s | 1/21 | 4 (3) | 359694 |
| OpenCode→Claude (origem 2) | full | r2 | sim | 9/9 | 5/5 | 6/6 | 17,4 s | 0/21 | 3 (3) | 261026 |
| OpenCode→Claude (origem 2) | min | r1 | sim | 9/9 | 5/5 | 6/6 | 20,1 s | 0/21 | 3 (3) | 260449 |
| OpenCode→Claude (origem 2) | min | r2 | sim | 9/9 | 5/5 | 6/6 | 19,8 s | 0/21 | 3 (3) | 261287 |
| OpenCode→Claude | full | r1 | sim | 7/7 | 5/5 | 6/6 | 26,6 s | 0/14 | 4 (4) | 305115 |
| OpenCode→Claude | full | r2 | sim | 7/7 | 5/5 | 6/6 | 18,7 s | 0/14 | 4 (4) | 305311 |
| OpenCode→Claude | full | r3 | sim | 3/3 | 5/5 | 6/6 | 23,6 s | 3/14 | 5 (4) | 398165 |
| OpenCode→Claude | min | r1 | sim | 10/10 | 5/5 | 6/6 | 31,1 s | 0/14 | 5 (4) | 350961 |
| OpenCode→Claude | min | r2 | sim | 9/9 | 5/5 | 6/6 | 24,5 s | 0/14 | 5 (4) | 353592 |
| OpenCode→Claude | min | r3 | sim | 8/8 | 5/5 | 6/6 | 30,3 s | 3/14 | 5 (4) | 407420 |
| OpenCode→Codex | full | r1 | sim | 3/3 | 5/5 | 6/6 | 23,1 s | 0/14 | 4 (4) | 111101 |
| OpenCode→Codex | full | r2 | sim | 7/7 | 5/5 | 6/6 | 20,8 s | 0/14 | 4 (4) | 57518 |
| OpenCode→Codex | min | r1 | sim | 3/3 | 5/5 | 6/6 | 18,9 s | 5/14 | 1† (4) | 56146 |
| OpenCode→Codex | min | r2 | **não** | 0/1 | 0/5 | 2/6 | 3,4 s | 0/14 | 0 (4) | 18087 |

### Agregado por célula (par x variante x modelo)

| Par | Variante | n | ok em n | Mediana do tempo | Faixa do tempo | Linhas perdidas (soma) | Escritas a mais (soma; por execução) | Pacote (bytes) |
|---|---|---|---|---|---|---|---|---|
| Claude→Codex (origem 2) | full | 2 | 2 de 2 | 24,8 s | 21,4 a 28,3 s | 0 | 0 (0, 0) | 4629 |
| Claude→Codex (origem 2) | min | 2 | 1 de 2 | 21,8 s | 15,7 a 27,9 s | 0 | 1 (1, 0) | 3600 |
| Claude→Codex | full | 3 | 3 de 3 | 24,5 s | 22,3 a 25,4 s | 0 | 1 (0, 0, 1) | 4930 |
| Claude→Codex | min | 3 | 1 de 3 | 20,1 s | 4,7 a 26,2 s | 0 | 0 (0, 0, 0) | 3599 |
| Claude→OpenCode | full | 2 | 2 de 2 | 124,4 s | 16,2 a 232,5 s | 2 | 2 (2, 0) | 4930 |
| Claude→OpenCode | min | 2 | 2 de 2 | 83,8 s | 78,9 a 88,6 s | 0 | 3 (2, 1) | 3599 |
| Codex→Claude | full | 2 | 2 de 2 | 18,6 s | 18,2 a 19,1 s | 0 | 0 (0, 0) | 4243 |
| Codex→Claude | min | 2 | 2 de 2 | 18,7 s | 18,2 a 19,2 s | 0 | 0 (0, 0) | 3129 |
| Codex→OpenCode (3.5-flash) | full | 1 | 1 de 1 | 48,7 s | 48,7 a 48,7 s | 0 | 0 (0) | 4243 |
| Codex→OpenCode (3.5-flash) | min | 2 | 2 de 2 | 39,3 s | 18,3 a 60,3 s | 0 | 0 (0, 0) | 3129 |
| Codex→OpenCode (origem 2) | full | 2 | 2 de 2 | 50,1 s | 17,0 a 83,1 s | 0 | 0 (0, 0) | 4654 |
| Codex→OpenCode (origem 2) | min | 2 | 2 de 2 | 112,6 s | 27,6 a 197,5 s | 0 | 3 (3, 0) | 3415 |
| Codex→OpenCode | full | 3 | 2 de 3 | 86,6 s | 58,6 a 179,6 s | 0 | 5 (2, 2, 1) | 4243 |
| Codex→OpenCode | min | 3 | 1 de 3 | 106,0 s | 45,3 a 184,4 s | 3 | 7 (1, 2, 4) | 3129 |
| OpenCode→Claude (origem 2) | full | 2 | 2 de 2 | 20,5 s | 17,4 a 23,5 s | 1 | 1 (1, 0) | 4791 |
| OpenCode→Claude (origem 2) | min | 2 | 2 de 2 | 20,0 s | 19,8 a 20,1 s | 0 | 0 (0, 0) | 3415 |
| OpenCode→Claude | full | 3 | 3 de 3 | 23,6 s | 18,7 a 26,6 s | 3 | 1 (0, 0, 1) | 4156 |
| OpenCode→Claude | min | 3 | 3 de 3 | 30,3 s | 24,5 a 31,1 s | 3 | 3 (1, 1, 1) | 3107 |
| OpenCode→Codex | full | 2 | 2 de 2 | 22,0 s | 20,8 a 23,1 s | 0 | 0 (0, 0) | 4156 |
| OpenCode→Codex | min | 2 | 1 de 2 | 11,1 s | 3,4 a 18,9 s | 5 | 0 (0, 0) | 3107 |

"ok em n" exige testes do próprio agente verdes, aceitação 5/5 e 6 passos. O tempo é a mediana, com a faixa ao lado. As execuções "excluída (cota)" não entram.

### Leitura (item 1: repetições e sentidos novos)

- **A leitura da rodada 1 ("full 4/4, min 2/4") não se sustenta com mais execuções.** Somando as duas rodadas (9 combinações de origem→destino, 21 execuções por variante), sem as de `gemini-3.5-flash`: **full 20 de 21, min 15 de 21**. A direção ainda é "full >= min", mas a diferença é bem menor do que parecia, e o que a causa mudou:
  - por **destino**: Claude min 7/7, full 7/7; **Codex min 3/7, full 7/7**; OpenCode/flash-lite min 5/7, full 6/7;
  - o Codex é onde a variante pesa: 4 falhas em 7 com o min, 0 em 7 com o full (Fisher bilateral ≈ 0,07, calculado aqui; **[N]**: n pequeno, execuções não independentes). Dessas 4 falhas, **2 foram recusa do Codex** ("workspace outside the writable roots", 0 ferramentas, 3 a 5 s) e 2 foram testes do próprio agente vermelhos (9/10 e 8/9) com a aceitação 5/5. O pacote e a configuração das recusas eram idênticos aos de execuções que funcionaram; a recusa parece estocástica **[N]**, e só apareceu com o min (2 de 7 contra 0 de 7 com o full), o que pode ser acaso;
  - no **OpenCode/flash-lite**, as 3 falhas (full r3, min r1, min r2) são todas do **mesmo par B, origem 1** (Codex com 2 passos feitos e 1 edição que não avançou nada). Nas outras 8 execuções com destino OpenCode (Claude→OpenCode e a origem 2 do par B, min e full), **0 falhas**. Então parte do que a rodada 1 atribuiu ao "destino fraco" pode ser da origem difícil (progresso fora de ordem/parcial), não só do modelo **[N]**. O full também falhou uma vez aqui (r3: aceitação 4/5, 5 de 6 passos), o que a rodada 1 não tinha visto.
- **Retrabalho.** Claude como destino fez exatamente as edições que faltavam em 9 de 14 execuções (4 de 4 no Codex→Claude); nas outras 5 fez 1 a mais. Codex fez as que faltavam na maioria, mas em 3 execuções escreveu por shell (†). OpenCode/flash-lite faz mais escritas que o necessário com frequência (até 8 para 4 passos), é o destino que "corrige depois de rodar os testes".
- **Perda de linhas**: perda funcional real só no Codex→OpenCode min r1 (3 de 11: testes do passo 2 reescritos). As demais "perdas" (Claude→OpenCode full r2: 2; OpenCode→Claude r3: 3 e 3; OpenCode→Claude origem 2 full r1: 1; OpenCode→Codex min r1: 5 de 14) são reescritas textuais com aceitação 5/5 (no OpenCode→Codex min r1 o Codex reescreveu `lib.mjs` inteiro com `cat >`).
- **Tempo**: Claude e Codex como destino ficam em 16 a 28 s, estáveis entre repetições. OpenCode como destino varia muito no mesmo pacote (16 a 232 s no Claude→OpenCode full), então qualquer decisão de agendamento não pode contar com tempo estável do OpenCode/flash-lite.
- **Direções novas** (n=2 por célula): Codex→Claude 4 de 4 corretas, 0 linhas perdidas, edições exatas, ~18 s; Claude→OpenCode 4 de 4 (lentas, 16 a 232 s); OpenCode→Codex full 2 de 2, min 1 de 2 (a falha foi a recusa de "writable roots"). Todas as 6 direções entre os 3 clientes já têm pelo menos uma execução correta com o full.
- **Custo do pacote** inalterado: full = +34% a +37% de bytes sobre o min (cerca de +1,1 KB).

### Item 3: destino OpenCode com modelo mais forte (Codex→OpenCode, origem 1)

Modelo: `google/gemini-3.5-flash`, escolhido na lista de `opencode models` (mesmo provedor `google/` do padrão, sem provedor novo nem login), via `OT_MODEL`. **Mais forte que o flash-lite: suposição pelo nome [N]. "Mais barato": o preço não foi verificado [N].**

| Modelo do destino | Variante | Válidas | ok | Tempo | Escritas (faltavam 4) |
|---|---|---|---|---|---|
| flash-lite (padrão) | min | 3 | 1 de 3 | 45 a 184 s | 5, 6, 8 |
| flash-lite (padrão) | full | 3 | 2 de 3 | 59 a 180 s | 5, 6, 6 |
| 3.5-flash | min | 2 | **2 de 2** | 18,3 e 60,3 s | 4 e 4 |
| 3.5-flash | full | 1 (2 excluídas por cota) | 1 de 1 | 48,7 s | 4 |

Nas 3 execuções válidas com o 3.5-flash: todas corretas, 0 linhas perdidas e **exatamente as 4 escritas que faltavam**, nos dois pacotes. Na mesma origem com o flash-lite, 3 de 6 falharam e as escritas passaram de 4 em todas. Leitura: é compatível com "o modelo de destino pesa mais que o formato do pacote" neste par, mas n=3 válidas não prova nada, e o full ficou com n=1 por causa da cota **[N]**. A cota diária do tier grátis (20 requisições por dia, segundo o erro) também sugere que esse modelo, nesta conta, não sustenta uso contínuo no tier grátis **[N]**.

### Item 4: retomada nativa com `cwd` diferente

1 execução por célula de repetição, 2 para o OpenCode (rodada com 180 s e rodada com 400 s). O novo cwd é uma worktree irmã do repositório (`wt`) ou uma pasta fora de qualquer repositório (`plain`). A: ACP cria, CLI retoma no novo cwd. B: CLI cria, ACP `session/load` com o novo cwd. Controle do OpenCode: mesmo cwd.

| Cliente | cwd novo | A: ACP → CLI | B: CLI → ACP (`session/load`) |
|---|---|---|---|
| Claude | wt | `claude -p --resume`: 5,8 s, **contexto voltou** | 1,8 s, 3 updates reproduzidos, **voltou** |
| Claude | plain | 5,3 s, **voltou** | 1,9 s, 3 updates, **voltou** |
| Codex | wt | `codex exec resume`: 5,6 s, **voltou** | 0,75 s, 10 updates, **voltou** |
| Codex | plain | 3,8 s, **voltou** | 0,56 s, 10 updates, **voltou** |
| OpenCode | wt | `opencode run -s <id> --dir <novo>`: **travou** (180 s e 400 s, sem saída, morto pelo timeout), contexto **não** voltou | 5,0 s, 2 updates, **voltou** |
| OpenCode | plain | **travou** (180 s e 400 s) | 4,8 s, 3 updates, **voltou** |
| OpenCode | mesmo cwd (controle) | 18 s, **voltou** | (rodada 1: 8,3 s, voltou) |

- **Claude e Codex**: o cwd diferente **não impede a retomada**, com o mesmo id de sessão, nos dois sentidos [V]. No Claude, o arquivo da sessão continua só na pasta derivada do cwd original (um arquivo por id de sessão; sem cópia na pasta do cwd novo) [V], então a retomada acha a sessão por id, não pelo cwd. **Isso contradiz o que a rodada 1 deduziu**; a linha foi corrigida acima.
- **OpenCode**: `session/load` com cwd diferente funciona; o **CLI** `opencode run -s` com `--dir` diferente **não termina** (4 de 4 tentativas; o controle com o mesmo cwd terminou em 18 s). Uma sonda separada com `--print-logs` mostrou o laço do agente terminando em ~10 s (`exiting loop`) e o processo continuando vivo sem escrever nada em stdout (também com stdout em arquivo, 70 s). O log mostra que o OpenCode abre instâncias para os **dois** diretórios (o `--dir` novo e o cwd original da sessão). A causa exata é **[N]**. Para o OTheater, o caminho seguro é o `session/load` pelo ACP.
- O `session/load` reproduz o histórico como `session/update` antes de responder, como na rodada 1 (1 a 2 mensagens antes do follow-up); o cliente precisa descartá-lo.
- Observação: o ACP do OpenCode anuncia (`available_commands_update`) comandos vindos de skills do ambiente do dono; é só o que o cliente expõe, nada foi lido além do fio ACP.

### O que NÃO foi rodado ou ficou incompleto na Rodada 2

- `gemini-3.5-flash` full: só 1 execução válida (2 excluídas por cota diária do tier grátis; reposição bloqueada por cerca de 15 horas).
- Origem 2 só tem n=2 por célula; origem 3 e tarefas maiores não foram feitas.
- Nenhum modelo mais forte para os destinos Claude e Codex (usaram o modelo mais barato de sempre), então "destino fraco" só foi separado no OpenCode.
- Retomada nativa com sessões antigas (pós-retenção): não testada.

## Formato do pacote de continuação **[proposta]**

Baseado no que funcionou melhor (variante full: 20 de 21 execuções corretas nas duas rodadas, ver Rodada 2; na rodada 1 eram 4 de 4). Seções nesta ordem; tudo gerado pelo harness a partir do que registrou, nada da memória do modelo:

1. **Cabeçalho**: quem é você, que não vê a conversa anterior, e que os arquivos do cwd já têm o trabalho feito.
2. **Demanda, contrato e ordens**, texto original, ainda em vigor.
3. **Estado da worktree**: id do commit-base, id do checkpoint e o diff contra o base (bloco `diff`).
4. **Por que parou**: motivo estruturado (processo morto, cota esgotada, limite de contexto, política), dizendo que não é falha da tarefa.
5. **Progresso calculado**: checklist `[x]/[ ]` obtido dos arquivos ou dos testes pelo harness (detector determinístico, §5.16). É o campo que mais protegeu contra retrabalho.
6. **Trajetória registrada** (eventos ACP): arquivos lidos, arquivos editados, comandos e testes com resultado e saída curta, última mensagem do agente, decisões já respondidas, ferramentas em voo (efeito incerto).
7. **Efeitos colaterais já executados** (commit, push, chamadas externas) para que o destino não os repita. Neste spike não houve efeitos externos; **[N]** o campo não foi exercitado.
8. **O que falta**, derivado do checklist.
9. **Instrução final**: "continue deste estado; não refaça o que está marcado como concluído; não reescreva código anterior sem um teste que prove o erro".

Notas: os caminhos absolutos do cwd de origem devem ser normalizados para relativos (feito em `package.ts`); o tamanho foi de ~1,0 a 1,2 mil tokens estimados para esta tarefa pequena, e cresce com o diff e com os comandos, então o resumo de trajetória precisa de teto (aqui: comando 120 caracteres, saída 160, mensagem 400) **[N: tetos ainda sem teste com tarefas grandes]**. A variante min (itens 1 a 3 mais a instrução) bastou para o Claude como destino (7 de 7), mas foi pior com o Codex (3 de 7) e com o OpenCode/flash-lite (5 de 7) (Rodada 2); usá-la como padrão seria apostar no destino.

## Pendências (não medido)

- **Estatística**: n de 2 a 3 por célula, uma tarefa pequena (6 passos), uma máquina. Faltam mais repetições e tarefas maiores, com mais passos e diffs grandes. Qualquer proporção acima é indicativa, não estatística.
- **Origem versus destino no OpenCode**: as 3 falhas do flash-lite foram na mesma origem (par B, origem 1). Separar efeito da origem e do modelo pedindo mais origens "difíceis" (progresso fora de ordem) e o 3.5-flash com n maior (a cota diária do tier grátis impediu).
- **Codex com o min**: recusas "writable roots" (2 de 7) e testes próprios vermelhos (2 de 7). Falta saber se a recusa depende do pacote, do modo `workspace-write` ou do acaso, e se vale mandar sempre o full para o Codex.
- **Interrupção por cota ou contexto**: aqui foi SIGKILL após N edições. O caso real (cota esgotada, ver spike `quota-exhaustion`) e o pacote com "por que parou" real não foram combinados. O detector de edições por tipo de ferramenta é cego a escritas por shell (Codex); o produto deve medir pelo diff.
- **Efeitos colaterais externos** e **decisões respondidas** (campos 6 e 7 da proposta): não exercitados.
- **Retomada nativa**: sessões antigas (pós-retenção) não testadas; CLI do OpenCode com `--dir` diferente trava (causa **[N]**).
- **Troca de cliente mantendo o cache de prompt**: não aplicável entre clientes; o `usage` mostra que o prompt do sistema domina o custo (cache de leitura).
- `usage` de OpenCode (`outputTokens` = 3) não confiável [N].
- Retenção real do Claude acima do documentado (38 dias contra 30): causa não investigada.
- Preço do `gemini-3.5-flash` frente ao flash-lite: não verificado [N].


## Como rodar

Requer os `node_modules` dos spikes irmãos `acp-claude` e `acp-codex` (os adaptadores são lidos de lá) e os clientes instalados e logados.

```
cd spikes/acp-handoff && npm install --ignore-scripts
node src/origin.ts <claude|codex|opencode> <par> [N=3]      # roda a origem e mata após N edições
node src/cont.ts <cliente-destino> <par> <min|full>          # monta o pacote e continua em sessão nova
node src/reeval.ts cont-<par>-<variante>                     # reavalia uma worktree já terminada
node src/native.ts <cliente> [A|B|AB]                        # item 2 (A: ACP->CLI, B: CLI->ACP)
./src/run-all.sh                                             # os três pares do item 1 em sequência
SCRATCH=<pasta> ./src/rep2.sh                                # 2ª repetição do par B (rodada 1)
# Rodada 2 (SPIKE_SCRATCH=<pasta> escolhe a pasta de trabalho; senão <tmpdir>/otheater-spikes/acp-handoff)
node src/restore-origins.ts                                  # refaz os checkpoints das origens a partir de out/package-*-min.md
SPIKE_SCRATCH=<pasta> ./src/rep3.sh [x|y|modelo|todos]       # repetições r1..r3, sentidos novos, 3.5-flash
SPIKE_SCRATCH=<pasta> ./src/origin2.sh                       # segunda origem dos 3 pares
SPIKE_SCRATCH=<pasta> ./src/rep4.sh [rapido|lento]           # continuações a partir das origens 2
node src/agg.ts                                              # agrega out/cont-*.json em tabelas markdown
```

Variáveis de `cont.ts`: `OT_ORIGIN` (qual `origin-<nome>.json` ler; padrão = o par), `OT_TAG` (sufixo `.rN` da execução), `OT_MODEL` (modelo do OpenCode, ex. `google/gemini-3.5-flash`). Variáveis de `native.ts`: `OT_CWD2=wt|plain|same` (cwd novo da retomada: worktree irmã, pasta fora do git, ou o mesmo como controle), `OT_CLI_TIMEOUT` (ms, padrão 180000), `OT_NTAG` (sufixo para repetir sem colidir). O OpenCode usa `opencode acp`; o `opencode serve` do dono não é usado.

`src/task.ts` define a pasta de trabalho (scratchpad) e recria o repositório de teste. As saídas (JSON por execução, pacotes `.md`, log de fio ACP `*.wire.jsonl`) ficam em `out/`, ignorado pelo git.

## Arquivos

`src/task.ts` (tarefa, worktrees, detector de progresso, avaliação), `src/acp.ts` (cliente ACP, trajetória, kill da árvore), `src/origin.ts`, `src/package.ts`, `src/cont.ts`, `src/reeval.ts`, `src/native.ts`, `src/run-all.sh`, `src/rep2.sh`, `fixtures/accept.test.mjs`. Rodada 2: `src/restore-origins.ts`, `src/rep3.sh`, `src/rep4.sh`, `src/origin2.sh`, `src/agg.ts` (e ajustes em `cont.ts` e `native.ts`).
