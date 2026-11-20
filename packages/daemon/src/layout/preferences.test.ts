// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LAYOUT_VERSION, defaultLayout, type LayoutPreferences } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordingSituations, captureLogger, makeTempDataDir } from '../test-helpers.js';
import {
  LAYOUT_KEPT_SUFFIX,
  LayoutPreferencesStore,
  type LayoutPreferencesOptions,
} from './preferences.js';

/** The records of the layout in a folder, with the cases of P12 of docs/17: nothing here may throw. */

let tmp: Awaited<ReturnType<typeof makeTempDataDir>>;
let dir: string;
let situations: RecordingSituations;

beforeEach(async () => {
  tmp = await makeTempDataDir();
  dir = join(tmp.dir, 'layout');
  situations = new RecordingSituations();
});

afterEach(async () => {
  await tmp.dispose();
});

async function open(read?: LayoutPreferencesOptions['read']) {
  const captured = captureLogger();
  const store = await LayoutPreferencesStore.open({
    dir,
    situations,
    logger: captured.logger,
    ...(read === undefined ? {} : { read }),
  });
  return { store, lines: captured.lines };
}

const SAVED: LayoutPreferences = {
  version: LAYOUT_VERSION,
  sidebarCollapsed: true,
  chatWidth: 72,
  openTabs: ['overview', 'plays'],
  collapsedSections: ['quotas'],
};

