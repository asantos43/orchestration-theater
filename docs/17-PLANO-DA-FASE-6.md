# 17. Plano da Fase 6

Versão 1, de 2026-11-19. Este é o plano de passos da Fase 6 da [arquitetura](framework-ideas/arquitetura.md), §10, "API do daemon e cliente compartilhado". A arquitetura continua sendo a referência: este plano só divide a fase em passos, diz o que pode correr em paralelo e dá o aceite de cada passo. Se os dois divergirem, vale a arquitetura, e este documento é corrigido.

O plano levanta oito decisões, N164 a N171 ([docs/13](13-DECISOES-EM-ABERTO.md)). O dono decidiu todas em 2026-11-19, por múltipla escolha, iguais à recomendação, e nenhuma segue aberta. O resumo está em "Decisões que surgem deste plano", no fim. Pela N171, os PRs da Fase 6 mesclam sem ok por PR, com a CI verde e squash, como nas Fases 3 a 5.

## Como usar

- Cada passo tem uma branch e um PR com título "Fase 6: ...". O PR que conclui um passo também muda o estado dele na tabela de passos.
- O merge é pelo `merge-pr.sh`, com squash, depois da CI verde e com a branch atualizada com a main (N171). Nunca com `gh pr merge --auto`.
- Todo passo exige, além do aceite próprio, `build`, `lint`, `format:check`, `test`, `verify` e `deps` verdes na máquina e na CI. O job `linux` roda em todo PR. Os jobs `cross` e `windows-launcher` rodam nos PRs que mexem em código (N162).
- O que está marcado **[proposta]** é detalhe deste plano, ainda sem decisão. Todo padrão novo vira uma chave de configuração, com um padrão e os seus modos. Se a chave mudar algum comportamento visível, a escolha vai ao dono, por múltipla escolha, ao abrir o passo.
- Paralelismo:
  - passos sem dependência entre si correm ao mesmo tempo, cada um no seu worktree;
  - dois passos nunca mexem nos mesmos arquivos. Há três exceções, em que cada passo acrescenta só o seu bloco e o conflito se resolve no merge da main na branch:
    - o `DaemonConfigSchema` (`daemon/src/config.ts`);
    - o índice do protocolo (`protocol/src/index.ts`);
    - o `compose.ts`;
  - as rotas ficam um arquivo por recurso em `daemon/src/api/routes/`, para que os passos de REST corram juntos;
  - no máximo dois subagentes rodam a suíte completa ao mesmo tempo, por causa da memória da máquina.
- **Nada real roda nos testes (N57).** A API e o `packages/client` são testados contra o daemon com o `fake-agent`, o relógio falso e o store em memória ou num SQLite temporário. Nenhum teste abre porta fora do loopback nem lê credencial.
- **Nenhum download novo sem decisão do dono.** Cada download vira uma linha no docs/13 antes de entrar. Os candidatos desta fase estão em "Dependências novas".
- **Claudexor (N41, §6.3):** a referência da API é `packages/control-api` e `docs/reference/endpoints.json`. Pela N119, o passo que abrir a REST (P5) relê esses arquivos no commit mais novo, por `gh api` e sem clone. Ele registra o commit e, se adaptar algum trecho, acrescenta a atribuição. Hoje a referência fixada é a tag `v6.1.2` (commit `7a87c33`) **[V: §6.3]**. Os arquivos ainda não foram lidos para esta fase **[N]**.

## Ponto de partida

O que já existe foi conferido no código em 2026-11-19, no commit `fe2e3e1` **[V]**. Os caminhos são relativos a `packages/`.

- **HTTP no daemon:**
  - o Hono (`hono` 4.13.16) e o `@hono/node-server` 2.1.6 já são dependências do daemon. Eles servem o MCP do framework (`daemon/src/mcp/server.ts`) e o canal do Produtor (`daemon/src/orchestration/channel-http.ts`);
  - **não há** API REST, SSE nem WebSocket, nem chave `api.*` na configuração;
  - o `@hono/node-server` 2.1.6 aceita WebSocket direto (`serve({ websocket: { server } })`, com o `upgradeWebSocket` de `hono/ws`), desde que receba um servidor no formato do `WebSocketServer` do `ws` **[V: `dist/index.d.mts`]**. Não falta adaptador, só o `ws`.
- **O canal do Produtor (N78), que a Fase 6 substitui:**
  - escuta só em `127.0.0.1`, em porta livre (`auto`), com um token aleatório novo a cada subida. O token e a URL ficam em `channel.json` (modo 0600) na pasta de dados, e o `ot chat` lê esse arquivo para achar o daemon;
  - tem seis rotas JSON: `/chat/open`, `/chat/send`, `/chat/attach`, `/chat/poll`, `/chat/answer` e `/chat/idea`. A conversa vem por **polling** de 300 ms (`CHAT_POLL_MS`), e o `poll` devolve respostas do Diretor, perguntas pendentes, estado das peças, mensagens de sistema e paradas da fila de ideias;
  - as requisições esperam o fim da reconciliação da subida (`RecoveryGate`, §5.21).
- **Eventos:**
  - a tabela `events` tem id inteiro autoincremental, e a porta `EventLog` (`core/src/ports/event-log.ts`) garante ids estritamente crescentes, não necessariamente sem buracos, com a visibilidade na ordem dos ids. Ela tem `append`, `readFrom(afterId, limit)` e `lastId()`. Isso basta para a retomada por `Last-Event-ID`;
  - **não há** aviso em processo de evento novo: quem acompanha o log hoje lê com `readFrom` em laço (`directives/service.ts`, `ideas/service.ts`, `scenarios/chat-flow.ts` e outros).
- **Estado de daemon:**
  - `protocol/src/api.ts` tem o `DaemonStatusSchema` (pid, início, versão, pasta de dados, estado), já pensado para o futuro `GET /status`;
  - **não há** id próprio do daemon. Cenários, peças e demandas têm ids locais (`S<n>`, `P<n>`, `D<n>`), únicos só dentro de um daemon.
- **Comandos `ot`:** `ot directives`, `ot profile` e outros abrem o store direto, sem passar pelo daemon. Só o `ot chat` fala com o daemon, pelo canal.
- **Pacotes:** não há `packages/client`. Os pacotes são `core`, `protocol`, `sdk`, `daemon`, `fake-agent` e os adaptadores.
- **Node 24.18:** `WebSocket` é global e `EventSource` não existe **[V: `node -e`]**. No navegador, o `EventSource` não manda o cabeçalho `Authorization`. Por isso o cliente lê o SSE sobre `fetch`, nos dois ambientes **[proposta]**.

## Dependências novas

As duas foram aprovadas pelo dono em 2026-11-19 (N164): o `ws` 8.23.0 como exceção de segurança à regra de duas semanas, e o `zustand` 5.1.0, instalado só a partir de 2026-11-20, quando faz duas semanas. Os dados abaixo vêm do registro npm e do GitHub, consultados em 2026-11-19 **[S]**:

| Pacote | Versão | Licença | Publicada | Passo | Observação |
|---|---|---|---|---|---|
| `ws` | 8.23.0 | MIT | 2026-11-12 | P7 | Corrige uma falha de esgotamento de memória por flood de Ping (notas da versão). Tem 7 dias, abaixo da regra de duas semanas. A 8.22.1 (2026-10-31) cumpre a regra, mas não tem a correção. Sem dependências; `bufferutil` e `utf-8-validate` são peers opcionais e não entram |
| `zustand` | 5.1.0 | MIT | 2026-11-06 | P11 | Duas semanas em 2026-11-20. Sem dependências; `react`, `immer` e `use-sync-external-store` são peers opcionais e não entram, porque o modo *vanilla* não usa nenhum deles |

Não entram **[proposta]**:
- o `@hono/node-ws`, porque o `@hono/node-server` 2.x já faz o upgrade. A versão 1.3.1 dele pede o `@hono/node-server` 1.x como peer;
- o `eventsource-parser` (MIT, 4.1.3) e qualquer polyfill de `EventSource`. O formato do SSE é curto, e o leitor fica no `packages/client`, com testes próprios;
- uma biblioteca de OpenAPI. O catálogo de rotas sai dos schemas zod do `packages/protocol`, por código próprio (P1).

## Passos

