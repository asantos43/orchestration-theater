// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishDiscovery, readDiscovery } from '../api/files.js';
import { main, type CliDeps } from '../cli.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { InstanceLock } from '../instance-lock.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths } from '../paths.js';
import type { DaemonSpawn } from '../service/ensure-daemon.js';
import { FakeServiceManager } from '../service/service-fixture.js';
import { ServiceError } from '../service/types.js';
import { NO_CLIENTS } from '../test-helpers.js';
import { purgeRefusalOf, type ServiceHost } from './service.js';

/**
 * `ot service`, `ot uninstall` and the daemon that `ot tui` starts (Phase 10, P3). Every test runs
 * with the fake service manager, a temp data folder and a temp HOME: none reaches `systemctl`,
 * `launchctl` or `schtasks`, and the real data folder is never named.
 */

const LAUNCHER = { node: '/n/node', entry: '/ot/dist/cli.js' } as const;
const PID = 4242;

let root: string;
let data: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'otheater-svc-cmd-'));
  data = join(root, 'data');
  home = join(root, 'home');
  await mkdir(data, { recursive: true });
  await mkdir(home, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

const noSpawn: DaemonSpawn = () => Promise.resolve({ ok: false, detail: 'no spawn in this test' });
/** No test reaches a network by accident: the stop route answers only where a test says so. */
const noFetch = (): Promise<Response> => Promise.reject(new Error('no network in this test'));

async function ot(
  argv: readonly string[],
  manager: FakeServiceManager | undefined,
  extra: Partial<CliDeps> = {},
  host: Partial<ServiceHost> = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, '--data-dir', data], {
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    homedir: home,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    systemLocale: 'en',
    version: '0.0.0-test',
    otLauncher: LAUNCHER,
    serviceHost: {
      manager,
      spawnDaemon: noSpawn,
      alive: (pid) => pid === PID,
      fetch: noFetch,
      ...host,
    },
    ...extra,
  });
  return { code, out, err };
}

const publish = (): Promise<void> =>
  publishDiscovery(dataPaths(data).apiDiscovery, {
    url: 'http://127.0.0.1:9',
    daemonId: randomUUID(),
    pid: PID,
    apiVersion: 1,
  });

