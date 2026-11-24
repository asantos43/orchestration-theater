// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { assertHarnessBuilt, ChaosRig, type ControlAnswer, type RunReport } from './harness.js';
import { assertInvariants, checkI1, checkI2, checkI5, checkI8 } from './invariants.js';

/**
 * The full disk (Phase 11, P5; N279; docs/23). The daemon runs as a process, with a play in flight,
 * and the disk fills with each of the three mechanisms of the table of simulations:
 *
 * - `max_page_count`: the store may not grow (`cap 0` of the control folder), the way SQLite itself
 *   says "database or disk is full";
 * - a fault point: `store.write=SQLITE_FULL` (a commit that fails before it is made) and
 *   `fs.write:log=ENOSPC` (the write of a line of `daemon.log`), through `OT_TEST_FAULT`;
 * - a small real file system: a tmpfs over the folder of the logs, in a mount namespace made by
 *   `unshare -rm` (no root needed where the kernel lets a user make one, and it is a file system
 *   that really answers ENOSPC), filled by a ballast file.
 *
 * What each test holds: no partial write becomes state (I1, I2 and the rest of the invariants after
 * the play ends), the notice follows `disk.notify`, the daemon pauses, stops or goes on as
 * `disk.on_full` says, and when the space is back it returns by itself and a play that was hit
 * finishes. The runs use the build output (`pnpm build` first), one test at a time.
 */

beforeAll(assertHarnessBuilt);
afterAll(disposeTestGitIsolation);

/** A rule that is armed from the start (so the store is given its hooks) and never fires: the test re-arms it. */
const DORMANT_STORE_FAULT = 'store.write=SQLITE_FULL#999999';
const DORMANT_LOG_FAULT = 'fs.write:log=ENOSPC#999999';
const FULL_STORE_FAULT = 'store.write=SQLITE_FULL#1x0';
const FULL_LOG_FAULT = 'fs.write:log=ENOSPC#1x0';

/** `disk.check_every` of the runs: short, so the way back is tried often. */
const CHECK_EVERY = '1s';

interface Run {
  readonly rig: ChaosRig;
  readonly child: ReturnType<ChaosRig['start']>;
}

/**
 * Starts the daemon with the Producer's message sent and one client launch (the play's Director)
 * held at the test gate, so the play exists and the test chooses when the disk fills.
 */
async function startHeld(
  rig: ChaosRig,
  env: Readonly<Record<string, string>>,
  prefix?: readonly string[],
): Promise<Run> {
  const child = rig.start({
    mode: 'first',
    ...(prefix === undefined ? {} : { prefix }),
    env: {
      OT_CHILD_WAIT: '1',
      OT_CHILD_HOLD_LAUNCH: rig.holdGate,
      OT_CHILD_HOLD_AFTER: '1',
      OT_CHILD_DISK_CHECK_EVERY: CHECK_EVERY,
      OT_CHILD_DEADLINE_MS: '120000',
      ...env,
    },
  });
  await child.line('STARTED', 60_000);
  await rig.waitHeld();
  return { rig, child };
}

async function until(
  run: Run,
  want: (answer: ControlAnswer) => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<ControlAnswer> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (run.child.process.exitCode !== null || run.child.process.signalCode !== null) {
      throw new Error(`The child ended before: ${what}.\n${run.child.output()}`);
    }
    const answer = await run.rig.control('status', '', 10_000).catch((error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${run.child.output()}`,
      );
    });
    if (want(answer)) return answer;
    if (Date.now() > deadline) throw new Error(`Not reached in ${String(timeoutMs)} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The `kind` of every `daemon.notice` in the store, in order (read from outside, after the run). */
function noticeKinds(storePath: string): string[] {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT payload FROM events WHERE type = 'daemon.notice' ORDER BY id")
      .all() as { payload: string }[];
    return rows
      .map((row) => (JSON.parse(row.payload) as { kind: string }).kind)
      .filter((kind) => kind.startsWith('disk_'));
  } finally {
    db.close();
  }
}

function stoppedReasons(storePath: string): string[] {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT payload FROM events WHERE type = 'daemon.stopped' ORDER BY id")
      .all() as { payload: string }[];
    return rows.map((row) => (JSON.parse(row.payload) as { reason: string }).reason);
  } finally {
    db.close();
  }
}

/** The tail of the event log (type and the start of the payload), for a run that did not end. */
function lastEvents(storePath: string): string[] {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT id, type, payload FROM events ORDER BY id DESC LIMIT 25')
      .all() as { id: number; type: string; payload: string }[];
    return rows
      .reverse()
      .map((row) => `${String(row.id)} ${row.type} ${row.payload.slice(0, 160)}`);
  } finally {
    db.close();
  }
}

