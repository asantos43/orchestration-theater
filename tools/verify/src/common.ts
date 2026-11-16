// SPDX-License-Identifier: MPL-2.0
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Usage or environment error: the CLI exits with code 2 (not 1, which means "verification failed"). */
export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export type Severity = 'error' | 'warning';

export interface Finding {
  severity: Severity;
  /** File, package or key the finding is about. */
  subject: string;
  message: string;
}

export interface CheckResult {
  /** One line per summary item (counts, totals). */
  summary: string[];
  findings: Finding[];
}

export function hasErrors(result: CheckResult): boolean {
  return result.findings.some((f) => f.severity === 'error');
}

export function renderResult(title: string, result: CheckResult): string {
  const lines: string[] = [title];
  for (const line of result.summary) lines.push(`  ${line}`);
  for (const f of result.findings) {
    lines.push(`${f.severity === 'error' ? 'ERROR' : 'WARNING'} ${f.subject}: ${f.message}`);
  }
  const errors = result.findings.filter((f) => f.severity === 'error').length;
  const warnings = result.findings.length - errors;
  lines.push(
    errors > 0
      ? `FAILED: ${String(errors)} error(s), ${String(warnings)} warning(s).`
      : `OK (${String(warnings)} warning(s)).`,
  );
  return lines.join('\n');
}

// ---------- JSON guards ----------

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function fail(where: string, message: string): never {
  throw new UsageError(`${where}: ${message}`);
}

export function requireRecord(value: unknown, where: string): JsonRecord {
  if (!isRecord(value)) fail(where, 'expected an object');
  return value;
}

export function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(where, 'expected an array');
  return value as unknown[];
}

export function requireString(rec: JsonRecord, key: string, where: string): string {
  const value = rec[key];
  if (typeof value !== 'string' || value === '') {
    fail(where, `"${key}" must be a non-empty string`);
  }
  return value;
}

export function optionalString(rec: JsonRecord, key: string, where: string): string | undefined {
  const value = rec[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(where, `"${key}" must be a string`);
  return value;
}

export function requireStringArray(value: unknown, where: string): string[] {
  const items = requireArray(value, where);
  return items.map((item, i) => {
    if (typeof item !== 'string') fail(`${where}[${String(i)}]`, 'expected a string');
    return item;
  });
}

// ---------- process execution ----------

/** Runs a program without a shell and returns stdout. Injectable so tests never spawn processes. */
export type ExecFn = (
  file: string,
  args: readonly string[],
  options: { cwd: string },
) => Promise<string>;

const execFileAsync = promisify(execFile);

export const defaultExec: ExecFn = async (file, args, options) => {
  try {
    const { stdout } = await execFileAsync(file, [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UsageError(`could not run "${file} ${args.join(' ')}": ${detail}`);
  }
};

// ---------- paths ----------

/** Repository-relative path with forward slashes. */
export function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/** Code-unit comparison: deterministic regardless of the machine locale. */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
