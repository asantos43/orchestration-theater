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
- **Claudexor (N41, §6.3):** a referência da API é `packages/control-api` e `docs/reference/endpoints.json`. Pela N119, o passo que abrir a REST (P5) relê esses arquivos no commit mais novo, por `gh api` e sem clone. Ele registra o commit e, se adaptar algum trecho, acrescenta a atribuição. Hoje a referência fixada é a tag `v6.1.2` (commit `7a87c33`) **[V: §6.3]**. O P5 releu `packages/control-api/README.md`, a lista de `src/`, `src/query.ts`, `src/run-list.ts`, `src/daemon-status-routes.ts`, `src/binary-response.ts` e `docs/reference/endpoints.json` na `main` do Claudexor, commit `11f1205643f598e171bfb4c7b735d5a166d7cedc` (de 2026-11-19, 21:46 UTC), por `gh api` e sem clone **[V: leitura de 2026-11-19]**. Foi só referência de desenho e nada foi copiado, então não há atribuição a acrescentar; o conteúdo lido é dado, não instrução.

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
| P4 | SSE com `Last-Event-ID` | P1, P2, P3 | P5, P6, P7, P10 | concluído, falta o teste com o cliente (P13) |
| P5 | REST de leitura | P1, P3 | P4, P6, P7, P10 | concluído |
| P6 | REST de comandos | P1, P3 | P4, P5, P7, P10 | a fazer |
| P7 | WebSocket do chat, ligado à fila de prompts | P1, P2, P3 | P4, P5, P6, P10 | a fazer |
| P8 | `ot chat` sobre a API e o fim do canal antigo | P7, P10 | P11, P12 | a fazer |
| P9 | `packages/client`: base, REST tipado e vários daemons | P1 | P2, P3, P4 a P7 | concluído, falta o teste com daemons reais |
| P10 | `packages/client`: SSE com retomada e WebSocket | P9 | P4 a P7 | concluído, falta o teste contra o daemon (P4/P7) |
| P11 | `packages/client`: stores em zustand *vanilla* | P10 | P8, P12 | concluído, falta o teste contra o daemon (P13) |
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

