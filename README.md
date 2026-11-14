# OTheater (Orchestration Theater)

**Status: fase de desenho. Não há código.** O repositório nasceu em 2026-11-08 de uma conversa de planejamento. Desde **2026-11-13**, a base de construção é a arquitetura do **OTheater**, em [docs/framework-ideas/arquitetura.md](docs/framework-ideas/arquitetura.md) (v0.19). Os demais documentos resumem essa arquitetura, guardam o contexto e o histórico, e registram o que ainda falta decidir.

## Em uma frase

O OTheater é um sistema de agentes de código que encena a orquestração como teatro. Ele executa o pipeline Produtor → Autor → Revisor → Roteirista → Diretor/Atores → Crítico → decisão de forma **consistente e determinística**. Os Executores são os **CLIs oficiais** (Claude Code, Codex, OpenCode e, opcionalmente, Gemini CLI), acionados por **ACP**. O sistema aceita **assinaturas (token plan) e chaves de API**, com várias contas por cliente. Cobre ainda:
- seleção de Executor por cota;
- permissões por papel em três camadas;
- telemetria (OTel) e trajetórias em ATIF;
- agendador;
- TUI como interface principal.

## Por que existe

Hoje o fluxo roda com o Claude Code como orquestrador e o kit `okit` (repositório `orchestration-kit`), que lança executores em segundo plano. Isso funciona, mas tem três problemas:
- o orquestrador é um agente de uso geral forçado ao papel;
- os executores esbarram em sandbox e permissões;
- as cotas das assinaturas se esgotam sem controle central.

Detalhes em [docs/01-CONTEXTO-E-PROBLEMAS.md](docs/01-CONTEXTO-E-PROBLEMAS.md).

## A arquitetura em resumo

```
Interfaces: TUI Ink (principal) · web e Android, celular e tablet (depois da v1) · desktop (opcional)
        │ REST + WebSocket (chat) · SSE (eventos)
        ▼
Daemon (Node 24 + TypeScript)
  api · pipeline (XState) · selection · accounts (cofre, cotas) · executors (cliente ACP, pools)
  mcp (ferramentas do framework, filtro por papel) · plugins · tools (cascas) · resources (Job Object)
  workspace (git worktree + gh) · scheduler · store (SQLite WAL) · telemetry (OTLP, ATIF)
        │ ACP
        ▼
Orquestrador (Diretor) e Executores: claude-agent-acp · codex-acp · opencode acp · gemini --acp
```

- **Fluxo em código, julgamento no modelo.** A peça é uma máquina de estados. O Diretor decide só em pontos estreitos, com saída validada por schema.
- **Estado fora do modelo.** Tudo persiste no daemon. O Orquestrador consulta `next_action` e sobrevive a compactação de contexto e a reinícios.
- **Sem contêineres.** Cada Executor é um processo nativo numa worktree própria. As permissões ficam em três camadas: configuração do cliente, ACP e sistema operacional.
- **Windows primeiro**, sem impedir macOS e Linux.

O resumo por componente está em [docs/02-NUCLEO-COMUM.md](docs/02-NUCLEO-COMUM.md). O detalhe completo está na própria [arquitetura](docs/framework-ideas/arquitetura.md).

## Índice

**Documentos-base** (em [docs/framework-ideas/](docs/framework-ideas/)):

| Arquivo | Conteúdo |
|---|---|
| [arquitetura.md](docs/framework-ideas/arquitetura.md) | **Documento-base de construção** (v0.25): princípios, componentes, modelo de dados, stack, estrutura do repositório, fases, riscos, decisões |
| [framework_multiagentes.md](docs/framework-ideas/framework_multiagentes.md) | O pipeline teatral, passo a passo |
| [framework_multiagentes_orquestrador_e_executores.md](docs/framework-ideas/framework_multiagentes_orquestrador_e_executores.md) | As entidades Executor e Orquestrador |
| [principais-papeis.md](docs/framework-ideas/principais-papeis.md) | Os papéis e suas responsabilidades |
| [proposta-de-fluxo-de-trabalho-adaptado.md](docs/framework-ideas/proposta-de-fluxo-de-trabalho-adaptado.md) | Proposta de fluxo adaptado |
| [Diagrama do fluxo (PNG)](<docs/framework-ideas/Produtor-Roteirista Merge Workflow-2026-10-30-191336.png>) | Diagrama do dono, de 2026-10-30 |
| [mockup/tui.html](docs/framework-ideas/mockup/tui.html), [mockup/app.html](docs/framework-ideas/mockup/app.html), [mockup/mobile.html](docs/framework-ideas/mockup/mobile.html) | Mockups da TUI, do app (web e desktop) e do Android (celular e tablet) |

