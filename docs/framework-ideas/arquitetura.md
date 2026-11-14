# Arquitetura — OTheater (Orchestration Theater)

> Documento-base de construção. Complementa `framework_multiagentes.md` (pipeline teatral), `framework_multiagentes_orquestrador_e_executores.md` (entidades) e `principais-papeis.md`. Onde este documento detalha *como*, aqueles definem *o quê*.
>
> Versão 0.26 — 2026-11-14. Produto: **OTheater** (*Orchestration Theater*). Linguagem: **TypeScript** de ponta a ponta. Licença do código próprio: **MPL-2.0** (era MIT até a v0.18).
> A v0.5 definiu a TUI em **Ink**, com teste do **OpenTUI** na Fase 0, e ligou as interfaces aos mockups em `mockup/`. A v0.6 faz da **TUI a interface principal** (Fase 7), cria o `packages/client` compartilhado e deixa web e desktop como fases opcionais (12 e 13). A v0.7 acrescenta o suporte multiplataforma da TUI: mapa de teclas configurável com padrões por sistema, fallback do cofre no Linux e uso por SSH. A v0.11 acrescenta as **ordens do Produtor**, globais e locais (seção 5.17), conceito trazido do `okit`. A v0.12 acrescenta **portas, adaptadores e registros** (P12, seção 5.18): contratos em `@otheater/core`, implementações trocáveis em pacotes `@otheater/adapter-*` e fluxos registrados por nome. A v0.13 acrescenta o **navegador compartilhado** (seção 5.19): o Produtor indica elementos da página para o agente trabalhar. A v0.14 define os **cenários** (seção 5.20): projeto com perfil, tarefa com definição e execuções, e chat genérico com Diretor que consulta um Ator forte. A v0.15 trata da **durabilidade e recuperação** (seção 5.21): gravação durável no SQLite, reconciliação na subida, comportamento com a máquina religada sem login e backup diário. A v0.16 fixa os **padrões** dos cenários e da durabilidade como chaves de configuração (seções 5.20 e 5.21) e cria a Fase 10b, do daemon sem login, logo depois da v1. A v0.17 define o **idioma** (seção 5.22): código, configuração, eventos, ferramentas, comandos e prompts em inglês, interface em inglês e português do Brasil desde a primeira tela, e os nomes canônicos em inglês no glossário (seção 13). A v0.18 fixa os **padrões do pipeline, da entrega, do agendador e da retomada** como chaves de configuração com predefinições (seções 5.4, 5.5, 5.15 e 5.16). A v0.19 troca a licença do código próprio de MIT para **MPL-2.0** e passa a aceitar MPL-2.0 em código copiado e dependências (seção 6.0). A v0.20 acrescenta as versões do app para **Android**, celular e tablet (seção 5.13, Fase 14): Capacitor sobre a web, acesso ao daemon pela VPN do usuário (seção 5.12) e, por consequência, a web deixa de ser opcional. A v0.21 fixa os **Executores padrão** de cada papel (seção 5.7): nome `<modelo>-<esforço>@<perfil>`, predefinições `roles.preset` aplicadas na primeira execução e revisão cruzada por provedor. A v0.22 define o **custo em moeda** e o **teto de gasto em API** (seção 5.6): cota e equivalente em API nas assinaturas, custo real nas contas de API, teto por dia e por mês no perfil e despertar agendado para retomar o trabalho quando a cota ou o teto voltam. A v0.23 resolve duas contradições sobre o **modelo local** (seções 5.7 e 5.9): ele pode ser Ator, limitado pelos slots da instância, com slots reservados ao Diretor, e o provedor de um Executor na revisão cruzada é a família do modelo, não o cliente. Os Executores do OpenCode entram por um assistente de cadastro com sugestões, e o daemon só valida. A abstração passa a ter dois eixos (seção 5.18): o **cliente** de agente (`ClientAdapter`, agora com o catálogo de modelos `ModelCatalog`) e o **servidor de modelo local** (nova porta `LocalModelServer`, com llama.cpp na v1 e Ollama depois). O nome do Executor passa a incluir o cliente, `<modelo>-<esforço>@<cliente>/<perfil>`, porque o OpenCode também pode chamar modelos do Claude e do GPT por API; com assinatura, cada família só roda pelo seu cliente oficial (`executors.cross_client: api_only`). A configuração dos papéis passa a ter override por papel em cada cenário e tarefa agendada, e não só a restrição de perfis por projeto. A primeira execução vira um `ot init` mínimo que abre a TUI num assistente de configuração cuja lógica fica no daemon. A v0.24 define a **capacidade mínima de cada papel** (seção 5.7): todos os papéis aceitam modelo local, e o que separa um Executor de um papel é a capacidade, igual para modelo local e na nuvem (janela de contexto, raciocínio nos papéis que decidem e uma sessão de teste no cadastro), com aviso em vez de bloqueio por padrão (`roles.capability_check: warn`). A v0.25 fixa o daemon como **serviço de logon** do usuário, sempre: o app desktop, se for feito, é só mais um cliente, como a TUI (item 6 da seção 12). A v0.26 faz das **perguntas ao Produtor listas de múltipla escolha** por padrão (seção 5.3, `chat.producer_questions: choices`), com a opção recomendada, que vale depois de um prazo sem resposta, menos nas decisões irreversíveis, em que a recomendada é sempre a segura; nas tarefas agendadas, o padrão passa a ser esperar um prazo e seguir com a recomendada (5.15).
> A v0.2 incorporou uma pesquisa de código reaproveitável (seção 6) e uma revisão do desenho (seção 15). A v0.3 criou a política de licenças; a v0.4 passa a aceitar Apache-2.0 e as demais licenças permissivas (seção 6.0). Os itens marcados **[a confirmar]** vieram de fontes secundárias ou não puderam ser verificados na fonte e entram na Fase 0.

---

## 1. Objetivo

**Nome:** **OTheater**, abreviação de *Orchestration Theater*: a orquestração de agentes encenada como teatro, como no pipeline de `framework_multiagentes.md`. Grafia fixa em inglês americano (*Theater*, não *Theatre*). Detalhes de pacote, comando e repositório na seção 9.

O OTheater é um sistema de agentes de código que:

1. executa o pipeline teatral (Produtor → Autor → Revisor → Roteirista → Diretor/Atores → Crítico → decisão) de forma **consistente e determinística**;
2. usa de forma **transparente** Claude Code, Codex e OpenCode (e, por eles, Anthropic, OpenAI, MiniMax, modelos locais e qualquer provedor por API);
3. suporta **assinaturas (token plan) e API**, com várias contas por cliente, adicionáveis e removíveis;
4. oferece **chat com o Orquestrador**, dashboard por cenário, página de configuração, plugins e acompanhamento em tempo real (consumo, telemetria, trajetórias) por uma API;
5. custa o mínimo para construir: **não reescrevemos agentes nem infraestrutura que já existe**; o código próprio fica concentrado no que é diferencial (pipeline, seleção por cota, política de permissões).

## 2. Princípios de projeto

| # | Princípio | Consequência |
|---|---|---|
| P1 | Reutilizar os CLIs oficiais como Executores | O loop de ferramentas, a edição de arquivos e o login de assinatura vêm prontos |
| P2 | Reutilizar bibliotecas antes de escrever | Adaptadores ACP, SDK do MCP, máquina de estados, componentes de UI e telemetria vêm de projetos existentes (seção 6) |
| P3 | Fluxo em código, julgamento no modelo | O pipeline é uma máquina de estados; o modelo só decide em pontos estreitos, com saída validada por schema |
| P4 | Estado fora do modelo | Tudo persiste no daemon; o Orquestrador consulta `next_action` e sobrevive a compressão de contexto ou reinício |
| P5 | Bloquear tudo, liberar o necessário | Permissões por lista de permitidos, por papel, em três camadas; a configuração do cliente é política, não fronteira de segurança |
| P6 | Tudo é evento | Um único log de eventos alimenta dashboard, SSE, OTel, ATIF e auditoria |
| P7 | Daemon separado da interface | Fechar a UI não interrompe as peças; várias UIs (TUI, web, desktop, Android) sobre a mesma API |
| P8 | Contexto mínimo por Executor | O Ator nasce com demanda + contrato; artefatos circulam por referência |
| P9 | Recursos sob controle de admissão | O paralelismo é limitado por RAM, cota e pool, não só pelo que o Roteirista permite |
| P10 | Versões fixadas | ACP, adaptadores e CLIs mudam toda semana: tudo fixado, atualizado de propósito, com testes de contrato |
| P11 | Licenças permissivas e MPL-2.0 | Código próprio em MPL-2.0; código copiado e dependências empacotadas em MIT, Apache-2.0, ISC, BSD ou MPL-2.0; GPL, AGPL e LGPL proibidas (seção 6.0) |
| P12 | Contratos antes de implementações | Toda fronteira com o mundo de fora e todo ponto que varia por cliente, provedor ou sistema é uma **porta** (interface TypeScript + schema zod) em `@otheater/core`; as implementações são **adaptadores** trocáveis, montados num único ponto; fluxos, papéis, ferramentas e chaves de `rule` ficam em **registros** tipados (seção 5.18) |

## 3. Premissas e restrições

- **Assinatura só pelo cliente oficial, sem tocar no token.** O framework nunca lê, copia nem reaproveita tokens OAuth. Ele dispara o login oficial num diretório de perfil isolado e executa o CLI oficial.
- **Termos da Anthropic** (documentação de legal e conformidade do Claude Code):
  - o login OAuth é para o "uso comum do Claude Code e de outros aplicativos nativos da Anthropic";
  - quem desenvolve **produtos**, inclusive com o Agent SDK, precisa usar **chave de API**: não pode oferecer login do Claude.ai, encaminhar requisições pelas credenciais de assinatura em nome de usuários, nem coletar ou intermediar esses tokens;
  - é permitido que um usuário final entre com a própria assinatura no **binário do Claude Code sem modificação**.

  **Consequência:**
  - **uso pessoal** (cada pessoa roda o daemon com os próprios logins, que acionam o CLI oficial) se encaixa na permissão;
  - **distribuir como produto** para terceiros com assinatura Claude exige confirmação com a Anthropic. Até lá, o modo produto usa chave de API para Claude. Ver o risco R1 na seção 11.
- **OpenAI:** a documentação recomenda chave de API para automação e pede tratar `auth.json` como senha. O uso do login ChatGPT em ferramentas de terceiros tem relatos de ser permitido por parceria **[a confirmar]**.
- **Várias contas pessoais** para somar limites: conferir os termos de cada provedor. Planos de time/empresa com vários assentos são o caminho limpo.
- **ACP (Agent Client Protocol)** é o protocolo entre o daemon e os Executores. **MCP** é o protocolo das ferramentas do framework e dos plugins.
- **Windows primeiro**, sem impedir macOS/Linux. O que é específico do sistema operacional fica atrás de portas (5.18), com adaptadores por sistema (`platform-windows`, `platform-posix`).
- **Segredos:** chaves de API ficam no cofre do sistema operacional; nunca em arquivo de configuração, log ou evento.
- **Operação local por padrão:** o daemon escuta em `127.0.0.1`; acesso remoto exige token + TLS. O app Android chega ao daemon pela VPN do usuário (5.12).

## 4. Visão geral

```
┌── Interfaces: TUI Ink (principal) · web e Android (pós-v1) · desktop (opcional) ─────┐
│ Lateral: Assinaturas · Projetos · Tarefas · Chats · Plugins · Configuração           │
│ Por cenário: [Chat com o Orquestrador]  [Dashboard]  [Trajetórias]                    │
└──────────┬────────────────────────────────────────────────────────────┬──────────────┘
           │ REST + WebSocket (chat)                                    │ SSE (eventos)
           ▼                                                            │
┌──────────────────────────────── Daemon (Node + TypeScript) ──────────────────────────┐
│  api/        REST · SSE · WS · autenticação                    (Hono)                │
│  pipeline/   máquina de estados da peça · DAG de demandas      (XState v5)           │
│  selection/  seleção de Executor (prioridade × disponibilidade)                      │
│  accounts/   perfis · cofre · sondas de cota                   (@napi-rs/keyring)    │
│  executors/  cliente ACP · pools · adaptadores                 (@agentclientprotocol)│
│  mcp/        servidor MCP do framework (filtro por papel)      (MCP SDK v2)          │
│  plugins/    agregador de servidores MCP de plugins                                  │
│  tools/      cascas: run_tests, git_*, http_get, shell restrito                      │
│  resources/  semáforos · lançador com Job Object               (launcher Rust)       │
│  workspace/  worktrees · branches · integração · PR            (git + gh)            │
│  store/      SQLite (WAL): eventos, estado, blackboard         (better-sqlite3)      │
│  telemetry/  receptor OTLP · export ATIF                       (OpenTelemetry JS)    │
└──────────┬───────────────────────────────────────┬───────────────────────────────────┘
           │ ACP (sessão do Orquestrador)          │ ACP (pools por perfil)
           ▼                                       ▼
   Orquestrador (Diretor)                  Autor · Revisor · Roteirista · Atores · Crítico
   claude-agent-acp + Haiku,               claude-agent-acp · codex-acp ·
   opencode acp + Gemma 4 local            opencode acp · gemini --acp
           │                                       │
           └──── MCP do framework (HTTP) ──────────┘  + plugins MCP do papel (HTTP)
```

**Portas e adaptadores (5.18):** cada módulo acima depende só das portas de `@otheater/core`. As bibliotecas entre parênteses são os **adaptadores padrão**, montados no ponto de montagem do daemon e trocáveis pela configuração.

**ACP em dois níveis:** o daemon é cliente ACP da sessão do Orquestrador (com quem você conversa pelo chat) e também de todos os Executores. O Orquestrador **não** abre Executores: ele chama ferramentas MCP do framework, e é o daemon que abre as sessões.

## 5. Componentes

### 5.1 Daemon

- Processo Node de longa duração, sempre iniciado como serviço de logon do usuário (decidido em 2026-11-14, v0.25, item 6 da seção 12). Nenhuma interface hospeda o daemon: a TUI, a web, o app desktop e o app Android só se conectam a ele.
- Um único daemon por usuário/máquina, garantido por lock de arquivo sobre o store.
- Responsável pelo estado global, pelo ciclo de vida dos Executores, pela execução das ferramentas homologadas e pela API das interfaces.
- **Recuperação ao reiniciar:** a reconciliação da seção 5.21, que roda antes de retomar qualquer coisa:
  - integridade do store;
  - processos órfãos;
  - sessões em curso marcadas como `interrupted`;
  - commit do que ficou sem commit nas worktrees;
  - efeitos colaterais ambíguos;
  - reidratação das máquinas XState;
  - agenda e ordens.

  Desde a v0.15, ela substitui os quatro passos que esta lista tinha.

### 5.2 Camada de Executores

**Executor = cliente + perfil de assinatura + modelo + esforço.**

**Cliente ACP:** `@agentclientprotocol/sdk` (v2, modelo `client()` + `connectWith`; a v2.0 removeu `ClientSideConnection`, então tutoriais antigos não valem). O daemon sobe o processo do adaptador e entrega o stream ao SDK.

Métodos usados:
- `initialize` (lê as capacidades, ex.: `mcpCapabilities.http`);
- `session/new` com `cwd` = worktree e `mcpServers` em HTTP;
- `session/prompt` e `session/update` (stream);
- `session/request_permission`;
- `session/cancel`;
- `session/load`, onde houver.

**Modelo, esforço e modo por sessão** pelas **Session Config Options** do ACP: `session/set_config_option` com as categorias `model`, `thought_level`, `mode` e `model_config`. O adaptador anuncia quais opções aceita, e a página de configuração usa essa lista. Isso substitui a tradução manual de esforço por cliente da v0.1. Fica um fallback por adaptador para o que não for exposto.

**Adaptadores prontos** (não os escrevemos):

| Cliente | Pacote / comando | Observações |
|---|---|---|
| Claude Code | `@agentclientprotocol/claude-agent-acp` (TS, Apache-2.0) | Um processo com várias sessões, mas **cada sessão sobe um processo `claude`**. Anuncia MCP HTTP e `loadSession`. Modelo e esforço são config options. |
| Codex | `@agentclientprotocol/codex-acp` (TS, Apache-2.0, mantido pela JetBrains) | Inclui `@openai/codex` e conversa com o `codex app-server`. Modelo, esforço, aprovação e sandbox selecionáveis. Várias sessões por processo **[a confirmar]**. |
| OpenCode | `opencode acp` (nativo) | Concorrência e config options **[a confirmar]**. A API V1→V2 do OpenCode mudou; fixar a versão. |
| Gemini CLI | `gemini --acp` (nativo) | Opcional. O ACP lá ainda é parcialmente `unstable`. |

**Interface própria (fina)** sobre cada adaptador. Ela cobre só o que o ACP não cobre:

```ts
interface ClientAdapter {
  id: 'claude-code' | 'codex' | 'opencode' | 'gemini' | string;
  command(profile: Profile): { cmd: string; args: string[] };          // ex.: npx claude-agent-acp
  profileEnv(profile: Profile): Record<string, string>;                // CLAUDE_CONFIG_DIR, CODEX_HOME...
  prepareProfile(profile: Profile, policy: RolePolicy): Promise<void>; // grava settings/config do perfil (permissões, statusline, OTel)
  login(profile: Profile): Promise<LoginFlow>;                         // login oficial no diretório do perfil
  logout(profile: Profile): Promise<void>;
  quota: QuotaProbe;                                                   // seção 5.6
  models: ModelCatalog;                                                // catálogo e validação dos modelos (5.7), v0.23
  processModel: 'process-per-session' | 'multi-session';                // medido na Fase 0
}

interface ModelCatalog {
  discovery: 'automatic' | 'assisted';                                 // Claude Code e Codex: automatic; OpenCode: assisted
  list(profile: Profile): Promise<ModelInfo[]>;                         // OpenCode: opencode models --verbose
  suggest(model: ModelInfo): Partial<ExecutorDraft>;                   // esforço, provider (família), local, custo
  validate(executor: Executor): Promise<ValidationResult>;             // existe, esforço aceito, toolcall
}
```

A interface acima é **[proposta]** (v0.23); a forma final sai da Fase 1.

`ClientAdapter` é uma porta de `@otheater/core` (5.18), e cada cliente é um pacote `@otheater/adapter-<cliente>` que passa na suíte de conformidade da porta. A conversa com o Executor fica numa porta separada, `AgentSession`, cujo adaptador padrão é o ACP.

**Pools por `(client, profile)`:**
- até `K` sessões por processo do adaptador; acima disso, abre outro processo;
- processo ocioso por `idleMs` é encerrado;
- processo travado é morto, e as sessões dele voltam para a fila;
- no Claude Code, o custo de RAM é por sessão (um `claude` por sessão), então o semáforo de admissão conta sessões, não processos do adaptador.

**Isolamento:** todo processo de Executor nasce pelo **lançador com Job Object** (ver 5.9). Ele limita a memória e mata a árvore inteira no cancelamento.

**Ciclo curto:** sessão termina → resultado estruturado gravado → sessão fechada.

**Saída de emergência:** se um adaptador se mostrar instável, a porta `AgentSession` (5.18) permite trocá-lo pelo modo headless do próprio cliente sem mexer no resto:
- `claude -p --output-format stream-json`;
- `codex exec --json`, ou o `@openai/codex-sdk`.

### 5.3 Servidor MCP do framework

- Um único servidor, com **MCP SDK v2** (`@modelcontextprotocol/server`) em Streamable HTTP, servido pelo daemon.
- O SDK v2 usa uma fábrica por requisição (`createMcpHandler(factory)`). A fábrica lê o token da sessão e devolve só as ferramentas daquele papel/peça/demanda. É ali que o filtro por papel é implementado.

| Conjunto | Ferramentas |
|---|---|
| Diretor (Orquestrador) | `next_action`, `status(play?)`, `decide(decisionId, payload)`, `open_play(need)`, `pause`, `resume`, `cancel_actor`, `ask_producer`, `open_pr`, `schedule` (rascunho, confirmado pelo Produtor), `list_schedules`, `pause_schedule`, `list_directives`, `propose_directive`, `extend_directive` e `revoke_directive` (rascunhos, confirmados pelo Produtor; 5.17), `consult` (chat), `promote` (rascunho), `run_task` (5.20) |
| Comum (todos os Executores) | `read_blackboard(key)`, `read_contract(id)`, `read_decision(id)`, `read_indication(id)` (5.19), `read_attachment(id)` (5.20), `submit(result)` |
| Autor / Revisor / Roteirista | `submit_plan`, `submit_plan_review`, `submit_script` (cada um com schema próprio) |
| Ator | `run_tests(target)`, `install_deps()`, `git_commit(message)`, `restricted_shell(argv)`, `http_get(url)`, `browser_*` se a política do papel liberar (5.19) + plugins do papel |
| Crítico | `run_tests(target)`, `view_diff(demand?)`, `submit_critique` |

`submit*` é a única forma de um Executor terminar:
- a saída é validada com **zod** contra o schema do papel;
- saída inválida volta ao Executor com o erro de validação, até `N` vezes;
- depois disso, conta como falha da tentativa.

**Perguntas ao Produtor (`ask_producer`)** (decidido em 2026-11-14, v0.26, item 24 da seção 12, a pedido do dono): por padrão, o Diretor pergunta por **listas de opções de múltipla escolha**, e isso é aplicado em código (P3), não por texto no prompt.
- **Schema** (zod), validado como o `submit`: de 1 a 4 perguntas por chamada, respondidas de uma vez. Cada pergunta tem o texto, de 2 a 4 opções com rótulo e descrição, a opção **recomendada** (mostrada em primeiro e destacada), se aceita **mais de uma** opção (`multi_select`) e a marca `open` para a pergunta que não cabe em opções (ex.: "qual o nome do projeto?"). A interface sempre acrescenta **"Outra"**, com texto livre, sem o Diretor pedir. Nomes dos campos **[proposta]**;
- **as interfaces só desenham**, pelo mesmo dado da API (eventos `decision.*`, 5.11): a TUI mostra uma lista navegável com as setas ou o número da opção, Espaço para marcar na escolha múltipla e Enter para responder; a web e o tablet, botões; o celular, um toque (5.13) **[proposta]**;
- quem não responde: abaixo, `chat.unanswered`, e nas tarefas agendadas, `schedule.unattended_decision` (5.15).

```yaml
chat:
  producer_questions: choices      # choices | choices_strict | free
  unanswered:
    mode: wait_then_recommended    # wait_then_recommended | wait | recommended_now
    wait_for: 30m                  # 0 = espera sem prazo
```

- `producer_questions: choices` (padrão): opções sempre que der; uma pergunta sem opções só passa com a marca `open`, e sem ela o daemon devolve o erro de validação ao Diretor, que refaz a pergunta. `choices_strict`: toda pergunta precisa de opções, e o texto livre fica só no "Outra". `free`: sem exigência;
- `unanswered.mode: wait_then_recommended` (padrão): o daemon espera o Produtor por `wait_for` (30 min por padrão) e então responde com a recomendada. O evento (`decision.auto_answered`) registra que a escolha foi automática, e o chat mostra a pergunta e a resposta. `wait`: espera sem prazo, com notificação. `recommended_now`: segue na hora e avisa depois. Uma pergunta `open` ou sem recomendada sempre espera o Produtor;
- **salvaguarda nas decisões irreversíveis** (merge na branch base, 5.5; aumentar o teto de gasto, 5.6): a recomendada é definida pelo daemon e é sempre a opção segura (`pr` em vez de merge, `skip` em vez de aumentar o teto), e o Diretor não pode marcar outra. Vale para a resposta automática do chat e para a das tarefas agendadas. A lista dessas decisões é fechada e fica no código **[proposta]**;
- **escopo:** as duas chaves são globais, com override por cenário e por tarefa agendada, na mesma precedência de `roles` (5.7), e entram na lista fechada de chaves que uma ordem `rule` pode mudar (5.17).

### 5.4 Máquina de estados do pipeline

**XState v5** modela a peça. A peça teatral é o **fluxo padrão** do registro de fluxos (5.18): uma máquina montada com etapas reutilizáveis, registrada por nome e versão. Os fluxos da tarefa e do chat estão na seção 5.20. O snapshot (`getPersistedSnapshot()`) é gravado no SQLite a cada transição e reidratado no reinício.

Cuidados conhecidos:
- restaurar só na mesma versão da máquina (o snapshot guarda a versão, e há migração explícita quando ela mudar);
- não depender de *history states*;
- não deixar promessas em voo dentro da máquina: efeitos longos (sessões ACP) ficam fora dela e voltam como eventos.

Fluxo:

```
NEED
  → PLANNING (Autor)
  → REVIEWING_PLAN (Revisor) ──reprovado──→ PLANNING        [contador plano ≤ Np]
  → SCRIPTING (Roteirista)
  → EXECUTING (Atores, DAG de demandas)
  → INTEGRATING (merge das demandas na branch de integração; conflito = falha de roteiro)
  → CRITIQUING (Crítico, sobre a branch integrada)
  → DECIDING (Diretor)
       ├─ aprovado ──────────→ DELIVERING (PR/merge na base) → DONE
       ├─ falha de execução ─→ EXECUTING (só demandas afetadas)
       ├─ falha de roteiro ──→ SCRIPTING → REVIEWING_SCRIPT (Autor) → EXECUTING
       ├─ falha estrutural ──→ PLANNING (recomeça Revisor → Roteirista → ...)
       └─ exceção crítica ───→ AWAITING_PRODUCER
  [reprovações do Crítico > Nc] → falha estrutural; se já estrutural → AWAITING_PRODUCER
```

- Transições, contadores e limites (`Np`, `Nc`, tentativas por demanda) ficam em código e configuração, nunca no prompt.
- **Dispensa do Crítico** (decidida em 2026-11-13; ver 5.17): é uma decisão registrada do Produtor, com motivo, e vale sempre para a **peça inteira**. Pode ser tomada em dois momentos:
  - ao abrir a peça: a máquina pula CRITIQUING e DECIDING, e vai de INTEGRATING a DELIVERING. Os testes da integração continuam rodando;
  - com a peça em AWAITING_PRODUCER depois de uma reprovação ("aceito assim"): a peça vai a DELIVERING.
  - Nos dois casos, o PR informa que o Crítico foi dispensado, por quem e por quê. Nenhuma ordem dispensa o Crítico.

**Limites do pipeline** (decidido em 2026-11-14, N4). Os limites são chaves de configuração, com valor global e override por projeto e por tarefa agendada. O padrão é a predefinição `moderate`.

```yaml
limits:
  preset: moderate             # moderate | economical | persistent
  plan_reviews: 2              # Np: reprovações do plano antes de AWAITING_PRODUCER
  critic_rejections: 2         # Nc: reprovações do Crítico antes da falha estrutural
  attempts_per_demand: 3
  demand_timeout: 30m          # quando o Roteirista não define o timeoutMin da demanda
  demand_timeout_max: 2h       # teto do que o Roteirista pode pedir
```

| Predefinição | `Np` | `Nc` | Tentativas | Timeout | Teto |
|---|---|---|---|---|---|
| `moderate` (padrão) | 2 | 2 | 3 | 30 min | 2 h |
| `economical` | 1 | 1 | 2 | 20 min | 1 h |
| `persistent` | 3 | 3 | 4 | 45 min | 3 h |

- A predefinição (`preset`) preenche todos os valores de uma vez. Uma chave individual sobrepõe só o valor dela **[proposta]**.
- O schema zod vem do módulo dono das chaves e é validado na subida (5.18). A aba Configurações › Limites e `ot config` mostram e mudam as chaves.

**Pontos de julgamento.** São os únicos lugares onde o modelo do Diretor decide, cada um com schema:
1. classificar a crítica negativa (execução / roteiro / estrutural / exceção) e listar as demandas afetadas;
2. Ator estourou o tempo: o trabalho parcial (já commitado, ver 5.5) segue para o Crítico ou para outro Ator continuar;
3. quando consultar o Produtor, e o que perguntar;
4. no chat, responder sozinho ou consultar um Ator forte (5.20);
5. numa execução de tarefa com passo falho: corrigir a definição, repetir, pular ou parar (5.20).

**Fila única de prompts do Orquestrador.** Mensagens suas no chat e avisos do daemon ("decisão pendente D-17; chame `next_action`") entram numa fila e são enviados à sessão do Orquestrador um de cada vez. Nunca dois `session/prompt` concorrentes. Mensagem do Produtor tem prioridade sobre aviso do daemon.

**Andamento sem custo de modelo.** "Ator 2 concluiu", "Crítico reprovou (1/3)" e semelhantes são mensagens de sistema que o daemon envia direto ao chat da UI, sem passar pelo modelo.

**Failover do Orquestrador.** Se o perfil do Diretor esgotar a cota ou falhar, o daemon abre uma sessão nova com o próximo Executor da lista do papel. Ela recebe um resumo gerado a partir do store (estado da peça, decisões pendentes, ordens vigentes, últimas mensagens do chat). Nada se perde, porque o estado nunca esteve só no modelo.

**Roteiro = DAG de demandas.** Cada demanda:

```ts
interface Demand {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];             // arestas do DAG
  contract: {                      // interface rígida entre Atores
    inputs: ContractRef[];         // o que consome de outras demandas
    outputs: ContractRef[];        // o que entrega (arquivos, APIs, tipos, schema)
  };
  expectedFiles: string[];         // escopo: detecção de conflito, sparse checkout
  complexity: 'low' | 'medium' | 'high';
  specialty?: string;              // "python", "sql", "frontend"... escolhe plugins e Executor
  timeoutMin: number;
  acceptanceCriteria: string[];
}
```

O Diretor executa o DAG em ordem topológica e libera em paralelo o que não tem dependência pendente, **limitado pelo controle de admissão** (5.9).

**Validação do roteiro** antes de executar, em código:
- DAG sem ciclos;
- contratos referenciados existem;
- duas demandas paralelas não declaram o mesmo arquivo em `expectedFiles`.

Se falhar, o roteiro volta ao Roteirista sem gastar Atores.

### 5.5 Workspace (git)

Wrapper fino em TS sobre `git worktree` e `gh`. Padrões emprestados do **ccmanager** (MIT, TS): arquivo `.worktreeinclude` para copiar `.env` e arquivos não versionados para a worktree, e hooks pós-criação.

**Branches:**
- a peça cria `play/<id>` a partir da branch base do projeto;
- cada tentativa ganha worktree + branch `play/<id>/<demand>/<attempt>`;
- a base dessa branch é `play/<id>`, ou a branch aprovada da dependência quando o contrato exige o código dela;
- se a dependência for refeita, as dependentes são rebaseadas ou refeitas (decisão do Diretor, registrada como evento).

**Commit de segurança:** no timeout, cancelamento ou interrupção, o daemon faz um commit WIP automático da worktree. É isso que permite "outro Ator terminar" o trabalho e a retomada após reinício. Desde a v0.10 há também checkpoints periódicos e política de retomada por causa: ver 5.16.

**`INTEGRATING`:**
- as branches das demandas concluídas entram em `play/<id>/integration`, em ordem topológica;
- o Crítico avalia **o trabalho combinado**, e os testes rodam sobre o código integrado;
- conflito de merge = falha de roteiro.

**`DELIVERING`:** PR de `play/<id>/integration` para a base (`gh pr create`), ou merge direto se a política do projeto permitir.

**Política de entrega** (decidido em 2026-11-14, N5). É a chave `delivery.mode`, com valor global e override por projeto, por peça e por tarefa agendada. O padrão é `pr`.

```yaml
delivery:
  mode: pr                     # pr | direct_merge | ask
  allow_direct_merge: false    # só no projeto; sem ela, direct_merge e ask viram pr
```

- `pr`: abre o PR e para ali. É o padrão.
- `direct_merge`: faz o merge na base. Só vale se o projeto tiver `allow_direct_merge: true` **e** a peça ou a tarefa pedir.
- `ask`: o Diretor pergunta ao Produtor, em DELIVERING, se abre PR ou faz merge. Sem ninguém olhando (tarefa agendada), vira `pr`.
- O PR e o evento de entrega registram o modo usado e quem o pediu.

**Limpeza:** worktrees de tentativas descartadas são removidas; as aprovadas, depois da entrega.

**Dependências:** caches com hardlink (`pnpm store`, `uv`). Sparse checkout opcional a partir de `expectedFiles`.

### 5.6 Assinaturas e cotas

**Perfil** = diretório isolado (`<data>/profiles/<cliente>/<perfil>/`). O nome do perfil é único dentro do cliente, e o id completo, usado nas chaves de configuração e no nome do Executor (5.7), é `<cliente>/<perfil>` (ex.: `claude-code/empresa`, `opencode/local`; v0.23):

