# 26. Plano da Fase 11b

Versão 1, de 2026-11-25. Este documento divide em passos a Fase 11b da [arquitetura](framework-ideas/arquitetura.md) (§10, "Fase 11b — Motor de workflows"). O desenho do motor está no [docs/24](24-DESENHO-DO-MOTOR-DE-WORKFLOWS.md), com as decisões N291 a N298. A conversa entre Executores vem da N308, e a supervisão do Diretor vem da N309. O formato segue o do [docs/23](23-PLANO-DA-FASE-11.md).

A Fase 11 terminou: os passos P0 a P13 do docs/23 estão na main [V: `git log`, PRs #342 a #357]. Pela N319, os PRs desta fase mesclam com a CI verde e por squash, sem o ok do dono em cada PR. O PR deste plano também.

**Regra central da fase:** a peça deixa de ser uma máquina escrita à mão e vira uma definição entre outras.
- Tudo o que vale para a peça de hoje passa a valer para qualquer workflow: os efeitos no journal, os invariantes de caos I1 a I8 e a aprovação antes do que é público.
- Isso é conferido por teste, e não só pela leitura do código.

## Decisões do plano (2026-11-25)

Foram tomadas pelo dono por múltipla escolha, todas iguais à recomendação. Estão registradas no [docs/13](13-DECISOES-EM-ABERTO.md) e na §12 da arquitetura (item 38).

| D | N | Decisão |
|---|---|---|
| D1 | N310 | **A v1 fica onde está:** depois da 11c e antes da 10b, quando o dono autorizar o release. O plano não trata de release. Como nunca houve release, não há usuário com dado a migrar, e isso não pesa nas escolhas desta fase. |
| D2 | N311 | **Sem migração da peça 1.x.** A `play` 2.0 substitui a máquina escrita à mão de uma vez, e a máquina antiga sai do código no mesmo passo. Um snapshot 1.x (só de desenvolvimento) é recusado com aviso e evento. O mecanismo da N295 entra mesmo assim (versão de nascimento, migração em ponto seguro) e é testado com uma 2.0 → 2.1 de teste. |
| D3 | N312 | **Da Fase 9b, só o mínimo.** Esta fase traz um laço de sondagem sobre os `wakeups` que já existem, sem acordar a máquina e sem tarefas. A 9b completa (cron, gatilho do sistema, aba Agenda, `schedule`) continua fase própria e reaproveita esse laço. |
| D4 | N313 | **Porta própria `IssueTracker`** para issue, comentário e rótulo. O adaptador do GitHub implementa as duas portas. As issues podem viver num lugar diferente do código. |
| D5 | N314 | **Assinatura SSHSIG**, o mesmo formato do `install.sh` (N288), conferida com `ssh-keygen -Y verify`. Há uma lista de chaves confiáveis por usuário (`workflows.packages.trusted_keys`). Um pacote sem assinatura só instala com confirmação, no modo padrão. |
| D6 | N315 | **Eventos de plugin como gatilho só com três condições:** o plugin está instalado e ativo, o manifesto declara o evento como gatilho e o vínculo pede o evento pelo nome (`workflows.triggers.plugin_events`, padrão `declared`). |
| D7 | N316 | **O aceite tem as três partes:** os workflows prontos e o pacote; o caos e a N295; a conversa e a supervisão (seção "Critério de aceite"). |
| D8 | N317 | **Ordem da conversa:** primeiro o mural, depois a supervisão e por fim o `ask_director`, em série, porque os três mexem no servidor MCP. **O aviso chega ao Ator na próxima resposta MCP** (`supervision.delivery: tool_reply`); o `redirect` cancela e relança com o aviso no prompt. |
| D9 | N318 | **O motor fica num pacote novo, `@otheater/workflows`.** Ele é código puro (schema, linguagem de condição, compilador, validador), para que o daemon, a CLI e o editor da TUI usem o mesmo validador. O runtime e os tipos de passo ficam no daemon. **Ondas:** o motor e a conversa andam em paralelo desde a onda 1. |
| D10 | N319 | **O merge com a CI verde, sem pedir,** vale também para as Fases 11b e 11c (dono, 2026-11-25: "Sim, vale para a 11b e a 11c"). |

## Como usar

- Cada passo tem uma branch e um PR, com o título "Fase 11b: ...".
  - A branch parte da main, sem branch sobre branch. O passo que depende de outro só começa depois do merge dele.
  - O PR que conclui um passo muda o estado dele na tabela e preenche o "Como ficou".
- O merge é feito pelo `merge-pr.sh`, com squash, depois da CI verde. Vale a CI do próprio head ou a de uma rodada verde da mesma árvore (`ci-tree.sh`). Nunca se usa `gh pr merge --auto`. **Só um PR roda a CI por vez.**
- Todo passo exige, além do aceite próprio, `build`, `lint`, `format:check`, `test`, `verify` e `deps` verdes.
- O que está marcado **[proposta]** é detalhe deste plano, ainda sem decisão do dono. Todo padrão novo vira uma chave de configuração, com um padrão e os seus modos (seção "Chaves de configuração").
- Toda situação que só iria ao log (aviso, desvio, falha que degrada) também gera um evento no protocolo (seção "Eventos").
- Marcas de confiança:
  - **[V]** verificado nesta máquina, lendo o código ou rodando;
  - **[S]** fonte secundária (documentação, arquitetura), com a data;
  - **[N]** não confirmado; o passo que usa a informação tem de medir.
- Paralelismo:
  - no máximo três agentes de código ao mesmo tempo, e no máximo dois com a suíte completa;
  - dois passos nunca mexem nos mesmos arquivos. As exceções são as das fases anteriores, e em cada uma o passo acrescenta só o seu bloco:
    - o `DaemonConfigSchema` (`daemon/src/config.ts`);
    - o catálogo de eventos;
    - o registro de ferramentas (`core/src/registries/tools.ts`);
    - o `compose.ts`;
    - a tabela de estado deste documento.
- **Nada real roda nos testes (N57).** Os clientes são o `fake-agent`. O GitHub é o code host falso com diário e o `IssueTracker` falso. Os pacotes git são repositórios locais em pasta temporária, e as chaves SSH de teste são geradas no teste e não ficam no repositório. As rodadas reais ficam no nível manual do dono.
- **Nenhuma dependência nova sem decisão do dono.** O caminho recomendado não traz nenhuma (seção "Dependências novas").

## Ponto de partida

Conferido no código em 2026-11-25, no commit `7ef3805` (a main depois do PR #357) **[V]**. Os caminhos são relativos a `packages/`, salvo indicação.

- **A máquina da peça:** `daemon/src/pipeline/machine.ts`, com 1.206 linhas, é XState v5 (`xstate` 5.33.3 no `daemon/package.json`) escrito à mão.
  - Os estados são NEED, PLANNING, CLARIFYING, REVIEWING_PLAN, SCRIPTING, REVIEWING_SCRIPT, EXECUTING, INTEGRATING, CRITIQUING, DECIDING, DELIVERING, AWAITING_PRODUCER, DONE e CANCELLED (docs/24, §2).
  - Os arquivos vizinhos são `runner.ts` (570 linhas), `context.ts`, `effects.ts` (`STAGE_ROLES`), `events.ts` (`PLAY_EVENT_DEFINITIONS`), `judgment.ts` e `definitions.ts` (`PLAY_FLOW_ID`, `PLAY_FLOW_VERSION`).
  - Os testes da máquina são `machine.test.ts` (511 linhas), `runner.test.ts` (881), `flow-machine.test.ts`, `menu.test.ts` e `merge-conflicts.test.ts`, além dos e2e de `daemon/src/orchestration/*-e2e.test.ts`.
- **O vínculo com o registro de fluxos:** `pipeline/flows.ts` tem o `assertPlayFlowLinked`, que confere a mesma versão, os papéis e os eventos registrados. Os fluxos por configuração ficam em `daemon/src/flows-config.ts`: a chave `flows.<id>` só liga ou desliga `plan_review` e `critique` (N243), e `scenario.flow` aceita `play` ou uma chave de `flows`.
- **As ferramentas MCP:** ficam em `core/src/registries/tools.ts`, por papel.
  - O Diretor tem `next_action`, `status`, `decide`, `pause`, `resume`, `cancel_actor`, `ask_producer`, `open_pr`, `schedule`, `list_schedules`, `pause_schedule`, as `*_directive` e `promote`.
  - Os papéis comuns têm `read_contract`, `read_decision`, `read_indication`, `read_attachment` e `submit`.
  - O Ator tem `run_tests`, `install_deps`, `git_commit`, `restricted_shell` e `http_get`.
  - As ferramentas de leitura (`read_blackboard`, `read_contract`, `read_decision`) estão em `daemon/src/mcp/read-tools.ts`. O servidor está em `daemon/src/mcp/server.ts`, e o `submit*` é embutido (`mcp/submit.ts`). O `ask_producer` tem tratamento próprio no servidor (`mcp/ask-producer.ts`, modos `choices|choices_strict|free`).
  - **Não há** ferramenta para um Ator deixar recado ou perguntar ao Diretor; a única saída do Ator é o `submit`.
- **O blackboard:** a porta é `core/src/ports/blackboard.ts`. Ela guarda chave, versão e valor JSON por `playId`, e uma versão nunca é sobrescrita. As chaves são definidas em `core/src/blackboard-keys.ts`. É a base natural do mural (N308).
- **As ferramentas da agenda** (`schedule`, `list_schedules`, `pause_schedule`) estão registradas para o Diretor, mas **não têm** agendador por trás: a Fase 9b não está no código (N285). O que acorda o daemon no tempo são os `wakeups` (`core/src/ports/wakeups.ts`, `daemon/src/quota/wakeups.ts`) e a agenda do backup (`daemon/src/recovery/schedule.ts`).
- **O code host:** a porta `core/src/ports/code-host.ts` (contrato `0.1.0`) só tem push, PR (abrir, achar) e merge de branch. **Não há** issue, comentário, rótulo nem log de CI. A ligação em produção é `adapters.code_host` (Fase 11, P13, N289).
- **As portas em `core/src/ports`:** não há `IssueTracker` nem `OsScheduler` [V: `ls`].
- **As suítes de conformidade** ficam em `sdk/src/conformance` (há uma de `CodeHost`). O guia de quem escreve adaptador é o [docs/25](25-GUIA-DE-ADAPTADORES-E-PLUGINS.md).
- **A assinatura:** o `install.sh` confere SSHSIG com `ssh-keygen -Y verify` (N288) [S: docs/21 e docs/13, N288; o script não foi relido neste plano].
- **O harness de caos da Fase 11:** `daemon/src/chaos/`, com `faults.inject`, pontos de queda nomeados, censo de processos e os invariantes I1 a I8 (docs/23) [V: pasta].

## Dependências novas

**Nenhuma no caminho recomendado [proposta]:**
- o YAML já é lido pelo daemon (o `flows.<id>` é YAML);
- o XState já é dependência;
- a conferência de SSHSIG usa o `ssh-keygen` do sistema, como o `install.sh`. Se ele não estiver no `PATH`, um pacote assinado instala só com confirmação, no modo `verify_if_present`, ou é recusado, no modo `require`;
- os pacotes git usam o `git` que o adaptador `vcs-git` já chama.

O `@otheater/workflows` é pacote novo do monorepo, não dependência de fora. Ele depende só de `zod`, que já é usado, e de `@otheater/core`.

## Passos

| Passo | Título | Depende de | Pode correr junto com | Estado |
|---|---|---|---|---|
| P0 | Plano e decisões (este documento) | nada | todos os que dependem só dele | feito (este PR) |
| P1 | `@otheater/workflows`: schema da definição, linguagem de condição, compilador para XState, validador e hash | P0 | P7, P13 | feito (#359) |
| P2 | Runtime do motor no daemon e tipos de passo genéricos (`call_tool`, `wait_event`, `branch`, `approval`, `notify`) | P1 | P5, P14 | feito (#413) |
| P3 | A definição `play` 2.0: os tipos de passo da peça, a troca da máquina, o `flows.<id>` como parâmetro, o snapshot 1.x recusado | P2 | P6, P8, P9 | feito (#418) |
| P4 | Versão de nascimento e migração em ponto seguro (N295), com a 2.0 → 2.1 de teste e o caos sobre workflows gerados | P10a | P12 | a fazer |
| P5 | Biblioteca e vínculos (N296): tabelas, `workflows.default` e `allowed`, estados do vínculo, prazo, orçamento por período, concorrência | P1 | P2, P14 | feito (#412) |
| P6 | Gatilhos: laço de sondagem mínimo (D3), eventos internos, eventos de plugin declarados (D6), filtro de autor | P5 | P3, P8, P9 | feito (#421) |
| P7 | Porta `IssueTracker` (D4), adaptador GitHub, falso, conformidade; `fetchPullRequest` e `fetchCiLog` na `CodeHost` | P0 | P1, P13 | feito (#362) |
| P8 | Tipos de passo do code host (`fetch_issue`, `fetch_pr`, `fetch_ci_log`, `comment`, `label`), aprovação antes de push e comentário, texto externo marcado | P2, P7 | P3, P6, P9 | feito (#416) |
| P9 | Pacotes de workflow (N298): arquivo ou git com ref fixa, permissões na instalação, SSHSIG e chaves confiáveis (D5) | P1, P5 | P3, P6, P8 | feito (#417) |
| P10a | Os gatilhos do P6 e o motor na composição do daemon e os leitores GitHub de PR, colaborador e CI (a troca da máquina passou ao P10c) | P3, P6, P8 | nada | feito (#423) |
| P10c | A peça pela `play.yaml`: o `PlayStageHost` no runtime, as cinco diferenças do P3, o snapshot e a retomada da peça, e o `playMachine` sai (critério 4); a parte da N295 que vale só para a peça | P4, P12 | nada | a fazer |
| P10b | API e CLI: validar, simular com o `fake-agent`, salvar, ativar, desativar, diff, listar, instalar (`ot flow ...`) | P4, P5, P9, P10a | P12, P10c | a fazer |
| P11 | Editor do YAML na TUI, com o validador do P1 | P10b | P15, P16 (a parte automática) | a fazer |
| P12 | Workflows prontos: `github-issues`, `pr-review` e `ci-fix` | P6, P8, P10a | P4, P10b | a fazer |
| P13 | Mural de recados da peça (N308, opção 1): `post_note`, `read_notes` | P0 | P1, P7 | feito (#360) |
| P14 | Supervisão do Diretor (N309): sinais, `warn` e `redirect`, o canal pela resposta MCP (D8) e os três extras | P13 | P2, P5 | feito (#414) |
| P15 | `ask_director` (N308, opção 2): o `blocked` que não encerra, com espera, prazo e o modo `relay` pelo canal do P14 | P14 | P3 a P12 | feito (#420) |
| P16 | Aceite da fase | P1 a P15 (com P10a, P10b e P10c), P17, P18 | nada | a fazer |
| P17 | Testes da TUI num terminal real com o `@microsoft/tui-test` (N320) | P1, P7, P13 | os da onda 2 | feito (este PR) |
| P18a | Nova detecção dos clientes (N321, itens 2 e 5): sem reiniciar o daemon, a cada abertura do assistente e ao criar uma conta; no Windows, o `Path` do registro; o motivo de cada cliente não achado na API | P7 | os da onda 2 | feito (#367) |
| P18b | O assistente resolve na tela (N321, itens 1 e 4): as teclas I, R e A, o motivo na tela e as mensagens sem comandos `ot` | P18a | os da onda 2 | feito (#371) |

Ondas **[proposta, forma decidida na D9]**:

- onda 1, logo depois do merge deste plano: **P1, P7 e P13**, em paralelo (três agentes);
- onda 2: **P2, P5 e P14**, e o **P17** (N320, acrescentado em 2026-11-25), que mexe só nos testes da TUI e na CI;
- onda 3: **P3, P8 e P9**, e depois **P6** e **P15**, assim que uma vaga abrir;
- onda 4 (reordenada pelo dono em 2026-11-28, com a divisão do P10): primeiro o **P10a**, sozinho; depois **P4 e P12**, em paralelo; por fim o **P10b** e o **P10c** (a troca da máquina, acrescentada pelo dono em 2026-11-28);
- onda 5: **P11** e **P16**.

O P3 é o passo de maior risco, porque troca o núcleo mais testado. Ele corre sozinho na suíte completa: enquanto ele roda os e2e, os outros dois agentes da onda só rodam os testes do próprio pacote.

## Critério de aceite

Tudo com o `fake-agent`, o code host falso e o `IssueTracker` falso, na CI em Linux (D7) **[proposta, partes decididas na D7]**.

1. **Workflows e pacote:**
   - `play`, `github-issues`, `pr-review` e `ci-fix` rodam de ponta a ponta;
   - push, comentário e rótulo só acontecem depois da aprovação (`workflows.security.require_approval`);
   - uma issue de autor fora da lista não dispara nada e gera `workflow.trigger.skipped`;
   - um workflow de pacote git assinado, numa ref fixa, é instalado com as permissões mostradas, validado, simulado e ativado pela API, pela CLI e pelo editor da TUI, sem reiniciar o daemon;
   - um pacote com assinatura inválida é recusado.
2. **Caos e N295:**
   - os invariantes I1 a I8 da Fase 11 passam sobre a `play` 2.0 e sobre um workflow que não é a peça (gerado pelo harness);
   - uma peça que nasceu na 2.0 continua na 2.0 depois da ativação da 2.1;
   - a migração pedida espera um ponto seguro e recusa sem mapeamento;
   - um snapshot 1.x é recusado com o evento.
3. **Conversa e supervisão:** numa peça com dois Atores:
   - o recado de um chega ao outro pelo mural, dentro dos limites;
   - um desvio (arquivo fora da demanda) gera o sinal, e o Diretor manda o aviso, que chega na próxima resposta MCP do Ator;
   - um `redirect` relança com o aviso;
   - o `ask_director` espera a resposta e, no prazo vencido, segue `collab.ask_director.on_timeout`;
   - todo limite atingido gera `collab.limit_reached` ou `supervision.limit_reached`.
4. A suíte que a máquina escrita à mão tinha passa sobre a `play` 2.0 sem mudar o que cada teste confere. Só mudam o modo de montar a máquina e os nomes internos.

**Estimativa [proposta]:** 4 a 5 semanas sem agentes; 2 a 3 com.

## Chaves de configuração

Todas **[proposta]**, salvo as que o docs/24 (§12) ou as decisões já fixaram. O padrão vem primeiro. As chaves entram no `DaemonConfigSchema`, cada passo com o seu bloco.

| Chave | Modos ou valores (padrão primeiro) | Passo | Origem |
|---|---|---|---|
| `workflows.default` | `play` ou o id de uma definição da biblioteca | P5 | docs/24 §12 |
| `workflows.allowed` | `all_installed`, lista de ids | P5 | docs/24 §12 |
| `workflows.running_on_change` | `pin`, `migrate_at_safe_point` | P4 | docs/24 §12, N295 |
| `workflows.legacy_snapshot` | `reject`, `cancel` (cancela a peça 1.x e a registra) | P3 | D2 |
| `workflows.triggers.authors` | `allowlist`, `collaborators`, `any` | P6 | docs/24 §12 |
| `workflows.triggers.authors_list` | lista vazia | P6 | [proposta] |
| `workflows.triggers.plugin_events` | `declared`, `off` | P6 | D6 |
| `workflows.triggers.poll.mode` | `loop`, `off` | P6 | D3 |
| `workflows.triggers.poll.interval` | `5m` (mínimo `1m`) | P6 | D3 |
| `workflows.triggers.poll.on_error` | `backoff`, `pause_binding` | P6 | [proposta] |
| `workflows.security.require_approval` | `[push, comment, label]`, `none`, lista | P8 | docs/24 §12 |
| `workflows.security.untrusted_text` | `mark`, `mark_and_truncate` | P8 | [proposta] |
| `workflows.budget.on_exhausted` | `pause`, `stop` | P5 | docs/24 §12 |
| `workflows.binding.concurrency` | `1` | P5 | docs/24 §12 |
| `workflows.binding.on_busy` | `queue`, `skip`, `replace` | P5 | docs/24 §12 |
| `workflows.packages.sources` | `[file, git]`, `file`, `git` | P9 | docs/24 §12 |
| `workflows.packages.signature` | `verify_if_present`, `require`, `off` | P9 | docs/24 §12, D5 |
| `workflows.packages.trusted_keys` | lista vazia (chaves públicas SSH) | P9 | D5 |
| `workflows.packages.unsigned` | `confirm`, `reject` | P9 | D5 |
| `workflows.simulate.max_steps` | `200` | P10 | [proposta] |
| `adapters.issue_tracker` | `same_as_code_host`, `github`, `none` | P7 | D4 |
| `collab.notes.mode` | `play`, `deps`, `off` | P13 | N308 |
| `collab.notes.max_per_actor` | `20` | P13 | N308 |
| `collab.notes.max_chars` | `2000` | P13 | N308 |
| `supervision.mode` | `warn`, `off`, `log`, `redirect` | P14 | N309 (padrão decidido) |
| `supervision.delivery` | `tool_reply`, `next_turn`, `relaunch` | P14 | D8 |
| `supervision.triggers.outside_demand` | `on`, `off` | P14 | N309 |
| `supervision.triggers.contract_changed` | `on`, `off` | P14 | N309 |
| `supervision.triggers.test_loop` | `3` falhas seguidas do mesmo teste; `off` | P14 | N309 |
| `supervision.triggers.budget_fraction` | `0.8`; `off` | P14 | N309 |
| `supervision.max_warnings_per_demand` | `3` | P14 | N309 |
| `supervision.director_budget` | `0.1` da cota da peça | P14 | N309 |
| `supervision.broadcast` | `on`, `off` | P14 | N309 (extra) |
| `supervision.status_request` | `on`, `off` | P14 | N309 (extra) |
| `collab.ask_director.mode` | `answer`, `relay`, `off` | P15 | N308 |
| `collab.ask_director.timeout` | `10m` | P15 | N308 |
| `collab.ask_director.on_timeout` | `blocked`, `continue` | P15 | N308 |
| `collab.ask_director.max_per_demand` | `3` | P15 | N308 |

A chave `flows.<id>` (N243) continua aceita. O P3 a traduz para parâmetros da definição `play`, com o mesmo efeito, e o `ot config` mostra a forma nova.

## Eventos

Todos **[proposta]** quanto ao nome. Cada um entra no catálogo do protocolo e no do daemon, no passo que o emite.

- P1 a P4: `workflow.validated`, `workflow.rejected` (motivo e caminho do erro), `workflow.run.started`, `workflow.step.started`, `workflow.step.finished`, `workflow.run.finished`, `workflow.migrated`, `workflow.migration_refused` e `workflow.snapshot_rejected`.
- P5: `workflow.binding.changed` (estado anterior e novo) e `workflow.budget_exhausted`.
- P6: `workflow.trigger.fired`, `workflow.trigger.skipped` (motivo: autor, ocupado, pausado, orçamento) e `workflow.poll.failed`.
- P8: `workflow.approval.requested` e `workflow.approval.resolved`.
- P9: `workflow.package.installed`, `workflow.package.removed` e `workflow.package.signature_failed`.
- P13: `note.posted` e `collab.limit_reached`.
- P14: `supervision.signal`, `supervision.warning`, `supervision.redirect`, `supervision.broadcast`, `supervision.status_requested` e `supervision.limit_reached`.
- P15: `actor.question` e `actor.answer`; o prazo vencido gera `actor.question_timeout`.

## Detalhe dos passos

### P1. `@otheater/workflows`

**Arquivos:** `packages/workflows/` (novo), `pnpm-workspace.yaml` se for preciso, `tsconfig` de referência, `docs/reference/workflow-definition.schema.json` (gerado).

- Schema zod da definição (docs/24 §4): `id`, `version`, `engine`, `inputs`, `nodes`, `edges`, `limits` e `triggers`. O JSON Schema é gerado a partir dele, como o `flow-config.schema.json`.
- Linguagem de condição fechada (docs/24 §4 e §13): a lista de operadores é fixa, e cada operador tem teste. Não há chamada nem laço.
- Compilador para uma configuração XState (puro, sem `createActor`), com os tipos de passo vindos de um registro que o chamador passa.
- Validador (docs/24 §5): schema, tipos, alcance, ciclos limitados por `limits`, plugins exigidos e aprovação antes de `push`, `comment` e `label`. Os erros têm caminho (`nodes.review.edges[1]`) e texto.
- Hash estável da definição normalizada.
- **Aceite próprio:** a definição `play` (escrita neste passo, só como dado) valida e compila; casos negativos para cada regra do validador; o hash não muda com a ordem das chaves.

**Como ficou** (2026-11-25, [V] com 145 testes locais):

- O pacote é puro: depende só de `@otheater/core`, `zod` e `yaml`. O `xstate` entra só como dependência de desenvolvimento, para o teste que roda a configuração compilada num ator real. A regra `workflows-pure` do dependency-cruiser impede que ele importe o daemon, o cliente ou o Node.
- Módulos:
  - `definition` (schema zod);
  - `condition` (análise, checagem de tipos e avaliação);
  - `step-types` (registro de tipos de passo, com os genéricos, os do code host e os da peça);
  - `validate`, `compile` (configuração XState com guardas e ações nomeadas, sem `createActor`) e `hash` (SHA-256 do JSON canônico);
  - `yaml`, que lê o YAML com posição de linha e coluna;
  - `schema-file`, que gera `docs/reference/workflow-definition.schema.json` (pelo script `pnpm workflow:schema`);
  - `definitions/play` (a peça só como dado).
- Arestas: aceitam a forma curta (`'a -> b when cond'`) e a de objeto (`from`, `to`, `when`, `limit`, `on_limit`). As duas dão o mesmo hash.
- Os erros levam o caminho real no documento (`edges[3].when`, `nodes.review.step`) e um código da lista `VALIDATION_CODES`. Cada código tem um caso negativo, e um teste confere que nenhum fica sem caso.
- Regra dos ciclos: todo ciclo precisa de uma aresta com `limit`. O caminho por `on_limit` também conta, então `a -(limit, on_limit c)-> b` com `c -> a` é recusado.
- No YAML, chaves repetidas, tags desconhecidas e avisos do parser viram erro com linha e coluna. O tamanho e o número de aliases têm limite.
- A linguagem de condição tem:
  - os operadores `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `and`, `or`, `not` e parênteses;
  - os literais string, número, booleano, `null` e lista à direita do `in`;
  - os caminhos `output.*` e `inputs.*`, sem ler o protótipo.
  O tamanho (500) e a profundidade (32) são opções.
- A peça como dado valida sem erro nem aviso, compila e percorre o caminho feliz, os atalhos e os limites. O hash não muda com a ordem das chaves.
- **[proposta], perguntas ao dono (vão no PR):**
  1. `deliver` sem modo segue o `delivery.mode` das regras do Produtor, e conta como aprovação; com `ask` também. Com `pr` ou `direct_merge` fixo na definição, ele passa por cima dessas regras e exige um `approval` antes.
  2. `on_limit` padrão é `failed`; a peça manda ao Produtor.
  3. `producer_rounds: 20` limita as voltas pelo Produtor.
  4. Os tipos nomeados de entrada são `code_host_repo` e `duration`.
  5. Os limites do YAML (256 KiB, 50 aliases) e da condição (500, 32) são opções do pacote. A chave de configuração entra no P2 ou no P10.
  6. As escolhas de `await_producer` são `plan`, `script`, `execution`, `deliver` e `cancel`.
  7. Na peça, a falha da integração vai ao Produtor.
  8. A faixa de `engine` aceita só inteiros (`>=1 <2`).
  9. Os avisos do parser YAML contam como erro.
  10. `approval.on_timeout` tem os modos `stop` e `reject`.

### P2. Runtime do motor e tipos de passo genéricos

**Arquivos:** `daemon/src/workflows/` (novo): `runtime.ts`, `steps/{call-tool,wait-event,branch,approval,notify}.ts`, o bloco no catálogo de eventos.

- O runtime monta o ator XState pelo compilador do P1 e guarda no snapshot `{id, version, hash}` (docs/24 §6). Os efeitos passam pelo `runEffect` (`workspace/effects.ts`), com a chave de idempotência declarada por tipo de passo.
- `call_tool` chama uma ferramenta MCP de plugin fora do processo (N292); `wait_event` espera um evento do log com prazo; `approval` usa o `ask_producer`; `notify` usa o canal de notificação do chat e dos plugins.
- **Aceite próprio:** um workflow pequeno de teste roda com o `fake-agent`; `kill -9` no meio de um `call_tool` retoma sem repetir o efeito (o harness da Fase 11).

**Como ficou** (2026-11-27, [V] com 39 testes locais de unidade e 4 de caos; PR #413; as escolhas do Claude foram aceitas pelo dono em 2026-11-27):

- Módulos novos em `daemon/src/workflows/`:
  - `machine.ts`: monta a máquina XState a partir do `compileWorkflow` do P1, com as guardas e as ações do compilador como `assign` puros, para usar o `transition()` puro como o `PlayRunner`;
  - `runtime.ts`: a classe `WorkflowRuntime` (`start`, `resume`, `resumeAll`, `cancel`, `isActive`, `idle`, `stop`);
  - `steps/{call-tool,wait-event,branch,approval,notify}.ts`, mais `steps/index.ts` (`GENERIC_STEP_RUNNERS`);
  - `effects.ts` (verificadores de `workflow.notify` e `workflow.approval`), `plugin-tool-caller.ts` (adaptador sobre o `PluginAggregator`) e `runtime-config.ts`.
- Como uma execução fica gravada:
  - é um registro de `plays` (`id` = id da execução, `flowId` = id da definição, `state` = nó ou estado final, `counters` = contagem das arestas com `limit`);
  - o snapshot guarda `{workflow: {id, version, hash}, machine, runtime}`;
  - cada transição é uma só transação: registro, snapshot, `workflow.step.finished` e, se terminou, `workflow.run.finished`.
- Retomada: o runtime recalcula o hash da definição que a fonte devolve. Se ela sumiu ou mudou, recusa e grava `workflow.run.refused` (`definition_missing`, `hash_mismatch` e outros), sem mexer no registro. A migração entre versões é do P3/P4.
- Efeitos: `call_tool` de ferramenta que escreve (`local_write`, `network`, `external_write`) e `notify` passam pelo `runEffect`, com a chave `<execução>:<nó>:<visita>` e o tipo `<plugin>.<ferramenta>` (o verificador é o que o plugin registra no `PluginEffectRegistry`). `approval` usa o `ask_producer`; depois de uma queda, a pergunta antiga não pode mais ser respondida, então o passo pergunta de novo.
- Config: bloco `workflows.runtime` em `config.ts` (`wait_event.poll`, `approval.timeout`, `approval.on_timeout` com `stop` ou `reject`, `call_tool.timeout`).
- Eventos novos no catálogo (bloco em `protocol/src/workflow-events.ts`): `workflow.run.started`, `workflow.step.started`, `workflow.step.finished`, `workflow.run.finished`, `workflow.run.refused` e `workflow.notified`.
- Aceite próprio:
  - unidade: um workflow com os cinco tipos de passo roda até o fim; queda simulada em cada ponto `effects.*` retoma sem repetir a escrita (o mundo de teste tem uma escrita só);
  - caos, com `kill -9` de verdade (`workflows/call-tool.chaos.test.ts`, `vitest.chaos.config.ts`, exige `pnpm build`): um processo filho com o store SQLite em disco morre em `effects.after_intend`, `after_execute` e `after_resolve` no meio de um `call_tool`, e um segundo processo retoma; o efeito acontece uma vez só e a execução termina `done`;
  - o `fake-agent` fica de fora: ele serve ao passo `play` (P3), então o aceite usa ferramentas falsas e o plugin de teste do agregador.
- Limites desta etapa (ficam para os passos seguintes):
  - `max_steps`, `max_duration` e `budget_usd` ainda não são aplicados;
  - os `args` do `call_tool` não são interpolados e a chave de idempotência não é repassada ao plugin;
  - o runtime e o `registerWorkflowEffects` ainda não estão ligados à composição do daemon;
  - o `PlayRunner.resumeAll` (P3) emitirá `play_not_resumed` para essas execuções até ser separado;
  - uma aprovação que estoura o prazo deixa a entrada no quadro, e uma aberta logo antes de uma queda pode ficar pendente.

### P3. A definição `play` 2.0

**Arquivos:** `daemon/src/workflows/steps/play/*` (novo), `daemon/src/workflows/definitions/play.yaml`, `daemon/src/pipeline/*` (a máquina escrita à mão sai), `daemon/src/pipeline/flows.ts`, `daemon/src/flows-config.ts`.

- Tipos de passo da peça: `plan`, `clarify`, `review`, `script`, `execute_dag`, `integrate`, `critique`, `decide` e `deliver`. Cada um embrulha o código de etapa que já existe (`runner.ts`, `judgment.ts`, `merge-conflicts`), sem reescrever a etapa.
- A `play` 2.0 tem os mesmos estados de hoje. `PLAY_FLOW_VERSION` passa a 2, e o `assertPlayFlowLinked` confere a definição, e não a máquina.
- O `flows.<id>` vira parâmetro (`skip: [plan_review, critique]`), com o mesmo efeito.
- Snapshot 1.x: `workflows.legacy_snapshot` (`reject`, com `workflow.snapshot_rejected` e um aviso no chat; `cancel`, que cancela a peça e a registra). D2 tira a migração.
- **Aceite próprio:** a suíte da máquina e os e2e da peça passam sem mudar o que conferem (critério 4); o caos da Fase 11 passa sobre a `play` 2.0.

**Como ficou** (2026-11-27, [V] com os testes locais de core, protocol e daemon; PR #418; o desvio e as escolhas do Claude foram aceitos pelo dono em 2026-11-28):
- **A máquina escrita à mão ficou, e a definição a confere.** O plano manda a máquina sair. Para não trocar o núcleo mais testado, e porque o critério 4 pede a mesma suíte sem mudar o que ela confere, o P3 manteve o `playMachine` e fez do `play.yaml` a fonte que o daemon valida, estado a estado, na subida (`assertPlayFlowLinked`) e nos testes. A troca da máquina pela execução da definição fica para o P10, que liga o `PlayStageHost`. O desvio é de risco, não de arquitetura, e o dono o aceitou em 2026-11-28, por múltipla escolha ("Aceitar, troca no P10").
- **`play.yaml` 2.0.0** (`daemon/src/workflows/definitions/`): 11 nós, um por estado da peça (menos `NEED` e os finais), parâmetro `skip` e as arestas de `plan_review` e `critique` condicionadas a ele. O texto é embutido em `play-yaml.ts` (cópia conferida por teste contra o arquivo) para o binário único não depender do disco [proposta]. `PLAY_FLOW_VERSION` e a versão do `flow` `play` no `core` passaram a 2.
- **Diferenças fixadas em teste [proposta]:** a definição tem `EXECUTING -> PLANNING` que a máquina não tem como alvo estático; a máquina tem cinco transições que a definição deixa de fora (`CRITIQUING -> PLANNING`, `DECIDING -> PLANNING`, `DELIVERING -> SCRIPTING`, `PLANNING -> AWAITING_PRODUCER`, `REVIEWING_SCRIPT -> INTEGRATING`), por precisarem de saídas que os tipos de passo ainda não têm. Mudar um dos lados quebra o teste. `limits.producer_rounds` e os papéis do YAML (`author`) não são impostos pela máquina.
- **Tipos de passo** (`workflows/steps/play/`): módulos que embrulham `entryEffects` (sem reescrever a etapa) para `plan`, `clarify`, `review`, `script`, `execute_dag`, `integrate`, `critique`, `decide`, `deliver` e `await_producer`; `createPlayStepRunners(host)` os expõe como `StepRunner` por uma porta `PlayStageHost` [proposta]. Nada ficou ligado ao runtime (`runtime.ts` e `steps/index.ts` intactos): quem liga é o P10.
- **`flows.<id>` como parâmetro:** `playParamsOfFlow` e `flowsAsPlayParams` (`pipeline/flow-selection.ts`) dão a forma `{workflow: 'play', params: {skip, limits}}`, e `flowRefOf` usa o mesmo `skip`; o efeito na máquina é o de antes (teste com o fluxo `quick`). [N] Não achei no repositório a superfície do `ot config` que mostra os fluxos, então a forma nova só existe como função; ligá-la fica para quem tocar essa superfície [proposta].
- **Snapshot 1.x:** `workflows.legacy_snapshot` (`reject` por padrão, `cancel`), com o evento `workflow.snapshot_rejected` (`flowId`, `savedVersion`, `currentVersion`, `mode`) e o aviso `play_not_resumed` (detalhe `legacy_snapshot`) no chat, em vez de um tipo de aviso novo [proposta]. No `cancel` a peça vira `CANCELLED` e o fim é notificado. Sem migração (D2/N311). `resumeAll` passou a ignorar registros de outro `flowId` (são execuções do motor genérico, que o runtime do P2 retoma) [proposta].
- **Os ganchos do P14** (`redirectReason`/`redirectFeedback`) ficaram como estavam; só o `wiring.ts` ganhou `legacySnapshot`.
- **Escolhas do Claude (decidido pelo dono em 2026-11-28, "Aceitar todas"):** as marcadas acima, que valem como estão: o texto embutido em `play-yaml.ts`; as diferenças entre a máquina e a definição fixadas em teste; a porta `PlayStageHost` e o `createPlayStepRunners`; a forma `{workflow, params}` só como função, até alguém tocar a superfície do `ot config`; o aviso `play_not_resumed` com o detalhe `legacy_snapshot`, em vez de um tipo novo; os modos de `workflows.legacy_snapshot`; e o `resumeAll` que ignora os registros de outro `flowId`.
- **Testes novos:** `play-definition.test.ts`, `play-steps.test.ts`, `runner-legacy.test.ts`, `flow-params.test.ts`, `legacy-snapshot-config.test.ts` e o do payload do evento; ajustes de versão em `flows.test.ts` e `flow-machine.test.ts` (sem mudar o que conferem) e a contagem do catálogo (169 com o P3 sozinho; 176 na main, com P8 e P9).

### P4. Versão de nascimento e migração em ponto seguro (N295)

**Arquivos:** `daemon/src/workflows/migrate.ts`, `daemon/src/workflows/fixtures/play-2.1.yaml` (só de teste), `daemon/src/chaos/` (o gerador de workflows).

- Implementa a migração da N295, com `workflows.running_on_change` e o mapeamento `estado antigo -> estado novo` validado pelo compilador.
- O harness de caos ganha um gerador de definições pequenas e roda I1 a I8 sobre elas (docs/24 §6).
- **Aceite próprio:** a parte 2 do critério de aceite.

**Como ficou** (2026-11-28, [V] com os testes locais de protocol, workflows e daemon e com o caos de `kill -9` sobre o `pnpm build`; as escolhas marcadas [proposta] foram aceitas pelo dono em 2026-11-28, por múltipla escolha: "Aceitar todas"). Por ordem do dono de 2026-11-28, a troca da `playMachine` pela execução da `play.yaml` ficou para um passo próprio, o **P10c**: o P4 vale só para o motor genérico (`WorkflowRuntime`), e a `play` continua no `PlayRunner` (`pipeline/` e a máquina intactos).
- **Versão de nascimento:** o snapshot da execução guarda `born: {id, version, hash}` (a definição em que ela nasceu) ao lado de `workflow` (a de agora). Sem migração, as duas são iguais. [V] Teste: uma execução nascida na 2.0 continua na 2.0 depois de a 2.1 ser ativada, com `pin`.
- **`workflows.running_on_change`:** `pin` (padrão) ou `migrate_at_safe_point`. A biblioteca avisa o runtime depois de ativar uma versão (gancho `onActivated`, com `runtime.onActivated`). Com `pin`, o runtime não pede nada e as execuções vivas ficam onde nasceram. Com `migrate_at_safe_point`, ele pede a migração das execuções abertas do workflow à versão ativada (só se for maior que a delas). [V] O Produtor também pode pedir uma migração explícita (`runtime.requestMigration(runId, versão)`), nos dois modos [proposta].
- **Ponto seguro:** a migração só se aplica entre dois passos, com `inFlight === null`, sem efeito aberto no diário (`pending` ou `ambiguous`; `not_done` é veredito fechado) e com `safePoint` no tipo de passo do nó que a execução está para entrar. Uma execução parada em `approval` ou `wait_event` não está em ponto seguro. O pedido fica gravado no snapshot (`runtime.migration`), então sobrevive a uma queda; um pedido novo substitui o antigo [proposta]. [V]
- **Mapeamento:** vive na definição NOVA, em `migrate_from: {<versão antiga>: {<nó antigo>: <nó novo>}}` [proposta]. O compilador (`@otheater/workflows`) valida a forma: versão em semver menor que a da definição (`migration_version`) e destino que seja nó dela (`migration_target`). O runtime confere, ao migrar, que a origem é nó da versão antiga (`mapping_invalid`). O JSON Schema de `docs/reference` foi regenerado. [V]
- **Recusa:** sem mapeamento para a versão da execução, ou com o nó atual fora do mapa, a migração é recusada com o evento `workflow.migration_refused` (oito motivos: `no_mapping`, `mapping_invalid`, `state_unmapped`, `inputs_incompatible`, entre outros), e a execução segue na versão em que está. A migração feita grava `workflow.migrated` (`fromState`, `toState`, versões, contadores levados e descartados). Os dois eventos entram no catálogo (184). [V]
- **Atomicidade:** `#applyMigration` grava o registro, o snapshot e `workflow.migrated` numa só transação. Os contadores levam-se por chave (os que a versão nova não tem são descartados e nomeados no evento); a memória dos passos zera; as entradas são resolvidas de novo contra a definição nova e precisam caber (`inputs_incompatible`) [proposta]. O `flowVersion` do registro não muda [proposta].
- **Fixture (só de teste):** `daemon/src/workflows/fixtures/migration-fixture.ts` tem a 2.0 e a 2.1 de um fluxo `ticket` e variantes (sem mapa, mapa parcial, entrada nova, limite renomeado). [V] `migration.test.ts` (15 testes): a nascida na 2.0 fica na 2.0; o pedido espera o ponto seguro; sem mapa é recusado. O `play-2.1.yaml` do plano ficou de fora, por causa da ordem do dono (vai ao P10c).
- **Caos (gerador):** `daemon/src/chaos/workflow-generator.test-support.ts` faz, de uma semente, um par de definições pequenas (1.0.0 e 1.1.0: cadeia de 4 a 7 nós, um passo-portão de leitura no meio, nós renomeados e um passo inserido na nova), com os efeitos esperados em ordem. [V] `workflow-generator.test.ts` (93 testes) confere determinismo, validade, mapa e que o motor entrega o que o par diz.
- **Caos (`kill -9`):** `migration.chaos.test.ts` roda um processo filho com o store SQLite em disco, que morre nos pontos `effects.after_intend`, `after_execute` e `after_resolve` de uma escrita, de um aviso e do primeiro efeito da 1.1.0, e em `store.before_commit` e `store.after_commit` da transação da própria migração, e logo depois de o pedido ser gravado; um segundo processo retoma, e um terceiro nada muda. O portão pede a migração de dentro do passo, para o pedido sempre vir antes dos efeitos seguintes. [V] 13 casos, com as sementes 1, 99, 4242, 31337 e uma aleatória. Invariantes:
  - I1, I2, I4, I5, I7 e I8 conferidos de fato (I4 pelo arquivo do mundo, que faz de diário externo; I8 com `workflow.migrated`, `workflow.migration_refused` e `workflow.notified` entre os eventos que ocorrem uma vez);
  - [proposta] I3 (clientes) e I6 (subida do daemon inteiro) não se aplicam a esse processo filho, que só tem store, runtime e ferramentas falsas; foram trocados por asserções diretas (versão final, `born`, `runtime.migration` nulo, um `workflow.migrated`, nenhuma recusa, nenhum efeito `pending` ou `ambiguous`).
- **Aceite próprio:** a parte 2 do critério, no motor genérico: a nascida na 2.0 fica na 2.0 depois de a 2.1 entrar; o pedido espera o ponto seguro; sem mapa é recusado; o caos I1 a I8 passa sobre as definições geradas.
- **Decisões do dono (2026-11-28, por múltipla escolha, iguais à recomendação):**
  - as escolhas abaixo ficam como estão;
  - a ligação da chave e do gancho na composição do daemon entra no **P10b**, junto com o `require_approval` que a composição ainda não passa aos validadores (achado no P12);
  - os desvios (I3 e I6 por asserções diretas; fluxo genérico no lugar do `play-2.1.yaml`) ficam aceitos e se completam no **P10c**.
- **Escolhas do Claude [proposta, aceitas]:**
  - o mapa na definição nova (`migrate_from`);
  - a regra do ponto seguro (`safePoint` do nó a entrar mais nenhum efeito aberto);
  - o pedido guardado no snapshot e a substituição por um pedido novo;
  - o `born` no snapshot;
  - os contadores levados por chave e as entradas conferidas de novo;
  - o nome `migrate_at_safe_point`;
  - o pedido explícito do Produtor, nos dois modos;
  - o gancho `onActivated` da biblioteca, cujas falhas são engolidas para não impedir a ativação (o resultado vai ao evento);
  - o `liveRuns` da biblioteca contado pela versão atual da execução;
  - os nomes e os motivos dos dois eventos;
  - o `flowVersion` do registro intacto;
  - o desenho do caos (portão que pede a migração, morte na transação da migração por um invólucro da transação, I4 pelo mundo, I3 e I6 fora).
- **Fica para o P10c** (a `play` na definição):
  - a peça nascida na `play` 2.0 continuar nela depois da 2.1, e a migração da peça pelo `playMachine` e pelo snapshot dela;
  - (passou ao P10b, por decisão do dono de 2026-11-28) ligar na composição do daemon (`compose.ts`, fora do escopo do P4) a opção `runningOnChange` do runtime à chave `workflows.running_on_change` e o gancho `library.onActivated` a `runtime.onActivated`; [N] até lá, o gancho existe e está testado, mas o daemon não o liga;
  - o `play-2.1.yaml` de teste e o caos I1 a I8 sobre a `play` 2.0 rodando pela definição.

### P5. Biblioteca e vínculos (N296)

**Arquivos:** `core/src/ports/workflows.ts` (novo agregado do store), `adapters/store-sqlite/src/` (migração com as tabelas `workflow_definitions` e `workflow_bindings`), `daemon/src/workflows/library.ts`, `daemon/src/workflows/bindings.ts`.

- A biblioteca é global, e as versões antigas ficam enquanto houver execução viva nelas.
- O vínculo liga um cenário a um workflow. Os estados são `active`, `paused`, `stopped` e `expired`; há prazo (`until`), orçamento por período, `concurrency` e `on_busy`.
- **Aceite próprio:** suíte de conformidade do agregado novo no store SQLite e no de memória; transições de estado do vínculo com o relógio falso.

**Como ficou** (2026-11-27, [V] com os testes locais de core, sdk, adaptador SQLite, protocol e daemon; PR #412):

- **Store (porta 0.9.0):** `store.workflowDefinitions` (biblioteca: `put`, `get`, `active`, `list`, `activate`, `remove`) e `store.workflowBindings` (`create`, `get`, `list`, `update`, `transition`, `recordSpend`, `rollPeriod`), sobre as tabelas `workflow_definitions` e `workflow_bindings` (migração `0011_workflows`). O core não importa `@otheater/workflows`; por isso o store guarda a definição como JSON opaco e só confere que `id` e `version` do documento batem com as colunas. Quem valida e calcula o hash é a biblioteca do daemon.
- **Biblioteca (`library.ts`):** `install` valida com `validateWorkflow`, calcula `workflowHash` e salva a versão; uma versão nunca muda (mesmo hash é idempotente, outro hash é `Conflict`). `resolve` entende `*` (a versão ativa), a versão exata e `1.x`/`1.2.x` (a maior que casa). `remove` recusa a versão ativa e a versão com execução viva nela. Banco: no máximo uma versão ativa por workflow (índice único parcial).
- **Vínculos (`bindings.ts`):** `create` aplica os padrões das chaves e confere `workflows.allowed` e a existência de versão na biblioteca; `until` aceita data, duração (`7d`) ou `none`; `pause`, `resume` e `stop` são do Produtor; `tick()` expira o vínculo cujo prazo passou e retoma o pausado por orçamento quando o período novo liberou; `recordSpend` pausa (ou encerra, por `workflows.budget.on_exhausted`) ao atingir o orçamento. Banco: um vínculo vivo (`active` ou `paused`) por cenário e workflow.
- **Eventos novos:** `workflow.binding.changed` (criação e toda mudança de estado) e `workflow.budget_exhausted`. O aviso no chat sai pelo callback `onBudgetExhausted`; quem liga o canal é o P10.
- **Chaves novas:** `workflows.default`, `workflows.allowed`, `workflows.budget.on_exhausted`, `workflows.budget.period`, `workflows.binding.concurrency`, `workflows.binding.on_busy`.
- **Aceite próprio:** a suíte `describeWorkflowAggregatesConformance` (sdk) roda no store de memória e no SQLite (os dois drivers); a migração tem teste de subida e prova dos índices únicos parciais; as transições do vínculo (pausa, retomada, parada, prazo, orçamento, virada de período) são testadas com o relógio falso, no store e no daemon.
- **Escolhas do Claude (decidido pelo dono em 2026-11-27):**
  - o estado do vínculo guarda o motivo (`producer`, `budget`, `deadline`);
  - o período do orçamento é uma janela fixa de 24 h, 7 d ou 30 d, contada do início do vínculo (e não o calendário), com a chave `workflows.budget.period`;
  - o gasto é gravado em qualquer estado, e o que fazer ao esgotar é do daemon, não do store;
  - o pause por orçamento volta sozinho no período seguinte (no `tick()`), e o Produtor pode retomar à mão só depois que o período virou;
  - as versões antigas ficam enquanto houver um play aberto do mesmo `flowId` (sonda conservadora, trocável por `liveRuns`), porque o play guarda `flowVersion` inteiro e a definição tem versão semântica;
  - o formato `*`, `1.x`, `1.2.x` ou exata para `versionRange`;
  - a primeira versão salva de um workflow vira a ativa, e as outras só ficam salvas, a menos que se peça `activate`;
  - as colunas e os nomes dos campos dos dois eventos.

### P6. Gatilhos e o laço de sondagem (D3, D6)

**Arquivos:** `daemon/src/workflows/triggers/` (novo): `poll-loop.ts`, `internal.ts`, `plugin-events.ts`, `authors.ts`.

- O laço de sondagem usa a porta `Clock` e os `wakeups`, sem gatilho do sistema operacional. A Fase 9b, quando vier, o reaproveita (D3).
- Gatilhos internos: eventos do log, filtrados pelo nome.
- Gatilhos do code host, por sondagem: `issue_opened`, `issue_labeled`, `pr_opened` e `ci_failed`, pela porta do P7, com filtro de autor e de rótulo.
- Eventos de plugin: as três condições da D6. O manifesto de plugin ganha o campo `triggers` opcional (`docs/reference/plugin-manifest.schema.json`).
- **Aceite próprio:** com o relógio falso, a issue nova dispara uma vez; o autor fora da lista é pulado; o vínculo ocupado segue `on_busy`; um evento de plugin não declarado não dispara.

**Como ficou** (2026-11-28, [V] com tsc, os testes locais do protocolo, do núcleo e do daemon; PR #421; o desvio da D3 e as escolhas do Claude foram aceitos pelo dono em 2026-11-28):

- **Montagem:** `createWorkflowTriggers(deps)` (`triggers/service.ts`) devolve `start`, `stop`, `pass` e o `ledger`. São dois laços sobre o `Clock`: um para o code host (a cada `poll.interval`) e outro para o log de eventos (a cada `event_poll`). `pass()` faz um olhar de cada laço agora, para os testes e para um comando que peça uma olhada. [V] Nenhum gatilho do sistema operacional em modo algum (D3). O `PollLoop` (`poll-loop.ts`) é genérico (`PollSource {id, poll}`), então a Fase 9b pode emprestar o mesmo laço às suas fontes.
- **Gatilhos do vínculo:** o campo `triggers` do vínculo ganhou forma (`types.ts`): `event` (`filter.name`), `code_host.issue_opened`, `code_host.issue_labeled` (`filter.label`), `code_host.pr_opened` e `code_host.ci_failed`, os quatro do code host com `filter.labels` (todos) e `filter.labels_any` (algum). Um gatilho que o daemon não entende gera um `workflow.trigger.skipped` (motivo `invalid`) uma vez por processo e é ignorado.
- **Uma vez só, durável:** o livro `<dados>/workflow-triggers.json` (modo 0600, escrita atômica) guarda o que cada vínculo já tratou (`issue_opened:12`, `pr_opened:7`, `ci_failed:7:<sha>`, `event:<id>`), o cursor do log e a fila de eventos que esperam. A outra metade da garantia é o id da execução, que é função do vínculo e do item: um segundo início é `Conflict`, lido como "já disparou". [V] testado com reinício do serviço sobre a mesma pasta e com o livro apagado.
- **Itens antigos não disparam:** um item criado antes do vínculo (`createdAt`) é ignorado, e o primeiro olhar do log só põe o cursor no fim, sem responder ao histórico.
- **Disparo (`fire.ts`):** respeita os vínculos do P5. Vínculo pausado ou orçamento esgotado não dispara (o item fica para o olhar seguinte, `retry: true`, avisado uma vez). Ocupado segue `on_busy` do vínculo: `queue` guarda o item, `skip` o descarta, `replace` cancela as execuções mais antigas do vínculo (motivo `replaced`) e abre a vaga. Uma execução recusada pelo runtime é descartada com o motivo.
- **Autor (`authors.ts`):** `workflows.triggers.authors`: `allowlist` (padrão, só `authors_list`, sem diferenciar maiúsculas), `collaborators` (pergunta ao code host, resposta guardada por 10 min; a lista também vale) e `any`. Um autor recusado vira `workflow.trigger.skipped` com motivo `author`, `retry: false`, e o item é marcado.
- **Eventos internos (`internal.ts`):** uma fonte lê o log desde o cursor, em lotes de 200, e entrega cada evento aos vínculos que pediram o nome. Os eventos do próprio gatilho (`workflow.trigger.*`, `workflow.poll.failed`) nunca disparam, para o vínculo não se alimentar da própria saída. O evento que chega com o vínculo ocupado (`queue`), pausado ou sem orçamento espera na fila do livro (até 100 por vínculo) e é tentado de novo a cada olhar.
- **Eventos de plugin (`plugin-events.ts`, D6):** só dispara se (1) o plugin está instalado e ativo no cenário e `workflows.triggers.plugin_events` é `declared`, (2) o manifesto declara o evento no campo novo e opcional `triggers`, (3) o vínculo pede o evento pelo nome. A recusa vira `workflow.trigger.skipped` (`plugin_events_off`, `plugin_inactive` ou `undeclared`), uma vez por vínculo, motivo e tipo a cada olhar. O evento de plugin precisa trazer o cenário do vínculo. O esquema `docs/reference/plugin-manifest.schema.json` foi regerado.
- **Falha de sondagem:** o olhar que falha escreve `workflow.poll.failed` (`bindingId`, `triggerType`, `error`, `failures`, `action`, `retryInMs`). Com `poll.on_error: backoff` a fonte espera `interval * 2^falhas` (até `poll.backoff_max`) e as outras fontes seguem; com `pause_binding` o vínculo da fonte é pausado (`bindings.pause`, motivo `producer`) e o Produtor o retoma. A falha de montar a lista de fontes e a do olhar do log sempre fazem `backoff`.
- **Eventos novos:** `workflow.trigger.fired`, `workflow.trigger.skipped` (motivos: `author`, `busy`, `paused`, `budget`, `undeclared`, `plugin_inactive`, `plugin_events_off`, `refused`, `no_workflow`, `invalid`) e `workflow.poll.failed`, nos catálogos do protocolo e do daemon (contagens 179 e 181).
- **Chaves novas:** `workflows.triggers.authors`, `authors_list`, `plugin_events`, `poll.mode`, `poll.interval` (mínimo `1m`), `poll.on_error`, e as [proposta] `poll.backoff_max` (`1h`), `poll.limit` (30, máximo 100) e `event_poll` (`2s` ou `off`).
- **Aceite próprio:** com o relógio falso (`service.test.ts`): a issue nova dispara uma vez (e não de novo após reinício); o autor fora da lista é pulado; o vínculo ocupado segue `queue`, `skip` e `replace`; o evento de plugin não declarado não dispara (e o declarado dispara); o erro de sondagem segue `backoff` (com dobra e teto) e `pause_binding`. Também: `pr_opened`, `ci_failed` (um disparo por sha), filtros de rótulo, `poll.mode: off`, vínculo pausado ou sem orçamento não olhado, `start`/`stop` sem timer sobrando. Mais testes de `poll-loop`, `seen`, `authors`, `types`, `plugin-events`, `fire`, da configuração e do manifesto.
- **Desvio da D3 (aceito pelo dono em 2026-11-28, por múltipla escolha: "Aceitar"):** a D3 fala em um laço "sobre os `wakeups` que já existem". O laço dorme no `Clock` e guarda em memória o próximo olhar de cada fonte, porque a tabela `wakeups` serve ao perfil que espera cota e tem uma linha por perfil. O "uma vez só" continua durável pelo livro e pelo id da execução. Registrado também na N312 do docs/13.
- **Escolhas do Claude (decidido pelo dono em 2026-11-28, "Aceitar todas"):** valem como estão:
  - o laço dorme no `Clock` e guarda em memória o próximo olhar de cada fonte, em vez de usar a tabela `wakeups`, que serve ao perfil que espera cota e é uma linha por perfil;
  - duas portas estreitas injetadas, `PullRequestLister` e `CollaboratorCheck` (e o `CiReader`), porque `CodeHost` e `IssueTracker` não listam PRs nem dizem quem é colaborador;
  - o filtro de autor é uma chave global, não um campo do gatilho;
  - `pause_binding` reaproveita o motivo `producer`, porque não existe motivo de erro de sondagem;
  - o livro em `workflow-triggers.json`, com o limite de 5000 chaves por vínculo e a fila de 100 eventos;
  - os eventos do próprio gatilho não disparam; o vínculo novo não responde ao histórico;
  - as chaves `poll.backoff_max`, `poll.limit` e `event_poll`;
  - a lista `authors_list` também vale no modo `collaborators`;
  - o tipo do gatilho como texto livre no evento, e os nomes dos motivos de `skipped`.
- **[N] Falta para o P10 (agora P10a):** ligar `createWorkflowTriggers` na composição do daemon (`start` ao subir, `stop` ao descer) com o `WorkflowRuntime`, a `WorkflowLibrary`, os `WorkflowBindings`, o registro de plugins e `repoOf` (o repositório do projeto de cada cenário); escrever os adaptadores reais de `PullRequestLister` e `CollaboratorCheck` sobre o GitHub (hoje só falsos nos testes); e a superfície de rotas e CLI que cria vínculos com `triggers` e pede um olhar (`pass`). [N] Sem isso o laço não roda no daemon real, e sem `pullRequests` os gatilhos `pr_opened` e `ci_failed` falham o olhar com `AdapterUnavailable` e seguem `poll.on_error`.

### P7. Porta `IssueTracker` (D4)

**Arquivos:** `core/src/ports/issue-tracker.ts` (novo), `core/src/ports/code-host.ts` (`fetchPullRequest`, `fetchCiLog`; o contrato passa a `0.2.0`), `adapters/codehost-github/src/` (as duas portas), `sdk/src/conformance/issue-tracker.ts`, o falso com diário, `daemon/src/code-host.ts` (`adapters.issue_tracker`).

- `IssueTracker`: buscar e listar issues (com filtro de rótulo, autor e data), comentar em issue e em PR, pôr e tirar rótulo.
- **[proposta]** O log de CI e os dados do PR ficam na `CodeHost`, que é onde o GitHub os serve; só issue, comentário e rótulo vão para a porta nova.
- **Aceite próprio:** a suíte de conformidade passa no falso e no adaptador GitHub (este com o `gh` falso dos testes de hoje); o guia do docs/25 ganha a porta.

**Como ficou** (2026-11-25, [V] com os testes locais de core, sdk, adaptador GitHub, protocol e daemon):

- Porta `IssueTracker` 0.1.0 em `core/src/ports/issue-tracker.ts`. Ela busca e lista issues (filtro de estado, de todos os rótulos, de autor e de data, `limit` de 1 a 100), comenta em issue e em PR, e põe e tira rótulo. Os erros são `NotFound` para número ausente ou do outro tipo e `InvalidInput` para entrada ruim. O falso tem diário e fica em `core/testing`.
- Na `CodeHost` (contrato `0.2.0`): `fetchPullRequest` (corpo, autor, rótulos e sha da cabeça) e `fetchCiLog` (as rodadas do sha, com o log das que falharam, cortado no tamanho pedido). O `LocalCodeHost` responde pelo PR gravado, com autor `local` e CI vazia.
- Adaptador GitHub (`GithubIssueTracker`): `gh api` sobre a API REST, com a autenticação do próprio `gh`, as mesmas opções do code host e o `gh` falso dos testes. A lista pula os PRs que a API mistura nas issues e lê no máximo 5 páginas.
- Suítes `describeIssueTrackerConformance` e as novas da `describeCodeHostConformance`, no falso e no adaptador GitHub.
- No daemon: a chave `adapters.issue_tracker` (`same_as_code_host`, o padrão; `github`; `none`). Com o code host `auto`, o tracker segue o code host de cada repositório. O code host e o tracker do GitHub saem de uma montagem só, que lê o token uma vez. Quando o tracker `github` não pode ser montado, há aviso e o evento `daemon.notice` `issue_tracker_unavailable`, e as chamadas caem em `AdapterUnavailable` com o motivo.
- Escolhas [proposta], que vão ao dono:
  - o log de CI e os dados do PR ficam na `CodeHost`;
  - o mapeamento `queued`;
  - os limites de página (`MAX_LIST_PAGES = 5`) e de lista;
  - `ghost` para conta apagada e `local` como autor do code host local;
  - sem tracker quando o code host é `none` ou `fake`;
  - REST pelo `gh api`, com as mesmas opções do code host;
  - o `remote` das opções, que o `gh` não usa;
  - o evento `issue_tracker_unavailable`;
  - o padrão `same_as_code_host`.

### P8. Tipos de passo do code host e a aprovação

**Arquivos:** `daemon/src/workflows/steps/codehost/*` (novo), `daemon/src/workflows/untrusted.ts`.

- `fetch_issue`, `fetch_pr`, `fetch_ci_log`, `comment` e `label`. O `comment` e o `label` são efeitos `external_write` com chave de idempotência.
- A aprovação antes de push, comentário e rótulo segue `workflows.security.require_approval`. O validador do P1 já recusa a definição que não a tem; o runtime confere de novo.
- O texto que vem de fora (corpo de issue, comentário, log) chega marcado como não confiável no prompt do Ator (docs/24 §9), e o modo `mark_and_truncate` corta pelo tamanho.
- **Aceite próprio:** um comentário sem aprovação não sai; um `kill -9` entre a aprovação e o comentário não comenta duas vezes.

**Como ficou** (2026-11-27, [V] com os testes locais de protocol e daemon; o `kill -9` roda sobre o build, com `vitest.chaos.config.ts`; PR #416; as escolhas do Claude foram aceitas pelo dono em 2026-11-28):

- Os cinco passos estão em `workflows/steps/codehost/`. Eles leem as portas `CodeHost` e `IssueTracker` pelo `StepDeps.codeHost` (opcional; sem ele os passos falham com `code_host_unavailable`). Quem monta o runtime junta `CODE_HOST_STEP_RUNNERS` à lista genérica e chama `registerCodeHostEffects`; a lista padrão continua `GENERIC_STEP_RUNNERS`.
- `fetch_issue`, `fetch_pr` e `fetch_ci_log` só leem, sem efeito no diário. A saída tem os campos tipados, para as condições das arestas, e `text` e `log`, que são o que vai ao prompt. O número vem de `params.number` ou da entrada `issue` ou `pr` da execução. O `fetch_ci_log` dá `failed` e `checks` (os nomes das rodadas que falharam) e guarda o fim do log.
- `comment` e `label` passam por `runEffect` (`external_write`, tipos `workflow.comment` e `workflow.label`), com a chave `<run>:<nó>:<visita>`. O comentário leva no fim um marcador oculto com a chave (`<!-- otheater-effect: ... -->`), e o verificador procura por ele no tracker. O rótulo se repete sem dano, então o verificador dele sempre diz `not_done`.
- A aprovação: o runtime guarda `approvals` no estado da execução (soma 1 quando um `approval` termina com sim), e `comment` e `label` conferem `workflows.security.require_approval` de novo. Sem aprovação o passo falha com `approval_required`, o evento `workflow.write.refused` sai e o tracker nem é chamado. O `approval` passou a emitir `workflow.approval.requested` e `workflow.approval.resolved`.
- O texto de fora vem em `<untrusted-text source="...">`, com um aviso fixo de que é dado e não instrução. Dentro do texto, qualquer `<untrusted-text` ou `</untrusted-text` é reescrito, para ele não fechar o bloco. `mark_and_truncate` corta em caracteres (nunca no meio de um par substituto) e emite `workflow.untrusted.truncated`.
- Chaves novas: `workflows.security.require_approval` (`[push, comment, label]`, `none` ou lista), `untrusted_text` (`mark_and_truncate`, `mark`), `untrusted_max_chars` (20000) e `workflows.codehost.comment_marker` (`on`, `off`).
- Aceite: [V] sem aprovação o comentário não sai, nem com a definição que passou pelo validador; [V] com `kill -9` em `after_intend`, `after_execute` e `after_resolve` entre a aprovação e o comentário, o tracker fica com um comentário só e a execução termina `done` (`comment.chaos.test.ts`, processo filho e SQLite em disco); [V] os mesmos pontos em processo (`codehost.test.ts`).
- Limite: a porta `IssueTracker` não lista comentários. A busca do comentário pelo marcador é um gancho (`findComment`) que o daemon liga; sem ele, depois de uma queda no meio do comentário o passo falha com `effect_ambiguous` (um comentário, nunca dois), e [V] isso também está testado.
- Os tipos dos passos (`CodeHostStepDeps`, `CommentFinder`, `FoundComment`) ficam em `steps/codehost/deps.ts`, para o `steps/types.ts` não importar o `support.ts` (a CI pegou o ciclo no `no-circular`).
- **Escolhas do Claude (decidido pelo dono em 2026-11-28, "Aceitar todas"):**
  - o `approvals` no estado da execução (o log não se consulta por execução);
  - o marcador oculto no comentário e o gancho `findComment` (e, como seguimento, um `listComments` na porta, no P7);
  - o formato do bloco `<untrusted-text>` e do corte, e os nomes `text`, `log`, `url` e `head_sha` na saída;
  - o padrão de 20000 caracteres e de `mark_and_truncate`;
  - os eventos `workflow.approval.requested`, `workflow.approval.resolved`, `workflow.write.refused` e `workflow.untrusted.truncated` (os dois primeiros têm o nome do plano; os campos são [proposta]);
  - as razões de falha `approval_required`, `number_missing`, `comment_body_missing`, `label_nothing_to_do` e `code_host_unavailable`;
  - o corpo do comentário literal, sem interpolação de parâmetros.

### P9. Pacotes de workflow (N298, D5)

**Arquivos:** `daemon/src/workflows/packages/` (novo): `install.ts`, `git-source.ts`, `sshsig.ts`, `permissions.ts`.

- Fontes: pasta ou arquivo, e git com ref fixa (sha; uma branch ou tag é resolvida para o sha na instalação e gravada).
- As permissões (ferramentas, plugins exigidos, efeitos externos) são mostradas antes de instalar.
- Assinatura SSHSIG, conferida com `ssh-keygen -Y verify` contra `workflows.packages.trusted_keys`. Sem `ssh-keygen` no `PATH`, um pacote assinado conta como não conferido e segue `workflows.packages.unsigned`.
- **Aceite próprio:** com chaves geradas no teste, a assinatura válida instala, a inválida é recusada, a ausente pede confirmação (`confirm`) ou é recusada (`reject`); a ref muda no remoto e o pacote instalado não muda.

**Como ficou** (2026-11-28, [V] com 83 testes locais do pacote, os de protocol e o `ssh-keygen` real; PR #417; as escolhas do Claude foram aceitas pelo dono em 2026-11-28):

- Módulos novos em `daemon/src/workflows/packages/`:
  - `install.ts`: `WorkflowPackageInstaller` (`preview`, `install`, `remove`, `list`, `get`), com a política `decidePolicy`;
  - `source.ts` (pasta ou arquivo), `git-source.ts` (git com ref fixa, sobre o `fetchGit` dos plugins: sem hooks, ref resolvida para o commit, `.git` apagado), `manifest.ts`, `sshsig.ts`, `permissions.ts`, `registry.ts` (o arquivo `workflow-packages.json` no diretório de dados) e `config.ts`.
- Formato:
  - uma pasta tem `package.yaml` (id, versão e, por arquivo de workflow, o sha256) e a assinatura `package.yaml.sshsig`: uma só assinatura sobre os bytes do manifesto cobre todos os arquivos;
  - um arquivo de workflow sozinho é um pacote de um workflow, com a assinatura em `<arquivo>.sshsig`;
  - o namespace SSHSIG é `otheater-workflow-package`.
- Assinatura: o JS só lê o SSHSIG para separar a inválida (malformada, outro namespace) da não conferida (chave fora de `trusted_keys`, sem `ssh-keygen`, tempo esgotado). O `verified` vem sempre do `ssh-keygen -Y verify` (código 0 e `Good "` na saída). Estados: `verified`, `invalid`, `unverified`, `absent`, `skipped` (`signature: off`).
- Política: a `invalid` é sempre recusada (evento `workflow.package.signature_failed`); `signature: require` recusa a ausente e a não conferida; com `unsigned: reject` também; com `unsigned: confirm` a instalação pede a confirmação `unsigned`. Uma atualização que traz permissão nova pede ainda `new_permissions`.
- Permissões mostradas na pré-visualização: ferramentas, plugins exigidos e efeitos externos (escritas públicas e ferramentas que escrevem). O registro guarda as permissões da versão atual (troca, não soma).
- Instalação: tudo ou nada (valida todos os workflows antes de gravar). Versão igual com conteúdo igual é `unchanged` e não escreve nada; versão igual com outro conteúdo, ou workflow que já é de outro pacote, é `Conflict`. Grava com `activate: false` e ativa conforme `workflows.packages.activate`. Se algo falha no meio, desfaz: apaga o que criou e reativa as versões que estavam ativas. As instalações são serializadas.
- A ref que muda no remoto não muda o instalado: a definição fica na biblioteca, e o registro guarda `{url, ref, commit}`. Ver o novo estado é uma nova instalação.
- Config: bloco `workflows.packages` em `config.ts`: `sources`, `signature`, `trusted_keys`, `unsigned` (as do plano) e, escolhas do Claude, `activate` (`when_none`, `always`, `never`), `fetch_timeout` (2m), `verify_timeout` (15s), `max_workflows` (50) e `ssh_keygen` (`auto`, ou o caminho do programa).
- Eventos novos no catálogo (`protocol/src/workflow-package-events.ts`): `workflow.package.installed`, `workflow.package.removed` e `workflow.package.signature_failed`. Sozinho, este PR leva o daemon a 171 eventos e o registro a 173; com o P8 já na main, somam 175 e 177.
- Aceite próprio (`install.test.ts`, com chaves Ed25519 geradas no teste e o `ssh-keygen` real, `describe.skipIf` se ele faltar): a assinatura válida instala sem confirmação; a adulterada e a de outro namespace são recusadas, mesmo com `confirm`; a ausente pede confirmação (`confirm`) ou é recusada (`reject`); a chave não confiável e a falta do `ssh-keygen` seguem `unsigned`; a branch que anda no remoto não muda o pacote instalado, a biblioteca nem o registro, e uma nova pré-visualização já mostra a versão nova.
- Limites desta etapa:
  - o instalador não está ligado à composição do daemon nem às rotas (`ot flow install` é do P10);
  - o store não tem desativar: um pacote com versão ativa não sai (`Conflict`); o P10 acrescenta o desativar;
  - `npm` não é fonte (recusada).
- **Escolhas do Claude (decidido pelo dono em 2026-11-28, "Aceitar todas"):** o formato do pacote (`package.yaml` com o sha256 de cada arquivo e uma assinatura só, o arquivo sozinho com `<arquivo>.sshsig`, o namespace `otheater-workflow-package`); os cinco estados da assinatura; as confirmações `unsigned` e `new_permissions`; o registro em `workflow-packages.json`, que guarda as permissões da versão atual; a instalação tudo ou nada, com `unchanged` e `Conflict`; as chaves `activate`, `fetch_timeout`, `verify_timeout`, `max_workflows` e `ssh_keygen`, com os padrões acima; e o desativar no P10.

### P10. A peça pela definição (P10a) e a API e a CLI (P10b) (N297)

**Divisão (dono, 2026-11-28, por múltipla escolha: "Dividir o P10"):** o P4 e o P12 dependem de a peça rodar pela `play.yaml`, que o P10 herdou do P3. Por isso o P10 se divide em dois. O **P10a** vai primeiro e sozinho:
- liga o `PlayStageHost` e o `createPlayStepRunners` ao runtime, a peça passa a rodar pela `play.yaml` e o `playMachine` sai, valendo o critério 4;
- monta o `createWorkflowTriggers` do P6 na composição do daemon;
- escreve os adaptadores GitHub de `PullRequestLister`, `CollaboratorCheck` e `CiReader`.

Depois, o P4 e o P12 correm em paralelo. O **P10b** vem por último, com o resto desta seção: as rotas, a CLI e o desativar.

**Arquivos:** `daemon/src/api/routes/workflows.ts` (novo), `docs/reference/api-routes.json`, `daemon/src/commands/flow.ts` (novo), `client/src/` (os métodos da API).

- As rotas são `validate`, `simulate` (com o `fake-agent`, limitada por `workflows.simulate.max_steps`), `save`, `activate`, `diff`, `list`, `install`, `bindings` e `runs`.
- A CLI é `ot flow validate|simulate|save|activate|diff|list|install|bind|pause|resume|stop`.
- Ativar não reinicia o daemon.
- **Aceite próprio:** os comandos de ponta a ponta contra o daemon de teste; `activate` com uma peça em curso segue a N295.
- **Herdado do P3 e do P9 (dono, 2026-11-28):**
  - a troca da máquina da peça pela definição: ligar o `PlayStageHost` e o `createPlayStepRunners` ao runtime, a peça passar a rodar pela `play.yaml` e o `playMachine` escrito à mão sair; o critério 4 continua valendo (a suíte da máquina e os e2e da peça passam sem mudar o que conferem);
  - o desativar de uma versão na biblioteca, para um pacote com versão ativa poder sair (`ot flow` e a rota).

**Como ficou (P10a)** (2026-11-28, PR #423; [V] com os testes locais de `codehost-github` e `daemon`; sem rede, sem cliente real; as rotas, a CLI e o desativar são do P10b; as escolhas do Claude foram aceitas pelo dono em 2026-11-28):
- **Decisões do dono (2026-11-28, por múltipla escolha):**
  - a troca da máquina (o desvio abaixo) segue por **ponte, e a troca depois**. O P12 cria o tipo de passo `run_play`, que abre uma peça pelo `PlayRunner` atual, e o P4 aplica a N295 ao motor genérico. A troca virou o passo **P10c**, sozinho, depois do P4 e do P12 e antes do P16, ainda com o critério 4. A D2 (N311) continua valendo: a máquina sai, só que no P10c;
  - as escolhas [proposta] deste bloco foram aceitas como estão ("Aceitar todas");
  - com `event_poll: off`, o laço de eventos nem começa; a correção vai no P12, que toca os gatilhos.
- **Os leitores do code host para os gatilhos** (`adapters/codehost-github/src/repo-reader.ts`): `GithubRepoReader`, com `listOpen({repo, since, limit})` para o `PullRequestLister` e `isCollaborator({repo, login})` para o `CollaboratorCheck`, sobre o mesmo `gh api` do adaptador (mesmas opções, mesmo lançador, mesmo token do cofre). O `CiReader` é o próprio `CodeHost` composto (`fetchCiLog`), então não ganhou classe. [V] testados contra o `fake-gh` (4 testes novos; os 66 do pacote passam).
  - [proposta] Uma classe à parte, fora da porta `CodeHost` (0.2.0), para não mudar a porta. Mudar a porta fica com o dono.
  - [proposta] Colaborador é quem tem `admin` ou `write`; `read` fica de fora, porque num repositório público todo mundo o tem.
  - [proposta] `listOpen` lê no máximo 5 páginas de 100 (`MAX_PAGES`), para no primeiro item mais velho que `since` e ordena por atualização, da mais nova para a mais velha. Um login que o GitHub não aceita (conta `[bot]`, caminho com `..`) responde `false` sem chamar a API; 404 responde `false`; qualquer outra falha da API é lançada, para ninguém ler "falhou" como "não é colaborador".
- **A composição do motor** (`daemon/src/workflows/compose.ts`, novo; `compose.ts`, `code-host.ts` e `daemon.ts`): `composeWorkflows` monta a biblioteca, os vínculos, o runtime (só os `StepRunner` genéricos e os do code host), o registro de verificadores de efeito e os gatilhos. No `startDaemon`:
  - os verificadores de efeito entram no `reconcileBeforeResume` (um efeito de workflow cortado por queda é resolvido antes de qualquer retomada);
  - `runtime.resumeAll()` roda depois do `resumeAll` das peças, e as execuções recusadas viram aviso no log;
  - `triggers.start()` roda por último, depois de tudo o que pode falhar na subida, e `triggers.stop()` e `runtime.stop()` são os primeiros passos do desligamento sobre os workflows (antes de a orquestração quiescer);
  - com `workflows.triggers.poll.mode: off` o laço do code host não chama o tracker, a lista de PRs, o CI nem a checagem de colaboradores (o laço dos eventos segue o `event_poll`). [V] 2 testes novos em `daemon-workflows.test.ts` (relógio falso: olha na subida e a cada intervalo, para ao parar, e `off` não chama nada).
  - [proposta] Os portos de `pull_requests` e `collaborators` por `adapters.code_host`: `github` usa o leitor; `auto` (padrão) escolhe por repositório e, onde o code host é o local, a chamada falha com `AdapterUnavailable` e o motivo (`AutoCodeHost.reasonFor`), de modo que a sondagem daquele vínculo falha com mensagem clara e segue o `poll.on_error`; `none`, `fake` e um `codeHost` sobrescrito não têm leitor. As sobrescritas `pullRequests` e `collaborators` (testes) trocam cada porta. [V] 3 testes novos em `compose.test.ts`.
  - [proposta] Sem localizador de comentários (`findComment`): um `comment` cortado por queda termina `effect_ambiguous`, em vez de arriscar um segundo comentário (a porta `IssueTracker` não lista comentários).
  - [proposta] A composição só existe quando há code host e tracker (sempre, fora de sobrescritas que os tirem).
  - [V] Efeito colateral nos testes: os laços dos gatilhos dormem no `Clock` do daemon, então um teste que avança um relógio falso por dias (`daemon-directives.test.ts`, `command-routes.test.ts`) passou a rodar dezenas de milhares de voltas e estourava o tempo. Os dois testes agora configuram `triggers.poll.interval: 1d` e `event_poll: 1d` (o que conferem não mudou). [N] O P6 deixa o laço dos eventos dar volta a cada 2 s mesmo com `event_poll: off` (sem fontes, só dorme); não mudei o P6, mas vale o dono decidir se o laço deve nem começar nesse caso.
- **Desvio: a troca da máquina da peça pela definição NÃO foi feita no P10a.** O `playMachine` continua em `daemon/src/pipeline/` e o `play.yaml` continua só conferindo a máquina (`assertPlayFlowLinked`); `PlayStageHost` e `createPlayStepRunners` continuam sem ligação ao runtime, e as cinco diferenças do P3 não foram resolvidas. O critério 4 ficou intacto, porque nenhum teste da suíte da máquina nem do e2e da peça mudou. Os motivos [V]:
  - o `PlayRunner` é dirigido por evento (`send(playId, evento)`, com a caixa de saída transacional e o `resumeAll` por snapshot do XState), e o `WorkflowRuntime` é dirigido por passo; trocar um pelo outro muda o formato do snapshot e do ponto de retomada, que o caos da Fase 11 (I1 a I8) confere. As cinco transições que a máquina tem e a definição não tem (`CRITIQUING -> PLANNING`, `DECIDING -> PLANNING`, `DELIVERING -> SCRIPTING`, `PLANNING -> AWAITING_PRODUCER`, `REVIEWING_SCRIPT -> INTEGRATING`) pedem saídas novas nos tipos de passo, e o roteiro manda parar e relatar quando o critério 4 não puder ser cumprido de algum jeito, em vez de decidir sozinho;
  - os dois motores convivem sem conflito: o `PlayRunner.resumeAll` pula o que não é `flowId: 'play'` e o `WorkflowRuntime.resumeAll` pula o snapshot que não passa em `SavedRunSchema`; o `workflows.legacy_snapshot`, o `assertPlayFlowLinked`, os ganchos do P14 e o `ask_director` do P15 continuam como estavam.
- **Fica para o P10b (e a troca da máquina, a decidir):** a troca da máquina (exige decidir as cinco diferenças e a forma do snapshot da peça), as rotas e o `ot flow`, o desativar de uma versão, a exposição da biblioteca e dos vínculos no `DaemonHandle`, a instalação da `play` embutida na biblioteca na subida (hoje o teste a instala à mão), o localizador de comentários e o canal do chat para `onBudgetExhausted` (a composição o deixa sem destino).

### P11. Editor do YAML na TUI

**Arquivos:** `tui/src/` (uma tela nova de workflows e o editor), os catálogos `en` e `pt-BR`.

- Lista, abre, edita, valida enquanto digita (o validador do P1, no cliente) e salva ou ativa pela API. O editor visual fica para a Fase 12 (N297).
- **Aceite próprio:** o teste da TUI, nos dois idiomas, cria, valida com erro apontado, corrige e ativa.

**Como ficou:** a preencher.

### P12. Workflows prontos (N293)

**Arquivos:** `daemon/src/workflows/definitions/{github-issues,pr-review,ci-fix}.yaml`, os testes e2e de cada um, e um guia de uso em `docs/` (o número é definido no passo).

- `github-issues`: a issue com rótulo vira uma peça, e a peça vira um PR, com aprovação antes do push.
- `pr-review`: o PR aberto recebe a revisão de um Crítico, que vira um comentário aprovado.
- `ci-fix`: a CI que falhou num PR vira a leitura do log, a correção numa branch e um PR, com aprovação.
- **Aceite próprio:** a parte 1 do critério de aceite, menos o pacote e o editor.

**Como ficou:** [V] feito, na branch `fase11b/p12-workflows-prontos` (2026-11-28). O guia de uso é o [docs/27](27-GUIA-DOS-WORKFLOWS-PRONTOS.md).
- **Decisões do dono (2026-11-28) que o passo seguiu:**
  - o `run_play` é a ponte para a peça de **hoje** (o `PlayRunner`); a troca da `playMachine` por `play.yaml` fica no P10c;
  - a demanda sai da issue, do PR ou do log, espera um estado final, retoma sem abrir uma segunda peça e marca o texto de fora como dado;
  - `event_poll: off` não inicia o laço de eventos do P6 (commit `77fce795`, com teste em `triggers/service.test.ts`).
- **O passo `run_play`:**
  - o tipo está em `workflows/src/step-types.ts` (`BRIDGE_STEP_TYPES`) e o passo, em `daemon/src/workflows/steps/play/run-play.ts`, registrado em `compose.ts`;
  - o adaptador sobre a orquestração é `run-play-port.ts`, e o `open-play.ts` ganhou o id da peça como quarto parâmetro, para o reinício achar a peça;
  - o daemon liga a porta depois do `startOrchestration` (a composição dos workflows vem antes dele), com uma porta tardia;
  - o `run_play` conta como escrita `push`: o validador exige uma `approval` antes e o passo confere `workflows.security.require_approval` de novo (`approval_required` e `workflow.write.refused`);
  - o `comment` ganhou `body_from` (lê do blackboard da execução o que o `run_play` deixou).
- **As três definições** (`daemon/src/workflows/definitions/*.yaml`, embutidas em `ready-yaml.ts` e instaladas pelo daemon como `builtin` e ativas, sem ligar nada):
  - `github-issues`, `pr-review` e `ci-fix`, todas com `approval`, `run_play` e `comment`;
  - cada uma passa no validador do P1 sem erro e sem aviso, e a versão embutida é igual ao arquivo.
- **Testes [V]:**
  - os do passo e do adaptador (`steps/play/`);
  - `ready-workflows.test.ts`, de cada definição;
  - `ready-workflows.e2e.test.ts`, com o motor montado por `composeWorkflows`, o `fake` do code host e do rastreador, o relógio falso e a peça falsa;
  - o e2e prova que a peça, o comentário e o `label` só saem depois da aprovação, e que um autor de fora da lista não inicia nada e gera `workflow.trigger.skipped`.
- **Nada real foi rodado:** nenhum cliente, nenhuma rede, nenhum GitHub. [N] O efeito de uma peça de verdade, com um modelo, fica para o roteiro do dono.
- **[proposta]** (a forma do `run_play` e das definições; vão ao dono):
  - parâmetros `from` (`issue`, `pr`, `ci_log`), `number`, `instructions` e `timeout`; saída `ended`, `delivered`, `branch`, `pr_number`, `pr_url`, `summary` e `play_id`;
  - a aprovação vem **antes** do trabalho, e não só antes do comentário;
  - o rótulo `otheater` do `github-issues`;
  - `body_from` no `comment`;
  - sem um laço de tentativas no `ci-fix`.
- **Desvios do docs/24 (seção 11), por falta do que vem no P10b e no P10c:**
  - sem a triagem pelo Diretor no `github-issues` e sem `Fixes #N` no PR;
  - `pr-review` roda uma peça inteira com a instrução de revisar, porque não há peça só com o Crítico;
  - `ci-fix` abre um PR novo e não faz push na branch do PR que falhou;
  - a aprovação antes da peça existe porque a peça empurra sozinha; uma aprovação depois do trabalho pede um modo de a peça parar antes do push.
- **Observações [V] para quem fizer o P10b e o P10c:**
  - um vínculo não herda os `triggers` da definição (a CLI do P10b deve copiá-los);
  - as saídas de um nó ainda não aparecem nos nós seguintes (a interpolação tiraria o `body_from`);
  - cancelar a execução não cancela a peça que ela abriu;
  - `composeWorkflows` não passa `workflows.security.require_approval` ao validador do motor nem ao da biblioteca: o validador usa o padrão (`push`, `comment`, `label`), e só a guarda de execução segue a configuração.

### P13. Mural de recados (N308, opção 1)

**Arquivos:** `daemon/src/collab/notes.ts` (novo), o bloco de `post_note` e `read_notes` em `core/src/registries/tools.ts`, o handler em `daemon/src/mcp/`, `core/src/blackboard-keys.ts`.

- `post_note` grava no blackboard da peça (`notes/<demanda>`), versionado e com autor; `read_notes` lê os recados das demandas que o modo deixa ver:
  - `play`: todas;
  - `deps`: só as dependências e as dependentes no DAG;
  - `off`: nenhuma.
- Os limites são `max_per_actor` e `max_chars`. Cada recado gera `note.posted`; o limite atingido gera `collab.limit_reached`.
- O recado é dado, não ordem: o texto chega ao outro Ator marcado como vindo de outro Ator, e o contrato continua sendo a interface.
- **Aceite próprio:** dois Atores do `fake-agent` (script `role-play`) trocam um recado pelo mural; o limite é respeitado; com `off`, as ferramentas não aparecem.

**Como ficou:** [V] feito, em PR (2026-11-25).
- A configuração é a seção `collab.notes`, em `daemon/src/collab/notes-config.ts` e `config.ts`:
  - `mode` pode ser `play` (o padrão), `deps` ou `off`;
  - `max_per_actor` vai de 1 a 1000, e o padrão é 20;
  - `max_chars` vai de 1 a `NOTE_TEXT_MAX`, e o padrão é 2000.
- As chaves (`NOTES_KEY_PREFIX`, `notesKey`) estão em `core/src/blackboard-keys.ts`. As ferramentas, só do Ator, estão em `core/src/registries/tools.ts`. Os eventos `note.posted` e `collab.limit_reached` estão em `protocol/src/collab-events.ts`.
- Os handlers estão em `daemon/src/collab/notes.ts`.
  - Cada recado é uma versão de `notes/<demanda>`, com a tentativa como autora. `note.posted` leva o tamanho do texto, não o texto.
  - `read_notes` devolve `source: notes_from_other_actors` e um aviso de que os recados são dados, não ordens.
  - Os erros são `collab_off`, `no_demand`, `limit_reached` (com `limit` e `max`) e `not_visible`.
  - O evento é gravado à parte: se a gravação falhar, o recado fica.
- No modo `off`, o servidor MCP tira as duas ferramentas da lista (a opção `hiddenTools`, lida a cada sessão), e os handlers recusam.
- O `fake-agent` ganhou duas fichas no `role-play`: `#actor-note:<id>=<texto>[*n]` e `#actor-read-notes:<id>`.
- [V] Testes: 12 de unidade (`collab/notes.test.ts`), 1 no servidor (`mcp/server.test.ts`) e 3 de ponta a ponta com o `fake-agent` (`orchestration/notes-e2e.test.ts`: a troca, o limite e o `off`). Todas as suítes afetadas passam (819 testes).
- [proposta] `collab.*` não entrou nas seções quentes de `config-hot.ts`. Os handlers leem a seção na hora do uso, mas uma mudança feita pelo `PUT /v1/config` ainda pede reinício, como as outras seções que não estão na lista.

### P14. Supervisão do Diretor (N309, D8)

**Arquivos:** `daemon/src/supervision/` (novo): `signals.ts`, `channel.ts`, `director-call.ts`; o bloco das ferramentas novas do Diretor (`warn_actor`, `redirect_actor`, `broadcast`, `request_status`) em `core/src/registries/tools.ts`; o anexo do aviso na resposta em `daemon/src/mcp/server.ts`.

- Os sinais são determinísticos e vêm do que o daemon já vê:
  - um arquivo editado fora da demanda;
  - o contrato mudado;
  - o mesmo teste falhando seguidas vezes;
  - uma fração do orçamento passada.
- O Diretor só é chamado quando um sinal dispara, dentro de `supervision.director_budget`.
- O canal é `supervision.delivery: tool_reply`: o aviso entra na resposta da próxima ferramenta MCP que o Ator chamar, marcado como vindo do Diretor. O `redirect` usa `cancel_actor` e relança com o aviso no prompt.
- Os extras usam o mesmo canal, cada um com chave e limite:
  - o aviso de contrato mudado vai a quem depende do contrato;
  - o aviso para todos vai a todos os Atores da peça;
  - o pedido de situação faz o Ator responder pelo `submit` com um estado parcial, sem encerrar.
- **Aceite próprio:** a parte 3 do critério de aceite, menos o `ask_director`.

**Como ficou** (2026-11-27, [V] com os testes locais de protocol, core, daemon e fake-agent; PR #414):

- **Sinais (`supervision/signals.ts`):** o `SignalDetector` vê só o que o daemon já tem (eventos da tentativa, `expectedFiles` da demanda, o roteiro e o tempo gasto) e dispara `outside_demand`, `contract_changed`, `test_loop` (N falhas seguidas do mesmo teste) e `budget_fraction`. Cada sinal vira o evento `supervision.signal` e é dedupado por tentativa e chave.
- **Canal (`supervision/channel.ts`):** os avisos ficam na fila da demanda, persistem no blackboard (`supervision/<demanda>`, chave em `core/src/blackboard-keys.ts`) e sobrevivem ao resume. O MCP (`mcp/server.ts`, opção `notices`) acrescenta o aviso, marcado `[Director supervision, ...]`, na resposta da próxima ferramenta do Ator (menos o `submit`). Se o Ator termina sem recebê-lo, grava `supervision.warning` com `delivered: false`.
- **Chamada ao Diretor (`supervision/director-call.ts`, `service.ts`):** só um sinal chama o Diretor, pela fila de prompts da sessão dele, dentro de `supervision.director_budget`. Ferramentas novas (`core/src/registries/tools.ts`): `warn_actor`, `redirect_actor`, `broadcast`, `request_status`. O `redirect_actor` cancela a tentativa (`cancel_actor`) e a relança com o texto no prompt: o pipeline abre o ponto de julgamento 2 e os ganchos novos `redirectReason` e `redirectFeedback` (`orchestration/play-effects.ts`) devolvem o texto do aviso.
- **Extras:** o aviso de contrato mudado vai do daemon a quem depende do contrato, sem chamar o Diretor; `broadcast` avisa todos os Atores da peça; `request_status` faz o Ator responder pelo `submit` com `result.state === 'status'`, que não encerra a tentativa nem conta como entrega.
- **Eventos novos:** `supervision.signal`, `.warning`, `.redirect`, `.broadcast`, `.status_requested`, `.limit_reached` (168 eventos do daemon e 170 no registro, com os dois da peça).
- **Chaves novas:** `supervision.mode` (`warn` padrão, `off`, `log`, `redirect`), `.delivery` (`tool_reply` padrão, `next_turn`, `relaunch`), `.triggers.outside_demand`, `.contract_changed`, `.test_loop` (3), `.budget_fraction` (0.8), `.max_warnings_per_demand` (3), `.director_budget` (0.1), `.broadcast` e `.status_request` (`on`).
- **Aceite próprio:** `orchestration/supervision-e2e.test.ts` (6 testes, fake-agent com `#actor-supervise` e Diretor falso): a edição fora da demanda gera o sinal e o aviso chega na resposta MCP seguinte; o `redirect` relança com o aviso; cada limite gera `supervision.limit_reached`; a nota entre dois Atores chega pelo quadro de notas (P13). Os módulos têm testes próprios (`signals`, `channel`, `director-call`, `service`, `mcp/server`, `config`).
- **Não coberto por e2e (só por teste de unidade):** `contract_changed`, `broadcast` e `request_status`. [N] Não foi verificado que o `submit` com `state: 'status'` de um Ator real (Claude Code, Codex, OpenCode) deixa a tentativa viva.
- **Escolhas do Claude (decidido pelo dono em 2026-11-27):**
  - `off` não faz nada; `log` só grava o sinal (as ferramentas ficam ocultas); `warn` chama o Diretor; `redirect_actor` só existe no modo `redirect`;
  - `next_turn` só vale a partir do turno seguinte ao da fila; com `relaunch` ou modo `redirect`, o aviso vira redirecionamento;
  - a cota de chamadas é `max(1, floor(director_budget x passos))` (0 desliga as chamadas);
  - `max_warnings_per_demand` conta por demanda (aviso, redirecionamento, contrato, pedido de situação); o `broadcast` é limitado por peça;
  - o roteiro é conferido por mudança de contrato no máximo a cada 2 s e sempre em `demand.transitioned`;
  - o rótulo `[Director supervision, ...]` e os tokens do fake-agent (`#actor-supervise`).

### P15. `ask_director` (N308, opção 2)

**Arquivos:** `daemon/src/collab/ask-director.ts` (novo), o bloco da ferramenta em `core/src/registries/tools.ts`, o handler em `daemon/src/mcp/`.

- O Ator pergunta, e a chamada espera a resposta até `collab.ask_director.timeout`. É o `blocked` que não encerra a demanda.
- No modo `answer`, o Diretor responde da informação que tem. No modo `relay`, ele passa a pergunta ao Ator dono da informação pelo canal do P14 e devolve a resposta.
- No prazo vencido, segue `on_timeout`: `blocked` encerra como hoje, `continue` devolve "sem resposta" e o Ator segue.
- **Aceite próprio:** a pergunta respondida, a pergunta que estoura o prazo nos dois modos e o limite `max_per_demand`.

**Como ficou** (2026-11-28, [V] com 24 testes de unidade e 6 e2e locais, mais os de protocol, core, daemon e fake-agent; PR #420; as escolhas do Claude foram aceitas pelo dono em 2026-11-28):

- **Serviço (`collab/ask-director.ts`, `ask-director-config.ts`):** o `AskDirectorService` registra os handlers das três ferramentas na cadeia do `daemon.ts` e liga ao runtime (sessões do Diretor, fila de prompts, hub de eventos) junto com a supervisão (`orchestration/wiring.ts`). A pergunta vai ao Diretor pela fila de prompts da sessão dele, como prompt `#ot-question`; o texto do Ator vai marcado como dado a pesar, não como ordem.
- **Espera:** a chamada `ask_director` espera até `collab.ask_director.timeout` (`10m`), pelo `Clock`. É cancelável: pelo sinal da requisição MCP (`mcp/server.ts` agora repassa `ctx.mcpReq.signal` em `ToolCaller.signal`), por `attempt.cancelled`, `attempt.aborted` e `session.closed` (menos `interrupted`) da tentativa, por uma peça que chega a estado final e pelo `unbind` do serviço. Em todos os casos o timer é solto.
- **Modos:** `answer` (padrão): o Diretor responde com `answer_actor`. `relay`: o Diretor chama `relay_question` e o aviso (tipo `question`) vai pelo canal do P14 ao Ator dono da informação, que responde com `submit {result: {state: 'answer', questionId, text}}`; esse `submit` não encerra a tentativa (`isStatusAnswer`, em `orchestration/play-effects.ts`, passou a aceitar também `answer`), e a resposta volta ao Ator que perguntou, marcada como vinda de outro Ator. `off`: as três ferramentas ficam ocultas e também são recusadas (`collab_off`) se forem chamadas.
- **Prazo (`on_timeout`):** `continue` devolve `{answered: false, reason: 'timeout'}` e o Ator segue; `blocked` grava um `attempt.submitted` de estado `blocked` em nome do Ator e a resposta manda encerrar o turno. A pergunta some no prazo: uma resposta tardia é recusada (`not_found`).
- **Limite:** `collab.ask_director.max_per_demand` (3), contado pelas versões da chave `questions/<demanda>` do blackboard (`core/src/blackboard-keys.ts`). Acima dele a chamada é recusada (`limit_reached`) e grava `collab.limit_reached` (do P13) com `feature: 'ask_director'` e `limit: 'max_per_demand'`; o Diretor nem é chamado.
- **Eventos novos:** `actor.question`, `actor.answer`, `actor.question_timeout` (`protocol/src/collab-events.ts`, `events.ts`; o registro de eventos passou de 179 para 182 depois do P6 (184 no registro com os 2 de play)). O tipo de aviso `question` entrou em `SUPERVISION_NOTICE_KINDS`.
- **Chaves novas:** `collab.ask_director.mode` (`answer` padrão, `relay`, `off`), `.timeout` (`10m`), `.on_timeout` (`blocked` padrão, `continue`), `.max_per_demand` (3, de 1 a 100).
- **Prompts e fake-agent:** `prompts/actor.md` ganhou "Asking the Director" e `prompts/director.md` ganhou "Questions from the Actors" (snapshots do `prompts-files` atualizados). O fake-agent ganhou `#actor-ask:<id>=<pergunta>[*<n>][@<tentativa>]`, `#actor-answer:<id>=<texto>`, o turno do Diretor para `#ot-question` (a pergunta `silent` fica sem resposta; `relay <demanda> ...` repassa) e `#independent` no pedido, que tira a dependência do `beta` para os dois Atores rodarem juntos.
- **Aceite próprio:** `collab/ask-director.test.ts` (24 testes: resposta, os dois `on_timeout` com o `FakeClock`, relay, limite, cancelamento, modo `off`) e `orchestration/ask-director-e2e.test.ts` (6 testes com o fake-agent: pergunta respondida, prazo em `continue` e em `blocked`, relay entre dois Atores, limite e modo `off`).
- **Não coberto:** [N] não foi verificado com Claude Code, Codex ou OpenCode reais que a chamada MCP longa (até 10 minutos) sobrevive ao tempo limite de chamada de ferramenta de cada cliente, nem que um Ator real responde a pergunta repassada pelo `submit` com `state: 'answer'`. [N] A pergunta pendente vive em memória: um reinício do daemon perde a espera (a pergunta fica no blackboard, mas a chamada do Ator já terá caído com a sessão).
- **Escolhas do Claude (decidido pelo dono em 2026-11-28, "Aceitar todas"):** valem como estão, inclusive a pergunta pendente só em memória:
  - o serviço fica em `collab/ask-director.ts` e a pergunta pendente fica só em memória;
  - os nomes `ask_director` (Ator), `answer_actor` e `relay_question` (Diretor), e o tipo de aviso `question` no canal do P14;
  - o modo `off` oculta e também recusa as três ferramentas; `relay_question` fica oculta fora do modo `relay` e exige `supervision.mode` diferente de `off` e `log`;
  - a resposta repassada é o `submit` com `state: 'answer'`, que não encerra a tentativa;
  - a contagem do limite é o número de versões de `questions/<demanda>`, e o `collab.limit_reached` do P13 é reaproveitado;
  - no `blocked` o daemon grava um `attempt.submitted` de estado `blocked` em nome do Ator;
  - as respostas (do Diretor e de outro Ator) vão marcadas como dado, e o prompt `#ot-question` e as seções novas dos prompts;
  - as quatro chaves `collab.ask_director.*`, a faixa de 1 a 100 do limite e os três eventos novos.

### P16. Aceite da fase

**Arquivos:** `daemon/src/phase11b-acceptance.e2e.test.ts` (novo), a tabela de estado deste documento, o estado da Fase 11b na §10 da arquitetura.

- Roda o critério de aceite inteiro e registra o resultado.
- Lista o que ficou para depois:
  - a pergunta direta a outro Ator (N308, opção 3) fica para depois da 10b;
  - o editor visual fica para a Fase 12;
  - a Fase 9b completa continua fase própria.

**Como ficou:** a preencher.

### P17. Testes da TUI num terminal real (N320)

**Arquivos:** `packages/tui/package.json` (o `@microsoft/tui-test` fixado em `0.1.1`, só como dependência de desenvolvimento), `packages/tui/src/terminal.test-support.ts` (novo), `packages/tui/src/pty.focus.test.ts` (refeito em cima dele), `packages/tui/src/tui-terminal.e2e.test.ts` (novo) e o job da CI que roda esses testes nos três sistemas.

- O suporte abre o `ot tui` compilado contra o daemon do fake-agent (`startChatDaemon`), num terminal emulado, com HOME e pastas temporárias, e fecha tudo no fim.
- O terminal vem da chave `OT_TUI_TEST_BACKEND`: `alacritty` (o padrão), `xtermjs`, `ghostty` ou `all`, que roda cada teste nos três.
- O e2e cobre o que o `ink-testing-library` não vê: as cores do tema, o link OSC 8, o clique do mouse por área, o redimensionamento, o Ctrl+C e a saída limpa do binário real.
- Na falha, o trace (`trace.md`) e o texto da tela vão como artefato da CI, para leitura sem rodar de novo.
- Onde falta o build ou o binário da plataforma, o teste é pulado; com `OT_REQUIRE_PTY=1`, o pulo vira falha, como hoje.
- **Aceite próprio:** os testes passam na CI de Linux, macOS e Windows. Um tema com a cor trocada faz o teste de cor falhar.

**Como ficou** (2026-11-26; [V] no Linux, com os três terminais emulados; macOS e Windows pela CI deste PR):

- O `terminal.test-support.ts` abre o `main.js` da TUI ou o `ot tui` compilado contra o daemon do fake-agent, com HOME e pastas temporárias. A função `withTui` grava o trace e o texto da tela em `OT_TUI_TEST_ARTIFACTS` quando o teste falha.
- O `ui` do teste vai pelo `OT_TUI_UI`, por cima do `SAFE_UI` (assistente `never`, navegador do login `off`). O daemon recebe o mesmo no `config.yaml`, que o `ot tui` lê. Assim nenhum teste abre navegador nem o assistente.
- O `tui-terminal.e2e.test.ts` tem 8 testes por terminal (24 com `OT_TUI_TEST_BACKEND=all`, [V] todos passam):
  - as cores do tema `otheater` por célula (cabeçalho, borda da área com foco, as outras);
  - o tema `terminal`, que sai com as cores nomeadas 12 e 8 da paleta de 16, e não em cor verdadeira;
  - o redimensionamento de 120x30 para 213x83;
  - o clique do mouse em cada área;
  - o link OSC 8 do painel de login (`getByLink`), com o endereço `.invalid` e sem navegador;
  - o Ctrl+C no `main.js` e no `ot tui`, com código 0;
  - um sinal (fora do Windows).

  No fim, o terminal tem de voltar como estava: sem tela alternativa, com o cursor visível, sem bracketed paste e sem modo de mouse.
- O `pty.focus.test.ts` saiu do `pty` do Python e roda em cima do suporte. Ele manda os três pedaços SGR medidos no terminal do Claude desktop, depois do redimensionamento, agora nos três sistemas.
- **Bug achado e corrigido:** com o protocolo de teclado do kitty, o Ctrl+C chega como `ESC [99;5u`, e a TUI não saía. O `isCtrlC` (`keys/use-keymap.ts`) aceita as duas formas, e os testes de `app` e `run` cobrem as duas.
- **Aceite da cor** [V]: com a borda ativa trocada para `#7d8cfe` na paleta, o teste falhou com "expected '#7d8cfe' to be '#7d8cff'"; com a cor de volta, passou.
- [N] Com o `signal('TERM')` do tui-test 0.1.1, o código de saída é 129 e não 143, provavelmente porque a sessão termina com um hang-up (não confirmado no código dele). O teste aceita qualquer código de sinal; o código de cada sinal continua testado no `run.test.tsx`.
- CI: o job novo `tui-terminal` roda os dois arquivos no Ubuntu, no macOS e no Windows, com `OT_REQUIRE_PTY=1`, nas mesmas condições do `linux`. No Windows, ele compila antes o `ot-job-launcher.exe`. Na falha, sobe o artefato `tui-terminal-<sistema>`. Os dois arquivos levam `// ot-ci: no-cross`, para o `cross` não repetir.
- O que a CI mostrou (2026-11-26):
  - Nos runners, a tela ficava vazia. O Ink 8 (`is-in-ci`) trata como CI qualquer `CI` cujo valor não seja `0` nem `false`, até a vazia, e aí só escreve o último quadro. O `supports-color` tira a cor quando a chave `CI` existe. O suporte apaga `CI` e `CONTINUOUS_INTEGRATION` do processo do teste [V: com `CI=true`, os 10 testes passam].
  - No macOS, o aviso da tecla Option toma o lugar da barra de atalhos até a primeira tecla. Depois de desenhar a tela, o suporte aperta F12, que não tem atalho.
  - No Windows, o ConPTY do runner descarta o desligamento do mouse (`?1006l ?1002l ?1000l`). A TUI escreve as sequências duas vezes, como no Linux, e o `?2004l` e o `?1049l` entre elas passam [N: visto no trace, não no código do ConPTY]. Lá o teste não confere o modo do mouse. Fica para o roteiro manual: no Windows Terminal, sair com Ctrl+C e mexer o mouse não pode escrever nada no shell.
- **Decidido pelo dono** (2026-11-26, por múltipla escolha, tudo igual à recomendação; docs/13, N320):
  - o `alacritty` é o terminal padrão;
  - as cores ficam escritas em hexadecimal no teste, e não lidas da paleta, para que uma cor trocada por engano falhe;
  - o `SAFE_UI` fica como está (assistente `never`, navegador do login `off`);
  - os testes rodam num job próprio da CI, o `tui-terminal`, e não no `cross`;
  - a variável do repositório `OT_TUI_TEST_BACKEND` escolhe o terminal na CI, e sem ela vale o `alacritty`. Quem cria a variável é o dono; o Claude não cria.

## Riscos

Os do docs/24 §13 continuam valendo. Este plano acrescenta três **[proposta]**:
- **O P3 troca o núcleo de uma vez (D2), sem a máquina antiga como rede de segurança.** Mitigação: o critério 4 (a mesma suíte) e o caos verde são condição de merge do P3. Se o P3 não fechar, a máquina escrita à mão continua na main, porque o P3 é um PR só.
- **O aviso pela resposta MCP pode não chegar** se o Ator não chamar mais nenhuma ferramenta. Mitigação: se o Ator encerrar sem receber o aviso, o daemon registra `supervision.warning` com `delivered: false`, e o Diretor decide no `submit`. A injeção direta (N308, opção 3) fica para depois da 10b.
- **Sondagem e cota do GitHub.** O laço gasta chamadas da API do GitHub. Mitigação: `poll.interval` com mínimo de `1m`, `on_error: backoff` e o evento `workflow.poll.failed`. [N] O limite de chamadas do `gh` autenticado não foi medido neste plano.