/** A clock that moves only when the command sleeps. */
const clock = (): { now: () => number; sleep: (ms: number) => Promise<void> } => {
  let at = 0;
  return {
    now: () => at,
    sleep: (ms) => {
      at += ms;
      return Promise.resolve();
    },
  };
};

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe('ot service', () => {
  it('is a usage error without an action or with an unknown one', async () => {
    expect(await ot(['service'], undefined)).toMatchObject({ code: 2 });
    const unknown = await ot(['service', 'frobnicate'], undefined);
    expect(unknown.code).toBe(2);
    expect(unknown.err.join('\n')).toMatch(/frobnicate/);
    expect((await ot(['service', 'status', 'x'], undefined)).code).toBe(2);
  });

  it('says there is no service manager where the platform has none', async () => {
    const result = await ot(['service', 'status'], undefined, { platform: 'freebsd' });
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/freebsd/);
  });

  it('install gives the manager the checkout command, the data folder and the config keys, then starts', async () => {
    const manager = new FakeServiceManager();
    await writeFile(join(data, 'config.yaml'), 'service:\n  restart: always\n  console: visible\n');
    const result = await ot(['service', 'install'], manager);
    expect(result.code).toBe(0);
    expect(manager.spec).toMatchObject({
      id: 'otheater-fake',
      command: {
        command: '/n/node',
        args: ['/ot/dist/cli.js', 'daemon', '--data-dir', data, '--non-interactive'],
      },
      dataDir: data,
      restart: 'always',
      autostart: 'logon',
      console: 'visible',
      path: '/usr/bin',
    });
    expect(manager.calls).toEqual(['install', 'start']);
    expect(result.out.join('\n')).toMatch(/installed[\s\S]*logon[\s\S]*linger[\s\S]*started/i);
  });

  it('install --no-start, autostart: manual and a daemon already running do not start it', async () => {
    const noStart = new FakeServiceManager();
    await ot(['service', 'install', '--no-start'], noStart);
    expect(noStart.calls).toEqual(['install']);

    const manual = new FakeServiceManager();
    await writeFile(join(data, 'config.yaml'), 'service:\n  autostart: manual\n');
    await ot(['service', 'install'], manual);
    expect(manual.calls).toEqual(['install']);
    expect(manual.spec?.autostart).toBe('manual');

    await writeFile(join(data, 'config.yaml'), '');
    await publish();
    const running = new FakeServiceManager();
    const result = await ot(['service', 'install'], running);
    expect(running.calls).toEqual(['install']);
    expect(result.out.join('\n')).toMatch(/already running/i);
  });

  it('a start that fails after the install is a warning, not a failure', async () => {
    const manager = new FakeServiceManager();
    manager.startError = new ServiceError('command_failed', 'systemctl start failed', 'boom');
    const result = await ot(['service', 'install'], manager);
    expect(result.code).toBe(0);
    expect(manager.installed).toBe(true);
    expect(result.err.join('\n')).toMatch(/could not be started[\s\S]*boom/i);
  });

  it('install without the entry of ot (no launcher) fails and installs nothing', async () => {
    const manager = new FakeServiceManager();
    const result = await ot(['service', 'install'], manager, { otLauncher: undefined });
    expect(result.code).toBe(1);
    expect(manager.calls).toEqual([]);
  });

  it('a broken config.yaml stops the install before it touches the manager', async () => {
    const manager = new FakeServiceManager();
    await writeFile(join(data, 'config.yaml'), 'service:\n  restart: sometimes\n');
    const result = await ot(['service', 'install'], manager);
    expect(result.code).not.toBe(0);
    expect(manager.calls).toEqual([]);
  });

  it('status prints text and, with --json, a document with the service and the daemon', async () => {
    const manager = new FakeServiceManager();
    const before = await ot(['service', 'status'], manager);
    expect(before.code).toBe(0);
    expect(before.out.join('\n')).toMatch(/not installed/i);

    await ot(['service', 'install', '--no-start'], manager);
    await publish();
    manager.active = true;
    const json = await ot(['service', 'status', '--json'], manager);
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({
      service: { kind: 'fake', installed: true, enabled: true, active: true },
      daemon: { running: true, pid: PID },
    });
    const text = await ot(['service', 'status'], manager);
    expect(text.out.join('\n')).toMatch(/running[\s\S]*4242/);
  });

  it('start and stop go through the manager; without the service they say so and exit 1', async () => {
    const manager = new FakeServiceManager();
    const missing = await ot(['service', 'start'], manager);
    expect(missing.code).toBe(1);
    expect(missing.err.join('\n')).toMatch(/not installed/i);

    manager.installed = true;
    expect((await ot(['service', 'start'], manager)).code).toBe(0);
    expect(manager.active).toBe(true);
    expect((await ot(['service', 'stop'], manager)).code).toBe(0);
    expect(manager.active).toBe(false);
  });

  it('stop waits until the daemon has gone from api.json', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    await publish();
    let alive = true;
    const slept: number[] = [];
    const result = await ot(
      ['service', 'stop'],
      manager,
      {},
      {
        alive: () => alive,
        sleep: (ms) => {
          slept.push(ms);
          if (slept.length === 3) alive = false;
          return Promise.resolve();
        },
        now: () => 0,
      },
    );
    expect(result.code).toBe(0);
    expect(slept).toHaveLength(3);
  });

  it('without the service and with nothing running, stop says it is not installed', async () => {
    const result = await ot(['service', 'stop'], new FakeServiceManager());
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/not installed/i);
    expect(result.out.join('\n')).not.toMatch(/stopped/i);
  });

  it('a manager that is unavailable is reported with its reason', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    manager.startError = new ServiceError('unavailable', 'no user session', 'no bus');
    const result = await ot(['service', 'start'], manager);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/no bus/);
  });

  it('uninstall stops, removes the service and leaves the data alone', async () => {
    const manager = new FakeServiceManager();
    await writeFile(join(data, 'config.yaml'), 'ui:\n  locale: en\n');
    await ot(['service', 'install', '--no-start'], manager);
    const result = await ot(['service', 'uninstall'], manager);
    expect(result.code).toBe(0);
    expect(manager.installed).toBe(false);
    expect(manager.calls).toEqual(['install', 'status', 'stop', 'uninstall']);
    expect(await readFile(join(data, 'config.yaml'), 'utf8')).toBe('ui:\n  locale: en\n');
    // A second one is not an error.
    expect((await ot(['service', 'uninstall'], manager)).code).toBe(0);
  });
});

