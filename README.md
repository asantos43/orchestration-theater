# OTheater (Orchestration Theater)

**Status: Fases 0 a 9 fechadas; Fase 10 (distribuição) em curso (2026-11-22).** A Fase 0 foi fechada com portões (2026-11-15, N48). O código descartável dos testes da Fase 0 fica em [spikes/](spikes/) (N33), e o veredito está no [relatório](spikes/RELATORIO-FASE-0.md); o código do produto começa na Fase 1. O repositório nasceu em 2026-11-08 de uma conversa de planejamento. Desde **2026-11-13**, a base de construção é a arquitetura do **OTheater**, em [docs/framework-ideas/arquitetura.md](docs/framework-ideas/arquitetura.md) (v0.50). Os demais documentos resumem essa arquitetura, guardam o contexto e o histórico, e registram o que ainda falta decidir.

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
Interfaces: TUI Ink (principal) · web, desktop e Android, celular e tablet (depois da v1, nessa ordem)
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
| [arquitetura.md](docs/framework-ideas/arquitetura.md) | **Documento-base de construção** (v0.94, 2026-11-24): princípios, componentes, modelo de dados, stack, estrutura do repositório, fases, riscos, decisões |
| [framework_multiagentes.md](docs/framework-ideas/framework_multiagentes.md) | O pipeline teatral, passo a passo |
| [framework_multiagentes_orquestrador_e_executores.md](docs/framework-ideas/framework_multiagentes_orquestrador_e_executores.md) | As entidades Executor e Orquestrador |
| [principais-papeis.md](docs/framework-ideas/principais-papeis.md) | Os papéis e suas responsabilidades |
| [proposta-de-fluxo-de-trabalho-adaptado.md](docs/framework-ideas/proposta-de-fluxo-de-trabalho-adaptado.md) | Proposta de fluxo adaptado |
| [fluxo-da-peca.md](docs/framework-ideas/fluxo-da-peca.md) | Diagrama do fluxo da peça em Mermaid (2026-11-14, arquitetura v0.31, §5.4) |
| [Diagrama do fluxo (PNG)](<docs/framework-ideas/Produtor-Roteirista Merge Workflow-2026-10-30-191336.png>) | Diagrama do dono, de 2026-10-30; substituído pelo fluxo-da-peca.md e mantido como registro |
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
| [14-PLANO-DA-FASE-3.md](docs/14-PLANO-DA-FASE-3.md) | Plano de passos da Fase 3, com dependências, paralelismo, aceite de cada passo e o marco 3a |
| [15-PLANO-DA-FASE-4.md](docs/15-PLANO-DA-FASE-4.md) | Plano de passos da Fase 4, com dependências, paralelismo, aceite de cada passo e o marco 4a |
| [16-PLANO-DA-FASE-5.md](docs/16-PLANO-DA-FASE-5.md) | Plano de passos da Fase 5 (assinaturas, cotas e seleção), com dependências, paralelismo, aceite de cada passo e o marco 5a [proposta] |
| [17-PLANO-DA-FASE-6.md](docs/17-PLANO-DA-FASE-6.md) | Plano de passos da Fase 6 (API do daemon e `packages/client`), com dependências, paralelismo e aceite de cada passo |
| [18-PLANO-DA-FASE-7.md](docs/18-PLANO-DA-FASE-7.md) | Plano de passos da Fase 7 (TUI), com dependências novas, paralelismo, aceite de cada passo e as decisões N185 a N192; o aceite (P21) passou no nível automático e no real, e a onda 6 de acertos (P22 a P27) está concluída; a fase só fecha com o roteiro dos terminais e o login oficial pelo dono (N209) |
| [19-PLANO-DA-FASE-8.md](docs/19-PLANO-DA-FASE-8.md) | Plano de passos da Fase 8 (observabilidade), com dependências candidatas, paralelismo, aceite de cada passo e as decisões N211 a N219 |
| [20-PLANO-DA-FASE-9.md](docs/20-PLANO-DA-FASE-9.md) | Plano de passos da Fase 9 (plugins e fluxos por configuração), com a dependência candidata, paralelismo, aceite de cada passo e as decisões N232 a N241 |
| [21-PLANO-DA-FASE-10.md](docs/21-PLANO-DA-FASE-10.md) | Plano de passos da Fase 10 (distribuição: executável único, instaladores, serviço de logon, atualização assinada e release com portão do R1), com a dependência, paralelismo, aceite de cada passo, o comando da chave Ed25519 e as perguntas N250 a N255 |
| [22-INSTALACAO.md](docs/22-INSTALACAO.md) | Guia de instalação (Windows `.msi`; macOS e Linux por `install.sh`), o que significam os avisos do SmartScreen e do Gatekeeper (com fonte e data), como conferir o SHA-256 e a assinatura à mão, atualizar (os modos de `updates.*`), desinstalar (os dados ficam), o que fazer se o `install.sh` recusar uma release, e as chaves de assinatura de código (desligadas, N247) |
| [23-PLANO-DA-FASE-11.md](docs/23-PLANO-DA-FASE-11.md) | Plano de passos da Fase 11 (endurecimento: testes de caos, idempotência de integração e PR, revisão de segurança e das portas, guia de adaptadores e plugins), com como simular cada falha sem nada real, os invariantes do aceite, as chaves de configuração propostas e as perguntas D1 a D9 |
| [24-DESENHO-DO-MOTOR-DE-WORKFLOWS.md](docs/24-DESENHO-DO-MOTOR-DE-WORKFLOWS.md) | Desenho da Fase 11b (depois da Fase 11): motor de workflows configuráveis em que a peça teatral é uma definição entre outras, com definições em YAML, vínculo por cenário com ciclo de vida, editor e API, pacotes e os workflows prontos de issues do GitHub, revisão de PR e conserto de CI (N291 a N298) |
| [25-GUIA-DE-ADAPTADORES-E-PLUGINS.md](docs/25-GUIA-DE-ADAPTADORES-E-PLUGINS.md) | Guia de quem escreve um adaptador (porta, regra de dependência, falso, suíte de conformidade, erros tipados, versão, montagem no `compose.ts`) ou um plugin (aponta para o `sdk/README.md`), com o exemplo que roda em [examples/adapter-clock](examples/adapter-clock) |
| [reference/phoenix.md](docs/reference/phoenix.md) | Receita do Arize Phoenix opcional (ELv2, só uso local): importar o ATIF exportado e, por um Collector, o OTLP; revisada contra a documentação pública em 2026-11-21, com [S], [V] e [N] |
| [FONTES.md](docs/FONTES.md) | Links consultados e grau de confirmação |
| [adr/](docs/adr/) | Registros das decisões de arquitetura (ADRs): 0001, projeto próprio sem fork (N1); 0002, TUI em Ink (N11) |

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
