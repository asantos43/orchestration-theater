// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * The orphan temporaries of the atomic writes of an adapter (Phase 11, N306): a small copy of
 * `packages/client/src/node/temporaries.ts`. An adapter may import neither the client nor another
 * adapter, so each adapter that writes "a temporary beside the file, then a rename" keeps this same
 * file (`client-claude-code`, `client-codex`, `client-opencode`, `vault-file`); a test of
 * `client-claude-code` keeps the copies equal. The name of a temporary is `[.]<file>.<pid>[.<hex>].tmp`,
 * and only the names of that shape for the file being written are ever removed.
 *
 * What counts as an orphan is the key `temporaries` of `config.yaml`, as for the daemon: the client
 * module, when it is loaded in the process (the daemon), publishes its policy and its sink of failures
 * under `Symbol.for('otheater.temporaries')`, and this copy reads them there. Without it (a test, a tool
 * that runs an adapter alone) the policy is the default, `pid`, and a failure is dropped. [proposta]
 */
export type TemporaryCleanupMode = 'off' | 'pid' | 'age';

export interface TemporaryCleanupPolicy {
  readonly mode: TemporaryCleanupMode;
  readonly maxAgeMs: number;
}

const DEFAULT_POLICY: TemporaryCleanupPolicy = { mode: 'pid', maxAgeMs: 60 * 60_000 };
const BRIDGE = Symbol.for('otheater.temporaries');

interface Bridge {
  readonly version: 1;
  readonly policy: () => TemporaryCleanupPolicy;
  readonly report: (name: string, error: unknown) => void;
}

function bridge(): Bridge | undefined {
  const value: unknown = (globalThis as Record<symbol, unknown>)[BRIDGE];
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<Bridge>;
  return candidate.version === 1 &&
    typeof candidate.policy === 'function' &&
    typeof candidate.report === 'function'
    ? (candidate as Bridge)
    : undefined;
}

/** The shape of the name of a temporary: `[.]<file>.<pid>[.<hex>].tmp`. */
export interface TemporaryShape {
  /** Hex digits after the pid (an even number); 0 for `<file>.<pid>.tmp`. */
  readonly hexLength: number;
  /** The name starts with a dot: `.<file>.<pid>.tmp`. */
  readonly hidden?: boolean | undefined;
}

/** The path of a new temporary of `path`, in the same folder, with this process's pid. */
export function temporaryPathOf(path: string, shape: TemporaryShape): string {
  const hex = shape.hexLength > 0 ? `.${randomBytes(shape.hexLength / 2).toString('hex')}` : '';
  const name = `${shape.hidden === true ? '.' : ''}${basename(path)}.${String(process.pid)}${hex}.tmp`;
  return join(dirname(path), name);
}

export interface SweepTemporariesOptions extends TemporaryShape {
  /** Replaces parts of the policy in force; tests use it. */
  readonly policy?: Partial<TemporaryCleanupPolicy> | undefined;
  /** Whether a pid is a live process. Default: signal 0. Tests replace it. */
  readonly alive?: ((pid: number) => boolean) | undefined;
  /** The clock of the `age` mode, in milliseconds. Default `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Told about a temporary that could not be removed. Default: the sink of the client, if any. */
  readonly onError?: ((error: unknown, name: string) => void) | undefined;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | undefined)?.code === 'EPERM';
  }
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'ENOENT';
}

function patternOf(path: string, shape: TemporaryShape): RegExp {
  const base = basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hex = shape.hexLength > 0 ? `\\.[0-9a-f]{${String(shape.hexLength)}}` : '';
  return new RegExp(`^${shape.hidden === true ? '\\.' : ''}${base}\\.(\\d+)${hex}\\.tmp$`);
}

/**
 * Removes the orphan temporaries of `path`: in mode `pid`, the ones whose pid is not a live process
 * (never one of this process, which may be a write in flight); in mode `age`, the ones older than
 * `maxAgeMs`; in mode `off`, none. Never throws: a failure goes to `onError`. Returns the names it
 * removed.
 */
export async function sweepTemporaries(
  path: string,
  options: SweepTemporariesOptions,
): Promise<string[]> {
  const shared = bridge();
  const policy = { ...(shared?.policy() ?? DEFAULT_POLICY), ...definedOnly(options.policy) };
  const alive = options.alive ?? isPidAlive;
  const now = options.now ?? Date.now;
  const report = (error: unknown, name: string): void => {
    try {
      if (options.onError !== undefined) options.onError(error, name);
      else shared?.report(name, error);
    } catch {
      // A handler that throws must not break the write it only reports about.
    }
  };
  const removed: string[] = [];
  if (policy.mode === 'off') return removed;
  const folder = dirname(path);
  const pattern = patternOf(path, options);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if (!isNotFound(error)) report(error, basename(path));
    return removed;
  }
  for (const name of names) {
    const pid = Number(pattern.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const file = join(folder, name);
    try {
      if (policy.mode === 'pid') {
        if (pid === process.pid || alive(pid)) continue;
      } else if (now() - (await lstat(file)).mtimeMs <= policy.maxAgeMs) continue;
      await rm(file, { force: true });
      removed.push(name);
    } catch (error) {
      if (!isNotFound(error)) report(error, name);
    }
  }
  return removed;
}

function definedOnly(
  policy: Partial<TemporaryCleanupPolicy> | undefined,
): Partial<TemporaryCleanupPolicy> {
  return {
    ...(policy?.mode === undefined ? {} : { mode: policy.mode }),
    ...(policy?.maxAgeMs === undefined ? {} : { maxAgeMs: policy.maxAgeMs }),
  };
}
