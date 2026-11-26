// SPDX-License-Identifier: MPL-2.0
import { Text } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, waitFor, type RenderedApp } from '../ink.test-support.js';
import { fakeOnline, seedStores, settingsWith } from '../layout.test-support.js';
import { Section } from '../layout/section.js';
import type { TabContentMap } from '../layout/tab-content.js';
import { MOUSE_DISABLE_SEQUENCE } from './modes.js';
import { sgrReport } from './sgr.js';

/** The screen without the margins: the positions of these tests are the ones of the borders. */
const COMPACT_SETTINGS = settingsWith({});

/**
 * The mouse over the whole app (N34, N36): the terminal modes on mount and off on exit, the reports
 * that never reach the text box, and what a click, a wheel notch, a drag does in each area. The
 * coordinates are found in the frame, the way a person points at what they see.
 */

afterEach(cleanupApps);

const F5 = '\x1b[15~';
const ENABLE_FULL = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';

/** How many replies of the Director the chat shows, `message number 0` to `message number 29`. */
const MESSAGES = 30;

const tabContent: TabContentMap = {
  overview: {
    sections: ['overview.long'],
    render: ({ width, sections }) => (
      <Section id="overview.long" title="Long section" width={width} control={sections}>
        {Array.from({ length: 80 }, (_, index) => (
          <Text key={index}>{`panel row ${String(index)}`}</Text>
        ))}
      </Section>
    ),
  },
  settings: {
    sections: ['settings.first', 'settings.second'],
    render: ({ width, sections }) => (
      <>
        <Section id="settings.first" title="First section" width={width} control={sections}>
          <Text>first body</Text>
        </Section>
        <Section id="settings.second" title="Second section" width={width} control={sections}>
          <Text>second body</Text>
        </Section>
      </>
    ),
  },
};

interface Opened {
  readonly app: RenderedApp;
  readonly writes: string[];
}

async function open(
  settings = COMPACT_SETTINGS,
  size = { columns: 140, rows: 30 },
): Promise<Opened> {
  const online = fakeOnline();
  seedStores(online.stores);
  const writes: string[] = [];
  const app = await renderApp({
    connector: online.connector,
    settings,
    size,
    tabContent,
    mouseWrites: writes,
  });
  await app.waitForText('SCENARIOS');
  // The chat is fed by its socket (P12): the daemon tells one finished reply per message.
  const socket = await waitFor(
    () => [...online.chat.sockets.values()][0]?.at(-1),
    'the chat socket',
  );
  for (let index = 0; index < MESSAGES; index += 1) {
    socket.emit({
      type: 'director_reply',
      eventId: index + 1,
      replyId: index + 1,
      text: `message number ${String(index)}`,
      final: true,
    });
  }
  await app.waitForText(`message number ${String(MESSAGES - 1)}`);
  return { app, writes };
}

interface Point {
  readonly col: number;
  readonly row: number;
}

/** Where `text` is on the screen (the first cell of the first line that has it, after `from`). */
function locate(frame: string, text: string, from = 0): Point {
  const lines = frame.split('\n');
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row] ?? '';
    const col = line.indexOf(text, row === 0 ? from : 0);
    if (col >= 0 && (row > 0 || col >= from)) return { col, row };
  }
  throw new Error(`"${text}" is not on the screen:\n${frame}`);
}

async function send(app: RenderedApp, bytes: string): Promise<string> {
  app.press(bytes);
  return app.settle();
}

async function click(app: RenderedApp, at: Point): Promise<string> {
  await send(app, sgrReport({ action: 'press', button: 'left', ...at }));
  return send(app, sgrReport({ action: 'release', button: 'left', ...at }));
}

/**
 * A click as the terminal of the Claude desktop reports it (measured, 2026-11-22): the press, then a
 * move with the button down on the SAME cell, then the release, each as a chunk of its own.
 */
