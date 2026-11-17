// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type {
  ClientAdapterWarning,
  ConformanceCache,
  ConformanceProbe,
} from './client-adapter-base.js';
import {
  AdapterUnavailable,
  InvalidInput,
  NotFound,
  PermissionDenied,
  QuotaExhausted,
} from './errors.js';
import type { PermissionRequest } from './ports/agent-session.js';
import {
  ROLE_POLICY_FIELDS,
  type ConformanceReport,
  type Enforcement,
  type RolePolicy,
} from './ports/client-adapter.js';
import type { Profile } from './ports/executor.js';
import {
  FakeClientAdapter,
  FakeProcessLauncher,
  FakeSessionTransport,
  type FakeClientAdapterOptions,
} from './testing/index.js';

const profile: Profile = { client: 'fake', profile: 'p', id: 'fake/p', dir: '/profiles/fake/p' };
const policy: RolePolicy = {
  nativeTools: ['read'],
  nativeShell: 'none',
  mcpServers: [],
  mcpTools: {},
  onAsk: 'reject',
  bypass: 'forbidden',
  writeScope: 'worktree',
  network: { allow: [] },
};

function enforcementWith(layers: Partial<Enforcement>): Enforcement {
  return {
    ...Object.fromEntries(ROLE_POLICY_FIELDS.map((field) => [field, ['client']])),
    ...layers,
  } as unknown as Enforcement;
}

function setup(options: Partial<FakeClientAdapterOptions> = {}) {
  const launcher = new FakeProcessLauncher();
  const warnings: ClientAdapterWarning[] = [];
  const adapter = new FakeClientAdapter({
    launcher,
    baseEnv: { PATH: '/bin', FROM_BASE: 'base' },
    adapterVersion: '1.0.0',
    command: { cmd: 'fake-client', args: ['--acp'] },
    onWarning: (warning) => warnings.push(warning),
    ...options,
  });
  return { adapter, launcher, warnings };
}

function permissionRequest(
  ...kinds: PermissionRequest['options'][number]['kind'][]
): PermissionRequest {
  return {
    toolCallId: 't',
    title: 'x',
    toolKind: 'edit',
    options: kinds.map((kind) => ({ optionId: kind, name: kind, kind })),
  };
}

/** The base's `answerPermission` is protected; a test reaches it through what the transport sees. */
async function answerOf(request: PermissionRequest, p: RolePolicy = policy) {
  const { adapter } = setup();
  const via = new FakeSessionTransport();
  await adapter.openSession(profile, p, '/work', via);
  const opened = via.opened[0];
  if (opened === undefined) throw new Error('not opened');
  return opened.onPermission(request);
}

describe('ClientAdapter.answerPermission', () => {
  it('prefers reject_once', async () => {
    await expect(
      answerOf(permissionRequest('allow_once', 'reject_always', 'reject_once')),
    ).resolves.toEqual({ outcome: 'selected', optionId: 'reject_once' });
  });

  it('falls back to reject_always', async () => {
    await expect(answerOf(permissionRequest('allow_always', 'reject_always'))).resolves.toEqual({
      outcome: 'selected',
      optionId: 'reject_always',
    });
  });

  it('cancels when nothing refuses, and never selects an allow option', async () => {
    await expect(answerOf(permissionRequest('allow_once', 'allow_always'))).resolves.toEqual({
      outcome: 'cancelled',
    });
    await expect(answerOf(permissionRequest())).resolves.toEqual({ outcome: 'cancelled' });
  });

  it('cancels for an onAsk value it does not know', async () => {
    const odd = { ...policy, onAsk: 'allow' } as unknown as RolePolicy;
    await expect(answerOf(permissionRequest('reject_once'), odd)).resolves.toEqual({
      outcome: 'cancelled',
    });
  });
});

describe('ClientAdapter.guarantee', () => {
  it('counts the client layer and the OS layer per field', () => {
    const { adapter } = setup({ minLayers: { default: 1, network: 2 } });
    const report = adapter.guarantee(policy, { fields: ['network'] });
    expect(report.fields.network).toEqual({ layers: ['client', 'os'], required: 2, ok: true });
    expect(report.fields.nativeTools).toEqual({ layers: ['client'], required: 1, ok: true });
    expect(report.ok).toBe(true);
    expect(report.short).toEqual([]);
  });

  it('points at the fields short of layers', () => {
    const { adapter } = setup({
      enforcement: enforcementWith({ network: [] }),
      minLayers: { default: 1 },
    });
    const report = adapter.guarantee(policy, { fields: [] });
    expect(report.ok).toBe(false);
    expect(report.short).toEqual(['network']);
    const withOs = adapter.guarantee(policy, { fields: ['network'] });
    expect(withOs.ok).toBe(true);
  });

  it('counts the daemon layer only for onAsk and bypass, and each layer once', () => {
    const { adapter } = setup({
      enforcement: enforcementWith({
        onAsk: ['client', 'daemon', 'daemon'],
        nativeTools: ['daemon'],
        network: ['os'],
      }),
      minLayers: { default: 1, onAsk: 2 },
    });
    const report = adapter.guarantee(policy, { fields: ['network'] });
    expect(report.fields.onAsk.layers).toEqual(['client', 'daemon']);
    expect(report.fields.onAsk.ok).toBe(true);
    expect(report.fields.nativeTools.layers).toEqual([]);
    expect(report.short).toContain('nativeTools');
    expect(report.fields.network.layers).toEqual(['os']);
  });
});

