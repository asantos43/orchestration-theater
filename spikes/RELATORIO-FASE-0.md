# Relatório da Fase 0

Relatório consolidado dos spikes da Fase 0 do OTheater. Ele junta o que cada README de `spikes/` e os dois ADRs registram, item por item da [§10 da arquitetura](../docs/framework-ideas/arquitetura.md). Não traz medição nova e não decide nada: as decisões em aberto continuam com o dono ([docs/13](../docs/13-DECISOES-EM-ABERTO.md)).

- **Data:** 2026-11-15 (horário de São Paulo, UTC-3).
- **Máquina de medição:** Linux, Fedora 45, kernel 7.3.3-300.fc45.x86_64, AMD Cezanne (12 threads, 30 GB de RAM, iGPU Vega, sem GPU dedicada). Tudo o que está aqui como medido foi medido nela. Windows e macOS não foram medidos.
- **Versões medidas:** `@agentclientprotocol/claude-agent-acp` 0.107.0, `@agentclientprotocol/codex-acp` 2.6.0, `opencode acp` 1.19.5, SDK ACP 2.7.0, Claude Code 2.1.325, `codex-cli` 0.166.0 e 0.169.0.
- **Critério de aceite da §10:** "cada item com resposta medida, não suposta". O veredito está na seção 7.

Marcas, copiadas do README de origem:

- **[V]** verificado localmente, por execução ou leitura nesta máquina.
- **[S]** fonte secundária (documentação ou código lido, não executado).
- **[N]** não confirmado ou hipótese.
- Os READMEs `acp-codex`, `acp-opencode` e `fork-evaluation` escrevem por extenso (verificado, secundária, não confirmado). Aqui estão convertidas para [V], [S] e [N]. O `tui-keys` usa "verificado localmente" e "não confirmado" no texto; também convertidos.
- Quando a origem não traz marca, o relatório escreve [N] e diz isso.
- **[proposta]** é a marca que os próprios spikes usam para sugestões deles. Não são decisões.

Os termos de uso dos provedores não foram tratados como fonte de permissão aqui. O que o spike `licenses` leu, com URL e data, está no README dele.

## 1. Tabela de cobertura

Estados: **Medido**, **Parcial**, **Pendente do dono**, **Não medível nesta máquina**. "Medido" quer dizer medido em Linux, salvo nota.