async function clickWithDrag(app: RenderedApp, at: Point): Promise<string> {
  await send(app, sgrReport({ action: 'press', button: 'left', ...at }));
  await send(app, sgrReport({ action: 'drag', button: 'left', ...at }));
  return send(app, sgrReport({ action: 'release', button: 'left', ...at }));
}

async function wheel(app: RenderedApp, at: Point, wheelDirection: 'up' | 'down'): Promise<string> {
  return send(app, sgrReport({ action: 'wheel', wheel: wheelDirection, ...at }));
}

function width(frame: string): number {
  const found = /◂ (\d+) col/.exec(frame);
  if (found?.[1] === undefined) throw new Error('the width of the chat is not on the screen');
  return Number(found[1]);
}

describe('the terminal modes', () => {
  it('go on at the mount and off when the app comes down', async () => {
    const { app, writes } = await open();
    expect(writes).toEqual([ENABLE_FULL]);
    app.unmount();
    expect(writes).toEqual([ENABLE_FULL, MOUSE_DISABLE_SEQUENCE]);
  });

  it('go off on Ctrl+Q, the quit of the app, as on any other way out', async () => {
    const { app, writes } = await open();
    await send(app, '\x11');
    app.unmount();
    expect(writes.at(-1)).toBe(MOUSE_DISABLE_SEQUENCE);
  });

  it('ui.mouse wheel leaves out the drag, and off writes nothing', async () => {
    const wheelOnly = await open({ ...COMPACT_SETTINGS, mouse: 'wheel' });
    expect(wheelOnly.writes).toEqual(['\x1b[?1000h\x1b[?1006h']);
    cleanupApps();
    const off = await open({ ...COMPACT_SETTINGS, mouse: 'off' });
    expect(off.writes).toEqual([]);
  });
});

describe('the wheel', () => {
  it('scrolls the chat under the pointer, and only it', async () => {
    const { app } = await open();
    const before = app.frame();
    expect(before).toContain('message number 29');
    const after = await wheel(app, locate(before, 'message number 25'), 'up');
    expect(after).not.toContain('message number 29');
    expect(after).toContain('message number 22');
  });

  it('scrolls the panel, and the lines go back the other way', async () => {
    const { app } = await open();
    const spot = locate(app.frame(), 'panel row 3');
    const down = await wheel(app, spot, 'down');
    expect(down).not.toContain('panel row 0');
    const up = await wheel(app, spot, 'up');
    expect(up).toContain('panel row 0');
  });
});

describe('the clicks', () => {
  it('on the tabs: change, close, open the picker and hide the panel', async () => {
    const { app } = await open();
    await send(app, F5);
    let frame = await app.waitForText('First section');
    // The tab of the overview is behind the settings one: a click brings it back.
    frame = await click(app, locate(frame, 'Overview'));
    expect(frame).toContain('Long section');
    frame = await click(app, locate(frame, 'Settings ✕', 0));
    expect(frame).toContain('First section');
    // The close mark of the settings tab.
    const close = locate(frame, 'Settings ✕');
    frame = await click(app, { col: close.col + 'Settings '.length, row: close.row });
    expect(frame).not.toContain('Settings ✕');
    frame = await click(app, locate(frame, '+ Alt+A'));
    expect(frame).toContain('Open a tab');
    await send(app, '\x1b');
    // A lone Esc is held a moment, in case it starts a report, before it reaches the picker.
    await new Promise((resolve) => setTimeout(resolve, 60));
    frame = await click(app, locate(await app.settle(), '⟩'));
    expect(frame).not.toContain('Long section');
  });

  it('on a section header: folds it, and a second click opens it', async () => {
    const { app } = await open();
    await send(app, F5);
    let frame = await app.waitForText('First section');
    frame = await click(app, locate(frame, 'First section'));
    expect(frame).not.toContain('first body');
    expect(frame).toContain('second body');
    frame = await click(app, locate(frame, 'First section'));
    expect(frame).toContain('first body');
  });

  it('on the side bar: a scenario, a section header, the settings line and the arrows', async () => {
    const { app } = await open();
    let frame = await click(app, locate(app.frame(), 'Mobile app'));
    expect(frame.split('\n')[0]).toContain('Mobile app');
    frame = await click(app, locate(frame, 'SCENARIOS'));
    expect(frame).not.toContain('Docs site');
    frame = await click(app, locate(frame, 'SCENARIOS'));
    expect(frame).toContain('Docs site');
    frame = await click(app, locate(frame, '⚙ Settings'));
    expect(frame).toContain('First section');
    frame = await click(app, locate(frame, '«'));
    expect(frame).not.toContain('SCENARIOS');
  });

  it('do not reach what is behind an overlay', async () => {
    const { app } = await open();
    await send(app, '\x1bk');
    const behind = locate(app.frame(), '⚙ Settings');
    const frame = await click(app, behind);
    expect(frame).not.toContain('First section');
  });

  it('are left alone with ui.mouse wheel, which only has the wheel', async () => {
    const { app } = await open({ ...COMPACT_SETTINGS, mouse: 'wheel' });
    const frame = await click(app, locate(app.frame(), '⚙ Settings'));
    expect(frame).not.toContain('First section');
    const scrolled = await wheel(app, locate(frame, 'message number 25'), 'up');
    expect(scrolled).not.toContain('message number 29');
  });
});

