# spikes/local-model

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10, "Fase 0 — Validações e escolha da base"): **Gemma 4 em llama.cpp com `--jinja`, via OpenCode (ACP), fazendo chamadas MCP estruturadas.** Código descartável; nada daqui segue para a Fase 1.

Marcas usadas em todo o documento:

- **[V]** = verificado localmente, por execução nesta máquina em 2026-11-15 (UTC-3), com a saída em `out/` (ignorada pelo git).
- **[S]** = fonte secundária (documentação, código ou cabeçalho lido, mas não executado).
- **[N]** = não confirmado, ou hipótese.

Os termos de uso dos provedores **não** foram consultados, com uma exceção: os do Google (Unpaid Services) para a seção "Gemma 4 26B-A4B e 31B pela API do Google", com fonte e data lá. Nada mais aqui afirma o que um provedor permite.

## Resumo

- O `--jinja` **funcionou de primeira**: o Gemma 4 devolveu `tool_calls` válidos, e não foi preciso trocar o template. Uma coisa precisou de ajuste: o **raciocínio vem ligado** e gasta o orçamento antes da chamada. Rodamos com `--reasoning off`. **[V]**
- Neste computador, o llama-server do pacote do Fedora só roda **em CPU e sem AVX**: ~3 tokens/s no prompt e ~2,2 tokens/s na geração. O prompt de ~12 mil tokens do OpenCode leva mais de uma hora na primeira requisição. **[V]**
- Nas 10 tarefas, com uma configuração enxuta do OpenCode (~1,9 mil tokens de prompt), o Gemma 4 E4B acertou **10 de 10**, sem argumento errado, ferramenta inventada, texto no lugar da chamada nem laço. O `google/gemini-3.1-flash-lite` também acertou 10 de 10. **[V]**, mas com uma execução por modelo e 10 tarefas curtas: não mostra diferença, e não dá para medir taxa de erro.
- O teste com o **prompt cheio** do OpenCode (14 ferramentas, ~12 mil tokens) no llama-server do Fedora foi **interrompido a pedido do dono** em 2026-11-15, com 52% do prompt processado. Ver "Prompt cheio do OpenCode".
- **No Ollama v0.40.16, com a iGPU por Vulkan**, o mesmo GGUF processa o prompt a ~150 a 210 tok/s e gera a ~8 a 11 tok/s: de 50 a 70 vezes mais rápido no prompt e ~4 vezes na geração. As 10 tarefas passaram **10 de 10** nas duas configurações, a enxuta (11 min 40 s) e a **cheia** (20 min 28 s, com 14 ferramentas e ~11,6 mil tokens), e com o raciocínio ligado, que é o padrão do Ollama. **[V]** Ver "Ollama com a iGPU por Vulkan". O Ollama passa a ser a ferramenta de modelo local para desenvolvimento e testes (`./ollama.sh`). O pacote `llama-cpp` do Fedora foi removido pelo dono, e o `serve.sh` ficou obsoleto.
- **Gemma 4 26B-A4B e 31B pela API do Google** (qualidade apenas; **não** mede RAM, tok/s nem quantização local): nas 10 tarefas, os dois acertaram **10 de 10** na configuração enxuta (n=2 cada, perfil `authonly`, ~1,9 mil tokens) e no perfil do dono (n=1); o 31B também 10 de 10 com o prompt cheio (~11,8 mil tokens), e o 26B 7 de 7, com 3 tarefas **excluídas por cota ou erro do provedor** (infraestrutura, não erro do modelo). O 26B chamou `record_findings` e `submit_result` sem o prefixo `otheater_` em 3 tarefas por corrida no `authonly` enxuto e se corrigiu depois da recusa do OpenCode (nada inválido chegou ao MCP); o 31B nunca errou o nome. As tarefas não distinguem os modelos (E4B, 26B, 31B e flash-lite, todos 10/10). **[V]** O tier grátis limita em 16 mil tokens de entrada por minuto **[V]**, e os termos do Google dizem que o conteúdo pode ser usado para melhorar produtos e ter revisão humana **[S]**. Ver "Gemma 4 26B-A4B e 31B pela API do Google".

## O que foi medido, onde e com quê

| | |
|---|---|
| Data e hora | 2026-11-15, execuções entre ~08:00 e 10:23 (UTC-3) |
| Sistema | Fedora Linux 45, kernel 7.3.3-300.fc45.x86_64 |
| Máquina | 12 núcleos (CPU "AMD Eng Sample", família Cezanne), 30 GB de RAM, sem GPU dedicada; iGPU AMD gfx90c (Vega). A máquina estava **ocupada** (load average 8 a 9 durante as medições), o que reduz as velocidades. |
| Node | v24.18.0 (TypeScript rodado direto; `npx tsc -p .` passa) |
| `opencode` | 1.19.5 (`opencode acp`) |
| llama.cpp | pacote `llama-cpp-b9840-2.fc45.x86_64`; `llama-server --version`: "version: 0 (unknown), built with Clang 22.0.0 for Linux x86_64". **Removido** pelo dono depois do teste (`rpm -q llama-cpp`: não instalado) |
| Ollama | v0.40.16, binário oficial para Linux amd64 (`ollama-linux-amd64.tar.zst`, SHA-256 conferido com o `sha256sum.txt` da release), instalado em `~/.local/opt/ollama-v0.40.16`, sem sudo e sem serviço; usa um `llama-server` próprio em `lib/ollama/` com Vulkan **[V]** |
| `@agentclientprotocol/sdk` / `@modelcontextprotocol/sdk` / `zod` / `typescript` | 2.7.0 (entrada `/unstable`) / 1.32.2 / 4.6.7 / 7.0.2 |
| Modelo local | `gemma-4-E4B-it-Q4_0.gguf` (ver "Modelo") |
| Modelo de comparação | `google/gemini-3.1-flash-lite`, esforço `low`, pelo perfil padrão do OpenCode do dono (chave de API; só o nome do provedor foi usado, o `auth.json` não foi lido) |

O repositório git de teste e a worktree ficaram na scratchpad da sessão, fora do repositório. O `~/.config/opencode` não foi alterado. O `opencode serve` do dono (porta 4096) não foi usado nem encerrado. As portas usadas foram a 47500 (llama-server) e a 47501 (servidor MCP de teste).

### Modelo

| | |
|---|---|
| Arquivo | `~/.cache/llama.cpp/gemma-4-E4B-it-Q4_0.gguf`. **Apagado** em 2026-11-15, a pedido do dono, depois do `import`; a única cópia ficou no Ollama, como o blob `sha256-a555b9…` em `~/.ollama/models/blobs` |
| Tamanho | 4 590 807 392 bytes (4,27 GiB) **[V]** |
| SHA-256 | `a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2` **[V]** (`out/gguf.sha256`) |
| Origem | repositório `ggml-org/gemma-4-E4B-it-GGUF` no Hugging Face (download autorizado no briefing) |
| Parâmetros / quantização | 7,46 bilhões de parâmetros contados pelo llama.cpp (o "E4B" tem 4 bilhões efetivos; o resto são embeddings por camada), Q4_0 **[V]** |
| Licença | **Apache-2.0**, segundo o cartão do modelo: <https://huggingface.co/google/gemma-4-E4B-it> (consulta em 2026-11-15) **[S]**. Conferir o texto da licença antes de redistribuir. |

