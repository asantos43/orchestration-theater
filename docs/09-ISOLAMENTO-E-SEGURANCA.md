# 09. Isolamento e segurança

Os dois cenários de isolamento são as **arquiteturas 1 (com contêiner)** e **2 (sem contêiner)**, detalhadas em [03](03-ARQUITETURA-1-COM-CONTEINERES.md) e [04](04-ARQUITETURA-2-SEM-CONTEINERES.md) e comparadas em [05](05-COMPARACAO-E-CRITERIOS.md). Este documento junta o que vale para ambas e as consequências de segurança de cada uma.

## Histórico da decisão

A primeira proposta da conversa foi um **contêiner por worktree**. O dono levantou que isso limitaria o produto ao Linux, já que quer o app de desktop para **Windows e macOS**, e que os agentes precisam de **internet** para tarefas que vão além de código. A partir daí os dois cenários passaram a ser comparados lado a lado, sem escolha ainda.

## O que protege o código em cada cenário

| Proteção | 1. Com contêiner | 2. Sem contêiner |
|---|---|---|
| Arquivos do host fora da worktree | Fora do alcance do agente (fronteira do sistema) | Dependem de política, usuário dedicado ou sandbox do cliente |
| Segredos de outras contas e `~/.ssh` | Não montados | Ao alcance de uma ferramenta de shell do mesmo usuário |
| Sandbox do cliente | Desligado com segurança (o contêiner é o sandbox) | Ligado causa `EPERM`; desligado não há fronteira |
| Portas, `HOME`, `/tmp` | Próprios de cada contêiner | `HOME` e `TMPDIR` próprios; portas podem colidir |
| Limites de CPU, memória, processos | Nativos | Frouxos (job objects no Windows) |
| Limpeza | Destruir o contêiner | Encerrar a árvore de processos |
| Rede | Política por contêiner (proxy, sem rede) | Só pela ferramenta web própria |

No cenário sem contêiner, a proteção deixa de ser uma **fronteira do sistema operacional** e passa a ser **política aplicada pelo núcleo**: worktree e diretório temporário por agente; permissões por ferramenta e por caminho (`--allowedTools`, `--disallowedTools`, `--permission-prompts host` no Claude; política do Codex); ambiente limpo, sem herdar segredos; conta e configuração separadas (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); limite de tempo e encerramento da árvore de processos; e, opcionalmente, usuário do sistema dedicado. Os sandboxes nativos dos clientes diferem por sistema; o suporte no Windows **não foi verificado**.

Em ambos os cenários, o **Runner roda as verificações** (testes, compilação, mutações) por conta própria, fora do sandbox do cliente.

## Internet e tarefas gerais

Os agentes precisam de internet ([00](00-OBJETIVO.md), R10). O risco é a **injeção de prompt**: uma página lida pelo agente pode tentar dirigi-lo. O perigo real aparece quando o mesmo agente junta **dados privados, conteúdo não confiável e um canal de saída**. Regras (valem nos dois cenários; o contêiner reforça, não substitui):

1. **Quem lê a web não envia nada.** Exemplo das manchetes: o agente produz o HTML como artefato; o **núcleo valida e higieniza** o HTML e envia o e-mail por uma ferramenta própria, com **destinatário fixo** configurado pelo dono. O agente nunca recebe a credencial do e-mail.
2. **A web entra por uma ferramenta própria** (MCP): busca e leitura com lista de domínios, limite de taxa e registro de cada acesso. Funciona igual para Claude, Codex e OpenCode e dá telemetria. As ferramentas web do cliente ficam desligadas.
3. **Conjuntos de ferramentas mínimos por papel e por tarefa.** O orquestrador e os agentes de leitura da web têm as listas mais curtas possíveis.
4. **Ferramentas que gravam ou enviam exigem política**: destino fixo, tamanho máximo, formato validado, confirmação do dono quando a política mandar.

Sem contêiner, a regra 1 e a 3 são **a** defesa; com contêiner, o isolamento do host e a política de rede são uma segunda camada.

## Segredos

- Tokens de contas e credenciais de e-mail ficam no **cofre do sistema**: Keychain (macOS), Credential Manager (Windows), libsecret (Linux).
- Redigir tokens em logs, eventos e trajetórias (o `okit-plugin` já tem redação de tokens como referência).
- Injetar o segredo só no processo que o precisa, e só enquanto roda. No cenário com contêiner, o segredo da conta é injetado no contêiner daquele passo; o cofre fica no host.
- Registrar a data de emissão de cada token (`setup-token` e outros) para avisar da renovação e para o caso de vazamento.

## API local do núcleo

- Escuta só em `127.0.0.1` com **token de sessão**, rejeitando origens externas; mesmo padrão do `okit-plugin config ui` (token, anfitrião e origem).
- Acesso remoto (se desejado) por túnel autenticado (Tailscale ou Cloudflare Tunnel), nunca por porta aberta.
- Plugins como **processos externos** com manifesto de permissões; nada de código de plugin dentro do processo do núcleo.

## Riscos aceitos e a vigiar

| Risco | Observação |
|---|---|
| Agente com ferramenta de shell lê o resto do disco do usuário | Só no cenário sem contêiner; mitigar com usuário dedicado, sandbox do cliente onde couber e runner de contêiner para tarefas de risco |
| Injeção de prompt por conteúdo da web | Separar leitura e envio; ferramentas próprias; listas curtas; contêiner como segunda camada |
| O contêiner protege o host, não o que está dentro | A worktree e o token injetado continuam acessíveis ao agente |
| Vazamento de token da assinatura | Cofre do sistema, redação em logs, injeção mínima, rotação |
| Contas sinalizadas por uso automatizado | Ver [07](07-ASSINATURAS-E-TERMOS.md); manter troca de executor |
| Diferenças entre sistemas operacionais | Testar nos três; evitar suposição de Linux; contêiner no macOS e no Windows exige VM |