describe('the drag', () => {
  it('of the border of the chat changes its width', async () => {
    const { app } = await open();
    const frame = app.frame();
    const row = frame.split('\n')[6] ?? '';
    const edge = row.indexOf('││', row.indexOf('││') + 2);
    expect(edge).toBeGreaterThan(0);
    const start = width(frame);
    await send(app, sgrReport({ action: 'press', button: 'left', col: edge, row: 6 }));
    await send(app, sgrReport({ action: 'drag', button: 'left', col: edge + 6, row: 6 }));
    const widened = await send(
      app,
      sgrReport({ action: 'release', button: 'left', col: edge + 6, row: 6 }),
    );
    expect(width(widened)).toBeGreaterThan(start);
  });

  it('selects in the chat and copies the text as OSC 52 when it is released', async () => {
    const { app, writes } = await open();
    const spot = locate(app.frame(), 'message number 25');
    const end = { col: spot.col + 'message number 25'.length - 1, row: spot.row };
    await send(app, sgrReport({ action: 'press', button: 'left', ...spot }));
    await send(app, sgrReport({ action: 'drag', button: 'left', ...end }));
    const frame = await send(app, sgrReport({ action: 'release', button: 'left', ...end }));
    const text = 'message number 25';
    const base64 = Buffer.from(text, 'utf8').toString('base64');
    expect(writes).toContain(`\x1b]52;c;${base64}\x07`);
    expect(frame).toContain('Copied 17 characters.');
  });
});

/** The shortcut bar (the last row) is of the area that has the focus. */
const bar = (frame: string): string => frame.split('\n').at(-1) ?? '';

