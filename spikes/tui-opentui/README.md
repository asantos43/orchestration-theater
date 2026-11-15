# spikes/tui-opentui — protótipo da TUI em OpenTUI

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10, item "TUI: Ink × OpenTUI"). Código **descartável**. Medido em **2026-11-14** (horário de São Paulo, UTC-3). Marcação: **[V]** verificado localmente · **[S]** fonte secundária · **[N]** não confirmado.

## Máquina e versões [V]

| Item | Valor |
|---|---|
| Sistema | Fedora 45, Linux 7.3.3-300.fc45.x86_64 |
| CPU / RAM | AMD Eng Sample 100-000000296-40_Y, 12 CPUs / 30 GiB |
| Bun | 1.3.14 |
| Node | 24.18.0 |
| tmux | 3.8 (medições com socket próprio, `tmux -L otspike`) |
| `@opentui/core` | 0.9.0 (último `latest` no npm em 2026-11-14) |
| `@opentui/react` | 0.9.0 |
| `react` | 19.2.0 (o `@opentui/react` exige `>=19.2.0`) |
| `react-reconciler` | 0.33.0 (dependência do `@opentui/react`) |
| TypeScript | 7.0.2 (`tsc --noEmit` passa) |

## Escolha da camada: React

`@opentui/react` e `@opentui/solid` existem, ambos 0.9.0 e MIT [V: `npm view`]. Escolhi **React** porque é o mesmo modelo do Ink (a comparação fica justa) e do `packages/client` da arquitetura (zustand vanilla, §5.13). O Solid ficou sem teste.

## Como rodar

```bash
cd spikes/tui-opentui
bun install
bun run start -- --scenario stream --rate 50 --duration 60
bun run start -- --scenario history --messages 5000 --steps 1000
```

- `--duration 0` = sem limite. Ao fim da duração o gerador para e o cabeçalho mostra `(fim)`; o app continua aberto até Ctrl+Q.
- Padrões: `stream` com `--rate 50 --duration 60`; `history` com `--messages 5000 --steps 1000`.
- Executável: `bun run build` gera `dist/otheater-tui`, que aceita os mesmos argumentos.
- `OT_KEYLOG=arquivo` grava cada tecla recebida (nome, ctrl, meta, sequência); `OT_MEMLOG=arquivo` grava `process.memoryUsage()` a cada 5 s.
- Medição rápida: `python3 scripts/medir.py stream|history|resize [--exe dist/otheater-tui]` (usa tmux 160x45).

**Interpretação do gerador** (o contrato era ambíguo): cada tique do gerador acrescenta um pedaço de 1 a 6 palavras à mensagem do assistente em curso; a mensagem fecha ao atingir um tamanho-alvo sorteado de 20 a 400 caracteres (nunca passa de 400), e o pedaço seguinte abre outra. PRNG mulberry32, semente 42, 118 palavras em português com acento. Se o protótipo Ink interpretou "a cada 1 a 6 palavras abre mensagem nova" de outro modo, as mensagens por segundo diferem entre os dois, e isso muda a carga.

## Layout e teclas [V]

Cabeçalho, lateral (elenco e barras de cota `█░`), chat com linha de entrada embaixo, painel de trajetória, rodapé de atalhos; bordas `╭╮╰╯`. Teclas implementadas: Ctrl+B/Alt+B, Ctrl+J/Alt+J, Ctrl+←/→ (passo de 4 colunas), Tab (foco chat/painel), PageUp/PageDown, Enter, Ctrl+Q. O texto digitado usa o `<input>` nativo do OpenTUI. Com a janela abaixo de 100 colunas a lateral vira trilho de 5 colunas. Com o painel fechado, o chat ocupa o resto e Ctrl+←/→ não muda nada.

Rolagem: `<scrollbox>` do OpenTUI com `stickyScroll`/`stickyStart="bottom"`. Ele tem **corte por viewport** (`viewportCulling`, ligado por padrão no código de 0.9.0): só desenha o que está visível. **Não** é virtualização de verdade: os 5.000 elementos React existem e o Yoga calcula o layout de todos.

## Resultados

### Runtime: Bun sim, Node 24 não [V]

- **Bun 1.3.14:** roda. `bun run start` abre na primeira tentativa.
- **Node 24.18.0:** o `.tsx` não roda direto (`ERR_UNKNOWN_FILE_EXTENSION`), então empacotei com `bun build --target=node` e rodei com `node`. O `import '@opentui/core'` funciona (295 exportações), mas `createCliRenderer()` falha com este erro exato:
  `Error: Failed to initialize OpenTUI render library: OpenTUI native FFI is not available for this runtime yet`
