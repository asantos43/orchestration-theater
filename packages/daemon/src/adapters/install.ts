// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { constants, readFileSync, statSync } from 'node:fs';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  adapterLockEntryPath,
  type AdapterLock,
  type AdapterLockEntry,
  entriesFor,
  lockDigest,
  type InstallPlatform,
} from './lock.js';
import { DEFAULT_MAX_ENTRIES, readTarGz, TarError } from './tar.js';

/**
 * The installer of the managed ACP adapters (Phase 10, P13; N254 revised). It downloads the tarballs the
 * lock lists from an npm registry, checks each against the `sha512` of the lock, builds the
 * `node_modules` tree in a folder beside the target and swaps it in by one rename, so a half
 * installation is never visible. No script of any package runs (an npm `install` script is never
 * executed), nothing is written outside `<data>/adapters/<id>/`, and nothing needs a privilege.
 */

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
/** `clients.adapters.redirect_max` (the config test keeps the two equal). */
export const DEFAULT_REDIRECT_MAX = 3;
/** `clients.adapters.tar_max_entries` (the config test keeps the two equal). */
export const DEFAULT_TAR_MAX_ENTRIES = DEFAULT_MAX_ENTRIES;

/** Why an installation failed. */
export type AdapterInstallErrorCode =
  | 'network'
  | 'registry_status'
  | 'registry_insecure'
  | 'redirect'
  | 'integrity'
  | 'archive'
  | 'storage'
  | 'locked'
  | 'entry_missing';

export class AdapterInstallError extends Error {
  override readonly name = 'AdapterInstallError';
  constructor(
    readonly code: AdapterInstallErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type InstallEvent =
  | {
      readonly phase: 'start';
      readonly id: string;
      readonly version: string;
      readonly packages: number;
    }
  | { readonly phase: 'done'; readonly id: string; readonly version: string }
  | {
      readonly phase: 'failed';
      readonly id: string;
      readonly version: string;
      readonly code: AdapterInstallErrorCode;
      readonly message: string;
    };

export interface InstallOptions {
  readonly lock: AdapterLock;
  /** `<data>/adapters`. */
  readonly adaptersDir: string;
  /** Default {@link DEFAULT_REGISTRY}. `https`, or `http` on a loopback address only. */
  readonly registry?: string;
  readonly platform: InstallPlatform;
  /** Default the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly onEvent?: (event: InstallEvent) => void;
  /** Timeout of one request. Default 120 s. */
  readonly requestTimeoutMs?: number;
  /** Tries after the first one, for a network error, a 429 or a 5xx. Default 2. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  /** A lock older than this is taken over. Default 15 min. */
  readonly lockStaleMs?: number;
  /** How long to wait for the lock another installer holds. Default 5 min. */
  readonly lockWaitMs?: number;
  /**
   * Host names a download may be redirected to besides the registry's own (`clients.adapters.redirect_hosts`).
   * Default none.
   */
  readonly redirectHosts?: readonly string[];
  /** Most redirects of one download (`clients.adapters.redirect_max`). Default {@link DEFAULT_REDIRECT_MAX}. */
  readonly redirectMax?: number;
  /** Most entries of one tarball (`clients.adapters.tar_max_entries`). Default {@link DEFAULT_TAR_MAX_ENTRIES}. */
  readonly tarMaxEntries?: number;
  /** Largest tarball, in bytes. Default 256 MiB. */
  readonly maxTarballBytes?: number;
  /** Tarballs in flight. Default 4. */
  readonly concurrency?: number;
}

export interface InstallResult {
  readonly status: 'installed' | 'already_installed';
  /** `<data>/adapters/<id>/<version>`. */
  readonly dir: string;
  /** The file Node runs. */
  readonly entry: string;
}

const MARKER = '.otheater-adapter.json';
const LOCK_FILE = '.install.lock';

/** `<adapters>/<id>/<version>`. */
export function adapterDir(adaptersDir: string, lock: AdapterLock): string {
  return path.join(adaptersDir, lock.id, lock.version);
}

/** The file of the adapter Node runs, inside its installation. */
export function adapterEntry(dir: string, lock: AdapterLock): string {
  return path.join(dir, adapterLockEntryPath(lock));
}

/** True when the folder holds a complete installation of exactly this lock (marker and entry). */
export async function isInstalled(dir: string, lock: AdapterLock): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(path.join(dir, MARKER), 'utf8')) as {
      digest?: unknown;
    };
    if (marker.digest !== lockDigest(lock)) return false;
    return (await stat(adapterEntry(dir, lock))).isFile();
  } catch {
    return false;
  }
}

