// SPDX-License-Identifier: MPL-2.0
import {
  type NewSideEffect,
  type SideEffectRecord,
  Transient,
  integrationBranch,
  type VcsHistory,
  type Vcs,
} from '@otheater/core';
import { FakeClock, FakeCodeHost, InMemoryStore } from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  verifyCommand,
  verifyGitCommit,
  verifyGitPush,
  verifyMergeBase,
  verifyOpenPr,
  verifySideEffect,
  type VerifierDeps,
} from './verifiers.js';
import { demandOf, makeWorkspaceRig, scriptOf, type WorkspaceRig } from './workspace-fixture.js';

afterAll(disposeTestGitIsolation);

const PLAY = 'play-1';
const BRANCH = integrationBranch(PLAY);
const T = 60_000;

describe('verifiers of the workspace effects (architecture 5.21)', () => {
  let clock: FakeClock;
  let store: InMemoryStore;
  let host: FakeCodeHost;
  let rig: WorkspaceRig;
  let deps: VerifierDeps;

  beforeEach(async () => {
    clock = new FakeClock();
    store = new InMemoryStore({ clock });
    host = new FakeCodeHost({ clock });
    rig = await makeWorkspaceRig({ store, codeHost: host });
    deps = { vcs: rig.vcs as Vcs & VcsHistory, codeHost: host };
  }, T);

  afterEach(async () => {
    await rig.dispose();
  });

  function intend(input: NewSideEffect): Promise<SideEffectRecord> {
    return store.sideEffects.intend(input);
  }

  describe('git_commit', () => {
    async function integrated(): Promise<void> {
      await rig.workspace.createPlayBase({ repo: rig.repo, playId: PLAY, base: 'main' });
      await rig.attempt(PLAY, 'd1', 1, { 'd1.txt': 'one\n' });
      await rig.workspace.integrate({
        repo: rig.repo,
        playId: PLAY,
        script: scriptOf([demandOf('d1')]),
        approved: [{ demandId: 'd1', attempt: 1 }],
      });
    }

    it(
      'is done when the branch has the commit with the key, and not_done when it has not',
      async () => {
        await integrated();
        const params = { repo: rig.repo, branch: BRANCH };
        const there = await store.sideEffects.get('play-1:integrate:d1:1');
        if (there === undefined) throw new Error('the integration left no record');
        expect(await verifyGitCommit(deps, there)).toMatchObject({
          verdict: 'done',
          result: { outcome: 'merged' },
        });

        const missing = await intend({
          idempotencyKey: 'play-1:integrate:d2:1',
          type: 'git_commit',
          target: BRANCH,
          params,
        });
        expect(await verifyGitCommit(deps, missing)).toEqual({ verdict: 'not_done' });
      },
      T,
    );

    it(
      'is not_done when the branch was never created',
      async () => {
        const record = await intend({
          idempotencyKey: 'play-1:integrate:d1:1',
          type: 'git_commit',
          target: BRANCH,
          params: { repo: rig.repo, branch: BRANCH },
        });
        expect(await verifyGitCommit(deps, record)).toEqual({ verdict: 'not_done' });
      },
      T,
    );

    it(
      'is ambiguous when the record cannot be read',
      async () => {
        const record = await intend({
          idempotencyKey: 'play-1:integrate:d1:1',
          type: 'git_commit',
          target: BRANCH,
          params: { branch: BRANCH },
        });
        expect(await verifyGitCommit(deps, record)).toMatchObject({ verdict: 'ambiguous' });
        const gone = await intend({
          idempotencyKey: 'play-1:integrate:d9:1',
          type: 'git_commit',
          target: BRANCH,
          params: { repo: '/nowhere/at/all', branch: BRANCH },
        });
        expect(await verifyGitCommit(deps, gone)).toMatchObject({ verdict: 'not_done' });
      },
      T,
    );
  });

  describe('git_push', () => {
    const key = `${PLAY}:push:${BRANCH}@sha`;

    it(
      'is done when the remote branch is at the sha, not_done when it is missing or elsewhere',
      async () => {
        const sha = host.commitLocal(rig.repo, BRANCH);
        const params = { repo: rig.repo, branch: BRANCH, remote: 'origin', sha };
        const record = await intend({
          idempotencyKey: key,
          type: 'git_push',
          target: BRANCH,
          params,
        });

        expect(await verifyGitPush(deps, record)).toEqual({ verdict: 'not_done' });

        await host.pushRef({ repo: rig.repo, branch: BRANCH });
        expect(await verifyGitPush(deps, record)).toEqual({ verdict: 'done', result: { sha } });

        const newer = host.commitLocal(rig.repo, BRANCH);
        await host.pushRef({ repo: rig.repo, branch: BRANCH });
        expect(newer).not.toBe(sha);
        expect(await verifyGitPush(deps, record)).toEqual({ verdict: 'not_done' });
      },
      T,
    );

    it(
      'is ambiguous when the remote cannot be asked, and when the record cannot be read',
      async () => {
        const record = await intend({
          idempotencyKey: key,
          type: 'git_push',
          target: BRANCH,
          params: { repo: rig.repo, branch: BRANCH, remote: 'origin', sha: 'abc1234' },
        });
        host.failNext('remoteRef', new Transient('offline'));
        expect(await verifyGitPush(deps, record)).toMatchObject({ verdict: 'ambiguous' });

        const bad = await intend({
          idempotencyKey: `${key}-bad`,
          type: 'git_push',
          target: BRANCH,
          params: { repo: rig.repo },
        });
        expect(await verifyGitPush(deps, bad)).toMatchObject({ verdict: 'ambiguous' });
      },
      T,
    );
  });

  describe('open_pr', () => {
    const params = { repo: '/repo', head: BRANCH, base: 'main', remote: 'origin' };

    function pushed(): void {
      host.seedRemote('/repo', 'main');
      host.commitLocal('/repo', BRANCH);
    }

    it(
      'is done when a PR is open for head into base, and not_done when there is none',
      async () => {
        pushed();
        await host.pushRef({ repo: '/repo', branch: BRANCH });
        const record = await intend({
          idempotencyKey: `${PLAY}:pr:${BRANCH}:main`,
          type: 'open_pr',
          target: BRANCH,
          params,
        });
        expect(await verifyOpenPr(deps, record)).toEqual({ verdict: 'not_done' });

        const pr = await host.openPullRequest({
          repo: '/repo',
          head: BRANCH,
          base: 'main',
          title: 'T',
          body: '',
        });
        expect(await verifyOpenPr(deps, record)).toEqual({
          verdict: 'done',
          result: { number: pr.number, url: pr.url, state: 'open' },
        });
      },
      T,
    );

    it(
      'counts a PR that was merged since the intent, but not one from before it',
      async () => {
        pushed();
        await host.pushRef({ repo: '/repo', branch: BRANCH });
        const old = await host.openPullRequest({
          repo: '/repo',
          head: BRANCH,
          base: 'main',
          title: 'Old',
          body: '',
        });
        host.setPullRequestState(old.number, 'closed');
        await clock.advance(1000);
        const record = await intend({
          idempotencyKey: `${PLAY}:pr:${BRANCH}:main`,
          type: 'open_pr',
          target: BRANCH,
          params,
        });
        // The only PR is a closed one from before the intent: it is not this effect.
        expect(await verifyOpenPr(deps, record)).toEqual({ verdict: 'not_done' });

        await clock.advance(1000);
        const fresh = await host.openPullRequest({
          repo: '/repo',
          head: BRANCH,
          base: 'main',
          title: 'New',
          body: '',
        });
        host.setPullRequestState(fresh.number, 'merged');
        expect(await verifyOpenPr(deps, record)).toMatchObject({
          verdict: 'done',
          result: { number: fresh.number, state: 'merged' },
        });
      },
      T,
    );

    it(
      'is ambiguous when the host cannot be asked',
      async () => {
        const record = await intend({
          idempotencyKey: `${PLAY}:pr:${BRANCH}:main`,
          type: 'open_pr',
          target: BRANCH,
          params,
        });
        host.failNext('findPullRequest', new Transient('offline'));
        expect(await verifyOpenPr(deps, record)).toMatchObject({ verdict: 'ambiguous' });
      },
      T,
    );
  });

  describe('merge_base', () => {
    it(
      'is done when the head is in the base on the remote, not_done when it is not',
      async () => {
        host.seedRemote('/repo', 'main');
        host.seedRemote('/repo', BRANCH);
        const record = await intend({
          idempotencyKey: `${PLAY}:merge:main:sha`,
          type: 'merge_base',
          target: 'main',
          params: { repo: '/repo', head: BRANCH, base: 'main', remote: 'origin', sha: 'x' },
        });
        expect(await verifyMergeBase(deps, record)).toEqual({ verdict: 'not_done' });

        const merged = await host.mergeBranch({ repo: '/repo', head: BRANCH, base: 'main' });
        expect(await verifyMergeBase(deps, record)).toEqual({
          verdict: 'done',
          result: { sha: merged.sha },
        });
      },
      T,
    );

    it(
      'is ambiguous when the host cannot be asked',
      async () => {
        const record = await intend({
          idempotencyKey: `${PLAY}:merge:main:sha`,
          type: 'merge_base',
          target: 'main',
          params: { repo: '/repo', head: BRANCH, base: 'main', remote: 'origin' },
        });
        host.failNext('isBranchMerged', new Transient('offline'));
        expect(await verifyMergeBase(deps, record)).toMatchObject({ verdict: 'ambiguous' });
      },
      T,
    );
  });

  it(
    'verifySideEffect picks the verifier by type and leaves other tools alone',
    async () => {
      const push = await intend({
        idempotencyKey: 'k-push',
        type: 'git_push',
        target: BRANCH,
        params: { repo: rig.repo, branch: BRANCH, remote: 'origin', sha: 'abc1234' },
      });
      expect(await verifySideEffect(deps, push)).toEqual({ verdict: 'not_done' });
      const other = await intend({ idempotencyKey: 'k-other', type: 'send_mail', target: 'x' });
      expect(await verifySideEffect(deps, other)).toMatchObject({ verdict: 'ambiguous' });
    },
    T,
  );
});

