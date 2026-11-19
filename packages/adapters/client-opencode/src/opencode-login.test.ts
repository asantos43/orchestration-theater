// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cancelled, PermissionDenied, type Profile } from '@otheater/core';
import { FakeProcessLauncher } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenCodeAdapter,
  opencodeAdapterVersion,
  type OpenCodeLoginOptions,
} from './opencode-adapter.js';
import { DEFAULT_ISOLATION, isolationEnv } from './profile.js';
import { writeFakeClient } from './testing/fake-official-client.js';
import { NodeProcessLauncher } from './testing/node-process-launcher.js';

let root: string;
let launcher: NodeProcessLauncher;
let command: (name: string) => { cmd: string; args: string[] };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ot-opencode-login-'));
  launcher = new NodeProcessLauncher();
  command = await writeFakeClient(join(root, 'bin'), 'XDG_DATA_HOME');
});

afterEach(async () => {
  await launcher.killAll();
  await rm(root, { recursive: true, force: true });
});

function profileOf(name: string): Profile {
  return {
    client: 'opencode',
    profile: name,
    id: `opencode/${name}`,
    dir: join(root, 'profiles', name),
  };
}

const ALL_OS = { fields: ['nativeTools', 'nativeShell', 'network', 'writeScope'] } as const;

/** An adapter whose official commands are the fake client's. */
function build(scenario: string, login: OpenCodeLoginOptions = {}): OpenCodeAdapter {
  return new OpenCodeAdapter({
    launcher,
    baseEnv: { FAKE_SCENARIO: scenario, FAKE_DELAY_MS: '80' },
    adapterVersion: opencodeAdapterVersion(),
    sandbox: ALL_OS,
    profileDir: (ref) => join(root, 'profiles', ref.profile),
    login: {
      command: command('login'),
      logoutCommand: command('logout'),
      listCommand: command('status-count'),
      ...login,
    },
  });
}

describe('opencode login', () => {
  it('terminal (the default): comes back at once, resolves at the end, the probe goes from out to in', async () => {
    const adapter = build('terminal');
    const profile = profileOf('a');
    expect(await adapter.probeLogin(profile)).toEqual({
      state: 'logged_out',
      via: 'account_list',
    });

    const flow = await adapter.login(profile);
    expect(flow.mode).toBe('terminal');
    expect(flow.url).toBeUndefined();
    await expect(flow.complete()).resolves.toBeUndefined();

    expect(await adapter.probeLogin(profile)).toEqual({ state: 'logged_in', via: 'account_list' });
  });

  it('browser: hands the URL back', async () => {
    const flow = await build('browser', { mode: 'browser' }).login(profileOf('a'));
    expect(flow.mode).toBe('browser');
    expect(flow.url).toBe('https://auth.example.test/authorize?state=abc123');
    await expect(flow.complete()).resolves.toBeUndefined();
  });

  it('device_code: hands the URL and the code back', async () => {
    const flow = await build('device', { mode: 'device_code' }).login(profileOf('a'));
    expect(flow.mode).toBe('device_code');
    expect(flow.url).toBe('https://auth.example.test/device');
    expect(flow.code).toBe('ABCD-1234');
    await expect(flow.complete()).resolves.toBeUndefined();
  });

  it('paste: the code the browser shows goes to the login, and a good one signs in (P27)', async () => {
    const flow = await build('paste').login(profileOf('a'));
    await flow.submitCode?.('good-code#state');
    await expect(flow.complete()).resolves.toBeUndefined();
  });

  it('cancel() ends the client tree and complete() rejects with Cancelled', async () => {
    const adapter = build('hang', { mode: 'browser' });
    const profile = profileOf('a');
    const flow = await adapter.login(profile);
    const assertion = expect(flow.complete()).rejects.toBeInstanceOf(Cancelled);
    await flow.cancel();
    await assertion;
    expect(launcher.aliveGroups()).toBe(0);
    await flow.cancel();
    expect((await adapter.probeLogin(profile)).state).toBe('logged_out');
  });

  it('a client that refuses makes login() reject with PermissionDenied', async () => {
    await expect(build('fail', { mode: 'browser' }).login(profileOf('a'))).rejects.toBeInstanceOf(
      PermissionDenied,
    );
  });

  it('in terminal mode login() does not wait, so the refusal comes through complete()', async () => {
    const flow = await build('fail').login(profileOf('a'));
    await expect(flow.complete()).rejects.toBeInstanceOf(PermissionDenied);
  });

  it('a login that outlives its timeout ends with PermissionDenied', async () => {
    const flow = await build('hang', { mode: 'browser', timeoutMs: 1200 }).login(profileOf('a'));
    await expect(flow.complete()).rejects.toBeInstanceOf(PermissionDenied);
    expect(launcher.aliveGroups()).toBe(0);
  });

  it('logout takes the login away; a failing logout is PermissionDenied', async () => {
    const adapter = build('terminal');
    const profile = profileOf('a');
    await (await adapter.login(profile)).complete();
    expect((await adapter.probeLogin(profile)).state).toBe('logged_in');
    await adapter.logout(profile);
    expect((await adapter.probeLogin(profile)).state).toBe('logged_out');
    await expect(build('logout-fail').logout(profile)).rejects.toBeInstanceOf(PermissionDenied);
  });

  it("a login is the profile's: another profile stays logged out", async () => {
    const adapter = build('terminal');
    await (await adapter.login(profileOf('a'))).complete();
    expect((await adapter.probeLogin(profileOf('a'))).state).toBe('logged_in');
    expect((await adapter.probeLogin(profileOf('b'))).state).toBe('logged_out');
  });

  it('a list the probe cannot read is unknown, never logged_in', async () => {
    const adapter = build('terminal', { listCommand: command('status-garbage') });
    expect(await adapter.probeLogin(profileOf('a'))).toEqual({
      state: 'unknown',
      via: 'account_list',
    });
  });
});

