// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import {
  KEYS,
  cleanupApps,
  fixedConnector,
  renderApp,
  waitFor,
  type RenderedApp,
} from './ink.test-support.js';
import { DEFAULT_UI_SETTINGS, parseUiSettings } from './settings.js';

afterEach(cleanupApps);

describe('App, without a daemon to talk to', () => {
  it('shows the heading, that the daemon is missing, and how to quit', async () => {
    const app = await renderApp({ connector: fixedConnector({ kind: 'offline' }) });
    const frame = await app.waitForText('No daemon is running');
    expect(frame).toContain('OTheater');
    expect(frame).toContain('ot daemon');
    expect(frame).toContain('Ctrl+Q quits');
  });

  it('shows the reason when the connection fails', async () => {
    const app = await renderApp({
      connector: fixedConnector({ kind: 'failed', message: 'wrong daemon id' }),
    });
    await app.waitForText('Could not connect to the daemon: wrong daemon id');
  });

  it('fills the window and draws a border around it', async () => {
    const app = await renderApp({ connector: fixedConnector({ kind: 'offline' }) });
    const frame = await app.waitForText('No daemon is running');
    const lines = frame.split('\n');
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    expect(lines[0]?.length).toBe(100);
  });
});

describe('App, the language', () => {
  it('follows the system language while ui.locale is auto', async () => {
    const app = await renderApp({
      connector: fixedConnector({ kind: 'offline' }),
      systemLocale: 'pt_BR.UTF-8',
    });
    await app.waitForText('Nenhum daemon está rodando');
  });

  it('changes the text at once when the setting changes, with no restart', async () => {
    const app = await renderApp({ connector: fixedConnector({ kind: 'offline' }) });
    await app.waitForText('No daemon is running');

    await app.locale.apply('pt-BR');
    const portuguese = await app.waitForText('Nenhum daemon está rodando');
    expect(portuguese).toContain('Ctrl+Q sai');
    expect(portuguese).not.toContain('No daemon is running');

    await app.locale.apply('en');
    await app.waitForText('No daemon is running');

    await app.locale.apply('auto');
    await app.waitForText('Ctrl+Q quits');
  });
});

describe('App, the patches of Ink', () => {
  it('warns when they were refused for a version of Ink that is not the supported one', async () => {
    const app = await renderApp({
      connector: fixedConnector({ kind: 'offline' }),
      patch: { applied: false, reason: 'version_mismatch', version: '8.1.0' },
    });
    await app.waitForText('No daemon is running');
    const frame = await app.waitForText('The render patches are off');
    expect(frame).toContain('Ink 8.1.0 is installed');
    expect(frame).toContain('only for Ink 8.0.0');
    // And it still works: the rest of the screen is there.
    expect(frame).toContain('No daemon is running');
  });

  it('says nothing when they were applied or turned off on purpose', async () => {
    for (const patch of [
      { applied: true, patches: ['cache', 'grid'], version: '8.0.0' },
      { applied: false, reason: 'disabled' },
    ] as const) {
      const app = await renderApp({ connector: fixedConnector({ kind: 'offline' }), patch });
      const frame = await app.waitForText('No daemon is running');
      expect(frame).not.toContain('patches are off');
      app.unmount();
    }
  });
});

describe('App, the keys', () => {
  /** After the app ends Ink erases the frame: the screen is empty. */
  async function exited(app: RenderedApp): Promise<void> {
    await waitFor(() => app.frame() === '' || undefined, 'the app to leave the screen');
  }

  it('asks Ink to paint at once after a key in flush mode, and not in throttle mode', async () => {
    const flush = await renderApp({ connector: fixedConnector({ kind: 'offline' }) });
    await flush.waitForText('No daemon');
    flush.press('x');
    await waitFor(() => flush.flushes() > 0 || undefined, 'a flush after a key');
    flush.press('y');
    await waitFor(() => flush.flushes() > 1 || undefined, 'a flush after another key');

    const throttle = await renderApp({
      connector: fixedConnector({ kind: 'offline' }),
      settings: parseUiSettings({ render: { keyRender: 'throttle' } }),
    });
    await throttle.waitForText('No daemon');
    throttle.press('x');
    throttle.press('y');
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(throttle.flushes()).toBe(0);
  });

  it('Ctrl+Q and Ctrl+C leave the app (the terminal is not left to Ink: exitOnCtrlC is off)', async () => {
    for (const key of [KEYS.ctrlQ, KEYS.ctrlC]) {
      const app = await renderApp({ connector: fixedConnector({ kind: 'offline' }) });
      await app.waitForText('No daemon');
      app.press(key);
      await exited(app);
      // After exiting, a later key changes nothing and nothing throws.
      app.press('x');
      expect(app.frame()).toBe('');
    }
  });

  it('uses the defaults of ui.render when none are given', () => {
    expect(DEFAULT_UI_SETTINGS.render.keyRender).toBe('flush');
  });
});
