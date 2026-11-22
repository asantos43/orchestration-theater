# 20. Plano da Fase 9

Versão 4, de 2026-11-22 (a versão 1 era de 2026-11-21, antes das decisões N232 a N241; a 2 não tinha o P14, da N242; a 3 era o plano de partida; a 4 registra o que os passos mesclados fizeram, no "Como ficou" de cada um). Este documento divide em passos a Fase 9 da [arquitetura](framework-ideas/arquitetura.md) (§10, "Fase 9 — Plugins"), com o desenho da §5.14 e o item 29 da §12 (N133). Para cada passo, ele diz o que pode correr em paralelo e qual é o aceite. A arquitetura continua sendo a referência: se este plano divergir dela, vale a arquitetura e o plano é corrigido.

A fase começa depois do fim da Fase 8 (decisões N224 a N231, de 2026-11-21). Pela N231, os PRs desta fase mesclam sem ok por PR, com a CI verde e squash. O que depende do dono fica para o fim da fase.

O fechamento da Fase 7 depende do roteiro dos terminais e do login oficial (N209, PR #262). O dono faz os dois em paralelo, e eles não seguram esta fase.

O plano traz dois passos curtos que a Fase 8 deixou para cá:
- a árvore única de spans (N230 (2));
- as métricas da espera e dos lotes recusados (N225 (2) e (3)).

O plano levantou dez decisões novas, N232 a N241 ([docs/13](13-DECISOES-EM-ABERTO.md)). O dono as decidiu em 2026-11-21, por múltipla escolha, todas iguais à recomendação, menos a N236: ele escolheu as três origens de instalação (pasta, npm e git), sem scripts de ciclo de vida. O resumo está em "Decisões deste plano", no fim.

## Como usar

- Cada passo tem uma branch e um PR com título "Fase 9: ...". A branch parte da main. Não há branch sobre branch: o passo que depende de outro só começa depois do merge dele (fila de PRs, 2026-11-21). O PR que conclui um passo também muda o estado dele na tabela de passos.
- O merge é feito pelo `merge-pr.sh`, com squash, depois da CI verde. Vale a CI do próprio head ou a de uma rodada verde da mesma árvore (`ci-tree.sh`). Nunca se usa `gh pr merge --auto`.
- Todo passo exige, além do aceite próprio, `build`, `lint`, `format:check`, `test`, `verify` e `deps` verdes na máquina e na CI. Os jobs `cross` e `windows-launcher` rodam nos PRs que mexem em código (N162).
- O que está marcado **[proposta]** é detalhe deste plano, ainda sem decisão. Todo padrão novo vira uma chave de configuração, com um padrão e os seus modos.
- Paralelismo:
  - passos sem dependência entre si correm ao mesmo tempo, cada um no seu worktree;
  - dois passos nunca mexem nos mesmos arquivos. As exceções são as das fases anteriores, e em cada uma o passo acrescenta só o seu bloco:
    - o `DaemonConfigSchema` (`daemon/src/config.ts`);
    - o índice do protocolo e o registro de rotas, com o catálogo `docs/reference/api-routes.json` regenerado;
    - o catálogo de eventos;
    - o `compose.ts`;
    - os catálogos `locales/<idioma>/*.json`;
  - no máximo dois subagentes rodam a suíte completa ao mesmo tempo.
- **Nada real roda nos testes (N57).** Os plugins dos testes são o plugin de exemplo (P9) e servidores MCP de teste do próprio processo. Os clientes são o `fake-agent`. As rodadas reais ficam no nível real do aceite (P13).
- **Nenhum download novo sem decisão do dono.** O único aprovado é o cliente MCP oficial, com as transitivas (N232 (a)); ver "Dependências novas".
- **Nenhum código de plugin roda no daemon nem na interface (§5.14, P5).** O servidor do plugin é um processo à parte. O painel é dado validado por schema.

## Ponto de partida

Conferido no código em 2026-11-21, no commit `fd6e26d` **[V]**. Os caminhos são relativos a `packages/`.

- **Manifesto e registro de plugins:** não existem. Não há schema de `plugin.yaml`, validador, pasta de plugins instalados nem comando `ot plugin`.
  - O `DaemonConfigSchema` é `strictObject`, então as chaves `plugins.*` e `flows.*` entram com os passos que as usam.
  - Os registros do daemon (`daemon/src/registries.ts`) são congelados na subida; o comentário diz "Plugin entries join here when the plugin steps arrive".
- **Ferramentas:**
  - o registro (`core/src/registries/tools.ts`) usa `TOOL_EFFECT_CLASSES = ['none', 'worktree', 'external_write']`. O manifesto da §5.14 usa `read | local_write | network | external_write`, e essa divergência é a N237;
  - o servidor MCP do framework (`daemon/src/mcp/server.ts`, nome `otheater` em `mcp/access.ts`) filtra as ferramentas por `tool.roles.includes(role)` e liga os handlers por nome;
  - a política do papel só concede o servidor `otheater` (`execution/attempt-runner.ts`, perto da linha 1204).
- **Eventos:** `PLUGIN_EVENT_PREFIX = 'plugin.'` e a checagem do prefixo já existem (`core/src/registries/events.ts`). Nenhum evento `plugin.*` está registrado.
- **Fluxos:**
  - o registro (`core/src/registries/flows.ts`) só descreve os fluxos oficiais `play`, `task.define` e `task.run`, com os papéis e as ferramentas, e tem o `validateFlows`;
  - a máquina do pipeline é fixa (XState). Não há interpretador declarativo nem chave `flows.<id>` ou `scenario.flow` (N133, item 29 da §12).
- **Cofre:** a porta `SecretVault` (`core/src/ports/secret-vault.ts`) existe, mas não há convenção de chave para plugin.
- **SDK:** o `@otheater/sdk` (`sdk/src`) só exporta as suítes de conformidade e o `harness`.
- **TUI:**
  - o teste do registro de abas (`client/src/ui/registry.test.ts`) já registra uma aba `plugins` (F6, ordem 70) num registro de teste;
  - o registro padrão (`client/src/ui/default-registry.ts`) não tem a aba, e o `tab-content.ts` não a desenha;
  - não há rota `/v1/plugins`.
- **MCP:**
  - no `pnpm-lock.yaml` estão o `@modelcontextprotocol/server` 2.4.0, o `@modelcontextprotocol/node` 2.1.2 e o `@modelcontextprotocol/core` 2.4.0;
  - o `core` traz só os schemas zod do protocolo, sem classe de cliente nem transporte;
  - não há cliente MCP no repositório.
- **JSON Schema:** não há validador direto. Há só o `ajv@6`, transitivo. O zod 4 tem `z.toJSONSchema`, mas não o caminho inverso.

## Dependências novas

Dados do registro npm, consultados em 2026-11-21 **[S]**. A regra é a das fases anteriores: só entra versão publicada há pelo menos duas semanas.

| Pacote | Versão | Licença | Publicada | Passo | Observação |
|---|---|---|---|---|---|
| `@modelcontextprotocol/client` | 2.4.0 | Apache-2.0 | 2026-10-23 | P5 | Aprovado pela N232 (a), em 2026-11-21. Mesmo monorepo e versão do `server` que o daemon já usa; depende do `@modelcontextprotocol/core` 2.4.0, já no lock. Traz como transitivas novas `jose` 6, `eventsource` 3, `eventsource-parser` 3 e `pkce-challenge` 5, todas MIT; o `cross-spawn` 7 e o `zod` já estão no lock |
| `ajv` | 8.x | MIT | a fixar | P5 | Não entra: a N233 ficou na (a), e os argumentos são validados pelo servidor do plugin |

## Passos

| Passo | Título | Depende de | Pode correr junto com | Estado |
|---|---|---|---|---|
| P0 | Plano e decisões (este documento) | nada | P1, P2 | feito (#263, ce95ab9) |
| P1 | Árvore única de spans (N230 (2)) | nada | P0, P2, P3 | feito (#265, 99220d9) |
| P2 | Métricas da espera e dos lotes recusados (N225 (2) e (3)) | nada | P0, P1, P3 | feito (#264, 6fde2b6) |
| P3 | Manifesto: schema, validador e JSON Schema gerado (N233, N237) | P0 | P1, P2 | feito (#266, bfc6cb1) |
| P4 | Registro, instalação e ativação por projeto (N235, N236) | P3 | P5, P9, P12 | feito (#272, 4c3460c; #277, 535c1f7) |
| P5 | Cliente MCP, processos dos plugins e agregação (N232, N234, N238) | P3 | P4, P9, P12 | feito (#273, a064ce1; #278, 6a0fd77) |
| P6 | Permissões geradas do manifesto (N237) | P4, P5 | P7, P8 | feito (#276, c0a7c7b) |
| P7 | Segredos do plugin no cofre (N239) | P5 | P6, P8 | feito (#274, 2a87ecb) |
| P8 | Eventos `plugin.<id>.*` e eventos do ciclo dos plugins | P4, P5 | P6, P7 | feito (#275, d27a3dd) |
| P9 | `@otheater/sdk` para plugins e o plugin de exemplo (N240) | P3 | P4, P5, P12 | feito (#271, 43908f2) |
| P10 | Rotas `/v1/plugins`: lista, painel e ação | P6, P8 | P12 | feito (#279, 6b6e0f3) |
| P11 | Aba Plugins da TUI (F6) com o painel declarativo | P10 | P12 | em curso |
| P12 | Fluxos por configuração: `flows.<id>` e `scenario.flow` (N133, N241) | P3 | P4 a P11 | feito (#270, ff36aab) |
| P14 | Troca manual do Diretor pela TUI e por `/director` (N242) | nada | P3 a P12 | feito (#269, 27c1185; plano #268, 303c334) |
| P13 | Aceite da fase | todos | nada | a fazer |

Ondas **[proposta]**:
- **onda 1:** P0, P1, P2 e P3;
- **onda 2:** P4, P5, P9, P12 e P14;
- **onda 3:** P6, P7 e P8;
- **onda 4:** P10 e depois P11;
- **fim:** P13.

O P12 só depende do validador do P3. Ele mexe no pipeline e na configuração do cenário, não no código dos plugins.

O P14 (N242, pedido do dono em 2026-11-21) não depende dos plugins. Ele mexe no Diretor, nos comandos `/` e no chat da TUI; com o P12, divide só a configuração do cenário, com blocos novos de cada lado.

### P1. Árvore única de spans (N230 (2); §5.11)

- O daemon passa ao cliente o `otheater.trace_id` da tentativa, pelo `resourceExtras` que o receptor já tem (`telemetry/client-telemetry.ts`). Hoje o `daemon.ts` não o passa.
- O receptor põe os spans do cliente sob o span da sessão ou da tentativa no trace do daemon:
  - o `traceId` passa a ser o do daemon;
  - o span-raiz do cliente ganha como pai o span da sessão;
  - a hierarquia interna dos spans do cliente fica;
  - os ids originais do cliente ficam em atributos (`otheater.client.trace_id` e `otheater.client.parent_span_id`) **[proposta]**.
- Chave `telemetry.receiver.reparent: session | off`, com padrão `session` **[proposta]**. Os spans de uma sessão desconhecida ficam como chegaram.
- **Aceite:** com o `fake-agent`, os spans do cliente aparecem na árvore do daemon, sob a sessão. Com `off`, nada muda. A rota de spans da peça, a exportação OTLP e o ATIF continuam válidos.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #265 (99220d9) [S: descrição do PR; a chave foi conferida na main]. Arquivos: `packages/daemon/src/telemetry/reparent.ts` (novo), `receiver.ts` e `daemon.ts`. O receptor reparenta os spans do cliente para o trace do daemon (`traceIdForAttempt`), sob o span da sessão (`sessionSpanId`) ou, sem ele, o da tentativa. Os ids originais ficam em `otheater.client.trace_id` e `otheater.client.parent_span_id` **[proposta]**. Os logs seguem os spans, e `traceResourceExtras` põe `otheater.trace_id` no recurso que o cliente recebe. Chave `telemetry.receiver.reparent: session | off`, padrão `session` [V: `config.ts`]. A rota `GET /v1/plays/:playId/spans` da peça segue só com os spans do daemon; a exportação OTLP e o ATIF não mudaram. Sem evento e sem métrica novos.

**Divergências:**
- o PR avisa dois limites que o plano não tinha: um pai remoto, que nunca chegou ao daemon, continua órfão; e com `telemetry.daemon_spans` desligado o span pai não existe [S];
- o aceite foi com o `fake-agent`; um cliente real (Claude Code, Codex, OpenCode) não foi rodado neste passo [N].

### P2. Métricas da espera e dos lotes recusados (N225 (2) e (3); §5.11)

- A espera vira métrica, derivada dos eventos `wait.started` e `wait.ended`, sem fonte nova. Os nomes seguem o estilo das dez métricas `otheater_*` **[proposta]**:
  - o gauge das esperas abertas por `kind`;
  - o contador das esperas por `kind` e desfecho;
  - a soma dos segundos por `kind`.
  Só contam as esperas acima de `events.wait_threshold`.
- Um contador dos lotes do receptor por motivo de recusa (`format`, `size`, `token`), lido do `stats` do receptor.
- As séries saem no `/metrics` e na exportação OTLP de métricas.
- **Aceite:** o `/metrics` mostra as séries novas com valores coerentes com os eventos e com o `stats`. As dez métricas existentes não mudam.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #264 (6fde2b6) [S: descrição do PR; os nomes das séries foram conferidos em `metrics.ts`]. Séries novas no `/metrics` [V]:
- `otheater_waits_active` (gauge, por `kind`);
- `otheater_waits_total` (contador, por `kind` e `outcome`);
- `otheater_wait_seconds_total` (contador, por `kind`);
- `otheater_telemetry_batches_rejected_total` (contador, por `reason`: `format`, `size`, `token`).

As esperas vêm dos eventos `wait.*` (`metrics-events.ts`) e os lotes recusados vêm do `stats` do receptor (fonte `receiver` em `metrics.ts`). Só contam as esperas acima de `events.wait_threshold`, e `waitedMs` é a espera inteira. `MAX_OPEN` limita a memória das esperas abertas. Os contadores zeram ao reiniciar (N225 (4)). Nenhuma chave nova.

**Divergências:**
- o plano dizia que as séries saíam também na exportação OTLP de métricas. Elas saem só no `/metrics`: a exportação OTLP não usa o `MetricsCollector` [S]. Se o dono quiser as séries no OTLP, é um passo novo;
- a espera pela escolha do Executor (`demand.waiting` e `scenario.director_waiting`) não é um evento `wait.*` e ficou fora das séries. É pergunta para o dono [S].

### P3. Manifesto: schema, validador e JSON Schema gerado (N233, N237; §5.14)

- **Schema zod** do `plugin.yaml`, com versão própria (`manifest_version: 1`) **[proposta]**. Os campos são os da §5.14:
  - `id` (o mesmo padrão dos ids de fluxo) e `version` (semver);
  - `server`: `type: stdio` com `command` e `cwd` relativo à pasta do plugin, ou `type: http` com `url` em loopback;
  - `tools[]`, cada uma com:
    - `name` e `roles`;
    - `specialties` (opcional);
    - `effects`, no vocabulário que a N237 escolher;
    - `requires_producer_approval`;
  - `secrets[]` e `events[]`;
  - `panel[]` com os blocos `table`, `list`, `metrics` e `action`;
  - `i18n`, com o catálogo `en` obrigatório (§5.22).
- **Regras além do schema:**
  - a `source` de um bloco tem de ser uma ferramenta do próprio plugin com efeito de leitura;
  - a `tool` de uma `action` tem de ser do próprio plugin;
  - um nome de evento não pode trazer o prefixo, que o daemon acrescenta (`plugin.<id>.<nome>`);
  - todo texto de tela é uma chave do catálogo do plugin;
  - os nomes das ferramentas não podem colidir com os das ferramentas do framework.
- **JSON Schema gerado** pelo `z.toJSONSchema`, em `docs/reference/plugin-manifest.schema.json`, conferido pelo `pnpm verify:*` como os outros catálogos, para editores e autores de plugin.
- O validador fica num lugar que o daemon, o SDK (P9) e os fluxos (P12) usam: `core/src/plugins/manifest.ts` **[proposta]**.
- **Aceite:**
  - o manifesto da §5.14 valida;
  - cada regra tem um teste de recusa, com a mensagem apontando o campo;
  - o JSON Schema gerado bate com o arquivo do repositório.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #266 (bfc6cb1) [S: descrição do PR; o script e o arquivo gerado foram conferidos na main]. O validador está em `packages/core/src/plugins/` (`manifest.ts` e `manifest-schema.ts`), com `parsePluginManifest` e `parsePluginManifestText`; este recebe o leitor de YAML por injeção (o daemon passa o `yaml`), para o núcleo não depender dele. Pontos:
- `manifest_version: 1` **[proposta]**;
- `id` no padrão `^[a-z][a-z0-9_-]{0,63}$`; `i18n` só é obrigatório quando há painel; `command` é uma lista de argumentos; texto de até 256K;
- as regras além do schema, cada uma com teste de recusa e mensagem apontando o campo: nome duplicado, evento com o prefixo `plugin.`, `source` que não é uma ferramenta de leitura do plugin, `tool` de `action` fora do plugin, catálogo `en`, `cwd` relativo sem `..`, `http` só em loopback e sem credenciais, e colisão com as ferramentas do framework;
- vocabulário de efeitos (N237): `TOOL_EFFECT_CLASSES` passou a `read | local_write | network | external_write`. Foi um renomear um a um (`none` virou `read`, `worktree` virou `local_write`) e `network` é novo. O `network` pede chave de idempotência, como o `external_write` **[proposta]**;
- JSON Schema em `docs/reference/plugin-manifest.schema.json`, gerado por `pnpm plugin:schema` [V: `package.json`] e conferido por teste (`toMatchFileSnapshot`).

**Divergências:**
- o plano deixava o vocabulário para a N237; o PR renomeou o antigo um a um, em vez de manter dois [S];
- `http_get` e os `browser_*` do framework seguem `read` no código, enquanto a §5.19 os lista como `network`. É pergunta para o dono [S];
- ficam para o dono: aceitar a chave de idempotência no manifesto e tornar `manifest_version` obrigatório [S].

### P4. Registro, instalação e ativação por projeto (N235, N236; §5.14)

- **Comandos** `ot plugin install <origem> | list | remove <id> | enable <id> --project <p> | disable <id> --project <p>`. Pela N236, a origem pode ser:
  - uma pasta local (`ot plugin install ./meu-plugin`). O daemon guarda o caminho e o hash do manifesto em `<dados>/plugins.json` **[proposta]**, sem copiar a pasta;
  - um pacote npm (`npm:<pacote>@<versão>` **[proposta]**), instalado em `<dados>/plugins/<id>/<versão>/` **[proposta]** com `--ignore-scripts`. A versão é exata, e o registro guarda a versão e o hash do pacote;
  - um repositório git (`git:<url>#<ref>` **[proposta]**), clonado sem hooks e fixado no commit que o `<ref>` tinha na instalação, que o registro guarda.
  - Nenhuma origem roda scripts de ciclo de vida (N236, pergunta seguinte): o plugin já vem pronto, com o `dist` incluído.
  - Chave `plugins.install.sources: [path, npm, git]` **[proposta]**, para limitar as origens aceitas.
  - Chave `plugins.install.npm` (padrão `auto`) **[proposta]**: como o npm é iniciado, sem shell. No Windows o `npm` é `npm.cmd`, que o Node não inicia sem shell (correção de segurança de 2024 [S]); então `auto` roda o `node` do daemon com o `npm-cli.js` que vem junto dele (`<pasta do node>\node_modules\npm\bin\npm-cli.js`, layout do instalador e do zip do Node [S]). A chave aceita o caminho de um `npm-cli.js` ou de um programa npm. Fora do Windows, `auto` é o `npm` do PATH.
  - Atualizar (`ot plugin update <id>` **[proposta]**) é instalar de novo. Se o manifesto mudar, o plugin fica desligado até o Produtor aprovar de novo; isso vale também para a pasta local editada.
- **Ativação por projeto:** `projects.<p>.plugins: [<id>]`, ou uma lista por projeto no registro **[proposta]**. Ao ativar, o Produtor vê:
  - as ferramentas, com os papéis e os efeitos;
  - os segredos pedidos;
  - os eventos.
  É o mesmo texto que a TUI mostra no P11.
- **Registros:** pela N235 (a), os plugins instalados entram nos registros da subida. Instalar, remover, ativar ou desativar troca o retrato congelado por um novo, de uma vez. A sessão em curso segue com o retrato com que abriu.
- **Aceite:**
  - instalar, listar, ativar, desativar e remover;
  - instalar das três origens: uma pasta, um tarball feito com `npm pack` de uma fixture e um repositório git local (`file://`), sem rede;
  - um pacote com script `postinstall` e um repositório com hook instalam sem rodá-los;
  - manifesto inválido recusado com a mensagem do P3;
  - manifesto mudado desliga o plugin;
  - a troca a quente não altera uma sessão aberta.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #272 (4c3460c) [S: descrição do PR; as chaves e os arquivos foram conferidos na main]; o PR #277 (535c1f7, 2026-11-22) é parte do passo. Arquivos em `packages/daemon/src/plugins/`: `registry.ts` (`<dados>/plugins.json`, escrita atômica, modo 0600, trava e `fs.watch` com debounce), `install.ts`, `install-sources.ts`, `sources.ts`, `manifest-file.ts`, `activation-text.ts` e `command.ts` (`ot plugin install | list | update | remove | enable | disable`). O `RegistryHolder` (`registries.ts`) troca o retrato congelado por um novo e aceita `contribute()` (usado pelo P8). Pontos:
- regra central: um plugin só está ativo num projeto enquanto o hash de `plugin.yaml` no disco for igual ao hash aprovado para o projeto. O `enable` aprova o hash mostrado e dá `Conflict` se ele mudar no meio;
- a interface para o P5: `ActivePlugin {id, version, manifest, dir, manifestHash}`, `registry.activeFor(project)`, `onChange` e `refresh()`;
- instalação: npm com `--ignore-scripts`, versão exata e ambiente filtrado; git com `core.hooksPath`, `--template=`, `protocol.ext.allow=never`, lista de URLs (https, ssh, scp e `file://`), commit fixado e `.git` removido [S];
- chaves `plugins.install.sources` (`path`, `npm`, `git`), `plugins.install.timeout` (padrão 5 minutos) e `plugins.install.npm` (padrão `auto`) [V: `config.ts`];
- #277: o `PluginRegistry` passou a gravar com `writePrivateFileAtomic` (`@otheater/client/node`), que repete o renomear até 5 vezes, com espera dobrada a partir de 10 ms, nos erros `EPERM`, `EACCES` e `EBUSY` do Windows. Corrigiu um teste instável no Windows [S].

Escolhas **[proposta]** do PR, para o dono: a lista de ativação fica em `plugins.json` e não na configuração; instalar um id existente dá `Conflict`; `npm:` exige versão exata e o manifesto tem de trazer a mesma versão do pacote; `git:` sem ref usa o ramo padrão, e `http://`, `git://` ou senha na URL são recusados; `remove` apaga a pasta instalada; `plugins.json` fica fora dos backups; a trava velha vale 60 s e o debounce é de 200 ms; um `plugins.json` corrompido deixa todos os plugins desligados; os comandos funcionam com o daemon no ar; qualquer byte mudado no manifesto pede nova aprovação.

**Divergências:**
- o corpo do PR não cita a chave `plugins.install.npm`, que o plano previa e o código tem [V];
- a forma do `update` e as escolhas acima eram **[proposta]** no plano e ficaram assim;
- o aceite com um pacote com `postinstall` e um repositório com hook foi coberto pelos testes de instalação do PR [S]; nada foi rodado com npm ou git de rede.

### P5. Cliente MCP, processos dos plugins e agregação (N232, N234, N238; §5.14)

- **Cliente MCP** para falar com o servidor do plugin: pela N232 (a), o `@modelcontextprotocol/client` 2.4.0. Na v1:
  - `stdio`;
  - `http` só em loopback e sem autenticação **[proposta]**.
- **Processos:** pela N238 (a), um processo por plugin e projeto.
  - Sobe no primeiro uso e para depois de `plugins.idle_timeout` (padrão `10m`) **[proposta]**.
  - Se cair, volta com espera crescente. Depois de `plugins.max_restarts` falhas seguidas (padrão 3) **[proposta]**, fica parado e gera evento (P8).
  - O processo herda só um ambiente mínimo, mais os segredos do P7. Ele nunca recebe o ambiente do daemon nem os tokens dos perfis.
- **Agregação:** pela N234 (a), no próprio daemon.
  - As ferramentas do plugin ativo no projeto aparecem no servidor MCP do framework (`otheater`), com nome `<id>__<ferramenta>` **[proposta]**, filtradas por papel como as do framework.
  - A chamada vai ao processo do plugin, com prazo (`plugins.call_timeout`, padrão `60s`) **[proposta]**.
  - O resultado volta ao Executor como veio.
  - Nada de 1MCP.
  - **Ligação com o registro do P4** **[proposta]**: o daemon abre o `PluginRegistry` antes do servidor MCP e o usa como fonte dos plugins ativos do agregador (`options.plugins` segue como substituto dos testes). O `watch()` do registro cuida de `plugins.json`; antes de cada sessão tirar o seu retrato dos plugins, o daemon chama `registry.refresh()`, para ver também uma pasta local cujo `plugin.yaml` foi editado. Ao fechar, o servidor MCP para o agregador e os processos antes de o registro parar de observar o arquivo.
- **`tools/list` do plugin:** o daemon confere o retorno contra o manifesto. Uma ferramenta que o servidor expõe e o manifesto não declara fica de fora, com aviso e evento. Uma declarada que o servidor não expõe fica indisponível.
- **Aceite**, com um servidor MCP de teste em stdio:
  - a ferramenta declarada aparece para o papel certo e não para os outros;
  - a chamada chega e volta;
  - o prazo estoura com erro de ferramenta;
  - a queda e a volta funcionam, e o processo para depois das falhas seguidas;
  - o processo para ocioso;
  - o processo não vê o ambiente do daemon.

**Como ficou:**

**Estado:** feito em 2026-11-21, PR #273 (a064ce1) [S: descrição do PR; as chaves foram conferidas em `config.ts`]; o PR #278 (6a0fd77, 2026-11-22) completou o ambiente do processo. Dependência nova: `@modelcontextprotocol/client` 2.4.0 (transitivas `eventsource` 3.0.7, `eventsource-parser` 3.1.1, `jose` 6.2.18 e `pkce-challenge` 5.0.2; o `THIRD_PARTY_NOTICES.md` foi regenerado). Arquivos em `packages/daemon/src/plugins/`: `mcp-client.ts`, `process-pool.ts`, `aggregate.ts` e `runtime-config.ts`, mais a agregação em `mcp/server.ts` e `mcp/access.ts`. Pontos:
- ambiente do processo: só `PATH`, `LANG`, `TZ` e um `HOME` próprio (`<dados>/plugin-homes/<plugin>/<projeto>`); `SHELL`, `USER`, `LOGNAME` e `TERM` ficam fora;
- agregação no servidor `otheater` como `<id>__<ferramenta>`, com o `tools/list` conferido contra o manifesto por avisos (`tool_not_declared`, `tool_not_exposed`, `tool_name_rejected` para nome acima de 64 caracteres);
- erros de ferramenta: `plugin_timeout`, `plugin_unavailable` (com `retry_in_ms`), `plugin_failed` e `tool_unavailable`;
- avisos do processo, por `PluginNoticeSink` (`StartDaemonOptions.pluginNotices`): `process_started`, `process_stopped` (ocioso, desligamento, inativo ou trocado), `process_failed` e `process_given_up`; o P8 os transformou em eventos;
- chaves [V]: `plugins.idle_timeout` (`10m` ou `off`), `plugins.max_restarts` (3, de 0 a 100), `plugins.call_timeout` (`60s`), `plugins.start_timeout` (`30s`), `plugins.restart_backoff.initial` e `.max` (`1s` e `1m`) e `plugins.http` (`loopback` | `off`). `plugins` é seção de reinício: não está em `HOT_CONFIG_SECTIONS`;
- a chamada que estoura o prazo não conta como falha do processo;
- #278: o daemon passa a pasta do projeto ao processo em `OTHEATER_PROJECT_DIR` (`PluginPoolOptions.projectDir`, ligado à pasta do cenário; só vale caminho absoluto, e um segredo de mesmo nome nunca a substitui). Chave nova `plugins.project_dir`: `scenario` (padrão) ou `off` **[proposta]** [V]. O SDK lê a variável com `pluginProjectDirectory()` (P9).

**Divergências:**
- o plano não previa a chave `plugins.project_dir`; ela entrou no #278, depois do P5 e do P9 (o README do SDK dizia que esse trabalho faltava) [S];
- uma chamada interrompida por uma queda devolve `plugin_failed` e não é repetida; repetir as ferramentas só de leitura seria decisão nova [N];
- a lista de ferramentas vem da última subida: um plugin que nunca subiu e parou por falhas não lista nenhuma [N].

### P6. Permissões geradas do manifesto (N237; §5.8, §5.14)

- O daemon gera as camadas 1 e 2 de permissão (§5.8) a partir dos papéis e efeitos do manifesto, para o adaptador de cada cliente, como já faz com as ferramentas do framework.
- Uma ferramenta fora dos papéis declarados fica **bloqueada**: não aparece no `tools/list` do papel, e a chamada direta dá erro.
- `requires_producer_approval: true` passa pelo mesmo cartão de aprovação das ferramentas do framework, com o evento de permissão.
- Os efeitos entram nas regras que já existem para a política do papel:
  - o Crítico só lê;
  - o `external_write` pede aprovação conforme a política.
  O vocabulário segue a N237.
- **Aceite:**
  - a matriz papel × ferramenta do plugin de exemplo bate com o manifesto, nos três adaptadores (pelo `fake-agent`);
  - a aprovação aparece e, recusada, a ferramenta não roda;
  - nenhum manifesto consegue liberar o que a política do papel nega (P3 da arquitetura).

**Como ficou:**

**Estado:** feito em 2026-11-22, PR #276 (c0a7c7b) [S: descrição do PR; as chaves foram conferidas em `config.ts`]. `packages/daemon/src/plugins/permissions.ts` aplica duas regras: o papel está na lista do manifesto (lista vazia quer dizer só painel); e o efeito cabe na política do papel (`read` para qualquer papel listado; `local_write` e `external_write` pedem `edit` ou `write` em `nativeTools`; `network` pede um domínio em `network.allow`). O `AttemptRunner` pergunta ao `McpAccess.pluginTools` e põe os nomes em `mcpTools.otheater`, que o Claude (`allowedMcpRules`), o OpenCode (`opencodePermission`) e o Codex (`decidePermission`, motivos `mcp_tool_of_role` e `mcp_tool_outside_role`) já liam; nenhum ponto do `resolveRolePolicy` mudou. O `mcp/server.ts` bloqueia a chamada direta e o `#callPlugin` recusa também (defesa em duas camadas). O cartão de aprovação usa `openApproval` e os eventos `permission.asked` e `permission.answered` com `rule: plugin:<id>`. Novos `PERMISSION_REASONS`: `plugin_tool_approved` e `plugin_tool_refused` (`core/permission-rules.ts`). Aviso `tool_refused`, com os motivos `not_allowed`, `approval_denied`, `approval_unavailable` e `approval_cancelled`.

Chaves `plugins.permissions.*` [V]:

| Chave | Padrão | Modos |
|---|---|---|
| `local_write` | `writes` | `writes`, `shells`, `deny` |
| `network` | `network_allow` | `network_allow`, `any`, `deny` |
| `external_write` | `writes` | `writes`, `deny` |
| `external_write_approval` | `ask` | `ask`, `manifest` |
| `approval_detail` | `keys` | `keys`, `values` |

**Divergências:**
- as chaves `plugins.permissions.*` não estavam no plano; todas são **[proposta]**, e o PR levanta sete perguntas para o dono, entre elas o fato de `mcpTools: 'all'` deixar as camadas 1 e 2 abertas [S];
- o aceite cobre os três adaptadores pela tradução das listas, pela camada 2 do Codex e por um e2e com o `fake-agent`; um cliente real não foi rodado [N];
- sem evento nem métrica novos além dos motivos do `plugin.tool_rejected` (P8).

### P7. Segredos do plugin no cofre (N239; §5.14)

- Os segredos ficam na chave `plugin/<id>/<NOME>` do `SecretVault`, com a variante por projeto `plugin/<id>/<projeto>/<NOME>` **[proposta]**, pela N239 (a).
- `ot plugin secret set <id> <NOME> [--project <p>]` lê o valor da entrada padrão e nunca o imprime. A TUI tem o mesmo, mascarado, no P11.
- O valor entra como variável de ambiente, só no processo do servidor do plugin. Ele nunca vai para o Executor, o log, a telemetria ou o evento, e a redação da §5.11 o reconhece como valor do cofre.
- Se faltar um segredo declarado, o plugin não sobe naquele projeto, com aviso e evento.
- **Aceite:**
  - o servidor de teste recebe o segredo;
  - o Executor e o log não o veem;
  - o valor por projeto vence o geral;
  - sem o segredo, o plugin não sobe.
- Os testes usam o cofre em memória, nunca o chaveiro real sem `OT_TEST_KEYRING=1`.

**Como ficou:**

**Estado:** feito em 2026-11-22, PR #274 (2a87ecb) [S: descrição do PR; o evento foi conferido na main]. `packages/daemon/src/plugins/secrets.ts` (`pluginSecretKey`, `PluginSecrets` com `set`, `has` e `resolve`, e `pluginExtraEnv`). Chaves do cofre `plugin/<id>/<NOME>` e `plugin/<id>/<projeto>/<NOME>`, e a do projeto vence. `ot plugin secret set <id> <NOME> [--project <p>]` lê o valor da entrada padrão ou de uma pergunta sem eco (`askHidden`, em `cli.ts`), nunca o imprime, recusa valor vazio e confere que o plugin declara o nome. O `composeVault` foi extraído para `compose.ts`. Sem um segredo declarado, o servidor não sobe: a chamada dá `unavailable`, com aviso no log e o aviso `secret_missing` (sem repetição), e isso não conta como falha nem espera crescente. Com o cofre trancado, nenhum aviso. O `maskValues` cobre o stderr do servidor. No cofre em arquivo cifrado, `secret set` é recusado com o daemon no ar; o chaveiro não tem trava.

Limites declarados no PR [S]: o `VaultValues` atualiza a cada 30 s; o resultado da ferramenta não é mascarado; um segredo chamado `PATH`, `HOME`, `LANG` ou `TZ` perde sem aviso.

**Divergências:**
- o PR diz "nenhum evento novo", mas a main tem o evento `plugin.secret_missing` (`PluginSecretMissingPayloadSchema` em `packages/protocol/src/plugin-events.ts`, registrado em `events.ts`) [V]; a contagem dos registros fecha com ele (137 da base, mais 1 do P14, 9 do P8, 1 do P7 e 1 do P10, 149 no protocolo);
- a TUI com a mesma edição mascarada continua no P11.

### P8. Eventos `plugin.<id>.*` e eventos do ciclo dos plugins (§5.14)

- **Eventos do plugin:** o plugin publica só os tipos que declarou no manifesto, como `plugin.<id>.<nome>`, com payload JSON pequeno e limitado (`plugins.event_max_bytes`, padrão 16 KB) **[proposta]**. O meio também é **[proposta]**: uma notificação MCP própria (`notifications/otheater/event`), que o SDK do P9 embrulha. Um tipo não declarado é recusado, com aviso e evento.
- **Eventos do daemon** sobre os plugins **[proposta]**, sem conteúdo nem segredo:
  - `plugin.installed`, `plugin.removed`, `plugin.enabled` e `plugin.disabled`;
  - `plugin.server_started`, `plugin.server_stopped` e `plugin.server_failed`;
  - `plugin.tool_rejected` (ferramenta fora do manifesto) e `plugin.event_rejected`.
  Os nomes dos eventos do daemon não colidem com os de plugin, porque um id de plugin não pode ser um destes nomes reservados.
- **Aceite:** o evento declarado entra no log com o prefixo e chega aos assinantes; o não declarado é recusado; as contagens dos registros de eventos sobem.

**Como ficou:**

**Estado:** feito em 2026-11-22, PR #275 (d27a3dd) [S: descrição do PR; os nove eventos e as chaves foram conferidos na main]. Nove eventos do daemon [V]: `plugin.installed`, `plugin.removed`, `plugin.enabled`, `plugin.disabled`, `plugin.server_started`, `plugin.server_stopped`, `plugin.server_failed`, `plugin.tool_rejected` e `plugin.event_rejected`. Motivos:
- `tool_rejected`: `not_declared`, `not_exposed`, `name_too_long`, `name_taken` e, vindos do P6, `not_allowed`, `approval_denied`, `approval_unavailable` e `approval_cancelled`;
- `event_rejected`: `off`, `invalid`, `inactive`, `not_declared` e `too_large`;
- `disabled`: `producer` e `needs_approval`.

`plugins/events.ts` transforma cada `PluginNotice` e cada aviso do registro em evento; `broken` fica só no log. Um id de plugin não pode ser um desses nomes (regra cruzada do manifesto e o registro `plugin_prefix`). Os eventos do plugin, `plugin.<id>.<nome>`, chegam pela notificação MCP `notifications/otheater/event` (`params {name, payload?}`), conferida nesta ordem: `plugins.events` ligado, parâmetros válidos, plugin ativo, nome no manifesto e tamanho. O `RegistryContributor` e o `LiveEventRegistry` põem os tipos dinâmicos no retrato, e o `events.unknown_type` continua `reject`. O `SituationLog.recordEvent` registra a situação. O servidor de teste ganhou o modo `--events`. Chaves [V]: `plugins.events` (`declared` | `off`, padrão `declared`) e `plugins.event_max_bytes` (de 1 a 1.048.576, padrão 16.384).

**Divergências:**
- as contagens do PR (protocolo 137 para 146 e daemon 139 para 148) valem para o PR sozinho; com os passos seguintes a main tem 149 e 151 [V];
- sem limite de taxa dos eventos do plugin **[proposta]**, e o payload do plugin não é mascarado [S];
- o `OTHEATER_PROJECT_DIR` não entrou aqui; veio no PR #278 (P5) [S].

### P9. `@otheater/sdk` para plugins e o plugin de exemplo (N240)

- **SDK:**
  - `definePlugin` amarra o manifesto (o schema do P3) às ferramentas;
  - um ajudante sobe o servidor stdio sobre o `@modelcontextprotocol/server` (já no lock);
  - um ajudante publica eventos;
  - uma suíte de conformidade de plugin, no molde das suítes do SDK, confere que o servidor expõe o que o manifesto declara.
- **Plugin de exemplo** em `examples/plugin-notes` **[proposta]**, pela N240 (a). São notas num arquivo JSON da pasta do projeto, sem rede e sem dependência nova:
  - `list_notes` (leitura, nenhum papel, usada pelo painel `table`);
  - `add_note` (escrita local, papel `actor`);
  - `clear_notes` (`requires_producer_approval`, usada pela `action` do painel);
  - o evento `note_added`;
  - o catálogo `en` e o `pt-BR`.
- **Aceite:**
  - o exemplo passa pela suíte de conformidade;
  - o exemplo se instala pelo P4 numa pasta temporária;
  - o README do SDK mostra o exemplo inteiro.

**Como ficou:**

**Estado:** feito em 2026-11-22, PR #271 (43908f2) [S: descrição do PR; a estrutura de arquivos foi conferida na main]. Subcaminho `@otheater/sdk/plugin` **[proposta]**, em `packages/sdk/src/plugin/` (`define.ts`, `server.ts`, `events.ts`, `conformance.ts`, `stdio-client.ts`, `environment.ts` e `manifest-file.ts`): `definePlugin`, `servePlugin`, o ajudante de eventos, o `PluginStdioClient` e `describePluginConformance`. O plugin de exemplo está em `examples/plugin-notes`:
- `list_notes` (leitura, sem papel, painel `table`);
- `add_note` (`local_write`, papel `actor`);
- `clear_notes` (`requires_producer_approval`, painel `action`);
- o evento `note_added` e os catálogos `en` e `pt-BR`;
- as notas ficam em `<projeto>/.plugin-notes.json` (até 1000 notas de 2000 caracteres), e as anotações MCP vêm dos efeitos.

O limite do payload do evento é o de 16.384 bytes do P8. Dependência nova do SDK: `yaml` 2.9.1, que já estava no lock. O PR tocou arquivos compartilhados: `pnpm-workspace.yaml` (`examples/*`), o `tsconfig.json` da raiz e o `vitest.config.ts`. O #278 (P5) fez o exemplo e o SDK lerem `OTHEATER_PROJECT_DIR` (`pluginProjectDirectory()`).

**Divergências:**
- o aceite "o exemplo se instala pelo P4 numa pasta temporária" ficou para o P13 [S];
- o subcaminho `@otheater/sdk/plugin`, em vez de um pacote novo, é **[proposta]**;
- sem evento, métrica ou chave novos.

### P10. Rotas `/v1/plugins`: lista, painel e ação

- **Rotas** **[proposta]**, no registro zod como as outras:
  - `GET /v1/plugins` lista os instalados, com o estado por projeto;
  - `GET /v1/plugins/:id` dá o manifesto e o texto de ativação;
  - `POST /v1/plugins/:id/enable` e `/disable` recebem `project`;
  - `GET /v1/plugins/:id/panel?project=` traz os blocos já com os dados: o daemon chama as ferramentas `source`, de leitura;
  - `POST /v1/plugins/:id/actions/:tool` chama a `action` em nome do Produtor, com a mesma permissão, aprovação e evento de qualquer chamada.
- Os dados do painel passam por um teto de tamanho e de linhas (`plugins.panel.max_rows`, padrão 200) **[proposta]**, e o texto de tela vem do catálogo do plugin no idioma da interface, com o `en` como reserva.
- **Aceite:** as rotas com o plugin de exemplo; uma `source` sem efeito de leitura é impossível (o P3 já recusa); a `action` com aprovação espera o Produtor; o catálogo da API é regenerado.

**Como ficou:**

**Estado:** feito em 2026-11-22, PR #279 (6b6e0f3) [S: descrição do PR; as rotas e a chave foram conferidas na main]. Seis rotas, no registro zod (`packages/protocol/src/api/plugins.ts` e `daemon/src/api/routes/plugins.ts`) [V]:
- `GET /v1/plugins` (`listPlugins`);
- `GET /v1/plugins/:pluginId` (`getPlugin`, com `lang`);
- `POST /v1/plugins/:pluginId/enable` e `/disable` (`enablePlugin` e `disablePlugin`, corpo `{project}`; `manifestHash` é opcional e dá 409 se estiver velho);
- `GET /v1/plugins/:pluginId/panel?project=` (`getPluginPanel`);
- `POST /v1/plugins/:pluginId/actions/:tool` (`callPluginAction`).

Contrato dos dados do painel: `table` e `list` recebem um array, `metrics` um objeto; qualquer outra forma dá erro do bloco `invalid_result`, com textos fixos do catálogo (`plugin.panel.error.*`, sete chaves em cada idioma). Chaves [V]: `plugins.panel.max_rows` (padrão 200) e `plugins.panel.max_bytes` (`1MB` ou `off`); o corte é primeiro por linhas e depois por bytes. Evento novo `plugin.panel_truncated` (payload `plugin`, `project`, `source`, `reason` `rows` ou `bytes`, `total`, `kept` e `limit`) [V]. Contagens dos registros de eventos: 149 no protocolo e 151 no daemon [V]. Ação só para ferramentas citadas por um bloco `action` (senão 404); os modos `deny` de `plugins.permissions` valem para o Produtor (403 `forbidden` e `plugin.tool_rejected` `not_allowed`); recusada ou cancelada dá 409; sem canal de aprovação dá 503. `PluginAggregator.callTool` ficou público, e `plugins/approval.ts` é compartilhado com o `mcp/server.ts`. `list` e `detail` chamam `refresh()`. O `api-routes.json` foi regenerado (6 rotas a mais).

**Divergências:**
- as rotas usam `:pluginId`, e o plano dizia `:id`;
- o plano só previa `plugins.panel.max_rows`; o `max_bytes` e o evento `plugin.panel_truncated` são acréscimos do passo **[proposta]**;
- o daemon de teste não tem o ambiente de aprovação (dá 503) [N];
- perguntas do PR para o dono: `:pluginId` ou `:id`, `manifestHash` opcional, ação só para blocos `action`, `deny` valendo para o Produtor, o padrão de `1MB`, e o fato de uma desconexão não cancelar a aprovação pendente [S].

### P11. Aba Plugins da TUI (F6) com o painel declarativo (§5.13, §5.14)

- A aba `plugins` (F6, ordem 70) entra no registro padrão. O registro de teste já a espera.
- **Lista:**
  - os plugins instalados, com o estado no projeto atual;
  - ativar e desativar, mostrando antes o texto de ativação do P4;
  - os segredos que faltam, com a edição mascarada do P7.
- **Painel:**
  - a TUI desenha os blocos `table`, `list`, `metrics` e `action` só a partir dos dados da rota do P10, sem nenhum código do plugin;
  - a `action` abre o cartão de confirmação, e a aprovação, quando pedida, segue o fluxo normal;
  - as teclas vêm do registro de teclas da aba (N199).
- Os textos da aba vão aos catálogos `en` e `pt-BR`; os do plugin vêm do catálogo dele.
- **Aceite:**
  - o painel do plugin de exemplo aparece, com o `ink-testing-library`;
  - um bloco de tipo desconhecido mostra aviso e não quebra a aba;
  - o teste de fumaça no tmux abre a aba;
  - nenhum `import` de código do plugin no pacote da TUI, conferido por teste.

### P12. Fluxos por configuração: `flows.<id>` e `scenario.flow` (N133, N241; §12, item 29)

O desenho segue a N241 (a) **[proposta]**:
- **Formato:** `flows.<id>` em YAML, `version: 1`. Um fluxo é o fluxo oficial `play` com:
  - etapas opcionais ligadas ou desligadas, por exemplo a revisão do plano ou a crítica;
  - o papel e os limites de cada etapa.
  A ordem das etapas é fixa, e um fluxo só usa etapas do registro.
- **Etapas obrigatórias** que nenhum fluxo tira:
  - os contadores dos laços;
  - a verificação em código;
  - a entrega.
  Um fluxo nunca libera permissão (P3 da arquitetura).
- **Escolha:** `scenario.flow: <id>`, com override por camada, como a política do papel. Sem a chave, vale o `play` oficial.
- **Snapshot (§5.4):**
  - o snapshot da peça guarda o id, a versão e o hash do fluxo;
  - mudar o fluxo na configuração não muda a peça em curso;
  - o `pipeline.session_reuse` (N131) continua valendo por etapa.
- **Sem editor de fluxos na TUI na v1.** O validador é o do P3. O plugin declarar fluxos fica para o nível de contribuições declarativas, depois da v1 (§5.14).
- **Aceite:**
  - um fluxo sem a revisão do plano roda até a entrega com o `fake-agent`;
  - um fluxo que tenta tirar uma etapa obrigatória é recusado;
  - o snapshot guarda o fluxo;
  - a troca da configuração não afeta a peça em curso.

**Como ficou:**

**Estado:** feito em 2026-11-22, PR #270 (ff36aab) [S: descrição do PR; as etapas, as chaves e o erro `invalid_flow` foram conferidos na main]. Arquivos: `packages/core/src/flows/` (`config.ts`, `schema.ts` e `steps.ts`), `docs/reference/flow-config.schema.json` (gerado por `pnpm flow:schema` [V]), `daemon/src/flows-config.ts`, `pipeline/flow-selection.ts` e `orchestration/open-play.ts`. As etapas, em ordem [V: `steps.ts`]: `planning`, `clarifying`, `plan_review`, `scripting`, `script_review`, `execution`, `integration`, `critique` e `delivery`. Só `plan_review` (papel `reviewer`) e `critique` (papel `critic`) podem ser desligadas; as demais são obrigatórias. Limites por etapa: `plan_review` com `plan_reviews`; `scripting` com `script_validations`; `script_review` com `script_vetoes`; `execution` com `attempts_per_demand`; `integration` com `script_returns`; `critique` com `critic_rejections` e `structural_restarts`. O `limits.submit_retries` continua global **[proposta]**, e o papel de cada etapa tem de ser o fixo dela **[proposta]**.

Chaves `flows` e `scenario.flow`, com `superRefine` que recusa um fluxo inexistente, e override por camada pela `configOverride` do cenário, como a política do papel. O snapshot da peça traz `context.flow = {id, version, hash, skip}`, com o hash sha256 do JSON canônico; os limites do fluxo entram em `context.limits` na criação. Na máquina, sem `plan_review` os eventos `PLAN_SUBMITTED` e `QUESTIONS_ANSWERED` vão direto a `SCRIPTING`; sem `critique`, `INTEGRATED` vai a `DELIVERING`. Um fluxo desconhecido ou inválido ao abrir a peça é recusado com `invalid_flow`, sem volta silenciosa ao `play` **[proposta]** [V]. O `play.created` não carrega o fluxo **[proposta]**, e o snapshot oficial da peça não ganhou campo.

**Divergências:**
- o plano dizia "papel e limites de cada etapa"; o PR fixou o papel de cada etapa e deixou só os limites configuráveis;
- sem evento nem métrica novos;
- a suíte afetada local foi interrompida sob carga, com estouros de prazo em alguns e2e; o veredito é o da CI [N];
- o item 29 da §12 e as sete escolhas **[proposta]** do PR seguem para o dono no fim da fase.

### P14. Troca manual do Diretor pela TUI e por `/director` (N242; §5.13, §5.4, §5.16)

Pedido do dono em 2026-11-21: clicar no modelo e no esforço que ficam embaixo da caixa de texto, como no Claude Code, e escolher outro Diretor; um comando `/` serve onde a TUI não der. Hoje o Diretor só troca de Executor no failover, e `/model` e `/effort` só mostram o valor [V].

O desenho segue a N242:
- **Rodapé da TUI:** abaixo da caixa de texto do chat, o Executor, o modelo e o esforço do Diretor do cenário. Um clique (com `ui.mouse` ligado) ou um atalho do mapa de teclas **[proposta]** abre o seletor.
- **Seletor:** os Executores da lista do papel do Diretor do cenário, com validade e cota, e os modelos e esforços que cada cliente anuncia (config options, §5.7). Uma linha "voltar ao padrão" tira o override.
- **Comando:** `/director` lista; `/director <executor>` troca; `/director default` volta ao padrão. `/model <modelo>` e `/effort <esforço>` passam a aceitar o valor e trocam no mesmo Executor **[proposta]**.
- **Duração:** override do cenário, gravado no store, até o Produtor voltar ao padrão. Sobrevive ao sono do Diretor e ao reinício do daemon. O failover segue a lista do papel a partir do escolhido.
- **Sessão:** automática.
  - Mesmo cliente e perfil, só modelo ou esforço: a config option muda na sessão viva. Se o cliente não anunciar a opção, vale a passagem de bastão.
  - Outro Executor: passagem de bastão. A sessão nova recebe o prefixo do papel e o resumo do estado do store, pelo mesmo caminho do failover e do sono.
  - O chat mostra um aviso com a forma usada, e a troca gera um evento **[proposta]**.
- **Durante um turno:** a troca espera o fim do turno, com a chave `scenarios.director_switch.in_turn: wait | interrupt`, padrão `wait` **[proposta]**.
- **Aceite**, com o `fake-agent`:
  - trocar para outro Executor abre uma sessão nova, cujo primeiro prompt traz o resumo do estado;
  - trocar só o esforço no mesmo Executor muda a sessão viva, sem sessão nova;
  - o override sobrevive ao sono e ao reinício, e "voltar ao padrão" o tira;
  - a troca pedida durante um turno espera o fim dele;
  - na TUI, o rodapé aparece, e o clique e o atalho abrem o seletor;
  - o comando e a TUI dão o mesmo resultado.

**Como ficou:**

**Estado:** feito em 2026-11-22, PR #269 (27c1185), com o plano no PR #268 (303c334, 2026-11-21) [S: descrição do PR; os nomes foram conferidos na main]. O override fica em `configOverride.director_override` (`DIRECTOR_OVERRIDE_KEY`, em `orchestration/director-switch.ts`) **[proposta]**, sobrevive ao sono e ao reinício, e só `/director default` o tira; o `RoleSelection.startAt` faz o failover partir do escolhido. Formas da troca: `live`, `baton`, `new_session`, `stored` e `unchanged`. Chave `scenarios.director_switch.in_turn` (`wait`, padrão, ou `interrupt`) [V], com uma troca por vez por cenário. Comandos: `/director` lista, `/director <executor|número|prefixo>` troca, `/director default` volta ao padrão, e `/model <m>` e `/effort <e>` aceitam um valor; `chat.slash_access: read_only` recusa as trocas. A troca gera o aviso `scenario.system_message` com `kind: director_switch` e o evento `scenario.director_switched` [V] (os registros foram de 137 para 138 no protocolo e de 139 para 140 no daemon). Na TUI: rodapé do chat, seletor (`packages/tui/src/chat/director-picker.ts`), atalho `chat.director` (`Alt+M` nos dois presets **[proposta]**, ação em `packages/client/src/ui/default-registry.ts` [V]) e clique com `ui.mouse`. Reusa `POST /v1/scenarios/:id/commands`, sem rota nova. Chave nova `ui.chat.directorFooter` (`on` | `off`, padrão `on`) [V: `protocol/src/ui-config.ts`]. O `FakeClientAdapter` passou a mapear também `effort`. O `api-routes.json` foi regenerado.

**Divergências:**
- os testes acharam dois erros, já corrigidos no PR: uma troca em espera aplicada duas vezes (agora é tomada uma só vez) e o `/director default` ignorando Executores com cota `unknown` [S];
- o atalho `Alt+M`, a chave `ui.chat.directorFooter` e o nome da chave do override não estavam no plano;
- a suíte afetada rodou local (564 arquivos, 8443 testes); o veredito é o da CI [N]; nenhum cliente real foi rodado.

### P13. Aceite da fase

- **Automático**, um e2e com o `fake-agent` e o plugin de exemplo instalado numa pasta temporária:
  - a ferramenta do plugin aparece só nos papéis declarados e fica bloqueada nos demais;
  - a chamada com aprovação espera o Produtor;
  - o segredo chega só ao servidor do plugin;
  - o evento `plugin.notes.note_added` entra no log;
  - o painel aparece na TUI sem código do plugin na interface;
  - um fluxo de configuração roda;
  - a árvore única de spans e as métricas novas da Fase 8 aparecem.
- **Real** (`--level phase9` do `real-acceptance.sh`) **[proposta]**: uma sessão real do Claude Code (haiku) como Ator chama o `add_note` do exemplo, e o Crítico não o vê. O Codex e o OpenCode são opcionais, como na N230.
- **Aceite:** os dois níveis verdes, e o critério da §10 cumprido.

## Fora desta fase

Ficam depois da v1 (§5.14):
- os níveis opcionais do plugin: assinar eventos, ganchos de interceptação e contribuições declarativas, incluídos os fluxos vindos de plugin;
- as sondas de cota e os notificadores por plugin.

Ficam para outras fases ou outros PRs:
- o painel do plugin na interface web (Fase 12);
- a autenticação de servidores `http` de plugin fora do loopback;
- a Fase 9b (agendador e tarefas): a entrega por plugin espera esta fase.

## Decisões deste plano

Decididas pelo dono em 2026-11-21, por múltipla escolha ([docs/13](13-DECISOES-EM-ABERTO.md)):

| Decisão | Escolha |
|---|---|
| N232, o cliente MCP | (a) o `@modelcontextprotocol/client` 2.4.0, com o download aprovado |
| N233, a validação | (a) zod, com o JSON Schema gerado só para a documentação |
| N234, o agregador | (a) próprio, no daemon |
| N235, a ativação | (a) troca a quente do retrato congelado |
| N236, a instalação | (a), (b) e (c): pasta local, npm e git, sem scripts de ciclo de vida |
| N237, os efeitos | (a) o código adota o vocabulário da §5.14 |
| N238, o processo | (a) um por plugin e projeto, sob demanda |
| N239, os segredos | (a) `plugin/<id>/<NOME>` com a variante por projeto |
| N240, o exemplo | (a) `examples/plugin-notes` |
| N241, os fluxos | (a) o `play` oficial com etapas opcionais, em ordem fixa |
| N242, a troca do Diretor | Executores do papel; override do cenário; sessão viva ou bastão, automático; passo P14 desta fase |

As opções, como foram apresentadas:

Todas abertas em 2026-11-21 e levadas ao dono por múltipla escolha, com a recomendação em primeiro lugar. Os detalhes e o estado de cada uma estão em [docs/13](13-DECISOES-EM-ABERTO.md).

- **N232, o cliente MCP (P5):**
  - (a) o `@modelcontextprotocol/client` 2.4.0 oficial (**recomendada**): mesma versão do servidor que já usamos, e o protocolo inteiro (inicialização, paginação, cancelamento, Streamable HTTP) sem reimplementar;
  - (b) um cliente próprio, só stdio, sobre os schemas do `@modelcontextprotocol/core` que já está no lock, sem download, deixando o `http` para depois.
- **N233, a validação por schema (P3, P5):**
  - (a) zod para o manifesto e para os fluxos, com o JSON Schema gerado só para a documentação; os argumentos das ferramentas são validados pelo próprio servidor do plugin (**recomendada**);
  - (b) também o `ajv` 8 (download) para validar os argumentos contra o `inputSchema` antes de repassar.
- **N234, o agregador (P5):**
  - (a) próprio, no daemon: as ferramentas do plugin saem pelo servidor MCP do framework, filtradas por papel (**recomendada**);
  - (b) o 1MCP como sidecar.
- **N235, a ativação por projeto e os registros congelados (P4):**
  - (a) troca a quente do retrato dos registros, e a sessão em curso fica com o retrato antigo (**recomendada**);
  - (b) instalar e remover pedem reinício do daemon; ativar e desativar são a quente.
- **N236, de onde instalar (P4):**
  - (a) só de uma pasta local na v1, guardando o caminho e o hash do manifesto (**recomendada**);
  - (b) também de um pacote npm;
  - (c) também de um repositório git.
- **N237, o vocabulário dos efeitos (P3, P6):**
  - (a) o código adota o vocabulário da arquitetura (`read`, `local_write`, `network`, `external_write`). O que existe é renomeado um a um: `none` vira `read`, e `worktree` vira `local_write` (**recomendada**: um vocabulário só, e a arquitetura é a referência);
  - (b) o código mantém os três e o carregador do manifesto converte, com `network` tratado como `external_write`, o lado conservador;
  - (c) a arquitetura passa a usar o vocabulário do código.
- **N238, o processo do plugin (P5):**
  - (a) um processo por plugin e projeto, que sobe no primeiro uso e para ocioso (**recomendada**: segredos e ativação são por projeto);
  - (b) um processo por plugin, compartilhado entre projetos;
  - (c) sempre ligado desde a subida do daemon.
- **N239, os segredos (P7):**
  - (a) `plugin/<id>/<NOME>` no cofre, com a variante por projeto, só como variável de ambiente do servidor do plugin (**recomendada**);
  - (b) só a chave geral por plugin, sem variante por projeto.
- **N240, o plugin de exemplo (P9):**
  - (a) `examples/plugin-notes`, com notas num arquivo do projeto, sem rede e sem dependência nova (**recomendada**);
  - (b) o exemplo `postgres-db` da §5.14, que pede um Postgres nos testes.
- **N241, os fluxos por configuração (N133, item 29 da §12, P12):**
  - (a) YAML `version: 1`. O fluxo é o `play` oficial, com as etapas opcionais ligadas ou desligadas e o papel e os limites por etapa, em ordem fixa. As etapas obrigatórias são fixas. A escolha é por `scenario.flow`, com override por camada. O snapshot guarda o id, a versão e o hash do fluxo. Sem editor na v1 (**recomendada**);
  - (b) um grafo declarativo completo, com transições, o que pede um interpretador no lugar da máquina fixa;
  - (c) adiar a N133 para depois da v1.
