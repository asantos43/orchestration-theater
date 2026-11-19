// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  Cancelled,
  PermissionDenied,
  type AgentSession,
  type Profile,
  type SessionOpenParams,
  type SessionTransport,
} from '@otheater/core';
import { FakeProcessLauncher, FakeSessionTransport } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CodexAdapter,
  DEFAULT_LOGIN_COMMANDS,
  DEFAULT_LOGOUT_COMMAND,
  type CodexAdapterOptions,
} from './codex-adapter.js';
import { CONFIG_FILE } from './profile.js';
import { writeFakeClient } from './testing/fake-official-client.js';
import { NodeProcessLauncher } from './testing/node-process-launcher.js';

let root: string;
let launcher: NodeProcessLauncher;
let command: (name: string) => { cmd: string; args: string[] };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ot-codex-login-'));
  launcher = new NodeProcessLauncher();
  command = await writeFakeClient(join(root, 'bin'), 'CODEX_HOME');
});

afterEach(async () => {
  await launcher.killAll();
  await rm(root, { recursive: true, force: true });
});

function profileOf(name: string): Profile {
  return {
    client: 'codex',
    profile: name,
    id: `codex/${name}`,
    dir: join(root, 'profiles', name),
  };
}

const SANDBOX = { fields: ['nativeTools', 'nativeShell', 'network'] } as const;

/** An adapter whose official commands, and whose `codex-acp`, are the fake client's. */
function build(
  scenario: string,
  login: NonNullable<CodexAdapterOptions['login']> = {},
): CodexAdapter {
  return new CodexAdapter({
    launcher,
    baseEnv: { FAKE_SCENARIO: scenario, FAKE_DELAY_MS: '80' },
    sandbox: SANDBOX,
    adapterVersion: '2.6.0',
    command: command('status-json'),
    login: { command: command('login'), logoutCommand: command('logout'), ...login },
  });
}

/**
 * What `codex-acp` does at `session/new`: with no login in the profile it answers JSON-RPC -32000
 * "Authentication required" [V, Phase 0 item 6]. Here the "codex-acp" is the fake client's status
 * command, which exits 0 when the profile has a login; the transport reads that and nothing else.
 */
class LoginAwareTransport implements SessionTransport {
  readonly id = 'acp';
  readonly #inner = new FakeSessionTransport({ id: 'acp' });
  async open(params: SessionOpenParams): Promise<AgentSession> {
    const exit = await params.process.exited;
    if (exit.code !== 0)
      throw Object.assign(new Error('Authentication required'), { code: -32000 });
    return this.#inner.open(params);
  }
  load(): Promise<AgentSession> {
    return Promise.reject(new AdapterUnavailable('not needed'));
  }
}

