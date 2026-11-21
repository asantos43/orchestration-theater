// SPDX-License-Identifier: MPL-2.0
import type {
  JsonValue,
  TelemetryAttributes,
  TelemetryBatch,
  TelemetryLogRecord,
  TelemetryMetricPoint,
  TelemetrySpan,
  TelemetrySpanStatus,
} from '@otheater/core';
import { z } from 'zod';

/**
 * OTLP/HTTP in JSON (Phase 8, P2, N211; architecture 5.11): what the three clients POST to
 * `/v1/traces`, `/v1/metrics` and `/v1/logs`, read with zod and turned into the records of the
 * `TelemetryStore` port. Code of our own, with no OpenTelemetry package and no protobuf: the shape
 * is the one of the OTLP/JSON encoding [S: opentelemetry.io/docs/specs/otlp, "JSON Protobuf
 * Encoding": ids as hex, 64-bit integers as strings, enums as numbers; the names are lowerCamelCase].
 * The decoding is lenient where the encoding allows two forms (an enum as a number or as its name,
 * a time as a string or as a number) and strict where a wrong shape would make a wrong record
 * (an id that is not hex, a time that is not a number): the whole batch is then refused.
 *
 * Nothing here knows about correlation or redaction: the records come out with every correlation
 * column `null`, and the receiver fills them and removes what must not be kept.
 */

/** Deepest `arrayValue` / `kvlistValue` nesting that is read; deeper is dropped to `null`. */
const MAX_VALUE_DEPTH = 8;

const NanosSchema = z.union([z.string().regex(/^\d{1,20}$/u), z.number().nonnegative()]);

function nanos(value: string | number | undefined): bigint | null {
  if (value === undefined) return null;
  return typeof value === 'number' ? BigInt(Math.trunc(value)) : BigInt(value);
}

const AnyValueSchema = z.record(z.string(), z.unknown());
const KeyValueSchema = z.looseObject({
  key: z.string().max(512),
  value: AnyValueSchema.optional(),
});
const AttributesSchema = z.array(KeyValueSchema).optional();
const ResourceSchema = z.looseObject({ attributes: AttributesSchema }).optional();

type AnyValue = z.infer<typeof AnyValueSchema>;
type KeyValue = z.infer<typeof KeyValueSchema>;

function intOf(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
    const number = Number(value);
    // A 64-bit integer that a double cannot hold exactly is kept as text, never rounded.
    return Number.isSafeInteger(number) ? number : value;
  }
  return null;
}

/** One OTLP `AnyValue` as a JSON value. Bytes stay as the base64 text they came in. */
function anyValue(value: AnyValue | undefined, depth: number): JsonValue {
  if (value === undefined) return null;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if ('intValue' in value) return intOf(value.intValue);
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (typeof value.bytesValue === 'string') return value.bytesValue;
  if (depth >= MAX_VALUE_DEPTH) return null;
  const array = value.arrayValue;
  if (array !== null && typeof array === 'object' && 'values' in array) {
    const values = (array as { values?: unknown }).values;
    return Array.isArray(values) ? values.map((item) => anyValue(asAny(item), depth + 1)) : [];
  }
  const list = value.kvlistValue;
  if (list !== null && typeof list === 'object' && 'values' in list) {
    const values = (list as { values?: unknown }).values;
    return attributesOf(Array.isArray(values) ? (values as KeyValue[]) : undefined, depth + 1);
  }
  return null;
}

function asAny(value: unknown): AnyValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyValue)
    : undefined;
}

/** A list of `KeyValue` as an object; a repeated key keeps the last value. */
function attributesOf(list: readonly KeyValue[] | undefined, depth = 0): TelemetryAttributes {
  const out: Record<string, JsonValue> = {};
  for (const item of list ?? []) out[item.key] = anyValue(item.value, depth);
  return out;
}

