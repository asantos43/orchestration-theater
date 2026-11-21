# Arize Phoenix (opcional): receita

Este documento é a receita para quem quiser ver as trajetórias e os traces do OTheater no Arize Phoenix, um visualizador gráfico de traces que a pessoa instala por conta própria (arquitetura §5.11 e §6.2; Fase 8, P12). **O OTheater não instala, não baixa, não embute nem distribui o Phoenix, e nenhum teste do repositório o executa.** Tudo o que se diz abaixo sobre o Phoenix vem da documentação e do código públicos dele, lidos em 2026-11-21 e **nunca executados aqui**.

Legenda:
- **[V]**: conferi no código do OTheater, neste repositório, em 2026-11-21.
- **[S]**: fonte secundária, a documentação ou o código público do Phoenix ou de outro projeto, com a fonte e a data (2026-11-21). Nada foi executado.
- **[N]**: não confirmado.
- **[proposta]**: escolha minha, do dono decidir.

## Em resumo

1. **Importar um arquivo ATIF funciona e é o caminho recomendado.** O Phoenix tem um utilitário em Python que converte ATIF em spans e os envia ao servidor. Ele declara suporte ao ATIF v1.0 a v1.7, e o OTheater escreve v1.8; a versão acima da 7 só gera um aviso lá, e o que muda na v1.8 (campos de áudio) não é convertido. Se o arquivo do OTheater importa sem perda **não foi testado** **[N]**.
2. **Apontar o `telemetry.otlp.endpoint` direto para o Phoenix não funciona hoje.** O OTheater manda só OTLP/HTTP com JSON, e a rota `/v1/traces` do Phoenix, no código da `main`, só aceita `application/x-protobuf` e responde 415 ao resto **[S]**. O caminho possível é um OpenTelemetry Collector no meio, que recebe o JSON e reenvia em protobuf **[S]**; ele também é ferramenta externa, instalada pela pessoa.
3. O Phoenix só recebe traces por OTLP; o código dele não tem rota de métricas nem de logs OTLP **[S]**. No OTheater, ligue só o sinal `traces`.

## Licença e o que o OTheater faz e não faz

- O Phoenix é licenciado sob a **Elastic License 2.0 (ELv2)**, source-available, e não uma licença aprovada pela OSI **[S: github.com/Arize-ai/phoenix, README e LICENSE, 2026-11-21]**. Em resumo, a licença proíbe oferecer o software a terceiros como serviço hospedado ou gerenciado que dê acesso a boa parte das funções dele, burlar ou adulterar o sistema de chaves de licença e remover os avisos de direitos autorais ou de licença **[S: LICENSE do repositório, 2026-11-21; o resumo é meu, leia o texto]**. O repositório tem também um `IP_NOTICE` sobre patentes **[S: github.com/Arize-ai/phoenix, 2026-11-21]**.
- A decisão do dono é aceitar o Phoenix **só como ferramenta local opcional, nunca embutida nem distribuída** (arquitetura §6.0 e §6.2; nível C: processo separado, instalado à parte) **[V: texto da arquitetura]**. O uso local, na própria máquina, é o que esta receita descreve. Isto não é aconselhamento jurídico: quem quiser usar o Phoenix de outro modo deve ler a ELv2.
- O OTheater não tem o Phoenix como dependência, não o baixa, não o inicia e não o menciona no código nem nos testes **[V: busca no repositório em `packages/`, `tools/` e `.github/`; só há texto em `docs/`]**. Quem instala, atualiza e executa o Phoenix é a pessoa; os comandos abaixo são dela.
- Instalar o Phoenix e o cliente Python dele é fora do OTheater: o servidor sobe com `phoenix serve` depois de `pip install arize-phoenix`, ou com `uvx arize-phoenix serve` **[S: README do repositório, 2026-11-21]**; o pacote do cliente é o `arize-phoenix-client`, que exige Python 3.11 ou mais novo **[S: `packages/phoenix-client/pyproject.toml`, 2026-11-21]**.

