// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DAEMON_EVENT_TYPES } from './events.js';
import { WaitEndedPayloadSchema, WaitStartedPayloadSchema } from './wait-events.js';

const base = {
  waitId: 'q1',
  kind: 'prompt_queue',
  reasons: ['director_busy'],
  since: 1_000,
};
const started = {
  ...base,
  scenarioId: 's1',
  promptSource: 'producer',
  promptPriority: 5,
  thresholdMs: 1_000,
};
const ended = { ...base, outcome: 'delivered', waitedMs: 2_500 };

describe('wait.started and wait.ended (P15, N222 (a))', () => {
  it('are registered events with a strict payload', () => {
    expect(DAEMON_EVENT_TYPES['wait.started'].payload).toBe(WaitStartedPayloadSchema);
    expect(DAEMON_EVENT_TYPES['wait.ended'].payload).toBe(WaitEndedPayloadSchema);
  });

  it('take the fields of a wait, with the ids optional', () => {
    expect(WaitStartedPayloadSchema.parse(started)).toEqual(started);
    expect(WaitStartedPayloadSchema.safeParse({ ...base, thresholdMs: 0 }).success).toBe(true);
    expect(WaitEndedPayloadSchema.parse(ended)).toEqual(ended);
  });

  it('refuse an unknown kind, reason or outcome, an empty list of reasons and a field of the other event', () => {
    expect(WaitStartedPayloadSchema.safeParse({ ...started, kind: 'tool_semaphore' }).success).toBe(
      false,
    );
    expect(WaitStartedPayloadSchema.safeParse({ ...started, reasons: ['moon'] }).success).toBe(
      false,
    );
    expect(WaitStartedPayloadSchema.safeParse({ ...started, reasons: [] }).success).toBe(false);
    expect(WaitStartedPayloadSchema.safeParse({ ...started, outcome: 'delivered' }).success).toBe(
      false,
    );
    expect(WaitEndedPayloadSchema.safeParse({ ...ended, outcome: 'finished' }).success).toBe(false);
    expect(WaitEndedPayloadSchema.safeParse({ ...ended, waitedMs: -1 }).success).toBe(false);
  });
});
