# 01. Contexto e problemas observados

Fonte: o trabalho no `okit-plugin` (assistente de instalação, demandas D149 a D154) feito em novembro de 2026 com o fluxo atual. Os fatos abaixo vêm dessa sessão e dos arquivos de memória do dono.

## Como é hoje

- **O Diretor** é o Claude Code interativo. Ele planeja, escreve briefings, lê relatórios e decide. Não deveria executar nada.
- **O kit** (`okit`, repositório `orchestration-kit`, binário `orchestration-kit/bin/okit`) cobre: caixa de demandas (`inbox`), worktrees (`wt new`), briefings (`brief`), execução de executores em segundo plano (`run`, `wait`, `report`), mutações (`mutate`), aprovação (`approve`, com crítico), suíte isolada (`suite run --isolated`), PR e merge (`pr open`, `pr merge`), cotas (`quota`, `capacity`), ordens permanentes (`orders`) e outros.
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

Qualquer das duas arquiteturas precisa **absorver** isso, não jogar fora.
