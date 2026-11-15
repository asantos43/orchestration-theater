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
| 6 | Retomada: passagem de bastão por outro cliente | Parcial | Retomada nativa ACP↔CLI funciona nos 3 clientes, também com `cwd` diferente, salvo o CLI do OpenCode, que trava [V]; nas 6 direções, o pacote full acertou 20 de 21 e o min 15 de 21, com 2 a 3 execuções por célula [V]. | [acp-handoff](acp-handoff/README.md) |
| 7 | Perfis isolados (dois logins lado a lado) | Parcial | Os três isolam por variável de ambiente e `session/new` funciona em perfil vazio no Claude [V]; o segundo login não foi feito em nenhum cliente. | os três acp-* |
| 8 | Permissões pelo ACP | Medido | Claude: `tools`, `disallowedTools` e `deny` removem o Bash cada um sozinho, mas `deny` por padrão é furado por `sh -c`, `bash -c`, `find -exec`, `eval`, `$(...)` e `python3 -c` (`sh -c` e `bash -c` fecham com o cliente em `reject`) [V]; Codex: `agent-full-access` não sai do catálogo, nem com `requirements.toml` no `$CODEX_HOME`, e o modo `agent` aprova a escalada sozinho, inclusive rede e `rm -rf`, sem `request_permission` [V]; OpenCode: não há bypass pelo ACP, `OPENCODE_PERMISSION` vence o `opencode.json` do cwd, o padrão é `allow` também sem a config global, e as regras por padrão de comando funcionam [V]. Tudo com n de 1 a 3. | os três acp-* |
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
| 19 | TUI: terminais e atalhos | Pendente do dono | Só tmux em Linux foi medido (41 teclas do mapa da N35, 4 variantes, com Shift+Enter); as colunas dos terminais reais estão vazias [V]. | [tui-keys](tui-keys/README.md) |
| 20 | TUI: mouse | Parcial | Roda, clique em aba e seção e arrasto da alça funcionam no mockup, só no tmux [V]. | [tui-mockup-ink](tui-mockup-ink/README.md) |
| 21 | OTel | Medido | Claude, Codex e OpenCode exportam OTLP/HTTP com os atributos `otheater.*`; sobrecarga de ~0,4 a 0,5 s não distinguível do ruído [V]. Na 2ª rodada: o `otel` do Codex só liga na partida do `app-server`, 1 thread de título extra por sessão, e o OpenCode só dá tokens com `experimental.openTelemetry`, que vaza conteúdo [V]. | [otel](otel/README.md) |
| 22 | Avaliação de base (fork sim ou não) | Medido | Projeto próprio, sem fork; nenhum candidato foi executado, a leitura do código e das árvores de licença é [V] [ADR 0001](../docs/adr/0001-projeto-proprio-sem-fork.md). | [fork-evaluation](fork-evaluation/README.md) |
| 23 | Licenças (1MCP, AgentPrism, Nimbalyst + verificador) | Parcial | 1MCP Apache-2.0, AgentPrism MIT (pacotes npm sem campo `license`, aceitos por exceção na N45), Nimbalyst MIT na raiz, árvore medida pelo `pnpm-lock.yaml` (1252 pacotes de produção, 15 LGPL e 14 sem decisão, verificador reprova; licença do registro [S]); verificador com as decisões da N45 e o nível C, 16 testes passam, mais 4 do adaptador pnpm [V]. Falta: termos da OpenAI (403). | [licenses](licenses/README.md) |
| 24 | Termos (R1, confirmação com a Anthropic) | Pendente do dono | O texto público foi lido [S]; não diz se um orquestrador pessoal multi-conta cabe; nenhuma resposta da Anthropic existe [N]. | [licenses](licenses/README.md) |

