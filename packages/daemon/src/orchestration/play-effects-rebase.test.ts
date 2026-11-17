// SPDX-License-Identifier: MPL-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attemptBranch, SCRIPT_KEY, type JsonValue } from '@otheater/core';
import { FakeClock, FakeCodeHost, InMemoryStore } from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, type RebaseConflictMode } from '../config.js';
import { createSilentLogger } from '../logger.js';
import { demandOf, makeWorkspaceRig, type WorkspaceRig } from '../workspace/workspace-fixture.js';
import { carryKey, CarrySchema } from './carry.js';
import { OrchestrationEffects } from './play-effects.js';

/**
 * The `rebase_dependents` effect (architecture 5.5, N82) on a real repository: the finished work
 * of a dependent moves onto the new branch of the demand that was redone, and what a conflict
 * does depends on `integration.rebase_conflict`. The daemon does not send the event that opens
 * this judgment yet, so the effect is dispatched by hand, and what it sends to the runner is read.
 */

afterAll(disposeTestGitIsolation);

const PLAY = 'play-1';
const SCENARIO = 'scenario-1';
const T = 60_000;

interface Sent {
  readonly playId: string;
  readonly event: Record<string, unknown>;
}

interface Rig extends WorkspaceRig {
  readonly store: InMemoryStore;
  readonly clock: FakeClock;
  readonly sent: Sent[];
  readonly effects: OrchestrationEffects;
  /** A finished attempt: a branch cut from `base` with `files`, and its row in the registry. */
  work(
    demandId: string,
    attempt: number,
    base: string,
    files: Record<string, string>,
  ): Promise<string>;
  /** Asks for the rebase of `dependentIds` after `demandId` was redone. */
  rebase(demandId: string, dependentIds: string[]): Promise<void>;
  show(branch: string, file: string): Promise<string>;
}

const rigs: Rig[] = [];

async function setup(mode: RebaseConflictMode): Promise<Rig> {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const host = new FakeCodeHost({ clock });
  const base = await makeWorkspaceRig({ store, codeHost: host });
  await base.workspace.createPlayBase({ repo: base.repo, playId: PLAY, base: 'main' });
  await store.scenarioRepos.put({ scenarioId: SCENARIO, path: base.repo, mainBranch: 'main' });
  const script = {
    contracts: ['alpha', 'beta', 'gamma'].map((id) => ({
      id: `c-${id}`,
      kind: 'file',
      title: `File ${id}`,
      description: `The file of ${id}.`,
    })),
    demands: [demandOf('alpha'), demandOf('beta', ['alpha']), demandOf('gamma', ['beta'])],
  };
  await store.blackboard.put({
    playId: PLAY,
    key: SCRIPT_KEY,
    value: script as unknown as JsonValue,
    author: 'daemon',
  });
  const sent: Sent[] = [];
  const effects = new OrchestrationEffects({
    store,
    vcs: base.vcs,
    config: parseConfig(`integration:\n  rebase_conflict: ${mode}\n`),
    logger: createSilentLogger(),
  } as never);
  effects.bind({
    send: (playId: string, event: Record<string, unknown>) => {
      sent.push({ playId, event });
      return Promise.resolve();
    },
  } as never);
  const rig: Rig = {
    ...base,
    store,
    clock,
    sent,
    effects,
    async work(demandId, attempt, from, files) {
      const branch = attemptBranch(PLAY, demandId, attempt);
      const path = join(base.worktreeRoot, 'attempts', PLAY, `${demandId}-${String(attempt)}`);
      await mkdir(join(path, '..'), { recursive: true });
      await base.vcs.createWorktree({ repo: base.repo, path, branch, base: from });
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(path, name), content);
      }
      await base.vcs.commitAll(path, `Work of ${demandId}`);
      await clock.advance(10);
      await store.attempts.put({
        attemptId: `${PLAY}:${demandId}:${String(attempt)}`,
        playId: PLAY,
        demandId,
        attempt,
        client: 'fake',
        profile: 'one',
        state: 'completed',
        cause: null,
        sessionId: null,
        worktree: path,
        branch,
        lastCheckpoint: null,
        lastCheckpointAt: null,
        lastEventAt: null,
        resumes: 0,
        freeResumes: 0,
      });
      // a finished attempt keeps its worktree, so a rebase has to cope with that
      return branch;
    },
    async rebase(demandId, dependentIds) {
      await effects.dispatch(
        { type: 'rebase_dependents', demandId, dependentIds },
        { playId: PLAY, scenarioId: SCENARIO },
      );
      await effects.idle();
    },
    show: async (branch, file) => `${await testGit(base.repo, 'show', `${branch}:${file}`)}\n`,
  };
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
});

const baseOfPlay = `play/${PLAY}/base`;

/** alpha (1) and beta (1) on top of it, and alpha redone (2) with `redone`. */
async function chain(
  rig: Rig,
  beta: Record<string, string>,
  redone: Record<string, string>,
): Promise<{ alpha1: string; beta1: string; alpha2: string }> {
  const alpha1 = await rig.work('alpha', 1, baseOfPlay, { 'a.txt': 'alpha v1\n' });
  const beta1 = await rig.work('beta', 1, alpha1, beta);
  const alpha2 = await rig.work('alpha', 2, baseOfPlay, redone);
  return { alpha1, beta1, alpha2 };
}

