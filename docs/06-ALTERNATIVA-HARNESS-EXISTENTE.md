# 06. Alternativa: continuar com um harness existente (Claude Code + okit)

> **Alternativa registrada, fora do rumo escolhido** (decisão Q3 em [13](13-DECISOES-EM-ABERTO.md), 2026-11-13). O rumo é construir o **OTheater** ([framework-ideas/arquitetura.md](framework-ideas/arquitetura.md)). Este documento continua útil por dois motivos:
> - descreve o fluxo que segue em uso até o OTheater servir no dia a dia (marco "uso diário", Fases 0–5);
> - lista melhorias pequenas que ainda valem para o `okit` nesse intervalo.
>
> O que acontece com o `okit` é a pergunta Q12. Abaixo, "A" é esta alternativa e "B" é o núcleo próprio, hoje o OTheater.

## Ideia

Continuar usando um cliente de agente pronto (Claude Code, ou Codex) como o **Diretor**, e **endurecer** esse cliente para que ele fique no papel, apoiado no kit (`okit`) que já executa o trabalho em segundo plano. Nada de núcleo próprio: a melhoria vem de configuração, permissões, hooks, agentes definidos e de evolução do kit.

## Desenho

```
Dono ──(terminal / Remote Control / app do Claude)──► Claude Code (Diretor, modelo barato)
                                                        │  ferramentas permitidas: só `okit ...` (lista de Bash)
                                                        ▼
                                              okit (orchestration-kit)
                                  inbox · wt · brief · run · wait · report · mutate
                                  approve · pr · suite · quota · orders · critic
                                                        │
                       ┌────────────────────────────────┼────────────────────────────┐
                       ▼                                ▼                            ▼
                 Codex (cx)                      OpenCode (m3)               Agentes Claude em
                 assinatura ChatGPT              MiniMax                     segundo plano
                                                                             (assinatura Anthropic)
                       └──────── cada um em uma worktree própria (`wt new`) ──────────┘
```

## Como endurecer o papel (variante endurecida)

O Claude Code tem recursos que aproximam o papel garantido (verificado em `claude --help`, versão 2.1.319):

- `--allowedTools` e `--disallowedTools`: tirar `Edit`, `Write` e `Bash` geral e liberar só `Bash(okit:*)` e leitura.
- `--agent` e `--agents`: definir um agente Diretor com prompt e ferramentas fixos.
- `--permission-mode` e hooks (`PreToolUse`): bloquear por política o que o prompt não impede.
- `--model` e `--effort`: Haiku ou outro modelo barato, esforço baixo.
- `--autocompact`: tamanho da janela de compactação.
- Sessões de fundo (`--bg`, `attach`, `logs`) e **Remote Control** (`--remote-control`) para iterar de qualquer lugar.
- Rotinas e agendas do próprio Claude Code (`CronCreate`, `RemoteTrigger`, a skill `schedule`) para tarefas recorrentes.

## Prós

1. **Já existe e funciona.** O D149 e o D150 foram entregues e mesclados com ele; o custo de começar é zero.
2. **Cliente oficial, uso interativo ou próximo disso.** É o cenário mais seguro quanto aos termos de uso da Anthropic (ver [07](07-ASSINATURAS-E-TERMOS.md)).
3. **Ecossistema pronto**: skills, MCP, plugins, hooks, Remote Control, sessões de fundo, `claude-mods`.
4. **Manutenção pequena**: atualizações do cliente chegam sozinhas, sem adaptador a manter.
5. **O kit já codifica o processo** (briefing, mutação, crítico, ordens), incluindo lições aprendidas.
6. **Evolução gradual**: cada problema vira uma demanda no kit (por exemplo a D371), sem recomeçar.

## Contras

1. **O papel não é garantido por construção.** Mesmo com `--disallowedTools`, o Diretor é um agente geral; um erro de configuração devolve a ele as ferramentas. É a objeção central do dono: "estou forçando um comportamento que eles não foram feitos para fazer".
2. **Contexto longo e compactação** (P9): o estado do fluxo vive na conversa e no resumo, não em um banco do núcleo.
3. **Custo de tokens do Diretor**: o cliente carrega seu prompt de sistema e a conversa inteira a cada turno; modelo barato ajuda, mas o histórico cresce.
4. **Sandbox e permissões dos executores continuam** (P2): o problema é do cliente executor, não do orquestrador. A é neutra aqui, a não ser que o kit passe a rodar os testes fora do sandbox por conta própria.
5. **Cota sem visão central** (P3): o `kit quota` e o `capacity` existem, mas o Diretor depende de ler esses números e agir; não há um corretor de contas que balanceie sozinho.
6. **Sem interface própria** (P10): dashboards, projetos, plugins e app de desktop não existem; dependem do que o Claude Code oferece.
7. **Um Diretor por sessão.** Vários projetos significam várias sessões independentes, sem um plano de controle que as enxergue juntas.
8. **Preso a um fornecedor para o cérebro**: se a Anthropic mudar preços, cotas ou termos, o Diretor muda junto.
9. **Agendamento e tarefas gerais limitados** ao que o cliente oferece, com pouca gestão de política (janela de cota, execução perdida, segredos por tarefa).
10. **Trajetórias**: o cliente grava as sessões no formato dele; converter para ATIF seria uma camada à parte, sem tempo real próprio.

## Quando A é a escolha certa

- Se a prioridade é **continuar entregando** o `okit-plugin` e outros projetos sem investir em produto novo.
- Se o dono aceita que o "papel garantido" seja **suficientemente bom** com permissões e hooks.
- Se interface própria, multi-projeto centralizado e telemetria completa **não** são urgentes.

## Melhorias que A pode absorver sem virar B

- Rodar verificações dos executores **fora do sandbox do cliente**, pelo próprio `okit` (resolve P2 sem núcleo novo).
- Um corretor de contas simples dentro do `okit` (escolher a conta pela cota, pausar com aviso, não cruzar sessões entre clientes: P4 e P5).
- Um Diretor `--agent` com a lista de ferramentas mínima e hooks que bloqueiam o que não for `okit`.
- Exportar as trajetórias dos executores para ATIF por um conversor pós-execução.
