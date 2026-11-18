// SPDX-License-Identifier: MPL-2.0
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A fake `ccusage` for tests: a Node script that prints fixed text, so no real tool and no real
 * log of any client is ever involved. The behavior is in a JSON file beside the script, and every
 * run appends its arguments, working folder and the directory variables it saw to `calls.jsonl`,
 * so a test can check that the environment was always the built one.
 */
export interface FakeCcusageConfig {
  /** What `--version` prints. */
  readonly version?: string;
  /** What `<sub> daily ...` prints on stdout, by sub-command (`claude`, `codex`, `opencode`). */
  readonly outputs?: Readonly<Record<string, string>>;
  /** Exit code of the `daily` runs (default 0). */
  readonly exitCode?: number;
  /** Text printed on stderr by a failing run (must never reach an error message). */
  readonly stderr?: string;
  /** Wait this long before answering a `daily` run, in ms (for the timeout test). */
  readonly sleepMs?: number;
}

export interface FakeCall {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const SCRIPT = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const here = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(here, 'fake-ccusage.json'), 'utf8'));
const argv = process.argv.slice(2);
const names = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_DATA_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'NO_COLOR'];
const env = {};
for (const name of names) env[name] = process.env[name];
fs.appendFileSync(path.join(here, 'calls.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), env }) + '\\n');
if (argv[0] === '--version') {
  process.stdout.write((config.version ?? '') + '\\n');
  process.exit(0);
}
const finish = () => {
  if (config.exitCode) {
    process.stderr.write(config.stderr ?? '');
    process.exit(config.exitCode);
  }
  process.stdout.write((config.outputs ?? {})[argv[0]] ?? '');
  process.exit(0);
};
if (config.sleepMs) setTimeout(finish, config.sleepMs); else finish();
`;

/** Writes the fake into `dir` and returns the absolute path of the executable. */
export function writeFakeCcusage(dir: string, config: FakeCcusageConfig): string {
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'ccusage');
  writeFileSync(script, SCRIPT, { mode: 0o755 });
  chmodSync(script, 0o755);
  writeFileSync(join(dir, 'fake-ccusage.json'), JSON.stringify(config));
  return script;
}

/** Rewrites the behavior of a fake already written into `dir`. */
export function reconfigureFakeCcusage(dir: string, config: FakeCcusageConfig): void {
  writeFileSync(join(dir, 'fake-ccusage.json'), JSON.stringify(config));
}

/** The runs the fake in `dir` has seen, in order. */
export function fakeCalls(dir: string): FakeCall[] {
  let text: string;
  try {
    text = readFileSync(join(dir, 'calls.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as FakeCall);
}

/** A `daily` output in the shape the parser knows, for tests ([N]: see `parse.ts`). */
export function dailyJson(
  days: readonly {
    date: string;
    models: readonly {
      name: string;
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: number;
    }[];
  }[],
): string {
  return JSON.stringify({
    daily: days.map((day) => ({
      date: day.date,
      inputTokens: day.models.reduce((sum, m) => sum + m.input, 0),
      outputTokens: day.models.reduce((sum, m) => sum + m.output, 0),
      totalCost: day.models.reduce((sum, m) => sum + (m.cost ?? 0), 0),
      modelBreakdowns: day.models.map((m) => ({
        modelName: m.name,
        inputTokens: m.input,
        outputTokens: m.output,
        cacheReadTokens: m.cacheRead ?? 0,
        cacheCreationTokens: m.cacheWrite ?? 0,
        cost: m.cost ?? 0,
      })),
    })),
  });
}
