# 01. Contexto e problemas observados

Fonte: o trabalho no `okit-plugin` (assistente de instalação, demandas D149 a D154) feito em novembro de 2026 com o fluxo atual. Os fatos abaixo vêm dessa sessão e dos arquivos de memória do dono.

## Como é hoje

- **O Diretor** é o Claude Code interativo. Ele planeja, escreve briefings, lê relatórios e decide. Não deveria executar nada.
- **O kit** (`okit`, repositório `orchestration-kit`, binário `orchestration-kit/bin/okit`) cobre: caixa de demandas (`inbox`), worktrees (`wt new`), briefings (`brief`), execução de executores em segundo plano (`run`, `wait`, `report`), mutações (`mutate`), aprovação (`approve`, com crítico), suíte isolada (`suite run --isolated`), PR e merge (`pr open`, `pr merge`), cotas (`quota`, `capacity`), ordens permanentes (`directives`) e outros.
- **Executores** (cada um numa assinatura diferente):
  - `cx`: Codex, assinatura ChatGPT.
  - `m3`: OpenCode com MiniMax, plano próprio.
  - agentes Claude em segundo plano, assinatura Anthropic.
- **Regras já adotadas pelo dono**: o Claude só orquestra e tudo que executa é delegado; merge só com o "pode mergear" explícito; verificadores não usam a cota do Codex; um executor só é lançado com cota acima de um limite (20 por cento), salvo ordem expressa; críticas podem ser dispensadas por uma ordem registrada e informada no PR.

## Problemas observados

| # | Problema | Evidência |
|---|---|---|
| P1 | **O orquestrador é um agente geral forçado ao papel.** Nada o impede tecnicamente de editar ou rodar comandos; o papel depende de instrução e disciplina. | Decisão do dono de buscar um harness onde o papel seja garantido |
| P2 | **Sandbox e permissões nos executores.** O sandbox do Codex bloqueia sockets e `spawnSync` (`listen EPERM`), gerando falhas falsas nos testes (3 testes de socket em `config-ui-install-jobs.test.js`). Os números de aceite tiveram que ser reproduzidos fora do sandbox com `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` e `OKWORK_HOME` temporários. | D150 e D151 |
| P3 | **Cotas esgotadas ao mesmo tempo, sem visão central.** Em 2026-11-08: ChatGPT com semana em 0 por cento (volta em cerca de 3 dias), MiniMax com `insufficient balance (1008)`, Anthropic com semana em 3 por cento (volta em cerca de 16 horas). O D151 parou por isso. A leitura de cota da MiniMax falhava no `kit quota`. | `kit quota` |
| P4 | **O portão de cota do cliente Codex não respeita `--force-launch`.** É preciso também `SKIP_QUOTA=1`. | Demanda D371 no kit |
| P5 | **Retomada de sessão cruzada entre clientes.** Depois de um limite de uso do ChatGPT, o retry automático lançou um agente Claude (opus) com o id de uma sessão do Codex e falhou com `No conversation found with session ID`. | D151, rodada 3 |
| P6 | **Laço sem progresso.** Uma rodada terminou com 3 tarefas pendentes sem avançar; foi preciso reescrever a rodada com arquivos gravados a cada passo. | D151, rodada 1 |
| P7 | **Um executor recusou o trabalho** porque o contrato anterior estava incompleto (planos nunca eram revisáveis). O Diretor precisou decidir consertar o contrato primeiro. | D151, rodada 0 |
| P8 | **Defeitos pequenos do kit** que exigem contorno: `kit mutate --copy` deixa pasta solta; falta exigir `--suite-ok` no commit pós-merge; o `approve` precisa de um laço de espera até aparecer "critic: waived by order". | Notas do dono |
| P9 | **Contexto longo do Diretor.** A sessão do orquestrador chega a precisar de compactação, e o histórico de decisões fica no resumo. | Esta própria sessão |
| P10 | **Sem interface própria**: o acompanhamento é por terminal e pelo painel do `claude-mods`. Não há dashboard de projetos, cotas e trajetórias. | Pedido do dono |

