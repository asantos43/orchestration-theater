// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { RollupRow, TelemetrySpan, TelemetryStore } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import type { DaemonEventPayloads, DaemonEventType } from '@otheater/protocol';
import type { SituationSink } from '../situations.js';
import { TelemetryRetention, type RetentionReady } from './retention.js';
import type { TelemetryRetentionSettings } from './retention-config.js';
import { MemoryTelemetryStore } from './telemetry-fixture.js';

const MB = 1024 * 1024;
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;
const at = (month: number, day: number, hour = 12): number =>
  Date.UTC(2026, month - 1, day, hour, 0, 0);
/** 2026-12-20 12:00 UTC: 30 days back is 2026-11-20 12:00. */
const NOW = at(12, 20);
const LOGGER = { warn: () => undefined, info: () => undefined };

function settings(over: Partial<TelemetryRetentionSettings> = {}): TelemetryRetentionSettings {
  return { mode: 'daily', interval: DAY_MS, days: 30, max_mb: 1024, guard: 'rollups', ...over };
}

let counter = 0;
/** A span that ends at `endMs`. */
function span(endMs: number): TelemetrySpan {
  counter += 1;
  return {
    traceId: counter.toString(16).padStart(32, '0'),
    spanId: counter.toString(16).padStart(16, '0'),
    parentSpanId: null,
    name: 'otheater.stage',
    kind: 1,
    startTimeUnixNano: BigInt(endMs - 1000) * 1_000_000n,
    endTimeUnixNano: BigInt(endMs) * 1_000_000n,
    status: 'unset',
    statusMessage: null,
    attributes: {},
    resource: {},
    scenarioId: 's1',
    playId: null,
    attemptId: null,
    sessionId: null,
  };
}

const rollup = (day: string): RollupRow => ({
  day,
  scenarioId: 's1',
  executor: 'claude-code',
  role: 'actor',
  metric: 'stage.duration_ms',
  facet: '',
  origin: 'daemon',
  count: 1,
  sum: 10,
  max: 10,
  p50: 10,
  p95: 10,
});

