# ADR 0001: projeto próprio, sem fork

- **Estado:** aceita
- **Data:** 2026-11-14 (horário de São Paulo, UTC-3)
- **Decisão:** N1 do [docs/13](../13-DECISOES-EM-ABERTO.md); arquitetura §6.4 e §12, item 1
- **Quem decidiu:** o dono (Anderson), igual à recomendação da avaliação da Fase 0
- **Evidência:** [spikes/fork-evaluation/README.md](../../spikes/fork-evaluation/README.md); para o Claudexor, [spikes/fork-evaluation/claudexor.md](../../spikes/fork-evaluation/claudexor.md)
- **Atualizada:** 2026-11-15 (N41), com o Claudexor como referência; ver a seção "Atualização" no fim

Marcadores: **[V]** verificado localmente; **[S]** fonte secundária (API do GitHub ou documentação do próprio projeto, sem confronto com o código); **[N]** não confirmado ou hipótese.

## Contexto

O OTheater precisa de um núcleo próprio:
- um daemon por usuário, independente da interface, com API para a TUI, a web, o desktop e o Android (§5.1 e §5.12);
- a máquina de estados do pipeline em XState v5 (§5.4);
- o store único em WAL (§7);
- os Executores por ACP (§5.2).

A pergunta da N1 era se valia partir do código de um projeto existente (fork) ou escrever o núcleo e só reaproveitar trechos.

## Critérios (arquitetura §6.4)

1. Licença do projeto e de toda a árvore de dependências. A política da §6.0 permite MIT, Apache-2.0, ISC, BSD-2/3-Clause, 0BSD e MPL-2.0. Proíbe GPL, AGPL e LGPL. O resto se decide caso a caso.
2. Núcleo que rode como daemon com API, separado da interface.
3. Encaixe da máquina de estados por cima.
4. Qualidade do código e testes.
5. Ritmo do upstream.

## Opções avaliadas

Os clones rasos são de 2026-11-14. Nenhum código dos candidatos foi executado, e as dependências foram instaladas com `--ignore-scripts`. **[V]**

| Candidato | Licença | Daemon com API | Máquina de estados | Observação |
|---|---|---|---|---|
| Emdash | Apache-2.0; árvore com 0 proibidas em 1.476 pacotes **[V]** | Parcial: o `workspace-server` usa um protocolo próprio ("wire"), não HTTP, e o controlador é o app Electron **[V]** | Máquina própria de sessão, sem XState **[V]** | O mais aproveitável em código |
| Orca | MIT; 0 proibidas **[V]** | Sim, mas dentro de um app de cerca de 3 milhões de linhas **[V]** | DAG próprio; ACP sem o SDK **[V]** | 12.804 commits em 90 dias **[S]** |
| AionUi | Apache-2.0; libvips LGPL no lockfile **[V]** | Falha: o núcleo (AionCore) é um binário de outro repositório **[V]** | Não avaliável | 79 commits em 90 dias **[S]** |
| Paradev | MIT; libvips LGPL no lockfile **[V]** | O melhor do grupo (Hono + tRPC), mas preso à nuvem (JWT, túnel, Sentry), e o modo headless não está resolvido **[V]** | Sem XState; fluxos do produto **[V]** | CLA no repositório |
| Happier | MIT; **4 proibidas**: `@img/sharp-libvips-*`, LGPL-3.0-or-later, dependência de produção **[V]** | Sim, mas é um produto de controle remoto com relay **[V]** | Sem XState; `AcpBackend.ts` de 4.479 linhas **[V]** | A árvore foi medida reduzida, por cota de disco |
| Fork parcial do Emdash (opção B) | Apache-2.0 | Exigiria trocar o wire pela API HTTP da §5.12 | Exigiria trocar a máquina de sessão e a persistência | Não validado na prática **[N]** |
| Projeto próprio com trechos reaproveitados | A nossa | Desenhado para isso | XState por cima, sem conflito | Mais código novo |

