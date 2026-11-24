# 09. Isolamento e segurança

Este documento resume como o OTheater isola os Executores e protege o código, os segredos e a máquina. A base é a arquitetura v0.10 (§3, §5.8, §5.9, §5.12, §5.14 e §11), de 2026-11-13, e o texto foi conferido com a v0.32 em 2026-11-14. **Nada aqui foi verificado localmente.** A Fase 0 mede o sandbox no Windows, as permissões pelo ACP e o lançador com Job Object.

## Histórico da decisão

- A primeira proposta da conversa de 2026-11-08 foi um **contêiner por worktree**.
- O dono levantou dois problemas:
  - isso limitaria o produto ao Linux, e ele quer Windows e macOS;
  - os agentes precisam de **internet** para tarefas além de código.
- A partir daí, os dois cenários foram comparados lado a lado nos antigos documentos 03 a 05, apagados em 2026-11-13 (última versão no commit `cb05e35`).
- Em **2026-11-13**, a arquitetura decidiu pelo cenário **sem contêiner**, com permissões em três camadas (decisões Q1 e Q9 em [13](13-DECISOES-EM-ABERTO.md)). A comparação fica no histórico do git.

## Princípio: bloquear tudo, liberar o necessário (P5)

| Categoria | Tratamento |
|---|---|
| Ler, buscar e editar arquivos | Ferramentas **nativas** do cliente, confinadas à worktree. Os modelos são treinados nelas. |
| Shell, testes, build, git, rede, banco, deploy | Nativo **bloqueado**. Só pelas **cascas** do framework. |
| Plugins | Servidor MCP + manifesto com as permissões declaradas. |

## As três camadas (arquitetura §5.8)

### 1. Configuração do cliente

O `prepareProfile` grava esta camada no diretório do perfil a cada mudança de política.

- **Claude Code:**
  - `tools` define quais ferramentas existem; o **Bash nativo é removido**. Regras de deny por padrão não bastam: na Fase 0 (`claude` 2.1.325), `deny: ["Bash(touch *)"]` pegou `touch`, `/usr/bin/touch` e `env touch`, mas `sh -c` e `bash -c` furaram. O `deny` fica como segunda camada, com o daemon recusando os pedidos (arquitetura v0.45, §5.8).
  - Também usa regras `deny`, `--strict-mcp-config` só com os MCPs do papel e `allowDangerouslySkipPermissions: false` (tira o bypass do catálogo de modos).
  - Headless, nega tudo que pediria permissão: modo `default`, com o daemon recusando cada `request_permission`. O `dontAsk` não chega pelo ACP.
  - Pelo ACP, essas chaves vão em `_meta.claudeCode.options` do `session/new` (medido na Fase 0; arquitetura v0.42, §5.8).
- **OpenCode:** allow/ask/deny com padrões. Na V2, `bash` virou `shell`, e `external_directory` vem liberado por padrão, então precisa ser negado explicitamente. Fixar a versão. Sem configuração, tudo é permitido, e não há bypass pelo ACP. O daemon fixa as permissões em `OPENCODE_PERMISSION`, que vence o `opencode.json` do cwd e o `OPENCODE_CONFIG_CONTENT`, e liga `OPENCODE_DISABLE_PROJECT_CONFIG=1`, porque o modelo pode editar a worktree (Fase 0, item 8; arquitetura v0.45).
- **Codex:** `sandbox_mode`, `approval_policy` e habilitação de ferramentas por servidor MCP. O shell faz parte do núcleo do Codex, então a contenção vem do sandbox dele:
  - **MXC** no Windows 11 24H2+;
  - modo `elevated` nos demais, o que exige configuração com admin.
  - Pelo ACP, o catálogo sempre traz `agent` e `agent-full-access`, e nenhuma opção de linha de comando os tira. No `agent`, a escalada é aprovada por um revisor automático do Codex sem pedido ao cliente; no `agent-full-access`, nada pede permissão. A sessão começa em `workspace-write` (ou `read-only`) e o daemon nunca pede os outros dois (Fase 0, item 8; arquitetura v0.45). O sandbox de `workspace-write` deixa `/tmp` gravável.

### 2. ACP

O daemon responde automaticamente a cada `session/request_permission`, conforme a política do papel, sem perguntar a ninguém.

### 3. Sistema operacional

É a **única camada que é fronteira de segurança de fato**.

