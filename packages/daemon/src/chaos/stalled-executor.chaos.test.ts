// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { FakeClientAdapter, FakeClock, InMemorySecretVault } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import type { AttemptOutcome } from '../execution/attempt-runner.js';
import { aliveEntries, isAlive } from './census.js';
import {
  eventsOf,
  installExecutorFakes,
  scriptPrompt,
  withExecutorRig,
  type ExecutorRig,
} from './executor-fixture.js';

installExecutorFakes({
  clock: () => new FakeClock(),
  vault: () => new InMemorySecretVault(),
  client: ({ parts, unenforced, enforcement, command, env }) =>
    new FakeClientAdapter({
      launcher: parts.launcher,
      baseEnv: {},
      env,
      adapterVersion: '1.0.0',
      enforcement,
      unenforced,
      command,
    }),
});

/**
 * Chaos B, the stalled Executor (docs/23, P4; table "Como cada falha é simulada", line "Executor
 * travado"). The client is alive and mute: it answers nothing, ignores the cancel and (in one
 * case) the polite signal. Time is the fake clock: nothing here waits for a number of
 * milliseconds. A step waits for an EVENT (a chunk in the log, a pid file) and only then moves the
 * clock, so the result is the same on a fast and on a slow machine.
 *
 * What is measured: the way the attempt ends (cause, decision), the launches (the ceiling of
 * attempts: a stalled client is never launched again by itself), and the processes that remain
 * (the census): the agent and what it started. At the end of each `withExecutorRig` the run goes
 * through I1, I3, I5 and I7.
 */

const STUCK = 'resume:\n  stuck:\n    no_event_for: 2m\n';
const MINUTE = 60_000;

const agentPids = (rig: ExecutorRig): number[] =>
  rig
    .census()
    .entries.filter((entry) => entry.source === 'sessions')
    .map((entry) => entry.pid);

/** The attempt, plus a flag that tells whether it already ended. */
function watched(run: Promise<AttemptOutcome>): {
  readonly outcome: Promise<AttemptOutcome>;
  readonly ended: () => boolean;
} {
  let done = false;
  const outcome = run.finally(() => {
    done = true;
  });
  return { outcome, ended: () => done };
}

/**
 * Moves the clock by `step` until the attempt ends. A chunk that the agent sends after a move
 * restarts the silence, so one move may not be enough; each lap waits for the end or for the
 * event loop, never for a number of milliseconds, and the laps are capped well under the demand
 * limit so a real fault ends the test instead of hanging it.
 */
async function advanceUntilEnded(
  rig: ExecutorRig,
  attempt: Promise<AttemptOutcome>,
  step: number,
): Promise<AttemptOutcome> {
  const state = { ended: false };
  const outcome = attempt.finally(() => {
    state.ended = true;
  });
  for (let lap = 0; lap < 10 && !state.ended; lap += 1) {
    await rig.clock.advance(step);
    await Promise.race([
      outcome.catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      }),
    ]);
  }
  return outcome;
}

const opened = (events: readonly { type: string }[]): number =>
  events.filter((event) => event.type === 'session.opened').length;

describe('chaos B: the stalled Executor', () => {
  it('stall: the watchdog ends it on the clock, once, and nothing of it stays alive', async () => {
    await withExecutorRig({ config: STUCK }, async (rig) => {
      const attempt = watched(rig.attempt(scriptPrompt('stall', { chunks: 1, lifeMs: 60_000 })));
      await rig.waitForEvent('the chunk before the silence', (e) => e.type === 'session.update');
      const pids = agentPids(rig);
      expect(pids).toHaveLength(1);
      expect(pids.every((pid) => isAlive(pid))).toBe(true);

      // One second short of the limit: the clock decides, so the attempt is still there.
      await rig.clock.advance(2 * MINUTE - 1000);
      expect(attempt.ended()).toBe(false);
      expect(pids.every((pid) => isAlive(pid))).toBe(true);

      await rig.clock.advance(1000);
      const outcome = await attempt.outcome;
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'stuck',
        needsDecision: true,
        countsAsAttempt: true,
        resumes: 0,
        decision: { action: 'handoff', differentExecutor: true, countsAsAttempt: true },
      });
      // No Executor is configured to take the baton: the attempt is parked, not run again.
      expect(outcome.handoffWait?.reason).toBe('no_other_executor');
      expect(outcome.handoffs).toHaveLength(0);

      const events = await rig.events();
      expect(opened(events)).toBe(1);
      expect(eventsOf(events, 'session.interrupted')).toHaveLength(1);
      expect(eventsOf(events, 'session.processes_left')).toHaveLength(0);
      expect(pids.some((pid) => isAlive(pid))).toBe(false);
      expect(aliveEntries(rig.census())).toEqual([]);
    });
  });

  it('ignore-term: a client that ignores SIGTERM is ended by the escalation to SIGKILL', async () => {
    await withExecutorRig({ config: STUCK, script: 'ignore-term' }, async (rig) => {
      const attempt = rig.attempt('anything');
      // The agent arms its signals before it serves the first request: once the session is open
      // it is already deaf to SIGTERM.
      await rig.waitForEvent('the session is open', (e) => e.type === 'session.opened');
      const pids = agentPids(rig);
      expect(pids).toHaveLength(1);
      const outcome = await advanceUntilEnded(rig, attempt, 2 * MINUTE);
      expect(outcome).toMatchObject({ state: 'interrupted', cause: 'stuck' });
      const events = await rig.events();
      expect(eventsOf(events, 'session.processes_left')).toHaveLength(0);
      expect(pids.some((pid) => isAlive(pid))).toBe(false);
      expect(aliveEntries(rig.census())).toEqual([]);
    });
  });

  it('spawn-child: the grandchild of a stalled client dies with the tree', async () => {
    await withExecutorRig({ config: STUCK }, async (rig) => {
      const attempt = rig.attempt(
        scriptPrompt('spawn-child', {
          file: 'pids/grandchild.pid',
          after: 'stall',
          lifeMs: 60_000,
        }),
      );
      const grandchild = Number(
        (await rig.waitForFile(join(rig.stateDir, 'pids', 'grandchild.pid'))).trim(),
      );
      await rig.waitForEvent('the pid in a chunk', (e) => e.type === 'session.update');
      expect(isAlive(grandchild)).toBe(true);
      expect(rig.census().entries.map((entry) => entry.pid)).toContain(grandchild);

      const outcome = await advanceUntilEnded(rig, attempt, 2 * MINUTE);
      expect(outcome).toMatchObject({ state: 'interrupted', cause: 'stuck' });
      expect(isAlive(grandchild)).toBe(false);
      expect(eventsOf(await rig.events(), 'session.processes_left')).toHaveLength(0);
      expect(aliveEntries(rig.census())).toEqual([]);
    });
  });
});