## O que o OTheater manda

**[V]** `packages/daemon/src/config.ts` (blocos `telemetry.export` e `telemetry.otlp`), `packages/daemon/src/telemetry/otlp-encode.ts` e `otlp-exporter.ts`.

- Só **OTLP/HTTP com corpo JSON** (`Content-Type: application/json`). Não há protobuf nem gRPC, e a configuração recusa `http/protobuf` e `grpc` em `telemetry.otlp.protocol` com mensagem clara (N211). É código próprio, sem pacote do OpenTelemetry.
- O `telemetry.otlp.endpoint` é a **URL base**; o exportador acrescenta `/v1/traces`, `/v1/metrics` e `/v1/logs` (sem barra dupla).
- Cada sinal (`traces`, `metrics`, `logs`) sai numa requisição própria e pode ser desligado em `telemetry.otlp.signals.<sinal>`.
- O que sai é o que a base `telemetry.sqlite` guarda, já com os segredos redigidos no recebimento (P2). O exportador lê a base por cursor; por isso `telemetry.enabled` precisa estar ligado.
- Resposta 401 ou 403 vira o motivo `unauthorized`; 429, 502, 503 e 504 são repetidos, conforme `telemetry.otlp.retry`; qualquer outro 4xx vira `rejected` e **não é repetido**, e um 5xx fora dessa lista vira `server_error`, também sem repetição. Depois das tentativas o lote é descartado (`on_failure: drop`), vai um aviso ao log e sai o evento `telemetry.export_failed`.
- Não há atributos OpenInference nos spans (as convenções são as do OTheater, `span-conventions.ts`). Como o Phoenix mostra spans sem esses atributos **não foi conferido** **[N]**.

## O que o Phoenix recebe

