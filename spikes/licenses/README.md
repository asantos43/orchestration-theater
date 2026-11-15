# Spike: licenças (confirmação na fonte, termos dos executores e verificador)

Data: 2026-11-15 (horário de São Paulo, UTC-3). Item da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10, "Licenças", e §6.0). Decisões que isto alimenta: R9 e R1 da arquitetura, N23 e as licenças "caso a caso" do [docs/13](../../docs/13-DECISOES-EM-ABERTO.md). Não há chamadas a modelos neste spike.

Legenda: **[V]** verificado localmente (arquivo lido, comando rodado); **[S]** fonte secundária (página de documentação, API do GitHub, código lido e não executado); **[N]** não confirmado ou hipótese. Todo termo e licença cita URL e data da consulta (2026-11-15). Não interpreto além do texto: o que for ambíguo vira **[N]** e entra em "Decisões que o dono precisa tomar".

## 1. O que foi medido, onde e com quê

**Máquina:** Fedora 45 (Linux 7.3.3-300.fc45.x86_64), 12 CPUs, 30 GB de RAM. Node v24.18.0. npm do Node 24. `license-checker-rseidelsohn` 5.0.1 (BSD-3-Clause), `@npmcli/arborist` 9.6.0, `spdx-expression-parse` 4.0.0, `semver` 7.8.6.

**Método.**
- Clones rasos de 1MCP, AgentPrism e Nimbalyst na scratchpad. Nada do código deles foi executado.
- Árvore do Nimbalyst (§6.4): só metadados (`pnpm-lock.yaml`, `package.json`, `LICENSE`, 72 arquivos) e um GET de JSON por pacote ao registro npm. Sem `pnpm install`, sem tarball, sem script de instalação, sem código do repositório executado.
- `npm pack` dos seis pacotes do item 2, para ler o `LICENSE` que vai no tarball.
- Árvores instaladas com `npm install --ignore-scripts`, sempre fora do repositório (exceto as árvores dos spikes que já existiam).
- Páginas de termos baixadas com `curl` e lidas como texto.
- Nenhum login, nenhuma credencial lida, nenhum binário acima de 100 MB baixado. As plataformas nativas (centenas de MB) foram medidas só pelo `package-lock.json`.

**Resultado do verificador por árvore** (JSON completo em `out/`, ignorado pelo git).

## 2. Resultado por item

| Item | Resultado | Marca |
|---|---|---|
| 1a. 1MCP (`@1mcp/agent`) | **Apache-2.0**: permitida pela §6.0. Árvore de produção: 199 pacotes, todos permitidos | [V] |
| 1b. AgentPrism (Evil Martians) | **MIT** no repositório. Mas os pacotes npm `agent-prism-data` e `agent-prism-types` 1.0.0 **não têm campo `license`**; o verificador só infere MIT pelo arquivo. O pacote de UI não é publicado: o `readme` manda copiar os componentes | [V] |
| 1c. Nimbalyst | **MIT** (LICENSE da raiz, `package.json` da raiz e API do GitHub). `LICENSING.md` diz que o servidor de sincronização é projeto separado e que as dependências de terceiros têm licença própria. Árvore medida na §6.4 (commit `dc5a0ef`): 1825 pacotes (1252 produção, 573 dev), **15 proibidas e 14 sem decisão em produção**, verificador sai com 1. É referência, não dependência | [V] a raiz; [S] a árvore (licença do registro) |
| 1d. Outros [a confirmar] de licença | croner **MIT**, dependency-cruiser **MIT** (dev). `wl-paste` (pacote `wl-clipboard` 2.3.0) é **GPL-3.0-or-later** (rpm local). `xclip` **não está instalado**, licença não confirmada. **Divergência com a §6.1:** o MCP SDK v2 (`@modelcontextprotocol/server` e `client` 2.4.0) é **Apache-2.0**, não MIT | [V] / xclip [N] |
| 2. Licenças e termos dos seis pacotes | Quatro são abertos (Apache-2.0 ou MIT). `@anthropic-ai/claude-agent-sdk` é "todos os direitos reservados", com uso regido pelos Termos Comerciais. Redistribuir o SDK dentro de um SEA **não tem permissão nem proibição no texto**: ambíguo (D1, D2) | [V] licenças; [S] termos |
| 3. `check.mjs` + `policy.json` | Feitos. 16 testes sintéticos passam (`node test.mjs`), mais 4 do adaptador pnpm (`node test-pnpm.mjs`). Sai com código 1 em licença proibida, sem decisão ou ferramenta de nível C empacotada. As decisões da N45 (2026-11-15) estão em `policy.json` | [V] |
| 4a. Árvore da stack da §8 | **Núcleo (192 pacotes): aprovado. Fases posteriores (138): aprovado.** Executores (154, só lockfile): 22 sem decisão, 0 proibidas | [V] |
| 4b. Árvores dos spikes já instaladas | **2 proibidas** (`@opentui/core-linux-x64` e `-musl`, `MIT AND LGPL-2.1-or-later`). 10 sem decisão nas árvores com `claude-agent-acp`. 1 alerta de arquivo LGPL no `@openai/codex` | [V] |

