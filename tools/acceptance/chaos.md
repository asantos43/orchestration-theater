<!-- SPDX-License-Identifier: MPL-2.0 -->

# Roteiro de caos do dono (nível manual) [proposta]

Roteiro da Fase 11 (P11, `docs/23-PLANO-DA-FASE-11.md`). A CI já quebra o daemon de propósito, com `kill -9` em
pontos nomeados, falhas injetadas e o censo de processos (`packages/daemon/src/chaos/`, P1 a P7). Este roteiro é
o mesmo teste feito **com a sua mão**: você derruba o daemon, para um Executor, enche um volume, tira o provedor
do ar, e um comando (`check`) diz `ok` ou `falhou: <motivo>` para cada invariante, do I1 ao I8, os mesmos do
harness (`invariants.ts`, `census.ts`). Nenhuma verificação foi escrita de novo: o verificador importa o harness.

**Aceite do passo:** o dono roda o roteiro numa máquina e todos os invariantes dão `ok` (tabela do fim).

Quem passar o roteiro troca os `[N]` da tabela do fim por `[V: <data>]` (passou) ou `[X: <o que falhou>]`
(falhou). Não conserte na hora: anote o que apareceu.

## O que ele faz e o que nunca faz

- Sobe um daemon de teste (`tools/acceptance/chaos-daemon.mjs`) com o `fake-agent` no lugar dos clientes, numa
  pasta temporária (`$TMPDIR/otheater-chaos-roteiro.XXXXXX`): `HOME`, dados, repositório, remote e hospedagem
  de código falsos. O relógio é o real e o cofre é de memória.
- **Nunca** usa o seu `HOME`, o chaveiro, um cliente de verdade (Claude Code, Codex, OpenCode), rede, `sudo` ou
  um serviço instalado. Os três clientes oficiais ficam desligados no `config.yaml` (`clients.<id>.enabled:
  false`) e o daemon não instala adaptador (`clients.adapters.install: off`): nada é baixado.
- **Nunca** mata um processo que não seja dele. O `stop` encerra o daemon pelo pid que gravou e o que sobrou da
  execução pelo **censo** (a pasta única da execução na linha de comando, no cwd ou no ambiente do processo),
  nunca por nome. O `stop` só apaga a pasta que tem a marca do roteiro e fica sob `$TMPDIR`.
- O estado fica numa pasta que só o script conhece (o ponteiro é `$TMPDIR/otheater-chaos-roteiro-<uid>.current`);
  o script não exporta nada para o seu shell.

## Antes de começar

- **Linux** com `node` 24 ou mais, `git` e o repositório compilado (`pnpm install --frozen-lockfile` e `pnpm
  build`). O Node 24 lê os fontes `.ts` do harness sem compilar; o `chaos-ts-hook.mjs` só liga o `./x.js` ao
  `./x.ts` quando o `.js` não existe (o harness é código de teste e não vai para o `dist`).
- Para o cenário do disco cheio: `unshare` e `nsenter` (util-linux) e o usuário poder criar um *user
  namespace* (padrão no Fedora e no Ubuntu recente). **Não precisa de root nem de `sudo`**: o volume pequeno é
  um `tmpfs` montado dentro de um *namespace* só dele (veja o passo 4).
- **macOS e Windows:** o roteiro **não roda** [N]. O censo de processos lê `/proc`, e o script recusa um
  `uname` que não seja Linux. No macOS os comandos `kill -9` e `kill -STOP` existem e o daemon e o `fake-agent`
  rodam, mas o censo e o volume por `unshare` não [N]; no Windows não há `kill -STOP` nem `setsid` [N]. A CI já
  cobre os três sistemas com a simulação (D1/N278, abaixo).
- Um terminal para os comandos. Os comandos abaixo partem da raiz do repositório.

```
tools/acceptance/chaos.sh help        # a lista dos comandos
tools/acceptance/chaos.sh steps       # os cenários; `steps 3` mostra um, com os pids de agora
```

Os comandos: `start`, `steps`, `status`, `plays`, `play`, `chat`, `provider`, `fill`, `free`, `plan`, `restart`,
`events`, `check`, `stop`. Um `check` depois de cada cenário; um `stop` ao fim (ou antes de um `start` com outras
opções: só há uma execução por vez).

## Como ler o `check`

```
tools/acceptance/chaos.sh check [--wait 90] [--allow DONE,...]
```

