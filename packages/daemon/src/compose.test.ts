// SPDX-License-Identifier: MPL-2.0
import { access, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  type Adapter,
  type Sandbox,
  type SandboxAvailability,
} from '@otheater/core';
import {
  FakeClock,
  FakeProcessLauncher,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  checkAdapterRange,
  chooseLauncher,
  compose,
  composeClock,
  type LauncherChoiceDeps,
} from './compose.js';
import { parseConfig } from './config.js';
import { buildDaemonRegistries } from './registries.js';
import { makeTempDataDir } from './test-helpers.js';

const adapter = (port: string, range: string): Adapter => ({
  id: 'x',
  implements: { port, range },
});

describe('checkAdapterRange', () => {
  it('accepts a range that covers the port version and reports what it saw', () => {
    expect(checkAdapterRange(adapter('Store', '^0.1.0'), 'Store', '0.1.0')).toEqual({
      port: 'Store',
      id: 'x',
      range: '^0.1.0',
      portVersion: '0.1.0',
    });
  });

  it('rejects an adapter for another port as InvalidInput', () => {
    expect(() => checkAdapterRange(adapter('Clock', '^0.1.0'), 'Store', '0.1.0')).toThrow(
      InvalidInput,
    );
  });

  it('rejects a range that is not semver as InvalidInput', () => {
    expect(() => checkAdapterRange(adapter('Store', 'banana'), 'Store', '0.1.0')).toThrow(
      InvalidInput,
    );
  });

  it('rejects a range that does not cover the version as AdapterUnavailable, naming both', () => {
    const run = (): unknown => checkAdapterRange(adapter('Store', '^0.2.0'), 'Store', '0.1.0');
    expect(run).toThrow(AdapterUnavailable);
    expect(run).toThrow(/Store version 0\.1\.0.*\^0\.2\.0/);
  });
});

describe('compose', () => {
  it('builds the real adapters from the defaults, records them and closes once', async () => {
    const tmp = await makeTempDataDir();
    try {
      const config = parseConfig(
        'adapters:\n  vault: encrypted-file\nvault:\n  scrypt: { N: 16384, r: 8, p: 1 }\nlog:\n  destination: file\n',
      );
      const composition = await compose(config, { dataDir: tmp.dir });
      expect(composition.adapters.map(({ port, id }) => `${port}:${id}`)).toEqual([
        'Clock:system',
        'SecretVault:encrypted-file',
        'Store:sqlite',
        'TelemetryStore:sqlite',
      ]);
      await access(join(tmp.dir, 'store.sqlite'));
      await access(join(tmp.dir, 'telemetry.sqlite'));
      await composition.close();
      await composition.close(); // memoized: no second close of the store
    } finally {
      await tmp.dispose();
    }
  });

  it('announces every append of the daemon through the event hub, validated or not (Phase 6, P2)', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(1000);
      const store = new InMemoryStore({ clock });
      const composition = await compose(parseConfig('api:\n  sse:\n    buffer_events: 7\n'), {
        dataDir: tmp.dir,
        events: { registry: buildDaemonRegistries().events, unknownType: 'reject' },
        overrides: { clock, store, vault: new InMemorySecretVault() },
      });
      const controller = new AbortController();
      const live = composition.eventHub.follow({ signal: controller.signal });
      const received: string[] = [];
      const reader = (async () => {
        for await (const event of live) {
          received.push(event.type);
          if (received.length === 2) break;
        }
      })();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const stopped = {
        type: 'daemon.stopped',
        schemaVersion: 1,
        payload: { reason: 'signal', uptimeMs: 1 },
      } as const;
      await composition.store.events.append(stopped);
      // The raw store (what `DaemonHandle.store` exposes) is announced too, with no validation.
      await composition.rawStore.events.append({ ...stopped, type: 'test.raw' });
      await reader;
      expect(received).toEqual(['daemon.stopped', 'test.raw']);
      expect(composition.eventHub.subscriberCount).toBe(0);
      controller.abort();
      await composition.close();
    } finally {
      await tmp.dispose();
    }
  });

  it('uses overrides instead of adapters and records them as override', async () => {
    const tmp = await makeTempDataDir();
    try {
      const clock = new FakeClock(1000);
      const store = new InMemoryStore({ clock });
      const closeSpy = vi.spyOn(store, 'close');
      const composition = await compose(parseConfig(''), {
        dataDir: tmp.dir,
        overrides: { clock, store, vault: new InMemorySecretVault(), telemetry: 'none' },
      });
      expect(composition.clock).toBe(clock);
      // The store the daemon uses is the override behind the event hub: same data, same close.
      await composition.store.events.append({ type: 'test.tick', schemaVersion: 1, payload: {} });
      await expect(store.events.lastId()).resolves.toBe(1);
      expect(composition.adapters.map((record) => record.id)).toEqual([
        'override',
        'override',
        'override',
      ]);
      await composition.close();
      await composition.close();
      expect(closeSpy).toHaveBeenCalledTimes(1);
      // An override replaces the adapter completely: no store file was created.
      await expect(access(join(tmp.dir, 'store.sqlite'))).rejects.toThrow();
    } finally {
      await tmp.dispose();
    }
  });

  it('names the full key when an adapter section has an unknown or bad value', async () => {
    const tmp = await makeTempDataDir();
    try {
      await expect(
        compose(parseConfig('store:\n  bogus: 1\n'), { dataDir: tmp.dir }),
      ).rejects.toThrow(/store\.bogus|store\..*bogus/);
      await expect(
        compose(parseConfig('store:\n  driver: nope\n'), { dataDir: tmp.dir }),
      ).rejects.toThrow(/store\.driver/);
    } finally {
      await tmp.dispose();
    }
  });
});

