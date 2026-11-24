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
import { isProfileAddLoginArgv, main, type CliDeps } from '../cli.js';
import type { ClientFactory } from '../clients.js';
import { dataPaths } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';
import { loginDecision, loginSkippedReason } from './command.js';
import type { ChildExit, ExecSpawn } from './exec.js';

/**
 * The login that goes with `ot profile add` (2026-11-22): `profiles.add.login` and the flags
 * `--login` and `--no-login`. The client and the spawn are fakes: no real client runs and no
 * browser opens; the login is `ot profile exec <id> login` (the fake CLI records what it is given).
 */

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const CLIENTS = ['claude-code', 'codex', 'opencode'] as const;

const CLI_OF = (dir: string): ProfileCli => ({
  cmd: 'fake-cli',
  args: ['--base'],
  env: { FAKE_HOME: dir },
  unsetEnv: [],
  commands: { login: ['auth', 'login'] },
  options: {},
});

interface Rig {
  readonly dir: string;
  readonly spawned: { cmd: string; args: readonly string[] }[];
  readonly asked: string[];
  /** The payloads of the events of a type, in the order they were written. */
  events(type: string): Promise<unknown[]>;
  /** What the fake client reports for a new account, and how the fake login ends. */
  loginState: 'logged_in' | 'logged_out' | 'unknown';
  exit: ChildExit;
  run(
    argv: readonly string[],
    extra?: Partial<CliDeps>,
  ): Promise<{ code: number; out: string[]; err: string[] }>;
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
  const rig: Rig = {
    dir: tmp.dir,
    spawned: [],
    asked: [],
    events: async (type) =>
      (await store.events.readFrom(0, 1000)).filter((e) => e.type === type).map((e) => e.payload),
    loginState: 'logged_out',
    exit: { code: 0, signal: null },
    run: async (argv, extra = {}) => {
      const clients: ClientFactory = (parts) =>
        CLIENTS.map((id) => {
          const adapter = new FakeClientAdapter({
            id,
            launcher: parts.launcher,
            baseEnv: { PATH: '/bin' },
            adapterVersion: '1.0.0',
            command: { cmd: 'fake-client', args: ['--acp'] },
            loginState: rig.loginState === 'unknown' ? 'unknown' : rig.loginState,
          });
          Object.assign(adapter, {
            profileCli: (profile: { dir: string }) => Promise.resolve(CLI_OF(profile.dir)),
          });
          return adapter;
        });
      const spawn: ExecSpawn = (cmd, args) => {
        rig.spawned.push({ cmd, args });
        return {
          exited: Promise.resolve(rig.exit),
          kill: () => undefined,
        };
      };
      const captured = { out: [] as string[], err: [] as string[] };
      const code = await main([...argv, '--data-dir', tmp.dir], {
        env: { PATH: '/usr/bin' },
        platform: 'linux',
        homedir: tmp.dir,
        out: (line) => captured.out.push(line),
        err: (line) => captured.err.push(line),
        systemLocale: 'en',
        version: '1.2.3',
        cwd: '/work/repo',
        overrides: { clock, store, vault, launcher, transport },
        clients,
        execSpawn: spawn,
        execSignals: () => () => undefined,
        ...extra,
      });
      return { ...captured, code };
    },
  };
  try {
    await body(rig);
  } finally {
    await tmp.dispose();
  }
}

async function setMode(rig: Rig, mode: 'ask' | 'auto' | 'off'): Promise<void> {
  await writeFile(dataPaths(rig.dir).config, `profiles:\n  add:\n    login: ${mode}\n`, 'utf8');
}

/** A terminal that answers the question with `answer`, recording what was asked. */
function terminal(rig: Rig, answer: boolean): Partial<CliDeps> {
  return {
    interactive: true,
    confirm: (question) => {
      rig.asked.push(question);
      return Promise.resolve(answer);
    },
  };
}

const ADD = ['profile', 'add', 'claude-code', 'work'] as const;
const LOGIN_ARGS = ['--base', 'auth', 'login'];