## 3. Item 1: confirmação na fonte

| Pacote ou projeto | Licença | Arquivo na fonte | `npm view <pkg> license` | Árvore de produção | Situação perante a §6.0 |
|---|---|---|---|---|---|
| 1MCP `@1mcp/agent` 0.39.9 | Apache-2.0 | `LICENSE` em `github.com/1mcp-app/agent`, commit `4b19190bef1e8abb7f4f0887608620e36c9a0cdc` (2026-11-13); API do GitHub: `Apache-2.0` | `Apache-2.0` | 199 pacotes: 199 permitidos | Permitida (nível B). Obrigação Apache-2.0: LICENSE e NOTICE no `THIRD_PARTY_NOTICES` |
| AgentPrism (repo) | MIT | `LICENSE` em `github.com/evilmartians/agent-prism`, commit `4fd371b5e4f25acd04278e94a0d4b21e543eb42c` (2026-10-08); API: `MIT` | `@evilmartians/agent-prism-data` e `-types` 1.0.0: **vazio**. `-ui`: 404, não existe no npm | `data` + `types` + dependências do `readme`: 31 pacotes, 29 permitidos, **2 sem decisão** (`data` e `types`, sem campo `license`, lidos como "MIT*") | Repo permitida. Pacotes npm: **sem decisão** até haver exceção (D7). Copiar a UI = nível A, MIT exige manter o aviso de copyright |
| Nimbalyst | MIT | `LICENSE` em `github.com/nimbalyst/nimbalyst`, commit `dc5a0ef938cf495a0667d797f871d09d0c44246f` (2026-11-14); API: `MIT` | (raiz privada, não publicada) | 1825 pacotes (1252 produção + 573 dev): 1197 permitidas, 18 decididas, **14 sem decisão**, **15 proibidas**, 8 nível C empacotado (produção) | Permitida para a raiz. Árvore: **reprovada** pelo verificador (§6.4); só os pacotes de terceiros, e licença do registro [S] |
| croner 11.0.1 | MIT | — | `MIT` | dentro do núcleo | Permitida |
| dependency-cruiser 18.7.2 | MIT | — | `MIT` | dev | Permitida (nível D) |
| MCP SDK v2 `server`/`client` 2.4.0 | **Apache-2.0** | `LICENSE` instalado | `Apache-2.0` (o `@modelcontextprotocol/sdk` 1.32.2, antigo, é MIT) | dentro do núcleo | Permitida. **A §6.1 diz MIT: corrigir.** A API do GitHub devolve `NOASSERTION` para o repositório (transição de licença) **[S]** |
| `wl-paste` (`wl-clipboard` 2.3.0) | GPL-3.0-or-later (`rpm -q`) | — | — | processo externo | Nível C (D10) |
| `xclip` | **não confirmada** | não instalado nesta máquina | — | processo externo | [N] |

Fontes: arquivos `LICENSE` lidos nos clones; `https://api.github.com/repos/<dono>/<repo>/license` e `npm view`, em 2026-11-15. A API do GitHub é fonte [S]; o arquivo lido no clone é [V].

## 4. Item 2: os seis pacotes e os termos

Versões lidas em 2026-11-15 (`npm view` e `npm pack`).

| Pacote | Versão | Licença declarada | `LICENSE` no tarball |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.325 | `SEE LICENSE IN README.md` | `LICENSE.md`: uma linha só. Diz que os direitos são reservados pela Anthropic PBC e que o uso segue os acordos legais da página `code.claude.com/docs/en/legal-and-compliance`. O `README.md` do pacote **não** tem seção de licença; só remete aos Termos Comerciais (privacidade) |
| `@agentclientprotocol/claude-agent-acp` | 0.107.0 | Apache-2.0 | Sim (Apache-2.0). Sem `NOTICE` |
| `@agentclientprotocol/codex-acp` | 2.6.0 | Apache-2.0 | Sim (Apache-2.0). Sem `NOTICE` |
| `@agentclientprotocol/sdk` | 2.7.0 | Apache-2.0 | Sim (Apache-2.0) |
| `@openai/codex` | 0.169.0 | Apache-2.0 | **Não vem no tarball** (só `bin/`, `package.json`, `README.md`). O repositório tem `LICENSE` Apache-2.0 e `NOTICE` (Ratatui, MIT) em `raw.githubusercontent.com/openai/codex/main/` (2026-11-15) |
| `opencode-ai` | 1.19.5 | MIT | Sim (MIT, "Copyright (c) 2025 opencode"). Os pacotes de plataforma `opencode-<os>-<cpu>` **não têm campo `license` nem `LICENSE`** no tarball (só `package.json` e `bin/opencode`) |

