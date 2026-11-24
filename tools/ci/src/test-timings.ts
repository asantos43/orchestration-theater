// SPDX-License-Identifier: MPL-2.0
// The durations of the test files, read from the logs of the CI, for the shards by duration
// (duration-shard.ts). tools/ci/update-test-timings.sh downloads the logs of a run and calls the
// CLI (test-timings-cli.ts), which rewrites tools/ci/test-timings.json.
import type { TimingsFile } from './duration-shard.js';

// A file line of the default reporter of vitest: `✓  packages  packages/a/src/x.test.ts (12 tests) 1234ms`,
// also `❯` (a failure inside) and `×`, with or without the project, with a time in ms or s.
const FILE_LINE =
  /^\s*[✓❯×↓]\s+(?:\S+\s+)?(\S+\.test\.tsx?)\s+\(\d+ tests?[^)]*\)\s+(\d+(?:\.\d+)?)(ms|s)\s*$/u;

/** The duration in ms of every test file a vitest log names (the longest, if one repeats). */
export function parseVitestLog(text: string): Map<string, number> {
  const timings = new Map<string, number>();
  for (const line of text.split(/\r?\n/u)) {
    const match = FILE_LINE.exec(line);
    if (match === null) continue;
    const [, file = '', amount = '0', unit = 'ms'] = match;
    const ms = Math.round(Number(amount) * (unit === 's' ? 1000 : 1));
    const key = file.replaceAll('\\', '/');
    timings.set(key, Math.max(ms, timings.get(key) ?? 0));
  }
  return timings;
}

/**
 * The file of durations with the measures of one system replaced: a file measured now takes the
 * new value, a file not in the logs keeps the old one (it ran in no job of this run, or was removed:
 * a removed file only weighs nothing, because no job lists it).
 */
export function mergeTimings(
  previous: TimingsFile | undefined,
  platform: string,
  measured: ReadonlyMap<string, number>,
): TimingsFile {
  const platforms: Record<string, Record<string, number>> = {};
  for (const [name, files] of Object.entries(previous?.platforms ?? {})) {
    platforms[name] = { ...files };
  }
  const files = { ...(platforms[platform] ?? {}) };
  for (const [file, ms] of measured) files[file] = ms;
  platforms[platform] = Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const sorted = Object.fromEntries(
    Object.entries(platforms).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return { version: 1, platforms: sorted };
}
