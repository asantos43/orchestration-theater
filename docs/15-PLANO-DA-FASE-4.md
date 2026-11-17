# 15. Plano da Fase 4

Versão 1, de 2026-11-17. Este é o plano de passos da Fase 4 da [arquitetura](framework-ideas/arquitetura.md), §10, "Permissões e ferramentas de trabalho". A arquitetura continua sendo a referência: este plano só divide a fase em passos, diz o que pode correr em paralelo e dá o aceite de cada passo. Se os dois divergirem, vale a arquitetura, e este documento é corrigido.

O dono liberou o merge dos PRs da Fase 4 sem ok por PR, com a CI verde e squash (2026-11-17).

Decisões do dono em 2026-11-17, por múltipla escolha, iguais às recomendações ([docs/13](13-DECISOES-EM-ABERTO.md)):
- **N93:** os downloads da Fase 4, com as versões exatas;
- **N94:** a camada 3 no Windows continua portão, e a fase fecha em Linux;
- **N95:** a CI instala o `bwrap`, o `socat` e o Chromium, e os testes de sandbox e de navegador rodam em todo PR;
- **N96:** o plano fica neste documento, e a fase ganha o marco interno 4a.

## Como usar

- Cada passo tem uma branch e um PR com título "Fase 4: ...". O PR que conclui um passo também muda o estado dele na tabela de passos.
- Todo passo exige, além do aceite próprio, `build`, `lint`, `format:check`, `test`, `verify` e `deps` verdes na máquina e na CI (job `linux`).
- O que está marcado **[proposta]** é detalhe deste plano, ainda sem decisão. Uma chave de configuração nova sempre ganha um padrão e os seus modos. Se ela mudar algum comportamento visível, a escolha vai ao dono, por múltipla escolha, ao abrir o passo.
- Paralelismo:
  - passos sem dependência entre si correm ao mesmo tempo, cada um no seu worktree;
  - dois passos nunca mexem nos mesmos arquivos, com uma exceção: o `DaemonConfigSchema` (`daemon/src/config.ts`) e o registro de ferramentas (`core/src/registries/tools.ts`) recebem grupos novos em vários passos. Cada passo acrescenta só o seu bloco, e o conflito se resolve no merge da main na branch;
  - no máximo dois subagentes rodam a suíte completa ao mesmo tempo, por causa da memória da máquina.
- Nada real roda nos testes (N57). Os testes reais desta fase (a suíte de fuga nos três clientes, P5 e P11) são opcionais, pulam sem as variáveis `OT_TEST_REAL_*` e só rodam com o ok do dono para cada rodada.

## Ponto de partida

O que já existe foi conferido no código em 2026-11-17, no commit `268f7d0` **[V]**. Os caminhos são relativos a `packages/`.

- **Política do papel:**
  - a `RolePolicy` (`core/src/ports/client-adapter.ts`) está na versão 1, só com literais: `nativeShell: 'none'`, `onAsk: 'reject'`, `bypass: 'forbidden'`, `writeScope: 'worktree'` e `network.allow`;
  - a política de cada papel é fixa no código (`policyOf`, `daemon/src/orchestration/roles.ts`): o Ator edita e escreve no worktree, os outros só leem e buscam, e ninguém tem shell nem rede.
- **Camada 1, por cliente:**
  - **Claude Code** (`client-claude-code/src/policy.ts`): `tools`, `disallowedTools` com o Bash, `allowedTools` com `mcp__<servidor>`, `strictMcpConfig`, `allowDangerouslySkipPermissions: false` e `settingSources`, pelo `_meta.claudeCode.options`. O `prepare-profile.ts` grava o modo padrão, o `disableBypassPermissionsMode` e o `deny`. O `enforcement` deixa `writeScope` e `network` sem camada.
  - **Codex** (`client-codex`): `config.toml` com `sandbox_mode` e `approval_policy`; o modo inicial `workspace-write` vai por `set_config_option`, e os modos `agent` e `agent-full-access` são vetados (`modes.ts`). Não há regra de liberação para as ferramentas MCP.
  - **OpenCode** (`client-opencode/src/permission.ts`): o `OPENCODE_PERMISSION` com `'*': 'ask'`, o bash negado, o `external_directory` negado e `<servidor>_*` liberado, mais `OPENCODE_DISABLE_PROJECT_CONFIG=1` e o isolamento por XDG.
