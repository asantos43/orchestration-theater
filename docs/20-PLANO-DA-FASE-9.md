# 20. Plano da Fase 9

Versão 1, de 2026-11-21. Este documento divide em passos a Fase 9 da [arquitetura](framework-ideas/arquitetura.md) (§10, "Fase 9 — Plugins"), com o desenho da §5.14 e o item 29 da §12 (N133). Para cada passo, ele diz o que pode correr em paralelo e qual é o aceite. A arquitetura continua sendo a referência: se este plano divergir dela, vale a arquitetura e o plano é corrigido.

A fase começa depois do fim da Fase 8 (decisões N224 a N231, de 2026-11-21). Pela N231, os PRs desta fase mesclam sem ok por PR, com a CI verde e squash. O que depende do dono fica para o fim da fase.

O fechamento da Fase 7 depende do roteiro dos terminais e do login oficial (N209, PR #262). O dono faz os dois em paralelo, e eles não seguram esta fase.

O plano traz dois passos curtos que a Fase 8 deixou para cá:
- a árvore única de spans (N230 (2));
- as métricas da espera e dos lotes recusados (N225 (2) e (3)).

O plano levanta dez decisões novas, N232 a N241 ([docs/13](13-DECISOES-EM-ABERTO.md)). Elas estão resumidas em "Decisões que surgem deste plano", no fim, cada uma com a recomendação em primeiro lugar.

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
- **Nenhum download novo sem decisão do dono.** A única dependência em pauta é o cliente MCP oficial (N232); ver "Dependências novas".
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
| `@modelcontextprotocol/client` | 2.4.0 | Apache-2.0 | 2026-10-23 | P5 | Só na N232 (a). Mesmo monorepo e versão do `server` que o daemon já usa; depende do `@modelcontextprotocol/core` 2.4.0, já no lock. Traz como transitivas novas `jose` 6, `eventsource` 3, `eventsource-parser` 3 e `pkce-challenge` 5, todas MIT; o `cross-spawn` 7 e o `zod` já estão no lock |
| `ajv` | 8.x | MIT | a fixar | P5 | Só na N233 (b), para validar os argumentos das ferramentas do plugin contra o `inputSchema` antes de repassar |

## Passos

| Passo | Título | Depende de | Pode correr junto com | Estado |
|---|---|---|---|---|
| P0 | Plano e decisões (este documento) | nada | P1, P2 | em PR |
| P1 | Árvore única de spans (N230 (2)) | nada | P0, P2, P3 | em curso |
| P2 | Métricas da espera e dos lotes recusados (N225 (2) e (3)) | nada | P0, P1, P3 | em curso |
| P3 | Manifesto: schema, validador e JSON Schema gerado (N233, N237) | P0 | P1, P2 | a fazer |
| P4 | Registro, instalação e ativação por projeto (N235, N236) | P3 | P5, P9, P12 | a fazer |
| P5 | Cliente MCP, processos dos plugins e agregação (N232, N234, N238) | P3 | P4, P9, P12 | a fazer |
| P6 | Permissões geradas do manifesto (N237) | P4, P5 | P7, P8 | a fazer |
| P7 | Segredos do plugin no cofre (N239) | P5 | P6, P8 | a fazer |
| P8 | Eventos `plugin.<id>.*` e eventos do ciclo dos plugins | P4, P5 | P6, P7 | a fazer |
| P9 | `@otheater/sdk` para plugins e o plugin de exemplo (N240) | P3 | P4, P5, P12 | a fazer |
| P10 | Rotas `/v1/plugins`: lista, painel e ação | P6, P8 | P12 | a fazer |
| P11 | Aba Plugins da TUI (F6) com o painel declarativo | P10 | P12 | a fazer |
| P12 | Fluxos por configuração: `flows.<id>` e `scenario.flow` (N133, N241) | P3 | P4 a P11 | a fazer |
| P13 | Aceite da fase | todos | nada | a fazer |

Ondas **[proposta]**:
- **onda 1:** P0, P1, P2 e P3;
- **onda 2:** P4, P5, P9 e P12;
- **onda 3:** P6, P7 e P8;
- **onda 4:** P10 e depois P11;
- **fim:** P13.

O P12 só depende do validador do P3. Ele mexe no pipeline e na configuração do cenário, não no código dos plugins.

### P1. Árvore única de spans (N230 (2); §5.11)

- O daemon passa ao cliente o `otheater.trace_id` da tentativa, pelo `resourceExtras` que o receptor já tem (`telemetry/client-telemetry.ts`). Hoje o `daemon.ts` não o passa.
- O receptor põe os spans do cliente sob o span da sessão ou da tentativa no trace do daemon:
  - o `traceId` passa a ser o do daemon;
  - o span-raiz do cliente ganha como pai o span da sessão;
  - a hierarquia interna dos spans do cliente fica;
  - os ids originais do cliente ficam em atributos (`otheater.client.trace_id` e `otheater.client.parent_span_id`) **[proposta]**.
- Chave `telemetry.receiver.reparent: session | off`, com padrão `session` **[proposta]**. Os spans de uma sessão desconhecida ficam como chegaram.
- **Aceite:** com o `fake-agent`, os spans do cliente aparecem na árvore do daemon, sob a sessão. Com `off`, nada muda. A rota de spans da peça, a exportação OTLP e o ATIF continuam válidos.

### P2. Métricas da espera e dos lotes recusados (N225 (2) e (3); §5.11)

- A espera vira métrica, derivada dos eventos `wait.started` e `wait.ended`, sem fonte nova. Os nomes seguem o estilo das dez métricas `otheater_*` **[proposta]**:
  - o gauge das esperas abertas por `kind`;
  - o contador das esperas por `kind` e desfecho;
  - a soma dos segundos por `kind`.
  Só contam as esperas acima de `events.wait_threshold`.
- Um contador dos lotes do receptor por motivo de recusa (`format`, `size`, `token`), lido do `stats` do receptor.
- As séries saem no `/metrics` e na exportação OTLP de métricas.
- **Aceite:** o `/metrics` mostra as séries novas com valores coerentes com os eventos e com o `stats`. As dez métricas existentes não mudam.

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

### P4. Registro, instalação e ativação por projeto (N235, N236; §5.14)

- **Comandos** `ot plugin install <pasta> | list | remove <id> | enable <id> --project <p> | disable <id> --project <p>`. Pela N236 (a), a instalação só aceita uma pasta local.
  - O daemon guarda o caminho e o hash do manifesto em `<dados>/plugins.json` **[proposta]**, sem copiar a pasta.
  - Se o manifesto mudar, o plugin fica desligado até o Produtor aprovar de novo.
- **Ativação por projeto:** `projects.<p>.plugins: [<id>]`, ou uma lista por projeto no registro **[proposta]**. Ao ativar, o Produtor vê:
  - as ferramentas, com os papéis e os efeitos;
  - os segredos pedidos;
  - os eventos.
  É o mesmo texto que a TUI mostra no P11.
- **Registros:** pela N235 (a), os plugins instalados entram nos registros da subida. Instalar, remover, ativar ou desativar troca o retrato congelado por um novo, de uma vez. A sessão em curso segue com o retrato com que abriu.
- **Aceite:**
  - instalar, listar, ativar, desativar e remover;
  - manifesto inválido recusado com a mensagem do P3;
  - manifesto mudado desliga o plugin;
  - a troca a quente não altera uma sessão aberta.

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
- **`tools/list` do plugin:** o daemon confere o retorno contra o manifesto. Uma ferramenta que o servidor expõe e o manifesto não declara fica de fora, com aviso e evento. Uma declarada que o servidor não expõe fica indisponível.
- **Aceite**, com um servidor MCP de teste em stdio:
  - a ferramenta declarada aparece para o papel certo e não para os outros;
  - a chamada chega e volta;
  - o prazo estoura com erro de ferramenta;
  - a queda e a volta funcionam, e o processo para depois das falhas seguidas;
  - o processo para ocioso;
  - o processo não vê o ambiente do daemon.

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

### P8. Eventos `plugin.<id>.*` e eventos do ciclo dos plugins (§5.14)

- **Eventos do plugin:** o plugin publica só os tipos que declarou no manifesto, como `plugin.<id>.<nome>`, com payload JSON pequeno e limitado (`plugins.event_max_bytes`, padrão 16 KB) **[proposta]**. O meio também é **[proposta]**: uma notificação MCP própria (`notifications/otheater/event`), que o SDK do P9 embrulha. Um tipo não declarado é recusado, com aviso e evento.
- **Eventos do daemon** sobre os plugins **[proposta]**, sem conteúdo nem segredo:
  - `plugin.installed`, `plugin.removed`, `plugin.enabled` e `plugin.disabled`;
  - `plugin.server_started`, `plugin.server_stopped` e `plugin.server_failed`;
  - `plugin.tool_rejected` (ferramenta fora do manifesto) e `plugin.event_rejected`.
  Os nomes dos eventos do daemon não colidem com os de plugin, porque um id de plugin não pode ser um destes nomes reservados.
- **Aceite:** o evento declarado entra no log com o prefixo e chega aos assinantes; o não declarado é recusado; as contagens dos registros de eventos sobem.

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

### P10. Rotas `/v1/plugins`: lista, painel e ação

- **Rotas** **[proposta]**, no registro zod como as outras:
  - `GET /v1/plugins` lista os instalados, com o estado por projeto;
  - `GET /v1/plugins/:id` dá o manifesto e o texto de ativação;
  - `POST /v1/plugins/:id/enable` e `/disable` recebem `project`;
  - `GET /v1/plugins/:id/panel?project=` traz os blocos já com os dados: o daemon chama as ferramentas `source`, de leitura;
  - `POST /v1/plugins/:id/actions/:tool` chama a `action` em nome do Produtor, com a mesma permissão, aprovação e evento de qualquer chamada.
- Os dados do painel passam por um teto de tamanho e de linhas (`plugins.panel.max_rows`, padrão 200) **[proposta]**, e o texto de tela vem do catálogo do plugin no idioma da interface, com o `en` como reserva.
- **Aceite:** as rotas com o plugin de exemplo; uma `source` sem efeito de leitura é impossível (o P3 já recusa); a `action` com aprovação espera o Produtor; o catálogo da API é regenerado.

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
- a instalação por pacote npm ou por git (N236 (b) e (c));
- a autenticação de servidores `http` de plugin fora do loopback;
- a Fase 9b (agendador e tarefas): a entrega por plugin espera esta fase.

## Decisões que surgem deste plano

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
