// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '@otheater/core';
import type { UpdateReason } from '@otheater/protocol';
import { crashPoint } from '../../chaos/crash-points.js';
import type { Logger } from '../../logger.js';
import type { HealthProbe, HealthReading } from './health.js';
import { FINAL_STEPS, readJournal, writeJournal, type UpdateJournal } from './journal.js';
import type { InstallLayout } from './layout.js';
import type { JournalTrust } from './trust.js';
import {
  clearStaging,
  exists,
  linkPrevious,
  placeStaged,
  restorePrevious,
  undoLink,
} from './swap.js';

/**
 * The applier (Phase 10, P8; architecture 5.21): the process that swaps the executable. The old
 * daemon starts it (from the new executable, in the internal mode `apply-update`), detached, and
 * shuts down; the applier waits for it to end, then walks the steps of the journal:
 *
 *   waiting -> linked -> placed -> starting -> checking -> committed
 *
 * If the new daemon does not start or does not hold, `rollback: auto` takes the old one back (and
 * the backup made before a migration), and the journal ends in `rolled_back`; `rollback: off`
 * ends in `failed` and leaves what is there. A failure before the new executable is in place
 * (the old daemon does not end, the staged file changed) moves nothing, so it is always
 * `rolled_back` and the old daemon is started again.
 *
 * Every effect goes through a port, so the tests run it over a temporary folder with fake scripts
 * for executables and the real file moves. The applier never throws for a failed version: it
 * returns the outcome. It throws only when it cannot even write the journal.
 */

export interface ApplyPorts {
  readonly clock: Pick<Clock, 'now' | 'sleep'>;
  readonly isAlive: (pid: number) => boolean;
  /** Starts the daemon of the installed executable (the service, or a detached child). */
  readonly startDaemon: () => Promise<
    { readonly ok: true } | { readonly ok: false; readonly detail: string }
  >;
  /** Stops the daemon that is running and waits for it to end. Never throws. */
  readonly stopDaemon: () => Promise<void>;
  readonly probe: HealthProbe;
  /** Puts the backup made before the migration back. Called with no daemon running. */
  readonly restoreBackup: (backupDir: string) => Promise<void>;
  readonly sha256: (file: string) => Promise<string>;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** How long to wait for the old daemon to end. Default 60 s. */
  readonly oldExitTimeoutMs?: number | undefined;
  /** The time between two looks. Default 500 ms. */
  readonly pollMs?: number | undefined;
}

export type ApplyOutcome =
  | { readonly kind: 'committed' }
  | { readonly kind: 'rolled_back'; readonly reason: UpdateReason }
  | { readonly kind: 'failed'; readonly reason: UpdateReason };

/**
 * The named points of the applier where the chaos tests kill it (Phase 11, P6; docs/23). Each is one
 * `crashPoint` call, free while no plan is armed; `detail` is the step of the journal. The points of
 * the file moves are in `swap.ts` ({@link SWAP_CRASH_POINTS}).
 */
export const APPLY_CRASH_POINTS = {
  /** The step is decided, the journal still says the one before. `detail`: the step about to be written. */
  beforeJournal: 'apply.before_journal',
  /** The journal says the step and nothing of it has run yet. `detail`: the step. */
  afterJournal: 'apply.after_journal',
  /** The daemon was started and the journal still says `starting`. */
  afterStartDaemon: 'apply.after_start_daemon',
  /** The new daemon held and the journal still says `checking`; the version is not committed yet. */
  beforeCommit: 'apply.before_commit',
} as const;

const OLD_EXIT_TIMEOUT_MS = 60_000;
const POLL_MS = 500;

async function save(
  layout: InstallLayout,
  ports: ApplyPorts,
  journal: UpdateJournal,
  patch: Partial<UpdateJournal>,
): Promise<UpdateJournal> {
  const next = { ...journal, ...patch, updatedAt: ports.clock.now() };
  await crashPoint(APPLY_CRASH_POINTS.beforeJournal, next.step);
  await writeJournal(layout.journal, next);
  await crashPoint(APPLY_CRASH_POINTS.afterJournal, next.step);
  return next;
}

async function waitFor(
  ports: ApplyPorts,
  timeoutMs: number,
  done: () => boolean | Promise<boolean>,
): Promise<boolean> {
  const deadline = ports.clock.now() + timeoutMs;
  for (;;) {
    if (await done()) return true;
    if (ports.clock.now() >= deadline) return false;
    await ports.clock.sleep(ports.pollMs ?? POLL_MS);
  }
}

/** Nothing was moved: the old version is still the executable. The old daemon is started again if it is gone. */
async function abortBeforeSwap(
  layout: InstallLayout,
  ports: ApplyPorts,
  journal: UpdateJournal,
  reason: UpdateReason,
): Promise<ApplyOutcome> {
  await undoLink(layout);
  ports.logger.warn(
    { reason, to: journal.to },
    'update: the swap did not start; nothing was changed',
  );
  if (journal.oldPid === 0 || !ports.isAlive(journal.oldPid)) {
    const started = await ports.startDaemon();
    if (!started.ok)
      ports.logger.error({ detail: started.detail }, 'update: the old daemon did not start again');
  }
  await save(layout, ports, journal, { step: 'rolled_back', reason, reported: false });
  return { kind: 'rolled_back', reason };
}

