# spikes/tui-mockup-ink — as 4 telas do mockup da TUI em Ink

Spike da Fase 0 ([arquitetura](../../docs/framework-ideas/arquitetura.md), §10, item "TUI: Ink × OpenTUI"). Código **descartável**. Feito em **2026-11-15** (horário de São Paulo, UTC-3). Pergunta: o Ink reproduz o [mockup](../../docs/framework-ideas/mockup/tui.html) (grade de 140x42, telas `main`, `traj`, `config` e `focus`) com componentes próprios, teclado e mouse?

Marcação: **[V]** verificado localmente nesta data · **[S]** fonte secundária · **[N]** não confirmado.

Resposta curta: **sim** [V]. As quatro telas saem **idênticas ao mockup, célula a célula, no texto, na cor de frente, no fundo e no negrito** (5880 de 5880 células em cada uma), tanto em `renderToString` quanto numa sessão tmux real. O teclado e o mouse funcionam sobre o estado. O mouse **exigiu um caminho próprio no stdin** (seção "Mouse").

## Versões e máquina [V]

| Item | Valor |
|---|---|
| Sistema | Fedora 45, Linux 7.3.3-300.fc45.x86_64 |
| Node | 24.18.0 |
| tmux | 3.8 (socket próprio, `-f /dev/null`, 140x42; `TERM` do tmux) |
| `ink` | 8.0.0 |
| `@inkjs/ui` | 2.0.0 (instalado, **não usado**: ver "O que ficou de fora") |
| `react` | 19.3.1 |
| Ferramentas | TypeScript 7.0.2, `esbuild` 0.28.2, `tsx` 4.23.15 |
| Licenças das dependências (55 pacotes) | MIT (51), Apache-2.0 (2: `typescript` e o binário nativo dele, só de desenvolvimento), ISC (1: `signal-exit`), `MIT OR CC0-1.0` (1: `type-fest`). Nenhuma fora da lista permitida [V] |

## Como rodar

```bash
cd spikes/tui-mockup-ink
npm install --ignore-scripts
npx tsc --noEmit                       # limpo [V]
npm start -- --screen main             # dev, com tsx
npm run build && node dist/main.js     # ou o bundle do esbuild

# num terminal de 140x42 (ou maior), sem depender do tamanho da janela atual:
tmux -L otmock -f /dev/null new-session -s m -x 140 -y 42 'cd spikes/tui-mockup-ink && npm start'
tmux -L otmock kill-server             # ao terminar (só esse socket)

npm run compare                        # conferência com o mockup (seção abaixo)
```

Flags: `--screen main|traj|config|focus`, `--mouse full|wheel|off` (padrão `full`), `--input filter|tap` (padrão `filter`; ver "Mouse"), `--help`. Depuração: `OTM_DEBUG=/caminho/log node dist/main.js` grava cada evento de mouse (com os alvos sob o ponteiro) e cada tecla recebida por `useInput`.

Teclas (todas conferidas numa sessão tmux [V], exceto onde indicado):

| Tecla | Efeito |
|---|---|
| F2 / F3 / F4 / F5 | presets `main` / `traj` / `config` / `focus` (F-keys chegam pelo caminho próprio do stdin) |
| F6 | abre a aba Plugins (placeholder) |
| Ctrl+B ou Alt+B | recolhe a lateral e mostra o trilho (Ctrl+B não digita "b" no chat) |
| Ctrl+J, Alt+J | fecha e abre o painel (Ctrl+J chega ao Ink como `\n`) |
| Ctrl+←/→ | largura do chat |
| Ctrl+T / Ctrl+W | abre e fecha abas |
| Tab | troca o foco (chat, painel, lateral) |
| Enter | recolhe a seção sob o cursor (painel); envia (chat) |
| 1 / 2, ↑↓, Enter, Esc | decisão do Produtor (escolhe, move, confirma, "depois") |
| Shift+↑↓ | reordena os Executores em Configurações, Papéis |
| Ctrl+K | paleta de comandos, como sobreposição (`position="absolute"`) |
| Ctrl+Q | sai |

Tela cheia no buffer alternativo, redesenho ao redimensionar (140x42 para 80x24 e de volta, testado [V]) e degradação em 80x24 (lateral vira trilho, painel encolhe; sem erro, mas apertado: ver "O que ficou de fora").

