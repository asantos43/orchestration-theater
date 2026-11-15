# tui-keys: registrador de teclas

Spike da Fase 0 (arquitetura v0.40, §5.13 e §10). Responde, por terminal, quais teclas do mapa da TUI **chegam** ao programa e com quais bytes. Node puro, sem dependências, sem `package-lock`.

- Datas: 2026-11-14 (primeira versão, mapa da v0.32); 2026-11-15 (mapa da N35, preset `agents`, mais Shift+Enter e o modo `extended-keys` do tmux). Horário de São Paulo.
- Máquina da medição automatizada: Fedora 45, kernel 7.3.3, Node v24.18.0, tmux 3.8.
- Rótulos: **verificado localmente** = medido nesta máquina; **não confirmado** = ainda por medir (pendente do dono).

## Como rodar (em cada terminal)

```sh
cd spikes/tui-keys
node keys.mjs --nome "Windows Terminal 1.22 / PowerShell"
node keys.mjs --nome "Windows Terminal 1.22 / PowerShell, mok" --pedir-mok
```

O programa sonda o terminal (protocolo kitty `CSI ? u`, DA1 e XTVERSION, 400 ms cada), pede cada tecla do mapa (`[i/41] aperte: ...`) e mostra os bytes e o nome decodificado. No fim grava `resultados/<nome>.json` (ou use `--out arquivo.json`).

- `--pedir-mok` pede ao terminal o modifyOtherKeys nível 2 (`CSI > 4 ; 2 m`) na partida e o desliga na saída, como faria uma TUI que quer o Shift+Enter. Rode cada terminal das duas formas.
- Ctrl+C pula o item atual (se a tecla fizer algo no terminal, como abrir aba, pule e anote); Ctrl+C duas vezes seguidas aborta e grava o que houver.
- `node keys.mjs --livre` mostra qualquer tecla (bytes e nome), sem percurso. Ctrl+C duas vezes sai.
- Estados no JSON: `ok` (chegou o esperado), `diferente` (chegou outra coisa; veja `recebido` e `bytes`), `indistinguível do Enter` (Ctrl+J ou Shift+Enter chegou como Enter), `não chegou`, `pulado`.
- Ctrl+Shift+P: "ok" significa chegar igual a Ctrl+P (0x10), isto é, o terminal **não** distingue. `diferente`, com `Ctrl+Shift+P [CSI u]` ou `Ctrl+Shift+P [modifyOtherKeys]`, significa que o terminal distingue.

### O que fazer em cada terminal

1. **Windows Terminal** (PowerShell e WSL, separados): rode com Node para Windows e depois dentro do WSL. Ctrl+W, Ctrl+T, Ctrl+Shift+←/→ e Ctrl+Shift+P podem estar ligados a ações do Windows Terminal (anote). Ctrl+V costuma colar texto.
2. **Terminal do VS Code**: Ctrl+K, Ctrl+W, Ctrl+B, Ctrl+J, Ctrl+G e F1/F5/F6 podem ser capturados pelo VS Code (o terminal integrado repassa só parte; veja `terminal.integrated.commandsToSkipShell`). Repita com `terminal.integrated.sendKeybindingsToShell` ligado, se quiser.
3. **Terminal.app (macOS)**: teste com e sem "Usar Option como tecla Meta" (Ajustes, Perfis, Teclado). Sem Meta, Option+S/J/A/W/K/B/F/D chegam como `ß ∆ å ∑ ˚ ∫ ƒ ∂`; o programa os reconhece. Grave dois JSONs (`--nome "Terminal.app sem Meta"` e `"Terminal.app com Meta"`). Ctrl+←/→ são capturados pelo Mission Control. F5/F6 podem exigir Fn.
4. **iTerm2**: igual ao Terminal.app (Perfis, Teclas, "Left Option key: Esc+"). Dois JSONs. O iTerm2 tem a opção de relatar teclas no protocolo CSI u: anote se ligar.
5. **GNOME Terminal, Ptyxis e Konsole**: um JSON cada (com e sem `--pedir-mok`).
6. **tmux** (qualquer terminal): rode dentro do tmux. Ctrl+B é o prefixo e **não chega** ao programa (ver a coluna aninhada). Anote o `extended-keys` (e o `extended-keys-format`) do seu `~/.tmux.conf`.
7. **SSH**: rode via `ssh` de cada terminal acima; a diferença costuma ser só o `TERM`.

