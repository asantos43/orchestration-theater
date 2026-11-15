# Avaliação do Claudexor (e nota sobre o TeamClaude)

- **Data:** 2026-11-15 (horário de São Paulo, UTC-3)
- **Pergunta:** o Claudexor muda a decisão da [ADR 0001](../../docs/adr/0001-projeto-proprio-sem-fork.md)? Ele serve de fork, de fonte de trechos ou só de referência?
- **Critérios:** os mesmos da ADR 0001 e da §6.4 da [arquitetura](../../docs/framework-ideas/arquitetura.md) (v0.35).
- **Companheiro de:** [README.md](README.md), a avaliação da Fase 0.

Marcadores: **[V]** verificado localmente; **[S]** fonte secundária (API do GitHub ou documentação do próprio projeto, sem confronto com o código); **[N]** não confirmado ou hipótese.

## 1. Método

- Clone raso de `razzant/claudexor` (versão 6.1.2, commit de 2026-11-15) e de `KarpelesLab/teamclaude` (versão 1.1.29, commit de 2026-11-11), em pasta de rascunho fora do repositório. **[V]**
- Nenhum código dos projetos foi executado. As dependências do Claudexor foram instaladas com `pnpm install --ignore-scripts`. O TeamClaude não tem dependências de execução, então nada foi instalado. **[V]**
- Não houve login, não li credenciais de ninguém e não toquei em `~/.claude`, `~/.codex`, `~/.config/opencode` nem no `opencode serve` da porta 4096. **[V]**
- Licenças: `spikes/licenses/check.mjs`, mais uma leitura direta dos `package.json` de `node_modules/.pnpm`, porque o verificador tem uma limitação com pnpm (seção 3.2).
- Estrelas, forks, commits e colaboradores vêm da API do GitHub, consultada em 2026-11-15. **[S]**
- Os testes do Claudexor **não foram rodados**. O que se diz de qualidade vem de contagens e de leitura. **[V]** para as contagens.

## 2. Resumo por critério

| Critério (§6.4) | Claudexor | Observação |
|---|---|---|
| 1. Licença da árvore | MIT, de Anton Razzhigaev. 0 proibidas nos 196 pacotes instalados **[V]** | Nenhum `sharp`/libvips no lockfile, ao contrário de Happier, Paradev e AionUi **[V]** |
| 2. Daemon com API, separado da interface | **Sim** (socket Unix + HTTP em loopback com bearer, 113 endpoints) **[V]** | O app de macOS é só uma casca em Swift **[S]** |
| 3. Encaixe do XState | **Não encaixa sem trocar o orquestrador.** Não há XState **[V]**; os pipelines são imperativos | Ver 3.3 |
| 4. Qualidade e testes | 1.117 arquivos de teste, 386.898 linhas de teste para 279.155 de código **[V]**; testes não rodados | Código denso, com comentários longos e invariantes numerados |
| 5. Ritmo do upstream | 1.866 commits em 90 dias, 881 em 30, 272 em 7 **[S]** | Ritmo alto demais para manter um fork |
| Regras de segurança do OTheater (§3) | **Conflita**: lê tokens OAuth (Claude e Codex) e chama a API do fornecedor com eles **[V]** | Ver seção 4 |

## 3. Os oito pontos

### 3.1 Licença do projeto e da árvore (ponto 1)

- Licença do projeto: MIT. **[V]** (`LICENSE`; a API do GitHub confirma `MIT`. **[S]**)
- Árvore instalada: 196 pacotes, **0 proibidos** (GPL, AGPL, LGPL). **[V]**
- Dependências de produção: todas MIT, ISC ou Apache-2.0. **[V]**
- 10 pacotes "sem decisão", todos de desenvolvimento: BlueOak-1.0.0 (8), Python-2.0 (1) e `spawndamnit` ("SEE LICENSE IN LICENSE", 1). **[V]**
  - A §6.0 não lista BlueOak-1.0.0 nem Python-2.0. Como são só de desenvolvimento e não seriam copiados, ficam como caso a decidir, não como bloqueio.
