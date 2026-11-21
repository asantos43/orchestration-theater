// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DRIVERS, log, metric, openTempTelemetry, span } from './test-helpers.js';

const DAY_NS = 86_400_000_000_000n;
const T0 = 1_700_000_000_000_000_000n;

/** A span of `body` bytes of attributes, ending at `end`: enough rows to move the page count. */
function bulky(index: number, end: bigint) {
  return span({
    traceId: index.toString(16).padStart(32, '0'),
    spanId: index.toString(16).padStart(16, '0'),
    startTimeUnixNano: end - 1_000n,
    endTimeUnixNano: end,
    attributes: { blob: 'x'.repeat(2000) },
  });
}

describe.each(DRIVERS)('footprint and compact (%s)', (driver) => {
  it('reports the oldest raw record across the three signals, and none on an empty base', async () => {
    const t = await openTempTelemetry(driver);
    try {
      expect((await t.store.footprint()).oldestUnixNano).toBeNull();
      t.store.write({
        spans: [span({ endTimeUnixNano: T0 + 5n * DAY_NS })],
        metrics: [metric({ timeUnixNano: T0 + 2n * DAY_NS })],
        logs: [log({ timeUnixNano: T0 + 9n * DAY_NS })],
      });
      const footprint = await t.store.footprint();
      // Millisecond resolution: what was written at T0 + 2 days is found at the same millisecond.
      expect(footprint.oldestUnixNano).toBe(T0 + 2n * DAY_NS);
      expect(footprint.usedBytes).toBeGreaterThan(0);
      expect(footprint.fileBytes).toBeGreaterThan(0);
    } finally {
      await t.dispose();
    }
  });

  it('lowers usedBytes at once on a delete, and the file only shrinks when it is compacted', async () => {
    const t = await openTempTelemetry(driver);
    try {
      t.store.write({
        spans: Array.from({ length: 400 }, (_, i) => bulky(i + 1, T0 + BigInt(i) * 1_000_000n)),
      });
      const full = await t.store.footprint();
      await t.store.deleteOlderThan(T0 + 300n * 1_000_000n);
      const afterDelete = await t.store.footprint();
      expect(afterDelete.usedBytes).toBeLessThan(full.usedBytes);
      expect(await t.store.readSpans()).toHaveLength(100);

      await t.store.compact();
      const compacted = await t.store.footprint();
      expect(compacted.fileBytes ?? 0).toBeLessThan(full.fileBytes ?? 0);
      expect(compacted.usedBytes).toBeLessThanOrEqual(afterDelete.usedBytes);
      // The rows left are still there, and the base still takes writes.
      expect(await t.store.readSpans()).toHaveLength(100);
      t.store.write({ spans: [bulky(9999, T0 + 400n * 1_000_000n)] });
      expect(await t.store.readSpans()).toHaveLength(101);
    } finally {
      await t.dispose();
    }
  });

  it('keeps the daily aggregates through a compaction', async () => {
    const t = await openTempTelemetry(driver);
    try {
      t.store.write({ spans: [bulky(1, T0), bulky(2, T0 + 1n)] });
      await t.store.replaceRollupDay('2026-11-20', [
        {
          day: '2026-11-20',
          scenarioId: 'sc1',
          executor: 'claude/default',
          role: 'worker',
          metric: 'attempt_ms',
          facet: '',
          origin: 'daemon',
          count: 1,
          sum: 1,
          p50: 1,
          p95: 1,
          max: 1,
        },
      ]);
      await t.store.markRollupsReady('2026-11-20');
      await t.store.deleteOlderThan(T0 + 1_000_000_000n);
      await t.store.compact();
      expect(await t.store.readRollups()).toHaveLength(1);
      expect(await t.store.readRollupsReadyThrough()).toBe('2026-11-20');
    } finally {
      await t.dispose();
    }
  });

  it('compacts an empty or untouched base without error', async () => {
    const t = await openTempTelemetry(driver);
    try {
      await expect(t.store.compact()).resolves.toBeUndefined();
    } finally {
      await t.dispose();
    }
  });
});