describe('LayoutPreferencesStore', () => {
  it('serves the default of each interface when nothing was saved, without an event', async () => {
    const { store, lines } = await open();
    expect(store.get('tui')).toEqual(defaultLayout('tui'));
    expect(store.get('web')).toEqual(defaultLayout('web'));
    expect(situations.recorded).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  it('saves a record per interface and finds it again after a restart', async () => {
    const first = (await open()).store;
    await first.put('tui', SAVED);
    expect(first.get('tui')).toEqual(SAVED);
    expect(first.get('web')).toEqual(defaultLayout('web'));
    const second = (await open()).store;
    expect(second.get('tui')).toEqual(SAVED);
    expect(second.get('web')).toEqual(defaultLayout('web'));
    // The save is a `layout.changed`; reading it again after a restart is no event.
    expect(situations.recorded.map((item) => item.type)).toEqual(['layout.changed']);
    expect(await readdir(dir)).toEqual(['tui.json']);
  });

  it('writes layout.changed for a write that changes the record, with the record and its origin', async () => {
    const { store } = await open();
    await store.put('tui', SAVED, 'client-a');
    await store.put('web', { ...SAVED, chatWidth: 500 });
    expect(situations.of('layout.changed')).toEqual([
      { interface: 'tui', origin: 'client-a', layout: SAVED },
      { interface: 'web', origin: null, layout: { ...SAVED, chatWidth: 500 } },
    ]);
  });

  it('writes no event for a write equal to the record that is there, saved or default', async () => {
    const { store } = await open();
    // The default of the interface is what is there when nothing was saved.
    await store.put('tui', defaultLayout('tui'));
    expect(situations.recorded).toHaveLength(0);
    await store.put('tui', SAVED);
    await store.put('tui', { ...SAVED }, 'client-a');
    expect(situations.of('layout.changed')).toHaveLength(1);
    // One that differs by a single field is a change again.
    await store.put('tui', { ...SAVED, openTabs: ['overview'] });
    expect(situations.of('layout.changed')).toHaveLength(2);
  });

  it('writes no event when the write fails: the record did not change', async () => {
    await writeFile(join(tmp.dir, 'blocker'), 'x');
    const blocked = await LayoutPreferencesStore.open({
      dir: join(tmp.dir, 'blocker', 'layout'),
      situations,
      logger: captureLogger().logger,
    });
    await expect(blocked.put('tui', SAVED)).rejects.toThrow();
    expect(situations.of('layout.changed')).toHaveLength(0);
  });

  it('writes the writes of a burst in order, and the last one stays', async () => {
    const { store } = await open();
    await Promise.all(
      [10, 20, 30, 40].map((chatWidth) => store.put('web', { ...SAVED, chatWidth })),
    );
    expect(store.get('web').chatWidth).toBe(40);
    expect(JSON.parse(await readFile(join(dir, 'web.json'), 'utf8'))).toMatchObject({
      chatWidth: 40,
    });
    // No temporary file is left beside the record.
    expect(await readdir(dir)).toEqual(['web.json']);
  });

  it('keeps the old record in memory when the write fails', async () => {
    const { store } = await open();
    await store.put('tui', SAVED);
    await writeFile(join(tmp.dir, 'blocker'), 'x');
    const blocked = await LayoutPreferencesStore.open({
      dir: join(tmp.dir, 'blocker', 'layout'),
      situations,
      logger: captureLogger().logger,
    });
    await expect(blocked.put('tui', SAVED)).rejects.toThrow();
    expect(blocked.get('tui')).toEqual(defaultLayout('tui'));
    // A failed write does not poison the next one.
    await expect(store.put('tui', { ...SAVED, chatWidth: 80 })).resolves.toBeDefined();
  });

  it('writes a migrated record back and records the event', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tui.json'), JSON.stringify({ version: 1 }));
    const { store, lines } = await open((layoutInterface) => ({
      outcome: 'migrated',
      layout: { ...defaultLayout(layoutInterface), chatWidth: 77 },
      fromVersion: 0,
    }));
    expect(store.get('tui').chatWidth).toBe(77);
    expect(situations.of('layout.adjusted')).toEqual([
      { interface: 'tui', action: 'migrated', reason: null, fromVersion: 0, kept: false },
    ]);
    expect(JSON.parse(await readFile(join(dir, 'tui.json'), 'utf8'))).toMatchObject({
      version: LAYOUT_VERSION,
      chatWidth: 77,
    });
    expect(await readdir(dir)).toEqual(['tui.json']);
    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1);
  });

  it('replaces a record of a newer version by the default and keeps a copy', async () => {
    await mkdir(dir, { recursive: true });
    const text = JSON.stringify({ ...SAVED, version: LAYOUT_VERSION + 1 });
    await writeFile(join(dir, 'web.json'), text);
    const { store, lines } = await open();
    expect(store.get('web')).toEqual(defaultLayout('web'));
    expect(situations.of('layout.adjusted')).toEqual([
      {
        interface: 'web',
        action: 'replaced',
        reason: 'newer_version',
        fromVersion: LAYOUT_VERSION + 1,
        kept: true,
      },
    ]);
    expect(await readFile(join(dir, `web.json${LAYOUT_KEPT_SUFFIX}`), 'utf8')).toBe(text);
    expect((await readdir(dir)).sort()).toEqual([`web.json${LAYOUT_KEPT_SUFFIX}`]);
    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1);
  });

  it.each([
    ['not JSON', '{ nope'],
    ['not an object', '[1, 2]'],
    ['out of the schema', JSON.stringify({ ...SAVED, chatWidth: -4 })],
    ['with an unknown field', JSON.stringify({ ...SAVED, extra: 1 })],
  ])('replaces a record that is %s without stopping the start', async (_name, text) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tui.json'), text);
    const { store } = await open();
    expect(store.get('tui')).toEqual(defaultLayout('tui'));
    const [event] = situations.of('layout.adjusted') as { action: string; reason: string }[];
    expect(event).toMatchObject({ action: 'replaced', reason: 'invalid' });
    expect(await readFile(join(dir, `tui.json${LAYOUT_KEPT_SUFFIX}`), 'utf8')).toBe(text);
    // The next write starts from the default, and the copy stays.
    await store.put('tui', SAVED);
    expect((await open()).store.get('tui')).toEqual(SAVED);
    expect((await readdir(dir)).sort()).toEqual(['tui.json', `tui.json${LAYOUT_KEPT_SUFFIX}`]);
  });

  it('uses the default and records an event when the record cannot be read', async () => {
    // A folder where the file should be: the read fails with something other than "not found".
    await mkdir(join(dir, 'tui.json'), { recursive: true });
    const { store } = await open();
    expect(store.get('tui')).toEqual(defaultLayout('tui'));
    expect(situations.of('layout.adjusted')).toEqual([
      { interface: 'tui', action: 'replaced', reason: 'invalid', fromVersion: null, kept: false },
    ]);
  });
});
