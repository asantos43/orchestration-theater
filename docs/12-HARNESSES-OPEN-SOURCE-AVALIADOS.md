# 12. Harnesses open source avaliados como base

Pergunta do dono (2026-11-08): como não quer construir do zero, qual destes seria a melhor base? Lista colada por ele: **mini-SWE-agent, SWE-agent, Aider, OpenHands, Cline, OpenCode, Eigent e Mistral Vibe**.

## Conclusão da conversa

**Nenhum deles é uma base de orquestrador.** São **agentes executores** (ou ambientes de agente): cada um traz o próprio laço de agente, o que o dono não quer controlar de dentro, mas de fora. O que servem a este projeto:

- Como **executores** atrás de adaptadores (o OpenCode já é usado assim, pelo kit, com a MiniMax).
- Como **referência** de padrões (laço de agente, ferramentas, trajetórias, avaliação).

## Observações por item

Estas notas vêm da conversa e de conhecimento geral, **não de leitura dos repositórios agora**. Confirme antes de decidir.

| Agente | Papel provável neste projeto | Observação |
|---|---|---|
| **OpenCode** | Executor (já em uso) | Aceita login do ChatGPT segundo a documentação; não aceita assinatura do Claude (removeu o suporte); roda MiniMax e outros por chave ou plano |
| **mini-SWE-agent** | Executor leve ou referência | Laço de agente mínimo, pensado para benchmarks de engenharia de software |
| **SWE-agent** | Referência | Origem de ideias de interface agente-computador para tarefas de código |
| **OpenHands** | Executor ou referência de plataforma | Plataforma de agentes com ambiente de execução; a documentação dele trata de assinaturas de LLM (ver [FONTES](FONTES.md)) |
| **Aider** | Executor de edição de código | Foco em pair programming com git |
| **Cline** | Executor dentro de editor | Voltado ao uso em IDE |
| **Eigent** | Referência multiagente de desktop | Aplicativo de desktop multiagente |
| **Mistral Vibe** | Executor (CLI de outro provedor) | CLI do ecossistema Mistral |

## O que um agente existente não resolve

1. **Controle do papel do orquestrador**: todos têm o próprio laço e ferramentas.
2. **Multi-conta com cota e relogin** por assinatura.
3. **Plano de controle comum** com dashboards, multi-projeto, agendador e plugins.
4. **Isolamento e verificações** em runner próprio.
5. **ATIF em tempo real** a partir de um log de eventos próprio.

Por isso o núcleo ([02](02-NUCLEO-COMUM.md)), com o runner de contêiner ([03](03-ARQUITETURA-1-COM-CONTEINERES.md)) ou o nativo ([04](04-ARQUITETURA-2-SEM-CONTEINERES.md)), trata esses agentes como executores. Partir de um deles como base do núcleo ficou registrado em [05](05-COMPARACAO-E-CRITERIOS.md) como considerado e não recomendado.

## Se algum dia valer a pena um spike

O dono disse "ainda não" a um spike. Se vier a querer: instalar OpenCode, mini-SWE-agent e OpenHands, rodar a mesma tarefa pequena em cada um e comparar (1) como o laço pode ser controlado de fora, (2) formato dos eventos e das trajetórias, (3) suporte a assinaturas, (4) uso nos três sistemas operacionais.
