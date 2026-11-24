// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDiscovery } from '../api/files.js';
import { main, type CliDeps } from '../cli.js';
import type { FindExecutable } from '../clients.js';
import {
  fixtureAdapter,
  startFakeRegistry,
  type FakeRegistry,
} from '../adapters/adapter-fixture.js';
import { DaemonConfigSchema, parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths } from '../paths.js';
import type { DaemonSpawn } from '../service/ensure-daemon.js';
import { FakeServiceManager } from '../service/service-fixture.js';
import { ServiceError } from '../service/types.js';
import { NO_CLIENTS } from '../test-helpers.js';
import { commandChecks } from './init.js';
import type { ServiceHost } from './service.js';

/**
 * `ot init` (Phase 10, P6). Every test runs with the fake service manager, a temp data folder, a
 * temp HOME and a daemon in this process: none reaches `systemctl`, `launchctl`, `schtasks` or
 * `npm`, and the real data folder and the real `PATH` are never looked at (`find` is injected).
 */

const LAUNCHER = { node: '/n/node', entry: '/ot/dist/cli.js' } as const;

let root: string;
let data: string;
let home: string;
let handle: DaemonHandle | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'otheater-init-'));
  data = join(root, 'data');
  home = join(root, 'home');
  await mkdir(data, { recursive: true });
  await mkdir(home, { recursive: true });
});
afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  await rm(root, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

const spawned: string[] = [];
const noSpawn: DaemonSpawn = (command) => {
  spawned.push(command.command);
  return Promise.resolve({ ok: false, detail: 'no spawn in this test' });
};

async function ot(
  argv: readonly string[],
  manager: FakeServiceManager | undefined,
  extra: Partial<CliDeps> = {},
  host: Partial<ServiceHost> = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main([...argv, '--data-dir', data], {
    env: { PATH: '/nowhere' },
    platform: 'linux',
    homedir: home,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    systemLocale: 'en',
    version: '0.0.0-test',
    otLauncher: LAUNCHER,
    serviceHost: { manager, spawnDaemon: noSpawn, ...host },
    // Nothing here reaches the npm registry: an install that is tried fails offline.
    adapters: { fetch: () => Promise.reject(new Error('offline')) },
    ...extra,
  });
  return { code, out, err };
}

/** The daemon of the test: the real one, in this process, so `api.json` is real and the pid is live. */
const startHere = async (): Promise<void> => {
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
};

/** The service of a test whose start brings the daemon up, as the real service would. */
function serviceThatStartsTheDaemon(): FakeServiceManager {
  const manager = new FakeServiceManager();
  manager.onStart = async () => {
    if ((await readDiscovery(dataPaths(data).apiDiscovery)).kind !== 'live') await startHere();
  };
  return manager;
}

/** `claude` and `claude-agent-acp` are installed; the others are not. */
const onlyClaude: FindExecutable = (command) =>
  command === 'claude' || command === 'claude-agent-acp' ? `/fake/bin/${command}` : undefined;
const nothing: FindExecutable = () => undefined;

const real = { alive: undefined } as const;

/** The lines of step 3 (the commands), to compare two runs. */
function commandLines(run: Run): string[] {
  const text = run.out.join('\n');
  const from = text.indexOf('Step 3');
  return text.slice(from).split('\n');
}

describe('ot init --no-tui', () => {
  it('twice in a row gives the same result: one service, a daemon, the same list of what is missing', async () => {
    const manager = serviceThatStartsTheDaemon();
    const first = await ot(['init', '--no-tui'], manager, {}, { ...real, find: onlyClaude });
    expect(first.code).toBe(0);
    expect(first.err).toEqual([]);
    // N274: the summary shows the command that adds an account (the step of the assistant needs the interface).
    expect(first.out.join('\n')).toMatch(/ot profile add <client> <name> --login/);
    expect(manager.calls).toEqual(['status', 'install', 'start']);
    expect(manager.installed).toBe(true);
    // The service is installed without starting it: the daemon comes up in step 2.
    expect(manager.spec).toMatchObject({
      command: { command: '/n/node', args: ['/ot/dist/cli.js', 'daemon', '--data-dir', data] },
      dataDir: data,
    });
    expect((await readDiscovery(dataPaths(data).apiDiscovery)).kind).toBe('live');
    const firstText = first.out.join('\n');
    expect(firstText).toMatch(
      /Step 1 of 3[\s\S]*installed[\s\S]*Step 2 of 3[\s\S]*started by the service/,
    );

    manager.calls.length = 0;
    const second = await ot(['init', '--no-tui'], manager, {}, { ...real, find: onlyClaude });
    expect(second.code).toBe(0);
    // Not written again, not started again.
    expect(manager.calls).toEqual(['status']);
    expect(second.out.join('\n')).toMatch(/already installed[\s\S]*daemon is running/);
    expect(commandLines(second)).toEqual(commandLines(first));
    expect(spawned).toEqual([]);
  });

  it('shows the missing clients with the npm command, installs none and still succeeds', async () => {
    const manager = serviceThatStartsTheDaemon();
    const result = await ot(['init', '--no-tui'], manager, {}, { ...real, find: onlyClaude });
    const text = result.out.join('\n');
    expect(result.code).toBe(0);
    expect(text).toContain(
      'found: claude-agent-acp (ACP adapter of claude-code) at /fake/bin/claude-agent-acp',
    );
    expect(text).toContain('found: claude (client claude-code) at /fake/bin/claude');
    // The adapter of a client that is not there comes with the client: nothing to install yet.
    expect(text).toContain(
      'codex-acp (ACP adapter of codex): not installed yet; it comes with codex',
    );
    expect(text).toContain(
      'MISSING: codex (client codex). To install it, run: npm install -g @openai/codex',
    );
    expect(text).toContain(
      'MISSING: opencode (client opencode). To install it, run: npm install -g opencode-ai',
    );
    expect(text).toMatch(/2 command\(s\) missing\. OTheater never installs a client/);
    expect(spawned).toEqual([]);
  });

  it('with everything in PATH it says so', async () => {
    const result = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      {},
      { ...real, find: (command) => `/fake/bin/${command}` },
    );
    expect(result.out.join('\n')).toContain('All the commands were found.');
  });

  it('a client turned off in the configuration is not looked for; a configured command is', async () => {
    await writeFile(
      join(data, 'config.yaml'),
      'clients:\n  codex:\n    enabled: false\n  opencode:\n    command:\n      cmd: /opt/oc/opencode\n',
    );
    const looked: string[] = [];
    const result = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      {},
      {
        ...real,
        find: (command) => {
          looked.push(command);
          return undefined;
        },
      },
    );
    expect(result.code).toBe(0);
    // The adapter manager looks for the official client first (it decides the install), then init checks each command.
    expect(looked).toEqual(['claude', 'claude-agent-acp', 'claude', '/opt/oc/opencode']);
    expect(result.out.join('\n')).toContain('codex: turned off');
  });

  it('commandChecks: OpenCode is one command, a disabled client has none', () => {
    const config = DaemonConfigSchema.parse({ clients: { codex: { enabled: false } } });
    const { checks, off } = commandChecks(config);
    expect(off).toEqual(['codex']);
    expect(checks.map((check) => `${check.id}:${check.kind}:${check.executable}`)).toEqual([
      'claude-code:managed:claude-agent-acp',
      'claude-code:client:claude',
      'opencode:client:opencode',
    ]);
  });
});

