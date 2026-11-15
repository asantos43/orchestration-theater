import { mulberry32 } from './prng.js';
import { WORDS } from './words.js';
import { trace, tracing, tnow } from './trace.js';

export type Role = 'you' | 'orq' | 'sys';
export interface Msg { id: number; role: Role; time: string; text: string }
export type LineKind = 'head' | 'body' | 'blank';
export interface Line { kind: LineKind; role: Role; text: string; time?: string; cursor?: boolean }

/** Quebra o texto em linhas de no máximo w colunas (palavras maiores que w são cortadas). */
export function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (let word of text.split(' ')) {
    while (word.length > w) {
      if (line) { out.push(line); line = ''; }
      out.push(word.slice(0, w));
      word = word.slice(w);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= w) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line || out.length === 0) out.push(line);
  return out;
}

export function clock(i: number): string {
  const m = 9 * 60 + 12 + Math.floor(i / 7);
  return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

export function layoutMsg(m: Msg, w: number, streaming: boolean): Line[] {
  const out: Line[] = [{ kind: 'head', role: m.role, text: m.role === 'you' ? 'você' : m.role === 'orq' ? 'diretor' : 'sistema', time: m.time }];
  const body = wrap(m.text, w);
  body.forEach((t, i) => out.push({ kind: 'body', role: m.role, text: t, cursor: streaming && i === body.length - 1 }));
  out.push({ kind: 'blank', role: m.role, text: '' });
  return out;
}

/** Armazenamento mínimo observável: o React lê `version` via useSyncExternalStore. */
export class Store {
  version = 0;
  private subs = new Set<() => void>();
  subscribe = (f: () => void): (() => void) => { this.subs.add(f); return () => this.subs.delete(f); };
  getVersion = (): number => this.version;
  private pending: ReturnType<typeof setTimeout> | null = null;
  /** Coalescência: no máximo ~1 notificação a cada 16 ms (os eventos chegam a 50/s, a tela atualiza a ≤ 30/s). */
  protected emit(): void {
    this.version++;
    if (Store.COALESCE_MS <= 0) { this.notify(); return; }
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.notify();
    }, Store.COALESCE_MS);
  }
  /** Mudança causada pelo usuário (rolar, enviar): com `Store.USER_NOW` avisa o React na hora, sem esperar o timer de coalescência. */
  protected userEmit(): void {
    if (!Store.USER_NOW) { this.emit(); return; }
    this.version++;
    if (this.pending) { clearTimeout(this.pending); this.pending = null; }
    this.notify();
  }
  private notify(): void {
    const t0 = tracing() ? tnow() : 0;
    for (const f of this.subs) f();
    if (t0) trace({ k: 'n', ms: Math.round((tnow() - t0) * 100) / 100 });
  }
  static COALESCE_MS = 16;
  static USER_NOW = false;
}

/** Chat: mensagens + linhas já quebradas. A janela visível é só uma fatia de `lines`. */
export class ChatModel extends Store {
  msgs: Msg[] = [];
  lines: Line[] = [];
  width = 80;
  /** linhas acima do fim (0 = acompanhando o fim) */
  offset = 0;
  private lastStart = 0;
  streaming = false;
  /** --history-window N: mantém em memória só as últimas ~N mensagens (0 = todas), como faria o daemon servindo páginas */
  historyWindow = 0;
  /** mensagens já descartadas da janela (só para o contador do título) */
  dropped = 0;

  get total(): number { return this.dropped + this.msgs.length; }

  /** Descarta as mais antigas em lotes (a cada 25% de folga), para o custo de re-quebrar não pesar por mensagem. */
  private trim(): void {
    const n = this.historyWindow;
    if (n <= 0 || this.msgs.length <= n + Math.ceil(n / 4)) return;
    const drop = this.msgs.length - n;
    this.msgs.splice(0, drop);
    this.dropped += drop;
    this.relayout();
    this.offset = Math.min(this.offset, Math.max(0, this.lines.length - 1));
  }

  setWidth(w: number): void {
    if (w === this.width) return;
    this.width = w;
    this.relayout();
    this.emit();
  }
  private relayout(): void {
    this.lines = [];
    for (let i = 0; i < this.msgs.length; i++) {
      if (i === this.msgs.length - 1) this.lastStart = this.lines.length;
      const m = this.msgs[i]!;
      const ls = layoutMsg(m, this.width, this.streaming && i === this.msgs.length - 1);
      for (const l of ls) this.lines.push(l);
    }
  }
  bulk(msgs: Msg[]): void {
    this.msgs = msgs;
    if (this.historyWindow > 0 && msgs.length > this.historyWindow) { this.dropped += msgs.length - this.historyWindow; this.msgs = msgs.slice(-this.historyWindow); }
    this.relayout();
    this.emit();
  }
  add(m: Msg, streaming = false): void {
    const before = this.lines.length;
    this.endStream();
    this.msgs.push(m);
    this.streaming = streaming;
    this.lastStart = this.lines.length;
    for (const l of layoutMsg(m, this.width, streaming)) this.lines.push(l);
    if (this.offset > 0) this.offset += this.lines.length - before;
    this.trim();
    this.emit();
  }
  /** acrescenta texto à última mensagem (a que está em curso) */
  append(text: string): void {
    const m = this.msgs[this.msgs.length - 1];
    if (!m) return;
    const before = this.lines.length;
    m.text += text;
    this.lines.length = this.lastStart;
    for (const l of layoutMsg(m, this.width, true)) this.lines.push(l);
    if (this.offset > 0) this.offset += this.lines.length - before;
    this.emit();
  }
  refresh(): void { this.emit(); }
  endStream(): void {
    if (!this.streaming) return;
    this.streaming = false;
    const last = this.lines[this.lines.length - 2];
    if (last) last.cursor = false;
  }
  scroll(delta: number, height: number): void {
    const max = Math.max(0, this.lines.length - height);
    const n = Math.min(max, Math.max(0, this.offset + delta));
    if (n !== this.offset) { this.offset = n; this.userEmit(); }
  }
  toBottom(): void { if (this.offset) { this.offset = 0; this.userEmit(); } }
}