| Plataforma | Recurso |
|---|---|
| Todas | Worktree como `cwd`, mais Job Object ou grupo de processos |
| macOS/Linux | `@anthropic-ai/sandbox-runtime` (Seatbelt/bubblewrap): rede negada por padrão com lista de domínios, escrita restrita |
| Windows | `sandbox-runtime` em **alpha**, a pilotar na Fase 0. Sem ele, a base é um usuário de baixo privilégio com ACL só na worktree, mais o sandbox do Codex. **O Claude Code nativo no Windows roda comandos sem sandbox**: mais um motivo para remover o Bash dele. |

O **lançador com Job Object** é um binário mínimo em Rust (`windows-sys`, N60) que:
1. cria o job, com limite de memória e `KILL_ON_JOB_CLOSE`;
2. inicia o Executor suspenso;
3. associa o processo ao job e o retoma.

Assim nenhum processo neto escapa (§5.9).

## Cascas (`tools/`)

Testes, build e mutações rodam **pelo daemon**, não pelo shell do cliente. Isso resolve o `EPERM` do sandbox visto no D151 ([01](01-CONTEXTO-E-PROBLEMAS.md)). Regras das cascas:
- são estreitas e tipadas (`run_tests`, `install_deps`, `git_commit`, `restricted_shell`, `http_get`, `view_diff`);
- o shell é só por `argv`, com lista de comandos permitidos e sem `;`, `|` ou `&&`;
- os caminhos são normalizados e presos à worktree: `..` e symlinks que saem dela são rejeitados;
- `http_get` só acessa domínios permitidos;
- há timeout e a saída é truncada;
- toda chamada gera evento, passa pelos semáforos e conta para o consumo;
- efeitos colaterais levam **chave de idempotência** (tabela `side_effects`, §5.16), para que uma retomada não os repita.

## Internet e injeção de prompt

Os agentes precisam de internet (R10 em [00](00-OBJETIVO.md)). O risco é a **injeção de prompt**: uma página lida pelo agente pode tentar dirigi-lo. O perigo real aparece quando o mesmo agente junta **dados privados, conteúdo não confiável e um canal de saída**.

Na arquitetura:
- a web entra pela casca **`http_get`**, com domínios permitidos, por plugins MCP ou pelo **navegador compartilhado** (arquitetura §5.19, v0.13). Desde a N40 (2026-11-15), o padrão do navegador não tem restrições: ele usa os logins do Produtor por uma extensão, abre qualquer domínio, `localhost` e `file://` (menos os caminhos de segredo) e clica sem aprovação. O perfil isolado, os domínios permitidos e a aprovação continuam como modos;
- as ferramentas web nativas do cliente ficam fora do conjunto do papel;
- cada ferramenta de plugin declara seus `effects` (`read | local_write | network | external_write`). Uma ferramenta pode exigir aprovação do Produtor (`requires_producer_approval`).

Regras de uso, registradas na conversa de 2026-11-08 e compatíveis com a arquitetura:
1. **Quem lê a web não envia nada.** No exemplo das manchetes ([10](10-TAREFAS-GERAIS-E-AGENDAMENTO.md)), o agente produz o HTML como artefato. O envio é feito por uma ferramenta de plugin com **destinatário fixo** configurado pelo dono, e a credencial do e-mail fica no plugin, nunca com o agente.
2. **Conjuntos de ferramentas mínimos por papel.** O Diretor não tem ferramentas de código nem de rede.
3. **Ferramentas que gravam ou enviam exigem política:** destino fixo, tamanho máximo, formato validado e confirmação do Produtor quando o manifesto mandar.

Sem contêiner, essas regras e a camada 3 são a defesa.

## Segredos

- Chaves de API ficam no **cofre do sistema operacional** via `@napi-rs/keyring`:
  - Credential Manager no Windows;
  - Keychain no macOS;
  - Secret Service no Linux.
- **Linux sem Secret Service:** arquivo criptografado com senha mestra, ou chave só em variável de ambiente do serviço. O daemon informa qual backend está em uso e nunca grava a chave em texto puro.
- A chave é injetada só no processo do Executor ou no servidor do plugin que precisa dela (`secrets` do manifesto).
- Nunca há segredo em arquivo de configuração, log ou evento (§3). Os prompts ficam redigidos por padrão no OTel (§5.11).
- **Tokens OAuth de assinatura não são tocados**: ficam no diretório do perfil, geridos pelo cliente oficial (§3). Para o Codex, a OpenAI pede tratar o `auth.json` como senha ([07](07-ASSINATURAS-E-TERMOS.md)).
- A redação de tokens do `okit-plugin` serve de referência.

## API local do daemon (arquitetura §5.12)

