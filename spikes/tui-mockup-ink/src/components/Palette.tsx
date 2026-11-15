// Paleta de comandos: sobreposição absoluta, centralizada no alto da tela. Desenhada linha a linha com fundo
// próprio (o Ink não "apaga" o que está atrás de um Box absoluto sem fundo).
import React from 'react';
import { filterCommands } from '../commands.js';
import { Line, PBox } from '../hit.js';
import { Canvas, pad, rep } from '../text.js';
import type { State } from '../state.js';

export function Palette({ st, cols, rows }: { st: State; cols: number; rows: number }) {
  const w = Math.min(64, cols - 4);
  const items = filterCommands(st.palette.q);
  const maxItems = Math.max(1, Math.min(items.length || 1, rows - 10));
  const sel = Math.min(st.palette.sel, Math.max(0, items.length - 1));
  const first = Math.max(0, Math.min(sel - maxItems + 1, items.length - maxItems));
  const lines: Canvas[] = [];
  const top = new Canvas(w, 0, 'pal').put(0, '╭' + rep('─', w - 2) + '╮', 'pal b-on').put(2, ' Comandos ', 'pal ti-on');
  lines.push(top);
  lines.push(new Canvas(w, 0, 'pal').put(0, '│', 'pal b-on').put(w - 1, '│', 'pal b-on').seg(2, [['› ', 'pal acc'], [st.palette.q, 'pal'], [' ', 'cur']]));
  lines.push(new Canvas(w, 0, 'pal').put(0, '│' + rep('─', w - 2) + '│', 'pal b-on'));
  if (!items.length) lines.push(new Canvas(w, 0, 'pal').put(0, '│', 'pal b-on').put(w - 1, '│', 'pal b-on').put(2, 'nenhum comando', 'pal dim'));
  items.slice(first, first + maxItems).forEach((c, i) => {
    const on = first + i === sel;
    const l = new Canvas(w, 0, on ? 'pal-sel' : 'pal').put(0, '│', 'pal b-on').put(w - 1, '│', 'pal b-on');
    l.put(2, pad(c.label, w - 12), on ? 'pal-sel' : 'pal').put(w - 8, c.key.padStart(6), on ? 'pal-sel' : 'pal hint');
    lines.push(l);
  });
  lines.push(new Canvas(w, 0, 'pal').put(0, '╰' + rep('─', w - 2) + '╯', 'pal b-on'));
  return (
    <PBox position="absolute" top={2} left={Math.floor((cols - w) / 2)} width={w} height={lines.length} flexDirection="column">
      {lines.map((c, i) => <Line key={i} parts={c.parts()} width={w} />)}
    </PBox>
  );
}
