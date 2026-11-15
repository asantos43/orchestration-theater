// Utilitários de texto e a "tela de uma linha" (Canvas), com as mesmas funções do tui-render.js do mockup.

/** [texto, estilo, id do alvo de clique] */
export type Part = readonly [text: string, k?: string, hit?: string];
export type Parts = Part[];

export function pad(s: string, n: number): string { s = String(s); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s.padEnd(n); }
export function rpad(s: string, n: number): string { s = String(s); return s.length > n ? s.slice(0, n) : s.padStart(n); }
export function wrap(t: string, w: number): string[] {
  const out: string[] = []; let line = '';
  for (const word of t.split(' ')) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= w) line += ' ' + word;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

/** repeat que aceita contagem negativa (larguras pequenas) */
export const rep = (s: string, n: number): string => s.repeat(Math.max(0, Math.floor(n)));

export function bar(w: number, p: number, k = 'ok'): Parts {
  const f = Math.round(w * p / 100);
  return [[rep('█', f), k], [rep('░', w - f), 'dim']];
}
/** barra fina da semana: traço cheio na cor da assinatura (esmaecida) e trilho escuro */
export function wbar(w: number, p: number, k: string): Parts {
  const f = Math.round(w * p / 100);
  return [[rep('━', f), k + ' wk'], [rep('─', w - f), 'b']];
}

/**
 * Uma linha de células. As coordenadas de put/seg/fill são as do mockup (colunas da tela);
 * `ox` é a coluna da tela onde começa a linha, para que o código se pareça com o do mockup.
 */
export class Canvas {
  c: string[];
  k: string[];
  h: (string | undefined)[];
  constructor(public w: number, public ox = 0, base = '') {
    this.c = Array.from({ length: w }, () => ' ');
    this.k = Array.from({ length: w }, () => base);
    this.h = Array.from({ length: w }, () => undefined);
  }
  put(x: number, s: string, k = '', hit?: string): this {
    for (let i = 0; i < s.length; i++) {
      const X = x - this.ox + i;
      if (X < 0 || X >= this.w) continue;
      this.c[X] = s[i]!; this.k[X] = k; this.h[X] = hit;
    }
    return this;
  }
  /** põe os segmentos em sequência a partir de x; devolve a coluna seguinte */
  segX(x: number, parts: readonly Part[]): number {
    let X = x;
    for (const [s, k, hit] of parts) { this.put(X, s, k ?? '', hit); X += s.length; }
    return X;
  }
  seg(x: number, parts: readonly Part[]): this { this.segX(x, parts); return this; }
  fill(x: number, w: number, k: string, ch = ' '): this { return this.put(x, rep(ch, w), k); }
  recolor(x: number, w: number, k: string): this {
    for (let i = 0; i < w; i++) { const X = x - this.ox + i; if (X >= 0 && X < this.w) this.k[X] = k; }
    return this;
  }
  /** marca a linha inteira como alvo de clique */
  hitAll(hit: string): this { this.h.fill(hit); return this; }
  parts(): Parts {
    const out: Part[] = [];
    let s = '', k = this.k[0] ?? '', h = this.h[0];
    for (let i = 0; i < this.w; i++) {
      if (this.k[i] !== k || this.h[i] !== h) { out.push([s, k, h]); s = ''; k = this.k[i] ?? ''; h = this.h[i]; }
      s += this.c[i];
    }
    if (s) out.push([s, k, h]);
    return out;
  }
  /** texto puro da linha (para a conferência com o mockup) */
  text(): string { return this.c.join(''); }
}

export interface Row { parts: Parts }
export const blankRow = (w: number): Row => ({ parts: [[rep(' ', w), '']] });
export const rowOf = (c: Canvas): Row => ({ parts: c.parts() });
