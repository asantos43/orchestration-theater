# 02. Núcleo do OTheater (resumo da arquitetura)

Este documento resume o núcleo descrito em [framework-ideas/arquitetura.md](framework-ideas/arquitetura.md) (v0.11, 2026-11-13). Em caso de dúvida ou divergência, vale a arquitetura.

> **Histórico.** Até 2026-11-13, este arquivo descrevia um "núcleo comum" às arquiteturas com e sem contêineres. Nesse desenho, o orquestrador era uma chamada só de decisão (`claude -p` ou `codex exec`, sem ferramentas), e os executores rodavam atrás de uma interface de runner trocável. A arquitetura v0.10 substituiu esse desenho por três peças: um daemon nativo, Executores por **ACP** e um Orquestrador que é uma sessão ACP com ferramentas MCP do framework. A versão anterior está no histórico do git (commit `35c5977`).

## Entidades

| Termo | Significado |
|---|---|
| **Executor** | Cliente + perfil (assinatura ou chave de API) + modelo + esforço |
| **Orquestrador (Diretor)** | Uma sessão ACP como qualquer outra, mas que só recebe as ferramentas MCP do papel Diretor |
| **Perfil** | Uma assinatura ou chave de API de um cliente, com diretório isolado |
| **Cenário** | Projeto, tarefa ou chat. Tem chat, Orquestrador, dashboard e configuração |
| **Peça** | Uma execução do pipeline para uma necessidade |
| **Demanda** | Unidade de trabalho do roteiro, executada por um Ator |
| **Tentativa** | Uma execução de uma demanda por um Executor, numa worktree própria |
| **Blackboard** | Memória compartilhada da peça: plano, roteiro, contratos e decisões |
| **Ordem** | Instrução do Produtor que vale além de uma peça: global (todos os cenários) ou local (um cenário), durante a sua vigência e até ser revogada |
| **Casca** | Ferramenta do framework que envolve uma ferramenta existente com política e telemetria |

O glossário completo está na arquitetura §13.

## Princípios (arquitetura §2)

P1 reutilizar os CLIs oficiais · P2 reutilizar bibliotecas · P3 fluxo em código, julgamento no modelo · P4 estado fora do modelo · P5 bloquear tudo, liberar o necessário · P6 tudo é evento · P7 daemon separado da interface · P8 contexto mínimo por Executor · P9 controle de admissão · P10 versões fixadas · P11 só licenças permissivas.

## Módulos do daemon (arquitetura §4 e §5)

| Módulo | Função | Base |
|---|---|---|
| `api/` | REST, SSE, WebSocket e autenticação | Hono |
| `pipeline/` | Máquina de estados da peça e DAG de demandas | XState v5, com snapshot no SQLite |
| `selection/` | Escolha do Executor por prioridade × disponibilidade | próprio |
| `accounts/` | Perfis, cofre, sondas de cota | `@napi-rs/keyring` |
| `executors/` | Cliente ACP, pools por (cliente, perfil), adaptadores | `@agentclientprotocol/sdk` v2 |
| `mcp/` | Servidor MCP do framework, com filtro por papel numa fábrica por requisição | MCP SDK v2 |
| `plugins/` | Agregador dos servidores MCP de plugins | próprio, sobre o SDK |
| `tools/` | Cascas: `run_tests`, `git_*`, `http_get`, shell restrito | próprio |
| `resources/` | Semáforos e lançador com Job Object | lançador Rust (`win32job`) |
| `workspace/` | Worktrees, branches, integração, PR | `git` + `gh` |
| `orders/` | Ordens globais e locais; aplicação das ordens do tipo `regra` | próprio |
| `scheduler/` | Agenda, gatilhos do sistema operacional | croner |
| `store/` | SQLite (WAL): eventos, estado, blackboard | `better-sqlite3` + Kysely |
| `telemetry/` | Receptor OTLP, spans, exportador ATIF | OpenTelemetry JS |

O daemon é **um por usuário/máquina** (lock de arquivo sobre o store). Ele sobrevive ao fechamento da UI. Ao reiniciar, reidrata as peças e devolve à fila as demandas interrompidas, preservando o que já foi commitado (§5.1).

## Executores (arquitetura §5.2)

- Os adaptadores ACP vêm prontos e não são escritos por nós:
  - `@agentclientprotocol/claude-agent-acp`;
  - `@agentclientprotocol/codex-acp`;
  - `opencode acp`;
  - `gemini --acp` (opcional).
- Modelo, esforço e modo são definidos pelas **Session Config Options** do ACP (`session/set_config_option`).
- Uma interface fina, `ClientAdapter`, cobre o que o ACP não cobre: o comando do adaptador, o ambiente do perfil, `prepareProfile` (permissões, statusline, OTel), login, logout, a sonda de cota e o `processModel`.
- Pools por `(cliente, perfil)`. No Claude Code, cada sessão sobe um processo `claude`, então a admissão conta sessões.
- Saída de emergência pelo modo headless: `claude -p --output-format stream-json`, `codex exec --json`.

