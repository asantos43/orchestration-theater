// Biblioteca da bancada: cliente tmux em modo de controle, amostragem de /proc e análise de tela.
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();

export function pct(arr, p) {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i];
}
export const stats = (arr) => ({
  n: arr.length,
  p50: round(pct(arr, 50)),
  p95: round(pct(arr, 95)),
  max: round(pct(arr, 100)),
  perdidas: arr.filter((x) => x == null).length,
});
export const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
export const median = (a) => pct(a, 50);

const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
export { q };

/** Cliente tmux persistente (modo de controle, -C): sem custo de spawn por comando. */
export class Tmux {
  constructor(sock, conf) {
    this.sock = sock;
    this.conf = conf;
    this.queue = [];
    this.buf = '';
    this.collecting = null;
  }
  async start() {
    try { execFileSync('tmux', ['-L', this.sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* nada rodando */ }
    const env = { ...process.env };
    delete env.TMUX;
    this.proc = spawn('tmux', ['-L', this.sock, '-f', this.conf, '-C', 'new-session', '-s', 'ctl'], { stdio: ['pipe', 'pipe', 'inherit'], env });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this.onData(d));
    // o primeiro %begin/%end é a resposta do new-session
    await new Promise((res) => this.queue.push({ res, rej: res }));
  }
  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.startsWith('%begin ')) { this.collecting = []; continue; }
      if (this.collecting && (line.startsWith('%end ') || line.startsWith('%error '))) {
        const out = this.collecting.join('\n');
        const err = line.startsWith('%error ');
        this.collecting = null;
        const w = this.queue.shift();
        if (w) (err ? w.rej : w.res)(err ? new Error(out) : out);
        continue;
      }
      if (this.collecting) this.collecting.push(line);
    }
  }
  cmd(s) {
    return new Promise((res, rej) => {
      this.queue.push({ res, rej });
      this.proc.stdin.write(s + '\n');
    });
  }
  async stop() {
    try { await Promise.race([this.cmd('kill-server'), sleep(500)]); } catch { /* servidor já saiu */ }
    try { execFileSync('tmux', ['-L', this.sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* ok */ }
    try { this.proc.kill(); } catch { /* ok */ }
  }
}

/** Uma sessão "b" de tmux com o protótipo rodando. */
export class Session {
  constructor(tmux, { cols = 160, rows = 45, cmd, cwd, rawFile = null, delay = 0 }) {
    Object.assign(this, { tmux, cols, rows, cmd, cwd, rawFile, delay });
  }
  async start() {
    const t = this.tmux;
    const pre = this.delay ? `sleep ${this.delay}; ` : '';
    this.t0 = now();
    await t.cmd(`new-session -d -s b -x ${this.cols} -y ${this.rows} -c ${q(this.cwd)} -e TERM=xterm-256color -e COLORTERM=truecolor ${q(pre + (this.cmd.includes(';') ? '' : 'exec ') + this.cmd)}`);
    if (this.rawFile) await t.cmd(`pipe-pane -O -t b ${q('cat >> ' + this.rawFile)}`);
    this.pid = Number((await t.cmd(`display-message -p -t b '#{pane_pid}'`)).trim());
  }
  async cap() {
    try { return await this.tmux.cmd('capture-pane -p -t b'); } catch { return null; }
  }
  alive() { return this.tmux.cmd('has-session -t b').then(() => true, () => false); }
  keys(...k) { return this.tmux.cmd('send-keys -t b ' + k.join(' ')); }
  text(s) { return this.tmux.cmd('send-keys -t b -l ' + q(s)); }
  async resize(c, r) { this.cols = c; this.rows = r; await this.tmux.cmd(`resize-window -t b -x ${c} -y ${r}`); }
  /** espera a tela satisfazer pred; devolve {ms, screen} ou ms=null no timeout */
  async waitFor(pred, timeout = 20000, t0 = now()) {
    for (;;) {
      const s = await this.cap();
      if (s != null && pred(s)) return { ms: now() - t0, screen: s };
      if (now() - t0 > timeout) return { ms: null, screen: s };
      await sleep(1);
    }
  }
  /** espera a tela ficar igual em duas leituras seguidas, com intervalo de 150 ms */
  async settle(timeout = 5000) {
    const t0 = now();
    let prev = await this.cap();
    for (;;) {
      await sleep(150);
      const s = await this.cap();
      if (s === prev) return { ms: now() - t0 - 150, screen: s };
      prev = s;
      if (now() - t0 > timeout) return { ms: null, screen: s };
    }
  }
  async kill() { try { await this.tmux.cmd('kill-session -t b'); } catch { /* já encerrada */ } }
  async quit() {
    await this.keys('C-q');
    const t0 = now();
    while (now() - t0 < 4000) { if (!(await this.alive())) return true; await sleep(50); }
    return false;
  }
}

// ---------- amostragem de processos (/proc, Linux) ----------
const PAGE = 4096; // getconf PAGESIZE no x86_64; verificado em readProc
const CLK = 100; // getconf CLK_TCK

function readTable() {
  const t = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8');
      const rp = st.lastIndexOf(')');
      const f = st.slice(rp + 2).split(' ');
      const comm = st.slice(st.indexOf('(') + 1, rp);
      t.set(Number(d), { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), comm });
    } catch { /* processo sumiu */ }
  }
  return t;
}
export function procTree(root) {
  const tab = readTable();
  const ids = [root];
  for (let i = 0; i < ids.length; i++) for (const [pid, p] of tab) if (p.ppid === ids[i] && !ids.includes(pid)) ids.push(pid);
  let ticks = 0;
  let rssMax = 0;
  let rssTree = 0;
  let main = null;
  for (const pid of ids) {
    const p = tab.get(pid);
    if (!p) continue;
    ticks += p.ticks;
    try {
      const rss = Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * PAGE;
      rssTree += rss;
      if (rss > rssMax) { rssMax = rss; main = p.comm; }
    } catch { /* ok */ }
  }
  return { n: ids.length, ticks, rssMax, rssTree, main };
}