- **Camada 2:** a única resposta é fixa (`answerPermission`, `core/src/client-adapter-base.ts`): `reject_once`, depois `reject_always`, senão `cancelled`. Não há regra de liberação nem evento do pedido recusado.
- **Camada 3:**
  - não há sandbox no código: nem `sandbox-runtime`, nem bubblewrap, nem Seatbelt;
  - o `SandboxCapabilities` existe, mas o `compose.ts` nunca o preenche. Por isso, `security.unenforced: refuse` (padrão) recusa as sessões com `writeScope` ou `network` sem camada no cliente;
  - só há contenção de processo: o grupo de processos e o scope do systemd em `adapters/platform-posix`, e o Job Object do lançador Rust (`native/job-launcher`), que ainda não está ligado ao daemon no Windows.
- **Ferramentas de trabalho:**
  - o registro (`core/src/registries/tools.ts`) já tem `run_tests`, `install_deps`, `git_commit`, `restricted_shell`, `http_get` e `view_diff`, todas respondendo `not_implemented` (`daemon/src/mcp/handlers.ts`). Também respondem `not_implemented` as do Diretor `open_pr`, `pause`, `resume`, `cancel_actor`, `schedule`, `list_schedules`, `pause_schedule`, `promote` e `run_task`, e a comum `read_indication`;
  - os schemas de entrada são mínimos (`restricted_shell {argv[]}`, `http_get {url}`), e a saída é `json` genérico;
  - não há semáforo de comandos pesados, confinamento de caminho das ferramentas nem truncamento de saída de comando. Os vizinhos são o `resolveInsideCwd` do agente falso e o `.worktreeinclude` do `vcs-git`, que não seguem symlink;
  - já existem os verificadores de efeito de `git_commit` e `open_pr` (`daemon/src/workspace/verifiers.ts`) e a chave de idempotência por `attempt_step`.
- **Navegador:** não há porta `BrowserSession`, Playwright nem chave `browser.*`.
- **Perfil `software`:**
  - o cenário de projeto grava `profile: 'software'`, e o campo `conventions` existe na porta, mas ninguém o preenche;
  - a entrega (`workspace.ts`, `play-effects.ts`) usa um título com a primeira linha da necessidade, um corpo fixo e a mensagem de merge `Deliver play <id>`. Não há changelog, estrutura inicial, CI nem importação com detecção de convenções.
- **Fila de ideias:** não há tabela `ideas`, chave `ideas.*` nem o ponto de julgamento `group_ideas`.
- **`delivery.mode: ask` (N89):** o `play-effects.ts` passa `attended: false` fixo, e o `ask` vira `pr`. A presença do chat existe (`orchestration/wiring.ts`), mas só alimenta o `base_drift: ask`.
- **Consultor (N86):** a política dele é só de leitura; o `http_get` não tem handler, e os adaptadores reais não declaram `inputTypes`, então só o agente falso aceita imagem.
- **Testes de fuga:** só há partes soltas: o agente falso recusa caminho fora do cwd e symlink; o `.worktreeinclude` não segue symlink; há as sondas `shCRejectProbe` (Claude Code), `modeVetoProbe` e `pinnedModeProbe` (Codex) e a de permissão do OpenCode. Não há suíte comum aos três clientes.
- **Máquina [V]:** Node 24.18.0; `bwrap` 0.13.1, `socat` e `rg` em `/usr/bin`; o Chromium revisão 1248 do Playwright já está no cache do usuário (`~/.cache/ms-playwright`).

## Dependências novas

Aprovadas pelo dono em 2026-11-17 (N93). A versão é fixa, e as duas foram publicadas até 2026-11-03, ou seja, há duas semanas ou mais. Os dados vêm do registro npm (`registry.npmjs.org/<pacote>`) e do `browsers.json` do pacote no jsDelivr, consultados em 2026-11-17 **[V]**.

