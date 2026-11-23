# 24 — Desenho do motor de workflows

> Estado: **desenho aprovado, implementação depois da Fase 11** (decisões do dono em 2026-11-23, por múltipla escolha, N291 a N298 do [docs/13](13-DECISOES-EM-ABERTO.md)). Este documento é a base do plano da fase nova (Fase 11b na [arquitetura](framework-ideas/arquitetura.md), §10). Quando o plano for escrito, ele detalha os passos e traz as perguntas que ficam abertas na seção "O que fica para o plano".
>
> Marcas: **[V]** verificado localmente no código em 2026-11-23; **[proposta]** desenho a implementar; **[N]** não confirmado.

## 1. O que se quer

Hoje o OTheater roda um fluxo só, a peça teatral. A ideia do dono (2026-11-23) é que o motor de estados aceite **workflows diferentes**, criados pelo usuário, e que a peça vire **uma definição entre outras**. Exemplos do dono:

- um workflow que acompanha as issues de um repositório do GitHub e atua assim que uma issue nova chega;
- o ciclo de vida de um projeto: quando o projeto termina, ele entra em depuração e correção de bugs. O novo cenário é o projeto do GitHub mais o workflow de issues, ativo por um prazo ou sem prazo, até o Produtor parar.

E, sobre o uso:

- associar workflows a cenários e trocá-los com o cenário em uso;
- criar o workflow dentro do app, validar, salvar e aplicar na hora;
- importar workflows como pacotes, sem precisar de versão nova do OTheater.

## 2. Como está hoje [V]

- `packages/daemon/src/pipeline/machine.ts` (cerca de 1.200 linhas) é **uma** máquina XState escrita à mão, com estados fixos: `NEED`, `PLANNING`, `CLARIFYING`, `REVIEWING_PLAN`, `SCRIPTING`, `REVIEWING_SCRIPT`, `EXECUTING`, `INTEGRATING`, `CRITIQUING`, `DECIDING`, `DELIVERING`, `AWAITING_PRODUCER`, `DONE` e `CANCELLED`.
- `pipeline/flows.ts` (`assertPlayFlowLinked`) só confere que o descritor `play` do registro de fluxos bate com essa máquina: a versão, os papéis e os eventos.
- `flows.<id>` (Fase 9, P12; N133, N241 e N243) só pula `plan_review` e `critique`. O papel de cada etapa é fixo, e o snapshot guarda `context.flow = {id, version, hash, skip}`.
- Os efeitos ficam fora da máquina (intenção, execução e resolução no journal de efeitos), e a reconciliação na subida resolve o que ficou pendente. Isso é o que a Fase 11 testa com o caos.
- A arquitetura (§5.18) já previa "máquinas XState por nome e versão, montadas com etapas reutilizáveis", mas com a fonte "módulos oficiais". O código ficou mais rígido que o texto.

## 3. Decisões (2026-11-23)

| N | Pergunta | Decisão |
|---|---|---|
| N291 | Adotar e quando | Adotar. É uma fase nova logo depois da Fase 11, antes da 10b e da web. O harness de caos da Fase 11 serve de rede de segurança para a troca do motor. |
| N292 | O que uma definição pode conter | Um grafo declarativo em YAML com os tipos de passo oficiais. Os plugins entram pelo passo "chamar ferramenta" (MCP, fora do processo). Nenhum código do usuário roda dentro do motor. |
| N293 | Workflows prontos | Além da peça migrada, vêm três: issues do GitHub, revisão de PR e conserto de CI. |
| N294 | Segurança dos gatilhos externos | O padrão é fechado, com aprovação. Só disparam autores e labels permitidos. Push e comentário público pedem aprovação humana, e há orçamento por execução. Tudo é chave de config, que o usuário pode afrouxar. |
| N295 | Workflow trocado durante uma peça | A peça em curso fica na versão com que nasceu, e a versão nova vale na hora para as próximas. Migrar a peça em curso é opcional, só num ponto seguro e com um mapeamento de estados validado. |
| N296 | Onde ficam e como se ligam aos cenários | Biblioteca global mais vínculo por cenário. O cenário guarda o padrão e a lista dos permitidos, e cada peça escolhe entre os permitidos. O vínculo tem ciclo de vida: prazo (data, duração ou nenhum), pausar, retomar e parar. |
| N297 | Editor no app | A API do daemon permite validar, simular, salvar e ativar sem reiniciar. Na TUI há um editor do YAML com validação ao vivo, diff entre versões e simulação. O editor visual em grafo fica para a web (Fase 12). |
| N298 | Pacotes | Instalados de um arquivo ou de um repositório git com ref fixa. Na instalação, o app mostra as permissões pedidas e aplica o padrão fechado com aprovação. A assinatura é conferida quando existe, e uma chave de config pode exigi-la. |

