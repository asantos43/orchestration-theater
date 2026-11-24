// SPDX-License-Identifier: MPL-2.0
// Shards of the tests by duration (CI under 10 min, owner, 2026-11-24).
//
// `vitest --shard=<i>/<N>` sorts the files by the hash of their path and cuts the list by count, so a
// shard can get most of the long e2e files: on the macOS runner of PR #333 the four shards ran
// 369 s, 468 s and less, from the same list. This sequencer keeps the `--shard` flag and replaces how
// the files are split: by the durations measured in CI (tools/ci/test-timings.json, per system),
// the longest file first into the shard with the least time so far (LPT). Every job of a matrix
// sees the same list and the same file of durations, so the shards cover the list exactly once.
//
// OT_TEST_SHARD_MODE picks the split: `duration` (default) or `hash` (the vitest one).
// A file with no measure weighs the median of the measured ones. The durations come from the logs
// of the CI (tools/ci/update-test-timings.sh): they are a guide to balance, not a test result, and
// an old file of durations only makes the shards less even.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

export type ShardMode = 'duration' | 'hash';

export const TIMINGS_FILE = path.join(import.meta.dirname, '..', 'test-timings.json');

export function shardMode(env: NodeJS.ProcessEnv = process.env): ShardMode {
  const raw = env.OT_TEST_SHARD_MODE ?? '';
  if (raw === '' || raw === 'duration') return 'duration';
  if (raw === 'hash') return 'hash';
  throw new Error(`OT_TEST_SHARD_MODE=${raw}: use duration or hash`);
}

/** Durations in ms by path relative to the root (with `/`), for one system. */
export type Timings = ReadonlyMap<string, number>;

export interface TimingsFile {
  readonly version: 1;
  /** By `process.platform` (linux, darwin, win32), then by file. */
  readonly platforms: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export function parseTimings(text: string, platform: string): Timings {
  const data = JSON.parse(text) as { version?: unknown; platforms?: unknown } | null;
  if (data?.version !== 1 || typeof data.platforms !== 'object' || data.platforms === null) {
    throw new Error('test-timings.json: expected { "version": 1, "platforms": { ... } }');
  }
  const platforms = data.platforms as Partial<Record<string, Readonly<Record<string, unknown>>>>;
  // A system with no measures borrows linux: the proportions between the files are what matters.
  const files = platforms[platform] ?? platforms.linux ?? {};
  const timings = new Map<string, number>();
  for (const [file, ms] of Object.entries(files)) {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) timings.set(file, ms);
  }
  return timings;
}

export function loadTimings(file = TIMINGS_FILE, platform: string = process.platform): Timings {
  try {
    return parseTimings(readFileSync(file, 'utf8'), platform);
  } catch (error) {
    // Without the file every file weighs the same and the split is still exact, only less even.
    console.warn(
      `duration-shard: ${file}: ${(error as Error).message}; every file weighs the same`,
    );
    return new Map();
  }
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 1)
    : ((sorted[middle - 1] ?? 1) + (sorted[middle] ?? 1)) / 2;
}

/**
 * Splits the keys among `count` shards, the longest first into the least loaded shard (ties: the
 * key, then the lowest shard). Deterministic: the same keys and timings give the same shards.
 */
export function balance(keys: readonly string[], timings: Timings, count: number): string[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`balance: count ${String(count)}`);
  const fallback = median([...timings.values()]);
  const weighted = [...new Set(keys)]
    .map((key) => ({ key, ms: timings.get(key) ?? fallback }))
    .sort((a, b) => b.ms - a.ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ load: 0, keys: [] as string[] }));
  for (const { key, ms } of weighted) {
    let target = shards[0];
    for (const shard of shards)
      if (target === undefined || shard.load < target.load) target = shard;
    if (target === undefined) break;
    target.keys.push(key);
    target.load += ms;
  }
  return shards.map((shard) => shard.keys);
}

/** The path of a test file relative to the root, with `/`, as test-timings.json keeps it. */
export function timingKey(root: string, moduleId: string): string {
  return path.relative(root, moduleId).split(path.sep).join('/');
}

export class DurationShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    if (shardMode() === 'hash' || config.shard === undefined) return super.shard(files);
    const { index, count } = config.shard;
    const key = (spec: TestSpecification) => timingKey(config.root, spec.moduleId);
    const mine = new Set(balance(files.map(key), loadTimings(), count)[index - 1] ?? []);
    return files.filter((spec) => mine.has(key(spec)));
  }
}
