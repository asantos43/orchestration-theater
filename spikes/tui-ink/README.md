# spikes/tui-ink — protótipo da TUI em Ink

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10, item "TUI: Ink × OpenTUI"). Código **descartável**. Medido em **2026-11-14 e 2026-11-15** (horário de São Paulo, UTC-3), pela bancada de [`../tui-bench`](../tui-bench/README.md). Marcação: **[V]** verificado localmente · **[S]** fonte secundária · **[N]** não confirmado.

## Máquina e versões [V]

| Item | Valor |
|---|---|
| Sistema | Fedora 45, Linux 7.3.3-300.fc45.x86_64 |
| CPU / RAM | AMD Eng Sample 100-000000296-40_Y, 12 CPUs / 30 GiB |
| Node | 24.18.0 |
| tmux | 3.8 (bancada com socket próprio, 160x45, `TERM=xterm-256color`) |
| `ink` | 8.0.0 |
| `@inkjs/ui` | 2.0.0 (só `Badge`; o `TextInput` dele fica atrás de `--input ui`) |
| `react` | 19.3.1 |
| Empacotamento | `esbuild` 0.28.2 (`--bundle --packages=external`, ESM); `tsx` 4.23.15 para `bun`-less dev; TypeScript 7.0.2 |

Só dependências JS puras. Sem módulo nativo, sem Bun: roda no Node 24 [V].

## Como rodar

```bash
cd spikes/tui-ink
npm install
npm run build                      # gera dist/main.js
NODE_ENV=production node dist/main.js --scenario stream --rate 50 --duration 60
NODE_ENV=production node dist/main.js --scenario history --messages 5000 --steps 1000
npm run typecheck                  # tsc --noEmit
```

- Padrões: `--scenario stream --rate 20 --duration 300`; `history` com `--messages 5000 --steps 1000`. `--duration 0` = sem limite. Ao fim da duração o gerador para e o cabeçalho mostra `FIM`; o app continua aberto até Ctrl+Q.
- `--incremental` liga o `incrementalRendering` do Ink (reescreve só as linhas que mudaram). `--max-fps N` (padrão 30). `--input ui` troca a linha de entrada própria pelo `TextInput` do `@inkjs/ui` (padrão: `own`). `--no-alt` desliga a tela alternativa.
- **Use sempre `NODE_ENV=production`.** Sem isso o React roda em modo de desenvolvimento (ver "Problemas").
- A bancada que mede este protótipo e o do OpenTUI é a [`../tui-bench`](../tui-bench/README.md): `node bench.mjs run --name ink --cwd ../tui-ink --cmd "env NODE_ENV=production node dist/main.js"`.

**Interpretação do gerador:** cada tique acrescenta pedaços de texto à mensagem em curso e a fecha ao atingir um tamanho-alvo; PRNG mulberry32, semente 42, palavras em português com acento. **O gerador do Ink e o do OpenTUI não são idênticos**: no stream de 300 s a 50/s o Ink terminou com 1.771 mensagens e 612 passos, o OpenTUI com 1.526 e 210; a 20/s, 709 e 252 contra 617 e 97 [V: cabeçalho da última tela de cada uma]. A largura do chat também difere (86 colunas no Ink, 76 no OpenTUI). Os números dos dois não são de cargas idênticas.

## Layout e teclas [V]

Cabeçalho, lateral (cenários e barras de cota `█░`), chat com linha de entrada embaixo, painel de trajetória, rodapé de atalhos; bordas `╭╮╰╯`. Teclas: Ctrl+B/Alt+B (lateral), Ctrl+J/Alt+J (painel), Ctrl+←/→ (largura do chat, passo de 4 colunas), Tab (foco chat/painel), PageUp/PageDown, Enter, Ctrl+Q. Com a janela estreita o painel some (o chat tem prioridade; o painel só aparece se couber 30 + 24 colunas além da lateral).