| # | Item da §10 | Estado | Resposta em uma frase | Spike |
|---|---|---|---|---|
| 1 | Adaptadores (Claude, Codex, OpenCode) | Medido | Os três falam ACP, criam sessão, respondem, cancelam (89 ms, 13 ms, 103 ms) e carregam sessão; em perfil vazio o Claude aceita `session/new` sem login e o Codex exige login [V]. | [acp-claude](acp-claude/README.md), [acp-codex](acp-codex/README.md), [acp-opencode](acp-opencode/README.md) |
| 2 | Concorrência: 3 sessões por adaptador (`processModel`, `K`, custo por sessão) | Medido | Claude: 1 `node` + 1 `claude` por sessão (~296 MB RSS cada, ~130 MB fixos); Codex: 1 `app-server` para N sessões (~37 MB marginais); OpenCode: 1 processo para N sessões (~50 MB ociosa, ~150 MB após um prompt) [V]. | os três acima |
| 3 | Retomada nativa: `session/load` e kill no meio da tarefa | Medido | `session/load` leva 3,7 s (Claude), 0,65 a 0,87 s (Codex) e 6,3 s (OpenCode); após `kill -9` o contexto volta, a tarefa não continua sozinha [V]. | os três acima; [acp-handoff](acp-handoff/README.md) |
| 4 | Retomada: cota esgotada simulada | Parcial | Com provedor falso e chave falsa, a sessão sobrevive e o `session/load` funciona nos 3; com assinatura real, [N] [V]. | [quota-exhaustion](quota-exhaustion/README.md) |
| 5 | Retomada: local e retenção dos arquivos de sessão | Medido | Claude 422 arquivos em 38 dias (padrão documentado 30 [S]); Codex 1004 arquivos em 71 dias; OpenCode 428 sessões em banco de ~6,6 GB [V]. | [acp-handoff](acp-handoff/README.md) |
| 6 | Retomada: passagem de bastão por outro cliente | Parcial | Retomada nativa ACP↔CLI funciona nos 3 clientes [V]; o pacote de continuação com a variante full acertou 4 de 4, com a min 2 de 4 [V], 1 execução por célula. | [acp-handoff](acp-handoff/README.md) |
| 7 | Perfis isolados (dois logins lado a lado) | Parcial | Os três isolam por variável de ambiente e `session/new` funciona em perfil vazio no Claude [V]; o segundo login não foi feito em nenhum cliente. | os três acp-* |
| 8 | Permissões pelo ACP | Parcial | Claude: `tools`/`disallowedTools`/`strictMcpConfig` removeu o Bash [V], efeito isolado de `dontAsk`/`deny` [N]; Codex: `read-only` e `workspace-write` exercitados [V]; OpenCode: `ask` gera `request_permission`, `deny` retira a ferramenta [V]. | os três acp-* |
| 9 | Sandbox do Codex (MXC) nesta máquina | Não medível nesta máquina | O MXC é o isolamento nativo do Windows 11 24H2+ (§5.8 da arquitetura), então não existe no Linux; o sandbox do Codex no Linux foi medido (`read-only` e `workspace-write`) [V]. | [acp-codex](acp-codex/README.md) |
| 10 | Cota (Claude, Codex) | Parcial | Claude: statusline `rate_limits` com `used_percentage` inteiro e `_claude/rateLimit` em fração 0 a 1 [V], só com valores em 1%; Codex: `account/rateLimits/read` em 0,41 a 0,72 s [V]. | [quota-probes](quota-probes/README.md) |
| 11 | Cota (MiniMax) | Pendente do dono | Chave falsa devolve HTTP 200 com `base_resp.status_code: 1004` [V]; o formato real não é documentado [S]; falta a chave do dono. | [quota-probes](quota-probes/README.md) |
| 12 | Sandbox Windows (`sandbox-runtime` alpha + plano B) | Não medível nesta máquina | Sem spike; `sandbox-runtime` só aparece na árvore de licenças [V]. | nenhum (ver 5.3) |
| 13 | Lançador Rust com Job Object | Não medível nesta máquina | Sem spike; nenhuma ocorrência de Rust ou Job Object nos READMEs [V]. | nenhum (ver 5.3) |
| 14 | Modelo local (Gemma 4 em llama.cpp `--jinja` via OpenCode) | Parcial | O E4B Q4_0 acertou 10 de 10 tarefas MCP/nativas; o 26B-A4B ou 31B que a arquitetura cita não foi medido [V]. | [local-model](local-model/README.md) |
| 15 | TUI: streaming | Medido | A 50 msg/s, digitação p50/p95 de 41,1/67,6 ms no Ink e 8,6/22,5 ms no OpenTUI; Ink otimizado 10,1/16,5 ms [V]. | [tui-bench](tui-bench/README.md), [tui-ink](tui-ink/README.md), [tui-opentui](tui-opentui/README.md) |
| 16 | TUI: rolagem | Medido | Histórico de 5.000 mensagens e 1.000 passos: PageUp p50 32,4 ms (Ink) contra 16,9 ms (OpenTUI); Ink otimizado 7,9 ms [V]. | os três tui acima |
| 17 | TUI: layout | Medido | Ink 25 de 25; OpenTUI 21 de 25 [V]. | os três tui acima |
| 18 | TUI: runtime e empacotamento | Medido | OpenTUI só roda no Bun (executável de 120.940.672 bytes) e traz FFmpeg estático LGPL; Ink roda no Node [V]. | [tui-opentui](tui-opentui/README.md) |
| 19 | TUI: terminais e atalhos | Pendente do dono | Só tmux em Linux foi medido (29 teclas); as colunas dos terminais reais estão vazias [V]. | [tui-keys](tui-keys/README.md) |
| 20 | TUI: mouse | Parcial | Roda, clique em aba e seção e arrasto da alça funcionam no mockup, só no tmux [V]. | [tui-mockup-ink](tui-mockup-ink/README.md) |
| 21 | OTel | Medido | Claude, Codex e OpenCode exportam OTLP/HTTP com os atributos `otheater.*`; sobrecarga de ~0,4 a 0,5 s não distinguível do ruído [V]. | [otel](otel/README.md) |
| 22 | Avaliação de base (fork sim ou não) | Medido | Projeto próprio, sem fork; nenhum candidato foi executado, a leitura do código e das árvores de licença é [V] [ADR 0001](../docs/adr/0001-projeto-proprio-sem-fork.md). | [fork-evaluation](fork-evaluation/README.md) |
| 23 | Licenças (1MCP, AgentPrism, Nimbalyst + verificador) | Parcial | 1MCP Apache-2.0, AgentPrism MIT (pacotes npm sem campo `license`), Nimbalyst MIT com árvore não medida; verificador feito, 12 testes passam [V]. | [licenses](licenses/README.md) |
| 24 | Termos (R1, confirmação com a Anthropic) | Pendente do dono | O texto público foi lido [S]; não diz se um orquestrador pessoal multi-conta cabe; nenhuma resposta da Anthropic existe [N]. | [licenses](licenses/README.md) |