## Resultado por item

| # | Item | Resultado |
|---|------|-----------|
| 1 | `llama-server --jinja` com contexto para o prompt do OpenCode; RAM, prompt tok/s, geração tok/s, TTFT | **[V]** `-c 32768 -np 1` (janela por slot 32 768, lida em `/props`/log: `n_ctx_slot = 32768`, 1 slot). Só CPU (ver "Backend"). **RAM**: RSS do processo 5,2 GB logo depois de carregar (5 214 MB), 5,27 GB depois de uma requisição de 516 tokens, **5,48 GB** (VmRSS 5 483 416 kB; 4,5 GB são o arquivo mapeado, 0,94 GB anônimo) depois das 10 tarefas com ~2 mil tokens de contexto. **Prompt**: 2,7 a 3,1 tok/s no teste isolado (3 repetições, 356 tokens), mediana 2,7 tok/s nas 19 requisições das tarefas (mín. 1,6, máx. 3,1). **Geração**: 2,2 a 2,4 tok/s no teste isolado, mediana 2,2 tok/s (mín. 2,1, máx. 2,4) nas tarefas. **TTFT**: 114 a 134 s para 356 tokens de prompt (3 repetições); para o prompt enxuto do OpenCode (~1,9 mil tokens), 682 s na primeira requisição. Com o cache de prefixo, as requisições seguintes só processam os tokens novos (15 a 140), e o primeiro token sai em 5 a 50 s. Prompt cheio de 12 mil tokens: ver seção própria. |
| 2 | Apontar o OpenCode para o servidor | **[V]** Funciona por `OPENCODE_CONFIG_CONTENT` com o provedor `@ai-sdk/openai-compatible` (`baseURL` `http://127.0.0.1:47500/v1`, modelo `gemma4-e4b`, `tool_call: true`, `limit.context` 32768) e perfil isolado (`XDG_*` e `OPENCODE_DB` em pastas vazias da scratchpad). Via **ACP** (`opencode acp`): `session/new`, `session/set_config_option` para o modelo, `session/prompt` com streaming. O modelo aparece no catálogo, **sem opções de esforço** (`effortValues: []`). **`opencode run` não foi testado** (ver Pendências). |
| 3 | 10 tarefas MCP estruturadas (Gemma) | **[V]** Configuração enxuta: **10/10** tarefas ok; 20 chamadas MCP válidas; **0** argumento errado, **0** ferramenta inventada, **0** texto no lugar da chamada, **0** laço. Ver a tabela por tarefa abaixo. A tarefa de ferramenta nativa (T5, `edit`) funcionou, e também `read` (T6) e `write` (T9). |
| 4 | Comparação com `google/gemini-3.1-flash-lite` | **[V]** Mesmas 10 tarefas, mesmas contagens: **10/10**, 20 chamadas MCP válidas, 0 de cada falha. Mesmo servidor MCP e mesmos critérios. Diferença que existe: tempo (Gemini: 2,6 a 31 s por tarefa; Gemma: 58 a 733 s) e o tamanho do prompt (ver "Ressalvas"). |
| 5 | O template `--jinja` funcionou ou precisou de ajuste? | **[V]** Funcionou **de primeira**, sem template próprio: o log não acusa erro de template e o `POST /v1/chat/completions` com `tools` devolveu `message.tool_calls` válidos (nome e argumentos JSON corretos, inclusive o objeto aninhado, o enum e o array). Dois avisos no carregamento, sem efeito visível: `'<|tool_response>' was not control-type` (o llama.cpp corrige sozinho) e `special_eog_ids contains '<|tool_response>', removing '</s>' from EOG`. **Travou** o raciocínio: ver "Template e raciocínio". |

### Backend: o que travou

- **ROCm/HIP (GPU)**: o pacote traz `libggml-hip.so`, mas o `llama-server` com a GPU **abortou** (códigos de saída 139 e 134; mensagem "HW Exception by GPU node-1 ... reason :GPU Hang"). O `gdb` (`out/gdb.log`) mostra o `SIGABRT` vindo de `rocr::core::Runtime::HwExceptionHandler`, em `libhsa-runtime64.so.1`: é o runtime ROCm que aborta o processo quando o kernel avisa de um travamento da GPU **[V]**. A iGPU é gfx90c (Cezanne). Que a biblioteca do pacote não tenha kernels para esse alvo é **[N]** (não li a lista de alvos). Solução usada: `--device none`.
- **Uma queda a mais**: já com `--device none`, o servidor morreu com a mesma mensagem durante a primeira corrida do prompt cheio, processando um prompt pequeno (`out/llama-server-run1.log`). Como o aborto vem do runtime ROCm carregado no processo, a causa provável é um travamento da iGPU que não foi causado por este servidor (outro programa do desktop, por exemplo) **[N]**. A corrida foi refeita com `ROCR_VISIBLE_DEVICES=-1 HIP_VISIBLE_DEVICES=-1` (o `serve.sh` as define) para o runtime não enxergar a GPU.
- **CPU sem AVX**: o `libggml-cpu.so.0` do pacote não tem uma única instrução `ymm`, `zmm` ou `vfmadd` (`objdump -d`: 0 ocorrências) **[V]**, embora a CPU tenha `avx`, `avx2`, `fma` e `f16c` (`/proc/cpuinfo`) **[V]**. Por isso a velocidade é de ~3 tok/s. A hipótese de que uma compilação nativa ou Vulkan chegaria a algo bem melhor é **[N]**: não foi tentada. Compilar o llama.cpp exigia baixar o código-fonte, e o ambiente negou essa ação; não contornei. Fica como pendência que depende da autorização do dono.

### Template e raciocínio

- Template embutido no GGUF ("Canonical Chat Template" do Gemma 4, data do cabeçalho 2026-07-09) **[S]**, lido pelo `--jinja`. Nenhum ajuste de template foi feito **[V]**.
- Com o raciocínio **ligado** (padrão do llama-server para este modelo), o Gemma 4 gasta tokens de "pensamento" antes da chamada de ferramenta. A 2,2 tok/s isso significa minutos por chamada, e o orçamento de `max_tokens` pode acabar antes da chamada. Rodei **`--reasoning off`** em todas as 10 tarefas. Não medi a qualidade das chamadas com o raciocínio ligado. **[V]** para o efeito de gastar tokens (primeiras requisições manuais); a comparação de qualidade fica como pendência.
- O OpenCode **não expõe esforço** para este modelo (`effortValues: []`), então não há como pedir "baixo" pelo ACP. O controle de raciocínio fica no servidor (`--reasoning`). **[V]**

## As 10 tarefas

Servidor MCP próprio (`src/lib/mcp-server.ts`, Streamable HTTP, sem estado, em 127.0.0.1:47501), com quatro ferramentas e esquemas validados por zod, que registra **toda** chamada, inclusive as inválidas:

