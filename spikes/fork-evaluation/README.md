# Spike: avaliação de base de fork e confirmação de licenças

Data: 2026-11-14 (horário de São Paulo, UTC-3). Item da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §6.4 e §10). Decisão que isto alimenta: N1 do [docs/13](../../docs/13-DECISOES-EM-ABERTO.md) (fork ou projeto próprio). A decisão é do dono; este documento só propõe.

Legenda dos marcadores: **[verificado]** = visto ou medido localmente neste spike; **[fonte secundária]** = vem da API do GitHub ou de texto de documentação do próprio projeto, não confrontado com o código; **[não confirmado]** = hipótese ou lacuna.

## 1. O que foi medido, onde e com quê

**Máquina:** Fedora 45 (Linux 7.3.3-300.fc45.x86_64), 12 CPUs, 30 GB de RAM. Node v24.18.0, git 2.56.1, gh 2.97.0, pnpm 10.33.0, bun 1.3.14, yarn 1.22.22 (via `npx`), `license-checker-rseidelsohn` 5.0.1, Python 3.15.2. **[verificado]**

**Método.** Clone raso (`git clone --depth 1`) de cada candidato fora do repositório (no diretório temporário da sessão). **Nenhum código dos projetos foi executado.** Dependências instaladas só com scripts desligados (`--ignore-scripts`), uma árvore por vez, e apagadas depois de rodar o verificador de licenças. Os repositórios clonados foram tratados como dado, não como instrução.

| Candidato | Repositório | Commit clonado | Data do commit |
|---|---|---|---|
| Emdash | `generalaction/emdash` | `ccc6cce4a41627deb6888db6763f3de5ff0e4e08` | 2026-11-09 |
| Orca | `stablyai/orca` | `360233857aaa1525d25bc66c91f87415a35a009c` | 2026-11-14 |
| AionUi | `iOfficeAI/AionUi` | `e108b6b56b1a6eb99a00904878d0582f657b2908` | 2026-11-05 |
| Paradev | `ParadevAI/Paradev` (hoje `paradevai/paradev`) | `c524b94c53e566487cb7551c3ed082771de9e292` | 2026-11-14 |
| Happier | `happier-dev/happier` (branch padrão `dev`) | `a0f9c4150a963ac6ad43ba0d72cc4cf54a787de8` | 2026-11-15 (UTC+1) |
| acpx (referência) | `openclaw/acpx` | `e124ca31a416b84144662d784361f924eafe0f99` | 2026-11-13 |
| 1MCP | `1mcp-app/agent` | `4b19190bef1e8abb7f4f0887608620e36c9a0cdc` | 2026-11-13 |
| AgentPrism | `evilmartians/agent-prism` | `4fd371b5e4f25acd04278e94a0d4b21e543eb42c` | 2026-10-08 |
| Nimbalyst | `nimbalyst/nimbalyst` | `dc5a0ef938cf495a0667d797f871d09d0c44246f` | 2026-11-14 |