Contagem: 10 Medido, 8 Parcial, 3 Pendente do dono, 3 Não medível nesta máquina (24 linhas).

## 2. Resultado por item

### 2.1 Adaptadores (item 1)

Os três adaptadores falam ACP com o cliente oficial por baixo. O cancelamento levou 89 ms (texto) e 42 ms (ferramenta `sleep 45`) no Claude, 13 ms no Codex e 103 ms no OpenCode (este medido só no Gemma) [V]. Que o cancelamento do Claude mate o filho da ferramenta é [N]. O Claude responde `authMethods: []` e `session/new` funciona sem login em perfil vazio [V]. O Codex responde `-32000 "Authentication required"` em `CODEX_HOME` vazio e oferece `api-key` e `chat-gpt` [V]. O OpenCode em perfil isolado fica só com modelos gratuitos do gateway [V]. `SIGTERM` no adaptador do Claude não mata o `claude` filho, e com `kill -9` o filho ficou órfão por ~7,3 s [V]. O catálogo do OpenCode tem 532 modelos e `family` vazio em 42 (consequência para a §5.7) [V].

### 2.2 Concorrência (item 2)

Os três clientes pedem `processModel` diferentes. Isso decide `K` e o custo por sessão.

| Cliente | Modelo de processos | Custo medido |
|---|---|---|
| Claude | 1 `node` + 1 `claude` por sessão (`process-per-session`) | Adaptador ocioso 130 MB; cada `claude` 296 a 297 MB; 3 sessões 1.018 MB (PSS 758 MB), pico 1.099 MB [V] |
| Codex | 1 adaptador, 1 `codex app-server`, N sessões | Fixo ~220 MB, marginal ~37 MB por sessão; os MCPs do dono somam ~210 MB por sessão. 3 prompts em ~10,9 s no mesmo processo contra ~4,2 s em 3 processos, causa [N] [V] |
| OpenCode | 1 `opencode acp`, N sessões | Cenário A (1 processo, 3 sessões): 252, 337, 401 MB, depois 717 MB, pico 835 MB. Cenário B (3 processos): 755 MB sem sessão, pico 1.652 MB. ~50 MB por sessão ociosa e ~150 MB após um prompt [V] |

Um crash derruba todas as sessões do processo no OpenCode. Para contas diferentes é preciso um processo por perfil. A escolha entre 1 por sessão e 1 por perfil é do dono (README do `acp-opencode`). Medido só em Linux.

### 2.3 Retomada (itens 3 a 6)

- **`session/load`:** 3,7 s no Claude, 0,65 a 0,87 s no Codex (os config options voltam ao padrão `agent`, `gpt-6.1-sol`, `high`) e 6,3 s no OpenCode (funciona com outro `cwd`) [V].
- **Kill no meio da tarefa:** no Claude, o replay traz só a mensagem do usuário, mas o contexto estava completo (respondeu "400"). No Codex não há sobreviventes e a tarefa não é retomada sozinha. No OpenCode o texto parcial não é persistido [V].
- **Retomada nativa ACP↔CLI** nos três clientes, com o mesmo id e o contexto voltando nos dois sentidos: Claude 11,2 s e 3,6 s; Codex 6,0 s e 1,6 s; OpenCode 31,2 s e 8,3 s [V].
- **Retenção:** Claude `cleanupPeriodDays` padrão 30 [S], observado 38 dias com 422 arquivos, causa [N]. Codex 1.004 arquivos em 71 dias, sem retenção documentada. OpenCode 428 sessões, banco de ~6,6 GB [V].
- **Pacote de continuação (bastão):** 1 execução por célula (2 no par B). Variante full: 4 de 4. Variante min: 2 de 4, as duas falhas no destino OpenCode/flash-lite. Claude→Codex ok (26,2 s e 25,4 s); Codex→OpenCode com min falhou nas duas e com full ok (179,6 s e 58,6 s); OpenCode→Claude ok. A full custa +34% a +37% de bytes sobre a min. Causa da falha (pacote ou modelo fraco): [N]. O formato do pacote é [proposta] [V].
- **Cota esgotada simulada** (mock local, chave falsa, sem assinatura real): a sessão continua viva e aceita novo prompt nos 3; o `session/load` em processo novo funciona (Claude 0,8 a 2,0 s; Codex 0,09 a 0,56 s; OpenCode 0,57 a 1,7 s). O texto parcial se repete (até 11 vezes no Claude), e o Claude grava "API Error:" como mensagem do agente. Sem a extensão tipada, Claude e OpenCode erram com JSON-RPC -32603, sem `stopReason`; o Codex dá `end_turn` sem erro, salvo no usage limit. Tempo até desistir: Claude ~3 min (11 requisições, ignora `retry-after`); Codex de 0,3 s (usage limit) a 11 s; OpenCode 70 a 75 s, e com `retry-after: 3600` espera sem limite (mais de 300 s). A extensão `_meta.jetbrains.air.sessionFailure` existe no Claude e no Codex [V]; no OpenCode não existe [S] [V].

