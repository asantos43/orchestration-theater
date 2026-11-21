// SPDX-License-Identifier: MPL-2.0
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteTelemetryConfigSchema } from './config.js';
import { backupTelemetryFile, SqliteTelemetryStore } from './store.js';
import { DRIVERS, log, makeTempDir, metric, openTempTelemetry, span } from './test-helpers.js';

describe.each(DRIVERS)('SqliteTelemetryStore (%s)', (driver) => {
  it('round-trips spans, metrics and logs with exact nanoseconds', async () => {
    const t = await openTempTelemetry(driver);
    try {
      const receipt = t.store.write({ spans: [span()], metrics: [metric()], logs: [log()] });
      expect(receipt).toEqual({ accepted: 3, dropped: 0 });
      const [s] = await t.store.readSpans();
      expect(s).toEqual(span());
      expect(s?.startTimeUnixNano).toBe(1_700_000_000_000_000_001n);
      const [m] = await t.store.readMetrics();
      expect(m).toEqual(metric());
      const [l] = await t.store.readLogs();
      expect(l).toEqual(log());
      const health = await t.store.health();
      expect(health).toMatchObject({ state: 'ok', queued: 0, written: 3, droppedOverflow: 0 });
      expect(health.fileBytes).toBeGreaterThan(0);
    } finally {
      await t.dispose();
    }
  });

  it('shares one resource row among records with the same resource', async () => {
    const t = await openTempTelemetry(driver);
    try {
      t.store.write({
        spans: [span({ spanId: '1'.repeat(16) }), span({ spanId: '2'.repeat(16) })],
      });
      t.store.write({ spans: [span({ spanId: '3'.repeat(16), resource: { b: 1, a: 2 } })] });
      t.store.write({ spans: [span({ spanId: '4'.repeat(16), resource: { a: 2, b: 1 } })] });
      expect(await t.store.readSpans()).toHaveLength(4);
      const { openRawDatabase } = await import('./driver.js');
      const raw = await openRawDatabase(driver, t.dbPath, { readonly: true, busyTimeoutMs: 1000 });
      try {
        const rows = raw.prepare('select count(*) as n from resources').all([]) as { n: number }[];
        expect(rows[0]?.n).toBe(2);
      } finally {
        raw.close();
      }
    } finally {
      await t.dispose();
    }
  });

  it('filters by play, attempt, session, scenario and by time window [from, to)', async () => {
    const t = await openTempTelemetry(driver);
    try {
      t.store.write({
        spans: [
          span({ spanId: '1'.repeat(16), playId: 'p1', attemptId: 'a1', scenarioId: 's1' }),
          span({
            spanId: '2'.repeat(16),
            playId: 'p1',
            attemptId: 'a2',
            sessionId: 'x',
            startTimeUnixNano: 1_700_000_001_000_000_000n,
            endTimeUnixNano: 1_700_000_002_000_000_000n,
          }),
          span({ spanId: '3'.repeat(16), playId: 'p2' }),
        ],
      });
      expect(await t.store.readSpans({ playId: 'p1' })).toHaveLength(2);
      expect(await t.store.readSpans({ attemptId: 'a1' })).toHaveLength(1);
      expect(await t.store.readSpans({ scenarioId: 's1' })).toHaveLength(1);
      expect(await t.store.readSpans({ sessionId: 'x' })).toHaveLength(1);
      expect(await t.store.readSpans({ playId: 'nope' })).toHaveLength(0);
      const from = 1_700_000_000_000_000_001n;
      expect(await t.store.readSpans({ fromUnixNano: from })).toHaveLength(3);
      expect(await t.store.readSpans({ fromUnixNano: from + 1n })).toHaveLength(1);
      expect(await t.store.readSpans({ toUnixNano: from })).toHaveLength(0);
      expect(await t.store.readSpans({ toUnixNano: from + 1n })).toHaveLength(2);
      const ordered = await t.store.readSpans();
      expect(ordered.map((s) => s.spanId[0])).toEqual(['1', '3', '2']);
      expect(await t.store.readSpans({ limit: 2 })).toHaveLength(2);
      await expect(t.store.readSpans({ limit: 0 })).rejects.toThrow(/limit/);
      await expect(t.store.readSpans({ limit: 10_001 })).rejects.toThrow(/limit/);
    } finally {
      await t.dispose();
    }
  });

  it('drops the oldest records when the queue is full, and counts them', async () => {
    const t = await openTempTelemetry(driver, { queueMax: 3, writeBatch: 100 });
    try {
      const logs = [1n, 2n, 3n, 4n, 5n].map((n) =>
        log({ timeUnixNano: 1_700_000_000_000_000_000n + n }),
      );
      const receipt = t.store.write({ logs });
      expect(receipt).toEqual({ accepted: 5, dropped: 2 });
      expect(await t.store.health()).toMatchObject({ queued: 3, droppedOverflow: 2 });
      const read = await t.store.readLogs();
      expect(read.map((l) => l.timeUnixNano % 10n)).toEqual([3n, 4n, 5n]);
    } finally {
      await t.dispose();
    }
  });

  it('discards and counts records it cannot encode', async () => {
    const t = await openTempTelemetry(driver);
    try {
      const receipt = t.store.write({
        metrics: [metric({ value: Number.NaN }), metric({ timeUnixNano: -1n }), metric()],
      });
      expect(receipt).toEqual({ accepted: 1, dropped: 2 });
      expect((await t.store.health()).discarded).toBe(2);
      expect(await t.store.readMetrics()).toHaveLength(1);
    } finally {
      await t.dispose();
    }
  });

  it('writes by itself when the queue reaches the batch size', async () => {
    const t = await openTempTelemetry(driver, { writeBatch: 2 });
    try {
      t.store.write({ logs: [log(), log({ body: 'b' })] });
      for (let i = 0; i < 100 && (await t.store.health()).written < 2; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await t.store.health()).written).toBe(2);
    } finally {
      await t.dispose();
    }
  });

  it('deletes by age and removes resources nothing refers to', async () => {
    const t = await openTempTelemetry(driver);
    try {
      t.store.write({
        spans: [
          span({ spanId: '1'.repeat(16), resource: { r: 'old' } }),
          span({
            spanId: '2'.repeat(16),
            startTimeUnixNano: 1_800_000_000_000_000_000n,
            endTimeUnixNano: 1_800_000_000_000_000_500n,
          }),
        ],
        metrics: [metric({ timeUnixNano: 1_700_000_000_000_000_000n, resource: { r: 'old' } })],
        logs: [log({ timeUnixNano: 1_800_000_000_000_000_000n })],
      });
      const result = await t.store.deleteOlderThan(1_750_000_000_000_000_000n);
      expect(result).toEqual({ spans: 1, metrics: 1, logs: 0 });
      expect(await t.store.readSpans()).toHaveLength(1);
      expect(await t.store.readMetrics()).toHaveLength(0);
      expect(await t.store.readLogs()).toHaveLength(1);
      const { openRawDatabase } = await import('./driver.js');
      const raw = await openRawDatabase(driver, t.dbPath, { readonly: true, busyTimeoutMs: 1000 });
      try {
        const rows = raw.prepare('select count(*) as n from resources').all([]) as { n: number }[];
        expect(rows[0]?.n).toBe(2);
      } finally {
        raw.close();
      }
      await expect(t.store.deleteOlderThan(-1n)).rejects.toThrow();
    } finally {
      await t.dispose();
    }
  });

  it('runs the telemetry file at synchronous NORMAL and WAL; the FULL of the Store is untouched', async () => {
    const t = await openTempTelemetry(driver);
    try {
      expect(await t.store.diagnostics()).toMatchObject({
        driver,
        journalMode: 'wal',
        synchronous: 1,
      });
    } finally {
      await t.dispose();
    }
    const full = await openTempTelemetry(driver, { synchronous: 'full' });
    try {
      expect((await full.store.diagnostics()).synchronous).toBe(2);
    } finally {
      await full.dispose();
    }
  });

  it('recreates a corrupted file, keeps it as .broken-<date> and tells onReset', async () => {
    const dir = await makeTempDir();
    try {
      const path = join(dir.dir, 'telemetry.sqlite');
      await writeFile(path, Buffer.alloc(8192, 0x61));
      const t = await openTempTelemetry(driver, {}, dir.dir);
      try {
        expect(t.resets).toHaveLength(1);
        expect(t.resets[0]).toMatchObject({ reason: 'corrupt', outcome: 'recreated' });
        expect(t.resets[0]?.brokenFile).toMatch(/telemetry\.sqlite\.broken-20261121-153000$/);
        const files = await readdir(dir.dir);
        expect(files).toContain('telemetry.sqlite.broken-20261121-153000');
        expect(
          (await readFile(join(dir.dir, files.find((f) => f.includes('broken')) ?? '')))[0],
        ).toBe(0x61);
        t.store.write({ logs: [log()] });
        expect(await t.store.readLogs()).toHaveLength(1);
        expect(await t.store.health()).toMatchObject({ state: 'ok', resets: 1 });
      } finally {
        await t.store.close();
      }
    } finally {
      await dir.dispose();
    }
  });

  it('does not overwrite an earlier .broken file', async () => {
    const dir = await makeTempDir();
    try {
      await writeFile(join(dir.dir, 'telemetry.sqlite'), Buffer.alloc(8192, 0x62));
      await writeFile(join(dir.dir, 'telemetry.sqlite.broken-20261121-153000'), 'older');
      const t = await openTempTelemetry(driver, {}, dir.dir);
      try {
        const files = await readdir(dir.dir);
        expect(files).toContain('telemetry.sqlite.broken-20261121-153000-1');
        expect(
          await readFile(join(dir.dir, 'telemetry.sqlite.broken-20261121-153000'), 'utf8'),
        ).toBe('older');
      } finally {
        await t.store.close();
      }
    } finally {
      await dir.dispose();
    }
  });

  it('without a base, writes are discards with a counter, and onReset says unavailable once', async () => {
    const dir = await makeTempDir();
    try {
      // The "file" is a directory: it cannot be opened, and it is not a reset reason.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(dir.dir, 'telemetry.sqlite'));
      const t = await openTempTelemetry(driver, { retryAfterMs: 3_600_000 }, dir.dir);
      try {
        expect(t.resets).toHaveLength(1);
        expect(t.resets[0]).toMatchObject({ outcome: 'unavailable', brokenFile: null });
        expect(t.store.write({ logs: [log(), log()] })).toEqual({ accepted: 0, dropped: 2 });
        const health = await t.store.health();
        expect(health).toMatchObject({ state: 'no_base', discarded: 2, fileBytes: null });
        await expect(t.store.readLogs()).rejects.toThrow();
        await t.store.flush();
        expect(t.resets).toHaveLength(1);
      } finally {
        await t.store.close();
      }
    } finally {
      await dir.dispose();
    }
  });

  it('copies a consistent snapshot with backupTo and backupTelemetryFile', async () => {
    const t = await openTempTelemetry(driver);
    const out = await makeTempDir();
    try {
      t.store.write({ logs: [log()] });
      await t.store.backupTo(join(out.dir, 'a.sqlite'));
      expect((await stat(join(out.dir, 'a.sqlite'))).size).toBeGreaterThan(0);
      const copy = await SqliteTelemetryStore.open(
        { path: join(out.dir, 'a.sqlite'), driver },
        { clock: t.clock },
      );
      try {
        expect(await copy.readLogs()).toHaveLength(1);
      } finally {
        await copy.close();
      }
      expect(
        await backupTelemetryFile({ path: t.dbPath, destPath: join(out.dir, 'b.sqlite'), driver }),
      ).toBe(true);
      expect(
        await backupTelemetryFile({
          path: join(out.dir, 'none'),
          destPath: join(out.dir, 'c.sqlite'),
          driver,
        }),
      ).toBe(false);
    } finally {
      await t.dispose();
      await out.dispose();
    }
  });

  it('keeps the data across close and reopen, and close is idempotent', async () => {
    const dir = await makeTempDir();
    try {
      const first = await openTempTelemetry(driver, {}, dir.dir);
      first.store.write({ spans: [span()] });
      await first.store.close();
      await first.store.close();
      const second = await openTempTelemetry(driver, {}, dir.dir);
      try {
        expect(await second.store.readSpans()).toHaveLength(1);
        expect(second.resets).toHaveLength(0);
      } finally {
        await second.store.close();
      }
      expect(first.store.write({ logs: [log()] })).toEqual({ accepted: 0, dropped: 1 });
    } finally {
      await dir.dispose();
    }
  });
});

describe('SqliteTelemetryConfigSchema', () => {
  it('applies the defaults', () => {
    expect(SqliteTelemetryConfigSchema.parse({ path: '/x/t.sqlite' })).toMatchObject({
      driver: 'better-sqlite3',
      synchronous: 'normal',
      writeBatch: 500,
      queueMax: 20_000,
    });
  });
  it('refuses unknown keys, memory paths and bad values', () => {
    for (const bad of [
      { path: '/x', extra: 1 },
      { path: ':memory:' },
      { path: 'file:x' },
      { path: '/x', synchronous: 'off' },
      { path: '/x', queueMax: 0 },
      { path: '/x', driver: 'other' },
    ]) {
      expect(SqliteTelemetryConfigSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('rejects an invalid config at open', async () => {
    await expect(
      SqliteTelemetryStore.open({ path: ':memory:' }, { clock: { now: () => 0 } }),
    ).rejects.toThrow(/Invalid SQLite telemetry config/);
  });
});
