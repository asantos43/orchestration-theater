<!-- SPDX-License-Identifier: MPL-2.0 -->

# Roteiro manual da TUI nos terminais [proposta]

Roteiro curto (P20 da Fase 7, N191; arquitetura §5.13) para o dono passar na TUI do OTheater no **Windows
Terminal** e num terminal de **macOS** ou **Linux**. O teste de fumaça (`packages/tui/src/tmux.smoke.test.ts`)
prova que a TUI abre, que as teclas do mapa chegam a ela e que `ot` sozinho a abre, tudo num tmux. Ele **não**
prova o que cada terminal envia: este roteiro cobre o que só um terminal de verdade mostra. Nada aqui foi
conferido ainda. Quem passar o roteiro troca os `[N]` da tabela do fim por `[V: <data>]` (passou) ou
`[X: <o que falhou>]` (falhou).

## Antes de começar

- O OTheater compilado (`pnpm install --frozen-lockfile` e `pnpm build`), e o daemon com o `fake-agent`, para
  não gastar cota: na raiz do repositório, abra um terminal e rode `node packages/daemon/dist/cli.js daemon`.
  [proposta: se o seu ambiente já tem um daemon de teste, use-o; o roteiro não precisa de cliente real.]
- Abra a TUI em **outro** terminal, o que está sendo conferido: `node packages/daemon/dist/cli.js` (sem
  argumento: abre a TUI quando a entrada e a saída são um terminal, N195) ou `... tui`.
- Anote na tabela do fim: o terminal, a versão, o sistema e o shell. Tamanho de partida sugerido: 120x36 ou mais.
- Para cada item, **faça** o que está escrito e compare com o **esperado**. Se a tecla ou o efeito não vier,
  anote o que apareceu (a tecla fica `[X]`; não conserte na hora).
- Uma tecla que o terminal, o multiplexador ou o sistema guardam para si não chega à TUI. Isso também é
  resultado: anote qual tecla e quem a guardou.

## 1. Abertura

1. **Faça:** abra a TUI.
   **Esperado:** três áreas na tela (a barra lateral "Navigation", o chat e o painel de trabalho), o cabeçalho
   com o cenário e o endereço do daemon, sem texto quebrado nem borda partida. Os acentos e as bordas (`╭ ─ │`)
   saem como desenho, não como `?` ou quadrados.
2. **Faça:** feche com `Ctrl+Q`.
   **Esperado:** a TUI sai e o terminal volta como estava: sem tela alternativa presa, cursor visível, o mouse
   não "pula" mais ao mexer (nenhuma sequência estranha aparece no prompt).

## 2. Teclas

Em cada linha: **faça** a tecla e **espere** o efeito. As teclas vêm do mapa (`packages/client/src/ui/default-registry.ts`).

| Tecla | Esperado |
| --- | --- |
| `Alt+S` | esconde e mostra a barra lateral |
| `Alt+J` | esconde e mostra o painel de trabalho |
| `F5` | abre a aba Settings do painel |
| `Alt+A` | abre o seletor de abas ("Open a tab"); `Enter` abre a aba escolhida |
| `Alt+W` | fecha a aba ativa |
| `Alt+K` e `F1` | abrem a paleta de comandos; `Esc` fecha |
| `Tab` e `Shift+Tab` | passam o foco entre as áreas, e a área com o foco aparece marcada |
| `Ctrl+Shift+←` e `Ctrl+Shift+→` | estreitam e alargam o chat |
| `PageUp`, `PageDown`, `Ctrl+Home`, `Ctrl+End` | rolam o chat |
| `Ctrl+J`, `Shift+Enter`, `Alt+Enter` | quebram a linha na caixa de texto (sem enviar) |
| `Enter` | envia o que está na caixa de texto |
| `Alt+B`, `Alt+F`, `Alt+Backspace` | andam e apagam por palavra na caixa de texto |
| `Ctrl+R`, `Ctrl+G` | busca no histórico; abre o editor externo |
| `Ctrl+Q` | sai |

