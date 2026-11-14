# 00. Objetivo

## Visão

Ter um sistema próprio, o **OTheater**, que coordene vários agentes de IA como uma equipe. A equipe tem duas partes:
- um **orquestrador barato e disciplinado**, que decide;
- **Executores**, que fazem o trabalho (código, testes, compilação, pesquisa, redação), cada um com o modelo e o esforço certos para o papel.

O sistema trabalha com contas e projetos diferentes e controla permissões, cotas e telemetria. O diferencial é **usar as assinaturas pelos clientes oficiais**. Chaves de API também são aceitas, e são o caminho para o modo produto enquanto o risco R1 estiver aberto (ver [07](07-ASSINATURAS-E-TERMOS.md)).

A arquitetura de construção está em [framework-ideas/arquitetura.md](framework-ideas/arquitetura.md) (v0.10, 2026-11-13). Os objetivos dela estão na §1.

## O fluxo que o sistema deve implementar (o "pipeline teatral")

O fluxo está descrito em [framework-ideas/framework_multiagentes.md](framework-ideas/framework_multiagentes.md) e no [diagrama do dono](<framework-ideas/Produtor-Roteirista Merge Workflow-2026-10-30-191336.png>), de 2026-10-30. A versão atual do fluxo, revista em 2026-11-14, está na §5.4 da arquitetura e em [framework-ideas/fluxo-da-peca.md](framework-ideas/fluxo-da-peca.md). Os papéis estão em [framework-ideas/principais-papeis.md](framework-ideas/principais-papeis.md). Em resumo:

1. **Produtor**: entrega a necessidade.
2. **Autor** e **Revisor**: transformam a necessidade num plano. O Revisor pode reprovar o plano até um limite `Np`.
3. **Roteirista**: transforma o plano num **roteiro**, que é um DAG de demandas com contratos entre elas. O roteiro é validado em código antes de executar.
4. **Diretor + Atores**: o Diretor (o Orquestrador) libera as demandas. Cada Ator roda numa **worktree própria**, com as ferramentas MCP do seu papel e **timeout**.
5. **Integração**: as demandas concluídas são mescladas numa branch de integração.
6. **Crítico**: avalia o trabalho **integrado**.
7. **Decisão e roteamento por tipo de falha**: falha de execução volta aos Atores; falha de roteiro, ao Roteirista; falha estrutural, ao Autor. Uma exceção crítica volta ao Produtor. Os limites são `Np` e `Nc`.
8. **Entrega por PR** (ou merge direto, se o projeto permitir) e então **um novo ciclo**.

A máquina de estados está na §5.4 da arquitetura.

## Requisitos