Contagem: 11 Medido, 7 Parcial, 3 Pendente do dono, 3 Não medível nesta máquina (24 linhas).

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
- **Pacote de continuação (bastão), rodada 1:** 1 execução por célula (2 no par B). Variante full: 4 de 4. Variante min: 2 de 4, as duas falhas no destino OpenCode/flash-lite. A full custa +34% a +37% de bytes sobre a min. O formato do pacote é [proposta] [V].
- **Bastão, rodada 2** (`acp-handoff`, 2026-11-15): repetições, os 3 sentidos que faltavam, uma segunda origem por par e um modelo mais forte no destino OpenCode. De 2 a 3 execuções por célula, o que continua não sendo estatística [V]:
  - Somando as duas rodadas (21 execuções por variante, sem o modelo mais forte): **full 20 de 21, min 15 de 21**. A leitura "full 4/4, min 2/4" da rodada 1 não se sustenta; a direção ainda é "full >= min", com diferença menor.
  - Por destino: Claude min 7/7 e full 7/7; **Codex min 3/7 e full 7/7** (Fisher ≈ 0,07, execuções não independentes [N]); OpenCode/flash-lite min 5/7 e full 6/7. Duas das falhas do Codex com min foram recusa "workspace outside the writable roots" com pacote igual ao de execuções que funcionaram, o que parece estocástico [N].
  - As 3 falhas do OpenCode/flash-lite são todas do mesmo par e origem (Codex→OpenCode, origem 1). Nas outras 8 com destino OpenCode, 0 falhas. Parte do "destino fraco" pode ser da origem difícil [N].
  - Com `google/gemini-3.5-flash` no destino OpenCode, na mesma origem: 3 de 3 válidas corretas, com exatamente as 4 escritas que faltavam; com o flash-lite, 3 de 6 falharam. Compatível com "o modelo pesa mais que o pacote", com n=3 [N]. Duas execuções foram excluídas pela cota diária do tier grátis do Google (20 requisições por dia).
  - Tempo: Claude e Codex como destino ficam em 16 a 28 s; o OpenCode varia de 16 a 233 s com o mesmo pacote.
  - Todas as 6 direções entre os 3 clientes já têm ao menos uma execução correta com o full.
  - O detector de interrupção por tipo `edit` não vê escritas por shell do Codex (heredoc); o README sugere medir o progresso pelo diff no produto [proposta].
- **Retomada nativa com `cwd` diferente** (rodada 2, 1 execução por célula) [V]: Claude e Codex retomam nos dois sentidos (CLI e `session/load`) numa worktree irmã e numa pasta fora do git, o que corrige a dedução da rodada 1. No OpenCode o `session/load` funciona (~5 s), mas `opencode run -s <id> --dir <outro>` trava em 4 de 4 tentativas (com o mesmo cwd termina em 18 s); causa [N]. O README indica o `session/load` pelo ACP.
- **Cota esgotada simulada** (mock local, chave falsa, sem assinatura real): a sessão continua viva e aceita novo prompt nos 3; o `session/load` em processo novo funciona (Claude 0,8 a 2,0 s; Codex 0,09 a 0,56 s; OpenCode 0,57 a 1,7 s). O texto parcial se repete (até 11 vezes no Claude), e o Claude grava "API Error:" como mensagem do agente. Sem a extensão tipada, Claude e OpenCode erram com JSON-RPC -32603, sem `stopReason`; o Codex dá `end_turn` sem erro, salvo no usage limit. Tempo até desistir: Claude ~3 min (11 requisições, ignora `retry-after`); Codex de 0,3 s (usage limit) a 11 s; OpenCode 70 a 75 s, e com `retry-after: 3600` espera sem limite (mais de 300 s). A extensão `_meta.jetbrains.air.sessionFailure` existe no Claude e no Codex [V]; no OpenCode não existe [S] [V].

Estas respostas alimentam a §5.7 e a N42 do docs/13. As consequências para o failover são [proposta] no README de origem.

### 2.4 Perfis isolados (item 7)

Variáveis de isolamento: `CLAUDE_CONFIG_DIR`, `CODEX_HOME` com `cli_auth_credentials_store="file"`, `XDG_*` e `OPENCODE_DB` [V]. Sem restrição de configuração, o perfil do dono (plugins e conectores claude.ai) vaza para a sessão do Claude [V]. O perfil isolado do OpenCode só vale em Linux [V]. O segundo login não foi medido em nenhum cliente; o `acp-claude` e o `acp-codex` listam o login real como pendente. A confiança da pasta com `CLAUDE_CONFIG_DIR` também está pendente (`quota-probes`).

