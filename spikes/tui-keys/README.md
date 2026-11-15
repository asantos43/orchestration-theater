# tui-keys: registrador de teclas

Spike da Fase 0 (arquitetura v0.32, §5.13 e §10). Responde, por terminal, quais teclas do mapa da TUI **chegam** ao programa e com quais bytes. Node puro, sem dependências, sem `package-lock`.

- Data: 2026-11-14 (São Paulo).
- Máquina da medição automatizada: Fedora 45, kernel 7.3.3, Node v24.18.0, tmux 3.8.
- Rótulos: **verificado localmente** = medido nesta máquina; **não confirmado** = ainda por medir (pendente do dono).

## Como rodar (em cada terminal)

```sh
cd spikes/tui-keys
node keys.mjs --nome "Windows Terminal 1.22 / PowerShell"
```

O programa sonda o terminal (protocolo kitty `CSI ? u`, DA1 e XTVERSION, 400 ms cada), pede cada tecla do mapa (`[i/29] aperte: ...`) e mostra os bytes e o nome decodificado. No fim grava `resultados/<nome>.json` (ou use `--out arquivo.json`).

- Ctrl+C pula o item atual (se a tecla fizer algo no terminal, como abrir aba, pule e anote); Ctrl+C duas vezes seguidas aborta e grava o que houver.
- `node keys.mjs --livre` mostra qualquer tecla (bytes e nome), sem percurso. Ctrl+C duas vezes sai.
- Estados no JSON: `ok` (chegou o esperado), `diferente` (chegou outra coisa; veja `recebido` e `bytes`), `indistinguível do Enter` (Ctrl+J chegou como Enter), `não chegou`, `pulado`.
- Ctrl+Shift+P: "ok" significa chegar igual a Ctrl+P (0x10), isto é, **confirma** a afirmação da arquitetura de que não se distingue sem o protocolo kitty. Se aparecer como `Ctrl+Shift+P [kitty CSI u]`, o terminal distingue.

### O que fazer em cada terminal

1. **Windows Terminal** (PowerShell e WSL, separados): rode com Node para Windows e depois dentro do WSL. Ctrl+W e Ctrl+T podem ser capturados pelo terminal (anote). Ctrl+Shift+←/→ e Ctrl+Shift+P podem estar ligados a ações do Windows Terminal.
2. **Terminal do VS Code**: Ctrl+K, Ctrl+W, Ctrl+T, Ctrl+B, Ctrl+J e F1/F5/F6 podem ser capturados pelo VS Code (o terminal integrado repassa só parte; veja `terminal.integrated.commandsToSkipShell`). Repita com `terminal.integrated.sendKeybindingsToShell` ligado, se quiser.
3. **Terminal.app (macOS)**: teste com e sem "Usar Option como tecla Meta" (Ajustes, Perfis, Teclado). Sem Meta, Option+B/J/T/W chegam como `∫ ∆ † ∑`; o programa os reconhece. Grave dois JSONs (`--nome "Terminal.app sem Meta"` e `"Terminal.app com Meta"`). Ctrl+←/→ são capturados pelo Mission Control; teste Ctrl+Shift+←/→. F5/F6 podem exigir Fn.
4. **iTerm2**: igual ao Terminal.app (Perfis, Teclas, "Left Option key: Esc+"). Dois JSONs.
5. **GNOME Terminal e Konsole**: um JSON cada.
6. **tmux** (qualquer terminal): rode dentro do tmux. Ctrl+B é o prefixo e **não chega** ao programa (ver a coluna aninhada). Anote também `set -g xterm-keys`/`extended-keys` se mexer.
7. **SSH**: rode via `ssh` de cada terminal acima; a diferença costuma ser só o `TERM`.

Mande os JSONs (ou preencha a tabela abaixo). Nada sai da máquina: o JSON só traz variáveis de ambiente do terminal (`TERM`, `TERM_PROGRAM`, `WT_SESSION` como "definido", `VTE_VERSION`, etc.), tamanho da janela e as teclas.

## Automação (tmux, Linux)

```sh
node auto-tmux.mjs            # tmux send-keys direto no gravador
node auto-tmux.mjs --nested   # um tmux externo manda as teclas a um `tmux attach`: cliente tmux real
```

Usa soquetes próprios (`otkeys`, `otkeys-in`) e os encerra no fim. Saídas em `resultados/tmux-linux-auto.json` e `resultados/tmux-linux-auto-aninhado.json`.

Limites desta automação (verificado localmente):
- `send-keys` **não passa por um terminal de verdade**: o tmux traduz o nome da tecla (`C-S-Left`, `M-b`) para bytes ao escrever no pty. Prova que o tmux entrega essas sequências ao programa; **não** prova que o Windows Terminal, o iTerm2 etc. as gerem.
- No modo aninhado, o `tmux attach` interno trata o prefixo: Ctrl+B é engolido (coluna "tmux aninhado", linha Ctrl+B, `não chegou`). Com `send-keys` direto, o prefixo não é aplicado e a tecla chega, o que **não** reflete uso real dentro do tmux. Portanto: dentro do tmux, Ctrl+B não serve para a lateral, a menos que o usuário troque o prefixo; Alt+B continua chegando.

## Tabela de resultados

As duas colunas de tmux foram preenchidas aqui (verificado localmente, com os bytes em hexadecimal entre crases). As demais ficam **pendentes do dono** (não confirmado): preencha com `ok`, os bytes que chegaram, ou `não chegou`.