describe('ClientAdapter.guarantee with the policy of version 2 (Phase 4, P1)', () => {
  const v2: RolePolicy = {
    ...policy,
    nativeShell: 'shells',
    mcpServers: ['otheater'],
    mcpTools: { otheater: ['submit', 'run_tests'] },
    network: { allow: ['example.com'] },
  };

  it('counts the daemon layer for mcpTools, because the daemon filters the tool list of the grant', () => {
    const { adapter } = setup({
      enforcement: enforcementWith({ mcpTools: ['client', 'daemon'] }),
      minLayers: { default: 1, mcpTools: 2 },
    });
    const report = adapter.guarantee(v2, { fields: [] });
    expect(report.fields.mcpTools).toEqual({ layers: ['client', 'daemon'], required: 2, ok: true });
  });

  it('is short on mcpTools when the client alone guarantees it and two layers are required', () => {
    const { adapter } = setup({ minLayers: { default: 1, mcpTools: 2 } });
    const report = adapter.guarantee(v2, { fields: [] });
    expect(report.fields.mcpTools).toEqual({ layers: ['client'], required: 2, ok: false });
    expect(report.short).toEqual(['mcpTools']);
    expect(report.ok).toBe(false);
  });

  it('the shells and the network domains stay with the layers of their fields (the OS covers the network)', () => {
    const { adapter } = setup({ minLayers: { default: 1, network: 2, nativeShell: 2 } });
    const without = adapter.guarantee(v2, { fields: [] });
    expect(without.short).toEqual(['nativeShell', 'network']);
    const withOs = adapter.guarantee(v2, { fields: ['network', 'nativeShell'] });
    expect(withOs.ok).toBe(true);
    expect(withOs.fields.network.layers).toEqual(['client', 'os']);
  });

  it('a policy of version 2 with onAsk rules gets the same report, and the field stays onAsk', () => {
    const { adapter } = setup();
    const rules: RolePolicy = { ...v2, onAsk: 'rules' };
    expect(adapter.guarantee(rules, { fields: [] })).toEqual(adapter.guarantee(v2, { fields: [] }));
  });
});

describe('ClientAdapter.openSession', () => {
  it('prepares the profile, launches with base + profile environment and hands everything to the transport', async () => {
    const { adapter, launcher } = setup({ env: { PROFILE_VAR: 'p', FROM_BASE: 'override' } });
    const via = new FakeSessionTransport();
    const session = await adapter.openSession(profile, policy, '/work', via);
    expect(adapter.prepared).toEqual([profile]);
    const process = launcher.launched[0];
    expect(process?.options).toMatchObject({
      cmd: 'fake-client',
      args: ['--acp'],
      cwd: '/work',
      env: { PATH: '/bin', FROM_BASE: 'override', PROFILE_VAR: 'p' },
    });
    expect(via.opened).toHaveLength(1);
    expect(via.opened[0]).toMatchObject({ cwd: '/work', mcpServers: [] });
    expect(via.opened[0]?.setup).toEqual({ via: 'acp', configOptions: {} });
    expect(session.sessionId).toMatch(/^fake-session-/);
    await session.close();
    expect(launcher.running).toEqual([]);
  });

  it('hands the launch to the launchWrapper (layer 3) and starts what it returns, in openSession and launchSpec', async () => {
    const seen: { cwd: string; via: string; cmd: string; policy: RolePolicy; profile: Profile }[] =
      [];
    const { adapter, launcher } = setup({
      launchWrapper: (input) => {
        seen.push({
          cwd: input.cwd,
          via: input.via,
          cmd: input.spec.cmd,
          policy: input.policy,
          profile: input.profile,
        });
        return Promise.resolve({
          cmd: 'bwrap',
          args: ['--', input.spec.cmd, ...input.spec.args],
          cwd: input.spec.cwd,
          env: input.spec.env,
        });
      },
    });
    const session = await adapter.openSession(profile, policy, '/work', new FakeSessionTransport());
    expect(launcher.launched[0]?.options).toMatchObject({
      cmd: 'bwrap',
      args: ['--', 'fake-client', '--acp'],
      cwd: '/work',
      env: { PATH: '/bin', FROM_BASE: 'base' },
    });
    const spec = await adapter.launchSpec(profile, policy, '/work');
    expect(spec).toMatchObject({ cmd: 'bwrap', args: ['--', 'fake-client', '--acp'] });
    expect(seen).toEqual([
      { cwd: '/work', via: 'fake', cmd: 'fake-client', policy, profile },
      { cwd: '/work', via: 'acp', cmd: 'fake-client', policy, profile },
    ]);
    await session.close();
  });

  it('a launchWrapper that rejects fails the open and leaves no process', async () => {
    const { adapter, launcher } = setup({
      launchWrapper: () => Promise.reject(new AdapterUnavailable('no sandbox here')),
    });
    await expect(
      adapter.openSession(profile, policy, '/work', new FakeSessionTransport()),
    ).rejects.toBeInstanceOf(AdapterUnavailable);
    expect(launcher.launched).toEqual([]);
  });

  it('asks the transport for the headless setup when it is the headless one', async () => {
    const { adapter } = setup();
    const via = new FakeSessionTransport({ id: 'headless' });
    await (await adapter.openSession(profile, policy, '/work', via)).close();
    expect(via.opened[0]?.setup.via).toBe('headless');
  });

  it('ends the process tree and rethrows a typed error when the transport fails', async () => {
    const { adapter, launcher } = setup();
    const via = new FakeSessionTransport();
    via.failWith = new AdapterUnavailable('no answer');
    await expect(adapter.openSession(profile, policy, '/work', via)).rejects.toBe(via.failWith);
    expect(launcher.running).toEqual([]);
    expect(launcher.launched[0]?.killTreeCalls).toBe(1);
  });

  it('wraps an untyped failure of the transport in AdapterUnavailable', async () => {
    const { adapter, launcher } = setup();
    const via = new FakeSessionTransport();
    via.failWith = new Error('weird');
    const error = await adapter.openSession(profile, policy, '/work', via).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterUnavailable);
    expect((error as AdapterUnavailable).cause).toBe(via.failWith);
    expect(launcher.running).toEqual([]);
  });

  it('rejects when the launcher fails, with nothing left behind', async () => {
    const { adapter, launcher } = setup();
    launcher.failWith = new Error('ENOENT');
    await expect(
      adapter.openSession(profile, policy, '/work', new FakeSessionTransport()),
    ).rejects.toBeInstanceOf(AdapterUnavailable);
    expect(launcher.launched).toEqual([]);
  });

  it('gives every session of a process-per-session client its own process', async () => {
    const { adapter, launcher } = setup();
    const via = new FakeSessionTransport();
    const first = await adapter.openSession(profile, policy, '/work', via);
    const second = await adapter.openSession(profile, policy, '/work', via);
    expect(launcher.launched).toHaveLength(2);
    await first.close();
    expect(launcher.running).toHaveLength(1);
    await second.close();
    expect(launcher.running).toEqual([]);
  });

  it('refuses named MCP servers without a resolver and resolves them with one', async () => {
    const withNames: RolePolicy = { ...policy, mcpServers: ['docs'] };
    const bare = setup();
    await expect(
      bare.adapter.openSession(profile, withNames, '/work', new FakeSessionTransport()),
    ).rejects.toBeInstanceOf(InvalidInput);
    expect(bare.launcher.launched).toEqual([]);

    const resolved = setup({
      resolveMcpServers: (names) =>
        names.map((name) => ({ name, url: `http://127.0.0.1/${name}` })),
    });
    const via = new FakeSessionTransport();
    await (await resolved.adapter.openSession(profile, withNames, '/work', via)).close();
    expect(via.opened[0]?.mcpServers).toEqual([{ name: 'docs', url: 'http://127.0.0.1/docs' }]);
  });

  it('takes the MCP servers of one session from the options, without a resolver', async () => {
    const withNames: RolePolicy = { ...policy, mcpServers: ['otheater'] };
    const ref = {
      name: 'otheater',
      url: 'http://127.0.0.1:4000/mcp',
      headers: { Authorization: 'Bearer t' },
    };
    const { adapter, launcher } = setup();
    const via = new FakeSessionTransport();
    const first = await adapter.openSession(profile, withNames, '/work', via, {
      mcpServers: [ref],
    });
    expect(via.opened[0]?.mcpServers).toEqual([ref]);
    // A reload (`session/load`) gets them too.
    await (
      await adapter.loadSession(profile, withNames, '/work', first.sessionId, via, {
        mcpServers: [ref],
      })
    ).close();
    await first.close();
    expect(via.loaded[0]?.mcpServers).toEqual([ref]);

    // A ref outside the policy is refused before anything starts.
    const before = launcher.launched.length;
    await expect(
      adapter.openSession(profile, policy, '/work', new FakeSessionTransport(), {
        mcpServers: [ref],
      }),
    ).rejects.toBeInstanceOf(InvalidInput);
    expect(launcher.launched).toHaveLength(before);
  });

  it('mixes the resolver and the options: the names the options do not cover are resolved', async () => {
    const both: RolePolicy = { ...policy, mcpServers: ['docs', 'otheater'] };
    const ref = { name: 'otheater', url: 'http://127.0.0.1:4000/mcp' };
    const { adapter } = setup({
      resolveMcpServers: (names) =>
        names.map((name) => ({ name, url: `http://127.0.0.1/${name}` })),
    });
    const via = new FakeSessionTransport();
    await (await adapter.openSession(profile, both, '/work', via, { mcpServers: [ref] })).close();
    expect(via.opened[0]?.mcpServers).toEqual([
      { name: 'docs', url: 'http://127.0.0.1/docs' },
      ref,
    ]);
  });
});

