// SPDX-License-Identifier: MPL-2.0
import { Text } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, type RenderedApp } from '../ink.test-support.js';
import { fakeOnline, seedStores } from '../layout.test-support.js';
import { Section } from '../layout/section.js';
import type { TabContentMap } from '../layout/tab-content.js';
import { DEFAULT_UI_SETTINGS } from '../settings.js';
import { MOUSE_DISABLE_SEQUENCE } from './modes.js';
import { sgrReport } from './sgr.js';
import type { ChatMessage } from '../layout/chat.js';

/**
 * The mouse over the whole app (N34, N36): the terminal modes on mount and off on exit, the reports
 * that never reach the text box, and what a click, a wheel notch, a drag does in each area. The
 * coordinates are found in the frame, the way a person points at what they see.
 */

afterEach(cleanupApps);

const F5 = '\x1b[15~';
const ENABLE_FULL = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';

const messages: readonly ChatMessage[] = Array.from({ length: 30 }, (_, index) => ({
  id: `m${String(index)}`,
  who: 'you' as const,
  at: '09:00',
  text: `message number ${String(index)}`,
}));

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

async function open(settings = DEFAULT_UI_SETTINGS): Promise<Opened> {
  const online = fakeOnline();
  seedStores(online.stores);
  const writes: string[] = [];
  const app = await renderApp({
    connector: online.connector,
    settings,
    size: { columns: 140, rows: 30 },
    messages,
    tabContent,
    mouseWrites: writes,
  });
  await app.waitForText('SCENARIOS');
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
    const wheelOnly = await open({ ...DEFAULT_UI_SETTINGS, mouse: 'wheel' });
    expect(wheelOnly.writes).toEqual(['\x1b[?1000h\x1b[?1006h']);
    cleanupApps();
    const off = await open({ ...DEFAULT_UI_SETTINGS, mouse: 'off' });
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
    const { app } = await open({ ...DEFAULT_UI_SETTINGS, mouse: 'wheel' });
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