**Rolagem e virtualização são do protótipo, não do Ink.** O Ink não tem `scrollbox`. O protótipo quebra o texto em linhas (`wrap()` por `String.length`), guarda todas num vetor e só cria elementos React para a fatia visível (`ChatLines`/`StepLines`). A abertura do histórico de 5.000 mensagens e a rolagem dependem desse código, não de uma virtualização do Ink. No OpenTUI a rolagem é do próprio `<scrollbox>` com corte por viewport.

## Resultados (bancada completa, 160x45, sequencial, máquina sem outra carga minha) [V]

Fonte: `../tui-bench/out/ink/` e `../tui-bench/out/ink-incremental/` (ignoradas pelo git). Tabela comparativa completa com o OpenTUI no [README da bancada](../tui-bench/README.md).

| Medida | `ink` | `ink --incremental` |
|---|---|---|
| Stream 50/s, digitação p50 / p95 / máx (ms) | 41,1 / 67,6 / 78,5 | 45,0 / 75,4 / 79,7 |
| Stream 50/s, CPU média / p95 (% de 1 núcleo) | 27,9 / 30,9 | 32,4 / 35,0 |
| Stream 50/s, RSS início / fim / pico (MB) | 157 / 292,8 / 292,8 | 162,2 / 295,3 / 295,3 |
| Stream 50/s, quadros/s · bytes/s no pty | 17,2 · 228.210 | 16,8 · 121.681 |
| Stream 20/s, digitação p50 / p95 / máx (ms) | 46,7 / 75,9 / 80,1 | 46,9 / 78,3 / 83,2 |
| Abertura com 5.000 msgs + 1.000 passos, 1º quadro / tela estável (ms) | 498 / 651 | 507 / 659 |
| PageUp/PageDown no chat, p50 / p95 (ms) | 32,4 / 65,8 | 38,6 / 67,7 |
| Layout, passos ok / total | 25 / 25 | 25 / 25 |
| Telas com borda quebrada durante o stream (50/s) | 1 / 29 | 0 / 29 |

Partida ociosa até o primeiro quadro: 440 ms (p50). RSS ocioso: 126 MB; CPU ociosa 0,6%.

- **RSS:** sobe de ~150 MB para ~280 MB nos primeiros 30 s (aquecimento do V8) e depois quase não anda: de 281 MB (60 s) para 293 MB (300 s) a 50/s, cerca de +1 a +3 MB/min no fim [V]. Sem crescimento contínuo visível em 300 s.
- **CPU:** estável durante os 300 s (28,6% nos primeiros 60 s, 27,8% nos últimos 60 s, a 50/s) [V].
- **Teclas e layout:** Ctrl+B, Alt+B, Ctrl+J, Alt+J e Ctrl+←/→ restauram o estado; redimensionamento (80x24, 200x60, 120x30 e rajada de 10 tamanhos em ~1 s) manteve as bordas inteiras [V].

## Problemas e limites