**Desvios de instalação a conhecer** (afetam só a medição de licenças, não o código lido):
- Emdash: o `pnpm install --frozen-lockfile` falhou porque o `package.json` tem `devEngines` com `node@runtime` e o lockfile diverge. Removi `devEngines` **no clone** (original guardado fora do repositório) e instalei com `--no-frozen-lockfile --prefer-frozen-lockfile`. **[verificado]**
- Orca: `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` (patchedDependencies; `packageManager` pnpm@12 contra pnpm 10 local). Mesmo remédio: `--no-frozen-lockfile --prefer-frozen-lockfile`. O `pnpm-lock.yaml` do clone foi alterado pela instalação. **[verificado]**
- Paradev: `bun install --frozen-lockfile` deu 5.590 pacotes e 1 falha (`@openai/codex@0.159.3-linux-x64`, EDQUOT, cota do diretório temporário). Esse pacote ficou sem verificação de licença. **[verificado]**
- Happier: a instalação completa (Expo, Tauri, site) estourou a cota de disco do diretório temporário. Medi uma **árvore reduzida**: o `package.json` raiz e os de `apps/cli`, `apps/server` e `packages/{agents,cli-common,connection-supervisor,release-runtime,privacy-kit,protocol,transfers,relay-server}`, com o `yarn.lock` original (não congelado, então `yarn` pode ter podado entradas). Ficaram de fora `apps/ui`, `apps/website`, `apps/docs`, `apps/stack`, `apps/bootstrap`, `packages/{audio-stream-native,sherpa-native,tests}`. **[verificado]**
- `--production` do verificador falhou nos monorepos pnpm (Emdash, Orca só parcialmente) e no Happier ("No packages found": a raiz não tem dependências de produção). Quando falhou, vale o número "todas" (inclui dependências de desenvolvimento, portanto mais conservador). **[verificado]**
- **Limite do verificador com bun:** nos clones de Paradev e AionUi, o `license-checker` **não enxergou** os pacotes opcionais de plataforma `@img/sharp-libvips-*`, que existem nos `bun.lock` (Paradev: `sharp@0.35.5`, libvips 1.3.4; AionUi: `sharp@0.34.5`, libvips 1.2.4). Cruzei com o lockfile (ver §3). **[verificado]**

Contagem de linhas: só `.ts`/`.tsx` fora de `node_modules`, sem `.d.ts`; "teste" = `*.test.*`, `*.spec.*` e pastas `test/`, `tests/`, `__tests__/`, `e2e/`. Não rodei os testes (regra: nunca executar código dos projetos), então "qualidade" abaixo é leitura de estrutura, não resultado de suíte. **[verificado]**

## 2. Tabela por candidato (critérios da §6.4)

Política usada: §6.0 (permitidas: MIT, Apache-2.0, ISC, BSD-2/3-Clause, 0BSD, MPL-2.0; GPL/AGPL/LGPL proibidas; o resto, caso a caso). "Caso a caso" nas árvores são, em geral, BlueOak-1.0.0, Unlicense, CC0-1.0, CC-BY-4.0 (dados do `caniuse-lite`), Python-2.0 (`argparse`), WTFPL, MIT-0 e OFL-1.1 (fontes). Resumo por árvore em `lic/` do diretório temporário (não copiado para o repositório; os números estão aqui).

### 2.1 Emdash (principal candidato)

