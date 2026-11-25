// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isPidAlive } from './pid.js';

/**
 * The temporary files of the atomic writes (Phase 11, N306): every file the daemon and the client write
 * as "a temporary file in the same folder, then a rename" is named `<file>.<pid>[.<hex>].tmp`, and a
 * process killed between the write and the rename leaves it behind. This module names those files and
 * removes the orphans, and only the ones of the exact name of the target that is being written: nothing
 * else in the folder and no temporary of another file is ever touched.
 *
 * What counts as an orphan is the key `temporaries` of `config.yaml` (the daemon sets it with
 * {@link configureTemporaryCleanup}; a process that never does, such as the CLI or the TUI, uses the
 * default, `pid`). (N306, owner 2026-11-24)
 * - `cleanup` (default `pid`): `pid` removes a temporary whose pid is not a live process; `age` removes
 *   one that is older than `max_age` whatever its pid says (for a folder that processes of other
 *   machines or containers write: a pid means nothing there); `off` removes nothing.
 * - `max_age` (default `1h`; from `1m` to `30d`): the age of `age`.
 */
export const TEMPORARY_CLEANUP_MODES = ['off', 'pid', 'age'] as const;
export type TemporaryCleanupMode = (typeof TEMPORARY_CLEANUP_MODES)[number];

export const DEFAULT_TEMPORARY_CLEANUP_MODE: TemporaryCleanupMode = 'pid';
/** A write takes milliseconds; an hour is a temporary nobody is writing any more. */
export const DEFAULT_TEMPORARY_MAX_AGE_MS = 60 * 60_000;
/** Below a minute, a slow disk could make the cleaning remove a write that is still going on. */
export const TEMPORARY_MAX_AGE_MIN_MS = 60_000;
export const TEMPORARY_MAX_AGE_MAX_MS = 30 * 24 * 60 * 60_000;

export interface TemporaryCleanupPolicy {
  readonly mode: TemporaryCleanupMode;
  readonly maxAgeMs: number;
}

const DEFAULT_POLICY: TemporaryCleanupPolicy = {
  mode: DEFAULT_TEMPORARY_CLEANUP_MODE,
  maxAgeMs: DEFAULT_TEMPORARY_MAX_AGE_MS,
};

const activePolicies: TemporaryCleanupPolicy[] = [];

/**
 * Sets the policy of this process (the daemon, from its `temporaries` block). Returns the function
 * that takes it back; the last policy still set is the one in force, and with none the default is.
 */
export function configureTemporaryCleanup(policy: Partial<TemporaryCleanupPolicy>): () => void {
  const mine: TemporaryCleanupPolicy = { ...DEFAULT_POLICY, ...definedOnly(policy) };
  activePolicies.push(mine);
  return () => {
    const at = activePolicies.indexOf(mine);
    if (at >= 0) activePolicies.splice(at, 1);
  };
}

/** The policy in force. */
export function temporaryCleanupPolicy(): TemporaryCleanupPolicy {
  return activePolicies.at(-1) ?? DEFAULT_POLICY;
}

function definedOnly(policy: Partial<TemporaryCleanupPolicy>): Partial<TemporaryCleanupPolicy> {
  return {
    ...(policy.mode === undefined ? {} : { mode: policy.mode }),
    ...(policy.maxAgeMs === undefined ? {} : { maxAgeMs: policy.maxAgeMs }),
  };
}

/** An orphan temporary that could not be removed, or the folder that could not be read. */
export interface TemporarySweepFailure {
  /** The name of the file, or of the target when the folder could not be read. */
  readonly name: string;
  readonly error: unknown;
}

const MAX_PENDING_FAILURES = 16;
const pendingFailures: TemporarySweepFailure[] = [];
let failureSink: ((failure: TemporarySweepFailure) => void) | undefined;

/**
 * Where the failures to remove an orphan temporary go by default (the daemon turns them into a log
 * warning and a `daemon.notice` event, kind `temporary_cleanup_failed`). A failure that came before the
 * sink was set (the store opens, and extracts its addon, before the daemon can write an event) is
 * delivered at once, in order. Returns the function that unsets the sink.
 */
export function onTemporarySweepFailure(
  sink: (failure: TemporarySweepFailure) => void,
): () => void {
  failureSink = sink;
  for (const failure of pendingFailures.splice(0)) reportTemporarySweepFailure(failure);
  return () => {
    if (failureSink === sink) failureSink = undefined;
  };
}

/** Hands a failure to the sink, or keeps it (a few of them) until there is one. Never throws. */
export function reportTemporarySweepFailure(
  failure: TemporarySweepFailure,
  handler?: (failure: TemporarySweepFailure) => void,
): void {
  const target = handler ?? failureSink;
  if (target === undefined) {
    if (pendingFailures.length < MAX_PENDING_FAILURES) pendingFailures.push(failure);
    return;
  }
  try {
    target(failure);
  } catch {
    // A sink that throws must not break the write it only reports about.
  }
}

/**
 * The bridge to the copies of this module in the adapters (`packages/adapters/<adapter>/src/temporaries.ts`),
 * which may not import the client: the policy in force and the sink of failures, published once under
 * `Symbol.for('otheater.temporaries')` when this module is loaded. (N306, owner 2026-11-25)
 */
(globalThis as Record<symbol, unknown>)[Symbol.for('otheater.temporaries')] = {
  version: 1,
  policy: temporaryCleanupPolicy,
  report: (name: string, error: unknown) => {
    reportTemporarySweepFailure({ name, error });
  },
};