| Pacote | Versão | Licença | Publicada em | Entra em | Passo |
|---|---|---|---|---|---|
| `@anthropic-ai/sandbox-runtime` | 0.0.81 | Apache-2.0 | 2026-10-20 | adaptador novo `adapters/sandbox-srt` | P4 |
| `playwright-core` | 1.64.1 | Apache-2.0 | 2026-10-14 | adaptador novo `adapters/browser-playwright` | P6 |

- **`sandbox-runtime`:**
  - pede Node >=22.12.0, e o repositório exige >=24;
  - dependências diretas: `zod ^3.25.0`, `commander ^12.1.0` (MIT), `node-forge ^1.4.0` e `@pondwader/socks5-server ^1.0.10` (MIT). O `zod` 3 entra como uma segunda cópia ao lado do zod 4 do repositório;
  - o `node-forge` tem a licença dupla `(BSD-3-Clause OR GPL-2.0)`. O projeto usa a opção BSD-3-Clause. Não foi conferido se o verificador de licenças aceita a expressão `OR` com uma opção proibida **[N]**; se não aceitar, o P4 registra a escolha na `policy.json`, com o motivo;
  - a versão é 0.0.x: a API pode mudar a cada versão, e a versão fixa protege o projeto disso;
  - no Linux, ele usa o `bwrap` e o `socat` do sistema, que já estão na máquina **[V]**; no macOS, o Seatbelt **[S]**.
- **`playwright-core`:**
  - não tem dependências e pede Node >=20;
  - não baixa navegador na instalação, ao contrário do pacote `playwright` **[S]**;
  - a 1.64.1 usa o Chromium revisão 1248 (156.0.8078.4), que já está no cache desta máquina **[V]**. Na CI, o navegador é baixado no job `linux` (N95).
- As versões mais novas ainda não completaram duas semanas: `sandbox-runtime` 0.0.82 (2026-11-10) e 0.0.83 (2026-11-13); `playwright-core` 1.65.0 (2026-11-05) e 1.65.1 (2026-11-13).
- Ninguém percorreu a árvore transitiva inteira **[N]**. O verificador de licenças roda no PR do passo que instala o pacote, e o `THIRD_PARTY_NOTICES` é gerado de novo nesse PR.
- Na CI do GitHub (Ubuntu 24.04), o AppArmor pode barrar os namespaces sem privilégio que o `bwrap` usa **[N]**. Pela N95, o job `linux` instala o `bwrap` e o `socat` por apt e, se o AppArmor barrar, libera os namespaces no próprio runner. O P4 confere isso no primeiro PR.

## Passos

| Passo | Título | Depende de | Pode correr junto com | Estado |
|---|---|---|---|---|
| P0 | Plano e downloads (este documento) | nada | nada | em andamento (este PR) |
| P1 | Política por papel e camada 1 completa | P0 | P3, P7, P8 | pendente |
| P2 | Camada 2: resposta por regra e eventos | P1 | P4, P6, P7 | pendente |
| P3 | Cascas: confinamento, truncamento, semáforo e handlers | P0 | P1, P7, P8 | pendente |
| P4 | Camada 3: porta `Sandbox` e `sandbox-runtime` | P1, P3 | P2, P6, P7 | pendente |
| P5 | Suíte de fuga | P2, P3, P4 | P9, P10 | pendente |
| P6 | Navegador sem a tela | P3 | P2, P4, P7 | pendente |
| P7 | Perfil de projeto `software` | P0 | P1, P2, P3, P4, P6, P8 | pendente |
| P8 | Fila de ideias | P0 | P1, P3, P7 | pendente |
| P9 | `delivery.mode: ask` com alguém olhando (N89) | P7 | P5, P10 | pendente |
| P10 | Consultor: pasta do chat, pesquisa e imagem (N86) | P3, P6 | P5, P9 | pendente |
| P11 | Aceite da fase | todos | nada | pendente |

Ordem em ondas **[proposta]**:
1. P1, P3, P7 e P8;
2. P2, P4 e P6;
3. P5, P9 e P10; **o marco 4a fecha com o P5**;
4. P11.

