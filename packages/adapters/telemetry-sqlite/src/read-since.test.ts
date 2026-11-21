// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DRIVERS, log, metric, openTempTelemetry, span } from './test-helpers.js';

describe.each(DRIVERS)('readSince, the cursor of the exporter (%s)', (driver) => {
  it('reads each signal by row id, in the order written, with the resource', async () => {
    const t = await openTempTelemetry(driver);
    try {
      t.store.write({
        spans: [span({ name: 'a' }), span({ name: 'b', spanId: 'c'.repeat(16) })],
        metrics: [metric({ name: 'm1' }), metric({ name: 'm2' })],
        logs: [log({ body: 'l1' })],
      });
      const spans = await t.store.readSince('spans', 0);
      expect(spans.map((row) => row.record.name)).toEqual(['a', 'b']);
      expect(spans[0]?.rowId).toBeLessThan(spans[1]?.rowId ?? 0);
      expect(spans[0]?.record.resource).toBeDefined();
      const metrics = await t.store.readSince('metrics', 0);
      expect(metrics.map((row) => row.record.name)).toEqual(['m1', 'm2']);
      const logs = await t.store.readSince('logs', 0);
      expect(logs.map((row) => row.record.body)).toEqual(['l1']);
    } finally {
      await t.dispose();
    }
  });

  it('continues after a position, honours the limit and never repeats a row', async () => {
    const t = await openTempTelemetry(driver);
    try {
      t.store.write({
        metrics: [1, 2, 3, 4, 5].map((n) => metric({ name: `m${String(n)}` })),
      });
      const first = await t.store.readSince('metrics', 0, 2);
      expect(first.map((row) => row.record.name)).toEqual(['m1', 'm2']);
      const next = await t.store.readSince('metrics', first[1]?.rowId ?? 0, 10);
      expect(next.map((row) => row.record.name)).toEqual(['m3', 'm4', 'm5']);
      expect(await t.store.readSince('metrics', next[2]?.rowId ?? 0)).toEqual([]);
    } finally {
      await t.dispose();
    }
  });

  it('keeps the row ids growing after old records are deleted (no reuse)', async () => {
    const t = await openTempTelemetry(driver);
    try {
      t.store.write({ logs: [log({ body: 'old' })] });
      const [old] = await t.store.readSince('logs', 0);
      await t.store.deleteOlderThan(BigInt(Date.UTC(2100, 0, 1)) * 1_000_000n);
      expect(await t.store.readSince('logs', 0)).toEqual([]);
      t.store.write({ logs: [log({ body: 'new' })] });
      const [fresh] = await t.store.readSince('logs', 0);
      expect(fresh?.record.body).toBe('new');
      expect(fresh?.rowId).toBeGreaterThan(old?.rowId ?? 0);
    } finally {
      await t.dispose();
    }
  });

  it('rejects a bad position or limit', async () => {
    const t = await openTempTelemetry(driver);
    try {
      await expect(t.store.readSince('spans', -1)).rejects.toThrow(/non-negative/);
      await expect(t.store.readSince('spans', 1.5)).rejects.toThrow(/non-negative/);
      await expect(t.store.readSince('spans', 0, 0)).rejects.toThrow(/limit/);
    } finally {
      await t.dispose();
    }
  });
});
