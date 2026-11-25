// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_DISCOVERY_FILE, API_TOKEN_FILE, type DaemonId } from '@otheater/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDaemonConnection } from '../directory.js';
import { DaemonDirectoryError } from '../errors.js';
import {
  removeTempDirs,
  startTestDaemon,
  tempDir,
  writeDaemonFiles,
  type TestDaemon,
} from '../test-daemon.test-support.js';
import {
  createNodeDaemonDirectory,
  FileDaemonListStore,
  writePrivateFileAtomic,
  isPidAlive,
  readLocalDaemon,
} from './index.js';
import {
  CLIENT_CONFIG_DIR_ENV,
  DATA_DIR_ENV,
  clientConfigFile,
  defaultClientConfigDir,
  defaultDataDir,
  resolveClientConfigDir,
  resolveDataDir,
} from './paths.js';

const ID_A = '11111111-1111-4111-8111-111111111111' as DaemonId;
const open: TestDaemon[] = [];
afterEach(async () => {
  for (const started of open.splice(0)) await started.close();
  await removeTempDirs();
});

const connection = (name: string, daemonId: DaemonId) =>
  parseDaemonConnection({ name, url: 'http://127.0.0.1:9', daemonId, token: `t-${name}` });

describe('FileDaemonListStore', () => {
  it('a missing file is an empty list, and the folder is made on the first save', async () => {
    const dir = await tempDir();
    const path = join(dir, 'a', 'b', 'client.json');
    const store = new FileDaemonListStore(path);
    expect(await store.load()).toEqual([]);
    await store.save([connection('casa', ID_A)]);
    expect(await store.load()).toEqual([connection('casa', ID_A)]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 });
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the file at 0600 and the folder at 0700',
    async () => {
      const dir = await tempDir();
      const path = join(dir, 'cfg', 'client.json');
      const store = new FileDaemonListStore(path);
      await store.save([connection('casa', ID_A)]);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, 'cfg'))).mode & 0o777).toBe(0o700);
      // A looser mode is tightened by the next write.
      await chmod(path, 0o644);
      await store.save([]);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
  );

  it('leaves no temporary file behind', async () => {
    const dir = await tempDir();
    const store = new FileDaemonListStore(join(dir, 'client.json'));
    await Promise.all(
      [0, 1, 2, 3].map((index) =>
        store.save([
          connection(`d${String(index)}`, `00000000-0000-4000-8000-00000000000${String(index)}`),
        ]),
      ),
    );
    expect(await readdir(dir)).toEqual(['client.json']);
    // Saves run in call order, so the last one called is the one on disk.
    expect((await store.load()).map((saved) => saved.name)).toEqual(['d3']);
  });

  it('a file that is not a list is unreadable, and is never overwritten', async () => {
    const dir = await tempDir();
    const path = join(dir, 'client.json');
    for (const content of ['not json', '{"version":2,"daemons":[]}', '{"version":1}', '[]']) {
      await writeFile(path, content);
      const store = new FileDaemonListStore(path);
      await expect(store.load()).rejects.toMatchObject({
        name: 'DaemonDirectoryError',
        code: 'unreadable_file',
      });
      expect(await readFile(path, 'utf8')).toBe(content);
    }
  });

  it('a directory that fails an add does not rewrite the corrupt file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'client.json');
    await writeFile(path, '{broken');
    const directory = createNodeDaemonDirectory({ configDir: dir, dataDir: join(dir, 'nodata') });
    const error = await directory
      .add({ name: 'x', url: 'http://127.0.0.1:9', token: 't', daemonId: ID_A })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DaemonDirectoryError);
    expect(await readFile(path, 'utf8')).toBe('{broken');
  });
});

