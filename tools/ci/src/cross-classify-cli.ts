#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { classifyTests } from './cross-classify.js';

/**
 * `node tools/ci/dist/cross-classify-cli.js [--explain] [--root <dir>]`: reads test files (repository-relative,
 * one per line) from stdin and prints those that touch the system (see cross-classify.ts). With
 * `--explain` it prints every file with the verdict and the reason, tab separated. Exit 0 on success; on any
 * error it prints it to stderr and exits 2, and the caller (tools/ci/test-affected.sh) then runs everything.
 */
function main(argv: readonly string[]): void {
  const explain = argv.includes('--explain');
  const at = argv.indexOf('--root');
  const root = at >= 0 ? (argv[at + 1] ?? '') : process.cwd();
  if (root === '') throw new Error('--root needs a folder');
  const files = readFileSync(0, 'utf8')
    .split('\n')
    .map((line) => line.trim().replaceAll('\\', '/'))
    .filter((line) => line !== '');
  const verdicts = classifyTests(root, files);
  const lines = explain
    ? verdicts.map((v) => `${v.file}\t${v.system ? 'system' : 'skip'}\t${v.reason}`)
    : verdicts.filter((v) => v.system).map((v) => v.file);
  if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `cross-classify: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}
