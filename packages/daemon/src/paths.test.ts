// SPDX-License-Identifier: MPL-2.0
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataPaths, defaultDataDir, ensureDataDir, profileDirOf, resolveDataDir } from './paths.js';
import { makeTempDataDir } from './test-helpers.js';

describe('defaultDataDir (injected environment, no real HOME)', () => {
  it('uses XDG_DATA_HOME on Linux when it is absolute', () => {
    expect(defaultDataDir('linux', { XDG_DATA_HOME: '/srv/xdg' }, '/home/u')).toBe(
      '/srv/xdg/otheater',
    );
  });

  it('falls back to ~/.local/share when XDG_DATA_HOME is unset, empty or relative', () => {
    for (const env of [{}, { XDG_DATA_HOME: '' }, { XDG_DATA_HOME: 'relative/dir' }]) {
      expect(defaultDataDir('linux', env, '/home/u')).toBe('/home/u/.local/share/otheater');
    }
  });

  it('uses Application Support on macOS and ignores XDG_DATA_HOME there', () => {
    expect(defaultDataDir('darwin', { XDG_DATA_HOME: '/srv/xdg' }, '/Users/u')).toBe(
      '/Users/u/Library/Application Support/OTheater',
    );
  });

  it('uses LOCALAPPDATA on Windows, or AppData\\Local under the home directory', () => {
    expect(
      defaultDataDir('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'C:\\Users\\u'),
    ).toBe('C:\\Users\\u\\AppData\\Local\\OTheater');
    expect(defaultDataDir('win32', {}, 'C:\\Users\\u')).toBe(
      'C:\\Users\\u\\AppData\\Local\\OTheater',
    );
  });
});

describe('resolveDataDir', () => {
  const base = { platform: 'linux', homedir: '/home/u' } as const;

  it('prefers the flag, then OT_DATA_DIR, then the default', () => {
    // Explicit values go through the native resolve(), so '/a' is 'D:\\a' on Windows. The default
    // is built by the injected platform's own path rules and is not resolved.
    expect(resolveDataDir({ ...base, flag: '/a', env: { OT_DATA_DIR: '/b' } })).toBe(resolve('/a'));
    expect(resolveDataDir({ ...base, env: { OT_DATA_DIR: '/b' } })).toBe(resolve('/b'));
    expect(resolveDataDir({ ...base, flag: '', env: { OT_DATA_DIR: '' } })).toBe(
      '/home/u/.local/share/otheater',
    );
  });

  it('makes a relative path absolute', () => {
    expect(resolveDataDir({ ...base, flag: 'rel/dir', env: {} })).toBe(resolve('rel/dir'));
  });
});

describe('dataPaths', () => {
  it('puts every piece inside the data directory', () => {
    const root = resolve('/data/ot');
    const paths = dataPaths('/data/ot');
    expect(paths).toEqual({
      dataDir: root,
      config: join(root, 'config.yaml'),
      store: join(root, 'store.sqlite'),
      lock: join(root, 'daemon.lock'),
      lockInfo: join(root, 'daemon.lock.json'),
      backups: join(root, 'backups'),
      bin: join(root, 'bin'),
      logs: join(root, 'logs'),
      logFile: join(root, 'logs', 'daemon.log'),
      scenarios: join(root, 'scenarios'),
      worktrees: join(root, 'worktrees'),
      profiles: join(root, 'profiles'),
      scratch: join(root, 'scratch'),
      channel: join(root, 'channel.json'),
      apiDiscovery: join(root, 'api.json'),
      apiToken: join(root, 'api-token'),
      daemonId: join(root, 'daemon-id'),
      layout: join(root, 'layout'),
    });
  });
});

describe('profileDirOf', () => {
  const paths = dataPaths('/data/ot');

  it('puts a profile under <data>/profiles/<client>/<profile>', () => {
    expect(profileDirOf(paths, { client: 'opencode', profile: 'work.1' })).toBe(
      join(resolve('/data/ot'), 'profiles', 'opencode', 'work.1'),
    );
  });

  it('refuses names that would leave the profiles directory', () => {
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a b']) {
      expect(() => profileDirOf(paths, { client: 'codex', profile: bad })).toThrow(/profile/);
      expect(() => profileDirOf(paths, { client: bad, profile: 'p' })).toThrow(/client/);
    }
  });
});

describe('ensureDataDir', () => {
  it.skipIf(process.platform === 'win32')(
    'creates a new directory with mode 0700 and leaves an existing one alone',
    async () => {
      const tmp = await makeTempDataDir();
      try {
        const fresh = join(tmp.dir, 'a', 'b');
        await ensureDataDir(fresh);
        expect((await stat(fresh)).mode & 0o777).toBe(0o700);

        const existing = join(tmp.dir, 'c');
        await mkdir(existing, { mode: 0o755 });
        await ensureDataDir(existing);
        expect((await stat(existing)).mode & 0o777).toBe(0o755);
      } finally {
        await tmp.dispose();
      }
    },
  );
});
