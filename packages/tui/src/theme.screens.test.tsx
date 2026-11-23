// SPDX-License-Identifier: MPL-2.0
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useChalkLevel } from './color.test-support.js';
import { cleanupApps, renderApp, TEST_UI_SETTINGS, type RenderedApp } from './ink.test-support.js';
import { fakeOnline, seedStores } from './layout.test-support.js';
import type { ThemeMode } from './settings.js';

/**
 * `ui.theme` on the whole screen: the colours that reach the terminal (as Ink writes them, with
 * truecolor on) in `otheater` and in `terminal`.
 */

const SIZE = { columns: 140, rows: 42 };

let restore: (() => void) | undefined;
beforeAll(async () => {
  restore = await useChalkLevel(3);
});
afterAll(() => {
  restore?.();
});
afterEach(cleanupApps);

async function openWith(theme: ThemeMode): Promise<RenderedApp> {
  const online = fakeOnline();
  seedStores(online.stores);
  const app = await renderApp({
    connector: online.connector,
    size: SIZE,
    settings: { ...TEST_UI_SETTINGS, theme },
  });
  await app.waitForText('127.0.0.1');
  return app;
}

describe('ui.theme on the screen', () => {
  it('otheater: the borders, the titles and the dim are the hex colours of the mockup', async () => {
    const app = await openWith('otheater');
    const raw = app.rawFrame();
    expect(raw).toContain('\x1b[38;2;125;140;255m'); // active border
    expect(raw).toContain('\x1b[38;2;58;65;80m'); // inactive border
    expect(raw).toContain('\x1b[38;2;230;232;236m'); // title of a frame
    expect(raw).toContain('\x1b[38;2;107;115;128m'); // dim
    expect(raw).toContain('\x1b[48;2;58;70;168m'); // header
    expect(raw).not.toContain('\x1b[94m');
    expect(raw).not.toContain('\x1b[2m');
    expect(raw).not.toContain('@');
  });

  it('terminal: the 16 colours of the terminal, as before', async () => {
    const app = await openWith('terminal');
    const raw = app.rawFrame();
    expect(raw).toContain('\x1b[94m'); // blueBright, the active border
    expect(raw).toContain('\x1b[90m'); // gray, the border
    expect(raw).toContain('\x1b[2m'); // the SGR dim
    expect(raw).not.toContain('38;2;125;140;255');
    expect(raw).not.toContain('38;2;107;115;128');
    expect(raw).not.toContain('@');
  });

  it('the text is the same in both modes', async () => {
    const dark = await openWith('otheater');
    const terminal = await openWith('terminal');
    expect(dark.frame()).toBe(terminal.frame());
  });
});
