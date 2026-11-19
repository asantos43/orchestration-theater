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

Convenção dos nomes: "Claude→Codex" etc. = origem→destino; "(origem 2)" = origem refeita; "(3.5-flash)" = destino OpenCode com `google/gemini-3.5-flash` em vez do padrão `google/gemini-3.1-flash-lite`; "(gemma local)" = destino OpenCode com o Gemma 4 E4B local no Ollama (seção própria, abaixo). "(glm-5.3-flash free)", "(deepseek-v4.1-flash free)" e "(minimax-m3.1-flash free)" = destino OpenCode com o modelo free do Zen (`opencode/...`); "(gemma 26b google)" e "(gemma 31b google)" = destino OpenCode com `google/gemma-4-26b-a4b-it` e `google/gemma-4-31b-it` (seção "Destino OpenCode com modelos free", abaixo). "(gpt-6.1-sol)" = destino OpenCode com `openai/gpt-6.1-sol` pelo login do ChatGPT (seção "Destino OpenCode com gpt-6.1-sol", abaixo). Os pares A, B e C da rodada 1 são Claude→Codex, Codex→OpenCode e OpenCode→Claude.

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
| Codex→OpenCode (deepseek-v4.1-flash free) | full | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (deepseek-v4.1-flash free) | full | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (deepseek-v4.1-flash free) | full | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (deepseek-v4.1-flash free) | min | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (deepseek-v4.1-flash free) | min | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (deepseek-v4.1-flash free) | min | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (3.5-flash) | full | r1 | sim | 9/9 | 5/5 | 6/6 | 48,7 s | 0/11 | 4 (4) | 21940 |
| Codex→OpenCode (3.5-flash) | full | r2 | excluída (cota) | 3/3 | 0/5 | 3/6 | 80,9 s | 0/11 | 1 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (3.5-flash) | full | r3 | excluída (cota) | 3/3 | 0/5 | 2/6 | 75,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (3.5-flash) | min | r1 | sim | 9/9 | 5/5 | 6/6 | 18,3 s | 0/11 | 4 (4) | 21604 |
| Codex→OpenCode (3.5-flash) | min | r2 | sim | 9/9 | 5/5 | 6/6 | 60,3 s | 0/11 | 4 (4) | 21613 |
| Codex→OpenCode (gemma local) | full | r1 | **não** | 3/3 | 0/5 | 2/6 | 273,6 s | 0/11 | 0 (4) | 17911 |
| Codex→OpenCode (gemma local) | full | r2 | **não** | 3/3 | 0/5 | 2/6 | 354,1 s | 0/11 | 0 (4) | 18587 |
| Codex→OpenCode (gemma local) | min | r1 | **não** | 0/1 | 0/5 | 4/6 | 1500,1 s (vigia) | 3/11 | 9‡ (4) | 0 ERRO: ACP connection closed |
| Codex→OpenCode (gemma local) | min | r2 | **não** | 4/4 | 0/5 | 2/6 | 1291,2 s | 9/11 | 6‡ (4) | 21533 |
| Codex→OpenCode (gemma 26b google) | full | r1 | excluída (cota) | 3/3 | 0/5 | 2/6 | 74,5 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 26b google) | full | r2 | excluída (cota) | 3/3 | 0/5 | 2/6 | 73,4 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 26b google) | full | r3 | excluída (cota) | 3/3 | 0/5 | 2/6 | 71,4 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 26b google) | min | r1 | excluída (cota) | 3/3 | 0/5 | 2/6 | 150,6 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 26b google) | min | r2 | excluída (cota) | 3/3 | 0/5 | 2/6 | 145,6 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 26b google) | min | r3 | excluída (provedor) | 3/3 | 0/5 | 3/6 | 212,2 s | 0/11 | 2 (4) | 0 ERRO: Internal error: Internal error encountered. |
| Codex→OpenCode (gemma 31b google) | full | r1 | excluída (cota) | 3/3 | 0/5 | 3/6 | 404,6 s | 0/11 | 2 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 31b google) | full | r2 | excluída (cota) | 3/3 | 0/5 | 3/6 | 249,8 s | 0/11 | 1 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 31b google) | full | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 165,2 s | 0/11 | 0 (4) | 0 ERRO: Internal error: Internal error encountered. |
| Codex→OpenCode (gemma 31b google) | min | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 138,3 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This model is currently experiencing high de |
| Codex→OpenCode (gemma 31b google) | min | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 165,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This model is currently experiencing high de |
| Codex→OpenCode (gemma 31b google) | min | r3 | excluída (cota) | 3/3 | 0/5 | 2/6 | 215,6 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (glm-5.3-flash free) | full | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (glm-5.3-flash free) | full | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (glm-5.3-flash free) | full | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (glm-5.3-flash free) | min | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (glm-5.3-flash free) | min | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (glm-5.3-flash free) | min | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | full | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | full | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | full | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | min | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | min | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | min | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (gpt-6.1-sol) | full | r1 | **não** | 3/3 | 0/5 | 2/6 | 600,2 s (vigia) | 0/11 | 0§ (4) | 0 ERRO: ACP connection closed |
| Codex→OpenCode (gpt-6.1-sol) | full | r2 | sim | 10/10 | 5/5 | 6/6 | 119,7 s | 0/11 | 0§ (4) | 15993 |
| Codex→OpenCode (gpt-6.1-sol) | full | r3 | sim | 11/11 | 5/5 | 6/6 | 123,4 s | 0/11 | 0§ (4) | 17134 |
| Codex→OpenCode (gpt-6.1-sol) | min | r1 | sim | 10/10 | 5/5 | 6/6 | 72,6 s | 0/11 | 0§ (4) | 15676 |
| Codex→OpenCode (gpt-6.1-sol) | min | r2 | sim | 11/11 | 5/5 | 6/6 | 79,3 s | 0/11 | 0§ (4) | 15427 |
| Codex→OpenCode (gpt-6.1-sol) | min | r3 | sim | 11/11 | 5/5 | 6/6 | 81,3 s | 0/11 | 0§ (4) | 15631 |
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
| Codex→OpenCode (gemma local) | full | 2 | 0 de 2 | 313,9 s | 273,6 a 354,1 s | 0 | 0 (0, 0) | 4243 |
| Codex→OpenCode (gemma local) | min | 2 | 0 de 2 | 1395,6 s | 1291,2 a 1500,1 s | 12 | 7‡ (5, 2) | 3129 |
| Codex→OpenCode (gpt-6.1-sol) | full | 3 | 2 de 3 | 123,4 s | 119,7 a 600,2 s | 0 | 0§ (0, 0, 0) | 4243 |
| Codex→OpenCode (gpt-6.1-sol) | min | 3 | 3 de 3 | 79,3 s | 72,6 a 81,3 s | 0 | 0§ (0, 0, 0) | 3129 |
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

As células "(deepseek-v4.1-flash free)", "(glm-5.3-flash free)", "(minimax-m3.1-flash free)", "(gemma 26b google)" e "(gemma 31b google)" **não têm linha neste agregado**: as 30 execuções foram todas excluídas por infraestrutura (seção "Destino OpenCode com modelos free"), então n válido = 0 em cada uma.