Estas respostas alimentam a §5.7 e a N42 do docs/13. As consequências para o failover são [proposta] no README de origem.

### 2.4 Perfis isolados (item 7)

Variáveis de isolamento: `CLAUDE_CONFIG_DIR`, `CODEX_HOME` com `cli_auth_credentials_store="file"`, `XDG_*` e `OPENCODE_DB` [V]. Sem restrição de configuração, o perfil do dono (plugins e conectores claude.ai) vaza para a sessão do Claude [V]. O perfil isolado do OpenCode só vale em Linux [V]. O segundo login não foi medido em nenhum cliente; o `acp-claude` e o `acp-codex` listam o login real como pendente. A confiança da pasta com `CLAUDE_CONFIG_DIR` também está pendente (`quota-probes`).

### 2.5 Permissões (itens 8 e 9)

- **Claude:** `_meta.claudeCode.options` com `tools`, `disallowedTools`, `strictMcpConfig` e `settings` removeu o Bash [V]. O efeito isolado de `dontAsk`, `deny` e `tools` contra `disallowedTools` é [N]. O `permissionMode` continua `auto` (controlado pelo ACP).
- **Codex:** `read-only` recusa a escrita. `workspace-write` deixa `/tmp` gravável sem `request_permission`; fora de `/tmp` bloqueia e gera `request_permission` (allow executa fora do sandbox, reject cancela). Só esses dois modos foram exercitados; `agent` e `agent-full-access` não [V].
- **OpenCode:** o padrão sem config permite tudo. `OPENCODE_PERMISSION` com `ask` gera `request_permission` (3 opções). `opencode.json` com `deny` retira a ferramenta (1 execução) [V].
- **MXC:** é do Windows 11 24H2+ (§5.8 da arquitetura) e nenhum README o menciona. O sandbox do Codex foi medido só no Linux.

### 2.6 Cota (itens 10 e 11)

- **Claude:** `--settings` aplica a `statusLine` e vence a do usuário [V]. `rate_limits.five_hour` e `seven_day` trazem `used_percentage` (inteiro) e `resets_at`. A statusline é dirigida por evento; `rate_limits` aparece 2,2 a 2,5 s após abrir o `claude`, sem prompt (origem [N]). `usage_update._meta["_claude/rateLimit"]` traz `utilization` como fração de 0 a 1 com 2 casas [V], mas só com dois pontos em 1% (sem ponto alto).
- **Codex:** o adaptador não repassa a cota estruturada. A leitura direta de `account/rateLimits/read` devolve `usedPercent` inteiro, `windowDurationMins` 300 e 10080, sem tokens, em 0,41 a 0,72 s (751 ms numa leitura do `acp-codex`) [V].
- **OpenCode:** o `usage` com `outputTokens` = 3 é [N].
- **MiniMax:** pendente do dono. O script está pronto em `quota-probes/src/q4-minimax-remains.ts`.
- **Pendências do spike:** o arranque do cliente conta cota?; unidade com valor alto; `ConPTY` no Windows; `account/rateLimits/updated` em turno real.

### 2.7 Sandbox Windows e lançador Rust (itens 12 e 13)

Sem spike. Onde procurei está na seção 5.3.

### 2.8 Modelo local (item 14)

O `--jinja` funcionou de primeira com o Gemma 4 E4B Q4_0; o raciocínio vem ligado e gasta o orçamento antes da chamada, então o llama-server rodou com `--reasoning off` [V].

| Cenário | Resultado |
|---|---|
| llama-server do Fedora (CPU sem AVX), prompt enxuto (~1,9 mil tokens) | 10 de 10, 20 chamadas MCP válidas; ~3 tok/s no prompt e ~2,2 na geração [V] |
| `google/gemini-3.1-flash-lite`, mesmas tarefas | 10 de 10, 20 chamadas MCP válidas [V] |
| llama-server, prompt cheio do OpenCode (14 ferramentas, ~12 mil tokens) | interrompido a pedido do dono com 52% processado; primeiro token estimado em 85 a 100 min [N] |
| Ollama v0.40.16 com iGPU por Vulkan, enxuta | 10 de 10 em 11 min 40 s [V] |
| Ollama, cheia (11.633 tokens em 75,6 s, 154 tok/s) | 10 de 10 em 20 min 28 s; geração mediana 9,6 tok/s [V] |