- `lightningcss` é MPL-2.0, de desenvolvimento, e a MPL-2.0 é permitida pela §6.0. **[V]**
- O lockfile (359 entradas) não tem `sharp`, `@img/sharp-libvips-*`, `ffmpeg`, `@anthropic-ai/*` nem `openai`. **[V]**
  - O Claudexor **não depende** do `@anthropic-ai/claude-agent-sdk` nem do `@openai/codex` como pacote npm. Ele dirige os binários dos clientes por entrada e saída nativas. Por isso a licença "Custom" do SDK, que a ADR 0001 deixou em aberto **[N]**, não entra aqui.
- O `pnpm-workspace.yaml` desliga os scripts de instalação do `esbuild` (`allowBuilds`), uma cerca de supply chain. **[V]**
- Exigência de ambiente: Node ≥ 24.15.0, pnpm 10.34.5 e `node:sqlite` (o store recusa SQLite abaixo de 3.51.3). **[V]**

### 3.2 Limitação do verificador de licenças (a registrar)

O `spikes/licenses/check.mjs` **dá falso "APROVADO"** em projetos pnpm com workspaces. **[V]**

- `--dir <pacote do workspace>` devolveu "0 pacotes … APROVADO", porque os pacotes são symlinks para `node_modules/.pnpm`.
- A raiz com `--tudo` cobriu 183 dos 196 pacotes e deixou de fora os de produção.
- `--so-lockfile` falha com `pnpm-lock.yaml` ("loadVirtual requires existing shrinkwrap file").
- Contornei lendo o `package.json` de cada pasta de `node_modules/.pnpm` (196 pacotes). Os resultados guardados na pasta de rascunho são `claudexor-prod.json` e `claudexor-tudo.json`.
- **Sugestão (não aplicada):** o verificador deveria seguir os symlinks do pnpm ou varrer `node_modules/.pnpm`, e deveria falhar, e não aprovar, quando acha 0 pacotes.

### 3.3 Daemon com API, separado da interface, e o XState (pontos 2 e 3)

**Daemon e API: sim, e separados.** **[V]**

- `packages/daemon` roda um servidor em socket Unix (`node:net`, `server.ts`) com uma fila de comandos persistida (`command-store.ts`, `client.ts`). O store é um único `engine.sqlite` em WAL, com um escritor único e lease de escritor.
- `packages/control-api/src/daemon-server.ts` abre um servidor HTTP em `127.0.0.1` (`listen(port, host)`), com SSE para eventos.
- `docs/reference/endpoints.json` lista **113 endpoints**, cada um `loopback_only` ou `loopback_bearer`.
- O CLI (`packages/cli`, 288 arquivos de teste, o maior pacote) e o app de macOS são clientes desse daemon. O app é em Swift, exige macOS 26+ e vem em DMG. **[S]**
- Isso é parecido com o que a §5.1 e a §5.12 pedem: daemon por usuário, API para as interfaces, acesso local por padrão com token.

**Máquina de estados: não há como pôr o XState por cima sem reescrever o miolo.**

- Não há XState em nenhum pacote. (Um falso positivo, `linuxState` em `process-identity.ts`, foi descartado.) **[V]**
- Os pipelines estão em `packages/orchestrator` como código imperativo: corrida best-of-N, revisão cruzada por família, árbitro, gates determinísticos. O estado fica no store SQL e no diário de eventos, não numa máquina declarativa.
- Para ter o pipeline da §5.4 em XState v5 teríamos de:
  1. tirar o `orchestrator` do caminho e reimplementar o que ele faz (pool de contas, rotação, retomada, orçamentos);
  2. ou rodar o XState "por fora", chamando o orquestrador como uma caixa preta, o que anula o sentido da máquina (transições, retomada e visualização do pipeline passam a depender do que está dentro da caixa). **[N]**
- Mesma conclusão da ADR 0001 para os outros candidatos: o fork obrigaria a reescrever justamente a parte que diferencia o OTheater.

### 3.4 Como os adaptadores falam com os clientes (ponto 4)

- **Claude Code e Codex: entrada e saída nativas, não ACP.** **[V]**
  - O adaptador do Claude lê o `stream-json` do CLI (`packages/harness-claude/src/parse.ts`, `quota.ts`).
  - O do Codex usa o `app-server` do Codex (`packages/harness-codex/src/app-server-*.ts`).
  - Cada harness roda "nativamente", com `CLAUDE_CONFIG_DIR` ou `CODEX_HOME` escopados em pasta própria do Claudexor.
