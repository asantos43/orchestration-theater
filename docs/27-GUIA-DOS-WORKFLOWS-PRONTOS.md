# 27 — Guia dos workflows prontos (`github-issues`, `pr-review`, `ci-fix`)

> Para quem vai ligar um dos três workflows prontos a um projeto. O desenho está no [docs/24](24-DESENHO-DO-MOTOR-DE-WORKFLOWS.md) (seção 11, N293) e o passo, no [docs/26](26-PLANO-DA-FASE-11B.md) (P12). Este guia diz o que cada um faz hoje, o que precisa estar configurado e o que **ainda não** faz.
>
> Marcas: **[V]** verificado no código e nos testes em 2026-11-28; **[S]** fonte secundária; **[N]** não confirmado. Tudo o que é escolha do Claude e não decisão do dono vem como **[proposta]**.

## 1. O que são

Três definições YAML, em `packages/daemon/src/workflows/definitions/`:

| Id | Gatilho do arquivo | O que faz |
|---|---|---|
| `github-issues` | `code_host.issue_labeled` com o rótulo `otheater` | lê a issue, pede aprovação, abre uma peça para ela e comenta o resultado na issue |
| `pr-review` | `code_host.pr_opened` | lê o PR, pede aprovação, roda uma peça de revisão e comenta a revisão no PR |
| `ci-fix` | `code_host.ci_failed` | lê o log da CI que falhou, pede aprovação, roda uma peça que corrige e comenta o resultado no PR |

O daemon as instala na biblioteca a cada subida (`installReadyWorkflows`, origem `builtin`, versão `1.0.0`, ativa). A instalação é idempotente e **não liga nada**: sem um vínculo, nenhuma delas roda **[V: `ready-workflows.test.ts`]**. O texto instalado é o do `.yaml`, embutido em `ready-yaml.ts`; um teste confere que os dois são iguais.

## 2. O desenho comum

Os três têm a mesma forma, e ela é de propósito:

1. **Ler** o item (`fetch_issue`, `fetch_pr` ou `fetch_ci_log`, só leitura).
2. **Aprovar** (`approval`, com `timeout: 24h` e `on_timeout: stop`).
3. **Trabalhar** (`run_play`, a ponte para a peça de hoje; seção 4).
4. **Responder** (`comment`, com o texto que a peça deixou, por `body_from`).

A aprovação vem **antes** do trabalho, e não só antes do comentário, porque a peça empurra a branch e abre o PR sozinha (pela chave `delivery.mode`). Uma aprovação só depois do trabalho exigiria um modo de a peça parar antes do push, que é o P10c. Por isso o `run_play` conta como escrita pública `push` **[V]**.

O validador do motor recusa a definição que tem um `run_play`, um `comment` ou um `label` sem uma `approval` antes dele, quando a escrita está em `workflows.security.require_approval`. O passo confere de novo na hora de rodar (`guardPublicWrite`): sem aprovação, a escrita não acontece, o passo termina com `approval_required` e o protocolo ganha `workflow.write.refused` **[V: testes de `run-play.test.ts` e do e2e]**.

## 3. O que precisa estar configurado

| Chave | Para quê | Padrão |
|---|---|---|
| `workflows.triggers.authors` | quem pode disparar uma execução por uma issue ou um PR: `allowlist`, `collaborators` ou `any` | `allowlist` |
| `workflows.triggers.authors_list` | os logins da `allowlist` | vazia: **ninguém** |
| `workflows.triggers.poll.mode` e `poll.interval` | o olhar no code host (`loop` ou `off`; a cada 5 minutos) | `loop`, `5m` |
| `workflows.security.require_approval` | as escritas públicas que pedem aprovação antes (`push`, `comment`, `label`, uma lista ou `none`) | as três |
| `workflows.security.untrusted_text` | como o texto de fora é marcado (`mark_and_truncate` ou `mark`) | `mark_and_truncate` |
| `workflows.allowed` | quais workflows podem ser ligados | `all_installed` |

Dois pontos que pegam quem chega agora:

- **Com a lista de autores vazia, nada dispara.** É o padrão seguro: uma issue de alguém de fora da lista não inicia execução, e o protocolo registra `workflow.trigger.skipped` com o motivo `author` (uma vez, e para sempre para aquele item) **[V: e2e dos três]**.
- **Um vínculo tem a sua própria lista de gatilhos**; ele não herda a da definição **[V: `bindings.ts`]**. Quem liga o workflow (o Produtor, pela CLI do P10b) copia os `triggers` da definição ou escreve os seus. Os testes e2e fazem a cópia.

