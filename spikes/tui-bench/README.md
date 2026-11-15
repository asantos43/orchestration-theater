# spikes/tui-bench — bancada de medição das TUIs (Ink × OpenTUI)

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10, item "TUI: Ink × OpenTUI"). Código **descartável**. Medido em **2026-11-14 (noite) e 2026-11-15 (madrugada)**, horário de São Paulo (UTC-3). Marcação: **[V]** verificado localmente · **[S]** fonte secundária · **[N]** não confirmado.

Este documento **não escolhe** entre Ink e OpenTUI: a decisão é do dono (Anderson). Ele só diz o que foi medido, em que condições e o que não vale como prova.

## O que a bancada mede

O `bench.mjs` roda o protótipo dentro de um tmux isolado (socket próprio `otbench-<nome>`, 160x45, `TERM=xterm-256color`, modo de controle `-C`). Lê a tela com `capture-pane`, guarda o fluxo bruto do pty e amostra o `/proc` da árvore de processos a 1 Hz. Não depende do framework: precisa só do comando do protótipo, que recebe `--scenario stream --rate N --duration S` ou `--scenario history --messages M --steps P`.

| Cenário | O que faz | Medidas |
|---|---|---|
| `startup` | 5 partidas ociosas (`--rate 0`), 3 com o histórico de 5.000 mensagens e 5 de linha de base do tmux (`printf` trivial) | tempo até o 1º quadro (p50), RSS e CPU ociosos |
| `stream20`, `stream50` | stream por 300 s a 20 e a 50 mensagens/s; a cada ~1 s digita um `Z` e espera vê-lo na tela; a cada 10 s confere a integridade da tela | latência de digitação p50/p95/máx, CPU média/p95, RSS (série de 1 Hz, início/fim/pico), quadros sincronizados (`?2026h`) por s, bytes por s no pty, telas com borda quebrada |
| `history` | abre com 5.000 mensagens + 1.000 passos; PageUp/PageDown (200 teclas no chat, 200 no painel, depois 2ª rodada no chat) | tempo de abertura (1º quadro e tela estável), latência de rolagem p50/p95/máx, teclas perdidas, RSS antes/depois e se estabiliza |
| `layout` | 25 passos: Ctrl+←/→, Ctrl+B, Alt+B, Ctrl+J, Alt+J, redimensionamentos (80x24, 200x60, 120x30, rajada de 10 tamanhos em ~1 s) | por passo: tudo cabe na tela, caixas `╭╮╰╯` com as quatro bordas, acentos, blocos `█░`; "ok/total" |
| `table` | junta vários `summary.json` | tabela Markdown |

Critérios automáticos de integridade (`lib.mjs`, `analyze`): a tela tem as linhas e colunas do terminal; cada caixa tem cantos nos quatro lados; os acentos do gerador (`ã é ç …`) aparecem; os blocos `█`/`░` das barras de cota aparecem. Ele **não** compara com imagem nem verifica cor.

### Como rodar

```bash
cd spikes/tui-bench
# 1) construir os protótipos
(cd ../tui-ink && npm install && npm run build)
(cd ../tui-opentui && bun install && bun run build)   # gera dist/otheater-tui; ver o README do tui-opentui
# 2) medir, UM DE CADA VEZ (nunca em paralelo: a medida de CPU e de latência só vale com a máquina quieta)
node bench.mjs run --name ink             --cwd ../tui-ink     --cmd "env NODE_ENV=production node dist/main.js"
node bench.mjs run --name ink-incremental --cwd ../tui-ink     --cmd "env NODE_ENV=production node dist/main.js --incremental"
node bench.mjs run --name opentui         --cwd ../tui-opentui --cmd "env NODE_ENV=production $PWD/../tui-opentui/dist/otheater-tui"
# opções: --only startup,stream20,stream50,history,layout   --duration 300   --tag texto
# 3) tabela
node bench.mjs table out/ink/summary.json out/ink-incremental/summary.json out/opentui/summary.json
# diagnóstico de memória depois do fim do stream (OpenTUI e outros)
node rss-apos-fim.mjs --name opentui-rss --cwd ../tui-opentui --cmd "env NODE_ENV=production OT_MEMLOG=$PWD/out/opentui-rss.memlog $PWD/../tui-opentui/dist/otheater-tui" --rate 50 --stream 90 --total 270
```