| Critério | Resultado |
|---|---|
| 1. Licença | Projeto **Apache-2.0** (`LICENSE.md`, Copyright 2026 General Action, Inc.). Árvore (todas, 1.476 pacotes): 1.449 permitidas, **0 proibidas**, 27 caso a caso. Pontos a decidir: `elkjs@0.11.1` **EPL-2.0** (copyleft fraco); `@anthropic-ai/claude-agent-sdk@0.3.280` com licença "Custom" (termos próprios da Anthropic; texto **não lido** **[não confirmado]**); fontes OFL-1.1. Obrigação Apache-2.0 num fork: manter `LICENSE`, avisos e `NOTICE`, marcar arquivos alterados. **[verificado]** |
| 2. Núcleo como daemon com API | **Parcial.** O runtime ACP vive em `packages/core/src/runtimes/acp/node/` e o mesmo build roda como daemon em `apps/workspace-server` (comandos `serve/start/stop/status`, sockets e stdio, pasta `daemon/`). A API é um protocolo próprio ("wire", `packages/wire`), **não HTTP**. O controlador é o app Electron: o registro de workspaces e o banco ficam no desktop (`apps/emdash-desktop`, 184,9 mil linhas), e o workspace-server foi desenhado para hosts SSH remotos ("local workers remain owned by desktop runtime bootstrap", em `agents/architecture/workspace-server.md`). Rodar o workspace-server sozinho como serviço de logon **não foi testado** (regra de não executar). |
| 3. Encaixe da máquina de estados | **Ruim a médio.** Sem XState. Máquina própria de sessão (`machine/machine.ts`, 517 linhas, fases `starting/replaying/ready/working/cancelling/closed`) e `session/cell.ts` (786 linhas) por cima de uma "primitive machine". Nosso pipeline (§5.4, XState v5) ficaria ao lado, não por cima: o `ConversationHandle` e o `SessionManager` assumem a conversa como unidade. Persistência em SQLite com drizzle por runtime (`db:generate:*`), em vez do store único WAL da §7. |
| 4. Qualidade e testes | **Boa.** `packages/core`: 63,9 mil linhas de produção e 56,4 mil de teste; `plugins`: 18,6 mil / 12,6 mil; `wire`: 14,9 mil / 10,1 mil; `workspace-server`: 3,9 mil / 2,1 mil; desktop 184,9 mil / 130,1 mil. ADRs em `docs/adr/` (vistos 0001, 0002 e 0007), docs de arquitetura em `agents/architecture/` e verificação de fronteiras entre módulos (oxlint com allowlists). SDK ACP `@agentclientprotocol/sdk ^1.1.0` (a arquitetura prevê v2). Adaptadores `claude-agent-acp ^0.81.2` e `codex-acp ^1.13.1`. |
| 5. Ritmo upstream | **1.026 commits em 90 dias, 191 em 30** (API do GitHub, 2026-11-14). Última release `v1.2.11` (2026-11-06). 6.252 estrelas. **[fonte secundária]** |

### 2.2 Orca

| Critério | Resultado |
|---|---|
| 1. Licença | Projeto **MIT** (Copyright 2026 Lovecast Inc.). Árvore (1.220 pacotes): 1.196 permitidas, **0 proibidas**, 24 caso a caso, entre elas `@stablyai/playwright*` sem campo de licença (UNKNOWN), `oxlint-plugin-react-doctor` (arquivo LICENSE próprio) e o SDK da Anthropic "Custom". Os 4 "UNLICENSED" da árvore de produção são pacotes do próprio monorepo (`@orca/*`), não de terceiros. **[verificado]** |
| 2. Núcleo como daemon com API | **Sim, mas enorme.** Há `src/main/orcad` (daemon headless em Node puro, com lock de instância, preflight, migração) e `src/main/daemon` (daemon de terminais/PTY, 41,3 mil linhas de produção, com protocolo de propriedade do socket documentado em `src/main/daemon/AGENTS.md`). Mas o núcleo vive dentro de `src/main` do app Electron. |
| 3. Encaixe da máquina de estados | **Ruim.** Sem XState. Há orquestração própria com DAG de tarefas (`src/main/runtime/orchestration/coordinator/coordinator-dag-convergence.ts`) e CLI (`src/cli/orchestration`), que competem com o pipeline da §5.4. **Não implementa ACP via SDK:** `package.json` não depende de `@agentclientprotocol/sdk`; há implementação própria em `src/main/acp` (124 arquivos, 16,7 mil linhas). **[verificado]** |
| 4. Qualidade e testes | Muito testado em proporção (3,09 milhões de linhas de produção, 1,12 milhão de teste, 26,3 mil arquivos de produção). **Tamanho inviável de auditar**: só `src/main/runtime` tem 268,7 mil linhas. |
| 5. Ritmo upstream | **12.804 commits em 90 dias, 7.401 em 30.** Release `v1.4.259` em 2026-11-14. 125.077 estrelas. **[fonte secundária]**. O volume sugere automação ou agentes escrevendo código (hipótese, **[não confirmado]**); de todo modo um fork divergiria em dias. |

### 2.3 AionUi