describe('readLocalDaemon', () => {
  const daemonFiles = { url: 'http://127.0.0.1:4321/', daemonId: ID_A, token: 'local-secret' };

  it('reads the url, id and token of a running daemon', async () => {
    const dir = await tempDir();
    await writeDaemonFiles(dir, daemonFiles);
    expect(await readLocalDaemon(dir)).toMatchObject({
      url: 'http://127.0.0.1:4321/',
      daemonId: ID_A,
      token: 'local-secret',
      pid: process.pid,
    });
  });

  it('is undefined with no files, a bad file, no token or an empty token', async () => {
    const dir = await tempDir();
    expect(await readLocalDaemon(dir)).toBeUndefined();
    await writeDaemonFiles(dir, daemonFiles);
    await writeFile(join(dir, API_TOKEN_FILE), '\n');
    expect(await readLocalDaemon(dir)).toBeUndefined();
    await writeFile(join(dir, API_TOKEN_FILE), 'ok');
    expect(await readLocalDaemon(dir)).toBeDefined();
    await writeFile(join(dir, API_DISCOVERY_FILE), '{nope');
    expect(await readLocalDaemon(dir)).toBeUndefined();
    await writeFile(join(dir, API_DISCOVERY_FILE), '{"url":"x"}');
    expect(await readLocalDaemon(dir)).toBeUndefined();
    const other = await tempDir();
    await writeDaemonFiles(other, daemonFiles);
    const { rm } = await import('node:fs/promises');
    await rm(join(other, API_TOKEN_FILE));
    expect(await readLocalDaemon(other)).toBeUndefined();
  });

  it('a pid that is gone means no daemon (injected check)', async () => {
    const dir = await tempDir();
    await writeDaemonFiles(dir, daemonFiles, 4_000_000);
    expect(await readLocalDaemon(dir, { isPidAlive: () => false })).toBeUndefined();
    expect(await readLocalDaemon(dir, { isPidAlive: (pid) => pid === 4_000_000 })).toBeDefined();
  });

  it('a pid of a process that really exited means no daemon', async () => {
    const child = spawnSync(process.execPath, ['-e', '0']);
    const pid = child.pid;
    expect(pid).toBeGreaterThan(0);
    expect(isPidAlive(pid)).toBe(false);
    const dir = await tempDir();
    await writeDaemonFiles(dir, daemonFiles, pid);
    expect(await readLocalDaemon(dir)).toBeUndefined();
  });

  it('isPidAlive is true for this process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});

describe('paths', () => {
  const home = '/home/ana';
  it.each([
    ['linux', {}, '/home/ana/.config/otheater'],
    ['linux', { XDG_CONFIG_HOME: '/x/cfg' }, '/x/cfg/otheater'],
    ['linux', { XDG_CONFIG_HOME: 'relative' }, '/home/ana/.config/otheater'],
    ['linux', { XDG_CONFIG_HOME: '' }, '/home/ana/.config/otheater'],
    ['darwin', {}, '/home/ana/Library/Application Support/OTheater'],
    [
      'win32',
      { APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' },
      'C:\\Users\\ana\\AppData\\Roaming\\OTheater',
    ],
    ['win32', {}, '\\home\\ana\\AppData\\Roaming\\OTheater'],
  ] as const)('the client folder on %s with %j', (platform, env, expected) => {
    expect(defaultClientConfigDir(platform, env, home)).toBe(expected);
  });

  it('OT_CLIENT_CONFIG_DIR overrides the default', async () => {
    const dir = await tempDir();
    const configDir = resolveClientConfigDir({
      env: { [CLIENT_CONFIG_DIR_ENV]: dir, XDG_CONFIG_HOME: '/never' },
      platform: 'linux',
      homedir: home,
    });
    expect(configDir).toBe(dir);
    expect(clientConfigFile(configDir)).toBe(join(dir, 'client.json'));
    expect(resolveClientConfigDir({ env: {}, platform: 'linux', homedir: home })).toBe(
      '/home/ana/.config/otheater',
    );
  });

  it.each([
    ['linux', {}, '/home/ana/.local/share/otheater'],
    ['linux', { XDG_DATA_HOME: '/x/data' }, '/x/data/otheater'],
    ['darwin', {}, '/home/ana/Library/Application Support/OTheater'],
    ['win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\L\\OTheater'],
  ] as const)('the data folder on %s with %j', (platform, env, expected) => {
    expect(defaultDataDir(platform, env, home)).toBe(expected);
  });

  it('the data folder: explicit, then OT_DATA_DIR, then the default', async () => {
    const a = await tempDir();
    const b = await tempDir();
    const base = { platform: 'linux', homedir: home } as const;
    expect(resolveDataDir({ ...base, env: { [DATA_DIR_ENV]: b }, explicit: a })).toBe(a);
    expect(resolveDataDir({ ...base, env: { [DATA_DIR_ENV]: b } })).toBe(b);
    expect(resolveDataDir({ ...base, env: {} })).toBe('/home/ana/.local/share/otheater');
  });
});

describe('createNodeDaemonDirectory with two real servers', () => {
  it('finds the local one from its files, saves the other, and talks to both', async () => {
    const root = await tempDir();
    const configDir = join(root, 'config');
    const dataDir = join(root, 'data');
    await mkdir(dataDir, { recursive: true });
    const local = await startTestDaemon();
    const remote = await startTestDaemon();
    open.push(local, remote);
    await writeDaemonFiles(dataDir, local);

    const directory = createNodeDaemonDirectory({
      env: { [CLIENT_CONFIG_DIR_ENV]: configDir, [DATA_DIR_ENV]: dataDir },
    });
    await directory.enroll({ name: 'nuvem', url: remote.url, token: remote.token });

    const outcomes = await directory.connectAll();
    expect(outcomes.map((o) => [o.entry.name, o.ok])).toEqual([
      ['local', true],
      ['nuvem', true],
    ]);
    const ids = outcomes.map((o) => (o.ok ? o.connected.status.daemonId : undefined));
    expect(ids).toEqual([local.daemonId, remote.daemonId]);

    // The saved list holds the remote one only (the local one is discovered), tokens included.
    const saved = JSON.parse(await readFile(join(configDir, 'client.json'), 'utf8')) as {
      daemons: { name: string }[];
    };
    expect(saved.daemons.map((d) => d.name)).toEqual(['nuvem']);

    // A second directory over the same files sees the same two daemons.
    const again = createNodeDaemonDirectory({ configDir, dataDir });
    expect((await again.list()).map((e) => e.name)).toEqual(['local', 'nuvem']);
  });

  it('the local daemon is absent when its pid is gone, and shows up again when it is back', async () => {
    const root = await tempDir();
    const local = await startTestDaemon();
    open.push(local);
    await writeDaemonFiles(root, local, 4_000_000);
    const stale = createNodeDaemonDirectory({ configDir: join(root, 'c'), dataDir: root });
    // pid 4000000 is above the Linux pid_max default; on other systems the check may say alive.
    const list = await stale.list();
    if (!isPidAlive(4_000_000)) expect(list).toEqual([]);
    await writeDaemonFiles(root, local);
    expect((await stale.list()).map((e) => e.name)).toEqual(['local']);
    expect((await stale.connect('local')).status.daemonId).toBe(local.daemonId);
  });
});

describe('writePrivateFileAtomic: orphan temporaries of a killed writer (N306)', () => {
  const hex = '0123456789abcdef'.slice(0, 8);
  const gone = (): number => spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid;

  it('names the temporary with the pid and leaves nothing behind', async () => {
    const dir = await tempDir();
    const path = join(dir, 'client.json');
    await writePrivateFileAtomic(path, 'one');
    expect(await readdir(dir)).toEqual(['client.json']);
    expect(await readFile(path, 'utf8')).toBe('one');
  });

  it('removes the temporary of a dead pid, keeps the one of a live pid and the ones outside the pattern', async () => {
    const dir = await tempDir();
    const path = join(dir, 'client.json');
    const orphan = `client.json.${String(gone())}.${hex}.tmp`;
    const live = `client.json.${String(process.ppid)}.${hex}.tmp`;
    const outside = [
      `client.json.${String(gone())}.tmp`,
      `other.json.${String(gone())}.${hex}.tmp`,
    ];
    for (const name of [orphan, live, ...outside]) await writeFile(join(dir, name), 'x');
    await writePrivateFileAtomic(path, 'two');
    expect((await readdir(dir)).sort()).toEqual([live, ...outside, 'client.json'].sort());
  });

  it('in age mode removes the old one and keeps the new one', async () => {
    const dir = await tempDir();
    const path = join(dir, 'client.json');
    const old = `client.json.${String(process.ppid)}.${hex}.tmp`;
    const fresh = `client.json.${String(gone())}.${hex}.tmp`;
    await writeFile(join(dir, old), 'old');
    await writeFile(join(dir, fresh), 'new');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(join(dir, old), twoHoursAgo, twoHoursAgo);
    await writePrivateFileAtomic(path, 'three', {
      sweep: { policy: { mode: 'age', maxAgeMs: 60 * 60_000 } },
    });
    expect((await readdir(dir)).sort()).toEqual([fresh, 'client.json'].sort());
  });

  it('a temporary it cannot remove is told to onError and the write still succeeds', async () => {
    const dir = await tempDir();
    const path = join(dir, 'client.json');
    const stuck = `client.json.${String(gone())}.${hex}.tmp`;
    await mkdir(join(dir, stuck));
    const names: string[] = [];
    await writePrivateFileAtomic(path, 'four', {
      sweep: { onError: (_error, name) => names.push(name) },
    });
    expect(names).toEqual([stuck]);
    expect(await readFile(path, 'utf8')).toBe('four');
  });
});