/**
 * {@link isInstalled}, synchronous: the daemon asks it every time a client process starts, from
 * code that cannot wait (`ClientAdapter.command()`), and it reads one small file and one `stat`.
 */
export function isInstalledSync(dir: string, lock: AdapterLock): boolean {
  try {
    const marker = JSON.parse(readFileSync(path.join(dir, MARKER), 'utf8')) as {
      digest?: unknown;
    };
    if (marker.digest !== lockDigest(lock)) return false;
    return statSync(adapterEntry(dir, lock)).isFile();
  } catch {
    return false;
  }
}

/** The URL of a tarball: the registry's own layout (`/<name>/-/<basename>-<version>.tgz`), whatever host the lock was made on. */
export function tarballUrl(registry: string, entry: AdapterLockEntry): string {
  const basename = entry.name.slice(entry.name.lastIndexOf('/') + 1);
  return `${registry.replace(/\/+$/u, '')}/${entry.name}/-/${basename}-${entry.version}.tgz`;
}

function checkRegistry(registry: string): void {
  let url: URL;
  try {
    url = new URL(registry);
  } catch {
    throw new AdapterInstallError(
      'registry_insecure',
      `clients.adapters.registry is not a URL: ${registry}`,
    );
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new AdapterInstallError(
      'registry_insecure',
      `clients.adapters.registry must be https (or http on this machine): ${url.protocol}//${url.host}`,
    );
  }
}

function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

/**
 * Reads the redirect of a response: the next URL, or a `redirect` error when the hop leaves what is
 * allowed (more hops than the limit, not `https` (`http` on the loopback), a host that is neither the
 * registry's nor listed). `fetch` is called with `redirect: 'manual'`, so nothing is followed unseen.
 */