## Estrutura

```
src/
  fixtures.ts        dados ilustrativos, separados dos componentes (como seria com packages/client)
  state.ts           State, presets, computeLayout (degradação), reducer
  theme.ts           cores hex do CSS do tui.html -> props do <Text>
  text.ts            pad/rpad/wrap/bar/wbar e o Canvas (uma linha de células com estilo e alvo de clique)
  views.ts           funções puras: cada região da tela vira linhas de Parts (lógica copiada do tui-render.js)
  hit.tsx            PBox + Registry (localização de clique com useBoxMetrics) e Line
  components/Frame.tsx, Palette.tsx
  view.tsx           View({st, cols, rows}): a tela como função pura
  input.ts, mouse.ts caminho próprio do stdin (filter/tap), SGR, F-keys, ligar/desligar o mouse
  app.tsx, main.tsx  estado, teclado (useInput) e mouse; ponto de entrada
scripts/
  mockup-grid.cjs    CÓPIA das linhas 6 a 298 de docs/framework-ideas/mockup/tui-render.js + gridOf(id)
  compare.tsx        a conferência com o mockup
```

`mockup-grid.cjs` é cópia (sha256 de `tui-render.js`, primeiros 16 caracteres: `80bece9f420dd7ac`); **nada em `docs/` foi alterado**. Se o mockup mudar, a cópia precisa ser refeita.

## Decisões de implementação

**Frame (título embutido na borda).** O Ink não tem título de borda. As alternativas eram (a) `Box` com `borderStyle` e uma sobreposição absoluta com o título por cima da borda de cima, ou (b) `borderTop={false}` e `borderBottom={false}`, com as linhas de cima e de baixo escritas à mão. Escolhi **(b)**: a borda de cima (título, `« ^B`) e a de baixo (rótulo `◂ 56 col ▸ ^←/^→`) são linhas montadas célula a célula, cada trecho com estilo e alvo de clique próprios, sem depender da ordem de pintura de caixas sobrepostas; as laterais `│` continuam sendo a borda do Ink. Só a alça `┃` da borda direita do chat é sobreposição absoluta (`position="absolute" right={-1}`, sem `overflow="hidden"` no Box do meio para a alça não ser recortada). Contraparte: o Frame sabe a própria largura (`w`) e fatia o conteúdo em JavaScript; ele não é um contêiner flexível de verdade. [V]

**Canvas e Parts.** Cada linha do mockup é uma linha de células `{c, k}` com coordenadas da tela (o mesmo modelo do `tui-render.js`). As funções de `views.ts` escrevem nela com `put/seg/fill/recolor/hitAll` e devolvem `Parts` (`[texto, classe CSS, alvo de clique]`). Os componentes só desenham: cada linha vira `<Box flexShrink={0} height={1}>` com um `<Text>` por trecho. Isso reproduz o mockup célula a célula (inclusive os truncamentos sem reticências do `rpad`), mas **não é "React idiomático"**: a composição por flexbox só aparece no nível dos painéis. Para um `packages/client` real, o custo é decidir se a lógica de posição fica em funções puras como aqui ou migra para `Box` aninhados. [V]

**Estilo.** `theme.ts` copia as classes do CSS (`.b`, `.acc`, `.dim`, `.sel`, `.tab-on`, ...; várias classes por célula, `wk` mistura 60% da cor com o fundo, como o `opacity` do CSS). Cores hex em `color` e `backgroundColor` do `<Text>`; o Ink emite truecolor com `FORCE_COLOR=3` e nos terminais que anunciam isso. [V]

**Linha selecionada com fundo em toda a largura.** `recolor` aplica a classe `sel` em todas as células da linha, e o fundo vai em cada `<Text>` da linha. [V]

**Linha de entrada própria.** O estado guarda `input` e o `useInput` o edita. O `TextInput` do `@inkjs/ui` não foi usado: o relato do spike anterior é que ele insere "b" com Ctrl+B [S: enunciado desta tarefa; não reexecutei o `TextInput` aqui]. Com a linha própria, Ctrl+B recolhe a lateral e não digita nada [V].