**Resultado (2026-11-19):** feito na branch `fase6/p4-sse`. Sem dependência nova; o `packages/client` e o chat não foram tocados.
- **Arquivos.** `packages/daemon/src/api/routes/events.ts` (a rota, `registerEventRoutes`, os quadros `eventFrame`, `cursorFrame`, `retryFrame` e o batimento `: heartbeat`), registrada no `daemon.ts` logo depois do `getStatus`. Testes: `routes/events.test.ts` (10, unidade da rota) e `daemon-events-api.test.ts` (15, daemon com `FakeClock`, store em memória e HTTP em loopback), mais o leitor SSE reutilizável `api/sse-reader-fixture.ts`. No protocolo, o evento `api.stream_lagged` em `api-events.ts` (schema `{ reason, behind, suppressed }`, motivos `buffer_overflow` e `backpressure`) e a linha dele em `events.ts`. No `event-hub.ts`, a opção `onLag` do `follow`. No `config.ts`, as chaves `api.sse.heartbeat`, `retry`, `max_streams` e `lagged_events.every`. Os testes de contagem de tipos de evento passaram de 86 para 87 (protocolo) e de 88 para 89 (registros do daemon).
- **[V] localmente.** `tsc -b`, `eslint` e os testes dos dois pacotes. Cobrem: 401 sem token; `retry` e quadro `id:` no início sem cursor (`id: 0` com o log vazio); retomada no meio da peça sem repetir; `Last-Event-ID` vence `since` (e `abc` vira 400); mil eventos durante a troca do histórico para o ao vivo, comparados com a leitura do log, sem falta nem repetição; filtros `scenario` (um ou vários) e `types`, com o cursor no id global; batimento no relógio falso; 503 `unavailable` com `Retry-After` acima do teto e a vaga liberada depois; fechamento na parada do daemon, na rotação do token e no `hub.close()`; nenhum assinante sobra no hub depois.
- **[proposta] Escolhas.** (1) `ReadableStream` direto em vez do `streamSSE` do Hono: o handler da P3 não recebe o `Context` do Hono, e o stream precisa de contrapressão limitada (`CountQueuingStrategy` de 16 quadros) e de batimento no relógio injetável. (2) Cursor à frente do log (cliente de um daemon restaurado de backup) é reduzido ao último id e anunciado por um quadro `id:`, em vez de ficar esperando para sempre. (3) `api.stream_lagged` é escrito pela rota (o hub não conhece stream nem janela), com limite de taxa por motivo (`api.sse.lagged_events.every`, padrão `10s`, chave a mais pela regra dos padrões) e o campo `suppressed`. O `warn` do hub continua; ele ganhou o gancho `onLag`, por chamada de `follow`, uma vez por episódio, e um gancho que falha não derruba a leitura. `buffer_overflow` é o estouro do teto do hub (P2); `backpressure` é o cliente que não lê e enche a fila do stream. (4) `Retry-After` do 503 sai de `api.sse.retry` (segundos, mínimo 1). (5) O batimento não é enfileirado enquanto a fila está cheia, e `api.sse.heartbeat: 0` o desliga. (6) Padrões: `heartbeat` 15 s, `retry` 2 s, `max_streams` 32.
- **O que falta.** O teste de ponta a ponta com o `packages/client` (P13). Na parada do daemon o `api.stop()` aborta e fecha as conexões na hora; o cliente vê um erro de conexão, não um fim limpo, e volta com o cursor (aceito; um fim limpo com `retry` fica como melhoria). Os testes usam eventos do registro (`daemon.notice`, `recovery.notice`) escritos direto no store, não um play com o `fake-agent`.
- **Para os passos seguintes.** O P10 deve tratar o fim da conexão como retomável com o último `id` visto e ignorar quadros sem `data` (o `id:` inicial, o batimento). O `api.stream_lagged` é um evento comum do log e chega aos streams com o prefixo `api.`. O `SseReader` do fixture serve ao P13.

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