"ok em n" exige testes do próprio agente verdes, aceitação 5/5 e 6 passos. O tempo é a mediana, com a faixa ao lado. As execuções "excluída (cota)" não entram. ‡ = nas linhas "gemma local", as escritas contam **tentativas** de edição (inclusive as que o OpenCode recusou); ver a seção do Gemma local. § = nas linhas "gpt-6.1-sol", o modelo delegou o trabalho a um subagente do OpenCode e as edições do subagente **não aparecem** no fluxo ACP da sessão; o 0 não quer dizer que não houve escrita, quer dizer que a escrita não foi medida (ver a seção do gpt-6.1-sol).

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

**Decisão do dono, 2026-11-15:** a célula pendente do `google/gemini-3.5-flash` full (ficou com **n=1** válida; 2 excluídas por cota) **não será completada**. No lugar dela entra a célula do modelo local (próxima seção). A célula do 3.5-flash fica registrada como **exceção**: min n=2 e full n=1, ambas corretas, sem mais repetições; qualquer conclusão sobre o "modelo mais forte" com o Gemini fica com esse n.

**Atualização, 2026-11-15:** o dono mandou rodar mais 5 modelos no mesmo par e origem (3 modelos free do Zen e 2 Gemma pelo Google); a seção "Destino OpenCode com modelos free" registra o que aconteceu. A decisão acima (não completar a célula do 3.5-flash) continua valendo. Depois, o dono mandou rodar também o `openai/gpt-6.1-sol` (o mesmo modelo do destino Codex) no destino OpenCode, como controle de harness; ver a seção "Destino OpenCode com gpt-6.1-sol". Isso não muda a exceção do 3.5-flash.

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

### Destino OpenCode com modelo local (Gemma 4 E4B no Ollama)

Medido em 2026-11-15, das 16:11 às 17:09 (UTC-3), a pedido do dono (que trocou a célula do `gemini-3.5-flash` por esta). Par **Codex→OpenCode, origem 1** (mesmo checkpoint restaurado e mesmos pacotes das células do flash-lite e do 3.5-flash), variantes **min** e **full**, **2 execuções por variante**. Uma terceira execução por variante **não foi feita** (cada execução levou de 4,5 a 25 min; ver "Tempo"), então n=2. **n de 2 não é estatística.**

**Configuração [V]**

| Item | Valor |
|---|---|
| Modelo | `local/gemma4-e4b` (provedor local, `@ai-sdk/openai-compatible`); é o `gemma4-e4b` do Ollama, o **mesmo** da configuração cheia do spike `local-model` (GGUF `gemma-4-E4B-it-Q4_0`, sem baixar nem importar nada) |
| Servidor | Ollama v0.40.16 por `spikes/local-model/ollama.sh start`, `127.0.0.1:47510`, iGPU por Vulkan (`library=Vulkan`, "AMD ... RADV RENOIR"); só eu o subi e só eu o parei |
| Contexto | `OLLAMA_CONTEXT_LENGTH=32768` (padrão do `ollama.sh`); o log do servidor mostra `n_ctx_slot = 32768` |
| Raciocínio | **ligado** (padrão do Ollama; o OpenCode não manda nada que o desligue; 591 a 8001 `agent_thought_chunk` por execução); mesma condição da corrida cheia do `local-model` |
| Ferramentas do OpenCode | **perfil padrão do dono**, o mesmo das células do Gemini; só o provedor foi acrescentado, por `OPENCODE_CONFIG_CONTENT` (limite de contexto 32768, saída 4096, como no `local-model`). O `~/.config/opencode` não foi lido nem alterado |
| Prompt | 16 996 tokens na 1ª requisição principal (com o pacote), crescendo até 21 576 na última; cabe nos 32 768. É mais que os ~11,6 mil do OpenCode "padrão" do `local-model`, porque o perfil do dono acrescenta contexto (skills etc.) |
| Velocidade (log do Ollama, 41 requisições) | prefill do prompt cheio: 151 tok/s (16 996 tokens em 113 s); com cache de prefixo, ~90 a 110 tok/s nos trechos novos (cerca de 200 a 400 tokens); geração 8,0 a 11,2 tok/s; ~23,7 mil tokens gerados nas quatro execuções (raciocínio incluído) |
| Mudança no código | **`acp.ts` não mudou**: o processo filho herda `OPENCODE_CONFIG_CONTENT` e `OT_MODEL=local/gemma4-e4b` do ambiente. Em `cont.ts`, só o vigia ficou configurável (`OT_WATCHDOG_MS`, antes fixo em 600 s; aqui 1500 s, porque a execução local leva mais que 10 min). `agg.ts` ganhou o rótulo "(gemma local)". Novo `src/rep5.sh` roda as execuções |

**Tabela por execução** (mesmo formato das anteriores; as 4 linhas também estão na tabela geral acima)

| Par | Variante | Execução | ok | Próprios | Aceitação | Passos | Tempo | Linhas perdidas | Escritas (faltavam) | Tokens do usage |
|---|---|---|---|---|---|---|---|---|---|---|
| Codex→OpenCode (gemma local) | min | r1 | **não** | 0/1 (arquivo não carrega) | 0/5 | 4/6 | 1500,1 s (vigia) | 3/11 | 9‡ (4) | sem usage (processo morto) |
| Codex→OpenCode (gemma local) | min | r2 | **não** | 4/4 | 0/5 | 2/6 | 1291,2 s | 9/11 | 6‡ (4) | 21533 |
| Codex→OpenCode (gemma local) | full | r1 | **não** | 3/3 | 0/5 | 2/6 | 273,6 s | 0/11 | 0 (4) | 17911 |
| Codex→OpenCode (gemma local) | full | r2 | **não** | 3/3 | 0/5 | 2/6 | 354,1 s | 0/11 | 0 (4) | 18587 |

‡ = tentativas de edição, contando as que o OpenCode recusou (min r1: 3 concluídas e 6 recusadas; min r2: 5 concluídas e 1 recusada, mais 2 comandos `node --test`).

**Falhas, uma a uma [V, a partir de `out/cont-codex-opencode-gemma-*.json` e das worktrees finais]**

- **full r1 e full r2 (iguais)**: o modelo leu `lib.mjs` (r2 leu também `lib.test.mjs`), **parou o turno** (`end_turn`) e escreveu a próxima chamada **como texto** (um bloco JSON com `read` ou `edit`) em vez de chamar a ferramenta. 0 edições; o estado final é o da origem (0 linhas perdidas, 2/6 passos), só que sem a continuação. Isso é o "texto no lugar da chamada" do `local-model`, que lá deu 0 em 10 tarefas. A causa (raciocínio ligado, prompt de ~17 mil tokens, tarefa mais longa, ou o parser de ferramentas do Ollama) **não foi separada [N]**.
- **min r1**: nenhuma parada precoce; 16 chamadas em 25 min, **6 de 9 edições recusadas pelo OpenCode** (2 "found multiple matches for oldString" e 4 "could not find oldString"). As 3 edições aceitas deixaram `lib.mjs` com `wordFreq` e `chunk` coladas **dentro** de `slugify` (sem fechar a chave): `SyntaxError`. O vigia de 1500 s matou o adaptador; o prompt não terminou (sem resposta final). Perdeu 3 linhas de teste da origem. Laço de chamadas repetidas idênticas **não** houve (as chamadas variaram), mas houve "ler, tentar editar, falhar, ler de novo" **[V]**.
- **min r2**: terminou sozinho em 21,5 min, respondeu **"DONE 10"** e **reescreveu `lib.mjs` e `lib.test.mjs` só com o `chunk` e seus testes**, apagando `slugify` e `wordFreq` (9 de 11 linhas da origem sumiram). Os testes do próprio agente ficaram verdes (4/4) e ele declarou sucesso, mas a aceitação (0/5) não carrega porque faltam exports e há 4 testes, não 10. **Falha silenciosa**: autoavaliação verde e resposta "DONE", com o trabalho da origem destruído **[V]**. É o tipo de falha que só o diff contra o checkpoint (o harness) pega.
- Nenhuma recusa de permissão (`permissions` = 0), nenhum erro de infraestrutura (Ollama estável, sem "GPU Hang", sem estouro de contexto), nenhuma cota.

