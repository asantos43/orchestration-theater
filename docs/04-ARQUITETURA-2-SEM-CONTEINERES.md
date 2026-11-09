# 04. Arquitetura 2: sem contêineres

Núcleo comum em [02](02-NUCLEO-COMUM.md). Aqui, o **runner é nativo**: cada agente roda como processo do sistema do usuário, numa worktree própria, e a proteção vem de **política aplicada pelo núcleo** e não de uma fronteira do sistema.

## Desenho do runner

```
núcleo ──► runner nativo
             │  1. cria a worktree (git worktree) e uma pasta de trabalho temporária
             │  2. monta o ambiente do processo:
             │       - variáveis mínimas (sem herdar segredos)
             │       - HOME, TMPDIR e diretórios de cache PRÓPRIOS do agente
             │       - configuração da conta (CLAUDE_CONFIG_DIR, CODEX_HOME)
             │  3. lança o CLI do agente com permissões e ferramentas definidas pelo núcleo
             │       (`--allowedTools` / `--disallowedTools` / `--permission-prompts host` no Claude;
             │        política do Codex), com o diretório de trabalho na worktree
             │  4. roda testes, compilação e mutações como processos próprios do runner,
             │       FORA do sandbox do cliente
             │  5. limite de tempo e encerramento da árvore de processos
             │       (Windows: job objects)
```

Opções para endurecer sem contêiner (a **avaliar**, não verificadas):

- **Usuário do sistema dedicado** para os agentes (`sudo -u` no Linux e macOS, usuário restrito no Windows): o agente deixa de ver os arquivos do dono.
- **Sandboxes nativos dos clientes** (Seatbelt no macOS, Landlock ou bwrap no Linux no Codex): suporte e política por sistema; o suporte no Windows **não foi verificado**. Ligar o sandbox do cliente é justamente o que causou os `EPERM` do P2.
- **Runner de contêiner ou VM opcional** para as tarefas de risco, onde o usuário tiver o runtime (é o outro cenário, [03](03-ARQUITETURA-1-COM-CONTEINERES.md)).

## Prós

1. **Portável por construção**: Windows, macOS e Linux sem runtime extra nem VM; instalar o produto é baixar o app.
2. **Builds e testes nativos de cada sistema**: o `.dmg` no macOS, o `.exe` no Windows e testes de interface no desktop real rodam sem passos fora do runner.
3. **Desempenho nativo**: sem camada de virtualização nem volumes lentos; subida de cada passo em milissegundos.
4. **Menos peças e modos de falha**: sem imagens, runtime, rede virtual nem mapeamento de UID.
5. **Ferramentas do usuário já instaladas** (Node, compiladores, SDKs) são usadas como estão, sem imagens para manter.
6. **Login e cofre do sistema diretos**: o CLI e o cofre (Keychain, Credential Manager, libsecret) vivem no mesmo ambiente; sem montar diretórios nem injetar tokens num contêiner.
7. **Adoção simples** para um app de desktop que o dono queira distribuir.
8. **Menor custo de desenvolvimento inicial**: uma implementação do runner é um lançador de processo com ambiente limpo.

## Contras

1. **Isolamento fraco.** Com o sandbox do cliente desligado, uma ferramenta de shell lê tudo o que o usuário lê (`~/.ssh`, tokens de outras contas, outros projetos). O núcleo só controla o que o cliente deixa passar pelas ferramentas; um `Bash` livre contorna regras de caminho. É a troca central: **sandbox do cliente ligado causa os `EPERM`; desligado, não há fronteira**.
2. **Colisões entre agentes em paralelo**: portas, arquivos em `~/.config` e `~/.cache`, bancos locais, processos soltos. `HOME` e `TMPDIR` próprios reduzem, mas não eliminam (portas fixas, serviços do sistema).
3. **Reprodutibilidade depende do host**: versões de ferramentas, variáveis e atualizações do sistema mudam o resultado entre máquinas e datas.
4. **Limites de recursos mais frouxos**: sem cgroups portáveis; no Windows, job objects; no macOS e no Linux, `ulimit` e controle de processos. Memória e CPU de um agente descontrolado são difíceis de limitar.
5. **Limpeza imperfeita**: encerrar a árvore de processos é frágil (processos órfãos, daemons iniciados pelos testes); resíduos em disco e no registro.
6. **Rede sem política por agente**: não há como restringir o acesso por agente sem um proxy local obrigatório (e o agente pode ignorá-lo se tiver shell livre). O controle fica na ferramenta web própria, não na rede.
7. **Segurança das tarefas gerais**: leitura de conteúdo não confiável acontece na máquina do dono. A defesa é a separação de leitura e envio e as listas curtas de ferramentas ([09](09-ISOLAMENTO-E-SEGURANCA.md)), não um isolamento.
8. **Diferenças entre sistemas**: árvores de processos, caminhos, shell e serviços variam; o runner precisa de três implementações finas e testes nos três sistemas.
9. **Credenciais ao alcance**: tokens das contas ficam no mesmo usuário do agente; uma ferramenta de shell pode tentar lê-los (mitigação: usuário dedicado, cofre do sistema e a regra "o agente nunca recebe segredos que não precisa").

## Quando a arquitetura 2 é a escolha certa

- O **desktop para Windows e macOS** é objetivo de primeira linha e instalar deve ser simples.
- O trabalho é sobre **repositórios do próprio dono** (confiáveis) e o risco aceito é o de um agente local com permissões amplas e limitadas por política.
- Há **builds específicos de cada sistema** que precisam rodar no runner.

## Itens a testar na Fase 0 (para esta arquitetura)

- A suíte completa do `okit-plugin` com o sandbox do Codex **desligado** e `HOME` próprio: zero `EPERM`? Quais colisões ainda aparecem em seis agentes paralelos?
- Um usuário do sistema dedicado para os agentes: é viável no Linux, macOS e Windows? Qual o custo operacional?
- O que o sandbox do Claude e o do Codex realmente bloqueiam em cada sistema, com a política mais permissiva que ainda cubra os testes.
- Encerramento da árvore de processos e limpeza depois de um teste que deixa serviço aberto.
