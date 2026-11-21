// SPDX-License-Identifier: MPL-2.0
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  otelEndpoint,
  otelHeaders,
  otelResourceAttributes,
  otelSignalUrl,
  type ClientOtel,
  type OtelSignal,
} from '@otheater/core';

/** Where the wrapper goes inside a profile directory (the profile is OTheater's, never `~/.codex`). */
export const CODEX_OTEL_WRAPPER_DIR = '.otheater';
export const CODEX_OTEL_WRAPPER_FILE = 'codex-otel.sh';

/** Environment variable that carries the real `codex` to the wrapper. */
export const OTEL_REAL_ENV = 'OTHEATER_CODEX_REAL';
/** Environment variable that carries the `-c` values (one per line) to the wrapper. */
export const OTEL_SETTINGS_ENV = 'OTHEATER_CODEX_OTEL';

/**
 * The wrapper `codex-acp` runs instead of `codex` (`CODEX_PATH`). Codex reads `[otel]` only at the
 * start of `codex app-server`, from `config.toml` or `-c`; the `CODEX_CONFIG` of the adapter goes to
 * each thread and exports nothing [V: Phase 0 spike, `spikes/otel/README.md`]. The script is the
 * same for every launch and holds no secret: the settings come in the environment, one `key=value`
 * per line, and become `-c` arguments before the ones `codex-acp` passes (`app-server ...`).
 */
export const CODEX_OTEL_WRAPPER = [
  '#!/bin/sh',
  '# Written by OTheater. Starts the real codex with the otel settings the daemon put in the environment.',
  'set -f',
  `real="\${${OTEL_REAL_ENV}:-codex}"`,
  `if [ -n "\${${OTEL_SETTINGS_ENV}:-}" ]; then`,
  '  old_ifs=$IFS',
  "  IFS='",
  "'",
  `  for setting in $${OTEL_SETTINGS_ENV}; do`,
  '    set -- -c "$setting" "$@"',
  '  done',
  '  IFS=$old_ifs',
  'fi',
  'exec "$real" "$@"',
  '',
].join('\n');

/** A TOML basic string. The inputs are already free of control characters (`otelHeaders`, `otelEndpoint`). */
function toml(text: string): string {
  return JSON.stringify(text);
}

function exporter(otel: ClientOtel, signal: OtelSignal): string {
  const headers = Object.keys(otel.headers)
    .sort()
    .map((name) => `${toml(name)}=${toml(otel.headers[name] ?? '')}`)
    .join(',');
  const table = headers === '' ? '' : `,headers={${headers}}`;
  return `{otlp-http={endpoint=${toml(otelSignalUrl(otel.endpoint, signal))},protocol="json"${table}}}`;
}

/**
 * The `-c` values (`key=value`, TOML) of the `[otel]` table: logs and metrics always, traces only
 * with `otel.traces`. The form is the one the Phase 0 spike ran [V]; `headers` is the documented
 * table of the OTLP exporter and was not run against a receiver that checks it [N].
 */
export function codexOtelSettings(otel: ClientOtel): string[] {
  // Validates what the environment will carry too, so a bad id fails here and not in the client.
  otelEndpoint(otel.endpoint);
  otelResourceAttributes(otel.resource);
  otelHeaders(otel.headers);
  return [
    'otel.environment="otheater"',
    `otel.exporter=${exporter(otel, 'logs')}`,
    `otel.metrics_exporter=${exporter(otel, 'metrics')}`,
    ...(otel.traces === true ? [`otel.trace_exporter=${exporter(otel, 'traces')}`] : []),
  ];
}

/** Writes the wrapper in the profile directory when it is not there as it should be; returns its path. */
export async function ensureCodexOtelWrapper(profileDir: string): Promise<string> {
  const dir = join(profileDir, CODEX_OTEL_WRAPPER_DIR);
  const file = join(dir, CODEX_OTEL_WRAPPER_FILE);
  const current = await readFile(file, 'utf8').catch(() => undefined);
  if (current !== CODEX_OTEL_WRAPPER) {
    await mkdir(dir, { recursive: true });
    await writeFile(file, CODEX_OTEL_WRAPPER, { mode: 0o755 });
  }
  await chmod(file, 0o755);
  return file;
}

/** What the title of a session is when the setup sets one: no model call to write it. */
export function codexOtelTitle(otel: ClientOtel): string {
  const id = otel.resource['otheater.attempt_id'] ?? otel.resource['otheater.session_id'];
  return id === undefined ? 'OTheater' : `OTheater ${id}`;
}