1. **Modo de desenvolvimento do React é bem mais lento.** Em 60 s a 50/s, sem `NODE_ENV=production` a CPU média foi **43,3%** contra **26,5%** em produção (1,6x), e o RSS mediano 291 contra 234 MB [V, uma execução de 60 s de cada, `out/ink-dev60` e `out/ink-prod60`]. A latência de digitação não mudou (p50 45,7 contra 47,3 ms). A estimativa anterior de "cerca de 2x" não foi reproduzida com esse número. Medir sempre com `NODE_ENV=production`; o cliente real precisa garantir isso no empacotamento.
2. **A latência de digitação sob stream (~41–47 ms p50) é, em boa parte, o limite de quadros do Ink.** Com `--max-fps 60` (padrão do protótipo: 30), em 60 s a 50/s a digitação caiu para p50 **29,6 ms** / p95 43,7 ms, e a CPU subiu para 45,3% [V, uma execução, `out/ink-fps60`]. Que o acelerador de quadros seja a causa principal é inferência a partir desses números, [N] sem outra medida. Fica como chave de configuração (`maxFps`), não como decisão.
3. **Borda quebrada em uma amostra de tela, repetindo.** No `ink` sem `--incremental`, 1 de 29 amostras (a cada 10 s) tinha as últimas linhas (42 e 43 da tela de 45) apagadas: 1/29 nos dois streams de 300 s, 1/29 numa repetição diagnóstica de 300 s (instante 130,3 s) e 1 numa execução de 60 s. Com `--incremental` foram 0/58 nos dois streams [V]. A tela de fim de stream estava sempre inteira. **Hipótese, [N]:** o Ink sem modo incremental apaga as 45 linhas do quadro anterior (`ESC[2K ESC[1A` repetido) e reescreve tudo dentro de `?2026h/l`; o `tmux capture-pane` lê a grade do tmux no meio do quadro. Se um terminal real que respeite o modo de saída sincronizada (DEC 2026) mostraria isso, **não foi testado**.
4. **Volume de bytes no pty muito maior sem `--incremental`:** 228 KB/s contra 122 KB/s a 50/s e 277 KB/s contra 63 KB/s a 20/s [V]. Em SSH ou em terminais lentos isso pesa [N, não medido].
5. **`TextInput` do `@inkjs/ui` insere "b" com Ctrl+B e Alt+B** (e, por extensão, ignora o significado de atalho dessas teclas) [V na rodada anterior; não repetido nesta]. Por isso a entrada padrão do protótipo é própria (`useInput`, `--input own`).
6. **Ctrl+J chega como LF** (`input === "\n"`), não como `key.ctrl` + `j`, e fica distinto do Enter (CR) dentro do tmux 3.8 [V na rodada anterior; o passo "Ctrl+J" do layout passou nesta rodada, pelo tratamento de `"\n"` em `App.tsx`]. Outros terminais **não testados** [N].
7. **Uma tecla PageUp/PageDown sem efeito em 200** no chat (1/200: 3 s sem a tela mudar) [V]; a causa **não foi investigada** [N].
8. **`wrap()` conta por `String.length`:** emoji, CJK e combinações de acento decomposto não têm largura tratada [V pelo código; efeito visual **não testado**].
9. **Rolagem e virtualização são código do protótipo** (acima). O custo de reproduzi-las no cliente real é do projeto, não do Ink.
10. **A rodada anterior, em paralelo com outros agentes, não vale como medida:** `../tui-bench/out/ink-paralelo` e `out/ink-incremental-paralelo` ficam só como registro (CPU 29%, digitação p50 46 ms, RSS ~293 MB — próximos dos números limpos, mas sem controle de carga).
11. Não medi: matriz de terminais (só tmux), SSH, mouse, macOS, Windows, entrada com IME [N].

## Otimização (2026-11-15)

Pedido: reduzir a latência de digitação durante o streaming e, depois, a memória. Tudo medido na bancada de [`../tui-bench`](../tui-bench/README.md) (tmux 3.8, 160x45, sequencial, uma execução de cada, Node 24.18, Ink 8.0.0). Marcação: [V] verificado aqui, [S] fonte secundária, [N] hipótese ou não medido. Todas as mudanças ficam atrás de flags; **sem flags o comportamento é o antigo**.

### Diagnóstico [V]

Rastreio por `--trace ARQUIVO` (eventos de stdin, handler, escrita no pty, tempo de render, memória) e um perfil de CPU de 60 s.

- **(a) Custo da bancada: desprezível.** O app de piso (`../tui-bench/floor.mjs`, mesmas 160x45 e mesmos bytes, sem React nem Ink) responde p50 1,8 ms / p95 8,9 ms a 50 quadros/s e usa 0,8% de CPU, 58 MB [V, `out/floor50`]. O ruído de medida fica em ~2 ms.
- **(b) A espera é o limitador de quadros do Ink.** A tecla passa pelo mesmo `throttle` do conteúdo (`maxFps` 30 = 34 ms) e não tem prioridade. Com o stream chamando `render` a cada ~28 ms, o quadro real sai a cada ~59 ms (17 quadros/s). A latência p50 de ~42 ms é essa espera mais o render.
- **(c) React e `wrap`: irrelevantes.** A notificação do React + Yoga custa p50 0,01 ms por notificação (evento `n` do rastreio); o Yoga é ~3% e o React ~2% do perfil; o `wrap` já é incremental.
- **(d) O gargalo de CPU é a saída do Ink.** `Output.get`/`renderNodeToOutput` custam ~11,5 ms por quadro (tokenizar, `stringWidth`, `styledCharsToString` por linha, e uma grade altura x largura de objetos nova a cada quadro, com `OutputCaches` descartado a cada quadro).

