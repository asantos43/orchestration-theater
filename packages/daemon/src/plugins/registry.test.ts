// SPDX-License-Identifier: MPL-2.0
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Conflict, InvalidInput, NotFound, type Clock } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import { hashManifestBytes } from './manifest-file.js';
import { manifestText, writePluginFolder } from './plugin-fixture.js';
import {
  PluginRegistry,
  pluginPaths,
  type PluginNotice,
  type PluginOrigin,
  type PluginsChange,
} from './registry.js';

/** A clock whose sleeps pass instantly, moving `now` forward: for the tests of the file lock. */
class FastClock implements Clock {
  #now = 1_800_000_000_000;
  now(): number {
    return this.#now;
  }
  sleep(ms: number): Promise<void> {
    this.#now += ms;
    return Promise.resolve();
  }
}

describe('PluginRegistry', () => {
  let data: Awaited<ReturnType<typeof makeTempDataDir>>;
  let folder: string;
  let registry: PluginRegistry;
  const clock = new FakeClock();

  const origin = (): PluginOrigin => ({ kind: 'path', path: folder });
  const hashOf = async (): Promise<string> =>
    hashManifestBytes(await readFile(join(folder, 'plugin.yaml')));

  /** Registers the fixture folder as it is on disk now. */
  const registerFolder = async (version = '1.0.0'): Promise<void> => {
    await registry.register({
      id: 'demo-db',
      version,
      origin: origin(),
      dir: folder,
      manifestHash: await hashOf(),
    });
  };

  beforeEach(async () => {
    data = await makeTempDataDir();
    folder = await writePluginFolder(join(data.dir, 'src', 'demo-db'));
    registry = await PluginRegistry.open({
      dataDir: data.dir,
      clock,
      logger: createSilentLogger(),
    });
  });
  afterEach(async () => {
    registry.close();
    await data.dispose();
  });

  it('starts empty and gives a frozen list for a project with no plugin', () => {
    expect(registry.list()).toEqual([]);
    const none = registry.activeFor('p1');
    expect(none).toEqual([]);
    expect(Object.isFrozen(none)).toBe(true);
  });

  it('installs off: a registered plugin is active in no project until enable', async () => {
    await registerFolder();
    expect(registry.activeFor('p1')).toEqual([]);
    expect(registry.get('demo-db')?.projects).toEqual([]);
  });

  it('enable makes it active in that project only, with the manifest, folder and hash', async () => {
    await registerFolder();
    const changes: PluginsChange[] = [];
    registry.onChange((change) => changes.push(change));

    const outcome = await registry.enable('demo-db', 'p1', await hashOf());
    expect(outcome.changed).toBe(true);

    const [active] = registry.activeFor('p1');
    expect(active).toMatchObject({
      id: 'demo-db',
      version: '1.0.0',
      dir: folder,
      manifestHash: await hashOf(),
    });
    expect(active?.manifest.tools.map((tool) => tool.name)).toEqual(['query_sql']);
    expect(Object.isFrozen(active)).toBe(true);
    expect(registry.activeFor('p2')).toEqual([]);
    expect(registry.activeProjects()).toEqual(['p1']);
    expect(changes).toEqual([{ projects: ['p1'], plugins: ['demo-db'] }]);

    // Enabling again with the same manifest changes nothing and tells nobody.
    expect((await registry.enable('demo-db', 'p1')).changed).toBe(false);
    expect(changes).toHaveLength(1);
  });

  it('disable turns it off in that project and says whether it was on', async () => {
    await registerFolder();
    await registry.enable('demo-db', 'p1');
    await registry.enable('demo-db', 'p2');
    const changes: PluginsChange[] = [];
    registry.onChange((change) => changes.push(change));

    expect(await registry.disable('demo-db', 'p1')).toBe(true);
    expect(await registry.disable('demo-db', 'p1')).toBe(false);
    expect(registry.activeFor('p1')).toEqual([]);
    expect(registry.activeFor('p2')).toHaveLength(1);
    expect(changes).toEqual([{ projects: ['p1'], plugins: ['demo-db'] }]);
  });

  it('hot swap: the array handed out before a change is not changed by it', async () => {
    await registerFolder();
    await registry.enable('demo-db', 'p1');
    const before = registry.activeFor('p1');
    const snapshotBefore = registry.activeSnapshot();

    await registry.disable('demo-db', 'p1');

    expect(before).toHaveLength(1);
    expect(snapshotBefore.get('p1')).toHaveLength(1);
    expect(registry.activeFor('p1')).toEqual([]);
    expect(registry.activeSnapshot()).not.toBe(snapshotBefore);
  });

  it('refuses to approve a manifest that is not the one that was shown', async () => {
    await registerFolder();
    const shown = await hashOf();
    await writeFile(join(folder, 'plugin.yaml'), manifestText({ variant: 'changed' }));
    await expect(registry.enable('demo-db', 'p1', shown)).rejects.toBeInstanceOf(Conflict);
    expect(registry.activeFor('p1')).toEqual([]);
  });

  it('a manifest changed on disk turns the plugin off, and enable approves the new one', async () => {
    await registerFolder();
    await registry.enable('demo-db', 'p1');
    const notices: PluginNotice[] = [];
    registry.onNotice((notice) => notices.push(notice));
    const changes: PluginsChange[] = [];
    registry.onChange((change) => changes.push(change));

    await writeFile(join(folder, 'plugin.yaml'), manifestText({ variant: 'changed' }));
    await registry.refresh();

    expect(registry.activeFor('p1')).toEqual([]);
    expect(registry.get('demo-db')?.projects).toEqual([{ project: 'p1', state: 'needs_approval' }]);
    expect(notices).toEqual([{ kind: 'needs_approval', id: 'demo-db', projects: ['p1'] }]);
    expect(changes).toEqual([{ projects: ['p1'], plugins: ['demo-db'] }]);

    await registry.enable('demo-db', 'p1');
    expect(registry.activeFor('p1')[0]?.manifest.tools.map((tool) => tool.name)).toEqual([
      'query_sql',
      'drop_table',
    ]);
  });

  it('an update that brings another manifest leaves the projects off and lists them', async () => {
    await registerFolder();
    await registry.enable('demo-db', 'p1');
    await registry.enable('demo-db', 'p2');

    await writeFile(
      join(folder, 'plugin.yaml'),
      manifestText({ variant: 'changed', version: '1.1.0' }),
    );
    const outcome = await registry.register({
      id: 'demo-db',
      version: '1.1.0',
      origin: origin(),
      dir: folder,
      manifestHash: await hashOf(),
    });

    expect(outcome.kind).toBe('updated');
    expect(outcome.needsApproval).toEqual(['p1', 'p2']);
    expect(registry.activeProjects()).toEqual([]);
  });

  it('an update with the same manifest keeps the plugin on', async () => {
    await registerFolder();
    await registry.enable('demo-db', 'p1');
    // Same bytes, only the code changed (a new server.js): no new approval is asked for.
    await writeFile(join(folder, 'server.js'), '// a new server\n');
    const outcome = await registry.register({
      id: 'demo-db',
      version: '1.0.0',
      origin: origin(),
      dir: folder,
      manifestHash: await hashOf(),
    });
    expect(outcome.needsApproval).toEqual([]);
    expect(registry.activeFor('p1')).toHaveLength(1);
  });

  it('a manifest that became invalid is "broken", never active', async () => {
    await registerFolder();
    await registry.enable('demo-db', 'p1');
    const notices: PluginNotice[] = [];
    registry.onNotice((notice) => notices.push(notice));

    await writeFile(join(folder, 'plugin.yaml'), 'manifest_version: 1\nid: demo-db\n');
    await registry.refresh();

    expect(registry.activeFor('p1')).toEqual([]);
    expect(registry.get('demo-db')?.projects).toEqual([{ project: 'p1', state: 'broken' }]);
    expect(notices.map((notice) => notice.kind)).toContain('broken');
    expect(registry.get('demo-db')?.problem).toContain('version');
  });

  it('remove forgets the plugin and its activations', async () => {
    await registerFolder();
    await registry.enable('demo-db', 'p1');
    await registry.remove('demo-db');
    expect(registry.list()).toEqual([]);
    expect(registry.activeFor('p1')).toEqual([]);
    await expect(registry.remove('demo-db')).rejects.toBeInstanceOf(NotFound);
    await expect(registry.enable('demo-db', 'p1')).rejects.toBeInstanceOf(NotFound);
  });

  it('rejects project ids that are not plain', async () => {
    await registerFolder();
    for (const project of ['', '__proto__', '../x', 'a b', '-lead']) {
      await expect(registry.enable('demo-db', project)).rejects.toBeInstanceOf(InvalidInput);
    }
  });

  it('survives a restart: the file is what the next registry loads', async () => {
    await registerFolder();
    await registry.enable('demo-db', 'p1');
    registry.close();

    registry = await PluginRegistry.open({
      dataDir: data.dir,
      clock,
      logger: createSilentLogger(),
    });
    expect(registry.activeFor('p1')).toHaveLength(1);
    const text = await readFile(pluginPaths(data.dir).file, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ version: 1, plugins: [{ id: 'demo-db' }] });
  });

  it('a registry file that cannot be read leaves no plugin on and is not overwritten', async () => {
    await registerFolder();
    await registry.enable('demo-db', 'p1');
    registry.close();
    const file = pluginPaths(data.dir).file;
    await writeFile(file, '{ not json');

    registry = await PluginRegistry.open({
      dataDir: data.dir,
      clock,
      logger: createSilentLogger(),
    });
    expect(registry.activeFor('p1')).toEqual([]);
    await expect(registerFolder()).rejects.toBeInstanceOf(InvalidInput);
    expect(await readFile(file, 'utf8')).toBe('{ not json');
  });

  it('a folder outside <data>/plugins is broken for an npm or git origin', async () => {
    await mkdir(pluginPaths(data.dir).dir, { recursive: true });
    await registry.register({
      id: 'demo-db',
      version: '1.0.0',
      origin: { kind: 'git', url: 'file:///x', ref: 'main', commit: 'a'.repeat(40) },
      dir: folder,
      manifestHash: await hashOf(),
    });
    expect(registry.get('demo-db')?.problem).toContain('outside');
    await expect(registry.enable('demo-db', 'p1')).resolves.toBeDefined();
    expect(registry.activeFor('p1')).toEqual([]);
  });

  it('serializes mutations that start together', async () => {
    await registerFolder();
    await Promise.all(
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((project) => registry.enable('demo-db', project)),
    );
    expect(registry.activeProjects()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  it('another process writing the file is seen by refresh', async () => {
    const other = await PluginRegistry.open({
      dataDir: data.dir,
      clock,
      logger: createSilentLogger(),
    });
    await registerFolder();
    await registry.enable('demo-db', 'p1');
    expect(other.activeFor('p1')).toEqual([]);
    await other.refresh();
    expect(other.activeFor('p1')).toHaveLength(1);
    other.close();
  });

  it('watch() brings in a change made by another registry on the same data folder', async () => {
    const other = await PluginRegistry.open({
      dataDir: data.dir,
      clock,
      logger: createSilentLogger(),
    });
    other.watch(10);
    await registerFolder();
    await registry.enable('demo-db', 'p1');
    await vi.waitFor(
      () => {
        expect(other.activeFor('p1')).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    other.close();
  });

  describe('the lock between processes', () => {
    it('takes over a lock that is older than the limit', async () => {
      const fast = await PluginRegistry.open({
        dataDir: data.dir,
        clock: new FastClock(),
        logger: createSilentLogger(),
      });
      const { lock } = pluginPaths(data.dir);
      await writeFile(lock, JSON.stringify({ token: 'dead', at: 1_800_000_000_000 - 120_000 }));
      await fast.register({
        id: 'demo-db',
        version: '1.0.0',
        origin: origin(),
        dir: folder,
        manifestHash: await hashOf(),
      });
      expect(fast.get('demo-db')).toBeDefined();
      await expect(readFile(lock, 'utf8')).rejects.toThrow();
      fast.close();
    });

    it('gives up with Conflict while a recent lock is held, and leaves it alone', async () => {
      const fast = await PluginRegistry.open({
        dataDir: data.dir,
        clock: new FastClock(),
        logger: createSilentLogger(),
      });
      const { lock } = pluginPaths(data.dir);
      const held = JSON.stringify({ token: 'other', at: 1_800_000_000_000 });
      await writeFile(lock, held);
      await expect(
        fast.register({
          id: 'demo-db',
          version: '1.0.0',
          origin: origin(),
          dir: folder,
          manifestHash: await hashOf(),
        }),
      ).rejects.toBeInstanceOf(Conflict);
      expect(await readFile(lock, 'utf8')).toBe(held);
      fast.close();
    });
  });
});
