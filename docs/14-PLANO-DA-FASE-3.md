# 14. Plano da Fase 3

Versão 1, de 2026-11-16. Este é o plano de passos da Fase 3 da [arquitetura](framework-ideas/arquitetura.md), §10, "Pipeline, MCP do framework e blackboard". A arquitetura continua sendo a referência: este plano só divide a fase em passos, diz o que pode correr em paralelo e dá o aceite de cada passo. Se os dois divergirem, vale a arquitetura, e este documento é corrigido.

Decisões do dono em 2026-11-16, por múltipla escolha, iguais às recomendações ([docs/13](13-DECISOES-EM-ABERTO.md)):
- **N75:** a Fase 2 fecha com portões;
- **N76:** os downloads da Fase 3, com as versões exatas;
- **N77:** o plano fica neste documento, e a fase ganha o marco interno 3a.

Decisões de 2026-11-17, também iguais às recomendações:
- **N78:** no MVP, o Produtor conversa com o Diretor por um `ot chat` mínimo no terminal, com o Diretor aberto pelo daemon (P8);
- **N79:** `limits.submit_retries`, com padrão 2 (P3);
- **N80:** `events.unknown_type: reject | warn`, com padrão `reject` (P1);
- **N81:** `mcp.port: auto | <número>`, com padrão `auto` (P3).

## Como usar

- Cada passo tem uma branch e um PR com título "Fase 3: ...". O PR que conclui um passo também muda o estado dele na tabela de passos.
- Todo passo exige, além do aceite próprio, `build`, `lint`, `format:check`, `test` e `deps` verdes na máquina e na CI (job `linux`).
- O que está marcado **[proposta]** é detalhe deste plano, ainda sem decisão. Uma chave de configuração nova sempre ganha um padrão e os seus modos. Se ela mudar algum comportamento visível, a escolha vai ao dono, por múltipla escolha, ao abrir o passo.
- Paralelismo:
  - passos sem dependência entre si correm ao mesmo tempo, cada um no seu worktree;
  - dois passos nunca mexem nos mesmos arquivos;
  - no máximo dois subagentes rodam a suíte completa ao mesmo tempo, por causa da memória da máquina (em 2026-11-16, o swap estava com ~470 MB livres) **[V]**.
- Nada real roda nos testes (N57). A peça real do aceite (P13) é rodada pelo dono.

## Ponto de partida

O que já existe foi conferido no código em 2026-11-16 **[V]**. Os caminhos são relativos a `packages/`.

- **Store:**
  - as portas `Store`, `StoreTransaction` e `StoreMaintenance` ficam em `core/src/ports/store.ts`, com `STORE_PORT_VERSION` 0.2.0;
  - o adaptador `adapters/store-sqlite` tem só três migrações (`events`, `attempts` e as retomadas gratuitas).
  - Nenhuma tabela da Fase 3 existe ainda.
- **Eventos:**
  - a porta `EventLog` não conhece os tipos de evento;
  - o único registro é `protocol/src/events.ts`, com 11 tipos `daemon.*`, `session.*` e `attempt.*`. É um objeto fixo, sem validação na subida;
  - o `append` não valida o tipo contra esse registro.
- **Registros (§5.18):** não há registro de papéis, ferramentas, chaves de `rule`, fluxos nem tipos de cenário. O que há de vizinho é a `RolePolicy` (`core/src/ports/client-adapter.ts`).
- **Execução:**
  - `AttemptRunner.run(spec)` e `resume`, `AttemptJournal`, `CheckpointTracker`, `SessionPool` e a classe `Execution` (`daemon/src/execution`);
  - a reconciliação de hoje (`reconcile.ts`) só retoma ou estaciona tentativas;
  - a `SessionSetup.mcpServers` (`McpServerRef {name, url, headers}`) já chega até o `session/new` do `session-acp`, mas o runner não a preenche.
- **Recuperação:**
  - existem o `quick_check` na subida, o backup, o restore e a retenção;
  - faltam os processos órfãos, os efeitos colaterais com verificador e a retomada de peças.
- **Agente falso (`fake-agent`):** fala só ACP, com os roteiros `echo`, `tool-call`, `edit-file`, `write-file`, `fail`, `hang`, `deaf` e `quota-signal`. Ele não chama MCP.
- **Configuração:**
  - o `DaemonConfigSchema` é estrito, então cada grupo novo de chaves entra no schema;
  - o grupo `limits` só tem os timeouts de demanda.