describe('ot profile add: the login that goes with the account (profiles.add.login)', () => {
  it.each(CLIENTS)('--login logs in with the %s CLI inside the new profile', async (client) => {
    await withRig(async (rig) => {
      const result = await rig.run([
        'profile',
        'add',
        client,
        'work',
        '--provider',
        'p',
        '--login',
      ]);
      expect(result.code, result.err.join('\n')).toBe(0);
      expect(rig.spawned).toEqual([{ cmd: 'fake-cli', args: LOGIN_ARGS }]);
      expect(rig.asked).toEqual([]);
      expect(result.out.join('\n')).toMatch(/Login of .* finished/);
    });
  });

  it('--no-login does not log in, whatever the key says', async () => {
    await withRig(async (rig) => {
      await setMode(rig, 'auto');
      const result = await rig.run([...ADD, '--no-login'], terminal(rig, true));
      expect(result.code).toBe(0);
      expect(rig.spawned).toEqual([]);
      expect(rig.asked).toEqual([]);
    });
  });

  it('ask (the default) in a terminal: yes logs in, anything else leaves the login for later', async () => {
    await withRig(async (rig) => {
      const yes = await rig.run([...ADD], terminal(rig, true));
      expect(yes.code, yes.err.join('\n')).toBe(0);
      expect(rig.asked).toEqual(['Log in to claude-code/work now?']);
      expect(rig.spawned).toEqual([{ cmd: 'fake-cli', args: LOGIN_ARGS }]);
    });
    await withRig(async (rig) => {
      const no = await rig.run([...ADD], terminal(rig, false));
      expect(no.code).toBe(0);
      expect(rig.asked).toHaveLength(1);
      expect(rig.spawned).toEqual([]);
      expect(no.out.join('\n')).toMatch(/ot profile exec claude-code\/work login/);
    });
  });

  it('ask without a terminal does not ask and does not log in', async () => {
    await withRig(async (rig) => {
      const result = await rig.run([...ADD]);
      expect(result.code).toBe(0);
      expect(rig.spawned).toEqual([]);
      expect(rig.asked).toEqual([]);
    });
    await withRig(async (rig) => {
      // Input and output are a terminal, but nothing to ask with: it still does not go on.
      const result = await rig.run([...ADD], { interactive: true });
      expect(result.code).toBe(0);
      expect(rig.spawned).toEqual([]);
    });
  });

  it('--json never asks and never logs in (and --login with --json is a usage error)', async () => {
    await withRig(async (rig) => {
      const result = await rig.run([...ADD, '--json'], terminal(rig, true));
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out.join('\n'))).toMatchObject({
        status: 'added',
        login: 'logged_out',
      });
      expect(rig.asked).toEqual([]);
      expect(rig.spawned).toEqual([]);
    });
    await withRig(async (rig) => {
      await setMode(rig, 'auto');
      const auto = await rig.run([...ADD, '--json'], terminal(rig, true));
      expect(auto.code).toBe(0);
      expect(rig.spawned).toEqual([]);
    });
    await withRig(async (rig) => {
      const bad = await rig.run([...ADD, '--login', '--json']);
      expect(bad.code).toBe(2);
      expect(bad.err.join('\n')).toMatch(/--login cannot go with --json/);
      expect(rig.spawned).toEqual([]);
    });
  });

  it('auto logs in at once in a terminal, and not without one', async () => {
    await withRig(async (rig) => {
      await setMode(rig, 'auto');
      const result = await rig.run([...ADD], terminal(rig, false));
      expect(result.code, result.err.join('\n')).toBe(0);
      expect(rig.asked).toEqual([]);
      expect(rig.spawned).toHaveLength(1);
    });
    await withRig(async (rig) => {
      await setMode(rig, 'auto');
      const result = await rig.run([...ADD]);
      expect(result.code).toBe(0);
      expect(rig.spawned).toEqual([]);
    });
  });

  it('auto without a terminal: one stderr line, the command, and the event profile.login.skipped (N273)', async () => {
    await withRig(async (rig) => {
      await setMode(rig, 'auto');
      const result = await rig.run([...ADD]);
      expect(result.code).toBe(0);
      expect(rig.spawned).toEqual([]);
      expect(result.err).toEqual([
        'Login not started (profiles.add.login is auto, but there is no terminal here). To log in: ot profile exec claude-code/work login',
      ]);
      expect(result.out.join('\n')).not.toMatch(/Login not started/);
      expect(await rig.events('profile.login.skipped')).toEqual([
        { profileId: 'claude-code/work', reason: 'no_terminal' },
      ]);
    });
  });

  it('auto with --json: the warning is in the JSON, the stderr stays empty, and the event is written', async () => {
    await withRig(async (rig) => {
      await setMode(rig, 'auto');
      const result = await rig.run([...ADD, '--json'], terminal(rig, true));
      expect(result.code).toBe(0);
      expect(result.err).toEqual([]);
      expect(rig.spawned).toEqual([]);
      expect(JSON.parse(result.out.join('\n'))).toMatchObject({
        status: 'added',
        loginSkipped: { reason: 'json', command: 'ot profile exec claude-code/work login' },
      });
      expect(await rig.events('profile.login.skipped')).toEqual([
        { profileId: 'claude-code/work', reason: 'json' },
      ]);
    });
  });

  it('says nothing and records nothing when the login was not skipped by auto', async () => {
    const skipped = async (rig: Rig): Promise<number> =>
      (await rig.events('profile.login.skipped')).length;
    // ask without a terminal, off, --no-login, and auto in a terminal: nothing was promised.
    await withRig(async (rig) => {
      const result = await rig.run([...ADD]);
      expect(result.err).toEqual([]);
      expect(await skipped(rig)).toBe(0);
    });
    await withRig(async (rig) => {
      await setMode(rig, 'off');
      const result = await rig.run([...ADD]);
      expect(result.err).toEqual([]);
      expect(await skipped(rig)).toBe(0);
    });
    await withRig(async (rig) => {
      await setMode(rig, 'auto');
      const result = await rig.run([...ADD, '--no-login']);
      expect(result.err).toEqual([]);
      expect(await skipped(rig)).toBe(0);
    });
    await withRig(async (rig) => {
      await setMode(rig, 'auto');
      const result = await rig.run([...ADD], terminal(rig, true));
      expect(result.err).toEqual([]);
      expect(await skipped(rig)).toBe(0);
    });
    // An account that already has a login has nothing to skip.
    await withRig(async (rig) => {
      await setMode(rig, 'auto');
      rig.loginState = 'logged_in';
      const result = await rig.run([...ADD]);
      expect(result.err).toEqual([]);
      expect(await skipped(rig)).toBe(0);
    });
  });

  it('off never offers the login in a terminal, but --login still does it', async () => {
    await withRig(async (rig) => {
      await setMode(rig, 'off');
      const result = await rig.run([...ADD], terminal(rig, true));
      expect(result.code).toBe(0);
      expect(rig.asked).toEqual([]);
      expect(rig.spawned).toEqual([]);
      const forced = await rig.run(['profile', 'add', 'codex', 'work', '--login']);
      expect(forced.code, forced.err.join('\n')).toBe(0);
      expect(rig.spawned).toHaveLength(1);
    });
  });

  it('an API account, and an account that already has a login, have nothing to log in', async () => {
    await withRig(async (rig) => {
      await setMode(rig, 'auto');
      const api = await rig.run([...ADD, '--kind', 'api', '--api-key-env', 'MY_KEY', '--login'], {
        ...terminal(rig, true),
        env: { PATH: '/usr/bin', MY_KEY: 'sk-test-0123456789' },
      });
      expect(api.code, api.err.join('\n')).toBe(0);
      expect(rig.asked).toEqual([]);
      expect(rig.spawned).toEqual([]);
    });
    await withRig(async (rig) => {
      rig.loginState = 'logged_in';
      const done = await rig.run([...ADD, '--login'], terminal(rig, true));
      expect(done.code).toBe(0);
      expect(rig.asked).toEqual([]);
      expect(rig.spawned).toEqual([]);
    });
  });

  it('a login that fails keeps the account and says how to try again', async () => {
    await withRig(async (rig) => {
      rig.exit = { code: 1, signal: null };
      const result = await rig.run([...ADD, '--login']);
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toMatch(
        /did not finish \(exit code 1\).*ot profile exec claude-code\/work login/,
      );
      const listed = await rig.run(['profile', 'list']);
      expect(listed.out.join('\n')).toMatch(/claude-code\/work \[active\]/);
    });
  });

  it('--login and --no-login together are a usage error and nothing is registered', async () => {
    await withRig(async (rig) => {
      const result = await rig.run([...ADD, '--login', '--no-login']);
      expect(result.code).toBe(2);
      expect(result.err.join('\n')).toMatch(/only one of --login and --no-login/);
      const listed = await rig.run(['profile', 'list']);
      expect(listed.out.join('\n')).toMatch(/No profiles/);
    });
  });

  it('a second subscription that needs the notice makes nothing and logs in to nothing', async () => {
    await withRig(async (rig) => {
      await rig.run([...ADD, '--no-login']);
      const second = await rig.run(['profile', 'add', 'claude-code', 'two', '--login']);
      expect(second.code).toBe(1);
      expect(rig.spawned).toEqual([]);
    });
  });
});