Dependências que mudam o quadro, vistas na árvore instalada:
- `claude-agent-acp` depende de `@anthropic-ai/claude-agent-sdk`, que é proprietário, e traz um pacote de plataforma de cerca de 365 MB (`@anthropic-ai/claude-agent-sdk-linux-x64`, `LICENSE.md` com a mesma frase) **[V]**.
- `@openai/codex-linux-x64` (declarado Apache-2.0) traz `vendor/.../codex-resources/voice/` com bibliotecas GLib e GStreamer **dinâmicas** sob **LGPL-2.1**, mais `bwrap`. O `NOTICE.md` do pacote diz isso e aponta o texto em `licenses/LGPL-2.1.txt` **[V]**.

### 4.1 Termos da Anthropic (o que o texto diz)

Fontes lidas em 2026-11-15:
- `https://code.claude.com/docs/en/legal-and-compliance` ("Legal and compliance")
- `https://code.claude.com/docs/en/agent-sdk/overview` (seção "License and terms")
- `https://www.anthropic.com/legal/commercial-terms` (vigência 17 jun 2025)
- `https://www.anthropic.com/legal/consumer-terms` (vigência 8 out 2025)

Todas **[S]** (texto de página, não contrato assinado).

- **Qual contrato vale.** Claude Code: Termos Comerciais para Team, Enterprise e API; Termos de Consumidor para Free, Pro, Max e Ultra. O Agent SDK é regido pelos Termos Comerciais, também quando alimenta produtos oferecidos a clientes e usuários finais, salvo componente ou dependência com outra licença indicada no `LICENSE` dele.
- **Binário do Claude Code.** Quem pré-instala ou executa o Claude Code em seu produto precisa aceitar os Termos Comerciais e cumprir duas condições: o binário **não pode ser modificado** (nem se pode remover ou restringir métodos de login) e o cliente **não pode pagar, revender ou intermediar o uso** por seus usuários finais; cada usuário se autentica com a própria chave, assinatura ou provedor.
- **Autenticação.** OAuth é "exclusivamente para compradores" dos planos e para uso comum. Quem constrói produtos, "inclusive com o Agent SDK", deve usar chave de API. A Anthropic "não permite" que terceiros ofereçam login claude.ai nem roteiem requisições pelas credenciais de planos em nome dos usuários. Desenvolvedores não podem coletar, guardar ou intermediar credenciais ou tokens de sessão do claude.ai. O texto do SDK acrescenta "salvo aprovação prévia".
- **Limites dos planos.** Os limites anunciados de Pro, Max e Ultra "assumem uso comum e individual" do Claude Code e do Agent SDK.
- **Consumidor.** Não se compartilha login, chave de API ou credencial da conta; não se acessa o serviço por "bot, script ou outro meio automatizado", **salvo por chave de API ou onde a Anthropic permitir de forma explícita**.
- **Comercial, D.4.** O cliente não pode usar o serviço para construir produto concorrente (inclusive treinar modelos), nem revender o serviço sem aprovação, nem fazer engenharia reversa.
- **Marca.** Pode-se dizer em texto simples que o produto roda o Claude Code. Não se usa "Claude Code" nem "Anthropic" no nome do produto, em logo, ou de modo que sugira parceria. O texto do SDK pede que o produto "mantenha a própria marca".

### 4.2 Termos da OpenAI e do OpenCode

- **OpenAI.** As páginas `openai.com/policies/terms-of-use` e `help.openai.com/.../codex-in-chatgpt` devolveram **HTTP 403** ao `curl` em 2026-11-15. **Os termos da OpenAI não foram lidos [N].** Li só `https://developers.openai.com/codex/auth` **[S]**: chave de API é a recomendação para automação e CI; o login com ChatGPT é o fluxo interativo; tokens de acesso de workspace são para "scripts de confiança, agendadores e runners de CI privados" em ChatGPT Enterprise. O `README` do pacote diz que o repositório é Apache-2.0.
- **OpenCode.** Licença MIT (`LICENSE` do tarball e `raw.githubusercontent.com/sst/opencode/dev/LICENSE`, 2026-11-15). A página `https://opencode.ai/docs/providers/` (2026-11-15) lista o login com plano ChatGPT Plus/Pro e uma assinatura própria ("OpenCode Go"). Procurei "Claude Pro" e "Claude Max" no texto da página e **não achei** **[V]** o termo. A página não trata de termos de uso dos provedores **[S]**.

### 4.3 O que é permitido e proibido, só pelo texto

| Pacote | Como dependência | Dentro de um executável Node SEA | Uso pessoal x produto distribuído |
|---|---|---|---|
| `claude-agent-acp`, `codex-acp`, `acp/sdk` (Apache-2.0) | Permitido: usar, copiar, modificar, distribuir | Permitido, com cópia da licença, `NOTICE` se houver, e marca nos arquivos modificados. Concessão de patente incluída | Sem diferença na licença |
| `@openai/codex` (Apache-2.0) | Permitido | Código permitido. **O pacote de plataforma traz bibliotecas LGPL-2.1** (voz), proibidas pela §6.0 se empacotadas (nível B) **[V]** | Sem diferença na licença. Termos de uso da OpenAI não lidos [N] |
| `opencode-ai` (MIT) | Permitido | Permitido com o aviso de copyright. Pacotes de plataforma sem licença declarada: ver D4 | Sem diferença na licença |
| `@anthropic-ai/claude-agent-sdk` (proprietário) | O texto manda usar os Termos Comerciais. **Nada diz que se pode ou não usar como dependência npm**; o uso é o propósito do pacote | **O texto não concede nem proíbe a redistribuição.** Só consta que o binário do Claude Code "deve ser instalado e executado como publicado" e que não pode ser modificado. **Ambíguo [N]** (D1) | Uso pessoal: a assinatura é para "uso comum e individual". Produto: "desenvolvedores... devem usar chave de API". Orquestrador pessoal com várias contas: **ambíguo [N]** (D2, é o R1 da arquitetura) |