Imprime uma linha por invariante e, no fim, `ok` (saída 0) ou `falhou: <motivo>` (saída 1). Ele espera até
`--wait` segundos para todo play estar num estado de `--allow` (padrão `DONE`).

| Invariante | O que garante |
| --- | --- |
| I1 | o armazém e a telemetria passam no `quick_check` do SQLite (e cada cópia de backup, no `integrity_check`) |
| I2 | nada confirmado se perdeu: todo evento e efeito que o daemon viu confirmado (o livro `ledger.jsonl`, gravado antes) está no armazém |
| I3 | nenhum processo da execução anterior sobrou depois da recuperação (o censo que o `restart` tirou) |
| I4 | nenhum efeito externo em dobro: no diário da hospedagem de código, no máximo um PR e um merge por par (head, base) e um push efetivo por branch |
| I5 | nenhum efeito colateral ficou `pending` ou `ambiguous` sem o Produtor ser perguntado (ou foi resolvido, ou tem uma decisão `recovery_effect`) |
| I6 | todo play terminou (ou está num estado de `--allow`), `daemon.recovered` saiu uma vez por subida e a mesma mensagem de sistema não saiu duas vezes |
| I7 | nada temporário sobrando: `.partial`, `.tmp`, `.new`, `-journal` (com o `daemon.lock-journal` permitido enquanto o daemon vive, como no `app-update.chaos.test.ts`) |
| I8 | o log de eventos não perdeu evento confirmado e o `restart` não escreveu o mesmo evento duas vezes |

Um `falhou` é um resultado, não um defeito do roteiro. Antes de anotar `[X]`, rode `status` e `events 40` e anote
o que o daemon fez. O `check` lê o armazém em modo só leitura e pode rodar com o daemon vivo ou parado.

## Os cenários

Em cada um: **faça** o comando, **espere** o efeito, rode `check`. Os pids que `status` mostra (`daemon`,
`cliente ... executor`, `cliente ... diretor/conversa`) são os que você passa ao `kill`. Todos os cenários abaixo
foram rodados no Linux do desenvolvimento [V: 2026-11-24]; veja a tabela do fim.

### 1. Queda do daemon com um play em curso

1. `tools/acceptance/chaos.sh start`
2. `tools/acceptance/chaos.sh play hold` (um Executor vivo, parado esperando; o `hold` zera o contador do
   `fake-agent`, então vale a cada rodada).
3. `tools/acceptance/chaos.sh status`: anote o pid do `daemon` e o do `cliente ... executor`; o play está em
   `EXECUTING`.
4. `kill -9 <pid do daemon>`
5. `tools/acceptance/chaos.sh restart`: ele tira o censo do que a queda deixou vivo (os dois clientes órfãos,
   porque o `fake-agent` sobrevive ao fim da conexão como um cliente de verdade), sobe o daemon de novo sobre
   os mesmos dados e a reconciliação roda.
6. `tools/acceptance/chaos.sh check`

**Esperado:** o `restart` diz `2 processo(s) da execução anterior ainda vivos`; o evento `daemon.recovered` traz
`orphansKilled: 2`; o play vai a `DONE`; `check` termina em `ok`.

### 2. Queda da árvore inteira

Como o cenário 1, mas no passo 4 mate o daemon **e** os clientes juntos: `kill -9 <daemon> <executor>
<diretor/conversa>`.

**Esperado:** o `restart` diz `0 processo(s) da execução anterior ainda vivos`; o play volta e termina; `check`
dá `ok`.

### 3. Executor parado (`kill -STOP`)

Precisa de `start --stuck 30s` (o padrão é `10m`, para não atrapalhar os outros cenários; a chave é
`resume.stuck.no_event_for` do `config.yaml`).

1. `tools/acceptance/chaos.sh start --stuck 30s` e `play hold`.
2. `status`; `kill -STOP <pid do executor>`.
3. Espere uns 40 segundos. Rode `status` e `events 6`.
4. `tools/acceptance/chaos.sh check --wait 5 --allow EXECUTING`

**Esperado:** o evento `session.interrupted` com `cause: stuck` e `detail: no event for 30000 ms`, seguido de
`session.closed` (`reason: interrupted`) e `session.handoff_failed`; o `cliente ... executor` **some** do
`status` (o daemon o encerrou, mesmo parado) e não sobra processo. Só há um perfil de Executor no roteiro, então
não há para quem passar o bastão: o play fica em `EXECUTING`, esperando você (por isso o `--allow EXECUTING`).
Os invariantes dão `ok`. Sem o `--allow`, o `check` mostra `falhou: ... play ... is EXECUTING (expected DONE)`:
é como se vê que o `check` falha quando deve (rodado assim [V]).

