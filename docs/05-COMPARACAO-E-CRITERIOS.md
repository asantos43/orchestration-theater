# 05. Comparação e critérios de decisão

> **Histórico. Comparação encerrada em 2026-11-13** (decisão Q1 em [13](13-DECISOES-EM-ABERTO.md)). A arquitetura do OTheater ([framework-ideas/arquitetura.md](framework-ideas/arquitetura.md), v0.10) não tem contêiner nem runner trocável. O caminho híbrido proposto aqui não foi adotado. As medições que continuam valendo foram para a **Fase 0** da arquitetura (§10): concorrência dos adaptadores, perfis isolados, sandbox no Windows e lançador com Job Object. O texto abaixo foi mantido como registro da análise de 2026-11-08 e não foi atualizado.

Duas arquiteturas, **com contêiner** ([03](03-ARQUITETURA-1-COM-CONTEINERES.md)) e **sem contêiner** ([04](04-ARQUITETURA-2-SEM-CONTEINERES.md)), sobre o mesmo núcleo ([02](02-NUCLEO-COMUM.md)). A diferença está só no runner.

## Lado a lado

| Critério | 1. Com contêiner | 2. Sem contêiner |
|---|---|---|
| Linux | Nativo | Nativo |
| macOS e Windows | Só dentro de uma VM Linux (Podman machine, Docker Desktop, Colima, WSL2); não testado aqui | Nativo |
| Instalação do produto | Exige runtime de contêiner (e VM fora do Linux) | Baixar o app |
| Isolamento de arquivos | Fronteira real | Política (ferramentas, caminhos, usuário dedicado opcional) |
| O sandbox do cliente (causa do `EPERM`, P2) | Desligado com segurança: o contêiner é o sandbox | Ligado causa o `EPERM`; desligado não há fronteira |
| Agentes em paralelo | Sem colisão de portas, `HOME` e `/tmp` | Colisões possíveis, reduzidas com `HOME` e `TMPDIR` próprios |
| Reprodutibilidade | Alta (imagem fixa) | Depende do host |
| Limites de recursos | Nativos (CPU, memória, processos, tempo) | Frouxos; job objects no Windows |
| Política de rede por agente | Possível (proxy, sem rede) | Só pela ferramenta web própria |
| Builds de outro sistema (`.dmg`, `.exe`) | Não cobre; passo fora do runner | Cobre no sistema em que roda |
| Testes de interface no desktop real | Só com `xvfb`, sem o desktop real | Sim |
| Desempenho | Sobrecarga de subida; volumes lentos com VM | Nativo |
| Esforço de desenvolvimento | Maior (imagens, volumes, UID, rede, runtime) | Menor (lançador de processo com ambiente limpo, três implementações finas) |
| Manutenção | Imagens e runtime | Diferenças entre sistemas |
| Segurança de tarefas com web ou conteúdo não confiável | Forte | Fraca; só a separação leitura e envio e listas curtas |
| Credenciais | Injeção no contêiner, host protegido | Mesmo usuário do agente; cofre do sistema direto |
| Experiência do dono | Já usa Podman (release local, teste de instalador) | Já usa o fluxo nativo |

## Perguntas que decidem

1. **O desktop para Windows e macOS é objetivo de primeira linha?** Se sim, a arquitetura 2 simplifica; a 1 exige VM e runtime nesses sistemas.
2. **Quanto vale o isolamento forte?** Se agentes com internet e shell livre rodando na máquina do dono, com acesso ao resto do disco, é aceitável, a 2 basta. Se não, a 1 (ou um usuário dedicado na 2).
3. **Os agentes rodam muito em paralelo?** Seis ao mesmo tempo com testes de socket favorece a 1; a 2 exige `HOME` e `TMPDIR` próprios e portas efêmeras.
4. **Há builds específicos de sistema no fluxo?** Se sim, a 1 não os cobre; eles precisam de runner nativo de qualquer jeito.
5. **O produto será distribuído a terceiros?** Pré-requisitos de contêiner e licença pesam contra a 1.
6. **Os repositórios são confiáveis?** Código do próprio dono: risco menor na 2. Código de terceiros ou web aberta: a 1.

## Caminho híbrido (proposta, não decisão)

Como as duas só diferem no runner, não é preciso escolher uma para sempre:

1. Implementar a **interface do runner** ([02](02-NUCLEO-COMUM.md)) e começar por **uma** implementação (a nativa, a mais simples e portável).
2. Deixar a política do núcleo **escolher o runner por tarefa** pelas `capacidades()`: tarefas de risco (web aberta, código de terceiros) pedem isolamento forte; builds de macOS e Windows pedem runner nativo; o resto, o que estiver disponível.
3. Acrescentar o **runner de contêiner como opcional** (Linux primeiro; macOS e Windows onde houver Podman ou WSL2) quando a Fase 0 mostrar que compensa.

Vantagem: o produto instala de forma simples nos três sistemas, e quem quiser isolamento forte o liga. Custo: duas implementações do runner a manter e testes nos três sistemas.

## O que medir na Fase 0 para decidir

- Suíte do `okit-plugin` nativa (sandbox do cliente desligado, `HOME` próprio) e em contêiner: tempo total, falhas por colisão, falhas por `EPERM`.
- Seis agentes paralelos em cada cenário: tempo, uso de memória e disco, colisões.
- Tempo de subida do contêiner e da imagem.
- Viabilidade e latência do contêiner no macOS e no Windows (Podman machine ou WSL2), se houver máquina para testar.
- Viabilidade do usuário dedicado para agentes no cenário nativo.

Esses números alimentam Q1 e Q2 em [13](13-DECISOES-EM-ABERTO.md).

## Fora deste eixo

- **Continuar com o Claude Code mais o `okit`** (sem núcleo próprio): [06](06-ALTERNATIVA-HARNESS-EXISTENTE.md). O kit hoje roda nativo, com os executores no sandbox de cada cliente.
- **Partir de um agente open source como base:** [12](12-HARNESSES-OPEN-SOURCE-AVALIADOS.md). Conclusão da conversa: nenhum serve de base de orquestrador; podem entrar como executores atrás de adaptadores.