async function finish(run: Run): Promise<RunReport> {
  const report = (await run.child.line('REPORT ', 120_000)) as RunReport;
  await run.child.exited;
  return report;
}

/** The invariants of a run that ended by itself: nothing partial became state, and the play finished. */
function expectWhole(rig: ChaosRig, report: RunReport): void {
  if (report.timedOut) {
    throw new Error(
      `The play did not end.\n${JSON.stringify(report.plays)}\n${lastEvents(rig.storePath).join('\n')}`,
    );
  }
  expect(report.plays.map((play) => play.state)).toEqual(['DONE']);
  assertInvariants(rig.evaluate({ census: rig.census(), report, boots: 1 }));
}

describe.skipIf(process.platform !== 'linux')('the full disk', { timeout: 300_000 }, () => {
  it('pause, max_page_count: the store cannot grow, the daemon closes the gate, tells once, returns by itself and the play finishes', async () => {
    const rig = await ChaosRig.create();
    try {
      const run = await startHeld(rig, {
        // Any armed rule: the handle that limits the growth of the store exists only then (test only).
        OT_TEST_FAULT: DORMANT_STORE_FAULT,
        OT_CHILD_DISK_ON_FULL: 'pause',
        OT_CHILD_DISK_NOTIFY: 'once',
        OT_CHILD_DISK_MIN_FREE: 'off',
      });
      await rig.control('cap', '0');
      await rig.release();
      const full = await until(run, (answer) => answer.disk.state === 'full', 'the disk is full');
      expect(full.paused).toBe(true);
      expect(full.disk.areas).toContain('store');
      // The gate: no new play opens while the disk is full.
      const refused = await rig.control('open-play');
      expect(refused).toMatchObject({ opened: false, code: 'disk_full' });
      await rig.control('cap', 'off');
      const back = await until(run, (answer) => answer.disk.state === 'ok', 'the disk is back');
      expect(back.paused).toBe(false);
      const report = await finish(run);
      expectWhole(rig, report);
      // `once`: one notice when it filled and one when it came back, written in that order.
      expect(noticeKinds(rig.storePath)).toEqual(['disk_full', 'disk_recovered']);
    } finally {
      await rig.dispose();
    }
  });

  it('pause, SQLITE_FULL at the commit: the transaction is rolled back, and the play that was hit is resumed', async () => {
    const rig = await ChaosRig.create();
    try {
      const run = await startHeld(rig, {
        OT_TEST_FAULT: DORMANT_STORE_FAULT,
        OT_CHILD_DISK_ON_FULL: 'pause',
        OT_CHILD_DISK_MIN_FREE: 'off',
      });
      await rig.control('fault', FULL_STORE_FAULT);
      await rig.release();
      const full = await until(run, (answer) => answer.disk.state === 'full', 'the disk is full');
      expect(full.paused).toBe(true);
      await rig.control('fault-off');
      await until(run, (answer) => answer.disk.state === 'ok', 'the disk is back');
      const report = await finish(run);
      expectWhole(rig, report);
      expect(noticeKinds(rig.storePath)).toEqual(['disk_full', 'disk_recovered']);
    } finally {
      await rig.dispose();
    }
  });

  it('pause, ENOSPC at the write of the log: the gate closes, and it opens when the write goes through', async () => {
    const rig = await ChaosRig.create();
    try {
      const run = await startHeld(rig, {
        OT_TEST_FAULT: DORMANT_LOG_FAULT,
        OT_CHILD_REAL_LOG: '1',
        OT_CHILD_DISK_ON_FULL: 'pause',
        OT_CHILD_DISK_MIN_FREE: 'off',
      });
      await rig.control('fault', FULL_LOG_FAULT);
      // The next line of the log finds no room (the daemon logs as it works).
      await rig.release();
      const full = await until(run, (answer) => answer.disk.state === 'full', 'the disk is full');
      expect(full.paused).toBe(true);
      expect(full.disk.areas).toContain('log');
      await rig.control('fault-off');
      await until(run, (answer) => answer.disk.state === 'ok', 'the disk is back');
      const report = await finish(run);
      expectWhole(rig, report);
      expect(noticeKinds(rig.storePath)).toEqual(['disk_full', 'disk_recovered']);
    } finally {
      await rig.dispose();
    }
  });

  it('stop: the daemon tells and then stops itself with the reason error, and what it wrote is whole', async () => {
    const rig = await ChaosRig.create();
    try {
      const child = rig.start({
        mode: 'first',
        env: {
          OT_TEST_FAULT: DORMANT_LOG_FAULT,
          OT_CHILD_REAL_LOG: '1',
          OT_CHILD_EXIT_ON_STOP: '1',
          OT_CHILD_HOLD_LAUNCH: rig.holdGate,
          OT_CHILD_HOLD_AFTER: '1',
          OT_CHILD_DISK_ON_FULL: 'stop',
          OT_CHILD_DISK_MIN_FREE: 'off',
        },
      });
      await child.line('STARTED', 60_000);
      await rig.waitHeld();
      await rig.control('fault', FULL_LOG_FAULT);
      await rig.release();
      await child.line('STOPPED', 60_000);
      const exit = await child.exited;
      expect(exit.code).toBe(0);
      expect(noticeKinds(rig.storePath)).toEqual(['disk_full']);
      expect(stoppedReasons(rig.storePath)).toEqual(['error']);
      // The play did not end here (the daemon stopped); what is on disk is whole all the same.
      assertInvariants([
        checkI1({ dataDir: rig.dataDir }),
        checkI2({ storePath: rig.storePath, ledger: rig.ledger }),
        checkI5({ storePath: rig.storePath }),
        checkI8({ storePath: rig.storePath, ledger: rig.ledger }),
      ]);
    } finally {
      await rig.dispose();
    }
  });

  it('continue: the daemon does not pause, still tells, and the play finishes when the space is back', async () => {
    const rig = await ChaosRig.create();
    try {
      const run = await startHeld(rig, {
        OT_TEST_FAULT: DORMANT_STORE_FAULT,
        OT_CHILD_DISK_ON_FULL: 'continue',
        OT_CHILD_DISK_MIN_FREE: 'off',
      });
      await rig.control('fault', FULL_STORE_FAULT);
      await rig.release();
      const full = await until(run, (answer) => answer.disk.state === 'full', 'the disk is full');
      // The gate stays open: the refusal is not the disk's (this daemon has no code host here).
      expect(full.paused).toBe(false);
      const open = await rig.control('open-play');
      expect(open).toMatchObject({ opened: false, code: 'no_code_host' });
      await rig.control('fault-off');
      await until(run, (answer) => answer.disk.state === 'ok', 'the disk is back');
      const report = await finish(run);
      expectWhole(rig, report);
      expect(noticeKinds(rig.storePath)).toEqual(['disk_full', 'disk_recovered']);
    } finally {
      await rig.dispose();
    }
  });

  it('notify: off keeps the daemon pausing and returning, and writes no notice', async () => {
    const rig = await ChaosRig.create();
    try {
      const run = await startHeld(rig, {
        OT_TEST_FAULT: DORMANT_STORE_FAULT,
        OT_CHILD_DISK_ON_FULL: 'pause',
        OT_CHILD_DISK_NOTIFY: 'off',
        OT_CHILD_DISK_MIN_FREE: 'off',
      });
      await rig.control('fault', FULL_STORE_FAULT);
      await rig.release();
      const full = await until(run, (answer) => answer.disk.state === 'full', 'the disk is full');
      expect(full.paused).toBe(true);
      await rig.control('fault-off');
      await until(run, (answer) => answer.disk.state === 'ok', 'the disk is back');
      const report = await finish(run);
      expectWhole(rig, report);
      expect(noticeKinds(rig.storePath)).toEqual([]);
    } finally {
      await rig.dispose();
    }
  });
});

