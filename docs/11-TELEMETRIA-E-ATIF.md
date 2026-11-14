# 11. Telemetria e trajetórias (ATIF)

Este documento resume a observabilidade do OTheater, a partir da arquitetura v0.10 (§5.11, §5.12, §7 e Fase 8), de 2026-11-13. **Nada aqui foi verificado localmente.** A RFC do ATIF não foi aberta nesta revisão.

## O que se quer

- Acompanhar a trajetória de cada agente **em tempo real**.
- **Telemetria completa:** eventos, uso de tokens, cota por perfil, duração e resultado de cada etapa.
- Trajetórias **exportáveis em ATIF** (R11 em [00](00-OBJETIVO.md)).

## Log de eventos: a fonte única

O log é a tabela `events` do SQLite, com id crescente. Tudo é evento (P6). A UI lê o log por SSE (`/events?cenario=&desde=`, com reconexão por `Last-Event-ID`), primeiro o histórico e depois ao vivo.

| Família | Conteúdo |
|---|---|
| `peca.*`, `etapa.*`, `demanda.*`, `tentativa.*` | Ciclo de vida do pipeline: estado, roteamento por tipo de falha, retomada |
| `sessao.update` | O que o adaptador ACP envia: mensagens, tool calls, diffs, plano |
| `executor.selecionado` | O Executor escolhido, os que foram pulados e por quê |
| `permissao.*` | Pedido, resposta automática do daemon e a regra que decidiu |
| `ferramenta.chamada` | Chamada de casca ou plugin |
| `cota.*`, `consumo.*` | Estado da cota por perfil; tokens e custo |
| `decisao.*` | Pontos de julgamento do Diretor e decisões do Produtor |
| `chat.*` | Mensagens do chat do cenário |
| `agenda.*` | Disparos e resultados do agendador ([10](10-TAREFAS-GERAIS-E-AGENDAMENTO.md)) |
| `ordem.*` | Criação, início, mudança de vigência, prazo, expiração, suspensão e revogação das ordens do Produtor (§5.17, v0.11) |
| `navegador.*` | Ações do agente no navegador compartilhado (URL e print de cada uma), troca de quem controla a sessão e indicações `I<n>` enviadas pelo Produtor (§5.19, v0.13) |
| `cenario.*` | Criação, importação, promoção, anexos e Diretor adormecido ou acordado (§5.20, v0.14) |
| `tarefa.*` | Definição (versão, ensaio, aprovação) e execuções da tarefa, passo a passo, até a entrega (§5.20, v0.14) |
| `daemon.*` | Reconciliação na subida (`daemon.recovered`, com sessões retomadas, efeitos resolvidos e pendências) e backup (`daemon.backup`) (§5.21, v0.15) |
| `erro.*` | Erros classificados |

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
- Não há biblioteca TS. O OTheater escreve o próprio **schema zod** a partir da RFC e um exportador `sessao.update` → ATIF.
- A conformidade é validada nos testes pelo **`TrajectoryValidator`** (Python) do Harbor. O Harbor é Apache-2.0, nível D (só desenvolvimento).

> **Correção em relação a 2026-11-08.** A versão anterior deste documento, baseada em fonte secundária, dizia ATIF **1.7** no repositório `laude-institute/harbor`. A arquitetura cita a **1.8** em `harbor-framework/harbor`. Vale a arquitetura, mas a RFC continua sem ser aberta por nós.

Notas de 2026-11-08 que continuam úteis, **não confirmadas**:
- os modelos do Harbor (Pydantic, `harbor.models.trajectories`) rejeitam campos não declarados, então metadados próprios precisam ir nos campos de extensão do esquema;
- os ids de passo são sequenciais a partir de 1, e passos do agente trazem chamadas de ferramenta, observações e métricas.

**Em aberto** (Q11 em [13](13-DECISOES-EM-ABERTO.md)): onde ficam os campos próprios (perfil, cota, papel, worktree, peça, demanda) dentro do ATIF-v1.8. A arquitetura não detalha.

## Tempo real versus arquivo

O ATIF é um **arquivo por trajetória**. O acompanhamento ao vivo vem do log de eventos:
1. o adaptador ACP emite `session/update`;
2. o daemon grava isso como `sessao.update` no log;
3. a UI mostra a trajetória viva por SSE;
4. ao fim da tentativa, os chunks de stream são compactados em trajetória, e o ATIF é gerado a partir dela.

A retenção é configurável, com política de expurgo.

## Visualizadores

- **Dashboard próprio:** a TUI, e a web se for feita, lendo o store. As listas são virtualizadas e as trajetórias paginadas.
- **Arize Phoenix** (opcional): roda como processo único sem Docker, ingere OTLP e importa ATIF. É ELv2, aceito só como **ferramenta local**, nunca embutido nem distribuído (§6.0 e §6.2).
- **OpenLIT** e **Laminar** (Apache-2.0) exigem Docker + ClickHouse.

## Telemetria agregada (a mostrar no dashboard)

- Cota e consumo por perfil, por provedor, por cenário, por papel e por peça.
- Custo da orquestração (sessões do Diretor) separado do custo dos Executores, para o critério de sucesso 8 de [00](00-OBJETIVO.md) e a Q14.
- Taxas de retentativa, de falha por tipo e de aprovação do Crítico, por Executor.
- Tempo por etapa e por peça.
- Custo em moeda é a decisão N10: em assinaturas, só o uso relativo da cota; em API, o custo real.

## Cuidados

- **Redação:** tokens e segredos nunca entram no log, no OTel nem no ATIF (§3).
- **Tamanho:** observações grandes (saídas de teste) são truncadas no evento. O conteúdo completo é guardado à parte e citado por referência (caminho, id, hash; §5.10).
- **Versão:** gravar a versão do esquema do evento e a do ATIF em cada arquivo.
- **Contratos:** os adaptadores ACP mudam rápido (risco R2), então é preciso fixar versões e ter testes de contrato com saídas gravadas.
