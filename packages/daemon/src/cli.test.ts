// SPDX-License-Identifier: MPL-2.0
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from './cli.js';
import { makeTempDataDir } from './test-helpers.js';

interface Captured {
  readonly out: string[];
  readonly err: string[];
}

/** Runs `ot` with a temp HOME and no real environment; `dir` is also the data directory. */
async function ot(
  argv: readonly string[],
  home: string,
  extra: Partial<CliDeps> = {},
): Promise<Captured & { code: number }> {
  const captured: Captured = { out: [], err: [] };
  const code = await main(argv, {
    env: {},
    platform: 'linux',
    homedir: home,
    out: (line) => captured.out.push(line),
    err: (line) => captured.err.push(line),
    systemLocale: 'en',
    version: '1.2.3',
    ...extra,
  });
  return { ...captured, code };
}

const quietOverrides = (): NonNullable<CliDeps['overrides']> => {
  const clock = new FakeClock(Date.UTC(2026, 10, 16, 15, 0, 0));
  return { clock, store: new InMemoryStore({ clock }), vault: new InMemorySecretVault() };
};

describe('ot: usage and information', () => {
  it('prints the help in English and exits 0', async () => {
    const tmp = await makeTempDataDir();
    try {
      for (const flag of ['--help', '-h']) {
        const result = await ot([flag, '--data-dir', tmp.dir], tmp.dir);
        expect(result.code).toBe(0);
        expect(result.out.join('\n')).toMatch(/^Usage: ot .*\n[\s\S]*restore <folder>/);
        expect(result.err).toEqual([]);
      }
    } finally {
      await tmp.dispose();
    }
  });

  it('prints the version', async () => {
    const tmp = await makeTempDataDir();
    try {
      const result = await ot(['--version', '--data-dir', tmp.dir], tmp.dir);
      expect(result).toMatchObject({ code: 0, out: ['1.2.3'] });
    } finally {
      await tmp.dispose();
    }
  });

  it('speaks pt-BR when the system says so, and ui.locale in config.yaml wins over it', async () => {
    const tmp = await makeTempDataDir();
    try {
      const flags = ['--help', '--data-dir', tmp.dir];
      const system = await ot(flags, tmp.dir, { systemLocale: 'pt_BR.UTF-8' });
      expect(system.out.join('\n')).toMatch(/^Uso: ot /);

      await writeFile(join(tmp.dir, 'config.yaml'), 'ui:\n  locale: en\n');
      const forced = await ot(flags, tmp.dir, { systemLocale: 'pt_BR.UTF-8' });
      expect(forced.out.join('\n')).toMatch(/^Usage: ot /);

      await writeFile(join(tmp.dir, 'config.yaml'), 'ui:\n  locale: pt-BR\n');
      const pt = await ot(flags, tmp.dir, { systemLocale: 'en' });
      expect(pt.out.join('\n')).toMatch(/^Uso: ot /);
    } finally {
      await tmp.dispose();
    }
  });

  it('still prints the help when config.yaml is broken', async () => {
    const tmp = await makeTempDataDir();
    try {
      await writeFile(join(tmp.dir, 'config.yaml'), 'ui: [not, a, map\n');
      const result = await ot(['--help', '--data-dir', tmp.dir], tmp.dir);
      expect(result.code).toBe(0);
    } finally {
      await tmp.dispose();
    }
  });

  it.each([
    ['no command', [], /No command given/],
    ['an unknown command', ['frobnicate'], /Unknown command "frobnicate"/],
    ['restore without a folder', ['restore'], /needs the backup folder/],
    ['restore with two folders', ['restore', 'a', 'b'], /Too many arguments for "ot restore"/],
    ['backup with an argument', ['backup', 'x'], /Too many arguments for "ot backup"/],
    ['daemon with an argument', ['daemon', 'x'], /Too many arguments for "ot daemon"/],
    ['an unknown option', ['--bogus'], /Invalid option/],
    ['--data-dir without a value', ['backup', '--data-dir'], /Invalid option/],
  ])('exits 2 with a hint for %s', async (_name, argv, message) => {
    const tmp = await makeTempDataDir();
    try {
      const result = await ot(
        argv.includes('--data-dir') ? argv : [...argv, '--data-dir', tmp.dir],
        tmp.dir,
      );
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toMatch(message);
      expect(result.err.at(-1)).toBe('Run "ot --help" for usage.');
      expect(result.out).toEqual([]);
    } finally {
      await tmp.dispose();
    }
  });
});