describe('a step that fails', () => {
  it('step 1: says why and which command repeats it, and starts nothing', async () => {
    const manager = new FakeServiceManager();
    manager.install = () =>
      Promise.reject(new ServiceError('unavailable', 'no user session', 'no bus'));
    const result = await ot(['init', '--no-tui'], manager, {}, { find: nothing });
    expect(result.code).toBe(1);
    const err = result.err.join('\n');
    expect(err).toMatch(/stopped at step 1[\s\S]*no bus/);
    // The data folder of the test is not the default one, so the command names it.
    expect(err).toContain(`ot service install --data-dir ${data}`);
    expect(manager.calls).toEqual(['status']);
    expect(result.out.join('\n')).not.toContain('Step 2');
  });

  it('step 1 on a system with no service manager', async () => {
    const result = await ot(['init', '--no-tui'], undefined, { platform: 'freebsd' });
    expect(result.code).toBe(1);
    expect(result.err.join('\n')).toMatch(/freebsd[\s\S]*ot service install/);
  });

  it('step 2: the service is kept, the reason and "ot service start" are given, step 3 does not run', async () => {
    const manager = new FakeServiceManager();
    // A daemon that never publishes its API, and a clock that runs out the wait at once.
    let ms = 0;
    const result = await ot(
      ['init', '--no-tui'],
      manager,
      {},
      {
        find: nothing,
        sleep: () => Promise.resolve(),
        now: () => (ms += 10_000),
      },
    );
    expect(result.code).toBe(1);
    const err = result.err.join('\n');
    expect(err).toMatch(/stopped at step 2[\s\S]*did not publish its API/);
    expect(err).toContain(`ot service start --data-dir ${data}`);
    expect(err).toMatch(/What was done before stays/);
    // Nothing was undone.
    expect(manager.installed).toBe(true);
    expect(manager.calls).not.toContain('uninstall');
    expect(result.out.join('\n')).not.toContain('Step 3');
  });

  it('repeating after the fix finishes the job: the service is not installed twice', async () => {
    const manager = new FakeServiceManager();
    let ms = 0;
    const failing = await ot(
      ['init', '--no-tui'],
      manager,
      {},
      { find: nothing, sleep: () => Promise.resolve(), now: () => (ms += 10_000) },
    );
    expect(failing.code).toBe(1);
    manager.onStart = startHere;
    manager.calls.length = 0;
    const result = await ot(['init', '--no-tui'], manager, {}, { ...real, find: nothing });
    expect(result.code).toBe(0);
    expect(manager.calls).toEqual(['status', 'start']);
  });
});