**Estado e teclado.** `reducer` puro (`state.ts`) com a ação `Action`; `useInput` só traduz tecla em ação. `useInput` **não** entrega F2..F5 (chegam com `input=''` e o `Key` não tem campo de função), Ctrl+J chega como `'\n'`, Alt+B como `key.meta`, Ctrl+←/→ como `ctrl` mais `leftArrow/rightArrow`, Shift+↑ como `upArrow` com `shift` [V, lido no código do Ink e conferido no tmux].

**Replicado do mockup de propósito (quirks).** A última linha do texto da decisão sai sem negrito; `rpad` trunca sem reticências (a coluna de executores das demandas vira 13 caracteres); o rodapé tem "F5 Config" enquanto F2..F5 são presets (em F5 o mockup mostra a tela só do chat). No spike, clicar na dica "F5 Config" abre a aba Configurações (ação do rodapé), e a tecla F5 faz o preset `focus`: **a inconsistência do mockup foi mantida, não resolvida**.

**Dados.** Todos vêm do mockup. Os de `Eventos` e `Fontes do sinal de cota` (seções recolhidas por padrão) o mockup só mostra como título; o conteúdo expandido é **inventado** neste spike, só para a expansão ter o que mostrar [V, está em `fixtures.ts`].

## Conferência com o mockup [V]

`npm run compare` renderiza cada tela com `renderToString(<View/>, {columns: 140})` com `FORCE_COLOR=3`, lê o ANSI de saída (parser próprio: `38;2`, `48;2`, `39`, `49`, `1`, `22`, `0`) e compara célula a célula com a grade de `mockup-grid.cjs`. A cor esperada vem do **CSS lido de `tui.html`** (não do `theme.ts`), então a conferência de cor é independente do código testado. Com `--print <tela> --size 80x24` imprime a tela renderizada sem comparar.

| Tela | Texto | Cor de frente | Fundo | Negrito | Linhas com diferença |
|---|---|---|---|---|---|
| `main` | 5880/5880 (100,00%) | 3006/3006 | 5880/5880 | 3006/3006 | 0 |
| `traj` | 5880/5880 (100,00%) | 2663/2663 | 5880/5880 | 2663/2663 | 0 |
| `config` | 5880/5880 (100,00%) | 2892/2892 | 5880/5880 | 2892/2892 | 0 |
| `focus` | 5880/5880 (100,00%) | 1934/1934 | 5880/5880 | 1934/1934 | 0 |

Cor de frente e negrito contam só as células com caractere visível. Conferido também numa **sessão tmux real** (140x42, F2..F5 e `capture-pane`): texto 100,00% nas quatro telas contra a mesma grade [V]. As cores no tmux não foram comparadas célula a célula, só olhadas por amostra no `capture-pane -e` (a cor medida é a do `renderToString`).

A primeira rodada deu 99,39% a 99,57% de texto e 95% a 97% de cor. As duas diferenças relevantes, ambas corrigidas:

1. **Largura da aba.** Eu somava 5 colunas por aba (`' nome ✕ '` mais o separador) onde o rótulo tem `nome.length + 4` e o separador `│` é desenhado à parte: cada aba saía 1 coluna mais larga, e o sublinhado `━` e o `+ ^T` se deslocavam. O mesmo número (`+5`) é usado no cálculo de `full`, o que confundiu a leitura do `tui-render.js`. Corrigido para `+4`.
2. **`#fff` contra `#ffffff`.** O CSS usa `#fff`; a saída do Ink é `#ffffff`. Era diferença do comparador (as 59 células do cabeçalho, as linhas `sel` e `tab-on`), não da tela. O comparador expande o hex curto.

**Limites do que isso prova.** A referência é o `tui-render.js` do mockup (a grade de texto que ele gera), não uma captura do HTML no navegador. Largura de glifos como ⚙ ◫ ⟩ ⋮ ↻ coincidiu entre Ink (string-width) e tmux 3.8 nesta máquina, mas **não testei** em outros terminais nem com fontes diferentes [N]. Desempenho (quadros por segundo, uso de CPU) **não foi medido aqui**: é da bancada em `spikes/tui-bench`.

## Mouse (N34)

Implementado em `src/mouse.ts` e `src/input.ts`. Liga `?1000h ?1002h ?1006h` (rastreio SGR com arrasto) na entrada e desliga na saída. `--mouse wheel` liga só `?1000h ?1006h` (o app trata só a roda e ignora o resto); `--mouse off` não liga nada.