describe('the focus by a press', () => {
  it('goes to the area that is pressed, on any of its rows', async () => {
    const { app } = await open();
    expect(bar(app.frame())).toContain('PageUp  Scroll');
    // A row of the panel that answers only to the wheel: the panel takes the focus.
    let frame = await click(app, locate(app.frame(), 'panel row 3'));
    expect(bar(frame)).toContain('Enter  Fold');
    // A quota of the side bar, which has no click of its own: the side bar takes it.
    frame = await click(app, locate(frame, 'codex-work'));
    expect(bar(frame)).toContain('Enter  Open');
    // A message of the chat: the chat takes it back.
    frame = await click(app, locate(frame, 'message number 25'));
    expect(bar(frame)).toContain('PageUp  Scroll');
  });

  it('does not take the click from what is inside the area', async () => {
    const { app } = await open();
    // The settings line of the side bar opens the tab, and the press on the side bar went before it.
    const frame = await click(app, locate(app.frame(), '⚙ Settings'));
    expect(frame).toContain('First section');
  });

  it('on the border of the chat leaves the focus on the border, not on the chat', async () => {
    const { app } = await open();
    const frame = app.frame();
    const row = frame.split('\n')[6] ?? '';
    const edge = row.indexOf('││', row.indexOf('││') + 2);
    await send(app, sgrReport({ action: 'press', button: 'left', col: edge, row: 6 }));
    await send(app, sgrReport({ action: 'drag', button: 'left', col: edge + 4, row: 6 }));
    const released = await send(
      app,
      sgrReport({ action: 'release', button: 'left', col: edge + 4, row: 6 }),
    );
    expect(bar(released)).toContain('Width');
  });

  it('is left alone with ui.mouse wheel', async () => {
    const { app } = await open({ ...COMPACT_SETTINGS, mouse: 'wheel' });
    const frame = await click(app, locate(app.frame(), 'panel row 3'));
    expect(bar(frame)).toContain('PageUp  Scroll');
  });
});

describe('the clicks of the terminal of the Claude desktop', () => {
  // The panel appears after the TUI started: the size goes from 120x30 to 213x83 by a resize.
  async function openResized(): Promise<Opened> {
    const opened = await open(COMPACT_SETTINGS, { columns: 120, rows: 30 });
    opened.app.resize(213, 83);
    await opened.app.settle();
    return opened;
  }

  it('give the focus to each area, with the press, the move on the same cell and the release', async () => {
    const { app } = await openResized();
    expect(bar(app.frame())).toContain('PageUp  Scroll');
    let frame = await clickWithDrag(app, locate(app.frame(), 'panel row 3'));
    expect(bar(frame)).toContain('Enter  Fold');
    frame = await clickWithDrag(app, locate(frame, 'codex-work'));
    expect(bar(frame)).toContain('Enter  Open');
    frame = await clickWithDrag(app, locate(frame, 'message number 25'));
    expect(bar(frame)).toContain('PageUp  Scroll');
    // The cells that the frames of the areas draw count too, not only the text inside them.
    frame = await clickWithDrag(app, { col: 3, row: 1 });
    expect(bar(frame)).toContain('Enter  Open');
    frame = await clickWithDrag(app, { col: 211, row: 81 });
    expect(bar(frame)).toContain('Enter  Fold');
  });

  it('count as a click for what is inside the area: a move that stays on the cell is not a drag', async () => {
    const { app } = await openResized();
    let frame = await clickWithDrag(app, locate(app.frame(), '⚙ Settings'));
    expect(frame).toContain('First section');
    frame = await clickWithDrag(app, locate(frame, 'First section'));
    expect(frame).not.toContain('first body');
    frame = await clickWithDrag(app, locate(frame, 'First section'));
    expect(frame).toContain('first body');
  });

  it('still select when the move leaves the cell', async () => {
    const { app, writes } = await openResized();
    const spot = locate(app.frame(), 'message number 25');
    const end = { col: spot.col + 'message number 25'.length - 1, row: spot.row };
    await send(app, sgrReport({ action: 'press', button: 'left', ...spot }));
    await send(app, sgrReport({ action: 'drag', button: 'left', ...spot }));
    await send(app, sgrReport({ action: 'drag', button: 'left', ...end }));
    await send(app, sgrReport({ action: 'release', button: 'left', ...end }));
    const base64 = Buffer.from('message number 25', 'utf8').toString('base64');
    expect(writes).toContain(`\x1b]52;c;${base64}\x07`);
  });
});

/**
 * `ui.tuiLayout.density: comfortable` (N258): a column of margin inside each frame. The areas of the
 * mouse are the ones the person sees, so a click lands on the tab, the section or the line it points
 * at, and the margin itself is not part of a tab.
 */