## 5. Item 3: o verificador

`check.mjs` lê a árvore, aplica a política de `policy.json` (dados, não código) e sai com **1** se achar licença proibida ou fora da lista sem decisão. Protótipo da automação de licenças da Fase 1.

- **Motor:** `license-checker-rseidelsohn` lê as licenças instaladas; `@npmcli/arborist` monta o grafo e dá o caminho mais curto de quem trouxe cada pacote.
- **SPDX:** `OR` vale o melhor ramo (o consumidor escolhe). `AND` vale o pior. Lista de licenças em um pacote vale como `OR`. Era uma leitura minha (D9); o dono a confirmou em 2026-11-15 (N45).
- **Desconhecidas:** `UNKNOWN`, `Custom`, `SEE LICENSE IN` e expressão inválida são "sem decisão". Licença inferida pelo verificador (marca `*`, sem campo `license` no pacote) também reprova por padrão (`--palpite=aviso` desliga).
- **Escopo:** produção (padrão) ou `--tudo` (inclui dev). Dev só importa no nível D.
- **Modo `--so-lockfile`:** lê o `license` do `package-lock.json`. Dá a árvore de plataformas que não foram instaladas, sem baixar binários.
- **Adaptador pnpm (`lockfile-pnpm.mjs`):** converte um `pnpm-lock.yaml` (v9) em um `package-lock.json` sintético e a licença vem do registro npm (GET de JSON com cache). O `check.mjs` não mudou; roda com `--so-lockfile`. Detalhes na §6.4.
- **Alerta de arquivo copyleft:** pacote que declara licença permitida mas leva `LGPL-*.txt`, `GPL*` ou `COPYING.LESSER` dentro. É o caso do `@openai/codex`. Vira falha com `--alertas=falha`.
- **Decisões:** só entram em `policy.json` decisões registradas pelo dono. Desde 2026-11-15 (N45) ele tem as oito licenças da D6 (`decisoesPorLicenca`), a exceção do AgentPrism (`excecoes`, por pacote e versão) e os executores (`ferramentasExternas`). Uma exceção pode exigir o texto exato da licença; sem esse campo, vale para qualquer leitura. Nunca libera licença proibida, a menos que diga `permiteProibida: true`.
- **Nível C (`--nivel-c=falha|instalacao`):** os pacotes de `ferramentasExternas` são programas que o usuário instala e que rodam em processo separado.
  - `falha` (padrão): se aparecem na árvore de produção, reprovam como `nivel-c-empacotada`, porque o executável do OTheater não pode carregá-los.
  - `instalacao`: a pasta é uma lista de ferramentas externas (`stacks/executors`, spikes de ACP). A ferramenta e o que **só ela** traz ficam `nivel-c` e não reprovam. O que a raiz também traz por outro caminho continua verificado.
- **Propostas:** `proposals.json` guardou o que eu propus para a D6, e só vale com `--com-propostas`. As oito foram aceitas e estão em `policy.json`; o arquivo fica como histórico.
- **Códigos de saída:** 0 aprovado; 1 reprovado; 2 erro de uso ou execução.

Limites **[V]**: o `license-checker` não enxerga pacotes opcionais de plataforma que não foram instalados; o modo `--so-lockfile` cobre esse caso. O campo `license` do lockfile é o do registro; não confere o arquivo de licença dentro do tarball.

## 6. Item 4: resultados por árvore

### 6.1 Árvore da stack (§6.1 e §8), pacotes exatos, sem uso

Manifestos em `stacks/<nome>/` (versões exatas e `package-lock.json`). `npm install --ignore-scripts` em `core` e `later`; `executors` só `--package-lock-only`.

| Árvore | Pacotes (produção) | Permitidas | Sem decisão | Proibidas |
|---|---|---|---|---|
| `core` (daemon, TUI, cliente: ACP SDK, MCP SDK v2, Hono, Ink, better-sqlite3, Kysely, pino, OTel, XState, zod, croner, execa, sandbox-runtime, keyring, ccusage, playwright-core) | 192 | 192 | 0 | 0 |
| `later` (web, Electron, Android, painéis: assistant-ui, CodeMirror, Monaco, xterm, xyflow, TanStack, Capacitor, node-pty; dev: Electron, electron-builder, Vite) | 138 | 138 | 0 | 0 |
| `executors` (os quatro adaptadores e clientes; só lockfile) | 154 | 132 | 22 | 0 |