- `get_sprint_info` (sem argumentos);
- `create_task` (título, `priority` enum, `labels` array com ao menos 1, `assignee` objeto `{name, team enum}`, `estimate_hours` opcional);
- `record_findings` (array de `{file, line inteiro, severity enum}`);
- `submit_result` (`status` done ou blocked, `summary`, `artifacts` opcional).

Tarefas (texto completo em `src/tasks.ts`): T1 `create_task` com array e objeto aninhado; T2 três achados em uma chamada; T3 `get_sprint_info` e depois `create_task` com os valores devolvidos (encadeada); T4 objeto aninhado, número decimal e `artifacts`; T5 **`edit` nativo** (trocar "foo" por "bar"); T6 `read` nativo e `create_task` com o conteúdo lido; T7 cinco achados; T8 `submit_result` com `blocked`; T9 `write` nativo; T10 duas chamadas `create_task`. Cada tarefa roda na worktree de teste, que é restaurada entre elas. Uma tarefa conta como "ok" quando o servidor MCP recebeu as chamadas certas com os valores certos **e** (nas nativas) o arquivo ficou como esperado.

Critérios de classificação: **chamada válida** = passou na validação zod; **argumento errado** = a ferramenta existe, mas a validação recusou; **ferramenta inventada** = nome que não existe (pelo nome original da chamada ACP, sem o título); **texto no lugar da chamada** = o turno acabou sem as chamadas necessárias e com texto; **laço** = 3 repetições da mesma chamada, ou mais de 25 chamadas MCP (cancelado).

### Gemma 4 E4B Q4_0, configuração enxuta (7 ferramentas, prompt ~1,9 mil tokens)

| Tarefa | Tipo | Resultado | Chamadas MCP válidas | Tempo |
|---|---|---|---|---|
| T1 | mcp | ok | 2 | 733 s (inclui o processamento inicial do prompt) |
| T2 | mcp | ok | 2 | 93 s |
| T3 | mcp | ok | 3 | 94 s |
| T4 | mcp | ok | 2 | 105 s |
| T5 | nativa (edit) | ok | 1 | 58 s |
| T6 | nativa + mcp | ok | 2 | 163 s |
| T7 | mcp | ok | 2 | 131 s |
| T8 | mcp | ok | 2 | 173 s |
| T9 | nativa (write) + mcp | ok | 1 | 66 s |
| T10 | mcp | ok | 3 | 168 s |
| **Total** | | **10/10** | **20** | |

Argumento errado 0, ferramenta inventada 0, texto no lugar da chamada 0, laço 0. Dados brutos: `out/gemma-lean.results.json`, `out/gemma-lean.mcp.jsonl`, `out/gemma-lean.acp.jsonl`.

### `google/gemini-3.1-flash-lite` (mesma configuração enxuta, perfil padrão do OpenCode)

10/10, 20 chamadas MCP válidas, 0 argumento errado, 0 ferramenta inventada, 0 texto no lugar da chamada, 0 laço. Tempos: 2,6 a 31 s (o maior, T6, 31 s). Brutos: `out/gemini.results.json`. Uma primeira corrida contou ferramentas nativas como "inventadas" por um erro do meu classificador (o título da chamada ACP virava o nome); corrigi para usar o nome original e rodei de novo. A corrida errada ficou em `out/gemini-run0-misclassified.results.json`.

### Ressalvas da comparação

- **Uma execução por modelo**, sem repetição: não dá para estimar variância. Dez tarefas curtas que os dois acertam não dizem qual é melhor, só que o Gemma 4 E4B não falhou nelas.
- A configuração enxuta (`permission: deny` em `bash`, `glob`, `grep`, `skill`, `task`, `todowrite`, `webfetch`, `list`; prompt de sistema de uma frase; geração de título desligada) **facilita** o trabalho do modelo: 7 ferramentas em vez de 14 e um prompt curto. O resultado vale para esse cenário, não para o OpenCode padrão.
- O Gemini rodou no perfil padrão do OpenCode do dono, que injeta mais contexto: ~7 mil tokens por requisição (3 mil de entrada mais ~4 mil lidos do cache), contra ~1,9 mil do Gemma no perfil isolado. A diferença de contexto favorece o Gemma; a de tamanho do modelo favorece o Gemini.
- O raciocínio do Gemma estava desligado; o do Gemini, em `low`.
- A máquina estava ocupada, o que só afeta tempos.

## Prompt cheio do OpenCode

Teste da configuração **padrão** do OpenCode (14 ferramentas nativas e MCP, prompt de sistema original) contra o mesmo llama-server (`-c 32768 -np 1 -t 6 --reasoning off`, só CPU).

**Tamanho do prompt.** Medido sem rodar modelo, com o `src/stub-llm.ts`: o corpo da requisição do OpenCode padrão tem **48,6 KB** (prompt de sistema de 24,5 KB, 14 ferramentas: `bash`, `edit`, `glob`, `grep`, `read`, `skill`, `task`, `todowrite`, `webfetch`, `write` e as 4 do MCP) **[V]**. Em tokens, o progresso do llama-server dá **~11,7 a 12,0 mil** (2048/0,17, 4096/0,35 e 6144/0,52, com o progresso arredondado) **[V, por estimativa]**. Na configuração enxuta (7 ferramentas, prompt de uma frase) o corpo tem 8,1 KB e o prompt, ~1,9 mil tokens **[V]**.

**Processamento medido até a parada** (do `out/llama-server-run2-interrupted.log`, requisição principal da corrida, que começou depois do pedido de título de 586 tokens, feito em 3,5 min):

| Tokens processados | Progresso | Tempo acumulado | tok/s acumulado | tok/s do trecho |
|---|---|---|---|---|
| 2048 | 0,17 | 691 s (11,5 min) | 2,96 | 2,96 |
| 4096 | 0,35 | 1515 s (25,3 min) | 2,70 | 2,49 |
| 6144 | 0,52 | 2472 s (41,2 min) | 2,49 | 2,14 |

A velocidade **cai com a profundidade** (2,96, 2,49 e 2,14 tok/s por trecho de 2048 tokens) **[V]**. **RAM** com 6 mil tokens processados: RSS 5,40 GB (0,89 GB anônimos e 4,5 GB do arquivo mapeado; `out/rss-during-full-prompt.txt`) **[V]**.

**Estimativa do total [N]**: faltavam ~5,7 mil tokens. Se a queda continuar (2 tok/s ou menos), mais ~48 a 60 min, e o **primeiro token só sairia 85 a 100 min** depois de enviar o prompt. Essa extrapolação não foi medida.

**O que não foi feito.** O teste foi **interrompido a pedido do dono em 2026-11-15, ~10:23**, porque ele vai instalar o Ollama nesta máquina e continuar o teste lá, num passo à parte. Por isso: (a) nenhuma tarefa rodou com o prompt cheio, e a **qualidade das chamadas com 14 ferramentas e ~12 mil tokens não foi medida**; (b) não há TTFT nem geração em tok/s com esse contexto; (c) a corrida anterior (`out/gemma-default-run0-gpuhang.*`) morreu por um "GPU Hang" do runtime ROCm antes de terminar o pedido de título e não conta.

## Ollama com a iGPU por Vulkan

