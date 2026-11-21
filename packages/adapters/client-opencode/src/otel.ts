// SPDX-License-Identifier: MPL-2.0
import { otelBaseEnv, type ClientOtel } from '@otheater/core';

/** The environment variable OpenCode reads a JSON config from (merged over the files it finds). */
export const OPENCODE_CONFIG_CONTENT_ENV = 'OPENCODE_CONFIG_CONTENT';

/**
 * What makes OpenCode export its telemetry to the daemon's receiver (Phase 8, P3; architecture
 * 5.11). OpenCode reads the standard `OTEL_EXPORTER_OTLP_*` and `OTEL_RESOURCE_ATTRIBUTES`
 * variables, so the endpoint, the token and the correlation need nothing else [V: Phase 0 spike].
 * Without `experimental.openTelemetry` it exports no tokens and no model, so `otel.experimental`
 * (`telemetry.clients.opencode.ai_spans`, default off, N213) turns it on through
 * `OPENCODE_CONFIG_CONTENT`: the spans of the AI SDK then carry prompt, response and tool results
 * in clear text, and the receiver must redact them [V: spike]. Never a file of `~/.config/opencode`.
 *
 * `existing` is the `OPENCODE_CONFIG_CONTENT` the environment already has: the setting is merged
 * into it. `null` when that text is not a JSON object, which the caller reports as unavailable
 * (overwriting it would drop the configuration of whoever set it).
 */
export function opencodeOtelEnv(
  otel: ClientOtel,
  existing: string | undefined,
): Record<string, string> | null {
  const env = otelBaseEnv(otel);
  if (otel.experimental !== true) return env;
  let config: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      config = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const experimental = config.experimental;
  env[OPENCODE_CONFIG_CONTENT_ENV] = JSON.stringify({
    ...config,
    experimental: {
      ...(typeof experimental === 'object' && experimental !== null && !Array.isArray(experimental)
        ? experimental
        : {}),
      openTelemetry: true,
    },
  });
  return env;
}
