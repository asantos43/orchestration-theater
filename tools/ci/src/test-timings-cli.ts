#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { TIMINGS_FILE, type TimingsFile } from './duration-shard.js';
import { mergeTimings, parseVitestLog } from './test-timings.js';

/**
 * `node tools/ci/dist/test-timings-cli.js --platform <linux|darwin|win32> [--out <file>] <log>...`:
 * reads the vitest logs of CI jobs of one system and writes their durations into the file of
 * durations (default tools/ci/test-timings.json), keeping the other systems. Exit 2 on error.
 */
function main(argv: readonly string[]): void {
  const at = argv.indexOf('--platform');
  const platform = at >= 0 ? (argv[at + 1] ?? '') : '';
  if (!['linux', 'darwin', 'win32'].includes(platform)) {
    throw new Error('--platform needs linux, darwin or win32');
  }
  const outAt = argv.indexOf('--out');
  const out = outAt >= 0 ? (argv[outAt + 1] ?? '') : TIMINGS_FILE;
  if (out === '') throw new Error('--out needs a file');
  const skip = new Set([at, at + 1, ...(outAt >= 0 ? [outAt, outAt + 1] : [])]);
  const logs = argv.filter((_, i) => !skip.has(i));
  if (logs.length === 0) throw new Error('no log given');
  const measured = new Map<string, number>();
  for (const log of logs) {
    for (const [file, ms] of parseVitestLog(readFileSync(log, 'utf8'))) {
      measured.set(file, Math.max(ms, measured.get(file) ?? 0));
    }
  }
  if (measured.size === 0) throw new Error('the logs name no test file with a duration');
  const previous = existsSync(out)
    ? (JSON.parse(readFileSync(out, 'utf8')) as TimingsFile)
    : undefined;
  writeFileSync(out, `${JSON.stringify(mergeTimings(previous, platform, measured), null, 2)}\n`);
  process.stdout.write(`test-timings: ${String(measured.size)} file(s) of ${platform} in ${out}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`test-timings: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