Feito em 2026-11-15, entre ~10:30 e 11:03 (UTC-3), a pedido do dono. Ele mandou deixar esta versão como ferramenta de desenvolvimento e testes. Mesmo GGUF (`ollama create` com `FROM <gguf>`, sem baixar outro modelo), porta 47510, só em 127.0.0.1.

**GPU.** Por padrão, o Ollama descarta a GPU integrada. Com `OLLAMA_IGPU_ENABLE=1`, ele usa o Vulkan: `library=Vulkan`, "AMD ... (RADV RENOIR)", 43 de 43 camadas na GPU e 2 851 MiB de buffer do modelo em `Vulkan0` (`out/ollama-serve-tasks.log`) **[V]**. Não houve "GPU Hang" em ~33 min de uso **[V]**. As bibliotecas CUDA do pacote falham ao carregar, porque não há `libcuda`, e isso não afeta nada. O ROCm fica de fora, porque trava nesta iGPU (ver "Backend").

**Template.** O Ollama não usou o template Jinja do GGUF. Ele reconheceu o modelo e aplicou o renderizador próprio `gemma4-small` e o parser `gemma4`, com ferramentas e raciocínio **[V]**. **O raciocínio ficou ligado nas duas corridas**: o Ollama raciocina por padrão com este modelo, e o OpenCode não manda nada que o desligue. O log ACP tem 4 953 `agent_thought_chunk` na corrida enxuta e 3 804 na cheia **[V]**. No llama-server, as corridas foram com `--reasoning off`, então a comparação de tempo não é direta: o Ollama fez mais trabalho por tarefa. Com `"reasoning_effort": "none"` na requisição, o Ollama respondeu sem raciocínio **[V, uma requisição manual]**.

**Velocidade** (do log do servidor, 77 requisições das duas corridas):

| | llama-server do Fedora (CPU sem AVX) | Ollama com Vulkan |
|---|---|---|
| Prompt | 2,7 a 3,1 tok/s | 154 tok/s no prompt cheio (11 633 tokens em 75,6 s); 212 tok/s com 1 715 tokens |
| Geração | ~2,2 tok/s | mediana 9,6 tok/s (mín. 8,1, máx. 11,5) |
| Primeira atualização da sessão no prompt cheio | 85 a 100 min, estimados **[N]** | 129 s na T1, incluindo o pedido de título; das tarefas seguintes em diante, ~0 s, com o cache de prefixo |

**Resultado das 10 tarefas** (mesmos critérios de "As 10 tarefas"):

| Tarefa | Enxuta | Cheia (14 ferramentas) |
|---|---|---|
| T1 | ok, 71 s | ok, 185 s |
| T2 | ok, 49 s | ok, 135 s |
| T3 | ok, 85 s | ok, 124 s |
| T4 | ok, 68 s | ok, 131 s |
| T5 (edit) | ok, 73 s | ok, 146 s |
| T6 (read) | ok, 82 s | ok, 101 s |
| T7 | ok, 64 s | ok, 153 s |
| T8 | ok, 47 s | ok, 105 s |
| T9 (write) | ok, 48 s | ok, 58 s |
| T10 | ok, 108 s | ok, 88 s |
| **Total** | **10/10**, 20 chamadas MCP válidas, 11 min 40 s | **10/10**, 20 chamadas MCP válidas, 20 min 28 s |

As duas corridas tiveram 0 argumento errado, 0 ferramenta inventada, 0 texto no lugar da chamada e 0 laço **[V]**. Os dados brutos estão em `out/ollama-lean.*` e `out/ollama-default.*`. Ressalva: é uma execução por configuração, com 10 tarefas curtas. Isso mostra que o Gemma 4 E4B aguentou o prompt cheio nestas tarefas, e não que ele aguenta tarefas difíceis.

**O que ficou no disco:**
- o Ollama em `~/.local/opt/ollama-v0.40.16` (2,4 GB);
- o modelo em `~/.ollama/models` (4,3 GB, com os nomes `otheater-gemma4-e4b` e `gemma4-e4b` apontando para o mesmo blob). É a única cópia do modelo: o GGUF do cache foi apagado depois do `import`.

A pasta `~/.ollama` já existia antes deste teste. O download (1,5 GB) foi apagado.

## Gemma 4 26B-A4B e 31B pela API do Google

Pedido do dono em 2026-11-15: medir a **qualidade** do Gemma 4 26B-A4B (`google/gemma-4-26b-a4b-it`) e do 31B (`google/gemma-4-31b-it`) nas mesmas 10 tarefas, pela API do Google, via OpenCode (ACP). **Não mede RAM, tok/s nem quantização local**: o modelo roda nos servidores do Google, com precisão e hardware que não conheço **[N]**. Os números de tempo abaixo são de um serviço remoto, sem relação com o desempenho que esses modelos teriam nesta máquina.

### Configuração

- **Provedor e credencial**: provedor `google` do OpenCode, com o login que o dono já tinha. Não li, copiei nem imprimi credencial nenhuma. Datas: todas as corridas em 2026-11-15 (UTC-3).
- **Perfis do OpenCode** (`OT_PROFILE`), três:
  - `authonly` (novo, em `src/run-tasks.ts`): config, cache e banco do OpenCode isolados; só o diretório de dados com o login do Google é o real. Com a configuração enxuta, ~1,9 mil tokens por requisição **[V]**, o mesmo tamanho do teste do E4B. É o perfil principal desta seção, porque deixa a comparação com o E4B justa em tamanho de prompt.
  - `default`: o perfil real do dono, o mesmo do Gemini. Com a configuração enxuta, ~6,6 mil tokens por requisição (~0,6 mil novos mais ~6 mil lidos do cache) **[V]**. Rodei uma vez por modelo, como extra, para comparar com o `google/gemini-3.1-flash-lite` no mesmo caminho.
  - `isolated`: só o provedor local (o dos testes do E4B). Não serve aqui.
- **Configurações** (`OT_CONFIG`): `lean` (7 ferramentas, prompt de uma frase, sem título) e `default` (a "cheia": 14 ferramentas e o prompt do OpenCode; no `authonly` foram ~1,6 mil tokens novos mais ~10,2 mil lidos do cache, ~11,8 mil por requisição **[V]**).
- **Raciocínio**: o OpenCode escolheu `minimal` sozinho para os dois modelos (campo `effort` dos brutos). O raciocínio não foi variado **[V]**.
- **Repetições**: `lean` no `authonly` com n=2 para cada modelo; as demais combinações, n=1. A cheia não foi repetida: a corrida do 26B levou ~67 min e a do 31B ~34 min de relógio, em boa parte por esperas de cota (abaixo), e eu priorizei cobrir os dois modelos nas três combinações antes de repetir.
- **Comandos**: ver "Como rodar". Uma corrida por vez (porta 47501 do MCP; worktree restaurada entre as tarefas).

### Cota, termos e infraestrutura

