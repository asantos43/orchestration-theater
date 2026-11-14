# 10. Tarefas gerais, recorrentes e agendadas

Este documento tem duas partes:
- o **agendador** como a arquitetura o descreve (§5.15, Fase 9b, riscos R13 e R14), de 2026-11-13, **não verificado localmente**;
- as **tarefas gerais**, que não são desenvolvimento de software, e os exemplos-guia do dono. Desde a v0.14 (2026-11-13), elas são cenários do tipo **tarefa** (arquitetura §5.20, decisão N3).

## Agendador (arquitetura §5.15)

O daemon dispara peças sozinho, no horário: o agendador age como se o Produtor tivesse escrito a necessidade no chat. **Não há pipeline novo.** A peça agendada passa pela mesma máquina de estados, seleção de Executores, permissões e eventos de qualquer outra.

### Tarefa agendada = modelo de peça

Fica guardada na tabela `schedules` e tem:
- cenário, com o projeto e a branch base;
- o texto da necessidade;
- overrides opcionais de Executores por papel, limites e timeout;
- **política de entrega:** PR por padrão. Merge direto só se o projeto permitir **e** a tarefa pedir;
- **orçamento por execução:** teto de tempo e, para perfis de API, de custo. Se estourar, a peça para e notifica.

### Tipos de agendamento

| Tipo | Exemplo | Observação |
|---|---|---|
| Uma vez | 20/11 às 22h | Sai da lista depois de rodar e fica no histórico |
| Por calendário | cron `0 7 * * 1-5`, fuso `America/Sao_Paulo` | O fuso é sempre explícito |
| Por intervalo | a cada 6 h | Conta a partir do fim da execução anterior |
| Logo após o reset da cota | "depois do próximo reset de claude-empresa" | Usa o `resetsAt` das sondas de cota ([08](08-CLIENTES-CLI-REFERENCIA.md)) |

A biblioteca é o **croner** (licença MIT **[a confirmar]**). O próximo disparo de cada tarefa fica gravado no SQLite e sobrevive a reinícios.

### Regras por tarefa

| Situação | Padrão |
|---|---|
| Execução perdida (máquina desligada ou daemon parado) | Rodar uma vez, se o atraso for menor que a janela configurada (padrão 12 h); senão, pular e registrar |
| Sobreposição com a execução anterior | Pular e registrar |
| Cota esgotada nos Executores do papel | Adiar até o reset, dentro de um prazo máximo |
| Decisão do Produtor sem ninguém olhando | Pausar e notificar |

Os valores padrão foram decididos em 2026-11-14 (**N13** em [13](13-DECISOES-EM-ABERTO.md)). São chaves de configuração `schedule.*`, com override por tarefa e três predefinições:
- `balanced`, o padrão: roda a execução perdida se o atraso for até 12 h; adia por cota até 6 h e depois pula e notifica; espera a decisão 24 h e depois cancela e registra; orçamento de 1 h e, em API, US$ 5;
- `conservative`: 2 h, 2 h, 4 h, 30 min e US$ 2;
- `relaxed`: 24 h, até o reset, sem prazo, 2 h e US$ 10.

### Notificações

O agendador notifica quando a tarefa termina, falha, pausa ou pede decisão:
- sempre no chat do cenário e como evento `schedule.*`;
- como notificação do sistema operacional, quando houver sessão gráfica;
- por e-mail, webhook ou chat corporativo, via plugin ([09](09-ISOLAMENTO-E-SEGURANCA.md), §5.14).

### Máquina dormindo (risco R14)

O daemon sozinho não acorda a máquina. Além disso, o Modern Standby do Windows estrangula processos em segundo plano. A arquitetura toma duas medidas:

1. **Acordar no horário.** Ao salvar a tarefa, o daemon registra um gatilho no agendador do sistema operacional, que chama `ot run <task>`:
   - Windows: Agendador de Tarefas, com "despertar o computador";
   - macOS: launchd + `pmset`;
   - Linux: timer do systemd com `WakeSystem=`.
2. **Manter acordada durante a execução.** O pedido de energia é liberado ao fim da peça:
   - Windows: `SetThreadExecutionState` + Power Request;
   - macOS: `caffeinate`/IOPMAssertion;
   - Linux: inibidor do systemd-logind.

**Máquina desligada ou religada sem login** (arquitetura §5.21, decidido em 2026-11-13): o gatilho acorda a máquina suspensa, mas não liga uma máquina desligada. Na v1, depois de uma queda de energia, nada roda até o usuário fazer login. No login, o daemon faz a reconciliação e a regra da execução perdida decide o que roda. O daemon completo sem login é a Fase 10b, logo depois da v1 (decidido em 2026-11-14, N21), e começa por medir se os clientes fazem login sem sessão aberta.

### Criação e controle

