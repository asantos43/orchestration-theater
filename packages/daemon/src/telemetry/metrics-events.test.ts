// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, JsonValue } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { WAIT_EVENT_KINDS } from '@otheater/protocol';
import { EventMetrics, executorLabel } from './metrics-events.js';
import { WaitEvents } from './wait-events.js';
import { RecordingSituations } from './wait-events-fixture.js';

const EXECUTOR = { client: 'fake', profile: 'one', model: 'fake-model' };
const OTHER = { client: 'fake', profile: 'two', model: 'fake-model', effort: 'high' };
const PLAY = { playId: 'p1', scenarioId: 's1' };

let seq = 0;
function event(
  type: string,
  payload: Record<string, JsonValue>,
  ids: { playId?: string; attemptId?: string; scenarioId?: string } = {},
): EventEnvelope {
  seq += 1;
  return { id: seq, timestamp: 1_800_000_000_000 + seq, type, payload, ...ids } as EventEnvelope;
}

function attempt(n: number): { playId: string; scenarioId: string; attemptId: string } {
  return { ...PLAY, attemptId: `p1/alpha/${String(n)}` };
}

const value = (counts: readonly { labels: Record<string, string>; value: number }[]) =>
  counts.map((count) => [count.labels, count.value]);

describe('executorLabel', () => {
  it('is the executor id, with the effort when there is one', () => {
    expect(executorLabel(EXECUTOR)).toBe('fake-model@fake/one');
    expect(executorLabel(OTHER)).toBe('fake-model-high@fake/two');
  });

  it('is unknown for anything else', () => {
    expect(executorLabel(undefined)).toBe('unknown');
    expect(executorLabel({ client: 'x' })).toBe('unknown');
    expect(executorLabel('text')).toBe('unknown');
  });
});