### 4. Disco cheio

Precisa de `start --volume 8m`. O script monta um `tmpfs` de 8 MB **sobre a pasta de dados** dentro de um
*namespace* de usuário e montagem só dele (`unshare -rm`, sem `sudo`); um processo `sleep` guarda o *namespace*
enquanto você mata e sobe o daemon, e o `nsenter` roda o daemon, o `dd`, o `df` e o verificador dentro dele. Os
dados ficam **só** nesse volume, e somem ao `stop`. O daemon sobe com `disk.min_free: 1MB` e `disk.check_every:
1s` (o padrão do produto é `256MB` e é maior que o volume). Fora do *namespace* o `ls` da pasta de dados aparece
vazio: use os comandos do script.

1. `tools/acceptance/chaos.sh start --volume 8m` e `play hold`.
2. `tools/acceptance/chaos.sh fill`: o `dd` termina com `No space left on device`, de propósito.
3. Espere uns 5 segundos. `status` mostra `disco ...: pausado=true estado=full`. `play` (um novo) volta com
   `"error": ...` e `"paused":true`: o daemon recusa trabalho novo.
4. `tools/acceptance/chaos.sh free`: apaga o lastro. Em poucos segundos `status` mostra `pausado=false estado=ok`.
5. `events 200`: procure os avisos `daemon.notice` `disk_full` e `disk_recovered`.
6. `tools/acceptance/chaos.sh play` (um play novo, sem `hold`): ele termina.
7. `tools/acceptance/chaos.sh check --allow DONE,EXECUTING` (o play do `hold` segue parado).

**Esperado:** o daemon **não cai** e não corrompe o armazém; ele pausa (`paused`), avisa (`disk_full`; o evento só
entra no log depois que há espaço, porque com o disco cheio nada se grava) e volta sozinho (`disk_recovered`);
`check` dá `ok`. A mesma ideia sem montar nada: `start --plan fail-log` injeta `ENOSPC` na escrita do log; o
daemon entra em disco cheio, o Diretor recusa o play com `disk_full`, e o espaço volta em ~30 s (`disk_recovered`).
Um play novo depois disso termina.

### 5. Provedor fora do ar ou rede cortada

O `fake-agent` não usa rede; o roteiro troca o *script* dele nos **próximos** clientes que o daemon abrir
(`provider-mode`): `down` é o erro transitório que os três clientes normalizam (`529 overloaded`, rede caída),
`quota` é cota esgotada e `auth` é login perdido. Um cliente que já roda não é tocado.

1. `tools/acceptance/chaos.sh start`
2. `tools/acceptance/chaos.sh provider down`
3. `tools/acceptance/chaos.sh play`: o Diretor responde com `[Overloaded: API Error 529 overloaded_error]` e a
   conversa recebe a mensagem `director_failover` (`outcome: unavailable`); nenhum play nasce (`plays` diz
   `nenhum play`).
4. `tools/acceptance/chaos.sh provider ok` e `play` de novo.
5. `tools/acceptance/chaos.sh check`

**Esperado:** o daemon não cai nem repete trabalho; com o provedor de volta o play (e o que ficou na fila)
termina em `DONE`; `check` dá `ok`. Um corte de rede **de verdade** (desligar o Wi-Fi com um cliente real) não
cabe aqui, porque o roteiro nunca usa cliente real nem rede [N].

### 6. Ponto de queda do plano de falhas

`start --plan crash-push` carrega o plano `{"crash":[{"point":"effects.after_execute","detail":"git_push","nth":1}]}`:
o próprio daemon se mata (SIGKILL, com `CRASHPOINT <json>` no `daemon.log`) logo depois de empurrar o branch do
play, antes de registrar o resultado. `crash-commit` mata no 40º commit do armazém (no meio do play). Um plano
seu vai em `--plan <arquivo.json>` (o formato é o de `packages/daemon/src/chaos/faults.ts`).

1. `tools/acceptance/chaos.sh start --plan crash-push`
2. `tools/acceptance/chaos.sh play`; espere uns 20 segundos. `status` diz `daemon: não está vivo`, e o
   `daemon.log` da execução tem a linha `CRASHPOINT`.
3. `tools/acceptance/chaos.sh plan none`: **o plano conta por processo**, então o daemon novo cairia de novo no
   mesmo ponto (com o `crash-commit`, no 40º commit; com o `crash-push`, não, porque o push já está no diário).
