// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killProcessTree, KILL_SETTLE_MS, sendSignal, type KillDeps } from './kill-tree.js';
import type { ProcessInfo, ProcessSnapshot } from './process-table.js';

const proc = (
  pid: number,
  ppid: number,
  pgid: number,
  extra: Partial<ProcessInfo> = {},
): ProcessInfo => ({ pid, ppid, pgid, zombie: false, start: `s${String(pid)}`, ...extra });

/** A fake system with a virtual clock; `react` decides who dies on which signal. */
class FakeSystem {
  rows = new Map<number, ProcessInfo>();
  time = 0;
  readonly sent: { pid: number; signal: string; group: boolean }[] = [];
  /** Pids that survive SIGTERM (and SIGKILL if in `immortal`). */
  readonly ignoreTerm = new Set<number>();
  readonly immortal = new Set<number>();
  /** Called after every sleep, to let a test fork or reap processes. */
  onTick: (() => void) | undefined;

  constructor(...rows: ProcessInfo[]) {
    for (const row of rows) this.rows.set(row.pid, row);
  }

  readonly deps: KillDeps = {
    table: () => Promise.resolve(new Map(this.rows) as ProcessSnapshot),
    signal: (pid, signal, group) => {
      this.sent.push({ pid, signal, group });
      for (const row of [...this.rows.values()]) {
        const hit = group ? row.pgid === pid : row.pid === pid;
        if (!hit || this.immortal.has(row.pid)) continue;
        if (signal === 'SIGTERM' && this.ignoreTerm.has(row.pid)) continue;
        this.rows.delete(row.pid);
      }
    },
    sleep: (ms) => {
      this.time += ms;
      this.onTick?.();
      return Promise.resolve();
    },
    now: () => this.time,
  };
}

const target = (rootPid: number) => ({ rootPid, rootStart: `s${String(rootPid)}` });

describe('killProcessTree', () => {
  it('ends the group with one group signal and reports found, not forced, nothing remaining', async () => {
    const sys = new FakeSystem(proc(100, 1, 100), proc(101, 100, 100), proc(102, 101, 100));
    const report = await killProcessTree(target(100), 1000, sys.deps);
    expect(report).toEqual({ found: 3, forced: false, remaining: [] });
    expect(sys.sent).toEqual([{ pid: 100, signal: 'SIGTERM', group: true }]);
  });

  it('finds a descendant that left the group through its parent chain', async () => {
    const sys = new FakeSystem(proc(100, 1, 100), proc(101, 100, 100), proc(200, 101, 200));
    const report = await killProcessTree(target(100), 1000, sys.deps);
    expect(report.found).toBe(3);
    expect(report.remaining).toEqual([]);
    expect(sys.sent).toContainEqual({ pid: 200, signal: 'SIGTERM', group: false });
  });

  it('never touches a process that merely shares a recycled pid', async () => {
    // Pid 100 now belongs to an unrelated process with another start time.
    const sys = new FakeSystem(proc(100, 1, 100, { start: 'other' }), proc(300, 1, 300));
    const report = await killProcessTree(target(100), 1000, sys.deps);
    expect(report).toEqual({ found: 0, forced: false, remaining: [] });
    expect(sys.sent).toEqual([]);
  });

  it('does not count zombies as alive or as found', async () => {
    const sys = new FakeSystem(
      proc(100, 1, 100, { zombie: true }),
      proc(101, 100, 100, { zombie: true }),
    );
    const report = await killProcessTree(target(100), 1000, sys.deps);
    expect(report).toEqual({ found: 0, forced: false, remaining: [] });
    expect(sys.sent).toEqual([]);
  });

  it('polls the table and politely signals what the tree forks while it dies', async () => {
    const sys = new FakeSystem(proc(100, 1, 100), proc(101, 100, 100));
    sys.ignoreTerm.add(101);
    let forked = false;
    sys.onTick = () => {
      if (forked) return;
      forked = true;
      sys.rows.set(500, proc(500, 101, 500));
    };
    const report = await killProcessTree(target(100), 200, sys.deps);
    expect(sys.sent).toContainEqual({ pid: 500, signal: 'SIGTERM', group: false });
    expect(report.found).toBe(2);
    expect(report.forced).toBe(true);
    expect(report.remaining).toEqual([]);
  });

  it('uses SIGKILL after the grace period for a process that ignores SIGTERM', async () => {
    const sys = new FakeSystem(proc(100, 1, 100), proc(101, 100, 100));
    sys.ignoreTerm.add(101);
    const report = await killProcessTree(target(100), 100, sys.deps);
    expect(report).toEqual({ found: 2, forced: true, remaining: [] });
    expect(sys.sent.at(-1)).toEqual({ pid: 100, signal: 'SIGKILL', group: true });
    expect(sys.time).toBeGreaterThanOrEqual(100);
  });

  it('with graceMs 0 goes straight to SIGKILL', async () => {
    const sys = new FakeSystem(proc(100, 1, 100));
    sys.ignoreTerm.add(100);
    const report = await killProcessTree(target(100), 0, sys.deps);
    expect(report).toEqual({ found: 1, forced: true, remaining: [] });
  });

  it('reports what is still alive after the settle time, and stops trying', async () => {
    const sys = new FakeSystem(proc(100, 1, 100), proc(101, 100, 100));
    sys.immortal.add(101);
    const report = await killProcessTree(target(100), 50, sys.deps);
    expect(report).toEqual({ found: 2, forced: true, remaining: [101] });
    expect(sys.time).toBeLessThan(50 + KILL_SETTLE_MS + 200);
  });
});

describe('sendSignal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses pid 0, 1, negatives, non-integers and its own pid', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    for (const pid of [0, 1, -5, 1.5, Number.NaN, process.pid]) sendSignal(pid, 'SIGTERM', true);
    expect(kill).not.toHaveBeenCalled();
  });

  it('signals the group with a negative pid and a lone process with a positive one', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    sendSignal(4242, 'SIGTERM', true);
    sendSignal(4243, 'SIGKILL', false);
    expect(kill).toHaveBeenNthCalledWith(1, -4242, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 4243, 'SIGKILL');
  });

  it('swallows ESRCH and EPERM but rethrows anything else', () => {
    const failWith = (code: string): void => {
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
    };
    failWith('ESRCH');
    expect(() => {
      sendSignal(4242, 'SIGTERM', true);
    }).not.toThrow();
    failWith('EPERM');
    expect(() => {
      sendSignal(4242, 'SIGTERM', true);
    }).not.toThrow();
    failWith('EINVAL');
    expect(() => {
      sendSignal(4242, 'SIGTERM', true);
    }).toThrow('EINVAL');
  });
});