Tempo da bancada completa: ~13 min por protótipo (startup ~15 s, stream20 5 min, stream50 5 min, history ~70 s, layout ~1 min). Saídas em `out/<nome>/` (`summary.json`, `summary.md`, um `.json` por cenário, `*.raw`, `*.screen.txt`, `layout.screens.txt`); `out/` está no `.gitignore`.

Antes de cada medição, conferir `pgrep -af "otheater|dist/main.js|bench.mjs"` e `uptime` (carga abaixo de ~1). Os dois processos de terceiros que ficam rodando na máquina (`opencode serve` do dono, porta 4096, e o socket tmux `otspike`) **não** são tocados pela bancada.

### Ajustes feitos na bancada nesta rodada (genéricos, sem mudar o que se mede)

- `scnStream` agora guarda a tela de cada amostra com borda quebrada em `out/<nome>/stream<taxa>.quebradas.txt` e o instante (`integridadeDuranteStream.instantes_s`). Só as execuções diagnósticas depois desse ajuste têm o arquivo; as três rodadas principais (`ink`, `ink-incremental`, `opentui`) foram feitas antes e só têm a contagem.
- `rss-apos-fim.mjs` (novo): roda o stream por `--stream` s e depois deixa o protótipo ocioso até `--total` s, amostrando RSS e CPU a 1 Hz (`rss.json`: série, medianas, CPU dos últimos 60 s). Usa o `OT_MEMLOG` do protótipo OpenTUI (`process.memoryUsage()` a cada 5 s) como segunda fonte.
- Nenhuma mudança no caminho do executável: o OpenTUI roda do `.exe` compilado pelo Bun, passado inteiro em `--cmd`.

## Máquina e versões [V]

| Item | Valor |
|---|---|
| Sistema | Fedora 45, Linux 7.3.3-300.fc45.x86_64 |
| CPU / RAM | AMD Eng Sample 100-000000296-40_Y, 12 CPUs / 30 GiB |
| Node | 24.18.0 |
| Bun | 1.3.14 |
| tmux | 3.8 |
| Ink | 8.0.0 (+ React 19.3.1, `@inkjs/ui` 2.0.0) |
| OpenTUI | `@opentui/core` e `@opentui/react` 0.9.0 (executável compilado, 120.940.672 bytes; só roda no Bun) |
| Terminal | **somente tmux 3.8 headless**, sem terminal gráfico por trás |

A máquina é o computador de trabalho do dono, com o aplicativo desktop do Claude e o `opencode serve` abertos. Carga média durante as medições: 0,2 a 0,5 [V, `uptime` antes de cada rodada]. Isso é carga de fundo real: os números absolutos de CPU são **dessa máquina** e podem mudar com outra.

## Resultados (160x45, tmux 3.8, execuções sequenciais, uma execução de cada) [V]

Todas as linhas foram medidas aqui. Cada célula é uma execução; **não há repetição para estimar variância**, exceto onde indicado. Fonte: `out/ink/`, `out/ink-incremental/`, `out/opentui/`.

