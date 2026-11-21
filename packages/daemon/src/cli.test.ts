// SPDX-License-Identifier: MPL-2.0
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '@otheater/core';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from './cli.js';
import { InstanceLock } from './instance-lock.js';
import { dataPaths } from './paths.js';
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
    ['api without an action', ['api'], /"ot api" needs an action/],
    ['api with an unknown action', ['api', 'burn'], /Unknown action "burn" for "ot api"/],
    [
      'api rotate-token with an argument',
      ['api', 'rotate-token', 'x'],
      /Too many arguments for "ot api"/,
    ],
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

describe('ot tui and ot with no command (Phase 7, P8)', () => {
  /** A launcher that records what it was given and returns `code`. */
  function recorder(code = 0): {
    runs: Parameters<NonNullable<CliDeps['launchTui']>>[0][];
    launch: NonNullable<CliDeps['launchTui']>;
  } {
    const runs: Parameters<NonNullable<CliDeps['launchTui']>>[0][] = [];
    return {
      runs,
      launch: (run) => {
        runs.push(run);
        return Promise.resolve(code);
      },
    };
  }

  it('ot tui hands the data folder and the ui section to the launcher and returns its code', async () => {
    const tmp = await makeTempDataDir();
    try {
      await writeFile(join(tmp.dir, 'config.yaml'), 'ui:\n  locale: pt-BR\n');
      const tui = recorder(7);
      const result = await ot(['tui', '--data-dir', tmp.dir], tmp.dir, {
        interactive: true,
        launchTui: tui.launch,
      });
      expect(result).toMatchObject({ code: 7, out: [], err: [] });
      expect(tui.runs).toHaveLength(1);
      expect(tui.runs[0]?.dataDir).toBe(tmp.dir);
      expect(tui.runs[0]?.ui).toMatchObject({ locale: 'pt-BR', bare_command: 'tui' });
    } finally {
      await tmp.dispose();
    }
  });

  it('ot tui without a terminal is a usage error and does not start the interface', async () => {
    const tmp = await makeTempDataDir();
    try {
      const tui = recorder();
      const result = await ot(['tui', '--data-dir', tmp.dir], tmp.dir, {
        interactive: false,
        launchTui: tui.launch,
      });
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toMatch(/needs a terminal/);
      expect(tui.runs).toEqual([]);
    } finally {
      await tmp.dispose();
    }
  });

  it('ot tui with an argument is a usage error', async () => {
    const tmp = await makeTempDataDir();
    try {
      const result = await ot(['tui', 'x', '--data-dir', tmp.dir], tmp.dir, { interactive: true });
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toMatch(/Too many arguments for "ot tui"/);
    } finally {
      await tmp.dispose();
    }
  });

  it('a bare ot opens the interface in a terminal (ui.bare_command: tui is the default)', async () => {
    const tmp = await makeTempDataDir();
    try {
      const tui = recorder();
      const result = await ot(['--data-dir', tmp.dir], tmp.dir, {
        interactive: true,
        launchTui: tui.launch,
      });
      expect(result).toMatchObject({ code: 0, out: [], err: [] });
      expect(tui.runs).toHaveLength(1);
    } finally {
      await tmp.dispose();
    }
  });

  it('a bare ot shows the usage as before without a terminal, or with ui.bare_command: help', async () => {
    const tmp = await makeTempDataDir();
    try {
      const tui = recorder();
      const pipe = await ot(['--data-dir', tmp.dir], tmp.dir, {
        interactive: false,
        launchTui: tui.launch,
      });
      expect(pipe.code).toBe(2);
      expect(pipe.err.join('\n')).toMatch(/No command given/);

      await writeFile(join(tmp.dir, 'config.yaml'), 'ui:\n  bare_command: help\n');
      const help = await ot(['--data-dir', tmp.dir], tmp.dir, {
        interactive: true,
        launchTui: tui.launch,
      });
      expect(help.code).toBe(2);
      expect(help.err.join('\n')).toMatch(/No command given/);
      expect(tui.runs).toEqual([]);
    } finally {
      await tmp.dispose();
    }
  });

  it('a broken config.yaml keeps the bare ot on the usage; ot tui still opens with the defaults', async () => {
    const tmp = await makeTempDataDir();
    try {
      await writeFile(join(tmp.dir, 'config.yaml'), 'ui: [not, a, map\n');
      const tui = recorder();
      const bare = await ot(['--data-dir', tmp.dir], tmp.dir, {
        interactive: true,
        launchTui: tui.launch,
      });
      expect(bare.code).toBe(2);
      const explicit = await ot(['tui', '--data-dir', tmp.dir], tmp.dir, {
        interactive: true,
        launchTui: tui.launch,
      });
      expect(explicit.code).toBe(0);
      expect(tui.runs).toHaveLength(1);
    } finally {
      await tmp.dispose();
    }
  });

  it('says how to build the interface when it is not built', async () => {
    const tmp = await makeTempDataDir();
    try {
      const notBuilt = Object.assign(new Error('missing'), {
        name: 'TuiNotBuiltError',
        file: '/x/main.js',
      });
      const result = await ot(['tui', '--data-dir', tmp.dir], tmp.dir, {
        interactive: true,
        launchTui: () => Promise.reject(notBuilt),
      });
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toMatch(/pnpm build.*\/x\/main\.js/);
    } finally {
      await tmp.dispose();
    }
  });

  it('lists ot tui in the help, in both languages', async () => {
    const tmp = await makeTempDataDir();
    try {
      const en = await ot(['--help', '--data-dir', tmp.dir], tmp.dir);
      expect(en.out.join('\n')).toMatch(/^ {2}tui {10,}Open the terminal interface/m);
      const pt = await ot(['--help', '--data-dir', tmp.dir], tmp.dir, { systemLocale: 'pt_BR' });
      expect(pt.out.join('\n')).toMatch(/^ {2}tui {10,}Abre a interface de terminal/m);
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

  it('frees the lock when the composition fails, so the next command can run (Windows: EBUSY)', async () => {
    const tmp = await makeTempDataDir();
    try {
      // A store that breaks as soon as the composition touches it.
      const broken = new Proxy({} as Store, {
        get: () => {
          throw new Error('store down');
        },
      });
      for (const args of [
        ['backup'],
        ['executor', 'list'],
        ['profile', 'list'],
        ['directives', 'list'],
      ]) {
        const result = await ot([...args, '--data-dir', tmp.dir], tmp.dir, {
          overrides: { store: broken, vault: new InMemorySecretVault() },
        });
        expect(result.code, args.join(' ')).toBe(1);
        const paths = dataPaths(tmp.dir);
        const again = await InstanceLock.acquire(paths.lock, paths.lockInfo);
        await again.release();
      }
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

describe('ot directives', () => {
  const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
  const run = (argv: readonly string[], dir: string, extra: Partial<CliDeps> = {}) =>
    ot([...argv, '--data-dir', dir], dir, {
      overrides: { clock: new FakeClock(NOW), vault: new InMemorySecretVault() },
      ...extra,
    });

  it('adds, lists, shows, extends and revokes orders, and they stay in the store', async () => {
    const tmp = await makeTempDataDir();
    try {
      const empty = await run(['directives', 'list'], tmp.dir);
      expect(empty).toMatchObject({ code: 0, out: ['No orders.'] });

      const added = await run(
        ['directives', 'add', 'Always run the linter.', '--for', '2d'],
        tmp.dir,
      );
      expect(added.err).toEqual([]);
      expect(added.out).toEqual(['Order O1 created (active).']);
      const local = await run(
        ['directives', 'add', 'Use pnpm.', '--scenario', 's1', '--role', 'actor'],
        tmp.dir,
      );
      expect(local.out).toEqual(['Order O2 created (active).']);

      const listed = await run(['directives', 'list'], tmp.dir);
      expect(listed.out).toEqual([
        'O1 [active] global instruction until 2026-11-19 09:00 America/Sao_Paulo: Always run the linter.',
        'O2 [active] scenario s1 instruction: Use pnpm.',
      ]);
      const other = await run(['directives', 'list', '--scenario', 's2'], tmp.dir);
      expect(other.out).toHaveLength(1);

      const shown = await run(['directives', 'show', 'O2'], tmp.dir);
      expect(JSON.parse(shown.out.join('\n'))).toMatchObject({
        id: 'O2',
        scope: 'local',
        scenarioId: 's1',
        roles: ['actor'],
      });

      const extended = await run(['directives', 'extend', 'O1', '--forever'], tmp.dir);
      expect(extended.out).toEqual(['Order O1 extended (active).']);
      const revoked = await run(['directives', 'revoke', 'O2', '--reason', 'Not needed.'], tmp.dir);
      expect(revoked.out).toEqual(['Order O2 revoked.']);

      const after = await run(['directives', 'list'], tmp.dir);
      expect(after.out).toEqual(['O1 [active] global instruction: Always run the linter.']);
      const all = await run(['directives', 'list', '--all'], tmp.dir);
      expect(all.out).toHaveLength(2);
      expect(all.out[1]).toContain('[revoked]');
    } finally {
      await tmp.dispose();
    }
  });

  it('adds a rule with a typed value, a suspension, and refuses a clashing rule', async () => {
    const tmp = await makeTempDataDir();
    try {
      const rule = await run(
        [
          'directives',
          'add',
          'Deliver by PR.',
          '--kind',
          'rule',
          '--rule-key',
          'delivery.mode',
          '--rule-value',
          'pr',
        ],
        tmp.dir,
      );
      expect(rule.out).toEqual(['Order O1 created (active).']);
      const clash = await run(
        [
          'directives',
          'add',
          'Ask first.',
          '--kind',
          'rule',
          '--rule-key',
          'delivery.mode',
          '--rule-value',
          'ask',
        ],
        tmp.dir,
      );
      expect(clash.code).toBe(1);
      expect(clash.err[0]).toMatch(/^Error: /);

      const suspended = await run(
        ['directives', 'suspend', 'O1', '--scenario', 'docs', 'Docs ship on their own.'],
        tmp.dir,
      );
      expect(suspended.err).toEqual([]);
      expect(suspended.out).toEqual(['Order O2 created (active).']);
      const shown = await run(['directives', 'show', 'O2'], tmp.dir);
      expect(JSON.parse(shown.out.join('\n'))).toMatchObject({
        kind: 'suspension',
        suspendsId: 'O1',
        scenarioId: 'docs',
      });
    } finally {
      await tmp.dispose();
    }
  });

  it('reports a bad date or an unknown order as an error with exit 1', async () => {
    const tmp = await makeTempDataDir();
    try {
      const bad = await run(['directives', 'add', 'x', '--until', 'someday'], tmp.dir);
      expect(bad.code).toBe(1);
      expect(bad.err[0]).toMatch(/^Error: .*"someday" is not a date/);
      const missing = await run(['directives', 'show', 'O9'], tmp.dir);
      expect(missing).toMatchObject({ code: 1, err: ['Order O9 not found.'] });
    } finally {
      await tmp.dispose();
    }
  });

  it.each([
    ['no action', ['directives'], /needs an action/],
    ['an unknown action', ['directives', 'burn'], /Unknown action "burn"/],
    ['show without an id', ['directives', 'show'], /needs the order id/],
    ['add without a text', ['directives', 'add'], /needs the text/],
    ['revoke without a reason', ['directives', 'revoke', 'O1'], /needs --reason/],
    ['suspend without a scenario', ['directives', 'suspend', 'O1'], /needs --scenario/],
    ['an unknown kind', ['directives', 'add', 'x', '--kind', 'law'], /--kind must be/],
    ['list with an argument', ['directives', 'list', 'x'], /Too many arguments/],
  ])('exits 2 with a hint for %s', async (_name, argv, message) => {
    const tmp = await makeTempDataDir();
    try {
      const result = await run(argv, tmp.dir);
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toMatch(message);
      expect(result.err.at(-1)).toBe('Run "ot --help" for usage.');
    } finally {
      await tmp.dispose();
    }
  });

  it('refuses while a daemon holds the data directory, and speaks pt-BR when asked', async () => {
    const tmp = await makeTempDataDir();
    try {
      const paths = dataPaths(tmp.dir);
      const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
      try {
        const refused = await run(['directives', 'list'], tmp.dir, { systemLocale: 'pt-BR' });
        expect(refused.code).toBe(1);
        expect(refused.err[0]).toMatch(/O daemon está em execução/);
      } finally {
        await lock.release();
      }
      const empty = await run(['directives', 'list'], tmp.dir, { systemLocale: 'pt-BR' });
      expect(empty.out).toEqual(['Nenhuma ordem.']);
    } finally {
      await tmp.dispose();
    }
  });
});

describe('ot api rotate-token (Phase 6, P3)', () => {
  it('with no daemon, writes a new token (mode 0600) into api-token and says so', async () => {
    const tmp = await makeTempDataDir();
    try {
      const path = dataPaths(tmp.dir).apiToken;
      const first = await ot(['api', 'rotate-token', '--data-dir', tmp.dir], tmp.dir);
      expect(first).toMatchObject({ code: 0, err: [] });
      expect(first.out.join('\n')).toMatch(/daemon is stopped/);
      const one = await readFile(path, 'utf8');
      expect(one.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.out.join('\n')).not.toContain(one.trim());
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
      await ot(['api', 'rotate-token', '--data-dir', tmp.dir], tmp.dir);
      expect(await readFile(path, 'utf8')).not.toBe(one);
    } finally {
      await tmp.dispose();
    }
  });

  it('with a daemon running but no live api.json, fails with a clear message, in pt-BR when asked', async () => {
    const tmp = await makeTempDataDir();
    try {
      const paths = dataPaths(tmp.dir);
      const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
      try {
        const refused = await ot(['api', 'rotate-token', '--data-dir', tmp.dir], tmp.dir, {
          systemLocale: 'pt-BR',
        });
        expect(refused.code).toBe(1);
        expect(refused.err[0]).toMatch(/api\.json está velho/);
        expect(refused.out).toEqual([]);
      } finally {
        await lock.release();
      }
    } finally {
      await tmp.dispose();
    }
  });
});
