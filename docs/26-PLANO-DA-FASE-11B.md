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
| P1 | `@otheater/workflows`: schema da definição, linguagem de condição, compilador para XState, validador e hash | P0 | P7, P13 | em PR |
| P2 | Runtime do motor no daemon e tipos de passo genéricos (`call_tool`, `wait_event`, `branch`, `approval`, `notify`) | P1 | P5, P14 | a fazer |
| P3 | A definição `play` 2.0: os tipos de passo da peça, a troca da máquina, o `flows.<id>` como parâmetro, o snapshot 1.x recusado | P2 | P6, P8, P9 | a fazer |
| P4 | Versão de nascimento e migração em ponto seguro (N295), com a 2.0 → 2.1 de teste e o caos sobre workflows gerados | P3 | P10, P12 | a fazer |
| P5 | Biblioteca e vínculos (N296): tabelas, `workflows.default` e `allowed`, estados do vínculo, prazo, orçamento por período, concorrência | P1 | P2, P14 | a fazer |
| P6 | Gatilhos: laço de sondagem mínimo (D3), eventos internos, eventos de plugin declarados (D6), filtro de autor | P5 | P3, P8, P9 | a fazer |
| P7 | Porta `IssueTracker` (D4), adaptador GitHub, falso, conformidade; `fetchPullRequest` e `fetchCiLog` na `CodeHost` | P0 | P1, P13 | em PR |
| P8 | Tipos de passo do code host (`fetch_issue`, `fetch_pr`, `fetch_ci_log`, `comment`, `label`), aprovação antes de push e comentário, texto externo marcado | P2, P7 | P3, P6, P9 | a fazer |
| P9 | Pacotes de workflow (N298): arquivo ou git com ref fixa, permissões na instalação, SSHSIG e chaves confiáveis (D5) | P1, P5 | P3, P6, P8 | a fazer |
| P10 | API e CLI: validar, simular com o `fake-agent`, salvar, ativar, diff, listar, instalar (`ot flow ...`) | P4, P5, P9 | P12 | a fazer |
| P11 | Editor do YAML na TUI, com o validador do P1 | P10 | P15, P16 (a parte automática) | a fazer |
| P12 | Workflows prontos: `github-issues`, `pr-review` e `ci-fix` | P6, P8 | P10 | a fazer |
| P13 | Mural de recados da peça (N308, opção 1): `post_note`, `read_notes` | P0 | P1, P7 | a fazer |
| P14 | Supervisão do Diretor (N309): sinais, `warn` e `redirect`, o canal pela resposta MCP (D8) e os três extras | P13 | P2, P5 | a fazer |
| P15 | `ask_director` (N308, opção 2): o `blocked` que não encerra, com espera, prazo e o modo `relay` pelo canal do P14 | P14 | P3 a P12 | a fazer |
| P16 | Aceite da fase | P1 a P15, P17 | nada | a fazer |
| P17 | Testes da TUI num terminal real com o `@microsoft/tui-test` (N320) | P1, P7, P13 | os da onda 2 | a fazer |

Ondas **[proposta, forma decidida na D9]**:

- onda 1, logo depois do merge deste plano: **P1, P7 e P13**, em paralelo (três agentes);
- onda 2: **P2, P5 e P14**, e o **P17** (N320, acrescentado em 2026-11-25), que mexe só nos testes da TUI e na CI;
- onda 3: **P3, P8 e P9**, e depois **P6** e **P15**, assim que uma vaga abrir;
- onda 4: **P4, P10 e P12**;
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

**Como ficou:** a preencher.

### P3. A definição `play` 2.0

**Arquivos:** `daemon/src/workflows/steps/play/*` (novo), `daemon/src/workflows/definitions/play.yaml`, `daemon/src/pipeline/*` (a máquina escrita à mão sai), `daemon/src/pipeline/flows.ts`, `daemon/src/flows-config.ts`.