describe('ClientAdapter security.unenforced', () => {
  const short = { enforcement: enforcementWith({ network: [] }) };

  it('refuses by default', async () => {
    const { adapter, launcher } = setup(short);
    await expect(
      adapter.openSession(profile, policy, '/work', new FakeSessionTransport()),
    ).rejects.toBeInstanceOf(PermissionDenied);
    expect(launcher.launched).toEqual([]);
    expect(adapter.prepared).toEqual([]);
  });

  it('warns and goes on with warn', async () => {
    const { adapter, warnings } = setup({ ...short, unenforced: 'warn' });
    await (await adapter.openSession(profile, policy, '/work', new FakeSessionTransport())).close();
    expect(warnings).toEqual([{ kind: 'unenforced', clientId: 'fake', short: ['network'] }]);
  });

  it('goes on in silence with allow', async () => {
    const { adapter, warnings } = setup({ ...short, unenforced: 'allow' });
    await (await adapter.openSession(profile, policy, '/work', new FakeSessionTransport())).close();
    expect(warnings).toEqual([]);
  });

  it('a throwing hook does not break the open', async () => {
    const { adapter } = setup({
      ...short,
      unenforced: 'warn',
      onWarning: () => {
        throw new Error('hook');
      },
    });
    await (await adapter.openSession(profile, policy, '/work', new FakeSessionTransport())).close();
  });
});