/** The shape of the name of a temporary: `[.]<file>.<pid>[.<hex>].tmp`. */
export interface TemporaryShape {
  /** Hex digits after the pid (an even number); 0 for `<file>.<pid>.tmp`. */
  readonly hexLength: number;
  /** The name starts with a dot: `.<file>.<pid>.tmp` (a file that must not look like the target). */
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
  /** Whether a pid is a live process. Default {@link isPidAlive}; tests replace it. */
  readonly alive?: ((pid: number) => boolean) | undefined;
  /** The clock of the `age` mode, in milliseconds. Default `Date.now`. */
  readonly now?: (() => number) | undefined;
  /**
   * Whether a temporary that carries this process's own pid is an orphan too (`pid` mode). At start-up
   * it is: nothing of this process has written the file yet, so the name is a left-over of an earlier
   * process with the same pid (a daemon that runs as pid 1 in a container always has it). While the
   * process writes it is not: it may be a write in flight. Default `false`.
   */
  readonly includeOwnPid?: boolean | undefined;
  /**
   * Told about a temporary that could not be removed, or a folder that could not be read. Default: the
   * sink of {@link onTemporarySweepFailure}. Never throws into the caller.
   */
  readonly onError?: ((error: unknown, name: string) => void) | undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function patternOf(path: string, shape: TemporaryShape): RegExp {
  const hex = shape.hexLength > 0 ? `\\.[0-9a-f]{${String(shape.hexLength)}}` : '';
  const dot = shape.hidden === true ? '\\.' : '';
  return new RegExp(`^${dot}${escapeRegExp(basename(path))}\\.(\\d+)${hex}\\.tmp$`);
}

interface SweepContext {
  readonly folder: string;
  readonly base: string;
  readonly pattern: RegExp;
  readonly policy: TemporaryCleanupPolicy;
  readonly alive: (pid: number) => boolean;
  readonly now: () => number;
  readonly includeOwnPid: boolean;
  readonly onError: (error: unknown, name: string) => void;
}

function contextOf(path: string, options: SweepTemporariesOptions): SweepContext {
  const forced = definedOnly(options.policy ?? {});
  return {
    folder: dirname(path),
    base: basename(path),
    pattern: patternOf(path, options),
    policy: { ...temporaryCleanupPolicy(), ...forced },
    alive: options.alive ?? isPidAlive,
    now: options.now ?? Date.now,
    includeOwnPid: options.includeOwnPid === true,
    onError: (error, name) => {
      if (options.onError === undefined) {
        reportTemporarySweepFailure({ name, error });
        return;
      }
      try {
        options.onError(error, name);
      } catch {
        // A handler that throws must not break the write it only reports about.
      }
    },
  };
}

/** The pid in the name of a candidate, or `undefined` when the name is not one of the shape. */
function pidOf(context: SweepContext, name: string): number | undefined {
  const match = context.pattern.exec(name);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** `pid` mode: whether the name's pid says the file is an orphan. */
function deadByPid(context: SweepContext, pid: number): boolean {
  return pid === process.pid ? context.includeOwnPid : !context.alive(pid);
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'ENOENT';
}

function tooOld(context: SweepContext, mtimeMs: number): boolean {
  return context.now() - mtimeMs > context.policy.maxAgeMs;
}

/**
 * Removes the orphan temporaries of `path` (see the top of this file for what an orphan is). Never
 * throws: a failure goes to `onError`. Returns the names it removed.
 */
export async function sweepTemporaries(
  path: string,
  options: SweepTemporariesOptions,
): Promise<string[]> {
  const removed: string[] = [];
  const context = contextOf(path, options);
  if (context.policy.mode === 'off') return removed;
  let names: string[];
  try {
    names = await readdir(context.folder);
  } catch (error) {
    if (!isNotFound(error)) context.onError(error, context.base);
    return removed;
  }
  for (const name of names) {
    const pid = pidOf(context, name);
    if (pid === undefined) continue;
    const file = join(context.folder, name);
    try {
      if (context.policy.mode === 'pid') {
        if (!deadByPid(context, pid)) continue;
      } else if (!tooOld(context, (await lstat(file)).mtimeMs)) continue;
      await rm(file, { force: true });
      removed.push(name);
    } catch (error) {
      if (!isNotFound(error)) context.onError(error, name);
    }
  }
  return removed;
}

/** {@link sweepTemporaries} for a caller that is synchronous (the extraction of a native addon). */
export function sweepTemporariesSync(path: string, options: SweepTemporariesOptions): string[] {
  const removed: string[] = [];
  const context = contextOf(path, options);
  if (context.policy.mode === 'off') return removed;
  let names: string[];
  try {
    names = readdirSync(context.folder);
  } catch (error) {
    if (!isNotFound(error)) context.onError(error, context.base);
    return removed;
  }
  for (const name of names) {
    const pid = pidOf(context, name);
    if (pid === undefined) continue;
    const file = join(context.folder, name);
    try {
      if (context.policy.mode === 'pid') {
        if (!deadByPid(context, pid)) continue;
      } else if (!tooOld(context, lstatSync(file).mtimeMs)) continue;
      rmSync(file, { force: true });
      removed.push(name);
    } catch (error) {
      if (!isNotFound(error)) context.onError(error, name);
    }
  }
  return removed;
}
