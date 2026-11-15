#!/usr/bin/env node
// App de piso da bancada: o mínimo possível. Ecoa as teclas numa linha fixa e, opcionalmente, redesenha a tela
// inteira N vezes por segundo (carga de saída no pty parecida com a de uma TUI). Serve para medir o que a
// BANCADA custa (tmux, send-keys, capture-pane, polling) sem framework nenhum.
//   node floor.mjs [--out-fps N] [--bytes B]   (a bancada também passa --scenario/--rate/--duration: ignorados, exceto
//                                                --rate, usado como --out-fps quando este falta)
// Ctrl+Q sai. Imprime "╭" no primeiro quadro, como o protótipo, para a bancada detectar a partida.
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? Number(a[i + 1]) : d; };
const fps = opt('out-fps', opt('rate', 0));
const lineBytes = opt('bytes', 7000);
const cols = process.stdout.columns || 160;
const rows = process.stdout.rows || 45;
const out = process.stdout;
out.write('\x1b[?1049h\x1b[?25l');
let text = '';
const input = () => `\x1b[${rows};1H\x1b[2K› ${text}▌`;
out.write('\x1b[H╭' + '─'.repeat(10) + input());
let n = 0;
if (fps > 0) {
  const filler = 'lorem ipsum áéíóú '.repeat(20);
  setInterval(() => {
    n++;
    let s = '\x1b[?2026h\x1b[H';
    const per = Math.max(1, Math.floor(lineBytes / (rows - 1)));
    for (let r = 1; r < rows; r++) s += `\x1b[${r};1H\x1b[2K` + (filler.slice(n % 17, n % 17 + Math.min(per, cols - 1)));
    s += input() + '\x1b[?2026l';
    out.write(s);
  }, 1000 / fps);
}
process.stdin.setRawMode(true);
process.stdin.on('data', (d) => {
  for (const ch of d.toString('utf8')) {
    if (ch === '\x11') { out.write('\x1b[?1049l\x1b[?25h'); process.exit(0); }
    if (ch === '\x7f') text = text.slice(0, -1);
    else if (ch >= ' ') text += ch;
  }
  out.write(input());
});
