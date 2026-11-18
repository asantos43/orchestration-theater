// SPDX-License-Identifier: MPL-2.0
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attemptInputOf } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { defaultVcs } from '../compose.js';
import { editsPrompt, TEST_POLICY, TEST_PROFILE } from '../test-helpers.js';
import { AttemptRunner } from './attempt-runner.js';
import { eventsOf, makeRig, specOf, until, type Rig, type RigParts } from './attempt-fixture.js';
import { reconcileAttempts, type AttemptResolver } from './reconcile.js';

const TEST_TIMEOUT_MS = 30_000;

function fakes() {
  const clock = new FakeClock();
  const launcher = new FakeProcessLauncher();
  return {
    clock,
    store: new InMemoryStore({ clock }),
    launcher,
    transport: new FakeSessionTransport(),
    adapter: new FakeClientAdapter({
      launcher,
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: 'fake-client', args: [] },
    }),
  } satisfies RigParts;
}

type TestRig = Rig<ReturnType<typeof fakes>>;

const rigs: TestRig[] = [];
afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});
afterAll(disposeTestGitIsolation);

const RESOLVER: AttemptResolver = () => ({
  profile: TEST_PROFILE,
  executor: { model: 'fake-model' },
  policy: TEST_POLICY,
});

/**
 * An attempt that was running when "the daemon" went away: the first runner is stopped, and a new
 * runner (the next daemon) is built over the same store, pool and worktrees.
 */
async function leftRunning(files: Record<string, string> = { 'a.txt': 'a\n' }) {
  const r: TestRig = await makeRig(fakes());
  rigs.push(r);
  const running = r.runner.run(specOf(r, editsPrompt(files, '#script:hang')));
  await until(
    async () =>
      (await eventsOf(r, 'session.update')).some((event) =>
        JSON.stringify(event.payload).includes('hanging until session/cancel'),
      ),
    'the Executor to hang',
  );
  await r.runner.stop();
  const outcome = await running;
  const next = new AttemptRunner({
    store: r.store,
    vcs: defaultVcs(),
    pool: r.pool,
    clock: r.clock,
    settings: r.settings,
    worktreeRoot: r.worktreeRoot,
    logger: pino({ level: 'silent' }),
  });
  return { r, outcome, next };
}

const logger = pino({ level: 'silent' });

describe('reconcileAttempts', () => {
  it(
    'resumes a graceful stop by reloading the conversation',
    async () => {
      const { r, outcome, next } = await leftRunning();
      expect((await r.store.attempts.get(outcome.attemptId))?.state).toBe('awaiting_resume');
      const interruptedBefore = (await eventsOf(r, 'session.interrupted')).length;

      const report = await reconcileAttempts({
        store: r.store,
        runner: next,
        resolver: RESOLVER,
        logger,
      });
      expect(report.found).toEqual([outcome.attemptId]);
      expect(report.resuming).toEqual([outcome.attemptId]);
      expect(report.parked).toEqual([]);
      const [done] = await report.done;

      expect(done).toMatchObject({ state: 'completed', attemptId: outcome.attemptId });
      expect(r.transport.loaded).toHaveLength(1);
      expect(r.transport.loaded[0]?.sessionId).toBe('fake-session-1');
      // The stop had already said "interrupted"; the resume does not say it twice.
      expect(await eventsOf(r, 'session.interrupted')).toHaveLength(interruptedBefore);
      expect((await eventsOf(r, 'session.resumed'))[0]?.payload).toMatchObject({
        form: 'native',
        cause: 'daemon_restart',
      });
      expect(r.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'resumes a daemon that died: commits what the worktree holds and records the interruption',
    async () => {
      const { r, outcome, next } = await leftRunning();
      // The daemon was killed: the registry still says executing, and the Executor had written
      // one more file nobody committed.
      const record = await r.store.attempts.get(outcome.attemptId);
      if (record === undefined) throw new Error('no record');
      await r.store.attempts.put({ ...attemptInputOf(record), state: 'executing', cause: null });
      await writeFile(join(outcome.worktree, 'late.txt'), 'late\n');

      const report = await reconcileAttempts({
        store: r.store,
        runner: next,
        resolver: RESOLVER,
        logger,
      });
      const [done] = await report.done;

      expect(done?.state).toBe('completed');
      expect(await testGit(outcome.worktree, 'show', 'HEAD:late.txt')).toBe('late');
      const interrupted = await eventsOf(r, 'session.interrupted');
      expect(interrupted.at(-1)?.payload).toMatchObject({ cause: 'daemon_restart' });
      expect(r.transport.loaded).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'parks what nobody knows how to resume, and says why',
    async () => {
      const { r, outcome, next } = await leftRunning();
      const report = await reconcileAttempts({
        store: r.store,
        runner: next,
        resolver: undefined,
        logger,
      });
      expect(report.parked).toEqual([outcome.attemptId]);
      expect(report.resuming).toEqual([]);
      expect(await report.done).toEqual([]);
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        state: 'interrupted',
        cause: 'daemon_restart',
      });
      expect(r.transport.loaded).toHaveLength(0);
      // The row of the interruption says the way on is a handoff, and that it cost no attempt (P17).
      const rows = await r.store.interruptions.list({ sessionId: 'fake-session-1' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        cause: 'daemon_restart',
        resumeForm: 'handoff',
        countedAsAttempt: false,
      });
      expect(rows[0]?.signals).toContain('action:handoff');
      // Parked is not picked up again.
      const again = await reconcileAttempts({
        store: r.store,
        runner: next,
        resolver: RESOLVER,
        logger,
      });
      expect(again.found).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'parks what a removed profile left, with the cause profile_removed (P21b)',
    async () => {
      const { r, outcome, next } = await leftRunning();
      const record = await r.store.attempts.get(outcome.attemptId);
      if (record === undefined) throw new Error('no record');
      await r.store.attempts.put({ ...attemptInputOf(record), cause: 'profile_removed' });
      const report = await reconcileAttempts({
        store: r.store,
        runner: next,
        resolver: undefined,
        logger,
      });
      expect(report.parked).toEqual([outcome.attemptId]);
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        state: 'interrupted',
        cause: 'profile_removed',
      });
      const rows = await r.store.interruptions.list({ sessionId: 'fake-session-1' });
      expect(rows.map((row) => row.cause)).toContain('profile_removed');
      expect(r.transport.loaded).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'parks an attempt whose worktree is gone',
    async () => {
      const { r, outcome, next } = await leftRunning();
      await rm(outcome.worktree, { recursive: true, force: true });
      const report = await reconcileAttempts({
        store: r.store,
        runner: next,
        resolver: RESOLVER,
        logger,
      });
      const [done] = await report.done;
      expect(done).toMatchObject({
        state: 'interrupted',
        cause: 'worktree_missing',
        needsDecision: true,
      });
      expect(await r.store.attempts.get(outcome.attemptId)).toMatchObject({
        state: 'interrupted',
        cause: 'worktree_missing',
      });
      expect(r.transport.loaded).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'leaves finished attempts alone',
    async () => {
      const r: TestRig = await makeRig(fakes());
      rigs.push(r);
      const outcome = await r.runner.run(specOf(r, 'done quickly'));
      const report = await reconcileAttempts({
        store: r.store,
        runner: r.runner,
        resolver: RESOLVER,
        logger,
      });
      expect(report.found).toEqual([]);
      expect((await r.store.attempts.get(outcome.attemptId))?.state).toBe('completed');
    },
    TEST_TIMEOUT_MS,
  );
});