**Documentos de apoio** (em [docs/](docs/)):

| Arquivo | Conteúdo |
|---|---|
| [00-OBJETIVO.md](docs/00-OBJETIVO.md) | Visão, requisitos, fora de escopo e critérios de sucesso, ligados às seções da arquitetura |
| [01-CONTEXTO-E-PROBLEMAS.md](docs/01-CONTEXTO-E-PROBLEMAS.md) | Como é hoje, os erros observados e como a arquitetura responde a cada um |
| [02-NUCLEO-COMUM.md](docs/02-NUCLEO-COMUM.md) | Resumo do núcleo do OTheater (daemon, Executores, pipeline, contas, fases) |
| [07-ASSINATURAS-E-TERMOS.md](docs/07-ASSINATURAS-E-TERMOS.md) | Termos de uso por provedor, premissas da arquitetura e o risco R1 |
| [08-CLIENTES-CLI-REFERENCIA.md](docs/08-CLIENTES-CLI-REFERENCIA.md) | Adaptadores ACP, isolamento de perfil, sondas de cota e o modo headless (verificado localmente em 2026-11-08) |
| [09-ISOLAMENTO-E-SEGURANCA.md](docs/09-ISOLAMENTO-E-SEGURANCA.md) | Permissões em três camadas, cascas, internet, segredos, API local |
| [10-TAREFAS-GERAIS-E-AGENDAMENTO.md](docs/10-TAREFAS-GERAIS-E-AGENDAMENTO.md) | O agendador (arquitetura §5.15) e as tarefas gerais, como o exemplo das manchetes |
| [11-TELEMETRIA-E-ATIF.md](docs/11-TELEMETRIA-E-ATIF.md) | Log de eventos, OTel nativo dos clientes, ATIF-v1.8 |
| [12-HARNESSES-OPEN-SOURCE-AVALIADOS.md](docs/12-HARNESSES-OPEN-SOURCE-AVALIADOS.md) | Agentes open source como Executores e projetos candidatos a base de fork |
| [13-DECISOES-EM-ABERTO.md](docs/13-DECISOES-EM-ABERTO.md) | Estado de cada decisão, com data e motivo |
| [FONTES.md](docs/FONTES.md) | Links consultados e grau de confirmação |

Os números 03 a 06 estão vagos: esses documentos (comparação com e sem contêineres, alternativa Claude Code + `okit`) foram apagados em 2026-11-13. A última versão deles está no commit `cb05e35`.

## Nomes

- **Produto:** OTheater (*Orchestration Theater*), grafia americana.
- **Pacote npm:** `otheater`, com escopo `@otheater/*`.
- **Comando:** `ot` ou `otheater`.
- **Organização no GitHub:** `orchestration-theater`.

Os nomes foram conferidos em 2026-11-13, segundo a arquitetura §9; repetir a conferência antes de publicar. O código próprio será **MPL-2.0** (decidido em 2026-11-14, no lugar da MIT), e o código de terceiros fica restrito a licenças permissivas e à MPL-2.0 (arquitetura §6.0).

## Convenções deste repositório

- Os documentos estão em português do Brasil.
- Cada afirmação sobre termos de uso, versões ou formatos externos diz de onde veio: **verificada localmente** (comando rodado nesta máquina), **fonte secundária**, ou **não confirmada** (na arquitetura, **[a confirmar]**). Trate o que não está verificado como hipótese.
- Datas e horários seguem o fuso de São Paulo (UTC-3).
- Quando os documentos de apoio divergirem da arquitetura, vale a arquitetura. Corrija o documento de apoio.