O acpx (MIT, cliente ACP headless) entrou como referência, não como candidato. A árvore dele tem 0 proibidas em 390 pacotes. **[V]**

## Decisão

**Projeto próprio, sem fork.** Reaproveitamos trechos com licença permitida (nível A da §6.0), nesta ordem:

1. **Emdash** (Apache-2.0):
   - conexão e cache dos processos ACP;
   - sondas de cota;
   - adaptadores por cliente;
   - worktrees;
   - documentação de arquitetura.
2. **acpx** (MIT):
   - cliente ACP;
   - árvore de processos do adaptador;
   - permissões;
   - sessões, fila, journal e retomada;
   - a suíte de testes, como modelo.
3. **Orca, Paradev e Happier** (MIT): só ideias e trechos pequenos.
   - Orca: várias contas, cotas e o protocolo de propriedade do socket do daemon.
   - Paradev: supervisor do daemon e o teste que impede acoplar o daemon à interface.
   - Happier: servidor de controle e operações de worktree.

Os caminhos exatos estão na §4 da avaliação.

## Motivos

1. Nenhum candidato entrega o daemon único por usuário, separado da interface e com API, sem uma reescrita (critério 2).
2. Nenhum usa XState. Todos têm uma máquina própria de sessão ou de DAG, que ocupa o lugar do pipeline da §5.4. Um fork obrigaria a reescrever justamente a parte que diferencia o OTheater (critério 3).
3. O SDK ACP dos candidatos é antigo em relação à arquitetura:
   - v1.x no Emdash, no Paradev e no Happier;
   - 0.18 no AionUi;
   - nenhum SDK no Orca.

   A migração para a v2 seria nossa de qualquer forma. **[V]**
4. Peso e ritmo (critério 5): o Orca divergiria em dias, o AionUi quase parou, e os demais trazem centenas de milhares de linhas de produto (interface, nuvem, celular) que o OTheater não quer manter. **[S]** para os números de commits.
5. Licença (critério 1): o único bloqueio objetivo é o LGPL-3.0 dos binários libvips do `sharp`. Ele aparece no Happier, onde foi confirmado pelo verificador, e no AionUi e no Paradev, pelo lockfile. Emdash, Orca e acpx estão limpos. **[V]**

## Consequências

- **Mais código novo nas Fases 1 a 3**, em troca de um núcleo que segue a arquitetura sem herdar máquina de sessão, persistência ou protocolo de terceiros.
- **Copiar exige cumprir as licenças:**
  - Apache-2.0 (Emdash): manter `LICENSE` e `NOTICE` e marcar os arquivos alterados;
  - MIT: manter o aviso de copyright;
  - tudo isso vai para o `THIRD_PARTY_NOTICES` em `docs/` (arquitetura, estrutura do repositório).
- **Fica de fora qualquer trecho que dependa de `sharp`** ou de `@img/sharp-libvips-*`. Rever a regra para binários opcionais de plataforma seria uma decisão à parte do dono; não foi tomada.
- **Antes de copiar um arquivo que importe `@anthropic-ai/claude-agent-sdk`**, é preciso ler a licença "Custom" do pacote. O texto não foi lido. **[N]**
- **Outros casos a decidir na hora de copiar:**
  - EPL-2.0 do `elkjs` (Emdash e acpx);
  - FSL-1.1-MIT do `@sentry/cli`, que é só ferramenta de build;
  - OFL-1.1 das fontes.
- **A opção B (fork parcial do Emdash) fica registrada como alternativa.** Três coisas mudariam a recomendação:
  - o dono priorizar um protótipo rápido em vez de um núcleo limpo;
  - a licença "Custom" e a decisão sobre libvips se mostrarem menos restritivas do que a §6.0 supõe;
  - um spike rodar o `workspace-server` do Emdash como serviço headless e mostrar que o wire é fino o bastante para trocar.

## O que não foi verificado