describe('ot init with the interface', () => {
  it('opens it after the daemon is up, with the ui of the configuration, and gives its exit code', async () => {
    await writeFile(join(data, 'config.yaml'), 'ui:\n  setup:\n    readTimeoutMs: 1234\n');
    const manager = serviceThatStartsTheDaemon();
    const seen: { live: boolean; ui: unknown }[] = [];
    const result = await ot(
      ['init'],
      manager,
      {
        interactive: true,
        launchTui: async (run) => {
          seen.push({
            live: (await readDiscovery(dataPaths(data).apiDiscovery)).kind === 'live',
            ui: run.ui,
          });
          return 7;
        },
      },
      { ...real, find: onlyClaude },
    );
    expect(result.code).toBe(7);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.live).toBe(true);
    // The default of `ui.setup.open` is auto: the interface opens the assistant of the first run.
    expect(seen[0]?.ui).toMatchObject({ setup: { open: 'auto', readTimeoutMs: 1234 } });
    expect(result.out.join('\n')).toMatch(/Step 4 of 4: the terminal interface/);
    // No question was asked anywhere.
    expect(result.err).toEqual([]);
  });

  it('says so when ui.setup.open is never, and still opens the interface', async () => {
    await writeFile(join(data, 'config.yaml'), 'ui:\n  setup:\n    open: never\n');
    const result = await ot(
      ['init'],
      serviceThatStartsTheDaemon(),
      { interactive: true, launchTui: () => Promise.resolve(0) },
      { ...real, find: nothing },
    );
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toMatch(/ui\.setup\.open is "never"/);
  });

  it('does not open it when the daemon failed', async () => {
    const opened: unknown[] = [];
    let ms = 0;
    const result = await ot(
      ['init'],
      new FakeServiceManager(),
      {
        interactive: true,
        launchTui: () => {
          opened.push(1);
          return Promise.resolve(0);
        },
      },
      { find: nothing, sleep: () => Promise.resolve(), now: () => (ms += 10_000) },
    );
    expect(result.code).toBe(1);
    expect(opened).toEqual([]);
  });

  it('without a terminal the steps are done, the interface is not opened and it is not an error', async () => {
    const opened: unknown[] = [];
    const result = await ot(
      ['init'],
      serviceThatStartsTheDaemon(),
      {
        interactive: false,
        launchTui: () => {
          opened.push(1);
          return Promise.resolve(0);
        },
      },
      { ...real, find: nothing },
    );
    expect(result.code).toBe(0);
    expect(opened).toEqual([]);
    expect(result.out.join('\n')).toMatch(/no terminal[\s\S]*ot tui/i);
    // N274: no assistant here, so the summary shows the command that adds an account.
    expect(result.out.join('\n')).toMatch(/ot profile add <client> <name> --login/);
  });

  it('--no-tui does not open it even in a terminal', async () => {
    const opened: unknown[] = [];
    const result = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      {
        interactive: true,
        launchTui: () => {
          opened.push(1);
          return Promise.resolve(0);
        },
      },
      { ...real, find: nothing },
    );
    expect(result.code).toBe(0);
    expect(opened).toEqual([]);
  });

  it('is a usage error with an argument', async () => {
    const result = await ot(['init', 'now'], new FakeServiceManager());
    expect(result.code).toBe(2);
  });

  it('prints in Portuguese when the system locale is pt-BR', async () => {
    const result = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      { systemLocale: 'pt-BR' },
      { ...real, find: nothing },
    );
    expect(result.code).toBe(0);
    expect(result.out.join('\n')).toMatch(
      /Passo 3 de 3[\s\S]*FALTA: codex \(cliente codex\)[\s\S]*npm install -g/,
    );
  });
});