- Escuta em `127.0.0.1` por padrão.
- O **token é obrigatório mesmo no acesso local**, com CORS fechado, para que nenhuma página de outra origem comande o daemon.
- Acesso remoto pela **VPN do usuário** (`api.remote: vpn`), com TLS do daemon, pareamento por QR e token por aparelho. O daemon nunca fica exposto na internet. Quem já tem reverse proxy com TLS pode usar `api.remote: proxy`. É tratado como acesso administrativo. A N9 foi decidida em 2026-11-14, para o app Android (arquitetura §5.12 e §5.13).
- Plugins rodam como **processos externos** (servidores MCP), agregados pelo daemon. Nenhum código de plugin roda dentro do processo do daemon nem na interface: o painel do plugin é declarativo (arquitetura §5.14 e §5.18, v0.12).

## Riscos (arquitetura §11)

| # | Risco | Mitigação na arquitetura |
|---|---|---|
| R4 | Sandbox fraco no Windows | Bash nativo removido; cascas; usuário de baixo privilégio; Job Object; testes de fuga |
| R6 | RAM com muitos Atores (um `claude` por sessão) | Admissão por sessão; plugins agregados; semáforo de comandos pesados |
| R13 | Tarefa agendada faz algo indesejado sem ninguém olhando | Entrega por PR; orçamento por execução; decisão sem ninguém olhando segue com a recomendada depois de um prazo, e numa decisão irreversível só com a opção segura (v0.26) |
| R15 | Retomada repete efeito colateral | Chaves de idempotência; checkpoints; pacote de continuação |
| R17 | Navegador compartilhado: injeção de prompt pela página, ou ação com conta logada no perfil do cenário Desde a N40 (2026-11-15), o risco é maior e foi aceito pelo dono. Ficam: a página tratada como dado, os caminhos de segredo fora do `file://`, o botão de parar, o evento com print de cada ação e os modos antigos por projeto ou cenário |
| R18 | Tarefa recorrente roda sem supervisão um script escrito por agente | Passos de código no sandbox; definição só ativa depois do ensaio e da aprovação; versão nova a cada mudança; destinatário fixo; orçamento por execução |
| R20 | Acesso remoto pelo app Android: aparelho perdido, token vazado, VPN mal configurada | Só pela VPN; token por aparelho, revogável, no armazenamento seguro; certificado fixado no pareamento; ações destrutivas pedem confirmação |
| — | Injeção de prompt por conteúdo da web via `http_get` e plugins | Separar leitura e envio; `http_get` com domínios; `effects` declarados nos plugins |
| — | Contas sinalizadas por uso automatizado | [07](07-ASSINATURAS-E-TERMOS.md); troca de Executor sem reescrever o núcleo |

Os dois últimos riscos vêm da conversa de 2026-11-08 e não estão na tabela da arquitetura. A injeção pelo navegador compartilhado está no R17.

## Revisão da Fase 11 (P8, 2026-11-23)

Revisão da API local e das cascas (P8b), mais a cadeia de suprimento (P8a, outro PR). Método: leitura do código, testes adversariais escritos à mão e a skill `/security-review` sobre a branch. Marcas: **[V]** reproduzido ou confirmado por teste local; **[S]** fonte secundária; **[N]** suspeita ou limite aceito, sem confirmação. As chaves novas são de reinício: valem na próxima subida do daemon (ver "Chaves novas"). O `api.remote` (VPN, proxy) ficou de fora: é da Fase 12.

### Achados e consertos

