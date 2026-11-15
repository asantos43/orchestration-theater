// A tela inteira como função pura de (estado, colunas, linhas). Não usa hooks de terminal além do que os PBox
// já usam, então serve igual para o render ao vivo e para renderToString (conferência com o mockup).
import React from 'react';
import { Box } from 'ink';
import { CHAT_TITLE } from './fixtures.js';
import { Blank, Line, PBox } from './hit.js';
import { Frame } from './components/Frame.js';
import { Palette } from './components/Palette.js';
import { chatView, headerParts, hintsParts, panelView, railRows, sideRows } from './views.js';
import { SIDE_OPEN, computeLayout, type State } from './state.js';
import type { Row } from './text.js';

const Rows = ({ rows }: { rows: Row[] }) => <>{rows.map((r, i) => <Line key={i} parts={r.parts} />)}</>;

export function View({ st, cols, rows }: { st: State; cols: number; rows: number }) {
  const lay = computeLayout(st, cols, rows);
  const h = lay.mainH;
  const sideOn = st.focus === 'side', chatOn = st.focus === 'chat', panelOn = st.focus === 'panel';
  const side = lay.side === SIDE_OPEN
    ? (
      <Frame w={lay.side} h={h} title="Navegação" on={sideOn} regId="pane:side"
        top={[{ x: 22, parts: [[' « ', 'acc', 'side:toggle'], ['^B', 'key', 'side:toggle'], [' ', 'b', 'side:toggle']] }]}>
        <Rows rows={sideRows(h, st)} />
      </Frame>
    )
    : (
      <Frame w={lay.side} h={h} on={sideOn} regId="pane:side">
        <Rows rows={railRows(h, st)} />
      </Frame>
    );

  const cv = chatView(st, lay.chat, h, chatOn);
  const lab = cv.bottomLabel;
  const chat = (
    <Frame w={lay.chat} h={h} title={CHAT_TITLE} on={chatOn} regId="pane:chat"
      bottom={[{ x: lay.chat - lab.length - 2, parts: [[lab, 'acc']] }]}
      edge={{ y: cv.edgeY, n: 6, k: 'acc', hit: 'handle' }}>
      <Rows rows={cv.head} />
      <PBox flexDirection="column" flexShrink={0} height={cv.area.length} regId="wheel:chat"><Rows rows={cv.area} /></PBox>
      {cv.decision && (
        <>
          <Blank />
          <PBox marginLeft={1} flexShrink={0} flexDirection="column">
            <Frame w={cv.decision.dw} h={cv.decision.dh} title={cv.decision.title} borderKey="warn" titleKey="warn">
              <Rows rows={cv.decision.rows} />
            </Frame>
          </PBox>
        </>
      )}
      <Rows rows={cv.tail} />
    </Frame>
  );

  let panel = null;
  if (lay.panelOpen) {
    const pv = panelView(st, lay.panel, h);
    panel = (
      <Frame w={lay.panel} h={h} on={panelOn} regId="pane:panel">
        <Line parts={pv.tabRow.parts} width={lay.panel - 2} />
        <Line parts={pv.ulRow.parts} width={lay.panel - 2} />
        <PBox marginLeft={1} flexDirection="column" flexShrink={0}>
          <Rows rows={pv.content} />
          <Line parts={pv.foot.parts} />
        </PBox>
      </Frame>
    );
  }

  return (
    <PBox flexDirection="column" width={cols} height={rows} regId="root">
      <Line parts={headerParts(cols, st)} width={cols} />
      <PBox flexDirection="row" width={cols} height={h} flexShrink={0}>
        {side}{chat}{panel}
      </PBox>
      <Line parts={hintsParts(cols, st, lay)} width={cols} />
      {st.palette.open && <Palette st={st} cols={cols} rows={rows} />}
    </PBox>
  );
}