### O que é da aplicação e o que é patch do Ink

| Flag | Onde | O que faz | Padrão |
|---|---|---|---|
| `--key-render flush` | aplicação (usa a API pública `waitUntilRenderFlush()`) | depois de cada tecla, força o render na hora em vez de esperar o limitador; rolagem e envio avisam o React sem esperar a coalescência de 16 ms | `throttle` (antigo) |
| `--memo` | aplicação | `memo` em linhas do chat, na linha de entrada e nos títulos; o `App` deixa de assinar o Store e de re-renderizar tudo a cada notificação | desligado |
| `--coalesce N` | aplicação | intervalo da coalescência do Store em ms (0 = a cada evento) | 16 (o do código original) |
| `--history-window N` | aplicação | guarda só as últimas N mensagens (descarta em lote, com 25% de folga) | 0 (tudo) |
| `--ink-patch cache,grid` (ou `all`) | **patch do Ink** (cópia de `output.js` do 8.0.0 em `patches/ink/output.js`, carregada por `module.registerHooks`) | `cache`: um único `OutputCaches` para a sessão, com limite por custo em caracteres (`OT_INK_CACHE_LIMIT`, padrão 120000) e cache de texto para linhas; `grid`: células vazias da grade são um único objeto congelado | desligado |
| `--trace ARQUIVO` | instrumentação | grava JSONL no encerramento | desligado |

- O patch é só um arquivo, só liga com `--ink-patch`, e o Ink original em `node_modules` **não é alterado**; o diff legível está em `patches/ink-output.patch` (contra o `output.js` do 8.0.0). Ele **acompanha a versão 8.0.0 do Ink**: atualizar o Ink exige refazer o patch [V pelo desenho]. Adotar o patch, fazer fork ou propor a mudança ao Ink é decisão do dono.
- Só o `dist/main.js` (launcher) lê `--ink-patch`. `npm start` (tsx, sem launcher) **não** aplica o patch nem o gancho do WASM.
- Opções do Node (não são deste código, vão no comando): `--max-semi-space-size=2` e `--max-old-space-size=96` (ver "Memória").

### Como rodar a variante otimizada

```bash
cd spikes/tui-ink && npm run build
NODE_ENV=production node --max-semi-space-size=2 --max-old-space-size=96 dist/main.js \
  --key-render flush --ink-patch cache,grid --memo
```

### Tabela por variante (stream 50/s, triagem de 60 s, 30 teclas) [V, uma execução cada]

Sem repetição: diferenças de 1 a 2 ms em p50 e de poucos MB de RSS entre variantes vizinhas estão dentro do ruído (v-key-cache e v-kc2 são a mesma configuração: 11,0 e 10,6 ms).

| Variante | Digitação p50 / p95 (ms) | CPU média (%) | RSS mediana (MB) |
|---|---|---|---|
| base (`ink-base60`) | 42,7 / 64,0 | 32,5 | 284 |
| `--key-render flush` | 15,9 / 23,4 | 32,1 | 285 |
| `--memo` | 41,4 / 71,0 | 27,3 | 234 |
| `--ink-patch cache` | 29,2 / 59,1 | 25,3 | 238 |
| flush + cache | 11,0 / 18,6 | 26,6 | 254 |
| flush + cache,grid | 12,2 / 19,8 | 25,9 | 240 |
| flush + cache,grid + memo | 10,9 / 20,4 | 24,2 | 240 |
| + `--max-semi-space-size=2` | 11,9 / 23,5 | 24,7 | 111 |
| + semi 2 + `--max-old-space-size=96` | 10,2 / 16,6 | 24,7 | 114 (máx 147) |
| + `--max-semi-space-size=4` | 10,7 / 17,6 | 24,5 | 118 |
| + `--max-semi-space-size=1` | 11,3 / 14,3 | 24,9 | 144 |
| base (sem flags) + semi 2 | 38,9 / 64,0 | 29,6 | 158 |
| + semi 2 + `--history-window 500` | 10,6 / 18,1 | 24,8 | 137,5 |
| Stream 20/s, base | 25,9 / 73,4 | 29,8 | 284 |
| Stream 20/s, final (semi 2) | 13,5 / 18,0 | 22,0 | 108,5 |

