# 21. Plano da Fase 10

Versão 1, de 2026-11-22. Este documento divide em passos a Fase 10 da [arquitetura](framework-ideas/arquitetura.md) (§10, "Fase 10 — Distribuição"), com o desenho da atualização em §5.21 ("Atualização automática", N73), o `THIRD_PARTY_NOTICES` por plataforma em §6.0 (N72) e o lançador com Job Object em §5.9 (N58). Quando este documento divergir da arquitetura, vale a arquitetura, e este documento é ajustado. As exceções são as decisões do dono de 2026-11-22 (N244 a N249, e as do plano, N250 a N255), que mudam o que a §10 e a N73 dizem sobre os canais (ver "Decisões de partida").

A fase começa depois do fim da Fase 9 (PRs #282 e #283, main em `1f331f9` [V: `git log`]). Pela N245, os PRs desta fase, incluindo o deste plano, mesclam com a CI verde e squash, sem o ok do dono em cada PR. As decisões continuam indo ao dono por múltipla escolha.

**Regra central da fase (N244):** tudo é construído e testado, mas **nenhum release público sai antes da confirmação da Anthropic sobre o R1** (Q4). O plano dá um portão técnico para isso no passo P9.

## Como usar

- Cada passo tem uma branch e um PR com título "Fase 10: ...". A branch parte da main. Não há branch sobre branch: o passo que depende de outro só começa depois do merge dele (fila de PRs, 2026-11-21). O PR que conclui um passo também muda o estado dele na tabela de passos.
- O merge é feito pelo `merge-pr.sh`, com squash, depois da CI verde (a do próprio head ou a de uma rodada verde da mesma árvore, `ci-tree.sh`). Nunca se usa `gh pr merge --auto`.
- Todo passo exige, além do aceite próprio, `build`, `lint`, `format:check`, `test`, `verify` e `deps` verdes na máquina e na CI. Os jobs `cross` e `windows-launcher` rodam nos PRs que mexem em código (N162).
- O que está marcado **[proposta]** é detalhe deste plano, ainda sem decisão. Todo padrão novo vira uma chave de configuração, com um padrão e os seus modos.
- Marcas de confiança: **[V]** verificado nesta máquina; **[S]** vem de fonte secundária (registro npm, documentação, um PR) e traz a data; **[N]** não confirmado, e o passo que o usa tem de medir.
- Paralelismo:
  - passos sem dependência entre si correm ao mesmo tempo, cada um no seu worktree;
  - dois passos nunca mexem nos mesmos arquivos. As exceções são as das fases anteriores, e em cada uma o passo acrescenta só o seu bloco: o `DaemonConfigSchema` (`daemon/src/config.ts`), o índice do protocolo, o catálogo de eventos, o `compose.ts`, o `cli.ts` (um comando novo é um arquivo próprio mais uma linha no `COMMANDS`) e os catálogos `locales/<idioma>/*.json`;
  - **cada passo de distribuição tem o seu próprio arquivo de workflow** em `.github/workflows/` **[proposta]**, com `paths:` e `workflow_dispatch`, em vez de acrescentar jobs ao `ci.yml`. Assim dois passos não colidem no mesmo YAML;
  - no máximo dois subagentes rodam a suíte completa ao mesmo tempo.
- **Nada real roda nos testes (N57).** Os testes de instalação e de atualização usam um servidor de versões em loopback e uma chave Ed25519 gerada no próprio teste (N246). Os clientes são o `fake-agent`. As rodadas reais ficam no nível real do aceite (P12) e nas verificações à mão do dono.
- **Nenhum download novo sem decisão do dono.** Só estão aprovados o esbuild, o postject e o WiX (N249); ver "Dependências novas".
- **Nenhum release, tag ou arquivo de versão é publicado** enquanto o portão do R1 estiver fechado (N244). Os passos publicam só dentro do próprio PR (código e testes).

## Ponto de partida

Conferido no código em 2026-11-22, no commit `1f331f9` **[V]**. Os caminhos são relativos a `packages/`, salvo indicação.

- **Distribuição:** não existe nada. Não há script de build de executável, instalador, serviço de logon, `ot init`, nem `updates.*` no `DaemonConfigSchema` (é `strictObject`). Os bins do pacote `@otheater/daemon` são `ot` e `otheater`, ambos apontando para `dist/cli.js` (um script ESM que precisa do `node`).
- **Quem sobe o quê hoje:**
  - o `cli.ts` guarda, em `otLauncherOf()`, o par `{ node: process.execPath, entry: realpathSync(process.argv[1]) }` para os lugares que relançam o próprio `ot`;
  - a TUI roda em outro processo: `tui/src/launcher.ts` monta `process.execPath` mais `main.js` (e `runtimeFlags`, mais o ambiente `OT_TUI_UI`), carregado por `import.meta.url`;
  - o shim MCP em stdio (`daemon/src/mcp/stdio-shim.ts`) é outro script, achado por `new URL('../../dist/mcp/stdio-shim.js', import.meta.url)`.
  - Num executável único, `process.execPath` é o próprio executável: todo "node mais script" vira "executável mais modo interno" (P1).
- **Arquivos lidos pelo caminho do módulo (`import.meta.url`), que no SEA não existem em disco:**
  - `locales/` (a TUI, o `client` e o `daemon/src/i18n.ts`) e `prompts/` (`adapters/prompts-files`);
  - `daemon/package.json`, de onde `version.ts` tira a versão;
  - `tui/patches/register.mjs`, o gancho dinâmico dos patches do Ink (`ink-patch.ts`; padrão `render.inkPatches: ['cache', 'grid']` em `tui/src/settings.ts`).
- **Nativos:**
  - `better-sqlite3` 13.2.0 (store e telemetria), cujos binários vêm dentro do tarball npm e carregam sem script de instalação (comentário do `pnpm-workspace.yaml`, que mantém `ignoredBuiltDependencies: [better-sqlite3]`);
  - `@napi-rs/keyring` 2.1.2, com um pacote `.node` por plataforma (`@napi-rs/keyring-linux-x64-gnu`, `-win32-x64-msvc`, `-darwin-arm64` e outros) [V: `pnpm-lock.yaml`].
  - Existe a alternativa `store.driver: node-sqlite` (N49), que usa o `node:sqlite` do Node, sem `.node` **[V: N49 registra o `DatabaseSync` do Node 24.18]**.
- **Adaptadores ACP:** o `claude-agent-acp` e o `codex-acp` não são dependências do repositório e o executável único **não** os leva. Até o P12 os adaptadores de cliente os chamavam como comandos do `PATH` (`DEFAULT_CODEX_COMMAND = { cmd: 'codex-acp' }`, e o equivalente no Claude Code) **[V: `client-codex` e `client-claude-code`]**. Desde 2026-11-22 (N254 revista, P13) o OTheater os **instala** em `<dataDir>/adapters/`, baixados do registro npm na versão fixa, e os roda com o Node embutido; o `PATH` continua sendo o caminho de reserva (`clients.<id>.adapter`).
- **Windows:**
  - o lançador Rust (`native/job-launcher`, `ot-job-launcher`, crate `windows-sys` fixa em `=0.61.2`) existe e tem o job `windows-launcher` na CI (Fase 2, N58);
  - **o adaptador TypeScript que o usa não existe**: `defaultLauncher()` (`daemon/src/compose.ts`) devolve `undefined` em `win32`, e sem lançador as tentativas e as ferramentas de navegador ficam desligadas no Windows. Por isso o P2 é código novo, e não só empacotamento.
- **Backup e restauração:** `ot backup` e `ot restore` existem (`daemon/src/recovery/backup.ts`); o evento `daemon.backup` tem `trigger: 'schedule' | 'manual'` (`protocol/src/api.ts`) **[V]**. A API ainda não tem rota de saúde própria (§5.21, e a busca por `health` em `daemon/src/api` não achou rota) **[V]**.
- **Assistente de configuração:** já entrou no daemon, com rotas em `client/src/setup-routes.test.ts` e a aba na TUI (N121; §5.12). O `ot init` só o abre.
- **Eventos:** 149 no protocolo e 151 no registro do daemon, depois da Fase 9 **[S: "Como ficou" do P13 em [docs/20](20-PLANO-DA-FASE-9.md)]**. Não existe `daemon.update`.
- **Notices:** `THIRD_PARTY_NOTICES.md` da raiz é gerado no Linux por `tools/verify/src/notices.ts`; não há opção por plataforma. A N72 pede um por plataforma distribuída.
- **CI:** jobs `linux`, `changes`, `docs`, `atif`, `cross` (Windows e macOS), `windows-launcher`, todos com Node 24 **[V: `.github/workflows/ci.yml`]**. Não há workflow de release.
- **Node:** 24.18.0 na máquina, só com `node --experimental-sea-config` (não há `--build-sea`) **[V: `node --help`, N249]**.

## Dependências novas

Dados do registro npm, consultados em 2026-11-22 com `timeout 60 npm view <pacote> version license` e `time` **[S]**. Nada foi baixado para descobrir. A regra é a das fases anteriores: só entra versão publicada há pelo menos duas semanas.

| Ferramenta | Versão fixa proposta | Licença | Publicada | Passo | Observação |
|---|---|---|---|---|---|
| `esbuild` | 0.28.2 | MIT [S] | 2026-08-08 [S] | P1 | `devDependency` de `tools/release`. Hoje só aparece no `pnpm-lock.yaml` como faixa de peer (`^0.27.0 \|\| ^0.28.0`); não está instalado. Traz o binário por pacotes opcionais `@esbuild/<plataforma>` (um por plataforma) **[N: o P1 confere os nomes e que roda com os scripts de instalação ignorados, como o `better-sqlite3`]**. As versões 0.28.0 (2026-04-02) e 0.28.1 (2026-06-11) também têm mais de duas semanas |
| `postject` | 1.0.0-alpha.6 | MIT [S] | 2023-05-19 [S] | P1 | É o `latest` do registro, e uma pré-versão de mais de três anos. Depende de `commander@^9.4.0` (a licença do `commander` **[N]**). Quem injeta o script no binário do Node 24, que só tem `--experimental-sea-config` **[V]**. Ver a N250 |
| WiX Toolset | série 6, versão a fixar no P4 | MS-RL **[N: não conferida]** | **[N]** | P4 | Só na CI do Windows, instalado como ferramenta .NET (`dotnet tool`) **[N: não é pacote npm; o P4 confere nome, versão e licença na fonte oficial, no download aprovado pela N249, e fixa a versão no workflow, com a data da publicação]** |

Não entram: ferramentas de assinatura de código (N247), `electron-builder`, `pkg`, `nexe`, `node-gyp` e qualquer outra coisa de build. O `crypto` do Node cobre o Ed25519 e o SHA-256, sem dependência nova (N73).

Custo de licença **[proposta]**: o esbuild, o postject e o WiX são ferramentas de build (nível D da §6.0): não vão para dentro do que se distribui, e não entram no `THIRD_PARTY_NOTICES`. O que o esbuild **junta** no executável é nível B e entra, e por isso o P10 lê o `metafile` do esbuild (a lista do que foi realmente empacotado).

## Passos

Os passos P1 a P11 seguem a lista do pedido do dono (executável, lançador, `.msi`, `install.sh`, `ot init`, `updates.*`, release, notices, assinatura, aceite), com dois acertos: o serviço de logon ganhou o seu próprio passo (P3), porque os três sistemas e o `ot init` o usam; e a atualização foi dividida em verificar e baixar (P7) e aplicar e voltar (P8).

| Passo | Título | Depende de | Pode correr junto com | Estado |
|---|---|---|---|---|
| P0 | Plano e decisões (este documento) | nada | todos os que dependem só dele | em andamento |
| P1 | Executável único (SEA): esbuild, postject, nativos e arquivos como assets | P0 | P2, P3, P7 | feito (#290) |
| P2 | Lançador com Job Object no Windows: adaptador `platform-windows` | P0 | P1, P3, P7 | feito (#289) |
| P3 | Serviço de logon: `ot service` com Tarefa Agendada, launchd e `systemd --user` | P0 | P1, P2, P7 | feito (#287) |
| P4 | `.msi` do Windows (WiX): instalar, serviço e desinstalar | P1, P2, P3 | P5, P6, P8, P10 | feito (#293) |
| P5 | `install.sh` para macOS e Linux | P1, P3 | P4, P6, P8, P10 | feito (#295) |
| P6 | `ot init` | P3 | P4, P5, P8, P10 | feito (#296) |
| P7 | `updates.*` (1/2): origem, manifesto, SHA-256, Ed25519, canais, `check`, `notify` e `off` | P0 | P1, P2, P3 | feito (#288) |
| P8 | `updates.*` (2/2): aplicar com `apply_when` e `max_wait`, volta automática e backup antes das migrações | P1, P7 | P4, P5, P6, P10 | feito (#297) |
| P9 | Job de release na CI e o portão do R1 | P1, P4, P5, P7, P10 | nada | feito neste PR |
| P10 | `THIRD_PARTY_NOTICES` por plataforma | P1 | P4, P5, P6, P8 | feito (#294) |
| P11 | Assinatura de código, desligada, por chave; guia de instalação | P9 | P12 (a parte automática) | feito (#332) |
| P12 | Aceite da fase | P1 a P11 | nada | feito neste PR |
| P13 | Adaptadores ACP gerenciados (N254 revista) | P1, P6 | P9, P11 | feito (#298) |

Ondas **[proposta]**:
- onda 1, logo depois do merge deste plano: **P1, P2, P3 e P7**, em paralelo, cada um nos seus arquivos;
- onda 2: **P4, P5, P6, P8 e P10**, em paralelo;
- onda 3: **P9**;
- onda 4: **P11 e P12**.

## Decisões de partida

Decididas pelo dono em 2026-11-22, por múltipla escolha, e registradas por outro passo em [docs/13](13-DECISOES-EM-ABERTO.md) e na arquitetura. O que cada uma deixa em aberto fica como **[proposta]** neste plano:

| Decisão | O que foi decidido | O que fica como [proposta] neste plano |
|---|---|---|
| N244 | A Fase 10 constrói e testa tudo; nenhum release público antes da confirmação do R1. A Q4 continua aberta | O portão técnico do P9: a variável de repositório `OT_RELEASE_GATE` e o input `publish`; o nome e o valor `open` |
| N2 | Modo **pessoal** até o R1; o modo produto fica para a resposta da Anthropic. A N2 continua aberta quanto ao produto | Nada neste plano depende do modo produto: não há conta, cobrança nem chave de API embutida |
| N245 | Merges da Fase 10 sem ok por PR, com a CI verde e squash | Nada |
| N246 | A chave privada Ed25519 é um secret do GitHub Actions criado pelo dono; só a pública entra no código; nos testes, uma chave gerada no teste | O nome do secret (`OT_UPDATE_SIGNING_KEY`), o arquivo da chave pública no repositório (`tools/release/keys/update-public-key.pem`) e o comando de geração (seção "O comando da chave") |
| N247 | Sem assinatura de código na v1; a documentação explica o SmartScreen e o Gatekeeper; o passo de assinar fica pronto, ligado por chave de build | Os nomes das chaves (`signing.windows`, `signing.macos`) e a assinatura *ad hoc* no macOS arm64 (ver P1 e P11) |
| N248 | Canais: GitHub Releases (`.msi` e executáveis) e `install.sh` para macOS e Linux. **npm e winget ficam fora da v1** | Como a instalação é detectada (P7) |
| N249 | Aprovados esbuild, postject e WiX; versões fixas neste plano | As versões da tabela "Dependências novas" (N250) |

**O que isto muda na arquitetura e na N73** (o ajuste cabe ao passo que registra as decisões; este plano só aponta):
- a lista da §10 cita "instalador `.msi`/winget" e "alternativa para desenvolvedores: `npm i -g`": a N248 tira o winget e o npm da v1;
- a parte "origem conforme a instalação" da N73 ("npm e winget só avisam") passa a valer só quando esses canais entrarem. Na v1 só há a origem do executável próprio (SEA e `.msi`), e a detecção do tipo de instalação (**[proposta]** da N73) se reduz a "foi instalado pelo `.msi` ou pelo `install.sh`, ou está rodando de um checkout (`ot` pelo Node)". Neste último caso a atualização é `check` (só avisa);
- a §10 ainda diz que a origem depende do item 2 da seção 12 e do repositório. Com a N2 em "pessoal até o R1" e o repositório público, a origem é o próprio repositório (N251).

### Perguntas novas ao dono

Levadas por múltipla escolha, com a recomendação em primeiro lugar. **Decididas pelo dono em 2026-11-22, todas na opção recomendada (a)** (docs/13, N250 a N255). As alternativas ficam abaixo como registro.

- **N250, as versões fixas das ferramentas (P1, P4):**
  - (a) esbuild 0.28.2, postject 1.0.0-alpha.6 e WiX série 6 com a versão fixada no P4 (**recomendada**): são as ferramentas que a N249 aprovou, nas versões mais novas com mais de duas semanas. O risco do postject é ser uma pré-versão parada desde 2023, mas é a ferramenta que a documentação do Node para SEA nomeia **[N: não relido nesta rodada]**, e o P1 fixa a versão exata e mede;
  - (b) esbuild 0.28.1 (2026-06-11), mais antigo, mesma licença: só se a 0.28.2 der problema no P1;
  - (c) deixar a versão do WiX para o dono escolher antes do P4: trava o P4.
- **N251, a origem das versões (P7, P9):**
  - (a) o próprio repositório, em GitHub Releases (**recomendada**): sem repositório novo (que, de resto, não pode ser criado), e o repositório já é público [V: arquitetura, "público desde 2026-11-21"]. O custo é que o release de ensaio e o publicado vivem no mesmo lugar, o que o portão do P9 protege;
  - (b) um repositório só para as versões: separa, mas exige criar o repositório (do dono) e mexer na origem depois.
- **N252, os artefatos do ensaio de release enquanto o portão estiver fechado (P9):**
  - (a) o ensaio roda o build inteiro e **guarda os artefatos do run por 1 dia**, assinados só com uma chave efêmera (**recomendada**): um binário assim não é uma "versão", porque nenhum OTheater o aceita (a chave pública embutida é outra), e o run só mostra o que o teste precisa. Pendente: se os artefatos de run de um repositório público ficam visíveis a qualquer usuário do GitHub **[N: não confirmado]**; por isso o ensaio não leva segredo nem dado do dono;
  - (b) o ensaio constrói e testa no mesmo job e **não sobe artefato** nenhum: zero exposição, mas o aceite em três sistemas fica mais acoplado e mais difícil de depurar.
- **N253, a verificação do `install.sh` (P5):**
  - (a) `openssl pkeyutl -rawin` quando o `openssl` do sistema suporta Ed25519, e, se não suportar, o modo interno do executável baixado confere o manifesto, **com aviso na tela** (**recomendada**): o `openssl` 3 já confere uma assinatura feita pelo Node **[V: neste Linux, OpenSSL 4.0.3]**, e o LibreSSL do macOS **[N: não testado]** pode não suportar. O modo interno usa a chave embutida no executável, então confia no que acabou de ser baixado, e por isso o aviso;
  - (b) exigir o `openssl` com Ed25519 e recusar a instalação sem ele: mais estrito, mas pode falhar num macOS de fábrica;
  - (c) só o SHA-256 pelo script, deixando o Ed25519 para o executável na primeira atualização: não cumpre a N248 ("confere SHA-256 e Ed25519").
- **N254, os adaptadores ACP (`claude-agent-acp`, `codex-acp`) no executável único (P1, P6, P13):**
  - **Revista em 2026-11-22 (P13), por decisão do dono:** o OTheater instala os dois adaptadores em `<dataDir>/adapters/`, sem `sudo` e sem mexer no `PATH`, baixando do registro npm a versão fixa (`@agentclientprotocol/claude-agent-acp` 0.107.0 e `@agentclientprotocol/codex-acp` 2.6.0) e conferindo o sha512 do lockfile. Eles rodam com o Node embutido, por um modo interno do executável (`--ot-internal=run-adapter <entry.js>`); fora do SEA, com `process.execPath`. O padrão é instalar sozinho quando o cliente oficial está no `PATH` e o adaptador falta, com aviso na tela e evento. **Nada é redistribuído no executável**: o `@anthropic-ai/claude-agent-sdk` tem licença comercial, então o usuário o baixa do npm. Os nomes das chaves (`clients.adapters.install: auto|ask|command|off`, `clients.<id>.adapter: managed|path|<caminho>`, `clients.adapters.registry`) são **[proposta]**.
  - (a, a decisão original, antes da revisão) eram pré-requisito externo e a v1 não os levava (**recomendada**): o `ot init` conferia se os comandos existiam e mostrava o comando `npm` que o usuário rodava, sem executar nem baixar nada. O P1 mede, sem entregar, se os adaptadores caberiam como modos internos;
  - (b) o instalador roda o `npm` para instalá-los: exige Node e npm na máquina, o que contraria o executável único, e baixa pacotes sem aprovação;
  - (c) empacotá-los no executável como modos internos: o executável cresce e muda de licença e de versão com cada cliente **[N: não medido]**; só se o P1 mostrar que cabe.
- **N255, as plataformas da v1 (P1, P9, P10):**
  - (a) as três da §10: `linux-x64`, `win32-x64` e `darwin-arm64` (**recomendada**): são os executores de CI disponíveis sem custo extra, e cada uma tem um job de máquina limpa;
  - (b) mais `linux-arm64` e `darwin-x64`: cada uma exige um runner e um `.node` do keyring a mais, e não há máquina de teste **[N: a disponibilidade desses runners não foi conferida]**.

### O comando da chave

O dono gera o par uma vez, de preferência num terminal que ele possa fechar depois (N246). Só ferramentas que já existem: o `node` e o `gh`. A **chave privada nunca vai ao terminal nem a um arquivo**: sai do `node` por um pipe direto para o `gh secret set`, que a lê da entrada padrão [V: `gh secret set --help`: "reads from standard input if not specified"]. Só a pública (que não é segredo) é gravada num arquivo.

```bash
# bash; roda na pasta onde a chave pública deve ficar
set -o pipefail
node -e '
const { generateKeyPairSync } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
writeFileSync(process.argv[1], publicKey.export({ type: "spki", format: "pem" }));
process.stdout.write(privateKey.export({ type: "pkcs8", format: "pem" }));
' ./update-public-key.pem | gh secret set OT_UPDATE_SIGNING_KEY --repo asantos43/orchestration-theater
```

- O trecho do `node` foi rodado aqui, só com o pipe para um contador de bytes: gerou o arquivo da pública (`BEGIN PUBLIC KEY`) e escreveu a privada só na saída padrão **[V: 2026-11-22]**. O `gh secret set` não foi executado.
- Se o `gh` falhar, nada foi gravado no GitHub e a chave se perdeu: rode de novo; o `update-public-key.pem` anterior deve ser descartado, porque só vale o par cuja privada foi gravada com sucesso.
- Com o `set -o pipefail`, uma falha do `node` também derruba o pipe. Num terminal zsh, rode o bloco dentro de `bash -c '...'` ou use `setopt pipefail`.
- Depois, o dono entrega o `update-public-key.pem` (só a pública) ao repositório, em `tools/release/keys/update-public-key.pem` **[proposta]**, por commit dele ou pedindo a Claude. Até lá, o arquivo é um marcador (conteúdo `PLACEHOLDER`), e o P9 recusa publicar com ele.
- A chave privada só existe no secret. O job de release a lê por `${{ secrets.OT_UPDATE_SIGNING_KEY }}` e a passa por variável de ambiente ao `tools/release`, que a importa com `crypto.createPrivateKey`; ela não é impressa, e o log mascara o secret. Nenhum agente a lê (N246).
- Trocar a chave (perda ou suspeita): gerar outro par e publicar uma versão assinada com a antiga que embute a pública nova. Se a privada vazar, as versões antigas não confiam mais na nova: o plano do P8 documenta o procedimento **[proposta]**.

## Formato dos artefatos e da assinatura

Definido aqui para que os passos em paralelo (P5, P7, P8 e P9) concordem **[proposta]**.

- **Executável por plataforma:** `otheater-<plataforma>` (`.exe` no Windows), com `<plataforma>` em `linux-x64`, `win32-x64`, `darwin-arm64` (N255). No Windows, também `OTheater-<versão>-win32-x64.msi`.
- **Manifesto:** `manifest.json`, publicado junto com a versão, com:
  - `schema: 1`, `version` (semver), `channel` (`stable` ou `beta`), `publishedAt` (UTC);
  - `assets`: uma lista de `{ platform, kind (exe | msi), name, size, sha256 }`;
  - `schemas`: as versões de esquema do store e da telemetria que essa versão exige (o P8 usa para decidir o backup; se faltar o campo, o backup é feito);
  - `minVersion`, a menor versão a partir da qual a atualização direta é suportada.
- **Assinatura:** `manifest.json.sig`, a assinatura Ed25519 do **conteúdo exato (bytes)** do `manifest.json`, em base64. Não há forma canônica a recalcular. O SHA-256 de cada executável vai dentro do manifesto, então **uma só assinatura cobre tudo**.
- **Chave pública:** embutida no executável pelo build (`define` do esbuild, lida de `tools/release/keys/update-public-key.pem`). **Não há chave pública em configuração do usuário**, porque uma chave trocável anularia a conferência. Os testes injetam a chave por parâmetro do verificador.
- **Conferência (o que o P7 implementa):** baixar o manifesto e a assinatura; conferir a assinatura com a chave embutida; só então ler o manifesto; conferir `channel` igual ao pedido; recusar versão menor ou igual à instalada (sem *downgrade* por manifesto, para impedir repetir um manifesto antigo); baixar o ativo da plataforma; conferir `size` e `sha256`; só então guardar. Qualquer falha descarta o download e gera o evento `daemon.update` com `phase: 'rejected'` e o motivo, e o aviso no chat global (§5.21).
- **Origem GitHub:** o `stable` lê `releases/latest/download/manifest.json` **[N: o redirecionamento sem API e sem limite de taxa não foi confirmado]**; o `beta` lê a lista de releases e pega a primeira marcada como pré-versão **[N: a API sem autenticação tem limite de 60 pedidos por hora por IP, de fontes que o P7 relê; a verificação é de 6 h, então cabe]**. Nenhuma credencial do GitHub vai para o daemon (§5.21).

## Detalhe dos passos

### P1. Executável único (SEA): esbuild, postject, nativos e arquivos como assets (§10, N249)

**O que fazer:** juntar o daemon e a TUI num executável por plataforma, com o Node SEA.

- **Pacote de build novo `tools/release`** (privado, no `pnpm-workspace.yaml` por `tools/*`), com o `esbuild` e o `postject` nas versões da tabela:
  - `bundle`: o esbuild gera **um** script **CJS** (o SEA do Node 24 carrega um script, e o suporte a ESM no SEA **[N]** não é assumido) a partir do ponto de entrada novo, com `--metafile` (o P10 lê). O `import.meta.url` é trocado por `define`/`banner` para o que o SEA tem; o `await` no topo vira uma função `main()` assíncrona;
  - `sea-config`: gera o `sea-config.json` com `main`, `output`, `disableExperimentalSEAWarning: true` e a lista de `assets`;
  - `inject`: `postject` no binário do Node da plataforma, com o fusível do SEA. Os caminhos de entrada e saída vêm por argumento.
- **Ponto de entrada multi-chamada `daemon/src/sea/main.ts`**: um só executável com modos internos, pelo primeiro argumento `--ot-internal=<modo>` **[proposta]** (o argumento do usuário não colide):
  - sem modo: a CLI `ot` de hoje (`daemon/src/cli.ts`);
  - `tui`: o `tui/src/main.ts`;
  - `mcp-shim`: o `daemon/src/mcp/stdio-shim.ts`;
  - `verify-release`: confere um manifesto com a chave embutida (usado pelo `install.sh`, N253);
  - `apply-update`: o aplicador do P8.
- **Quem relançava `node` mais script** passa a relançar o executável mais modo. Os pontos conhecidos: `otLauncherOf()` no `cli.ts`; `buildTuiCommand` e `runtimeFlags` em `tui/src/launcher.ts`; o caminho do `stdio-shim` em `mcp/stdio-shim.ts`. A função que decide o comando é uma só (`resolveSelfCommand()`), com o caso de checkout (`node` mais script) e o caso SEA, e os testes cobrem os dois.
- **Arquivos como assets** (`node:sea`, `getAsset`, `getRawAsset`; **[N]** a API exata no Node 24.18, e o P1 mede): `locales/**`, `prompts/**` e a versão. A versão vem de uma constante do build (`define`), e não da leitura de `package.json` em `version.ts` **[proposta]**; o `i18n.ts`, o `ui-catalog.ts` e o `file-prompt-source.ts` leem do asset quando estão num SEA (`isSea()`), e do disco quando não estão.
- **Nativos como assets, extraídos na primeira execução:** os `.node` do `better-sqlite3` e do keyring da plataforma vão como assets, são extraídos para `<dataDir>/native/<sha256>/` (com verificação do hash e reaproveitados nas execuções seguintes) e carregados com `process.dlopen` **[N]**. O `better-sqlite3` aceita indicar o binário na criação (a opção `nativeBinding`) e o `@napi-rs/keyring` tem o carregador por plataforma que o esbuild precisa desviar com um plugin **[N: os dois pontos são de documentação e de leitura do pacote, e o P1 confere]**. **[proposta]** O padrão de `store.driver` no SEA continua `better-sqlite3`; se a extração falhar no Windows (antivírus, pasta bloqueada), o P1 mede o `node-sqlite` como saída e registra o desvio.
- **Os patches do Ink** (`ink-patch.ts`, gancho dinâmico em `register.mjs`) não cabem como estão num script único **[N]**. **[proposta]** O P1 tenta aplicá-los em tempo de build, com um plugin de `onLoad` do esbuild; se não for possível, o SEA sai com `render.inkPatches: []` por padrão e o custo de renderização medido vai para o relatório do P1, para o dono decidir.
- **Assinatura *ad hoc* no macOS arm64 [N]:** um binário arm64 modificado precisa de ao menos assinatura *ad hoc* para executar (`codesign --sign -`, sem certificado, sem conta). **[proposta]** O build a aplica sempre no macOS, e isso não conta como "assinatura de código" da N247 (que seria com certificado). O P11 explica a diferença na documentação.
- **Chaves da build:** `tools/release/release.config.json` **[proposta]**: `targets` (padrão `["linux-x64","win32-x64","darwin-arm64"]`, N255) e `versionOverride` (só para testes: embute uma versão sintética, usada pelo P8 e pelo P12). Os campos de assinatura chegam no P11.
- **Workflow `.github/workflows/dist-sea.yml` [proposta]:** em PR que mexe em `tools/release`, `daemon/src/sea` ou nos pontos de relançamento, constrói o executável nas três plataformas, roda `--version`, sobe o daemon num diretório temporário com o `fake-agent`, chama a API, abre e fecha a TUI (modo sem terminal real) e para o daemon. A variável `OT_DIST_CI` (`affected` | `full` | `off`) controla como as de `OT_CROSS_CI` **[proposta]**.

**Arquivos:** `tools/release/**` (novo), `daemon/src/sea/**` (novo), `.github/workflows/dist-sea.yml` (novo), `pnpm-lock.yaml` (só este passo o altera, com o download aprovado pela N249), e blocos pequenos em `daemon/src/cli.ts`, `daemon/src/version.ts`, `daemon/src/i18n.ts`, `daemon/src/mcp/stdio-shim.ts`, `tui/src/launcher.ts`, `tui/src/locale.ts`, `client/src/node/ui-catalog.ts` e `adapters/prompts-files/src/file-prompt-source.ts`.

**Aceite:**
- o executável de cada plataforma sobe o daemon, atende a API, abre a TUI e relança o `ot` e o shim MCP por modo interno **[V na CI]**;
- o mesmo comportamento do checkout (`node` mais script) segue verde, na suíte atual;
- o relatório do P1 traz os números medidos: tamanho do executável por plataforma, tempo de subida a frio e a quente (com a extração dos `.node`), o resultado dos patches do Ink e a viabilidade de embutir os adaptadores ACP (N254).

**Como ficou:** a preencher quando o passo for mesclado.

### P2. Lançador com Job Object no Windows: adaptador `platform-windows` (§5.9, N58)

**O que fazer:** ligar o `ot-job-launcher.exe` ao daemon no Windows. Hoje `defaultLauncher()` devolve `undefined` em `win32`.

- **Pacote novo `packages/adapters/platform-windows`:** implementa a porta `ProcessLauncher` (`core/src/ports/process-launcher.ts`) lançando o executável de cada Executor por `ot-job-launcher -- <exe> <args>` (a forma documentada em `native/job-launcher/README.md`), e propagando o código de saída, `stdin`, `stdout`, `stderr` e o ambiente. O fim da árvore é o encerramento do lançador: o Windows fecha o job inteiro **[V: README do lançador; teste real no job `windows-launcher`, Fase 2]**.
  - `.cmd` e `.bat` são recusados pelo lançador (injeção de argumentos). O adaptador resolve o executável real antes (por exemplo, `node.exe`) e recusa o que não resolve, com erro claro;
  - o limite de memória usa `--memory-limit-bytes` quando a política do papel o pede (§5.9).
- **Onde achar o lançador:** ao lado do executável do OTheater (`<pasta>/ot-job-launcher.exe`), ou numa pasta de checkout (`native/job-launcher/target/release/`) **[N: o P2 confere o caminho do build do cargo]**. O P4 instala os dois lado a lado.
- **`compose.ts`:** `defaultLauncher()` passa a devolver o adaptador em `win32`. **Chave nova [proposta]:** `processes.windows_launcher: auto | job_object | off`, padrão `auto` (usa o lançador se achar o `.exe`; se não achar, cai para `off` com um evento de aviso, porque "sem lançador" desliga as tentativas e as ferramentas de navegador, como hoje). `job_object` recusa subir sem o lançador. `off` mantém o comportamento de hoje.
- **Situação vira evento:** quando cai para `off`, o aviso também gera evento (regra das fases anteriores), no tipo de aviso que o daemon já tem **[N: o P2 escolhe o tipo existente]**.
- **Testes:** o adaptador roda no job `windows-launcher` e no `cross` (Windows) com o lançador real e um processo de teste que cria netos; o teste mata o lançador e confere que os netos morreram. O `fake-agent` é o filho. Em Linux e macOS, o adaptador não carrega (o caminho é só de `win32`) e um teste de unidade cobre o seletor com um `platform` falso.

**Arquivos:** `packages/adapters/platform-windows/**` (novo), `daemon/src/compose.ts` (bloco do lançador), `daemon/src/config.ts` (a chave), `locales/<idioma>/*.json` (o aviso), `docs/reference/` (regenerado pelos `pnpm verify:*`). O teste real fica no workflow existente `windows-launcher`, sem edição do `ci.yml` além do filtro de caminhos, se precisar **[N]**.

**Aceite:** no Windows da CI, um Executor de teste é lançado pelo adaptador e a árvore some quando o daemon é morto à força; no Linux e no macOS, nada muda. Os dois estados da chave estão cobertos. **Fica para o dono, à mão:** o mesmo com um cliente real (Claude Code ou Codex) num Windows real, que a CI não cobre (ver o P12).

**Como ficou:** a preencher quando o passo for mesclado.

### P3. Serviço de logon: `ot service` com Tarefa Agendada, launchd e `systemd --user` (§5.1, §5.21, §10)

**O que fazer:** instalar e remover o daemon como serviço **do usuário**, que sobe no logon e só roda com o usuário conectado (§5.21, "Gatilhos do sistema operacional registrados para rodar só com o usuário conectado"). O comando é `ot service install | uninstall | status | start | stop`; o `.msi` (P4), o `install.sh` (P5) e o `ot init` (P6) chamam o mesmo comando.

- **Porta `ServiceManager`** no daemon, com três adaptadores, escolhidos por `process.platform`, e um quarto falso para teste:
  - **Windows:** uma **Tarefa Agendada** do usuário, acionada no logon, com reinício em falha, criada pelo `schtasks.exe` com um arquivo XML **[proposta]**. A tarefa roda sem janela. Não exige administrador, por ser do próprio usuário **[N: não conferido num Windows real; o P3 testa na CI e o P12 deixa a conferência final ao dono]**. A alternativa descartada é a chave `Run` do registro, que não reinicia em falha;
  - **macOS:** um **LaunchAgent** (`~/Library/LaunchAgents/<id>.plist`, com `RunAtLoad` e `KeepAlive` em falha), carregado por `launchctl bootstrap gui/<uid>` (e `bootout` ao remover) **[N: `bootstrap` exige uma sessão gráfica ativa, e a CI do macOS pode não ter; o teste confere o plist e tenta o carregamento]**;
  - **Linux:** uma unidade **`systemd --user`** (`~/.config/systemd/user/<id>.service`, `Restart=on-failure`, `WantedBy=default.target`), habilitada por `systemctl --user enable --now`. **[proposta]** Sem `loginctl enable-linger`: o serviço roda só enquanto há uma sessão do usuário, que é o que a §5.21 pede. O `ot service status` avisa isso em `en` e `pt-BR`.
- **O comando que o serviço roda:** o próprio executável com `daemon`, achado por `resolveSelfCommand()` (P1) **[proposta]**; antes do P1 chegar, o caminho do checkout (`node` mais `dist/cli.js`). O identificador do serviço é `com.otheater.daemon` no macOS, e `otheater-daemon` nos outros **[proposta]**.
- **Chaves novas [proposta]:** `service.restart: on_failure | always | never` (padrão `on_failure`); `service.autostart: logon | manual` (padrão `logon`; `manual` registra, mas não habilita o gatilho).
- **O comando da TUI sobe o daemon se ele não estiver no ar** (§10): se `ot tui` não achar o daemon, chama `ot service start` quando o serviço existe, e, se não existe, sobe um daemon filho do próprio usuário **[proposta]**, sem pedir nada no terminal. Isso entra neste passo porque é o mesmo detector de "está no ar". **[proposta]** uma chave `tui.start_daemon: service | child | off` (padrão `service`, e `child` se o serviço não existir).
- **Desinstalar** remove o serviço e para o daemon pela API (parada limpa), **sem apagar dados** (store, telemetria, backups, configuração). Apagar dados é outra ação explícita, `ot uninstall --purge-data` **[proposta]**, com confirmação, que só o `.msi` e o `install.sh` oferecem. O padrão que preserva dados evita a perda por engano.
- **Eventos:** `ot service` roda sem daemon e não emite evento. Quando o daemon sobe por um serviço, ele já registra `daemon.started` (nenhum evento novo); se o serviço reiniciou o daemon depois de uma falha, o aviso entra no log e no evento que a reconciliação já emite **[N: o P3 confere qual]**.
- **Testes:** os três adaptadores geram o arquivo (XML, plist, unidade) por funções puras, comparados com arquivos de referência; a ordem das chamadas ao SO é testada com um executor de comandos falso. Os jobs por SO da CI (`ubuntu`, `macos`, `windows`) rodam o `install` e o `uninstall` reais **no que o runner permite** (ver o P12), sem depender de um logon.

**Arquivos:** `daemon/src/service/**` (novo), `daemon/src/commands/service.ts` (novo) mais uma linha no `COMMANDS` do `cli.ts`, `daemon/src/config.ts` (as chaves), `locales/<idioma>/*.json`, `.github/workflows/dist-service.yml` (novo).

**Aceite:** `install`, `status` e `uninstall` funcionam nos três SOs na CI, o `uninstall` preserva os dados, e o `ot tui` sobe o daemon quando ele não está no ar.

**Como ficou:** a preencher quando o passo for mesclado.

### P4. `.msi` do Windows (WiX): instalar, serviço e desinstalar (§10, N249)

**O que fazer:** um instalador `.msi` **por usuário** (sem administrador), gerado na CI do Windows com o WiX.

- **Conteúdo:** `ot.exe` (o SEA do P1), `ot-job-launcher.exe` (P2) e o `THIRD_PARTY_NOTICES-win32-x64.md` (P10), em `%LOCALAPPDATA%\Programs\OTheater` **[proposta]**; o `ot` entra no `PATH` do usuário.
- **Serviço:** uma ação personalizada do instalador chama `ot service install` (P3) no fim da instalação, e `ot service uninstall` antes de remover os arquivos. A desinstalação **preserva os dados**, como no P3.
- **Fonte WiX:** `installer/wix/Product.wxs` e um script `installer/wix/build.ps1` que roda o WiX na versão fixada (N250), com a versão do produto vinda do `manifest`/`versionOverride`. A licença do WiX e a versão exata ficam documentadas no próprio script **[N: conferir no passo]**.
- **Sem assinatura (N247):** o `.msi` sai sem assinatura. O SmartScreen avisa na primeira execução, e o P11 documenta como seguir. O passo de assinar entra no P11, desligado.
- **Workflow `.github/workflows/dist-msi.yml` [proposta]:** no `windows-latest`, constrói o `.msi`, instala com `msiexec /i ... /qn`, confere os arquivos, o `PATH` e a Tarefa Agendada, roda `ot --version`, desinstala com `msiexec /x` e confere que os arquivos e a tarefa sumiram e que a pasta de dados ficou.

**Arquivos:** `installer/wix/**` (novo), `.github/workflows/dist-msi.yml` (novo).

**Aceite:** instalação e desinstalação limpas no Windows da CI (máquina limpa por run). **Fica para o dono, à mão:** instalar num Windows real, ver o aviso do SmartScreen, sair e entrar na sessão (logon) e conferir que o daemon subiu, o que a CI não faz.

**Como ficou:** a preencher quando o passo for mesclado.

### P5. `install.sh` para macOS e Linux (N248)

**O que fazer:** um script POSIX (`sh`) que baixa do GitHub Releases, confere SHA-256 e Ed25519, instala por usuário e registra o serviço.

- **Fluxo:** descobre `os` e `arch` (`uname`), baixa `manifest.json`, `manifest.json.sig` e o executável da plataforma; confere a assinatura (N253: `openssl`, ou o modo interno `verify-release` com aviso) e o SHA-256 (`sha256sum` ou `shasum -a 256`, o que existir **[V: `sha256sum` e `shasum` existem neste Linux]**); instala em `~/.local/share/otheater/` (o executável) e liga `~/.local/bin/ot` **[proposta]**; chama `ot service install` (P3); imprime o que fez e o que falta (o PATH, os adaptadores ACP da N254).
- **Origem e canal por variáveis do script, não por argumento surpresa:** `OT_INSTALL_BASE_URL` (padrão: o GitHub Releases do repositório, N251) e `OT_INSTALL_CHANNEL` (`stable` ou `beta`). A base alternativa existe para os testes (servidor em loopback).
- **Sem `sudo`**, sem escrever fora do HOME, sem baixar nada além do manifesto, da assinatura e do executável. Falha fechada: qualquer conferência que não passa apaga o que baixou e sai com código diferente de zero.
- **Desinstalar:** o mesmo script com `--uninstall` (ou `ot service uninstall` mais a remoção dos arquivos), preservando os dados (`--purge-data` apaga, com confirmação).
- **Workflow `.github/workflows/dist-install-sh.yml` [proposta]:** em `ubuntu` e `macos`, sobe um servidor de versões em loopback com artefatos assinados por uma chave gerada no teste (P7 e P9 dão o utilitário), roda o `install.sh` e confere os arquivos e o serviço; roda de novo com uma assinatura errada e confere que **recusa**; desinstala e confere.
- **Linting do script:** `shellcheck` quando existir na máquina da CI **[N]** (não é dependência nova do repositório).

**Arquivos:** `installer/install.sh` (novo) e `installer/README.md` (novo, curto), `.github/workflows/dist-install-sh.yml` (novo).

**Aceite:** instalar, recusar assinatura ruim e desinstalar em `ubuntu` e `macos`, na CI. **Fica para o dono, à mão:** o Gatekeeper do macOS real ao abrir o executável sem certificado (o P11 documenta), e o `systemd --user` e o launchd depois de um logon real.

**Como ficou:** a preencher quando o passo for mesclado.

### P6. `ot init` (§5.7, §10)

**O que fazer:** o comando mínimo, **sem perguntas no terminal**: instala o serviço (P3), sobe o daemon, confere se os comandos dos Executores existem e abre a TUI direto no assistente de configuração (§5.7 e §5.12; N121).

- **Passos do comando:** (1) `ot service install` (se o serviço já existe, segue; o comando é idempotente); (2) sobe o daemon e espera a API; (3) confere os clientes no `PATH` e **só mostra** o que falta, com o comando `npm` para o usuário rodar (o OTheater nunca instala um cliente); os adaptadores ACP (`claude-agent-acp`, `codex-acp`) ele instala conforme `clients.adapters.install` (N254 revista, P13: `auto` instala, `ask` pergunta, `command` e `off` só mostram); (4) abre a TUI na aba do assistente (`launchTui` já existe).
- **Idempotência e erros:** rodar duas vezes não duplica o serviço. Se algum passo falha, o comando sai com o motivo e o comando que repete aquele passo, sem desfazer o que deu certo.
- **`--no-tui`** **[proposta]**: faz os passos 1 a 3 e sai, para os scripts (`install.sh` e `.msi`) e para os testes.
- **Eventos e chaves:** nenhuma chave nova; o assistente é do daemon.
- **Passo para adicionar uma conta (N274, 2026-11-22) [proposta; a decisão é do dono]:** a TUI do primeiro uso tem um passo próprio antes da detecção: a pessoa escolhe o cliente, dá o nome da conta e o login começa na hora, pelo mesmo caminho da tecla `L` de Configurações › Assinaturas (o terminal é entregue ao cliente com `useSuspendTerminal`, e o mouse volta depois). O passo é da TUI, não do daemon (a execução do daemon continua em `detect`, `preset`, `executors`, `review`); pode ser pulado com Enter e repetido. Um login que o daemon abriria sozinho (`started`) é cancelado e rodado no terminal com `ot profile exec <id> login`, porque essa tela não recebe eventos. Com `--no-tui` (ou sem terminal) o passo não roda, e o resumo final mostra o comando `ot profile add <cliente> <nome> --login`.
- **Testes:** com o `ServiceManager` falso (P3) e o `fake-agent`: o `ot init --no-tui` cria o serviço falso, sobe o daemon e imprime a lista de adaptadores faltantes, duas vezes seguidas com o mesmo resultado; um teste de TUI confere a abertura na aba do assistente.

**Arquivos:** `daemon/src/commands/init.ts` (novo) mais uma linha no `COMMANDS`, `locales/<idioma>/*.json`.

**Aceite:** do zero, `ot init` deixa o daemon como serviço, no ar, com a TUI no assistente, sem uma pergunta no terminal.

**Como ficou:** a preencher quando o passo for mesclado.

### P7. `updates.*` (1/2): origem, manifesto, SHA-256, Ed25519, canais, `check`, `notify` e `off` (§5.21, N73)

**O que fazer:** tudo que **descobre, baixa e confere** uma versão. Aplicar é o P8.

- **Módulo `daemon/src/updates/`:**
  - `manifest.ts`: o schema zod do manifesto (seção "Formato dos artefatos");
  - `verify.ts`: a conferência da assinatura (`crypto.verify(null, bytes, publicKey, signature)`) e do SHA-256, com a chave pública vinda de **parâmetro**; o executável a embute no build, e os testes passam uma chave gerada no teste;
  - `source.ts`: a origem `github` (ou a base alternativa), com `fetch` injetável e o relógio injetável;
  - `checker.ts`: o laço de verificação periódica e a máquina dos modos.
- **Chaves [proposta], todas só globais (§5.21), sem override por cenário**, no bloco `updates` do `DaemonConfigSchema`:
  - `mode`: `auto | notify | check | off` (padrão `auto`, N73). Neste passo, `auto` baixa e confere, e deixa **pronta**; aplicar é do P8. Sem o P8, o `auto` se comporta como `notify` e diz isso;
  - `channel`: `stable | beta` (padrão `stable`);
  - `source`: `github | url` (padrão `github`), e `url` com `updates.url` (HTTPS; HTTP só em loopback, para teste). A assinatura continua valendo com qualquer origem;
  - `check_interval`: `off | 6h | 24h | ...` (padrão `6h`);
  - o resto das chaves da §5.21 (`apply_when`, `max_wait`, `rollback`, `backup_before_migration`) **entra no P8**.
- **Detecção do tipo de instalação (N248):** se o executável é um SEA (`isSea()`, P1) e está na pasta do instalador (`.msi` ou `install.sh`), é "próprio" e baixa; se roda de um checkout (`node` mais script), age como `check` (só avisa), e diz isso no status. Sem npm nem winget na v1.
- **Evento novo `daemon.update` [proposta]:** payload zod com `phase` (`found | downloaded | verified | rejected | skipped | failed`; o P8 acrescenta `applying | applied | rolled_back`), `version`, `channel`, `reason` (para `rejected`, `skipped` e `failed`: assinatura, SHA-256, tamanho, versão não maior, canal errado, sem rede) e `mode`. Soma **1** à contagem: 150 no protocolo e 152 no registro do daemon **[proposta]**. O aviso para o Produtor vai ao chat global (§5.21) pelo caminho de avisos que já existe.
- **Rotas e TUI:** `GET /v1/updates` (estado: versão atual, a encontrada, o modo, o último motivo de recusa) e `POST /v1/updates/check` (verifica agora) **[proposta]**, com o catálogo `docs/reference/api-routes.json` regenerado; a TUI mostra a versão encontrada na barra de status e a ação "aplicar" quando o modo é `notify` (a ação em si chega com o P8). O texto vai aos catálogos `en` e `pt-BR`.
- **Métricas:** `otheater_updates_checks_total{result}` e `otheater_updates_rejected_total{reason}` no `MetricsCollector` **[proposta]**.
- **Testes (N57, sem nada real):** um servidor de versões em loopback e uma chave gerada no teste. Cobrem: versão boa baixada e guardada; **assinatura de outra chave recusada**; manifesto adulterado depois de assinado recusado; executável com SHA-256 diferente recusado; `size` diferente recusado; versão igual ou menor recusada (sem *downgrade*); canal errado recusado; sem rede (fica `failed`, sem travar a subida do daemon); os modos `check`, `notify`, `off` e `auto` sem o P8.

**Arquivos:** `daemon/src/updates/**` (novo), `protocol/src/events.ts` e o registro de eventos (bloco do `daemon.update`), `daemon/src/config.ts` (bloco `updates`), `daemon/src/api/` (as rotas, bloco novo), `locales/<idioma>/*.json`, `docs/reference/*` (regenerado).

**Aceite:** os casos dos testes acima passam; nenhuma credencial do GitHub é lida; uma assinatura errada nunca chega ao disco de produção. O P7 não troca nenhum arquivo do executável.

**Como ficou:** a preencher quando o passo for mesclado.

### P8. `updates.*` (2/2): aplicar com `apply_when` e `max_wait`, volta automática e backup antes das migrações (§5.21, N73)

**O que fazer:** trocar a versão **sem perder a peça** e voltar se a nova não subir.

- **Layout de instalação [proposta]:** `<pasta>/ot[.exe]` (a atual), `<pasta>/previous/ot[.exe]` (**só uma** anterior, como a §5.21 propõe), `<pasta>/staging/` (a baixada e já conferida pelo P7) e `<pasta>/update-state.json` (o diário de cada etapa).
- **Quem troca [proposta]:** o daemon velho lança o novo executável (de `staging/`) no modo interno `apply-update` (P1), **destacado**, e se desliga de forma limpa. O aplicador espera o processo antigo terminar, grava no diário, renomeia `ot` para `previous/ot` e `staging/ot` para `ot`, e chama `ot service start` (P3) para subir o daemon novo. Isso evita sobrescrever um executável em uso (no Windows, não se apaga nem se sobrescreve um executável em execução **[N: não conferido aqui]**), e a troca é só de renomeação.
- **Checagem de saúde [proposta]:** a nova rota `GET /v1/health` (a API ainda não tem uma, [V: busca nas rotas]) devolve 200 quando a reconciliação da subida terminou sem erro (§5.12) e a API responde. O aplicador espera `updates.health_timeout` (padrão **60 s**) **[proposta]** e, depois da primeira resposta boa, mais 30 s sem queda **[proposta]**.
- **Volta automática (`updates.rollback: auto | off`, padrão `auto`):** se o daemon novo não sobe, ou falha na checagem, o aplicador devolve `previous/ot` (renomeia de volta), **restaura o backup feito antes da migração, quando houve**, sobe o daemon antigo e avisa no chat global. Se o aplicador morre no meio (queda de energia), o próximo início de `ot` lê o `update-state.json` e termina ou desfaz a troca **[proposta]**. `rollback: off` deixa o estado como está e avisa.
- **Backup antes das migrações (`updates.backup_before_migration: true | false`, padrão `true`):** o daemon velho compara os `schemas` do manifesto (store e telemetria) com os seus; se algum é maior, faz um backup no formato do `ot restore`. O `daemon.backup` ganha `trigger: 'update'` (hoje `schedule | manual`, em `protocol/src/api.ts`) **[proposta]**, e a volta depois de uma migração restaura esse backup. Sem o campo `schemas`, o backup é feito.
- **Momento (`updates.apply_when: idle | park | next_start`, padrão `idle`) e o teto (`updates.max_wait`, padrão 24 h):**
  - `idle`: aplica quando não há tentativa rodando, e nesse intervalo o daemon **não começa trabalho novo**; passado o `max_wait`, pergunta ao Produtor por múltipla escolha (§5.3), "estaciona e aplica" ou "espera mais";
  - `park`: a parada limpa. As sessões em curso ficam `awaiting_resume`, a troca conta como "Reinício do daemon ou da máquina" na política por causa (§5.16), sem gastar tentativa, e a volta é por `session/load`;
  - `next_start`: deixa pronta e aplica no próximo início do daemon.
- **Eventos:** o `daemon.update` ganha `applying`, `applied` e `rolled_back`, com a versão e o motivo da volta. Nenhum evento novo além do P7.
- **Testes (N57):** o aplicador roda sobre um diretório temporário com executáveis falsos (scripts de teste) e **ferramentas de arquivo reais**; cobre a troca, a volta por "não sobe", a volta por "saúde falha", a queda no meio (diário) e o backup com uma migração de teste. **[proposta]** A migração de teste é um gancho (`OT_TEST_MIGRATION`) que existe só fora do build de release. A peça em curso usa o `fake-agent`: em `idle`, a peça termina antes da troca; em `park`, a sessão fica `awaiting_resume` e volta por `session/load` **[N: confirmar que o `fake-agent` suporta `session/load`]**.

**Arquivos:** `daemon/src/updates/apply/**` (novo), `daemon/src/api/` (a rota de saúde e a ação de aplicar, bloco novo), `protocol/src/api.ts` (o `trigger: 'update'`), `daemon/src/config.ts` (bloco `updates`, só as chaves novas), o modo `apply-update` no `daemon/src/sea/` (P1, bloco novo), `locales/<idioma>/*.json`.

**Aceite:** os quatro comportamentos da §10: aplica com a peça em curso, sem perdê-la, em `idle` e em `park`; recusa a assinatura errada (herdado do P7); volta sozinho quando a versão não sobe, com o store restaurado do backup da migração.

**Como ficou:** a preencher quando o passo for mesclado.

### P9. Job de release na CI e o portão do R1 (N244, N246)

**O que fazer:** o workflow `.github/workflows/release.yml` constrói, assina e (só se o portão abrir) publica. **Enquanto o portão do R1 está fechado, nenhum release é publicado.**

- **Disparo só manual:** `on: workflow_dispatch`, com os inputs `version`, `channel` (`stable | beta`) e `publish` (booleano, padrão `false`). Não há `push` de tag nem agenda, para uma tag acidental não publicar nada.
- **O portão, em duas travas [proposta]:**
  1. o input `publish` tem de ser `true` (a intenção, por execução);
  2. a **variável de repositório** `OT_RELEASE_GATE` tem de valer `open`. Ausente ou com qualquer outro valor, o portão está **fechado**. Só o dono a cria, depois da confirmação da Anthropic, e a abre pelo `gh variable set` ou pela interface do GitHub.
  - O job `publish` tem `if: inputs.publish == true && vars.OT_RELEASE_GATE == 'open'`. Com o portão fechado, ele nem é criado na execução, e o resumo da execução diz **"portão do R1 fechado: ensaio, nada publicado"**.
  - **[proposta]** uma camada a mais, opcional: o job `publish` usa um *environment* `release` com revisor obrigatório (configuração do dono no GitHub). O plano não depende dela.
- **O ensaio (sempre roda, com o portão fechado ou não):** jobs de construção nas três plataformas (`build-sea`, do P1), o `.msi` (P4), os `THIRD_PARTY_NOTICES` (P10), a montagem do manifesto e a **assinatura com uma chave efêmera** (gerada no job, nunca a de produção), e os testes de instalação em máquina limpa (os workflows dos P4 e P5 reaproveitados contra os artefatos do ensaio). Os artefatos do run ficam por **1 dia** e sem segredo (N252 (a)).
- **A assinatura de produção:** só no job `publish`, com `OT_UPDATE_SIGNING_KEY` (secret, N246). O job confere antes de assinar: (a) o secret existe; (b) a chave pública derivada dele é **igual** à de `tools/release/keys/update-public-key.pem`; (c) o arquivo não é o marcador `PLACEHOLDER`. Se algo falha, o job para antes de criar o release.
- **Quando abrir:** o `publish` cria o release como **rascunho (`draft`)** e só o dono o publica pela interface **[proposta]**, sem automação. Assim, mesmo com o portão aberto por engano, nada fica público sem uma segunda ação.
- **`tools/release`:** `assemble-manifest`, `sign-manifest` (Ed25519 pelo `crypto` do Node) e `verify-manifest` (o mesmo código de `daemon/src/updates/verify.ts`, importado, não copiado), com testes de unidade.
- **Testes:** o `tools/release` tem testes de unidade (assinar e conferir; recusar a chave errada); um teste de forma lê o YAML do workflow e confere que o job `publish` só existe com as duas travas e que **nenhum outro job** tem `contents: write` nem chama `gh release`. O ensaio roda no PR **[proposta]** só com `workflow_dispatch` (não em todo PR, pelo custo).

**Arquivos:** `.github/workflows/release.yml` (novo), `.github/workflows/dist-{sea,msi}.yml` (o `workflow_call`), `tools/release/src/{manifest,sign,verify,install-script,release-cli}.ts` e os testes, inclusive o de forma `release-workflow.test.ts` (novos), `tools/release/src/cli.ts` (o `--version` e os comandos novos), `daemon/src/updates/manifest.ts` (o ativo `notices`).

**Aceite:** um disparo com `publish=true` e **sem** a variável não cria release e diz o porquê; um disparo com a variável e `publish=false`, idem; o ensaio termina verde com os artefatos assinados com a chave efêmera, e o `install.sh` e o `.msi` da CI os aceitam. **Não se publica nada nesta fase.**

**Como ficou:** (2026-11-22)
- **O workflow `.github/workflows/release.yml` [V: lido por um teste de forma]:** só `workflow_dispatch` (sem `push`, sem `schedule`), com `version`, `channel` e `publish` (padrão `false`). O ensaio sempre roda: `plan` (confere versão e canal), `gate` (diz o estado do portão no resumo), `sea` e `msi` (chamam o `dist-sea.yml` e o `dist-msi.yml` por `workflow_call`), `manifest` (monta, assina com chave efêmera, confere como o daemon e guarda os arquivos por 1 dia) e `install-check` (roda o `install.sh` com a chave efêmera embutida, de um servidor em `127.0.0.1`, no Linux e no macOS, e confere que um manifesto alterado sai com código 3).
- **O portão [V: teste de forma]:** o job `publish` tem `if: inputs.publish == true && vars.OT_RELEASE_GATE == 'open'`, é o único com `contents: write` e o único que lê `OT_UPDATE_SIGNING_KEY` e chama `gh release`. Antes de assinar, `check-key` confere o secret, a chave pública derivada (igual à de `tools/release/keys/update-public-key.pem`) e que o arquivo não é o `PLACEHOLDER`; o release sai como `--draft`. Com o portão fechado, o resumo diz "portão do R1 fechado: ensaio, nada publicado" e o motivo (`publish=false`, variável ausente ou com outro valor).
- **`tools/release` [V: testado aqui, com chaves geradas na hora, nenhuma no repositório]:** `manifest.ts` (monta o manifesto dos arquivos de uma pasta, validado pelo `UpdateManifestSchema` do daemon), `sign.ts` (Ed25519 pelo `crypto`; chave efêmera; `checkProductionKey`), `verify.ts` (importa `parseManifest`, `verifySignature`, `parsePublicKey` e `sha256OfFile` do daemon, não os copia; confere também tamanho e SHA-256 dos arquivos), `install-script.ts` (embute a chave no `install.sh`, entre os marcadores do P5) e `release-cli.ts` (os comandos `ephemeral-key`, `assemble`, `sign`, `verify`, `check-key` e `embed-key`; `build` ganhou `--version`). Cobertos: assinar e conferir, chave errada, `PLACEHOLDER`, manifesto adulterado, arquivo trocado, de outro tamanho e ausente, plataforma sem executável, e `sh -n` do `install.sh` com a chave embutida.
- **Acertos no que já existia [V]:** o daemon recusava `kind: 'notices'`, que o `install.sh` (P5) e o P10 já usam; `UPDATE_ASSET_KINDS` ganhou `notices`, com teste. `dist-sea.yml` e `dist-msi.yml` ganharam `workflow_call` com `version` e `upload` opcionais (vazios nos outros eventos, então push, PR e dispatch não mudam) e o grupo de `concurrency` com `github.workflow`. O daemon exporta `updates/manifest` e `updates/verify` para o `tools/release` importá-los; o `yaml` vira devDependency do `tools/release` (só o teste de forma o usa).
- **[N: não verificado, só a CI mostra]:** o ensaio de verdade (um `workflow_dispatch` nunca foi disparado; não se dispara nada nesta fase), o `workflow_call` com a matriz de `dist-sea.yml` e o `upload-artifact`/`download-artifact` entre os jobs, o `install-check` no macOS (depende do `openssl@3` da imagem) e a sintaxe do YAML pelo GitHub (`actionlint` não está nesta máquina; o YAML foi lido por um parser e pelo teste de forma). O `.msi` de P4 não confere assinatura: o que a CI aceita no Windows é a instalação e a remoção; o manifesto assinado é conferido por `verify` e pelo `install.sh`.
- **Para o dono decidir ([proposta]):** (a) o `publish` exige `refs/heads/main` (um passo a mais, fora do plano); (b) o *environment* `release` com revisor, opcional no plano, **não** foi acrescentado (ele pede configuração do dono no GitHub); (c) o executável de `win32-x64` do release vem do job `sea` e o de dentro do `.msi`, do job `msi`: são duas compilações do mesmo commit e da mesma versão, e os bytes podem diferir; (d) o `publish` refaz o manifesto e a assinatura com a chave de produção sobre os mesmos arquivos do ensaio (a `publishedAt` muda) e embute a chave de produção no `install.sh`; (e) o P5 (`install.sh`) entra pelo job `install-check`, e não por `workflow_call` em `dist-install-sh.yml`, que continua testando o serviço de verdade nos PRs.

### P10. `THIRD_PARTY_NOTICES` por plataforma (§6.0, N72)

**O que fazer:** cada build de plataforma gera o seu `THIRD_PARTY_NOTICES` e o leva junto.

- **Gerador:** `tools/verify/src/notices.ts` já gera o arquivo da raiz no Linux **[V]**. Ganha a opção `--platform <linux-x64|win32-x64|darwin-arm64>`, que usa o grafo de dependências de produção **dessa** plataforma (o `.node` do keyring muda por plataforma, e o `better-sqlite3` também **[V: `pnpm-lock.yaml`]**), cruzado com o `metafile` do esbuild do P1 (o que realmente entrou no executável). O arquivo da raiz continua o do Linux, gerado no Linux, como a N72 pediu.
- **Conteúdo:** os pacotes de nível B da §6.0 com nome, versão, licença e o texto da licença. O esbuild, o postject, o WiX e as demais ferramentas de build (nível D) **não** entram. Os crates do lançador do Windows já têm o `native/job-launcher/THIRD_PARTY_NOTICES.md`, e o arquivo do Windows o inclui.
- **Verificação:** `pnpm verify:notices` confere o arquivo da raiz (como hoje) e, com `--platform`, que o arquivo gerado bate com o grafo (sem pacote faltando nem sobrando) para a plataforma da máquina da CI. O `.msi` e o `install.sh` levam o arquivo da plataforma.
- **Chave de build [proposta]:** `release.config.json` → `notices: per_platform | root_only` (padrão `per_platform`).

**Arquivos:** `tools/verify/src/notices.ts` (e o teste), `tools/release/src/notices.ts` (novo), `THIRD_PARTY_NOTICES.md` (só se o conteúdo da raiz mudar).

**Aceite:** os três arquivos são gerados, cada um com o `.node` da sua plataforma e sem as ferramentas de build, e a verificação falha se faltar um pacote.

**Como ficou:** a preencher quando o passo for mesclado.

### P11. Assinatura de código, desligada, por chave; guia de instalação (N247)

**O que fazer:** deixar pronto o passo de assinar, **desligado**, e documentar o aviso que isso causa.

- **Chaves de build [proposta]** em `release.config.json`, e as variáveis de repositório equivalentes na CI: `signing.windows: off | signtool` e `signing.macos: off | codesign` (padrão `off`). Com `signtool`, o `release.yml` assina o `.exe` e o `.msi` com um certificado vindo de secrets (nomes definidos no passo); com `codesign`, assina e notariza o binário do macOS. **Nenhuma conta nem certificado foi criado**: as contas pagas são do dono (N247).
- **A assinatura *ad hoc* do macOS (P1) não é assinatura de código** no sentido desta chave: serve só para o binário arm64 executar. O guia diz isso.
- **Um teste de forma** confere que, com as duas chaves em `off`, os passos de assinatura não rodam, e que, com a chave em `on` e sem o secret, o job falha antes de publicar.
- **Guia `docs/22-INSTALACAO.md` [proposta]:** instalar (Windows, macOS e Linux), o que o aviso do **SmartScreen** (Windows) e do **Gatekeeper** (macOS) significam e como seguir, como conferir o SHA-256 e a assinatura à mão, atualizar (os modos), desinstalar, e o que fazer se o `install.sh` recusar uma assinatura. O guia só afirma o comportamento do SmartScreen e do Gatekeeper **citando a fonte e a data** (regra do repositório), que o passo consulta.

**Arquivos:** `tools/release/**` (as chaves e o teste), `.github/workflows/release.yml` (os passos de assinatura, com as chaves; este é o único passo, depois do P9, a mexer nele), `docs/22-INSTALACAO.md` (novo) e a linha dele no `README.md`.

**Aceite:** com as chaves em `off`, o ensaio do P9 continua verde sem assinar; com elas em `on`, o job se recusa a seguir sem o certificado. O guia está revisado por `pnpm verify:docs`.

**Como ficou** (2026-11-24; nada foi assinado, publicado nem criado: nenhuma conta, certificado, variável ou secret):

- **Chaves [V]:** `tools/release/release.config.json` ganhou `signing: { windows: off | signtool, macos: off | codesign }`, os dois `off`. `tools/release/src/config.ts` valida (chave ausente vale `off`; modo ou subchave desconhecida é erro, nunca um `off` silencioso) e exporta `WINDOWS_SIGNING_MODES` e `MACOS_SIGNING_MODES`. A variável de repositório `OT_SIGNING_WINDOWS` ou `OT_SIGNING_MACOS` vale mais que o arquivo **[proposta]**.
- **`release.yml` [V: a forma; N: nada rodou com certificado real]:** o job `signing` (sem `if`, porque um job que depende de um job pulado é pulado e levaria o manifesto junto) resolve os modos, exige `refs/heads/main` com uma chave ligada **[proposta]** e confere os *secrets* **antes** de `sea` e `msi` (`needs`), falhando com a lista dos que faltam. `sign-windows` (`signtool sign /fd SHA256 /tr ... /td SHA256` e `verify /pa /v`, no `.exe` e no `.msi`) e `sign-macos` (`codesign --options runtime --timestamp`, conferência de que a autoridade é "Developer ID Application", `notarytool submit --wait` com `Accepted`, sem `staple`) rodam entre a compilação e o manifesto e reenviam o artefato com o mesmo nome (`overwrite: true`), então o SHA-256 do manifesto é o do arquivo assinado. Todo passo desses jobs tem `if` na chave. O `if` do `publish` não mudou. Nomes dos *secrets*, `OT_SIGNING_TIMESTAMP_URL` e `tools/release/macos-entitlements.plist` são **[proposta]**.
- **Testes [V]:** `release-workflow.test.ts` confere que, com `off`/`off`, nenhum passo de assinatura roda (as expressões `if` são avaliadas); que cada plataforma só roda com a sua chave; que `signing` precede a compilação, o manifesto e o `publish`; que os *secrets* de assinatura só aparecem nos três jobs de assinatura e o de produção só no `publish`; e **executa de verdade, com `bash`**, os passos de resolver os modos e de conferir os *secrets* (sem secret: código 1 e mensagem com os nomes; com todos: 0 e nada impresso; variável sobre arquivo; modo inválido recusado; fora da `main` recusado). `config.test.ts` cobre o bloco `signing`. Os 139 testes de `tools/release` passam.
- **Guia [V]:** `docs/22-INSTALACAO.md` (instalar, avisos, conferir à mão, atualizar, desinstalar, recusa do `install.sh`, ligar a assinatura) e a linha no `README.md`. **[S]** O SmartScreen e o Gatekeeper só são descritos com a fonte e a data (2026-11-24, [seção 9 do guia](22-INSTALACAO.md#9-fontes-consultadas)). **[V]** Não existe `ot update`: a atualização é o bloco `updates.*` do `config.yaml` e a API `/v1/updates`; o guia lista os modos que existem no código.
- **Ficou [N]:** o `ot.exe` **dentro do `.msi`** sai sem assinatura (é uma compilação separada do `dist-msi.yml`, fora deste passo); os *entitlements* do macOS e a notarização de um binário avulso não foram testados com certificado; `upload-artifact@v4` com `overwrite` (a versão 4.x que o trouxe não está na página consultada); o texto do botão "More info" do SmartScreen e se o `curl | sh` faz o Gatekeeper reclamar.
- **Decidido (N301, 2026-11-24, por múltipla escolha, igual à recomendação):** os nomes dos secrets e das variáveis ficam como estão; a assinatura só roda a partir da `main`; os jobs de assinatura sempre sobem um runner; e a assinatura do `ot.exe` de dentro do `.msi` vira um passo à parte, só quando houver certificado. Os **[proposta]** desses quatro pontos passam a decididos.

### P12. Aceite da fase

O critério da §10, em quatro frases do dono (instalar e desinstalar, fechar a TUI sem interromper a peça, atualizar com uma peça em curso, recusar uma assinatura ruim e voltar à versão anterior), dividido pelo que a CI prova e pelo que fica para o dono. **Cada CI de um sistema conta como máquina limpa** (cada job começa de uma VM nova **[S: documentação do GitHub Actions, não relida nesta rodada]**).

**Automático na CI**, num workflow `.github/workflows/dist-acceptance.yml` **[proposta]** (`workflow_dispatch` e em PR que mexe na distribuição), com o `fake-agent` e um servidor de versões em loopback assinado por uma **chave gerada no teste**:

| Item da §10 | Linux (`ubuntu`) | macOS | Windows |
|---|---|---|---|
| Instalar | `install.sh` contra o servidor de loopback; arquivos, `ot --version`, `ot service status` | idem | `msiexec /i /qn` do `.msi` do ensaio; arquivos, `PATH`, Tarefa Agendada |
| Desinstalar | `install.sh --uninstall`; serviço e arquivos somem, **dados ficam** | idem | `msiexec /x`; idem |
| Fechar a TUI sem interromper a peça; reabrir e achar estado e layout | uma peça do `fake-agent` roda, o processo da TUI é morto, a peça segue até `DONE`, a TUI nova reabre com o layout salvo | idem | idem |
| Atualizar com a peça em curso | versão N instalada, N+1 publicada no servidor (`versionOverride`); em `idle`, a peça termina e então troca; em `park`, a sessão fica `awaiting_resume` e volta | idem | idem |
| Recusar assinatura ruim | assinatura de outra chave, manifesto adulterado, SHA-256 trocado e *downgrade*: tudo recusado, com o evento `daemon.update` `rejected`, e a versão instalada intacta | idem | idem |
| Voltar à versão anterior | N+1 com gancho de falha na subida: volta sozinho para N, com o store restaurado do backup da migração de teste | idem | idem |

Limites da CI **[N: o P12 mede e registra o que o runner não permite]**: não há logon de verdade (o gatilho de logon do serviço não dispara), o `launchctl bootstrap gui/<uid>` e o `systemctl --user` podem não ter sessão. Quando o runner não permite iniciar o serviço, o teste confere o arquivo do serviço e o passo `ot service start` cai para o daemon filho (P3), e o relatório diz qual caminho rodou em cada sistema.

**À mão, pelo dono (a CI não alcança):**
- **Windows real:** instalar o `.msi` do ensaio; ver o aviso do SmartScreen; **sair da sessão e entrar** e conferir que o daemon subiu sozinho e a TUI o encontra; o Job Object com um cliente real (Claude Code ou Codex), matando o daemon e conferindo que o cliente some; desinstalar e conferir que os dados ficaram.
- **macOS real:** o Gatekeeper com o executável sem certificado e o `launchd` depois de um logon real.
- **Linux real:** o `systemd --user` depois de um logon real, e o comportamento sem `linger` (o serviço para quando a última sessão fecha).
- **Origem real:** o download de um release do GitHub Releases de verdade **só depois do R1**, porque nenhum release sai antes (N244). Até lá, a origem `github` é testada por um servidor falso que imita as respostas **[N: o formato real das respostas do GitHub não é testado aqui]**, e o dono confere na primeira publicação, com o portão aberto e o release ainda como rascunho.
- **Nível real `phase10` do `real-acceptance.sh` [proposta]:** uma peça real (Claude Code, haiku) com o daemon instalado pelo `install.sh` num HOME e dados temporários, atualizada no meio por uma versão de ensaio assinada com a chave do teste. Rodado pelo orquestrador, como o `phase9`. Não usa a chave de produção.

**Aceite:** os três jobs verdes na CI com a tabela acima, o roteiro à mão registrado pelo dono (ou pendente, com o motivo) e o critério da §10 cumprido para o que a CI alcança. Ficam registradas como pendências do dono as verificações da lista acima que dependem de máquina real.

**Como ficou** (2026-11-24; nada foi publicado, assinado nem criado: nenhuma variável, secret, tag, release ou serviço):

- **O aceite [V: Linux local e CI]:** `tools/release/src/acceptance.ts` e o comando `otheater-release acceptance` rodam, por fora, contra **dois executáveis únicos reais** (N 1.0.0 e N+1 1.0.1) compilados com a metade pública de uma chave gerada na rodada (`ephemeral-key`), um servidor de versões no loopback assinado por ela e um HOME e uma pasta de dados temporários. A instalação e a desinstalação são o `install.sh` de verdade (P5); no Windows, a cópia para a pasta do usuário (o `.msi` tem o job dele). Os onze passos: instalar; subir o daemon e gravar o layout da TUI; matar a TUI (janela fechada) com o daemon vivo no mesmo pid e reabrir com o layout; recusar **outra chave**, **manifesto adulterado**, **SHA-256 trocado** e **downgrade**, cada um com o evento `daemon.update` `rejected` (motivos `signature`, `signature`, `sha256`, `version_not_newer`) e a versão e o pid intactos; **rollback** (a versão que o executável diz difere da do manifesto, o `/v1/health` não confere, o diário vai a `rolled_back` por `not_started`, o backup é tomado antes da troca e o daemon volta na N); atualização em `idle` e em `park` (diário `committed`, eventos `found`, `downloaded`, `verified`, `applying` e `applied`, executável novo, `previous/` presente); desinstalar com os dados intactos; reinstalar sobre os dados velhos.
- **`.github/workflows/dist-acceptance.yml` [proposta]:** `ubuntu`, `macos` e `windows`, `workflow_dispatch` e PR que mexe na distribuição (`OT_DIST_CI`: affected, full ou off; a variável **não** foi criada). Reaproveita em vez de repetir: o `install.sh` (P5) é o instalador do driver; o `install-sh-real.test.ts` (P5) registra e remove o **serviço real** do runner no Linux e no macOS; o `dist-msi.yml` (P4, que roda o `test-install.ps1`) é chamado num dispatch ou com `OT_DIST_CI=full`, e num PR roda pelos caminhos dele. O job escreve o relatório no resumo da execução.
- **O nível `phase10` do `real-acceptance.sh` [proposta, V: rodado aqui duas vezes, as 11 verificações ok na segunda, 2026-11-24]:** gera a chave, compila os dois executáveis e roda o `acceptance`. **Não usa cliente real, cota, serviço, chaveiro nem a chave de produção**, e não faz parte da suíte do `phase9`: o plano previa uma peça real (Claude Code, haiku) atualizada no meio, e isso **não** foi feito (ver abaixo). Precisa de `OT_SEA_NODE` quando o Node do PATH não é standalone.
- **O nível `phase10-busy` do `real-acceptance.sh` [proposta; N303 (2), 2026-11-24; a rodada real passou [V], abaixo]:** a atualização com uma peça em curso, em `idle` e em `park`, com o Claude Code como cliente real, no mesmo cenário do `phase10` (chave da rodada, os executáveis 1.0.0 e 1.0.1, servidor de versões no loopback, `install.sh` num HOME temporário). O comando é `otheater-release acceptance-busy` (`tools/release/src/acceptance-busy.ts`, que reaproveita os auxiliares do `acceptance.ts`). **Viabilidade [V, por leitura do código; o link com o sandbox `off` não foi provado]:** não precisa de gancho de teste no build de release: antes de subir o daemon, o nível escreve o `config.yaml` (Executor `claude-code/real`, `sandbox.mode: off`, `clients.adapters.install: off`, sem CodeHost) e um link `<dados>/profiles/claude-code/real` para `OT_TEST_CLAUDE_PROFILE_DIR`, que só é apontado, nunca copiado nem lido; o chaveiro e o HOME de verdade não são tocados. Por modo (`OT_TEST_BUSY_MODES`, padrão `idle,park`): instala o 1.0.0, abre um cenário num projeto git com `origin` local, manda a necessidade (`OT_TEST_BUSY_NEED`, pequena) ao Diretor pelo chat e responde as perguntas dele com a primeira opção; **enquanto uma tentativa roda**, publica o 1.0.1 e pede a atualização. Em `idle`, confere o estado `waiting` do `/v1/updates` com a tentativa em curso e que o `applying` vem **depois** do `attempt.submitted` no log (`OT_TEST_BUSY_MAX_WAIT`, padrão 20m, é o `updates.max_wait`); em `park`, a troca vem na hora, com `session.interrupted` (causa `daemon_restart`) e a peça seguindo por `session.resumed` (`native` ou `handoff`) ou por uma tentativa nova da mesma demanda (`OT_TEST_BUSY_RESUME_FORM=any`, padrão; `native` exige o `session/load`). Nos dois: diário `committed`, eventos `applying` e `applied`, executável dizendo 1.0.1, peça em `DONE` com `delivery.completed` e nenhum processo da rodada sobrando; o resumo de cada passo sai com o prefixo `[phase10-busy-real]`, com teto de 90m, as checagens prévias do `phase9` e `OT_SEA_NODE`. **Validação sem cliente real [V, 2026-11-24]:** o roteiro inteiro rodou no executável único, instalado pelo `install.sh`, com o `fake-agent` (`FAKE_AGENT_SCRIPT=role-play`) como comando do cliente atrás de um proxy de stdio de teste que segura o primeiro `session/prompt` por 25 s para a tentativa ficar em curso e troca o modo `acceptEdits` por `default`, que o fake não conhece; `idle` e `park` passaram nos oito passos, e o `phase10` continua com as 11 verificações ok. O proxy e o wrapper não entram no repositório. **Achado [V, fake-agent no SEA; por leitura do código]:** o daemon do release **não** passa o `resolveAttempt` (só os testes o passam), então depois de um reinício toda tentativa em curso vai a `interrupted` (`daemon_restart`, forma `handoff`) e a peça roda a etapa **de novo** como `.../2`; a retomada por `session/load` da N61 (5) e (6) não acontece no produto hoje. Por isso o `park` aceita as duas formas por padrão. **Rodada real [V, local, 2026-11-24, de 21:14 a 21:17 em São Paulo, cerca de 3 min para os dois modos]:** com o Claude Code (modelo `haiku`) em todos os papéis, pelo claude-agent-acp 0.107.0, a necessidade padrão (`fib.js`) e o perfil de teste apontado por link, os dois modos passaram nos oito passos. Em `idle`, a atualização ficou em `waiting` com a tentativa `stage-planning/1` em curso, e o `applying` (evento 117) veio depois do `attempt.submitted` (evento 39). Em `park`, a troca veio na hora, a tentativa foi a `interrupted` (`daemon_restart`) e a demanda rodou de novo como `stage-planning/2`, **sem `session/load`**, como o achado acima previa. Nos dois, o diário ficou `committed`, o executável passou de 1.0.0 a 1.0.1, a peça chegou a `DONE` com uma `delivery.completed`, e nenhum processo da rodada sobrou. O pico de memória ficou em cerca de 3,5 GB. Isso prova também que o cliente lê o perfil pelo link com o sandbox `off`. **Ficou [N]:** a retomada nativa (`session/load`) no `park`, que depende de o daemon passar o `resolveAttempt`; e a rodada com Codex e OpenCode.
- **Caminho do serviço [N: por sistema]:** o daemon do driver é sempre um **processo filho**, nos três sistemas, para a atualização ser a mesma em todos (o serviço de logon não dispara num runner). O serviço real é o do `install-sh-real.test.ts`, e o relatório do job diz se o runner tinha gerenciador de serviço de usuário (`no user service manager here`) ou se registrou e removeu o serviço.
- **Achado [V], resolvido (N303, PR #346, 2026-11-24):** o `install.sh --uninstall` removia o executável e os avisos, mas deixava em `bin/` o que as atualizações criaram (`previous/`, `staging/`, `update-apply.log`, `update-state.json`), e por isso não apagava `bin/` nem a pasta do app; um `previous/` velho sobrevivia a uma reinstalação. Agora ele remove **por nome** (a lista vem de `apply/layout.ts`, `journal.ts`, `trust.ts` e `main.ts`, sem curinga de pasta): `update-state.json` e o `update-state.json.<pid>.tmp` de um escritor que morreu, `update-apply.log`, `previous/<exe>`, `staging/<exe>`, `staging/manifest.json` e `staging/manifest.json.sig`, e depois, com `rmdir`, as pastas que ficarem vazias (`previous/`, `staging/`, `bin/`, a pasta do app). Um arquivo que não é do OTheater em `bin/` ou em `previous/` fica, com a pasta, e o script avisa (mensagem `left_behind`, nas duas línguas); `previous/` ou `staging/` que sejam links não são seguidos. Os dados (store, configuração, arquivos do usuário) ficam, e o `--purge-data` é o de antes. **Linux [V: local]:** 5 testes novos no `install-sh.test.ts` (sobras removidas e dados preservados, arquivo estranho preservado com o aviso, aviso em pt-BR, link não seguido, `--purge-data`; os três que exigem o comportamento novo falham sem a mudança) e o nível `phase10` local, em que a linha "uninstall, the data stays" do `acceptance.ts` agora exige que antes haja `update-state.json` e `previous/` e que depois `bin/` não exista. **Linux, macOS e Windows [V: CI, commit `3505c35`]:** `dist-acceptance.yml` (run 45453938157) com `linux-x64`, `darwin-arm64` e `win32-x64` verdes, e a linha "uninstall, the data stays" ok nos três (no Windows ela só confere a cópia que o próprio aceite apaga; o `.msi` tem o job dele); `dist-install-sh.yml` (45453938282; o job do macOS foi cancelado por falta de runner depois de 39 min na fila e passou na repetição, sem mudar o código), `ci.yml` (45453938185), `dist-sea.yml` (45453938190) e `chaos.yml` (45453938125) verdes. **Windows `.msi` [V: CI, `dist-msi.yml`, run 45453938112]:** as sobras também ficavam na pasta de instalação e impediam o `RemoveFolder` (o Windows Installer só remove o que instalou); o componente `OtUpdateLeftovers` do `Product.wxs` ganhou `RemoveFile` nominais (a única máscara é o `.tmp` do diário) e `RemoveFolder` de `previous` e `staging`, só com elementos do núcleo do WiX (**sem extensão, sem download**), e o `test-install.ps1` cria as sobras antes do `msiexec /x` e confere que elas e a pasta somem. **[N]:** um arquivo estranho na pasta do `.msi` (o Windows Installer deixa a pasta; agora o `test-install.ps1` exercita isso, por decisão do dono em 2026-11-24); o `ot uninstall` **não** limpa as sobras (roda de dentro do executável, que pode não estar numa pasta do instalador, e no Windows não apaga a si mesmo; a pasta de instalação é do `install.sh` e do `.msi`), decidido (N303).
- **Ficou [N]:** (1) **uma peça em andamento no executável real**: o Diretor e os Executores vêm de perfis de um cliente real (`ot profile add` pede a senha do cofre num terminal), então o `fake-agent` não os substitui num SEA; as esperas de `idle` e `park` com uma tentativa em curso são as dos testes de unidade do P8 (`coordinator.test.ts`), e aqui os dois modos rodam com o daemon quieto (o nível `phase10-busy`, acima, cobre o caso com cliente real e passou com o Claude Code em 2026-11-24 [V]); o cenário aberto no chat é só o **layout** da TUI. (2) A **TUI no Windows**: não há pseudo-terminal na CI (a linha "fechar e reabrir" pula lá e o `smoke` do P1 cobre o que dá); (3) o gatilho de logon e a sessão de usuário real; (4) a origem `github` real, só depois do R1.
- **Rodada do orquestrador [V, 2026-11-24]:** a primeira, com o Node do Fedora no PATH (`node-24`, que usa a libnode compartilhada), falhou no `build` (o `postject` não acha o sentinela) e o script **seguiu** e testou um executável velho, com um FAIL enganoso sobre a versão. Corrigido aqui: a geração da chave, os dois `build` e o `acceptance` vão encadeados com `&&`, e um `build` que falha para o nível. A segunda, com `OT_SEA_NODE` apontando para um Node standalone (v24.11.1), passou nas 11 verificações (instalar, primeira subida, fechar e reabrir a TUI, as quatro recusas, o rollback, `idle`, desinstalar e `park`). O `phase10` precisa de um Node standalone; o do pacote da distribuição não serve.
- **Decidido (N303, 2026-11-24):** (1) o `install.sh --uninstall` passa a limpar as sobras de `bin/` (`previous/`, `update-apply.log`, `update-state.json`) e as pastas vazias, sem tocar nos dados, num passo à parte; (2) a atualização com uma peça em curso ganha um teste real (cliente real, `idle` e `park`), num passo à parte, e até lá segue [N]; (3) a `OT_DIST_CI` não será criada: o `dist-acceptance.yml` fica no modo `affected`; (4) o nível `phase10` fica separado do `phase9`.
- **Decidido (N305, 2026-11-24):** a repetição das trocas de arquivo no Windows vira as chaves `updates.apply.fs_retry` (`auto`, `always`, `off`) e `updates.apply.fs_retry_timeout` (15s) num passo à parte; depois do limite, o aplicador desiste com `swap_failed` e volta sozinho. O `-Version` do `dist-msi.yml` no `workflow_dispatch` é corrigido num passo à parte.
- **As chaves da repetição entraram (N305, 2026-11-24, passo à parte):** `updates.apply.fs_retry` (`auto`, `always`, `off`; padrão `auto`, só no Windows) e `updates.apply.fs_retry_timeout` (padrão `15s`; entre `1s` e `5m` **[proposta]**) estão no `UpdatesConfigSchema`; o daemon as grava no diário (`fsRetry`, `fsRetryTimeoutMs`, opcionais) e o aplicador as lê de lá (`realApplyPorts`), com os padrões quando faltam; depois do limite continua `swap_failed` e a volta sozinha. O grupo `apply` é aninhado, como a N305 nomeia, enquanto as outras `updates.*` são planas. A frase "ainda **não** criadas" do item (a) abaixo vale até este passo.
- **CI [V], run 45408775580 (PR #341, commit `1ec708d`):** `linux-x64`, `win32-x64` e `darwin-arm64` verdes. Linux e macOS: os dez passos mais os 75 testes do `install.sh` com o serviço real (`install-sh-real.test.ts` registrou e removeu o serviço do runner; o aviso `no user service manager here` não apareceu em nenhum dos dois, então o caminho foi o do **serviço real**, e o daemon do driver foi o filho). Windows: nove passos (a linha da TUI pula) e o `.msi` é o `dist-msi.yml` (P4), que rodou verde por conta própria (run 45408775593); o job `msi` do aceite só o chama num dispatch ou com `OT_DIST_CI=full`. Os runners macOS e Windows gastaram 6 a 8 minutos cada. O primeiro run falhou no Windows só ao apagar a pasta temporária (`EPERM`); a limpeza passou a tentar de novo e só avisa.
- **Defeito do aplicador no Windows [V: CI]; corrigido (2026-11-24, commits `bd3d0a8`, `42ee21b` e `f8bf628`).** Sintoma: no Windows, o rollback esperava 240 s pelo `rolled_back` (runs 45410914057 e 45418878226), e depois voltou com `reason swap_failed`, quando no Linux e no macOS é `not_started`, e o `apply_when park` esperou 180 s pelo `committed` (45423027329). O diário parava em `starting`, o daemon novo subia, e **não havia `update-apply.log`**: o aplicador morria sem rastro. Causa, em duas partes. (1) **[V]** o Windows recusa com `EPERM` uma troca de arquivo que no Linux e no macOS passa: o log da 45425179099 mostra `rename staging\otheater.exe -> otheater.exe` recusado 14 ms depois do `linked`, em `placeStaged`, o que dava o `swap_failed`; e o aceite corrigido mostrou, nas rodadas 45429281784 e 45431345629, **o `rename` do diário (`.tmp` sobre o diário) recusado com `EPERM`** (uma ou duas vezes por caso) (**[N]** quem segura o arquivo: o daemon ou o aceite lendo o diário, ou o antivírus ou o indexador do runner, por alguns milissegundos). (2) **[V]** o aplicador não tinha `catch` no topo, serializava um `Error` como `{}` e tinha o stdio ignorado, então uma dessas recusas no diário matava o processo sem uma linha de log. **[N]** que foi essa recusa, e não outra, que travou o `starting` das rodadas antigas: ela é a causa provável e a única observada, mas as rodadas antigas não tinham o log que a mostraria.
  **Correção:** (a) `apply/fs-retry.ts` [proposta]: as chamadas de arquivo do aplicador (`rm`, `copyFile`, `rename` da troca, do `previous/` e do diário, e a leitura do diário) repetem com espera crescente (25 ms, dobrando até 500 ms) em `EPERM`, `EBUSY` e `EACCES`, até 15 s; outro erro falha de imediato, como antes. Chaves previstas, ainda **não** criadas na configuração (o esquema não foi tocado): `updates.apply.fs_retry` (`auto`, padrão: só no Windows; `always`; `off`) e `updates.apply.fs_retry_timeout` (padrão 15 s); por ora são a opção `ApplyPorts.fsRetry` e a constante `FS_RETRY_TIMEOUT_MS`. (b) `apply/file-log.ts`: o log do aplicador é síncrono e serializa o `Error` (nome, mensagem, `code`, `syscall`, pilha); o `main.ts` registra a partida, o passo, os `uncaughtException` e `unhandledRejection`, o fim e o código de saída, com um `catch` no topo que sai com `APPLY_EXIT_NOT_APPLIED`; o aviso `update: a file call was refused; trying again` fica no `update-apply.log`. (c) `tools/release/src/acceptance.ts`: o caso do rollback agora **falha** se o `reason` não for `not_started` (antes só o imprimia), e o resultado acrescenta `file calls repeated: <chamada> <código> xN` quando o aplicador repetiu uma chamada. Teste de unidade: `fs-retry.test.ts` (espera `[25,50,100]`, os códigos, o limite de 500 ms e o tempo máximo, os três modos, `placeStaged` ainda falhando de imediato num erro que não é transitório, ida e volta do diário).
  **Verificação [V]:** testes afetados (`vitest run --maxWorkers=2`) e o nível `phase10` local verdes; **três rodadas verdes seguidas do `dist-acceptance.yml` com o mesmo head `f8bf628`**, as três com `linux-x64`, `darwin-arm64` e `win32-x64` verdes e o rollback com `reason not_started` nos três sistemas: **45429281784** (PR), **45431345629** e **45435563450** (`workflow_dispatch`). No Windows, o `rename journal EPERM` foi repetido e passou nos três casos da primeira rodada (4 repetições) e em dois da segunda (2 repetições), e em nenhum na terceira: a repetição realmente dispara na CI, de forma esporádica. O `swap_failed` **não** é legítimo no Windows: era uma recusa transitória que a troca não repetia.
  **Ficou [N]:** (1) a máquina Windows real (antivírus e indexador de verdade; o runner os tem leves); (2) o limite de 15 s: uma recusa mais longa ainda dá `swap_failed`, e a volta automática segue valendo; a alternativa é esperar o processo antigo soltar a imagem (pergunta ao dono); (3) as três chaves acima são [proposta] e não existem na configuração; (4) nas rodadas `workflow_dispatch`, o job `msi` (chamado do `dist-msi.yml`, P4/P9, fora dos arquivos deste passo) **falha** com `Launcher not found: 1.0.0` em `installer/wix/build.ps1`: o `dist-acceptance.yml` o chama com `version: 1.0.0`, e o `dist-msi.yml` passa `-Version` ao `build.ps1` por `@extra` de **array**, que em PowerShell vale como argumento posicional (então `1.0.0` cai no parâmetro `Launcher`; a explicação do mecanismo é [N], o sintoma é [V]). Isso deixa vermelha a execução inteira de um dispatch, sem relação com o aplicador, e **provavelmente afeta o ensaio de release** do P9 (que passa a versão) **[N]**: corrigir com um `hashtable` (`@{ Version = ... }`) no `dist-msi.yml`, num passo à parte.
- **Pendências do dono, à mão:** as da lista acima (Windows, macOS e Linux reais, logon, SmartScreen, Gatekeeper, `linger`, Job Object com cliente real) e a origem real do GitHub Releases depois do R1.


### P13. Adaptadores ACP gerenciados (N254 revista)

**O que fazer:** o OTheater instala o `claude-agent-acp` e o `codex-acp` em `<dataDir>/adapters/`, sem `sudo`, sem mexer no `PATH` e sem redistribuir nada no executável (o `@anthropic-ai/claude-agent-sdk` tem licença comercial: o usuário o baixa do npm).

- **Versões fixas e conferência:** `@agentclientprotocol/claude-agent-acp` 0.107.0 e `@agentclientprotocol/codex-acp` 2.6.0, com o lockfile da subárvore de cada um em `daemon/src/adapters/locks/*.lock.json` (sha512 de cada pacote). O comando `adapter-locks [--check]` do `tools/verify` regera ou confere esses arquivos a partir dos lockfiles npm dos spikes, sem rede; o instalador nunca resolve versões sozinho.
- **Instalador:** baixa cada tarball do registro (`clients.adapters.registry`), confere o sha512, lê o `tar.gz` com um leitor próprio e instala de forma atômica (pasta temporária e `rename`), com trava por arquivo (com retomada de trava velha) e uma marca com o resumo do lockfile. É idempotente: o `ot init` e o daemon instalando juntos é seguro.
- **Execução:** o daemon chama o adaptador pelo caminho absoluto. Dentro do SEA, o modo interno `--ot-internal=run-adapter <entry.js>` carrega o módulo ES com `import()`; fora do SEA, roda `process.execPath <entry.js>`. `CODEX_PATH` e `CLAUDE_CODE_EXECUTABLE` apontam o adaptador para o cliente oficial do usuário, achado no `PATH`.
- **Chaves [proposta]:** `clients.adapters.install: auto|ask|command|off` (padrão `auto`); `clients.<id>.adapter: managed|path|<caminho absoluto>` (padrão `managed`, que cai no `PATH` quando a instalação está desligada ou falhou, com aviso e evento); `clients.adapters.registry` (padrão `https://registry.npmjs.org`).
- **Modos de `install`:** `auto` instala sozinho em segundo plano quando o cliente oficial está no `PATH` e o adaptador falta, com aviso na tela e evento; `ask` pergunta no `ot init` e instala depois de um sim (a pergunta na aba de configurações da TUI **não foi feita neste passo**); `command` só instala pelo `ot adapters install`; `off` nunca instala.
- **Comando novo:** `ot adapters status|install [claude-code|codex]` (`--json` no `status`).
- **Eventos (regra "situações viram eventos"):** `daemon.notice` com os tipos novos `adapter_installing`, `adapter_installed`, `adapter_install_failed`, `adapter_missing` e `adapter_fallback`.
- **Integração:** `enabled: auto` de um cliente vale quando há o cliente oficial e o adaptador (instalado, em instalação ou no `PATH`); os adaptadores de cliente recebem o comando resolvido a cada início de processo (`command` aceita `{cmd,args}` ou uma função); a mensagem `AdapterUnavailable` de `ot profile ... login` diz o que fazer. A camada 3 do sandbox nega a leitura de `<data>`: o novo `SandboxRequest.readPaths` reabre `<data>/adapters`.

**Arquivos:** `daemon/src/adapters/{manager,install,lock,tar}.ts` (novos), `daemon/src/commands/adapters.ts` (novo), `daemon/src/sea/{self-command,main}.ts`, `daemon/src/{clients,compose,config,paths,sandbox-wiring}.ts`, `daemon/src/commands/init.ts`, `daemon/src/profiles/login.ts`, `core/src/ports/sandbox.ts`, `adapters/sandbox-srt/src/policy.ts`, `adapters/client-{claude-code,codex}`, `protocol/src/notice-events.ts`, `tools/verify/src/adapter-locks.ts`, `tools/release/src/smoke.ts`, `locales/{en,pt-BR}/cli.json`.

**Como ficou:** (2026-11-22)
- **[V: testado aqui, com registro falso em `127.0.0.1`, `HOME` e dados temporários, `PATH` injetado]** o instalador (sha512, `tar.gz` cortado ou adulterado, trava, falha de rede com nova tentativa, idempotência); o `AdapterManager` (estados, eventos, reserva no `PATH`, "em instalação, tente de novo"); `selectClients` e a composição (`enabled: auto`); `ot adapters` (status em texto, em JSON e em pt-BR; instalar um ou os dois; `off` recusa com saída 1; cliente ou ação desconhecidos com saída 2; falha de instalação com saída 1); `ot init` (os modos `auto`, `ask` com sim e com não, `command`, `off`, cliente oficial ausente e falha de instalação); o modo `run-adapter` sob o Node comum; as regras do sandbox com `readPaths`; os catálogos `en` e `pt-BR`; `headers`, `credentials`, `catalogs`, `deps` e `adapter-locks --check` do `tools/verify`.
- **Nenhum teste usa o registro real nem o `PATH` real** (esta máquina tem `claude` e `codex` no `PATH`): os testes injetam o registro falso ou o `NO_CLIENTS`, e o `cli-process.test.ts`, que roda o `dist/cli.js` de verdade, ganhou `clients.adapters.install: off` na configuração.
- **[N: não verificado]** o `import()` de um módulo ES do disco dentro de um SEA de verdade: esta máquina só tem o Node da distribuição, sem a "sentinela" do SEA, e o build recusa injetar nele. A etapa `run-adapter` do `smoke` (`tools/release/src/smoke.ts`) foi escrita e fica para a CI (job do P1/P9). Também **[N]** a instalação real do `claude-agent-acp` 0.107.0 e do `codex-acp` 2.6.0 a partir do `registry.npmjs.org` (nada foi baixado), e qual `codex` o `codex-acp` roda: **[V]** o `codex` do `PATH` desta máquina é um script Node (`#!/usr/bin/env node`), que o `codex-acp` pode não aceitar em `CODEX_PATH`; **[N]** se aceita, e se prefere o binário nativo do pacote `@openai/codex`.
- **Limite conhecido:** uma sessão iniciada durante a primeira instalação em segundo plano falha com a mensagem "em instalação, tente de novo"; a seguinte já usa o adaptador instalado.
- **Para o dono conferir ([proposta]):** os nomes e os padrões das três chaves; `auto` como padrão (baixa do npm sem perguntar quando o cliente está no `PATH`); o código de saída 4 do `run-adapter` quando o módulo não carrega; os cinco tipos novos de `daemon.notice`.
- **Para a CI:** a suíte completa (não rodou aqui: o `suite-slot.sh` não existe neste worktree, só os testes afetados), o `smoke` real e as plataformas Windows e macOS.

## Fora desta fase

Ficam depois da v1 (N244, N247, N248):
- o **npm** (`npm i -g`) e o **winget**, e a parte da N73 que os trata como canais que só avisam;
- a assinatura de código com certificado (Windows e macOS) e a notarização: o passo está pronto e desligado (P11);
- o **modo produto** da distribuição (N2): a decisão depende da resposta da Anthropic;
- o app desktop (Fase 13), a interface web (Fase 12) e o endurecimento (Fase 11, com os testes de caos de atualização e de queda de energia);
- `linux-arm64` e `darwin-x64` (fora da v1 pela N255);
- a publicação do primeiro release, que depende do R1.

## Decisões deste plano

Estado em 2026-11-22. As decisões de partida (N244 a N249) já estão decididas pelo dono e aparecem na seção "Decisões de partida". As seis perguntas novas abaixo foram **decididas pelo dono em 2026-11-22**, por múltipla escolha, todas na opção recomendada (docs/13):

| Decisão | Decidida (2026-11-22) | Alternativas não escolhidas |
|---|---|---|
| N250, versões fixas | (a) esbuild 0.28.2, postject 1.0.0-alpha.6, WiX série 6 com a versão fixada no P4 | (b) esbuild 0.28.1; (c) o dono escolhe o WiX antes |
| N251, origem das versões | (a) o próprio repositório, em GitHub Releases | (b) um repositório só para as versões |
| N252, artefatos do ensaio | (a) o ensaio guarda os artefatos por 1 dia, com chave efêmera | (b) o ensaio não sobe artefato |
| N253, verificação do `install.sh` | (a) `openssl` se suporta Ed25519, senão o modo interno, com aviso | (b) exigir o `openssl`; (c) só o SHA-256 no script |
| N254, adaptadores ACP (revista em 2026-11-22) | o OTheater instala em `<dataDir>/adapters/` (npm, versão fixa, sha512), roda com o Node embutido; a v1 original: (a) pré-requisito externo | (b) o instalador roda o `npm`; (c) empacotá-los no executável |
| N255, plataformas da v1 | (a) `linux-x64`, `win32-x64` e `darwin-arm64` | (b) mais `linux-arm64` e `darwin-x64` |

Detalhes deste plano marcados **[proposta]** que **não** viraram pergunta (decididos como o mais conservador, para o dono rever): o layout de instalação e a troca por renomeação (P8); o prazo de 60 s da checagem de saúde; o serviço sem `linger` no Linux; a Tarefa Agendada no Windows; o release como rascunho; o formato do manifesto e a assinatura sobre os bytes exatos; os nomes das chaves (`updates.*`, `service.*`, `processes.windows_launcher`, `tui.start_daemon`, `signing.*`, `notices`); a variável `OT_RELEASE_GATE`; o `OT_DIST_CI`; a assinatura *ad hoc* no macOS arm64.