**Marco 4a (N96):** permissões e cascas fechadas, com a suíte de fuga verde no agente falso e nos testes reais opcionais. São o P1 a o P5 e o primeiro item do aceite da fase. O navegador, o perfil `software`, a fila de ideias e as sobras da Fase 3 vêm depois, até o aceite completo.

**Estimativa:** 3 semanas para a fase inteira, como na §10 **[proposta]**.

### P1. Política por papel e camada 1 completa (§5.2 e §5.8)

**Escopo:**
- A `RolePolicy` ganha a versão 2 **[proposta]**:
  - `nativeShell: 'none' | 'shells'`, em que `shells` libera só as cascas do daemon (P3);
  - `network.allow` com a lista de domínios do papel, garantida pela camada 3 (P4);
  - o conjunto das ferramentas MCP do papel por nome, já filtrado pelo registro;
  - `onAsk: 'reject' | 'rules'` (P2).
- A política sai do código (`policyOf`) para a configuração, com override no projeto e no cenário: `roles.<papel>.policy`. O padrão é a política de hoje. O override só abre o que é seguro (N99): liga as cascas, os domínios de rede e as ferramentas nativas de escrita; o bypass, o shell nativo e a escrita fora do worktree ficam sempre proibidos, e o daemon recusa a configuração que tentar abri-los.
- O `prepareProfile` e o `sessionSetup` de cada cliente traduzem a versão 2:
  - **Claude Code:** sem mudança de mecanismo; o `allowedTools` passa a listar só as ferramentas MCP do papel;
  - **Codex:** a liberação das ferramentas MCP do papel, se o cliente tiver uma. Como o Codex aprova uma chamada MCP está **[N]**; o passo mede no agente falso o que der e deixa a medição real para o teste opcional;
  - **OpenCode:** o `OPENCODE_PERMISSION` lista as ferramentas MCP do papel por nome, em vez de `<servidor>_*`.
- O `enforcement` de cada adaptador diz, por campo, qual camada garante o quê, para a `guarantee()` decidir com `security.min_layers`.

**Aceite:** testes de unidade da tradução nos três adaptadores, para cada papel; a `guarantee()` com a política v2; a política por configuração com override; o teste real opcional de cada cliente continua passando.

### P2. Camada 2: resposta por regra e eventos (§5.8)

**Escopo:**
- O `answerPermission` passa a consultar regras de liberação quando `onAsk: 'rules'` **[proposta]**:
  - uma regra casa o tipo do pedido (ferramenta, caminho, comando) e a política do papel;
  - um pedido de escrita fora do worktree, de shell nativo, de rede fora da lista ou de troca para um modo de bypass é sempre recusado, com qualquer regra;
  - sem regra que case, a resposta é a recusa de hoje.
- Cada pedido vira evento: `permission.asked` e `permission.answered`, com a sessão, a tentativa, a ferramenta e a regra que decidiu **[proposta]**.
- O pedido que chega numa sessão direta (N44, Fase 7) fica fora deste passo.

**Aceite:** testes com o agente falso: um pedido liberado por regra, um recusado sem regra e um recusado com regra (fora do worktree), cada um com os eventos.

### P3. Cascas: confinamento, truncamento, semáforo e handlers (§5.8)

**Escopo:**
- Biblioteca pura em `core` **[proposta]**:
  - confinamento de caminho: resolve o caminho contra o worktree com `realpath`, recusa `..` que escapa e symlink que aponta para fora;
  - argv só por lista: o programa vem de uma allowlist por papel e por perfil de projeto, sem `;`, `|`, `&&`, redirecionamento nem expansão de shell, e sem programa chamado por caminho;
  - truncamento de saída, com o tamanho original e a marca de truncado.