/**
 * A small real file system: `unshare -rm` makes a user and mount namespace and `mount -t tmpfs`
 * mounts one over the folder of the logs of the daemon (`<data>/logs`). Where the kernel does not
 * let a user do that (no unprivileged user namespaces, a container without the capability, no
 * `unshare` or `mount`), the test is skipped and the reason is printed [N]: it is not known that
 * the CI of the project can run it (docs/23, P5).
 */
function mountProblem(): string | undefined {
  if (process.platform !== 'linux') return 'not Linux';
  const probe = mkdtempSync(join(tmpdir(), 'otheater-mount-probe-'));
  try {
    const result = spawnSync(
      'unshare',
      ['-rm', 'sh', '-c', `mount -t tmpfs -o size=1m tmpfs "${probe}" && touch "${probe}/x"`],
      { encoding: 'utf8' },
    );
    if (result.error !== undefined) return `unshare is not available: ${result.error.message}`;
    if (result.status !== 0) {
      return `unshare -rm and mount -t tmpfs failed without root (${result.stderr.trim()})`;
    }
    return undefined;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const MOUNT_PROBLEM = mountProblem();
if (MOUNT_PROBLEM !== undefined) {
  process.stderr.write(`[chaos] the tmpfs test is skipped: ${MOUNT_PROBLEM}\n`);
}

describe.skipIf(MOUNT_PROBLEM !== undefined)(
  'the full disk, on a small real file system',
  { timeout: 300_000 },
  () => {
    it('pause: a tmpfs over the logs is filled, the daemon sees ENOSPC and the free space, and returns when the ballast is freed', async () => {
      const rig = await ChaosRig.create();
      try {
        const logs = join(rig.dataDir, 'logs');
        const prefix = [
          'unshare',
          '-rm',
          'sh',
          '-c',
          `mkdir -p "${logs}" && mount -t tmpfs -o size=2m tmpfs "${logs}" && exec "$0" "$@"`,
        ];
        const run = await startHeld(
          rig,
          {
            OT_CHILD_REAL_LOG: '1',
            OT_CHILD_DISK_ON_FULL: 'pause',
            OT_CHILD_DISK_NOTIFY: 'once',
            // The tmpfs is 2 MB: below this the disk counts as full.
            OT_CHILD_DISK_MIN_FREE: '256KB',
          },
          prefix,
        );
        await rig.control('fill', logs);
        await rig.release();
        const full = await until(run, (answer) => answer.disk.state === 'full', 'the disk is full');
        expect(full.paused).toBe(true);
        expect(full.disk.areas).toContain('log');
        expect(await rig.control('open-play')).toMatchObject({ opened: false, code: 'disk_full' });
        await rig.control('free', logs);
        const back = await until(run, (answer) => answer.disk.state === 'ok', 'the disk is back');
        expect(back.paused).toBe(false);
        const report = await finish(run);
        expectWhole(rig, report);
        expect(noticeKinds(rig.storePath)).toEqual(['disk_full', 'disk_recovered']);
      } finally {
        await rig.dispose();
      }
    });
  },
);