describe('opencode login: what is launched', () => {
  function recording(login: OpenCodeLoginOptions = {}) {
    const fake = new FakeProcessLauncher();
    const adapter = new OpenCodeAdapter({
      launcher: fake,
      baseEnv: { PATH: '/usr/bin' },
      adapterVersion: opencodeAdapterVersion(),
      sandbox: ALL_OS,
      profileDir: (ref) => join(root, 'profiles', ref.profile),
      login: { urlWaitMs: 10, ...login },
    });
    return { fake, adapter };
  }

  it('runs `opencode auth login` in the profile, with the isolation of the profile and no permission', async () => {
    const { fake, adapter } = recording();
    const profile = profileOf('a');
    const flow = await adapter.login(profile);
    const [launched] = fake.launched;
    expect(launched?.options.cmd).toBe('opencode');
    expect(launched?.options.args).toEqual(['auth', 'login']);
    expect(launched?.options.cwd).toBe(profile.dir);
    expect(launched?.options.env).toEqual({ PATH: '/usr/bin', ...isolationEnv(profile.dir) });
    expect(launched?.options.env.OPENCODE_PERMISSION).toBeUndefined();
    await flow.cancel();
  });

  it('adds the provider and the method the options name', async () => {
    const { fake, adapter } = recording({
      provider: 'anthropic',
      method: 'oauth',
      mode: 'browser',
    });
    const flow = await adapter.login(profileOf('a'));
    expect(fake.launched[0]?.options.args).toEqual([
      'auth',
      'login',
      '-p',
      'anthropic',
      '-m',
      'oauth',
    ]);
    await flow.cancel();
  });

  it('logout and list use the same executable; the provider goes to logout', async () => {
    const { fake, adapter } = recording({ provider: 'anthropic' });
    // Nothing ends by itself in the fake launcher: the commands are ended by their timeout, so only the launch is looked at.
    void adapter.logout(profileOf('a')).catch(() => undefined);
    void adapter.probeLogin(profileOf('a')).catch(() => undefined);
    // Both launches are awaited, not a fixed pause: a loaded Windows runner may take past 100 ms.
    await vi.waitFor(
      () => {
        expect(fake.launched).toHaveLength(2);
      },
      { timeout: 10_000, interval: 10 },
    );
    expect(fake.launched.map((process) => process.options.args)).toContainEqual([
      'auth',
      'logout',
      'anthropic',
    ]);
    expect(fake.launched.map((process) => process.options.args)).toContainEqual(['auth', 'list']);
    await Promise.all(fake.running.map((process) => process.killTree()));
  });

  it('the executable of `command` is the one the official commands use', async () => {
    const fake = new FakeProcessLauncher();
    const adapter = new OpenCodeAdapter({
      launcher: fake,
      baseEnv: {},
      adapterVersion: opencodeAdapterVersion(),
      sandbox: ALL_OS,
      profileDir: (ref) => join(root, 'profiles', ref.profile),
      command: { cmd: '/opt/opencode' },
      login: { urlWaitMs: 10 },
    });
    const flow = await adapter.login(profileOf('a'));
    expect(fake.launched[0]?.options.cmd).toBe('/opt/opencode');
    await flow.cancel();
  });
});

describe('opencode profileCli (P28a, N159)', () => {
  it('is the official CLI with the isolation of the profile, and the login options', async () => {
    const adapter = new OpenCodeAdapter({
      launcher: new FakeProcessLauncher(),
      baseEnv: { OPENAI_API_KEY: 'sk-test' },
      adapterVersion: opencodeAdapterVersion(),
      sandbox: ALL_OS,
      profileDir: (ref) => join(root, 'profiles', ref.profile),
      login: { provider: 'openai', method: 'ChatGPT Pro/Plus (browser)' },
    });
    const profile = profileOf('a');
    const cli = await adapter.profileCli(profile);
    expect(cli.cmd).toBe('opencode');
    // No pinned permission and no project config turned off: a person uses it as usual.
    expect(cli.env).toEqual(isolationEnv(profile.dir, DEFAULT_ISOLATION));
    expect(Object.keys(cli.env)).not.toContain('OPENCODE_PERMISSION');
    expect(cli.unsetEnv).toEqual(
      expect.arrayContaining(['OPENCODE_DB', 'OPENCODE_PERMISSION', 'OPENAI_API_KEY']),
    );
    expect(cli.commands).toEqual({
      login: ['auth', 'login', '-p', 'openai', '-m', 'ChatGPT Pro/Plus (browser)'],
      logout: ['auth', 'logout', 'openai'],
      status: ['auth', 'list'],
      run: ['run'],
    });
    expect(cli.options).toEqual({ model: ['--model'] });
  });
});