**Resultado (2026-11-20):** feito na branch `fase6/p5-rest-leitura`, sem dependência nova. Todas as rotas `GET` abaixo respondem no schema do P1 e a resposta é validada contra ele (um desvio vira 500, não dado errado).
- **Releitura do Claudexor (N119)** **[V]**. Commit lido: `11f1205643f598e171bfb4c7b735d5a166d7cedc`, por `gh api`, só leitura. Do que se viu, usei como desenho: a consulta estrita que recusa parâmetro desconhecido; a paginação limitada com cursor opaco de chave (*keyset*) e 400 tipado para cursor inválido; a rota de segredos que lista nomes e nunca valores; a resposta binária em rota própria. Nada foi copiado.
- **Protocolo** (`packages/protocol/src/api/`, um arquivo por recurso, tudo com prefixo `Api...` e espalhado em `registry.ts`): `scenarios.ts`, `plays.ts`, `decisions.ts`, `blackboard.ts`, `attachments.ts`, `profiles.ts`, `executors.ts`, `orders.ts`, `ideas.ts`, `usage.ts`, `config-view.ts`. Rotas novas, 22: `listScenarios`, `getScenario`, `listScenarioPlays`, `getPlay`, `listScenarioDecisions`, `listBlackboard`, `getBlackboardEntry`, `listBlackboardHistory`, `listAttachments`, `getAttachment`, `getAttachmentContent`, `listProfiles`, `getProfile`, `listExecutors`, `listRoles`, `listOrders`, `getOrder`, `listIdeas`, `getIdea`, `getUsage`, `getBudget` e `getConfig`. O `docs/reference/api-routes.json` foi regenerado por `pnpm api:catalog` (arquivo gerado, ordenado por id da rota, por isso o diff é grande). `GET /v1/status` já existia.
- **Daemon** (`packages/daemon/src/api/routes/`): `index.ts` (`registerReadRoutes`), `deps.ts` (`ReadRouteDeps`), `paging.ts`, `redact.ts`, e um arquivo por recurso (`scenarios.ts`, `blackboard.ts`, `attachments.ts`, `profiles.ts`, `executors.ts`, `orders.ts`, `ideas.ts`, `usage.ts`, `config-view.ts`). O `daemon.ts` só ganhou duas importações e um bloco de registro logo antes de `const handle: DaemonHandle`, com o `AttachmentService` da rota de conteúdo.
- **[V] Verificado localmente** (testes com o daemon real subindo com relógio falso, store e cofre em memória e nenhum cliente, ou seja, sem nada real; o `fake-agent` não é necessário porque nenhuma rota de leitura inicia sessão): 39 testes novos em três arquivos (`paging.test.ts`, `redact.test.ts`, `read-routes.test.ts`) e o `registry.test.ts` do protocolo ajustado (a lista das rotas do P1 virou `arrayContaining`, mais um teste para as 22 novas, todas `GET`).
  - **Cursor sem perda:** na rota de cenários, com escrita entre as páginas (um cenário novo e uma alteração em um já visto), a caminhada por `after`/`limit` devolve todos os itens uma vez só; o `paging.test.ts` repete a prova na função de paginação (escrita no meio, empate na primeira parte da chave, número comparado como número, item removido antes do cursor sem repetir outro). Em ordens, ideias, anexos e histórico do blackboard o teste só caminha a lista por páginas, sem escrita no meio.
  - **Cursor inválido:** `after` que a rota não deu, de outra forma ou de outro tipo dá 400 `invalid_input` com `details.field = "after"`; `limit=0` e parâmetro desconhecido também dão 400.
  - **Sem segredo:** o valor do cofre falso, o literal posto na configuração (`clients.codex.env`) e o literal posto nas `conventions` e na `configOverride` de um cenário não aparecem no texto de nenhuma das rotas `GET` (varredura de 21 caminhos, sem as rotas de conteúdo de anexo e de eventos). O perfil sai com `secretRef` (referência) e `hasSecret`, nunca o valor; o cofre não é aberto pelas rotas.
  - **Leitura não deixa rastro:** o último id de evento do log não muda depois de uma sequência de leituras (cenários, perfis, papéis, orçamento e configuração). A sequência de eventos de subida bate com `startNotices()`.
  - **Erros:** 404 `not_found` para cenário, peça, ordem, ideia, perfil, anexo e chave de blackboard que não existem; 413 `payload_too_large` para anexo binário acima de `scenarios.attachment_read_max`.
  - **Filtros:** `kind`/`state` de cenários; `state=ended` de ordens (expirada ou revogada); `state=queued` de ideias é a fila.
  - `pnpm check` completo passa (build, lint, format:check, test, verify e deps): 347 arquivos de teste e 6152 testes passam, 14 arquivos e 186 testes pulados (os reais, que dependem de cliente instalado ou de chave). Antes disso, `tsc -b` e `eslint` dos arquivos mexidos.