RSS do servidor ~5,48 GB com `-c 32768 -np 1` [V]. Uma execução por configuração e 10 tarefas curtas: não mostra taxa de erro. A arquitetura cita o Gemma 26B-A4B ou 31B; o spike mediu o E4B. O Ollama virou ferramenta de desenvolvimento e testes (`./ollama.sh`, `OLLAMA_IGPU_ENABLE=1`), e o `serve.sh` ficou obsoleto. A licença Apache-2.0 do modelo vem do cartão no Hugging Face [S]; o texto completo não foi lido.

### 2.9 TUI (itens 15 a 20)

Bancada tmux 3.8 sem tela gráfica, 160x45, uma execução por célula [V].

Stream de 50 msg/s por 300 s:

| Medida | Ink | OpenTUI |
|---|---|---|
| Digitação p50/p95/máx (ms) | 41,1/67,6/78,5 | 8,6/22,5/28,9 |
| CPU média/p95 (%) | 27,9/30,9 | 48,8/64,7 |
| RSS (MB) | 157,0 a 292,8, estável | 102,5 a 313,5, +31 MB/min, 352,9 aos 600 s, sem platô |

- **Stream de 20 msg/s:** digitação p50 de 46,7 ms (Ink) contra 3,1 ms (OpenTUI).
- **Histórico (5.000 mensagens e 1.000 passos):** abertura até tela estável em 651 ms (Ink) contra 1.234 ms (OpenTUI). PageUp p50 de 32,4 contra 16,9 ms. Teclas perdidas: Ink 1 em 200 no chat; OpenTUI 8 em 200 no painel.
- **Layout:** Ink 25 de 25; OpenTUI 21 de 25 (o chat transborda com o painel fechado; causa [N]).
- **Runtime:** OpenTUI só roda no Bun (no Node 24: `native FFI is not available`; Node 26.4 ou mais é [N]). Executável de 120.940.672 bytes (Bun sozinho 92.752.752).
- **Licença:** os binários nativos do OpenTUI são `MIT AND LGPL-2.1-or-later` (FFmpeg estático); a §6.0 e o P11 proíbem LGPL. A decisão final do dono foi o Ink (ADR 0002).
- **Ink otimizado (2026-11-15):** digitação p50/p95/máx 10,1/16,5/26,6 ms (a base da rodada 48,2/70,8/78,1), CPU 23,6%, RSS mediana 142,3 MB, histórico PageUp 7,9/14,8 ms. Piso da bancada ~2 ms. Inclui um patch do `output.js` do Ink 8.0.0, travado na versão. A adoção do patch, fork ou contribuição ao Ink é do dono. Borda quebrada: 1 em 29 sem `--incremental`, 0 em 58 com (hipótese de captura no meio do quadro [N]).
- **Mouse e mockup:** as 4 telas (`main`, `traj`, `config`, `focus`) saem idênticas ao mockup, 5880 de 5880 células cada, em `renderToString` e no tmux real. Roda, clique em aba e seção e arrasto da alça funcionam, com `--mouse full|wheel|off`. O mouse exigiu caminho próprio no stdin (`filter` ou `tap`); o `tap` vaza sequência cortada e o `filter` também, exceto no `ESC` isolado. Ctrl+J chega como `\n`; F-keys não chegam ao `useInput`; `@inkjs/ui` não foi usado; 80x24 fica apertado. Sem medição de desempenho do mockup [V].
- **Teclas (tmux Linux, 29 teclas):** Ctrl+J chega como `0a`, diferente do Enter `0d`. Ctrl+B não chega dentro do tmux com o prefixo padrão (modo aninhado). Alt+B chega (`1b 62`). Ctrl+Shift+←/→ chegam como `ESC[1;6D/C`. Ctrl+Shift+P chega como `10`, dado fraco: o byte foi gerado pelo tmux. O terminal sob o tmux não responde ao protocolo kitty. `send-keys` não passa por terminal real [V].
- **Limites declarados:** só tmux; os geradores dos dois protótipos não são idênticos; vazamento contra retenção do OpenTUI [N]; sem terminal gráfico, SSH, macOS, Windows, IME; faltam as 3 repetições mínimas.

### 2.10 OTel (item 21)

