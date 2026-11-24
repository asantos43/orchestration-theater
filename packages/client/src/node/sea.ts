// SPDX-License-Identifier: MPL-2.0
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as nodeSea from 'node:sea';
import { isPidAlive } from './files.js';
import { resolveDataDir, type Env } from './paths.js';

/**
 * The single executable (Node SEA, Phase 10, P1) as seen from the code that runs inside it
 * [proposta]. A SEA has no folder of files: the catalogs, the prompts and the native addons travel
 * as assets of the executable, and every place that read a file by the path of its module reads the
 * asset when {@link isSeaProcess} is true, and the disk when it is not. Same code in the checkout
 * and in the executable; the disk stays the source of truth for the checkout and the tests.
 *
 * The helpers live here because the client's `node` folder is the one Node-aware package the TUI and
 * the daemon both already use; `adapters/prompts-files` keeps a small copy of its own (an adapter
 * may not import another package of the workspace besides `core`).
 */

/** The argument that selects an internal mode of the executable (`--ot-internal=tui`). [proposta] */
export const SEA_INTERNAL_PREFIX = '--ot-internal=';

/** The asset that lists every other asset key (`locales/en/cli.json`...), written by the build. */
export const SEA_ASSET_INDEX = 'ot-assets.json';

/** Whether this process is a single executable. A plain `node script.js` is not. */
export function isSeaProcess(): boolean {
  try {
    return nodeSea.isSea();
  } catch {
    return false;
  }
}

/** The text of the asset `key`, or `undefined` when this is not a SEA or the asset is missing. */
export function readSeaAsset(key: string): string | undefined {
  if (!isSeaProcess()) return undefined;
  try {
    return nodeSea.getAsset(key, 'utf8');
  } catch {
    return undefined;
  }
}

/** The bytes of the asset `key` (a copy), or `undefined`, as {@link readSeaAsset}. */
export function readSeaAssetBytes(key: string): Buffer | undefined {
  if (!isSeaProcess()) return undefined;
  try {
    return Buffer.from(nodeSea.getRawAsset(key));
  } catch {
    return undefined;
  }
}

/** The keys of the assets under `prefix` (`prompts/`), sorted; empty outside a SEA. */
export function listSeaAssets(prefix: string): string[] {
  const raw = readSeaAsset(SEA_ASSET_INDEX);
  if (raw === undefined) return [];
  try {
    const keys = JSON.parse(raw) as unknown;
    if (!Array.isArray(keys)) return [];
    return keys
      .filter((key): key is string => typeof key === 'string' && key.startsWith(prefix))
      .sort();
  } catch {
    return [];
  }
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The value of `--data-dir <dir>` or `--data-dir=<dir>` in `argv`, when there is one. */
export function dataDirArgument(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') return undefined;
    if (token === '--data-dir') return argv[index + 1];
    if (token?.startsWith('--data-dir=') === true) return token.slice('--data-dir='.length);
  }
  return undefined;
}

export interface SeaNativeOptions {
  /** The folder that holds `native/`. Default: the data folder (`--data-dir`, `OT_DATA_DIR`, else the platform one). */
  readonly dataDir?: string | undefined;
  readonly argv?: readonly string[] | undefined;
  readonly env?: Env | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly homedir?: string | undefined;
  /** Whether a pid is a live process, for the cleaning of orphan temporaries. Default `isPidAlive`; tests replace it. */
  readonly isPidAlive?: ((pid: number) => boolean) | undefined;
  /**
   * Told about an orphan temporary that could not be removed. Default: the sink of
   * {@link onSeaNativeSweepFailure} (the daemon turns it into a log warning and an event), or, with no
   * sink yet, a short queue that waits for one. Never throws into the extraction.
   */
  readonly onSweepFailure?: ((failure: SeaSweepFailure) => void) | undefined;
}

/** An orphan temporary of an extraction that could not be removed (Phase 11, N306). */
export interface SeaSweepFailure {
  /** The name of the file, or of the folder that could not be read. */
  readonly name: string;
  readonly error: unknown;
}

const MAX_PENDING_SWEEP_FAILURES = 16;
const pendingSweepFailures: SeaSweepFailure[] = [];
let sweepSink: ((failure: SeaSweepFailure) => void) | undefined;

/**
 * Where the failures to remove an orphan temporary go by default (Phase 11, N306). A failure that came
 * before the sink was set (the store opens, and extracts its addon, before the daemon can write an
 * event) is delivered at once, in order. Returns the function that unsets the sink.
 */
export function onSeaNativeSweepFailure(sink: (failure: SeaSweepFailure) => void): () => void {
  sweepSink = sink;
  for (const failure of pendingSweepFailures.splice(0)) reportSweepFailure(failure, undefined);
  return () => {
    if (sweepSink === sink) sweepSink = undefined;
  };
}

