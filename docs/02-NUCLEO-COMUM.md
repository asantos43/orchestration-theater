# 02. Núcleo do OTheater (resumo da arquitetura)

Este documento resume o núcleo descrito em [framework-ideas/arquitetura.md](framework-ideas/arquitetura.md) (v0.21, 2026-11-14). Em caso de dúvida ou divergência, vale a arquitetura.

> **Histórico.** Até 2026-11-13, este arquivo descrevia um "núcleo comum" às arquiteturas com e sem contêineres. Nesse desenho, o orquestrador era uma chamada só de decisão (`claude -p` ou `codex exec`, sem ferramentas), e os executores rodavam atrás de uma interface de runner trocável. A arquitetura v0.10 substituiu esse desenho por três peças: um daemon nativo, Executores por **ACP** e um Orquestrador que é uma sessão ACP com ferramentas MCP do framework. A versão anterior está no histórico do git (commit `35c5977`).

## Entidades

| Termo | Significado |
|---|---|
| **Executor** | Cliente + perfil (assinatura ou chave de API) + modelo + esforço |
| **Orquestrador (Diretor)** | Uma sessão ACP como qualquer outra, mas que só recebe as ferramentas MCP do papel Diretor |
| **Perfil** | Uma assinatura ou chave de API de um cliente, com diretório isolado |
| **Cenário** | Projeto, tarefa ou chat genérico. Tem Diretor e chat próprios, pasta, anexos, ordens locais, dashboard e configuração (arquitetura §5.20) |
| **Peça** | Uma execução do pipeline para uma necessidade |
| **Demanda** | Unidade de trabalho do roteiro, executada por um Ator |
| **Tentativa** | Uma execução de uma demanda por um Executor, numa worktree própria |
| **Blackboard** | Memória compartilhada da peça: plano, roteiro, contratos e decisões |
| **Ordem** | Instrução do Produtor que vale além de uma peça: global (todos os cenários) ou local (um cenário), durante a sua vigência e até ser revogada |
| **Casca** | Ferramenta do framework que envolve uma ferramenta existente com política e telemetria |

O glossário completo está na arquitetura §13.

## Princípios (arquitetura §2)

P1 reutilizar os CLIs oficiais · P2 reutilizar bibliotecas · P3 fluxo em código, julgamento no modelo · P4 estado fora do modelo · P5 bloquear tudo, liberar o necessário · P6 tudo é evento · P7 daemon separado da interface · P8 contexto mínimo por Executor · P9 controle de admissão · P10 versões fixadas · P11 licenças permissivas e MPL-2.0 · P12 contratos antes de implementações (portas e adaptadores).

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
| `directives/` | Ordens globais e locais; aplicação das ordens do tipo `rule` | próprio |
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
- Pools por `(client, profile)`. No Claude Code, cada sessão sobe um processo `claude`, então a admissão conta sessões.
- Saída de emergência pelo modo headless: `claude -p --output-format stream-json`, `codex exec --json`.
- **Seleção (§5.7):** cada papel tem uma lista ordenada de Executores, que é a cadeia de fallback. O nome é sempre `<modelo>-<esforço>@<perfil>` (`claude-opus-high@claude-empresa`, `codex-sol-high@codex-1`). A primeira execução (`ot init`) detecta clientes, logins e chaves de API e aplica `roles.preset` (`quality` por padrão, `balanced`, `economical`). O Revisor e o Crítico preferem outro provedor (`selection.cross_check`).

Referência dos clientes e do que foi verificado localmente: [08](08-CLIENTES-CLI-REFERENCIA.md).

## Orquestrador e ferramentas MCP (arquitetura §5.3 e §5.4)

- O Orquestrador **não abre Executores**: ele chama ferramentas MCP do framework, e o daemon abre as sessões.
- Conjuntos de ferramentas por papel:

| Papel | Ferramentas |
|---|---|
| Diretor | `next_action`, `status`, `decide`, `open_play`, `pause`, `resume`, `cancel_actor`, `ask_producer`, `open_pr`, `schedule`, `list_schedules`, `pause_schedule`, `list_directives`, `propose_directive`, `extend_directive`, `revoke_directive`, `consult`, `promote`, `run_task` |
| Todos | `read_blackboard`, `read_contract`, `read_decision`, `read_indication`, `read_attachment`, `submit` |
| Autor / Revisor / Roteirista | `submit_plan`, `submit_plan_review`, `submit_script` |
| Ator | `run_tests`, `install_deps`, `git_commit`, `restricted_shell`, `http_get` + plugins do papel |
| Crítico | `run_tests`, `view_diff`, `submit_critique` |

