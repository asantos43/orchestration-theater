// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { LAYOUT_VERSION, type LayoutPreferences, type UiDensity } from '@otheater/protocol';
import { cleanupApps, renderApp, TEST_UI_SETTINGS, type RenderedApp } from './ink.test-support.js';
import {
  fakeOnline,
  MemoryLayoutFile,
  seedStores,
  settingsWith,
  type FakeOnline,
} from './layout.test-support.js';
import { sgrReport } from './mouse/sgr.js';
import type { SidebarEdgeMode } from './settings.js';

/**
 * The border between the side bar and the chat (N277): `ui.tuiLayout.sidebarEdge` says if it is a
 * stop of Tab with arrows (`tab`), only dragged (`mouse`) or fixed (`off`), and the width the
 * person chose is saved in the layout and comes back when the TUI is reopened.
 */

afterEach(cleanupApps);

const SIZE = { columns: 140, rows: 42 };
const TAB = '\t';
const LEFT = '\x1b[D';
const RIGHT = '\x1b[C';
const WIDEN_CHAT = '\x1b[1;6C';

function prefs(change: Partial<LayoutPreferences>): string {
  const base: LayoutPreferences = {
    version: LAYOUT_VERSION,
    sidebarCollapsed: false,
    chatWidth: 56,
    openTabs: ['overview'],
    collapsedSections: [],
  };
  return JSON.stringify({ ...base, ...change });
}

interface Opened {
  readonly app: RenderedApp;
  readonly online: FakeOnline;
}

async function open(
  edge: SidebarEdgeMode,
  options: {
    density?: UiDensity;
    saved?: Partial<LayoutPreferences>;
    file?: MemoryLayoutFile;
  } = {},
): Promise<Opened> {
  const file = options.file ?? new MemoryLayoutFile();
  file.text ??= prefs(options.saved ?? {});
  const online = fakeOnline({ file });
  seedStores(online.stores);
  const app = await renderApp({
    connector: online.connector,
    settings: {
      ...TEST_UI_SETTINGS,
      tuiLayout: settingsWith({ sidebarEdge: edge, density: options.density ?? 'compact' })
        .tuiLayout,
    },
    size: SIZE,
    mouseWrites: [],
  });
  await app.waitForText('127.0.0.1');
  return { app, online };
}

/** Columns where each frame of the body starts (`╭` of the second row). */
function frames(frame: string): number[] {
  const row = frame.split('\n')[1] ?? '';
  return Array.from(row).flatMap((char, index) => (char === '╭' ? [index] : []));
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timeout waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Tabs until the bar says the border of the side bar has the focus; false if it never does. */
async function tabToSidebarEdge(app: RenderedApp): Promise<boolean> {
  for (let index = 0; index < 6; index += 1) {
    app.press(TAB);
    await app.settle();
    if (app.frame().includes('Side bar width')) return true;
  }
  return false;
}

function storedWidth(online: FakeOnline): number | undefined {
  return online.layouts[0]?.layout.sidebarWidth;
}

describe('ui.tuiLayout.sidebarEdge: tab (the default)', () => {
  it('puts the border of the side bar in the Tab walk, after the side bar and before the chat', async () => {
    const { app } = await open('tab');
    // chat -> edge -> panel -> side bar -> border of the side bar -> chat
    const seen: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      app.press(TAB);
      await app.settle();
      const frame = app.frame();
      seen.push(
        frame.includes('Side bar width')
          ? 'sidebarEdge'
          : frame.includes('Width') && !frame.includes('Side bar width')
            ? 'edge'
            : frame.includes('PageUp  Scroll')
              ? 'chat'
              : 'other',
      );
    }
    expect(seen[0]).toBe('edge');
    expect(seen[3]).toBe('sidebarEdge');
    expect(seen[4]).toBe('chat');
  });

  it('moves the border with the arrows, by the step, and saves the width', async () => {
    const { app, online } = await open('tab');
    expect(await tabToSidebarEdge(app)).toBe(true);
    expect(app.frame()).toContain('◂ 30 col ▸');
    app.press(RIGHT);
    await waitUntil(() => storedWidth(online) === 32);
    await app.settle();
    expect(frames(app.frame())).toEqual([0, 32, 88]);
    app.press(LEFT);
    app.press(LEFT);
    await waitUntil(() => storedWidth(online) === 28);
    await app.settle();
    expect(frames(app.frame())).toEqual([0, 28, 84]);
    expect(app.frame()).toContain('◂ 28 col ▸');
  });

  it('stops at 16 columns, and before the chat or the panel falls under its minimum', async () => {
    const { app, online } = await open('tab', { saved: { sidebarWidth: 18 } });
    expect(await tabToSidebarEdge(app)).toBe(true);
    app.press(LEFT);
    app.press(LEFT);
    app.press(LEFT);
    await waitUntil(() => storedWidth(online) === 16);
    await app.settle();
    expect(frames(app.frame())[1]).toBe(16);
    // Wide: 140 columns, chat 30 and panel 30 at least, so 80 is the end.
    for (let index = 0; index < 40; index += 1) app.press(RIGHT);
    await waitUntil(() => storedWidth(online) === 80);
    await app.settle();
    const columns = frames(app.frame());
    expect(columns[1]).toBe(80);
    expect(columns).toHaveLength(3);
    expect((columns[2] ?? 0) - 80).toBeGreaterThanOrEqual(30);
    expect(140 - (columns[2] ?? 0)).toBeGreaterThanOrEqual(30);
  });

  it('is not an area of the Tab walk when the side bar is a rail', async () => {
    const { app } = await open('tab', { saved: { sidebarCollapsed: true } });
    expect(await tabToSidebarEdge(app)).toBe(false);
  });

  it('keeps the chat edge on its own keys (Ctrl+Shift+arrows)', async () => {
    const { app, online } = await open('tab');
    app.press(WIDEN_CHAT);
    await waitUntil(() => online.layouts[0]?.layout.chatWidth === 58);
    expect(storedWidth(online)).toBeUndefined();
  });

  it('comes back with the saved width when the TUI is reopened', async () => {
    const file = new MemoryLayoutFile();
    const first = await open('tab', { file });
    expect(await tabToSidebarEdge(first.app)).toBe(true);
    first.app.press(RIGHT);
    first.app.press(RIGHT);
    await waitUntil(() => storedWidth(first.online) === 34);
    await first.online.layouts[0]?.flush();
    expect(JSON.parse(file.text ?? '{}')).toMatchObject({
      sidebarWidth: 34,
      version: LAYOUT_VERSION,
    });
    cleanupApps();
    const second = await open('tab', { file });
    expect(frames(second.app.frame())[1]).toBe(34);
  });
});