- **Porta e rota:** o servidor aceita OTLP por HTTP na mesma porta da interface, 6006 por padrão, em `/v1/traces`, e por gRPC na 4317; não usa a 4318 padrão do OTLP **[S: documentação de self-hosting do Phoenix, `arize.com/docs/phoenix/self-hosting/configuration`, via resultado de busca, 2026-11-21; a página em si respondeu 403 ao leitor automático]**.
- **Corpo:** no código da `main`, o tratador de `POST /v1/traces` só aceita `application/x-protobuf` (415 para outro tipo, inclusive `application/json`), decodifica gzip e deflate e responde 422 se o protobuf for inválido **[S: `src/phoenix/server/api/routers/v1/traces.py`, github.com/Arize-ai/phoenix, `main`, lido em 2026-11-21 por um leitor automático de páginas, não por mim linha a linha]**.
- O pedido de aceitar OTLP JSON está aberto (issue #14991 do Phoenix, aberta em 2026-08-01, com comentário de 2026-11-01 de alguém que diz que vai tratar do lado do servidor) **[S: github.com/Arize-ai/phoenix/issues/14991, 2026-11-21]**. Quando isso entrar numa versão, o apontamento direto passaria a servir; **a receita abaixo deve ser revista** nesse dia **[N: não sei em que versão entra]**.
- **Só traces:** o diretório de rotas v1 do servidor tem `traces.py` e `spans.py`, e nenhum arquivo de métricas ou logs OTLP **[S: listagem de `src/phoenix/server/api/routers/v1`, `main`, 2026-11-21]**.
- **Autenticação:** um Phoenix local não exige chave **[S: resultado de busca sobre a documentação do Phoenix, 2026-11-21; fonte secundária]**. Por isso a receita não usa `telemetry.otlp.headers`.
- A norma do OTLP diz que o servidor **deve** (SHOULD) aceitar protobuf e JSON na mesma porta, e que o gzip precisa ser aceito **[S: opentelemetry.io/docs/specs/otlp, 2026-11-21]**. Ou seja, o Phoenix não descumpre uma obrigação ao recusar o JSON.

## Receita 1 (recomendada): importar o arquivo ATIF

O OTheater exporta o ATIF e o Phoenix o importa. Não depende do OTLP.

**1. Exporte a peça no OTheater.** **[V: `packages/daemon/src/atif/command.ts`, `atif-config.ts`]**

- Por padrão o daemon já grava o arquivo ao fim de cada peça (`atif.export.on: play_end`), em `<pasta de dados>/trajectories/<peça>.atif.json` (`atif.export.dir`).
- Ou, à mão: `ot trajectory export <peça> --out <pasta>`. Com o daemon parado, o comando grava os arquivos de `atif.export.unit`; com o daemon rodando, pede a trajetória à rota `GET /v1/plays/:playId/atif` e só a unidade `play` está disponível.
- Use `atif.export.unit: play` (o padrão): um arquivo com o Diretor na raiz e cada tentativa em `subagent_trajectories`, ligada ao passo do Diretor por `subagent_trajectory_ref`. O schema que o OTheater escreve é o `ATIF-v1.8`.
- **Conteúdo e segredos:** com `atif.export.content: full` (padrão) o arquivo leva o conteúdo; os valores do cofre e as chaves secretas são sempre mascarados, mas o resto do texto da peça vai como está. Se o arquivo vai sair da máquina ou ser enviado a um Phoenix de outra pessoa, exporte com `--content redacted`.

**2. Importe no Phoenix**, com o cliente Python dele, em outro ambiente que não o do OTheater.

```python
import json
from phoenix.client import Client
from phoenix.client.helpers.atif import upload_atif_trajectories_as_spans

client = Client(base_url="http://localhost:6006")  # [N] nome do parâmetro não conferido
with open("<peça>.atif.json", encoding="utf-8") as arquivo:
    trajetoria = json.load(arquivo)

resposta = upload_atif_trajectories_as_spans(
    client, [trajetoria], project_name="otheater"
)
print(resposta)  # traz total_received e total_queued
```

O que a documentação diz do utilitário, todo **[S: documentação do cliente (`arize-phoenix.readthedocs.io/projects/client/api/helpers.html`) e `helpers/atif/__init__.py` e `_validate.py` da `main`, 2026-11-21]**:

- assinatura `upload_atif_trajectories_as_spans(client, trajectories, *, project_name, timeout=...)`; `trajectories` é uma lista de dicionários, e os pais vêm antes dos filhos externos;
- cada trajetória vira um span raiz de agente, os passos viram spans de iteração, e abaixo deles ficam os spans de LLM e de ferramenta; os subagentes ligados por `subagent_trajectory_ref` entram no trace do pai;
- suporta o ATIF v1.0 a v1.7; o docstring diz que os campos de áudio da v1.8 não são suportados; a validação aceita qualquer `ATIF-vX.Y` da versão maior 1, **avisa** quando o menor passa de 7 ("some fields may not be validated or converted") e **recusa** a versão maior 2 ou acima; campos desconhecidos, como o `extra.otheater` do OTheater, não são recusados;
- os ids são determinísticos, e o Phoenix **rejeita um lote com id de span que já existe**: importar o mesmo arquivo duas vezes no mesmo projeto falha;
- as entradas dos spans de LLM são reconstruídas a partir do contexto do ATIF, não são as requisições reais; sessões muito longas podem estourar o limite de tamanho de atributos;
- só traces; nada de avaliações.

Da versão do cliente: o utilitário existe desde o `arize-phoenix-client` 2.3.0, e a v1.7 com subagentes embutidos entra na 2.7.0 **[S: notas de versão do Phoenix de 2026-04-03 e de 2026-05-15, conhecidas só por resultado de busca porque as páginas responderam 403; fonte secundária]**. Use uma versão atual.

**Limites e dúvidas desta receita [N]:**
- Não testei o arquivo do OTheater no Phoenix. O que está acima é a leitura da documentação.
- Não sei se o aviso da v1.8 vira outra coisa que não um aviso em algum caso do OTheater. O exportador do OTheater não escreve áudio **[N: não conferi o código por esse ângulo]**.
- O ATIF do OTheater não guarda a entrada e a saída cruas das ferramentas, só título, estado e desfecho **[V: corpo do PR do P5, `extra.otheater.fidelity`]**; o Phoenix mostrará só isso.
- `atif.export.unit: play_files` gera um arquivo por tentativa mais o do Diretor; se for usá-lo, passe a lista com o Diretor primeiro **[N: não testado, nem se o utilitário os junta num trace]**.

## Receita 2 (opcional): o OTLP ao vivo, por um Collector

Só vale a pena se você quer os spans do daemon no Phoenix conforme acontecem. Como o Phoenix recusa JSON, entre os dois fica um **OpenTelemetry Collector**, que a pessoa instala por conta própria e que o OTheater também não instala nem inicia.

**1. Collector** (um trecho, para a pessoa adaptar; o do Collector é **[S: README do `otlpreceiver` e do `otlphttpexporter` em github.com/open-telemetry/opentelemetry-collector, 2026-11-21]**):

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: "127.0.0.1:4318"   # recebe OTLP/HTTP, inclusive com JSON
exporters:
  otlphttp/phoenix:
    endpoint: "http://127.0.0.1:6006"  # o Collector acrescenta /v1/traces
    encoding: proto                    # o padrão; é o que o Phoenix aceita
    compression: none
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/phoenix]
```

- O receptor do Collector aceita OTLP/HTTP com JSON além de gRPC, e o `localhost` é o padrão dele **[S]**.
- O exportador `otlphttp` acrescenta `/v1/traces` à URL base, tem `encoding` com `proto` (padrão) ou `json`, e usa gzip por padrão **[S]**. O tratador do Phoenix decodifica gzip e deflate **[S]**; `compression: none` é só para simplificar.
- O pipeline é só de traces. As requisições de métricas e de logs do OTheater cairiam em 404, por isso a configuração abaixo as desliga.

**2. `config.yaml` do OTheater** (chaves de `packages/daemon/src/config.ts` **[V]**; todas aceitam só os modos abaixo):

```yaml
telemetry:
  enabled: on                  # obrigatório: o exportador lê a telemetry.sqlite
  export: otlp                 # off (padrão) | otlp | prometheus | both
  otlp:
    endpoint: "http://127.0.0.1:4318"  # a base; o OTheater acrescenta /v1/traces
    protocol: http/json                # o único que existe (N211)
    signals:
      traces: on
      metrics: off             # o Collector acima só tem pipeline de traces
      logs: off
    compression: none          # none | gzip
    # headers: não é preciso; só com a chave do cofre, e só com https fora do loopback
    # on_failure: drop (padrão) | hold; retry.*; interval; batch; timeout: ver abaixo