Mande os JSONs (ou preencha a tabela abaixo). Nada sai da máquina: o JSON só traz variáveis de ambiente do terminal (`TERM`, `TERM_PROGRAM`, `WT_SESSION` como "definido", `VTE_VERSION`, etc.), tamanho da janela e as teclas.

## Automação (tmux, Linux)

```sh
node auto-tmux.mjs                       # tmux send-keys direto no gravador
node auto-tmux.mjs --nested              # um tmux externo manda as teclas a um `tmux attach`: cliente tmux real
node auto-tmux.mjs --ext always          # o tmux parte com extended-keys always e extended-keys-format csi-u
node auto-tmux.mjs --ext pedido          # o tmux parte com extended-keys on; o gravador pede o modifyOtherKeys
node auto-tmux.mjs --nested --ext always # as duas coisas (também --nested --ext pedido)
```

Usa soquetes próprios (`otkeys`, `otkeys-in`) e os encerra no fim. Com `--ext`, as opções vão num arquivo de configuração temporário passado com `-f` na partida (e apagado no fim); sem `--ext`, `-f /dev/null`. Saídas em `resultados/tmux-linux-auto[-aninhado][-ext-always|-ext-pedido].json`.

Limites desta automação (verificado localmente):
- `send-keys` **não passa por um terminal de verdade**: o tmux traduz o nome da tecla (`C-S-Left`, `M-b`, `S-Enter`) para bytes ao escrever no pty. Prova o que o tmux entrega ao programa; **não** prova que o Windows Terminal, o iTerm2 etc. gerem essas teclas. Para o Shift+Enter chegar de verdade dentro do tmux, o terminal de fora também tem de mandá-lo distinto do Enter (e o tmux tem de saber disso, `terminal-features` com `extkeys`).
- O `extended-keys` só vale para os painéis criados **depois** de a opção ser ligada. Ligar com `tmux set` numa sessão já aberta não mudou nada (o Shift+Enter continuou `0d`); por isso a automação usa o arquivo de configuração na partida.
- No modo aninhado, o `tmux attach` interno trata o prefixo: Ctrl+B é engolido (`não chegou`). Com `send-keys` direto, o prefixo não é aplicado e a tecla chega, o que **não** reflete uso real dentro do tmux.

## Tabela de resultados

As quatro colunas de tmux foram preenchidas aqui (verificado localmente, 2026-11-15, com os bytes em hexadecimal entre crases). As duas variantes aninhadas com `--ext` deram o mesmo das colunas `always` e `pedido`, exceto o Ctrl+B, que não chegou (como na coluna aninhada). As demais colunas ficam **pendentes do dono** (não confirmado): preencha com `ok`, os bytes que chegaram, ou `não chegou`, e diga se foi com ou sem `--pedir-mok`.