**Tempo [V]**

- Tempo até a 1ª chamada de ferramenta: 227 a 244 s nas quatro execuções (prefill de ~17 mil tokens em ~113 s mais raciocínio a ~9 tok/s).
- Total: full 274 e 354 s (paradas precoces); min 1291 s e 1500 s (limite do vigia). O tempo do min é dominado por raciocínio longo entre chamadas (requisições de até ~1,3 mil tokens gerados, ~2,5 min cada). Contraste: flash-lite 45 a 184 s, 3.5-flash 18 a 60 s.
- O vigia de 600 s original teria matado as duas execuções do min; 1500 s é um teto escolhido por mim, sem relação com o produto.

**Tokens [N]**: o `usage` que o OpenCode devolve pelo ACP veio mais plausível que nos testes anteriores (`outputTokens` de 284 a 605, `cachedReadTokens` 17 387 a 20 968), mas o total (~18 a 21 mil) é do tamanho de **uma** requisição, não da soma das chamadas; parece reportar só o último passo. Por isso não comparo com os demais. A medida confiável aqui é do servidor: **41 requisições e ~23,7 mil tokens gerados** nas quatro execuções, e 3 de 4 chegaram a ~21 mil de contexto (min r1/r2 e a corrida até o corte).

**Comparação com as células do flash-lite e do 3.5-flash (mesmo par, mesma origem, mesmos pacotes)**

| Modelo do destino | Variante | Válidas | ok | Tempo | Escritas (faltavam 4) | Linhas perdidas |
|---|---|---|---|---|---|---|
| flash-lite (padrão) | min | 3 | 1 de 3 | 45 a 184 s | 5, 6, 8 | 3 |
| flash-lite (padrão) | full | 3 | 2 de 3 | 59 a 180 s | 5, 6, 6 | 0 |
| 3.5-flash (exceção; n=1 no full) | min | 2 | 2 de 2 | 18 e 60 s | 4 e 4 | 0 |
| 3.5-flash (exceção; n=1 no full) | full | 1 | 1 de 1 | 49 s | 4 | 0 |
| **Gemma 4 E4B local** | min | 2 | **0 de 2** | 1291 e 1500 s | 6 e 9 tentativas | 12 |
| **Gemma 4 E4B local** | full | 2 | **0 de 2** | 274 e 354 s | 0 | 0 |

Leitura (n de 2 a 3 por célula **não é estatística**; mesma máquina, mesmo dia, serviços diferentes):

- **Nesta tarefa e neste par, o Gemma 4 E4B local não fechou nenhuma das 4 execuções** (0 de 4), contra 3 de 6 do flash-lite e 3 de 3 do 3.5-flash **[V, n pequeno]**. O resultado é pior que o do flash-lite e bem pior que o do 3.5-flash; o intervalo é largo demais para dizer quanto (com 0 de 4, uma taxa verdadeira de até ~50% ainda não seria improvável **[N]**, cálculo aproximado, não verificado).
- **Os modos de falha diferem do flash-lite**: o flash-lite errava no conteúdo (reescrever testes, `chunk` sem `RangeError`) e fazia escritas a mais; o Gemma parou o turno com chamada em texto (2 execuções, full), fez edições que o OpenCode recusou e quebrou a sintaxe (min r1) e **apagou o trabalho da origem declarando DONE** (min r2) **[V]**. O full evitou a perda de trabalho (0 linhas perdidas) porque o modelo nem chegou a editar; **isso não é evidência de que o full protege**, é parada precoce **[N]**.
- **Variante**: o full teve 0 linhas perdidas e o min 12, mas com 0 edições nas execuções do full a comparação das variantes fica sem sentido aqui. O que se pode dizer é que **nenhuma** das duas variantes funcionou com este modelo nesta configuração.
- **Custo de tempo**: no min, 21 a 25 min por execução, de 7 a 30 vezes o flash-lite/3.5-flash. Mesmo que o resultado fosse correto, o Executor local nesta máquina e com raciocínio ligado seria lento para continuar tarefas de 6 passos **[V para estas execuções]**.
- **Não se separou** a causa (modelo pequeno, raciocínio ligado, prompt de ~17 mil tokens do perfil do dono, ferramenta `edit` do OpenCode, parser do Ollama) **[N]**. Não foi rodado: raciocínio desligado (`reasoning_effort: none`), perfil enxuto do OpenCode, outro quantizador ou o Gemma maior, nem a 3ª execução. Cada um poderia mudar o resultado; os do `local-model` (10/10 em tarefas curtas, mesmo modelo e servidor) mostram que o modelo e a cadeia funcionam em tarefas de 1 a 3 chamadas, não nesta de 6 passos com bastão.
- **Consequência para o bastão (proposta [N], decisão do dono)**: destino local de 4B efetivos, com raciocínio ligado, não deve receber continuação sem checagem do harness; a falha mais perigosa (min r2) passou nos testes do próprio agente e só foi vista no diff contra o checkpoint e na aceitação escondida. Reforça a recomendação de medir o progresso pelo estado dos arquivos, e não pela resposta do agente.

Dados brutos em `out/cont-codex-opencode-gemma-{min,full}.r{1,2}.json` e `*.wire.jsonl` (git-ignored). O log do servidor Ollama desta sessão ficou em `spikes/local-model/out/ollama-serve.log` (também git-ignored; sobrescrito na próxima subida).

### Destino OpenCode com modelos free (Zen e Gemma pelo Google)

Medido em 2026-11-15, das 17:21 às 17:57 (UTC-3), a pedido do dono, que escolheu estes 5 modelos no mesmo dia (IDs vindos de `opencode models` [V]). Par **Codex→OpenCode, origem 1** (mesmo checkpoint restaurado e mesmos pacotes das células do flash-lite, 3.5-flash e Gemma local), variantes **min** e **full**, **3 execuções por variante (r1 a r3)**: 5 modelos x 2 x 3 = **30 execuções, uma de cada vez**. **Resultado: nenhuma das 30 produziu uma continuação avaliável. As 30 foram excluídas por infraestrutura (cota ou provedor), então esta seção não mede o desempenho de nenhum dos 5 modelos.** O que ela registra é por que não deu e o que o dono precisa resolver.

**Configuração [V]**

