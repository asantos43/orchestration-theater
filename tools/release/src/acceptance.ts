// SPDX-License-Identifier: MPL-2.0
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleManifest, executableAssetName } from './manifest.js';
import {
  generateEphemeralKey,
  publicPemOf,
  signManifest,
  signManifestSshsig,
  sshPublicKeyLine,
} from './sign.js';
import { DAEMON_READY, PTY_SCRIPT } from './smoke.js';
import { hostTarget, type TargetId } from './targets.js';

/**
 * The acceptance of the distribution (Phase 10, P12; docs/21): the rows of the table of P12, run
 * from the outside against two real single executables (N, the one installed, and N+1, the update)
 * that embed a key made for the run. Nothing real is touched: a temporary HOME and data folder, a
 * release server on the loopback signed by a key made here (never the production one), no client,
 * no login, no network. The daemon runs as a child of this process; the logon service is not
 * registered here (the jobs of P4 and P5 run it on the runners, and the workflow reports which
 * path ran on each system). [proposta]
 *
 * What it does not do, and why (P12, "Como ficou"): a play in progress. The Director and the
 * Executors of a real daemon come from profiles of a real client (`ot profile add` asks the vault
 * for a master password and the clients are the three official ones), so the fake agent cannot
 * take their place in a built executable; the waits of `idle` and `park` with a running attempt
 * are covered by `packages/daemon/src/updates/apply/coordinator.test.ts`. Here `idle` and `park`
 * run with the daemon quiet, and the scenario of the chat stays open across the TUI and the swap.
 */

export interface AcceptanceOptions {
  /** The executable built as version `versionN`, with the public half of `keyFile` embedded. */
  readonly exeN: string;
  readonly versionN: string;
  /** The executable built as version `versionN1` (greater than `versionN`), same key. */
  readonly exeN1: string;
  readonly versionN1: string;
  /** The PEM of the private key of the run (`ephemeral-key`), used only to sign. */
  readonly privateKeyFile: string;
  /** `installer/install.sh`. Used on macOS and Linux; Windows installs by copying (the msi has its own job). */
  readonly installScript: string;
  /** The store schema of the daemon, to build a manifest that asks for a backup. */
  readonly ownSchemas: { readonly store: number; readonly telemetry: number };
  /** Where the temporary folder goes. Default: the system one. */
  readonly workDir?: string | undefined;
  /** Keep the temporary folder (for a person to look at). */
  readonly keep?: boolean | undefined;
  readonly log: (line: string) => void;
  /** Platform of the machine. Default: `process.platform`. */
  readonly platform?: NodeJS.Platform | undefined;
}

export interface AcceptanceStep {
  readonly name: string;
  readonly ok: boolean;
  /** `skipped`: the machine cannot do it (and the detail says why); it is not a failure. */
  readonly skipped: boolean;
  readonly detail: string;
  readonly ms: number;
}

export interface AcceptanceResult {
  readonly ok: boolean;
  readonly steps: readonly AcceptanceStep[];
  /** `service`: a logon service ran the daemon; `child`: this process did (always, here). */
  readonly daemonPath: 'child';
}

class Skip extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(
  what: string,
  timeoutMs: number,
  read: () => Promise<T | undefined> | T | undefined,
  everyMs = 250,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let value: T | undefined;
    try {
      value = await read();
    } catch {
      value = undefined;
    }
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out after ${String(timeoutMs)} ms: ${what}`);
    await sleep(everyMs);
  }
}

// ---- the release server ----------------------------------------------------------------------

interface ReleaseServer {
  /** `http://127.0.0.1:<port>/releases`, no trailing slash. */
  readonly base: string;
  readonly files: Map<string, Buffer>;
  close(): Promise<void>;
}

