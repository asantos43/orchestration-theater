// SPDX-License-Identifier: MPL-2.0
import type {
  JsonValue,
  TelemetryAttributes,
  TelemetryLogRecord,
  TelemetryMetricPoint,
  TelemetrySpan,
} from '@otheater/core';
import type { OtlpSignal } from './otlp.js';
import { OT } from './span-conventions.js';

/**
 * The other way of `otlp.ts` (Phase 8, P7, N70 and N211): the records of the telemetry base as an
 * OTLP/HTTP JSON request, to send to the `telemetry.otlp.endpoint`. Code of our own, with no
 * OpenTelemetry package and no protobuf. The shape is the one of the OTLP/JSON encoding
 * [S: opentelemetry.io/docs/specs/otlp, "JSON Protobuf Encoding": ids as lowercase hex, 64-bit
 * integers as strings, enums as numbers, names in lowerCamelCase].
 *
 * What the base does not keep is filled with what is safe, and says so here:
 * - the instrumentation scope is not stored, so every group goes out under the scope `otheater`;
 * - a data point is not stored as an integer or a double: it goes as `asDouble`;
 * - a number in an attribute that is an integer goes as `intValue`, any other as `doubleValue`
 *   (a double with no fraction is read back as an integer: the base never kept which it was);
 * - an attribute whose value is `null` is left out (OTLP has no null that a backend accepts alike);
 * - a sum with no temporality goes as cumulative and not monotonic, a histogram with none as
 *   cumulative [proposta]. The decoder keeps what the clients said (`detail`), so this is the
 *   exception, not the rule.
 *
 * What goes out was redacted when it was received (P2), so nothing is redacted again here.
 */

/** The scope every group goes out under. */
export const EXPORT_SCOPE = { name: 'otheater' } as const;

const CUMULATIVE = 2;

interface KeyValueJson {
  readonly key: string;
  readonly value: Record<string, unknown>;
}

/** One JSON value as an OTLP `AnyValue`. A non-finite number goes as its text. */
function anyValue(value: JsonValue): Record<string, unknown> {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { stringValue: String(value) };
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (value === null) return {};
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  return { kvlistValue: { values: keyValues(value) } };
}

function keyValues(attributes: Readonly<Record<string, JsonValue>>): KeyValueJson[] {
  const out: KeyValueJson[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== null) out.push({ key, value: anyValue(value) });
  }
  return out;
}

/** The ids the base ties a record to, as attributes, unless the record already says them. */
function withCorrelation(
  attributes: TelemetryAttributes,
  ids: {
    readonly scenarioId: string | null;
    readonly playId: string | null;
    readonly attemptId: string | null;
    readonly sessionId: string | null;
  },
): TelemetryAttributes {
  const out: Record<string, JsonValue> = { ...attributes };
  const pairs = [
    [OT.scenarioId, ids.scenarioId],
    [OT.playId, ids.playId],
    [OT.attemptId, ids.attemptId],
    [OT.sessionId, ids.sessionId],
  ] as const;
  for (const [key, value] of pairs) {
    if (value !== null && out[key] === undefined) out[key] = value;
  }
  return out;
}

/** Groups records that share a resource, in the order the resources first appear. */
function byResource<T extends { readonly resource: TelemetryAttributes }>(
  records: readonly T[],
): { readonly resource: TelemetryAttributes; readonly records: T[] }[] {
  const groups = new Map<string, { resource: TelemetryAttributes; records: T[] }>();
  for (const record of records) {
    const key = JSON.stringify(record.resource);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { resource: record.resource, records: [record] });
    else group.records.push(record);
  }
  return [...groups.values()];
}

const STATUS_CODE = { unset: 0, ok: 1, error: 2 } as const;

function spanJson(span: TelemetrySpan): Record<string, unknown> {
  const out: Record<string, unknown> = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: span.startTimeUnixNano.toString(),
    endTimeUnixNano: span.endTimeUnixNano.toString(),
    attributes: keyValues(withCorrelation(span.attributes, span)),
  };
  if (span.parentSpanId !== null) out.parentSpanId = span.parentSpanId;
  const status: Record<string, unknown> = { code: STATUS_CODE[span.status] };
  if (span.statusMessage !== null) status.message = span.statusMessage;
  out.status = status;
  return out;
}

function numberOf(detail: Readonly<Record<string, JsonValue>> | null, key: string): unknown {
  const value = detail?.[key];
  return typeof value === 'number' ? value : undefined;
}

function temporalityOf(point: TelemetryMetricPoint): number {
  const value = numberOf(point.detail, 'aggregationTemporality');
  return value === 1 || value === 2 ? value : CUMULATIVE;
}

function monotonicOf(point: TelemetryMetricPoint): boolean {
  return point.detail?.isMonotonic === true;
}