- **ACP existe só para quem fala ACP.** `packages/harness-acp` (`createAcpAdapter`) e `packages/acp-server` usam `@agentclientprotocol/sdk` **2.6.0**, a série v2 que a arquitetura adota. **[V]**
  - `packages/acp-server` também expõe o próprio Claudexor como agente ACP, para editores. **[S]**
- **Outros harnesses:** `harness-opencode` (via `runCliHarness`), `harness-cursor`, `harness-grok`, `harness-agy`, `harness-raw-api`, `harness-fake`. **[V]**
- **Diferença para o OTheater:** a arquitetura (§5.2) manda os três clientes por ACP. O Claudexor fez outra escolha, com mais acoplamento à saída de cada CLI e menos dependência de um adaptador ACP de terceiros. É uma alternativa válida de projeto, mas **não** é a que o dono decidiu. **[V]**

### 3.5 Perfis, leitura de cota e rotação de contas (ponto 5)

**Numeração do pedido.** O pedido cita §5.10 e §5.11. Na v0.35 essas seções são Contexto (tokens) e Observabilidade. O assunto está em **§5.6 (Assinaturas e cotas), §5.7 (Seleção de Executor) e §5.2 (Camada de Executores)**. A comparação abaixo usa essas.

| Tema | OTheater (arquitetura v0.35) | Claudexor |
|---|---|---|
| Perfil de credencial | Pasta isolada por perfil (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, XDG); login oficial disparado pelo daemon **[V]** (arquitetura §3 e §5.6) | Igual na ideia: "perfis" são linhas de registro (INV-135) com `isolation_locator` dentro de uma raiz própria (`claudexorOwnedRoot`). Recusa ler fora dela **[V]** |
| Token | **"O framework nunca lê, copia nem reaproveita tokens OAuth"** (§3) | **Lê o token OAuth** (ver abaixo) |
| Leitura de cota do Claude | Último JSON da statusline por perfil; sem chamar o modelo (§5.6) | (a) eventos `rate_limit_event` do `stream-json` (`quota.ts`), **sem token** **[V]**; (b) **chamada a `api.anthropic.com/api/oauth/usage` com o token** do perfil (`packages/cli/src/claude-oauth-fetch.ts`) **[V]** |
| Leitura de cota do Codex | `account/rateLimits/read` do `app-server` (§5.6) | Mesmo método no `app-server` (`harness-codex/src/quota.ts`, 225 linhas) **[V]** |
| Estado de cota | `ok`, `near_limit`, `exhausted`, `unknown` | Veredito `fresh_headroom` / `unknown` / `exhausted`, com frescor: cota velha nunca autoriza rota (`account-pool.ts`) **[V]** |
| Rotação | Seleção de Executor e política na §5.7 | `limit_action: fail \| ask \| rotate`. A rotação só roda se a tentativa não entregou nada e não mexeu no workspace (`rotation-predicate.ts`) **[V]** |
| Contas por API | Perfil tipo `api` | Linha `api_key` é rota paga: **nunca escolhida em silêncio**, só por pin ou preferência explícita **[V]** |

**O ponto sensível, com caminhos [V]:**

1. **Claude: leitura do token.** `packages/cli/src/claude-oauth-credential.ts` lê `<configDir>/.credentials.json` (no macOS, o item do chaveiro `Claude Code-credentials-<sha256(configDir)[:8]>`). Ele pega o `accessToken` e o repassa a `fetchClaudeOauthUsage`, que o envia como `Authorization: Bearer` com o cabeçalho `anthropic-beta: oauth-2025-04-20` para `https://api.anthropic.com/api/oauth/usage` e para rotas `/api/oauth/…` de recursos e créditos. O README diz que o daemon consulta essas fontes. **[V]**
   - Se isso fica ligado por padrão ou só por configuração não foi verificado. **[N]**