- **[proposta] Escolhas.**
  1. **Cursor de chave.** O cursor é o JSON da chave do último item, em base64url, opaco para o cliente. A página seguinte é o que tem chave maior, na ordem que a rota documenta. As chaves não mudam depois que o item existe (`seq`, `[createdAt, id]`, `[id]`, `[key]`, `[version]`), por isso uma escrita no meio pode acrescentar item, nunca fazer um sumir nem repetir; um deslocamento (`offset`) faria os dois. A ordem das listas é a chave, não a do store.
  2. **Redação da configuração** (`redact.ts`). A configuração de hoje não tem chave cujo valor seja segredo (as que leem um apontam para variável de ambiente, `api_key_env`, ou para o cofre), mas tem texto livre (o `env` literal de um cliente, URL, linha de comando). A regra fica do lado seguro do palpite: todo valor sob uma chave `env`; texto cuja chave nomeia segredo (`token`, `secret`, `password`, `passphrase`, `credential`, `api_key`, `private_key`, `bearer`), menos a chave que só diz onde ele está (`_env`, `_file`, `_path`, `_store`) e o `api.token`, que é um modo; URL com usuário e senha; e a forma de chaves conhecidas (`sk-...`, `ghp_...`, `xox?-...`, `AKIA...`). O texto vira `[redacted]` e o caminho vai em `redactedPaths`, para a tela poder dizer que escondeu. O mesmo vale para as `conventions` e a `configOverride` do cenário. A configuração padrão não esconde nada (teste).
  3. **Blackboard por peça, não por cenário.** No store o blackboard é da peça (`playId`), então as rotas são `/v1/plays/:playId/blackboard`, `/entry?key=&version=` e `/history?key=`; o briefing falava em "do cenário". O cenário chega às peças por `/v1/scenarios/:id/plays`.
  4. **Perfis e cota.** `listProfiles` pagina antes de ler a cota (só os itens da página pagam a leitura); um perfil removido sai com `quota: null`. A cota sai com `authorizes` (se uma sessão nova pode começar).
  5. **Papéis.** `listRoles` usa a mesma resolução do daemon (`resolveScenarioRoleExecutors`) e acrescenta a validade da tabela. `blockedBy` segue a ordem inválido, cota (estado `unknown` conta como livre quando `selection.unknown_quota` é `allow`), orçamento. `next` é o primeiro Executor sem bloqueio; `null` quando nenhum pode, e então vale `whenExhausted`.
  6. **Teto de gasto.** `getBudget` lê os limites por `headroom(executorId)` de todos os Executores (tabela, configuração e os que têm teto próprio), sem repetir (escopo, id, período), e lista os perfis com teto estourado.
  7. **Conteúdo do anexo** por rota própria (`/attachments/:id/content`): texto vem cortado em `scenarios.attachment_read_max` com `truncated`; binário ou imagem acima do limite dá 413, porque meia imagem não serve. Sem chave nova: usa as duas que já existem.
- **O que falta ou fica como limite** **[V]**.
  - Uma leitura que chegar entre o início do servidor da API e o registro dos handlers (o servidor sobe antes dos serviços) responde 404; a janela é de milissegundos no começo da subida. Se o P6 ou os clientes precisarem de 503 nessa janela, é uma mudança no `ApiServer`, não nas rotas.
  - Um perfil com teto e sem nenhum Executor não tem leitura no `getBudget`: não há API pública para ler o teto de um perfil sozinho, só pelo Executor. O estouro dele sai em `exceeded` mesmo assim.
  - `getUsage` agrega no daemon (`totals` e `groups`); não há lista de turnos individuais, que ainda não tem dono neste plano.
  - Não há eventos novos: nenhuma rota de leitura escreve nada, e as situações de falha (404, 400, 413) são resposta, não degradação silenciosa.
- **Para o P6 e os seguintes.** O padrão de registro é: um arquivo por recurso em `daemon/src/api/routes/`, com `register<Recurso>Routes(handlers, deps)`, chamado por `registerReadRoutes` em `index.ts`. O P6 segue com um `register<Recurso>Commands` por arquivo (de preferência no mesmo arquivo do recurso ou em `<recurso>-commands.ts`), registrado com `{ command: true }` (o padrão de todo método que não é `GET`), e acrescenta a `ReadRouteDeps` (o nome continua, é o que a rota lê) só o que precisar de serviço novo. O `daemon.ts` monta as dependências uma vez e chama `registerReadRoutes`; o P6 acrescenta a sua chamada ao lado. `paginate(items, keyOf, query)` e `redactTree` servem a qualquer lista nova; um recurso novo só precisa de uma chave imutável.

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

