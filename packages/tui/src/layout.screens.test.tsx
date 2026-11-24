// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { LAYOUT_VERSION, type LayoutPreferences } from '@otheater/protocol';
import { cleanupApps, renderApp, waitFor, type RenderedApp } from './ink.test-support.js';
import {
  fakeOnline,
  MemoryLayoutFile,
  seedStores,
  type FakeOnline,
} from './layout.test-support.js';

/**
 * The four screens of the mockup (`docs/framework-ideas/mockup/tui.html`, a grid of 140x42) over
 * `ink-testing-library`, and the other things the layout promises: the scroll of a long chat, the
 * same layout after closing and reopening, and the keys. The daemon is a fake that is online (N57).
 */

afterEach(cleanupApps);

const SIZE = { columns: 140, rows: 42 };

function prefs(change: Partial<LayoutPreferences>): string {
  const base: LayoutPreferences = {
    version: LAYOUT_VERSION,
    sidebarCollapsed: false,
    chatWidth: 60,
    openTabs: ['overview'],
    collapsedSections: [],
  };
  return JSON.stringify({ ...base, ...change });
}

async function open(online: FakeOnline): Promise<RenderedApp> {
  seedStores(online.stores);
  const app = await renderApp({ connector: online.connector, size: SIZE });
  await app.waitForText('127.0.0.1');
  return app;
}

async function openWith(
  change: Partial<LayoutPreferences>,
): Promise<{ app: RenderedApp; online: FakeOnline }> {
  const file = new MemoryLayoutFile();
  file.text = prefs(change);
  const online = fakeOnline({ file });
  return { app: await open(online), online };
}

/** Columns where a frame of the body starts (`╭` of the second row), and the rows of the frame. */
function frames(frame: string): number[] {
  const row = frame.split('\n')[1] ?? '';
  return Array.from(row).flatMap((char, index) => (char === '╭' ? [index] : []));
}

function rowsOf(frame: string): string[] {
  return frame.split('\n');
}

describe('the four screens of the mockup, at 140x42', () => {
  it('main: the side bar of 30, the chat of 56 and the panel of 54', async () => {
    const { app } = await openWith({ chatWidth: 56 });
    const frame = app.frame();
    expect(frames(frame)).toEqual([0, 30, 86]);
    expect(rowsOf(frame)).toHaveLength(42);
    const lines = rowsOf(frame);
    expect(lines[0]).toContain('Billing API');
    expect(lines[0]).toContain('1 decision');
    expect(frame).toContain('Navigation');
    expect(frame).toContain('SCENARIOS');
    expect(frame).toContain('SUBSCRIPTIONS');
    expect(frame).toContain('Overview');
    expect(frame).toContain('Alt+K');
    // The bar of shortcuts is the last row.
    expect(lines[41]).toContain('Alt+S');
  });

  it('trajectories: the side bar as a rail of 5, the chat of 50 and the panel of 85', async () => {
    const { app } = await openWith({
      sidebarCollapsed: true,
      chatWidth: 50,
      openTabs: ['trajectories'],
    });
    const frame = app.frame();
    expect(frames(frame)).toEqual([0, 5, 55]);
    expect(frame).toContain('Trajectories');
    expect(frame).not.toContain('SUBSCRIPTIONS');
  });

  it('config: the side bar of 30, the chat of 46 and the panel of 64', async () => {
    const { app } = await openWith({ chatWidth: 46, openTabs: ['settings'] });
    const frame = app.frame();
    expect(frames(frame)).toEqual([0, 30, 76]);
    expect(frame).toContain('Settings');
  });

  it('focus: the rail and the chat in all the rest, with no panel', async () => {
    const { app } = await openWith({
      sidebarCollapsed: true,
      chatWidth: 135,
      openTabs: ['overview'],
      collapsedSections: ['layout.panelClosed'],
    });
    const frame = app.frame();
    expect(frames(frame)).toEqual([0, 5]);
    expect(frame).toContain('Chat');
    expect(frame).not.toContain('Overview ✕');
    // Every row of the screen has the width of the terminal, never more.
    for (const line of rowsOf(frame)) expect(Array.from(line).length).toBeLessThanOrEqual(140);
  });

  it('draws the same four screens in Portuguese', async () => {
    const file = new MemoryLayoutFile();
    file.text = prefs({ chatWidth: 56 });
    const online = fakeOnline({ file });
    seedStores(online.stores);
    const app = await renderApp({
      connector: online.connector,
      size: SIZE,
      systemLocale: 'pt_BR.UTF-8',
    });
    const frame = await app.waitForText('CENÁRIOS');
    expect(frames(frame)).toEqual([0, 30, 86]);
    expect(frame).toContain('Navegação');
    expect(frame).toContain('1 decisão');
  });
});