/**
 * Takes the old version back: stops the new daemon, puts the backup of the migration back (when
 * there is one), renames `previous/` over the executable and, with `restart`, starts the old
 * daemon. Safe to run again after a stop in the middle (every step looks at what is there).
 */
export async function rollBack(
  layout: InstallLayout,
  ports: ApplyPorts,
  journal: UpdateJournal,
  reason: UpdateReason,
  restart: boolean,
): Promise<ApplyOutcome> {
  let current = await save(layout, ports, journal, { step: 'rolling_back', reason });
  await ports.stopDaemon();
  if (current.backup !== null) {
    try {
      await ports.restoreBackup(current.backup);
    } catch (error) {
      // The old executable goes back all the same: the Producer is told, and the copy is still there.
      ports.logger.error(
        { err: error, backup: current.backup },
        'update: the backup could not be restored',
      );
    }
  }
  if (await exists(layout.previousExe)) await restorePrevious(layout);
  if (restart) {
    const started = await ports.startDaemon();
    if (!started.ok)
      ports.logger.error({ detail: started.detail }, 'update: the old daemon did not start again');
  }
  current = await save(layout, ports, current, { step: 'rolled_back', reason, reported: false });
  ports.logger.warn({ reason, from: current.from, to: current.to }, 'update: rolled back');
  return { kind: 'rolled_back', reason };
}

async function fail(
  layout: InstallLayout,
  ports: ApplyPorts,
  journal: UpdateJournal,
  reason: UpdateReason,
  restart: boolean,
): Promise<ApplyOutcome> {
  if (journal.rollback === 'auto') return await rollBack(layout, ports, journal, reason, restart);
  await save(layout, ports, journal, { step: 'failed', reason, reported: false });
  ports.logger.error(
    { reason, to: journal.to },
    'update: the new version failed and rollback is off; left as it is',
  );
  return { kind: 'failed', reason };
}

/** The wait for the first good answer, then for the daemon to hold. Returns the reason it did not. */
async function watch(
  ports: ApplyPorts,
  journal: UpdateJournal,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: UpdateReason }> {
  const expect = { version: journal.to, notPid: journal.oldPid };
  let seen = 'down' as HealthReading;
  const answered = await waitFor(ports, journal.healthTimeoutMs, async () => {
    seen = await ports.probe(expect);
    return seen === 'ok';
  });
  if (!answered) return { ok: false, reason: seen === 'unhealthy' ? 'health' : 'not_started' };
  const until = ports.clock.now() + journal.stableMs;
  while (ports.clock.now() < until) {
    await ports.clock.sleep(
      Math.min(ports.pollMs ?? POLL_MS, Math.max(1, until - ports.clock.now())),
    );
    if ((await ports.probe(expect)) !== 'ok') return { ok: false, reason: 'unstable' };
  }
  return { ok: true };
}

/** The whole swap, from the journal the old daemon wrote (step `waiting`). */
export async function runApply(
  layout: InstallLayout,
  ports: ApplyPorts,
  initial: UpdateJournal,
): Promise<ApplyOutcome> {
  let journal = await save(layout, ports, initial, { step: 'waiting', applierPid: process.pid });

  if (journal.oldPid > 0) {
    const gone = await waitFor(
      ports,
      ports.oldExitTimeoutMs ?? OLD_EXIT_TIMEOUT_MS,
      () => !ports.isAlive(journal.oldPid),
    );
    if (!gone) return await abortBeforeSwap(layout, ports, journal, 'swap_failed');
  }

  let staged: string | undefined;
  try {
    staged = (await exists(layout.stagingExe)) ? await ports.sha256(layout.stagingExe) : undefined;
  } catch {
    staged = undefined;
  }
  if (staged !== journal.sha256)
    return await abortBeforeSwap(layout, ports, journal, 'hash_changed');

  try {
    await linkPrevious(layout);
  } catch (error) {
    ports.logger.error({ err: error }, 'update: the old executable could not be kept');
    return await abortBeforeSwap(layout, ports, journal, 'swap_failed');
  }
  journal = await save(layout, ports, journal, { step: 'linked' });
  try {
    await placeStaged(layout);
  } catch (error) {
    ports.logger.error({ err: error }, 'update: the new executable could not be put in place');
    return await abortBeforeSwap(layout, ports, journal, 'swap_failed');
  }
  journal = await save(layout, ports, journal, { step: 'placed' });
  return await startAndWatch(layout, ports, journal, true);
}

/** From `placed` on: start the daemon, wait for it, and keep or take back the version. */
async function startAndWatch(
  layout: InstallLayout,
  ports: ApplyPorts,
  initial: UpdateJournal,
  restart: boolean,
): Promise<ApplyOutcome> {
  let journal = await save(layout, ports, initial, { step: 'starting' });
  const started = await ports.startDaemon();
  if (!started.ok) {
    ports.logger.error({ detail: started.detail }, 'update: the new daemon could not be started');
    return await fail(layout, ports, journal, 'not_started', restart);
  }
  await crashPoint(APPLY_CRASH_POINTS.afterStartDaemon);
  journal = await save(layout, ports, journal, { step: 'checking' });
  const seen = await watch(ports, journal);
  if (!seen.ok) return await fail(layout, ports, journal, seen.reason, restart);
  return await commit(layout, ports, journal);
}

