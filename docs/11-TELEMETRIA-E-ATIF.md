# 11. Telemetria e trajetórias (ATIF)

## O que se quer

- Acompanhar a trajetória de cada agente **em tempo real**.
- **Telemetria completa**: eventos, uso de tokens, custo de cota por conta, duração, resultado de cada passo.
- Trajetórias **exportáveis em ATIF**.

## ATIF (Agent Trajectory Interchange Format)

**Fonte secundária; a RFC não foi aberta.** Segundo a documentação consultada em 2026-11-08:

- A especificação mora numa RFC do framework **Harbor** (Laude Institute), em `docs/rfcs/0001-trajectory-format.md` do repositório `laude-institute/harbor`.
- A versão atual seria a **1.7**; o Harbor aceita da 1.0 à 1.7. A 1.7 traz subagentes embutidos, id por trajetória e `llm_call_count`. Uma biblioteca (`vtcode-exec-events`) implementa a 1.4, ou seja, está atrás.
- Estrutura: ids de passo sequenciais a partir de 1; passos do agente podem trazer chamadas de ferramenta, resultados (observações) e métricas por passo.
- Os modelos do Harbor (Pydantic, `harbor.models.trajectories`) **rejeitam campos não declarados**; metadados próprios precisam ir nos campos de extensão do esquema.
- Arquivo `.json` para ATIF e `.jsonl` para o formato nativo; ao converter para o formato de outro agente, perdem-se detalhes específicos de sessão.
- Agentes que declaram suporte gravam `agent/trajectory.json` no resultado de um trial.

**Antes de gravar código:** ler a RFC, fixar a versão do ATIF a emitir e decidir onde ficam os campos próprios (conta, cota, worktree, papel).

## Tempo real versus arquivo

O ATIF é um **arquivo por trajetória**; o acompanhamento ao vivo pede outra coisa. Desenho natural:

1. Cada adaptador converte os eventos do cliente para um **formato interno de eventos**, em ordem, e os grava num **log que só cresce** (append-only).
2. O dashboard lê o log (por SSE ou WebSocket) e mostra a trajetória viva.
3. O **ATIF é gerado a partir do log**, ao vivo (arquivo parcial) ou ao fim, como exportação para avaliação e arquivo.

## Formato interno de eventos (proposta, a detalhar)

Tipos mínimos, todos com: id, tempo, projeto, tarefa, papel, agente, conta, sessão.

| Evento | Conteúdo |
|---|---|
| `mensagem` | Papel (usuário, agente, sistema) e texto |
| `ferramenta` | Chamada (nome, argumentos redigidos) |
| `observação` | Resultado da ferramenta (truncado, redigido) |
| `permissão` | Pedido, decisão do núcleo e a regra que decidiu |
| `uso` | Tokens de entrada e saída, cache, modelo, esforço, duração |
| `cota` | Estado da cota da conta antes e depois |
| `fluxo` | Mudança de estado (passo iniciado, retentativa, roteamento por erro, aprovado, escalado) |
| `verificação` | Comando, código de saída, resumo de testes e mutações |
| `erro` | Tipo (autenticação, cota, sandbox, tempo, laço sem progresso, falha de ferramenta) |
| `artefato` | Arquivo gerado, diff, commit, PR |

O **tipo de erro** é o que alimenta o roteamento do diagrama (P5, P6) e as estatísticas de qualidade por ator (medir erro e retrabalho por executor era um desejo anterior do dono).

## Telemetria agregada

- Cota e consumo por conta, por provedor, por projeto, por papel e por tarefa.
- Custo da orquestração (chamadas do orquestrador) separado do custo dos executores: serve ao critério de sucesso 8 de [00](00-OBJETIVO.md).
- Taxas de retentativa, de falha por tipo de erro e de aprovação do crítico, por executor.
- Tempo por passo e por ciclo completo.

## Cuidados

- **Redação**: tokens e segredos nunca entram no log nem no ATIF.
- **Tamanho**: observações grandes (saídas de teste) são truncadas no evento, com o conteúdo completo guardado à parte, por referência.
- **Versão**: gravar a versão do esquema do evento e a do ATIF em cada arquivo, para migrar depois.
- **Não depender do formato do cliente**: os CLIs mudam o formato de saída por versão; os adaptadores têm testes de contrato com saídas gravadas.
