# 13. Decisões em aberto

Estado das perguntas. Ao decidir, mude o estado, registre a data e o motivo.

Em **2026-11-13** a arquitetura do **OTheater** ([framework-ideas/arquitetura.md](framework-ideas/arquitetura.md), v0.10) passou a ser a base de construção. Várias perguntas abertas em 2026-11-08 foram respondidas por ela. O motivo registrado em cada uma aponta para a seção correspondente. As perguntas novas da seção 12 da arquitetura estão na segunda tabela, com prefixo **N**.

## Perguntas da conversa de 2026-11-08 (Q1 a Q19)

| # | Pergunta | Estado | Data | Resposta e motivo |
|---|---|---|---|---|
| Q1 | Arquitetura do runner: com contêiner ou sem contêiner? | **Decidida** | 2026-11-13 | **Sem contêiner.** Cada Executor roda como processo nativo numa worktree própria, com permissões em três camadas: configuração do cliente, respostas automáticas do ACP e sistema operacional (Job Object, `sandbox-runtime`). Motivo: arquitetura §5.8 e §5.9. A comparação estava nos antigos documentos 03 a 05, apagados em 2026-11-13 (última versão no commit `cb05e35`). |
| Q2 | O desktop para Windows e macOS é objetivo de primeira linha? | **Decidida** | 2026-11-13 | **Não.** A interface principal é a **TUI** (Fase 7). Web (Fase 12) e desktop (Fase 13) são opcionais. O sistema é "Windows primeiro, sem impedir macOS/Linux". Motivo: arquitetura §3, §5.13 e §15 (v0.6). Se e quando fazer a web e o desktop é a N12. |
| Q3 | Construir o núcleo próprio ou continuar com o Claude Code + `okit`? | **Decidida** | 2026-11-13 | **Construir o OTheater.** Ainda está em aberto se o projeto parte de um fork ou é próprio com trechos reaproveitados (N1). A alternativa estava no antigo documento 06, apagado em 2026-11-13 (última versão no commit `cb05e35`). Motivo: arquitetura §1 e §6.4. |
| Q4 | Termos de uso: automação contínua sobre assinatura é aceitável? | **Aberta (reformulada)** | 2026-11-13 | Segundo a arquitetura (§3, que cita a documentação legal do Claude Code consultada em 2026-11-13), o **uso pessoal** com o binário oficial e logins próprios se encaixa nos termos. **Distribuir como produto** exige confirmação com a Anthropic (risco R1, decisão N2). Isso não foi verificado nesta revisão; ver [07](07-ASSINATURAS-E-TERMOS.md). |
| Q5 | Linguagem e processo do núcleo | **Decidida** | 2026-11-13 | **TypeScript strict** de ponta a ponta, **Node 24 LTS**, um daemon por usuário/máquina. O código próprio é MIT. Motivo: arquitetura §5.1 e §8. |
| Q6 | App de desktop: Electron ou Tauri? | **Aberta** | — | Só importa se a Fase 13 for feita. É a mesma pergunta que a N7. |
| Q7 | Orquestrador: chamada por turno ou processo vivo? | **Decidida** | 2026-11-13 | **Sessão ACP viva**: `claude-agent-acp` com Haiku ou `opencode acp` com Gemma 4 local. Ela só usa as ferramentas MCP do Diretor. O estado fica no daemon (`proxima_acao`/`status`), há uma fila única de prompts e failover para o próximo Executor do papel. Motivo: arquitetura §4, §5.3 e §5.4. |
| Q8 | Adaptador do Codex | **Decidida** | 2026-11-13 | **`@agentclientprotocol/codex-acp`** (usa o `codex app-server`). A saída de emergência é `codex exec --json` ou `@openai/codex-sdk`. Motivo: arquitetura §5.2. |
| Q9 | Isolamento no cenário nativo | **Decidida** | 2026-11-13 | **Três camadas** (§5.8). O Bash nativo do Claude é removido e o shell passa só pelas cascas do framework. No macOS/Linux, `sandbox-runtime`. No Windows, `sandbox-runtime` em alpha, a pilotar na Fase 0; o plano B é um usuário de baixo privilégio com ACL só na worktree, mais o sandbox do Codex. A medição fica na Fase 0. |
| Q10 | Runtime de contêiner | **Descartada** | 2026-11-13 | Deixou de se aplicar com a Q1. |
| Q11 | Versão do ATIF e campos de extensão | **Decidida em parte** | 2026-11-13 | **ATIF-v1.8** do Harbor (RFC 0001 de `harbor-framework/harbor`). A conformidade é validada com o `TrajectoryValidator` do Harbor nos testes. Motivo: arquitetura §5.11. Onde ficam os campos próprios (conta, cota, papel, worktree) ainda não foi detalhado. |
| Q12 | Relação com o `okit` | **Decidida** | 2026-11-13 | **Só os conceitos do `okit` são aproveitados; nenhum código dele.** O OTheater é uma arquitetura nova. Os conceitos do kit (listados em [01](01-CONTEXTO-E-PROBLEMAS.md)) servem de referência, mas cada um é redesenhado dentro da arquitetura. Motivo: decisão do dono, para não herdar os vícios do projeto anterior (problemas P1 a P10 em [01](01-CONTEXTO-E-PROBLEMAS.md)). **Complemento (2026-11-13):** são projetos separados. O `okit` continua em uso no fluxo atual até o OTheater ficar pronto. Depois, uma **ferramenta de importação** migra as demandas e estruturas do `okit` para a estrutura do OTheater. A arquitetura ainda não prevê essa ferramenta, e o mapeamento entre as duas estruturas não foi desenhado. |
| Q13 | Onde mora o estado | **Decidida** | 2026-11-13 | **SQLite em modo WAL** (`better-sqlite3` ou `node:sqlite`) com **Kysely**. Um log de eventos de id crescente é a fonte única, e o snapshot XState de cada peça fica no banco. Motivo: arquitetura §5.4, §5.11 e §7. |
| Q14 | Meta de custo da orquestração | **Aberta** | — | Medir antes de fixar. A arquitetura reduz o custo com contexto mínimo, blackboard, prefixo estável e mensagens de andamento sem modelo (§5.4 e §5.10). |
| Q15 | Multi-conta do mesmo provedor | **Aberta** | — | A arquitetura (§3) diz para conferir os termos de cada provedor e aponta os planos de time/empresa com vários assentos como o caminho limpo. Restringir até ler os termos ([07](07-ASSINATURAS-E-TERMOS.md)). |
| Q16 | Acesso remoto ao núcleo | **Aberta** | — | Por padrão o daemon escuta em `127.0.0.1`, e o acesso remoto exige token + TLS (§3). Se esse acesso é necessário é a N9. |
| Q17 | Modelo do orquestrador | **Decidida em parte** | 2026-11-13 | O Executor do Diretor é configurável. O exemplo da arquitetura usa a lista `[haiku, gemma4-local]` (§5.7). Para modelo local, **Gemma 4** e não Gemma 3. Os padrões da primeira execução são a N8. |
| Q18 | Plugins | **Decidida** | 2026-11-13 | **Servidores MCP com manifesto de permissões.** Cada plugin roda uma vez e o daemon agrega todos, com filtro por papel. Motivo: arquitetura §5.9 e §5.14. |
| Q19 | Nome definitivo do produto | **Decidida** | 2026-11-13 | **OTheater** (*Orchestration Theater*). Pacote `otheater`, escopo `@otheater/*`, comando `ot`/`otheater`, organização GitHub `orchestration-theater`. Motivo: arquitetura §9 e §12. |

