// Frame: caixa arredondada com título embutido na borda de cima e rótulo na borda de baixo.
//
// Escolha: o Ink não tem título de borda. As duas alternativas eram
//   (a) Box com borderStyle e uma sobreposição absoluta com o título em cima da borda de cima;
//   (b) Box com borderTop={false} / borderBottom={false} e as linhas de cima e de baixo escritas à mão.
// Foi usada a (b): a borda de cima e a de baixo são linhas de texto montadas célula a célula (assim o título, os
// atalhos "« ^B" e o rótulo "◂ 56 col ▸" entram na borda com estilos diferentes e alvos de clique próprios, sem
// depender da ordem de pintura de caixas sobrepostas), e as laterais "│" continuam sendo a borda do Ink.
// A alça "┃" da borda direita, essa sim, é uma sobreposição absoluta (position="absolute" right={-1}).
import React, { type ReactNode } from 'react';
import { Text } from 'ink';
import { BORDER, style } from '../theme.js';
import { Canvas, pad, rep, type Parts } from '../text.js';
import { Line, PBox } from '../hit.js';

export interface Overlay { x: number; parts: Parts }

export interface FrameProps {
  w: number;
  h: number;
  title?: string;
  on?: boolean;
  /** cor da borda (padrão: b / b-on conforme `on`) */
  borderKey?: string;
  titleKey?: string;
  top?: Overlay[];
  bottom?: Overlay[];
  /** alça ┃ na borda direita: primeira linha (relativa ao Frame), altura e alvo de clique */
  edge?: { y: number; n: number; k: string; hit: string };
  regId?: string;
  children?: ReactNode;
}

function edgeLine(w: number, left: string, right: string, bk: string, over: Overlay[], title: string | undefined, tk: string): Parts {
  const c = new Canvas(w);
  c.put(0, left + rep('─', w - 2) + right, bk);
  if (title) { const t = title.length > w - 6 ? pad(title, w - 6) : title; c.put(2, ' ' + t + ' ', tk); }
  for (const o of over) c.seg(o.x, o.parts);
  return c.parts();
}

export function Frame({ w, h, title, on = false, borderKey, titleKey, top = [], bottom = [], edge, regId, children }: FrameProps) {
  const bk = borderKey ?? (on ? 'b-on' : 'b');
  const color = borderKey === 'warn' ? BORDER.warn : on ? BORDER.on : BORDER.off;
  return (
    <PBox flexDirection="column" width={w} height={h} flexShrink={0} {...(regId ? { regId } : {})}>
      <Line parts={edgeLine(w, '╭', '╮', bk, top, title, titleKey ?? (on ? 'ti-on' : 'ti'))} width={w} />
      <PBox flexDirection="column" width={w} height={h - 2} flexShrink={0}
        borderStyle="round" borderTop={false} borderBottom={false} borderColor={color}>
        {children}
        {edge && (
          <PBox position="absolute" right={-1} top={edge.y - 1} width={1} height={edge.n} regId={edge.hit}>
            <Text {...style(edge.k)}>{Array.from({ length: edge.n }, () => '┃').join('\n')}</Text>
          </PBox>
        )}
      </PBox>
      <Line parts={edgeLine(w, '╰', '╯', bk, bottom, undefined, '')} width={w} />
    </PBox>
  );
}
