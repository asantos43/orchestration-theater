// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  PermissionDenied,
  ROLE_POLICY_FIELDS,
  type Profile,
  type RolePolicy,
} from '@otheater/core';
import { FakeProcessLauncher, FakeSessionTransport } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter, DEFAULT_CODEX_COMMAND, type CodexAdapterOptions } from './codex-adapter.js';
import { CONFIG_OPTIONS } from './fixtures/config-options.js';
import { MODE_VETO_PROBE_ID, PINNED_MODE_PROBE_ID } from './probes.js';
import { CONFIG_FILE } from './profile.js';

const policy: RolePolicy = {
  nativeTools: ['read', 'search'],
  nativeShell: 'none',
  mcpServers: [],
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function profileIn(): Promise<Profile> {
  const dir = await mkdtemp(join(tmpdir(), 'ot-codex-adapter-'));
  dirs.push(dir);
  return { client: 'codex', profile: 'work', id: 'codex/work', dir };
}

/** Layer 3 as a sandbox that covers what the client cannot. */
const SANDBOX = { fields: ['nativeTools', 'nativeShell', 'network'] } as const;

interface BuildOptions extends Partial<CodexAdapterOptions> {
  /** No layer 3: the policy is short on the fields only a sandbox covers. */
  readonly bare?: boolean;
}

function build({ bare, ...options }: BuildOptions = {}) {
  const launcher = new FakeProcessLauncher();
  const adapter = new CodexAdapter({
    launcher,
    baseEnv: { PATH: '/usr/bin' },
    adapterVersion: '2.6.0',
    ...(bare === true ? {} : { sandbox: SANDBOX }),
    ...options,
  });
  return { launcher, adapter };
}

describe('CodexAdapter identity', () => {
  it('is the codex ClientAdapter, process model as Phase 0 measured it', () => {
    const { adapter } = build();
    expect(adapter.id).toBe('codex');
    expect(adapter.implements.port).toBe('ClientAdapter');
    expect(adapter.processModel).toBe('multi-session');
    expect(adapter.capabilities).toEqual({
      loadSession: true,
      mcpHttp: true,
      configOptions: ['model', 'thought_level', 'mode'],
      headless: true,
      extensions: [],
    });
    expect(adapter.models.discovery).toBe('automatic');
  });

  it('opens sessions with the measured process model: several sessions of a profile share one codex-acp', async () => {
    const { adapter, launcher } = build();
    const profile = await profileIn();
    const via = new FakeSessionTransport();
    const first = await adapter.openSession(profile, policy, '/work', via);
    const second = await adapter.openSession(profile, policy, '/other', via);
    expect(launcher.launched).toHaveLength(1);
    // Another profile is another CODEX_HOME, so another process.
    await adapter.openSession(await profileIn(), policy, '/work', via);
    expect(launcher.launched).toHaveLength(2);
    await first.close();
    await second.close();
  });

  it('refuses a vetoed initial mode at construction', () => {
    expect(() => build({ initialMode: 'agent', allowedModes: ['agent'] })).toThrow(InvalidInput);
    expect(() =>
      build({ initialMode: 'agent-full-access', allowedModes: ['agent-full-access'] }),
    ).toThrow(InvalidInput);
  });
});

describe('CodexAdapter.openSession', () => {
  it('starts codex-acp by default, with CODEX_HOME at the profile and the base environment', async () => {
    const { adapter, launcher } = build();
    const profile = await profileIn();
    const via = new FakeSessionTransport();
    await adapter.openSession(profile, policy, '/work', via);
    const launched = launcher.launched[0]?.options;
    expect(launched?.cmd).toBe(DEFAULT_CODEX_COMMAND.cmd);
    expect(launched?.cmd).toBe('codex-acp');
    expect(launched?.args).toEqual([]);
    expect(launched?.cwd).toBe('/work');
    expect(launched?.env).toEqual({ PATH: '/usr/bin', CODEX_HOME: profile.dir });
  });

  it('takes the command from the options', async () => {
    const { adapter, launcher } = build({
      command: { cmd: '/opt/bin/codex-acp', args: ['--flag'] },
    });
    await adapter.openSession(await profileIn(), policy, '/work', new FakeSessionTransport());
    expect(launcher.launched[0]?.options.cmd).toBe('/opt/bin/codex-acp');
    expect(launcher.launched[0]?.options.args).toEqual(['--flag']);
  });

  it('writes config.toml into the profile directory, and only that', async () => {
    const { adapter } = build({ credentialsStore: 'keyring', approvalPolicy: 'untrusted' });
    const profile = await profileIn();
    await writeFile(join(profile.dir, 'client-state.bin'), 'placeholder for a file of the client');
    await adapter.openSession(profile, policy, '/work', new FakeSessionTransport());
    expect((await readdir(profile.dir)).sort()).toEqual(['client-state.bin', CONFIG_FILE]);
    const toml = await readFile(join(profile.dir, CONFIG_FILE), 'utf8');
    expect(toml).toContain('cli_auth_credentials_store = "keyring"');
    expect(toml).toContain('sandbox_mode = "workspace-write"');
    expect(toml).toContain('approval_policy = "untrusted"');
    expect(await readFile(join(profile.dir, 'client-state.bin'), 'utf8')).toBe(
      'placeholder for a file of the client',
    );
  });

  it('pins the initial mode right after session/new, by the setup', async () => {
    const { adapter } = build();
    const via = new FakeSessionTransport();
    await adapter.openSession(await profileIn(), policy, '/work', via);
    expect(via.opened[0]?.setup).toEqual({
      via: 'acp',
      configOptions: { mode: 'workspace-write' },
    });
    const readOnly = build({ initialMode: 'read-only', allowedModes: ['read-only'] });
    const other = new FakeSessionTransport();
    await readOnly.adapter.openSession(await profileIn(), policy, '/work', other);
    expect(other.opened[0]?.setup).toEqual({ via: 'acp', configOptions: { mode: 'read-only' } });
  });

  it('pins the mode again on loadSession', async () => {
    const { adapter } = build();
    const via = new FakeSessionTransport();
    const profile = await profileIn();
    const session = await adapter.openSession(profile, policy, '/work', via);
    await adapter.loadSession(profile, policy, '/work', session.sessionId, via);
    expect(via.loaded[0]?.setup).toEqual({
      via: 'acp',
      configOptions: { mode: 'workspace-write' },
    });
  });

  it('gives the headless emergency exit codex exec --json with the sandbox of the mode', async () => {
    const { adapter } = build();
    const via = new FakeSessionTransport({ id: 'headless' });
    await adapter.openSession(await profileIn(), policy, '/work', via);
    expect(via.opened[0]?.setup).toEqual({
      via: 'headless',
      args: ['exec', '--json', '--sandbox', 'workspace-write'],
      env: {},
    });
  });

  it('refuses MCP servers in headless mode instead of dropping them', async () => {
    const { adapter, launcher } = build({ resolveMcpServers: () => [] });
    const via = new FakeSessionTransport({ id: 'headless' });
    await expect(
      adapter.openSession(await profileIn(), { ...policy, mcpServers: ['git'] }, '/work', via),
    ).rejects.toBeInstanceOf(InvalidInput);
    // The base wraps a setup failure after the launch; nothing is left running.
    expect(launcher.running).toHaveLength(0);
  });

  it('refuses a policy short of layers when there is no sandbox, and asks nothing of the client', async () => {
    const { adapter, launcher } = build({ bare: true });
    const via = new FakeSessionTransport();
    await expect(
      adapter.openSession(await profileIn(), policy, '/work', via),
    ).rejects.toBeInstanceOf(PermissionDenied);
    expect(launcher.launched).toHaveLength(0);
  });

  it('opens with security.unenforced allow, and rejects every permission request', async () => {
    const { adapter } = build({ bare: true, unenforced: 'allow' });
    const via = new FakeSessionTransport();
    const session = await adapter.openSession(await profileIn(), policy, '/work', via);
    await session.prompt([{ type: 'text', text: '#script:edit-file {"path":"x.txt"}\n' }]);
    expect(via.permissionAnswers).toEqual([{ outcome: 'selected', optionId: 'reject' }]);
    expect(via.edits).toEqual([]);
  });
});

describe('CodexAdapter.guarantee', () => {
  it('guarantees onAsk by client and daemon, bypass by the daemon veto, and leaves three fields to layer 3', () => {
    const { adapter } = build({ bare: true });
    const report = adapter.guarantee(policy, { fields: [] });
    expect(report.fields.onAsk.layers).toEqual(['client', 'daemon']);
    expect(report.fields.bypass.layers).toEqual(['daemon']);
    expect(report.fields.writeScope.layers).toEqual(['client']);
    expect(report.fields.mcpServers.layers).toEqual(['client']);
    expect(report.short).toEqual(['nativeTools', 'nativeShell', 'network']);
    expect(report.ok).toBe(false);
  });

  it('is complete once layer 3 covers the shell, the tools and the network', () => {
    const { adapter } = build({ bare: true });
    const report = adapter.guarantee(policy, SANDBOX);
    expect(report.ok).toBe(true);
    expect(report.fields.nativeShell.layers).toEqual(['os']);
  });

  it('with a sandbox that covers everything, every field has the os layer too', () => {
    const { adapter } = build({ bare: true });
    const report = adapter.guarantee(policy, { fields: ROLE_POLICY_FIELDS });
    for (const field of ROLE_POLICY_FIELDS) expect(report.fields[field].layers).toContain('os');
  });

  it('headless: no daemon layer for onAsk (nothing asks), and no MCP because the setup refuses it', () => {
    const { adapter } = build({ bare: true });
    const report = adapter.guarantee(policy, { fields: [] }, 'headless');
    expect(report.fields.mcpServers.layers).toEqual(['client']);
    expect(report.fields.onAsk.layers).toEqual(['client']);
    expect(report.fields.bypass.layers).toEqual(['daemon']);
  });
});

describe('CodexAdapter.configOptionsFor', () => {
  it('maps model, effort and mode to the ids of the client', () => {
    const { adapter } = build();
    expect(adapter.configOptionsFor({ model: 'model-a' })).toEqual({ model: 'model-a' });
    expect(
      adapter.configOptionsFor({ model: 'model-a', effort: 'low', mode: 'read-only' }),
    ).toEqual({
      model: 'model-a',
      reasoning_effort: 'low',
      mode: 'read-only',
    });
  });

  it.each(['agent', 'agent-full-access', 'permission-profile:x'])('refuses the mode %s', (mode) => {
    const { adapter } = build();
    expect(() => adapter.configOptionsFor({ model: 'model-a', mode })).toThrow(PermissionDenied);
  });

  it('refuses the veto on the open session, before it reaches the transport', async () => {
    const { adapter } = build();
    const via = new FakeSessionTransport();
    const session = await adapter.openSession(await profileIn(), policy, '/work', via);
    await expect(session.setConfig('mode', 'agent')).rejects.toBeInstanceOf(PermissionDenied);
    await expect(session.setConfig('mode', 'agent-full-access')).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    expect(via.configApplied.map((applied) => applied.value)).not.toContain('agent');
  });

  it('can widen the allowed modes by configuration, but never to a vetoed one', () => {
    const { adapter } = build({
      allowedModes: ['read-only', 'workspace-write', 'permission-profile:ci'],
    });
    expect(adapter.configOptionsFor({ model: 'm', mode: 'permission-profile:ci' }).mode).toBe(
      'permission-profile:ci',
    );
    expect(() => adapter.configOptionsFor({ model: 'm', mode: 'agent' })).toThrow(PermissionDenied);
  });
});

describe('CodexAdapter quota, login and the catalog', () => {
  it('has an honest quota probe that arrives in Phase 5', async () => {
    const { adapter } = build();
    expect(adapter.quota.implements.port).toBe('QuotaProbe');
    expect(adapter.quota.capabilities()).toEqual({
      windows: [],
      delivery: 'poll',
      precision: 'approximate',
    });
    await expect(adapter.quota.read({ client: 'codex', profile: 'work' })).rejects.toThrow(
      /Phase 5/,
    );
    await expect(adapter.quota.read({ client: 'codex', profile: 'work' })).rejects.toBeInstanceOf(
      AdapterUnavailable,
    );
  });

  it('rejects login and logout with AdapterUnavailable, pointing at Phase 5', async () => {
    const { adapter } = build();
    await expect(adapter.login()).rejects.toThrow(/Phase 5/);
    await expect(adapter.logout()).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('lists the models from the options it was given', async () => {
    const { adapter } = build({ modelSource: () => Promise.resolve(CONFIG_OPTIONS) });
    expect(
      (await adapter.models.list({ client: 'codex', profile: 'work' })).map((m) => m.id),
    ).toEqual(['model-a', 'model-b']);
  });
});

describe('CodexAdapter conformance probes', () => {
  it('passes when the session is in the pinned mode', async () => {
    const { adapter } = build({ readSessionMode: () => Promise.resolve('workspace-write') });
    const report = await adapter.checkConformance(await profileIn());
    expect(report.ok).toBe(true);
    expect(report.adapterVersion).toBe('2.6.0');
    expect(report.probes.map((probe) => probe.id)).toEqual([
      MODE_VETO_PROBE_ID,
      PINNED_MODE_PROBE_ID,
    ]);
  });

  it('fails when the client left the session in agent', async () => {
    const { adapter } = build({ readSessionMode: () => Promise.resolve('agent') });
    const report = await adapter.checkConformance(await profileIn());
    expect(report.ok).toBe(false);
    const pinned = report.probes.find((probe) => probe.id === PINNED_MODE_PROBE_ID);
    expect(pinned).toMatchObject({ ok: false });
    expect(pinned?.detail).toContain('agent');
    expect(report.probes.find((probe) => probe.id === MODE_VETO_PROBE_ID)?.ok).toBe(true);
  });

  it('fails honestly when no way to read the mode was configured', async () => {
    const { adapter } = build();
    const report = await adapter.checkConformance(await profileIn());
    expect(report.probes.find((probe) => probe.id === PINNED_MODE_PROBE_ID)).toMatchObject({
      ok: false,
    });
    expect(report.probes.find((probe) => probe.id === MODE_VETO_PROBE_ID)).toMatchObject({
      ok: true,
    });
  });

  it('fails when the client does not say the mode', async () => {
    const { adapter } = build({ readSessionMode: () => Promise.resolve(undefined) });
    const report = await adapter.checkConformance(await profileIn());
    expect(report.ok).toBe(false);
  });
});
