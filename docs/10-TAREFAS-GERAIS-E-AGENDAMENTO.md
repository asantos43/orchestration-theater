# 10. Tarefas gerais, recorrentes e agendadas

O sistema não é só para desenvolvimento de software. Exemplo-guia do dono: **consultar vários portais de notícias em paralelo, compilar um resumo de manchetes e enviar o resumo em HTML por e-mail**, de forma recorrente.

## Princípio: ferramenta primeiro, modelo por último

Cada agente em paralelo gasta cota de assinatura. Para o resumo de manchetes, a maior parte do trabalho **não precisa de agente**:

1. O núcleo busca os RSS ou as páginas por HTTP, **em paralelo, sem gastar cota**.
2. Extrai e normaliza (título, link, hora, portal) com código.
3. O **modelo barato** só resume e agrupa (um passo, ou poucos).
4. O núcleo gera o HTML, valida e higieniza.
5. O núcleo envia o e-mail com destinatário e remetente fixos.

Fan-out de **agentes** só existe quando o passo exige julgamento (por exemplo, páginas sem RSS que pedem leitura inteligente).

## Fluxo declarativo (proposta)

Uma tarefa é uma definição com passos, dependências e política:

```
tarefa: manchetes-diarias
agenda: todos os dias 07:30 (America/Sao_Paulo)
política:
  execução perdida: rodar ao voltar (no máximo 1 por dia)
  janela de cota: não rodar com a conta abaixo de 20 por cento
  tempo máximo: 10 min
passos:
  - buscar: paralelo, ferramenta web própria, fontes = [portal1, portal2, ...]   # sem modelo
  - normalizar: código
  - resumir: modelo barato, ferramentas = nenhuma, entrada = itens normalizados
  - montar_html: código (modelo opcional para o texto)
  - validar_e_higienizar: código
  - enviar_email: ferramenta própria do núcleo, destinatário fixo
```

O mesmo formato descreve os fluxos de desenvolvimento do diagrama (Autor, Revisor, Roteirista, Diretor, Atores, Crítico), com passos de agente, retentativas e roteamento por tipo de erro.

## Agendador

- Mora no **daemon**, que precisa rodar como **serviço do sistema** mesmo com o app fechado: launchd (macOS), Agendador de Tarefas ou serviço (Windows), systemd (Linux). O app de desktop é só um cliente.
- **Execução perdida** (computador dormindo ou desligado): políticas `rodar ao voltar`, `pular` e `juntar`.
- **Concorrência**: limite de execuções simultâneas por conta, por projeto e global.
- **Janela de cota**: cada tarefa declara quando pode rodar e em que conta; o broker respeita.
- **Retentativas e backoff** por tipo de erro; falha de autenticação pausa e avisa em vez de insistir.
- Histórico de execuções, duração, custo de cota e resultado, no dashboard.

## Outros usos já mencionados ou naturais

- Relatórios periódicos de um projeto (estado das demandas, cotas, falhas).
- Monitorar um site ou repositório e avisar de mudanças.
- Rotinas de manutenção do próprio sistema (rotacionar logs, checar logins, avisar renovação de token).

## Pontos de atenção

- **Segurança**: ver [09](09-ISOLAMENTO-E-SEGURANCA.md): leitura da web e envio ficam em passos e identidades separados.
- **Termos**: automação recorrente sobre assinatura é o ponto mais sensível ([07](07-ASSINATURAS-E-TERMOS.md)). Quanto mais passos forem código e não modelo, menor o consumo e o risco.
- **Alternativa já existente**: o Claude Code tem rotinas e agendas próprias (`CronCreate`, `RemoteTrigger`, a skill `schedule`). Elas servem à alternativa de continuar com o harness existente ([06](06-ALTERNATIVA-HARNESS-EXISTENTE.md)), mas não têm política de cota, segredos por tarefa nem a separação leitura e envio.
