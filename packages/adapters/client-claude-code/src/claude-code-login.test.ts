// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cancelled, PermissionDenied, type Profile } from '@otheater/core';
import { FakeProcessLauncher } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ClaudeCodeAdapter,
  DEFAULT_LOGIN_COMMAND,
  DEFAULT_LOGOUT_COMMAND,
  DEFAULT_STATUS_COMMAND,
  type ClaudeCodeLoginOptions,
} from './claude-code-adapter.js';
import { writeFakeClient } from './testing/fake-official-client.js';
import { NodeProcessLauncher } from './testing/node-process-launcher.js';

let root: string;
let launcher: NodeProcessLauncher;
let command: (name: string) => { cmd: string; args: string[] };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ot-claude-login-'));
  launcher = new NodeProcessLauncher();
  command = await writeFakeClient(join(root, 'bin'), 'CLAUDE_CONFIG_DIR');
});

afterEach(async () => {
  await launcher.killAll();
  await rm(root, { recursive: true, force: true });
});

function profileOf(name: string): Profile {
  return {
    client: 'claude-code',
    profile: name,
    id: `claude-code/${name}`,
    dir: join(root, 'profiles', name),
  };
}

/** An adapter whose official commands are the fake client's. */
function build(scenario: string, login: ClaudeCodeLoginOptions = {}): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    launcher,
    baseEnv: { FAKE_SCENARIO: scenario, FAKE_DELAY_MS: '80' },
    sandbox: { fields: ['writeScope', 'network'] },
    login: {
      command: command('login'),
      logoutCommand: command('logout'),
      statusCommand: command('status-json'),
      ...login,
    },
  });
}

describe('claude-code login', () => {
  it('browser: hands the URL back, resolves at the end, and the probe goes from out to in', async () => {
    const adapter = build('browser');
    const profile = profileOf('a');
    expect((await adapter.probeLogin(profile)).state).toBe('logged_out');

    const flow = await adapter.login(profile);
    expect(flow.mode).toBe('browser');
    expect(flow.url).toBe('https://auth.example.test/authorize?state=abc123');
    expect(flow.code).toBeUndefined();
    await expect(flow.complete()).resolves.toBeUndefined();

    expect(await adapter.probeLogin(profile)).toEqual({
      state: 'logged_in',
      via: 'status_command',
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

  it('terminal: comes back at once, with nothing to show', async () => {
    const adapter = build('terminal', { mode: 'terminal' });
    const flow = await adapter.login(profileOf('a'));
    expect(flow.mode).toBe('terminal');
    expect(flow.url).toBeUndefined();
    await expect(flow.complete()).resolves.toBeUndefined();
  });

  it('a client that says nothing in time still hands the flow back, without a URL', async () => {
    const adapter = build('quiet', { urlWaitMs: 40 });
    const profile = profileOf('a');
    const flow = await adapter.login(profile);
    expect(flow.url).toBeUndefined();
    await expect(flow.complete()).resolves.toBeUndefined();
    expect((await adapter.probeLogin(profile)).state).toBe('logged_in');
  });

  it('cancel() ends the client tree and complete() rejects with Cancelled', async () => {
    const adapter = build('hang');
    const profile = profileOf('a');
    const flow = await adapter.login(profile);
    expect(flow.url).toBe('https://auth.example.test/authorize?state=abc123');
    const done = flow.complete();
    const assertion = expect(done).rejects.toBeInstanceOf(Cancelled);
    await flow.cancel();
    await assertion;
    expect(launcher.aliveGroups()).toBe(0);
    await flow.cancel(); // a second one is a no-op
    expect((await adapter.probeLogin(profile)).state).toBe('logged_out');
  });

  it('a login that outlives its timeout ends with PermissionDenied', async () => {
    const adapter = build('hang', { timeoutMs: 1200 });
    const flow = await adapter.login(profileOf('a'));
    await expect(flow.complete()).rejects.toBeInstanceOf(PermissionDenied);
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('a client that refuses makes login() reject with PermissionDenied', async () => {
    const adapter = build('fail');
    await expect(adapter.login(profileOf('a'))).rejects.toBeInstanceOf(PermissionDenied);
  });

  it('logout takes the login away; a failing logout is PermissionDenied', async () => {
    const adapter = build('browser');
    const profile = profileOf('a');
    await (await adapter.login(profile)).complete();
    expect((await adapter.probeLogin(profile)).state).toBe('logged_in');
    await adapter.logout(profile);
    expect((await adapter.probeLogin(profile)).state).toBe('logged_out');

    await expect(build('logout-fail').logout(profile)).rejects.toBeInstanceOf(PermissionDenied);
  });

  it("a login is the profile's: another profile stays logged out", async () => {
    const adapter = build('browser');
    await (await adapter.login(profileOf('a'))).complete();
    expect((await adapter.probeLogin(profileOf('a'))).state).toBe('logged_in');
    expect((await adapter.probeLogin(profileOf('b'))).state).toBe('logged_out');
  });

  it('an answer the probe cannot read is unknown, never logged_in', async () => {
    const adapter = build('browser', { statusCommand: command('status-garbage') });
    expect(await adapter.probeLogin(profileOf('a'))).toEqual({
      state: 'unknown',
      via: 'status_command',
    });
  });
});

describe('claude-code login: what is launched', () => {
  it('runs the official commands in the profile, with the profile as config dir and no API key', async () => {
    const fake = new FakeProcessLauncher();
    const adapter = new ClaudeCodeAdapter({
      launcher: fake,
      baseEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_OAUTH_TOKEN: 'tok' },
      sandbox: { fields: ['writeScope', 'network'] },
      login: { urlWaitMs: 10 },
    });
    const profile = profileOf('a');
    const flow = await adapter.login(profile);
    const [launched] = fake.launched;
    expect(launched?.options.cmd).toBe(DEFAULT_LOGIN_COMMAND.cmd);
    expect(launched?.options.args).toEqual([...DEFAULT_LOGIN_COMMAND.args]);
    expect(launched?.options.cwd).toBe(profile.dir);
    expect(launched?.options.env).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: profile.dir });
    if (process.platform !== 'win32') {
      expect((await stat(profile.dir)).mode & 0o777).toBe(0o700);
    }
    await flow.cancel();
    expect(launched?.alive).toBe(false);
  });

  it('the defaults come from the help of the client and are the ones of the options', () => {
    expect(DEFAULT_LOGIN_COMMAND).toEqual({ cmd: 'claude', args: ['auth', 'login', '--claudeai'] });
    expect(DEFAULT_LOGOUT_COMMAND).toEqual({ cmd: 'claude', args: ['auth', 'logout'] });
    expect(DEFAULT_STATUS_COMMAND).toEqual({ cmd: 'claude', args: ['auth', 'status', '--json'] });
  });

  it('a command given in the options replaces the default, argument by argument', async () => {
    const fake = new FakeProcessLauncher();
    const adapter = new ClaudeCodeAdapter({
      launcher: fake,
      baseEnv: {},
      sandbox: { fields: ['writeScope', 'network'] },
      login: {
        command: { cmd: '/opt/claude', args: ['auth', 'login', '--console'] },
        urlWaitMs: 10,
      },
    });
    const flow = await adapter.login(profileOf('a'));
    expect(fake.launched[0]?.options.cmd).toBe('/opt/claude');
    expect(fake.launched[0]?.options.args).toEqual(['auth', 'login', '--console']);
    await flow.cancel();
  });
});
