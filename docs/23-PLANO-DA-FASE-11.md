# 23. Plano da Fase 11

Versão 1, de 2026-11-22. Este documento divide em passos a Fase 11 da [arquitetura](framework-ideas/arquitetura.md) (§10, "Fase 11 — Endurecimento"), com o desenho da recuperação em §5.21, as portas em §5.18 e os riscos R16 e R19. Segue o formato do [docs/21](21-PLANO-DA-FASE-10.md).

A Fase 10 ainda não terminou: os passos P1 a P8, P10 e P13 estão na main, e faltam P9, P11 e P12 (a tabela do docs/21 está desatualizada; o `git log` mostra os PRs #287 a #298 [V]). Pela D6 (N283), a Fase 11 abre já, em paralelo com o que falta da Fase 10, e só o P12 desta fase espera o fim dela. Pela D7 (N284), os PRs desta fase, incluindo o deste plano, mesclam com a CI verde e squash, sem o ok do dono em cada PR.

**Regra central da fase:** o aceite é um **roteiro de caos sem perda de estado nem processo órfão**. "Sem perda de estado" e "sem órfão" viram invariantes verificáveis por código (seção "Invariantes e o censo de processos"), e não uma leitura a olho.

## Como usar

- Cada passo tem uma branch e um PR com título "Fase 11: ...". A branch parte da main. Não há branch sobre branch: o passo que depende de outro só começa depois do merge dele (fila de PRs, 2026-11-21). O PR que conclui um passo também muda o estado dele na tabela e preenche o "Como ficou".
- O merge é feito pelo `merge-pr.sh`, com squash, depois da CI verde (a do próprio head ou a de uma rodada verde da mesma árvore, `ci-tree.sh`). Nunca se usa `gh pr merge --auto`.
- Todo passo exige, além do aceite próprio, `build`, `lint`, `format:check`, `test`, `verify` e `deps` verdes.
- O que está marcado **[proposta]** é detalhe deste plano, ainda sem decisão. Todo padrão novo vira uma chave de configuração, com um padrão e os seus modos (seção "Chaves de configuração").
- Marcas de confiança: **[V]** verificado nesta máquina, lendo o código ou rodando; **[S]** vem de fonte secundária (documentação, arquitetura), com a data; **[N]** não confirmado, e o passo que o usa tem de medir.
- Paralelismo:
  - passos sem dependência entre si correm ao mesmo tempo, cada um no seu worktree;
  - dois passos nunca mexem nos mesmos arquivos. As exceções são as das fases anteriores, e em cada uma o passo acrescenta só o seu bloco: o `DaemonConfigSchema` (`daemon/src/config.ts`), o catálogo de eventos, o `compose.ts` e a tabela de estado deste documento;
  - **um teste de caos que acha um defeito** corrige o defeito no mesmo PR só se o arquivo não for de outro passo em curso. Se for, o PR registra o achado na seção "Como ficou" e o conserto vira passo próprio na onda seguinte;
  - no máximo dois subagentes rodam a suíte completa ao mesmo tempo.
- **Nada real roda nos testes (N57).** Os clientes são o `fake-agent`; o GitHub é o code host falso com diário; as origens HTTP (atualização, registro npm, sondagem de cota) são servidores em `127.0.0.1`. Nenhum teste de caos usa conta, rede externa ou o `PATH` real. As rodadas reais ficam no nível manual do dono e no `real-acceptance.sh`.
- **Nenhum download novo sem decisão do dono.** O caminho recomendado não traz dependência nova (seção "Dependências novas").

## Ponto de partida

Conferido no código em 2026-11-22, no commit `3c84693` (a main depois do PR #310) **[V]**. Os caminhos são relativos a `packages/`, salvo indicação.

- **Reconciliação na subida (§5.21):** `daemon/src/recovery/reconcile.ts` [V].
  - Lê as sessões em estado vivo (`active`, `resuming`, `awaiting_resume`) e, se o `ProcessLauncher` tem a capacidade (`supportsOrphanKill`), chama `killOrphan({ pid, startedAt })`. O instante de início evita matar um pid reaproveitado. Depois marca a sessão `interrupted`. Se o órfão não morre, a linha fica viva e a próxima subida tenta de novo.
  - Guarda o que havia nas worktrees num commit `wip(recovery): ` (`RECOVERY_COMMIT_PREFIX`), resolve os efeitos `pending` e `ambiguous` pelos verificadores e devolve um `RecoveryReport` (`orphansKilled`, `sessionsInterrupted`, `wipCommits`, `effectsResolved`, `pending`).
  - `recovery/gate.ts` segura as chamadas da API até a reconciliação abrir; `recovery/notice.ts` faz o relato.
  - `recovery/tracking-launcher.ts` envolve o `ProcessLauncher` e grava pid e instante de início de cada processo em `sessions` **antes** de entregá-lo, para que um `kill -9` deixe no store o que a próxima subida precisa.
- **Trava de instância:** `daemon/src/instance-lock.ts` usa um bloqueio exclusivo do SQLite em `daemon.lock`. O sistema o solta sozinho quando o processo termina, `SIGKILL` incluído, então não há arquivo de pid velho para adivinhar [V: comentário do código; não rodei].
- **Durabilidade e backup:** `adapters/store-sqlite/src/config.ts` tem a chave `store.synchronous` (padrão `full`, §5.21) [V]. `adapters/store-sqlite/src/backup.ts` copia para `<dest>.partial`, troca para `journal_mode=DELETE` e confere `integrity_check`; `daemon/src/recovery/{backup,restore,retention}.ts` e o comando `ot backup` completam o conjunto [V]. A agenda de backup (`backup.when`: `daily_after`, `on_idle`, `manual`) já trata "disco cheio" só como motivo para tentar de novo mais tarde [V: comentário em `recovery/schedule.ts`].
- **`fake-agent`:** ACP em stdio. O script vem de `FAKE_AGENT_SCRIPT` e é validado por zod em `fake-agent/src/scripts.ts` [V]. Existem `echo`, `tool-call`, `edit-file`, `write-file`, `fail`, `mcp-call`, `submit`, `role-play`, o das tentativas proibidas do sandbox, `hang` e um que simula o terminal. `FAKE_AGENT_SURVIVE_EOF=1` mantém o processo vivo depois do EOF do stdin, e `FAKE_AGENT_STATE_DIR` guarda o estado do `role-play`. **Não há** script que morra no meio de um prompt, que pare de responder sem fechar o stdout, que ignore `SIGTERM`, que deixe um neto vivo, nem que devolva erro tipado de login vencido, de cota ou transitório [V: `grep` em `scripts.ts`, `agent.ts` e `cli.ts`].
- **O que já existe de queda e retomada:**
  - `daemon/src/recovery/crash.test.ts` (só em Linux, `describe.skipIf`) sobe o daemon como processo, deixa o code host falso abrir o PR, escreve o `CRASHPOINT` e leva `SIGKILL`. Depois confere que os órfãos morrem, que o efeito é resolvido pelo verificador e que nada é repetido. O ponto de queda é a variável `OT_TEST_CRASH_AT=open_pr:after`, **a única** hoje, e fica no código de teste (`crash-child-fixture.ts`), não no daemon [V].
  - `recovery/restart.test.ts` retoma a peça pelo snapshot [V: título do teste].
  - Aceites e e2e: `daemon/src/acceptance.test.ts`, `execution/acceptance.test.ts`, `browser/acceptance.test.ts`, `orchestration/phase5-acceptance-e2e.test.ts`, `api/phase6-acceptance.e2e.test.ts`, `phase8-acceptance.e2e.test.ts`, `phase9-acceptance.e2e.test.ts`, os da TUI e os `*.real.test.ts` (clientes reais, fora da CI) [V: `find`]. **Não há** arquivo `*chaos*` [V].
  - `daemon/src/execution/profile-leaving.test.ts` cobre a conta removida durante a sessão (causa `profile_removed`) [V].
- **Como se detecta processo órfão hoje:** pelo par pid mais instante de início gravado em `sessions` (`row.pid`, `row.processStartedAt`) e por `killOrphan`. O `platform-posix` mata a árvore (`kill-tree.ts`) e pode usar escopo do systemd (`systemd-scope.ts`); no Windows, o lançador usa Job Object (Fase 10, P2) [V: arquivos; o comportamento do Windows não foi rodado aqui]. O teste do P9 da Fase 3 confere os pids com `isAlive`. **Não há** um censo que ache processos que nunca foram gravados em `sessions` (um neto que se desligou do grupo, por exemplo) [V].
- **Idempotência da integração e do PR:** `workspace/effects.ts` (`runEffect`) grava a intenção (`intend`) **antes** de executar e resolve depois; a chave base é `<chave>`, e a repetição depois de `not_done` ou `failed` usa `<chave>~2`, `~3`, até `MAX_EFFECT_ATTEMPTS`. Um registro `pending` ou `ambiguous` é decidido pelo verificador, e `ambiguous` espera o Producer [V]. A entrega (`workspace/workspace.ts`) usa as chaves `<playId>:push:<branch>@<sha>`, `<playId>:merge:<base>:<sha>` e `<playId>:pr:<branch>:<base>` [V]. Os verificadores de `workspace/verifiers.ts` perguntam ao mundo: `git_push` e `git_commit` pelo ref, `open_pr` por `findPullRequest` (estados `open`, `closed`, `merged`) e `merge_base` pela base. Um comando (`install_deps`, `run_tests`, `restricted_shell`) é sempre `ambiguous`, salvo `openPolicy: 'rerun'` [V].
  - Caso a examinar no P7 (leitura, sem teste): `verifyOpenPr` aceita como "feito" um PR **aberto** com o mesmo `head` e `base` mesmo que tenha sido criado antes do registro; só descarta o fechado ou mesclado mais velho. Com o ramo derivado do `playId` isso é provavelmente o desejado, mas não há teste que diga.
  - Só existe um ponto de queda nomeado (o do code host falso). Não há queda entre o `intend` e o `execute` nem entre o `execute` e o `resolve` [V].
- **Portas com um só adaptador real** (o falso dos testes não conta; só o `ClientAdapter` e outros com mais de um aparecem abaixo) [V: `grep "port: '"` nos adaptadores, sem testes]:

  | Porta | Único adaptador | Pacote | Segundo previsto na tabela da §5.18 |
  |---|---|---|---|
  | `Clock` | relógio do sistema | `adapters/clock-system` | relógio falso, nos testes |
  | `CodeHost` | GitHub (`gh`) | `adapters/codehost-github` | GitLab, Gitea, só merge local **[hipótese]** |
  | `Vcs` | git | `adapters/vcs-git` | nenhum (`—`) |
  | `Sandbox` | `sandbox-runtime` | `adapters/sandbox-srt` | usuário de baixo privilégio (Windows); nulo, só nos testes |
  | `Store` | SQLite | `adapters/store-sqlite` | `node:sqlite`; em memória, para os testes |
  | `TelemetryStore` | SQLite | `adapters/telemetry-sqlite` | **não consta na tabela** (a tabela tem `TelemetryIngest`) |
  | `PromptSource` | pasta `prompts/` | `adapters/prompts-files` | prompts por projeto **[hipótese]** |
  | `UsageSource` | ccusage | `adapters/usage-ccusage` | contabilidade local |
  | `BrowserSession` | Playwright | `adapters/browser-playwright` | extensão do navegador (padrão da N40) [N: a extensão não existe no código] |
  | `MemoryProbe` | leitura do POSIX | `adapters/platform-posix` | nenhum; **a tabela chama a porta `ResourceMonitor`**, o código chama `MemoryProbe`; o `platform-windows` não tem o seu |

  - Têm mais de um adaptador: `ClientAdapter` (três clientes), `QuotaProbe` (um por cliente e os do MiniMax e do provedor genérico), `LocalModelServer` (Ollama e llama.cpp), `SecretVault` (chaveiro e arquivo) e `ProcessLauncher` (posix e Windows) [V].
  - Da tabela da §5.18, não achei porta em `core/src/ports` para `OsScheduler`, `Notifier`, `TerminalSession`, `EventSink`, `TelemetryIngest` nem `Dictation` [V: `grep`]. A `EventLog` existe e tem suíte.
  - Suítes de conformidade em `sdk/src/conformance` e nos pacotes: há para `Clock`, `CodeHost`, `Vcs`, `Store` (e os agregados), `EventLog`, `PromptSource`, `ProcessLauncher`, `SecretVault`, `LocalModelServer`, `ClientAdapter` e `AgentSession`. **Não achei** para `Sandbox`, `MemoryProbe`, `UsageSource`, `BrowserSession`, `TelemetryStore` nem `QuotaProbe` [V: `grep` de `describe*Conformance(` em `*.test.ts` e em `sdk/src/conformance`; a regra 5 da §5.18 pede as três coisas por porta].
- **Documentação de adaptador e de plugin que já existe:** `sdk/README.md` (o kit de plugins, a suíte de conformidade de plugin e o exemplo `examples/plugin-notes`), `docs/reference/plugin-manifest.schema.json`, `api-routes.json` e `flow-config.schema.json`, e README em seis adaptadores (`browser-playwright`, `client-claude-code`, `client-codex`, `client-opencode`, `local-ollama`, `usage-ccusage`) [V]. **Não existe** guia de "como escrever um adaptador" (nenhum arquivo `.md` do repositório trata disso) [V: `grep`]. O README do SDK diz que um adaptador novo entra por PR como pacote oficial (§5.18) [S: arquitetura].
- **Segurança da API:** `daemon/src/api/server.ts` escuta só em `127.0.0.1`; todo pedido, o de status incluído, passa por três portões antes da rota: `Host` (`127.0.0.1:<porta>` ou `localhost:<porta>`, senão 403), `Origin` (só `api.cors.origins`, senão 403) e `Authorization: Bearer` (senão 401). O token é gerado, gravado por `writePrivateFile` e rotacionável por `POST /v1/api-token/rotate`, mesmo durante a reconciliação [V: leitura]. `api.remote` só aceita `off` até a Fase 12 [V: `config.ts`]. As cascas e o resto (argv, caminhos presos à worktree, `http_get` por domínio) estão em [docs/09](09-ISOLAMENTO-E-SEGURANCA.md) [S] e têm testes de fuga em `execution/escape.real.test.ts` (real, fora da CI) [V: nome].
- **Atualização:** a Fase 10 trouxe o aplicador com diário (`updates/apply/{applier,journal,recover,swap,health}.ts`) e o gerenciador de adaptadores ACP (`daemon/src/adapters/{manager,install,lock,tar}.ts`, P13). O `coordinator.test.ts` cobre a volta automática, o backup antes da migração e o aplicador que não sobe; `applier.test.ts` chama `recoverInterrupted` com portas falsas [V]. Os cortes são simulados por portas falsas dentro do processo; nenhum teste mata um aplicador de verdade no meio da troca [V: leitura dos testes].
- **Tarefa agendada (Fase 9b):** **não existe** no código. Não há agregado de tarefas em `core/src/ports` nem `OsScheduler`; o que sobrevive a um reinício e "acorda" o daemon são os `wakeups` de cota e de orçamento (`core/src/ports/wakeups.ts`) [V]. O item "tarefa agendada" da queda de energia da §10 não é testável de ponta a ponta agora (D8).
- **Interrupções e travamento:** `INTERRUPTION_CAUSES` (`protocol/src/session-events.ts`) lista `quota_exhausted`, `spend_cap`, `transient`, `client_crash`, `daemon_restart`, `timeout`, `stuck`, `refusal`, `permission`, `profile_removed` e `paused` [V]. As chaves `limits.turn_timeout`, `limits.on_turn_timeout` e `resume.stuck.no_event_for` já existem [V: `config.ts`]. **Não achei** causa própria para login vencido (`profile_expired`) [N: a lista foi lida com recorte; o P4 confere].
- **Disco cheio:** o único tratamento explícito é o do log (`log-rotation.ts`: a linha se perde, o daemon continua) e o do cofre de arquivo (a memória só muda depois da troca do arquivo) [V]. Vários testes injetam `new Error('disk full')` em serviços (análise, ideias, pipeline), mas nenhum conhece `ENOSPC` ou `SQLITE_FULL` [V: `grep`]. Não há política "o que o daemon faz quando o disco enche".
- **Ganchos de teste por variável de ambiente:** `OT_TEST_KEYRING`, `OT_TEST_MIGRATION` (que **não faz nada** na build de release, [V: `coordinator.test.ts`]) e `OT_TEST_CRASH_AT`. O precedente de "no release não vale" é o modelo para o `faults.inject`.

## Dependências novas

**Nenhuma no caminho recomendado [proposta].** O harness usa só Node, Vitest, o `fake-agent`, o code host falso e servidores `node:http` em loopback. Duas decisões podem trazer dependência, ambas a aprovar pelo dono antes de qualquer download: a VM da queda de energia (D1, QEMU e uma imagem de sistema) e uma ferramenta externa de revisão de segurança (D3).

## Passos

| Passo | Título | Depende de | Pode correr junto com | Estado |
|---|---|---|---|---|
| P0 | Plano e decisões (este documento) | nada | todos os que dependem só dele | feito |
| P1 | Harness de caos: `faults.inject`, pontos de queda, censo de processos, invariantes e o workflow de caos | P0 | P2, P8, P9 | feito |
| P2 | `fake-agent`: modos de falha (morrer, travar, ignorar `SIGTERM`, deixar neto, erros tipados, lentidão) | P0 | P1, P8, P9 | a fazer |
| P3 | Caos A: daemon morto no meio da peça e queda de energia simulada (processos e store rasgado) | P1, P2, D8 | P4, P5, P6, P7, P10 | a fazer |
| P4 | Caos B: Executor travado, perfil expirado e provedor fora do ar | P1, P2 | P3, P5, P6, P7, P10 | a fazer |
| P5 | Disco cheio: a política `disk.*`, o erro tipado e o caos | P1, D2 | P3, P4, P6, P7, P10 | a fazer |
| P6 | Caos C: atualização de adaptador e atualização do aplicativo, com processos mortos de verdade | P1 | P3, P4, P5, P7, P10 | a fazer |
| P7 | Idempotência de integração e de PR: queda em cada fronteira do efeito | P1, P2 | P3, P4, P5, P6, P10 | a fazer |
| P8 | Revisão de segurança da API e das cascas (D3) | P0 | P1, P2, P9 | a fazer |
| P9 | Revisão das portas (R16) (D4) | P0 | P1, P2, P8 | a fazer |
| P10 | Documentação: o guia de adaptadores e plugins (D5), com exemplo que roda | P9 | P3 a P7 | a fazer |
| P11 | Roteiro de caos do dono (nível manual) e, se a D1 mandar, a VM | P3, P4, P5, P6, P7 | P12 (a parte automática) | a fazer |
| P12 | Aceite da fase | P1 a P11 | nada | a fazer |

Ondas **[proposta]**:

- onda 1, logo depois do merge deste plano: **P1, P2, P8 e P9**, em paralelo, cada um nos seus arquivos;
- onda 2: **P3, P4, P5, P6, P7 e P10**, em paralelo (no máximo dois com a suíte completa ao mesmo tempo);
- onda 3: **P11** e, depois do fim da Fase 10, **P12** (D6).

## Como cada falha é simulada (sem nada real)

Tudo **[proposta]**. A coluna "limite" diz o que o mecanismo **não** prova. O nível automático roda na CI, em Linux (como o `crash.test.ts` de hoje); macOS e Windows ficam no nível manual do dono e nos testes em processo que já existem.

| Falha | Mecanismo | O que se confere | Limite | Nível manual do dono |
|---|---|---|---|---|
| Daemon morto no meio da peça | O daemon sobe como processo filho (`dist/cli.js`, dados temporários, `fake-agent` como cliente, code host falso com diário). O harness manda `SIGKILL` em **pontos nomeados** (`crashPoint('<área>.<ponto>')`, ativos só com `faults.inject`) e em instantes aleatórios com semente fixa e impressa. Depois sobe de novo e confere os invariantes | I1 a I8 | `SIGKILL` encerra o processo, mas o cache do sistema de arquivos sobrevive: não prova `fsync` | O dono manda `kill -9` no daemon de teste (N275) com a TUI aberta |
| Queda de energia | Três níveis. **(i)** `SIGKILL` na árvore inteira de uma vez (grupo de processos), com uma peça, um chat e o relato em curso. **(ii)** o disco "rasgado": o filho grava pelo store de verdade e anota num arquivo, com `fsync`, cada id de commit confirmado; o harness tira cópia do `.db` e do `-wal` num instante aleatório, trunca o `-wal` em deslocamentos aleatórios, apaga o `-shm`, e reabre. **(iii)** VM desligada à força (D1) | `quick_check` e `integrity_check` ok; todo id anotado está presente; a reconciliação termina; o relato sai uma vez | (i) e (ii) simulam o que **o sistema** guarda, não o que o **disco** guarda: não detectam um `fsync` que mente. Só a VM chega perto disso [inferência, sem fonte] | O roteiro com a VM, se a D1 aprovar |
| Executor travado | `fake-agent` com os scripts novos `stall` (vivo, sem responder, stdout aberto), `ignore-term` (ignora `SIGTERM`) e `spawn-child` (deixa um neto vivo, com o pid em `FAKE_AGENT_STATE_DIR`). O relógio é o falso da porta `Clock`, então os minutos de `limits.turn_timeout` e `resume.stuck.no_event_for` passam em milissegundos | o daemon declara `timeout` ou `stuck`, acaba a árvore (do `SIGTERM` ao `SIGKILL`), pega o neto e segue a política por causa da §5.16 | o neto que se desliga do grupo e do escopo só é achado pelo censo por diretório (abaixo) | `kill -STOP` num cliente do daemon de teste |
| Perfil expirado | Script `fail-auth` do `fake-agent`, que devolve o erro que o adaptador de cliente traduz como login vencido (o P4 confere qual é) | a sessão para com a causa certa, o perfil sai da seleção, a próxima sessão usa outro Executor, o Producer é avisado uma vez, nada fica em laço apertado | [N] se há causa para isso (ver "Interrupções e travamento"): o P4 propõe a causa se faltar | trocar o fake por uma conta que o dono deslogou, no nível real, **só se o dono quiser** |
| Disco cheio | Três mecanismos. **(i)** o store: `PRAGMA max_page_count` com o tamanho atual, que faz o SQLite devolver `SQLITE_FULL` de verdade [S: documentação do SQLite, não relida]. **(ii)** os demais arquivos (log, backup, adaptadores, anexos, diário do aplicador): o ponto de falha `fs.write:<área>` do `faults.inject` devolve `ENOSPC`. **(iii)** um sistema de arquivos pequeno de verdade, só se o `mount` sem root funcionar na CI [N: não testado] | a política `disk.on_full` (D2); nenhuma escrita parcial vira estado; o aviso sai; ao liberar espaço, o daemon volta | (i) e (ii) injetam o erro no ponto em que ele ocorre, mas não o `ENOSPC` do meio de uma escrita de várias páginas | um volume pequeno de verdade, no roteiro manual |
| Provedor fora do ar | Dois tipos. O que passa pelo ACP: scripts `fail-quota` e `fail-transient` do `fake-agent`. O que o daemon chama por HTTP (sondagem de cota do MiniMax, origem das atualizações, registro npm dos adaptadores): servidor `node:http` em `127.0.0.1` com os modos `refuse` (porta fechada), `503`, `cut` (corta no meio do corpo), `slow` (responde depois do timeout) e `flap` (cai e volta) | a política por causa (`transient`, `quota_exhausted`), o backoff e o `handoff` valem; as tentativas ficam abaixo de um teto contado com o relógio falso; o aviso sai uma vez | o provedor real tem outros modos (TLS quebrado, `Retry-After`, `429` sem cabeçalho); o P4 cobre os que o adaptador já trata | cortar a rede do daemon de teste, sem conta real |
| Atualização de adaptador | **(i)** adaptador ACP gerenciado (P13): registro falso em loopback; `SIGKILL` do daemon no meio do download e da extração; registro que cai; arquivo cortado. **(ii)** o aplicativo (Fase 10, P8): `SIGKILL` no **aplicador** (processo de verdade) entre as etapas do diário, com os pontos nomeados do `swap` | nunca se usa instalação pela metade; a próxima subida refaz ou volta; `recoverInterrupted` acaba no estado bom; uma sessão em curso continua com o processo antigo | não há SEA de verdade nos testes de Linux da CI comum (isso é do P12, depois da Fase 10) | atualizar o daemon de teste com um release de ensaio local |
| Idempotência | O code host falso (com diário) e um `Vcs` real num repositório temporário. `crashPoint` em cada fronteira de `runEffect`: antes do `intend`, entre `intend` e `execute`, entre `execute` e `resolve`; e depois do `resolve`. Para cada tipo (`git_commit`, `git_push`, `open_pr`, `merge_base`). Mais: duas retomadas concorrentes da mesma entrega | I4 e I5: no máximo um PR e uma fusão por entrega, o push repetido não cria nada novo; o `ambiguous` chega ao Producer | o diário do code host falso vale tanto quanto o `gh` real se comporta; o `gh` não é rodado | uma entrega num repositório de teste do dono, **só se o dono quiser** |

## Invariantes e o censo de processos

Valem para todo teste de caos e formam o aceite da fase **[proposta]**. O harness do P1 os confere depois de cada queda e de cada subida.

| Id | Invariante |
|---|---|
| I1 | O `quick_check` do store e da telemetria passa, e o `integrity_check` passa depois do backup |
| I2 | Todo commit confirmado antes da queda (o harness anota o id, com `fsync`, antes de contar a confirmação) está no store depois da subida |
| I3 | Nenhum processo do censo está vivo depois que a reconciliação terminou |
| I4 | Nenhum efeito externo foi duplicado: o diário do code host falso mostra no máximo um PR, uma fusão e um push efetivo por entrega |
| I5 | Todo efeito `pending` ou `ambiguous` foi resolvido pelo verificador ou aparece como pendente para o Producer; nenhum some |
| I6 | A peça continua do ponto certo (snapshot) ou termina num estado explicado; o relato (`daemon.recovered` e a mensagem do cenário) saiu uma vez |
| I7 | Não sobra arquivo temporário (`.partial`, instalação pela metade, diário aberto) fora da lista que o harness permite |
| I8 | O log de eventos não perdeu nenhum evento que o harness viu confirmado, e a reconciliação não emitiu o mesmo evento duas vezes |

**O censo de processos** (I3) é a parte nova mais importante: hoje só se acham os processos que foram gravados em `sessions`. O harness [proposta] junta três fontes e exige que **nenhuma** esteja viva ao fim:

1. as linhas de `sessions` gravadas pelo `tracking-launcher` (pid e instante de início), conferidas por `kill(pid, 0)` **e** pelo instante de início, para não confundir com um pid reaproveitado;
2. os pids que o próprio harness e o `fake-agent` anotam no diretório de estado do teste;
3. uma varredura do sistema (`/proc` no Linux, `ps -o pid,pgid,command` no macOS) atrás de qualquer processo cujo diretório de trabalho, ou cuja linha de comando, contenha o **diretório temporário único da rodada**. O diretório é novo a cada rodada, então não colide com nada, e a varredura lê `/proc` diretamente, sem `pgrep -f` com padrão do próprio comando. Ela é o que acha o neto que se desligou do grupo.

No Windows o censo depende do Job Object do P2 da Fase 10 [N: não rodado aqui]; fica no nível manual.

## Chaves de configuração

Toda regra ou padrão novo vira chave, com padrão e modos. Tudo **[proposta]**; os nomes e os padrões vão ao dono junto com o PR de cada passo.

| Chave | Modos | Padrão | Passo | Para quê |
|---|---|---|---|---|
| `faults.inject` | `off`, `env`, `plan` | `off` | P1 | `off`: os pontos de queda e de falha não fazem nada. `env`: valem as variáveis `OT_TEST_FAULT` e `OT_TEST_CRASH_AT`. `plan`: vale um arquivo JSON com a lista de falhas (para o roteiro do dono). **Na build de release (SEA) vale sempre `off`**, como o `OT_TEST_MIGRATION`; a chave só existe para testes e para o roteiro manual |
| `disk.on_full` | `pause`, `stop`, `continue` | `pause` (D2) | P5 | O que o daemon faz quando uma escrita falha por disco cheio |
| `disk.min_free` | tamanho (`256MB`), `off` | `256MB` | P5 | Espaço livre abaixo do qual o daemon age **antes** de a escrita falhar |
| `disk.notify` | `once`, `every_hour`, `off` | `once` | P5 | Quantas vezes avisar o Producer enquanto o disco está cheio |
| `recovery.orphans` | `kill`, `report` | `kill` (o que o código faz hoje) | P3 | Hoje a morte do órfão é fixa em `reconcile.ts`. O P3 confere se já é chave; se não for, vira `kill` (padrão) ou `report` (só relata, para depuração) |
| `security.*` | a definir pelo P8 | a definir | P8 | O que a revisão achar e for regra nova (limite de corpo, limite de pedidos, expiração de token) entra como chave, nunca como constante |

O que o sistema faz com provedor fora do ar, com Executor travado e com perfil vencido já é política por causa (§5.16) e já tem chaves (`limits.*`, `resume.*`). O caos **testa** essas políticas. Se achar uma lacuna, o PR do P4 propõe a chave na seção "Como ficou".

## Detalhe dos passos

### P1. Harness de caos

**O que fazer:**
- Generalizar o `crash-child-fixture` e o `crash.test.ts` num harness reutilizável: sobe o daemon como processo, com dados temporários, o `fake-agent` e o code host falso; deixa um teste dizer "mate no ponto X" ou "mate em N ms" (semente impressa para reproduzir); sobe de novo; confere os invariantes.
- `crashPoint(nome)` no código do daemon, sem efeito com `faults.inject: off`. Os pontos iniciais ficam nas fronteiras de `runEffect`, na reconciliação (antes e depois de cada etapa), no `commit` do store e no `swap` do aplicador. Cada ponto nasce com um teste que o aciona.
- O censo de processos e os invariantes I1 a I8 como funções.
- O arquivo de workflow `.github/workflows/chaos.yml`, próprio (como os da Fase 10), com `paths:` nos caminhos de recuperação, efeitos, atualização e do próprio harness, `schedule` e `workflow_dispatch`, e a variável de repositório `OT_CHAOS_CI` (D9).
- O script `pnpm test:chaos` e a regra de nome `*.chaos.test.ts`, fora da suíte comum, que roda `OT_CHAOS_CI` na CI [o passo confere o `vitest.config` antes de escolher].

**Arquivos:** `daemon/src/chaos/{harness,census,invariants,faults,crash-points}.ts` e os testes (novos), `daemon/src/config.ts` (só o bloco `faults`), `daemon/src/recovery/{crash-child-fixture,crash.test}.ts` (passam a usar o harness), `package.json` (script), `.github/workflows/chaos.yml` (novo).

**Aceite:** o `crash.test.ts` de hoje passa sobre o harness novo, com os invariantes conferidos por função; um teste de fumaça mata o daemon num ponto nomeado e num instante aleatório, duas vezes com a mesma semente e o mesmo resultado; com `faults.inject: off` nenhum ponto faz nada (teste) e a build de release ignora a chave (teste).

**Como ficou:** (2026-11-23; verificado localmente, em Linux, salvo onde marcado)
- **Harness** [V]: `daemon/src/chaos/harness.ts` (`ChaosRig`: `killAtPoint`, `killAfter`, `restart`, `evaluate`, `dispose`; semente por `OT_CHAOS_SEED`, impressa em stderr; PRNG mulberry32), `census.ts`, `invariants.ts` (I1 a I8 como `checkI1` a `checkI8` e `assertInvariants`), `faults.ts` e `crash-points.ts`. O `crash-child-fixture` e o `crash.test.ts` passam a usar o harness; o `crash.test.ts` de antes passa sobre ele, com I1 a I8 conferidos. `harness`, `census` e `invariants` são só de teste (fora do `tsconfig.src.json`); `faults` e `crash-points` entram na build, porque o daemon os chama.
- **Pontos de queda criados (14)** [V], cada um com teste que o aciona (`chaos/points.test.ts`, que falha se um ponto entrar no catálogo sem teste): `effects.before_intend`, `after_intend`, `after_execute`, `after_resolve`, `after_verify` (detalhe: o tipo do efeito); `reconcile.before_orphans`, `after_orphans`, `before_worktrees`, `after_worktrees`, `before_effects`, `before_effect_resolve` (só quando o veredito não é ambíguo; detalhe: o tipo do efeito), `after_effects`; `store.before_commit`, `store.after_commit`. **Fica para o P6:** o ponto `swap` do aplicador, porque o aplicador é arquivo do P6 e este passo não toca nele.
- **`faults.inject`** [V]: `off` (padrão), `env`, `plan`, só como o bloco `faults` do `config.ts`. Na build de release (a que define `__OT_BUILD_VERSION__`) o plano é sempre vazio, como o `OT_TEST_MIGRATION` (teste com `releaseBuild: true`). **Chave a mais, [proposta]:** `faults.plan_file` (padrão `fault-plan.json`, relativo ao diretório de dados), que o modo `plan` lê. Com `off` nada é armado e o store não recebe gancho algum (testes em `faults.test.ts` e `crash-points.test.ts`; e, com o daemon de verdade, `harness-smoke.chaos.test.ts`).
- **Censo de processos** [V]: três fontes, as linhas de `sessions` (pid e instante de início, com tolerância de 2 s), os pids em `<diretório de estado>/pids/*.pid` e a varredura direta de `/proc` pelo diretório único da rodada (cmdline, cwd e environ), nunca `pgrep -f`. **Convenção para o P2:** o `fake-agent` e o harness gravam o pid, um por linha, em `<FAKE_AGENT_STATE_DIR>/pids/<nome>.pid`.
- **Fumaça** [V]: `chaos/harness-smoke.chaos.test.ts` mata num ponto nomeado e num instante aleatório, sobe de novo, confere I1 a I8, e repete com a mesma semente. `pnpm test:chaos` (config `vitest.chaos.config.ts`) roda os `*.chaos.test.ts`; a suíte comum os exclui. **Limite da semente** [V]: a mesma semente dá o mesmo plano (ponto ou atraso) e o mesmo veredito dos invariantes; o relógio de parede não se repete bit a bit.
- **CI** [V só a sintaxe do YAML; o workflow não foi disparado]: `.github/workflows/chaos.yml` com `changes` (PR), `mode` (push e `schedule`), `schedule` às 06:00 UTC, `workflow_dispatch` e a variável `OT_CHAOS_CI` (`paths|nightly|off`, padrão `paths`).
- **Mexi fora da lista do passo** [V]: gancho de commit no `store-sqlite` (`StoreCommitHooks`, `store.ts` e `index.ts`, com `commit-hooks.test.ts`), `compose.ts` (passa o gancho; `openComposedStore` é o ponto único que o teste do `store.*` usa), `daemon.ts` (arma e desarma o plano), `workspace/effects.ts` e `recovery/reconcile.ts` (os pontos), `tsconfig.src.json`, `tsconfig.test.json`, `vitest.config.ts` (exporta `alias` e exclui `*.chaos.test.ts`) e `tools/ci/test-affected.sh` (o `git grep` ignora `*.chaos.test.ts`, que o vitest comum não roda).
- **Limites** [N sobre outros sistemas]: o `SIGKILL` não prova o `fsync` (o núcleo guarda os dados do processo morto; a queda de energia de verdade é do P3, por cópia do `-wal`); o harness abre o SQLite para ler, e isso deixa o WAL se recuperar, então ele confere o estado já recuperado; o censo é só Linux (no Windows fica o roteiro manual do dono, seção "Invariantes e o censo de processos"); o teste do `store.*` roda em `node-sqlite`, e o gancho foi conferido nos dois drivers só em `commit-hooks.test.ts`.
- **Achado dos testes** [V, 2026-11-23; defeito do produto, **não corrigido** aqui]: matando o daemon num instante aleatório (cerca de 1,3 s depois do início, com a semente 20261123), um cliente (`fake-agent`) já tinha sido lançado e a linha dele em `sessions` ainda não tinha sido gravada. O censo o achou só pela varredura de `/proc` (cwd no diretório da rodada), e depois do segundo início ele continuou vivo, porque a reconciliação só mata o que está em `sessions`: o invariante I3 falha ("pid vivo (proc: working directory)"). Em outra rodada com a mesma janela a peça ficou em AWAITING_PRODUCER e o I6 estourou o prazo. A fumaça usa o intervalo estável (600 a 1000 ms) para o resultado repetir, e a janela fica para um passo seguinte (a ordem "gravar a sessão antes do `spawn`, ou lançar sob um marcador que a reconciliação ache" é decisão de projeto, não minha). Para o filho do harness, `OT_CHILD_INJECT` (`env` por padrão; `off` para provar que o ponto não faz nada) escolhe o `faults.inject` do fixture.


### P2. `fake-agent` com modos de falha

**O que fazer:** acrescentar scripts, cada um validado pelo zod de `scripts.ts`: `die` (o processo se mata com `SIGKILL` depois de N chunks, ou na abertura), `stall` (vivo e mudo, sem fechar o stdout), `ignore-term`, `spawn-child` (neto que sobrevive ao pai e grava o pid em `FAKE_AGENT_STATE_DIR`), `slow` (chunks com intervalo), `fail-auth`, `fail-quota` e `fail-transient`. Os três últimos devolvem o erro **que o adaptador de cada cliente normaliza**: o passo lê os `client-*` para achar a forma exata [N]. Cada script tem teste próprio e entra na suíte de conformidade do `AgentSession` quando o contrato permitir.

**Arquivos:** `fake-agent/src/{scripts,agent,cli}.ts` e testes.

**Aceite:** cada script faz o que diz, medido por um teste que usa o processo de verdade; o `fake-agent` continua sem tocar rede nem `PATH`.

**Como ficou:** a preencher.

### P3. Caos A: daemon morto e queda de energia

**O que fazer:** o roteiro de "daemon morto no meio da peça" (a peça em cada estado do fluxo: plano, execução, revisão, entrega) e o de "queda de energia" (níveis i e ii da tabela), com uma peça, um chat pela API (conexão SSE/WebSocket cortada e religada) e, enquanto a D8 não decidir outra coisa, os `wakeups` de cota e de orçamento como o "agendamento" que tem de sobreviver. O cenário da tarefa agendada fica escrito e pulado (`skipIf`) com o motivo, para rodar quando a Fase 9b existir. Confere o `recovery.orphans` (ver "Chaves").

**Arquivos:** `daemon/src/chaos/{daemon-killed,power-loss}.chaos.test.ts`, `daemon/src/chaos/torn-store.ts` (cópia e truncamento do `-wal`). Mexe em `daemon/src/recovery/*` e em `daemon/src/config.ts` (bloco `recovery`) só se achar defeito e se nenhum passo em curso estiver nesses arquivos.

**Aceite:** I1 a I8 em todos os pontos nomeados e em 50 instantes aleatórios por cenário (o número vira chave de teste, não do produto).

**Como ficou:** a preencher.

### P4. Caos B: Executor travado, perfil expirado, provedor fora do ar

**O que fazer:** os três cenários da tabela, com o relógio falso. O servidor de loopback com os modos `refuse`, `503`, `cut`, `slow` e `flap`. Para o perfil expirado, conferir se a lista de causas precisa de uma `profile_expired`; se precisar, propor (tipo de erro, causa, política, chave) sem implementar.

**Arquivos:** `daemon/src/chaos/{stalled-executor,expired-profile,provider-down}.chaos.test.ts`, `daemon/src/chaos/loopback-server.ts`.

**Aceite:** cada cenário passa pelos invariantes e mede o limite de tentativas; o neto do `spawn-child` morre com o resto da árvore.

**Como ficou:** a preencher.

### P5. Disco cheio

**O que fazer:** depois da D2, a política `disk.on_full` e a chave `disk.min_free`. O adaptador do store traduz `SQLITE_FULL` e `ENOSPC` num erro tipado novo (`DiskFull`, §5.18 regra 4: o tipo faz parte do contrato; mexer na porta `Store` pede o bump da versão da porta). O daemon, no modo `pause`, para de abrir peça e tarefa novas, deixa o turno em curso terminar, emite `daemon.notice` e o evento (§5.17: toda situação que só vai ao log também gera evento), e volta sozinho quando o espaço volta. O caos injeta os três mecanismos da tabela.

**Arquivos:** `daemon/src/disk/*` (novo), `daemon/src/config.ts` (bloco `disk`), `adapters/store-sqlite/src/*` (a tradução do erro), `core/src/errors` ou o arquivo de erros da porta `Store` (o tipo novo), `daemon/src/chaos/disk-full.chaos.test.ts`.

**Aceite:** com o store cheio, nenhuma escrita parcial vira estado (I1, I2); o aviso sai conforme `disk.notify`; ao liberar espaço o daemon volta, e uma peça retomada termina; `stop` e `continue` têm teste cada um.

**Como ficou:** a preencher.

### P6. Caos C: atualização

**O que fazer:** os dois itens da tabela, com processos mortos de verdade. Para o adaptador ACP gerenciado, `SIGKILL` no meio da extração do `tar.gz`; registro falso que cai; versão trocada com sessão ativa. Para o aplicativo, `SIGKILL` no aplicador entre as etapas do diário e no meio do `swap`. O que a Fase 10 deixou como `[N]` (o `import()` de um módulo dentro de um SEA de verdade) **não** é deste passo: fica no P12.

**Arquivos:** `daemon/src/chaos/{adapter-update,app-update}.chaos.test.ts`. Corrige `daemon/src/adapters/*` e `daemon/src/updates/apply/*` só se achar defeito (registrar se a Fase 10 ainda estiver mexendo neles).

**Aceite:** I1, I3 e I7 depois de cada corte; nenhuma instalação pela metade é usada; a volta automática acontece.

**Como ficou:** a preencher.

### P7. Idempotência de integração e de PR

**O que fazer:** a tabela de "Idempotência", com `crashPoint` em cada fronteira de `runEffect` e para cada tipo de efeito; duas retomadas concorrentes; o caso do `verifyOpenPr` descrito no ponto de partida (um PR aberto antes do registro); e a mesma entrega repetida 3 vezes seguidas. O diário do code host falso diz quantas chamadas cada operação recebeu.

**Arquivos:** `daemon/src/chaos/delivery.chaos.test.ts`. Corrige `daemon/src/workspace/{effects,verifiers,workspace}.ts` se achar defeito.

**Aceite:** I4 e I5 em todos os pontos; a chave `~2` só nasce depois de `not_done` ou `failed`, nunca depois de `done`.

**Como ficou:** a preencher.

### P8. Revisão de segurança da API e das cascas

**O que fazer (com a D3 recomendada):** três subagentes de leitura, cada um numa área, mais a skill `/security-review` na branch e testes adversariais escritos à mão. Áreas **[proposta]**:
- **API:** os três portões (`Host`, `Origin`, token) para todas as rotas e para o SSE e o WebSocket do chat (inclusive o upgrade e os tickets de `chat-tickets.ts`); o arquivo de token e o de descoberta (modo `0600`; em Windows, a ACL [N]); a rotação; o tamanho e a profundidade dos corpos; mensagens de erro que vazam caminho ou token; o redator de log; o CORS fechado;
- **cascas e Executores:** argv, lista de comandos, `..` e links simbólicos, `http_get` por domínio, tempo e truncamento, o servidor MCP do daemon (porta `auto`, cabeçalhos por sessão) e o receptor OTLP em loopback, o ambiente mínimo dos plugins (`OTHEATER_PROJECT_DIR` e segredos);
- **cadeia de suprimento:** a conferência Ed25519 e SHA-256 das atualizações, o `install.sh`, os adaptadores baixados do npm (sha512), o `verify credentials`.

O resultado é a seção "Revisão da Fase 11" no [docs/09](09-ISOLAMENTO-E-SEGURANCA.md), com cada achado marcado **[V]** (reproduzido por teste) ou **[N]** (suspeita), a gravidade e o estado. Achado reproduzido vira teste e conserto no mesmo PR. O `api.remote` (VPN, proxy) está fora: é da Fase 12.

**Arquivos:** `docs/09-ISOLAMENTO-E-SEGURANCA.md` (só esta seção), `daemon/src/api/**` e `daemon/src/mcp/**` (consertos), `daemon/src/api/security-review.test.ts` (novo), `daemon/src/config.ts` (bloco `security`, se houver chave).

**Aceite:** relatório entregue; todo achado alto e médio reproduzido tem teste e conserto, ou uma decisão para o dono; nenhum achado fica sem marca.

**Como ficou:** a preencher.

### P9. Revisão das portas

**O que fazer:** para cada porta da tabela do ponto de partida, e para as da §5.18 sem código (`OsScheduler`, `Notifier`, `TerminalSession`, `EventSink`, `TelemetryIngest`, `Dictation`), responder: tem adaptador real? falso? suíte de conformidade? há segundo previsto? o que custa tirar a porta? E a divergência de nomes (`ResourceMonitor` na arquitetura, `MemoryProbe` no código; `TelemetryStore` fora da tabela). O resultado é uma tabela nesta seção do plano ("Revisão das portas"), com a recomendação por porta: **manter** (a porta paga a regra 5 pelo falso e pela suíte), **simplificar** (candidata do R16) ou **completar** (falta suíte ou falso). Sem mexer em código de porta (a D4 decide se as simplificações entram na fase).

**Arquivos:** `docs/23-PLANO-DA-FASE-11.md` (só a seção "Revisão das portas"). Se a D4 for "simplificar", cada simplificação é um PR próprio, nos arquivos da porta.

**Aceite:** a tabela cobre todas as portas, cada linha com a evidência (arquivo) e a recomendação; as divergências com a arquitetura estão listadas para o dono decidir (a arquitetura não é mudada por este passo).

**Como ficou:** a preencher.

### P10. Guia de adaptadores e de plugins

**O que fazer:** o guia (onde, D5), com duas partes.
- **Adaptador:** o que é porta e adaptador (§5.18); a regra de dependência (o `dependency-cruiser`); as três coisas de toda porta (real, falso, conformidade); como escrever e registrar um adaptador; como ligar a suíte; os erros tipados; o que muda numa porta versionada; como o adaptador entra no `compose.ts`. Como a entrada de terceiros é por PR (§5.18), o guia é para o contribuidor.
- **Plugin:** parte do `sdk/README.md` (kit, manifesto, eventos, suíte de conformidade), sem duplicar: o guia aponta para o README e para o exemplo.
- **Exemplo que roda:** o menor adaptador completo, com a suíte de conformidade do `Clock` (a mais curta), num pacote de exemplo cujo teste roda na CI; o guia cita o código do exemplo, e o código é o que a CI roda, para o texto não apodrecer.
- Um README curto em cada adaptador que ainda não tem, apontando para o guia (`clock-system`, `codehost-github`, `local-llama-cpp`, `platform-posix`, `platform-windows`, `prompts-files`, `sandbox-srt`, `session-acp`, `store-sqlite`, `telemetry-sqlite`, `vault-file`, `vault-keyring`, `vcs-git`) [V: a lista dos que não têm].
- A linha do guia no `README.md` (índice).

**Arquivos:** o guia (D5), `examples/adapter-clock/**` (novo, com os cabeçalhos SPDX que o `verify headers` exige), os README dos adaptadores, `packages/sdk/README.md` (só um link), `README.md` (índice).

**Aceite:** o exemplo compila, passa na suíte de conformidade e roda na CI; `pnpm verify:docs` e o prettier passam; um contribuidor que nunca viu o repositório consegue seguir o guia até o teste verde [N: só um teste com alguém de fora diz; o dono julga].

**Como ficou:** a preencher.

### P11. Roteiro de caos do dono

**O que fazer:** o roteiro manual, parecido com o `tools/acceptance/tui-terminals.md`. Um script sobe o daemon de teste com o `fake-agent` (a N275 já decidiu esse daemon para a Fase 7), um `plan` de falhas (`faults.inject: plan`) e imprime os passos que o dono faz com a mão: `kill -9`, `kill -STOP`, encher um volume pequeno, cortar a rede, e conferir cada invariante com um comando que diz `ok` ou `falhou` e o motivo. Se a D1 mandar a VM, o script de VM entra aqui (e o download só depois do ok).

**Arquivos:** `tools/acceptance/chaos.sh` e `tools/acceptance/chaos.md` (novos), `tools/acceptance/chaos-vm/**` (só se a D1 pedir).

**Aceite:** o dono roda o roteiro numa máquina e todos os invariantes dão `ok`.

**Como ficou:** a preencher.

### P12. Aceite da fase

**O que fazer:** rodar o roteiro de caos completo (todos os cenários, todos os pontos nomeados, as sementes registradas) sobre o executável da Fase 10, quando ela terminar; preencher o "Como ficou" de cada passo; listar o que ficou de fora e o que o dono precisa decidir; propor as linhas do `docs/13` e da §10 (quem registra é o chamador).

**Aceite (§10):** roteiro de caos sem perda de estado nem processo órfão: I1 a I8 verdes em todos os cenários, na CI e no nível manual do dono.

**Como ficou:** a preencher.

## Perguntas novas ao dono

Levadas ao dono por múltipla escolha, com a recomendação em primeiro lugar. **Todas decididas igual à recomendação**, a opção (a) de cada uma: D1 a D8 em 2026-11-22 e D9 em 2026-11-23. Viraram N278 a N286 no [docs/13](13-DECISOES-EM-ABERTO.md).

- **D1, a queda de energia: VM ou só simulação (P3, P11):**
  - (a) **(Recomendado)** simulação no CI agora (níveis i e ii), e a VM só como roteiro manual **opcional** no aceite (P12), sem download agora. O porquê: matar processos e rasgar o store testa a recuperação, mas só uma VM desligada à força testa se o `fsync` chega ao disco; esse ponto é caro (QEMU e uma imagem) e pode esperar para depois de saber o que a simulação já achou;
  - (b) VM obrigatória no nível manual, com QEMU e uma imagem de sistema baixados já na onda 3 (download a aprovar, tamanho a medir [N]): fecha a lacuna do `fsync`, mas atrasa o P11;
  - (c) só a simulação, sem VM nunca, com o limite escrito no aceite: mais barato, e a arquitetura (§10) diz "VM desligada à força", então é um desvio dela.
- **D2, o que fazer com disco cheio (P5):**
  - (a) **(Recomendado)** `disk.on_full: pause`: para de abrir trabalho novo, deixa o turno em curso terminar, avisa o Producer e volta sozinho quando há espaço. O porquê: é o único modo que não perde estado nem derruba o chat, e o `disk.min_free` age antes de a escrita falhar;
  - (b) `stop`: o daemon encerra limpo com o código de saída e um aviso; simples, mas corta o chat e as peças, que só voltam quando o dono liberar espaço e subir de novo;
  - (c) `continue`: relata e segue, cada chamada falha por conta própria; é o que há hoje e arrisca estado parcial.
  Qualquer que seja a escolha, os três modos ficam como chave; a D2 só escolhe o padrão.
- **D3, quem faz a revisão de segurança (P8):**
  - (a) **(Recomendado)** um passo com subagentes de leitura, a skill `/security-review` e testes adversariais escritos à mão, sem ferramenta nova: o porquê é que não traz dependência e deixa teste que fica. O limite é que o mesmo modelo que escreveu o código pode ter pontos cegos parecidos, então o dono lê o relatório;
  - (b) ferramenta externa de análise (por exemplo o CodeQL, que o GitHub oferece em repositório público [N: não conferido hoje]): um olhar de outro tipo, mas é configuração e dependência nova, que o dono tem de aprovar;
  - (c) as duas: (a) primeiro e (b) depois, no P12.
- **D4, as portas candidatas a simplificar (P9):**
  - (a) **(Recomendado)** só listar e recomendar na fase; qualquer simplificação vira passo depois, porta a porta, com ok do dono. O porquê: remover porta muda contrato versionado e suíte do SDK, e a fase é de endurecimento; a porta com falso nos testes já cumpre a regra 5, então o R16 é questão de custo e não de risco;
  - (b) simplificar na fase as que o P9 marcar, cada uma num PR (P9a, P9b...), na onda 3: o código fica mais enxuto já, mas mexe em fronteira no fim do endurecimento;
  - (c) simplificar na fase só as que não têm falso, nem segundo previsto, nem suíte: o menor corte.
- **D5, onde mora o guia de adaptadores e de plugins (P10):**
  - (a) **(Recomendado)** um documento novo em `docs/` (o número é o seguinte livre quando o passo rodar), com o exemplo que roda em `examples/`, e os README dos pacotes apontando para ele. O porquê: é onde o dono e o contribuidor já procuram, o `verify:docs` o cobre, e o `sdk/README.md` continua sendo a referência do kit de plugins;
  - (b) ampliar o `packages/sdk/README.md`: perto do código, mas mistura o SDK interno com o guia do contribuidor e o README já é longo;
  - (c) uma pasta `docs/guia/` com um arquivo por assunto (adaptador, plugin, conformidade): cresce melhor, mas é mais estrutura para a v1.
- **D6, quando a Fase 11 abre (todos):**
  - (a) **(Recomendado)** já, em paralelo com P9, P11 e P12 da Fase 10, **menos o P12 desta fase**, que só roda depois do fim da Fase 10. O porquê: a Fase 10 termina em CI, release de ensaio, assinatura e aceite (`.github/workflows`, `tools/release`, docs de instalação), arquivos que os passos P1 a P11 desta fase não tocam [N: o P1 e o P6 conferem antes de abrir PR]; e o caos de atualização deve rodar sobre o executável final;
  - (b) esperar o fim da Fase 10: sem choque de arquivos e de CI, mas perde o paralelismo e deixa a segurança e as portas para depois;
  - (c) abrir só a onda 1 (P1, P2, P8, P9), que não mexe em nada da Fase 10, e a onda 2 depois.
- **D7, a autorização de merge (todos):**
  - (a) **(Recomendado)** os PRs da Fase 11, incluindo o deste plano, mesclam com a CI verde e squash pelo `merge-pr.sh`, sem o ok por PR, como nas Fases 3 a 10 (N171, N192, N210, N245). O porquê: é o ritmo das fases anteriores, e o aceite é todo por teste;
  - (b) ok do dono em cada PR.
- **D8, a tarefa agendada na queda de energia (P3, P12):**
  - (a) **(Recomendado)** cobrir o agendamento com o que existe (os `wakeups` de cota e de orçamento, que sobrevivem ao reinício [V]), deixar o cenário da tarefa agendada escrito e pulado até a Fase 9b existir, e dizer isso por escrito no aceite. O porquê: nenhuma ordem da arquitetura muda, e o mecanismo de persistência fica testado;
  - (b) construir a Fase 9b antes (a estimativa da §10 é de 2,5 a 3 semanas [S: arquitetura]): muda a ordem das fases;
  - (c) tirar "tarefa agendada" do aceite da Fase 11 e passá-la ao aceite da Fase 10b, que já exige "a tarefa agendada que estava na janela".
- **D9, quando os testes de caos rodam na CI (P1):**
  - (a) **(Recomendado)** um workflow próprio, `chaos.yml`, que roda nos PRs que tocam os caminhos de recuperação, efeitos, atualização e do harness, toda noite e por `workflow_dispatch`; a variável de repositório `OT_CHAOS_CI` escolhe (`paths`, `nightly`, `off`), como as outras (`OT_TEST_CI`, `OT_CROSS_CI`). O porquê: os testes matam processos e demoram mais que os comuns, e o caminho só dispara onde importa;
  - (b) em todo PR, dentro do `ci.yml`: pega tudo, mas aumenta o tempo de cada PR;
  - (c) só toda noite e à mão: não atrasa nenhum PR, mas um defeito de recuperação só aparece no dia seguinte.

## Fora desta fase

- **Fase 9b (agendador e tarefas)** e o aceite com a tarefa agendada na janela (D8; é do aceite da **Fase 10b**, que também decide o serviço sem login e o `SecretVault` que destranca sozinho).
- **API remota** (`api.remote: vpn` e `proxy`) e a revisão de segurança dela: Fase 12.
- **Caos automático em macOS e Windows:** o nível automático roda em Linux; os outros dois ficam no nível manual do dono e nos testes em processo que já existem. Um segundo job de caos nos dois sistemas é possível depois da v1 **[proposta]**.
- **Caos dos terminais, do navegador compartilhado e dos plugins:** não estão na lista da §10. O P8 revisa o ambiente dos plugins; o resto fica para a fase em que cada um endurecer.
- **O `import()` de um módulo no SEA de verdade** e o `smoke` dos adaptadores: ficam como estão, no P12 da Fase 10.
- **Testes de carga e de desempenho:** os de `tools/bench` já existem; nada novo aqui.

## Decisões deste plano

Estado em 2026-11-23: **todas decididas**, por múltipla escolha, igual à recomendação (a coluna "Recomendada" é a escolhida):

| Decisão | N | Recomendada (escolhida) | Alternativas não escolhidas |
|---|---|---|---|
| D1, queda de energia | N278 | (a) simulação no CI agora; VM só opcional no aceite | (b) VM obrigatória, com download; (c) só simulação |
| D2, disco cheio | N279 | (a) `pause` | (b) `stop`; (c) `continue` |
| D3, revisão de segurança | N280 | (a) subagentes, `/security-review` e testes adversariais | (b) ferramenta externa; (c) as duas |
| D4, portas candidatas | N281 | (a) listar e recomendar; simplificar depois, com ok | (b) simplificar na fase; (c) só as sem falso, sem previsto e sem suíte |
| D5, onde mora o guia | N282 | (a) documento novo em `docs/`, com exemplo em `examples/` | (b) ampliar o `sdk/README.md`; (c) pasta `docs/guia/` |
| D6, quando abre | N283 | (a) já, menos o P12 desta fase | (b) esperar a Fase 10; (c) só a onda 1 agora |
| D7, merge | N284 | (a) CI verde e squash, sem ok por PR | (b) ok do dono por PR |
| D8, tarefa agendada | N285 | (a) `wakeups` agora, cenário pulado até a 9b | (b) construir a 9b antes; (c) passar ao aceite da 10b |
| D9, caos na CI | N286 | (a) `chaos.yml` por caminho, toda noite e à mão | (b) em todo PR; (c) só à noite e à mão |

Detalhes marcados **[proposta]** que **não** viraram pergunta (escolhidos pelo mais conservador, para o dono rever): o nome `faults.inject` e os seus três modos; o nome e o formato dos pontos de queda (`<área>.<ponto>`); os invariantes I1 a I8 como definição do aceite; o censo por diretório temporário único em vez de `pgrep -f`; a semente de aleatoriedade impressa e fixa por teste; Linux como único sistema do nível automático; o nome `*.chaos.test.ts` e o script `pnpm test:chaos`; o `recovery.orphans` como chave só se ainda não for; a interpretação de "atualização de adaptador" como as duas coisas (o adaptador ACP gerenciado e o aplicativo).

Marcas de confiança do que o plano **não** conferiu: o que o adaptador de cada cliente espera como erro de login vencido, de cota e transitório (P2, P4); se o `mount` sem root funciona na CI (P5); o comportamento do Job Object e do censo no Windows; se a CI aceita o novo workflow sem ajuste de permissões; o tamanho de QEMU e de uma imagem de sistema, se a D1 mandar baixar; a documentação do SQLite sobre `max_page_count` (usada como fonte secundária, não relida).
