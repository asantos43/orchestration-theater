// SPDX-License-Identifier: MPL-2.0

/**
 * The modes of the export of the telemetry (Phase 8, P7; architecture 5.11, N70, N211, N218). The
 * keys are in `config.ts` (`telemetry.export`, `telemetry.otlp.*`, `telemetry.prometheus.*`); the
 * values they take are here, so the exporter and the tests read the same list. Every name beyond
 * `telemetry.export` and `telemetry.otlp.{endpoint,protocol,headers}` is [proposta].
 */

/** `telemetry.export` (N70): what leaves the daemon. Default `off`: nothing leaves, no `/metrics`. */
export const TELEMETRY_EXPORT_MODES = ['off', 'otlp', 'prometheus', 'both'] as const;
export type TelemetryExportMode = (typeof TELEMETRY_EXPORT_MODES)[number];

/** Whether the mode sends OTLP to the endpoint. */
export function exportsOtlp(mode: TelemetryExportMode): boolean {
  return mode === 'otlp' || mode === 'both';
}

/** Whether the mode serves `GET /metrics`. */
export function exportsPrometheus(mode: TelemetryExportMode): boolean {
  return mode === 'prometheus' || mode === 'both';
}

/**
 * `telemetry.otlp.protocol` (N211): only `http/json` exists. The two others are the future modes of
 * the plan; the config names them so the refusal says what they are, and refuses them [proposta]:
 * a value that parses but does nothing would let the user think a collector is being fed.
 */
export const TELEMETRY_OTLP_PROTOCOLS = ['http/json', 'http/protobuf', 'grpc'] as const;
export type TelemetryOtlpProtocol = (typeof TELEMETRY_OTLP_PROTOCOLS)[number];
export const SUPPORTED_OTLP_PROTOCOLS: readonly TelemetryOtlpProtocol[] = ['http/json'];

/** `telemetry.otlp.compression`: `none` (default) or `gzip` for the body of each request. */
export const TELEMETRY_OTLP_COMPRESSIONS = ['none', 'gzip'] as const;
export type TelemetryOtlpCompression = (typeof TELEMETRY_OTLP_COMPRESSIONS)[number];

/** `telemetry.otlp.retry.backoff`: the wait grows by doubling (`exponential`) or stays (`fixed`). */
export const TELEMETRY_RETRY_BACKOFFS = ['exponential', 'fixed'] as const;
export type TelemetryRetryBackoff = (typeof TELEMETRY_RETRY_BACKOFFS)[number];

/**
 * `telemetry.otlp.on_failure`: what happens to a batch the destination did not take after the
 * retries. `drop` (default): the batch is dropped, the exporter moves on and a warning and the event
 * `telemetry.export_failed` say so (architecture 5.11). `hold`: the cursor stays, the same batch is
 * tried again at the next turn, and nothing is lost while the base still has it.
 */
export const TELEMETRY_EXPORT_FAILURE_MODES = ['drop', 'hold'] as const;
export type TelemetryExportFailureMode = (typeof TELEMETRY_EXPORT_FAILURE_MODES)[number];

/** A header name an HTTP request may carry (RFC 9110 token). */
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