| Critério | Resultado |
|---|---|
| 1. Licença | Projeto **Apache-2.0**. Árvore (1.563 pacotes, todas): 1.536 permitidas, 27 caso a caso, **0 proibidas pelo verificador**. Ressalvas: `@sentry/cli@2.58.5` **FSL-1.1-MIT** (ferramenta de build); `sharp@0.34.5` no `package.json` raiz e `@img/sharp-libvips-linux-x64@1.2.4` no `bun.lock` (**LGPL-3.0-or-later**, confirmado na licença do mesmo pacote e versão em outra árvore, §3). **A licença do AionCore (o núcleo) não foi verificada: não está no clone.** |
| 2. Núcleo como daemon com API | **Falha.** Segundo `docs/architecture/overview.md`, o AionUi tem três runtimes e o terceiro, `aioncore`, é um **binário HTTP em outro repositório** (`resources/bundled-aioncore/`, resolvido por `process/backend/binaryResolver.ts`), não presente no clone ("you will not find it in a fresh clone"). O repositório avaliado é interface + processo principal Electron. O `package.json` fixa a versão do AionCore (`v0.2.2`). **[verificado no repositório; o conteúdo do AionCore não foi avaliado]** |
| 3. Encaixe da máquina de estados | **Não avaliável** no que foi clonado; a orquestração líder/equipe citada no docs/12 está no backend externo. |
| 4. Qualidade e testes | Repositório todo: 163,9 mil linhas de produção e 122 mil de teste, mas `packages/desktop` tem 150,5 mil de produção contra **100 linhas de teste** (2 arquivos). `@agentclientprotocol/sdk ^0.18.2` (antiga). |
| 5. Ritmo upstream | **79 commits em 90 dias, 13 em 30.** Release `v2.2.2` em 2026-09-09. 34.279 estrelas. **[fonte secundária]** (o menor ritmo do grupo). |

### 2.4 Paradev

| Critério | Resultado |
|---|---|
| 1. Licença | Projeto **MIT** (Copyright 2025-2026 Superset Inc.; pacotes `@superset/*`). Existem `CLA.md` e `signatures/` (relevante se um dia contribuirmos de volta). Árvore (1.917 pacotes): 1.890 permitidas, 27 caso a caso, **0 proibidas pelo verificador**. Ressalvas: `(BSD-3-Clause OR GPL-2.0)` (escolhe-se BSD-3); `unionfs` "Public Domain"; `sharp@0.35.5` com libvips LGPL no lockfile (não visto pelo verificador, §3); `@openai/codex` linux-x64 sem verificar. |
| 2. Núcleo como daemon com API | **Melhor resposta do grupo, com ressalvas.** `packages/host-service` é um servidor Hono + tRPC (`@hono/node-server`, WebSocket) com `DaemonSupervisor`, singleton, versão esperada e auto-atualização (`src/daemon/`), 83,8 mil linhas de produção. O teste `src/no-electron-coupling.test.ts` falha se o código importar Electron. O próprio arquivo admite que `better-sqlite3`, `node-pty` e `@parcel/watcher` ainda esperam a resolução de módulos do Electron, então o modo headless não está resolvido. Acoplamento à nuvem: `JwtApiAuthProvider`, túnel/relay (`src/tunnel`), Sentry, dependência de `@superset/trpc` e módulos de sandbox. |
| 3. Encaixe da máquina de estados | **Médio.** Sem XState. ACP por `@superset/chat-runtime` (`createAcpAdapter`) em `packages/chat-runtime/src/harness/acp` e `packages/host-service/src/chat-v3` (adapters `claude-agent-acp 0.107.0` e `codex-acp 2.1.0`). Os fluxos de chat e de checkpoint git são específicos do produto. |
| 4. Qualidade e testes | Repositório: 901,7 mil linhas de produção e 286,3 mil de teste (tem app móvel, site, docs). `host-service`: 83,8 mil / 65,1 mil. `chat-runtime`: 14,3 mil / 17,7 mil. `pty-daemon`: 3,9 mil / 5,6 mil (ótima proporção). Há `no-main-loop-blocking.test.ts`. |
| 5. Ritmo upstream | **2.001 commits em 90 dias, 678 em 30.** Release `desktop-v2.0.8` em 2026-11-10. 16.303 estrelas. **[fonte secundária]** |