| # | Área | Achado | Gravidade | Estado | Chave | Teste |
|---|---|---|---|---|---|---|
| 1 | API | Anexo por `path` lia qualquer arquivo legível (`~/.ssh/...`) e o entregava a um modelo **[V]** | alta | consertado (N287) | `security.attachment_roots` | `api/security-review.test.ts` |
| 2 | API | Rotação do token: um pedido que já tinha passado pelo portão terminava com o token velho, e tickets e soquetes do chat sobreviviam **[V]** | média | consertado (época do token) | — | `security-review.test.ts`, `chat-tickets.test.ts` |
| 3 | API | Tickets do chat sem teto, com limpeza que varria todos **[V]** | média | consertado (teto e limpeza barata) | `api.chat.max_tickets` | `chat-tickets.test.ts`, `security-review.test.ts` |
| 4 | API | JSON profundo derrubava o `JSON.parse` (500) no corpo REST e no quadro do chat **[V]** | média | consertado (400 `json_too_deep`; no chat, quadro de erro) | `api.max_json_depth` | `security-review.test.ts` |
| 5 | API | Mensagens de erro e `details` com caminho absoluto (diz quem é o usuário e como a máquina é) **[V]** | média | consertado (`<path>`; o log guarda a mensagem inteira) | — | `security-review.test.ts` |
| 6 | API | Arquivo de token e pasta de dados: escrita com nome temporário previsível e seguindo link; token antigo com modo frouxo era reaproveitado; pasta de dados já existente com bits de grupo/outros **[V]** | média | consertado (`O_EXCL`, `O_NOFOLLOW`, `0600`, só reaproveita arquivo regular privado; pasta `0700`) | — | `security-review.test.ts`, `paths.test.ts` |
| 7 | API | Soquetes do chat, fila de mensagens e tabela de idempotência sem teto **[V]** | baixa | consertado | `api.chat.max_sockets`, `api.chat.max_queued_messages`, `api.idempotency_max_entries` | `security-review.test.ts`, `idempotency.test.ts` |
| 8 | API | O redator do log não cobria cabeçalhos nem chaves de segredo aninhadas **[V]** | média | consertado | — | `logger.test.ts` |
| 9 | Cascas | `confineArgv` não olhava a opção curta colada (`-f/etc/passwd`) nem `--opt=valor` **[V]** | alta | consertado | — | `core/src/shell-tools/{confine,argv}.test.ts` |
| 10 | Cascas | `node -e`, `-p`, `-r`, `--import`... rodavam código que não estava em arquivo da worktree **[V]** | alta | consertado (N290) | `shell.node_inline` | `tools/command-tools.test.ts`, `core/.../argv.test.ts` |
| 11 | Cascas | `http_get` liberava um domínio permitido que resolvia para `127.0.0.1`, rede privada ou metadados de nuvem **[V]** | alta | consertado (resolve o nome e recusa endereço privado; com `tools.http.redirects: follow_allowed`, a cada salto) | `shell.http_get.block_private` | `tools/private-address.test.ts`, `tools/http-get.test.ts` |
| 12 | Suprimento | Chave pública de verificação embutida no pacote **[V]** | média | P8a, feito | — | P8a |
| 13 | Suprimento | `install.sh`: o manifesto assinado em Ed25519 (`.sig`) e em SSHSIG (`.sshsig`, namespace `otheater-release`) é conferido antes de ler o conteúdo, por openssl 3, depois `ssh-keygen`, depois o SHA-256 fixado no script; sem nenhum verificador, recusa (código 3). O executável baixado nunca confere a si mesmo (N288). `OT_INSTALL_VERIFIER=auto\|openssl\|ssh-keygen\|pinned` escolhe o verificador **[V]** | alta | P8a, feito (N288) | — | P8a |
| 14 | Suprimento | Troca da chave ou do `openssl` no `install.sh` (variáveis do `wget` e da raiz de confiança) só com `OT_INSTALL_ALLOW_KEY_OVERRIDE=1` **[V]** | média | P8a, feito | — | P8a |
| 15 | Suprimento | Restauração de uma versão guardada por execução anterior: passa de novo por canal, `minVersion` e validade, com a configuração e o relógio de agora, ao restaurar e ao aplicar (`updates/policy.ts`) **[V]** | média | P8a, feito | — | P8a |
| 16 | Suprimento | Diário do aplicador sem autenticação: agora guarda `manifestSha256`, e a prova é o manifesto assinado ao lado do executável. Sem prova válida (SHA, assinatura, versão, SHA do ativo) nada é movido e sai o aviso `update_untrusted_journal`; `exe` e `backup` ficam confinados **[V]** | alta | P8a, feito | — | P8a |
| 17 | Suprimento | Validade do manifesto: campo opcional `expires`, gerado pelo `assemble` com `manifestValidityDays`; o `install.sh` recusa vencido **[V]** | média | P8a, feito | `updates.manifest_expiry`: `enforce` (padrão; recusa vencido, aceita sem `expires` e avisa `update_no_expiry`), `require`, `off` | P8a |
| 18 | Suprimento | Download de adaptadores (`adapters/install`): redirecionamento só para `clients.adapters.redirect_hosts` e até `redirect_max` (3); o `tar` recusa entradas duplicadas e mais de `tar_max_entries` (20000) **[V]** | média | P8a, feito | `clients.adapters.redirect_hosts`, `redirect_max`, `tar_max_entries` | P8a |
| 19 | Suprimento | `verify credentials` é uma verificação do lint, **não** uma garantia de que não há credencial **[V]** | baixa | P8a, aceito (documentado) | — | P8a |

As linhas 12 a 19 são do PR do P8a (branch `fase11/p8a-cadeia`); o teste e o estado de cada uma estão lá. Fora do escopo do P8a **[N]**: a repetição de um manifesto antigo e ainda válido (rollback dentro da validade); a rotação da chave; `from` e `dataDir` do diário, que não são autenticados; a presença do `openssl@3` nas imagens macOS da CI, não confirmada.