export interface Step { n: number; tool: string; text: string; status: 'ok' | 'run' | 'err' }
const TOOLS = ['ler', 'editar', 'bash', 'buscar', 'testar', 'git'];

export class TrajModel extends Store {
  steps: Step[] = [];
  offset = 0;
  add(s: Step): void {
    this.steps.push(s);
    if (this.offset > 0) this.offset++;
    this.emit();
  }
  bulk(s: Step[]): void { this.steps = s; this.emit(); }
  scroll(delta: number, height: number): void {
    const max = Math.max(0, this.steps.length - height);
    const n = Math.min(max, Math.max(0, this.offset + delta));
    if (n !== this.offset) { this.offset = n; this.userEmit(); }
  }
}

export function makeStep(rnd: () => number, n: number): Step {
  const tool = TOOLS[Math.floor(rnd() * TOOLS.length)]!;
  const w = Array.from({ length: 2 + Math.floor(rnd() * 4) }, () => WORDS[Math.floor(rnd() * WORDS.length)]!).join(' ');
  const r = rnd();
  return { n, tool, text: w, status: r < 0.85 ? 'ok' : r < 0.95 ? 'run' : 'err' };
}

/** Texto aleatório de `len` caracteres (aproximado, termina em palavra inteira). */
export function randomText(rnd: () => number, len: number): string {
  let s = '';
  while (s.length < len) s += (s ? ' ' : '') + WORDS[Math.floor(rnd() * WORDS.length)]!;
  return s;
}

export function buildHistory(n: number, steps: number, seed: number): { msgs: Msg[]; steps: Step[] } {
  const rnd = mulberry32(seed + 1);
  const msgs: Msg[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const role: Role = r < 0.3 ? 'you' : r < 0.9 ? 'orq' : 'sys';
    msgs.push({ id: i, role, time: clock(i), text: randomText(rnd, 20 + Math.floor(rnd() * 381)) });
  }
  const st: Step[] = [];
  for (let i = 0; i < steps; i++) st.push(makeStep(rnd, i + 1));
  return { msgs, steps: st };
}

/**
 * Gerador de eventos falso. A cada tick (1000/rate ms) acrescenta um pedaço de 1 a 6 palavras à mensagem em curso;
 * quando ela chega ao tamanho sorteado (20 a 400 caracteres), abre uma nova.
 */
export class Generator {
  private rnd: () => number;
  private target = 0;
  private timer?: ReturnType<typeof setInterval>;
  private nextId: number;
  private ticks = 0;
  done = false;
  constructor(private chat: ChatModel, private traj: TrajModel, seed: number, private rate: number, private duration: number) {
    this.rnd = mulberry32(seed);
    this.nextId = chat.msgs.length;
  }
  private open(): void {
    this.target = 20 + Math.floor(this.rnd() * 381);
    this.chat.add({ id: this.nextId, role: 'orq', time: clock(this.nextId * 3), text: '' }, true);
    this.nextId++;
  }
  start(onDone: () => void): void {
    if (this.rate <= 0) return;
    this.open();
    const t0 = Date.now();
    const period = 1000 / this.rate;
    // setInterval com 1000/rate ms; se o laço atrasar, recupera os pedaços perdidos para manter a taxa média
    let emitted = 0;
    this.timer = setInterval(() => {
      const el = Date.now() - t0;
      if (el >= this.duration * 1000) { this.stop(); onDone(); return; }
      const due = Math.floor(el / period) + 1;
      while (emitted < due) { this.tick(); emitted++; }
    }, Math.max(1, Math.floor(period / 2)));
  }
  private tick(): void {
    const n = 1 + Math.floor(this.rnd() * 6);
    const words: string[] = [];
    for (let i = 0; i < n; i++) words.push(WORDS[Math.floor(this.rnd() * WORDS.length)]!);
    const cur = this.chat.msgs[this.chat.msgs.length - 1]!;
    this.chat.append((cur.text ? ' ' : '') + words.join(' '));
    if (++this.ticks % 25 === 0) this.traj.add(makeStep(this.rnd, this.traj.steps.length + 1));
    if (cur.text.length >= this.target) this.open();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.done = true;
    this.chat.endStream();
    this.chat.refresh();
  }
}
