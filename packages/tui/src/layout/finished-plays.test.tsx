// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, TEST_UI_SETTINGS, type RenderedApp } from '../ink.test-support.js';
import { fakeOnline, play, seedStores, type FakeOnline } from '../layout.test-support.js';
import type { UiSettings } from '../settings.js';

/**
 * The "Terminadas" section of the side bar (P11 of docs/19): a finished play shows in it even
 * though the stores only read the open plays, in the three modes of `ui.sidebar.finishedPlays`.
 */

afterEach(cleanupApps);

function withSidebar(finishedPlays: UiSettings['sidebar']['finishedPlays']): UiSettings {
  return {
    ...TEST_UI_SETTINGS,
    sidebar: { ...TEST_UI_SETTINGS.sidebar, finishedPlays },
  };
}

async function open(
  settings: UiSettings,
): Promise<{ app: RenderedApp; online: FakeOnline; scenarioIds: string[] }> {
  const online = fakeOnline();
  const { scenarios } = seedStores(online.stores);
  const [first, second] = scenarios;
  const done = play(first?.id ?? '', { state: 'DONE', need: 'ship it', finishedAt: 50 });
  const cancelled = play(second?.id ?? '', {
    state: 'CANCELLED',
    need: 'drop it',
    finishedAt: 40,
  });
  online.stores.plays.setState((state) => ({
    ...state,
    byId: { ...state.byId, [done.id]: done, [cancelled.id]: cancelled },
  }));
  const app = await renderApp({
    connector: online.connector,
    size: { columns: 140, rows: 42 },
    settings,
  });
  await app.waitForText('SCENARIOS');
  return { app, online, scenarioIds: scenarios.map((item) => item.id) };
}

async function shown(app: RenderedApp): Promise<string> {
  await app.settle();
  return app.frame();
}

async function key(app: RenderedApp, sequence: string): Promise<string> {
  app.press(sequence);
  return shown(app);
}

describe('the finished plays in the side bar', () => {
  it('collapsed (the default): the section is there, with its count, and the plays are not', async () => {
    const { app } = await open(withSidebar('collapsed'));
    const frame = await shown(app);
    expect(frame).toContain('▸ FINISHED');
    expect(frame).not.toContain('ship it');
    // The side bar has the focus after three Tab; F (the registry action) opens the section.
    for (const sequence of ['\t', '\t', '\t']) await key(app, sequence);
    const opened = await key(app, 'f');
    expect(opened).toContain('▾ FINISHED');
    expect(opened).toContain('ship it');
    expect(opened).toContain('drop it');
    // The most recent one first.
    expect(opened.indexOf('ship it')).toBeLessThan(opened.indexOf('drop it'));
    const closed = await key(app, 'f');
    expect(closed).not.toContain('ship it');
  });

  it('expanded: the plays are listed from the start', async () => {
    const { app } = await open(withSidebar('expanded'));
    const frame = await shown(app);
    expect(frame).toContain('▾ FINISHED');
    expect(frame).toContain('ship it');
    expect(frame).toContain('cancelled');
  });

  it('hidden: no section, and the key does nothing', async () => {
    const { app, online } = await open(withSidebar('hidden'));
    for (const sequence of ['\t', '\t', '\t']) await key(app, sequence);
    const frame = await key(app, 'f');
    expect(frame).not.toContain('FINISHED');
    expect(frame).not.toContain('ship it');
    expect(Object.keys(online.stores.plays.getState().byId).length).toBeGreaterThan(0);
  });

  it('opens the section with Enter on its head, and the chat goes to the scenario of a play', async () => {
    const { app } = await open(withSidebar('collapsed'));
    // Side bar, then: scenarios head, three scenarios, finished head.
    for (const sequence of ['\t', '\t', '\t', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\r']) {
      await key(app, sequence);
    }
    expect(await shown(app)).toContain('ship it');
    // The first line of the section is the most recent play, of the first scenario.
    await key(app, '\x1b[B');
    await key(app, '\r');
    const frame = await shown(app);
    expect(frame.split('\n')[2]).toMatch(/Billing API/);
  });
});
