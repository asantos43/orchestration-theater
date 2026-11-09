# 03. Arquitetura 1: com contêineres

Núcleo comum em [02](02-NUCLEO-COMUM.md). Aqui, o **runner roda cada agente (e as verificações) dentro de um contêiner**, com a worktree montada como volume.

## Desenho do runner

```
núcleo ──► runner de contêiner
             │  1. cria a worktree no host (git worktree)
             │  2. sobe um contêiner de uma imagem do projeto (toolchain pronta)
             │       - worktree montada em /work (leitura e escrita)
             │       - HOME e /tmp próprios do contêiner
             │       - configuração da conta (CLAUDE_CONFIG_DIR, CODEX_HOME) montada ou token injetado
             │       - limites: CPU, memória, processos, tempo
             │       - rede: política (liberada, proxy com lista de domínios, nenhuma)
             │  3. roda o CLI do agente com o sandbox DO CLIENTE DESLIGADO
             │       (o contêiner é o sandbox: `--dangerously-bypass-approvals-and-sandbox` no Codex,
             │        permissões amplas no Claude dentro do contêiner)
             │  4. roda testes, compilação e mutações no mesmo contêiner
             │  5. recolhe artefatos e destrói o contêiner
```

O `--help` do Codex diz que `--dangerously-bypass-approvals-and-sandbox` é "intended solely for running in environments that are externally sandboxed": o contêiner é exatamente esse ambiente. Isso resolve de raiz os `EPERM` do P2 sem enfraquecer o host.

## O que o dono já tem

- Experiência e ferramentas com **Podman**: o `release-local.mjs` do Folder Browser constrói os pacotes num contêiner, e há prática de testar o instalador num contêiner (Podman com driver de pty na imagem de verificação).
- Execução do Electron em contêiner (`xvfb-run` com `--no-sandbox`) já documentada no Folder Browser.

## Prós

1. **Fronteira real do sistema**: o agente, mesmo com shell livre, só enxerga a worktree e o que foi montado. `~/.ssh`, o resto do disco e outras contas ficam fora do alcance.
2. **O sandbox do cliente pode ser desligado com segurança**: resolve o P2 (testes de socket, `spawnSync`) sem abrir o host.
3. **Agentes em paralelo sem colisão**: cada contêiner tem a sua rede, portas, `HOME` e `/tmp`. Testes que escutam portas ou escrevem em `~/.config` não se atropelam.
4. **Reprodutibilidade**: a imagem fixa as versões das ferramentas; o mesmo resultado hoje e daqui a seis meses; menos "funciona na minha máquina".
5. **Limites de recursos** nativos (CPU, memória, processos, tempo) e **limpeza total** ao destruir o contêiner.
6. **Controle de rede**: política de saída por contêiner (proxy com lista de domínios), útil para agentes que leem a web e para auditar acessos.
7. **Segurança de tarefas gerais**: leitura da web e código não confiável ficam isolados do host e dos segredos.
8. **Credenciais sob controle**: o contêiner só recebe o segredo da conta do agente daquele passo.

## Contras

1. **Linux nativo apenas.** No macOS e no Windows os contêineres rodam dentro de uma **VM Linux** (Podman machine, Docker Desktop, Colima, WSL2). É conhecimento geral, **não verificado aqui**. O app de desktop para Windows e macOS passa a exigir que o usuário instale e mantenha um runtime de contêiner e uma VM.
2. **Não cobre builds nativos de outros sistemas.** Um `.dmg` precisa do macOS e um `.exe` assinado de ferramentas do Windows; um contêiner Linux não os produz (o Folder Browser faz o `.dmg` por um workflow manual do GitHub Actions por esse motivo). Esses passos teriam que sair do runner de contêiner.
3. **Desempenho nos sistemas com VM**: volumes montados entre o host e a VM são mais lentos em muitos arquivos (como `node_modules`); a subida do contêiner e da VM soma segundos a cada passo.
4. **Aplicações com interface gráfica e e2e** (Electron, navegadores) funcionam com `xvfb`, mas não testam o comportamento do desktop real.
5. **Imagens para manter**: uma por conjunto de ferramentas (Node, Python, Rust…), com atualizações, cache e uso de disco; o primeiro uso de cada imagem é lento.
6. **Login e tokens**: o fluxo de login dos CLIs abre o navegador do host; o contêiner precisa receber o diretório de configuração ou um token (`setup-token`, `--with-access-token`). O cofre do sistema fica no host; a injeção precisa ser cuidadosa.
7. **Licença**: o Docker Desktop tem restrições comerciais para empresas grandes (conhecimento geral, confirmar); o Podman é livre. Pesa se o produto for distribuído a terceiros.
8. **Mais peças e mais modos de falha**: runtime do contêiner, rede, volumes, permissões de usuário (rootless e mapeamento de UID), imagem, VM.
9. **Distribuição**: instalar o produto deixa de ser "baixar o app"; passa a exigir pré-requisitos, uma barreira para quem não é o dono.
10. **O agente com rede dentro do contêiner ainda vaza o que está dentro dele** (a worktree, o token da conta injetado). O contêiner protege o host, não o conteúdo montado.

## Quando a arquitetura 1 é a escolha certa

- O produto roda **principalmente no Linux** (ou o dono aceita exigir Podman e VM no macOS e Windows).
- A prioridade é **isolamento forte e reprodutibilidade**, com muitos agentes em paralelo e tarefas da web.
- Os builds de outros sistemas operacionais podem ser **feitos fora do runner** (CI ou a máquina real).

## Itens a testar na Fase 0 (para esta arquitetura)

- Tempo de subida do contêiner e do primeiro uso da imagem do `okit-plugin`; custo dos volumes em `node_modules`.
- A suíte completa do `okit-plugin` no contêiner, sem o sandbox do Codex: zero `EPERM`?
- Login e renovação de token com o diretório da conta montado.
- Quantos contêineres paralelos a máquina aguenta (o dono planeja até seis agentes ao mesmo tempo).
- Como ficaria no macOS e no Windows (Podman machine ou WSL2): funciona, e com que latência? (não testado)