- **CLI:** o `ot` fica em `daemon/src/cli.ts`, com `commands.ts`.

## Dependências novas (N76)

Aprovadas pelo dono em 2026-11-16. A versão é fixa, e todas foram publicadas até 2026-11-02, ou seja, há duas semanas ou mais. Os dados vêm do registro npm (`registry.npmjs.org/<pacote>`), consultado em 2026-11-16 **[V]**.

| Pacote | Versão | Licença | Publicada em | Entra em | Passo |
|---|---|---|---|---|---|
| `xstate` | 5.33.3 | MIT | 2026-10-17 | `daemon` | P4 |
| `@modelcontextprotocol/server` | 2.4.0 | Apache-2.0 | 2026-10-23 | `daemon` | P3 |
| `@modelcontextprotocol/core` | 2.4.0 | Apache-2.0 | 2026-10-23 | transitiva do `server` | P3 |
| `@modelcontextprotocol/node` | 2.1.2 | Apache-2.0 | 2026-10-23 | `daemon` | P3 |
| `hono` | 4.13.16 | MIT | 2026-11-01 | transitiva do `node`, travada no pnpm | P3 |
| `@hono/node-server` | 2.1.6 | MIT | 2026-11-02 | transitiva do `node`, travada no pnpm | P3 |

- O `xstate` não tem dependências nem `engines`. Os pacotes do MCP pedem Node >=20, e o repositório exige >=24.
- O `server` pede `zod ^4.2.0`. O repositório já usa o zod 4.6.7, então fica uma cópia só.
- O Hono e o `@hono/node-server` já eram a escolha da API do daemon (§5.12 e §6.1). Com o `@modelcontextprotocol/node`, eles entram na Fase 3, antes da Fase 6.
- As versões mais novas ainda não completaram duas semanas: `xstate` 5.33.4 (2026-11-07), `hono` 4.13.19 (2026-11-16) e `@hono/node-server` 2.1.8 (2026-11-12).
- Ficam de fora:
  - o `@modelcontextprotocol/client`: o agente falso chama o MCP por `fetch`, e o cliente MCP de plugins é de uma fase posterior;
  - o adaptador `express`.
- Ninguém percorreu a árvore transitiva inteira **[N]**. O verificador de licenças da Fase 1 roda no PR do passo que instala os pacotes, e o `THIRD_PARTY_NOTICES` é gerado de novo nesse PR.
- Cuidados que a documentação aponta **[V]**:
  - na restauração de um snapshot do XState, os atores invocados são reiniciados, e as ações não rodam de novo;
  - a documentação não diz o que acontece com os eventos atrasados (`after`) **[N]**. Por isso, a máquina da peça não usa `after`: os prazos vêm do `Clock` como eventos **[proposta]**;
  - o MCP v2 teve cinco versões em três meses (2.1.0 a 2.4.0), e a versão fixa protege o projeto disso;
  - o handler do MCP não autentica sozinho: o daemon valida o token e passa o `authInfo` à fábrica.
- Não foi conferido se os clientes de MCP do `claude-agent-acp`, do `codex-acp` e do `opencode` conversam com um servidor da especificação 2026-07-28 **[N]**. Os spikes da Fase 0 usaram o SDK v1. Por isso, o P3 traz um teste real opcional (N57) para o dono rodar.

## Fechamento da Fase 2 (N75)

A Fase 2 fechou em 2026-11-16 com portões. O critério de aceite foi cumprido em Linux **[V]**:
- o aceite real no nível `clients`, com os três clientes;
- o aceite real no nível `prompts`, com o Claude Code e o agente falso;
- a medição real de `K` e `processModel` nos três clientes, com 1, 2, 4 e 6 sessões;
- os padrões de `K` por cliente (N74).

Ficam como portões **[N]**:
- **Codex e OpenCode no nível `prompts`:** o aceite real ainda não rodou com eles. Ele é condição para a primeira peça real com cada um deles como Executor. A peça real da Fase 3 usa só o Claude Code com o Haiku, então isso não trava a Fase 3.
- **`K` acima de 6:** não foi medido. A medição é condição para qualquer padrão de `K` maior que 6.