- `submit*` é a única forma de um Executor terminar. A saída é validada com zod e devolvida com o erro até `N` vezes.
- O modelo do Diretor decide só em **cinco pontos de julgamento**:
  1. classificar a crítica negativa;
  2. decidir o destino do trabalho parcial de um Ator que estourou o tempo;
  3. decidir quando e o que perguntar ao Produtor;
  4. no chat, responder sozinho ou consultar um Ator forte;
  5. numa execução de tarefa com passo falho, corrigir a definição, repetir, pular ou parar.
- Há uma **fila única de prompts** do Orquestrador, com prioridade para o Produtor, e **failover** para o próximo Executor do papel com um resumo gerado do store.

## Pipeline (arquitetura §5.4)

```
NEED → PLANNING → REVIEWING_PLAN → SCRIPTING → EXECUTING
  → INTEGRATING → CRITIQUING → DECIDING
      ├─ aprovado            → DELIVERING → DONE
      ├─ falha de execução   → EXECUTING (só as demandas afetadas)
      ├─ falha de roteiro    → SCRIPTING → REVIEWING_SCRIPT → EXECUTING
      ├─ falha estrutural    → PLANNING
      └─ exceção crítica     → AWAITING_PRODUCER
```

- O roteiro é um **DAG de `Demand`**. Cada demanda traz contrato de entradas e saídas, `expectedFiles`, complexidade, timeout e critérios de aceite.
- Antes de executar, o roteiro é validado em código: o DAG não pode ter ciclos, os contratos citados precisam existir e duas demandas em paralelo não podem prever o mesmo arquivo.
- Os limites `Np`, `Nc` e o número de tentativas por demanda ficam em código e configuração, nunca no prompt.
- **Padrões** (decididos em 2026-11-14, N4, N5, N13 e N14): todos são chaves de configuração, com três predefinições por grupo e chaves individuais.
  - `limits.preset: moderate`: `Np` 2, `Nc` 2, 3 tentativas por demanda, timeout de 30 min (teto de 2 h).
  - `delivery.mode: pr`: `direct_merge` só se o projeto permitir e a peça ou tarefa pedir; `ask` pergunta ao Produtor.
  - `schedule.preset: balanced`: execução perdida até 12 h de atraso, adiamento por cota até 6 h, espera por decisão de 24 h, orçamento de 1 h e US$ 5 em API.
  - `resume.preset: balanced`: 5 retomadas, espera pelo reset até 30 min, checkpoint a cada 10 min, travado com 10 min sem evento ou o mesmo erro 3 vezes.

## Workspace (arquitetura §5.5)

- Branches: `play/<id>`, `play/<id>/<demand>/<attempt>` e `play/<id>/integration`.
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
- Cada perfil tem um estado: `ok | near_limit | exhausted(untilReset) | unknown`. O ccusage guarda o histórico de consumo.
- Cada papel tem uma lista ordenada de Executores e uma regra para quando todos estão esgotados (`next` ou `wait`). A nova tentativa de uma demanda começa por um Executor diferente do anterior, e o motivo de cada escolha vira evento.

## Permissões, recursos e contexto

Ver [09](09-ISOLAMENTO-E-SEGURANCA.md) (arquitetura §5.8 e §5.9) e a arquitetura §5.10, sobre o Ator enxuto, o blackboard, os artefatos por referência e o prefixo estável para cache.

## Ordens do Produtor (arquitetura §5.17)