const TRACE_ID = /^[0-9a-fA-F]{32}$/u;
const SPAN_ID = /^[0-9a-fA-F]{16}$/u;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

const SPAN_KINDS: Readonly<Record<string, number>> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};

const SpanSchema = z.looseObject({
  traceId: z.string().regex(TRACE_ID),
  spanId: z.string().regex(SPAN_ID),
  parentSpanId: z.string().optional(),
  name: z.string().max(1024),
  kind: z.union([z.int().min(0).max(5), z.string()]).optional(),
  startTimeUnixNano: NanosSchema,
  endTimeUnixNano: NanosSchema,
  attributes: AttributesSchema,
  status: z
    .looseObject({
      code: z.union([z.int().min(0).max(2), z.string()]).optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const TracesRequestSchema = z.looseObject({
  resourceSpans: z
    .array(
      z.looseObject({
        resource: ResourceSchema,
        scopeSpans: z.array(z.looseObject({ spans: z.array(SpanSchema).optional() })).optional(),
      }),
    )
    .optional(),
});

const NumberDataSchema = z.looseObject({
  attributes: AttributesSchema,
  startTimeUnixNano: NanosSchema.optional(),
  timeUnixNano: NanosSchema.optional(),
  asInt: z.union([z.string().regex(/^-?\d+$/u), z.number()]).optional(),
  asDouble: z.number().optional(),
});

const HistogramDataSchema = z.looseObject({
  attributes: AttributesSchema,
  startTimeUnixNano: NanosSchema.optional(),
  timeUnixNano: NanosSchema.optional(),
  count: z.union([z.string().regex(/^\d+$/u), z.number()]).optional(),
  sum: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  bucketCounts: z.array(z.union([z.string().regex(/^\d+$/u), z.number()])).optional(),
  explicitBounds: z.array(z.number()).optional(),
});

/** `AggregationTemporality`: 1 delta, 2 cumulative (a number, or the name of the enum). */
const TemporalitySchema = z.union([z.int().min(0).max(2), z.string()]);

const MetricSchema = z.looseObject({
  name: z.string().max(1024),
  unit: z.string().optional(),
  gauge: z.looseObject({ dataPoints: z.array(NumberDataSchema).optional() }).optional(),
  sum: z
    .looseObject({
      dataPoints: z.array(NumberDataSchema).optional(),
      aggregationTemporality: TemporalitySchema.optional(),
      isMonotonic: z.boolean().optional(),
    })
    .optional(),
  histogram: z
    .looseObject({
      dataPoints: z.array(HistogramDataSchema).optional(),
      aggregationTemporality: TemporalitySchema.optional(),
    })
    .optional(),
});

const MetricsRequestSchema = z.looseObject({
  resourceMetrics: z
    .array(
      z.looseObject({
        resource: ResourceSchema,
        scopeMetrics: z
          .array(z.looseObject({ metrics: z.array(MetricSchema).optional() }))
          .optional(),
      }),
    )
    .optional(),
});

const LogRecordSchema = z.looseObject({
  timeUnixNano: NanosSchema.optional(),
  observedTimeUnixNano: NanosSchema.optional(),
  severityNumber: z.union([z.int().min(0).max(24), z.string()]).optional(),
  severityText: z.string().optional(),
  body: AnyValueSchema.optional(),
  attributes: AttributesSchema,
  traceId: z.string().optional(),
  spanId: z.string().optional(),
});

const LogsRequestSchema = z.looseObject({
  resourceLogs: z
    .array(
      z.looseObject({
        resource: ResourceSchema,
        scopeLogs: z
          .array(z.looseObject({ logRecords: z.array(LogRecordSchema).optional() }))
          .optional(),
      }),
    )
    .optional(),
});

/** The number of an `AggregationTemporality`, or `undefined` when it is unset or unknown. */
function temporalityOf(value: number | string | undefined): 1 | 2 | undefined {
  if (value === 1 || value === 'AGGREGATION_TEMPORALITY_DELTA') return 1;
  if (value === 2 || value === 'AGGREGATION_TEMPORALITY_CUMULATIVE') return 2;
  return undefined;
}

/**
 * What a sum carries besides its points: its temporality and whether it only grows. [proposta] Kept
 * in `detail` (P7) so the exporter does not tell a backend that a delta counter is cumulative.
 * `null` when the request said neither.
 */
function sumDetail(
  sum:
    | { aggregationTemporality?: number | string | undefined; isMonotonic?: boolean | undefined }
    | undefined,
): Record<string, JsonValue> | null {
  const detail: Record<string, JsonValue> = {};
  const temporality = temporalityOf(sum?.aggregationTemporality);
  if (temporality !== undefined) detail.aggregationTemporality = temporality;
  if (sum?.isMonotonic !== undefined) detail.isMonotonic = sum.isMonotonic;
  return Object.keys(detail).length === 0 ? null : detail;
}

/** The OTLP signal a path names. */
export type OtlpSignal = 'traces' | 'metrics' | 'logs';

/** A body that is JSON but not an OTLP request of its signal: the receiver answers 400. */
export class OtlpDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtlpDecodeError';
  }
}

function statusOf(status: { code?: number | string | undefined } | undefined): TelemetrySpanStatus {
  const code = status?.code;
  if (code === 1 || code === 'STATUS_CODE_OK') return 'ok';
  if (code === 2 || code === 'STATUS_CODE_ERROR') return 'error';
  return 'unset';
}

function kindOf(kind: number | string | undefined): number {
  if (typeof kind === 'number') return kind;
  return (kind === undefined ? undefined : SPAN_KINDS[kind]) ?? 0;
}

function severityOf(value: number | string | undefined): number | null {
  if (typeof value === 'number') return value >= 1 ? value : null;
  return value === undefined ? null : severityByName(value);
}

const SEVERITY_BASE: Readonly<Record<string, number>> = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
};

function severityByName(name: string): number | null {
  const match = /^SEVERITY_NUMBER_([A-Z]+)(\d?)$/u.exec(name);
  const base = match?.[1] === undefined ? undefined : SEVERITY_BASE[match[1]];
  if (base === undefined) return null;
  const digit = match?.[2];
  const step = digit === undefined || digit === '' ? 0 : Number(digit) - 1;
  return base + step;
}

function bodyText(body: AnyValue | undefined): string | null {
  if (body === undefined) return null;
  const value = anyValue(body, 0);
  if (value === null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

const NO_CORRELATION = {
  scenarioId: null,
  playId: null,
  attemptId: null,
  sessionId: null,
} as const;

function parseOrThrow<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? '' : ` at ${issue.path.map(String).join('.')}`;
    throw new OtlpDecodeError(`not an OTLP request${where}`);
  }
  return parsed.data;
}

function decodeTraces(body: unknown): TelemetryBatch {
  const request = parseOrThrow(TracesRequestSchema, body);
  const spans: TelemetrySpan[] = [];
  for (const group of request.resourceSpans ?? []) {
    const resource = attributesOf(group.resource?.attributes);
    for (const scope of group.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const parent = span.parentSpanId;
        spans.push({
          ...NO_CORRELATION,
          traceId: span.traceId.toLowerCase(),
          spanId: span.spanId.toLowerCase(),
          parentSpanId:
            parent !== undefined && SPAN_ID.test(parent) && parent !== ZERO_SPAN
              ? parent.toLowerCase()
              : null,
          name: span.name,
          kind: kindOf(span.kind),
          startTimeUnixNano: nanos(span.startTimeUnixNano) ?? 0n,
          endTimeUnixNano: nanos(span.endTimeUnixNano) ?? 0n,
          status: statusOf(span.status),
          statusMessage:
            span.status?.message === undefined || span.status.message === ''
              ? null
              : span.status.message,
          attributes: attributesOf(span.attributes),
          resource,
        });
      }
    }
  }
  return { spans };
}