### 2.5 Happier

| Critério | Resultado |
|---|---|
| 1. Licença | Projeto **MIT** (`LICENCE`, "Happy Coder Contributors"; leva a crer que descende do projeto Happy, **[não confirmado]**). Árvore reduzida (952 pacotes, §1): 934 permitidas, **4 proibidas**, 14 caso a caso. **Bloqueio de licença: `@img/sharp-libvips-linux-x64` e `-linuxmusl-x64` (versões 1.2.4 e 1.3.4), LGPL-3.0-or-later**, binários de libvips trazidos por `sharp`, que é dependência **de produção** de `apps/cli` e `apps/server`. Outros: `@sentry/cli` FSL-1.1-MIT; `@anthropic-ai/claude-agent-sdk*` "Custom"; os 8 "UNLICENSED" são pacotes do próprio monorepo. **[verificado]** |
| 2. Núcleo como daemon com API | **Sim, mas ligado ao produto.** O CLI (`apps/cli`, 492,5 mil linhas de produção) contém um daemon em segundo plano com servidor HTTP local de controle (`src/daemon/controlServer.ts`, `controlClient.ts`, `ensureDaemon.ts`, serviço de logon em `src/daemon/service`). O desenho é "controle remoto de sessões" com servidor/relay e criptografia ponta a ponta (`apps/server`, `packages/relay-server`), que não queremos. |
| 3. Encaixe da máquina de estados | **Ruim.** Sem XState. ACP em `apps/cli/src/agent/acp/AcpBackend.ts`, **4.479 linhas num arquivo**, com dezenas de backends em `src/backends` (claude, codex, gemini, opencode, cursor, kimi, kiro, entre outros), cada um com extensões próprias. SDK `@agentclientprotocol/sdk ^1.2.1`. |
| 4. Qualidade e testes | Muitos testes, mais do que código no CLI (492,5 mil de produção, 774,2 mil de teste) e na interface (830,5 mil / 908,5 mil). Mas a base é imensa e a contagem de testes não mede cobertura. |
| 5. Ritmo upstream | **3.481 commits em 90 dias, 1.147 em 30** (branch `dev`). Release `ui-web-v0.2.21` em 2026-11-03. 2.211 estrelas. **[fonte secundária]** |

### 2.6 acpx (referência, não é candidato a fork)

Licença **MIT** (OpenClaw Team). Árvore (390 pacotes, todas): 379 permitidas, **0 proibidas**, 11 caso a caso, entre elas `elkjs@0.12.1` "EPL-2.0 OR GPL-3.0-or-later" (usa-se a EPL-2.0) e a árvore de produção (26 pacotes) toda permitida. Tamanho: 55,5 mil linhas de produção e 110,2 mil de teste (o dobro de teste), 396 commits em 90 dias, release `v0.22.0`. É um **cliente ACP headless** com sessões persistentes, fila e journal: muito mais próximo da camada de Executores (§5.2) que qualquer candidato. **[verificado, exceto commits e release: fonte secundária]**

## 3. Licenças da árvore de dependências: resumo e bloqueios

| Árvore | Pacotes | Permitidas | Proibidas | Caso a caso |
|---|---|---|---|---|
| Emdash | 1.476 | 1.449 | 0 | 27 |
| Orca | 1.220 | 1.196 | 0 | 24 |
| AionUi (produção: 970) | 1.563 | 1.536 | 0 (mas libvips no lockfile) | 27 |
| Paradev | 1.917 | 1.890 | 0 (mas libvips no lockfile) | 27 |
| Happier (árvore reduzida) | 952 | 934 | **4** | 14 |
| acpx | 390 | 379 | 0 | 11 |