## Perguntas da arquitetura (seção 12, v0.10 e v0.11)

Copiadas da seção 12 da arquitetura em 2026-11-13. A arquitetura é a referência. Ao decidir, atualize as duas.

| # | Pergunta | Estado | Observação |
|---|---|---|---|
| N1 | Fork (Emdash é o principal candidato; Orca, AionUi, Paradev ou Happier) ou projeto próprio com trechos reaproveitados | Aberta | A Fase 0 decide pelos critérios da §6.4. O padrão até lá é projeto próprio. |
| N2 | Modo de distribuição: pessoal (assinaturas) ou produto (API para Claude) | Aberta | Depende da resposta da Anthropic sobre o R1 (Q4). |
| N3 | Tipos de cenário além de projeto: o que muda no fluxo de "tarefa" e de "chat genérico" | Aberta | Afeta as tarefas gerais de [10](10-TAREFAS-GERAIS-E-AGENDAMENTO.md). |
| N4 | Valores padrão de `Np`, `Nc`, tentativas por demanda e timeouts | Aberta | |
| N5 | Política de entrega por projeto: PR sempre ou merge direto permitido | Aberta | O padrão é PR. |
| N6 | Daemon como serviço de logon, como processo do app desktop ou os dois | Aberta | |
| N7 | Electron ou Tauri (só se a Fase 13 for feita) | Aberta | Igual à Q6. |
| N8 | Executores padrão de cada papel na primeira execução | Aberta | Ligada à Q17. |
| N9 | Necessidade de acesso remoto ao dashboard | Aberta | Ligada à Q16. Define cedo ou tarde o TLS/reverse proxy. |
| N10 | Custo em moeda: assinaturas (só uso relativo da cota) versus API (custo real) | Aberta | |
| N11 | Framework da TUI: Ink (padrão) ou OpenTUI | Aberta | O teste comparativo da Fase 0 é obrigatório. A decisão vira ADR. |
| N12 | Se e quando fazer a web (Fase 12) e o desktop (Fase 13) | Aberta | |
| N13 | Padrões do agendador: janela para execução perdida, prazo máximo de adiamento por cota, espera por decisão sem ninguém olhando, orçamento por execução | Aberta | Ver [10](10-TAREFAS-GERAIS-E-AGENDAMENTO.md). |
| N14 | Padrões da retomada: limite de retomadas por tentativa, espera máxima pelo reset antes de passar o bastão, intervalo dos checkpoints, critério de "agente travado" | Aberta | Arquitetura §5.16. |
| N15 | Ordens do Produtor (arquitetura §5.17, incluída na v0.11) | **Decidida** | 2026-11-13. Decisões do dono, todas iguais às propostas: (1) no mesmo cenário, a local prevalece sobre a global; (2) uma ordem vale para um cenário ou para todos, sem lista nem tag; (3) sessões em curso não mudam, e o Diretor decide se relança o Ator; (4) `regra` com quatro chaves na v1: perfis de um papel, `proximo`/`esperar`, exigir PR e `git.push_apos_commit` (push da branch da demanda após cada commit, sem force push nem push na base). A quarta chave foi acrescentada no mesmo dia, quando o dono deu "fazer push sempre que commitar" como exemplo de ordem; (5) a dispensa do Crítico é uma decisão registrada do Produtor, não uma ordem. Ela vale para a peça inteira e pode ser tomada ao abrir a peça ou depois de uma reprovação (§5.4); (6) a janela recorrente fica para depois da v1; (7) o aviso de prazo é 24 h antes, configurável; (8) a suspensão local de uma global fica. Na arquitetura, a pergunta saiu da lista numerada da §12 e foi para "Decididas". |

