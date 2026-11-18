# 16. Plano da Fase 5

Versão 1, de 2026-11-17. Este é o plano de passos da Fase 5 da [arquitetura](framework-ideas/arquitetura.md), §10, "Assinaturas, cotas e seleção". A arquitetura continua sendo a referência: este plano só divide a fase em passos, diz o que pode correr em paralelo e dá o aceite de cada passo. Se os dois divergirem, vale a arquitetura, e este documento é corrigido.

O dono liberou o merge dos PRs da Fase 5 sem ok por PR, com a CI verde e squash (2026-11-17). As dez decisões que o plano levanta (N118 a N127) estão **abertas**: nenhuma foi tomada, e cada passo que depende de uma só abre depois dela ([docs/13](13-DECISOES-EM-ABERTO.md)).

## Como usar

- Cada passo tem uma branch e um PR com título "Fase 5: ...". O PR que conclui um passo também muda o estado dele na tabela de passos.
- Todo passo exige, além do aceite próprio, `build`, `lint`, `format:check`, `test`, `verify` e `deps` verdes na máquina e na CI (job `linux`).
- O que está marcado **[proposta]** é detalhe deste plano, ainda sem decisão. Todo padrão novo vira uma chave de configuração, com um padrão e os seus modos. Se a chave mudar algum comportamento visível, a escolha vai ao dono, por múltipla escolha, ao abrir o passo.
- Paralelismo:
  - passos sem dependência entre si correm ao mesmo tempo, cada um no seu worktree;
  - dois passos nunca mexem nos mesmos arquivos, com três exceções, em que cada passo acrescenta só o seu bloco e o conflito se resolve no merge da main na branch: o `DaemonConfigSchema` (`daemon/src/config.ts`), o registro de eventos (`protocol/src/events.ts`) e o `compose.ts`;
  - o que mexe no mesmo arquivo corre em série: `execution/attempt-runner.ts` (P17, P18, P19), `orchestration/director.ts` (P16 e P20), `execution/pool.ts` (P4 e P21) e `store-sqlite/src/migrations.ts` (só o P1);
  - no máximo dois subagentes rodam a suíte completa ao mesmo tempo, por causa da memória da máquina.
- **Nada real roda nos testes (N57), e nenhum teste faz login real nem lê credencial:**
  - login, logout e cotas reais só existem nos testes reais opcionais (`OT_TEST_REAL_*`), que pulam sem as variáveis e rodam sem ok a cada rodada, sem provocar esgotamento (N122, decidida);
  - os testes de perfis e de cotas usam falsos: o agente falso, o cofre em memória e as sondas simuladas (`core/src/testing`);
  - nenhum arquivo de credencial é aberto. A trava da CI (`tools/verify/src/credentials.ts`) recusa em código próprio os nomes de arquivo de credencial e os endpoints `/api/oauth/` e `backend-api/codex` **[V]**.
- **Nenhum download novo sem decisão do dono.** Cada download vira uma linha no docs/13 antes de entrar. Nesta fase há dois candidatos, o `ccusage` (N118) e a releitura do Claudexor (N119); nenhum foi feito.
- **Claudexor (N41, §6.3):** as sondas, o pool, a rotação, a sonda de login e o orçamento têm referência nos arquivos dele, na tag `v6.1.2` (commit `7a87c33`). O passo que adaptar um arquivo dele acrescenta a atribuição no `THIRD_PARTY_NOTICES` e o cabeçalho com projeto, caminho e commit, sem dependência `@claudexor/*` e sem o que lê token ou arquivo de credencial. A lista `tools/verify/copied-code.json` está vazia hoje **[V]**, ou seja, ainda não há código copiado.

## Ponto de partida

O que já existe foi conferido no código em 2026-11-17, no commit `1c3a8e6` **[V]**. Os caminhos são relativos a `packages/`.

- **Portas prontas, sem implementação:**
  - `core/src/ports/quota-probe.ts` tem a `QuotaProbe` (`read`, `watch` opcional, janelas, precisão, entrega `push | poll | both`) e o `QuotaReadingSchema`. Os três adaptadores têm só um esqueleto em `adapters/client-*/src/quota-probe.ts`, que recusa com `AdapterUnavailable` "arrives in Phase 5";
  - `login` e `logout` da `ClientAdapter` (`core/src/ports/client-adapter.ts`) existem com o `LoginFlow` (`browser`, `device_code`, `terminal`), mas Claude Code e Codex recusam com "arrives in Phase 5". O adaptador do OpenCode não foi aberto nesta conferência **[N]**;
  - `core/src/ports/executor.ts` tem `ProfileRef`, `Profile`, `formatProfileId` e `parseProfileId`; `secret-vault.ts` tem o `SecretVault` e o `LockableSecretVault`, com adaptadores `vault-file` e `vault-keyring`.