describe('EventMetrics', () => {
  it('counts an attempt by the Executor of its session and the role of its selection', () => {
    const metrics = new EventMetrics();
    metrics.observe(
      event('executor.selected', { outcome: 'selected', role: 'actor', executor: EXECUTOR }, PLAY),
    );
    metrics.observe(event('session.opened', { sessionId: 's-1', executor: EXECUTOR }, attempt(1)));
    metrics.observe(event('attempt.submitted', {}, attempt(1)));
    expect(value(metrics.attempts())).toEqual([
      [{ executor: 'fake-model@fake/one', role: 'actor', outcome: 'submitted' }, 1],
    ]);
  });

  it('tells the roles apart when two Executors are selected in one play', () => {
    const metrics = new EventMetrics();
    metrics.observe(
      event('executor.selected', { outcome: 'selected', role: 'actor', executor: EXECUTOR }, PLAY),
    );
    metrics.observe(
      event('executor.selected', { outcome: 'selected', role: 'critic', executor: OTHER }, PLAY),
    );
    metrics.observe(event('session.opened', { sessionId: 's-2', executor: OTHER }, attempt(2)));
    metrics.observe(event('session.opened', { sessionId: 's-1', executor: EXECUTOR }, attempt(1)));
    metrics.observe(event('attempt.cancelled', {}, attempt(2)));
    metrics.observe(event('attempt.aborted', {}, attempt(1)));
    expect(value(metrics.attempts())).toEqual([
      [{ executor: 'fake-model-high@fake/two', role: 'critic', outcome: 'cancelled' }, 1],
      [{ executor: 'fake-model@fake/one', role: 'actor', outcome: 'aborted' }, 1],
    ]);
  });

  it('does not use a selection that was not chosen', () => {
    const metrics = new EventMetrics();
    metrics.observe(
      event('executor.selected', { outcome: 'waiting', role: 'actor', executor: EXECUTOR }, PLAY),
    );
    metrics.observe(event('session.opened', { sessionId: 's-1', executor: EXECUTOR }, attempt(1)));
    metrics.observe(event('attempt.submitted', {}, attempt(1)));
    expect(metrics.attempts()[0]?.labels.role).toBe('unknown');
  });

  it('says unknown for an attempt whose session it did not see', () => {
    const metrics = new EventMetrics();
    metrics.observe(event('attempt.submitted', {}, attempt(7)));
    expect(value(metrics.attempts())).toEqual([
      [{ executor: 'unknown', role: 'unknown', outcome: 'submitted' }, 1],
    ]);
  });

  it('counts one attempt once and forgets it', () => {
    const metrics = new EventMetrics();
    metrics.observe(event('session.opened', { sessionId: 's-1', executor: EXECUTOR }, attempt(1)));
    metrics.observe(event('attempt.submitted', {}, attempt(1)));
    metrics.observe(event('attempt.submitted', {}, attempt(1)));
    expect(value(metrics.attempts())).toEqual([
      [{ executor: 'fake-model@fake/one', role: 'unknown', outcome: 'submitted' }, 1],
      ...[[{ executor: 'unknown', role: 'unknown', outcome: 'submitted' }, 1]],
    ]);
  });

  it('counts a resume by the Executor it went to and the cause', () => {
    const metrics = new EventMetrics();
    metrics.observe(
      event(
        'session.resumed',
        { sessionId: 's-1', from: EXECUTOR, to: OTHER, cause: 'quota', form: 'handoff' },
        attempt(1),
      ),
    );
    metrics.observe(
      event(
        'session.resumed',
        { sessionId: 's-1', from: OTHER, to: OTHER, form: 'native' },
        attempt(1),
      ),
    );
    expect(value(metrics.resumes())).toEqual([
      [{ executor: 'fake-model-high@fake/two', reason: 'quota' }, 1],
      [{ executor: 'fake-model-high@fake/two', reason: 'unknown' }, 1],
    ]);
  });

  it('counts an interruption as a failure, by the Executor that was running', () => {
    const metrics = new EventMetrics();
    metrics.observe(event('session.opened', { sessionId: 's-1', executor: EXECUTOR }, attempt(1)));
    metrics.observe(event('session.interrupted', { sessionId: 's-1', cause: 'crash' }, attempt(1)));
    metrics.observe(
      event('session.interrupted', { sessionId: 's-9', cause: 'quota', from: OTHER }, attempt(2)),
    );
    expect(value(metrics.failures())).toEqual([
      [{ executor: 'fake-model@fake/one', kind: 'crash' }, 1],
      [{ executor: 'fake-model-high@fake/two', kind: 'quota' }, 1],
    ]);
  });

  it('does not count a pause or a removed profile as a failure', () => {
    const metrics = new EventMetrics();
    metrics.observe(
      event('session.interrupted', { sessionId: 's-1', cause: 'paused' }, attempt(1)),
    );
    metrics.observe(
      event('session.interrupted', { sessionId: 's-1', cause: 'profile_removed' }, attempt(1)),
    );
    expect(metrics.failures()).toEqual([]);
  });

  it('never throws for a payload it does not understand', () => {
    const metrics = new EventMetrics();
    expect(() => {
      metrics.observe(event('session.opened', {}, {}));
      metrics.observe(event('session.interrupted', { cause: 5 }, {}));
      metrics.observe(event('executor.selected', { outcome: 'selected' }, PLAY));
      metrics.observe(event('attempt.submitted', {}, {}));
    }).not.toThrow();
    expect(metrics.attempts()).toEqual([]);
  });

  it('follows a hub from now, until it is stopped', async () => {
    const metrics = new EventMetrics();
    const queue: EventEnvelope[] = [];
    let wake: (() => void) | undefined;
    let seenOptions: unknown;
    const hub = {
      async *follow(options: { signal?: AbortSignal }): AsyncGenerator<EventEnvelope> {
        seenOptions = options;
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (options.signal?.aborted === true) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
            options.signal?.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
        }
      },
    };
    metrics.start(hub, { warn: () => undefined });
    queue.push(event('attempt.submitted', {}, attempt(3)));
    wake?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(metrics.attempts()).toHaveLength(1);
    expect(seenOptions).toMatchObject({
      filter: { typePrefixes: ['attempt.', 'session.', 'executor.selected', 'wait.'] },
    });
    expect((seenOptions as { afterId?: number }).afterId).toBeUndefined();
    await metrics.stop();
  });

  it('warns, and does not throw, when the follow breaks', async () => {
    const warnings: unknown[] = [];
    const metrics = new EventMetrics();
    metrics.start(
      {
        // eslint-disable-next-line require-yield, @typescript-eslint/require-await
        async *follow(): AsyncGenerator<EventEnvelope> {
          throw new Error('hub gone');
        },
      },
      { warn: (...args: unknown[]) => warnings.push(args) },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await metrics.stop();
    expect(warnings).toHaveLength(1);
  });
});

