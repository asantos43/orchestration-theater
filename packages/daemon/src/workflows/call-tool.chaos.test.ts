// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRASHPOINT_LINE } from '../chaos/crash-points.js';
import { WORKFLOW_CHILD_SCRIPT } from './workflow-chaos-child-fixture.js';

/**
 * The `kill -9` acceptance of the workflow runtime (Phase 11b, P2; docs/26): a process runs a
 * workflow with one `call_tool` that changes the world, kills itself with `SIGKILL` at a point of the
 * effect journal (`chaos/crash-points.ts`), and another process over the same on-disk store resumes
 * the run. Whatever the point, the world ends with the effect exactly once and the run is `done`.
 * Runs over the build output (`pnpm build` first) and is part of `pnpm test:chaos`.
 */

const DAEMON_DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const STORE_MODULE = pathToFileURL(
  fileURLToPath(new URL('../../../adapters/store-sqlite/dist/index.js', import.meta.url)),
).href;

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

let dir = '';
beforeAll(() => {
  if (!existsSync(join(DAEMON_DIST, 'workflows', 'runtime.js'))) {
    throw new Error('The daemon is not built: run "pnpm build" before the chaos tests');
  }
  dir = mkdtempSync(join(tmpdir(), 'ot-wf-chaos-'));
  writeFileSync(join(dir, 'child.mjs'), WORKFLOW_CHILD_SCRIPT);
});
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

function runChild(run: string, mode: 'first' | 'resume', crashPoint?: string): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, 'child.mjs')], {
      env: {
        PATH: process.env.PATH ?? '',
        OT_CHILD_MODE: mode,
        OT_CHILD_DB: join(dir, run, 'store.db'),
        OT_CHILD_WORLD: join(dir, `${run}.world`),
        OT_CHILD_DAEMON_DIST: DAEMON_DIST,
        OT_CHILD_STORE_MODULE: STORE_MODULE,
        ...(crashPoint === undefined ? {} : { OT_CHILD_CRASH_POINT: crashPoint }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`The child did not end in time.\n${stdout}\n${stderr}`));
    }, 60_000);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

const worldOf = (run: string): string[] => {
  const path = join(dir, `${run}.world`);
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
    : [];
};

describe('call_tool killed with SIGKILL', () => {
  const CASES: readonly { point: string; wrote: boolean }[] = [
    { point: 'effects.after_intend', wrote: false },
    { point: 'effects.after_execute', wrote: true },
    { point: 'effects.after_resolve', wrote: true },
  ];

  for (const { point, wrote } of CASES) {
    it(`at ${point}: the restart finishes the run and the effect happened once`, async () => {
      const run = point.replace('.', '-');
      const killed = await runChild(run, 'first', point);
      expect(killed.signal).toBe('SIGKILL');
      expect(killed.stdout).toContain(`${CRASHPOINT_LINE}{"point":"${point}"`);
      expect(worldOf(run)).toEqual(wrote ? ['doc-9'] : []);

      const resumed = await runChild(run, 'resume');
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain('RESUMED {"resumed":["run-1"],"refused":[]}');
      expect(resumed.stdout).toContain('FINAL done');
      expect(worldOf(run)).toEqual(['doc-9']);

      // A third start finds nothing open and changes nothing.
      const again = await runChild(run, 'resume');
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toContain('RESUMED {"resumed":[],"refused":[]}');
      expect(worldOf(run)).toEqual(['doc-9']);
    });
  }

  it('with no kill the same program ends the run in one process', async () => {
    const first = await runChild('plain', 'first');
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain('FINAL done');
    expect(worldOf('plain')).toEqual(['doc-9']);
  });
});
