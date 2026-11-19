// SPDX-License-Identifier: MPL-2.0
import { writeFile } from 'node:fs/promises';
import type { ProfileCli } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { isProfileExecArgv, main, type CliDeps } from '../cli.js';
import type { ClientFactory } from '../clients.js';
import { dataPaths } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';
import { execEnv, exitCodeOf, type ChildExit, type ExecSpawn } from './exec.js';

const KEY = 'sk-test-exec-0123456789-NEVER-PRINTED';
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

/** The map of the fake client: its own words for the common ones. */
const CLI_OF = (dir: string): ProfileCli => ({
  cmd: 'fake-cli',
  args: ['--base'],
  env: { FAKE_HOME: dir },
  unsetEnv: ['FAKE_HOME', 'FAKE_TOKEN'],
  commands: { login: ['auth', 'login'], status: ['auth', 'status'], run: ['-p'] },
  options: { model: ['-m'] },
});

interface Spawned {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
  readonly killed: NodeJS.Signals[];
}

interface Rig {
  readonly dir: string;
  readonly store: InMemoryStore;
  readonly vault: InMemorySecretVault;
  readonly spawned: Spawned[];
  /** What the fake CLI does when it ends, and the signal the fake process gets while it runs. */
  exit: ChildExit | Error;
  signalDuringRun: NodeJS.Signals | undefined;
  run(argv: readonly string[], extra?: Partial<CliDeps>): Promise<{ code: number; err: string }>;
  events(type: string): Promise<unknown[]>;
}

async function withRig(body: (rig: Rig) => Promise<void>): Promise<void> {
  const tmp = await makeTempDataDir();
  const clock = new FakeClock(NOW);
  const store = new InMemoryStore({ clock });
  // The command closes its composition; the test still reads the events after it.
  Object.assign(store, { close: () => Promise.resolve() });
  const vault = new InMemorySecretVault();
  const launcher = new FakeProcessLauncher();
  const transport = new FakeSessionTransport();
  const clients: ClientFactory = (parts) =>
    ['claude-code', 'codex', 'bare'].map((id) => {
      const adapter = new FakeClientAdapter({
        id,
        launcher: parts.launcher,
        baseEnv: { PATH: '/bin' },
        adapterVersion: '1.0.0',
        command: { cmd: 'fake-client', args: ['--acp'] },
        loginState: 'logged_in',
      });
      if (id !== 'bare') {
        Object.assign(adapter, {
          profileCli: (profile: { dir: string }) => Promise.resolve(CLI_OF(profile.dir)),
        });
      }
      return adapter;
    });
  const rig: Rig = {
    dir: tmp.dir,
    store,
    vault,
    spawned: [],
    exit: { code: 0, signal: null },
    signalDuringRun: undefined,
    run: async (argv, extra = {}) => {
      const err: string[] = [];
      const spawn: ExecSpawn = (cmd, args, options) => {
        const seen: Spawned = { cmd, args, env: options.env, cwd: options.cwd, killed: [] };
        rig.spawned.push(seen);
        const outcome = rig.exit;
        return {
          exited:
            outcome instanceof Error
              ? Promise.reject(outcome)
              : new Promise<ChildExit>((resolve) => {
                  setImmediate(() => {
                    resolve(outcome);
                  });
                }),
          kill: (signal) => seen.killed.push(signal),
        };
      };
      const code = await main(['--data-dir', tmp.dir, ...argv], {
        env: { PATH: '/usr/bin', HOME: '/home/x', FAKE_TOKEN: 'other-account', MY_KEY: KEY },
        platform: 'linux',
        homedir: tmp.dir,
        out: () => undefined,
        err: (line) => err.push(line),
        systemLocale: 'en',
        version: '1.2.3',
        cwd: '/work/repo',
        overrides: { clock, store, vault, launcher, transport },
        clients,
        execSpawn: spawn,
        execSignals: (forward) => {
          if (rig.signalDuringRun !== undefined) forward(rig.signalDuringRun);
          return () => undefined;
        },
        ...extra,
      });
      return { code, err: err.join('\n') };
    },
    events: async (type) =>
      (await store.events.readFrom(0, 1000)).filter((e) => e.type === type).map((e) => e.payload),
  };
  try {
    await body(rig);
  } finally {
    await tmp.dispose();
  }
}

async function addProfile(
  rig: Rig,
  client: string,
  name: string,
  extra: string[] = [],
): Promise<void> {
  const added = await rig.run(['profile', 'add', client, name, '--accept-notice', ...extra]);
  expect(added.code, added.err).toBe(0);
}