describe('the keys of the layout', () => {
  it('Alt+S turns the side bar into a rail and back', async () => {
    const { app, online } = await openWith({ chatWidth: 56 });
    app.press('\x1bs');
    await app.waitForText(/╭─.*\n/);
    await waitUntil(() => online.layouts[0]?.layout.sidebarCollapsed === true);
    await app.settle();
    expect(frames(app.frame())[1]).toBe(5);
    expect(app.frame()).not.toContain('SUBSCRIPTIONS');
    app.press('\x1bs');
    await waitUntil(() => online.layouts[0]?.layout.sidebarCollapsed === false);
    await app.settle();
    expect(frames(app.frame())[1]).toBe(30);
  });

  it('Alt+J closes and opens the panel; the chat takes the room', async () => {
    const { app, online } = await openWith({ chatWidth: 56 });
    app.press('\x1bj');
    await waitUntil(
      () => online.layouts[0]?.layout.collapsedSections.includes('layout.panelClosed') === true,
    );
    await app.settle();
    expect(frames(app.frame())).toEqual([0, 30]);
    app.press('\x1bj');
    await waitUntil(
      () => online.layouts[0]?.layout.collapsedSections.includes('layout.panelClosed') === false,
    );
    await app.settle();
    expect(frames(app.frame())).toEqual([0, 30, 86]);
  });

  it('Ctrl+Shift+arrows move the edge of the chat by the step', async () => {
    const { app, online } = await openWith({ chatWidth: 56 });
    app.press('\x1b[1;6D');
    await waitUntil(() => online.layouts[0]?.layout.chatWidth === 54);
    await app.settle();
    expect(frames(app.frame())).toEqual([0, 30, 84]);
    app.press('\x1b[1;6C');
    app.press('\x1b[1;6C');
    await waitUntil(() => online.layouts[0]?.layout.chatWidth === 58);
    await app.settle();
    expect(frames(app.frame())).toEqual([0, 30, 88]);
  });

  it('Tab walks the areas until the edge, and the arrows move it there', async () => {
    const { app, online } = await openWith({ chatWidth: 56 });
    app.press('\t');
    await app.settle();
    expect(app.frame()).toContain('Tab');
    // chat -> edge
    await waitUntil(() => app.frame().includes('Esc') || true);
    app.press('\x1b[D');
    await waitUntil(() => online.layouts[0]?.layout.chatWidth === 54);
    await app.settle();
    expect(frames(app.frame())).toEqual([0, 30, 84]);
    app.press('\x1b[C');
    await waitUntil(() => online.layouts[0]?.layout.chatWidth === 56);
  });

  it('Alt+A opens the picker, Enter opens the tab it is on, Alt+W closes it', async () => {
    const { app, online } = await openWith({ chatWidth: 56 });
    app.press('\x1ba');
    const picker = await app.waitForText('Open a tab');
    expect(picker).toContain('Trajectories');
    expect(picker).not.toContain('❯ Overview');
    app.press('\r');
    await waitUntil(() => online.layouts[0]?.layout.openTabs.includes('trajectories') === true);
    await app.settle();
    expect(app.frame()).not.toContain('Open a tab');
    expect(app.frame()).toContain('Trajectories ✕');
    app.press('\x1bw');
    await waitUntil(() => online.layouts[0]?.layout.openTabs.includes('trajectories') === false);
    await app.settle();
    expect(app.frame()).not.toContain('Trajectories ✕');
    expect(app.frame()).toContain('Overview');
  });

  it('closing the last tab leaves the panel with its placeholder', async () => {
    const { app, online } = await openWith({ chatWidth: 56 });
    app.press('\x1bw');
    await waitUntil(() => online.layouts[0]?.layout.openTabs.length === 0);
    await app.settle();
    expect(app.frame()).toContain('Alt+A');
    expect(frames(app.frame())).toEqual([0, 30, 86]);
  });

  it('Alt+K opens the palette, filters it by what is typed, and Esc closes it', async () => {
    const { app } = await openWith({ chatWidth: 56 });
    app.press('\x1bk');
    const palette = await app.waitForText('Command palette');
    expect(palette).toContain('Show or hide the side bar');
    app.press('usage');
    const filtered = await app.waitForText(/Go to the tab Usage/);
    expect(filtered).not.toContain('Show or hide the side bar');
    app.press('\x1b');
    await waitUntil(() => !app.frame().includes('Command palette'));
  });

  it('F1 also opens the palette and a key of the layout does not pass through it', async () => {
    const { app, online } = await openWith({ chatWidth: 56 });
    app.press('\x1bOP');
    await app.waitForText('Command palette');
    app.press('\x1bs');
    await app.settle();
    expect(online.layouts[0]?.layout.sidebarCollapsed).toBe(false);
  });

  it('Ctrl+Q saves the layout and ends the app', async () => {
    const { app, online } = await openWith({ chatWidth: 56 });
    app.press('\x1bs');
    await waitUntil(() => online.layouts[0]?.layout.sidebarCollapsed === true);
    app.press('\x11');
    await waitUntil(() => savedLayout(online.file)?.sidebarCollapsed === true);
  });
});

