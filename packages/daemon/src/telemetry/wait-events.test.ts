// SPDX-License-Identifier: MPL-2.0
import { FakeClock } from '@otheater/core/testing';
import {
  WAIT_EVENT_REASONS,
  WaitEndedPayloadSchema,
  WaitStartedPayloadSchema,
} from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { POOL_WAIT_REASON } from '../execution/pool.js';
import { PROMPT_WAIT_REASON } from '../prompt-dispatcher.js';
import { WaitEvents, type WaitBegin } from './wait-events.js';
import { RecordingSituations } from './wait-events-fixture.js';

function setup(thresholdMs: number) {
  const clock = new FakeClock(10_000);
  const situations = new RecordingSituations();
  const waits = new WaitEvents({ situations, clock, thresholdMs });
  const begin = (extra: Partial<WaitBegin> = {}): WaitBegin => ({
    kind: 'pool_admission',
    id: 'w1',
    since: clock.now(),
    reason: 'max_sessions',
    correlation: { playId: 'p1', attemptId: 'a1', client: 'fake' },
    ...extra,
  });
  return { clock, situations, waits, begin };
}

describe('WaitEvents (P15, N222 (a))', () => {
  it('tells nothing for a wait that ends under the threshold', async () => {
    const { clock, situations, waits, begin } = setup(1_000);
    const wait = waits.begin(begin());
    await clock.advance(999);
    wait.end('admitted');
    await clock.advance(5_000);
    expect(situations.told).toEqual([]);
    expect(clock.pendingSleeps).toBe(0);
  });

  it('tells wait.started when the wait reaches the threshold, while it goes on, and wait.ended at the end', async () => {
    const { clock, situations, waits, begin } = setup(1_000);
    const wait = waits.begin(
      begin({ correlation: { playId: 'p1', attemptId: 'a1', role: 'actor', client: 'fake' } }),
    );
    await clock.advance(1_000);
    expect(situations.types).toEqual(['wait.started']);
    wait.hold('quota');
    await clock.advance(500);
    wait.end('admitted');
    expect(situations.types).toEqual(['wait.started', 'wait.ended']);
    const [started, ended] = situations.told;
    expect(WaitStartedPayloadSchema.parse(started?.payload)).toMatchObject({
      waitId: 'w1',
      kind: 'pool_admission',
      reasons: ['max_sessions'],
      since: 10_000,
      thresholdMs: 1_000,
      role: 'actor',
    });
    expect(WaitEndedPayloadSchema.parse(ended?.payload)).toMatchObject({
      reasons: ['max_sessions', 'quota'],
      outcome: 'admitted',
      waitedMs: 1_500,
    });
    expect(started?.correlation).toEqual({ scenarioId: undefined, playId: 'p1', attemptId: 'a1' });
  });

  it('tells a wait at its end when it reached the threshold and the timer has not fired yet', () => {
    let now = 10_000;
    // A clock whose sleeps never fire: the end is the only way to the event.
    const clock = { now: () => now, sleep: () => new Promise<void>(() => undefined) };
    const situations = new RecordingSituations();
    const waits = new WaitEvents({ situations, clock, thresholdMs: 1_000 });
    const wait = waits.begin({ kind: 'pool_admission', id: 'w1', since: now, reason: 'ram' });
    now += 1_200;
    wait.end('admitted');
    expect(situations.types).toEqual(['wait.started', 'wait.ended']);
    expect(situations.told[1]?.payload).toMatchObject({ waitedMs: 1_200 });
  });

  it('tells at once a wait that was older than the threshold when it was first seen (a restart)', () => {
    const { clock, situations, waits, begin } = setup(1_000);
    const wait = waits.begin(
      begin({
        kind: 'prompt_queue',
        id: 'q1',
        since: clock.now() - 60_000,
        reason: 'restart',
        correlation: { scenarioId: 's1' },
        prompt: { source: 'producer', priority: 5 },
      }),
    );
    expect(situations.types).toEqual(['wait.started']);
    expect(situations.told[0]?.payload).toMatchObject({
      since: 10_000 - 60_000,
      promptSource: 'producer',
      promptPriority: 5,
    });
    wait.end('delivered');
    expect(situations.told[1]?.payload).toMatchObject({ outcome: 'delivered', waitedMs: 60_000 });
  });

  it('with a threshold of 0 tells every wait that began, even one that ends at once', () => {
    const { situations, waits, begin } = setup(0);
    waits.begin(begin()).end('cancelled');
    expect(situations.types).toEqual(['wait.started', 'wait.ended']);
  });

  it('ends once, ignores a reason held after the end and never starts after it', async () => {
    const { clock, situations, waits, begin } = setup(100);
    const wait = waits.begin(begin());
    await clock.advance(100);
    wait.end('admitted');
    wait.end('cancelled');
    wait.hold('ram');
    await clock.advance(1_000);
    expect(situations.types).toEqual(['wait.started', 'wait.ended']);
    expect(situations.told[1]?.payload).toMatchObject({ outcome: 'admitted' });
  });

  it('writes nothing after close() and leaves no timer behind', async () => {
    const { clock, situations, waits, begin } = setup(1_000);
    const open = waits.begin(begin());
    expect(clock.pendingSleeps).toBe(1);
    waits.close();
    expect(clock.pendingSleeps).toBe(0);
    await clock.advance(5_000);
    open.end('pool_closed');
    waits.begin(begin({ id: 'w2' })).end('admitted');
    expect(situations.told).toEqual([]);
  });

  it('is never broken by a sink that throws', async () => {
    const clock = new FakeClock(10_000);
    const waits = new WaitEvents({
      clock,
      thresholdMs: 10,
      situations: {
        record: () => {
          throw new Error('sink is broken');
        },
      },
    });
    const wait = waits.begin({
      kind: 'prompt_queue',
      id: 'q',
      since: clock.now(),
      reason: 'queued',
    });
    await clock.advance(50);
    expect(() => {
      wait.end('delivered');
    }).not.toThrow();
  });
});

describe('the reasons of the places that wait (P15)', () => {
  it('are all reasons the events accept', () => {
    const accepted: readonly string[] = WAIT_EVENT_REASONS;
    for (const reason of [
      ...Object.values(POOL_WAIT_REASON),
      ...Object.values(PROMPT_WAIT_REASON),
    ]) {
      expect(accepted).toContain(reason);
    }
  });
});