function reportSweepFailure(
  failure: SeaSweepFailure,
  handler: ((failure: SeaSweepFailure) => void) | undefined,
): void {
  const target = handler ?? sweepSink;
  if (target === undefined) {
    if (pendingSweepFailures.length < MAX_PENDING_SWEEP_FAILURES)
      pendingSweepFailures.push(failure);
    return;
  }
  try {
    target(failure);
  } catch {
    // A sink that throws must not break the extraction it only reports about.
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes the orphan temporaries of the addon `name` in `folder`: the `.<name>.<pid>.<12 hex>.tmp` that
 * {@link extractNative} leaves when its process dies between the write and the rename, whose pid is no
 * longer alive. Only that exact shape, for that exact addon, is touched; a temporary of a process that is
 * alive (another extraction in the same folder) stays. The extraction is synchronous, so a temporary with
 * this process's own pid is never one of its own in flight: it is a left-over of an earlier process with
 * the same pid (a daemon that runs as pid 1 in a container), and goes too. Never throws.
 */
function sweepNativeTemporaries(folder: string, name: string, options: SeaNativeOptions): void {
  const alive = options.isPidAlive ?? isPidAlive;
  const shape = new RegExp(`^\\.${escapeRegExp(name)}\\.(\\d+)\\.[0-9a-f]{12}\\.tmp$`);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') {
      reportSweepFailure({ name, error }, options.onSweepFailure);
    }
    return;
  }
  for (const entry of names) {
    const match = shape.exec(entry);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (pid !== process.pid && alive(pid)) continue;
    try {
      rmSync(join(folder, entry), { force: true });
    } catch (error) {
      reportSweepFailure({ name: entry, error }, options.onSweepFailure);
    }
  }
}

/**
 * Writes the bytes of an addon to `<dataDir>/native/<sha256>/<name>` and returns the path. The folder
 * is named by the hash, so an addon of another version lands beside the old one and nothing is
 * overwritten. A file that is already there with the right hash is reused (on Windows it may be
 * loaded by another process, and cannot be replaced). The write is a temporary file and a rename.
 * A process killed between the two leaves `.<name>.<pid>.<hex>.tmp`; the next extraction of the same
 * addon, whether it finds the good copy or writes it again, removes the ones whose pid is gone (N306).
 */
export function extractNative(
  name: string,
  bytes: Uint8Array,
  options: SeaNativeOptions = {},
): string {
  const digest = sha256Of(bytes);
  const root =
    options.dataDir ??
    resolveDataDir({
      explicit: dataDirArgument(options.argv ?? process.argv.slice(2)),
      env: options.env ?? process.env,
      platform: options.platform ?? process.platform,
      homedir: options.homedir ?? homedir(),
    });
  const folder = join(root, 'native', digest);
  const target = join(folder, name);
  try {
    if (sha256Of(readFileSync(target)) === digest) {
      sweepNativeTemporaries(folder, name, options);
      return target;
    }
  } catch {
    // Not there yet, or unreadable: extract below.
  }
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  sweepNativeTemporaries(folder, name, options);
  const temporary = join(
    folder,
    `.${name}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporary, bytes, { mode: 0o755 });
    try {
      renameSync(temporary, target);
    } catch (error) {
      // Windows refuses to replace a loaded file: if a good copy is there now, it is the one.
      if (sha256Of(readFileSync(target)) !== digest) throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return target;
}

const loaded = new Map<string, unknown>();

/**
 * Loads the native addon of the asset `key`: extracts it ({@link extractNative}, checked against
 * `sha256`, the hash the build recorded) and `process.dlopen`s it. The result is cached by key. The
 * esbuild plugins of `tools/release` replace the loader of `better-sqlite3` and of the keyring with a
 * call to this (through `globalThis.__otSeaNative`, set by the entry of the executable).
 */
export function loadSeaNative(
  key: string,
  sha256: string,
  options: SeaNativeOptions = {},
): unknown {
  const cached = loaded.get(key);
  if (cached !== undefined) return cached;
  const bytes = readSeaAssetBytes(key);
  if (bytes === undefined) throw new Error(`The executable has no native asset ${key}`);
  if (sha256Of(bytes) !== sha256) {
    throw new Error(`The native asset ${key} does not match the hash recorded by the build`);
  }
  const file = extractNative(key.slice(key.lastIndexOf('/') + 1), bytes, options);
  const holder = { exports: {} as unknown };
  process.dlopen(holder, file);
  loaded.set(key, holder.exports);
  return holder.exports;
}
