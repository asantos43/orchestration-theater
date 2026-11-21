// SPDX-License-Identifier: MPL-2.0
import { TELEMETRY_STORE_PORT_VERSION, type RollupRow } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { DRIVERS, openTempTelemetry, span } from './test-helpers.js';

function row(over: Partial<RollupRow> = {}): RollupRow {
  return {
    day: '2026-11-20',
    scenarioId: 'sc1',
    executor: 'claude/default',
    role: 'worker',
    metric: 'attempt_ms',
    facet: '',
    origin: 'daemon',
    count: 3,
    sum: 300,
    p50: 100,
    p95: 150,
    max: 160,
    ...over,
  };
}

describe('telemetry port version', () => {
  it('declares the rollup extension as a minor bump', () => {
    expect(TELEMETRY_STORE_PORT_VERSION).toBe('0.4.0');
  });
});

describe.each(DRIVERS)('rollups_daily (%s)', (driver) => {
  it('stores and reads rows, keeping NULL as a gap and not zero', async () => {
    const t = await openTempTelemetry(driver);
    try {
      const gap = row({
        metric: 'tokens_in',
        origin: 'client',
        sum: null,
        p50: null,
        p95: null,
        max: null,
      });
      await t.store.replaceRollupDay('2026-11-20', [row(), gap]);
      const rows = await t.store.readRollups();
      expect(rows).toHaveLength(2);
      const read = rows.find((r) => r.metric === 'tokens_in');
      expect(read).toEqual(gap);
      expect(read?.sum).toBeNull();
    } finally {
      await t.dispose();
    }
  });

  it('replaces a whole day and leaves the other days alone (idempotent)', async () => {
    const t = await openTempTelemetry(driver);
    try {
      await t.store.replaceRollupDay('2026-11-19', [row({ day: '2026-11-19' })]);
      const day20 = [row(), row({ metric: 'wait_ms', facet: 'quota' })];
      await t.store.replaceRollupDay('2026-11-20', day20);
      const first = await t.store.readRollups();
      await t.store.replaceRollupDay('2026-11-20', day20);
      expect(await t.store.readRollups()).toEqual(first);
      await t.store.replaceRollupDay('2026-11-20', [row({ count: 9 })]);
      const after = await t.store.readRollups();
      expect(after).toHaveLength(2);
      expect(after.find((r) => r.day === '2026-11-20')?.count).toBe(9);
      expect(after.find((r) => r.day === '2026-11-19')).toBeDefined();
      await t.store.replaceRollupDay('2026-11-20', []);
      expect(await t.store.readRollups()).toHaveLength(1);
    } finally {
      await t.dispose();
    }
  });

  it('filters by day range, scenario, executor and role', async () => {
    const t = await openTempTelemetry(driver);
    try {
      await t.store.replaceRollupDay('2026-11-19', [row({ day: '2026-11-19' })]);
      await t.store.replaceRollupDay('2026-11-20', [
        row(),
        row({ scenarioId: 'sc2' }),
        row({ executor: 'codex/default' }),
        row({ role: 'reviewer' }),
      ]);
      expect(await t.store.readRollups({ fromDay: '2026-11-20' })).toHaveLength(4);
      expect(await t.store.readRollups({ toDay: '2026-11-19' })).toHaveLength(1);
      expect(await t.store.readRollups({ scenarioId: 'sc2' })).toHaveLength(1);
      expect(await t.store.readRollups({ executor: 'codex/default' })).toHaveLength(1);
      expect(await t.store.readRollups({ role: 'reviewer' })).toHaveLength(1);
    } finally {
      await t.dispose();
    }
  });

  it('rejects malformed days, rows of another day and duplicate keys', async () => {
    const t = await openTempTelemetry(driver);
    try {
      await expect(t.store.replaceRollupDay('2026-13-01', [])).rejects.toThrow();
      await expect(t.store.replaceRollupDay('20261120', [])).rejects.toThrow();
      await expect(
        t.store.replaceRollupDay('2026-11-20', [row({ day: '2026-11-21' })]),
      ).rejects.toThrow();
      await expect(t.store.replaceRollupDay('2026-11-20', [row(), row()])).rejects.toThrow();
      expect(await t.store.readRollups()).toHaveLength(0);
    } finally {
      await t.dispose();
    }
  });

  it('keeps the old day when a replacement fails', async () => {
    const t = await openTempTelemetry(driver);
    try {
      await t.store.replaceRollupDay('2026-11-20', [row()]);
      await expect(t.store.replaceRollupDay('2026-11-20', [row({ count: -1 })])).rejects.toThrow();
      expect(await t.store.readRollups()).toEqual([row()]);
    } finally {
      await t.dispose();
    }
  });

  it('keeps the latest ready day and never goes back', async () => {
    const t = await openTempTelemetry(driver);
    try {
      expect(await t.store.readRollupsReadyThrough()).toBeNull();
      await t.store.markRollupsReady('2026-11-20');
      await t.store.markRollupsReady('2026-11-18');
      expect(await t.store.readRollupsReadyThrough()).toBe('2026-11-20');
      await t.store.markRollupsReady('2026-11-21');
      expect(await t.store.readRollupsReadyThrough()).toBe('2026-11-21');
    } finally {
      await t.dispose();
    }
  });

  it('deletes the days before a cut-off and reports how many rows went', async () => {
    const t = await openTempTelemetry(driver);
    try {
      await t.store.replaceRollupDay('2026-11-18', [row({ day: '2026-11-18' })]);
      await t.store.replaceRollupDay('2026-11-19', [
        row({ day: '2026-11-19' }),
        row({ day: '2026-11-19', metric: 'x' }),
      ]);
      await t.store.replaceRollupDay('2026-11-20', [row()]);
      expect(await t.store.deleteRollupsBefore('2026-11-20')).toBe(3);
      expect((await t.store.readRollups()).map((r) => r.day)).toEqual(['2026-11-20']);
    } finally {
      await t.dispose();
    }
  });

  it('filters spans by end time, separately from the start window', async () => {
    const t = await openTempTelemetry(driver);
    try {
      t.store.write({
        spans: [
          span({ spanId: '1'.repeat(16), startTimeUnixNano: 10n, endTimeUnixNano: 100n }),
          span({ spanId: '2'.repeat(16), startTimeUnixNano: 50n, endTimeUnixNano: 200n }),
          span({ spanId: '3'.repeat(16), startTimeUnixNano: 150n, endTimeUnixNano: 300n }),
        ],
      });
      await t.store.flush();
      const ids = async (f: { endedFromUnixNano?: bigint; endedToUnixNano?: bigint }) =>
        (await t.store.readSpans(f)).map((s) => s.spanId[0]).sort();
      expect(await ids({ endedFromUnixNano: 100n, endedToUnixNano: 300n })).toEqual(['1', '2']);
      expect(await ids({ endedFromUnixNano: 200n })).toEqual(['2', '3']);
      expect(await ids({ endedToUnixNano: 100n })).toEqual([]);
    } finally {
      await t.dispose();
    }
  });
});