| Item | Valor |
|---|---|
| Modelos (`OT_MODEL`) | `opencode/glm-5.3-flash-free`, `opencode/deepseek-v4.1-flash-free`, `opencode/minimax-m3.1-flash-free` (Zen); `google/gemma-4-26b-a4b-it`, `google/gemma-4-31b-it` (Google) |
| Perfil do OpenCode | o padrão do dono, como no 3.5-flash; **só `OT_MODEL` muda**, sem `OPENCODE_CONFIG_CONTENT`. O harness troca o modelo da sessão por `session/set_config_option`; o log de fio confirma `applied: model = <id>` nas execuções. O padrão do perfil que o ACP anunciou foi `minimax/MiniMax-M3` (esforço `none`, modo `build`), não o flash-lite que o `SPEC` do `acp.ts` usa quando `OT_MODEL` não está definido |
| Script | novo `src/rep6.sh <modelo> <rótulo> <min\|full> <tag> ...`, par `codex-opencode-<rótulo>` (`glm`, `deepseek`, `minimax`, `gemma26`, `gemma31`), `OT_ORIGIN=codex-opencode.restored`, vigia padrão de 600 000 ms, `timeout -k 10 700`. Ordem: r1 de todos os modelos, depois r2, depois r3. `cont.ts` e `acp.ts` não mudaram; `agg.ts` ganhou os 5 rótulos e a exclusão "provedor" |
| Pasta e repositório | `SPIKE_SCRATCH` com o repositório restaurado e o checkpoint `76e6d48` conferidos antes (o mesmo das células anteriores) |
| Processos | só os que o harness iniciou (`node src/cont.ts`, `opencode acp` filhos). O `opencode serve` do dono (porta 4096) não foi tocado. Nenhum login, nenhuma credencial lida |

**Fatos de fonte secundária [S], consultados em 2026-11-15 (não verifiquei localmente)**

- **Zen** (https://opencode.ai/docs/zen/): GLM-5.3-Flash Free, DeepSeek V4.1 Flash Free e MiniMax M3.1 Flash Free têm "zero-retention" e não usam os dados para treino; são grátis "for a limited time"; a página **não informa limite de requisições** para eles.
- **Google** (termos dos Unpaid Services, https://aistudio.google.com/docs/terms, vigentes desde 2026-03-23): o conteúdo enviado é usado para melhorar produtos e pode ter revisão humana. **Limites do tier grátis para Gemma: não os encontrei na documentação [N]**; os números abaixo vêm só das mensagens de erro da API.
- Implicação [N]: no Gemma pelo Google, a requisição inclui o prompt do perfil do OpenCode do dono (o `local-model` mediu ~17 mil tokens na 1ª requisição, com skills etc.), além do pacote, e essa parte segue os termos acima. Não abri o conteúdo do prompt de sistema.

**Tabela por execução** (mesmo formato das anteriores; as 30 linhas também estão na tabela geral). "Próprios", "Aceitação" e "Passos" são do estado da worktree no fim (o do checkpoint, 2 de 6 passos, quando o destino não fez nada); em linhas excluídas **não medem o modelo**.

| Par | Variante | Execução | ok | Próprios | Aceitação | Passos | Tempo | Linhas perdidas | Escritas (faltavam) | Tokens do usage |
|---|---|---|---|---|---|---|---|---|---|---|
| Codex→OpenCode (glm-5.3-flash free) | full | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (glm-5.3-flash free) | full | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (glm-5.3-flash free) | full | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (glm-5.3-flash free) | min | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (glm-5.3-flash free) | min | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (glm-5.3-flash free) | min | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (deepseek-v4.1-flash free) | full | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (deepseek-v4.1-flash free) | full | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (deepseek-v4.1-flash free) | full | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (deepseek-v4.1-flash free) | min | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (deepseek-v4.1-flash free) | min | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (deepseek-v4.1-flash free) | min | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | full | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | full | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | full | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | min | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | min | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,7 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (minimax-m3.1-flash free) | min | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 0,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This API key has expired. Create a new API k |
| Codex→OpenCode (gemma 26b google) | full | r1 | excluída (cota) | 3/3 | 0/5 | 2/6 | 74,5 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 26b google) | full | r2 | excluída (cota) | 3/3 | 0/5 | 2/6 | 73,4 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 26b google) | full | r3 | excluída (cota) | 3/3 | 0/5 | 2/6 | 71,4 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 26b google) | min | r1 | excluída (cota) | 3/3 | 0/5 | 2/6 | 150,6 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 26b google) | min | r2 | excluída (cota) | 3/3 | 0/5 | 2/6 | 145,6 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 26b google) | min | r3 | excluída (provedor) | 3/3 | 0/5 | 3/6 | 212,2 s | 0/11 | 2 (4) | 0 ERRO: Internal error: Internal error encountered. |
| Codex→OpenCode (gemma 31b google) | full | r1 | excluída (cota) | 3/3 | 0/5 | 3/6 | 404,6 s | 0/11 | 2 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 31b google) | full | r2 | excluída (cota) | 3/3 | 0/5 | 3/6 | 249,8 s | 0/11 | 1 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |
| Codex→OpenCode (gemma 31b google) | full | r3 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 165,2 s | 0/11 | 0 (4) | 0 ERRO: Internal error: Internal error encountered. |
| Codex→OpenCode (gemma 31b google) | min | r1 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 138,3 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This model is currently experiencing high de |
| Codex→OpenCode (gemma 31b google) | min | r2 | excluída (provedor) | 3/3 | 0/5 | 2/6 | 165,8 s | 0/11 | 0 (4) | 0 ERRO: Internal error: This model is currently experiencing high de |
| Codex→OpenCode (gemma 31b google) | min | r3 | excluída (cota) | 3/3 | 0/5 | 2/6 | 215,6 s | 0/11 | 0 (4) | 0 ERRO: Internal error: You exceeded your current quota, please chec |

**Por que as 30 foram excluídas [V, a partir de `out/cont-codex-opencode-*.json` e dos logs de fio]**

- **18 do Zen (GLM, DeepSeek, MiniMax; 3 x 2 x 3): "This API key has expired"**, devolvido pelo provedor no 1º `session/prompt`, em 0,7 a 0,8 s, 0 chamadas de ferramenta, `usage` 0. O texto do erro manda criar uma nova chave no console do OpenCode ("Signing in again will not renew this key"). Repeti os 3 modelos nas 3 execuções, com o mesmo resultado. A chave é da conta do dono no OpenCode (auth que não li e não mexi); **renovar é ação do dono**. Que a chave do Zen seja a mesma de `opencode/` no `opencode models` é o que a mensagem indica [N: não inspecionei a configuração].
- **8 do Google por cota** (erro `generate_content_free_tier_input_token_count`, **limite 16000 tokens de entrada por minuto, "on Free Tier"**, modelos `gemma-4-26b` e `gemma-4-31b`, com "retry in" de 18 a 58 s): 26B full r1/r2/r3 e min r1/r2; 31B full r1/r2 e min r3. O erro mostra também que a chave do dono no Google está no **tier grátis** [V: texto do erro]. O erro aparece 3 vezes no log de fio de cada execução (provavelmente tentativas do OpenCode **[N]**) e a execução termina com ele. Execuções levaram de 71 a 405 s, **tempo de espera e nova tentativa, não velocidade do modelo**.
- **4 do Google por erro do provedor**: 31B min r1 e r2 ("This model is currently experiencing high demand"), 26B min r3 e 31B full r3 ("Internal error encountered").
- **Chegou a haver trabalho parcial** antes do corte: 26B min r3 fez 2 edições (3 de 6 passos), 31B full r1 fez 2 (3 de 6) e full r2 fez 1 (3 de 6). São execuções interrompidas pelo provedor, **não avaliáveis**: sem resposta final, aceitação 0/5. Não dá para dizer se o modelo teria fechado a tarefa, nem se erraria.
- **O limite de 16 000 tokens por minuto é o provável bloqueio estrutural do Gemma neste perfil [N]**: o prompt do perfil do dono com o pacote tem ~17 mil tokens por requisição medidos no Ollama (tokenizador diferente do Google, então a contagem do Google pode diferir), e uma execução faz várias requisições em sequência. Algumas execuções passaram de 1 a 4 chamadas antes do corte, então não é "toda requisição falha" [V]; que 2 ou mais requisições seguidas estourem o minuto é inferência [N].