Um gatilho só olha o que nasceu **depois** do vínculo (o relógio do vínculo é o corte) e só uma vez por item (o livro de marcas de `workflow-triggers.json`) **[V: `triggers/`]**.

## 4. `run_play`: a ponte para a peça de hoje

Uma `run_play` abre uma peça pelo executor atual (`PlayRunner`) e espera por um estado final. A troca da máquina `playMachine` pela definição `play.yaml` é o P10c; até lá, esta ponte é a única maneira de um workflow genérico usar a peça. A forma abaixo é **[proposta]**; a decisão do dono (2026-11-28) fixa só a ponte.

**Parâmetros**

| Parâmetro | Valor |
|---|---|
| `from` | `issue`, `pr` ou `ci_log`: de onde sai a demanda da peça |
| `number` | o número do item; sem ele, vale a entrada `issue` ou `pr` da execução |
| `instructions` | o que pedir à peça; cada `from` tem um texto padrão |
| `timeout` | quanto esperar (duração); sem ele, espera sem prazo |

**Saída** (também gravada no blackboard da execução, na chave `run_play:<nó>`): `ended` (`done` ou `cancelled`), `delivered` (verdadeiro quando a peça terminou `DONE`; `pr_number` e `pr_url` vêm vazios se ela só deixou a branch), `branch`, `pr_number`, `pr_url`, `summary`, `play_id`.

**Como se comporta**

- **Dado, não ordem.** O título e o corpo da issue ou do PR e o log da CI entram na demanda marcados como texto de fora (`<untrusted-text ...>`), com um aviso de que é dado a ler e não instrução a seguir **[V]**. Isto reduz o risco de injeção, mas não o elimina: a peça ainda lê esse texto **[N: nenhuma medição contra um modelo real]**.
- **Sem peça repetida.** O id da peça deriva da chave da visita (`<execução>:<nó>:<ordem>`). Depois de um reinício, o passo acha a peça que já existe e só espera por ela **[V]**.
- **Prazo.** Estourar o `timeout` termina o passo com `play_timeout` e **deixa a peça rodando**: ela é do Produtor, no chat. Cancelar a execução também não cancela a peça **[V]**.
- **Recusas.** A orquestração pode recusar (por exemplo `no_repository`, o cenário sem repositório): o passo termina `play_refused` com o código.
- **Peça cancelada.** Termina `done` com `delivered` falso, e o `comment` não roda (a aresta `work -> done`).

## 5. Os três, um a um

### `github-issues`

`issue_labeled` (rótulo `otheater`) leva a `read -> ask -> work -> reply`. Se a issue já não está aberta, termina sem perguntar. Com a aprovação negada, a execução é cancelada, sem peça e sem comentário. A peça recebe o título e o corpo da issue e a instrução de entregar um PR que a fecha. O comentário na issue traz o resumo da peça (a branch e o PR).

### `pr-review`

`pr_opened` leva a `read -> ask -> review -> post`. Não existe peça só com o Crítico; por isso a revisão é uma peça inteira, com a instrução de revisar sem mudar código e sem abrir PR. O que ela deixa vira o comentário no PR. A peça de revisão **pode** empurrar uma branch dela, como qualquer peça; a aprovação vem antes por isso.

### `ci-fix`

`ci_failed` leva a `log -> ask -> fix -> reply`. Se a CI do PR já está verde, termina. A peça lê o log (como dado) e entrega uma branch e **um PR novo**; ela **não** empurra para a branch do PR que falhou. Não há laço de tentativas na definição: o livro de marcas do gatilho dispara no máximo uma execução por cabeça de PR que falhou, e o orçamento do vínculo limita o gasto.

## 6. Como foi testado (sem nada real)