| Medida | Ink | Ink `--incremental` | OpenTUI |
|---|---|---|---|
| **Stream 50/s, 300 s** | | | |
| Digitação p50 / p95 / máx (ms) | 41,1 / 67,6 / 78,5 | 45,0 / 75,4 / 79,7 | 8,6 / 22,5 / 28,9 |
| CPU média / p95 (% de 1 núcleo) | 27,9 / 30,9 | 32,4 / 35,0 | 48,8 / 64,7 |
| RSS início / fim / pico (MB) | 157,0 / 292,8 / 292,8 | 162,2 / 295,3 / 295,3 | 102,5 / 313,5 / 315,6 |
| Quadros sincronizados/s | 17,2 | 16,8 | 46,0 |
| Bytes/s no pty | 228.210 | 121.681 | 222.204 |
| Telas com borda quebrada | 1 / 29 | 0 / 29 | 0 / 29 |
| **Stream 20/s, 300 s** | | | |
| Digitação p50 / p95 / máx (ms) | 46,7 / 75,9 / 80,1 | 46,9 / 78,3 / 83,2 | 3,1 / 15,5 / 21,4 |
| CPU média / p95 (%) | 30,0 / 33,8 | 32,7 / 36,0 | 26,1 / 35,0 |
| RSS início / fim / pico (MB) | 149,9 / 290,0 / 290,0 | 162,3 / 296,7 / 296,7 | 102,0 / 217,0 / 217,0 |
| Quadros sincronizados/s | 21,0 | 20,9 | 19,9 |
| Bytes/s no pty | 277.493 | 64.745 | 89.331 |
| Telas com borda quebrada | 1 / 29 | 0 / 29 | 0 / 29 |
| **Histórico (5.000 msgs + 1.000 passos)** | | | |
| Abertura: 1º quadro / tela estável (ms) | 498 / 651 | 507 / 659 | 930 / 1.234 |
| PageUp/PageDown no chat, p50 / p95 / máx (ms) | 32,4 / 65,8 / 81,9 | 38,6 / 67,7 / 70,8 | 16,9 / 18,3 / 19,7 |
| Teclas perdidas no chat (de 200) | 1 | 0 | 0 |
| PageUp/PageDown no painel, p50 / p95 / máx (ms) | 30,2 / 64,8 / 71,7 | 35,0 / 67,0 / 68,8 | 16,8 / 18,4 / 22,4 |
| Teclas perdidas no painel (de 200) | 0 | 0 | 8 |
| Chat, 2ª rodada, p50 / p95 / máx (ms) | 30,3 / 64,1 / 64,5 | 33,3 / 67,2 / 68,5 | 16,7 / 18,5 / 24,8 |
| RSS antes → depois da rolagem (MB) | 162,6 → 326,1 | 177,3 → 264,7 | 265,0 → 304,8 (máx 335,6) |
| RSS estabiliza na 2ª rodada | sim | sim | **não** (314,7 → 287,3 → 287,0 → 304,8) |
| **Layout** | | | |
| Passos ok / total | 25 / 25 | 25 / 25 | **21 / 25** |
| **Partida e ocioso** | | | |
| Partida ociosa até o 1º quadro, p50 (ms) | 439,5 | 422,3 | 331,7 |
| Partida com histórico até o 1º quadro, p50 (ms) | 502,3 | 509,8 | 926,0 |
| RSS ocioso (MB) | 126,1 | 127,2 | 90,1 |

### Série de RSS durante o stream (MB), tempo desde o início [V]

| Execução | início | 60 s | 150 s | 300 s | tendência no fim |
|---|---|---|---|---|---|
| Ink 50/s | 157,0 | 281,2 | 288,3 | 292,8 | estável |
| Ink 20/s | 149,9 | 281,7 | 284,1 | 290,0 | estável |
| Ink `--incremental` 50/s | 162,2 | 283,9 | 291,6 | 295,3 | estável |
| Ink `--incremental` 20/s | 162,3 | 283,9 | 288,1 | 296,7 | estável |
| OpenTUI 50/s | 102,5 | 197,7 | 241,2 | 313,5 | **+31 MB/min, CPU de 34% para 62%** |
| OpenTUI 20/s | 102,0 | 138,6 | 168,5 | 217,0 | **+17 MB/min, CPU de 20% para 30%** |

### Resposta: o RSS do OpenTUI estabiliza em 300 s?

**Não: cresce durante todos os 300 s (e ainda aos 600 s), embora a taxa de crescimento caia com o tempo** [V, duas execuções de 300 s e uma de 600 s]. Série a 50/s: 102,5 MB (início), 197,7 (60 s), 241,2 (150 s), 313,5 (300 s).

Duas execuções diagnósticas completam a leitura [V, `out/opentui-rss-long` (600 s) e `out/opentui-rss` (90 s a 50/s, ocioso até 270 s: 102,9 MB aos 0 s, 157,6 aos 30 s, 184,7 aos 60 s, 193,3 aos 90 s; depois cai para ~165 MB por volta de 120 s e fica ali até 265 s)]:

| Execução | 0 s | 60 s | 150 s | 300 s | 450 s | 600 s (fim do stream) | depois do fim |
|---|---|---|---|---|---|---|---|
| Stream 50/s por **600 s**, ocioso até 700 s | 101,3 | 173,6 | 232,9 | 315,1 | 341,4 | 352,9 | 292,9 aos 610 s; **292,7 de 630 s a 695 s**, CPU 0% |