interface Recorded {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

class Recorder implements SituationSink {
  readonly events: Recorded[] = [];
  record<T extends DaemonEventType>(type: T, payload: DaemonEventPayloads[T]): void {
    this.events.push({ type, payload });
  }
  notices(kind: string): Recorded[] {
    return this.events.filter((e) => e.type === 'daemon.notice' && e.payload.kind === kind);
  }
  of(type: string): Recorded[] {
    return this.events.filter((e) => e.type === type);
  }
}

interface Rig {
  readonly clock: FakeClock;
  readonly store: MemoryTelemetryStore;
  readonly recorder: Recorder;
  readonly retention: TelemetryRetention;
  readonly passes: () => number;
}

function rig(
  over: Partial<TelemetryRetentionSettings> = {},
  options: {
    readonly readyDay?: string | null;
    readonly bytesPerRecord?: number;
    readonly store?: TelemetryStore;
  } = {},
): Rig {
  const clock = new FakeClock(NOW);
  const memory = new MemoryTelemetryStore(
    options.bytesPerRecord === undefined ? {} : { bytesPerRecord: options.bytesPerRecord },
  );
  const recorder = new Recorder();
  let passes = 0;
  const readyDay = options.readyDay ?? null;
  const ready = (): Promise<RetentionReady | null> => {
    if (readyDay === null) return Promise.resolve(null);
    const [y, m, d] = readyDay.split('-').map(Number) as [number, number, number];
    return Promise.resolve({ day: readyDay, untilMs: Date.UTC(y, m - 1, d + 1) });
  };
  const retention = new TelemetryRetention({
    clock,
    telemetry: options.store ?? memory,
    settings: () => settings(over),
    ready,
    prepare: () => {
      passes += 1;
      return Promise.resolve();
    },
    situations: recorder,
    logger: LOGGER,
  });
  return { clock, store: memory, recorder, retention, passes: () => passes };
}

async function ends(store: TelemetryStore): Promise<number[]> {
  const spans = await store.readSpans({});
  return spans.map((s) => Number(s.endTimeUnixNano / 1_000_000n)).sort((a, b) => a - b);
}

describe('TelemetryRetention: by age', () => {
  it('removes what is past the deadline and keeps the rest and the aggregates', async () => {
    const r = rig({}, { readyDay: '2026-11-30' });
    r.store.write({
      spans: [span(at(11, 5)), span(at(11, 10)), span(at(11, 25)), span(at(12, 15))],
    });
    await r.store.replaceRollupDay('2026-11-05', [rollup('2026-11-05')]);
    await r.store.replaceRollupDay('2026-11-10', [rollup('2026-11-10')]);

    const result = await r.retention.runOnce();

    // The deadline is 2026-11-20 12:00: the two November spans before it go, the others stay.
    expect(result).toMatchObject({ rows: 2, spans: 2, metrics: 0, logs: 0, blocked: false });
    expect(await ends(r.store)).toEqual([at(11, 25), at(12, 15)]);
    expect((await r.store.readRollups({})).map((row) => row.day)).toEqual([
      '2026-11-05',
      '2026-11-10',
    ]);
    expect(r.recorder.of('telemetry.purged')).toEqual([
      {
        type: 'telemetry.purged',
        payload: {
          reason: 'age',
          rows: 2,
          spans: 2,
          metrics: 0,
          logs: 0,
          bytes: 2048,
          fileBytes: 4096,
          compacted: false,
          fromMs: at(11, 5),
          untilMs: at(11, 20),
          readyThrough: '2026-11-30',
        },
      },
    ]);
    // Within the cap, so the file is not rewritten.
    expect(r.store.compactions).toBe(0);
  });

  it('removes nothing at or after the end of the last ready day', async () => {
    const r = rig({}, { readyDay: '2026-11-10' });
    r.store.write({ spans: [span(at(11, 5)), span(at(11, 10, 23)), span(at(11, 15))] });

    const result = await r.retention.runOnce();

    // 2026-11-15 is past the 30 days but its day is not in the aggregates yet.
    expect(result).toMatchObject({ rows: 2, blocked: true });
    expect(await ends(r.store)).toEqual([at(11, 15)]);
    const [notice] = r.recorder.notices('telemetry_purge_blocked');
    expect(notice?.payload).toMatchObject({ subject: 'age' });
    expect(String(notice?.payload.detail)).toContain('2026-11-10');
    expect(r.recorder.of('telemetry.purged')[0]?.payload).toMatchObject({
      untilMs: at(11, 11, 0),
      readyThrough: '2026-11-10',
    });
  });

  it('does nothing when no record is past the deadline, and says nothing', async () => {
    const r = rig({}, { readyDay: '2026-12-19' });
    r.store.write({ spans: [span(at(12, 1))] });
    expect(await r.retention.runOnce()).toMatchObject({ rows: 0, blocked: false });
    expect(r.recorder.events).toEqual([]);
  });

  it('days: 0 keeps the records whatever their age', async () => {
    const r = rig({ days: 0 }, { readyDay: '2026-12-19' });
    r.store.write({ spans: [span(at(1, 1))] });
    expect(await r.retention.runOnce()).toMatchObject({ rows: 0 });
    expect(await ends(r.store)).toEqual([at(1, 1)]);
  });

  it('with days and max_mb both 0 a pass does nothing, not even a read', async () => {
    const r = rig({ days: 0, max_mb: 0 }, { readyDay: '2026-12-19' });
    expect(await r.retention.runOnce()).toBeNull();
    expect(r.passes()).toBe(0);
  });
});

describe('TelemetryRetention: by size', () => {
  it('removes the oldest first until the data fits the cap, then gives the disk back', async () => {
    const r = rig({ days: 0, max_mb: 3 }, { readyDay: '2026-12-19', bytesPerRecord: MB });
    r.store.write({
      spans: [
        span(at(12, 10)),
        span(at(12, 11)),
        span(at(12, 12)),
        span(at(12, 13)),
        span(at(12, 14)),
      ],
    });

    const result = await r.retention.runOnce();

    expect(await ends(r.store)).toEqual([at(12, 12), at(12, 13), at(12, 14)]);
    expect(result).toMatchObject({ rows: 2, bytes: 2 * MB, compacted: true, blocked: false });
    expect(r.store.compactions).toBe(1);
    expect(r.recorder.of('telemetry.purged')[0]?.payload).toMatchObject({
      reason: 'size',
      rows: 2,
      bytes: 2 * MB,
      fileBytes: 3 * MB,
      compacted: true,
      fromMs: at(12, 10),
    });
  });

  it('takes the oldest hour at a time, so it does not remove more than it needs', async () => {
    const r = rig({ days: 0, max_mb: 3 }, { readyDay: '2026-12-19', bytesPerRecord: MB });
    const first = at(12, 10);
    r.store.write({
      spans: [first, first + 3 * HOUR, first + 6 * HOUR, first + 9 * HOUR].map(span),
    });
    await r.retention.runOnce();
    // A slice of a whole day would have taken the four of them.
    expect(await ends(r.store)).toEqual([first + 3 * HOUR, first + 6 * HOUR, first + 9 * HOUR]);
  });

  it('with age and size together the reason says both', async () => {
    const r = rig({ max_mb: 2 }, { readyDay: '2026-12-19', bytesPerRecord: MB });
    r.store.write({
      spans: [span(at(11, 1)), span(at(12, 10)), span(at(12, 11)), span(at(12, 12))],
    });
    await r.retention.runOnce();
    expect(await ends(r.store)).toEqual([at(12, 11), at(12, 12)]);
    expect(r.recorder.of('telemetry.purged')[0]?.payload).toMatchObject({
      reason: 'age_and_size',
      rows: 2,
    });
  });

  it('max_mb: 0 sets no cap and the file is never rewritten', async () => {
    const r = rig({ max_mb: 0 }, { readyDay: '2026-12-19', bytesPerRecord: 100 * MB });
    r.store.write({ spans: [span(at(12, 10)), span(at(12, 11))] });
    expect(await r.retention.runOnce()).toMatchObject({ rows: 0, compacted: false });
    expect(r.store.compactions).toBe(0);
  });

  it('stops at the last ready day and tells that the cap could not be met', async () => {
    const r = rig({ days: 0, max_mb: 1 }, { readyDay: '2026-12-11', bytesPerRecord: MB });
    r.store.write({ spans: [span(at(12, 10)), span(at(12, 11)), span(at(12, 12))] });

    const result = await r.retention.runOnce();

    expect(await ends(r.store)).toEqual([at(12, 12)]);
    // The two days the aggregates cover went; the third is over nothing (1 MB fits the 1 MB cap).
    expect(result).toMatchObject({ rows: 2, blocked: false });

    const blocked = rig({ days: 0, max_mb: 1 }, { readyDay: '2026-12-10', bytesPerRecord: MB });
    blocked.store.write({ spans: [span(at(12, 10)), span(at(12, 11)), span(at(12, 12))] });
    expect(await blocked.retention.runOnce()).toMatchObject({ rows: 1, blocked: true });
    expect(await ends(blocked.store)).toEqual([at(12, 11), at(12, 12)]);
    expect(blocked.recorder.notices('telemetry_purge_blocked')[0]?.payload).toMatchObject({
      subject: 'size',
    });
    // What was removed gives the disk back even though the data is still over the cap.
    expect(blocked.store.compactions).toBe(1);
  });
});

describe('TelemetryRetention: the guard', () => {
  it('rollups with no ready day removes nothing and tells why', async () => {
    const r = rig({ days: 30, max_mb: 1 }, { readyDay: null, bytesPerRecord: MB });
    r.store.write({ spans: [span(at(10, 1)), span(at(10, 2))] });

    const result = await r.retention.runOnce();

    expect(result).toMatchObject({ rows: 0, blocked: true });
    expect(await ends(r.store)).toHaveLength(2);
    expect(r.recorder.of('telemetry.purged')).toEqual([]);
    const [notice] = r.recorder.notices('telemetry_purge_blocked');
    expect(notice?.payload).toMatchObject({ subject: 'size' });
    expect(String(notice?.payload.detail)).toContain('no day yet');
  });

  it('none enforces the limits whatever the analysis has', async () => {
    const r = rig({ guard: 'none' }, { readyDay: null });
    r.store.write({ spans: [span(at(10, 1)), span(at(12, 15))] });
    expect(await r.retention.runOnce()).toMatchObject({ rows: 1, blocked: false });
    expect(await ends(r.store)).toEqual([at(12, 15)]);
    expect(r.recorder.of('telemetry.purged')[0]?.payload).toMatchObject({ readyThrough: null });
  });

  it('prepare runs before the pass, and a prepare that fails does not stop it', async () => {
    const clock = new FakeClock(NOW);
    const store = new MemoryTelemetryStore();
    store.write({ spans: [span(at(10, 1))] });
    const order: string[] = [];
    const retention = new TelemetryRetention({
      clock,
      telemetry: store,
      settings: () => settings({ guard: 'none' }),
      ready: () => Promise.resolve(null),
      prepare: () => {
        order.push('prepare');
        return Promise.reject(new Error('catch-up failed'));
      },
      logger: LOGGER,
    });
    expect(await retention.runOnce()).toMatchObject({ rows: 1 });
    expect(order).toEqual(['prepare']);
  });
});

describe('TelemetryRetention: failure', () => {
  it('a store that fails is a notice, not an error, and the next pass tries again', async () => {
    const store = new MemoryTelemetryStore();
    store.write({ spans: [span(at(10, 1))] });
    let failing = true;
    const flaky = new Proxy(store, {
      get(target, key) {
        if (key === 'footprint' && failing) {
          return () => Promise.reject(new Error('disk I/O error'));
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const r = rig({ guard: 'none' }, { store: flaky });

    expect(await r.retention.runOnce()).toBeNull();
    const [notice] = r.recorder.notices('telemetry_purge_failed');
    expect(notice?.payload).toMatchObject({ subject: 'purge' });
    expect(String(notice?.payload.detail)).toContain('disk I/O error');

    failing = false;
    expect(await r.retention.runOnce()).toMatchObject({ rows: 1 });
  });

  it('a compaction that fails says compact', async () => {
    const store = new MemoryTelemetryStore({ bytesPerRecord: MB });
    store.write({ spans: [span(at(12, 1)), span(at(12, 2))] });
    const broken = new Proxy(store, {
      get(target, key) {
        if (key === 'compact') return () => Promise.reject(new Error('no space left'));
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const r = rig({ days: 0, max_mb: 1, guard: 'none' }, { store: broken });
    expect(await r.retention.runOnce()).toBeNull();
    expect(r.recorder.notices('telemetry_purge_failed')[0]?.payload).toMatchObject({
      subject: 'compact',
    });
  });
});

describe('TelemetryRetention: the schedule', () => {
  it('daily runs at the start and then every interval, on the clock handed in', async () => {
    const r = rig({ mode: 'daily', interval: DAY_MS, guard: 'none' });
    r.retention.start();
    await r.clock.advance(0);
    expect(r.passes()).toBe(1);
    await r.clock.advance(DAY_MS - 1);
    expect(r.passes()).toBe(1);
    await r.clock.advance(1);
    expect(r.passes()).toBe(2);
    await r.clock.advance(2 * DAY_MS);
    expect(r.passes()).toBe(4);
    await r.retention.stop();
    await r.clock.advance(5 * DAY_MS);
    expect(r.passes()).toBe(4);
  });

  it('startup runs once', async () => {
    const r = rig({ mode: 'startup', guard: 'none' });
    r.retention.start();
    await r.clock.advance(0);
    await r.clock.advance(3 * DAY_MS);
    expect(r.passes()).toBe(1);
    await r.retention.stop();
  });

  it('off never runs by itself', async () => {
    const r = rig({ mode: 'off', guard: 'none' });
    r.retention.start();
    await r.clock.advance(3 * DAY_MS);
    expect(r.passes()).toBe(0);
    await r.retention.stop();
    // A pass asked for still runs.
    await r.retention.runOnce();
    expect(r.passes()).toBe(1);
  });

  it('a second start does not start a second schedule', async () => {
    const r = rig({ mode: 'daily', guard: 'none' });
    r.retention.start();
    r.retention.start();
    await r.clock.advance(0);
    expect(r.passes()).toBe(1);
    await r.retention.stop();
  });
});