### 2.5 Permissões (itens 8 e 9)

- **Claude:** `_meta.claudeCode.options` com `tools`, `disallowedTools`, `strictMcpConfig` e `settings` removeu o Bash [V]. Isolado caso a caso (item 8b do `acp-claude`, 2026-11-15) [V]:
  - `tools` sem o Bash, `disallowedTools: [Bash]` e `deny: [Bash]` removem o Bash **cada um sozinho**;
  - o `dontAsk` **não chega** pelo ACP: o adaptador 0.107.0 não o oferece no catálogo, `set_config_option` o recusa, o `defaultMode` do `_meta` é ignorado e o dos arquivos de settings cai para `default`;
  - o `disableBypassPermissionsMode` do `_meta` não tira o `bypassPermissions` do catálogo, só faz a troca falhar (`-32603`); `allowDangerouslySkipPermissions: false` tira do catálogo;
  - `settingSources: []` vale (o padrão vem antes do espalhamento do `_meta`) e corta plugins, skills e MCP do perfil do dono; os conectores claude.ai continuam listados.
  - O modo começa em `auto`, exceto quando os arquivos de settings do cwd dizem outro modo do catálogo. A troca é por `session/set_config_option`.
  - [proposta] O "nega tudo que pediria permissão" do Executor headless vira modo `default` mais o cliente do OTheater respondendo `reject`.