| Tecla | Uso na TUI | tmux no Linux (automatizado) | tmux aninhado (cliente real) | Windows Terminal | Terminal do VS Code | Terminal.app | iTerm2 | GNOME Terminal / Konsole | SSH |
|---|---|---|---|---|---|---|---|---|---|
| Enter | enviar / responder decisão | ok `0d` | ok `0d` | | | | | | |
| Ctrl+J (tem de ser diferente do Enter) | abrir/fechar painel | ok `0a` | ok `0a` | | | | | | |
| Ctrl+B | recolher/expandir lateral | ok `02` | não chegou | | | | | | |
| Alt+B (macOS: Option+B) | lateral (alternativa) | ok `1b 62` | ok `1b 62` | | | | | | |
| Alt+J (macOS: Option+J) | painel (alternativa) | ok `1b 6a` | ok `1b 6a` | | | | | | |
| Ctrl+← | largura do chat (Windows/Linux) | ok `1b 5b 31 3b 35 44` | ok `1b 5b 31 3b 35 44` | | | | | | |
| Ctrl+→ | largura do chat (Windows/Linux) | ok `1b 5b 31 3b 35 43` | ok `1b 5b 31 3b 35 43` | | | | | | |
| Ctrl+Shift+← | largura do chat (macOS) | ok `1b 5b 31 3b 36 44` | ok `1b 5b 31 3b 36 44` | | | | | | |
| Ctrl+Shift+→ | largura do chat (macOS) | ok `1b 5b 31 3b 36 43` | ok `1b 5b 31 3b 36 43` | | | | | | |
| Ctrl+T | abrir aba | ok `14` | ok `14` | | | | | | |
| Alt+T (macOS: Option+T) | abrir aba (alternativa) | ok `1b 74` | ok `1b 74` | | | | | | |
| Ctrl+W | fechar aba | ok `17` | ok `17` | | | | | | |
| Alt+W (macOS: Option+W) | fechar aba (alternativa) | ok `1b 77` | ok `1b 77` | | | | | | |
| Ctrl+K | paleta de comandos | ok `0b` | ok `0b` | | | | | | |
| F1 | paleta + ajuda | ok `1b 4f 50` | ok `1b 4f 50` | | | | | | |
| F5 | Configurações | ok `1b 5b 31 35 7e` | ok `1b 5b 31 35 7e` | | | | | | |
| F6 | Plugins | ok `1b 5b 31 37 7e` | ok `1b 5b 31 37 7e` | | | | | | |
| Ctrl+Q | sair | ok `11` | ok `11` | | | | | | |
| Tab | trocar o foco | ok `09` | ok `09` | | | | | | |
| Shift+Tab | foco para trás | ok `1b 5b 5a` | ok `1b 5b 5a` | | | | | | |
| PageUp | rolar | ok `1b 5b 35 7e` | ok `1b 5b 35 7e` | | | | | | |
| PageDown | rolar | ok `1b 5b 36 7e` | ok `1b 5b 36 7e` | | | | | | |
| ↑ | navegar / decisão | ok `1b 5b 41` | ok `1b 5b 41` | | | | | | |
| ↓ | navegar / decisão | ok `1b 5b 42` | ok `1b 5b 42` | | | | | | |
| Shift+↑ | reordenar papéis | ok `1b 5b 31 3b 32 41` | ok `1b 5b 31 3b 32 41` | | | | | | |
| Shift+↓ | reordenar papéis | ok `1b 5b 31 3b 32 42` | ok `1b 5b 31 3b 32 42` | | | | | | |
| Espaço | marcar opção | ok `20` | ok `20` | | | | | | |
| Esc | depois / cancelar | ok `1b` | ok `1b` | | | | | | |
| Ctrl+Shift+P | não usado | ok `10` | ok `10` | | | | | | |

## Achados (verificado localmente, só tmux)

- Ctrl+J chega como `0a` e Enter como `0d`: distinguíveis no tmux, em modo bruto. Fora do modo bruto (cooked), os dois viram quebra de linha.
- Alt+letra chega como `ESC letra` (`1b 62`). Ctrl+←/→ chega como `ESC [ 1 ; 5 D/C`, Ctrl+Shift+←/→ como `ESC [ 1 ; 6 D/C` (o tmux sintetiza a sequência do xterm).
- Ctrl+Shift+P chega como `10`, igual a Ctrl+P. Aqui o dado é fraco: quem gerou o byte foi o tmux. A confirmação real depende dos terminais.
- O terminal sob o tmux anuncia `xtversion = tmux 3.8` e não responde à consulta do protocolo kitty (`kitty: null`).
- Ctrl+B não chega a um programa dentro de um tmux com o prefixo padrão (modo aninhado).

## Pendências para o dono (não confirmado)

Windows Terminal, terminal do VS Code, Terminal.app (com e sem Option como Meta), iTerm2, GNOME Terminal, Konsole, SSH em cada um deles, e macOS e Windows em geral. Nada disso pôde ser medido nesta máquina Linux.

## Arquivos

- `keys.mjs`: registrador (modo bruto, sondagem, percurso, JSON).
- `decode.mjs`: decodificador de bytes (Ctrl, Alt por prefixo ESC, CSI com modificadores, `~`, SS3, kitty `CSI u`, `modifyOtherKeys`, composições do Option no macOS).
- `map.mjs`: o mapa de teclas da §5.13 (rótulo, esperado, tecla do tmux, uso na TUI).
- `auto-tmux.mjs`: automação com tmux.
- `resultados/`: JSONs por terminal.
