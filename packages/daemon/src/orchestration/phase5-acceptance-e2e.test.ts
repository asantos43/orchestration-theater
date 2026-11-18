// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import type { EventEnvelope } from '@otheater/core';
import { dataPaths, profileDirOf } from '../paths.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayFakes,
  type PlayHarness,
} from './e2e-fixture.js';

/**
 * The acceptance of Phase 5 with the fake agent (P23): the five items of the criterion in one play
 * of one daemon. The client is the compiled `dist/cli.js` of the fake agent; the clock is a fake
 * one, so the only time that passes is the one the test lets pass.
 *
 * One play (`execution_failure`: the Critic rejects its first look, the Director sends alpha back,
 * beta is rebased) with the Actors on three profiles of the same client (`a1`, `a2`, `a3`) and the
 * Director on two (`d1`, `d2`). The tokens in the need steer the fake Actors (`#actor-*`).
 *
 * 1. alpha runs on `a1`, which runs out (the end of the limit is far); beta is sent to `a2`, and
 *    the event of the selection says why `a1` was skipped (item 1).
 * 2. alpha, on `a1`, commits and installs, then runs out; the baton passes to `a2`, which repeats
 *    both calls and finds them done (item 4).
 * 3. beta runs out on `a2` with a near reset and `roles.actor.when_exhausted: wait`: it waits, and
 *    resumes natively on the same session when the clock passes the reset (item 5).
 * 4. The Critic rejects; the first judgment prompt makes `d1` run out: `d2` answers it (item 3).
 * 5. alpha, in its second round, is on `a2` and does not end by itself; the test removes `a2`
 *    with the session in progress and the baton passes to `a3` (item 2).
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const HOUR = 3_600_000;
const MINUTE = 60_000;
const ROLES = ['director', 'consultant', 'author', 'reviewer', 'scriptwriter', 'actor', 'critic'];
const entry = (profile: string): string => `fake-model@fake/${profile}`;

/** The lists of the roles: the Director on `d1` and `d2`, the Actors on `a1`, `a2` and `a3`. */
function rolesConfig(): string {
  const registry = ['d1', 'd2', 'a1', 'a2', 'a3', 'x']
    .map(
      (profile) =>
        `  ${entry(profile)}:\n    client: fake\n    profile: ${profile}\n    model: fake-model\n`,
    )
    .join('');
  const lists: Record<string, readonly string[]> = {
    director: ['d1', 'd2'],
    actor: ['a1', 'a2', 'a3'],
  };
  const roles = ROLES.map(
    (role) =>
      `  ${role}:\n    executors: [${(lists[role] ?? ['x']).map(entry).join(', ')}]\n${
        role === 'actor' ? '    when_exhausted: wait\n' : ''
      }`,
  ).join('');
  const install = JSON.stringify([
    'node',
    '-e',
    // The sandbox of the commands writes inside the worktree only: the log is a file of it.
    `require('node:fs').appendFileSync('install.log', 'run\\n')`,
  ]);
  return [
    `executors:\n${registry}roles:\n${roles}`,
    'selection:\n  recheck_every: off',
    'profiles:\n  drain:\n    on_timeout: handoff',
    `tools:\n  commands:\n    install: ${install}`,
  ].join('\n');
}