- Nenhum candidato foi executado. Faltam testes, tempo de subida, memória e a confirmação de que os daemons rodam headless.
- Não foram lidos:
  - o AionCore;
  - o texto da licença "Custom" do SDK da Anthropic;
  - a árvore completa do Happier (`apps/ui` e os módulos nativos);
  - o pacote `@openai/codex` linux-x64 no Paradev.
- Os números de commits vêm da API do GitHub, consultada em 2026-11-14. **[S]**

## Atualização (2026-11-15, N41): Claudexor como referência

**Contexto.** O Claudexor (`razzant/claudexor`, MIT, © Anton Razzhigaev, TypeScript) não entrou na avaliação de 2026-11-14. Ele é o projeto mais parecido com o OTheater:
- é um plano de controle local, com daemon e API;
- roda várias assinaturas do Claude e do Codex, lê a cota de cada uma e troca de conta quando a cota acaba;
- faz revisão cruzada entre famílias de modelo.

Ele foi avaliado pelos mesmos critérios em [spikes/fork-evaluation/claudexor.md](../../spikes/fork-evaluation/claudexor.md). A avaliação leu o código e as licenças e não executou nada.

| Critério | Resultado |
|---|---|
| 1. Licença | MIT; 0 licenças proibidas em 196 pacotes; sem libvips **[V]** |
| 2. Daemon com API | Sim: socket Unix e HTTP em loopback com token, 113 endpoints **[V]** |
| 3. XState por cima | Não encaixa: os pipelines dele são código imperativo **[V]** |
| 4. Qualidade | 1.117 arquivos de teste, com mais linhas de teste que de código **[V]**; a suíte não foi rodada **[N]** |
| 5. Ritmo | 881 commits em 30 dias **[S]** |
| Segurança (§3) | **Conflita**: lê o token OAuth do Claude e do Codex e chama a API do fornecedor com ele **[V]** |

**Decisão do dono:** "vamos usá-lo como referência para não termos que reinventar código em áreas críticas".
- **Continua sem fork**, pelos critérios 3 e 5, pela regra da §3 e porque ele não fala ACP com os clientes.
- **O Claudexor entra na lista de reaproveitamento**, à frente do Emdash nestas áreas:
  - sondas de cota;
  - pool de contas;
  - rotação na retomada;
  - sonda de login e perfis isolados;
  - store;
  - API do daemon;
  - orçamento.

  O Emdash e o acpx continuam como fonte do runtime ACP, das sessões e dos worktrees. Os caminhos de cada área estão na §6.3 da arquitetura.
- **Atribuição:**
  - o aviso MIT vai para o `THIRD_PARTY_NOTICES`;
  - cada arquivo adaptado ganha um cabeçalho com o projeto, o caminho e o commit de origem, mesmo quando a lógica é reescrita.
- **Fica de fora** todo código dele que lê token OAuth ou arquivo de credencial, ou que chama a API do fornecedor por fora do cliente oficial. A lista de arquivos está na §6.3.
- **Nenhum pacote `@claudexor/*` como dependência.**
- **Referência fixada** na tag `v6.1.2`, commit `7a87c337b5b54f28f6038a4a7c5138da7cc87c4a` (2026-11-14). **[S]**, consultado na API do GitHub em 2026-11-15.
- **[proposta]:**
  - reler o arquivo de referência no commit mais novo ao abrir cada fase;
  - uma trava na CI contra nomes de arquivo de credencial e endpoints proibidos em código próprio.

**TeamClaude** (`KarpelesLab/teamclaude`, MIT): não entra nem como fonte de código. Ele guarda os tokens das contas em texto, abre o HTTPS com um certificado próprio e reescreve o identificador da conta nas requisições. **[V]** Dele ficam só ideias:
- separar a cota esgotada do limite por minuto;
- espaçar as requisições na conta recém-escolhida;
- preferir a conta cuja janela reinicia primeiro.

**Consequência para a Fase 1:** a avaliação achou um defeito no verificador de licenças do spike. Com pnpm em workspaces, ele aprova 0 pacotes em silêncio. **[V]** O verificador da Fase 1 precisa ler árvores pnpm e reprovar quando não achar nenhum pacote.
