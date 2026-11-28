// SPDX-License-Identifier: MPL-2.0
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRASHPOINT_LINE } from '../chaos/crash-points.js';
import { COMMENT_CHILD_SCRIPT } from './workflow-comment-chaos-child-fixture.js';

/**
 * The `kill -9` acceptance of the `comment` step (Phase 11b, P8; docs/26): a process runs
 * `approval -> comment`, kills itself with `SIGKILL` at a point of the effect journal in the middle
 * of the comment (after the approval was given), and another process over the same on-disk store
 * resumes the run. Whatever the point, the tracker ends with the comment exactly once and the run is
 * `done`. Without a way to list comments the restart does not guess: it ends the step as ambiguous
 * and the tracker still has at most the one comment. Runs over the build output (`tsc -b` first) and
 * is part of `pnpm test:chaos`.
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
  if (!existsSync(join(DAEMON_DIST, 'workflows', 'steps', 'codehost', 'index.js'))) {
    throw new Error('The daemon is not built: run "pnpm build" before the chaos tests');
  }
  dir = mkdtempSync(join(tmpdir(), 'ot-comment-chaos-'));
  writeFileSync(join(dir, 'child.mjs'), COMMENT_CHILD_SCRIPT);
});
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

function runChild(
  run: string,
  mode: 'first' | 'resume',
  options: { crashPoint?: string; finder?: 'off' } = {},
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, 'child.mjs')], {
      env: {
        PATH: process.env.PATH ?? '',
        OT_CHILD_MODE: mode,
        OT_CHILD_DB: join(dir, run, 'store.db'),
        OT_CHILD_WORLD: join(dir, `${run}.world`),
        OT_CHILD_DAEMON_DIST: DAEMON_DIST,
        OT_CHILD_STORE_MODULE: STORE_MODULE,
        ...(options.crashPoint === undefined ? {} : { OT_CHILD_CRASH_POINT: options.crashPoint }),
        ...(options.finder === undefined ? {} : { OT_CHILD_FINDER: options.finder }),
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

/** The comments the tracker has, in the order they were posted. */
const commentsOf = (run: string): { id: string; number: number; body: string }[] => {
  const path = join(dir, `${run}.world`);
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { id: string; number: number; body: string })
    : [];
};

describe('comment killed with SIGKILL after the approval', () => {
  const CASES: readonly { point: string; wrote: boolean }[] = [
    { point: 'effects.after_intend', wrote: false },
    { point: 'effects.after_execute', wrote: true },
    { point: 'effects.after_resolve', wrote: true },
  ];

  for (const { point, wrote } of CASES) {
    it(`at ${point}: the restart finishes the run and the comment went out once`, async () => {
      const run = point.replace('.', '-');
      const killed = await runChild(run, 'first', { crashPoint: point });
      expect(killed.signal).toBe('SIGKILL');
      expect(killed.stdout).toContain(`${CRASHPOINT_LINE}{"point":"${point}"`);
      expect(commentsOf(run)).toHaveLength(wrote ? 1 : 0);

      const resumed = await runChild(run, 'resume');
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain('RESUMED {"resumed":["run-1"],"refused":[]}');
      expect(resumed.stdout).toContain('FINAL done');
      const comments = commentsOf(run);
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({ number: 7 });
      expect(comments[0]?.body).toContain('Looks fine.');
      // When the verifier found nothing, the journal retries with the next key (`~2`).
      expect(comments[0]?.body).toMatch(/<!-- otheater-effect: run-1:say:1(~2)? -->/);

      // A third start finds nothing open and changes nothing.
      const again = await runChild(run, 'resume');
      expect(again.code, again.stderr).toBe(0);
      expect(again.stdout).toContain('RESUMED {"resumed":[],"refused":[]}');
      expect(commentsOf(run)).toHaveLength(1);
    });
  }

  it('after_execute without a way to list comments: the step ends ambiguous, never a second comment', async () => {
    const run = 'no-finder';
    const killed = await runChild(run, 'first', {
      crashPoint: 'effects.after_execute',
      finder: 'off',
    });
    expect(killed.signal).toBe('SIGKILL');
    expect(commentsOf(run)).toHaveLength(1);

    const resumed = await runChild(run, 'resume', { finder: 'off' });
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('FINAL failed');
    expect(commentsOf(run)).toHaveLength(1);
  });

  it('with no kill the same program ends the run in one process with one comment', async () => {
    const first = await runChild('plain', 'first');
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain('FINAL done');
    expect(commentsOf('plain')).toHaveLength(1);
  });
});