## 4. Conceitos [proposta]

- **Definição de workflow:** um documento YAML com `id`, `version`, `engine` (a faixa de versão do motor que ela aceita), `inputs`, `nodes`, `edges`, `limits` e `triggers` opcionais. É dado, nunca código. Fica no store com o hash do conteúdo canônico.
- **Tipo de passo:** a unidade que o motor sabe executar. O registro é oficial (§5.18), e cada tipo declara:
  - o schema dos parâmetros;
  - o schema da saída;
  - o papel que usa, se usar;
  - os efeitos que pode causar;
  - os pontos seguros, onde a peça pode ser migrada.
- **Gatilho:** o que cria uma execução. São os tipos do registro de gatilhos (§5.20), ampliados nesta fase.
- **Vínculo:** liga um workflow (id e faixa de versão) a um cenário, com parâmetros, gatilhos, prazo e estado: `active`, `paused`, `stopped` ou `expired`.
- **Execução:** uma peça, no sentido de hoje, de um workflow. Ela guarda `{id, version, hash}` da definição com que nasceu.
- **Pacote:** um conjunto de definições com manifesto, instalado sem versão nova do OTheater.

### Tipos de passo da primeira versão [proposta]

- **Os da peça:**
  - `plan` (Diretor);
  - `clarify` (pergunta ao Produtor);
  - `review` (Revisor, de plano ou de roteiro);
  - `script`;
  - `execute_dag` (Atores);
  - `integrate`;
  - `critique` (Crítico);
  - `decide`;
  - `deliver` (branch, PR, merge, segundo `delivery.mode`).
- **Genéricos:**
  - `call_tool` (ferramenta do framework ou de plugin, por MCP, fora do processo);
  - `wait_event` (espera um evento tipado, com prazo);
  - `branch` (escolhe a aresta por condição);
  - `approval` (aprovação humana pelo chat ou pela interface, com prazo e o que fazer quando vence);
  - `notify`.
- **Do code host:**
  - `comment` (issue ou PR);
  - `label`;
  - `fetch_issue`, `fetch_pr` e `fetch_ci_log` (só leitura).

Um tipo de passo novo só entra por módulo oficial e, portanto, por versão nova. O que é novo e não muda o motor entra por `call_tool` em plugin, sem versão nova.

### Exemplo (ilustrativo) [proposta]

```yaml
id: github-issues
version: 1.0.0
engine: ">=1 <2"
inputs:
  repo: { type: code_host_repo }
triggers:
  - type: code_host.issue_opened
    filter: { labels_any: [bug], authors: allowlist }
nodes:
  read:    { step: fetch_issue }
  triage:  { step: plan, role: director, params: { prompt: triage } }
  ask:     { step: approval, params: { timeout: 24h, on_timeout: stop } }
  fix:     { step: execute_dag }
  check:   { step: critique }
  deliver: { step: deliver, params: { mode: pr, link_issue: fixes } }
  reply:   { step: comment, params: { target: issue } }
edges:
  - read -> triage
  - triage -> ask      when: output.kind == "fix"
  - triage -> reply    when: output.kind == "needs_info"
  - ask -> fix         when: output.approved
  - fix -> check
  - check -> fix       when: output.verdict == "redo"   # bounded by limits.redo
  - check -> deliver   when: output.verdict == "ok"
  - deliver -> reply
limits: { redo: 2, budget_usd: 5, max_duration: 4h }
```