/** A sandbox that answers `availability` and counts what the daemon asks of it. */
function fakeSandbox(availability: SandboxAvailability): Sandbox & {
  asked: number;
  closed: number;
} {
  return {
    id: 'fake-sandbox',
    implements: { port: 'Sandbox', range: '^0.1.0' },
    asked: 0,
    closed: 0,
    capabilities() {
      return availability.ok ? { fields: ['writeScope', 'network'] } : { fields: [] };
    },
    available() {
      this.asked += 1;
      return Promise.resolve(availability);
    },
    wrap: () => Promise.reject(new AdapterUnavailable('not used here')),
    close() {
      this.closed += 1;
      return Promise.resolve();
    },
  };
}

describe('compose: the telemetry base (Phase 8, P1)', () => {
  async function composed(config: string, before?: (dir: string) => Promise<void>) {
    const tmp = await makeTempDataDir();
    await before?.(tmp.dir);
    const clock = new FakeClock(1000);
    const composition = await compose(parseConfig(config), {
      dataDir: tmp.dir,
      overrides: {
        clock,
        store: new InMemoryStore({ clock }),
        vault: new InMemorySecretVault(),
        sandbox: 'none',
      },
      events: { registry: buildDaemonRegistries().events, unknownType: 'reject' },
    });
    return { composition, dir: tmp.dir, dispose: tmp.dispose };
  }

  it('opens <data>/telemetry.sqlite by default and uses telemetry.file when set', async () => {
    const first = await composed('');
    try {
      expect(first.composition.telemetry).toBeDefined();
      await access(join(first.dir, 'telemetry.sqlite'));
      expect(first.composition.adapters.map((r) => r.port)).toContain('TelemetryStore');
    } finally {
      await first.composition.close();
      await first.dispose();
    }
    const second = await composed('telemetry:\n  file: sub/t.db\n');
    try {
      await access(join(second.dir, 'sub', 't.db'));
    } finally {
      await second.composition.close();
      await second.dispose();
    }
  });

  it('does not open a base with telemetry.enabled: off', async () => {
    const { composition, dir, dispose } = await composed('telemetry:\n  enabled: off\n');
    try {
      expect(composition.telemetry).toBeUndefined();
      expect(composition.telemetryBackup).toBeUndefined();
      await expect(access(join(dir, 'telemetry.sqlite'))).rejects.toThrow();
    } finally {
      await composition.close();
      await dispose();
    }
  });

  it('builds the projector of the spans of the daemon by default, and not with off or without a base', async () => {
    for (const [yaml, expected] of [
      ['', true],
      ['telemetry:\n  daemon_spans: off\n', false],
      ['telemetry:\n  enabled: off\n', false],
    ] as const) {
      const { composition, dispose } = await composed(yaml);
      try {
        expect(composition.daemonSpans !== undefined).toBe(expected);
      } finally {
        await composition.close();
        await dispose();
      }
    }
  });

  it('builds the writer of the waits by default (it needs no telemetry base), and not with events.wait_threshold: off', async () => {
    for (const [yaml, expected] of [
      ['', true],
      ['telemetry:\n  enabled: off\n', true],
      ['events:\n  wait_threshold: always\n', true],
      ['events:\n  wait_threshold: off\n', false],
    ] as const) {
      const { composition, dispose } = await composed(yaml);
      try {
        expect(composition.waitEvents !== undefined).toBe(expected);
      } finally {
        await composition.close();
        await dispose();
      }
    }
  });

  it('recreates a corrupted file and records telemetry.store_reset without a path', async () => {
    const { composition, dir, dispose } = await composed('', async (data) => {
      await writeFile(join(data, 'telemetry.sqlite'), Buffer.alloc(8192, 0x61));
    });
    try {
      composition.situations.open();
      await composition.situations.idle();
      const events = (await composition.store.events.readFrom(0, 1000)).filter(
        (event) => event.type === 'telemetry.store_reset',
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({
        reason: 'corrupt',
        outcome: 'recreated',
        brokenFile: expect.stringMatching(/^telemetry\.sqlite\.broken-\d{8}-\d{6}$/) as string,
        resets: 1,
      });
      expect((await readdir(dir)).some((name) => name.startsWith('telemetry.sqlite.broken-'))).toBe(
        true,
      );
      await expect(composition.telemetry?.health()).resolves.toMatchObject({
        state: 'ok',
        resets: 1,
      });
    } finally {
      await composition.close();
      await dispose();
    }
  });
});

describe('compose: layer 3 (the sandbox)', () => {
  async function composed(config: string, sandbox: Sandbox | 'none') {
    const tmp = await makeTempDataDir();
    const clock = new FakeClock(1000);
    const composition = await compose(parseConfig(config), {
      dataDir: tmp.dir,
      overrides: {
        clock,
        store: new InMemoryStore({ clock }),
        vault: new InMemorySecretVault(),
        sandbox,
      },
    });
    return { composition, dispose: tmp.dispose };
  }

  it('wires an available sandbox: capabilities for guarantee(), and closes it with the daemon', async () => {
    const sandbox = fakeSandbox({ ok: true });
    const { composition, dispose } = await composed('', sandbox);
    try {
      expect(composition.sandbox?.capabilities).toEqual({ fields: ['writeScope', 'network'] });
      await composition.close();
      expect(sandbox.closed).toBe(1);
    } finally {
      await dispose();
    }
  });

  it('runs without layer 3 when the sandbox says it does not work here', async () => {
    const sandbox = fakeSandbox({ ok: false, reason: 'no bubblewrap' });
    const { composition, dispose } = await composed('', sandbox);
    try {
      expect(composition.sandbox).toBeUndefined();
    } finally {
      await composition.close();
      await dispose();
    }
  });

  /** What the daemon wrote as `daemon.notice` after the sink opened (P24, N146). */
  async function noticesOf(composition: Awaited<ReturnType<typeof composed>>['composition']) {
    composition.situations.open();
    await composition.situations.idle();
    return (await composition.store.events.readFrom(0, 1000))
      .filter((event) => event.type === 'daemon.notice')
      .map((event) => event.payload);
  }

  it('daemon.notice sandbox_unavailable: the missing layer 3 is also an event, with the reason (P24, N146)', async () => {
    const sandbox = fakeSandbox({ ok: false, reason: 'no bubblewrap' });
    const { composition, dispose } = await composed('', sandbox);
    try {
      expect(await noticesOf(composition)).toEqual([
        { kind: 'sandbox_unavailable', subject: 'fake-sandbox', detail: 'no bubblewrap' },
      ]);
    } finally {
      await composition.close();
      await dispose();
    }
  });

  it('daemon.notice sandbox_nested: a Codex launch with inner_sandbox: nested is an event naming the worktree (P24, N146)', async () => {
    const sandbox = fakeSandbox({ ok: true });
    const { composition, dispose } = await composed(
      'clients:\n  codex:\n    inner_sandbox: nested\n',
      sandbox,
    );
    try {
      // The fake refuses to wrap: the warning comes before the wrap, which is what is under test.
      await composition.sandbox
        ?.launchWrapper()({
          profile: { client: 'codex', profile: 'a', id: 'codex/a', dir: '/data/profiles/codex/a' },
          policy: {
            nativeTools: ['read'],
            nativeShell: 'none',
            mcpServers: [],
            mcpTools: {},
            onAsk: 'reject',
            bypass: 'forbidden',
            writeScope: 'worktree',
            network: { allow: [] },
          },
          cwd: '/data/worktrees/w1',
          via: 'acp',
          spec: { cmd: 'codex-acp', args: [], cwd: '/data/worktrees/w1', env: {} },
        })
        .catch(() => undefined);
      expect(await noticesOf(composition)).toEqual([
        { kind: 'sandbox_nested', subject: 'codex', detail: '/data/worktrees/w1' },
      ]);
    } finally {
      await composition.close();
      await dispose();
    }
  });

  it('does not even ask the sandbox when sandbox.mode is off or the override is none', async () => {
    const sandbox = fakeSandbox({ ok: true });
    const off = await composed('sandbox:\n  mode: off\n', sandbox);
    const none = await composed('', 'none');
    try {
      expect(off.composition.sandbox).toBeUndefined();
      expect(none.composition.sandbox).toBeUndefined();
      expect(sandbox.asked).toBe(0);
    } finally {
      await off.composition.close();
      await none.composition.close();
      await off.dispose();
      await none.dispose();
    }
  });
});

describe('composeClock', () => {
  it('returns the override, or the system clock', () => {
    const fake = new FakeClock(7);
    expect(composeClock({ clock: fake })).toBe(fake);
    expect(Math.abs(composeClock().now() - Date.now())).toBeLessThan(5000);
  });
});

describe('chooseLauncher (processes.windows_launcher, Phase 10 P2)', () => {
  const FOUND = 'C:\\ot\\ot-job-launcher.exe';
  const exe = 'C:\\ot\\ot.exe';
  const win = (exists: readonly string[], extra: Partial<LauncherChoiceDeps> = {}) => {
    const built: string[] = [];
    const deps: LauncherChoiceDeps = {
      platform: 'win32',
      execPath: exe,
      checkoutRoots: [],
      exists: (path) => exists.includes(path),
      createWindows: (path) => {
        built.push(path);
        return new FakeProcessLauncher();
      },
      ...extra,
    };
    return { deps, built };
  };
  const settings = (config: string) => parseConfig(config).processes;

  it('has auto as the default and takes job_object, off and an absolute path', () => {
    expect(settings('')).toEqual({ windows_launcher: 'auto', windows_shims: 'resolve' });
    expect(
      settings(
        'processes:\n  windows_launcher: job_object\n  windows_launcher_path: D:\\x\\l.exe\n',
      ),
    ).toEqual({
      windows_launcher: 'job_object',
      windows_launcher_path: 'D:\\x\\l.exe',
      windows_shims: 'resolve',
    });
    expect(settings('processes:\n  windows_launcher: off\n').windows_launcher).toBe('off');
  });

  it('refuses an unknown mode, a relative path and an unknown key at start-up', () => {
    expect(() => parseConfig('processes:\n  windows_launcher: always\n')).toThrow(
      /windows_launcher/,
    );
    expect(() => parseConfig('processes:\n  windows_launcher_path: l.exe\n')).toThrow(
      /windows_launcher_path/,
    );
    expect(() => parseConfig('processes:\n  nope: 1\n')).toThrow(/nope/);
    expect(() => parseConfig('processes:\n  windows_shims: maybe\n')).toThrow(/windows_shims/);
  });

  it('windows_shims (resolve by default, or refuse) reaches the Windows launcher', () => {
    expect(settings('processes:\n  windows_shims: refuse\n').windows_shims).toBe('refuse');
    const modes: string[] = [];
    for (const config of ['', 'processes:\n  windows_shims: refuse\n']) {
      const { deps } = win([FOUND], {
        createWindows: (_path, shims) => {
          modes.push(shims);
          return new FakeProcessLauncher();
        },
      });
      chooseLauncher(settings(config), deps);
    }
    expect(modes).toEqual(['resolve', 'refuse']);
  });

  it('auto: uses the launcher beside the executable', () => {
    const { deps, built } = win([FOUND]);
    const choice = chooseLauncher(settings(''), deps);
    expect(choice.launcher).toBeDefined();
    expect(choice.fallback).toBeUndefined();
    expect(built).toEqual([FOUND]);
  });

  it('auto: without the file, runs without a launcher and says why (fallback)', () => {
    const { deps, built } = win([]);
    const choice = chooseLauncher(settings(''), deps);
    expect(choice.launcher).toBeUndefined();
    expect(choice.fallback).toMatch(/auto and ot-job-launcher\.exe was not found/);
    expect(choice.fallback).toContain(FOUND);
    expect(built).toEqual([]);
  });

  it('job_object: uses the file, and refuses to start without it', () => {
    const present = win([FOUND]);
    expect(
      chooseLauncher(settings('processes:\n  windows_launcher: job_object\n'), present.deps)
        .launcher,
    ).toBeDefined();
    const absent = win([]);
    expect(() =>
      chooseLauncher(settings('processes:\n  windows_launcher: job_object\n'), absent.deps),
    ).toThrow(expect.objectContaining({ code: 'ADAPTER_UNAVAILABLE' }) as Error);
  });

  it('off: no launcher, no search and no fallback notice', () => {
    const exists = vi.fn(() => true);
    const { deps, built } = win([FOUND], { exists });
    const choice = chooseLauncher(settings('processes:\n  windows_launcher: off\n'), deps);
    expect(choice).toEqual({ launcher: undefined });
    expect(exists).not.toHaveBeenCalled();
    expect(built).toEqual([]);
  });

  it('windows_launcher_path replaces the search', () => {
    const { deps, built } = win([FOUND, 'D:\\x\\l.exe']);
    chooseLauncher(settings('processes:\n  windows_launcher_path: D:\\x\\l.exe\n'), deps);
    expect(built).toEqual(['D:\\x\\l.exe']);
  });

  it('Linux and macOS: the process group, whatever the key says (it is not read there)', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      for (const mode of ['auto', 'job_object', 'off']) {
        const choice = chooseLauncher(settings(`processes:\n  windows_launcher: ${mode}\n`), {
          platform,
        });
        expect(choice.launcher?.capabilities().treeKill).toBe('process-group');
        expect(choice.fallback).toBeUndefined();
      }
    }
  });

  describe('compose', () => {
    async function composed(config: string, launcherDeps: LauncherChoiceDeps) {
      const tmp = await makeTempDataDir();
      const clock = new FakeClock(1000);
      const composition = await compose(parseConfig(config), {
        dataDir: tmp.dir,
        overrides: {
          clock,
          store: new InMemoryStore({ clock }),
          vault: new InMemorySecretVault(),
          sandbox: 'none',
          launcherDeps,
        },
      });
      return { composition, dispose: tmp.dispose };
    }
    const noticesOf = async (composition: Awaited<ReturnType<typeof composed>>['composition']) => {
      composition.situations.open();
      await composition.situations.idle();
      return (await composition.store.events.readFrom(0, 1000))
        .filter((event) => event.type === 'daemon.notice')
        .map((event) => event.payload);
    };

    it('auto without the launcher: the fall to none is a log line and a daemon.notice execution_off', async () => {
      const { composition, dispose } = await composed('', win([]).deps);
      try {
        expect(composition.launcher).toBeUndefined();
        expect(await noticesOf(composition)).toEqual([
          expect.objectContaining({
            kind: 'execution_off',
            subject: 'windows_launcher_not_found',
            detail: expect.stringContaining('ot-job-launcher.exe was not found') as string,
          }),
        ]);
      } finally {
        await composition.close();
        await dispose();
      }
    });

    it('auto with the launcher, and off: no notice', async () => {
      for (const [config, deps] of [
        ['', win([FOUND]).deps],
        ['processes:\n  windows_launcher: off\n', win([]).deps],
      ] as const) {
        const { composition, dispose } = await composed(config, deps);
        try {
          expect(await noticesOf(composition)).toEqual([]);
        } finally {
          await composition.close();
          await dispose();
        }
      }
    });

    it('job_object without the launcher: the composition fails', async () => {
      await expect(
        composed('processes:\n  windows_launcher: job_object\n', win([]).deps),
      ).rejects.toMatchObject({ code: 'ADAPTER_UNAVAILABLE' });
    });
  });
});