Conceito trazido do `okit` (`kit orders`) e redesenhado, sem reaproveitar código (Q12).
- **Escopo:** global (um único registro, vale para todos os cenários, inclusive os novos) ou local (um projeto, uma tarefa ou um chat). No mesmo cenário, a local prevalece. Não há ordem para uma lista de cenários (N15, decidida). Uma global pode ser **suspensa** num cenário só.
- **Tipos:** `instruction` (texto para os modelos; o daemon não interpreta), `rule` (override de uma chave de configuração de uma lista fechada, aplicado em código; nunca de permissão; quatro chaves na v1, entre elas `git.push_after_commit`) e `suspension`. A dispensa do Crítico não é ordem: é decisão registrada do Produtor, para a peça inteira, ao abrir a peça ou depois de uma reprovação.
- **Vigência:** início e fim opcionais, com fuso explícito. Aceita "até sexta 18h", "por 3 dias", "de 20/11 a 27/11"; a janela recorrente ("dias úteis, 9h às 18h") fica para depois da v1. Tudo vira data absoluta na confirmação. Se a ordem vale agora é calculado pelo relógio a cada uso, então uma ordem vencida nunca é aplicada, mesmo depois de a máquina dormir. A vigência pode ser prorrogada ou antecipada, com registro.
- **Revogação:** só pelo Produtor, com motivo obrigatório, imediata, em lote se preciso, e definitiva (reativar é criar outra ligada à antiga). Sessões em curso não mudam; o Diretor é avisado e decide se relança o Ator. Uma `rule` revogada devolve o valor da configuração.
- **Onde entram:** sessão do Orquestrador, prefixo estável dos Executores (regras → ordens → papel → contratos), critérios do Crítico, resumo do failover e pacote de continuação (com as ordens vigentes na retomada).
- **Quem cria:** só o Produtor, pelo chat (o Diretor propõe um rascunho com as datas calculadas, e o Produtor confirma), pela aba Ordens ou por `ot directives`. Executores não têm ferramenta de ordens.
- **Registro:** ids `O<n>`, estados `scheduled`/`active`/`expired`/`revoked`, nada é apagado; eventos `directive.*`; tabela `directives`.

## Portas, adaptadores e registros (arquitetura §5.18)

Decidido pelo dono em 2026-11-13 (N16 em [13](13-DECISOES-EM-ABERTO.md)).
- **Porta** = interface TypeScript + schemas zod em `@otheater/core`, com semver própria. Há porta em toda fronteira com o mundo de fora (processos, rede, disco, git, cofre, sistema operacional, relógio) e em todo ponto que varia por cliente, provedor ou sistema. A lógica interna pura (validação do roteiro, precedência de ordens, algoritmo de seleção) fica em funções puras, sem porta.
- **Adaptador** = implementação de uma porta num pacote `@otheater/adapter-*`, escolhida por id na configuração. Toda porta nasce com um adaptador real, um falso e uma suíte de conformidade (em `@otheater/sdk`).
- Portas principais: `ClientAdapter`, `AgentSession` (ACP ou headless), `QuotaProbe`, `UsageSource`, `SecretVault`, `Store`, `EventLog`, `EventSink`, `TelemetryIngest`, `Vcs`, `CodeHost`, `Sandbox`, `ProcessLauncher`, `ResourceMonitor`, `OsScheduler`, `Notifier`, `Clock`, `PromptSource`.
- **Registros** tipados: fluxos (a peça teatral é o padrão; `task.define`, `task.run` e `chat` vêm da §5.20), tipos de cenário, perfis de projeto, tipos de passo, gatilhos, papéis, ferramentas, chaves de `rule` (lista fechada, só módulos oficiais), tipos de evento (plugins só com `plugin.<id>.*`), estratégias e itens da interface. Entrada inválida é recusada na subida do daemon.
- **Montagem manual** num ponto único (`compose.ts`), sem container de injeção. A CI verifica a regra de dependência: `core` só depende do zod, e o daemon só importa adaptadores no ponto de montagem.
- **Duas camadas de extensão:** a interna (adaptadores oficiais, no processo) e a externa (plugins MCP, fora do processo, com painel declarativo). Código de terceiros nunca roda no daemon nem na interface. Não há mods em processo: depois da v1, o plugin ganha níveis opcionais (assinar eventos, ganchos de interceptação que vetam ou anotam, contribuições declarativas), decididos na N17.

## Navegador compartilhado (arquitetura §5.19)

