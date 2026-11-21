// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import {
  joinUnixNano,
  splitUnixNano,
  type JsonValue,
  type TelemetryAttributes,
  type TelemetryCorrelation,
  type TelemetryLogRecord,
  type TelemetryMetricPoint,
  type TelemetrySpan,
} from '@otheater/core';
import type { Insertable, Selectable } from 'kysely';
import type { LogRecordsTable, MetricPointsTable, SpansTable } from './schema.js';

/** A resource as it goes into the `resources` table: its hash and its JSON. */
export interface ResourceKey {
  readonly hash: string;
  readonly json: string;
}

/** One record waiting in the queue, already turned into the columns of its table. */
export type QueueEntry =
  | {
      readonly signal: 'spans';
      readonly resource: ResourceKey;
      readonly row: Omit<Insertable<SpansTable>, 'resource_id'>;
    }
  | {
      readonly signal: 'metrics';
      readonly resource: ResourceKey;
      readonly row: Omit<Insertable<MetricPointsTable>, 'resource_id'>;
    }
  | {
      readonly signal: 'logs';
      readonly resource: ResourceKey;
      readonly row: Omit<Insertable<LogRecordsTable>, 'resource_id'>;
    };

/** JSON with the keys of every object sorted, so equal resources give equal text (and hash). */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value);
}

const resourceCache = new WeakMap<object, ResourceKey>();

/** Hash and canonical text of a resource; the same object is hashed once. */
export function resourceKey(resource: TelemetryAttributes): ResourceKey {
  const cached = resourceCache.get(resource);
  if (cached !== undefined) return cached;
  const json = canonicalJson(resource);
  const key = { hash: createHash('sha256').update(json).digest('hex'), json };
  resourceCache.set(resource, key);
  return key;
}

/** Largest epoch (in milliseconds) both drivers hand back exactly: 2^53 - 1. */
const MAX_MS = Number.MAX_SAFE_INTEGER;

/** A nanosecond time the table can hold, as its two columns; throws for a negative or huge one. */
function time(nanos: bigint, what: string): { ms: number; subNs: number } {
  if (typeof nanos !== 'bigint' || nanos < 0n)
    throw new RangeError(`${what} must be a bigint >= 0`);
  const parts = splitUnixNano(nanos);
  if (parts.ms > MAX_MS) throw new RangeError(`${what} is out of range`);
  return parts;
}

function jsonText(value: unknown, what: string): string {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) throw new TypeError(`${what} is not JSON`);
  return text;
}

function correlation(item: TelemetryCorrelation): {
  scenario_id: string | null;
  play_id: string | null;
  attempt_id: string | null;
  session_id: string | null;
} {
  return {
    scenario_id: item.scenarioId ?? null,
    play_id: item.playId ?? null,
    attempt_id: item.attemptId ?? null,
    session_id: item.sessionId ?? null,
  };
}

/** Turns a span into a queue entry; throws when it cannot be stored (the caller discards it). */
export function spanEntry(span: TelemetrySpan): QueueEntry {
  const start = time(span.startTimeUnixNano, 'startTimeUnixNano');
  const end = time(span.endTimeUnixNano, 'endTimeUnixNano');
  return {
    signal: 'spans',
    resource: resourceKey(span.resource),
    row: {
      trace_id: span.traceId,
      span_id: span.spanId,
      parent_span_id: span.parentSpanId ?? null,
      name: span.name,
      kind: span.kind,
      start_ms: start.ms,
      start_sub_ns: start.subNs,
      end_ms: end.ms,
      end_sub_ns: end.subNs,
      status: span.status,
      status_message: span.statusMessage ?? null,
      attributes: jsonText(span.attributes, 'attributes'),
      ...correlation(span),
    },
  };
}

export function metricEntry(point: TelemetryMetricPoint): QueueEntry {
  if (!Number.isFinite(point.value)) throw new RangeError('value must be a finite number');
  const at = time(point.timeUnixNano, 'timeUnixNano');
  const start =
    point.startTimeUnixNano === null ? null : time(point.startTimeUnixNano, 'startTimeUnixNano');
  return {
    signal: 'metrics',
    resource: resourceKey(point.resource),
    row: {
      name: point.name,
      unit: point.unit ?? null,
      kind: point.kind,
      time_ms: at.ms,
      time_sub_ns: at.subNs,
      start_ms: start?.ms ?? null,
      start_sub_ns: start?.subNs ?? null,
      value: point.value,
      detail: point.detail === null ? null : jsonText(point.detail, 'detail'),
      attributes: jsonText(point.attributes, 'attributes'),
      ...correlation(point),
    },
  };
}

export function logEntry(record: TelemetryLogRecord): QueueEntry {
  const at = time(record.timeUnixNano, 'timeUnixNano');
  return {
    signal: 'logs',
    resource: resourceKey(record.resource),
    row: {
      time_ms: at.ms,
      time_sub_ns: at.subNs,
      severity: record.severity ?? null,
      severity_text: record.severityText ?? null,
      body: record.body ?? null,
      trace_id: record.traceId ?? null,
      span_id: record.spanId ?? null,
      attributes: jsonText(record.attributes, 'attributes'),
      ...correlation(record),
    },
  };
}

// ---- rows read back ---------------------------------------------------------------------------

interface CorrelationRow {
  scenario_id: string | null;
  play_id: string | null;
  attempt_id: string | null;
  session_id: string | null;
  resource_attributes: string;
  attributes: string;
}

function corr(row: CorrelationRow): TelemetryCorrelation {
  return {
    scenarioId: row.scenario_id,
    playId: row.play_id,
    attemptId: row.attempt_id,
    sessionId: row.session_id,
  };
}

const parseAttributes = (text: string): TelemetryAttributes =>
  JSON.parse(text) as TelemetryAttributes;

export type SpanRow = Selectable<SpansTable> & { resource_attributes: string };
export type MetricRow = Selectable<MetricPointsTable> & { resource_attributes: string };
export type LogRow = Selectable<LogRecordsTable> & { resource_attributes: string };

export function toSpan(row: SpanRow): TelemetrySpan {
  return {
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    kind: row.kind,
    startTimeUnixNano: joinUnixNano(row.start_ms, row.start_sub_ns),
    endTimeUnixNano: joinUnixNano(row.end_ms, row.end_sub_ns),
    status: row.status as TelemetrySpan['status'],
    statusMessage: row.status_message,
    attributes: parseAttributes(row.attributes),
    resource: parseAttributes(row.resource_attributes),
    ...corr(row),
  };
}

export function toMetric(row: MetricRow): TelemetryMetricPoint {
  return {
    name: row.name,
    unit: row.unit,
    kind: row.kind as TelemetryMetricPoint['kind'],
    timeUnixNano: joinUnixNano(row.time_ms, row.time_sub_ns),
    startTimeUnixNano:
      row.start_ms === null || row.start_sub_ns === null
        ? null
        : joinUnixNano(row.start_ms, row.start_sub_ns),
    value: row.value,
    detail: row.detail === null ? null : (JSON.parse(row.detail) as Record<string, JsonValue>),
    attributes: parseAttributes(row.attributes),
    resource: parseAttributes(row.resource_attributes),
    ...corr(row),
  };
}

export function toLog(row: LogRow): TelemetryLogRecord {
  return {
    timeUnixNano: joinUnixNano(row.time_ms, row.time_sub_ns),
    severity: row.severity,
    severityText: row.severity_text,
    body: row.body,
    traceId: row.trace_id,
    spanId: row.span_id,
    attributes: parseAttributes(row.attributes),
    resource: parseAttributes(row.resource_attributes),
    ...corr(row),
  };
}