Marque na tabela do fim, por terminal, **cada** tecla que não fez o efeito. Atenção especial a `Ctrl+Shift+←/→`,
`Shift+Enter` e `Alt+...`: são as que mais variam de terminal para terminal.

## 3. Mouse (`ui.mouse`)

Padrão `full`. Teste também `wheel` e `off` (chave `ui.mouse` na configuração; reinicie a TUI depois de mudar).

1. **Faça** (`full`): gire a roda sobre o chat com bastante texto; clique numa aba do painel; clique no `▾` de uma
   seção; clique numa entrada da barra lateral; arraste a borda do chat.
   **Esperado:** a roda rola o chat, o clique troca a aba, dobra e desdobra a seção, abre o item e a borda
   acompanha o mouse. O teclado continua fazendo tudo.
2. **Faça** (`wheel`): repita.
   **Esperado:** só a roda age; clique e arrasto não fazem nada na TUI, e a seleção normal do terminal volta.
3. **Faça** (`off`): repita.
   **Esperado:** nada do mouse age na TUI; a seleção normal do terminal funciona.

## 4. Cópia (`ui.clipboard.copy`)

Padrão `osc52`; os outros modos são `system`, `auto` e `off`. Cole o resultado fora da TUI (no bloco de notas,
no shell...) para ver o que foi copiado.

1. **Faça** (`osc52`, mouse `full`): arraste com o mouse sobre um trecho do chat e solte.
   **Esperado:** o trecho fica selecionado na TUI e o texto copiado está na área de transferência. Se o
   terminal bloqueia OSC 52 por padrão, anote o nome da opção que o libera.
2. **Faça** (mouse `full`): **Shift+arrastar** (no macOS, **Option+arrastar**) sobre um trecho.
   **Esperado:** é a seleção do próprio terminal que age. Copie com o atalho do terminal e confira.
   [a confirmar: é o que a arquitetura registra como [a confirmar no teste de terminais].]
3. **Faça** (`system`): repita o item 1.
   **Esperado:** a cópia sai pela ferramenta do sistema (`pbcopy`, `wl-copy`, `xclip`, `xsel` ou `clip.exe`).
   Sem a ferramenta, a TUI avisa em vez de falhar calada.
4. **Faça** (`off`): repita o item 1.
   **Esperado:** nada vai para a área de transferência.
5. **Faça** (`osc52`, dentro de **tmux**, com `set -g set-clipboard on`): repita o item 1.
   **Esperado:** o texto chega à área de transferência do sistema. Anote o resultado sem a opção também.

## 5. Colagem

1. **Faça:** cole na caixa de texto um texto de várias linhas (copiado de fora).
   **Esperado:** o texto entra inteiro na caixa, com as quebras de linha, e **nada é enviado** ao Diretor até
   você apertar `Enter`.
2. **Faça:** cole um texto grande (umas 200 linhas).
   **Esperado:** entra sem travar a TUI de forma visível, e apagar tudo deixa a caixa limpa.

## 6. Redimensionar

1. **Faça:** arraste a borda da janela (ou use o atalho do terminal) de larga para estreita: 120, 80, 50
   colunas e de volta a 150.
   **Esperado:** a TUI refaz o quadro a cada tamanho, sem restos de desenho antigo: o painel de trabalho some
   perto de 80 colunas, a barra lateral vira uma tira estreita perto de 50, e tudo volta ao alargar.
2. **Faça:** reduza a altura até umas 12 linhas.
   **Esperado:** a TUI continua usável (nada de tela embaralhada) e se recompõe ao crescer.
3. **Faça:** coloque o terminal em tela cheia e saia dela.
   **Esperado:** o mesmo.

## 7. Option como Meta no macOS (só macOS)

1. **Faça** (Terminal.app): com a opção "Usar Option como tecla Meta" **desligada** (padrão), aperte `Alt+S`
   (Option+S) e `Alt+K` (Option+K).
   **Esperado:** a TUI avisa que o Option não chega como Meta e diz como ligar (aviso de ambiente, que a
   arquitetura marca como [hipótese: não confirmada em terminal real]). Sem o aviso, ou com outro texto, anote.
