// Conferência com o mockup: renderiza cada tela com o Ink (renderToString, 140x42) e compara célula a célula
// com a grade de referência (scripts/mockup-grid.cjs, cópia da lógica de tui-render.js).
//   texto: caractere por caractere
//   cor:   cor de frente (só em células com caractere visível), fundo e negrito, lidos do ANSI da saída e
//          comparados com o CSS de docs/framework-ideas/mockup/tui.html (lido, nunca alterado)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToString } from 'ink';
import { View } from '../src/view.js';
import { initial, type ScreenId } from '../src/state.js';

const require = createRequire(import.meta.url);
const mock = require(path.resolve(process.cwd(), 'scripts/mockup-grid.cjs')) as { gridOf(id: string): { c: string; k: string }[][]; W: number; H: number; ids: string[] };

const W = mock.W, H = mock.H;
interface Cell { c: string; fg: string; bg: string; bold: boolean }

/** CSS do mockup -> { classe: { color, bg, bold, opacity } } */
function readCss(): Record<string, { color?: string; bg?: string; bold?: boolean; opacity?: number }> {
  const html = fs.readFileSync(path.resolve(process.cwd(), '../../docs/framework-ideas/mockup/tui.html'), 'utf8');
  const css = html.slice(html.indexOf('.b{color'), html.indexOf('.note{'));
  const out: Record<string, { color?: string; bg?: string; bold?: boolean; opacity?: number }> = {};
  for (const m of css.matchAll(/\.([a-z-]+)\{([^}]*)\}/g)) {
    const d: { color?: string; bg?: string; bold?: boolean; opacity?: number } = {};
    for (const decl of m[2]!.split(';')) {
      const [p, v] = decl.split(':').map(s => s?.trim());
      if (p === 'color') d.color = v; else if (p === 'background') d.bg = v; else if (p === 'font-weight' && v === '700') d.bold = true; else if (p === 'opacity') d.opacity = Number(v);
    }
    out[m[1]!] = d;
  }
  return out;
}
const CSS = readCss();
const BASE_FG = '#c9ced6', BASE_BG = '#11141a';
const full = (h: string) => (h.length === 4 ? '#' + h.slice(1).split('').map(c => c + c).join('') : h);
const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)] as const;
const mix = (a: string, b: string, o: number) => '#' + hex(a).map((v, i) => Math.round(v * o + hex(b)[i]! * (1 - o)).toString(16).padStart(2, '0')).join('');

/** estilo esperado de uma célula do mockup (classes separadas por espaço) */
function expected(k: string): { fg: string; bg: string; bold: boolean } {
  let fg = BASE_FG, bg = '', bold = false, op = 1;
  for (const c of k.split(' ').filter(Boolean)) {
    const d = CSS[c]; if (!d) continue;
    if (d.color) fg = full(d.color); if (d.bg) bg = full(d.bg); if (d.bold) bold = true; if (d.opacity != null) op = d.opacity;
  }
  if (op < 1) fg = mix(fg, BASE_FG === fg ? BASE_BG : BASE_BG, op);
  return { fg, bg, bold };
}

/** ANSI -> grade de células (suporta 38;2/48;2, 39, 49, 1, 22, 0) */
function parseAnsi(s: string): Cell[][] {
  const grid: Cell[][] = [];
  let fg = '', bg = '', bold = false;
  for (const line of s.split('\n')) {
    const row: Cell[] = [];
    for (let i = 0; i < line.length;) {
      if (line[i] === '\x1b' && line[i + 1] === '[') {
        const e = line.indexOf('m', i);
        const codes = line.slice(i + 2, e).split(';').map(Number);
        for (let j = 0; j < codes.length; j++) {
          const c = codes[j]!;
          if (c === 0) { fg = ''; bg = ''; bold = false; }
          else if (c === 1) bold = true;
          else if (c === 22) bold = false;
          else if (c === 39) fg = '';
          else if (c === 49) bg = '';
          else if (c === 38 && codes[j + 1] === 2) { fg = '#' + [codes[j + 2]!, codes[j + 3]!, codes[j + 4]!].map(v => v.toString(16).padStart(2, '0')).join(''); j += 4; }
          else if (c === 48 && codes[j + 1] === 2) { bg = '#' + [codes[j + 2]!, codes[j + 3]!, codes[j + 4]!].map(v => v.toString(16).padStart(2, '0')).join(''); j += 4; }
        }
        i = e + 1; continue;
      }
      const cp = String.fromCodePoint(line.codePointAt(i)!);
      row.push({ c: cp, fg, bg, bold }); i += cp.length;
    }
    grid.push(row);
  }
  return grid;
}