function decodeMetrics(body: unknown): TelemetryBatch {
  const request = parseOrThrow(MetricsRequestSchema, body);
  const metrics: TelemetryMetricPoint[] = [];
  for (const group of request.resourceMetrics ?? []) {
    const resource = attributesOf(group.resource?.attributes);
    for (const scope of group.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        const unit = metric.unit === undefined || metric.unit === '' ? null : metric.unit;
        for (const kind of ['gauge', 'sum'] as const) {
          for (const point of metric[kind]?.dataPoints ?? []) {
            const value = point.asDouble ?? (point.asInt === undefined ? 0 : Number(point.asInt));
            metrics.push({
              ...NO_CORRELATION,
              name: metric.name,
              unit,
              kind,
              timeUnixNano: nanos(point.timeUnixNano) ?? 0n,
              startTimeUnixNano: kind === 'gauge' ? null : nanos(point.startTimeUnixNano),
              value: Number.isFinite(value) ? value : 0,
              detail: kind === 'sum' ? sumDetail(metric.sum) : null,
              attributes: attributesOf(point.attributes),
              resource,
            });
          }
        }
        for (const point of metric.histogram?.dataPoints ?? []) {
          const detail: Record<string, JsonValue> = {
            count: point.count === undefined ? 0 : Number(point.count),
            bucketCounts: (point.bucketCounts ?? []).map(Number),
            explicitBounds: point.explicitBounds ?? [],
          };
          const temporality = temporalityOf(metric.histogram?.aggregationTemporality);
          if (temporality !== undefined) detail.aggregationTemporality = temporality;
          if (point.min !== undefined) detail.min = point.min;
          if (point.max !== undefined) detail.max = point.max;
          metrics.push({
            ...NO_CORRELATION,
            name: metric.name,
            unit,
            kind: 'histogram',
            timeUnixNano: nanos(point.timeUnixNano) ?? 0n,
            startTimeUnixNano: nanos(point.startTimeUnixNano),
            value: point.sum ?? 0,
            detail,
            attributes: attributesOf(point.attributes),
            resource,
          });
        }
      }
    }
  }
  return { metrics };
}