- Handlers no daemon, em `daemon/src/tools/` **[proposta]**:
  - `restricted_shell {argv}`: roda sem shell, no worktree, com timeout e o semáforo de comandos pesados;
  - `run_tests` e `install_deps`: o comando vem das convenções do projeto (P7) ou da configuração, nunca do modelo;
  - `git_commit {message}`: commit no worktree pela porta `Vcs`, com o verificador de efeito que já existe;
  - `view_diff {demand?}`: o diff da demanda pela porta `Vcs`, truncado;
  - `http_get {url}`: só os domínios permitidos do papel, com o corpo truncado e marcado como conteúdo não confiável.
- Schemas de saída por ferramenta: `exitCode`, `stdout`, `stderr`, `truncated`, `durationMs` **[proposta]**.
- O semáforo de comandos pesados: `tools.heavy_concurrency`, padrão 1 (N98), com a lista de comandos pesados por configuração.
- Os limites `tools.timeout_ms`, padrão 600000 (10 min), e `tools.output_max_bytes`, padrão 65536 (64 KiB) (N98).
- A lista de programas `tools.shell_allowlist` (N97): modos `list | profile | any`, padrão `list`, com uma lista curada (o `git` só nos subcomandos de leitura, `ls`, `cat`, `head`, `rg`, `node`, `pnpm run` e `npm run`, `tsc`, `eslint`, `prettier`, `vitest`). As chaves têm override no projeto e no cenário.
- Cada chamada vira evento `tool.called` e `tool.finished`, e as de efeito colateral (`git_commit`, `install_deps`) usam a chave de idempotência `attempt_step`.

**Aceite:** testes de unidade do confinamento (traversal, symlink de arquivo e de pasta, symlink em cadeia) e do argv (encadeamento, redirecionamento, programa por caminho); testes dos handlers com o agente falso chamando o MCP; timeout e truncamento; dois comandos pesados esperando o semáforo.

### P4. Camada 3: porta `Sandbox` e `sandbox-runtime` (§5.8)

**Escopo:**
- Porta `Sandbox` em `core` **[proposta]**: recebe a política do papel e o comando do Executor e devolve o comando embrulhado. Também declara o `SandboxCapabilities` da máquina (`writeScope`, `network`).
- Adaptador `adapters/sandbox-srt` sobre o `sandbox-runtime` 0.0.81 (N93), para Linux e macOS:
  - escrita só no worktree, nas pastas do perfil do cliente e numa pasta temporária própria;
  - rede negada por padrão, com a lista de domínios do papel e os do provedor do cliente;
  - leitura negada nos caminhos de segredo (a mesma lista do `browser.secret_paths`, P6) **[proposta]**.
- O `compose.ts` passa o `SandboxCapabilities` à `guarantee()`. Com a camada 3 ativa, `writeScope` e `network` deixam de precisar de `security.unenforced: warn`.
- As cascas (P3) também rodam dentro da sandbox.
- Chaves **[proposta]**: `sandbox.mode: runtime | off`, padrão `runtime` onde houver adaptador; `sandbox.extra_write_paths` e `sandbox.extra_domains`.
- **Windows:** fica como portão (N94), e a fase fecha em Linux. O passo só garante que o daemon no Windows diga que a camada 3 falta e siga o `security.unenforced`, que por padrão recusa. A medição dos itens 9 e 12 da Fase 0 fica para quando houver uma máquina Windows.
- A confirmar no passo **[N]**:
  - se o `bwrap` roda na CI do GitHub, e o que é preciso liberar no runner (N95);
  - se o `claude-agent-acp`, o `codex-acp` e o `opencode` funcionam dentro da sandbox, com a rede do provedor liberada;
  - se um servidor em `localhost` que o Ator sobe dentro da sandbox é alcançável pelo navegador, que fica fora dela (§5.19).

**Aceite:** com o agente falso dentro da sandbox, uma escrita fora do worktree e uma conexão a um domínio fora da lista falham no sistema operacional; a `guarantee()` passa sem `unenforced: warn`; o teste real opcional de cada cliente roda sob a sandbox.

### P5. Suíte de fuga (§5.8 e Fase 4)

**Escopo:**
- Roteiros novos do agente falso para cada tentativa de fuga **[proposta]**:
  - path traversal e symlink, nas ferramentas nativas e nas cascas;
  - encadeamento de comandos (`;`, `|`, `&&`, `$(...)`);
  - programa chamado por caminho ou dentro de `sh -c`;
  - ferramenta nativa bloqueada (Bash ou equivalente);
  - escrita fora do worktree e rede fora da lista, que só a camada 3 segura.