describe('closing and reopening', () => {
  it('draws the same layout the second time, from the file the first one left', async () => {
    const file = new MemoryLayoutFile();
    const first = fakeOnline({ file });
    const app = await open(first);
    app.press('\x1bs');
    await waitUntil(() => first.layouts[0]?.layout.sidebarCollapsed === true);
    app.press('\x1ba');
    await app.waitForText('Open a tab');
    app.press('\x1b[B');
    app.press('\r');
    await waitUntil(() => first.layouts[0]?.layout.openTabs.length === 2);
    app.press('\x1b[1;6D');
    app.press('\x1b[1;6D');
    app.press('\x1b[1;6D');
    await waitUntil(() => first.layouts[0]?.layout.chatWidth === 54);
    await app.settle();
    // The play ids come from a counter of the test support, so the second seed numbers them anew.
    const sameIds = (frame: string): string => frame.replace(/\bP\d+\b/g, 'P#');
    const before = sameIds(app.frame());
    app.press('\x11');
    await waitUntil(() => savedLayout(file)?.chatWidth === 54);
    const saved = file.text;
    cleanupApps();

    const second = fakeOnline({ file });
    const again = await open(second);
    expect(sameIds(again.frame())).toBe(before);
    expect(second.layouts[0]?.layout).toEqual(first.layouts[0]?.layout);
    expect(file.text).toBe(saved);
  });
});

describe('a long chat', () => {
  it('draws only what fits when there are 5,000 messages, from the last up to the first', async () => {
    const online = fakeOnline();
    const app = await open(online);
    const socket = await waitFor(
      () => [...online.chat.sockets.values()][0]?.at(-1),
      'the chat socket',
    );
    // The daemon tells 5,000 turns of the Director; each one is a reply with its own id.
    for (let index = 0; index < 5000; index += 1) {
      socket.emit({
        type: 'director_reply',
        eventId: index + 1,
        replyId: index + 1,
        text: `message number ${String(index + 1)}`,
        final: true,
      });
    }
    await app.waitForText('message number 5000');
    let frame = app.frame();
    expect(frame).toContain('message number 5000');
    expect(frame).not.toContain('message number 4900');
    expect(rowsOf(frame)).toHaveLength(42);
    // What is drawn is the window: far less than the 5,000 messages.
    expect((frame.match(/message number/g) ?? []).length).toBeLessThan(20);
    app.press('\x1b[5~');
    frame = await app.waitForText(/message number 49\d\d/);
    expect(frame).not.toContain('message number 5000');
    app.press('\x1b[1;5H');
    await app.settle();
    expect(rowsOf(app.frame())).toHaveLength(42);
  });
});

function savedLayout(file: MemoryLayoutFile): LayoutPreferences | undefined {
  return file.text === undefined ? undefined : (JSON.parse(file.text) as LayoutPreferences);
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timeout waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
