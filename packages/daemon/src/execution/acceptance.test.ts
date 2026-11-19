// SPDX-License-Identifier: MPL-2.0
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventEnvelope } from '@otheater/core';
import { isCheckpointMessage } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import {
  editingTransport,
  editsPrompt,
  makeTempDataDir,
  TEST_POLICY,
  TEST_PROFILE,
} from '../test-helpers.js';
import { makeRepo, until } from './attempt-fixture.js';
import type { AttemptOutcome, AttemptSpec } from './attempt-runner.js';

/**
 * Acceptance of step P8 (architecture 5.2, 5.16, 5.21), offline: the daemon over the real SQLite
 * and a real git repository, with the fake client in place of the three real ones (N57: nothing
 * real runs here; the real clients are wired and exercised from P9 on).
 *
 * Four simulated Executors run at once, each in its own worktree: one streams and finishes, one
 * is cut by the timeout (WIP commit, `session/cancel`, kill, no process left), one loses its
 * process and is resumed by `session/load`, and one is running when the daemon stops and is
 * resumed by the next daemon at start.
 */

const TEST_TIMEOUT_MS = 60_000;

const CONFIG = parseConfig(`
backup:
  when: manual
limits:
  demand_timeout: 10m
resume:
  checkpoint_edit_batch: 2
  checkpoint_every: 5m
  stuck:
    no_event_for: 1h
  transient_backoff: [1s]
`);

afterAll(disposeTestGitIsolation);

function updatesOf(events: readonly EventEnvelope[], attemptId: string): readonly string[] {
  return events.filter((event) => event.attemptId === attemptId).map((event) => event.type);
}