**Bloqueio encontrado: LGPL-3.0-or-later nos binários de libvips (`@img/sharp-libvips-*`).** Confirmado pelo verificador no Happier. Para AionUi e Paradev, é o mesmo pacote em versões que também aparecem no Happier (1.2.4 e 1.3.4), citado nos `bun.lock`, mas **não visto pelo verificador**, então a licença nesses dois é por identidade de pacote e versão, não por leitura local. Emdash, Orca e acpx não usam `sharp`. Pela §6.0, LGPL em dependência empacotada reprova. É evitável (não depender de `sharp`, ou rever a regra para binários dinâmicos opcionais de plataforma); decisão do dono, **[proposta]**.

**Caso a caso a registrar, comuns a todos:** BlueOak-1.0.0 (família `isaacs`: `glob`, `minimatch`, `minipass`, `lru-cache`), Python-2.0 (`argparse`), CC-BY-4.0 (`caniuse-lite`), Unlicense, CC0-1.0, WTFPL, MIT-0. **Específicos:** EPL-2.0 (`elkjs`, Emdash, acpx), FSL-1.1-MIT (`@sentry/cli`, AionUi e Happier, só ferramenta de build), OFL-1.1 (fontes do Emdash), "Custom" do `@anthropic-ai/claude-agent-sdk` (Emdash, Orca, Happier; **o texto não foi lido**).

## 4. O que se aproveitaria de cada um (caminhos relativos ao clone)

Nível A da §6.0 (copiar ou adaptar). **Nada disso foi executado**; a leitura foi de código e docs.

**Emdash (Apache-2.0)**, o mais aproveitável:
- `packages/core/src/runtimes/acp/node/connection/acp-agent-connection.ts` (178 linhas): `initialize` com `fs` e `terminal`, leitura de `loadSession` e `mcpCapabilities`.
- `.../connection/source.ts`: cache de processos ACP com chave `provedor:cwd:env:sha256(env)`, que casa com o nosso "um adaptador por perfil" (§5.2).
- `.../runtime/mcp-servers.ts`, `.../session/cell.ts` e `.../machine/machine.ts` (como referência de sessão ACP, fila de prompts e permissões pendentes).
- `packages/plugins/src/agents/helpers/usage-probe.ts` e `impl/{claude,codex}/usage.ts` (sondas de cota, §5.6); `impl/{claude,codex,opencode}/` (`adapter.ts`, `auth.ts`, `trust.ts`, `hooks.ts`); `helpers/adapter-assets.ts`.
- `packages/core/src/runtimes/workspace-registry/node/{create-worktree,delete-worktree,worktree-path-safety}.ts` (worktrees, §5.5).
- Documentação: `agents/architecture/{acp-runtime,workspace-server,git-runtime,state-ownership}.md`, `docs/adr/` (0001, 0002, 0007).

**acpx (MIT):** `src/acp/client.ts` (2.871 linhas), `src/acp/process-descendants.ts` (árvore de processos do adaptador), `src/permissions.ts`, `src/agent-registry.ts`, `src/runtime/engine/*`, `src/session/{queue,journal,event-log,lock-owner,persistence}` (sessões, fila, retomada), mais a suíte de testes como modelo.

**Orca (MIT)**, só ideias e trechos pequenos, dado o tamanho **[leitura por nome de arquivo, não revisada a fundo]**: `src/main/{claude-accounts,codex-accounts,orca-profiles,rate-limits}` (várias contas e cotas, §5.6), `src/main/git/worktrees/*` (criação, remoção, limite de remoção), `src/main/daemon/AGENTS.md` (protocolo de propriedade do socket do daemon: `link` antes de `rename`, "não consegui provar" nunca vira "morto"), `src/main/runtime/orchestration/coordinator/coordinator-dag-convergence.ts`.