**Comparação com as células anteriores (mesmo par, mesma origem, mesmos pacotes)**

| Modelo do destino | Variante | Válidas | ok | Observação |
|---|---|---|---|---|
| flash-lite (padrão) | min | 3 | 1 de 3 | 45 a 184 s, 5 a 8 escritas |
| flash-lite (padrão) | full | 3 | 2 de 3 | 59 a 180 s, 5 a 6 escritas |
| 3.5-flash (exceção) | min | 2 | 2 de 2 | 18 e 60 s, 4 escritas |
| 3.5-flash (exceção) | full | 1 | 1 de 1 | 49 s, 4 escritas |
| Gemma 4 E4B local | min / full | 2 / 2 | 0 de 2 / 0 de 2 | 0 de 4; paradas precoces, edições recusadas, trabalho da origem apagado |
| GLM-5.3-Flash free | min / full | 0 / 0 | sem dado (0 de 0) | chave do Zen expirada (6 excluídas) |
| DeepSeek V4.1 Flash free | min / full | 0 / 0 | sem dado (0 de 0) | chave do Zen expirada (6 excluídas) |
| MiniMax M3.1 Flash free | min / full | 0 / 0 | sem dado (0 de 0) | chave do Zen expirada (6 excluídas) |
| Gemma 4 26B (Google) | min / full | 0 / 0 | sem dado (0 de 0) | cota do tier grátis e erros do provedor (6 excluídas) |
| Gemma 4 31B (Google) | min / full | 0 / 0 | sem dado (0 de 0) | cota do tier grátis e erros do provedor (6 excluídas) |

**Leitura**

- **Nada a concluir sobre a qualidade dos 5 modelos** como destino do bastão: 0 de 30 execuções válidas. Os números "0 de 0" não são falhas dos modelos e não entram nas taxas de nenhuma célula.
- **O que a tentativa mostrou, e que é dado de infraestrutura para o OTheater [V para esta conta e este dia]**: (1) uma credencial de provedor expirada derruba o destino na 1ª requisição, em menos de 1 s, e o erro chega pelo ACP como "Internal error: ..." com o texto do provedor; o harness precisa classificar isso (aqui, por texto do erro no `agg.ts`) como "provedor indisponível", não como falha do modelo, e tentar outro destino; (2) o tier grátis do Google para Gemma tem limite de tokens de entrada por minuto (16 000) menor que o prompt do perfil cheio do OpenCode, o que torna o Gemma pelo Google na conta grátis impraticável com este perfil **[N: inferência]**; (3) "modelo free" do Zen tem, nesta conta, um ponto único de falha na chave.
- **O dado do Gemma local continua valendo** (0 de 4, seção anterior); esta rodada não o confirma nem o refuta com os Gemma maiores.
- **Opções, para o dono decidir [N]**: renovar a chave do Zen e repetir `rep6.sh` nos 3 modelos free; para o Gemma, usar uma chave do Google com cobrança (tier pago, sem o limite de 16 000 por minuto, a confirmar na documentação do Google) ou os IDs `openrouter/google/gemma-4-26b-a4b-it` e `openrouter/google/gemma-4-31b-it` (e as variantes `:free`) que aparecem no `opencode models` e **não foram testados** (outro provedor, outros termos). Não escolhi nenhuma.

Dados brutos em `out/cont-codex-opencode-{glm,deepseek,minimax,gemma26,gemma31}-{min,full}.r{1,2,3}.json` e `*.wire.jsonl` (git-ignored).

### Destino OpenCode com gpt-6.1-sol (controle de harness)

Pergunta: com o **mesmo modelo** do destino Codex (`gpt-6.1-sol`, que é o `currentValue` nos logs de fio do Codex [V]), quanto da diferença entre os destinos Codex e OpenCode vem do modelo e quanto vem do harness (o cliente, o perfil e as ferramentas)? Mesmo par (Codex→OpenCode), mesma origem 1 (`codex-opencode.restored`), mesmos pacotes min e full, 3 execuções por variante.

| Item | Valor |
|---|---|
| Modelo | `OT_MODEL=openai/gpt-6.1-sol`, da lista do `opencode models` [V] |
| Conta | **login do ChatGPT do dono no OpenCode**. Autorização do dono em 2026-11-15: "Login ChatGPT, pode usar". O dono assumiu o uso **sem a leitura dos termos da OpenAI** sobre usar a assinatura por um cliente de terceiros (D3); o que esses termos permitem é **[N]**. Não li nem mexi em credencial |
| Perfil | o padrão do OpenCode, com as skills e as instruções do dono, igual ao das células flash-lite e free |
| Script | `src/rep6.sh openai/gpt-6.1-sol gpt61sol min r1 full r1 min r2 full r2 min r3 full r3`, vigia de 600 s. Em `agg.ts`, só o rótulo "(gpt-6.1-sol)" é novo |
| Quando | 2026-11-15, de 22:19 a 22:38 (UTC-3), em sequência, sem outro fluxo em paralelo |

**Resultado [V, a partir de `out/cont-codex-opencode-gpt61sol-*.json` e dos logs de fio]**

| Variante | Válidas | ok | Tempo | Linhas perdidas | Testes próprios |
|---|---|---|---|---|---|
| min | 3 | **3 de 3** | 72,6 a 81,3 s (mediana 79,3) | 0 | 10, 11, 11 |
| full | 3 | **2 de 3** | 119,7 e 123,4 s; a falha bateu no vigia de 600 s | 0 | 10, 11 (a falha ficou com os 3 da origem) |

**O modelo delegou em todas as 6 execuções [V]**
- Nas 6, o gpt-6.1-sol carregou a skill `delegate` do perfil do dono, que diz que o orquestrador não executa. Na full r2, em vez de carregar a skill, leu o arquivo `SKILL.md` dela. Na full r1 e na full r3, carregou também a skill `quota` e rodou `kit quota`.
- Depois, abriu um subagente do OpenCode (ferramenta `task`, `subagent_type: "general"`) com um briefing reescrito por ele: os passos 3 a 7 em ordem estrita, "não reescreva o slugify", "só lib.mjs e lib.test.mjs".
- O resultado da `task` traz `model: {providerID: "openai", modelID: "gpt-6.1-sol"}`, então o subagente usou o mesmo modelo [V].
- A sessão principal fez 0 edições. As edições do subagente não aparecem no fluxo ACP da sessão principal. Por isso "Escritas" aparece como 0§: **o retrabalho por escrita não foi medido nestas 6**. As linhas perdidas e a avaliação vêm dos arquivos finais e continuam válidas.
- O `usage` (15 a 17 mil tokens) é provavelmente só da sessão principal **[N]**.
- A falha (full r1) foi a `task` do subagente aberta aos 25,9 s, que não voltou mais. Nenhum arquivo mudou (`numstat` vazio, 2 de 6 passos, os da origem), e o vigia matou a execução aos 600 s. Não dá para ver no ACP o que o subagente fazia: o id da sessão filha só aparece no resultado da `task`, que não chegou. A causa (subagente travado, espera do provedor, laço) é **[N]**.

**Comparação (mesmo par e origem no OpenCode; destino Codex com o mesmo modelo)**

