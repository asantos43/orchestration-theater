// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AdapterUnavailable } from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecordingSituations } from '../test-helpers.js';
import { fixtureAdapter, startFakeRegistry, type FakeRegistry } from './adapter-fixture.js';
import { AdapterInstallError } from './install.js';
import {
  AdapterManager,
  isManagedClient,
  MANAGED_CLIENT_IDS,
  type AdapterManagerOptions,
} from './manager.js';

const LINUX = { os: 'linux', cpu: 'x64', libc: 'glibc' } as const;
const NODE = '/opt/node/bin/node';

let dir: string;
let registry: FakeRegistry | undefined;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ot-manager-'));
});

afterEach(async () => {
  await registry?.close();
  registry = undefined;
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

const found = (...commands: string[]) => {
  return (command: string): string | undefined =>
    commands.includes(command) ? `/usr/bin/${command}` : undefined;
};

interface Rig {
  manager: AdapterManager;
  situations: RecordingSituations;
  warnings: string[];
}

async function rig(options: Partial<AdapterManagerOptions> = {}, offline = false): Promise<Rig> {
  const adapter = fixtureAdapter();
  registry = await startFakeRegistry(adapter);
  const situations = new RecordingSituations();
  const warnings: string[] = [];
  const manager = new AdapterManager({
    adaptersDir: dir,
    install: 'auto',
    registry: registry.url,
    find: found('claude', 'codex'),
    platform: LINUX,
    self: { sea: false, execPath: NODE },
    lockOf: (id) => ({ ...adapter.lock, id }),
    installOptions: { retryDelayMs: 0, retries: 0 },
    situations,
    logger: {
      info: () => undefined,
      warn: (...args: unknown[]) => {
        warnings.push(String(args[1]));
      },
    },
    ...(offline ? { fetch: () => Promise.reject(new Error('offline')) } : {}),
    ...options,
  });
  return { manager, situations, warnings };
}

const kinds = (situations: RecordingSituations): string[] =>
  situations.of('daemon.notice').map((payload) => (payload as { kind: string }).kind);

describe('the managed clients', () => {
  it('are Claude Code and Codex; OpenCode speaks ACP by itself', () => {
    expect(MANAGED_CLIENT_IDS).toEqual(['claude-code', 'codex']);
    expect(isManagedClient('codex')).toBe(true);
    expect(isManagedClient('opencode')).toBe(false);
  });
});

describe('AdapterManager.status', () => {
  it('says missing, with the official client and the hand-installed adapter found in PATH', async () => {
    const { manager } = await rig({ find: found('claude', 'claude-agent-acp') });
    const status = manager.status('claude-code');
    expect(status).toMatchObject({
      client: 'claude-code',
      adapter: 'claude-agent-acp',
      version: '1.2.3',
      installed: false,
      installing: false,
      officialPath: '/usr/bin/claude',
      pathAdapter: '/usr/bin/claude-agent-acp',
      failure: undefined,
    });
    expect(status.dir.startsWith(dir)).toBe(true);
    expect(manager.status('codex').pathAdapter).toBeUndefined();
  });
});

describe('AdapterManager.officialEnv', () => {
  it('points the adapter at the official client found in PATH, never at a bundled copy', async () => {
    const { manager } = await rig({ find: found('claude') });
    expect(manager.officialEnv('claude-code')).toEqual({
      CLAUDE_CODE_EXECUTABLE: '/usr/bin/claude',
    });
    expect(manager.officialEnv('codex')).toEqual({});
  });
});

describe('AdapterManager.ensure', () => {
  it('installs the pinned adapter, tells it and then runs it with the Node that runs the daemon', async () => {
    const { manager, situations } = await rig();
    const result = await manager.ensure('claude-code');
    expect(result.entry).toContain(dir);
    const status = manager.status('claude-code');
    expect(status.installed).toBe(true);
    expect(kinds(situations)).toEqual(['adapter_installing', 'adapter_installed']);
    expect(manager.commandFor('claude-code', 'managed')).toEqual({
      cmd: NODE,
      args: [status.entry],
    });
  });

  it('runs the installed adapter through the executable itself in a single executable', async () => {
    const { manager } = await rig({ self: { sea: true, execPath: '/opt/ot/ot' } });
    await manager.ensure('codex');
    expect(manager.commandFor('codex', 'managed')).toEqual({
      cmd: '/opt/ot/ot',
      args: ['--ot-internal=run-adapter', manager.status('codex').entry],
    });
  });

  it('serves two calls at once with one download', async () => {
    const { manager } = await rig();
    const release = registry?.hold();
    const first = manager.ensure('claude-code');
    expect(manager.status('claude-code').installing).toBe(true);
    const second = manager.ensure('claude-code');
    expect(second).toBe(first);
    release?.();
    await Promise.all([first, second]);
    expect(registry?.requests.length).toBe(1);
    expect(manager.status('claude-code').installing).toBe(false);
  });

  it('remembers why it failed, tells it, and a later success clears it', async () => {
    const { manager, situations } = await rig({}, true);
    await expect(manager.ensure('claude-code')).rejects.toBeInstanceOf(AdapterInstallError);
    expect(manager.status('claude-code').failure).toBeDefined();
    expect(kinds(situations)).toEqual(['adapter_installing', 'adapter_install_failed']);
  });

  it('clears the failure after a good install', async () => {
    const adapter = fixtureAdapter();
    registry = await startFakeRegistry(adapter);
    const url = registry.url;
    let up = false;
    const manager = new AdapterManager({
      adaptersDir: dir,
      install: 'auto',
      registry: url,
      find: found('claude'),
      platform: LINUX,
      lockOf: (id) => ({ ...adapter.lock, id }),
      installOptions: { retryDelayMs: 0, retries: 0 },
      fetch: (input, init) =>
        up ? fetch(input, init) : Promise.reject(new Error('network is down')),
    });
    await expect(manager.ensure('claude-code')).rejects.toBeDefined();
    expect(manager.status('claude-code').failure).toContain('network is down');
    up = true;
    await manager.ensure('claude-code');
    expect(manager.status('claude-code')).toMatchObject({ installed: true, failure: undefined });
  });
});

describe('AdapterManager.commandFor', () => {
  it('takes an absolute path as it is', async () => {
    const { manager } = await rig();
    expect(manager.commandFor('codex', '/opt/my/codex-acp')).toEqual({
      cmd: '/opt/my/codex-acp',
      args: [],
    });
  });

  it('with "path" needs the adapter in PATH and says so otherwise', async () => {
    const { manager } = await rig({ find: found('codex-acp') });
    expect(manager.commandFor('codex', 'path')).toEqual({ cmd: 'codex-acp', args: [] });
    expect(() => manager.commandFor('claude-code', 'path')).toThrow(AdapterUnavailable);
    expect(() => manager.commandFor('claude-code', 'path')).toThrow(
      /claude-agent-acp is not in PATH/,
    );
  });

  it('refuses a value that is not managed, path or an absolute path', async () => {
    const { manager } = await rig();
    expect(() => manager.commandFor('codex', 'relative/codex-acp')).toThrow(AdapterUnavailable);
  });

  it('with "managed" and nothing installed falls back to PATH with a warning and one event', async () => {
    const { manager, situations, warnings } = await rig({
      find: found('claude', 'claude-agent-acp'),
    });
    expect(manager.commandFor('claude-code', 'managed')).toEqual({
      cmd: 'claude-agent-acp',
      args: [],
    });
    manager.commandFor('claude-code', 'managed');
    expect(kinds(situations)).toEqual(['adapter_fallback']);
    expect(warnings).toHaveLength(1);
  });

  it('with "managed", nothing installed and nothing in PATH says what is missing and what to do', async () => {
    const { manager } = await rig();
    expect(() => manager.commandFor('claude-code', 'managed')).toThrow(
      /claude-agent-acp is not installed: run "ot adapters install"/,
    );
  });

  it('says it is being installed while the download runs', async () => {
    const { manager } = await rig();
    const release = registry?.hold();
    const running = manager.ensure('claude-code');
    expect(() => manager.commandFor('claude-code', 'managed')).toThrow(/being installed/);
    release?.();
    await running;
  });

  it('says why the install failed, and to try again with "ot adapters install"', async () => {
    const { manager } = await rig({}, true);
    await manager.ensure('claude-code').catch(() => undefined);
    expect(() => manager.commandFor('claude-code', 'managed')).toThrow(
      /could not be installed.*ot adapters install/,
    );
  });
});

describe('AdapterManager.prepare', () => {
  it('installs in the background with install: auto, never blocking', async () => {
    const { manager, situations } = await rig();
    manager.prepare(['claude-code']);
    expect(manager.status('claude-code').installing).toBe(true);
    await manager.idle();
    expect(manager.status('claude-code').installed).toBe(true);
    expect(kinds(situations)).toEqual(['adapter_installing', 'adapter_installed']);
  });

  it('does not throw when the background install fails', async () => {
    const { manager, situations } = await rig({}, true);
    expect(() => {
      manager.prepare(['codex']);
    }).not.toThrow();
    await manager.idle();
    expect(kinds(situations)).toContain('adapter_install_failed');
  });

  it('does nothing when the official client is not in PATH (there is nothing to drive)', async () => {
    const { manager, situations } = await rig({ find: found() });
    manager.prepare(['claude-code', 'codex']);
    await manager.idle();
    expect(registry?.requests).toEqual([]);
    expect(kinds(situations)).toEqual([]);
  });

  it('does nothing when the adapter is already installed', async () => {
    const { manager } = await rig();
    await manager.ensure('claude-code');
    const before = registry?.requests.length;
    manager.prepare(['claude-code']);
    await manager.idle();
    expect(registry?.requests.length).toBe(before);
  });

  it.each(['ask', 'command'] as const)(
    'with install: %s downloads nothing and says what is missing',
    async (install) => {
      const { manager, situations } = await rig({ install });
      manager.prepare(['claude-code']);
      await manager.idle();
      expect(registry?.requests).toEqual([]);
      expect(situations.of('daemon.notice')).toMatchObject([{ kind: 'adapter_missing' }]);
    },
  );

  it('with install: off says it and points at clients.<id>.adapter', async () => {
    const { manager, situations } = await rig({ install: 'off' });
    manager.prepare(['codex']);
    expect(registry?.requests).toEqual([]);
    const [notice] = situations.of('daemon.notice') as { kind: string; detail: string }[];
    expect(notice?.kind).toBe('adapter_missing');
    expect(notice?.detail).toContain('clients.adapters.install is off');
  });

  it('says nothing when the adapter is in PATH already', async () => {
    const { manager, situations } = await rig({
      install: 'off',
      find: found('claude', 'claude-agent-acp'),
    });
    manager.prepare(['claude-code']);
    expect(kinds(situations)).toEqual([]);
  });
});