- **Termos de uso [S]**: os "Unpaid Services" do Google (https://aistudio.google.com/docs/terms, vigentes desde 2026-03-23, consultados em 2026-11-15) dizem que o conteúdo enviado é usado para melhorar os produtos do Google e pode passar por revisão humana. Consequência prática, **a confirmar pelo dono**: não mandar código ou dados sensíveis por esse caminho. As tarefas daqui usam só texto sintético.
- **Limites do tier grátis para Gemma [N]**: não os encontrei na documentação consultada.
- **Limite visto na prática [V]**: a API devolveu "Quota exceeded ... generate_content_free_tier_input_token_count, limit: 16000, model: gemma-4-31b (e gemma-4-26b), ... input tokens per minute limit exceeded on Free Tier". Ou seja, o tier grátis limita em **16 mil tokens de entrada por minuto**. A cota também falhou com requisições de ~2 mil tokens; então ela não é só a soma dos prompts do meu lado **[N]** (o que conta como entrada para a cota, ou se outros usos da mesma chave entram na conta, não sei).
- **Erros do provedor [V]**: além da cota, houve "Internal error encountered" (HTTP 500 do provedor). O OpenCode faz retentativas internas e depois devolve o erro `-32603 APIError`.
- **Tratamento**: falha por cota, limite de taxa ou erro do provedor é **infraestrutura**, não erro do modelo. O `run-tasks.ts` repete a tarefa inteira (worktree restaurada), com espera de 65 s entre as tentativas (`OT_INFRA_RETRIES`, `OT_INFRA_WAIT_MS`, `OT_TASK_GAP_MS`), e, se todas falham, marca a tarefa como **excluída** (`excluded: true`), que não entra na contagem de acertos nem de falhas. O tempo da tabela é o da tentativa que passou.
- **Contagem de erros de infraestrutura nas 8 corridas [V]**: 11 de cota e 19 do provedor (500). Por corrida: 26B lean (1) 1 cota e 2 de 500; 26B lean (2) 1 de 500; 31B lean (1) 3 de cota; 31B lean (2) nenhum; 26B cheia 6 de cota e 9 de 500; 31B cheia 1 de cota; 26B dono lean 6 de 500; 31B dono lean 1 de 500.
- A primeira tentativa de `gemma26-google-lean` rodou no perfil `default`, bateu na cota logo na T1 e foi descartada (não está em `out/`). Foi o que me levou a criar o `authonly` e as retentativas.

### Resultado

Tempos em segundos, da tentativa que passou (inclui as retentativas internas do OpenCode, se houve **[N]**). "(inv.)" = a tarefa teve chamada de ferramenta inventada, mas passou. "(N tent.)" = foram necessárias N tentativas por erro de infraestrutura. **EXCL** = excluída por infraestrutura (todas as tentativas falharam por cota ou erro do provedor).

| Tarefa | 26B lean (1) | 26B lean (2) | 31B lean (1) | 31B lean (2) | 26B cheia | 31B cheia | 26B dono lean | 31B dono lean |
|---|---|---|---|---|---|---|---|---|
| T1 | ok 8 s | ok 89 s | ok 55 s (2 tent.) | ok 55 s | ok 101 s (2 tent.) | ok 115 s | ok 74 s | ok 291 s |
| T2 | ok 15 s (inv.) | ok 7 s (inv.) | ok 48 s | ok 76 s | **EXCL** (3 tent.) | ok 61 s | ok 23 s | ok 63 s |
| T3 | ok 9 s | ok 9 s | ok 51 s | ok 96 s | ok 263 s (2 tent.) | ok 187 s (2 tent.) | ok 121 s (4 tent.) | ok 182 s |
| T4 | ok 79 s | ok 44 s | ok 74 s | ok 92 s | ok 113 s | ok 88 s | ok 89 s | ok 260 s |
| T5 | ok 22 s (inv.) (2 tent.) | ok 9 s (inv.) (2 tent.) | ok 92 s (2 tent.) | ok 167 s | **EXCL** (3 tent.) | ok 228 s | ok 88 s | ok 237 s |
| T6 | ok 13 s (2 tent.) | ok 9 s | ok 112 s (2 tent.) | ok 110 s | ok 145 s (2 tent.) | ok 266 s | ok 78 s (2 tent.) | ok 178 s (2 tent.) |
| T7 | ok 23 s (inv.) | ok 45 s (inv.) | ok 111 s | ok 76 s | ok 116 s (3 tent.) | ok 68 s | ok 151 s | ok 153 s |
| T8 | ok 9 s | ok 4 s | ok 31 s | ok 37 s | **EXCL** (3 tent.) | ok 105 s | ok 40 s (2 tent.) | ok 48 s |
| T9 | ok 4 s (2 tent.) | ok 11 s | ok 34 s | ok 245 s | ok 157 s (2 tent.) | ok 119 s | ok 114 s | ok 94 s |
| T10 | ok 6 s | ok 13 s | ok 57 s | ok 66 s | ok 110 s | ok 158 s | ok 118 s (2 tent.) | ok 122 s |

| Corrida | Perfil / config | ok | excluídas | MCP válidas | arg. errado | inventada (chamadas) | texto | laço | tempo das tarefas ok | ensaios extras |
|---|---|---|---|---|---|---|---|---|---|---|
| 26B lean (1) | `authonly` / enxuta | 10/10 | 0 | 20 | 0 | 3 | 0 | 0 | 187 s | 3 |
| 26B lean (2) | `authonly` / enxuta | 10/10 | 0 | 20 | 0 | 3 | 0 | 0 | 239 s | 1 |
| 31B lean (1) | `authonly` / enxuta | 10/10 | 0 | 20 | 0 | 0 | 0 | 0 | 666 s | 3 |
| 31B lean (2) | `authonly` / enxuta | 10/10 | 0 | 20 | 0 | 0 | 0 | 0 | 1021 s | 0 |
| 26B cheia | `authonly` / cheia | 7/7 | 3 | 15 | 0 | 0 | 0 | 0 | 1006 s | 12 |
| 31B cheia | `authonly` / cheia | 10/10 | 0 | 20 | 0 | 0 | 0 | 0 | 1397 s | 1 |
| 26B dono lean | `default` / enxuta | 10/10 | 0 | 20 | 0 | 0 | 0 | 0 | 895 s | 6 |
| 31B dono lean | `default` / enxuta | 10/10 | 0 | 20 | 0 | 0 | 0 | 0 | 1628 s | 1 |

Brutos em `out/`, cada um com `.results.json`, `.mcp.jsonl`, `.acp.jsonl`, `.acp.stderr.log` e `.log`: `gemma26-google-lean`, `gemma26-google-lean-r2`, `gemma31-google-lean`, `gemma31-google-lean-r2`, `gemma26-google-default` (a "26B cheia"), `gemma31-google-default` (a "31B cheia"), `gemma26-google-dono-lean` e `gemma31-google-dono-lean`.

**Exclusões**: só a "26B cheia" teve, e foram 3 de 10 (T2, T5 e T8), cada uma com 3 tentativas falhas por cota ou erro 500 do provedor. Conto como infraestrutura, não como erro do modelo, e **não sei** como o 26B teria se saído nessas três tarefas com o prompt cheio **[N]**. As 7 tarefas restantes passaram.

**Ferramenta inventada, só no 26B no `authonly` enxuto [V]**: nas duas execuções, e nas mesmas três tarefas (T2, T5 e T7), o 26B chamou `record_findings` e `submit_result` **sem o prefixo `otheater_`** (o OpenCode nomeia as ferramentas do MCP como `otheater_<nome>`). O OpenCode recusou ("unavailable tool"), o modelo repetiu a chamada com o nome certo no turno seguinte e a tarefa passou. Pelos critérios, isso é "ferramenta inventada" (3 por corrida), mas **nenhuma chamada inventada chegou ao servidor MCP**, e as 20 chamadas válidas vieram todas com o nome e os argumentos certos. Esse erro **não** apareceu no 26B com a configuração cheia (nas 7 tarefas rodadas, T7 incluída) nem no perfil do dono (0 em 10 tarefas), nem no 31B em nenhuma corrida. Por que só no `authonly` enxuto, não sei **[N]**; a diferença de ferramentas ou de prompt é só uma hipótese.

**Outras observações [V]**: na T4 o 26B (nas duas execuções do `authonly` enxuto) usou a ferramenta `write` para criar um `MIGRATION.md`, que a tarefa não pedia (o nome só aparece em `artifacts` de `submit_result`); a tarefa passou porque o critério só confere as chamadas MCP. Em nenhuma corrida houve argumento errado, texto no lugar da chamada ou laço. No 31B, a T1 do perfil do dono levou 291 s, perto do prazo de 300 s por tarefa que usei nessas corridas (`OT_TASK_TIMEOUT_MS`).

### Comparação com o E4B e com o flash-lite

| Modelo | Onde roda | Configuração | Resultado |
|---|---|---|---|
| Gemma 4 E4B Q4_0 | llama-server (CPU) | enxuta, ~1,9 mil tokens | 10/10, 20 válidas, 0 falhas; 58 a 733 s por tarefa |
| Gemma 4 E4B Q4_0 | Ollama (iGPU, Vulkan) | enxuta; cheia (~11,6 mil tokens) | 10/10 nas duas; 11 min 40 s e 20 min 28 s no total |
| Gemma 4 26B-A4B | API do Google | enxuta, ~1,9 mil tokens (n=2) | 10/10 nas duas; 20 válidas; 3 inventadas (corrigidas) por corrida; 4 a 89 s por tarefa |
| Gemma 4 26B-A4B | API do Google | cheia, ~11,8 mil tokens | 7/7 não excluídas, 3 excluídas por cota ou erro do provedor; 0 falhas |
| Gemma 4 26B-A4B | API do Google | perfil do dono, enxuta | 10/10; 20 válidas; 0 inventadas; 23 a 151 s por tarefa |
| Gemma 4 31B | API do Google | enxuta, ~1,9 mil tokens (n=2) | 10/10 nas duas; 20 válidas; 0 falhas; 31 a 245 s por tarefa |
| Gemma 4 31B | API do Google | cheia, ~11,8 mil tokens | 10/10; 20 válidas; 0 falhas; 61 a 266 s por tarefa |
| Gemma 4 31B | API do Google | perfil do dono, enxuta | 10/10; 20 válidas; 0 falhas; 48 a 291 s por tarefa |
| `google/gemini-3.1-flash-lite` | API do Google | perfil do dono, enxuta | 10/10; 20 válidas; 0 falhas; 2,6 a 31 s por tarefa |

### Leitura

- **[V] Nestas 10 tarefas, os dois modelos grandes fazem o que o E4B e o flash-lite fazem**: chamadas MCP estruturadas (objeto aninhado, array, enum, decimal, encadeadas) e as ferramentas nativas `edit`, `read` e `write`, com 20 chamadas MCP válidas em toda corrida completa, sem argumento errado, texto no lugar da chamada nem laço. Isso vale nas três combinações de perfil e configuração, inclusive com o prompt cheio.
- **[V] As tarefas não distinguem os modelos.** Os quatro (E4B, 26B, 31B e flash-lite) tiram 10/10. Qualquer diferença de qualidade que exista fica abaixo do que estas 10 tarefas fáceis conseguem mostrar, com n=1 ou n=2. Não dá para dizer que 26B ou 31B são melhores que o E4B nesse tipo de tarefa; só que não pioram.
- **[V] O 26B errou o nome da ferramenta no `authonly` enxuto** (sem o prefixo, nas duas execuções, nas mesmas três tarefas) e se corrigiu sozinho. O 31B não errou nenhuma vez em 6 execuções. É um sinal de que o 26B é mais frágil com nomes de ferramentas em prompt curto, mas com 2 execuções e uma só configuração onde aparece, não é prova **[N]**. Para o OTheater, vale tratar a recusa "unavailable tool" como recuperável (o modelo se corrigiu) e contar a ocorrência.
- **[V] O 31B é bem mais lento que o 26B pela API**: 666 s e 1021 s contra 187 s e 239 s, no `authonly` enxuto. Isso é latência do serviço remoto e depende de carga e de cota **[N]**; não é velocidade local.
- **[V] A cota do tier grátis é o fator limitante**, não o modelo: com o prompt cheio (~11,8 mil tokens por requisição) e o limite de 16 mil tokens de entrada por minuto, o 26B perdeu 3 de 10 tarefas por infraestrutura. O tier grátis é inadequado para um Executor contínuo, e há o aviso dos termos acima **[S]**.
- **Ressalvas**: n=2 só no `authonly` enxuto, n=1 nas outras; 10 tarefas curtas escritas para serem acertáveis; o esforço de raciocínio foi o que o OpenCode escolheu (`minimal`); o Gemma local é o E4B quantizado em Q4_0, enquanto 26B e 31B rodam no Google em precisão que não conheço **[N]**, então a comparação é entre modelos de tamanhos e execuções diferentes, não só de qualidade. A "26B cheia" tem 3 tarefas sem resultado.
- **Fora do escopo, não medido**: RAM do 26B-A4B e do 31B, tok/s e TTFT locais, qualidade com quantização local (Q4 ou outra). A arquitetura cita o 26B-A4B como candidato local; **nada aqui diz se ele cabe ou roda bem nesta máquina** **[N]**.


## Pendências (não medido)

Cada item abaixo **não foi medido**. O motivo vem ao lado.

| # | O que falta | Por quê |
|---|---|---|
| 1 | ~~Compilação nativa ou Vulkan do llama.cpp~~ | **Resolvido** pelo Ollama com Vulkan (seção própria). A compilação nativa com AVX2, sem GPU, continua sem medida. |
| 2 | ~~TTFT e tok/s com 12 a 14 mil tokens de prompt~~ | **Medido no Ollama**: 11 633 tokens em 75,6 s (seção própria). No llama-server do Fedora, ficou só a extrapolação **[N]**. |
| 3 | `opencode run` (sem ACP) | Só o caminho ACP foi exercitado, que é o do OTheater. |
| 4 | Raciocínio: qualidade e custo em tokens, comparando ligado e desligado | **Em parte**: no Ollama, com o raciocínio ligado, foram 10/10 nas duas configurações. Falta rodar no Ollama com o raciocínio desligado e contar os tokens de raciocínio. |
| 5 | Outras quantizações (Q8_0, Q5, Q6) e o desempenho **local** do Gemma 4 26B-A4B e do 31B, que a arquitetura cita | **Parcial.** A **qualidade** do 26B-A4B e do 31B nas 10 tarefas foi medida pela API do Google (seção própria): 10/10, com a ressalva das exclusões por cota. Continuam **não medidos**: RAM, tok/s e TTFT locais e a qualidade com quantização local, porque exigem baixar vários GB. A RAM do 26B-A4B em Q4 é **[N]**. |
| 6 | Mais de um slot (`-np 2` ou mais), contexto por slot e admissão | Só `-np 1` foi rodado. Que a janela por slot é `-c` dividido por `-np` vem da documentação do llama.cpp **[S]**; aqui o `/props` e o log mostraram `n_ctx_slot = 32768` com 1 slot **[V]**. |
| 7 | Repetição das 10 tarefas, para estimar variância, e mais tarefas (erros de esquema, instruções ambíguas, contexto longo) | **Em parte**: 26B e 31B rodaram 2 vezes na configuração enxuta (`authonly`); o resto, 1 vez. As 10 tarefas são curtas e foram escritas para serem acertáveis, e os quatro modelos tiram 10/10: falta um conjunto mais difícil para separá-los. |
| 8 | Gemini no mesmo perfil isolado e com o mesmo prompt do Gemma | **Em parte**: o 26B e o 31B rodaram no perfil do dono (como o Gemini) e no `authonly` (mesmo tamanho de prompt do E4B). O flash-lite **não** foi rodado no `authonly` **[N]**. |
| 9 | Cancelamento (`session/cancel`) com o modelo local no meio de um prompt longo | Fora do escopo das 10 tarefas. |
| 10 | Windows e macOS | Só Linux. |
| 11 | Leitura do texto completo da licença e da política de uso do Gemma 4 | Só o cartão do modelo foi consultado (2026-11-15). |
| 12 | ~~Repetir as 10 tarefas e o prompt cheio no Ollama~~ **Feito**: 10/10 nas duas configurações (seção "Ollama com a iGPU por Vulkan"). Texto original: repetir no Ollama, com GPU (Vulkan ou ROCm; a iGPU é gfx90c) ou CPU com AVX2, reaproveitando o mesmo GGUF por `ollama create`, sem baixar outro modelo | O dono mandou parar o teste do prompt cheio no llama-server e vai instalar o Ollama; o teste continua nele, num passo à parte. O GGUF fica em `~/.cache/llama.cpp/`. Não foi verificado que o Ollama aceite este GGUF nem que o template do Gemma 4 funcione lá **[N]**; o `ollama create` usa um Modelfile, e o template precisa ser conferido. |


## Como rodar

Com o Ollama, que é a ferramenta de desenvolvimento e testes:

```bash
cd spikes/local-model
npm install --ignore-scripts          # só nesta pasta
# 1. modelo: nesta máquina ele já está no Ollama (gemma4-e4b), e os passos 1 e o import podem ser pulados.
#    Numa máquina nova: ggml-org/gemma-4-E4B-it-GGUF, arquivo gemma-4-E4B-it-Q4_0.gguf (4,59 GB), em ~/.cache/llama.cpp/ ou em OT_GGUF
# 2. servidor (porta 47510, iGPU por Vulkan; grava out/ollama.pid e out/ollama-serve.log)
./ollama.sh start
./ollama.sh import                    # só na primeira vez: cria gemma4-e4b a partir do GGUF
# 3. as 10 tarefas pelo OpenCode (ACP), com o servidor MCP em 127.0.0.1:47501
export OT_BASEURL=http://127.0.0.1:47510/v1 OT_MODEL=local/gemma4-e4b OT_PROFILE=isolated OT_TASK_TIMEOUT_MS=900000
OT_CONFIG=lean node src/run-tasks.ts ollama-lean
OT_CONFIG=default node src/run-tasks.ts ollama-default
# 4. estado e parada (só o seu processo)
./ollama.sh status
./ollama.sh stop
```

Gemma 4 26B-A4B e 31B pela API do Google (precisa do login do Google já feito no OpenCode; nada de credencial no repositório). Uma corrida por vez, porque a porta do MCP é a 47501 e a worktree é única:

```bash
cd spikes/local-model
export OT_MAX_PROMPTS=800 OT_TASK_TIMEOUT_MS=300000 OT_INFRA_RETRIES=3 OT_TASK_GAP_MS=30000   # o limite padrão de prompts por sessão é 80
# perfil authonly (config isolada, login real do Google), enxuta e cheia
OT_PROFILE=authonly OT_CONFIG=lean    OT_MODEL=google/gemma-4-26b-a4b-it node src/run-tasks.ts gemma26-google-lean
OT_PROFILE=authonly OT_CONFIG=lean    OT_MODEL=google/gemma-4-31b-it     node src/run-tasks.ts gemma31-google-lean
OT_PROFILE=authonly OT_CONFIG=default OT_MODEL=google/gemma-4-26b-a4b-it OT_INFRA_RETRIES=2 OT_TASK_GAP_MS=60000 node src/run-tasks.ts gemma26-google-default
# perfil do dono (como o Gemini)
OT_PROFILE=default  OT_CONFIG=lean    OT_MODEL=google/gemma-4-31b-it     node src/run-tasks.ts gemma31-google-dono-lean
```

Variáveis novas do `run-tasks.ts`: `OT_PROFILE` (`isolated`, `default` ou `authonly`), `OT_INFRA_RETRIES` (retentativas por tarefa em erro de cota ou do provedor; padrão 0), `OT_INFRA_WAIT_MS` (espera entre elas; padrão 65 000), `OT_TASK_GAP_MS` (pausa entre tarefas; padrão 0) e `OT_MAX_PROMPTS` (limite de prompts da sessão, em `src/lib/budget.ts`; padrão 80). Valores usados: `authonly` enxuta, 3 retentativas e 10 s de pausa; `authonly` cheia, 2 retentativas e 60 s; perfil do dono, 3 retentativas e 30 s; prazo de 300 s por tentativa em todas. Não cobre RAM, tok/s nem quantização local.

Variáveis do `ollama.sh`: `OT_OLLAMA_DIR` (padrão `~/.local/opt/ollama-v0.40.16`), `OT_OLLAMA_PORT` (padrão 47510), `OT_CTX` (padrão 32768, teto 32768), `OT_GGUF`, `OT_OLLAMA_MAX_LOADED` (padrão 1), `OT_OLLAMA_KV_CACHE` (`f16`, o padrão, `q8_0` ou `q4_0`; os quantizados ligam o flash attention) e `OT_OLLAMA_FLASH_ATTENTION`. Limites desta máquina (dono, 2026-11-19): **um modelo local carregado por vez**, **no máximo 10 a 12 GB** por modelo e **contexto de no máximo 32K**.

O caminho antigo (`./serve.sh`, `src/bench.ts` e `src/parse-llama-log.ts`) usava o `/usr/bin/llama-server` do pacote do Fedora. O pacote foi removido em 2026-11-15, e por isso esse caminho **não roda mais** nesta máquina. Ele fica só como registro das medições em CPU. A comparação com o Gemini continua igual: `OT_MODEL=google/gemini-3.1-flash-lite OT_PROFILE=default node src/run-tasks.ts gemini`.

Variáveis: `SPIKE_SCRATCH` (repositório de teste; padrão `<tmpdir>/otheater-spikes/local-model`), `OT_GGUF` (caminho do modelo), `OT_TASK_TIMEOUT_MS` (padrão 480 000), `OT_BASEURL`. `src/stub-llm.ts` é um servidor OpenAI falso que grava os corpos das requisições; serviu para medir o prompt do OpenCode sem rodar o modelo.

## Consequências para o Executor local

Tudo abaixo é **[proposta]**, a partir do que foi medido; a decisão é do dono.

1. **Modelo e quantização.** `gemma-4-E4B-it-Q4_0` (4,27 GiB, Apache-2.0 pelo cartão) acertou 10/10 nas chamadas MCP estruturadas e nas ferramentas `edit`, `read` e `write` com o prompt enxuto **[V]**. Serve como ponto de partida do Executor local para tarefas curtas com ferramentas. Não testei Q8 localmente. O 26B-A4B e o 31B, que a arquitetura cita, só foram medidos pela API do Google (qualidade, 10/10 nas 10 tarefas, sem diferença em relação ao E4B nelas); RAM, velocidade e quantização local deles **não** foram medidas; não recomendo trocar sem medir **[N]**.
2. **RAM.** ~5,5 GB de RSS com `-c 32768 -np 1` **[V]**. Mais slots aumentam o cache de contexto; quanto, não medi **[N]**. Cabe folgado nos 30 GB desta máquina.
3. **Velocidade manda.** Com o binário do pacote (CPU sem AVX), 2 a 3 tok/s no prompt e ~2,2 na geração **[V]**: inviável como Ator interativo. Com o Ollama e a iGPU por Vulkan, ~150 a 210 tok/s no prompt e ~9,6 na geração, e as tarefas levam de 1 a 3 min **[V]**: lento para conversa, mas usável como Ator de tarefas curtas. O Executor local só faz sentido com **GPU funcionando ou CPU com SIMD**. O `LocalModelServer` precisa saber ligar a iGPU (no Ollama, `OLLAMA_IGPU_ENABLE=1`), porque o padrão a descarta. O `LocalModelServer` (§5.9) deveria medir tok/s de prompt e de geração no cadastro e avisar quando for baixo, em vez de só ler a janela de contexto.
4. **Prompt do cliente.** O OpenCode padrão manda ~12 mil tokens; o enxuto, ~1,9 mil **[V]**. Um perfil `local` do lançador deveria aplicar o corte (ferramentas negadas por `permission`, `agent.build.prompt` curto, `agent.title.disable`), pois o ganho é de ~6 vezes. O custo: o Ator perde `bash`, `grep` e `glob`; se ele precisar delas, o perfil precisa de um modo intermediário. Se isso derruba a qualidade, **não medido**.
5. **Cache de prefixo.** O llama-server reaproveitou o prefixo entre requisições (só 15 a 140 tokens novos por requisição) **[V]**. O custo da primeira requisição se paga uma vez; por isso o Executor local deve manter o **mesmo slot e o mesmo prefixo** (prompt de sistema e ferramentas estáveis, sem texto variável no começo) e evitar reiniciar o servidor.
6. **Tempos limite.** O primeiro token pode levar de minutos a mais de uma hora **[V]**. Os prazos por tentativa e a sonda de capacidade (§5.7) precisam de um valor próprio para o perfil local, com prazo de cadastro e de primeira requisição separados dos de nuvem.
7. **Raciocínio e esforço.** O OpenCode não expõe esforço para o modelo local **[V]**. O raciocínio se liga no servidor (`--reasoning` no llama-server); no Ollama, ele vem ligado por padrão e se desliga por requisição (`reasoning_effort: none`) **[V]**. Chaves sugeridas no bloco `local` do perfil: `reasoning: off|on|auto` (usei `off`), `threads`, `ctx_total` e `parallel` (janela por slot = `ctx_total / parallel` **[S]**), `opencode_prompt: lean|default`.
8. **Template.** Sem ajuste: `--jinja` com o template do GGUF no llama-server; no Ollama, o renderizador próprio `gemma4-small` **[V]**. O template do Gemma 4 é recente (2026-07-09 no cabeçalho); fixar a versão do llama.cpp usada no teste (b9840) e repetir a sessão de teste ao atualizar.
9. **Limites desta evidência.** Uma execução por configuração, 10 tarefas fáceis e curtas, máquina ocupada. O resultado mostra que a cadeia OpenCode, ACP e MCP funciona com o Gemma 4 local, no llama-server e no Ollama, e que o modelo aguentou o prompt cheio nestas tarefas; **não** mostra que ele aguenta tarefas difíceis.


## Arquivos

Em `spikes/local-model/` (a pasta `out/` e `node_modules/` são ignoradas pelo git):

- `README.md` (este arquivo), `package.json`, `package-lock.json`, `tsconfig.json`;
- `ollama.sh` (servidor de desenvolvimento e testes) e `serve.sh` (o llama-server do Fedora, obsoleto);
- `n148-eval.py` (qualidade das decisões de um Diretor local, N148 do docs/13: casos sorteados com semente fixa, resposta certa por regras determinísticas; chaves `NUM_CTX` (teto 32768), `HISTORY_TOKENS` (histórico de eventos antigos para encher o contexto), `TEMPERATURE` (padrão 0), `NUM_PREDICT` e `NUM_GPU`), `n148-run.sh` (os modelos de 8K, um por vez) e `n148-run-32k.sh` (o qwen3:14b com 32K, com um vigia que descarrega o modelo se a memória disponível cair mais de 12 GB); os resultados vão para `out/` ou para `$N148_OUT`;
- `src/run-tasks.ts` (executor das 10 tarefas; ganhou o perfil `authonly`, as retentativas e a exclusão por infraestrutura), `src/tasks.ts` (as tarefas e os critérios), `src/bench.ts` (TTFT, tok/s e RAM do servidor), `src/parse-llama-log.ts` (tempos por requisição a partir do log), `src/stub-llm.ts` (servidor OpenAI falso para medir o prompt do OpenCode);
- `src/lib/`: `agent.ts`, `budget.ts` (limite de prompts agora por `OT_MAX_PROMPTS`), `jsonl.ts`, `proc.ts`, `session.ts` (cliente ACP, vindos de `spikes/acp-opencode` com pequenas mudanças), `mcp-server.ts` e `paths.ts` (novos);
- `out/` (git-ignored): resultados, logs ACP/MCP e os logs do llama-server e do Ollama de cada corrida; as da API do Google são `gemma26-google-lean`, `gemma26-google-lean-r2`, `gemma31-google-lean`, `gemma31-google-lean-r2`, `gemma26-google-default`, `gemma31-google-default`, `gemma26-google-dono-lean` e `gemma31-google-dono-lean` (`.results.json`, `.mcp.jsonl`, `.acp.jsonl`, `.acp.stderr.log`, `.log`).

Fora do repositório: o Ollama em `~/.local/opt/ollama-v0.40.16`, o modelo importado em `~/.ollama/models` e a scratchpad da sessão.