| Destino e modelo | min | full | Tempo | Escritas (faltavam 4) |
|---|---|---|---|---|
| OpenCode, flash-lite (padrão) | 1 de 3 | 2 de 3 | 45 a 184 s | 5 a 8 |
| OpenCode, 3.5-flash (exceção) | 2 de 2 | 1 de 1 | 18 a 60 s | 4 |
| OpenCode, Gemma 4 E4B local | 0 de 2 | 0 de 2 | 274 a 1500 s | — |
| **OpenCode, gpt-6.1-sol** | **3 de 3** | **2 de 3** | 73 a 123 s (mais 1 de 600 s) | não medido (§) |
| Codex, gpt-6.1-sol (todas as origens: Claude→Codex e OpenCode→Codex) | 3 de 7 | 7 de 7 | 3 a 28 s | 0 a 1 a mais |

**Leitura**
- **Não é um controle limpo do harness [V]**. Com o perfil do dono, o gpt-6.1-sol no OpenCode não continuou a tarefa, e sim **reorquestrou**: leu o pacote, escreveu um briefing e passou a outro agente. O que foi medido é "gpt-6.1-sol + skill `delegate` + subagente `general`", um segundo bastão dentro do primeiro. O Codex com o mesmo modelo trabalhou direto (as escritas aparecem no ACP).
- **Com essa ressalva, o modelo pesa [N: n=3 por variante]**. Com o min, deu 3 de 3 contra 1 de 3 do flash-lite, na mesma origem. O min também não falhou aqui como falhou no Codex (3 de 7). Uma explicação possível **[N]** é o briefing reescrito: ele transforma o min num pedido explícito de passos, o que faz a reescrita agir como um "full gerado pelo modelo".
- **O custo da delegação é o tempo e a visibilidade [V]**. As execuções certas levaram de 73 a 123 s, contra 3 a 28 s do Codex com o mesmo modelo. A falha é do tipo que o harness do OTheater não enxerga: um subagente interno do cliente travou, o pai ficou esperando sem eventos e só o vigia encerrou.
- **Para a arquitetura (dado, sem decisão nova)**:
  - um Executor que delega internamente esconde as edições do fluxo ACP. A medição de progresso e de retrabalho tem que vir do diff da worktree (já é a pendência "o produto deve medir pelo diff"), não dos eventos de ferramenta;
  - o perfil (skills e instruções do dono) muda o comportamento do destino tanto quanto o modelo. Perfil enxuto contra perfil do dono continua sem medir no bastão (no local-model foi medido com o modo authonly).
- A exceção do 3.5-flash continua registrada. Esta célula é um dado a mais sobre o "modelo mais forte" no destino OpenCode, mas com o desvio da delegação.

Dados brutos em `out/cont-codex-opencode-gpt61sol-{min,full}.r{1,2,3}.json` e `*.wire.jsonl` (git-ignored).

### O que NÃO foi rodado ou ficou incompleto na Rodada 2

- `gemini-3.5-flash` full: só 1 execução válida (2 excluídas por cota diária do tier grátis). **Exceção registrada**: por decisão do dono (2026-11-15), a célula não será completada e foi substituída pela do Gemma 4 E4B local (seção acima).
- Gemma local: n=2 por variante, só raciocínio ligado e só o perfil padrão do OpenCode; sem 3ª execução.
- Modelos free do Zen (GLM-5.3-Flash, DeepSeek V4.1 Flash, MiniMax M3.1 Flash) e Gemma 4 26B/31B pelo Google: 30 execuções feitas, **0 válidas** (chave do Zen expirada; tier grátis do Google com limite de tokens de entrada por minuto e erros do provedor). Nenhum desses modelos tem resultado de qualidade.
- `openai/gpt-6.1-sol` no OpenCode: n=3 por variante, só o perfil do dono (com a skill `delegate`, que o modelo seguiu nas 6 execuções); sem rodada com perfil enxuto (authonly) que deixasse o modelo trabalhar direto, e sem medir as escritas do subagente.
- Origem 2 só tem n=2 por célula; origem 3 e tarefas maiores não foram feitas.
- Nenhum modelo mais forte para os destinos Claude e Codex (usaram o modelo mais barato de sempre), então "destino fraco" só foi separado no OpenCode.
- Retomada nativa com sessões antigas (pós-retenção): não testada.

## Rodada 3 (2026-11-19): n=5 nas 6 direções base e destino OpenCode com gpt-6-luna (item 6 da Fase 5)

Objetivo: o item 6 dos portões da Fase 5 (bastão com n maior). As 6 direções base vão a n=5 por variante, e o destino OpenCode é medido com `openai/gpt-6-luna`, um modelo da conta OpenAI do dono, no lugar do `google/gemini-3.1-flash-lite`. **n=5 continua não sendo estatística**: as execuções foram na mesma máquina, na mesma hora e contra serviços que variam. Tudo abaixo é **[V]** (medido aqui) salvo marca em contrário.

### Como foi feito

- **Script**: novo `src/rep7.sh` (`x`, `y` ou `todos`). O fluxo Y cobre os destinos Claude e Codex, e o fluxo X o destino OpenCode, os dois em paralelo. Foram 48 execuções novas; a primeira terminou às 11:39 e a última às 12:24 (UTC-3). `cont.ts`, `acp.ts` e os pacotes não mudaram. Mesmas origens restauradas por `restore-origins.ts`, mesmo vigia de 600 000 ms e mesmo `timeout -k 10 700` das rodadas anteriores.
- **Par novo `-luna`**: Codex→OpenCode e Claude→OpenCode com `OT_MODEL=openai/gpt-6-luna`, r1 a r5, min e full, nas mesmas origens das células base (`codex-opencode.restored` e `claude-codex.restored`). O OpenCode é o do PATH, com o **perfil do dono** (que inclui a skill `delegate` e o comando `kit`), como na célula do gpt-6.1-sol.
- **`agg.ts`** ganhou o rótulo `-luna`.
- **Codex→OpenCode base ficou com n=4**, não 5. A cópia sem sufixo desse par (`cont-codex-opencode-{min,full}.json`) é o r2 duplicado (mesmo tamanho e mesmo horário), e o `agg.ts` já a descartava. O par tinha r1 a r3, e o `rep7.sh` só acrescentou o r4, porque contou a cópia como uma execução. Não refiz o r5.

### Agregado por célula (direções base e `-luna`)