describe('codex login', () => {
  it('browser: hands the URL back, resolves at the end, and the probe goes from out to in', async () => {
    const adapter = build('browser');
    const profile = profileOf('a');
    const via = new LoginAwareTransport();
    expect(await adapter.probeLogin(profile, via)).toEqual({
      state: 'logged_out',
      via: 'acp_session',
    });

    const flow = await adapter.login(profile);
    expect(flow.mode).toBe('browser');
    expect(flow.url).toBe('https://auth.example.test/authorize?state=abc123');
    await expect(flow.complete()).resolves.toBeUndefined();

    expect(await adapter.probeLogin(profile, via)).toEqual({
      state: 'logged_in',
      via: 'acp_session',
    });
  });

  it('device_code: hands the URL and the code back', async () => {
    const adapter = build('device', { mode: 'device_code' });
    const flow = await adapter.login(profileOf('a'));
    expect(flow.mode).toBe('device_code');
    expect(flow.url).toBe('https://auth.example.test/device');
    expect(flow.code).toBe('ABCD-1234');
    await expect(flow.complete()).resolves.toBeUndefined();
  });

  it('terminal: comes back at once', async () => {
    const flow = await build('terminal', { mode: 'terminal' }).login(profileOf('a'));
    expect(flow.mode).toBe('terminal');
    expect(flow.url).toBeUndefined();
    await expect(flow.complete()).resolves.toBeUndefined();
  });

  it('paste: the code the browser shows goes to the login, and a good one signs in (P27)', async () => {
    const flow = await build('paste').login(profileOf('a'));
    await flow.submitCode?.('good-code#state');
    await expect(flow.complete()).resolves.toBeUndefined();
  });

  it('cancel() ends the client tree and complete() rejects with Cancelled', async () => {
    const adapter = build('hang');
    const profile = profileOf('a');
    const flow = await adapter.login(profile);
    const assertion = expect(flow.complete()).rejects.toBeInstanceOf(Cancelled);
    await flow.cancel();
    await assertion;
    expect(launcher.aliveGroups()).toBe(0);
    await flow.cancel();
    expect((await adapter.probeLogin(profile, new LoginAwareTransport())).state).toBe('logged_out');
  });

  it('a client that refuses makes login() reject with PermissionDenied', async () => {
    await expect(build('fail').login(profileOf('a'))).rejects.toBeInstanceOf(PermissionDenied);
  });

  it('a login that outlives its timeout ends with PermissionDenied', async () => {
    const flow = await build('hang', { timeoutMs: 1200 }).login(profileOf('a'));
    await expect(flow.complete()).rejects.toBeInstanceOf(PermissionDenied);
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('logout takes the login away; a failing logout is PermissionDenied', async () => {
    const adapter = build('browser');
    const profile = profileOf('a');
    const via = new LoginAwareTransport();
    await (await adapter.login(profile)).complete();
    expect((await adapter.probeLogin(profile, via)).state).toBe('logged_in');
    await adapter.logout(profile);
    expect((await adapter.probeLogin(profile, via)).state).toBe('logged_out');
    await expect(build('logout-fail').logout(profile)).rejects.toBeInstanceOf(PermissionDenied);
  });

  it("a login is the profile's: another profile stays logged out", async () => {
    const adapter = build('browser');
    const via = new LoginAwareTransport();
    await (await adapter.login(profileOf('a'))).complete();
    expect((await adapter.probeLogin(profileOf('a'), via)).state).toBe('logged_in');
    expect((await adapter.probeLogin(profileOf('b'), via)).state).toBe('logged_out');
  });

  it('writes config.toml before the login, so the client keeps the login in the profile', async () => {
    const profile = profileOf('a');
    const flow = await build('browser').login(profile);
    await flow.complete();
    expect(await readFile(join(profile.dir, CONFIG_FILE), 'utf8')).toContain(
      'cli_auth_credentials_store = "file"',
    );
  });
});

describe('codex login probe', () => {
  it('-32000 "Authentication required" is logged_out', async () => {
    const via = new FakeSessionTransport({ id: 'acp' });
    via.failWith = Object.assign(new Error('Authentication required'), { code: -32000 });
    const adapter = new CodexAdapter({
      launcher: new FakeProcessLauncher(),
      baseEnv: {},
      sandbox: SANDBOX,
      adapterVersion: '2.6.0',
    });
    expect(await adapter.probeLogin(profileOf('a'), via)).toEqual({
      state: 'logged_out',
      via: 'acp_session',
    });
  });

  it('an auth_required the transport already typed is logged_out', async () => {
    const via = new FakeSessionTransport({ id: 'acp' });
    via.failWith = new PermissionDenied('login first', {
      cause: { kind: 'auth_required', message: 'login first' },
    });
    const adapter = new CodexAdapter({
      launcher: new FakeProcessLauncher(),
      baseEnv: {},
      sandbox: SANDBOX,
      adapterVersion: '2.6.0',
    });
    expect((await adapter.probeLogin(profileOf('a'), via)).state).toBe('logged_out');
  });

  it('a session that opens is logged_in, and is closed', async () => {
    const fake = new FakeProcessLauncher();
    const adapter = new CodexAdapter({
      launcher: fake,
      baseEnv: {},
      sandbox: SANDBOX,
      adapterVersion: '2.6.0',
    });
    const via = new FakeSessionTransport({ id: 'acp' });
    expect((await adapter.probeLogin(profileOf('a'), via)).state).toBe('logged_in');
    expect(via.opened).toHaveLength(1);
    expect(fake.running).toHaveLength(0);
  });

  it('another failure says nothing about the login and goes up', async () => {
    const via = new FakeSessionTransport({ id: 'acp' });
    via.failWith = Object.assign(new Error('internal error'), { code: -32603 });
    const adapter = new CodexAdapter({
      launcher: new FakeProcessLauncher(),
      baseEnv: {},
      sandbox: SANDBOX,
      adapterVersion: '2.6.0',
    });
    await expect(adapter.probeLogin(profileOf('a'), via)).rejects.toBeInstanceOf(
      AdapterUnavailable,
    );
  });
});

describe('codex login: what is launched', () => {
  it('runs `codex login` in the profile with CODEX_HOME, and `--device-auth` for device_code', async () => {
    for (const mode of ['browser', 'device_code'] as const) {
      const fake = new FakeProcessLauncher();
      const adapter = new CodexAdapter({
        launcher: fake,
        baseEnv: { PATH: '/usr/bin' },
        sandbox: SANDBOX,
        adapterVersion: '2.6.0',
        login: { mode, urlWaitMs: 10 },
      });
      const profile = profileOf(mode);
      const flow = await adapter.login(profile);
      const [launched] = fake.launched;
      expect(launched?.options.cmd).toBe('codex');
      expect(launched?.options.args).toEqual([...DEFAULT_LOGIN_COMMANDS[mode].args]);
      expect(launched?.options.cwd).toBe(profile.dir);
      expect(launched?.options.env).toEqual({ PATH: '/usr/bin', CODEX_HOME: profile.dir });
      await flow.cancel();
    }
    expect(DEFAULT_LOGIN_COMMANDS.device_code.args).toEqual(['login', '--device-auth']);
    expect(DEFAULT_LOGOUT_COMMAND).toEqual({ cmd: 'codex', args: ['logout'] });
  });

  it('a command given in the options replaces the default', async () => {
    const fake = new FakeProcessLauncher();
    const adapter = new CodexAdapter({
      launcher: fake,
      baseEnv: {},
      sandbox: SANDBOX,
      adapterVersion: '2.6.0',
      login: { command: { cmd: '/opt/codex', args: ['login', '--with-api-key'] }, urlWaitMs: 10 },
    });
    const flow = await adapter.login(profileOf('a'));
    expect(fake.launched[0]?.options.cmd).toBe('/opt/codex');
    expect(fake.launched[0]?.options.args).toEqual(['login', '--with-api-key']);
    await flow.cancel();
  });
});