- **Fio de cota na Fase 1:** `protocol/src/quota.ts` tem os schemas de `_otheater/quota/signal` (com `sessionId`) e do erro `-32001` `QuotaExhausted`; o agente falso os emite (N50). Ninguém consome o sinal **[V]**.
- **Store:** `store-sqlite/src/migrations.ts` tem `events`, `attempts`, `scenarios`, `scenario_repos`, `attachments`, `plays`, `stages`, `demands`, `decisions`, `blackboard`, `prompt_queue`, `side_effects`, `sessions`, `directives` e `ideas`. **Não há** `profiles`, `executors`, `interruptions`, `quota_snapshots`, `usage` nem `wakeups`.
- **Perfis:**
  - `daemon/src/paths.ts` tem `profileDirOf` (`<data>/profiles/<cliente>/<perfil>/`) e cada adaptador prepara o diretório (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` com `cli_auth_credentials_store = "file"`, XDG e `OPENCODE_DB`);
  - **não há** cadastro de perfil, ciclo de vida (`active`, `draining`, `removed`), comando `ot profile` nem aviso de segunda conta. A CLI (`daemon/src/cli.ts`) só tem `daemon`, `backup`, `restore`, `directives` e `chat`.
- **Executores e papéis:** a configuração tem um Executor fixo por papel em `orchestration.executor` e `orchestration.roles.<papel>` (`PlayExecutorSchema`: `client`, `profile`, `model`). **Não há** `executors.*`, `roles.preset`, `roles.<papel>.executors` (lista), `when_exhausted`, `selection.*` nem `profiles.*`. Também não há o evento `executor.selected` **[V]**.
- **Cota e consumo:** não há `QuotaService`, estado do perfil, `usage.*`, tabela `pricing`, `budget`, `wakeups`, `quota.restored` nem `quota.recheck_every`. Uma busca por `quota.`, `budget.`, `usage.` e `wakeup` em `packages/**/*.ts` só achou o esqueleto das sondas e o erro `-32001` **[V]**.
- **Admissão:** o pool (`daemon/src/execution/pool.ts`) conta sessões (`pool.max_sessions`, `sessions_per_process`) e não olha RAM livre nem cota. O que existe de memória: `min_free_memory_mb` do navegador (`browser-playwright`, com `os.freemem`) e o `MemAvailable` do `k-measure-fixture.ts`, só para medir. A porta `LocalModelServer` lê os `slots` da instância, mas nada os liga ao pool **[V]**.
- **Retomada:**
  - o `attempt-runner.ts` já retoma de forma **nativa** (`session/load`) a queda do cliente e o erro transitório, com recuo exponencial, `resume.max_resumes`, `resume.max_free_resumes` e o vigia de travamento; o `reconcile.ts` retoma as sessões de um reinício do daemon;
  - o checkpoint por lote, por tempo e na interrupção existe (`checkpoints.ts`), e os eventos `session.interrupted` e `session.resumed` já distinguem as causas e as formas (`native`, `handoff`);
  - a cota esgotada (`QUOTA_EXHAUSTED`) vira `interrupted` com `native: false` e `needsDecision: true`: a sessão fica parada, porque "a passagem de bastão é do Diretor", e ela **não existe**: não há pacote de continuação, nem `AWAITING_RESUME`, nem tabela `interruptions`;
  - os valores de `resume.*` (predefinições `balanced`, `patient`, `agile`) estão na configuração, mas `quota_wait_max` e a regra `wait`/`next` não têm quem os leia **[V]**.
- **Failover do Orquestrador:** o Diretor dorme e acorda com o resumo do estado tirado do store (`core/src/state-summary.ts`, `orchestration/director.ts`: `summaryNeeded`). Uma falha de turno só marca a sessão como `failed` e para a fila; **não há** troca para o próximo Executor da lista **[V]**.
- **Idempotência dos efeitos:** a tabela `side_effects`, a porta `SideEffectRegistry`, os verificadores de `git_commit` e `open_pr`, a chave `attempt_step` e a reconciliação na subida existem (Fases 3 e 4; `workspace/effects.ts`, `recovery/reconcile.ts`, `tools/git-tools.ts`). O `install_deps` está no registro como efeito `worktree` e não grava `side_effects` **[V]**. Plugins só existem na Fase 9 **[N]**.
- **Fase 0, o que mediu e o que ficou:**
  - **[V]** a statusline do Claude traz `rate_limits.five_hour` e `seven_day` (`used_percentage` inteiro, `resets_at`), 2,2 a 2,5 s depois de abrir o cliente; o Codex responde `account/rateLimits/read` em 0,41 a 0,72 s; o isolamento por variável de ambiente vale nos três clientes; a retomada nativa e a passagem de bastão funcionam entre os clientes (pacote `full`: 20 de 21; `min`: 15 de 21);
  - **[N]** ficaram pendentes (portões da Fase 5, N48): o segundo login em nenhum cliente (item 7), a cota esgotada com assinatura real e o `resetsAt` (item 4), a unidade de `utilization` com valor alto (item 10), a chave da MiniMax (item 11), o bastão com n maior (item 6) e a leitura dos termos da OpenAI (D3). O ACP não devolve estruturado o horário de volta da cota nos três clientes (N42).
- **Máquina:** os clientes ficam no `PATH` do dono, mas este plano não rodou nenhum **[V]**. O que for real é opcional e fica nos níveis `OT_TEST_REAL_*` (N122).

## Dependências novas

Nenhuma está aprovada. A única candidata é o **`ccusage`** (MIT, TypeScript, **[S]**: é o que a arquitetura diz; a licença, a versão e se ele exporta uma API **não foram conferidos** **[N]**). Entra só pelo P12, depois da N118, com versão fixa e mais de duas semanas de publicada. O P12 é o único passo que a decisão trava; o resto da fase corre sem ele, porque o consumo vem dos sinais dos clientes (P10).

O que já está no repositório e a fase reaproveita: `@napi-rs/keyring` (cofre), o `vault-file` e as portas de modelo local. Não há mais nada a baixar, salvo a releitura do Claudexor (N119), que é código de referência e não dependência.

## Passos

| Passo | Título | Depende de | Pode correr junto com | Estado |
|---|---|---|---|---|
| P0 | Plano e decisões (este documento) | nada | nada | concluído (PR #90) |
| P1 | Esquema do store da fase: perfis, Executores, interrupções, cota, consumo e despertares | P0 | P3, P4, P22 | concluído (PR #96) |
| P2 | Perfis: serviço, cofre e ciclo de vida | P1 | P3, P4, P5, P13, P22 | concluído (PR #101) |
| P3 | Login e logout oficiais nos três adaptadores | P0 | P1, P2, P4, P22 | concluído (PR #98) |
| P4 | Admissão por RAM, vagas e cota | P0 | P1, P2, P3, P22 | concluído (PR #95) |
| P5 | `QuotaService`: sinais, estado do perfil e frescor | P1 | P2, P13, P4 | concluído (PR #100) |
| P6 | Sonda de cota do Claude Code | P5 | P7, P8, P9, P10, P14, P17 | pendente |
| P7 | Sonda de cota do Codex | P5 | P6, P8, P9, P10, P14, P17 | pendente |
| P8 | Sondas da MiniMax e do OpenCode e o erro de limite | P5 | P6, P7, P9, P10, P14, P17 | pendente |
| P9 | Despertares e reconsulta (`wakeups`) | P5 | P6, P7, P8, P10, P14, P17 | pendente |
| P10 | Consumo e custo em moeda | P5 | P6, P7, P8, P9, P14, P17 | pendente |
| P11 | Teto de gasto em API | P9, P10 | P12, P15 | pendente |
| P12 | `ccusage` como `UsageSource` (trava na N118) | P10 | P11, P15 | pendente |
| P13 | Executores e papéis na configuração | P1 | P2, P5, P4 | concluído (PR #99) |
| P14 | Cadastro de Executores do OpenCode e validação de capacidade | P13 | P6 a P10, P17 | pendente |
| P15 | Seleção por papel: algoritmo, retry por diversidade e eventos | P4, P5, P13 | P11, P12 | pendente |
| P16 | Seleção no pipeline: o fim do Executor fixo | P15 | P18, P19, P21 | pendente |
| P17 | Interrupção: classificação da causa e política por causa | P1, P5 | P6 a P10, P14 | pendente |
| P18 | Pacote de continuação e passagem de bastão | P15, P17, P22 | P16, P20 | pendente |
| P19 | Espera pelo reset e retomada nativa depois dele | P9, P18 | P20, P21 | pendente |
| P20 | Failover do Orquestrador | P16, P17 | P18, P19, P21 | pendente |
| P21 | Remoção de perfil com sessões em curso | P2, P16, P18 | P19, P20 | pendente |
| P22 | Idempotência dos efeitos na retomada | P0 | P1 a P4 | concluído (PR #97) |
| P23 | Aceite da fase | todos | nada | pendente |

Ordem em ondas **[proposta]**:
1. P1, P3, P4 e P22;
2. P2, P5 e P13;
3. P6, P7, P8, P9, P10, P14 e P17 (a N122 e a N123 antes do P6 ao P8; a N125 antes do P10);
4. P11, P12 (só depois da N118) e P15;
5. P16 e P18;
6. P19, P20 e P21;
7. P23.

**Marco 5a [N120, decidida]:** perfis, cota, consumo, teto e seleção, com o Diretor redistribuindo quando um perfil esgota (simulado). São o P1 ao P11, o P13 ao P16 e o primeiro item do critério de aceite. Fecha com o P16. O marco 5b (retomada completa, failover e remoção) fecha com o P23.

**Estimativa:** 2,5 semanas para a fase inteira, como na §10 (1,5 a 2 com agentes; ≈ 6–18 h pelo ritmo medido nas Fases 1 a 3) **[proposta]**. Com 23 passos, contra 11 da Fase 4, é provável ficar na parte alta da faixa **[N]**.

### P1. Esquema do store da fase (§7)

**Escopo:**
- Uma só migração, `store-sqlite/src/migrations.ts`, com as tabelas da §7 que a fase usa **[proposta]**:
  - `profiles` (id, cliente, tipo `token_plan | api`, provedor da conta, estado `active | draining | removed`, diretório, referência do segredo, aceite do aviso de segunda conta);
  - `executors` (id completo `<modelo>-<esforço>@<cliente>/<perfil>`, perfil, modelo, esforço, `provider` do modelo, validade `valid | invalid`);
  - `interruptions`, `quota_snapshots`, `usage` e `wakeups`, com as colunas da §7.
- As portas no `core/src/ports/store.ts` (um repositório por tabela), os schemas zod de cada linha, as implementações do `store-sqlite` e os falsos em memória em `core/src/testing`.
- Os tipos de evento vão ao registro nos passos que os emitem; este passo só cria o que é de tabela.
- Só este passo toca na migração: os passos seguintes usam as tabelas sem mudar o esquema. Se um passo achar que falta uma coluna, abre um PR pequeno antes dele **[proposta]**.

**Aceite:** a migração sobe do esquema da Fase 4 sem perder linha (teste com o banco da Fase 4 de fixture); cada repositório faz criar, ler, listar e atualizar; o falso em memória passa a mesma suíte de contrato que o SQLite; `PRAGMA foreign_key_check` limpo.

**Como ficou (2026-11-18):**
- Migração `0009_profiles_executors_quota_usage` em `store-sqlite/src/migrations.ts`, uma só, com `IF NOT EXISTS`, sem chave estrangeira, como as anteriores. Seis tabelas: `profiles`, `executors`, `interruptions`, `quota_snapshots`, `usage`, `wakeups`. [V]
- Portas novas em `core/src/ports/` (`profiles`, `executor-records`, `interruptions`, `quota-snapshots`, `usage`, `wakeups`), um repositório por tabela, com schema zod por linha; `StoreAggregates` ganha seis campos e `STORE_PORT_VERSION` vai a `0.5.0`. Os repositórios são escritos uma vez sobre `RecordTable` (store-kit), então SQLite e falso em memória compartilham a lógica. [V]
- Aceite: a migração sobe de um banco montado só com as migrações da Fase 4 (0001 a 0008), com linhas de evento, diretiva e ideia que sobrevivem; `PRAGMA foreign_key_check` volta vazio; a suíte `describeProfileAggregatesConformance` roda no SQLite (os dois drivers) e no falso em memória. [V] (`migrations.test.ts`, `sdk/src/conformance/profile-aggregates.ts`)
- Nenhum tipo de evento criado e nenhuma chave de configuração nova. [V]
- [proposta] Ids: `X<n>` (interrupção), `U<n>` (consumo), `W<n>` (despertar), numerados no store inteiro; perfil `<cliente>/<nome>`; Executor `<modelo>-<esforço>@<perfil>` (sem esforço: `<modelo>@<perfil>`).
- [proposta] Perfil: transições `active -> draining`, `draining -> active | removed`, `removed` final; recriar um perfil removido dá `Conflict`; o aceite do aviso de segunda conta é a coluna `notice_accepted_at`. Preço mensal e orçamento ficam na configuração, não no store.
- [proposta] Executor: o patch só muda `provider`, `validity` e `invalidReason`; o repositório não confere se o perfil existe (sem chave estrangeira).
- [proposta] `quota_snapshots` guarda o último estado por (perfil, janela), com `put` em upsert. `usage` não tem coluna de janela (a janela é um intervalo sobre `occurred_at`); o custo é aninhado, `null` significa desconhecido (nunca zero) e `pricing_table` exige `pricingVersion`. `interruptions.signals` é lista de textos.
- [proposta] `wakeups`: no máximo um `scheduled` por (perfil, causa), garantido pelo repositório (`Conflict`) e por índice único parcial no SQL; só um `scheduled` pode ser atualizado.
- [proposta] O `core` duplica o vocabulário de causas e formas de retomada (`INTERRUPTION_CAUSE_NAMES`, `RESUME_FORM_NAMES`) porque não importa o `protocol`; um teste no `protocol` confere que as listas são iguais.
- [V] O store-kit ganhou `ranges` (`gte`/`lte`) em `RecordQuery` e `boolean` em `TableSpec`; não mudam o comportamento das tabelas existentes.

### P2. Perfis: serviço, cofre e ciclo de vida (§5.6)

**Escopo:**
- Um `ProfileService` no daemon:
  - **cadastra** um perfil (assinatura ou API): cria o diretório isolado com `profileDirOf`, chama o `prepareProfile` do adaptador e grava a linha em `profiles`; o nome é único dentro do cliente e o id é `<cliente>/<perfil>`;
  - **chave de API** vai ao `SecretVault` e é injetada como variável de ambiente só no processo do Executor, nunca em arquivo do perfil nem em log; o daemon diz qual backend do cofre está em uso;
  - **drenagem:** `active → draining` (sem sessão nova; as em curso terminam ou voltam à fila), depois logout, depois remoção do diretório e `removed`; os Executores do perfil ficam `invalid`, sem quebrar as listas dos papéis;
  - **aviso de segunda conta** de assinatura do mesmo provedor, com o aceite gravado no perfil: `profiles.same_provider_notice: once | always | off` (padrão `once`); conta de API nunca dispara.
- Comandos `ot profile add | list | drain | remove` (§5.12), com a saída em texto e em JSON. A tela do assistente fica para a Fase 7 (N121).
- O logout e a remoção chamam a `ClientAdapter` pela porta; aqui com o adaptador falso.
- Sem leitura de credencial: o serviço só sabe "tem login ou não" pela sonda de login do P3.

**Aceite:** com o cofre em memória e o agente falso: criar três perfis (dois do mesmo cliente), um deles de API; o aviso aparece uma vez na segunda assinatura e nunca na chave de API; `drain` não entrega sessão nova; `remove` apaga o diretório e deixa os Executores `invalid`; a chave nunca aparece no ambiente de outro perfil nem no log (teste de varredura). Os testes reais ficam em N122.

**Como ficou (2026-11-18):**
- [V] `ProfileService` em `packages/daemon/src/profiles/`: `add`, `list`, `drain` e `remove`, com 28 testes (cofre em memória, adaptador falso, sem processo real). O aceite passa: três perfis (dois do mesmo cliente, um de API), o aviso uma vez na segunda assinatura e nunca na chave de API, `drain` sem sessão nova, `remove` apaga o diretório e deixa os Executores `invalid`, e a varredura não acha a chave no ambiente de outro perfil, nos eventos, no store, no log nem em arquivo.
- [V] A chave de API vai ao `SecretVault` (referência `profile/<cliente>/<nome>/api-key`) e entra só no ambiente do processo daquele perfil, por `ClientAdapterOptions.secretEnv`, resolvido a cada lançamento a partir da linha do perfil e do cofre. O daemon liga isso em `buildExecution`; o evento `profile.added` e o comando dizem o backend do cofre, nunca a chave.
- [V] Protocolo: eventos `profile.*` (o registro do protocolo foi de 45 para 50 tipos e o do daemon de 47 para 52; os dois testes de contagem são ponto provável de conflito com os outros passos da onda). A porta do cliente ganhou `probeLogin`, `setUpProfile` e `secretEnv` como métodos opcionais.
- [V] `ot profile add | list | drain | remove` com texto e `--json`, sem tela (N121). A chave nunca é argumento: vem de `--api-key-env <NOME>` (nome da variável) ou de `--api-key-stdin`. O comando segue o padrão de `ot directives`: toma o lock do diretório de dados, então com o daemon rodando ele recusa (código 1).
- [proposta] Chaves novas, todas em `config.yaml`: `profiles.same_provider_notice: once | always | off` (padrão `once`); `profiles.drain.timeout` (padrão `10m`); `profiles.drain.on_timeout: handoff | wait | force` (padrão `handoff`); `profiles.drain.removed_dir: delete | keep_backup` (padrão `delete`, com o logout antes); `profiles.api_key_env` (mapa provedor para nome da variável; os padrões `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` e `MINIMAX_API_KEY` são proposta). Os padrões da drenagem e do aviso são os da N127, que continua **aberta**: o passo não a decidiu.
- [proposta] O aviso de segunda assinatura é neutro quanto aos termos do provedor: diz que o OTheater não confere o que eles permitem e manda o dono lê-los (fonte e data dos termos ficam para quem decidir a N127). O aceite fica em `noticeAcceptedAt` e no evento `profile.notice_accepted`.
- [proposta] A remoção confere que o diretório gravado é o que o nome do perfil dá, nunca segue link simbólico e só apaga dentro de `<dados>/profiles`; `keep_backup` move para `<dados>/profiles/.removed/`. Falha no logout não impede a remoção; uma remoção interrompida no meio termina na repetição.
- [N] **Drenagem ao vivo.** O `pool.ts` não tem API por perfil e não foi tocado. `ProfileService.acceptsSessions(perfil)` é o gancho de disponibilidade para o pool (P21, P4). O `ProfileSessions` padrão só mexe nas linhas do store: não conta nem para processo vivo. A contagem por perfil e o `handoff`/`force` de sessões vivas dependem de P21, P18 e P20; aqui o `handoff` só devolve as sessões à fila. Pelo `ot`, a drenagem usa tempo limite 0 (o comando segura o lock, então as linhas `active` são sobras); o controle de um daemon em execução pede o canal próprio do daemon, que não existe.
- [N] Se cada cliente real lê a chave pelas variáveis acima (e se o `probeLogin` real dá o estado certo num perfil de API) só se sabe nos testes reais do nível `profiles` (N122). O login de uma assinatura é feito pelo próprio cliente, na pasta do perfil; `ot profile add` apenas diz o estado.

### P3. Login e logout oficiais nos três adaptadores (§5.2 e §5.6)

**Escopo:**
- `login()` e `logout()` dos adaptadores do Claude Code, do Codex e do OpenCode, rodando o **fluxo oficial do cliente** dentro do diretório do perfil, sem nunca ler o token:
  - o `LoginFlow` informa o modo (`browser`, `device_code` ou `terminal`), uma URL ou código para mostrar ao dono e uma promessa que resolve quando o login termina;
  - o Codex oferece `api-key` e `chat-gpt` no `authMethods` **[V, Fase 0]**; o Claude responde `authMethods: []` e aceita `session/new` sem login **[V]**; como cada cliente faz o login oficial por linha de comando é **[N]** e o passo confere na ajuda do cliente, sem rodá-lo;
  - a **sonda de login** (tem login ou não, sem ler token) usa a resposta de `session/new` ou o método de conta do cliente: o Codex devolve `-32000 "Authentication required"` em perfil vazio **[V]**. A referência é o `probeLogin` do Claudexor, só como desenho (§6.3). O que não der por esse caminho fica [N] e vira medição opcional.
- O adaptador não toca em `auth.json`, `.credentials.json` nem em endpoint de OAuth; a trava da CI confere.
- As chaves de API continuam pelo cofre e por variável de ambiente (P2).

**Aceite:** com o cliente falso (processo que imita a saída do login), cada adaptador devolve o `LoginFlow` no modo certo, resolve ao fim, cancela com `Cancelled` e faz o logout; a sonda de login diz "sem login" num perfil vazio e "com login" depois do fluxo falso; nenhum teste lê arquivo de credencial; a CI de credenciais passa. O login e o logout reais, com uma segunda conta, só no nível opcional `profiles` (N122).

**Como ficou (2026-11-18):**
- `login()`, `logout()` e `probeLogin()` nos três adaptadores (`official-login.ts`, igual nos três pacotes pela regra `adapter-isolation`). O `LoginFlow` do núcleo não mudou. `login()` devolve o fluxo quando viu o que o modo precisa (URL; URL e código no `device_code`; o `terminal` não espera), quando o processo terminou ou após `urlWaitMs`. `complete()` resolve no código 0; `PermissionDenied` em saída diferente de zero, sinal ou tempo esgotado; `cancel()` mata a árvore e `complete()` rejeita com `Cancelled`. A saída do cliente nunca é registrada e nenhum token é lido. [V] nos testes com o cliente falso (`src/testing/fake-official-client.ts`); nenhum login nem logout real rodou.
- O que a ajuda de cada cliente disse (só `--help`) [V]: Claude Code `auth login [--claudeai|--console|--email|--sso]`, `auth logout`, `auth status [--json|--text]`; Codex `login [--device-auth|--with-api-key|--with-access-token]`, `login status`, `logout`; OpenCode `auth list|login [url] [-p -m]|logout [provider]`.
- Padrões [proposta]: Claude `claude auth login --claudeai` (modo `browser`), `claude auth logout`; Codex `codex login` (`browser` e `terminal`) e `codex login --device-auth` (`device_code`), `codex logout`; OpenCode `opencode auth login [-p provider] [-m method]` (modo `terminal`), `opencode auth logout [provider]`. Chaves, todas [proposta]: `clients.<id>.login.mode`, `.command`, `.logout_command`, `.url_wait_ms` (15000), `.timeout_ms` (600000); `clients.claude-code.login.status_command`; `clients.opencode.login.provider`, `.method`, `.list_command`.
- Sonda de login: Claude lê o booleano `loggedIn` de `claude auth status --json`, porque o `session/new` do Claude funciona sem login [V]; Codex abre uma sessão com política que nega tudo e `-32000 "Authentication required"` é "sem login" [V, Fase 0]; OpenCode lê a contagem de `auth list`. Resultado `logged_in | logged_out | unknown`; o que não dá para ler é `unknown`, nunca "sem login" por palpite.
- Em aberto [N]: o que cada comando imprime (formato da URL e do código do dispositivo); se rodam sem TTY (o menu do OpenCode); os códigos de saída; o JSON de `claude auth status --json`; a redação de `opencode auth list`; se `opencode auth logout` sem provedor pergunta. O `LoginFlow` não tem canal de entrada, então um passo em que o cliente pede para colar um código é [N]. A conferência real, com uma segunda conta, fica no nível `profiles` (N122).

### P4. Admissão por RAM, vagas e cota (§5.9)

**Escopo:**
- O pool passa a decidir a admissão por **RAM livre, vagas e cota**, em vez de só contar sessões:
  - uma porta `MemoryProbe` (RAM disponível: `MemAvailable` no Linux, equivalente nos outros sistemas) em `adapters/platform-posix`, com falso para os testes;
  - chave `pool.admission.mode: slots | ram | ram_and_quota` **[proposta]** e o custo estimado por sessão de cada cliente (`pool.<cliente>.session_mb`, `auto` mede a árvore de processos do cliente no início) **[proposta]**; o padrão sai da medição do nível `k` da Fase 2 **[N]**;
  - uma sessão que não cabe espera na fila do pool, sem erro;
  - o gancho de cota: a admissão consulta uma função `canAdmit(perfil)` que o P15 liga ao `QuotaService`; até lá ela diz sempre que sim.
- O semáforo de **comandos pesados** continua separado (Fase 4, P3); este passo só confere que as duas filas não se misturam.
- **Modelo local:** os `slots` da instância (`LocalModelServer`) viram a vaga do pool daquele perfil; `reserve_for_director` (`0 | <número> | all`, padrão `1`) e `reserve_when` (`listed | always | never`, padrão `listed`), como na §5.9 **[proposta, v0.23]**; a memória do modelo é da instância, e o semáforo conta o processo do cliente por sessão e a instância uma vez só.

**Aceite:** com a `MemoryProbe` falsa: com RAM abaixo do mínimo, a sessão espera e entra quando a RAM sobe; com `slots: 2` na instância local, a terceira sessão do perfil espera; uma vaga reservada ao Diretor não é dada a um Ator; `mode: slots` mantém o comportamento de hoje; o gancho de cota recusa quando o falso diz "esgotado".

**Como ficou (2026-11-18):**
- **Porta e sonda** [V, testes locais]: `MemoryProbe` em `packages/core/src/ports/memory-probe.ts` (versão `0.1.0`; `availableMb()` e `treeMb(pid)` opcional, nenhum rejeita) e `FakeMemoryProbe` em `core/testing`. A implementação `PosixMemoryProbe` (`adapters/platform-posix`) lê `MemAvailable` de `/proc/meminfo` e soma o PSS da árvore por `smaps_rollup`. Fora do Linux ela usa `os.freemem()` **[N]**: não foi testada em macOS nem Windows. A porta ainda não está na tabela da §5.18 **[proposta]**.
- **Chaves novas** (todas **[proposta]**; o dono decide qualquer padrão diferente):
  - `pool.admission.mode: slots | ram | ram_and_quota`, padrão `slots` (o comportamento de antes do P4);
  - `pool.admission.min_free_mb`, padrão `2048`;
  - `pool.admission.recheck`, padrão `5s` (de quanto em quanto tempo a sessão que espera olha de novo a RAM e a cota);
  - `pool.admission.unknown_ram: admit | wait`, padrão `admit` (o que fazer quando a sonda não sabe a RAM);
  - `pool.<cliente>.session_mb` (número ou `auto`), padrão **320** para o Claude Code, **150** para o Codex e **520** para o OpenCode. Os números saem da medição do nível `k` de 2026-11-16 (PSS por sessão após um prompt, processo sozinho: 313,6, 150,1 e 521,9 MB) arredondados para cima [V, N74]. Cliente fora da tabela: 512.
- **Admissão** [V, `execution/admission.test.ts`]: em `slots` a fila é servida de forma síncrona e a sonda nunca é lida; em `ram` e `ram_and_quota` a fila é FIFO, a sessão que não cabe espera sem erro, a RAM de sessões ainda abrindo é reservada (a `MemAvailable` ainda não caiu por elas), uma sessão grande que espera por RAM não é ultrapassada por pequenas, e o pool olha de novo ao fim de cada sessão, a cada `recheck` e em `pool.wake()`. Modo `ram` ou `ram_and_quota` sem sonda é `InvalidInput` na construção.
- **Cota** [V]: gancho `canAdmit(perfil)` (padrão: sempre sim, até o P15 ligá-lo ao `QuotaService`). É consultado uma vez por perfil por rodada, só em `ram_and_quota`; uma exceção conta como "não". Um perfil sem cota não segura os outros.
- **Modelo local** [V, no pool]: `slots` da instância viram a vaga do perfil, `reserve_for_director` e `reserve_when` seguem a §5.9; o Diretor (`PoolRequest.director`, passado por `orchestration/director.ts`) pode usar as vagas reservadas e o Ator não. A memória da instância não entra na conta por sessão.
- **`session_mb: auto`** [V no teste com sonda falsa]: depois que um processo compartilhado recebe uma sessão, o pool mede a árvore e guarda a maior parcela por sessão. Cliente de um processo por sessão (Claude Code) não expõe o pid ao pool, então `auto` fica no padrão dele **[N]**.
- **Duas filas** [V]: o semáforo de comandos pesados (`tools/semaphore.ts`) é outra instância e não se mistura com a fila do pool (teste dedicado).
- **Ainda [N] / em aberto:**
  - o daemon não liga `localInstance` nem a lista de perfis do Diretor (`directorProfiles`): não existe ainda a chave `profiles.*.local` no daemon. O pool e os testes cobrem o mecanismo; falta a ligação, que depende de decisão sobre onde o bloco `local` mora;
  - o padrão `pool.admission.mode: slots` é do dono; trocar para `ram` ou `ram_and_quota` muda o comportamento;
  - nenhuma rodada real com RAM de verdade foi feita (só a leitura do `/proc/meminfo` por teste com texto de exemplo).

### P5. `QuotaService`: sinais, estado do perfil e frescor (§5.6)

**Escopo:**
- O gerente único no daemon (`compose.ts`, §5.18):
  - recebe o `_otheater/quota/signal` das cascas (`window`, `usage`, `limit_hit`) e o erro `-32001`, e associa cada um ao perfil pela `sessionId`;
  - recebe as leituras das sondas (`QuotaProbe.read` e `watch`) e as grava em `quota_snapshots`;
  - mantém o estado de cada perfil: `ok | near_limit | exhausted(untilReset, cause: quota | budget) | unknown`;
  - aplica o **frescor**: uma leitura velha nunca autoriza rota (a leitura expira em `quota.stale_after`), como no Claudexor, e uma janela que falta é `unknown`, não `ok`;
  - responde `canUse(perfil)` à seleção e à admissão, e `statusOf(perfil)` às interfaces;
  - emite `quota.updated`, `quota.near_limit`, `quota.exhausted` e `quota.restored` **[proposta]** no registro de eventos.
- O fallback universal: um erro de limite (429 ou mensagem) com o horário de reset marca o perfil `exhausted` até o reset; sem horário, `exhausted` com a consulta do P9.
- Chaves **[proposta]**: `quota.near_limit_at` (fração, padrão `0.8`), `quota.stale_after` (padrão `10m`), `quota.probe.delivery: both | push | poll` (padrão `both`). Os padrões vão à N123.
- Referência: os parsers e o veredito com frescor do Claudexor (`harness-claude/src/quota.ts`, `harness-codex/src/quota.ts`, `orchestrator/src/account-pool.ts`), com atribuição (N119).

**Aceite:** com sondas simuladas e o agente falso: uma janela a 85% leva a `near_limit`; um `-32001` com `resetsAt` leva a `exhausted` com o horário; uma leitura velha vira `unknown` e `canUse` recusa; um sinal de outra sessão do mesmo perfil soma no mesmo estado; o estado de um perfil não muda o de outro; a cota continua `exhausted` depois de reiniciar o daemon (vem do `quota_snapshots`).

**Como ficou (2026-11-18):**
- `daemon/src/quota/` tem o `QuotaService` (`service.ts`), as regras puras de estado e frescor (`state.ts`) e a leitura das chaves (`settings.ts`). O estado é função pura das linhas de `quota_snapshots` e do relógio, então o reinício recalcula o mesmo estado. O daemon cria o serviço, entrega a ele a sonda de cada cliente (`ClientAdapter.quota`), chama `quota.start()` depois de montar a execução e o expõe em `DaemonHandle.quota`. [V]
- Aceite, todos com sondas simuladas (`SimProbe`) e o formato de erro do agente falso (`code: -32001`, `data.type: 'QuotaExhausted'`), em `quota/service.test.ts` e `quota/state.test.ts`: janela a 85% vai a `near_limit` (e `canUse` continua `true`); `-32001` com `resetsAt` vai a `exhausted` até o horário; leitura velha vira `unknown` e `canUse` recusa; sinais de duas sessões do mesmo perfil somam no mesmo estado; o estado de um perfil não muda o de outro; `exhausted` continua depois de um novo serviço sobre o mesmo store, sem anunciar de novo. [V]
- Eventos novos no `protocol` (`quota-events.ts`, `schemaVersion` 1): `quota.updated`, `quota.near_limit`, `quota.exhausted`, `quota.restored`. [proposta] Nomes e campos; a arquitetura só nomeia `quota.restored`. O que a hora muda sozinha (um reset, uma leitura que envelhece) também vira evento: um vigia acorda o serviço na próxima fronteira, e o início do daemon fecha o que o reinício perdeu (um `quota.restored` que faltou). [V]
- Chaves novas, todas **[proposta]**, com os padrões da recomendação do plano (N123 continua aberta): `quota.near_limit_at: 0.8` (fração em (0, 1]), `quota.stale_after: 10m`, `quota.probe.delivery: both | push | poll` (padrão `both`) e `quota.probe.poll_every: 5m` (intervalo da leitura por `read`). `push` só assina `watch` e nunca lê; `poll` só lê; `both` faz os dois, e uma sonda sem `watch` cai no `read`. [V]
- [proposta] Regra de frescor: uma linha é fresca se `agora - observedAt <= stale_after` e o reset dela, se houver, ainda não passou. Uma janela cheia (100% ou mais) com reset no futuro continua `exhausted` mesmo com a leitura velha (recusar é o lado seguro). Sem `resetsAt`, só vale enquanto fresca. Uma janela que a sonda declara em `capabilities().windows` e que não tem leitura fresca deixa o perfil `unknown`; uma sonda sem janelas declaradas não exige nenhuma.
- [proposta] Um erro de limite vira uma linha de `quota_snapshots` na janela reservada `limit_hit` (causa `quota`) ou `budget_hit` (causa `budget`), a 100%, para sobreviver ao reinício como qualquer leitura. Com horário: `exhausted` até ele. Sem horário: `exhausted` até uma leitura fresca, mais nova que o erro, com folga em toda janela (o que a P9 consulta); um novo erro sem horário guarda o horário de um erro anterior ainda no futuro. A causa `budget` só termina no reset (ou fica até alguém limpar), e nenhum cliente a alimenta ainda: `ingestLimitHit` a recebe explicitamente.
- [proposta] Sessão para perfil: `bindSession(sessionId, perfil)` (o pool liga ao abrir, P15) e, sem ele, a linha de `sessions` do store (`client`/`profile`, ou `clientSessionId`). A sessão do lançador (`launcher`) e a que não se resolve são recusadas com um aviso (o `ingest*` devolve `false`). O sinal `usage` é aceito e não muda o estado.
- [S] Os formatos de `resetsAt` do sinal (texto ISO, segundos ou milissegundos) são aceitos por `parseResetsAt`; o texto que os clientes reais mandam e a unidade de `utilization` **[N]** não foram medidos.
- [N] `planType` do `QuotaReading` vai só no evento `quota.updated`: a tabela `quota_snapshots` não tem coluna para ele, então não sobrevive ao reinício.
- [N] Ligar o fluxo vivo das sessões (`_otheater/quota/signal`, o erro do prompt e o `rate_limit` normalizado) ao `ingest*`, o pool (P15) e as sondas reais (P6 a P8) ficam fora deste passo. Enquanto não houver sonda com leituras, um perfil fica `unknown` e `canUse` recusa: é o P15 que decide se tenta um perfil `unknown` (por `statusOf`), e o P9 que consulta o `exhausted` sem horário.

### P6. Sonda de cota do Claude Code (§5.6)

**Escopo:**
- O `prepareProfile` do Claude grava, no `settings.json` do perfil isolado, um comando de statusline que grava o JSON recebido em disco no perfil; a sonda lê esse arquivo e normaliza `rate_limits.five_hour` e `seven_day` (`used_percentage`, `resets_at`). O comando vence a statusline do usuário por `--settings` **[V, Fase 0]**.
- O `rate_limit_event` do stream vira `_otheater/quota/signal` quando o adaptador o repassa. A unidade de `utilization` é fração de 0 a 1 em 1% e **não foi medida com valor alto** **[N]**: o parser aceita a fração e o percentual, recusa o que sair de 0 a 100 e registra a unidade que viu.
- A statusline só se atualiza depois de uma resposta (2,2 a 2,5 s após abrir o cliente, sem prompt, origem [N]); por isso a sonda é de entrega `push`/`poll` por arquivo, e o perfil sem leitura fica `unknown`.
- O comando da statusline não chama o modelo nem a rede, e não grava nada além do JSON da cota.

**Aceite:** com arquivos de fixture tirados da Fase 0 (sem credencial): a leitura vira janelas com o reset; um JSON sem `rate_limits` vira `unknown`; o valor fora da faixa é recusado com o motivo; o `rate_limit_event` falso vira sinal; o arquivo é lido sem seguir link simbólico para fora do perfil. A leitura real só no nível opcional `quota` (N122).

### P7. Sonda de cota do Codex (§5.6)

**Escopo:**
- Um `codex app-server` **leve**, por perfil e só para sondar, com o `CODEX_HOME` do perfil: `account/rateLimits/read` na leitura e `account/rateLimits/updated` no `watch`. A leitura direta devolveu `usedPercent` inteiro, `windowDurationMins` 300 e 10080, sem tokens, em 0,41 a 0,72 s **[V, Fase 0]**; o adaptador ACP do Codex não repassa a cota estruturada **[V]**.
- Os tipos vêm de `codex app-server generate-ts`, que roda o binário **sem login e sem rede**; o passo guarda a saída como fixture e não roda o cliente na CI **[proposta]**. Se o dono preferir não rodar nem isso, os tipos são escritos à mão a partir da Fase 0 **[N]**.
- O processo leve tem tempo limite e é encerrado em grupo (como os outros processos do daemon); um perfil sem login responde `Authentication required` e fica `unknown`, não `exhausted`.
- Não conta cota nem chama modelo; se o arranque do cliente conta cota é **[N]** (pendência da Fase 0).

**Aceite:** com um `app-server` falso que fala o protocolo: a leitura vira janelas com `resetsAt` e `planType`; a notificação `updated` atualiza o estado; sem login, `unknown`; o processo não deixa órfão no encerramento nem no tempo limite; nenhum arquivo de credencial é aberto.

**Como ficou (2026-11-18):**
- `CodexQuotaProbe` (`packages/adapters/client-codex/src/quota-probe.ts`) sobe um `codex app-server` por leitura, com `CODEX_HOME` e diretório de trabalho no perfil, manda `initialize`, `initialized` e `account/rateLimits/read` e encerra a árvore (grupo de processos) ao ter a resposta, no tempo limite e no `dispose` **[V, testes com um app-server falso e uma árvore com neto]**. Nunca chama `account/read` nem `account/rateLimits/consume*`.
- Os tipos foram escritos à mão a partir da saída de `codex app-server generate-ts` (codex-cli 0.170.0, rodado uma vez, com `CODEX_HOME` vazio, sem login e sem rede) e guardados como fixture reduzida; a CI não roda o cliente **[V]**. Não foi copiado código do Claudexor (li só o `quota.ts` de referência, no commit `8210f18`), então `THIRD_PARTY_NOTICES.md` e `copied-code.json` não mudaram.
- `account/rateLimits/read` vira janelas `5h` (300 min) e `7d` (10080 min), com `resetsAt` em milissegundos (o protocolo manda segundos) e `planType`; outra duração vira `Nd`, `Nh` ou `Nm`, e sem duração vale o nome do espaço (`primary`, `secondary`) **[V, fake]**; os nomes de outras durações são **[proposta]**.
- Sem login: o erro de autenticação do `app-server` (ou o processo que sai dizendo isso) vira `AdapterUnavailable`, o `QuotaService` mantém o perfil `unknown` e `canUse` é falso; nunca `exhausted` **[V, teste de integração em `packages/daemon/src/quota/codex-probe.test.ts`]**. O texto real do erro nesta rota é **[N]**: a regex de `looksLikeAuthFailure` é um palpite, a partir do `-32000` "Authentication required" do ACP **[V, Fase 0]**.
- `account/rateLimits/updated`: com `watch: resident`, o `watch` entrega a primeira leitura e funde cada notificação esparsa na última visão (janelas da notificação substituem as antigas, o plano é mantido) **[V, fake]**; a regra de fusão é **[N]**. Sem `watch`, nada é iniciado.
- Nenhum arquivo de credencial é aberto: o código da sonda não importa `node:fs`, e um teste registra as operações de arquivo e confirma que só o `config.toml` do perfil (por `prepareProfile`) é tocado, com `auth.json` intacto **[V]**.
- Chaves **[proposta]**, com padrão que não muda o comportamento de hoje: `clients.codex.quota.command` (padrão `codex app-server`), `clients.codex.quota.timeout` (`15s`), `clients.codex.quota.watch` (`off` ou `resident`; padrão `off`) e `clients.codex.quota.windows` (padrão vazio, para um plano de uma janela só não ficar `unknown`). Nenhum evento novo nem chave de registro: os testes de contagem não mudam.
- Em aberto **[N]**: se subir o `app-server` conta cota; o comportamento de `updated` durante turnos reais (na Fase 0 não chegou sem turno); se `excludeResetCreditDetails` vale em versões antigas do cliente; a resposta de um perfil com chave de API (provavelmente sem janelas, que vira `AdapterUnavailable`); `ordinaryUsageAllowed === false` não é mapeado; a janela `limit_reached` (100%, sem reset) para um limite alcançado sem janela cheia é **[proposta]**; um `app-server` residente que morre não é reiniciado (o polling continua).

### P8. Sondas da MiniMax e do OpenCode e o erro de limite (§5.6)

**Escopo:**
- **MiniMax (Token Plan):** `GET /v1/token_plan/remains` com a chave do cofre, janelas de 5 h e semanal. O schema da resposta **não é documentado** **[S, Fase 0]**: o parser é estrito, trata resposta desconhecida como `unknown` e registra o formato visto. Uma chave falsa devolveu HTTP 200 com `base_resp.status_code: 1004` **[V]**, e o parser trata isso como "sem leitura", não como esgotado. O formato real depende da chave do dono (item 11) **[N]**.
- **OpenCode:** sem API de cota, a sonda é a **contabilidade local** (consumo somado dos eventos de uso da sessão e, se o banco do próprio OpenCode ajudar, a leitura somente-leitura dele, sem tocar no arquivo de autenticação) mais o erro de limite. Quanto o `usage` do OpenCode cobre, em modelo local, é **[N]** (Fase 0).
- **Erro de limite** universal (429 e mensagem com horário de reset): o `normalize` de cada adaptador já classifica o erro; este passo fecha o caminho até o `QuotaService` (P5) com o horário de reset e a fonte (`rate_limit_event`, `429`, `mensagem`).
- A chamada de rede da MiniMax passa pela política de rede do daemon (camada 3 não se aplica: é o próprio daemon).

**Aceite:** com um servidor HTTP local falso: leitura boa, `1004`, corpo desconhecido, tempo limite e 429, cada um com o estado esperado; a sonda do OpenCode soma o consumo de uma sessão falsa e passa a `near_limit`; um erro de limite sem horário marca `exhausted` com a consulta do P9. A MiniMax real só no nível `quota`, com a chave do dono (N122).

### P9. Despertares e reconsulta (§5.6, "Retomada quando a cota ou o teto voltam")

**Escopo:**
- Ao esgotar um perfil, o daemon grava um **despertar** em `wakeups` (perfil, causa `quota | budget`, horário, estado): o `resetsAt` da sonda, ou a virada do período do teto (P11).
- No horário, o gerente: volta o perfil a `ok` e emite `quota.restored` ou `budget.restored`; acorda as tentativas em `AWAITING_RESUME` que esperavam o perfil (P19); passa as demandas da fila sem Executor disponível de novo pela seleção (P15); libera as tarefas agendadas adiadas por cota (§5.15, Fase 9b, só o gancho) **[proposta]**.
- **Consulta sem horário** (`quota.recheck_every`, padrão `15m`, `off` desliga): só sinais que **não chamam o modelo** (a sonda do Codex, a da MiniMax, o último JSON da statusline do Claude). O perfil sem sinal sem custo (Claude, OpenCode) passa de `exhausted` a `unknown` depois do intervalo, e a próxima sessão real serve de teste.
- Os despertares sobrevivem a reinício e queda: o que venceu com o daemon parado roda na subida, pela reconciliação (§5.21). O gatilho do sistema operacional para acordar a máquina é o do agendador (Fase 9b) e **não existe ainda** **[N]**; o passo entrega o relógio do daemon e a reconciliação.

**Aceite:** com o relógio falso: o despertar vence e o perfil volta a `ok` com o evento; o reinício do daemon antes do horário mantém o despertar; o vencido com o daemon parado roda na subida; a reconsulta nunca chama o modelo (o agente falso conta as chamadas: zero); `recheck_every: off` não consulta; duas quedas seguidas não duplicam o despertar (chave única).

### P10. Consumo e custo em moeda (§5.6)

**Escopo:**
- O evento `usage.recorded` **[proposta]** por turno, com sessão, perfil, Executor, modelo, tokens, custo e a **fonte** (`client` ou `pricing_table`) com a versão da tabela; grava em `usage`. O consumo vem do `usage_update` do ACP e do sinal `usage`; o `ccusage` (P12) é uma segunda fonte, não a primeira.
- A tabela `pricing` (US$ por milhão de tokens) que vem com cada versão e que a configuração sobrescreve. O valor de cada modelo precisa de fonte e data (N125). **Modelo sem preço** deixa o custo `unknown`, e `unknown` nunca vale US$ 0 (regra do `budget` do Claudexor).
- `usage.subscription_display: quota_and_equivalent | quota | prorated` (padrão `quota_and_equivalent`) e `usage.cost_source: client_then_pricing | pricing_table | provider_billing` (padrão `client_then_pricing`), como na §5.6. O `prorated` usa `monthly_price_usd` do perfil. O `provider_billing` fica **[a confirmar por provedor]** e este passo só o aceita na configuração, sem adaptador.
- Perfil de API: custo real por sessão, peça, Executor, perfil e período. Perfil de assinatura: uso da cota e o equivalente em API, que é estimativa para comparar contas.
- `usage.api_gateway: off` continua desligado (depois da v1).

**Aceite:** com sinais de consumo do agente falso: o custo real de um perfil de API bate com tokens × tabela; o custo do cliente vence o da tabela em `client_then_pricing`; `pricing_table` ignora o do cliente; modelo sem preço vira `unknown` e a soma do período o marca; o equivalente em API de uma assinatura não é somado ao gasto real; a consulta por sessão, Executor, perfil e período devolve a mesma soma.

### P11. Teto de gasto em API (§5.6)

**Escopo:**
- `profiles.<id>.budget` (`daily_usd`, `monthly_usd`, `warn_at`, `on_exceeded: skip | wait | ask`, `in_flight: handoff | finish | stop`) e `executors.<nome>.budget` dentro do teto do perfil; vale o mais restritivo, também contra o orçamento por execução das tarefas agendadas (§5.15).
- O gasto soma a cada evento de consumo (P10). Em `warn_at` (padrão `[0.8]`) sai uma mensagem de sistema e o evento `budget.warning` **[proposta]**; ao estourar, o perfil fica `exhausted` com causa `budget` até virar o período (dia e mês no fuso do daemon, à meia-noite e no dia 1), com o despertar do P9.
- `skip` (padrão) segue para o próximo Executor da lista; `wait` espera o período; `ask` pergunta ao Diretor e, sem ninguém olhando, vira `skip`. Em `in_flight`, `handoff` (padrão) interrompe a sessão e passa o bastão sem contar como tentativa (o gancho do P17), `finish` termina a sessão e `stop` para e pergunta, e sem ninguém olhando passa o bastão.
- O teto pode passar pelo custo da última chamada, porque ele só se conhece depois dela **[V na §5.6]**. O teto sugerido na primeira execução (US$ 20 por dia, US$ 200 por mês) é do assistente, que é da Fase 7 (N121); aqui vale o valor da configuração.

**Aceite:** com o agente falso e o relógio falso: o aviso em 80%; o estouro leva o perfil a `exhausted(budget)` e a seleção segue para o próximo; cada `on_exceeded` e cada `in_flight` com um teste; `ask` sem ninguém olhando vira `skip`; virar o dia ou o mês devolve o perfil a `ok` com `budget.restored`; o teto do Executor menor que o do perfil vence.

### P12. `ccusage` como `UsageSource` (§5.6 e §6.2)

Trava na **N118**. Sem a decisão, o passo não abre, e a fase fecha com o consumo dos sinais (P10).

**Escopo:**
- Um adaptador `UsageSource` opcional (`adapters/usage-ccusage`), com a versão fixa que o dono aprovar, sob a forma que ele escolher (biblioteca, se exportar API; senão, a CLI como nível C) **[proposta]**.
- Ele lê os logs locais dos três clientes e aceita vários `CLAUDE_CONFIG_DIR` (um por perfil). Os logs ficam no diretório do perfil e podem ter conteúdo da conversa: o adaptador lê só os campos de consumo, não repassa texto e não lê credencial.
- O `ccusage` **não informa a cota restante**, por isso as sondas continuam.
- O verificador de licenças roda no PR do passo, e o `THIRD_PARTY_NOTICES` é gerado de novo.

**Aceite:** com logs de fixture escritos pelo teste (nunca os do dono): o consumo por perfil bate com o dos sinais; uma divergência acima de uma tolerância aparece como aviso **[proposta]**; sem o pacote instalado, o daemon sobe e usa só os sinais; `deps` e `verify` verdes com a dependência nova.

### P13. Executores e papéis na configuração (§5.7)

**Escopo:**
- `executors.<id>` com `client`, `profile`, `model`, `effort` (`low | medium | high`) e `provider` (a família do modelo; fixo pelo cliente no Claude Code e no Codex), com o nome sempre `<modelo>-<esforço>@<cliente>/<perfil>`. Perfil que não existe deixa o Executor `invalid`.
- `roles.<papel>.executors` (lista ordenada) e `when_exhausted: next | wait` para **todos** os papéis (Diretor, Consultor, Autor, Revisor, Roteirista, Crítico e Atores), mais `roles.preset: quality | balanced | economical` (padrão `quality`) expandida pelas contas que existem, e `roles.<papel>` individual vencendo a predefinição.
- `executors.cross_client: api_only | off | any` (padrão `api_only`); `executors.on_register: ask | preset_only | none` (padrão `ask`); `roles.capability_check: warn | block | off` (padrão `warn`) e `roles.<papel>.requires` (contexto 32k, 64k e 128k; `reasoning`), com os números **[proposta]** da §5.7 até a medição.
- **Override por camada**, como a política do papel da Fase 4: global, `config.yaml` do projeto, cenário de origem, cenário e tarefa agendada; a lista de um papel dada no cenário **substitui** a global só naquele papel; `preset` no cenário troca a base; `roles.allowed_profiles` só restringe contas e vale depois da expansão **[proposta]**.
- **Compatibilidade:** `orchestration.executor` e `orchestration.roles.<papel>` (um Executor fixo por papel) continuam valendo como lista de um item, até o P16 trocar o pipeline; um aviso de depreciação **[proposta]**.
- O parse recusa nome de Executor mal formado, perfil repetido e lista vazia, com o nome da chave.

**Aceite:** testes de esquema: a predefinição `quality` expande para as contas de uma máquina de exemplo (`claude-code/empresa`, `codex/conta-1`, `opencode/minimax-api`, `opencode/local`) na ordem da tabela da §5.7; um item sem conta é tirado da lista; o override do cenário substitui só o papel citado; `allowed_profiles` tira as contas de fora; `capability_check: block` recusa um Executor abaixo do mínimo e `warn` o aceita marcado; o formato antigo continua carregando.

**Como ficou (2026-11-18):**
- Funções puras em `core/src/executor-roles/` (`names`, `presets`, `resolve`): o nome `<modelo>-<esforço>@<cliente>/<perfil>` (e `<modelo>@...` sem esforço), a tabela de predefinições da §5.7, `resolveRoleExecutors` e `planRegistration`. O esquema de configuração está em `daemon/src/role-executors-config.ts` (chaves `executors.*` e `roles.*`) e a ligação com as camadas em `daemon/src/orchestration/role-executors.ts`. Nada chama a resolução ainda: o Diretor e o pipeline seguem lendo `orchestration.executor` até o P16. [V] (testes de `core` e do `daemon`)
- Padrão que não muda o comportamento de hoje: sem `executors` e sem `roles.executors`, `parseConfig('')` só ganha `executors: {cross_client: api_only, on_register: ask, entries: {}}`, e `roles` continua vazio (os padrões são aplicados na resolução, para as camadas distinguirem "não dito"). [V]
- Expansão: para cada item da predefinição (`<modelo>-<esforço>`), uma entrada por conta que o tem, o cliente oficial da família primeiro (anthropic: Claude Code; openai: Codex), depois a ordem das contas, depois o id. Item sem conta sai da lista, com aviso `no_account`. [V]
- Camadas: configuração global, depois `configOverride` de cada cenário da cadeia `originScenarioId` (o mais antigo primeiro; o projeto é um cenário), depois o override de uma tarefa agendada, passado como argumento (o agendador é da Fase 6). Aceita chave pontilhada (`roles.author.executors`) e aninhada, como a política do papel da Fase 4. A lista de um papel dada numa camada substitui a de baixo só naquele papel; `when_exhausted` e `requires` valem chave a chave. [V]
- `capability_check: block` lança `InvalidInput` para um item de lista escrita à mão e tira o item de uma expansão de predefinição; `warn` mantém o item com `shortfalls` e um aviso; capacidade desconhecida nunca reprova. [V]
- `cross_client`: `api_only` aceita uma família fora do seu cliente só em perfil `api`; `off` recusa sempre; `any` aceita. Recusado vira `invalid` (`cross_client_refused`) numa lista escrita à mão. [V]
- Compatibilidade: `orchestration.executor` e `orchestration.roles.<papel>` entram como lista de um item, abaixo das listas novas e acima da predefinição; o daemon avisa uma vez por chave antiga na partida (`deprecationWarnings`). [V]
- [proposta] Duas chaves a mais, que a §5.7 não nomeia: `roles.preset_scope: all | unset_roles` (padrão `all`: um `preset` numa camada derruba as listas das camadas de baixo, "troca a base de todos os papéis"; `unset_roles` as mantém) e `roles.api_fallback: preset_models | all_registered | off` (padrão `preset_models`: o passo 3 da primeira execução, que põe no fim de cada lista os Executores de perfil `api` cujo `<modelo>-<esforço>` a predefinição cita em algum papel que não seja o Diretor; é o caso do minimax do exemplo).
- [proposta] `k` vale 1000 tokens e `m` 1000000 (`128k` passa com um modelo que declara 128000). O `when_exhausted` dos papéis que a tabela não marca é `next` (o Crítico é `wait`, os Atores `next`).
- [proposta] `executors.cross_client` e `executors.on_register` são só globais. `allowed_profiles` de uma camada posterior substitui a anterior (não faz interseção). "Perfil repetido" vale para `allowed_profiles` e um Executor repetido numa lista de papel também é recusado.
- [N] O `provider` de `claude-code` e `codex` é fixo pelo cliente: um valor diferente é recusado. Isso bloqueia, por ora, o MiniMax por gateway do Claude Code; se o dono quiser permitir, é decisão dele.
- [proposta] `planRegistration` devolve o que o `on_register` manda (`ask`: as opções por papel, marcadas onde a predefinição cita o modelo; `preset_only`: só essas posições; `none`: nada). Quem aplica é o comando `ot executor add` do P14.

### P14. Cadastro de Executores do OpenCode e validação de capacidade (§5.7)

**Escopo:**
- A lógica do cadastro, no daemon e sem tela (N121): ler `opencode models --verbose` no diretório do perfil (`providerID`, `family`, `api.url`, `cost`, `capabilities`, `variants`), pré-preencher esforço, `provider` (a partir de `family`), `local` (por `localhost` ou `127.0.0.1`, o que cria o bloco `local` do perfil) e custo (para a `pricing`), e deixar o campo vazio quando a `family` vier vazia (42 de 532 modelos, **[V, Fase 0]**).
- A **validação**: o modelo existe, o esforço está nas `variants`, o modelo chama ferramentas (`toolcall`). A sessão de teste curta (chamar uma ferramenta e entregar um `submit` válido) roda no agente falso nos testes e, no real, só no nível opcional.
- Comandos `ot executor add | list | check | remove`. O que `executors.on_register` manda (perguntar os papéis, só a predefinição ou nada) é aplicado pelo comando; a pergunta vem como lista de opções na saída, e a tela fica para a Fase 7.
- Os Executores do Claude Code e do Codex são descobertos pelos `ModelCatalog` que já existem, e o `on_register` vale para eles também.

**Aceite:** com o catálogo de fixture do OpenCode: o cadastro pré-preenche os campos; a `family` vazia deixa o `provider` em branco e a validação pede o campo; `toolcall` falso recusa; o `local` cria o bloco do perfil; `on_register: preset_only` põe o Executor só onde a predefinição o cita; a sessão de teste do agente falso aprova e reprova.

### P15. Seleção por papel (§5.7)

**Escopo:**
- O seletor, em `core`, com o algoritmo da §5.7 para cada demanda ou etapa:
  1. percorre a lista na ordem;
  2. um Executor é **disponível** quando o perfil está `active` e saudável, o `QuotaService` diz que pode (P5), há vaga e a admissão permite (P4), e o prompt da demanda cabe na janela dele (no modelo local, a janela por slot) **[proposta]**;
  3. pega o primeiro disponível;
  4. sem ninguém: `next` espera o primeiro que liberar, `wait` espera o reset do primeiro sem rebaixar;
  5. **retry com diversidade:** a nova tentativa de uma demanda que falhou começa pelo Executor seguinte ao da anterior.
- **Revisão cruzada** `selection.cross_check: prefer_other_provider | require_other_provider | other_model | off` (padrão `prefer_other_provider`): o Revisor e o Crítico pulam os Executores do mesmo provedor de quem fez o trabalho. O `provider` `unknown` vale como diferente de todos.
- Cada escolha vira o evento `executor.selected` com os Executores pulados e o motivo de cada um (`quota`, `budget`, `draining`, `invalid`, `no_slot`, `ram`, `context`, `same_provider`) **[proposta]**.
- O estado `unknown` e o `near_limit` na ordem da lista são da N124. O desempate é estável: a ordem da lista.
- Referência: `account-pool.ts` do Claudexor (ranking por folga e "cota velha nunca autoriza rota"), só onde não contradiz a ordem da lista da arquitetura.

**Aceite:** testes de unidade do seletor com sondas simuladas: o primeiro disponível; o pulo de cada motivo, com o evento; `next` e `wait`; o retry começando pelo seguinte; as quatro opções do `cross_check`; o `allowed_profiles` do cenário; o prompt que não cabe na janela; o evento sempre traz a lista dos pulados. **Critério de aceite da fase, 1º item, no nível do seletor:** com dois perfis do mesmo cliente, esgotar um (simulado) faz o seguinte da lista ser escolhido.

### P16. Seleção no pipeline: o fim do Executor fixo (§5.7)

**Escopo:**
- Todo lugar que hoje abre uma sessão de papel com o Executor fixo (`orchestration.executor`) passa a chamar o seletor: Diretor, Consultor, Autor, Revisor, Roteirista, Crítico e Atores (`pipeline/`, `orchestration/`, `execution/`). O Executor escolhido e o `executor.selected` ficam na tentativa.
- A demanda sem Executor disponível fica na fila com o motivo e volta pela seleção quando o P9 acorda (`quota.restored`); o Diretor e o chat mostram "esperando cota de ...".
- A seleção respeita o override por cenário e por tarefa (P13) e o `allowed_profiles`.
- Remove o aviso de depreciação do P13 quando o formato antigo não for mais necessário, se o dono quiser **[proposta]**.

**Aceite:** com o agente falso, dois perfis do mesmo cliente e uma peça completa: esgotar um perfil no meio (sinal simulado) faz as demandas novas irem ao outro, com `executor.selected` explicando; sem nenhum perfil, a demanda espera e continua depois do `quota.restored`; as sessões em curso não mudam com a mudança de configuração (§5.7). **Fecha o marco 5a.**

### P17. Interrupção: classificação da causa e política por causa (§5.16)

**Escopo:**
- A **classificação** pelos sinais que existem: `stopReason`, código de saída, `rate_limit_event`/429 e a sonda (P5), tempo limite e travamento (o vigia do `attempt-runner` já mede). A causa vai ao evento `session.interrupted` e à tabela `interruptions` (causa, sinais, forma de retomada, Executor de origem e destino, se contou como tentativa).
- A **política por causa**, como função pura e testável, com a tabela da §5.16: cota com reset próximo e regra `wait` → esperar e retomar nativa; cota com reset longe ou `next` → passagem de bastão; teto estourado → pela chave `in_flight`; erro transitório → nativa com recuo (o que já existe); queda do cliente → nativa, depois bastão; reinício → nativa se os arquivos existirem; tempo limite, travamento e recusa → como na tabela.
- **Contagem:** a interrupção de causa externa (cota, rede, queda, reinício) **não** consome as tentativas da demanda; só as falhas atribuíveis ao agente. O limite próprio de retomadas por tentativa (`resume.max_resumes`, padrão 5) leva o caso ao ponto de julgamento do Diretor. A queda do cliente não conta na primeira vez e conta se repetir.
- O `attempt-runner` deixa de "estacionar" a cota com `needsDecision` e passa a devolver a **ação** da política; a execução da ação é do P18 (bastão) e do P19 (espera). Até lá, a ação de bastão cai no comportamento de hoje.

**Aceite:** teste de tabela com uma linha por causa da §5.16: a ação, se conta como tentativa, e a linha em `interruptions`; a cota não gasta tentativa; a queda repetida gasta; passar de `max_resumes` vai ao ponto de julgamento; os testes de retomada nativa da Fase 2 continuam verdes.

### P18. Pacote de continuação e passagem de bastão (§5.16)

**Escopo:**
- O **pacote de continuação**, montado do store e nunca da memória de um modelo, com as cinco partes: (1) demanda, contrato, critérios de aceite e as ordens vigentes no momento da retomada, com o mesmo prefixo estável do papel; (2) estado da worktree, com o último commit de checkpoint e o diff contra a base; (3) o resumo determinístico da trajetória (arquivos lidos e editados, comandos e testes com o resultado, última mensagem, decisões do Produtor já respondidas); (4) os efeitos colaterais já executados, da `side_effects` (P22); (5) o motivo e a instrução "continue deste estado; não refaça o que está concluído".
- Resumo longo: um modelo barato pode condensar, com o determinístico anexado como fonte da verdade (`resume.package.summarize`, N126).
- A **passagem de bastão**: o seletor (P15) escolhe o próximo Executor disponível do papel, abre uma sessão nova com o pacote e a máquina de estados da tentativa faz `INTERRUPTED → AWAITING_RESUME → RESUMING(handoff) → EXECUTING`; a nativa que falha cai na de bastão; eventos `session.interrupted` e `session.resumed` com a forma e os Executores de origem e destino, e a mensagem de sistema no chat.
- Papéis de saída curta (Revisor, Roteirista, Crítico): o bastão é refazer com as anotações parciais **[proposta]**.
- A tentativa que passou o bastão não volta ao Executor anterior quando ele se recupera.
- Referência: `rotation-predicate.ts` do Claudexor (só trocar de conta se a tentativa não entregou nada). A arquitetura manda trocar sempre que a cota acaba, então o predicado entra só como desenho do que o pacote deve dizer, não como regra (N126).

**Aceite:** com o agente falso: um Ator interrompido por cota esgotada recebe o bastão em outro perfil, com o pacote de cinco partes, **sem refazer commits nem instalações já feitos** (a chave `attempt + step` devolve o resultado gravado); a nativa que falha vira bastão; o pacote leva as ordens vigentes no momento da retomada e não as do início; o resumo é o mesmo para os mesmos eventos (determinístico); a tentativa não gasta tentativa da demanda; o pacote não carrega segredo nem caminho de credencial. O bastão entre clientes reais só no nível opcional (N122).

### P19. Espera pelo reset e retomada nativa depois dele (§5.16)

**Escopo:**
- A cota esgotada com reset **dentro do limite** (`resume.quota_wait_max`, padrão 30 min) e regra `wait` do papel: a tentativa vai a `AWAITING_RESUME`, grava o despertar (P9) e, no `quota.restored`, retoma de forma **nativa** (`session/load`) no mesmo perfil, sem gastar tentativa. A mesma espera vale para o teto de gasto com `on_exceeded: wait`.
- Reset **mais longe** que o limite, ou regra `next`, vira bastão (P18).
- Sobrevive a reinício do daemon: a tentativa em `AWAITING_RESUME` e o despertar vêm do store, e a subida os reconcilia (§5.21); se os arquivos da sessão do cliente sumiram (retenção), o `session/load` falha e vira bastão.
- O contador de retomadas gasto na espera continua no registro da tentativa.

**Aceite:** com o relógio falso e o agente falso: outro Ator, com `wait`, espera 10 min e retoma de forma nativa depois do reset; com reset a 2 h, vira bastão; o reinício do daemon durante a espera mantém tudo; o `session/load` que falha vira bastão; o evento diz `native` e a espera aparece no chat. **Critério de aceite da fase, 2º item de "Também faz parte".**

### P20. Failover do Orquestrador (§5.4)

**Escopo:**
- Quando a sessão do Diretor falha por cota esgotada, erro do provedor ou queda, o daemon abre uma sessão **nova** com o próximo Executor da lista do papel `director`, com o resumo do estado tirado do store (`stateSummaryOf`: estado da peça, decisões pendentes, ordens vigentes, últimas mensagens), pelo mesmo caminho do despertar do Diretor (`summaryNeeded`).
- Hoje a falha do turno só marca `failed` e para a fila (`director.ts`); passa a ser classificada pelo P17 e a seleção escolhe o seguinte.
- Sem nenhum Executor disponível na lista do Diretor, a fila espera, avisa o Produtor com o motivo e retoma no `quota.restored`; o chat mostra a espera.
- O prompt que estava em curso volta à fila do Diretor (`prompt_queue`) e não se perde; a fila continua em ordem.

**Aceite:** com o agente falso: a cota do Diretor esgota no meio de um turno e a peça continua no Executor seguinte, **sem perder a peça nem o prompt**; o resumo traz as ordens vigentes; sem Executor, a fila espera e retoma; o evento do failover traz origem, destino e causa. **Critério de aceite da fase, 3º item.**

### P21. Remoção de perfil com sessões em curso (§5.6)

**Escopo:**
- A drenagem do P2, ligada ao pool e à retomada: o perfil em `draining` não recebe sessão nova (a seleção o pula com o motivo `draining`); as sessões em curso terminam ou, passado o tempo limite da drenagem, voltam à fila **com passagem de bastão** (P18), sem perder a demanda; só então vêm o logout e a remoção do diretório.
- Chaves **[proposta]**, na N127: `profiles.drain.timeout` (padrão `10m`) e `profiles.drain.on_timeout: handoff | wait | force`.
- Os Executores do perfil removido ficam `invalid`, e as listas dos papéis seguem sem eles; uma lista que ficou sem nenhum Executor válido avisa o Produtor.
- A remoção apaga só o diretório do perfil dentro de `<data>/profiles/`, nunca fora dele (`confinePath`).

**Aceite:** com o agente falso: remover um perfil com duas sessões em curso termina uma e passa o bastão da outra, sem perder demanda; o perfil removido nunca é escolhido; os Executores ficam `invalid`; a lista sem Executor válido avisa; o diretório fora de `<data>/profiles/` nunca é apagado (teste com caminho malicioso). **Critério de aceite da fase, 2º item.**

### P22. Idempotência dos efeitos na retomada (§5.16 e §5.21)

**Escopo:**
- O que já existe (Fases 3 e 4) cobre `git_commit`, `open_pr` e o navegador. Este passo fecha o que falta na retomada:
  - `install_deps` e as outras cascas com efeito passam a gravar `side_effects` antes e depois, com a chave `attempt + step` **[V: hoje só o `git_commit` grava]**;
  - a mesma chave depois de uma retomada devolve o resultado gravado em vez de executar de novo;
  - um efeito com "antes" e sem "depois" é **ambíguo** e a reconciliação (§5.21) o resolve pelo verificador da ferramenta ou pergunta ao Produtor; nunca repete às cegas;
  - uma consulta `effectsOf(attempt)` devolve os efeitos já executados, que o P18 põe no pacote.
- **Plugins:** a regra "plugin com `external_write` declara no manifesto se aceita a chave; senão pede confirmação do Produtor antes de repetir" é da Fase 9 (plugins) e **não existe nada para aplicar** hoje **[N]**. O passo deixa o gancho e o teste de contrato com um plugin falso.

**Aceite:** com o agente falso e a worktree de teste: repetir o `install_deps` com a mesma chave devolve o resultado gravado, sem rodar; um "antes" sem "depois" é resolvido pelo verificador ou vira pergunta ao Produtor; a consulta `effectsOf` lista o que foi feito; a reconciliação da subida continua verde.

**Como ficou (2026-11-18):**
- **Cascas com efeito** [V: `command-effects.test.ts`]: `install_deps`, `run_tests` e `restricted_shell` gravam o "antes" e o "depois" em `side_effects` com a chave `<play>:<ferramenta>:<attempt>:<passo>` (retentativas `~2`, `~3`). `src/tools/command-effects.ts` faz isso em volta do `runCommand`; os handlers e as regras de argv não mudaram. Um comando que falha ou estoura o tempo grava `failed` com a saída (`EffectFailed`) e a resposta ao agente continua a de antes.
- **Reaproveitar a chave** [V]: `install_deps` com o mesmo comando e o mesmo conteúdo dos arquivos de dependências (`package.json`, lockfiles etc.) que a última instalação concluída devolve o resultado gravado com `reused: true`, sem rodar. Mudou um manifesto, ou a última execução falhou, ou há uma execução aberta depois: roda de novo como passo novo. A chave do passo é por chamada (o agente não manda chave); a "mesma chave" é, na prática, o mesmo comando sobre as mesmas entradas. [proposta]
- **"Antes" sem "depois"** [V]: o verificador de comando (`verifyCommand`, em `workspace/verifiers.ts`) diz `not_done` para `install_deps` e `run_tests` (rodam do comando do projeto e convergem; `tools.effects.open_command: rerun_safe`) e `ambiguous` para `restricted_shell` (o que o modelo mandou não se verifica depois). Na subida, `reconcileBeforeResume` resolve os comandos sem precisar de code host; o `ambiguous` com play aberto vira a decisão `recovery_effect` ao Produtor (mecanismo já existente). Na chamada, o registro aberto (`ambiguous`) responde `ToolFailure('ambiguous')` e nada roda. Nunca se repete às cegas.
- **`effectsOf(registry, attemptId, types?)` e `openEffectsOf`** [V]: `src/workspace/effects-of.ts`, exportados por `workspace/index.ts`. A primeira lista os efeitos `done` da tentativa, em ordem; a segunda, os `pending`/`ambiguous`. O P18 pode usar as duas no pacote de continuação; a ligação ao pacote é do P18 [N].
- **Passos** [V]: `browser/steps.ts` foi movido para `workspace/steps.ts` (agora é usado também pelas cascas) e `stepFor` ganhou o parâmetro opcional `busy`, para que uma chamada em andamento neste processo não seja tomada por execução interrompida. Duas chamadas iguais ao mesmo tempo viram dois passos (`StepGate`).
- **Plugins** [V: `plugin-effects.test.ts`]: só o gancho. `PluginEffectRegistry` (tipo `<plugin>.<efeito>`, um dono por tipo), `runPluginEffect` (roda sob o protocolo com o verificador do plugin) e o campo opcional `pluginEffects` em `RecoveryDeps`, que a reconciliação consulta antes dos verificadores embutidos. A regra do manifesto (`external_write`, aceitar a chave ou pedir confirmação) continua sendo da Fase 9 [N].
- **Chaves de configuração novas** [proposta], bloco `tools.effects` (global e por cenário, via `configOverride`):
  - `mode`: `record` (padrão) | `off` (volta ao comportamento anterior: nada gravado);
  - `replay`: `same_inputs` (padrão, a §5.16) | `never`;
  - `open_command`: `rerun_safe` (padrão) | `ask` (todo comando aberto vai ao Produtor);
  - `fingerprint_files`: lista de caminhos dentro da worktree (padrão: manifestos e lockfiles dos ecossistemas comuns).
- **Sem mudança de esquema**: nenhuma coluna nova em `side_effects`; o único campo novo do contrato é `reused?` em `commandOutput` (`packages/core/src/registries/tools.ts`).
- **Riscos e lacunas**:
  - o `replay` presume que a instalação anterior continua válida; se o agente apagou `node_modules` por fora, use `tools.effects.replay: never` [N: sem detector de `node_modules` ausente];
  - um `restricted_shell` interrompido bloqueia só a mesma chamada (mesmo argv) até o Produtor responder; **não achei no código quem consuma a decisão `recovery_effect`** (lacuna anterior ao P22) [V: busca no código; N: se existe consumidor fora do repositório];
  - o aceite foi verificado só com o agente falso e processos de teste (`node`), nada real [V].

### P23. Aceite da fase

**Escopo:**
- Os itens do critério de aceite da Fase 5 na §10, com os testes do agente falso já feitos nos passos, rodados juntos numa peça só:
  - dois perfis do mesmo cliente; esgotar um (simulado) e ver o Diretor redistribuir;
  - remover um perfil com sessões em curso sem perder demanda;
  - failover do Orquestrador sem perder a peça;
  - um Ator interrompido por cota esgotada retomado por passagem de bastão em outra assinatura, sem refazer commits nem instalações;
  - outro Ator, com regra `wait`, retomado de forma nativa depois do reset.
- Os níveis reais opcionais, rodados sem ok a cada rodada (N122, decidida): `profiles` (login e logout de um segundo perfil por cliente, com o dono ao teclado) e `quota` (leitura real da cota dos três clientes e da MiniMax, **sem provocar esgotamento**). O resultado, com data e **[V]**, entra na §10.
- Atualiza o docs/13 (estado de cada Nxx), a §10 da arquitetura (a fase fechada, o resultado dos itens 4, 6, 7, 10 e 11 da Fase 0 que couberem) e a lista de portões.

**Aceite:** todos os itens do critério de aceite da Fase 5 na §10, e o relato do que ficou [N]. **Marco: o framework passa a poder construir as próximas fases.**

## Decisões que surgem deste plano

Todas **abertas**, com a recomendação marcada **[proposta]**. O dono decide por múltipla escolha ao abrir o passo que depende de cada uma ([docs/13](13-DECISOES-EM-ABERTO.md)):

- **N118:** o download do `ccusage` (P12) e a forma de uso. Opções: versão fixa como biblioteca, versão fixa como CLI, ou fora da v1. **Recomendação:** biblioteca, se ela exportar uma API (a conferir no registro npm ao abrir o P12), senão a CLI; versão com mais de duas semanas e licença conferida.
- **N119:** a releitura do Claudexor no início da fase (§6.3). Opções: ler só os arquivos listados no commit mais novo, clonar o repositório inteiro em pasta temporária, ou manter a tag `v6.1.2`. **Recomendação:** ler só os arquivos listados, sem clone, registrando o novo commit nos cabeçalhos.
- **N120 (decidida em 2026-11-17):** o plano neste documento, com o marco 5a no P16.
- **N121 (decidida em 2026-11-17):** só serviços e a CLI (`ot profile`, `ot executor`); o assistente da primeira execução fica para a Fase 7 (tela) e a 10 (`ot init`).
- **N122 (decidida em 2026-11-17):** os níveis `profiles` e `quota` sem provocar esgotamento e sem ok a cada rodada; o esgotamento real só se o dono pedir.
- **N123:** os padrões das sondas: `quota.near_limit_at: 0.8`, `quota.stale_after: 10m`, `quota.probe.delivery: both`, a unidade de `utilization`, e a statusline gravada no diretório do perfil. **Recomendação:** os valores acima.
- **N124:** a seleção com o estado incerto. `selection.unknown_quota: allow | skip` e `selection.near_limit: keep_order | last | skip`. **Recomendação:** `allow` (a sessão real é o teste, como na §5.6) e `keep_order` (a ordem da lista, como no algoritmo da §5.7).
- **N125:** a tabela `pricing` inicial. Opções: vazia até o dono preencher, os modelos da predefinição `quality` com valores de fonte pública datada e confirmados pelo dono, ou só o custo do cliente. **Recomendação:** os modelos da `quality`, cada preço com fonte e data, confirmados pelo dono ao abrir o P10.
- **N126:** os detalhes do pacote de continuação e do failover: `resume.package.summarize: deterministic | director_model` (padrão `deterministic`), o tamanho máximo do pacote, o bastão sempre que a cota acaba (como a arquitetura) contra o predicado do Claudexor (só se nada foi entregue), e a fila do Diretor sem Executor. **Recomendação:** `deterministic`, bastão sempre (a arquitetura), fila em espera com aviso.
- **N127:** a drenagem do perfil: `profiles.drain.timeout` (`10m`) e `profiles.drain.on_timeout: handoff | wait | force` (`handoff`), e o que fazer com o diretório removido (`delete` ou `keep_backup`). **Recomendação:** `handoff`, `10m` e `delete`, com o logout antes.

O que continua **[N]** depois deste plano, para o dono ou para uma rodada real: o segundo login em cada cliente (item 7), o esgotamento de cota com assinatura real e o `resetsAt` (item 4), a unidade de `utilization` com valor alto (item 10), o formato real da MiniMax (item 11), o bastão com n maior (item 6), a leitura dos termos da OpenAI (D3) e a confirmação da Anthropic sobre o uso de assinatura (Q4, N2, portão da Fase 10). Nenhum afirma o que os provedores permitem: cada um fica como pendência, sem fonte nem data.
