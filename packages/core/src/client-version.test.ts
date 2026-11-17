// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  isClientVersion,
  type ClientAdapterWarning,
  type ClientVersion,
  type ClientVersionOptions,
  type ConformanceCache,
  type ConformanceProbe,
} from './client-adapter-base.js';
import type { ConformanceReport, RolePolicy } from './ports/client-adapter.js';
import type { Profile } from './ports/executor.js';
import {
  FakeClientAdapter,
  FakeProcessLauncher,
  FakeSessionTransport,
  type FakeClientAdapterOptions,
} from './testing/index.js';

// N63: the version of the client the base keys the conformance cache by, and the `initialize`
// that confirms or corrects it.

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

const compose = (clientVersion: string): string => `0.1.0+fake.${clientVersion}`;

function versioning(initial: ClientVersion, confirmByInitialize: boolean): ClientVersionOptions {
  return { initial, confirmByInitialize, adapterVersionOf: compose };
}

function setup(
  clientVersion: ClientVersionOptions | undefined,
  options: Partial<FakeClientAdapterOptions> = {},
) {
  const warnings: ClientAdapterWarning[] = [];
  const adapter = new FakeClientAdapter({
    launcher: new FakeProcessLauncher(),
    baseEnv: {},
    adapterVersion: clientVersion === undefined ? '1.0.0' : compose(clientVersion.initial.version),
    ...(clientVersion === undefined ? {} : { clientVersion }),
    command: { cmd: 'fake-client', args: [] },
    onWarning: (warning) => warnings.push(warning),
    ...options,
  });
  return { adapter, warnings };
}

const open = (adapter: FakeClientAdapter, via: FakeSessionTransport) =>
  adapter.openSession(profile, policy, '/work', via);

const info = (version: string, name = 'fake-acp') => ({ name, version });

describe('the client version of the base', () => {
  it('is unknown, and the adapter version is the given string, without the option', async () => {
    const { adapter, warnings } = setup(undefined);
    expect(adapter.clientVersion).toEqual({ version: 'unknown', source: 'unknown' });
    expect(adapter.adapterVersion).toBe('1.0.0');
    // The client says a version: with no option the base does not listen.
    await open(adapter, new FakeSessionTransport({ agentInfo: info('9.9.9') }));
    expect(adapter.adapterVersion).toBe('1.0.0');
    expect(warnings).toEqual([]);
  });

  it('starts from the version it was given and keys the cache by it', () => {
    const { adapter } = setup(versioning({ version: '2.6.0', source: 'package_json' }, true));
    expect(adapter.clientVersion).toEqual({ version: '2.6.0', source: 'package_json' });
    expect(adapter.adapterVersion).toBe('0.1.0+fake.2.6.0');
  });

  it('keeps the version read when the initialize says the same', async () => {
    const { adapter, warnings } = setup(
      versioning({ version: '2.6.0', source: 'package_json' }, true),
    );
    await open(adapter, new FakeSessionTransport({ agentInfo: info('2.6.0') }));
    expect(adapter.clientVersion).toEqual({ version: '2.6.0', source: 'package_json' });
    expect(warnings).toEqual([]);
  });

  it('is corrected by a different version in the initialize, with one warning', async () => {
    const { adapter, warnings } = setup(
      versioning({ version: '2.6.0', source: 'package_json' }, true),
    );
    await open(adapter, new FakeSessionTransport({ agentInfo: info('2.7.1', 'codex-acp') }));
    expect(adapter.clientVersion).toEqual({ version: '2.7.1', source: 'initialize' });
    expect(adapter.adapterVersion).toBe('0.1.0+fake.2.7.1');
    expect(warnings).toEqual([
      {
        kind: 'client_version_corrected',
        clientId: 'fake',
        from: { version: '2.6.0', source: 'package_json' },
        to: { version: '2.7.1', source: 'initialize' },
        adapterVersion: '0.1.0+fake.2.7.1',
        agentName: 'codex-acp',
      },
    ]);
  });

  it('is filled in by the initialize when nothing knew it', async () => {
    const { adapter, warnings } = setup(
      versioning({ version: 'unknown', source: 'unknown' }, true),
    );
    await open(adapter, new FakeSessionTransport({ agentInfo: info('1.19.5', 'OpenCode') }));
    expect(adapter.clientVersion).toEqual({ version: '1.19.5', source: 'initialize' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ from: { source: 'unknown' }, to: { version: '1.19.5' } });
  });

  it('follows a later session that reports another version, and not the same one again', async () => {
    const { adapter, warnings } = setup(
      versioning({ version: 'unknown', source: 'unknown' }, true),
    );
    const via = new FakeSessionTransport({ agentInfo: info('1.0.0') });
    await open(adapter, via);
    await open(adapter, via);
    expect(warnings).toHaveLength(1);
    via.agentInfo = info('1.1.0');
    await open(adapter, via);
    expect(adapter.clientVersion.version).toBe('1.1.0');
    expect(warnings).toHaveLength(2);
  });

  it('loadSession listens to the initialize too', async () => {
    const { adapter } = setup(versioning({ version: 'unknown', source: 'unknown' }, true));
    await adapter.loadSession(
      profile,
      policy,
      '/work',
      'fake-session-1',
      new FakeSessionTransport({ agentInfo: info('3.0.0') }),
    );
    expect(adapter.clientVersion.version).toBe('3.0.0');
  });

  it('keeps the version when the client says nothing', async () => {
    const { adapter, warnings } = setup(
      versioning({ version: '2.6.0', source: 'package_json' }, true),
    );
    await open(adapter, new FakeSessionTransport());
    expect(adapter.clientVersion).toEqual({ version: '2.6.0', source: 'package_json' });
    expect(warnings).toEqual([]);
  });

  it('is never changed when it was written (config), whatever the client says', async () => {
    const { adapter, warnings } = setup(versioning({ version: '9.0.0', source: 'config' }, true));
    await open(adapter, new FakeSessionTransport({ agentInfo: info('2.7.1') }));
    expect(adapter.clientVersion).toEqual({ version: '9.0.0', source: 'config' });
    expect(adapter.adapterVersion).toBe('0.1.0+fake.9.0.0');
    expect(warnings).toEqual([]);
  });

  it('ignores the initialize when confirmByInitialize is off', async () => {
    const { adapter, warnings } = setup(
      versioning({ version: '2.6.0', source: 'package_json' }, false),
    );
    await open(adapter, new FakeSessionTransport({ agentInfo: info('2.7.1') }));
    expect(adapter.clientVersion).toEqual({ version: '2.6.0', source: 'package_json' });
    expect(warnings).toEqual([]);
  });

  it.each(['', '   ', 'has space', 'a'.repeat(65), '1.0\n2.0', '-1.0', 'v1;rm'])(
    'ignores the version %j of the initialize: it is not a version token',
    async (version) => {
      const { adapter, warnings } = setup(
        versioning({ version: '2.6.0', source: 'package_json' }, true),
      );
      await open(adapter, new FakeSessionTransport({ agentInfo: info(version) }));
      expect(adapter.clientVersion.version).toBe('2.6.0');
      expect(warnings).toEqual([]);
    },
  );

  it('trims the version the client reports', async () => {
    const { adapter } = setup(versioning({ version: 'unknown', source: 'unknown' }, true));
    await open(adapter, new FakeSessionTransport({ agentInfo: info(' 1.2.3 ') }));
    expect(adapter.clientVersion.version).toBe('1.2.3');
  });

  it('a hook that throws on the warning does not fail the open', async () => {
    const { adapter } = setup(versioning({ version: 'unknown', source: 'unknown' }, true), {
      onWarning: () => {
        throw new Error('hook broke');
      },
    });
    await expect(
      open(adapter, new FakeSessionTransport({ agentInfo: info('1.0.0') })),
    ).resolves.toBeDefined();
    expect(adapter.clientVersion.version).toBe('1.0.0');
  });

  it('the process pool path (openSessionOn) listens to it as well', async () => {
    const { adapter } = setup(versioning({ version: 'unknown', source: 'unknown' }, true));
    const launcher = new FakeProcessLauncher();
    const spec = await adapter.launchSpec(profile, policy, '/work');
    const process = await launcher.launch(spec);
    await adapter.openSessionOn(
      process,
      policy,
      '/work',
      new FakeSessionTransport({ agentInfo: info('4.0.0') }),
    );
    expect(adapter.clientVersion.version).toBe('4.0.0');
  });
});