- A mesma suíte como teste real opcional nos três clientes, com o prompt que pede a fuga e a conferência no disco e na rede, sem olhar o texto do modelo. Entra como nível `escape` no `tools/acceptance/real-acceptance.sh` **[proposta]**.
- Quem roda o nível real é o dono, ou o orquestrador com o ok do dono para cada rodada (N57).

**Aceite:** a suíte verde com o agente falso, na máquina e na CI; o nível `escape` pronto para o dono, com `--dry-run`.

### P6. Navegador sem a tela (§5.19)

**Escopo:**
- Porta `BrowserSession` em `core` e adaptador `adapters/browser-playwright` sobre o `playwright-core` 1.64.1 (N93), com o Chromium sob o lançador (§5.9) e a admissão de RAM.
- Ferramentas `browser_open`, `browser_read`, `browser_screenshot`, `browser_click`, `browser_fill` e `browser_press_key`, com os `effects` da §5.19, filtradas pela política do papel.
- As chaves da N40, com os padrões sem restrição: `browser.profile` (só `shared` e `per_scenario` nesta fase; `extension` cai no `browser.fallback`, padrão `shared`), `browser.domains`, `browser.blocked_domains`, `browser.local_urls`, `browser.file_urls` com `browser.secret_paths`, `browser.write_approval`.
- O `file://` aplicado pelo daemon: `browser_open` recusa o caminho de segredo, e o daemon serve os arquivos numa origem local própria com token.
- A aprovação de escrita (`per_domain` e `always`) vai ao Produtor pela fila de prompts do chat.
- Eventos `browser.*`, com a URL e um print; as ações de escrita levam a chave de idempotência.
- A confirmar no passo **[N]**: a política do Chromium para `file://` no Playwright.

**Aceite:** os casos de navegador do aceite da fase, com uma página de teste servida pelo próprio teste: abrir, ler, tirar print e clicar sem aprovação no padrão; com `write_approval: always`, a aprovação antes do clique; com `allowlist`, a recusa de um domínio fora da lista; abrir `localhost` e um arquivo do worktree; recusar um caminho de segredo em `file://`.

### P7. Perfil de projeto `software` (§5.20)

**Escopo:**
- Artefatos gerados a partir do store na etapa DELIVERING: a entrada do changelog, a mensagem do commit de merge e a descrição do PR. O modelo só redige o texto livre dentro de um schema **[proposta]**.
- Estrutura inicial do projeto novo, a partir do modelo do perfil, com a CI (GitHub Actions) **[proposta]**.
- Importação de um repositório que já existe, com a detecção das convenções: o formato do changelog (Keep a Changelog, conventional-changelog ou outro), o padrão de commit (Conventional Commits ou livre), a CI e a branch principal. O OTheater mostra o que achou ao Produtor, que confirma ou corrige, e grava em `scenarios.conventions`.
- A detecção é código, com as heurísticas testadas por repositórios de exemplo criados no teste **[proposta]**.
- O changelog na entrega (N100): `delivery.changelog: auto | always | never`, padrão `always`. Se o repositório não tem changelog, a entrega cria o `CHANGELOG.md` no formato Keep a Changelog; se já tem, mantém o formato dele.

**Aceite:** um repositório importado mantém o formato do próprio changelog e o padrão de commit depois de uma peça com o agente falso; um importado sem changelog ganha o `CHANGELOG.md` na primeira entrega; um projeto novo nasce com a estrutura e a CI do perfil.

### P8. Fila de ideias (§5.20, N91)