- `core --tudo` (321 pacotes): 1 sem decisão, `graceful-fs@4.2.12` (**BlueOak-1.0.0**, dev), via `dependency-cruiser`.
- `later --tudo`: 11 sem decisão, 0 proibidas, **todas dev**: 9 entradas **BlueOak-1.0.0** (8 nomes: `chownr`, `graceful-fs`, `isexe` em duas versões, `minimatch`, `minipass`, `sax`, `tar`, `yallist`), `argparse` **Python-2.0**, `truncate-utf8-bytes` **WTFPL**; vêm de `electron-builder` e `electron`.
- Expressões `OR` no núcleo e em fases posteriores: `node-forge@1.4.3` `(BSD-3-Clause OR GPL-2.0)` (via `@anthropic-ai/sandbox-runtime`), `type-fest@5.10.0` `(MIT OR CC0-1.0)` (via `ink`), `dompurify@3.4.15` `(MPL-2.0 OR Apache-2.0)` (via `monaco-editor`). Passam pela regra "OR = melhor ramo" (D9).
- Núcleo: 37 pacotes Apache-2.0. Cada um com `NOTICE` precisa entrar no `THIRD_PARTY_NOTICES`. `playwright-core` traz `NOTICE` **[V]**.
- `executors`: 22 sem decisão, todos de três famílias:
  - `@anthropic-ai/claude-agent-sdk` e **8 pacotes de plataforma** (`SEE LICENSE IN ...`), via `claude-agent-acp` (D1);
  - `fast-sha256@1.3.0` (**Unlicense**), via `claude-agent-acp > ... > @anthropic-ai/sdk > standardwebhooks`;
  - **12 pacotes `opencode-<plataforma>`** sem campo `license` (D4), via `opencode-ai`.

### 6.2 Árvores dos spikes já instaladas (`spikes/*/node_modules`)

Medição de antes das decisões (política vazia). Para o resultado depois da N45, veja a seção 6.3. Produção, modo instalado. Sem `node_modules` (não medidos): `tui-bench`, `tui-keys`.

| Spike | Pacotes | Situação |
|---|---|---|
| `acp-handoff` | 4 | aprovado |
| `acp-opencode` | 116 | aprovado |
| `local-model` | 116 | aprovado |
| `quota-probes` | 25 | aprovado |
| `tui-ink`, `tui-mockup-ink` | 47 cada | aprovado (também com `--tudo`: 99) |
| `acp-codex` | 116 | aprovado, com **1 alerta**: `@openai/codex@0.166.0-linux-x64` leva `LGPL-2.1.txt` |
| `acp-claude` | 136 | **10 sem decisão**: o SDK, 8 pacotes de plataforma (o `linux-x64` instalado e 7 só no lockfile) e `fast-sha256` |
| `otel`, `quota-exhaustion` | 157 e 135 | os mesmos **10 sem decisão** do `acp-claude`, mais o alerta LGPL do codex |
| `tui-opentui` | 21 | **2 PROIBIDAS** (abaixo) |
| `licenses` (este spike, `--tudo`) | 130 | 15 sem decisão (`BlueOak-1.0.0` de `glob`, `lru-cache`, `minimatch` etc.; `CC-BY-3.0` de `spdx-exceptions` e `spdx-ranges`). Passam com `--com-propostas`. São ferramentas de verificação (nível D) |

**Proibidas ou fora da lista, com quem trouxe:**

| Pacote | Licença | Trazido por | Observação |
|---|---|---|---|
| `@opentui/core-linux-x64@0.9.0` | `MIT AND LGPL-2.1-or-later` | `tui-opentui` > `@opentui/core@0.9.0` | O `.so` linka FFmpeg estaticamente. Arquivos `LICENSE-FFMPEG` (LGPL-2.1) e `FFMPEG-SOURCE.md` no pacote **[V]** |
| `@opentui/core-linux-x64-musl@0.9.0` | `MIT AND LGPL-2.1-or-later` | idem | idem |
| `@anthropic-ai/claude-agent-sdk@0.3.323` e 8 pacotes de plataforma | proprietária (`SEE LICENSE IN`) | `acp-claude`, `otel`, `quota-exhaustion` > `@agentclientprotocol/claude-agent-acp@0.107.0` | A árvore dos spikes está em 0.3.323; o `npm view` hoje mostra 0.3.325 |
| `fast-sha256@1.3.0` | Unlicense | `claude-agent-acp > @anthropic-ai/claude-agent-sdk > @anthropic-ai/sdk@1.8.0 > standardwebhooks` | |
| `@openai/codex@0.166.0-linux-x64` | Apache-2.0 declarada, com **LGPL-2.1** dentro | `codex-acp > @openai/codex` | Alerta, não falha |

O OpenTUI já está fora do produto (a TUI é Ink, decidido em 2026-11-15, item 11 da §12). O verificador pegou o caso sem ajuda, como esperado. Esse código é descartável (spike), mas fica registrado.