4. `tools/acceptance/chaos.sh restart`; espere uns 15 segundos.
5. `tools/acceptance/chaos.sh check`

**Esperado:** o play termina em `DONE`, sem push nem PR em dobro (I4) e sem commit perdido (I2); `check` dá `ok`.
Se o ponto cair antes de o daemon subir (`--plan` com `store.before_commit` num `nth` pequeno), o `start` imprime
`o daemon se matou antes de subir` e o resto é igual (`plan none`, `restart`).

**Achado, a decidir (rodado [V], `crash-commit` sem trocar o plano):** se você derruba o daemon duas vezes
seguidas com o mesmo play no ar (aqui, o plano ainda armado no `restart`), as duas recuperações escrevem a mesma
mensagem `scenario.system_message` (`kind: recovery`, `resumed: [play ...]`), e o `check` diz
`I6: the scenario ... got the same message twice` e `I8: event N (scenario.system_message) repeats event M`.
Pode ser defeito do produto (a recuperação não deveria repetir a mesma mensagem) ou rigor demais do invariante
para duas quedas seguidas, onde cada recuperação diz a verdade; o roteiro não decide, só mostra (pergunta ao
dono no PR).

### 7. Atualização interrompida [N]

Não há como fazer à mão neste roteiro [N]. As atualizações do aplicativo e do adaptador (P6, P7:
`app-update.chaos.test.ts`, `adapter-update.chaos.test.ts`) dependem de artefatos de um release (executável,
assinatura, pacote do adaptador) e a Fase 10 ainda não publicou um; o roteiro também não baixa nada. Esses dois
cenários rodam na CI e passam a ser do P12 (sobre o executável da Fase 10).

### Não coberto, de propósito

- **Queda de energia** (corte do `fsync`, SQLite com a página rasgada): só em teste automático (P3,
  `torn-store.ts`); não há queda de energia que se faça à mão sem VM. Decisão D1 (N278): simulação na CI; a VM
  (QEMU e uma imagem baixada) só entra, se o dono pedir, no aceite do P12; **nenhuma VM e nenhum download neste
  passo**.
- A tarefa agendada (D8): fica para a Fase 9b.

## Ao fim

```
tools/acceptance/chaos.sh stop
```

Encerra o daemon (SIGTERM; SIGKILL se não parar em 20 s), mata o que sobrou da execução (o censo), encerra o
volume pequeno e apaga a pasta e o ponteiro; `stop --keep` mantém a pasta para você olhar (apague depois). Sem
parar, o daemon termina sozinho em 120 minutos (`start --minutes <n>` muda o prazo).

Os valores desta execução são chaves do `config.yaml` da pasta de teste (as do produto: `resume.stuck.no_event_for`,
`resume.transient_backoff`, `disk.min_free`, `disk.check_every`, `faults.inject`, `faults.plan_file`); a pasta e o
arquivo estão no `start`. Edite entre um `kill` e um `restart` para tentar outro valor.

## Tabela de resultados

`[V: <data>]` passou, `[X: <o que falhou>]` falhou, `[N]` não rodado, `[-]` não se aplica. A coluna "Dev" é o
Linux do desenvolvimento (rodado por quem escreveu o roteiro); a do dono fica `[N]` até ele rodar.

| Cenário | Dev (Linux) | Dono |
| --- | --- | --- |
| 1. Queda do daemon com play em curso | [V: 2026-11-24] | [N] |
| 2. Queda da árvore | [V: 2026-11-24] | [N] |
| 3. Executor parado (`kill -STOP`) | [V: 2026-11-24] | [N] |
| 4. Disco cheio (`tmpfs` sem root, e `fail-log`) | [V: 2026-11-24] | [N] |
| 5. Provedor fora do ar | [V: 2026-11-24] | [N] |
| 6. Ponto de queda (`crash-push`, `crash-commit`, queda antes de subir) | [V: 2026-11-24] | [N] |
| 6. Duas quedas seguidas no mesmo play | [X: I6 e I8, mensagem repetida; achado acima] | [N] |
| 7. Atualização interrompida | [N] | [N] |
| macOS e Windows | [N] | [N] |
| Corte de rede de verdade | [N] | [N] |
| Queda de energia (VM) | [N: D1, só no P12 se o dono pedir] | [N] |

Quando o roteiro for passado, o resultado (e o que sair `[X]`) vai para o PR do passo seguinte ou para um registro
do orquestrador; este arquivo guarda só o roteiro e a tabela.