describe('conformance probes and the corrected version', () => {
  function counting(counter: { runs: number }): ConformanceProbe {
    return {
      id: 'p',
      run: () => {
        counter.runs += 1;
        return Promise.resolve({ ok: true, detail: 'fine' });
      },
    };
  }

  it('on_version_change runs the probes again for the version the initialize gave', async () => {
    const counter = { runs: 0 };
    const store = new Map<string, ConformanceReport>();
    const cache: ConformanceCache = {
      get: (version) => store.get(version),
      set: (version, report) => void store.set(version, report),
    };
    const { adapter } = setup(versioning({ version: '2.6.0', source: 'package_json' }, true), {
      probes: [counting(counter)],
      conformanceCache: cache,
    });
    const first = await adapter.checkConformance(profile);
    expect(first.adapterVersion).toBe('0.1.0+fake.2.6.0');
    await adapter.checkConformance(profile);
    expect(counter.runs).toBe(1);

    // The first session says another version: the cached report is for the old one.
    await open(adapter, new FakeSessionTransport({ agentInfo: info('2.7.1') }));
    const second = await adapter.checkConformance(profile);
    expect(counter.runs).toBe(2);
    expect(second.adapterVersion).toBe('0.1.0+fake.2.7.1');
    await adapter.checkConformance(profile);
    expect(counter.runs).toBe(2);
    expect([...store.keys()].sort()).toEqual(['0.1.0+fake.2.6.0', '0.1.0+fake.2.7.1']);
  });

  it('does not run them again when the initialize confirms the version read', async () => {
    const counter = { runs: 0 };
    const { adapter } = setup(versioning({ version: '2.6.0', source: 'package_json' }, true), {
      probes: [counting(counter)],
    });
    await adapter.checkConformance(profile);
    await open(adapter, new FakeSessionTransport({ agentInfo: info('2.6.0') }));
    await adapter.checkConformance(profile);
    expect(counter.runs).toBe(1);
  });
});

describe('isClientVersion', () => {
  it.each(['1.2.3', '0.107.0', '1.19.5', '2.0.0-beta.1', '1.0.0+build.5', 'unknown', '7'])(
    'accepts %s',
    (value) => {
      expect(isClientVersion(value)).toBe(true);
    },
  );
  it.each(['', ' 1.0', '1 0', '.1', '/etc/passwd', 'a'.repeat(65)])('refuses %j', (value) => {
    expect(isClientVersion(value)).toBe(false);
  });
});
