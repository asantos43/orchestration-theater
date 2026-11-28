// SPDX-License-Identifier: MPL-2.0
import { durationMs } from '@otheater/workflows';
import { eventMatches, sleepOrAbort } from './support.js';
import type { StepContext, StepResult, StepRunner } from './types.js';

/** How many events of the log are read at a time. [proposta] */
const READ_BATCH = 200;

interface Wait {
  readonly deadline: number;
  readonly cursor: number;
}

function savedWait(ctx: StepContext): Wait | undefined {
  const value = ctx.memo.get('wait');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { deadline, cursor } = value;
  return typeof deadline === 'number' && typeof cursor === 'number'
    ? { deadline, cursor }
    : undefined;
}

/**
 * `wait_event` (docs/24 §4): waits for an event of the log, with a deadline. Output
 * `{timed_out, event}`: `event` is `{id, type, payload, timestamp}` of the first event after the
 * start of the wait that matches (`eventMatches`), or `null` on a timeout.
 *
 * [proposta]
 * - the deadline (an absolute instant) and the position in the log are saved in the memo of the run
 *   when the wait starts, so a restart waits for what was left of the time and does not miss an
 *   event that arrived while the daemon was down;
 * - the log has no live subscription (`EventLog` has `readFrom` and `lastId` only), so the wait
 *   reads it every `workflows.runtime.wait_event.poll`;
 * - only the events of the scenario of the run, or with no scenario, count;
 * - there is no effect: waiting changes nothing outside the run, so nothing goes to the journal.
 */
export const waitEventStep: StepRunner = {
  type: 'wait_event',
  async run(ctx: StepContext): Promise<StepResult> {
    const { store, clock, settings } = ctx.deps;
    const type = String(ctx.params.event);
    const filter = ctx.params.filter as Record<string, unknown> | undefined;
    let wait = savedWait(ctx);
    if (wait === undefined) {
      wait = {
        deadline: clock.now() + durationMs(String(ctx.params.timeout)),
        cursor: await store.events.lastId(),
      };
      await ctx.memo.set('wait', { deadline: wait.deadline, cursor: wait.cursor });
    }
    let cursor = wait.cursor;
    for (;;) {
      for (;;) {
        const batch = await store.events.readFrom(cursor, READ_BATCH);
        for (const event of batch) {
          cursor = event.id;
          if (event.scenarioId !== undefined && event.scenarioId !== ctx.scenarioId) continue;
          if (!eventMatches(event, type, filter)) continue;
          return {
            kind: 'done',
            output: {
              timed_out: false,
              event: {
                id: event.id,
                type: event.type,
                payload: event.payload,
                timestamp: event.timestamp,
              },
            },
          };
        }
        if (batch.length < READ_BATCH) break;
      }
      const left = wait.deadline - clock.now();
      if (left <= 0) return { kind: 'done', output: { timed_out: true, event: null } };
      if (!(await sleepOrAbort(clock, Math.min(settings.waitEventPollMs, left), ctx.signal))) {
        return { kind: 'cancelled', reason: 'aborted' };
      }
    }
  },
};
