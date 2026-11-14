# Arquitetura — OTheater (Orchestration Theater)

> Documento-base de construção. Complementa `framework_multiagentes.md` (pipeline teatral), `framework_multiagentes_orquestrador_e_executores.md` (entidades) e `principais-papeis.md`. Onde este documento detalha *como*, aqueles definem *o quê*.
>
> Versão 0.11 — 2026-11-13. Produto: **OTheater** (*Orchestration Theater*). Linguagem: **TypeScript** de ponta a ponta. Licença do código próprio: **MIT**.
> A v0.5 definiu a TUI em **Ink**, com teste do **OpenTUI** na Fase 0, e ligou as interfaces aos mockups em `mockup/`. A v0.6 faz da **TUI a interface principal** (Fase 7), cria o `packages/client` compartilhado e deixa web e desktop como fases opcionais (12 e 13). A v0.7 acrescenta o suporte multiplataforma da TUI: mapa de teclas configurável com padrões por sistema, fallback do cofre no Linux e uso por SSH. A v0.11 acrescenta as **ordens do Produtor**, globais e locais (seção 5.17), conceito trazido do `okit`.
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
| P4 | Estado fora do modelo | Tudo persiste no daemon; o Orquestrador consulta `proxima_acao` e sobrevive a compressão de contexto ou reinício |
| P5 | Bloquear tudo, liberar o necessário | Permissões por lista de permitidos, por papel, em três camadas; a configuração do cliente é política, não fronteira de segurança |
| P6 | Tudo é evento | Um único log de eventos alimenta dashboard, SSE, OTel, ATIF e auditoria |
| P7 | Daemon separado da interface | Fechar a UI não interrompe as peças; várias UIs (web, desktop, TUI) sobre a mesma API |
| P8 | Contexto mínimo por Executor | O Ator nasce com demanda + contrato; artefatos circulam por referência |
| P9 | Recursos sob controle de admissão | O paralelismo é limitado por RAM, cota e pool, não só pelo que o Roteirista permite |
| P10 | Versões fixadas | ACP, adaptadores e CLIs mudam toda semana: tudo fixado, atualizado de propósito, com testes de contrato |
| P11 | Só licenças permissivas | Código próprio em MIT; código copiado e dependências empacotadas em MIT, Apache-2.0, ISC ou BSD; copyleft proibido (seção 6.0) |

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
- **Windows primeiro**, sem impedir macOS/Linux. O que é específico do sistema operacional fica atrás de `platform/`.
- **Segredos:** chaves de API ficam no cofre do sistema operacional; nunca em arquivo de configuração, log ou evento.
- **Operação local por padrão:** o daemon escuta em `127.0.0.1`; acesso remoto exige token + TLS.

## 4. Visão geral

```
┌──────── Interfaces: TUI Ink (principal) · web e desktop (opcionais) ─────────────────┐
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

**ACP em dois níveis:** o daemon é cliente ACP da sessão do Orquestrador (com quem você conversa pelo chat) e também de todos os Executores. O Orquestrador **não** abre Executores: ele chama ferramentas MCP do framework, e é o daemon que abre as sessões.

## 5. Componentes

### 5.1 Daemon

- Processo Node de longa duração, iniciado como serviço de logon do usuário ou pelo app desktop.
- Um único daemon por usuário/máquina, garantido por lock de arquivo sobre o store.
- Responsável pelo estado global, pelo ciclo de vida dos Executores, pela execução das ferramentas homologadas e pela API das interfaces.
- **Recuperação ao reiniciar:**
  1. relê o store;
  2. reidrata a máquina de estados de cada peça a partir do snapshot XState persistido;
  3. marca as sessões ACP que estavam em curso como `interrompida`;
  4. devolve as demandas correspondentes à fila, preservando o trabalho já commitado nas worktrees (ver 5.5).

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
  processModel: 'processo-por-sessao' | 'multissessao';                // medido na Fase 0
}
```

**Pools por `(cliente, perfil)`:**
- até `K` sessões por processo do adaptador; acima disso, abre outro processo;
- processo ocioso por `idleMs` é encerrado;
- processo travado é morto, e as sessões dele voltam para a fila;
- no Claude Code, o custo de RAM é por sessão (um `claude` por sessão), então o semáforo de admissão conta sessões, não processos do adaptador.

**Isolamento:** todo processo de Executor nasce pelo **lançador com Job Object** (ver 5.9). Ele limita a memória e mata a árvore inteira no cancelamento.

**Ciclo curto:** sessão termina → resultado estruturado gravado → sessão fechada.

**Saída de emergência:** se um adaptador se mostrar instável, a interface permite trocá-lo pelo modo headless do próprio cliente sem mexer no resto:
- `claude -p --output-format stream-json`;
- `codex exec --json`, ou o `@openai/codex-sdk`.

### 5.3 Servidor MCP do framework

- Um único servidor, com **MCP SDK v2** (`@modelcontextprotocol/server`) em Streamable HTTP, servido pelo daemon.
- O SDK v2 usa uma fábrica por requisição (`createMcpHandler(factory)`). A fábrica lê o token da sessão e devolve só as ferramentas daquele papel/peça/demanda. É ali que o filtro por papel é implementado.

| Conjunto | Ferramentas |
|---|---|
| Diretor (Orquestrador) | `proxima_acao`, `status(peca?)`, `decidir(decisaoId, payload)`, `abrir_peca(necessidade)`, `pausar`, `retomar`, `cancelar_ator`, `perguntar_produtor`, `abrir_pr`, `agendar` (rascunho, confirmado pelo Produtor), `listar_agenda`, `pausar_agenda`, `listar_ordens`, `propor_ordem`, `prorrogar_ordem` e `revogar_ordem` (rascunhos, confirmados pelo Produtor; 5.17) |
| Comum (todos os Executores) | `ler_blackboard(chave)`, `ler_contrato(id)`, `ler_decisao(id)`, `entregar(resultado)` |
| Autor / Revisor / Roteirista | `entregar_plano`, `entregar_parecer_plano`, `entregar_roteiro` (cada um com schema próprio) |
| Ator | `run_tests(alvo)`, `install_deps()`, `git_commit(mensagem)`, `shell_restrito(argv)`, `http_get(url)` + plugins do papel |
| Crítico | `run_tests(alvo)`, `ver_diff(demanda?)`, `entregar_critica` |

`entregar*` é a única forma de um Executor terminar:
- a saída é validada com **zod** contra o schema do papel;
- saída inválida volta ao Executor com o erro de validação, até `N` vezes;
- depois disso, conta como falha da tentativa.

### 5.4 Máquina de estados do pipeline

**XState v5** modela a peça. O snapshot (`getPersistedSnapshot()`) é gravado no SQLite a cada transição e reidratado no reinício.

Cuidados conhecidos:
- restaurar só na mesma versão da máquina (o snapshot guarda a versão, e há migração explícita quando ela mudar);
- não depender de *history states*;
- não deixar promessas em voo dentro da máquina: efeitos longos (sessões ACP) ficam fora dela e voltam como eventos.

Fluxo:

```
NECESSIDADE
  → PLANEJANDO (Autor)
  → REVISANDO_PLANO (Revisor) ──reprovado──→ PLANEJANDO        [contador plano ≤ Np]
  → ROTEIRIZANDO (Roteirista)
  → EXECUTANDO (Atores, DAG de demandas)
  → INTEGRANDO_TESTE (merge das demandas na branch de integração; conflito = falha de roteiro)
  → CRITICANDO (Crítico, sobre a branch integrada)
  → DECIDINDO (Diretor)
       ├─ aprovado ──────────→ ENTREGANDO (PR/merge na base) → CONCLUIDA
       ├─ falha de execução ─→ EXECUTANDO (só demandas afetadas)
       ├─ falha de roteiro ──→ ROTEIRIZANDO → REVISANDO_ROTEIRO (Autor) → EXECUTANDO
       ├─ falha estrutural ──→ PLANEJANDO (recomeça Revisor → Roteirista → ...)
       └─ exceção crítica ───→ AGUARDANDO_PRODUTOR
  [reprovações do Crítico > Nc] → falha estrutural; se já estrutural → AGUARDANDO_PRODUTOR
```

- Transições, contadores e limites (`Np`, `Nc`, tentativas por demanda) ficam em código e configuração, nunca no prompt.
- **Dispensa do Crítico** (decidida em 2026-11-13; ver 5.17): é uma decisão registrada do Produtor, com motivo, e vale sempre para a **peça inteira**. Pode ser tomada em dois momentos:
  - ao abrir a peça: a máquina pula CRITICANDO e DECIDINDO, e vai de INTEGRANDO_TESTE a ENTREGANDO. Os testes da integração continuam rodando;
  - com a peça em AGUARDANDO_PRODUTOR depois de uma reprovação ("aceito assim"): a peça vai a ENTREGANDO.
  - Nos dois casos, o PR informa que o Crítico foi dispensado, por quem e por quê. Nenhuma ordem dispensa o Crítico.

**Pontos de julgamento.** São os únicos lugares onde o modelo do Diretor decide, cada um com schema:
1. classificar a crítica negativa (execução / roteiro / estrutural / exceção) e listar as demandas afetadas;
2. Ator estourou o tempo: o trabalho parcial (já commitado, ver 5.5) segue para o Crítico ou para outro Ator continuar;
3. quando consultar o Produtor, e o que perguntar.