## Passos

| Passo | Título | Depende de | Pode correr junto com | Estado |
|---|---|---|---|---|
| P0 | Plano, fechamento da Fase 2 e downloads (este documento) | nada | nada | feito (PR #49) |
| P1 | Registros validados na subida | P0 | P2, P5 | feito (PR #51) |
| P2 | Store da Fase 3 | P0 | P1, P5 | feito (PR #52) |
| P3 | Servidor MCP do framework | P1 | P4, P6, P11 | feito (PR #54) |
| P4 | Máquina da peça em XState | P1, P2 | P3, P6, P11 | a fazer |
| P5 | Roteiro: validação e DAG | P0 | P1, P2, P3, P4 | feito (PR #50) |
| P6 | Workspace: integração e entrega por PR | P2 | P3, P4, P11 | a fazer |
| P7 | Blackboard e fila única de prompts | P2, P3 | P10 | a fazer |
| P8 | Peça ponta a ponta com o agente falso | P3 a P7, P11 | P10 | a fazer |
| P9 | Reconciliação na subida e `kill -9` | P8 | P10, P12 | a fazer |
| P10 | Ordens globais e locais | P3, P11 | P7, P8, P9 | a fazer |
| P11 | Prompts iniciais dos papéis | P1 | P3, P4, P6 | feito (PR #53) |
| P12 | Cenários e fluxo `chat` | P4, P7, P8 | P9, P10 | a fazer |
| P13 | Aceite da fase e peça real | P9, P10, P12 | nada | a fazer |

Ordem em ondas **[proposta]**:
1. P1, P2 e P5;
2. P3, P4, P6 e P11;
3. P7 e P10;
4. P8 e depois P9; **o marco 3a fecha com o P9**;
5. P12, junto com o P9 e o P10 se der tempo;
6. P13.

**Marco 3a (N77):** uma peça ponta a ponta com o agente falso, nos quatro desfechos e no critério de parada, um reinício do daemon no meio da peça e o `kill -9` no meio de um efeito colateral. São os três primeiros itens do aceite da fase. Ordens, cenários e chat vêm depois, até o aceite completo.

**Estimativa:** 3,5 semanas para a fase inteira, como na §10 **[proposta]**.

### P1. Registros validados na subida (§5.18)

**Escopo:**
- Registros tipados em `core`, só com lógica pura:
  - **papéis:** `director`, `consultant`, `author`, `reviewer`, `scriptwriter`, `actor` e `critic`;
  - **ferramentas do framework:** nome, papéis que a veem, schema zod de entrada e de saída, classe de efeito (sem efeito, worktree ou `external_write`), chave de idempotência e verificador opcional;
  - **chaves de `rule`:** a lista fechada de seis chaves da §5.17, cada uma com o schema do valor;
  - **tipos de evento:** os 11 de hoje migram para o registro, e os eventos de plugin usam o prefixo `plugin.<id>.*`;
  - **fluxos:** id, versão, papéis e ferramentas usados. A máquina da peça entra no P4;
  - **tipos de cenário:** `project`, `task` e `chat`.
- Na subida, o daemon valida os registros e não sobe se algum estiver errado, com uma mensagem que diz qual entrada falhou. Ele confere:
  - nomes únicos;
  - se as ferramentas apontam para papéis que existem;
  - se os fluxos apontam para papéis e ferramentas que existem;
  - se os eventos têm schema;
  - se as chaves de `rule` têm schema de valor.
- O `append` do daemon passa a recusar um tipo de evento fora do registro, pela chave `events.unknown_type: reject | warn`, com padrão `reject` (N80, decidida em 2026-11-17).

**Aceite:**
- Cada regra de validação tem um teste que a reprova.
- O daemon recusa subir com um registro inválido.
- Os 11 tipos atuais continuam com os mesmos payloads, e os testes da Fase 2 passam sem mudança.
- O `pnpm deps` reprova um import de adaptador dentro dos registros do `core`.

### P2. Store da Fase 3 (§7 e §5.21)

**Escopo:**
- Migrações para as tabelas que a Fase 3 usa:
  - `plays`, com o snapshot XState, o id e a versão do fluxo e os contadores;
  - `stages`, `demands`, `decisions`, `blackboard`, `prompt_queue` e `side_effects`;
  - `sessions`, com o pid e o instante de início, para achar processos órfãos;
  - `directives`, `scenarios`, `scenario_repos` e `attachments`.
- As tabelas de tarefas (`task_definitions` e `task_runs`) ficam para a fase do agendador.
- Os agregados novos entram no `StoreTransaction` e no `InMemoryStore`, e o `STORE_PORT_VERSION` passa a 0.3.0.
- Cada agregado ganha uma suíte de conformidade no `sdk`.

**Aceite:**
- As suítes de conformidade passam nos dois drivers (`better-sqlite3` e `node:sqlite`) e no `InMemoryStore`.
- Um banco da Fase 2, com eventos e tentativas, migra sem perda.
- O backup e o restore continuam passando no teste de aceite do daemon.

### P3. Servidor MCP do framework (§5.3)

**Escopo:**
- Instalar o `@modelcontextprotocol/server` 2.4.0 e o `@modelcontextprotocol/node` 2.1.2, com o `hono` e o `@hono/node-server` travados nas versões da tabela (N76).
- Em `daemon/src/mcp`:
  - o servidor usa `createMcpHandler(factory)` e responde por Streamable HTTP só em `127.0.0.1`, com as guardas de `Host` e `Origin` para localhost. A porta vem de `mcp.port: auto | <número>`, com padrão `auto` (N81, decidida em 2026-11-17);
  - cada sessão recebe um token próprio, gerado pelo daemon e ligado à sessão e ao papel;
  - a fábrica lê o `authInfo` e monta só as ferramentas do papel, tiradas do registro do P1.
- O `AttemptRunner` preenche a `SessionSetup.mcpServers` com a URL e o cabeçalho `Authorization`. Isso também vale na retomada por `session/load`.
- As ferramentas `submit*` validam a saída com zod. Uma saída inválida volta ao Executor com o erro, até `limits.submit_retries` vezes (2 na predefinição `moderate`, 1 na `economical` e 3 na `persistent`; N79), e depois disso conta como falha.
- O `ask_producer` ganha o schema da §5.3: de 1 a 4 perguntas, de 2 a 4 opções cada, com a opção recomendada, `multi_select` e `open`.
- O agente falso ganha os roteiros `mcp-call` e `submit`: ele chama as ferramentas por `fetch` em JSON-RPC sobre Streamable HTTP, sem o pacote `client`.
- Um teste real opcional (N57) abre o `claude-agent-acp` com o Haiku, faz uma chamada a uma ferramenta do framework e entrega um `submit` válido. Ele confere se o cliente conversa com o MCP v2, e quem roda é o dono.

**Aceite:**
- Cada papel lista só as próprias ferramentas.
- Um token de outro papel não chama uma ferramenta alheia.
- Um token inválido recebe 401.
- Um `Host` ou `Origin` fora de localhost é recusado.
- Um `submit` inválido volta com o erro e conta no limite, e o `N+1`-ésimo vira falha.
- O agente falso, pelo transporte ACP real, entrega um `submit` válido, e o daemon grava o evento.
- O verificador de licenças passa, e o `THIRD_PARTY_NOTICES` é regenerado.

### P4. Máquina da peça em XState (§5.4)

**Escopo:**
- Instalar o `xstate` 5.33.3.
- Em `daemon/src/pipeline`, o fluxo `play` v1 entra no registro de fluxos, com:
  - todos os estados da §5.4, inclusive `AWAITING_PRODUCER`;
  - os contadores;
  - os três presets de `limits` e os overrides por chave;
  - o menu fixo de cinco opções;
  - a lista fechada de exceções críticas;
  - a dispensa do Crítico, registrada como decisão;
  - os oito pontos de julgamento.
- Persistência:
  - o `getPersistedSnapshot()` é gravado na mesma transação do evento, antes do efeito que a transição dispara;
  - o snapshot só é restaurado na mesma versão do fluxo.
- Efeitos e prazos:
  - os efeitos longos ficam fora da máquina e voltam como eventos;
  - a máquina não usa estados de histórico nem `after`, e os prazos chegam pelo `Clock` **[proposta]**.

**Aceite:**
- Há testes de modelo para cada transição e cada contador, nos três presets.
- Um snapshot gravado e restaurado continua no mesmo estado.
- Um snapshot de outra versão do fluxo é recusado.
- Os prazos rodam com o `FakeClock`.
- Todo contador esgotado leva a `AWAITING_PRODUCER` com o menu fixo.

### P5. Roteiro: validação e DAG (§5.4)

**Escopo:**
- No `core`, só com lógica pura:
  - o schema zod da `Demand`, com `id`, `title`, `description`, `dependsOn`, `contract`, `expectedFiles`, `complexity`, `specialty`, `timeoutMin`, `acceptanceCriteria`, `verify` e `verifyWaiver`;
  - a validação do roteiro: sem ciclos, com os contratos citados existindo, sem `expectedFiles` em comum entre demandas paralelas e com todas as demandas prontas;
  - a ordem topológica em camadas paralelas.

**Aceite:**
- Cada regra tem um caso que reprova, com a mensagem que vai ao Roteirista.
- Um teste baseado em propriedades confirma que a ordem respeita o `dependsOn` e que duas demandas da mesma camada não têm arquivos em comum **[proposta]**.

### P6. Workspace: integração e entrega por PR (§5.5)

**Escopo:**
- As branches `play/<id>/base`, `play/<id>/attempts/<demanda>/<tentativa>` e `play/<id>/integration`.
- A integração junta as tentativas aprovadas na ordem topológica. Um conflito vira falha de roteiro, como na §5.4.
- A entrega segue `delivery.mode: pr | direct_merge | ask`, com `allow_direct_merge: false`.
- Uma porta nova, `CodeHost`, ganha o adaptador `adapters/codehost-github`, que usa o `gh`.
- Abrir PR, empurrar a ref e fazer commit são efeitos colaterais, com chave de idempotência em `side_effects`. Cada um tem um verificador: o PR aberto para a branch, a ref no remoto e o commit com a chave no trailer.
- Nos testes, o remoto é um repositório nu local, e o `CodeHost` é falso. O `gh` real não roda em teste.

**Aceite:**
- Duas tentativas sem conflito se integram.
- Um conflito vira falha de roteiro.
- O PR é pedido uma vez só, mesmo repetindo a entrega.
- Cada verificador responde `done` e `not_done` nos casos certos.
- A suíte de conformidade do `CodeHost` passa com o adaptador falso.

### P7. Blackboard e fila única de prompts (§5.4 e §5.21)

**Escopo:**
- O blackboard é versionado por chave: plano, roteiro, contratos e decisões.
- As ferramentas `read_blackboard`, `read_contract` e `read_decision` ficam no MCP.
- Fila única de prompts do Orquestrador:
  - a mensagem do Produtor tem prioridade;
  - tudo é gravado antes de ir ao Diretor.
- O resumo do estado é montado a partir do store e serve para a troca do Orquestrador e para o Diretor adormecido (P12).

**Aceite:**
- Uma mensagem do Produtor passa à frente na fila.
- Um prompt na fila sobrevive a um reinício.
- Uma leitura do blackboard devolve a versão pedida.
- O resumo sai igual de um store restaurado.

### P8. Peça ponta a ponta com o agente falso

**Escopo:**
- Ligar os passos P3 a P7 e o P11 numa peça completa:
  - o Diretor falso chama `next_action`, `decide` e `open_play`;
  - o `ot chat` mínimo (N78): o daemon abre o Diretor, e o comando manda as mensagens do Produtor pela fila única, mostra as respostas e responde às perguntas do `ask_producer`;
  - os Atores rodam pelo `AttemptRunner`;
  - o Crítico avalia a branch integrada, e a entrega sai por PR no `CodeHost` falso.
- O agente falso ganha roteiros por papel para cada desfecho.

**Aceite:**
- A peça chega a DONE no desfecho aprovado.
- As falhas de execução, de roteiro e estrutural voltam aos estados da §5.4.
- Um contador esgotado para em `AWAITING_PRODUCER`.
- É o primeiro item do aceite da fase.

### P9. Reconciliação na subida e `kill -9` (§5.21)

**Escopo:** a rotina completa, nos passos 2 a 8 da §5.21:
- os processos órfãos, achados pelo pid e pelo instante de início, são mortos pelo `ProcessLauncher`;
- as sessões `active` viram `interrupted`;
- o que ficou sem commit vira `wip(recovery)`;
- os efeitos ambíguos são resolvidos pelo verificador. Sem verificador, a demanda pausa e o Produtor decide;
- as máquinas são reidratadas;
- a vigência das ordens é recalculada;
- o evento `daemon.recovered` é gravado.
- Enquanto a rotina roda, os comandos que mudam estado esperam.

**Aceite:**
- Um reinício do daemon no meio de uma peça retoma do snapshot, que é o segundo item do aceite da fase.
- No `kill -9` do daemon no meio de um efeito colateral, o teste sobe o daemon como processo filho e o mata num ponto marcado. Na subida:
  - o processo órfão do cliente morre;
  - o efeito é resolvido pelo verificador ou vira uma pergunta ao Produtor;
  - nada se repete.
- Isso é o terceiro item do aceite. **Com ele, o marco 3a fecha.**

### P10. Ordens globais e locais (§5.17)

**Escopo:**
- A tabela de ordens e os tipos `instruction`, `rule` e `suspension`, em escopo global ou local, com o campo `roles`.
- A vigência é função pura do relógio: agendada, ativa, vencida ou revogada.
- As ferramentas do Diretor: `list_directives`, `propose_directive`, `extend_directive` e `revoke_directive`.
- O rascunho é confirmado pelo Produtor, e os ids seguem o formato `O<n>`.
- As ordens entram no prefixo dos Executores, montado no P11, e no pacote de continuação.
- Eventos `directive.*` e o comando `ot directives`.
- A janela recorrente fica de fora (§5.17).

**Aceite:** os testes de ordens da §10, como estão lá:
- a global e a local chegam ao prompt e sobrevivem ao reinício;
- a ordem com início futuro só entra depois do início;
- a ordem que vence com o daemon parado fica fora das sessões abertas depois do reinício;
- a suspensão tira a global de um cenário só;
- a `rule` revogada devolve o valor da configuração.

### P11. Prompts iniciais dos papéis

**Escopo:**
- Um prompt para cada papel do registro, em inglês (§5.22).
- O montador do prefixo junta o papel, as ordens (a partir do P10), o contrato e as ferramentas do papel.
- A origem dos prompts passa por uma porta `PromptSource` (§5.18), com o adaptador de arquivos do pacote **[proposta]**.

**Aceite:**
- Cada papel tem prompt e prefixo montados por teste de snapshot.
- Um prompt que cita uma ferramenta fora do registro do papel reprova na subida.

### P12. Cenários e fluxo `chat` (§5.20)

**Escopo:**
- O registro de tipos de cenário e a pasta de cada cenário.
- Anexos `A<n>`:
  - lidos com `read_attachment`;
  - com o limite `scenarios.attachment_max_size`, de 50 MB;
  - uma imagem só vai a um Executor que aceita imagem.
- O Diretor adormece depois de `scenarios.director_idle_after`, de 15 min, e acorda pelo resumo do P7.
- O fluxo `chat`, com os estados `IDLE`, `CONSULTING` e `AWAITING_PRODUCER`, e o papel `consultant`, aberto pela ferramenta `consult`.
- Eventos `scenario.*`.

**Aceite:** os testes de chat da §10, com o agente falso:
- uma pergunta simples é respondida pelo Diretor;
- uma pergunta difícil abre o consultor;
- um anexo de imagem só vai a quem aceita imagem;
- o Diretor adormece e acorda sem perder o estado.

### P13. Aceite da fase e peça real

**Escopo:**
- O nível `play` no `tools/acceptance/real-acceptance.sh` **[proposta]**: uma peça real pequena, com o Orquestrador em `claude-agent-acp` com o Haiku, num repositório de teste. Quem roda é o dono (N57).
- O resultado, com data e marca **[V]**, entra na §10.
- A Fase 3 fecha, com os portões que sobrarem.

**Aceite:** todos os itens do critério de aceite da Fase 3 na §10.

## Decisões que surgem deste plano

As duas que o plano levantou foram decididas pelo dono em 2026-11-17, por múltipla escolha:
- **P3 (N79):** `limits.submit_retries`, com padrão 2;
- **P8 (N78):** o `ot chat` mínimo no terminal, com o Diretor aberto pelo daemon.

As próximas que surgirem vão ao dono do mesmo jeito, ao abrir o passo.
