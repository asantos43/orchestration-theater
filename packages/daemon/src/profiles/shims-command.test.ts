// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../cli.js';
import type { ClientFactory } from '../clients.js';
import { dataPaths } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';
import { RC_BEGIN, type OtLauncher } from './shims.js';

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const LAUNCHER: OtLauncher = { node: '/opt/node/bin/node', entry: '/opt/ot/cli.js' };
const posix = process.platform !== 'win32';

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

interface Rig {
  /** The data directory; the person's home is the same temporary folder. */
  readonly dir: string;
  readonly bin: string;
  run(argv: readonly string[], extra?: Partial<CliDeps>): Promise<Result>;
  events(type: string): Promise<unknown[]>;
  config(lines: readonly string[]): Promise<void>;
}

async function withRig(body: (rig: Rig) => Promise<void>): Promise<void> {
  const tmp = await makeTempDataDir();
  const clock = new FakeClock(NOW);
  const store = new InMemoryStore({ clock });
  // The commands close their composition; the test still reads the events after them.
  Object.assign(store, { close: () => Promise.resolve() });
  const vault = new InMemorySecretVault();
  const launcher = new FakeProcessLauncher();
  const transport = new FakeSessionTransport();
  const clients: ClientFactory = (parts) =>
    ['claude-code', 'codex'].map(
      (id) =>
        new FakeClientAdapter({
          id,
          launcher: parts.launcher,
          baseEnv: { PATH: '/bin' },
          adapterVersion: '1.0.0',
          command: { cmd: 'fake-client', args: ['--acp'] },
          loginState: 'logged_in',
        }),
    );
  const paths = dataPaths(tmp.dir);
  const rig: Rig = {
    dir: tmp.dir,
    bin: paths.bin,
    run: async (argv, extra = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(['--data-dir', tmp.dir, ...argv], {
        env: { PATH: '/usr/bin', HOME: tmp.dir, SHELL: '/bin/zsh' },
        platform: 'linux',
        homedir: tmp.dir,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        systemLocale: 'en',
        version: '1.2.3',
        overrides: { clock, store, vault, launcher, transport },
        clients,
        otLauncher: LAUNCHER,
        ...extra,
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
    events: async (type) =>
      (await store.events.readFrom(0, 1000)).filter((e) => e.type === type).map((e) => e.payload),
    config: async (lines) => {
      await writeFile(paths.config, `${lines.join('\n')}\n`);
    },
  };
  try {
    await body(rig);
  } finally {
    await tmp.dispose();
  }
}

async function add(rig: Rig, client: string, name: string, extra: Partial<CliDeps> = {}) {
  const result = await rig.run(['profile', 'add', client, name, '--accept-notice'], extra);
  expect(result.code, result.err).toBe(0);
  return result;
}

describe('the commands by profile after add and remove (P28b, N159)', () => {
  it('auto: add writes the script of the profile, remove takes it out, and both are events', async () => {
    await withRig(async (rig) => {
      const added = await add(rig, 'codex', 'personal');
      expect(added.out).toContain('Command for the profile: codex-personal');
      expect(added.out).toContain(`not in PATH: ${rig.bin}`);
      const script = await readFile(join(rig.bin, 'codex-personal'), 'utf8');
      expect(script).toContain(
        `exec '/opt/node/bin/node' '/opt/ot/cli.js' --data-dir '${rig.dir}' profile exec 'codex/personal' -- "$@"`,
      );

      const removed = await rig.run(['profile', 'remove', 'codex/personal']);
      expect(removed.code, removed.err).toBe(0);
      expect(await readdir(rig.bin)).toEqual([]);
      expect(await rig.events('profile.shims.synced')).toEqual([
        {
          trigger: 'add',
          written: ['codex-personal'],
          removed: [],
          conflicts: [],
          binOnPath: false,
        },
        {
          trigger: 'remove',
          written: [],
          removed: ['codex-personal'],
          conflicts: [],
          binOnPath: false,
        },
      ]);
    });
  });

  it('--json keeps the output a JSON document', async () => {
    await withRig(async (rig) => {
      const added = await rig.run([
        'profile',
        'add',
        'codex',
        'personal',
        '--accept-notice',
        '--json',
      ]);
      expect(added.code, added.err).toBe(0);
      expect(() => JSON.parse(added.out) as unknown).not.toThrow();
      expect(await readdir(rig.bin)).toEqual(['codex-personal']);
    });
  });

  it('manual and off write nothing on add; without a launcher neither does auto', async () => {
    await withRig(async (rig) => {
      await rig.config(['profiles:', '  shims:', '    mode: manual']);
      await add(rig, 'codex', 'a');
      await rig.config(['profiles:', '  shims:', '    mode: off']);
      await add(rig, 'codex', 'b');
      await rig.config([]);
      await add(rig, 'codex', 'c', { otLauncher: undefined });
      await expect(readdir(rig.bin)).rejects.toThrow();
      expect(await rig.events('profile.shims.synced')).toEqual([]);
    });
  });

  it.runIf(posix)('a name another program has in PATH gets no script, and a warning', async () => {
    await withRig(async (rig) => {
      const other = join(rig.dir, 'other-bin');
      await mkdir(other);
      await writeFile(join(other, 'codex-personal'), '#!/bin/sh\n');
      await chmod(join(other, 'codex-personal'), 0o755);
      const env = { PATH: `/usr/bin:${other}`, HOME: rig.dir };
      const added = await add(rig, 'codex', 'personal', { env });
      expect(added.err).toContain(
        `No command codex-personal: another program already has that name in PATH (${join(other, 'codex-personal')})`,
      );
      expect(await readdir(rig.bin)).toEqual([]);
      expect(await rig.events('profile.warning')).toContainEqual({
        profileId: 'codex/personal',
        kind: 'shim_conflict',
        detail: 'codex-personal',
      });
      // With a prefix, the name is free.
      await rig.config(['profiles:', '  shims:', "    prefix: 'ot-'"]);
      const synced = await rig.run(['profile', 'shims', 'sync'], { env });
      expect(synced.code, synced.err).toBe(0);
      expect(await readdir(rig.bin)).toEqual(['ot-codex-personal']);
    });
  });

  it('a script that cannot be written does not fail the add: it is a warning', async () => {
    await withRig(async (rig) => {
      await writeFile(rig.bin, 'a file where the folder goes');
      const added = await add(rig, 'codex', 'personal');
      expect(added.err).toMatch(/its command could not be written \(E[A-Z]+\)/);
      expect(await rig.events('profile.warning')).toContainEqual(
        expect.objectContaining({ profileId: 'codex/personal', kind: 'shim_failed' }),
      );
    });
  });
});

describe('ot profile shims sync', () => {
  it('writes the missing scripts, keeps the right ones, and prints JSON on --json', async () => {
    await withRig(async (rig) => {
      await rig.config(['profiles:', '  shims:', '    mode: manual']);
      await add(rig, 'codex', 'personal');
      await add(rig, 'claude-code', 'work');
      const first = await rig.run(['profile', 'shims', 'sync']);
      expect(first.code, first.err).toBe(0);
      expect(first.out).toContain(`Commands in ${rig.bin}: 2 written, 0 already right, 0 removed.`);
      const again = await rig.run(['profile', 'shims', 'sync', '--json']);
      expect(JSON.parse(again.out)).toMatchObject({
        binDir: rig.bin,
        written: [],
        removed: [],
        conflicts: [],
        binOnPath: false,
      });
      // A sync with nothing changed is no event.
      expect(await rig.events('profile.shims.synced')).toHaveLength(1);
    });
  });

  it('refuses when the mode is off, or when it cannot tell where ot runs from', async () => {
    await withRig(async (rig) => {
      expect(
        (await rig.run(['profile', 'shims', 'sync'], { otLauncher: undefined })).err,
      ).toContain('Could not tell where ot runs from');
      await rig.config(['profiles:', '  shims:', '    mode: off']);
      const off = await rig.run(['profile', 'shims', 'sync']);
      expect(off.code).toBe(1);
      expect(off.err).toContain('profiles.shims.mode is "off"');
    });
  });

  it('answers wrong usage with code 2', async () => {
    await withRig(async (rig) => {
      for (const argv of [
        ['profile', 'shims'],
        ['profile', 'shims', 'clean'],
        ['profile', 'shims', 'sync', 'extra'],
        ['profile', 'shims', 'sync', '--install'],
        ['profile', 'shims', 'path', '--install', '--uninstall'],
        ['profile', 'shims', 'path', '--shell', 'tcsh'],
      ]) {
        expect((await rig.run(argv)).code, argv.join(' ')).toBe(2);
      }
      const noShell = await rig.run(['profile', 'shims', 'path', '--install', '--yes'], {
        env: { PATH: '/usr/bin', HOME: rig.dir },
      });
      expect(noShell.code).toBe(2);
      expect(noShell.err).toContain('--shell');
    });
  });
});

describe('ot profile shims path (owner: the choice is the person’s)', () => {
  it('with no option, explains both ways and writes nothing', async () => {
    await withRig(async (rig) => {
      const how = await rig.run(['profile', 'shims', 'path']);
      expect(how.code, how.err).toBe(0);
      const rc = join(rig.dir, '.zshrc');
      expect(how.out).toContain(`not in PATH: ${rig.bin}`);
      expect(how.out).toContain('ot profile shims path --install');
      expect(how.out).toContain(`export PATH='${rig.bin}':"$PATH"`);
      expect(how.out).toContain(`. '${rc}'`);
      await expect(readFile(rc, 'utf8')).rejects.toThrow();
      const fish = await rig.run(['profile', 'shims', 'path', '--shell', 'fish']);
      expect(fish.out).toContain(`set -gx PATH '${rig.bin}' $PATH`);
      expect(fish.out).toContain(join(rig.dir, '.config', 'fish', 'config.fish'));
    });
  });

  it('--install asks first; no terminal and no --yes, or a no, write nothing', async () => {
    await withRig(async (rig) => {
      const rc = join(rig.dir, '.zshrc');
      await writeFile(rc, 'setopt x\n');
      const noTerminal = await rig.run(['profile', 'shims', 'path', '--install']);
      expect(noTerminal.code).toBe(1);
      expect(noTerminal.err).toContain('--yes');
      const questions: string[] = [];
      const no = await rig.run(['profile', 'shims', 'path', '--install'], {
        confirm: (question) => {
          questions.push(question);
          return Promise.resolve(false);
        },
      });
      expect(no.code).toBe(1);
      expect(questions[0]).toContain(`export PATH='${rig.bin}':"$PATH"`);
      expect(await readFile(rc, 'utf8')).toBe('setopt x\n');
      expect(await rig.events('profile.shims.rc_changed')).toEqual([]);
    });
  });

  it('after a yes it writes the block, once; --uninstall takes it out; both are events', async () => {
    await withRig(async (rig) => {
      const rc = join(rig.dir, '.zshrc');
      await writeFile(rc, 'setopt x\n');
      const yes = await rig.run(['profile', 'shims', 'path', '--install'], {
        confirm: () => Promise.resolve(true),
      });
      expect(yes.code, yes.err).toBe(0);
      expect(yes.out).toContain(`Added the block to ${rc}.`);
      expect(yes.out).toContain(`. '${rc}'`);
      expect(await readFile(rc, 'utf8')).toContain(RC_BEGIN);
      const again = await rig.run(['profile', 'shims', 'path', '--install', '--yes']);
      expect(again.out).toContain('already has the block');
      const out = await rig.run(['profile', 'shims', 'path', '--uninstall']);
      expect(out.code, out.err).toBe(0);
      expect(await readFile(rc, 'utf8')).toBe('setopt x\n');
      expect(await rig.events('profile.shims.rc_changed')).toEqual([
        { shell: 'zsh', change: 'added' },
        { shell: 'zsh', change: 'removed' },
      ]);
    });
  });

  it('on Windows it only explains: ot does not change PATH there', async () => {
    await withRig(async (rig) => {
      const how = await rig.run(['profile', 'shims', 'path'], { platform: 'win32' });
      expect(how.code, how.err).toBe(0);
      expect(how.out).toContain('Environment Variables');
      const install = await rig.run(['profile', 'shims', 'path', '--install', '--yes'], {
        platform: 'win32',
      });
      expect(install.code).toBe(1);
      expect(install.err).toContain('by hand');
    });
  });
});
