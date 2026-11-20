// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LAYOUT_VERSION, defaultLayout } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../layout/manual-clock.test-support.js';
import { LocalLayoutPersistence } from '../layout/persistence.js';
import { LayoutStore, type LayoutProblem } from '../layout/store.js';
import { removeTempDirs, tempDir } from '../test-daemon.test-support.js';
import { FileLayoutStore, clientLayoutFile, layoutFileName } from './layout-file.js';

/** The `local` layout mode against a real temporary folder (P12 of docs/17). */

afterEach(removeTempDirs);

function storeOver(dir: string, which: 'tui' | 'web', problems: LayoutProblem[] = []): LayoutStore {
  return new LayoutStore({
    interface: which,
    persistence: new LocalLayoutPersistence(
      new FileLayoutStore(clientLayoutFile(dir, which)),
      which,
    ),
    clock: new ManualClock(),
    writeDelayMs: 0,
    onProblem: (problem) => problems.push(problem),
  });
}

describe('FileLayoutStore', () => {
  it('names the file by interface, beside client.json', async () => {
    expect(layoutFileName('tui')).toBe('layout.tui.json');
    const dir = await tempDir();
    expect(clientLayoutFile(dir, 'web')).toBe(join(dir, 'layout.web.json'));
  });

  it('reads nothing from a missing file and writes it atomically at mode 0600', async () => {
    const dir = await tempDir();
    const file = new FileLayoutStore(join(dir, 'a', 'layout.tui.json'));
    expect(await file.read()).toBeUndefined();
    await file.write('{"x":1}\n');
    expect(await file.read()).toBe('{"x":1}\n');
    expect(await readdir(join(dir, 'a'))).toEqual(['layout.tui.json']);
    if (process.platform !== 'win32') {
      expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    }
  });

  it('sets a file aside as .bad, and says false when there is none', async () => {
    const dir = await tempDir();
    const file = new FileLayoutStore(join(dir, 'layout.tui.json'));
    expect(await file.setAside()).toBe(false);
    await file.write('junk');
    expect(await file.setAside()).toBe(true);
    expect(await readFile(`${file.path}.bad`, 'utf8')).toBe('junk');
    expect(await file.read()).toBeUndefined();
  });
});

describe('the local layout store in a folder', () => {
  it('keeps the layout between runs, per interface', async () => {
    const dir = await tempDir();
    const first = storeOver(dir, 'tui');
    await first.load();
    first.update({ sidebarCollapsed: true, chatWidth: 99, collapsedSections: ['events'] });
    await first.flush();
    first.close();

    const again = storeOver(dir, 'tui');
    await again.load();
    expect(again.layout).toMatchObject({
      sidebarCollapsed: true,
      chatWidth: 99,
      collapsedSections: ['events'],
    });
    const web = storeOver(dir, 'web');
    await web.load();
    expect(web.layout).toEqual(defaultLayout('web'));
    expect((await readdir(dir)).sort()).toEqual(['layout.tui.json']);
  });

  it.each([
    ['an invalid file', '{ "version": 1, "chatWidth": '],
    ['a file of a newer version', JSON.stringify({ version: LAYOUT_VERSION + 4, anything: true })],
  ])('replaces %s by the default, keeps a copy, warns, and goes on', async (_name, text) => {
    const dir = await tempDir();
    await mkdir(dir, { recursive: true });
    const path = clientLayoutFile(dir, 'tui');
    await writeFile(path, text);
    const problems: LayoutProblem[] = [];
    const store = storeOver(dir, 'tui', problems);
    await store.load();
    expect(store.layout).toEqual(defaultLayout('tui'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'adjusted', action: 'replaced', kept: true });
    expect(await readFile(`${path}.bad`, 'utf8')).toBe(text);
    // The next change is saved over the place of the old file, and the copy stays.
    store.setChatWidth(70);
    await store.flush();
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ chatWidth: 70 });
    expect((await readdir(dir)).sort()).toEqual(['layout.tui.json', 'layout.tui.json.bad']);
  });
});