- `ready-workflows.test.ts`: o texto embutido é o do `.yaml`; o validador do motor não dá erro nem aviso; sem a `approval` a definição é recusada; os gatilhos; a instalação na biblioteca.
- `steps/play/run-play.test.ts` e `run-play-port.test.ts`: a ponte e o adaptador sobre a orquestração (falsos).
- `ready-workflows.e2e.test.ts`: o motor montado como o daemon o monta (`composeWorkflows`), com o code host, o rastreador de issues e a lista de PRs falsos, a pergunta ao Produtor falsa, a peça falsa e o relógio falso. Para cada workflow: depois de `pass()`, a execução pergunta e **nada** é escrito (nenhuma peça, nenhum comentário); com `Allow`, a peça abre, termina e o comentário sai; com `Deny`, nada sai; um autor de fora da lista não inicia nada e gera `workflow.trigger.skipped`. Um teste à parte prova que um `label` só sai depois da aprovação.
- Não foi feita rodada real com o Claude Code, o Codex ou o OpenCode: a peça é falsa nos testes. **[N]** O comportamento com um modelo real, e com o GitHub de verdade, fica para o roteiro do dono.

## 7. Operar pela CLI: `ot flow` (P10b)

O `ot flow` fala com o daemon pela API local (as mesmas rotas `/api/workflows/...`, catalogadas em `docs/reference/api-routes.json`). Sem daemon, ele diz que não há daemon e sai com 1. `--json` imprime a resposta crua. Ativar ou desativar **não reinicia o daemon**.

| Comando | O que faz |
|---|---|
| `ot flow validate <arquivo.yaml>` | Valida a definição (esquema, referências, gatilhos) sem gravar. Sai com 1 se houver erro. |
| `ot flow simulate <arquivo \| id[@versão]> [--scenario ID] [--state JSON] [--input JSON] [--outputs JSON] [--fail NÓ]...` | Passeia pelo grafo **sem executar nada** (nenhum Executor, nenhum efeito) e lista cada passo e o que ele faria. Para em `workflows.simulate.max_steps`. |
| `ot flow save <arquivo.yaml> [--activate]` | Grava uma versão na biblioteca (imutável; o mesmo conteúdo com o mesmo número é aceito, outro conteúdo é conflito). |
| `ot flow activate <id> <versão>` ou `<id>@<versão>` | Torna a versão a ativa. O que acontece com as execuções em andamento depende de `workflows.running_on_change` (`pin` ou `migrate_at_safe_point`) e a resposta diz qual. |
| `ot flow deactivate <id> <versão>` | A versão sai de ativa; o workflow fica **sem versão ativa** até outra ser ativada. Serve para um pacote com versão ativa poder sair. |
| `ot flow diff <id> <de> <para>` | Compara duas versões (nós, arestas, gatilhos, parâmetros). |
| `ot flow list <workflows \| bindings \| runs \| packages> [--workflow ID] [--scenario ID] [--state ESTADO]` | Lista, seguindo a paginação. |
| `ot flow install <origem> [--approve HASH]` | Instalação em duas chamadas: a primeira só mostra o pacote (assinatura, permissões, o que muda) e o hash; a segunda, com `--approve <hash>`, instala. Se o pacote mudou entre as duas, a resposta é conflito. |
| `ot flow bind <cenário> <workflow> [--range 1.x] [--params JSON] [--triggers JSON] [--budget N --period day\|week\|month] [--concurrency N] [--on-busy queue\|skip\|replace] [--until 7d]` | Liga o workflow a um cenário. Sem `--triggers`, o daemon copia os gatilhos da definição; `--triggers '[]'` não liga nenhum (`--triggers` é uma lista JSON de objetos). |
| `ot flow pause <ligação>` / `resume <ligação>` / `stop <ligação>` | Pausa, retoma ou encerra a ligação. |

Códigos de saída: 0 em sucesso (uma simulação truncada também é 0, com o aviso), 1 em recusa ou erro (definição inválida, daemon recusou, instalação recusada), 2 em uso errado.

A ajuda completa, com todas as opções, sai de `ot help flow`.

## 8. O que ainda não existe

- **Ligar pela CLI e pela API** passou a existir no P10b (seção 7). Falta a tela da TUI (P11).
- **A triagem pelo Diretor** do `github-issues` (docs/24, seção 11, item 2): o `ask_director` existe (P15), mas a definição pronta não o usa; a decisão de corrigir ou pedir informação fica com o Produtor, na aprovação. **[proposta]**
- **PR com `Fixes #N`:** quem monta o texto do PR é a entrega da peça, que ainda não sabe da issue.
- **`ci-fix` na mesma branch** e **`pr-review` só com o Crítico:** pedem a troca da máquina e um modo de a peça parar antes do push (P10c).
- **Uma aprovação depois do trabalho** e **as saídas de um nó visíveis nos nós seguintes** (a interpolação substituiria o `body_from`): ficam para o P10b e o P10c.
