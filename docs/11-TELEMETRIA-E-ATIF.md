# 11. Telemetria e trajetórias (ATIF)

Este documento resume a observabilidade do OTheater, a partir da arquitetura v0.10 (§5.11, §5.12, §7 e Fase 8), de 2026-11-13, e foi conferido com a v0.32 em 2026-11-14. **Nada aqui foi verificado localmente.** Em 2026-11-14 (v0.27), a RFC do ATIF e os modelos Pydantic do Harbor foram lidos no GitHub (ramo `main`) para decidir a Q11; ver a seção "Campos próprios".

## O que se quer

- Acompanhar a trajetória de cada agente **em tempo real**.
- **Telemetria completa:** eventos, uso de tokens, cota por perfil, duração e resultado de cada etapa.
- Trajetórias **exportáveis em ATIF** (R11 em [00](00-OBJETIVO.md)).

## Log de eventos: a fonte única

O log é a tabela `events` do SQLite, com id crescente. Tudo é evento (P6). A UI lê o log por SSE (`/events?scenario=&since=`, com reconexão por `Last-Event-ID`), primeiro o histórico e depois ao vivo.

Os tipos de evento têm nome em inglês desde a v0.17 (arquitetura §5.22).

| Família | Conteúdo |
|---|---|
| `play.*`, `stage.*`, `demand.*`, `attempt.*` | Ciclo de vida do pipeline: estado, roteamento por tipo de falha, retomada |
| `session.update` | O que o adaptador ACP envia: mensagens, tool calls, diffs, plano |
| `executor.selected` | O Executor escolhido, os que foram pulados e por quê |
| `permission.*` | Pedido, resposta automática do daemon e a regra que decidiu |
| `tool.called` | Chamada de casca ou plugin |
| `quota.*`, `usage.*` | Estado da cota por perfil; tokens e custo |
| `decision.*` | Pontos de julgamento do Diretor e decisões do Produtor |
| `chat.*` | Mensagens do chat do cenário |
| `schedule.*` | Disparos e resultados do agendador ([10](10-TAREFAS-GERAIS-E-AGENDAMENTO.md)) |
| `directive.*` | Criação, início, mudança de vigência, prazo, expiração, suspensão e revogação das ordens do Produtor (§5.17, v0.11) |
| `browser.*` | Ações do agente no navegador compartilhado (URL e print de cada uma), troca de quem controla a sessão e indicações `I<n>` enviadas pelo Produtor (§5.19, v0.13) |
| `scenario.*` | Criação, importação, promoção, anexos e Diretor adormecido ou acordado (§5.20, v0.14) |
| `task.*` | Definição (versão, ensaio, aprovação) e execuções da tarefa, passo a passo, até a entrega (§5.20, v0.14) |
| `daemon.*` | Reconciliação na subida (`daemon.recovered`, com sessões retomadas, efeitos resolvidos e pendências) e backup (`daemon.backup`) (§5.21, v0.15) |
| `error.*` | Erros classificados |

O **tipo de falha** alimenta o roteamento do pipeline (execução, roteiro, estrutural, exceção crítica). O **motivo da interrupção** alimenta a retomada (cota, rede, queda, reinício, timeout, agente travado; §5.16). Os dois servem também para medir a qualidade por Executor, um desejo anterior do dono.

## OTel nativo dos clientes

Os clientes já emitem telemetria, então não instrumentamos nada neles:
- **Claude Code:** `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*`. Emite métricas (`claude_code.token.usage`, `cost.usage` etc.) e eventos (`api_request`, `tool_result`, `tool_decision` etc.). Os traces estão em beta.
- **Codex:** tabela `[otel]` no `config.toml` do perfil (`otlp-http`).

O daemon configura os dois, por perfil, para mandarem a **um receptor OTLP do próprio daemon**. Os ids da peça e da tentativa vão como atributos de recurso. O conteúdo dos prompts fica **redigido por padrão**.

## OTel do daemon

Os spans seguem a hierarquia peça → etapa → tentativa → sessão → chamada de ferramenta, nas convenções GenAI de agentes (`invoke_agent`, `execute_tool`). Essas convenções ainda estão em "Development" e podem mudar.

## ATIF (Agent Trajectory Interchange Format)