- **Aba Agenda** na TUI (e na web, se existir).
- **Pelo chat.** O Diretor chama `schedule(...)`, que **não salva direto**: devolve um rascunho para o Produtor confirmar, editar ou cancelar. `list_schedules` e `pause_schedule` completam o conjunto.
- **Pelo terminal:** `ot schedule list|add|pause|resume|rm` e `ot run <task>`.

**"Rodar até os testes passarem" não é agendamento.** Isso já é o ciclo de correção do pipeline (Crítico → correção, com os limites `Nc` e de tentativas).

## Tarefas gerais: o exemplo das manchetes

O sistema não é só para desenvolvimento de software. O exemplo-guia do dono, registrado em 2026-11-08, é **consultar vários portais de notícias em paralelo, compilar um resumo das manchetes e enviar o resumo em HTML por e-mail**, de forma recorrente.

### Ferramenta primeiro, modelo por último

Esse princípio, que é o R13 em [00](00-OBJETIVO.md), corresponde aos P3 e P8 da arquitetura. Para as manchetes, a maior parte do trabalho **não precisa de agente**:
1. buscar os RSS ou as páginas por HTTP (casca `http_get` com domínios permitidos, ou um plugin de feeds), em paralelo e sem gastar cota;
2. extrair e normalizar título, link, hora e portal com código;
3. o **modelo barato** só resume e agrupa;
4. gerar, validar e higienizar o HTML com código;
5. enviar o e-mail por um **plugin** com destinatário fixo. A credencial fica no plugin (`secrets` do manifesto), nunca com o agente.

### Como se encaixa na arquitetura (§5.20, decidido em 2026-11-13)

Até a v0.13, a arquitetura modelava toda tarefa agendada como uma **peça** completa (Autor → Revisor → Roteirista → Atores → Crítico), o que era pesado para um resumo diário. A N3 resolveu isso com o cenário do tipo **tarefa**, que separa a definição da execução:
- **Definição versionada**, desenhada uma vez pelos papéis no fluxo `task.define`:
  1. o Autor escreve o plano a partir da conversa;
  2. o Revisor revisa;
  3. o Roteirista transforma o plano em passos;
  4. os Atores escrevem os scripts dos passos de código;
  5. o Crítico faz o **ensaio** com dados de exemplo.

  Depois, o Produtor aprova. O Diretor fica leve e só coordena, como o dono pediu. A seleção escolhe o melhor Executor para cada papel.
- **Execução** pelo motor de passos (`task.run`), sem planejamento a cada vez. O Diretor só é chamado se um passo falhar ou pedir decisão.
- **Passos tipados:**
  - `code`: sem modelo;
  - `model`: chamada com schema;
  - `agent`: demanda para um Ator;
  - `approval`;
  - `delivery`: por plugin ou notificação.
- **Gatilhos:** manual e os tipos do agendador na v1; eventos (arquivo novo, webhook, e-mail recebido, mudança de página) depois.

O fluxo declarativo proposto em 2026-11-08 virou a definição da tarefa:

```
task: daily-headlines
trigger: todos os dias 07:30 (America/Sao_Paulo)
steps: fetch (code) → normalize (code) → summarize (model, barato)
       → build_html (code) → validate (code) → send_email (delivery, plugin)
```

O segundo exemplo do dono, de 2026-11-13, segue o mesmo formato:

```
task: daily-consolidation
steps: download (code) → unzip (code) → extract (code; agent se o formato mudar)
       → build_spreadsheet (code) → package (code) → send (delivery: e-mail ou Telegram, plugin)
```

Um trabalho recorrente que pertence a um repositório continua sendo uma peça agendada do projeto (§5.15). Um chat de prototipação pode ser **promovido** a tarefa quando o Produtor decide repeti-lo.

### Outros usos mencionados

- Relatórios periódicos de um projeto (estado das peças, cotas, falhas).
- Monitorar um site ou repositório e avisar de mudanças.
- Rotinas de manutenção do próprio sistema (checar logins, avisar renovação).
- Na arquitetura: "atualizar dependências e corrigir o que quebrar", como tarefa de projeto entregue por PR.

## Pontos de atenção

- **Segurança:** a leitura da web e o envio ficam separados ([09](09-ISOLAMENTO-E-SEGURANCA.md)).
- **Termos:** automação recorrente sobre assinatura é o ponto mais sensível ([07](07-ASSINATURAS-E-TERMOS.md), pergunta 2). Quanto mais passos forem código e não modelo, menor o consumo e o risco.
- **Cota interativa:** uma tarefa agendada pode gastar a cota que o dono usaria de dia (R13). Agendar para logo após o reset e adiar quando esgotado são as mitigações.
- **Alternativa já existente:** o Claude Code tem rotinas e agendas próprias (`CronCreate`, `RemoteTrigger`, a skill `schedule`). Elas serviriam à alternativa de continuar com o Claude Code + `okit` (antigo documento 06, apagado em 2026-11-13), mas não têm política de cota, segredos por tarefa nem a separação entre leitura e envio.