| Passo | Título | Depende de | Pode correr junto com | Estado |
|---|---|---|---|---|
| P0 | Plano e decisões (este documento) | nada | nada | concluído (PR #165) |
| P1 | Contrato da API no `packages/protocol` | P0 | P2, P3, P9 | concluído |
| P2 | Aviso de evento novo em processo | P0 | P1, P3, P9 | concluído |
| P3 | Servidor da API: bind, token, CORS, descoberta e id do daemon | P0 | P1, P2, P9 | concluído |
| P4 | SSE com `Last-Event-ID` | P1, P2, P3 | P5, P6, P7, P10 | a fazer |
| P5 | REST de leitura | P1, P3 | P4, P6, P7, P10 | a fazer |
| P6 | REST de comandos | P1, P3 | P4, P5, P7, P10 | a fazer |
| P7 | WebSocket do chat, ligado à fila de prompts | P1, P2, P3 | P4, P5, P6, P10 | concluído, falta o teste com o cliente do P10 |
| P8 | `ot chat` sobre a API e o fim do canal antigo | P7, P10 | P11, P12 | a fazer |
| P9 | `packages/client`: base, REST tipado e vários daemons | P1 | P2, P3, P4 a P7 | concluído, falta o teste com daemons reais |
| P10 | `packages/client`: SSE com retomada e WebSocket | P9 | P4 a P7 | a fazer |
| P11 | `packages/client`: stores em zustand *vanilla* | P10 | P8, P12 | a fazer |
| P12 | Preferências de layout | P9 | P8, P11 | a fazer |
| P13 | Aceite da fase | todos | nada | a fazer |

Ordem em ondas **[proposta]**:
1. P1, P2, P3 e P9;
2. P4, P5, P6, P7 e P10;
3. P8, P11 e P12 (o P11 instala o `zustand` 5.1.0, que só pode entrar a partir de 2026-11-20).
4. P13.

Sem marco interno: a fase é curta, e o aceite só faz sentido com a API e o cliente juntos **[proposta]**.

**Estimativa:** 1,5 semana, como na §10. Pelo ritmo medido nas Fases 1 a 5, com agentes, fica mais perto de 1 semana **[proposta]**. São 13 passos, contra 23 da Fase 5.

### P1. Contrato da API no `packages/protocol` (§5.12)

**Escopo:** só a base do contrato **[proposta]**. Os schemas de cada recurso (cenários, peças, perfis, ordens...) vêm com o passo que abre as rotas deles, P5 e P6, um arquivo por recurso em `protocol/src/api/<recurso>.ts`:
- `protocol/src/api/`, com o auxiliar `defineRoute` e o registro `API_ROUTES`: método, caminho, parâmetros, consulta, cabeçalhos, corpo, resposta e erros de cada rota. O contrato é a única fonte: o daemon valida com ele, e o `packages/client` tipa com ele.
- Prefixo `/v1` em todas as rotas, e a versão do contrato em `GET /v1/status` (`apiVersion`), inteiro a partir de 1 **[proposta]**. O `ApiStatusSchema` é o `DaemonStatusSchema` mais `daemonId` e `apiVersion`; o `DaemonStatusSchema` não muda.
- Formato de erro único: `{ error: { code, message, details? } }`, com a tabela de códigos e status HTTP (`invalid_input` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404, `conflict` 409, `payload_too_large` 413, `quota_exhausted` 429, `vault_locked` 503, `unavailable` 503, `recovering` 503, `internal` 500) e o mapa dos erros do core para ela **[proposta]**. É o que o canal faz hoje, com nome de código no lugar do texto solto.
- O id do daemon (`daemonId`, UUID) e a referência global de um cenário (`{ daemonId, scenarioId }`) (N168).
- Paginação por cursor (`after`, `limit` com teto: padrão 50, máximo 200 **[proposta]**, resposta `{ items, nextCursor }`) e o cabeçalho `Idempotency-Key`.
- O SSE (P4): a consulta de `GET /v1/events`, o cabeçalho `Last-Event-ID` e o envelope da mensagem: `id` (o id do log), `event` (o tipo) e `data` (o `EventEnvelope` inteiro, com `daemonId`).
- O WebSocket do chat (P7): `POST /v1/chat-tickets`, `GET /v1/scenarios/:id/chat` e as mensagens nos dois sentidos, como união discriminada por `type` **[proposta]**.
- As preferências de layout (N170): schema com versão, por interface (`tui`, `web`), e `GET`/`PUT /v1/layout/:interface`.
- O catálogo das rotas, gerado dos schemas por `z.toJSONSchema` e versionado em `docs/reference/api-routes.json`, equivalente do `endpoints.json` do Claudexor **[proposta]**. A conferência é um teste do vitest (arquivo de *snapshot*) que falha se o arquivo não bate; a regeneração é `pnpm api:catalog`.

**Aceite:** os schemas fazem o caminho de ida e volta (parse do que o daemon gera); o catálogo gerado bate com o versionado; nenhuma rota sem schema de resposta e de erro.

**Resultado (2026-11-19):** feito na branch `fase6/p1-contrato`. Arquivos em `packages/protocol/src/api/`: `route.ts` (`defineRoute`, `routePath`, `assertUniqueRoutes`), `errors.ts`, `ids.ts`, `page.ts`, `status.ts`, `sse.ts`, `chat.ts`, `layout.ts`, `registry.ts` (`API_ROUTES`, `API_ROUTE_LIST`), `catalog.ts` e `index.ts`, mais um `*.test.ts` para cada um; o `index.ts` do protocolo reexporta tudo. O catálogo versionado é `docs/reference/api-routes.json`, e o script `api:catalog` entrou no `package.json` da raiz. Sem dependência nova. [V] `tsc -b`, `eslint packages/protocol` e os testes do protocolo (26 arquivos, 160 testes) passam localmente: ida e volta dos schemas, toda rota com resposta e erros, nenhum caminho fora de `/v1`, caminho único por método, catálogo igual ao arquivo, e as uniões do WebSocket recusando `type` desconhecido. Os schemas por recurso ficam para P5 e P6. Para acrescentar rota: criar `api/<recurso>.ts`, espalhar a tabela `*_ROUTES` em `registry.ts` e rodar `pnpm api:catalog`.

### P2. Aviso de evento novo em processo (§5.11, P6 da arquitetura)

**Escopo:**
- Um `EventHub` no daemon que embrulha o `EventLog`: depois do commit de um `append`, avisa os assinantes com o envelope. A porta `EventLog` do core não muda **[proposta]**.
- O assinante recebe o aviso e, se perceber buraco (id maior que o esperado mais os buracos que o contrato admite), relê pelo `readFrom`. A regra é a do contrato do `EventLog`: o cursor é o último id recebido, e nunca se supõe `id === anterior + 1`.
- Fila por assinante com teto, `api.sse.buffer_events` **[proposta: 1000]**. O assinante lento perde o aviso ao vivo e volta a ler do log, sem travar quem escreve.
- Os serviços que hoje fazem polling no log podem passar ao hub depois, cada um no seu passo. Este passo não muda nenhum deles **[proposta]**.

**Aceite:** o assinante recebe todos os eventos em ordem com escritas concorrentes; um assinante lento não segura o `append`; depois de estourar o teto, ele recupera tudo pelo log, sem perder nem repetir; um `append` desfeito não gera aviso.

**Resultado (2026-11-19):** feito, com o `EventHub` em `packages/daemon/src/events/event-hub.ts` **[proposta: o nome e a pasta]**. A porta `EventLog` do core e o `packages/protocol` não mudaram.
- **Decorador do `Store`**, como o `validateEventsOf`: o `append` fora de transação avisa quando a promessa resolve; dentro de uma transação, os eventos são juntados e avisados todos depois do commit; transação desfeita não avisa nada. No `compose.ts` o hub é o decorador mais interno (`hub.store`), por baixo da validação do N80, então todo `append` que chega ao adaptador é avisado, o validado e o do `DaemonHandle.store`, e o que o registro recusa nunca é. O hub entra em `Composition.eventHub` e em `DaemonHandle.eventHub`, e é fechado (os streams terminam) antes do fechamento do store.
- **`follow({ afterId?, filter?, signal, pageSize? })`** devolve um `AsyncGenerator<EventEnvelope>`. **[proposta]** O aviso é só um despertador: os envelopes vêm sempre do `readFrom(cursor)`, uma leitura por vez por assinante, e os avisos que chegam durante a leitura viram uma marca só. O histórico e o ao vivo são o mesmo laço, então não há troca para errar. Não há entrega direta do envelope avisado, porque dois commits podem ser avisados fora de ordem e nada distingue um buraco de id de um evento ainda não avisado. O cursor é o id do último evento lido, avança pelo id global mesmo sobre o que o filtro derruba, e nunca supõe `id === anterior + 1`. `afterId` ausente começa em `lastId()`, lido no primeiro `next()`. O filtro (`scenarioIds`, `typePrefixes`; lista vazia = sem restrição) vale na leitura, e o aviso de um evento que o filtro derruba nem acorda o assinante. O assinante só existe a partir do primeiro `next()`; `signal` abortado, `break` do consumidor ou `hub.close()` o soltam na hora, mesmo com o consumidor parado (`hub.subscriberCount` volta a 0).
- **Teto** `api.sse.buffer_events` (padrão 1000 **[proposta]**; inteiro >= 1; bloco `api` no `DaemonConfigSchema`, onde o P3 acrescenta `port`, `token`, `remote` e `cors`). Como nenhum envelope fica em fila (a memória já é limitada), o teto conta os avisos ao vivo que o assinante deixou sem ler: ao passar dele, o assinante registra um `warn` (uma vez por episódio, até alcançar o log) e segue lendo páginas do log, sem perder nem repetir. O escritor nunca espera: avisar é marcar uma flag por assinante. **[proposta]** O estouro só vai ao log; o evento da regra "situações viram eventos" (`api.stream_lagged`, com o cenário e o tamanho do atraso, ao P4 decidir com o catálogo de eventos da API) **não** foi criado neste passo, para não mexer no protocolo, que o P1 altera em paralelo.
- **Verificação [V]:** `event-hub.test.ts` (29 testes) cobre `append` e transação avisados depois do commit, transação desfeita e evento recusado pelo registro sem aviso, 150 `append` + 20 transações + 10 desfeitas em paralelo (todos em ordem, uma vez, transação nunca partida), mil eventos escritos durante a troca do histórico para o ao vivo (ids 1 a 2000 exatamente uma vez), buracos nos ids, filtro por cenário e prefixo, cursor avançando sobre o filtrado, assinante lento que não segura 3000 `append` e se recupera do log, aviso uma vez só, `signal` (esperando, parado no `yield`, já abortado), `break`, 50 assinantes e `close()` voltando a zero, e a chave de configuração. Mais um teste no `compose.test.ts` (store validado e cru avisados) e um no `daemon.test.ts` (`handle.eventHub`, e o stream termina na parada). O `pnpm check` da raiz passou [V]: build, lint, `format:check`, 325 arquivos de teste (5808 testes passados, 186 pulados) e `verify`.

### P3. Servidor da API: bind, token, CORS, descoberta e id do daemon (§5.12)

**Escopo:**
- `daemon/src/api/server.ts`, sobre o Hono e o `@hono/node-server` que já estão no daemon.
- **Bind:** só `127.0.0.1`. A chave `api.remote` existe com o padrão `off`; `vpn` e `proxy` são recusados com a mensagem de que chegam na Fase 12 **[proposta]**.
- **Porta:** `api.port: auto | <número>`, padrão `auto` (N166). A porta é escolhida livre a cada subida e publicada no `api.json`, como já fazem o MCP e o canal.
- **Token:** obrigatório em toda rota, inclusive `/v1/status`, comparado em tempo constante. Pela N165, ele é persistente: fica num arquivo próprio (`api-token`, modo 0600) na pasta de dados e sobrevive ao reinício. A chave é `api.token: persistent | per_start`, padrão `persistent`, e o comando `ot api rotate-token` troca o token. A troca fecha os streams e WebSockets abertos com o token velho **[proposta]**.
- **Descoberta:** o daemon publica `api.json` (modo 0600) na pasta de dados, com URL, `daemonId`, pid e versão do contrato. O token não vai no `api.json`: fica no `api-token`, que tem outro ciclo de vida **[proposta]**. O `api.json` some na parada limpa, e um arquivo velho é reconhecido pelo pid **[proposta]**.
- **CORS fechado:** nenhum cabeçalho `Access-Control-Allow-*` por padrão. A chave `api.cors.origins` começa vazia e serve à web da Fase 12 **[proposta]**.
- **Defesa contra DNS rebinding:** o cabeçalho `Host` precisa ser `127.0.0.1:<porta>` ou `localhost:<porta>`. Um `Origin` fora de `api.cors.origins` é recusado com 403 **[proposta]**. O token já basta contra uma página de outra origem; isso é defesa em profundidade.
- **Id do daemon:** um UUID gerado na primeira subida e guardado na pasta de dados (`daemon-id`). Ele entra no backup e é preservado pelo `ot restore` **[proposta]**. O id volta em `GET /v1/status` (`DaemonStatusSchema` ganha `daemonId` e `apiVersion`).
- O `RecoveryGate` segura as rotas de comando durante a reconciliação, como no canal. As de leitura e o SSE respondem desde a subida **[proposta]**.
- Limites: corpo máximo (`api.max_body_bytes` **[proposta: 1 MiB]**) e anexo por rota própria, com o limite de anexos da §5.20.
- Eventos `api.started` e `api.client_rejected` (motivo `token`, `host` ou `origin`, sem o valor recebido), pela regra de toda situação virar evento **[proposta]**.

**Aceite:** sem token, com token errado, com `Host` estranho ou com `Origin` fora da lista, a resposta é 401 ou 403 e o evento sai; o `api.json` e o `api-token` têm modo 0600, e o `api.json` some na parada; o token persiste no reinício e muda com a rotação, e com `per_start` muda a cada subida; o `daemonId` sobrevive a reinício e a backup com restauração; nenhum cabeçalho de CORS sai por padrão; o servidor não escuta em outra interface (teste que tenta o IP da máquina).

**Resultado (2026-11-19):** feito na branch `fase6/p3-servidor`. Sem dependência nova.
- **Arquivos.** Em `packages/daemon/src/api/`: `server.ts` (`ApiServer`, Hono sobre `@hono/node-server`, sem WebSocket), `handlers.ts` (`ApiHandlers`, `ApiFailure`) e `files.ts` (`daemon-id`, `api-token`, `api.json`, escrita atômica 0600); `commands-api.ts` (`ot api rotate-token`). No protocolo: `api-events.ts` (`api.started`, `api.client_rejected`, em `DAEMON_EVENT_DEFINITIONS`) e `api/admin.ts` (rota `rotateApiToken`; `registry.ts` e `index.ts` só ganharam a linha do `ADMIN_ROUTES`; o `discovery.ts` não precisou de campo novo). `docs/reference/api-routes.json` foi regerado com `pnpm api:catalog`. Também mudaram `config.ts` (bloco `api`), `paths.ts` (`apiDiscovery`, `apiToken`, `daemonId`), `daemon.ts`, `recovery/backup.ts` e `recovery/restore.ts`, e os catálogos `locales/*/cli.json`.
- **[V] Verificado localmente** (testes com pasta de dados temporária e portas `auto`, nada real): sem token, token errado e cabeçalho malformado dão 401, `Host` estranho e `Origin` fora da lista dão 403, e o evento sai sem nunca levar o valor recebido; `api.json` e `api-token` com modo 0600 (pulado no Windows) e `api.json` removido na parada; o token persiste no reinício, muda na rotação e muda a cada subida com `per_start`; o `daemonId` sobrevive a reinício e a `ot backup` mais `ot restore`; nenhum `Access-Control-Allow-*` por padrão (nem no preflight); o servidor só escuta em `127.0.0.1` (o teste tenta o IP não-loopback da máquina e pula, com o motivo, se não houver); porta ocupada vira `AdapterUnavailable` e libera o lock; rotas de comando esperam o `RecoveryGate` e as de leitura não; validação de parâmetros, query e corpo no formato `ApiErrorSchema`; 413 acima de `api.max_body_bytes`.
- **[proposta] Escolhas.** (1) Rota sem handler não é montada e responde 404 `not_found` (o conjunto de códigos de erro é fechado e não tem 501). (2) A troca do token é a rota `POST /v1/api-token/rotate` (resposta `{ "rotated": true }`, nunca o token; o novo fica só no `api-token`), autenticada com o token atual e fora do `RecoveryGate`; sem daemon, `ot api rotate-token` pega o lock e grava o token novo direto. (3) Token de 32 bytes aleatórios em base64url (43 caracteres), comparado pelo SHA-256 dos dois lados com `timingSafeEqual`. (4) Uma rota é "comando" por padrão quando o método não é GET; o handler pode marcar o contrário (`{ command: true | false }`). (5) A resposta de uma rota JSON é validada contra o schema da rota, e uma que não encaixa vira 500 `internal`. (6) O preflight (`OPTIONS` com `Origin`) é respondido sem token, só para origem da lista; os cabeçalhos CORS permitidos são fixos. (7) Limite de taxa do `api.client_rejected`: no máximo um evento por motivo a cada `api.rejection_events.every` (padrão `10s`, chave a mais que acrescentei por causa da regra de todo padrão ser chave de configuração), com o campo `suppressed` contando o que ficou de fora. (8) O `daemon-id` entra no backup e o `ot restore` o devolve (o id vivo e diferente fica como `daemon-id.before-restore-<carimbo>`; backup sem id ou com id estragado não mexe em nada). (9) O servidor sobe logo depois do `situations.open()` e antes das diretivas, e para antes de o store fechar.
- **Para P4 a P7.** O `DaemonHandle` ganhou `api` (o `ApiServer`) e `daemonId`. Para registrar uma rota: `daemon.api.handlers.register('<id de API_ROUTES>', handler, { command? })`, antes ou depois da subida (o handler é procurado a cada requisição); o `getStatus` já é registrado pelo `daemon.ts`. O handler recebe `{ params, query, headers, body, request, signal }` já validados e devolve o objeto da resposta (ou uma `Response`, obrigatório nas rotas `sse` e `websocket`); `throw new ApiFailure(code, message, { details })` produz o erro no formato do contrato. Disponíveis também: `api.url`, `api.stopSignal` (aborta na parada, para encerrar streams), `api.httpServer` (para o upgrade do WebSocket) e `api.guard(request)`, que repete Host, Origin e token com os mesmos eventos para quem toma a conexão (o chat, P7).
- **Gancho da rotação.** `api.onTokenRotated(listener)` devolve a função que o remove; o listener roda logo depois da troca e deve fechar os streams e sockets abertos com o token velho (P4 e P7 precisam registrá-lo). Um listener que falha vai ao log e não impede os outros.

### P4. SSE com `Last-Event-ID` (§5.12)

**Escopo:**
- `GET /v1/events`, com o `streamSSE` do Hono. Primeiro vem o histórico a partir do cursor, depois os eventos ao vivo, sem buraco nem repetição na troca.
- Cursor: o cabeçalho `Last-Event-ID` tem precedência sobre o parâmetro `since`. Sem nenhum dos dois, o stream começa no evento mais novo, sem histórico **[proposta]**.
- Filtros: `scenario` (um ou vários) e `types` (prefixos, como `play.` ou `quota.`). O cursor continua o id global do log, então a retomada com filtro funciona igual.
- Batimento (comentário SSE) a cada `api.sse.heartbeat` **[proposta: 15 s]** e campo `retry` **[proposta: 2 s]**.
- O cliente que cai para trás do teto do hub (P2) volta a ler do log, sem sair do stream.
- Teto de streams abertos, `api.sse.max_streams` **[proposta: 32]**. Acima dele, 503 com `Retry-After`.

**Aceite:** um stream que cai no meio de uma peça e volta com `Last-Event-ID` recebe todos os eventos seguintes uma vez só; com mil eventos escritos durante a troca do histórico para o ao vivo, nenhum falta nem se repete; o filtro por cenário não deixa passar evento de outro cenário; o batimento chega com o relógio falso.

### P5. REST de leitura (§5.12)

**Escopo:** rotas `GET` só para o que existe hoje no daemon (N167). Assistentes, plugins e `/metrics` chegam com as fases deles:
- cenários (projetos, tarefas e chats), com peças, demandas e decisões pendentes;
- blackboard e anexos de um cenário (metadados; o conteúdo do anexo por rota própria);
- perfis e o estado de cota de cada um, Executores e papéis (com a lista ordenada e a regra próximo/esperar);
- ordens vigentes, agendadas e encerradas, e a fila de ideias;
- consumo e teto de gasto;
- a configuração efetiva, sem segredo nenhum: as chaves que apontam para o cofre saem como referência, nunca como valor;
- `GET /v1/status`.

Paginação por cursor (`after`, `limit`, base do P1) nas listas que crescem **[proposta]**. Os schemas de cada recurso lido nascem aqui, um arquivo por recurso em `protocol/src/api/<recurso>.ts`, e entram em `API_ROUTES` **[proposta]**. Antes de abrir, o passo relê o `control-api` e o `endpoints.json` do Claudexor (N119) e registra o commit lido.

**Aceite:** cada rota responde no schema do P1, testada contra o daemon com o `fake-agent`; uma busca no texto das respostas da configuração não acha nenhum valor do cofre falso; as listas paginadas não perdem item entre páginas com escrita no meio.

### P6. REST de comandos (§5.12)

**Escopo:** rotas `POST`, `PUT` e `DELETE` para os comandos que o daemon já tem:
- abrir um cenário (o que o `/chat/open` faz hoje), anexar e responder a uma decisão;
- pausar, retomar e cancelar uma peça ou um Ator;
- ordens: criar, prorrogar, suspender e revogar;
- fila de ideias: os comandos do `/idea`;
- perfis: cadastrar, drenar e remover. O login oficial pela interface fica para a Fase 7, que desenha o painel dele; aqui entra só o que não é interativo **[proposta]**;
- editar a configuração, com a validação do `config-edit.ts`.

Os schemas de cada recurso de comando nascem aqui, em `protocol/src/api/<recurso>.ts`, e entram em `API_ROUTES` **[proposta]**. Todo comando aceita `Idempotency-Key` (formato definido no P1). Uma repetição com a mesma chave devolve a resposta da primeira vez, guardada por `api.idempotency_ttl` **[proposta: 24 h]**. Todo comando vira evento, como já acontece no daemon.

**Aceite:** cada comando tem teste contra o daemon com o `fake-agent`; uma repetição com a mesma `Idempotency-Key` não duplica efeito; um comando durante a reconciliação espera o fim dela; um corpo fora do schema dá 400 com o caminho do campo.

### P7. WebSocket do chat, ligado à fila de prompts (§5.4, §5.12)

**Escopo:**
- `GET /v1/scenarios/:id/chat` com upgrade para WebSocket, pelo `ws` e pelo suporte do `@hono/node-server` (N164).
- **Autenticação:** o navegador não manda `Authorization` no WebSocket. O cliente pega antes um bilhete de uso único (`POST /v1/chat-tickets`, validade de 30 s) e o passa como parâmetro. O token nunca vai na URL **[proposta]**.
- **Do Produtor para o daemon:** mensagem (texto e anexos já enviados), resposta a uma decisão e comando `/`. A mensagem entra na fila única de prompts (`PromptDispatcher`, §5.4) com a prioridade do Produtor, como o `/chat/send` faz hoje.
- **Do daemon para o Produtor:** resposta do Diretor (inteira ou em partes, se o Executor mandar em partes), pergunta pendente, mensagem de sistema, parada da fila de ideias e mudança de estado da peça. É o que o `poll` do canal entrega hoje, empurrado.
- **Retomada:** cada mensagem do daemon leva o id do evento que a gerou. Ao reconectar, o cliente manda o último id, e o daemon reenvia o que falta, como no SSE **[proposta]**.
- Presença: um WebSocket aberto marca o cenário como "com alguém olhando", como o `poll` faz hoje (N89).
- Batimento por ping e pong do protocolo, com o teto de pongs pendentes da versão 8.23.0 do `ws` **[proposta]**.

**Aceite:** uma conversa com o Diretor do `fake-agent` passa inteira pelo WebSocket, com uma pergunta respondida; a mensagem passa pela fila de prompts (o evento da fila aparece); a conexão que cai e volta não perde nem repete mensagem; um bilhete usado duas vezes ou vencido é recusado.

**Resultado (2026-11-19):** feito na branch `fase6/p7-chat-ws`, sobre o `ws` 8.23.0 (a única dependência nova, autorizada pelo N164; sem `@types/ws` nem `@hono/node-ws`, os tipos usados estão à mão em `packages/daemon/src/types/ws.d.ts` **[proposta]**, incluído também no `tsconfig.test.json`).
- **Arquivos.** `packages/daemon/src/api/chat-tickets.ts` (`ChatTickets`), `chat-socket.ts` (`registerChatRoutes` e `ChatSession`, uma por socket), `orchestration/chat-feed.ts` (o decorador do store que grava o `chat.ask` na mesma transação da decisão), `packages/protocol/src/chat-events.ts` (os payloads) e, ao lado, os testes. Mexidos: `api/server.ts` (o `serve` com `websocket: { server }`, os sockets abertos, `rejectTicket`, `recordMessageRejected`, o fechamento com 1001 na parada), `api/handlers.ts` (o gancho `upgrade` do handler), `orchestration/channel.ts` (`state` e `pendingAsk`, sem efeito colateral; o `poll` usa o `state`), `presence.ts` (`hold`), `prompt-dispatcher.ts` (`onQueued`), `director.ts` (`onReply`), `wiring.ts`, `compose.ts` e `daemon.ts` (as rotas se registram depois da subida da orquestração).
- **Eventos novos** (catálogo do daemon, 90 tipos; registro do daemon 92): `prompt.queued` (quem, prioridade e item, nunca o texto), `chat.director_reply`, `chat.ask` e `api.chat_closed` (`reason` e `code`; nunca o bilhete nem o token). `API_REJECTION_REASONS` ganhou `ticket` e `message`.
- **Bilhete.** `POST /v1/chat-tickets` (com token) devolve 32 bytes em base64url, de uso único, de um cenário, com validade de `api.chat.ticket_ttl`. O `redeem` apaga o bilhete qualquer que seja a resposta, e os vencidos saem a cada emissão ou uso. Recusa (reuso, vencido, de outro cenário, ausente ou malformado): 401 e `api.client_rejected` com `reason: ticket`. A rotação do token limpa os bilhetes e fecha os sockets com 1008 (`token_rotated`). **[proposta]** Os bilhetes ficam só em memória.
- **Do Produtor ao daemon.** `message` e `command` entram na fila única de prompts pelo `channel.send` (o evento `prompt.queued` aparece); `answer` vai ao `channel.answer`. **[proposta]** O texto do comando `/` vai ao Diretor como mensagem, como o `/chat/send` faz hoje (o registro dos comandos é da Fase 7, N44). Mensagem fora do schema: quadro `error` (`invalid_input`, com o caminho do campo), `api.client_rejected` com `reason: message`, e o socket segue aberto; passar de `max_message_bytes` termina com 1009.
- **Do daemon ao Produtor.** Um laço de `hub.follow` do cenário (prefixos `chat.director_reply`, `chat.ask`, `scenario.system_message`, `idea.queue_held`, `play.transitioned`) vira `director_reply`, `ask`, `system`, `queue_held` e `play_state`, cada um com o `eventId` do evento que o gerou. `waits` e `busy` não são eventos: vêm do estado do cenário (`channel.state`) a cada `api.chat.state_interval`, só quando mudam. **[proposta]** Eles levam o cursor do laço (nunca o fim do log), para que o cursor do cliente, que é o maior `eventId` recebido, não pule um evento que ainda não chegou. **[proposta]** A resposta do Diretor sai inteira (`final: true`); partes ficam para depois.
- **Retomada.** O socket só começa a mandar depois da primeira mensagem do cliente ou de `api.chat.resume_window` **[proposta: 250 ms]**, para que um `resume` no primeiro quadro não corra com o que o daemon mandaria. Com `resume{lastEventId}`, reenvia dali em diante pelo `hub.follow`, sem perda nem repetição; sem cursor, manda primeiro as perguntas pendentes (com `eventId` igual ao fim do log, **[proposta]**) e segue ao vivo. Um cursor além do fim do log dá `invalid_input` e recomeça do estado atual. Uma pergunta que já saiu no estado inicial não volta pelo laço, e uma já respondida ou cancelada não é mais enviada.
- **Presença.** O socket aberto chama `presence.hold`: o cenário conta como visto sem `poll`, enquanto durar; ao fechar o último socket, vale a janela como depois de um `poll`. O modo `never` continua dizendo que ninguém vê.
- **Batimento.** `ping` a cada `api.chat.heartbeat`; sem `pong` até o seguinte, `terminate` e `api.chat_closed` com `no_pong`. `maxPendingAutoPongs` vem de `api.chat.max_pending_pongs`. **[proposta]** Falha do laço de eventos fecha com 1011 e o motivo `feed_failed` (o cliente reconecta com `resume`).
- **Chaves novas** em `api.chat` (todas com padrão **[proposta]**): `state_interval` (1 s) e `resume_window` (250 ms); as demais (`ticket_ttl`, `heartbeat`, `close_grace`, `max_message_bytes`, `max_pending_pongs`) já vinham do P3.
- **Verificação [V].** `chat-socket.e2e.test.ts` (9 testes, contra o daemon com o `fake-agent`, o relógio falso e o SQLite temporário, em loopback): conversa inteira com uma pergunta respondida e o `prompt.queued` no log; mensagem inválida; queda e volta com `resume` (um, dois e três, cada um uma vez, e nenhum `eventId` de evento abaixo do cursor); pergunta pendente reenviada a uma conexão nova e não a uma com cursor além dela; bilhete reusado, vencido (relógio falso), de outro cenário, ausente e curto, todos 401, com o bilhete e o token fora do log; criação do bilhete sem token (401) e para cenário inexistente (404); `no_pong` com um cliente `ws` de `autoPong: false`; rotação do token (1008 e `token_rotated`); e o menu de entrega (`delivery.mode: ask`) respondido pelo socket, que não é cancelado depois de 120 s do relógio sem nenhum `poll`. Repetido 3 vezes sem falha. Mais `chat-tickets.test.ts`, os testes de `hold` em `presence.test.ts`, `chat-events.test.ts` e os de configuração e contagem. O `heartbeat` do teste fica em 30 s, menos no do `no_pong` (150 ms): o daemon e o cliente do teste dividem um laço de eventos, e uma parada sob carga parece um pong que não veio (visto numa rodada completa). `pnpm check` completo: 343 arquivos e 6024 testes passam (186 pulados), mais `lint`, `format:check`, `verify` e `deps`; o `THIRD_PARTY_NOTICES.md` foi refeito com `pnpm notices` por causa do `ws`.
- **Falta.** (1) O teste com o cliente real do P10 contra este socket (o P10 está na main, não nesta branch). (2) Uma decisão antiga sem evento `chat.ask` (criada antes deste passo, ou se a gravação do evento falhar) não chega a um cliente que retoma; só a conexão sem cursor a vê, pelo estado inicial. (3) O `channel.ts` ainda guarda `#notices` e `#holds` que crescem se ninguém fizer `poll`: sai no P8, com o canal antigo. (4) Um evento que não cabe no seu quadro só vai ao log (`warn`); só aconteceria por um bug do próprio daemon, por isso não ganhou tipo novo.
- **Para os passos seguintes.** P4: este passo mexe nos mesmos arquivos do protocolo (`index.ts`, `api-events.ts`, `events.ts`, e as contagens nos testes de registro): o merge é só somar os dois blocos e os dois números. P10: o cliente deve mandar o `resume` como primeiro quadro só se tiver cursor (o daemon espera `resume_window` por ele), e pode ignorar os quadros `waits` e `busy` ao calcular o cursor, mas não precisa. P8: o `ot chat` abre o bilhete por `createChatTicket` a cada conexão, inclusive a cada reconexão (o bilhete é de uso único).

### P8. `ot chat` sobre a API e o fim do canal antigo

**Escopo:**
- O `ot chat` passa a usar o `packages/client` (N169): descoberta pelo `api.json`, conversa pelo WebSocket e anexos pela REST.
- O comportamento visível do `ot chat` não muda: os mesmos comandos, as mesmas mensagens e o mesmo catálogo de idioma.
- Sai o `channel-http.ts`, o `channel.json` e a entrada `channel` de `paths.ts`. O `ProducerChannel`, que é a lógica, fica e passa a ser usado pelas rotas.

**Aceite:** os testes atuais do `ot chat` (`chat-command.test.ts`, `chat-idea-command.test.ts`) passam sem mudar o que conferem; nenhum arquivo cita `channel.json`; o daemon abre uma porta HTTP a menos.

### P9. `packages/client`: base, REST tipado e vários daemons

**Escopo:**
- Pacote novo `@otheater/client` (MPL-2.0), que só depende do `protocol` e do core de tipos, sem nada de interface, de Node só onde for inevitável e com o acesso a arquivo isolado num módulo próprio. A regra do `dependency-cruiser` impede que ele importe o daemon **[proposta]**.
- Cliente REST tipado, gerado a partir dos schemas do P1, sobre `fetch`, com validação da resposta e erros tipados.
- **Vários daemons (N134, N168):** uma lista de conexões (`client.daemons`), cada uma com nome, URL, `daemonId`, token e, no futuro, a impressão digital do certificado. O daemon local entra sozinho pelo `api.json`. Toda referência de cenário no cliente leva o `daemonId`. Pareamento remoto e TLS ficam para a Fase 12.
- O arquivo da lista fica na pasta de configuração do cliente, com modo 0600, porque guarda tokens **[proposta]**.

**Aceite:** o cliente lê e escreve em dois daemons ao mesmo tempo num teste com dois daemons reais com o `fake-agent`, cada um na sua pasta; uma resposta fora do schema vira erro tipado, não exceção solta; o pacote não importa nada do daemon (regra do `deps`).

**Resultado (2026-11-19):** feito na branch `fase6/p9-client`, com o pacote em `packages/client` (`@otheater/client`, MPL-2.0, só depende de `@otheater/protocol` e `zod`; o `@otheater/core` não entrou porque o cliente não importa nada dele). Arquivos em `src/`: `errors.ts`, `client.ts` (`ApiClient`), `directory.ts` (`DaemonDirectory`), `refs.ts` e `index.ts` (seguro para o navegador), e em `src/node/` os únicos módulos que tocam em Node: `paths.ts`, `files.ts` e `index.ts` (export `@otheater/client/node`, com `createNodeDaemonDirectory`). Os testes usam um daemon de teste em processo (`test-daemon.test-support.ts`, só nos testes: fora do `tsconfig.src.json` e do pacote publicado).

- **`ApiClient`:** `client.call(route, { params, query, body, headers, signal, timeoutMs })` sobre um `fetch` injetável, com `Authorization: Bearer`. As opções exigem exatamente o que a rota tem (checado pelo compilador). Params, query, body e headers são validados pelo schema da rota antes de enviar (`ApiInputError`, nada sai) e a resposta pelo `response` da rota. Rota `sse` ou `websocket` em `call` lança `TypeError` (o tipo de `defineRoute` não distingue o `kind`, então a recusa é em execução; essas rotas são do P10). Atalhos `status()`, `connect()` (confere o `daemonId` e a versão da API) e `scenarioRef(id)`. O token fica só em campo privado e não entra em mensagem de erro. Sem redirecionamento automático (`redirect: 'manual'`), tempo limite padrão de 30 s (`0` = sem limite) e `AbortSignal` do chamador.
- **Erros tipados** (todos com `daemonId` e `routeId`): `ApiRequestError` (corpo de erro do daemon: `code`, `status`, `details`, `retryAfterSeconds`), `ApiProtocolError` (`invalid_json`, `invalid_response`, `invalid_error_body`: resposta fora do schema, HTML, redirecionamento, corpo vazio), `ApiNetworkError` (`connection`, `timeout`, `aborted`), `ApiInputError`, `DaemonIdMismatchError`, `ApiVersionError` e `DaemonDirectoryError`.
- **`DaemonDirectory`:** lista de conexões (`name`, `url`, `daemonId`, `token`, `fingerprint?` para a Fase 12). `list()` põe o daemon local primeiro; `add`, `enroll`, `update`, `remove`, `connect(name)` e `connectAll()` (um daemon fora do ar ou errado vira resultado, não exceção). `add` não usa a rede; `enroll` aprende o `daemonId` pelo `GET /v1/status`. As escritas da lista rodam uma de cada vez. O arquivo é `client.json` na pasta de configuração, escrito em arquivo temporário com modo 0600 e `rename`; arquivo corrompido vira `unreadable_file` e nunca é sobrescrito. O daemon local entra sozinho por `api.json` + `api-token` na pasta de dados; pid morto, arquivo inválido ou sem token = ausente. `refs.ts` dá `scenarioRefKey`, `parseScenarioRefKey` e `sameScenario` (a chave leva sempre o `daemonId`).
- **Regras do `dependency-cruiser`:** `client-only-protocol-and-zod` (sem módulos de Node fora de `src/node/`), `client-node-folder`, `client-node-folder-limits` e `client-never-daemon` (nem os testes importam daemon, adapters ou fake-agent). [V] `pnpm deps` passa, e arquivos com violações propositais acionaram as regras.
- **[V] verificado localmente:** `tsc -b`, `eslint packages/client` e `vitest run packages/client` (3 arquivos, 78 testes): chamadas tipadas, query com lista repetida, caminho com escape, todos os erros acima (incluindo queda, tempo limite, abortar antes e durante a chamada, redirecionamento e corpo HTML), `connect` com id e versão trocados, lista em arquivo 0600, pid de processo realmente encerrado, tabelas de pastas das três plataformas, 10 `add` simultâneos e **dois daemons de teste em processo ao mesmo tempo**, cada um com seu token, seu id e seu estado de layout, um descoberto como local e o outro salvo por `enroll`. O modo 0600 não é conferido no Windows (convenção dos outros arquivos 0600), onde o teste é pulado.
- **[proposta]:** (1) `local` é nome reservado; (2) uma entrada salva com o mesmo `daemonId` do daemon local fica escondida da lista (continua no arquivo), para um cenário não aparecer duas vezes; (3) `enroll` confia na primeira resposta (*trust on first use*) e a impressão digital da Fase 12 fixa o certificado; (4) pasta de configuração do cliente: Linux `$XDG_CONFIG_HOME/otheater` (só se absoluto) ou `~/.config/otheater`, macOS `~/Library/Application Support/OTheater`, Windows `%APPDATA%\OTheater`, trocável por `OT_CLIENT_CONFIG_DIR`; (5) `defaultDataDir` e `resolveDataDir` em `src/node/paths.ts` são cópia das do daemon, porque o cliente não pode importar o daemon (o comentário no código pede manter as duas em dia); (6) o arquivo `.test-support.ts` do daemon de teste vive em `src/` e é isento nas regras de Node. O protocolo não precisou de nada novo.
- **Falta:** o aceite pede dois daemons reais com o `fake-agent`; isso entra quando o P3 (servidor da API) estiver na main. Hoje os testes usam servidores em processo, o que cobre o cliente mas não o servidor.
- **Para o P10, P11 e P12:** usem `ApiClient` e `DaemonDirectory`. Os clientes de SSE e WebSocket tomam `url` e `daemonId` do `ApiClient` e o token de `ConnectedDaemon.entry.token` (o `ApiClient` guarda o dele em campo privado). O módulo `@otheater/client/node` serve ao `ot chat` (P8). As rotas `getLayout` e `putLayout` já funcionam por `call`; o modo `local` do armazém de layout deve usar a pasta de configuração do cliente (`resolveClientConfigDir`).

### P10. `packages/client`: SSE com retomada e WebSocket

**Escopo:**
- Leitor de SSE próprio sobre `fetch` com corpo em stream, que funciona no Node 24 e no navegador e manda o `Authorization`.
- Reconexão com recuo exponencial e o `Last-Event-ID` do último evento recebido. O campo `retry` do servidor ajusta o recuo.
- Cliente do WebSocket do chat sobre o `WebSocket` global (Node 24 e navegador), com o bilhete do P7 e a retomada pelo último id.
- Estado da conexão observável (`connecting`, `open`, `retrying`, `closed`) para a TUI mostrar.

**Aceite:** os testes de unidade cobrem o parser com campos partidos entre pedaços do stream, comentários, `retry` e eventos de várias linhas; contra o daemon, a queda forçada no meio de uma peça e a volta não perdem nem repetem evento.

### P11. `packages/client`: stores em zustand *vanilla*

**Escopo:**
- Stores com `createStore` do `zustand/vanilla` (N164), sem React: cenários, peças, demandas, decisões pendentes, cotas e eventos recentes.
- Cada store começa por uma leitura da REST e segue pelos eventos do SSE, com o id do último evento aplicado. Um evento com id já aplicado é ignorado. Assim a retomada do SSE não duplica estado.
- Os redutores de evento ficam em funções puras, testadas sem rede.
- Teto do store de eventos recentes, `client.events.keep` **[proposta: 500]**.

**Aceite:** o store de uma peça, montado só pelos eventos do SSE, fica igual ao estado lido pela REST no fim da peça; a mesma sequência de eventos aplicada duas vezes dá o mesmo estado; os testes rodam sem React.

### P12. Preferências de layout

**Escopo:**
- As preferências da §5.13: lateral recolhida, largura do chat, abas abertas e seções recolhidas.
- Pela N170, ficam no daemon, separadas por interface (`tui`, `web`), e são lidas e escritas pela REST. A chave é `ui.layout.store: daemon | local`, padrão `daemon`. No modo `local`, ficam num arquivo da pasta de configuração do cliente.
- Schema no `protocol`, com versão (feito no P1), e store próprio no `packages/client`.
- A escrita sai com atraso curto (*debounce*), para que arrastar a borda do chat não gere uma escrita por coluna **[proposta]**.

**Aceite:** as preferências salvas por um cliente voltam num cliente novo; um arquivo ou registro de versão antiga é migrado ou trocado pelo padrão, com aviso, sem travar a subida.

### P13. Aceite da fase

**Escopo:** um cliente de teste sobre o `packages/client`, contra o daemon com o `fake-agent`, que:
- acompanha uma peça inteira por SSE, da necessidade à entrega;
- derruba a conexão no meio e reconecta sem perder evento: a lista de ids recebidos é igual à do log, sem repetição;
- conversa com o Orquestrador pelo WebSocket, com uma pergunta respondida;
- vê os cenários de dois daemons ao mesmo tempo (N134, N168).

O aceite roda nos três sistemas da CI. O nível real (`tools/acceptance`) ganha um teste opcional com um cliente de verdade (Claude com haiku) acompanhado pela API **[proposta]**.

**Aceite:** o da §10, mais o item dos dois daemons; o resultado é registrado na §10 da arquitetura, como nas fases anteriores.

## Fora desta fase

- **`/metrics` no formato Prometheus:** depende de `telemetry.export` (§5.11) e entra na Fase 8.
- **Acesso remoto (`api.remote: vpn | proxy`), TLS e pareamento por QR:** Fase 12, com o app Android depois. Aqui a chave existe, só com `off`.
- **Assistentes de configuração (§5.7) e plugins (§5.14):** entram com as suas fases (7 e 9), e as rotas vêm junto.
- **Registro dos comandos `/` (N44):** Fase 7. O WebSocket do P7 só repassa o texto do comando, como o canal faz hoje.
- **Login oficial pela interface:** Fase 7. O P27 da Fase 5 já deixou o `LoginFlow.submitCode` pronto.
- **Mover cenário e federação (N134, níveis 2 e 3):** depois da v1.

## Decisões que surgem deste plano

Todas foram decididas pelo dono em 2026-11-19, por múltipla escolha, iguais à recomendação ([docs/13](13-DECISOES-EM-ABERTO.md)):
- **N164, dependências novas:**
  - `ws` 8.23.0 (MIT), como exceção de segurança à regra de duas semanas;
  - `zustand` 5.1.0 (MIT), só a partir de 2026-11-20;
  - leitor de SSE próprio, sem o `eventsource-parser`.
- **N165, token:** persistente num arquivo 0600, com rotação, e a chave `api.token: persistent | per_start`, padrão `persistent`.
- **N166, porta:** `api.port: auto | <número>`, padrão `auto`, com descoberta pelo `api.json`.
- **N167, escopo da REST:** só o que o daemon já faz.
- **N168, vários daemons (protocolo da N134):**
  - `daemonId` (UUID da primeira subida) no status e em todo cenário;
  - a lista `client.daemons` num arquivo 0600 do cliente;
  - o cliente falando com vários daemons, com um teste de dois daemons locais.
- **N169, canal do Produtor:** o `ot chat` migra para o `packages/client`, e o `channel-http.ts` sai no P8.
- **N170, preferências de layout:** no daemon, por interface, com `ui.layout.store: daemon | local`, padrão `daemon`.
- **N171, merge:** a autorização das Fases 3 a 5 vale também para a Fase 6. Com a CI verde, o squash é feito pelo `merge-pr.sh`, sem ok por PR.