async function startReleaseServer(): Promise<ReleaseServer> {
  const files = new Map<string, Buffer>();
  const server: Server = createServer((request, response) => {
    const url = request.url ?? '';
    const name = url.startsWith('/releases/') ? decodeURIComponent(url.slice(10)) : undefined;
    const body = name === undefined ? undefined : files.get(name);
    if (body === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(port)}/releases`,
    files,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
        server.closeAllConnections();
      }),
  };
}

// ---- a release: manifest, signatures, executable --------------------------------------------

interface PublishSpec {
  /** The version the manifest says. */
  readonly version: string;
  /** The executable that is served. */
  readonly exe: string;
  /** The key that signs. Default: the key of the run. */
  readonly signWith?: string | undefined;
  readonly schemas?: { store: number; telemetry: number } | undefined;
  /** Changes the manifest text after it was assembled and before it is signed. */
  readonly edit?: ((manifest: string) => string) | undefined;
  /** Changes the manifest text after it was signed (the signature then no longer fits). */
  readonly tamper?: ((manifest: string) => string) | undefined;
  /** The SHA-256 the manifest says, when it must differ from the file served (signed all the same). */
  readonly lieSha256?: string | undefined;
}

interface Run {
  readonly options: AcceptanceOptions;
  readonly platform: NodeJS.Platform;
  readonly target: TargetId;
  readonly root: string;
  readonly home: string;
  readonly data: string;
  readonly env: NodeJS.ProcessEnv;
  readonly privatePem: string;
  readonly server: ReleaseServer;
  /** Where the installed executable is, once installed. */
  installed: string;
  daemon: ChildProcess | undefined;
  /** The output of the last daemon started as a child (the one the applier starts is not ours). */
  daemonOutput: () => string;
}

async function publish(run: Run, spec: PublishSpec): Promise<void> {
  const dir = mkdtempSync(path.join(run.root, 'release-'));
  const name = executableAssetName(run.target);
  copyFileSync(spec.exe, path.join(dir, name));
  const assembled = await assembleManifest({
    version: spec.version,
    channel: 'stable',
    assets: [{ platform: run.target, kind: 'exe', file: path.join(dir, name) }],
    schemas: spec.schemas,
    validityDays: 30,
  });
  let text = assembled.bytes.toString('utf8');
  if (spec.lieSha256 !== undefined) {
    const real = createHash('sha256').update(readFileSync(spec.exe)).digest('hex');
    text = text.replace(real, spec.lieSha256);
  }
  if (spec.edit !== undefined) text = spec.edit(text);
  const signed = Buffer.from(text);
  const key = spec.signWith ?? run.privatePem;
  const files = run.server.files;
  const served = spec.tamper === undefined ? signed : Buffer.from(spec.tamper(text));
  files.set('manifest.json', served);
  files.set('manifest.json.sig', Buffer.from(signManifest(signed, key)));
  files.set('manifest.json.sshsig', Buffer.from(signManifestSshsig(signed, key)));
  files.set(name, readFileSync(path.join(dir, name)));
  rmSync(dir, { recursive: true, force: true });
}

// ---- processes --------------------------------------------------------------------------------

interface Finished {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
): Promise<Finished> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function sandboxEnv(
  root: string,
  platform: NodeJS.Platform,
): { home: string; data: string; env: NodeJS.ProcessEnv } {
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  for (const dir of [home, data, path.join(root, 'client')]) mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    // The PATH of the machine: the daemon needs `git`, and no client is configured, so none is started.
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'share'),
    XDG_STATE_HOME: path.join(home, 'state'),
    OT_CLIENT_CONFIG_DIR: path.join(root, 'client'),
    OT_DATA_DIR: data,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
  };
  if (platform === 'win32') {
    for (const key of ['SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  return { home, data, env };
}

/** The `config.yaml` of the daemon in the run. The keys of `updates` are the ones under test. */
function writeConfig(r: Run, updates: { apply_when: string; health_timeout?: string }): void {
  const text = `ui:
  locale: en
adapters:
  vault: encrypted-file
  code_host: fake
vault:
  scrypt: { N: 16384, r: 8, p: 1 }
backup:
  when: manual
  content: store_only
sandbox:
  mode: 'off'
updates:
  mode: auto
  channel: stable
  source: url
  url: ${r.server.base}
  check_interval: off
  apply_when: ${updates.apply_when}
  rollback: auto
  health_timeout: ${updates.health_timeout ?? '60s'}
  manifest_expiry: enforce
`;
  writeFileSync(path.join(r.data, 'config.yaml'), text);
}

interface Api {
  get(route: string): Promise<unknown>;
  send(method: string, route: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  events(prefix: string): Promise<Record<string, unknown>[]>;
}

function readDiscovery(data: string): { url: string; pid: number } | undefined {
  try {
    return JSON.parse(readFileSync(path.join(data, 'api.json'), 'utf8')) as {
      url: string;
      pid: number;
    };
  } catch {
    return undefined;
  }
}

function apiOf(data: string): Api {
  const call = async (
    method: string,
    route: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> => {
    const info = readDiscovery(data);
    if (info === undefined) throw new Error('no api.json');
    const token = readFileSync(path.join(data, 'api-token'), 'utf8').trim();
    const response = await fetch(`${info.url}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
  };
  return {
    get: async (route) => {
      const answer = await call('GET', route);
      if (answer.status !== 200) throw new Error(`GET ${route} answered ${String(answer.status)}`);
      return answer.body;
    },
    send: call,
    events: async (prefix) => {
      const info = readDiscovery(data);
      if (info === undefined) throw new Error('no api.json');
      const token = readFileSync(path.join(data, 'api-token'), 'utf8').trim();
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, 2500);
      let text = '';
      try {
        const response = await fetch(`${info.url}/v1/events?since=0&types=${prefix}`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const reader = response.body?.getReader();
        if (reader === undefined) return [];
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += Buffer.from(chunk.value).toString('utf8');
        }
      } catch {
        // The window ended: the history came first, and what the stream held is in `text`.
      } finally {
        clearTimeout(timer);
      }
      const found: Record<string, unknown>[] = [];
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          found.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
        } catch {
          // A line the window cut in the middle.
        }
      }
      return found;
    },
  };
}