describe('loginDecision and isProfileAddLoginArgv', () => {
  const base = {
    mode: 'ask',
    flag: undefined,
    json: false,
    interactive: true,
    canAsk: true,
    needsLogin: true,
  } as const;

  it('follows the flag, then the key, then the terminal', () => {
    expect(loginDecision(base)).toBe('ask');
    expect(loginDecision({ ...base, mode: 'auto' })).toBe('login');
    expect(loginDecision({ ...base, mode: 'off' })).toBe('none');
    expect(loginDecision({ ...base, flag: true, mode: 'off', interactive: false })).toBe('login');
    expect(loginDecision({ ...base, flag: false, mode: 'auto' })).toBe('none');
    expect(loginDecision({ ...base, canAsk: false })).toBe('none');
    expect(loginDecision({ ...base, interactive: false, mode: 'auto' })).toBe('none');
    expect(loginDecision({ ...base, json: true, mode: 'auto' })).toBe('none');
    expect(loginDecision({ ...base, needsLogin: false, flag: true })).toBe('none');
  });

  it('loginSkippedReason: only `auto` with no flag, an account that needs a login, and no way to log in', () => {
    const input = {
      mode: 'auto',
      flag: undefined,
      json: false,
      interactive: false,
      needsLogin: true,
    } as const;
    expect(loginSkippedReason(input)).toBe('no_terminal');
    expect(loginSkippedReason({ ...input, json: true })).toBe('json');
    expect(loginSkippedReason({ ...input, json: true, interactive: true })).toBe('json');
    expect(loginSkippedReason({ ...input, interactive: true })).toBeUndefined();
    expect(loginSkippedReason({ ...input, mode: 'ask' })).toBeUndefined();
    expect(loginSkippedReason({ ...input, mode: 'off' })).toBeUndefined();
    expect(loginSkippedReason({ ...input, flag: false })).toBeUndefined();
    expect(loginSkippedReason({ ...input, flag: true })).toBeUndefined();
    expect(loginSkippedReason({ ...input, needsLogin: false })).toBeUndefined();
  });

  it('only `profile add ... --login` keeps Ctrl+C for the client', () => {
    expect(isProfileAddLoginArgv(['profile', 'add', 'codex', 'x', '--login'])).toBe(true);
    expect(
      isProfileAddLoginArgv(['--data-dir', '/d', 'profile', 'add', '--login', 'codex', 'x']),
    ).toBe(true);
    expect(isProfileAddLoginArgv(['profile', 'add', 'codex', 'x'])).toBe(false);
    expect(isProfileAddLoginArgv(['profile', 'list', '--login'])).toBe(false);
    expect(isProfileAddLoginArgv(['profile', 'add', 'codex', 'x', '--', '--login'])).toBe(false);
  });
});