**Escopo:**
- Tabela `ideas` no store, com o ciclo de vida `queued` → `grouped` → `done`, `discarded` ou `deferred`, e a ligação à peça e ao PR.
- O ponto de julgamento `group_ideas` do Autor, no nível do cenário, com o schema do grupo, das ideias de fora e das descartadas, divididas ou adiadas, sempre com o motivo.
- As chaves `ideas.drain` (padrão `auto`), `ideas.grouping_approval` (padrão `ask`), `ideas.max_per_play` (padrão 5) e `ideas.parallel_plays` (padrão 1).
- Os eventos `idea.*`, o comando `/idea` no `ot chat` e a volta das ideias à fila quando a peça é cancelada ou termina sem entrega.
- Fica de fora: a importação do `okit` (N92), que entra com a ferramenta da Q12.

**Aceite:** com o agente falso, uma fila de quatro ideias, duas da mesma área, vira três peças; o grupo espera a aprovação com `grouping_approval: ask`; a fila esvazia, com cada ideia ligada à peça e ao PR.

### P9. `delivery.mode: ask` com alguém olhando (§5.5, N89)

**Escopo:**
- Com alguém presente no chat, `delivery.mode: ask` faz o Diretor perguntar em DELIVERING se abre o PR ou faz o merge, pela fila de prompts.
- A resposta é um menu na máquina da peça; sem ninguém presente, continua virando `pr`.
- O `attended` fixo em `false` no `play-effects.ts` sai.

**Aceite:** com o agente falso, a peça com o Produtor presente pergunta e segue a resposta; sem o Produtor, entrega por PR, como hoje.

### P10. Consultor: pasta do chat, pesquisa e imagem (N86)

**Escopo:**
- O consultor escreve na pasta do chat (`scenarios/<id>/`), com o confinamento do P3.
- As ferramentas de pesquisa do consultor: `http_get` (P3) e as de leitura do navegador (P6).
- Os adaptadores reais declaram `inputTypes` com imagem quando o cliente aceita. Qual cliente aceita imagem pelo ACP está **[N]**: o passo confere no catálogo do cliente o que der sem rodar turno e deixa o resto para o teste real opcional.

**Aceite:** com o agente falso, o consultor grava um arquivo na pasta do chat e não grava fora dela; usa o `http_get` num servidor local do teste; recebe uma imagem quando o adaptador declara.

### P11. Aceite da fase

**Escopo:**
- Os itens do critério de aceite da Fase 4 na §10, com os testes do agente falso já feitos nos passos.
- O nível `escape` real nos três clientes, rodado pelo dono ou com o ok dele para cada rodada. O resultado, com data e **[V]**, entra na §10.

**Aceite:** todos os itens do critério de aceite da Fase 4 na §10.

## Decisões que surgem deste plano

As quatro que o plano levantou foram decididas pelo dono em 2026-11-17, por múltipla escolha, iguais às recomendações ([docs/13](13-DECISOES-EM-ABERTO.md)):
- **N93:** os downloads, com as versões exatas: `@anthropic-ai/sandbox-runtime` 0.0.81 (P4) e `playwright-core` 1.64.1 (P6);
- **N94:** a camada 3 no Windows continua portão. A Fase 4 fecha em Linux; no Windows, o daemon avisa que a camada 3 falta e segue o `security.unenforced`. A medição dos itens 9 e 12 da Fase 0 fica para quando houver uma máquina Windows;
- **N95:** a CI instala o `bwrap` e o `socat` por apt, libera os namespaces se o AppArmor barrar e baixa o Chromium do Playwright, e os testes de sandbox e de navegador rodam em todo PR;
- **N96:** o plano fica neste documento, com o marco interno 4a fechando no P5.

Ao abrir a primeira onda, o dono fixou os padrões dela, no mesmo dia:
- **N97:** a lista curada do `restricted_shell` (`tools.shell_allowlist.mode: list`), igual à recomendação;
- **N98:** os limites das cascas (10 min, 64 KiB, um comando pesado por vez), igual à recomendação;
- **N99:** o override da política do papel só abre o que é seguro, igual à recomendação;
- **N100:** o changelog sempre mantido na entrega (`delivery.changelog: always`), diferente da recomendação (`auto`).

As chaves novas dos outros passos (`sandbox.*`, `browser.*`) vão ao dono ao abrir o passo, como em "Como usar". As próximas decisões que surgirem também vão ao dono do mesmo jeito.