describe('the clicks, with the margin of comfortable', () => {
  const COMFORTABLE = settingsWith({ density: 'comfortable' });

  it('on the tabs: change, close, open the picker and hide the panel', async () => {
    const { app } = await open(COMFORTABLE);
    await send(app, F5);
    let frame = await app.waitForText('First section');
    // The tab of the overview is behind the settings one: a click on its label brings it back.
    frame = await click(app, locate(frame, 'Overview'));
    expect(frame).toContain('Long section');
    frame = await click(app, locate(frame, 'Settings ✕', 0));
    expect(frame).toContain('First section');
    // The close mark of the settings tab.
    const close = locate(frame, 'Settings ✕');
    frame = await click(app, { col: close.col + 'Settings '.length, row: close.row });
    expect(frame).not.toContain('Settings ✕');
    frame = await click(app, locate(frame, '+ Alt+A'));
    expect(frame).toContain('Open a tab');
    await send(app, '\x1b');
    await new Promise((resolve) => setTimeout(resolve, 60));
    frame = await click(app, locate(await app.settle(), '⟩'));
    expect(frame).not.toContain('Long section');
  });

  it('on the first and the last cell of a tab, and not on the margin before the first', async () => {
    const { app } = await open(COMFORTABLE);
    await send(app, F5);
    let frame = await app.waitForText('First section');
    const overview = locate(frame, 'Overview');
    // The cell before the tab is the margin of the frame: it is not a tab, so nothing changes.
    frame = await click(app, { col: overview.col - 2, row: overview.row });
    expect(frame).toContain('First section');
    // The first cell of the tab (its leading blank) is the tab of the overview.
    frame = await click(app, { col: overview.col - 1, row: overview.row });
    expect(frame).toContain('Long section');
    // The last cell of the label.
    frame = await click(app, locate(frame, 'Settings ✕'));
    expect(frame).toContain('First section');
    frame = await click(app, {
      col: locate(frame, 'Overview').col + 'Overview'.length - 1,
      row: overview.row,
    });
    expect(frame).toContain('Long section');
  });

  it('on a section header: folds it, and a second click opens it', async () => {
    const { app } = await open(COMFORTABLE);
    await send(app, F5);
    let frame = await app.waitForText('First section');
    frame = await click(app, locate(frame, 'First section'));
    expect(frame).not.toContain('first body');
    expect(frame).toContain('second body');
    frame = await click(app, locate(frame, 'First section'));
    expect(frame).toContain('first body');
  });

  it('on a scenario of the side bar: the line goes from border to border, the margin included', async () => {
    const { app } = await open(COMFORTABLE);
    const frame = app.frame();
    const target = locate(frame, 'Mobile app');
    const line = (frame.split('\n')[target.row] ?? '').slice(0, 30);
    expect(line.startsWith('│   ! Mobile app')).toBe(true);
    // The margin cell (column 1) is part of the line: a click on it puts the cursor on the scenario,
    // and Enter opens it.
    await click(app, { col: 1, row: target.row });
    const chosen = await send(app, '\r');
    expect(chosen).toContain('▸ ! Mobile app');
  });

  it('on the settings line of the side bar, which has its glyph after the margin', async () => {
    const { app } = await open(COMFORTABLE);
    const frame = await click(app, locate(app.frame(), '⚙ Settings'));
    expect(frame).toContain('First section');
  });

  it('on the + of the scenarios header, and not on the cell before it', async () => {
    const { app } = await open(COMFORTABLE);
    const frame = app.frame();
    const head = locate(frame, '▾ SCENARIOS');
    const plus = (frame.split('\n')[head.row] ?? '').indexOf('+');
    // The cell before the + is the header of the section (a click folds it), not the button.
    const folded = await click(app, { col: plus - 3, row: head.row });
    expect(folded).toContain('▸ SCENARIOS');
    const opened = await click(app, { col: plus, row: head.row });
    expect(opened).toContain('New scenario');
  });
});