| Cliente | Isolamento | Observações |
|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` (oficial) | No Windows, a credencial fica em `<dir>\.credentials.json`. Uma `ANTHROPIC_API_KEY` presente no ambiente sempre vence, então o daemon remove do ambiente do processo as variáveis que não pertencem ao perfil. |
| Codex | `CODEX_HOME` | Exige `cli_auth_credentials_store = "file"` no `config.toml` do perfil. No modo keyring/auto, a entrada do cofre pode ser compartilhada entre perfis **[a confirmar]**. |
| OpenCode | `XDG_DATA_HOME`/`XDG_CONFIG_HOME` + `OPENCODE_DB` | O isolamento por XDG só tem relatos de terceiros. Testar na Fase 0. |

**API:** a chave vai para o cofre do sistema operacional (`@napi-rs/keyring`; o `keytar` foi arquivado em 2022) e é injetada como variável de ambiente só no processo do Executor.
- Backends: Credential Manager (Windows), Keychain (macOS), Secret Service (Linux).
- **Linux sem Secret Service** (servidor sem interface gráfica, sessão SSH): fallback para um arquivo criptografado com senha mestra, pedida na abertura do daemon, ou chave só em variável de ambiente do serviço. O daemon informa qual backend está em uso, e nunca grava a chave em texto puro.

**Remoção de perfil:**
1. o perfil vai para `draining`: não recebe sessões novas, e as que estão em curso terminam ou voltam à fila;
2. logout;
3. remoção do diretório.

Executores que usavam o perfil ficam `invalid`, sem quebrar as listas dos papéis.

**Sondas de cota** (`QuotaProbe`). São as fontes mais confiáveis encontradas:

| Provedor | Fonte | Dados |
|---|---|---|
| Claude (Pro/Max) | **statusline**: o daemon configura, no `settings.json` de cada perfil, um comando de statusline que grava o JSON recebido em disco | `rate_limits.five_hour` / `seven_day` → `used_percentage`, `resets_at`. Só aparece depois da primeira resposta; janelas podem faltar. |
| Claude (complemento) | evento `rate_limit_event` do Agent SDK no stream | `status`, `resetsAt`, `utilization`. Não documentado oficialmente e com unidades inconsistentes **[a confirmar]**. Só vale se o adaptador repassar o evento. |
| Codex | `codex app-server`: `account/rateLimits/read` e a notificação `account/rateLimits/updated` | Janelas primária e secundária com `usedPercent`, `resetsAt`, `planType`. Um `app-server` leve por perfil, só para sondar, se o `codex-acp` não repassar a informação. Os tipos saem de `codex app-server generate-ts`. |
| MiniMax (Token Plan) | `GET /v1/token_plan/remains` | Janelas de 5 h e semanal. O schema da resposta não é documentado: tratar como frágil. |
| OpenCode | sem API de cota documentada | Contabilidade local (o banco SQLite do próprio OpenCode) + erros de limite. |
| Qualquer um | erro de limite (429 / mensagem) com o horário de reset | Fallback universal. |

- **Histórico de consumo (tokens e custo):** usar o **ccusage** (MIT, TS; cobre Claude, Codex, OpenCode e Gemini a partir dos logs locais, aceita vários `CLAUDE_CONFIG_DIR`) como biblioteca ou CLI. Ele não informa a cota restante, por isso as sondas acima continuam necessárias.
- **Referência de implementação:** o **CodexBar** (MIT, Swift, só macOS/Linux) já lê cota de dezenas de provedores. Serve para consultar como ele obtém cada sinal, não para usar direto no Windows.
- **Estado por perfil:** `ok | near_limit | exhausted(untilReset, cause) | unknown`. A causa é `quota` (cota da assinatura) ou `budget` (teto de gasto em API, abaixo).

#### Custo em moeda

Decidido em 2026-11-14 (era o item 10 da seção 12). Assinatura e API são medidas de jeitos diferentes, e as telas mostram as duas:
- **perfil de API:** custo real em US$, por sessão, peça, Executor, perfil e período;
- **perfil de assinatura:** uso da cota (janelas de 5 h e 7 dias, com o reset) e, ao lado, o **equivalente em API**: quanto o mesmo consumo custaria pelos preços de API, calculado dos tokens. É uma estimativa para comparar contas, não uma cobrança.

**Fonte do valor:** o custo que o próprio cliente informa, quando existe (no Claude Code, a métrica `claude_code.cost.usage` do OTel, 5.11); senão, tokens × a tabela de preços `pricing`, que vem com cada versão do OTheater e pode ser sobrescrita na configuração. O evento de consumo (`usage.*`) grava a fonte (`client` ou `pricing_table`) e a versão da tabela.

```yaml
usage:
  subscription_display: quota_and_equivalent   # quota_and_equivalent | quota | prorated
  cost_source: client_then_pricing              # client_then_pricing | pricing_table | provider_billing
pricing:                       # sobrescreve a tabela da versão; US$ por milhão de tokens
  minimax-m2: { input_per_mtok: <US$>, output_per_mtok: <US$> }
```

- `quota` mostra só a cota; `prorated` divide a mensalidade do plano, informada no perfil (`monthly_price_usd`), pelo uso do mês.
- `pricing_table` usa sempre a tabela; `provider_billing` consulta a API de uso ou faturamento do provedor, que chega com atraso e não existe em todos **[a confirmar por provedor]**.
- A tabela de preços precisa de revisão a cada versão, porque os preços mudam. Se um modelo não tem preço na tabela, o custo fica `unknown` e a tela avisa.

#### Teto de gasto em API

Decidido em 2026-11-14 (era o item 21 da seção 12). Cada comportamento é uma chave de configuração.

```yaml
profiles:
  opencode/minimax-api:
    budget:
      daily_usd: 20            # opcional; sugerido pelo assistente
      monthly_usd: 200         # opcional; sugerido pelo assistente
      warn_at: [0.8]           # avisos, em fração do teto
      on_exceeded: skip        # skip | wait | ask
      in_flight: handoff       # handoff | finish | stop
```

- **Onde fica:** no perfil de API, com teto por dia e por mês, os dois opcionais. Um Executor pode ter um teto menor (`executors.<nome>.budget`), dentro do teto do perfil. O orçamento por execução das tarefas agendadas (5.15) continua valendo; vale sempre o mais restritivo.
- **Primeira execução:** ao encontrar uma chave de API, o assistente de configuração (5.7) sugere US$ 20 por dia e US$ 200 por mês, e o Produtor confirma ou muda antes de a chave entrar nas listas (5.7).
- **Aviso:** em 80% do teto do dia ou do mês, mensagem de sistema no chat e notificação nas interfaces. `warn_at` aceita uma lista, como `[0.5, 0.8]`.
- **Sessões novas ao estourar** (`on_exceeded`):
  - `skip` (padrão): o perfil fica `exhausted` com causa `budget` até virar o período, e a seleção segue para o próximo Executor da lista. Sem nenhum disponível, vale o `when_exhausted` do papel;
  - `wait`: o papel espera virar o período, sem usar outro Executor;
  - `ask`: o Diretor pergunta se aumenta o teto, pula ou espera. Sem ninguém olhando, vira `skip`.
- **Sessão em curso ao estourar** (`in_flight`):
  - `handoff` (padrão): igual a cota esgotada (5.16). A sessão é interrompida e passa o bastão para o próximo Executor, sem contar como tentativa;
  - `finish`: termina a sessão atual, e o teto só barra as novas. Pode passar um pouco do teto;
  - `stop`: para e pergunta ao Produtor. Sem ninguém olhando, passa o bastão.
- **Período:** o dia e o mês seguem o fuso do daemon e viram à meia-noite e no dia 1 (aprovado pelo dono em 2026-11-14).
- **Medição:** o gasto é somado a cada evento de consumo. Como o custo de uma chamada só se conhece depois dela, o teto pode passar pelo custo da última chamada.

#### Retomada quando a cota ou o teto voltam

Decidido em 2026-11-14, a pedido do dono: o trabalho e as tarefas recorrentes continuam até o fim, sem o Produtor precisar relançar nada. Quando a cota de um perfil esgota ou o teto estoura, o daemon grava no store um **despertar** (tabela `wakeups`, seção 7) com o horário em que o perfil volta: o `resetsAt` da sonda de cota ou a virada do dia ou do mês do teto. Sem horário conhecido, o daemon volta a consultar o perfil de tempos em tempos.

**Consulta sem horário de reset** (decidida em 2026-11-14, com a ressalva do dono de que não gaste tokens e seja ajustável):
- a consulta só usa sinais que não chamam o modelo: a sonda de cota do provedor (`account/rateLimits/read` do Codex, `token_plan/remains` da MiniMax) ou a leitura do último JSON da statusline do Claude. Nunca manda prompt de teste;
- o intervalo é a chave `quota.recheck_every`, com padrão `15m`; `off` desliga a consulta;
- o provedor que não tem sinal sem custo (o Claude, cuja statusline só se atualiza depois de uma resposta, e o OpenCode) não é consultado. Passado o intervalo, o perfil vai de `exhausted` para `unknown`, e a próxima sessão real que a seleção mandar para ele serve de teste: se der erro de limite, ele volta a `exhausted` com o reset informado no erro **[proposta]**.

```yaml
quota:
  recheck_every: 15m           # só sinais sem custo de tokens; off desliga
```


No horário do despertar:
1. o perfil volta a `ok`, com o evento `quota.restored` ou `budget.restored`;
2. as tentativas em `AWAITING_RESUME` que esperavam aquele perfil retomam (5.16);
3. as demandas na fila sem Executor disponível passam de novo pela seleção (5.7);
4. as tarefas agendadas adiadas por cota (`quota_exhausted: postpone`, 5.15) rodam.

- Os despertares ficam no SQLite e sobrevivem a reinício e queda (5.21). Com a máquina desligada ou o daemon parado no horário, rodam na subida, pela reconciliação.
- Se a máquina puder estar dormindo no horário, o daemon usa o mesmo gatilho do sistema operacional que o agendador usa para acordá-la (5.15).
- Uma sessão que já passou o bastão para outro Executor não volta ao anterior quando ele se recupera, como as ordens não mudam sessões em curso (5.17).

### 5.7 Seleção de Executor

Configuração por papel: lista ordenada de Executores + regra quando ninguém está disponível. **Todos os papéis** têm a lista (Diretor, Consultor, Autor, Revisor, Roteirista, Crítico e Atores), e ela é a cadeia de fallback: quando o primeiro não tem assinatura com cota nem chave de API disponível, vale o seguinte. Tudo é ajustável na configuração (decidido em 2026-11-14).

**Nome do Executor** (decidido em 2026-11-14, revisto no mesmo dia na v0.23): sempre `<modelo>-<esforço>@<cliente>/<perfil>`. O `<modelo>-<esforço>` vem primeiro porque o papel é desempenhado pelo conjunto modelo + esforço. O prefixo do modelo é a família: os modelos do Claude levam `claude-`, como os do Codex levam `codex-`, para os nomes ficarem consistentes: `claude-opus-high`, `claude-sonnet-medium`, `claude-haiku-low`, `codex-sol-high`, `codex-luna-low`, `minimax-m2-medium`, `gemma4-low`. O sufixo `@<cliente>/<perfil>` vai em todos os Executores, mesmo com uma conta só: o cliente diz quem executa e o perfil diz a conta, que é única dentro de cada cliente (decisão do dono; era o item 22 da seção 12). Assim o mesmo modelo e esforço não colide nem entre contas nem entre clientes: `claude-opus-high@claude-code/empresa`, `claude-opus-high@claude-code/pessoal`, `claude-opus-high@opencode/anthropic-api`, `codex-sol-high@codex/conta-1`, `gemma4-low@opencode/local`. O cliente entrou no nome na v0.23 porque o OpenCode também pode chamar modelos do Claude e do GPT por chave de API ou gateway (a lista local do `opencode models`, versão 1.19.5, traz `opencode/claude-opus-5-5`; verificado localmente), e o nome sem o cliente esconderia quem executa. Os nomes `gpt-6-sol` e `gpt-6-luna` vêm do cache de modelos do Codex citado na documentação do `okit` (fonte secundária) e o nome atual do modelo da MiniMax também está **[a confirmar]** na Fase 0.

```yaml
executors:
  claude-haiku-low@claude-code/empresa:     { client: claude-code, profile: empresa,       model: haiku,                     effort: low }                       # provider: anthropic (fixo pelo cliente)
  claude-opus-high@opencode/anthropic-api: { client: opencode,    profile: anthropic-api, model: anthropic/claude-opus-5-5, effort: high, provider: anthropic } # chave de API; id do modelo [a confirmar]
  codex-luna-low@codex/conta-1:             { client: codex,       profile: conta-1,       model: gpt-6-luna,                effort: low }                       # [a confirmar]; provider: openai (fixo pelo cliente)
  gemma4-low@opencode/local:                { client: opencode,    profile: local,         model: gemma-4-26b-a4b,           effort: low,  provider: google }    # cadastrado no assistente
```

- **Interfaces:** onde faltar espaço (a TUI, o celular), a tela pode mostrar só o `<perfil>`, pôr o cliente numa coluna à parte, como ícone ou abreviado (`cc/empresa`, `cx/conta-1`, `oc/local`, como no mockup da TUI), mas o nome guardado e o dos eventos é sempre o completo **[proposta]**.
- **Cliente cruzado** (decidido em 2026-11-14, v0.23): com assinatura, cada família só roda pelo seu cliente oficial (Claude pelo Claude Code, GPT pelo Codex); com chave de API ou gateway, qualquer cliente que suporte o modelo pode executá-lo (ex.: `claude-opus-high@opencode/anthropic-api`). O que os termos de cada provedor permitem não é afirmado aqui: fica **[a confirmar]** na Fase 0, com fonte e data.

```yaml
executors:
  cross_client: api_only   # api_only | off | any
```

  - `api_only` (padrão): o daemon aceita um modelo fora do cliente oficial só num perfil de chave de API ou gateway;
  - `off`: cada família só pelo seu cliente oficial, com ou sem API;
  - `any`: sem verificação; vale o que o cliente aceitar.
- **Esforço que o adaptador não expõe:** o nome guarda o esforço pedido, e vale o fallback do adaptador (abaixo). Se o OpenCode expõe esforço para o Gemma 4 e o MiniMax está **[a confirmar]**.

**Primeira execução e assistente de configuração** (decidida em 2026-11-14, item 8 da seção 12; forma revista no mesmo dia na v0.23, a pedido do dono):
- **`ot init` mínimo:** instala o daemon como serviço de logon (Fase 10), sobe o daemon e abre a TUI direto no assistente, sem nenhuma pergunta no terminal. Motivo do dono, pela experiência no `okit-plugin`: setup por script é propenso a falhas e costuma ficar complexo, então a parte complexa vai para o assistente;
- **lógica no daemon:** o assistente é um fluxo de passos do daemon, exposto pela API (5.12). Cada passo guarda o estado no store, é validado antes de seguir e pode ser retomado depois de fechar a TUI ou de o daemon reiniciar. Nada entra na configuração antes da confirmação final, que grava tudo de uma vez **[proposta]**;
- **as interfaces só desenham:** na v1, a TUI (Fase 7); a web e o app (Fases 12 e 14) mostram o mesmo assistente pela mesma API, sem lógica própria;
- **reuso:** o mesmo mecanismo serve, depois da primeira execução, para adicionar uma conta, cadastrar um Executor do OpenCode (abaixo) e trocar a predefinição **[proposta]**.

Passos da primeira execução no assistente:
1. detecta os clientes instalados, os logins e as chaves de API; os modelos do Claude Code e do Codex são descobertos sozinhos, e os do OpenCode passam pelo assistente de cadastro (abaixo, "Cadastro dos Executores do OpenCode");
2. aplica a predefinição da chave `roles.preset` e tira da lista os Executores que não existem. A predefinição é escrita em `<modelo>-<esforço>`, sem conta; o assistente troca cada item pelos Executores das contas encontradas que têm aquele modelo, em qualquer cliente que o `executors.cross_client` permita, um por conta, primeiro os do cliente oficial e depois os outros, na ordem das contas que o Produtor confirmar (ex.: `claude-opus-high` vira `claude-opus-high@claude-code/empresa, claude-opus-high@claude-code/pessoal`, e `claude-opus-high@opencode/anthropic-api` se houver esse perfil) **[proposta]**;
3. acrescenta ao fim da lista de cada papel o Executor por API que encontrar (ex.: `minimax-m2-medium@opencode/minimax-api`), com o teto de gasto que o Produtor confirmar (5.6). Sem chave de API, a lista fica como está e vale o `when_exhausted` do papel;
4. mostra o resultado, e o Produtor confirma ou ajusta; só então a configuração é gravada.

Predefinição padrão, `quality`, depois da primeira execução numa máquina com as contas `claude-code/empresa`, `codex/conta-1`, `opencode/minimax-api` e `opencode/local`:

```yaml
roles:
  preset: quality              # quality | balanced | economical
  director:     { executors: [claude-haiku-low@claude-code/empresa, codex-luna-low@codex/conta-1, gemma4-low@opencode/local, minimax-m2-medium@opencode/minimax-api] }
  consultant:   { executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1, minimax-m2-medium@opencode/minimax-api] }   # Ator forte do chat (5.20)
  author:       { executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1, minimax-m2-medium@opencode/minimax-api] }
  reviewer:     { executors: [codex-sol-high@codex/conta-1, claude-opus-high@claude-code/empresa, minimax-m2-medium@opencode/minimax-api] }
  scriptwriter: { executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1, minimax-m2-medium@opencode/minimax-api] }
  critic:       { executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1, minimax-m2-medium@opencode/minimax-api], when_exhausted: wait }
  actor:        { executors: [codex-sol-high@codex/conta-1, claude-sonnet-medium@claude-code/empresa, minimax-m2-medium@opencode/minimax-api], when_exhausted: next }

selection:
  cross_check: prefer_other_provider   # prefer_other_provider | require_other_provider | other_model | off
```

A tabela das predefinições usa os nomes sem conta, como elas são escritas:

| Papel | `quality` (padrão) | `balanced` | `economical` |
|---|---|---|---|
| Diretor | `claude-haiku-low`, `codex-luna-low`, `gemma4-low` | igual | igual |
| Consultor | `claude-opus-high`, `codex-sol-high` | igual **[proposta]** | `claude-sonnet-high`, `codex-sol-medium` **[proposta]** |
| Autor | `claude-opus-high`, `codex-sol-high` | `claude-sonnet-high`, `codex-sol-medium` | `claude-sonnet-medium`, `codex-sol-medium` |
| Revisor | `codex-sol-high`, `claude-opus-high` | `codex-sol-medium`, `claude-sonnet-high` | `codex-sol-medium`, `claude-sonnet-medium` |
| Roteirista | igual ao Autor | igual ao Autor | igual ao Autor |
| Crítico (`wait`) | `claude-opus-high`, `codex-sol-high` | `claude-opus-high`, `codex-sol-high` | `claude-sonnet-high`, `codex-sol-medium` |
| Atores (`next`) | `codex-sol-high`, `claude-sonnet-medium`, `minimax-m2-medium` | `claude-sonnet-medium`, `codex-sol-medium`, `minimax-m2-medium` | `minimax-m2-medium`, `gemma4-medium`, `claude-sonnet-medium` |

- A `balanced` deixa o Opus só onde decide a qualidade; a `economical` poupa as assinaturas e usa API barata e modelo local. O modelo local entra como Ator limitado pelos slots da instância (5.9, decidido em 2026-11-14, v0.23). O primeiro item de cada lista de `balanced` e `economical` veio da pergunta ao dono; os seguintes, que dão a troca de provedor, são **[proposta]**.
- O Diretor usa esforço `low` nas três: ele só encaminha e chama ferramentas MCP. Pode ser mudado na configuração.
- A chave individual de um papel (`roles.author.executors`, ...) prevalece sobre a predefinição.

**Revisão cruzada** (`selection.cross_check`, decidida em 2026-11-14): o Revisor e o Crítico pulam os Executores do mesmo provedor de quem fez o trabalho (o Autor, no plano; o Ator, no código) e voltam a ele se não houver outro disponível (`prefer_other_provider`, padrão). Os outros modos:
- `require_other_provider`: sem outro provedor, esperam;
- `other_model`: basta outro modelo, mesmo do mesmo provedor;
- `off`: só a ordem da lista.
O pulo entra no evento `executor.selected`, como os outros.

**Provedor de um Executor** (decidido em 2026-11-14, v0.23): na revisão cruzada, o provedor é a **família do modelo**, quem o treinou, e não o cliente nem a conta. O Gemma 4 conta como `google` mesmo servido pelo OpenCode numa instância local; o `minimax-m2` conta como `minimax`; o Haiku e o Sonnet contam como `anthropic`. Assim, um Revisor Gemma 4 local é de outro provedor em relação a um Autor Opus, e um Gemma 4 local e um Gemini na nuvem são do mesmo provedor.
- o campo `provider` do Executor define o provedor. No Claude Code e no Codex, ele é fixo pelo cliente (`anthropic`, `openai`) e entra sozinho na descoberta automática dos modelos;
- no OpenCode, o prefixo do modelo é a conta ou o gateway por onde ele é chamado, não quem o fez: `opencode/claude-opus-5-5` é da Anthropic pelo gateway do OpenCode, e um Gemma 4 pode vir de `google/`, de `openrouter/` ou de uma instância local (verificado localmente em 2026-11-14 com o `opencode models`, versão 1.19.5). Por isso o `provider` não é inferido pelo nome: ele vem do cadastro abaixo;
- sem `provider`, o Executor fica com `unknown`, que a revisão cruzada trata como diferente de todos, e a interface pede ao Produtor que o preencha **[proposta]**;
- o provedor da conta (coluna `provedor` de `profiles`, seção 7) continua servindo para a cota e o custo; ele pode ser diferente do provedor do modelo (ex.: um perfil OpenCode com chave da OpenRouter que serve um modelo da Anthropic).

**Cadastro dos Executores do OpenCode** (decidido em 2026-11-14, v0.23, a pedido do dono; contrato no `ModelCatalog` do `ClientAdapter`, 5.2): a descoberta automática fica para o Claude Code e o Codex, cujos modelos são bem documentados. Como o OpenCode chama muitos provedores e modelos, locais ou não, o Produtor cadastra os Executores dele num **assistente**, na primeira execução e depois na área de configuração (o mesmo mecanismo de assistente do daemon, acima), e o daemon só valida:
1. o assistente lê `opencode models --verbose` no diretório do perfil. A saída traz, por modelo, `providerID`, `family`, `api.url`, `cost`, `capabilities` (`toolcall`, `attachment`, `reasoning`) e `variants` (os esforços `low`, `medium`, `high`) (verificado localmente em 2026-11-14, versão 1.19.5);
2. o Produtor escolhe o modelo, e o assistente pré-preenche: o esforço (entre as variantes), a família do modelo (`provider`, a partir de `family`), se é local (pela `api.url` em `localhost` ou `127.0.0.1`, o que cria o bloco `local` do perfil, 5.9) e o custo (para a tabela `pricing`, 5.6);
3. o Produtor confirma ou corrige cada campo. Em modelo local configurado à mão no OpenCode, a `family` pode vir vazia ou pouco confiável **[a confirmar na Fase 0]**, e o campo fica para ele;
4. o daemon valida: o modelo existe na lista, o esforço está entre as variantes e o modelo chama ferramentas (`toolcall`). Depois roda uma **sessão de teste** curta, em que o modelo precisa chamar uma ferramenta e entregar um `submit` válido contra o schema (v0.24, abaixo, "Capacidade mínima por papel"). A capacidade `attachment` alimenta o filtro de anexos (5.20). Um Executor que deixa de passar na validação (modelo retirado, perfil sem login) muda o estado de validade (seção 7) e sai da seleção.

O que foi cadastrado vai para a chave `executors`, editável à mão; o assistente é só a forma guiada de preenchê-la.

**Depois do cadastro** (decidido em 2026-11-14, v0.23): o Executor fica disponível para **qualquer papel**. O catálogo não tem restrição por papel, e ele aparece como opção em todas as listas, na configuração e nas ordens do Produtor (5.17). Entrar na lista de um papel é outra coisa, e não acontece sem o Produtor ver:

```yaml
executors:
  on_register: ask   # ask | preset_only | none
```

- `ask` (padrão): o assistente termina perguntando em quais papéis e em que posição colocar o Executor. Vêm marcados os papéis cuja predefinição atual (`roles.preset`) já cita aquele `<modelo>-<esforço>` (ex.: `gemma4-medium` nos Atores da `economical`), e os outros vêm desmarcados;
- `preset_only`: entra sem perguntar, só onde a predefinição cita o modelo, na posição que ela dá;
- `none`: fica só no catálogo, até o Produtor acrescentá-lo a uma lista.

Vale para os Executores do OpenCode e também para os descobertos sozinhos no Claude Code e no Codex depois da primeira execução (um modelo novo, uma conta nova). Na seleção continuam os filtros de capacidade (anexos, 5.20; `toolcall`, na validação) e entra a capacidade mínima do papel (abaixo). O OTheater não roda modelos locais por código próprio: eles passam pelo OpenCode, como os outros, por ACP (P1, decisão do dono no mesmo dia).

**Capacidade mínima por papel** (decidida em 2026-11-14, v0.24, item 23 da seção 12): **todos os papéis aceitam modelo local**. Não há proibição por localização; o que separa um Executor de um papel é a capacidade, e o mesmo mínimo vale para modelo local e na nuvem. Os critérios:
- **chamada de ferramentas** (`toolcall`): obrigatória em todos os papéis, como já era na validação do cadastro;
- **janela de contexto:** num modelo local, vale a janela **por slot**, lida da instância pela porta `LocalModelServer` (5.9); nos outros, o valor do catálogo (`limit.context` no `opencode models --verbose`; no Claude Code e no Codex, o do `ModelCatalog`). O prompt de sistema e as ferramentas do cliente ocupam parte da janela, e por isso os mínimos têm folga **[hipótese]**;
- **raciocínio** (`capabilities.reasoning`): exigido nos papéis que decidem, o Consultor, o Autor, o Revisor, o Roteirista e o Crítico; o Diretor e os Atores não exigem;
- **sessão de teste no cadastro:** o assistente roda uma sessão curta em que o modelo chama uma ferramenta e entrega um `submit` válido contra o schema. Quem não passa fica marcado, e não excluído, conforme a chave `roles.capability_check` (abaixo). Vale para o cadastro do OpenCode e para os Executores descobertos sozinhos no Claude Code e no Codex **[proposta]**.

```yaml
roles:
  capability_check: warn        # warn | block | off
  director:     { requires: { context: 32k } }
  consultant:   { requires: { context: 128k, reasoning: true } }
  author:       { requires: { context: 128k, reasoning: true } }
  reviewer:     { requires: { context: 128k, reasoning: true } }
  scriptwriter: { requires: { context: 128k, reasoning: true } }
  critic:       { requires: { context: 128k, reasoning: true } }
  actor:        { requires: { context: 64k } }
```

- os mínimos de contexto padrão são **32k** para o Diretor, **64k** para os Atores e **128k** para o Consultor, o Autor, o Revisor, o Roteirista e o Crítico (escolha do dono; os números são **[proposta]** até a medição da Fase 0). Os nomes das chaves (`requires`, `context`, `reasoning`) são **[proposta]**; os nomes dos papéis seguem as chaves de `roles` (5.22);
- `requires` pode ser mudado por cenário e por tarefa agendada, como o resto de `roles` (abaixo, "Configuração dos papéis por cenário");
- `warn` (padrão): o assistente e a configuração aceitam um Executor abaixo do mínimo, com aviso, e ele aparece marcado na lista do papel (na TUI, um sinal ao lado do nome, com o motivo: janela, raciocínio ou sessão de teste). A escolha fica com o Produtor;
- `block`: o assistente e a configuração recusam o Executor naquele papel, e uma lista escrita à mão com ele falha na validação da configuração;
- `off`: sem verificação de capacidade, só a do `toolcall`;
- em qualquer modo, a seleção pula o Executor quando o prompt da demanda não cabe na janela dele (passo 1 do algoritmo, abaixo). É uma checagem por demanda, não pelo mínimo do papel.

Algoritmo, para cada demanda ou etapa:
1. percorre a lista na ordem. Um Executor é **disponível** quando:
   - o perfil está saudável;
   - a cota não está esgotada nem o teto de gasto em API estourou (5.6);
   - há vaga no pool;
   - o controle de admissão permite;
   - o prompt da demanda, com a folga do cliente, cabe na janela de contexto do Executor (no modelo local, a janela por slot) (v0.24) **[proposta]**;
2. pega o primeiro disponível;
3. se ninguém estiver disponível:
   - `next`: espera o primeiro da lista que liberar;
   - `wait`: aguarda o reset do primeiro da lista, sem rebaixar;
4. **retry com diversidade:** a nova tentativa de uma demanda que falhou começa pelo Executor seguinte ao da tentativa anterior;
5. o motivo da escolha vira evento (`executor.selected`, com os Executores pulados e por quê).

**Configuração dos papéis por cenário** (decidido em 2026-11-14, v0.23; antes só havia o override por projeto). A chave `roles` segue a regra geral da configuração (5.20): valor global, com override em cada cenário (projeto, tarefa ou chat) e em cada tarefa agendada (5.15). O override é **por papel**:

```yaml
# configuração de um cenário (ou de uma tarefa agendada); tudo é opcional
roles:
  preset: economical                     # troca a base de todos os papéis neste cenário
  author: { executors: [claude-opus-high@claude-code/empresa], when_exhausted: wait }   # substitui só este papel
  allowed_profiles: [claude-code/empresa, codex/conta-1]   # só restringe contas, como o antigo override por projeto [proposta]
```

- a lista de um papel dada no cenário **substitui** a global só para aquele papel; os papéis não citados continuam com a global e recebem as mudanças feitas nela depois;
- `preset` no cenário troca a base de todos os papéis; o daemon expande a predefinição pelas contas existentes, como na primeira execução (passo 2 acima), e as listas dadas por papel no cenário prevalecem sobre ela **[proposta]**;
- `allowed_profiles` tira da lista final as contas fora dela (ex.: só o plano da empresa num projeto da empresa) e vale depois da expansão **[proposta]**;
- **precedência:** tarefa agendada > cenário > global. Uma ordem `rule` vigente (5.17) vale por cima da configuração do seu escopo, durante a vigência;
- as sessões em curso não mudam com uma alteração da configuração, como acontece com as ordens (5.17);
- a página de configuração do cenário mostra, por papel, se a lista é local ou herdada da global, com um atalho para voltar à herdada **[proposta]**.

**Esforço:** abstrato na configuração (`low | medium | high`). Aplicado pela config option `thought_level`/`model_config` que o adaptador anuncia (5.2), com fallback por adaptador.

**Outros provedores dentro do Claude Code:**
- **MiniMax:** endpoint oficial compatível com Anthropic (`https://api.minimax.io/anthropic`, `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` no perfil). Conferir o nome atual do modelo.
- **Gateway único (opcional):** **LiteLLM** para outros provedores por API e modelos locais, com o endpoint `/v1/messages` e `ANTHROPIC_BASE_URL`.
- **claude-code-router** é alternativa, com relatos conflitantes sobre a compatibilidade com o Claude Code 2.x **[a confirmar]**.

**Modelo local:**
- usar **Gemma 4** (26B-A4B MoE ou 31B, Apache-2.0, chamada de ferramenta nativa), não Gemma 3 27B, que tem chamada de ferramenta fraca;
- servidor: **llama.cpp com `--jinja`** ou Ollama (que tem API compatível com Anthropic). Há relatos de chamada de ferramenta quebrada em uma versão do Ollama;
- para modelo local, o OpenCode tende a ser um harness melhor que o Claude Code, cujas definições de ferramenta ocupam cerca de 11 mil tokens e que pede contexto de 64 mil ou mais.

### 5.8 Permissões (bloquear tudo, liberar o necessário)

Divisão:

| Categoria | Tratamento |
|---|---|
| Ler, buscar e editar arquivos | Ferramentas **nativas** do cliente (os modelos são treinados nelas), confinadas à worktree |
| Shell, testes, build, git, rede, banco, deploy | Nativo **bloqueado**; só pelas cascas do framework |
| Plugins | Servidor MCP + manifesto com permissões declaradas |

Três camadas:

**1. Configuração do cliente** — gravada por `prepareProfile` no diretório do perfil a cada mudança de política.
- **Claude Code:**
  - `--tools` / `tools` restringe quais ferramentas **existem**; `--allowedTools` só dispensa o pedido de permissão;
  - regras `deny` (avaliadas antes de `ask` e `allow`);
  - modo **`dontAsk`** para Executores headless: nega tudo que pediria permissão;
  - `--strict-mcp-config` com só os MCPs do papel;
  - `disableBypassPermissionsMode`;
  - **Atenção:** as regras de deny para Bash não pegam o mesmo programa chamado por caminho ou dentro de `sh -c`. Por isso o Bash nativo é removido (`tools`), não apenas filtrado. Pelo ACP, as flags chegam via settings do perfil e opções do adaptador; confirmar o mecanismo na Fase 0.
- **OpenCode:** allow/ask/deny com padrões, com a última regra que casar vencendo, e overrides por agente.
  - Na V2, `bash` virou `shell` e `external_directory` vem liberado por padrão: negar explicitamente.
  - Fixar a versão.
- **Codex:** `sandbox_mode`, `approval_policy` e habilitação de ferramentas por servidor MCP, selecionáveis pelo `codex-acp`. O shell faz parte do núcleo do Codex, então ali a contenção vem do sandbox:
  - no Windows 11 24H2+, **MXC** (isolamento nativo, sem admin);
  - fora disso, o modo `elevated` (exige configuração com admin).

**2. ACP:** os `session/request_permission` são respondidos pelo daemon conforme a política do papel, automaticamente, sem perguntar a ninguém.

**3. Sistema operacional:** a única camada que é fronteira de segurança de fato.

| Plataforma | Recurso |
|---|---|
| Todas | Worktree como `cwd` + Job Object / grupo de processos |
| macOS/Linux | **`@anthropic-ai/sandbox-runtime`** (Apache-2.0; Seatbelt / bubblewrap) para o processo do Executor: rede negada por padrão com lista de domínios, escrita restrita |
| Windows | O `sandbox-runtime` está em **alpha** (usuário local dedicado + filtro WFP, instalação com admin). Pilotar na Fase 0. Base sem ele: usuário Windows de baixo privilégio com ACL só na worktree, mais o sandbox do próprio Codex. **O Claude Code nativo no Windows roda comandos sem sandbox** (WSL2 é a alternativa), mais um motivo para remover o Bash dele. |

**Cascas** (`tools/`):
- estreitas e tipadas;
- shell só por `argv`, com lista de comandos permitidos (sem `;`, `|`, `&&`);
- caminhos normalizados e presos à worktree (rejeitar `..` e symlinks que saem dela);
- domínios permitidos em `http_get`;
- timeout e saída truncada;
- toda chamada gera evento, passa pelos semáforos e conta para o consumo.

### 5.9 Recursos e memória (RAM)

**Plugins MCP compartilhados.** Cada plugin roda **uma vez**, e o daemon agrega todos:
1. sobe um cliente MCP SDK v2 por plugin (stdio ou HTTP);
2. junta as ferramentas;
3. as expõe pelo mesmo servidor do framework, com o filtro por papel na fábrica (5.3).