### 6.3 Depois das decisões da N45 (2026-11-15) **[V]**

Rodado de novo com `policy.json` preenchido:

| Árvore | `--nivel-c=falha` (padrão) | `--nivel-c=instalacao` |
|---|---|---|
| `stacks/core --tudo --so-lockfile` | aprovado (320 permitidas, 1 decidida: `graceful-fs`, BlueOak) | igual |
| `stacks/later --tudo --so-lockfile` | aprovado (436 permitidas, 11 decididas) | igual |
| `stacks/executors --so-lockfile` | reprovado: 18 de nível C empacotados e 20 sem decisão | **aprovado**: os 154 são nível C |
| `licenses --tudo` (este spike) | aprovado (115 permitidas, 15 decididas) | igual |
| `acp-claude` | reprovado: 2 de nível C e 8 pacotes de plataforma do SDK | **aprovado**: 116 permitidas, 20 nível C |
| `acp-codex` | reprovado: 8 de nível C | **aprovado**: 93 permitidas, 23 nível C |
| `otel`, `quota-exhaustion` | reprovados: 10 de nível C e 8 sem decisão | **aprovados** (132 e 133 nível C) |
| `tui-ink`, `tui-mockup-ink` | aprovados | igual |
| `tui-opentui` | **2 proibidas** (LGPL do FFmpeg) | igual: nível C não libera dependência empacotada |

Os spikes de ACP reprovam no modo padrão, e isso é o certo: eles instalam o adaptador como dependência. No produto, o adaptador fica fora do executável. O `fast-sha256` (Unlicense) agora é "decidida" no modo padrão, e "nível C" no modo instalação.

### 6.4 Árvore do Nimbalyst (monorepo pnpm), commit `dc5a0ef938cf495a0667d797f871d09d0c44246f`

Medida em 2026-11-15, com o `policy.json` como está (N45), sem mudar política. É referência, não dependência.

**Método.**
- Baixei só `pnpm-lock.yaml` (lockfileVersion 9.0), os `package.json` do monorepo e o `LICENSE` (72 arquivos), em pasta nova da scratchpad (`<tmpdir>/licenses/nimbalyst`). Nada foi instalado nem executado. [V]
- `lockfile-pnpm.mjs` lê o YAML (parser mínimo próprio, sem dependência), calcula o alcance exato a partir dos importers e busca a licença de cada `nome@versão` no registro npm (1825 GET de JSON, com cache, concorrência 4, UA genérico). Gera `package.json`, `package-lock.json` sintético e `analise.json` em `out/nimbalyst-lock/`. [V]
- Cada importer vira um nó sintético privado (`ws-<id>` para produção, `wsdev-<id>` para dev; 112 ao todo, ignorados pelo verificador). Cada `nome@versão` aparece em um lugar só, porque o verificador classifica prod/dev pela primeira cópia. Com isso o `check.mjs` bateu com o alcance exato: **1252 produção + 573 dev**. [V]
- O documento extra do `pnpm-lock.yaml` (ambiente do próprio pnpm 11, 15 pacotes) foi ignorado. [V]
- Os `package.json` do monorepo não declaram `license` (a maioria `null`); o `LICENSE` da raiz é MIT. [V]

```bash
node lockfile-pnpm.mjs --lock <pnpm-lock.yaml> --out out/nimbalyst-lock --cache <tmpdir>/licenses/cache-npm
node check.mjs --dir out/nimbalyst-lock --so-lockfile            # produção
node check.mjs --dir out/nimbalyst-lock --so-lockfile --tudo     # produção + dev
```

**Totais [S: licença do registro].**

| Escopo | Pacotes | Permitidas | Decididas | Sem decisão | Proibidas | Nível C empacotado | Saída |
|---|---|---|---|---|---|---|---|
| Produção | 1252 | 1197 | 18 | 14 | 15 | 8 | **1** |
| Produção + dev (`--tudo`) | 1825 | 1748 | 26 | 14 | 29 | 8 | **1** |

- 56 importers; 0 pacotes sem metadado no registro. 3 variantes de peers divergem (`postcss-load-config@6.0.1` e `vite@7.3.6` com `jiti` 1.21.7 ou 2.7.0; `vitest@4.1.11` com `jsdom` 26.1.0 ou 27.4.0): a fusão é por união e só pode aumentar o alcance, mas o alcance exato calculado à parte é idêntico. [V]
- Licenças em produção (contagem do verificador): MIT 988, ISC 73, BSD-3-Clause 67, Apache-2.0 61, BlueOak-1.0.0 12, LGPL-3.0-or-later 10, `SEE LICENSE IN LICENSE.md` 8, BSD-2-Clause 8, `Apache-2.0 AND LGPL-3.0-or-later` 3, UNKNOWN 2, Unlicense 2, CC0-1.0 2, `(MIT AND Zlib)` 2, `(MIT OR CC0-1.0)` 2, e 1 cada de `SEE LICENSE IN README.md`, `MIT OR Apache-2.0`, `Apache-2.0 AND LGPL-3.0-or-later AND MIT`, Python-2.0, CC-BY-4.0, `(MPL-2.0 OR Apache-2.0)`, EPL-2.0, `(MIT OR GPL-3.0-or-later)`, LGPL-3.0, `SEE LICENSE IN LICENSE`, 0BSD, `MIT AND ISC`. Com `--tudo` (1825): MIT 1437, Apache-2.0 108, ISC 98, BSD-3-Clause 76, BSD-2-Clause 23, LGPL-3.0-or-later 20, BlueOak-1.0.0 14, e a cauda longa em `out/nimbalyst.tudo.txt`.