describe('verifiers of the commands (P22)', () => {
  const record = (type: string, openPolicy?: string): SideEffectRecord => ({
    idempotencyKey: `${PLAY}:${type}:a:1`,
    type,
    target: '/wt',
    attemptId: null,
    params: openPolicy === undefined ? { callHash: 'h' } : { callHash: 'h', openPolicy },
    result: null,
    state: 'pending',
    verifier: null,
    createdAt: 0,
    updatedAt: 0,
    resolvedAt: null,
  });

  it('says not_done for a command that is safe to run again', () => {
    expect(verifyCommand(record('install_deps', 'rerun'))).toEqual({ verdict: 'not_done' });
    expect(verifyCommand(record('run_tests', 'rerun'))).toEqual({ verdict: 'not_done' });
  });

  it('says ambiguous for a command that is not, or has no policy', () => {
    for (const open of [record('restricted_shell', 'ask'), record('install_deps')]) {
      expect(verifyCommand(open)).toMatchObject({ verdict: 'ambiguous' });
    }
  });

  it('is what verifySideEffect answers for the three command types, with no code host', async () => {
    const deps = {} as VerifierDeps;
    for (const type of ['install_deps', 'run_tests', 'restricted_shell']) {
      expect(await verifySideEffect(deps, record(type, 'rerun'))).toEqual({ verdict: 'not_done' });
    }
  });
});