O desenho de filtro por tags do **1MCP** (`@1mcp/agent`) é a referência. O agregador é próprio (algumas centenas de linhas sobre o SDK MIT). O 1MCP só entra como sidecar se a licença dele estiver na lista permitida da seção 6.0 **[a confirmar]**.

**Controle de admissão:**
- semáforo de Executores calculado por RAM livre, vagas e cota;
- no Claude Code, o custo é por sessão (um `claude` por sessão).

**Semáforo de comandos pesados** (build, suíte de testes, instalação de dependências), separado: `run_tests` e `install_deps` entram nessa fila.

**Lançador com Job Object (Windows).** Não há pacote npm mantido para isso, e o Node não cria processos suspensos. Associar o processo ao job depois do spawn deixa uma janela em que netos escapam. Solução: um **lançador mínimo em Rust** (crate `win32job`, MIT/Apache) que:
1. cria o job (limite de memória + `KILL_ON_JOB_CLOSE`);
2. inicia o Executor suspenso;
3. associa o processo ao job e o retoma.

O daemon guarda o handle. Alternativa sem Rust: `koffi` (FFI), aceitando a janela.

**Fallback de kill:** `execa` 10 com `killDescendants` (no Windows, `taskkill /T /F` enquanto a árvore existe).

**Modelo local** (decidido em 2026-11-14, v0.23; antes dizia "não para Atores em paralelo", o que contradizia a predefinição `economical`):
- uma instância compartilhada por perfil (llama.cpp com `--parallel` ou Ollama), com poucos slots;
- serve ao Diretor, aos julgamentos curtos e também a Atores e outros papéis, desde que haja slot livre;
- os slots são a vaga do pool desse perfil (5.7): com todos ocupados, o Executor fica indisponível e vale o `next` ou o `wait` do papel;
- uma parte dos slots fica reservada ao Diretor, para ele não ficar sem resposta quando Atores locais ocupam a instância;
- a memória do modelo é da instância, não de cada sessão: o semáforo de RAM conta o processo do cliente (`opencode acp`) por sessão e a instância uma vez só.

```yaml
profiles:
  opencode/local:
    local:
      server: llama-cpp         # llama-cpp (v1) | ollama (depois) — adaptador de LocalModelServer
      url: http://127.0.0.1:8080
      slots: auto               # auto (lê da instância) | <número>
      reserve_for_director: 1   # 0 | <número> | all (só o Diretor usa)
      reserve_when: listed      # listed (só se o perfil estiver na lista do Diretor) | always | never
```

- a instância é vista pela porta `LocalModelServer` (5.18), com um adaptador por servidor: `llama-cpp` na v1 e `ollama` depois. O bloco `local` do perfil ganha a chave `server: llama-cpp` (ou `ollama`), que escolhe o adaptador **[proposta]**;
- a janela de contexto que vale para a capacidade mínima do papel (5.7) é a **por slot**: no llama.cpp, o contexto total (`-c`) é dividido entre os slots de `--parallel`, e o adaptador lê a janela de cada slot da instância **[a confirmar na Fase 0]**. Mais slots significam mais sessões ao mesmo tempo e janela menor em cada uma, e o assistente mostra essa troca ao Produtor **[proposta]**;
- `slots: auto` lê o número de slots pelo adaptador: no llama.cpp, pelo `/props` ou `/slots` do servidor; no Ollama, pela variável `OLLAMA_NUM_PARALLEL` **[a confirmar na Fase 0]**. Sem leitura possível, vale 1 e o assistente de configuração pede o número ao Produtor **[proposta]**;
- `reserve_for_director: all` volta ao comportamento antigo (só o Diretor e julgamentos curtos);
- os valores padrão `1` e `listed` são **[proposta]**; a escolha das chaves foi do dono.

**Daemon e UI:** eventos vão direto para o SQLite; a UI virtualiza listas e pagina trajetórias.

### 5.10 Contexto (tokens)

- **Ator enxuto:** o prompt inicial tem regras do projeto + ordens vigentes (5.17) + papel + contrato da demanda + caminho da worktree. Usar `systemPrompt` do `session/new` quando o adaptador anunciar suporte.
- **Blackboard** no store: plano, roteiro, contratos e decisões. Lido sob demanda (`read_blackboard`, `read_contract`), nunca colado inteiro.
- **Artefatos por referência:** caminho, id, hash.
- **Saída estruturada:** o Executor termina com `submit(result)` (o que fez, arquivos tocados, testes, pendências). O Crítico lê diff integrado + resultados, não trajetórias.
- **Prompt caching:**
  - prefixo estável igual para todos os Executores do mesmo papel e projeto, nesta ordem: regras → ordens → papel → contratos. O início, o fim, a revogação ou a suspensão de uma ordem mudam o prefixo das sessões seguintes, não o das sessões em curso;
  - a parte variável vai no fim;
  - opcional: aquecer o cache com o primeiro Ator antes de liberar os demais.
- **Orquestrador sem memória própria:** sempre `next_action` / `status`.

### 5.11 Observabilidade

**Log de eventos** (tabela `events`, id crescente) é a fonte única. Tipos principais:
- `play.*`, `stage.*`, `demand.*`, `attempt.*`;
- `session.update` (mensagens, tool calls, diffs, plano);
- `executor.selected`, `permission.*`, `tool.called`;
- `quota.*`, `usage.*`, `decision.*`, `chat.*`, `directive.*`, `error.*`.

**OTel nativo dos clientes** (reaproveitado, sem instrumentar nada):
- **Claude Code:** `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*`. Envia métricas (`claude_code.token.usage`, `cost.usage`, ...) e eventos (`api_request`, `tool_result`, `tool_decision`, ...). Traces em beta.
- **Codex:** tabela `[otel]` no `config.toml` do perfil (`otlp-http`).
- O daemon configura os dois, por perfil, para mandarem a **um receptor OTLP do próprio daemon**, com atributos de correlação (id da peça e da tentativa como atributos de recurso). Conteúdo de prompt fica redigido por padrão.

**OTel do daemon:** spans peça → etapa → tentativa → sessão → chamada de ferramenta, seguindo as convenções GenAI de agentes (`invoke_agent`, `execute_tool`; ainda em "Development", então podem mudar).

**ATIF:**
- formato definido pelo **Harbor** (dos criadores do Terminal-Bench), versão atual **ATIF-v1.8**, especificação na RFC 0001 do repositório `harbor-framework/harbor`;
- não há biblioteca TS: escrevemos o schema zod a partir da RFC e um exportador `session.update` → ATIF;
- validação de conformidade com o `TrajectoryValidator` (Python) do próprio Harbor nos testes.

**Visualizador externo opcional:**
- **Arize Phoenix**: processo único, sem Docker, ingere OTLP e importa ATIF. Licença ELv2, source-available: serve para uso local, não para embutir num produto;
- alternativas Apache-2.0 (**OpenLIT**, **Laminar**) exigem Docker + ClickHouse.

O dashboard próprio continua lendo o store.

**Retenção:** chunks de stream compactados em trajetória após o fim da tentativa; política de expurgo configurável.

### 5.12 API do daemon

- **Framework HTTP:** Hono + `@hono/node-server`, validação com zod, contrato compartilhado com o front (`packages/protocol`).
- **REST:**
  - cenários (projetos, tarefas, chats), peças, demandas;
  - assinaturas, executores, papéis, plugins, configuração, ordens (globais e por cenário);
  - assistentes (5.7): iniciar, ler o passo atual, responder, voltar, retomar e confirmar; o estado de cada assistente fica no store **[proposta]**;
  - comandos: pausar, retomar, cancelar Ator, aprovar decisão, responder ao Produtor.
- **SSE:** `/events?scenario=&since=` segue a tabela de eventos, com reconexão por `Last-Event-ID` (histórico, depois ao vivo).
- **WebSocket:** chat com o Orquestrador. A ponte vai para a fila única de prompts (5.4), mais as mensagens de sistema do daemon.
- **Segurança:**
  - `127.0.0.1` por padrão;
  - token obrigatório mesmo em acesso local, com CORS fechado, para que nenhuma página de outra origem comande o daemon;
  - acesso remoto (decidido em 2026-11-14, para o app Android, 5.13): pela **VPN do usuário** (Tailscale, WireGuard ou similar). O daemon nunca fica exposto na internet, e o OTheater não depende de serviço em nuvem próprio;
  - no modo `vpn`, o daemon também escuta no endereço da interface da VPN, com TLS próprio: certificado autoassinado, cuja impressão digital o app fixa no pareamento **[proposta]**;
  - **pareamento por QR:** `ot pair`, ou Configurações → Aparelhos, mostra um QR com o endereço do daemon na VPN, um token só daquele aparelho e a impressão digital do certificado. Cada aparelho pode ser revogado sozinho **[proposta]**;
  - tratar como acesso administrativo.

```yaml
api:
  remote: off           # off | vpn | proxy  [proposta]
  vpn_interface: auto   # auto | nome da interface (por exemplo tailscale0)
```

- `off` (padrão): só `127.0.0.1`;
- `vpn`: também no endereço da VPN, com TLS do daemon e tokens por aparelho; é o modo do app Android;
- `proxy`: só `127.0.0.1`, atrás de um reverse proxy com TLS, para quem já tem um.

**Referências de desenho:** `acpx` (MIT, TS; cliente ACP headless com sessões persistentes e saída NDJSON) e `rivet-dev/agents` (Apache-2.0, TS; agentes de código atrás de uma API HTTP).

### 5.13 Interfaces

**Mockups de referência** (valores ilustrativos):
- `mockup/tui.html`: TUI (interface principal), gerada por `mockup/tui-render.js` (`node tui-render.js`);
- `mockup/app.html`: web e desktop (Fases 12 e 13);
- `mockup/mobile.html`: app Android, celular e tablet em paisagem e retrato (Fase 14).

**Layout comum ao app e à TUI** (decisão de 2026-11-13):
- **Chat em altura total**, sempre visível, com **largura ajustável** (arrastar a borda no app; Ctrl+←/→ na TUI), lembrada entre sessões. Os dados da peça (título, etapa, decisão pendente) ficam no topo do chat.
- **Lateral retrátil** (Ctrl+B) com cenários, assinaturas e a entrada de **Configurações**. Recolhida, vira um trilho com os cenários e as barrinhas de cota.
- **Painel de trabalho em abas que abrem e fecham:** Visão geral, Trajetórias, Consumo, Agenda, Ordens, Configurações e Plugins. Configuração é uma aba, não uma tela que substitui o chat. O painel inteiro fecha com Ctrl+J, e o chat passa a ocupar a largura toda.
- **Tudo recolhe, menos o chat:** seções da lateral e cartões das abas abrem e fecham com um clique (Enter na TUI).
- **Estado de layout persistido por usuário:** lateral, largura do chat, abas abertas.

**Ordem das interfaces** (decisão de 2026-11-13): **a TUI vem primeiro e é a interface principal** (Fase 7). A web (Fase 12) e o app desktop (Fase 13) são posteriores. Desde 2026-11-14, o app Android (Fase 14) embrulha a web; por isso, a web deixou de ser opcional, e só o desktop continua opcional.

**Camada compartilhada (`packages/client`, Fase 6).** O reaproveitamento entre TUI e web é de **lógica, não de tela**: componentes Ink não rodam no navegador, e componentes da web não rodam no terminal. O que se compartilha fica abaixo deles, num pacote que não depende de interface:
- **cliente da API:** REST tipado (a partir de `packages/protocol`), SSE com retomada por `Last-Event-ID` e WebSocket do chat;
- **stores de estado:** zustand no modo *vanilla* (MIT), que funciona tanto no Ink quanto no React. Guardam cenários, peças, demandas, decisões pendentes, cotas e eventos;
- **preferências de layout por usuário:** lateral recolhida, largura do chat, abas abertas, seções recolhidas.

A TUI nasce sobre essa camada, e a web a herda pronta: TUI e web viram duas "peles" sobre a mesma lógica.

**TUI (principal):** cliente de terminal da API do daemon, em **Ink** (React para terminal, MIT, layout flexbox via Yoga). Nunca fala com os agentes diretamente.

Por que Ink:
- **Mesmo modelo da web:** componentes React em TypeScript sobre o `packages/client`. Quando a web vier, muda só a camada de desenho.
- **Já usado em agentes de código:** Claude Code e Gemini CLI são feitos em Ink.
- **O layout dos mockups cabe no flexbox:** a largura do chat é a prop `width` de uma `<Box>`; lateral e painel são `<Box>` exibidas ou não.

O que o Ink não traz e escrevemos (`packages/tui/src/components/`):
- áreas com **rolagem própria** (histórico do chat, eventos, trajetória), com virtualização para conversas longas;
- **tela cheia** no buffer alternativo do terminal, com redesenho correto ao redimensionar a janela;
- barra de abas, seções recolhíveis e alça de largura do chat;
- paleta de comandos (Ctrl+K);
- **mouse** fica para depois (o Ink é focado em teclado; os mockups usam atalhos).

Componentes básicos (campos, listas, seletores) vêm do `@inkjs/ui` (MIT).

Abas, comandos da paleta e ações do mapa de teclas ficam num registro do `packages/client` (5.18). Uma aba nova é uma entrada no registro, não uma mudança no layout. Plugins entram pelo painel declarativo (5.14), desenhado pela TUI e pela web.

Adaptações do terminal em relação à web:
- **DAG:** vira lista com dependências (`D4 ← D2, D3`), sem desenho gráfico;
- **papéis:** reordenados com Shift+↑↓, sem arrastar;
- **login das assinaturas:** o fluxo oficial do CLI (`claude`, `codex login`) roda num painel da própria TUI, porque esses logins já são interativos no terminal;
- **decisões do Produtor:** respondidas por tecla (1, 2, esc).

**Multiplataforma.** TUI e daemon rodam em Windows, macOS e Linux (Node). O que muda por sistema:
- **cofre de chaves:** Keychain no macOS, Credential Manager no Windows, Secret Service (GNOME Keyring/KWallet) no Linux, ver 5.6;
- **contenção de processos:** Job Object no Windows; grupos de processos + `sandbox-runtime` no macOS/Linux, ver 5.8 e 5.9;
- **teclado:** ver o mapa de teclas abaixo.

**Uso remoto por SSH.** No Linux e no macOS, com o daemon numa máquina sempre ligada, a TUI pode ser aberta por SSH de qualquer lugar, sem depender da nuvem. O daemon continua escutando só em `127.0.0.1`; quem acessa é a TUI rodando na própria máquina, dentro da sessão SSH.

#### Mapa de teclas (configurável)

Programas de terminal só recebem Ctrl e Alt/Option; o **Cmd do macOS nunca chega**. Alguns atalhos do mockup colidem com o sistema ou com o terminal. Por isso o mapa de teclas:
- é **configurável** pelo usuário (arquivo de preferências, editável também pela aba Configurações);
- tem **padrões por sistema e por ambiente**, detectados na inicialização:
  - macOS;
  - dentro do tmux (variável `TMUX`);
  - no terminal do VS Code (`TERM_PROGRAM=vscode`);
- oferece **sempre um caminho alternativo**: toda ação está na paleta de comandos, e a paleta tem dois atalhos;
- é mostrado na **barra de atalhos** do rodapé e na ajuda (F1), sempre com as teclas efetivamente ativas.

| Ação | Padrão (Windows/Linux) | Padrão no macOS | Alternativa | Colisões conhecidas |
|---|---|---|---|---|
| Recolher/expandir lateral | Ctrl+B | Ctrl+B | Alt+B; paleta | **tmux** usa Ctrl+B como prefixo: dentro do tmux o padrão vira Alt+B |
| Abrir/fechar painel | Ctrl+J | Ctrl+J | Alt+J; paleta | Ctrl+J é o código de "nova linha" (LF). Em modo bruto difere do Enter (CR) na maioria dos terminais, não em todos: o teste da Fase 0 confirma |
| Largura do chat | Ctrl+←/→ | **Ctrl+Shift+←/→** | foco na borda do chat (Tab) e ←/→; paleta | No **macOS**, Ctrl+←/→ troca de área de trabalho (Mission Control) e não chega ao terminal |
| Abrir aba | Ctrl+T | Ctrl+T | Alt+T; paleta | Terminais no navegador (SSH web) podem capturar Ctrl+T |
| Fechar aba | Ctrl+W | Ctrl+W | Alt+W; paleta | Terminais no navegador fecham a aba do navegador com Ctrl+W |
| Paleta de comandos | Ctrl+K | Ctrl+K | **F1** (paleta + ajuda) | O terminal do **VS Code** pode capturar Ctrl+K para os atalhos dele **[a confirmar no teste]**: ali o padrão vira F1 |
| Configurações / Plugins | F5 / F6 | F5 / F6 | paleta | No macOS, as teclas F exigem Fn por padrão |
| Responder decisão | 1, 2, Esc | 1, 2, Esc | paleta | — |
| Sair | Ctrl+Q | Ctrl+Q | paleta | Ctrl+Q/Ctrl+S são controle de fluxo (XON/XOFF) fora do modo bruto; o modo bruto do Node os desativa |

Regras:
- **Alt no macOS** depende do terminal: no Terminal.app, "Usar Option como Meta"; no iTerm2, "Option como Esc+". Se não estiver ativo, a TUI avisa na primeira execução e o caminho é a paleta.
- **Ctrl+Shift+letra não serve:** sem o protocolo de teclado estendido (kitty), o terminal não distingue Ctrl+Shift+P de Ctrl+P. Setas com modificadores, ao contrário, são distinguíveis na maioria dos terminais.
- **Conflito ao configurar:** a configuração rejeita atalhos repetidos e avisa quando o usuário escolhe uma combinação da lista de colisões.

Os mockups mostram os padrões de Windows/Linux.

**Alternativa: OpenTUI** (equipe do OpenCode; TypeScript com núcleo nativo, MIT **[a confirmar]**). Traz rolagem e mouse prontos e desempenho melhor com muitas atualizações por segundo. Até onde se sabe, roda principalmente sobre o **Bun** **[a confirmar]**. Não é impeditivo, porque a TUI é um processo separado do daemon, mas acrescenta um runtime ao projeto.

**Decisão:** começar em Ink. O **teste comparativo da Fase 0** (Ink × OpenTUI), agora **obrigatório**, decide antes da Fase 7. Como a TUI só depende do `packages/client` e da API do daemon, trocar de framework não afeta o resto do sistema.

**Web (Fase 12, depois da v1; base do app Android):** React + Vite sobre o mesmo `packages/client`, com SSE para tempo real. Nasce responsiva e preparada para toque, porque o app Android a reaproveita (Fase 14). Acrescenta à TUI o DAG desenhado, arrastar para reordenar, painéis próprios de plugins e mouse. Componentes reaproveitados:

| Uso | Componente |
|---|---|
| Chat com streaming | **assistant-ui** (MIT) com `ExternalStoreRuntime`, alimentado pelos stores do `packages/client` |
| Blocos de IA (código, trace, mensagens) | padrões de IA do **shadcn/ui** (não usar Vercel AI Elements: será descontinuado no fim de novembro de 2026 em favor do shadcn) |
| DAG de demandas | **@xyflow/react** (React Flow, MIT) |
| Trajetórias | **AgentPrism** (Evil Martians; `TraceViewer` em árvore, com adaptador OTel), só se a licença estiver na lista permitida da seção 6.0 **[a confirmar]**; senão, componente próprio sobre a árvore de spans |

**Conteúdo das telas** (o mesmo nas duas interfaces):
- **Lateral:** Assinaturas, Projetos, Tarefas, Chats, Plugins, Configuração.
- **Cenário** (projeto, tarefa ou chat genérico: o mesmo objeto, com tipo e fluxo diferentes; 5.20):
  - chat com o Orquestrador, com anexos e o estado do Diretor (ativo ou adormecido);
  - na tarefa: a definição (versão ativa, passos, ensaio) e a lista de execuções com o artefato final de cada uma;
  - dashboard: etapa, DAG, Atores ativos e tempo restante, worktrees/branches, reprovações, consumo e cota por assinatura, motivos de seleção;
  - visualizador de trajetórias, ao vivo e histórico.
- **Configuração:**
  - Assinaturas: status, cota, reset, login, adicionar/remover;
  - Executores: cliente, perfil, modelo e esforço a partir das config options anunciadas;
  - Papéis: lista ordenada por prioridade + `next`/`wait`;
  - Limites: `Np`, `Nc`, timeouts, semáforos;
  - escopo global com override por projeto.

**Desktop (Fase 13, opcional, depende da web):** Electron envolvendo a web, conectado ao serviço de logon da Fase 10, como qualquer outro cliente; o daemon não roda dentro do app (item 6 da seção 12, v0.25). Sem o serviço instalado, o app abre o mesmo assistente de configuração do daemon (5.7), que o instala. Instalador por usuário (electron-builder).
- Tauri v2 tem guia oficial de sidecar Node e gera instalador menor, ao custo de toolchain Rust. Como o lançador de Job Object já traz Rust para o projeto, Tauri fica mais viável que na v0.1.
- Decisão na Fase 13.

**Android, celular e tablet (Fase 14, depois da web).** Decidido em 2026-11-14, a pedido do dono.
- **Só cliente.** O daemon continua no computador, porque precisa dos CLIs oficiais, das worktrees e do cofre do sistema. O app fala com ele pela mesma API (REST, SSE e WebSocket), como a web.
- **Tecnologia: Capacitor** (Ionic; MIT **[a confirmar]**) embrulhando a web da Fase 12. Reaproveita as telas, os componentes e o `packages/client`. O que é novo:
  - o layout de celular;
  - os plugins nativos do Capacitor: leitor de QR, notificações e armazenamento seguro do token **[proposta]**.
- **Tablet: o app completo.** O layout de `mockup/app.html` (lateral, chat e painel em abas), com toque no lugar do mouse. Em retrato, a lateral e o painel viram gavetas sobre o chat **[proposta]**.
- **Celular: versão enxuta**, com uma coluna por vez e navegação inferior **[proposta]**. Tem:
  - o chat com o Diretor, com anexos (foto, arquivo);
  - as decisões pendentes, respondidas com um toque;
  - as cotas por assinatura (5 h e 7 dias, com o reset), os eventos e o estado das peças, tarefas e agenda;
  - pausar, retomar e cancelar.

  Fica de fora do celular: editar a configuração pesada (Executores, papéis, perfis, plugins), o DAG desenhado, as trajetórias longas e o navegador compartilhado. Essas telas aparecem só para leitura, ou o app indica abrir no computador **[proposta]**.
- **Comandos pelo celular** (`mockup/mobile.html`) **[proposta]**. Mandar uma ordem ao Diretor tem de caber em um ou dois toques:
  - o chat abre direto, com o composer embaixo, ao alcance do polegar; o topo mostra o destinatário, e um toque troca entre o Orquestrador global e o Diretor de cada cenário;
  - comandos rápidos em fichas acima do composer, que mudam com o estado do cenário (com peça rodando: como está, pausar, nova peça, resumo, agendar);
  - o botão `/` abre uma folha com busca e os comandos agrupados (peça atual, criar, consultar), mais as frases salvas do Produtor;
  - sem texto, o botão de enviar vira microfone (segurar para falar); o ditado do teclado do Android serve de alternativa sem plugin **[a confirmar]**;
  - comandos terminados em “…” preenchem um modelo para completar; os outros enviam na hora; consultas de estado (`/status`, `/cotas`) respondem pelo daemon, sem chamar o modelo;
  - ações destrutivas (cancelar a peça) pedem confirmação e biometria;
  - sem conexão com o daemon, a mensagem fica numa fila no aparelho e sai quando a VPN volta, além da `prompt_queue` do daemon.
- **Acesso ao daemon:** pela VPN do usuário, com pareamento por QR e token por aparelho (5.12).
- **Idioma:** o mesmo catálogo da web (5.22).
- **Em aberto:** as notificações (seção 12, item 19) e a distribuição (item 20).

### 5.14 Plugins

Plugin = **servidor MCP + manifesto** (+ painel declarativo opcional). É a camada **externa** de extensão (5.18): roda fora do processo do daemon.

```yaml
# plugin.yaml
id: postgres-db
version: 1.0.0
server:
  type: stdio            # ou http; o daemon agrega e expõe pelo servidor do framework
  command: ["node", "dist/server.js"]
tools:
  - name: query_sql
    roles: [actor, critic]
    specialties: [sql]
    effects: read         # read | local_write | network | external_write
  - name: migrate
    roles: [actor]
    effects: external_write
    requires_producer_approval: true
  - name: list_migrations
    roles: []             # só o painel usa
    effects: read
secrets: [PG_URL]        # resolvidos do cofre, injetados só no servidor do plugin
events: [migration_applied]    # publicados como plugin.postgres-db.migration_applied
panel:                    # opcional e declarativo: a TUI e a web desenham
  - type: table
    title: Migrações pendentes   # texto de tela: chave do catálogo i18n do plugin (5.22)
    source: list_migrations   # ferramenta do próprio plugin, com effects: read
  - type: action
    label: Migrar
    tool: migrate             # segue requires_producer_approval
```

- O daemon lê os manifestos, monta o conjunto de ferramentas de cada papel e gera as camadas 1 e 2 de permissão automaticamente.
- Ativação por projeto.
- **Painel declarativo** (decidido em 2026-11-13): o plugin descreve o painel em dados, validados por schema, e **nenhum código do plugin roda na interface**.
  - Tipos de bloco na v1: `table`, `list`, `metrics` e `action`. O schema do painel tem versão própria (5.18), e um tipo novo entra nele.
  - A `source` de um bloco só pode ser uma ferramenta do próprio plugin com `effects: read`.
  - Uma `action` chama uma ferramenta do plugin em nome do Produtor, pela API, com as mesmas permissões, aprovação e evento de qualquer chamada.
- **Eventos próprios:** o plugin só publica tipos com o prefixo `plugin.<id>.*`, declarados no manifesto.
- **Comportamento de mod, depois da v1** (decidido em 2026-11-13): não haverá um mecanismo de mods separado. O próprio plugin ganha **níveis opcionais**, declarados no manifesto e aprovados pelo Produtor na ativação, sempre fora do processo do daemon (P5):
  - **assinar eventos:** recebe os tipos de evento que declarou, só para leitura e em segundo plano (ex.: avisar quando uma peça termina);
  - **ganchos de interceptação:** o daemon chama o plugin em pontos fixos do fluxo (ex.: antes de uma ferramenta rodar, antes da entrega), com prazo. O gancho pode **vetar** ou **anotar**, nunca liberar permissão nem trocar o resultado de uma ferramenta;
  - **contribuições declarativas:** fluxos montados só com as etapas já registradas (5.20), fragmentos de prompt e atalhos, validados pelos schemas dos registros (5.18).
  - Os detalhes (pontos de interceptação, prazo, falha do gancho) são o item 15 da seção 12. Na v1, o plugin fica como descrito acima.

### 5.15 Agendador (tarefas agendadas e repetidas)

O daemon dispara peças sozinho, no horário: o agendador age como se você tivesse escrito a necessidade no chat. Não há pipeline novo. A peça agendada passa pela mesma máquina de estados, seleção de Executores, permissões e eventos de qualquer outra.

**Tarefa agendada = modelo de peça**, guardado no store (tabela `schedules`, seção 7). Desde a v0.14, o mesmo agendamento também dispara a execução de um cenário do tipo tarefa (5.20). Nesse caso, ele aponta para a tarefa e a versão da definição, em vez de uma necessidade, e os campos abaixo de projeto não se aplicam. O agendamento de um projeto tem:
- cenário: projeto e branch base;
- texto da necessidade (ex.: "atualizar dependências e corrigir o que quebrar");
- overrides opcionais: executores por papel (chave `roles`, com a mesma forma do override por cenário, 5.7), limites, timeout;
- **política de entrega:** abrir PR por padrão. Merge direto só se o projeto permitir **e** a tarefa pedir explicitamente;
- **orçamento por execução:** teto de tempo total e, para perfis de API, de custo. Estourou, a peça para e notifica.

**Tipos de agendamento:**

| Tipo | Exemplo | Observação |
|---|---|---|
| Uma vez | 20/11 às 22h | Some da lista depois de rodar (fica no histórico) |
| Repetida por calendário | cron `0 7 * * 1-5` com fuso `America/Sao_Paulo` | Dias úteis às 7h; o fuso é sempre explícito |
| Repetida por intervalo | a cada 6 h | Conta a partir do fim da execução anterior |
| Logo após o reset da cota | "depois do próximo reset de claude-code/empresa" | Usa o `resetsAt` das sondas de cota (5.6) para aproveitar a janela cheia |

Biblioteca: **croner** (TypeScript, cron com fuso horário e sem dependências; licença MIT **[a confirmar]**). O próximo disparo de cada tarefa é recalculado e gravado no SQLite, então sobrevive a reinícios do daemon.

**Regras por tarefa** (com padrões globais na aba Configurações › Limites):

| Situação | Opções | Padrão |
|---|---|---|
| **Execução perdida** (máquina desligada ou daemon parado no horário) | rodar uma vez ao voltar / pular | rodar uma vez, se o atraso for menor que a janela configurada (padrão 12 h); senão, pular e registrar |
| **Sobreposição** (a execução anterior ainda roda) | pular / enfileirar / cancelar a anterior | pular e registrar |
| **Cota** (assinaturas do papel esgotadas) | adiar até o reset / usar a regra do papel (`next`/`wait`) / pular | adiar até o reset, dentro de um prazo máximo |
| **Decisão do Produtor sem ninguém olhando** | esperar um prazo e seguir com a recomendada / pausar e notificar (e cancelar depois do prazo) / resposta padrão definida na tarefa | esperar um prazo e seguir com a recomendada (v0.26; era pausar e notificar), nunca numa decisão irreversível além da opção segura (5.3) |

**Notificações:** ao terminar, falhar, pausar ou pedir decisão.
- Sempre no chat do cenário e como evento (`schedule.*`).
- Notificação do sistema operacional, quando houver sessão gráfica.
- E-mail, webhook ou chat corporativo via plugin (seção 5.14).

**Máquina dormindo.** O daemon sozinho não acorda a máquina. Além disso, o Modern Standby do Windows estrangula processos em segundo plano com a tela bloqueada (problema já visto em outro projeto desta máquina, com uma fila de envio que atrasou horas). Duas medidas:
1. **Acordar no horário:** ao salvar uma tarefa, o daemon registra um gatilho no agendador do sistema operacional. O gatilho acorda a máquina e chama `ot run <task>`, que entrega o disparo ao daemon (e o inicia, se preciso):
   - Windows: Agendador de Tarefas, com "despertar o computador";
   - macOS: launchd, com `pmset` para despertar;
   - Linux: timer do systemd com `WakeSystem=`.
2. **Manter acordada durante a execução:** pedido de energia ao sistema enquanto houver peça agendada rodando:
   - Windows: `SetThreadExecutionState` + Power Request;
   - macOS: `caffeinate`/IOPMAssertion;
   - Linux: inibidor do systemd-logind.

   O pedido é liberado ao fim da peça.

**Criação e controle:**
- **Aba Agenda** no painel (TUI e web):
  - lista de tarefas com próxima execução e estado;
  - histórico de execuções com resultado e link para a peça;
  - ações pausar, retomar, editar, duplicar, excluir e "rodar agora".
- **Pelo chat:** "toda segunda às 8h, revise as dependências do loja-api". O Orquestrador chama a ferramenta MCP `schedule(...)`, que **não salva direto**: devolve um rascunho que aparece no chat como decisão do Produtor (confirmar / editar / cancelar). Ferramentas `list_schedules` e `pause_schedule` completam o conjunto do Diretor.
- **Pelo terminal:**
  - `ot schedule list|add|pause|resume|rm`;
  - `ot run <task>`, que também é o comando chamado pelo gatilho do sistema operacional.

**Repetição até uma condição** ("rodar até os testes passarem") **não** é agendamento: já é o ciclo de correção do próprio pipeline (Crítico → correção, com os limites `Nc` e de tentativas).

**Padrões do agendador** (decidido em 2026-11-14, N13). As regras acima são chaves de configuração, com valor global e override por tarefa. O padrão é a predefinição `balanced`. Valem também para os cenários do tipo tarefa (5.20).

```yaml
schedule:
  preset: balanced             # balanced | conservative | relaxed
  missed_run:
    mode: run_once             # run_once | skip
    window: 12h                # atraso máximo para rodar; 0 = sem limite
  overlap: skip                # skip | queue | cancel_previous
  quota_exhausted:
    mode: postpone             # postpone | role_rule | skip
    max_postpone: 6h           # 0 = até o reset, sem prazo; estourou, pula e notifica
  unattended_decision:
    mode: wait_then_recommended  # wait_then_recommended | pause_notify | default_answer
    wait_for: 1h               # wait_then_recommended: espera antes de seguir com a recomendada
    timeout: 24h               # pause_notify: 0 = espera sem prazo; estourou, cancela e registra
  budget:
    max_time: 1h
    max_api_cost_usd: 5        # só perfis de API
```

| Predefinição | Janela da perdida | Adiamento por cota | Segue com a recomendada após | Espera por decisão (`pause_notify`) | Tempo | Custo (API) |
|---|---|---|---|---|---|---|
| `balanced` (padrão) | 12 h | 6 h | 1 h | 24 h | 1 h | US$ 5 |
| `conservative` | 2 h | 2 h | 2 h | 4 h | 30 min | US$ 2 |
| `relaxed` | 24 h | até o reset | 30 min | sem prazo | 2 h | US$ 10 |

- **Decisão sem ninguém olhando** (decidido em 2026-11-14, v0.26, item 24 da seção 12, revendo o padrão do item 13): o padrão passa a ser `wait_then_recommended`, que espera o prazo da predefinição e segue com a opção recomendada da pergunta (5.3), com o evento registrando a escolha automática. Os prazos padrão de 1 h (`balanced`), 2 h (`conservative`) e 30 min (`relaxed`) foram escolhidos pelo dono, e cada um muda na chave `wait_for`, globalmente ou por tarefa. `pause_notify` e `default_answer` continuam como alternativas. Nas decisões irreversíveis, a recomendada é sempre a opção segura, e o risco R13 segue coberto pela entrega por PR.