describe('ui.tuiLayout.sidebarEdge: mouse', () => {
  it('has no Tab stop and the arrows change nothing', async () => {
    const { app, online } = await open('mouse');
    expect(await tabToSidebarEdge(app)).toBe(false);
    app.press(RIGHT);
    await app.settle();
    expect(storedWidth(online)).toBeUndefined();
    expect(frames(app.frame())[1]).toBe(30);
  });
});

describe('ui.tuiLayout.sidebarEdge: off', () => {
  it('has no Tab stop, no handle and the arrows change nothing', async () => {
    const { app, online } = await open('off');
    expect(await tabToSidebarEdge(app)).toBe(false);
    app.press(RIGHT);
    app.press(LEFT);
    await app.settle();
    expect(storedWidth(online)).toBeUndefined();
    expect(frames(app.frame())[1]).toBe(30);
    // No handle on the right border of the side bar (column 29); the chat edge keeps its own.
    const lines = app.frame().split('\n');
    expect(lines.some((line) => Array.from(line)[29] === '┃')).toBe(false);
    expect(lines.some((line) => line.includes('┃'))).toBe(true);
  });

  it('is not dragged by the mouse either', async () => {
    const { app, online } = await open('off');
    const edge = sidebarEdgeColumn(app.frame());
    await drag(app, edge, 8);
    expect(storedWidth(online)).toBeUndefined();
    expect(frames(app.frame())[1]).toBe(30);
  });
});

/** The column of the right border of the side bar, on a row with no handle (row 6). */
function sidebarEdgeColumn(frame: string): number {
  const row = frame.split('\n')[6] ?? '';
  const edge = row.indexOf('││');
  expect(edge).toBeGreaterThan(0);
  return edge;
}

async function drag(app: RenderedApp, col: number, by: number, row = 6): Promise<string> {
  app.press(sgrReport({ action: 'press', button: 'left', col, row }));
  await app.settle();
  app.press(sgrReport({ action: 'drag', button: 'left', col: col + by, row }));
  await app.settle();
  app.press(sgrReport({ action: 'release', button: 'left', col: col + by, row }));
  return app.settle();
}

describe.each(['compact', 'comfortable'] as const)(
  'the drag of the border, density %s',
  (density) => {
    it.each(['tab', 'mouse'] as const)(
      'widens and narrows the side bar in %s mode',
      async (edge) => {
        const { app, online } = await open(edge, { density });
        const col = sidebarEdgeColumn(app.frame());
        expect(col).toBe(29);
        await drag(app, col, 6);
        await waitUntil(() => storedWidth(online) === 36);
        expect(frames(app.frame())[1]).toBe(36);
        await drag(app, 35, -10);
        await waitUntil(() => storedWidth(online) === 26);
        expect(frames(app.frame())[1]).toBe(26);
      },
    );

    it('stays inside 16 and the room the chat and the panel leave', async () => {
      const { app, online } = await open('mouse', { density });
      await drag(app, 29, -29);
      await waitUntil(() => storedWidth(online) === 16);
      await drag(app, 15, 120);
      await waitUntil(() => storedWidth(online) === 80);
      const columns = frames(app.frame());
      expect(columns[1]).toBe(80);
      expect(140 - (columns[2] ?? 0)).toBeGreaterThanOrEqual(30);
    });
  },
);

describe('the border of the side bar in tab mode, by the mouse', () => {
  it('takes the focus when it is pressed, so the arrows go on from there', async () => {
    const { app, online } = await open('tab');
    await drag(app, 29, 4);
    await waitUntil(() => storedWidth(online) === 34);
    expect(app.frame()).toContain('Side bar width');
    app.press(LEFT);
    await waitUntil(() => storedWidth(online) === 32);
  });

  it('leaves the focus alone in mouse mode', async () => {
    const { app, online } = await open('mouse');
    await drag(app, 29, 4);
    await waitUntil(() => storedWidth(online) === 34);
    expect(app.frame()).not.toContain('Side bar width');
  });
});
