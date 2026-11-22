// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import type { LayoutPreferences } from '@otheater/protocol';
import { cleanupApps, renderApp, waitFor, type RenderedApp } from './ink.test-support.js';
import {
  fakeOnline,
  MemoryLayoutFile,
  seedStores,
  type FakeOnline,
} from './layout.test-support.js';

/**
 * The keys of the layout with `ui.keyboard.protocol` on (flag `disambiguateEscapeCodes` of the
 * kitty protocol). The terminal then writes Ctrl+letter and Alt+letter as CSI-u, and the TUI must
 * do with them what it does with the legacy bytes (`layout.screens.test.tsx`): the same real path,
 * the keymap of the app over the keys Ink hands out, only the bytes change. F1, F5, the arrows
 * with modifiers and Ctrl+Home/End are functional keys: they keep their legacy sequence with the flag on.
 */

afterEach(cleanupApps);

const SIZE = { columns: 140, rows: 42 };

/** What a terminal with the protocol on writes for each key (flag 1 only). */
const KITTY = {
  altS: '\x1b[115;3u',
  altJ: '\x1b[106;3u',
  altA: '\x1b[97;3u',
  altW: '\x1b[119;3u',
  altK: '\x1b[107;3u',
  ctrlQ: '\x1b[113;5u',
  esc: '\x1b[27u',
  // Functional keys: the same bytes as without the protocol.
  f1: '\x1bOP',
  f5: '\x1b[15~',
  ctrlShiftLeft: '\x1b[1;6D',
  ctrlShiftRight: '\x1b[1;6C',
  ctrlHome: '\x1b[1;5H',
  ctrlEnd: '\x1b[1;5F',
} as const;

function prefs(change: Partial<LayoutPreferences>): string {
  const base: LayoutPreferences = {
    version: 1,
    sidebarCollapsed: false,
    chatWidth: 56,
    openTabs: ['overview'],
    collapsedSections: [],
  };
  return JSON.stringify({ ...base, ...change });
}

async function open(): Promise<{ app: RenderedApp; online: FakeOnline; file: MemoryLayoutFile }> {
  const file = new MemoryLayoutFile();
  file.text = prefs({});
  const online = fakeOnline({ file });
  seedStores(online.stores);
  const app = await renderApp({ connector: online.connector, size: SIZE });
  await app.waitForText('127.0.0.1');
  return { app, online, file };
}

/** The columns where a frame of the body starts (`╭` of the second row). */
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

describe('the keys of the layout, as CSI-u (ui.keyboard.protocol on)', () => {
  it('Alt+S turns the side bar into a rail and back', async () => {
    const { app, online } = await open();
    app.press(KITTY.altS);
    await waitUntil(() => online.layouts[0]?.layout.sidebarCollapsed === true);
    await app.settle();
    expect(frames(app.frame())[1]).toBe(5);
    app.press(KITTY.altS);
    await waitUntil(() => online.layouts[0]?.layout.sidebarCollapsed === false);
    await app.settle();
    expect(frames(app.frame())[1]).toBe(30);
  });

  it('Alt+J closes and opens the panel', async () => {
    const { app, online } = await open();
    app.press(KITTY.altJ);
    await waitUntil(
      () => online.layouts[0]?.layout.collapsedSections.includes('layout.panelClosed') === true,
    );
    await app.settle();
    expect(frames(app.frame())).toEqual([0, 30]);
    app.press(KITTY.altJ);
    await waitUntil(
      () => online.layouts[0]?.layout.collapsedSections.includes('layout.panelClosed') === false,
    );
    await app.settle();
    expect(frames(app.frame())).toEqual([0, 30, 86]);
  });

  it('Alt+A opens the picker and Alt+W closes the tab', async () => {
    const { app, online } = await open();
    app.press(KITTY.altA);
    await app.waitForText('Open a tab');
    app.press('\r');
    await waitUntil(() => online.layouts[0]?.layout.openTabs.includes('trajectories') === true);
    await app.settle();
    expect(app.frame()).toContain('Trajectories ✕');
    app.press(KITTY.altW);
    await waitUntil(() => online.layouts[0]?.layout.openTabs.includes('trajectories') === false);
    await app.settle();
    expect(app.frame()).not.toContain('Trajectories ✕');
  });

  it('Alt+K opens the palette, and Esc as CSI-u closes it', async () => {
    const { app } = await open();
    app.press(KITTY.altK);
    await app.waitForText('Command palette');
    app.press('usage');
    await app.waitForText(/Go to the tab Usage/);
    app.press(KITTY.esc);
    await waitUntil(() => !app.frame().includes('Command palette'));
  });

  it('F1 opens the palette and a CSI-u key of the layout does not pass through it', async () => {
    const { app, online } = await open();
    app.press(KITTY.f1);
    await app.waitForText('Command palette');
    app.press(KITTY.altS);
    await app.settle();
    expect(online.layouts[0]?.layout.sidebarCollapsed).toBe(false);
  });

  it('F5 opens the Settings tab', async () => {
    const { app, online } = await open();
    app.press(KITTY.f5);
    await app.waitForText('Settings ✕');
    expect(online.layouts[0]?.layout.openTabs).toContain('settings');
  });

  it('Ctrl+Shift+arrows move the edge of the chat by the step', async () => {
    const { app, online } = await open();
    app.press(KITTY.ctrlShiftLeft);
    await waitUntil(() => online.layouts[0]?.layout.chatWidth === 54);
    app.press(KITTY.ctrlShiftRight);
    app.press(KITTY.ctrlShiftRight);
    await waitUntil(() => online.layouts[0]?.layout.chatWidth === 58);
    await app.settle();
    expect(frames(app.frame())).toEqual([0, 30, 88]);
  });

  it('Ctrl+Home goes to the first message of the chat and Ctrl+End back to the last', async () => {
    const { app, online } = await open();
    const socket = await waitFor(
      () => [...online.chat.sockets.values()][0]?.at(-1),
      'the chat socket',
    );
    for (let index = 0; index < 100; index += 1) {
      socket.emit({
        type: 'director_reply',
        eventId: index + 1,
        replyId: index + 1,
        text: `message number ${String(index + 1)}`,
        final: true,
      });
    }
    await app.waitForText('message number 100');
    app.press(KITTY.ctrlHome);
    await app.waitForText(/message number 1\s+│/);
    expect(app.frame()).not.toContain('message number 100');
    app.press(KITTY.ctrlEnd);
    await app.waitForText(/message number 100\s+│/);
    expect(app.frame()).not.toMatch(/message number 1\s+│/);
  });

  it('Ctrl+Q as CSI-u saves the layout and ends the app', async () => {
    const { app, online, file } = await open();
    app.press(KITTY.altS);
    await waitUntil(() => online.layouts[0]?.layout.sidebarCollapsed === true);
    app.press(KITTY.ctrlQ);
    await waitUntil(() => {
      const saved =
        file.text === undefined ? undefined : (JSON.parse(file.text) as LayoutPreferences);
      return saved?.sidebarCollapsed === true;
    });
  });
});
