// SPDX-License-Identifier: MPL-2.0
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../cli.js';
import { dataPaths, ensureDataDir } from '../paths.js';
import { InstanceLock } from '../instance-lock.js';
import { makeTempDataDir } from '../test-helpers.js';
import { isolatedEnv, writePluginFolder } from './plugin-fixture.js';

// The 'changed' variant of the fixture declares the secret PG_URL.
const NAME = 'PG_URL';
const VALUE = 'postgres://user:pa55-w0rd-0123@db.local/app';

interface Captured {
  readonly out: string[];
  readonly err: string[];
  readonly code: number;
}

async function ot(
  argv: readonly string[],
  data: string,
  work: string,
  extra: Partial<CliDeps> = {},
  locale = 'en',
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, '--data-dir', data], {
    env: isolatedEnv(work),
    platform: 'linux',
    homedir: work,
    cwd: work,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    systemLocale: locale,
    version: '1.2.3',
    overrides: { clock: new FakeClock(Date.UTC(2026, 10, 21, 15)) },
    ...extra,
  });
  return { out, err, code };
}

async function scene<T>(
  body: (paths: { data: string; work: string; vault: InMemorySecretVault }) => Promise<T>,
): Promise<T> {
  const data = await makeTempDataDir();
  const work = await makeTempDataDir();
  try {
    const vault = new InMemorySecretVault();
    const folder = await writePluginFolder(join(work.dir, 'demo-db'), { variant: 'changed' });
    const installed = await ot(['plugin', 'install', folder], data.dir, work.dir);
    expect(installed.code).toBe(0);
    return await body({ data: data.dir, work: work.dir, vault });
  } finally {
    await data.dispose();
    await work.dispose();
  }
}

/** The deps of `secret set`: the vault of the test and the value on the standard input. */
function withValue(vault: InMemorySecretVault, value: string): Partial<CliDeps> {
  return {
    input: Readable.from([value]),
    overrides: { clock: new FakeClock(Date.UTC(2026, 10, 21, 15)), vault },
  };
}

