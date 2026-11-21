// SPDX-License-Identifier: MPL-2.0
import type { Generated } from 'kysely';

/**
 * Times are exact epoch nanoseconds split in two integer columns: `*_ms` (whole milliseconds) and
 * `*_sub_ns` (0 to 999999). An epoch in nanoseconds does not fit the 53 bits of a double, and
 * neither driver hands a 64-bit integer back unrounded by default; two small integers keep the
 * exact value and still index and sort by time.
 */

/** A deduplicated resource (the `resource` attributes of OTLP): one row per distinct set. */
export interface ResourcesTable {
  id: Generated<number>;
  /** SHA-256 of the canonical JSON of the attributes. */
  hash: string;
  /** JSON object, as text. */
  attributes: string;
}

/** The correlation columns every signal table carries (NULL when the receiver did not know). */
interface CorrelationColumns {
  scenario_id: string | null;
  play_id: string | null;
  attempt_id: string | null;
  session_id: string | null;
}

export interface SpansTable extends CorrelationColumns {
  id: Generated<number>;
  resource_id: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: number;
  start_ms: number;
  start_sub_ns: number;
  end_ms: number;
  end_sub_ns: number;
  status: string;
  status_message: string | null;
  attributes: string;
}

export interface MetricPointsTable extends CorrelationColumns {
  id: Generated<number>;
  resource_id: number;
  name: string;
  unit: string | null;
  kind: string;
  time_ms: number;
  time_sub_ns: number;
  start_ms: number | null;
  start_sub_ns: number | null;
  value: number;
  detail: string | null;
  attributes: string;
}

export interface LogRecordsTable extends CorrelationColumns {
  id: Generated<number>;
  resource_id: number;
  time_ms: number;
  time_sub_ns: number;
  severity: number | null;
  severity_text: string | null;
  body: string | null;
  trace_id: string | null;
  span_id: string | null;
  attributes: string;
}

/** Small facts about the file itself (`format`, `port_version`). */
export interface MetaTable {
  key: string;
  value: string;
}

/**
 * The daily aggregates of the analysis (Phase 8, P9). The key is `(day, scenario_id, executor,
 * role, metric, facet, origin)`; the dimensions are empty strings (not NULL) when unknown, so the
 * key is a real primary key. `sum`, `p50`, `p95` and `max` are NULL when no sample knew the value.
 */
export interface RollupsDailyTable {
  day: string;
  scenario_id: string;
  executor: string;
  role: string;
  metric: string;
  facet: string;
  origin: string;
  count: number;
  sum: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface TelemetryDatabase {
  resources: ResourcesTable;
  spans: SpansTable;
  metric_points: MetricPointsTable;
  log_records: LogRecordsTable;
  meta: MetaTable;
  rollups_daily: RollupsDailyTable;
}