```

Reinicie o daemon depois de editar o arquivo. **[N: não conferi se o bloco `telemetry` recarrega a quente]**

Chaves relacionadas (padrão, modos) **[V]**:

| Chave | Padrão | Observação |
| --- | --- | --- |
| `telemetry.enabled` | `on` | `off` e `export: otlp` ou `both` juntos são recusados na leitura |
| `telemetry.export` | `off` | `off`, `otlp`, `prometheus`, `both` |
| `telemetry.otlp.endpoint` | `null` | URL `http` ou `https`; obrigatória com `otlp` ou `both` |
| `telemetry.otlp.protocol` | `http/json` | só `http/json` |
| `telemetry.otlp.headers` | `{}` | nome do cabeçalho para a **chave de um segredo no cofre**; recusada com `http://` fora do loopback |
| `telemetry.otlp.compression` | `none` | `none`, `gzip` |
| `telemetry.otlp.signals.{traces,metrics,logs}` | `on` | `on`, `off` |
| `telemetry.otlp.timeout` e `interval` | `10s` e `10s` | duração |
| `telemetry.otlp.batch` | `500` | 1 a 10000 |
| `telemetry.otlp.retry.{retries,backoff,initial,max}` | `3`, `exponential`, `1s`, `30s` | `backoff`: `exponential`, `fixed` |
| `telemetry.otlp.on_failure` | `drop` | `drop`, `hold` |
| `telemetry.otlp.failure_report` | `1m` | janela do evento `telemetry.export_failed` |

