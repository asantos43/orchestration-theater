// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  InvalidInput,
  NotFound,
  Transient,
  integrationBranch,
  playBranch,
  type Vcs,
} from '@otheater/core';
import { FakeClock, FakeCodeHost, InMemoryStore } from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demandOf, makeWorkspaceRig, scriptOf, type WorkspaceRig } from './workspace-fixture.js';
import { Workspace } from './workspace.js';

afterAll(disposeTestGitIsolation);

const PLAY = 'play-1';
const T = 60_000;

interface Rig extends WorkspaceRig {
  readonly store: InMemoryStore;
  readonly host: FakeCodeHost;
}

const rigs: Rig[] = [];

async function setup(): Promise<Rig> {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const host = new FakeCodeHost({ clock });
  const rig = { ...(await makeWorkspaceRig({ store, codeHost: host })), store, host };
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
});

async function eventsOf(rig: Rig, type: string) {
  return (await rig.store.events.readFrom(0, 1000)).filter((event) => event.type === type);
}

const script = scriptOf([demandOf('d1'), demandOf('d2', ['d1']), demandOf('d3')]);

describe('Workspace.createPlayBase', () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await setup();
  }, T);

  it(
    'creates play/<id>/base from the base and keeps it on a repetition',
    async () => {
      const main = await testGit(rig.repo, 'rev-parse', 'main');
      const sha = await rig.workspace.createPlayBase({
        repo: rig.repo,
        playId: PLAY,
        base: 'main',
      });
      expect(sha).toBe(main);
      expect(await testGit(rig.repo, 'rev-parse', playBranch(PLAY))).toBe(main);
      // No worktree is left behind; only the branch.
      expect((await rig.vcs.listWorktrees(rig.repo)).map((entry) => entry.branch)).toEqual([
        'main',
      ]);

      await testGit(rig.repo, 'commit', '--quiet', '--allow-empty', '-m', 'main moves on');
      const again = await rig.workspace.createPlayBase({
        repo: rig.repo,
        playId: PLAY,
        base: 'main',
      });
      expect(again).toBe(main);
    },
    T,
  );

  it(
    'rejects a base that does not exist',
    async () => {
      await expect(
        rig.workspace.createPlayBase({ repo: rig.repo, playId: PLAY, base: 'nope' }),
      ).rejects.toBeInstanceOf(NotFound);
    },
    T,
  );

  it('refuses a Vcs that cannot merge or answer history queries', () => {
    const bare = {
      id: 'bare',
      implements: rig.vcs.implements,
      createWorktree: rig.vcs.createWorktree.bind(rig.vcs),
    } as unknown as Vcs;
    expect(
      () =>
        new Workspace({
          store: rig.store,
          vcs: bare,
          codeHost: rig.host,
          worktreeRoot: rig.worktreeRoot,
        }),
    ).toThrow(AdapterUnavailable);
  });
});