- **Em 300 s não estabiliza** (de 233 MB aos 150 s para 315 MB aos 300 s, +33 MB/min). **O crescimento desacelera**: +10 MB/min entre 300 e 450 s e +4,6 MB/min entre 450 e 600 s, ainda positivo no fim. Aos 600 s ainda não havia platô (352,9 MB). Platô além de 600 s: não medido [N].
- **Sem carga não há crescimento**: depois que o gerador para, o RSS cai de uma vez (353 para 293 MB em menos de 10 s; 193 para ~165 MB na execução curta) e fica parado com CPU em 0%. `heapUsed` do `OT_MEMLOG` cai de 81 para 38 MB. Ou seja, parte do pico durante o stream é lixo ainda não coletado (o V8/Bun segura memória sob carga), e o que sobra é proporcional ao conteúdo acumulado (292,7 MB depois de 600 s de stream contra ~165 MB depois de 90 s) [V os números; a interpretação é hipótese, [N]].

Cuidado com a leitura: o crescimento pode acompanhar **o conteúdo acumulado** (a 50/s o OpenTUI chegou a 1.526 mensagens; a 20/s, 617), então "cresce" não distingue vazamento de retenção proporcional ao histórico. A comparação com o Ink não é de cargas idênticas (o gerador do Ink produziu 1.771 mensagens a 50/s). Decidir entre vazamento e retenção **[N]**; o que se pode afirmar é o que a série mostra, e que o CPU do OpenTUI também sobe junto (34% para 62%) enquanto o do Ink fica parado (28,6% nos primeiros 60 s, 27,8% nos últimos).

### Rodada de otimização do Ink (2026-11-15) [V]

