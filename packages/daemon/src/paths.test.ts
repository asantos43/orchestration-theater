// SPDX-License-Identifier: MPL-2.0
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataPaths, defaultDataDir, ensureDataDir, resolveDataDir } from './paths.js';
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
    expect(resolveDataDir({ ...base, flag: '/a', env: { OT_DATA_DIR: '/b' } })).toBe('/a');
    expect(resolveDataDir({ ...base, env: { OT_DATA_DIR: '/b' } })).toBe('/b');
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
    const paths = dataPaths('/data/ot');
    expect(paths).toEqual({
      dataDir: '/data/ot',
      config: '/data/ot/config.yaml',
      store: '/data/ot/store.sqlite',
      lock: '/data/ot/daemon.lock',
      lockInfo: '/data/ot/daemon.lock.json',
      backups: '/data/ot/backups',
      logs: '/data/ot/logs',
      logFile: '/data/ot/logs/daemon.log',
      scenarios: '/data/ot/scenarios',
    });
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
