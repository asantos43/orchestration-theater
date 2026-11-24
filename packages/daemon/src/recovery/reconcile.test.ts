// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProcessLauncher } from '@otheater/core';
import {
  FakeClock,
  FakeCodeHost,
  FakeProcessLauncher,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import { createSilentLogger } from '../logger.js';
import { DECISION_KINDS } from '../orchestration/play-effects.js';
import { RecordingSituations } from '../test-helpers.js';
import { PluginEffectRegistry } from '../workspace/plugin-effects.js';
import { makeWorkspaceRig, type WorkspaceRig } from '../workspace/workspace-fixture.js';
import {
  RECOVERY_COMMIT_PREFIX,
  reconcileBeforeResume,
  recoveryDecisionId,
  type RecoveryDeps,
} from './reconcile.js';

afterAll(disposeTestGitIsolation);

interface Rig {
  readonly store: InMemoryStore;
  readonly fake: FakeCodeHost;
  readonly launcher: FakeProcessLauncher;
  readonly workspace: WorkspaceRig;
  deps(extra?: Partial<RecoveryDeps>): RecoveryDeps;
}

const PLAY = 'play-1';
const BRANCH = `play/${PLAY}/delivery`;
let rig: Rig;
const scratch: string[] = [];

beforeEach(async () => {
  const clock = new FakeClock();
  const store = new InMemoryStore({ clock });
  const fake = new FakeCodeHost({ clock });
  const workspace = await makeWorkspaceRig({ store, codeHost: fake });
  const launcher = new FakeProcessLauncher();
  rig = {
    store,
    fake,
    launcher,
    workspace,
    deps: (extra) => ({
      store,
      vcs: workspace.vcs,
      codeHost: fake,
      launcher,
      logger: createSilentLogger(),
      ...extra,
    }),
  };
  await store.scenarios.create({
    id: 'scenario-1',
    kind: 'project',
    flowId: 'play',
    name: 'scenario',
    folder: workspace.repo,
    baseBranch: 'main',
  });
  await store.plays.create({
    id: PLAY,
    scenarioId: 'scenario-1',
    need: 'need',
    flowId: 'play',
    flowVersion: 1,
    state: 'DELIVERING',
    counters: {},
  });
});

afterEach(async () => {
  await rig.workspace.dispose();
  for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

function prRecord(key: string, type = 'open_pr') {
  return {
    idempotencyKey: key,
    type,
    target: `${BRANCH} -> main`,
    params: { repo: rig.workspace.repo, head: BRANCH, base: 'main', remote: 'origin' },
  };
}

/** The remote has the head and the base, as a push leaves it. */
async function pushHead(): Promise<void> {
  rig.fake.seedRemote(rig.workspace.repo, 'main');
  rig.fake.commitLocal(rig.workspace.repo, BRANCH);
  await rig.fake.pushRef({ repo: rig.workspace.repo, branch: BRANCH });
}

describe('orphan processes and sessions', () => {
  it('ends the orphan found by pid and start instant, and parks the session', async () => {
    rig.launcher.plantOrphan(31_337, 5_000);
    await rig.store.sessions.open({
      id: 's-orphan',
      client: 'fake',
      profile: 'one',
      pid: 31_337,
      processStartedAt: 5_000,
    });
    const report = await reconcileBeforeResume(rig.deps());
    expect(report.orphansKilled).toBe(1);
    expect(report.sessionsInterrupted).toBe(1);
    expect(rig.launcher.orphanAlive(31_337)).toBe(false);
    expect((await rig.store.sessions.get('s-orphan'))?.state).toBe('interrupted');
  });

  it('finds the orphan of a row that has no pid yet by its launch marker (Phase 11, P3)', async () => {
    // The daemon died after the process existed and before its pid was written.
    rig.launcher.plantOrphan(31_337, 5_000, 'proc-window');
    rig.launcher.plantOrphan(31_338, 5_000, 'proc-other');
    await rig.store.sessions.open({ id: 'proc-window', client: 'fake', profile: 'one' });
    const report = await reconcileBeforeResume(rig.deps());
    expect(report.orphansKilled).toBe(1);
    expect(report.orphansLeft).toBe(0);
    expect(rig.launcher.orphanAlive(31_337)).toBe(false);
    // A marker no live row names is not ours to end.
    expect(rig.launcher.orphanAlive(31_338)).toBe(true);
    expect((await rig.store.sessions.get('proc-window'))?.state).toBe('interrupted');
  });

  it('counts a row once when its pid and its marker name the same process', async () => {
    rig.launcher.plantOrphan(31_337, 5_000, 'proc-both');
    await rig.store.sessions.open({
      id: 'proc-both',
      client: 'fake',
      profile: 'one',
      pid: 31_337,
      processStartedAt: 5_000,
    });
    const report = await reconcileBeforeResume(rig.deps());
    expect(report.orphansKilled).toBe(1);
    expect(rig.launcher.orphanAlive(31_337)).toBe(false);
  });

  it('recovery.orphans: report leaves the orphan alive and says so in a notice', async () => {
    rig.launcher.plantOrphan(31_337, 5_000, 'proc-window');
    await rig.store.sessions.open({ id: 'proc-window', client: 'fake', profile: 'one' });
    const situations = new RecordingSituations();
    const report = await reconcileBeforeResume(rig.deps({ orphans: 'report', situations }));
    expect(report.orphansKilled).toBe(0);
    expect(report.orphansLeft).toBe(1);
    expect(rig.launcher.orphanAlive(31_337)).toBe(true);
    expect(rig.launcher.orphanKills).toEqual([]);
    expect(situations.of('recovery.notice')).toEqual([
      expect.objectContaining({ kind: 'orphan_left', subject: 'fake' }),
    ]);
    expect((await rig.store.sessions.get('proc-window'))?.state).toBe('interrupted');
  });

  it('recovery.orphans: report does not count a recycled pid as left', async () => {
    rig.launcher.plantOrphan(31_337, 9_000);
    await rig.store.sessions.open({
      id: 's-old',
      client: 'fake',
      profile: 'one',
      pid: 31_337,
      processStartedAt: 5_000,
    });
    const situations = new RecordingSituations();
    const report = await reconcileBeforeResume(rig.deps({ orphans: 'report', situations }));
    expect(report.orphansLeft).toBe(0);
    expect(situations.recorded).toEqual([]);
  });

  it('does not signal a recycled pid, but still parks the session', async () => {
    rig.launcher.plantOrphan(31_337, 9_000);
    await rig.store.sessions.open({
      id: 's-old',
      client: 'fake',
      profile: 'one',
      pid: 31_337,
      processStartedAt: 5_000,
    });
    const report = await reconcileBeforeResume(rig.deps());
    expect(report.orphansKilled).toBe(0);
    expect(rig.launcher.orphanAlive(31_337)).toBe(true);
    expect((await rig.store.sessions.get('s-old'))?.state).toBe('interrupted');
  });

  it('parks sessions with no pid, and leaves closed and interrupted ones alone', async () => {
    await rig.store.sessions.open({ id: 'no-pid', client: 'fake', profile: 'one' });
    await rig.store.sessions.open({
      id: 'closed',
      client: 'fake',
      profile: 'one',
      state: 'closed',
    });
    const report = await reconcileBeforeResume(rig.deps());
    expect(report.sessionsInterrupted).toBe(1);
    expect((await rig.store.sessions.get('closed'))?.state).toBe('closed');
    // A second start finds nothing left to park.
    expect((await reconcileBeforeResume(rig.deps())).sessionsInterrupted).toBe(0);
  });

  it('keeps the session live when the orphan could not be ended, so the next start tries again', async () => {
    const broken: ProcessLauncher & {
      processStartedAt(): Promise<number>;
      killOrphan(): Promise<never>;
      findMarked(): Promise<readonly never[]>;
    } = Object.assign(Object.create(rig.launcher) as ProcessLauncher, {
      processStartedAt: () => Promise.resolve(5_000),
      findMarked: () => Promise.resolve([]),
      killOrphan: () => Promise.reject(new Error('EPERM')),
    });
    await rig.store.sessions.open({
      id: 's-stuck',
      client: 'fake',
      profile: 'one',
      pid: 31_337,
      processStartedAt: 5_000,
    });
    const report = await reconcileBeforeResume(rig.deps({ launcher: broken }));
    expect(report.sessionsInterrupted).toBe(0);
    expect((await rig.store.sessions.get('s-stuck'))?.state).toBe('active');
  });

  it('only parks the sessions when the launcher cannot find orphans', async () => {
    await rig.store.sessions.open({
      id: 's-1',
      client: 'fake',
      profile: 'one',
      pid: 31_337,
      processStartedAt: 5_000,
    });
    const report = await reconcileBeforeResume(rig.deps({ launcher: undefined }));
    expect(report.orphansKilled).toBe(0);
    expect(report.sessionsInterrupted).toBe(1);
  });
});

describe('work left in the worktrees', () => {
  async function attemptWithWorktree(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'otheater-recovery-wt-'));
    scratch.push(root);
    const path = join(root, 'wt');
    await rig.workspace.vcs.createWorktree({
      repo: rig.workspace.repo,
      path,
      branch: `play/${PLAY}/a1`,
      base: 'main',
    });
    await rig.store.attempts.put({
      attemptId: 'a1',
      playId: PLAY,
      demandId: 'd1',
      attempt: 1,
      client: 'fake',
      profile: 'one',
      state: 'executing',
      cause: null,
      sessionId: null,
      worktree: path,
      branch: `play/${PLAY}/a1`,
      lastCheckpoint: null,
      lastCheckpointAt: null,
      lastEventAt: null,
      resumes: 0,
      freeResumes: 0,
    });
    return path;
  }

  it('commits what an attempt in progress left uncommitted, once', async () => {
    const path = await attemptWithWorktree();
    await writeFile(join(path, 'half.txt'), 'half done\n');
    const first = await reconcileBeforeResume(rig.deps());
    expect(first.wipCommits).toBe(1);
    expect(await testGit(path, 'log', '-1', '--format=%s')).toContain(RECOVERY_COMMIT_PREFIX);
    expect(await testGit(path, 'status', '--porcelain')).toBe('');
    // Nothing is left to commit the second time.
    expect((await reconcileBeforeResume(rig.deps())).wipCommits).toBe(0);
  });

  it('skips an attempt whose worktree is gone', async () => {
    const path = await attemptWithWorktree();
    await rm(path, { recursive: true, force: true });
    expect((await reconcileBeforeResume(rig.deps())).wipCommits).toBe(0);
  });
});

describe('effects with an intent and no end', () => {
  it('takes as done what the verifier finds done', async () => {
    await pushHead();
    await rig.fake.openPullRequest({
      repo: rig.workspace.repo,
      head: BRANCH,
      base: 'main',
      title: 't',
      body: 'b',
    });
    await rig.store.sideEffects.intend(prRecord(`${PLAY}:pr:${BRANCH}:main`));
    const report = await reconcileBeforeResume(rig.deps());
    expect(report.effectsResolved).toBe(1);
    expect(report.pending).toEqual([]);
    expect(await rig.store.sideEffects.get(`${PLAY}:pr:${BRANCH}:main`)).toMatchObject({
      state: 'done',
      verifier: 'verifier',
      result: { number: 1 },
    });
    expect(rig.fake.pullRequests()).toHaveLength(1);
  });

  it('takes as not done what the verifier does not find', async () => {
    await pushHead();
    await rig.store.sideEffects.intend(prRecord(`${PLAY}:pr:${BRANCH}:main`));
    const report = await reconcileBeforeResume(rig.deps());
    expect(report.effectsResolved).toBe(1);
    expect(await rig.store.sideEffects.get(`${PLAY}:pr:${BRANCH}:main`)).toMatchObject({
      state: 'not_done',
      verifier: 'verifier',
    });
    expect(await rig.store.decisions.list({})).toEqual([]);
  });

  it('asks the Producer, once, about an effect no verifier knows', async () => {
    const key = `${PLAY}:mystery:1`;
    await rig.store.sideEffects.intend({ ...prRecord(key, 'mystery') });
    const first = await reconcileBeforeResume(rig.deps());
    expect(first.effectsResolved).toBe(0);
    expect(first.pending).toEqual([
      expect.objectContaining({ key, effectType: 'mystery', playId: PLAY }),
    ]);
    expect((await rig.store.sideEffects.get(key))?.state).toBe('ambiguous');
    const asked = await rig.store.decisions.list({});
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      id: recoveryDecisionId(PLAY, key),
      kind: DECISION_KINDS.recovery,
      playId: PLAY,
      state: 'pending',
    });
    expect(asked[0]?.input).toMatchObject({ key, options: ['not_done', 'done'] });

    // A second start finds the same effect, and does not ask again.
    const second = await reconcileBeforeResume(rig.deps());
    expect(second.pending).toHaveLength(1);
    expect(await rig.store.decisions.list({})).toHaveLength(1);
  });

  it('recovery.notice effect_unsettled: the effect that waits for the Producer is an event of its play, and a settled one is not (P24, N146)', async () => {
    const key = `${PLAY}:mystery:1`;
    await rig.store.sideEffects.intend({ ...prRecord(key, 'mystery') });
    const situations = new RecordingSituations();
    await reconcileBeforeResume(rig.deps({ situations }));
    expect(situations.recorded).toEqual([
      {
        type: 'recovery.notice',
        payload: {
          kind: 'effect_unsettled',
          subject: 'mystery',
          detail: expect.any(String) as string,
        },
        correlation: { scenarioId: 'scenario-1', playId: PLAY },
      },
    ]);
    // A second start does not ask again, so it does not say it again.
    await reconcileBeforeResume(rig.deps({ situations }));
    expect(situations.recorded).toHaveLength(1);

    const settled = new RecordingSituations();
    rig.launcher.plantOrphan(1, 1);
    await reconcileBeforeResume(rig.deps({ situations: settled }));
    expect(settled.recorded).toEqual([]);
  });

  it('asks the Producer when there is no code host to check against', async () => {
    const key = `${PLAY}:pr:${BRANCH}:main`;
    await rig.store.sideEffects.intend(prRecord(key));
    const report = await reconcileBeforeResume(rig.deps({ codeHost: undefined }));
    expect(report.pending).toHaveLength(1);
    expect((await rig.store.sideEffects.get(key))?.state).toBe('ambiguous');
    expect(await rig.store.decisions.list({})).toHaveLength(1);
  });

  it('records an effect of no open play as pending without asking anyone', async () => {
    const key = 'other-play:mystery:1';
    await rig.store.sideEffects.intend({ ...prRecord(key, 'mystery') });
    const report = await reconcileBeforeResume(rig.deps());
    expect(report.pending).toEqual([expect.objectContaining({ key, playId: null })]);
    expect(await rig.store.decisions.list({})).toEqual([]);
  });

  it('settles an open install as not done with no code host, so the next call runs it', async () => {
    const key = `${PLAY}:install_deps:${PLAY}/d1/1:1`;
    await rig.store.sideEffects.intend({
      idempotencyKey: key,
      type: 'install_deps',
      target: '/wt',
      params: { callHash: 'h', openPolicy: 'rerun' },
    });
    const report = await reconcileBeforeResume(rig.deps({ codeHost: undefined }));
    expect(report.effectsResolved).toBe(1);
    expect(report.pending).toEqual([]);
    expect(await rig.store.sideEffects.get(key)).toMatchObject({
      state: 'not_done',
      verifier: 'verifier',
    });
    expect(await rig.store.decisions.list({})).toEqual([]);
  });

  it('asks the Producer, once, about an open shell command or an install set to ask', async () => {
    const shell = `${PLAY}:restricted_shell:${PLAY}/d1/1:1`;
    const install = `${PLAY}:install_deps:${PLAY}/d1/1:1`;
    await rig.store.sideEffects.intend({
      idempotencyKey: shell,
      type: 'restricted_shell',
      target: '/wt',
      params: { callHash: 'h', openPolicy: 'ask' },
    });
    await rig.store.sideEffects.intend({
      idempotencyKey: install,
      type: 'install_deps',
      target: '/wt',
      params: { callHash: 'h', openPolicy: 'ask' },
    });
    const first = await reconcileBeforeResume(rig.deps());
    expect(first.effectsResolved).toBe(0);
    expect(first.pending.map((effect) => effect.key).sort()).toEqual([install, shell].sort());
    expect(await rig.store.decisions.list({})).toHaveLength(2);
    expect((await rig.store.sideEffects.get(shell))?.state).toBe('ambiguous');
    await reconcileBeforeResume(rig.deps());
    expect(await rig.store.decisions.list({})).toHaveLength(2);
  });

  it('lets the verifier of a plugin settle the effect of the plugin', async () => {
    const plugins = new PluginEffectRegistry();
    plugins.register('fake', {
      type: 'fake.send',
      verify: (record) =>
        Promise.resolve({ verdict: 'done', result: { seen: record.idempotencyKey } }),
    });
    const key = `${PLAY}:fake.send:1`;
    await rig.store.sideEffects.intend({ idempotencyKey: key, type: 'fake.send', target: 'x' });
    const report = await reconcileBeforeResume(
      rig.deps({ codeHost: undefined, pluginEffects: plugins }),
    );
    expect(report.effectsResolved).toBe(1);
    expect(await rig.store.sideEffects.get(key)).toMatchObject({
      state: 'done',
      result: { seen: key },
    });
  });

  it('leaves settled effects alone', async () => {
    const key = `${PLAY}:push:x`;
    await rig.store.sideEffects.intend({ ...prRecord(key, 'git_push') });
    await rig.store.sideEffects.resolve(key, { state: 'done', result: {}, verifier: null });
    const report = await reconcileBeforeResume(rig.deps());
    expect(report.effectsResolved).toBe(0);
    expect(report.pending).toEqual([]);
  });
});