**3. Veja o resultado** na interface do Phoenix, no projeto padrão dele (ou o que o Collector fixar). **[N: como o Phoenix apresenta spans sem os atributos OpenInference (`openinference.span.kind` e afins) e como agrupa por projeto não foi conferido.]** O que dá para dizer do lado do OTheater é que cada span leva os ids de cenário, peça, tentativa e sessão como atributos quando a base os sabe (`otheater.scenario_id` e afins, `span-conventions.ts` **[V]**).

**Se algo falhar:** o evento `telemetry.export_failed` do OTheater diz o destino, o sinal, o motivo e o status. Um 415 em `traces` quer dizer que o OTheater está falando direto com o Phoenix (o desenho da receita 2 evita isso); um 404 em `metrics` ou `logs` quer dizer que o sinal está ligado e o Collector não tem o pipeline.

## Não faça

- Não aponte `telemetry.otlp.endpoint` direto para `http://127.0.0.1:6006` esperando que funcione hoje: o resultado esperado, segundo o código do Phoenix, é 415 **[S]**, que o OTheater conta como `rejected`, não repete e descarta, com um evento por janela.
- Não use `telemetry.otlp.headers` com `http://` fora desta máquina: a configuração recusa.
- Não distribua o Phoenix com o OTheater, nem o ofereça como serviço a terceiros a partir dele (ELv2).

## Fontes e data

Todas lidas em 2026-11-21; leitura por um leitor automático de páginas, que devolve resumos e não o texto integral. Nada foi baixado nem executado.

| Fonte | Uso | Estado |
| --- | --- | --- |
| github.com/Arize-ai/phoenix (README, `LICENSE`, `IP_NOTICE`) | licença ELv2, como subir, patentes | lido |
| github.com/Arize-ai/phoenix, `src/phoenix/server/api/routers/v1/traces.py` e a listagem do diretório | só protobuf, 415, só traces | lido (`main`, sem fixar o commit) |
| github.com/Arize-ai/phoenix/issues/14991 | pedido de OTLP JSON e de importar arquivos de trace | lido |
| github.com/Arize-ai/phoenix, `packages/phoenix-client` (`helpers/atif/__init__.py`, `_validate.py`, `_types.py`, `pyproject.toml`) | utilitário de ATIF, versões, dependências | lido (`main`) |
| arize-phoenix.readthedocs.io/projects/client/api/helpers.html | assinatura e notas do utilitário de ATIF | lido |
| arize.com/docs/phoenix (configuração de self-hosting, importação de ATIF, notas de versão, exportador) | portas, `/v1/traces`, versões do cliente | **não lido**: o leitor recebeu 403; só conheço o conteúdo por resultados de busca (fonte secundária) |
| opentelemetry.io/docs/specs/otlp | tipos de conteúdo, portas, caminhos, gzip | lido |
| github.com/open-telemetry/opentelemetry-collector (`otlpreceiver`, `otlphttpexporter`) | receptor com JSON e exportador em protobuf | lido |
| Código do OTheater (`config.ts`, `otlp-encode.ts`, `otlp-exporter.ts`, `atif/command.ts`, `atif-config.ts`) | o que o OTheater manda e exporta | **[V]** |

Os termos e as versões do Phoenix mudam: antes de usar, confira de novo a licença e a documentação. O texto aqui não foi executado contra um Phoenix real.