| Tecla | Grupo | Uso na TUI | tmux (send-keys) | tmux aninhado (cliente real) | tmux `extended-keys always` (csi-u) | tmux `extended-keys on` + modifyOtherKeys pedido | Windows Terminal | Terminal do VS Code | Terminal.app | iTerm2 | GNOME Terminal / Ptyxis / Konsole | SSH |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Enter | caixa | enviar / responder decisão | ok `0d` | ok `0d` | ok `0d` | ok `0d` | | | | | | |
| Ctrl+J (tem de ser diferente do Enter) | caixa | nova linha (N35) | ok `0a` | ok `0a` | ok `0a` | ok `1b 5b 32 37 3b 35 3b 31 30 36 7e` | | | | | | |
| Shift+Enter (só onde o terminal distingue do Enter) | caixa | nova linha (N35) | indistinguível do Enter `0d` | indistinguível do Enter `0d` | ok `1b 5b 31 33 3b 32 75` | ok `1b 5b 32 37 3b 32 3b 31 33 7e` | | | | | | |
| Alt+S (macOS: Option+S) | layout | recolher/expandir lateral | ok `1b 73` | ok `1b 73` | ok `1b 73` | ok `1b 5b 32 37 3b 33 3b 31 31 35 7e` | | | | | | |
| Alt+J (macOS: Option+J) | layout | abrir/fechar painel | ok `1b 6a` | ok `1b 6a` | ok `1b 6a` | ok `1b 5b 32 37 3b 33 3b 31 30 36 7e` | | | | | | |
| Ctrl+Shift+← | layout | largura do chat | ok `1b 5b 31 3b 36 44` | ok `1b 5b 31 3b 36 44` | ok `1b 5b 31 3b 36 44` | ok `1b 5b 31 3b 36 44` | | | | | | |
| Ctrl+Shift+→ | layout | largura do chat | ok `1b 5b 31 3b 36 43` | ok `1b 5b 31 3b 36 43` | ok `1b 5b 31 3b 36 43` | ok `1b 5b 31 3b 36 43` | | | | | | |
| Alt+A (macOS: Option+A) | layout | abrir aba | ok `1b 61` | ok `1b 61` | ok `1b 61` | ok `1b 5b 32 37 3b 33 3b 39 37 7e` | | | | | | |
| Alt+W (macOS: Option+W) | layout | fechar aba | ok `1b 77` | ok `1b 77` | ok `1b 77` | ok `1b 5b 32 37 3b 33 3b 31 31 39 7e` | | | | | | |
| Alt+K (macOS: Option+K) | layout | paleta de comandos | ok `1b 6b` | ok `1b 6b` | ok `1b 6b` | ok `1b 5b 32 37 3b 33 3b 31 30 37 7e` | | | | | | |
| F1 | layout | paleta + ajuda | ok `1b 4f 50` | ok `1b 4f 50` | ok `1b 4f 50` | ok `1b 4f 50` | | | | | | |
| F5 | layout | Configurações | ok `1b 5b 31 35 7e` | ok `1b 5b 31 35 7e` | ok `1b 5b 31 35 7e` | ok `1b 5b 31 35 7e` | | | | | | |
| F6 | layout | Plugins | ok `1b 5b 31 37 7e` | ok `1b 5b 31 37 7e` | ok `1b 5b 31 37 7e` | ok `1b 5b 31 37 7e` | | | | | | |
| Ctrl+Q | layout | sair | ok `11` | ok `11` | ok `11` | ok `1b 5b 32 37 3b 35 3b 31 31 33 7e` | | | | | | |
| Ctrl+A | caixa | início da linha | ok `01` | ok `01` | ok `01` | ok `1b 5b 32 37 3b 35 3b 39 37 7e` | | | | | | |
| Ctrl+E | caixa | fim da linha | ok `05` | ok `05` | ok `05` | ok `1b 5b 32 37 3b 35 3b 31 30 31 7e` | | | | | | |
| Ctrl+B | caixa | um caractere para trás (era a lateral até a v0.32) | ok `02` | não chegou | ok `02` | ok `1b 5b 32 37 3b 35 3b 39 38 7e` | | | | | | |
| Ctrl+F | caixa | um caractere para frente | ok `06` | ok `06` | ok `06` | ok `1b 5b 32 37 3b 35 3b 31 30 32 7e` | | | | | | |
| Ctrl+K | caixa | apagar até o fim (era a paleta até a v0.32) | ok `0b` | ok `0b` | ok `0b` | ok `1b 5b 32 37 3b 35 3b 31 30 37 7e` | | | | | | |
| Ctrl+U | caixa | apagar até o início | ok `15` | ok `15` | ok `15` | ok `1b 5b 32 37 3b 35 3b 31 31 37 7e` | | | | | | |
| Ctrl+W | caixa | apagar palavra (era fechar aba até a v0.32) | ok `17` | ok `17` | ok `17` | ok `1b 5b 32 37 3b 35 3b 31 31 39 7e` | | | | | | |
| Ctrl+Y | caixa | colar o que foi apagado | ok `19` | ok `19` | ok `19` | ok `1b 5b 32 37 3b 35 3b 31 32 31 7e` | | | | | | |
| Alt+B (macOS: Option+B) | caixa | palavra para trás | ok `1b 62` | ok `1b 62` | ok `1b 62` | ok `1b 5b 32 37 3b 33 3b 39 38 7e` | | | | | | |
| Alt+F (macOS: Option+F) | caixa | palavra para frente | ok `1b 66` | ok `1b 66` | ok `1b 66` | ok `1b 5b 32 37 3b 33 3b 31 30 32 7e` | | | | | | |
| Alt+D (macOS: Option+D) | caixa | apagar palavra à frente | ok `1b 64` | ok `1b 64` | ok `1b 64` | ok `1b 5b 32 37 3b 33 3b 31 30 30 7e` | | | | | | |
| Ctrl+← | caixa | palavra para trás (era a largura do chat) | ok `1b 5b 31 3b 35 44` | ok `1b 5b 31 3b 35 44` | ok `1b 5b 31 3b 35 44` | ok `1b 5b 31 3b 35 44` | | | | | | |
| Ctrl+→ | caixa | palavra para frente | ok `1b 5b 31 3b 35 43` | ok `1b 5b 31 3b 35 43` | ok `1b 5b 31 3b 35 43` | ok `1b 5b 31 3b 35 43` | | | | | | |
| Ctrl+R | caixa | buscar no histórico | ok `12` | ok `12` | ok `12` | ok `1b 5b 32 37 3b 35 3b 31 31 34 7e` | | | | | | |
| Ctrl+G | caixa | escrever no $EDITOR | ok `07` | ok `07` | ok `07` | ok `1b 5b 32 37 3b 35 3b 31 30 33 7e` | | | | | | |
| Ctrl+V | caixa | colar imagem | ok `16` | ok `16` | ok `16` | ok `1b 5b 32 37 3b 35 3b 31 31 38 7e` | | | | | | |
| Tab | navegação | trocar o foco | ok `09` | ok `09` | ok `09` | ok `09` | | | | | | |
| Shift+Tab | navegação | foco para trás | ok `1b 5b 5a` | ok `1b 5b 5a` | ok `1b 5b 5a` | ok `1b 5b 32 37 3b 32 3b 39 7e` | | | | | | |
| PageUp | navegação | rolar | ok `1b 5b 35 7e` | ok `1b 5b 35 7e` | ok `1b 5b 35 7e` | ok `1b 5b 35 7e` | | | | | | |
| PageDown | navegação | rolar | ok `1b 5b 36 7e` | ok `1b 5b 36 7e` | ok `1b 5b 36 7e` | ok `1b 5b 36 7e` | | | | | | |
| ↑ | navegação | histórico / decisão | ok `1b 5b 41` | ok `1b 5b 41` | ok `1b 5b 41` | ok `1b 5b 41` | | | | | | |
| ↓ | navegação | histórico / decisão | ok `1b 5b 42` | ok `1b 5b 42` | ok `1b 5b 42` | ok `1b 5b 42` | | | | | | |
| Shift+↑ | navegação | reordenar papéis | ok `1b 5b 31 3b 32 41` | ok `1b 5b 31 3b 32 41` | ok `1b 5b 31 3b 32 41` | ok `1b 5b 31 3b 32 41` | | | | | | |
| Shift+↓ | navegação | reordenar papéis | ok `1b 5b 31 3b 32 42` | ok `1b 5b 31 3b 32 42` | ok `1b 5b 31 3b 32 42` | ok `1b 5b 31 3b 32 42` | | | | | | |
| Espaço | navegação | marcar opção | ok `20` | ok `20` | ok `20` | ok `20` | | | | | | |
| Esc | navegação | depois / cancelar | ok `1b` | ok `1b` | ok `1b` | ok `1b` | | | | | | |
| Ctrl+T (só no preset classic) | classic | abrir aba no preset classic | ok `14` | ok `14` | ok `14` | ok `1b 5b 32 37 3b 35 3b 31 31 36 7e` | | | | | | |
| Ctrl+Shift+P (a arquitetura diz que NÃO distingue de Ctrl+P) | conferência | não usado | ok `10` | ok `10` | ok `10` | diferente `1b 5b 32 37 3b 36 3b 31 31 32 7e` | | | | | | |