**Resultado (2026-11-19):** feito na branch `fase6/p10-client-streams`, em `packages/client/src/`, sem dependência nova (nem `EventSource`, nem `ws`, nem zustand; N164). Tudo é seguro para o navegador: nenhum módulo de Node entra, e o `index.ts` exporta os novos módulos.

- **Arquivos:** `sse-parser.ts` (parser e `readSseText`), `connection.ts` (estado, recuo e relógio, a parte comum), `event-stream.ts` (`EventStream`), `chat-socket.ts` (`ChatSocket`), `http.ts` (auxiliares que saíram do `client.ts`), mais edições em `client.ts`, `errors.ts` e `index.ts`. Os apoios de teste são `test-clock`, `test-stream-server` e `fake-websocket`, todos `.test-support.ts`.
- **Parser de SSE:** escrito pela seção de *server-sent events* do HTML Living Standard. Aceita `\n`, `\r\n` e `\r`, o BOM, `id`, `event`, `data` de várias linhas, `retry` e comentários (o heartbeat). Um `id` com NUL é ignorado e um `id` vazio zera o cursor. Um evento sem `data` não é entregue, mas o `id` dele vira cursor. O que sobra no fim da conexão é descartado. O `id` só vale na linha em branco: meio quadro cortado pela queda não move o cursor (o teste do corte no meio do quadro achou o erro, que estava no parser, e foi corrigido). `readSseText` usa `TextDecoder` em modo de fluxo, então um caractere multibyte partido entre pedaços não quebra, e cancela o corpo se o consumo para antes.
- **`EventStream`:** `GET /v1/events` por `fetch`, com `Authorization: Bearer`, `Accept: text/event-stream` e `redirect: 'manual'`. Cada mensagem é validada por `ApiSseMessageSchema`; fora do schema vira `ApiProtocolError` (`invalid_json`, `invalid_response`) e a conexão fecha sem tentar de novo. Resposta que não é `text/event-stream` ou sem corpo vira `invalid_stream` (motivo novo em `ApiProtocolReason`). Os filtros `scenario`, `types` e o `since` inicial vão na query, validados pelo schema da rota antes de conectar (`ApiInputError`). O `since` só vale até o stream ter cursor próprio; depois, e a cada reconexão, vai o `Last-Event-ID`. O cursor acompanha também um `id:` sem evento, o que permite ao servidor mandar o id mais novo como primeiro quadro.
- **`ChatSocket`:** pega o bilhete por `POST /v1/chat-tickets` (pelo `ApiClient`, que guarda o token), abre `ws(s)://host/v1/scenarios/:id/chat?ticket=...` (o token nunca vai na URL e um prefixo de caminho do daemon é mantido) e valida as mensagens nos dois sentidos (`ChatServerMessageSchema` ao receber, `ChatClientMessageSchema` ao enviar). A cada reconexão pede um bilhete novo e manda `resume { lastEventId }` como primeiro quadro, com o maior `eventId` recebido (a mensagem `error` tem `eventId` nulo e não move o cursor). O contrato já tinha `resume`, então não falta nada no protocolo. `send()` não enfileira: com o socket fechado lança `ChatNotOpenError`, porque reenviar depois de uma queda pode duplicar. Mensagem inválida do daemon fecha com o código 1002.
- **Reconexão (`ReconnectingConnection`, compartilhada):** estados `connecting`, `open`, `retrying`, `closed` com `onState(listener)`, sem zustand, e `done` (promessa que nunca rejeita). O atraso é `min(máximo, base · fator^(n-1))` com jitter, `n` sendo as falhas seguidas desde a última abertura. O `retry:` do servidor vira a base (mínimo 1 ms, nunca acima do máximo). 401, 403, 404 e qualquer 4xx não reconectam; 5xx e queda de rede sim. Um 503 com `Retry-After` espera pelo menos isso, cortado em `maxRetryAfterMs`. `AbortSignal` e `close()` fecham na hora, inclusive no meio da espera. O relógio (`clock`) e o sorteio (`random`) são injetáveis, então os testes não dormem.
- **[V] verificado localmente:** `tsc -b`, `eslint packages/client` e `vitest run packages/client` (7 arquivos, 189 testes, 111 deles novos). O parser tem 28 testes (campos, `id`, `retry`, comentários, terminadores, corte em todas as posições, entrada caractere a caractere e UTF-8 partido em todos os bytes). O SSE roda contra um servidor `node:http` em processo, só no *loopback*: entrega em ordem, queda no meio de um quadro e volta com `Last-Event-ID` recebendo 1 a 10 uma vez cada, `retry` mudando o recuo (3000, 6000, 12000), 401/403/404 sem reconexão, 401 com HTML, 503 com `Retry-After: 7`, 502 com HTML, `maxRetries`, mensagens inválidas nos dois modos, filtros na query, `id:` sem evento como cursor, `dropRepeated` e ouvinte que lança. O WebSocket roda contra um socket falso injetado (reconexão com bilhete novo e `resume`, `resumeFrom`, bilhete com 401/404/503, mensagens inválidas, `send` recusado), mais dois testes por `ApiClient.chat` contra o daemon de teste em processo.
- **[proposta]:** (1) `client.events(options)` e `client.chat(scenarioId, options)` no `ApiClient`, para o token ficar no campo privado; as classes também são exportadas e aceitam `{ url, token, daemonId, fetch }`; (2) os padrões de recuo (1 s, teto de 30 s, fator 2, jitter de 20%, sem limite de tentativas, `Retry-After` até 5 min) são chaves das opções; (3) `invalidMessages: 'fail' | 'skip'` (padrão `fail`) e `dropRepeated` (padrão ligado); (4) `redirect: 'manual'` também no stream, para o token não seguir um redirecionamento; (5) o stream sem `Content-Type` de SSE é erro fatal.
- **Falta:** (1) o aceite contra o daemon (a queda forçada no meio de uma peça e a volta sem perder nem repetir) depende do P4 (SSE) e do P7 (WebSocket) e **fica para o P13**; hoje o servidor de teste em processo cobre o cliente, não o servidor. (2) Não há tempo limite ocioso pelo heartbeat (um stream calado, mas aberto, não é derrubado) nem tempo limite para abrir a conexão ou o WebSocket; ficam como acréscimo, depois que o P4 definir o intervalo do heartbeat.
- **Para o P4:** um stream sem cursor que cai antes do primeiro evento perde o que passar no intervalo. Sugestão: mandar um `id: <mais novo>` logo no começo da conexão; o cliente já segue um `id:` sem evento. O `Last-Event-ID` e o `since` precisam ser aceitos juntos (o cliente manda só um dos dois por requisição).
- **Para o P7:** (1) se várias mensagens do chat dividirem o mesmo `eventId`, um `resume` a partir dele pula as seguintes; use um `eventId` por mensagem ou defina com precisão se o `resume` reenvia o que vem depois ou a partir do id. (2) Sem cursor (nenhum evento recebido) o cliente não manda `resume`; se o daemon precisar de "desde o início", falta essa semântica. (3) O cliente fecha com 1002 uma mensagem fora do contrato e trata qualquer fechamento do daemon como queda a retomar.
- **Para o P8, P11 e P12:** o `ot chat` usa `client.chat(...)`, com `onMessage`, `onState` e `send`, e deve mostrar o estado `retrying` com `detail.delayMs`. O P11 liga o store a `client.events({ since })`: o `dropRepeated` já evita aplicar duas vezes o mesmo id, e o store deve guardar o `lastEventId` para o `since` de uma leitura nova.