describe('ot backup and restore', () => {
  it('backs up with the real SQLite store and reports the folder', async () => {
    const tmp = await makeTempDataDir();
    try {
      const result = await ot(['backup', '--data-dir', tmp.dir], tmp.dir, {
        overrides: { vault: new InMemorySecretVault() },
      });
      expect(result.err).toEqual([]);
      expect(result.code).toBe(0);
      expect(result.out[0]).toMatch(
        /^Backup saved in .*otheater-\d{8}-\d{6}Z \(\d+ bytes, method online_api\)\.$/,
      );
      const [name] = await readdir(join(tmp.dir, 'backups'));
      expect(name).toMatch(/^otheater-/);
    } finally {
      await tmp.dispose();
    }
  });

  it('says "Error:" and exits 1 when the command fails', async () => {
    const tmp = await makeTempDataDir();
    try {
      const result = await ot(
        ['restore', join(tmp.dir, 'nothing-here'), '--data-dir', tmp.dir],
        tmp.dir,
      );
      expect(result.code).toBe(1);
      expect(result.err[0]).toMatch(/^Error: /);
    } finally {
      await tmp.dispose();
    }
  });

  it('restores what a backup saved (end to end through the CLI)', async () => {
    const tmp = await makeTempDataDir();
    try {
      const overrides = { vault: new InMemorySecretVault() };
      const made = await ot(['backup', '--data-dir', tmp.dir], tmp.dir, { overrides });
      expect(made.code).toBe(0);
      const [name] = await readdir(join(tmp.dir, 'backups'));
      const restored = await ot(
        ['restore', join(tmp.dir, 'backups', name ?? ''), '--data-dir', tmp.dir],
        tmp.dir,
      );
      expect(restored.err).toEqual([]);
      expect(restored.code).toBe(0);
      expect(restored.out.join('\n')).toMatch(/Restored the database at .*store\.sqlite\./);
      expect(restored.out.join('\n')).toMatch(/previous database was kept as .*before-restore/);
    } finally {
      await tmp.dispose();
    }
  });
});

describe('ot daemon', () => {
  it('runs until the signal, then says it stopped and exits 0', async () => {
    const tmp = await makeTempDataDir();
    try {
      await writeFile(join(tmp.dir, 'config.yaml'), 'backup:\n  when: manual\n');
      const controller = new AbortController();
      const captured: Captured = { out: [], err: [] };
      const code = await main(['daemon', '--data-dir', tmp.dir], {
        env: {},
        platform: 'linux',
        homedir: tmp.dir,
        systemLocale: 'pt-BR',
        out: (line) => {
          captured.out.push(line);
          if (line.includes('pid')) controller.abort();
        },
        err: (line) => captured.err.push(line),
        signal: controller.signal,
        overrides: quietOverrides(),
      });
      expect(code).toBe(0);
      expect(captured.err).toEqual([]);
      expect(captured.out).toHaveLength(3);
      expect(captured.out[0]).toMatch(/^Daemon do OTheater em execução \(pid \d+\)/);
      expect(captured.out[2]).toMatch(/parado/i);
    } finally {
      await tmp.dispose();
    }
  });

  it('exits 1 and names the cause when another daemon holds the data dir', async () => {
    const tmp = await makeTempDataDir();
    try {
      await writeFile(join(tmp.dir, 'config.yaml'), 'backup:\n  when: manual\n');
      const controller = new AbortController();
      const first = main(['daemon', '--data-dir', tmp.dir], {
        env: {},
        platform: 'linux',
        homedir: tmp.dir,
        systemLocale: 'en',
        out: (line) => {
          if (line.includes('pid')) {
            void ot(['daemon', '--data-dir', tmp.dir], tmp.dir, {
              overrides: quietOverrides(),
            }).then((second) => {
              expect(second.code).toBe(1);
              expect(second.err[0]).toMatch(/^Error: /);
              controller.abort();
            });
          }
        },
        err: () => undefined,
        signal: controller.signal,
        overrides: quietOverrides(),
      });
      expect(await first).toBe(0);
    } finally {
      await tmp.dispose();
    }
  });
});