function numberPoint(point: TelemetryMetricPoint): Record<string, unknown> {
  const out: Record<string, unknown> = {
    attributes: keyValues(withCorrelation(point.attributes, point)),
    timeUnixNano: point.timeUnixNano.toString(),
    asDouble: point.value,
  };
  if (point.startTimeUnixNano !== null) out.startTimeUnixNano = point.startTimeUnixNano.toString();
  return out;
}

/** A count of the base as the string OTLP/JSON gives a 64-bit integer; none is zero. */
function counted(value: unknown): string {
  return typeof value === 'number' ? String(value) : '0';
}

function histogramPoint(point: TelemetryMetricPoint): Record<string, unknown> {
  const detail = point.detail;
  const counts = detail?.bucketCounts;
  const bounds = detail?.explicitBounds;
  const out: Record<string, unknown> = {
    attributes: keyValues(withCorrelation(point.attributes, point)),
    timeUnixNano: point.timeUnixNano.toString(),
    count: counted(numberOf(detail, 'count')),
    sum: point.value,
    bucketCounts: Array.isArray(counts) ? counts.map(counted) : [],
    explicitBounds: Array.isArray(bounds) ? bounds : [],
  };
  if (point.startTimeUnixNano !== null) out.startTimeUnixNano = point.startTimeUnixNano.toString();
  const min = numberOf(detail, 'min');
  const max = numberOf(detail, 'max');
  if (min !== undefined) out.min = min;
  if (max !== undefined) out.max = max;
  return out;
}

/** The points of one resource grouped under the metric they belong to (name, unit and kind). */
function metricsJson(points: readonly TelemetryMetricPoint[]): Record<string, unknown>[] {
  const metrics = new Map<string, { head: Record<string, unknown>; points: unknown[] }>();
  for (const point of points) {
    const temporality = point.kind === 'gauge' ? 0 : temporalityOf(point);
    const monotonic = point.kind === 'sum' ? monotonicOf(point) : false;
    const key = JSON.stringify([point.name, point.unit, point.kind, temporality, monotonic]);
    let group = metrics.get(key);
    if (group === undefined) {
      const head: Record<string, unknown> = { name: point.name };
      if (point.unit !== null) head.unit = point.unit;
      group = { head, points: [] };
      metrics.set(key, group);
      if (point.kind === 'gauge') head.gauge = { dataPoints: group.points };
      else if (point.kind === 'sum') {
        head.sum = {
          dataPoints: group.points,
          aggregationTemporality: temporality,
          isMonotonic: monotonic,
        };
      } else {
        head.histogram = { dataPoints: group.points, aggregationTemporality: temporality };
      }
    }
    group.points.push(point.kind === 'histogram' ? histogramPoint(point) : numberPoint(point));
  }
  return [...metrics.values()].map((group) => group.head);
}

function logJson(record: TelemetryLogRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    timeUnixNano: record.timeUnixNano.toString(),
    attributes: keyValues(withCorrelation(record.attributes, record)),
  };
  if (record.severity !== null) out.severityNumber = record.severity;
  if (record.severityText !== null) out.severityText = record.severityText;
  if (record.body !== null) out.body = { stringValue: record.body };
  if (record.traceId !== null) out.traceId = record.traceId;
  if (record.spanId !== null) out.spanId = record.spanId;
  return out;
}

/** What each signal's request is made of. */
export interface OtlpRecords {
  readonly traces: readonly TelemetrySpan[];
  readonly metrics: readonly TelemetryMetricPoint[];
  readonly logs: readonly TelemetryLogRecord[];
}

/** The path each signal is POSTed to, after the base of the endpoint (OTLP/HTTP). */
export const OTLP_PATH: Readonly<Record<OtlpSignal, string>> = {
  traces: '/v1/traces',
  metrics: '/v1/metrics',
  logs: '/v1/logs',
};

/**
 * The body of an OTLP/HTTP JSON request for `records` of one signal. The caller sends it as
 * `application/json`; an empty list is a valid, empty request (the caller sends none).
 */
export function encodeOtlp<S extends OtlpSignal>(
  signal: S,
  records: OtlpRecords[S],
): Record<string, unknown> {
  const resourceOf = (resource: TelemetryAttributes): Record<string, unknown> => ({
    attributes: keyValues(resource),
  });
  if (signal === 'traces') {
    return {
      resourceSpans: byResource(records as readonly TelemetrySpan[]).map((group) => ({
        resource: resourceOf(group.resource),
        scopeSpans: [{ scope: EXPORT_SCOPE, spans: group.records.map(spanJson) }],
      })),
    };
  }
  if (signal === 'metrics') {
    return {
      resourceMetrics: byResource(records as readonly TelemetryMetricPoint[]).map((group) => ({
        resource: resourceOf(group.resource),
        scopeMetrics: [{ scope: EXPORT_SCOPE, metrics: metricsJson(group.records) }],
      })),
    };
  }
  return {
    resourceLogs: byResource(records as readonly TelemetryLogRecord[]).map((group) => ({
      resource: resourceOf(group.resource),
      scopeLogs: [{ scope: EXPORT_SCOPE, logRecords: group.records.map(logJson) }],
    })),
  };
}