| # | Requisito | Origem | Como a arquitetura atende |
|---|---|---|---|
| R1 | **Assinaturas como diferencial.** Usar as assinaturas (Claude, ChatGPT, MiniMax e outras) **pelos clientes oficiais**, sem nunca tocar nos tokens. Chaves de API são aceitas como alternativa. *Até 2026-11-13 o requisito era "sem chave de API"; a arquitetura passou a aceitar as duas formas.* | Pedido do dono; ajustado pela arquitetura | §1 (item 3), §3, §5.6 |
| R2 | **Multi-conta, multi-agente e multi-projeto.** Cada cenário (projeto, tarefa ou chat) tem o seu Orquestrador. | Pedido do dono | §4, §5.6, §7 (`scenarios`, `profiles`) |
| R3 | O **orquestrador não sai do papel**: não edita código, não roda testes, não compila. | Pedido do dono | §5.3: o Diretor só tem as ferramentas MCP do papel e não abre Executores; quem os abre é o daemon |
| R4 | O orquestrador roda em **modelo pequeno e barato**, em esforço baixo ou médio. | Pedido do dono | §5.7: lista do papel (por exemplo Haiku ou Gemma 4 local); §5.10: Orquestrador sem memória própria |
| R5 | Os Executores usam **modelo e esforço específicos por papel** e **rodam testes, compilam e rodam mutações sem problemas de permissão ou sandbox**. | Pedido do dono | §5.2 (config options do ACP); §5.8: `run_tests` e `install_deps` são cascas executadas pelo daemon, não pelo sandbox do cliente |
| R6 | **Controle total** de ferramentas, permissões, autenticação, assinaturas e cotas. | Pedido do dono | §5.6, §5.7, §5.8 |
| R7 | **Cliente fino** que encapsula Claude Code, Codex e OpenCode. | Pedido do dono | §5.2: adaptadores ACP prontos + `ClientAdapter` fino |
| R8 | **Interface própria** para chat com o Orquestrador, dashboard, configuração, plugins e acompanhamento em tempo real, sem o Claude como "prompt de controle". *Até 2026-11-13 o pedido era um app de desktop. A arquitetura faz da **TUI** a interface principal; a web, o desktop e o app Android de celular e tablet (2026-11-14) vêm depois da v1 e da Fase 10b, nessa ordem; desde a v0.29, o desktop não é mais opcional.* | Pedido do dono; ajustado pela arquitetura | §5.13, Fases 7, 12, 13 e 14 |
| R9 | **Portabilidade**: Windows primeiro, sem impedir macOS e Linux. **Sem contêineres** (decisão Q1 em [13](13-DECISOES-EM-ABERTO.md)). | Pedido do dono | §3, portas e adaptadores `platform-*` (§5.18, §9), §5.8 |
| R10 | Agentes com **acesso à internet** e **tarefas agendadas e repetidas**. | Pedido do dono | §5.8 (`http_get` com domínios permitidos), §5.15 (agendador) |
| R11 | **Telemetria completa** e **trajetórias em ATIF**, acompanháveis **em tempo real**. | Pedido do dono | §5.11 |
| R12 | **Relogin controlado** quando a assinatura precisar ser renovada. | Pedido do dono | §5.6: login e logout oficiais no diretório de cada perfil; o perfil passa por `draining` antes de ser removido |
| R13 | **Economia de cota**: ferramenta primeiro, modelo por último; o modelo mais barato que cumpra a verificação. | Princípio já adotado pelo dono | P3, P8, §5.10; mensagens de andamento sem custo de modelo (§5.4) |
| R14 | **Resolver de uma vez os erros que aparecem hoje** (ver [01](01-CONTEXTO-E-PROBLEMAS.md)). | Pedido do dono | Tabela "Como a arquitetura responde" em [01](01-CONTEXTO-E-PROBLEMAS.md) |
| R15 | **Retomar sessões interrompidas** (cota, rede, queda, reinício, timeout, agente travado) sem perder trabalho nem repetir efeitos colaterais. | Arquitetura v0.10 | §5.16 |
| R16 | **Licenças permissivas ou MPL-2.0** no código copiado e nas dependências empacotadas; código próprio em **MPL-2.0**. | Arquitetura v0.3/v0.4; dono, 2026-11-14 (N23) | §6.0 |

## Fora de escopo (por enquanto)

- Treinar ou ajustar modelos.
- Reescrever os clientes de agente (Claude Code, Codex, OpenCode) ou os adaptadores ACP. Eles são reaproveitados, não substituídos (P1, P2).
- Contêineres como mecanismo de isolamento (Q1).
- Ler, copiar ou reaproveitar tokens OAuth de assinatura (§3).
- Distribuir para terceiros com assinatura Claude antes da confirmação da Anthropic (R1, decisão N2).

## Critérios de sucesso (propostos, a validar com o dono)

1. Uma demanda de código percorre o pipeline completo (plano, roteiro, execução isolada, integração, testes, crítico, PR) **sem que o Orquestrador execute nenhuma ferramenta de código**. A verificação é feita pelo conjunto de ferramentas MCP do papel Diretor (§5.3), não pela leitura do comportamento.
2. Um Executor roda a suíte de testes e a compilação do projeto **sem falha de permissão ou sandbox**: zero `EPERM` causado pela ferramenta (ver o caso do D151 em [01](01-CONTEXTO-E-PROBLEMAS.md)).
3. Quando uma conta esgota a cota ou perde o login, o trabalho **passa ao próximo Executor elegível** (`next`) ou **espera o reset com aviso** (`wait`), sem laço nem espera cega (§5.7, §5.16).
4. A trajetória de cada agente pode ser **vista ao vivo** e **exportada em ATIF-v1.8**, validada pelo `TrajectoryValidator` do Harbor (§5.11).
5. Uma tarefa agendada roda sem ninguém olhando, **entrega por PR** e, quando precisa de decisão do Produtor, espera um prazo e segue com a opção recomendada, que numa decisão irreversível é sempre a segura (§5.15, v0.26).
6. O mesmo daemon atende **dois projetos ao mesmo tempo** sem misturar worktrees, perfis ou estado.
7. Daemon e TUI instalam e rodam em **Windows**, **macOS** e **Linux**, com o Windows como primeira plataforma.
8. Custo da orquestração: o consumo de cota do Orquestrador por demanda é pequeno e **medido**. A meta numérica é uma decisão em aberto (Q14 em [13](13-DECISOES-EM-ABERTO.md)).
9. Uma sessão interrompida no meio do trabalho é retomada (nativa ou por passagem de bastão) **sem commits duplicados nem efeitos colaterais repetidos** (§5.16).