- **Claude Code:** `http/json` e `http/protobuf` funcionam; métricas, eventos e traces chegam. O recurso traz os 3 atributos `otheater.*` em 100% dos registros (63/63, 62/62, 68/68). Por sessão ACP, `_meta.claudeCode.options.env` troca a correlação e o endpoint no mesmo adaptador [V].
- **Codex:** `codex exec -c otel.*` exporta logs, traces e métricas; `OTEL_RESOURCE_ATTRIBUTES` funciona nos 3 sinais (1348/1348), embora a documentação não o cite. No `codex-acp`, `CODEX_CONFIG` com `otel` não exportou (causa [N]); um wrapper em `CODEX_PATH` funcionou, mas não dá correlação por sessão: o `app-server` atende todas as sessões do adaptador, e o daemon precisaria de um adaptador por run (ou correlacionar por `conversation.id`) [V].
- **OpenCode:** `OTEL_EXPORTER_OTLP_ENDPOINT` basta; logs e traces chegam (sem métricas), com `otheater.*` em 376 de 376 registros. Não apareceu span de chamada ao modelo, token ou custo [V].
- **Vazamento padrão:** Claude e Codex trazem `user.email`, `user.id` e `organization.id` ou `user.account_id` sempre. O `codex.tool_result` exporta `arguments` e `output` em claro por padrão [V]. O daemon precisa redigir no receptor.
- **Sobrecarga:** Claude 9,33 s sem e 9,79 s com (+0,47 s); Codex 3,56 s sem e 3,98 s com (+0,42 s); não distinguível do ruído (até 1,5 s entre repetições) [V]. Runs longos e via ACP não foram medidos.

### 2.11 Avaliação de base (item 22)

[ADR 0001](../docs/adr/0001-projeto-proprio-sem-fork.md): projeto próprio, sem fork. Nenhum candidato entrega o daemon único por usuário com API, e nenhum usa XState [V]. O único bloqueio de licença objetivo é o LGPL-3.0 do libvips do `sharp` (Happier, AionUi, Paradev) [V]. Os números de commits vêm da API do GitHub, em 2026-11-14 [S]. Nenhum candidato foi executado. Faltam o AionCore, o texto da licença "Custom" do `@anthropic-ai/claude-agent-sdk` [N] e a árvore completa do Happier. O Claudexor (MIT, 196 pacotes sem licença proibida, 1.117 arquivos de teste que não foram rodados) entrou em 2026-11-15 como referência, sem fork, e conflita com a §3 por ler token OAuth [V].

### 2.12 Licenças (item 23)

- **1MCP** Apache-2.0 (199 pacotes de produção, todos permitidos); **AgentPrism** MIT no repositório, mas os pacotes npm `agent-prism-data` e `agent-prism-types` 1.0.0 não têm campo `license`; **Nimbalyst** MIT, com árvore **não medida** [V].
- **Verificador** `check.mjs` com `policy.json` vazio de propósito: 12 testes sintéticos passam [V].
- **Árvores da stack:** núcleo 192 de 192 permitidas; fases posteriores 138 de 138; executores (só lockfile) 154, com 22 sem decisão e 0 proibidas [V].
- **Árvores dos spikes:** 2 proibidas, `@opentui/core-linux-x64` e `-musl` (`MIT AND LGPL-2.1-or-later`); 10 sem decisão nas árvores com `claude-agent-acp`; 1 alerta de arquivo LGPL em `@openai/codex@0.166.0-linux-x64` [V].
- **`@anthropic-ai/claude-agent-sdk`:** "todos os direitos reservados". O texto não concede nem proíbe a redistribuição dentro de um SEA: ambíguo [N] (D1 do spike).
- **Termos da OpenAI não foram lidos:** as páginas devolveram HTTP 403 ao `curl` em 2026-11-15 [N].
- **Termos da Anthropic:** lidos como texto de página [S]. O spike não interpreta além do texto (ver D2).

### 2.13 Termos e R1 (item 24)

O README `licenses` registra o que as páginas públicas da Anthropic dizem (consulta em 2026-11-15, [S]): OAuth é para compradores dos planos; quem constrói produto deve usar chave de API; terceiros não oferecem login claude.ai nem roteiam requisições pelas credenciais de planos. O texto não diz se um orquestrador pessoal e multi-conta com o binário não modificado cabe nisso. A confirmação por escrito com a Anthropic não existe [N]. É a D2 do spike e a pergunta "Termos" da §10.

## 3. ADRs produzidos

| ADR | Estado | Decisão em uma linha |
|---|---|---|
| [0001, projeto próprio sem fork](../docs/adr/0001-projeto-proprio-sem-fork.md) | aceita em 2026-11-14 (N1), atualizada em 2026-11-15 (N41) | Sem fork; reaproveitar trechos de licença permitida (Emdash, acpx) e usar o Claudexor como referência, sem código que leia token OAuth. |
| [0002, framework da TUI](../docs/adr/0002-framework-da-tui-ink.md) | aceita em 2026-11-15 (N11) | Ink, porque passa em streaming, rolagem e layout, e o OpenTUI reprovou por LGPL, runtime só em Bun, layout 21 de 25 e memória e CPU crescentes. |