function nextHop(
  response: Response,
  from: URL,
  hops: number,
  options: InstallOptions,
  registryHost: string,
  label: string,
): URL {
  const max = options.redirectMax ?? DEFAULT_REDIRECT_MAX;
  if (hops >= max) {
    throw new AdapterInstallError(
      'redirect',
      `${label}: more than ${String(max)} redirects (clients.adapters.redirect_max)`,
    );
  }
  const location = response.headers.get('location');
  let target: URL;
  try {
    if (location === null || location === '') throw new Error('no location');
    target = new URL(location, from);
  } catch {
    throw new AdapterInstallError(
      'redirect',
      `${label}: the registry redirected without a usable Location`,
    );
  }
  const secure =
    target.protocol === 'https:' ||
    (target.protocol === 'http:' && isLoopbackHost(target.hostname));
  if (!secure || target.username !== '' || target.password !== '') {
    throw new AdapterInstallError(
      'redirect',
      `${label}: refused a redirect to ${target.protocol}//${target.host} (https only, no credentials in the URL)`,
    );
  }
  const allowed = [registryHost, ...(options.redirectHosts ?? [])].map((host) =>
    host.toLowerCase(),
  );
  if (!allowed.includes(target.hostname.toLowerCase())) {
    throw new AdapterInstallError(
      'redirect',
      `${label}: refused a redirect to ${target.host}; add it to clients.adapters.redirect_hosts if you trust it`,
    );
  }
  return target;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > limit)
    throw new AdapterInstallError('archive', `the tarball is larger than ${String(limit)} bytes`);
  if (response.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit)
      throw new AdapterInstallError('archive', `the tarball is larger than ${String(limit)} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function download(
  entry: AdapterLockEntry,
  options: InstallOptions,
  registry: string,
): Promise<Buffer> {
  const doFetch = options.fetch ?? fetch;
  const url = tarballUrl(registry, entry);
  const label = `${entry.name}@${entry.version}`;
  const registryHost = new URL(registry).hostname;
  const tries = (options.retries ?? 2) + 1;
  let lastError: AdapterInstallError | undefined;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (attempt > 0) await sleep(options.retryDelayMs ?? 500);
    try {
      const signal = AbortSignal.timeout(options.requestTimeoutMs ?? 120_000);
      let current = new URL(url);
      let response = await doFetch(current, { signal, redirect: 'manual' });
      for (let hops = 0; [301, 302, 303, 307, 308].includes(response.status); hops += 1) {
        current = nextHop(response, current, hops, options, registryHost, label);
        await response.body?.cancel().catch(() => undefined);
        response = await doFetch(current, { signal, redirect: 'manual' });
      }
      if (response.status >= 500 || response.status === 429) {
        lastError = new AdapterInstallError(
          'registry_status',
          `${entry.name}@${entry.version}: the registry answered ${String(response.status)}`,
        );
        continue;
      }
      if (!response.ok) {
        throw new AdapterInstallError(
          'registry_status',
          `${entry.name}@${entry.version}: the registry answered ${String(response.status)}`,
        );
      }
      return await readLimited(response, options.maxTarballBytes ?? 256 * 1024 * 1024);
    } catch (error) {
      if (error instanceof AdapterInstallError) {
        if (
          error.code === 'registry_status' ||
          error.code === 'archive' ||
          error.code === 'redirect'
        )
          throw error;
        lastError = error;
        continue;
      }
      lastError = new AdapterInstallError(
        'network',
        `${entry.name}@${entry.version}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw (
    lastError ?? new AdapterInstallError('network', `${entry.name}@${entry.version}: no answer`)
  );
}

/** The `sha512-<base64>` of the lock against the bytes. */
export function integrityMatches(integrity: string, data: Buffer): boolean {
  return `sha512-${createHash('sha512').update(data).digest('base64')}` === integrity;
}

async function extract(
  entry: AdapterLockEntry,
  data: Buffer,
  root: string,
  options: InstallOptions,
): Promise<void> {
  if (!integrityMatches(entry.integrity, data)) {
    throw new AdapterInstallError(
      'integrity',
      `${entry.name}@${entry.version}: the tarball does not match the sha512 of the lock`,
    );
  }
  const base = path.join(root, ...entry.path.split('/'));
  let files;
  try {
    files = readTarGz(data, { maxEntries: options.tarMaxEntries ?? DEFAULT_TAR_MAX_ENTRIES });
  } catch (error) {
    if (error instanceof TarError) {
      throw new AdapterInstallError('archive', `${entry.name}@${entry.version}: ${error.message}`);
    }
    throw error;
  }
  for (const file of files) {
    const target = path.join(base, ...file.path.split('/'));
    if (!target.startsWith(`${base}${path.sep}`)) {
      throw new AdapterInstallError(
        'archive',
        `${entry.name}@${entry.version}: ${file.path} leaves the package`,
      );
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.data, { mode: file.executable ? 0o755 : 0o644 });
  }
}

async function pool<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: Error | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const item = items[next];
      next += 1;
      if (item === undefined) return;
      try {
        await work(item);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  if (failure !== undefined) throw failure;
}