function fakes(): PlayFakes & { readonly clock: FakeClock } {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

async function registerProfiles(harness: PlayHarness): Promise<void> {
  for (const name of ['d1', 'd2', 'a1', 'a2', 'a3', 'x']) {
    // The profile `a2` is the one the test removes: its directory is the one the daemon would
    // have made, so the removal accepts it (`removeProfileDir` recomputes the path).
    const dir =
      name === 'a2'
        ? profileDirOf(dataPaths(harness.dataDir), { client: 'fake', profile: name })
        : `${harness.dataDir}/profiles-of-the-test/${name}`;
    if (name === 'a2') await mkdir(dir, { recursive: true });
    await harness.daemon.store.profiles.create({
      client: 'fake',
      name,
      kind: 'token_plan',
      provider: 'fake',
      dir,
      secretRef: null,
    });
  }
}

async function allEvents(harness: PlayHarness): Promise<readonly EventEnvelope[]> {
  return harness.daemon.store.events.readFrom(0, 100_000);
}

type Payload = Record<string, unknown>;

/** The value a lookup of the test must have found. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('the test expected to find this event');
  return value;
}

const payloadOf = (event: EventEnvelope): Payload => event.payload;
const ofType = (events: readonly EventEnvelope[], type: string): readonly EventEnvelope[] =>
  events.filter((event) => event.type === type);
const indexOfType = (
  events: readonly EventEnvelope[],
  type: string,
  where: (payload: Payload) => boolean = () => true,
): number => events.findIndex((event) => event.type === type && where(payloadOf(event)));
const profileOf = (value: unknown): unknown => (value as { profile?: unknown }).profile;

describe('the acceptance of Phase 5 with the fake agent (P23)', { timeout: 240_000 }, () => {
  it('runs the five items in one play', async () => {
    const set = fakes();
    let directorPid: number | undefined;
    await withDaemon(set, { extra: rolesConfig() }, async (harness) => {
      await registerProfiles(harness);
      const now = set.clock.now();
      const far = new Date(now + 6 * HOUR).toISOString();
      const near = new Date(now + 10 * MINUTE).toISOString();
      const need = [
        'write alpha and beta #outcome:execution_failure',
        '#actor-effects:alpha',
        `#actor-quota:alpha=${far}@1`,
        `#actor-quota:beta=${near}@1`,
        '#actor-hang:alpha@2',
      ].join(' ');
      const scenarioId = await harness.openChat();
      await harness.producer.send(
        scenarioId,
        `#ot-director-fail:quota\n#ot-director-fail-on:judge\n#ot-director-fail-resets:${far}\n#ot-play ${need}`,
      );
      const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);

      // beta ran out with a near reset and the rule `wait`: it is waiting for the clock.
      await waitFor('beta waiting for the reset', async () =>
        (await harness.eventsOf(play.id)).some(
          (event) => event.type === 'attempt.reset_wait_started',
        )
          ? true
          : undefined,
      );
      const waiting = await harness.daemon.store.attempts.list();
      expect(waiting.find((a) => a.demandId === 'beta')?.state).toBe('awaiting_resume');
      await set.clock.advance(11 * MINUTE);
      await harness.daemon.wakeups.reconcile('fake/a2');

      // alpha, sent back by the Critic, hangs on `a2` (the profile the test takes away).
      const hanging = await waitFor('alpha round 2 on a2', async () => {
        const attempts = await harness.daemon.store.attempts.list();
        const redo = attempts.find((a) => a.demandId === 'alpha' && a.attempt === 2);
        return redo?.profile === 'a2' && redo.state === 'executing' ? redo : undefined;
      });
      expect(hanging.client).toBe('fake');
      await waitFor('alpha 2 is working', async () =>
        (await allEvents(harness)).some(
          (event) =>
            event.type === 'session.update' &&
            payloadOf(event).attemptId === `${play.id}/alpha/2` &&
            JSON.stringify(payloadOf(event).update).includes('does not end by itself'),
        )
          ? true
          : undefined,
      );
      const removal = await harness.daemon.profiles.remove('fake/a2', { timeoutMs: 0 });
      expect(removal).toBeDefined();
      const done = await waitFor('the play is done', async () => {
        const record = await harness.daemon.store.plays.get(play.id);
        return record?.state === 'DONE' ? record : undefined;
      });
      expect(done.state).toBe('DONE');

      const events = await allEvents(harness);
      const playEvents = events.filter((event) => event.playId === play.id);

      // ---- Item 1: two profiles of one client; one runs out and the selection goes to the other.
      const a1Exhausted = indexOfType(events, 'quota.exhausted', (p) => p.profile === 'fake/a1');
      expect(a1Exhausted).toBeGreaterThanOrEqual(0);
      const actorSelections = playEvents.filter(
        (event) => event.type === 'executor.selected' && payloadOf(event).role === 'actor',
      );
      const profilesSelected = actorSelections.map((event) => payloadOf(event).profile);
      expect(profilesSelected.slice(0, 3)).toEqual(['fake/a1', 'fake/a2', 'fake/a2']);
      const afterExhaustion = actorSelections.find((event) =>
        (payloadOf(event).skipped as { profile: string; reason: string }[]).some(
          (skip) => skip.profile === 'fake/a1' && skip.reason === 'quota',
        ),
      );
      expect(afterExhaustion).toBeDefined();
      expect(payloadOf(must(afterExhaustion)).outcome).toBe('selected');
      expect(payloadOf(must(afterExhaustion)).profile).toBe('fake/a2');

      // ---- Item 4: alpha interrupted by quota, the baton goes to `a2`, nothing is redone.
      const alphaHandoff = playEvents.find(
        (event) =>
          event.type === 'session.interrupted' &&
          payloadOf(event).attemptId === `${play.id}/alpha/1`,
      );
      expect(payloadOf(must(alphaHandoff))).toMatchObject({
        cause: 'quota_exhausted',
        form: 'handoff',
        from: { client: 'fake', profile: 'a1' },
        to: { client: 'fake', profile: 'a2' },
      });
      const alphaPackage = ofType(playEvents, 'session.handoff').find(
        (event) => payloadOf(event).attemptId === `${play.id}/alpha/1`,
      );
      expect(payloadOf(must(alphaPackage))).toMatchObject({
        cause: 'quota_exhausted',
        countedAsAttempt: false,
        packageCut: false,
      });
      const effects = await harness.daemon.store.sideEffects.list({
        types: ['git_commit', 'install_deps'],
      });
      const ofAlphaOne = effects.filter((effect) => effect.attemptId === `${play.id}/alpha/1`);
      const commits = ofAlphaOne.filter((effect) => effect.type === 'git_commit');
      const installs = ofAlphaOne.filter((effect) => effect.type === 'install_deps');
      // One commit and one install happened. The second session asked for the commit again: the
      // row of that step says `empty` (nothing was left to commit), not a new commit.
      expect(commits.map((effect) => effect.result?.outcome)).toEqual(['committed', 'empty']);
      expect(commits.every((effect) => effect.state === 'done')).toBe(true);
      expect(installs.map((effect) => effect.state)).toEqual(['done']);
      expect(new Set(ofAlphaOne.map((effect) => effect.idempotencyKey)).size).toBe(3);
      const replies = playEvents
        .filter(
          (event) =>
            event.type === 'session.update' && payloadOf(event).attemptId === `${play.id}/alpha/1`,
        )
        .map((event) => JSON.stringify(payloadOf(event).update));
      expect(replies.filter((line) => line.includes('git_commit: done'))).toHaveLength(1);
      expect(replies.filter((line) => line.includes('git_commit: refused'))).toHaveLength(1);
      expect(replies.filter((line) => line.includes('nothing_to_commit'))).toHaveLength(1);
      expect(replies.filter((line) => line.includes('install_deps: done'))).toHaveLength(2);
      expect(replies.filter((line) => line.includes('\\"reused\\":true'))).toHaveLength(1);
      const attempts = await harness.daemon.store.attempts.list();
      const alphaOne = attempts.find((a) => a.demandId === 'alpha' && a.attempt === 1);
      expect(alphaOne?.state).toBe('completed');
      const subjects = (
        await testGit(alphaOne?.worktree ?? '', 'log', '--format=%s', 'main..HEAD')
      ).split('\n');
      // The commit of the Actor, once, and the checkpoint of the interruption on top of it.
      expect(subjects.filter((line) => line === 'alpha: write alpha.txt')).toHaveLength(1);
      expect(subjects.filter((line) => line.startsWith('wip(checkpoint)'))).toHaveLength(1);
      expect(subjects).toHaveLength(2);
      expect(await readFile(join(alphaOne?.worktree ?? '', 'install.log'), 'utf8')).toBe('run\n');
      // beta has no effects at all, and alpha's second round no commit of the tool.
      expect(effects.filter((effect) => effect.attemptId?.includes('/beta/'))).toEqual([]);

      // ---- Item 5: beta, rule `wait`, resumed natively after the reset (fake clock).
      const betaId = `${play.id}/beta/1`;
      const betaEvents = playEvents.filter((event) => payloadOf(event).attemptId === betaId);
      const betaTypes = betaEvents.map((event) => event.type);
      expect(betaTypes).not.toContain('session.handoff');
      const betaInterrupted = betaEvents.find((event) => event.type === 'session.interrupted');
      expect(payloadOf(must(betaInterrupted))).toMatchObject({
        cause: 'quota_exhausted',
        form: 'native',
        from: { profile: 'a2' },
        to: { profile: 'a2' },
      });
      const started = betaEvents.find((event) => event.type === 'attempt.reset_wait_started');
      expect(payloadOf(must(started))).toMatchObject({
        cause: 'quota_exhausted',
        resetsAt: now + 10 * MINUTE,
        afterRestart: false,
      });
      const ended = betaEvents.find((event) => event.type === 'attempt.reset_wait_ended');
      expect(payloadOf(must(ended))).toMatchObject({
        outcome: 'restored',
        waitedMs: 10 * MINUTE,
      });
      const betaResumed = betaEvents.find((event) => event.type === 'session.resumed');
      expect(payloadOf(must(betaResumed))).toMatchObject({
        form: 'native',
        sessionId: payloadOf(must(betaInterrupted)).sessionId,
      });
      expect(betaTypes.indexOf('attempt.reset_wait_started')).toBeLessThan(
        betaTypes.indexOf('attempt.reset_wait_ended'),
      );
      expect(betaTypes.indexOf('attempt.reset_wait_ended')).toBeLessThan(
        betaTypes.indexOf('session.resumed'),
      );
      expect(ofType(events, 'quota.restored').map((event) => payloadOf(event).profile)).toContain(
        'fake/a2',
      );
      expect(attempts.filter((a) => a.demandId === 'beta')).toHaveLength(1);
      expect(attempts.find((a) => a.demandId === 'beta')?.state).toBe('completed');

      // ---- Item 3: the Director runs out at the judgment point; the other one answers it.
      const failover = events.find(
        (event) =>
          event.type === 'scenario.system_message' && payloadOf(event).kind === 'director_failover',
      );
      expect(payloadOf(must(failover))).toMatchObject({
        outcome: 'switched',
        cause: 'quota_exhausted',
        fromExecutor: entry('d1'),
        toExecutor: entry('d2'),
      });
      expect(payloadOf(must(failover)).requeued).toEqual(expect.any(String));
      const directorSelections = events.filter(
        (event) => event.type === 'executor.selected' && payloadOf(event).role === 'director',
      );
      expect(directorSelections.map((event) => payloadOf(event).profile)).toEqual([
        'fake/d1',
        'fake/d2',
      ]);
      expect(
        (payloadOf(must(directorSelections[1])).skipped as { profile: string }[]).map(
          (skip) => skip.profile,
        ),
      ).toEqual(['fake/d1']);
      expect(
        indexOfType(events, 'quota.exhausted', (p) => p.profile === 'fake/d1'),
      ).toBeGreaterThan(-1);
      // The play went on from the judgment: alpha has a second round, ordered by the new Director.
      expect(events.indexOf(must(failover))).toBeLessThan(
        events.findIndex((event) => payloadOf(event).attemptId === `${play.id}/alpha/2`),
      );
      expect(ofType(events, 'play.created')).toHaveLength(1);

      // ---- Item 2: removing `a2` with a session in progress loses no demand.
      const draining = events.find((event) => event.type === 'profile.draining');
      expect(payloadOf(must(draining))).toMatchObject({
        profileId: 'fake/a2',
        activeSessions: 1,
        onTimeout: 'handoff',
      });
      expect(
        payloadOf(must(events.find((event) => event.type === 'profile.drained'))),
      ).toMatchObject({ profileId: 'fake/a2', outcome: 'handoff', sessions: 1 });
      expect(
        payloadOf(must(events.find((event) => event.type === 'profile.removed'))),
      ).toMatchObject({ profileId: 'fake/a2', loggedOut: true, dir: 'deleted' });
      // The name of the cause is not asserted (it changes with P21b): the form and the Executors are.
      const leaving = playEvents.find(
        (event) =>
          event.type === 'session.interrupted' &&
          payloadOf(event).attemptId === `${play.id}/alpha/2`,
      );
      expect(payloadOf(must(leaving))).toMatchObject({
        form: 'handoff',
        from: { client: 'fake', profile: 'a2' },
        to: { client: 'fake', profile: 'a3' },
      });
      expect(profileOf(payloadOf(must(leaving)).to)).toBe('a3');
      const alphaTwo = attempts.find((a) => a.demandId === 'alpha' && a.attempt === 2);
      expect(alphaTwo).toMatchObject({ profile: 'a3', state: 'completed' });
      expect(
        ofType(playEvents, 'attempt.submitted').filter(
          (event) => payloadOf(event).attemptId === `${play.id}/alpha/2`,
        ),
      ).toHaveLength(1);
      const profile = await harness.daemon.store.profiles.get('fake/a2');
      expect(profile?.state).toBe('removed');
      expect(existsSync(profile?.dir ?? '')).toBe(false);

      // ---- Every item: the end state, no demand lost, no session or process left.
      expect(await harness.pathOf(play.id)).toContain('DONE');
      const demands = await harness.daemon.store.demands.list({ playId: play.id });
      expect(demands.map((demand) => demand.id).sort()).toEqual(
        expect.arrayContaining(['alpha', 'beta']),
      );
      for (const demand of demands.filter((d) => !d.id.startsWith('stage-'))) {
        expect(demand.state).toBe('approved');
      }
      expect(attempts.filter((a) => a.state !== 'completed' && a.state !== 'failed')).toEqual([]);
      expect(
        await harness.daemon.store.attempts.list({
          states: ['executing', 'interrupted', 'awaiting_resume', 'resuming'],
        }),
      ).toEqual([]);
      // Only the process of the Director (one per chat) is alive while the daemon runs: the
      // sessions of the Actors and the stages, and the Director that ran out, are all closed.
      const open = await harness.daemon.store.sessions.list({
        states: ['active', 'interrupted', 'awaiting_resume', 'resuming'],
      });
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ profile: 'launcher', attemptId: null });
      directorPid = open[0]?.pid ?? undefined;
      expect(ofType(events, 'session.processes_left')).toEqual([]);
      expect(
        ofType(events, 'daemon.notice').filter((e) => payloadOf(e).kind !== 'deprecated_config'),
      ).toEqual([]);
    });
    // The daemon is stopped: the process of the Director went with it.
    expect(directorPid).toBeDefined();
    expect(() => process.kill(must(directorPid), 0)).toThrow(/ESRCH/);
  });
});