Referência dos clientes e do que foi verificado localmente: [08](08-CLIENTES-CLI-REFERENCIA.md).

## Orquestrador e ferramentas MCP (arquitetura §5.3 e §5.4)

- O Orquestrador **não abre Executores**: ele chama ferramentas MCP do framework, e o daemon abre as sessões.
- Conjuntos de ferramentas por papel:

| Papel | Ferramentas |
|---|---|
| Diretor | `proxima_acao`, `status`, `decidir`, `abrir_peca`, `pausar`, `retomar`, `cancelar_ator`, `perguntar_produtor`, `abrir_pr`, `agendar`, `listar_agenda`, `pausar_agenda`, `listar_ordens`, `propor_ordem`, `prorrogar_ordem`, `revogar_ordem` |
| Todos | `ler_blackboard`, `ler_contrato`, `ler_decisao`, `entregar` |
| Autor / Revisor / Roteirista | `entregar_plano`, `entregar_parecer_plano`, `entregar_roteiro` |
| Ator | `run_tests`, `install_deps`, `git_commit`, `shell_restrito`, `http_get` + plugins do papel |
| Crítico | `run_tests`, `ver_diff`, `entregar_critica` |

- `entregar*` é a única forma de um Executor terminar. A saída é validada com zod e devolvida com o erro até `N` vezes.
- O modelo do Diretor decide só em **três pontos de julgamento**:
  1. classificar a crítica negativa;
  2. decidir o destino do trabalho parcial de um Ator que estourou o tempo;
  3. decidir quando e o que perguntar ao Produtor.
- Há uma **fila única de prompts** do Orquestrador, com prioridade para o Produtor, e **failover** para o próximo Executor do papel com um resumo gerado do store.

## Pipeline (arquitetura §5.4)

```
NECESSIDADE → PLANEJANDO → REVISANDO_PLANO → ROTEIRIZANDO → EXECUTANDO
  → INTEGRANDO_TESTE → CRITICANDO → DECIDINDO
      ├─ aprovado            → ENTREGANDO → CONCLUIDA
      ├─ falha de execução   → EXECUTANDO (só as demandas afetadas)
      ├─ falha de roteiro    → ROTEIRIZANDO → REVISANDO_ROTEIRO → EXECUTANDO
      ├─ falha estrutural    → PLANEJANDO
      └─ exceção crítica     → AGUARDANDO_PRODUTOR
```

- O roteiro é um **DAG de `Demanda`**. Cada demanda traz contrato de entradas e saídas, `arquivosEsperados`, complexidade, timeout e critérios de aceite.
- Antes de executar, o roteiro é validado em código: o DAG não pode ter ciclos, os contratos citados precisam existir e duas demandas em paralelo não podem prever o mesmo arquivo.
- Os limites `Np`, `Nc` e o número de tentativas por demanda ficam em código e configuração, nunca no prompt.

## Workspace (arquitetura §5.5)

- Branches: `peca/<id>`, `peca/<id>/<demanda>/<tentativa>` e `peca/<id>/integracao`.
- Commit WIP automático no timeout, no cancelamento e na interrupção, mais checkpoints periódicos.
- O Crítico avalia a branch **integrada**. Conflito de merge conta como falha de roteiro.
- A entrega é por PR (`gh pr create`) por padrão.

## Contas, cotas e seleção (arquitetura §5.6 e §5.7)

- Cada perfil é um diretório isolado:
  - Claude: `CLAUDE_CONFIG_DIR`;
  - Codex: `CODEX_HOME`, com `cli_auth_credentials_store = "file"`;
  - OpenCode: XDG + `OPENCODE_DB`.
- O login é sempre o login oficial, feito no diretório do perfil.
- Chaves de API ficam no cofre do sistema. No Linux sem Secret Service, há fallback criptografado.
- Cada perfil tem um estado: `ok | perto_do_limite | esgotado(ateReset) | desconhecido`. O ccusage guarda o histórico de consumo.
- Cada papel tem uma lista ordenada de Executores e uma regra para quando todos estão esgotados (`proximo` ou `esperar`). A nova tentativa de uma demanda começa por um Executor diferente do anterior, e o motivo de cada escolha vira evento.

## Permissões, recursos e contexto

Ver [09](09-ISOLAMENTO-E-SEGURANCA.md) (arquitetura §5.8 e §5.9) e a arquitetura §5.10, sobre o Ator enxuto, o blackboard, os artefatos por referência e o prefixo estável para cache.

## Ordens do Produtor (arquitetura §5.17)