describe('ot profile exec (P28a, N159)', () => {
  it('runs the CLI of the client inside the profile, with the common words translated', async () => {
    await withRig(async (rig) => {
      await addProfile(rig, 'codex', 'personal');
      const result = await rig.run([
        'profile',
        'exec',
        'codex/personal',
        '--',
        '--model',
        'gpt-x',
        'run',
        'say hi',
      ]);
      expect(result.code, result.err).toBe(0);
      const [spawned] = rig.spawned;
      const dir = (await rig.store.profiles.get('codex/personal'))?.dir;
      expect(spawned).toMatchObject({
        cmd: 'fake-cli',
        args: ['--base', '-p', '-m', 'gpt-x', 'say hi'],
        cwd: '/work/repo',
      });
      // terminal mode: the person's environment, without what points at another account.
      expect(spawned?.env).toEqual({
        PATH: '/usr/bin',
        HOME: '/home/x',
        MY_KEY: KEY,
        FAKE_HOME: dir,
      });
      expect(await rig.events('profile.exec.started')).toEqual([
        { profileId: 'codex/personal', command: 'run', envInherit: 'terminal', apiKey: false },
      ]);
      expect(await rig.events('profile.exec.ended')).toEqual([
        {
          profileId: 'codex/personal',
          command: 'run',
          exitCode: 0,
          signal: null,
          startFailed: false,
          durationMs: 0,
        },
      ]);
    });
  });

  it("after a second -- the words reach the client as they are, and its exit code is the command's", async () => {
    await withRig(async (rig) => {
      await addProfile(rig, 'codex', 'personal');
      rig.exit = { code: 3, signal: null };
      const result = await rig.run([
        'profile',
        'exec',
        'codex/personal',
        '--',
        '--',
        'login',
        '--device-auth',
      ]);
      expect(result.code).toBe(3);
      expect(rig.spawned[0]?.args).toEqual(['--base', 'login', '--device-auth']);
      expect(await rig.events('profile.exec.started')).toMatchObject([{ command: 'native' }]);
    });
  });

  it('gives an API profile its key from the vault, and never puts it in an event', async () => {
    await withRig(async (rig) => {
      await addProfile(rig, 'claude-code', 'metered', ['--kind', 'api', '--api-key-env', 'MY_KEY']);
      const result = await rig.run(['profile', 'exec', 'claude-code/metered', '--', 'status']);
      expect(result.code, result.err).toBe(0);
      expect(rig.spawned[0]?.args).toEqual(['--base', 'auth', 'status']);
      expect(rig.spawned[0]?.env.ANTHROPIC_API_KEY).toBe(KEY);
      expect(await rig.events('profile.exec.started')).toMatchObject([{ apiKey: true }]);
      const all = await rig.store.events.readFrom(0, 1000);
      expect(JSON.stringify(all)).not.toContain(KEY);
      expect(result.err).not.toContain(KEY);
    });
  });

  it('client mode: the environment the daemon gives an Executor of the client', async () => {
    await withRig(async (rig) => {
      await addProfile(rig, 'codex', 'personal');
      await writeFile(
        dataPaths(rig.dir).config,
        'profiles:\n  exec:\n    env_inherit: client\n',
        'utf8',
      );
      const result = await rig.run(['profile', 'exec', 'codex/personal', '--', 'status']);
      expect(result.code, result.err).toBe(0);
      const env = rig.spawned[0]?.env ?? {};
      expect(env.MY_KEY).toBeUndefined();
      expect(env.FAKE_TOKEN).toBeUndefined();
      expect(env.FAKE_HOME).toBeDefined();
      expect(await rig.events('profile.exec.started')).toMatchObject([{ envInherit: 'client' }]);
    });
  });

  it('a configured common word reaches the client named, and the others say they do not have it', async () => {
    await withRig(async (rig) => {
      await addProfile(rig, 'codex', 'personal');
      await addProfile(rig, 'claude-code', 'work');
      await writeFile(
        dataPaths(rig.dir).config,
        'profiles:\n  commands:\n    review:\n      codex: [review, --uncommitted]\n',
        'utf8',
      );
      const ok = await rig.run(['profile', 'exec', 'codex/personal', '--', 'review']);
      expect(ok.code, ok.err).toBe(0);
      expect(rig.spawned[0]?.args).toEqual(['--base', 'review', '--uncommitted']);
      const refused = await rig.run(['profile', 'exec', 'claude-code/work', '--', 'review']);
      expect(refused.code).toBe(2);
      expect(refused.err).toMatch(/"review" is a common word that claude-code has no translation/);
      expect(refused.err).toMatch(/login, run, status/);
      expect(refused.err).toMatch(/after "--"/);
      expect(rig.spawned).toHaveLength(1);
      const missing = await rig.run(['profile', 'exec', 'codex/personal', '--', 'run', '--model']);
      expect(missing.code).toBe(2);
      expect(missing.err).toMatch(/--model needs a value/);
    });
  });

  it('refuses a removed profile, an unknown one, and a client with no CLI by profile; warns on a draining one', async () => {
    await withRig(async (rig) => {
      expect((await rig.run(['profile', 'exec', 'codex'])).code).toBe(2);
      const unknown = await rig.run(['profile', 'exec', 'codex/nobody']);
      expect(unknown.code).toBe(1);
      expect(unknown.err).toMatch(/codex\/nobody not found/);

      await addProfile(rig, 'codex', 'old');
      await rig.store.profiles.update('codex/old', { state: 'draining' });
      const draining = await rig.run(['profile', 'exec', 'codex/old', '--', 'status']);
      expect(draining.code).toBe(0);
      expect(draining.err).toMatch(/draining/);
      await rig.store.profiles.update('codex/old', { state: 'removed' });
      const removed = await rig.run(['profile', 'exec', 'codex/old', '--', 'status']);
      expect(removed.code).toBe(1);
      expect(removed.err).toMatch(/was removed/);

      await addProfile(rig, 'bare', 'one', ['--provider', 'x']);
      const bare = await rig.run(['profile', 'exec', 'bare/one']);
      expect(bare.code).toBe(1);
      expect(bare.err).toMatch(/cannot run its CLI inside a profile/);
      expect(rig.spawned).toHaveLength(1);
      expect(await rig.events('profile.warning')).toEqual([
        { profileId: 'codex/old', kind: 'exec_draining' },
        { profileId: 'codex/old', kind: 'exec_refused', detail: 'removed' },
        { profileId: 'bare/one', kind: 'exec_refused', detail: 'no_profile_cli' },
      ]);
    });
  });

  it('a CLI that does not start is 127, and a signal passed on ends it with 128 + its number', async () => {
    await withRig(async (rig) => {
      await addProfile(rig, 'codex', 'personal');
      rig.exit = Object.assign(new Error('spawn fake-cli ENOENT'), { code: 'ENOENT' });
      const missing = await rig.run(['profile', 'exec', 'codex/personal']);
      expect(missing.code).toBe(127);
      expect(missing.err).toMatch(/Could not start fake-cli \(ENOENT\)/);
      expect(await rig.events('profile.exec.ended')).toMatchObject([
        { exitCode: null, signal: null, startFailed: true },
      ]);

      rig.exit = { code: null, signal: 'SIGTERM' };
      rig.signalDuringRun = 'SIGTERM';
      const ended = await rig.run(['profile', 'exec', 'codex/personal']);
      expect(ended.code).toBe(143);
      expect(rig.spawned[1]?.killed).toEqual(['SIGTERM']);
    });
  });
});