### P11. `packages/client`: stores em zustand *vanilla*

**Escopo:**
- Stores com `createStore` do `zustand/vanilla` (N164), sem React: cenários, peças, demandas, decisões pendentes, cotas e eventos recentes.
- Cada store começa por uma leitura da REST e segue pelos eventos do SSE, com o id do último evento aplicado. Um evento com id já aplicado é ignorado. Assim a retomada do SSE não duplica estado.
- Os redutores de evento ficam em funções puras, testadas sem rede.
- Teto do store de eventos recentes, `client.events.keep` **[proposta: 500]**.

**Aceite:** o store de uma peça, montado só pelos eventos do SSE, fica igual ao estado lido pela REST no fim da peça; a mesma sequência de eventos aplicada duas vezes dá o mesmo estado; os testes rodam sem React.

**Resultado (2026-11-20):** feito na branch `fase6/p11-stores`, em `packages/client/src/stores/`. A única dependência nova é o `zustand` 5.1.0, versão exata, só em `packages/client`; sem `react`, `immer` nem `use-sync-external-store`. A regra `client-only-protocol-and-zod` do dependency-cruiser passou a admitir o `zustand`; as demais regras `client-*` (nada de Node fora de `src/node`, nada do daemon) continuam valendo. Nenhum arquivo de `packages/daemon` ou `packages/protocol` foi tocado.

