// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishDiscovery } from '../api/files.js';
import { dataPaths } from '../paths.js';
import { makeTempDataDir } from '../test-helpers.js';
import { ensureDaemon, type DaemonSpawn, type EnsureDaemonInput } from './ensure-daemon.js';
import { FakeServiceManager } from './service-fixture.js';
import { ServiceError } from './types.js';

let dir: string;
let dispose: () => Promise<void>;
beforeEach(async () => {
  ({ dir, dispose } = await makeTempDataDir());
});
afterEach(async () => {
  await dispose();
});

const PID = 4242;
const COMMAND = { command: '/n/node', args: ['/ot/dist/cli.js', 'daemon'] };

const publish = (): Promise<void> =>
  publishDiscovery(dataPaths(dir).apiDiscovery, {
    url: 'http://127.0.0.1:9',
    daemonId: randomUUID(),
    pid: PID,
    apiVersion: 1,
  });

/** A clock that moves 100 ms per sleep, so a timeout takes no real time. */
function clock(): Pick<EnsureDaemonInput, 'sleep' | 'now'> {
  let time = 0;
  return {
    sleep: (ms) => {
      time += ms;
      return Promise.resolve();
    },
    now: () => time,
  };
}

function input(over: Partial<EnsureDaemonInput> & { spawned?: string[] } = {}): EnsureDaemonInput {
  const spawned = over.spawned ?? [];
  const spawnDaemon: DaemonSpawn = (command) => {
    spawned.push([command.command, ...command.args].join(' '));
    return Promise.resolve({ ok: true });
  };
  return {
    dataDir: dir,
    discoveryFile: dataPaths(dir).apiDiscovery,
    mode: 'service',
    timeoutMs: 1000,
    daemonCommand: COMMAND,
    service: undefined,
    spawnDaemon,
    env: {},
    alive: (pid) => pid === PID,
    ...clock(),
    ...over,
  };
}

describe('ensureDaemon (tui.start_daemon)', () => {
  it('does nothing when a daemon is already running, in every mode', async () => {
    await publish();
    const service = new FakeServiceManager();
    const spawned: string[] = [];
    for (const mode of ['service', 'child', 'off'] as const) {
      expect(await ensureDaemon(input({ mode, service, spawned }))).toEqual({ kind: 'running' });
    }
    expect(service.calls).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it('a stale api.json (its pid is gone) is not a running daemon', async () => {
    await publish();
    const spawned: string[] = [];
    const outcome = await ensureDaemon(input({ mode: 'off', alive: () => false, spawned }));
    expect(outcome).toEqual({ kind: 'off' });
    expect(spawned).toEqual([]);
  });

  it('off starts nothing', async () => {
    const service = new FakeServiceManager();
    expect(await ensureDaemon(input({ mode: 'off', service }))).toEqual({ kind: 'off' });
    expect(service.calls).toEqual([]);
  });

  it('service mode starts the installed service and waits for api.json', async () => {
    const service = new FakeServiceManager();
    service.installed = true;
    service.onStart = publish;
    const spawned: string[] = [];
    expect(await ensureDaemon(input({ service, spawned }))).toEqual({
      kind: 'started',
      via: 'service',
    });
    expect(service.calls).toEqual(['start']);
    expect(spawned).toEqual([]);
  });

  it('service mode with no service installed falls back to a detached child', async () => {
    const service = new FakeServiceManager();
    const spawned: string[] = [];
    const outcome = await ensureDaemon(
      input({
        service,
        spawned,
        spawnDaemon: async (command) => {
          spawned.push(command.args.join(' '));
          // Written before the poll starts: the clock of the test is virtual, the file is not.
          await publish();
          return { ok: true };
        },
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'started',
      via: 'child',
      fallback: { reason: 'not_installed' },
    });
    expect(spawned).toEqual(['/ot/dist/cli.js daemon']);
  });

  it('service mode with a service that fails to start falls back too, and says why', async () => {
    const service = new FakeServiceManager();
    service.installed = true;
    service.startError = new ServiceError('command_failed', 'systemctl start failed', 'boom');
    const outcome = await ensureDaemon(
      input({
        service,
        spawnDaemon: async () => {
          // Written before the poll starts: the clock of the test is virtual, the file is not.
          await publish();
          return { ok: true };
        },
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'started',
      via: 'child',
      fallback: { reason: 'service_failed', detail: 'systemctl start failed' },
    });
  });

  it('service mode with no manager on the platform starts a child', async () => {
    const outcome = await ensureDaemon(
      input({
        service: undefined,
        spawnDaemon: async () => {
          // Written before the poll starts: the clock of the test is virtual, the file is not.
          await publish();
          return { ok: true };
        },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'started', via: 'child' });
  });

  it('child mode never touches the service', async () => {
    const service = new FakeServiceManager();
    service.installed = true;
    const outcome = await ensureDaemon(
      input({
        mode: 'child',
        service,
        spawnDaemon: async () => {
          // Written before the poll starts: the clock of the test is virtual, the file is not.
          await publish();
          return { ok: true };
        },
      }),
    );
    expect(outcome).toMatchObject({ kind: 'started', via: 'child' });
    expect(service.calls).toEqual([]);
  });

  it('fails without throwing: no command, a spawn that fails, a daemon that never answers', async () => {
    expect(await ensureDaemon(input({ mode: 'child', daemonCommand: undefined }))).toMatchObject({
      kind: 'failed',
      reason: 'no_command',
    });
    expect(
      await ensureDaemon(
        input({
          mode: 'child',
          spawnDaemon: () => Promise.resolve({ ok: false, detail: 'ENOENT' }),
        }),
      ),
    ).toEqual({ kind: 'failed', reason: 'spawn_failed', detail: 'ENOENT' });
    expect(await ensureDaemon(input({ mode: 'child', timeoutMs: 500 }))).toMatchObject({
      kind: 'failed',
      reason: 'timeout',
    });
  });

  it('a removed api.json after the start is read again on every poll', async () => {
    let polls = 0;
    const outcome = await ensureDaemon(
      input({
        mode: 'child',
        sleep: async () => {
          polls += 1;
          if (polls === 3) await publish();
          else await rm(dataPaths(dir).apiDiscovery, { force: true });
        },
        now: () => 0,
      }),
    );
    expect(outcome).toMatchObject({ kind: 'started', via: 'child' });
    expect(polls).toBe(3);
  });
});
