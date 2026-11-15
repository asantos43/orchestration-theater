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
  - `tools` define quais ferramentas existem; o **Bash nativo é removido**. Regras de deny para Bash não pegam o mesmo programa chamado por caminho ou dentro de `sh -c`, então filtrar não basta.
  - Também usa regras `deny`, o modo `dontAsk`, `--strict-mcp-config` só com os MCPs do papel e `disableBypassPermissionsMode`.
  - Como essas flags chegam pelo ACP ainda precisa ser confirmado na Fase 0.
- **OpenCode:** allow/ask/deny com padrões. Na V2, `bash` virou `shell`, e `external_directory` vem liberado por padrão, então precisa ser negado explicitamente. Fixar a versão.
- **Codex:** `sandbox_mode`, `approval_policy` e habilitação de ferramentas por servidor MCP. O shell faz parte do núcleo do Codex, então a contenção vem do sandbox dele:
  - **MXC** no Windows 11 24H2+;
  - modo `elevated` nos demais, o que exige configuração com admin.

### 2. ACP

O daemon responde automaticamente a cada `session/request_permission`, conforme a política do papel, sem perguntar a ninguém.

### 3. Sistema operacional

É a **única camada que é fronteira de segurança de fato**.

| Plataforma | Recurso |
|---|---|
| Todas | Worktree como `cwd`, mais Job Object ou grupo de processos |
| macOS/Linux | `@anthropic-ai/sandbox-runtime` (Seatbelt/bubblewrap): rede negada por padrão com lista de domínios, escrita restrita |
| Windows | `sandbox-runtime` em **alpha**, a pilotar na Fase 0. Sem ele, a base é um usuário de baixo privilégio com ACL só na worktree, mais o sandbox do Codex. **O Claude Code nativo no Windows roda comandos sem sandbox**: mais um motivo para remover o Bash dele. |

O **lançador com Job Object** é um binário mínimo em Rust (`win32job`) que:
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
- a web entra pela casca **`http_get`**, com domínios permitidos, por plugins MCP ou pelo **navegador compartilhado** (arquitetura §5.19, v0.13). O navegador tem perfil isolado por cenário, domínios permitidos e aprovação para clicar e preencher;
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
| R17 | Navegador compartilhado: injeção de prompt pela página, ou ação com conta logada no perfil do cenário | Perfil isolado por cenário, sem importar cookies; domínios permitidos; escrita com aprovação por padrão; página tratada como dado; evento com print de cada ação |
| R18 | Tarefa recorrente roda sem supervisão um script escrito por agente | Passos de código no sandbox; definição só ativa depois do ensaio e da aprovação; versão nova a cada mudança; destinatário fixo; orçamento por execução |
| R20 | Acesso remoto pelo app Android: aparelho perdido, token vazado, VPN mal configurada | Só pela VPN; token por aparelho, revogável, no armazenamento seguro; certificado fixado no pareamento; ações destrutivas pedem confirmação |
| — | Injeção de prompt por conteúdo da web via `http_get` e plugins | Separar leitura e envio; `http_get` com domínios; `effects` declarados nos plugins |
| — | Contas sinalizadas por uso automatizado | [07](07-ASSINATURAS-E-TERMOS.md); troca de Executor sem reescrever o núcleo |

Os dois últimos riscos vêm da conversa de 2026-11-08 e não estão na tabela da arquitetura. A injeção pelo navegador compartilhado está no R17.
