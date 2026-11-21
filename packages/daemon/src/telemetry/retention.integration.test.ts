// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { TelemetrySpan } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import type { DaemonEventPayloads, DaemonEventType } from '@otheater/protocol';
import { AnalysisConfigSchema } from '../analysis/analysis-config.js';
import { AnalysisService } from '../analysis/analysis-service.js';
import { DAEMON_SPAN_RESOURCE, OT, SPAN_NAME } from './span-conventions.js';
import { TelemetryRetention } from './retention.js';
import { MemoryTelemetryStore } from './telemetry-fixture.js';

const LOGGER = { warn: () => undefined, info: () => undefined };
const at = (month: number, day: number, hour: number): number =>
  Date.UTC(2026, month - 1, day, hour, 0, 0);

let counter = 0;
/** A stage span of the daemon that ends `minutes` after `startMs`. */
function stage(startMs: number): TelemetrySpan {
  counter += 1;
  return {
    traceId: counter.toString(16).padStart(32, '0'),
    spanId: counter.toString(16).padStart(16, '0'),
    parentSpanId: null,
    name: SPAN_NAME.stage,
    kind: 1,
    startTimeUnixNano: BigInt(startMs) * 1_000_000n,
    endTimeUnixNano: BigInt(startMs + 60_000) * 1_000_000n,
    status: 'unset',
    statusMessage: null,
    attributes: { [OT.stage]: 'PLANNING' },
    resource: { ...DAEMON_SPAN_RESOURCE },
    scenarioId: 's1',
    playId: 'p1',
    attemptId: null,
    sessionId: null,
  };
}

function rig(analysis: Record<string, unknown> = {}): {
  readonly telemetry: MemoryTelemetryStore;
  readonly service: AnalysisService;
  readonly retention: TelemetryRetention;
  readonly notices: string[];
} {
  const clock = new FakeClock(at(11, 13, 12));
  const store = new InMemoryStore({ clock });
  const telemetry = new MemoryTelemetryStore();
  const settings = AnalysisConfigSchema.parse({ day_boundary: 'utc', ...analysis });
  const notices: string[] = [];
  const situations = {
    record: <T extends DaemonEventType>(type: T, payload: DaemonEventPayloads[T]): void => {
      notices.push(type === 'daemon.notice' ? (payload as { kind: string }).kind : type);
    },
  };
  const service = new AnalysisService({
    clock,
    telemetry,
    events: store.events,
    usage: store.usage,
    settings: () => settings,
    situations,
    logger: LOGGER,
  });
  const retention = new TelemetryRetention({
    clock,
    telemetry,
    settings: () => ({
      mode: 'daily',
      interval: 86_400_000,
      days: 1,
      max_mb: 1024,
      guard: 'rollups',
    }),
    ready: () => service.readyCutoff(),
    prepare: settings.schedule.mode === 'off' ? undefined : () => service.catchUp(),
    situations,
    logger: LOGGER,
  });
  return { telemetry, service, retention, notices };
}

const days = async (telemetry: MemoryTelemetryStore): Promise<string[]> => [
  ...new Set((await telemetry.readRollups({})).map((row) => row.day)),
];
const startsOf = async (telemetry: MemoryTelemetryStore): Promise<number[]> =>
  (await telemetry.readSpans({}))
    .map((span) => Number(span.startTimeUnixNano / 1_000_000n))
    .sort((a, b) => a - b);

describe('the retention over the analysis (P8 over P9)', () => {
  it('removes the raw days the aggregates now cover and keeps the aggregates', async () => {
    const r = rig();
    r.telemetry.write({
      spans: [
        stage(at(11, 10, 9)),
        stage(at(11, 11, 9)),
        stage(at(11, 12, 9)),
        stage(at(11, 13, 8)),
      ],
    });

    const result = await r.retention.runOnce();

    // Today (11-13) is not closed, so it is not in the aggregates, and it stays raw.
    expect(await days(r.telemetry)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
    expect(await startsOf(r.telemetry)).toEqual([at(11, 13, 8)]);
    expect(result).toMatchObject({ rows: 3, blocked: false });
    expect(r.notices).toEqual(['telemetry.purged']);
  });

  it('with the analysis off nothing is purged, and the notice says so', async () => {
    const r = rig({ schedule: { mode: 'off' } });
    r.telemetry.write({ spans: [stage(at(11, 10, 9)), stage(at(11, 11, 9))] });

    const result = await r.retention.runOnce();

    expect(result).toMatchObject({ rows: 0, blocked: true });
    expect(await startsOf(r.telemetry)).toHaveLength(2);
    expect(await days(r.telemetry)).toEqual([]);
    expect(r.notices).toEqual(['telemetry_purge_blocked']);
  });

  it('after the aggregates are built by hand the same pass purges them', async () => {
    const r = rig({ schedule: { mode: 'off' } });
    r.telemetry.write({ spans: [stage(at(11, 10, 9)), stage(at(11, 13, 8))] });
    await r.service.aggregateDay('2026-11-10');
    await r.telemetry.markRollupsReady('2026-11-10');

    expect(await r.retention.runOnce()).toMatchObject({ rows: 1, blocked: false });
    expect(await startsOf(r.telemetry)).toEqual([at(11, 13, 8)]);
    expect(await days(r.telemetry)).toEqual(['2026-11-10']);
  });
});