/** Amostrador 1 Hz: devolve funções para parar e obter a série. */
export function sampler(pid, periodMs = 1000) {
  const series = [];
  let last = null;
  const tick = () => {
    const s = procTree(pid);
    const t = now();
    if (last && s.n) {
      const cpu = ((s.ticks - last.s.ticks) / CLK / ((t - last.t) / 1000)) * 100;
      series.push({ t: round((t - series.t0) / 1000, 1), rssMB: round(s.rssMax / 1048576), rssTreeMB: round(s.rssTree / 1048576), cpu: round(cpu), proc: s.main });
    }
    last = { s, t };
  };
  series.t0 = now();
  tick();
  const h = setInterval(tick, periodMs);
  return { series, stop: () => { clearInterval(h); return series; }, ticksNow: () => procTree(pid).ticks };
}
export const ticksToSec = (t) => t / CLK;

// ---------- análise de tela ----------
const ACCENT = /[áàâãéêíóôõúç]/i;

export function analyze(text, cols, rows) {
  const lines = text.split('\n');
  const g = lines.map((l) => Array.from(l));
  const maxW = Math.max(0, ...g.map((l) => l.length));
  const count = (ch) => g.reduce((a, l) => a + l.filter((c) => c === ch).length, 0);
  const corners = { '╭': count('╭'), '╮': count('╮'), '╰': count('╰'), '╯': count('╯') };
  const failures = [];
  let boxes = 0;
  let intact = 0;
  for (let r = 0; r < g.length; r++) {
    for (let c = 0; c < g[r].length; c++) {
      if (g[r][c] !== '╭') continue;
      boxes++;
      let rb = r + 1;
      while (rb < g.length && g[rb][c] === '│') rb++;
      if (g[rb]?.[c] !== '╰') { failures.push(`caixa em (${r},${c}): borda esquerda quebrada na linha ${rb}`); continue; }
      let c2 = c + 1;
      while (c2 < cols && g[rb][c2] === '─') c2++;
      if (g[rb][c2] !== '╯') { failures.push(`caixa em (${r},${c}): borda inferior quebrada`); continue; }
      if (g[r][c2] !== '╮') { failures.push(`caixa em (${r},${c}): canto ╮ ausente na coluna ${c2}`); continue; }
      let ok = true;
      for (let rr = r + 1; rr < rb; rr++) if (!g[rr][c2] || g[rr][c2] === ' ') { failures.push(`caixa em (${r},${c}): borda direita quebrada na linha ${rr}`); ok = false; break; }
      if (ok) intact++;
    }
  }
  const sameCorners = corners['╭'] === corners['╮'] && corners['╮'] === corners['╰'] && corners['╰'] === corners['╯'];
  const res = {
    linhas: lines.length,
    larguraMax: maxW,
    cabeNaTela: maxW <= cols && lines.length <= rows,
    cantos: corners,
    cantosIguais: sameCorners && corners['╭'] > 0,
    caixas: boxes,
    caixasIntegras: intact,
    acentos: ACCENT.test(text),
    blocos: text.includes('█') && text.includes('░'),
    falhas: failures.slice(0, 5),
  };
  res.ok = res.cabeNaTela && res.cantosIguais && boxes > 0 && intact === boxes && res.acentos && res.blocos;
  // "borda inteira" sem exigir acento/bloco (telas sem conteúdo com acento, p. ex.)
  res.bordasOk = res.cabeNaTela && res.cantosIguais && boxes > 0 && intact === boxes;
  return res;
}

/** Conta ocorrências de sequências de controle no fluxo bruto do pty. */
export function countSeqs(buf) {
  const s = buf.toString('latin1');
  const c = (re) => (s.match(re) || []).length;
  return {
    bytes: buf.length,
    ED2_ESC_2J: c(/\x1b\[2J/g),
    ED_ESC_J: c(/\x1b\[0?J/g),
    EL_ESC_K: c(/\x1b\[0?K/g),
    EL2_ESC_2K: c(/\x1b\[2K/g),
    cursorUp: c(/\x1b\[\d*A/g),
    home: c(/\x1b\[H/g),
    sync2026: c(/\x1b\[\?2026h/g),
  };
}
