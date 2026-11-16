// SPDX-License-Identifier: MPL-2.0
import { EVENT_LOG_PORT_VERSION, type Clock, type EventLog, type NewEvent } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { useHarness, type AdapterFactory, type Disposable } from '../harness.js';
import { rejectionOf } from './helpers.js';

export interface EventLogHarness extends Disposable {
  readonly events: EventLog;
  /** The clock the adapter stamps events with (or one reading the same time source). */
  readonly clock: Pick<Clock, 'now'>;
}

/** A valid event; `n` makes the payload distinguishable. */
export function sampleEvent(n = 0, overrides: Partial<NewEvent> = {}): NewEvent {
  return { type: 'test.happened', schemaVersion: 1, payload: { n }, ...overrides };
}

/**
 * Registers the `EventLog` conformance tests (port version {@link EVENT_LOG_PORT_VERSION}).
 * The store adapters (`Store.events`) run it too, through `describeStoreConformance`.
 */
export function describeEventLogConformance(
  name: string,
  factory: AdapterFactory<EventLogHarness>,
): void {
  describe(`EventLog conformance: ${name} (port ${EVENT_LOG_PORT_VERSION})`, () => {
    const harness = useHarness(factory);

    it('starts empty', async () => {
      const { events } = harness();
      expect(await events.lastId()).toBe(0);
      expect(await events.readFrom(0, 10)).toEqual([]);
    });

    it('append returns the stored envelope', async () => {
      const { events, clock } = harness();
      const before = clock.now();
      const stored = await events.append(
        sampleEvent(7, { scenarioId: 'S1', playId: 'P1', attemptId: 'A1' }),
      );
      const after = clock.now();

      expect(stored).toMatchObject({
        type: 'test.happened',
        schemaVersion: 1,
        payload: { n: 7 },
        scenarioId: 'S1',
        playId: 'P1',
        attemptId: 'A1',
      });
      expect(Number.isSafeInteger(stored.id)).toBe(true);
      expect(stored.id).toBeGreaterThanOrEqual(1);
      expect(stored.timestamp).toBeGreaterThanOrEqual(before);
      expect(stored.timestamp).toBeLessThanOrEqual(after);
      expect(await events.readFrom(0, 10)).toEqual([stored]);
    });

    it('omits the optional correlation ids that were not given', async () => {
      const { events } = harness();
      const stored = await events.append(sampleEvent());
      expect(stored.scenarioId).toBeUndefined();
      expect(await events.readFrom(0, 1)).toEqual([stored]);
    });

    it('assigns strictly increasing ids, and lastId follows', async () => {
      const { events } = harness();
      const ids: number[] = [];
      for (let n = 0; n < 5; n++) {
        ids.push((await events.append(sampleEvent(n))).id);
        expect(await events.lastId()).toBe(ids[n]);
      }
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1] ?? Number.POSITIVE_INFINITY);
      }
    });

    it('readFrom(afterId) is exclusive, ascending and honours limit', async () => {
      const { events } = harness();
      const stored = [];
      for (let n = 0; n < 6; n++) stored.push(await events.append(sampleEvent(n)));
      const ids = stored.map((e) => e.id);

      expect((await events.readFrom(0, 100)).map((e) => e.id)).toEqual(ids);
      expect((await events.readFrom(0, 2)).map((e) => e.id)).toEqual(ids.slice(0, 2));
      expect((await events.readFrom(ids[2] ?? 0, 100)).map((e) => e.id)).toEqual(ids.slice(3));
      expect(await events.readFrom(ids[5] ?? 0, 100)).toEqual([]);
      expect(await events.readFrom((ids[5] ?? 0) + 1000, 100)).toEqual([]);
    });

    it('paging with the last id as cursor visits every event exactly once, in order', async () => {
      const { events } = harness();
      for (let n = 0; n < 7; n++) await events.append(sampleEvent(n));

      const seen: number[] = [];
      let cursor = 0;
      for (;;) {
        const page = await events.readFrom(cursor, 3);
        if (page.length === 0) break;
        expect(page.length).toBeLessThanOrEqual(3);
        for (const e of page) seen.push(e.payload.n as number);
        cursor = page[page.length - 1]?.id ?? cursor;
      }
      expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('stores nested JSON payloads faithfully', async () => {
      const { events } = harness();
      const payload = {
        text: 'olá, mundo\n"quoted"',
        list: [1, 2.5, null, true, { deep: ['x'] }],
        empty: {},
      };
      const stored = await events.append(sampleEvent(0, { payload }));
      expect(stored.payload).toEqual(payload);
      expect((await events.readFrom(0, 1))[0]?.payload).toEqual(payload);
    });

    it('rejects invalid events with INVALID_INPUT and stores nothing', async () => {
      const { events } = harness();
      const invalid: unknown[] = [
        { ...sampleEvent(), type: 'Bad Type' },
        { ...sampleEvent(), type: 'single' },
        { ...sampleEvent(), schemaVersion: 0 },
        { ...sampleEvent(), schemaVersion: 1.5 },
        { ...sampleEvent(), payload: 'not an object' },
        { ...sampleEvent(), payload: { fn: () => 1 } },
        { ...sampleEvent(), payload: { n: Number.NaN } },
        { ...sampleEvent(), id: 99 },
        { type: 'test.happened', schemaVersion: 1 },
        null,
      ];
      for (const event of invalid) {
        expect(await rejectionOf(events.append(event as NewEvent))).toMatchObject({
          code: 'INVALID_INPUT',
        });
      }
      expect(await events.lastId()).toBe(0);
      expect(await events.readFrom(0, 10)).toEqual([]);
    });

    it('rejects invalid readFrom arguments with INVALID_INPUT', async () => {
      const { events } = harness();
      const invalid: [number, number][] = [
        [-1, 10],
        [1.5, 10],
        [Number.NaN, 10],
        [0, 0],
        [0, -3],
        [0, 2.5],
        [0, Number.POSITIVE_INFINITY],
      ];
      for (const [afterId, limit] of invalid) {
        expect(await rejectionOf(events.readFrom(afterId, limit))).toMatchObject({
          code: 'INVALID_INPUT',
        });
      }
    });

    it('returns copies: changing a result or the input does not change the log', async () => {
      const { events } = harness();
      const input = sampleEvent(1, { payload: { list: [1] } });
      const stored = await events.append(input);

      (input.payload.list as number[]).push(2);
      (stored.payload.list as number[]).push(3);
      const [read] = await events.readFrom(0, 1);
      (read?.payload.list as number[]).push(4);

      expect((await events.readFrom(0, 1))[0]?.payload).toEqual({ list: [1] });
    });

    it('concurrent appends get distinct, strictly increasing ids matching read order', async () => {
      const { events } = harness();
      const stored = await Promise.all(
        Array.from({ length: 25 }, (_, n) => events.append(sampleEvent(n))),
      );
      const read = await events.readFrom(0, 100);

      expect(read).toHaveLength(25);
      expect(new Set(stored.map((e) => e.id)).size).toBe(25);
      for (let i = 1; i < read.length; i++) {
        expect(read[i]?.id).toBeGreaterThan(read[i - 1]?.id ?? Number.POSITIVE_INFINITY);
      }
      expect([...read].sort((a, b) => a.id - b.id)).toEqual(read);
      expect(new Set(read.map((e) => e.payload.n))).toEqual(
        new Set(Array.from({ length: 25 }, (_, n) => n)),
      );
    });
  });
}
