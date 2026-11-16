// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isRecord, requireArray, requireRecord, UsageError } from './common.js';

export interface CruiseOptions {
  /** Repository root: where dependency-cruiser is installed and where the default config lives. */
  root: string;
  /** Directory the cruise runs in (rule paths are relative to it). */
  cwd: string;
  /** Config file path, absolute or relative to `cwd`. */
  config: string;
  targets: readonly string[];
  outputType: 'err' | 'json';
}

export interface CruiseResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Violation {
  rule: string;
  from: string;
  to: string;
}

export const DEFAULT_CONFIG = '.dependency-cruiser.js';
export const DEFAULT_TARGETS: readonly string[] = ['packages'];

export function runCruiser(options: CruiseOptions): Promise<CruiseResult> {
  const bin = path.join(
    options.root,
    'node_modules',
    'dependency-cruiser',
    'bin',
    'dependency-cruiser.mjs',
  );
  if (!existsSync(bin)) {
    return Promise.reject(
      new UsageError('dependency-cruiser is not installed (run "pnpm install")'),
    );
  }
  const args = [
    bin,
    ...options.targets,
    '--config',
    options.config,
    '--output-type',
    options.outputType,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      reject(new UsageError(`could not start dependency-cruiser: ${error.message}`));
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 2, stdout, stderr });
    });
  });
}

/** Extracts the violations from `--output-type json`. */
export function parseViolations(json: string): Violation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new UsageError('dependency-cruiser did not produce JSON');
  }
  const summary = requireRecord(
    requireRecord(parsed, 'dependency-cruiser output').summary,
    'summary',
  );
  return requireArray(summary.violations, 'summary.violations').map((item) => {
    const rec = requireRecord(item, 'violation');
    const rule = rec.rule;
    return {
      rule: isRecord(rule) && typeof rule.name === 'string' ? rule.name : '?',
      from: typeof rec.from === 'string' ? rec.from : '?',
      to: typeof rec.to === 'string' ? rec.to : '?',
    };
  });
}