describe('ot uninstall', () => {
  it('without --purge-data it removes the service and keeps every file of the data folder', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    await writeFile(join(data, 'config.yaml'), 'ui:\n  locale: en\n');
    await writeFile(join(data, 'store.sqlite'), 'x');
    const result = await ot(['uninstall'], manager);
    expect(result.code).toBe(0);
    expect(manager.installed).toBe(false);
    expect(result.out.join('\n')).toContain(data);
    expect(await exists(join(data, 'store.sqlite'))).toBe(true);
    expect(await exists(join(data, 'config.yaml'))).toBe(true);
  });

  it('--purge-data asks first; a yes deletes the data folder and only it', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    await writeFile(join(data, 'config.yaml'), 'ui:\n  locale: en\n');
    const questions: string[] = [];
    const result = await ot(['uninstall', '--purge-data'], manager, {
      confirm: (question) => {
        questions.push(question);
        return Promise.resolve(true);
      },
    });
    expect(result.code).toBe(0);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain(data);
    expect(await exists(data)).toBe(false);
    expect(await exists(home)).toBe(true);
    expect(manager.installed).toBe(false);
  });

  it('--purge-data with a no changes nothing, not even the service', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    await writeFile(join(data, 'config.yaml'), '');
    const result = await ot(['uninstall', '--purge-data'], manager, {
      confirm: () => Promise.resolve(false),
    });
    expect(result.code).toBe(1);
    expect(manager.installed).toBe(true);
    expect(await exists(join(data, 'config.yaml'))).toBe(true);
  });

  it('--purge-data without a terminal to ask and without --yes refuses; --yes does not ask', async () => {
    const manager = new FakeServiceManager();
    await writeFile(join(data, 'config.yaml'), '');
    const refused = await ot(['uninstall', '--purge-data'], manager, { confirm: undefined });
    expect(refused.code).toBe(1);
    expect(refused.err.join('\n')).toMatch(/--yes/);
    expect(await exists(data)).toBe(true);

    const yes = await ot(['uninstall', '--purge-data', '--yes'], manager, { confirm: undefined });
    expect(yes.code).toBe(0);
    expect(await exists(data)).toBe(false);
  });

  it('--purge-data refuses a folder that is not an OTheater data folder, even with --yes', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    await writeFile(join(data, 'notes.txt'), 'mine');
    const result = await ot(['uninstall', '--purge-data', '--yes'], manager);
    expect(result.code).toBe(1);
    expect(await exists(join(data, 'notes.txt'))).toBe(true);
    expect(manager.calls).toEqual([]);
  });

  it('--purge-data refuses while a daemon holds the instance lock; the service is already gone', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    await writeFile(join(data, 'config.yaml'), '');
    const paths = dataPaths(data);
    const lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
    try {
      const result = await ot(['uninstall', '--purge-data', '--yes'], manager, {}, clock());
      expect(result.code).toBe(1);
      expect(manager.installed).toBe(false);
      expect(result.err.join('\n')).toMatch(/still holds the data folder/i);
      expect(await exists(join(data, 'config.yaml'))).toBe(true);
    } finally {
      await lock.release();
    }
  });

  it('purgeRefusalOf: the root, the home folder and what is above it, a folder that is not a data folder', async () => {
    expect(await purgeRefusalOf('/', home)).toBe('root');
    expect(await purgeRefusalOf(home, home)).toBe('home');
    expect(await purgeRefusalOf(root, home)).toBe('home');
    expect(await purgeRefusalOf(data, home)).toBe('not_data');
    await writeFile(join(data, 'daemon-id'), 'x');
    expect(await purgeRefusalOf(data, home)).toBeUndefined();
    // A data folder inside the home folder is the normal case.
    const inside = join(home, '.local', 'share', 'otheater');
    await mkdir(inside, { recursive: true });
    await writeFile(join(inside, 'store.sqlite'), 'x');
    expect(await purgeRefusalOf(inside, home)).toBeUndefined();
  });
});