function decodeLogs(body: unknown): TelemetryBatch {
  const request = parseOrThrow(LogsRequestSchema, body);
  const logs: TelemetryLogRecord[] = [];
  for (const group of request.resourceLogs ?? []) {
    const resource = attributesOf(group.resource?.attributes);
    for (const scope of group.scopeLogs ?? []) {
      for (const record of scope.logRecords ?? []) {
        const traceId = record.traceId;
        const spanId = record.spanId;
        logs.push({
          ...NO_CORRELATION,
          timeUnixNano: nanos(record.timeUnixNano) ?? nanos(record.observedTimeUnixNano) ?? 0n,
          severity: severityOf(record.severityNumber),
          severityText:
            record.severityText === undefined || record.severityText === ''
              ? null
              : record.severityText,
          body: bodyText(record.body),
          traceId:
            traceId !== undefined && TRACE_ID.test(traceId) && traceId !== ZERO_TRACE
              ? traceId.toLowerCase()
              : null,
          spanId:
            spanId !== undefined && SPAN_ID.test(spanId) && spanId !== ZERO_SPAN
              ? spanId.toLowerCase()
              : null,
          attributes: attributesOf(record.attributes),
          resource,
        });
      }
    }
  }
  return { logs };
}

/**
 * The records of one OTLP/JSON request, with no correlation. Throws {@link OtlpDecodeError} when
 * the body is not a request of that signal. An empty request is a valid, empty batch.
 */
export function decodeOtlp(signal: OtlpSignal, body: unknown): TelemetryBatch {
  if (signal === 'traces') return decodeTraces(body);
  if (signal === 'metrics') return decodeMetrics(body);
  return decodeLogs(body);
}