### Resultado final (300 s) [V, uma execução de cada, rastreio ligado]

Final = `--key-render flush --ink-patch cache,grid --memo` com `node --max-semi-space-size=2 --max-old-space-size=96`. Base = sem flags.

| Medida | Base | Final | Meta |
|---|---|---|---|
| Stream 50/s, digitação p50 / p95 / máx (ms) | 48,2 / 70,8 / 78,1 | **10,1 / 16,5 / 26,6** | p50 ≤ 16 |
| Stream 50/s, CPU média / p95 (%) | 26,2 / 29,8 | **23,6 / 26,9** | ≤ 32,9 |
| Stream 50/s, RSS mediana / máx (MB, `/proc`) | 237,9 / 244,5 | **142,3 / 143,1** | < 200 |
| Stream 50/s, quadros/s · KB/s no pty | 17,3 · 223 | 20,1 · 260 | |
| Stream 50/s, telas com borda quebrada | 0 / 29 | 1 / 29 | |
| Stream 20/s, digitação p50 / p95 / máx (ms) | 46,7 / 75,9 / 80,1 (rodada de 2026-11-14) | **10,1 / 17,0 / 19,1** | |
| Stream 20/s, CPU média (%) · RSS mediana (MB) | 30,0 · 290 (rodada de 2026-11-14) | **21,7 · 147,3** | |
| Histórico, PageUp/PageDown no chat p50 / p95 (ms) | 35,7 / 65,4 | **7,9 / 14,8** (2ª rodada 7,3 / 10,2) | |
| Histórico, RSS antes → depois (MB) | 177,8 → 265,6 | **119,6 → 158,7** | |
| Layout, passos ok | 25 / 25 | 25 / 25 | |

- A base de 300 s foi medida de novo nesta rodada (`out/base300`): p50 48,2 ms (contra 41,1 ms na rodada de 2026-11-14) e RSS 238 MB (contra 293 MB). Não sei explicar a diferença de RSS (uma execução de cada) [N]; a comparação antes/depois acima usa a base desta rodada.
- A borda quebrada 1/29 do "final" é o mesmo fenômeno já descrito nos "Problemas e limites" (o Ink sem `--incremental` reescreve o quadro inteiro e o `capture-pane` pode pegar o meio dele); aparece também na base da rodada anterior. Não foi investigada [N]. Com patch o Ink emite mais quadros por segundo (20 contra 17), então mais chance de a amostra cair no meio de um [N].
- CPU: a base de 60 s deu 32,5% e a de 300 s 26,2%; a de 60 s inclui o aquecimento. Compare 60 s com 60 s e 300 s com 300 s.

### Memória [V salvo onde marcado]

Divisão (rastreio, `process.memoryUsage()` + `WebAssembly.Memory` do Yoga, MB). O RSS do rastreio e o da bancada (`/proc`, 1 Hz) diferem em ~10 MB.

| Execução, instante | rss | heapTotal | heapUsed | external | arrayBuffers | WASM do Yoga |
|---|---|---|---|---|---|---|
| Base, 0 s | 94 | 34 | 19 | 22 | 1 | 16,8 |
| Base, 60 s | 244 | 165 | 63 | 21 | 0 | 16,8 |
| Base, fim (300 s) | 255 | 175 | 48 | 21 | 0 | 16,8 |
| Final, 0 s | 88 | 22 | 16 | 21 | 0 | 16,8 |
| Final, 60 s | 139 | 40 | 29 | 21 | 0 | 16,8 |
| Final, fim (300 s) | 149 | 52 | 39 | 21 | 0 | 16,8 |