/** Takes `<id>/.install.lock` (created exclusively); another installer's lock is waited for, a stale one taken over. */
async function withLock<T>(
  lockPath: string,
  options: InstallOptions,
  run: () => Promise<T>,
): Promise<T> {
  const stale = options.lockStaleMs ?? 15 * 60_000;
  const deadline = Date.now() + (options.lockWaitMs ?? 5 * 60_000);
  for (;;) {
    try {
      const handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(`${String(process.pid)} ${new Date().toISOString()}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new AdapterInstallError(
          'storage',
          `cannot take ${lockPath}: ${(error as Error).message}`,
        );
      }
    }
    try {
      if (Date.now() - (await stat(lockPath)).mtimeMs > stale) {
        await unlink(lockPath);
        continue;
      }
    } catch {
      continue; // gone meanwhile: try again at once
    }
    if (Date.now() > deadline) {
      throw new AdapterInstallError(
        'locked',
        'another installation of this adapter is still running',
      );
    }
    await sleep(100);
  }
  try {
    return await run();
  } finally {
    await rm(lockPath, { force: true });
  }
}

/** Leftovers of an installation that died: nobody else works in the folder while the lock is held. */
async function sweep(parent: string): Promise<void> {
  for (const name of await readdir(parent)) {
    if (name.startsWith('.tmp-') || name.includes('.old-'))
      await rm(path.join(parent, name), { recursive: true, force: true });
  }
}

async function build(options: InstallOptions, registry: string, dir: string): Promise<void> {
  const { lock } = options;
  const parent = path.dirname(dir);
  const staging = path.join(
    parent,
    `.tmp-${lock.version}-${String(process.pid)}-${String(Date.now())}`,
  );
  const entries = entriesFor(lock, options.platform);
  try {
    await mkdir(staging, { recursive: true });
    await pool(entries, options.concurrency ?? 4, async (entry) => {
      await extract(entry, await download(entry, options, registry), staging, options);
    });
    const entryFile = adapterEntry(staging, lock);
    if (
      !(await stat(entryFile).then(
        (s) => s.isFile(),
        () => false,
      ))
    ) {
      throw new AdapterInstallError('entry_missing', `${lock.package} has no ${lock.entry}`);
    }
    await writeFile(
      path.join(staging, MARKER),
      `${JSON.stringify({ schema: 1, id: lock.id, version: lock.version, digest: lockDigest(lock), installedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    // An incomplete folder (no marker) is moved aside, then the new one takes its place in one rename.
    const aside = `${dir}.old-${String(process.pid)}`;
    const existed = await rename(dir, aside).then(
      () => true,
      () => false,
    );
    try {
      await rename(staging, dir);
    } catch (error) {
      if (existed) await rename(aside, dir).catch(() => undefined);
      throw new AdapterInstallError(
        'storage',
        `cannot move the installation into place: ${(error as Error).message}`,
      );
    }
    if (existed) await rm(aside, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Installs the adapter of `options.lock` into `<adaptersDir>/<id>/<version>/`, or says it is there.
 * Idempotent and safe against concurrent installs (a lock file per adapter, in this process and in another).
 * Failures are an {@link AdapterInstallError}; the events say start, end and failure.
 */
export async function installAdapter(options: InstallOptions): Promise<InstallResult> {
  const { lock } = options;
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const dir = adapterDir(options.adaptersDir, lock);
  const entry = adapterEntry(dir, lock);
  if (await isInstalled(dir, lock)) return { status: 'already_installed', dir, entry };
  const emit = (event: InstallEvent): void => options.onEvent?.(event);
  try {
    checkRegistry(registry);
    const parent = path.dirname(dir);
    try {
      await mkdir(parent, { recursive: true });
    } catch (error) {
      throw new AdapterInstallError(
        'storage',
        `cannot create ${parent}: ${(error as Error).message}`,
      );
    }
    return await withLock(path.join(parent, LOCK_FILE), options, async () => {
      // Another process may have finished while this one waited for the lock.
      if (await isInstalled(dir, lock)) return { status: 'already_installed' as const, dir, entry };
      await sweep(parent);
      emit({
        phase: 'start',
        id: lock.id,
        version: lock.version,
        packages: entriesFor(lock, options.platform).length,
      });
      await build(options, registry, dir);
      emit({ phase: 'done', id: lock.id, version: lock.version });
      return { status: 'installed' as const, dir, entry };
    });
  } catch (error) {
    const failure =
      error instanceof AdapterInstallError
        ? error
        : new AdapterInstallError(
            'storage',
            error instanceof Error ? error.message : String(error),
          );
    emit({
      phase: 'failed',
      id: lock.id,
      version: lock.version,
      code: failure.code,
      message: failure.message,
    });
    throw failure;
  }
}