Decidido pelo dono em 2026-11-13 (N18 em [13](13-DECISOES-EM-ABERTO.md)).
- Uma sessão de navegador por cenário, da porta oficial `BrowserSession` no daemon (Playwright sobre CDP). O agente e o Produtor usam a mesma sessão.
- O agente usa as ferramentas `browser_*` (abrir, ler, print, clicar, preencher). As de escrita exigem aprovação por padrão, e só os domínios permitidos são abertos.
- Na web e no desktop, o Produtor vê a tela transmitida, assume o controle e **indica elementos**. Cada indicação vira um artefato `I<n>` (URL, seletor, trecho do HTML, caixa, recorte, comentário), anexado à mensagem do chat.
- O mecanismo de indicar é genérico: **tipos de indicação** num registro, produzidos por superfícies. O primeiro tipo é `web_element`. Outros tipos, como trecho de código, região de imagem, nó do DAG ou tela de app, entram depois, um a um.
- O perfil é isolado por cenário e persistente. O login é feito pelo Produtor, e o agente nunca vê senha.
- As ferramentas entram na v1 (Fase 4); a tela e o modo indicar elemento, na Fase 12.

## Cenários (arquitetura §5.20)

Decidido em 2026-11-13 (N3). Todo cenário é um Diretor que conversa com o Produtor, com chat próprio, pasta própria, anexos, ordens locais e navegador isolado. Há três tipos, num registro:

| Tipo | O que é | Fluxo |
|---|---|---|
| **Projeto** | Pasta versionada por git com um **perfil de projeto**. O padrão é `software`, em que o OTheater gera e controla changelog, commits, PRs, publicação e CI. Um repositório importado mantém as convenções detectadas, confirmadas pelo Produtor. Um repositório por projeto na v1 | Peça teatral |
| **Tarefa** | Workflow que gera um artefato final, uma vez ou recorrente. Tem uma **definição** versionada de passos tipados (`code`, `model`, `agent`, `approval`, `delivery`), desenhada pelos papéis e ensaiada pelo Crítico antes da aprovação, e as **execuções** dela, cada uma com pasta própria. Gatilhos de horário e manual na v1, de evento depois | `task.define` e `task.run` |
| **Chat genérico** | Prototipação. O Diretor barato responde o simples e abre um Ator `consultant` forte quando precisa. Pode virar tarefa ou projeto: a **promoção** cria um cenário novo ligado ao chat | `chat` |

- **Anexos** `A<n>` de qualquer tipo, por referência, lidos com `read_attachment`. A seleção respeita os tipos de entrada que cada Executor aceita.
- **Diretor adormecido:** sem atividade, a sessão do Diretor fecha e reabre pelo resumo do store, como no failover.
- **Padrões como chaves de configuração** (N19), com override por cenário:
  - Diretor adormece depois de 15 min;
  - anexo copiado de até 50 MB;
  - as 30 últimas execuções de cada tarefa ficam inteiras;
  - todas as versões da definição são guardadas.
- O Diretor continua leve: os papéis fazem o trabalho, e a seleção escolhe o melhor Executor para cada um.

## Retomada de sessões (arquitetura §5.16)

- A interrupção é classificada por causa (cota, rede, queda, reinício, timeout, agente travado).
- A sessão é retomada de duas formas:
  - **nativa**, por `session/load`, no mesmo cliente e perfil;
  - por **passagem de bastão**, com um pacote de continuação, para outro Executor.
- Há checkpoints periódicos e uma tabela `side_effects` com chaves de idempotência, para não repetir efeitos colaterais.
- Interrupções externas não contam como tentativa.

## Durabilidade e recuperação (arquitetura §5.21)

Decidido em 2026-11-13 (N20).
- **Fechar a interface** não para nada: o daemon é outro processo (P7).
- **Gravação durável:** o store usa WAL com `synchronous=FULL`, e toda mudança de estado é gravada antes do efeito que dispara. Uma queda de energia não desfaz transação confirmada.
- **Reconciliação na subida:** integridade do store, processos órfãos, sessões marcadas como interrompidas, commit do que ficou sem commit nas worktrees e efeitos ambíguos resolvidos pelo verificador da ferramenta ou pelo Produtor. Só então vêm a retomada (§5.16), a agenda (regra da janela, §5.15) e as ordens.
- **Sem login:** na v1, a máquina religada espera o login para rodar qualquer coisa. Logo depois da v1, a Fase 10b passa para o daemon completo sem login.
- **Backup** automático diário, a partir das 3h ou na primeira subida depois, com 7 cópias em `backups/` nos dados do daemon. Entram o store e as pastas de tarefa e chat, menos as execuções. Há também `ot backup` e `ot restore`. Tudo isso é chave de configuração (N21).

