// Cores e estilos do mockup: as classes CSS de docs/framework-ideas/mockup/tui.html, uma a uma.
// Cada "chave de estilo" é o nome da classe (ex.: 'ok', 'sel-acc'); várias separadas por espaço (ex.: 'ok wk').

export const BASE_FG = '#c9ced6';
export const BASE_BG = '#11141a';

interface Sty { color?: string; bg?: string; bold?: boolean }

const CLASSES: Record<string, Sty> = {
  b: { color: '#3a4150' },
  'b-on': { color: '#7d8cff' },
  ti: { color: '#e6e8ec', bold: true },
  'ti-on': { color: '#aab4ff', bold: true },
  dim: { color: '#6b7380' },
  acc: { color: '#8f9cff' },
  ok: { color: '#4fc98f' },
  warn: { color: '#e8a948' },
  err: { color: '#ef6b6b' },
  sys: { color: '#b4a6ff' },
  you: { color: '#7cc4ff', bold: true },
  bold: { color: '#e6e8ec', bold: true },
  hdr: { bg: '#3a46a8', color: '#ffffff' },
  'hdr-k': { bg: '#3a46a8', color: '#ffd479', bold: true },
  sel: { bg: '#232a44', color: '#ffffff' },
  'sel-acc': { bg: '#232a44', color: '#8f9cff' },
  'tab-on': { bg: '#232a44', color: '#ffffff', bold: true },
  key: { bg: '#2b3140', color: '#ffd479', bold: true },
  hint: { color: '#9aa3af' },
  cur: { bg: '#c9ced6', color: '#11141a' },
  add: { color: '#4fc98f' },
  del: { color: '#ef6b6b' },
  // extras do spike (a paleta de comandos não existe no mockup)
  pal: { bg: '#1b2030', color: '#c9ced6' },
  'pal-sel': { bg: '#2f3a6b', color: '#ffffff' },
};

const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toHex = (c: number[]): string => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
/** opacidade .6 do CSS (.wk): mistura a cor com o fundo do terminal do mockup */
export function blend(fg: string, bg: string, a: number): string {
  const f = hex(fg), b = hex(bg);
  return toHex(f.map((v, i) => v * a + (b[i] ?? 0) * (1 - a)));
}

export interface TextStyle { color: string; backgroundColor?: string; bold?: boolean }
const cache = new Map<string, TextStyle>();

export function style(k: string): TextStyle {
  let s = cache.get(k);
  if (s) return s;
  let color = BASE_FG, bg: string | undefined, bold = false, wk = false;
  for (const c of k.split(' ')) {
    if (!c) continue;
    if (c === 'wk') { wk = true; continue; }
    const d = CLASSES[c];
    if (!d) continue;
    if (d.color) color = d.color;
    if (d.bg) bg = d.bg;
    if (d.bold) bold = true;
  }
  if (wk) color = blend(color, BASE_BG, 0.6);
  s = { color, ...(bg ? { backgroundColor: bg } : {}), ...(bold ? { bold: true } : {}) };
  cache.set(k, s);
  return s;
}

export const BORDER = { off: CLASSES['b']!.color!, on: CLASSES['b-on']!.color!, warn: CLASSES['warn']!.color! };
