// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { openRawDatabase } from './driver.js';
import { DRIVERS, openTempTelemetry, span } from './test-helpers.js';

describe.each(DRIVERS)('span identity and producer cursors (%s)', (driver) => {
  it('keeps the first span written under a (trace_id, span_id) and ignores the rest', async () => {
    const t = await openTempTelemetry(driver);
    try {
      const first = span({ name: 'first' });
      expect(t.store.write({ spans: [first] })).toEqual({ accepted: 1, dropped: 0 });
      t.store.write({ spans: [span({ name: 'again' }), span({ spanId: 'c'.repeat(16) })] });
      const spans = await t.store.readSpans();
      expect(spans.map((s) => s.name)).toEqual(['first', 'op']);
      // The same id in another trace is another span.
      t.store.write({ spans: [span({ traceId: 'd'.repeat(32), name: 'other trace' })] });
      expect(await t.store.readSpans()).toHaveLength(3);
      // A duplicate inside one batch does not fail the batch.
      t.store.write({
        spans: [span({ spanId: 'e'.repeat(16) }), span({ spanId: 'e'.repeat(16) })],
      });
      expect(await t.store.readSpans()).toHaveLength(4);
      expect(await t.store.health()).toMatchObject({ state: 'ok', discarded: 0 });
    } finally {
      await t.dispose();
    }
  });

  it('saves a cursor, reads it back, moves it, and tells names apart', async () => {
    const t = await openTempTelemetry(driver);
    try {
      expect(await t.store.readCursor('daemon-spans')).toBeNull();
      await t.store.writeCursor('daemon-spans', 41);
      await t.store.writeCursor('other', 7);
      expect(await t.store.readCursor('daemon-spans')).toBe(41);
      await t.store.writeCursor('daemon-spans', 0);
      expect(await t.store.readCursor('daemon-spans')).toBe(0);
      expect(await t.store.readCursor('other')).toBe(7);
      await expect(t.store.writeCursor('daemon-spans', -1)).rejects.toThrow(/integer >= 0/);
      await expect(t.store.writeCursor('daemon-spans', 1.5)).rejects.toThrow(/integer >= 0/);
      await expect(t.store.readCursor('')).rejects.toThrow(/cursor name/);
    } finally {
      await t.dispose();
    }
  });

  it('writes what is queued before it saves a cursor', async () => {
    const t = await openTempTelemetry(driver);
    try {
      t.store.write({ spans: [span()] });
      expect((await t.store.health()).queued).toBe(1);
      await t.store.writeCursor('daemon-spans', 3);
      expect((await t.store.health()).queued).toBe(0);
    } finally {
      await t.dispose();
    }
  });

  it('a recreated base has no cursor: the producer starts again', async () => {
    const t = await openTempTelemetry(driver);
    try {
      await t.store.writeCursor('daemon-spans', 9);
    } finally {
      await t.dispose();
    }
    const fresh = await openTempTelemetry(driver);
    try {
      expect(await fresh.store.readCursor('daemon-spans')).toBeNull();
    } finally {
      await fresh.dispose();
    }
  });

  it('migration 0002 drops the duplicates a 0001 base may hold and then enforces identity', async () => {
    const first = await openTempTelemetry(driver);
    try {
      first.store.write({ spans: [span()] });
      await first.store.close();
      const raw = await openRawDatabase(driver, first.dbPath, {
        readonly: false,
        busyTimeoutMs: 1000,
      });
      try {
        // Back to what a base of the first release looks like, with a duplicate in it.
        raw.exec('drop index spans_trace_span');
        raw.exec(
          `insert into spans (resource_id, trace_id, span_id, parent_span_id, name, kind, start_ms, start_sub_ns, end_ms, end_sub_ns, status, attributes)
           select resource_id, trace_id, span_id, parent_span_id, 'dup', kind, start_ms, start_sub_ns, end_ms, end_sub_ns, status, attributes from spans`,
        );
        raw.exec("delete from kysely_migration where name = '0002_span_identity'");
      } finally {
        raw.close();
      }
      const again = await openTempTelemetry(driver, {}, first.dir);
      try {
        expect((await again.store.readSpans()).map((s) => s.name)).toEqual(['op']);
        again.store.write({ spans: [span({ name: 'later' })] });
        expect(await again.store.readSpans()).toHaveLength(1);
      } finally {
        await again.store.close();
      }
    } finally {
      await first.dispose();
    }
  });
});