**Fila única de prompts do Orquestrador.** Mensagens suas no chat e avisos do daemon ("decisão pendente D-17; chame `proxima_acao`") entram numa fila e são enviados à sessão do Orquestrador um de cada vez. Nunca dois `session/prompt` concorrentes. Mensagem do Produtor tem prioridade sobre aviso do daemon.

**Andamento sem custo de modelo.** "Ator 2 concluiu", "Crítico reprovou (1/3)" e semelhantes são mensagens de sistema que o daemon envia direto ao chat da UI, sem passar pelo modelo.

**Failover do Orquestrador.** Se o perfil do Diretor esgotar a cota ou falhar, o daemon abre uma sessão nova com o próximo Executor da lista do papel. Ela recebe um resumo gerado a partir do store (estado da peça, decisões pendentes, ordens vigentes, últimas mensagens do chat). Nada se perde, porque o estado nunca esteve só no modelo.

**Roteiro = DAG de demandas.** Cada demanda:

```ts
interface Demanda {
  id: string;
  titulo: string;
  descricao: string;
  dependeDe: string[];             // arestas do DAG
  contrato: {                      // interface rígida entre Atores
    entradas: ContratoRef[];       // o que consome de outras demandas
    saidas: ContratoRef[];         // o que entrega (arquivos, APIs, tipos, schema)
  };
  arquivosEsperados: string[];     // escopo: detecção de conflito, sparse checkout
  complexidade: 'baixa' | 'media' | 'alta';
  especialidade?: string;          // "python", "sql", "frontend"... escolhe plugins e Executor
  timeoutMin: number;
  criteriosAceite: string[];
}
```

O Diretor executa o DAG em ordem topológica e libera em paralelo o que não tem dependência pendente, **limitado pelo controle de admissão** (5.9).

**Validação do roteiro** antes de executar, em código:
- DAG sem ciclos;
- contratos referenciados existem;
- duas demandas paralelas não declaram o mesmo arquivo em `arquivosEsperados`.

Se falhar, o roteiro volta ao Roteirista sem gastar Atores.

### 5.5 Workspace (git)

Wrapper fino em TS sobre `git worktree` e `gh`. Padrões emprestados do **ccmanager** (MIT, TS): arquivo `.worktreeinclude` para copiar `.env` e arquivos não versionados para a worktree, e hooks pós-criação.

**Branches:**
- a peça cria `peca/<id>` a partir da branch base do projeto;
- cada tentativa ganha worktree + branch `peca/<id>/<demanda>/<tentativa>`;
- a base dessa branch é `peca/<id>`, ou a branch aprovada da dependência quando o contrato exige o código dela;
- se a dependência for refeita, as dependentes são rebaseadas ou refeitas (decisão do Diretor, registrada como evento).

**Commit de segurança:** no timeout, cancelamento ou interrupção, o daemon faz um commit WIP automático da worktree. É isso que permite "outro Ator terminar" o trabalho e a retomada após reinício. Desde a v0.10 há também checkpoints periódicos e política de retomada por causa: ver 5.16.

**`INTEGRANDO_TESTE`:**
- as branches das demandas concluídas entram em `peca/<id>/integracao`, em ordem topológica;
- o Crítico avalia **o trabalho combinado**, e os testes rodam sobre o código integrado;
- conflito de merge = falha de roteiro.

**`ENTREGANDO`:** PR de `peca/<id>/integracao` para a base (`gh pr create`), ou merge direto se a política do projeto permitir.

**Limpeza:** worktrees de tentativas descartadas são removidas; as aprovadas, depois da entrega.

**Dependências:** caches com hardlink (`pnpm store`, `uv`). Sparse checkout opcional a partir de `arquivosEsperados`.

### 5.6 Assinaturas e cotas

**Perfil** = diretório isolado (`<dados>/profiles/<id>/`):

| Cliente | Isolamento | Observações |
|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` (oficial) | No Windows, a credencial fica em `<dir>\.credentials.json`. Uma `ANTHROPIC_API_KEY` presente no ambiente sempre vence, então o daemon remove do ambiente do processo as variáveis que não pertencem ao perfil. |
| Codex | `CODEX_HOME` | Exige `cli_auth_credentials_store = "file"` no `config.toml` do perfil. No modo keyring/auto, a entrada do cofre pode ser compartilhada entre perfis **[a confirmar]**. |
| OpenCode | `XDG_DATA_HOME`/`XDG_CONFIG_HOME` + `OPENCODE_DB` | O isolamento por XDG só tem relatos de terceiros. Testar na Fase 0. |

**API:** a chave vai para o cofre do sistema operacional (`@napi-rs/keyring`; o `keytar` foi arquivado em 2022) e é injetada como variável de ambiente só no processo do Executor.
- Backends: Credential Manager (Windows), Keychain (macOS), Secret Service (Linux).
- **Linux sem Secret Service** (servidor sem interface gráfica, sessão SSH): fallback para um arquivo criptografado com senha mestra, pedida na abertura do daemon, ou chave só em variável de ambiente do serviço. O daemon informa qual backend está em uso, e nunca grava a chave em texto puro.

**Remoção de perfil:**
1. o perfil vai para `drenando`: não recebe sessões novas, e as que estão em curso terminam ou voltam à fila;
2. logout;
3. remoção do diretório.

Executores que usavam o perfil ficam `invalidos`, sem quebrar as listas dos papéis.

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
- **Estado por perfil:** `ok | perto_do_limite | esgotado(ateReset) | desconhecido`.

### 5.7 Seleção de Executor

Configuração por papel: lista ordenada de Executores + regra quando ninguém está disponível.

```yaml
papeis:
  diretor:  { executores: [haiku, gemma4-local] }
  autor:    { executores: [opus-alto, codex-alto] }
  revisor:  { executores: [codex-alto, opus-alto] }
  critico:  { executores: [opus-alto, codex-alto], se_esgotado: esperar }
  ator:     { executores: [codex-alto, sonnet-medio, minimax], se_esgotado: proximo }
