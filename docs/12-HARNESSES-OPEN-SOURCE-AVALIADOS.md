# 12. Projetos open source avaliados

O documento tem duas partes:
- os **agentes** que o dono listou em 2026-11-08, avaliados como base;
- os projetos que a arquitetura v0.10 (§6.3 a §6.5) avaliou em 2026-11-13 como **base de fork** ou como **referência**.

Nenhum repositório foi lido nesta revisão. As licenças e descrições vêm da arquitetura, ou da conversa de 2026-11-08, e devem ser confirmadas antes de decidir.

## Parte 1. Agentes listados pelo dono (2026-11-08)

Pergunta do dono: como não quer construir do zero, qual destes seria a melhor base? A lista: **mini-SWE-agent, SWE-agent, Aider, OpenHands, Cline, OpenCode, Eigent e Mistral Vibe**.

### Conclusão (mantida pela arquitetura)

**Nenhum deles é base de orquestrador.** São **agentes executores**, cada um com o próprio laço de agente, e o dono quer controlar o laço de fora. No OTheater, um agente entra como **Executor por ACP** (§5.2): basta ter um adaptador ACP.

| Agente | Papel no OTheater | Observação |
|---|---|---|
| **OpenCode** | Executor (`opencode acp`, nativo) | Usado hoje pelo kit com a MiniMax. Segundo fontes secundárias de 2026-11-08, aceita login do ChatGPT e não aceita a assinatura do Claude. A arquitetura o recomenda como harness para modelo local (Gemma 4), em vez do Claude Code (§5.7). |
| **mini-SWE-agent** | Referência | Laço de agente mínimo, pensado para benchmarks |
| **SWE-agent** | Referência | Ideias de interface agente-computador |
| **OpenHands** | Referência | Plataforma com ambiente de execução próprio |
| **Aider** | Possível Executor, se houver adaptador ACP **[não verificado]** | Pair programming com git |
| **Cline** | Fora do escopo | Voltado ao uso em IDE |
| **Eigent** | Referência | App de desktop multiagente |
| **Mistral Vibe** | Possível Executor, se houver adaptador ACP **[não verificado]** | CLI do ecossistema Mistral |

O Gemini CLI, que não estava na lista, entra como Executor opcional (`gemini --acp`).

### O que um agente existente não resolve

São os diferenciais do OTheater, que a arquitetura (§6.4) também diz que nenhum candidato a fork tem:
1. o **pipeline teatral** com papéis, Crítico e escalonamento;
2. a **seleção** por prioridade × cota com várias assinaturas;
3. as **permissões por papel**;
4. o **ATIF** a partir de um log de eventos próprio.

## Parte 2. Base de fork (arquitetura §6.4, decisão N1)

Candidatos, em ordem:

| # | Projeto | Licença | Por quê |
|---|---|---|---|
| 1 | **Emdash** (`generalaction/emdash`) | Apache-2.0 | Melhor encaixe: runtime ACP em TS, adaptadores claude/codex, agentes paralelos em worktrees |
| 2 | **Orca** (`stablyai/orca`) | MIT | Daemon + CLI, DAG de tarefas |
| 3 | **AionUi** | Apache-2.0 | Orquestração líder/equipe sobre ACP |
| 4 | **Paradev**, **Happier** | MIT | Sessões paralelas em worktrees; interface para vários agentes ACP |

Critérios da Fase 0:
1. licença do projeto e de todas as dependências que ele arrasta dentro da lista permitida, sem GPL, AGPL ou LGPL;
2. núcleo como daemon separado da UI;
3. aceitar a máquina de estados por cima;
4. qualidade de código e testes;
5. ritmo do upstream.

**Padrão até a avaliação:** projeto próprio, com trechos copiados com atribuição. O risco R8 é o fork divergir e a manutenção dobrar.

## Parte 3. Referências para copiar ou adaptar (arquitetura §6.3)

| Projeto | Licença | O que aproveitar |
|---|---|---|
| acpx | MIT | Cliente ACP headless com sessões persistentes e NDJSON |
| ccmanager | MIT | Gestão de worktrees, detecção de estado do agente |
| rivet-dev/agents | Apache-2.0 | Agentes de código atrás de uma API HTTP |
| Nimbalyst (sucessor do Crystal) | MIT **[a confirmar]** | Sessões paralelas |
| Vibe Kanban | Apache-2.0 (Rust) | Executores ACP e worktree por tarefa (só o desenho) |
| CodexBar | MIT (Swift) | Como obter a cota de cada provedor |
| Harbor | Apache-2.0 (Python) | Modelos do ATIF, a portar para zod |
| 1MCP | **[licença a confirmar]** | Agregação de MCPs com filtro por tags |
| AgentPrism | **[licença a confirmar]** | Visualizador de trajetórias |

## Parte 4. Avaliados e descartados (arquitetura §6.5)

| Projeto | Motivo |
|---|---|
| Claude Squad, coder/mux, Toad | AGPL |
| Mastra workflows | Partes com licença enterprise; dependência grande demais |
| Drizzle ORM | O Kysely já atende |
| DBOS TS, Absurd | Só Postgres |
| Temporal, Inngest, Restate | Servidor separado, desproporcional para um daemon local |
| Ruflo (ex-claude-flow) | App opinativo, não biblioteca |
| LangGraph.js | Não acrescenta nada sobre o XState para um fluxo determinístico |
| Vercel AI Elements | Será descontinuado no fim de novembro de 2026 |
| MetaMCP, Docker MCP Gateway | Pesados para embutir |
| coder/agentapi | Arquivado |
| Crystal | Descontinuado |

## Se valer a pena um spike

Em 2026-11-08, o dono disse "ainda não" a um spike com os agentes da Parte 1. A Fase 0 da arquitetura agora inclui a avaliação dos candidatos a fork da Parte 2 (N1). Rodar os agentes da Parte 1 só faria sentido para os que têm adaptador ACP.
