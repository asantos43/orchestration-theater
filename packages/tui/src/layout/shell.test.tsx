// SPDX-License-Identifier: MPL-2.0
import { Text } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupApps, renderApp, type RenderedApp } from '../ink.test-support.js';
import { fakeOnline, seedStores, type FakeOnline } from '../layout.test-support.js';
import { Section } from './section.js';
import type { TabContentMap } from './tab-content.js';

/**
 * The areas of the screen and what the keys do in each: the focus walk, the side bar, the folding
 * of the sections of a tab, and the scroll of the panel. A tab is a test one that draws two
 * sections, the way the steps that fill the tabs will.
 */

afterEach(cleanupApps);

const tabContent: TabContentMap = {
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

async function open(): Promise<{ app: RenderedApp; online: FakeOnline }> {
  const online = fakeOnline();
  seedStores(online.stores);
  const app = await renderApp({
    connector: online.connector,
    size: { columns: 140, rows: 42 },
    tabContent,
  });
  await app.waitForText('SCENARIOS');
  return { app, online };
}

/** One key at a time, as a terminal sends them: the app has handled it before the next. */
async function key(app: RenderedApp, sequence: string): Promise<string> {
  app.press(sequence);
  return app.settle();
}

async function waitUntil(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timeout waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the tabs of the panel', () => {
  it('open on a key, take the focus, and draw what the step that owns them gives', async () => {
    const { app, online } = await open();
    app.press('\x1b[15~');
    const frame = await app.waitForText('First section');
    expect(frame).toContain('first body');
    expect(frame).toContain('Settings ✕');
    expect(online.layouts[0]?.layout.openTabs).toEqual(['overview', 'settings']);
  });

  it('fold and unfold a section with Enter, one at a time with the arrows, and keep it in the store', async () => {
    const { app, online } = await open();
    app.press('\x1b[15~');
    await app.waitForText('first body');
    app.press('\r');
    await waitUntil(
      () => online.layouts[0]?.layout.collapsedSections.includes('settings.first') === true,
    );
    let frame = await app.settle();
    expect(frame).not.toContain('first body');
    expect(frame).toContain('second body');
    expect(frame).toContain('▸ First section');
    await key(app, '\x1b[B');
    await key(app, '\r');
    await waitUntil(
      () => online.layouts[0]?.layout.collapsedSections.includes('settings.second') === true,
    );
    frame = await app.settle();
    expect(frame).not.toContain('second body');
    app.press('\r');
    await waitUntil(
      () => online.layouts[0]?.layout.collapsedSections.includes('settings.second') === false,
    );
    frame = await app.settle();
    expect(frame).toContain('second body');
    expect(frame).not.toContain('first body');
  });

  it('go from one tab to the other with Left and Right when the panel has the focus', async () => {
    const { app } = await open();
    app.press('\x1b[15~');
    await app.waitForText('first body');
    app.press('\x1b[D');
    const frame = await app.waitForText('This tab has no content yet.');
    expect(frame).not.toContain('first body');
    app.press('\x1b[C');
    await app.waitForText('first body');
  });
});

describe('the focus', () => {
  it('walks chat, border, panel and side bar with Tab, and back with Shift+Tab', async () => {
    const { app } = await open();
    // The shortcut bar (the last row) is of the area that has the focus.
    const bar = async (sequence?: string): Promise<string> => {
      const frame = sequence === undefined ? await app.settle() : await key(app, sequence);
      return frame.split('\n').at(-1) ?? '';
    };
    expect(await bar()).toContain('PageUp  Scroll');
    expect(await bar('\t')).toContain('Width');
    expect(await bar('\t')).toContain('Enter  Fold');
    expect(await bar('\t')).toContain('Enter  Open');
    expect(await bar('\x1b[Z')).toContain('Enter  Fold');
    expect(await bar('\x1b[Z')).toContain('Width');
    expect(await bar('\x1b[Z')).toContain('PageUp  Scroll');
  });

  it('chooses a scenario in the side bar: the chat is about it from then on', async () => {
    const { app } = await open();
    for (const sequence of ['\t', '\t', '\t', '\x1b[B', '\x1b[B', '\r']) await key(app, sequence);
    const frame = await app.waitForText('State: decision');
    expect(frame.split('\n')[2]).toMatch(/││Mobile app/);
  });
});