- A predefinição (`preset`) preenche todos os valores de uma vez. Uma chave individual sobrepõe só o valor dela **[proposta]**.
- O schema zod vem do módulo dono das chaves e é validado na subida (5.18). A aba Configurações › Limites e `ot config` mostram e mudam as chaves.

### 5.16 Interrupção e retomada de sessões

Qualquer sessão de Executor (Autor, Revisor, Roteirista, Ator, Crítico, e também o Orquestrador) pode ser interrompida no meio do trabalho:
- cota esgotada;
- erro do provedor ou da rede;
- queda do processo do cliente;
- reinício do daemon ou da máquina;
- timeout;
- agente travado.

O daemon precisa saber **por que** parou, **o que já foi feito** e **como continuar**, sem perder trabalho nem repetir efeitos colaterais.

#### Duas formas de retomar

| Forma | Como | Quando dá | Vantagem | Limite |
|---|---|---|---|---|
| **Nativa** | `session/load` do ACP: o cliente recarrega a própria conversa (histórico, contexto, chamadas de ferramenta) e o daemon envia um prompt de continuação | Mesmo cliente, **mesmo perfil** (as conversas ficam no diretório do perfil: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`…), mesma worktree e adaptador que anuncia `loadSession` | Continua exatamente de onde parou, com todo o contexto | Não atravessa clientes nem contas; depende dos arquivos do cliente continuarem lá |
| **Passagem de bastão** (*handoff*) | Sessão **nova**, em qualquer Executor, com um **pacote de continuação** montado pelo daemon | Sempre | Funciona entre modelos, clientes e assinaturas; é o que permite trocar de conta quando a cota acaba | Perde o raciocínio interno; depende da qualidade do pacote |

**Pacote de continuação**, montado a partir do store, nunca da memória de um modelo:
1. demanda, contrato, critérios de aceite e ordens vigentes no momento da retomada (o mesmo prefixo estável de qualquer Executor do papel);
2. **estado da worktree**: commit de checkpoint mais recente e diff em relação à base da tentativa;
3. **resumo da trajetória**, gerado de forma determinística a partir dos eventos:
   - arquivos lidos e editados;
   - comandos e testes rodados, com resultado;
   - última mensagem do agente;
   - decisões do Produtor já respondidas;
4. **efeitos colaterais já executados**: commits, instalações, chamadas de plugin com escrita (seção abaixo);
5. **motivo da interrupção** e instrução explícita: "continue a partir deste estado; não refaça o que está listado como concluído".

Opcionalmente, um modelo barato (o do Diretor) condensa o resumo quando a trajetória é longa. O resumo determinístico continua anexado, como fonte da verdade.

Para papéis de saída curta (Revisor, Roteirista, Crítico), a passagem de bastão costuma ser simplesmente **refazer** com as anotações parciais. Para o **Orquestrador**, vale o failover já descrito em 5.4.

#### Política por causa

O daemon classifica a causa pelos sinais disponíveis:
- `stopReason` do ACP;
- código de saída do processo;
- `rate_limit_event`/429 e sondas de cota (5.6);
- timeout do próprio daemon;
- detecção de travamento: sem evento por N minutos, ou o mesmo erro de ferramenta repetido.

| Causa | Ação padrão | Conta como tentativa? |
|---|---|---|
| **Cota esgotada**, reset próximo (dentro do limite configurado) e regra do papel `wait` | Aguardar o reset e retomar **nativa** no mesmo perfil | Não |
| **Cota esgotada**, reset distante ou regra `next` | **Passagem de bastão** para o próximo Executor disponível do papel (5.7) | Não |
| **Teto de gasto em API estourado** (5.6) | Pela chave `in_flight` do perfil: passagem de bastão (padrão), terminar a sessão ou parar e perguntar | Não |
| **Erro transitório** (rede, 5xx do provedor, sobrecarga) | Retomar **nativa** com recuo exponencial (ex.: 30 s, 2 min, 10 min); se esgotar, passagem de bastão | Não |
| **Queda do processo do cliente** | Retomar **nativa**; se o `session/load` falhar, passagem de bastão | Não, na primeira vez; sim, se repetir |
| **Reinício do daemon ou da máquina** | Para cada sessão `interrupted`: nativa se os arquivos do cliente existirem; senão, passagem de bastão | Não |
| **Timeout da demanda** | Regra já existente (5.4): o Diretor avalia o parcial (vai para o Crítico ou para outro Ator); a continuação é passagem de bastão | Sim |
| **Agente travado ou em laço** | Passagem de bastão para **outro** Executor (diversidade) | Sim |
| **Recusa do modelo** ou erro de permissão | Ponto de julgamento do Diretor: reformular, trocar de Executor ou perguntar ao Produtor | Sim |

**Interrupções de causa externa** (cota, rede, queda, reinício) **não** consomem as tentativas da demanda. Só contam as falhas atribuíveis ao agente. Um limite próprio de retomadas por tentativa (padrão 5) evita laço infinito: passou disso, o caso vai para o Diretor.

#### Checkpoints

- **Commit de checkpoint automático** na branch da tentativa:
  - a cada lote de edições, ou a cada N minutos com mudanças;
  - na interrupção, qualquer que seja a causa (não só no timeout, como na v0.8).
- Os commits de checkpoint são marcados (`wip(checkpoint): …`) e **reescritos num único commit** na integração (`INTEGRATING`), sem poluir o histórico.
- O daemon guarda por tentativa:
  - a referência da sessão ACP;
  - o perfil e a worktree;
  - o último checkpoint;
  - o último evento processado.

  Isso é o mínimo para decidir entre retomada nativa e passagem de bastão.

#### Efeitos colaterais e idempotência

Retomar não pode repetir o que já mudou o mundo fora da worktree:
- toda chamada de casca ou plugin com efeito (`git_commit`, `install_deps`, ferramentas de plugin marcadas `local_write`, `network` ou `external_write`) recebe uma **chave de idempotência** (`attempt + step`) e é registrada como evento antes e depois da execução;
- se a mesma chave chegar de novo após uma retomada, a casca devolve o resultado gravado em vez de executar outra vez;
- plugins com `external_write` precisam declarar no manifesto se aceitam chave de idempotência. Os que não aceitam exigem confirmação do Produtor antes de serem repetidos numa retomada.
- um efeito com "antes" e sem "depois" (reinício ou queda no meio da chamada) é **ambíguo**. A reconciliação (5.21) o resolve pelo verificador da ferramenta ou pergunta ao Produtor; nunca o repete às cegas.

#### Máquina de estados da tentativa

```
EXECUTING ──(interrupção)──→ INTERRUPTED(cause)
INTERRUPTED → AWAITING_RESUME (reset de cota, virada do período do teto, recuo, vaga no pool)
AWAITING_RESUME → RESUMING(native | handoff) → EXECUTING
RESUMING(native) ──falhou──→ RESUMING(handoff)
retomadas > limite → DECIDING (ponto de julgamento do Diretor)
```

Tudo vira evento (`session.interrupted`, `session.resumed`, com causa, forma e Executor de origem e destino) e aparece no chat como mensagem de sistema. Exemplo: "D2 interrompida: cota de codex/conta-1 esgotada; retomada em sonnet-medium por passagem de bastão".

#### Padrões da retomada

Decidido em 2026-11-14 (N14). Os valores são chaves de configuração, com valor global e override por projeto. O padrão é a predefinição `balanced`.

```yaml
resume:
  preset: balanced             # balanced | patient | agile
  max_resumes: 5               # por tentativa; passou, vai ao ponto de julgamento do Diretor
  quota_wait_max: 30m          # reset mais perto que isso, com regra wait: espera; senão, passa o bastão
  checkpoint_every: 10m        # só se houver mudança; além do lote de edições e da interrupção
  stuck:                       # agente travado: o que vier primeiro
    no_event_for: 10m
    same_error_times: 3
  transient_backoff: [30s, 2m, 10m]   # erro transitório; esgotou, passa o bastão
```

| Predefinição | Retomadas | Espera pelo reset | Checkpoint | Sem evento | Mesmo erro |
|---|---|---|---|---|---|
| `balanced` (padrão) | 5 | 30 min | 10 min | 10 min | 3 vezes |
| `patient` | 8 | 2 h | 15 min | 20 min | 5 vezes |
| `agile` | 3 | 10 min | 5 min | 5 min | 2 vezes |

- A predefinição (`preset`) preenche todos os valores de uma vez. Uma chave individual sobrepõe só o valor dela **[proposta]**.
- O schema zod vem do módulo dono das chaves e é validado na subida (5.18). A aba Configurações › Limites e `ot config` mostram e mudam as chaves.
- O recuo do erro transitório (`transient_backoff`) não muda com a predefinição **[proposta]**.

### 5.17 Ordens do Produtor (globais e locais)

Conceito trazido do `okit` (ordens permanentes, `kit orders`) e redesenhado aqui. Nenhum código do kit é reaproveitado (decisão Q12 de `docs/13-DECISOES-EM-ABERTO.md`). No `okit`, a ordem tinha só um prazo final opcional (`validUntil`) e a revogação com motivo. Aqui ela ganha período de vigência, duração, janela recorrente, prorrogação, revogação programada e suspensão local de uma global.

**Ordem** é uma instrução do Produtor que vale além de uma peça. Ela continua em vigor entre peças, sessões, compressões de contexto, failover e reinícios, durante a sua vigência e até ser revogada. Exemplos:
- "mensagens de commit em português" (permanente);
- "sempre me apresente as dúvidas como múltiplas escolhas, para eu decidir" (exemplo dado pelo dono em 2026-11-13; era uma `instruction` ao Diretor, e desde a v0.26 é o padrão em código, `chat.producer_questions: choices`, 5.3; como ordem, vira uma `rule` com `choices_strict`);
- "fazer push sempre que commitar" (global, `rule` com a chave `git.push_after_commit`, porque quem faz commit e push é o daemon e um texto não mudaria isso; exemplo dado pelo dono em 2026-11-13);
- "não alterar `infra/` sem perguntar" (local a um projeto);
- "não usar o perfil claude-code/empresa para Atores até sexta 18h" (com prazo).

#### Escopo

| Escopo | Vale para | Exemplo |
|---|---|---|
| **Global** | Todos os cenários (projetos, tarefas e chats), inclusive os criados depois | "Respostas em português do Brasil" |
| **Local** | Um cenário: um projeto, uma tarefa ou um chat | "No loja-api, toda mudança de schema vem com migration" |

- **Uma ordem global é um único registro**, não uma cópia por cenário. Cenários novos a herdam sem passo extra, e não há cópias para divergir. No `okit`, a ordem "para todos" era copiada em cada projeto, com grupo e aviso de divergência.
- **Precedência (decidida em 2026-11-13):** no mesmo cenário, a local prevalece sobre a global. O prompt mostra as duas listas separadas e diz isso explicitamente. Para `rule`, o daemon aplica a local.
- **Um cenário ou todos (decidido em 2026-11-13):** não há ordem para uma lista de cenários nem por tag. Para valer em alguns cenários, cria-se uma ordem local em cada um.
- **Suspensão local de uma global** (mantida por decisão de 2026-11-13): para que uma global não valha num cenário, o Produtor cria uma ordem local do tipo `suspension`, que aponta para a global (ex.: "suspender O3 no loja-api até 30/11"). A global some do prompt daquele cenário enquanto a suspensão vigora. A global não é editada, e os outros cenários não mudam.
- **`roles` (opcional):** limita a quais papéis a ordem chega (ex.: só Atores e Crítico). Sem o campo, chega a todos. Mantém o contexto mínimo (P8).

#### Tipos, sem texto mágico

| Tipo | O que é | Quem aplica |
|---|---|---|
| `instruction` | Texto livre para os modelos | Os modelos, pelo prompt; o Crítico confere |
| `rule` | Override de uma chave de configuração que já existe, dentro do escopo e da vigência da ordem. Ex.: tirar um perfil da lista de um papel (5.7), trocar a regra `next`/`wait`, exigir PR na entrega | O daemon, em código (P3) |
| `suspension` | Tira uma ordem global de um cenário, durante a vigência da suspensão | O daemon, ao montar o prompt e ao aplicar as `rule` |

- O daemon **não interpreta o texto** de uma `instruction`: ela nunca muda o fluxo nem a permissão. No `okit`, um texto como `critic-waiver passo-N` tinha efeito em código; aqui, o que precisa ter efeito garantido é `rule`.
- Uma `rule` só aceita chaves de uma lista fechada, validada por schema zod. **Na v1 (decidido em 2026-11-13), a lista tem quatro chaves:** os perfis da lista de um papel (tirar ou reordenar, 5.7), a regra `next`/`wait` da cota, a exigência de PR na entrega e `git.push_after_commit`. A v0.26 acrescentou duas, `chat.producer_questions` e `chat.unanswered` (5.3), e a lista ficou com seis. Com esta última, depois de cada `git_commit` o daemon faz push da branch da demanda. Ele nunca faz force push nem push na branch base, que só recebe pela entrega (5.5). Chaves novas entram uma a uma, cada uma com teste. **Chaves de permissão (5.8) ficam fora**: permissão se muda na configuração do papel, não por ordem.
- **Conflito de `rule`:** duas `rule` sobre a mesma chave, no mesmo escopo e com vigências que se sobrepõem, são recusadas na criação. O rascunho mostra a ordem conflitante, e o Produtor revoga uma delas ou ajusta a vigência. Entre global e local, vale a precedência.
- Quando uma `rule` muda uma decisão do daemon, o evento cita o id da ordem (ex.: `executor.selected` com motivo "ordem O7"). A descrição do PR lista as `rule` que afetaram a peça.
- **Dispensa do Crítico não é ordem** (decidido em 2026-11-13). No `okit`, uma ordem com o texto `critic-waiver passo-N` dispensava o crítico. Aqui, o Produtor dispensa o Crítico por uma **decisão registrada** (`decide`, tabela `decisions`), com motivo, para a peça inteira, ao abrir a peça ou depois de uma reprovação (5.4). Nenhuma ordem, nem `rule`, dispensa o Crítico.

#### Vigência (período de validade)

Toda ordem tem uma vigência: **início** e **fim**, os dois opcionais, com fuso explícito (padrão `America/Sao_Paulo`, configurável). Sem início, vale a partir da confirmação. Sem fim, vale até ser revogada.

| Forma | Exemplo | Como é gravada |
|---|---|---|
| Permanente | "a partir de agora, commits em português" | início = confirmação; sem fim |
| Até uma data | "até sexta 18h" | fim = sexta 18:00 |
| Por uma duração | "pelas próximas 2 h", "por 3 dias" | fim = confirmação + duração |
| Período futuro | "de 20/11 a 27/11" | início e fim; fica `scheduled` até o início |
| Janela recorrente (**depois da v1**, decidido em 2026-11-13) | "em dias úteis, das 9h às 18h" | expressão cron de abertura + duração da janela, com fuso (croner, 5.15), dentro do início e do fim |

- **Tudo vira data absoluta na confirmação.** O rascunho mostra o início e o fim já calculados ("vale de 13/11 14:32 a 16/11 14:32"), para o Produtor ver o que vai valer. A duração conta da confirmação, não do pedido.
- **Data sem hora:** o início vale às 00:00 e o fim às 23:59:59 do dia, ou seja, o dia inteiro conta.
- **Estados:** `scheduled` → `active` → `expired`; `scheduled` ou `active` → `revoked`. `expired` e `revoked` são finais. Uma ordem com janela fica `active` durante toda a vigência, mas só entra no prompt e só aplica a `rule` com a janela aberta.
- **O relógio decide, não o timer.** Se a ordem vale agora é uma função pura de (agora, início, fim, janela), calculada a cada uso: ao montar um prompt, ao aplicar uma `rule`, ao listar. O croner só dispara os eventos e avisos nas fronteiras. Com a máquina dormindo ou o daemon parado, nenhuma ordem vencida é aplicada. Ao reiniciar, o daemon emite as transições que perdeu, com o horário real da fronteira (`effective_at`).
- **Prorrogar e antecipar:** a vigência é o único campo que muda depois da criação, por `extend_directive` (chat, aba ou terminal), e só enquanto a ordem não é final. Cada mudança gera o evento `directive.validity_changed` com os valores antigo e novo. Texto, escopo, tipo e papéis não mudam: para mudá-los, revoga-se e cria-se outra (ver Revogação, abaixo).
- **Avisos:** no chat do cenário e na aba Ordens, 24 h antes do fim (configurável; padrão decidido em 2026-11-13), no início de uma ordem `scheduled`, e quando ela expira.

#### Revogação

Revogar encerra a ordem antes do fim da vigência. Regras:
- **Só o Produtor revoga**, pelos mesmos canais da criação. O Diretor pode **sugerir** uma revogação (ex.: duas ordens em contradição), mas `revoke_directive` só devolve um rascunho que o Produtor confirma.
- **Motivo obrigatório**, numa linha. No chat, o rascunho já vem com o motivo tirado das palavras do Produtor.
- **Imediata ou programada:** "revogar agora" vale na confirmação. "Revogar a partir de sexta" não é revogação: é antecipar o fim para sexta (prorrogar), e a ordem termina `expired`.
- **Em lote:** por escopo ou filtro ("todas as ordens do chat X", "todas as `rule` sobre o perfil claude-code/empresa"). O rascunho lista cada ordem afetada, e cada uma gera o próprio evento.
- **É definitiva.** Uma ordem revogada não volta. Para reativar, cria-se uma ordem nova a partir dela; o campo `supersedes` liga as duas, e o histórico mostra a cadeia.
- **Revogar uma global num só cenário** é suspensão (tipo `suspension`), não revogação.

**Efeitos da revogação, da expiração e do início de uma ordem no meio do trabalho:**
1. **Sessões novas** já nascem com o conjunto de ordens vigente.
2. **Sessões em curso** (decidido em 2026-11-13) não são alteradas, porque o prefixo é estável (5.10). O Diretor recebe um aviso pela fila única (5.4) e decide se cancela e relança o Ator (`cancel_actor`). O padrão é não relançar.
3. **`rule`:** passa a valer, ou deixa de valer, na próxima decisão do daemon. Ao deixar de valer, volta o valor que a configuração tem.
4. **Nada é desfeito.** O que foi feito sob a ordem fica, e o histórico mostra qual ordem estava vigente em cada peça.

#### Onde as ordens entram

1. **Orquestrador:** sempre recebe as ordens vigentes (globais e do cenário, já descontadas as suspensas). Avisos de criação, início, prorrogação, revogação e expiração entram pela fila única de prompts (5.4).
2. **Executores:** as ordens vigentes, filtradas por `roles`, entram no prefixo estável (5.10), logo depois das regras do projeto. Cada uma traz o id e, se tiver, o fim ("O7, até 16/11 18:00").
3. **Crítico:** recebe as `instruction` vigentes durante a tentativa como critérios adicionais. Violação é crítica negativa, como qualquer outra.
4. **Retomada e failover:** o resumo do failover (5.4) e o pacote de continuação (5.16) levam as ordens vigentes **no momento da retomada**, não as do início da sessão interrompida.
5. **Peças agendadas** (5.15) usam as ordens vigentes no horário do disparo.

#### Criação e controle

- **Só o Produtor cria.** Pelo chat ("a partir de agora, commits em português"), o Orquestrador chama `propose_directive(...)`, que **não salva direto**: devolve um rascunho que aparece no chat como decisão do Produtor (confirmar / editar / cancelar), como o `schedule` (5.15). O rascunho mostra escopo, tipo, papéis e a vigência em datas absolutas. `extend_directive` e `revoke_directive` seguem o mesmo caminho.
- **Executores não têm ferramenta de ordens.** Um texto lido na web ou num arquivo nunca vira ordem (injeção de prompt).
- **Aba Ordens** no painel (TUI e web): ordens vigentes, agendadas e encerradas, por escopo, com a linha do tempo da vigência; criar, prorrogar, suspender e revogar.
- **Pelo terminal:**
  - `ot directives list [--global | --scenario <name>] [--state ...]` e `ot directives show O<n>`;
  - `ot directives add "<text>" (--global | --scenario <name>) [--type ...] [--roles ...] [--from <date>] [--until <date> | --for <duration>] [--window "<cron>" --duration <duration>]` (`--window` depois da v1);
  - `ot directives extend O<n> (--until <date> | --for <duration>)`;
  - `ot directives suspend O<n> --scenario <name> [--until <date>]`;
  - `ot directives revoke O<n>... --reason "<text>"`.

#### Registro e histórico

- ids `O<n>` sequenciais, únicos no daemon e nunca reaproveitados;
- **nada é apagado**; revogadas e expiradas ficam no histórico;
- eventos `directive.created`, `directive.activated`, `directive.validity_changed`, `directive.expiring`, `directive.expired`, `directive.revoked` e `directive.suspended`. A abertura e o fechamento de janelas recorrentes não geram evento, para não encher o log; o estado é calculado pelo relógio.

**Importação do `okit`** (Q12, proposta a detalhar com o importador):
- as ordens ativas de cada projeto viram ordens locais do tipo `instruction`, com o `validUntil` como fim;
- cópias do mesmo grupo presentes em todos os projetos viram uma única ordem global;
- revogadas e expiradas entram como histórico;
- textos que tinham efeito em código no kit não são importados como texto: vão para uma lista que o Produtor decide.

### 5.18 Portas, adaptadores e registros (extensibilidade)

Decidido em 2026-11-13 (v0.12), a pedido do dono: como tudo é TypeScript, a arquitetura usa ao máximo as abstrações da linguagem. O objetivo é que trocar ou acrescentar um cliente, um provedor, um sistema operacional, um armazenamento ou um fluxo não exija mexer no núcleo. O desenho é de **portas e adaptadores** (P12):
- **porta:** interface TypeScript + schemas zod em `@otheater/core`, com versão própria;
- **adaptador:** implementação de uma porta, num pacote `@otheater/adapter-*`;
- **registro:** lista tipada em que os módulos oficiais contribuem entradas (fluxos, papéis, ferramentas, chaves de `rule`, tipos de evento...).

#### Regras

1. **Porta em toda fronteira e em todo ponto de variação.** Isso vale para tudo que fala com o mundo de fora (processos, rede, disco, git, cofre, sistema operacional, relógio) e para tudo que muda por cliente, provedor ou sistema. A lógica interna pura **não** tem porta: validação do roteiro, precedência e conflito de ordens, algoritmo de seleção e cálculo de vigência são funções puras em `@otheater/core`, testadas sem fakes.
2. **O núcleo não conhece implementações.** Fora do adaptador não há `if (client === 'codex')` nem `if (process.platform === 'win32')`. O núcleo pergunta as **capacidades** do adaptador, como o ACP faz no `initialize` (ex.: `loadSession`, multissessão, MCP HTTP, config options).
3. **Regra de dependência:**
   - `core` depende só do zod;
   - cada adaptador depende de `core` e das bibliotecas dele;
   - o daemon depende de `core` e só importa adaptadores no ponto de montagem.

   A CI verifica a regra. A ferramenta é escolhida na Fase 1 (ex.: `dependency-cruiser`, licença MIT **[a confirmar]**).
4. **Erros tipados fazem parte do contrato** (`QuotaExhausted`, `AdapterUnavailable`, `PermissionDenied`, `Transient`...). A seleção (5.7) e a política de retomada por causa (5.16) decidem pelo tipo do erro, nunca pelo texto da mensagem.
5. **Toda porta nasce com três coisas:** um adaptador real, um adaptador falso para os testes e uma suíte de conformidade. Porta sem uso real não entra, para evitar abstração especulativa (R16).

#### Duas camadas de extensão

Decidido em 2026-11-13.

| Camada | Quem escreve | Onde roda | Como entra |
|---|---|---|---|
| **Interna** | o projeto (pacotes `@otheater/*`) | no processo do daemon | adaptador escolhido por id na configuração e montado no ponto de montagem |
| **Externa** | qualquer um | fora do processo | plugins MCP (5.14): ferramentas, painel declarativo e tipos de evento `plugin.<id>.*` |

- Código de terceiros **nunca** roda no processo do daemon nem na interface (P5).
- Um adaptador novo escrito por terceiros (ex.: outro cliente de agente) entra no projeto por PR, como pacote oficial, depois de passar na suíte de conformidade da porta.
- **Dois eixos para clientes e modelos** (decidido em 2026-11-14, v0.23): o **cliente** é quem executa o agente (laço de ferramentas, sessão, login, ACP) e entra pelo `ClientAdapter` + `AgentSession`; o **servidor de modelo local** é onde o modelo roda e entra pelo `LocalModelServer`. Um servidor como o Ollama não é cliente de agente: suportá-lo é escrever um adaptador de `LocalModelServer`, não um `ClientAdapter`, que exigiria um laço de agente próprio. Qualquer cliente que fale com um modelo local usa essa porta. Na v1 é o OpenCode; o Codex (`codex --oss`) e o Claude Code (por um endpoint compatível com a API da Anthropic) podem usar o Ollama também, segundo fontes não verificadas nesta máquina **[a confirmar na Fase 0]**.
- Não existe "mod" em processo. O que um mod faria (reagir a eventos, interceptar o fluxo, contribuir fluxos e prompts) vira nível opcional do plugin depois da v1, na camada externa (5.14).

#### Portas

| Porta | O que abstrai | Adaptador padrão | Outros previstos |
|---|---|---|---|
| `ClientAdapter` | cliente de agente: comando, ambiente, perfil, login (5.2) | `claude-code`, `codex`, `opencode` | `gemini` |
| `AgentSession` | conversa com o Executor: abrir, enviar prompt, receber o stream, cancelar, carregar (5.2) | ACP (`@agentclientprotocol/sdk`) | modo headless (`claude -p`, `codex exec --json`), que é a saída de emergência |
| `ModelCatalog` | modelos de um cliente: lista, sugestão de campos e validação dos Executores (5.7); faz parte do `ClientAdapter` | descoberta automática (Claude Code, Codex); assistida pelo `opencode models --verbose` (OpenCode) | clientes novos |
| `LocalModelServer` | servidor de modelo local: saúde, modelos carregados, número de slots (5.9) | `llama-cpp` | `ollama`, LM Studio, vLLM **[hipótese]** |
| `QuotaProbe` | sinal de cota de um provedor (5.6) | statusline (Claude), `app-server` (Codex), `token_plan/remains` (MiniMax), erro de limite | provedores novos |
| `UsageSource` | histórico de consumo (5.6) | ccusage | contabilidade local |
| `SecretVault` | cofre de segredos (5.6) | `@napi-rs/keyring` | arquivo criptografado com senha mestra; variável de ambiente do serviço |
| `Store` | persistência por agregado (peças, demandas, ordens, agenda...) e transações (seção 7) | SQLite WAL + Kysely sobre `better-sqlite3` | `node:sqlite`; em memória, para os testes |
| `EventLog` | log de eventos de id crescente (P6, 5.11) | tabela `events` do `Store` | — |
| `EventSink` | saída do log de eventos para fora | SSE, OTel, exportador ATIF | arquivo NDJSON; outros formatos de trajetória |
| `TelemetryIngest` | entrada da telemetria dos clientes (5.11) | receptor OTLP | — |
| `Vcs` | worktree, branch, commit, merge e push (5.5) | CLI `git` | — |
| `CodeHost` | PR e entrega (5.5) | `gh` (GitHub) | GitLab (`glab`), Gitea, só merge local **[hipótese]** |
| `Sandbox` | camada 3 de permissão (5.8) | `sandbox-runtime` (macOS/Linux) | usuário de baixo privilégio (Windows); nulo, só nos testes |
| `ProcessLauncher` | criar, limitar e matar a árvore de processos (5.9) | lançador Rust com Job Object (Windows); grupo de processos (posix) | `koffi`; `execa` com `killDescendants` |
| `ResourceMonitor` | RAM livre e carga, para a admissão (5.9) | leitura do sistema operacional | — |
| `OsScheduler` | gatilho que acorda a máquina e pedido de manter acordada (5.15) | Agendador de Tarefas, launchd + `pmset`, timer do systemd | — |
| `Notifier` | notificações (5.15) | chat do cenário; notificação do sistema operacional | e-mail, webhook ou chat corporativo por ferramenta de plugin (5.14) |
| `Clock` | hora atual e espera (vigência das ordens, agenda, timeouts) | relógio do sistema | relógio falso, nos testes |
| `PromptSource` | prompts dos papéis (5.10) | pasta `prompts/` versionada | prompts por projeto **[hipótese]** |
| `BrowserSession` | navegador compartilhado entre o agente e o Produtor: sessão, ferramentas, transmissão da tela, indicar elemento (5.19) | Playwright sobre CDP (Chromium) | outros motores do Playwright **[hipótese]** |

A tabela é o ponto de partida. Uma porta nova entra pela regra 5.

#### Registros

Decidido em 2026-11-13: as listas viram registros tipados, com schema zod por entrada, e só os módulos oficiais registram entradas que mudam o comportamento do daemon.

| Registro | Entradas | Quem registra |
|---|---|---|
| Fluxos | máquinas XState por nome e versão, montadas com etapas reutilizáveis (planejar, revisar, roteirizar, executar o DAG, integrar, criticar, decidir, entregar). A peça teatral (5.4) é o fluxo padrão | módulos oficiais |
| Papéis | schema de entrega, conjunto de ferramentas, prompt e pontos de julgamento de cada papel | módulos oficiais |
| Ferramentas do framework | ferramentas MCP do Diretor e dos papéis, e as cascas (5.3, 5.8), cada uma com schema, `effects` e chave de idempotência | módulos oficiais; plugins pelo manifesto, fora do processo |
| Chaves de `rule` | chave, schema do valor e ponto onde se aplica (5.17). **Lista fechada:** seis chaves na v1 (quatro de 2026-11-13 e duas da v0.26); chave nova entra uma a uma, com teste | só módulos oficiais |
| Tipos de evento | nome e schema do payload (5.11) | módulos oficiais; plugins só com o prefixo `plugin.<id>.*` |
| Estratégias | `when_exhausted` (`next`, `wait`; 5.7), política de retomada por causa (5.16), tipos de agendamento (5.15) | módulos oficiais |
| Cenários | tipos de cenário (projeto, tarefa, chat), perfis de projeto (`software` na v1), tipos de passo de tarefa, gatilhos (5.20) | módulos oficiais |
| Interface | abas, comandos da paleta e ações do mapa de teclas (5.13), em `packages/client` | módulos oficiais; plugins pelo painel declarativo (5.14) |
| Tipos de indicação | nome, versão, schema do conteúdo, texto para o prompt, leitura do detalhe e checagem de validade (5.19); o primeiro é `web_element` | só módulos oficiais |

- O registro recusa entrada duplicada ou com schema inválido **na subida do daemon**, nunca no meio de uma peça.
- **Fluxos.** O registro de fluxos (decidido em 2026-11-13) tem a peça teatral como padrão. Os fluxos `task.define`, `task.run` e `chat` (5.20, decididos na N3) são registrados ao lado dela, sem mexer na peça.
  - O cenário guarda o id do fluxo.
  - O snapshot da peça guarda o id e a versão do fluxo, e a migração de snapshot (5.4) é feita por fluxo.
  - As etapas reutilizáveis são atores XState com entrada e saída tipadas. Os efeitos longos (sessões ACP) continuam fora da máquina e voltam como eventos (5.4).

#### Montagem, sem container

Decidido em 2026-11-13: composição manual.
- Um **ponto de montagem** único (`packages/daemon/src/compose.ts`) lê a configuração, escolhe o adaptador de cada porta pelo id e passa tudo por construtor.
- Não há biblioteca de injeção de dependências, decorators nem resolução por nome em tempo de execução.
- Cada módulo de domínio (`pipeline/`, `selection/`, `directives/`, `scheduler/`...) recebe só as portas de que precisa.
- Os testes montam o mesmo daemon com fakes: `fake-agent`, `Store` em memória, `Clock` falso, `Sandbox` nulo.

```ts
// @otheater/core
export interface Adapter {
  readonly id: string;                                      // 'claude-statusline', 'sqlite', 'keyring'...
  readonly implements: { port: string; range: string };     // ex.: { port: 'QuotaProbe', range: '^1.0.0' }
}

export interface QuotaProbe extends Adapter {
  capabilities(): QuotaCapabilities;                        // janelas, push ou polling, precisão
  read(profile: ProfileRef): Promise<QuotaReading>;         // QuotaReading validado por zod
  watch?(profile: ProfileRef, onChange: (r: QuotaReading) => void): Disposable;
}

// packages/daemon/src/compose.ts
const clock = new SystemClock();
const store = new SqliteStore(config.store, clock);
const quota = new QuotaService([claudeStatuslineProbe, codexAppServerProbe, rateLimitErrorProbe]);
const selection = new SelectionService({ store, quota, admission, clock });
```

A escolha dos adaptadores fica na configuração. Cada adaptador contribui o schema zod da própria configuração, validado na subida:

```yaml
adapters:
  store: sqlite              # ou node-sqlite
  vault: keyring             # ou encrypted-file | env
  vcs: git
  code_host: github
  sandbox: auto              # escolhe pelo sistema operacional
  notifier: [chat, os]
```

A aba Configurações e a API mostram qual adaptador está em cada porta e com qual versão, como já acontece com o backend do cofre (5.6).

#### Versão dos contratos

Decidido em 2026-11-13: semver por porta + suítes de conformidade.
- Cada porta tem versão semver própria em `@otheater/core`.
- O adaptador declara a faixa que implementa (`implements.range`). Na subida, o ponto de montagem recusa um adaptador fora da faixa, com uma mensagem que diz a porta, a versão esperada e a recebida.
- Mudança que quebra o contrato = versão maior. Durante uma transição, o núcleo pode aceitar duas versões maiores **[proposta]**.
- **Suítes de conformidade** ficam em `@otheater/sdk`: uma por porta, em Vitest, que qualquer adaptador roda na própria CI. As de `ClientAdapter` e `AgentSession` incluem os testes de contrato contra os adaptadores reais fixados (seção 8, P10).

### 5.19 Navegador compartilhado

Decidido em 2026-11-13 (v0.13), a pedido do dono. É um navegador que o Produtor vê na web e no desktop e em que **indica elementos da página para o agente trabalhar**, como "este botão está desalinhado" ou "preencha este formulário". O Produtor e o agente usam **a mesma sessão**: o que o Produtor indica é o que o agente vê e controla.

#### Dono da sessão

O dono da sessão é a **porta oficial `BrowserSession`** (5.18), no daemon.
- O adaptador padrão é o **Playwright** (Apache-2.0, já na stack de testes) sobre CDP, com Chromium.
- O navegador roda como processo filho do daemon, sob o lançador (5.9) e com a admissão de RAM.
- Não fica num plugin nem numa webview da interface. Assim funciona igual na web e no desktop, e a escolha Electron × Tauri (N7) não depende dele.

#### Uma sessão, duas pontas

**Agente.** As ferramentas vêm do MCP do framework (5.3), com filtro por papel. Elas só entram no conjunto do papel se a política dele liberar (5.8).

| Ferramenta | `effects` | Observação |
|---|---|---|
| `browser_open(url)` | `network` | Só nos domínios permitidos do cenário, como o `http_get` |
| `browser_read(ref?)` | `network` | Texto e árvore de acessibilidade da página ou de um elemento, truncados |
| `browser_screenshot(ref?)` | `network` | Print da página ou de um elemento |
| `browser_click(ref)`, `browser_fill(ref, value)`, `browser_press_key(key)` | `external_write` | Por padrão, exigem aprovação do Produtor. O projeto pode liberar por domínio **[proposta]** |

**Interface.**
- A API (5.12) transmite a tela da sessão por WebSocket. A fonte é o screencast do CDP, e o desempenho em telas grandes está **[a confirmar]** na Fase 12.
- O Produtor também usa a sessão com mouse, teclado e rolagem, e pode assumir o controle a qualquer momento.
- Enquanto o Produtor controla, as ferramentas de escrita do agente ficam em espera.

#### Indicar elemento

1. O Produtor liga o modo **indicar elemento**.
2. Ao passar o mouse, o daemon destaca o elemento sob o cursor. Para isso, injeta um script oficial de sobreposição na página, só enquanto o modo estiver ligado.
3. O Produtor clica no elemento e escreve um comentário. Pode indicar vários elementos antes de enviar.
4. As indicações vão anexadas à mensagem do chat do cenário. O Diretor decide o que fazer e pode repassá-las ao Ator dentro da demanda.

Cada indicação vira um artefato por referência (5.10), a **indicação** (id `I<n>`), do tipo `web_element`. Esse tipo guarda:
- a URL e o título da página;
- um **seletor estável**: primeiro o papel com o nome acessível, depois o `data-testid`, e por último o CSS;
- um trecho do HTML (truncado);
- a caixa do elemento (posição e tamanho no viewport);
- um recorte do print;
- o comentário do Produtor e o momento da indicação.

O prompt leva só o id e o comentário. O resto é lido com `read_indication(id)` quando o agente precisar (P8). Se a página mudou e o seletor não acha mais o elemento, a ferramenta avisa em vez de adivinhar.

#### Indicações de outros tipos

Decidido em 2026-11-13, a pedido do dono: o mecanismo de indicar não fica preso a elementos de página.
- **Tipos de indicação** são um registro (5.18). Cada tipo traz:
  - nome e versão;
  - o schema zod do conteúdo;
  - como o conteúdo vira texto curto para o prompt;
  - como `read_indication` devolve o detalhe;
  - se ainda é válido: a página ou o arquivo pode ter mudado desde a indicação.
- **Campos comuns** a todo tipo: id `I<n>`, tipo, superfície de origem, cenário, mensagem do chat, comentário do Produtor, recorte de imagem opcional, momento. O resto fica no conteúdo do tipo.
- **Superfície** é qualquer parte que oferece o modo indicar: o navegador compartilhado é a primeira. Cada superfície declara os tipos que produz. Na interface, o modo indicar é um só: a mesma tecla, o mesmo destaque e a mesma bandeja de indicações a enviar.
- **Na v1 (Fase 12) só existe `web_element`.** Tipos e superfícies futuros, todos **[hipótese]**, entram um a um, com teste:
  - `code_snippet`: arquivo, faixa de linhas e commit, no diff ou no visualizador de arquivos;
  - `image_region`: retângulo num print ou numa imagem;
  - `dag_node` e `demand`: um nó do DAG da peça;
  - `terminal_snippet` e `event`: saída de uma sessão ou um evento do log;
  - `app_element`: tela de um emulador ou de um app de desktop, por uma porta nova com outro adaptador.
- O mecanismo segue as regras das abstrações (5.18): só módulos oficiais registram tipos de indicação. Abrir isso a plugins é parte do item 15 da seção 12.

#### Perfil e segurança

- **Perfil isolado por cenário.** É persistente, numa pasta própria nos dados do daemon. Nada dos navegadores do Produtor é importado.
- **Login.** O Produtor entra nos sites pela tela transmitida. O agente nunca vê senha nem cookie.
- **Proteções.** O perfil guarda sessões logadas, então valem três proteções:
  - os domínios permitidos do cenário;
  - a aprovação das ações de escrita;
  - o conteúdo da página tratado como dado, nunca como instrução, com a separação entre leitura e envio (5.8).
- **Registro.** Cada ação do agente no navegador vira evento `browser.*`, com a URL e um print. Uma ação de escrita é efeito colateral, com chave de idempotência (5.16).

#### Fases

- **v1, na Fase 4:** a porta, o adaptador, o perfil isolado e as ferramentas do agente, sem a tela. O agente já trabalha com o navegador.
- **Na TUI:** a TUI não mostra a página. Ela mostra a URL atual e as indicações, e pode abrir uma janela visível do navegador ao lado **[proposta]**.
- **Fase 12:** a transmissão da tela, o controle pelo Produtor e o modo indicar elemento, na web.
- **Fase 13:** o desktop aproveita a mesma tela da web.

### 5.20 Cenários: projeto, tarefa e chat

Decidido em 2026-11-13 (v0.14), a pedido do dono, e fecha a N3. As definições de cada tipo são do dono. As escolhas das subseções foram decididas por ele no mesmo dia. O que está marcado **[proposta]** é detalhe deste documento, ainda sem decisão.

#### O que todo cenário tem

Um cenário é sempre um **Diretor (Orquestrador) que conversa com o Produtor**. Todo cenário tem:
- **chat próprio**, separado dos outros cenários, com Diretor próprio;
- **pasta própria:**
  - no projeto, é o repositório;
  - na tarefa e no chat, é uma pasta nos dados do daemon (`scenarios/<id>/`);
- **anexos** de qualquer tipo;
- configuração com override da global, ordens locais (5.17) e navegador com perfil isolado (5.19);
- dashboard e trajetórias (5.13);
- um **fluxo** do registro de fluxos (5.18).

**Tipos de cenário** são um registro (5.18), e só módulos oficiais registram entradas. Cada tipo traz:
- os fluxos que aceita;
- o conjunto de ferramentas e a política de permissão padrão (5.8);
- o Diretor padrão;
- o que a tela do cenário mostra.

A v1 tem **três tipos**: projeto, tarefa e chat. As variações não viram tipo novo:
- um projeto de documentação ou de dados é um **perfil de projeto**;
- monitorar um site é uma **tarefa com gatilho**;
- pesquisar e fazer um relatório é um **chat**, ou uma **tarefa** se for repetir.

| | Projeto | Tarefa | Chat genérico |
|---|---|---|---|
| Para quê | Desenvolver software (ou outro perfil) num repositório | Um workflow de vários passos que gera um artefato final, uma vez ou recorrente | Prototipar e perguntar |
| Pasta | Repositório git | `scenarios/<id>/`, com a definição versionada e uma subpasta por execução | `scenarios/<id>/` |
| Fluxo | Peça teatral (5.4) | `task.define` (peça curta que desenha e ensaia a definição) e `task.run` (motor de passos) | `chat` (Diretor + consultor) |
| Entrega | PR, changelog, release | Artefato final entregue por plugin (e-mail, Telegram...) ou na pasta | Resposta e artefatos no chat |
| Recorrência | Peça agendada (5.15) | Gatilhos | — |

#### Projeto

Um projeto é uma pasta no disco versionada por git, com um **perfil de projeto** registrado. Não confundir com o perfil de assinatura (5.6).

- **Perfil.** O perfil padrão é **`software`**. Ele define:
  - a estrutura inicial;
  - as ferramentas e as permissões pré-definidas;
  - os artefatos que o OTheater gera e controla conforme o projeto avança:
    - changelog;
    - mensagens de commit;
    - PRs;
    - publicação no code host (`CodeHost`, 5.18; `gh` no GitHub);
    - CI (GitHub Actions ou similar);
    - releases e versões **[proposta]**.

  Outros perfis (documentação, dados) entram depois sem mudar o conceito.
- **Artefatos do perfil, gerados a partir do store [proposta].**
  - A etapa DELIVERING (5.4) monta a entrada do changelog, a mensagem do commit de merge e a descrição do PR com código, a partir das demandas, dos resultados e das decisões da peça.
  - O modelo só redige o texto livre dentro de um schema.
  - A CI é criada na estrutura inicial e, depois, como demanda comum de uma peça.
- **Criação:**
  - **projeto novo:** nasce do modelo do perfil e segue as convenções dele;
  - **repositório que já existe** (decidido em 2026-11-13): na importação, o OTheater detecta as convenções do repositório:
    - o formato do changelog;
    - o padrão de commit;
    - a CI;
    - a branch principal.

    Ele mostra ao Produtor o que achou. O Produtor confirma ou corrige, e o OTheater passa a gerar seguindo isso. As convenções ficam no cenário (`scenarios.conventions`).
- **Um repositório por projeto na v1** (decidido em 2026-11-13).
  - O modelo de dados já guarda uma lista (`scenario_repos`, seção 7).
  - Um projeto com vários repositórios (front e back, por exemplo), com worktrees e PRs coordenados, fica para depois da v1.
- **Recorrência.** Um trabalho recorrente que pertence ao repositório continua sendo uma peça agendada do projeto (5.15). Exemplo: atualizar as dependências toda semana.

#### Tarefa

Uma tarefa é um **workflow de trabalho** em que vários agentes executam passos e geram um **artefato final**. Ela pode rodar uma vez ou ser recorrente, começar num horário e ter várias etapas. Tem um Diretor associado, como todo cenário.

Exemplo do dono:
1. baixar todo dia arquivos comprimidos;
2. descomprimi-los e extrair uma informação;
3. consolidar a informação numa planilha;
4. empacotar e enviar por e-mail ou para um chat do Telegram.

O resumo diário de manchetes ([docs/10](../10-TAREFAS-GERAIS-E-AGENDAMENTO.md)) é o outro exemplo-guia.

A tarefa separa a **definição** da **execução** (decidido em 2026-11-13).

**Definição.** É versionada, fica na pasta da tarefa e é validada por schema. Contém:
- objetivo;
- entradas;
- passos;
- artefato final;
- entrega;
- gatilhos;
- orçamento por execução.

**Os papéis desenham a definição** (decidido em 2026-11-13, a pedido do dono). O Diretor fica leve e só coordena. O trabalho de desenhar vai para os papéis, e a seleção (5.7) escolhe o melhor Executor para cada um. O fluxo `task.define` é uma peça curta montada com as etapas reutilizáveis (5.18):
1. o **Autor** escreve o plano da tarefa a partir da conversa com o Produtor: objetivo, entradas, artefato final, entrega e restrições;
2. o **Revisor** revisa o plano;
3. o **Roteirista** transforma o plano em passos tipados, como faz com o DAG de demandas;
4. os **Atores** escrevem o código dos passos de código (scripts na pasta da tarefa);
5. o **Crítico** faz o **ensaio**: roda a definição inteira com dados de exemplo, sem entregar de verdade, e avalia o artefato final;
6. o Produtor aprova. Só então a definição fica ativa e pode ser agendada.

Pedir pelo chat uma mudança na tarefa abre uma nova peça `task.define` sobre a versão atual. Cada mudança gera uma versão nova, que passa por ensaio e aprovação. Por padrão, todas as versões são guardadas (chave `tasks.definition_versions`, em "Padrões e configuração").

**Passos tipados.** Os tipos de passo são um registro (5.18):

| Tipo | O que faz | Quem executa |
|---|---|---|
| `code` | Roda um script da pasta da tarefa (baixar, descomprimir, extrair, montar a planilha) | Ninguém: o motor roda o script sob o lançador (5.9) e o sandbox (5.8), sem modelo |
| `model` | Uma chamada com entrada e saída validadas por schema (resumir, classificar) | Um papel, e a seleção escolhe o Executor (ex.: modelo barato para resumir) |
| `agent` | Uma demanda com ferramentas (pesquisar na web, usar o navegador, lidar com um formato inesperado) | Um Ator, com papel, `specialty` e `complexity` como na `Demand` (5.4) |
| `approval` | Pede uma decisão ao Produtor antes de seguir | O Produtor, com as regras de "decisão sem ninguém olhando" (5.15) |
| `delivery` | Envia o artefato final | Uma ferramenta de plugin (e-mail, Telegram; 5.14) ou o `Notifier` (5.18), com destinatário fixo na definição |

Segue o "ferramenta primeiro, modelo por último" (P3, P8): o que dá para fazer com código é passo `code`. O papel e o Executor entram só onde há julgamento.

**Execução.** O fluxo `task.run` é um **motor de passos**:
- ele roda os passos da versão ativa em ordem topológica, com paralelismo limitado pela admissão (5.9);
- cada execução tem pasta própria (`scenarios/<id>/runs/<n>/`), com entradas, saídas intermediárias e o artefato final. Por padrão, as 30 últimas ficam inteiras; das mais antigas ficam o artefato final e o registro no store (chave `tasks.runs`, em "Padrões e configuração");
- cada passo de código é um efeito colateral com chave de idempotência, e a retomada (5.16) continua do último passo concluído;
- o **Diretor não acompanha a execução.** Ele só é chamado quando um passo falha depois das tentativas ou quando surge uma decisão. Nesse caso, há um ponto de julgamento com schema:
  - corrigir a definição, o que abre `task.define`;
  - repetir;
  - pular o passo;
  - parar e avisar o Produtor.

**Gatilhos** (decidido em 2026-11-13). Os gatilhos são um registro (5.18).
- Na v1:
  - rodar agora (manual);
  - uma vez;
  - cron;
  - intervalo;
  - após o reset da cota.

  São os tipos do agendador (5.15), e as regras dele (execução perdida, sobreposição, cota, decisão sem ninguém olhando, orçamento) valem igual.
- Depois da v1, entram sem mudar a tarefa:
  - arquivo novo numa pasta;
  - webhook;
  - e-mail recebido (por plugin);
  - mudança numa página.

#### Chat genérico

O chat é um **espaço de prototipação**. O Produtor conversa com o Diretor, que pode gerar artefatos, acessar páginas web para responder e trabalhar com os anexos.

- **Diretor barato que consulta um forte** (decidido em 2026-11-13):
  - o Diretor responde sozinho o que é simples;
  - quando precisa, chama `consult(question, attachments?)`. Isso abre um **Ator consultor**, um papel `consultant` com modelo forte e ferramentas de pesquisa (`http_get`, `browser_*`) e de escrita na pasta do chat;
  - o chat mostra que houve consulta, com o Executor escolhido e o motivo;
  - o Produtor pode pedir o forte numa mensagem ("use o forte"), e aí a consulta é obrigatória.

  O chat, portanto, não fica limitado a um modelo de baixa capacidade.
- **Ponto de julgamento novo:** responder sozinho ou consultar, com schema e motivo registrado.
- **Fluxo `chat` [proposta].** A conversa é uma peça de vida longa, com os estados IDLE, CONSULTING e AWAITING_PRODUCER. Cada consulta é uma tentativa, com sessão, consumo e trajetória como as outras.
- **Promoção** (decidida em 2026-11-13). O chat pode virar tarefa ou projeto a qualquer momento, por decisão do Produtor.
  - O Diretor chama `promote(type)`, que devolve um rascunho para o Produtor confirmar.
  - Nasce um **cenário novo, ligado ao chat de origem** (`scenarios.origin_id`), que recebe:
    - os anexos;
    - os artefatos escolhidos;
    - cópias das ordens locais;
    - um resumo da conversa.

    O resumo é a entrada do Autor (a necessidade da primeira peça do projeto ou do `task.define`).
  - O chat continua existindo como protótipo, com um link para o cenário novo.
  - Uma tarefa também pode virar projeto do mesmo jeito, quando passa a precisar de código versionado com PRs.

#### Anexos

Em todos os cenários, o Produtor pode enviar:
- documentos de qualquer tipo;
- caminhos de arquivo ou de pasta;
- imagens;
- texto colado;
- URLs.

Ou seja, tudo o que um cliente de agente de código aceita.

- Cada anexo é um **artefato por referência** (5.10) com id `A<n>`.
- Ele é **copiado para a pasta do cenário** ou, se for um caminho, **referenciado só para leitura**. Um caminho fora das pastas liberadas pede a liberação do Produtor (5.8).
- O daemon detecta o tipo (MIME), o tamanho e o hash. O limite de tamanho de um anexo copiado é a chave `scenarios.attachment_max_size`, com padrão de 50 MB. Um caminho só referenciado não entra no limite.
- O prompt leva só o id, o nome, o tipo e o tamanho. O conteúdo é lido com `read_attachment(id)` (P8).
- **Capacidade de entrada.** O `ClientAdapter` declara os tipos de entrada que aceita: imagem, PDF, áudio... O tipo de anexo da demanda entra como restrição na seleção (5.7): um Executor que não aceita imagem não recebe demanda com imagem. Quando nenhum aceita, o daemon converte o que der: texto do PDF, transcrição **[proposta]**.

#### Diretor adormecido

Decidido em 2026-11-13.
- Depois de um tempo sem atividade, a sessão do Diretor do cenário é encerrada para poupar cota e RAM. O tempo é a chave `scenarios.director_idle_after`, com padrão de 15 minutos.
- Ela reabre na próxima mensagem do Produtor, no próximo gatilho ou quando surgir uma decisão. Volta com o resumo gerado a partir do store, pelo mesmo mecanismo do failover (5.4). Nada se perde, porque o estado nunca esteve só no modelo.
- O cenário mostra o estado do Diretor (ativo ou adormecido). A primeira resposta depois de acordar é mais lenta e paga o prefixo do cache de novo.
- Uma execução de tarefa não acorda o Diretor, a menos que falhe ou peça decisão.

#### Padrões e configuração

Decidido em 2026-11-14 (N19), pelo dono: cada padrão é uma **chave de configuração**, com várias opções de escolha, e não um valor fixo no código.
- As chaves seguem a regra da configuração: valor global, com override por cenário (5.20, "O que todo cenário tem").
- O schema zod vem do módulo de cenários e é validado na subida (5.18).
- A aba Configurações e `ot config` mostram e mudam as chaves.

```yaml
scenarios:
  director_idle_after: 15m       # duração; 0 = nunca adormece
  attachment_max_size: 50MB      # anexo copiado; caminho referenciado não conta
tasks:
  runs:                          # quantas execuções ficam com a pasta inteira
    keep: last                   # last | days | last_or_days | all
    last: 30
    days: 90                     # usado por "days" e "last_or_days"
  definition_versions:
    keep: all                    # all | last | days
    last: 10
    days: 365
```

- **Execuções além do limite.** A pasta é podada: ficam o artefato final e o registro em `task_runs`, e saem as entradas e as saídas intermediárias. `last_or_days` mantém o que satisfizer qualquer um dos dois critérios **[proposta]**.
- **Versões da definição.** Uma versão que ainda tem execução guardada, ou que é a ativa, nunca é apagada, qualquer que seja o valor da chave **[proposta]**.

#### Eventos

- `scenario.*`: criação, importação (com as convenções detectadas), promoção, anexo recebido, Diretor adormecido ou acordado.
- `task.*`: versão da definição criada, ensaio, aprovação, execução iniciada, passo concluído ou falho, artefato final, entrega.

### 5.21 Durabilidade e recuperação

Decidido em 2026-11-13 (v0.15), a partir de uma pergunta do dono: o que acontece ao fechar a interface, ao reiniciar a máquina ou numa queda de energia, já que há tarefas recorrentes, agendamentos e eventos. Esta seção junta o que já estava espalhado (5.1, 5.4, 5.5, 5.15, 5.16, 5.17 e 5.20) e acrescenta quatro decisões: gravação durável, reconciliação na subida, comportamento sem login e backup. O que está marcado **[proposta]** é detalhe deste documento, ainda sem decisão.

#### O que sobrevive a quê

| Situação | O que acontece | Onde |
|---|---|---|
| Fechar o app, a TUI ou a web | Nada para: o daemon é outro processo. Ao reabrir, a interface lê o estado e o log de eventos pela API | P7 |
| Daemon cai ou é reiniciado | Sobe, faz a reconciliação (abaixo) e retoma cada peça, tarefa e chat | 5.1, 5.16 |
| Máquina reinicia com login | O serviço de logon sobe o daemon; reconciliação; agendamentos perdidos seguem a regra da janela | 5.15 |
| Queda de energia | Igual ao reinício. Nenhuma transação confirmada no store se perde (gravação durável, abaixo); o que estava em memória se perde e é refeito | esta seção |
| Máquina religada sem ninguém fazer login | Na v1, nada roda até o login (abaixo) | esta seção |
| Arquivo do store perdido ou corrompido | `ot restore` do backup mais recente | esta seção |

Tudo o que importa fica no store (P4): cenários, peças e snapshots XState, demandas, tentativas, sessões, ordens, agenda, definições e execuções de tarefa, anexos (o registro; o arquivo fica na pasta do cenário), decisões, fila de prompts e o log de eventos.

#### Gravação durável

Decidido em 2026-11-13: **`synchronous=FULL` sempre**.
- O store abre com `journal_mode=WAL` e `synchronous=FULL`. No macOS, também `fullfsync=ON`, porque lá o `fsync` comum não esvazia o cache do disco **[a confirmar na Fase 1]**.
- Segundo a documentação do SQLite (pragma `synchronous`), em WAL com `NORMAL` o banco não corrompe, mas uma transação confirmada pode ser desfeita depois de uma queda de energia; com `FULL`, cada commit fica no disco **[fonte secundária; conferir na Fase 1]**.
- O daemon grava pouco (eventos, transições, filas), então o custo extra deve ser pequeno **[hipótese]**. A Fase 1 mede.
- **Gravar antes de agir:** toda mudança de estado é gravada, numa transação, antes do efeito que ela dispara. Exemplos:
  - a mensagem do Produtor entra no store (e na `prompt_queue`) antes de ir para o Diretor, então um prompt na fila não se perde;
  - a transição da máquina XState é gravada antes de abrir a sessão ACP correspondente;
  - o "antes" de um efeito colateral (5.16) é gravado antes da chamada.

#### Reconciliação na subida

Decidido em 2026-11-13: uma **rotina explícita**, que roda antes de retomar qualquer coisa. Ela substitui os quatro passos que a 5.1 listava até a v0.14. Durante a rotina, a API responde e a interface mostra "recuperando", mas os comandos que mudam estado esperam.

1. **Lock e integridade.** Pega o lock de instância (5.1) e roda `PRAGMA quick_check` **[proposta]**. Se falhar, o daemon não sobe sozinho: avisa e oferece `ot restore`.
2. **Processos órfãos.** A tabela `sessions` guarda o pid e o instante de início de cada processo (para não confundir com um pid reaproveitado). O daemon mata pelo `ProcessLauncher` as árvores que ainda estiverem vivas e fecha o navegador do cenário que ficou sem dono (5.19).
3. **Sessões.** Toda sessão `active` vira `interrupted`, com causa `restart`.
4. **Worktrees.** O que ficou sem commit desde o último checkpoint vira um commit `wip(recovery)` na branch da tentativa, em vez de ser descartado **[proposta]**.
5. **Efeitos ambíguos.** Um efeito com "antes" e sem "depois" em `side_effects` não é repetido às cegas:
   - se a ferramenta tem **verificador**, o daemon consulta o mundo de fora e marca o efeito como `done` ou `not_done`. Exemplos: o commit com a chave de idempotência no trailer existe na branch? A ref chegou ao remoto? Existe PR aberto para a branch? **[proposta]**;
   - sem verificador, a demanda pausa e o Produtor decide no chat (feito, refazer ou cancelar).

   Cascas oficiais com efeito fora da worktree trazem verificador. Plugins com `external_write` podem declarar uma ferramenta de verificação no manifesto (5.14).
6. **Retomada.** Reidrata as máquinas XState; cada sessão interrompida segue a política da 5.16; cada execução de tarefa volta do último passo concluído (5.20); o Diretor de cada cenário volta adormecido e acorda pelo resumo quando houver o que fazer.
7. **Agenda e ordens.** Recalcula os disparos perdidos pela regra da janela (5.15) e a vigência das ordens (5.17).
8. **Relato.** Evento `daemon.recovered` com o resumo (sessões retomadas, efeitos resolvidos, pendências) e uma mensagem de sistema no chat de cada cenário afetado.

#### Máquina religada sem login

Decidido em 2026-11-13: **na v1, espera o login**; a meta, depois da v1, é o **daemon completo sem login**. Pedido do dono: começar pelo simples e migrar depois. Em 2026-11-14 o dono decidiu que a migração é uma fase própria, a **Fase 10b**, logo depois da v1 (seção 10).

**v1:**
- O daemon continua sendo serviço de logon (Fase 10). Sem login, nada roda.
- No login, o daemon sobe, faz a reconciliação, e a regra da janela (5.15) decide o que roda dos disparos perdidos.
- O gatilho do sistema operacional (5.15) é registrado para rodar só com o usuário conectado. Ele continua acordando a máquina **suspensa**, que tem a sessão aberta. Uma máquina **desligada** não é ligada por ele. Os nomes da opção em cada sistema (Agendador de Tarefas, LaunchAgent do launchd, timer do systemd de usuário sem `linger`) **[a confirmar na Fase 0]**.
- Motivo: o cofre de chaves do sistema costuma ficar trancado até o login **[hipótese]**, e sem ele as assinaturas e chaves não estão disponíveis.

**Fase 10b, o daemon completo sem login** **[proposta]**:
- o daemon passa a ser serviço que roda sem sessão: systemd de usuário com `loginctl enable-linger`, tarefa do Windows "executar estando o usuário conectado ou não", LaunchDaemon com `UserName` no macOS **[a confirmar]**;
- os segredos passam a vir de um adaptador de `SecretVault` que destranca sem ninguém digitar nada. Qual (mecanismo nativo da máquina, como DPAPI, TPM ou `systemd-creds`, ou arquivo cifrado com chave protegida por permissão) é decidido ao abrir a Fase 10b, depois da medição (seção 12, item 17). O critério já está decidido: preferir o mecanismo nativo de cada sistema que não exige senha digitada, e nunca guardar segredo em texto claro;
- os próprios clientes (Claude Code, Codex, OpenCode) guardam o login deles. Se dependerem do cofre da sessão, também falham sem login **[hipótese]**. A Fase 10b começa por essa medição.

**Regras da v1 para a migração sair barata:**
- nada essencial do daemon depende de sessão gráfica. A notificação do sistema operacional é opcional, e o navegador do cenário roda sem janela quando ninguém está olhando;
- todo segredo passa pela porta `SecretVault` (5.18), nunca por variável de ambiente lida direto;
- o modo de instalação é assunto do instalador (Fase 10), não do núcleo. Passar a rodar sem login muda o instalador e o adaptador do cofre, não o daemon **[hipótese]**.

#### Backup

Decidido em 2026-11-13: **automático e diário, guardando 7**. Os padrões abaixo foram decididos em 2026-11-14 (N21) e, como os dos cenários, são chaves de configuração.
- Uma cópia consistente do store é feita com o daemon no ar, pela API de backup online do SQLite (`backup()` do `better-sqlite3`) ou por `VACUUM INTO` **[a escolher na Fase 1]**.
- **Quando:** uma vez por dia, na primeira oportunidade a partir das 3h. Se a máquina estava desligada ou suspensa, o backup roda na primeira subida depois.
- **Onde:** na pasta `backups/` dos dados do daemon, com rotação de 7 cópias. Na primeira execução guiada (Fase 10), o daemon avisa que a pasta está no mesmo disco e sugere apontar outro.
- `ot backup` faz uma cópia na hora; `ot restore <file>` só roda com o daemon parado e guarda o store atual antes de trocar.
- Cada cópia passa por `PRAGMA integrity_check` antes de entrar na rotação. Uma cópia que falha gera aviso no chat global **[proposta]**.
- **O que entra:** por padrão, o store e as pastas dos cenários de tarefa e chat, menos as pastas `runs/`. Assim entram a definição, os scripts das tarefas e os anexos copiados. De cada execução entra só o artefato final. Os projetos não entram, porque já estão no git.
- Configuração:

  ```yaml
  backup:
    when: daily_after            # daily_after | on_idle | manual
    after: "03:00"
    idle: 30m                    # usado por "on_idle": sem peça nem tarefa rodando
    dir: <data>/backups
    copies: 7
    content: without_runs        # store_only | without_runs | all
  ```

  A chave é só global, sem override por cenário.
- Evento `daemon.backup` com o resultado.

#### O que se perde (aceito)

- A resposta que o modelo estava gerando no momento da queda. A sessão é retomada (5.16) e a resposta é refeita.
- O estado das páginas abertas no navegador do cenário. O perfil (cookies, logins) fica, e o agente reabre a última URL de `browser_sessions`.
- Arquivos que o Executor gravou logo antes de uma queda de energia e que o sistema ainda não tinha levado ao disco. O passo 4 da reconciliação salva o que estiver no disco.
- Disparos agendados fora da janela (5.15): são pulados e registrados, não executados.

#### Testes

- **Fase 1:** um backup feito com o daemon no ar abre e passa no `integrity_check`; `ot restore` devolve o estado; mede o custo do `FULL`.
- **Fase 3:** `kill -9` do daemon no meio de um efeito colateral. Na subida, a reconciliação mata o processo órfão do cliente, resolve o efeito pelo verificador (ou pergunta ao Produtor), e nada se repete.
- **Fase 11:** queda de energia simulada (VM desligada à força) com uma peça, uma tarefa agendada e um chat em curso. O store abre íntegro, nenhuma transação confirmada se perde, e tudo retoma pela reconciliação.

### 5.22 Idioma e internacionalização

Decidido em 2026-11-14 (v0.17), a partir de uma pergunta do dono: padronizar em inglês o código, as skills e o material do daemon, com a interface em inglês e português do Brasil. Os detalhes desta seção e os nomes do glossário foram aprovados pelo dono no mesmo dia.

#### O que é em inglês

- **Código:** identificadores, nomes de arquivo e pasta, comentários e mensagens de commit do repositório do OTheater.
- **Dados e contratos:** tabelas e colunas do store, schemas zod, estados das máquinas XState, tipos de evento, códigos de erro.
- **Configuração:** chaves e valores (`scenarios.*`, `tasks.*`, `backup.*`, `roles.*`, `adapters.*`, `ui.*`), manifestos de plugin e definições de tarefa.
- **Superfície para agentes e scripts:** ferramentas MCP do framework, comandos e opções do `ot`, a API do daemon.
- **Logs** (pino) e atributos de telemetria.
- **Prompts e skills** que o daemon manda aos agentes, em `prompts/`. Motivo: um prefixo único e estável para o cache (5.10), e os modelos seguem instrução em inglês pelo menos tão bem quanto em português **[hipótese]**.

#### O que segue o Produtor ou o projeto

- **Respostas ao Produtor** (Diretor, Consultor, decisões no chat): no idioma do Produtor. O mecanismo é uma ordem global do tipo `instruction` (5.17), por exemplo "Respostas em português do Brasil". O prompt de cada papel continua em inglês. A primeira subida já oferece essa ordem, conforme o `ui.locale`.
- **O que os agentes escrevem num projeto do Produtor** (commits, changelog, PRs, comentários): segue as convenções do projeto, detectadas na importação ou definidas pelo perfil (5.20), não a regra deste documento.
- **Este repositório de desenho:** o texto continua em português do Brasil. Os identificadores citados passam a ser os nomes em inglês desde a v0.17, e os comentários dentro dos exemplos de configuração podem ficar em português.

#### Interface (TUI, web, desktop e Android)

- **Catálogo de textos desde a primeira tela**, com `en` e `pt-BR` completos. Nenhum texto de tela fica escrito direto no componente.
- Os catálogos ficam em `locales/` e são carregados pelo `packages/client`, compartilhado por todas as interfaces. O app Android usa o catálogo da web.
- A biblioteca de i18n é escolhida na Fase 1.
- O idioma vem do sistema operacional e a chave `ui.locale` troca:

```yaml
ui:
  locale: auto     # auto | en | pt-BR
```

- Com `auto`, um locale `pt-*` vira `pt-BR`, e qualquer outro vira `en`.
- Erros chegam à interface pelo código em inglês (5.18), e o catálogo traz o texto de cada código.
- O painel declarativo de um plugin (5.14) traz o próprio catálogo, com `en` obrigatório; o que faltar em `pt-BR` aparece em inglês.
- Datas, números e durações são formatados pelo `Intl` do runtime, conforme o locale.

#### Glossário canônico

Cada conceito tem um nome em inglês, usado no código, na configuração e nos prompts, e um nome em português, usado no texto deste repositório e na interface em `pt-BR`. A tabela fica na seção 13. Os nomes em inglês foram aprovados pelo dono em 2026-11-14. Dois casos pedem atenção:
- Roteirista é `scriptwriter`, e não *playwright*, para não colidir com o Playwright do navegador compartilhado (5.19);
- ordem é `directive`, e não *order*: as tabelas, ferramentas e eventos usam `directive`.

#### Testes

- **Fase 1:** a CI reprova chave presente num catálogo e ausente no outro, e texto de tela fora do catálogo.
- **Fase 7:** a TUI inteira em `en` e em `pt-BR`, trocando por `ui.locale` sem reiniciar o daemon.

## 6. Reaproveitamento: o que usar pronto

Levantamento de 2026-11-13, filtrado pela política de licenças abaixo.

### 6.0 Política de licenças

O código próprio do projeto é **MPL-2.0**. Decidido em 2026-11-14 (N23), pelo dono, no lugar da MIT, depois de uma pergunta sobre uso comercial. Decisão de 2026-11-13, mantida: **MIT e Apache-2.0 são igualmente aceitas**, junto com as demais licenças permissivas comuns no ecossistema. Desde 2026-11-14, a **MPL-2.0** também é aceita em código copiado e em dependências.

**O que a MPL-2.0 significa aqui.** Leitura deste documento, a conferir no texto oficial da licença (mozilla.org/MPL/2.0) antes de publicar **[a confirmar]**:
- o copyleft vale **por arquivo**: quem altera um arquivo do OTheater e distribui o programa precisa oferecer o código-fonte daquele arquivo, sob MPL-2.0;
- arquivos novos, separados, podem ter outra licença, inclusive fechada. Um produto comercial pode juntar o núcleo MPL-2.0 com módulos próprios fechados (a "obra maior" da licença);
- vender é permitido, para o dono e para qualquer outra pessoa que distribua o código;
- a licença traz concessão de patentes pelos contribuidores, como a Apache-2.0;
- o dono, como autor, pode licenciar o próprio código também de outra forma. O código de terceiros que entrar por contribuição fica só sob MPL-2.0, a menos que haja um acordo (seção 12, item 18).

**Obrigações do código próprio** **[proposta]**:
- `LICENSE` na raiz com o texto da MPL-2.0, a partir da Fase 1;
- cabeçalho do Anexo A da MPL-2.0 (ou a linha `SPDX-License-Identifier: MPL-2.0`) em todo arquivo de código, conferido pelo verificador de cabeçalho da CI;
- sem o aviso do Anexo B ("Incompatible With Secondary Licenses"), para o código continuar compatível com a GPL de quem quiser combiná-lo.

**Lista de licenças:**

| Situação | Licenças | Onde valem |
|---|---|---|
| **Permitidas** | MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, MPL-2.0 | Em todos os níveis: código copiado, fork, dependências empacotadas |
| **Proibidas** | GPL, AGPL, LGPL (copyleft forte ou de biblioteca) | Em código copiado e em dependências empacotadas. Também não se lê código AGPL para reproduzir desenho, para evitar contaminação por semelhança |
| **Caso a caso** | Qualquer outra (ELv2, BSL, MPL-1.1, source-available, sem licença) | Precisa de decisão registrada nesta seção |

**Níveis de uso.** A lista acima vale para os níveis A e B. Os níveis C e D são mais flexíveis:

| Nível | O que é | Regra |
|---|---|---|
| **A. Código copiado ou fork** | Trechos trazidos para o repositório; fork de projeto | Licenças permitidas + obrigações abaixo |
| **B. Dependência empacotada** | Pacote npm/crate que vai no instalador, inclusive transitivo | Licenças permitidas |
| **C. Ferramenta externa** | Programa executado como processo separado e instalado à parte (Claude Code, Codex, git, gh, LiteLLM, Phoenix) | A licença não se propaga para o nosso código; basta permitir o uso. Proprietárias são aceitas |
| **D. Só desenvolvimento** | Compilador, testes, validadores que não vão no instalador | Licenças permitidas ou caso a caso |

**Obrigações de Apache-2.0 (níveis A e B):**
1. **Licença e cabeçalhos:** arquivos copiados mantêm o cabeçalho e continuam sob Apache-2.0. Eles não são relicenciados como MPL-2.0. O repositório fica MPL-2.0, com arquivos Apache identificados.
2. **NOTICE:** o conteúdo do arquivo `NOTICE` de cada projeto Apache usado vai para o `THIRD_PARTY_NOTICES` e para o instalador.
3. **Modificações:** arquivo Apache alterado ganha no cabeçalho a indicação de que foi modificado.
4. **Fork:** o código original do fork segue Apache-2.0 e o que escrevermos é MPL-2.0. A distribuição cumpre os termos da Apache.

**Obrigações da MPL-2.0 de terceiros (níveis A e B)** **[proposta]**:
1. arquivos copiados de projeto MPL-2.0 mantêm o cabeçalho e continuam sob MPL-2.0;
2. um pacote MPL-2.0 alterado por nós tem as alterações publicadas sob MPL-2.0, e o instalador aponta onde está o código-fonte de cada arquivo MPL distribuído;
3. o `THIRD_PARTY_NOTICES` lista os pacotes MPL-2.0 e onde obter o código-fonte deles.

A Apache-2.0 traz ainda **concessão explícita de patentes** pelos contribuidores, com cláusula de retaliação contra quem processar por patente. Isso não afeta o nosso uso.

**Automação na CI:**
- verificador de licenças sobre toda a árvore de dependências empacotadas, comparando com a lista de permitidas (com MPL-2.0); licença proibida ou caso a caso não registrada falha o build;
- o `THIRD_PARTY_NOTICES` é gerado automaticamente, com as licenças e os `NOTICE` dos pacotes Apache;
- um verificador de cabeçalho confere que arquivos copiados de projetos Apache ou MPL mantêm o aviso e que os arquivos próprios têm o cabeçalho MPL-2.0.

### 6.1 Dependências (nível B)

| Necessidade | Projeto | Licença |
|---|---|---|
| Cliente ACP | `@agentclientprotocol/sdk` 2.x | Apache-2.0 |
| Servidor/cliente MCP + filtro por papel | MCP SDK v2 (`@modelcontextprotocol/server` / `client`) | MIT |
| Máquina de estados persistível | XState v5 | MIT |
| HTTP, SSE, WebSocket | Hono + `@hono/node-server` | MIT |
| Validação | zod | MIT |
| SQLite | `better-sqlite3` (ou `node:sqlite`, parte do Node) | MIT |
| Query builder | Kysely | MIT |
| Processos e kill de árvore | execa 10 (`killDescendants`) | MIT |
| Telemetria | OpenTelemetry JS | Apache-2.0 |
| Sandbox (macOS/Linux; Windows em alpha) | `@anthropic-ai/sandbox-runtime`, como biblioteca ou envoltório | Apache-2.0 |
| Cofre | `@napi-rs/keyring` | MIT |
| Logs técnicos | pino | MIT |
| Agendamento (cron com fuso) | croner | MIT **[a confirmar]** |
| Histórico de consumo | ccusage (biblioteca, se exportar API; senão nível C, como CLI) | MIT |
| Front | React, Vite, TanStack Query, shadcn/ui, assistant-ui, @xyflow/react | MIT |
| Desktop (opcional, Fase 13) | Electron + electron-builder (ou Tauri v2, MIT/Apache) | MIT |
| App Android (Fase 14) | Capacitor (`@capacitor/core`, `@capacitor/android`) e plugins oficiais | MIT **[a confirmar]** |
| TUI | Ink + `@inkjs/ui` (alternativa: OpenTUI, decisão na Fase 0) | MIT |
| Estado compartilhado TUI/web (`packages/client`) | zustand (modo vanilla) | MIT |
| Job Object (lançador Rust) | crate `win32job` | MIT/Apache |

### 6.2 Ferramentas externas e de desenvolvimento (níveis C e D)

| Componente | Licença | Nível | Observação |
|---|---|---|---|
| `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp` | Apache-2.0 | C (e A, se adaptarmos o código) | Processos separados; o código pode ser copiado e ajustado se for preciso |
| Claude Code | Proprietário | C | O próprio Executor |
| Codex CLI | Apache-2.0 | C | O próprio Executor |
| OpenCode | MIT | C | O próprio Executor |
| Gemini CLI | Apache-2.0 | C | Opcional |
| LiteLLM | MIT no núcleo (pasta `enterprise` à parte) | C | Gateway opcional |
| Arize Phoenix | ELv2 (source-available) | C | **Caso a caso, aceito como ferramenta local opcional**; nunca embutido nem distribuído |
| Harbor (validador ATIF) | Apache-2.0 | D | Testes de conformidade das trajetórias |
| TypeScript, Playwright, Vitest | Apache-2.0 / MIT | D | Desenvolvimento |

### 6.3 Código para copiar ou adaptar (nível A)

| Projeto | Licença, stack | O que aproveitar |
|---|---|---|
| **Emdash** (`generalaction/emdash`) | Apache-2.0, TS | Runtime ACP em stdio (`packages/core/src/runtimes/acp`), adaptadores claude/codex, agentes paralelos em worktrees. **Principal candidato a base de fork** |
| **acpx** (`openclaw/acpx`) | MIT, TS | Cliente ACP headless com sessões persistentes e eventos NDJSON: referência para `executors/` |
| **AionUi** | Apache-2.0, TS | Delegação líder/equipe sobre ACP com vários backends |
| **Orca** (`stablyai/orca`) | MIT, TS | Daemon + CLI, worktrees, DAG de tarefas |
| **ccmanager** | MIT, TS | Gestão de worktrees, `.worktreeinclude`, detecção de estado do agente (ocioso/ocupado/aguardando) |
| **rivet-dev/agents** | Apache-2.0, TS | Agentes de código atrás de uma API HTTP |
| **Happier** (`happier-dev/happier`) | MIT, TS | Interface web/desktop/mobile para vários agentes ACP |
| **Paradev** (`ParadevAI/Paradev`) | MIT, TS | Sessões paralelas em worktrees |
| **Nimbalyst** (sucessor do Crystal) | MIT **[a confirmar]**, TS | Gestão de sessões paralelas |
| **claude-agent-acp / codex-acp** | Apache-2.0, TS | Ajustes nos adaptadores, se precisarmos |
| **Harbor** | Apache-2.0, Python | Modelos do ATIF, para portar o schema para zod |
| **Vibe Kanban** | Apache-2.0, Rust | Executores ACP e worktree por tarefa (desenho; o código é Rust) |
| **CodexBar** | MIT, Swift | Como obter a cota de cada provedor (lógica a portar) |
| **1MCP** (`@1mcp/agent`) | TS **[licença a confirmar]** | Agregação de MCPs com filtro por tags. Se a licença for permitida, pode rodar como sidecar; senão, o agregador é próprio (5.9) |
| **AgentPrism** | React **[licença a confirmar]** | Viewer de trajetórias. Se a licença não for permitida, componente próprio |

### 6.4 Avaliar como base de fork (Fase 0)

Candidatos, em ordem:
1. **Emdash** (Apache-2.0): o melhor encaixe técnico (runtime ACP em TS, adaptadores claude/codex, worktrees);
2. **Orca** (MIT): daemon + CLI e DAG de tarefas;
3. **AionUi** (Apache-2.0): orquestração líder/equipe sobre ACP;
4. **Paradev** e **Happier** (MIT).

O que **nenhum** deles tem é o nosso diferencial: pipeline teatral com papéis, Crítico e escalonamento; seleção por prioridade × cota com várias assinaturas; permissões por papel; ATIF.

Critérios da avaliação:
1. licença do projeto e de **todas** as dependências que o fork arrasta dentro da lista permitida (GPL, AGPL ou LGPL reprova);
2. o núcleo roda como daemon separado da UI, com API (ou pode ser separado sem reescrever);
3. a arquitetura aceita a máquina de estados por cima sem brigar com o modelo deles;
4. qualidade de código e testes;
5. ritmo de mudanças upstream (fork que diverge cedo vira manutenção dobrada).

Padrão até a avaliação: **projeto próprio** com as dependências de 6.1 e trechos de 6.3. Se um fork passar, ele reduz a Fase 2 (runtime ACP, worktrees) e parte da Fase 12. Com a TUI como interface principal (v0.6), a interface gráfica desses candidatos pesa pouco (ver seção 10).

### 6.5 Avaliados e descartados

| Projeto | Motivo |
|---|---|
| Claude Squad, coder/mux, Toad | AGPL |
| Mastra workflows | Partes sob licença enterprise e dependência grande demais para um processo único; XState + SQLite basta |
| Drizzle ORM | Licença agora permitida, mas o Kysely já atende; sem motivo para trocar |
| DBOS TS, Absurd | Só Postgres |
| Temporal, Inngest, Restate | Servidor separado; desproporcional para um daemon local |
| Ruflo (ex-claude-flow) | App opinativo, não biblioteca |
| LangGraph.js | Não acrescenta sobre XState para um fluxo determinístico |
| Vercel AI Elements | Será descontinuado no fim de novembro de 2026 |
| MetaMCP, Docker MCP Gateway | Pesados (Postgres/containers) para embutir |
| coder/agentapi | Arquivado |
| Crystal | Descontinuado (sucessor: Nimbalyst) |

## 7. Modelo de dados (SQLite, WAL)

| Tabela | Conteúdo |
|---|---|
| `profiles` | id, cliente, tipo (`token_plan`/`api`), provedor, estado (`active`/`draining`/`removed`), diretório, referência do segredo |
| `executors` | id, profile_id, modelo, esforço, provedor do modelo (`provider`, 5.7), estado de validade |
| `roles` | papel, escopo (global, cenário ou tarefa agendada), scenario_id ou schedule_id, lista ordenada de executores, regra de esgotamento; a predefinição e os perfis permitidos por escopo (5.7) |
| `scenarios` | id, tipo (projeto/tarefa/chat), fluxo padrão (id do registro de fluxos, 5.18), nome, pasta, perfil de projeto e convenções detectadas (JSON, só projeto; 5.20), branch base, override de configuração, cenário de origem (promoção), estado do Diretor (ativo/adormecido), estado (ativo/arquivado) |
| `scenario_repos` | repositórios de um projeto (5.20): caminho, remoto, branch principal. Um por projeto na v1 |
| `task_definitions` | versão da definição de uma tarefa (5.20): objetivo, entradas, passos (JSON validado pelo registro de tipos de passo), artefato final, entrega, gatilhos, orçamento, estado (`draft`/`rehearsed`/`active`/`superseded`), peça `task.define` que a gerou, resultado do ensaio |
| `task_runs` | execução de uma tarefa (5.20): versão da definição, gatilho, pasta (e se foi podada pela retenção), estado de cada passo, artefato final, entrega, consumo, resultado |
| `attachments` | anexo `A<n>` (5.20): cenário, mensagem do chat, nome, tipo MIME, tamanho, hash, cópia na pasta ou caminho referenciado (só leitura) |
| `plays` (peças) | id, scenario_id, necessidade, id e versão do fluxo (5.18), snapshot XState, contadores, timestamps |
| `stages` | etapas executadas de cada peça (papel, tentativa, resultado) |
| `demands` | demandas do roteiro (campos de `Demand`), estado |
| `attempts` | tentativa por demanda: executor, worktree, branch, sessão ACP, início/fim, commit WIP, resultado estruturado; contador de retomadas; último checkpoint; último evento processado |
| `sessions` | sessões ACP: processo (pid e instante de início, para achar órfãos na subida; 5.21), perfil, papel, worktree, id da sessão no cliente (para `session/load`), estado (`active`/`interrupted`/`awaiting_resume`/`resuming`/`closed`) |
| `interruptions` | interrupção de uma sessão: causa classificada, sinais que a indicaram, forma de retomada (nativa/bastão), Executor de origem e destino, se contou como tentativa |
| `side_effects` | efeitos colaterais por chave de idempotência (`attempt + step`): ferramenta, parâmetros resumidos, resultado gravado, momento antes/depois, estado (`pending`/`done`/`not_done`/`ambiguous`) e como a ambiguidade foi resolvida (verificador ou Produtor; 5.21) |
| `prompt_queue` | fila única de prompts do Orquestrador (origem, prioridade, estado) |
| `decisions` | pontos de julgamento: tipo, entrada, resposta, quem decidiu |
| `blackboard` | chave, versão, conteúdo (plano, roteiro, contratos, decisões) |
| `events` | id crescente, timestamp, scenario/play/attempt, tipo, payload JSON |
| `quota_snapshots` | perfil, janela, uso, reset, fonte do sinal |
| `usage` | consumo por sessão/perfil/janela: tokens, custo real (API) ou equivalente em API (assinatura), fonte do valor (`client`/`pricing_table`) e versão da tabela de preços (5.6) |
| `wakeups` | despertar interno (5.6): perfil, causa (`quota`/`budget`), horário, estado, id do gatilho no sistema operacional |
| `plugins` | manifesto (com o painel declarativo e os tipos de evento), versão, estado, projetos ativos |
| `browser_sessions` | sessão do navegador compartilhado (5.19): cenário, pasta do perfil, domínios permitidos, URL atual, quem controla (agente/Produtor), estado |
| `indications` | indicação `I<n>` (5.19): tipo e versão do tipo, superfície de origem, cenário, mensagem do chat, conteúdo JSON (validado pelo schema do tipo; para `web_element`: URL, título, seletor, trecho do HTML, caixa), caminho do recorte, comentário, criada em |
| `schedules` | tarefa agendada: cenário, necessidade (projeto) ou tarefa e versão da definição (5.20), tipo (uma vez/cron/intervalo/após reset), expressão e fuso, overrides, política de entrega, orçamento, regras (perdida, sobreposição, cota, decisão), próximo disparo, estado, id do gatilho no sistema operacional |
| `directives` | ordem do Produtor (5.17): id `O<n>`, escopo (global/cenário), scenario_id, tipo (`instruction`/`rule`/`suspension`), texto, chave e valor (para `rule`), ordem suspensa (para `suspension`), papéis, início, fim, fuso, janela (cron + duração; depois da v1), estado (`scheduled`/`active`/`expired`/`revoked`), criada em, origem (chat/TUI/terminal/importação), substitui, revogada em, motivo. As mudanças de vigência ficam nos eventos `directive.validity_changed` |
| `schedule_runs` | execução de uma tarefa: horário previsto e real, motivo (horário, atraso, rodar agora), peça gerada, resultado, notificações enviadas |

Acesso via **Kysely** (MIT; query builder tipado) sobre `better-sqlite3`, dentro do adaptador padrão da porta `Store` (5.18). O resto do daemon não vê SQL. No Electron, o `better-sqlite3` exige rebuild do módulo nativo; `node:sqlite` do Node 24 é alternativa sem binário nativo, a avaliar na Fase 1. Migrations versionadas com o migrator do próprio Kysely. O store abre com `journal_mode=WAL` e `synchronous=FULL` (e `fullfsync` no macOS) e tem backup diário (5.21).

## 8. Stack

| Área | Escolha |
|---|---|
| Runtime | Node 24 LTS |
| Linguagem | TypeScript strict |
| Contratos | `@otheater/core`: portas (interfaces) + schemas zod, semver por porta; suítes de conformidade em `@otheater/sdk` (5.18) |
| Montagem | Composição manual num ponto de montagem (`compose.ts`), sem container de injeção nem decorators |
| Monorepo | pnpm workspaces |
| ACP | `@agentclientprotocol/sdk` 2.x + adaptadores como processos externos |
| MCP | `@modelcontextprotocol/server` / `client` (SDK v2) |
| Fluxo | XState v5 |
| HTTP | Hono + `@hono/node-server` |
| Validação | zod |
| Banco | `better-sqlite3` (ou `node:sqlite`) + Kysely |
| Processos | execa 10 + lançador Rust (`win32job`) no Windows |
| Sandbox | `@anthropic-ai/sandbox-runtime` (macOS/Linux; Windows em piloto) |
| Cofre | `@napi-rs/keyring` |
| Git | CLI `git` + `gh` |
| Consumo | ccusage |
| Telemetria | OpenTelemetry JS + receptor OTLP no daemon |
| Logs técnicos | pino |
| Agendamento | croner (cron com fuso) + gatilho do agendador do sistema operacional |
| TUI (interface principal) | Ink + `@inkjs/ui` (ou OpenTUI, conforme o teste da Fase 0) |
| Cliente e estado compartilhados | `packages/client`: cliente REST/SSE/WS + stores zustand (vanilla) |
| Web (depois da v1; base do Android) | React + Vite + shadcn/ui + assistant-ui + @xyflow/react |
| Desktop (opcional) | Electron (ou Tauri v2) |
| Android (celular e tablet) | Capacitor sobre a web |
| Navegador compartilhado | Playwright (Apache-2.0) sobre CDP, Chromium com perfil isolado por cenário (5.19) |
| Testes | Vitest + Playwright + `ink-testing-library` (TUI) |

**Agente simulado para testes** (`packages/fake-agent`), construído com o lado `agent()` do próprio SDK do ACP. Responde roteiros determinísticos: edita arquivo, chama ferramenta, falha, estoura tempo, pede permissão, emite sinal de cota. A máquina de estados, os pools e a UI são testados sem gastar cota.

**Testes de contrato dos adaptadores:** fazem parte das suítes de conformidade de `ClientAdapter` e `AgentSession` (5.18). Uma suíte curta roda contra cada adaptador real fixado (`initialize`, config options, MCP HTTP, cancelamento) e é executada a cada atualização de versão (P10).

## 9. Estrutura do repositório

**Nome, pacotes e comando.** Conferido em 2026-11-13. Repetir a conferência antes de publicar, porque nomes livres podem ser tomados.

| Item | Escolha | Situação na conferência |
|---|---|---|
| Produto | **OTheater** (*Orchestration Theater*) | — |
| Pacote principal no npm | `otheater` | Livre |
| Pacotes internos | escopo `@otheater/*` (`@otheater/daemon`, `@otheater/client`, `@otheater/tui`…) | Nome livre no registro. A criação da organização `otheater` no npm não dá para conferir sem login: confirmar ao criar |
| Comando de terminal | **`ot`** (curto, uso diário) + `otheater` (nome completo, mesmo programa) | Os pacotes `ot` e `oth` existem no npm, mas são bibliotecas antigas sem comando de terminal: não colidem. Não há comando `ot` padrão em Windows, macOS ou Linux. Conferir de novo na Fase 10, antes de registrar o `ot` no instalador |
| Organização no GitHub | **`orchestration-theater`** | Livre. `otheater` já é uma conta de usuário criada em 2021, sem repositórios públicos |
| Alternativas reservas | `otheatre` (npm e GitHub livres) | — |
| Marca | — | Não conferida. Consultar o INPI (e o registro do país de distribuição) se o produto for distribuído |

```
/
├─ packages/
│  ├─ core/            portas (interfaces), schemas zod do domínio, erros tipados, lógica pura; só depende do zod (5.18)
│  ├─ sdk/             para escrever adaptadores e plugins: tipos, utilitários e suítes de conformidade (antigo plugin-kit)
│  ├─ protocol/        contrato da API com as interfaces: REST, SSE, WS, eventos, ATIF (usa os schemas do core)
│  ├─ adapters/        um pacote @otheater/adapter-* por adaptador
│  │  ├─ client-claude-code/  client-codex/  client-opencode/  client-gemini/
│  │  ├─ session-acp/  session-headless/
│  │  ├─ quota-claude/  quota-codex/  quota-minimax/  quota-rate-limit/
│  │  ├─ store-sqlite/  vault-keyring/  vault-file/
│  │  ├─ vcs-git/  codehost-github/
│  │  ├─ sandbox-runtime/  telemetry-otel/  export-atif/  browser-playwright/
│  │  └─ platform-windows/  platform-posix/   (lançador, gatilho do SO, manter acordado, monitor de RAM)
│  ├─ daemon/
│  │  ├─ src/compose.ts      (ponto de montagem: escolhe e liga os adaptadores)
│  │  ├─ src/api/
│  │  ├─ src/pipeline/       (registro de fluxos, etapas reutilizáveis, peça teatral)
│  │  ├─ src/selection/
│  │  ├─ src/accounts/       (perfis, cofre, sondas de cota)
│  │  ├─ src/executors/      (pools, admissão; os clientes vêm de adapters/)
│  │  ├─ src/mcp/            (servidor do framework, agregador de plugins)
│  │  ├─ src/tools/
│  │  ├─ src/resources/
│  │  ├─ src/workspace/
│  │  ├─ src/directives/     (ordens globais e locais, aplicação das regras)
│  │  ├─ src/scheduler/      (agenda, croner, gatilhos do sistema operacional, pedido de manter acordado)
│  │  ├─ src/scenarios/      (tipos de cenário, perfis de projeto, anexos, promoção, Diretor adormecido)
│  │  ├─ src/tasks/          (definição, ensaio e motor de passos das tarefas)
│  │  ├─ src/recovery/       (reconciliação na subida, verificadores de efeito, backup)
│  │  ├─ src/store/          (serviços sobre a porta Store; o SQL fica em adapters/store-sqlite)
│  │  └─ src/telemetry/      (spans; receptor e exportadores vêm de adapters/)
│  ├─ fake-agent/      agente ACP simulado
│  ├─ client/          cliente da API (REST, SSE, WS) + stores de estado e preferências, sem interface
│  ├─ tui/             TUI, interface principal (Ink; ou OpenTUI, conforme a Fase 0)
│  ├─ web/             web (Fase 12; base do Android)
│  ├─ desktop/         Electron ou Tauri (opcional, Fase 13)
│  ├─ android/         Capacitor sobre a web: celular e tablet (Fase 14)
├─ native/
│  └─ job-launcher/    lançador Rust com Job Object (Windows)
├─ prompts/            prompts de cada papel, em inglês (versionados, prefixo estável; 5.22)
├─ locales/            catálogos de texto da interface: en, pt-BR (5.22)
├─ docs/               este documento, ADRs, guia de plugins, THIRD_PARTY_NOTICES
└─ spikes/             código descartável da Fase 0
```

## 10. Fases de construção

Estimativas para **1 desenvolvedor em tempo integral**, sem e com apoio de agentes de código (a partir da Fase 5, o próprio framework pode construir as seguintes). São faixas, não prazos. O maior fator de incerteza é a Fase 0, que também decide se haverá fork.

### Fase 0 — Validações e escolha da base

Medições técnicas:
- **Adaptadores** `claude-agent-acp`, `codex-acp`, `opencode acp`:
  - sessão com `cwd` de worktree e `mcpServers` HTTP;
  - streaming, cancelamento, `request_permission`, `session/load`;
  - config options disponíveis (modelo, esforço, modo).
- **Concorrência:** 3 sessões simultâneas por adaptador, medindo processos e RAM. Define `processModel`, `K` e o custo por sessão.
- **Retomada nativa:** em cada adaptador, matar o processo no meio de uma tarefa e simular cota esgotada; conferir se `session/load` recupera a conversa (mesmo perfil e worktree), onde o cliente guarda os arquivos de sessão dentro do diretório do perfil e quanto tempo eles duram. Medir também a qualidade da passagem de bastão: uma tarefa interrompida e continuada por **outro** cliente a partir do pacote de continuação.
- **Perfis isolados:** dois logins do mesmo cliente lado a lado (`CLAUDE_CONFIG_DIR`; `CODEX_HOME` + `cli_auth_credentials_store="file"`; XDG/`OPENCODE_DB` no Windows).
- **Permissões pelo ACP:** como fazer chegar `tools`/deny/`dontAsk`/`--strict-mcp-config` ao Claude via adaptador; política do OpenCode V2; sandbox do Codex (MXC) nesta máquina.
- **Cota:** statusline por perfil gravando `rate_limits`; repasse ou não do `rate_limit_event` pelo adaptador; `account/rateLimits` do Codex; `token_plan/remains` da MiniMax.
- **Sandbox Windows:** piloto do `sandbox-runtime` alpha; plano B com usuário de baixo privilégio.
- **Lançador Rust** com Job Object: protótipo de criar suspenso → associar → retomar.
- **Modelo local:** Gemma 4 em llama.cpp `--jinja` via OpenCode, fazendo chamadas MCP estruturadas.
- **TUI: Ink × OpenTUI** (3–4 dias, **obrigatório**; inclui a matriz de terminais e atalhos). Protótipo mínimo nos dois frameworks com o layout de `mockup/tui.html` (lateral, chat, painel), alimentado por um gerador de eventos falso. Medir:
  - **streaming no chat:** 20–50 atualizações por segundo durante 5 minutos, sem tremulação nem atraso de digitação;
  - **rolagem:** histórico de 5.000 mensagens e trajetória de 1.000 passos, com rolagem fluida e memória estável;
  - **layout:** Ctrl+←/→ na largura do chat, Ctrl+B e Ctrl+J, e redimensionar a janela do terminal sem quebrar bordas;
  - **terminais:** Windows Terminal, terminal do VS Code, Terminal.app e iTerm2 (macOS), um terminal de Linux (GNOME Terminal ou Konsole), dentro do tmux e por SSH; acentos, `█`/`░` e bordas arredondadas;
  - **atalhos:** cada linha do mapa de teclas da seção 5.13, nos terminais acima, registrando o que chega à TUI. Pontos a confirmar:
    - Ctrl+J distinguível do Enter;
    - Ctrl+K no VS Code;
    - Ctrl+Shift+←/→ no macOS;
    - Alt com e sem "Option como Meta".

    O resultado define os padrões por ambiente;
  - **mouse:** clique em aba (bônus; não decide sozinho);
  - **runtime:** OpenTUI no Node ou só no Bun, e o custo de empacotar o Bun junto.

  **Critério:** fica o Ink se passar nos três primeiros itens; senão, OpenTUI. A decisão vira ADR.
- **OTel:** Claude Code e Codex exportando para um receptor local com atributos de correlação.

Avaliação de base (2–3 dias dentro da fase): Emdash, Orca, AionUi, Paradev e Happier, nessa ordem, pelos critérios da seção 6.4, começando pela licença das dependências que cada um arrasta. Com a TUI como interface principal, a avaliação olha o **núcleo** deles (runtime ACP, worktrees), não a interface gráfica. Leitura do runtime ACP do Emdash e do acpx.

Licenças: confirmar na fonte as marcadas **[a confirmar]** (1MCP, AgentPrism, Nimbalyst) e rodar um verificador de licenças (`license-checker` ou equivalente) sobre a árvore de dependências inicial. Qualquer licença proibida, ou fora da lista sem decisão registrada, reprova.

Termos: confirmação com a Anthropic sobre o uso de assinatura num orquestrador pessoal versus distribuído (R1).

**Entregável:** relatório de spikes + ADRs (inclusive fork sim/não) + ajustes neste documento.
**Critério de aceite:** cada item com resposta medida, não suposta.
**Estimativa:** 2–3 semanas (inclui os 3–4 dias do teste da TUI, **obrigatório**: a TUI é a interface principal e o framework dela precisa estar decidido antes da Fase 7).

### Fase 1 — Fundação

- Monorepo, lint, testes, CI, `THIRD_PARTY_NOTICES`.
- Automação de licenças da seção 6.0 na CI: verificador da árvore de dependências contra a lista permitida, geração do `THIRD_PARTY_NOTICES` (com os `NOTICE` dos pacotes Apache) e verificação de cabeçalho nos arquivos copiados.
- `packages/core` com as primeiras portas (`Store`, `EventLog`, `Clock`, `SecretVault`), os erros tipados e as funções puras iniciais; `packages/protocol` com os primeiros schemas da API.
- `packages/sdk` com o esqueleto das suítes de conformidade.
- Regra de dependência na CI (5.18): `core` sem infraestrutura; o daemon só importa adaptadores no ponto de montagem.
- Daemon esqueleto:
  - ponto de montagem (`compose.ts`);
  - configuração;
  - lock de instância;
  - store SQLite + migrations, com `synchronous=FULL` e backup diário (`ot backup`, `ot restore`; 5.21);
  - log de eventos;
  - pino.
- Idioma (5.22): biblioteca de i18n escolhida, catálogos `en` e `pt-BR` em `locales/`, chave `ui.locale` e verificação dos catálogos na CI.
- `fake-agent` mínimo sobre o SDK do ACP.

**Critério de aceite:** o daemon sobe, grava e lê eventos, testes verdes na CI; um backup feito com o daemon no ar passa no `integrity_check` e o `ot restore` devolve o estado, com o custo do `FULL` medido; o mesmo daemon sobe montado com fakes (`Store` em memória, `Clock` falso), e a CI reprova um import que fure a regra de dependência.
**Estimativa:** 1,5 semana (era 1 na v0.11: entram `core`, `sdk`, ponto de montagem e regra de dependência).

### Fase 2 — Camada de Executores

- Cliente ACP sobre o SDK; adaptadores prontos configurados por perfil (`command`, `profileEnv`, `prepareProfile`).
- Aplicação de modelo/esforço por config options.
- Pools com `K` e `processModel` medidos.
- Lançador Rust (Windows), com `killDescendants` como fallback.
- Worktrees e branches.
- Timeout → commit WIP → `session/cancel` → kill.
- Checkpoints automáticos (por lote de edições, a cada N minutos e em toda interrupção) e registro por tentativa: referência da sessão ACP, perfil, worktree, último checkpoint, último evento.
- **Retomada nativa** (`session/load`) para queda do processo e reinício do daemon, com recuo exponencial para erros transitórios.
- `session/update` → eventos.
- Testes de contrato dos adaptadores, dentro das suítes de conformidade de `ClientAdapter` e `AgentSession` (5.18). Cada cliente num pacote `@otheater/adapter-client-*`.
- `ModelCatalog` de cada cliente (descoberta automática no Claude Code e no Codex, assistida no OpenCode) e o adaptador `llama-cpp` da porta `LocalModelServer`, cada um com a sua suíte de conformidade (5.18, v0.23).

**Critério de aceite:** N Executores reais e simulados em worktrees diferentes, stream como eventos, cancelamento por timeout sem processo órfão e com WIP commitado.
**Estimativa:** 2 semanas (era 1,5 na v0.9: entram checkpoints e retomada nativa).

### Fase 3 — Pipeline, MCP do framework e blackboard

- Servidor MCP v2 com fábrica por papel e token por sessão.
- Schemas de saída + `submit*` com revalidação.
- Registro de fluxos e etapas reutilizáveis (5.18); a peça teatral como fluxo padrão: máquina XState completa (seção 5.4), com persistência, contadores, escalonamento e `AWAITING_PRODUCER`.
- Registros de papéis, ferramentas, chaves de `rule` e tipos de evento, validados na subida.
- Validação do roteiro (ciclos, contratos, arquivos).
- DAG em ordem topológica.
- Integração antes do Crítico; entrega por PR.
- Blackboard; fila única de prompts do Orquestrador.
- Ordens globais e locais (seção 5.17), sem a janela recorrente: tabela, ferramentas do Diretor, entrada no prefixo dos Executores e no pacote de continuação, `ot directives`.
- Prompts iniciais dos papéis.
- Cenários (5.20): registro de tipos, pasta por cenário, anexos com `read_attachment`, Diretor adormecido e fluxo `chat` com o papel `consultant`.
- Reconciliação na subida (5.21), com os verificadores das cascas oficiais.

**Critério de aceite:**
- peça ponta a ponta com o `fake-agent` cobrindo os quatro desfechos e o critério de parada;
- reinício do daemon no meio da peça, retomando do snapshot;
- `kill -9` do daemon no meio de um efeito colateral: na subida, a reconciliação mata o processo órfão, resolve o efeito pelo verificador (ou pergunta ao Produtor) e nada se repete;
- uma ordem global e uma local chegam ao prompt do Orquestrador e dos Executores e sobrevivem ao reinício; uma ordem com início futuro só entra no prompt depois do início; uma ordem que vence com o daemon parado não entra em sessões abertas depois do reinício; uma suspensão tira a global de um cenário só; uma `rule` revogada devolve o valor da configuração;
- uma peça real pequena concluída com o Orquestrador em `claude-agent-acp` + Haiku;
- no chat, uma pergunta simples é respondida pelo Diretor, uma pergunta difícil abre o consultor, e um anexo de imagem só vai para um Executor que aceita imagem; o Diretor adormece e acorda pelo resumo sem perder o estado.

**Marco: MVP utilizável sem UI**, conversando com o Orquestrador pelo próprio cliente apontado para o MCP do framework.
**Estimativa:** 3,5 semanas (era 2,5 na v0.13; a v0.14 acrescentou a base dos cenários e o chat, e a v0.15 a reconciliação) **[proposta]**.

### Fase 4 — Permissões e ferramentas de trabalho

- `prepareProfile` gerando a camada 1 para cada cliente a partir da política do papel.
- Resposta automática a `request_permission` (camada 2).
- Camada 3: `sandbox-runtime` em macOS/Linux; no Windows, a solução escolhida na Fase 0.
- Cascas, com confinamento de caminho, truncamento e o semáforo de comandos pesados.
- Testes de fuga:
  - path traversal e symlink;
  - encadeamento de comandos;
  - programa chamado por caminho ou dentro de `sh -c`;
  - ferramenta nativa bloqueada.
- Navegador compartilhado sem a tela (5.19): porta `BrowserSession`, adaptador Playwright, perfil isolado por cenário, domínios permitidos e ferramentas `browser_*` com aprovação das ações de escrita.
- Perfil de projeto `software` (5.20): estrutura inicial, changelog, mensagens de commit e PR gerados na entrega, criação da CI; importação de repositório existente com detecção das convenções e confirmação do Produtor.

**Critério de aceite:** suíte de fuga verde nos três clientes; o Ator abre uma página de teste, lê, tira print e só clica depois da aprovação, e um domínio fora da lista é recusado; um repositório importado mantém o formato do próprio changelog e o padrão de commit depois de uma peça.
**Estimativa:** 2,5 semanas (era 1,5 na v0.12; a v0.13 acrescentou o navegador e a v0.14 o perfil `software`) **[proposta]**.

### Fase 5 — Assinaturas, cotas e seleção

- Perfis: criar, login oficial, logout, drenagem, remoção.
- Chaves no cofre.
- Sondas de cota da seção 5.6 (statusline, app-server, MiniMax, erro de limite) e histórico pelo ccusage.
- Seleção por papel com retry por diversidade e eventos de motivo.
- Admissão por RAM; failover do Orquestrador; override por projeto.
- **Retomada completa (5.16):** classificação da causa; política por causa; **passagem de bastão** com pacote de continuação; limite de retomadas por tentativa; interrupções externas fora da contagem de tentativas.
- **Idempotência de efeitos colaterais:** chaves por `attempt + step` nas cascas e nos plugins, tabela `side_effects`.

**Critério de aceite:** com dois perfis do mesmo cliente, esgotar um (simulado) e ver o Diretor redistribuir; remover um perfil com sessões em curso sem perder demanda; failover do Orquestrador sem perder a peça.

Também faz parte do aceite:
- um Ator interrompido por cota esgotada é retomado por passagem de bastão em outra assinatura, sem refazer commits nem instalações já feitos;
- outro Ator, com regra `wait`, é retomado de forma nativa depois do reset.

**Marco: o framework passa a poder construir as próximas fases.**
**Estimativa:** 2,5 semanas (era 2: entram a passagem de bastão e a idempotência).

### Fase 6 — API do daemon e cliente compartilhado

- REST.
- SSE com `Last-Event-ID`.
- WebSocket do chat, ligado à fila de prompts.
- Token, CORS fechado, bind local.
- **`packages/client`:** a camada que a TUI usa agora e a web herda depois. Não depende de interface:
  - cliente REST tipado a partir de `packages/protocol`;
  - assinatura SSE com retomada por `Last-Event-ID` e reconexão;
  - WebSocket do chat;
  - **stores de estado** (zustand no modo *vanilla*, MIT, que funciona no Ink e no React): cenários, peças, demandas, decisões pendentes, cotas, eventos;
  - **preferências de layout por usuário:** lateral recolhida, largura do chat, abas abertas, seções recolhidas.
- Testes do `packages/client` contra o daemon com `fake-agent`.

**Critério de aceite:** um cliente de teste sobre o `packages/client` acompanha uma peça inteira por SSE, reconecta no meio sem perder evento e conversa com o Orquestrador.
**Estimativa:** 1,5 semana (era 1: inclui o `packages/client`).

### Fase 7 — TUI (interface principal)

`packages/tui` no framework escolhido na Fase 0 (Ink por padrão), sobre o `packages/client`. A TUI só desenha e lê teclado; estado e acesso à API ficam no `packages/client`.

**Layout** de `mockup/tui.html`:
- lateral retrátil (trilho recolhido) com cenários, assinaturas e a entrada de Configurações;
- chat em altura total com largura ajustável;
- painel de abas que abrem e fecham;
- seções recolhíveis.

**Componentes próprios:**
- rolagem virtualizada;
- tela cheia com redesenho ao redimensionar;
- barra de abas e alça de largura;
- formulários e seletores, sobre `@inkjs/ui`;
- paleta de comandos (Ctrl+K).

**Telas e abas:**
- **Chat:** decisões do Produtor respondidas por tecla.
- **Visão geral:**
  - pipeline;
  - **DAG em forma de lista com dependências** (sem desenho gráfico);
  - Atores, eventos e cota.
- **Trajetórias:** passos expansíveis e diffs.
- **Consumo.**
- **Ordens:** vigentes, agendadas e encerradas por escopo, linha do tempo da vigência e prazos; criar, prorrogar, suspender e revogar.
- **Configurações:**
  - **Assinaturas:** o login oficial do CLI roda num painel da própria TUI, porque esses logins já são interativos no terminal;
  - **Executores:** modelo e esforço vindos das config options;
  - **Papéis:** reordenação com Shift+↑↓ e regra próximo/esperar;
  - **Limites.**
- **Assistente de configuração** (5.7): desenha os passos que o daemon manda, com voltar e retomar; a primeira execução abre nele.
- **Plugins:** ativação e permissões por papel.

**Idioma** (5.22): todas as telas em `en` e `pt-BR`, pelo catálogo, com troca por `ui.locale`.

**Atalhos:** mapa de teclas configurável da seção 5.13:
- padrões por sistema e ambiente (macOS, tmux, VS Code), definidos pelo teste da Fase 0;
- alternativas com Alt;
- paleta de comandos com dois atalhos (Ctrl+K e F1);
- aviso de Option-como-Meta no macOS;
- validação de conflitos ao configurar.

**Testes:** `ink-testing-library` sobre o `fake-agent`, e testes de fumaça nos terminais da Fase 0.

**Critério de aceite:** criar um projeto, adicionar uma assinatura (login oficial dentro da TUI), configurar papéis, pedir uma necessidade no chat, responder a uma decisão e acompanhar até o PR só pela TUI, no Windows Terminal e num terminal de macOS/Linux, nos dois idiomas.
**Estimativa:** 2,5–3 semanas (era 2–2,5 como fase opcional; agora cobre configuração e plugins completos).

### Fase 8 — Observabilidade

- Receptor OTLP no daemon recebendo o OTel nativo do Claude Code e do Codex, com correlação.
- Spans do daemon com as convenções GenAI.
- Exportador ATIF v1.8, validado pelo `TrajectoryValidator` do Harbor.
- Painéis de consumo na TUI (aba Consumo); retenção.
- Integração opcional com Phoenix, para quem quiser um visualizador gráfico de traces.

**Critério de aceite:** trace completo de uma peça; trajetória ATIF válida.
**Estimativa:** 1 semana.

### Fase 9 — Plugins

- Manifesto, validação, registro, ativação por projeto.
- Agregador MCP (ou 1MCP como sidecar).
- Permissões geradas dos manifestos; segredos no cofre.
- `@otheater/sdk` para plugins + plugin de exemplo.
- Painel declarativo (5.14) desenhado na aba Plugins da TUI; tipos de evento `plugin.<id>.*`.

**Critério de aceite:** a ferramenta do plugin aparece só nos papéis declarados e fica bloqueada nos demais; o painel do plugin de exemplo aparece na TUI sem nenhum código do plugin na interface.
**Estimativa:** 1–1,5 semana.

### Fase 9b — Agendador e tarefas

Depende das Fases 5 (sondas de cota e seleção) e 6 (API). Pode andar em paralelo com as Fases 7–9.

- Tabelas `schedules` e `schedule_runs`; croner com fuso; recálculo e gravação do próximo disparo.
- Tipos: uma vez, cron, intervalo, após reset da cota.
- Regras por tarefa e padrões globais: execução perdida, sobreposição, cota, decisão sem ninguém olhando; orçamento por execução.
- Gatilho do sistema operacional que acorda a máquina e chama `ot run <task>`:
  - Windows: Agendador de Tarefas;
  - macOS: launchd;
  - Linux: timer do systemd.
- Pedido de manter acordada durante a execução, nas três plataformas.
- Ferramentas MCP do Diretor: `schedule` (rascunho confirmado pelo Produtor), `list_schedules`, `pause_schedule`.
- Comandos `ot schedule …` e `ot run`.
- Aba Agenda na TUI.
- Notificações: chat, sistema operacional, plugin.
- Testes com relógio simulado sobre o `fake-agent`.
- Tarefas (5.20): definição versionada, fluxo `task.define` com os papéis e o ensaio, motor de passos `task.run` (tipos `code`, `model`, `agent`, `approval`, `delivery`), pasta por execução, gatilhos da v1, `run_task`, promoção de chat para tarefa ou projeto. A entrega por plugin depende da Fase 9.

**Critério de aceite:**
- tarefa diária dispara no horário com a tela bloqueada (Windows com Modern Standby incluído) e abre o PR;
- execução perdida com a máquina desligada roda uma vez ao voltar;
- execução sobreposta é pulada;
- com a cota esgotada, a tarefa é adiada até o reset;
- decisão do Produtor sem ninguém olhando espera o prazo e segue com a recomendada, e numa decisão irreversível segue só com a opção segura;
- tarefa criada pelo chat só é salva depois da confirmação;
- o exemplo das manchetes e o do dono (baixar, descomprimir, extrair, montar a planilha, enviar) passam no ensaio, rodam pelo agendador e entregam o artefato, com o Diretor adormecido durante a execução;
- um passo de código que falha acorda o Diretor, que abre a correção da definição.

**Estimativa:** 2,5–3 semanas sem agentes; 1,5–2 com (era 1–1,5 e 0,5–1 na v0.13: entram as tarefas) **[proposta]**.

### Fase 10 — Distribuição (daemon + TUI)

- Executável único do daemon e da TUI: Node SEA, ou `bun build --compile` se a Fase 0 escolher o OpenTUI. Lançador Rust de Job Object junto, no Windows.
- Instalação por usuário:
  - Windows: instalador `.msi`/winget;
  - macOS/Linux: pacote ou script;
  - alternativa para desenvolvedores: `npm i -g`.
- Daemon como serviço de logon; o comando da TUI sobe o daemon se ele não estiver no ar.
- Gatilhos do sistema operacional registrados para rodar só com o usuário conectado (5.21).
- `ot init` mínimo: instala o serviço, sobe o daemon e abre a TUI no assistente de configuração, sem perguntas no terminal (5.7).
- Atualização automática e primeira execução guiada dentro da TUI, pelo assistente do daemon (criar a primeira assinatura, escolher os papéis padrão).

**Critério de aceite:**
- instalar e desinstalar numa máquina limpa;
- fechar a TUI sem interromper a peça;
- reabrir e reencontrar o estado e o layout.

**Estimativa:** 1 semana.

### Fase 11 — Endurecimento

- Testes de caos:
  - daemon morto no meio da peça;
  - queda de energia simulada (VM desligada à força) com uma peça, uma tarefa agendada e um chat em curso (5.21);
  - Executor travado;
  - perfil expirado;
  - disco cheio;
  - provedor fora do ar;
  - atualização de adaptador.
- Idempotência de integração e PR.
- Revisão de segurança da API e das cascas.
- Revisão das portas (5.18): porta que continua com um só adaptador e sem segundo previsto é candidata a ser simplificada (R16).
- Documentação, incluindo o guia para escrever adaptadores e plugins.

**Critério de aceite:** roteiro de caos sem perda de estado nem processo órfão.
**Estimativa:** 1,5–2 semanas.

### Fase 10b — Daemon sem login (logo depois da v1)

Decidida em 2026-11-14 (N21): fase própria, logo depois da Fase 11 (5.21).
- **Medição primeiro.** Verificar se os clientes (Claude Code, Codex, OpenCode) fazem login e rodam sem sessão de usuário aberta, nos três sistemas.
- Escolher o adaptador de `SecretVault` que destranca sem ninguém digitar nada, pelo critério da 5.21.
- Instalador com a opção de serviço sem login: systemd de usuário com `linger`, tarefa do Windows "executar estando o usuário conectado ou não", LaunchDaemon com `UserName` no macOS **[a confirmar]**.
- Gatilhos do sistema operacional passam a rodar sem o usuário conectado.

**Critério de aceite:** a máquina religada depois de uma queda de luz, sem ninguém fazer login, roda a tarefa agendada que estava na janela, retoma as peças pela reconciliação e notifica pelo chat e pelo plugin de notificação.
**Estimativa:** a definir ao abrir a fase, depois da medição.

### Fase 12 — Interface web (depois da v1; base do app Android)

Fica fora do caminho crítico e do total. Deixou de ser opcional em 2026-11-14, porque o app Android (Fase 14) a reaproveita. Pode começar a qualquer momento depois da Fase 6, inclusive em paralelo com a Fase 7 se houver uma segunda pessoa.

- `packages/web` (React + Vite) sobre o **mesmo `packages/client`**: estado, API e preferências já existem; só a camada de desenho é nova.
- Layout de `mockup/app.html`:
  - chat em altura total com largura ajustável por arraste;
  - lateral retrátil;
  - painel de abas;
  - cartões recolhíveis.
- Layout responsivo e preparado para toque desde o início, para o tablet e o celular da Fase 14.
- Componentes prontos: assistant-ui (chat), @xyflow/react (DAG gráfico), shadcn/ui, AgentPrism ou viewer próprio (trajetórias).
- O que a web acrescenta à TUI: DAG desenhado, arrastar para reordenar papéis, desenho gráfico dos painéis declarativos dos plugins, mouse.
- Navegador compartilhado na tela (5.19): transmissão da sessão, controle pelo Produtor e modo **indicar**, genérico, com as indicações `web_element` anexadas à mensagem do chat.
- Testes e2e com Playwright sobre o `fake-agent`.

**Critério de aceite:** o mesmo da Fase 7, feito só pela interface web; e o Produtor indica dois elementos numa página, e o Ator corrige os dois a partir das indicações.
**Estimativa:** 2,5–3 semanas sem agentes; 1,5–2 com (era 2–2,5 na v0.12; +0,5 do navegador compartilhado).

### Fase 13 — App desktop (opcional, depende da Fase 12)

- Decisão Electron × Tauri.
- A web numa janela nativa, como cliente do serviço de logon da Fase 10 (o daemon não roda dentro do app; item 6 da seção 12, v0.25). Sem o serviço, o app instala pelo assistente de configuração.
- Instalador por usuário, atualização automática.

**Critério de aceite:** instalar e desinstalar numa máquina limpa; fechar a janela sem interromper a peça.
**Estimativa:** 1 semana sem agentes; 0,5–1 com.

### Fase 14 — App Android, celular e tablet (depois da Fase 12)

Fica fora do caminho crítico e do total, como a web. Não depende da Fase 13.

- `packages/android`: Capacitor sobre o build da `packages/web`.
- Tablet com o layout do app; celular com uma coluna por vez e navegação inferior (5.13).
- No daemon: `api.remote: vpn`, TLS com certificado fixado, pareamento por QR (`ot pair`), tokens por aparelho e a tela Aparelhos (5.12).
- Notificações, conforme o item 19 da seção 12.
- Testes: emulador Android (celular e tablet) e um aparelho real pela VPN; queda de rede e retomada do SSE por `Last-Event-ID`.

**Critério de aceite:** num tablet e num celular ligados à VPN, parear por QR, acompanhar uma peça ao vivo, responder a uma decisão do Produtor e conversar com o Diretor; revogar o aparelho e ver o acesso cair; fechar o app sem interromper a peça.
**Estimativa:** 2–2,5 semanas sem agentes; 1–1,5 com **[hipótese]**.

### Resumo das estimativas

| Fase | Sem agentes | Com agentes de código* | v0.1 (sem agentes) |
|---|---|---|---|
| 0 Validações e base (teste da TUI obrigatório) | 2–3 sem | 2–3 sem | 1–1,5 |
| 1 Fundação | 1,5 sem | 1 sem | 1 |
| 2 Executores | 2 sem | 1,5 sem | 2 |
| 3 Pipeline + MCP + base dos cenários + reconciliação | 3,5 sem | 2,5–3 sem | 2,5–3 |
| 4 Permissões, navegador e perfil `software` | 2,5 sem | 1,5–2 sem | 1,5–2 |
| 5 Assinaturas, seleção e retomada | 2,5 sem | 1,5–2 sem | 2 |
| 6 API + `packages/client` | 1,5 sem | 0,5–1 sem | 1 |
| 7 TUI (interface principal) | 2,5–3 sem | 1,5 sem | — |
| 8 Observabilidade | 1 sem | 0,5 sem | 1 |
| 9 Plugins | 1–1,5 sem | 0,5–1 sem | 1,5 |
| 9b Agendador e tarefas | 2,5–3 sem | 1,5–2 sem | — |
| 10 Distribuição (daemon + TUI) | 1 sem | 0,5–1 sem | 1–1,5 |
| 11 Endurecimento | 1,5–2 sem | 1–1,5 sem | 1,5–2 |
| **Total (produto na TUI)** | **≈ 25–28 semanas** | **≈ 16–20,5 semanas** | 19–24 |
| 10b Daemon sem login (logo depois da v1) | a definir | a definir | — |
| 12 Interface web (depois da v1) | 2,5–3 sem | 1,5–2 sem | 3–4 |
| 13 App desktop (opcional) | 1 sem | 0,5–1 sem | — |
| 14 App Android, celular e tablet (depois da web) | 2–2,5 sem | 1–1,5 sem | — |

\* Com Claude Code/Codex como apoio desde o início e, a partir da Fase 5, com o próprio framework. Supõe revisão humana de tudo o que for gerado. A Fase 0 não acelera com agentes: é medição.

**Fork, com a TUI primeiro:** os candidatos da seção 6.4 (Emdash, Orca, AionUi, Paradev, Happier) são apps gráficos. Com a TUI como interface principal, o fork perde a maior parte do valor. O que ainda se aproveita é o runtime ACP e a gestão de worktrees (Fase 2, ≈ 0,5–1 semana a menos) e parte da Fase 12. A avaliação da Fase 0 passa a olhar principalmente o núcleo deles (runtime ACP, worktrees), não a interface.

As estimativas já consideram a política de licenças da seção 6.0 (Apache-2.0 aceita, sem reimplementar o SDK do ACP nem o OpenTelemetry).

**Marcos:**
- **MVP sem UI** (Fases 0–3): ≈ 9–10 semanas sem agentes, ≈ 7–8,5 com. Conversa com o Orquestrador pelo próprio cliente apontado para o MCP do framework.
- **Uso diário com várias assinaturas** (+ Fases 4–5): ≈ 14–15 / ≈ 10,5–13.
- **Produto na TUI** (+ Fases 6–7): ≈ 18–19,5 / ≈ 12,5–15,5.
- **Produto completo na TUI** (+ Fases 8–11, com 9b): ≈ 25–28 / ≈ 16–20,5.
- **Daemon sem login** (+ Fase 10b, logo depois da v1): a estimar depois da medição.
- **Web, desktop e Android** (+ Fases 12–14; só o desktop é opcional): + 5,5–6,5 / + 3–4,5. Sem o desktop: + 4,5–5,5 / + 2,5–3,5.

**Paralelização com uma segunda pessoa:**
- depois da Fase 3, a Fase 6 (API + `packages/client`) anda em paralelo com as Fases 4–5;
- depois da Fase 6, a TUI (7) anda em paralelo com as Fases 8, 9 e 9b (agendador); a web (12) pode correr junto com a TUI, já que as duas usam o mesmo `packages/client`;
- o contrato da API está em `packages/protocol`, o das portas em `packages/core`, e o `fake-agent` cobre o back.

Caminho crítico: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 11.

## 11. Riscos e mitigação

| # | Risco | Impacto | Mitigação |
|---|---|---|---|
| R1 | Termos da Anthropic restringem assinatura em produtos (inclusive com Agent SDK, que o `claude-agent-acp` usa) | Modo produto sem assinatura Claude | Uso pessoal com o CLI oficial e logins próprios; confirmação formal na Fase 0; modo produto com chave de API para Claude até lá |
| R2 | ACP e adaptadores mudam toda semana (SDK 2.0 a 2.6 em três semanas, renomeações de pacote) | Quebras ao atualizar | Versões fixadas; testes de contrato; atualização deliberada; saída de emergência pelo modo headless |
| R3 | Sinal de cota ausente, não documentado ou instável | Alocação em perfil esgotado | Várias fontes por provedor + erro de limite + contabilidade local; retry no próximo Executor |
| R4 | Sandbox fraco no Windows (Claude Code sem sandbox nativo; `sandbox-runtime` em alpha) | Fuga de permissão | Bash nativo removido; cascas; usuário de baixo privilégio; Job Object; testes de fuga |
| R5 | Modelo pequeno no Diretor decide mal | Ciclos desnecessários | Pontos de julgamento estreitos com schema; limites `Np`/`Nc`; Executor do Diretor configurável; Gemma 4 em vez de Gemma 3 |
| R6 | RAM com muitos Atores (um `claude` por sessão) | Máquina travando | Admissão por sessão; plugins agregados; semáforo de comandos pesados; Codex/OpenCode para Atores simples |
| R7 | Conflitos de merge frequentes | Retrabalho | `expectedFiles` validado antes da execução; conflito vira falha de roteiro |
| R8 | Fork que diverge do upstream | Manutenção dobrada | Critérios explícitos na Fase 0; preferir copiar trechos com atribuição a manter um fork |
| R9 | Licença proibida entrando sem perceber (dependência transitiva GPL, AGPL ou LGPL, componente não confirmado, fork que arrasta AGPL) ou obrigação da Apache-2.0 ou da MPL-2.0 esquecida (NOTICE, cabeçalho, marca de modificação, código-fonte de arquivo MPL alterado) | Violação de licença; bloqueio jurídico tardio | Política da seção 6.0; verificador de licenças e de cabeçalhos na CI; `THIRD_PARTY_NOTICES` gerado; alternativa própria para cada componente a confirmar |
| R10 | Custo de contexto alto | Cota esgota rápido | Blackboard, saída estruturada, prefixo estável para cache |
| R11 | Ink lento ou tremulando com streaming intenso, ou rolagem ruim em conversas longas | A TUI é a interface principal: sem ela confortável, o produto todo sofre | Teste comparativo Ink × OpenTUI na Fase 0; rolagem virtualizada; TUI isolada atrás da API, então trocar de framework não afeta o resto |
| R12 | Sem interface gráfica até a Fase 12 | Quem não usa terminal fica sem acesso; DAG e trajetórias longas são menos legíveis no terminal | Web (Fase 12) e Android (Fase 14) depois da v1, e desktop opcional, todos prontos para começar depois da Fase 6 sobre o `packages/client`; Phoenix como visualizador gráfico de traces no meio-tempo |
| R13 | Tarefa agendada roda sem ninguém olhando e faz algo indesejado, ou gasta a cota | Mudança não revisada, cota esgotada para o uso interativo | Entrega por PR por padrão; orçamento por execução; criação pelo chat só com confirmação; decisão sem ninguém olhando pausa por padrão; adiar quando a cota está esgotada |
| R14 | Máquina dormindo no horário (Modern Standby, tampa fechada) | Tarefa não roda ou atrasa horas | Gatilho do agendador do sistema operacional que acorda a máquina; pedido de manter acordada durante a execução; regra de execução perdida; histórico mostra atraso real |
| R15 | Retomada repete efeito colateral, ou a passagem de bastão perde contexto e o novo Executor refaz ou desfaz trabalho | Commits duplicados, chamadas externas repetidas, retrabalho | Chaves de idempotência nas cascas e plugins; checkpoints frequentes; pacote de continuação com efeitos já executados; preferir retomada nativa quando possível; teste de qualidade da passagem de bastão na Fase 0 |
| R16 | Excesso de abstração: portas especulativas, indireção demais, contratos que mudam a toda hora | Código mais difícil de ler e de mudar; o custo de trocar uma implementação deixa de compensar | Porta só em fronteira e em ponto de variação (5.18, regra 1); porta nasce com adaptador real, fake e conformidade (regra 5); composição manual, sem container; regra de dependência na CI; revisão das portas na Fase 11 |
| R17 | Navegador compartilhado: uma página dirige o agente por injeção de prompt, ou o agente age com uma conta logada no perfil do cenário | Ação indesejada num site real (envio, compra, exclusão) ou vazamento do que a página mostra | Perfil isolado por cenário, sem importar cookies; domínios permitidos; ações de escrita com aprovação por padrão; página tratada como dado (5.8); evento com print de cada ação (5.19) |
| R18 | Tarefa recorrente roda sem supervisão um script escrito por agente | Script errado ou malicioso roda todo dia, apaga dados ou envia o que não devia | Passos de código no sandbox, com a política da tarefa (5.8); definição só ativa depois do ensaio e da aprovação do Produtor; toda mudança gera versão nova, com diff, ensaio e aprovação; destinatário da entrega fixo na definição; orçamento por execução (5.20) |
| R19 | Queda de energia ou reinício no meio do trabalho | Transação confirmada perdida, store corrompido, efeito externo feito duas vezes ou esquecido, processo órfão consumindo cota | `synchronous=FULL`; gravar antes de agir; reconciliação na subida com verificadores de efeito; backup diário com `integrity_check`; teste de queda forçada na Fase 11 (5.21) |
| R20 | Acesso remoto pelo app Android: aparelho perdido ou roubado, token vazado, VPN mal configurada | Quem tem o aparelho comanda o daemon, que é acesso administrativo | Só pela VPN, nunca exposto na internet; token por aparelho, revogável; token no armazenamento seguro do Android; certificado fixado no pareamento; ações destrutivas pedem confirmação; bloqueio do app por biometria **[proposta]** (5.12, 5.13) |

## 12. Decisões em aberto

1. Fork (Emdash como principal candidato; Orca, AionUi, Paradev ou Happier) ou projeto próprio com trechos reaproveitados (Fase 0).
2. Modo de distribuição: pessoal (assinaturas) ou produto (API para Claude), depois da resposta sobre R1.
3. *(Decidida em 2026-11-13: tipos de cenário, ver "Decididas" e a seção 5.20.)*
4. *(Decidida em 2026-11-14: limites do pipeline como chaves de configuração, ver "Decididas" e a seção 5.4.)*
5. *(Decidida em 2026-11-14: política de entrega como chave de configuração, ver "Decididas" e a seção 5.5.)*
6. *(Decidida em 2026-11-14: daemon sempre como serviço de logon, ver "Decididas" e a seção 5.1.)*
7. Electron ou Tauri (só se a Fase 13 for feita).
8. *(Decidida em 2026-11-14: Executores padrão de cada papel, ver "Decididas" e a seção 5.7.)*
9. *(Decidida em 2026-11-14: acesso remoto pela VPN do usuário, para o app Android, ver "Decididas" e as seções 5.12 e 5.13.)*
10. *(Decidida em 2026-11-14: custo em moeda, ver "Decididas" e a seção 5.6.)*
11. Framework da TUI: Ink (padrão) ou OpenTUI, pelo teste comparativo da Fase 0 (obrigatório).
12. Quando fazer a web (Fase 12), que desde 2026-11-14 é a base do app Android (Fase 14) e deixou de ser opcional, e se fazer o app desktop (Fase 13).
13. *(Decidida em 2026-11-14: padrões do agendador como chaves de configuração, ver "Decididas" e a seção 5.15.)*
14. *(Decidida em 2026-11-14: padrões da retomada como chaves de configuração, ver "Decididas" e a seção 5.16.)*
15. Detalhes dos níveis de plugin com comportamento de mod, para depois da v1 (5.14): quais pontos de interceptação existem, o prazo padrão de um gancho, o que acontece quando ele falha ou estoura o prazo (bloquear ou deixar passar) e se uma sonda de cota ou um notificador de um provedor novo podem vir de plugin, sem virar pacote oficial (5.18).
16. *(Decidida em 2026-11-14: padrões dos cenários como chaves de configuração, ver "Decididas" e a seção 5.20.)*
17. Como destrancar os segredos no modo sem login (5.21): mecanismo nativo da máquina (DPAPI, TPM, `systemd-creds`) ou arquivo cifrado com chave protegida. Decide-se ao abrir a Fase 10b, depois da medição. O resto do item foi decidido em 2026-11-14, ver "Decididas".
18. Contribuições externas (6.0): exigir um acordo de contribuição (CLA), que dá ao dono o direito de relicenciar o código recebido e mantém aberta uma licença dupla ou uma versão comercial, ou só a certificação de origem (DCO, com `Signed-off-by`), em que cada contribuição fica só sob MPL-2.0. Decide-se antes de o repositório aceitar contribuições.
19. Notificações do app Android (5.13): push pelo Firebase Cloud Messaging (exige conta Google e alguém que envie o push, o que pede um serviço fora da máquina); UnifiedPush ou ntfy (sem Google, com servidor próprio ou público); ou só com o app aberto ou num serviço em primeiro plano ligado ao SSE, que gasta bateria. Decide-se na Fase 14.
20. Distribuição do app Android: Google Play, APK direto (com atualização pelo próprio app) ou F-Droid. Liga-se ao item 2 (uso pessoal ou produto).
21. *(Decidida em 2026-11-14: teto de gasto em API, ver "Decididas" e a seção 5.6.)*
22. *(Decidida em 2026-11-14: sufixo `@<perfil>` em todos os Executores; revista no mesmo dia na v0.23 para `@<cliente>/<perfil>`; ver "Decididas" e a seção 5.7.)*
23. *(Decidida em 2026-11-14: capacidade mínima por papel, ver "Decididas" e a seção 5.7.)*
24. *(Decidida em 2026-11-14: perguntas ao Produtor por múltipla escolha, ver "Decididas" e as seções 5.3 e 5.15.)*

Decididas:
- perguntas ao Produtor por múltipla escolha (2026-11-14, seções 5.3, 5.15 e 5.17, v0.26; item 24): o `ask_producer` tem schema com 1 a 4 perguntas, de 2 a 4 opções cada, a recomendada em primeiro, escolha múltipla e "Outra" com texto livre sempre; `chat.producer_questions: choices` (padrão), `choices_strict` ou `free`; sem resposta no chat, `chat.unanswered: wait_then_recommended` com `wait_for: 30m` (ou `wait`, `recommended_now`); nas tarefas agendadas, `schedule.unattended_decision.mode: wait_then_recommended` com o prazo da predefinição (1 h, 2 h, 30 min, escolhidos pelo dono), revendo o `pause_notify` do item 13; nas decisões irreversíveis, a recomendada é sempre a opção segura, definida pelo daemon; as duas chaves `chat.*` têm override por cenário e tarefa agendada e entram na lista de chaves de `rule`, que fica com seis;
- daemon como serviço de logon (2026-11-14, seção 5.1 e Fase 13, v0.25; item 6): o daemon é sempre o serviço de logon do usuário, instalado pelo `ot init`; nenhuma interface o hospeda, e o app desktop (Fase 13, se for feito) é só mais um cliente, que instala o serviço pelo assistente de configuração quando ele falta. Motivo: um daemon só por usuário, e as tarefas agendadas rodam com qualquer interface fechada. O comportamento sem login segue a seção 5.21 (na v1, o daemon espera o login);
- capacidade mínima por papel (2026-11-14, seções 5.7 e 5.9, v0.24; item 23): todos os papéis aceitam modelo local, sem proibição por localização, e o mínimo vale igual para modelo local e na nuvem; critérios: `toolcall` em todos, janela de contexto (por slot no modelo local, lida pelo `LocalModelServer`; do catálogo nos outros), raciocínio no Consultor, no Autor, no Revisor, no Roteirista e no Crítico, e sessão de teste no cadastro (chamar uma ferramenta e entregar um `submit` válido); mínimos de contexto padrão de 32k no Diretor, 64k nos Atores e 128k nos outros papéis, em `roles.<papel>.requires` **[proposta]**; `roles.capability_check: warn` (padrão), `block` ou `off`: com `warn`, o Executor abaixo do mínimo entra com aviso e fica marcado na lista; em qualquer modo a seleção pula o Executor quando o prompt não cabe na janela;
- modelo local e provedor na revisão cruzada (2026-11-14, seções 5.7 e 5.9; resolve contradições, sem item numerado): o modelo local pode ser Ator e servir aos outros papéis, limitado pelos slots da instância, com `local.reserve_for_director: 1` e `local.reserve_when: listed` **[proposta]** nos padrões; na revisão cruzada, o provedor é a família do modelo (campo `provider` do Executor); os Executores do OpenCode são cadastrados por um assistente que sugere os campos a partir do `opencode models --verbose` e o daemon só valida, sem código próprio para modelos locais; depois do cadastro, o Executor fica disponível para qualquer papel e entra nas listas pelo que o Produtor marcar (`executors.on_register: ask`, com `preset_only` e `none`); dois eixos na abstração: `ClientAdapter` (com `ModelCatalog`) para o cliente e a porta `LocalModelServer` para o servidor local (llama.cpp na v1, Ollama depois); nome do Executor `<modelo>-<esforço>@<cliente>/<perfil>`, com o perfil único dentro do cliente (revê o item 22); com assinatura, cada família só pelo seu cliente oficial, e com API ou gateway, qualquer cliente que suporte o modelo (`executors.cross_client: api_only`, com `off` e `any`); configuração dos papéis com valor global e override por papel em cada cenário (projeto, tarefa, chat) e em cada tarefa agendada, com `roles.preset` e `roles.allowed_profiles` também por escopo, e precedência tarefa agendada > cenário > global; `ot init` mínimo (instala o serviço, sobe o daemon e abre a TUI no assistente, sem perguntas no terminal) e assistente de configuração com a lógica no daemon, passos salvos, retomáveis e validados, gravados só na confirmação final; na v1 o assistente é desenhado pela TUI, e a web o mostra depois pela mesma API;
- Executores padrão de cada papel (2026-11-14, seção 5.7; eram os itens 8 e 22): nome sempre `<modelo>-<esforço>@<perfil>`, com o prefixo `claude-` nos modelos do Claude e o sufixo da conta em todos, e o cliente no campo (revisto na v0.23: o cliente entrou no nome, `<modelo>-<esforço>@<cliente>/<perfil>`); todos os papéis com lista de fallback ajustável; a primeira execução (`ot init`) detecta clientes, logins e chaves, aplica `roles.preset: quality` (opções `balanced` e `economical`), tira o que não existe, acrescenta ao fim o Executor por API que houver e pede confirmação; Diretor com `claude-haiku-low`, `codex-luna-low`, `gemma4-low`; Roteirista com a lista do Autor; revisão cruzada com `selection.cross_check: prefer_other_provider`;
- custo e teto de gasto em API (2026-11-14, seção 5.6; eram os itens 10 e 21): assinatura mostra a cota e o equivalente em API, e conta de API mostra o custo real (`usage.subscription_display: quota_and_equivalent`); o valor vem do cliente, senão da tabela de preços (`usage.cost_source: client_then_pricing`); teto por dia e por mês no perfil de API (`budget`), sugerido pelo `ot init` em US$ 20 e US$ 200 e confirmado pelo Produtor; aviso em 80%; ao estourar, `on_exceeded: skip` para sessões novas e `in_flight: handoff` para a sessão em curso; despertar agendado no store retoma o trabalho e as tarefas adiadas quando a cota ou o teto voltam;
- nome do produto: **OTheater** (*Orchestration Theater*); pacote `otheater`, escopo `@otheater/*`, comando `ot`/`otheater`, organização GitHub `orchestration-theater` (2026-11-13, seção 9);
- licenças permitidas: MIT, Apache-2.0, ISC, BSD-2/3-Clause, 0BSD e MPL-2.0; GPL, AGPL e LGPL proibidas (2026-11-13; MPL-2.0 aceita em 2026-11-14, seção 6.0);
- app Android (2026-11-14, seções 5.12 e 5.13 e Fase 14; era o item 9): versões para celular e tablet, só como cliente do daemon; Capacitor sobre a web da Fase 12; tablet com o app completo, celular enxuto; acesso pela VPN do usuário, com pareamento por QR e token por aparelho; Fase 14, depois da web, fora da v1. Com isso, a web deixa de ser opcional. Notificações e distribuição seguem em aberto (itens 19 e 20);
- licença do código próprio: **MPL-2.0**, no lugar da MIT (2026-11-14, seção 6.0). Permite produto comercial e módulos fechados em arquivos separados; quem distribuir um arquivo do OTheater alterado publica aquele arquivo. Contribuições externas (CLA ou DCO) seguem em aberto (item 18);
- Arize Phoenix (ELv2) aceito só como ferramenta local opcional, nunca distribuído (2026-11-13, seção 6.2);
- ordens do Produtor (2026-11-13, seção 5.17): a local prevalece sobre a global no mesmo cenário; uma ordem vale para um cenário ou para todos, sem lista nem tag; sessões em curso não mudam e o Diretor decide relançar; `rule` com quatro chaves na v1 (perfis de um papel, `next`/`wait`, exigir PR e `git.push_after_commit`), mais `chat.producer_questions` e `chat.unanswered` desde a v0.26; dispensa do Crítico por decisão registrada, não por ordem, para a peça inteira, ao abrir a peça ou depois de uma reprovação (seção 5.4); janela recorrente depois da v1; aviso de prazo 24 h antes, configurável; suspensão local de uma global mantida.
- portas, adaptadores e registros (2026-11-13, P12 e seção 5.18): porta em toda fronteira e ponto de variação, sem porta para a lógica interna pura; duas camadas de extensão (adaptadores oficiais no processo, terceiros só fora dele, como plugins MCP); registro de fluxos em TypeScript, com a peça teatral como padrão (os outros fluxos foram decididos depois, na seção 5.20); composição manual, sem container; pacotes `core`, `sdk` e `adapter-*`; semver por porta com suítes de conformidade; painel declarativo de plugin, sem código do plugin na interface; registros tipados, com chaves de `rule` só de módulos oficiais e eventos de plugin com prefixo `plugin.<id>.*`.
- plugin com comportamento de mod (2026-11-13, seção 5.14): um mecanismo só, sem mods em processo; depois da v1 o plugin ganha níveis opcionais (assinar eventos, ganchos de interceptação que vetam ou anotam, contribuições declarativas), sempre fora do processo.
- navegador compartilhado (2026-11-13, seção 5.19): porta oficial `BrowserSession` no daemon (Playwright sobre CDP), usada pelo agente e pela interface; indicação completa anexada ao chat, num mecanismo genérico com tipos de indicação registrados (o primeiro é `web_element`); perfil isolado por cenário; ferramentas do agente na v1 (Fase 4) e a tela com o modo indicar elemento na Fase 12.
- cenários (2026-11-13, seção 5.20; era o item 3): três tipos (projeto, tarefa e chat genérico), num registro, com as variações como perfis de projeto (`software` na v1) e gatilhos de tarefa; projeto importado mantém as convenções detectadas, confirmadas pelo Produtor; um repositório por projeto na v1, vários depois; tarefa com definição versionada e execuções, desenhada pelos papéis (Autor, Revisor, Roteirista, Atores e Crítico no ensaio), com o Diretor leve só coordenando; gatilhos de horário e manual na v1, de evento depois; no chat, Diretor barato que consulta um Ator forte; promoção cria um cenário novo ligado ao chat; Diretor adormece sem atividade e acorda pelo resumo.
- durabilidade e recuperação (2026-11-13, seção 5.21): store com `synchronous=FULL` sempre; reconciliação explícita na subida, com efeito ambíguo resolvido pelo verificador da ferramenta ou pelo Produtor; na v1 a máquina religada sem login espera o login, e a meta depois da v1 é o daemon completo sem login; backup automático diário, guardando 7.
- padrões dos cenários e da durabilidade (2026-11-14, seções 5.20 e 5.21; eram os itens 16 e 17): todos são chaves de configuração, com várias opções de escolha. Os padrões são estes: o Diretor adormece depois de 15 min; um anexo copiado tem até 50 MB; ficam as 30 últimas execuções inteiras; todas as versões da definição são guardadas; o backup roda uma vez por dia a partir das 3h (ou na primeira subida depois), na pasta `backups/` dos dados do daemon, com o store e as pastas de tarefa e chat, menos as execuções. O daemon sem login vira a Fase 10b, logo depois da v1. O mecanismo dos segredos sem login é escolhido ao abrir a fase, depois da medição.
- idioma (2026-11-14, seção 5.22): código, dados, configuração, eventos, ferramentas MCP, comandos, logs, commits do próprio OTheater e prompts em inglês; respostas ao Produtor no idioma dele, por ordem global; interface com catálogo `en` e `pt-BR` desde a primeira tela, idioma do sistema e chave `ui.locale`; nomes canônicos em inglês, com o glossário da seção 13, aprovado pelo dono no mesmo dia; detalhes aprovados no mesmo dia: a primeira subida oferece a ordem de idioma, catálogos em `locales/` carregados pelo `packages/client`, biblioteca escolhida na Fase 1, `auto` leva `pt-*` a `pt-BR` e o resto a `en`, plugin com catálogo próprio e `en` obrigatório, CI que verifica os catálogos; este repositório continua em português, com os identificadores em inglês.
- padrões do pipeline, da entrega, do agendador e da retomada (2026-11-14, seções 5.4, 5.5, 5.15 e 5.16; eram os itens 4, 5, 13 e 14): todos são chaves de configuração, com predefinições que o Produtor escolhe e chaves individuais. Os padrões são estes: `limits.preset: moderate` (`Np` 2, `Nc` 2, 3 tentativas por demanda, timeout de 30 min com teto de 2 h); `delivery.mode: pr`, com `direct_merge` só se o projeto permitir e a peça ou tarefa pedir, e `ask`; `schedule.preset: balanced` (execução perdida roda se o atraso for até 12 h, adiamento por cota até 6 h, espera por decisão de 24 h, orçamento de 1 h e US$ 5 em API); `resume.preset: balanced` (5 retomadas, espera pelo reset até 30 min, checkpoint a cada 10 min, travado com 10 min sem evento ou o mesmo erro 3 vezes).

## 13. Glossário

Os nomes em inglês são os do código, da configuração e dos prompts (5.22), aprovados pelo dono em 2026-11-14. Na interface em `pt-BR` aparece o termo em português.

| Termo | No código (en) | Significado aqui |
|---|---|---|
| Produtor | `Producer` | O dono: pede, decide e aprova pelo chat |
| Diretor | `director` | Papel que coordena um cenário; o nome antigo "Orquestrador" é o mesmo papel |
| Autor | `author` | Papel que escreve o plano da peça ou da tarefa |
| Revisor | `reviewer` | Papel que revisa o plano (e o roteiro) |
| Roteirista | `scriptwriter` | Papel que transforma o plano no roteiro de demandas; não é `playwright`, para não colidir com o Playwright (5.19) |
| Ator | `actor` | Papel que executa uma demanda |
| Crítico | `critic` | Papel que avalia a branch integrada e faz o ensaio das tarefas |
| Necessidade | `need` | O pedido do Produtor que abre uma peça |
| Roteiro | `script` | Plano dividido em demandas, com contratos e dependências |
| Etapa | `Stage` | Fase do pipeline da peça (estados como `PLANNING` e `EXECUTING`) |
| Parecer | `review` | Resultado da revisão do plano ou do roteiro |
| Crítica | `critique` | Resultado da avaliação do Crítico |
| Passagem de bastão | `handoff` | Retomada por outro Executor, com o pacote de continuação (5.16) |
| Peça | `Play` | Uma execução do pipeline para uma necessidade |
| Cenário | `Scenario` | Projeto, tarefa ou chat genérico: tem Diretor e chat próprios, pasta, anexos, ordens locais, dashboard e configuração (5.20) |
| Perfil de projeto | `ProjectProfile` | Tipo registrado de projeto que define estrutura inicial, ferramentas, permissões e artefatos gerados; o padrão é `software` (5.20). Não confundir com o perfil de assinatura |
| Tarefa | `Task` | Cenário de workflow com artefato final: uma definição versionada de passos tipados e as execuções dela (5.20) |
| Ensaio | `rehearsal` | Execução da definição de uma tarefa com dados de exemplo, sem entrega real, avaliada pelo Crítico antes da aprovação (5.20) |
| Consultor | `consultant` | Papel com modelo forte que o Diretor do chat abre quando a pergunta pede (5.20) |
| Anexo | `Attachment` | Artefato `A<n>` enviado pelo Produtor ao chat: arquivo, caminho, imagem, texto ou URL, lido com `read_attachment` (5.20) |
| Promoção | `promote` | Criação de uma tarefa ou de um projeto a partir de um chat (ou de uma tarefa), ligado ao cenário de origem (5.20) |
| Executor | `Executor` | Cliente + perfil + modelo + esforço |
| Perfil | `Profile` | Uma assinatura ou chave de API de um cliente, com diretório isolado |
| Demanda | `Demand` | Unidade de trabalho do roteiro, executada por um Ator |
| Tentativa | `Attempt` | Uma execução de uma demanda por um Executor, numa worktree própria |
| Ordem | `Directive` | Instrução do Produtor que vale além de uma peça, global ou local a um cenário, durante a sua vigência e até ser revogada (5.17) |
| Blackboard | `Blackboard` | Memória compartilhada da peça (plano, roteiro, contratos, decisões) |
| Casca | `Wrapper` | Ferramenta do framework que envolve uma ferramenta existente com política e telemetria |
| Ponto de julgamento | `JudgmentPoint` | Decisão do Diretor tomada por modelo, com saída validada por schema |
| Config option | `ConfigOption` | Opção de sessão anunciada pelo adaptador ACP (modelo, esforço, modo) |
| Porta | `Port` | Interface TypeScript + schemas zod em `@otheater/core`, com versão própria, para uma fronteira ou um ponto de variação (5.18) |
| Adaptador | `Adapter` | Implementação de uma porta, num pacote `@otheater/adapter-*`, escolhida pela configuração (5.18) |
| Registro | `Registry` | Lista tipada de entradas (fluxos, papéis, ferramentas, chaves de `rule`, tipos de evento), validada na subida do daemon (5.18) |
| Fluxo | `Flow` | Máquina de estados registrada por nome e versão; a peça teatral é o fluxo padrão (5.4, 5.18) |
| Navegador compartilhado | `BrowserSession` | Sessão de navegador do cenário, usada pelo agente e pelo Produtor ao mesmo tempo (5.19) |
| Indicação | `Indication` | Artefato `I<n>` que aponta algo para o agente (5.19): um tipo registrado (o primeiro é `web_element`), o conteúdo validado pelo schema do tipo e o comentário do Produtor |
| Superfície | `Surface` | Parte do sistema que oferece o modo indicar e declara os tipos de indicação que produz; a primeira é o navegador compartilhado (5.19) |
| Reconciliação | `reconcile` | Rotina da subida do daemon que acha e resolve o que ficou pela metade (órfãos, sessões, worktrees, efeitos ambíguos) antes de retomar (5.21) |
| Efeito ambíguo | `ambiguous` | Efeito colateral com "antes" e sem "depois" gravados: não se sabe se aconteceu. É resolvido pelo verificador da ferramenta ou pelo Produtor (5.21) |
| Ponto de montagem | `compose.ts` | O único lugar do daemon que escolhe e liga os adaptadores às portas (`compose.ts`, 5.18) |

## 14. Fontes principais (consultadas em 2026-11-13)

- ACP: agentclientprotocol.com (session-setup, session-config-options, clients); github.com/agentclientprotocol (typescript-sdk, claude-agent-acp, codex-acp)
- MCP SDK v2: ts.sdk.modelcontextprotocol.io; blog.modelcontextprotocol.io
- Claude Code: code.claude.com/docs (permissions, cli-reference, sandboxing, statusline, authentication, env-vars, monitoring-usage, legal-and-compliance, llm-gateway, agent-sdk/subagents)
- Codex: learn.chatgpt.com/docs (app-server, config-advanced, auth, windows-sandbox)
- OpenCode: opencode.ai/docs (acp, permissions, server, sdk, troubleshooting)
- MiniMax: platform.minimax.io/docs (coding-plan, token-plan/faq)
- XState: stately.ai/docs/persistence
- Sandbox: github.com/anthropic-experimental/sandbox-runtime
- ATIF: github.com/harbor-framework/harbor (rfcs/0001-trajectory-format.md); docs.harborframework.com
- OTel GenAI: opentelemetry.io/docs/specs/semconv/gen-ai
- Reaproveitamento: github.com/generalaction/emdash, openclaw/acpx, stablyai/orca, ryoppippi/ccusage, steipete/CodexBar, assistant-ui.com, ui.shadcn.com, github.com/vercel/ai-elements, docs.1mcp.app, github.com/ohadravid/win32job-rs, ai.google.dev/gemma (Gemma 4)

## 15. Revisão v0.1 → v0.2 (o que mudou e por quê)

| Ponto | v0.1 | v0.2 | Motivo |
|---|---|---|---|
| Adaptadores ACP | Escritos por nós | Pacotes prontos (`claude-agent-acp`, `codex-acp`, nativos) | Já existem e são mantidos |
| Modelo/esforço | Tradução manual por cliente | Session Config Options do ACP | Recurso padrão do protocolo |
| Crítico | Avaliava antes do merge | Avalia a branch **integrada** (`INTEGRATING`) | O documento original pede avaliar o trabalho conjunto; testes precisam do código combinado |
| Timeout do Ator | Sem mecanismo de repasse | Commit WIP automático | Permite "outro Ator terminar" e a retomada após reinício |
| Prompts ao Orquestrador | Concorrência não tratada | Fila única com prioridade para o Produtor | Evita dois `session/prompt` simultâneos |
| Falha do Orquestrador | Não tratada | Failover para o próximo Executor com resumo do store | Cota do Diretor também esgota |
| Dependências refeitas | Não tratado | Rebase ou refação das dependentes | Branch dependente ficaria desatualizada |
| Roteiro | Executado direto | Validado em código (ciclos, contratos, arquivos) | Pega erro barato antes de gastar Atores |
| Máquina de estados | Própria | XState v5 com snapshot no SQLite | Biblioteca madura com persistência |
| Permissões | "Camada 1 bloqueia" | Configuração = política; fronteira = sistema operacional | Deny de Bash é contornável; Claude Code no Windows não tem sandbox |
| Job Objects | koffi | Lançador Rust (`win32job`), koffi como alternativa | O Node não cria processo suspenso; há janela de fuga |
| Cotas | "Fase 0 levanta" | Fontes concretas por provedor | Pesquisa encontrou statusline, app-server, endpoint MiniMax |
| Telemetria | Instrumentar | Reaproveitar o OTel nativo de Claude Code e Codex | Já existe |
| ATIF | Formato a confirmar | Harbor ATIF-v1.8, validador do Harbor | Especificação localizada |
| Modelo local | "Gemini 27B" | Gemma 4 (26B-A4B / 31B) | Gemini não tem pesos abertos; Gemma 3 é fraco em ferramentas |
| UI | Componentes próprios | assistant-ui, shadcn, xyflow | Já existem |
| Termos | Genérico | Regra concreta da Anthropic e consequência para o modo produto | Pode mudar o modelo de distribuição |
| Estimativa | 19–24 semanas | 17,5–20 (14–16 com fork) | Reaproveitamento; a Fase 0 cresce um pouco |
| Licenças (v0.3) | Sem política | MIT por padrão, quatro níveis (copiado, empacotado, externo, desenvolvimento) e exceções listadas | Preferência do projeto por MIT |
| Banco (v0.3) | Drizzle | Kysely | Drizzle é Apache-2.0 |
| Base de fork (v0.3) | Emdash, Orca, AionUi | Orca, Paradev, Happier | Emdash e AionUi são Apache-2.0 |
| Agregador MCP (v0.3) | 1MCP como sidecar | Próprio; 1MCP só se MIT | Licença não confirmada |
| Licenças (v0.4) | Só MIT, com duas exceções Apache | MIT, Apache-2.0, ISC, BSD-2/3, 0BSD permitidas; copyleft proibido; obrigações da Apache automatizadas na CI | Apache-2.0 aceita; e a lista só-MIT reprovaria dependências transitivas ISC/BSD comuns no npm |
| Base de fork (v0.4) | Orca, Paradev, Happier | Emdash (principal), Orca, AionUi, Paradev, Happier | Emdash volta a ser o melhor encaixe técnico |
| Sandbox (v0.4) | Só envoltório externo | Biblioteca ou envoltório | Apache-2.0 permitida no nível B |
| TUI (v0.5) | "Futura, opcional", Ink citado de passagem | Ink por padrão, com teste comparativo contra OpenTUI na Fase 0; Fase 12 própria, opcional e fora do total | Mockup da TUI aprovado; Ink reaproveita o modelo React da web |
| Layout (v0.5) | Telas descritas por função | Layout comum app/TUI: chat em altura total e largura ajustável, lateral retrátil, Configurações como aba, tudo recolhível menos o chat | Mockups de referência em `mockup/` |
| Ordem das interfaces (v0.6) | Web principal (Fase 7), TUI opcional (Fase 12) | **TUI principal (Fase 7)**; web (Fase 12) e desktop (Fase 13) opcionais; teste Ink × OpenTUI obrigatório | Preferência do produto; o uso começa no terminal e o próprio framework passa a ser usado mais cedo |
| Camada compartilhada (v0.6) | Reuso entre TUI e web implícito | `packages/client` (cliente da API + stores zustand vanilla + preferências de layout) na Fase 6 | O reaproveitamento entre TUI e web é de lógica, não de tela |
| Distribuição (v0.6) | Fase 10 = app desktop | Fase 10 = daemon + TUI em executável único e serviço de logon; desktop vira Fase 13 | O desktop depende da web |
| Estimativa (v0.6) | 18–20,5 sem (11,5–14,5 com agentes) | 19–21 sem (11,5–15 com agentes) até o produto completo na TUI; web + desktop + 3–3,5 (1,5–2,5) | Fase 6 cresce com o `packages/client`; TUI completa no caminho crítico |
| Atalhos da TUI (v0.7) | Fixos (Ctrl+B, Ctrl+J, Ctrl+←/→, Ctrl+T/W, Ctrl+K) | Mapa de teclas configurável, padrões por sistema/ambiente, alternativas com Alt, paleta com dois atalhos | Colisões no macOS (Mission Control, Cmd não chega), tmux (Ctrl+B), VS Code (Ctrl+K) e Ctrl+J = LF |
| Nome (v0.8) | "Framework Multiagente" | **OTheater** (*Orchestration Theater*), comando `ot` | Escolha do produto; nomes conferidos no npm e no GitHub |
| Agendador (v0.9) | Inexistente | Seção 5.15 e Fase 9b: tarefas únicas, cron, intervalo e após reset da cota; regras de execução perdida, sobreposição, cota e decisão sem ninguém olhando; gatilho do sistema operacional para acordar a máquina; aba Agenda | Pedido do produto; o daemon já tinha o estado e o pipeline necessários |
| Retomada de sessões (v0.10) | Só devolução à fila no reinício, WIP no timeout e failover do Orquestrador | Seção 5.16: retomada nativa (`session/load`) ou passagem de bastão com pacote de continuação, política por causa, checkpoints periódicos, idempotência de efeitos colaterais, interrupções externas fora da contagem de tentativas | Sessões de qualquer papel podem parar por cota, rede, queda ou reinício e precisam continuar sem perda nem repetição |
| Ordens do Produtor (v0.11) | Inexistentes | Seção 5.17: ordens globais (um registro para todos os cenários) e locais (um projeto, tarefa ou chat), dos tipos `instruction`, `rule` e `suspension`; vigência com início, fim, duração e janela recorrente, calculada pelo relógio; prorrogação; revogação com motivo, em lote e definitiva; criação só pelo Produtor; entrada no prefixo, no Crítico e na retomada. Estimativas das fases não revistas | Conceito do `okit` trazido para o OTheater, redesenhado para evitar cópias por projeto e texto com efeito em código; vigência por período e revogação refinadas a pedido do dono; pontos em aberto decididos pelo dono no mesmo dia, incluindo a dispensa do Crítico (5.4) |
| Abstrações (v0.12) | Uma interface própria (`ClientAdapter`) e o resto ligado direto às bibliotecas | P12 e seção 5.18: portas em `@otheater/core` para toda fronteira e ponto de variação, adaptadores trocáveis em `@otheater/adapter-*`, registros tipados (fluxos, papéis, ferramentas, chaves de `rule`, eventos, interface), composição manual, semver por porta com suítes de conformidade em `@otheater/sdk`, painel declarativo de plugin; Fase 1 cresce 0,5 semana | Pedido do dono: com tudo em TypeScript, abstrair ao máximo para ganhar flexibilidade e facilidade de expansão; as escolhas de desenho foram decididas pelo dono no mesmo dia; no mesmo dia, o dono decidiu que o comportamento de mod vira nível opcional do plugin depois da v1, sem mecanismo separado (5.14) |
| Navegador compartilhado (v0.13) | Só `http_get` e plugins MCP para a web | Seção 5.19: porta `BrowserSession` (Playwright sobre CDP) no daemon, uma sessão para o agente e para o Produtor, ferramentas `browser_*` com aprovação das ações de escrita, modo indicar genérico, com indicações `I<n>` de tipos registrados (o primeiro é `web_element`) anexadas ao chat, perfil isolado por cenário; tabelas `browser_sessions` e `indications`; R17; Fase 4 e Fase 12 crescem 0,5 semana cada | Pedido do dono: um navegador na web e no desktop em que ele indica elementos da página para o agente trabalhar; escolhas decididas pelo dono no mesmo dia, e a generalização para outros tipos foi pedida por ele em seguida |
| Cenários (v0.14) | Projeto, tarefa e chat citados, sem definição; tarefa geral sem formato (N3) | Seção 5.20: base comum (Diretor e chat próprios, pasta, anexos `A<n>`, Diretor adormecido); registro de tipos de cenário; projeto com perfil (`software`: changelog, commits, PRs, publicação, CI) e importação que respeita as convenções; tarefa com definição versionada desenhada pelos papéis e ensaiada, motor de passos tipados e gatilhos; chat com Diretor barato e papel `consultant`; promoção para cenário novo ligado; tabelas `scenario_repos`, `task_definitions`, `task_runs` e `attachments`; R18; Fases 3, 4 e 9b crescem | Definições do dono para os três tipos; escolhas decididas por ele no mesmo dia, incluindo usar os papéis para desenhar a tarefa e deixar o Diretor leve |
| Durabilidade (v0.15) | Snapshot por transição, retomada (5.16) e regra da janela (5.15), sem modo de gravação definido, sem rotina de reconciliação, sem backup e sem resposta para a máquina religada sem login | Seção 5.21: `synchronous=FULL`; gravar antes de agir; reconciliação na subida com verificadores de efeito; na v1 espera o login, depois daemon completo sem login; backup diário com 7 cópias; R19; Fase 3 cresce 0,5 semana | Pergunta do dono sobre fechar a interface, reiniciar e faltar luz; escolhas decididas por ele no mesmo dia |
| Idioma (v0.17) | Identificadores em português, sem regra de idioma; interface só em português nos mockups | Seção 5.22: código, dados, configuração, eventos, ferramentas, comandos, logs e prompts em inglês; respostas ao Produtor no idioma dele, por ordem; catálogo `en` e `pt-BR` desde a primeira tela, com `ui.locale`; glossário com o nome em inglês de cada termo; identificadores deste documento renomeados (os antigos estão no histórico do git, e o glossário faz a ponte) | Pergunta do dono; escolhas decididas por ele no mesmo dia |
| Padrões do pipeline (v0.18) | `Np`, `Nc`, tentativas, timeouts, política de entrega, regras do agendador e da retomada sem valor (itens 4, 5, 13 e 14) | Chaves `limits.*`, `delivery.*`, `schedule.*` e `resume.*`, cada grupo com três predefinições e chaves individuais; padrões `moderate`, `pr`, `balanced` e `balanced` | Decisões do dono, que pediu que cada padrão seja chave de configuração com várias opções |
| Licença do código próprio (v0.19) | Código próprio em MIT; MPL proibida em código copiado e dependências | Código próprio em MPL-2.0; MPL-2.0 permitida em código copiado e dependências, com obrigações; GPL, AGPL e LGPL seguem proibidas; CLA ou DCO em aberto (item 18) | Decisão do dono, depois de uma pergunta sobre uso comercial |
| App Android (v0.20) | Interfaces só no computador (TUI, web e desktop opcionais); acesso remoto em aberto (item 9) | App Android para celular e tablet na Fase 14, com Capacitor sobre a web; tablet com o app completo, celular enxuto; acesso pela VPN do usuário, com pareamento por QR e token por aparelho (`api.remote`); a web deixa de ser opcional; notificações e distribuição em aberto (itens 19 e 20); mockup `mockup/mobile.html`, com os comandos pelo celular como proposta | Decisão do dono |
| Executores padrão (v0.21) | Exemplo de lista por papel, sem Roteirista, com nomes sem regra (`haiku`, `codex-high`, `minimax`); padrões da primeira execução em aberto (item 8) | Nome `<modelo>-<esforço>@<perfil>`, com prefixo `claude-` e o sufixo da conta em todos; todos os papéis com lista de fallback; `ot init` detecta e aplica `roles.preset` (`quality` padrão, `balanced`, `economical`), acrescenta o Executor por API; Diretor `claude-haiku-low`, `codex-luna-low`, `gemma4-low`; `selection.cross_check: prefer_other_provider`; teto de gasto em API em aberto (item 21) | Decisão do dono |
| Custo e teto de gasto (v0.22) | Custo em moeda e teto de gasto em API em aberto (itens 10 e 21); só o orçamento por execução das tarefas agendadas | Assinatura com cota e equivalente em API, API com custo real, valor do cliente ou da tabela `pricing`; `budget` por dia e mês no perfil de API, aviso em 80%, `on_exceeded: skip`, `in_flight: handoff`; despertares no store (`wakeups`) retomam o trabalho quando a cota ou o teto voltam | Decisão do dono |
| Modelo local e provedor (v0.23) | §5.9 restringia o modelo local ao Orquestrador e a julgamentos curtos, mas a predefinição `economical` o punha entre os Atores; o provedor de um modelo local na revisão cruzada não estava definido; o nome `@<perfil>` não mostrava o cliente, e o OpenCode pode chamar o mesmo modelo do Claude por API; a §5.20 dava override da configuração a todo cenário, mas a §5.7 e a tabela `roles` só falavam de projeto; o `ot init` concentrava a configuração inicial num script, propenso a falhas | Modelo local como Ator limitado pelos slots da instância, com reserva para o Diretor (`local.slots`, `local.reserve_for_director`, `local.reserve_when`); provedor = família do modelo, campo `provider` do Executor; assistente de cadastro para os Executores do OpenCode, com validação pelo daemon e entrada nas listas dos papéis por `executors.on_register: ask`; `ModelCatalog` no `ClientAdapter` e porta `LocalModelServer` (llama.cpp na v1, Ollama depois); nome `<modelo>-<esforço>@<cliente>/<perfil>` e `executors.cross_client: api_only`; configuração dos papéis global com override por papel em cada cenário e tarefa agendada; `ot init` mínimo e assistente de configuração no daemon, desenhado pela TUI na v1 | Decisões do dono antes de abrir a pergunta sobre modelos locais por papel |
| Capacidade mínima por papel (v0.24) | Só `toolcall` validado no cadastro; a capacidade mínima de cada papel era a pergunta seguinte, e não se sabia se modelo local servia a todos os papéis | Todos os papéis aceitam modelo local; mínimo igual para local e nuvem em `roles.<papel>.requires` (janela de contexto, por slot no modelo local; raciocínio nos papéis que decidem); sessão de teste no cadastro; `roles.capability_check: warn` marca sem bloquear; a seleção pula quem não comporta o prompt | Escolha do dono: o que limita um papel é a capacidade do modelo, não onde ele roda, e o Produtor decide com o aviso à vista |
| Daemon como serviço de logon (v0.25) | Daemon como serviço de logon ou dentro do app desktop (`utilityProcess`), em aberto (item 6) | Sempre serviço de logon; o app desktop é só mais um cliente e instala o serviço pelo assistente quando ele falta | Escolha do dono: um daemon só por usuário, e as tarefas agendadas não dependem de uma janela aberta |
| Perguntas ao Produtor (v0.26) | `ask_producer` sem schema; múltipla escolha só como exemplo de ordem `instruction`; tarefa agendada pausava e notificava | Schema com opções, recomendada e "Outra"; `chat.producer_questions: choices` e `chat.unanswered: wait_then_recommended` (30 min); agendadas seguem com a recomendada depois do prazo da predefinição; decisões irreversíveis só com a opção segura | Pedido do dono: decidir com um toque e não depender de o modelo lembrar de um texto; nas agendadas, mais flexibilidade, com a salvaguarda para o que não se desfaz |
| Padrões (v0.16) | Padrões dos cenários e do backup sem valor (itens 16 e 17); migração sem login sem data | Chaves `scenarios.*`, `tasks.*` e `backup.*` com várias opções e padrões definidos; backup inclui as pastas de tarefa e chat, menos as execuções; Fase 10b do daemon sem login | Decisões do dono, que pediu que cada padrão seja chave de configuração |
| Cofre no Linux (v0.7) | Só Secret Service | Fallback para arquivo criptografado ou variável de ambiente do serviço | Servidores sem interface gráfica e sessões SSH não têm Secret Service |
| Teste de terminais da Fase 0 (v0.7) | Windows Terminal, VS Code e um de macOS/Linux | Inclui Terminal.app, iTerm2, GNOME Terminal/Konsole, tmux, SSH e todos os atalhos | Os padrões do mapa de teclas saem desse teste |