Medida com a mesma bancada, execuções sequenciais, uma de cada. **Não substitui** a tabela acima (números de 2026-11-14 mantidos); acrescenta as variantes. Detalhes, flags e diagnóstico em [`../tui-ink/README.md`](../tui-ink/README.md#otimização-2026-11-15). Fonte: `out/base300`, `out/final300`, `out/final300-20`, `out/final-hl` e as variantes de 60 s (`out/v-*`, `out/m-*`, `out/b-*`, `out/f-*`, `out/floor*`).

"Final" = `node --max-semi-space-size=2 --max-old-space-size=96 dist/main.js --key-render flush --ink-patch cache,grid --memo`. "Base" = `node dist/main.js` (sem flags), medida de novo nesta rodada.

| Medida | Ink base (2026-11-14) | Ink base (2026-11-15, `base300`) | Ink final | App de piso (`floor50`, 60 s) |
|---|---|---|---|---|
| Stream 50/s, 300 s: digitação p50 / p95 / máx (ms) | 41,1 / 67,6 / 78,5 | 48,2 / 70,8 / 78,1 | **10,1 / 16,5 / 26,6** | 1,8 / 8,9 / 9,7 |
| Stream 50/s, 300 s: CPU média / p95 (%) | 27,9 / 30,9 | 26,2 / 29,8 | **23,6 / 26,9** | 0,8 / 2 |
| Stream 50/s, 300 s: RSS início → fim / pico (MB) | 157 / 292,8 | mediana 237,9 / máx 244,5 | mediana 142,3 / máx 143,1 | 58,2 |
| Stream 50/s: quadros/s · KB/s no pty | 17,2 · 228 | 17,3 · 223 | 20,1 · 260 | |
| Stream 20/s, 300 s: digitação p50 / p95 / máx (ms) | 46,7 / 75,9 / 80,1 | não repetido | **10,1 / 17,0 / 19,1** | |
| Stream 20/s, 300 s: CPU média (%) · RSS mediana (MB) | 30,0 · 290 | não repetido | **21,7 · 147,3** | |
| Histórico: PageUp/PageDown chat p50 / p95 (ms) | 32,4 / 65,8 | 35,7 / 65,4 (`h-base`) | **7,9 / 14,8** | |
| Histórico: RSS antes → depois (MB) | 162,6 → 326,1 | 177,8 → 265,6 | **119,6 → 158,7** | |
| Layout, passos ok | 25 / 25 | 25 / 25 | 25 / 25 | |

- A diferença entre as duas colunas de base (p50 41,1 contra 48,2 ms; RSS 293 contra 238 MB) é variação entre execuções que não consegui explicar [N]: uma execução cada.
- **O piso da bancada é ~2 ms** (`floor50`, `floor0`): a latência de 10 ms do Ink final é quase toda do app, não da medida.

#### `floor.mjs` (novo): app de piso

O mínimo possível, sem framework: ecoa as teclas numa linha fixa e, com `--out-fps N` (ou o `--rate` que a bancada passa), redesenha a tela inteira N vezes por segundo, com `--bytes B` (padrão 7.000) por quadro, dentro de `?2026h/l`. Serve para medir **o que a bancada custa** (tmux, `send-keys`, `capture-pane`, polling), sem React nem Ink, e como piso de latência e de RSS. `Ctrl+Q` sai.

```bash
node bench.mjs run --name floor50 --cwd . --cmd "node floor.mjs --out-fps 50" --only stream50 --duration 60
node bench.mjs run --name floor0  --cwd . --cmd "node floor.mjs --out-fps 0"  --only stream50 --duration 60   # sem saída: só o custo de ler a tela
```

Resultados (60 s, 30 teclas) [V]: `floor0`: p50 1,5 / p95 10,3 / máx 12 ms, CPU 0%, RSS 50,7 MB. `floor50`: p50 1,8 / p95 8,9 / máx 9,7 ms, CPU 0,8%, RSS 58,2 MB. As bordas "quebradas" que o `analyze` aponta no piso (5/5) vêm do app ser mínimo (sem caixas `╭╮╰╯` completas), não de defeito [V pelo código].

#### Como rodar variantes do Ink

```bash
node bench.mjs run --name final300 --cwd ../tui-ink \
  --cmd "env NODE_ENV=production node --max-semi-space-size=2 --max-old-space-size=96 dist/main.js --key-render flush --ink-patch cache,grid --memo" --only stream50
```

O `--trace ARQUIVO` do protótipo grava JSONL (stdin, handler, escrita, tempo de render, memória) no encerramento. Usei `--trace` nas execuções de stream desta rodada; ele muda pouco a medida mas **não é zero** [N].

## Veredito por critério (números, sem escolher)

Limiares da arquitetura: **a decisão de aceitar ou não os números é do dono**. Aqui estão só os resultados.

| Critério | Ink | OpenTUI |
|---|---|---|
| **Stream** (digitação, CPU, memória) | Funciona em 20 e 50/s. Digitação p50 41–47 ms, p95 68–78 ms (limitada pelo `maxFps` 30; ver abaixo). RSS e CPU estáveis em 300 s. Uma tela em 29 com borda quebrada sem `--incremental`. | Funciona em 20 e 50/s. Digitação p50 3–9 ms, p95 16–23 ms. **RSS e CPU crescem durante todo o stream** (313 MB e 62% de CPU ao fim de 300 s a 50/s). |
| **Rolagem** (5.000 msgs + 1.000 passos) | p50 30–39 ms, p95 64–68 ms; 1 tecla perdida em 400. Abertura em 0,5 s. | p50 17 ms, p95 18 ms; **8 teclas perdidas em 200 no painel**. Abertura em 0,9–1,2 s (cerca de 2x a do Ink). RSS não estabiliza na 2ª rodada. |
| **Layout** (25 passos) | 25/25, também em `--incremental`. | **21/25**: 4 passos com o chat transbordando a tela quando o painel está fechado (abaixo). |

## Problemas observados

### OpenTUI

1. **Layout: o chat transborda a tela com o painel fechado** [V]. Passos reprovados: "Ctrl+J (fecha o painel)", "Alt+J (fecha de novo)", "resize 80x24" e "80x24 + Ctrl+J (painel)". Na tela, a borda direita do chat sai da área visível e aparecem `││` coladas (`out/opentui/layout.screens.txt`). A causa provável é o chat ter `flexGrow` 1 e `flexShrink` 0 sem largura definida quando o painel fecha (`src/App.tsx`, `chatW` fica `undefined`), de modo que o Yoga deixa o conteúdo definir a largura **[N, hipótese lida do código, não testada por correção]**. Não corrigi: o protótipo ficou como medido, para os números do stream e do histórico valerem para o mesmo executável.
2. **Teclas perdidas no painel: 8 em 200** [V]. Acontecem nos índices 24, 25, 74, 75, 124, 125, 174 e 175, isto é, nas fronteiras de blocos de 50 teclas (o ponto onde a rolagem muda de sentido). Que haja relação com o limite do `<scrollbox>` é hipótese **[N]**.
3. **Memória e CPU crescem durante o stream** (acima). Depois do fim da geração o RSS cai e se mantém (ver a resposta acima) [V, `out/opentui-rss` e `out/opentui-rss-long`].
4. **Abertura do histórico ~2x mais lenta** (0,9 s contra 0,5 s) [V], apesar de a partida ociosa ser mais rápida (332 contra 440 ms).
5. **Só roda no Bun** (o `@opentui/core` 0.9.0 usa FFI do Bun; no Node 24 não há FFI) [V: testado nesta máquina]; o cliente final seria um executável de ~121 MB [V]. O `<scrollbox>` faz corte por viewport, não virtualização [V pelo código].

### Ink

1. **Borda quebrada em 1 de 29 amostras sem `--incremental`, nos dois streams, e repete** (também 1 numa execução diagnóstica de 300 s no instante 130,3 s e 1 em outra de 60 s); com `--incremental` foram 0/58 [V]. A tela quebrada tinha as últimas linhas (42 a 45) vazias, o que é compatível com `capture-pane` lendo a grade do tmux no meio do apagar-e-reescrever de um quadro **[N, hipótese]**. Se isso apareceria num terminal real com saída sincronizada (DEC 2026) não foi testado.
2. **A latência de digitação sob stream é limitada pelo `maxFps`** (padrão 30 no protótipo): com `--max-fps 60`, 60 s a 50/s, p50 caiu de ~47 para 29,6 ms e o CPU subiu de 26,5% para 45,3% [V, execuções únicas de 60 s: `out/ink-prod60`, `out/ink-fps60`]. Causa principal = inferência a partir dos números **[N]**.
3. **O modo de desenvolvimento do React custa mais CPU**: 43,3% contra 26,5% em produção a 50/s (1,6x), RSS mediano 291 contra 234 MB [V, execuções únicas de 60 s: `out/ink-dev60`, `out/ink-prod60`]. A latência de digitação não mudou. O número anterior, "cerca de 2x", não se confirmou.
4. **Volume no pty**: sem `--incremental`, 228 KB/s (50/s) e 277 KB/s (20/s); com, 122 KB/s e 65 KB/s [V]. Em SSH ou terminais lentos isso pesa **[N, não medido]**.
5. Problemas de teclado do `TextInput` do `@inkjs/ui` e do Ctrl+J: em [`../tui-ink/README.md`](../tui-ink/README.md).

## Limites e cuidados

- **Só tmux 3.8 headless** [V]. Não medi: terminal gráfico real (kitty, WezTerm, Ghostty, GNOME Terminal, Alacritty), SSH, macOS, Windows, mouse, IME, 256 cores contra truecolor. Qualquer um deles pode mudar latência, quadros/s e a hipótese do corte de borda.
- **Os dois geradores não são idênticos**: no stream de 300 s a 50/s, Ink 1.771 mensagens e 612 passos, OpenTUI 1.526 e 210; a 20/s, 709 e 252 contra 617 e 97. O chat tem 86 colunas no Ink e 76 no OpenTUI. As cargas por quadro não são as mesmas; comparar absolutos exige unificar o gerador.
- **Uma execução por célula**, sem repetição (exceto as diagnósticas do Ink). Não há intervalo de confiança.
- **Carga de fundo da máquina** (aplicativo desktop e `opencode serve`): 0,2 a 0,5 de carga média.
- **A latência de digitação mede tmux + protótipo**: cada leitura é um `capture-pane` por tmux, com custo próprio de alguns ms (a linha de base `baseline_ms` do cenário `startup` mede o do tmux + shell); os p50 de 3 ms do OpenTUI estão perto desse piso e não devem ser lidos como exatos [N, o custo exato da leitura não foi isolado].
- **O que `capture-pane` vê não é, necessariamente, o que um terminal real mostraria** (ver a borda quebrada do Ink).
- A rodada anterior em paralelo com outros agentes (`out/ink-paralelo`, `out/ink-incremental-paralelo`) fica só como registro; não vale como medida.

## O que falta

- Repetir em terminais reais, em SSH, em macOS e em Windows.
- Unificar o gerador dos dois protótipos (mesmas mensagens, passos e larguras).
- Uma execução do OpenTUI mais longa que 600 s e um perfil de heap, para separar vazamento de retenção.
- Corrigir o transbordo do chat no OpenTUI e refazer o `layout` como execução rotulada à parte.
- Repetir cada célula pelo menos 3 vezes para ter dispersão.
