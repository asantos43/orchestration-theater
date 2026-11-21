// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '../errors.js';

/**
 * Where a client sends its own telemetry and how the daemon tells the data apart (Phase 8, P3,
 * N213; architecture 5.11). The daemon hands it to `openSession`/`launchSpec`; the adapter turns it
 * into the environment variables, process arguments and session settings of its client, never
 * into a file in the configuration folder of the person. Without it a client starts exactly as
 * before and receives no `OTEL_*` variable. [proposta] Additive, without a new port version: a
 * descendant that ignored it would only leave the client without telemetry.
 */
export interface ClientOtel {
  /**
   * Base URL of the OTLP/HTTP receiver, without the signal path (`http://127.0.0.1:4318`). The
   * client appends `/v1/<signal>`. Loopback by design: the daemon never opens it to the network.
   */
  readonly endpoint: string;
  /** HTTP headers of every export; the receiver token goes here (`Authorization`). */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * OTLP resource attributes that correlate the data with the daemon (`otheater.play_id`,
   * `otheater.stage_id`, `otheater.attempt_id`, `otheater.session_id`, `otheater.profile`,
   * `otheater.client`). Keys and values cannot hold a comma, an equals sign, a space or a control
   * character: they travel in `OTEL_RESOURCE_ATTRIBUTES` (`k=v,k=v`), and a safe id never needs one.
   */
  readonly resource: Readonly<Record<string, string>>;
  /**
   * Default off: the client exports metrics and logs only. On: also its traces (Claude Code:
   * `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` and `OTEL_TRACES_EXPORTER`; Codex: `otel.trace_exporter`;
   * OpenCode has no switch for it). (`telemetry.clients.claude-code.traces`.)
   */
  readonly traces?: boolean;
  /**
   * Default off. OpenCode: turns on `experimental.openTelemetry` (the AI SDK spans, with prompt and
   * response in clear text, which the receiver must redact). (`telemetry.clients.opencode.ai_spans`.)
   */
  readonly experimental?: boolean;
}

/** The three OTLP signals. */
export type OtelSignal = 'traces' | 'metrics' | 'logs';

// eslint-disable-next-line no-control-regex -- the point of the check is to refuse control characters
const CONTROL = /[\u0000-\u001f\u007f]/u;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;

/** Checks the endpoint and returns it without the trailing slash. `InvalidInput` when it is not an http(s) URL. */
export function otelEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidInput('otel.endpoint is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidInput('otel.endpoint must be http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidInput('otel.endpoint carries no credential: the token goes in the headers');
  }
  return endpoint.replace(/\/+$/u, '');
}

/** `<endpoint>/v1/<signal>`, the address a client posts one signal to. */
export function otelSignalUrl(endpoint: string, signal: OtelSignal): string {
  return `${otelEndpoint(endpoint)}/v1/${signal}`;
}

/**
 * The value of `OTEL_RESOURCE_ATTRIBUTES`: `k=v,k=v`, sorted by key so the same set always gives
 * the same text (the key of a shared process is built from the environment). `InvalidInput` for a
 * key or value the format cannot carry; the error names the key, never the value.
 */
export function otelResourceAttributes(resource: Readonly<Record<string, string>>): string {
  return Object.keys(resource)
    .sort()
    .map((key) => {
      const value = resource[key] ?? '';
      if (key === '' || /[,=\s]/u.test(key) || CONTROL.test(key)) {
        throw new InvalidInput('otel.resource has a key the OTLP resource format cannot carry');
      }
      if (value === '' || /[,=\s]/u.test(value) || CONTROL.test(value)) {
        throw new InvalidInput(`otel.resource["${key}"] is empty or holds a , = space or control`);
      }
      return `${key}=${value}`;
    })
    .join(',');
}

/**
 * The value of `OTEL_EXPORTER_OTLP_HEADERS`: `k=v,k=v`, sorted by key. A value keeps its spaces
 * (`Bearer <token>`) and is not percent-encoded [N: the encoding the clients expect was not
 * checked against a real receiver; a token made of URL-safe characters needs none]. `InvalidInput`
 * for a name that is not an HTTP token or a value with a comma or a control character.
 */
export function otelHeaders(headers: Readonly<Record<string, string>>): string {
  return Object.keys(headers)
    .sort()
    .map((name) => {
      const value = headers[name] ?? '';
      if (!HEADER_NAME.test(name)) {
        throw new InvalidInput('otel.headers has a name that is not an HTTP header name');
      }
      if (value === '' || value.includes(',') || CONTROL.test(value)) {
        throw new InvalidInput(`otel.headers["${name}"] is empty or holds a comma or control`);
      }
      return `${name}=${value}`;
    })
    .join(',');
}

/**
 * The variables every OTLP client reads, the same for the three clients (Claude Code, OpenCode;
 * Codex reads the resource only). One place, so an adapter cannot forget a header or the resource.
 */
export function otelBaseEnv(otel: ClientOtel): Record<string, string> {
  const env: Record<string, string> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: otelEndpoint(otel.endpoint),
    OTEL_RESOURCE_ATTRIBUTES: otelResourceAttributes(otel.resource),
  };
  if (Object.keys(otel.headers).length > 0) {
    env.OTEL_EXPORTER_OTLP_HEADERS = otelHeaders(otel.headers);
  }
  return env;
}