Segundo a arquitetura (§5.11, fontes consultadas em 2026-11-13):
- O formato é definido pelo **Harbor**, dos criadores do Terminal-Bench. A versão atual é a **ATIF-v1.8**, com especificação na RFC 0001 do repositório **`harbor-framework/harbor`**.
- Não há biblioteca TS. O OTheater escreve o próprio **schema zod** a partir da RFC e um exportador `session.update` → ATIF.
- A conformidade é validada nos testes pelo **`TrajectoryValidator`** (Python) do Harbor. O Harbor é Apache-2.0, nível D (só desenvolvimento).

> **Correção em relação a 2026-11-08.** A versão anterior deste documento, baseada em fonte secundária, dizia ATIF **1.7** no repositório `laude-institute/harbor`. A arquitetura cita a **1.8** em `harbor-framework/harbor`. Vale a arquitetura. Em 2026-11-14, a RFC foi aberta e a versão 1.8 consta como a atual no histórico dela, embora o texto ainda cite 1.7 e 1.5 em alguns trechos.

Notas de 2026-11-08 que continuam úteis:
- os modelos do Harbor (Pydantic, `harbor.models.trajectories`) rejeitam campos não declarados, então metadados próprios precisam ir nos campos de extensão do esquema (**confirmado em 2026-11-14** no código: `extra="forbid"` em todos os modelos);
- **não confirmado:** os ids de passo são sequenciais a partir de 1, e passos do agente trazem chamadas de ferramenta, observações e métricas.

## Campos próprios (Q11, decidida em 2026-11-14, v0.27)

Resumo da arquitetura §5.11 (decisões do dono, iguais às recomendações):
- tudo o que é do OTheater fica num objeto `otheater` dentro dos `extra` do ATIF (raiz, `agent`, `step`, `tool_calls`, resultados de `observation`, `metrics`, `final_metrics`), com `schema: 1` na raiz;
- a unidade padrão é a **peça inteira**: a trajetória do Diretor na raiz e cada tentativa em `subagent_trajectories` (`atif.export.unit: play`, ou `attempt`, `play_files`);
- `cost_usd` só leva custo real; nas assinaturas fica nulo, e o equivalente em API e a cota vão no bloco próprio;
- o conteúdo sai **completo**, com os segredos sempre mascarados (`atif.export.content: full`, ou `redacted`).

O que vai em cada nível e o jeito de ligar as tentativas lançadas pelo daemon são **[proposta]** e fecham na Fase 8, contra o validador.

## Tempo real versus arquivo

O ATIF é um **arquivo por trajetória**. O acompanhamento ao vivo vem do log de eventos:
1. o adaptador ACP emite `session/update`;
2. o daemon grava isso como `session.update` no log;
3. a UI mostra a trajetória viva por SSE;
4. ao fim da tentativa, os chunks de stream são compactados em trajetória, e o ATIF é gerado a partir dela.

A retenção é configurável, com política de expurgo.

## Visualizadores

- **Dashboard próprio:** a TUI e, a partir da Fase 12, a web, lendo o store. As listas são virtualizadas e as trajetórias paginadas.
- **Arize Phoenix** (opcional): roda como processo único sem Docker, ingere OTLP e importa ATIF. É ELv2, aceito só como **ferramenta local**, nunca embutido nem distribuído (§6.0 e §6.2). A receita, com o que o Phoenix aceita de fato (o OTLP dele é só protobuf, e o OTheater manda JSON), está em [reference/phoenix.md](reference/phoenix.md).
- **OpenLIT** e **Laminar** (Apache-2.0) exigem Docker + ClickHouse.

## Telemetria agregada (a mostrar no dashboard)

- Cota e consumo por perfil, por provedor, por cenário, por papel e por peça.
- Custo da orquestração (sessões do Diretor) separado do custo dos Executores, para o critério de sucesso 8 de [00](00-OBJETIVO.md) e a Q14.
- Taxas de retentativa, de falha por tipo e de aprovação do Crítico, por Executor.
- Tempo por etapa e por peça.
- Custo em moeda (N10, decidida em 2026-11-14, arquitetura §5.6): a assinatura mostra a cota e, ao lado, o equivalente em API, que é uma estimativa; a conta de API mostra o custo real.

## Cuidados

- **Redação:** tokens e segredos nunca entram no log, no OTel nem no ATIF (§3).
- **Tamanho:** observações grandes (saídas de teste) são truncadas no evento. O conteúdo completo é guardado à parte e citado por referência (caminho, id, hash; §5.10).
- **Versão:** gravar a versão do esquema do evento e a do ATIF em cada arquivo.
- **Contratos:** os adaptadores ACP mudam rápido (risco R2), então é preciso fixar versões e ter testes de contrato com saídas gravadas.