2. **Codex: o token vai além da cota.** `packages/harness-codex/src/model-auth.ts` lê o `auth.json` do perfil (só dentro da raiz própria), extrai `accessToken` e `accountId`, e `model.ts`, `images.ts` e `model-catalog.ts` chamam **`https://chatgpt.com/backend-api/codex`** diretamente, com `Authorization: Bearer`. É o que a documentação chama de "operações de modelo do chamador" (`docs/ARCHITECTURE.md`, a partir da linha 3061: geração de texto e de imagem sem o cliente oficial). **[V]**
   - Isso usa a **assinatura ChatGPT por fora do cliente oficial**. A arquitetura (§3) lista o uso do login ChatGPT em ferramentas de terceiros como "a confirmar", e pede tratar `auth.json` como senha. **[V]** para o código, **[N]** para o que a OpenAI permite hoje.
3. **Identidade só com campos permitidos.** `codexAccountIdentity` e `claudeAccountIdentity` leem `auth.json` e `.claude.json` mas devolvem só `{email, plan}` (claims do `id_token` sem verificar assinatura, e `oauthAccount.emailAddress`/`organizationType`), e recusam pastas fora da raiz própria. É um cuidado real, mas **continua sendo ler arquivo de credencial**. **[V]**
4. **O que é compatível com o OTheater**, sem token: o `stream-json`/`rate_limit_event` do Claude, o `app-server` do Codex, `codex login status` como sonda de login (`probeLogin` em `auth.ts`), a escrita de `auth.json` só para chave de API num `CODEX_HOME` isolado, e `-c cli_auth_credentials_store="file"` (`CODEX_FILE_AUTH_ARGS`). **[V]**

**Conclusão do ponto 5.** Em estrutura (perfis isolados, pool por frescor, estados de cota, rotação restrita) o Claudexor está muito perto do que a §5.6 e a §5.7 desenham. Em **regra de segurança** ele vai na direção oposta em dois pontos: lê token e fala com a API do fornecedor com ele. Nada disso pode ser copiado.

### 3.6 Modelo local (ponto 6)

- **`harness-raw-api`**: harness de API "crua", compatível com OpenAI (`POST <baseUrl>/chat/completions`, `GET <baseUrl>/models`). O `baseUrl` vem da configuração ou de `CLAUDEXOR_RAWAPI_BASE_URL`, com padrão `https://api.openai.com/v1`. Qualquer servidor compatível (llama.cpp `llama-server`, Ollama, LM Studio) entra apontando o `baseUrl`. **[V]** (leitura de `index.ts` e `catalog.ts`)
- **`harness-opencode`**: usa o CLI do OpenCode via `runCliHarness`, com a chave vinda de `OPENCODE_API_KEY`, `OPENAI_API_KEY` ou `ANTHROPIC_API_KEY`. **[V]**
- **O que não existe:** gerência do servidor local. Não há equivalente ao `LocalModelServer` do OTheater (subir e parar o llama.cpp, medir RAM). O Claudexor trata o modelo local como "mais um endpoint". Não encontrei texto sobre o contexto mínimo que o Claude Code exige (64 mil) nem sobre preferir o OpenCode para modelos pequenos, que a arquitetura registra. **[V]** para a busca, **[N]** para a conclusão.
- Nada disso foi executado.

### 3.7 Qualidade do código, testes e ritmo (ponto 7)

**Código e testes.** **[V]**

| Medida | Valor |
|---|---|
| Pacotes em `packages/` | 33 |
| Arquivos `.ts` de código | 1.455 |
| Linhas de código (sem testes) | 279.155 |
| Arquivos `*.test.ts` | 1.117 |
| Linhas de teste | 386.898 |
| Maiores em testes | `cli` 288, `orchestrator` 176, `daemon` 144, `control-api` 103, `workspace` 64, `harness-codex` 63 |
| `docs/ARCHITECTURE.md` | 9.923 linhas |
| CI | `ci.yml`, `release.yml`, `pages.yml`, `publish-mcp.yml`, `repo-metrics.yml`; `release:verify` encadeia vários gates |
| Lint de código morto | `knip` |

- Tem mais linha de teste que de código, o que é bom sinal. Mas **não rodei nada**, então não sei se a suíte passa nem quanto leva. **[N]**
- Estilo: invariantes numerados (INV-067, INV-135, INV-146), comentários longos que explicam o motivo. (O `zod` aparece só em 3 pacotes; não verifiquei como as bordas são validadas no resto.) Fácil de auditar um arquivo, difícil de absorver o conjunto: 1.455 arquivos e uma "bíblia" de 9.923 linhas.
- Pacotes se importam pelo nome `@claudexor/*`. Um trecho copiado quase nunca vem sozinho: traz `schema`, `core`, `util`. **[V]**