| Função | Resultado [V] (tmux, sequências SGR enviadas com `send-keys -l`) |
|---|---|
| Roda rola o chat | funciona (3 linhas por tique, indicador ▲; só quando o ponteiro está sobre o chat) |
| Clique em aba / no ✕ / em `+` / em `⟩` | funciona |
| Clique em seção recolhível | funciona (expande e recolhe) |
| Clique na opção da decisão (1, 2, "depois") | funciona; resolve a decisão e acrescenta a mensagem do Produtor |
| Clique em cenário da lateral, em dica do rodapé | funciona (`^J Painel` fecha e abre o painel) |
| Arrastar a alça ┃ da borda do chat | funciona: a largura do chat muda durante o arrasto e o rótulo `◂ N col ▸` acompanha (os valores exatos medidos não foram anotados) |
| `--mouse wheel` / `--mouse off` | clique ignorado nos dois [V] |
| Desligar na saída | `?1006l ?1002l ?1000l` e saída do buffer alternativo em Ctrl+Q (código 0), Ctrl+C (0), SIGINT (130), SIGTERM (143) e SIGHUP (143), medidos num pty [V]. `uncaughtException` e `unhandledRejection` têm o mesmo tratamento no código, mas **não os provoquei** [N] |

**Localização do clique com `useBoxMetrics`.** `useBoxMetrics` devolve `left/top` relativos ao pai, não à tela. `PBox` mede a si mesmo, soma a origem do pai (contexto) e, com `regId`, registra o retângulo absoluto num `Registry`; o clique procura o menor retângulo que contém o ponto e tem ação conhecida. **Toda caixa da cadeia entre a raiz e um alvo precisa ser `PBox`**: no primeiro teste real um `Box` comum na linha do meio fez todos os retângulos saírem **1 linha acima** (o cabeçalho ficava fora da conta) e nenhum clique acertava; trocar esse `Box` por `PBox` resolveu. `renderToString` não serve para isso (os hooks de terminal viram no-op e `useBoxMetrics` devolve zeros). [V]

### Como ler o mouse sem conflito com o leitor do Ink

O parser de entrada do Ink (`input-parser.js` e `components/App.js`) **descarta** as sequências CSI completas que não viram tecla conhecida, e `useInput` não entrega mouse nem F-keys. Então o mouse **precisou de caminho próprio no stdin** [V, lido no código e confirmado em teste]. Implementei dois caminhos e comparei:

- **`--input tap`**: o Ink lê o `process.stdin` como sempre; o app só adiciona um listener `'data'` ao lado do `'readable'` do Ink e extrai o mouse e as F-keys. Funciona: com o listener `'readable'` do Ink ativo, o `stdin.read()` também emite `'data'`, e os dois leem os mesmos bytes sem um tirar do outro [V]. O Ink continua vendo tudo e descarta o que é mouse.
- **`--input filter`** (padrão): o app lê o stdin real, tira dele as sequências de mouse e de F-key e entrega só o resto ao Ink por um `PassThrough` (com `isTTY`, `setRawMode`, `ref` e `unref` repassados ao stdin real; passado ao `render` na opção `stdin`). Uma sequência partida no fim do chunk espera o próximo (25 ms para `ESC`, `ESC [` e `ESC O`; 250 ms para `ESC [ <...`, que só pode ser mouse) e, vencido o prazo, segue ao Ink, para o Esc sozinho não se perder.

Resultado dos testes de fragmentação (partes enviadas com 150 ms de intervalo, o que é muito mais que o normal; o Ink espera 20 ms antes de despejar uma sequência incompleta como texto) [V]:

| Caso | `tap` | `filter` |
|---|---|---|
| Sequência SGR cortada no meio do número (`ESC[<0;10` e depois `2;3M`) | **vazou como texto** no campo do chat: `[<0;102;3M`. O clique em si foi entendido (a cauda é guardada) | sem vazamento |
| Cortada depois do `;` (`ESC[<0;102;3` e depois `m`) | sem vazamento visível (o `m` final foi tratado) | sem vazamento |
| `ESC` sozinho e 150 ms depois `[<0;90;3M` | **vazou** `[<0;90;3M` | **vazou** igual: `ESC` sozinho é a tecla Esc, e 25 ms vencem |
| Rajada de 20 movimentos seguidos de teclas | sem vazamento | sem vazamento |
| Tecla colada ao mouse no mesmo `write` (`p`, mouse, `q`; mouse e `r`; 3 mouses e `s`) | nenhuma tecla perdida | nenhuma tecla perdida |

