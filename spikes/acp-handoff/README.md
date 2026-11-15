# spikes/acp-handoff: passagem de bastão entre clientes ACP

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10 e §5.16). Código **descartável**. Mede a **passagem de bastão** (handoff), item que ficou pendente nos spikes [acp-claude](../acp-claude/README.md), [acp-codex](../acp-codex/README.md) e [acp-opencode](../acp-opencode/README.md):

1. continuar uma tarefa interrompida em **outro cliente**, por um pacote de continuação montado pelo harness (não pela memória do modelo);
2. retomar uma sessão ACP no **CLI do mesmo cliente** e o inverso (retomada nativa);
3. onde cada cliente guarda os arquivos de sessão e por quanto tempo.

Medido em 2026-11-15 (UTC-3), uso pessoal, nas assinaturas do dono. Nenhum login foi feito, nenhuma credencial foi lida. Os arquivos de sessão do dono não foram abertos; só as sessões criadas pelo spike (e, para o item 3, metadados: contagem, datas e nomes de arquivo). Marcas: **[V]** verificado localmente, **[S]** fonte secundária (documentação), **[N]** não confirmado ou estimativa.

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
- A retomada é por `cwd`: o Claude guarda a sessão em pasta derivada do cwd (item 3), então o CLI deve rodar no **mesmo cwd** [S: deduzido do local de armazenamento]; os três funcionaram no mesmo cwd, e cwd diferente não foi testado.
- Mesmo cliente, mesma conta: foi o que se testou. Retomar em **outro** cliente não é possível por este caminho (esse é o caso do item 1) [V].

### Item 3: onde ficam as sessões e quanto duram

| Cliente | Local | Retenção documentada | Observado (só metadados) |
|---|---|---|---|
| Claude | `~/.claude/projects/<cwd com não alfanuméricos trocados por ->/<sessionId>.jsonl` [V] | `cleanupPeriodDays`, padrão 30, mínimo 1 [S] | 422 arquivos; mais antigo por mtime = 2026-10-08 (38 dias), a chave não está no `settings.json` do dono [V]. Ultrapassa os 30 dias documentados; motivo não explicado (mtime vs criação, ou limpeza não ocorreu) [N] |
| Codex | `~/.codex/sessions/AAAA/MM/DD/rollout-<data-hora>-<sessionId>.jsonl` [V] | Nenhuma retenção de sessão documentada; há `history.max_bytes`, `history.persistence` e `memories.max_rollout_age_days` (outro assunto) [S] | 1004 arquivos; do 2026-09-05 (71 dias) ao dia de hoje, sem limpeza aparente [V] |
| OpenCode | SQLite `~/.local/share/opencode/opencode.db` (`OPENCODE_DB` muda o caminho) [S/V] | Nenhuma retenção documentada [S] | 428 sessões de 2026-07-11 a hoje; banco de ~6,6 GB [V] (consulta só de agregados, em modo somente leitura) |

Fontes (consultadas em 2026-11-15): https://code.claude.com/docs/en/claude-directory.md (`cleanupPeriodDays`), https://learn.chatgpt.com/docs/config-file/config-reference (Codex), https://opencode.ai/docs/troubleshooting/ (`opencode.db`, `OPENCODE_DB`).

Consequência de desenho: só o Claude tem expiração por padrão, e ela é curta o bastante para importar em retomadas de dias. Codex e OpenCode acumulam sem limite aparente. O OTheater não deve depender da sessão nativa para a continuação durável; o pacote com checkpoint e diff é a fonte da verdade, e a sessão nativa é só otimização de cache (arquitetura §5.16) [N: recomendação, decisão do dono].

## Formato do pacote de continuação **[proposta]**

Baseado no que funcionou melhor (variante full; zero perda de trabalho em 4 de 4 execuções). Seções nesta ordem; tudo gerado pelo harness a partir do que registrou, nada da memória do modelo:

1. **Cabeçalho**: quem é você, que não vê a conversa anterior, e que os arquivos do cwd já têm o trabalho feito.
2. **Demanda, contrato e ordens**, texto original, ainda em vigor.
3. **Estado da worktree**: id do commit-base, id do checkpoint e o diff contra o base (bloco `diff`).
4. **Por que parou**: motivo estruturado (processo morto, cota esgotada, limite de contexto, política), dizendo que não é falha da tarefa.
5. **Progresso calculado**: checklist `[x]/[ ]` obtido dos arquivos ou dos testes pelo harness (detector determinístico, §5.16). É o campo que mais protegeu contra retrabalho.
6. **Trajetória registrada** (eventos ACP): arquivos lidos, arquivos editados, comandos e testes com resultado e saída curta, última mensagem do agente, decisões já respondidas, ferramentas em voo (efeito incerto).
7. **Efeitos colaterais já executados** (commit, push, chamadas externas) para que o destino não os repita. Neste spike não houve efeitos externos; **[N]** o campo não foi exercitado.
8. **O que falta**, derivado do checklist.
9. **Instrução final**: "continue deste estado; não refaça o que está marcado como concluído; não reescreva código anterior sem um teste que prove o erro".

Notas: os caminhos absolutos do cwd de origem devem ser normalizados para relativos (feito em `package.ts`); o tamanho foi de ~1,0 a 1,2 mil tokens estimados para esta tarefa pequena, e cresce com o diff e com os comandos, então o resumo de trajetória precisa de teto (aqui: comando 120 caracteres, saída 160, mensagem 400) **[N: tetos ainda sem teste com tarefas grandes]**. A variante min (itens 1 a 3 mais a instrução) bastou para Claude e Codex como destino, mas não para o OpenCode/flash-lite; usá-la como padrão seria apostar no modelo de destino.

## Pendências (não medido)

- **Estatística**: 1 execução por célula (2 no par B). Faltam repetições, mais pares (os 6 sentidos entre clientes) e tarefas maiores, com mais passos e diffs grandes.
- **Destino fraco**: a diferença min x full apareceu só com o OpenCode/flash-lite. Falta separar efeito do pacote de efeito do modelo (rodar o mesmo destino com um modelo mais forte).
- **Interrupção por cota ou contexto**: aqui foi SIGKILL após N edições. O caso real (cota esgotada, ver spike `quota-exhaustion`) e o pacote com "por que parou" real não foram combinados.
- **Efeitos colaterais externos** e **decisões respondidas** (campos 6 e 7 da proposta): não exercitados.
- **Retomada nativa com `cwd` diferente** e com sessões antigas (pós-retenção): não testadas.
- **Troca de cliente mantendo o cache de prompt**: não aplicável entre clientes; o `usage` mostra que o prompt do sistema domina o custo (cache de leitura).
- `usage` de OpenCode (`outputTokens` = 3) não confiável [N].
- Retenção real do Claude acima do documentado (38 dias contra 30): causa não investigada.

## Como rodar

Requer os `node_modules` dos spikes irmãos `acp-claude` e `acp-codex` (os adaptadores são lidos de lá) e os clientes instalados e logados.

```
cd spikes/acp-handoff && npm install --ignore-scripts
node src/origin.ts <claude|codex|opencode> <par> [N=3]      # roda a origem e mata após N edições
node src/cont.ts <cliente-destino> <par> <min|full>          # monta o pacote e continua em sessão nova
node src/reeval.ts cont-<par>-<variante>                     # reavalia uma worktree já terminada
node src/native.ts <cliente> [A|B|AB]                        # item 2 (A: ACP->CLI, B: CLI->ACP)
./src/run-all.sh                                             # os três pares do item 1 em sequência
SCRATCH=<pasta> ./src/rep2.sh                                # 2ª repetição do par B
```

`src/task.ts` define a pasta de trabalho (scratchpad) e recria o repositório de teste. As saídas (JSON por execução, pacotes `.md`, log de fio ACP `*.wire.jsonl`) ficam em `out/`, ignorado pelo git.

## Arquivos

`src/task.ts` (tarefa, worktrees, detector de progresso, avaliação), `src/acp.ts` (cliente ACP, trajetória, kill da árvore), `src/origin.ts`, `src/package.ts`, `src/cont.ts`, `src/reeval.ts`, `src/native.ts`, `src/run-all.sh`, `src/rep2.sh`, `fixtures/accept.test.mjs`.
