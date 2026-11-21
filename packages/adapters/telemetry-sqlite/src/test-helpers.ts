// SPDX-License-Identifier: MPL-2.0
// Shared by the tests only (excluded from the build of the package).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Clock,
  TelemetryLogRecord,
  TelemetryMetricPoint,
  TelemetrySpan,
} from '@otheater/core';
import {
  SQLITE_DRIVERS,
  type SqliteDriverName,
  type SqliteTelemetryConfigInput,
} from './config.js';
import { SqliteTelemetryStore, type TelemetryResetInfo } from './store.js';

export const DRIVERS: readonly SqliteDriverName[] = SQLITE_DRIVERS;

/** A temporary directory removed by `dispose()`. */
export async function makeTempDir(): Promise<{ dir: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'otheater-telemetry-'));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/** A fixed clock: this file may not import the fakes of core/testing (only *.test.ts may). */
export const FIXED_NOW = Date.UTC(2026, 10, 21, 15, 30, 0);

export async function openTempTelemetry(
  driver: SqliteDriverName,
  extra: Partial<SqliteTelemetryConfigInput> = {},
  existingDir?: string,
): Promise<{
  store: SqliteTelemetryStore;
  clock: Pick<Clock, 'now'>;
  resets: TelemetryResetInfo[];
  dir: string;
  dbPath: string;
  dispose: () => Promise<void>;
}> {
  const made = existingDir === undefined ? await makeTempDir() : undefined;
  const dir = existingDir ?? (made as { dir: string }).dir;
  const clock = { now: () => FIXED_NOW };
  const resets: TelemetryResetInfo[] = [];
  const dbPath = join(dir, 'telemetry.sqlite');
  try {
    const store = await SqliteTelemetryStore.open(
      { path: dbPath, driver, flushIntervalMs: 3_600_000, ...extra },
      { clock, onReset: (info) => resets.push(info) },
    );
    return {
      store,
      clock,
      resets,
      dir,
      dbPath,
      dispose: async () => {
        await store.close();
        await made?.dispose();
      },
    };
  } catch (error) {
    await made?.dispose();
    throw error;
  }
}

const NO_CORRELATION = { scenarioId: null, playId: null, attemptId: null, sessionId: null };

export function span(over: Partial<TelemetrySpan> = {}): TelemetrySpan {
  return {
    ...NO_CORRELATION,
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    parentSpanId: null,
    name: 'op',
    kind: 1,
    startTimeUnixNano: 1_700_000_000_000_000_001n,
    endTimeUnixNano: 1_700_000_000_000_000_999n,
    status: 'ok',
    statusMessage: null,
    attributes: { k: 'v', n: 1 },
    resource: { 'service.name': 'claude-code' },
    ...over,
  };
}

export function metric(over: Partial<TelemetryMetricPoint> = {}): TelemetryMetricPoint {
  return {
    ...NO_CORRELATION,
    name: 'tokens',
    unit: '{token}',
    kind: 'sum',
    timeUnixNano: 1_700_000_000_000_000_123n,
    startTimeUnixNano: null,
    value: 42,
    detail: null,
    attributes: {},
    resource: { 'service.name': 'claude-code' },
    ...over,
  };
}

export function log(over: Partial<TelemetryLogRecord> = {}): TelemetryLogRecord {
  return {
    ...NO_CORRELATION,
    timeUnixNano: 1_700_000_000_000_000_456n,
    severity: 9,
    severityText: 'INFO',
    body: 'hello',
    traceId: null,
    spanId: null,
    attributes: {},
    resource: { 'service.name': 'codex' },
    ...over,
  };
}