Conclusões [V, exceto onde marcado]:
- **Nenhuma tecla se perdeu** em nenhum caso. Em um teste pareceu que teclas sumiam após um vazamento; era o clique que havia movido o foco para o painel (as teclas foram para lá).
- O vazamento do `tap` é o parser do Ink despejando como texto o que sobra de uma CSI incompleta após 20 ms. Em terminal local o terminal escreve a sequência inteira de uma vez, então é raro; sob carga ou por SSH [N: não testei SSH] ele aparece.
- O `filter` elimina o vazamento exceto no caso inevitável do `ESC` isolado com mais de 25 ms de atraso, e custa até 25 ms de latência numa tecla Esc.
- F2..F5/F6: cobertos `ESC O Q/R/S` e `ESC [12~..15~`, `ESC [17~` (xterm e tmux). Não cobertos: console do Linux (`ESC [[B`), protocolo kitty (`CSI u`), F-keys com modificador [N: não testados].
- O custo do `filter`: o app passa a ser dono do stdin, e o Ink precisa aceitar um stream "de mentira" (aceitou sem ressalva na 8.0.0 [V]; um `PassThrough` que imita `setRawMode`/`ref` é frágil se o Ink passar a usar outro método do TTY [N]).

## O que foi difícil no Ink

1. **Título na borda.** Não existe. Frame com linhas à mão (acima).
2. **Teclas.** F-keys e mouse não chegam ao `useInput`; Ctrl+J vira `'\n'` (e Enter é `'\r'`, então ainda dá para distinguir [V]). Foi preciso o caminho próprio do stdin.
3. **Posição absoluta de um clique.** `useBoxMetrics` é relativo ao pai; uma caixa comum na cadeia quebra tudo em silêncio (erro de 1 linha). Ficou a regra "tudo é `PBox`".
4. **`<Text>` não tem altura nem `flexShrink`.** Para o layout não espremer a linha, cada linha vai num `Box flexShrink={0} height={1}`.
5. **Medir sem terminal.** `renderToString` é ótimo para conferência (a saída é uma string com ANSI), mas os hooks de terminal viram no-op, então a `View` é função pura de `(estado, colunas, linhas)` e o mouse só se testa num terminal de verdade.
6. **Larguras pequenas.** `String.prototype.repeat` com contagem negativa derrubou o app ao encolher para 80x24 (exceção sem mensagem útil na tela: o processo saiu com código 1). Corrigido com `rep()` em `text.ts`; só apareceu no teste de redimensionamento [V].
7. **Sobreposições** (`position="absolute"`) funcionam bem para a paleta e a alça ┃, inclusive com `right={-1}` [V].

## O que ficou de fora

- **Trajetórias**: sem navegação por passo pelo teclado (só os passos 3 e 6 abertos, como no mockup); sem `f`, `d`, `e`, `s` (aparecem nas dicas, sem ação).
- **Consumo** e **Plugins**: placeholder de uma linha (o mockup não tem conteúdo para eles). Configurações: só a sub-aba **Papéis** tem conteúdo (como no mockup); as outras sub-abas só trocam o destaque.
- **Sem texto longo no chat**: a linha de entrada é de uma linha só, sem cursor no meio do texto, sem colar, sem histórico, sem `/` e `@` (as dicas aparecem, sem ação).
- **80x24**: não quebra, mas fica apertado: abas e rótulos do painel com 24 colunas se sobrepõem em partes (o cabeçalho e os rótulos à direita das seções somem abaixo de certa largura; o resto fica truncado). O mockup não define essa degradação; o `tui-ink` cuida disso melhor [N: não comparei].
- Sem reconexão, sem dados reais, sem acessibilidade, sem temas claros.
- `@inkjs/ui` ficou instalado e **não é usado**: nenhum componente dele serviu (a linha de entrada, as barras e as abas são próprios). Isto vale como resultado do teste.
- Sem medição de desempenho (é da bancada). Sem teste em outros terminais além do tmux 3.8 (kitty, Alacritty, WezTerm, GNOME Terminal) e sem SSH [N].
- `uncaughtException` e `unhandledRejection` não foram provocados [N].