describe('ot tui starts the daemon when it is not running (tui.start_daemon)', () => {
  const memoryStore = (): InMemoryStore => new InMemoryStore({ clock: new FakeClock() });
  let handle: DaemonHandle | undefined;
  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
  });

  /** The daemon of the test: the real one, in this process, with no client and an in-memory store. */
  const startHere = async (): Promise<void> => {
    handle = await startDaemon({
      dataDir: data,
      clientSearch: NO_CLIENTS,
      config: parseConfig('backup:\n  when: manual\n'),
      overrides: {
        clock: new FakeClock(),
        vault: new InMemorySecretVault(),
        store: memoryStore(),
      },
      logger: createSilentLogger(),
      version: '0.0.0-test',
    });
  };

  /** A launcher that records whether the daemon was live when the interface opened. */
  function launcher(): { liveAtLaunch: boolean[]; launch: NonNullable<CliDeps['launchTui']> } {
    const liveAtLaunch: boolean[] = [];
    return {
      liveAtLaunch,
      launch: async () => {
        liveAtLaunch.push((await readDiscovery(dataPaths(data).apiDiscovery)).kind === 'live');
        return 0;
      },
    };
  }

  const real = { alive: undefined } as const;

  it('starts the installed service, and the interface opens with a daemon', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    manager.onStart = startHere;
    const tui = launcher();
    const result = await ot(['tui'], manager, { interactive: true, launchTui: tui.launch }, real);
    expect(result).toMatchObject({ code: 0, err: [] });
    expect(manager.calls).toEqual(['start']);
    expect(tui.liveAtLaunch).toEqual([true]);
  });

  it('does not start a second daemon when one is running', async () => {
    await startHere();
    const manager = new FakeServiceManager();
    manager.installed = true;
    const tui = launcher();
    const result = await ot(['tui'], manager, { interactive: true, launchTui: tui.launch }, real);
    expect(result).toMatchObject({ code: 0, err: [] });
    expect(manager.calls).toEqual([]);
    expect(tui.liveAtLaunch).toEqual([true]);
  });

  it('without the service installed it starts a detached child with daemon --data-dir --non-interactive', async () => {
    const manager = new FakeServiceManager();
    const spawned: string[] = [];
    const tui = launcher();
    const result = await ot(
      ['tui'],
      manager,
      { interactive: true, launchTui: tui.launch },
      {
        ...real,
        spawnDaemon: async (command) => {
          spawned.push([command.command, ...command.args].join(' '));
          await startHere();
          return { ok: true };
        },
      },
    );
    expect(result).toMatchObject({ code: 0, err: [] });
    expect(spawned).toEqual([
      `/n/node /ot/dist/cli.js daemon --data-dir ${data} --non-interactive`,
    ]);
    expect(tui.liveAtLaunch).toEqual([true]);
  });

  it('tui.start_daemon: off starts nothing and the interface opens without a daemon', async () => {
    await writeFile(join(data, 'config.yaml'), 'tui:\n  start_daemon: off\n');
    const manager = new FakeServiceManager();
    manager.installed = true;
    const tui = launcher();
    const result = await ot(['tui'], manager, { interactive: true, launchTui: tui.launch }, real);
    expect(result).toMatchObject({ code: 0, err: [] });
    expect(manager.calls).toEqual([]);
    expect(tui.liveAtLaunch).toEqual([false]);
  });

  it('tui.start_daemon: child never starts the service', async () => {
    await writeFile(join(data, 'config.yaml'), 'tui:\n  start_daemon: child\n');
    const manager = new FakeServiceManager();
    manager.installed = true;
    const tui = launcher();
    await ot(
      ['tui'],
      manager,
      { interactive: true, launchTui: tui.launch },
      {
        ...real,
        spawnDaemon: async () => {
          await startHere();
          return { ok: true };
        },
      },
    );
    expect(manager.calls).toEqual([]);
    expect(tui.liveAtLaunch).toEqual([true]);
  });

  it('a daemon that does not come up is a warning: the interface opens anyway', async () => {
    await writeFile(
      join(data, 'config.yaml'),
      'tui:\n  start_daemon: child\n  start_timeout: 1s\n',
    );
    let time = 0;
    const tui = launcher();
    const result = await ot(
      ['tui'],
      new FakeServiceManager(),
      { interactive: true, launchTui: tui.launch },
      {
        spawnDaemon: () => Promise.resolve({ ok: true }),
        sleep: (ms) => {
          time += ms;
          return Promise.resolve();
        },
        now: () => time,
      },
    );
    expect(result.code).toBe(0);
    expect(result.err.join('\n')).toMatch(/daemon/i);
    expect(tui.liveAtLaunch).toEqual([false]);
  });

  it('a service that fails to start falls back to the child and warns about it', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    manager.startError = new ServiceError('command_failed', 'systemctl start failed', 'boom');
    const tui = launcher();
    const result = await ot(
      ['tui'],
      manager,
      { interactive: true, launchTui: tui.launch },
      {
        ...real,
        spawnDaemon: async () => {
          await startHere();
          return { ok: true };
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.err.join('\n')).toMatch(/systemctl start failed/);
    expect(tui.liveAtLaunch).toEqual([true]);
  });

  it('without a serviceHost (every other test of ot) nothing is started', async () => {
    const tui = launcher();
    const out: string[] = [];
    const code = await main(['tui', '--data-dir', data], {
      env: {},
      platform: 'linux',
      homedir: home,
      out: (line) => out.push(line),
      err: (line) => out.push(line),
      systemLocale: 'en',
      version: '0.0.0-test',
      interactive: true,
      launchTui: tui.launch,
    });
    expect(code).toBe(0);
    expect(out).toEqual([]);
    expect(tui.liveAtLaunch).toEqual([false]);
  });
});

