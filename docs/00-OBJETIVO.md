# 00. Objetivo

## Visão

Ter um sistema próprio que coordene vários agentes de IA como uma equipe: um **orquestrador barato e disciplinado** que decide, e **executores** que fazem o trabalho (código, testes, compilação, pesquisa, redação), cada um com o modelo e o esforço certos para o papel, em contas e projetos diferentes, com controle total de permissões, cotas e telemetria. O diferencial é **usar as assinaturas dos clientes oficiais** e não chaves de API.

## O fluxo que o sistema deve implementar (o "desenho")

O dono tem um diagrama (imagem anexada na conversa de 2026-11-08, não copiada para cá). Os papéis e o encadeamento, como descritos:

1. **Produtor**: entrega a demanda.
2. **Autor**, **Revisor** e **Roteirista**: transformam a demanda em plano e em roteiro de passos.
3. **Diretor + Atores**: o Diretor lança os Atores (executores). Cada Ator roda em **ambiente isolado com worktree própria**, com **MCPs** definidos e **timeout**.
4. **Crítico**: avalia o resultado.
5. **Limite de tentativas** e **roteamento por tipo de erro**: o tipo da falha decide para onde o trabalho volta (autor, roteirista, outro ator, escalonar).
6. **PR e merge**, e então **um novo ciclo**.

## Requisitos

| # | Requisito | Origem |
|---|---|---|
| R1 | **Sem chave de API.** Usar as assinaturas (Claude, ChatGPT, e planos de outros provedores) pelos clientes oficiais. "O diferencial precisa ser usar as assinaturas." | Pedido do dono |
| R2 | **Multi-conta, multi-agente e multi-projeto**, com vários orquestradores (um por projeto). | Pedido do dono |
| R3 | O **orquestrador não sai do papel**: não edita código, não roda testes, não compila. | Pedido do dono |
| R4 | O orquestrador roda em **modelo pequeno e barato** (por exemplo Haiku ou Luna) em esforço baixo ou médio, com contexto de 200 a 250 mil tokens. | Pedido do dono |
| R5 | Os executores são chamados com **modelo e esforço específicos por papel** e **rodam testes, compilam e rodam mutações sem problemas de permissão ou sandbox**. | Pedido do dono |
| R6 | **Controle total** de ferramentas, permissões, autenticação, assinaturas e cotas. | Pedido do dono |
| R7 | **Cliente fino** que encapsula Claude Code, Codex e OpenCode (OpenCode não aceita a assinatura do Claude; aceita login do ChatGPT segundo a documentação dele e outros provedores por chave ou plano). | Pedido do dono |
| R8 | **Interface própria**: dashboards, controle de projetos, plugins e **app de desktop** para Windows, macOS e Linux. Sem o Claude como "prompt de controle". | Pedido do dono |
| R9 | **Portabilidade entre Windows, macOS e Linux** para o app e para os agentes. Se o isolamento usa contêiner ou não é a decisão em comparação (Q1 em [13](13-DECISOES-EM-ABERTO.md)); o runner é trocável. | Pedido do dono |
| R10 | Agentes com **acesso à internet** e **tarefas gerais, recorrentes e agendadas** (exemplo: consultar vários portais de notícias em paralelo, compilar manchetes e enviar o resumo em HTML por e-mail). | Pedido do dono |
| R11 | **Telemetria completa** e **trajetórias em formato ATIF**, acompanháveis **em tempo real**. | Pedido do dono |
| R12 | **Relogin** controlado quando a assinatura precisar ser renovada, e uso do `claude setup-token` quando fizer sentido. | Pedido do dono |
| R13 | **Economia de cota**: ferramenta primeiro, modelo por último; modelo mais barato que cumpra a verificação. | Princípio já adotado pelo dono |
| R14 | **Resolver de uma vez os erros que aparecem hoje** (ver [01](01-CONTEXTO-E-PROBLEMAS.md)). | Pedido do dono |

## Fora de escopo (por enquanto)

- Usar chaves de API (pode existir como opção futura, mas não é o objetivo).
- Treinar ou ajustar modelos.
- Reescrever os clientes de agente (Claude Code, Codex, OpenCode): eles são encapsulados, não substituídos.
- Hospedar o sistema para terceiros (é uma ferramenta pessoal, local, do dono).

## Critérios de sucesso (propostos, a validar com o dono)

1. Uma demanda de código percorre o fluxo completo (plano, execução isolada, testes, mutações, crítico, PR) **sem que o orquestrador execute nenhuma ferramenta de código**. Isso é verificado pela lista de ferramentas do orquestrador (vazia ou restrita), não pela leitura do comportamento.
2. Um executor roda a suíte de testes e a compilação do projeto **sem falha de permissão ou sandbox** (zero `EPERM` causado pela ferramenta; ver o caso do D151 em [01](01-CONTEXTO-E-PROBLEMAS.md)).
3. Quando uma conta esgota a cota ou perde o login, o trabalho **passa a outra conta elegível** ou **pausa com aviso claro**, sem laço nem espera cega.
4. A trajetória de cada agente pode ser **vista ao vivo** e **exportada em ATIF** (versão a fixar; ver [11](11-TELEMETRIA-E-ATIF.md)).
5. Uma tarefa geral agendada (o exemplo das manchetes) roda sem supervisão, **sem que o agente que lê a web tenha a credencial de envio** do e-mail.
6. O mesmo núcleo atende **dois projetos ao mesmo tempo** sem misturar worktrees, contas ou estado.
7. Instala e roda em **Windows, macOS e Linux**.
8. Custo da orquestração: o consumo de cota do orquestrador por demanda é pequeno e **medido** (a meta numérica é uma decisão em aberto; ver [13](13-DECISOES-EM-ABERTO.md)).