## 4. Pendências

### 4.1 Do dono

| Pendência | Origem |
|---|---|
| Tabela de terminais e atalhos: Windows Terminal, VS Code, Terminal.app (com e sem Option como Meta), iTerm2, GNOME Terminal/Konsole, SSH | [tui-keys](tui-keys/README.md) |
| Chave da MiniMax para rodar `q4-minimax-remains.ts` | [quota-probes](quota-probes/README.md) |
| Contato com a Anthropic sobre o R1 (orquestrador pessoal multi-conta; redistribuição do SDK dentro do executável) | [licenses](licenses/README.md), D1 e D2 |
| Termos da OpenAI: ler ele mesmo, ou autorizar outro meio de leitura (o `curl` deu 403) | [licenses](licenses/README.md), D3 |
| Segundo login de cada cliente (precisa de uma segunda conta) | os três acp-* |
| Assinatura ou OAuth real para esgotar cota, `resetsAt` e failover entre contas | [quota-exhaustion](quota-exhaustion/README.md) |
| Decisões já listadas como do dono nos READMEs: `processModel` do OpenCode (1 por sessão ou por perfil); patch, fork ou contribuição ao Ink; D4 a D10 do `licenses` (pacotes `opencode-<plataforma>` sem licença, LGPL no Codex, licenças "caso a caso", AgentPrism, `OR`/`AND` em SPDX, GPL em ferramenta externa) | READMEs de origem |

### 4.2 Exigem Windows ou macOS

- Sandbox Windows (`sandbox-runtime` alpha e plano B), o lançador Rust com Job Object e o MXC do Codex: nenhum spike.
- `ConPTY` no Windows (`quota-probes`).
- Windows Terminal, Terminal.app e iTerm2 (`tui-keys`); IME, SSH e terminais gráficos (`tui-ink`, `tui-opentui`).
- Todo o resto dos spikes foi feito em Linux. Os READMEs `acp-*` listam o Windows como pendência.

### 4.3 Abertas por falta de medição

- **Repetição estatística:** o bastão (1 execução por célula), as 10 tarefas do modelo local (1 por configuração) e a TUI (menos de 3 repetições) têm n muito pequeno.
- **Destino fraco e `cwd` diferente no bastão; cota real combinada; efeitos externos** (`acp-handoff`).
- **Unidade de `utilization` com valor alto:** só foi medida em 1% (`quota-probes`).
- **Sobrecarga do OTel** em runs longos e via ACP; causa de `CODEX_CONFIG` com `otel` não exportar; threads extras de `conversation.id`; span de modelo no OpenCode (`otel`).
- **RAM do Claude com `strictMcpConfig`**; efeito isolado de `dontAsk`/`deny`/`tools` (`acp-claude`); modos `agent` e `agent-full-access` do Codex (`acp-codex`); `OPENCODE_CONFIG_CONTENT` (`acp-opencode`).
- **Modelo local:** 26B-A4B e 31B que a arquitetura cita, outras quantizações, mais de um slot, raciocínio ligado contra desligado, `opencode run`, cancelamento com prompt longo (`local-model`).
- **Árvore de dependências do Nimbalyst, `xclip`, texto da MPL-2.0, `THIRD_PARTY_NOTICES`** (`licenses`).
- **Candidatos a fork não executados**, AionCore e árvore completa do Happier (ADR 0001).
- **Mouse e mockup:** sem medição de desempenho e sem outros terminais (`tui-mockup-ink`).

## 5. Itens da §10 sem spike e onde procurei

### 5.1 Itens sem spike

Três itens da §10 não têm spike, todos do Windows: **sandbox Windows**, **lançador Rust com Job Object** e o **MXC do Codex** (Windows 11 24H2+).

### 5.2 Comandos

Busca, sem distinguir maiúsculas, sobre `spikes/*/README.md`, `spikes/*/*.md` e `docs/adr/*.md`:

- `grep -rniE "job object|lançador|launcher|sandbox-runtime|MXC|bwrap|AppContainer|seatbelt|3 sess|três sess|concorr"`
- `grep -rniE "rust|sandbox windows|windows sandbox|baixo privil|sandbox do codex|sandbox_mode|workspace-write"`

### 5.3 Resultado