- **Arquivos:** `core.ts` (redutor puro, `applyEvent`, marcas de leitura pendente), `scenarios.ts`, `plays.ts`, `demands.ts`, `decisions.ts`, `quotas.ts`, `recent-events.ts`, `play-events.ts` (schemas locais dos eventos de peça), `sync.ts` (o *hub* `DaemonStores`) e `index.ts`; mais `fixtures.test-support.ts`, `stores.test.ts` e `sync.test.ts`. Edições em `event-stream.ts` (+ teste), `index.ts`, `package.json`, `pnpm-lock.yaml` e `.dependency-cruiser.js`.
- **Stores e redutores:** cada store é um `createStore` de `zustand/vanilla` e guarda `lastEventId`; um evento com id já aplicado é ignorado, e um tipo desconhecido, ou com payload fora do schema, é ignorado sem erro e devolve o mesmo estado (a referência não muda, então ninguém é notificado). Os redutores são funções puras, sem rede. O `lastEventId` de um store só sobe quando o redutor muda o estado; o hub guarda o cursor global em `status.cursor`.
- **Ordem entre a leitura e o stream [proposta]:** (1) abre o stream sem `since` e guarda as mensagens; (2) descobre a cabeça H do log pelo primeiro quadro `id:` (o servidor do P4 manda o id mais novo logo no início, `id: 0` com o log vazio), ou usa H = 0 depois de `headTimeoutMs`; (3) lê os snapshots da REST; (4) instala-os com `lastEventId = H`; (5) aplica de forma síncrona os eventos guardados com id > H, em ordem, e passa a aplicar ao vivo. O que tem id até H foi confirmado antes de ser enviado, então o snapshot lido depois já o contém; os eventos acima de H aplicados sobre um snapshot mais novo convergem porque os redutores são de conjunto (inserir ou trocar por chave) ou só marcam a chave como velha. `resync()` refaz o ciclo.
- **Chave velha (*stale*) com revisão [proposta]:** onde o evento não traz o registro inteiro (demandas, decisões, cotas e arquivamento de cenário), o redutor marca a chave (`markStale` sobe a revisão), e o hub lê de novo a REST depois de um atraso curto. A leitura guarda a revisão que viu e só limpa a marca se ela não mudou, então uma marca que chegou durante a leitura provoca outra. Há uma leitura por chave por vez, um limite de leituras ao mesmo tempo, novas tentativas com recuo, e o 404 remove a chave. Se desistir, a chave fica velha, o hub emite `onProblem({ kind: 'refresh_failed' })` e `status.error`, e o evento seguinte marca de novo.
- **Opções e padrões [proposta], em `DEFAULT_SYNC` (e `DEFAULT_EVENTS_KEEP`, para o teto):** `events.keep` 500 (a chave `client.events.keep` do escopo; um valor inválido lança `RangeError`), `plays` `'open'` ou `'all'` (padrão `'open'`: só peças em andamento), `demands` `'open'` ou `'none'` (padrão `'open'`), `refreshDebounceMs` 250, `refreshRetryMs` 2000, `refreshAttempts` 3, `concurrency` 4, `pageLimit` 200, `headTimeoutMs` 5000, e `stream`, `clock` e `onProblem` injetáveis. As situações que só iriam ao log (`refresh_failed` e `stream_closed`) saem por `onProblem` e por `status`; como o cliente não é o daemon, elas não viram evento do catálogo (o daemon já emite os eventos de conexão no seu lado) [N].
- **`EventStream.onCursor` [proposta]:** acréscimo pequeno em `event-stream.ts`: avisa o último `id:` de um pedaço quando o cursor anda, uma vez por pedaço e antes das mensagens do mesmo pedaço. O hub o usa para saber H sem esperar um evento. O `Clock.sleep` do cliente resolve (não rejeita) ao abortar, e o hub conta com isso.
- **Eventos de peça [proposta]:** `play.created` e `play.transitioned` só têm schema em `daemon/src/pipeline/events.ts`, que o cliente não pode importar. Foram reescritos com `z.looseObject` em `stores/play-events.ts`. O P13 compara com o daemon; a recomendação é mover esses schemas para `packages/protocol`.
- **[V] verificado localmente:** `tsc -b`, `eslint packages/client/src` e `vitest run packages/client` (9 arquivos, 244 testes, 55 deles novos: 32 nos redutores e stores, 21 no hub e 2 no `onCursor`; estável em 3 rodadas). Os testes do hub usam um `ApiClient` real com um `fetch` injetado que simula o daemon (`FakeDaemon`), sem porta, sem credencial (N57). As respostas REST e as sequências de eventos são montadas com os schemas do protocolo. O aceite está coberto: o store de peça montado só pelos eventos fica igual ao estado lido pela REST no fim da peça; a mesma sequência aplicada duas vezes dá o mesmo estado (por redutor e pelo hub); os testes rodam sem React. Também há testes para tipo desconhecido, evento repetido, teto de 500 (e outro valor), 404 na releitura, desistência da leitura, evento que chega durante a leitura e retomada por `Last-Event-ID`.
- **Falta (fica para o P13):** o aceite contra o daemon real (o store de uma peça por SSE igual à REST do daemon, com o `fake-agent`) e a conferência dos eventos de peça com os schemas do daemon. O P13 deve também verificar a igualdade entre o carimbo do evento e o `updatedAt`, `createdAt` ou `finishedAt` do registro, de que os redutores dependem para o resultado ser idêntico à REST. [N] não conferido contra o daemon real.
- **Achados para o catálogo de eventos (N):** não há evento para o estado da demanda, a criação e a resposta de uma decisão, o arquivamento de cenário, nem para `reason` e `authorizes` da cota; por isso esses stores usam chave velha e releitura. Recomenda-se `decision.created`, `decision.answered` e um evento de arquivamento. Uma demanda gravada depois do seu evento de transição pode ser lida velha até a próxima transição.
- **Limites conhecidos [N]:** (1) o store de eventos recentes não tem retroativo: eventos com id até H não aparecem; (2) um daemon restaurado de um backup, com o cursor à frente do log, exige `resync()` manual; (3) durante a aplicação dos eventos guardados os estados intermediários são visíveis; (4) com vários daemons, um hub por daemon, combinados por `daemonId` e `scenarioRefKey` (`refs.ts`).
- **Para o P12 e o P13:** o P12 liga ganchos de React aos stores *vanilla* (`useStore(hub.plays, seletor)`); os seletores devem devolver referência estável, porque o `zustand` notifica só quando a referência muda e os redutores a preservam para o que não os afeta. O P13 usa `DaemonStores` contra o daemon com o `fake-agent` e chama `whenIdle()` para esperar as leituras pendentes.

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