- **Claude, item 8c** (`acp-claude`, 2026-11-15, 17 prompts) [V]:
  - `deny: ["Bash(touch *)"]` pelo `_meta`, com o cliente em `allow`, nega `touch`, `/usr/bin/touch` e `env touch` sem consultar o cliente. `sh -c` e `bash -c` **furam** a regra: geram `request_permission` e, com `allow`, o arquivo é criado. Com o cliente em `reject`, os dois furos fecham. A documentação (https://code.claude.com/docs/en/permissions, lida em 2026-11-15) avisa sobre `/bin/rm`, `bash -c` e `env` [S]. `deny` por padrão é segunda camada, não fronteira.
  - RSS do `claude` por sessão: base 315 MB, `strictMcpConfig` 300 MB (perto do ruído de 2 MB), `settingSources: []` 254 MB, os dois 242 MB. O contexto do prompt cai de 41,8 mil para 30,0 mil tokens. Uma rodada por variante.
  - `session/cancel` mata o filho de uma ferramenta Bash em primeiro plano (25 ms). Um filho lançado com `run_in_background` sobrevive ao cancelamento.
- **Claude, item 8d** (`acp-claude`, 2026-11-15, 29 prompts, Haiku/low) [V]:
  - Outros embrulhos do `deny: ["Bash(touch *)"]`, cliente em `allow`, n=1 cada: `xargs`, `command`, `timeout` e `nohup` foram negados sem consultar o cliente; `find -exec`, `eval`, `$(echo touch)` e `python3 -c` com `os.system` **furaram**, com 1 `request_permission` cada e o arquivo criado. Com o cliente em `reject`, `sh -c` e `bash -c` não criaram o arquivo (n=1 cada); os outros furos com `reject` não foram medidos [N].
  - RAM com 3 rodadas por variante (média, mínimo a máximo, RSS do `claude`): base 313 (312 a 314) MB, `strictMcpConfig` 301 (300 a 302), `settingSources: []` 255 (254 a 255), os dois 244 (243 a 244). Ganhos de 12, 58 e 69 MB, e a rodada única do 8c cai dentro das faixas. O que variou foi o adaptador Node, de 97 a 132 MB. Tokens do prompt: 41,8 mil na base e 30,1 mil com os dois cortes.
  - Filho em segundo plano: ao fechar o stdin do adaptador (n=2) ou mandar SIGTERM (n=1), o adaptador sai em até 200 ms, os filhos morrem em até 200 ms e o `claude` some em 1 a 3 s. Com SIGKILL no adaptador (n=2), o `claude` fica órfão (adotado pelo `systemd --user`) e o filho só termina sozinho, aos ~118 s. Quem mata os filhos no fechamento normal não foi isolado [N].
  - Sem `settingSources: []`, apareceram `kit-quota` e `codex app-server` como filhos do `claude`, provavelmente de um gancho do perfil do dono [N].
- **Codex:** `read-only` recusa a escrita. `workspace-write` deixa `/tmp` gravável sem `request_permission`; fora de `/tmp` bloqueia e gera `request_permission` (allow executa fora do sandbox, reject cancela) [V].
- **Codex, item 8** (`acp-codex`, 2026-11-15, 7 prompts) [V]:
  - O catálogo tem sempre os 4 modos. `agent-full-access` não sai com `INITIAL_AGENT_MODE`, `CODEX_CONFIG` nem `-c allowed_sandbox_modes` (por um embrulhador em `CODEX_PATH`), e o `set_config_option` para ele funciona em todas as variantes. Só um `requirements.toml` gerenciado (`/etc`, nuvem ou MDM) poderia barrar; não testado [S/N].
  - No modo `agent`, a escalada passa por um revisor automático ("Guardian Review") que aprovou sozinho; nenhum `session/request_permission` chegou ao cliente, nem com a política `reject`. Em `agent-full-access` nada pede permissão. Uma forma de pedido medida; outros comandos podem ter outro veredito [N].
  - O sandbox de `agent` e `workspace-write` deixa `/tmp` gravável (`excludeSlashTmp: false`).
  - Conclusão do README: o veto a `agent` e `agent-full-access` tem de ficar no cliente (negar o `set_config_option`); `workspace-write` ou `read-only` são os modos em que o gerente vê o pedido.
- **Codex, item 8d** (`acp-codex`, 2026-11-15, 10 prompts com modelo real e 8 com provedor falso):
  - O binário 0.166.0 traz `/etc/codex/requirements.toml` fixo [S]. Num `CODEX_HOME` isolado, com provedor falso e sem login, um `requirements.toml` com `allowed_sandbox_modes` foi ignorado: `configRequirements/read` devolveu `null`, o catálogo seguiu com 4 modos e o `turn/start` de `agent-full-access` mandou `never` e `dangerFullAccess` [V, n=1 por caso]. O efeito de um arquivo em `/etc` não foi medido, porque exigiria root [N].
  - Revisor do modo `agent`, cliente em `reject`, n=1 por caso, 0 `request_permission` nos 6: com o prompt "se bloquear, peça aprovação", o sandbox bloqueou `curl` e `sudo -n` e o modelo não escalou. Com o prompt que manda escalar, o revisor aprovou os 4 pedidos (risco low): `curl` deu HTTP 200, o `rm -rf` apagou a pasta de teste fora da worktree, e o `sudo -n true` falhou só por falta de senha [V]. Os prompts pediam a aprovação por escrito, o que enviesa o revisor; o modelo escalando sozinho não foi medido [N].
  - `read-only` (n=4, `reject` e `allow`): nenhum arquivo criado e 0 `request_permission`, mas o modelo não rodou nenhum comando, então o bloqueio do sandbox em si não foi medido [N].
- **OpenCode:** o padrão sem config permite tudo. `OPENCODE_PERMISSION` com `ask` gera `request_permission` (3 opções). `opencode.json` com `deny` retira a ferramenta (1 execução) [V].
- **OpenCode, item 8** (`acp-opencode`, 2026-11-15, 5 prompts) [V]:
  - O `opencode acp` só oferece `model`, `effort` e `mode` (`build` e `plan`). `set_mode` e `set_config_option` com nomes de bypass falham. O `--auto` existe só no `opencode run`, fora do ACP.
  - Precedência medida em pares: `opencode.json` do cwd < `OPENCODE_CONFIG_CONTENT` < `OPENCODE_PERMISSION`. `deny` retira a ferramenta. `OPENCODE_DISABLE_PROJECT_CONFIG=1` faz o `opencode.json` do cwd ser ignorado. A config global do dono não foi lida e pode ter influído [N]. Os nomes das variáveis vêm das strings do binário, não da documentação [S/V].
  - Inferência do README: como o modelo pode editar o `opencode.json` da worktree, o daemon deve fixar as permissões por `OPENCODE_PERMISSION` [N].
- **OpenCode, item 8d** (`acp-opencode`, 2026-11-15, 12 prompts, n=1 por caso) [V]:
  - Com a config global do dono isolada por `XDG_CONFIG_HOME` (o login fica em `XDG_DATA_HOME` e continuou valendo; o `auth.json` não foi lido), e1 a e5 deram o mesmo resultado: a precedência se mantém, e a dúvida sobre a influência da global sai, para esses casos.
  - Sem nenhuma config, o padrão é `allow` para `bash` e `edit`, sem `request_permission`. A documentação diz `ask` (https://opencode.ai/docs/permissions/, lida em 2026-11-15) [S].
  - `opencode.json` do cwd com `bash: deny` contra `OPENCODE_PERMISSION` com `bash: allow`: o `allow` vence.
  - Regras por padrão de comando em `OPENCODE_PERMISSION`: com `{"*": "deny", "git status*": "allow"}`, o `git status` roda e o `touch` termina `failed` sem pedido; com `{"*": "allow", "touch *": "ask"}`, o `touch` gera 1 `request_permission`. Um `deny` por padrão não tira a ferramenta, só faz a chamada falhar.
- **Prompts:** o item 8 gastou acima do limite de 25 do trabalho original: Claude 40, Codex 28 e OpenCode 29 prompts no total de cada spike até o 8c; o 8d acrescentou 29, 10 e 12.
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
- **Teclas (tmux Linux; mapa da N35, 41 teclas; refeito em 2026-11-15):** Ctrl+J chega como `0a`, diferente do Enter `0d`. Alt+S, Alt+J, Alt+A, Alt+W e Alt+K chegam como `ESC letra`. Ctrl+B não chega dentro do tmux com o prefixo padrão (modo aninhado); no preset `agents` ele só move o cursor na caixa de texto. Ctrl+Shift+←/→ chegam como `ESC[1;6D/C`. O terminal sob o tmux não responde ao protocolo kitty. `send-keys` não passa por terminal real [V].
- **Shift+Enter no tmux [V]:**
  - Sem `extended-keys`, chega `0d`, igual ao Enter.
  - Com `extended-keys always` e `extended-keys-format csi-u` na partida do servidor, chega `ESC[13;2u`.
  - Com `extended-keys on`, o programa que pede o modifyOtherKeys recebe `ESC[27;2;13~`. Nesse modo, Ctrl+letra, Alt+letra e Shift+Tab também mudam de forma.
  - O aninhado deu o mesmo.
  - O `extended-keys` ligado com `tmux set` depois de a sessão abrir não teve efeito.
- **Ink 8.0.0 e teclas estendidas [V]:** o `parse-keypress` do Ink lê o `CSI u` (Shift+Enter vira `return` com `shift`) e não lê o modifyOtherKeys (nome vazio). Para o Ink, o caminho é o `CSI u`: o protocolo kitty ou o tmux com `extended-keys-format csi-u`.
- **Ctrl+Shift+P:** chega como `10` sem `extended-keys` e com `csi-u`. Com o modifyOtherKeys pedido, chega distinto (`ESC[27;6;112~`). A §5.13 diz que só o protocolo kitty distingue; no tmux, o modifyOtherKeys também distingue [V]. Dado fraco: o byte foi gerado pelo tmux.
- **Limites declarados:** só tmux; os geradores dos dois protótipos não são idênticos; vazamento contra retenção do OpenTUI [N]; sem terminal gráfico, SSH, macOS, Windows, IME; faltam as 3 repetições mínimas.

### 2.10 OTel (item 21)

- **Claude Code:** `http/json` e `http/protobuf` funcionam; métricas, eventos e traces chegam. O recurso traz os 3 atributos `otheater.*` em 100% dos registros (63/63, 62/62, 68/68). Por sessão ACP, `_meta.claudeCode.options.env` troca a correlação e o endpoint no mesmo adaptador [V].
- **Codex:** `codex exec -c otel.*` exporta logs, traces e métricas; `OTEL_RESOURCE_ATTRIBUTES` funciona nos 3 sinais (1348/1348), embora a documentação não o cite. No `codex-acp`, `CODEX_CONFIG` com `otel` não exportou. A causa, medida no `app-server` direto: o exportador só é montado na partida, por `config.toml` ou `-c otel.*`; o `otel` no `config` do `thread/start` é ignorado sem erro (n=4 por variante) [V]; o adaptador só converte `hooks` e `model_provider(s)` em `-c` [S]. Um wrapper em `CODEX_PATH` funcionou, mas não dá correlação por sessão: o `app-server` atende todas as sessões do adaptador, e o daemon precisaria de um adaptador por run (ou correlacionar por `conversation.id`) [V]. A thread extra é 1 por sessão (não 2): a geração de título, com outro modelo e `read-only`; some com `session/set_title` antes do 1º prompt (0 de 3 contra 3 de 3) [V].
- **OpenCode:** `OTEL_EXPORTER_OTLP_ENDPOINT` basta; logs e traces chegam (sem métricas), com `otheater.*` em 376 de 376 registros. No prompt curto não apareceu span de chamada ao modelo, token ou custo [V]. Com ferramenta, via `opencode acp` em porta própria (n=2): sem `experimental.openTelemetry`, só spans internos sem atributos; com a chave, spans `ai.streamText` e `ai.toolCall` com tokens e modelo, mas o prompt (~33 mil caracteres), a resposta e o resultado da ferramenta saem em claro. Custo em USD não aparece [V].
- **Vazamento padrão:** Claude e Codex trazem `user.email`, `user.id` e `organization.id` ou `user.account_id` sempre. O `codex.tool_result` exporta `arguments` e `output` em claro por padrão [V]. O daemon precisa redigir no receptor.
- **Sobrecarga:** Claude 9,33 s sem e 9,79 s com (+0,47 s); Codex 3,56 s sem e 3,98 s com (+0,42 s); não distinguível do ruído (até 1,5 s entre repetições) [V]. Runs longos e via ACP não foram medidos.

### 2.11 Avaliação de base (item 22)

[ADR 0001](../docs/adr/0001-projeto-proprio-sem-fork.md): projeto próprio, sem fork. Nenhum candidato entrega o daemon único por usuário com API, e nenhum usa XState [V]. O único bloqueio de licença objetivo é o LGPL-3.0 do libvips do `sharp` (Happier, AionUi, Paradev) [V]. Os números de commits vêm da API do GitHub, em 2026-11-14 [S]. Nenhum candidato foi executado. Faltam o AionCore, o texto da licença "Custom" do `@anthropic-ai/claude-agent-sdk` [N] e a árvore completa do Happier. O Claudexor (MIT, 196 pacotes sem licença proibida, 1.117 arquivos de teste que não foram rodados) entrou em 2026-11-15 como referência, sem fork, e conflita com a §3 por ler token OAuth [V].

### 2.12 Licenças (item 23)

- **1MCP** Apache-2.0 (199 pacotes de produção, todos permitidos); **AgentPrism** MIT no repositório, mas os pacotes npm `agent-prism-data` e `agent-prism-types` 1.0.0 não têm campo `license`; **Nimbalyst** MIT na raiz [V]. Árvore medida em 2026-11-15 pelo `pnpm-lock.yaml` do commit `dc5a0ef`, sem instalar nem executar nada, com a licença do registro npm [S]: 1825 pacotes (1252 de produção). Em produção, 15 proibidas, todas LGPL (libvips do `sharp` via `@huggingface/transformers`, e `libheif-js`), 14 sem decisão (8 do SDK do Claude, `elkjs` EPL-2.0, `posthog-js`, 2 UNKNOWN e 2 `MIT AND Zlib`) e 8 de nível C empacotadas; o verificador sai com 1. É referência de desenho, não dependência.
- **Verificador** `check.mjs`: 16 testes sintéticos passam [V]. O adaptador `lockfile-pnpm.mjs` converte um `pnpm-lock.yaml` para o formato que ele lê (4 testes passam) [V]. Desde 2026-11-15, `policy.json` traz as decisões do dono (N45): oito licenças aceitas, a exceção do AgentPrism e os executores em `ferramentasExternas`. A chave `--nivel-c=falha|instalacao` reprova ferramenta de nível C dentro do produto (padrão), ou aceita a ferramenta e o que só ela traz quando a pasta é uma lista de ferramentas externas.
- **Decisões do dono (N45, 2026-11-15):** os executores e os adaptadores ACP ficam no nível C (D1, D4 e D5). BlueOak-1.0.0, Unlicense, CC0-1.0, MIT-0, Python-2.0, WTFPL, CC-BY-3.0 e CC-BY-4.0 são aceitas em dependências (D6). AgentPrism 1.0.0 entra por exceção (D7). Confirmadas as regras `OR` e `AND` do SPDX (D9) e GPL só no nível C (D10). Com isso, `core` e `later` passam também com `--tudo`, e `executors` passa com `--nivel-c=instalacao` [V].
- **Árvores da stack:** núcleo 192 de 192 permitidas; fases posteriores 138 de 138; executores (só lockfile) 154, com 22 sem decisão e 0 proibidas [V].
- **Árvores dos spikes:** 2 proibidas, `@opentui/core-linux-x64` e `-musl` (`MIT AND LGPL-2.1-or-later`); 10 sem decisão nas árvores com `claude-agent-acp`; 1 alerta de arquivo LGPL em `@openai/codex@0.166.0-linux-x64` [V].
- **`@anthropic-ai/claude-agent-sdk`:** "todos os direitos reservados". O texto não concede nem proíbe a redistribuição dentro de um SEA: ambíguo [N]. Por isso a D1 o deixou fora do executável, no nível C.
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
| Contato com a Anthropic sobre o R1 (orquestrador pessoal multi-conta). A redistribuição do SDK saiu da pergunta: pela D1 ele fica no nível C | [licenses](licenses/README.md), D2 |
| Termos da OpenAI: ler ele mesmo, ou autorizar outro meio de leitura (o `curl` deu 403) | [licenses](licenses/README.md), D3 |
| Segundo login de cada cliente (precisa de uma segunda conta) | os três acp-* |
| Assinatura ou OAuth real para esgotar cota, `resetsAt` e failover entre contas | [quota-exhaustion](quota-exhaustion/README.md) |
| Decisões já listadas como do dono nos READMEs: `processModel` do OpenCode (1 por sessão ou por perfil); patch, fork ou contribuição ao Ink | READMEs de origem |

### 4.2 Exigem Windows ou macOS

- Sandbox Windows (`sandbox-runtime` alpha e plano B), o lançador Rust com Job Object e o MXC do Codex: nenhum spike.
- `ConPTY` no Windows (`quota-probes`).
- Windows Terminal, Terminal.app e iTerm2 (`tui-keys`); IME, SSH e terminais gráficos (`tui-ink`, `tui-opentui`).
- Todo o resto dos spikes foi feito em Linux. Os READMEs `acp-*` listam o Windows como pendência.

### 4.3 Abertas por falta de medição

- **Repetição estatística:** o bastão (2 a 3 execuções por célula), as 10 tarefas do modelo local (1 por configuração) e a TUI (menos de 3 repetições) têm n muito pequeno.
- **Bastão** (`acp-handoff`): o full com `gemini-3.5-flash` só tem n=1 (cota diária); origem 3 e tarefas maiores; modelo mais forte nos destinos Claude e Codex; sessões depois da retenção; cota real combinada; efeitos externos; causa do travamento do `opencode run -s` com `--dir` diferente.
- **Unidade de `utilization` com valor alto:** só foi medida em 1% (`quota-probes`).
- **OTel:** sobrecarga em runs longos e via ACP; `codex-acp` com `config.toml` e chamada ao modelo (exigiria `auth.json` num `CODEX_HOME` à parte); opção para desligar a thread de título sem definir título; origem do 2º modelo e custo no OpenCode; `opencode serve` (`otel`).
- **Permissões, resto do item 8 depois do 8d:** os furos do `deny` do Claude com o cliente em `reject`, além de `sh -c` e `bash -c`, e se o grupo de processos mata o `claude` órfão (`acp-claude`); um `requirements.toml` em `/etc` (exige root), o modelo escalando sem o prompt pedir e o bloqueio do sandbox `read-only` com um comando de fato executado (`acp-codex`); comandos compostos contra padrões, ordem das chaves e a chave `shell` (`acp-opencode`). Tudo com n=1.
- **Modelo local:** 26B-A4B e 31B que a arquitetura cita, outras quantizações, mais de um slot, raciocínio ligado contra desligado, `opencode run`, cancelamento com prompt longo (`local-model`).
- **Licenças:** arquivo de licença dentro dos tarballs para os UNKNOWN e `SEE LICENSE IN` do Nimbalyst, e o HEAD atual dele; `xclip`, texto da MPL-2.0, `THIRD_PARTY_NOTICES` (`licenses`).
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
| Licenças da Fase 0: executores no nível C, oito licenças aceitas, `OR`/`AND` do SPDX, GPL só no nível C, exceção do AgentPrism | docs/13, N45; arquitetura v0.41 (§6.0) |
| Tradução da `RolePolicy` ajustada ao item 8: `deny` do Claude como segunda camada; `OPENCODE_PERMISSION` fixado e `OPENCODE_DISABLE_PROJECT_CONFIG=1`; Codex começando em `workspace-write`, com veto do daemon a `agent` e `agent-full-access`; cancelar encerra a árvore de processos | arquitetura v0.45 (§5.2 e §5.8), docs/08 e docs/09 |
| Dados do item 8d, sem decisão nova: mais furos no `deny` do Claude, `claude` órfão quando o adaptador morre por SIGKILL, `requirements.toml` do Codex só em `/etc`, regras por padrão de comando no OpenCode | arquitetura v0.46 (§5.2 e §5.8) |
| Dados do OTel e do Nimbalyst, sem decisão nova: o exportador do Codex só na partida do `app-server`, a thread de título por sessão, o OpenCode só com `experimental.openTelemetry` (que vaza conteúdo), e o Nimbalyst MIT na raiz com a árvore medida | arquitetura v0.47 (§5.11 e tabela de referências) |

Outras entradas do docs/13 ligadas à Fase 0, todas Decididas: N33 (código dos spikes em `spikes/`), N36 (copiar com o mouse), N43 (integração de terminal estilo Claude Desktop), N44 (comandos `/` e sessão direta) e N45 (licenças da Fase 0).

## 7. Veredito do critério de aceite

Critério da §10: "cada item com resposta medida, não suposta".

**O critério não está cumprido.** 11 de 24 itens têm resposta medida em Linux. Os outros 13 não têm.

Sem resposta medida, por grupo:

- **Parcial (7):** cota esgotada com assinatura real (4), bastão com 2 a 3 execuções por célula (6), segundo login (7), cota em valor alto (10), modelo local sem o 26B-A4B ou 31B (14), mouse fora do tmux (20), licenças sem os termos da OpenAI (23; a árvore do Nimbalyst foi medida em 2026-11-15).
- **Pendente do dono (3):** MiniMax (11), terminais e atalhos reais (19), R1 com a Anthropic (24).
- **Não medível nesta máquina (3):** MXC do Codex (9), sandbox Windows (12) e lançador Rust com Job Object (13).

Dois pontos de leitura que não mudam a contagem:

- **Medido não quer dizer fechado.** Vários itens "Medido" têm uma execução por célula (TUI, modelo local, permissões) e marcam n pequeno no README. O item 2 está medido, mas o `processModel` do OpenCode continua do dono.
- **O texto da §10 pede "Shift+Enter distinguível do Enter".** Em 2026-11-15, o `tui-keys` passou ao mapa da N35 e ganhou uma linha de Shift+Enter. No tmux, o Shift+Enter só se distingue do Enter com `extended-keys` ligado na partida, e o Ink só o lê no formato `CSI u` [V]. Nos terminais reais, a medição continua pendente do dono. Por isso, quem garante a nova linha (N35) é o Ctrl+J, que se distingue do Enter em toda a bancada.

Estimativa da §10: 2 a 3 semanas. Os READMEs não medem o esforço real; nada aqui confirma ou contradiz o prazo.