describe('ot plugin secret set', () => {
  it('stores the value from the standard input, for every project, and never prints it', async () => {
    await scene(async ({ data, work, vault }) => {
      const run = await ot(
        ['plugin', 'secret', 'set', 'demo-db', NAME],
        data,
        work,
        withValue(vault, `${VALUE}\n`),
      );
      expect(run.code).toBe(0);
      expect((await vault.get(`plugin/demo-db/${NAME}`))?.reveal()).toBe(VALUE);
      const printed = [...run.out, ...run.err].join('\n');
      expect(printed).toContain(NAME);
      expect(printed).not.toContain(VALUE);
      expect(printed).not.toContain('pa55');
    });
  });

  it('with --project, stores the value of that project only', async () => {
    await scene(async ({ data, work, vault }) => {
      const run = await ot(
        ['plugin', 'secret', 'set', 'demo-db', NAME, '--project', 'p1'],
        data,
        work,
        withValue(vault, `${VALUE}\r\n`),
      );
      expect(run.code).toBe(0);
      expect(run.out.join('\n')).toContain('p1');
      // A carriage return of the line ending is not part of the value.
      expect((await vault.get(`plugin/demo-db/p1/${NAME}`))?.reveal()).toBe(VALUE);
      expect(await vault.get(`plugin/demo-db/${NAME}`)).toBeUndefined();
      expect([...run.out, ...run.err].join('\n')).not.toContain(VALUE);
    });
  });

  it('keeps spaces inside the value, and prints JSON without the value', async () => {
    await scene(async ({ data, work, vault }) => {
      const run = await ot(
        ['plugin', 'secret', 'set', 'demo-db', NAME, '--json'],
        data,
        work,
        withValue(vault, ' a b \n'),
      );
      expect(run.code).toBe(0);
      expect((await vault.get(`plugin/demo-db/${NAME}`))?.reveal()).toBe(' a b ');
      expect(JSON.parse(run.out.join('\n'))).toEqual({
        id: 'demo-db',
        name: NAME,
        project: null,
        stored: true,
      });
    });
  });

  it('reads the value from the hidden prompt of a terminal', async () => {
    await scene(async ({ data, work, vault }) => {
      const asked: string[] = [];
      const run = await ot(['plugin', 'secret', 'set', 'demo-db', NAME], data, work, {
        askHidden: (question) => {
          asked.push(question);
          return Promise.resolve(VALUE);
        },
        overrides: { clock: new FakeClock(Date.UTC(2026, 10, 21, 15)), vault },
      });
      expect(run.code).toBe(0);
      expect(asked).toHaveLength(1);
      expect((await vault.get(`plugin/demo-db/${NAME}`))?.reveal()).toBe(VALUE);
    });
  });

  it('refuses an empty value and stores nothing', async () => {
    await scene(async ({ data, work, vault }) => {
      const run = await ot(
        ['plugin', 'secret', 'set', 'demo-db', NAME],
        data,
        work,
        withValue(vault, '\n'),
      );
      expect(run.code).toBe(1);
      expect(await vault.list()).toEqual([]);
    });
  });

  it('with no input at all it says to pipe the value in', async () => {
    await scene(async ({ data, work, vault }) => {
      const run = await ot(['plugin', 'secret', 'set', 'demo-db', NAME], data, work, {
        overrides: { clock: new FakeClock(Date.UTC(2026, 10, 21, 15)), vault },
      });
      expect(run.code).toBe(1);
      expect(run.err.join('\n')).toMatch(/standard input/);
      expect(await vault.list()).toEqual([]);
    });
  });

  it('refuses a name the plugin does not declare, and a plugin that is not installed', async () => {
    await scene(async ({ data, work, vault }) => {
      const typo = await ot(
        ['plugin', 'secret', 'set', 'demo-db', 'PG_URI'],
        data,
        work,
        withValue(vault, `${VALUE}\n`),
      );
      expect(typo.code).toBe(1);
      expect(typo.err.join('\n')).toContain(NAME);
      const missing = await ot(
        ['plugin', 'secret', 'set', 'nope', NAME],
        data,
        work,
        withValue(vault, `${VALUE}\n`),
      );
      expect(missing.code).toBe(1);
      expect(missing.err.join('\n')).toContain('nope');
      expect(await vault.list()).toEqual([]);
      expect([...typo.err, ...missing.err].join('\n')).not.toContain(VALUE);
    });
  });

  it('is a usage error when the arguments are wrong', async () => {
    await scene(async ({ data, work, vault }) => {
      for (const argv of [
        ['plugin', 'secret'],
        ['plugin', 'secret', 'get', 'demo-db', NAME],
        ['plugin', 'secret', 'set', 'demo-db'],
        ['plugin', 'secret', 'set', 'demo-db', NAME, 'extra'],
        ['plugin', 'secret', 'set', 'demo-db', 'lowercase'],
        ['plugin', 'secret', 'set', 'demo-db', NAME, '--project', ''],
      ]) {
        const run = await ot(argv, data, work, withValue(vault, `${VALUE}\n`));
        expect(run.code, argv.join(' ')).toBe(2);
        expect(run.err.join('\n')).not.toContain(VALUE);
      }
      expect(await vault.list()).toEqual([]);
    });
  });

  it('with the encrypted-file vault it refuses while the daemon runs', async () => {
    await scene(async ({ data, work }) => {
      const paths = dataPaths(data);
      await ensureDataDir(paths.dataDir);
      // The encrypted file is the vault that needs the lock; the default (keyring) would not.
      // The command stops at the lock, before any vault is composed: the real keyring is never read.
      await writeFile(paths.config, 'adapters:\n  vault: encrypted-file\n');
      const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
      try {
        const run = await ot(['plugin', 'secret', 'set', 'demo-db', NAME], data, work, {
          input: Readable.from([`${VALUE}\n`]),
        });
        expect(run.code).toBe(1);
        expect(run.err.join('\n')).toMatch(/daemon is running/);
        expect([...run.out, ...run.err].join('\n')).not.toContain(VALUE);
      } finally {
        await lock.release();
      }
    });
  });

  it('speaks pt-BR when the system does', async () => {
    await scene(async ({ data, work, vault }) => {
      const run = await ot(
        ['plugin', 'secret', 'set', 'demo-db', NAME],
        data,
        work,
        withValue(vault, `${VALUE}\n`),
        'pt_BR.UTF-8',
      );
      expect(run.code).toBe(0);
      expect(run.out.join('\n')).toMatch(/segredo/i);
      expect(run.out.join('\n')).not.toContain(VALUE);
    });
  });
});
