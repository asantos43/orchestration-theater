// SPDX-License-Identifier: MPL-2.0
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  integrityOf,
  makeTarball,
  tarballPath,
  type FixtureAdapter,
  type FixtureFile,
} from '../adapters/adapter-fixture.js';
import { parseAdapterLock } from '../adapters/lock.js';
import { CRASH_AT_VARIABLE, FAULT_VARIABLE } from './faults.js';

/**
 * What the chaos tests of the updates (Phase 11, P6; docs/23) are made of: child processes that run
 * the compiled daemon (`packages/daemon/dist`, so `pnpm build` comes first), a fake npm registry
 * that can stop in the middle of a body, a fake daemon the applier starts for real, and the small
 * helpers that wait for a signal (a line, a file, a pid gone) and never for a time.
 * Nothing here is a real package, a real key or a real service. Tests only.
 */

export const DAEMON_DIST = fileURLToPath(new URL('../../dist', import.meta.url));

export const LINUX_X64 = { os: 'linux', cpu: 'x64', libc: 'glibc' } as const;

/** The directory of one run: everything a test writes is inside it, and `afterEach` removes it. */
export async function makeRunDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ot-chaos-p6-'));
  await mkdir(join(dir, 'home'), { recursive: true });
  return dir;
}

export async function removeRunDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export async function waitUntil(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Not reached in ${String(timeoutMs)} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  // A zombie still answers `kill 0`: the state in /proc says it is over.
  try {
    const text = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const state = text.slice(text.lastIndexOf(')') + 2, text.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

export async function waitGone(pid: number, timeoutMs = 30_000): Promise<void> {
  await waitUntil(`pid ${String(pid)} is gone`, () => !pidAlive(pid), timeoutMs);
}

/** SIGTERM and wait; a pid that is gone already is fine. Only ever called with a pid of the run. */
export async function stopPid(pid: number): Promise<void> {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  try {
    await waitGone(pid, 15_000);
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // It ended in between.
    }
    await waitGone(pid, 10_000);
  }
}

// --- child processes -------------------------------------------------------------------------

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface Watched {
  readonly process: ChildProcess;
  readonly pid: number;
  readonly exited: Promise<ExitInfo>;
  output(): string;
  errors(): string;
  /** Resolves with the JSON after `prefix` on the first line that starts with it. */
  line(prefix: string, timeoutMs?: number): Promise<unknown>;
}

function watch(child: ChildProcess): Watched {
  let out = '';
  let err = '';
  const waiting: (() => void)[] = [];
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    out += chunk;
    for (const wake of waiting) wake();
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    err += chunk;
  });
  const exited = new Promise<ExitInfo>((resolve) => {
    child.on('exit', (code, signal) => {
      resolve({ code, signal });
    });
    child.on('close', () => {
      for (const wake of waiting) wake();
    });
  });
  return {
    process: child,
    pid: child.pid ?? 0,
    exited,
    output: () => out,
    errors: () => err,
    line: (prefix, timeoutMs = 120_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`No "${prefix}" line in ${String(timeoutMs)} ms.\n${out}\n${err}`));
        }, timeoutMs);
        const check = (): boolean => {
          const found = out.split('\n').find((candidate) => candidate.startsWith(prefix));
          if (found === undefined) return false;
          clearTimeout(timer);
          const rest = found.slice(prefix.length).trim();
          resolve(rest === '' ? null : JSON.parse(rest));
          return true;
        };
        if (check()) return;
        waiting.push(() => {
          if (child.exitCode !== null || child.signalCode !== null) {
            if (!out.includes(prefix)) {
              clearTimeout(timer);
              reject(new Error(`The child exited before "${prefix}".\n${out}\n${err}`));
              return;
            }
          }
          check();
        });
      }),
  };
}

/** The environment of a child: the one of the test without the faults, `HOME` inside the run. */
export function childEnv(
  runDir: string,
  extra: Readonly<Record<string, string | undefined>> = {},
): NodeJS.ProcessEnv {
  const merged: Record<string, string | undefined> = {
    ...process.env,
    HOME: join(runDir, 'home'),
    OT_CHILD_DIST: DAEMON_DIST,
    ...extra,
  };
  const dropped = new Set<string>([CRASH_AT_VARIABLE, FAULT_VARIABLE]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined && !(dropped.has(key) && !(key in extra))) env[key] = value;
  }
  return env;
}