### Chaves novas

| Chave | Modos | Padrão |
|---|---|---|
| `security.attachment_roots.mode` | `list`, `any` | `list` |
| `security.attachment_roots.defaults` | subconjunto de `project`, `worktrees`, `documents`, `downloads` | os quatro |
| `security.attachment_roots.add` | lista de caminhos absolutos ou com `~` | vazia |
| `shell.node_inline` | `deny`, `allow` | `deny` |
| `shell.http_get.block_private` | `on`, `off` | `on` |
| `api.max_json_depth` | inteiro >= 1 | 64 |
| `api.chat.max_tickets` / `max_sockets` / `max_queued_messages` | inteiro >= 1 | 64 / 32 / 256 |
| `api.idempotency_max_entries` | inteiro >= 1 | 10000 |

O bloco `shell` vale só na configuração global (não há `tools.*` por projeto para estas duas chaves). Testes das chaves: `config.test.ts`, bloco "the security review of Phase 11".

### Decisões do dono, 2026-11-23

- **N287, anexo por caminho.** Com `list`, só entra o arquivo cujo `realpath` está sob uma das raízes: o projeto, as worktrees do cenário, Documentos e Downloads do usuário (resolvidos por plataforma: `XDG_*` e `user-dirs.dirs` no Linux, `~/Documents` no macOS, `%USERPROFILE%` no Windows) e o que o usuário puser em `add`. As raízes também passam por `realpath`; a referência é conferida de novo na leitura. Uma pasta do XDG que seja a própria home ou a raiz do disco é ignorada [V].
- **N290, `node` inline.** Com `deny`, o `node` recusa `-e`, `--eval`, `-p`, `--print`, `-r`, `--require`, `--import` e `--input-type`, também colados e na forma `--opção=valor` (e `-pe`). O que vem depois de `--` é do script. **O que isso não resolve:** `node script.js` e os scripts do projeto (`npm test`, `pnpm build`) continuam rodando código arbitrário que o agente pôde escrever na worktree; quem segura isso é o sandbox (camada 3), não a lista de bandeiras. Com `allow`, vale só o sandbox.

### O que ficou [N] ou fora

- **[N] DNS rebinding no `http_get`:** o nome é resolvido para conferir e de novo para conectar; um servidor que troque a resposta entre as duas passa. Fechar pede conectar no IP já conferido (com SNI do nome).
- **[N] Opções curtas agrupadas** com valor colado (`-abf/etc/passwd`) não são abertas; só a opção curta única colada e o `--opção=valor`.
- **[N] `node script.js -p`** é recusado no modo `deny` (a opção é do script); o contorno é `node -- script.js -p`.
- **[N] Windows:** pastas conhecidas realocadas (OneDrive) não são perguntadas ao sistema (use `add`); os modos de arquivo POSIX não existem e a ACL não foi revista; a ordem de acesso ao arquivo de token fica por conta da ACL padrão da pasta do usuário.
- **[N] Teto de soquetes:** pode passar um pouco do teto enquanto há aperto de mão em curso, limitado por `max_tickets`. Uma fila de 256 mensagens de 1 MiB é um pior caso grande de memória.
- **[N] Leitura do token durante a escrita:** um cliente que leia o arquivo na janela da troca recebe 401 e lê de novo.
- **[N]** `ensureDataDir` não muda o modo de uma pasta de outro usuário. A redação de caminhos corta no espaço. A mensagem de anexo "fora das raízes" difere da de "não é um arquivo", então a existência de um arquivo fora das raízes é distinguível; quem anexa é o Produtor, impacto baixo.
- **[N] Endereços sem uso na prática** que o classificador não cobre: SIIT (`::ffff:0:a.b.c.d`), `64:ff9b:1::/48` e Teredo. Só chegam com uma rede especial.
- **[N] A raiz `project`** é o repositório que o Produtor registra no cenário; quem tem o token pode registrar `~` como repositório e anexar tudo abaixo. É o mesmo nível de confiança do token, e a revisão trata como projeto.
- **Fora do escopo:** o servidor MCP do daemon (porta `auto`), o receptor OTLP e o ambiente dos plugins não foram revisados a fundo neste passo [N]; ficam sem revisão e precisam de um passo próprio.

### Resultado da `/security-review`

Rodada sobre a branch (commit `a6bd973`, antes dos dois consertos abaixo). Nenhum achado com confiança maior que 80% [V]. As três observações abaixo do corte: o redator não pegava caminho depois de `=` ou `:` e a pasta XDG igual à home viraria raiz (as duas **consertadas** e testadas), e a raiz `project` acima, aceita.