**Paradev (MIT)** **[leitura parcial]**: `packages/host-service/src/daemon/{DaemonSupervisor,singleton,manifest}.ts` (um daemon por usuário, versão esperada), `src/no-electron-coupling.test.ts` (ideia: teste que impede acoplar o daemon à interface), `packages/chat-runtime/src/harness/acp`, `packages/pty-daemon`.

**Happier (MIT, depois de resolver o LGPL):** `apps/cli/src/daemon/{controlServer,controlClient,ensureDaemon,pidSafety}.ts`, `apps/cli/src/scm/backends/git/operations/worktreeOperations.ts` (280 linhas). `AcpBackend.ts` (4.479 linhas) serve de catálogo de peculiaridades de adaptadores, não de código a copiar.

**AionUi (Apache-2.0):** nada em código, porque o núcleo é externo; só `docs/architecture/overview.md` como referência de desenho.

## 5. Confirmação de licenças pedida (1MCP, AgentPrism, Nimbalyst)

Verificadas em 2026-11-14 lendo o arquivo `LICENSE` do clone raso do repositório oficial no commit indicado, e conferidas com o campo de licença da API do GitHub. **[verificado]**

| Projeto | Repositório oficial | Licença | Arquivo | Observações |
|---|---|---|---|---|
| 1MCP | https://github.com/1mcp-app/agent | **Apache-2.0** | `LICENSE` (200 linhas) no commit `4b19190`; `package.json` também diz Apache-2.0 | Há um `LICENSE` aninhado em `test/conformance/official/fixtures/reference/` (fixture, não lido). |
| AgentPrism | https://github.com/evilmartians/agent-prism | **MIT** | `LICENSE` no commit `4fd371b` (Copyright 2025 Evil Martians e autores); `packages/types` e `packages/data` trazem MIT própria | A identificação do repositório é **inferência**: "AgentPrism" também nomeia outros repositórios sem relação (`agentprism/agentprism-workflows`, `StefanMaron/agentprism`, `AsymAlwali/agentprism`, `VikashLoomba/agentprism-ide`). Escolhi `evilmartians/agent-prism` ("React components for visualizing traces from AI agents") porque casa com "visualizador de trajetórias" do docs/12. **[não confirmado com o dono]** |
| Nimbalyst | https://github.com/nimbalyst/nimbalyst | **MIT** | `LICENSE` (Copyright 2024-2026 Nimbalyst Inc.) e `LICENSING.md` no commit `dc5a0ef` | `LICENSING.md` diz que o servidor de sincronização colaborativa (Cloudflare Worker de `wss://sync.nimbalyst.com`) é **projeto separado**, fora deste repositório e fora da licença MIT dele; dependências de terceiros têm licenças próprias. Trechos de temas e ícones trazem `LICENSE` próprios (não lidos). |

**Não feito:** a árvore de dependências desses três não foi verificada (não eram o foco); a chamada "sucessor do Crystal" do docs/12 para o Nimbalyst não foi confirmada.

## 6. Proposta de ADR: fork sim ou não (decisão do dono, N1)

**Proposta:** **não fazer fork.** Manter o padrão da N1 (projeto próprio) e reaproveitar trechos de nível A, nesta ordem: Emdash (Apache-2.0), acpx (MIT), depois ideias de Orca, Paradev e Happier.

