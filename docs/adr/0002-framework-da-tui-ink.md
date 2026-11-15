# ADR 0002: framework da TUI é o Ink

- **Estado:** aceita
- **Data:** 2026-11-15 (horário de São Paulo, UTC-3)
- **Decisão:** N11 do [docs/13](../13-DECISOES-EM-ABERTO.md); arquitetura §5.13 e §12, item 11
- **Quem decidiu:** o dono (Anderson), igual à recomendação do teste comparativo da Fase 0
- **Evidência:**
  - [spikes/tui-bench/README.md](../../spikes/tui-bench/README.md);
  - [spikes/tui-ink/README.md](../../spikes/tui-ink/README.md);
  - os protótipos em `spikes/tui-ink/` e `spikes/tui-opentui/`.
- **Relacionadas:** N34 (mouse na Fase 7); N35 (caixa de texto e atalhos); N36 (copiar); N37 (desempenho do Ink)

Marcadores: **[V]** verificado localmente; **[S]** fonte secundária; **[N]** não confirmado ou hipótese.

## Contexto

A TUI é a interface principal do OTheater (§5.13), e o framework dela precisa estar decidido antes da Fase 7. A arquitetura tinha o Ink como padrão e o OpenTUI como alternativa. Pela Fase 0, a escolha saía de um teste comparativo com este critério: **fica o Ink se passar nos três primeiros itens (streaming, rolagem e layout); senão, OpenTUI.**

## Como foi medido

Os dois protótipos têm o mesmo layout (chat, painel lateral e caixa de entrada). A bancada foi escrita para isso (`spikes/tui-bench`). **[V]**

- **Ambiente:**
  - tmux 3.8 headless, em 160x45;
  - Fedora 45, Node 24.18.0 e Bun 1.3.14;
  - Ink 8.0.0 com React 19.3.1 e `@inkjs/ui` 2.0.0;
  - OpenTUI 0.9.0.
- **Cenários:**
  - streams de 300 s a 20 e 50 eventos/s, medindo a latência de digitação, o CPU e o RSS;
  - histórico de 5.000 mensagens e 1.000 passos, com PageUp e PageDown;
  - 25 passos de layout: Ctrl+←/→, Ctrl+B, Ctrl+J e redimensionamento (os atalhos da época; a N35 os trocou por Alt + letra).
- **Limites da medição:** uma execução por célula e execuções sequenciais. A máquina de trabalho tinha carga de fundo de 0,2 a 0,5.

## Resultados

| Medida | Ink | OpenTUI |
|---|---|---|
| Digitação sob stream, p50 / p95 (ms) | 41,1 / 67,6 a 50/s; 46,7 / 75,9 a 20/s | 8,6 / 22,5 a 50/s; 3,1 / 15,5 a 20/s |
| CPU média a 50/s (% de um núcleo) | 27,9, estável | 48,8, subindo de 34 para 62 |
| RSS no stream de 50/s (MB) | 157 → 293, estável no fim | 102 → 314 em 300 s e 353 em 600 s, sem platô |
| Rolagem do histórico, p50 / p95 (ms) | 30 a 39 / 64 a 68; 1 tecla perdida em 400 | cerca de 17 / 18; 8 teclas perdidas em 200 no painel |
| Abertura do histórico até a tela estável (ms) | 651 | 1.234 |
| Layout | 25/25 | 21/25: o chat transborda com o painel fechado |
| Runtime | Node | Só Bun (usa a FFI do Bun); executável de cerca de 121 MB |
| Licença dos binários | — | `MIT AND LGPL-2.1-or-later` nos binários nativos |

Todos os números são **[V]**. Duas ressalvas de leitura:
- Os geradores dos dois protótipos não produziram cargas idênticas.
- O crescimento do RSS no OpenTUI pode ser retenção proporcional ao histórico, e não vazamento. Isso não foi separado. **[N]**

## Decisão

**Ink.** Ele passou nos três critérios que decidem:

- **Streaming:** funciona a 20 e 50/s, com CPU e RSS estáveis em 300 s.
- **Rolagem:** p50 de 30 a 39 ms, com abertura em 0,5 s.
- **Layout:** 25/25.

O OpenTUI reprovaria de qualquer forma:
- pela §6.0, por causa dos binários LGPL;
- pelo runtime só em Bun;
- pelo layout 21/25 no protótipo;
- pela memória e pelo CPU que sobem durante o stream.

## Consequências

- **Stack da TUI:** Ink e `@inkjs/ui` no Node, distribuídos como Node SEA (arquitetura, tabela de stack e distribuição).
- **A latência de digitação sob stream fica para a Fase 7.** No Ink ela é cerca de 5 vezes maior que no OpenTUI e é limitada pelo `maxFps`. Com `--max-fps 60`, numa execução de 60 s, o p50 caiu para 29,6 ms e o CPU subiu para 45,3%. **[V]**

  A afinação de `maxFps`, da renderização incremental e da janela do histórico vira chaves de configuração. Os padrões ainda não foram decididos.

  **Atualização (2026-11-15, N37):** o spike de otimização baixou a digitação sob stream a 50/s para p50 de 10 a 11 ms, com CPU de 24% e RSS de 110 a 140 MB, usando renderização imediata da tecla, memoização, limite do heap jovem do V8 e um patch no `output.js` do Ink 8.0.0, travado na versão. Os padrões estão na §5.13 da arquitetura. **[V]**, uma execução por caso.
- **Borda quebrada:** sem `--incremental`, 1 de 29 capturas veio com a borda quebrada; com `--incremental`, nenhuma em 58. **[V]** É compatível com o `capture-pane` lendo a tela no meio de um quadro **[N]**. Precisa ser conferido num terminal real com saída sincronizada (DEC 2026).
- **Código próprio a escrever, porque o Ink 8.0.0 não tem estas peças [V, lido em `node_modules/ink/build`]:**
  - moldura com título na borda;
  - campo de entrada;
  - rolagem virtualizada;
  - quebra de linha que respeita a largura dos caracteres;
  - camada de mouse.
- **Mouse:** decidido à parte, na N34. Entra na Fase 7 com a chave `ui.mouse` (`full`, `wheel` ou `off`). O Claude Code 2.1.325, também feito em Ink, liga o rastreamento de mouse e tem uma camada própria de eventos. **[V]**
- **Problemas de teclado já vistos no protótipo:** o `TextInput` do `@inkjs/ui` e o Ctrl+J (ver `spikes/tui-ink/README.md`). Entram no teste de atalhos.

## O que não foi verificado

Os itens da Fase 0 que não decidem o framework, mas definem os padrões por ambiente:

- **Terminais:**
  - terminais gráficos reais (Windows Terminal, terminal do VS Code, Terminal.app, iTerm2, GNOME Terminal ou Konsole);
  - SSH;
  - macOS e Windows.
- **Atalhos:**
  - o mapa de teclas da §5.13 nesses terminais;
  - o Ctrl+J distinguível do Enter;
  - os atalhos com Alt da N35 no VS Code (era o Ctrl+K);
  - o Alt com e sem "Option como Meta".
- **Outros:** IME; 256 cores contra truecolor.
- **Repetições:** cada célula precisa de pelo menos 3 execuções para ter dispersão, e o gerador precisa ser unificado entre os dois protótipos.