describe('ClientAdapter security.catalog_probe', () => {
  const short = { enforcement: enforcementWith({ network: [] }) };
  const probe = { purpose: 'catalog-probe' } as const;

  it('exempts a catalog session from refuse by default, warns, and runs nothing', async () => {
    const { adapter, launcher, warnings } = setup(short);
    const via = new FakeSessionTransport();
    const session = await adapter.openSession(profile, policy, '/work', via, probe);
    expect(warnings).toEqual([
      { kind: 'catalog_probe_exempt', clientId: 'fake', short: ['network'] },
    ]);
    expect(session.configOptions.length).toBeGreaterThan(0);
    await expect(session.prompt([{ type: 'text', text: 'hello' }])).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    await expect(session.setConfig('model', 'fake-model-2')).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    // Nothing reached the client: no turn started, no config changed.
    expect(via.configApplied).toEqual([]);
    await session.close();
    expect(launcher.running).toHaveLength(0);
  });

  it('never exempts a work session, with or without the purpose spelled out', async () => {
    const { adapter, launcher } = setup(short);
    for (const options of [undefined, { purpose: 'work' } as const]) {
      await expect(
        adapter.openSession(profile, policy, '/work', new FakeSessionTransport(), options),
      ).rejects.toBeInstanceOf(PermissionDenied);
    }
    expect(launcher.launched).toEqual([]);
  });

  it('refuse: the catalog session goes through the check like any other', async () => {
    const { adapter, launcher, warnings } = setup({ ...short, catalogProbe: 'refuse' });
    await expect(
      adapter.openSession(profile, policy, '/work', new FakeSessionTransport(), probe),
    ).rejects.toBeInstanceOf(PermissionDenied);
    expect(launcher.launched).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('stays quiet when the policy is guaranteed, and still gives a session that never prompts', async () => {
    const { adapter, warnings } = setup();
    const session = await adapter.openSession(
      profile,
      policy,
      '/work',
      new FakeSessionTransport(),
      probe,
    );
    expect(warnings).toEqual([]);
    await expect(session.prompt([{ type: 'text', text: 'hello' }])).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    await session.close();
  });

  it('applies to launchSpec, openSessionOn and loadSession as well', async () => {
    const { adapter, launcher, warnings } = setup(short);
    await expect(adapter.launchSpec(profile, policy, '/work')).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    const spec = await adapter.launchSpec(profile, policy, '/work', 'acp', 'catalog-probe');
    const process = await launcher.launch(spec);
    const via = new FakeSessionTransport();
    await expect(adapter.openSessionOn(process, policy, '/work', via)).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    const owned = await adapter.openSessionOn(process, policy, '/work', via, probe);
    await expect(owned.prompt([{ type: 'text', text: 'hello' }])).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    const loaded = await adapter.loadSession(profile, policy, '/work', owned.sessionId, via, probe);
    await expect(loaded.prompt([{ type: 'text', text: 'hello' }])).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    expect(warnings.filter((w) => w.kind === 'catalog_probe_exempt')).toHaveLength(3);
    await loaded.close();
    await process.killTree();
  });
});

describe('ClientAdapter multi-session', () => {
  function multi(options: Partial<FakeClientAdapterOptions> = {}) {
    return setup({ processModel: 'multi-session', ...options });
  }

  it('puts the sessions of one profile on one process, and ends it when the last one leaves', async () => {
    const { adapter, launcher } = multi();
    const via = new FakeSessionTransport();
    const first = await adapter.openSession(profile, policy, '/work/a', via);
    const second = await adapter.openSession(profile, policy, '/work/b', via);
    expect(launcher.launched).toHaveLength(1);
    expect(via.opened[0]?.process.stdin).toBe(via.opened[1]?.process.stdin);
    expect(via.opened.map((params) => params.cwd)).toEqual(['/work/a', '/work/b']);
    await first.close();
    expect(launcher.running).toHaveLength(1);
    expect(launcher.launched[0]?.killTreeCalls).toBe(0);
    await second.close();
    expect(launcher.running).toEqual([]);
    expect(launcher.launched[0]?.killTreeCalls).toBe(1);
  });

  it('cancel of one session does not end the process while another uses it', async () => {
    const { adapter, launcher } = multi();
    const via = new FakeSessionTransport();
    const first = await adapter.openSession(profile, policy, '/work', via);
    const second = await adapter.openSession(profile, policy, '/work', via);
    await first.cancel();
    expect(launcher.running).toHaveLength(1);
    await expect(first.prompt([{ type: 'text', text: 'x' }])).rejects.toBeInstanceOf(
      AdapterUnavailable,
    );
    const outcome = await second.prompt([{ type: 'text', text: 'still here' }]);
    expect(outcome.stopReason).toBe('end_turn');
    await second.close();
    expect(launcher.running).toEqual([]);
  });

  describe('shared_cancel', () => {
    const hang = [{ type: 'text' as const, text: '#script:hang\n' }];
    const deaf = [{ type: 'text' as const, text: '#script:deaf\n' }];

    async function trio(options: Partial<FakeClientAdapterOptions> = {}) {
      const rig = multi(options);
      const via = new FakeSessionTransport();
      const a = await rig.adapter.openSession(profile, policy, '/work', via);
      const b = await rig.adapter.openSession(profile, policy, '/work', via);
      const c = await rig.adapter.openSession(profile, policy, '/work', via);
      return { ...rig, a, b, c };
    }

    it('escalate (default): a cancel the client honours leaves the others alone', async () => {
      const { launcher, a, b } = await trio();
      const running = a.prompt(hang);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await a.cancel();
      await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
      expect(launcher.running).toHaveLength(1);
      await expect(b.prompt([{ type: 'text', text: 'ok' }])).resolves.toMatchObject({
        stopReason: 'end_turn',
      });
    });

    it('escalate: a cancel the client ignores kills the process; the others see AdapterUnavailable', async () => {
      const told: { pid: number; siblings: number }[] = [];
      const { launcher, a, b, c } = await trio({ onSharedCancel: (e) => told.push(e) });
      const running = a.prompt(deaf);
      const siblingTurn = b.prompt(deaf).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await a.cancel();
      await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
      expect(launcher.running).toHaveLength(0);
      expect(await siblingTurn).toBeInstanceOf(AdapterUnavailable);
      await expect(c.prompt([{ type: 'text', text: 'x' }])).rejects.toBeInstanceOf(
        AdapterUnavailable,
      );
      expect(told).toEqual([{ pid: launcher.launched[0]?.pid, siblings: 2 }]);
    });

    it('always_kill: a cancel the client honours still ends the process', async () => {
      const { launcher, a, b } = await trio({ sharedCancel: 'always_kill' });
      await a.cancel();
      expect(launcher.running).toHaveLength(0);
      await expect(b.prompt([{ type: 'text', text: 'x' }])).rejects.toBeInstanceOf(
        AdapterUnavailable,
      );
    });

    it('release: a cancel the client ignores leaves the process to the others', async () => {
      const { launcher, a, b, c } = await trio({ sharedCancel: 'release' });
      const running = a.prompt(deaf);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await a.cancel();
      await expect(running).resolves.toMatchObject({ stopReason: 'cancelled' });
      expect(launcher.running).toHaveLength(1);
      await expect(b.prompt([{ type: 'text', text: 'x' }])).resolves.toMatchObject({
        stopReason: 'end_turn',
      });
      await b.close();
      await c.close();
      expect(launcher.running).toHaveLength(0);
    });

    it('a process of its own is always ended by a cancel, in every mode', async () => {
      for (const sharedCancel of ['escalate', 'always_kill', 'release'] as const) {
        const { adapter, launcher } = multi({ sharedCancel, processReuse: 'own' });
        const via = new FakeSessionTransport();
        const a = await adapter.openSession(profile, policy, '/work', via);
        const b = await adapter.openSession(profile, policy, '/work', via);
        await a.cancel();
        expect(launcher.running).toHaveLength(1);
        await b.close();
      }
    });
  });

  it('does not join a process that is already killed, and a new session starts another', async () => {
    const { adapter, launcher } = multi();
    const via = new FakeSessionTransport();
    await (await adapter.openSession(profile, policy, '/work', via)).close();
    const again = await adapter.openSession(profile, policy, '/work', via);
    expect(launcher.launched).toHaveLength(2);
    await again.close();
  });

  it('starts another process above sessionsPerProcess', async () => {
    const { adapter, launcher } = multi({ sessionsPerProcess: 2 });
    const via = new FakeSessionTransport();
    const sessions = [];
    for (let i = 0; i < 5; i += 1) {
      sessions.push(await adapter.openSession(profile, policy, '/work', via));
    }
    expect(launcher.launched).toHaveLength(3);
    for (const session of sessions) await session.close();
    expect(launcher.running).toEqual([]);
  });

  it('shares nothing across profiles, and opens concurrently on one process', async () => {
    const { adapter, launcher } = multi();
    const via = new FakeSessionTransport();
    const other: Profile = { ...profile, profile: 'q', id: 'fake/q', dir: '/profiles/fake/q' };
    const opened = await Promise.all([
      adapter.openSession(profile, policy, '/work', via),
      adapter.openSession(profile, policy, '/work', via),
      adapter.openSession(other, policy, '/work', via),
    ]);
    expect(launcher.launched).toHaveLength(2);
    for (const session of opened) await session.close();
    expect(launcher.running).toEqual([]);
  });

  it('[proposta] does not share a process between two environments (the key includes the env)', async () => {
    let rules = 'deny';
    const { adapter, launcher } = multi({ env: () => ({ PERMISSION_RULES: rules }) });
    const via = new FakeSessionTransport();
    const first = await adapter.openSession(profile, policy, '/work', via);
    const sameRules = await adapter.openSession(profile, policy, '/work', via);
    rules = 'ask';
    const otherRules = await adapter.openSession(profile, policy, '/work', via);
    expect(launcher.launched.map((process) => process.options.env.PERMISSION_RULES)).toEqual([
      'deny',
      'ask',
    ]);
    expect(via.opened[0]?.process.stdin).toBe(via.opened[1]?.process.stdin);
    expect(via.opened[2]?.process.stdin).not.toBe(via.opened[0]?.process.stdin);
    for (const session of [first, sameRules, otherRules]) await session.close();
    expect(launcher.running).toEqual([]);
  });

  it('prepares the profile on every open, shared process or not', async () => {
    const { adapter } = multi();
    const via = new FakeSessionTransport();
    await adapter.openSession(profile, policy, '/work', via);
    await adapter.openSession(profile, policy, '/work', via);
    expect(adapter.prepared).toHaveLength(2);
  });

  it('{ process: "own" } and processReuse: "own" start a process for the session alone', async () => {
    const { adapter, launcher } = multi();
    const via = new FakeSessionTransport();
    const shared = await adapter.openSession(profile, policy, '/work', via);
    const own = await adapter.openSession(profile, policy, '/work', via, { process: 'own' });
    const joined = await adapter.openSession(profile, policy, '/work', via);
    expect(launcher.launched).toHaveLength(2);
    expect(via.opened[2]?.process.stdin).toBe(via.opened[0]?.process.stdin);
    await own.close();
    expect(launcher.running).toHaveLength(1);
    await shared.close();
    await joined.close();
    expect(launcher.running).toEqual([]);

    const always = multi({ processReuse: 'own' });
    const a = await always.adapter.openSession(profile, policy, '/work', via);
    const b = await always.adapter.openSession(profile, policy, '/work', via);
    expect(always.launcher.launched).toHaveLength(2);
    const c = await always.adapter.openSession(profile, policy, '/work', via, {
      process: 'shared',
    });
    const d = await always.adapter.openSession(profile, policy, '/work', via, {
      process: 'shared',
    });
    expect(always.launcher.launched).toHaveLength(3);
    for (const session of [a, b, c, d]) await session.close();
    expect(always.launcher.running).toEqual([]);
  });

  it('a process-per-session client ignores { process: "shared" }', async () => {
    const { adapter, launcher } = setup();
    const via = new FakeSessionTransport();
    const a = await adapter.openSession(profile, policy, '/work', via, { process: 'shared' });
    const b = await adapter.openSession(profile, policy, '/work', via, { process: 'shared' });
    expect(launcher.launched).toHaveLength(2);
    await a.close();
    await b.close();
  });

  it('the death of the process takes every session down with AdapterUnavailable', async () => {
    const { adapter, launcher } = multi();
    const via = new FakeSessionTransport();
    const first = await adapter.openSession(profile, policy, '/work', via);
    const second = await adapter.openSession(profile, policy, '/work', via);
    const hanging = [first, second].map((session) =>
      session.prompt([{ type: 'text', text: '#script:hang' }]).catch((error: unknown) => error),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    launcher.launched[0]?.exit(137, 'SIGKILL');
    const errors = await Promise.all(hanging);
    for (const error of errors) expect(error).toBeInstanceOf(AdapterUnavailable);
    for (const session of [first, second]) {
      await expect(session.prompt([{ type: 'text', text: 'x' }])).rejects.toBeInstanceOf(
        AdapterUnavailable,
      );
    }
    // A session opened after the death starts a fresh process.
    const next = await adapter.openSession(profile, policy, '/work', via);
    expect(launcher.launched).toHaveLength(2);
    await next.close();
  });

  it('a failed open leaves the process to the sessions that use it', async () => {
    const { adapter, launcher } = multi();
    const via = new FakeSessionTransport();
    const first = await adapter.openSession(profile, policy, '/work', via);
    via.failWith = new AdapterUnavailable('no answer');
    await expect(adapter.openSession(profile, policy, '/work', via)).rejects.toBe(via.failWith);
    expect(launcher.running).toHaveLength(1);
    via.failWith = undefined;
    await first.close();
    expect(launcher.running).toEqual([]);
  });

  it('a failed open on a process of its own ends it, and the launch failure leaves no entry', async () => {
    const { adapter, launcher } = multi();
    const via = new FakeSessionTransport();
    via.failWith = new Error('boom');
    await expect(adapter.openSession(profile, policy, '/work', via)).rejects.toBeInstanceOf(
      AdapterUnavailable,
    );
    expect(launcher.running).toEqual([]);
    via.failWith = undefined;
    launcher.failWith = new Error('ENOENT');
    await expect(adapter.openSession(profile, policy, '/work', via)).rejects.toBeInstanceOf(
      AdapterUnavailable,
    );
    launcher.failWith = undefined;
    const ok = await adapter.openSession(profile, policy, '/work', via);
    await ok.close();
    expect(launcher.running).toEqual([]);
  });

  it('loads a conversation on the shared process too', async () => {
    const { adapter, launcher } = multi();
    const via = new FakeSessionTransport();
    const first = await adapter.openSession(profile, policy, '/work', via);
    const again = await adapter.loadSession(profile, policy, '/work', 'fake-session-1', via);
    expect(launcher.launched).toHaveLength(1);
    expect(again.sessionId).toBe('fake-session-1');
    await first.close();
    await again.close();
    expect(launcher.running).toEqual([]);
  });

  it('hands the extension handlers of the client to the transport', async () => {
    const handler = { method: '_otheater/fake/ping', handle: () => 'pong' };
    const { adapter } = multi({ extensions: [handler] });
    const via = new FakeSessionTransport();
    await (await adapter.openSession(profile, policy, '/work', via)).close();
    expect(via.opened[0]?.extensions).toEqual([handler]);
  });

  it('rejects a sessionsPerProcess that is not a positive integer', () => {
    expect(() => multi({ sessionsPerProcess: 0 })).toThrow(InvalidInput);
    expect(() => multi({ sessionsPerProcess: 1.5 })).toThrow(InvalidInput);
  });
});

describe('ClientAdapter.loadSession', () => {
  it('reloads a conversation through the transport', async () => {
    const { adapter } = setup();
    const via = new FakeSessionTransport();
    const first = await adapter.openSession(profile, policy, '/work', via);
    await first.close();
    const again = await adapter.loadSession(profile, policy, '/work', first.sessionId, via);
    expect(again.sessionId).toBe(first.sessionId);
    expect(via.loaded[0]?.sessionId).toBe(first.sessionId);
    await again.close();
  });

  it('rejects NotFound for a conversation the client does not have, and leaves no process', async () => {
    const { adapter, launcher } = setup();
    await expect(
      adapter.loadSession(profile, policy, '/work', 'nope', new FakeSessionTransport()),
    ).rejects.toBeInstanceOf(NotFound);
    expect(launcher.running).toEqual([]);
  });

  it('rejects when the client cannot load, without launching', async () => {
    const { adapter, launcher } = setup({ capabilities: { loadSession: false } });
    await expect(
      adapter.loadSession(profile, policy, '/work', 'fake-session-1', new FakeSessionTransport()),
    ).rejects.toBeInstanceOf(AdapterUnavailable);
    expect(launcher.launched).toEqual([]);
  });
});

describe('ClientAdapter.checkConformance', () => {
  function probe(id: string, ok: boolean, counter: { runs: number }): ConformanceProbe {
    return {
      id,
      run: () => {
        counter.runs += 1;
        return Promise.resolve({ ok, detail: ok ? 'fine' : 'broken' });
      },
    };
  }

  it('runs the common probes and its own, and reports them in order', async () => {
    const counter = { runs: 0 };
    const { adapter } = setup({
      commonProbes: [probe('common', true, counter)],
      probes: [probe('own', false, counter)],
    });
    const report = await adapter.checkConformance(profile);
    expect(report.adapterVersion).toBe('1.0.0');
    expect(report.ok).toBe(false);
    expect(report.probes.map((p) => [p.id, p.ok])).toEqual([
      ['common', true],
      ['own', false],
    ]);
  });

  it('on_version_change: probes once per version, also through a shared cache', async () => {
    const counter = { runs: 0 };
    const store = new Map<string, ConformanceReport>();
    const cache: ConformanceCache = {
      get: (version) => store.get(version),
      set: (version, report) => void store.set(version, report),
    };
    const options = { probes: [probe('p', true, counter)], conformanceCache: cache };
    const first = setup(options);
    await first.adapter.checkConformance(profile);
    await first.adapter.checkConformance(profile);
    expect(counter.runs).toBe(1);
    const restarted = setup(options);
    await restarted.adapter.checkConformance(profile);
    expect(counter.runs).toBe(1);
    const newVersion = setup({ ...options, adapterVersion: '2.0.0' });
    await newVersion.adapter.checkConformance(profile);
    expect(counter.runs).toBe(2);
  });

  it('every_start: once per instance, again on a new instance', async () => {
    const counter = { runs: 0 };
    const options = { probes: [probe('p', true, counter)], conformance: 'every_start' as const };
    const first = setup(options);
    await first.adapter.checkConformance(profile);
    await first.adapter.checkConformance(profile);
    expect(counter.runs).toBe(1);
    await setup(options).adapter.checkConformance(profile);
    expect(counter.runs).toBe(2);
  });

  it('off: runs nothing and reports success', async () => {
    const counter = { runs: 0 };
    const { adapter } = setup({ probes: [probe('p', false, counter)], conformance: 'off' });
    await expect(adapter.checkConformance(profile)).resolves.toEqual({
      adapterVersion: '1.0.0',
      ok: true,
      probes: [],
    });
    expect(counter.runs).toBe(0);
  });

  it('concurrent calls share one run', async () => {
    const counter = { runs: 0 };
    const { adapter } = setup({ probes: [probe('p', true, counter)] });
    const [a, b] = await Promise.all([
      adapter.checkConformance(profile),
      adapter.checkConformance(profile),
    ]);
    expect(a).toBe(b);
    expect(counter.runs).toBe(1);
  });

  it('a probe that throws fails the report, warns, and is tried again next time', async () => {
    let attempts = 0;
    const flaky: ConformanceProbe = {
      id: 'flaky',
      run: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('transient'))
          : Promise.resolve({ ok: true, detail: 'ok' });
      },
    };
    const { adapter, warnings } = setup({ probes: [flaky] });
    const first = await adapter.checkConformance(profile);
    expect(first.ok).toBe(false);
    expect(first.probes[0]?.detail).toContain('transient');
    expect(warnings.map((w) => w.kind)).toEqual(['conformance_probe_threw']);
    const second = await adapter.checkConformance(profile);
    expect(second.ok).toBe(true);
  });

  it('rejects duplicate probe ids', async () => {
    const counter = { runs: 0 };
    const { adapter } = setup({
      commonProbes: [probe('same', true, counter)],
      probes: [probe('same', true, counter)],
    });
    await expect(adapter.checkConformance(profile)).rejects.toBeInstanceOf(InvalidInput);
    expect(counter.runs).toBe(0);
  });
});

describe('ClientAdapter.configOptionsFor', () => {
  it('goes through the descendant mapConfig', () => {
    const { adapter } = setup();
    expect(adapter.configOptionsFor({ model: 'fake-model', mode: 'plan' })).toEqual({
      model: 'fake-model',
      mode: 'plan',
    });
  });
});

describe('ClientAdapter mode veto', () => {
  const veto = { vetoedModes: { plan: 'it skips layer 2' } } as const;

  it('refuses setConfig of a vetoed mode on the open session, before the client', async () => {
    const { adapter, launcher } = setup(veto);
    const via = new FakeSessionTransport();
    const session = await adapter.openSession(profile, policy, '/work', via);
    const refused = session.setConfig('mode', 'plan');
    await expect(refused).rejects.toBeInstanceOf(PermissionDenied);
    await expect(refused).rejects.toThrow(/fake: the mode plan is refused: it skips layer 2/);
    expect(via.configApplied).toEqual([]);
    // What the veto does not name goes through, the model and the other modes included.
    await session.setConfig('mode', 'default');
    await session.setConfig('model', 'fake-model-2');
    expect(via.configApplied).toEqual([
      { id: 'mode', value: 'default' },
      { id: 'model', value: 'fake-model-2' },
    ]);
    await session.close();
    expect(launcher.running).toEqual([]);
  });

  it('refuses a value that is not one mode id, and the mode marked by category', async () => {
    const { adapter } = setup(veto);
    const via = new FakeSessionTransport();
    const session = await adapter.openSession(profile, policy, '/work', via);
    await expect(session.setConfig('mode', true)).rejects.toBeInstanceOf(PermissionDenied);
    expect(session.configOptions.find((option) => option.id === 'mode')?.category).toBe('mode');
    await session.close();
  });

  it('refuses the initial mode of the setup without reaching the client, and leaves nothing', async () => {
    const { adapter, launcher } = setup({ ...veto, setupConfig: { mode: 'plan' } });
    const via = new FakeSessionTransport();
    await expect(adapter.openSession(profile, policy, '/work', via)).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    expect(via.opened).toEqual([]);
    expect(launcher.running).toEqual([]);
    await expect(adapter.loadSession(profile, policy, '/work', 's', via)).rejects.toBeInstanceOf(
      PermissionDenied,
    );
    expect(launcher.running).toEqual([]);
  });

  it('lets a setup mode that is not vetoed through', async () => {
    const { adapter } = setup({ ...veto, setupConfig: { mode: 'default' } });
    const via = new FakeSessionTransport();
    const session = await adapter.openSession(profile, policy, '/work', via);
    expect(via.opened[0]?.setup).toEqual({ via: 'acp', configOptions: { mode: 'default' } });
    await session.close();
  });

  it('refuses it in configOptionsFor too, and never calls mapConfig for a refused mode', () => {
    const { adapter } = setup(veto);
    expect(() => adapter.configOptionsFor({ model: 'fake-model', mode: 'plan' })).toThrow(
      PermissionDenied,
    );
    expect(adapter.configOptionsFor({ model: 'fake-model', mode: 'default' }).mode).toBe('default');
    expect(adapter.configOptionsFor({ model: 'fake-model' })).toEqual({ model: 'fake-model' });
  });

  it('covers the sessions of a shared process, the loaded ones and the catalog probe', async () => {
    const { adapter, launcher } = setup({ ...veto, processModel: 'multi-session' });
    const via = new FakeSessionTransport();
    const first = await adapter.openSession(profile, policy, '/work/a', via);
    const second = await adapter.openSession(profile, policy, '/work/b', via);
    const loaded = await adapter.loadSession(profile, policy, '/work/a', first.sessionId, via);
    expect(launcher.launched).toHaveLength(1);
    for (const session of [first, second, loaded]) {
      await expect(session.setConfig('mode', 'plan')).rejects.toBeInstanceOf(PermissionDenied);
    }
    expect(via.configApplied).toEqual([]);
    await first.close();
    await second.close();
    await loaded.close();
    // The probe session refuses every change anyway, and a veto does not turn that into another error.
    const probe = await adapter.openSession(profile, policy, '/work', via, {
      purpose: 'catalog-probe',
    });
    await expect(probe.setConfig('mode', 'plan')).rejects.toBeInstanceOf(PermissionDenied);
    await probe.close();
    expect(launcher.running).toEqual([]);
  });

  it('asks the descendant about the transport the session goes through', async () => {
    const { adapter } = setup({ ...veto, vetoVia: 'headless' });
    expect(adapter.configOptionsFor({ model: 'fake-model', mode: 'plan' }).mode).toBe('plan');
    expect(() =>
      adapter.configOptionsFor({ model: 'fake-model', mode: 'plan' }, 'headless'),
    ).toThrow(PermissionDenied);
    const acp = new FakeSessionTransport({ id: 'acp' });
    const onAcp = await adapter.openSession(profile, policy, '/work', acp);
    await onAcp.setConfig('mode', 'plan');
    await onAcp.close();
    const headless = new FakeSessionTransport({ id: 'headless' });
    const onHeadless = await adapter.openSession(profile, policy, '/work', headless);
    await expect(onHeadless.setConfig('mode', 'plan')).rejects.toBeInstanceOf(PermissionDenied);
    await onHeadless.close();
  });

  it('a bare list of modes gives a default reason', () => {
    const { adapter } = setup({ vetoedModes: ['plan'] });
    expect(() => adapter.configOptionsFor({ model: 'fake-model', mode: 'plan' })).toThrow(
      /the mode plan is refused: the fake client refuses it/,
    );
  });
});

describe('ClientAdapter.command', () => {
  it('receives the transport the session goes through, on open and on load', async () => {
    const { adapter } = setup();
    const acp = new FakeSessionTransport({ id: 'acp' });
    const headless = new FakeSessionTransport({ id: 'headless' });
    await (await adapter.openSession(profile, policy, '/work', acp)).close();
    await (await adapter.openSession(profile, policy, '/work', headless)).close();
    await (await adapter.loadSession(profile, policy, '/work', 'fake-session-1', acp)).close();
    expect(adapter.commandVia).toEqual(['acp', 'headless', 'acp']);
  });
});

describe('FakeSessionTransport scripts', () => {
  async function open() {
    const { adapter, launcher } = setup();
    const via = new FakeSessionTransport();
    const session = await adapter.openSession(profile, policy, '/work', via);
    return { session, via, launcher };
  }
  const text = (value: string) => [{ type: 'text' as const, text: value }];

  it('echoes, runs tool calls, refuses edits by the policy, and fails as scripted', async () => {
    const { session, via, launcher } = await open();
    const seen: string[] = [];
    session.onUpdate((update) => seen.push(update.kind));
    await expect(session.prompt(text('hello world'))).resolves.toEqual({ stopReason: 'end_turn' });
    await session.prompt(text('#script:tool-call'));
    await session.prompt(text('#script:edit-file {"path":"a.txt"}'));
    expect(via.permissionAnswers).toEqual([{ outcome: 'selected', optionId: 'reject' }]);
    expect(via.edits).toEqual([]);
    expect(seen).toContain('tool_call');
    await expect(session.prompt(text('#script:fail'))).rejects.toBeTruthy();
    await expect(session.prompt(text('#script:quota-signal'))).rejects.toBeInstanceOf(
      QuotaExhausted,
    );
    await session.close();
    expect(launcher.running).toEqual([]);
  });

  it('write-file edits without asking, so the policy has nothing to refuse', async () => {
    const { session, via } = await open();
    const seen: string[] = [];
    session.onUpdate((update) =>
      seen.push('status' in update ? `${update.kind}:${String(update.status)}` : update.kind),
    );
    await expect(session.prompt(text('#script:write-file {"path":"a.txt"}'))).resolves.toEqual({
      stopReason: 'end_turn',
    });
    expect(via.permissionRequests).toEqual([]);
    expect(via.edits).toEqual(['a.txt']);
    expect(seen).toEqual(['tool_call:in_progress', 'tool_call_update:completed']);
    await session.close();
  });

  it('hang ends with cancel and leaves no process', async () => {
    const { session, launcher } = await open();
    const turn = session.prompt(text('#script:hang'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.cancel();
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' });
    expect(launcher.running).toEqual([]);
  });

  it('accepts only the config options the client offers', async () => {
    const { session, via } = await open();
    await session.setConfig('model', 'fake-model-2');
    expect(via.configApplied).toEqual([{ id: 'model', value: 'fake-model-2' }]);
    await expect(session.setConfig('model', 'nope')).rejects.toBeInstanceOf(InvalidInput);
    await expect(session.setConfig('unknown', 'x')).rejects.toBeInstanceOf(InvalidInput);
    await session.close();
  });
});

describe('ClientAdapter, process owned by the caller (session pool)', () => {
  it('launchSpec writes the profile and builds the launch options without starting anything', async () => {
    const { adapter, launcher } = setup({ env: { FROM_PROFILE: 'profile' } });
    const spec = await adapter.launchSpec(profile, policy, '/work');
    expect(spec).toEqual({
      cmd: 'fake-client',
      args: ['--acp'],
      cwd: '/work',
      env: { PATH: '/bin', FROM_BASE: 'base', FROM_PROFILE: 'profile' },
    });
    expect(adapter.prepared).toEqual([profile]);
    expect(launcher.launched).toEqual([]);
  });

  it('launchSpec refuses a policy that is short of layers', async () => {
    const { adapter } = setup({ enforcement: enforcementWith({ onAsk: [] }) });
    await expect(adapter.launchSpec(profile, policy, '/work')).rejects.toBeInstanceOf(
      PermissionDenied,
    );
  });

  it('opens and reloads sessions on a process it did not start, and leaves it running', async () => {
    const { adapter, launcher } = setup({ processModel: 'multi-session' });
    const via = new FakeSessionTransport();
    const process = await launcher.launch(await adapter.launchSpec(profile, policy, '/work'));
    const first = await adapter.openSessionOn(process, policy, '/work', via);
    const second = await adapter.openSessionOn(process, policy, '/work', via);
    expect(via.opened.map((params) => params.process)).toEqual([process, process]);
    await first.close().catch(() => undefined);
    const again = await adapter.loadSessionOn(process, policy, '/work', second.sessionId, via);
    expect(again.sessionId).toBe(second.sessionId);
    expect(launcher.launched).toHaveLength(1);
  });

  it('a failed open on an owned process does not end it', async () => {
    const { adapter, launcher } = setup({ processModel: 'multi-session' });
    const via = new FakeSessionTransport();
    via.failWith = new Error('boom');
    const process = await launcher.launch(await adapter.launchSpec(profile, policy, '/work'));
    await expect(adapter.openSessionOn(process, policy, '/work', via)).rejects.toBeInstanceOf(
      AdapterUnavailable,
    );
    expect(launcher.running).toHaveLength(1);
  });

  it('loadSessionOn refuses a client that cannot reload', async () => {
    const { adapter, launcher } = setup({ capabilities: { loadSession: false } });
    const process = await launcher.launch(await adapter.launchSpec(profile, policy, '/work'));
    await expect(
      adapter.loadSessionOn(process, policy, '/work', 'x', new FakeSessionTransport()),
    ).rejects.toBeInstanceOf(AdapterUnavailable);
  });
});