## O que funciona e deve ser preservado

- O fluxo em si (demanda, briefing, executor, relatório, mutação, aprovação, PR, merge).
- A disciplina de verificação: o relatório do executor nunca é aceito sozinho; os comandos de aceite são rodados à parte.
- A separação por papéis (`roles/critico.md`, `roles/executor.md`).
- A regra de mutação para provar que cada correção é coberta por teste.
- As ordens permanentes (`orders`) e a trilha de decisões.

A arquitetura do OTheater precisa **absorver** isso, não jogar fora. Correspondências na arquitetura v0.10:
- o relatório do executor corresponde à saída estruturada `submit`, validada por schema (§5.3);
- o crítico corresponde ao papel Crítico sobre a branch integrada (§5.4 e §5.5);
- os papéis correspondem aos prompts versionados em `prompts/` (§9);
- a trilha de decisões corresponde à tabela `decisions` e ao log de eventos (§7);
- as ordens permanentes correspondem às **ordens do Produtor**, globais ou locais a um cenário (§5.17, incluída na v0.11 em 2026-11-13).

A regra de mutação **não aparece explicitamente** na arquitetura. Ela precisa ser encaixada como critério de aceite das demandas, ferramenta do Crítico ou política do projeto (a decidir).

## Como a arquitetura responde a cada problema

Leitura feita em 2026-11-13 sobre [framework-ideas/arquitetura.md](framework-ideas/arquitetura.md) v0.10. É um mapeamento do desenho, não uma medição: as respostas só valem depois de verificadas na Fase 0 e nas fases seguintes.

| # | Resposta da arquitetura | Seção |
|---|---|---|
| P1 | O Diretor é uma sessão ACP que só enxerga as ferramentas MCP do papel (`next_action`, `decide`, `open_play`…). Quem abre Executores é o daemon. O fluxo é uma máquina de estados em código. | §5.3, §5.4 |
| P2 | Shell, testes, build e git passam pelas **cascas** do daemon (`run_tests`, `install_deps`, `git_commit`, `restricted_shell`), fora do sandbox do cliente. O isolamento real vem do sistema operacional (Job Object, `sandbox-runtime`). | §5.8, §5.9 |
| P3 | Sondas de cota por provedor (statusline do Claude, `account/rateLimits` do Codex, `token_plan/remains` da MiniMax, erro 429), estado por perfil e seleção por prioridade × disponibilidade. | §5.6, §5.7 |
| P4 | Não há portão de cota no cliente: a admissão é decidida pelo daemon, com regra explícita `next`/`wait` por papel. | §5.7, §5.9 |
| P5 | A retomada nativa (`session/load`) só acontece no mesmo cliente e perfil. A troca de cliente é uma **passagem de bastão** com pacote de continuação, nunca o id de sessão de outro cliente. | §5.16 |
| P6 | Critério de "agente travado" (minutos sem evento, repetição do mesmo erro), timeout com commit WIP e limites de tentativas em código. | §5.4, §5.5, §5.16 |
| P7 | O plano passa pelo Revisor antes do roteiro. O roteiro é validado em código (ciclos, contratos, arquivos), e cada demanda tem contrato explícito. | §5.4 |
| P8 | Os defeitos do kit não passam para o OTheater: ele é uma arquitetura nova e não reaproveita código do `okit`, só os conceitos (Q12, decidida em 2026-11-13). | [13](13-DECISOES-EM-ABERTO.md) |
| P9 | O estado fica no daemon (SQLite + blackboard). O Orquestrador consulta `next_action`/`status` e, em caso de failover, recebe um resumo gerado do store. | P4, §5.4, §5.10 |
| P10 | TUI como interface principal (chat, dashboard, trajetórias, agenda), com web e desktop opcionais sobre o `packages/client`. | §5.13, Fases 7, 12 e 13 |