## Interfaces (arquitetura §5.13)

- A **TUI em Ink** é a interface principal (Fase 7). O teste comparativo Ink × OpenTUI na Fase 0 é obrigatório.
- O `packages/client` reúne o cliente da API e as stores zustand vanilla, e é compartilhado com a web (Fase 12), o desktop (Fase 13, opcional) e o app Android de celular e tablet (Fase 14). O app Android é Capacitor sobre a web e chega ao daemon pela VPN do usuário (arquitetura §5.12 e §5.13); por isso, a web deixou de ser opcional (2026-11-14).
- O mapa de teclas é configurável.
- Todas as telas existem em inglês e em português do Brasil desde a primeira, por um catálogo de textos; o idioma vem do sistema e a chave `ui.locale` troca (§5.22).
- Mockups: [mockup/tui.html](framework-ideas/mockup/tui.html), [mockup/app.html](framework-ideas/mockup/app.html) e [mockup/mobile.html](framework-ideas/mockup/mobile.html) (Android, celular e tablet).

## Idioma (arquitetura §5.22)

Decidido em 2026-11-14 (N22).
- **Em inglês:** código, store, schemas, estados, eventos, chaves de configuração, ferramentas MCP, comandos `ot`, logs, commits do próprio OTheater e os prompts e skills mandados aos agentes.
- **No idioma do Produtor:** as respostas no chat, por uma ordem global (por exemplo, "Respostas em português do Brasil").
- **Nos projetos do Produtor:** commits, changelog e PRs seguem as convenções do projeto.
- **Interface:** `en` e `pt-BR` completos, por catálogo.
- **Nomes:** cada conceito tem um nome canônico em inglês (glossário da arquitetura, §13). Os nomes foram aprovados pelo dono em 2026-11-14. Exemplos: Peça é `Play`, Ordem é `Directive` e Roteirista é `scriptwriter`.
- **Estes documentos** continuam em português, com os identificadores já em inglês.

## Fases (arquitetura §10)

| Fase | Conteúdo | Sem agentes | Com agentes |
|---|---|---|---|
| 0 | Validações e escolha da base (teste da TUI obrigatório) | 2–3 sem | 2–3 sem |
| 1 | Fundação (com `core`, `sdk` e ponto de montagem) | 1,5 | 1 |
| 2 | Camada de Executores | 2 | 1,5 |
| 3 | Pipeline, MCP do framework, blackboard, base dos cenários (com o chat) e reconciliação | 3,5 | 2,5–3 |
| 4 | Permissões, ferramentas de trabalho, navegador e perfil `software` | 2,5 | 1,5–2 |
| 5 | Assinaturas, cotas, seleção e retomada | 2,5 | 1,5–2 |
| 6 | API do daemon e `packages/client` | 1,5 | 0,5–1 |
| 7 | TUI (interface principal) | 2,5–3 | 1,5 |
| 8 | Observabilidade | 1 | 0,5 |
| 9 | Plugins | 1–1,5 | 0,5–1 |
| 9b | Agendador e tarefas | 2,5–3 | 1,5–2 |
| 10 | Distribuição (daemon + TUI) | 1 | 0,5–1 |
| 11 | Endurecimento | 1,5–2 | 1–1,5 |
| **Total** | **Produto na TUI** | **≈ 25–28 sem** | **≈ 16–20,5 sem** |
| 12 / 13 | Web (com a tela do navegador) / Desktop (opcional) | + 3,5–4 | + 2–3 |
| 14 | App Android, celular e tablet (depois da web) | + 2–2,5 | + 1–1,5 |

Caminho crítico: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 11. As estimativas são faixas para uma pessoa em tempo integral, não prazos.

## Estrutura do repositório de código (arquitetura §9)

`packages/{core, sdk, protocol, adapters/*, daemon, fake-agent, client, tui, web, desktop, android}`, `native/job-launcher`, `prompts/`, `docs/`, `spikes/`. O `core` guarda as portas, o `sdk` serve a quem escreve adaptadores e plugins, e cada adaptador é um pacote em `adapters/`. O `fake-agent` é um agente ACP simulado: com ele, a máquina de estados, os pools e a UI são testados sem gastar cota.
