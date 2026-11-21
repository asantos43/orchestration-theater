// SPDX-License-Identifier: MPL-2.0
import { otelBaseEnv, type ClientOtel, type SessionSetup } from '@otheater/core';

/**
 * The variables that make Claude Code export its own telemetry to the daemon's receiver (Phase 8,
 * P3; architecture 5.11). Metrics and logs always; traces only with `otel.traces` (the enhanced
 * telemetry beta, which the Phase 0 spike measured). OTLP over HTTP with JSON, because the receiver
 * of the daemon speaks JSON only. The `OTEL_LOG_*` flags that put prompts, tool arguments or tool
 * results in the logs are never set: the client keeps its default (off). [V: Phase 0 spike]
 */
export function claudeOtelEnv(otel: ClientOtel): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    ...otelBaseEnv(otel),
    ...(otel.traces === true
      ? { CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1', OTEL_TRACES_EXPORTER: 'otlp' }
      : {}),
  };
}

/**
 * Puts the variables where this transport hands them to the client: ACP, in
 * `_meta.claudeCode.options.env` of `session/new` (the adapter of the client gives them to the
 * process of that session alone, so the correlation is per session [V]); headless, in the
 * environment of the process the transport starts. Nothing else of the setup changes.
 */
export function withClaudeOtel(setup: SessionSetup, otel: ClientOtel): SessionSetup {
  const env = claudeOtelEnv(otel);
  if (setup.via === 'headless') return { ...setup, env: { ...setup.env, ...env } };
  const meta = isRecord(setup.meta) ? setup.meta : {};
  const claudeCode = isRecord(meta.claudeCode) ? meta.claudeCode : {};
  const options = isRecord(claudeCode.options) ? claudeCode.options : {};
  const current = isRecord(options.env) ? options.env : {};
  return {
    ...setup,
    meta: {
      ...meta,
      claudeCode: { ...claudeCode, options: { ...options, env: { ...current, ...env } } },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