describe('ot init --no-tui: the managed ACP adapters (P13)', () => {
  const LINUX = { os: 'linux', cpu: 'x64', libc: 'glibc' } as const;
  const onlyClient: FindExecutable = (command) =>
    command === 'claude' ? '/fake/bin/claude' : undefined;
  const fixture = fixtureAdapter();
  let registry: FakeRegistry;
  beforeEach(async () => {
    registry = await startFakeRegistry(fixture);
  });
  afterEach(async () => {
    await registry.close();
  });

  /** The seams that send the install to the fake registry, with the fixture as the pinned lock. */
  const seams = (): CliDeps['adapters'] => ({
    lockOf: (id) => ({ ...fixture.lock, id }),
    platform: LINUX,
    self: { sea: false, execPath: '/n/node' },
    installOptions: { retryDelayMs: 0, retries: 0 },
  });
  const configure = async (install: string): Promise<void> => {
    await writeFile(
      join(data, 'config.yaml'),
      `clients:\n  codex:\n    enabled: false\n  adapters:\n    install: ${install}\n    registry: ${registry.url}\n`,
    );
  };
  const installedEntry = (): string =>
    join(
      dataPaths(data).adapters,
      'claude-agent-acp',
      '1.2.3',
      'node_modules',
      'fake-acp',
      'dist',
      'index.js',
    );

  it('auto: installs the missing adapter of a client that is in PATH', async () => {
    await configure('auto');
    const result = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      { adapters: seams() },
      { ...real, find: onlyClient },
    );
    const text = result.out.join('\n');
    expect(result.code).toBe(0);
    expect(text).toContain('Installing claude-agent-acp');
    expect(text).toContain('Installed claude-agent-acp');
    expect(registry.requests.length).toBeGreaterThan(0);
    expect(existsSync(installedEntry())).toBe(true);
    // A second run finds it already there and goes to no registry.
    const before = registry.requests.length;
    const again = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      { adapters: seams() },
      { ...real, find: onlyClient },
    );
    expect(again.out.join('\n')).toContain('installed by OTheater');
    expect(registry.requests.length).toBe(before);
  });

  it('ask: installs after a yes and leaves it after a no', async () => {
    await configure('ask');
    const questions: string[] = [];
    const no = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      {
        adapters: seams(),
        confirm: (question) => {
          questions.push(question);
          return Promise.resolve(false);
        },
      },
      { ...real, find: onlyClient },
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain(registry.url);
    expect(no.out.join('\n')).toContain('ot adapters install');
    expect(registry.requests).toEqual([]);
    expect(existsSync(installedEntry())).toBe(false);

    const yes = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      { adapters: seams(), confirm: () => Promise.resolve(true) },
      { ...real, find: onlyClient },
    );
    expect(yes.out.join('\n')).toContain('Installed claude-agent-acp');
    expect(existsSync(installedEntry())).toBe(true);
  });

  it('command: only shows "ot adapters install"; off: says it is off', async () => {
    await configure('command');
    const command = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      { adapters: seams() },
      { ...real, find: onlyClient },
    );
    expect(command.out.join('\n')).toContain('ot adapters install');
    await configure('off');
    const off = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      { adapters: seams() },
      { ...real, find: onlyClient },
    );
    expect(off.out.join('\n')).toContain('clients.adapters.install is off');
    expect(registry.requests).toEqual([]);
  });

  it('without the official client in PATH it installs nothing and says the adapter comes with it', async () => {
    await configure('auto');
    const result = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      { adapters: seams() },
      { ...real, find: nothing },
    );
    expect(result.out.join('\n')).toContain('it comes with claude');
    expect(registry.requests).toEqual([]);
  });

  it('an install that fails is reported, counted as missing, and init still succeeds', async () => {
    await configure('auto');
    registry.failNext(404, 50);
    const result = await ot(
      ['init', '--no-tui'],
      serviceThatStartsTheDaemon(),
      { adapters: seams() },
      { ...real, find: onlyClient },
    );
    expect(result.code).toBe(0);
    expect(result.err.join('\n')).toContain('Could not install claude-agent-acp');
    expect(result.out.join('\n')).toContain('"ot adapters install" tries again');
    expect(existsSync(installedEntry())).toBe(false);
  });
});