RSS por variante (bancada, `/proc`): base 300 s: início ≈ 94, 60 s ≈ 244, fim ≈ 255, pico 255 (trace); final 300 s: início ≈ 88, 60 s ≈ 139, fim ≈ 149, pico 149 (trace). heapUsed máximo: base 91, final 46.

- **O RSS do Ink é, em quase tudo, capacidade do V8 e não retenção.** Na base, `heapTotal` 165–175 MB com `heapUsed` de 33 a 91 MB (o resto é semi-espaço young de 16 MB x vários e páginas do old space ainda não devolvidas). O WASM do Yoga é constante em 16,8 MB e `external` fica em 21 MB, sem crescimento.
- **O protótipo não retém nada que cresça sem limite no stream:** `heapUsed` do final vai de 29 MB (60 s) a 39 MB (300 s) e o RSS mediano se mantém (133,9 → 142,6 MB entre as metades). O que cresce é o histórico de mensagens (esperado); `--history-window` o limita, mas **não deu ganho de RSS** em 60 s (137,5 contra 111 MB sem janela, uma execução: ruído ou custo do descarte em lote [N]) e descarta dados, então fica como chave, desligada.
- **`--max-semi-space-size=2` é a alavanca:** de 240 para 111 MB sem custo de CPU nem de latência (24,2 → 24,7% CPU; 10,9 → 11,9 ms, dentro do ruído). Sozinho, na base (sem as outras flags), cai de 284 para 158 MB, com CPU 32,5 → 29,6%. Com 1 MB o RSS sobe (144 MB; mais coletas de lixo, [N] a causa) e com 4 MB fica em 118 MB.
- **`--max-old-space-size=96` só importa no histórico.** No stream muda pouco (114 MB). Na rolagem do histórico com `flush` cada tecla gera um quadro, o `heapUsed` salta a 125 MB em rajadas e o V8 não devolve as páginas: o RSS chegou a 233 MB (só semi 2), 318 MB (semi 2 + `flush`, sem patch nem memo), 194 MB (só `memo`, com PageUp lento de 34 ms), 146 MB (old 80) e 137 MB (old 64) com a mesma latência; com old 96: 158,7 MB (`final-hl`). **Aviso de regressão cruzada:** o `flush` sem teto de heap piorou o RSS do histórico (de 177,8 → 265,6 MB na base para 318 MB); o teto de old space o recupera sem perder latência.
- **Risco do teto:** `--max-old-space-size` é limite duro; passando dele o processo morre por falta de memória. No stream de 300 s o `heapUsed` máximo foi 46 MB e com 5.000 mensagens ~44 MB, ou seja, 2x de folga com 96 MB. Um cliente real com histórico maior precisa de teto proporcional [N] (chave de configuração, não constante).
- **Hipótese refutada:** achei que o RSS do histórico vinha do cache de `styledChars` do patch. O limite por custo em caracteres foi implementado e **não mudou nada** (308 MB com limite de 5.000, 318 MB sem patch algum). O limite por custo fica no patch (é inofensivo e protege de crescimento sem teto), mas a causa é o lixo em rajada, não o cache.
- **Não implementado:** quebra só da fatia visível com cache limitado (o `wrap` já é incremental e só o chat da janela é quebrado, então o ganho esperado é pequeno) [N].

### Limites desta otimização

1. Uma execução por célula, sem variância medida; os ganhos grandes (latência 4–5x, RSS ~40%) estão acima do ruído, os pequenos não.
2. Só tmux. Latência medida de `send-keys` até o `capture-pane` mostrar a tecla, não até o pixel [V pelo método].
3. `flush` dobra o trabalho de render em rajadas de teclas (um quadro por tecla, sem coalescência); com digitação muito rápida mais lenta do que o render isso é bom, com colagem de texto longo **não foi medido** [N].
4. O patch copia `output.js` do Ink 8.0.0; é código nosso a manter se for adotado.
5. Os números de CPU/RSS do Ink e do OpenTUI continuam de cargas diferentes (ver acima).
6. `--max-fps 15` na variante final e a variante "só aplicação" a 300 s **não foram medidas** [N].