**Já decididas na arquitetura** (2026-11-13):
- nome do produto: OTheater (§9);
- licenças permitidas: MIT, Apache-2.0, ISC, BSD-2/3-Clause e 0BSD; copyleft proibido (§6.0);
- Arize Phoenix (ELv2) aceito só como ferramenta local opcional, nunca distribuído (§6.2).

## Ideias registradas, sem prioridade

- Medir a **qualidade por executor** (erro e retrabalho) com a telemetria. A arquitetura já grava o motivo de cada escolha de Executor e o tipo de cada falha como eventos (§5.7 e §5.11).
- Uma etapa `init` que levanta assinaturas, modelos, capacidades e limites paralelos de cada máquina (ideia anterior do kit). Na arquitetura, isso corresponde às config options anunciadas pelos adaptadores e ao `processModel` medido na Fase 0.
- Os **seis agentes em paralelo** do dono (2 por assinatura, 3 assinaturas) como referência para o controle de admissão. Na arquitetura, o limite vem de RAM, cota e pool (§5.9).

## Próximas ações sugeridas

1. **Fase 0** da arquitetura (§10): medir adaptadores ACP, concorrência, retomada nativa, perfis isolados, permissões pelo ACP, sondas de cota, sandbox no Windows, lançador Rust, modelo local, teste Ink × OpenTUI e OTel. Avaliar também a base de fork (N1).
2. Pedir à Anthropic a confirmação sobre o uso de assinatura num orquestrador pessoal versus distribuído (Q4, N2).