- Tipos de passo da peça: `plan`, `clarify`, `review`, `script`, `execute_dag`, `integrate`, `critique`, `decide` e `deliver`. Cada um embrulha o código de etapa que já existe (`runner.ts`, `judgment.ts`, `merge-conflicts`), sem reescrever a etapa.
- A `play` 2.0 tem os mesmos estados de hoje. `PLAY_FLOW_VERSION` passa a 2, e o `assertPlayFlowLinked` confere a definição, e não a máquina.
- O `flows.<id>` vira parâmetro (`skip: [plan_review, critique]`), com o mesmo efeito.
- Snapshot 1.x: `workflows.legacy_snapshot` (`reject`, com `workflow.snapshot_rejected` e um aviso no chat; `cancel`, que cancela a peça e a registra). D2 tira a migração.
- **Aceite próprio:** a suíte da máquina e os e2e da peça passam sem mudar o que conferem (critério 4); o caos da Fase 11 passa sobre a `play` 2.0.

**Como ficou:** a preencher.

### P4. Versão de nascimento e migração em ponto seguro (N295)

**Arquivos:** `daemon/src/workflows/migrate.ts`, `daemon/src/workflows/fixtures/play-2.1.yaml` (só de teste), `daemon/src/chaos/` (o gerador de workflows).

- Implementa a migração da N295, com `workflows.running_on_change` e o mapeamento `estado antigo -> estado novo` validado pelo compilador.
- O harness de caos ganha um gerador de definições pequenas e roda I1 a I8 sobre elas (docs/24 §6).
- **Aceite próprio:** a parte 2 do critério de aceite.

**Como ficou:** a preencher.

### P5. Biblioteca e vínculos (N296)

**Arquivos:** `core/src/ports/workflows.ts` (novo agregado do store), `adapters/store-sqlite/src/` (migração com as tabelas `workflow_definitions` e `workflow_bindings`), `daemon/src/workflows/library.ts`, `daemon/src/workflows/bindings.ts`.

- A biblioteca é global, e as versões antigas ficam enquanto houver execução viva nelas.
- O vínculo liga um cenário a um workflow. Os estados são `active`, `paused`, `stopped` e `expired`; há prazo (`until`), orçamento por período, `concurrency` e `on_busy`.
- **Aceite próprio:** suíte de conformidade do agregado novo no store SQLite e no de memória; transições de estado do vínculo com o relógio falso.

**Como ficou:** a preencher.

### P6. Gatilhos e o laço de sondagem (D3, D6)

**Arquivos:** `daemon/src/workflows/triggers/` (novo): `poll-loop.ts`, `internal.ts`, `plugin-events.ts`, `authors.ts`.

- O laço de sondagem usa a porta `Clock` e os `wakeups`, sem gatilho do sistema operacional. A Fase 9b, quando vier, o reaproveita (D3).
- Gatilhos internos: eventos do log, filtrados pelo nome.
- Gatilhos do code host, por sondagem: `issue_opened`, `issue_labeled`, `pr_opened` e `ci_failed`, pela porta do P7, com filtro de autor e de rótulo.
- Eventos de plugin: as três condições da D6. O manifesto de plugin ganha o campo `triggers` opcional (`docs/reference/plugin-manifest.schema.json`).
- **Aceite próprio:** com o relógio falso, a issue nova dispara uma vez; o autor fora da lista é pulado; o vínculo ocupado segue `on_busy`; um evento de plugin não declarado não dispara.

**Como ficou:** a preencher.

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

**Como ficou:** a preencher.

### P9. Pacotes de workflow (N298, D5)

**Arquivos:** `daemon/src/workflows/packages/` (novo): `install.ts`, `git-source.ts`, `sshsig.ts`, `permissions.ts`.

- Fontes: pasta ou arquivo, e git com ref fixa (sha; uma branch ou tag é resolvida para o sha na instalação e gravada).
- As permissões (ferramentas, plugins exigidos, efeitos externos) são mostradas antes de instalar.
- Assinatura SSHSIG, conferida com `ssh-keygen -Y verify` contra `workflows.packages.trusted_keys`. Sem `ssh-keygen` no `PATH`, um pacote assinado conta como não conferido e segue `workflows.packages.unsigned`.
- **Aceite próprio:** com chaves geradas no teste, a assinatura válida instala, a inválida é recusada, a ausente pede confirmação (`confirm`) ou é recusada (`reject`); a ref muda no remoto e o pacote instalado não muda.

