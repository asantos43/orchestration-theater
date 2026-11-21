// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, JsonValue } from '@otheater/core';
import { EventMetrics, executorLabel } from './metrics-events.js';

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
      filter: { typePrefixes: ['attempt.', 'session.', 'executor.selected'] },
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