describe('acceptance: sessions run by the daemon', () => {
  it(
    'streams, times out without orphans, resumes after a crash and after a restart',
    async () => {
      const tmp = await makeTempDataDir();
      const { repo, dispose: disposeRepo } = await makeRepo();
      const clock = new FakeClock();
      const launcher = new FakeProcessLauncher();
      const transport = new FakeSessionTransport();
      const resolver = () => ({
        profile: TEST_PROFILE,
        executor: { model: 'fake-model' },
        policy: TEST_POLICY,
      });
      // Every daemon opened here is stopped before the directory goes: on Windows an open
      // `daemon.lock` cannot be deleted, and that error would hide the one of the test.
      const opened: DaemonHandle[] = [];
      const open = (): Promise<DaemonHandle> =>
        startDaemon({
          dataDir: tmp.dir,
          config: CONFIG,
          overrides: {
            clock,
            vault: new InMemorySecretVault(),
            launcher,
            transport: editingTransport(transport),
          },
          clients: (parts) => [
            new FakeClientAdapter({
              launcher: parts.launcher,
              baseEnv: {},
              adapterVersion: '1.0.0',
              command: { cmd: 'fake-client', args: [] },
            }),
          ],
          resolveAttempt: resolver,
          logger: createSilentLogger(),
          version: '0.0.0-test',
        }).then((daemon) => {
          opened.push(daemon);
          return daemon;
        });
      const spec = (demandId: string, prompt: string, timeoutMs?: number): AttemptSpec => ({
        playId: 'play-1',
        demandId,
        attempt: 1,
        repo,
        base: 'main',
        profile: TEST_PROFILE,
        executor: { model: 'fake-model' },
        policy: TEST_POLICY,
        prompt,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });

      try {
        const daemon = await open();
        const runner = daemon.execution?.runner;
        if (runner === undefined) throw new Error('the daemon has no execution');
        const hanging = async (attemptId: string): Promise<void> =>
          until(async () => {
            const events = await daemon.store.events.readFrom(0, 10_000);
            return events.some(
              (event) =>
                event.attemptId === attemptId &&
                JSON.stringify(event.payload).includes('hanging until session/cancel'),
            );
          }, `${attemptId} to hang`);

        // Three Executors at once, in three worktrees.
        const streams = runner.run(
          spec('stream', editsPrompt({ 'stream.txt': 's\n', 'more.txt': 'm\n' }, 'one two three')),
        );
        const timed = runner.run(
          spec('timed', editsPrompt({ 'timed.txt': 'draft\n' }, '#script:hang'), 60_000),
        );
        const crashing = runner.run(
          spec('crash', editsPrompt({ 'crash.txt': 'c\n' }, '#script:hang'), 3_600_000),
        );
        await hanging('play-1/timed/1');
        await hanging('play-1/crash/1');

        // 1. The stream is in the log, one attempt after the other.
        const streamed = await streams;
        expect(streamed).toMatchObject({ state: 'completed', stopReason: 'end_turn' });
        const events = await daemon.store.events.readFrom(0, 10_000);
        const types = updatesOf(events, 'play-1/stream/1');
        expect(types[0]).toBe('session.opened');
        expect(types.filter((type) => type === 'session.update').length).toBeGreaterThanOrEqual(5);
        expect(types.at(-1)).toBe('session.closed');
        // Two completed edits made one edit-batch checkpoint.
        expect(types).toContain('attempt.checkpoint');

        // 2. The timeout: WIP commit on the attempt branch, cancel, kill, nothing left running.
        await clock.advance(60_000);
        const timedOut: AttemptOutcome = await timed;
        expect(timedOut).toMatchObject({ state: 'timed_out', cause: 'timeout' });
        expect(await testGit(timedOut.worktree, 'show', 'HEAD:timed.txt')).toBe('draft');
        expect(
          isCheckpointMessage(await testGit(timedOut.worktree, 'log', '-1', '--format=%s')),
        ).toBe(true);
        expect(await testGit(timedOut.worktree, 'rev-parse', 'HEAD')).toBe(timedOut.checkpointSha);
        // Only the process of the attempt that is still working is alive.
        expect(launcher.running).toHaveLength(1);
        expect(launcher.launched.filter((process) => process.killTreeCalls > 0)).toHaveLength(
          launcher.launched.length - 1,
        );

        // 3. The client of the third Executor dies: the conversation is reloaded (session/load).
        const crashed = launcher.running[0];
        if (crashed === undefined) throw new Error('no process to crash');
        crashed.exit(137);
        const resumed = await crashing;
        expect(resumed).toMatchObject({ state: 'completed', resumes: 1 });
        expect(transport.loaded.map((load) => load.sessionId)).toEqual([resumed.sessionId]);
        expect(updatesOf(await daemon.store.events.readFrom(0, 10_000), resumed.attemptId)).toEqual(
          expect.arrayContaining(['session.interrupted', 'session.resumed']),
        );
        expect(launcher.running).toHaveLength(0);

        // Each Executor worked in its own worktree and on its own branch.
        const worktrees = [streamed, timedOut, resumed].map((outcome) => outcome.worktree);
        expect(new Set(worktrees).size).toBe(3);
        expect(worktrees.every((path) => path.startsWith(join(tmp.dir, 'worktrees')))).toBe(true);
        // Compared by real path: on Windows git prints the long form with `/` (`C:/Users/...`), and
        // the temporary folder can come in the short 8.3 form with `\` (`C:\Users\RUNNER~1\...`).
        const listed = await Promise.all(
          (await testGit(repo, 'worktree', 'list', '--porcelain'))
            .split('\n')
            .filter((line) => line.startsWith('worktree '))
            .map((line) => line.slice('worktree '.length))
            // A registered worktree whose folder is already gone stays as git printed it.
            .map((path) => realpath(path).catch(() => path)),
        );
        for (const path of worktrees) expect(listed).toContain(await realpath(path));
        expect(await testGit(timedOut.worktree, 'ls-files')).toBe('README.md\ntimed.txt');
        expect(await testGit(resumed.worktree, 'ls-files')).toBe('README.md\ncrash.txt');

        // 4. A fourth Executor is running when the daemon stops...
        const stopped = runner.run(
          spec('restart', editsPrompt({ 'restart.txt': 'r\n' }, '#script:hang')),
        );
        await hanging('play-1/restart/1');
        await daemon.stop();
        const left = await stopped;
        expect(left).toMatchObject({ state: 'interrupted', cause: 'daemon_restart' });
        expect(launcher.running).toHaveLength(0);

        // ...and the next daemon finds it in the registry and resumes the same conversation.
        const next = await open();
        try {
          const record = await next.store.attempts.get(left.attemptId);
          expect(record?.sessionId).toBe(left.sessionId);
          const report = next.execution?.reconciled;
          expect(report?.resuming).toEqual([left.attemptId]);
          const [done] = (await report?.done) ?? [];
          expect(done).toMatchObject({ state: 'completed', attemptId: left.attemptId });
          expect(transport.loaded.map((load) => load.sessionId)).toContain(left.sessionId);
          expect(await testGit(left.worktree, 'show', 'HEAD:restart.txt')).toBe('r');
          expect(launcher.running).toHaveLength(0);
          // Nothing is waiting any more.
          expect(
            await next.store.attempts.list({
              states: ['executing', 'resuming', 'awaiting_resume'],
            }),
          ).toEqual([]);
        } finally {
          await next.stop();
        }
      } finally {
        await Promise.all(opened.map((daemon) => daemon.stop()));
        await disposeRepo();
        await tmp.dispose();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // The three real clients (N57) are in `acceptance.real.test.ts`, behind OT_TEST_REAL_CLIENTS=1
  // and OT_TEST_REAL_PROMPTS=1.
});