| Par | Variante | n | ok em n | Mediana do tempo | Faixa do tempo | Linhas perdidas (soma) | Escritas a mais (soma; por execução) |
|---|---|---|---|---|---|---|---|
| Claude→Codex | full | 5 | 4 de 5 | 24,5 s | 22,2 a 25,6 s | 0 | 1 (0, 0, 1, 0, 0) |
| Claude→Codex | min | 5 | 3 de 5 | 20,7 s | 4,7 a 26,2 s | 0 | 0 (0, 0, 0, 0, 0) |
| Claude→OpenCode (flash-lite) | full | 5 | 5 de 5 | 88,1 s | 16,2 a 232,5 s | 2 | 3 (2, 0, 1, 0, 0) |
| Claude→OpenCode (flash-lite) | min | 5 | 5 de 5 | 78,9 s | 59,7 a 318,8 s | 2 | 10 (2, 1, 7, 0, 0) |
| Claude→OpenCode (gpt-6-luna) | full | 5 | 5 de 5 | 59,4 s | 47,9 a 235,8 s | 0 | 2§ (1, 1, 0, 0, 0) |
| Claude→OpenCode (gpt-6-luna) | min | 5 | 5 de 5 | 50,8 s | 32,0 a 59,8 s | 0 | 2§ (0, 1, 0, 0, 1) |
| Codex→Claude | full | 5 | 5 de 5 | 18,2 s | 15,8 a 22,2 s | 0 | 1 (0, 0, 0, 0, 1) |
| Codex→Claude | min | 5 | 5 de 5 | 19,2 s | 18,2 a 22,6 s | 0 | 3 (0, 0, 0, 1, 2) |
| Codex→OpenCode (flash-lite) | full | 4 | 3 de 4 | 104,7 s | 58,6 a 179,6 s | 0 | 7 (2, 2, 1, 2) |
| Codex→OpenCode (flash-lite) | min | 4 | 1 de 4 | 136,5 s | 45,3 a 184,4 s | 3 | 8 (1, 2, 4, 1) |
| Codex→OpenCode (gpt-6-luna) | full | 5 | 4 de 5 | 53,8 s | 41,9 a 71,8 s | 0 | 3§ (1, 0, 0, 1, 1) |
| Codex→OpenCode (gpt-6-luna) | min | 5 | 3 de 5 | 68,3 s | 42,3 a 222,0 s | 0 | 3§ (1, 0, 0, 0, 2) |
| OpenCode→Claude | full | 5 | 5 de 5 | 20,0 s | 17,7 a 26,6 s | 3 | 1 (0, 0, 1, 0, 0) |
| OpenCode→Claude | min | 5 | 5 de 5 | 30,3 s | 18,7 a 39,1 s | 3 | 5 (1, 1, 1, 0, 2) |
| OpenCode→Codex | full | 5 | 4 de 5 | 23,1 s | 18,4 a 26,8 s | 0 | 0 (0, 0, 0, 0, 0) |
| OpenCode→Codex | min | 5 | 3 de 5 | 18,9 s | 3,1 a 35,8 s | 6 | 0 (0, 0, 0, 0, 0) |

As células da origem 2, do 3.5-flash, do Gemma local e do gpt-6.1-sol não mudaram nesta rodada (ver a Rodada 2). "ok em n" segue o critério de antes: testes próprios verdes, aceitação 5/5 e 6 passos. § = como no gpt-6.1-sol, a escrita de um subagente do OpenCode não aparece no fluxo ACP. 11 das 20 execuções com o gpt-6-luna acionaram o `kit` do perfil do dono, então a contagem de escritas dessas células é um piso.

### Leitura

- **Total das direções base com o flash-lite no OpenCode**, somando as rodadas 1 a 3 e a origem 2: **full 32 de 35, min 27 de 35**. A direção "full >= min" se mantém, e a diferença de 5 em 35 ficou parecida com a de 5 em 21 da Rodada 2.
- **Por destino:**
  - Claude: full 12 de 12, min 12 de 12. Continua sem falha, nos dois pacotes, com 18 a 30 s de mediana.
  - Codex: full 10 de 12, min 7 de 12. O "full 7 de 7" da Rodada 2 não se sustentou. As duas falhas novas do full (Claude→Codex r5 e OpenCode→Codex r4) foram testes próprios vermelhos (10/11 e 6/7) com a aceitação em 5/5.
  - OpenCode com o flash-lite: full 10 de 11, min 8 de 11. As 4 falhas continuam todas no par Codex→OpenCode, origem 1; o Claude→OpenCode deu 10 de 10.
- **Recusa "workspace outside the writable roots" do Codex**: 3 de 12 com o min (Claude→Codex r2, OpenCode→Codex r2 e r5; 3 a 5 s, nenhuma ferramenta) e 0 de 12 com o full. A recusa só aparece com o min nas três rodadas. Com n=12 ainda pode ser acaso **[N]**, mas vale a recomendação de usar o full quando o destino for o Codex.
- **gpt-6-luna no lugar do flash-lite (mesmas origens e mesmos pacotes):**
  - Claude→OpenCode: 10 de 10 nos dois modelos. O luna foi mais rápido (mediana de 51 a 59 s, contra 79 a 88 s do flash-lite) e não perdeu linhas.
  - Codex→OpenCode, a origem difícil: luna 7 de 10 (full 4 de 5, min 3 de 5) contra 4 de 8 do flash-lite (full 3 de 4, min 1 de 4).
  - **As 3 falhas do luna são outro tipo de falha**: nenhuma edição e 2 de 6 passos, ou seja, o modelo parou sem continuar.
    - Na full r2, seguiu o fluxo do `kit` do perfil do dono e parou porque `kit wt new` não achou o repositório principal.
    - Na min r2, disse que o caminho do worktree não estava acessível para as ferramentas de edição.
    - Na min r1, delegou a um executor do `kit` que respondeu "DONE", mas a aceitação no worktree da continuação ficou em 0/5. **[N]**: não investiguei onde o executor escreveu.
  - Todas as 3 falhas estão entre as 11 execuções que acionaram o `kit`; nas 9 que não acionaram, nenhuma falhou. Isso é compatível com "o perfil do dono atrapalha o destino", e não com "o modelo é fraco", mas **[N]**: não houve rodada com um perfil enxuto.
  - Leitura **[N]**: o modelo explica parte das falhas do flash-lite na origem difícil, e o harness (o perfil com delegação) explica as do luna. No produto, o perfil do Executor que recebe o bastão não deve carregar instruções que mandem delegar ou mudar de pasta.
- **Perda de linhas**: nenhuma perda funcional nova. As somas de 2 a 6 são reescritas textuais com a aceitação em 5/5, como na Rodada 2.
- **Tempo**: os destinos Claude e Codex continuam estáveis, de 16 a 36 s fora as recusas. O OpenCode continua variando muito no mesmo pacote (16 a 319 s com o flash-lite; 32 a 236 s com o luna).

Dados brutos em `out/cont-*.r{4,5}.json`, `out/cont-codex-claude-*.r3.json`, `out/cont-opencode-codex-*.r3.json`, `out/cont-claude-opencode-*.r3.json`, `out/cont-*-luna-*.r{1..5}.json` e nos `*.wire.jsonl` correspondentes (todos ignorados pelo git).

## Formato do pacote de continuação **[proposta]**

Baseado no que funcionou melhor (variante full: 32 de 35 execuções corretas nas três rodadas, ver Rodada 3; 20 de 21 na Rodada 2 e 4 de 4 na rodada 1). Seções nesta ordem; tudo gerado pelo harness a partir do que registrou, nada da memória do modelo:

1. **Cabeçalho**: quem é você, que não vê a conversa anterior, e que os arquivos do cwd já têm o trabalho feito.
2. **Demanda, contrato e ordens**, texto original, ainda em vigor.
3. **Estado da worktree**: id do commit-base, id do checkpoint e o diff contra o base (bloco `diff`).
4. **Por que parou**: motivo estruturado (processo morto, cota esgotada, limite de contexto, política), dizendo que não é falha da tarefa.
5. **Progresso calculado**: checklist `[x]/[ ]` obtido dos arquivos ou dos testes pelo harness (detector determinístico, §5.16). É o campo que mais protegeu contra retrabalho.
6. **Trajetória registrada** (eventos ACP): arquivos lidos, arquivos editados, comandos e testes com resultado e saída curta, última mensagem do agente, decisões já respondidas, ferramentas em voo (efeito incerto).
7. **Efeitos colaterais já executados** (commit, push, chamadas externas) para que o destino não os repita. Neste spike não houve efeitos externos; **[N]** o campo não foi exercitado.
8. **O que falta**, derivado do checklist.
9. **Instrução final**: "continue deste estado; não refaça o que está marcado como concluído; não reescreva código anterior sem um teste que prove o erro".