interface Status {
  state?: string;
  version?: string;
  pid?: number;
}

async function statusOf(r: Run): Promise<Status | undefined> {
  try {
    return (await apiOf(r.data).get('/v1/status')) as Status;
  } catch {
    return undefined;
  }
}

/** Starts the daemon of the installed executable as a child and waits for it to answer. */
async function startDaemon(r: Run): Promise<number> {
  const child = spawn(r.installed, ['daemon', '--data-dir', r.data], {
    env: r.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  r.daemon = child;
  let seen = '';
  r.daemonOutput = () => seen;
  child.stdout.on('data', (chunk: Buffer) => (seen += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (seen += chunk.toString('utf8')));
  try {
    await until(
      'the daemon says it is running',
      90_000,
      () => (seen.includes(DAEMON_READY) ? true : undefined),
      100,
    );
    return await until('the API answers', 30_000, async () => {
      const status = await statusOf(r);
      return status?.state === 'running' ? status.pid : undefined;
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${(error as Error).message} (output: ${seen.slice(-400)})`, { cause: error });
  }
}

/** Stops whatever daemon answers in the data folder (the child, or the one the applier started). */
async function stopDaemon(r: Run): Promise<void> {
  const info = readDiscovery(r.data);
  const pid = info?.pid;
  if (pid !== undefined) {
    try {
      process.kill(pid, r.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // Already gone.
    }
    await until('the daemon to end', 30_000, () => {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch {
        return true;
      }
    }).catch(() => {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Gone.
      }
    });
  }
  r.daemon = undefined;
}

// ---- the installation -------------------------------------------------------------------------

function installedPath(r: Run): string {
  if (r.platform === 'win32')
    return path.join(r.home, 'AppData', 'Local', 'OTheater', 'bin', 'otheater.exe');
  return path.join(r.home, '.local', 'share', 'otheater', 'bin', 'otheater');
}

function opensslChecks(openssl: string): boolean {
  const help = spawnSync(openssl, ['pkeyutl', '-help'], { encoding: 'utf8', timeout: 20_000 });
  return `${help.stdout}${help.stderr}`.includes('rawin');
}

async function installBy(r: Run, version: string): Promise<string> {
  if (r.platform === 'win32') {
    mkdirSync(path.dirname(r.installed), { recursive: true });
    copyFileSync(version === r.options.versionN ? r.options.exeN : r.options.exeN1, r.installed);
    return 'copied into the folder of the user (the msi has its own job: test-install.ps1)';
  }
  const openssl = process.env.OT_TEST_OPENSSL ?? 'openssl';
  const keyFile = path.join(r.root, 'update-public-key');
  const publicPem = publicPemOf(r.privatePem);
  writeFileSync(keyFile, opensslChecks(openssl) ? publicPem : `${sshPublicKeyLine(publicPem)}\n`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: r.home,
    LANG: 'en_US.UTF-8',
    OT_DATA_DIR: r.data,
    OT_INSTALL_BASE_URL: r.server.base,
    OT_INSTALL_PUBLIC_KEY_FILE: keyFile,
    OT_INSTALL_OPENSSL: openssl,
    OT_INSTALL_ALLOW_KEY_OVERRIDE: '1',
    OT_INSTALL_SERVICE: 'off',
  };
  const ended = await run('sh', [r.options.installScript], env);
  if (ended.code !== 0) {
    throw new Error(
      `install.sh exited ${String(ended.code)}: ${(ended.stderr || ended.stdout).slice(-400)}`,
    );
  }
  return 'install.sh, signature checked against the key of the run, service off';
}

async function versionOf(exe: string, env: NodeJS.ProcessEnv): Promise<string> {
  const ended = await run(exe, ['--version'], env, 30_000);
  return ended.stdout.trim();
}

// ---- the TUI ------------------------------------------------------------------------------------

/** Opens the TUI in a pseudo terminal, waits for its first screen and kills it (a closed window). */
const PTY_CLOSE = String.raw`
import json, os, pty, select, signal, sys, time, struct, fcntl, termios
exe, data = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.execv(exe, [exe, '--ot-internal=tui', '--data-dir', data])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
out = b''
end = time.time() + 40
while time.time() < end and b'OTheater' not in out:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if ready:
        try:
            out += os.read(fd, 65536)
        except OSError:
            break
time.sleep(1.5)
os.kill(pid, signal.SIGKILL)
os.waitpid(pid, 0)
print(json.dumps({'shown': b'OTheater' in out}))
`;

async function pythonHasPty(r: Run): Promise<boolean> {
  const probe = await run('python3', ['-I', '-c', 'import pty'], r.env, 15_000);
  return probe.code === 0;
}

// ---- the steps ----------------------------------------------------------------------------------

type StepBody = (r: Run) => Promise<string>;

const eventsOf = async (
  r: Run,
): Promise<{ phase: string; reason: string | null; version: string | null }[]> => {
  const all = await apiOf(r.data).events('daemon.update');
  return all.map((event) => {
    const payload = event.payload as {
      phase: string;
      reason: string | null;
      version: string | null;
    };
    return { phase: payload.phase, reason: payload.reason, version: payload.version };
  });
};

async function checkUpdate(r: Run): Promise<unknown> {
  const answer = await apiOf(r.data).send('POST', '/v1/updates/check');
  if (answer.status !== 200)
    throw new Error(`POST /v1/updates/check answered ${String(answer.status)}`);
  return answer.body;
}

/** A bad release: the daemon refuses it with a `rejected` event and stays as it is. */
async function refuseCase(
  r: Run,
  label: string,
  spec: PublishSpec,
  expectedReason: string | RegExp,
): Promise<string> {
  const before = (await eventsOf(r)).filter((event) => event.phase === 'rejected').length;
  const pidBefore = (await statusOf(r))?.pid;
  await publish(r, spec);
  await checkUpdate(r);
  const rejected = await until(`a "rejected" event for ${label}`, 30_000, async () => {
    const all = (await eventsOf(r)).filter((event) => event.phase === 'rejected');
    return all.length > before ? all[all.length - 1] : undefined;
  });
  const reason = rejected.reason ?? '';
  const matches =
    typeof expectedReason === 'string' ? reason === expectedReason : expectedReason.test(reason);
  if (!matches)
    throw new Error(`${label}: rejected for "${reason}", expected ${String(expectedReason)}`);
  const status = await statusOf(r);
  if (status?.version !== r.options.versionN || status.pid !== pidBefore) {
    throw new Error(`${label}: the daemon changed (version ${String(status?.version)})`);
  }
  const staged = existsSync(path.join(path.dirname(r.installed), 'previous'));
  if (staged) throw new Error(`${label}: a previous/ folder exists, so something was applied`);
  return `rejected (${reason}), version ${status.version} and pid intact`;
}

/** The update, applied by the daemon at the moment `apply_when` says. */
async function updateCase(r: Run, when: 'idle' | 'park'): Promise<string> {
  const { versionN, versionN1, exeN1 } = r.options;
  writeConfig(r, { apply_when: when });
  await stopDaemon(r);
  const pidN = await startDaemon(r);
  await publish(r, { version: versionN1, exe: exeN1 });
  await checkUpdate(r);
  // The applier replaces the executable and starts the new daemon; the old one ends by itself.
  const status = await until(
    `the daemon at version ${versionN1}`,
    180_000,
    async () => {
      const now = await statusOf(r);
      return now?.version === versionN1 && now.pid !== pidN ? now : undefined;
    },
    1000,
  );
  // The new daemon holds the swap for a stable period before it commits (`stableMs` of the journal).
  const journal = await until(
    'the journal to say committed',
    180_000,
    () => {
      const now = JSON.parse(
        readFileSync(path.join(path.dirname(r.installed), 'update-state.json'), 'utf8'),
      ) as {
        step: string;
        from: string;
        to: string;
      };
      return now.step === 'committed' ? now : undefined;
    },
    1000,
  );
  if (journal.from !== versionN || journal.to !== versionN1) {
    throw new Error(`the journal says ${JSON.stringify(journal)}`);
  }
  const phases = (await eventsOf(r)).map((event) => event.phase);
  for (const phase of ['found', 'downloaded', 'verified', 'applying', 'applied']) {
    if (!phases.includes(phase))
      throw new Error(`no daemon.update "${phase}" event (got ${phases.join(', ')})`);
  }
  const exeVersion = await versionOf(r.installed, r.env);
  if (!exeVersion.includes(versionN1))
    throw new Error(`the installed executable says "${exeVersion}"`);
  if (!existsSync(path.join(path.dirname(r.installed), 'previous')))
    throw new Error('no previous/ to roll back to');
  return `apply_when ${when}: ${versionN} -> ${versionN1}, journal committed, pid ${String(pidN)} -> ${String(status.pid)}${retriesNote(r)}`;
}

/** The new version does not come up (it says a version other than the manifest's): back to N, store restored. */
async function rollbackCase(r: Run): Promise<string> {
  const { versionN, versionN1, exeN1 } = r.options;
  writeConfig(r, { apply_when: 'park', health_timeout: '20s' });
  await stopDaemon(r);
  const pidN = await startDaemon(r);
  // A marker in the store before the update: the backup taken before the swap must hold it.
  const marker = path.join(r.data, 'acceptance-marker.txt');
  writeFileSync(marker, 'before the update\n');
  const wrong = `${versionN1}-wrong`;
  await publish(r, {
    version: wrong,
    exe: exeN1,
    schemas: { store: r.options.ownSchemas.store + 1, telemetry: r.options.ownSchemas.telemetry },
  });
  await checkUpdate(r);
  const rolled = await until(
    'the journal to say rolled_back',
    240_000,
    () => {
      try {
        const journal = JSON.parse(
          readFileSync(path.join(path.dirname(r.installed), 'update-state.json'), 'utf8'),
        ) as {
          step: string;
          backup: string | null;
          reason: string | null;
        };
        return journal.step === 'rolled_back' ? journal : undefined;
      } catch {
        return undefined;
      }
    },
    1000,
  );
  // The daemon starts but answers another version than the manifest's: the health reads `down`, so the reason is `not_started` on every system (anything else is a swap that failed).
  if (rolled.reason !== 'not_started')
    throw new Error(`the rollback says the reason ${String(rolled.reason)}, not not_started`);
  if (rolled.backup === null)
    throw new Error('no backup was taken before the swap (manifest schemas above the daemon)');
  const status = await until(
    `the old daemon (${versionN}) back`,
    120_000,
    async () => {
      const now = await statusOf(r);
      return now?.version === versionN && now.pid !== pidN ? now : undefined;
    },
    1000,
  );
  const phases = (await eventsOf(r)).map((event) => event.phase);
  if (!phases.includes('rolled_back'))
    throw new Error(`no daemon.update "rolled_back" event (got ${phases.join(', ')})`);
  const exeVersion = await versionOf(r.installed, r.env);
  if (!exeVersion.includes(versionN))
    throw new Error(`the executable after the rollback says "${exeVersion}"`);
  rmSync(marker, { force: true });
  return `${wrong}: rolled back to ${versionN} (reason ${rolled.reason}), backup ${path.basename(rolled.backup)} restored, new pid ${String(status.pid)}${retriesNote(r)}`;
}

/**
 * What the applier had to repeat so far (a rename that the system refused for a moment, as Windows does
 * while a scan or a process that just ended still holds a file), from its log: `""` when nothing, else
 * `; file calls repeated: place staged EPERM x3`. A pass that needed it says so, and does not hide it.
 */
function retriesNote(r: Run): string {
  const text = tailOf(path.join(path.dirname(r.installed), 'update-apply.log'), 1_000_000);
  if (text === undefined) return '';
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('a file call was refused')) continue;
    try {
      const entry = JSON.parse(line) as { call?: string; code?: string };
      const key = `${entry.call ?? '?'} ${entry.code ?? '?'}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } catch {
      // A line that is not JSON is not one of ours.
    }
  }
  if (counts.size === 0) return '';
  return `; file calls repeated: ${[...counts].map(([key, n]) => `${key} x${String(n)}`).join(', ')}`;
}

/** The end of a text file, or undefined when it cannot be read. */
function tailOf(file: string, chars: number): string | undefined {
  try {
    const text = readFileSync(file, 'utf8');
    return text.length > chars ? `...${text.slice(-chars)}` : text;
  } catch {
    return undefined;
  }
}

/**
 * What a failed step leaves to read in the log of the run: the journal of the applier, the folder of the
 * executable, the end of each log there and in the data folder, and the end of the output of the daemon
 * child. A timeout alone says nothing of where the update stopped.
 */
function diagnosticsOf(r: Run): string[] {
  const lines: string[] = [];
  const add = (title: string, text: string | undefined): void => {
    if (text === undefined || text.trim() === '') return;
    lines.push(`--- ${title}`);
    for (const line of text.trimEnd().split(/\r?\n/)) lines.push(line);
  };
  if (r.installed !== '') {
    const bin = path.dirname(r.installed);
    try {
      add(`files in ${bin}`, readdirSync(bin).join(' '));
    } catch {
      // No folder: nothing to list.
    }
    add('update-state.json', tailOf(path.join(bin, 'update-state.json'), 2000));
    add('update-apply.log', tailOf(path.join(bin, 'update-apply.log'), 3000));
  }
  const logs: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      if (name.endsWith('.log')) logs.push(full);
      else if (depth > 0 && !name.includes('.')) walk(full, depth - 1);
    }
  };
  walk(r.data, 2);
  for (const file of logs.slice(0, 6)) add(path.relative(r.data, file), tailOf(file, 1500));
  add('output of the daemon child', r.daemonOutput().slice(-1500));
  return lines;
}

async function runSteps(
  r: Run,
  steps: [string, StepBody][],
  log: (line: string) => void,
): Promise<AcceptanceStep[]> {
  const done: AcceptanceStep[] = [];
  let broken = false;
  for (const [name, body] of steps) {
    const started = Date.now();
    if (broken) {
      done.push({
        name,
        ok: false,
        skipped: true,
        detail: 'not run: an earlier step failed',
        ms: 0,
      });
      continue;
    }
    try {
      const detail = await body(r);
      done.push({ name, ok: true, skipped: false, detail, ms: Date.now() - started });
      log(`  ok    ${name}: ${detail}`);
    } catch (error) {
      if (error instanceof Skip) {
        done.push({
          name,
          ok: true,
          skipped: true,
          detail: error.message,
          ms: Date.now() - started,
        });
        log(`  skip  ${name}: ${error.message}`);
        continue;
      }
      const detail = error instanceof Error ? error.message : String(error);
      done.push({ name, ok: false, skipped: false, detail, ms: Date.now() - started });
      log(`  FAIL  ${name}: ${detail}`);
      for (const line of diagnosticsOf(r)) log(`        | ${line}`);
      broken = true;
    }
  }
  return done;
}

export async function runAcceptance(options: AcceptanceOptions): Promise<AcceptanceResult> {
  const platform = options.platform ?? process.platform;
  const target = hostTarget();
  if (target === undefined) throw new Error('this machine is not a target of the release');
  const base = options.workDir ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(path.join(base, 'otheater-accept-'));
  const { home, data, env } = sandboxEnv(root, platform);
  const server = await startReleaseServer();
  const r: Run = {
    options,
    platform,
    target,
    root,
    home,
    data,
    env,
    privatePem: readFileSync(options.privateKeyFile, 'utf8'),
    server,
    installed: '',
    daemon: undefined,
    daemonOutput: () => '',
  };
  r.installed = installedPath(r);
  const { versionN, versionN1, exeN, exeN1 } = options;
  const otherKey = generateEphemeralKey().privatePem;
  const log = options.log;
  log(
    `acceptance on ${platform} (${target}); versions ${versionN} -> ${versionN1}; sandbox ${root}`,
  );

  const steps: [string, StepBody][] = [
    [
      'install',
      async (run0) => {
        await publish(run0, { version: versionN, exe: exeN });
        const how = await installBy(run0, versionN);
        const says = await versionOf(run0.installed, run0.env);
        if (!says.includes(versionN)) throw new Error(`the installed executable says "${says}"`);
        return `${how}; ${run0.installed} says ${says}`;
      },
    ],
    [
      'first start and the state that must survive',
      async (run0) => {
        writeConfig(run0, { apply_when: 'idle' });
        const pid = await startDaemon(run0);
        writeFileSync(path.join(run0.data, 'acceptance-data.txt'), 'the data of the user\n');
        const api = apiOf(run0.data);
        const layout = {
          version: 2,
          sidebarCollapsed: true,
          chatWidth: 72,
          openTabs: ['overview'],
          collapsedSections: [],
        };
        const put = await api.send('PUT', '/v1/layout/tui', layout);
        if (put.status !== 200)
          throw new Error(`PUT /v1/layout/tui answered ${String(put.status)}`);
        return `daemon ${versionN} pid ${String(pid)}; layout of the TUI saved in the daemon`;
      },
    ],
    [
      'close the TUI, the daemon goes on, reopen with the state and the layout',
      async (run0) => {
        if (run0.platform === 'win32' || !(await pythonHasPty(run0))) {
          throw new Skip(
            'no pseudo terminal here (Windows, or no python3): the TUI is checked by smoke on the runners that have one',
          );
        }
        const pidBefore = (await statusOf(run0))?.pid;
        const closed = await run(
          'python3',
          ['-I', '-c', PTY_CLOSE, run0.installed, run0.data],
          run0.env,
          120_000,
        );
        if (!closed.stdout.includes('"shown": true'))
          throw new Error(
            `the TUI did not draw (${closed.stdout.slice(-200)} ${closed.stderr.slice(-200)})`,
          );
        const after = await statusOf(run0);
        if (after?.state !== 'running' || after.pid !== pidBefore)
          throw new Error('the daemon did not outlive the TUI');
        const reopened = await run(
          'python3',
          ['-I', '-c', PTY_SCRIPT, run0.installed, run0.data, path.dirname(run0.installed)],
          run0.env,
          120_000,
        );
        const report = JSON.parse(reopened.stdout.trim().split('\n').pop() ?? '{}') as {
          code?: number;
          connected?: boolean;
          alt?: boolean;
        };
        if (report.code !== 0 || report.connected !== true || report.alt !== true) {
          throw new Error(
            `the reopened TUI: ${reopened.stdout.slice(-300)} ${reopened.stderr.slice(-200)}`,
          );
        }
        const layout = (await apiOf(run0.data).get('/v1/layout/tui')) as {
          chatWidth?: number;
          sidebarCollapsed?: boolean;
        };
        if (layout.chatWidth !== 72 || layout.sidebarCollapsed !== true)
          throw new Error(`the layout came back as ${JSON.stringify(layout)}`);
        return 'TUI killed (window closed): daemon kept its pid; reopened in a pseudo terminal, connected, layout (chatWidth 72, sidebar collapsed) intact';
      },
    ],
    [
      'refuse: signature of another key',
      (run0) =>
        refuseCase(
          run0,
          'other key',
          { version: versionN1, exe: exeN1, signWith: otherKey },
          'signature',
        ),
    ],
    [
      'refuse: tampered manifest',
      (run0) =>
        refuseCase(
          run0,
          'tampered manifest',
          {
            version: versionN1,
            exe: exeN1,
            tamper: (text) => text.replace(`"${versionN1}"`, '"9.9.9"'),
          },
          'signature',
        ),
    ],
    [
      'refuse: SHA-256 swapped (signed, but not the file served)',
      (run0) =>
        refuseCase(
          run0,
          'swapped sha256',
          { version: versionN1, exe: exeN1, lieSha256: '0'.repeat(64) },
          'sha256',
        ),
    ],
    [
      'refuse: downgrade',
      async (run0) => {
        // The manifest is signed and good, but its version is not above the installed one.
        const before = (await eventsOf(run0)).length;
        await publish(run0, { version: '0.0.1', exe: exeN });
        await checkUpdate(run0);
        const status = await statusOf(run0);
        if (status?.version !== versionN)
          throw new Error(`the daemon says ${String(status?.version)}`);
        const news = (await eventsOf(run0)).slice(before);
        const phases = news.map(
          (event) => `${event.phase}${event.reason === null ? '' : `:${event.reason}`}`,
        );
        if (
          phases.some((phase) =>
            ['found', 'downloaded', 'applying', 'applied'].includes(phase.split(':')[0] ?? ''),
          )
        ) {
          throw new Error(`the daemon went on with a downgrade (${phases.join(', ')})`);
        }
        return `version ${versionN} kept; events: ${phases.length === 0 ? 'none (nothing newer)' : phases.join(', ')}`;
      },
    ],
    ['rollback: N+1 does not come up, the store is restored from the backup', rollbackCase],
    ['update with apply_when idle', (run0) => updateCase(run0, 'idle')],
    [
      'uninstall, the data stays',
      async (run0) => {
        await stopDaemon(run0);
        await publish(run0, { version: versionN, exe: exeN });
        if (run0.platform === 'win32') {
          rmSync(path.dirname(run0.installed), { recursive: true, force: true });
        } else {
          const ended = await run('sh', [options.installScript, '--uninstall', '--yes'], {
            PATH: process.env.PATH,
            HOME: run0.home,
            LANG: 'en_US.UTF-8',
            OT_DATA_DIR: run0.data,
            OT_INSTALL_SERVICE: 'off',
          });
          if (ended.code !== 0)
            throw new Error(
              `install.sh --uninstall exited ${String(ended.code)}: ${(ended.stderr || ended.stdout).slice(-300)}`,
            );
        }
        if (existsSync(run0.installed)) throw new Error('the executable is still there');
        if (
          !existsSync(path.join(run0.data, 'acceptance-data.txt')) ||
          !existsSync(path.join(run0.data, 'store.sqlite'))
        ) {
          throw new Error('the data folder lost files');
        }
        // `install.sh --uninstall` only removes what it installed: what the updates left in the
        // folder of the executable (previous/, staging/, the journal) stays. It is not a failure of
        // the row (the data is intact), but the report says it.
        const left = existsSync(path.dirname(run0.installed))
          ? readdirSync(path.dirname(run0.installed))
          : [];
        return `executable gone; the data folder (store, config, file of the user) is intact${
          left.length === 0 ? '' : `; left in the folder of the executable: ${left.join(', ')}`
        }`;
      },
    ],
    [
      'install again over the old data, and update with apply_when park',
      async (run0) => {
        await publish(run0, { version: versionN, exe: exeN });
        await installBy(run0, versionN);
        const says = await versionOf(run0.installed, run0.env);
        if (!says.includes(versionN)) throw new Error(`the installed executable says "${says}"`);
        return await updateCase(run0, 'park');
      },
    ],
  ];

  try {
    const done = await runSteps(r, steps, log);
    return { ok: done.every((step) => step.ok), steps: done, daemonPath: 'child' };
  } finally {
    await stopDaemon(r).catch(() => undefined);
    await server.close();
    if (options.keep !== true) {
      // Windows keeps a file locked for a moment after its process ended: the folder is temporary,
      // so a cleanup that still fails is a warning, never the verdict of the acceptance.
      await sleep(1000);
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (error) {
        log(`  warn  the temporary folder was not removed: ${(error as Error).message}`);
      }
    }
  }
}