describe('EventMetrics: the waits (Phase 9, P2; N225 (2))', () => {
  function waitEvent(
    type: 'wait.started' | 'wait.ended',
    waitId: string,
    kind: string,
    extra: Record<string, JsonValue> = {},
  ): EventEnvelope {
    return event(type, { waitId, kind, reasons: ['queued'], since: 0, ...extra });
  }
  const active = (metrics: EventMetrics): Record<string, number> =>
    Object.fromEntries(
      metrics
        .waitsActive()
        .map((count): [string, number] => [count.labels.kind ?? '', count.value]),
    );

  it('has a count of zero for every kind before any wait', () => {
    const metrics = new EventMetrics();
    expect(active(metrics)).toEqual(Object.fromEntries(WAIT_EVENT_KINDS.map((kind) => [kind, 0])));
    expect(metrics.waits()).toEqual([]);
    expect(metrics.waitSeconds()).toEqual([]);
  });

  it('raises the gauge at wait.started and lowers it at wait.ended, by kind', () => {
    const metrics = new EventMetrics();
    metrics.observe(waitEvent('wait.started', 'w1', 'pool_admission', { thresholdMs: 1000 }));
    metrics.observe(waitEvent('wait.started', 'w2', 'pool_admission', { thresholdMs: 1000 }));
    metrics.observe(waitEvent('wait.started', 'w3', 'prompt_queue', { thresholdMs: 1000 }));
    expect(active(metrics)).toEqual({ pool_admission: 2, prompt_queue: 1 });
    metrics.observe(
      waitEvent('wait.ended', 'w1', 'pool_admission', { outcome: 'admitted', waitedMs: 1500 }),
    );
    expect(active(metrics)).toEqual({ pool_admission: 1, prompt_queue: 1 });
  });

  it('counts the waits that ended by kind and outcome, and sums their seconds by kind', () => {
    const metrics = new EventMetrics();
    for (const [id, kind, outcome, waitedMs] of [
      ['w1', 'pool_admission', 'admitted', 1500],
      ['w2', 'pool_admission', 'admitted', 2500],
      ['w3', 'pool_admission', 'cancelled', 1000],
      ['w4', 'prompt_queue', 'delivered', 4000],
    ] as const) {
      metrics.observe(waitEvent('wait.started', id, kind, { thresholdMs: 1000 }));
      metrics.observe(waitEvent('wait.ended', id, kind, { outcome, waitedMs }));
    }
    expect(value(metrics.waits())).toEqual([
      [{ kind: 'pool_admission', outcome: 'admitted' }, 2],
      [{ kind: 'pool_admission', outcome: 'cancelled' }, 1],
      [{ kind: 'prompt_queue', outcome: 'delivered' }, 1],
    ]);
    expect(value(metrics.waitSeconds())).toEqual([
      [{ kind: 'pool_admission' }, 5],
      [{ kind: 'prompt_queue' }, 4],
    ]);
    expect(Object.values(active(metrics))).toEqual([0, 0]);
  });

  it('counts a wait.ended it saw no wait.started for, and does not take it from the gauge', () => {
    const metrics = new EventMetrics();
    metrics.observe(waitEvent('wait.started', 'w1', 'prompt_queue', { thresholdMs: 1000 }));
    metrics.observe(
      waitEvent('wait.ended', 'unseen', 'prompt_queue', { outcome: 'delivered', waitedMs: 2000 }),
    );
    expect(active(metrics).prompt_queue).toBe(1);
    expect(value(metrics.waits())).toEqual([[{ kind: 'prompt_queue', outcome: 'delivered' }, 1]]);
    expect(value(metrics.waitSeconds())).toEqual([[{ kind: 'prompt_queue' }, 2]]);
  });

  it('does not count a wait twice that started twice', () => {
    const metrics = new EventMetrics();
    metrics.observe(waitEvent('wait.started', 'w1', 'prompt_queue', { thresholdMs: 0 }));
    metrics.observe(waitEvent('wait.started', 'w1', 'prompt_queue', { thresholdMs: 0 }));
    expect(active(metrics).prompt_queue).toBe(1);
  });

  it('ignores a wait of a kind it does not know and a payload it does not understand', () => {
    const metrics = new EventMetrics();
    metrics.observe(waitEvent('wait.started', 'w1', 'something_else', { thresholdMs: 0 }));
    metrics.observe(event('wait.started', { kind: 'prompt_queue' }));
    metrics.observe(waitEvent('wait.ended', 'w2', 'prompt_queue', { outcome: 'delivered' }));
    metrics.observe(
      waitEvent('wait.ended', 'w3', 'prompt_queue', { outcome: 'delivered', waitedMs: -5 }),
    );
    expect(Object.values(active(metrics))).toEqual([0, 0]);
    expect(metrics.waits()).toEqual([]);
    expect(metrics.waitSeconds()).toEqual([]);
  });

  it('follows the events WaitEvents writes on a fake clock: a wait under the threshold is in no series', async () => {
    const clock = new FakeClock(10_000);
    const situations = new RecordingSituations();
    const waits = new WaitEvents({ situations, clock, thresholdMs: 1_000 });
    const metrics = new EventMetrics();
    let sent = 0;
    const feed = () => {
      for (const told of situations.told.slice(sent)) {
        metrics.observe(event(told.type, told.payload as Record<string, JsonValue>));
      }
      sent = situations.told.length;
    };
    const begin = (id: string, kind: 'prompt_queue' | 'pool_admission') =>
      waits.begin({ kind, id, since: clock.now(), reason: 'queued' });

    const quick = begin('quick', 'pool_admission');
    await clock.advance(999);
    quick.end('admitted');
    const slow = begin('slow', 'pool_admission');
    const prompt = begin('prompt', 'prompt_queue');
    await clock.advance(1_000);
    feed();
    // `quick` told nothing; `slow` and `prompt` reached the threshold.
    expect(active(metrics)).toEqual({ pool_admission: 1, prompt_queue: 1 });
    await clock.advance(2_000);
    slow.end('admitted');
    feed();
    expect(active(metrics)).toEqual({ pool_admission: 0, prompt_queue: 1 });
    await clock.advance(1_000);
    prompt.end('delivered');
    feed();
    expect(active(metrics)).toEqual({ pool_admission: 0, prompt_queue: 0 });
    expect(value(metrics.waits())).toEqual([
      [{ kind: 'pool_admission', outcome: 'admitted' }, 1],
      [{ kind: 'prompt_queue', outcome: 'delivered' }, 1],
    ]);
    // `waitedMs` is the whole wait from its start, not only the part past the threshold.
    expect(value(metrics.waitSeconds())).toEqual([
      [{ kind: 'pool_admission' }, 3],
      [{ kind: 'prompt_queue' }, 4],
    ]);
  });

  it('follows the wait. events of the hub', async () => {
    const metrics = new EventMetrics();
    let filter: { typePrefixes?: readonly string[] } | undefined;
    metrics.start(
      {
        // eslint-disable-next-line @typescript-eslint/require-await
        async *follow(options?: { filter?: { typePrefixes?: readonly string[] } }) {
          filter = options?.filter;
          yield waitEvent('wait.started', 'w1', 'prompt_queue', { thresholdMs: 0 });
        },
      },
      { warn: () => undefined },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await metrics.stop();
    expect(filter?.typePrefixes).toContain('wait.');
    expect(active(metrics).prompt_queue).toBe(1);
  });
});