Notas: os caminhos absolutos do cwd de origem devem ser normalizados para relativos (feito em `package.ts`); o tamanho foi de ~1,0 a 1,2 mil tokens estimados para esta tarefa pequena, e cresce com o diff e com os comandos, então o resumo de trajetória precisa de teto (aqui: comando 120 caracteres, saída 160, mensagem 400) **[N: tetos ainda sem teste com tarefas grandes]**. A variante min (itens 1 a 3 mais a instrução) bastou para o Claude como destino (12 de 12), mas foi pior com o Codex (7 de 12, com 3 recusas de "writable roots") e com o OpenCode/flash-lite (8 de 11) (Rodada 3); usá-la como padrão seria apostar no destino.

## Pendências (não medido)

- **Estatística**: n=5 nas 6 direções base desde a Rodada 3 (n=4 no Codex→OpenCode base) e n de 1 a 3 nas outras células, uma tarefa pequena (6 passos), uma máquina. Faltam mais repetições e tarefas maiores, com mais passos e diffs grandes. Qualquer proporção acima é indicativa, não estatística.
- **Origem versus destino no OpenCode**: as 3 falhas do flash-lite foram na mesma origem (par B, origem 1). Separar efeito da origem e do modelo pedindo mais origens "difíceis" (progresso fora de ordem) e o 3.5-flash com n maior (a cota diária do tier grátis impediu).
- **Codex com o min**: recusas "writable roots" (2 de 7) e testes próprios vermelhos (2 de 7). Falta saber se a recusa depende do pacote, do modo `workspace-write` ou do acaso, e se vale mandar sempre o full para o Codex.
- **Interrupção por cota ou contexto**: aqui foi SIGKILL após N edições. O caso real (cota esgotada, ver spike `quota-exhaustion`) e o pacote com "por que parou" real não foram combinados. O detector de edições por tipo de ferramenta é cego a escritas por shell (Codex); o produto deve medir pelo diff.
- **Efeitos colaterais externos** e **decisões respondidas** (campos 6 e 7 da proposta): não exercitados.
- **Retomada nativa**: sessões antigas (pós-retenção) não testadas; CLI do OpenCode com `--dir` diferente trava (causa **[N]**).
- **Troca de cliente mantendo o cache de prompt**: não aplicável entre clientes; o `usage` mostra que o prompt do sistema domina o custo (cache de leitura).
- `usage` de OpenCode (`outputTokens` = 3) não confiável [N].
- Retenção real do Claude acima do documentado (38 dias contra 30): causa não investigada.
- Preço do `gemini-3.5-flash` frente ao flash-lite: não verificado [N].
- Destino local (Gemma 4 E4B): separar a causa do 0 de 4 (raciocínio ligado ou desligado, perfil enxuto do OpenCode, modelo maior, parser de ferramentas do Ollama) e medir uma 3ª execução; o `usage` do OpenCode com o modelo local parece só do último passo [N].
- **Modelos free (Zen) e Gemma pelo Google**: 0 execuções válidas de 30. Falta (ação do dono, **[N]** se resolve): renovar a chave do OpenCode Zen (a mensagem do provedor manda criar uma nova no console do OpenCode; não renovo por login) e decidir como rodar o Gemma pelo Google sem o limite de 16 000 tokens de entrada por minuto do tier grátis (o pacote com o perfil do OpenCode já passa disso na 1ª requisição). Depois, repetir `rep6.sh` (r1 a r3, min e full).
- **gpt-6.1-sol no OpenCode sem delegação**: repetir com um perfil enxuto (sem as skills do dono, como o authonly do `local-model`), para ter o controle de harness limpo. Medir as escritas pelo diff da worktree, e não pelos eventos do ACP, quando o destino delegar. Descobrir por que o subagente da full r1 não voltou [N]. Termos da OpenAI para o login do ChatGPT em cliente de terceiros: não lidos (D3) [N].


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
# Destino local (Gemma 4 E4B no Ollama): subir antes spikes/local-model/ollama.sh start; parar com stop ao fim
SPIKE_SCRATCH=<pasta> ./src/rep5.sh min r1 full r1 min r2 full r2   # OPENCODE_CONFIG_CONTENT com o provedor local, OT_MODEL=local/gemma4-e4b, vigia de 1500 s
# Modelos free (Zen) e Gemma pelo Google: perfil padrao do OpenCode, so OT_MODEL muda; rotulo = glm|deepseek|minimax|gemma26|gemma31
SPIKE_SCRATCH=<pasta> ./src/rep6.sh opencode/glm-5.3-flash-free glm min r1 full r1 min r2 full r2 min r3 full r3
# Controle de harness com o modelo do Codex (login do ChatGPT no OpenCode): rotulo gpt61sol
SPIKE_SCRATCH=<pasta> ./src/rep6.sh openai/gpt-6.1-sol gpt61sol min r1 full r1 min r2 full r2 min r3 full r3
# Rodada 3 (item 6 da Fase 5): direcoes base ate n=5 e o par -luna (openai/gpt-6-luna)
SPIKE_SCRATCH=<pasta> ./src/rep7.sh [x|y|todos]
```

Variáveis de `cont.ts`: `OT_ORIGIN` (qual `origin-<nome>.json` ler; padrão = o par), `OT_TAG` (sufixo `.rN` da execução), `OT_MODEL` (modelo do OpenCode, ex. `google/gemini-3.5-flash`), `OT_WATCHDOG_MS` (vigia da execução em ms, padrão 600000). Variáveis de `native.ts`: `OT_CWD2=wt|plain|same` (cwd novo da retomada: worktree irmã, pasta fora do git, ou o mesmo como controle), `OT_CLI_TIMEOUT` (ms, padrão 180000), `OT_NTAG` (sufixo para repetir sem colidir). O OpenCode usa `opencode acp`; o `opencode serve` do dono não é usado.

`src/task.ts` define a pasta de trabalho (scratchpad) e recria o repositório de teste. As saídas (JSON por execução, pacotes `.md`, log de fio ACP `*.wire.jsonl`) ficam em `out/`, ignorado pelo git.

## Arquivos

`src/task.ts` (tarefa, worktrees, detector de progresso, avaliação), `src/acp.ts` (cliente ACP, trajetória, kill da árvore), `src/origin.ts`, `src/package.ts`, `src/cont.ts`, `src/reeval.ts`, `src/native.ts`, `src/run-all.sh`, `src/rep2.sh`, `fixtures/accept.test.mjs`. Rodada 2: `src/restore-origins.ts`, `src/rep3.sh`, `src/rep4.sh`, `src/origin2.sh`, `src/agg.ts` (e ajustes em `cont.ts` e `native.ts`). Destino local: `src/rep5.sh`, `OT_WATCHDOG_MS` em `cont.ts`, rótulo "(gemma local)" em `agg.ts`. Modelos free: `src/rep6.sh` (modelo, rótulo, lista variante/tag), rótulos dos 5 modelos e exclusão por provedor ("excluída (provedor)") em `agg.ts`. Controle com gpt-6.1-sol: rótulo "(gpt-6.1-sol)" em `agg.ts` e `gpt61sol` na lista de rótulos do `rep6.sh`. Rodada 3: `src/rep7.sh` e o rótulo `-luna` em `agg.ts`.