describe('the parts of ot profile exec', () => {
  it('exitCodeOf: the code, or 128 + the signal', () => {
    expect(exitCodeOf({ code: 5, signal: null })).toBe(5);
    expect(exitCodeOf({ code: null, signal: 'SIGINT' })).toBe(130);
    expect(exitCodeOf({ code: null, signal: null })).toBe(1);
  });

  it('execEnv: takes out the names of unsetEnv in any case, then the profile and the key win', () => {
    const env = execEnv(
      'terminal',
      { PATH: '/b', fake_token: 'x', KEEP: 'y', GONE: undefined },
      undefined,
      { env: { FAKE_HOME: '/p' }, unsetEnv: ['FAKE_TOKEN'] },
      { API_KEY: 'k' },
    );
    expect(env).toEqual({ PATH: '/b', KEEP: 'y', FAKE_HOME: '/p', API_KEY: 'k' });
  });

  it('isProfileExecArgv: only `profile exec`, with or without --data-dir before it', () => {
    expect(isProfileExecArgv(['profile', 'exec', 'codex/x', '--', 'login'])).toBe(true);
    expect(isProfileExecArgv(['--data-dir', '/d', 'profile', 'exec', 'codex/x'])).toBe(true);
    expect(isProfileExecArgv(['profile', 'list'])).toBe(false);
    expect(isProfileExecArgv(['daemon'])).toBe(false);
    expect(isProfileExecArgv(['--', 'profile', 'exec'])).toBe(false);
  });
});