## Achados (verificado localmente, só tmux 3.8)

- **Shift+Enter.** Sem `extended-keys`, o tmux entrega `0d`, igual ao Enter (inclusive no aninhado). Com `extended-keys always` e formato `csi-u`, entrega `ESC [ 13 ; 2 u`, sem o programa pedir nada. Com `extended-keys on` (o modo em que o tmux só manda as teclas estendidas a quem pede), o programa que pede o modifyOtherKeys nível 2 recebe `ESC [ 27 ; 2 ; 13 ~`. Nos dois casos o `decode.mjs` reconhece o Shift+Enter, e o aninhado também funcionou (com `terminal-features xterm*:extkeys` no tmux interno). O pedido pelo protocolo kitty (`CSI > 1 u`) não teve efeito no tmux: o Shift+Enter continuou `0d` (teste manual com `od`, 2026-11-15).
- **Efeito colateral do modifyOtherKeys pedido.** Com o pedido ligado, o tmux passa a mandar em `ESC [ 27 ; mods ; código ~` também Ctrl+letra (Ctrl+J vira `ESC [ 27 ; 5 ; 106 ~`, Ctrl+B `ESC [ 27 ; 5 ; 98 ~`), Alt+letra (Alt+S vira `ESC [ 27 ; 3 ; 115 ~`) e Shift+Tab (`ESC [ 27 ; 2 ; 9 ~`, em vez de `ESC [ Z`). Teclas especiais (setas, F1 a F6, PageUp/PageDown, Tab, Esc, Enter, Espaço) não mudam. Uma TUI que pedir o modifyOtherKeys tem de decodificar todas essas formas; se a biblioteca de entrada não fizer isso, os atalhos de Ctrl e Alt param de funcionar.
- **O Ink 8.0.0 lê o `CSI u`, mas não o modifyOtherKeys.** Passei as sequências pelo `parse-keypress.js` do Ink instalado em `spikes/tui-ink` (2026-11-15): `ESC [ 13 ; 2 u` vira `return` com `shift`, `ESC [ 106 ; 5 u` vira `j` com `ctrl` e `ESC [ 112 ; 6 u` vira `p` com `ctrl` e `shift`. Já `ESC [ 27 ; 2 ; 13 ~`, `ESC [ 27 ; 5 ; 106 ~`, `ESC [ 27 ; 3 ; 115 ~` e `ESC [ 27 ; 2 ; 9 ~` voltam com nome vazio. Com o Ink, portanto, o caminho que serve é o `CSI u`: o protocolo kitty (opção `kittyKeyboard` do `render`) ou o tmux com `extended-keys-format csi-u`. Com esse formato, até o programa que pede o modifyOtherKeys recebe `CSI u` (teste manual com `od`). Pedir o modifyOtherKeys numa TUI em Ink, sem um decodificador próprio, quebraria os atalhos.
- **Ctrl+Shift+P.** Com o modifyOtherKeys pedido, chega distinto do Ctrl+P (`ESC [ 27 ; 6 ; 112 ~`). A arquitetura diz que só o protocolo kitty distingue; no tmux, o modifyOtherKeys também distingue. Com `extended-keys always` e `csi-u`, o tmux continuou mandando `10`, igual ao Ctrl+P.
- Ctrl+J chega como `0a` e Enter como `0d`: distinguíveis no tmux, em modo bruto. Fora do modo bruto (cooked), os dois viram quebra de linha.
- Alt+letra chega como `ESC letra` (`1b 73`) sem o pedido. Ctrl+←/→ chega como `ESC [ 1 ; 5 D/C`, Ctrl+Shift+←/→ como `ESC [ 1 ; 6 D/C` (o tmux sintetiza a sequência do xterm).
- O terminal sob o tmux anuncia `xtversion = tmux 3.8` e não responde à consulta do protocolo kitty (`kitty: null`).
- Ctrl+B não chega a um programa dentro de um tmux com o prefixo padrão (modo aninhado). No preset `agents` (N35), Ctrl+B é só "um caractere para trás" da caixa de texto; a lateral é Alt+S, que chega.

## Pendências para o dono (não confirmado)

Windows Terminal, terminal do VS Code, Terminal.app (com e sem Option como Meta), iTerm2, GNOME Terminal, Ptyxis, Konsole, SSH em cada um deles, e macOS e Windows em geral, cada um com e sem `--pedir-mok`. Nada disso pôde ser medido nesta máquina pela automação.

## Arquivos

- `keys.mjs`: registrador (modo bruto, sondagem, percurso, JSON; `--pedir-mok`).
- `decode.mjs`: decodificador de bytes (Ctrl, Alt por prefixo ESC, CSI com modificadores, `~`, SS3, `CSI u`, `modifyOtherKeys`, composições do Option no macOS).
- `map.mjs`: o mapa de teclas da §5.13 com os atalhos da N35 (rótulo, grupo, esperado, tecla do tmux, uso na TUI).
- `auto-tmux.mjs`: automação com tmux (`--nested`, `--ext always|pedido`).
- `resultados/`: JSONs por terminal.