describe('rebase_dependents', () => {
  let rig: Rig;

  describe('without a conflict', () => {
    beforeEach(async () => {
      rig = await setup('redo');
    }, T);

    it(
      'moves the finished work of the dependent onto the new branch, and tells nobody',
      async () => {
        const { beta1, alpha2 } = await chain(
          rig,
          { 'b.txt': 'beta\n' },
          { 'a.txt': 'alpha v2\n' },
        );
        const before = await testGit(rig.repo, 'rev-parse', beta1);
        await rig.rebase('alpha', ['beta']);
        expect(rig.sent).toEqual([]);
        const after = await testGit(rig.repo, 'rev-parse', beta1);
        expect(after).not.toBe(before);
        // it now sits on the new work of alpha and keeps its own
        expect(await rig.show(beta1, 'a.txt')).toBe('alpha v2\n');
        expect(await rig.show(beta1, 'b.txt')).toBe('beta\n');
        const merged = await testGit(rig.repo, 'merge-base', '--is-ancestor', alpha2, beta1).then(
          () => true,
          () => false,
        );
        expect(merged).toBe(true);
        // only the demands of the list move: nothing else was written
        expect(await rig.store.blackboard.get(PLAY, carryKey('beta'))).toBeUndefined();
      },
      T,
    );

    it(
      'moves the dependents of a dependent that moved (alpha, beta, gamma), in the order of the script',
      async () => {
        const { beta1 } = await chain(rig, { 'b.txt': 'beta\n' }, { 'a.txt': 'alpha v2\n' });
        const gamma1 = await rig.work('gamma', 1, beta1, { 'g.txt': 'gamma\n' });
        await rig.rebase('alpha', ['gamma', 'beta']);
        expect(rig.sent).toEqual([]);
        expect(await rig.show(gamma1, 'a.txt')).toBe('alpha v2\n');
        expect(await rig.show(gamma1, 'b.txt')).toBe('beta\n');
        expect(await rig.show(gamma1, 'g.txt')).toBe('gamma\n');
      },
      T,
    );

    it(
      'leaves alone a demand that does not depend on the redone one first',
      async () => {
        await chain(rig, { 'b.txt': 'beta\n' }, { 'a.txt': 'alpha v2\n' });
        const gamma1 = await rig.work('gamma', 1, baseOfPlay, { 'g.txt': 'gamma\n' });
        const before = await testGit(rig.repo, 'rev-parse', gamma1);
        await rig.rebase('alpha', ['gamma']);
        expect(await testGit(rig.repo, 'rev-parse', gamma1)).toBe(before);
        expect(rig.sent).toEqual([]);
      },
      T,
    );
  });

  describe.each<RebaseConflictMode>(['redo', 'script_failure', 'resolve_attempt'])(
    'with a conflict, integration.rebase_conflict: %s',
    (mode) => {
      beforeEach(async () => {
        rig = await setup(mode);
      }, T);

      it(
        'aborts the rebase, keeps the old branch as it was and sends REBASE_CONFLICT with the mode',
        async () => {
          const { beta1 } = await chain(
            rig,
            { 'a.txt': 'alpha v1\nbeta line\n' },
            { 'a.txt': 'alpha v2\n' },
          );
          const before = await testGit(rig.repo, 'rev-parse', beta1);
          await rig.rebase('alpha', ['beta']);
          expect(rig.sent).toHaveLength(1);
          expect(rig.sent[0]).toMatchObject({
            playId: PLAY,
            event: { type: 'REBASE_CONFLICT', demandId: 'beta', mode, files: ['a.txt'] },
          });
          expect(String(rig.sent[0]?.event.reason)).toContain('a.txt');
          // nothing was left half done: the branch is where it was and no rebase is running
          expect(await testGit(rig.repo, 'rev-parse', beta1)).toBe(before);
          expect(await rig.show(beta1, 'a.txt')).toBe('alpha v1\nbeta line\n');
          const status = await testGit(rig.repo, 'status', '--porcelain');
          expect(status).not.toContain('UU');
        },
        T,
      );

      it(
        'leaves the note the next attempt reads: the old branch, what it started on, the files',
        async () => {
          const { beta1, alpha1, alpha2 } = await chain(
            rig,
            { 'a.txt': 'alpha v1\nbeta line\n' },
            { 'a.txt': 'alpha v2\n' },
          );
          await rig.rebase('alpha', ['beta']);
          const entry = await rig.store.blackboard.get(PLAY, carryKey('beta'));
          const carry = CarrySchema.parse(entry?.value);
          expect(carry).toMatchObject({
            fromAttempt: 1,
            kind: 'rebase_conflict',
            branch: beta1,
            oldBase: alpha1,
            files: ['a.txt'],
          });
          // `resolve_attempt` starts on the old branch and merges the new work into it
          if (mode === 'resolve_attempt') {
            expect(carry).toMatchObject({ resolve: true, startFromBranch: true, mergeIn: alpha2 });
          } else {
            expect(carry).toMatchObject({ resolve: false, startFromBranch: false, mergeIn: null });
          }
        },
        T,
      );

      it(
        'does not move the dependents of the one that conflicted',
        async () => {
          const { beta1 } = await chain(
            rig,
            { 'a.txt': 'alpha v1\nbeta line\n' },
            { 'a.txt': 'alpha v2\n' },
          );
          const gamma1 = await rig.work('gamma', 1, beta1, { 'g.txt': 'gamma\n' });
          const before = await testGit(rig.repo, 'rev-parse', gamma1);
          await rig.rebase('alpha', ['beta', 'gamma']);
          expect(rig.sent.map((entry) => entry.event.demandId)).toEqual(['beta']);
          expect(await testGit(rig.repo, 'rev-parse', gamma1)).toBe(before);
        },
        T,
      );
    },
  );

  it(
    'does nothing when the play has no script',
    async () => {
      rig = await setup('redo');
      await rig.effects.dispatch(
        { type: 'rebase_dependents', demandId: 'alpha', dependentIds: ['beta'] },
        { playId: 'other-play', scenarioId: SCENARIO },
      );
      await rig.effects.idle();
      expect(rig.sent).toEqual([]);
    },
    T,
  );
});