As condições das arestas usam uma linguagem fechada: comparações, `and`, `or`, `not` e `in`, sobre campos da saída tipada do passo anterior e das entradas. Não há chamadas nem laços dentro da expressão.

## 5. Compilação e validação [proposta]

A definição vira uma máquina XState por um compilador do núcleo. O compilador recusa a definição, com erro tipado e o caminho do campo, quando:

- o schema não bate (zod, como os registros de hoje);
- um tipo de passo ou um papel não existe, ou a versão do motor fica fora da faixa;
- os tipos não batem entre a saída de um passo e o que a condição da aresta lê;
- algum nó é inalcançável, ou algum nó não chega a um fim (`done`, `cancelled` ou `failed`);
- um ciclo não tem limite declarado em `limits`;
- uma ferramenta ou um plugin exigido não está instalado;
- falta aprovação antes de push ou comentário público quando `workflows.security.require_approval` exige.

A mesma validação roda em quatro lugares: na subida do daemon, na API (`validar`), na instalação de pacote e na ativação. Uma definição inválida nunca entra no registro, e uma peça nunca descobre no meio do caminho que a definição era ruim.

## 6. Execução e durabilidade [proposta]

- **Efeitos:** continuam fora da máquina, pelo journal de efeitos. Cada tipo de passo declara os efeitos e a chave de idempotência dele. A reconciliação na subida não muda.
- **Snapshot:** cada execução guarda `{id, version, hash}` da definição. Na subida, o daemon recompila a definição pelo hash guardado no store (as versões antigas não são apagadas enquanto houver execução viva nelas).
- **Os invariantes da Fase 11 (I1 a I8) valem para qualquer workflow.** O harness de caos ganha um gerador de definições pequenas e roda os mesmos cenários sobre elas, além da peça.
- **Migração da peça atual:** a peça vira a definição `play` 2.x, com os mesmos estados. Os snapshots da peça 1.x (a máquina escrita à mão) são lidos por um mapeamento fixo e testado. A máquina antiga fica no código por uma versão, só para retomar o que estava em curso.

### Troca de versão com a peça em curso (N295)

- A versão nova ativada vale para as execuções que nascem depois.
- A execução em curso fica na versão dela. O Produtor pode pedir a migração, que só acontece num ponto seguro (entre passos, sem efeito `pending`), com um mapeamento `estado antigo -> estado novo` declarado na versão nova e validado pelo compilador. Sem mapeamento, a migração é recusada com o motivo.

## 7. Biblioteca, cenários e ciclo de vida (N296)

- **Biblioteca global:** as definições instaladas (oficiais, do usuário e de pacotes), com as versões delas.
- **No cenário:** `workflows.default` e `workflows.allowed`. Cada peça escolhe um workflow da lista permitida, e o padrão é `default`. Para os cenários que já existem, o padrão é `play`.
- **Vínculo com ciclo de vida:** um cenário pode ter vínculos ativos com gatilho. Exemplo do dono: o projeto termina e o Produtor ativa o vínculo "issues do GitHub" no mesmo cenário.
  - **Prazo:** `until` é uma data, uma duração ou `none`. Ao vencer, o vínculo fica `expired` e gera um evento.
  - **Produtor:** pausar, retomar e parar, pelo chat, pela paleta e pela API.
  - **Orçamento por período:** ao chegar ao teto, o vínculo pausa e gera um evento, com aviso no chat.
  - **Concorrência:** quantas execuções do mesmo vínculo rodam ao mesmo tempo (`concurrency`, padrão 1), e o que fazer com o gatilho que chega com outra em curso (`queue`, `skip` ou `replace`).