Conceito trazido do `okit` (`kit orders`) e redesenhado, sem reaproveitar código (Q12).
- **Escopo:** global (um único registro, vale para todos os cenários, inclusive os novos) ou local (um projeto, uma tarefa ou um chat). No mesmo cenário, a local prevalece. Não há ordem para uma lista de cenários (N15, decidida). Uma global pode ser **suspensa** num cenário só.
- **Tipos:** `instrucao` (texto para os modelos; o daemon não interpreta), `regra` (override de uma chave de configuração de uma lista fechada, aplicado em código; nunca de permissão; três chaves na v1) e `suspensao`. A dispensa do Crítico não é ordem: é decisão registrada do Produtor, para a peça inteira, ao abrir a peça ou depois de uma reprovação.
- **Vigência:** início e fim opcionais, com fuso explícito. Aceita "até sexta 18h", "por 3 dias", "de 20/11 a 27/11"; a janela recorrente ("dias úteis, 9h às 18h") fica para depois da v1. Tudo vira data absoluta na confirmação. Se a ordem vale agora é calculado pelo relógio a cada uso, então uma ordem vencida nunca é aplicada, mesmo depois de a máquina dormir. A vigência pode ser prorrogada ou antecipada, com registro.
- **Revogação:** só pelo Produtor, com motivo obrigatório, imediata, em lote se preciso, e definitiva (reativar é criar outra ligada à antiga). Sessões em curso não mudam; o Diretor é avisado e decide se relança o Ator. Uma `regra` revogada devolve o valor da configuração.
- **Onde entram:** sessão do Orquestrador, prefixo estável dos Executores (regras → ordens → papel → contratos), critérios do Crítico, resumo do failover e pacote de continuação (com as ordens vigentes na retomada).
- **Quem cria:** só o Produtor, pelo chat (o Diretor propõe um rascunho com as datas calculadas, e o Produtor confirma), pela aba Ordens ou por `ot ordens`. Executores não têm ferramenta de ordens.
- **Registro:** ids `O<n>`, estados `agendada`/`ativa`/`expirada`/`revogada`, nada é apagado; eventos `ordem.*`; tabela `orders`.

## Retomada de sessões (arquitetura §5.16)

- A interrupção é classificada por causa (cota, rede, queda, reinício, timeout, agente travado).
- A sessão é retomada de duas formas:
  - **nativa**, por `session/load`, no mesmo cliente e perfil;
  - por **passagem de bastão**, com um pacote de continuação, para outro Executor.
- Há checkpoints periódicos e uma tabela `side_effects` com chaves de idempotência, para não repetir efeitos colaterais.
- Interrupções externas não contam como tentativa.

## Interfaces (arquitetura §5.13)

- A **TUI em Ink** é a interface principal (Fase 7). O teste comparativo Ink × OpenTUI na Fase 0 é obrigatório.
- O `packages/client` reúne o cliente da API e as stores zustand vanilla, e é compartilhado com a web (Fase 12) e o desktop (Fase 13), ambos opcionais.
- O mapa de teclas é configurável.
- Mockups: [mockup/tui.html](framework-ideas/mockup/tui.html) e [mockup/app.html](framework-ideas/mockup/app.html).

## Fases (arquitetura §10)

| Fase | Conteúdo | Sem agentes | Com agentes |
|---|---|---|---|
| 0 | Validações e escolha da base (teste da TUI obrigatório) | 2–3 sem | 2–3 sem |
| 1 | Fundação | 1 | 0,5 |
| 2 | Camada de Executores | 2 | 1,5 |
| 3 | Pipeline, MCP do framework e blackboard | 2,5 | 1,5–2 |
| 4 | Permissões e ferramentas de trabalho | 1,5 | 1 |
| 5 | Assinaturas, cotas, seleção e retomada | 2,5 | 1,5–2 |
| 6 | API do daemon e `packages/client` | 1,5 | 0,5–1 |
| 7 | TUI (interface principal) | 2,5–3 | 1,5 |
| 8 | Observabilidade | 1 | 0,5 |
| 9 / 9b | Plugins / Agendador | 1–1,5 cada | 0,5–1 cada |
| 10 | Distribuição (daemon + TUI) | 1 | 0,5–1 |
| 11 | Endurecimento | 1,5–2 | 1–1,5 |
| **Total** | **Produto na TUI** | **≈ 21–24 sem** | **≈ 13–17,5 sem** |
| 12 / 13 | Web / Desktop (opcionais) | + 3–3,5 | + 1,5–2,5 |

Caminho crítico: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 11. As estimativas são faixas para uma pessoa em tempo integral, não prazos.

## Estrutura do repositório de código (arquitetura §9)

`packages/{protocol, daemon, fake-agent, client, tui, web, desktop, plugin-kit}`, `native/job-launcher`, `prompts/`, `docs/`, `spikes/`. O `fake-agent` é um agente ACP simulado: com ele, a máquina de estados, os pools e a UI são testados sem gastar cota.
