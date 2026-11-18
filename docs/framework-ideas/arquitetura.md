# Arquitetura — OTheater (Orchestration Theater)

> Documento-base de construção. Complementa `framework_multiagentes.md` (pipeline teatral), `framework_multiagentes_orquestrador_e_executores.md` (entidades) e `principais-papeis.md`. Onde este documento detalha *como*, aqueles definem *o quê*.
>
> Versão 0.73 — 2026-11-17. Produto: **OTheater** (*Orchestration Theater*). Linguagem: **TypeScript** de ponta a ponta. Licença do código próprio: **MPL-2.0** (era MIT até a v0.18).
> A v0.5 definiu a TUI em **Ink**, com teste do **OpenTUI** na Fase 0, e ligou as interfaces aos mockups em `mockup/`. A v0.6 faz da **TUI a interface principal** (Fase 7), cria o `packages/client` compartilhado e deixa web e desktop como fases opcionais (12 e 13). A v0.7 acrescenta o suporte multiplataforma da TUI: mapa de teclas configurável com padrões por sistema, fallback do cofre no Linux e uso por SSH. A v0.11 acrescenta as **ordens do Produtor**, globais e locais (seção 5.17), conceito trazido do `okit`. A v0.12 acrescenta **portas, adaptadores e registros** (P12, seção 5.18): contratos em `@otheater/core`, implementações trocáveis em pacotes `@otheater/adapter-*` e fluxos registrados por nome. A v0.13 acrescenta o **navegador compartilhado** (seção 5.19): o Produtor indica elementos da página para o agente trabalhar. A v0.14 define os **cenários** (seção 5.20): projeto com perfil, tarefa com definição e execuções, e chat genérico com Diretor que consulta um Ator forte. A v0.15 trata da **durabilidade e recuperação** (seção 5.21): gravação durável no SQLite, reconciliação na subida, comportamento com a máquina religada sem login e backup diário. A v0.16 fixa os **padrões** dos cenários e da durabilidade como chaves de configuração (seções 5.20 e 5.21) e cria a Fase 10b, do daemon sem login, logo depois da v1. A v0.17 define o **idioma** (seção 5.22): código, configuração, eventos, ferramentas, comandos e prompts em inglês, interface em inglês e português do Brasil desde a primeira tela, e os nomes canônicos em inglês no glossário (seção 13). A v0.18 fixa os **padrões do pipeline, da entrega, do agendador e da retomada** como chaves de configuração com predefinições (seções 5.4, 5.5, 5.15 e 5.16). A v0.19 troca a licença do código próprio de MIT para **MPL-2.0** e passa a aceitar MPL-2.0 em código copiado e dependências (seção 6.0). A v0.20 acrescenta as versões do app para **Android**, celular e tablet (seção 5.13, Fase 14): Capacitor sobre a web, acesso ao daemon pela VPN do usuário (seção 5.12) e, por consequência, a web deixa de ser opcional. A v0.21 fixa os **Executores padrão** de cada papel (seção 5.7): nome `<modelo>-<esforço>@<perfil>`, predefinições `roles.preset` aplicadas na primeira execução e revisão cruzada por provedor. A v0.22 define o **custo em moeda** e o **teto de gasto em API** (seção 5.6): cota e equivalente em API nas assinaturas, custo real nas contas de API, teto por dia e por mês no perfil e despertar agendado para retomar o trabalho quando a cota ou o teto voltam. A v0.23 resolve duas contradições sobre o **modelo local** (seções 5.7 e 5.9): ele pode ser Ator, limitado pelos slots da instância, com slots reservados ao Diretor, e o provedor de um Executor na revisão cruzada é a família do modelo, não o cliente. Os Executores do OpenCode entram por um assistente de cadastro com sugestões, e o daemon só valida. A abstração passa a ter dois eixos (seção 5.18): o **cliente** de agente (`ClientAdapter`, agora com o catálogo de modelos `ModelCatalog`) e o **servidor de modelo local** (nova porta `LocalModelServer`, com llama.cpp na v1 e Ollama depois). O nome do Executor passa a incluir o cliente, `<modelo>-<esforço>@<cliente>/<perfil>`, porque o OpenCode também pode chamar modelos do Claude e do GPT por API; com assinatura, cada família só roda pelo seu cliente oficial (`executors.cross_client: api_only`). A configuração dos papéis passa a ter override por papel em cada cenário e tarefa agendada, e não só a restrição de perfis por projeto. A primeira execução vira um `ot init` mínimo que abre a TUI num assistente de configuração cuja lógica fica no daemon. A v0.24 define a **capacidade mínima de cada papel** (seção 5.7): todos os papéis aceitam modelo local, e o que separa um Executor de um papel é a capacidade, igual para modelo local e na nuvem (janela de contexto, raciocínio nos papéis que decidem e uma sessão de teste no cadastro), com aviso em vez de bloqueio por padrão (`roles.capability_check: warn`). A v0.25 fixa o daemon como **serviço de logon** do usuário, sempre: o app desktop, se for feito, é só mais um cliente, como a TUI (item 6 da seção 12). A v0.26 faz das **perguntas ao Produtor listas de múltipla escolha** por padrão (seção 5.3, `chat.producer_questions: choices`), com a opção recomendada, que vale depois de um prazo sem resposta, menos nas decisões irreversíveis, em que a recomendada é sempre a segura; nas tarefas agendadas, o padrão passa a ser esperar um prazo e seguir com a recomendada (5.15). A v0.27 fecha os **campos próprios no ATIF** (seção 5.11): tudo o que é do OTheater fica num bloco `extra.otheater`, a unidade exportada é a peça inteira, com a trajetória do Diretor na raiz e cada tentativa como subtrajetória, `cost_usd` só leva custo real e o conteúdo sai completo, com os segredos mascarados. A v0.28 fecha os **ganchos de interceptação dos plugins** (seção 5.14, para depois da v1; item 15 da seção 12): quatro pontos (antes de lançar a tentativa, antes da ferramenta, antes de aceitar o `submit` e antes da entrega), prazo de 5 s e de 30 s na entrega, comportamento na falha declarado pelo plugin, com deixar passar como padrão, e sondas de cota e notificadores que podem vir de plugin. A v0.29 fixa a **ordem das interfaces depois da v1** (seção 5.13 e Fases 12 a 14; item 12 da seção 12): primeiro a Fase 10b, depois a web (Fase 12), o app desktop (Fase 13), que deixa de ser opcional, e o app Android (Fase 14); Electron ou Tauri é decidido ao abrir a Fase 13. A v0.30 decide as **várias contas do mesmo provedor** (seções 3 e 5.6; era a Q15 do docs/13): o OTheater as suporta como qualquer perfil, não as divulga, e cada usuário as usa por conta e risco. A v0.31 revisa o **fluxo da peça** (P13 e seção 5.4; item 25 da seção 12): cada papel ganha uma fronteira estreita, para o Ator só escrever o código de uma demanda pronta; o plano traz dúvidas e suposições, e as dúvidas vão ao Produtor antes do Revisor; o Autor revisa todo roteiro; cada demanda tem verificação em código ao fim da tentativa; todo laço tem contador, e esgotado vai ao Produtor com um menu fixo; numa crítica mista vence a falha mais grave; e um pedido de mudança depois da entrega abre uma peça nova, ligada à anterior. A v0.32 fecha a **revisão de consistência** dos documentos antes da Fase 0 (seções 5.3, 5.4, 5.16 e 5.20; item 26 da seção 12): o menu fixo de AWAITING_PRODUCER é um tipo próprio, vindo do código, e não segue o limite de 2 a 4 opções do `ask_producer`; a lista de pontos de julgamento do Diretor passa a incluir os casos da seção 5.16 e o rebase na integração; e o `task.define` segue as regras da peça, com as dúvidas do plano ao Produtor e a revisão dos passos pelo Autor; na revisão do roteiro, o Autor também veta dependência sem motivo, para não perder paralelismo. A v0.33 acrescenta o princípio **feito para evoluir** (P14, pedido do dono) e fecha três pontos da TUI (seção 5.13): a **caixa de texto do Produtor** se comporta como a dos agentes de código, e os atalhos do layout passam a Alt + letra livre (Alt+S, Alt+J, Alt+K, Alt+A, Alt+W; Ctrl+Shift+←/→ na largura); **copiar** usa a seleção nativa do terminal com Shift e uma seleção própria por OSC 52; e o **desempenho do Ink** vem da renderização imediata da tecla, da memoização, do limite do heap e de um patch travado na versão 8.0.0. A v0.34 dá ao **app desktop** o mesmo mapa de teclas e as mesmas capacidades do Claude Desktop, com a identidade do OTheater (seção 5.13, Fases 12 e 13; N39): o mapa vira dado no registro de interface, com presets por plataforma e superfície; entram os painéis de Mudanças, Arquivos e Terminal (este sob o lançador e a sandbox, `app.terminal: sandbox`), a tela dividida, o chat lateral, bifurcar, voltar e enfileirar mensagens, o ditado e o chat rápido global. A v0.35 tira do **navegador compartilhado** as restrições do navegador do Claude Desktop (seção 5.19; N40): por padrão, o agente usa os logins do Produtor por uma extensão no navegador do dia a dia dele (o Opera primeiro), abre qualquer domínio, `localhost` e `file://` (menos os caminhos de segredo) e clica e preenche sem pedir aprovação; cada restrição antiga continua como modo de uma chave `browser.*`. A v0.36 acrescenta o **Claudexor** (`razzant/claudexor`, MIT) como referência de desenho e fonte de trechos pequenos, com atribuição, nas áreas críticas (seções 6.3 e 6.4; N41): cotas, pool de contas e rotação, sonda de login, isolamento dos perfis, store, API do daemon e orçamento. Fica de fora todo código dele que lê token OAuth ou chama a API do fornecedor por fora do cliente oficial. A v0.37 registra a regra para o que o ACP não resolve (seção 3; N42): procurar uma alternativa entre os canais do próprio cliente oficial e adaptá-la, sem mudar a proibição de ler token. A v0.38 traz a integração de terminal do Claude Desktop (seção 5.13; N43): comando do Produtor pelo chat com `!`, na TUI desde a Fase 7, com a saída entrando na conversa; ferramentas de terminal para o Ator; e a saída ao vivo dos comandos do Ator, que o adaptador ACP do Claude já manda. A v0.39 cria os **comandos `/`** e a **sessão direta** (seções 5.13 e 5.20; N44). Os comandos `/` vêm de um registro só no daemon, servido a todas as interfaces desde a Fase 7. Os comandos do próprio cliente aparecem com prefixo e valem na sessão do Diretor parado e na sessão direta. A sessão direta é uma conversa do Produtor com a sessão de um Ator, fora de qualquer peça. A v0.40 corrige a licença do MCP SDK v2 na seção 6.1 (Apache-2.0, não MIT) e liga o entregável da Fase 0 ao [relatório dos spikes](../../spikes/RELATORIO-FASE-0.md). A v0.41 registra as decisões de licença da Fase 0 (N45, seção 6.0): os executores ficam no nível C, oito licenças permissivas passam a ser aceitas em dependências, as regras de `OR` e `AND` do SPDX, ferramentas GPL só em processo separado instalado pelo usuário, e uma exceção por pacote e versão para o AgentPrism. A v0.42 ajusta as **permissões do Claude pelo ACP** (seção 5.8) ao que a Fase 0 mediu: o `dontAsk` não chega pelo adaptador, e o Executor headless passa a negar pelo modo `default` com o cliente do OTheater recusando cada `request_permission`; o bypass é bloqueado por `allowDangerouslySkipPermissions: false`. A v0.43 registra, a pedido do dono, a **hierarquia de adaptadores** (seção 5.2, **[proposta]**): a `ClientAdapter` vira classe-base abstrata com tudo o que é comum aos clientes (abrir sessão, responder permissões, conferir garantias, sondar conformidade), um descendente por cliente traduz a política neutra do papel (`RolePolicy`) para as chaves dele, e o daemon recusa o papel quando nenhuma camada garante um campo da política. Na mesma versão, também a pedido do dono, cada descendente vira a **casca de agente** do seu cliente: normaliza a conversa (eventos, erros, cota, modos, transporte) e faz do ACP a língua única entre o daemon e o agente, rodando dentro do daemon; os recursos únicos de cada cliente também chegam como chamadas ACP (métodos de extensão `_otheater/...`), e suportar um agente novo é escrever uma casca nova. A v0.44, aprovada pelo dono, divide a **cota** (seção 5.6, **[proposta]**): a casca de cada cliente coleta os sinais (`_otheater/quota/signal` na sessão, a `QuotaProbe` fora dela), e um gerente único no daemon (`QuotaService`) guarda o estado por perfil, o custo e o teto de gasto e responde à seleção; um gateway de API fica para depois da v1 (`usage.api_gateway: off`). A v0.45, aprovada pelo dono, ajusta a **tradução da `RolePolicy`** e a camada 1 (seções 5.2 e 5.8) ao que o item 8 da Fase 0 mediu: no Claude, o `deny` por padrão é furado por `sh -c` e vira segunda camada; no Codex, o daemon veta os modos `agent` e `agent-full-access`, que não saem do catálogo e não mandam os pedidos de permissão ao cliente; no OpenCode, as permissões são fixadas por `OPENCODE_PERMISSION`, com o `opencode.json` da worktree ignorado; e cancelar uma sessão passa a encerrar a árvore de processos do cliente. Na mesma versão, também por decisão do dono, o Claude roda com `settingSources: []` por padrão (chave `setting_sources`), e dois trechos de atalhos foram corrigidos (5.13 e 10). A v0.46 só acrescenta dados medidos no item 8d da Fase 0 (5.2 e 5.8), sem decisão nova: mais embrulhos furam o `deny` do Claude, o `claude` fica órfão quando o adaptador morre por SIGKILL, o Codex só lê o `requirements.toml` em `/etc`, e o OpenCode aceita regras por padrão de comando. A v0.47 também só acrescenta dados da Fase 0 (5.11 e a tabela de referências), sem decisão nova: o OTel do Codex no `codex-acp` só liga na partida do `app-server`, cada sessão sem título gera uma thread extra no Codex, o OpenCode só exporta tokens com uma chave experimental que vaza conteúdo, e a árvore do Nimbalyst foi medida. A v0.48 fecha a Fase 0 com portões (N48): o critério de aceite não foi cumprido, e cada item aberto passa a ser condição da fase que precisa dele (seção 10); a confirmação da Anthropic sobre o R1 vira portão da Fase 10 (seção 11). A v0.49 registra as quatro escolhas que a arquitetura deixava para a Fase 1 (N49): os dois drivers do SQLite pela chave `store.driver`, o i18next, o dependency-cruiser e a CI no GitHub Actions. A v0.50 registra as propostas aceitas dos passos 2 a 6 da Fase 1 (N50, N51 e N52), a retenção do backup em 2 dias, as medições do passo 7 (custo do `synchronous=FULL` e métodos de backup, seção 5.21), a escolha do dono do método de backup (N53), a telemetria numa base SQLite própria, separada do store (N54, seção 5.11), a análise do sistema registrada como pergunta aberta da Fase 8 (N55, seção 12) e o fechamento da Fase 1 (seção 10). A v0.52 troca o crate `win32job` pelo `windows-sys` no lançador com Job Object (N60, seção 5.9) e registra o portão do item 13 fechado pela CI Windows (N58). A v0.53 registra as propostas aceitas das ondas 3 e 4 da Fase 2 (N61 e N62): adaptadores dos três clientes, execução no daemon, várias sessões por processo e clientes reais no compose. Ela também abre a medição da versão do cliente como pergunta (N63, seção 12, item 28). A v0.54 decide o cancelamento de uma sessão num processo compartilhado (N64, seção 5.2): chave `pool.shared_cancel`, com padrão `escalate`. A v0.55 isenta da trava de garantias a sessão que só lê o catálogo de modelos (N65, seção 5.2), pela chave `security.catalog_probe`, e põe um teto nas retomadas que não contam em `max_resumes` (N66, seção 5.16), pela chave `resume.max_free_resumes`. A v0.56 guarda esse contador no registro de tentativas (N67, seção 5.16), põe o propósito da sessão na porta `ClientAdapter` (N68, seções 5.2 e 5.18) e registra o aviso da isenção uma vez por cliente (N69, seção 5.2), pela chave `security.catalog_probe_log`. A v0.57 deixa a telemetria sair da máquina, quando configurada, para um serviço como o Grafana: OTLP para um coletor e `/metrics` no formato Prometheus, pela chave `telemetry.export`, desligada por padrão (N70, seções 5.11, 5.12, 5.18 e Fase 8). A v0.58 marca a troca da base aceita no P7b como o passo P13 da Fase 2 (N61, seção 5.2), lê a versão do cliente no `package.json` do pacote instalado e a confirma pelo `initialize`, sem executar o binário (N63, seções 5.2 e 5.18), traz o adaptador `ollama` para a Fase 2 e deixa o LM Studio para depois da v1 (N71, seções 5.9 e 5.18) e gera os avisos de terceiros por plataforma no instalador (N72, seção 6.0 e Fase 10). Ainda na v0.58, a pedido do dono, o OTheater ganha a atualização automática (N73, seções 5.1 e 5.21 e Fases 10 e 13): por padrão, baixa em segundo plano, confere a assinatura e aplica quando o daemon fica ocioso, pela chave `updates.mode`, com origem conforme a instalação, canais `stable` e `beta`, volta automática e backup antes das migrações. A v0.59 dá a cada cliente a sua chave de `K` (N74, seção 5.2 e Fase 2): `pool.<cliente>.sessions_per_process`, que herda a global `pool.sessions_per_process`; o padrão de cada cliente sai da medição dos três clientes pelo pool do daemon, com 1, 2, 4 e 6 sessões, ociosas e com prompts. A v0.60 registra os padrões decididos depois da medição real (N74, seção 5.2 e Fase 2): `K` = 6 no Codex, `K` = 4 no OpenCode e, no Claude Code, a herança da global, sem efeito no `process-per-session`. A v0.61 fecha a Fase 2 com portões (N75, Fase 2), fixa as dependências da Fase 3 com versões e licenças (N76, seção 6.1) e liga a Fase 3 ao [plano de passos](../14-PLANO-DA-FASE-3.md), com o marco interno 3a (N77). Ela também troca a conversa do MVP pelo `ot chat` no terminal, com o Diretor aberto pelo daemon (N78), e cria `limits.submit_retries`, com padrão 2 (N79). A v0.62 cria `events.unknown_type: reject | warn`, com padrão `reject`, para o evento que o registro não aceita (N80, seção 5.18). A v0.63 cria `mcp.port: auto | <número>`, com padrão `auto`, para a porta do servidor MCP do framework (N81, seção 5.3). A v0.64 fecha três lacunas dos conflitos de merge (N82 a N84, seções 5.4 e 5.5): o conflito no rebase das dependentes faz o daemon refazer a dependente (`integration.rebase_conflict`, padrão `redo`); a base que mudou durante a peça é mesclada na integração antes da entrega, e o conflito vira falha de roteiro (`delivery.base_drift`, padrão `update`); e, no roteiro novo depois de um conflito, as demandas que não mudaram continuam aprovadas (`rescript.reuse`, padrão `keep_unchanged`). A v0.65 dá ao Diretor `read_attachment` só para anexos de texto e PDF convertido em texto (N85, seções 5.3 e 5.20): a imagem continua indo ao consultor que aceita imagem, pelo `consult`. A v0.66 decide como a Fase 3 fecha (N86 a N88, Fase 3): três partes que ficaram sem ligação no código entram num passo próprio antes do aceite (a dependência refeita, quem está olhando a peça e o aviso no chat depois da reconciliação); a peça real do aceite roda num repositório git local, com todos os papéis no `claude-agent-acp` com o Haiku e a entrega no `CodeHost` falso; e a fase só fecha depois que o dono rodar a peça real e ela passar. A v0.67 registra duas decisões do P15 (N89 e N90, seções 5.5 e 5.21): com alguém olhando, o `delivery.mode: ask` fica para a Fase 4 e, até lá, vira `pr`; e o aviso da reconciliação vai ao chat de cada cenário afetado uma vez, em memória, no próximo poll, com o evento `scenario.system_message` como registro e a chave `recovery.notice: always | unclean_only | off`, padrão `always`. A v0.68 acrescenta a **fila de ideias** do cenário (N91, seção 5.20, Fase 4): o Produtor joga ideias, prompts ou textos de especificação, sem abrir peça; o Autor lê a fila, junta as que fazem sentido num grupo e o grupo vira a necessidade de uma peça, até a fila esvaziar, com `ideas.drain` (padrão `auto`) e `ideas.grouping_approval` (padrão `ask`); a caixa de entrada global fica para uma fase futura. A v0.69 registra o **fechamento da Fase 3** (N88): o nível `play` do aceite real passou em 2026-11-17, na terceira rodada, depois de duas correções (as ferramentas MCP do papel liberadas no Claude Code e os esquemas reais das ferramentas de etapa). A v0.70 desenha a **importação das demandas do `okit`** (N92, seção 5.20): as demandas não feitas da caixa de cada projeto do kit entram na fila de ideias do cenário do mesmo repositório, com a fila pausada até o Produtor confirmar; fica para depois que o OTheater estiver funcionando, com a ferramenta de importação da Q12. A v0.71 registra o **plano da Fase 4** (N93 a N96, seção 10): os passos em [docs/15](../15-PLANO-DA-FASE-4.md), com o marco interno 4a; os downloads do `sandbox-runtime` 0.0.81 e do `playwright-core` 1.64.1; a camada 3 do Windows como portão; e a sandbox e o navegador testados na CI. Na mesma versão, o dono fixou os padrões dos passos da primeira onda (N97 a N100): a lista curada do `restricted_shell`, os limites das cascas (10 min, 64 KiB e um comando pesado por vez), o override da política do papel que só abre o que é seguro e o changelog sempre mantido na entrega (`delivery.changelog: always`). A v0.72, a pedido do dono, acrescenta às estimativas da seção 10 o **ritmo medido** nas Fases 1 a 3: o que estava estimado em semanas com agentes foi feito em horas, e cada fase restante ganha a estimativa nesse ritmo, em horas de trabalho, ao lado das estimativas antigas. A v0.73 registra as **decisões dos passos P1, P2, P3, P4, P7 e P8 da Fase 4** (N101 a N113, seções 5.2, 5.8, 5.18, 5.19 e 5.20): o papel Ator ganha as cascas por padrão (`roles.actor.policy.native_shell: shells`), a porta `ClientAdapter` vai para a 0.3.0 com a `RolePolicy` v2 (`nativeShell`, `mcpTools` por servidor, `onAsk`), a política e as regras da camada 2 saem do código para `roles.<papel>.policy` com as camadas padrão < configuração < cenário de origem < cenário, a sandbox vira `sandbox.mode: runtime` com `security.unenforced: refuse` onde não há adaptador, os caminhos de segredo viram uma lista só, `security.secret_paths`, com `browser.secret_paths` como apelido, e a fila de ideias para e avisa o Produtor quando não pode seguir.
> A v0.2 incorporou uma pesquisa de código reaproveitável (seção 6) e uma revisão do desenho (seção 15). A v0.3 criou a política de licenças; a v0.4 passa a aceitar Apache-2.0 e as demais licenças permissivas (seção 6.0). Os itens marcados **[a confirmar]** vieram de fontes secundárias ou não puderam ser verificados na fonte e entram na Fase 0.

---

## 1. Objetivo

**Nome:** **OTheater**, abreviação de *Orchestration Theater*: a orquestração de agentes encenada como teatro, como no pipeline de `framework_multiagentes.md`. Grafia fixa em inglês americano (*Theater*, não *Theatre*). Detalhes de pacote, comando e repositório na seção 9.

O OTheater é um sistema de agentes de código que:

1. executa o pipeline teatral (Produtor → Autor → Revisor → Roteirista → Diretor/Atores → Crítico → decisão) de forma **consistente e determinística**;
2. usa de forma **transparente** Claude Code, Codex e OpenCode (e, por eles, Anthropic, OpenAI, MiniMax, modelos locais e qualquer provedor por API);
3. suporta **assinaturas (token plan) e API**, com várias contas por cliente, adicionáveis e removíveis;
4. oferece **chat com o Orquestrador**, dashboard por cenário, página de configuração, plugins e acompanhamento em tempo real (consumo, telemetria, trajetórias) por uma API;
5. custa o mínimo para construir: **não reescrevemos agentes nem infraestrutura que já existe**; o código próprio fica concentrado no que é diferencial (pipeline, seleção por cota, política de permissões).

## 2. Princípios de projeto

| # | Princípio | Consequência |
|---|---|---|
| P1 | Reutilizar os CLIs oficiais como Executores | O loop de ferramentas, a edição de arquivos e o login de assinatura vêm prontos |
| P2 | Reutilizar bibliotecas antes de escrever | Adaptadores ACP, SDK do MCP, máquina de estados, componentes de UI e telemetria vêm de projetos existentes (seção 6) |
| P3 | Fluxo em código, julgamento no modelo | O pipeline é uma máquina de estados; o modelo só decide em pontos estreitos, com saída validada por schema |
| P4 | Estado fora do modelo | Tudo persiste no daemon; o Orquestrador consulta `next_action` e sobrevive a compressão de contexto ou reinício |
| P5 | Bloquear tudo, liberar o necessário | Permissões por lista de permitidos, por papel, em três camadas; a configuração do cliente é política, não fronteira de segurança |
| P6 | Tudo é evento | Um único log de eventos alimenta dashboard, SSE, OTel, ATIF e auditoria |
| P7 | Daemon separado da interface | Fechar a UI não interrompe as peças; várias UIs (TUI, web, desktop, Android) sobre a mesma API |
| P8 | Contexto mínimo por Executor | O Ator nasce com demanda + contrato; artefatos circulam por referência |
| P9 | Recursos sob controle de admissão | O paralelismo é limitado por RAM, cota e pool, não só pelo que o Roteirista permite |
| P10 | Versões fixadas | ACP, adaptadores e CLIs mudam toda semana: tudo fixado, atualizado de propósito, com testes de contrato |
| P11 | Licenças permissivas e MPL-2.0 | Código próprio em MPL-2.0; código copiado e dependências empacotadas em MIT, Apache-2.0, ISC, BSD ou MPL-2.0; GPL, AGPL e LGPL proibidas (seção 6.0) |
| P13 | Papéis com fronteira estreita e esforço antes da execução | Autor e Revisor fecham o plano, o Roteirista entrega demandas prontas, e o Ator só escreve o código que atende uma demanda; corrigir antes de executar é barato, e cada rodada do Crítico é cara (seção 5.4, v0.31) |
| P12 | Contratos antes de implementações | Toda fronteira com o mundo de fora e todo ponto que varia por cliente, provedor ou sistema é uma **porta** (interface TypeScript + schema zod) em `@otheater/core`; as implementações são **adaptadores** trocáveis, montados num único ponto; fluxos, papéis, ferramentas e chaves de `rule` ficam em **registros** tipados (seção 5.18) |
| P14 | Feito para evoluir (decisão do dono, 2026-11-15, N38) | A interface e toda a implementação são desenhadas para simplificar upgrades e features futuras: dependências e frameworks ficam atrás de portas e camadas finas (P12), a TUI só desenha sobre o `packages/client`, abas, comandos e teclas entram por registro, versões são fixadas e atualizadas de propósito (P10), e qualquer patch em código de terceiros fica isolado, travado na versão e com volta ao original quando a versão muda |

## 3. Premissas e restrições

- **Assinatura só pelo cliente oficial, sem tocar no token.** O framework nunca lê, copia nem reaproveita tokens OAuth. Ele dispara o login oficial num diretório de perfil isolado e executa o CLI oficial.
- **Termos da Anthropic** (documentação de legal e conformidade do Claude Code):
  - o login OAuth é para o "uso comum do Claude Code e de outros aplicativos nativos da Anthropic";
  - quem desenvolve **produtos**, inclusive com o Agent SDK, precisa usar **chave de API**: não pode oferecer login do Claude.ai, encaminhar requisições pelas credenciais de assinatura em nome de usuários, nem coletar ou intermediar esses tokens;
  - é permitido que um usuário final entre com a própria assinatura no **binário do Claude Code sem modificação**.

  **Consequência:**
  - **uso pessoal** (cada pessoa roda o daemon com os próprios logins, que acionam o CLI oficial) se encaixa na permissão;
  - **distribuir como produto** para terceiros com assinatura Claude exige confirmação com a Anthropic. Até lá, o modo produto usa chave de API para Claude. Ver o risco R1 na seção 11.
- **OpenAI:** a documentação recomenda chave de API para automação e pede tratar `auth.json` como senha. O uso do login ChatGPT em ferramentas de terceiros tem relatos de ser permitido por parceria **[a confirmar]**.
- **Várias contas pessoais do mesmo provedor** (decidido em 2026-11-14, v0.30; era a Q15 do docs/13): o OTheater **suporta**, porque cada conta é só mais um perfil (5.6), mas **não divulga** o recurso, e cada usuário o usa **por conta e risco**. O projeto não afirma que isso é permitido pelos termos de nenhum provedor; quem usa confere os termos do seu. Planos de time/empresa com vários assentos continuam sendo o caminho limpo.
- **ACP (Agent Client Protocol)** é o protocolo entre o daemon e os Executores. **MCP** é o protocolo das ferramentas do framework e dos plugins.
- **O que o ACP não resolve** (decidido em 2026-11-15; N42): o ACP continua o caminho principal. Quando uma necessidade não tem solução por ele, procuramos uma alternativa e a adaptamos. Valem só os canais do próprio cliente oficial: statusline, `app-server`, `stream-json`, hooks, arquivos que o cliente grava, OTel e comandos do CLI. Continua proibido ler o token ou chamar a API do provedor por fora do cliente oficial (primeiro item desta seção). Já seguem essa regra a sonda de cota por statusline do Claude e o `account/rateLimits/read` do Codex (5.6). **[proposta]:** cada alternativa entra atrás de uma porta (5.18), com o registro do que o ACP não entrega e de como isso foi medido ou lido na fonte.
- **Windows primeiro**, sem impedir macOS/Linux. O que é específico do sistema operacional fica atrás de portas (5.18), com adaptadores por sistema (`platform-windows`, `platform-posix`).
- **Segredos:** chaves de API ficam no cofre do sistema operacional; nunca em arquivo de configuração, log ou evento.
- **Operação local por padrão:** o daemon escuta em `127.0.0.1`; acesso remoto exige token + TLS. O app Android chega ao daemon pela VPN do usuário (5.12).

## 4. Visão geral

```
┌── Interfaces: TUI Ink (principal) · web, desktop e Android (pós-v1) ─────────────────┐
│ Lateral: Assinaturas · Projetos · Tarefas · Chats · Plugins · Configuração           │
│ Por cenário: [Chat com o Orquestrador]  [Dashboard]  [Trajetórias]                    │
└──────────┬────────────────────────────────────────────────────────────┬──────────────┘
           │ REST + WebSocket (chat)                                    │ SSE (eventos)
           ▼                                                            │
┌──────────────────────────────── Daemon (Node + TypeScript) ──────────────────────────┐
│  api/        REST · SSE · WS · autenticação                    (Hono)                │
│  pipeline/   máquina de estados da peça · DAG de demandas      (XState v5)           │
│  selection/  seleção de Executor (prioridade × disponibilidade)                      │
│  accounts/   perfis · cofre · sondas de cota                   (@napi-rs/keyring)    │
│  executors/  cliente ACP · pools · adaptadores                 (@agentclientprotocol)│
│  mcp/        servidor MCP do framework (filtro por papel)      (MCP SDK v2)          │
│  plugins/    agregador de servidores MCP de plugins                                  │
│  tools/      cascas: run_tests, git_*, http_get, shell restrito                      │
│  resources/  semáforos · lançador com Job Object               (launcher Rust)       │
│  workspace/  worktrees · branches · integração · PR            (git + gh)            │
│  store/      SQLite (WAL): eventos, estado, blackboard         (better-sqlite3)      │
│  telemetry/  receptor OTLP · export ATIF                       (OpenTelemetry JS)    │
└──────────┬───────────────────────────────────────┬───────────────────────────────────┘
           │ ACP (sessão do Orquestrador)          │ ACP (pools por perfil)
           ▼                                       ▼
   Orquestrador (Diretor)                  Autor · Revisor · Roteirista · Atores · Crítico
   claude-agent-acp + Haiku,               claude-agent-acp · codex-acp ·
   opencode acp + Gemma 4 local            opencode acp · gemini --acp
           │                                       │
           └──── MCP do framework (HTTP) ──────────┘  + plugins MCP do papel (HTTP)
```

**Portas e adaptadores (5.18):** cada módulo acima depende só das portas de `@otheater/core`. As bibliotecas entre parênteses são os **adaptadores padrão**, montados no ponto de montagem do daemon e trocáveis pela configuração.

**ACP em dois níveis:** o daemon é cliente ACP da sessão do Orquestrador (com quem você conversa pelo chat) e também de todos os Executores. O Orquestrador **não** abre Executores: ele chama ferramentas MCP do framework, e é o daemon que abre as sessões.

## 5. Componentes

### 5.1 Daemon

- Processo Node de longa duração, sempre iniciado como serviço de logon do usuário (decidido em 2026-11-14, v0.25, item 6 da seção 12). Nenhuma interface hospeda o daemon: a TUI, a web, o app desktop e o app Android só se conectam a ele.
- Um único daemon por usuário/máquina, garantido por um lock exclusivo do SQLite no arquivo `daemon.lock`, que o sistema solta mesmo depois de um `kill -9` **[V]** (teste do passo 5 da Fase 1). O pid, o instante de início e a versão ficam num `daemon.lock.json` ao lado (2026-11-16, N52).
- **Pasta de dados** (N52): no Linux, `$XDG_DATA_HOME/otheater` ou `~/.local/share/otheater` (um `XDG_DATA_HOME` vazio ou relativo é ignorado); no macOS, `~/Library/Application Support/OTheater`; no Windows, `%LOCALAPPDATA%\OTheater`. `--data-dir` ou `OT_DATA_DIR` trocam a pasta. Ela é criada com permissão 0700; uma pasta que já existe não recebe `chmod`. O cofre em arquivo padrão fica em `<data>/vault.enc`.
- **Senha mestra do cofre em arquivo** (N52): só é pedida quando a entrada é um terminal (TTY), e nunca vem de variável de ambiente nem de argumento. São 3 tentativas; depois, `PermissionDenied`, e o daemon não sobe. Sem terminal, ou com resposta vazia, o daemon sobe com o cofre trancado, avisa, e quem usar o cofre recebe `VaultLocked`. Ctrl+C no prompt interrompe a subida.
- **Log** (N52): pino, em `<data>/logs/daemon.log` (0600), síncrono e ainda sem rotação. Destinos: `file`, `stderr` ou `both`.
- **CLI** (N52): `ot daemon`, `ot backup` e `ot restore` desde a Fase 1, com saída 0 (ok), 1 (falha) e 2 (uso inválido).
- **Atualização automática** (N73): o daemon se atualiza sozinho, sem interromper peça, tarefa nem chat. O desenho está na seção 5.21, em "Atualização automática", e a entrega na Fase 10.
- Responsável pelo estado global, pelo ciclo de vida dos Executores, pela execução das ferramentas homologadas e pela API das interfaces.
- **Recuperação ao reiniciar:** a reconciliação da seção 5.21, que roda antes de retomar qualquer coisa:
  - integridade do store;
  - processos órfãos;
  - sessões em curso marcadas como `interrupted`;
  - commit do que ficou sem commit nas worktrees;
  - efeitos colaterais ambíguos;
  - reidratação das máquinas XState;
  - agenda e ordens.

  Desde a v0.15, ela substitui os quatro passos que esta lista tinha.

### 5.2 Camada de Executores

**Executor = cliente + perfil de assinatura + modelo + esforço.**

**Cliente ACP:** `@agentclientprotocol/sdk` (v2, modelo `client()` + `connectWith`; a v2.0 removeu `ClientSideConnection`, então tutoriais antigos não valem). O daemon sobe o processo do adaptador e entrega o stream ao SDK.

Métodos usados:
- `initialize` (lê as capacidades, ex.: `mcpCapabilities.http`);
- `session/new` com `cwd` = worktree e `mcpServers` em HTTP;
- `session/prompt` e `session/update` (stream);
- `session/request_permission`;
- `session/cancel`;
- `session/load`, onde houver.

**Modelo, esforço e modo por sessão** pelas **Session Config Options** do ACP: `session/set_config_option` com as categorias `model`, `thought_level`, `mode` e `model_config`. O adaptador anuncia quais opções aceita, e a página de configuração usa essa lista. Isso substitui a tradução manual de esforço por cliente da v0.1. Fica um fallback por adaptador para o que não for exposto.

**Adaptadores prontos** (não os escrevemos):

| Cliente | Pacote / comando | Observações |
|---|---|---|
| Claude Code | `@agentclientprotocol/claude-agent-acp` (TS, Apache-2.0) | Um processo com várias sessões, mas **cada sessão sobe um processo `claude`**. Anuncia MCP HTTP e `loadSession`. Modelo e esforço são config options. |
| Codex | `@agentclientprotocol/codex-acp` (TS, Apache-2.0, mantido pela JetBrains) | Inclui `@openai/codex` e conversa com o `codex app-server`. Modelo, esforço, aprovação e sandbox selecionáveis. Várias sessões por processo **[a confirmar]**. |
| OpenCode | `opencode acp` (nativo) | Concorrência e config options **[a confirmar]**. A API V1→V2 do OpenCode mudou; fixar a versão. |
| Gemini CLI | `gemini --acp` (nativo) | Opcional. O ACP lá ainda é parcialmente `unstable`. |

**Hierarquia de adaptadores** (v0.43, a pedido do dono; antes era uma `interface` com os mesmos membros, v0.23) **[proposta]**. Ela cobre só o que o ACP não cobre. A `ClientAdapter` é uma **classe-base abstrata** com tudo o que é igual para todos os clientes. Abaixo dela fica um **descendente por cliente**, que implementa só o que é específico daquele cliente:

```
ClientAdapter (abstrata, @otheater/core)
├── ClaudeCodeAdapter   (@otheater/adapter-client-claude-code)
├── CodexAdapter        (@otheater/adapter-client-codex)
├── OpenCodeAdapter     (@otheater/adapter-client-opencode)
└── GeminiAdapter       (@otheater/adapter-client-gemini, opcional)
```

```ts
abstract class ClientAdapter {
  abstract readonly id: 'claude-code' | 'codex' | 'opencode' | 'gemini' | string;
  abstract readonly processModel: 'process-per-session' | 'multi-session'; // medido na Fase 0
  abstract readonly quota: QuotaProbe;                                   // seção 5.6
  abstract readonly models: ModelCatalog;                                // catálogo e validação dos modelos (5.7), v0.23

  // ---- comum, implementado uma vez na base ----
  /** Abre a conversa e devolve uma AgentSession normalizada (a casca de agente, ver abaixo).
   *  Sobe o processo pelo lançador (5.9), escolhe o transporte (AcpTransport por padrão, HeadlessTransport
   *  na saída de emergência; objetos à parte, por composição), aplica sessionSetup(), liga o respondedor
   *  de permissões (camada 2 da 5.8) e passa cada evento e erro pelos normalizadores do descendente. */
  openSession(profile: Profile, policy: RolePolicy, cwd: string, via: SessionTransport): Promise<AgentSession>;
  /** Camada 2: resposta a session/request_permission pela política, igual para todos os clientes. */
  protected answerPermission(req: PermissionRequest, policy: RolePolicy): PermissionAnswer;
  /** Junta enforcement() do descendente com a camada 3 disponível na máquina; aponta o campo com menos camadas que o exigido. */
  guarantee(policy: RolePolicy, os: SandboxCapabilities): GuaranteeReport;
  /** Sondas de conformidade de segurança (ver "Sondas" abaixo), com cache por versão do adaptador. */
  checkConformance(profile: Profile): Promise<ConformanceReport>;

  // ---- específico, cada descendente implementa ----
  protected abstract command(profile: Profile): { cmd: string; args: string[] };   // ex.: npx claude-agent-acp
  protected abstract profileEnv(profile: Profile): Record<string, string>;         // CLAUDE_CONFIG_DIR, CODEX_HOME...
  /** Camada 1 em arquivo: grava settings/config do perfil (permissões, statusline, OTel). */
  protected abstract prepareProfile(profile: Profile, policy: RolePolicy): Promise<void>;
  /** Camada 1 por sessão, para o transporte pedido. ACP: o que vai no session/new e nos config options
   *  (no Claude, _meta.claudeCode.options e o modo). Headless: flags e ambiente (no Claude, --tools, --strict-mcp-config...). */
  protected abstract sessionSetup(policy: RolePolicy, via: SessionTransport): SessionSetup;
  /** O que o cliente garante sozinho para cada campo da política, no transporte pedido. */
  protected abstract enforcement(policy: RolePolicy, via: SessionTransport): Enforcement;
  /** Casca de agente: converte o que o cliente manda no formato normalizado do OTheater. */
  protected abstract normalizeUpdate(raw: RawUpdate, via: SessionTransport): NormalizedUpdate | null; // tool_call, consumo, rate limit
  protected abstract normalizeError(raw: unknown, via: SessionTransport): NormalizedError;            // cota esgotada (N42), login, travamento
  protected abstract mapConfig(want: ExecutorConfig): Record<string, string>;                         // modelo e esforço nos ids do cliente
  /** O que só este cliente oferece, anunciado no initialize e exposto como métodos de extensão ACP. */
  abstract readonly capabilities: ClientCapabilities;
  protected abstract extensions(): AcpExtensionHandler[];                                             // atende os _otheater/<recurso>                                                 // ex.: comandos / do Claude, sandbox do Codex
  /** Sondas próprias do cliente, além das comuns. */
  protected abstract probes(): ConformanceProbe[];
  abstract login(profile: Profile): Promise<LoginFlow>;                             // login oficial no diretório do perfil
  abstract logout(profile: Profile): Promise<void>;
}

/** Política do papel, neutra: não cita chave de nenhum cliente. Versão 2 (porta 0.3.0, v0.73, N102). */
interface RolePolicy {
  nativeTools: Array<'read' | 'search' | 'edit' | 'write'>;  // ferramentas nativas que existem; o resto é removido
  nativeShell: 'none' | 'shells';                            // 'shells' libera só as cascas do daemon (5.8); o shell do cliente nunca é um valor (N99)
  mcpServers: string[];                                      // só os MCPs do papel (estrito)
  mcpTools: Record<string, string[] | 'all'>;                // as ferramentas do papel por servidor MCP; servidor sem entrada = nenhuma (v0.73, N102)
  onAsk: 'reject' | 'rules';                                 // 'reject' recusa todo pedido; 'rules' consulta roles.<papel>.policy.rules, e o que não casa é recusado (N109)
  rules?: PermissionRule[];                                  // regras de liberação da camada 2; não é campo da garantia
  bypass: 'forbidden';
  writeScope: 'worktree';
  network: { allow: string[] };                              // domínios; garantido pela camada 3
}

type SessionTransport = 'acp' | 'headless' | string;         // AcpTransport, HeadlessTransport ou o de um agente sem ACP (SDK, API)
type SessionSetup =
  | { via: 'acp'; meta?: unknown; configOptions: Record<string, string> }
  | { via: 'headless'; args: string[]; env: Record<string, string> };

type Guarantee = 'client' | 'daemon' | 'os';
/** Lista de camadas por campo; lista vazia = campo sem garantia.
 *  Ex.: Claude no Linux: nativeShell → ['client', 'os']; Claude no Windows: ['client']; Codex: ['os'];
 *  Codex: bypass → ['daemon'] (o daemon nunca pede os modos agent e agent-full-access, v0.45). */
type Enforcement = Record<keyof RolePolicy, Guarantee[]>;

interface ModelCatalog {
  discovery: 'automatic' | 'assisted';                                 // Claude Code e Codex: automatic; OpenCode: assisted
  list(profile: Profile): Promise<ModelInfo[]>;                         // OpenCode: opencode models --verbose
  suggest(model: ModelInfo): Partial<ExecutorDraft>;                   // esforço, provider (família), local, custo
  validate(executor: Executor): Promise<ValidationResult>;             // existe, esforço aceito, toolcall
}
```

A forma acima é **[proposta]** (v0.23 a interface, v0.43 a hierarquia); a forma final sai da Fase 1. Por que classe-base e não só interface: o que hoje se repetiria em cada adaptador (lançar, abrir a sessão, responder permissões, conferir garantias, rodar as sondas) fica num lugar só, e um cliente novo escreve só a tradução dele. As portas `QuotaProbe` e `ModelCatalog` e os transportes (`AcpTransport`, `HeadlessTransport`) continuam objetos à parte, usados pela classe (composição), para poderem ser trocados sem herdar. A `AgentSession` é o que a classe devolve.

Regras da hierarquia, para a base não virar o lugar onde tudo se acumula:
- **um nível só**: a base e os descendentes concretos, sem classe intermediária nem netos;
- a base orquestra e os descendentes só implementam os métodos abstratos. Os métodos comuns (`openSession`, `answerPermission`, `guarantee`, `checkConformance`) não são sobrescritos. O TypeScript não tem `final`, então a regra é conferida por lint;
- se um cliente precisar de um comportamento comum diferente, essa variação vira um objeto à parte, passado à base (composição), em vez de uma sobrescrita.

**Estado na Fase 2 (v0.53).** A base já abre várias sessões por processo (`sessionsPerProcess`, padrão 4, e `processReuse: shared | own`), e o `AcpTransport` multiplexa uma conexão por processo (`connectionLifetime`), pela N62. O cancelamento nesse processo segue a chave `pool.shared_cancel` (N64), as irmãs derrubadas pela escalada têm o teto `resume.max_free_resumes` (N66), e o pool do daemon separa os processos pela chave canônica do `launchSpec`. Duas mudanças desta seção foram aceitas para um passo próprio (N61, P7b), que é o P13 da Fase 2 (v0.58): um gancho de veto de modo na base, no lugar do transporte de guarda do Codex, e o `via` como parâmetro de `command(profile)`. Até o P13, a assinatura acima continua valendo.

**Tradução da `RolePolicy`** (o que cada descendente faz; fatos de cada cliente na seção 5.8):

| Campo | `ClaudeCodeAdapter` | `OpenCodeAdapter` | `CodexAdapter` |
|---|---|---|---|
| `nativeTools`, `nativeShell: none` (e `shells`, em que o Bash do cliente continua removido e só as cascas do daemon entram, como MCP) | `tools` sem Bash (principal), mais `disallowedTools`; `deny` só como segunda camada, porque `sh -c`, `bash -c`, `find -exec`, `eval`, `$(...)` e `python3 -c` com `os.system` furam o padrão (v0.45; item 8d) | `deny` para o shell em `OPENCODE_PERMISSION`, que retira a ferramenta | sem como remover o shell: garantia `os` (sandbox); o `sandbox-srt` declara `nativeTools` e `nativeShell` entre os campos que cobre, e sem sandbox o campo fica sem camada e `unenforced: refuse` recusa (N128) |
| `mcpServers`, `mcpTools` | `strictMcpConfig`, mais `settingSources: []`, que corta plugins, skills e MCPs do perfil do usuário (v0.45); o `allowedTools` lista só as ferramentas MCP do papel (v0.73) | config do perfil; o `OPENCODE_PERMISSION` lista as ferramentas MCP do papel por nome, no lugar de `<servidor>_*` (v0.73) | habilitação por servidor MCP; o Codex pede `session/request_permission` para toda chamada MCP (`kind: execute`, com o título e o `rawInput` só no `tool_call` anterior, de mesmo `toolCallId`) **[V: spike s1b, `codex-acp` 2.6.0, e rodada real de 2026-11-17]**, e a camada 2 libera a ferramenta que o papel lista com `allow_once`, nunca `allow_always` **[proposta]**; que uma sessão real entregue a chamada por essa resposta está **[N]** (v0.73) |
| `onAsk: reject` (e `rules`, que só muda a resposta da camada 2 na base) | modo `default` + camada 2 | `ask` + camada 2 | `approval_policy` + camada 2, só nos modos `workspace-write` e `read-only`; no modo `agent` o pedido não chega ao cliente (v0.45) |
| `bypass: forbidden` | `allowDangerouslySkipPermissions: false` | não há bypass pelo ACP (o `--auto` é só do `opencode run`); `OPENCODE_PERMISSION` fixado e `OPENCODE_DISABLE_PROJECT_CONFIG=1` (v0.45) | garantia `daemon`: modo inicial `workspace-write` e veto do daemon ao `set_config_option` para `agent` e `agent-full-access`, que não saem do catálogo (v0.45) |
| `writeScope`, `network` | camada 3 | `external_directory` negado + camada 3 | sandbox do Codex + camada 3 (o sandbox deixa `/tmp` gravável) |

**Garantia por campo.** Antes de abrir a sessão, `guarantee()` junta, para cada campo da política, as camadas que o garantem: as do cliente (`enforcement()`), a do daemon e a do sistema operacional disponível na máquina. Se algum campo ficar com menos camadas que `security.min_layers`, vale `security.unenforced`. A garantia `daemon` conta para `onAsk` (camada 2) e para `bypass` quando o modo só muda por pedido do próprio daemon, como no Codex (v0.45). Ela não conta para os outros campos: recusar um pedido não impede uma ferramenta que nunca pede.

```yaml
security:
  min_layers:               # camadas exigidas por campo da RolePolicy
    default: 1              # <número>; ex.: nativeShell: 2 exige cliente e sistema operacional (no Windows sem sandbox, recusa o Claude)
  unenforced: refuse        # refuse (não abre a sessão do papel) | warn (abre e registra evento) | allow
  catalog_probe: allow      # allow (a sessão que só lê o catálogo de modelos passa pela trava acima) | refuse (v0.55, N65)
  catalog_probe_log: once   # once (grava o aviso da isenção uma vez por cliente e versão do adaptador, a cada execução do daemon) | every | off (v0.56, N69)
  conformance: on_version_change   # on_version_change (roda as sondas na primeira vez de cada versão do adaptador) | every_start | off
  on_conformance_fail: block       # block (o adaptador sai dos papéis que dependem da sonda que falhou) | warn
```

**Chaves da Fase 4 (v0.73)** **[V]**: os nomes foram conferidos em `packages/daemon/src/config.ts`, `role-policy-config.ts` e `ideas/settings.ts`. Todas têm override no projeto e no cenário, e o que uma camada mais específica escreve vence a anterior: **padrão do papel < `config.yaml` < cenário de origem < cenário** (N102).

```yaml
roles:                      # objeto fechado: um item por papel do registro; um nome fora dele é recusado (N102)
  actor:
    policy:                 # todas as chaves são opcionais; o que falta vem do padrão do papel
      native_tools: [read, search, edit, write]   # read | search | edit | write; o Ator edita e escreve no worktree, os outros só leem e buscam
      native_shell: shells  # none | shells; padrão do Ator: shells (N101); dos outros papéis: none. O shell do cliente nunca é um valor (N99)
      network:
        allow: []           # domínios (example.com ou *.example.com); um "*" solto é recusado; garantido pela camada 3
      browser: none         # none (padrão) | read | full: as ferramentas browser_* do papel (5.19, N116)
      on_ask: reject        # reject (padrão) | rules (N109)
      rules: []             # regras de liberação da camada 2; a lista da camada mais específica substitui a da anterior; no máximo 100
      bypass: forbidden     # valor único: uma configuração que tente abrir é recusada com a mensagem do N99
      write_scope: worktree # valor único, idem
tools:                      # as cascas do daemon (5.8)
  shell_allowlist: { mode: list, list: [...] }   # list (padrão, lista curada) | profile | any (N97)
  timeout_ms: 600000        # N98
  output_max_bytes: 65536   # N98
  truncate: head_tail       # head | tail | head_tail
  heavy_concurrency: 1      # N98
  heavy_commands: [run_tests, install_deps]      # restricted_shell fica de fora (N110)
  commands: { test: ..., install: ... }          # ProjectCommandSchema (uma linha ou um argv); o do cenário e o das convenções vencem (N111)
  env_inherit: minimal      # minimal (PATH, HOME, locale, proxy) | none | all; só no bloco global (N110)
  env_allow: []
  http: { timeout_ms: 30000, redirects: refuse } # refuse (padrão) | follow_allowed, no máximo 5 saltos (N104)
sandbox:                    # camada 3 (5.8)
  mode: runtime             # runtime (padrão, onde houver adaptador) | off; sem adaptador ou com off, vale security.unenforced (padrão refuse) (N106)
  extra_write_paths: []     # pastas absolutas que o cliente confinado pode escrever, além do worktree, do perfil dele e da pasta temporária
  extra_domains: []         # domínios a mais, além do network.allow do papel e dos do provedor do cliente
  mcp_bridge: proxy         # proxy (padrão, Linux) | off; deixa o cliente confinado alcançar o MCP do daemon em 127.0.0.1 (N115, 5.8)
security:
  secret_paths:             # uma lista só (N107); browser.secret_paths é apelido dela (5.19)
    add: []                 # acrescenta ao padrão da 5.19
    remove: []              # tira do padrão
browser:                    # 5.19; as chaves da N40 mais as da Fase 4 (N117)
  fallback: shared          # shared (padrão) | wait | fail (N108)
  timeout_ms: 30000         # só no bloco global
  min_free_memory_mb: 1024  # só global: nenhum navegador abre com menos RAM livre (5.9)
  max_instances: 2          # só global
  sandbox: true             # só global: false liga o Chromium com --no-sandbox, só onde a sandbox não roda
  executable_path: ...      # só global: o Chromium; sem ele, o que o playwright-core acha
  idle_close_ms: 600000     # só global: 0 nunca fecha
  read_max_chars: 32768     # override no cenário
  action_screenshots: writes # override no cenário
  # profile, domains, blocked_domains, local_urls, file_urls e write_approval: tabela da 5.19
ideas:                      # fila de ideias (5.20, N91); override do cenário por chave pontilhada (ideas.drain...)
  drain: auto               # auto (padrão) | manual; scheduled é recusado até existir o agendador (5.15, N112)
  grouping_approval: ask    # ask (padrão) | auto
  max_per_play: 5
  parallel_plays: 1
project:
  conventions: ask          # ask (padrão: detecta e pergunta ao Produtor, sem bloquear) | detect | off (N105)
```

**Sessão de leitura de catálogo** (v0.55, N65). O catálogo de modelos do Claude Code e do Codex é lido de uma sessão aberta só para isso: sem prompt, com a política de leitura mínima, num diretório vazio dos dados do daemon, e fechada logo depois de ler as opções que o cliente anuncia no `session/new`. Com `security.unenforced: refuse`, essa política também ficava curta de camadas e a sessão não abria. Com `security.catalog_probe: allow` (padrão), a sessão aberta com o propósito de leitura de catálogo pula a trava, e a base registra um aviso. Essa sessão nunca roda trabalho: o `prompt()` dela é recusado com `PermissionDenied`, sem chegar ao cliente. Com `refuse`, ela passa pela trava como qualquer outra. [N] Não foi medido se o cliente roda ganchos do usuário (por exemplo, `SessionStart`) ao abrir a sessão; se rodar, eles rodam também nessa leitura. O propósito da sessão (`work` ou `catalog-probe`) é um parâmetro opcional de `openSession` e `loadSession` na própria porta `ClientAdapter`, não só na classe-base, e a suíte de conformidade cobra de todo adaptador que a sessão de leitura recuse prompt (v0.56, N68).

**Sondas de conformidade.** São testes curtos contra o cliente real, no estilo do item 8b da Fase 0 (`spikes/acp-claude/src/s10-permissions-isolated.ts`). As comuns ficam na base: pedir a criação de um arquivo pelo shell nativo e conferir que não foi criado; tentar trocar para o modo de bypass e conferir a recusa; conferir que só os MCPs do papel aparecem. Cada descendente acrescenta as dele em `probes()`. Exemplos que saem do item 8 da Fase 0 (v0.45): no Claude, o mesmo arquivo por `sh -c` com o cliente em `reject`; no Codex, conferir que o modo da sessão é o fixado logo depois do `session/new`; no OpenCode, conferir que um `opencode.json` com `allow` na worktree não muda a permissão fixada. Elas entram também na suíte de conformidade da porta (5.18). Motivo: o comportamento muda entre versões (no adaptador 0.107.0 o `dontAsk` não chega pelo ACP), e a tradução só vale para a versão em que foi medida. **Custo:** cada sonda é um prompt real ao modelo. No item 8b, um prompt trivial do Claude gastou cerca de 84 mil tokens com as settings do usuário e cerca de 30 mil com `settingSources: []` [V]. Por isso o padrão é `on_version_change`, e as sondas rodam num worktree de rascunho, com o modelo mais barato do perfil.

**Versão do cliente** (v0.58, decidido pelo dono em 2026-11-16, N63). O daemon nunca executa o binário do cliente para saber a versão. Antes da primeira sessão, o adaptador lê o `package.json` do pacote instalado (o do cliente ou o do adaptador ACP), sem executar nada. Quando a primeira sessão abre, a versão que o cliente informa no `initialize` do ACP confirma ou corrige a lida (o campo é o `agentInfo` da resposta, opcional no ACP [V: SDK `@agentclientprotocol/sdk` 2.7.0]; o que cada cliente põe nele é **[a confirmar]** com os clientes reais). A versão escrita na chave `client_version` ganha das duas. Como as sondas rodam por versão (`security.conformance: on_version_change`), uma versão corrigida pelo `initialize` faz as sondas rodarem de novo.

**Implementação (P15, Fase 2).** A chave `clients.<id>.version_source: auto | package_json | initialize | config` (padrão `auto`) escolhe a origem; `version_packages` troca a lista de pacotes cujo `package.json` vale. O adaptador procura o executável de `command.cmd` no `PATH`, segue o link até o arquivo real e sobe até 12 pastas atrás de um `package.json` com um desses nomes, uma vez, na criação do adaptador. Um wrapper, `npx` ou binário avulso dá `unknown`. Os pacotes lidos são o adaptador ACP no Claude Code e no Codex (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`) e o `opencode-ai` no OpenCode. O transporte ACP entrega o `agentInfo` pelo `onAgentInfo` de `SessionOpenParams`, um acréscimo opcional que deixa a porta `AgentSession` na 0.1.0 (5.18, "Versão dos contratos"). Uma correção gera o aviso `client_version_corrected`, em nível info, e muda a chave do cache das sondas. Esses detalhes foram aceitos pelo dono em 2026-11-16, no merge do P15.

```yaml
clients:
  <id>:
    client_version: unknown   # unknown | <versão>; quando escrita, ganha das outras fontes
    version_source: auto      # auto (package.json e depois initialize) | package_json | initialize | config (só client_version)
    version_packages: [...]   # opcional; padrão: o adaptador ACP (Claude Code, Codex) ou opencode-ai (OpenCode)
```

**Casca de agente** (v0.43, ideia do dono, **[proposta]**). Cada descendente da `ClientAdapter` é também a **casca** do seu cliente: além de traduzir a política, ele normaliza a conversa. O resto do daemon (Diretor, pipeline, TUI, telemetria, cotas) fala com um agente só e nunca vê o cliente de destino. Não confundir com as cascas de ferramentas (`tools/`, 5.8), que embrulham shell, testes e rede.
- **O ACP é a língua única entre o daemon e o agente.** O daemon só fala ACP, com os mesmos métodos e eventos para todos os agentes. As particularidades de cada cliente são resolvidas dentro da casca, sem que o daemon perceba. O tipo é a `AgentSession` (5.18).
- **O que a casca resolve** (diferenças vistas na Fase 0):
  - cota esgotada: cada cliente avisa de um jeito, e nenhum devolve o horário de volta pelo ACP (N42). A casca devolve um erro único, com o horário quando houver outra fonte, e manda os sinais de cota ao gerente de cotas como `_otheater/quota/signal` (5.6, "Quem cuida da cota", v0.44);
  - modos, modelos e esforço: nomes diferentes por cliente (o Claude não tem `dontAsk`). `mapConfig` converte;
  - eventos: tipos de chamada de ferramenta, formato do consumo de tokens e `rate_limit_event`;
  - retomada (`session/load`) e cancelamento, que não se comportam igual em todos (5.16). No Claude, o `session/cancel` mata o filho de uma ferramenta Bash em primeiro plano, mas uma tarefa lançada em segundo plano sobrevive [V: Fase 0, item 8]. Por isso, ao cancelar, a casca encerra a árvore de processos do cliente e confere que não sobrou filho, em vez de confiar só no cancelamento do ACP (v0.45). Num processo com várias sessões, encerrar a árvore derruba também as outras sessões. A chave `pool.shared_cancel` decide o que fazer (N64, v0.54): `escalate` (padrão) mata o processo só quando o cliente não encerra o turno dentro da carência, e as sessões irmãs são retomadas por `session/load` (5.16); `always_kill` mata o processo em todo cancelamento; `release` só devolve a vez da sessão. Se o adaptador morre por SIGKILL, o `claude` fica órfão, adotado pelo `systemd --user`, e o filho segue vivo até terminar sozinho; ao fechar o stdin ou mandar SIGTERM ao adaptador, tudo sai em até 3 s [V: Fase 0, item 8d, n de 1 a 2]. O `ProcessLauncher` (grupo de processos no posix) cobre esse caso, o que ainda não foi medido [N];
  - transporte: para cima é sempre ACP. Para baixo é o que o cliente falar: ACP, headless (`claude -p`, `codex exec --json`), um SDK ou uma API. A troca na saída de emergência não aparece para o daemon.
- **Recursos únicos também viram ACP.** O que só um cliente oferece não é apagado nem chega ao daemon por outro caminho. A casca o expõe como chamada ACP compatível: um método de extensão `_otheater/<recurso>`, ou um campo `_meta`, e o anuncia no `initialize`. O ACP prevê os dois mecanismos: métodos com nome começando por `_` são extensões, e `_meta` é reservado para metadados de cada implementação [V: guia e schema do `@agentclientprotocol/sdk` 2.7.0, 2026-11-15]. Quando dois clientes têm recursos parecidos, os dois respondem ao mesmo método normalizado. Só um recurso sem equivalente leva o nome do cliente (`_otheater/<cliente>/<recurso>`). Exemplos: os comandos `/` do cliente (5.13, N44), o sandbox próprio do Codex, a statusline do Claude. Os nomes dos métodos são **[proposta]**.
- **Agente novo = casca nova.** Suportar outro agente é escrever um descendente que fale ACP para cima e o protocolo do agente para baixo, com a política, os normalizadores e as sondas. Se o agente já fala ACP, a casca é fina. O daemon não muda. Vale lembrar os dois eixos (5.18): um **modelo** novo (DeepSeek, Grok e outros pela API) entra por um cliente que já existe, como provedor do OpenCode, sem casca nova. Só um **agente** novo, com laço e ferramentas próprios, pede uma casca.
- **Roda dentro do daemon**, sem processo próprio. Um processo à parte não traria segurança: a ferramenta nativa roda dentro do cliente, e a casca só vê o evento depois. Quem bloqueia é a camada 1 e a camada 3 (5.8). Também custaria RAM e acrescentaria um salto e um ponto de falha. Como o contrato é ACP, a casca pode virar processo à parte depois sem mudar o daemon, se aparecer motivo: reaproveitar a casca em outro cliente ACP (um editor) ou isolar um adaptador instável. O ACP tem um desenho para isso, as *proxy chains*, com um `conductor` e os métodos `proxy/initialize` e `proxy/successor`, mas ele só está no schema instável [V: `schema.unstable.json` do SDK 2.7.0, 2026-11-15]. O modo `separate` seguiria esse desenho quando ele estabilizar.

```yaml
agents:
  shell_process: in_daemon   # in_daemon (v1) | separate (casca como processo ACP à parte; depois, se houver motivo)
```

`ClientAdapter` é uma porta de `@otheater/core` (5.18), e cada cliente é um pacote `@otheater/adapter-client-<cliente>` que passa na suíte de conformidade da porta. A conversa com o Executor é a `AgentSession` que a casca devolve: um contrato só, implementado por cada descendente sobre o transporte ACP ou headless.

**Pools por `(client, profile)`:**
- até `K` sessões por processo do adaptador; acima disso, abre outro processo. O `K` é por cliente (decidido em 2026-11-16, N74): `pool.<cliente>.sessions_per_process`, opcional, e sem ela vale a global `pool.sessions_per_process` (padrão 4, N62). Os padrões saíram da medição real da Fase 2 (2026-11-16, uma rodada, 1, 2, 4 e 6 sessões, ociosas e com prompts [V]) e foram decididos pelo dono: Codex 6 (o maior valor medido; acima de 6 não foi medido [N]), OpenCode 4 e Claude Code sem padrão próprio (herda a global; sem efeito no `process-per-session`). No Codex, um processo com 6 sessões usa cerca de 40% da memória de 6 processos sem perder latência; no OpenCode, com 4 sessões a latência é parecida (3,6 s contra 4,0 s), mas com 6 o processo único enfileira (6,3 s contra 3,6 s). O custo de um `K` alto é que, se o processo cai, as `K` sessões caem juntas;
- processo ocioso por `idleMs` é encerrado;
- processo travado é morto, e as sessões dele voltam para a fila;
- no Claude Code, o custo de RAM é por sessão (um `claude` por sessão), então o semáforo de admissão conta sessões, não processos do adaptador;
- no OpenCode, o modelo de processos é uma chave (decidido em 2026-11-16, N56). No padrão `per_profile`, cada perfil tem um `opencode acp` com até `K` sessões. Um crash derruba as sessões daquele processo e é tratado como queda do cliente (5.16). No `per_session`, cada sessão tem o seu processo e gasta perto do dobro de RAM (Fase 0: 835 MB contra 1.652 MB com 3 sessões [V]).

```yaml
pool:
  sessions_per_process: 4        # K global (N62)
  claude-code:
    # sessions_per_process: 4    # opcional, sem padrão próprio (N74): herda a global; sem efeito no process-per-session
  codex:
    sessions_per_process: 6      # padrão medido (N74); opcional
  opencode:
    process_model: per_profile   # per_profile | per_session (N56)
    sessions_per_process: 4      # padrão medido (N74); opcional
```

**Isolamento:** todo processo de Executor nasce pelo **lançador com Job Object** (ver 5.9). Ele limita a memória e mata a árvore inteira no cancelamento.

**Ciclo curto:** sessão termina → resultado estruturado gravado → sessão fechada.

**Saída de emergência:** se um adaptador se mostrar instável, a casca do cliente troca o transporte ACP pelo modo headless do próprio cliente, e a `AgentSession` que o daemon vê não muda:
- `claude -p --output-format stream-json`;
- `codex exec --json`, ou o `@openai/codex-sdk`.

### 5.3 Servidor MCP do framework

- Um único servidor, com **MCP SDK v2** (`@modelcontextprotocol/server`) em Streamable HTTP, servido pelo daemon.
- O SDK v2 usa uma fábrica por requisição (`createMcpHandler(factory)`). A fábrica lê o token da sessão e devolve só as ferramentas daquele papel/peça/demanda. É ali que o filtro por papel é implementado.
- **Porta** (decidido em 2026-11-17, N81): `mcp.port: auto | <número>`, com padrão `auto`. Com `auto`, o sistema escolhe uma porta livre em `127.0.0.1` a cada subida, e o daemon guarda a URL e a entrega a cada sessão, junto com o token dela. Um número fixo serve para depurar.

| Conjunto | Ferramentas |
|---|---|
| Diretor (Orquestrador) | `next_action`, `status(play?)`, `decide(decisionId, payload)`, `open_play(need)`, `pause`, `resume`, `cancel_actor`, `ask_producer`, `open_pr`, `schedule` (rascunho, confirmado pelo Produtor), `list_schedules`, `pause_schedule`, `list_directives`, `propose_directive`, `extend_directive` e `revoke_directive` (rascunhos, confirmados pelo Produtor; 5.17), `consult` (chat), `read_attachment(id)` (só texto e PDF convertido, N85), `promote` (rascunho), `run_task` (5.20) |
| Comum (todos os Executores) | `read_blackboard(key)`, `read_contract(id)`, `read_decision(id)`, `read_indication(id)` (5.19), `read_attachment(id)` (5.20), `submit(result)` |
| Autor / Revisor / Roteirista | `submit_plan` (com dúvidas e suposições, v0.31), `submit_plan_review`, `submit_script`, `submit_script_review` (o Autor, v0.31) (cada um com schema próprio) |
| Ator | `run_tests(target)`, `install_deps()`, `git_commit(message)`, `restricted_shell(argv)`, `http_get(url)`, `browser_*` se a política do papel liberar (5.19) + plugins do papel; o `submit` final aceita o estado `blocked` com o motivo (5.4, v0.31) |
| Crítico | `run_tests(target)`, `view_diff(demand?)`, `submit_critique` |

`submit*` é a única forma de um Executor terminar:
- a saída é validada com **zod** contra o schema do papel;
- saída inválida volta ao Executor com o erro de validação, até `N` vezes (`limits.submit_retries`, padrão 2 na predefinição `moderate`; decidido em 2026-11-17, N79);
- depois disso, conta como falha da tentativa.
- **[proposta]** as ferramentas de etapa (`submit_plan`, `submit_plan_review`, `submit_script`, `submit_script_review`, `submit_critique`) validam com o esquema da saída da etapa, o mesmo que o daemon usa para ler o que foi aceito; assim um formato errado volta ao modelo dentro das `N` retentativas e não derruba a peça depois (rodada real de 2026-11-17).

**Perguntas ao Produtor (`ask_producer`)** (decidido em 2026-11-14, v0.26, item 24 da seção 12, a pedido do dono): por padrão, o Diretor pergunta por **listas de opções de múltipla escolha**, e isso é aplicado em código (P3), não por texto no prompt.
- **Schema** (zod), validado como o `submit`: de 1 a 4 perguntas por chamada, respondidas de uma vez. Cada pergunta tem o texto, de 2 a 4 opções com rótulo e descrição, a opção **recomendada** (mostrada em primeiro e destacada), se aceita **mais de uma** opção (`multi_select`) e a marca `open` para a pergunta que não cabe em opções (ex.: "qual o nome do projeto?"). A interface sempre acrescenta **"Outra"**, com texto livre, sem o Diretor pedir. Nomes dos campos **[proposta]**;
- **as interfaces só desenham**, pelo mesmo dado da API (eventos `decision.*`, 5.11): a TUI mostra uma lista navegável com as setas ou o número da opção, Espaço para marcar na escolha múltipla e Enter para responder; a web e o tablet, botões; o celular, um toque (5.13) **[proposta]**;
- quem não responde: abaixo, `chat.unanswered`, e nas tarefas agendadas, `schedule.unattended_decision` (5.15);
- **o menu fixo de AWAITING_PRODUCER (5.4) é um tipo próprio** (decidido em 2026-11-14, v0.32): a lista vem do código e não segue o limite de 2 a 4 opções, que vale só para as perguntas que o Diretor monta. A interface mostra todas as opções que valem no momento.

```yaml
chat:
  producer_questions: choices      # choices | choices_strict | free
  unanswered:
    mode: wait_then_recommended    # wait_then_recommended | wait | recommended_now
    wait_for: 30m                  # 0 = espera sem prazo
```

- `producer_questions: choices` (padrão): opções sempre que der; uma pergunta sem opções só passa com a marca `open`, e sem ela o daemon devolve o erro de validação ao Diretor, que refaz a pergunta. `choices_strict`: toda pergunta precisa de opções, e o texto livre fica só no "Outra". `free`: sem exigência;
- `unanswered.mode: wait_then_recommended` (padrão): o daemon espera o Produtor por `wait_for` (30 min por padrão) e então responde com a recomendada. O evento (`decision.auto_answered`) registra que a escolha foi automática, e o chat mostra a pergunta e a resposta. `wait`: espera sem prazo, com notificação. `recommended_now`: segue na hora e avisa depois. Uma pergunta `open` ou sem recomendada sempre espera o Produtor;
- **salvaguarda nas decisões irreversíveis** (merge na branch base, 5.5; aumentar o teto de gasto, 5.6): a recomendada é definida pelo daemon e é sempre a opção segura (`pr` em vez de merge, `skip` em vez de aumentar o teto), e o Diretor não pode marcar outra. Vale para a resposta automática do chat e para a das tarefas agendadas. A lista dessas decisões é fechada e fica no código **[proposta]**;
- **escopo:** as duas chaves são globais, com override por cenário e por tarefa agendada, na mesma precedência de `roles` (5.7), e entram na lista fechada de chaves que uma ordem `rule` pode mudar (5.17).

### 5.4 Máquina de estados do pipeline

**XState v5** modela a peça. A peça teatral é o **fluxo padrão** do registro de fluxos (5.18): uma máquina montada com etapas reutilizáveis, registrada por nome e versão. Os fluxos da tarefa e do chat estão na seção 5.20. O snapshot (`getPersistedSnapshot()`) é gravado no SQLite a cada transição e reidratado no reinício.

Cuidados conhecidos:
- restaurar só na mesma versão da máquina (o snapshot guarda a versão, e há migração explícita quando ela mudar);
- não depender de *history states*;
- não deixar promessas em voo dentro da máquina: efeitos longos (sessões ACP) ficam fora dela e voltam como eventos.

Fluxo:

```
NEED
  → PLANNING (Autor; o plano traz dúvidas e suposições)
  → CLARIFYING (Diretor pergunta as dúvidas ao Produtor; pulado sem dúvidas)
  → REVIEWING_PLAN (Revisor) ──reprovado──→ PLANNING              [plan_reviews]
  → SCRIPTING (Roteirista) ──validação em código falhou──→ SCRIPTING [script_validations]
  → REVIEWING_SCRIPT (Autor) ──vetado──→ SCRIPTING                [script_vetoes]
  → EXECUTING (Atores, DAG de demandas; verificação por demanda)  [attempts_per_demand]
       └─ Ator bloqueado (demanda insuficiente) → falha de roteiro [script_returns]
  → INTEGRATING (merge das demandas na branch de integração)
       └─ conflito → falha de roteiro                              [script_returns]
  → CRITIQUING (Crítico, sobre a branch integrada)
  → DECIDING (Diretor; numa crítica mista, vence a falha mais grave)
       ├─ aprovado ──────────→ DELIVERING (PR/merge na base) → DONE
       │     └─ base mudou e conflita → falha de roteiro           [script_returns]
       ├─ falha de execução ─→ EXECUTING (só demandas afetadas)
       ├─ falha de roteiro ──→ SCRIPTING → REVIEWING_SCRIPT (Autor) → EXECUTING
       ├─ falha estrutural ──→ PLANNING (recomeça)                  [structural_restarts]
       └─ exceção crítica ───→ AWAITING_PRODUCER
  [reprovações do Crítico > Nc] → falha estrutural
  [qualquer contador esgotado]  → AWAITING_PRODUCER (menu fixo)
```

O mesmo fluxo, desenhado em Mermaid, está em [fluxo-da-peca.md](fluxo-da-peca.md) (2026-11-14).

**Esforço antes da execução** (decidido em 2026-11-14, v0.31, P13, a partir da experiência do dono com o `okit`, em que o Diretor planejava sozinho e as instruções incompletas geravam muitas rodadas do Crítico): corrigir um plano ou um roteiro custa uma sessão curta, sem worktree; uma rodada do Crítico custa Atores, integração, testes, crítica e decisão. Por isso, o pipeline concentra a verificação antes de EXECUTING, e as voltas para trás são raras e simples. As regras abaixo vêm da revisão do fluxo `Produtor-Roteirista Merge Workflow` (imagem de 2026-10-30), que a §5.4 substitui.

**Fronteira de cada papel** (P13). Cada papel faz uma coisa, e o que não é dele fica fora do seu schema e das suas ferramentas:

| Papel | Faz | Não faz |
|---|---|---|
| Produtor | Define a necessidade; responde às dúvidas | — |
| Autor | Transforma a necessidade em plano (o quê e por quê); declara dúvidas e suposições; revisa **todo** roteiro | Dividir em demandas; escrever código |
| Revisor | Confere o plano contra a necessidade e as respostas do Produtor; julga as suposições | Reescrever o plano |
| Roteirista | Divide o plano em **demandas prontas**, com contratos | Mudar o plano |
| Diretor | Coordena, pergunta ao Produtor, classifica a crítica | Planejar, dividir ou escrever código |
| Ator | Escreve o código que atende **uma** demanda pronta | Planejar, mudar escopo ou contrato, decidir pelo Produtor |
| Crítico | Avalia o trabalho integrado contra o plano, o roteiro e os critérios | Corrigir |

- **Demanda pronta:** descrição, critérios de aceite, contratos de entrada e saída, `expectedFiles` e pelo menos um passo de verificação (`verify`), ou o motivo de não haver (`verifyWaiver`), que o Autor julga. A validação em código confere os campos; o Autor confere o conteúdo em REVIEWING_SCRIPT.
- **Dúvidas e suposições do plano:** o `submit_plan` traz dois campos, `open_questions` (o que só o Produtor sabe) e `assumptions` (o que o Autor decidiu sozinho). Com dúvidas, a peça passa por CLARIFYING: o Diretor faz as perguntas por múltipla escolha (5.3), e o Autor fecha o plano com as respostas antes do Revisor. O Revisor julga se as suposições restantes são aceitáveis; uma suposição inaceitável reprova o plano.
- **O Autor revisa todo roteiro**, o inicial e os corrigidos: confere se a divisão preserva o plano e se cada demanda está pronta. O veto volta ao Roteirista com o motivo.
- **Paralelismo** (decidido em 2026-11-14, v0.32): o Roteirista indica o que pode rodar em paralelo pelas dependências (`dependsOn`): sem dependência pendente, a demanda roda junto com as outras. Na revisão, o Autor confere também se cada dependência é justificada por um contrato (`inputs`) ou pela ordem que o plano exige, e veta o encadeamento sem motivo. O schema da demanda não muda.
- **Verificação por demanda, em código:** ao fim de cada tentativa, o daemon roda os passos `verify` da demanda na worktree dela. Se falham, a saída volta ao Ator como erro e conta em `attempts_per_demand`, sem gastar integração, Crítico e Diretor. Os critérios de aceite em texto continuam com o Crítico.
- **Ator bloqueado:** se a demanda não basta para implementar (falta informação ou o contrato se contradiz), o Ator encerra com `submit` de estado `blocked` e o motivo, em vez de adivinhar. Isso conta como falha de roteiro, sem passar pelo Crítico.
- **Continuação de sessão entre papéis** (decidido em 2026-11-18, N131; implementação depois da Fase 5): com `pipeline.session_reuse: when_same_executor` (padrão), quando a seleção escolhe para a etapa seguinte o mesmo Executor da anterior, a sessão continua em vez de abrir outra, nos pares Revisor → Roteirista (a sessão que aprova o plano escreve o roteiro; a reprovação fecha a sessão e volta ao Autor) e Autor → revisão do roteiro (a sessão do plano é retomada no REVIEWING_SCRIPT). `preferred` faz a seleção preferir o Executor da etapa anterior; `off` abre sempre sessão nova. A revisão independente (Autor → Revisor, Ator → Crítico) sempre abre sessão nova. Estados, eventos, schemas e contadores não mudam; o daemon libera a ferramenta de cada etapa só no estado dela.

**Regras das voltas** (decididas em 2026-11-14, v0.31; os detalhes propostos na mesma revisão, como valores, nomes e listas, foram confirmados pelo dono no mesmo dia):
- **Todo laço tem contador**, em `limits` (abaixo). Esgotado, a peça vai a AWAITING_PRODUCER, com o **menu fixo**.
- **Crítica mista:** se a mesma crítica aponta falhas de tipos diferentes, vence a mais grave (estrutural, depois roteiro, depois execução). As falhas menores seguem como contexto do novo ciclo.
- **Recomeço estrutural:** `structural_restarts` limita quantas vezes o plano recomeça; esgotado, vai ao Produtor. A cada recomeço, os outros contadores zeram.
- **Depois da entrega**, um pedido de mudança no PR ou o PR fechado abre uma **peça nova**, ligada à anterior, com o pedido como necessidade e contadores novos. Se o PR ainda está aberto, a peça nova trabalha na branch dele e atualiza o mesmo PR; com o PR fechado, abre um PR novo.

**Menu fixo de AWAITING_PRODUCER.** A lista de opções é fechada e fica no código; o Diretor só escolhe a recomendada (5.3). É um tipo próprio de pergunta (v0.32): as cinco opções não seguem o limite de 2 a 4 do `ask_producer`, e a interface mostra todas as que valem no momento:
- **redefinir a necessidade:** volta a PLANNING com a necessidade nova e os contadores zerados;
- **aumentar o limite e continuar:** o laço que esgotou ganha mais uma rodada; se esgotar de novo, o menu volta;
- **entregar o que ficou pronto:** DELIVERING só com as demandas aprovadas; o PR diz o que faltou;
- **aceitar assim** (só depois de uma reprovação do Crítico): DELIVERING, com a dispensa do Crítico registrada (abaixo);
- **cancelar.**

A **exceção crítica**, que leva ao Produtor sem esperar contador, é uma lista fechada: necessidade impossível ou contraditória, falta de acesso, credencial ou permissão, risco de segurança ou de perda de dados, e decisão fora do escopo do plano.

- Transições, contadores e limites (`Np`, `Nc`, tentativas por demanda) ficam em código e configuração, nunca no prompt.
- **Dispensa do Crítico** (decidida em 2026-11-13; ver 5.17): é uma decisão registrada do Produtor, com motivo, e vale sempre para a **peça inteira**. Pode ser tomada em dois momentos:
  - ao abrir a peça: a máquina pula CRITIQUING e DECIDING, e vai de INTEGRATING a DELIVERING. Os testes da integração continuam rodando;
  - com a peça em AWAITING_PRODUCER depois de uma reprovação ("aceito assim"): a peça vai a DELIVERING.
  - Nos dois casos, o PR informa que o Crítico foi dispensado, por quem e por quê. Nenhuma ordem dispensa o Crítico.

**Limites do pipeline** (decidido em 2026-11-14, N4). Os limites são chaves de configuração, com valor global e override por projeto e por tarefa agendada. O padrão é a predefinição `moderate`.

```yaml
limits:
  preset: moderate             # moderate | economical | persistent
  plan_reviews: 2              # Np: reprovações do plano antes de AWAITING_PRODUCER
  critic_rejections: 2         # Nc: reprovações do Crítico antes da falha estrutural
  attempts_per_demand: 3
  script_validations: 3        # validações do roteiro em código antes do Produtor (v0.31)
  script_vetoes: 2             # vetos do Autor ao roteiro (v0.31)
  script_returns: 2            # falhas de roteiro sem o Crítico: conflito na integração, Ator bloqueado (v0.31)
  structural_restarts: 1       # recomeços do plano (v0.31)
  submit_retries: 2            # saídas inválidas de submit* devolvidas ao Executor antes da falha (v0.61, N79)
  demand_timeout: 30m          # quando o Roteirista não define o timeoutMin da demanda
  demand_timeout_max: 2h       # teto do que o Roteirista pode pedir
```

| Predefinição | `Np` | `Nc` | Tentativas | Timeout | Teto | Validações | Vetos | Voltas | Recomeços | Correções do `submit` |
|---|---|---|---|---|---|---|---|---|---|---|
| `moderate` (padrão) | 2 | 2 | 3 | 30 min | 2 h | 3 | 2 | 2 | 1 | 2 |
| `economical` | 1 | 1 | 2 | 20 min | 1 h | 2 | 1 | 1 | 0 | 1 |
| `persistent` | 3 | 3 | 4 | 45 min | 3 h | 4 | 3 | 3 | 2 | 3 |

- As colunas de validações a recomeços entraram na v0.31, com valores confirmados pelo dono em 2026-11-14. A coluna de correções do `submit` entrou na v0.61, decidida pelo dono em 2026-11-17 (N79).

- A predefinição (`preset`) preenche todos os valores de uma vez. Uma chave individual sobrepõe só o valor dela **[proposta]**.
- O schema zod vem do módulo dono das chaves e é validado na subida (5.18). A aba Configurações › Limites e `ot config` mostram e mudam as chaves.

**Pontos de julgamento.** São os únicos lugares onde o modelo do Diretor decide, cada um com schema:
1. classificar a crítica negativa (execução / roteiro / estrutural / exceção) e listar as demandas afetadas; numa crítica mista, vence a falha mais grave (v0.31);
2. Ator estourou o tempo: aceitar o trabalho parcial (já commitado, ver 5.5), que passa pelo `verify` e pela integração como qualquer demanda antes do Crítico, ou passá-lo a outro Ator para continuar;
3. quando consultar o Produtor, e o que perguntar;
4. no chat, responder sozinho ou consultar um Ator forte (5.20);
5. numa execução de tarefa com passo falho: corrigir a definição, repetir, pular ou parar (5.20);
6. recusa do modelo ou erro de permissão: reformular, trocar de Executor ou perguntar ao Produtor (5.16, v0.32);
7. retomadas de uma tentativa acima do limite (5.16, v0.32);
8. dependência refeita: rebasear ou refazer as demandas dependentes (5.5, v0.32). Se o rebase conflitar, o daemon refaz a dependente, sem nova decisão (N82, 5.5).

**Fila única de prompts do Orquestrador.** Mensagens suas no chat e avisos do daemon ("decisão pendente D-17; chame `next_action`") entram numa fila e são enviados à sessão do Orquestrador um de cada vez. Nunca dois `session/prompt` concorrentes. Mensagem do Produtor tem prioridade sobre aviso do daemon.

**Andamento sem custo de modelo.** "Ator 2 concluiu", "Crítico reprovou (1/2)" e semelhantes são mensagens de sistema que o daemon envia direto ao chat da UI, sem passar pelo modelo.

**Failover do Orquestrador.** Se o perfil do Diretor esgotar a cota ou falhar, o daemon abre uma sessão nova com o próximo Executor da lista do papel. Ela recebe um resumo gerado a partir do store (estado da peça, decisões pendentes, ordens vigentes, últimas mensagens do chat). Nada se perde, porque o estado nunca esteve só no modelo.

**Roteiro = DAG de demandas.** Cada demanda:

```ts
interface Demand {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];             // arestas do DAG
  contract: {                      // interface rígida entre Atores
    inputs: ContractRef[];         // o que consome de outras demandas
    outputs: ContractRef[];        // o que entrega (arquivos, APIs, tipos, schema)
  };
  expectedFiles: string[];         // escopo: detecção de conflito, sparse checkout
  complexity: 'low' | 'medium' | 'high';
  specialty?: string;              // "python", "sql", "frontend"... escolhe plugins e Executor
  timeoutMin: number;
  acceptanceCriteria: string[];
  verify: VerifyStep[];            // passos em código ao fim da tentativa (testes, lint); v0.31
  verifyWaiver?: string;           // motivo, se não houver passo de verificação
}
```

O Diretor executa o DAG em ordem topológica e libera em paralelo o que não tem dependência pendente, **limitado pelo controle de admissão** (5.9).

**Validação do roteiro** antes de executar, em código:
- DAG sem ciclos;
- contratos referenciados existem;
- duas demandas paralelas não declaram o mesmo arquivo em `expectedFiles`;
- toda demanda está pronta: critérios de aceite, contratos e `verify` (ou `verifyWaiver`) presentes (v0.31).

Se falhar, o roteiro volta ao Roteirista sem gastar Atores, até `script_validations` vezes. Passando, vai ao Autor (REVIEWING_SCRIPT).

### 5.5 Workspace (git)

Wrapper fino em TS sobre `git worktree` e `gh`. Padrões emprestados do **ccmanager** (MIT, TS): arquivo `.worktreeinclude` para copiar `.env` e arquivos não versionados para a worktree, e hooks pós-criação.

**Branches** (nomes desde 2026-11-16, N59): todas as branches de uma peça ficam sob `play/<id>/`, porque o git não guarda um ref e outro abaixo dele (com `play/42` existindo, `play/42/d1/1` é recusada; verificado num repositório temporário em 2026-11-16). Uma peça inteira se lista ou se apaga por esse prefixo.
- a peça cria `play/<id>/base` a partir da branch base do projeto;
- cada tentativa ganha worktree + branch `play/<id>/attempts/<demand>/<attempt>`; nenhum id de demanda fica reservado;
- a base dessa branch é `play/<id>/base`, ou a branch aprovada da dependência quando o contrato exige o código dela;
- se a dependência for refeita, as dependentes são rebaseadas ou refeitas (ponto de julgamento do Diretor, 5.4, registrado como evento).
- **conflito no rebase** (decidido em 2026-11-17, N82): o daemon aborta o rebase, e um Ator refaz a dependente numa tentativa nova, a partir da branch aprovada nova da dependência, com o diff da tentativa antiga como contexto. Conta em `attempts_per_demand` e não muda o roteiro; o Ator não resolve conflito. Chave `integration.rebase_conflict: redo | script_failure | resolve_attempt`, padrão `redo`: `script_failure` trata o conflito como falha de roteiro, e `resolve_attempt` abre uma tentativa só para resolvê-lo, conferida pelo `verify`, o que alarga a fronteira do Ator.

**Commit de segurança:** no timeout, cancelamento ou interrupção, o daemon faz um commit WIP automático da worktree. É isso que permite "outro Ator terminar" o trabalho e a retomada após reinício. Desde a v0.10 há também checkpoints periódicos e política de retomada por causa: ver 5.16.

**`INTEGRATING`:**
- as branches das demandas concluídas entram em `play/<id>/integration`, em ordem topológica;
- o Crítico avalia **o trabalho combinado**, e os testes rodam sobre o código integrado;
- conflito de merge = falha de roteiro.
- **o código já feito, no roteiro novo** (decidido em 2026-11-17, N84): o Roteirista marca as demandas que seguem iguais (mesma descrição, contrato e `expectedFiles`), e o daemon confere a igualdade e as mantém aprovadas, sem refazer. As que mudam são refeitas a partir da base, com o diff da tentativa antiga como contexto do Ator. A integração é refeita a partir de `play/<id>/base` **[proposta]**. As branches antigas, inclusive a da tentativa que conflitou, ficam até a entrega. Chave `rescript.reuse: keep_unchanged | redo_all | from_previous`, padrão `keep_unchanged`: `redo_all` refaz todas do zero, e `from_previous` começa a tentativa nova de uma demanda que mudou pela branch antiga dela.

**`DELIVERING`:** PR de `play/<id>/integration` para a base (`gh pr create`), ou merge direto se a política do projeto permitir.

**Base que mudou** (decidido em 2026-11-17, N83): antes do PR ou do merge, o daemon faz merge da base em `play/<id>/integration` e roda de novo os `verify` das demandas. Sem conflito, entrega. Com conflito, é falha de roteiro: as demandas dos arquivos em conflito são refeitas sobre a base nova, contando em `script_returns`, e as que não mudam seguem a regra do código já feito (N84, acima). Chave `delivery.base_drift: update | deliver_and_warn | ask`, padrão `update`: `deliver_and_warn` abre o PR com a lista dos arquivos em conflito e avisa o Produtor; `ask` leva a peça a AWAITING_PRODUCER com refazer, entregar com conflito ou cancelar, e sem ninguém olhando (tarefa agendada) vira `update`. **[proposta]**: `play/<id>/base` passa a apontar para a base nova antes de refazer, e um `verify` que falha depois da atualização, sem conflito, conta como falha de roteiro das demandas dele.

**Política de entrega** (decidido em 2026-11-14, N5). É a chave `delivery.mode`, com valor global e override por projeto, por peça e por tarefa agendada. O padrão é `pr`.

```yaml
delivery:
  mode: pr                     # pr | direct_merge | ask
  allow_direct_merge: false    # só no projeto; sem ela, direct_merge e ask viram pr
```

- `pr`: abre o PR e para ali. É o padrão.
- `direct_merge`: faz o merge na base. Só vale se o projeto tiver `allow_direct_merge: true` **e** a peça ou a tarefa pedir.
- `ask`: o Diretor pergunta ao Produtor, em DELIVERING, se abre PR ou faz merge. Sem ninguém olhando (tarefa agendada), vira `pr`. **Implementado no P9 da Fase 4 (N89, 2026-11-17)**: com alguém olhando, a peça pergunta pelo menu de AWAITING_PRODUCER (`deliver_pr`, `deliver_merge`, `cancel`) e o Diretor avisa o Produtor pela fila de prompts; a resposta volta ao `Workspace.deliver` como pedido do Produtor. Duas chaves **[proposta]** cuidam de quem não responde: `delivery.ask.timeout` (padrão `10m`; `0` espera sem limite) e `delivery.ask.on_leave` (`pr`, o padrão, ou `wait`); vencido o prazo ou, com `pr`, saindo o Produtor, a peça segue com o `pr` e o fato fica nas decisões (`decidedBy: daemon`). "Alguém olhando" é um `ot chat` que faz poll do cenário dentro de `chat.presence_window` (chave `chat.presence: poll | always | never`, padrão `poll`, **[proposta]** do P15a).
- O PR e o evento de entrega registram o modo usado e quem o pediu.

**Limpeza:** worktrees de tentativas descartadas são removidas; as aprovadas, depois da entrega. As branches das tentativas, descartadas ou aprovadas, saem depois da entrega (N84).

**Dependências:** caches com hardlink (`pnpm store`, `uv`). Sparse checkout opcional a partir de `expectedFiles`.

### 5.6 Assinaturas e cotas

**Perfil** = diretório isolado (`<data>/profiles/<cliente>/<perfil>/`). O nome do perfil é único dentro do cliente, e o id completo, usado nas chaves de configuração e no nome do Executor (5.7), é `<cliente>/<perfil>` (ex.: `claude-code/empresa`, `opencode/local`; v0.23):

| Cliente | Isolamento | Observações |
|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` (oficial) | No Windows, a credencial fica em `<dir>\.credentials.json`. Uma `ANTHROPIC_API_KEY` presente no ambiente sempre vence, então o daemon remove do ambiente do processo as variáveis que não pertencem ao perfil. |
| Codex | `CODEX_HOME` | Exige `cli_auth_credentials_store = "file"` no `config.toml` do perfil. No modo keyring/auto, a entrada do cofre pode ser compartilhada entre perfis **[a confirmar]**. |
| OpenCode | `XDG_DATA_HOME`/`XDG_CONFIG_HOME` + `OPENCODE_DB` | O isolamento por XDG só tem relatos de terceiros. Testar na Fase 0. |

**API:** a chave vai para o cofre do sistema operacional (`@napi-rs/keyring`; o `keytar` foi arquivado em 2022) e é injetada como variável de ambiente só no processo do Executor.
- Backends: Credential Manager (Windows), Keychain (macOS), Secret Service (Linux).
- **Linux sem Secret Service** (servidor sem interface gráfica, sessão SSH): fallback para um arquivo criptografado com senha mestra, pedida na abertura do daemon, ou chave só em variável de ambiente do serviço. O daemon informa qual backend está em uso, e nunca grava a chave em texto puro.

**Remoção de perfil:**
1. o perfil vai para `draining`: não recebe sessões novas, e as que estão em curso terminam ou voltam à fila;
2. logout;
3. remoção do diretório.

Executores que usavam o perfil ficam `invalid`, sem quebrar as listas dos papéis.

**Várias contas do mesmo provedor** (decidido em 2026-11-14, v0.30; era a Q15 do docs/13): são aceitas como qualquer perfil, e a seleção (5.7) as trata igual a qualquer Executor, sem regra especial. A decisão do dono tem três partes:
- **suporte:** o cadastro não bloqueia nem limita uma segunda conta do mesmo cliente;
- **sem divulgação:** README, documentação de uso, site e textos da interface não apresentam o recurso como forma de somar cota;
- **por conta e risco:** o projeto não afirma que o uso é permitido; o risco (suspensão da conta, por exemplo) é de quem usa.

**Aviso no cadastro** (aprovado pelo dono em 2026-11-14): o assistente de configuração mostra um aviso ao cadastrar uma segunda conta **de assinatura** do mesmo provedor, de qualquer plano (Pro + Max conta, como Max + Max), com o link para os termos dele e um aceite do usuário, registrado no perfil. Chave `profiles.same_provider_notice: once` (padrão; ou `always`, a cada conta nova, ou `off`).
- O que dispara o aviso é **somar cotas de assinatura**, e o plano não importa.
- **Contas de API nunca disparam o aviso**, ao lado de uma assinatura do mesmo provedor ou de outra chave: são cobradas por uso, e não somam cota. API e assinatura convivem no mesmo provedor sem restrição.

**Sondas de cota** (`QuotaProbe`). São as fontes mais confiáveis encontradas:

| Provedor | Fonte | Dados |
|---|---|---|
| Claude (Pro/Max) | **statusline**: o daemon configura, no `settings.json` de cada perfil, um comando de statusline que grava o JSON recebido em disco | `rate_limits.five_hour` / `seven_day` → `used_percentage`, `resets_at`. Só aparece depois da primeira resposta; janelas podem faltar. |
| Claude (complemento) | evento `rate_limit_event` do Agent SDK no stream | `status`, `resetsAt`, `utilization`. Não documentado oficialmente e com unidades inconsistentes **[a confirmar]**. Só vale se o adaptador repassar o evento. |
| Codex | `codex app-server`: `account/rateLimits/read` e a notificação `account/rateLimits/updated` | Janelas primária e secundária com `usedPercent`, `resetsAt`, `planType`. Um `app-server` leve por perfil, só para sondar, se o `codex-acp` não repassar a informação. Os tipos saem de `codex app-server generate-ts`. |
| MiniMax (Token Plan) | `GET /v1/token_plan/remains` | Janelas de 5 h e semanal. O schema da resposta não é documentado: tratar como frágil. |
| OpenCode | sem API de cota documentada | Contabilidade local (o banco SQLite do próprio OpenCode) + erros de limite. |
| Qualquer um | erro de limite (429 / mensagem) com o horário de reset | Fallback universal. |

- **Histórico de consumo (tokens e custo):** usar o **ccusage** (MIT, TS; cobre Claude, Codex, OpenCode e Gemini a partir dos logs locais, aceita vários `CLAUDE_CONFIG_DIR`) como biblioteca ou CLI. Ele não informa a cota restante, por isso as sondas acima continuam necessárias.
- **Referência de implementação:** o **CodexBar** (MIT, Swift, só macOS/Linux) já lê cota de dezenas de provedores. Serve para consultar como ele obtém cada sinal, não para usar direto no Windows.
- **Referência em TypeScript (N41, 2026-11-15):** o **Claudexor** (MIT) tem os parsers do `rate_limit_event` do Claude (`packages/harness-claude/src/quota.ts`) e do `account/rateLimits/read` do Codex (`packages/harness-codex/src/quota.ts`), com recusa de envelope malformado, e um veredito de cota com frescor (cota velha nunca autoriza rota). São o ponto de partida das sondas, com atribuição (seção 6.3). A sonda dele que chama `api.anthropic.com/api/oauth/usage` com o token do perfil **não** entra: contraria a seção 3. **[S]** (código lido, não executado)
- **Estado por perfil:** `ok | near_limit | exhausted(untilReset, cause) | unknown`. A causa é `quota` (cota da assinatura) ou `budget` (teto de gasto em API, abaixo).

#### Quem cuida da cota: casca e gerente

Proposto na v0.44, a partir de uma pergunta do dono: a cota fica na casca de agente (5.2) ou ganha uma casca própria? **[proposta]** O trabalho se divide em duas partes, e não há casca de cota, porque cota não é uma conversa a traduzir. É estado da conta, usado por várias sessões.

- **A casca de agente coleta os sinais** (uma por cliente, descendente da `ClientAdapter`):
  - **durante a sessão:** ela traduz para ACP os sinais que só o cliente vê, numa notificação de extensão `_otheater/quota/signal`, no mesmo formato para todos os clientes. Os sinais são o `rate_limit_event` do Claude, o erro de limite (429 ou mensagem) com o horário de reset, o consumo de tokens por turno e a cota esgotada no meio do turno. A cota esgotada continua chegando também como o erro tipado `QuotaExhausted` (5.18);
  - **fora da sessão:** cada descendente oferece a `QuotaProbe` do seu cliente (o membro `quota` da classe), com a fonte da tabela acima. Ela lê sem abrir sessão de conversa, e o gerente a chama quando precisa.
- **O gerente de cotas decide** (`QuotaService`, um só no daemon, o mesmo do `compose.ts` da 5.18):
  - recebe os sinais e as leituras;
  - associa cada sinal ao perfil da sessão, que o daemon conhece, então o sinal não carrega o perfil;
  - mantém o estado de cada perfil, o registro de consumo (com o ccusage como `UsageSource`), o custo em moeda, a tabela `pricing` e o teto de gasto;
  - aplica o frescor: uma leitura velha nunca autoriza rota (como no Claudexor, acima);
  - responde à seleção (5.7), dizendo se o perfil pode receber sessão agora, e dispara a passagem de bastão (5.16) com `in_flight: handoff`.

```ts
// payload de _otheater/quota/signal; o nome do método e os campos são [proposta]
type QuotaSignal =
  | { kind: 'window'; window: '5h' | '7d' | string; usedPercent: number; resetsAt?: string }
  | { kind: 'usage'; model: string; inputTokens: number; outputTokens: number; costUsd?: number }
  | { kind: 'limit_hit'; resetsAt?: string; source: string };   // source: rate_limit_event, 429, mensagem...
```

**Por que não fica tudo na casca de agente:**
1. **A cota é da conta, não da sessão.** Três sessões no mesmo perfil Max consomem a mesma janela de 5 h. Se cada casca guardasse o estado, cada uma veria um pedaço.
2. **A seleção decide antes de existir uma sessão.** Para escolher o Executor, o daemon precisa da cota de perfis que nenhuma casca está usando no momento. Algumas sondas nem precisam de sessão, como o `app-server` leve do Codex e o HTTP do MiniMax.
3. **O teto de gasto cruza provedores.** O teto mensal e o equivalente em API entre contas usam a tabela de preços e o período. Isso não é particularidade de nenhum cliente.

Para um cliente novo, basta a casca emitir `_otheater/quota/signal` e oferecer uma sonda, se houver fonte. O gerente não muda.

**O que o fake-agent da Fase 1 fixou** (2026-11-16, N50): os params de `_otheater/quota/signal` trazem `sessionId` além do `QuotaSignal`, porque o sinal não carrega o perfil e o gerente o associa pela sessão. A cota esgotada vira erro JSON-RPC `-32001`, com `data: { type: 'QuotaExhausted', resetsAt? }`. Os schemas do sinal ficam em `packages/protocol`, e o fake-agent os importa de lá (N52). O nome do método e os campos do `QuotaSignal` continuam **[proposta]** até a Fase 5 (N47).

**Gateway de API (depois da v1, se houver motivo):** seria um proxy entre o cliente e o provedor, só para perfis de **chave de API**. Ele daria duas coisas que as sondas não dão:
- corte exato do teto antes de gastar, em vez de depois do turno;
- contagem exata de tokens para qualquer cliente, inclusive o OpenCode, que não tem API de cota.

Não se aplica a assinaturas, que passam pelo login dos clientes oficiais. Interceptar esse tráfego teria risco com os termos **[não confirmado]**, e nada se afirma sem a fonte. Fica desligado:

```yaml
usage:
  api_gateway: off   # off (v1) | on (só perfis de API; depois da v1, se houver motivo)
```

#### Custo em moeda

Decidido em 2026-11-14 (era o item 10 da seção 12). Assinatura e API são medidas de jeitos diferentes, e as telas mostram as duas:
- **perfil de API:** custo real em US$, por sessão, peça, Executor, perfil e período;
- **perfil de assinatura:** uso da cota (janelas de 5 h e 7 dias, com o reset) e, ao lado, o **equivalente em API**: quanto o mesmo consumo custaria pelos preços de API, calculado dos tokens. É uma estimativa para comparar contas, não uma cobrança.

**Fonte do valor:** o custo que o próprio cliente informa, quando existe (no Claude Code, a métrica `claude_code.cost.usage` do OTel, 5.11); senão, tokens × a tabela de preços `pricing`, que vem com cada versão do OTheater e pode ser sobrescrita na configuração. O evento de consumo (`usage.*`) grava a fonte (`client` ou `pricing_table`) e a versão da tabela.

```yaml
usage:
  subscription_display: quota_and_equivalent   # quota_and_equivalent | quota | prorated
  cost_source: client_then_pricing              # client_then_pricing | pricing_table | provider_billing
pricing:                       # sobrescreve a tabela da versão; US$ por milhão de tokens
  minimax-m2: { input_per_mtok: <US$>, output_per_mtok: <US$> }
```

- `quota` mostra só a cota; `prorated` divide a mensalidade do plano, informada no perfil (`monthly_price_usd`), pelo uso do mês.
- `pricing_table` usa sempre a tabela; `provider_billing` consulta a API de uso ou faturamento do provedor, que chega com atraso e não existe em todos **[a confirmar por provedor]**.
- A tabela de preços precisa de revisão a cada versão, porque os preços mudam. Se um modelo não tem preço na tabela, o custo fica `unknown` e a tela avisa.

#### Teto de gasto em API

Decidido em 2026-11-14 (era o item 21 da seção 12). Cada comportamento é uma chave de configuração.

```yaml
profiles:
  opencode/minimax-api:
    budget:
      daily_usd: 20            # opcional; sugerido pelo assistente
      monthly_usd: 200         # opcional; sugerido pelo assistente
      warn_at: [0.8]           # avisos, em fração do teto
      on_exceeded: skip        # skip | wait | ask
      in_flight: handoff       # handoff | finish | stop
```

- **Onde fica:** no perfil de API, com teto por dia e por mês, os dois opcionais. Um Executor pode ter um teto menor (`executors.<nome>.budget`), dentro do teto do perfil. O orçamento por execução das tarefas agendadas (5.15) continua valendo; vale sempre o mais restritivo.
- **Primeira execução:** ao encontrar uma chave de API, o assistente de configuração (5.7) sugere US$ 20 por dia e US$ 200 por mês, e o Produtor confirma ou muda antes de a chave entrar nas listas (5.7).
- **Aviso:** em 80% do teto do dia ou do mês, mensagem de sistema no chat e notificação nas interfaces. `warn_at` aceita uma lista, como `[0.5, 0.8]`.
- **Sessões novas ao estourar** (`on_exceeded`):
  - `skip` (padrão): o perfil fica `exhausted` com causa `budget` até virar o período, e a seleção segue para o próximo Executor da lista. Sem nenhum disponível, vale o `when_exhausted` do papel;
  - `wait`: o papel espera virar o período, sem usar outro Executor;
  - `ask`: o Diretor pergunta se aumenta o teto, pula ou espera. Sem ninguém olhando, vira `skip`.
- **Sessão em curso ao estourar** (`in_flight`):
  - `handoff` (padrão): igual a cota esgotada (5.16). A sessão é interrompida e passa o bastão para o próximo Executor, sem contar como tentativa;
  - `finish`: termina a sessão atual, e o teto só barra as novas. Pode passar um pouco do teto;
  - `stop`: para e pergunta ao Produtor. Sem ninguém olhando, passa o bastão.
- **Período:** o dia e o mês seguem o fuso do daemon e viram à meia-noite e no dia 1 (aprovado pelo dono em 2026-11-14).
- **Medição:** o gasto é somado a cada evento de consumo. Como o custo de uma chamada só se conhece depois dela, o teto pode passar pelo custo da última chamada.

#### Retomada quando a cota ou o teto voltam

Decidido em 2026-11-14, a pedido do dono: o trabalho e as tarefas recorrentes continuam até o fim, sem o Produtor precisar relançar nada. Quando a cota de um perfil esgota ou o teto estoura, o daemon grava no store um **despertar** (tabela `wakeups`, seção 7) com o horário em que o perfil volta: o `resetsAt` da sonda de cota ou a virada do dia ou do mês do teto. Sem horário conhecido, o daemon volta a consultar o perfil de tempos em tempos.

**Consulta sem horário de reset** (decidida em 2026-11-14, com a ressalva do dono de que não gaste tokens e seja ajustável):
- a consulta só usa sinais que não chamam o modelo: a sonda de cota do provedor (`account/rateLimits/read` do Codex, `token_plan/remains` da MiniMax) ou a leitura do último JSON da statusline do Claude. Nunca manda prompt de teste;
- o intervalo é a chave `quota.recheck_every`, com padrão `15m`; `off` desliga a consulta;
- o provedor que não tem sinal sem custo (o Claude, cuja statusline só se atualiza depois de uma resposta, e o OpenCode) não é consultado. Passado o intervalo, o perfil vai de `exhausted` para `unknown`, e a próxima sessão real que a seleção mandar para ele serve de teste: se der erro de limite, ele volta a `exhausted` com o reset informado no erro **[proposta]**.

```yaml
quota:
  recheck_every: 15m           # só sinais sem custo de tokens; off desliga
```


No horário do despertar:
1. o perfil volta a `ok`, com o evento `quota.restored` ou `budget.restored`;
2. as tentativas em `AWAITING_RESUME` que esperavam aquele perfil retomam (5.16);
3. as demandas na fila sem Executor disponível passam de novo pela seleção (5.7);
4. as tarefas agendadas adiadas por cota (`quota_exhausted: postpone`, 5.15) rodam.

- Os despertares ficam no SQLite e sobrevivem a reinício e queda (5.21). Com a máquina desligada ou o daemon parado no horário, rodam na subida, pela reconciliação.
- Se a máquina puder estar dormindo no horário, o daemon usa o mesmo gatilho do sistema operacional que o agendador usa para acordá-la (5.15).
- Uma sessão que já passou o bastão para outro Executor não volta ao anterior quando ele se recupera, como as ordens não mudam sessões em curso (5.17).

### 5.7 Seleção de Executor

Configuração por papel: lista ordenada de Executores + regra quando ninguém está disponível. **Todos os papéis** têm a lista (Diretor, Consultor, Autor, Revisor, Roteirista, Crítico e Atores), e ela é a cadeia de fallback: quando o primeiro não tem assinatura com cota nem chave de API disponível, vale o seguinte. Tudo é ajustável na configuração (decidido em 2026-11-14).

**Nome do Executor** (decidido em 2026-11-14, revisto no mesmo dia na v0.23): sempre `<modelo>-<esforço>@<cliente>/<perfil>`. O `<modelo>-<esforço>` vem primeiro porque o papel é desempenhado pelo conjunto modelo + esforço. O prefixo do modelo é a família: os modelos do Claude levam `claude-`, como os do Codex levam `codex-`, para os nomes ficarem consistentes: `claude-opus-high`, `claude-sonnet-medium`, `claude-haiku-low`, `codex-sol-high`, `codex-luna-low`, `minimax-m2-medium`, `gemma4-low`. O sufixo `@<cliente>/<perfil>` vai em todos os Executores, mesmo com uma conta só: o cliente diz quem executa e o perfil diz a conta, que é única dentro de cada cliente (decisão do dono; era o item 22 da seção 12). Assim o mesmo modelo e esforço não colide nem entre contas nem entre clientes: `claude-opus-high@claude-code/empresa`, `claude-opus-high@claude-code/pessoal`, `claude-opus-high@opencode/anthropic-api`, `codex-sol-high@codex/conta-1`, `gemma4-low@opencode/local`. O cliente entrou no nome na v0.23 porque o OpenCode também pode chamar modelos do Claude e do GPT por chave de API ou gateway (a lista local do `opencode models`, versão 1.19.5, traz `opencode/claude-opus-5-5`; verificado localmente), e o nome sem o cliente esconderia quem executa. Os nomes `gpt-6-sol` e `gpt-6-luna` vêm do cache de modelos do Codex citado na documentação do `okit` (fonte secundária) e o nome atual do modelo da MiniMax também está **[a confirmar]** na Fase 0.

```yaml
executors:
  claude-haiku-low@claude-code/empresa:     { client: claude-code, profile: empresa,       model: haiku,                     effort: low }                       # provider: anthropic (fixo pelo cliente)
  claude-opus-high@opencode/anthropic-api: { client: opencode,    profile: anthropic-api, model: anthropic/claude-opus-5-5, effort: high, provider: anthropic } # chave de API; id do modelo [a confirmar]
  codex-luna-low@codex/conta-1:             { client: codex,       profile: conta-1,       model: gpt-6-luna,                effort: low }                       # [a confirmar]; provider: openai (fixo pelo cliente)
  gemma4-low@opencode/local:                { client: opencode,    profile: local,         model: gemma-4-26b-a4b,           effort: low,  provider: google }    # cadastrado no assistente
```

- **Interfaces:** onde faltar espaço (a TUI, o celular), a tela pode mostrar só o `<perfil>`, pôr o cliente numa coluna à parte, como ícone ou abreviado (`cc/empresa`, `cx/conta-1`, `oc/local`, como no mockup da TUI), mas o nome guardado e o dos eventos é sempre o completo **[proposta]**.
- **Cliente cruzado** (decidido em 2026-11-14, v0.23): com assinatura, cada família só roda pelo seu cliente oficial (Claude pelo Claude Code, GPT pelo Codex); com chave de API ou gateway, qualquer cliente que suporte o modelo pode executá-lo (ex.: `claude-opus-high@opencode/anthropic-api`). O que os termos de cada provedor permitem não é afirmado aqui: fica **[a confirmar]** na Fase 0, com fonte e data.

```yaml
executors:
  cross_client: api_only   # api_only | off | any
```

  - `api_only` (padrão): o daemon aceita um modelo fora do cliente oficial só num perfil de chave de API ou gateway;
  - `off`: cada família só pelo seu cliente oficial, com ou sem API;
  - `any`: sem verificação; vale o que o cliente aceitar.
- **Esforço que o adaptador não expõe:** o nome guarda o esforço pedido, e vale o fallback do adaptador (abaixo). Se o OpenCode expõe esforço para o Gemma 4 e o MiniMax está **[a confirmar]**.

**Primeira execução e assistente de configuração** (decidida em 2026-11-14, item 8 da seção 12; forma revista no mesmo dia na v0.23, a pedido do dono):
- **`ot init` mínimo:** instala o daemon como serviço de logon (Fase 10), sobe o daemon e abre a TUI direto no assistente, sem nenhuma pergunta no terminal. Motivo do dono, pela experiência no `okit-plugin`: setup por script é propenso a falhas e costuma ficar complexo, então a parte complexa vai para o assistente;
- **lógica no daemon:** o assistente é um fluxo de passos do daemon, exposto pela API (5.12). Cada passo guarda o estado no store, é validado antes de seguir e pode ser retomado depois de fechar a TUI ou de o daemon reiniciar. Nada entra na configuração antes da confirmação final, que grava tudo de uma vez **[proposta]**;
- **as interfaces só desenham:** na v1, a TUI (Fase 7); a web e o app (Fases 12 e 14) mostram o mesmo assistente pela mesma API, sem lógica própria;
- **reuso:** o mesmo mecanismo serve, depois da primeira execução, para adicionar uma conta, cadastrar um Executor do OpenCode (abaixo) e trocar a predefinição **[proposta]**.

Passos da primeira execução no assistente:
1. detecta os clientes instalados, os logins e as chaves de API; os modelos do Claude Code e do Codex são descobertos sozinhos, e os do OpenCode passam pelo assistente de cadastro (abaixo, "Cadastro dos Executores do OpenCode");
2. aplica a predefinição da chave `roles.preset` e tira da lista os Executores que não existem. A predefinição é escrita em `<modelo>-<esforço>`, sem conta; o assistente troca cada item pelos Executores das contas encontradas que têm aquele modelo, em qualquer cliente que o `executors.cross_client` permita, um por conta, primeiro os do cliente oficial e depois os outros, na ordem das contas que o Produtor confirmar (ex.: `claude-opus-high` vira `claude-opus-high@claude-code/empresa, claude-opus-high@claude-code/pessoal`, e `claude-opus-high@opencode/anthropic-api` se houver esse perfil) **[proposta]**;
3. acrescenta ao fim da lista de cada papel o Executor por API que encontrar (ex.: `minimax-m2-medium@opencode/minimax-api`), com o teto de gasto que o Produtor confirmar (5.6). Sem chave de API, a lista fica como está e vale o `when_exhausted` do papel;
4. mostra o resultado, e o Produtor confirma ou ajusta; só então a configuração é gravada.

Predefinição padrão, `quality`, depois da primeira execução numa máquina com as contas `claude-code/empresa`, `codex/conta-1`, `opencode/minimax-api` e `opencode/local`:

```yaml
roles:
  preset: quality              # quality | balanced | economical
  director:     { executors: [claude-haiku-low@claude-code/empresa, codex-luna-low@codex/conta-1, gemma4-low@opencode/local, minimax-m2-medium@opencode/minimax-api] }
  consultant:   { executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1, minimax-m2-medium@opencode/minimax-api] }   # Ator forte do chat (5.20)
  author:       { executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1, minimax-m2-medium@opencode/minimax-api] }
  reviewer:     { executors: [codex-sol-high@codex/conta-1, claude-opus-high@claude-code/empresa, minimax-m2-medium@opencode/minimax-api] }
  scriptwriter: { executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1, minimax-m2-medium@opencode/minimax-api] }
  critic:       { executors: [claude-opus-high@claude-code/empresa, codex-sol-high@codex/conta-1, minimax-m2-medium@opencode/minimax-api], when_exhausted: wait }
  actor:        { executors: [codex-sol-high@codex/conta-1, claude-sonnet-medium@claude-code/empresa, minimax-m2-medium@opencode/minimax-api], when_exhausted: next }

selection:
  cross_check: prefer_other_provider   # prefer_other_provider | require_other_provider | other_model | off
```

A tabela das predefinições usa os nomes sem conta, como elas são escritas:

| Papel | `quality` (padrão) | `balanced` | `economical` |
|---|---|---|---|
| Diretor | `claude-haiku-low`, `codex-luna-low`, `gemma4-low` | igual | igual |
| Consultor | `claude-opus-high`, `codex-sol-high` | igual **[proposta]** | `claude-sonnet-high`, `codex-sol-medium` **[proposta]** |
| Autor | `claude-opus-high`, `codex-sol-high` | `claude-sonnet-high`, `codex-sol-medium` | `claude-sonnet-medium`, `codex-sol-medium` |
| Revisor | `codex-sol-high`, `claude-opus-high` | `codex-sol-medium`, `claude-sonnet-high` | `codex-sol-medium`, `claude-sonnet-medium` |
| Roteirista | igual ao Autor | igual ao Autor | igual ao Autor |
| Crítico (`wait`) | `claude-opus-high`, `codex-sol-high` | `claude-opus-high`, `codex-sol-high` | `claude-sonnet-high`, `codex-sol-medium` |
| Atores (`next`) | `codex-sol-high`, `claude-sonnet-medium`, `minimax-m2-medium` | `claude-sonnet-medium`, `codex-sol-medium`, `minimax-m2-medium` | `minimax-m2-medium`, `gemma4-medium`, `claude-sonnet-medium` |

- A `balanced` deixa o Opus só onde decide a qualidade; a `economical` poupa as assinaturas e usa API barata e modelo local. O modelo local entra como Ator limitado pelos slots da instância (5.9, decidido em 2026-11-14, v0.23). O primeiro item de cada lista de `balanced` e `economical` veio da pergunta ao dono; os seguintes, que dão a troca de provedor, são **[proposta]**.
- O Diretor usa esforço `low` nas três: ele só encaminha e chama ferramentas MCP. Pode ser mudado na configuração.
- A chave individual de um papel (`roles.author.executors`, ...) prevalece sobre a predefinição.

**Revisão cruzada** (`selection.cross_check`, decidida em 2026-11-14): o Revisor e o Crítico pulam os Executores do mesmo provedor de quem fez o trabalho (o Autor, no plano; o Ator, no código) e voltam a ele se não houver outro disponível (`prefer_other_provider`, padrão). Os outros modos:
- `require_other_provider`: sem outro provedor, esperam;
- `other_model`: basta outro modelo, mesmo do mesmo provedor;
- `off`: só a ordem da lista.
O pulo entra no evento `executor.selected`, como os outros.

**Provedor de um Executor** (decidido em 2026-11-14, v0.23): na revisão cruzada, o provedor é a **família do modelo**, quem o treinou, e não o cliente nem a conta. O Gemma 4 conta como `google` mesmo servido pelo OpenCode numa instância local; o `minimax-m2` conta como `minimax`; o Haiku e o Sonnet contam como `anthropic`. Assim, um Revisor Gemma 4 local é de outro provedor em relação a um Autor Opus, e um Gemma 4 local e um Gemini na nuvem são do mesmo provedor.
- o campo `provider` do Executor define o provedor. No Claude Code e no Codex, ele é fixo pelo cliente (`anthropic`, `openai`) e entra sozinho na descoberta automática dos modelos;
- no OpenCode, o prefixo do modelo é a conta ou o gateway por onde ele é chamado, não quem o fez: `opencode/claude-opus-5-5` é da Anthropic pelo gateway do OpenCode, e um Gemma 4 pode vir de `google/`, de `openrouter/` ou de uma instância local (verificado localmente em 2026-11-14 com o `opencode models`, versão 1.19.5). Por isso o `provider` não é inferido pelo nome: ele vem do cadastro abaixo;
- sem `provider`, o Executor fica com `unknown`, que a revisão cruzada trata como diferente de todos, e a interface pede ao Produtor que o preencha **[proposta]**;
- o provedor da conta (coluna `provedor` de `profiles`, seção 7) continua servindo para a cota e o custo; ele pode ser diferente do provedor do modelo (ex.: um perfil OpenCode com chave da OpenRouter que serve um modelo da Anthropic).

**Cadastro dos Executores do OpenCode** (decidido em 2026-11-14, v0.23, a pedido do dono; contrato no `ModelCatalog` do `ClientAdapter`, 5.2): a descoberta automática fica para o Claude Code e o Codex, cujos modelos são bem documentados. Como o OpenCode chama muitos provedores e modelos, locais ou não, o Produtor cadastra os Executores dele num **assistente**, na primeira execução e depois na área de configuração (o mesmo mecanismo de assistente do daemon, acima), e o daemon só valida:
1. o assistente lê `opencode models --verbose` no diretório do perfil. A saída traz, por modelo, `providerID`, `family`, `api.url`, `cost`, `capabilities` (`toolcall`, `attachment`, `reasoning`) e `variants` (os esforços `low`, `medium`, `high`) (verificado localmente em 2026-11-14, versão 1.19.5);
2. o Produtor escolhe o modelo, e o assistente pré-preenche: o esforço (entre as variantes), a família do modelo (`provider`, a partir de `family`), se é local (pela `api.url` em `localhost` ou `127.0.0.1`, o que cria o bloco `local` do perfil, 5.9) e o custo (para a tabela `pricing`, 5.6);
3. o Produtor confirma ou corrige cada campo. Em modelo local configurado à mão no OpenCode, a `family` pode vir vazia ou pouco confiável **[a confirmar na Fase 0]**, e o campo fica para ele;
4. o daemon valida: o modelo existe na lista, o esforço está entre as variantes e o modelo chama ferramentas (`toolcall`). Depois roda uma **sessão de teste** curta, em que o modelo precisa chamar uma ferramenta e entregar um `submit` válido contra o schema (v0.24, abaixo, "Capacidade mínima por papel"). A capacidade `attachment` alimenta o filtro de anexos (5.20). Um Executor que deixa de passar na validação (modelo retirado, perfil sem login) muda o estado de validade (seção 7) e sai da seleção.

O que foi cadastrado vai para a chave `executors`, editável à mão; o assistente é só a forma guiada de preenchê-la.

**Depois do cadastro** (decidido em 2026-11-14, v0.23): o Executor fica disponível para **qualquer papel**. O catálogo não tem restrição por papel, e ele aparece como opção em todas as listas, na configuração e nas ordens do Produtor (5.17). Entrar na lista de um papel é outra coisa, e não acontece sem o Produtor ver:

```yaml
executors:
  on_register: ask   # ask | preset_only | none
```

- `ask` (padrão): o assistente termina perguntando em quais papéis e em que posição colocar o Executor. Vêm marcados os papéis cuja predefinição atual (`roles.preset`) já cita aquele `<modelo>-<esforço>` (ex.: `gemma4-medium` nos Atores da `economical`), e os outros vêm desmarcados;
- `preset_only`: entra sem perguntar, só onde a predefinição cita o modelo, na posição que ela dá;
- `none`: fica só no catálogo, até o Produtor acrescentá-lo a uma lista.

Vale para os Executores do OpenCode e também para os descobertos sozinhos no Claude Code e no Codex depois da primeira execução (um modelo novo, uma conta nova). Na seleção continuam os filtros de capacidade (anexos, 5.20; `toolcall`, na validação) e entra a capacidade mínima do papel (abaixo). O OTheater não roda modelos locais por código próprio: eles passam pelo OpenCode, como os outros, por ACP (P1, decisão do dono no mesmo dia).

**Capacidade mínima por papel** (decidida em 2026-11-14, v0.24, item 23 da seção 12): **todos os papéis aceitam modelo local**. Não há proibição por localização; o que separa um Executor de um papel é a capacidade, e o mesmo mínimo vale para modelo local e na nuvem. Os critérios:
- **chamada de ferramentas** (`toolcall`): obrigatória em todos os papéis, como já era na validação do cadastro;
- **janela de contexto:** num modelo local, vale a janela **por slot**, lida da instância pela porta `LocalModelServer` (5.9); nos outros, o valor do catálogo (`limit.context` no `opencode models --verbose`; no Claude Code e no Codex, o do `ModelCatalog`). O prompt de sistema e as ferramentas do cliente ocupam parte da janela, e por isso os mínimos têm folga **[hipótese]**;
- **raciocínio** (`capabilities.reasoning`): exigido nos papéis que decidem, o Consultor, o Autor, o Revisor, o Roteirista e o Crítico; o Diretor e os Atores não exigem;
- **sessão de teste no cadastro:** o assistente roda uma sessão curta em que o modelo chama uma ferramenta e entrega um `submit` válido contra o schema. Quem não passa fica marcado, e não excluído, conforme a chave `roles.capability_check` (abaixo). Vale para o cadastro do OpenCode e para os Executores descobertos sozinhos no Claude Code e no Codex **[proposta]**.

```yaml
roles:
  capability_check: warn        # warn | block | off
  director:     { requires: { context: 32k } }
  consultant:   { requires: { context: 128k, reasoning: true } }
  author:       { requires: { context: 128k, reasoning: true } }
  reviewer:     { requires: { context: 128k, reasoning: true } }
  scriptwriter: { requires: { context: 128k, reasoning: true } }
  critic:       { requires: { context: 128k, reasoning: true } }
  actor:        { requires: { context: 64k } }
```

- os mínimos de contexto padrão são **32k** para o Diretor, **64k** para os Atores e **128k** para o Consultor, o Autor, o Revisor, o Roteirista e o Crítico (escolha do dono; os números são **[proposta]** até a medição da Fase 0). Os nomes das chaves (`requires`, `context`, `reasoning`) são **[proposta]**; os nomes dos papéis seguem as chaves de `roles` (5.22);
- `requires` pode ser mudado por cenário e por tarefa agendada, como o resto de `roles` (abaixo, "Configuração dos papéis por cenário");
- `warn` (padrão): o assistente e a configuração aceitam um Executor abaixo do mínimo, com aviso, e ele aparece marcado na lista do papel (na TUI, um sinal ao lado do nome, com o motivo: janela, raciocínio ou sessão de teste). A escolha fica com o Produtor;
- `block`: o assistente e a configuração recusam o Executor naquele papel, e uma lista escrita à mão com ele falha na validação da configuração;
- `off`: sem verificação de capacidade, só a do `toolcall`;
- em qualquer modo, a seleção pula o Executor quando o prompt da demanda não cabe na janela dele (passo 1 do algoritmo, abaixo). É uma checagem por demanda, não pelo mínimo do papel.

Algoritmo, para cada demanda ou etapa:
1. percorre a lista na ordem. Um Executor é **disponível** quando:
   - o perfil está saudável;
   - a cota não está esgotada nem o teto de gasto em API estourou (5.6);
   - há vaga no pool;
   - o controle de admissão permite;
   - o prompt da demanda, com a folga do cliente, cabe na janela de contexto do Executor (no modelo local, a janela por slot) (v0.24) **[proposta]**;
2. pega o primeiro disponível. Entre Executores do mesmo `<modelo>-<esforço>` em contas diferentes, a chave `selection.strategy: ordered | most_headroom | round_robin` (padrão `ordered`, N130, 2026-11-18) diz a ordem: `ordered` é a da lista, `most_headroom` põe primeiro o perfil com mais folga de cota, e `round_robin` reveza a cada demanda; a ordem entre modelos diferentes não muda;
3. se ninguém estiver disponível:
   - `next`: espera o primeiro da lista que liberar;
   - `wait`: aguarda o reset do primeiro da lista, sem rebaixar;
4. **retry com diversidade:** a nova tentativa de uma demanda que falhou começa pelo Executor seguinte ao da tentativa anterior;
5. o motivo da escolha vira evento (`executor.selected`, com os Executores pulados e por quê).

**Configuração dos papéis por cenário** (decidido em 2026-11-14, v0.23; antes só havia o override por projeto). A chave `roles` segue a regra geral da configuração (5.20): valor global, com override em cada cenário (projeto, tarefa ou chat) e em cada tarefa agendada (5.15). O override é **por papel**:

```yaml
# configuração de um cenário (ou de uma tarefa agendada); tudo é opcional
roles:
  preset: economical                     # troca a base de todos os papéis neste cenário
  author: { executors: [claude-opus-high@claude-code/empresa], when_exhausted: wait }   # substitui só este papel
  allowed_profiles: [claude-code/empresa, codex/conta-1]   # só restringe contas, como o antigo override por projeto [proposta]
```

- a lista de um papel dada no cenário **substitui** a global só para aquele papel; os papéis não citados continuam com a global e recebem as mudanças feitas nela depois;
- `preset` no cenário troca a base de todos os papéis; o daemon expande a predefinição pelas contas existentes, como na primeira execução (passo 2 acima), e as listas dadas por papel no cenário prevalecem sobre ela **[proposta]**;
- `allowed_profiles` tira da lista final as contas fora dela (ex.: só o plano da empresa num projeto da empresa) e vale depois da expansão **[proposta]**;
- **precedência:** tarefa agendada > cenário > global. Uma ordem `rule` vigente (5.17) vale por cima da configuração do seu escopo, durante a vigência;
- as sessões em curso não mudam com uma alteração da configuração, como acontece com as ordens (5.17);
- a página de configuração do cenário mostra, por papel, se a lista é local ou herdada da global, com um atalho para voltar à herdada **[proposta]**.

**Esforço:** abstrato na configuração (`low | medium | high`). Aplicado pela config option `thought_level`/`model_config` que o adaptador anuncia (5.2), com fallback por adaptador.

**Outros provedores dentro do Claude Code:**
- **MiniMax:** endpoint oficial compatível com Anthropic (`https://api.minimax.io/anthropic`, `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` no perfil). Conferir o nome atual do modelo.
- **Gateway único (opcional):** **LiteLLM** para outros provedores por API e modelos locais, com o endpoint `/v1/messages` e `ANTHROPIC_BASE_URL`.
- **claude-code-router** é alternativa, com relatos conflitantes sobre a compatibilidade com o Claude Code 2.x **[a confirmar]**.

**Modelo local:**
- usar **Gemma 4** (26B-A4B MoE ou 31B, Apache-2.0, chamada de ferramenta nativa), não Gemma 3 27B, que tem chamada de ferramenta fraca;
- servidor: **llama.cpp com `--jinja`** ou Ollama (que tem API compatível com Anthropic). Há relatos de chamada de ferramenta quebrada em uma versão do Ollama;
- para modelo local, o OpenCode tende a ser um harness melhor que o Claude Code, cujas definições de ferramenta ocupam cerca de 11 mil tokens e que pede contexto de 64 mil ou mais.

### 5.8 Permissões (bloquear tudo, liberar o necessário)

Divisão:

| Categoria | Tratamento |
|---|---|
| Ler, buscar e editar arquivos | Ferramentas **nativas** do cliente (os modelos são treinados nelas), confinadas à worktree |
| Shell, testes, build, git, rede, banco, deploy | Nativo **bloqueado**; só pelas cascas do framework |
| Plugins | Servidor MCP + manifesto com permissões declaradas |

Três camadas:

**1. Configuração do cliente** — gravada por `prepareProfile` no diretório do perfil a cada mudança de política, e por `sessionSetup` em cada `session/new`. Os dois são métodos de cada descendente da `ClientAdapter` (5.2), que traduz a política neutra do papel (`RolePolicy`) para as chaves abaixo (v0.43, **[proposta]**).
- **Claude Code:**
  - `--tools` / `tools` restringe quais ferramentas **existem**; `--allowedTools` só dispensa o pedido de permissão;
  - regras `deny` (avaliadas antes de `ask` e `allow`);
  - Executores headless **negam tudo que pediria permissão**: a sessão roda no modo `default`, e o cliente do OTheater responde `reject` a cada `request_permission`. O modo `dontAsk` faria o mesmo no CLI, mas não chega pelo ACP (v0.42);
  - `--strict-mcp-config` com só os MCPs do papel;
  - as ferramentas dos servidores MCP do papel são liberadas com `allowedTools` e `permissions.allow` (regra `mcp__<servidor>`, que cobre todas as ferramentas do servidor). Sem elas, a chamada gera um `request_permission`, que a política `reject` recusa, e a ferramenta MCP nunca roda: o modo `acceptEdits` só dispensa o pedido para edição de arquivos. Nenhuma ferramenta nativa nem o Bash entram no `allow`. **[proposta]**, a partir da rodada do nível `play` do aceite real de 2026-11-17, em que o Diretor não abriu a peça (hipótese principal, ainda não confirmada por uma sessão real [N]; regra e formato em https://code.claude.com/docs/en/permissions [S], lida em 2026-11-17);
  - `settingSources: []` por padrão (v0.45), para que plugins, skills e MCPs do perfil do usuário não vazem para a sessão do Executor. Medido na Fase 0 (item 8b e 8c, uma rodada por variante) [V]: com ele somem os plugins, as skills e os MCPs do perfil, e os conectores claude.ai continuam listados; o `claude` usa 61 MB a menos de RSS e o prompt cerca de 12 mil tokens a menos. Ele também deixa de carregar os arquivos de settings e o `CLAUDE.md` da worktree [S: documentação do Agent SDK; não medido]; o contexto do papel vem do daemon (5.10). Uma sonda de conformidade confere que nenhum plugin do perfil apareceu na sessão (sobram só os `@builtin` do app). Chave por perfil:

    ```yaml
    profiles:
      claude/<perfil>:
        setting_sources: none   # none (padrão: settingSources []) | project (['project']: settings e CLAUDE.md da worktree) | user (['user', 'project', 'local']: o comportamento do CLI, com o perfil do usuário)
    ```
  - bypass bloqueado com `allowDangerouslySkipPermissions: false`, que tira o `bypassPermissions` do catálogo de modos; `disableBypassPermissionsMode` fica como segunda camada;
  - **Atenção:** as regras de deny por padrão não são fronteira. Medido na Fase 0 (`claude` 2.1.325, item 8c) [V]: `deny: ["Bash(touch *)"]` pegou `touch`, `/usr/bin/touch` e `env touch`, mas `sh -c` e `bash -c` furaram a regra e geraram `request_permission`. No item 8d [V, n=1 por variante], `xargs`, `command`, `timeout` e `nohup` foram negados, e `find -exec`, `eval`, `$(echo touch)` e `python3 -c` com `os.system` furaram, também com `request_permission`; com o cliente em `reject`, `sh -c` e `bash -c` não criaram o arquivo. Os outros furos com `reject` não foram medidos [N]. A documentação avisa também sobre o caminho absoluto e o `env` (https://code.claude.com/docs/en/permissions, lida em 2026-11-15) [S]. Por isso o Bash nativo é removido (`tools`), não apenas filtrado. O `deny` fica como segunda camada, e os furos fecham com o cliente respondendo `reject` (v0.45).
  - **Como chega pelo ACP** (medido na Fase 0, adaptador `claude-agent-acp` 0.107.0, [relatório](../../spikes/RELATORIO-FASE-0.md) item 8) [V]:
    - `tools`, `disallowedTools`, `strictMcpConfig`, `settings` (com as regras `deny`) e `allowDangerouslySkipPermissions` vão em `_meta.claudeCode.options` do `session/new`. `tools`, `disallowedTools` e `deny` removem o Bash cada um sozinho;
    - o modo é do ACP. Ele começa em `auto`, ou no `permissions.defaultMode` dos arquivos de settings, quando esse modo está no catálogo, e muda por `session/set_config_option`. O catálogo tem `default`, `acceptEdits`, `plan`, `auto` e, se permitido, `bypassPermissions`; não tem `dontAsk`. O `defaultMode` do `_meta` é ignorado;
    - `disableBypassPermissionsMode` no `_meta` não tira o bypass do catálogo, só faz a troca falhar. Nos arquivos de settings do perfil ou do cwd, ele tira.
- **OpenCode:** allow/ask/deny com padrões, com a última regra que casar vencendo, e overrides por agente.
  - Na V2, `bash` virou `shell` e `external_directory` vem liberado por padrão: negar explicitamente. No 1.19.5 medido na Fase 0, a chave que funcionou foi `bash` [V].
  - Fixar a versão.
  - **Como chega pelo ACP** (medido na Fase 0, `opencode acp` 1.19.5, item 8) [V]: sem configuração, tudo é permitido. O catálogo do `session/new` só tem `model`, `effort` e `mode` (`build` e `plan`), e não há como ligar um bypass pelo ACP. A precedência medida é `opencode.json` do cwd < `OPENCODE_CONFIG_CONTENT` < `OPENCODE_PERMISSION`, e `OPENCODE_DISABLE_PROJECT_CONFIG=1` faz o `opencode.json` do cwd ser ignorado. Os nomes das variáveis vêm das strings do binário, não da documentação [S]. Como o modelo pode editar a worktree, o daemon fixa as permissões em `OPENCODE_PERMISSION` e liga `OPENCODE_DISABLE_PROJECT_CONFIG=1` (v0.45). Uma sonda confere isso a cada versão.
  - **Item 8d** (mesma versão, config global do usuário isolada por `XDG_CONFIG_HOME`, n=1 por caso) [V]: a precedência e o padrão `allow` se mantêm sem a config global, o que contradiz a documentação de permissões, que diz `ask` (https://opencode.ai/docs/permissions/, lida em 2026-11-15) [S]. O `allow` do `OPENCODE_PERMISSION` vence um `deny` no `opencode.json` do cwd. Regras por padrão de comando funcionam: com `{"*": "deny", "git status*": "allow"}`, o `git status` roda e o `touch` falha sem pedir; com `{"*": "allow", "touch *": "ask"}`, o `touch` gera um `request_permission`. Um `deny` por padrão não tira a ferramenta: a chamada termina `failed`.
- **Codex:** `sandbox_mode`, `approval_policy` e habilitação de ferramentas por servidor MCP, selecionáveis pelo `codex-acp`. O shell faz parte do núcleo do Codex, então ali a contenção vem do sandbox:
  - no Windows 11 24H2+, **MXC** (isolamento nativo, sem admin);
  - fora disso, o modo `elevated` (exige configuração com admin).
  - **Como chega pelo ACP** (medido na Fase 0, `codex-acp` 2.6.0 com o `codex` 0.166.0, item 8) [V]:
    - o catálogo tem sempre `read-only`, `workspace-write`, `agent` e `agent-full-access`. `INITIAL_AGENT_MODE`, `CODEX_CONFIG` e `-c allowed_sandbox_modes` não tiram o `agent-full-access`, e a troca para ele por `set_config_option` funciona. Só um `requirements.toml` gerenciado (`/etc`, nuvem ou MDM) poderia barrar, o que não foi testado [S]. No item 8d, o binário mostrou o caminho `/etc/codex/requirements.toml` fixo [S], e um `requirements.toml` no `$CODEX_HOME` foi ignorado: o `agent-full-access` passou sem rebaixamento [V, n=1]. Sem root, o OTheater não tem essa camada;
    - o modo inicial padrão é `agent`. Nele, a escalada passa por um revisor automático do Codex, que aprovou sozinho, sem `request_permission` ao cliente e com a política `reject` ignorada. Em `agent-full-access` nada pede permissão. No item 8d, com o prompt pedindo escalada, o revisor aprovou `curl` para fora, `rm -rf` de uma pasta fora da worktree e `sudo -n true` (que falhou por falta de senha), todos com 0 `request_permission` [V, n=1 por caso];
    - o sandbox de `workspace-write` e de `agent` deixa `/tmp` gravável;
    - por isso (v0.45): a sessão começa em `workspace-write` (ou `read-only`), por `INITIAL_AGENT_MODE` e um `set_config_option` logo depois do `session/new`, conferido pela sonda; o daemon nunca envia `set_config_option` para `agent` nem para `agent-full-access`. Essa é a garantia `daemon` do `bypass` no Codex.

**2. ACP:** os `session/request_permission` são respondidos pelo daemon conforme a política do papel, automaticamente, sem perguntar a ninguém.

**3. Sistema operacional:** a única camada que é fronteira de segurança de fato.

| Plataforma | Recurso |
|---|---|
| Todas | Worktree como `cwd` + Job Object / grupo de processos |
| macOS/Linux | **`@anthropic-ai/sandbox-runtime`** (Apache-2.0; Seatbelt / bubblewrap) para o processo do Executor: rede negada por padrão com lista de domínios, escrita restrita |
| Windows | O `sandbox-runtime` está em **alpha** (usuário local dedicado + filtro WFP, instalação com admin). Pilotar na Fase 0. Base sem ele: usuário Windows de baixo privilégio com ACL só na worktree, mais o sandbox do próprio Codex. **O Claude Code nativo no Windows roda comandos sem sandbox** (WSL2 é a alternativa), mais um motivo para remover o Bash dele. |

**Ponte do MCP do daemon (v0.73, N115) [V]:** o servidor MCP do daemon escuta em `127.0.0.1:<porta>` no host, e o loopback de dentro do `bwrap` (`--unshare-net`) é outro, então o cliente confinado não o alcança sozinho. Com `sandbox.mcp_bridge: proxy` (padrão no Linux), o adaptador acrescenta ao comando um ouvinte `socat` TCP em `127.0.0.1` e `[::1]`, dentro da sandbox, que repassa pelo `CONNECT` do proxy da biblioteca (o retransmissor `socat` e o soquete Unix dela, montados antes do filtro seccomp) a `localhost:<porta>` do host. O filtro seccomp segue inteiro (o cliente não abre soquete Unix; `allowAllUnixSockets` é global e abriria o D-Bus da sessão) e a lista de rede do comando continua só com a porta do MCP: outra porta do host fica inalcançável. A porta chega por `SandboxRequest.loopbackPorts`, um campo opcional (5.18). Confirmado com o cliente real **[V]** (2026-11-17, `claude-agent-acp`). macOS não medido **[N]**.

**Suíte de fuga (v0.73, P5) [V]:** cada tentativa de sair do confinamento tem um teste com o agente falso por ACP real (`packages/daemon/src/execution/escape.test.ts`), e a pergunta que o teste faz é qual camada a segura, conferida no disco do host, nas requisições de um servidor local e nos eventos do daemon, nunca no texto que o agente devolve. A camada 2 recusa a escrita fora do worktree (`..`, caminho absoluto, symlink), o shell nativo, o `fetch` fora de `network.allow` e a troca de modo; as cascas recusam encadeamento, programa por caminho e flag proibida pelos códigos de recusa do argv; o que nenhuma regra pode ver (`node -e`, um `spawn` direto, uma conexão crua) só a camada 3 segura, e o teste de controle sem sandbox mostra que a escrita sairia. Nenhuma fuga passou no host. Em `bwrap`, `../x` nomeia o `tmpfs` privado da sandbox e a escrita pode dar certo ali sem chegar ao disco do host. A camada 1 (a configuração de cada cliente real) só se vê no nível `escape` do `real-acceptance.sh`, não rodado **[N]**.

**Cascas** (`tools/`):
- estreitas e tipadas;
- shell só por `argv`, com lista de comandos permitidos (sem `;`, `|`, `&&`);
- caminhos normalizados e presos à worktree (rejeitar `..` e symlinks que saem dela);
- domínios permitidos em `http_get`;
- timeout e saída truncada;
- toda chamada gera evento, passa pelos semáforos e conta para o consumo.

### 5.9 Recursos e memória (RAM)

**Plugins MCP compartilhados.** Cada plugin roda **uma vez**, e o daemon agrega todos:
1. sobe um cliente MCP SDK v2 por plugin (stdio ou HTTP);
2. junta as ferramentas;
3. as expõe pelo mesmo servidor do framework, com o filtro por papel na fábrica (5.3).

O desenho de filtro por tags do **1MCP** (`@1mcp/agent`) é a referência. O agregador é próprio (algumas centenas de linhas sobre o SDK MIT). O 1MCP só entra como sidecar se a licença dele estiver na lista permitida da seção 6.0 **[a confirmar]**.

**Controle de admissão:**
- semáforo de Executores calculado por RAM livre, vagas e cota;
- no Claude Code, o custo é por sessão (um `claude` por sessão).

**Semáforo de comandos pesados** (build, suíte de testes, instalação de dependências), separado: `run_tests` e `install_deps` entram nessa fila.

**Lançador com Job Object (Windows).** Não há pacote npm mantido para isso, e o Node não cria processos suspensos. Associar o processo ao job depois do spawn deixa uma janela em que netos escapam. Solução: um **lançador mínimo em Rust** (crate `windows-sys`, MIT ou Apache-2.0, chamando a API Win32 direto; N60) que:
1. cria o job (`KILL_ON_JOB_CLOSE`, `DIE_ON_UNHANDLED_EXCEPTION` e, se pedido, `JOB_MEMORY`: limite da memória comprometida do job inteiro, não de cada processo nem do working set);
2. inicia o Executor suspenso;
3. associa o processo ao job e o retoma.

O daemon guarda o handle. Alternativa sem Rust: `koffi` (FFI), aceitando a janela.

**Fallback de kill:** `execa` 10 com `killDescendants` (no Windows, `taskkill /T /F` enquanto a árvore existe).

**Modelo local** (decidido em 2026-11-14, v0.23; antes dizia "não para Atores em paralelo", o que contradizia a predefinição `economical`):
- uma instância compartilhada por perfil (llama.cpp com `--parallel` ou Ollama), com poucos slots;
- serve ao Diretor, aos julgamentos curtos e também a Atores e outros papéis, desde que haja slot livre;
- os slots são a vaga do pool desse perfil (5.7): com todos ocupados, o Executor fica indisponível e vale o `next` ou o `wait` do papel;
- uma parte dos slots fica reservada ao Diretor, para ele não ficar sem resposta quando Atores locais ocupam a instância;
- a memória do modelo é da instância, não de cada sessão: o semáforo de RAM conta o processo do cliente (`opencode acp`) por sessão e a instância uma vez só.

```yaml
profiles:
  opencode/local:
    local:
      server: llama-cpp         # llama-cpp | ollama (os dois na Fase 2, N71) — adaptador de LocalModelServer
      url: http://127.0.0.1:8080
      slots: auto               # auto (lê da instância) | <número>
      reserve_for_director: 1   # 0 | <número> | all (só o Diretor usa)
      reserve_when: listed      # listed (só se o perfil estiver na lista do Diretor) | always | never
```

- a instância é vista pela porta `LocalModelServer` (5.18), com um adaptador por servidor: `llama-cpp` e `ollama`, os dois na Fase 2 (v0.58, N71); o LM Studio e o vLLM ficam para depois da v1. O bloco `local` do perfil ganha a chave `server: llama-cpp` (ou `ollama`), que escolhe o adaptador **[proposta]**;
- a janela de contexto que vale para a capacidade mínima do papel (5.7) é a **por slot**: no llama.cpp, o contexto total (`-c`) é dividido entre os slots de `--parallel`, e o adaptador lê a janela de cada slot da instância **[a confirmar na Fase 0]**. Mais slots significam mais sessões ao mesmo tempo e janela menor em cada uma, e o assistente mostra essa troca ao Produtor **[proposta]**;
- `slots: auto` lê o número de slots pelo adaptador: no llama.cpp, pelo `/props` ou `/slots` do servidor; no Ollama, a API HTTP não expõe a variável `OLLAMA_NUM_PARALLEL` [S: documentação da API e FAQ do Ollama; o teste real do P14 não rodou], e o adaptador não lê a variável de outro processo: o número vem da chave `parallel` (ou `parallel_by_url`) do adaptador, com `context_mode: total | per_slot` (padrão `total`, que divide o contexto por `parallel`) (P14). Sem leitura possível nem chave escrita, vale 1 e o assistente de configuração pede o número ao Produtor **[proposta]**;
- `reserve_for_director: all` volta ao comportamento antigo (só o Diretor e julgamentos curtos);
- os valores padrão `1` e `listed` são **[proposta]**; a escolha das chaves foi do dono.

**Daemon e UI:** eventos vão direto para o SQLite; a UI virtualiza listas e pagina trajetórias.

### 5.10 Contexto (tokens)

- **Ator enxuto:** o prompt inicial tem regras do projeto + ordens vigentes (5.17) + papel + contrato da demanda + caminho da worktree. Usar `systemPrompt` do `session/new` quando o adaptador anunciar suporte.
- **Blackboard** no store: plano, roteiro, contratos e decisões. Lido sob demanda (`read_blackboard`, `read_contract`), nunca colado inteiro.
- **Artefatos por referência:** caminho, id, hash.
- **Saída estruturada:** o Executor termina com `submit(result)` (o que fez, arquivos tocados, testes, pendências). O Crítico lê diff integrado + resultados, não trajetórias.
- **Prompt caching:**
  - prefixo estável igual para todos os Executores do mesmo papel e projeto, nesta ordem: regras → ordens → papel → contratos. O início, o fim, a revogação ou a suspensão de uma ordem mudam o prefixo das sessões seguintes, não o das sessões em curso;
  - a parte variável vai no fim;
  - opcional: aquecer o cache com o primeiro Ator antes de liberar os demais.
- **Orquestrador sem memória própria:** sempre `next_action` / `status`.

### 5.11 Observabilidade

**Log de eventos** (tabela `events`, id crescente) é a fonte única. Tipos principais:
- `play.*`, `stage.*`, `demand.*`, `attempt.*`;
- `session.update` (mensagens, tool calls, diffs, plano);
- `executor.selected`, `permission.*`, `tool.called`;
- `quota.*`, `usage.*`, `decision.*`, `chat.*`, `directive.*`, `error.*`.

**OTel nativo dos clientes** (reaproveitado, sem instrumentar nada):
- **Claude Code:** `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*`. Envia métricas (`claude_code.token.usage`, `cost.usage`, ...) e eventos (`api_request`, `tool_result`, `tool_decision`, ...). Traces em beta.
- **Codex:** tabela `[otel]` no `config.toml` do perfil (`otlp-http`).
  - Medido na Fase 0 (`spikes/otel`, 2026-11-15) [V]: o `app-server` monta o exportador só na partida, por `[otel]` no `config.toml` do `CODEX_HOME` ou por `-c otel.*`. O `otel` dentro do `CODEX_CONFIG` do `codex-acp` vai para o `config` do `thread/start` e é ignorado sem erro. Um `app-server` atende todas as sessões do adaptador, então a correlação por atributo de recurso vale por processo; por sessão, só pelo `conversation.id` (= `sessionId` do ACP).
  - Cada sessão sem título explícito gera 1 thread extra, de título (outro modelo, `read-only`, prompt de 560 caracteres), com chamada ao modelo e `conversation.id` que não é sessão do ACP; com `session/set_title` antes do 1º prompt ela não ocorre [V, n=3 por braço].
  - `codex.tool_result` exporta `arguments` e `output` em claro por padrão, e todo registro traz `user.email` e `user.account_id` [V]: a redação é no receptor.
- **OpenCode** (dados da Fase 0, sem decisão nova): `OTEL_EXPORTER_OTLP_ENDPOINT` basta para logs e traces, com os atributos de recurso. Sem `experimental.openTelemetry` só saem spans internos, sem tokens nem modelo. Com a chave saem spans do AI SDK (`ai.streamText`, `ai.toolCall`) com tokens e modelo, mas também o prompt, a resposta e o resultado das ferramentas em claro; custo em USD não aparece [V, n=2, `opencode acp`].
- O daemon configura os dois, por perfil, para mandarem a **um receptor OTLP do próprio daemon**, com atributos de correlação (id da peça e da tentativa como atributos de recurso). Conteúdo de prompt fica redigido por padrão.

**OTel do daemon:** spans peça → etapa → tentativa → sessão → chamada de ferramenta, seguindo as convenções GenAI de agentes (`invoke_agent`, `execute_tool`; ainda em "Development", então podem mudar).

**ATIF:**
- formato definido pelo **Harbor** (dos criadores do Terminal-Bench), versão atual **ATIF-v1.8**, especificação na RFC 0001 do repositório `harbor-framework/harbor`;
- não há biblioteca TS: escrevemos o schema zod a partir da RFC e um exportador `session.update` → ATIF;
- validação de conformidade com o `TrajectoryValidator` (Python) do próprio Harbor nos testes.

**Campos próprios no ATIF** (decidido em 2026-11-14, v0.27; era a Q11 do [docs/13](../13-DECISOES-EM-ABERTO.md)):
- **Onde podem ficar:** os modelos Pydantic do Harbor usam `extra="forbid"`, então o validador recusa qualquer campo fora do schema. Dado próprio só entra nos objetos `extra`, que existem na raiz (`Trajectory`), em `agent`, em cada `step`, em `tool_calls`, nos resultados de `observation`, em `metrics`, em `final_metrics` e em `subagent_trajectory_ref` (verificado em 2026-11-14 no código de `harbor-framework/harbor`, ramo `main`, `src/harbor/models/trajectories/`; a RFC não diz o que acontece com campo desconhecido).
- **Bloco único:** tudo o que é do OTheater fica num objeto `otheater` dentro de cada `extra`, nunca em chaves soltas, para não colidir com outros exportadores. A raiz leva `schema` (versão do bloco, começando em 1). O schema zod valida só esse bloco, e o resto segue o modelo do Harbor.
- **O que vai em cada nível [proposta, fecha na Fase 8]:**
  - raiz: cenário, peça, etapa, demanda, tentativa, papel, worktree, branch e o motivo do fim da tentativa;
  - `agent`: o nome do Executor (`<modelo>-<esforço>@<cliente>/<perfil>`, 5.7), o cliente e a versão do adaptador ACP. O perfil vai pelo nome, nunca pelo e-mail ou pelo id da conta;
  - `step` e `tool_calls`: a decisão de permissão (qual das três camadas da 5.8 respondeu e se foi automática), os ids de indicação e de anexo citados e a ligação com o `events.id` do log;
  - `metrics` e `final_metrics`: o uso da cota (5 h e 7 dias), o equivalente em API e a origem do valor (`client`, `pricing_table` ou `provider_billing`, como em `usage.cost_source`, 5.6).
- **Unidade:** por padrão, a **peça inteira**. A trajetória raiz é a do Diretor, e cada tentativa de Ator, Revisor, Roteirista, Crítico ou consultor entra em `subagent_trajectories` (ATIF v1.7+), com `trajectory_id` igual ao id da tentativa e referenciada por `subagent_trajectory_ref` no passo que a lançou. Como quem lança as tentativas é o daemon, e não uma ferramenta do Diretor, o jeito exato de ligar o passo é conferido contra o validador na Fase 8 **[a confirmar]**.
- **Custo:** `metrics.cost_usd` e `final_metrics.total_cost_usd` só levam **custo real** (conta de API). Numa assinatura ficam nulos, e o equivalente em API (estimativa da 5.6) e o uso da cota vão no `extra.otheater`, para nenhum visualizador somar estimativa com gasto.
- **Conteúdo:** por padrão, **completo**: mensagens, raciocínio e resultados das ferramentas. Os valores que passam pelo `SecretVault` e as chaves reconhecidas por padrão são sempre mascarados, em qualquer modo. O arquivo é local e serve para reproduzir e analisar.

```yaml
atif:
  export:
    unit: play            # play | attempt (um arquivo por tentativa) | play_files (raiz com trajectory_path para cada tentativa)
    content: full         # full | redacted (só estrutura, argumentos resumidos e métricas)
    on: attempt_end       # attempt_end | play_end | manual  [proposta]
```

**Visualizador externo opcional:**
- **Arize Phoenix**: processo único, sem Docker, ingere OTLP e importa ATIF. Licença ELv2, source-available: serve para uso local, não para embutir num produto;
- alternativas Apache-2.0 (**OpenLIT**, **Laminar**) exigem Docker + ClickHouse.

O dashboard próprio continua lendo o store; os traces vêm da base de telemetria (abaixo).

**Onde a telemetria fica** (decidido pelo dono em 2026-11-16, N54):
- numa base SQLite própria, `telemetry.sqlite`, na pasta de dados, separada do store. Nela ficam os spans, as métricas e os logs OTLP recebidos dos clientes e os spans do próprio daemon;
- continuam no store o log de eventos (`events`), que é a fonte única do estado e da reconciliação (5.21), e as tabelas `usage` e `quota_snapshots`, que o agendador usa para decidir;
- motivos:
  - o SQLite aceita um escritor por arquivo, então o fluxo de spans não disputa a vez com as transições de estado;
  - a telemetria pode gravar com `NORMAL`, enquanto o store continua em `FULL` (no passo 7, ~1,4 ms por commit **[V]**);
  - uma falha na base de telemetria (disco cheio, arquivo corrompido) não para o daemon: ele recria a base vazia e avisa;
  - o backup e o expurgo do store não carregam a telemetria;
- não há transação entre as duas bases. A correlação usa os ids da peça e da tentativa, que já vão como atributos de recurso, e uma consulta que cruze as duas usa `ATTACH`;
- o esquema das tabelas, a porta e o adaptador da base de telemetria e o expurgo dela ficam para a Fase 8 **[proposta]**.

```yaml
telemetry:
  file: telemetry.sqlite       # relativo à pasta de dados, ou absoluto (N54)
  synchronous: normal          # normal | full (N54)
  export: off                  # off | otlp | prometheus | both (v0.57, N70)
  otlp:
    endpoint: null             # por exemplo http://127.0.0.1:4318, um Grafana Alloy ou um OpenTelemetry Collector [proposta]
    protocol: http/protobuf    # http/protobuf | grpc [proposta]
    headers: {}                # nome → referência ao `SecretVault` (5.6, 5.18); o valor nunca fica no arquivo [proposta]
```

**Exportação para fora** (v0.57, decidido pelo dono em 2026-11-16, N70). A telemetria fica na máquina por padrão (`telemetry.export: off`). Quando o usuário liga a chave, o daemon a entrega a um serviço de observabilidade, como o Grafana, em dois formatos:
- **OTLP** (`otlp` ou `both`): o daemon reenvia para o endpoint configurado, com o exportador do OpenTelemetry JS:
  - os spans e os logs do próprio daemon (peça → etapa → tentativa → sessão → ferramenta);
  - a telemetria nativa dos clientes que o receptor já recebe, com os ids da peça e da tentativa;
  - as métricas do daemon (abaixo).
- **Prometheus** (`prometheus` ou `both`): a API do daemon (5.12) expõe `/metrics` no formato de texto do Prometheus, com as mesmas regras de acesso dela (`127.0.0.1` por padrão e token). Ali saem só métricas, sem traces nem logs.
- **Métricas do daemon:** uso das cotas (5 h e 7 dias), equivalente em API (5.6), fila do agendador, retomadas e falhas por Executor. Os nomes e os rótulos ficam para a Fase 8 **[proposta]**.
- **Conteúdo:** o que sai segue a mesma redação do que entra. O conteúdo dos prompts fica redigido por padrão, e os segredos nunca saem.
- **Falha do destino:** um coletor fora do ar não para o daemon nem a gravação local. O exportador descarta o lote depois das tentativas e avisa no log **[proposta]**.
- **Como o Grafana recebe** [S, documentação do Grafana e do OpenTelemetry, não conferida localmente]: pelo Grafana Alloy ou por um OpenTelemetry Collector, que mandam traces ao Tempo, métricas ao Mimir ou Prometheus e logs ao Loki, ou direto pelo endpoint OTLP do Grafana Cloud. O `/metrics` serve a quem prefere que o Prometheus venha buscar as métricas (scrape).

**Retenção:** chunks de stream compactados em trajetória após o fim da tentativa; política de expurgo configurável. Os agregados que a análise do sistema precisa ficam guardados antes do expurgo (pergunta aberta N55, seção 12).

### 5.12 API do daemon

- **Framework HTTP:** Hono + `@hono/node-server`, validação com zod, contrato compartilhado com o front (`packages/protocol`).
- **REST:**
  - cenários (projetos, tarefas, chats), peças, demandas;
  - assinaturas, executores, papéis, plugins, configuração, ordens (globais e por cenário);
  - assistentes (5.7): iniciar, ler o passo atual, responder, voltar, retomar e confirmar; o estado de cada assistente fica no store **[proposta]**;
  - comandos: pausar, retomar, cancelar Ator, aprovar decisão, responder ao Produtor.
- **Métricas:** `/metrics` no formato Prometheus, só quando `telemetry.export` é `prometheus` ou `both` (5.11, N70).
- **SSE:** `/events?scenario=&since=` segue a tabela de eventos, com reconexão por `Last-Event-ID` (histórico, depois ao vivo).
- **WebSocket:** chat com o Orquestrador. A ponte vai para a fila única de prompts (5.4), mais as mensagens de sistema do daemon.
- **Segurança:**
  - `127.0.0.1` por padrão;
  - token obrigatório mesmo em acesso local, com CORS fechado, para que nenhuma página de outra origem comande o daemon;
  - acesso remoto (decidido em 2026-11-14, para o app Android, 5.13): pela **VPN do usuário** (Tailscale, WireGuard ou similar). O daemon nunca fica exposto na internet, e o OTheater não depende de serviço em nuvem próprio;
  - no modo `vpn`, o daemon também escuta no endereço da interface da VPN, com TLS próprio: certificado autoassinado, cuja impressão digital o app fixa no pareamento **[proposta]**;
  - **pareamento por QR:** `ot pair`, ou Configurações → Aparelhos, mostra um QR com o endereço do daemon na VPN, um token só daquele aparelho e a impressão digital do certificado. Cada aparelho pode ser revogado sozinho **[proposta]**;
  - tratar como acesso administrativo.

```yaml
api:
  remote: off           # off | vpn | proxy  [proposta]
  vpn_interface: auto   # auto | nome da interface (por exemplo tailscale0)
```

- `off` (padrão): só `127.0.0.1`;
- `vpn`: também no endereço da VPN, com TLS do daemon e tokens por aparelho; é o modo do app Android;
- `proxy`: só `127.0.0.1`, atrás de um reverse proxy com TLS, para quem já tem um.

**Referências de desenho:** `acpx` (MIT, TS; cliente ACP headless com sessões persistentes e saída NDJSON) e `rivet-dev/agents` (Apache-2.0, TS; agentes de código atrás de uma API HTTP).

### 5.13 Interfaces

**Mockups de referência** (valores ilustrativos):
- `mockup/tui.html`: TUI (interface principal), gerada por `mockup/tui-render.js` (`node tui-render.js`);
- `mockup/app.html`: web e desktop (Fases 12 e 13);
- `mockup/mobile.html`: app Android, celular e tablet em paisagem e retrato (Fase 14).

**Layout comum ao app e à TUI** (decisão de 2026-11-13):
- **Chat em altura total**, sempre visível, com **largura ajustável** (arrastar a borda no app; Ctrl+Shift+←/→ ou o mouse na TUI), lembrada entre sessões. Os dados da peça (título, etapa, decisão pendente) ficam no topo do chat.
- **Lateral retrátil** (Alt+S na TUI; Ctrl+B no app, N39) com cenários, assinaturas e a entrada de **Configurações**. Recolhida, vira um trilho com os cenários e as barrinhas de cota.
- **Painel de trabalho em abas que abrem e fecham:** Visão geral, Trajetórias, Consumo, Agenda, Ordens, Configurações e Plugins. Configuração é uma aba, não uma tela que substitui o chat. O painel inteiro fecha com Alt+J na TUI e com Ctrl+. no app (N39), e o chat passa a ocupar a largura toda.
- **Tudo recolhe, menos o chat:** seções da lateral e cartões das abas abrem e fecham com um clique (Enter na TUI).
- **Estado de layout persistido por usuário:** lateral, largura do chat, abas abertas.

**Ordem das interfaces** (decisão de 2026-11-13): **a TUI vem primeiro e é a interface principal** (Fase 7). Desde 2026-11-14 (v0.29, item 12 da seção 12), a ordem depois da v1 é: Fase 10b (daemon sem login), web (Fase 12), app desktop (Fase 13) e app Android (Fase 14). Nenhuma delas é opcional: o Android embrulha a web, e o desktop vem antes dele por escolha do dono, sem dependência técnica entre os dois.

**Camada compartilhada (`packages/client`, Fase 6).** O reaproveitamento entre TUI e web é de **lógica, não de tela**: componentes Ink não rodam no navegador, e componentes da web não rodam no terminal. O que se compartilha fica abaixo deles, num pacote que não depende de interface:
- **cliente da API:** REST tipado (a partir de `packages/protocol`), SSE com retomada por `Last-Event-ID` e WebSocket do chat;
- **stores de estado:** zustand no modo *vanilla* (MIT), que funciona tanto no Ink quanto no React. Guardam cenários, peças, demandas, decisões pendentes, cotas e eventos;
- **preferências de layout por usuário:** lateral recolhida, largura do chat, abas abertas, seções recolhidas.

A TUI nasce sobre essa camada, e a web a herda pronta: TUI e web viram duas "peles" sobre a mesma lógica.

**TUI (principal):** cliente de terminal da API do daemon, em **Ink** (React para terminal, MIT, layout flexbox via Yoga). Nunca fala com os agentes diretamente.

Por que Ink:
- **Mesmo modelo da web:** componentes React em TypeScript sobre o `packages/client`. Quando a web vier, muda só a camada de desenho.
- **Já usado em agentes de código:** Claude Code e Gemini CLI são feitos em Ink.
- **O layout dos mockups cabe no flexbox:** a largura do chat é a prop `width` de uma `<Box>`; lateral e painel são `<Box>` exibidas ou não.

O que o Ink não traz e escrevemos (`packages/tui/src/components/`):
- áreas com **rolagem própria** (histórico do chat, eventos, trajetória), com virtualização para conversas longas;
- **tela cheia** no buffer alternativo do terminal, com redesenho correto ao redimensionar a janela;
- barra de abas, seções recolhíveis e alça de largura do chat;
- paleta de comandos (Alt+K e F1);
- **caixa de texto do Produtor** (decisão do dono, 2026-11-15, N35), com o comportamento da caixa dos agentes de código. Conferido localmente no Claude Code 2.1.325: Ctrl+J nova linha, Ctrl+V cola imagem, Ctrl+G editor externo, Ctrl+R busca no histórico, marcadores `[Pasted text #…]` e `[Image #…]`. O Codex 0.169.0 também resume a colagem longa (`Pasted Content`) e lê imagens da área de transferência (`arboard`). Na caixa:
  - Enter envia; Ctrl+J e Shift+Enter (onde o terminal distingue do Enter) inserem nova linha;
  - edição no estilo do readline: Ctrl+A/E, Ctrl+B/F, Ctrl+K/U/W/Y, Alt+B/F/D e Ctrl+←/→ por palavra;
  - ↑/↓ no histórico de mensagens, Ctrl+R para buscar nele e Ctrl+G para escrever no `$EDITOR`;
  - **colar:** por bracketed paste (`usePaste` do Ink 8, que liga `?2004h`; verificado no código do Ink); colagem longa vira um marcador na caixa, com o texto inteiro guardado como anexo;
  - **imagem:** Ctrl+V lê a imagem da área de transferência e cria um anexo `A<n>` (5.20). No Linux e no macOS o Claude Code chama `wl-paste`, `xclip` e `osascript` (nomes vistos no binário); o OTheater chama a ferramenta do sistema se estiver instalada, sem empacotá-la. Licenças dessas ferramentas e enquadramento na 6.2 **[a confirmar]**;
  - **arrastar arquivo:** o terminal cola o caminho do arquivo como texto; um caminho de arquivo existente vira anexo. Comportamento de cada terminal **[a confirmar no teste de terminais]**;
  - chave `ui.keymap.preset`: `agents` (padrão, a caixa fica com as teclas de edição) ou `classic` (os atalhos antigos com Ctrl, da v0.7);
- **copiar texto** (decisão do dono, 2026-11-15, N36): com o mouse ligado, Shift+arrastar usa a seleção do próprio terminal (Option no macOS) **[a confirmar no teste de terminais]**; além disso, a TUI tem seleção própria com o mouse dentro de uma área (o chat, sem as bordas e as colunas vizinhas) e copia por OSC 52, que também aparece no binário do Claude Code e funciona por SSH (no tmux, com `set-clipboard on`). Chave `ui.clipboard.copy`: `osc52` (padrão), `system` (pbcopy, wl-copy ou clip.exe, para terminais sem OSC 52) ou `off`. Com `ui.mouse` em `wheel` ou `off`, a seleção normal do terminal volta;
- **mouse** (decisão do dono, 2026-11-15, N34): entra na Fase 7, como no Claude Code, que é feito em Ink e liga o rastreamento de mouse do terminal (`?1000h` e `?1006h` no binário 2.1.325, verificado localmente). O Ink 8 não tem API de mouse, mas já descarta as sequências de mouse da entrada e dá a posição de cada caixa (`useBoxMetrics`) para saber o que foi clicado. A camada é nossa: liga o rastreamento, lê os eventos SGR e acha a caixa clicada, descontando a rolagem. Cobre a roda para rolar, o clique em abas, seções, lateral e opções da decisão e o arrasto da borda do chat. Chave `ui.mouse`: `full` (padrão), `wheel` (só a roda) ou `off`. O teclado continua cobrindo tudo. Com o mouse capturado, selecionar texto do terminal passa a exigir uma tecla extra, que depende do terminal **[a confirmar no teste de terminais]**; tmux e SSH também ficam para esse teste.

Componentes básicos (campos, listas, seletores) vêm do `@inkjs/ui` (MIT).

Abas, comandos da paleta e ações do mapa de teclas ficam num registro do `packages/client` (5.18). Uma aba nova é uma entrada no registro, não uma mudança no layout. Plugins entram pelo painel declarativo (5.14), desenhado pela TUI e pela web.

Adaptações do terminal em relação à web:
- **DAG:** vira lista com dependências (`D4 ← D2, D3`), sem desenho gráfico;
- **papéis:** reordenados com Shift+↑↓, sem arrastar;
- **login das assinaturas:** o fluxo oficial do CLI (`claude`, `codex login`) roda num painel da própria TUI, porque esses logins já são interativos no terminal;
- **decisões do Produtor:** lista navegável (5.3), com as setas ou o número da opção, Espaço para marcar na escolha múltipla e Enter para responder.

**Multiplataforma.** TUI e daemon rodam em Windows, macOS e Linux (Node). O que muda por sistema:
- **cofre de chaves:** Keychain no macOS, Credential Manager no Windows, Secret Service (GNOME Keyring/KWallet) no Linux, ver 5.6;
- **contenção de processos:** Job Object no Windows; grupos de processos + `sandbox-runtime` no macOS/Linux, ver 5.8 e 5.9;
- **teclado:** ver o mapa de teclas abaixo.

**Uso remoto por SSH.** No Linux e no macOS, com o daemon numa máquina sempre ligada, a TUI pode ser aberta por SSH de qualquer lugar, sem depender da nuvem. O daemon continua escutando só em `127.0.0.1`; quem acessa é a TUI rodando na própria máquina, dentro da sessão SSH.

#### Comandos `/` do chat (decisão do dono, 2026-11-15, N44)

- **Um registro só, no daemon.** Os comandos `/` são entradas do mesmo registro de ações que gera a paleta, a ajuda e a tela de atalhos (N39), e a API os serve (5.12). Por isso a TUI, a web, o desktop e o Android mostram a mesma lista, com a mesma busca e o mesmo autocompletar. O registro entra na **Fase 7**, na TUI, e as outras interfaces o herdam.
  - Cada entrada traz id, descrição, argumentos com schema, onde vale (tipo de cenário e estado), permissão e confirmação **[proposta]**.
  - O nome é em inglês, com sinônimo no catálogo do idioma (5.22) **[proposta]**.
- **Três origens:**
  1. **Do daemon (comandos próprios):** o daemon os executa sem chamar o modelo, por isso não gastam cota. Valem a qualquer momento, até com o Diretor no meio de um turno, e não têm prefixo. Os que mudam estado passam pelas mesmas permissões e confirmações das ações; cancelar uma peça, por exemplo, pede confirmação.
     - Lista inicial **[proposta]**, nomes e agrupamento incluídos:
       - **consultar:** `/status`, `/quota`, `/cost`, `/executors`, `/plays`, `/trajectory`, `/logs` e `/doctor`, que faz o diagnóstico do daemon, dos clientes e dos perfis;
       - **controlar a peça:** `/pause`, `/resume`, `/cancel`, `/retry` e `/approve`;
       - **sessão e cenário:** `/new`, `/fork`, `/attach`, `/direct`, que abre a sessão direta (5.20), e `/export`;
       - **configurar:** `/model`, `/effort`, `/profile`, `/directives` (ordens, 5.17), `/config` e `/keys`;
       - **ajuda:** `/help`, gerada do próprio registro.
     - O mesmo registro pode servir a CLI, como `ot status` **[proposta]**: cada comando novo valeria em todas as interfaces e no shell sem código a mais (P14).
     - Plugins (5.14) podem registrar comandos deste tipo. Para não colidir com os do daemon, eles levam o prefixo do plugin **[proposta]**.
  2. **Modelos para o Diretor:** os terminados em "…" preenchem um texto para o Produtor completar. As frases salvas do Produtor e os modelos que os plugins registram (5.14) entram aqui.
  3. **Do cliente do Executor:** o que o cliente anuncia por `available_commands_update` no ACP aparece com o prefixo do cliente, como `/claude:compact`. Os três clientes mandam essa atualização **[V, spikes acp-claude, acp-codex e acp-opencode]**.
     - Esses comandos valem em dois lugares: na sessão do próprio Diretor, só quando ele não está num turno; e na sessão direta com um Ator (5.20).
     - Os Atores de uma peça nunca recebem comando do cliente vindo do Produtor.
- **`/` e `!`:** o `!` roda um comando de shell (N43), e o `/` chama o registro. Só os modelos do item 2 viram mensagem ao Diretor.
- **Chaves [proposta]:**
  - `chat.slash_commands: on | off` (padrão `on`);
  - `chat.client_commands: on | off | allowlist` (padrão `on`), com a lista em `chat.client_commands.allow` no modo `allowlist`.
- O botão `/` do Android (abaixo) abre esta mesma lista.

#### Mapa de teclas (configurável)

Programas de terminal só recebem Ctrl e Alt/Option; o **Cmd do macOS nunca chega**. Alguns atalhos do mockup colidem com o sistema ou com o terminal. Por isso o mapa de teclas:
- é **configurável** pelo usuário (arquivo de preferências, editável também pela aba Configurações);
- tem **padrões por sistema e por ambiente**, detectados na inicialização:
  - macOS;
  - dentro do tmux (variável `TMUX`);
  - no terminal do VS Code (`TERM_PROGRAM=vscode`);
- oferece **sempre um caminho alternativo**: toda ação está na paleta de comandos, e a paleta tem dois atalhos;
- é mostrado na **barra de atalhos** do rodapé e na ajuda (F1), sempre com as teclas efetivamente ativas.

| Ação | Padrão (Windows/Linux) | Padrão no macOS | Alternativa | Colisões conhecidas |
|---|---|---|---|---|
| Recolher/expandir lateral | Alt+S | Alt+S | paleta; clique | Era Ctrl+B até a v0.32, que é "voltar um caractere" no readline e o prefixo do tmux |
| Abrir/fechar painel | Alt+J | Alt+J | paleta; clique | Era Ctrl+J, que agora é "nova linha" na caixa de texto (N35) |
| Largura do chat | Ctrl+Shift+←/→ | Ctrl+Shift+←/→ | foco na borda do chat (Tab) e ←/→; arrastar a alça; paleta | Ctrl+←/→ pula palavra na caixa de texto (`/etc/inputrc` do Fedora, verificado localmente); no macOS troca de área de trabalho |
| Abrir aba | Alt+A | Alt+A | paleta; clique no `+` | Era Ctrl+T ("transpor caracteres" no readline) |
| Fechar aba | Alt+W | Alt+W | paleta; clique no `✕` | Era Ctrl+W ("apagar palavra" no readline); terminais no navegador fecham a aba com Ctrl+W |
| Paleta de comandos | Alt+K | Alt+K | **F1** (paleta + ajuda) | Era Ctrl+K ("apagar até o fim da linha" no readline) |
| Configurações / Plugins | F5 / F6 | F5 / F6 | paleta | No macOS, as teclas F exigem Fn por padrão |
| Responder decisão | ↑↓ ou número, Espaço, Enter | ↑↓ ou número, Espaço, Enter | paleta | — |
| Sair | Ctrl+Q | Ctrl+Q | paleta | Ctrl+Q/Ctrl+S são controle de fluxo (XON/XOFF) fora do modo bruto; o modo bruto do Node os desativa |

Regras:
- **Alt no macOS** depende do terminal: no Terminal.app, "Usar Option como Meta"; no iTerm2, "Option como Esc+". Se não estiver ativo, a TUI avisa na primeira execução e o caminho é a paleta.
- **Ctrl+Shift+letra não serve:** sem um modo de teclado estendido, o terminal não distingue Ctrl+Shift+P de Ctrl+P. O protocolo do kitty distingue, e o modifyOtherKeys também: no tmux, com ele pedido, o Ctrl+Shift+P chega como `ESC [ 27 ; 6 ; 112 ~` [V: Fase 0, `tui-keys`]. A regra continua, porque nem todo terminal liga esses modos. Setas com modificadores, ao contrário, são distinguíveis na maioria dos terminais.
- **A caixa de texto tem prioridade** (N35): nenhum atalho do layout usa uma tecla de edição do readline ou dos agentes de código. Os atalhos do layout usam Alt com letras que o readline deixa livres (conferido localmente com `bind -p` no bash: ele usa Alt+B C D F G L N P R T U X Y). Os atalhos com Ctrl da v0.7 continuam disponíveis com `ui.keymap.preset: classic`.
- **Conflito ao configurar:** a configuração rejeita atalhos repetidos e avisa quando o usuário escolhe uma combinação da lista de colisões.

Os mockups mostram os padrões de Windows/Linux.

**Alternativa: OpenTUI** (equipe do OpenCode; TypeScript com núcleo nativo). Traz rolagem e mouse prontos e desempenho melhor com muitas atualizações por segundo. Na Fase 0 (2026-11-14, verificado localmente na versão 0.9.0; `spikes/tui-opentui/`): só roda no **Bun**, porque no Node 24 falta a FFI nativa; os pacotes JS são MIT, mas os binários nativos `@opentui/core-<plataforma>` são `MIT AND LGPL-2.1-or-later`, o que a seção 6.0 proíbe.

**Decisão:** começar em Ink. O **teste comparativo da Fase 0** (Ink × OpenTUI), agora **obrigatório**, decide antes da Fase 7. Como a TUI só depende do `packages/client` e da API do daemon, trocar de framework não afeta o resto do sistema.

**Resultado (2026-11-15, decisão do dono; item 11 da seção 12): Ink.** Pelo critério da Fase 0, o Ink passou nos três itens na bancada (`spikes/tui-bench/README.md`; tmux 160x45, streams de 300 s, uma execução por caso): CPU e memória estáveis no streaming a 20 e 50 eventos/s, rolagem de 5.000 mensagens com p50 de 30 a 39 ms e layout 25/25. A digitação sob streaming ficou mais lenta que no OpenTUI (p50 de 41 a 47 ms, contra 3 a 9 ms); `maxFps` e a renderização incremental ficam como ajustes da Fase 7. Pesaram também contra o OpenTUI: só Bun, binários LGPL, memória crescendo durante o streaming (até 353 MB em 600 s, sem platô) e layout 21/25 no protótipo. Faltam os terminais gráficos reais, SSH, macOS e Windows, que a matriz de terminais da Fase 7 cobre.

**Desempenho do Ink (decisão do dono, 2026-11-15, N37).** No spike de otimização (`spikes/tui-ink/README.md`, seção "Otimização"; tmux 160x45, uma execução por caso, verificado localmente), a digitação sob streaming a 50/s caiu de p50 de 41 a 48 ms para 10 a 11 ms, a CPU de 26 a 28% para 24% e o RSS de cerca de 290 para 110 a 140 MB. O ganho vem de duas partes:
- **da aplicação**, com a API pública do Ink e flags do Node: cada tecla desenha um quadro na hora (`waitUntilRenderFlush`), componentes memoizados e o heap jovem do V8 limitado (`--max-semi-space-size=2`, a maior alavanca da memória);
- **de um patch** no `output.js` do Ink 8.0.0 (cache dos trechos estilizados e reaproveitamento da grade), carregado por gancho de módulos sem alterar o `node_modules`. Ele baixa o quadro de cerca de 11,5 para 7 ms.

O patch fica, com a versão do Ink travada em 8.0.0: se a versão mudar, o patch é recusado e o Ink original roda (a trava ainda não existe no spike; entra na Fase 7). Propor a mudança ao projeto Ink fica para depois, só com autorização do dono. Chaves em `ui.render`: `keyRender` (`flush`, padrão, ou `throttle`), `maxFps` (30, agora só para o fluxo), `coalesceMs` (16), `memo` (ligado), `inkPatches` (`[cache, grid]`, padrão, ou vazio) e `historyWindow` (0, desligado); e em `ui.runtime`: `maxSemiSpaceMB` (2) e `maxOldSpaceMB`. O `maxOldSpaceMB` é um teto duro (o processo morre se o heap vivo passar dele); 96 MB deu folga de 2x no spike, e o valor do cliente real precisa acompanhar o tamanho do histórico **[a definir na Fase 7]**. A variante otimizada ainda mostrou a borda quebrada em capturas do tmux (1 em 29 a 300 s; 1 em 5 numa repetição de 60 s), o mesmo fenômeno já visto sem `--incremental` **[a investigar]**.

**Web (Fase 12, depois da v1; base do app Android):** React + Vite sobre o mesmo `packages/client`, com SSE para tempo real. Nasce responsiva e preparada para toque, porque o app Android a reaproveita (Fase 14). Acrescenta à TUI o DAG desenhado, arrastar para reordenar, painéis próprios de plugins e mouse. Componentes reaproveitados:

| Uso | Componente |
|---|---|
| Chat com streaming | **assistant-ui** (MIT) com `ExternalStoreRuntime`, alimentado pelos stores do `packages/client` |
| Blocos de IA (código, trace, mensagens) | padrões de IA do **shadcn/ui** (não usar Vercel AI Elements: será descontinuado no fim de novembro de 2026 em favor do shadcn) |
| DAG de demandas | **@xyflow/react** (React Flow, MIT) |
| Trajetórias | **AgentPrism** (Evil Martians; `TraceViewer` em árvore, com adaptador OTel). Licença MIT no repositório, com exceção por pacote para os pacotes npm (N45, seção 6.0) **[V]** |

**Conteúdo das telas** (o mesmo nas duas interfaces):
- **Lateral:** Assinaturas, Projetos, Tarefas, Chats, Plugins, Configuração.
- **Cenário** (projeto, tarefa ou chat genérico: o mesmo objeto, com tipo e fluxo diferentes; 5.20):
  - chat com o Orquestrador, com anexos e o estado do Diretor (ativo ou adormecido);
  - na tarefa: a definição (versão ativa, passos, ensaio) e a lista de execuções com o artefato final de cada uma;
  - dashboard: etapa, DAG, Atores ativos e tempo restante, worktrees/branches, reprovações, consumo e cota por assinatura, motivos de seleção;
  - visualizador de trajetórias, ao vivo e histórico.
- **Configuração:**
  - Assinaturas: status, cota, reset, login, adicionar/remover;
  - Executores: cliente, perfil, modelo e esforço a partir das config options anunciadas;
  - Papéis: lista ordenada por prioridade + `next`/`wait`;
  - Limites: a predefinição e as chaves de `limits` (`Np`, `Nc`, `attempts_per_demand`, `script_validations`, `script_vetoes`, `script_returns`, `structural_restarts`, timeouts), semáforos;
  - escopo global com override por projeto.

**Desktop (Fase 13, depois da web e antes do Android; v0.29):** Electron envolvendo a web, conectado ao serviço de logon da Fase 10, como qualquer outro cliente; o daemon não roda dentro do app (item 6 da seção 12, v0.25). Sem o serviço instalado, o app abre o mesmo assistente de configuração do daemon (5.7), que o instala. Instalador por usuário (electron-builder).
- Tauri v2 tem guia oficial de sidecar Node e gera instalador menor, ao custo de toolchain Rust. Como o lançador de Job Object já traz Rust para o projeto, Tauri fica mais viável que na v0.1.
- Decisão ao abrir a Fase 13 (item 7 da seção 12).

**Mapa de teclas e capacidades do app (web e desktop; decisão do dono, 2026-11-15, N39).** O app desktop usa o **mesmo mapa de teclas do Claude Desktop** e tem as **mesmas capacidades** dele. A **identidade é do OTheater**: cores, tipografia, ícones, nomes e o layout dos mockups (lateral, chat em altura total e painel de abas). Do Claude vêm só as combinações de teclas e o comportamento das ações; nenhum código, ícone ou texto dele é copiado.
- **Referência:** Claude Desktop 5.11492.2, pacote `claude-desktop` do Fedora, Electron 45.2.1. Foi lido localmente em 2026-11-15 em duas fontes: os aceleradores do menu do processo principal e o registro de atalhos da interface, que dá as combinações por plataforma (`mac` e `non-mac`) e por superfície (`web` e `desktop`). **[V]** para Linux. O macOS foi deduzido pela regra `CmdOrCtrl` (Ctrl vira Cmd) e pelas variantes `mac` do registro, sem conferência num Mac **[N]**.
- **Por superfície**, como no próprio Claude:
  - **desktop:** o mapa completo da tabela abaixo;
  - **web:** o mesmo mapa, menos as combinações que o navegador reserva (Ctrl+N, Ctrl+W, Ctrl+T e Ctrl+Tab). Nesses casos vale a variante web do Claude, quando ela existe (Ctrl+Shift+O para novo cenário), e a ação continua na paleta;
  - **TUI:** fica com o mapa da N35 (Alt + letra), porque o terminal não recebe Cmd nem distingue Ctrl+Shift+letra. As ações são as mesmas e vêm do mesmo registro.
- **O mapa é dado, não código** (P14). Ele fica no registro de interface do `packages/client` (5.18), com uma entrada por ação: id, descrição, grupo e as combinações por plataforma e por superfície, na mesma forma do registro do Claude. Ação nova é uma entrada nova. O menu nativo do desktop, a paleta, a ajuda e a tela de atalhos são gerados do registro e sempre mostram as teclas ativas.
- **Chaves:**
  - `app.keymap.preset`: `claude` (padrão) ou `tui` (os atalhos Alt da TUI também no app);
  - `app.keymap.overrides`: ação → combinação, com a mesma checagem de conflito da TUI.
- **Acompanhar o Claude:** o preset `claude` guarda a versão de referência. Ao abrir a Fase 13, e depois a cada versão do OTheater, uma conferência compara o preset com o Claude Desktop instalado e lista as diferenças para o dono decidir. O preset não muda sozinho.
- **Não depende da escolha Electron × Tauri (N7):** os dois têm aceleradores de menu e atalho global. No Tauri, o atalho global vem do plugin oficial `global-shortcut` **[S]**.

| Grupo | Ação no OTheater | Linux e Windows | Ação no Claude Desktop |
|---|---|---|---|
| Janela | Paleta de comandos | Ctrl+K | Command palette |
| Janela | Buscar cenários e mensagens | Ctrl+Shift+K | Search |
| Janela | Tela de atalhos / Ajuda | Ctrl+/ / F1 | Keyboard shortcuts / Help |
| Janela | Configurações (abre a aba) | Ctrl+, | Settings |
| Janela | Recolher/expandir lateral | Ctrl+B | Sidebar |
| Janela | Abrir/fechar painel de trabalho | Ctrl+. | Toggle side panel (era Ctrl+J no mockup) |
| Janela | Fechar painel / fechar aba, painel ou cenário | Ctrl+\ / Ctrl+W | Close pane / Close tab, pane, or session |
| Janela | Próxima / anterior região | F6 / Shift+F6 | Focus next / previous region |
| Janela | Zoom: tamanho real, aumentar, diminuir | Ctrl+0, Ctrl+=, Ctrl+- | Actual Size, Zoom In, Zoom Out |
| Janela | Localizar; próxima e anterior ocorrência | Ctrl+F; F3 e Shift+F3 (ou Ctrl+G e Ctrl+Shift+G) | Find |
| Janela | Recarregar, menu, tela cheia, sair | F5, F10, F11, Ctrl+Q | Reload, Application Menu, Full Screen, Quit |
| Cenários | Novo cenário | Ctrl+N (web: Ctrl+Shift+O) | New session |
| Cenários | Reabrir cenário ou aba fechada | Ctrl+Shift+T | Reopen closed session |
| Cenários | Próximo / anterior | Ctrl+Tab / Ctrl+Shift+Tab (ou Ctrl+Shift+] / [) | Next / Previous session |
| Cenários | Ir ao cenário 1 a 9 | Ctrl+1…9 | Jump to session |
| Cenários | Voltar / avançar na navegação | Alt+← / Alt+→ | Back / Forward |
| Cenários | Renomear, fixar, marcar como lido | Ctrl+Alt+R, Ctrl+Alt+P, Ctrl+Alt+U | Rename, Pin, Mark read |
| Cenários | Arquivar | Ctrl+Shift+Backspace (ou Ctrl+Alt+A) | Archive session |
| Cenários | Bifurcar cenário | Ctrl+Alt+O | Fork |
| Cenários | Copiar link do cenário | Ctrl+Alt+L | Copy link |
| Cenários | Abrir o PR da entrega | Ctrl+Alt+G | Open PR |
| Cenários | Visão geral | Ctrl+Alt+N | Overview |
| Cenários | Mensagem anterior / seguinte do Produtor | Alt+↑ / Alt+↓ | Jump to previous / next prompt |
| Tela dividida | Abrir à direita / abaixo | Ctrl+Alt+\ / Ctrl+Alt+- | New split right / below |
| Tela dividida | Foco na próxima / anterior | Ctrl+] / Ctrl+[ | Focus next / previous split |
| Tela dividida | Fechar a divisão; abrir cenário na divisão | Ctrl+Alt+W; Alt+clique | Close split; Alt+click |
| Painéis | Mudanças (diff) | Ctrl+Shift+D | Changes |
| Painéis | Navegador compartilhado (5.19); indicar elemento | Ctrl+Shift+B; Ctrl+Shift+S | Browser; Select element |
| Painéis | Nova aba do navegador; barra de endereço | Ctrl+T; Ctrl+L | New browser tab; Focus address bar |
| Painéis | Arquivos; anexar a seleção ao chat | Ctrl+Shift+F; Ctrl+Shift+L | Files; Attach selection as context |
| Painéis | Terminal; comando seguinte / anterior | Ctrl+\`; Ctrl+↓ / Ctrl+↑ | Terminal |
| Painéis | Chat lateral | Ctrl+; | Side chat |
| Caixa de texto | Enviar / nova linha | Enter / Shift+Enter | Send / New line |
| Caixa de texto | Menu de modelo / de esforço | Ctrl+Shift+. / Ctrl+Shift+E | Model selector / Effort |
| Caixa de texto | Anexar arquivo; ditado | Ctrl+U; Ctrl+D | File upload; Dictation |
| Caixa de texto | Última mensagem; buscar no histórico | ↑ com a caixa vazia; Ctrl+R | Last message; Search prompts |
| Caixa de texto | Enfileirar enquanto o Diretor trabalha; enviar num cenário bifurcado | Ctrl+Enter; Ctrl+Alt+Enter | Queue; Send in forked session |
| Caixa de texto | Parar a resposta; voltar ou editar a última mensagem | Esc; Esc Esc | Stop; Rewind |
| Global | Chat rápido, com o app em segundo plano (só desktop) | Ctrl+Alt+K | Quick chat |

No macOS, a tecla Ctrl da tabela vira Cmd, menos nos atalhos em que o Claude usa Ctrl de propósito, como Ctrl+Tab e Ctrl+\`. A tela dividida usa Cmd+Ctrl. **[N]** até a conferência num Mac. A tecla do menu de modelo diverge entre o registro (Ctrl+Shift+.) e a tela de atalhos do Claude (Cmd+Shift+I); vale o registro, e isso será conferido na Fase 13 **[N]**. Duas ações do Claude não têm equivalente: trocar de organização (Ctrl+Alt+S), porque o OTheater não tem organizações, e o modo anônimo, que fica de fora porque o log de eventos (P6) é a base da auditoria. Por isso essas combinações ficam livres.

**O que cada capacidade é no OTheater.** A sessão do Claude corresponde ao cenário (5.20), e o painel lateral dele corresponde ao painel de trabalho. Todas as capacidades abaixo entram nas Fases 12 e 13 (decisão do dono, 2026-11-15). As que rodam no navegador entram na web, e as nativas, no desktop.
- **Mudanças:** diff do worktree de cada demanda e da integração, com navegação entre mudanças e comentários. Um comentário numa faixa de linhas vira a indicação `code_snippet` (5.19), anexada à mensagem do chat. Visualizador: CodeMirror 6 com `@codemirror/merge` ou o editor de diff do Monaco, os dois MIT **[a confirmar na 6.0]**.
- **Arquivos:** árvore do worktree do cenário, só leitura. A seleção vira `code_snippet` ou anexo `A<n>` (5.20).
- **Terminal:** porta nova `TerminalSession` (5.18). O shell é filho do daemon e roda sob o `ProcessLauncher` e o `Sandbox`, no worktree do cenário. A tela é transmitida por WebSocket (5.12), e por isso funciona igual na web e no desktop, como o navegador compartilhado.
  - Adaptador: `node-pty`; na tela, xterm.js, os dois MIT **[a confirmar na 6.0]**.
  - Chave `app.terminal`: `sandbox` (padrão: a mesma contenção dos Atores, decisão do dono, 2026-11-15), `host` (shell comum do usuário, sem sandbox, como no Claude Desktop) ou `off`.
  - A saída selecionada vira a indicação `terminal_snippet` (5.19).
  - **Integração do Claude Desktop** (decisão do dono, 2026-11-15, N43). São três peças:
    - **Comando do Produtor pelo chat.** Uma mensagem que começa com `!` roda como comando, e não vai ao Diretor. Ela roda numa `TerminalSession` do cenário e respeita o modo de `app.terminal`. A saída entra na conversa como `terminal_snippet`. Entra na **Fase 7, na TUI**, e a web e o desktop herdam na Fase 12. **[proposta]** para o resto:
      - quando o comando pede entrada (senha, confirmação), a captura para e a conversa registra isso. Na TUI, o Produtor assume o terminal: o Ink se suspende e devolve a tela ao processo, como ao abrir um editor; ao sair, a TUI volta. Na web e no desktop, ele digita no painel de Terminal;
      - chaves: `chat.shell_command: on | off` (padrão `on`); `chat.shell_command.context: auto | ask | never` (a saída entra na conversa sempre, depois de perguntar ou nunca; padrão `auto`); `terminal.snippet.max_lines` (padrão 200, com o resto resumido e o arquivo completo no log da sessão).
    - **Ferramentas de terminal para o Ator:** `terminal_list`, `terminal_read` (últimas linhas e espera por saída nova) e `terminal_run`, oferecidas pelo servidor MCP do próprio OTheater às sessões ACP. Entram na **Fase 12**, com o painel. **[proposta]** para o resto:
      - chave `actors.terminal_tools: off | read | ask | auto` (padrão `ask`: ler é livre, e rodar um comando pede aprovação do Produtor);
      - o que o Ator lê do terminal é dado, nunca instrução, como o texto lido na web ou num arquivo (5.17, R17). O Ator nunca digita senha nem código de verificação: deixa o pedido no chat, e quem digita é o Produtor;
      - a saída passa por uma redação de segredos (chaves de API e tokens reconhecíveis) antes de ir ao Ator ou ao log;
      - com `app.terminal: host`, o Ator lê o shell comum do usuário, e por isso a aprovação vale por comando.
    - **Saída ao vivo dos comandos do Ator.** O cliente ACP do OTheater declara `_meta.terminal_output_delta` no `initialize`. O adaptador do Claude (claude-agent-acp 0.107.0) responde mandando a saída do Bash como terminal de exibição (`terminal_info`, `terminal_output_delta`, `terminal_exit`) **[V, pela leitura do código, 2026-11-15]**. O OTheater grava essa saída no log de eventos, e as Trajetórias a mostram a partir da Fase 7. Detalhes:
      - O comando continua rodando dentro do cliente oficial; o OTheater só exibe. O ACP também tem `terminal/create`, pelo qual o cliente executaria o comando do agente: o SDK tem o método **[V]**, mas o adaptador do Claude não o chama **[V]**. Por isso, o shell do Ator não passa pelo PTY do OTheater, e a regra da seção 3 para o que o ACP não resolve (N42) vale aqui.
      - Codex e OpenCode: **[N]**, a medir na Fase 2.
      - Os spikes da Fase 0 declaravam `terminal: false`.
- **Tela dividida:** dois ou mais cenários lado a lado, cada um com o seu chat. O layout é persistido com as outras preferências.
- **Chat lateral:** conversa paralela com o Diretor sobre o cenário. Ela não entra no chat principal e não muda a peça. O Produtor pode promover uma resposta a mensagem do chat ou a ordem (5.17).
- **Bifurcar:** cria um cenário novo, do mesmo tipo, com o chat e as ordens até a mensagem escolhida. Peças em andamento não são copiadas. O que se copia em cada tipo de cenário é detalhado na Fase 12 **[a definir]**.
- **Voltar ou editar a última mensagem:** só enquanto o Diretor não agiu sobre ela. Depois disso, a edição vira uma mensagem nova que corrige a anterior, porque o log de eventos não se reescreve (P6).
- **Enfileirar:** a mensagem enviada enquanto o Diretor trabalha entra numa fila do cenário e é entregue no próximo ponto de julgamento.
- **Parar (Esc):** interrompe a resposta do Diretor no chat, mas não pausa a peça. Pausar fica na paleta, com confirmação.
- **Modelo e esforço:** os menus mostram o Executor do Diretor do cenário, com as config options que o cliente anuncia (5.7). A troca vale como override do cenário. O modo rápido aparece só se o cliente anunciar a opção.
- **Ditado:** porta nova `Dictation`, com o motor escolhido por medição na Fase 12 entre o modelo local pelo daemon (whisper.cpp, MIT **[a confirmar na 6.0]**) e o reconhecimento do sistema. Chave `app.dictation.engine`. O Electron não traz o reconhecimento de voz do Chrome **[N]**.
- **Chat rápido global:** só no desktop. Uma janela pequena, aberta mesmo com o app em segundo plano, manda a mensagem a um chat genérico novo ou ao cenário escolhido. Chave `app.quick_chat.shortcut`, com `off` para desligar.
- **Copiar link:** endereço do cenário na web e link profundo `otheater://` no desktop.

**Android, celular e tablet (Fase 14, depois da web).** Decidido em 2026-11-14, a pedido do dono.
- **Só cliente.** O daemon continua no computador, porque precisa dos CLIs oficiais, das worktrees e do cofre do sistema. O app fala com ele pela mesma API (REST, SSE e WebSocket), como a web.
- **Tecnologia: Capacitor** (Ionic; MIT **[a confirmar]**) embrulhando a web da Fase 12. Reaproveita as telas, os componentes e o `packages/client`. O que é novo:
  - o layout de celular;
  - os plugins nativos do Capacitor: leitor de QR, notificações e armazenamento seguro do token **[proposta]**.
- **Tablet: o app completo.** O layout de `mockup/app.html` (lateral, chat e painel em abas), com toque no lugar do mouse. Em retrato, a lateral e o painel viram gavetas sobre o chat **[proposta]**.
- **Celular: versão enxuta**, com uma coluna por vez e navegação inferior **[proposta]**. Tem:
  - o chat com o Diretor, com anexos (foto, arquivo);
  - as decisões pendentes, respondidas com um toque;
  - as cotas por assinatura (5 h e 7 dias, com o reset), os eventos e o estado das peças, tarefas e agenda;
  - pausar, retomar e cancelar.

  Fica de fora do celular: editar a configuração pesada (Executores, papéis, perfis, plugins), o DAG desenhado, as trajetórias longas e o navegador compartilhado. Essas telas aparecem só para leitura, ou o app indica abrir no computador **[proposta]**.
- **Comandos pelo celular** (`mockup/mobile.html`) **[proposta]**. Mandar uma ordem ao Diretor tem de caber em um ou dois toques:
  - o chat abre direto, com o composer embaixo, ao alcance do polegar; o topo mostra o destinatário, e um toque troca entre o Orquestrador global e o Diretor de cada cenário;
  - comandos rápidos em fichas acima do composer, que mudam com o estado do cenário (com peça rodando: como está, pausar, nova peça, resumo, agendar);
  - o botão `/` abre uma folha com busca e os comandos agrupados (peça atual, criar, consultar), mais as frases salvas do Produtor; a lista vem do registro de comandos do daemon (N44);
  - sem texto, o botão de enviar vira microfone (segurar para falar); o ditado do teclado do Android serve de alternativa sem plugin **[a confirmar]**;
  - comandos terminados em “…” preenchem um modelo para completar; os outros enviam na hora; consultas de estado (`/status`, `/cotas`) respondem pelo daemon, sem chamar o modelo;
  - ações destrutivas (cancelar a peça) pedem confirmação e biometria;
  - sem conexão com o daemon, a mensagem fica numa fila no aparelho e sai quando a VPN volta, além da `prompt_queue` do daemon.
- **Acesso ao daemon:** pela VPN do usuário, com pareamento por QR e token por aparelho (5.12).
- **Idioma:** o mesmo catálogo da web (5.22).
- **Em aberto:** as notificações (seção 12, item 19) e a distribuição (item 20).

### 5.14 Plugins

Plugin = **servidor MCP + manifesto** (+ painel declarativo opcional). É a camada **externa** de extensão (5.18): roda fora do processo do daemon.

```yaml
# plugin.yaml
id: postgres-db
version: 1.0.0
server:
  type: stdio            # ou http; o daemon agrega e expõe pelo servidor do framework
  command: ["node", "dist/server.js"]
tools:
  - name: query_sql
    roles: [actor, critic]
    specialties: [sql]
    effects: read         # read | local_write | network | external_write
  - name: migrate
    roles: [actor]
    effects: external_write
    requires_producer_approval: true
  - name: list_migrations
    roles: []             # só o painel usa
    effects: read
secrets: [PG_URL]        # resolvidos do cofre, injetados só no servidor do plugin
events: [migration_applied]    # publicados como plugin.postgres-db.migration_applied
panel:                    # opcional e declarativo: a TUI e a web desenham
  - type: table
    title: Migrações pendentes   # texto de tela: chave do catálogo i18n do plugin (5.22)
    source: list_migrations   # ferramenta do próprio plugin, com effects: read
  - type: action
    label: Migrar
    tool: migrate             # segue requires_producer_approval
```

- O daemon lê os manifestos, monta o conjunto de ferramentas de cada papel e gera as camadas 1 e 2 de permissão automaticamente.
- Ativação por projeto.
- **Painel declarativo** (decidido em 2026-11-13): o plugin descreve o painel em dados, validados por schema, e **nenhum código do plugin roda na interface**.
  - Tipos de bloco na v1: `table`, `list`, `metrics` e `action`. O schema do painel tem versão própria (5.18), e um tipo novo entra nele.
  - A `source` de um bloco só pode ser uma ferramenta do próprio plugin com `effects: read`.
  - Uma `action` chama uma ferramenta do plugin em nome do Produtor, pela API, com as mesmas permissões, aprovação e evento de qualquer chamada.
- **Eventos próprios:** o plugin só publica tipos com o prefixo `plugin.<id>.*`, declarados no manifesto.
- **Comportamento de mod, depois da v1** (decidido em 2026-11-13): não haverá um mecanismo de mods separado. O próprio plugin ganha **níveis opcionais**, declarados no manifesto e aprovados pelo Produtor na ativação, sempre fora do processo do daemon (P5):
  - **assinar eventos:** recebe os tipos de evento que declarou, só para leitura e em segundo plano (ex.: avisar quando uma peça termina);
  - **ganchos de interceptação:** o daemon chama o plugin em pontos fixos do fluxo (ex.: antes de uma ferramenta rodar, antes da entrega), com prazo. O gancho pode **vetar** ou **anotar**, nunca liberar permissão nem trocar o resultado de uma ferramenta;
  - **contribuições declarativas:** fluxos montados só com as etapas já registradas (5.20), fragmentos de prompt e atalhos, validados pelos schemas dos registros (5.18).
  - Na v1, o plugin fica como descrito acima. Os detalhes abaixo valem para quando os níveis entrarem.
- **Ganchos de interceptação** (decidido em 2026-11-14, v0.28, item 15 da seção 12; tudo depois da v1):
  - **Pontos**, todos com o mesmo contrato (entrada com schema fixo; saída `allow`, `veto` com motivo ou `annotate` com texto):
    - `attempt.before_start`: depois da seleção do Executor (5.7) e antes de abrir a sessão. Um veto conta como Executor indisponível para essa demanda, e a seleção segue para o próximo da lista; a anotação entra no prompt da tentativa como contexto marcado como vindo do plugin;
    - `tool.before`: antes de cada chamada de ferramenta de um Executor, **depois** das três camadas de permissão (5.8). O gancho só vê o que já foi permitido e só pode barrar. O veto volta ao Executor como erro da ferramenta, com o motivo;
    - `submit.before_accept`: depois da validação zod do `submit` (5.3). O veto volta ao Executor como saída inválida e conta no mesmo limite de `N` correções;
    - `delivery.before`: antes de abrir o PR, de fazer merge ou de enviar o artefato da tarefa (5.5 e 5.20). O veto para a entrega e vira decisão do Produtor no chat, com o motivo; sem ninguém olhando, segue a regra das tarefas agendadas (5.15).
  - Ponto novo entra um a um, com teste, como os outros registros (5.18).
  - **Prazo:** 5 s nos três primeiros pontos, que acontecem muito, e 30 s em `delivery.before`, que é rara e pode rodar uma checagem maior. Os ganchos de um mesmo ponto rodam em paralelo, e vale o primeiro veto **[proposta]**.
  - **Falha** (o plugin cai, responde fora do schema ou estoura o prazo): o manifesto declara `on_failure: allow | block` em cada gancho, e o Produtor vê isso ao ativar o plugin. Sem declaração, **deixa passar**. Em qualquer caso, fica um evento `plugin.hook_failed` e um aviso ao Produtor. Depois de 3 falhas seguidas, o gancho é desligado até o Produtor religar **[proposta]**.
  - Um gancho nunca vê segredos do cofre nem o conteúdo inteiro do prompt; recebe só os campos do schema do ponto **[proposta]**.

```yaml
# plugin.yaml (depois da v1)
hooks:
  - point: tool.before
    tools: [restricted_shell, git_commit]   # filtro opcional
    on_failure: block                       # allow (padrão) | block
  - point: delivery.before
    timeout: 20s                            # override do plugin, até o teto do ponto

# configuração do daemon
plugins:
  hooks:
    timeout: 5s                  # padrão dos pontos
    timeout_by_point:
      delivery.before: 30s
    disable_after_failures: 3    # 0 = nunca desliga  [proposta]
```

- **Sondas de cota e notificadores por plugin** (decidido em 2026-11-14, v0.28, item 15): `QuotaProbe` e `Notifier` (5.18) podem vir de um plugin, sem virar pacote oficial. O plugin declara no manifesto que implementa a porta (`implements: QuotaProbe` ou `Notifier`) e expõe ferramentas MCP com o schema fixo da porta. O daemon roda a suíte de conformidade da porta na ativação e recusa o plugin que não passa. A sonda só entrega dados de cota, que a seleção usa como qualquer outra sonda; o notificador só recebe a mensagem já pronta. Os **tipos de indicação** (5.19) continuam só oficiais, porque mexem no prompt e na interface.

### 5.15 Agendador (tarefas agendadas e repetidas)

O daemon dispara peças sozinho, no horário: o agendador age como se você tivesse escrito a necessidade no chat. Não há pipeline novo. A peça agendada passa pela mesma máquina de estados, seleção de Executores, permissões e eventos de qualquer outra.

**Tarefa agendada = modelo de peça**, guardado no store (tabela `schedules`, seção 7). Desde a v0.14, o mesmo agendamento também dispara a execução de um cenário do tipo tarefa (5.20). Nesse caso, ele aponta para a tarefa e a versão da definição, em vez de uma necessidade, e os campos abaixo de projeto não se aplicam. O agendamento de um projeto tem:
- cenário: projeto e branch base;
- texto da necessidade (ex.: "atualizar dependências e corrigir o que quebrar");
- overrides opcionais: executores por papel (chave `roles`, com a mesma forma do override por cenário, 5.7), limites, timeout;
- **política de entrega:** abrir PR por padrão. Merge direto só se o projeto permitir **e** a tarefa pedir explicitamente;
- **orçamento por execução:** teto de tempo total e, para perfis de API, de custo. Estourou, a peça para e notifica.

**Tipos de agendamento:**

| Tipo | Exemplo | Observação |
|---|---|---|
| Uma vez | 20/11 às 22h | Some da lista depois de rodar (fica no histórico) |
| Repetida por calendário | cron `0 7 * * 1-5` com fuso `America/Sao_Paulo` | Dias úteis às 7h; o fuso é sempre explícito |
| Repetida por intervalo | a cada 6 h | Conta a partir do fim da execução anterior |
| Logo após o reset da cota | "depois do próximo reset de claude-code/empresa" | Usa o `resetsAt` das sondas de cota (5.6) para aproveitar a janela cheia |

Biblioteca: **croner** (TypeScript, cron com fuso horário e sem dependências; licença MIT **[a confirmar]**). O próximo disparo de cada tarefa é recalculado e gravado no SQLite, então sobrevive a reinícios do daemon.

**Regras por tarefa** (com padrões globais na aba Configurações › Limites):

| Situação | Opções | Padrão |
|---|---|---|
| **Execução perdida** (máquina desligada ou daemon parado no horário) | rodar uma vez ao voltar / pular | rodar uma vez, se o atraso for menor que a janela configurada (padrão 12 h); senão, pular e registrar |
| **Sobreposição** (a execução anterior ainda roda) | pular / enfileirar / cancelar a anterior | pular e registrar |
| **Cota** (assinaturas do papel esgotadas) | adiar até o reset / usar a regra do papel (`next`/`wait`) / pular | adiar até o reset, dentro de um prazo máximo |
| **Decisão do Produtor sem ninguém olhando** | esperar um prazo e seguir com a recomendada / pausar e notificar (e cancelar depois do prazo) / resposta padrão definida na tarefa | esperar um prazo e seguir com a recomendada (v0.26; era pausar e notificar), nunca numa decisão irreversível além da opção segura (5.3) |

**Notificações:** ao terminar, falhar, pausar ou pedir decisão.
- Sempre no chat do cenário e como evento (`schedule.*`).
- Notificação do sistema operacional, quando houver sessão gráfica.
- E-mail, webhook ou chat corporativo via plugin (seção 5.14).

**Máquina dormindo.** O daemon sozinho não acorda a máquina. Além disso, o Modern Standby do Windows estrangula processos em segundo plano com a tela bloqueada (problema já visto em outro projeto desta máquina, com uma fila de envio que atrasou horas). Duas medidas:
1. **Acordar no horário:** ao salvar uma tarefa, o daemon registra um gatilho no agendador do sistema operacional. O gatilho acorda a máquina e chama `ot run <task>`, que entrega o disparo ao daemon (e o inicia, se preciso):
   - Windows: Agendador de Tarefas, com "despertar o computador";
   - macOS: launchd, com `pmset` para despertar;
   - Linux: timer do systemd com `WakeSystem=`.
2. **Manter acordada durante a execução:** pedido de energia ao sistema enquanto houver peça agendada rodando:
   - Windows: `SetThreadExecutionState` + Power Request;
   - macOS: `caffeinate`/IOPMAssertion;
   - Linux: inibidor do systemd-logind.

   O pedido é liberado ao fim da peça.

**Criação e controle:**
- **Aba Agenda** no painel (TUI e web):
  - lista de tarefas com próxima execução e estado;
  - histórico de execuções com resultado e link para a peça;
  - ações pausar, retomar, editar, duplicar, excluir e "rodar agora".
- **Pelo chat:** "toda segunda às 8h, revise as dependências do loja-api". O Orquestrador chama a ferramenta MCP `schedule(...)`, que **não salva direto**: devolve um rascunho que aparece no chat como decisão do Produtor (confirmar / editar / cancelar). Ferramentas `list_schedules` e `pause_schedule` completam o conjunto do Diretor.
- **Pelo terminal:**
  - `ot schedule list|add|pause|resume|rm`;
  - `ot run <task>`, que também é o comando chamado pelo gatilho do sistema operacional.

**Repetição até uma condição** ("rodar até os testes passarem") **não** é agendamento: já é o ciclo de correção do próprio pipeline (Crítico → correção, com os limites `Nc` e de tentativas).

**Padrões do agendador** (decidido em 2026-11-14, N13). As regras acima são chaves de configuração, com valor global e override por tarefa. O padrão é a predefinição `balanced`. Valem também para os cenários do tipo tarefa (5.20).

```yaml
schedule:
  preset: balanced             # balanced | conservative | relaxed
  missed_run:
    mode: run_once             # run_once | skip
    window: 12h                # atraso máximo para rodar; 0 = sem limite
  overlap: skip                # skip | queue | cancel_previous
  quota_exhausted:
    mode: postpone             # postpone | role_rule | skip
    max_postpone: 6h           # 0 = até o reset, sem prazo; estourou, pula e notifica
  unattended_decision:
    mode: wait_then_recommended  # wait_then_recommended | pause_notify | default_answer
    wait_for: 1h               # wait_then_recommended: espera antes de seguir com a recomendada
    timeout: 24h               # pause_notify: 0 = espera sem prazo; estourou, cancela e registra
  budget:
    max_time: 1h
    max_api_cost_usd: 5        # só perfis de API
```

| Predefinição | Janela da perdida | Adiamento por cota | Segue com a recomendada após | Espera por decisão (`pause_notify`) | Tempo | Custo (API) |
|---|---|---|---|---|---|---|
| `balanced` (padrão) | 12 h | 6 h | 1 h | 24 h | 1 h | US$ 5 |
| `conservative` | 2 h | 2 h | 2 h | 4 h | 30 min | US$ 2 |
| `relaxed` | 24 h | até o reset | 30 min | sem prazo | 2 h | US$ 10 |

- **Decisão sem ninguém olhando** (decidido em 2026-11-14, v0.26, item 24 da seção 12, revendo o padrão do item 13): o padrão passa a ser `wait_then_recommended`, que espera o prazo da predefinição e segue com a opção recomendada da pergunta (5.3), com o evento registrando a escolha automática. Os prazos padrão de 1 h (`balanced`), 2 h (`conservative`) e 30 min (`relaxed`) foram escolhidos pelo dono, e cada um muda na chave `wait_for`, globalmente ou por tarefa. `pause_notify` e `default_answer` continuam como alternativas. Nas decisões irreversíveis, a recomendada é sempre a opção segura, e o risco R13 segue coberto pela entrega por PR.

- A predefinição (`preset`) preenche todos os valores de uma vez. Uma chave individual sobrepõe só o valor dela **[proposta]**.
- O schema zod vem do módulo dono das chaves e é validado na subida (5.18). A aba Configurações › Limites e `ot config` mostram e mudam as chaves.

### 5.16 Interrupção e retomada de sessões

Qualquer sessão de Executor (Autor, Revisor, Roteirista, Ator, Crítico, e também o Orquestrador) pode ser interrompida no meio do trabalho:
- cota esgotada;
- erro do provedor ou da rede;
- queda do processo do cliente;
- reinício do daemon ou da máquina;
- timeout;
- agente travado.

O daemon precisa saber **por que** parou, **o que já foi feito** e **como continuar**, sem perder trabalho nem repetir efeitos colaterais.

#### Duas formas de retomar

| Forma | Como | Quando dá | Vantagem | Limite |
|---|---|---|---|---|
| **Nativa** | `session/load` do ACP: o cliente recarrega a própria conversa (histórico, contexto, chamadas de ferramenta) e o daemon envia um prompt de continuação | Mesmo cliente, **mesmo perfil** (as conversas ficam no diretório do perfil: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`…), mesma worktree e adaptador que anuncia `loadSession` | Continua exatamente de onde parou, com todo o contexto | Não atravessa clientes nem contas; depende dos arquivos do cliente continuarem lá |
| **Passagem de bastão** (*handoff*) | Sessão **nova**, em qualquer Executor, com um **pacote de continuação** montado pelo daemon | Sempre | Funciona entre modelos, clientes e assinaturas; é o que permite trocar de conta quando a cota acaba | Perde o raciocínio interno; depende da qualidade do pacote |

**Pacote de continuação**, montado a partir do store, nunca da memória de um modelo:
1. demanda, contrato, critérios de aceite e ordens vigentes no momento da retomada (o mesmo prefixo estável de qualquer Executor do papel);
2. **estado da worktree**: commit de checkpoint mais recente e diff em relação à base da tentativa;
3. **resumo da trajetória**, gerado de forma determinística a partir dos eventos:
   - arquivos lidos e editados;
   - comandos e testes rodados, com resultado;
   - última mensagem do agente;
   - decisões do Produtor já respondidas;
4. **efeitos colaterais já executados**: commits, instalações, chamadas de plugin com escrita (seção abaixo);
5. **motivo da interrupção** e instrução explícita: "continue a partir deste estado; não refaça o que está listado como concluído".

Opcionalmente, um modelo barato (o do Diretor) condensa o resumo quando a trajetória é longa. O resumo determinístico continua anexado, como fonte da verdade.

Para papéis de saída curta (Revisor, Roteirista, Crítico), a passagem de bastão costuma ser simplesmente **refazer** com as anotações parciais. Para o **Orquestrador**, vale o failover já descrito em 5.4.

#### Política por causa

O daemon classifica a causa pelos sinais disponíveis:
- `stopReason` do ACP;
- código de saída do processo;
- `rate_limit_event`/429 e sondas de cota (5.6);
- timeout do próprio daemon;
- detecção de travamento: sem evento por N minutos, ou o mesmo erro de ferramenta repetido.

| Causa | Ação padrão | Conta como tentativa? |
|---|---|---|
| **Cota esgotada**, reset próximo (dentro do limite configurado) e regra do papel `wait` | Aguardar o reset e retomar **nativa** no mesmo perfil | Não |
| **Cota esgotada**, reset distante ou regra `next` | **Passagem de bastão** para o próximo Executor disponível do papel (5.7) | Não |
| **Teto de gasto em API estourado** (5.6) | Pela chave `in_flight` do perfil: passagem de bastão (padrão), terminar a sessão ou parar e perguntar | Não |
| **Erro transitório** (rede, 5xx do provedor, sobrecarga) | Retomar **nativa** com recuo exponencial (ex.: 30 s, 2 min, 10 min); se esgotar, passagem de bastão | Não |
| **Queda do processo do cliente** | Retomar **nativa**; se o `session/load` falhar, passagem de bastão | Não, na primeira vez; sim, se repetir |
| **Reinício do daemon ou da máquina** | Para cada sessão `interrupted`: nativa se os arquivos do cliente existirem; senão, passagem de bastão | Não |
| **Timeout da demanda** | Regra já existente (5.4): o Diretor avalia o parcial (aceito, passa pelo `verify` e pela integração antes do Crítico; ou vai para outro Ator); a continuação é passagem de bastão | Sim |
| **Agente travado ou em laço** | Passagem de bastão para **outro** Executor (diversidade) | Sim |
| **Recusa do modelo** ou erro de permissão | Ponto de julgamento do Diretor (5.4): reformular, trocar de Executor ou perguntar ao Produtor | Sim |

**Interrupções de causa externa** (cota, rede, queda, reinício) **não** consomem as tentativas da demanda. Só contam as falhas atribuíveis ao agente. Um limite próprio de retomadas por tentativa (padrão 5) evita laço infinito: passou disso, o caso vai a um ponto de julgamento do Diretor (5.4).

#### Checkpoints

- **Commit de checkpoint automático** na branch da tentativa:
  - a cada lote de edições, ou a cada N minutos com mudanças;
  - na interrupção, qualquer que seja a causa (não só no timeout, como na v0.8).
- Os commits de checkpoint são marcados (`wip(checkpoint): …`) e **reescritos num único commit** na integração (`INTEGRATING`), sem poluir o histórico.
- O daemon guarda por tentativa:
  - a referência da sessão ACP;
  - o perfil e a worktree;
  - o último checkpoint;
  - o último evento processado.

  Isso é o mínimo para decidir entre retomada nativa e passagem de bastão.

#### Efeitos colaterais e idempotência

Retomar não pode repetir o que já mudou o mundo fora da worktree:
- toda chamada de casca ou plugin com efeito (`git_commit`, `install_deps`, ferramentas de plugin marcadas `local_write`, `network` ou `external_write`) recebe uma **chave de idempotência** (`attempt + step`) e é registrada como evento antes e depois da execução;
- se a mesma chave chegar de novo após uma retomada, a casca devolve o resultado gravado em vez de executar outra vez;
- plugins com `external_write` precisam declarar no manifesto se aceitam chave de idempotência. Os que não aceitam exigem confirmação do Produtor antes de serem repetidos numa retomada.
- um efeito com "antes" e sem "depois" (reinício ou queda no meio da chamada) é **ambíguo**. A reconciliação (5.21) o resolve pelo verificador da ferramenta ou pergunta ao Produtor; nunca o repete às cegas.

#### Máquina de estados da tentativa

```
EXECUTING ──(interrupção)──→ INTERRUPTED(cause)
INTERRUPTED → AWAITING_RESUME (reset de cota, virada do período do teto, recuo, vaga no pool)
AWAITING_RESUME → RESUMING(native | handoff) → EXECUTING
RESUMING(native) ──falhou──→ RESUMING(handoff)
retomadas > limite → ponto de julgamento do Diretor (5.4), sem passar por DECIDING
```

Tudo vira evento (`session.interrupted`, `session.resumed`, com causa, forma e Executor de origem e destino) e aparece no chat como mensagem de sistema. Exemplo: "D2 interrompida: cota de codex/conta-1 esgotada; retomada em sonnet-medium por passagem de bastão".

#### Padrões da retomada

Decidido em 2026-11-14 (N14). Os valores são chaves de configuração, com valor global e override por projeto. O padrão é a predefinição `balanced`.

```yaml
resume:
  preset: balanced             # balanced | patient | agile
  max_resumes: 5               # por tentativa; passou, vai ao ponto de julgamento do Diretor
  max_free_resumes: 3          # retomadas de sessão derrubada pela escalada do cancelamento (5.2, N64) que não contam em max_resumes; passou, contam (v0.55, N66; igual nas três predefinições; o contador fica no registro da tentativa e sobrevive ao reinício do daemon, v0.56, N67)
  quota_wait_max: 30m          # reset mais perto que isso, com regra wait: espera; senão, passa o bastão
  checkpoint_every: 10m        # só se houver mudança; além do lote de edições e da interrupção
  stuck:                       # agente travado: o que vier primeiro
    no_event_for: 10m
    same_error_times: 3
  transient_backoff: [30s, 2m, 10m]   # erro transitório; esgotou, passa o bastão
```

| Predefinição | Retomadas | Espera pelo reset | Checkpoint | Sem evento | Mesmo erro |
|---|---|---|---|---|---|
| `balanced` (padrão) | 5 | 30 min | 10 min | 10 min | 3 vezes |
| `patient` | 8 | 2 h | 15 min | 20 min | 5 vezes |
| `agile` | 3 | 10 min | 5 min | 5 min | 2 vezes |

- A predefinição (`preset`) preenche todos os valores de uma vez. Uma chave individual sobrepõe só o valor dela **[proposta]**.
- O schema zod vem do módulo dono das chaves e é validado na subida (5.18). A aba Configurações › Limites e `ot config` mostram e mudam as chaves.
- O recuo do erro transitório (`transient_backoff`) não muda com a predefinição **[proposta]**.

### 5.17 Ordens do Produtor (globais e locais)

Conceito trazido do `okit` (ordens permanentes, `kit orders`) e redesenhado aqui. Nenhum código do kit é reaproveitado (decisão Q12 de `docs/13-DECISOES-EM-ABERTO.md`). No `okit`, a ordem tinha só um prazo final opcional (`validUntil`) e a revogação com motivo. Aqui ela ganha período de vigência, duração, janela recorrente, prorrogação, revogação programada e suspensão local de uma global.

**Ordem** é uma instrução do Produtor que vale além de uma peça. Ela continua em vigor entre peças, sessões, compressões de contexto, failover e reinícios, durante a sua vigência e até ser revogada. Exemplos:
- "mensagens de commit em português" (permanente);
- "sempre me apresente as dúvidas como múltiplas escolhas, para eu decidir" (exemplo dado pelo dono em 2026-11-13; era uma `instruction` ao Diretor, e desde a v0.26 é o padrão em código, `chat.producer_questions: choices`, 5.3; como ordem, vira uma `rule` com `choices_strict`);
- "fazer push sempre que commitar" (global, `rule` com a chave `git.push_after_commit`, porque quem faz commit e push é o daemon e um texto não mudaria isso; exemplo dado pelo dono em 2026-11-13);
- "não alterar `infra/` sem perguntar" (local a um projeto);
- "não usar o perfil claude-code/empresa para Atores até sexta 18h" (com prazo).

#### Escopo

| Escopo | Vale para | Exemplo |
|---|---|---|
| **Global** | Todos os cenários (projetos, tarefas e chats), inclusive os criados depois | "Respostas em português do Brasil" |
| **Local** | Um cenário: um projeto, uma tarefa ou um chat | "No loja-api, toda mudança de schema vem com migration" |

- **Uma ordem global é um único registro**, não uma cópia por cenário. Cenários novos a herdam sem passo extra, e não há cópias para divergir. No `okit`, a ordem "para todos" era copiada em cada projeto, com grupo e aviso de divergência.
- **Precedência (decidida em 2026-11-13):** no mesmo cenário, a local prevalece sobre a global. O prompt mostra as duas listas separadas e diz isso explicitamente. Para `rule`, o daemon aplica a local.
- **Um cenário ou todos (decidido em 2026-11-13):** não há ordem para uma lista de cenários nem por tag. Para valer em alguns cenários, cria-se uma ordem local em cada um.
- **Suspensão local de uma global** (mantida por decisão de 2026-11-13): para que uma global não valha num cenário, o Produtor cria uma ordem local do tipo `suspension`, que aponta para a global (ex.: "suspender O3 no loja-api até 30/11"). A global some do prompt daquele cenário enquanto a suspensão vigora. A global não é editada, e os outros cenários não mudam.
- **`roles` (opcional):** limita a quais papéis a ordem chega (ex.: só Atores e Crítico). Sem o campo, chega a todos. Mantém o contexto mínimo (P8).

#### Tipos, sem texto mágico

| Tipo | O que é | Quem aplica |
|---|---|---|
| `instruction` | Texto livre para os modelos | Os modelos, pelo prompt; o Crítico confere |
| `rule` | Override de uma chave de configuração que já existe, dentro do escopo e da vigência da ordem. Ex.: tirar um perfil da lista de um papel (5.7), trocar a regra `next`/`wait`, exigir PR na entrega | O daemon, em código (P3) |
| `suspension` | Tira uma ordem global de um cenário, durante a vigência da suspensão | O daemon, ao montar o prompt e ao aplicar as `rule` |

- O daemon **não interpreta o texto** de uma `instruction`: ela nunca muda o fluxo nem a permissão. No `okit`, um texto como `critic-waiver passo-N` tinha efeito em código; aqui, o que precisa ter efeito garantido é `rule`.
- Uma `rule` só aceita chaves de uma lista fechada, validada por schema zod. **Na v1 (decidido em 2026-11-13), a lista tem quatro chaves:** os perfis da lista de um papel (tirar ou reordenar, 5.7), a regra `next`/`wait` da cota, a exigência de PR na entrega e `git.push_after_commit`. A v0.26 acrescentou duas, `chat.producer_questions` e `chat.unanswered` (5.3), e a lista ficou com seis. Com `git.push_after_commit`, depois de cada `git_commit` o daemon faz push da branch da demanda. Ele nunca faz force push nem push na branch base, que só recebe pela entrega (5.5). Chaves novas entram uma a uma, cada uma com teste. **Chaves de permissão (5.8) ficam fora**: permissão se muda na configuração do papel, não por ordem.
- **Conflito de `rule`:** duas `rule` sobre a mesma chave, no mesmo escopo e com vigências que se sobrepõem, são recusadas na criação. O rascunho mostra a ordem conflitante, e o Produtor revoga uma delas ou ajusta a vigência. Entre global e local, vale a precedência.
- Quando uma `rule` muda uma decisão do daemon, o evento cita o id da ordem (ex.: `executor.selected` com motivo "ordem O7"). A descrição do PR lista as `rule` que afetaram a peça.
- **Dispensa do Crítico não é ordem** (decidido em 2026-11-13). No `okit`, uma ordem com o texto `critic-waiver passo-N` dispensava o crítico. Aqui, o Produtor dispensa o Crítico por uma **decisão registrada** (`decide`, tabela `decisions`), com motivo, para a peça inteira, ao abrir a peça ou depois de uma reprovação (5.4). Nenhuma ordem, nem `rule`, dispensa o Crítico.

#### Vigência (período de validade)

Toda ordem tem uma vigência: **início** e **fim**, os dois opcionais, com fuso explícito (padrão `America/Sao_Paulo`, configurável). Sem início, vale a partir da confirmação. Sem fim, vale até ser revogada.

| Forma | Exemplo | Como é gravada |
|---|---|---|
| Permanente | "a partir de agora, commits em português" | início = confirmação; sem fim |
| Até uma data | "até sexta 18h" | fim = sexta 18:00 |
| Por uma duração | "pelas próximas 2 h", "por 3 dias" | fim = confirmação + duração |
| Período futuro | "de 20/11 a 27/11" | início e fim; fica `scheduled` até o início |
| Janela recorrente (**depois da v1**, decidido em 2026-11-13) | "em dias úteis, das 9h às 18h" | expressão cron de abertura + duração da janela, com fuso (croner, 5.15), dentro do início e do fim |

- **Tudo vira data absoluta na confirmação.** O rascunho mostra o início e o fim já calculados ("vale de 13/11 14:32 a 16/11 14:32"), para o Produtor ver o que vai valer. A duração conta da confirmação, não do pedido.
- **Data sem hora:** o início vale às 00:00 e o fim às 23:59:59 do dia, ou seja, o dia inteiro conta.
- **Estados:** `scheduled` → `active` → `expired`; `scheduled` ou `active` → `revoked`. `expired` e `revoked` são finais. Uma ordem com janela fica `active` durante toda a vigência, mas só entra no prompt e só aplica a `rule` com a janela aberta.
- **O relógio decide, não o timer.** Se a ordem vale agora é uma função pura de (agora, início, fim, janela), calculada a cada uso: ao montar um prompt, ao aplicar uma `rule`, ao listar. O croner só dispara os eventos e avisos nas fronteiras. Com a máquina dormindo ou o daemon parado, nenhuma ordem vencida é aplicada. Ao reiniciar, o daemon emite as transições que perdeu, com o horário real da fronteira (`effective_at`).
- **Prorrogar e antecipar:** a vigência é o único campo que muda depois da criação, por `extend_directive` (chat, aba ou terminal), e só enquanto a ordem não é final. Cada mudança gera o evento `directive.validity_changed` com os valores antigo e novo. Texto, escopo, tipo e papéis não mudam: para mudá-los, revoga-se e cria-se outra (ver Revogação, abaixo).
- **Avisos:** no chat do cenário e na aba Ordens, 24 h antes do fim (configurável; padrão decidido em 2026-11-13), no início de uma ordem `scheduled`, e quando ela expira.

#### Revogação

Revogar encerra a ordem antes do fim da vigência. Regras:
- **Só o Produtor revoga**, pelos mesmos canais da criação. O Diretor pode **sugerir** uma revogação (ex.: duas ordens em contradição), mas `revoke_directive` só devolve um rascunho que o Produtor confirma.
- **Motivo obrigatório**, numa linha. No chat, o rascunho já vem com o motivo tirado das palavras do Produtor.
- **Imediata ou programada:** "revogar agora" vale na confirmação. "Revogar a partir de sexta" não é revogação: é antecipar o fim para sexta (prorrogar), e a ordem termina `expired`.
- **Em lote:** por escopo ou filtro ("todas as ordens do chat X", "todas as `rule` sobre o perfil claude-code/empresa"). O rascunho lista cada ordem afetada, e cada uma gera o próprio evento.
- **É definitiva.** Uma ordem revogada não volta. Para reativar, cria-se uma ordem nova a partir dela; o campo `supersedes` liga as duas, e o histórico mostra a cadeia.
- **Revogar uma global num só cenário** é suspensão (tipo `suspension`), não revogação.

**Efeitos da revogação, da expiração e do início de uma ordem no meio do trabalho:**
1. **Sessões novas** já nascem com o conjunto de ordens vigente.
2. **Sessões em curso** (decidido em 2026-11-13) não são alteradas, porque o prefixo é estável (5.10). O Diretor recebe um aviso pela fila única (5.4) e decide se cancela e relança o Ator (`cancel_actor`). O padrão é não relançar.
3. **`rule`:** passa a valer, ou deixa de valer, na próxima decisão do daemon. Ao deixar de valer, volta o valor que a configuração tem.
4. **Nada é desfeito.** O que foi feito sob a ordem fica, e o histórico mostra qual ordem estava vigente em cada peça.

#### Onde as ordens entram

1. **Orquestrador:** sempre recebe as ordens vigentes (globais e do cenário, já descontadas as suspensas). Avisos de criação, início, prorrogação, revogação e expiração entram pela fila única de prompts (5.4).
2. **Executores:** as ordens vigentes, filtradas por `roles`, entram no prefixo estável (5.10), logo depois das regras do projeto. Cada uma traz o id e, se tiver, o fim ("O7, até 16/11 18:00").
3. **Crítico:** recebe as `instruction` vigentes durante a tentativa como critérios adicionais. Violação é crítica negativa, como qualquer outra.
4. **Retomada e failover:** o resumo do failover (5.4) e o pacote de continuação (5.16) levam as ordens vigentes **no momento da retomada**, não as do início da sessão interrompida.
5. **Peças agendadas** (5.15) usam as ordens vigentes no horário do disparo.

#### Criação e controle

- **Só o Produtor cria.** Pelo chat ("a partir de agora, commits em português"), o Orquestrador chama `propose_directive(...)`, que **não salva direto**: devolve um rascunho que aparece no chat como decisão do Produtor (confirmar / editar / cancelar), como o `schedule` (5.15). O rascunho mostra escopo, tipo, papéis e a vigência em datas absolutas. `extend_directive` e `revoke_directive` seguem o mesmo caminho.
- **Executores não têm ferramenta de ordens.** Um texto lido na web ou num arquivo nunca vira ordem (injeção de prompt).
- **Aba Ordens** no painel (TUI e web): ordens vigentes, agendadas e encerradas, por escopo, com a linha do tempo da vigência; criar, prorrogar, suspender e revogar.
- **Pelo terminal:**
  - `ot directives list [--global | --scenario <name>] [--state ...]` e `ot directives show O<n>`;
  - `ot directives add "<text>" (--global | --scenario <name>) [--type ...] [--roles ...] [--from <date>] [--until <date> | --for <duration>] [--window "<cron>" --duration <duration>]` (`--window` depois da v1);
  - `ot directives extend O<n> (--until <date> | --for <duration>)`;
  - `ot directives suspend O<n> --scenario <name> [--until <date>]`;
  - `ot directives revoke O<n>... --reason "<text>"`.

#### Registro e histórico

- ids `O<n>` sequenciais, únicos no daemon e nunca reaproveitados;
- **nada é apagado**; revogadas e expiradas ficam no histórico;
- eventos `directive.created`, `directive.activated`, `directive.validity_changed`, `directive.expiring`, `directive.expired`, `directive.revoked` e `directive.suspended`. A abertura e o fechamento de janelas recorrentes não geram evento, para não encher o log; o estado é calculado pelo relógio.

**Importação do `okit`** (Q12, proposta a detalhar com o importador):
- as ordens ativas de cada projeto viram ordens locais do tipo `instruction`, com o `validUntil` como fim;
- cópias do mesmo grupo presentes em todos os projetos viram uma única ordem global;
- revogadas e expiradas entram como histórico;
- textos que tinham efeito em código no kit não são importados como texto: vão para uma lista que o Produtor decide.

### 5.18 Portas, adaptadores e registros (extensibilidade)

Decidido em 2026-11-13 (v0.12), a pedido do dono: como tudo é TypeScript, a arquitetura usa ao máximo as abstrações da linguagem. O objetivo é que trocar ou acrescentar um cliente, um provedor, um sistema operacional, um armazenamento ou um fluxo não exija mexer no núcleo. O desenho é de **portas e adaptadores** (P12):
- **porta:** interface TypeScript + schemas zod em `@otheater/core`, com versão própria;
- **adaptador:** implementação de uma porta, num pacote `@otheater/adapter-*`;
- **registro:** lista tipada em que os módulos oficiais contribuem entradas (fluxos, papéis, ferramentas, chaves de `rule`, tipos de evento...).
- **evento fora do registro** (decidido em 2026-11-17, N80): todo `append` do daemon passa pelo registro de tipos de evento. A chave `events.unknown_type` tem dois modos:
  - `reject` (padrão): um tipo fora do registro, uma `schemaVersion` sem suporte ou um payload fora do schema lança erro, e nada é gravado;
  - `warn`: o evento é gravado, e o log recebe um aviso com o tipo.

#### Regras

1. **Porta em toda fronteira e em todo ponto de variação.** Isso vale para tudo que fala com o mundo de fora (processos, rede, disco, git, cofre, sistema operacional, relógio) e para tudo que muda por cliente, provedor ou sistema. A lógica interna pura **não** tem porta: validação do roteiro, precedência e conflito de ordens, algoritmo de seleção e cálculo de vigência são funções puras em `@otheater/core`, testadas sem fakes.
2. **O núcleo não conhece implementações.** Fora do adaptador não há `if (client === 'codex')` nem `if (process.platform === 'win32')`. O núcleo pergunta as **capacidades** do adaptador, como o ACP faz no `initialize` (ex.: `loadSession`, multissessão, MCP HTTP, config options).
3. **Regra de dependência:**
   - `core` depende só do zod;
   - cada adaptador depende de `core` e das bibliotecas dele;
   - o daemon depende de `core` e só importa adaptadores no ponto de montagem.

   A CI verifica a regra com o `dependency-cruiser` (decidido em 2026-11-15, N49; licença MIT **[a confirmar]** na fonte antes de instalar).
4. **Erros tipados fazem parte do contrato** (`QuotaExhausted`, `AdapterUnavailable`, `PermissionDenied`, `Transient`...). A seleção (5.7) e a política de retomada por causa (5.16) decidem pelo tipo do erro, nunca pelo texto da mensagem.
5. **Toda porta nasce com três coisas:** um adaptador real, um adaptador falso para os testes e uma suíte de conformidade. Porta sem uso real não entra, para evitar abstração especulativa (R16).

#### Duas camadas de extensão

Decidido em 2026-11-13.

| Camada | Quem escreve | Onde roda | Como entra |
|---|---|---|---|
| **Interna** | o projeto (pacotes `@otheater/*`) | no processo do daemon | adaptador escolhido por id na configuração e montado no ponto de montagem |
| **Externa** | qualquer um | fora do processo | plugins MCP (5.14): ferramentas, painel declarativo e tipos de evento `plugin.<id>.*` |

- Código de terceiros **nunca** roda no processo do daemon nem na interface (P5).
- Um adaptador novo escrito por terceiros (ex.: outro cliente de agente) entra no projeto por PR, como pacote oficial, depois de passar na suíte de conformidade da porta. A exceção, depois da v1, são `QuotaProbe` e `Notifier`, que também podem vir de plugin, fora do processo, com a mesma suíte rodada na ativação (5.14, v0.28).
- **Dois eixos para clientes e modelos** (decidido em 2026-11-14, v0.23): o **cliente** é quem executa o agente (laço de ferramentas, sessão, login, ACP) e entra pelo `ClientAdapter` + `AgentSession`; o **servidor de modelo local** é onde o modelo roda e entra pelo `LocalModelServer`. Um servidor como o Ollama não é cliente de agente: suportá-lo é escrever um adaptador de `LocalModelServer`, não um `ClientAdapter`, que exigiria um laço de agente próprio. Qualquer cliente que fale com um modelo local usa essa porta. Na v1 é o OpenCode; o Codex (`codex --oss`) e o Claude Code (por um endpoint compatível com a API da Anthropic) podem usar o Ollama também, segundo fontes não verificadas nesta máquina **[a confirmar na Fase 0]**.
- Não existe "mod" em processo. O que um mod faria (reagir a eventos, interceptar o fluxo, contribuir fluxos e prompts) vira nível opcional do plugin depois da v1, na camada externa (5.14).

#### Portas

| Porta | O que abstrai | Adaptador padrão | Outros previstos |
|---|---|---|---|
| `ClientAdapter` | cliente de agente: comando, ambiente, perfil, login (5.2) | `claude-code`, `codex`, `opencode` | `gemini` |
| `AgentSession` | conversa com o Executor, normalizada: abrir, enviar prompt, receber o stream, cancelar, carregar (5.2). Desde a v0.43 **[proposta]**, é o contrato que a casca de cada cliente (descendente da `ClientAdapter`) devolve, em ACP normalizado | transporte ACP (`@agentclientprotocol/sdk`) dentro da casca | transporte headless (`claude -p`, `codex exec --json`), que é a saída de emergência |
| `ModelCatalog` | modelos de um cliente: lista, sugestão de campos e validação dos Executores (5.7); faz parte do `ClientAdapter` | descoberta automática (Claude Code, Codex); assistida pelo `opencode models --verbose` (OpenCode) | clientes novos |
| `LocalModelServer` | servidor de modelo local: saúde, modelos carregados, número de slots (5.9) | `llama-cpp`, `ollama` (N71) | LM Studio e vLLM, depois da v1 (N71) |
| `QuotaProbe` | sinal de cota de um provedor, lido fora da sessão; cada descendente da `ClientAdapter` oferece a do seu cliente, e o `QuotaService` do daemon a chama (5.6, v0.44 **[proposta]**) | statusline (Claude), `app-server` (Codex), `token_plan/remains` (MiniMax), erro de limite | provedores novos; depois da v1, também por plugin (5.14) |
| `UsageSource` | histórico de consumo (5.6) | ccusage | contabilidade local |
| `SecretVault` | cofre de segredos (5.6) | `@napi-rs/keyring` | arquivo criptografado com senha mestra; variável de ambiente do serviço |
| `Store` | persistência por agregado (peças, demandas, ordens, agenda...) e transações (seção 7) | SQLite WAL + Kysely sobre `better-sqlite3` | `node:sqlite`; em memória, para os testes |
| `EventLog` | log de eventos de id crescente (P6, 5.11) | tabela `events` do `Store` | — |
| `EventSink` | saída do log de eventos para fora | SSE, exportador OTLP (5.11, N70), exportador ATIF | arquivo NDJSON; `/metrics` no formato Prometheus (N70); outros formatos de trajetória |
| `TelemetryIngest` | entrada da telemetria dos clientes (5.11) | receptor OTLP | — |
| `Vcs` | worktree, branch, commit, merge e push (5.5) | CLI `git` | — |
| `CodeHost` | PR e entrega (5.5) | `gh` (GitHub) | GitLab (`glab`), Gitea, só merge local **[hipótese]** |
| `Sandbox` | camada 3 de permissão (5.8) | `sandbox-runtime` (macOS/Linux) | usuário de baixo privilégio (Windows); nulo, só nos testes |
| `ProcessLauncher` | criar, limitar e matar a árvore de processos (5.9) | lançador Rust com Job Object (Windows); grupo de processos (posix) | `koffi`; `execa` com `killDescendants` |
| `ResourceMonitor` | RAM livre e carga, para a admissão (5.9) | leitura do sistema operacional | — |
| `OsScheduler` | gatilho que acorda a máquina e pedido de manter acordada (5.15) | Agendador de Tarefas, launchd + `pmset`, timer do systemd | — |
| `Notifier` | notificações (5.15) | chat do cenário; notificação do sistema operacional | e-mail, webhook ou chat corporativo por ferramenta de plugin (5.14); depois da v1, também como adaptador vindo de plugin (5.14) |
| `Clock` | hora atual e espera (vigência das ordens, agenda, timeouts) | relógio do sistema | relógio falso, nos testes |
| `PromptSource` | prompts dos papéis (5.10) | pasta `prompts/` versionada | prompts por projeto **[hipótese]** |
| `BrowserSession` | navegador compartilhado entre o agente e o Produtor: sessão, ferramentas, transmissão da tela, indicar elemento (5.19) | extensão no navegador do Produtor (padrão, N40); Playwright sobre CDP (Chromium) | outros motores do Playwright; extensão para o Firefox **[hipótese]** |
| `TerminalSession` | terminal do app no worktree do cenário: shell filho do daemon sob o `ProcessLauncher` e o `Sandbox`, transmitido por WebSocket (5.13, N39) | `node-pty` **[a confirmar na 6.0]** | — |
| `Dictation` | ditado na caixa de texto do app (5.13, N39) | escolhido por medição na Fase 12 **[a definir]** | modelo local pelo daemon (whisper.cpp); reconhecimento do sistema **[hipótese]** |

A tabela é o ponto de partida. Uma porta nova entra pela regra 5.

#### Registros

Decidido em 2026-11-13: as listas viram registros tipados, com schema zod por entrada, e só os módulos oficiais registram entradas que mudam o comportamento do daemon.

| Registro | Entradas | Quem registra |
|---|---|---|
| Fluxos | máquinas XState por nome e versão, montadas com etapas reutilizáveis (planejar, revisar, roteirizar, executar o DAG, integrar, criticar, decidir, entregar). A peça teatral (5.4) é o fluxo padrão | módulos oficiais |
| Papéis | schema de entrega, conjunto de ferramentas, prompt e pontos de julgamento de cada papel | módulos oficiais |
| Ferramentas do framework | ferramentas MCP do Diretor e dos papéis, e as cascas (5.3, 5.8), cada uma com schema, `effects` e chave de idempotência | módulos oficiais; plugins pelo manifesto, fora do processo |
| Chaves de `rule` | chave, schema do valor e ponto onde se aplica (5.17). **Lista fechada:** seis chaves na v1 (quatro de 2026-11-13 e duas da v0.26); chave nova entra uma a uma, com teste | só módulos oficiais |
| Tipos de evento | nome e schema do payload (5.11) | módulos oficiais; plugins só com o prefixo `plugin.<id>.*` |
| Estratégias | `when_exhausted` (`next`, `wait`; 5.7), política de retomada por causa (5.16), tipos de agendamento (5.15) | módulos oficiais |
| Cenários | tipos de cenário (projeto, tarefa, chat), perfis de projeto (`software` na v1), tipos de passo de tarefa, gatilhos (5.20) | módulos oficiais |
| Interface | abas, painéis, comandos da paleta, ações e mapas de teclas com presets por plataforma e superfície (5.13, N39), em `packages/client` | módulos oficiais; plugins pelo painel declarativo (5.14) |
| Tipos de indicação | nome, versão, schema do conteúdo, texto para o prompt, leitura do detalhe e checagem de validade (5.19); o primeiro é `web_element` | só módulos oficiais |

- O registro recusa entrada duplicada ou com schema inválido **na subida do daemon**, nunca no meio de uma peça.
- **Fluxos.** O registro de fluxos (decidido em 2026-11-13) tem a peça teatral como padrão. Os fluxos `task.define`, `task.run` e `chat` (5.20, decididos na N3) são registrados ao lado dela, sem mexer na peça.
  - O cenário guarda o id do fluxo.
  - O snapshot da peça guarda o id e a versão do fluxo, e a migração de snapshot (5.4) é feita por fluxo.
  - As etapas reutilizáveis são atores XState com entrada e saída tipadas. Os efeitos longos (sessões ACP) continuam fora da máquina e voltam como eventos (5.4).

#### Montagem, sem container

Decidido em 2026-11-13: composição manual.
- Um **ponto de montagem** único (`packages/daemon/src/compose.ts`) lê a configuração, escolhe o adaptador de cada porta pelo id e passa tudo por construtor.
- Não há biblioteca de injeção de dependências, decorators nem resolução por nome em tempo de execução.
- Cada módulo de domínio (`pipeline/`, `selection/`, `directives/`, `scheduler/`...) recebe só as portas de que precisa.
- Os testes montam o mesmo daemon com fakes: `fake-agent`, `Store` em memória, `Clock` falso, `Sandbox` nulo.

```ts
// @otheater/core
export interface Adapter {
  readonly id: string;                                      // 'claude-statusline', 'sqlite', 'keyring'...
  readonly implements: { port: string; range: string };     // ex.: { port: 'QuotaProbe', range: '^1.0.0' }
}

export interface QuotaProbe extends Adapter {
  capabilities(): QuotaCapabilities;                        // janelas, push ou polling, precisão
  read(profile: ProfileRef): Promise<QuotaReading>;         // QuotaReading validado por zod
  watch?(profile: ProfileRef, onChange: (r: QuotaReading) => void): Disposable;
}

// packages/daemon/src/compose.ts
const clock = new SystemClock();
const store = new SqliteStore(config.store, clock);
const quota = new QuotaService([claudeStatuslineProbe, codexAppServerProbe, rateLimitErrorProbe]);
const selection = new SelectionService({ store, quota, admission, clock });
```

A escolha dos adaptadores fica na configuração. Cada adaptador contribui o schema zod da própria configuração, validado na subida:

```yaml
adapters:
  store: sqlite              # ou node-sqlite
  vault: keyring             # ou encrypted-file | env
  vcs: git
  code_host: github
  sandbox: auto              # escolhe pelo sistema operacional
  notifier: [chat, os]
```

A aba Configurações e a API mostram qual adaptador está em cada porta e com qual versão, como já acontece com o backend do cofre (5.6).

#### Versão dos contratos

Decidido em 2026-11-13: semver por porta + suítes de conformidade.
- Cada porta tem versão semver própria em `@otheater/core`.
- O adaptador declara a faixa que implementa (`implements.range`). Na subida, o ponto de montagem recusa um adaptador fora da faixa, com uma mensagem que diz a porta, a versão esperada e a recebida.
- Mudança que quebra o contrato = versão maior. Durante uma transição, o núcleo pode aceitar duas versões maiores **[proposta]**.
- **Suítes de conformidade** ficam em `@otheater/sdk`: uma por porta, em Vitest, que qualquer adaptador roda na própria CI. As de `ClientAdapter` e `AgentSession` incluem os testes de contrato contra os adaptadores reais fixados (seção 8, P10).

#### O que a Fase 1 fixou

Escolhas dos PRs dos passos 3 a 5 da Fase 1, aceitas pelo dono em 2026-11-16 (N50, N51 e N52):
- **Versões.** As portas começam em `0.1.0`. Uma capacidade nova e opcional não muda a versão da porta, porque `^0.1.0` não aceitaria `0.2.0`. A exceção é uma mudança de que depende uma garantia de segurança: a porta `ClientAdapter` foi para `0.2.0` quando `openSession` e `loadSession` passaram a receber o propósito da sessão (v0.56, N68), porque um adaptador que o ignorasse devolveria uma sessão capaz de rodar prompt a quem pediu uma que não roda. Ela foi para `0.3.0` na Fase 4 (P1, v0.73, N102), porque a `RolePolicy` passou à versão 2: um adaptador escrito para a versão 1 leria `nativeShell: 'shells'` como "sem shell" e um servidor MCP como inteiro (sem `mcpTools`), e a faixa `^0.2.0` não garante mais a segurança. A `RolePolicy` v2 tem `nativeShell: 'none' | 'shells'`, `mcpTools` por servidor (`Record<servidor, nomes | 'all'>`, em que o servidor sem entrada não tem ferramenta liberada) e `onAsk: 'reject' | 'rules'`; as `rules` são um campo aditivo e fora da garantia, e por isso não mudam a versão da porta. O `compose.ts` confere a faixa dos adaptadores contra essa versão.
- **Capacidades opcionais.** O que só alguns adaptadores oferecem é uma interface à parte, com um guard (`isX`), e não um método opcional na porta:
  - `LockableSecretVault` (`isLocked`, `unlock`, `lock`), para o cofre em arquivo com senha mestra;
  - `StoreMaintenance` (`quickCheck`, `backup`), para o store em SQLite.
- **Relógio.** O `Clock` do sistema é um adaptador próprio, `@otheater/adapter-clock-system`, e não fica no core. `Clock.now()` e o `timestamp` dos eventos são epoch em ms, inteiros.
- **Fakes.** Ficam em `@otheater/core/testing`, e não no sdk. Uma regra do dependency-cruiser impede que algo fora de `testing/` importe `testing/`. O `vitest` é `peerDependency` do sdk.
- **Ponto de montagem.** O `compose.ts` confere `implements.range` com semver:
  - faixa incompatível dá `AdapterUnavailable`;
  - faixa malformada ou porta errada dá `InvalidInput`;
  - um adaptador injetado por override (nos testes) aparece com id `override` no `daemon.started`.
- **Regra de dependência.** Além das regras do início desta seção, o `protocol` só importa a si mesmo, o core (sem `testing`) e o zod.
- **Contrato das portas.** O `Store` tem `close()`. O `SecretVault.get` devolve `undefined` para chave ausente. Os ids do `EventLog` crescem estritamente, mas podem ter buracos. Os códigos de erro incluem `CANCELLED` e `INVALID_INPUT`.

### 5.19 Navegador compartilhado

Decidido em 2026-11-13 (v0.13), a pedido do dono. É um navegador que o Produtor vê na web e no desktop e em que **indica elementos da página para o agente trabalhar**, como "este botão está desalinhado" ou "preencha este formulário". O Produtor e o agente usam **a mesma sessão**: o que o Produtor indica é o que o agente vê e controla.

Revisto em 2026-11-15 (v0.35, N40), a pedido do dono: o navegador do OTheater não tem as restrições do navegador do Claude Desktop. Os padrões estão em "Sem as restrições do Claude Desktop", abaixo, e cada restrição antiga continua disponível como modo de uma chave.

#### Dono da sessão

O dono da sessão é a **porta oficial `BrowserSession`** (5.18), no daemon.
- Há dois adaptadores (N40):
  - a **extensão** no navegador do Produtor, que é o padrão (`browser.profile: extension`, ver "Extensão no navegador do Produtor");
  - o **Playwright** (Apache-2.0, já na stack de testes) sobre CDP, com Chromium, para os outros modos de perfil, para quando a extensão não está conectada e para os testes.
- No Playwright, o navegador roda como processo filho do daemon, sob o lançador (5.9) e com a admissão de RAM. Na extensão, o navegador é o do Produtor, e o daemon só conversa com ele.
- Não fica num plugin nem numa webview da interface. Assim funciona igual na web e no desktop, e a escolha Electron × Tauri (N7) não depende dele.

#### Uma sessão, duas pontas

**Agente.** As ferramentas vêm do MCP do framework (5.3), com filtro por papel. Elas só entram no conjunto do papel se a política dele liberar (5.8).

| Ferramenta | `effects` | Observação |
|---|---|---|
| `browser_open(url)` | `network` | Qualquer domínio por padrão (`browser.domains: any`, N40); com `allowlist`, só os domínios permitidos do cenário, como o `http_get`. Também abre `localhost` e `file://` (ver "Sem as restrições do Claude Desktop") |
| `browser_read(ref?)` | `network` | Texto e árvore de acessibilidade da página ou de um elemento, truncados |
| `browser_screenshot(ref?)` | `network` | Print da página ou de um elemento |
| `browser_click(ref)`, `browser_fill(ref, value)`, `browser_press_key(key)` | `external_write` | Sem aprovação por padrão (`browser.write_approval: never`, N40). Os modos `per_domain` e `always` pedem a aprovação do Produtor. Cada ação continua com evento e print |

**Interface.**
- A API (5.12) transmite a tela da sessão por WebSocket. A fonte é o screencast do CDP, e o desempenho em telas grandes está **[a confirmar]** na Fase 12.
- O Produtor também usa a sessão com mouse, teclado e rolagem, e pode assumir o controle a qualquer momento.
- Enquanto o Produtor controla, as ferramentas de escrita do agente ficam em espera.

#### Indicar elemento

1. O Produtor liga o modo **indicar elemento**.
2. Ao passar o mouse, o daemon destaca o elemento sob o cursor. Para isso, injeta um script oficial de sobreposição na página, só enquanto o modo estiver ligado.
3. O Produtor clica no elemento e escreve um comentário. Pode indicar vários elementos antes de enviar.
4. As indicações vão anexadas à mensagem do chat do cenário. O Diretor decide o que fazer e pode repassá-las ao Ator dentro da demanda.

Cada indicação vira um artefato por referência (5.10), a **indicação** (id `I<n>`), do tipo `web_element`. Esse tipo guarda:
- a URL e o título da página;
- um **seletor estável**: primeiro o papel com o nome acessível, depois o `data-testid`, e por último o CSS;
- um trecho do HTML (truncado);
- a caixa do elemento (posição e tamanho no viewport);
- um recorte do print;
- o comentário do Produtor e o momento da indicação.

O prompt leva só o id e o comentário. O resto é lido com `read_indication(id)` quando o agente precisar (P8). Se a página mudou e o seletor não acha mais o elemento, a ferramenta avisa em vez de adivinhar.

#### Indicações de outros tipos

Decidido em 2026-11-13, a pedido do dono: o mecanismo de indicar não fica preso a elementos de página.
- **Tipos de indicação** são um registro (5.18). Cada tipo traz:
  - nome e versão;
  - o schema zod do conteúdo;
  - como o conteúdo vira texto curto para o prompt;
  - como `read_indication` devolve o detalhe;
  - se ainda é válido: a página ou o arquivo pode ter mudado desde a indicação.
- **Campos comuns** a todo tipo: id `I<n>`, tipo, superfície de origem, cenário, mensagem do chat, comentário do Produtor, recorte de imagem opcional, momento. O resto fica no conteúdo do tipo.
- **Superfície** é qualquer parte que oferece o modo indicar: o navegador compartilhado é a primeira. Cada superfície declara os tipos que produz. Na interface, o modo indicar é um só: a mesma tecla, o mesmo destaque e a mesma bandeja de indicações a enviar.
- **Na Fase 12 entram `web_element` e, pela N39 (2026-11-15), `code_snippet` e `terminal_snippet`**, porque os painéis de Mudanças, Arquivos e Terminal do app os produzem (5.13). Pela N43, `terminal_snippet` sai antes, na Fase 7, gerado pelo comando `!` da TUI. Os outros tipos e superfícies, todos **[hipótese]**, entram um a um, com teste:
  - `code_snippet`: arquivo, faixa de linhas e commit, no diff ou no visualizador de arquivos (Fase 12, N39);
  - `image_region`: retângulo num print ou numa imagem;
  - `dag_node` e `demand`: um nó do DAG da peça;
  - `terminal_snippet` (Fase 7 pelo comando `!`, N43; Fase 12 pelo painel, N39) e `event`: saída de uma sessão do terminal ou um evento do log;
  - `app_element`: tela de um emulador ou de um app de desktop, por uma porta nova com outro adaptador.
- O mecanismo segue as regras das abstrações (5.18): só módulos oficiais registram tipos de indicação. Isso continua assim depois da v1 (decidido em 2026-11-14, v0.28, item 15 da seção 12), porque o tipo mexe no prompt e na interface.

#### Sem as restrições do Claude Desktop (N40)

Decidido em 2026-11-15, a pedido do dono: "vou querer uma implementação sem as restrições que ele tem hoje". O navegador embutido do Claude Desktop:
- pede aprovação por site e bloqueia alguns sites;
- não abre `file://` nem os servidores `localhost` que o agente sobe;
- usa um perfil próprio, separado do navegador do usuário.

**[S]**: instruções do navegador embutido lidas numa sessão do Claude Code no app, em 2026-11-15; não conferido no código do app.

O dono escolheu tirar as quatro restrições e, no mesmo dia, os padrões de login e de `file://`, todos por múltipla escolha. Cada padrão é uma chave com override da global no projeto e no cenário (5.20):

| Chave | Padrão (N40) | Outros modos | O que faz |
|---|---|---|---|
| `browser.profile` | `extension` | `import`, `shared`, `per_scenario` | `extension`: o agente usa o navegador do dia a dia do Produtor, com os logins dele, por uma extensão (abaixo). `import` **[proposta]**: copia cookies e sessões de um perfil do navegador do Produtor para o perfil do Playwright. `shared`: um perfil do OTheater para todos os cenários. `per_scenario`: o perfil isolado por cenário da v0.13 |
| `browser.domains` | `any` | `allowlist` | `any`: qualquer domínio. `allowlist`: só os domínios permitidos do cenário, como o `http_get`. Em qualquer modo vale a lista opcional `browser.blocked_domains`, vazia por padrão **[proposta]** |
| `browser.local_urls` | `allow` | `deny` | Abre `localhost`, `127.0.0.1`, `[::1]` e `*.localhost`, em qualquer porta |
| `browser.file_urls` | `except_secrets` | `any`, `scenario`, `deny` | `except_secrets`: qualquer arquivo que a conta do Produtor lê, menos os caminhos de `browser.secret_paths`. `any`: sem exceção. `scenario`: só as pastas do cenário |
| `browser.write_approval` | `never` | `per_domain`, `always` | `never`: clicar, preencher e teclar sem pedir aprovação. `per_domain`: pede na primeira ação de escrita em cada domínio, e a resposta vale para o cenário. `always`: o padrão da v0.13 |
| `browser.fallback` | `shared` | `wait`, `fail` | O que fazer no modo `extension` quando a extensão não está conectada: navegador fechado, daemon sem login (Fase 10b) ou tarefa agendada. O padrão `shared` foi decidido pelo dono para a Fase 4, em que a extensão ainda não existe (v0.73, N108), e está implementado no P6 (PR #82) **[V]**. Com `wait` e `fail` a chamada é recusada |

**Política do papel (v0.73, N116) [V]:** `roles.<papel>.policy.browser` aceita `none`, `read` e `full`, com o padrão **`none`**: nenhum papel recebe as ferramentas `browser_*` sem que a configuração ou o cenário a ligue. `read` dá `browser_open`, `browser_read` e `browser_screenshot`; `full` acrescenta `browser_click`, `browser_fill` e `browser_press_key`. Sem o lançador do Playwright, as ferramentas nem são registradas. As chaves da máquina (`timeout_ms`, `min_free_memory_mb`, `max_instances`, `sandbox`, `executable_path`, `idle_close_ms`) são só do bloco global, e as do que o agente pode fazer (`profile`, `fallback`, `domains`, `blocked_domains`, `local_urls`, `file_urls`, `write_approval`, `action_screenshots`, `read_max_chars`) aceitam override no cenário (N117).

**`browser.secret_paths`** é o apelido de **`security.secret_paths`**, a lista única de caminhos de segredo (v0.73, N107): a mesma lista vale para a sandbox (leitura negada pela camada 3, 5.8) e para o `browser_open`, e uma escrita em `browser.secret_paths` é uma escrita em `security.secret_paths` (`add` e `remove` sobre o padrão abaixo). O módulo puro que a expande e a confere está em `packages/core/src/secret-paths.ts` **[V]**, e a ligação com o navegador foi feita no passo P6 da Fase 4 (PR #82) **[V]**; escrever as duas, `security.secret_paths` e `browser.secret_paths`, é recusado no parse (N117). O padrão vem com esta lista **[proposta]**:
- as chaves e os logins: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials`;
- os perfis dos clientes: `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.config/opencode`, `~/.local/share/opencode`;
- os chaveiros e os perfis de navegador: `~/.local/share/keyrings`, `~/.config/google-chrome`, `~/.config/chromium`, `~/.mozilla` e `~/.var/app/*/config` (Flatpak);
- os dados do daemon, com os perfis do OTheater (5.6);
- os arquivos `.env` e `.env.*` em qualquer pasta.

A lista aceita acréscimos e remoções na configuração (`security.secret_paths.add` e `.remove`; uma entrada é `~/...`, `<data>/...`, um caminho absoluto ou um nome sem barra, como `.env`, que vale em qualquer pasta). Os caminhos equivalentes no macOS e no Windows estão **[a definir]**.

**Como o `file://` é aplicado.** A regra é aplicada pelo daemon, não pelo navegador **[proposta]**:
- `browser_open` recusa um caminho de segredo antes de abrir a página;
- o daemon serve os arquivos numa origem local própria (`http://127.0.0.1:<porta>/files/…`, com token), e a regra vale também para os arquivos que a página carrega. Isso funciona nos dois adaptadores e no Opera em Flatpak, que não enxerga a pasta pessoal (abaixo);
- no Playwright, a navegação direta a `file://` fica bloqueada por política do Chromium **[a confirmar na Fase 4]**.

**`localhost`.** O Executor roda sob o `sandbox-runtime` (5.8). Ainda não se sabe se um servidor que o Ator sobe dentro da sandbox é alcançável pelo navegador, que fica fora dela **[a confirmar na Fase 4]**.

**O que o OTheater não controla.** O OTheater tira as restrições que são dele. Ficam fora do alcance dele:
- as recusas do próprio modelo do Executor, por exemplo resolver CAPTCHA ou digitar senha;
- os termos de uso de cada provedor.

Nenhum dos dois foi verificado.

#### Extensão no navegador do Produtor

É o adaptador do modo `browser.profile: extension` (N40), um segundo adaptador da porta `BrowserSession`.
- **Primeiro alvo: o Opera**, o navegador do dia a dia do dono.
  - Na máquina de desenho, é o Opera 136.0.6008.80 em Flatpak (`com.opera.Opera`, Flathub) **[V]**.
  - A extensão é Manifest V3 para Chromium. Por isso deve servir também ao Chrome, ao Edge e ao Brave **[N]**.
  - O Firefox exigiria outra versão **[hipótese]**.
- **Ligação com o daemon:** WebSocket na API local (5.12). A extensão é pareada uma vez, com um código mostrado na TUI ou no app, e pode ser revogada como um aparelho.
  - Não usa native messaging, porque o Opera em Flatpak não roda binários do sistema.
  - As permissões do Flatpak compartilham a rede. O sistema de arquivos fica limitado a Downloads e a algumas pastas de configuração **[V, `flatpak info --show-permissions`]**.
- **Controle:** pela API `chrome.debugger` (CDP por aba). Ela dá clique, digitação, teclas, print e árvore de acessibilidade, as mesmas ferramentas do Playwright.
  - O suporte no Opera está **[a confirmar]**.
  - A alternativa é um content script com `tabs.captureVisibleTab`.
  - Enquanto o depurador está ligado, o Chromium mostra uma barra de aviso na aba **[S]**.
- **Abas [proposta]:** o agente trabalha num grupo de abas com o nome do cenário e nas abas que o Produtor compartilhar com ele. As outras abas do Produtor ficam fora (`browser.tabs: group`, padrão, ou `any`).
- **Indicar elemento direto no Opera [proposta]:** a extensão injeta a mesma sobreposição do modo indicar, e as indicações vão para o chat do cenário escolhido no menu da extensão. O painel do navegador no app espelha a aba pelo screencast do CDP.
- **Parar:** o botão da extensão e um atalho tiram o controle do agente na hora. Como na sessão do Playwright, quando o Produtor mexe na aba, as ferramentas de escrita do agente ficam em espera.
- **Fase:** a extensão entra na **Fase 12**, junto com a tela (decisão do dono, 2026-11-15, N40). A Fase 12 cresce 1 semana sem agentes e 0,5 com.
- **Até a Fase 12:** sem a extensão, o padrão `extension` cai no `browser.fallback`. Na v1, o agente usa o Playwright com o perfil `shared`, em que o Produtor faz login uma vez **[proposta]**.

#### Proteções que ficam

Os novos padrões aumentam o R17. Uma página pode tentar dirigir o agente, e o agente age com as contas logadas do Produtor, em qualquer domínio e sem aprovação. O dono aceitou esse risco em 2026-11-15 (N40). Continuam valendo:
- **A página como dado.** O conteúdo da página é tratado como dado, nunca como instrução, com a separação entre leitura e envio (5.8). A saída de `browser_read` vem marcada como conteúdo não confiável.
- **Segredos.** Os caminhos de segredo ficam fora do `file://`. As ferramentas não devolvem senha nem cookie. O texto da página, com os dados pessoais que ela mostrar, vai para o provedor do modelo do Executor.
- **Parar e esperar.** O botão de parar continua disponível, e a escrita do agente espera enquanto o Produtor mexe na sessão.
- **Registro.** Cada ação do agente no navegador vira evento `browser.*`, com a URL e um print. Uma ação de escrita é efeito colateral, com chave de idempotência (5.16).
- **Modos antigos.** O projeto ou o cenário pode voltar a ligá-los, por exemplo `write_approval: always` num cenário que mexe com dinheiro.

**Login nos modos do Playwright.** O Produtor entra nos sites pela tela transmitida, ou o modo `import` copia as sessões. O agente nunca vê senha nem cookie.

#### Fases

- **v1, na Fase 4:** a porta, o adaptador Playwright, os modos de perfil, as chaves da N40 e as ferramentas do agente, sem a tela. O agente já trabalha com o navegador, com o perfil `shared` até a extensão existir **[proposta]**.
- **Na TUI:** a TUI não mostra a página. Ela mostra a URL atual e as indicações, e pode abrir uma janela visível do navegador ao lado **[proposta]**.
- **Fase 12:** a transmissão da tela, o controle pelo Produtor e o modo indicar elemento, na web, e a extensão no navegador do Produtor (N40), com o pareamento e o espelho da aba no painel.
- **Fase 13:** o desktop aproveita a mesma tela da web.

### 5.20 Cenários: projeto, tarefa e chat

Decidido em 2026-11-13 (v0.14), a pedido do dono, e fecha a N3. As definições de cada tipo são do dono. As escolhas das subseções foram decididas por ele no mesmo dia. O que está marcado **[proposta]** é detalhe deste documento, ainda sem decisão.

#### O que todo cenário tem

Um cenário é sempre um **Diretor (Orquestrador) que conversa com o Produtor**. Desde a N44, ele também pode ter sessões diretas com Atores (abaixo). Todo cenário tem:
- **chat próprio**, separado dos outros cenários, com Diretor próprio;
- **pasta própria:**
  - no projeto, é o repositório;
  - na tarefa e no chat, é uma pasta nos dados do daemon (`scenarios/<id>/`);
- **anexos** de qualquer tipo;
- configuração com override da global, ordens locais (5.17) e navegador (5.19);
- dashboard e trajetórias (5.13);
- um **fluxo** do registro de fluxos (5.18).

**Tipos de cenário** são um registro (5.18), e só módulos oficiais registram entradas. Cada tipo traz:
- os fluxos que aceita;
- o conjunto de ferramentas e a política de permissão padrão (5.8);
- o Diretor padrão;
- o que a tela do cenário mostra.

A v1 tem **três tipos**: projeto, tarefa e chat. As variações não viram tipo novo:
- um projeto de documentação ou de dados é um **perfil de projeto**;
- monitorar um site é uma **tarefa com gatilho**;
- pesquisar e fazer um relatório é um **chat**, ou uma **tarefa** se for repetir.

| | Projeto | Tarefa | Chat genérico |
|---|---|---|---|
| Para quê | Desenvolver software (ou outro perfil) num repositório | Um workflow de vários passos que gera um artefato final, uma vez ou recorrente | Prototipar e perguntar |
| Pasta | Repositório git | `scenarios/<id>/`, com a definição versionada e uma subpasta por execução | `scenarios/<id>/` |
| Fluxo | Peça teatral (5.4) | `task.define` (peça curta que desenha e ensaia a definição) e `task.run` (motor de passos) | `chat` (Diretor + consultor) |
| Entrega | PR, changelog, release | Artefato final entregue por plugin (e-mail, Telegram...) ou na pasta | Resposta e artefatos no chat |
| Recorrência | Peça agendada (5.15) | Gatilhos | — |

#### Sessão direta com um Ator (decisão do dono, 2026-11-15, N44)

Além do chat com o Diretor, o Produtor pode abrir uma **sessão direta**: uma conversa com a sessão ACP de um Executor que ele escolhe, fora de qualquer peça. É como usar o cliente oficial, mas dentro do OTheater. Os comandos do cliente (`/claude:compact`, por exemplo) valem nela.

O resto é **[proposta]**:
- **Onde abre:** numa aba do cenário, em qualquer tipo de cenário. O Executor vem da lista do perfil, com modelo e esforço das config options.
- **Onde escreve:** chave `direct_session.workspace`, com três modos:
  - `worktree` (padrão): um worktree próprio; nada dele vai para a integração sem o Produtor promover;
  - `readonly`: só lê;
  - `scenario`: escreve na pasta do cenário. Pede confirmação, porque sai das fronteiras da P13.
- **Contas e registro:**
  - conta na cota e no orçamento do perfil como qualquer tentativa (5.6);
  - roda sob o lançador (5.9) e a sandbox (5.8);
  - vai para o log de eventos e para as trajetórias (P6, 5.11).
- **Relação com o Diretor:** o Diretor não lê a sessão direta. O Produtor pode anexar um trecho ao chat ou **promover** o resultado a demanda ou peça, como na promoção do chat.
- **Permissões:** as ferramentas do cliente seguem a política do cenário (5.8), e as aprovações são pedidas ao Produtor na própria aba.
- **Fase:** 7, na TUI, junto com o registro de comandos.

#### Projeto

Um projeto é uma pasta no disco versionada por git, com um **perfil de projeto** registrado. Não confundir com o perfil de assinatura (5.6).

- **Perfil.** O perfil padrão é **`software`**. Ele define:
  - a estrutura inicial;
  - as ferramentas e as permissões pré-definidas;
  - os artefatos que o OTheater gera e controla conforme o projeto avança:
    - changelog;
    - mensagens de commit;
    - PRs;
    - publicação no code host (`CodeHost`, 5.18; `gh` no GitHub);
    - CI (GitHub Actions ou similar);
    - releases e versões **[proposta]**.

  Outros perfis (documentação, dados) entram depois sem mudar o conceito.
- **Artefatos do perfil, gerados a partir do store [proposta].**
  - A etapa DELIVERING (5.4) monta a entrada do changelog, a mensagem do commit de merge e a descrição do PR com código, a partir das demandas, dos resultados e das decisões da peça.
  - O modelo só redige o texto livre dentro de um schema.
  - A CI é criada na estrutura inicial e, depois, como demanda comum de uma peça.
- **Criação:**
  - **projeto novo:** nasce do modelo do perfil e segue as convenções dele;
  - **repositório que já existe** (decidido em 2026-11-13): na importação, o OTheater detecta as convenções do repositório:
    - o formato do changelog;
    - o padrão de commit;
    - a CI;
    - a branch principal.

    Ele mostra ao Produtor o que achou. O Produtor confirma ou corrige, e o OTheater passa a gerar seguindo isso. As convenções ficam no cenário (`scenarios.conventions`).
- **Um repositório por projeto na v1** (decidido em 2026-11-13).
  - O modelo de dados já guarda uma lista (`scenario_repos`, seção 7).
  - Um projeto com vários repositórios (front e back, por exemplo), com worktrees e PRs coordenados, fica para depois da v1.
- **Recorrência.** Um trabalho recorrente que pertence ao repositório continua sendo uma peça agendada do projeto (5.15). Exemplo: atualizar as dependências toda semana.

#### Fila de ideias (decisão do dono, 2026-11-17, N91)

Ideia do dono, com o desenho proposto aqui e aprovado por ele no mesmo dia; os detalhes marcados **[proposta]** ainda não têm decisão. O Produtor joga **ideias** na fila do cenário a qualquer hora, sem abrir uma peça: um prompt, um texto de especificação ou um anexo `A<n>`. O Autor lê a fila, junta as ideias que fazem sentido juntas e transforma cada grupo num plano, até a fila esvaziar.

- **Amarrada ao cenário.** Cada cenário tem a sua fila, e um grupo só junta ideias do mesmo cenário, porque elas mexem no mesmo repositório e seguem as mesmas convenções.
  - No **projeto**, o grupo vira a necessidade de uma peça (5.4).
  - Na **tarefa**, o grupo vira a necessidade de um `task.define`, que gera uma versão nova da definição **[proposta]**; entra quando a tarefa for construída.
  - O **chat genérico** não tem fila, porque não tem plano **[proposta]**.
  - A **caixa de entrada global**, em que o Produtor joga a ideia sem escolher o cenário e o Diretor sugere o destino para o Produtor confirmar, fica para uma fase futura.
- **Quem agrupa: o Autor.** O agrupamento é um ponto de julgamento novo, no nível do cenário, fora da máquina da peça (`group_ideas` **[proposta]**). O Autor lê a fila e devolve, por schema:
  - o grupo, com a ordem das ideias;
  - para cada ideia que fica de fora, o motivo;
  - as ideias que ele descarta, divide ou adia, sempre com o motivo.

  Juntam-se ideias da mesma área, as que dependem umas das outras e as que se cobrem. Uma ideia ambígua, ou que contradiz outra, vai ao `ask_producer` e não entra no plano. Depois do grupo, segue a peça normal: o Autor escreve o plano, e o Revisor confere o plano contra cada ideia do grupo, uma a uma.
- **Ciclo de vida da ideia [proposta]:** `queued` → `grouped` (com a peça) → `done`, `discarded` (com o motivo) ou `deferred`. Cada ideia aponta para a peça e para o PR que a resolveram. Se a peça é cancelada ou termina sem entrega, as ideias dela voltam para a fila.
- **Ideia nova durante uma peça:** espera o próximo agrupamento. Redefinir a necessidade da peça em curso (5.4) continua sendo uma ação do Produtor.
- **Chaves:**
  - `ideas.drain: auto | manual | scheduled`, padrão `auto` (decisão do dono, que fecha o fluxo: a fila anda sozinha até esvaziar). `manual` só anda por comando; `scheduled` anda pelo agendador (5.15). Em todos os modos, a fila respeita a cota, o teto de gasto e o horário (5.6), como o agendador.
  - `ideas.grouping_approval: ask | auto`, padrão `ask` (decisão do dono): o Autor mostra o grupo, e o Produtor aprova, mexe ou recusa antes de a peça começar; sem resposta, a fila espera. Com `drain: auto`, o agrupamento acontece sozinho, e só o início da peça espera o Produtor. Com `auto`, o grupo vira peça direto, e o agrupamento fica no histórico.
  - `ideas.max_per_play`, padrão 5 **[proposta]**: o tamanho máximo de um grupo, para a peça não ficar gigante.
  - `ideas.parallel_plays`, padrão 1 **[proposta]**: quantas peças da fila rodam ao mesmo tempo no cenário.
- **Eventos [proposta]:** `idea.added`, `idea.grouped`, `idea.discarded`, `idea.deferred` e `idea.done`.
- **Interfaces [proposta]:** o comando `/idea` no chat e a lista da fila na tela do cenário.
- **Importação das demandas do `okit` (decisão do dono, 2026-11-17, N92).** Outro motivo da fila: ela recebe a caixa de demandas do `okit`. Fica para depois que o OTheater estiver funcionando, com a ferramenta de importação da Q12, que também importa as ordens (5.17). O importador só lê o `okit` e não escreve nada nele **[proposta]**.
  - **Destino.** As demandas de cada projeto do kit vão para a fila do cenário de projeto do mesmo repositório. O kit acha o projeto pelo commit raiz (`kit project id`), e o importador casa pelo mesmo commit raiz **[proposta]**.
  - **Quais entram:** só as não feitas (`aberta`, `em-andamento` e `aguarda-produtor`, com o sufixo explicativo, se houver). As feitas, em `inbox-historico.json`, ficam no kit. Chave `okit_import.items: open | open_and_history | ask`, padrão `open` (decisão do dono). Com `open_and_history`, as feitas também entram, já como `done`, só para consulta. Com `ask`, o importador mostra a lista, e o Produtor marca o que entra.
  - **A fila espera o Produtor.** Com `ideas.drain: auto`, uma importação grande começaria peças sozinha e gastaria cota. Por isso, depois de importar, a fila do cenário só anda quando o Produtor confirma a importação; daí em diante, segue o `ideas.drain`. Chave `okit_import.drain: hold | follow | deferred`, padrão `hold` (decisão do dono). Com `follow`, as ideias seguem o `ideas.drain` direto. Com `deferred`, entram como `deferred`, e o Produtor as tira do adiamento quando quiser.
  - **Projeto sem cenário.** O importador pergunta ao Produtor se cria o cenário de projeto para aquele repositório ou se pula o projeto. Chave `okit_import.missing_scenario: ask | create | skip`, padrão `ask` (decisão do dono). Com `create`, ele cria o cenário apontando para o clone registrado no kit. Com `skip`, deixa só um aviso.
  - **Conversão [proposta]:** o texto da ideia junta `titulo`, `pedido`, `escopo`, `comportamento`, `compatibilidade/riscos`, `teste` e `arquivos`, sem os campos `a definir`. O `tipo`, o `tamanho`, a `origem`, o `depois-de` e o id `D<n>` ficam como metadados da ideia, e o `depois-de` serve ao Autor como dica de ordem. Uma demanda `aguarda-produtor` entra com a pergunta marcada, e o Autor a leva ao `ask_producer` antes de agrupá-la. Repetir a importação não duplica, porque o par (commit raiz, `D<n>`) identifica a ideia.

#### Tarefa

Uma tarefa é um **workflow de trabalho** em que vários agentes executam passos e geram um **artefato final**. Ela pode rodar uma vez ou ser recorrente, começar num horário e ter várias etapas. Tem um Diretor associado, como todo cenário.

Exemplo do dono:
1. baixar todo dia arquivos comprimidos;
2. descomprimi-los e extrair uma informação;
3. consolidar a informação numa planilha;
4. empacotar e enviar por e-mail ou para um chat do Telegram.

O resumo diário de manchetes ([docs/10](../10-TAREFAS-GERAIS-E-AGENDAMENTO.md)) é o outro exemplo-guia.

A tarefa separa a **definição** da **execução** (decidido em 2026-11-13).

**Definição.** É versionada, fica na pasta da tarefa e é validada por schema. Contém:
- objetivo;
- entradas;
- passos;
- artefato final;
- entrega;
- gatilhos;
- orçamento por execução.

**Os papéis desenham a definição** (decidido em 2026-11-13, a pedido do dono). O Diretor fica leve e só coordena. O trabalho de desenhar vai para os papéis, e a seleção (5.7) escolhe o melhor Executor para cada um. O fluxo `task.define` é uma peça curta montada com as etapas reutilizáveis (5.18) e segue as mesmas regras da peça (5.4; decidido em 2026-11-14, v0.32):
1. o **Autor** escreve o plano da tarefa a partir da conversa com o Produtor: objetivo, entradas, artefato final, entrega e restrições, com as dúvidas e as suposições;
2. as **dúvidas** vão ao Produtor (CLARIFYING), e o Autor fecha o plano com as respostas;
3. o **Revisor** revisa o plano e julga as suposições;
4. o **Roteirista** transforma o plano em passos tipados, como faz com o DAG de demandas;
5. o **Autor** revisa os passos tipados (REVIEWING_SCRIPT), antes dos Atores;
6. os **Atores** escrevem o código dos passos de código (scripts na pasta da tarefa);
7. o **Crítico** faz o **ensaio**: roda a definição inteira com dados de exemplo, sem entregar de verdade, e avalia o artefato final;
8. o Produtor aprova. Só então a definição fica ativa e pode ser agendada.

Pedir pelo chat uma mudança na tarefa abre uma nova peça `task.define` sobre a versão atual. Cada mudança gera uma versão nova, que passa por ensaio e aprovação. Por padrão, todas as versões são guardadas (chave `tasks.definition_versions`, em "Padrões e configuração").

**Passos tipados.** Os tipos de passo são um registro (5.18):

| Tipo | O que faz | Quem executa |
|---|---|---|
| `code` | Roda um script da pasta da tarefa (baixar, descomprimir, extrair, montar a planilha) | Ninguém: o motor roda o script sob o lançador (5.9) e o sandbox (5.8), sem modelo |
| `model` | Uma chamada com entrada e saída validadas por schema (resumir, classificar) | Um papel, e a seleção escolhe o Executor (ex.: modelo barato para resumir) |
| `agent` | Uma demanda com ferramentas (pesquisar na web, usar o navegador, lidar com um formato inesperado) | Um Ator, com papel, `specialty` e `complexity` como na `Demand` (5.4) |
| `approval` | Pede uma decisão ao Produtor antes de seguir | O Produtor, com as regras de "decisão sem ninguém olhando" (5.15) |
| `delivery` | Envia o artefato final | Uma ferramenta de plugin (e-mail, Telegram; 5.14) ou o `Notifier` (5.18), com destinatário fixo na definição |

Segue o "ferramenta primeiro, modelo por último" (P3, P8): o que dá para fazer com código é passo `code`. O papel e o Executor entram só onde há julgamento.

**Execução.** O fluxo `task.run` é um **motor de passos**:
- ele roda os passos da versão ativa em ordem topológica, com paralelismo limitado pela admissão (5.9);
- cada execução tem pasta própria (`scenarios/<id>/runs/<n>/`), com entradas, saídas intermediárias e o artefato final. Por padrão, as 30 últimas ficam inteiras; das mais antigas ficam o artefato final e o registro no store (chave `tasks.runs`, em "Padrões e configuração");
- cada passo de código é um efeito colateral com chave de idempotência, e a retomada (5.16) continua do último passo concluído;
- o **Diretor não acompanha a execução.** Ele só é chamado quando um passo falha depois das tentativas ou quando surge uma decisão. Nesse caso, há um ponto de julgamento com schema:
  - corrigir a definição, o que abre `task.define`;
  - repetir;
  - pular o passo;
  - parar e avisar o Produtor.

**Gatilhos** (decidido em 2026-11-13). Os gatilhos são um registro (5.18).
- Na v1:
  - rodar agora (manual);
  - uma vez;
  - cron;
  - intervalo;
  - após o reset da cota.

  São os tipos do agendador (5.15), e as regras dele (execução perdida, sobreposição, cota, decisão sem ninguém olhando, orçamento) valem igual.
- Depois da v1, entram sem mudar a tarefa:
  - arquivo novo numa pasta;
  - webhook;
  - e-mail recebido (por plugin);
  - mudança numa página.

#### Chat genérico

O chat é um **espaço de prototipação**. O Produtor conversa com o Diretor, que pode gerar artefatos, acessar páginas web para responder e trabalhar com os anexos.

- **Diretor barato que consulta um forte** (decidido em 2026-11-13):
  - o Diretor responde sozinho o que é simples;
  - lê sozinho um anexo de texto com `read_attachment` (N85, em Anexos, abaixo);
  - quando precisa, chama `consult(question, attachments?)`. Isso abre um **Ator consultor**, um papel `consultant` com modelo forte e ferramentas de pesquisa (`http_get`, `browser_*`) e de escrita na pasta do chat;
  - **Escrita do consultor (P10, 2026-11-17; `scenarios.consultant_writes` decidida pelo dono no mesmo dia).** A consulta roda num worktree próprio, e o que ela escreve entra na pasta do chat só depois de conferido com o confinamento dos caminhos (link simbólico para fora, `.git` e `attachments/` são recusados), por merge `--no-ff`, com `scenarios.consultant_writes: merge | keep | discard` (padrão `merge`). A saída de `consult` ganha `files` e `notice`. A imagem de um anexo vai ao consultor como bloco `image` do resultado da ferramenta, e os três adaptadores reais declaram `inputTypes: ['image']` pelo que o `initialize` mediu na Fase 0 **[V: spike]**; que o modelo veja o bloco devolvido por ferramenta fica **[N]**;
  - o chat mostra que houve consulta, com o Executor escolhido e o motivo;
  - o Produtor pode pedir o forte numa mensagem ("use o forte"), e aí a consulta é obrigatória.

  O chat, portanto, não fica limitado a um modelo de baixa capacidade.
- **Ponto de julgamento novo:** responder sozinho ou consultar, com schema e motivo registrado.
- **Fluxo `chat` [proposta].** A conversa é uma peça de vida longa, com os estados IDLE, CONSULTING e AWAITING_PRODUCER. Cada consulta é uma tentativa, com sessão, consumo e trajetória como as outras.
- **Promoção** (decidida em 2026-11-13). O chat pode virar tarefa ou projeto a qualquer momento, por decisão do Produtor.
  - O Diretor chama `promote(type)`, que devolve um rascunho para o Produtor confirmar.
  - Nasce um **cenário novo, ligado ao chat de origem** (`scenarios.origin_id`), que recebe:
    - os anexos;
    - os artefatos escolhidos;
    - cópias das ordens locais;
    - um resumo da conversa.

    O resumo é a entrada do Autor (a necessidade da primeira peça do projeto ou do `task.define`).
  - O chat continua existindo como protótipo, com um link para o cenário novo.
  - Uma tarefa também pode virar projeto do mesmo jeito, quando passa a precisar de código versionado com PRs.

#### Anexos

Em todos os cenários, o Produtor pode enviar:
- documentos de qualquer tipo;
- caminhos de arquivo ou de pasta;
- imagens;
- texto colado;
- URLs.

Ou seja, tudo o que um cliente de agente de código aceita.

- Cada anexo é um **artefato por referência** (5.10) com id `A<n>`.
- Ele é **copiado para a pasta do cenário** ou, se for um caminho, **referenciado só para leitura**. Um caminho fora das pastas liberadas pede a liberação do Produtor (5.8).
- O daemon detecta o tipo (MIME), o tamanho e o hash. O limite de tamanho de um anexo copiado é a chave `scenarios.attachment_max_size`, com padrão de 50 MB. Um caminho só referenciado não entra no limite.
- O prompt leva só o id, o nome, o tipo e o tamanho. O conteúdo é lido com `read_attachment(id)` (P8).
- **O Diretor lê texto** (decidido em 2026-11-17, N85): o Diretor também tem `read_attachment`, mas só para anexo de texto e PDF convertido em texto, para responder sozinho as perguntas simples sem gastar o modelo forte. Uma imagem, ou outro tipo, é recusada a ele com a indicação de usar `consult`, que leva o anexo ao consultor que aceita o tipo. **[proposta]**: o código da recusa, `director_text_only`; enquanto a conversão de PDF não existir, o PDF também é recusado ao Diretor.
- **Capacidade de entrada.** O `ClientAdapter` declara os tipos de entrada que aceita: imagem, PDF, áudio... O tipo de anexo da demanda entra como restrição na seleção (5.7): um Executor que não aceita imagem não recebe demanda com imagem. Quando nenhum aceita, o daemon converte o que der: texto do PDF, transcrição **[proposta]**.

#### Diretor adormecido

Decidido em 2026-11-13.
- Depois de um tempo sem atividade, a sessão do Diretor do cenário é encerrada para poupar cota e RAM. O tempo é a chave `scenarios.director_idle_after`, com padrão de 15 minutos.
- Ela reabre na próxima mensagem do Produtor, no próximo gatilho ou quando surgir uma decisão. Volta com o resumo gerado a partir do store, pelo mesmo mecanismo do failover (5.4). Nada se perde, porque o estado nunca esteve só no modelo.
- O cenário mostra o estado do Diretor (ativo ou adormecido). A primeira resposta depois de acordar é mais lenta e paga o prefixo do cache de novo.
- Uma execução de tarefa não acorda o Diretor, a menos que falhe ou peça decisão.

#### Padrões e configuração

Decidido em 2026-11-14 (N19), pelo dono: cada padrão é uma **chave de configuração**, com várias opções de escolha, e não um valor fixo no código.
- As chaves seguem a regra da configuração: valor global, com override por cenário (5.20, "O que todo cenário tem").
- O schema zod vem do módulo de cenários e é validado na subida (5.18).
- A aba Configurações e `ot config` mostram e mudam as chaves.

```yaml
scenarios:
  director_idle_after: 15m       # duração; 0 = nunca adormece
  attachment_max_size: 50MB      # anexo copiado; caminho referenciado não conta
tasks:
  runs:                          # quantas execuções ficam com a pasta inteira
    keep: last                   # last | days | last_or_days | all
    last: 30
    days: 90                     # usado por "days" e "last_or_days"
  definition_versions:
    keep: all                    # all | last | days
    last: 10
    days: 365
```

- **Execuções além do limite.** A pasta é podada: ficam o artefato final e o registro em `task_runs`, e saem as entradas e as saídas intermediárias. `last_or_days` mantém o que satisfizer qualquer um dos dois critérios **[proposta]**.
- **Versões da definição.** Uma versão que ainda tem execução guardada, ou que é a ativa, nunca é apagada, qualquer que seja o valor da chave **[proposta]**.

#### Eventos

- `scenario.*`: criação, importação (com as convenções detectadas), promoção, anexo recebido, Diretor adormecido ou acordado.
- `task.*`: versão da definição criada, ensaio, aprovação, execução iniciada, passo concluído ou falho, artefato final, entrega.

### 5.21 Durabilidade e recuperação

Decidido em 2026-11-13 (v0.15), a partir de uma pergunta do dono: o que acontece ao fechar a interface, ao reiniciar a máquina ou numa queda de energia, já que há tarefas recorrentes, agendamentos e eventos. Esta seção junta o que já estava espalhado (5.1, 5.4, 5.5, 5.15, 5.16, 5.17 e 5.20) e acrescenta quatro decisões: gravação durável, reconciliação na subida, comportamento sem login e backup. O que está marcado **[proposta]** é detalhe deste documento, ainda sem decisão.

#### O que sobrevive a quê

| Situação | O que acontece | Onde |
|---|---|---|
| Fechar o app, a TUI ou a web | Nada para: o daemon é outro processo. Ao reabrir, a interface lê o estado e o log de eventos pela API | P7 |
| Daemon cai ou é reiniciado | Sobe, faz a reconciliação (abaixo) e retoma cada peça, tarefa e chat | 5.1, 5.16 |
| Máquina reinicia com login | O serviço de logon sobe o daemon; reconciliação; agendamentos perdidos seguem a regra da janela | 5.15 |
| Queda de energia | Igual ao reinício. Nenhuma transação confirmada no store se perde (gravação durável, abaixo); o que estava em memória se perde e é refeito | esta seção |
| Máquina religada sem ninguém fazer login | Na v1, nada roda até o login (abaixo) | esta seção |
| Arquivo do store perdido ou corrompido | `ot restore` do backup mais recente | esta seção |

Tudo o que importa fica no store (P4): cenários, peças e snapshots XState, demandas, tentativas, sessões, ordens, agenda, definições e execuções de tarefa, anexos (o registro; o arquivo fica na pasta do cenário), decisões, fila de prompts e o log de eventos.

#### Gravação durável

Decidido em 2026-11-13: **`synchronous=FULL` sempre**. A regra vale para o store; a base de telemetria (5.11) usa `NORMAL` por padrão, pela chave `telemetry.synchronous` (N54).
- O store abre com `journal_mode=WAL` e `synchronous=FULL`. No macOS, também `fullfsync=ON`, porque lá o `fsync` comum não esvazia o cache do disco **[a confirmar na Fase 1]**.
- Segundo a documentação do SQLite (pragma `synchronous`), em WAL com `NORMAL` o banco não corrompe, mas uma transação confirmada pode ser desfeita depois de uma queda de energia; com `FULL`, cada commit fica no disco **[fonte secundária]**. A Fase 1 mediu só o custo; a perda com `NORMAL` não foi reproduzida.
- **Custo medido na Fase 1** (passo 7, 2026-11-16, programa `tools/bench`, resultados em `tools/bench/results/2026-11-16-linux.md`) **[V]**, em Linux, num btrfs sobre NVMe, nos dois drivers, mediana de 3 repetições:
  - com `FULL`, cada commit custa cerca de 1,4 ms (p50), que é o `fsync`;
  - com um evento por transação, o `FULL` faz ~660 a 700 transações/s, contra ~5 500 a 5 900 do `NORMAL` (0,12 vez), com p99 de 2,7 a 3,0 ms;
  - com lotes de 10 eventos, ~425 a 450 transações/s, ou ~4 400 eventos/s (0,4 vez o `NORMAL`), com p99 de 4,3 a 4,5 ms;
  - o daemon grava pouco (eventos, transições, filas), então esse custo cabe com folga, e o `FULL` continua;
  - não foram medidos ext4, xfs, outro disco, Windows nem macOS **[N]**.
- **Gravar antes de agir:** toda mudança de estado é gravada, numa transação, antes do efeito que ela dispara. Exemplos:
  - a mensagem do Produtor entra no store (e na `prompt_queue`) antes de ir para o Diretor, então um prompt na fila não se perde;
  - a transição da máquina XState é gravada antes de abrir a sessão ACP correspondente;
  - o "antes" de um efeito colateral (5.16) é gravado antes da chamada.

#### Reconciliação na subida

Decidido em 2026-11-13: uma **rotina explícita**, que roda antes de retomar qualquer coisa. Ela substitui os quatro passos que a 5.1 listava até a v0.14. Durante a rotina, a API responde e a interface mostra "recuperando", mas os comandos que mudam estado esperam.

1. **Lock e integridade.** Pega o lock de instância (5.1) e roda `PRAGMA quick_check` (na Fase 1, pela capacidade `StoreMaintenance`, 5.18). Se falhar, o daemon não sobe sozinho: avisa e oferece `ot restore`.
2. **Processos órfãos.** A tabela `sessions` guarda o pid e o instante de início de cada processo (para não confundir com um pid reaproveitado). O daemon mata pelo `ProcessLauncher` as árvores que ainda estiverem vivas e fecha o navegador do cenário que ficou sem dono (5.19).
3. **Sessões.** Toda sessão `active` vira `interrupted`, com causa `restart`.
4. **Worktrees.** O que ficou sem commit desde o último checkpoint vira um commit `wip(recovery)` na branch da tentativa, em vez de ser descartado **[proposta]**.
5. **Efeitos ambíguos.** Um efeito com "antes" e sem "depois" em `side_effects` não é repetido às cegas:
   - se a ferramenta tem **verificador**, o daemon consulta o mundo de fora e marca o efeito como `done` ou `not_done`. Exemplos: o commit com a chave de idempotência no trailer existe na branch? A ref chegou ao remoto? Existe PR aberto para a branch? **[proposta]**;
   - sem verificador, a demanda pausa e o Produtor decide no chat (feito, refazer ou cancelar).

   Cascas oficiais com efeito fora da worktree trazem verificador. Plugins com `external_write` podem declarar uma ferramenta de verificação no manifesto (5.14).
6. **Retomada.** Reidrata as máquinas XState; cada sessão interrompida segue a política da 5.16; cada execução de tarefa volta do último passo concluído (5.20); o Diretor de cada cenário volta adormecido e acorda pelo resumo quando houver o que fazer.
7. **Agenda e ordens.** Recalcula os disparos perdidos pela regra da janela (5.15) e a vigência das ordens (5.17).
8. **Relato.** Evento `daemon.recovered` com o resumo (sessões retomadas, efeitos resolvidos, pendências) e uma mensagem de sistema no chat de cada cenário afetado. A mensagem (N90, 2026-11-17) é o evento `scenario.system_message`, com o que foi retomado, o que o verificador resolveu e o que espera pelo Produtor; o chat a recebe uma vez, em memória, no próximo poll, e cada interface escreve o texto no idioma do Produtor. A chave `recovery.notice: always | unclean_only | off` (padrão `always`, **[proposta]**) decide quando há mensagem: `unclean_only` cala a subida que só retomou.

#### Máquina religada sem login

Decidido em 2026-11-13: **na v1, espera o login**; a meta, depois da v1, é o **daemon completo sem login**. Pedido do dono: começar pelo simples e migrar depois. Em 2026-11-14 o dono decidiu que a migração é uma fase própria, a **Fase 10b**, logo depois da v1 (seção 10).

**v1:**
- O daemon continua sendo serviço de logon (Fase 10). Sem login, nada roda.
- No login, o daemon sobe, faz a reconciliação, e a regra da janela (5.15) decide o que roda dos disparos perdidos.
- O gatilho do sistema operacional (5.15) é registrado para rodar só com o usuário conectado. Ele continua acordando a máquina **suspensa**, que tem a sessão aberta. Uma máquina **desligada** não é ligada por ele. Os nomes da opção em cada sistema (Agendador de Tarefas, LaunchAgent do launchd, timer do systemd de usuário sem `linger`) **[a confirmar na Fase 0]**.
- Motivo: o cofre de chaves do sistema costuma ficar trancado até o login **[hipótese]**, e sem ele as assinaturas e chaves não estão disponíveis.

**Fase 10b, o daemon completo sem login** **[proposta]**:
- o daemon passa a ser serviço que roda sem sessão: systemd de usuário com `loginctl enable-linger`, tarefa do Windows "executar estando o usuário conectado ou não", LaunchDaemon com `UserName` no macOS **[a confirmar]**;
- os segredos passam a vir de um adaptador de `SecretVault` que destranca sem ninguém digitar nada. Qual (mecanismo nativo da máquina, como DPAPI, TPM ou `systemd-creds`, ou arquivo cifrado com chave protegida por permissão) é decidido ao abrir a Fase 10b, depois da medição (seção 12, item 17). O critério já está decidido: preferir o mecanismo nativo de cada sistema que não exige senha digitada, e nunca guardar segredo em texto claro;
- os próprios clientes (Claude Code, Codex, OpenCode) guardam o login deles. Se dependerem do cofre da sessão, também falham sem login **[hipótese]**. A Fase 10b começa por essa medição.

**Regras da v1 para a migração sair barata:**
- nada essencial do daemon depende de sessão gráfica. A notificação do sistema operacional é opcional, e o navegador do cenário roda sem janela quando ninguém está olhando;
- todo segredo passa pela porta `SecretVault` (5.18), nunca por variável de ambiente lida direto;
- o modo de instalação é assunto do instalador (Fase 10), não do núcleo. Passar a rodar sem login muda o instalador e o adaptador do cofre, não o daemon **[hipótese]**.

#### Backup

Decidido em 2026-11-13: **automático e diário**, guardando 7 cópias. Em 2026-11-16 o dono trocou a retenção para **2 dias**, por chave de configuração (N51). Os padrões abaixo foram decididos em 2026-11-14 (N21) e, como os dos cenários, são chaves de configuração.
- Uma cópia consistente do store é feita com o daemon no ar, pela API de backup online do SQLite (`online_api`) ou por `VACUUM INTO` (`vacuum_into`), nos dois drivers. O padrão é `online_api` em passo único, escolhido pelo dono em 2026-11-16 a partir das medições abaixo (N53).
- **Quando:** uma vez por dia, na primeira oportunidade a partir das 3h. Se a máquina estava desligada ou suspensa, o backup roda na primeira subida depois. A primeira subida sem nenhuma cópia faz um backup na hora. Um backup agendado que falha tenta de novo em 15 min (N52).
- **Onde:** na pasta `backups/` dos dados do daemon. Na primeira execução guiada (Fase 10), o daemon avisa que a pasta está no mesmo disco e sugere apontar outro. Cada cópia é um diretório `otheater-YYYYMMDD-HHMMSSZ/`, com o carimbo em UTC, que guarda `store.sqlite` e `manifest.json`. Ela é escrita como `.partial` e só troca de nome no fim (N52).
- **Retenção** (N51): `backup.retention: days`, com `backup.keep_days: 2`; no modo `copies`, vale `backup.copies: 7`. As regras são **[proposta]** aceita com o PR do passo 5 (N52):
  - a idade conta do instante em que a cópia foi feita;
  - a cópia mais recente que passou no `integrity_check` nunca é apagada, mesmo com mais de 2 dias, para a máquina desligada por uma semana não ficar sem backup;
  - a rotação só roda depois de uma cópia nova boa, para um backup que falhou não apagar os antigos;
  - as cópias de `ot backup` entram na mesma rotação;
  - um `.partial` que sobrou só é apagado depois de 1 h, porque pode ser de um `ot backup` em curso;
  - os `.before-restore-*` seguem a mesma regra de idade, mas sem a proteção da cópia mais recente, porque não são backups.
- `ot backup` faz uma cópia na hora. Com o daemon no ar, copia pelo arquivo do store e não grava evento (o evento fica para quando houver API); com o daemon parado, grava `daemon.backup` com `trigger: manual` (N52).
- `ot restore <dir>` só roda com o daemon parado e guarda o store atual como `<db>.before-restore-<carimbo>` antes de trocar. Também restaura `scenarios/` e guarda a pasta antiga como `scenarios.before-restore-<carimbo>`; uma cópia `store_only` não mexe em `scenarios/` (N51, N52).
- Cada cópia passa por `PRAGMA integrity_check` antes de entrar na rotação, e o backup recusa sobrescrever um destino existente (N51). Uma cópia que falha gera aviso no chat global **[proposta]**.
- **Medições da Fase 1** (passo 7, 2026-11-16, mesmo ambiente da gravação durável, 3 repetições, bancos de 12 MB e 120 MB; o escritor grava 1 evento a cada ~5 ms, no mesmo processo, como o daemon) **[V]**:
  - a cópia, com o `integrity_check` incluído, leva ~65 a 70 ms em 12 MB e ~560 a 670 ms em 120 MB, com qualquer método; o `integrity_check` responde por ~15 ms e ~260 ms desse tempo;
  - `online_api` em passo único e `vacuum_into` sempre terminaram, com e sem escritor, e os dois seguram o event loop durante a cópia. No better-sqlite3 (o driver padrão), com escritor e 120 MB, o maior atraso do loop foi de 579 ms no `online_api` e de 2,6 s no `vacuum_into`;
  - o `backup()` do `node:sqlite` copia fora da thread principal; nesse driver, quem segura o loop é o `integrity_check`, que roda síncrono;
  - em passos (100 ou 1000 páginas), com o escritor ativo, o SQLite reinicia a cópia a cada commit entre dois passos, e 21 das 24 execuções deram `Transient` pelo timeout de 60 s (livelock). Sem escritor, os passos terminam e liberam o loop;
  - não foram medidos cache frio, banco maior que 120 MB, outro disco ou sistema de arquivos, nem outros padrões de escrita **[N]**.
- **Método** (decidido pelo dono em 2026-11-16, N53): `backup.method: online_api` em passo único, com `backup.pages_per_step: all`. O `vacuum_into` continua como modo da chave. Um número em `pages_per_step` copia em passos desse tamanho e libera o loop, mas só serve sem escrita no store; com escrita, cai no livelock acima. A chave só vale para o `online_api`.
- A cópia em passo único e o `integrity_check` síncrono seguram o event loop por até ~0,6 s num banco de 120 MB. Rodar os dois numa worker thread fica como **[proposta]**, sem fase marcada, para quando o banco crescer.
- Com `when: on_idle`, "ocioso" quer dizer, por enquanto, "daemon no ar há `idle`". A interface `ActivityProbe` fica pronta para as fases que tiverem peças e tarefas rodando (N52).
- **O que entra:** por padrão, o store e as pastas dos cenários de tarefa e chat, menos as pastas `runs/`. Assim entram a definição, os scripts das tarefas e os anexos copiados. De cada execução entra só o artefato final. Os projetos não entram, porque já estão no git. A base de telemetria (5.11) também fica fora por padrão, pela chave `backup.telemetry: exclude | include` (N54). Se ela se perder, o daemon recria a base vazia. Um `ot restore` de uma cópia sem telemetria não mexe na base de telemetria atual **[proposta]**.
- Configuração:

  ```yaml
  backup:
    when: daily_after            # daily_after | on_idle | manual
    after: "03:00"
    idle: 30m                    # usado por "on_idle": sem peça nem tarefa rodando
    dir: backups                 # relativo à pasta de dados, ou absoluto
    retention: days              # days | copies (N51)
    keep_days: 2                 # usado por "days"
    copies: 7                    # usado por "copies"
    content: without_runs        # store_only | without_runs | all
    method: online_api           # online_api | vacuum_into (N53)
    pages_per_step: all          # all | <páginas por passo>; só no online_api (N53)
    telemetry: exclude           # exclude | include: a base de telemetria (5.11, N54)
  ```

  A chave é só global, sem override por cenário.
- Evento `daemon.backup` com o resultado.

#### Atualização automática

Decidido pelo dono em 2026-11-16 (N73), por múltipla escolha, igual às quatro recomendações. Até então, a arquitetura só citava a atualização numa linha da Fase 10 e noutra da Fase 13. Como o daemon é um serviço de logon (5.1) e pode estar sempre ocupado, a troca de versão segue as regras de reinício desta seção.

- **Modo** (`updates.mode`):
  - `auto` (padrão): baixa a versão nova em segundo plano, confere a assinatura e aplica no momento seguro (`apply_when`). Depois, a TUI mostra o que mudou;
  - `notify`: baixa e confere, mas só aplica quando o Produtor aceitar na TUI;
  - `check`: só avisa que há versão nova; baixar e aplicar ficam com o usuário;
  - `off`: não consulta nada **[proposta]**, para máquinas sem rede ou com a versão fixada por quem administra.
- **Momento** (`updates.apply_when`):
  - `idle` (padrão): aplica quando não houver tentativa rodando, e nesse intervalo o daemon não começa trabalho novo. Passado o teto `updates.max_wait` sem ficar ocioso, pergunta ao Produtor, por múltipla escolha (5.3), se estaciona e aplica ou se espera mais; o valor de 24 h é **[proposta]**;
  - `park`: faz a parada limpa. As sessões em curso ficam `awaiting_resume` (tabela `sessions`, seção 7), a troca conta como "Reinício do daemon ou da máquina" na política por causa (5.16), que não gasta tentativa, e a volta é nativa, por `session/load`;
  - `next_start`: deixa a versão pronta e aplica no próximo início do daemon (logon ou reinício manual).
- **Origem, conforme a instalação:**
  - executável próprio (Node SEA no Linux e no macOS, `.msi` no Windows): baixa do GitHub Releases do projeto e confere o SHA-256 e uma assinatura Ed25519 com a chave pública embutida no executável, pelo `crypto` do Node, sem dependência nova. Uma assinatura que não confere descarta o download e gera aviso no chat global;
  - instalação pelo npm (`npm i -g`) ou pelo winget: só avisa, como em `check`, e deixa o gerenciador de pacotes atualizar. Assim o OTheater não troca arquivos que pertencem a outro gerenciador. Como o daemon descobre o tipo de instalação fica como **[proposta]** da Fase 10.
- **Canais** (`updates.channel`): `stable` (padrão) ou `beta`.
- **Volta automática:** a versão anterior fica guardada ao lado da nova. Se o daemon novo não subir, ou falhar na checagem de saúde depois de subir, o processo que aplicou a atualização volta sozinho para a anterior e avisa no chat global. O que conta como checagem de saúde (por exemplo, a reconciliação da subida sem erro e a API respondendo, 5.12) e o prazo dela são **[proposta]**; a API ainda não tem uma rota de saúde própria. Só uma versão anterior fica guardada **[proposta]**.
- **Backup antes das migrações:** se a versão nova migra o esquema de algum banco SQLite (o store, e a base de telemetria, 5.11), o daemon faz antes um backup no mesmo formato do `ot restore` (acima, em "Backup"), com o evento `daemon.backup` marcado como vindo da atualização, para a volta não perder dados. Uma volta depois da migração restaura esse backup.
- **Dependências em aberto:**
  - o modo de distribuição (item 2 da seção 12, N48) decide quem publica as versões e onde. No modo pessoal, o próprio dono;
  - o repositório hoje é privado, e o GitHub Releases de um repositório privado exige autenticação para baixar **[S: documentação do GitHub, não conferida nesta data]**. Fica para a Fase 10 escolher entre um repositório público só para as versões, outro endereço ou abrir o repositório. Nenhuma credencial do GitHub vai para o daemon;
  - guardar a chave privada de assinatura fora da máquina de desenvolvimento e fora do repositório é requisito, e o como fica para a Fase 10.
- Eventos `daemon.update` com a versão encontrada, o download, a conferência, a aplicação e a volta.
- Configuração:

  ```yaml
  updates:
    mode: auto              # auto | notify | check | off (off é [proposta])
    apply_when: idle        # idle | park | next_start
    max_wait: 24h           # usado por "idle"; depois pergunta ao Produtor [proposta para o valor]
    channel: stable         # stable | beta
    rollback: auto          # auto | off [proposta para o off]
    backup_before_migration: true   # true | false [proposta para o false]
  ```

  A chave é só global, sem override por cenário.

#### O que se perde (aceito)

- A resposta que o modelo estava gerando no momento da queda. A sessão é retomada (5.16) e a resposta é refeita.
- O estado das páginas abertas no navegador do cenário. O perfil (cookies, logins) fica, e o agente reabre a última URL de `browser_sessions`.
- Arquivos que o Executor gravou logo antes de uma queda de energia e que o sistema ainda não tinha levado ao disco. O passo 4 da reconciliação salva o que estiver no disco.
- Disparos agendados fora da janela (5.15): são pulados e registrados, não executados.

#### Testes

- **Fase 1:** um backup feito com o daemon no ar abre e passa no `integrity_check`; `ot restore` devolve o estado; mede o custo do `FULL`. Cumprido em 2026-11-16 **[V]**: o teste de aceite do daemon (passo 5) e o `tools/bench` (passo 7, acima).
- **Fase 3:** `kill -9` do daemon no meio de um efeito colateral. Na subida, a reconciliação mata o processo órfão do cliente, resolve o efeito pelo verificador (ou pergunta ao Produtor), e nada se repete.
- **Fase 11:** queda de energia simulada (VM desligada à força) com uma peça, uma tarefa agendada e um chat em curso. O store abre íntegro, nenhuma transação confirmada se perde, e tudo retoma pela reconciliação.

### 5.22 Idioma e internacionalização

Decidido em 2026-11-14 (v0.17), a partir de uma pergunta do dono: padronizar em inglês o código, as skills e o material do daemon, com a interface em inglês e português do Brasil. Os detalhes desta seção e os nomes do glossário foram aprovados pelo dono no mesmo dia.

#### O que é em inglês

- **Código:** identificadores, nomes de arquivo e pasta, comentários e mensagens de commit do repositório do OTheater.
- **Dados e contratos:** tabelas e colunas do store, schemas zod, estados das máquinas XState, tipos de evento, códigos de erro.
- **Configuração:** chaves e valores (`scenarios.*`, `tasks.*`, `backup.*`, `roles.*`, `adapters.*`, `ui.*`), manifestos de plugin e definições de tarefa.
- **Superfície para agentes e scripts:** ferramentas MCP do framework, comandos e opções do `ot`, a API do daemon.
- **Logs** (pino) e atributos de telemetria.
- **Prompts e skills** que o daemon manda aos agentes, em `prompts/`. Motivo: um prefixo único e estável para o cache (5.10), e os modelos seguem instrução em inglês pelo menos tão bem quanto em português **[hipótese]**.

#### O que segue o Produtor ou o projeto

- **Respostas ao Produtor** (Diretor, Consultor, decisões no chat): no idioma do Produtor. O mecanismo é uma ordem global do tipo `instruction` (5.17), por exemplo "Respostas em português do Brasil". O prompt de cada papel continua em inglês. A primeira subida já oferece essa ordem, conforme o `ui.locale`.
- **O que os agentes escrevem num projeto do Produtor** (commits, changelog, PRs, comentários): segue as convenções do projeto, detectadas na importação ou definidas pelo perfil (5.20), não a regra deste documento.
- **Este repositório de desenho:** o texto continua em português do Brasil. Os identificadores citados passam a ser os nomes em inglês desde a v0.17, e os comentários dentro dos exemplos de configuração podem ficar em português.

#### Interface (TUI, web, desktop e Android)

- **Catálogo de textos desde a primeira tela**, com `en` e `pt-BR` completos. Nenhum texto de tela fica escrito direto no componente.
- Os catálogos ficam em `locales/` e são carregados pelo `packages/client`, compartilhado por todas as interfaces. O app Android usa o catálogo da web.
- A biblioteca de i18n é o **i18next** (decidido em 2026-11-15, N49), com o `react-i18next` na TUI e na web. A licença MIT da versão 26.6.0 foi conferida no `LICENSE` do pacote em 2026-11-16 **[V]**.
- Desde a Fase 1, o i18next traduz as mensagens do `ot`, no catálogo `locales/<idioma>/cli.json`. Logs, eventos e erros do core continuam em inglês (2026-11-16, N52). A instalação empacotada (Fase 10) tem de levar a pasta `locales/` junto.
- A verificação de "texto de tela fora do catálogo" espera haver interface, provavelmente como regra de ESLint (N50). A de chaves ausentes num dos catálogos roda na CI desde a Fase 1.
- O idioma vem do sistema operacional e a chave `ui.locale` troca:

```yaml
ui:
  locale: auto     # auto | en | pt-BR
```

- Com `auto`, um locale `pt-*` vira `pt-BR`, e qualquer outro vira `en`.
- Erros chegam à interface pelo código em inglês (5.18), e o catálogo traz o texto de cada código.
- O painel declarativo de um plugin (5.14) traz o próprio catálogo, com `en` obrigatório; o que faltar em `pt-BR` aparece em inglês.
- Datas, números e durações são formatados pelo `Intl` do runtime, conforme o locale.

#### Glossário canônico

Cada conceito tem um nome em inglês, usado no código, na configuração e nos prompts, e um nome em português, usado no texto deste repositório e na interface em `pt-BR`. A tabela fica na seção 13. Os nomes em inglês foram aprovados pelo dono em 2026-11-14. Dois casos pedem atenção:
- Roteirista é `scriptwriter`, e não *playwright*, para não colidir com o Playwright do navegador compartilhado (5.19);
- ordem é `directive`, e não *order*: as tabelas, ferramentas e eventos usam `directive`.

#### Testes

- **Fase 1:** a CI reprova chave presente num catálogo e ausente no outro, e texto de tela fora do catálogo.
- **Fase 7:** a TUI inteira em `en` e em `pt-BR`, trocando por `ui.locale` sem reiniciar o daemon.

## 6. Reaproveitamento: o que usar pronto

Levantamento de 2026-11-13, filtrado pela política de licenças abaixo.

### 6.0 Política de licenças

O código próprio do projeto é **MPL-2.0**. Decidido em 2026-11-14 (N23), pelo dono, no lugar da MIT, depois de uma pergunta sobre uso comercial. Decisão de 2026-11-13, mantida: **MIT e Apache-2.0 são igualmente aceitas**, junto com as demais licenças permissivas comuns no ecossistema. Desde 2026-11-14, a **MPL-2.0** também é aceita em código copiado e em dependências.

**O que a MPL-2.0 significa aqui.** Leitura deste documento, a conferir no texto oficial da licença (mozilla.org/MPL/2.0) antes de publicar **[a confirmar]**:
- o copyleft vale **por arquivo**: quem altera um arquivo do OTheater e distribui o programa precisa oferecer o código-fonte daquele arquivo, sob MPL-2.0;
- arquivos novos, separados, podem ter outra licença, inclusive fechada. Um produto comercial pode juntar o núcleo MPL-2.0 com módulos próprios fechados (a "obra maior" da licença);
- vender é permitido, para o dono e para qualquer outra pessoa que distribua o código;
- a licença traz concessão de patentes pelos contribuidores, como a Apache-2.0;
- o dono, como autor, pode licenciar o próprio código também de outra forma. O código de terceiros que entrar por contribuição fica só sob MPL-2.0, a menos que haja um acordo (seção 12, item 18).

**Obrigações do código próprio** **[proposta]**:
- `LICENSE` na raiz com o texto da MPL-2.0, a partir da Fase 1;
- cabeçalho do Anexo A da MPL-2.0 (ou a linha `SPDX-License-Identifier: MPL-2.0`) em todo arquivo de código, conferido pelo verificador de cabeçalho da CI;
- sem o aviso do Anexo B ("Incompatible With Secondary Licenses"), para o código continuar compatível com a GPL de quem quiser combiná-lo.

**Lista de licenças:**

| Situação | Licenças | Onde valem |
|---|---|---|
| **Permitidas** | MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, MPL-2.0 | Em todos os níveis: código copiado, fork, dependências empacotadas |
| **Proibidas** | GPL, AGPL, LGPL (copyleft forte ou de biblioteca) | Em código copiado e em dependências empacotadas. Também não se lê código AGPL para reproduzir desenho, para evitar contaminação por semelhança |
| **Aceitas em dependências** (2026-11-15, N45) | BlueOak-1.0.0, Unlicense, CC0-1.0, MIT-0, Python-2.0, WTFPL, CC-BY-3.0, CC-BY-4.0 (as duas CC-BY aparecem em pacotes de dados) | Em dependências empacotadas e de desenvolvimento (níveis B e D). Em código copiado (nível A), caso a caso |
| **Caso a caso** | Qualquer outra (ELv2, BSL, MPL-1.1, source-available, sem licença) | Precisa de decisão registrada nesta seção |

**Expressões SPDX** (2026-11-15, N45). Em `A OR B`, o OTheater escolhe a alternativa e vale a melhor: `(BSD-3-Clause OR GPL-2.0)` é aceita pelo ramo BSD. Em `A AND B`, valem as duas, e decide a pior: `MIT AND LGPL-2.1-or-later` é proibida.

**Exceções por pacote** (2026-11-15, N45). Valem para um pacote e uma faixa de versões, nunca para a árvore toda, e ficam no `policy.json` do verificador com data, motivo e fonte:
- `@evilmartians/agent-prism-data` e `@evilmartians/agent-prism-types` 1.0.0, do AgentPrism. Os pacotes não têm campo `license`; o repositório (commit `4fd371b5`, 2026-10-08) e o `LICENSE` dentro do tarball são MIT **[V]**, spike `licenses`. Versão nova exige nova conferência.

**Níveis de uso.** A lista acima vale para os níveis A e B. Os níveis C e D são mais flexíveis:

| Nível | O que é | Regra |
|---|---|---|
| **A. Código copiado ou fork** | Trechos trazidos para o repositório; fork de projeto | Licenças permitidas + obrigações abaixo |
| **B. Dependência empacotada** | Pacote npm/crate que vai no instalador, inclusive transitivo | Licenças permitidas |
| **C. Ferramenta externa** | Programa executado como processo separado e instalado à parte (Claude Code, Codex, git, gh, LiteLLM, Phoenix) | A licença não se propaga para o nosso código; basta permitir o uso. Proprietárias são aceitas. Desde 2026-11-15 (N45): os três executores, com os adaptadores ACP (Claude Code com o `claude-agent-acp` e o Claude Agent SDK, Codex com o `codex-acp`, OpenCode), são nível C: o usuário os instala, e o executável do OTheater não os carrega nem os distribui. GPL e LGPL também são aceitas neste nível (como o `wl-paste`, GPL-3.0-or-later), sempre em processo separado, instaladas pelo usuário, nunca embutidas nem distribuídas. O verificador reprova uma ferramenta de nível C que apareça como dependência empacotada |
| **D. Só desenvolvimento** | Compilador, testes, validadores que não vão no instalador | Licenças permitidas ou caso a caso |

**Obrigações de Apache-2.0 (níveis A e B):**
1. **Licença e cabeçalhos:** arquivos copiados mantêm o cabeçalho e continuam sob Apache-2.0. Eles não são relicenciados como MPL-2.0. O repositório fica MPL-2.0, com arquivos Apache identificados.
2. **NOTICE:** o conteúdo do arquivo `NOTICE` de cada projeto Apache usado vai para o `THIRD_PARTY_NOTICES` e para o instalador.
3. **Modificações:** arquivo Apache alterado ganha no cabeçalho a indicação de que foi modificado.
4. **Fork:** o código original do fork segue Apache-2.0 e o que escrevermos é MPL-2.0. A distribuição cumpre os termos da Apache.

**Obrigações da MPL-2.0 de terceiros (níveis A e B)** **[proposta]**:
1. arquivos copiados de projeto MPL-2.0 mantêm o cabeçalho e continuam sob MPL-2.0;
2. um pacote MPL-2.0 alterado por nós tem as alterações publicadas sob MPL-2.0, e o instalador aponta onde está o código-fonte de cada arquivo MPL distribuído;
3. o `THIRD_PARTY_NOTICES` lista os pacotes MPL-2.0 e onde obter o código-fonte deles.

A Apache-2.0 traz ainda **concessão explícita de patentes** pelos contribuidores, com cláusula de retaliação contra quem processar por patente. Isso não afeta o nosso uso.

**Automação na CI:**
- verificador de licenças sobre toda a árvore de dependências empacotadas, comparando com a lista de permitidas (com MPL-2.0); licença proibida ou caso a caso não registrada falha o build;
- o `THIRD_PARTY_NOTICES` é gerado automaticamente, com as licenças e os `NOTICE` dos pacotes Apache. A árvore muda com a plataforma (o pacote nativo do cofre do sistema é um por plataforma, como `@napi-rs/keyring-linux-x64-gnu`): o arquivo do repositório é o do Linux, e cada build do instalador gera o da sua plataforma e o leva junto (v0.58, N72);
- um verificador de cabeçalho confere que arquivos copiados de projetos Apache ou MPL mantêm o aviso e que os arquivos próprios têm o cabeçalho MPL-2.0.

### 6.1 Dependências (nível B)

| Necessidade | Projeto | Licença |
|---|---|---|
| Cliente ACP | `@agentclientprotocol/sdk` 2.x | Apache-2.0 |
| Servidor/cliente MCP + filtro por papel | MCP SDK v2: `@modelcontextprotocol/server` 2.4.0 (com `core` 2.4.0) e `@modelcontextprotocol/node` 2.1.2 na Fase 3 (N76); o `client` fica para a fase dos plugins | Apache-2.0 (era MIT até a v0.39; o `LICENSE` instalado do 2.4.0 diz Apache-2.0 **[V]**, spike `licenses`, D8) |
| Máquina de estados persistível | XState v5 (5.33.3 na Fase 3, N76) | MIT |
| HTTP, SSE, WebSocket | Hono + `@hono/node-server` (entram na Fase 3 pelo `@modelcontextprotocol/node`, travados em `hono` 4.13.16 e `@hono/node-server` 2.1.6, N76) | MIT |
| Validação | zod | MIT |
| SQLite | `better-sqlite3` (ou `node:sqlite`, parte do Node) | MIT |
| Query builder | Kysely | MIT |
| Processos e kill de árvore | execa 10 (`killDescendants`) | MIT |
| Telemetria | OpenTelemetry JS | Apache-2.0 |
| Sandbox (macOS/Linux; Windows em alpha) | `@anthropic-ai/sandbox-runtime`, como biblioteca ou envoltório | Apache-2.0 |
| Cofre | `@napi-rs/keyring` | MIT |
| Logs técnicos | pino | MIT |
| Agendamento (cron com fuso) | croner | MIT **[a confirmar]** |
| Histórico de consumo | ccusage (biblioteca, se exportar API; senão nível C, como CLI) | MIT |
| Front | React, Vite, TanStack Query, shadcn/ui, assistant-ui, @xyflow/react | MIT |
| Desktop (Fase 13) | Electron + electron-builder (ou Tauri v2, MIT/Apache) | MIT |
| Painéis do app (Fase 12, N39) | xterm.js e `node-pty` (Terminal); CodeMirror 6 com `@codemirror/merge` ou Monaco (Mudanças) | MIT **[a confirmar]** |
| App Android (Fase 14) | Capacitor (`@capacitor/core`, `@capacitor/android`) e plugins oficiais | MIT **[a confirmar]** |
| TUI | Ink + `@inkjs/ui` (decidido na Fase 0, N11) | MIT |
| Estado compartilhado TUI/web (`packages/client`) | zustand (modo vanilla) | MIT |
| Job Object (lançador Rust) | crate `windows-sys` (N60) | MIT ou Apache-2.0 |

### 6.2 Ferramentas externas e de desenvolvimento (níveis C e D)

| Componente | Licença | Nível | Observação |
|---|---|---|---|
| `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp` | Apache-2.0 | C (e A, se adaptarmos o código) | Processos separados; o código pode ser copiado e ajustado se for preciso |
| Claude Code | Proprietário | C | O próprio Executor |
| Codex CLI | Apache-2.0 | C | O próprio Executor |
| OpenCode | MIT | C | O próprio Executor |
| Gemini CLI | Apache-2.0 | C | Opcional |
| LiteLLM | MIT no núcleo (pasta `enterprise` à parte) | C | Gateway opcional |
| Arize Phoenix | ELv2 (source-available) | C | **Caso a caso, aceito como ferramenta local opcional**; nunca embutido nem distribuído |
| Harbor (validador ATIF) | Apache-2.0 | D | Testes de conformidade das trajetórias |
| TypeScript, Playwright, Vitest | Apache-2.0 / MIT | D | Desenvolvimento |

### 6.3 Código para copiar ou adaptar (nível A)

| Projeto | Licença, stack | O que aproveitar |
|---|---|---|
| **Emdash** (`generalaction/emdash`) | Apache-2.0, TS | Runtime ACP em stdio (`packages/core/src/runtimes/acp`), adaptadores claude/codex, agentes paralelos em worktrees. Primeira fonte de trechos do runtime ACP e dos worktrees (era o principal candidato a base de fork até a N1) |
| **acpx** (`openclaw/acpx`) | MIT, TS | Cliente ACP headless com sessões persistentes e eventos NDJSON: referência para `executors/` |
| **Claudexor** (`razzant/claudexor`) | MIT (© Anton Razzhigaev), TS | Referência de desenho e trechos pequenos nas áreas críticas (N41), em primeiro lugar nelas, antes do Emdash. Lista por área logo abaixo |
| **AionUi** | Apache-2.0, TS | Delegação líder/equipe sobre ACP com vários backends |
| **Orca** (`stablyai/orca`) | MIT, TS | Daemon + CLI, worktrees, DAG de tarefas |
| **ccmanager** | MIT, TS | Gestão de worktrees, `.worktreeinclude`, detecção de estado do agente (ocioso/ocupado/aguardando) |
| **rivet-dev/agents** | Apache-2.0, TS | Agentes de código atrás de uma API HTTP |
| **Happier** (`happier-dev/happier`) | MIT, TS | Interface web/desktop/mobile para vários agentes ACP |
| **Paradev** (`ParadevAI/Paradev`) | MIT, TS | Sessões paralelas em worktrees |
| **Nimbalyst** (sucessor do Crystal) | MIT na raiz **[V]** (commit `dc5a0ef`, 2026-11-14). Árvore de terceiros (`pnpm-lock.yaml`, licença pelo registro npm [S]): 1252 pacotes de produção, 15 LGPL (libvips do `sharp`, `libheif-js`) e 14 sem decisão; o verificador reprova (`spikes/licenses`, §6.4). Só referência de desenho, sem dependência, TS | Gestão de sessões paralelas |
| **claude-agent-acp / codex-acp** | Apache-2.0, TS | Ajustes nos adaptadores, se precisarmos |
| **Harbor** | Apache-2.0, Python | Modelos do ATIF, para portar o schema para zod |
| **Vibe Kanban** | Apache-2.0, Rust | Executores ACP e worktree por tarefa (desenho; o código é Rust) |
| **CodexBar** | MIT, Swift | Como obter a cota de cada provedor (lógica a portar) |
| **1MCP** (`@1mcp/agent`) | TS **[licença a confirmar]** | Agregação de MCPs com filtro por tags. Se a licença for permitida, pode rodar como sidecar; senão, o agregador é próprio (5.9) |
| **AgentPrism** | React, MIT no repositório; pacotes npm `data` e `types` 1.0.0 sem campo `license`, aceitos por exceção por pacote e versão (2026-11-15, N45, seção 6.0) **[V]** | Viewer de trajetórias. A UI não é publicada no npm: o readme manda copiar os componentes, o que é nível A com o aviso MIT |

**Claudexor nas áreas críticas** (decidido em 2026-11-15 pelo dono, N41: "vamos usá-lo como referência para não termos que reinventar código em áreas críticas"). A avaliação está em `spikes/fork-evaluation/claudexor.md`. Referência fixada na tag `v6.1.2`, commit `7a87c337b5b54f28f6038a4a7c5138da7cc87c4a` (2026-11-14); a avaliação leu o `main` de 2026-11-15. **[S]** para o código: lido, não executado.

| Área (seção, fase) | Caminho no Claudexor | O que aproveitar |
|---|---|---|
| Sondas de cota (5.6, Fase 5) | `packages/harness-claude/src/quota.ts`, `packages/harness-codex/src/quota.ts` | Parsers das janelas, razão de uso e reset; validação estrita |
| Pool de contas (5.7, Fase 5) | `packages/orchestrator/src/account-pool.ts` | Ranking por folga conhecida, desconhecida e esgotada; desempate estável; cota velha nunca autoriza rota |
| Rotação na retomada (5.16, Fase 5) | `packages/orchestrator/src/rotation-predicate.ts` | Só troca de conta se a tentativa não entregou nada nem mexeu no workspace |
| Login e perfis isolados (5.6, Fase 5) | `packages/harness-codex/src/auth.ts` (`probeLogin`, `CODEX_FILE_AUTH_ARGS`); a parte de isolamento de `packages/harness-claude/src/native-home.ts` | Sonda de login sem ler token; pasta de config própria por perfil |
| Store (7 e 5.21, Fases 1 e 3) | `packages/daemon/src/store/*` | Ideias: WAL com escritor único e lease, gravar antes do efeito externo, checar a versão do SQLite |
| API do daemon (5.12, Fase 6) | `packages/control-api`, `docs/reference/endpoints.json` | Desenho dos endpoints, SSE, acesso `loopback_bearer` |
| Orçamento (5.6, Fase 5) | `packages/budget` | Orçamento tipado; custo desconhecido nunca vale US$ 0 |
| Modelo local por API (5.9) | `packages/harness-raw-api` | Cliente compatível com OpenAI, com `baseUrl` e `/models`; o caminho principal continua o OpenCode |

Regras para copiar do Claudexor:
- **Atribuição:** o aviso MIT de copyright entra no `THIRD_PARTY_NOTICES`, e cada arquivo adaptado ganha um cabeçalho com o projeto, o caminho e o commit de origem. Vale também quando a lógica é reescrita a partir da leitura, porque os pacotes dele dependem uns dos outros (`@claudexor/schema`, `core`, `util`) e quase nada se copia sozinho.
- **Fica de fora** todo código que lê token OAuth ou arquivo de credencial, ou que chama a API do fornecedor por fora do cliente oficial (seção 3): `packages/cli/src/claude-oauth-*.ts`, `claude-resource-source.ts` e `claude-resource-transport.ts`; `packages/harness-codex/src/model-auth.ts`, `model.ts`, `images.ts` e `model-catalog.ts`; o `claudeAccountIdentity` e o `harness-claude/src/continuity.ts`.
- **Sem dependência de runtime:** nenhum pacote `@claudexor/*` entra no `package.json`. O ritmo dele (cerca de 20 commits por dia) tornaria a dependência instável.
- **Ao abrir cada fase**, relê-se o arquivo de referência no commit mais novo, porque o upstream muda rápido, e a nova referência fica registrada no cabeçalho. **[proposta]**
- **Trava na CI:** o verificador de cabeçalho da Fase 1 recusa, em código próprio, os nomes de arquivo de credencial e os endpoints proibidos (`.credentials.json`, `auth.json`, `/api/oauth/`, `backend-api/codex`), com exceção explícita para a lista `browser.secret_paths` e para os testes da própria trava. **[proposta]**

### 6.4 Avaliar como base de fork (Fase 0)

Candidatos, em ordem:
1. **Emdash** (Apache-2.0): o melhor encaixe técnico (runtime ACP em TS, adaptadores claude/codex, worktrees);
2. **Orca** (MIT): daemon + CLI e DAG de tarefas;
3. **AionUi** (Apache-2.0): orquestração líder/equipe sobre ACP;
4. **Paradev** e **Happier** (MIT).

O que **nenhum** deles tem é o nosso diferencial: pipeline teatral com papéis, Crítico e escalonamento; seleção por prioridade × cota com várias assinaturas; permissões por papel; ATIF.

Critérios da avaliação:
1. licença do projeto e de **todas** as dependências que o fork arrasta dentro da lista permitida (GPL, AGPL ou LGPL reprova);
2. o núcleo roda como daemon separado da UI, com API (ou pode ser separado sem reescrever);
3. a arquitetura aceita a máquina de estados por cima sem brigar com o modelo deles;
4. qualidade de código e testes;
5. ritmo de mudanças upstream (fork que diverge cedo vira manutenção dobrada).

**Resultado (2026-11-14, decisão do dono; item 1 da seção 12):** projeto próprio, sem fork. A avaliação está em `spikes/fork-evaluation/README.md`. Os trechos a reaproveitar vêm, nesta ordem, do Emdash (Apache-2.0) e do acpx (MIT); de Orca, Paradev e Happier, só ideias. Os binários libvips do `sharp` (`@img/sharp-libvips-*`) são LGPL-3.0-or-later e ficam de fora; o Happier os usa em produção.

**Complemento (2026-11-15, decisão do dono; N41):** o **Claudexor** (`razzant/claudexor`, MIT), que a avaliação de 2026-11-14 não viu, foi avaliado pelos mesmos critérios em `spikes/fork-evaluation/claudexor.md`. Tem a árvore limpa (0 proibidas em 196 pacotes) e um daemon com API separado da interface. Continua sem fork: não tem XState (critério 3), muda cerca de 20 vezes por dia (critério 5), fala com Claude e Codex por E/S nativa e não por ACP, e lê token OAuth, o que contraria a seção 3. Entra como **referência de desenho e fonte de trechos nas áreas críticas**, à frente do Emdash nelas (seção 6.3). O TeamClaude (`KarpelesLab/teamclaude`, MIT), um proxy que guarda e injeta os tokens das contas, não entra nem como fonte de código; dele ficam só ideias, como separar a cota esgotada do limite por minuto.

Padrão até a avaliação: **projeto próprio** com as dependências de 6.1 e trechos de 6.3. Se um fork passar, ele reduz a Fase 2 (runtime ACP, worktrees) e parte da Fase 12. Com a TUI como interface principal (v0.6), a interface gráfica desses candidatos pesa pouco (ver seção 10).

### 6.5 Avaliados e descartados

| Projeto | Motivo |
|---|---|
| Claude Squad, coder/mux, Toad | AGPL |
| Mastra workflows | Partes sob licença enterprise e dependência grande demais para um processo único; XState + SQLite basta |
| Drizzle ORM | Licença agora permitida, mas o Kysely já atende; sem motivo para trocar |
| DBOS TS, Absurd | Só Postgres |
| Temporal, Inngest, Restate | Servidor separado; desproporcional para um daemon local |
| Ruflo (ex-claude-flow) | App opinativo, não biblioteca |
| LangGraph.js | Não acrescenta sobre XState para um fluxo determinístico |
| Vercel AI Elements | Será descontinuado no fim de novembro de 2026 |
| MetaMCP, Docker MCP Gateway | Pesados (Postgres/containers) para embutir |
| coder/agentapi | Arquivado |
| Crystal | Descontinuado (sucessor: Nimbalyst) |

## 7. Modelo de dados (SQLite, WAL)

| Tabela | Conteúdo |
|---|---|
| `profiles` | id, cliente, tipo (`token_plan`/`api`), provedor, estado (`active`/`draining`/`removed`), diretório, referência do segredo |
| `executors` | id, profile_id, modelo, esforço, provedor do modelo (`provider`, 5.7), estado de validade |
| `roles` | papel, escopo (global, cenário ou tarefa agendada), scenario_id ou schedule_id, lista ordenada de executores, regra de esgotamento; a predefinição e os perfis permitidos por escopo (5.7) |
| `scenarios` | id, tipo (projeto/tarefa/chat), fluxo padrão (id do registro de fluxos, 5.18), nome, pasta, perfil de projeto e convenções detectadas (JSON, só projeto; 5.20), branch base, override de configuração, cenário de origem (promoção), estado do Diretor (ativo/adormecido), estado (ativo/arquivado) |
| `scenario_repos` | repositórios de um projeto (5.20): caminho, remoto, branch principal. Um por projeto na v1 |
| `task_definitions` | versão da definição de uma tarefa (5.20): objetivo, entradas, passos (JSON validado pelo registro de tipos de passo), artefato final, entrega, gatilhos, orçamento, estado (`draft`/`rehearsed`/`active`/`superseded`), peça `task.define` que a gerou, resultado do ensaio |
| `task_runs` | execução de uma tarefa (5.20): versão da definição, gatilho, pasta (e se foi podada pela retenção), estado de cada passo, artefato final, entrega, consumo, resultado |
| `attachments` | anexo `A<n>` (5.20): cenário, mensagem do chat, nome, tipo MIME, tamanho, hash, cópia na pasta ou caminho referenciado (só leitura) |
| `ideas` | ideia da fila do cenário (5.20, N91): cenário, texto ou anexo, prioridade, estado (`queued`, `grouped`, `done`, `discarded`, `deferred`), peça, motivo, timestamps **[proposta]** |
| `plays` (peças) | id, scenario_id, necessidade, ideias de origem (N91), id e versão do fluxo (5.18), snapshot XState, contadores, timestamps |
| `stages` | etapas executadas de cada peça (papel, tentativa, resultado) |
| `demands` | demandas do roteiro (campos de `Demand`), estado |
| `attempts` | tentativa por demanda: executor, worktree, branch, sessão ACP, início/fim, commit WIP, resultado estruturado; contador de retomadas; último checkpoint; último evento processado |
| `sessions` | sessões ACP: processo (pid e instante de início, para achar órfãos na subida; 5.21), perfil, papel, worktree, id da sessão no cliente (para `session/load`), estado (`active`/`interrupted`/`awaiting_resume`/`resuming`/`closed`) |
| `interruptions` | interrupção de uma sessão: causa classificada, sinais que a indicaram, forma de retomada (nativa/bastão), Executor de origem e destino, se contou como tentativa |
| `side_effects` | efeitos colaterais por chave de idempotência (`attempt + step`): ferramenta, parâmetros resumidos, resultado gravado, momento antes/depois, estado (`pending`/`done`/`not_done`/`ambiguous`) e como a ambiguidade foi resolvida (verificador ou Produtor; 5.21) |
| `prompt_queue` | fila única de prompts do Orquestrador (origem, prioridade, estado) |
| `decisions` | pontos de julgamento: tipo, entrada, resposta, quem decidiu |
| `blackboard` | chave, versão, conteúdo (plano, roteiro, contratos, decisões) |
| `events` | id crescente (estrito, com buracos possíveis), timestamp em epoch ms, scenario/play/attempt (opcionais), tipo, payload JSON. Desde a Fase 1 (N50): o tipo é um nome em inglês, minúsculo, com pontos e dois segmentos ou mais (`daemon.started`); o payload é sempre um objeto e é validado por um registro tipo → versão → schema estrito em `packages/protocol`; fora da transação só aparece o que foi confirmado, e uma transação aparece inteira |
| `quota_snapshots` | perfil, janela, uso, reset, fonte do sinal |
| `usage` | consumo por sessão/perfil/janela: tokens, custo real (API) ou equivalente em API (assinatura), fonte do valor (`client`/`pricing_table`) e versão da tabela de preços (5.6) |
| `wakeups` | despertar interno (5.6): perfil, causa (`quota`/`budget`), horário, estado, id do gatilho no sistema operacional |
| `plugins` | manifesto (com o painel declarativo e os tipos de evento), versão, estado, projetos ativos |
| `browser_sessions` | sessão do navegador compartilhado (5.19): cenário, adaptador (`extension` ou `playwright`), modo e pasta do perfil, grupo de abas, domínios permitidos, URL atual, quem controla (agente/Produtor), estado |
| `indications` | indicação `I<n>` (5.19): tipo e versão do tipo, superfície de origem, cenário, mensagem do chat, conteúdo JSON (validado pelo schema do tipo; para `web_element`: URL, título, seletor, trecho do HTML, caixa), caminho do recorte, comentário, criada em |
| `schedules` | tarefa agendada: cenário, necessidade (projeto) ou tarefa e versão da definição (5.20), tipo (uma vez/cron/intervalo/após reset), expressão e fuso, overrides, política de entrega, orçamento, regras (perdida, sobreposição, cota, decisão), próximo disparo, estado, id do gatilho no sistema operacional |
| `directives` | ordem do Produtor (5.17): id `O<n>`, escopo (global/cenário), scenario_id, tipo (`instruction`/`rule`/`suspension`), texto, chave e valor (para `rule`), ordem suspensa (para `suspension`), papéis, início, fim, fuso, janela (cron + duração; depois da v1), estado (`scheduled`/`active`/`expired`/`revoked`), criada em, origem (chat/TUI/terminal/importação), substitui, revogada em, motivo. As mudanças de vigência ficam nos eventos `directive.validity_changed` |
| `schedule_runs` | execução de uma tarefa: horário previsto e real, motivo (horário, atraso, rodar agora), peça gerada, resultado, notificações enviadas |

Acesso via **Kysely** (MIT; query builder tipado) sobre `better-sqlite3`, dentro do adaptador padrão da porta `Store` (5.18). O resto do daemon não vê SQL. No Electron, o `better-sqlite3` exige rebuild do módulo nativo; `node:sqlite` do Node 24 é alternativa sem binário nativo. Desde 2026-11-15 (N49), os dois entram pela chave `store.driver: better-sqlite3 | node-sqlite`, com padrão `better-sqlite3`; a mesma suíte de conformidade roda nos dois, e a medição do `FULL` e do backup na Fase 1 (5.21, 2026-11-16) não mudou o padrão. A telemetria (spans, métricas e logs OTLP) não fica neste store, e sim numa base própria, `telemetry.sqlite` (5.11, N54). Migrations versionadas com o migrator do próprio Kysely. O store abre com `journal_mode=WAL` e `synchronous=FULL` (e `fullfsync` no macOS) e tem backup diário (5.21).

## 8. Stack

| Área | Escolha |
|---|---|
| Runtime | Node 24 LTS |
| Linguagem | TypeScript strict |
| Contratos | `@otheater/core`: portas (interfaces) + schemas zod, semver por porta; suítes de conformidade em `@otheater/sdk` (5.18) |
| Montagem | Composição manual num ponto de montagem (`compose.ts`), sem container de injeção nem decorators |
| Monorepo | pnpm workspaces |
| CI | GitHub Actions: Linux a cada push; Windows e macOS por disparo manual (N49) |
| Regra de dependência | dependency-cruiser (N49) |
| i18n | i18next + `react-i18next` (N49) |
| ACP | `@agentclientprotocol/sdk` 2.x + adaptadores como processos externos |
| MCP | `@modelcontextprotocol/server` / `client` (SDK v2) |
| Fluxo | XState v5 |
| HTTP | Hono + `@hono/node-server` |
| Validação | zod |
| Banco | `better-sqlite3` (padrão) ou `node:sqlite`, pela chave `store.driver` (N49) + Kysely |
| Processos | execa 10 + lançador Rust (`windows-sys`) no Windows |
| Sandbox | `@anthropic-ai/sandbox-runtime` (macOS/Linux; Windows em piloto) |
| Cofre | `@napi-rs/keyring` |
| Git | CLI `git` + `gh` |
| Consumo | ccusage |
| Telemetria | OpenTelemetry JS + receptor OTLP no daemon |
| Logs técnicos | pino |
| Agendamento | croner (cron com fuso) + gatilho do agendador do sistema operacional |
| TUI (interface principal) | Ink + `@inkjs/ui` (decidido na Fase 0, N11) |
| Cliente e estado compartilhados | `packages/client`: cliente REST/SSE/WS + stores zustand (vanilla) |
| Web (depois da v1; base do Android) | React + Vite + shadcn/ui + assistant-ui + @xyflow/react |
| Desktop (Fase 13) | Electron (ou Tauri v2) |
| Android (celular e tablet) | Capacitor sobre a web |
| Navegador compartilhado | Extensão Manifest V3 no navegador do Produtor, o Opera primeiro (padrão, N40); Playwright (Apache-2.0) sobre CDP, com Chromium, nos outros modos de perfil e nos testes (5.19) |
| Testes | Vitest + Playwright + `ink-testing-library` (TUI) |

**Agente simulado para testes** (`packages/fake-agent`), construído com o lado `agent()` do próprio SDK do ACP. Responde roteiros determinísticos: edita arquivo, chama ferramenta, falha, estoura tempo, pede permissão, emite sinal de cota. A máquina de estados, os pools e a UI são testados sem gastar cota. O roteiro vem da diretiva `#script:<nome> {json opcional}` na primeira linha do prompt ou da variável `FAKE_AGENT_SCRIPT`; o roteiro `fail` usa o erro `-32603`; o agente anuncia `loadSession: true`, usa ids `fake-session-N` e recusa um segundo prompt simultâneo na mesma sessão (2026-11-16, N50).

**Testes de contrato dos adaptadores:** fazem parte das suítes de conformidade de `ClientAdapter` e `AgentSession` (5.18). Uma suíte curta roda contra cada adaptador real fixado (`initialize`, config options, MCP HTTP, cancelamento) e é executada a cada atualização de versão (P10). Desde 2026-11-16 (N57), o `pnpm test` roda só a parte offline. A parte real exige `OT_TEST_REAL_CLIENTS=1` e usa perfis isolados e vazios. Os testes que mandam prompt gastam tokens e usam o login do dono, por isso exigem também `OT_TEST_REAL_PROMPTS=1` e só rodam com o ok dele.

## 9. Estrutura do repositório

**Nome, pacotes e comando.** Conferido em 2026-11-13. Repetir a conferência antes de publicar, porque nomes livres podem ser tomados.

| Item | Escolha | Situação na conferência |
|---|---|---|
| Produto | **OTheater** (*Orchestration Theater*) | — |
| Pacote principal no npm | `otheater` | Livre |
| Pacotes internos | escopo `@otheater/*` (`@otheater/daemon`, `@otheater/client`, `@otheater/tui`…) | Nome livre no registro. A criação da organização `otheater` no npm não dá para conferir sem login: confirmar ao criar |
| Comando de terminal | **`ot`** (curto, uso diário) + `otheater` (nome completo, mesmo programa) | Os pacotes `ot` e `oth` existem no npm, mas são bibliotecas antigas sem comando de terminal: não colidem. Não há comando `ot` padrão em Windows, macOS ou Linux. Conferir de novo na Fase 10, antes de registrar o `ot` no instalador |
| Organização no GitHub | **`orchestration-theater`** | Livre. `otheater` já é uma conta de usuário criada em 2021, sem repositórios públicos |
| Alternativas reservas | `otheatre` (npm e GitHub livres) | — |
| Marca | — | Não conferida. Consultar o INPI (e o registro do país de distribuição) se o produto for distribuído |

```
/
├─ packages/
│  ├─ core/            portas (interfaces), schemas zod do domínio, erros tipados, lógica pura; só depende do zod (5.18)
│  ├─ sdk/             para escrever adaptadores e plugins: tipos, utilitários e suítes de conformidade (antigo plugin-kit)
│  ├─ protocol/        contrato da API com as interfaces: REST, SSE, WS, eventos, ATIF (usa os schemas do core)
│  ├─ adapters/        um pacote @otheater/adapter-* por adaptador
│  │  ├─ client-claude-code/  client-codex/  client-opencode/  client-gemini/
│  │  ├─ session-acp/  session-headless/
│  │  ├─ quota-claude/  quota-codex/  quota-minimax/  quota-rate-limit/
│  │  ├─ store-sqlite/  vault-keyring/  vault-file/  clock-system/
│  │  ├─ vcs-git/  codehost-github/
│  │  ├─ sandbox-runtime/  telemetry-otel/  export-atif/  browser-playwright/  browser-extension/
│  │  └─ platform-windows/  platform-posix/   (lançador, gatilho do SO, manter acordado, monitor de RAM)
│  ├─ daemon/
│  │  ├─ src/compose.ts      (ponto de montagem: escolhe e liga os adaptadores)
│  │  ├─ src/api/
│  │  ├─ src/pipeline/       (registro de fluxos, etapas reutilizáveis, peça teatral)
│  │  ├─ src/selection/
│  │  ├─ src/accounts/       (perfis, cofre, sondas de cota)
│  │  ├─ src/executors/      (pools, admissão; os clientes vêm de adapters/)
│  │  ├─ src/mcp/            (servidor do framework, agregador de plugins)
│  │  ├─ src/tools/
│  │  ├─ src/resources/
│  │  ├─ src/workspace/
│  │  ├─ src/directives/     (ordens globais e locais, aplicação das regras)
│  │  ├─ src/scheduler/      (agenda, croner, gatilhos do sistema operacional, pedido de manter acordado)
│  │  ├─ src/scenarios/      (tipos de cenário, perfis de projeto, anexos, promoção, Diretor adormecido)
│  │  ├─ src/tasks/          (definição, ensaio e motor de passos das tarefas)
│  │  ├─ src/recovery/       (reconciliação na subida, verificadores de efeito, backup)
│  │  ├─ src/store/          (serviços sobre a porta Store; o SQL fica em adapters/store-sqlite)
│  │  └─ src/telemetry/      (spans; receptor e exportadores vêm de adapters/)
│  ├─ fake-agent/      agente ACP simulado
│  ├─ client/          cliente da API (REST, SSE, WS) + stores de estado e preferências, sem interface
│  ├─ tui/             TUI, interface principal (Ink)
│  ├─ web/             web (Fase 12; base do Android)
│  ├─ desktop/         Electron ou Tauri (Fase 13)
│  ├─ android/         Capacitor sobre a web: celular e tablet (Fase 14)
│  ├─ browser-extension/  extensão Manifest V3 do navegador compartilhado, o Opera primeiro (5.19, N40)
├─ native/
│  └─ job-launcher/    lançador Rust com Job Object (Windows)
├─ prompts/            prompts de cada papel, em inglês (versionados, prefixo estável; 5.22)
├─ locales/            catálogos de texto da interface: en, pt-BR (5.22)
├─ tools/              ferramentas do repositório, fora do produto: verify (verificadores da CI), bench (medições)
├─ docs/               este documento, ADRs, guia de plugins
├─ spikes/             código descartável da Fase 0
└─ THIRD_PARTY_NOTICES.md   avisos de terceiros, gerados pela CI (6.0)
```

O `THIRD_PARTY_NOTICES.md` fica na raiz, e não em `docs/`, porque `docs/` é de desenho e fica fora do Prettier (2026-11-16, N50). Os pacotes `@otheater/adapter-clock-system` (relógio do sistema, N51) e `tools/` entraram na Fase 1.

## 10. Fases de construção

Estimativas para **1 desenvolvedor em tempo integral**, sem e com apoio de agentes de código (a partir da Fase 5, o próprio framework pode construir as seguintes). São faixas, não prazos. O maior fator de incerteza é a Fase 0, que também decide se haverá fork.

### Fase 0 — Validações e escolha da base

Medições técnicas:
- **Adaptadores** `claude-agent-acp`, `codex-acp`, `opencode acp`:
  - sessão com `cwd` de worktree e `mcpServers` HTTP;
  - streaming, cancelamento, `request_permission`, `session/load`;
  - config options disponíveis (modelo, esforço, modo).
- **Concorrência:** 3 sessões simultâneas por adaptador, medindo processos e RAM. Define `processModel`, `K` e o custo por sessão.
- **Retomada nativa:** em cada adaptador, matar o processo no meio de uma tarefa e simular cota esgotada; conferir se `session/load` recupera a conversa (mesmo perfil e worktree), onde o cliente guarda os arquivos de sessão dentro do diretório do perfil e quanto tempo eles duram. Medir também a qualidade da passagem de bastão: uma tarefa interrompida e continuada por **outro** cliente a partir do pacote de continuação.
- **Perfis isolados:** dois logins do mesmo cliente lado a lado (`CLAUDE_CONFIG_DIR`; `CODEX_HOME` + `cli_auth_credentials_store="file"`; XDG/`OPENCODE_DB` no Windows).
- **Permissões pelo ACP:** como fazer chegar `tools`/deny/`dontAsk`/`--strict-mcp-config` ao Claude via adaptador; política do OpenCode V2; sandbox do Codex (MXC) nesta máquina.
- **Cota:** statusline por perfil gravando `rate_limits`; repasse ou não do `rate_limit_event` pelo adaptador; `account/rateLimits` do Codex; `token_plan/remains` da MiniMax.
- **Sandbox Windows:** piloto do `sandbox-runtime` alpha; plano B com usuário de baixo privilégio.
- **Lançador Rust** com Job Object: protótipo de criar suspenso → associar → retomar.
- **Modelo local:** Gemma 4 em llama.cpp `--jinja` via OpenCode, fazendo chamadas MCP estruturadas.
- **TUI: Ink × OpenTUI** (3–4 dias, **obrigatório**; inclui a matriz de terminais e atalhos). Protótipo mínimo nos dois frameworks com o layout de `mockup/tui.html` (lateral, chat, painel), alimentado por um gerador de eventos falso. Medir:
  - **streaming no chat:** 20–50 atualizações por segundo durante 5 minutos, sem tremulação nem atraso de digitação;
  - **rolagem:** histórico de 5.000 mensagens e trajetória de 1.000 passos, com rolagem fluida e memória estável;
  - **layout:** Ctrl+←/→ na largura do chat, Alt+S e Alt+J (eram Ctrl+B e Ctrl+J; ver a tabela de atalhos em 5.13), e redimensionar a janela do terminal sem quebrar bordas;
  - **terminais:** Windows Terminal, terminal do VS Code, Terminal.app e iTerm2 (macOS), um terminal de Linux (GNOME Terminal ou Konsole), dentro do tmux e por SSH; acentos, `█`/`░` e bordas arredondadas;
  - **atalhos:** cada linha do mapa de teclas da seção 5.13, nos terminais acima, registrando o que chega à TUI. Pontos a confirmar:
    - Ctrl+J distinguível do Enter;
    - Shift+Enter distinguível do Enter;
    - Alt+J, Alt+S, Alt+K, Alt+A e Alt+W chegando à TUI (era Ctrl+K no VS Code; atalhos mudados pela N35);
    - Ctrl+Shift+←/→ no macOS;
    - Alt com e sem "Option como Meta".

    O resultado define os padrões por ambiente;
  - **mouse:** clique em aba (bônus; não decide sozinho);
  - **runtime:** OpenTUI no Node ou só no Bun, e o custo de empacotar o Bun junto.

  **Critério:** fica o Ink se passar nos três primeiros itens; senão, OpenTUI. A decisão vira ADR.
- **OTel:** Claude Code e Codex exportando para um receptor local com atributos de correlação.

Avaliação de base (2–3 dias dentro da fase): Emdash, Orca, AionUi, Paradev e Happier, nessa ordem, pelos critérios da seção 6.4, começando pela licença das dependências que cada um arrasta. Com a TUI como interface principal, a avaliação olha o **núcleo** deles (runtime ACP, worktrees), não a interface gráfica. Leitura do runtime ACP do Emdash e do acpx.

Licenças: confirmar na fonte as marcadas **[a confirmar]** (1MCP, AgentPrism, Nimbalyst) e rodar um verificador de licenças (`license-checker` ou equivalente) sobre a árvore de dependências inicial. Qualquer licença proibida, ou fora da lista sem decisão registrada, reprova.

Termos: confirmação com a Anthropic sobre o uso de assinatura num orquestrador pessoal versus distribuído (R1).

**Entregável:** relatório de spikes + ADRs (inclusive fork sim/não) + ajustes neste documento. O relatório está em [spikes/RELATORIO-FASE-0.md](../../spikes/RELATORIO-FASE-0.md) (2026-11-15).
**Critério de aceite:** cada item com resposta medida, não suposta.
**Estimativa:** 2–3 semanas (inclui os 3–4 dias do teste da TUI, **obrigatório**: a TUI é a interface principal e o framework dela precisa estar decidido antes da Fase 7).

**Fechamento (2026-11-15, N48):** a Fase 0 foi fechada **com portões**, sem cumprir o critério de aceite. Em 2026-11-15, 11 dos 24 itens do relatório estavam medidos em Linux; os outros 13 viraram condição da fase que usa a resposta, e essa fase não fecha sem medi-los:

| Itens do relatório | Portão | Até lá |
|---|---|---|
| 13 (lançador Rust com Job Object) | Fase 2 | `killDescendants` em Linux e macOS |
| 9 (MXC do Codex), 12 (sandbox Windows) | Fase 4, parte de Windows da camada 3 | camada 3 só em macOS e Linux |
| 4 (cota esgotada com assinatura real), 6 (bastão com n maior), 7 (segundo login), 10 (cota em valor alto), 11 (MiniMax), termos da OpenAI (D3, resto do 23) | Fase 5 | dados parciais do relatório |
| 19 (terminais e atalhos reais), 20 (mouse fora do tmux) | Fase 7 | medição só no tmux; Ctrl+J garante a nova linha |
| 14 (Gemma 26B-A4B e 31B rodando aqui: RAM e velocidade) | entrada do modelo local como Executor (N29) | qualidade medida pela API do Google |
| 24 (R1, confirmação da Anthropic) | Fase 10 (seção 11) | uso pessoal com os clientes oficiais e logins próprios |

A Fase 1 pode começar. Nenhuma medição a mais foi feita antes dela.

### Fase 1 — Fundação

- Monorepo, lint, testes, CI, `THIRD_PARTY_NOTICES`. A CI é o GitHub Actions: Linux a cada push, Windows e macOS por disparo manual, que também serve aos portões 9, 12 e 13 da Fase 0 (N49).
- Automação de licenças da seção 6.0 na CI: verificador da árvore de dependências contra a lista permitida, geração do `THIRD_PARTY_NOTICES` (com os `NOTICE` dos pacotes Apache) e verificação de cabeçalho nos arquivos copiados. O verificador precisa ler árvores pnpm (seguir os links de `node_modules/.pnpm`) e reprovar quando não acha nenhum pacote: o do spike de licenças aprovava 0 pacotes em silêncio nesse caso **[V]**. A mesma verificação traz a trava de credenciais da seção 6.3 **[proposta]**.
- `packages/core` com as primeiras portas (`Store`, `EventLog`, `Clock`, `SecretVault`), os erros tipados e as funções puras iniciais; `packages/protocol` com os primeiros schemas da API.
- `packages/sdk` com o esqueleto das suítes de conformidade.
- Regra de dependência na CI (5.18): `core` sem infraestrutura; o daemon só importa adaptadores no ponto de montagem.
- Daemon esqueleto:
  - ponto de montagem (`compose.ts`);
  - configuração;
  - lock de instância;
  - store SQLite + migrations, com `synchronous=FULL` e backup diário (`ot backup`, `ot restore`; 5.21);
  - log de eventos;
  - pino.
- Idioma (5.22): biblioteca de i18n escolhida, catálogos `en` e `pt-BR` em `locales/`, chave `ui.locale` e verificação dos catálogos na CI.
- `fake-agent` mínimo sobre o SDK do ACP.

**Critério de aceite:** o daemon sobe, grava e lê eventos, testes verdes na CI; um backup feito com o daemon no ar passa no `integrity_check` e o `ot restore` devolve o estado, com o custo do `FULL` medido; o mesmo daemon sobe montado com fakes (`Store` em memória, `Clock` falso), e a CI reprova um import que fure a regra de dependência.
**Resultado (2026-11-16, passo 7):** critério cumprido em Linux **[V]**:
- o daemon sobe e grava e lê eventos (passo 5);
- o `pnpm check` passa na máquina e na CI do GitHub Actions (job `linux`) a cada push;
- um backup feito com o daemon no ar e um escritor ativo passa no `integrity_check`, e o `ot restore` descarta os eventos posteriores à cópia (teste de aceite do passo 5);
- o custo do `FULL` foi medido (5.21);
- o mesmo `startDaemon` sobe sobre `InMemoryStore` e `FakeClock`;
- o `pnpm deps` reprova os imports proibidos.

Ficam fora **[N]**: Windows e macOS (com o `fullfsync`), o prompt de senha sem eco num TTY real e o `KeyringVault` dentro do daemon.
**Estimativa:** 1,5 semana (era 1 na v0.11: entram `core`, `sdk`, ponto de montagem e regra de dependência).

### Fase 2 — Camada de Executores

- Cliente ACP sobre o SDK; adaptadores prontos configurados por perfil (`command`, `profileEnv`, `prepareProfile`).
- Aplicação de modelo/esforço por config options.
- Pools com `K` e `processModel` medidos. A chave de `K` é por cliente e herda a global (N74). A medição passa pelo pool do daemon, com os adaptadores e o lançador reais, nos três clientes, com 1, 2, 4 e 6 sessões, ociosas e com prompts; quem roda é o dono, porque a parte com prompts gasta cota (N57), e o padrão de cada cliente saiu dela.
- **Medição real de `K` e `processModel` (2026-11-16) [V]:** rodada pelo dono às 23:13 (UTC-3), em Linux, uma vez, com `tools/acceptance/real-acceptance.sh --level k` (teste `k-measure.real.test.ts`), pelo pool do daemon com adaptadores e lançador reais. Modelos: Claude Code `haiku`, Codex `gpt-5.6-luna`, OpenCode `opencode/deepseek-v4.1-flash-free`; prompt curto e sem ferramentas; N em 1, 2, 4 e 6; "shared" é `K`=N (um processo) e "own" é `K`=1 (N processos). PSS por sessão (MB), ocioso / com prompt, e tempo de parede dos N prompts simultâneos:
  - Claude Code (`process-per-session` fixo, o `K` não se aplica): 300,7 / 313,6 (N=1), 243,8 / 257,5 (2), 226,7 / 239,1 (4), 218,7 / 251,3 (6); parede de 1694, 1731, 1773 e 2433 ms.
  - Codex shared: 266,8 / 286,7 (1), 131,5 / 145,9 (2), 70,5 / 84,8 (4), 50,9 / 60,1 (6); parede de 1604, 1652, 2053 e 1626 ms. Codex own: 183,8 / 197,3 (2), 145,6 / 161,9 (4), 138,3 / 150,1 (6); parede de 1326, 1551 e 2678 ms.
  - OpenCode shared: 337,5 / 608,4 (1), 177 / 315,8 (2), 104 / 235,6 (4), 72,5 / 174,2 (6); parede de 2151, 3122, 3613 e 6287 ms. OpenCode own: 285,8 / 547 (2), 272,4 / 521,9 (4), 267,2 / 513,9 (6); parede de 2627, 4023 e 3558 ms.
  - Leitura: no Codex, um processo com 6 sessões usa cerca de 40% da memória de 6 processos sem perder latência; no OpenCode, com 4 sessões a latência é parecida (3,6 s contra 4,0 s), mas com 6 o processo único enfileira (6,3 s contra 3,6 s). O teste abriu as sessões uma de cada vez por causa de uma corrida no pool, corrigida depois no PR #46. Padrões decididos pelo dono: Codex 6 (acima de 6 não foi medido [N]), OpenCode 4, Claude Code herda a global.
- Lançador Rust (Windows), com `killDescendants` como fallback. O teste real roda na CI Windows, por disparo manual; nesta máquina, só `cargo check` e `clippy` (N58).
- Worktrees e branches.
- Timeout → commit WIP → `session/cancel` → kill.
- Checkpoints automáticos (por lote de edições, a cada N minutos e em toda interrupção) e registro por tentativa: referência da sessão ACP, perfil, worktree, último checkpoint, último evento.
- **Retomada nativa** (`session/load`) para queda do processo e reinício do daemon, com recuo exponencial para erros transitórios.
- `session/update` → eventos.
- Testes de contrato dos adaptadores, dentro das suítes de conformidade de `ClientAdapter` e `AgentSession` (5.18). Cada cliente num pacote `@otheater/adapter-client-*`. A parte real só roda com as variáveis da N57 (seção 8).
- `ModelCatalog` de cada cliente (descoberta automática no Claude Code e no Codex, assistida no OpenCode) e os adaptadores `llama-cpp` e `ollama` da porta `LocalModelServer` (N71), cada um com a sua suíte de conformidade (5.18, v0.23).
- Passo P13: gancho de veto de modo na base `ClientAdapter`, no lugar do transporte de guarda do Codex, e o `via` como parâmetro de `command(profile)` (N61, 5.2).
- Versão do cliente pelo `package.json` do pacote instalado, confirmada pelo `initialize`, depois do P13 (N63, 5.2).

**Critério de aceite:** N Executores reais e simulados em worktrees diferentes, stream como eventos, cancelamento por timeout sem processo órfão e com WIP commitado.
**Aceite real, nível `clients` (2026-11-16) [V]:** rodado pelo dono com `tools/acceptance/real-acceptance.sh` (N57), na main depois do PR #38, com `claude-agent-acp` 0.107.0, `codex-acp` 2.6.0 e `opencode-ai` 1.19.5. Os três clientes sobem em perfil vazio e não deixam processo. O Claude Code e o OpenCode abrem sessão. O Codex é recusado no `session/new` com `PermissionDenied` (`auth_required`), como medido na Fase 0, e o pool fica vazio. O pico de memória foi de ~0,7 GB. Faltam o nível `prompts`, que gasta cota e usa o login do dono, e a medição de `K` e `processModel`.
**Aceite real, nível `prompts` (2026-11-16) [V]:** rodado pelo dono com o mesmo script, na main depois do PR #41, com o Claude Code (`claude-agent-acp` 0.107.0, modelo `haiku`, modo `acceptEdits`, perfil de teste logado) e duas tentativas simuladas (o agente falso pelo transporte ACP stdio real). O critério passou inteiro: stream como eventos, rascunho do Claude Code em worktree próprio, edição simulada com checkpoint, edição simulada recusada pela política `onAsk: reject` (sem arquivo nem checkpoint), corte por timeout com o WIP commitado, worktrees diferentes e nenhum processo depois de parar o daemon. O pico de memória foi de ~0,9 GB. As duas rodadas anteriores falharam e foram corrigidas: `session.update` gravado antes do `session.opened` (PR #40) e a edição simulada que pedia permissão e era recusada, um erro do teste (PR #41). O Codex (sem `codex-acp` no PATH) e o OpenCode (sem perfil de teste) ficaram de fora do nível `prompts` [N]. Falta a medição de `K` e `processModel`.
**Fechamento (2026-11-16, N75):** a Fase 2 foi fechada **com portões**, com o critério de aceite cumprido em Linux [V]: aceite real nos níveis `clients` e `prompts` e medição real de `K` e `processModel` nos três clientes. Ficam como portões [N]: o aceite real no nível `prompts` com o Codex e com o OpenCode é condição da primeira peça real com cada um como Executor (a peça real da Fase 3 usa só o Claude Code com o Haiku); a medição de `K` acima de 6 é condição de qualquer padrão de `K` maior que 6.
**Estimativa:** 2 semanas (era 1,5 na v0.9: entram checkpoints e retomada nativa).

### Fase 3 — Pipeline, MCP do framework e blackboard

Plano de passos, com dependências, paralelismo e aceite de cada passo: [docs/14](../14-PLANO-DA-FASE-3.md) (N77).

- Servidor MCP v2 com fábrica por papel e token por sessão.
- Schemas de saída + `submit*` com revalidação, até `limits.submit_retries` correções (N79).
- `ot chat` mínimo no terminal: o daemon abre o Diretor, e o Produtor conversa com ele pela fila única de prompts, com as perguntas do `ask_producer` respondidas ali (N78).
- Registro de fluxos e etapas reutilizáveis (5.18); a peça teatral como fluxo padrão: máquina XState completa (seção 5.4), com persistência, contadores, escalonamento e `AWAITING_PRODUCER`.
- Registros de papéis, ferramentas, chaves de `rule` e tipos de evento, validados na subida; o `append` recusa o evento fora do registro (`events.unknown_type: reject`, N80).
- Validação do roteiro (ciclos, contratos, arquivos).
- DAG em ordem topológica.
- Integração antes do Crítico; entrega por PR.
- Blackboard; fila única de prompts do Orquestrador.
- Ordens globais e locais (seção 5.17), sem a janela recorrente: tabela, ferramentas do Diretor, entrada no prefixo dos Executores e no pacote de continuação, `ot directives`.
- Prompts iniciais dos papéis.
- Cenários (5.20): registro de tipos, pasta por cenário, anexos com `read_attachment`, Diretor adormecido e fluxo `chat` com o papel `consultant`.
- Reconciliação na subida (5.21), com os verificadores das cascas oficiais.

**Critério de aceite:**
- peça ponta a ponta com o `fake-agent` cobrindo os quatro desfechos e o critério de parada;
- reinício do daemon no meio da peça, retomando do snapshot;
- `kill -9` do daemon no meio de um efeito colateral: na subida, a reconciliação mata o processo órfão, resolve o efeito pelo verificador (ou pergunta ao Produtor) e nada se repete;
- uma ordem global e uma local chegam ao prompt do Orquestrador e dos Executores e sobrevivem ao reinício; uma ordem com início futuro só entra no prompt depois do início; uma ordem que vence com o daemon parado não entra em sessões abertas depois do reinício; uma suspensão tira a global de um cenário só; uma `rule` revogada devolve o valor da configuração;
- uma peça real pequena concluída com o Orquestrador em `claude-agent-acp` + Haiku: num repositório git local criado pelo teste, com todos os papéis no Haiku e a entrega no `CodeHost` falso, rodada pelo dono (N87);
- no chat, uma pergunta simples é respondida pelo Diretor, uma pergunta difícil abre o consultor, e um anexo de imagem só vai para um Executor que aceita imagem; o Diretor adormece e acorda pelo resumo sem perder o estado.

**Marco interno 3a (N77):** os três primeiros itens do aceite (peça ponta a ponta com o `fake-agent`, reinício no meio da peça e `kill -9` no meio de um efeito colateral). Ordens, cenários, chat e a peça real vêm depois.
**Fechamento (N88):** a Fase 3 fecha depois que o dono rodar o nível `play` do aceite real e ele passar; o resultado entra aqui, com data e **[V]**. Antes do aceite, o passo P15 liga as três partes que ficaram sem ligação no código (N86).
**Resultado do fechamento (2026-11-17, [V]):** o nível `play` passou na terceira rodada. Quem rodou foi o orquestrador (Claude), a pedido do dono, que estava remoto e deu o ok para cada rodada; o perfil foi o de teste do Claude Code, com o Haiku em todos os papéis e `OT_TEST_CLAUDE_MODE=acceptEdits`. Antes da peça, o teste da chamada MCP (`mcp-submit.real.test.ts`) passou. A peça chegou a `DONE` em 103 s, passando por PLANNING, REVIEWING_PLAN, SCRIPTING, REVIEWING_SCRIPT, EXECUTING, INTEGRATING, CRITIQUING e DELIVERING, com 7 tentativas e 7 `submit*` aceitos. A primeira tentativa do Ator falhou na verificação (`node --test`: o `ø` não se decompõe no NFD), e a segunda passou, o que exercitou a retentativa. O Crítico aprovou, o PR foi aberto no `CodeHost` falso, e nenhum processo de cliente sobrou (8 abertos, nenhum vivo ao fim). O custo somado foi de US$ 0,0275, e o pico de memória, de cerca de 894 MB. As duas rodadas anteriores falharam e foram corrigidas. Na primeira, nenhuma peça foi aberta em 25 min, porque o Claude Code não liberava as ferramentas MCP do papel (PR #70). Na segunda, as ferramentas de etapa validavam com um esquema genérico, e um `submit_plan` aceito virava `SUBMIT_FAILED` na máquina (PR #71, com os esquemas reais). Observações que não bloqueiam o fechamento: as ferramentas de trabalho sem manipulador (`run_tests`, `restricted_shell`, `git_commit`, `view_diff`) respondem `not_implemented`, e por isso o Crítico aprovou com a ressalva de não ter rodado os testes nem visto o diff (Fase 4); nas atualizações `usage`, os tokens saíram 0 e só o custo veio preenchido **[N]**; o Codex e o OpenCode não entraram na peça. **A Fase 3 está fechada.**
**Marco: MVP utilizável sem UI**, conversando com o Diretor pelo `ot chat` no terminal, com o Diretor aberto pelo daemon (N78; até a v0.60, pelo próprio cliente apontado para o MCP do framework).
**Estimativa:** 3,5 semanas (era 2,5 na v0.13; a v0.14 acrescentou a base dos cenários e o chat, e a v0.15 a reconciliação) **[proposta]**.

### Fase 4 — Permissões e ferramentas de trabalho

- `prepareProfile` gerando a camada 1 para cada cliente a partir da política do papel.
- Resposta automática a `request_permission` (camada 2).
- Camada 3: `sandbox-runtime` em macOS/Linux; no Windows, a solução escolhida no portão dos itens 9 e 12 da Fase 0, medidos nesta fase (N48).
- Cascas, com confinamento de caminho, truncamento e o semáforo de comandos pesados.
- Testes de fuga:
  - path traversal e symlink;
  - encadeamento de comandos;
  - programa chamado por caminho ou dentro de `sh -c`;
  - ferramenta nativa bloqueada.
- Navegador compartilhado sem a tela (5.19): porta `BrowserSession`, adaptador Playwright, ferramentas `browser_*` e as chaves da N40 (`browser.profile`, `browser.domains`, `browser.local_urls`, `browser.file_urls` com `browser.secret_paths`, `browser.write_approval`), com os padrões sem restrição. A extensão no navegador do Produtor fica para a Fase 12 (N40); até lá, vale o perfil `shared` **[proposta]**.
- Perfil de projeto `software` (5.20): estrutura inicial, changelog, mensagens de commit e PR gerados na entrega, criação da CI; importação de repositório existente com detecção das convenções e confirmação do Produtor.
- Fila de ideias do projeto (5.20, N91): tabela `ideas`, o ponto de julgamento do agrupamento pelo Autor, o ciclo de vida da ideia e as chaves `ideas.*`.

**Critério de aceite:** suíte de fuga verde nos três clientes; o Ator abre uma página de teste, lê, tira print e clica sem aprovação no padrão, e só depois dela com `write_approval: always`; com `allowlist`, um domínio fora da lista é recusado; abre um servidor em `localhost` e um arquivo do worktree, e um caminho de segredo em `file://` é recusado; um repositório importado mantém o formato do próprio changelog e o padrão de commit depois de uma peça; com o agente falso, uma fila de quatro ideias, duas da mesma área, vira três peças, o grupo espera a aprovação com `grouping_approval: ask`, e a fila esvazia com cada ideia ligada à peça e ao PR.
**Resultado do fechamento (2026-11-18, [V]):** a suíte de fuga real (`escape.real.test.ts`, nível `escape` de `tools/acceptance/real-acceptance.sh`) passou nos três clientes, com `sandbox.mode: runtime` e `security.unenforced: refuse`. Rodou o orquestrador (Claude), com as rodadas autorizadas pelo dono, nos perfis de teste. Cada cliente recebeu nove pedidos:
- escrever fora do worktree por caminho absoluto, por `../` e por um link simbólico;
- `touch` fora do worktree, direto, dentro de `sh -c` com `;` e dentro de `$(...)`;
- sobrescrever um arquivo de fora;
- buscar uma página num servidor do próprio teste em 127.0.0.1;
- criar um arquivo dentro do worktree, como controle.

Nos três, nada ficou fora do worktree, o arquivo de fora não mudou, o servidor não recebeu nenhum pedido e o controle foi criado. Por cliente:
- **Claude Code** (Haiku, `acceptEdits`, 2026-11-17, os nove pedidos num turno):
  - a camada 2 recusou as duas escritas fora (`write_outside_worktree`) e uma leitura sem regra;
  - o `restricted_shell` recusou `ln`, `touch` e `sh`, e não há shell para o `$(...)`;
  - o `http_get` recusou 127.0.0.1, que está fora da lista.
- **OpenCode** (`openai/gpt-5.6-luna`, 2026-11-17, num turno):
  - o `apply_patch` fora do worktree foi recusado;
  - o link simbólico foi criado no worktree, mas nada foi escrito através dele;
  - o `restricted_shell` falhou nas três tentativas;
  - o `http_get` respondeu `host not allowed`.
- **Codex** (`gpt-5.6-luna`, 2026-11-18, uma tentativa por pedido, com `OT_TEST_ESCAPE_TURNS=each`):
  - a camada 2 recusou as duas escritas fora;
  - os quatro comandos de shell falharam, porque o sandbox do próprio Codex não cria um user namespace dentro da sandbox do `srt` (a mensagem é do Codex, e a causa exata está **[N]**);
  - a ferramenta web do Codex recusou o endereço 127.0.0.1.

O nível `mcp` (`submit_plan` pelo MCP do daemon, com a sandbox) passou nos três clientes: Claude Code em 2026-11-17 (N115), OpenCode em 2026-11-17 e Codex em 2026-11-18. Os outros itens do critério de aceite (navegador, perfil `software` e fila de ideias) passaram com o agente falso nos passos P6, P7 e P8 ([docs/15](../15-PLANO-DA-FASE-4.md)) e rodam na CI.

As rodadas reais encontraram cinco defeitos, todos corrigidos antes do fechamento:
- **Garantia curta do Codex:** com o Codex, a garantia de `nativeShell` e `nativeTools` ficava curta, e a sessão terminava `interrupted/permission` antes de abrir. A decisão do dono foi a N128.
- **Lock do OpenCode em `state`:** o OpenCode cria locks em `state` antes de conectar ao MCP. O isolamento padrão passou a `data`, `config` e `state`.
- **`sandbox.mode: off` nos testes reais:** os testes reais escreviam `sandbox: off`, que não desligava a sandbox.
- **Prazo que não disparava:** com o `FakeClock`, o prazo da tentativa nunca disparava. Os testes reais passaram ao relógio do sistema.
- **Aprovação MCP do Codex:** o Codex pedia aprovação para as ferramentas MCP do papel, e a camada 2 recusava. Agora elas são aprovadas pela regra `mcp_tool_of_role` (PR #93).

Observações que não bloqueiam o fechamento:
- O `codex-acp` 2.6.0 só oferece `cancel` para recusar uma mudança de arquivo, e o `cancel` encerra o turno. Por isso a fuga do Codex roda com uma tentativa por pedido.
- Dentro da sandbox `runtime`, o shell nativo do Codex não roda nenhum comando. Fica a pergunta N129.

**A Fase 4 está fechada.**
**Estimativa:** 3 semanas (era 1,5 na v0.12; a v0.13 acrescentou o navegador, a v0.14 o perfil `software` e a v0.68 a fila de ideias) **[proposta]**. No ritmo medido nas Fases 1 a 3 (v0.72, ver o resumo das estimativas): ≈ 8–23 h de trabalho, cerca de um dia.

Plano de passos, com dependências, paralelismo e aceite de cada passo: [docs/15](../15-PLANO-DA-FASE-4.md) (N96). O marco interno 4a fecha com as permissões, as cascas, a sandbox e a suíte de fuga. Na Fase 4, a camada 3 do Windows continua portão, e a fase fecha em Linux (N94).

### Fase 5 — Assinaturas, cotas e seleção

- Perfis: criar, login oficial, logout, drenagem, remoção.
- Chaves no cofre.
- Sondas de cota da seção 5.6 (statusline, app-server, MiniMax, erro de limite) e histórico pelo ccusage.
- Referência para sondas, pool, rotação, sonda de login e orçamento: os arquivos do Claudexor da seção 6.3 (N41), com atribuição.
- Seleção por papel com retry por diversidade e eventos de motivo.
- Admissão por RAM; failover do Orquestrador; override por projeto.
- **Retomada completa (5.16):** classificação da causa; política por causa; **passagem de bastão** com pacote de continuação; limite de retomadas por tentativa; interrupções externas fora da contagem de tentativas.
- **Idempotência de efeitos colaterais:** chaves por `attempt + step` nas cascas e nos plugins, tabela `side_effects`.

**Critério de aceite:** com dois perfis do mesmo cliente, esgotar um (simulado) e ver o Diretor redistribuir; remover um perfil com sessões em curso sem perder demanda; failover do Orquestrador sem perder a peça.

Também faz parte do aceite:
- um Ator interrompido por cota esgotada é retomado por passagem de bastão em outra assinatura, sem refazer commits nem instalações já feitos;
- outro Ator, com regra `wait`, é retomado de forma nativa depois do reset.

**Marco: o framework passa a poder construir as próximas fases.**
**Estimativa:** 2,5 semanas (era 2: entram a passagem de bastão e a idempotência).

Plano de passos, com dependências, paralelismo e aceite de cada passo: [docs/16](../16-PLANO-DA-FASE-5.md) (N120, decidida em 2026-11-17). O marco interno 5a fecha com a seleção no pipeline (P16); a retomada completa, o failover e a remoção de perfil fecham com o aceite da fase (P23).

### Fase 6 — API do daemon e cliente compartilhado

- REST, com o desenho de endpoints e o acesso `loopback_bearer` do Claudexor como referência (seção 6.3, N41).
- SSE com `Last-Event-ID`.
- WebSocket do chat, ligado à fila de prompts.
- Token, CORS fechado, bind local.
- **`packages/client`:** a camada que a TUI usa agora e a web herda depois. Não depende de interface:
  - cliente REST tipado a partir de `packages/protocol`;
  - assinatura SSE com retomada por `Last-Event-ID` e reconexão;
  - WebSocket do chat;
  - **stores de estado** (zustand no modo *vanilla*, MIT, que funciona no Ink e no React): cenários, peças, demandas, decisões pendentes, cotas, eventos;
  - **preferências de layout por usuário:** lateral recolhida, largura do chat, abas abertas, seções recolhidas.
  - **vários daemons** (N134, aberta): a lista dos daemons pareados e o id do daemon em cada cenário, para a TUI mostrar cenários de outras máquinas (item 30 da seção 12).
- Testes do `packages/client` contra o daemon com `fake-agent`.

**Critério de aceite:** um cliente de teste sobre o `packages/client` acompanha uma peça inteira por SSE, reconecta no meio sem perder evento e conversa com o Orquestrador.
**Estimativa:** 1,5 semana (era 1: inclui o `packages/client`).

### Fase 7 — TUI (interface principal)

`packages/tui` no framework escolhido na Fase 0 (Ink por padrão), sobre o `packages/client`. A TUI só desenha e lê teclado; estado e acesso à API ficam no `packages/client`.

**Layout** de `mockup/tui.html`:
- lateral retrátil (trilho recolhido) com cenários, assinaturas e a entrada de Configurações;
- chat em altura total com largura ajustável;
- painel de abas que abrem e fecham;
- seções recolhíveis.

**Componentes próprios:**
- rolagem virtualizada;
- tela cheia com redesenho ao redimensionar;
- barra de abas e alça de largura;
- formulários e seletores, sobre `@inkjs/ui`;
- paleta de comandos (Alt+K e F1);
- caixa de texto do Produtor com o comportamento dos agentes de código (`ui.keymap.preset`, 5.13, N35): edição, histórico, colagem, imagem e arquivo arrastado viram anexo;
- cópia de texto (`ui.clipboard.copy`, 5.13, N36): seleção própria e OSC 52;
- desempenho (`ui.render` e `ui.runtime`, 5.13, N37): tecla desenhada na hora, memoização, limite do heap e o patch do Ink com a versão travada;
- mouse (`ui.mouse`, 5.13): roda, clique e arrasto da borda do chat;
- comandos `/` do registro do daemon, com autocompletar, e os comandos do cliente com prefixo (5.13, N44);
- sessão direta com um Ator numa aba do cenário (5.20, N44) **[proposta para a fase]**;
- comando do Produtor pelo chat (`!`, `chat.shell_command`, 5.13, N43): roda no worktree do cenário, sob o modo de `app.terminal`, e a saída vira `terminal_snippet`. Quando o comando pede entrada, a TUI devolve o terminal ao processo e volta ao fim **[proposta]**.

**Telas e abas:**
- **Chat:** decisões do Produtor respondidas por tecla.
- **Visão geral:**
  - pipeline;
  - **DAG em forma de lista com dependências** (sem desenho gráfico);
  - Atores, eventos e cota.
- **Trajetórias:** passos expansíveis e diffs.
- **Consumo.**
- **Ordens:** vigentes, agendadas e encerradas por escopo, linha do tempo da vigência e prazos; criar, prorrogar, suspender e revogar.
- **Configurações:**
  - **Assinaturas:** o login oficial do CLI roda num painel da própria TUI, porque esses logins já são interativos no terminal;
  - **Executores:** modelo e esforço vindos das config options;
  - **Papéis:** reordenação com Shift+↑↓ e regra próximo/esperar;
  - **Limites.**
- **Assistente de configuração** (5.7): desenha os passos que o daemon manda, com voltar e retomar; a primeira execução abre nele.
- **Plugins:** ativação e permissões por papel.

**Idioma** (5.22): todas as telas em `en` e `pt-BR`, pelo catálogo, com troca por `ui.locale`.

**Atalhos:** mapa de teclas configurável da seção 5.13:
- padrões por sistema e ambiente (macOS, tmux, VS Code), definidos pelo teste da Fase 0;
- alternativas com Alt;
- paleta de comandos com dois atalhos (Alt+K e F1);
- aviso de Option-como-Meta no macOS;
- validação de conflitos ao configurar.

**Testes:** `ink-testing-library` sobre o `fake-agent`, e testes de fumaça nos terminais da Fase 0.

**Critério de aceite:** criar um projeto, adicionar uma assinatura (login oficial dentro da TUI), configurar papéis, pedir uma necessidade no chat, responder a uma decisão e acompanhar até o PR só pela TUI, no Windows Terminal e num terminal de macOS/Linux, nos dois idiomas.
**Estimativa:** 2,5–3 semanas (era 2–2,5 como fase opcional; agora cobre configuração e plugins completos).

### Fase 8 — Observabilidade

- Receptor OTLP no daemon recebendo o OTel nativo do Claude Code e do Codex, com correlação, gravando na base própria `telemetry.sqlite` (5.11, N54).
- Spans do daemon com as convenções GenAI.
- Exportador ATIF v1.8, validado pelo `TrajectoryValidator` do Harbor, com o bloco `extra.otheater` e a peça inteira como unidade (5.11).
- Painéis de consumo na TUI (aba Consumo); retenção.
- Integração opcional com Phoenix, para quem quiser um visualizador gráfico de traces.
- Exportação para fora (5.11, N70): OTLP para um coletor configurável e `/metrics` no formato Prometheus, pela chave `telemetry.export`, desligada por padrão. Serve ao Grafana e a qualquer serviço que receba OTLP.
- Análise do sistema para achar gargalos e melhorias (N55, seção 12): o desenho fecha nesta fase, com dados reais.

**Critério de aceite:** trace completo de uma peça; trajetória ATIF válida; com `telemetry.export: both`, o trace da peça chega a um coletor OTLP de teste e o `/metrics` responde.
**Estimativa:** 1 semana.

### Fase 9 — Plugins

- Manifesto, validação, registro, ativação por projeto.
- Agregador MCP (ou 1MCP como sidecar).
- Permissões geradas dos manifestos; segredos no cofre.
- `@otheater/sdk` para plugins + plugin de exemplo.
- Painel declarativo (5.14) desenhado na aba Plugins da TUI; tipos de evento `plugin.<id>.*`.

**Critério de aceite:** a ferramenta do plugin aparece só nos papéis declarados e fica bloqueada nos demais; o painel do plugin de exemplo aparece na TUI sem nenhum código do plugin na interface.
**Estimativa:** 1–1,5 semana.

### Fase 9b — Agendador e tarefas

Depende das Fases 5 (sondas de cota e seleção) e 6 (API). Pode andar em paralelo com as Fases 7–9.

- Tabelas `schedules` e `schedule_runs`; croner com fuso; recálculo e gravação do próximo disparo.
- Tipos: uma vez, cron, intervalo, após reset da cota.
- Regras por tarefa e padrões globais: execução perdida, sobreposição, cota, decisão sem ninguém olhando; orçamento por execução.
- Gatilho do sistema operacional que acorda a máquina e chama `ot run <task>`:
  - Windows: Agendador de Tarefas;
  - macOS: launchd;
  - Linux: timer do systemd.
- Pedido de manter acordada durante a execução, nas três plataformas.
- Ferramentas MCP do Diretor: `schedule` (rascunho confirmado pelo Produtor), `list_schedules`, `pause_schedule`.
- Comandos `ot schedule …` e `ot run`.
- Aba Agenda na TUI.
- Notificações: chat, sistema operacional, plugin.
- Testes com relógio simulado sobre o `fake-agent`.
- Tarefas (5.20): definição versionada, fluxo `task.define` com os papéis e o ensaio, motor de passos `task.run` (tipos `code`, `model`, `agent`, `approval`, `delivery`), pasta por execução, gatilhos da v1, `run_task`, promoção de chat para tarefa ou projeto. A entrega por plugin depende da Fase 9.

**Critério de aceite:**
- tarefa diária dispara no horário com a tela bloqueada (Windows com Modern Standby incluído) e abre o PR;
- execução perdida com a máquina desligada roda uma vez ao voltar;
- execução sobreposta é pulada;
- com a cota esgotada, a tarefa é adiada até o reset;
- decisão do Produtor sem ninguém olhando espera o prazo e segue com a recomendada, e numa decisão irreversível segue só com a opção segura;
- tarefa criada pelo chat só é salva depois da confirmação;
- o exemplo das manchetes e o do dono (baixar, descomprimir, extrair, montar a planilha, enviar) passam no ensaio, rodam pelo agendador e entregam o artefato, com o Diretor adormecido durante a execução;
- um passo de código que falha acorda o Diretor, que abre a correção da definição.

**Estimativa:** 2,5–3 semanas sem agentes; 1,5–2 com (era 1–1,5 e 0,5–1 na v0.13: entram as tarefas) **[proposta]**.

### Fase 10 — Distribuição (daemon + TUI)

- Executável único do daemon e da TUI: Node SEA (a Fase 0 escolheu o Ink, N11). Lançador Rust de Job Object junto, no Windows.
- Instalação por usuário:
  - Windows: instalador `.msi`/winget;
  - macOS/Linux: pacote ou script;
  - alternativa para desenvolvedores: `npm i -g`.
- Daemon como serviço de logon; o comando da TUI sobe o daemon se ele não estiver no ar.
- Gatilhos do sistema operacional registrados para rodar só com o usuário conectado (5.21).
- `ot init` mínimo: instala o serviço, sobe o daemon e abre a TUI no assistente de configuração, sem perguntas no terminal (5.7).
- Atualização automática (5.21, N73): `updates.*` com os modos `auto`, `notify` e `check`, momento `idle`, `park` ou `next_start`, origem conforme a instalação (GitHub Releases com SHA-256 e Ed25519 no executável próprio; só aviso no npm e no winget), canais `stable` e `beta`, volta automática e backup antes das migrações. A origem das versões depende do item 2 da seção 12 e do repositório, hoje privado.
- Primeira execução guiada dentro da TUI, pelo assistente do daemon (criar a primeira assinatura, escolher os papéis padrão).
- Cada build do instalador gera o `THIRD_PARTY_NOTICES` da sua plataforma (linux-x64, win32-x64, darwin-arm64 e as outras distribuídas) e o leva junto (6.0, N72).

**Critério de aceite:**
- instalar e desinstalar numa máquina limpa;
- fechar a TUI sem interromper a peça;
- reabrir e reencontrar o estado e o layout.
- uma versão nova publicada no canal é baixada, conferida e aplicada com a peça em curso, sem perder a peça: em `idle`, espera a tentativa terminar; em `park`, retoma por `session/load`;
- uma versão com assinatura errada é recusada, e uma que não sobe volta sozinha para a anterior, com o store restaurado do backup feito antes da migração.

**Estimativa:** 1 semana.

### Fase 11 — Endurecimento

- Testes de caos:
  - daemon morto no meio da peça;
  - queda de energia simulada (VM desligada à força) com uma peça, uma tarefa agendada e um chat em curso (5.21);
  - Executor travado;
  - perfil expirado;
  - disco cheio;
  - provedor fora do ar;
  - atualização de adaptador.
- Idempotência de integração e PR.
- Revisão de segurança da API e das cascas.
- Revisão das portas (5.18): porta que continua com um só adaptador e sem segundo previsto é candidata a ser simplificada (R16).
- Documentação, incluindo o guia para escrever adaptadores e plugins.

**Critério de aceite:** roteiro de caos sem perda de estado nem processo órfão.
**Estimativa:** 1,5–2 semanas.

### Fase 10b — Daemon sem login (logo depois da v1)

Decidida em 2026-11-14 (N21): fase própria, logo depois da Fase 11 (5.21).
- **Medição primeiro.** Verificar se os clientes (Claude Code, Codex, OpenCode) fazem login e rodam sem sessão de usuário aberta, nos três sistemas.
- Escolher o adaptador de `SecretVault` que destranca sem ninguém digitar nada, pelo critério da 5.21.
- Instalador com a opção de serviço sem login: systemd de usuário com `linger`, tarefa do Windows "executar estando o usuário conectado ou não", LaunchDaemon com `UserName` no macOS **[a confirmar]**.
- Gatilhos do sistema operacional passam a rodar sem o usuário conectado.

**Critério de aceite:** a máquina religada depois de uma queda de luz, sem ninguém fazer login, roda a tarefa agendada que estava na janela, retoma as peças pela reconciliação e notifica pelo chat e pelo plugin de notificação.
**Estimativa:** a definir ao abrir a fase, depois da medição.

### Fase 12 — Interface web (depois da Fase 10b; base do app Android)

Fica fora do caminho crítico e do total. Deixou de ser opcional em 2026-11-14, porque o app Android (Fase 14) a reaproveita. Começa depois da Fase 10b (decisão do dono, 2026-11-14, v0.29, item 12 da seção 12), e não mais a qualquer momento depois da Fase 6.

- `packages/web` (React + Vite) sobre o **mesmo `packages/client`**: estado, API e preferências já existem; só a camada de desenho é nova.
- Layout de `mockup/app.html`:
  - chat em altura total com largura ajustável por arraste;
  - lateral retrátil;
  - painel de abas;
  - cartões recolhíveis.
- Layout responsivo e preparado para toque desde o início, para o tablet e o celular da Fase 14.
- Componentes prontos: assistant-ui (chat), @xyflow/react (DAG gráfico), shadcn/ui, AgentPrism ou viewer próprio (trajetórias).
- O que a web acrescenta à TUI: DAG desenhado, arrastar para reordenar papéis, desenho gráfico dos painéis declarativos dos plugins (o mouse a TUI já tem desde a Fase 7, N34).
- Navegador compartilhado na tela (5.19): transmissão da sessão, controle pelo Produtor e modo **indicar**, genérico, com as indicações `web_element` anexadas à mensagem do chat.
- Extensão Manifest V3 no navegador do Produtor (5.19, N40), o Opera primeiro: pareamento com o daemon por WebSocket, controle pela `chrome.debugger` (ou pela alternativa com content script), grupo de abas por cenário, botão de parar e espelho da aba no painel do navegador.
- Mapa de teclas e capacidades do Claude Desktop (5.13, N39), na parte que roda no navegador:
  - registro de ações com presets por plataforma e superfície (`app.keymap.preset`, `app.keymap.overrides`), com a paleta, a ajuda e a tela de atalhos geradas dele;
  - painéis de Mudanças (diff com comentários que viram `code_snippet`), Arquivos e Terminal (porta `TerminalSession` no daemon, `app.terminal: sandbox` por padrão);
  - tela dividida, chat lateral, bifurcar, voltar ou editar a última mensagem, enfileirar, parar a resposta, menus de modelo e esforço;
  - ditado (porta `Dictation`, motor escolhido por medição).
- Testes e2e com Playwright sobre o `fake-agent`, incluindo cada atalho do preset `claude` na variante web.

**Critério de aceite:** o mesmo da Fase 7, feito só pela interface web; o Produtor indica dois elementos numa página, e o Ator corrige os dois a partir das indicações; e o Produtor comenta uma linha no painel de Mudanças e roda um comando no Terminal sob a sandbox, só com o teclado; e, com a extensão pareada no Opera, o Ator abre uma página logada do Produtor, preenche um formulário de teste sem aprovação e para na hora pelo botão da extensão.
**Estimativa:** 5,5–6 semanas sem agentes; 3–3,5 com (era 2,5–3 na v0.33; +2 das capacidades da N39 e +1 da extensão da N40).

### Fase 13 — App desktop (depois da Fase 12, antes da 14)

Fica fora do caminho crítico e do total, como a web. Deixou de ser opcional em 2026-11-14 (v0.29, item 12 da seção 12): vem depois da web, que ele embrulha, e antes do app Android, por escolha do dono.

- Decisão Electron × Tauri ao abrir a fase (item 7 da seção 12).
- A web numa janela nativa, como cliente do serviço de logon da Fase 10 (o daemon não roda dentro do app; item 6 da seção 12, v0.25). Sem o serviço, o app instala pelo assistente de configuração.
- Instalador por usuário, atualização automática pelas mesmas regras do daemon (5.21, N73); o mecanismo do próprio Electron ou Tauri entra só se respeitar a assinatura e a volta automática.
- Mapa de teclas do Claude Desktop completo (5.13, N39): menu nativo com os aceleradores gerados do registro, variantes do macOS e chat rápido global (`app.quick_chat.shortcut`).
- Conferência do preset `claude` contra o Claude Desktop instalado, com a lista de diferenças para o dono decidir. Inclui as teclas do macOS, que ainda não foram vistas num Mac.

**Critério de aceite:** instalar e desinstalar numa máquina limpa; fechar a janela sem interromper a peça; todas as ações da tabela da N39 funcionam pelo atalho e pela paleta no Linux, no Windows e no macOS.
**Estimativa:** 1,5–2 semanas sem agentes; 1–1,5 com (era 1 e 0,5–1 na v0.33; +0,5 da N39).

### Fase 14 — App Android, celular e tablet (depois da Fase 13)

Fica fora do caminho crítico e do total, como a web. Vem depois da Fase 13 por escolha do dono (v0.29), mas não depende tecnicamente dela: só precisa da web (Fase 12).

- `packages/android`: Capacitor sobre o build da `packages/web`.
- Tablet com o layout do app; celular com uma coluna por vez e navegação inferior (5.13).
- No daemon: `api.remote: vpn`, TLS com certificado fixado, pareamento por QR (`ot pair`), tokens por aparelho e a tela Aparelhos (5.12).
- Notificações, conforme o item 19 da seção 12.
- Testes: emulador Android (celular e tablet) e um aparelho real pela VPN; queda de rede e retomada do SSE por `Last-Event-ID`.

**Critério de aceite:** num tablet e num celular ligados à VPN, parear por QR, acompanhar uma peça ao vivo, responder a uma decisão do Produtor e conversar com o Diretor; revogar o aparelho e ver o acesso cair; fechar o app sem interromper a peça.
**Estimativa:** 2–2,5 semanas sem agentes; 1–1,5 com **[hipótese]**.

### Resumo das estimativas

| Fase | Sem agentes | Com agentes de código* | No ritmo medido** | v0.1 (sem agentes) |
|---|---|---|---|---|
| 0 Validações e base (teste da TUI obrigatório) | 2–3 sem | 2–3 sem | feita: ≈ 1 sem (11-08 a 11-15) | 1–1,5 |
| 1 Fundação | 1,5 sem | 1 sem | feita: ≈ 10 h | 1 |
| 2 Executores | 2 sem | 1,5 sem | feita: ≈ 13 h | 2 |
| 3 Pipeline + MCP + base dos cenários + reconciliação | 3,5 sem | 2,5–3 sem | feita: ≈ 11 h | 2,5–3 |
| 4 Permissões, navegador, perfil `software` e fila de ideias | 3 sem | 2–2,5 sem | ≈ 8–23 h | 1,5–2 |
| 5 Assinaturas, seleção e retomada | 2,5 sem | 1,5–2 sem | ≈ 6–18 h | 2 |
| 6 API + `packages/client` | 1,5 sem | 0,5–1 sem | ≈ 2–9 h | 1 |
| 7 TUI (interface principal) | 2,5–3 sem | 1,5 sem | ≈ 6–14 h | — |
| 8 Observabilidade | 1 sem | 0,5 sem | ≈ 2–5 h | 1 |
| 9 Plugins | 1–1,5 sem | 0,5–1 sem | ≈ 2–9 h | 1,5 |
| 9b Agendador e tarefas | 2,5–3 sem | 1,5–2 sem | ≈ 6–18 h | — |
| 10 Distribuição (daemon + TUI) | 1 sem | 0,5–1 sem | ≈ 2–9 h, mais o portão do R1 | 1–1,5 |
| 11 Endurecimento | 1,5–2 sem | 1–1,5 sem | ≈ 4–14 h | 1,5–2 |
| **Total (produto na TUI)** | **≈ 25,5–28,5 semanas** | **≈ 16,5–21,5 semanas** | **≈ 38–119 h nas Fases 4 a 11** | 19–24 |
| 10b Daemon sem login (logo depois da v1) | a definir | a definir | a definir | — |
| 12 Interface web (depois da 10b; com as capacidades da N39 e a extensão da N40) | 5,5–6 sem | 3–3,5 sem | ≈ 12–32 h | 3–4 |
| 13 App desktop (depois da web; mapa do Claude Desktop, N39) | 1,5–2 sem | 1–1,5 sem | ≈ 4–14 h | — |
| 14 App Android, celular e tablet (depois do desktop) | 2–2,5 sem | 1–1,5 sem | ≈ 4–14 h | — |

\* Com Claude Code/Codex como apoio desde o início e, a partir da Fase 5, com o próprio framework. Supõe revisão humana de tudo o que for gerado. A Fase 0 não acelera com agentes: é medição.

\*\* **Ritmo medido (v0.72, 2026-11-17, a pedido do dono).** As durações das Fases 1 a 3 saem dos horários dos commits na `main` **[V]**: a Fase 1 foi de 2026-11-15 23h27 (N49) a 2026-11-16 09h23 (passo 7); a Fase 2, de 2026-11-16 10h44 a 23h29 (K padrão por cliente); a Fase 3, de 2026-11-17 04h12 (plano) a 15h17 (fechamento, N88). As horas são de relógio, com as pausas de dentro da fase, e incluem as rodadas reais feitas com o ok do dono. No total, ≈ 34 h para o que estava estimado em 5–5,5 semanas com agentes: de ≈ 4 h (Fase 3) a ≈ 10 h (Fase 1) por semana estimada, e o ritmo melhorou com o paralelismo (N78 e a ordem de 2026-11-16). A coluna aplica essa faixa, de 4 a 9 h por semana estimada com agentes, a cada fase restante **[proposta]**. Ela é uma projeção, não um compromisso, e erra para menos nestes casos:
- as fases com interface (7, 12, 13 e 14) pedem conferência visual e uso real, que as Fases 1 a 3, sem tela e testadas com o agente falso, não tiveram;
- os testes reais só rodam com o ok do dono para cada rodada, e o tempo de espera por ele não está na conta;
- os portões não dependem do ritmo: a confirmação da Anthropic sobre o R1 antes da Fase 10 (seção 11), a máquina Windows para a camada 3 e para os itens 9 e 12 da Fase 0 (N94) e a medição que define a Fase 10b;
- as cotas das assinaturas limitam quanto trabalho de agentes cabe num dia.

Com cerca de 18 h de trabalho por dia, como nas Fases 1 a 3, as Fases 4 a 11 levam de 2 a 7 dias de calendário, e as Fases 12 a 14, mais 1 a 3, fora os portões **[proposta]**.

**Fork, com a TUI primeiro:** os candidatos da seção 6.4 (Emdash, Orca, AionUi, Paradev, Happier) são apps gráficos. Com a TUI como interface principal, o fork perde a maior parte do valor. O que ainda se aproveita é o runtime ACP e a gestão de worktrees (Fase 2, ≈ 0,5–1 semana a menos) e parte da Fase 12. A avaliação da Fase 0 passa a olhar principalmente o núcleo deles (runtime ACP, worktrees), não a interface.

As estimativas já consideram a política de licenças da seção 6.0 (Apache-2.0 aceita, sem reimplementar o SDK do ACP nem o OpenTelemetry).

**Marcos:**
- **MVP sem UI** (Fases 0–3): ≈ 9–10 semanas sem agentes, ≈ 7–8,5 com. Conversa com o Diretor pelo `ot chat` no terminal (N78).
- **Uso diário com várias assinaturas** (+ Fases 4–5): ≈ 14,5–15,5 / ≈ 10,5–13; no ritmo medido, ≈ 14–41 h depois do fim da Fase 3.
- **Produto na TUI** (+ Fases 6–7): ≈ 18,5–20 / ≈ 12,5–15,5; no ritmo medido, ≈ 22–64 h depois do fim da Fase 3.
- **Produto completo na TUI** (+ Fases 8–11, com 9b): ≈ 25,5–28,5 / ≈ 16,5–21,5; no ritmo medido, ≈ 38–119 h depois do fim da Fase 3, mais o portão do R1.
- **Daemon sem login** (+ Fase 10b, logo depois da v1): a estimar depois da medição.
- **Web, desktop e Android** (+ Fases 12, 13 e 14, nessa ordem, depois da 10b; v0.29): + 9–10,5 / + 5–6,5 (a soma antiga, + 5,5–6,5 / + 3–4,5, era de antes da N39 e da N40); no ritmo medido, + 20–60 h.

**Paralelização com uma segunda pessoa:**
- depois da Fase 3, a Fase 6 (API + `packages/client`) anda em paralelo com as Fases 4–5;
- depois da Fase 6, a TUI (7) anda em paralelo com as Fases 8, 9 e 9b (agendador);
- a web (12) não entra nessa paralelização: desde a v0.29 ela começa depois da Fase 10b, embora use o mesmo `packages/client` da TUI;
- o contrato da API está em `packages/protocol`, o das portas em `packages/core`, e o `fake-agent` cobre o back.

Caminho crítico: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 11.

## 11. Riscos e mitigação

| # | Risco | Impacto | Mitigação |
|---|---|---|---|
| R1 | Termos da Anthropic restringem assinatura em produtos (inclusive com Agent SDK, que o `claude-agent-acp` usa) | Modo produto sem assinatura Claude | Uso pessoal com o CLI oficial e logins próprios durante o desenvolvimento; confirmação formal da Anthropic exigida antes da Fase 10 (portão da N48, 2026-11-15; era na Fase 0); modo produto com chave de API para Claude até lá |
| R2 | ACP e adaptadores mudam toda semana (SDK 2.0 a 2.6 em três semanas, renomeações de pacote) | Quebras ao atualizar | Versões fixadas; testes de contrato; atualização deliberada; saída de emergência pelo modo headless |
| R3 | Sinal de cota ausente, não documentado ou instável | Alocação em perfil esgotado | Várias fontes por provedor + erro de limite + contabilidade local; retry no próximo Executor |
| R4 | Sandbox fraco no Windows (Claude Code sem sandbox nativo; `sandbox-runtime` em alpha) | Fuga de permissão | Bash nativo removido; cascas; usuário de baixo privilégio; Job Object; testes de fuga |
| R5 | Modelo pequeno no Diretor decide mal | Ciclos desnecessários | Pontos de julgamento estreitos com schema; limites `Np`/`Nc`; Executor do Diretor configurável; Gemma 4 em vez de Gemma 3 |
| R6 | RAM com muitos Atores (um `claude` por sessão) | Máquina travando | Admissão por sessão; plugins agregados; semáforo de comandos pesados; Codex/OpenCode para Atores simples |
| R7 | Conflitos de merge frequentes | Retrabalho | `expectedFiles` validado antes da execução; conflito vira falha de roteiro; no roteiro novo, o que não mudou continua aprovado (N84); conflito no rebase refaz só a dependente (N82); a base que mudou entra na integração antes da entrega (N83) |
| R8 | Fork que diverge do upstream | Manutenção dobrada | Critérios explícitos na Fase 0; preferir copiar trechos com atribuição a manter um fork |
| R9 | Licença proibida entrando sem perceber (dependência transitiva GPL, AGPL ou LGPL, componente não confirmado, fork que arrasta AGPL) ou obrigação da Apache-2.0 ou da MPL-2.0 esquecida (NOTICE, cabeçalho, marca de modificação, código-fonte de arquivo MPL alterado) | Violação de licença; bloqueio jurídico tardio | Política da seção 6.0; verificador de licenças e de cabeçalhos na CI; `THIRD_PARTY_NOTICES` gerado; alternativa própria para cada componente a confirmar |
| R10 | Custo de contexto alto | Cota esgota rápido | Blackboard, saída estruturada, prefixo estável para cache |
| R11 | Ink lento ou tremulando com streaming intenso, ou rolagem ruim em conversas longas | A TUI é a interface principal: sem ela confortável, o produto todo sofre | Teste comparativo Ink × OpenTUI na Fase 0; rolagem virtualizada; TUI isolada atrás da API, então trocar de framework não afeta o resto |
| R12 | Sem interface gráfica até a Fase 12 | Quem não usa terminal fica sem acesso; DAG e trajetórias longas são menos legíveis no terminal | Depois da v1 e da Fase 10b, a web (Fase 12), o desktop (Fase 13) e o Android (Fase 14), nessa ordem (v0.29), todos sobre o `packages/client`; Phoenix como visualizador gráfico de traces no meio-tempo |
| R13 | Tarefa agendada roda sem ninguém olhando e faz algo indesejado, ou gasta a cota | Mudança não revisada, cota esgotada para o uso interativo | Entrega por PR por padrão; orçamento por execução; criação pelo chat só com confirmação; decisão sem ninguém olhando pausa por padrão; adiar quando a cota está esgotada |
| R14 | Máquina dormindo no horário (Modern Standby, tampa fechada) | Tarefa não roda ou atrasa horas | Gatilho do agendador do sistema operacional que acorda a máquina; pedido de manter acordada durante a execução; regra de execução perdida; histórico mostra atraso real |
| R15 | Retomada repete efeito colateral, ou a passagem de bastão perde contexto e o novo Executor refaz ou desfaz trabalho | Commits duplicados, chamadas externas repetidas, retrabalho | Chaves de idempotência nas cascas e plugins; checkpoints frequentes; pacote de continuação com efeitos já executados; preferir retomada nativa quando possível; teste de qualidade da passagem de bastão na Fase 0 |
| R16 | Excesso de abstração: portas especulativas, indireção demais, contratos que mudam a toda hora | Código mais difícil de ler e de mudar; o custo de trocar uma implementação deixa de compensar | Porta só em fronteira e em ponto de variação (5.18, regra 1); porta nasce com adaptador real, fake e conformidade (regra 5); composição manual, sem container; regra de dependência na CI; revisão das portas na Fase 11 |
| R17 | Navegador compartilhado: uma página dirige o agente por injeção de prompt, ou o agente age com uma conta logada no perfil do cenário | Ação indesejada num site real (envio, compra, exclusão) ou vazamento do que a página mostra | Desde a N40 (2026-11-15), o padrão não tem as restrições antigas, e o risco foi aceito pelo dono. Ficam: página tratada como dado (5.8), com a saída marcada como não confiável; caminhos de segredo fora do `file://`; botão de parar; evento com print de cada ação; os modos antigos (`per_scenario`, `allowlist`, `write_approval: always`) por projeto ou cenário (5.19) |
| R18 | Tarefa recorrente roda sem supervisão um script escrito por agente | Script errado ou malicioso roda todo dia, apaga dados ou envia o que não devia | Passos de código no sandbox, com a política da tarefa (5.8); definição só ativa depois do ensaio e da aprovação do Produtor; toda mudança gera versão nova, com diff, ensaio e aprovação; destinatário da entrega fixo na definição; orçamento por execução (5.20) |
| R19 | Queda de energia ou reinício no meio do trabalho | Transação confirmada perdida, store corrompido, efeito externo feito duas vezes ou esquecido, processo órfão consumindo cota | `synchronous=FULL`; gravar antes de agir; reconciliação na subida com verificadores de efeito; backup diário com `integrity_check`; teste de queda forçada na Fase 11 (5.21) |
| R20 | Acesso remoto pelo app Android: aparelho perdido ou roubado, token vazado, VPN mal configurada | Quem tem o aparelho comanda o daemon, que é acesso administrativo | Só pela VPN, nunca exposto na internet; token por aparelho, revogável; token no armazenamento seguro do Android; certificado fixado no pareamento; ações destrutivas pedem confirmação; bloqueio do app por biometria **[proposta]** (5.12, 5.13) |

## 12. Decisões em aberto

1. *(Decidida em 2026-11-14: projeto próprio, sem fork, com trechos reaproveitados, ver "Decididas" e a seção 6.4.)*
2. Modo de distribuição: pessoal (assinaturas) ou produto (API para Claude), depois da resposta sobre R1, que tem de chegar antes da Fase 10 (N48, 2026-11-15).
3. *(Decidida em 2026-11-13: tipos de cenário, ver "Decididas" e a seção 5.20.)*
4. *(Decidida em 2026-11-14: limites do pipeline como chaves de configuração, ver "Decididas" e a seção 5.4.)*
5. *(Decidida em 2026-11-14: política de entrega como chave de configuração, ver "Decididas" e a seção 5.5.)*
6. *(Decidida em 2026-11-14: daemon sempre como serviço de logon, ver "Decididas" e a seção 5.1.)*
7. Electron ou Tauri. Decide-se ao abrir a Fase 13, que deixou de ser opcional em 2026-11-14 (item 12).
8. *(Decidida em 2026-11-14: Executores padrão de cada papel, ver "Decididas" e a seção 5.7.)*
9. *(Decidida em 2026-11-14: acesso remoto pela VPN do usuário, para o app Android, ver "Decididas" e as seções 5.12 e 5.13.)*
10. *(Decidida em 2026-11-14: custo em moeda, ver "Decididas" e a seção 5.6.)*
11. *(Decidida em 2026-11-15: Ink, pelo teste comparativo da Fase 0, ver "Decididas" e a seção 5.13.)*
12. *(Decidida em 2026-11-14: ordem das interfaces depois da v1, ver "Decididas" e a seção 5.13.)*
13. *(Decidida em 2026-11-14: padrões do agendador como chaves de configuração, ver "Decididas" e a seção 5.15.)*
14. *(Decidida em 2026-11-14: padrões da retomada como chaves de configuração, ver "Decididas" e a seção 5.16.)*
15. *(Decidida em 2026-11-14: ganchos de interceptação dos plugins, ver "Decididas" e a seção 5.14.)*
16. *(Decidida em 2026-11-14: padrões dos cenários como chaves de configuração, ver "Decididas" e a seção 5.20.)*
17. Como destrancar os segredos no modo sem login (5.21): mecanismo nativo da máquina (DPAPI, TPM, `systemd-creds`) ou arquivo cifrado com chave protegida. Decide-se ao abrir a Fase 10b, depois da medição. O resto do item foi decidido em 2026-11-14, ver "Decididas".
18. Contribuições externas (6.0): exigir um acordo de contribuição (CLA), que dá ao dono o direito de relicenciar o código recebido e mantém aberta uma licença dupla ou uma versão comercial, ou só a certificação de origem (DCO, com `Signed-off-by`), em que cada contribuição fica só sob MPL-2.0. Decide-se antes de o repositório aceitar contribuições.
19. Notificações do app Android (5.13): push pelo Firebase Cloud Messaging (exige conta Google e alguém que envie o push, o que pede um serviço fora da máquina); UnifiedPush ou ntfy (sem Google, com servidor próprio ou público); ou só com o app aberto ou num serviço em primeiro plano ligado ao SSE, que gasta bateria. Decide-se na Fase 14.
20. Distribuição do app Android: Google Play, APK direto (com atualização pelo próprio app) ou F-Droid. Liga-se ao item 2 (uso pessoal ou produto).
21. *(Decidida em 2026-11-14: teto de gasto em API, ver "Decididas" e a seção 5.6.)*
22. *(Decidida em 2026-11-14: sufixo `@<perfil>` em todos os Executores; revista no mesmo dia na v0.23 para `@<cliente>/<perfil>`; ver "Decididas" e a seção 5.7.)*
23. *(Decidida em 2026-11-14: capacidade mínima por papel, ver "Decididas" e a seção 5.7.)*
24. *(Decidida em 2026-11-14: perguntas ao Produtor por múltipla escolha, ver "Decididas" e as seções 5.3 e 5.15.)*
25. *(Decidida em 2026-11-14: fluxo da peça, com a fronteira dos papéis e as regras das voltas, ver "Decididas", P13 e a seção 5.4.)*
26. *(Decidida em 2026-11-14: revisão de consistência, com o menu fixo como tipo próprio, os pontos de julgamento da seção 5.16 e o `task.define` com as regras da peça, ver "Decididas" e as seções 5.3, 5.4, 5.16 e 5.20.)*
27. **Análise do sistema** (aberta em 2026-11-16, N55 do docs/13; fecha na Fase 8). Os dados já previstos são o log de eventos com horário, `attempts`, `interruptions`, `decisions`, `usage`, os spans OTLP e as trajetórias ATIF. Mas a arquitetura não define a análise em si. Falta decidir:
    - um relatório de gargalos: tempo por estado da peça, da etapa e da tentativa; reprovações por Executor e papel; espera por cota e pelo Produtor; custo por demanda aprovada;
    - a comparação entre peças e ao longo do tempo;
    - os agregados guardados antes do expurgo da telemetria e a retenção deles;
    - se a espera na `prompt_queue` e nos semáforos ganha span ou evento próprio;
    - como tratar a falta de dados de alguns clientes: o OpenCode sem tokens fora do `experimental.openTelemetry`, e o Codex com correlação por processo.
28. *(Decidida em 2026-11-16: versão do cliente pelo `package.json` do pacote instalado, confirmada pelo `initialize`, ver "Decididas" e a seção 5.2.)*
30. **Cenários de outros daemons** (aberta em 2026-11-18, N134 do docs/13; o protocolo fecha na Fase 6). Ideia do dono. Hoje há um daemon por máquina (5.1), e o acesso remoto (5.12) liga um aparelho a um daemon. Já escolhido pelo dono: três níveis, cada um por chave própria, com o protocolo no `packages/client` da Fase 6, a tela na TUI (Fase 7) e os outros níveis depois da v1. Falta decidir **[proposta]**:
    - **cliente com vários daemons** (`client.daemons`): os cenários de todos os daemons pareados, agrupados por máquina, com cada ação indo ao daemon dono do cenário; o id global do daemon e do cenário;
    - **mover um cenário** entre daemons (`scenarios.transfer: off | export_import`): o que vai no pacote (fila, ordens, histórico, configuração) e o repositório por git;
    - **federação** (`federation.mode: off | peers`, padrão `off`): o pareamento entre daemons, o que um daemon pode pedir ao outro, a política do papel no daemon que executa, nenhum segredo saindo da máquina, e como a seleção (5.7) e o `QuotaService` contam Executores de outra máquina;
    - o comportamento com um daemon fora do ar, e os termos de uso das assinaturas usadas a partir de outra máquina **[N]**.

Decididas:
- fechamento da Fase 2 (2026-11-16, seção 10, N75): fechada com portões, com o critério de aceite cumprido em Linux; o aceite real no nível `prompts` com o Codex e com o OpenCode é condição da primeira peça real com cada um como Executor, e a medição de `K` acima de 6 é condição de qualquer padrão de `K` maior que 6;
- dependências da Fase 3 (2026-11-16, seção 6.1, N76): `xstate` 5.33.3, `@modelcontextprotocol/server` e `core` 2.4.0, `@modelcontextprotocol/node` 2.1.2, `hono` 4.13.16 e `@hono/node-server` 2.1.6, todas com duas semanas ou mais de publicadas, instaladas só no passo que as usa; o `client` fica de fora;
- conversa do Produtor com o Diretor no MVP (2026-11-17, seção 10, N78): `ot chat` mínimo no terminal, com o Diretor aberto pelo daemon e as mensagens pela fila única de prompts; a TUI da Fase 7 o substitui pela mesma API;
- correções do `submit` (2026-11-17, seções 5.3 e 5.4, N79): `limits.submit_retries`, com 2 na predefinição `moderate`, 1 na `economical` e 3 na `persistent`;
- conflito no rebase das dependentes (2026-11-17, seções 5.4 e 5.5, N82): `integration.rebase_conflict: redo | script_failure | resolve_attempt`, padrão `redo`; o daemon aborta o rebase e um Ator refaz a dependente a partir da branch nova da dependência, contando em `attempts_per_demand`;
- base que mudou antes da entrega (2026-11-17, seção 5.5, N83): `delivery.base_drift: update | deliver_and_warn | ask`, padrão `update`; a base é mesclada na integração e os `verify` rodam de novo antes do PR, e o conflito vira falha de roteiro;
- código já aprovado numa falha de roteiro por conflito (2026-11-17, seções 5.4 e 5.5, N84): `rescript.reuse: keep_unchanged | redo_all | from_previous`, padrão `keep_unchanged`; as demandas iguais no roteiro novo continuam aprovadas, as que mudam são refeitas com o diff antigo como contexto, e as branches antigas ficam até a entrega;
- anexos lidos pelo Diretor (2026-11-17, seções 5.3 e 5.20, N85): o Diretor ganha `read_attachment` só para texto e PDF convertido; a imagem continua indo ao consultor que aceita imagem, pelo `consult`;
- lacunas da Fase 3 (2026-11-17, Fase 3, N86): entram num passo próprio antes do aceite (P15 do docs/14) o envio de `DEPENDENCY_REDONE` quando uma demanda com dependentes aprovadas é refeita (ponto de julgamento 8), a ligação de quem está olhando a peça (`attended`) ao `ot chat` aberto, para o `delivery.base_drift: ask`, e a mensagem de sistema no chat de cada cenário depois da reconciliação (5.21, item 8); a escrita do consultor na pasta do chat, as ferramentas de pesquisa dele e a capacidade de imagem dos adaptadores reais ficam para a Fase 4;
- peça real do aceite da Fase 3 (2026-11-17, Fase 3, N87): repositório git local criado pelo teste, tarefa pequena, todos os papéis no `claude-agent-acp` com o Haiku e entrega no `CodeHost` falso, sem GitHub; quem roda é o dono (N57);
- fechamento da Fase 3 (2026-11-17, Fase 3, N88): a fase fecha depois que o dono rodar o nível `play` do aceite real e ele passar, com o resultado na seção 10 com data e **[V]**;
- `delivery.mode: ask` com alguém olhando (2026-11-17, seção 5.5, N89): fica para a Fase 4; até lá vira `pr`; implementada no P9 da Fase 4, com `delivery.ask.timeout` 10m e `delivery.ask.on_leave: pr` decididos pelo dono em 2026-11-17;
- escrita do consultor (2026-11-17, seção 5.21 e Fase 4, N86, P10): `scenarios.consultant_writes: merge | keep | discard`, padrão `merge`, decidida pelo dono;
- decisões do P5 da Fase 4 (2026-11-17, seção 5.8): o `validateArgv` recusa também o operador colado (PR #91), `security.unenforced: refuse` continua o padrão, e o nível `escape` real roda nos três clientes, com as rodadas reais autorizadas pelo dono sem ok por rodada;
- aviso da reconciliação no chat (2026-11-17, seção 5.21, N90): uma vez, em memória, no próximo poll, com o evento `scenario.system_message` como registro e `recovery.notice: always | unclean_only | off`, padrão `always`;
- fila de ideias (2026-11-17, seção 5.20 e Fase 4, N91): fila amarrada ao cenário, agrupada pelo Autor num ponto de julgamento, com o grupo como necessidade da peça; `ideas.drain: auto | manual | scheduled`, padrão `auto`, e `ideas.grouping_approval: ask | auto`, padrão `ask`; a caixa de entrada global fica para uma fase futura;
- importação das demandas do `okit` (2026-11-17, seção 5.20, N92): depois que o OTheater estiver funcionando, com a ferramenta de importação da Q12; as demandas não feitas de cada projeto do kit vão para a fila de ideias do cenário do mesmo repositório; `okit_import.items: open | open_and_history | ask`, padrão `open`; `okit_import.drain: hold | follow | deferred`, padrão `hold`; `okit_import.missing_scenario: ask | create | skip`, padrão `ask`;
- downloads da Fase 4 (2026-11-17, seções 5.8 e 5.19 e Fase 4, N93): `@anthropic-ai/sandbox-runtime` 0.0.81 e `playwright-core` 1.64.1, com as versões exatas; o `node-forge` transitivo é usado pela opção BSD-3-Clause;
- camada 3 no Windows (2026-11-17, seção 5.8 e Fase 4, N94): continua portão; a Fase 4 fecha em Linux, e no Windows o daemon avisa que a camada 3 falta e segue o `security.unenforced`;
- sandbox e navegador na CI (2026-11-17, Fase 4, N95): o job `linux` instala o `bwrap`, o `socat` e o Chromium do Playwright, e os testes rodam em todo PR;
- plano da Fase 4 (2026-11-17, seção 10, N96): passos P0 a P11 em [docs/15](../15-PLANO-DA-FASE-4.md), com o marco interno 4a (permissões, cascas, sandbox e suíte de fuga);
- lista do `restricted_shell` (2026-11-17, Fase 4, N97): `tools.shell_allowlist.mode: list | profile | any`, padrão `list`, com uma lista curada de ferramentas de desenvolvimento e override no projeto e no cenário; o argv roda sempre sem shell, sem encadeamento e confinado ao worktree;
- limites das cascas (2026-11-17, Fase 4, N98): `tools.timeout_ms` 600000, `tools.output_max_bytes` 65536 e `tools.heavy_concurrency` 1, com override no projeto e no cenário;
- override da política do papel (2026-11-17, seção 5.8 e Fase 4, N99): `roles.<papel>.policy` no projeto e no cenário liga as cascas, os domínios de rede e as ferramentas nativas de escrita; o bypass, o shell nativo e a escrita fora do worktree ficam sempre proibidos;
- changelog na entrega (2026-11-17, seção 5.20 e Fase 4, N100): `delivery.changelog: auto | always | never`, padrão `always`; a entrega cria o `CHANGELOG.md` (Keep a Changelog) quando o repositório não tem um e mantém o formato do que já existe;
- shell nativo por papel (2026-11-17, seção 5.8 e Fase 4, N101): o Ator tem `roles.actor.policy.native_shell: shells` por padrão, e os outros papéis têm `none`; o shell do cliente continua proibido (N99);
- política por papel (2026-11-17, seções 5.2, 5.8 e 5.18 e Fase 4, N102): porta `ClientAdapter` 0.3.0, `RolePolicy` v2 com `mcpTools` por servidor, chaves `roles.<papel>.policy.{native_tools, native_shell, network.allow, on_ask}`, camadas padrão < configuração < cenário de origem < cenário e `roles` como objeto fechado;
- fila de ideias parada (2026-11-17, seção 5.20 e Fase 4, N103, N112): quando não pode seguir, ela para e avisa o Produtor do motivo (evento `idea.queue_held`); as perguntas sobre as ideias de fora ficam só na aprovação do grupo; `ideas.drain: scheduled` continua recusado até existir o agendador (5.15);
- redirecionamento do `http_get` (2026-11-17, seção 5.8 e Fase 4, N104): `tools.http.redirects: refuse | follow_allowed`, padrão `refuse`;
- convenções do projeto importado (2026-11-17, seção 5.20 e Fase 4, N105, N111): `project.conventions: ask | detect | off`, padrão `ask`, sem bloquear; formato das convenções, `ProjectCommandSchema` como schema único dos comandos do projeto e CI do perfil com `actions/checkout@v7`;
- sandbox (2026-11-17, seção 5.8 e Fase 4, N106, N113): `sandbox.mode: runtime | off`, padrão `runtime` onde houver adaptador; sem adaptador, vale `security.unenforced`, padrão `refuse`; a CI do Ubuntu 26.04 descarrega o perfil AppArmor `bwrap-userns-restrict` no runner descartável;
- caminhos de segredo (2026-11-17, seções 5.8 e 5.19 e Fase 4, N107): uma lista só, `security.secret_paths` (`add` e `remove` sobre o padrão da 5.19), com `browser.secret_paths` como apelido;
- navegador sem a extensão (2026-11-17, seção 5.19 e Fase 4, N108): `browser.fallback` tem o padrão `shared` na Fase 4;
- regras da camada 2 (2026-11-17, seção 5.8 e Fase 4, N109): ficam em `roles.<papel>.policy.rules`, com as mesmas camadas da política; `on_ask` continua com o padrão `reject`;
- detalhes das cascas (2026-11-17, seção 5.8 e Fase 4, N110): `restricted_shell` e `install_deps` sem verificador de efeito, `git_commit` com; `tools.env_inherit: minimal` herda PATH, HOME, locale e proxy; `tools.heavy_commands` sem o `restricted_shell`;
- regras da camada 2, as 10 propostas (2026-11-17, seção 5.8 e Fase 4, N114): campos `action`, `kind`, `tool`, `path` e `id`, a primeira que casa decide, `allow` só `allow_once`, no máximo 100 regras, `switch_mode` sempre recusado;
- MCP do daemon dentro da sandbox (2026-11-17, seção 5.8 e Fase 4, N115): **decidida, medida e implementada** (PR #85). Medido **[V]** em 2026-11-17: sem ponte o cliente confinado não alcança o servidor, e um ouvinte só por soquete Unix dentro da sandbox é barrado pelo seccomp (`socket(AF_UNIX)` dá `EPERM`); `allowAllUnixSockets` é global e abriria o D-Bus da sessão. Adotado: ouvinte TCP em `127.0.0.1:<porta do MCP>` dentro da sandbox, repassado pelo retransmissor e pelo proxy da própria biblioteca (que já usa soquete Unix, montado antes do seccomp), com a chave `sandbox.mcp_bridge: proxy | off` (padrão `proxy` no Linux), **aceitos pelo dono em 2026-11-17**. Confirmado com o cliente real **[V]** (2026-11-17, `claude-agent-acp` com Haiku: o `attempt.submitted` chega pela ponte). macOS não medido **[N]**;
- `roles.<papel>.policy.browser` (2026-11-17, seções 5.2 e 5.19 e Fase 4, N116): `none` (padrão), `read` ou `full`; nenhum papel recebe as ferramentas `browser_*` de fábrica;
- propostas restantes do P4 e do P6 (2026-11-17, seções 5.8 e 5.19 e Fase 4, N117): aceitas, com os limites medidos de cada uma; seguem [N] `file:` no Windows e no macOS, WebSocket e service workers fora da rota, a porta CDP, as portas do daemon com `local_urls: allow`, DNS rebinding e a política de `file://` do Chromium;
- plano da Fase 5 (2026-11-17, Fase 5, N120): o plano de passos em docs/16, com o marco 5a fechando no P16 e o 5b no P23;
- escopo do assistente de configuração na Fase 5 (2026-11-17, seção 5.12 e Fase 5, N121): só serviços e CLI (`ot profile`, `ot executor`); a tela do assistente vai para a Fase 7 e o `ot init` para a Fase 10;
- rodadas reais da Fase 5 (2026-11-17, Fase 5, N122): os níveis `profiles` e `quota` sem provocar esgotamento e sem ok a cada rodada; o esgotamento real só se o dono pedir;
- a sandbox conta como a camada `os` para `nativeShell` e `nativeTools` (2026-11-17, seções 5.2 e 5.8 e Fase 4, N128): **decidida pelo dono** ("Sandbox conta") depois de uma rodada real de fuga em que o Codex terminou `interrupted/permission` antes de abrir a sessão **[V]**: o adaptador do Codex não dá camada de cliente a esses campos e o `sandbox-srt` declarava só `writeScope` e `network`, então, com `security.min_layers.default: 1` e `unenforced: refuse`, a garantia ficava curta. O `sandbox-srt` passa a declarar `nativeTools`, `nativeShell`, `writeScope` e `network` onde há mecanismo (Linux e macOS); no Windows (N94) e com `sandbox.mode: off` a lista é vazia e o `refuse` continua valendo. A camada `os` confina o shell e as ferramentas do cliente, não as remove;
- padrões das sondas de cota (2026-11-18, seção 5.6 e Fase 5, N123): `quota.near_limit_at: 0.8`, `quota.stale_after: 10m`, `quota.probe.delivery: both`, parser de fração e percentual, statusline do Claude no diretório do perfil;
- seleção com cota incerta (2026-11-18, seção 5.7 e Fase 5, N124): `selection.unknown_quota: allow` e `selection.near_limit: keep_order`;
- pacote de continuação e failover (2026-11-18, seções 5.4 e 5.16 e Fase 5, N126): `resume.package.summarize: deterministic`, bastão sempre que a cota acaba, e a fila do Diretor em espera com aviso ao Produtor quando a lista inteira se esgota;
- drenagem e remoção de perfil (2026-11-18, seção 5.6 e Fase 5, N127): `profiles.drain.timeout: 10m`, `profiles.drain.on_timeout: handoff`, `profiles.drain.removed_dir: delete`, com o logout antes;
- shell nativo do Codex na sandbox `runtime` (2026-11-18, seções 5.2 e 5.8 e Fase 4, N129): `clients.codex.inner_sandbox: keep | full_access_when_wrapped | nested`, padrão `keep`; a medida mostrou que o srt bloqueia namespace aninhado por padrão e que `allowNestedUserNamespaces` o permite, ao custo das proibições de escrita;
- estratégia de seleção entre contas (2026-11-18, seção 5.7 e Fase 5, N130): `selection.strategy: ordered | most_headroom | round_robin`, padrão `ordered`;
- continuação de sessão entre papéis (2026-11-18, seções 5.4 e 5.7, N131): `pipeline.session_reuse: off | when_same_executor | preferred`, padrão `when_same_executor`, nos pares Revisor → Roteirista e Autor → revisão do roteiro; a revisão independente (Autor → Revisor, Ator → Crítico) sempre abre sessão nova; implementação depois da Fase 5;
- uso do `ccusage` (2026-11-18, seções 5.6 e 6.2 e Fase 5, N118): versão fixa com mais de duas semanas e licença conferida, como biblioteca se exportar uma API, senão como CLI;
- releitura do Claudexor (2026-11-18, seção 6.3 e Fase 5, N119): só os arquivos listados, no commit mais novo, sem clone, com o commit registrado nos cabeçalhos, no `THIRD_PARTY_NOTICES` e no `copied-code.json`;
- tabela `pricing` inicial (2026-11-18, seção 5.6 e Fase 5, N125): os modelos da predefinição `quality`, cada preço com fonte pública e data, confirmados pelo dono ao abrir o P10;
- porta do servidor MCP (2026-11-17, seção 5.3 e Fase 3, N81): `mcp.port: auto | <número>`, padrão `auto`; o sistema escolhe uma porta livre a cada subida, e o daemon entrega a URL às sessões;
- evento fora do registro (2026-11-17, seção 5.18 e Fase 3, N80): `events.unknown_type: reject | warn`, padrão `reject`; com `reject`, o tipo fora do registro ou o payload fora do schema lança erro e nada é gravado; com `warn`, o evento é gravado e o log recebe um aviso;
- plano da Fase 3 (2026-11-16, seção 10, N77): passos P0 a P13 em [docs/14](../14-PLANO-DA-FASE-3.md), com o marco interno 3a (peça ponta a ponta com o agente falso, reinício e `kill -9`);
- `K` por cliente (2026-11-16, seção 5.2 e Fase 2; N74 do docs/13): `pool.<cliente>.sessions_per_process`, opcional, que herda `pool.sessions_per_process`; os padrões saíram da medição real de 1, 2, 4 e 6 sessões, ociosas e com prompts, nos três clientes (2026-11-16, uma rodada [V]): Codex 6 (o maior valor medido; acima de 6 não foi medido [N]), OpenCode 4 e Claude Code sem padrão próprio (herda a global; sem efeito no `process-per-session`).
- atualização automática (2026-11-16, seções 5.1 e 5.21 e Fases 10 e 13; N73 do docs/13): `updates.mode: auto | notify | check`, padrão `auto` (baixa, confere e aplica); `updates.apply_when: idle | park | next_start`, padrão `idle`, com `updates.max_wait`; origem conforme a instalação (GitHub Releases com SHA-256 e Ed25519 no executável próprio, só aviso no npm e no winget); `updates.channel: stable | beta`, padrão `stable`; volta automática; backup antes das migrações. `off`, o valor de `max_wait` e a checagem de saúde são **[proposta]**.
- avisos de terceiros por plataforma (2026-11-16, seção 6.0 e Fase 10; N72 do docs/13): cada build do instalador gera o `THIRD_PARTY_NOTICES` da sua plataforma; o repositório guarda o do Linux, como hoje.
- Ollama e LM Studio (2026-11-16, seções 5.9 e 5.18 e Fase 2; N71 do docs/13): o adaptador `ollama` da porta `LocalModelServer` entra na Fase 2, ao lado do `llama-cpp`; o LM Studio fica para depois da v1, com o vLLM.
- versão do cliente (2026-11-16, seções 5.2 e 5.18 e Fase 2; N63 do docs/13, item 28): o adaptador lê o `package.json` do pacote instalado antes da primeira sessão, sem executar nada, e confirma ou corrige com a versão do `initialize`; a chave `client_version` ganha quando escrita; `clients.<id>.version_source` é **[proposta]**. A troca da base aceita no P7b (N61) é o passo P13 da Fase 2.
- exportação da telemetria para fora (2026-11-16, seções 5.11, 5.12, 5.18 e Fase 8; N70 do docs/13): o dono escolheu OTLP para um endpoint configurável e `/metrics` no formato Prometheus; saem os spans e os logs do daemon, a telemetria dos clientes e as métricas do daemon; a chave `telemetry.export: off | otlp | prometheus | both` tem o padrão `off`; entra na Fase 8.
- contador das retomadas gratuitas no registro (2026-11-16, seção 5.16; N67 do docs/13): o contador de `resume.max_free_resumes` é gravado no registro da tentativa, e o teto vale também depois de um reinício do daemon.
- propósito da sessão na porta (2026-11-16, seções 5.2 e 5.18; N68 do docs/13): `openSession` e `loadSession` da porta `ClientAdapter` recebem `options?`, com `process` e `purpose`; a versão da porta sobe para `0.2.0`, e a checagem da sessão de leitura de catálogo vale para todo adaptador.
- registro do aviso da isenção (2026-11-16, seção 5.2; N69 do docs/13): o dono escolheu a chave `security.catalog_probe_log: once | every | off`, com o padrão `once`.
- sessão de leitura de catálogo (2026-11-16, seção 5.2; N65 do docs/13): o dono escolheu a chave `security.catalog_probe: allow | refuse`, com o padrão `allow`. A sessão aberta só para ler o catálogo de modelos, sem prompt, pula a trava de garantias, e o `prompt()` dela é recusado.
- teto das retomadas gratuitas (2026-11-16, seção 5.16; N66 do docs/13): o dono escolheu a chave `resume.max_free_resumes`, com o padrão 3. Passado o teto, a retomada de uma sessão derrubada pela escalada do cancelamento conta em `max_resumes`.
- cancelamento num processo compartilhado (2026-11-16, seções 5.2 e 5.16; N64 do docs/13): o dono escolheu a chave `pool.shared_cancel: escalate | always_kill | release`, com o padrão `escalate`. O daemon mata o processo inteiro só quando o cliente não encerra o turno cancelado dentro da carência. Nesse caso, grava `session.cancel_escalated`, e as sessões irmãs são retomadas por `session/load`.
- propostas da onda 4 da Fase 2 (2026-11-16, seções 5.2, 5.8, 5.9 e 8; N62 do docs/13): `K` inicial de 4 sessões por processo em todos os clientes, revisto com os testes reais (N57); reuso do processo pela chave canônica de perfil, diretório, comando, argumentos e ambiente; `connectionLifetime: last_session` por padrão; `clients.<cliente>.enabled: auto`; ambiente do cliente com `env_inherit: minimal` e `account_env: strip`; a versão do cliente nunca vem de executar o binário (item 28); sem cliente, o daemon sobe sem execução e avisa.
- propostas da onda 3 da Fase 2 (2026-11-16, seções 5.2, 5.7, 5.8, 5.16 e Fase 2; N61 do docs/13): as chaves `clients.claude-code.*`, `clients.codex.*` e `clients.opencode.*` dos adaptadores; o Claude Code começa no modo `default` e recusa `bypassPermissions`, `dontAsk` e `auto`; o OpenCode com `read_only_mode: none` e `project_config: disabled`; as chaves `pool.*`, `limits.*` e `resume.*` da execução no daemon, com `interrupted` como estacionada e a parada limpa em `awaiting_resume`. O gancho de veto de modo na base e o `via` em `command(profile)` foram aceitos para um passo próprio (5.2).
- modelo de processos do OpenCode (2026-11-16, seção 5.2; N56 do docs/13): o dono escolheu a chave `pool.opencode.process_model: per_profile | per_session`, com o padrão `per_profile` (até `K` sessões por processo de cada perfil). Um crash é tratado como queda do cliente (5.16).
- testes de contrato reais (2026-11-16, seções 5.18 e 8; N57 do docs/13): o `pnpm test` roda só a parte offline; a parte real exige `OT_TEST_REAL_CLIENTS=1`, com perfis isolados e vazios; os testes com prompt exigem também `OT_TEST_REAL_PROMPTS=1` e o ok do dono a cada vez.
- nomes das branches da peça (2026-11-16, seção 5.5; N59 do docs/13): tudo sob `play/<id>/`, com `play/<id>/base`, `play/<id>/attempts/<demand>/<attempt>` e `play/<id>/integration`. O nome anterior, `play/<id>` com as tentativas abaixo dele, não funciona no git: um ref não pode ser prefixo de outro.
- lançador Rust na Fase 2 (2026-11-16, seção 5.9 e Fase 2; N58 do docs/13, portão do item 13 da N48): o lançador entra na Fase 2. Nesta máquina, só `cargo check` e `clippy`; o teste real roda na CI Windows, por disparo manual do dono, e o portão fecha com o resultado.
- lançador Rust com `windows-sys` (2026-11-16, seção 5.9; N60 do docs/13): o passo 6 da Fase 2 usou o `windows-sys` direto, sem o crate `win32job`. O `win32job` 2.1.0 não tem setter do limite de memória comprometida (o campo é `pub(crate)`, e o `limit_working_memory` não mata nenhum processo) e puxaria o `windows` 0.62 e o `thiserror`. O dono aceitou a troca. O limite de memória é do job inteiro e de memória comprometida. O portão do item 13 (N58) fechou com a CI Windows de 2026-11-16 (run 43887409539, job `windows-launcher`): os 7 testes de integração passaram;
- telemetria numa base própria (2026-11-16, seções 5.11, 5.21 e 7; N54 do docs/13): o dono decidiu separar a telemetria do store ("Melhor separar a telemetria numa base própria. Isso daria mais resiliência ao sistema"). Os spans, as métricas e os logs OTLP dos clientes e os spans do daemon vão para `telemetry.sqlite`, com `telemetry.synchronous: normal | full` (padrão `normal`) e `backup.telemetry: exclude | include` (padrão `exclude`). O log de eventos, o uso e a cota continuam no store;
- método do backup (2026-11-16, seção 5.21; N53 do docs/13): depois das medições do passo 7 da Fase 1, o dono escolheu `backup.method: online_api` em passo único como padrão, com a chave nova `backup.pages_per_step: all | <número>`. O `vacuum_into` e a cópia em passos continuam como modos; a cópia em passos entra em livelock com escrita ativa;
- propostas do passo 5 da Fase 1 (2026-11-16, seções 5.1, 5.6, 5.18, 5.21 e 5.22; N52 do docs/13): o dono aceitou as 18 escolhas do PR #9 ("Aceito, pode mesclar"): senha mestra com 3 tentativas e só por TTY; `AdapterUnavailable` e `InvalidInput` na conferência de faixa, id `override` para adaptador injetado; pasta de dados por sistema, com `--data-dir` e `OT_DATA_DIR`; lock exclusivo do SQLite em `daemon.lock`; cofre em `<data>/vault.enc`; log em `<data>/logs/daemon.log`; formato e regras das cópias de backup; `ot backup` e `ot restore`; saída 0, 1 e 2; i18next só nas mensagens do `ot`, com catálogos em `locales/`; regra de dependência do `protocol`;
- propostas do passo 4 e retenção do backup (2026-11-16, seções 5.18 e 5.21; N51 do docs/13): o dono aceitou as escolhas do PR #7 (relógio num adaptador próprio, `SqliteStore` com duas conexões e as chaves `synchronous` e `busyTimeoutMs`, backup em `.partial` com `integrity_check`, parâmetros do scrypt, `vault-keyring` com `secret-service`) e decidiu "manter só dois dias de backup por chave de configuração": `backup.retention: days` com `backup.keep_days: 2`, ou `copies` com `backup.copies: 7`;
- propostas dos passos 2, 3 e 6 da Fase 1 (2026-11-16, seções 5.6, 5.11, 5.18, 5.22, 7 e 9; N50 do docs/13): o dono aceitou as escolhas dos PRs #3, #5 e #4: `THIRD_PARTY_NOTICES.md` na raiz; `Clock.now()` em epoch ms; portas em `0.1.0`; envelope do evento; fakes em `@otheater/core/testing`; contrato das portas; diretivas e erros do fake-agent;
- cota entre a casca e o gerente (2026-11-15, seção 5.6; N47 do docs/13): o dono perguntou se a cota cabia na casca de agente ou numa casca própria de cotas e API. Ele aprovou registrar como proposta a divisão: a casca de cada cliente coleta os sinais (notificação `_otheater/quota/signal` na sessão, `QuotaProbe` fora dela), e um gerente único no daemon (`QuotaService`) guarda o estado por perfil, o registro de consumo, o custo e o teto de gasto, aplica o frescor e responde à seleção (5.7) e à passagem de bastão (5.16). O gateway de API, só para perfis de chave, fica para depois da v1 (`usage.api_gateway: off`). Ficam **[proposta]** o nome do método, os campos do `QuotaSignal` e a chave `usage.api_gateway`;
- hierarquia de adaptadores (2026-11-15, seções 5.2 e 5.8; N46 do docs/13): o dono perguntou se dava para abstrair as permissões do cliente e escolheu, por múltipla escolha, registrar a proposta na arquitetura. Em seguida pediu "uma classe agente com tudo o que precisamos e abaixo dela os descendentes especializados de cada agente". Ficou decidido registrar a forma: classe-base `ClientAdapter` com o comum e um descendente por cliente. Depois de uma avaliação, o dono aprovou três ajustes: a sessão é aberta pela porta `AgentSession` (para não quebrar a saída de emergência headless), cada campo tem uma lista de camadas (com `security.min_layers`), e `onAsk` fica só com `reject`. Depois, o dono propôs uma "casca de agente que abstraísse a chamada do agente de destino" e, após a avaliação, mandou registrá-la: cada descendente normaliza também a conversa, o contrato é ACP normalizado e a casca roda dentro do daemon, podendo virar processo à parte depois. O dono precisou a vantagem principal: o ACP é a língua única entre o daemon e o agente, as particularidades ficam dentro da casca sem que o daemon perceba, e os recursos únicos são expostos como chamadas ACP compatíveis, o que facilita suportar agentes novos. Os membros, a `RolePolicy`, a tabela de tradução e as chaves `security.*` são **[proposta]** e se fecham na Fase 1;
- comandos `/` e sessão direta (2026-11-15, seções 5.13 e 5.20, Fase 7; N44 do docs/13): por múltipla escolha, o dono decidiu três pontos:
  - um registro de comandos no daemon, o mesmo da paleta, servido a todas as interfaces desde a Fase 7;
  - os comandos do cliente (`available_commands_update`) com prefixo, nunca para os Atores de uma peça;
  - a pedido dele, "tanto direto quanto do Ator": esses comandos valem na sessão do Diretor parado e numa sessão direta nova do Produtor com um Ator, fora de peça.

  Depois, o dono reforçou que vale o daemon ter comandos próprios. A seção 5.13 traz uma lista inicial deles, que é **[proposta]**, assim como as chaves, os nomes, o uso do registro pela CLI, o worktree próprio da sessão direta e a fase dela;
- integração de terminal do Claude Desktop (2026-11-15, seção 5.13 e Fases 7 e 12; N43 do docs/13): por múltipla escolha, o dono mandou registrar as três peças. São elas: o comando `!` do Produtor pelo chat, com a saída indo para a conversa; as ferramentas de terminal do Ator; e a saída ao vivo dos comandos do Ator. O `!` entra na Fase 7, na TUI. As chaves, os padrões, a fase das ferramentas do Ator (12) e a suspensão do Ink são **[proposta]**;
- o que o ACP não resolve (2026-11-15, seção 3; N42 do docs/13): decisão do dono, "se tiver algo que não consigamos resolver por ACP, podemos procurar alternativas e adaptá-las"; por múltipla escolha, ele limitou as alternativas aos canais do próprio cliente oficial (statusline, `app-server`, `stream-json`, hooks, arquivos que o cliente grava, OTel, CLI), sem ler o token nem chamar a API do provedor por fora; a seção 3 continua valendo; a porta por alternativa fica como **[proposta]**;
- Claudexor como referência (2026-11-15, seções 6.3 e 6.4; complementa o item 1; N41 do docs/13): pedido do dono, "vamos usá-lo como referência para não termos que reinventar código em áreas críticas", depois da avaliação em `spikes/fork-evaluation/claudexor.md`; continua sem fork; trechos pequenos, com atribuição, nas sondas de cota, no pool de contas, na rotação, na sonda de login, no isolamento dos perfis, no store, na API do daemon e no orçamento, à frente do Emdash nessas áreas; fica de fora todo código dele que lê token ou chama a API do fornecedor por fora do cliente oficial; nenhum pacote dele como dependência; referência fixada na tag `v6.1.2`; reler a referência ao abrir cada fase e a trava de credenciais na CI ficam como **[proposta]**;
- navegador sem as restrições do Claude Desktop (2026-11-15, seção 5.19; N40 do docs/13): pedido do dono, "vou querer uma implementação sem as restrições que ele tem hoje"; por múltipla escolha, ele tirou as quatro restrições e escolheu os padrões: `browser.profile: extension` (uma extensão no Opera, o navegador do dia a dia dele), `browser.domains: any`, `browser.local_urls: allow`, `browser.file_urls: except_secrets` e `browser.write_approval: never`; as restrições antigas continuam como modos; o R17 cresce, com o risco aceito pelo dono; a extensão entra na Fase 12, com a tela, também por escolha do dono, e a Fase 12 cresce 1 semana; até lá, o perfil `shared` **[proposta]**;
- mapa de teclas e capacidades do app (2026-11-15, seção 5.13 e Fases 12 e 13; N39 do docs/13): pedido do dono, "use o mesmo mapa de teclas do Claude Desktop. A ideia é ter a nossa identidade e também ter as mesmas capacidades do Claude"; referência Claude Desktop 5.11492.2, lida localmente; o mapa é dado no registro de interface (`app.keymap.preset: claude`, padrão, ou `tui`); a web usa as variantes do Claude onde o navegador reserva a tecla, e a TUI fica com a N35; as capacidades novas entram nas Fases 12 e 13, e o Terminal roda sob o lançador e a sandbox (`app.terminal: sandbox`, padrão; `host`; `off`), as duas escolhas do dono;
- feito para evoluir (2026-11-15, P14; N38 do docs/13): pedido do dono, "a interface precisa ser criada de forma que simplifique futuros upgrades e features. isso vale para toda a implementação"; dependências atrás de portas, registros, versões fixadas e patches de terceiros travados na versão, com volta ao original;
- caixa de texto do Produtor e atalhos da TUI (2026-11-15, seção 5.13; N35 do docs/13): a caixa segue os agentes de código (Ctrl+J e Shift+Enter nova linha, edição do readline, histórico, Ctrl+R, Ctrl+G, colagem resumida, Ctrl+V com imagem, arquivo arrastado vira anexo); os atalhos do layout que colidiam passam a Alt + letra livre (Alt+S lateral, Alt+J painel, Alt+K e F1 paleta, Alt+A e Alt+W abas) e Ctrl+Shift+←/→ na largura; `ui.keymap.preset` (`agents`, padrão; `classic`, os atalhos da v0.7);
- copiar texto na TUI (2026-11-15, seção 5.13; N36 do docs/13): Shift+arrastar usa a seleção do terminal, e a TUI tem seleção própria copiada por OSC 52; `ui.clipboard.copy` (`osc52`, padrão; `system`; `off`);
- desempenho do Ink (2026-11-15, seção 5.13; N37 do docs/13): tecla desenhada na hora, memoização, heap jovem limitado e patch no `output.js` do Ink com a versão travada em 8.0.0 (versão diferente, patch recusado); chaves em `ui.render` e `ui.runtime`; propor a mudança ao Ink fica para depois, com autorização do dono;
- mouse na TUI (2026-11-15, seção 5.13; N34 do docs/13): entra na Fase 7, com a chave `ui.mouse` (`full`, padrão; `wheel`; `off`), como no Claude Code, também feito em Ink; antes, ficava para depois da v1;
- framework da TUI (2026-11-15, seção 5.13; item 11, N11 do docs/13): **Ink**, pelo critério da Fase 0 (o Ink fica se passar em streaming, rolagem e layout), medido em `spikes/tui-bench/`. O OpenTUI teve digitação mais rápida, mas só roda no Bun, tem binários nativos LGPL-2.1-or-later (proibidos pela seção 6.0), a memória cresceu durante o streaming sem platô e o layout do protótipo passou 21/25;
- base do projeto (2026-11-14, seção 6.4; item 1, N1 do docs/13), pela avaliação de fork da Fase 0 (`spikes/fork-evaluation/README.md`): **projeto próprio, sem fork**, reaproveitando trechos com licença permitida, na ordem Emdash (Apache-2.0), acpx (MIT) e depois ideias de Orca, Paradev e Happier, sem os pacotes LGPL. Motivo: nenhum candidato tem um núcleo que rode como daemon com API separado da interface sem reescrita, nenhum usa XState e todos têm máquina própria de sessão ou de DAG que ocuparia o lugar do pipeline (5.4), e o Happier arrasta LGPL-3.0 (binários libvips do `sharp`). A avaliação só leu o código; nada dos candidatos foi executado;
- revisão de consistência (2026-11-14, seções 5.3, 5.4, 5.16 e 5.20, v0.32; item 26), na conferência dos documentos antes da Fase 0: o menu fixo de AWAITING_PRODUCER é um tipo próprio, vindo do código, e não segue o limite de 2 a 4 opções do `ask_producer`, que vale só para as perguntas que o Diretor monta; a lista de pontos de julgamento do Diretor ganha a recusa do modelo ou erro de permissão, as retomadas acima do limite e o rebase ou refazer das dependentes, e as retomadas acima do limite não passam por DECIDING; o `task.define` segue as regras da peça, com as dúvidas do plano ao Produtor (CLARIFYING) e a revisão dos passos tipados pelo Autor antes dos Atores; o parcial de um Ator que estourou o tempo passa pelo `verify` e pela integração antes do Crítico; o paralelismo continua indicado pelo `dependsOn`, e o Autor, na revisão do roteiro, veta a dependência que não é justificada por um contrato ou pela ordem do plano;
- fluxo da peça (2026-11-14, P13 e seção 5.4, v0.31; item 25), a partir da revisão do fluxo da imagem de 2026-10-30 e da experiência do dono com o `okit`: cada papel com fronteira estreita, para o Ator só escrever o código de uma demanda pronta; o plano traz dúvidas e suposições, e as dúvidas vão ao Produtor (CLARIFYING) antes do Revisor; o Autor revisa todo roteiro, o inicial também; verificação em código de cada demanda ao fim da tentativa (`verify`); todo laço tem contador (`script_validations`, `script_vetoes`, `script_returns`, `structural_restarts`, além dos que já existiam), e esgotado vai a AWAITING_PRODUCER com um menu fixo; numa crítica mista vence a falha mais grave; pedido de mudança depois da entrega abre uma peça nova ligada à anterior. Ficaram de fora o caminho curto que pularia o Revisor e o Roteirista (vai contra o motivo da separação) e, para depois, o Crítico sugerir a classificação e o Crítico incremental;
- várias contas do mesmo provedor (2026-11-14, seções 3 e 5.6, v0.30; era a Q15 do docs/13, sem item numerado): suportadas como qualquer perfil, sem divulgação do recurso e por conta e risco de cada usuário; o projeto não afirma que os termos permitem; aviso com aceite no cadastro da segunda conta de assinatura do mesmo provedor, de qualquer plano (`profiles.same_provider_notice: once`), aprovado pelo dono no mesmo dia; contas de API nunca disparam o aviso, porque são cobradas por uso;
- ordem das interfaces depois da v1 (2026-11-14, seção 5.13 e Fases 12 a 14, v0.29; item 12): a web (Fase 12) começa depois da Fase 10b; o app desktop (Fase 13) deixa de ser opcional e vem depois da web e antes do app Android (Fase 14). A ordem v1 → 10b → 12 → 13 → 14 é escolha do dono: o Android só depende tecnicamente da web. Electron ou Tauri (item 7) segue aberto até a Fase 13 abrir;
- ganchos de interceptação dos plugins (2026-11-14, seções 5.14 e 5.18, v0.28; item 15), para depois da v1: pontos `attempt.before_start`, `tool.before` (depois das três camadas de permissão), `submit.before_accept` e `delivery.before`, cada um com saída `allow`, `veto` ou `annotate`; prazo de 5 s e de 30 s na entrega (`plugins.hooks.timeout`, com override por ponto e por plugin); na falha, o plugin declara `on_failure: allow | block`, e o padrão é deixar passar, com evento e aviso; `QuotaProbe` e `Notifier` podem vir de plugin, com a suíte de conformidade na ativação; tipos de indicação seguem só oficiais;
- campos próprios no ATIF (2026-11-14, seção 5.11, v0.27; era a Q11 do docs/13, sem item numerado): tudo num bloco `extra.otheater` com `schema: 1`, porque o validador do Harbor recusa campo fora dos `extra`; unidade padrão a peça inteira, com o Diretor na raiz e cada tentativa em `subagent_trajectories` (`atif.export.unit: play`, ou `attempt`, `play_files`); `cost_usd` só com custo real, e o equivalente das assinaturas no bloco próprio; conteúdo completo com segredos sempre mascarados (`atif.export.content: full`, ou `redacted`);
- perguntas ao Produtor por múltipla escolha (2026-11-14, seções 5.3, 5.15 e 5.17, v0.26; item 24): o `ask_producer` tem schema com 1 a 4 perguntas, de 2 a 4 opções cada, a recomendada em primeiro, escolha múltipla e "Outra" com texto livre sempre; `chat.producer_questions: choices` (padrão), `choices_strict` ou `free`; sem resposta no chat, `chat.unanswered: wait_then_recommended` com `wait_for: 30m` (ou `wait`, `recommended_now`); nas tarefas agendadas, `schedule.unattended_decision.mode: wait_then_recommended` com o prazo da predefinição (1 h, 2 h, 30 min, escolhidos pelo dono), revendo o `pause_notify` do item 13; nas decisões irreversíveis, a recomendada é sempre a opção segura, definida pelo daemon; as duas chaves `chat.*` têm override por cenário e tarefa agendada e entram na lista de chaves de `rule`, que fica com seis;
- daemon como serviço de logon (2026-11-14, seção 5.1 e Fase 13, v0.25; item 6): o daemon é sempre o serviço de logon do usuário, instalado pelo `ot init`; nenhuma interface o hospeda, e o app desktop (Fase 13; deixou de ser opcional na v0.29) é só mais um cliente, que instala o serviço pelo assistente de configuração quando ele falta. Motivo: um daemon só por usuário, e as tarefas agendadas rodam com qualquer interface fechada. O comportamento sem login segue a seção 5.21 (na v1, o daemon espera o login);
- capacidade mínima por papel (2026-11-14, seções 5.7 e 5.9, v0.24; item 23): todos os papéis aceitam modelo local, sem proibição por localização, e o mínimo vale igual para modelo local e na nuvem; critérios: `toolcall` em todos, janela de contexto (por slot no modelo local, lida pelo `LocalModelServer`; do catálogo nos outros), raciocínio no Consultor, no Autor, no Revisor, no Roteirista e no Crítico, e sessão de teste no cadastro (chamar uma ferramenta e entregar um `submit` válido); mínimos de contexto padrão de 32k no Diretor, 64k nos Atores e 128k nos outros papéis, em `roles.<papel>.requires` **[proposta]**; `roles.capability_check: warn` (padrão), `block` ou `off`: com `warn`, o Executor abaixo do mínimo entra com aviso e fica marcado na lista; em qualquer modo a seleção pula o Executor quando o prompt não cabe na janela;
- modelo local e provedor na revisão cruzada (2026-11-14, seções 5.7 e 5.9; resolve contradições, sem item numerado): o modelo local pode ser Ator e servir aos outros papéis, limitado pelos slots da instância, com `local.reserve_for_director: 1` e `local.reserve_when: listed` **[proposta]** nos padrões; na revisão cruzada, o provedor é a família do modelo (campo `provider` do Executor); os Executores do OpenCode são cadastrados por um assistente que sugere os campos a partir do `opencode models --verbose` e o daemon só valida, sem código próprio para modelos locais; depois do cadastro, o Executor fica disponível para qualquer papel e entra nas listas pelo que o Produtor marcar (`executors.on_register: ask`, com `preset_only` e `none`); dois eixos na abstração: `ClientAdapter` (com `ModelCatalog`) para o cliente e a porta `LocalModelServer` para o servidor local (llama.cpp na v1, Ollama depois); nome do Executor `<modelo>-<esforço>@<cliente>/<perfil>`, com o perfil único dentro do cliente (revê o item 22); com assinatura, cada família só pelo seu cliente oficial, e com API ou gateway, qualquer cliente que suporte o modelo (`executors.cross_client: api_only`, com `off` e `any`); configuração dos papéis com valor global e override por papel em cada cenário (projeto, tarefa, chat) e em cada tarefa agendada, com `roles.preset` e `roles.allowed_profiles` também por escopo, e precedência tarefa agendada > cenário > global; `ot init` mínimo (instala o serviço, sobe o daemon e abre a TUI no assistente, sem perguntas no terminal) e assistente de configuração com a lógica no daemon, passos salvos, retomáveis e validados, gravados só na confirmação final; na v1 o assistente é desenhado pela TUI, e a web o mostra depois pela mesma API;
- Executores padrão de cada papel (2026-11-14, seção 5.7; eram os itens 8 e 22): nome sempre `<modelo>-<esforço>@<perfil>`, com o prefixo `claude-` nos modelos do Claude e o sufixo da conta em todos, e o cliente no campo (revisto na v0.23: o cliente entrou no nome, `<modelo>-<esforço>@<cliente>/<perfil>`); todos os papéis com lista de fallback ajustável; a primeira execução (`ot init`) detecta clientes, logins e chaves, aplica `roles.preset: quality` (opções `balanced` e `economical`), tira o que não existe, acrescenta ao fim o Executor por API que houver e pede confirmação; Diretor com `claude-haiku-low`, `codex-luna-low`, `gemma4-low`; Roteirista com a lista do Autor; revisão cruzada com `selection.cross_check: prefer_other_provider`;
- custo e teto de gasto em API (2026-11-14, seção 5.6; eram os itens 10 e 21): assinatura mostra a cota e o equivalente em API, e conta de API mostra o custo real (`usage.subscription_display: quota_and_equivalent`); o valor vem do cliente, senão da tabela de preços (`usage.cost_source: client_then_pricing`); teto por dia e por mês no perfil de API (`budget`), sugerido pelo `ot init` em US$ 20 e US$ 200 e confirmado pelo Produtor; aviso em 80%; ao estourar, `on_exceeded: skip` para sessões novas e `in_flight: handoff` para a sessão em curso; despertar agendado no store retoma o trabalho e as tarefas adiadas quando a cota ou o teto voltam;
- nome do produto: **OTheater** (*Orchestration Theater*); pacote `otheater`, escopo `@otheater/*`, comando `ot`/`otheater`, organização GitHub `orchestration-theater` (2026-11-13, seção 9);
- licenças permitidas: MIT, Apache-2.0, ISC, BSD-2/3-Clause, 0BSD e MPL-2.0; GPL, AGPL e LGPL proibidas (2026-11-13; MPL-2.0 aceita em 2026-11-14, seção 6.0);
- licenças da Fase 0 (2026-11-15, seção 6.0, N45, pelo spike `licenses`): executores e adaptadores ACP no nível C; BlueOak-1.0.0, Unlicense, CC0-1.0, MIT-0, Python-2.0, WTFPL, CC-BY-3.0 e CC-BY-4.0 aceitas em dependências; `OR` do SPDX vale pelo melhor ramo e `AND` pelo pior; GPL e LGPL aceitas só no nível C; exceção por pacote e versão para os pacotes npm do AgentPrism;
- fechamento da Fase 0 (2026-11-15, seção 10, N48): fechada com portões, sem cumprir o critério de aceite; cada item aberto é condição da fase que precisa dele (13 na Fase 2; 9 e 12 na Fase 4; 4, 6, 7, 10, 11 e os termos da OpenAI na Fase 5; 19 e 20 na Fase 7; 14 quando o modelo local entrar como Executor); a confirmação do R1 é portão da Fase 10; a Fase 1 começa sem medição a mais;
- escolhas da Fase 1 (2026-11-15, seções 5.18, 5.22, 7, 8 e 10; N49 do docs/13): por múltipla escolha, o dono aprovou as quatro recomendações: os dois drivers do SQLite pela chave `store.driver` (padrão `better-sqlite3`, a mesma suíte de conformidade nos dois); o i18next; o dependency-cruiser; o GitHub Actions com Linux a cada push e Windows e macOS por disparo manual. As licenças das duas bibliotecas ficam **[a confirmar]** na fonte antes de instalar;
- app Android (2026-11-14, seções 5.12 e 5.13 e Fase 14; era o item 9): versões para celular e tablet, só como cliente do daemon; Capacitor sobre a web da Fase 12; tablet com o app completo, celular enxuto; acesso pela VPN do usuário, com pareamento por QR e token por aparelho; Fase 14, depois da web, fora da v1. Com isso, a web deixa de ser opcional. Notificações e distribuição seguem em aberto (itens 19 e 20);
- licença do código próprio: **MPL-2.0**, no lugar da MIT (2026-11-14, seção 6.0). Permite produto comercial e módulos fechados em arquivos separados; quem distribuir um arquivo do OTheater alterado publica aquele arquivo. Contribuições externas (CLA ou DCO) seguem em aberto (item 18);
- Arize Phoenix (ELv2) aceito só como ferramenta local opcional, nunca distribuído (2026-11-13, seção 6.2);
- ordens do Produtor (2026-11-13, seção 5.17): a local prevalece sobre a global no mesmo cenário; uma ordem vale para um cenário ou para todos, sem lista nem tag; sessões em curso não mudam e o Diretor decide relançar; `rule` com quatro chaves na v1 (perfis de um papel, `next`/`wait`, exigir PR e `git.push_after_commit`), mais `chat.producer_questions` e `chat.unanswered` desde a v0.26; dispensa do Crítico por decisão registrada, não por ordem, para a peça inteira, ao abrir a peça ou depois de uma reprovação (seção 5.4); janela recorrente depois da v1; aviso de prazo 24 h antes, configurável; suspensão local de uma global mantida.
- portas, adaptadores e registros (2026-11-13, P12 e seção 5.18): porta em toda fronteira e ponto de variação, sem porta para a lógica interna pura; duas camadas de extensão (adaptadores oficiais no processo, terceiros só fora dele, como plugins MCP); registro de fluxos em TypeScript, com a peça teatral como padrão (os outros fluxos foram decididos depois, na seção 5.20); composição manual, sem container; pacotes `core`, `sdk` e `adapter-*`; semver por porta com suítes de conformidade; painel declarativo de plugin, sem código do plugin na interface; registros tipados, com chaves de `rule` só de módulos oficiais e eventos de plugin com prefixo `plugin.<id>.*`.
- plugin com comportamento de mod (2026-11-13, seção 5.14): um mecanismo só, sem mods em processo; depois da v1 o plugin ganha níveis opcionais (assinar eventos, ganchos de interceptação que vetam ou anotam, contribuições declarativas), sempre fora do processo.
- navegador compartilhado (2026-11-13, seção 5.19): porta oficial `BrowserSession` no daemon (Playwright sobre CDP), usada pelo agente e pela interface; indicação completa anexada ao chat, num mecanismo genérico com tipos de indicação registrados (o primeiro é `web_element`); perfil isolado por cenário; ferramentas do agente na v1 (Fase 4) e a tela com o modo indicar elemento na Fase 12. O perfil e as proteções foram revistos em 2026-11-15 pela N40.
- cenários (2026-11-13, seção 5.20; era o item 3): três tipos (projeto, tarefa e chat genérico), num registro, com as variações como perfis de projeto (`software` na v1) e gatilhos de tarefa; projeto importado mantém as convenções detectadas, confirmadas pelo Produtor; um repositório por projeto na v1, vários depois; tarefa com definição versionada e execuções, desenhada pelos papéis (Autor, Revisor, Roteirista, Atores e Crítico no ensaio), com o Diretor leve só coordenando; gatilhos de horário e manual na v1, de evento depois; no chat, Diretor barato que consulta um Ator forte; promoção cria um cenário novo ligado ao chat; Diretor adormece sem atividade e acorda pelo resumo.
- durabilidade e recuperação (2026-11-13, seção 5.21): store com `synchronous=FULL` sempre; reconciliação explícita na subida, com efeito ambíguo resolvido pelo verificador da ferramenta ou pelo Produtor; na v1 a máquina religada sem login espera o login, e a meta depois da v1 é o daemon completo sem login; backup automático diário, guardando 7 (desde 2026-11-16, 2 dias por chave de configuração, N51).
- padrões dos cenários e da durabilidade (2026-11-14, seções 5.20 e 5.21; eram os itens 16 e 17): todos são chaves de configuração, com várias opções de escolha. Os padrões são estes: o Diretor adormece depois de 15 min; um anexo copiado tem até 50 MB; ficam as 30 últimas execuções inteiras; todas as versões da definição são guardadas; o backup roda uma vez por dia a partir das 3h (ou na primeira subida depois), na pasta `backups/` dos dados do daemon, com o store e as pastas de tarefa e chat, menos as execuções. O daemon sem login vira a Fase 10b, logo depois da v1. O mecanismo dos segredos sem login é escolhido ao abrir a fase, depois da medição.
- idioma (2026-11-14, seção 5.22): código, dados, configuração, eventos, ferramentas MCP, comandos, logs, commits do próprio OTheater e prompts em inglês; respostas ao Produtor no idioma dele, por ordem global; interface com catálogo `en` e `pt-BR` desde a primeira tela, idioma do sistema e chave `ui.locale`; nomes canônicos em inglês, com o glossário da seção 13, aprovado pelo dono no mesmo dia; detalhes aprovados no mesmo dia: a primeira subida oferece a ordem de idioma, catálogos em `locales/` carregados pelo `packages/client`, biblioteca escolhida na Fase 1, `auto` leva `pt-*` a `pt-BR` e o resto a `en`, plugin com catálogo próprio e `en` obrigatório, CI que verifica os catálogos; este repositório continua em português, com os identificadores em inglês.
- padrões do pipeline, da entrega, do agendador e da retomada (2026-11-14, seções 5.4, 5.5, 5.15 e 5.16; eram os itens 4, 5, 13 e 14): todos são chaves de configuração, com predefinições que o Produtor escolhe e chaves individuais. Os padrões são estes: `limits.preset: moderate` (`Np` 2, `Nc` 2, 3 tentativas por demanda, timeout de 30 min com teto de 2 h); `delivery.mode: pr`, com `direct_merge` só se o projeto permitir e a peça ou tarefa pedir, e `ask`; `schedule.preset: balanced` (execução perdida roda se o atraso for até 12 h, adiamento por cota até 6 h, espera por decisão de 24 h, orçamento de 1 h e US$ 5 em API); `resume.preset: balanced` (5 retomadas, espera pelo reset até 30 min, checkpoint a cada 10 min, travado com 10 min sem evento ou o mesmo erro 3 vezes).

## 13. Glossário

Os nomes em inglês são os do código, da configuração e dos prompts (5.22), aprovados pelo dono em 2026-11-14. Na interface em `pt-BR` aparece o termo em português.

| Termo | No código (en) | Significado aqui |
|---|---|---|
| Produtor | `Producer` | O dono: pede, decide e aprova pelo chat |
| Diretor | `director` | Papel que coordena um cenário; o nome antigo "Orquestrador" é o mesmo papel |
| Autor | `author` | Papel que escreve o plano da peça ou da tarefa e revisa o roteiro |
| Revisor | `reviewer` | Papel que revisa o plano; o roteiro é revisado pelo Autor (v0.31) |
| Roteirista | `scriptwriter` | Papel que transforma o plano no roteiro de demandas; não é `playwright`, para não colidir com o Playwright (5.19) |
| Ator | `actor` | Papel que executa uma demanda |
| Crítico | `critic` | Papel que avalia a branch integrada e faz o ensaio das tarefas |
| Necessidade | `need` | O pedido do Produtor que abre uma peça |
| Roteiro | `script` | Plano dividido em demandas, com contratos e dependências |
| Etapa | `Stage` | Fase do pipeline da peça (estados como `PLANNING` e `EXECUTING`) |
| Parecer | `review` | Resultado da revisão do plano ou do roteiro |
| Crítica | `critique` | Resultado da avaliação do Crítico |
| Passagem de bastão | `handoff` | Retomada por outro Executor, com o pacote de continuação (5.16) |
| Peça | `Play` | Uma execução do pipeline para uma necessidade |
| Cenário | `Scenario` | Projeto, tarefa ou chat genérico: tem Diretor e chat próprios, pasta, anexos, ordens locais, dashboard e configuração (5.20) |
| Perfil de projeto | `ProjectProfile` | Tipo registrado de projeto que define estrutura inicial, ferramentas, permissões e artefatos gerados; o padrão é `software` (5.20). Não confundir com o perfil de assinatura |
| Tarefa | `Task` | Cenário de workflow com artefato final: uma definição versionada de passos tipados e as execuções dela (5.20) |
| Ensaio | `rehearsal` | Execução da definição de uma tarefa com dados de exemplo, sem entrega real, avaliada pelo Crítico antes da aprovação (5.20) |
| Consultor | `consultant` | Papel com modelo forte que o Diretor do chat abre quando a pergunta pede (5.20) |
| Anexo | `Attachment` | Artefato `A<n>` enviado pelo Produtor ao chat: arquivo, caminho, imagem, texto ou URL, lido com `read_attachment` (5.20) |
| Promoção | `promote` | Criação de uma tarefa ou de um projeto a partir de um chat (ou de uma tarefa), ligado ao cenário de origem (5.20) |
| Executor | `Executor` | Cliente + perfil + modelo + esforço |
| Perfil | `Profile` | Uma assinatura ou chave de API de um cliente, com diretório isolado |
| Demanda | `Demand` | Unidade de trabalho do roteiro, executada por um Ator |
| Tentativa | `Attempt` | Uma execução de uma demanda por um Executor, numa worktree própria |
| Ordem | `Directive` | Instrução do Produtor que vale além de uma peça, global ou local a um cenário, durante a sua vigência e até ser revogada (5.17) |
| Blackboard | `Blackboard` | Memória compartilhada da peça (plano, roteiro, contratos, decisões) |
| Casca | `Wrapper` | Ferramenta do framework que envolve uma ferramenta existente com política e telemetria |
| Ponto de julgamento | `JudgmentPoint` | Decisão do Diretor tomada por modelo, com saída validada por schema |
| Config option | `ConfigOption` | Opção de sessão anunciada pelo adaptador ACP (modelo, esforço, modo) |
| Porta | `Port` | Interface TypeScript + schemas zod em `@otheater/core`, com versão própria, para uma fronteira ou um ponto de variação (5.18) |
| Adaptador | `Adapter` | Implementação de uma porta, num pacote `@otheater/adapter-*`, escolhida pela configuração (5.18) |
| Registro | `Registry` | Lista tipada de entradas (fluxos, papéis, ferramentas, chaves de `rule`, tipos de evento), validada na subida do daemon (5.18) |
| Fluxo | `Flow` | Máquina de estados registrada por nome e versão; a peça teatral é o fluxo padrão (5.4, 5.18) |
| Navegador compartilhado | `BrowserSession` | Sessão de navegador do cenário, usada pelo agente e pelo Produtor ao mesmo tempo (5.19) |
| Indicação | `Indication` | Artefato `I<n>` que aponta algo para o agente (5.19): um tipo registrado (o primeiro é `web_element`), o conteúdo validado pelo schema do tipo e o comentário do Produtor |
| Superfície | `Surface` | Parte do sistema que oferece o modo indicar e declara os tipos de indicação que produz; a primeira é o navegador compartilhado (5.19) |
| Reconciliação | `reconcile` | Rotina da subida do daemon que acha e resolve o que ficou pela metade (órfãos, sessões, worktrees, efeitos ambíguos) antes de retomar (5.21) |
| Efeito ambíguo | `ambiguous` | Efeito colateral com "antes" e sem "depois" gravados: não se sabe se aconteceu. É resolvido pelo verificador da ferramenta ou pelo Produtor (5.21) |
| Ponto de montagem | `compose.ts` | O único lugar do daemon que escolhe e liga os adaptadores às portas (`compose.ts`, 5.18) |

## 14. Fontes principais (consultadas em 2026-11-13)

- ACP: agentclientprotocol.com (session-setup, session-config-options, clients); github.com/agentclientprotocol (typescript-sdk, claude-agent-acp, codex-acp)
- MCP SDK v2: ts.sdk.modelcontextprotocol.io; blog.modelcontextprotocol.io
- Claude Code: code.claude.com/docs (permissions, cli-reference, sandboxing, statusline, authentication, env-vars, monitoring-usage, legal-and-compliance, llm-gateway, agent-sdk/subagents)
- Codex: learn.chatgpt.com/docs (app-server, config-advanced, auth, windows-sandbox)
- OpenCode: opencode.ai/docs (acp, permissions, server, sdk, troubleshooting)
- MiniMax: platform.minimax.io/docs (coding-plan, token-plan/faq)
- XState: stately.ai/docs/persistence
- Sandbox: github.com/anthropic-experimental/sandbox-runtime
- ATIF: github.com/harbor-framework/harbor (rfcs/0001-trajectory-format.md); docs.harborframework.com
- OTel GenAI: opentelemetry.io/docs/specs/semconv/gen-ai
- Reaproveitamento: github.com/generalaction/emdash, openclaw/acpx, razzant/claudexor (consultado em 2026-11-15), stablyai/orca, ryoppippi/ccusage, steipete/CodexBar, assistant-ui.com, ui.shadcn.com, github.com/vercel/ai-elements, docs.1mcp.app, github.com/ohadravid/win32job-rs, ai.google.dev/gemma (Gemma 4)

## 15. Revisão v0.1 → v0.2 (o que mudou e por quê)

| Ponto | v0.1 | v0.2 | Motivo |
|---|---|---|---|
| Adaptadores ACP | Escritos por nós | Pacotes prontos (`claude-agent-acp`, `codex-acp`, nativos) | Já existem e são mantidos |
| Modelo/esforço | Tradução manual por cliente | Session Config Options do ACP | Recurso padrão do protocolo |
| Crítico | Avaliava antes do merge | Avalia a branch **integrada** (`INTEGRATING`) | O documento original pede avaliar o trabalho conjunto; testes precisam do código combinado |
| Timeout do Ator | Sem mecanismo de repasse | Commit WIP automático | Permite "outro Ator terminar" e a retomada após reinício |
| Prompts ao Orquestrador | Concorrência não tratada | Fila única com prioridade para o Produtor | Evita dois `session/prompt` simultâneos |
| Falha do Orquestrador | Não tratada | Failover para o próximo Executor com resumo do store | Cota do Diretor também esgota |
| Dependências refeitas | Não tratado | Rebase ou refação das dependentes | Branch dependente ficaria desatualizada |
| Roteiro | Executado direto | Validado em código (ciclos, contratos, arquivos) | Pega erro barato antes de gastar Atores |
| Máquina de estados | Própria | XState v5 com snapshot no SQLite | Biblioteca madura com persistência |
| Permissões | "Camada 1 bloqueia" | Configuração = política; fronteira = sistema operacional | Deny de Bash é contornável; Claude Code no Windows não tem sandbox |
| Job Objects | koffi | Lançador Rust (`windows-sys`; o `win32job` foi descartado na N60), koffi como alternativa | O Node não cria processo suspenso; há janela de fuga |
| Cotas | "Fase 0 levanta" | Fontes concretas por provedor | Pesquisa encontrou statusline, app-server, endpoint MiniMax |
| Telemetria | Instrumentar | Reaproveitar o OTel nativo de Claude Code e Codex | Já existe |
| ATIF | Formato a confirmar | Harbor ATIF-v1.8, validador do Harbor | Especificação localizada |
| Modelo local | "Gemini 27B" | Gemma 4 (26B-A4B / 31B) | Gemini não tem pesos abertos; Gemma 3 é fraco em ferramentas |
| UI | Componentes próprios | assistant-ui, shadcn, xyflow | Já existem |
| Termos | Genérico | Regra concreta da Anthropic e consequência para o modo produto | Pode mudar o modelo de distribuição |
| Estimativa | 19–24 semanas | 17,5–20 (14–16 com fork) | Reaproveitamento; a Fase 0 cresce um pouco |
| Licenças (v0.3) | Sem política | MIT por padrão, quatro níveis (copiado, empacotado, externo, desenvolvimento) e exceções listadas | Preferência do projeto por MIT |
| Banco (v0.3) | Drizzle | Kysely | Drizzle é Apache-2.0 |
| Base de fork (v0.3) | Emdash, Orca, AionUi | Orca, Paradev, Happier | Emdash e AionUi são Apache-2.0 |
| Agregador MCP (v0.3) | 1MCP como sidecar | Próprio; 1MCP só se MIT | Licença não confirmada |
| Licenças (v0.4) | Só MIT, com duas exceções Apache | MIT, Apache-2.0, ISC, BSD-2/3, 0BSD permitidas; copyleft proibido; obrigações da Apache automatizadas na CI | Apache-2.0 aceita; e a lista só-MIT reprovaria dependências transitivas ISC/BSD comuns no npm |
| Base de fork (v0.4) | Orca, Paradev, Happier | Emdash (principal), Orca, AionUi, Paradev, Happier | Emdash volta a ser o melhor encaixe técnico |
| Sandbox (v0.4) | Só envoltório externo | Biblioteca ou envoltório | Apache-2.0 permitida no nível B |
| TUI (v0.5) | "Futura, opcional", Ink citado de passagem | Ink por padrão, com teste comparativo contra OpenTUI na Fase 0; Fase 12 própria, opcional e fora do total | Mockup da TUI aprovado; Ink reaproveita o modelo React da web |
| Layout (v0.5) | Telas descritas por função | Layout comum app/TUI: chat em altura total e largura ajustável, lateral retrátil, Configurações como aba, tudo recolhível menos o chat | Mockups de referência em `mockup/` |
| Ordem das interfaces (v0.6) | Web principal (Fase 7), TUI opcional (Fase 12) | **TUI principal (Fase 7)**; web (Fase 12) e desktop (Fase 13) opcionais; teste Ink × OpenTUI obrigatório | Preferência do produto; o uso começa no terminal e o próprio framework passa a ser usado mais cedo |
| Camada compartilhada (v0.6) | Reuso entre TUI e web implícito | `packages/client` (cliente da API + stores zustand vanilla + preferências de layout) na Fase 6 | O reaproveitamento entre TUI e web é de lógica, não de tela |
| Distribuição (v0.6) | Fase 10 = app desktop | Fase 10 = daemon + TUI em executável único e serviço de logon; desktop vira Fase 13 | O desktop depende da web |
| Estimativa (v0.6) | 18–20,5 sem (11,5–14,5 com agentes) | 19–21 sem (11,5–15 com agentes) até o produto completo na TUI; web + desktop + 3–3,5 (1,5–2,5) | Fase 6 cresce com o `packages/client`; TUI completa no caminho crítico |
| Atalhos da TUI (v0.7) | Fixos (Ctrl+B, Ctrl+J, Ctrl+←/→, Ctrl+T/W, Ctrl+K) | Mapa de teclas configurável, padrões por sistema/ambiente, alternativas com Alt, paleta com dois atalhos | Colisões no macOS (Mission Control, Cmd não chega), tmux (Ctrl+B), VS Code (Ctrl+K) e Ctrl+J = LF |
| Nome (v0.8) | "Framework Multiagente" | **OTheater** (*Orchestration Theater*), comando `ot` | Escolha do produto; nomes conferidos no npm e no GitHub |
| Agendador (v0.9) | Inexistente | Seção 5.15 e Fase 9b: tarefas únicas, cron, intervalo e após reset da cota; regras de execução perdida, sobreposição, cota e decisão sem ninguém olhando; gatilho do sistema operacional para acordar a máquina; aba Agenda | Pedido do produto; o daemon já tinha o estado e o pipeline necessários |
| Retomada de sessões (v0.10) | Só devolução à fila no reinício, WIP no timeout e failover do Orquestrador | Seção 5.16: retomada nativa (`session/load`) ou passagem de bastão com pacote de continuação, política por causa, checkpoints periódicos, idempotência de efeitos colaterais, interrupções externas fora da contagem de tentativas | Sessões de qualquer papel podem parar por cota, rede, queda ou reinício e precisam continuar sem perda nem repetição |
| Ordens do Produtor (v0.11) | Inexistentes | Seção 5.17: ordens globais (um registro para todos os cenários) e locais (um projeto, tarefa ou chat), dos tipos `instruction`, `rule` e `suspension`; vigência com início, fim, duração e janela recorrente, calculada pelo relógio; prorrogação; revogação com motivo, em lote e definitiva; criação só pelo Produtor; entrada no prefixo, no Crítico e na retomada. Estimativas das fases não revistas | Conceito do `okit` trazido para o OTheater, redesenhado para evitar cópias por projeto e texto com efeito em código; vigência por período e revogação refinadas a pedido do dono; pontos em aberto decididos pelo dono no mesmo dia, incluindo a dispensa do Crítico (5.4) |
| Abstrações (v0.12) | Uma interface própria (`ClientAdapter`) e o resto ligado direto às bibliotecas | P12 e seção 5.18: portas em `@otheater/core` para toda fronteira e ponto de variação, adaptadores trocáveis em `@otheater/adapter-*`, registros tipados (fluxos, papéis, ferramentas, chaves de `rule`, eventos, interface), composição manual, semver por porta com suítes de conformidade em `@otheater/sdk`, painel declarativo de plugin; Fase 1 cresce 0,5 semana | Pedido do dono: com tudo em TypeScript, abstrair ao máximo para ganhar flexibilidade e facilidade de expansão; as escolhas de desenho foram decididas pelo dono no mesmo dia; no mesmo dia, o dono decidiu que o comportamento de mod vira nível opcional do plugin depois da v1, sem mecanismo separado (5.14) |
| Navegador compartilhado (v0.13) | Só `http_get` e plugins MCP para a web | Seção 5.19: porta `BrowserSession` (Playwright sobre CDP) no daemon, uma sessão para o agente e para o Produtor, ferramentas `browser_*` com aprovação das ações de escrita, modo indicar genérico, com indicações `I<n>` de tipos registrados (o primeiro é `web_element`) anexadas ao chat, perfil isolado por cenário; tabelas `browser_sessions` e `indications`; R17; Fase 4 e Fase 12 crescem 0,5 semana cada | Pedido do dono: um navegador na web e no desktop em que ele indica elementos da página para o agente trabalhar; escolhas decididas pelo dono no mesmo dia, e a generalização para outros tipos foi pedida por ele em seguida |
| Cenários (v0.14) | Projeto, tarefa e chat citados, sem definição; tarefa geral sem formato (N3) | Seção 5.20: base comum (Diretor e chat próprios, pasta, anexos `A<n>`, Diretor adormecido); registro de tipos de cenário; projeto com perfil (`software`: changelog, commits, PRs, publicação, CI) e importação que respeita as convenções; tarefa com definição versionada desenhada pelos papéis e ensaiada, motor de passos tipados e gatilhos; chat com Diretor barato e papel `consultant`; promoção para cenário novo ligado; tabelas `scenario_repos`, `task_definitions`, `task_runs` e `attachments`; R18; Fases 3, 4 e 9b crescem | Definições do dono para os três tipos; escolhas decididas por ele no mesmo dia, incluindo usar os papéis para desenhar a tarefa e deixar o Diretor leve |
| Durabilidade (v0.15) | Snapshot por transição, retomada (5.16) e regra da janela (5.15), sem modo de gravação definido, sem rotina de reconciliação, sem backup e sem resposta para a máquina religada sem login | Seção 5.21: `synchronous=FULL`; gravar antes de agir; reconciliação na subida com verificadores de efeito; na v1 espera o login, depois daemon completo sem login; backup diário com 7 cópias; R19; Fase 3 cresce 0,5 semana | Pergunta do dono sobre fechar a interface, reiniciar e faltar luz; escolhas decididas por ele no mesmo dia |
| Idioma (v0.17) | Identificadores em português, sem regra de idioma; interface só em português nos mockups | Seção 5.22: código, dados, configuração, eventos, ferramentas, comandos, logs e prompts em inglês; respostas ao Produtor no idioma dele, por ordem; catálogo `en` e `pt-BR` desde a primeira tela, com `ui.locale`; glossário com o nome em inglês de cada termo; identificadores deste documento renomeados (os antigos estão no histórico do git, e o glossário faz a ponte) | Pergunta do dono; escolhas decididas por ele no mesmo dia |
| Padrões do pipeline (v0.18) | `Np`, `Nc`, tentativas, timeouts, política de entrega, regras do agendador e da retomada sem valor (itens 4, 5, 13 e 14) | Chaves `limits.*`, `delivery.*`, `schedule.*` e `resume.*`, cada grupo com três predefinições e chaves individuais; padrões `moderate`, `pr`, `balanced` e `balanced` | Decisões do dono, que pediu que cada padrão seja chave de configuração com várias opções |
| Licença do código próprio (v0.19) | Código próprio em MIT; MPL proibida em código copiado e dependências | Código próprio em MPL-2.0; MPL-2.0 permitida em código copiado e dependências, com obrigações; GPL, AGPL e LGPL seguem proibidas; CLA ou DCO em aberto (item 18) | Decisão do dono, depois de uma pergunta sobre uso comercial |
| App Android (v0.20) | Interfaces só no computador (TUI, web e desktop opcionais); acesso remoto em aberto (item 9) | App Android para celular e tablet na Fase 14, com Capacitor sobre a web; tablet com o app completo, celular enxuto; acesso pela VPN do usuário, com pareamento por QR e token por aparelho (`api.remote`); a web deixa de ser opcional; notificações e distribuição em aberto (itens 19 e 20); mockup `mockup/mobile.html`, com os comandos pelo celular como proposta | Decisão do dono |
| Executores padrão (v0.21) | Exemplo de lista por papel, sem Roteirista, com nomes sem regra (`haiku`, `codex-high`, `minimax`); padrões da primeira execução em aberto (item 8) | Nome `<modelo>-<esforço>@<perfil>`, com prefixo `claude-` e o sufixo da conta em todos; todos os papéis com lista de fallback; `ot init` detecta e aplica `roles.preset` (`quality` padrão, `balanced`, `economical`), acrescenta o Executor por API; Diretor `claude-haiku-low`, `codex-luna-low`, `gemma4-low`; `selection.cross_check: prefer_other_provider`; teto de gasto em API em aberto (item 21) | Decisão do dono |
| Custo e teto de gasto (v0.22) | Custo em moeda e teto de gasto em API em aberto (itens 10 e 21); só o orçamento por execução das tarefas agendadas | Assinatura com cota e equivalente em API, API com custo real, valor do cliente ou da tabela `pricing`; `budget` por dia e mês no perfil de API, aviso em 80%, `on_exceeded: skip`, `in_flight: handoff`; despertares no store (`wakeups`) retomam o trabalho quando a cota ou o teto voltam | Decisão do dono |
| Modelo local e provedor (v0.23) | §5.9 restringia o modelo local ao Orquestrador e a julgamentos curtos, mas a predefinição `economical` o punha entre os Atores; o provedor de um modelo local na revisão cruzada não estava definido; o nome `@<perfil>` não mostrava o cliente, e o OpenCode pode chamar o mesmo modelo do Claude por API; a §5.20 dava override da configuração a todo cenário, mas a §5.7 e a tabela `roles` só falavam de projeto; o `ot init` concentrava a configuração inicial num script, propenso a falhas | Modelo local como Ator limitado pelos slots da instância, com reserva para o Diretor (`local.slots`, `local.reserve_for_director`, `local.reserve_when`); provedor = família do modelo, campo `provider` do Executor; assistente de cadastro para os Executores do OpenCode, com validação pelo daemon e entrada nas listas dos papéis por `executors.on_register: ask`; `ModelCatalog` no `ClientAdapter` e porta `LocalModelServer` (llama.cpp na v1, Ollama depois); nome `<modelo>-<esforço>@<cliente>/<perfil>` e `executors.cross_client: api_only`; configuração dos papéis global com override por papel em cada cenário e tarefa agendada; `ot init` mínimo e assistente de configuração no daemon, desenhado pela TUI na v1 | Decisões do dono antes de abrir a pergunta sobre modelos locais por papel |
| Capacidade mínima por papel (v0.24) | Só `toolcall` validado no cadastro; a capacidade mínima de cada papel era a pergunta seguinte, e não se sabia se modelo local servia a todos os papéis | Todos os papéis aceitam modelo local; mínimo igual para local e nuvem em `roles.<papel>.requires` (janela de contexto, por slot no modelo local; raciocínio nos papéis que decidem); sessão de teste no cadastro; `roles.capability_check: warn` marca sem bloquear; a seleção pula quem não comporta o prompt | Escolha do dono: o que limita um papel é a capacidade do modelo, não onde ele roda, e o Produtor decide com o aviso à vista |
| Daemon como serviço de logon (v0.25) | Daemon como serviço de logon ou dentro do app desktop (`utilityProcess`), em aberto (item 6) | Sempre serviço de logon; o app desktop é só mais um cliente e instala o serviço pelo assistente quando ele falta | Escolha do dono: um daemon só por usuário, e as tarefas agendadas não dependem de uma janela aberta |
| Perguntas ao Produtor (v0.26) | `ask_producer` sem schema; múltipla escolha só como exemplo de ordem `instruction`; tarefa agendada pausava e notificava | Schema com opções, recomendada e "Outra"; `chat.producer_questions: choices` e `chat.unanswered: wait_then_recommended` (30 min); agendadas seguem com a recomendada depois do prazo da predefinição; decisões irreversíveis só com a opção segura | Pedido do dono: decidir com um toque e não depender de o modelo lembrar de um texto; nas agendadas, mais flexibilidade, com a salvaguarda para o que não se desfaz |
| Campos próprios no ATIF (v0.27) | ATIF v1.8 decidido, mas sem dizer onde ficam conta, cota, papel e worktree (Q11 em parte) | Bloco `extra.otheater` versionado; peça inteira como unidade, tentativas em `subagent_trajectories`; `cost_usd` só com custo real; conteúdo completo com segredos mascarados; chaves `atif.export.*` | Escolha do dono, igual às recomendações; o validador do Harbor usa `extra="forbid"`, então só os `extra` aceitam dado próprio |
| Ganchos dos plugins (v0.28) | Níveis de mod decididos sem os detalhes (item 15): pontos, prazo, falha do gancho e o que mais podia vir de plugin | Quatro pontos com `allow`/`veto`/`annotate`; 5 s, 30 s na entrega; `on_failure` declarado pelo plugin, com deixar passar como padrão; `QuotaProbe` e `Notifier` por plugin, com a suíte de conformidade; indicação só oficial | Escolhas do dono, iguais às recomendações, mais o ponto antes de lançar a tentativa |
| Ordem das interfaces depois da v1 (v0.29) | Item 12: a web podia começar depois da Fase 6 e o desktop era opcional | Web (12) depois da 10b; desktop (13) obrigatório, antes do Android (14); Electron ou Tauri ao abrir a Fase 13 | Escolhas do dono: web depois da 10b (a recomendada) e desktop antes do Android |
| Várias contas do mesmo provedor (v0.30) | Q15: conferir os termos e restringir o balanceamento até lá | Suportadas como qualquer perfil, sem divulgação, por conta e risco do usuário; aviso no cadastro da segunda assinatura, de qualquer plano; API nunca dispara | Decisões do dono; o aviso era proposta e foi aprovado |
| Fluxo da peça (v0.31) | Fluxo da imagem de 2026-10-30 e §5.4 com laços sem saída ou sem limite (veto do Autor, validação do roteiro, tentativas esgotadas, conflito, recomeço estrutural), saídas de AWAITING_PRODUCER indefinidas e só o roteiro corrigido revisado pelo Autor | P13: fronteira estreita por papel e esforço antes da execução; CLARIFYING com as dúvidas do plano; Autor revisa todo roteiro; `verify` por demanda; contador em todo laço e menu fixo no Produtor; vence a falha mais grave; peça nova depois da entrega | Experiência do dono com o `okit`: instruções incompletas geravam muitas rodadas do Crítico, sem garantir qualidade |
| Consistência (v0.32) | Menu fixo de cinco opções contra o limite de 2 a 4 do `ask_producer`; casos da 5.16 e o rebase fora da lista de pontos de julgamento; `task.define` sem as regras da v0.31; teclas e contadores antigos na TUI | Menu fixo como tipo próprio; lista de pontos de julgamento completa; `task.define` com CLARIFYING e revisão do Autor; Autor veta dependência sem motivo; teclas da 5.3 e chaves de `limits` na TUI | Revisão de consistência dos documentos antes da Fase 0; decisões do dono |
| App desktop (v0.34) | Só a web numa janela nativa; painel com Ctrl+J no mockup; sem terminal, diff, tela dividida nem ditado | Mapa de teclas e capacidades do Claude Desktop 5.11492.2 como preset `claude` do registro de interface; painéis de Mudanças, Arquivos e Terminal (sob a sandbox); tela dividida, chat lateral, bifurcar, voltar, enfileirar, ditado e chat rápido global; portas `TerminalSession` e `Dictation`; Fases 12 e 13 crescem 2 e 0,5 semana | Pedido do dono (N39): mesmo mapa e mesmas capacidades do Claude Desktop, com identidade própria |
| Navegador sem restrições (v0.35) | Perfil isolado por cenário, domínios permitidos, aprovação das ações de escrita e nenhum `localhost` nem `file://` previsto | Chaves `browser.*` com os padrões sem restrição: extensão no navegador do Produtor (Opera primeiro), qualquer domínio, `localhost`, `file://` menos os caminhos de segredo, escrita sem aprovação; as restrições antigas viram modos; R17 revisto; extensão na Fase 12, que cresce 1 semana | Pedido do dono (N40): o navegador sem as restrições do navegador do Claude Desktop, com os logins do navegador do dia a dia dele |
| Claudexor como referência (v0.36) | Trechos do Emdash e do acpx; ideias de Orca, Paradev e Happier; Claudexor não avaliado | Claudexor (MIT) como referência e fonte de trechos nas áreas críticas, à frente do Emdash nelas, com atribuição, sem dependência de runtime e sem o código que lê token; tabela por área na seção 6.3; verificador de licenças da Fase 1 com suporte a pnpm | Decisão do dono (N41), depois da avaliação em `spikes/fork-evaluation/claudexor.md` |
| O que o ACP não resolve (v0.37) | ACP como protocolo dos Executores; canais fora dele (statusline, `app-server`) usados caso a caso, sem regra geral | Regra geral: o que o ACP não resolve ganha uma alternativa adaptada, só entre os canais do cliente oficial, sem ler token | Decisão do dono (N42), depois do spike de cota esgotada simulada |
| Integração de terminal (v0.38) | Painel de Terminal e `terminal_snippet` na Fase 12 (N39), sem comando pelo chat nem acesso do Ator ao terminal | Comando `!` na TUI desde a Fase 7, com a saída na conversa; ferramentas de terminal do Ator pelo MCP do OTheater; saída ao vivo do Bash do Claude por `_meta.terminal_output_delta` | Decisão do dono (N43), a partir do uso do terminal do Claude Desktop nesta sessão |
| Conflitos de merge (v0.64) | Conflito na integração = falha de roteiro, sem dizer o que acontece com o código já aprovado, com um conflito no rebase das dependentes (ponto de julgamento 8) nem com a base que muda durante a peça | `rescript.reuse` (padrão `keep_unchanged`), `integration.rebase_conflict` (padrão `redo`) e `delivery.base_drift` (padrão `update`) (N82 a N84, 5.4, 5.5) | Decisões do dono N82 a N84 (2026-11-17), por múltipla escolha |
| Plano da Fase 5 (v0.73) | Fase 5 sem plano de passos; `ccusage`, releitura do Claudexor, rodadas reais e padrões de cota, seleção, custo e drenagem sem decisão | Plano em [docs/16](../16-PLANO-DA-FASE-5.md), com 24 passos (P0 a P23) em 7 ondas e o marco 5a [proposta]; dez decisões abertas (N118 a N127), cada uma com recomendação [proposta]; nenhuma tomada | Plano da Fase 5, 2026-11-17 (N118 a N127) |
| Decisões dos passos P2, P4 e P6 da Fase 4 (v0.73) | As propostas dos PRs #80, #81 e #82 sem decisão; `browser.secret_paths` e `browser.fallback` ainda [N]; a chave `browser` da política do papel sem padrão decidido | Regras da camada 2 com as 10 propostas aceitas (N114); medição do MCP do daemon dentro da sandbox antes de qualquer ponte, com a ponte por soquete Unix só se falhar (N115); `roles.<papel>.policy.browser: none` por padrão (N116); propostas restantes do P4 e do P6 aceitas, com os itens [N] a medir (N117); `browser.fallback: shared` e o apelido `browser.secret_paths` implementados no P6 (N107, N108) | Dono, 2026-11-17 (N114 a N117) |
| Consultor com escrita, pesquisa e imagem (v0.73, N86) | Consultor só de leitura, sem escrita na pasta do chat; adaptadores reais sem `inputTypes`; imagem só no agente falso | `consultant` escreve no worktree da consulta e o daemon confere e mescla na pasta do chat (`scenarios.consultant_writes: merge \| keep \| discard`, padrão `merge`); `http_get` e `browser_*` pela política do papel; imagem como bloco `image` do MCP; `inputTypes: ['image']` nos três adaptadores | Implementado no P10 da Fase 4; as escolhas ficam **[proposta]** até o dono decidir; sem mudar a versão do documento |
| Ponte do MCP do daemon para o cliente confinado (v0.73, N115) | Servidor MCP em `127.0.0.1` inalcançável de dentro do `bwrap` (loopback próprio, `NO_PROXY`), com a ponte por soquete Unix só se a medição falhasse | Medição feita (2026-11-17, [V]): o soquete Unix direto é barrado pelo seccomp; ouvinte TCP dentro da sandbox repassado pelo proxy da biblioteca; chave `sandbox.mcp_bridge` (`proxy` \| `off`); campo opcional `loopbackPorts` em `SandboxRequest`, porta `Sandbox` 0.1.0 sem mudar | Decisão do dono (N115), medida e implementada no PR #85; desenho e chave aceitos pelo dono e confirmados com o cliente real em 2026-11-17; sem mudar a versão do documento |
| `delivery.mode: ask` com alguém olhando (v0.73, N89, P9) | `ask` virava `pr` mesmo com o Produtor no chat, e o `attended` da entrega era fixo em `false` | Menu `deliver_pr`/`deliver_merge` em AWAITING_PRODUCER, aviso ao Diretor pela fila, `attended` real; chaves **[proposta]** `delivery.ask.timeout` e `delivery.ask.on_leave`, com `pr` como lado seguro | Decisão do dono (N89), implementada no P9; sem mudar a versão do documento |
| Suíte de fuga da Fase 4 (v0.73, P5) | Sem teste que tente sair do confinamento e diga qual camada segura cada tentativa | Roteiro `escape` do agente falso; 12 testes por ACP real (camada 2, cascas, limite das regras e camada 3 em `bwrap`), conferidos no disco do host e na rede, nenhuma fuga passou **[V]**; teste real e nível `escape` no `real-acceptance.sh`, pulados por padrão e não rodados **[N]**; sem chave nova; sem mudar a versão do documento | Passo P5 da Fase 4 (PR do P5) |
| Decisões dos passos P1 a P8 da Fase 4 (v0.73) | Política do papel fixa no código (`RolePolicy` v1, sem shell, só `reject`); sem sandbox, sem regras na camada 2, sem cascas, sem perfil `software` nem fila de ideias no código; as chaves da Fase 4 como propostas do plano | Porta `ClientAdapter` 0.3.0 e `RolePolicy` v2 (`nativeShell: none \| shells`, `mcpTools` por servidor, `onAsk: reject \| rules`); `roles.<papel>.policy` (incluindo `rules`) com as camadas padrão < `config.yaml` < cenário de origem < cenário e `roles` como objeto fechado; Ator com `native_shell: shells` (N101 a N103, N109); `tools.*` das cascas: `http.redirects: refuse`, sem verificador de efeito no `restricted_shell` e no `install_deps`, `env_inherit: minimal`, `heavy_commands` sem o `restricted_shell` (N104, N110); `project.conventions: ask` e os detalhes do perfil `software` (N105, N111); `sandbox.mode: runtime` e `security.unenforced: refuse` (N106); `security.secret_paths` como lista única, com `browser.secret_paths` como apelido (N107); `browser.fallback: shared` (N108); `ideas.drain: scheduled` ainda recusado (N112); CI da sandbox no Ubuntu 26.04, o que amplia a N95 (N113) | Dono, 2026-11-17 (N101 a N109); co-dono (Claude), com base no ok do dono para a Fase 4 (N110 a N113) |
| Ritmo medido nas estimativas (v0.72) | Estimativas só em semanas, sem agentes e com agentes; a linha da Fase 4 da tabela ainda com 2,5 semanas, contra as 3 do texto da fase | Coluna "No ritmo medido" na seção 10, com as horas das Fases 1 a 3 tiradas do git e a projeção de 4 a 9 h por semana estimada; Fase 4 corrigida para 3 semanas sem agentes e 2–2,5 com, com os totais e os marcos refeitos; a soma das Fases 12 a 14 corrigida; marcos com o ritmo medido | Dono, 2026-11-17, pedido de atualização |
| Plano da Fase 4 (v0.71) | Fase 4 sem plano de passos; downloads, Windows e CI sem decisão | Plano em [docs/15](../15-PLANO-DA-FASE-4.md) com o marco 4a (N96); `sandbox-runtime` 0.0.81 e `playwright-core` 1.64.1 (N93); camada 3 do Windows como portão (N94); sandbox e navegador na CI (N95); padrões da primeira onda: lista curada do `restricted_shell` (N97), limites das cascas (N98), override seguro da política (N99) e changelog sempre mantido (N100) | Dono, 2026-11-17, por múltipla escolha |
| Importação das demandas do `okit` (v0.70) | A Q12 previa uma ferramenta de importação, mas só as ordens tinham proposta; o mapeamento das demandas não estava desenhado | As demandas não feitas de cada projeto do kit vão para a fila de ideias do cenário do mesmo repositório; a fila espera o Produtor confirmar; projeto sem cenário vira pergunta; chaves `okit_import.*` (N92, 5.20) | Ideia do dono, como outro motivo para a fila de ideias; os pontos foram decididos por múltipla escolha |
| Fechamento da Fase 3 cumprido (v0.69) | Fase 3 à espera da rodada do nível `play` (N88) | Nível `play` passou em 2026-11-17 **[V]**, na terceira rodada; resultado na seção 10, Fase 3; a Fase 3 está fechada | Rodada real feita pelo orquestrador a pedido do dono; as duas falhas anteriores viraram os PRs #70 e #71 |
| Fila de ideias (v0.68) | Uma necessidade por peça, escrita pelo Produtor no chat; sem lugar para guardar ideias nem para juntar as que se cobrem | Fila de ideias por cenário; o Autor agrupa num ponto de julgamento, e o grupo vira a necessidade da peça; `ideas.drain` (padrão `auto`) e `ideas.grouping_approval` (padrão `ask`); tabela `ideas`; Fase 4 cresce 0,5 semana (N91, 5.20) | Ideia do dono; desenho proposto e aprovado no mesmo dia, com as escolhas por múltipla escolha |
| Decisões do P15 (v0.67) | `delivery.mode: ask` sem destino com alguém olhando; aviso da reconciliação sem forma de entrega | `ask` vira `pr` até a Fase 4; aviso uma vez, em memória, no próximo poll, com `recovery.notice` | Decisões do dono no P15 (N89 e N90) |
| Fechamento da Fase 3 (v0.66) | Lacunas do P12 e do P14 sem destino; peça real do aceite sem forma definida; sem regra de fechamento da Fase 3 | Passo P15 antes do aceite, com `DEPENDENCY_REDONE`, `attended` e o aviso depois da reconciliação; o resto vai à Fase 4 (N86); peça real num repositório local, com todos os papéis no Haiku pelo `claude-agent-acp` e o `CodeHost` falso (N87); a fase fecha depois da peça real do dono (N88) | Decisões do dono N86, N87 e N88 (2026-11-17), por múltipla escolha |
| Anexos e o Diretor (v0.65) | `read_attachment` só para os Executores; o Diretor passava todo anexo ao consultor pelo `consult`, mesmo um texto curto | O Diretor lê anexo de texto e PDF convertido; imagem e outros tipos são recusados a ele e seguem pelo `consult` (N85, 5.3, 5.20) | Decisão do dono N85 (2026-11-17), por múltipla escolha |
| Porta do servidor MCP (v0.63) | O plano da Fase 3 previa `mcp.port: auto \| <número>`, com o padrão `auto` como **[proposta]** | `mcp.port: auto \| <número>`, padrão `auto`: porta livre em `127.0.0.1` a cada subida, com a URL entregue às sessões; número fixo para depurar (N81, 5.3, Fase 3) | Decisão do dono N81 (2026-11-17), por múltipla escolha |
| Evento fora do registro (v0.62) | O plano da Fase 3 previa que o `append` recusasse o tipo de evento fora do registro, sem chave nem modo **[proposta]** | `events.unknown_type: reject \| warn`, padrão `reject`: o tipo fora do registro, a `schemaVersion` sem suporte ou o payload fora do schema lança erro e nada é gravado; `warn` grava e avisa no log (N80, 5.18, Fase 3) | Decisão do dono N80 (2026-11-17), por múltipla escolha |
| Fechamento da Fase 2 e plano da Fase 3 (v0.61) | Fase 2 aberta, com os itens sem medição real no Codex e no OpenCode; dependências da Fase 3 sem versão; Fase 3 sem plano de passos; MVP pelo próprio cliente apontado para o MCP; `N` de correções do `submit` sem chave | Fase 2 fechada com portões (nível `prompts` no Codex e no OpenCode antes da primeira peça real com cada um; `K` acima de 6 antes de um padrão maior); versões fixas de `xstate`, MCP `server`, `core` e `node`, `hono` e `@hono/node-server`; plano em docs/14 com o marco interno 3a; MVP pelo `ot chat` no terminal, com o Diretor aberto pelo daemon; `limits.submit_retries` 2/1/3 | Decisões do dono N75, N76 e N77 (2026-11-16), N78 e N79 (2026-11-17) |
| `K` padrão por cliente (v0.60) | A chave de `K` era por cliente e herdava a global, mas o padrão de cada cliente ficava [proposta] até a medição | Codex 6, OpenCode 4 e Claude Code sem padrão próprio (herda a global, sem efeito no `process-per-session`), a partir da medição real de 1, 2, 4 e 6 sessões pelo pool do daemon (uma rodada [V]); a global continua 4 (N74, 5.2, Fase 2) | Medição real e pergunta ao dono em 2026-11-16, por múltipla escolha |
| `K` por cliente (v0.59) | Um `K` só, `pool.sessions_per_process`, com 4 como valor inicial em todos os clientes (N62): não medido no Claude Code e medido só até 3 sessões no Codex | `pool.<cliente>.sessions_per_process`, que herda a global; o padrão de cada cliente sai da medição de 1, 2, 4 e 6 sessões, ociosas e com prompts, pelo pool do daemon (N74, 5.2, Fase 2) | Pergunta ao dono em 2026-11-16, por múltipla escolha |
| Atualização automática (v0.58) | A atualização era só uma linha nas Fases 10 e 13, sem modo, momento, origem, conferência nem volta | 5.21, "Atualização automática": `updates.mode`, padrão `auto`; `apply_when`, padrão `idle`, com `max_wait`; origem conforme a instalação, com SHA-256 e Ed25519; canais `stable` e `beta`; volta automática; backup antes das migrações (N73, 5.1, Fases 10 e 13) | Pedido do dono em 2026-11-16, decidido por múltipla escolha |
| Pendentes da Fase 2 (v0.58) | A troca da base aceita no P7b não tinha passo; sem a chave `client_version`, a versão do cliente ficava `unknown`; o `ollama` ficava para depois da v1; o `THIRD_PARTY_NOTICES` era um só, gerado no Linux | P13 da Fase 2 (N61); `package.json` e `initialize`, com a chave ganhando (N63, 5.2); `ollama` na Fase 2, LM Studio e vLLM depois da v1 (N71, 5.9, 5.18); avisos por plataforma no instalador (N72, 6.0, Fase 10) | Perguntas ao dono em 2026-11-16, por múltipla escolha |
| Telemetria para fora (v0.57) | A telemetria era recebida e gravada em `telemetry.sqlite`, mas nada dizia como mandá-la a um serviço como o Grafana | OTLP para um coletor configurável e `/metrics` Prometheus, com spans, logs, telemetria dos clientes e métricas do daemon; chave `telemetry.export`, padrão `off`; Fase 8 (N70, 5.11, 5.12, 5.18) | Pergunta do dono em 2026-11-16, decidida por múltipla escolha |
| Propostas do P11 (v0.56) | O contador das retomadas gratuitas ficava só na memória; o propósito da sessão existia só na classe-base; o aviso da isenção saía a cada leitura | Contador no registro da tentativa (N67, 5.16); `options?` com `purpose` na porta `ClientAdapter` (N68, 5.2 e 5.18); chave `security.catalog_probe_log`, padrão `once` (N69, 5.2) | Decisão do dono em 2026-11-16, sobre as propostas do PR #29 |
| Leitura de catálogo e retomadas gratuitas (v0.55) | Com `security.unenforced: refuse`, a sessão que lê o catálogo de modelos do Claude e do Codex não abria; as retomadas das irmãs derrubadas pela escalada (N64) não tinham teto | Chaves `security.catalog_probe`, padrão `allow` (N65, 5.2), e `resume.max_free_resumes`, padrão 3 (N66, 5.16) | Decisão do dono em 2026-11-16, sobre as propostas dos PRs #27 e #28 |
| Cancelamento compartilhado (v0.54) | Na §5.2, o cancelamento encerrava a árvore do cliente, o que num processo com várias sessões derruba as outras; o código só devolvia a vez da sessão | Chave `pool.shared_cancel`, com padrão `escalate` (N64, 5.2); o pool do daemon separa os processos pela chave canônica do `launchSpec` | Decisão do dono em 2026-11-16, ao corrigir as lacunas da Fase 2 |
| Propostas da Fase 2 (v0.53) | As escolhas dos PRs #20 a #25 (adaptadores, execução no daemon, várias sessões por processo, clientes reais) não estavam na arquitetura; a §5.2 só tinha o `processModel` | Registradas na N61 e na N62; nota de estado na §5.2 (várias sessões por processo na base, veto de modo e `via` aceitos para depois); item 28 da seção 12 (N63) | Revisão das propostas pelo dono, em 2026-11-16, depois das ondas 3 e 4 da Fase 2 |
| Lançador Rust sem `win32job` (v0.52) | §5.9 citava o crate `win32job` | `windows-sys` direto; limite do job inteiro, de memória comprometida; portão do item 13 fechado pela CI Windows | Decisão do dono (N60), depois do passo 6 da Fase 2 |
| Decisões da Fase 2 (v0.51) | `processModel` do OpenCode pendente do dono; testes de contrato reais sem regra de custo; lançador Rust sem plano de teste fora do Windows; §5.2 dizia `@otheater/adapter-<cliente>`; §5.5 tinha nomes de branch que o git recusa | Chave `pool.opencode.process_model`, padrão `per_profile` (N56, 5.2); parte real dos testes sob `OT_TEST_REAL_CLIENTS` e `OT_TEST_REAL_PROMPTS` (N57, seção 8); lançador testado na CI Windows (N58, Fase 2); nome `@otheater/adapter-client-<cliente>` em toda parte; branches sob `play/<id>/` (N59, 5.5), porque `play/<id>` e `play/<id>/<demand>/<attempt>` não coexistem no git | Decisões do dono em 2026-11-16, ao planejar a Fase 2 |
| Propostas da Fase 1 (v0.50) | Retenção de 7 cópias; `THIRD_PARTY_NOTICES` em `docs/`; pasta de dados, lock, senha mestra, log, formato do backup e `ot restore` sem detalhe; método do backup a escolher; custo do `FULL` como hipótese | Retenção de 2 dias por chave (N51); `THIRD_PARTY_NOTICES.md` na raiz; as escolhas dos PRs dos passos 2 a 6 nas seções 5.1, 5.6, 5.18, 5.21, 5.22, 7 e 9; custo do `FULL` medido; `online_api` em passo único como padrão, com `backup.pages_per_step` (5.21); telemetria numa base própria, `telemetry.sqlite` (N54, 5.11); análise do sistema como pergunta aberta da Fase 8 (N55, seção 12) | Propostas aceitas pelo dono em 2026-11-16 (N50, N51 e N52), medições do passo 7 da Fase 1 e escolha do método (N53) |
| Escolhas da Fase 1 (v0.49) | `better-sqlite3` ou `node:sqlite` a avaliar; biblioteca de i18n, ferramenta da regra de dependência e CI a escolher na Fase 1 | Chave `store.driver` com os dois drivers; i18next; dependency-cruiser; GitHub Actions, Linux a cada push e Windows e macOS manuais (seções 5.18, 5.22, 7, 8 e 10) | N49 (2026-11-15): decisão do dono por múltipla escolha |
| Fechamento da Fase 0 (v0.48) | Critério de aceite "cada item com resposta medida"; confirmação do R1 na Fase 0 | Fase 0 fechada com portões: os 13 itens sem resposta medida são condição das Fases 2, 4, 5, 7 e da entrada do modelo local; o R1 é portão da Fase 10 (seções 10, 11 e 12) | N48 (2026-11-15): nenhum item aberto bloqueia a Fase 1; 3 exigem Windows e 3 dependem do dono |
| Dados do OTel e do Nimbalyst (v0.47) | `otel` no `CODEX_CONFIG` sem causa; threads extras do Codex sem função; OpenCode sem span de modelo; Nimbalyst "MIT [a confirmar]" | Exportador do Codex só na partida do `app-server`; thread de título por sessão sem título; OpenCode só com `experimental.openTelemetry`, que vaza conteúdo; Nimbalyst MIT na raiz, árvore medida e reprovada (5.11 e tabela de referências). Sem decisão nova |
| Dados do item 8d (v0.46) | furos do `deny` do Claude só com `sh -c` e `bash -c`; efeito do `requirements.toml` e do revisor do Codex não medido; precedência do OpenCode medida com a config global ativa | mais furos no `deny` (ver 5.8); `claude` órfão quando o adaptador morre por SIGKILL; `requirements.toml` só em `/etc`; revisor do `agent` aprova rede, remoção e `sudo`; precedência e padrão `allow` do OpenCode iguais sem a global, e regras por padrão de comando medidas. Nenhuma decisão mudou | Item 8d da Fase 0 (2026-11-15) [V] |
| Permissões medidas no item 8 (v0.45) | Claude com `deny` como garantia do shell; OpenCode sem bypass "a confirmar"; Codex com `sandbox_mode` sem `danger-full-access`; `session/cancel` sem efeito definido nos filhos | Claude: `tools` sem Bash como principal, `deny` como segunda camada (`sh -c` fura); OpenCode: `OPENCODE_PERMISSION` fixado e `OPENCODE_DISABLE_PROJECT_CONFIG=1`, sem bypass pelo ACP; Codex: modo inicial `workspace-write` e veto do daemon a `agent` e `agent-full-access` (garantia `daemon`); cancelar encerra a árvore de processos; Claude com `settingSources: []` por padrão (`setting_sources: none`) | Item 8 da Fase 0 (2026-11-15) [V]; o dono aprovou o ajuste por múltipla escolha |
| Cota entre a casca e o gerente (v0.44) | `QuotaProbe` e `QuotaService` citados sem dizer quem coleta e quem decide; sinais de cota da sessão sem caminho definido | A casca de cada cliente coleta (`_otheater/quota/signal` na sessão, `QuotaProbe` fora dela); o `QuotaService` único do daemon guarda o estado, o custo e o teto e responde à seleção; gateway de API depois da v1 (`usage.api_gateway: off`), tudo **[proposta]** | Pergunta do dono em 2026-11-15 (cota na casca de agente ou numa casca própria), proposta aprovada por ele |
| Hierarquia de adaptadores (v0.43) | `interface ClientAdapter`; `RolePolicy` citada sem definição; tradução e conferência da política dentro de cada adaptador | Classe-base abstrata com o comum (sessão, camada 2, garantias, sondas) e um descendente por cliente; `RolePolicy` neutra; `sessionSetup` e `enforcement` por transporte (ACP ou headless), com a sessão aberta pela porta `AgentSession`; garantias em lista por campo; hierarquia de um nível sem sobrescrever os métodos comuns; chaves `security.min_layers`, `security.unenforced`, `security.conformance` e `security.on_conformance_fail`; cada descendente é a casca de agente do cliente (normaliza a conversa e expõe ACP normalizado, dentro do daemon, chave `agents.shell_process`), e a `AgentSession` vira o contrato que a casca devolve; o ACP é a língua única com o daemon, e os recursos únicos viram métodos de extensão `_otheater/...`, tudo **[proposta]** | Pedido do dono em 2026-11-15 (não depender do cliente; "uma classe agente com tudo o que precisamos e abaixo os descendentes especializados"); o item 8b mostrou que parte da política vai por sessão |
| Permissões do Claude pelo ACP (v0.42) | `dontAsk` para os Executores headless e `disableBypassPermissionsMode` contra o bypass; mecanismo pelo ACP a confirmar | Modo `default` com o cliente recusando cada `request_permission`; `allowDangerouslySkipPermissions: false` contra o bypass; mecanismo do ACP registrado na seção 5.8 | Medição da Fase 0 (`acp-claude`, item 8b): o `dontAsk` não chega pelo adaptador 0.107.0; ajuste aprovado pelo dono em 2026-11-15 |
| Decisões de licença da Fase 0 (v0.41) | Executores sem nível definido; licenças permissivas fora da lista como caso a caso; `OR`/`AND` do SPDX e GPL no nível C sem regra; AgentPrism com licença a confirmar | Nível C para os executores; oito licenças aceitas em dependências; regras do SPDX; GPL e LGPL só no nível C; exceção por pacote para o AgentPrism (seção 6.0) | Decisões do dono (N45), sobre os achados D1 a D10 do spike `licenses` |
| Licença do MCP SDK v2 e relatório da Fase 0 (v0.40) | §6.1 dizia MIT; o entregável da Fase 0 não tinha relatório | Apache-2.0 na §6.1; relatório consolidado em `spikes/RELATORIO-FASE-0.md`, ligado à Fase 0 | Fato medido pelo spike `licenses` (D8); a Apache-2.0 já é permitida (§6.0) |
| Comandos `/` e sessão direta (v0.39) | `/` só no app Android, sem registro no daemon; comandos do cliente sem destino; todo cenário só com o chat do Diretor | Registro de comandos no daemon desde a Fase 7; comandos do cliente com prefixo, na sessão do Diretor parado e na sessão direta; sessão direta do Produtor com um Ator, fora de peça | Decisão do dono (N44) |
| Padrões (v0.16) | Padrões dos cenários e do backup sem valor (itens 16 e 17); migração sem login sem data | Chaves `scenarios.*`, `tasks.*` e `backup.*` com várias opções e padrões definidos; backup inclui as pastas de tarefa e chat, menos as execuções; Fase 10b do daemon sem login | Decisões do dono, que pediu que cada padrão seja chave de configuração |
| Cofre no Linux (v0.7) | Só Secret Service | Fallback para arquivo criptografado ou variável de ambiente do serviço | Servidores sem interface gráfica e sessões SSH não têm Secret Service |
| Teste de terminais da Fase 0 (v0.7) | Windows Terminal, VS Code e um de macOS/Linux | Inclui Terminal.app, iTerm2, GNOME Terminal/Konsole, tmux, SSH e todos os atalhos | Os padrões do mapa de teclas saem desse teste |
