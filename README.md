# multi-agent-orchestration

**Status: fase de desenho. Não há código.** Criado em 2026-11-08 a partir de uma conversa de planejamento. A arquitetura definitiva **ainda não foi escolhida**: este repositório guarda tudo o que foi discutido para a decisão ser tomada com a informação completa.

## Em uma frase

Um sistema para coordenar vários agentes de IA (Claude Code, Codex, OpenCode e outros), em várias contas e vários projetos, **usando as assinaturas dos clientes oficiais e não chaves de API**, com um orquestrador barato que **não sai do papel**, agentes executores isolados que rodam testes e compilam sem problemas de permissão, controle de cota, telemetria completa, trajetórias em formato ATIF acompanhadas em tempo real, e também tarefas gerais, recorrentes e agendadas (por exemplo: resumir manchetes de vários portais e mandar por e-mail em HTML).

## Por que existe

Hoje o fluxo roda com o Claude Code como orquestrador e um kit de comandos (`okit`, repositório `orchestration-kit`) que lança executores em segundo plano. Funciona, mas o orquestrador é um agente de uso geral forçado a se comportar como orquestrador, os executores esbarram em sandbox e permissões, e as cotas das três assinaturas se esgotam sem um controle central. Detalhes em [docs/01-CONTEXTO-E-PROBLEMAS.md](docs/01-CONTEXTO-E-PROBLEMAS.md).

## As duas arquiteturas em comparação

As duas partem do **mesmo núcleo** (um cliente fino próprio que encapsula os CLIs oficiais, [docs/02](docs/02-NUCLEO-COMUM.md)) e **diferem só no runner**, ou seja, onde e como o agente executor e as verificações rodam:

| | **1. Com contêineres** | **2. Sem contêineres** |
|---|---|---|
| Ideia | Cada agente e suas verificações rodam num contêiner, com a worktree montada | Cada agente roda como processo nativo, numa worktree própria, com política do núcleo |
| Isolamento | Fronteira real do sistema | Política (ferramentas, caminhos, usuário dedicado opcional) |
| Sandbox do cliente (causa do `EPERM`) | Desligado com segurança | Ligado causa o erro; desligado não há fronteira |
| Windows e macOS | Só dentro de uma VM Linux | Nativo |
| Instalação | Exige runtime de contêiner | Baixar o app |
| Builds de outro sistema (`.dmg`, `.exe`) | Não cobre | Cobre |
| Agentes em paralelo | Sem colisões | Colisões possíveis |
| Esforço | Maior | Menor |

Detalhes e pesos: [docs/03](docs/03-ARQUITETURA-1-COM-CONTEINERES.md), [docs/04](docs/04-ARQUITETURA-2-SEM-CONTEINERES.md) e [docs/05](docs/05-COMPARACAO-E-CRITERIOS.md). Há um **caminho híbrido** (runner trocável, nativo por padrão, contêiner opcional) proposto em [docs/05](docs/05-COMPARACAO-E-CRITERIOS.md).

Fora desse eixo, duas outras escolhas ficaram registradas: **continuar com o Claude Code mais o `okit`**, sem núcleo próprio ([docs/06](docs/06-ALTERNATIVA-HARNESS-EXISTENTE.md)), e **partir de um agente open source** ([docs/12](docs/12-HARNESSES-OPEN-SOURCE-AVALIADOS.md), não recomendado).

## Índice

| Arquivo | Conteúdo |
|---|---|
| [docs/00-OBJETIVO.md](docs/00-OBJETIVO.md) | O que queremos atingir: requisitos, fora de escopo, critérios de sucesso propostos |
| [docs/01-CONTEXTO-E-PROBLEMAS.md](docs/01-CONTEXTO-E-PROBLEMAS.md) | Como é hoje e os erros observados que motivam o projeto |
| [docs/02-NUCLEO-COMUM.md](docs/02-NUCLEO-COMUM.md) | O núcleo comum às duas arquiteturas: módulos, interface do runner, orquestrador, contas, fases |
| [docs/03-ARQUITETURA-1-COM-CONTEINERES.md](docs/03-ARQUITETURA-1-COM-CONTEINERES.md) | Arquitetura 1: desenho do runner, prós, contras, quando escolher |
| [docs/04-ARQUITETURA-2-SEM-CONTEINERES.md](docs/04-ARQUITETURA-2-SEM-CONTEINERES.md) | Arquitetura 2: desenho do runner, prós, contras, quando escolher |
| [docs/05-COMPARACAO-E-CRITERIOS.md](docs/05-COMPARACAO-E-CRITERIOS.md) | Comparação lado a lado, perguntas que decidem, caminho híbrido, o que medir |
| [docs/06-ALTERNATIVA-HARNESS-EXISTENTE.md](docs/06-ALTERNATIVA-HARNESS-EXISTENTE.md) | Alternativa: continuar com o Claude Code como Diretor e o `okit` |
| [docs/07-ASSINATURAS-E-TERMOS.md](docs/07-ASSINATURAS-E-TERMOS.md) | O que cada provedor permite, o que está confirmado e o que não está |
| [docs/08-CLIENTES-CLI-REFERENCIA.md](docs/08-CLIENTES-CLI-REFERENCIA.md) | O que `claude`, `codex` e `opencode` oferecem (verificado localmente) |
| [docs/09-ISOLAMENTO-E-SEGURANCA.md](docs/09-ISOLAMENTO-E-SEGURANCA.md) | Isolamento nos dois cenários, internet, injeção de prompt, segredos |
| [docs/10-TAREFAS-GERAIS-E-AGENDAMENTO.md](docs/10-TAREFAS-GERAIS-E-AGENDAMENTO.md) | Tarefas recorrentes, fluxos paralelos, o exemplo das manchetes |
| [docs/11-TELEMETRIA-E-ATIF.md](docs/11-TELEMETRIA-E-ATIF.md) | Eventos, custo, cota e trajetórias ATIF em tempo real |
| [docs/12-HARNESSES-OPEN-SOURCE-AVALIADOS.md](docs/12-HARNESSES-OPEN-SOURCE-AVALIADOS.md) | Os agentes open source considerados como base e por que não servem de orquestrador |
| [docs/13-DECISOES-EM-ABERTO.md](docs/13-DECISOES-EM-ABERTO.md) | Perguntas a decidir, com a recomendação de cada uma |
| [docs/FONTES.md](docs/FONTES.md) | Links consultados (a maioria secundária) |

## Convenções deste repositório

- Os documentos estão em português do Brasil.
- Cada afirmação sobre termos de uso, versões ou formatos externos diz se foi **verificada localmente** (comando rodado nesta máquina), **vem de fonte secundária** ou **não foi confirmada**. Trate o que não está verificado como hipótese.
- Datas e horários seguem o fuso de São Paulo (UTC-3).