**Proibidas em produção (15).** Todas LGPL; o caminho de entrada é `ws-packages--electron` (o pacote Electron do monorepo).

| Pacote@versão | Licença | Escopo | Caminho de entrada |
|---|---|---|---|
| `@img/sharp-libvips-<plataforma>@1.2.4` (10: darwin-arm64, darwin-x64, linux-arm64, linux-arm, linux-ppc64, linux-riscv64, linux-s390x, linux-x64, linuxmusl-arm64, linuxmusl-x64) | LGPL-3.0-or-later | produção | electron > `@huggingface/transformers@3.8.1` > `sharp@0.34.5` > pacote |
| `@img/sharp-wasm32@0.34.5` | Apache-2.0 AND LGPL-3.0-or-later AND MIT | produção | idem |
| `@img/sharp-win32-arm64`, `-ia32`, `-x64` `@0.34.5` (3) | Apache-2.0 AND LGPL-3.0-or-later | produção | idem |
| `libheif-js@1.19.8` | LGPL-3.0 | produção | electron (dependência direta) |

O `license-approvals.json` do Nimbalyst aprova o `libheif-js` **[V]**; isso é decisão deles, não minha nem do OTheater. Só em dev há mais 14 proibidas (`@img/sharp-libvips-*@1.3.1` x10, `@img/sharp-wasm32@0.35.2` e `@img/sharp-win32-arm64/ia32/x64@0.35.2`), por `wsdev-packages--marketplace` > `wrangler@4.125.0` > `miniflare@5.20260820.0-alpha` > `sharp@0.35.2`.

**Sem decisão em produção (14).**

