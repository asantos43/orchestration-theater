// SPDX-License-Identifier: MPL-2.0

/**
 * Windows refuses a rename, a delete or an open with `EPERM`, `EBUSY` or `EACCES` while another
 * process still holds the file: the antivirus that scans what was just written, the indexer, an
 * executable whose process has ended but whose image is not released yet. The hold is short, and the
 * same call a moment later succeeds (Phase 10, P12: `rename staging\ot.exe -> ot.exe` failed with
 * `EPERM` on a runner, 14 ms after the old executable was linked to `previous\`). The swap retries
 * these, and only these, for a bounded time before it calls the step failed. [proposta]
 * Keys `updates.apply.fs_retry` (`auto`, `always`, `off`) and `updates.apply.fs_retry_timeout`.
 */

/** `auto`: on Windows only, where these errors are transient; `always`: on every system; `off`: never. */
export type FsRetryMode = 'auto' | 'always' | 'off';

export interface FsRetryPolicy {
  /** Default `auto`. */
  readonly mode?: FsRetryMode | undefined;
  /** The system, for `auto`. Default `process.platform`. */
  readonly platform?: NodeJS.Platform | undefined;
  /** How long one call may keep trying. Default {@link FS_RETRY_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  /** Told at each try that failed and will be repeated: what call, which error, how many tries so far. */
  readonly onRetry?:
    | ((info: {
        readonly call: string;
        readonly code: string;
        readonly attempt: number;
        readonly waitedMs: number;
      }) => void)
    | undefined;
}

/** The default of `timeoutMs`. [proposta] key `updates.apply.fs_retry_timeout`. */
export const FS_RETRY_TIMEOUT_MS = 15_000;
const FIRST_WAIT_MS = 25;
const LONGEST_WAIT_MS = 500;
const TRANSIENT_CODES: readonly string[] = ['EPERM', 'EBUSY', 'EACCES'];

export function isTransientFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_CODES.includes(code);
}

/**
 * Runs `operation`; when it fails with a transient file error, runs it again after a growing wait,
 * until `timeoutMs` has passed. The last error is thrown as it came. Any other error is thrown at once.
 */
export async function retryFs<T>(
  call: string,
  operation: () => Promise<T>,
  policy: FsRetryPolicy = {},
): Promise<T> {
  const mode = policy.mode ?? 'auto';
  const on =
    mode === 'always' || (mode === 'auto' && (policy.platform ?? process.platform) === 'win32');
  const now = policy.now ?? Date.now;
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = now();
  const deadline = started + (policy.timeoutMs ?? FS_RETRY_TIMEOUT_MS);
  let wait = FIRST_WAIT_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!on || !isTransientFsError(error) || now() >= deadline) throw error;
      policy.onRetry?.({
        call,
        code: (error as NodeJS.ErrnoException).code ?? '',
        attempt,
        waitedMs: now() - started,
      });
      await sleep(wait);
      wait = Math.min(wait * 2, LONGEST_WAIT_MS);
    }
  }
}