- **Q4 continua aberta:** automação contínua numa assinatura (docs/13). O desenho deixa o caminho pronto, e a escolha entre conta de assinatura e chave de API para vínculos com gatilho segue a decisão da Q4, quando vier.

## 8. Gatilhos novos [proposta]

Os gatilhos da v1 (§5.20) continuam: manual, uma vez, cron, intervalo e depois do reset da cota. Entram:

- **Evento interno:** qualquer evento tipado do daemon, incluindo `plugin.<id>.*`. Casa com a regra de que situações viram eventos.
- **Do code host, por consulta periódica:** `code_host.issue_opened`, `code_host.issue_labeled`, `code_host.pr_opened` e `code_host.ci_failed`. São por consulta porque o daemon só escuta em 127.0.0.1 (Q16) e não recebe webhook. O webhook fica depois, por um túnel ou relé escolhido pelo usuário.
- **Filtros obrigatórios dos gatilhos do code host:** autores permitidos (`allowlist`, `collaborators` ou `any`), labels e o repositório do cenário.

## 9. Segurança (N294 e N298)

O texto de issue, PR e log de CI é escrito por terceiros e chega ao agente. É a mesma classe de risco do R17 (navegador) e do R18 (tarefa sem supervisão). O padrão é fechado:

- **Quem dispara:** `workflows.triggers.authors: allowlist` (padrão), `collaborators` ou `any`, e os labels exigidos pelo vínculo.
- **Aprovação humana** antes de push, de comentário público e de label: `workflows.security.require_approval: [push, comment, label]` (padrão), sem push e comentário (`none`), ou uma lista própria.
- **Orçamento:** por execução, por vínculo e por período, com `on_exhausted: pause` (padrão) ou `stop`.
- **Isolamento:** o texto externo vai ao prompt marcado como não confiável, e as cascas e permissões de hoje (Fase 4) valem iguais.
- **Pacotes:**
  - a instalação mostra as permissões pedidas pelo manifesto (gatilhos, ferramentas, papéis, efeitos e acesso de rede) e só segue com o ok do Produtor;
  - `workflows.packages.signature: verify_if_present` (padrão), `require` ou `off`;
  - a origem é um arquivo local ou um repositório git com ref fixa (commit), nunca um branch móvel;
  - uma atualização com permissão nova pede ok de novo.

## 10. API, CLI e editor (N297)

- **API do daemon:**
  - `validate` devolve os erros com o caminho do campo;
  - `simulate` roda a definição com o agente falso do P2 da Fase 11, sem cota e sem efeito externo, e devolve o caminho percorrido;
  - `save` cria uma versão nova (nunca sobrescreve);
  - `activate` e `deactivate`;
  - `diff` entre versões;
  - `list` e `get`;
  - `install_package` e `remove_package`.
- **CLI:** `ot flow validate|simulate|save|activate|diff|list|install|remove`.
- **TUI:** o editor do YAML tem validação ao vivo (o erro aparece na linha), diff da versão ativa, simulação com o caminho percorrido e ativação com confirmação. A lista de vínculos do cenário aparece com estado, prazo, orçamento gasto e as ações de pausar, retomar e parar.
- **Web (Fase 12):** o editor visual em grafo, sobre a mesma API.

## 11. Workflows prontos (N293)

1. **`play`:** a peça teatral migrada. Continua o padrão.
2. **`github-issues`:** o gatilho é uma issue nova com label e autor permitidos. Os passos são:
   - leitura;
   - triagem pelo Diretor (corrigir ou pedir informação);
   - aprovação;
   - a peça de correção;
   - PR com `Fixes #N`;
   - comentário na issue.
3. **`pr-review`:** o gatilho é um PR aberto por outra pessoa. O Crítico revisa e comenta, sem push. O comentário passa por aprovação no padrão.
4. **`ci-fix`:** o gatilho é a CI vermelha num PR do próprio usuário. O workflow lê o log, corrige e faz push na mesma branch, depois da aprovação no padrão. O limite de tentativas vem de `limits`.