**Ritmo e saúde do projeto.** **[S]**

| Medida | Valor |
|---|---|
| Criado em | 2026-06-05 (cerca de 5 meses) |
| Estrelas / forks / issues abertas | 525 / 59 / 38 |
| Commits em 90 / 30 / 7 dias | 1.866 / 881 / 272 |
| Releases publicadas | 30 |
| Colaboradores | `razzant` 1.747 commits; `ouroboros-agent` 1.445; `IlidanNaga` 49; `dependabot` 30; os demais, 9 ou menos |

- Cerca de 20 commits por dia, quase todos de duas contas. O nome `ouroboros-agent` sugere uma conta de agente de IA, mas **não confirmei**. **[N]**
- Está na versão 6.1.2 com 30 releases em cerca de 5 meses **[S]**, e o README tem uma seção "Stability at 2.0" (não li o que ela promete). Não é um projeto parado. É um alvo móvel: um fork divergiria em dias, como já se disse do Orca na ADR.

### 3.8 Trechos que valem copiar (ponto 8)

Licença de todos: **MIT, © Anton Razzhigaev**. Copiar exige manter o aviso de copyright e entrar no `THIRD_PARTY_NOTICES` (ADR 0001, consequências). Todos têm dependências internas (`@claudexor/schema`, `core`, `util`), então o mais realista é **reescrever a lógica com a atribuição**, não colar o arquivo.

**Vale reaproveitar (sem tocar em token):**