**Motivos:**
1. **Nenhum candidato entrega o que a §5.1 e a §5.12 pedem**: daemon único por usuário, independente da interface, com API para TUI/web/desktop/Android. Emdash expõe o runtime por um "wire" próprio e o controlador é o Electron; Orca tem daemon, mas dentro de um app de 3 milhões de linhas; AionUi guarda o núcleo num repositório externo; Paradev é o mais próximo, porém preso à nuvem (JWT, túnel, sandbox, Sentry) e ainda dependente do módulo de resolução do Electron; Happier é um produto de controle remoto com relay e criptografia ponta a ponta.
2. **A máquina de estados da §5.4 não encaixa por cima**: nenhum usa XState, e todos têm máquinas próprias de sessão ou de DAG que ocupam o lugar do pipeline. Fork significa reescrever justamente a parte que nos diferencia.
3. **O SDK ACP está defasado em relação à arquitetura** (v1.x no Emdash, Paradev e Happier, 0.18 no AionUi; o Orca nem usa o SDK). A migração para v2 seria nossa em qualquer cenário.
4. **Peso e ritmo**: Orca (12.804 commits em 90 dias, 3 milhões de linhas) diverge em dias; AionUi quase parou (79 commits); os demais têm centenas de milhares de linhas de produto (interface, nuvem, móvel) que o OTheater não quer manter.
5. **Licença**: o único bloqueio objetivo (LGPL-3.0 via libvips/`sharp`) atinge Happier (confirmado) e, pelo lockfile, AionUi e Paradev; Emdash, Orca e acpx ficam limpos. O SDK da Anthropic com termos "Custom" (Emdash, Orca, Happier) precisa de leitura antes de qualquer cópia de arquivo que o importe. Fork de Apache-2.0 traria ainda obrigações de `NOTICE` e de marcar alterações, que a cópia de trechos também exige, mas em escala menor.

**Alternativa a registrar como opção B (se o dono quiser menos código novo):** **fork parcial do Emdash**, só `packages/core` (runtime ACP, worktrees), `packages/plugins` (adaptadores e sondas de cota), `packages/wire` e `apps/workspace-server`, cerca de 100 mil linhas de produção, descartando o desktop. Exigiria trocar a máquina de sessão, a persistência (drizzle por runtime pelo store único da §7) e o wire pela API HTTP da §5.12. É a única rota de fork que parece viável, mas **não foi validada na prática** (não executei o workspace-server nem rodei os testes do Emdash).

**O que mudaria a recomendação:** (a) o dono priorizar um primeiro protótipo rápido em vez de um núcleo limpo; (b) a leitura do texto "Custom" do SDK da Anthropic e a decisão sobre libvips mostrarem que as restrições de licença são menores do que a §6.0 supõe; (c) um spike que rode o `workspace-server` do Emdash como serviço headless no Linux e mostre que o wire é fino o bastante para trocar.

## 7. O que não foi possível verificar, e por quê

- **Execução**: nada foi executado (regra do dono); portanto não há medida de testes, tempo de subida, consumo de memória, nem confirmação de que o `workspace-server` do Emdash, o `host-service` do Paradev e o `orcad` do Orca rodam headless.
- **AionCore** (núcleo do AionUi): repositório e licença fora do escopo do clone.
- **Texto da licença "Custom" do SDK da Anthropic** (aparece como `Custom: README.md` ou `LICENSE.md` no verificador): não li; precisa de decisão caso a caso.
- **Árvores de dependência** de 1MCP, AgentPrism e Nimbalyst, e do `@openai/codex` linux-x64 no Paradev (falha de instalação por cota).
- **Happier**: árvore reduzida, sem `apps/ui` e sem os módulos nativos; pode haver outras licenças ali.
- **Libvips em Paradev e AionUi**: visto só no lockfile; o verificador não leu esses pacotes instalados com bun.
- **Ritmo**: números vindos da API do GitHub em 2026-11-14 (commits dos últimos 90 e 30 dias no branch padrão); a causa do volume do Orca é hipótese.
- Termos de uso dos provedores (Anthropic, OpenAI) não foram avaliados aqui.

## 8. Complemento: Claudexor (2026-11-15)

O Claudexor (`razzant/claudexor`, MIT) não entrou nesta avaliação. Ele foi avaliado depois, pelos mesmos critérios, em [claudexor.md](claudexor.md), junto com uma nota sobre o TeamClaude. Decisão do dono: N41 do [docs/13](../../docs/13-DECISOES-EM-ABERTO.md). O Claudexor vira referência e fonte de trechos nas áreas críticas, e continua sem fork.