2. **Faça:** ligue a opção (Terminal.app: Ajustes > Perfis > Teclado > "Usar Option como tecla Meta"; iTerm2:
   Perfil > Teclas > "Esc+" no Option esquerdo) e repita.
   **Esperado:** `Alt+S`, `Alt+J`, `Alt+A`, `Alt+W` e `Alt+K` agem, sem digitar `ß`, `∆` ou outro caractere
   especial na caixa de texto.
3. **Faça:** aperte `F5` e `F1`.
   **Esperado:** agem. Em teclados de notebook as teclas F podem exigir `Fn`; anote se exigiram.

## 8. SSH

1. **Faça:** de um terminal, entre por SSH numa máquina Linux que tenha o OTheater (ou um daemon alcançável) e
   abra a TUI lá. Se não houver máquina, use `ssh localhost`.
   **Esperado:** a TUI abre, as teclas da seção 2 agem.
2. **Faça:** repita a cópia da seção 4 (`osc52`).
   **Esperado:** o texto chega à área de transferência **da máquina onde você está sentado**, não da remota.
3. **Faça:** repita a seção 6 (redimensionar) pelo SSH.
   **Esperado:** a TUI acompanha o novo tamanho.
4. **Faça:** feche o terminal sem sair da TUI (fecha a janela, ou derruba a conexão).
   **Esperado:** na máquina remota **nenhum** processo `node ... tui/dist/main.js` fica para trás, parado ou
   gastando CPU (confira com `ps`). O teste de fumaça já cobre o pty que some num tmux (a TUI sai sozinha); este item confere o caso real,
   de uma conexão SSH que cai.

## Tabela de terminais

Uma linha por terminal. Troque `[N]` por `[V: data]` (passou), `[X: o que falhou]` (falhou) ou `[-]` (não se
aplica ao terminal). O que não foi conferido fica `[N]`.

| Item | Windows Terminal | macOS (Terminal.app ou iTerm2) | Linux (terminal do dono) | Outro |
| --- | --- | --- | --- | --- |
| Terminal, versão, sistema e shell | [N] | [N] | [N] | [N] |
| 1. Abertura e saída limpa | [N] | [N] | [N] | [N] |
| 2. Teclas: `Alt+...` (S, J, A, W, K) | [N] | [N] | [N] | [N] |
| 2. Teclas: `F1` e `F5` | [N] | [N] | [N] | [N] |
| 2. Teclas: `Ctrl+Shift+←/→` | [N] | [N] | [N] | [N] |
| 2. Teclas: `Shift+Enter`, `Alt+Enter`, `Ctrl+J` | [N] | [N] | [N] | [N] |
| 2. Teclas: `Alt+B`, `Alt+F`, `Alt+Backspace` | [N] | [N] | [N] | [N] |
| 2. Teclas: `PageUp`, `PageDown`, `Ctrl+Home`, `Ctrl+End` | [N] | [N] | [N] | [N] |
| 3. Mouse `full` | [N] | [N] | [N] | [N] |
| 3. Mouse `wheel` e `off` | [N] | [N] | [N] | [N] |
| 4. Cópia `osc52` | [N] | [N] | [N] | [N] |
| 4. Cópia Shift+arrastar (Option no macOS) | [N] | [N] | [N] | [N] |
| 4. Cópia `system`, `off` | [N] | [N] | [N] | [N] |
| 4. Cópia por OSC 52 dentro do tmux | [N] | [N] | [N] | [N] |
| 5. Colagem de várias linhas | [N] | [N] | [N] | [N] |
| 6. Redimensionar | [N] | [N] | [N] | [N] |
| 7. Option como Meta | [-] | [N] | [-] | [N] |
| 8. SSH (teclas, cópia, redimensionar) | [N] | [N] | [N] | [N] |
| 8. Terminal fechado sem processo sobrando | [N] | [N] | [N] | [N] |

Quando o roteiro for passado, o resultado (e o que sair `[X]`) vai para o PR do passo seguinte ou para um
registro do orquestrador; este arquivo guarda só o roteiro e a tabela.