| Caminho | O que traz | Observação |
|---|---|---|
| `packages/harness-claude/src/quota.ts` (90 linhas) | Leitura dos `rate_limit_event` do `stream-json`: janelas `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, razão de uso 0–1, reset | O mais útil: casa com a "sonda por statusline" da §5.6 como segundo canal. **[V]** |
| `packages/harness-codex/src/quota.ts` (225 linhas) | Parser de `account/rateLimits/read`, com validação estrita e recusa de envelope malformado | Casa com a sonda do Codex da §5.6 **[V]** |
| `packages/orchestrator/src/account-pool.ts` (279 linhas) | Ranking do pool: folga conhecida, depois desconhecida, depois esgotada; desempate por id; "cota velha nunca autoriza rota" | Boa especificação para a §5.7 **[V]** |
| `packages/orchestrator/src/rotation-predicate.ts` | Só rotaciona se não houve entrega nem mudança no workspace | Regra pequena e segura **[V]** |
| `packages/harness-codex/src/auth.ts` | `probeLogin` (`codex login status`) e `CODEX_FILE_AUTH_ARGS` | Sem ler token **[V]** |
| `packages/harness-claude/src/native-home.ts` | Pasta de config isolada e a ponte de chaveiro | Só a parte de isolamento, não `claudeAccountIdentity` **[V]** |
| `packages/daemon/src/store/*` | `engine.sqlite` em WAL, escritor único, lease, `flushed()` antes do efeito externo, checagem da versão do SQLite | Modelo para o store da §7 (as ideias, não o código) **[V]** |
| `packages/control-api` e `docs/reference/endpoints.json` | Desenho de 113 endpoints, SSE, `loopback_bearer` | Referência para a §5.12 **[V]** |
| `packages/budget` | Orçamento tipado; "custo desconhecido nunca é US$ 0" | Casa com o equivalente em API da §5.6 **[V]** |
| `packages/harness-raw-api` | Cliente OpenAI-compatível com `baseUrl` e `/models` | Para o modelo local **[V]** |

**Fica de fora (não copiar):**

| Caminho | Motivo |
|---|---|
| `packages/cli/src/claude-oauth-credential.ts`, `claude-oauth-fetch.ts`, `claude-resource-source.ts`, `claude-resource-transport.ts` | Leem o token do Claude e chamam `/api/oauth/*` com ele |
| `packages/harness-codex/src/model-auth.ts`, `model.ts`, `images.ts`, `model-catalog.ts` | Leem o token do ChatGPT e chamam `chatgpt.com/backend-api/codex` fora do cliente oficial |
| `harness-claude/src/continuity.ts` (lista `.credentials.json` como "laneCredentialStores") e qualquer outro ponto que mova arquivos de credencial | Mexe em arquivo de credencial |
| O app de macOS e o instalador | Fora do escopo (Linux, TUI/web) |

## 4. TeamClaude (KarpelesLab/teamclaude, MIT)

**O que é.** Um proxy local de várias contas para o Claude Code e o Codex. Ele guarda as contas, escolhe uma, **injeta o token real dela** na requisição e passa para a API. Quando a conta chega ao limite (98% por padrão, na janela de 5 horas ou na semanal), troca para a próxima. **[V]** (README e código)

**Números.** Criado em 2026-03-24; 499 estrelas **[S]**; 374 commits em 90 dias e 82 em 30 **[S]**. Código em JavaScript com tipos JSDoc, cerca de 44.900 linhas em `src/` e 314 arquivos de teste; **sem dependências de execução** (só `@types/node`, `eslint` e `typescript` de desenvolvimento). Licença MIT. **[V]**

**O que ele faz com as credenciais** (o ponto principal):

1. **Guarda tokens OAuth em texto no arquivo de configuração.** As contas ficam em `~/.config/teamclaude.json`, com `credential` (token de acesso) e `refreshToken`. A escrita é atômica e com modo `0600`. Não vi criptografia em repouso. **[V]** (`src/config.js`, `src/credential-sync.js`)
2. **Importa e renova.** `teamclaude import` pega as credenciais do Claude Code; `teamclaude login` faz um OAuth próprio; o proxy renova o token e grava de volta. **[V]** (`docs/accounts.md`, `src/codex-auth.js`)
3. **Injeta o token e reescreve a identidade.** O módulo `src/account-uuid-rewrite.js` troca, no corpo da requisição, o `account_uuid` dentro de `metadata.user_id` pelo da conta escolhida, para a identidade declarada bater com o token injetado. **[V]**
4. **Faz MITM de TLS.** `src/mitm.js` gera um certificado local e termina o TLS de `api.anthropic.com` (e de `chatgpt.com`, se houver conta Codex). O cliente confia na CA via `NODE_EXTRA_CA_CERTS`, só no processo lançado por `teamclaude run`. A documentação diz que a CA não entra no sistema e que a chave dela não é gravada. **[V]** para o código, **[S]** para a promessa da documentação.
5. **Sincroniza tokens por um serviço de terceiros.** Em `callback.net`, as contas OAuth (identidade, token de acesso e `refreshToken`) vão para um serviço externo, que a documentação diz guardar criptografado, "só legível com o seu login". O conteúdo que trafega e a garantia são **[S]**; não auditei. **[N]**
6. **Tem recursos de contorno e gasto.** `sx.org` (proxy residencial para "contornar 429 por IP de saída", com código de indicação do autor na documentação); `autoRedeemResets` (resgata reinícios gratuitos da conta); `allowExtraUsage` (consome uso extra pago); keep-warm e sonda de cota, que fazem chamadas que nenhum cliente pediu (desligados por padrão). **[V]** (`docs/configuration.md`, `docs/compliance.md`)

**O que a própria documentação admite.** `docs/compliance.md`: o autor diz que a Anthropic "não abençoou explicitamente" o pool automatizado, que apontar frontends de terceiros para credenciais Pro/Max é o padrão que a Anthropic restringe, e que a decisão de termos é do usuário. Para OpenAI e os demais, "não há texto equivalente ainda". **[S]**

**Choca com as regras do OTheater? Sim, de frente.**

- A §3 diz: **"O framework nunca lê, copia nem reaproveita tokens OAuth."** O TeamClaude lê, copia, renova, guarda e injeta tokens. Também reescreve o `account_uuid`, o que é adulterar um campo de identidade da requisição. **[V]**
- A mesma seção registra, a partir da documentação da Anthropic, que quem desenvolve produtos não pode "encaminhar requisições pelas credenciais de assinatura em nome de usuários, nem coletar ou intermediar esses tokens". O TeamClaude é exatamente um intermediador de tokens, ainda que de uma pessoa só. **[V]** (citação da própria arquitetura; os termos em si **[N]**, a rever na fonte e na data)
- Um proxy MITM com CA própria, sincronização de tokens num serviço externo e proxy residencial "anti-429" também ficam muito fora do perfil de segurança do OTheater (§5.12: daemon local, token por aparelho).

**Conclusão sobre o TeamClaude:** não adotar, não copiar código e não rodar. Serve só de **referência de ideias** que não dependem de tocar no token:

- separar o 429 de **cota esgotada** do 429 de **limite por minuto**, rotacionando só no primeiro (ritmo igual ao da conta atual no segundo);
- espaçar as requisições na conta recém-escolhida, para uma tropa de agentes não derrubá-la;
- preferir a conta cuja janela semanal reinicia primeiro (roteamento por "pressão de expiração");
- limiar de troca configurável (98%).

Tudo isso o OTheater pode implementar com os sinais que já usa (statusline, `rate_limit_event`, `app-server`), sem proxy.

## 5. Recomendação

**Continuar com o projeto próprio.** Usar o Claudexor como **referência de desenho** e, no máximo, fonte de **atribuições pequenas** (os parsers de cota e a regra de rotação), com a lista da seção 3.8. Não fazer fork.

Motivos, nos critérios da ADR:

1. **Critério 3 (XState):** não há máquina de estados, e o pipeline é o núcleo do que o OTheater quer ser. Mesmo motivo que descartou os outros candidatos.
2. **Critério 5 (ritmo):** cerca de 20 commits por dia, com versões maiores a cada poucas semanas. Um fork perderia a conexão com o upstream quase de imediato.
3. **Regras de segurança (§3):** o Claudexor lê tokens e chama a API do fornecedor por fora do cliente oficial. Herdar isso iria contra uma premissa explícita da arquitetura. Os trechos úteis são justamente os que **não** tocam em token.
4. **Escolha de projeto diferente:** o Claudexor fala com Claude e Codex por E/S nativa; a arquitetura decidiu ACP. Adotar a base dele seria trocar uma decisão do dono por outra.
5. **Pontos a favor, que não mudam a conclusão:** licença limpa (nenhum libvips, nenhum SDK "Custom"), daemon separado com API, muito teste, e um desenho do pool de contas que confirma o que a §5.6 e a §5.7 já propõem.

**A ADR 0001 precisa mudar?**

- **A decisão não.** "Projeto próprio, sem fork" continua valendo, e o Claudexor reforça o motivo 2 (nenhum candidato usa XState) e o motivo 4 (ritmo).
- **Duas anotações seriam úteis, a critério do dono** (não editei a ADR):
  1. acrescentar o Claudexor à tabela de candidatos, como "referência de desenho, MIT, sem fork", e a linha de trechos com atribuição à lista de reaproveitamento;
  2. registrar que ele e o TeamClaude lêem token OAuth, por isso **ficam de fora** os arquivos listados na seção 3.8.
- **A decisão continua do dono.** Nada aqui altera a arquitetura nem o `docs/13`.

## 6. O que não foi verificado

- Os testes do Claudexor não foram executados (nem a compilação). Não sei se a suíte passa, quanto tempo leva, nem a memória do daemon. **[N]**
- Não sei se a consulta a `oauth/usage` vem ligada por padrão, nem em que frequência. **[N]**
- O que a Anthropic e a OpenAI permitem hoje (login por assinatura fora do cliente oficial, uso do endpoint `oauth/usage`, `chatgpt.com/backend-api/codex`) **não foi confirmado nos termos de uso**. Falta citar fonte e data antes de afirmar qualquer coisa. **[N]**
- Não li o app de macOS em Swift nem o `docs/ARCHITECTURE.md` do Claudexor inteiro (9.923 linhas); li as seções de abertura, de daemon, de armazenamento e de operações do chamador. **[V]** para o que foi lido.
- O que `callback.net` faz com os tokens vem só da documentação do TeamClaude. **[N]**
- Os números de commits, estrelas e colaboradores vêm da API do GitHub em 2026-11-15. **[S]**
- O verificador `check.mjs` precisa de correção para pnpm (seção 3.2); até lá, árvores pnpm só valem lidas à mão.
