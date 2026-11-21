// SPDX-License-Identifier: MPL-2.0

/**
 * The Prometheus text exposition format, version 0.0.4 (Phase 8, P7; N70, N211 and N218), written
 * with code of our own: no `prom-client`. [S: prometheus.io/docs/instrumenting/exposition_formats,
 * "Text format details"]
 *
 * What the format asks, and what is done here:
 * - one `# HELP` and one `# TYPE` line per family, before its samples; the HELP text escapes `\` and
 *   the line feed;
 * - a sample is `name{label="value",...} value`, with the label values escaped (`\`, `"` and the
 *   line feed) and the labels in a fixed order (the order the family names them);
 * - the value is a Go-parsable float: `NaN`, `+Inf` and `-Inf` are spelled as the format spells them;
 * - lines end with a line feed, and the body ends with one;
 * - the names are checked (`[a-zA-Z_:][a-zA-Z0-9_:]*` for a metric, `[a-zA-Z_][a-zA-Z0-9_]*` for a
 *   label, none starting with `__`): a bad name is a bug of ours, so it throws.
 */

/** The content type of the body (the version of the text format is part of it). */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export type MetricType = 'counter' | 'gauge';

export interface MetricSample {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

export interface MetricFamily {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  readonly samples: readonly MetricSample[];
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

/** The value of a label: `\`, `"` and the line feed are escaped. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\n/gu, '\\n');
}

/** The HELP text: `\` and the line feed are escaped. */
export function escapeHelp(text: string): string {
  return text.replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n');
}

/** A sample value as the text format spells it. */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return '+Inf';
  if (value === Number.NEGATIVE_INFINITY) return '-Inf';
  return String(value);
}

function labelsText(labels: Readonly<Record<string, string>>): string {
  const names = Object.keys(labels);
  if (names.length === 0) return '';
  const pairs = names.map((name) => {
    if (!LABEL_NAME.test(name) || name.startsWith('__')) {
      throw new TypeError(`'${name}' is not a valid Prometheus label name`);
    }
    return `${name}="${escapeLabelValue(labels[name] ?? '')}"`;
  });
  return `{${pairs.join(',')}}`;
}

/** The families as the body of a scrape. */
export function renderPrometheus(families: readonly MetricFamily[]): string {
  const lines: string[] = [];
  for (const family of families) {
    if (!METRIC_NAME.test(family.name)) {
      throw new TypeError(`'${family.name}' is not a valid Prometheus metric name`);
    }
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      lines.push(`${family.name}${labelsText(sample.labels)} ${formatValue(sample.value)}`);
    }
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