export function spawnNode(
  runDir: string,
  script: string,
  args: readonly string[],
  extra: Readonly<Record<string, string | undefined>> = {},
): Watched {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: runDir,
    env: childEnv(runDir, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return watch(child);
}

/** The head of every child program: loads a module of the compiled daemon by its path in `dist`. */
const CHILD_HEAD = `
import { pathToFileURL } from 'node:url';
const load = (path) => import(pathToFileURL(process.env.OT_CHILD_DIST + '/' + path).href);
const { armFaults } = await load('chaos/crash-points.js');
const { resolveFaultPlan } = await load('chaos/faults.js');
armFaults(await resolveFaultPlan({ mode: 'env', env: process.env }));
`;

// --- the adapter ---------------------------------------------------------------------------

const ADAPTER_CHILD = `${CHILD_HEAD}
import { readFileSync } from 'node:fs';
const { installAdapter } = await load('adapters/install.js');
const { parseAdapterLock } = await load('adapters/lock.js');
const lock = parseAdapterLock(JSON.parse(readFileSync(process.env.OT_CHILD_LOCK, 'utf8')));
try {
  const result = await installAdapter({
    lock,
    adaptersDir: process.env.OT_CHILD_ADAPTERS_DIR,
    registry: process.env.OT_CHILD_REGISTRY,
    platform: { os: 'linux', cpu: 'x64', libc: 'glibc' },
    retries: 0,
    retryDelayMs: 0,
    concurrency: 1,
    requestTimeoutMs: 120000,
    lockWaitMs: Number(process.env.OT_CHILD_LOCK_WAIT_MS ?? '5000'),
    ...(process.env.OT_CHILD_LOCK_TAKEOVER ? { lockTakeover: process.env.OT_CHILD_LOCK_TAKEOVER } : {}),
  });
  console.log('RESULT ' + JSON.stringify({ status: result.status }));
} catch (error) {
  console.log('FAILED ' + JSON.stringify({ code: error.code, message: String(error.message) }));
  process.exitCode = 3;
}
`;

export interface AdapterChildInput {
  readonly runDir: string;
  readonly adaptersDir: string;
  readonly registry: string;
  readonly adapter: FixtureAdapter;
  /** `adapter.after_file#3`, for example (`OT_TEST_CRASH_AT`). */
  readonly crashAt?: string;
  readonly lockWaitMs?: number;
  readonly lockTakeover?: 'dead_owner' | 'stale_only';
}

/** Runs the installation of an adapter as a process of its own; the lock goes in a file of the run. */
export async function startAdapterChild(input: AdapterChildInput): Promise<Watched> {
  const scripts = join(input.runDir, 'scripts');
  await mkdir(scripts, { recursive: true });
  const script = join(scripts, 'adapter-child.mjs');
  await writeFile(script, ADAPTER_CHILD);
  const lockFile = join(scripts, `lock-${input.adapter.lock.version}.json`);
  await writeFile(lockFile, JSON.stringify(input.adapter.lock));
  return spawnNode(input.runDir, script, [], {
    OT_CHILD_LOCK: lockFile,
    OT_CHILD_ADAPTERS_DIR: input.adaptersDir,
    OT_CHILD_REGISTRY: input.registry,
    OT_CHILD_LOCK_WAIT_MS: String(input.lockWaitMs ?? 5000),
    OT_CHILD_LOCK_TAKEOVER: input.lockTakeover,
    [CRASH_AT_VARIABLE]: input.crashAt,
  });
}

const ADAPTER_ENTRY = `
import { writeFileSync } from 'node:fs';
const ready = process.env.OT_ADAPTER_READY;
if (ready) writeFileSync(ready, JSON.stringify({ version: process.env.OT_ADAPTER_VERSION, pid: process.pid }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => undefined, 1000);
`;

/**
 * A fake adapter `claude-agent-acp@<version>`: `fake-acp` (its entry is a program that stays alive,
 * the "session") and `fake-dep` with a few files and a blob big enough for the download to have a
 * middle. The files of one package are many, so a kill after the n-th file leaves a real half.
 */
export function chaosAdapter(version: string): FixtureAdapter {
  const dependency: FixtureFile[] = [
    { path: 'package.json', content: `{"name":"fake-dep","version":"${version}"}` },
    { path: 'lib/a.js', content: 'export const a = 1;\n' },
    { path: 'lib/b.js', content: 'export const b = 2;\n' },
    { path: 'lib/c.js', content: 'export const c = 3;\n' },
    { path: 'data/blob.txt', content: randomBytes(100_000).toString('hex') },
  ];
  const main: FixtureFile[] = [
    {
      path: 'package.json',
      content: `{"name":"fake-acp","version":"${version}","type":"module"}`,
    },
    { path: 'dist/index.js', content: ADAPTER_ENTRY, mode: 0o755 },
    { path: 'dist/util.js', content: 'export const util = 1;\n' },
    { path: 'README.md', content: `fake-acp ${version}\n` },
  ];
  const packages = [
    { path: 'node_modules/fake-acp', name: 'fake-acp', files: main },
    { path: 'node_modules/fake-dep', name: 'fake-dep', files: dependency },
  ];
  const tarballs = new Map<string, Buffer>();
  const entries = packages.map((pkg) => {
    const tarball = makeTarball(pkg.files);
    tarballs.set(tarballPath(pkg.name, version), tarball);
    return {
      path: pkg.path,
      name: pkg.name,
      version,
      integrity: integrityOf(tarball),
    };
  });
  const lock = parseAdapterLock({
    schema: 1,
    id: 'claude-agent-acp',
    package: 'fake-acp',
    version,
    entry: 'dist/index.js',
    entries,
  });
  return { lock, tarballs };
}

export type RegistryMode = 'serve' | 'hold-half' | 'cut-half' | 'short' | { status: number };

/**
 * A registry on the loopback that can serve half of a body and stop (`hold-half` keeps the
 * connection open until the test kills the downloader; `cut-half` closes it), serve a body shorter
 * than the tarball (a file that arrived cut, with a length that matches), answer with an error, or
 * be switched off and on again at the same port.
 */
export class ChaosRegistry {
  readonly requests: string[] = [];
  readonly #tarballs: Map<string, Buffer>;
  readonly #modes = new Map<string, RegistryMode>();
  readonly #reached = new Map<string, () => void>();
  readonly #reachedPromise = new Map<string, Promise<void>>();
  #server: Server | undefined;
  #port = 0;

  private constructor(adapters: readonly FixtureAdapter[]) {
    this.#tarballs = new Map();
    for (const adapter of adapters)
      for (const [path, data] of adapter.tarballs) this.#tarballs.set(path, data);
  }

  static async start(...adapters: FixtureAdapter[]): Promise<ChaosRegistry> {
    const registry = new ChaosRegistry(adapters);
    await registry.#listen(0);
    return registry;
  }

  get url(): string {
    return `http://127.0.0.1:${String(this.#port)}`;
  }

  /** What `path` does from now on. */
  mode(path: string, mode: RegistryMode): void {
    this.#modes.set(path, mode);
  }

  /** Resolves when a request for `path` has been given half of its body (`hold-half`, `cut-half`). */
  reached(path: string): Promise<void> {
    let promise = this.#reachedPromise.get(path);
    if (promise === undefined) {
      promise = new Promise<void>((resolve) => {
        this.#reached.set(path, resolve);
      });
      this.#reachedPromise.set(path, promise);
    }
    return promise;
  }

  async #listen(port: number): Promise<void> {
    const server = createServer((request, response) => {
      this.#answer(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
  }

  #answer(request: IncomingMessage, response: ServerResponse): void {
    const path = request.url ?? '';
    this.requests.push(path);
    const data = this.#tarballs.get(path);
    if (data === undefined) {
      response.writeHead(404).end();
      return;
    }
    const mode = this.#modes.get(path) ?? 'serve';
    if (typeof mode === 'object') {
      response.writeHead(mode.status).end();
      return;
    }
    const half = data.subarray(0, Math.floor(data.length / 2));
    const headers = { 'content-type': 'application/octet-stream' };
    if (mode === 'serve') {
      response.writeHead(200, { ...headers, 'content-length': data.length }).end(data);
    } else if (mode === 'short') {
      response.writeHead(200, { ...headers, 'content-length': half.length }).end(half);
    } else {
      response.writeHead(200, { ...headers, 'content-length': data.length });
      response.write(half, () => {
        this.#reached.get(path)?.();
        // Mark it as reached even if nobody asked yet.
        if (!this.#reachedPromise.has(path)) this.#reachedPromise.set(path, Promise.resolve());
        if (mode === 'cut-half') response.destroy();
      });
    }
  }

  /** Switches the registry off (the port stays free of answers: connections are refused). */
  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  }

  /** Switches it on again at the same port. */
  async restart(): Promise<void> {
    if (this.#server === undefined) await this.#listen(this.#port);
  }

  async close(): Promise<void> {
    await this.stop();
  }
}

/** Every file or folder under `root` whose name matches one of `patterns`. */
export async function findLeftovers(root: string, patterns: readonly RegExp[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (patterns.some((pattern) => pattern.test(entry.name))) {
        found.push(path);
        continue;
      }
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(root);
  return found.sort();
}

/** What an adapter installation leaves when it is cut: the staging folder, the folder moved aside, the lock. */
export const ADAPTER_LEFTOVERS: readonly RegExp[] = [
  /^\.tmp-/,
  /\.old-\d+$/,
  /^\.install\.lock$/,
  /\.partial$/,
  /\.tmp$/,
];

// --- the application -------------------------------------------------------------------------

export type FakeDaemonMode = 'healthy' | 'unhealthy' | 'dies_on_start';

export interface FakeDaemonVersion {
  readonly version: string;
  readonly mode: FakeDaemonMode;
  /** The `PRAGMA user_version` the daemon of this version migrates the store to (it refuses a newer one). */
  readonly schema: number;
  /** A file that must exist before the daemon publishes `api.json` (the lock is held meanwhile). */
  readonly publishGate?: string | undefined;
  /** A file that must exist before the daemon migrates the store. */
  readonly migrateGate?: string | undefined;
}

const FAKE_DAEMON = `
import { appendFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const opt = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const version = opt('--fake-version');
const mode = opt('--fake-mode') ?? 'healthy';
const schema = Number(opt('--fake-schema') ?? '1');
const runDir = opt('--fake-run');
const publishGate = opt('--fake-publish-gate');
const migrateGate = opt('--fake-migrate-gate');
const dataDir = opt('--data-dir');
const load = (path) => import(pathToFileURL(process.env.OT_CHILD_DIST + '/' + path).href);
const log = (event, extra = {}) =>
  appendFileSync(runDir + '/daemon-log.jsonl', JSON.stringify({ version, pid: process.pid, event, ...extra }) + '\\n');
const gate = async (file) => {
  if (file === undefined) return;
  while (!existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 25));
};

const { InstanceLock } = await load('instance-lock.js');
const { dataPaths } = await load('paths.js');
const files = await load('api/files.js');
const paths = dataPaths(dataDir);

let lock;
try {
  lock = await InstanceLock.acquire(paths.lock, paths.lockInfo);
} catch (error) {
  log('conflict', { message: String(error.message) });
  process.exit(1);
}
await lock.publish({ pid: process.pid, startedAt: Date.now(), version });
log('locked');

let server;
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server?.closeAllConnections?.();
  server?.close();
  await files.removeDiscovery(paths.apiDiscovery).catch(() => undefined);
  await lock.release().catch(() => undefined);
  log('stopped');
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

if (mode === 'dies_on_start') {
  await lock.release();
  log('died');
  process.exit(1);
}

const db = new DatabaseSync(paths.store);
const current = db.prepare('PRAGMA user_version').get().user_version;
if (current > schema) {
  db.close();
  log('store_too_new', { current, schema });
  await lock.release();
  process.exit(1);
}
if (current < schema) {
  await gate(migrateGate);
  db.exec('BEGIN');
  db.exec('CREATE TABLE migrated_' + schema + ' (id INTEGER)');
  db.exec('PRAGMA user_version = ' + schema);
  db.exec('COMMIT');
  log('migrated', { schema });
}
db.close();

const token = await files.loadOrCreateApiToken(paths.apiToken, 'persistent');
const daemonId = await files.loadOrCreateDaemonId(paths.daemonId);
await gate(publishGate);
server = createServer((request, response) => {
  const authorized = request.headers.authorization === 'Bearer ' + token;
  if (request.url !== '/v1/health' || !authorized) {
    response.writeHead(request.url === '/v1/health' ? 401 : 404).end();
    return;
  }
  if (mode === 'unhealthy') {
    response.writeHead(503, { 'content-type': 'application/json' }).end('{"status":"starting"}');
    return;
  }
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ status: 'ok', version, pid: process.pid }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
await files.publishDiscovery(paths.apiDiscovery, {
  url: 'http://127.0.0.1:' + server.address().port,
  daemonId,
  pid: process.pid,
  apiVersion: 1,
});
log('ready');
`;

/**
 * Writes the "executable" of a version: a shell script that starts the fake daemon with the
 * behaviour of that version baked in, so the bytes (and the SHA-256 the manifest signs) belong to the
 * version, and the applier starts it as `<exe> daemon --data-dir <dir>`, as it starts the real one.
 */
export async function writeFakeExe(
  runDir: string,
  target: string,
  spec: FakeDaemonVersion,
): Promise<Buffer> {
  const scripts = join(runDir, 'scripts');
  await mkdir(scripts, { recursive: true });
  const daemon = join(scripts, 'fake-daemon.mjs');
  await writeFile(daemon, FAKE_DAEMON);
  const flags = [
    `--fake-version ${spec.version}`,
    `--fake-mode ${spec.mode}`,
    `--fake-schema ${String(spec.schema)}`,
    `--fake-run '${runDir}'`,
    ...(spec.publishGate === undefined ? [] : [`--fake-publish-gate '${spec.publishGate}'`]),
    ...(spec.migrateGate === undefined ? [] : [`--fake-migrate-gate '${spec.migrateGate}'`]),
  ].join(' ');
  const text = `#!/bin/sh\nOT_CHILD_DIST='${DAEMON_DIST}' exec '${process.execPath}' '${daemon}' ${flags} "$@"\n`;
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, text);
  await chmod(target, 0o755);
  return Buffer.from(text);
}

const APPLIER_CHILD = `${CHILD_HEAD}
const { readJournal } = await load('updates/apply/journal.js');
const { layoutOf } = await load('updates/apply/layout.js');
const { runApply } = await load('updates/apply/applier.js');
const { realApplyPorts } = await load('updates/apply/real-ports.js');
const { checkJournalTrust } = await load('updates/apply/trust.js');
const { parsePublicKey } = await load('updates/verify.js');
const { ServiceError } = await load('service/types.js');
import { appendFileSync } from 'node:fs';

const reading = await readJournal(process.env.OT_CHILD_JOURNAL);
if (reading.kind !== 'ok') {
  console.log('OUTCOME ' + JSON.stringify({ kind: 'no_journal', reading: reading.kind }));
  process.exit(2);
}
const layout = layoutOf(reading.journal.exe);
const key = parsePublicKey(process.env.OT_CHILD_PUBLIC_PEM);
const trusted = await checkJournalTrust({ layout, journal: reading.journal, key, platform: 'linux-x64' });
if (!trusted.ok) {
  console.log('OUTCOME ' + JSON.stringify({ kind: 'untrusted', detail: trusted.detail }));
  process.exit(2);
}
const write = (level) => (fields, message) =>
  appendFileSync(layout.folder + '/update-apply.log', JSON.stringify({ level, message: typeof fields === 'string' ? fields : message, fields: typeof fields === 'object' ? fields : undefined }) + '\\n');
const logger = { info: write('info'), warn: write('warn'), error: write('error') };
// No real service: the one of the test says it is not installed, so the daemon is started as a child.
const service = {
  kind: 'fake',
  start: async () => { throw new ServiceError('not_installed', 'no service in the test'); },
  stop: async () => undefined,
};
const env = { ...process.env };
delete env.OT_TEST_CRASH_AT;
delete env.OT_TEST_FAULT;
const ports = realApplyPorts({ layout, journal: reading.journal, logger, service, env });
const outcome = await runApply(layout, ports, reading.journal);
console.log('OUTCOME ' + JSON.stringify(outcome));
`;

export interface ApplierChildInput {
  readonly runDir: string;
  readonly journal: string;
  readonly publicPem: string;
  readonly crashAt?: string | undefined;
}

/** The real applier (`runApply` over the real ports, a fake service) as a process of its own. */
export async function startApplierChild(input: ApplierChildInput): Promise<Watched> {
  const scripts = join(input.runDir, 'scripts');
  await mkdir(scripts, { recursive: true });
  const script = join(scripts, 'applier-child.mjs');
  await writeFile(script, APPLIER_CHILD);
  return spawnNode(input.runDir, script, [], {
    OT_CHILD_JOURNAL: input.journal,
    OT_CHILD_PUBLIC_PEM: input.publicPem,
    [CRASH_AT_VARIABLE]: input.crashAt,
  });
}

/** Starts a fake daemon the way the applier does (a process of its own), for the "old daemon" of a test. */
export function startFakeDaemon(runDir: string, exe: string, dataDir: string): Watched {
  const child = spawn(exe, ['daemon', '--data-dir', dataDir], {
    cwd: runDir,
    env: childEnv(runDir),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return watch(child);
}

/** The lines `daemon-log.jsonl` holds (the fake daemons write there), parsed. */
export function daemonLog(runDir: string): { version: string; pid: number; event: string }[] {
  const file = join(runDir, 'daemon-log.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { version: string; pid: number; event: string });
}