async function commit(
  layout: InstallLayout,
  ports: ApplyPorts,
  journal: UpdateJournal,
): Promise<ApplyOutcome> {
  await crashPoint(APPLY_CRASH_POINTS.beforeCommit);
  // The journal first: while it still asks for something, the proof it rests on is beside it (P8a).
  await save(layout, ports, journal, { step: 'committed', reason: null, reported: false });
  await clearStaging(layout);
  ports.logger.info({ from: journal.from, to: journal.to }, 'update: applied');
  return { kind: 'committed' };
}

export type RecoveryResult =
  /** No journal, or a swap that already ended. */
  | { readonly kind: 'none' }
  /** The journal cannot be read: nothing is done, the file is left for the person. */
  | { readonly kind: 'corrupt' }
  /** The applier is still running: it is not interrupted. */
  | { readonly kind: 'running' }
  /** The journal asks for something no signed manifest backs (P8a): nothing is done. */
  | { readonly kind: 'untrusted'; readonly detail: string }
  | { readonly kind: 'finished'; readonly outcome: ApplyOutcome };

/**
 * What the next start of `ot` does with a swap whose applier died (a power cut, a kill):
 * - `waiting`: nothing was moved; the swap is undone;
 * - `linked`: if the new executable is already in place (the cut came between the rename and the
 *   journal), it goes on as `placed`; if not, the link is undone;
 * - `placed`, `starting`, `checking`: the new version is looked at now (`/v1/health`); if it
 *   answers it is kept, if not it is taken back (or left, with `rollback: off`);
 * - `rolling_back`: the rollback is finished.
 * `restart` says whether the old daemon is started again after a rollback (the CLI that finds
 * the journal leaves that to the command it is running).
 */
export async function recoverInterrupted(
  layout: InstallLayout,
  ports: ApplyPorts,
  restart: boolean,
  trust: (journal: UpdateJournal) => Promise<JournalTrust>,
): Promise<RecoveryResult> {
  const reading = await readJournal(layout.journal);
  if (reading.kind === 'none') return { kind: 'none' };
  if (reading.kind === 'corrupt') return { kind: 'corrupt' };
  const { journal } = reading;
  if (FINAL_STEPS.includes(journal.step)) return { kind: 'none' };
  if (
    journal.applierPid > 0 &&
    journal.applierPid !== process.pid &&
    ports.isAlive(journal.applierPid)
  ) {
    return { kind: 'running' };
  }
  // A journal that no signed manifest backs is not followed: it moves nothing and starts nothing.
  const trusted = await trust(journal);
  if (!trusted.ok) {
    ports.logger.error(
      { step: journal.step, to: journal.to, detail: trusted.detail },
      'update: the journal of an interrupted swap is not backed by a signed manifest; ignored',
    );
    return { kind: 'untrusted', detail: trusted.detail };
  }
  ports.logger.warn(
    { step: journal.step, to: journal.to },
    'update: a swap was interrupted; finishing it',
  );

  switch (journal.step) {
    case 'waiting': {
      await undoLink(layout);
      await save(layout, ports, journal, {
        step: 'rolled_back',
        reason: 'interrupted',
        reported: false,
      });
      return { kind: 'finished', outcome: { kind: 'rolled_back', reason: 'interrupted' } };
    }
    case 'linked': {
      const inPlace =
        (await exists(layout.exe)) && (await ports.sha256(layout.exe)) === journal.sha256;
      if (!inPlace) {
        await undoLink(layout);
        await save(layout, ports, journal, {
          step: 'rolled_back',
          reason: 'interrupted',
          reported: false,
        });
        return { kind: 'finished', outcome: { kind: 'rolled_back', reason: 'interrupted' } };
      }
      return await judge(
        layout,
        ports,
        await save(layout, ports, journal, { step: 'placed' }),
        restart,
      );
    }
    case 'rolling_back':
      return {
        kind: 'finished',
        outcome: await rollBack(layout, ports, journal, journal.reason ?? 'interrupted', restart),
      };
    case 'placed':
    case 'starting':
    case 'checking':
      return await judge(layout, ports, journal, restart);
    case 'committed':
    case 'rolled_back':
    case 'failed':
      return { kind: 'none' };
  }
}

async function judge(
  layout: InstallLayout,
  ports: ApplyPorts,
  journal: UpdateJournal,
  restart: boolean,
): Promise<RecoveryResult> {
  const reading = await ports.probe({ version: journal.to, notPid: journal.oldPid });
  if (reading === 'ok') {
    return { kind: 'finished', outcome: await commit(layout, ports, journal) };
  }
  return { kind: 'finished', outcome: await fail(layout, ports, journal, 'interrupted', restart) };
}