| Pacote@versão | Licença | Escopo | Caminho de entrada |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk-<plataforma>@0.3.321` (8) | `SEE LICENSE IN LICENSE.md` | produção | electron > `@anthropic-ai/claude-agent-sdk@0.3.321` > pacote (mesmo caso da D1) |
| `elkjs@0.11.1` | EPL-2.0 | produção | `ws-packages--extensions--datamodellm` (o Nimbalyst a aprova) |
| `exif-parser@0.1.12` | UNKNOWN | produção | electron > `jimp@1.6.1` > `@jimp/core@1.6.1` |
| `khroma@2.1.0` | UNKNOWN | produção | electron > `mermaid@11.17.2` |
| `pako@1.0.11` | MIT AND Zlib | produção | `ws-packages--extensions--playwright` > `jszip@3.10.1` |
| `pako@2.0.3` | MIT AND Zlib | produção | electron > `@excalidraw/excalidraw@0.18.1` |
| `posthog-js@1.380.0` | `SEE LICENSE IN LICENSE` | produção | electron (dependência direta) |

Em dev não há nenhuma sem decisão.

**Outros achados.**
- Nível C empacotado (8): `@anthropic-ai/claude-agent-sdk@0.3.321` e `@openai/codex@0.167.0` com 6 pacotes de plataforma, via electron > `@openai/codex-sdk@0.167.0`. A política os trata como ferramentas externas (N45); aqui estão empacotados, então o verificador reprova.
- Passam por `OR` (melhor ramo): `jszip@3.10.1` (`MIT OR GPL-3.0-or-later`), `dompurify@3.4.14` (`MPL-2.0 OR Apache-2.0`, via `monaco-editor`), `type-fest` (`MIT OR CC0-1.0`).
- Decididas em produção (18): BlueOak-1.0.0 x12, Unlicense x2, CC0-1.0 x2, Python-2.0, CC-BY-4.0. Em dev (8): MIT-0 x3, CC0-1.0 x2, BlueOak-1.0.0 x2, WTFPL.

**Limites.**
- A licença é o campo `license` do registro [S]; não li o arquivo de licença dentro dos tarballs. Os `UNKNOWN` e `SEE LICENSE IN` acima só se resolvem lendo o arquivo [N].
- O lockfile tem o SDK do Claude na 0.3.321; a §6.2 cita 0.3.323/0.3.325 (outra árvore). Não é contradição.
- O pacote sintético raiz se chama `nimbalyst-medicao`; aparece como `(raiz)` nos caminhos.
- Saídas em `out/nimbalyst.{prod,tudo}.{json,txt}` e `out/nimbalyst-lock/` (ignoradas pelo git).

## 7. Decisões do dono

Decididas em 2026-11-15, registradas na N45 do [docs/13](../../docs/13-DECISOES-EM-ABERTO.md) e na arquitetura v0.41 (§6.0). Foram por múltipla escolha, e as respostas coincidiram com as recomendações:

| Ponto | Decisão |
|---|---|
| **D1.** O SDK proprietário do Claude dentro do executável | O `claude-agent-acp`, com o SDK, é **ferramenta externa de nível C**. O usuário a instala, e o executável não a carrega |
| **D4.** Pacotes `opencode-<plataforma>` sem campo `license` | O OpenCode é **nível C** |
| **D5.** LGPL dentro do `@openai/codex-linux-x64` | O Codex é **nível C** |
| **D6.** Licenças "caso a caso" nas árvores | Aceitas as oito: BlueOak-1.0.0, Unlicense, CC0-1.0, MIT-0, Python-2.0, WTFPL, CC-BY-3.0, CC-BY-4.0. Valem em dependências (níveis B e D); código copiado (nível A) segue caso a caso |
| **D7.** AgentPrism | Exceção por pacote e versão: `@evilmartians/agent-prism-data` e `-types` 1.0.0 |
| **D8.** Licença do MCP SDK v2 | Fato, não decisão; corrigido na v0.40 (Apache-2.0) |
| **D9.** `OR` e `AND` do SPDX | Confirmada a leitura: `OR` pelo melhor ramo, `AND` pelo pior |
| **D10.** Ferramentas GPL em processo separado | Aceitas no nível C, instaladas pelo usuário, nunca embutidas nem distribuídas (`wl-paste`) |

Continuam abertas:
- **D2. Uso pessoal x produto (R1).** O texto diz que quem constrói produto "deve usar chave de API", que terceiros não podem rotear requisições por credenciais de plano, e que os limites dos planos assumem "uso comum e individual". Não diz se um orquestrador **pessoal e multi-conta** com o binário não modificado cabe nisso. Continua a pergunta à Anthropic da §10 ("Termos"). Também fica aberto o que "script ou bot" quer dizer nos Termos de Consumidor.
- **D3. Termos da OpenAI.** Não consegui ler (403). O dono decide se leio por outro meio ou se ele mesmo lê, antes de afirmar algo sobre uso de assinatura ChatGPT no Codex.

## 8. Pendências (não medido)

- **Termos da OpenAI** (403): [N].
- **Árvore do Nimbalyst, no HEAD atual**: medi o commit `dc5a0ef`; o HEAD de hoje (`c7d76d9`) não foi medido. [N]
- **Árvore do Nimbalyst, arquivos de licença**: a licença vem do campo `license` do registro [S]. Os `UNKNOWN` e `SEE LICENSE IN` (`exif-parser`, `khroma`, `posthog-js`, SDK do Claude) precisam de leitura do arquivo no tarball. [N]
- **`xclip`**: não instalado, licença não confirmada. [N]
- **Contrato com a Anthropic**: só li páginas públicas. Nenhuma resposta da Anthropic existe. [N]
- **Texto da MPL-2.0** (§6.0 marca "a conferir"): fora do escopo deste spike. [N]
- **`THIRD_PARTY_NOTICES`**: o verificador sinaliza pacotes com `NOTICE`, mas não gera o arquivo. Fica para a Fase 1.
- **`license` do lockfile x arquivo no tarball**: só o modo instalado olha o arquivo. Pacotes de plataforma não instalados confiam no registro.
- **Cobertura da árvore dos executores:** só lockfile, os binários nativos não foram baixados.

## 9. Como rodar

```bash
cd spikes/licenses
npm install --ignore-scripts

node test.mjs                                            # 16 testes sintéticos, sem rede
node test-pnpm.mjs                                       # 4 testes do adaptador pnpm, sem rede
node check.mjs --dir ../acp-claude                       # produção, árvore instalada
node check.mjs --dir ../acp-claude --tudo --json out/x.json
node check.mjs --dir stacks/executors --so-lockfile --nivel-c=instalacao   # só o package-lock.json; lista de ferramentas externas
node check.mjs --dir ../acp-claude --nivel-c=instalacao  # spike que instala o adaptador
```

Opções: `--dir`, `--tudo`, `--com-propostas`, `--json <arquivo>`, `--palpite=falha|aviso`, `--alertas=aviso|falha`, `--nivel-c=falha|instalacao`, `--so-lockfile`, `--politica <arquivo>`, `--quiet`. Código de saída: 0 aprovado, 1 reprovado, 2 erro.

Para reproduzir as árvores da stack: `cd stacks/core && npm ci --ignore-scripts` (idem `later`) e rode o verificador na pasta. A árvore `core` precisou de `@opentelemetry/api` 1.10.0 para resolver os pares do OpenTelemetry; os `package-lock.json` guardam o resultado.

**Arquivos:** `check.mjs`, `lockfile-pnpm.mjs`, `policy.json`, `proposals.json`, `test.mjs`, `test-pnpm.mjs`, `package.json`, `stacks/{core,later,executors}/{package.json,package-lock.json}`. Saídas em `out/` (ignoradas pelo git).