/**
 * N323, bug 2: on Windows ending the scheduled task did not reach the daemon, and `ot service stop`
 * said "stopped" with the daemon still running. The stop now asks the daemon through its API, waits
 * for the instance lock, ends a daemon that does not go by its pid, and says "stopped" only then.
 */
describe('ot service stop stops the daemon for real (N323)', () => {
  const OTHER = 5555;
  let handle: DaemonHandle | undefined;
  let held: InstanceLock | undefined;
  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    await held?.release();
    held = undefined;
  });

  /** A daemon that answers nothing: the test holds its lock and `api.json` names {@link PID}. */
  const deafDaemon = async (lockPid = PID): Promise<void> => {
    const paths = dataPaths(data);
    held = await InstanceLock.acquire(paths.lock, paths.lockInfo);
    await held.publish({ pid: lockPid, startedAt: 0, version: '0.0.0-test' });
    await publish();
    await writeFile(paths.apiToken, 'test-token\n');
  };

  it('without the service, it stops the daemon through POST /v1/daemon/stop and waits for it', async () => {
    handle = await startDaemon({
      dataDir: data,
      clientSearch: NO_CLIENTS,
      config: parseConfig('backup:\n  when: manual\n'),
      overrides: {
        clock: new FakeClock(),
        vault: new InMemorySecretVault(),
        store: new InMemoryStore({ clock: new FakeClock() }),
      },
      logger: createSilentLogger(),
      version: '0.0.0-test',
    });
    const manager = new FakeServiceManager();
    const result = await ot(
      ['service', 'stop'],
      manager,
      {},
      { alive: undefined, fetch: undefined, kill: () => expect.fail('nothing is killed') },
    );
    expect(result).toMatchObject({ code: 0, err: [] });
    expect(result.out.join('\n')).toMatch(/stopped/i);
    await handle.stopped;
    expect((await readDiscovery(dataPaths(data).apiDiscovery)).kind).toBe('none');
    // The lock is free: the data folder can be taken again.
    const paths = dataPaths(data);
    await (await InstanceLock.acquire(paths.lock, paths.lockInfo)).release();
  });

  it('asks the daemon with the token and, when it does not go, ends its pid and says so', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    await deafDaemon();
    let alive = true;
    const requests: string[] = [];
    const kills: string[] = [];
    const result = await ot(
      ['service', 'stop'],
      manager,
      {},
      {
        ...clock(),
        alive: (pid) => pid === PID && alive,
        fetch: (url, init) => {
          const headers = new Headers(init?.headers);
          const target = typeof url === 'string' ? url : 'not a string';
          requests.push(`${init?.method ?? 'GET'} ${target} ${headers.get('authorization') ?? ''}`);
          return Promise.reject(new Error('connection reset'));
        },
        kill: (pid, signal) => {
          kills.push(`${String(pid)} ${signal}`);
          alive = false;
          void held?.release();
        },
      },
    );
    expect(requests).toEqual(['POST http://127.0.0.1:9/v1/daemon/stop Bearer test-token']);
    expect(kills).toEqual([`${String(PID)} SIGTERM`]);
    expect(result.code).toBe(0);
    expect(result.err.join('\n')).toMatch(new RegExp(`process \\(${String(PID)}\\) was ended`));
    expect(result.out.join('\n')).toMatch(/stopped/i);
  });

  it('a daemon that survives SIGKILL is an error and never "stopped"', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    await deafDaemon();
    const kills: string[] = [];
    const result = await ot(
      ['service', 'stop'],
      manager,
      {},
      { ...clock(), kill: (pid, signal) => kills.push(`${String(pid)} ${signal}`) },
    );
    expect(kills).toEqual([`${String(PID)} SIGTERM`, `${String(PID)} SIGKILL`]);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(new RegExp(`pid ${String(PID)}\\) is still running`));
    expect(result.out.join('\n')).not.toMatch(/stopped/i);
  });

  it('does not end a pid when the lock and api.json disagree on who holds the folder', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    await deafDaemon(OTHER);
    const kills: string[] = [];
    const result = await ot(
      ['service', 'stop'],
      manager,
      {},
      {
        ...clock(),
        alive: (pid) => pid === PID || pid === OTHER,
        kill: (pid, signal) => kills.push(`${String(pid)} ${signal}`),
      },
    );
    expect(kills).toEqual([]);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/pid is not known/);
  });

  it('uninstall removes the service even when the daemon does not stop, and says it is running', async () => {
    const manager = new FakeServiceManager();
    manager.installed = true;
    await deafDaemon();
    const result = await ot(
      ['service', 'uninstall'],
      manager,
      {},
      { ...clock(), kill: () => undefined },
    );
    expect(manager.installed).toBe(false);
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/still running/);
  });
});