```

Algoritmo, para cada demanda ou etapa:
1. percorre a lista na ordem. Um Executor é **disponível** quando:
   - o perfil está saudável;
   - a cota não está esgotada;
   - há vaga no pool;
   - o controle de admissão permite;
2. pega o primeiro disponível;
3. se ninguém estiver disponível:
   - `proximo`: espera o primeiro da lista que liberar;
   - `esperar`: aguarda o reset do primeiro da lista, sem rebaixar;
4. **retry com diversidade:** a nova tentativa de uma demanda que falhou começa pelo Executor seguinte ao da tentativa anterior;
5. o motivo da escolha vira evento (`executor.selecionado`, com os Executores pulados e por quê).

**Override por projeto:** um projeto pode restringir perfis (ex.: só o plano da empresa).

**Esforço:** abstrato na configuração (`baixo | medio | alto`). Aplicado pela config option `thought_level`/`model_config` que o adaptador anuncia (5.2), com fallback por adaptador.

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

**Modelo local:**
- uma instância compartilhada (llama.cpp `--parallel` ou Ollama) com poucos slots;
- usada para o Orquestrador e julgamentos curtos, não para Atores em paralelo.

**Daemon e UI:** eventos vão direto para o SQLite; a UI virtualiza listas e pagina trajetórias.

### 5.10 Contexto (tokens)

- **Ator enxuto:** o prompt inicial tem regras do projeto + ordens vigentes (5.17) + papel + contrato da demanda + caminho da worktree. Usar `systemPrompt` do `session/new` quando o adaptador anunciar suporte.
- **Blackboard** no store: plano, roteiro, contratos e decisões. Lido sob demanda (`ler_blackboard`, `ler_contrato`), nunca colado inteiro.
- **Artefatos por referência:** caminho, id, hash.
- **Saída estruturada:** o Executor termina com `entregar(resultado)` (o que fez, arquivos tocados, testes, pendências). O Crítico lê diff integrado + resultados, não trajetórias.
- **Prompt caching:**
  - prefixo estável igual para todos os Executores do mesmo papel e projeto, nesta ordem: regras → ordens → papel → contratos. O início, o fim, a revogação ou a suspensão de uma ordem mudam o prefixo das sessões seguintes, não o das sessões em curso;
  - a parte variável vai no fim;
  - opcional: aquecer o cache com o primeiro Ator antes de liberar os demais.
- **Orquestrador sem memória própria:** sempre `proxima_acao` / `status`.

### 5.11 Observabilidade

**Log de eventos** (tabela `events`, id crescente) é a fonte única. Tipos principais:
- `peca.*`, `etapa.*`, `demanda.*`, `tentativa.*`;
- `sessao.update` (mensagens, tool calls, diffs, plano);
- `executor.selecionado`, `permissao.*`, `ferramenta.chamada`;
- `cota.*`, `consumo.*`, `decisao.*`, `chat.*`, `ordem.*`, `erro.*`.

**OTel nativo dos clientes** (reaproveitado, sem instrumentar nada):
- **Claude Code:** `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*`. Envia métricas (`claude_code.token.usage`, `cost.usage`, ...) e eventos (`api_request`, `tool_result`, `tool_decision`, ...). Traces em beta.
- **Codex:** tabela `[otel]` no `config.toml` do perfil (`otlp-http`).
- O daemon configura os dois, por perfil, para mandarem a **um receptor OTLP do próprio daemon**, com atributos de correlação (id da peça e da tentativa como atributos de recurso). Conteúdo de prompt fica redigido por padrão.

**OTel do daemon:** spans peça → etapa → tentativa → sessão → chamada de ferramenta, seguindo as convenções GenAI de agentes (`invoke_agent`, `execute_tool`; ainda em "Development", então podem mudar).

**ATIF:**
- formato definido pelo **Harbor** (dos criadores do Terminal-Bench), versão atual **ATIF-v1.8**, especificação na RFC 0001 do repositório `harbor-framework/harbor`;
- não há biblioteca TS: escrevemos o schema zod a partir da RFC e um exportador `sessao.update` → ATIF;
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
  - comandos: pausar, retomar, cancelar Ator, aprovar decisão, responder ao Produtor.
- **SSE:** `/events?cenario=&desde=` segue a tabela de eventos, com reconexão por `Last-Event-ID` (histórico, depois ao vivo).
- **WebSocket:** chat com o Orquestrador. A ponte vai para a fila única de prompts (5.4), mais as mensagens de sistema do daemon.
- **Segurança:**
  - `127.0.0.1` por padrão;
  - token obrigatório mesmo em acesso local, com CORS fechado, para que nenhuma página de outra origem comande o daemon;
  - acesso remoto só com TLS via reverse proxy;
  - tratar como acesso administrativo.

**Referências de desenho:** `acpx` (MIT, TS; cliente ACP headless com sessões persistentes e saída NDJSON) e `rivet-dev/agents` (Apache-2.0, TS; agentes de código atrás de uma API HTTP).

### 5.13 Interfaces

**Mockups de referência** (valores ilustrativos):
- `mockup/tui.html`: TUI (interface principal), gerada por `mockup/tui-render.js` (`node tui-render.js`);
- `mockup/app.html`: web/desktop (fases opcionais).

**Layout comum ao app e à TUI** (decisão de 2026-11-13):
- **Chat em altura total**, sempre visível, com **largura ajustável** (arrastar a borda no app; Ctrl+←/→ na TUI), lembrada entre sessões. Os dados da peça (título, etapa, decisão pendente) ficam no topo do chat.
- **Lateral retrátil** (Ctrl+B) com cenários, assinaturas e a entrada de **Configurações**. Recolhida, vira um trilho com os cenários e as barrinhas de cota.
- **Painel de trabalho em abas que abrem e fecham:** Visão geral, Trajetórias, Consumo, Agenda, Ordens, Configurações e Plugins. Configuração é uma aba, não uma tela que substitui o chat. O painel inteiro fecha com Ctrl+J, e o chat passa a ocupar a largura toda.
- **Tudo recolhe, menos o chat:** seções da lateral e cartões das abas abrem e fecham com um clique (Enter na TUI).
- **Estado de layout persistido por usuário:** lateral, largura do chat, abas abertas.

**Ordem das interfaces** (decisão de 2026-11-13): **a TUI vem primeiro e é a interface principal** (Fase 7). A web (Fase 12) e o app desktop (Fase 13) são posteriores e opcionais.

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

**Web (Fase 12, opcional):** React + Vite sobre o mesmo `packages/client`, com SSE para tempo real. Acrescenta à TUI o DAG desenhado, arrastar para reordenar, painéis próprios de plugins e mouse. Componentes reaproveitados:

| Uso | Componente |
|---|---|
| Chat com streaming | **assistant-ui** (MIT) com `ExternalStoreRuntime`, alimentado pelos stores do `packages/client` |
| Blocos de IA (código, trace, mensagens) | padrões de IA do **shadcn/ui** (não usar Vercel AI Elements: será descontinuado no fim de novembro de 2026 em favor do shadcn) |
| DAG de demandas | **@xyflow/react** (React Flow, MIT) |
| Trajetórias | **AgentPrism** (Evil Martians; `TraceViewer` em árvore, com adaptador OTel), só se a licença estiver na lista permitida da seção 6.0 **[a confirmar]**; senão, componente próprio sobre a árvore de spans |

**Conteúdo das telas** (o mesmo nas duas interfaces):
- **Lateral:** Assinaturas, Projetos, Tarefas, Chats, Plugins, Configuração.
- **Cenário** (projeto, tarefa ou chat genérico: o mesmo objeto, com modelo de fluxo diferente):
  - chat com o Orquestrador;
  - dashboard: etapa, DAG, Atores ativos e tempo restante, worktrees/branches, reprovações, consumo e cota por assinatura, motivos de seleção;
  - visualizador de trajetórias, ao vivo e histórico.
- **Configuração:**
  - Assinaturas: status, cota, reset, login, adicionar/remover;
  - Executores: cliente, perfil, modelo e esforço a partir das config options anunciadas;
  - Papéis: lista ordenada por prioridade + `proximo`/`esperar`;
  - Limites: `Np`, `Nc`, timeouts, semáforos;
  - escopo global com override por projeto.

**Desktop (Fase 13, opcional, depende da web):** Electron envolvendo a web, com o daemon como `utilityProcess` ou o serviço de logon da Fase 10; instalador por usuário (electron-builder).
- Tauri v2 tem guia oficial de sidecar Node e gera instalador menor, ao custo de toolchain Rust. Como o lançador de Job Object já traz Rust para o projeto, Tauri fica mais viável que na v0.1.
- Decisão na Fase 13.

### 5.14 Plugins

Plugin = **servidor MCP + manifesto** (+ painel opcional no dashboard).

```yaml
# plugin.yaml
id: banco-postgres
versao: 1.0.0
servidor:
  tipo: stdio            # ou http; o daemon agrega e expõe pelo servidor do framework
  comando: ["node", "dist/server.js"]
ferramentas:
  - nome: consultar_sql
    papeis: [ator, critico]
    especialidades: [sql]
    efeitos: leitura      # leitura | escrita_local | rede | escrita_externa
  - nome: migrar
    papeis: [ator]
    efeitos: escrita_externa
    exige_aprovacao_produtor: true