Os três novos também servem de teste do motor: cada um tem uma simulação com o agente falso e um cenário de caos.

## 12. Dependências e o que muda

- **Porta do code host:**
  - hoje ela só tem métodos de branch e PR [V: `packages/core/src/ports/code-host.ts`];
  - os workflows de issues, revisão e CI precisam de métodos de issue, comentário, label e log de CI. Eles podem ir na mesma porta ou numa porta `IssueTracker` (escolha no plano);
  - a ligação em produção vem do P13 da Fase 11 (N289, `adapters.code_host`).
- **Agendador:** os gatilhos por consulta e os vínculos com prazo precisam de quem rode no tempo. O agendador da Fase 9b não está no código (N285). A ordem entre a 9b e esta fase vai para o plano.
- **Arquitetura:**
  - **§5.18, linha "Fluxos":** a fonte deixa de ser só "módulos oficiais". Os tipos de passo continuam só de módulos oficiais, e as definições também vêm do usuário e de pacotes.
  - **§5.20:** recebe os gatilhos novos e o vínculo entre cenário e workflow.
  - **§10:** ganha a Fase 11b.
  - **N243, a parte do P12 da Fase 9 (as etapas fixas do `flows.<id>`),** é revisada: o `flows.<id>` de hoje vira parâmetro da definição `play`, com o mesmo efeito, e a chave antiga continua aceita e é traduzida.
- **Chaves de config novas (todas com modos, padrão entre parênteses):**
  - `workflows.default` (`play`);
  - `workflows.allowed` (`all_installed` ou uma lista);
  - `workflows.running_on_change` (`pin`, `migrate_at_safe_point`);
  - `workflows.triggers.authors` (`allowlist`, `collaborators`, `any`);
  - `workflows.security.require_approval` (`[push, comment, label]`, `none` ou uma lista);
  - `workflows.budget.on_exhausted` (`pause`, `stop`);
  - `workflows.packages.signature` (`verify_if_present`, `require`, `off`);
  - `workflows.packages.sources` (`file`, `git`);
  - `workflows.binding.concurrency` (1);
  - `workflows.binding.on_busy` (`queue`, `skip`, `replace`).

## 13. Riscos

- **Trocar o núcleo mais testado:** a peça escrita à mão é o caminho que mais tem teste.
  - Mitigação: fazer só depois da Fase 11, com o caos verde.
  - Mitigação: a definição `play` 2.x tem de passar nos mesmos testes da máquina atual antes de virar padrão.
  - Mitigação: a máquina antiga fica por uma versão.
- **Expressividade demais:** se a linguagem de condição crescer até virar código, ela traz de volta o problema de rodar código de terceiros. Mitigação: a lista de operadores é fechada, e cada operador novo entra com teste, como as chaves de `rule`.
- **Gatilho externo como vetor de injeção de prompt:** mitigado pelo padrão fechado com aprovação (seção 9).
- **Gasto sem ninguém olhando:** mitigado pelo orçamento por vínculo e por período, pelo prazo e pela pausa automática (R13).

## 14. O que fica para o plano da fase

Estes pontos não foram decididos e vão ao dono por múltipla escolha quando o plano for escrito:

1. A v1 sai antes ou depois desta fase.
2. A ordem com a Fase 9b (agendador): antes, junto ou só o mínimo para os gatilhos por consulta.
3. Métodos de issue na porta `CodeHost` ou uma porta `IssueTracker` própria.
4. O formato e a chave de assinatura dos pacotes (por exemplo, SSHSIG como no `install.sh`, N288), e se há lista de chaves confiadas por usuário.
5. Como ficam os eventos de plugin como gatilho (só os de plugins instalados e ativos, ou também por padrão).
6. A divisão em passos e ondas, e o critério de aceite da fase.
