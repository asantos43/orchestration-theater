// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { hasErrorCode } from '../errors.js';
import {
  EVENT_TYPE_PATTERN,
  EventEnvelopeSchema,
  assertReadFromArgs,
  parseNewEvent,
} from './event-log.js';

const valid = { type: 'play.created', schemaVersion: 1, payload: { need: 'x' } };

describe('event type pattern', () => {
  it('accepts dotted lowercase English names', () => {
    for (const type of ['play.created', 'session.update', 'plugin.my-tool.finished', 'a.b_c.d9']) {
      expect(EVENT_TYPE_PATTERN.test(type), type).toBe(true);
    }
  });

  it('rejects single words, uppercase, spaces, empty segments and leading digits', () => {
    for (const type of [
      'play',
      'Play.created',
      'play created',
      'play..x',
      '.play.x',
      'play.',
      '1a.b',
      '',
    ]) {
      expect(EVENT_TYPE_PATTERN.test(type), type).toBe(false);
    }
  });
});

describe('parseNewEvent', () => {
  it('returns a valid event, with optional correlation ids', () => {
    expect(parseNewEvent(valid)).toEqual(valid);
    const withIds = { ...valid, scenarioId: 's', playId: 'p', attemptId: 'a' };
    expect(parseNewEvent(withIds)).toEqual(withIds);
  });

  it('throws INVALID_INPUT with the ZodError as cause', () => {
    try {
      parseNewEvent({ ...valid, schemaVersion: 0 });
      expect.unreachable();
    } catch (error) {
      expect(hasErrorCode(error, 'INVALID_INPUT')).toBe(true);
      expect((error as Error).cause).toBeDefined();
    }
  });

  it('rejects unknown keys (typos) and the fields only the log may set', () => {
    for (const extra of [{ typo: 1 }, { id: 3 }, { timestamp: 1 }]) {
      expect(() => parseNewEvent({ ...valid, ...extra })).toThrow(/Invalid event/);
    }
  });

  it('rejects payloads that are not JSON objects', () => {
    for (const payload of [
      'x',
      1,
      null,
      [1],
      { a: undefined },
      { a: () => 1 },
      { a: Number.NaN },
      { a: 1n },
    ]) {
      expect(() => parseNewEvent({ ...valid, payload })).toThrow();
    }
  });
});

describe('EventEnvelopeSchema', () => {
  it('needs id >= 1 and timestamp >= 0, both integers', () => {
    const base = { ...valid, id: 1, timestamp: 0 };
    expect(EventEnvelopeSchema.safeParse(base).success).toBe(true);
    for (const patch of [{ id: 0 }, { id: 1.5 }, { timestamp: -1 }, { timestamp: 1.5 }]) {
      expect(EventEnvelopeSchema.safeParse({ ...base, ...patch }).success).toBe(false);
    }
  });
});

describe('assertReadFromArgs', () => {
  it('accepts afterId >= 0 and limit >= 1', () => {
    expect(() => {
      assertReadFromArgs(0, 1);
    }).not.toThrow();
    expect(() => {
      assertReadFromArgs(10, 500);
    }).not.toThrow();
  });

  it('rejects the rest with INVALID_INPUT', () => {
    for (const [afterId, limit] of [
      [-1, 1],
      [0, 0],
      [0.5, 1],
      [0, 1.5],
      [Number.NaN, 1],
      [0, Infinity],
    ] as const) {
      try {
        assertReadFromArgs(afterId, limit);
        expect.unreachable();
      } catch (error) {
        expect(hasErrorCode(error, 'INVALID_INPUT')).toBe(true);
      }
    }
  });
});