segredos: [PG_URL]       # resolvidos do cofre, injetados só no servidor do plugin
painel: dist/panel.js     # opcional
```

- O daemon lê os manifestos, monta o conjunto de ferramentas de cada papel e gera as camadas 1 e 2 de permissão automaticamente.
- Ativação por projeto.

### 5.15 Agendador (tarefas agendadas e repetidas)

O daemon dispara peças sozinho, no horário: o agendador age como se você tivesse escrito a necessidade no chat. Não há pipeline novo. A peça agendada passa pela mesma máquina de estados, seleção de Executores, permissões e eventos de qualquer outra.

**Tarefa agendada = modelo de peça**, guardado no store (tabela `schedules`, seção 7):
- cenário: projeto e branch base;
- texto da necessidade (ex.: "atualizar dependências e corrigir o que quebrar");
- overrides opcionais: executores por papel, limites, timeout;
- **política de entrega:** abrir PR por padrão. Merge direto só se o projeto permitir **e** a tarefa pedir explicitamente;
- **orçamento por execução:** teto de tempo total e, para perfis de API, de custo. Estourou, a peça para e notifica.

**Tipos de agendamento:**

| Tipo | Exemplo | Observação |
|---|---|---|
| Uma vez | 20/11 às 22h | Some da lista depois de rodar (fica no histórico) |
| Repetida por calendário | cron `0 7 * * 1-5` com fuso `America/Sao_Paulo` | Dias úteis às 7h; o fuso é sempre explícito |
| Repetida por intervalo | a cada 6 h | Conta a partir do fim da execução anterior |
| Logo após o reset da cota | "depois do próximo reset de claude-empresa" | Usa o `resetsAt` das sondas de cota (5.6) para aproveitar a janela cheia |

Biblioteca: **croner** (TypeScript, cron com fuso horário e sem dependências; licença MIT **[a confirmar]**). O próximo disparo de cada tarefa é recalculado e gravado no SQLite, então sobrevive a reinícios do daemon.

**Regras por tarefa** (com padrões globais na aba Configurações › Limites):

| Situação | Opções | Padrão |
|---|---|---|
| **Execução perdida** (máquina desligada ou daemon parado no horário) | rodar uma vez ao voltar / pular | rodar uma vez, se o atraso for menor que a janela configurada (ex.: 12 h); senão, pular e registrar |
| **Sobreposição** (a execução anterior ainda roda) | pular / enfileirar / cancelar a anterior | pular e registrar |
| **Cota** (assinaturas do papel esgotadas) | adiar até o reset / usar a regra do papel (`proximo`/`esperar`) / pular | adiar até o reset, dentro de um prazo máximo |
| **Decisão do Produtor sem ninguém olhando** | pausar e notificar / resposta padrão definida na tarefa / esperar até um prazo e cancelar | pausar e notificar |

**Notificações:** ao terminar, falhar, pausar ou pedir decisão.
- Sempre no chat do cenário e como evento (`agenda.*`).
- Notificação do sistema operacional, quando houver sessão gráfica.
- E-mail, webhook ou chat corporativo via plugin (seção 5.14).

**Máquina dormindo.** O daemon sozinho não acorda a máquina. Além disso, o Modern Standby do Windows estrangula processos em segundo plano com a tela bloqueada (problema já visto em outro projeto desta máquina, com uma fila de envio que atrasou horas). Duas medidas:
1. **Acordar no horário:** ao salvar uma tarefa, o daemon registra um gatilho no agendador do sistema operacional. O gatilho acorda a máquina e chama `ot run <tarefa>`, que entrega o disparo ao daemon (e o inicia, se preciso):
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
- **Pelo chat:** "toda segunda às 8h, revise as dependências do loja-api". O Orquestrador chama a ferramenta MCP `agendar(...)`, que **não salva direto**: devolve um rascunho que aparece no chat como decisão do Produtor (confirmar / editar / cancelar). Ferramentas `listar_agenda` e `pausar_agenda` completam o conjunto do Diretor.
- **Pelo terminal:**
  - `ot agenda list|add|pause|resume|rm`;
  - `ot run <tarefa>`, que também é o comando chamado pelo gatilho do sistema operacional.

**Repetição até uma condição** ("rodar até os testes passarem") **não** é agendamento: já é o ciclo de correção do próprio pipeline (Crítico → correção, com os limites `Nc` e de tentativas).

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
| **Cota esgotada**, reset próximo (dentro do limite configurado) e regra do papel `esperar` | Aguardar o reset e retomar **nativa** no mesmo perfil | Não |
| **Cota esgotada**, reset distante ou regra `proximo` | **Passagem de bastão** para o próximo Executor disponível do papel (5.7) | Não |
| **Erro transitório** (rede, 5xx do provedor, sobrecarga) | Retomar **nativa** com recuo exponencial (ex.: 30 s, 2 min, 10 min); se esgotar, passagem de bastão | Não |
| **Queda do processo do cliente** | Retomar **nativa**; se o `session/load` falhar, passagem de bastão | Não, na primeira vez; sim, se repetir |
| **Reinício do daemon ou da máquina** | Para cada sessão `interrompida`: nativa se os arquivos do cliente existirem; senão, passagem de bastão | Não |
| **Timeout da demanda** | Regra já existente (5.4): o Diretor avalia o parcial (vai para o Crítico ou para outro Ator); a continuação é passagem de bastão | Sim |
| **Agente travado ou em laço** | Passagem de bastão para **outro** Executor (diversidade) | Sim |
| **Recusa do modelo** ou erro de permissão | Ponto de julgamento do Diretor: reformular, trocar de Executor ou perguntar ao Produtor | Sim |

**Interrupções de causa externa** (cota, rede, queda, reinício) **não** consomem as tentativas da demanda. Só contam as falhas atribuíveis ao agente. Um limite próprio de retomadas por tentativa (ex.: 5) evita laço infinito: passou disso, o caso vai para o Diretor.

#### Checkpoints

- **Commit de checkpoint automático** na branch da tentativa:
  - a cada lote de edições, ou a cada N minutos com mudanças;
  - na interrupção, qualquer que seja a causa (não só no timeout, como na v0.8).
- Os commits de checkpoint são marcados (`wip(checkpoint): …`) e **reescritos num único commit** na integração (`INTEGRANDO_TESTE`), sem poluir o histórico.
- O daemon guarda por tentativa:
  - a referência da sessão ACP;
  - o perfil e a worktree;
  - o último checkpoint;
  - o último evento processado.

  Isso é o mínimo para decidir entre retomada nativa e passagem de bastão.

#### Efeitos colaterais e idempotência

Retomar não pode repetir o que já mudou o mundo fora da worktree:
- toda chamada de casca ou plugin com efeito (`git_commit`, `install_deps`, ferramentas de plugin marcadas `escrita_local`, `rede` ou `escrita_externa`) recebe uma **chave de idempotência** (`tentativa + passo`) e é registrada como evento antes e depois da execução;
- se a mesma chave chegar de novo após uma retomada, a casca devolve o resultado gravado em vez de executar outra vez;
- plugins com `escrita_externa` precisam declarar no manifesto se aceitam chave de idempotência. Os que não aceitam exigem confirmação do Produtor antes de serem repetidos numa retomada.

#### Máquina de estados da tentativa

```
EXECUTANDO ──(interrupção)──→ INTERROMPIDA(causa)
INTERROMPIDA → AGUARDANDO_RETOMADA (reset de cota, recuo, vaga no pool)
AGUARDANDO_RETOMADA → RETOMANDO(nativa | bastão) → EXECUTANDO
RETOMANDO(nativa) ──falhou──→ RETOMANDO(bastão)
retomadas > limite → DECIDINDO (ponto de julgamento do Diretor)
```

Tudo vira evento (`sessao.interrompida`, `sessao.retomada`, com causa, forma e Executor de origem e destino) e aparece no chat como mensagem de sistema. Exemplo: "D2 interrompida: cota de codex-1 esgotada; retomada em sonnet-medio por passagem de bastão".

### 5.17 Ordens do Produtor (globais e locais)

Conceito trazido do `okit` (ordens permanentes, `kit orders`) e redesenhado aqui. Nenhum código do kit é reaproveitado (decisão Q12 de `docs/13-DECISOES-EM-ABERTO.md`). No `okit`, a ordem tinha só um prazo final opcional (`validaAte`) e a revogação com motivo. Aqui ela ganha período de vigência, duração, janela recorrente, prorrogação, revogação programada e suspensão local de uma global.

**Ordem** é uma instrução do Produtor que vale além de uma peça. Ela continua em vigor entre peças, sessões, compressões de contexto, failover e reinícios, durante a sua vigência e até ser revogada. Exemplos:
- "mensagens de commit em português" (permanente);
- "sempre me apresente as dúvidas como múltiplas escolhas, para eu decidir" (global, `instrucao`, com `papeis` = Diretor, que é quem pergunta ao Produtor por `perguntar_produtor`; exemplo dado pelo dono em 2026-11-13);
- "fazer push sempre que commitar" (global, `regra` com a chave `git.push_apos_commit`, porque quem faz commit e push é o daemon e um texto não mudaria isso; exemplo dado pelo dono em 2026-11-13);
- "não alterar `infra/` sem perguntar" (local a um projeto);
- "não usar o perfil claude-empresa para Atores até sexta 18h" (com prazo).

#### Escopo

| Escopo | Vale para | Exemplo |
|---|---|---|
| **Global** | Todos os cenários (projetos, tarefas e chats), inclusive os criados depois | "Respostas em português do Brasil" |
| **Local** | Um cenário: um projeto, uma tarefa ou um chat | "No loja-api, toda mudança de schema vem com migration" |

- **Uma ordem global é um único registro**, não uma cópia por cenário. Cenários novos a herdam sem passo extra, e não há cópias para divergir. No `okit`, a ordem "para todos" era copiada em cada projeto, com grupo e aviso de divergência.
- **Precedência (decidida em 2026-11-13):** no mesmo cenário, a local prevalece sobre a global. O prompt mostra as duas listas separadas e diz isso explicitamente. Para `regra`, o daemon aplica a local.
- **Um cenário ou todos (decidido em 2026-11-13):** não há ordem para uma lista de cenários nem por tag. Para valer em alguns cenários, cria-se uma ordem local em cada um.
- **Suspensão local de uma global** (mantida por decisão de 2026-11-13): para que uma global não valha num cenário, o Produtor cria uma ordem local do tipo `suspensao`, que aponta para a global (ex.: "suspender O3 no loja-api até 30/11"). A global some do prompt daquele cenário enquanto a suspensão vigora. A global não é editada, e os outros cenários não mudam.
- **`papeis` (opcional):** limita a quais papéis a ordem chega (ex.: só Atores e Crítico). Sem o campo, chega a todos. Mantém o contexto mínimo (P8).

#### Tipos, sem texto mágico

| Tipo | O que é | Quem aplica |
|---|---|---|
| `instrucao` | Texto livre para os modelos | Os modelos, pelo prompt; o Crítico confere |
| `regra` | Override de uma chave de configuração que já existe, dentro do escopo e da vigência da ordem. Ex.: tirar um perfil da lista de um papel (5.7), trocar a regra `proximo`/`esperar`, exigir PR na entrega | O daemon, em código (P3) |
| `suspensao` | Tira uma ordem global de um cenário, durante a vigência da suspensão | O daemon, ao montar o prompt e ao aplicar as `regra` |

- O daemon **não interpreta o texto** de uma `instrucao`: ela nunca muda o fluxo nem a permissão. No `okit`, um texto como `critic-waiver passo-N` tinha efeito em código; aqui, o que precisa ter efeito garantido é `regra`.
- Uma `regra` só aceita chaves de uma lista fechada, validada por schema zod. **Na v1 (decidido em 2026-11-13), a lista tem quatro chaves:** os perfis da lista de um papel (tirar ou reordenar, 5.7), a regra `proximo`/`esperar` da cota, a exigência de PR na entrega e `git.push_apos_commit`. Com esta última, depois de cada `git_commit` o daemon faz push da branch da demanda. Ele nunca faz force push nem push na branch base, que só recebe pela entrega (5.5). Chaves novas entram uma a uma, cada uma com teste. **Chaves de permissão (5.8) ficam fora**: permissão se muda na configuração do papel, não por ordem.
- **Conflito de `regra`:** duas `regra` sobre a mesma chave, no mesmo escopo e com vigências que se sobrepõem, são recusadas na criação. O rascunho mostra a ordem conflitante, e o Produtor revoga uma delas ou ajusta a vigência. Entre global e local, vale a precedência.
- Quando uma `regra` muda uma decisão do daemon, o evento cita o id da ordem (ex.: `executor.selecionado` com motivo "ordem O7"). A descrição do PR lista as `regra` que afetaram a peça.
- **Dispensa do Crítico não é ordem** (decidido em 2026-11-13). No `okit`, uma ordem com o texto `critic-waiver passo-N` dispensava o crítico. Aqui, o Produtor dispensa o Crítico por uma **decisão registrada** (`decidir`, tabela `decisions`), com motivo, para a peça inteira, ao abrir a peça ou depois de uma reprovação (5.4). Nenhuma ordem, nem `regra`, dispensa o Crítico.

#### Vigência (período de validade)

Toda ordem tem uma vigência: **início** e **fim**, os dois opcionais, com fuso explícito (padrão `America/Sao_Paulo`, configurável). Sem início, vale a partir da confirmação. Sem fim, vale até ser revogada.

| Forma | Exemplo | Como é gravada |
|---|---|---|
| Permanente | "a partir de agora, commits em português" | início = confirmação; sem fim |
| Até uma data | "até sexta 18h" | fim = sexta 18:00 |
| Por uma duração | "pelas próximas 2 h", "por 3 dias" | fim = confirmação + duração |
| Período futuro | "de 20/11 a 27/11" | início e fim; fica `agendada` até o início |
| Janela recorrente (**depois da v1**, decidido em 2026-11-13) | "em dias úteis, das 9h às 18h" | expressão cron de abertura + duração da janela, com fuso (croner, 5.15), dentro do início e do fim |

- **Tudo vira data absoluta na confirmação.** O rascunho mostra o início e o fim já calculados ("vale de 13/11 14:32 a 16/11 14:32"), para o Produtor ver o que vai valer. A duração conta da confirmação, não do pedido.
- **Data sem hora:** o início vale às 00:00 e o fim às 23:59:59 do dia, ou seja, o dia inteiro conta.
- **Estados:** `agendada` → `ativa` → `expirada`; `agendada` ou `ativa` → `revogada`. `expirada` e `revogada` são finais. Uma ordem com janela fica `ativa` durante toda a vigência, mas só entra no prompt e só aplica a `regra` com a janela aberta.
- **O relógio decide, não o timer.** Se a ordem vale agora é uma função pura de (agora, início, fim, janela), calculada a cada uso: ao montar um prompt, ao aplicar uma `regra`, ao listar. O croner só dispara os eventos e avisos nas fronteiras. Com a máquina dormindo ou o daemon parado, nenhuma ordem vencida é aplicada. Ao reiniciar, o daemon emite as transições que perdeu, com o horário real da fronteira (`efetivo_em`).
- **Prorrogar e antecipar:** a vigência é o único campo que muda depois da criação, por `prorrogar_ordem` (chat, aba ou terminal), e só enquanto a ordem não é final. Cada mudança gera o evento `ordem.vigencia_alterada` com os valores antigo e novo. Texto, escopo, tipo e papéis não mudam: para mudá-los, revoga-se e cria-se outra (ver Revogação, abaixo).
- **Avisos:** no chat do cenário e na aba Ordens, 24 h antes do fim (configurável; padrão decidido em 2026-11-13), no início de uma ordem `agendada`, e quando ela expira.

#### Revogação

Revogar encerra a ordem antes do fim da vigência. Regras:
- **Só o Produtor revoga**, pelos mesmos canais da criação. O Diretor pode **sugerir** uma revogação (ex.: duas ordens em contradição), mas `revogar_ordem` só devolve um rascunho que o Produtor confirma.
- **Motivo obrigatório**, numa linha. No chat, o rascunho já vem com o motivo tirado das palavras do Produtor.
- **Imediata ou programada:** "revogar agora" vale na confirmação. "Revogar a partir de sexta" não é revogação: é antecipar o fim para sexta (prorrogar), e a ordem termina `expirada`.
- **Em lote:** por escopo ou filtro ("todas as ordens do chat X", "todas as `regra` sobre o perfil claude-empresa"). O rascunho lista cada ordem afetada, e cada uma gera o próprio evento.
- **É definitiva.** Uma ordem revogada não volta. Para reativar, cria-se uma ordem nova a partir dela; o campo `substitui` liga as duas, e o histórico mostra a cadeia.
- **Revogar uma global num só cenário** é suspensão (tipo `suspensao`), não revogação.

**Efeitos da revogação, da expiração e do início de uma ordem no meio do trabalho:**
1. **Sessões novas** já nascem com o conjunto de ordens vigente.
2. **Sessões em curso** (decidido em 2026-11-13) não são alteradas, porque o prefixo é estável (5.10). O Diretor recebe um aviso pela fila única (5.4) e decide se cancela e relança o Ator (`cancelar_ator`). O padrão é não relançar.
3. **`regra`:** passa a valer, ou deixa de valer, na próxima decisão do daemon. Ao deixar de valer, volta o valor que a configuração tem.
4. **Nada é desfeito.** O que foi feito sob a ordem fica, e o histórico mostra qual ordem estava vigente em cada peça.

#### Onde as ordens entram

1. **Orquestrador:** sempre recebe as ordens vigentes (globais e do cenário, já descontadas as suspensas). Avisos de criação, início, prorrogação, revogação e expiração entram pela fila única de prompts (5.4).
2. **Executores:** as ordens vigentes, filtradas por `papeis`, entram no prefixo estável (5.10), logo depois das regras do projeto. Cada uma traz o id e, se tiver, o fim ("O7, até 16/11 18:00").
3. **Crítico:** recebe as `instrucao` vigentes durante a tentativa como critérios adicionais. Violação é crítica negativa, como qualquer outra.
4. **Retomada e failover:** o resumo do failover (5.4) e o pacote de continuação (5.16) levam as ordens vigentes **no momento da retomada**, não as do início da sessão interrompida.
5. **Peças agendadas** (5.15) usam as ordens vigentes no horário do disparo.

#### Criação e controle

- **Só o Produtor cria.** Pelo chat ("a partir de agora, commits em português"), o Orquestrador chama `propor_ordem(...)`, que **não salva direto**: devolve um rascunho que aparece no chat como decisão do Produtor (confirmar / editar / cancelar), como o `agendar` (5.15). O rascunho mostra escopo, tipo, papéis e a vigência em datas absolutas. `prorrogar_ordem` e `revogar_ordem` seguem o mesmo caminho.
- **Executores não têm ferramenta de ordens.** Um texto lido na web ou num arquivo nunca vira ordem (injeção de prompt).
- **Aba Ordens** no painel (TUI e web): ordens vigentes, agendadas e encerradas, por escopo, com a linha do tempo da vigência; criar, prorrogar, suspender e revogar.
- **Pelo terminal:**
  - `ot ordens list [--global | --cenario <nome>] [--estado ...]` e `ot ordens show O<n>`;
  - `ot ordens add "<texto>" (--global | --cenario <nome>) [--tipo ...] [--papeis ...] [--de <data>] [--ate <data> | --por <duração>] [--janela "<cron>" --duracao <duração>]` (`--janela` depois da v1);
  - `ot ordens prorrogar O<n> (--ate <data> | --por <duração>)`;
  - `ot ordens suspend O<n> --cenario <nome> [--ate <data>]`;
  - `ot ordens revoke O<n>... --motivo "<texto>"`.

#### Registro e histórico

- ids `O<n>` sequenciais, únicos no daemon e nunca reaproveitados;
- **nada é apagado**; revogadas e expiradas ficam no histórico;
- eventos `ordem.criada`, `ordem.ativada`, `ordem.vigencia_alterada`, `ordem.prazo`, `ordem.expirada`, `ordem.revogada` e `ordem.suspensa`. A abertura e o fechamento de janelas recorrentes não geram evento, para não encher o log; o estado é calculado pelo relógio.

**Importação do `okit`** (Q12, proposta a detalhar com o importador):
- as ordens ativas de cada projeto viram ordens locais do tipo `instrucao`, com o `validaAte` como fim;
- cópias do mesmo grupo presentes em todos os projetos viram uma única ordem global;
- revogadas e expiradas entram como histórico;
- textos que tinham efeito em código no kit não são importados como texto: vão para uma lista que o Produtor decide.

## 6. Reaproveitamento: o que usar pronto

Levantamento de 2026-11-13, filtrado pela política de licenças abaixo.

### 6.0 Política de licenças

O código próprio do projeto é **MIT**. Decisão de 2026-11-13: **MIT e Apache-2.0 são igualmente aceitas**, junto com as demais licenças permissivas comuns no ecossistema.

**Lista de licenças:**

| Situação | Licenças | Onde valem |
|---|---|---|
| **Permitidas** | MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD | Em todos os níveis: código copiado, fork, dependências empacotadas |
| **Proibidas** | GPL, AGPL, LGPL, MPL (copyleft) | Em código copiado e em dependências empacotadas. Também não se lê código AGPL para reproduzir desenho, para evitar contaminação por semelhança |
| **Caso a caso** | Qualquer outra (ELv2, BSL, source-available, sem licença) | Precisa de decisão registrada nesta seção |

**Níveis de uso.** A lista acima vale para os níveis A e B. Os níveis C e D são mais flexíveis:

| Nível | O que é | Regra |
|---|---|---|
| **A. Código copiado ou fork** | Trechos trazidos para o repositório; fork de projeto | Licenças permitidas + obrigações abaixo |
| **B. Dependência empacotada** | Pacote npm/crate que vai no instalador, inclusive transitivo | Licenças permitidas |
| **C. Ferramenta externa** | Programa executado como processo separado e instalado à parte (Claude Code, Codex, git, gh, LiteLLM, Phoenix) | A licença não se propaga para o nosso código; basta permitir o uso. Proprietárias são aceitas |
| **D. Só desenvolvimento** | Compilador, testes, validadores que não vão no instalador | Licenças permitidas ou caso a caso |

**Obrigações de Apache-2.0 (níveis A e B):**
1. **Licença e cabeçalhos:** arquivos copiados mantêm o cabeçalho e continuam sob Apache-2.0. Eles não são relicenciados como MIT. O repositório fica MIT, com arquivos Apache identificados.
2. **NOTICE:** o conteúdo do arquivo `NOTICE` de cada projeto Apache usado vai para o `THIRD_PARTY_NOTICES` e para o instalador.
3. **Modificações:** arquivo Apache alterado ganha no cabeçalho a indicação de que foi modificado.
4. **Fork:** o código original do fork segue Apache-2.0 e o que escrevermos pode ser MIT. A distribuição cumpre os termos da Apache.

A Apache-2.0 traz ainda **concessão explícita de patentes** pelos contribuidores, com cláusula de retaliação contra quem processar por patente. Isso não afeta o nosso uso.

**Automação na CI:**
- verificador de licenças sobre toda a árvore de dependências empacotadas, comparando com a lista de permitidas; licença proibida ou caso a caso não registrada falha o build;
- o `THIRD_PARTY_NOTICES` é gerado automaticamente, com as licenças e os `NOTICE` dos pacotes Apache;
- um verificador de cabeçalho confere que arquivos copiados de projetos Apache mantêm o aviso.

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
1. licença do projeto e de **todas** as dependências que o fork arrasta dentro da lista permitida (qualquer copyleft reprova);
2. o núcleo roda como daemon separado da UI, com API (ou pode ser separado sem reescrever);
3. a arquitetura aceita a máquina de estados por cima sem brigar com o modelo deles;
4. qualidade de código e testes;
5. ritmo de mudanças upstream (fork que diverge cedo vira manutenção dobrada).

Padrão até a avaliação: **projeto próprio** com as dependências de 6.1 e trechos de 6.3. Se um fork passar, ele reduz a Fase 2 (runtime ACP, worktrees) e, se a web for feita, parte da Fase 12. Com a TUI como interface principal (v0.6), a interface gráfica desses candidatos pesa pouco (ver seção 10).

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
| `profiles` | id, cliente, tipo (`token_plan`/`api`), provedor, estado (`ativo`/`drenando`/`removido`), diretório, referência do segredo |
| `executors` | id, profile_id, modelo, esforço, estado de validade |
| `roles` | papel, escopo (global/projeto), lista ordenada de executores, regra de esgotamento |
| `scenarios` | id, tipo (projeto/tarefa/chat), nome, repositório, branch base, override de configuração |
| `plays` (peças) | id, scenario_id, necessidade, snapshot XState + versão da máquina, contadores, timestamps |
| `stages` | etapas executadas de cada peça (papel, tentativa, resultado) |
| `demands` | demandas do roteiro (campos de `Demanda`), estado |
| `attempts` | tentativa por demanda: executor, worktree, branch, sessão ACP, início/fim, commit WIP, resultado estruturado; contador de retomadas; último checkpoint; último evento processado |
| `sessions` | sessões ACP: processo, perfil, papel, worktree, id da sessão no cliente (para `session/load`), estado (`ativa`/`interrompida`/`aguardando_retomada`/`retomando`/`encerrada`) |
| `interruptions` | interrupção de uma sessão: causa classificada, sinais que a indicaram, forma de retomada (nativa/bastão), Executor de origem e destino, se contou como tentativa |
| `side_effects` | efeitos colaterais por chave de idempotência (`tentativa + passo`): ferramenta, parâmetros resumidos, resultado gravado, momento antes/depois |
| `prompt_queue` | fila única de prompts do Orquestrador (origem, prioridade, estado) |
| `decisions` | pontos de julgamento: tipo, entrada, resposta, quem decidiu |
| `blackboard` | chave, versão, conteúdo (plano, roteiro, contratos, decisões) |
| `events` | id crescente, timestamp, scenario/play/attempt, tipo, payload JSON |
| `quota_snapshots` | perfil, janela, uso, reset, fonte do sinal |
| `usage` | consumo por sessão/perfil/janela (tokens; custo quando for API) |
| `plugins` | manifesto, versão, estado, projetos ativos |
| `schedules` | tarefa agendada: cenário, necessidade, tipo (uma vez/cron/intervalo/após reset), expressão e fuso, overrides, política de entrega, orçamento, regras (perdida, sobreposição, cota, decisão), próximo disparo, estado, id do gatilho no sistema operacional |
| `orders` | ordem do Produtor (5.17): id `O<n>`, escopo (global/cenário), scenario_id, tipo (`instrucao`/`regra`/`suspensao`), texto, chave e valor (para `regra`), ordem suspensa (para `suspensao`), papéis, início, fim, fuso, janela (cron + duração; depois da v1), estado (`agendada`/`ativa`/`expirada`/`revogada`), criada em, origem (chat/TUI/terminal/importação), substitui, revogada em, motivo. As mudanças de vigência ficam nos eventos `ordem.vigencia_alterada` |
| `schedule_runs` | execução de uma tarefa: horário previsto e real, motivo (horário, atraso, rodar agora), peça gerada, resultado, notificações enviadas |

Acesso via **Kysely** (MIT; query builder tipado) sobre `better-sqlite3`. No Electron, o `better-sqlite3` exige rebuild do módulo nativo; `node:sqlite` do Node 24 é alternativa sem binário nativo, a avaliar na Fase 1. Migrations versionadas com o migrator do próprio Kysely.

## 8. Stack

| Área | Escolha |
|---|---|
| Runtime | Node 24 LTS |
| Linguagem | TypeScript strict |
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
| Web (opcional) | React + Vite + shadcn/ui + assistant-ui + @xyflow/react |
| Desktop (opcional) | Electron (ou Tauri v2) |
| Testes | Vitest + Playwright + `ink-testing-library` (TUI) |

**Agente simulado para testes** (`packages/fake-agent`), construído com o lado `agent()` do próprio SDK do ACP. Responde roteiros determinísticos: edita arquivo, chama ferramenta, falha, estoura tempo, pede permissão, emite sinal de cota. A máquina de estados, os pools e a UI são testados sem gastar cota.

**Testes de contrato dos adaptadores:** uma suíte curta roda contra cada adaptador real fixado (`initialize`, config options, MCP HTTP, cancelamento) e é executada a cada atualização de versão (P10).

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
│  ├─ protocol/        tipos e schemas zod compartilhados (eventos, API, saídas dos papéis, ATIF)
│  ├─ daemon/
│  │  ├─ src/api/
│  │  ├─ src/pipeline/       (máquinas XState, validação de roteiro)
│  │  ├─ src/selection/
│  │  ├─ src/accounts/       (perfis, cofre, sondas de cota)
│  │  ├─ src/executors/      (cliente ACP, pools, adapters/claude|codex|opencode|gemini)
│  │  ├─ src/mcp/            (servidor do framework, agregador de plugins)
│  │  ├─ src/tools/
│  │  ├─ src/resources/
│  │  ├─ src/workspace/
│  │  ├─ src/orders/         (ordens globais e locais, aplicação das regras)
│  │  ├─ src/scheduler/      (agenda, croner, gatilhos do sistema operacional, pedido de manter acordado)
│  │  ├─ src/store/          (schema Kysely, migrations)
│  │  ├─ src/telemetry/      (receptor OTLP, spans, exportador ATIF)
│  │  └─ src/platform/       (windows, posix)
│  ├─ fake-agent/      agente ACP simulado
│  ├─ client/          cliente da API (REST, SSE, WS) + stores de estado e preferências, sem interface
│  ├─ tui/             TUI, interface principal (Ink; ou OpenTUI, conforme a Fase 0)
│  ├─ web/             web (opcional, Fase 12)
│  ├─ desktop/         Electron ou Tauri (opcional, Fase 13)
│  └─ plugin-kit/      utilitários para escrever plugins
├─ native/
│  └─ job-launcher/    lançador Rust com Job Object (Windows)
├─ prompts/            prompts de cada papel (versionados, prefixo estável)
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
- `packages/protocol` com os primeiros schemas.
- Daemon esqueleto:
  - configuração;
  - lock de instância;
  - store SQLite + migrations;
  - log de eventos;
  - pino.
- `fake-agent` mínimo sobre o SDK do ACP.

**Critério de aceite:** o daemon sobe, grava e lê eventos, testes verdes na CI.
**Estimativa:** 1 semana.

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
- Testes de contrato dos adaptadores.

**Critério de aceite:** N Executores reais e simulados em worktrees diferentes, stream como eventos, cancelamento por timeout sem processo órfão e com WIP commitado.
**Estimativa:** 2 semanas (era 1,5 na v0.9: entram checkpoints e retomada nativa).

### Fase 3 — Pipeline, MCP do framework e blackboard

- Servidor MCP v2 com fábrica por papel e token por sessão.
- Schemas de saída + `entregar*` com revalidação.
- Máquina XState completa (seção 5.4), com persistência, contadores, escalonamento e `AGUARDANDO_PRODUTOR`.
- Validação do roteiro (ciclos, contratos, arquivos).
- DAG em ordem topológica.
- Integração antes do Crítico; entrega por PR.
- Blackboard; fila única de prompts do Orquestrador.
- Ordens globais e locais (seção 5.17), sem a janela recorrente: tabela, ferramentas do Diretor, entrada no prefixo dos Executores e no pacote de continuação, `ot ordens`.
- Prompts iniciais dos papéis.

**Critério de aceite:**
- peça ponta a ponta com o `fake-agent` cobrindo os quatro desfechos e o critério de parada;
- reinício do daemon no meio da peça, retomando do snapshot;
- uma ordem global e uma local chegam ao prompt do Orquestrador e dos Executores e sobrevivem ao reinício; uma ordem com início futuro só entra no prompt depois do início; uma ordem que vence com o daemon parado não entra em sessões abertas depois do reinício; uma suspensão tira a global de um cenário só; uma `regra` revogada devolve o valor da configuração;
- uma peça real pequena concluída com o Orquestrador em `claude-agent-acp` + Haiku.

**Marco: MVP utilizável sem UI**, conversando com o Orquestrador pelo próprio cliente apontado para o MCP do framework.
**Estimativa:** 2,5 semanas.

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

**Critério de aceite:** suíte de fuga verde nos três clientes.
**Estimativa:** 1,5 semana.

### Fase 5 — Assinaturas, cotas e seleção

- Perfis: criar, login oficial, logout, drenagem, remoção.
- Chaves no cofre.
- Sondas de cota da seção 5.6 (statusline, app-server, MiniMax, erro de limite) e histórico pelo ccusage.
- Seleção por papel com retry por diversidade e eventos de motivo.
- Admissão por RAM; failover do Orquestrador; override por projeto.
- **Retomada completa (5.16):** classificação da causa; política por causa; **passagem de bastão** com pacote de continuação; limite de retomadas por tentativa; interrupções externas fora da contagem de tentativas.
- **Idempotência de efeitos colaterais:** chaves por `tentativa + passo` nas cascas e nos plugins, tabela `side_effects`.

**Critério de aceite:** com dois perfis do mesmo cliente, esgotar um (simulado) e ver o Diretor redistribuir; remover um perfil com sessões em curso sem perder demanda; failover do Orquestrador sem perder a peça.

Também faz parte do aceite:
- um Ator interrompido por cota esgotada é retomado por passagem de bastão em outra assinatura, sem refazer commits nem instalações já feitos;
- outro Ator, com regra `esperar`, é retomado de forma nativa depois do reset.

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
- **Plugins:** ativação e permissões por papel.

**Atalhos:** mapa de teclas configurável da seção 5.13:
- padrões por sistema e ambiente (macOS, tmux, VS Code), definidos pelo teste da Fase 0;
- alternativas com Alt;
- paleta de comandos com dois atalhos (Ctrl+K e F1);
- aviso de Option-como-Meta no macOS;
- validação de conflitos ao configurar.

**Testes:** `ink-testing-library` sobre o `fake-agent`, e testes de fumaça nos terminais da Fase 0.

**Critério de aceite:** criar um projeto, adicionar uma assinatura (login oficial dentro da TUI), configurar papéis, pedir uma necessidade no chat, responder a uma decisão e acompanhar até o PR só pela TUI, no Windows Terminal e num terminal de macOS/Linux.
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
- `plugin-kit` + plugin de exemplo.
- Aba Plugins na TUI. O painel próprio de plugin fica para a web (Fase 12).

**Critério de aceite:** a ferramenta do plugin aparece só nos papéis declarados e fica bloqueada nos demais.
**Estimativa:** 1–1,5 semana.

### Fase 9b — Agendador

Depende das Fases 5 (sondas de cota e seleção) e 6 (API). Pode andar em paralelo com as Fases 7–9.

- Tabelas `schedules` e `schedule_runs`; croner com fuso; recálculo e gravação do próximo disparo.
- Tipos: uma vez, cron, intervalo, após reset da cota.
- Regras por tarefa e padrões globais: execução perdida, sobreposição, cota, decisão sem ninguém olhando; orçamento por execução.
- Gatilho do sistema operacional que acorda a máquina e chama `ot run <tarefa>`:
  - Windows: Agendador de Tarefas;
  - macOS: launchd;
  - Linux: timer do systemd.
- Pedido de manter acordada durante a execução, nas três plataformas.
- Ferramentas MCP do Diretor: `agendar` (rascunho confirmado pelo Produtor), `listar_agenda`, `pausar_agenda`.
- Comandos `ot agenda …` e `ot run`.
- Aba Agenda na TUI.
- Notificações: chat, sistema operacional, plugin.
- Testes com relógio simulado sobre o `fake-agent`.

**Critério de aceite:**
- tarefa diária dispara no horário com a tela bloqueada (Windows com Modern Standby incluído) e abre o PR;
- execução perdida com a máquina desligada roda uma vez ao voltar;
- execução sobreposta é pulada;
- com a cota esgotada, a tarefa é adiada até o reset;
- decisão do Produtor sem ninguém olhando pausa e notifica;
- tarefa criada pelo chat só é salva depois da confirmação.

**Estimativa:** 1–1,5 semana sem agentes; 0,5–1 com.

### Fase 10 — Distribuição (daemon + TUI)

- Executável único do daemon e da TUI: Node SEA, ou `bun build --compile` se a Fase 0 escolher o OpenTUI. Lançador Rust de Job Object junto, no Windows.
- Instalação por usuário:
  - Windows: instalador `.msi`/winget;
  - macOS/Linux: pacote ou script;
  - alternativa para desenvolvedores: `npm i -g`.
- Daemon como serviço de logon; o comando da TUI sobe o daemon se ele não estiver no ar.
- Atualização automática e primeira execução guiada dentro da TUI (criar a primeira assinatura, escolher os papéis padrão).

**Critério de aceite:**
- instalar e desinstalar numa máquina limpa;
- fechar a TUI sem interromper a peça;
- reabrir e reencontrar o estado e o layout.

**Estimativa:** 1 semana.

### Fase 11 — Endurecimento

- Testes de caos:
  - daemon morto no meio da peça;
  - Executor travado;
  - perfil expirado;
  - disco cheio;
  - provedor fora do ar;
  - atualização de adaptador.
- Idempotência de integração e PR.
- Revisão de segurança da API e das cascas.
- Documentação.

**Critério de aceite:** roteiro de caos sem perda de estado nem processo órfão.
**Estimativa:** 1,5–2 semanas.

### Fase 12 — Interface web (opcional, posterior)

Fica fora do caminho crítico e do total. Pode começar a qualquer momento depois da Fase 6, inclusive em paralelo com a Fase 7 se houver uma segunda pessoa.

- `packages/web` (React + Vite) sobre o **mesmo `packages/client`**: estado, API e preferências já existem; só a camada de desenho é nova.
- Layout de `mockup/app.html`:
  - chat em altura total com largura ajustável por arraste;
  - lateral retrátil;
  - painel de abas;
  - cartões recolhíveis.
- Componentes prontos: assistant-ui (chat), @xyflow/react (DAG gráfico), shadcn/ui, AgentPrism ou viewer próprio (trajetórias).
- O que a web acrescenta à TUI: DAG desenhado, arrastar para reordenar papéis, painéis próprios de plugins, mouse.
- Testes e2e com Playwright sobre o `fake-agent`.

**Critério de aceite:** o mesmo da Fase 7, feito só pela interface web.
**Estimativa:** 2–2,5 semanas sem agentes; 1–1,5 com (era 2,5–3 como interface principal: estado e cliente vêm do `packages/client`).

### Fase 13 — App desktop (opcional, depende da Fase 12)

- Decisão Electron × Tauri.
- A web numa janela nativa, com o daemon como `utilityProcess`/sidecar ou o serviço de logon da Fase 10.
- Instalador por usuário, atualização automática.

**Critério de aceite:** instalar e desinstalar numa máquina limpa; fechar a janela sem interromper a peça.
**Estimativa:** 1 semana sem agentes; 0,5–1 com.

### Resumo das estimativas

| Fase | Sem agentes | Com agentes de código* | v0.1 (sem agentes) |
|---|---|---|---|
| 0 Validações e base (teste da TUI obrigatório) | 2–3 sem | 2–3 sem | 1–1,5 |
| 1 Fundação | 1 sem | 0,5 sem | 1 |
| 2 Executores | 2 sem | 1,5 sem | 2 |
| 3 Pipeline + MCP | 2,5 sem | 1,5–2 sem | 2,5–3 |
| 4 Permissões | 1,5 sem | 1 sem | 1,5–2 |
| 5 Assinaturas, seleção e retomada | 2,5 sem | 1,5–2 sem | 2 |
| 6 API + `packages/client` | 1,5 sem | 0,5–1 sem | 1 |
| 7 TUI (interface principal) | 2,5–3 sem | 1,5 sem | — |
| 8 Observabilidade | 1 sem | 0,5 sem | 1 |
| 9 Plugins | 1–1,5 sem | 0,5–1 sem | 1,5 |
| 9b Agendador | 1–1,5 sem | 0,5–1 sem | — |
| 10 Distribuição (daemon + TUI) | 1 sem | 0,5–1 sem | 1–1,5 |
| 11 Endurecimento | 1,5–2 sem | 1–1,5 sem | 1,5–2 |
| **Total (produto na TUI)** | **≈ 21–24 semanas** | **≈ 13–17,5 semanas** | 19–24 |
| 12 Interface web (opcional) | 2–2,5 sem | 1–1,5 sem | 3–4 |
| 13 App desktop (opcional) | 1 sem | 0,5–1 sem | — |

\* Com Claude Code/Codex como apoio desde o início e, a partir da Fase 5, com o próprio framework. Supõe revisão humana de tudo o que for gerado. A Fase 0 não acelera com agentes: é medição.

**Fork, com a TUI primeiro:** os candidatos da seção 6.4 (Emdash, Orca, AionUi, Paradev, Happier) são apps gráficos. Com a TUI como interface principal, o fork perde a maior parte do valor. O que ainda se aproveita é o runtime ACP e a gestão de worktrees (Fase 2, ≈ 0,5–1 semana a menos) e, se a web for feita, parte da Fase 12. A avaliação da Fase 0 passa a olhar principalmente o núcleo deles (runtime ACP, worktrees), não a interface.

As estimativas já consideram a política de licenças da seção 6.0 (Apache-2.0 aceita, sem reimplementar o SDK do ACP nem o OpenTelemetry).

**Marcos:**
- **MVP sem UI** (Fases 0–3): ≈ 7,5–8,5 semanas sem agentes, ≈ 5,5–7 com. Conversa com o Orquestrador pelo próprio cliente apontado para o MCP do framework.
- **Uso diário com várias assinaturas** (+ Fases 4–5): ≈ 11,5–12,5 / ≈ 8,5–10,5.
- **Produto na TUI** (+ Fases 6–7): ≈ 15,5–17 / ≈ 10,5–13.
- **Produto completo na TUI** (+ Fases 8–11, com 9b): ≈ 21–24 / ≈ 13–17,5.
- **Web e desktop** (+ Fases 12–13, opcionais): + 3–3,5 / + 1,5–2,5.

**Paralelização com uma segunda pessoa:**
- depois da Fase 3, a Fase 6 (API + `packages/client`) anda em paralelo com as Fases 4–5;
- depois da Fase 6, a TUI (7) anda em paralelo com as Fases 8, 9 e 9b (agendador); a web (12) pode correr junto com a TUI, já que as duas usam o mesmo `packages/client`;
- o contrato está em `packages/protocol`, e o `fake-agent` cobre o back.

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
| R7 | Conflitos de merge frequentes | Retrabalho | `arquivosEsperados` validado antes da execução; conflito vira falha de roteiro |
| R8 | Fork que diverge do upstream | Manutenção dobrada | Critérios explícitos na Fase 0; preferir copiar trechos com atribuição a manter um fork |
| R9 | Licença proibida entrando sem perceber (dependência transitiva copyleft, componente não confirmado, fork que arrasta AGPL) ou obrigação da Apache-2.0 esquecida (NOTICE, cabeçalho, marca de modificação) | Violação de licença; bloqueio jurídico tardio | Política da seção 6.0; verificador de licenças e de cabeçalhos na CI; `THIRD_PARTY_NOTICES` gerado; alternativa própria para cada componente a confirmar |
| R10 | Custo de contexto alto | Cota esgota rápido | Blackboard, saída estruturada, prefixo estável para cache |
| R11 | Ink lento ou tremulando com streaming intenso, ou rolagem ruim em conversas longas | A TUI é a interface principal: sem ela confortável, o produto todo sofre | Teste comparativo Ink × OpenTUI na Fase 0; rolagem virtualizada; TUI isolada atrás da API, então trocar de framework não afeta o resto |
| R12 | Sem interface gráfica até a Fase 12 | Quem não usa terminal fica sem acesso; DAG e trajetórias longas são menos legíveis no terminal | Web e desktop como fases opcionais prontas para começar depois da Fase 6 sobre o `packages/client`; Phoenix como visualizador gráfico de traces no meio-tempo |
| R13 | Tarefa agendada roda sem ninguém olhando e faz algo indesejado, ou gasta a cota | Mudança não revisada, cota esgotada para o uso interativo | Entrega por PR por padrão; orçamento por execução; criação pelo chat só com confirmação; decisão sem ninguém olhando pausa por padrão; adiar quando a cota está esgotada |
| R14 | Máquina dormindo no horário (Modern Standby, tampa fechada) | Tarefa não roda ou atrasa horas | Gatilho do agendador do sistema operacional que acorda a máquina; pedido de manter acordada durante a execução; regra de execução perdida; histórico mostra atraso real |
| R15 | Retomada repete efeito colateral, ou a passagem de bastão perde contexto e o novo Executor refaz ou desfaz trabalho | Commits duplicados, chamadas externas repetidas, retrabalho | Chaves de idempotência nas cascas e plugins; checkpoints frequentes; pacote de continuação com efeitos já executados; preferir retomada nativa quando possível; teste de qualidade da passagem de bastão na Fase 0 |

## 12. Decisões em aberto

1. Fork (Emdash como principal candidato; Orca, AionUi, Paradev ou Happier) ou projeto próprio com trechos reaproveitados (Fase 0).
2. Modo de distribuição: pessoal (assinaturas) ou produto (API para Claude), depois da resposta sobre R1.
3. Tipos de cenário além de projeto: o que muda no fluxo de "tarefa" e "chat genérico".
4. Valores padrão de `Np`, `Nc`, tentativas por demanda e timeouts.
5. Política de entrega por projeto: PR sempre, ou merge direto permitido.
6. Daemon como serviço de logon ou processo do app desktop (ou os dois).
7. Electron ou Tauri (só se a Fase 13 for feita).
8. Executores padrão de cada papel na primeira execução.
9. Necessidade de acesso remoto ao dashboard (define cedo ou tarde o TLS/reverse proxy).
10. Custo em moeda para assinaturas (só o uso relativo da cota) versus API (custo real).
11. Framework da TUI: Ink (padrão) ou OpenTUI, pelo teste comparativo da Fase 0 (obrigatório).
12. Se e quando fazer a web (Fase 12) e o app desktop (Fase 13).
13. Padrões do agendador: janela para rodar execução perdida, prazo máximo de adiamento por cota, prazo de espera por decisão sem ninguém olhando, orçamento padrão por execução.
14. Padrões da retomada: limite de retomadas por tentativa, prazo máximo para esperar o reset antes de passar o bastão, intervalo dos checkpoints, critério de "agente travado" (minutos sem evento, repetições do mesmo erro).

Decididas:
- nome do produto: **OTheater** (*Orchestration Theater*); pacote `otheater`, escopo `@otheater/*`, comando `ot`/`otheater`, organização GitHub `orchestration-theater` (2026-11-13, seção 9);
- licenças permitidas: MIT, Apache-2.0, ISC, BSD-2/3-Clause e 0BSD; copyleft proibido (2026-11-13, seção 6.0);
- Arize Phoenix (ELv2) aceito só como ferramenta local opcional, nunca distribuído (2026-11-13, seção 6.2);
- ordens do Produtor (2026-11-13, seção 5.17): a local prevalece sobre a global no mesmo cenário; uma ordem vale para um cenário ou para todos, sem lista nem tag; sessões em curso não mudam e o Diretor decide relançar; `regra` com quatro chaves na v1 (perfis de um papel, `proximo`/`esperar`, exigir PR e `git.push_apos_commit`); dispensa do Crítico por decisão registrada, não por ordem, para a peça inteira, ao abrir a peça ou depois de uma reprovação (seção 5.4); janela recorrente depois da v1; aviso de prazo 24 h antes, configurável; suspensão local de uma global mantida.

## 13. Glossário

| Termo | Significado aqui |
|---|---|
| Peça | Uma execução do pipeline para uma necessidade |
| Cenário | Projeto, tarefa ou chat: tem chat, Orquestrador, dashboard e configuração |
| Executor | Cliente + perfil + modelo + esforço |
| Perfil | Uma assinatura ou chave de API de um cliente, com diretório isolado |
| Demanda | Unidade de trabalho do roteiro, executada por um Ator |
| Tentativa | Uma execução de uma demanda por um Executor, numa worktree própria |
| Ordem | Instrução do Produtor que vale além de uma peça, global ou local a um cenário, durante a sua vigência e até ser revogada (5.17) |
| Blackboard | Memória compartilhada da peça (plano, roteiro, contratos, decisões) |
| Casca | Ferramenta do framework que envolve uma ferramenta existente com política e telemetria |
| Ponto de julgamento | Decisão do Diretor tomada por modelo, com saída validada por schema |
| Config option | Opção de sessão anunciada pelo adaptador ACP (modelo, esforço, modo) |

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
| Crítico | Avaliava antes do merge | Avalia a branch **integrada** (`INTEGRANDO_TESTE`) | O documento original pede avaliar o trabalho conjunto; testes precisam do código combinado |
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
| Ordens do Produtor (v0.11) | Inexistentes | Seção 5.17: ordens globais (um registro para todos os cenários) e locais (um projeto, tarefa ou chat), dos tipos `instrucao`, `regra` e `suspensao`; vigência com início, fim, duração e janela recorrente, calculada pelo relógio; prorrogação; revogação com motivo, em lote e definitiva; criação só pelo Produtor; entrada no prefixo, no Crítico e na retomada. Estimativas das fases não revistas | Conceito do `okit` trazido para o OTheater, redesenhado para evitar cópias por projeto e texto com efeito em código; vigência por período e revogação refinadas a pedido do dono; pontos em aberto decididos pelo dono no mesmo dia, incluindo a dispensa do Crítico (5.4) |
| Cofre no Linux (v0.7) | Só Secret Service | Fallback para arquivo criptografado ou variável de ambiente do serviço | Servidores sem interface gráfica e sessões SSH não têm Secret Service |
| Teste de terminais da Fase 0 (v0.7) | Windows Terminal, VS Code e um de macOS/Linux | Inclui Terminal.app, iTerm2, GNOME Terminal/Konsole, tmux, SSH e todos os atalhos | Os padrões do mapa de teclas saem desse teste |