**Como ficou:** a preencher.

### P10. API e CLI (N297)

**Arquivos:** `daemon/src/api/routes/workflows.ts` (novo), `docs/reference/api-routes.json`, `daemon/src/commands/flow.ts` (novo), `client/src/` (os métodos da API).

- As rotas são `validate`, `simulate` (com o `fake-agent`, limitada por `workflows.simulate.max_steps`), `save`, `activate`, `diff`, `list`, `install`, `bindings` e `runs`.
- A CLI é `ot flow validate|simulate|save|activate|diff|list|install|bind|pause|resume|stop`.
- Ativar não reinicia o daemon.
- **Aceite próprio:** os comandos de ponta a ponta contra o daemon de teste; `activate` com uma peça em curso segue a N295.

**Como ficou:** a preencher.

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

**Como ficou:** a preencher.

### P13. Mural de recados (N308, opção 1)

**Arquivos:** `daemon/src/collab/notes.ts` (novo), o bloco de `post_note` e `read_notes` em `core/src/registries/tools.ts`, o handler em `daemon/src/mcp/`, `core/src/blackboard-keys.ts`.

- `post_note` grava no blackboard da peça (`notes/<demanda>`), versionado e com autor; `read_notes` lê os recados das demandas que o modo deixa ver:
  - `play`: todas;
  - `deps`: só as dependências e as dependentes no DAG;
  - `off`: nenhuma.
- Os limites são `max_per_actor` e `max_chars`. Cada recado gera `note.posted`; o limite atingido gera `collab.limit_reached`.
- O recado é dado, não ordem: o texto chega ao outro Ator marcado como vindo de outro Ator, e o contrato continua sendo a interface.
- **Aceite próprio:** dois Atores do `fake-agent` (script `role-play`) trocam um recado pelo mural; o limite é respeitado; com `off`, as ferramentas não aparecem.

**Como ficou:** a preencher.

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

**Como ficou:** a preencher.

### P15. `ask_director` (N308, opção 2)

**Arquivos:** `daemon/src/collab/ask-director.ts` (novo), o bloco da ferramenta em `core/src/registries/tools.ts`, o handler em `daemon/src/mcp/`.

- O Ator pergunta, e a chamada espera a resposta até `collab.ask_director.timeout`. É o `blocked` que não encerra a demanda.
- No modo `answer`, o Diretor responde da informação que tem. No modo `relay`, ele passa a pergunta ao Ator dono da informação pelo canal do P14 e devolve a resposta.
- No prazo vencido, segue `on_timeout`: `blocked` encerra como hoje, `continue` devolve "sem resposta" e o Ator segue.
- **Aceite próprio:** a pergunta respondida, a pergunta que estoura o prazo nos dois modos e o limite `max_per_demand`.

**Como ficou:** a preencher.

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

**Como ficou:** a preencher.

## Riscos

Os do docs/24 §13 continuam valendo. Este plano acrescenta três **[proposta]**:
- **O P3 troca o núcleo de uma vez (D2), sem a máquina antiga como rede de segurança.** Mitigação: o critério 4 (a mesma suíte) e o caos verde são condição de merge do P3. Se o P3 não fechar, a máquina escrita à mão continua na main, porque o P3 é um PR só.
- **O aviso pela resposta MCP pode não chegar** se o Ator não chamar mais nenhuma ferramenta. Mitigação: se o Ator encerrar sem receber o aviso, o daemon registra `supervision.warning` com `delivered: false`, e o Diretor decide no `submit`. A injeção direta (N308, opção 3) fica para depois da 10b.
- **Sondagem e cota do GitHub.** O laço gasta chamadas da API do GitHub. Mitigação: `poll.interval` com mínimo de `1m`, `on_error: backoff` e o evento `workflow.poll.failed`. [N] O limite de chamadas do `gh` autenticado não foi medido neste plano.