describe('Workspace.integrate', () => {
  let rig: Rig;
  beforeEach(async () => {
    rig = await setup();
    await rig.workspace.createPlayBase({ repo: rig.repo, playId: PLAY, base: 'main' });
  }, T);

  it(
    'integrates two attempts without conflict, in the order of the script',
    async () => {
      const d1 = await rig.attempt(PLAY, 'd1', 1, { 'd1.txt': 'one\n' });
      const d2 = await rig.attempt(PLAY, 'd2', 1, { 'd2.txt': 'two\n' });

      // The approval came in the reverse order: d2 depends on d1, so d1 goes first.
      const result = await rig.workspace.integrate({
        repo: rig.repo,
        playId: PLAY,
        script,
        approved: [
          { demandId: 'd2', attempt: 1 },
          { demandId: 'd1', attempt: 1 },
        ],
      });

      if (result.kind !== 'integrated') throw new Error(`Expected integrated: ${result.kind}`);
      expect(result.branch).toBe(integrationBranch(PLAY));
      expect(result.merged.map((entry) => [entry.demandId, entry.sha, entry.outcome])).toEqual([
        ['d1', d1, 'merged'],
        ['d2', d2, 'merged'],
      ]);
      expect(result.head).toBe(await testGit(rig.repo, 'rev-parse', integrationBranch(PLAY)));
      expect(await readFile(join(result.worktree, 'd1.txt'), 'utf8')).toBe('one\n');
      expect(await readFile(join(result.worktree, 'd2.txt'), 'utf8')).toBe('two\n');

      // The merge commits carry the idempotency key, and the registry says they are done.
      const log = await testGit(rig.repo, 'log', '--format=%s%n%b', integrationBranch(PLAY));
      expect(log).toContain('OTheater-Idempotency-Key: play-1:integrate:d1:1');
      expect(log).toContain('OTheater-Idempotency-Key: play-1:integrate:d2:1');
      const effects = await rig.store.sideEffects.list({ types: ['git_commit'] });
      expect(effects.map((effect) => [effect.idempotencyKey, effect.state])).toEqual([
        ['play-1:integrate:d1:1', 'done'],
        ['play-1:integrate:d2:1', 'done'],
      ]);

      const events = await eventsOf(rig, 'workspace.integrated');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ playId: PLAY, payload: { head: result.head } });
    },
    T,
  );

  it(
    'a repetition integrates nothing twice and says nothing new',
    async () => {
      await rig.attempt(PLAY, 'd1', 1, { 'd1.txt': 'one\n' });
      const input = {
        repo: rig.repo,
        playId: PLAY,
        script,
        approved: [{ demandId: 'd1', attempt: 1 }],
      };
      const first = await rig.workspace.integrate(input);
      const commits = await testGit(rig.repo, 'rev-list', '--count', integrationBranch(PLAY));
      const second = await rig.workspace.integrate(input);

      expect(second).toEqual(first);
      expect(await testGit(rig.repo, 'rev-list', '--count', integrationBranch(PLAY))).toBe(commits);
      expect(await eventsOf(rig, 'workspace.integrated')).toHaveLength(1);
    },
    T,
  );

  it(
    'turns a merge conflict into a typed script failure and stops there',
    async () => {
      await rig.attempt(PLAY, 'd1', 1, { 'shared.txt': 'from d1\n' });
      await rig.attempt(PLAY, 'd3', 1, { 'shared.txt': 'from d3\n' });
      const input = {
        repo: rig.repo,
        playId: PLAY,
        script,
        approved: [
          { demandId: 'd1', attempt: 1 },
          { demandId: 'd3', attempt: 1 },
        ],
      };

      const result = await rig.workspace.integrate(input);

      expect(result).toEqual({
        kind: 'script_failure',
        cause: 'merge_conflict',
        demandId: 'd3',
        attempt: 1,
        branch: 'play/play-1/attempts/d3/1',
        integrationBranch: integrationBranch(PLAY),
        conflictFiles: ['shared.txt'],
        mergedSoFar: ['d1'],
      });
      // d1 stays in; d3 is not half-merged.
      const worktree = (await rig.vcs.listWorktrees(rig.repo)).find(
        (entry) => entry.branch === integrationBranch(PLAY),
      );
      expect(worktree).toBeDefined();
      expect(await readFile(join(worktree?.path ?? '', 'shared.txt'), 'utf8')).toBe('from d1\n');
      expect(await testGit(worktree?.path ?? '', 'status', '--porcelain')).toBe('');

      const failed = await eventsOf(rig, 'workspace.integration_failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({
        cause: 'merge_conflict',
        demandId: 'd3',
        conflictFiles: ['shared.txt'],
        mergedSoFar: ['d1'],
      });
      expect(await eventsOf(rig, 'workspace.integrated')).toHaveLength(0);

      // The same attempt conflicts again without merging or announcing anything.
      expect(await rig.workspace.integrate(input)).toEqual(result);
      expect(await eventsOf(rig, 'workspace.integration_failed')).toHaveLength(1);
    },
    T,
  );

  it(
    'an attempt that adds nothing is up to date, not an error',
    async () => {
      await rig.attempt(PLAY, 'd1', 1, { 'd1.txt': 'one\n' });
      // The second attempt branch is the same commit as the first one.
      await testGit(rig.repo, 'branch', 'play/play-1/attempts/d3/1', 'play/play-1/attempts/d1/1');
      const result = await rig.workspace.integrate({
        repo: rig.repo,
        playId: PLAY,
        script,
        approved: [
          { demandId: 'd1', attempt: 1 },
          { demandId: 'd3', attempt: 1 },
        ],
      });
      if (result.kind !== 'integrated') throw new Error(result.kind);
      expect(result.merged.map((entry) => entry.outcome)).toEqual(['merged', 'up_to_date']);
    },
    T,
  );

  it(
    'settles an interrupted merge with the verifier instead of merging again',
    async () => {
      await rig.attempt(PLAY, 'd1', 1, { 'd1.txt': 'one\n' });
      const input = {
        repo: rig.repo,
        playId: PLAY,
        script,
        approved: [{ demandId: 'd1', attempt: 1 }],
      };
      await rig.workspace.integrate(input);
      const commits = await testGit(rig.repo, 'rev-list', '--count', integrationBranch(PLAY));

      // A daemon that died after the merge and before writing the "after": a new store knows only
      // the intent. The history of the branch is what says the commit exists.
      const clock = new FakeClock();
      const store = new InMemoryStore({ clock });
      await store.sideEffects.intend({
        idempotencyKey: 'play-1:integrate:d1:1',
        type: 'git_commit',
        target: integrationBranch(PLAY),
        params: { repo: rig.repo, branch: integrationBranch(PLAY) },
      });
      const restarted = new Workspace({
        store,
        vcs: rig.vcs,
        codeHost: rig.host,
        worktreeRoot: rig.worktreeRoot,
      });

      const result = await restarted.integrate(input);

      expect(result.kind).toBe('integrated');
      expect(await testGit(rig.repo, 'rev-list', '--count', integrationBranch(PLAY))).toBe(commits);
      expect(await store.sideEffects.get('play-1:integrate:d1:1')).toMatchObject({
        state: 'done',
        verifier: 'verifier',
      });
    },
    T,
  );

  it(
    'rejects what makes no sense before touching git',
    async () => {
      const base = { repo: rig.repo, playId: PLAY, script };
      await expect(rig.workspace.integrate({ ...base, approved: [] })).rejects.toBeInstanceOf(
        InvalidInput,
      );
      await expect(
        rig.workspace.integrate({ ...base, approved: [{ demandId: 'zz', attempt: 1 }] }),
      ).rejects.toBeInstanceOf(InvalidInput);
      await expect(
        rig.workspace.integrate({
          ...base,
          approved: [
            { demandId: 'd1', attempt: 1 },
            { demandId: 'd1', attempt: 2 },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidInput);
      await expect(
        rig.workspace.integrate({ ...base, approved: [{ demandId: 'd1', attempt: 0 }] }),
      ).rejects.toBeInstanceOf(InvalidInput);
      expect(await rig.store.sideEffects.list()).toEqual([]);
    },
    T,
  );

  it(
    'needs the base of the play and the branch of the attempt',
    async () => {
      await expect(
        rig.workspace.integrate({
          repo: rig.repo,
          playId: 'other-play',
          script,
          approved: [{ demandId: 'd1', attempt: 1 }],
        }),
      ).rejects.toBeInstanceOf(NotFound);
      await expect(
        rig.workspace.integrate({
          repo: rig.repo,
          playId: PLAY,
          script,
          approved: [{ demandId: 'd1', attempt: 1 }],
        }),
      ).rejects.toBeInstanceOf(NotFound);
    },
    T,
  );
});

describe('Workspace.deliver', () => {
  let rig: Rig;
  let head: string;
  const branch = integrationBranch(PLAY);
  const delivery = {
    playId: PLAY,
    base: 'main',
    title: 'Deliver play 1',
    body: 'What was done.',
    configMode: 'pr',
    allowDirectMerge: false,
    attended: true,
  } as const;

  beforeEach(async () => {
    rig = await setup();
    await rig.workspace.createPlayBase({ repo: rig.repo, playId: PLAY, base: 'main' });
    await rig.attempt(PLAY, 'd1', 1, { 'd1.txt': 'one\n' });
    const integrated = await rig.workspace.integrate({
      repo: rig.repo,
      playId: PLAY,
      script,
      approved: [{ demandId: 'd1', attempt: 1 }],
    });
    if (integrated.kind !== 'integrated') throw new Error(integrated.kind);
    head = integrated.head;
    // The fake host has no git: it learns the branch the real repository has.
    rig.host.seedRemote(rig.repo, 'main');
    rig.host.adoptLocal(rig.repo, branch, head);
  }, T);

  it(
    'pushes the branch and opens a PR, and a repeated delivery requests it only once',
    async () => {
      const first = await rig.workspace.deliver({ ...delivery, repo: rig.repo });
      if (first.kind !== 'delivered') throw new Error(first.kind);
      expect(first).toMatchObject({
        mode: 'pr',
        branch,
        base: 'main',
        pushedSha: head,
        pullRequest: { number: 1 },
      });
      expect(await rig.host.remoteRef({ repo: rig.repo, branch })).toBe(head);

      const second = await rig.workspace.deliver({ ...delivery, repo: rig.repo });
      expect(second).toEqual(first);
      expect(rig.host.callCount('openPullRequest')).toBe(1);
      expect(rig.host.callCount('pushRef')).toBe(1);
      expect(rig.host.pullRequests()).toHaveLength(1);

      const effects = await rig.store.sideEffects.list({ types: ['git_push', 'open_pr'] });
      // The fake clock does not move, so the listing order of the two is by key.
      expect(effects.map((effect) => [effect.type, effect.state]).sort()).toEqual([
        ['git_push', 'done'],
        ['open_pr', 'done'],
      ]);
      const events = await eventsOf(rig, 'delivery.completed');
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        mode: 'pr',
        requestedMode: 'pr',
        requestedBy: 'config',
        downgraded: false,
        pushedSha: head,
        pullRequest: { number: 1 },
      });
    },
    T,
  );

  it(
    'records the mode and who asked for it in the PR, and says when it was downgraded',
    async () => {
      const result = await rig.workspace.deliver({
        ...delivery,
        repo: rig.repo,
        requested: { mode: 'direct_merge', by: 'play' },
      });
      expect(result).toMatchObject({
        kind: 'delivered',
        mode: 'pr',
        decision: { downgraded: true, reason: 'direct_merge_not_allowed', requestedBy: 'play' },
      });
      const opened = rig.host.calls.find((call) => call.method === 'openPullRequest');
      const body = (opened?.args as { body: string }).body;
      expect(body).toContain('What was done.');
      expect(body).toContain('requested `direct_merge` by play');
      expect(body).toContain('direct_merge_not_allowed');
      expect(rig.host.callCount('mergeBranch')).toBe(0);
      expect((await eventsOf(rig, 'delivery.completed'))[0]?.payload).toMatchObject({
        mode: 'pr',
        requestedMode: 'direct_merge',
        downgraded: true,
        reason: 'direct_merge_not_allowed',
      });
    },
    T,
  );

  it(
    'merges on the remote when allowed and asked for by the play',
    async () => {
      const input = {
        ...delivery,
        repo: rig.repo,
        allowDirectMerge: true,
        requested: { mode: 'direct_merge', by: 'task' },
      } as const;
      const result = await rig.workspace.deliver(input);
      if (result.kind !== 'delivered') throw new Error(result.kind);
      expect(result.mode).toBe('direct_merge');
      expect(result.pullRequest).toBeUndefined();
      expect(result.mergeSha).toBe(await rig.host.remoteRef({ repo: rig.repo, branch: 'main' }));
      expect(rig.host.pullRequests()).toEqual([]);

      await rig.workspace.deliver(input);
      expect(rig.host.callCount('mergeBranch')).toBe(1);
      expect(await eventsOf(rig, 'delivery.completed')).toHaveLength(1);
    },
    T,
  );

  it(
    'asks the Producer without doing anything when someone is looking',
    async () => {
      const result = await rig.workspace.deliver({
        ...delivery,
        repo: rig.repo,
        configMode: 'ask',
        allowDirectMerge: true,
      });
      expect(result).toMatchObject({
        kind: 'ask_producer',
        options: ['pr', 'direct_merge'],
        recommended: 'pr',
      });
      expect(rig.host.calls).toEqual([]);
      expect(await rig.store.sideEffects.list()).toHaveLength(1); // only the integration merge
      expect(await eventsOf(rig, 'delivery.completed')).toEqual([]);
    },
    T,
  );

  it(
    'opens a PR for ask when nobody is looking',
    async () => {
      const result = await rig.workspace.deliver({
        ...delivery,
        repo: rig.repo,
        configMode: 'ask',
        allowDirectMerge: true,
        attended: false,
      });
      expect(result).toMatchObject({
        kind: 'delivered',
        mode: 'pr',
        decision: { requestedMode: 'ask', reason: 'unattended' },
      });
    },
    T,
  );

  it(
    'adopts the PR the host already has when the intent was written and the answer lost',
    async () => {
      // A crash after the host created the PR and before the daemon wrote the "after".
      await rig.host.pushRef({ repo: rig.repo, branch });
      const existing = await rig.host.openPullRequest({
        repo: rig.repo,
        head: branch,
        base: 'main',
        title: 'Deliver play 1',
        body: '',
      });
      await rig.store.sideEffects.intend({
        idempotencyKey: `${PLAY}:push:${branch}@${head}`,
        type: 'git_push',
        target: branch,
        params: { repo: rig.repo, branch, remote: 'origin', sha: head },
      });
      await rig.store.sideEffects.intend({
        idempotencyKey: `${PLAY}:pr:${branch}:main`,
        type: 'open_pr',
        target: `${branch} -> main`,
        params: { repo: rig.repo, head: branch, base: 'main', remote: 'origin' },
      });

      const result = await rig.workspace.deliver({ ...delivery, repo: rig.repo });

      expect(result).toMatchObject({ kind: 'delivered', pullRequest: { number: existing.number } });
      expect(rig.host.callCount('openPullRequest')).toBe(1);
      expect(rig.host.callCount('pushRef')).toBe(1);
      expect(await rig.store.sideEffects.get(`${PLAY}:pr:${branch}:main`)).toMatchObject({
        state: 'done',
        verifier: 'verifier',
      });
    },
    T,
  );

  it(
    'asks again under a new key when the intent has no PR behind it',
    async () => {
      await rig.store.sideEffects.intend({
        idempotencyKey: `${PLAY}:pr:${branch}:main`,
        type: 'open_pr',
        target: `${branch} -> main`,
        params: { repo: rig.repo, head: branch, base: 'main', remote: 'origin' },
      });
      const result = await rig.workspace.deliver({ ...delivery, repo: rig.repo });
      expect(result).toMatchObject({ kind: 'delivered', pullRequest: { number: 1 } });
      expect(await rig.store.sideEffects.get(`${PLAY}:pr:${branch}:main`)).toMatchObject({
        state: 'not_done',
      });
      expect((await rig.store.sideEffects.get(`${PLAY}:pr:${branch}:main~2`))?.state).toBe('done');
    },
    T,
  );

  it(
    'reports an ambiguity instead of guessing when the host cannot be asked',
    async () => {
      await rig.store.sideEffects.intend({
        idempotencyKey: `${PLAY}:pr:${branch}:main`,
        type: 'open_pr',
        target: `${branch} -> main`,
        params: { repo: rig.repo, head: branch, base: 'main', remote: 'origin' },
      });
      rig.host.failNext('findPullRequest', new Transient('host unreachable'));

      const result = await rig.workspace.deliver({ ...delivery, repo: rig.repo });

      expect(result).toMatchObject({ kind: 'ambiguous', step: 'pull_request' });
      expect(rig.host.callCount('openPullRequest')).toBe(0);
      expect((await rig.store.sideEffects.get(`${PLAY}:pr:${branch}:main`))?.state).toBe(
        'ambiguous',
      );
      expect(await eventsOf(rig, 'delivery.completed')).toEqual([]);
    },
    T,
  );

  it(
    'a failed push is recorded and the next delivery pushes again',
    async () => {
      rig.host.failNext('pushRef', new Transient('network down'));
      await expect(rig.workspace.deliver({ ...delivery, repo: rig.repo })).rejects.toBeInstanceOf(
        Transient,
      );
      expect((await rig.store.sideEffects.get(`${PLAY}:push:${branch}@${head}`))?.state).toBe(
        'failed',
      );
      const result = await rig.workspace.deliver({ ...delivery, repo: rig.repo });
      expect(result.kind).toBe('delivered');
      expect(rig.host.callCount('pushRef')).toBe(2);
    },
    T,
  );

  it(
    'needs an integration branch to deliver',
    async () => {
      await expect(
        rig.workspace.deliver({ ...delivery, repo: rig.repo, playId: 'other-play' }),
      ).rejects.toBeInstanceOf(NotFound);
    },
    T,
  );
});