function render(id: ScreenId, cols = W, rows = H): Cell[][] {
  const out = renderToString(<View st={initial(id)} cols={cols} rows={rows} />, { columns: cols });
  return parseAnsi(out);
}

// uso auxiliar: --print <tela> [--size 80x24] imprime o texto da tela renderizada (sem comparar)
const pi = process.argv.indexOf('--print');
if (pi > 0) {
  const sz = (process.argv[process.argv.indexOf('--size') + 1] ?? '').match(/^(\d+)x(\d+)$/);
  const c = sz ? Number(sz[1]) : W, r = sz ? Number(sz[2]) : H;
  const out = renderToString(<View st={initial(process.argv[pi + 1] as ScreenId)} cols={c} rows={r} />, { columns: c });
  console.log(out.replace(/\x1b\[[0-9;]*m/g, ''));
  process.exit(0);
}

const pct = (a: number, b: number) => (100 * a / b).toFixed(2) + '%';
const verbose = process.argv.includes('--verbose');
const ids = (mock.ids as ScreenId[]);
const rowsOut: string[] = [];
let maxDiffRows = verbose ? 99 : 6;

console.log(`Conferência com o mockup (${W}x${H}, FORCE_COLOR=${process.env['FORCE_COLOR'] ?? ''})\n`);
for (const id of ids) {
  const ref = mock.gridOf(id);
  const got = render(id);
  let same = 0, total = W * H, fgOk = 0, fgN = 0, bgOk = 0, boldOk = 0, boldN = 0;
  const diffRows: string[] = [];
  const colorBad = new Map<string, number>();
  for (let y = 0; y < H; y++) {
    let exp = '', act = '', rowDiff = false;
    for (let x = 0; x < W; x++) {
      const r = ref[y]![x]!, g = got[y]?.[x] ?? { c: ' ', fg: '', bg: '', bold: false };
      exp += r.c; act += g.c;
      if (r.c === g.c) same++; else rowDiff = true;
      const e = expected(r.k);
      if (r.c !== ' ') {
        fgN++;
        const gfg = g.fg || BASE_FG;
        if (gfg === e.fg) fgOk++; else { const key = `${r.k || '(base)'}: esperado ${e.fg} obtido ${gfg}`; colorBad.set(key, (colorBad.get(key) ?? 0) + 1); }
        boldN++; if (g.bold === e.bold) boldOk++;
      }
      if ((g.bg || '') === e.bg) bgOk++; else { const key = `fundo ${r.k || '(base)'}: esperado ${e.bg || '(nenhum)'} obtido ${g.bg || '(nenhum)'}`; colorBad.set(key, (colorBad.get(key) ?? 0) + 1); }
    }
    if (rowDiff) diffRows.push(`  linha ${String(y).padStart(2)}\n    mockup |${exp}|\n    ink    |${act}|`);
  }
  console.log(`== ${id}: texto ${same}/${total} células iguais (${pct(same, total)}); linhas com diferença: ${diffRows.length}`);
  console.log(`   cor de frente ${fgOk}/${fgN} (${pct(fgOk, fgN)}); fundo ${bgOk}/${total} (${pct(bgOk, total)}); negrito ${boldOk}/${boldN} (${pct(boldOk, boldN)})`);
  for (const d of diffRows.slice(0, maxDiffRows)) console.log(d);
  if (diffRows.length > maxDiffRows) console.log(`  ... mais ${diffRows.length - maxDiffRows} linhas (use --verbose)`);
  const cb = [...colorBad].sort((a, b) => b[1] - a[1]).slice(0, verbose ? 30 : 6);
  for (const [k, n] of cb) console.log(`   cor: ${n}x ${k}`);
  console.log('');
  rowsOut.push(`${id}|${pct(same, total)}|${pct(fgOk, fgN)}|${pct(bgOk, total)}`);
}
console.log('resumo (tela|texto|frente|fundo)\n' + rowsOut.join('\n'));