- **Sandbox Windows:** `sandbox-runtime` só aparece em `licenses/README.md`, como árvore de licenças (`node-forge (BSD-3-Clause OR GPL-2.0)` via `@anthropic-ai/sandbox-runtime`). Nenhum piloto e nenhum plano B com usuário de baixo privilégio.
- **Lançador Rust com Job Object:** nenhuma ocorrência de Rust ou Job Object. Em `local-model`, a palavra "lançador" aparece só na ideia de um perfil `local` que corta o prompt do OpenCode (~12 mil tokens contra ~1,9 mil), o que não tem relação com Job Object.
- **MXC do Codex:** nenhuma ocorrência nos spikes. Na arquitetura (§5.8), no `docs/08` e no `docs/09`, o MXC aparece só como isolamento do Windows 11 24H2+. O sandbox do Codex foi medido só no Linux (`acp-codex`, `read-only` e `workspace-write`).
- **Concorrência de 3 sessões:** tem spike nos três `acp-*`, só em Linux.

## 6. Ajustes na arquitetura já provocados pelos spikes

Só entram as mudanças que alguma fonte já registra. A coluna "Onde está escrito" diz a fonte. Não há proposta nova aqui.

| Ajuste | Onde está escrito |
|---|---|
| O verificador de licenças da Fase 1 precisa ler árvores pnpm e reprovar quando não achar nenhum pacote (com pnpm em workspaces o spike aprovava 0 pacotes em silêncio) | ADR 0001, "Consequência para a Fase 1" |
| Claudexor como referência (tag `v6.1.2`, commit `7a87c337…`), à frente do Emdash em cota, pool de contas, rotação, perfis isolados, store, API do daemon e orçamento; sem código que leia token OAuth; nenhum pacote `@claudexor/*` | ADR 0001, "Atualização" (N41); §6.3 da arquitetura |
| Projeto próprio sem fork, reaproveitando Emdash (Apache-2.0) e acpx (MIT) | ADR 0001 (N1); §6.4 e §12 item 1 |
| TUI em Ink; código próprio a escrever: moldura com título, campo de entrada, rolagem virtualizada, quebra por largura, camada de mouse | ADR 0002 (N11) |
| Atalhos do layout por Alt+letra no lugar de Ctrl+B; latência do Ink em p50 de 10 a 11 ms com `flush`, memo, semi-space e patch do `output.js`; mouse na Fase 7 com a chave `ui.mouse` | ADR 0002, atualizações N35, N37 e N34 |
| O ACP não devolve estruturado o horário de volta da cota nos três clientes (quota-exhaustion) | docs/13, N42 ("O que o ACP não resolve") |
| §6.1 dizia MIT para o MCP SDK v2, mas é Apache-2.0 | `licenses/README.md`, D8; aplicado na arquitetura v0.40 (2026-11-15) |
| Ollama como ferramenta de modelo local para desenvolvimento e testes; `serve.sh` obsoleto | `local-model/README.md` |
| OpenTUI fora do produto por LGPL | `licenses/README.md`, seção 6.2; ADR 0002 |

Outras entradas do docs/13 ligadas à Fase 0, todas Decididas: N33 (código dos spikes em `spikes/`), N36 (copiar com o mouse), N43 (integração de terminal estilo Claude Desktop) e N44 (comandos `/` e sessão direta).

## 7. Veredito do critério de aceite

Critério da §10: "cada item com resposta medida, não suposta".

**O critério não está cumprido.** 10 de 24 itens têm resposta medida em Linux. Os outros 14 não têm.

Sem resposta medida, por grupo:

- **Parcial (8):** cota esgotada com assinatura real (4), bastão com n muito pequeno (6), segundo login (7), permissões sem o efeito isolado de cada chave (8), cota em valor alto (10), modelo local sem o 26B-A4B ou 31B (14), mouse fora do tmux (20), licenças sem a árvore do Nimbalyst nem os termos da OpenAI (23).
- **Pendente do dono (3):** MiniMax (11), terminais e atalhos reais (19), R1 com a Anthropic (24).
- **Não medível nesta máquina (3):** MXC do Codex (9), sandbox Windows (12) e lançador Rust com Job Object (13).

Dois pontos de leitura que não mudam a contagem:

- **Medido não quer dizer fechado.** Vários itens "Medido" têm uma execução por célula (TUI, bastão, modelo local) e marcam n pequeno no README. O item 2 está medido, mas o `processModel` do OpenCode continua do dono.
- **O texto da §10 pede "Shift+Enter distinguível do Enter".** O mapa do `tui-keys` não tem uma linha de Shift+Enter, então esse ponto não foi medido. O README do `tui-keys` ainda testa Ctrl+B, e o ADR 0002 registra que a N35 trocou os atalhos do layout por Alt+letra.

Estimativa da §10: 2 a 3 semanas. Os READMEs não medem o esforço real; nada aqui confirma ou contradiz o prazo.