- `node --experimental-ffi` não existe no Node 24: `node: bad option: --experimental-ffi`.
- O README do `@opentui/core` 0.9.0 diz que ele roda "no Bun 1.3.14 ou superior, ou no Node.js 26.4.0 ou superior com ESM e `--experimental-ffi`" [V: `node_modules/@opentui/core/README.md`; `engines` do `package.json`: `bun >=1.3.14`, `node >=26.4.0`]. Node 26.4+ **não foi testado** (não instalado aqui) [N].

### Empacotamento (`bun build --compile`) [V]

| Item | Valor |
|---|---|
| `dist/otheater-tui` | 120.940.672 bytes (115,3 MiB) |
| `bun` sozinho | 92.752.752 bytes (88,5 MiB) |
| Acréscimo sobre o `bun` | 28.187.920 bytes (26,9 MiB): `libopentui.so` (8,9 MB), React, core e app |
| Com `--minify` | 119.294.080 bytes (só 1,4% menor) |
| Partida (processo carrega os módulos e sai por erro de argumento) | 0,28–0,30 s |
| Até o primeiro quadro, stream, no tmux | 0,40–0,52 s (3 medições) |
| Até o primeiro quadro, history (5.000 + 1.000), executável | 1,10–1,67 s (5 medições) |
| Até o primeiro quadro, history, `bun run start` | 1,23–1,66 s (5 medições) |

O executável roda de outro diretório (`/tmp`), sem `node_modules` [V]. O custo de "empacotar o Bun junto" é, portanto, cerca de 88,5 MiB mais 27 MiB por plataforma.

### Medição rápida no tmux 160x45 [V]

**Streaming a 50/s por 60 s** (`scripts/medir.py stream`, amostra a cada 1 s do processo `bun`; CPU em % de um núcleo):

| Métrica | Valor |
|---|---|
| CPU média / p95 / máx | 42,4% / 59% / 86% |
| RSS início → fim (máx) | 110 → 209 MB (211) |
| Latência de digitação (mediana / máx, n=15) | 17 ms / 27 ms |
| Mensagens ao fim | 312 |

- A latência inclui o custo do `tmux send-keys` e do `capture-pane` (cada um alguns ms), então é um teto.
- **RSS cresce durante o stream.** Em outra execução de 60 s com `OT_MEMLOG`, o `heapUsed` do JS ficou entre 15 e 54 MB (`external` 6 MB), mas o RSS subiu de 118 para 189 MB. Em uma de 150 s, foi de 145 MB (15 s) para 249 MB (150 s), sem platô. O crescimento está **fora do heap vivo do JS** (memória nativa do Zig/Yoga ou capacidade do heap do Bun) e acompanha o número de mensagens. Se é vazamento ou só proporcional ao conteúdo, **não foi decidido**: a bancada de 5 minutos mostra a tendência [N].
- A CPU sobe um pouco com o tempo (≈30% no começo, ≈50% no fim), coerente com o React recriando a lista de mensagens a cada pedaço (cópia do array e comparação de N elementos memoizados).

**Abertura com 5.000 mensagens e 1.000 passos** (`scripts/medir.py history`):

| Métrica | Valor |
|---|---|
| Até o primeiro quadro | 1,13 s |
| RSS em repouso | 286 MB |
| CPU em repouso | 0,4% |
| 200 PageUp seguidos no chat | RSS 286 → 302 MB; app respondeu |
| Depois de 400 PageUp/PageDown no painel e no chat | RSS 318 MB |
| Latência de digitação, com histórico (mediana / máx) | 6 ms / 9 ms |

Rolagem conferida pelo `capture-pane`: PageUp move o chat uma tela por vez; Tab muda o foco e o PageUp passa a rolar o painel (o rodapé mostra `foco: panel`).

**Redimensionamento** (`scripts/medir.py resize`, `tmux resize-window` entre 160x45, 80x24, 200x60, 80x24 e 160x45): as bordas ficaram íntegras em todos (cantos `╭╮╰╯` nas posições certas e largura exata de cada linha, conferidas por script sobre o `capture-pane`). Em 80x24 o cabeçalho é cortado à direita e a lateral vira trilho.

### Teclas, como chegam ao app dentro do tmux 3.8 [V]

Registro por `OT_KEYLOG`, com `tmux send-keys`:

| Tecla | O que o OpenTUI recebeu |
|---|---|
| Ctrl+B | `name=b ctrl=true` (no tmux real o prefixo do tmux a captura; vale o Alt+B) |
| **Ctrl+J** | `name=linefeed`, sequência `\n`, **distinto** do Enter (`name=return`, `\r`) |
| Alt+B / Alt+J | `name=b/j meta=true`, sequência `ESC b` / `ESC j` |
| Ctrl+←/→ | `name=left/right ctrl=true`, `ESC[1;5D` / `ESC[1;5C` |
| PageUp/PageDown, Tab, Ctrl+Q | `pageup`, `pagedown`, `tab`, `q ctrl=true` |

O app trata `linefeed` como Ctrl+J. Isso foi testado **só no tmux**, não nos outros terminais do item "matriz de terminais" [N].

### Licença e dependências nativas

- **`@opentui/core`, `@opentui/react`, `@opentui/solid`: MIT** [V: campo `license` do `package.json` instalado e `npm view`; texto do `LICENSE` em `https://raw.githubusercontent.com/anomalyco/opentui/main/LICENSE`, "MIT License, Copyright (c) 2025 opentui", lido em 2026-11-14]. O repositório é `https://github.com/anomalyco/opentui` (o antigo `github.com/sst/opentui` redireciona com 301).
- **Binários nativos pré-compilados: `MIT AND LGPL-2.1-or-later`** [V: campo `license` dos pacotes `@opentui/core-<plataforma>@0.9.0`]. O motivo está no `FFMPEG-SOURCE.md` do pacote: o `libopentui.so` **linka estaticamente** um FFmpeg 9.0.2 reduzido (decodificação MOV/MP4/H.264/AAC), licença LGPL-2.1-or-later, com GPL e não livre desativados. Com `bun build --compile`, esse código vai dentro do executável. **A arquitetura (§6.0, P11) proíbe LGPL em dependências empacotadas.** Isto é uma decisão do dono, não minha: o spike não decide.
- Demais licenças nos pacotes nativos [V: arquivos `LICENSE-*`]: Ghostty (MIT), LCMS2 (MIT), WUFFS (Apache-2.0), libwebp (BSD), stb, zlib. O pacote tem ainda `PATENTS-LIBWEBP`.
- Dependências JS [V: `npm view` e `package.json` instalados]: `diff` 9.0.0 (BSD-3-Clause), `string-width` 7.2.0 (MIT), `bun-ffi-structs` 0.3.1 (MIT), `react-reconciler` 0.33.0 (MIT), `scheduler` 0.27.0 (MIT), pares `web-tree-sitter` 0.25.10 (MIT), `ws` 8.23.0 (MIT), `react-devtools-core` 7.0.1 (MIT).
- **Plataformas** (`optionalDependencies` do `@opentui/core@0.9.0`) [V: `npm view`, 2026-11-14]: `core-linux-x64`, `core-linux-x64-musl`, `core-linux-arm64`, `core-linux-arm64-musl`, `core-darwin-x64`, `core-darwin-arm64`, `core-win32-x64`, `core-win32-arm64`. Logo, **há binário pré-compilado para Windows x64, macOS arm64, macOS x64 e Linux x64**. Tamanho descompactado: 7,2 a 9,7 MB cada. Só o de Linux x64 foi **instalado e executado** aqui (o `bun add` baixou também o `-musl`); os demais só foram listados no registro [V para a lista; N para o funcionamento]. O README do core diz que Windows arm64 pede Bun 1.4.0 ou superior [S: README do pacote].

## Problemas e limites

1. **LGPL no binário nativo** (acima), em conflito com a regra de licenças da arquitetura.
2. **Node 24 não roda**; a documentação pede Node 26.4+ com `--experimental-ffi`, e o OpenTUI só roda no Bun aqui. O executável leva o Bun (88,5 MiB).
3. **RSS crescente** durante o stream (acima); precisa da medição de 5 minutos.
4. `bun run start` cria um processo `bun run` pai e um filho; a bancada deve medir o filho (o que roda `src/main.tsx`) ou usar o executável.
5. O LSP de TypeScript estava listado como ferramenta, mas **não inicializou** (`Could not find a valid TypeScript installation`: o TypeScript 7.0.2 local não traz `tsserver`). A checagem de tipos foi por `tsc --noEmit`, que passa.
6. Scrollbox por corte de viewport, não virtualizado: os 5.000 elementos React ficam vivos (RSS em repouso de 286 MB com o histórico).
7. Não medi: matriz de terminais (só tmux), SSH, mouse (desligado), Node 26.4+, Windows e macOS.
