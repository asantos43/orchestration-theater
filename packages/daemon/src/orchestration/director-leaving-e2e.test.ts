// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import type {
  ScenarioDirectorFailoverNotice,
  ScenarioSystemMessagePayload,
} from '@otheater/protocol';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayFakes,
  type PlayHarness,
  type PlayHarnessOptions,
} from './e2e-fixture.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * The Director on the profile that is being removed (P21b, N153): with `profiles.drain.director:
 * failover` it moves to the next Executor of its list through the failover of P20 (cause
 * `profile_removed`) and the removal finishes; with `wait` it holds the profile as before. The
 * client is the compiled fake agent; the clock is a fake one, so no drain timeout ever fires.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const ROLES = ['director', 'consultant', 'author', 'reviewer', 'scriptwriter', 'actor', 'critic'];
const entry = (profile: string): string => `fake-model@fake/${profile}`;

function rolesConfig(director: readonly string[], rest = ''): string {
  const registry = ['one', 'two', 'three']
    .map(
      (profile) =>
        `  ${entry(profile)}:\n    client: fake\n    profile: ${profile}\n    model: fake-model\n`,
    )
    .join('');
  const roles = ROLES.map(
    (role) =>
      `  ${role}:\n    executors: [${(role === 'director' ? director : ['three']).map(entry).join(', ')}]\n`,
  ).join('');
  return `executors:\n${registry}roles:\n${roles}selection:\n  recheck_every: off\n${rest}`;
}

const DRAIN_WAIT = 'profiles:\n  drain:\n    director: wait\n';

const HOUR = 3_600_000;

interface Rig {
  readonly harness: PlayHarness;
  readonly clock: FakeClock;
  /** The state directory the fake agents of the test share. */
  readonly stateDir: () => string;
}

async function withLeavingDaemon(
  options: PlayHarnessOptions,
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  let stateDir = '';
  const set: PlayFakes & { readonly clock: FakeClock } = {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) => {
      stateDir = env.FAKE_AGENT_STATE_DIR ?? stateDir;
      return new FakeClientAdapter({
        launcher,
        baseEnv: {},
        env,
        adapterVersion: '1.0.0',
        command,
      });
    },
  };
  await withDaemon(set, options, async (harness) => {
    for (const name of ['one', 'two', 'three']) {
      await harness.daemon.store.profiles.create({
        client: 'fake',
        name,
        kind: 'token_plan',
        provider: 'fake',
        dir: `${harness.dataDir}/profiles/fake/${name}`,
        secretRef: null,
      });
    }
    await body({ harness, clock: set.clock, stateDir: () => stateDir });
  });
}

async function notices(
  harness: PlayHarness,
  scenarioId: string,
): Promise<ScenarioDirectorFailoverNotice[]> {
  const events = await harness.daemon.store.events.readFrom(0, 100_000);
  return events
    .filter((event) => event.scenarioId === scenarioId && event.type === 'scenario.system_message')
    .map((event) => event.payload as unknown as ScenarioSystemMessagePayload)
    .filter((payload): payload is ScenarioDirectorFailoverNotice => {
      return payload.kind === 'director_failover';
    });
}

async function repliesOf(harness: PlayHarness, scenarioId: string): Promise<string[]> {
  return (await harness.producer.poll(scenarioId, 0)).replies.map((reply) => reply.text);
}

async function waitForReply(
  harness: PlayHarness,
  scenarioId: string,
  text: string,
): Promise<string> {
  return waitFor(`a reply with "${text}"`, async () =>
    (await repliesOf(harness, scenarioId)).find((reply) => reply.includes(text)),
  );
}

async function directorExecutors(harness: PlayHarness): Promise<string[]> {
  const events = await harness.daemon.store.events.readFrom(0, 100_000);
  return events
    .filter((event) => event.type === 'executor.selected')
    .map((event) => event.payload as unknown as { role: string; executor: string | null })
    .filter((payload) => payload.role === 'director' && payload.executor !== null)
    .map((payload) => String(payload.executor));
}

describeWithLauncher('the Director on the profile that leaves (P21b)', { timeout: 180_000 }, () => {
  it('an idle Director moves to the next Executor and the removal finishes', async () => {
    await withLeavingDaemon({ extra: rolesConfig(['one', 'two']) }, async ({ harness }) => {
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-chat first');
      await waitForReply(harness, scenarioId, 'answer: first');
      expect(await directorExecutors(harness)).toEqual([entry('one')]);

      const removed = await harness.daemon.profiles.remove('fake/one', { timeoutMs: 0 });
      expect(removed.profile.state).toBe('removed');
      expect(removed.drain).toMatchObject({ outcome: 'finished' });

      const notice = await waitFor('the failover notice', async () =>
        (await notices(harness, scenarioId)).find((item) => item.outcome === 'switched'),
      );
      expect(notice).toMatchObject({
        kind: 'director_failover',
        cause: 'profile_removed',
        fromExecutor: entry('one'),
        toExecutor: entry('two'),
        requeued: null,
      });
      // The conversation was rebuilt from the store: the new session answers the next prompt.
      await harness.producer.send(scenarioId, '#ot-chat second');
      await waitForReply(harness, scenarioId, 'answer: second');
      expect(await directorExecutors(harness)).toEqual([entry('one'), entry('two')]);
      expect(await notices(harness, scenarioId)).toHaveLength(1);
    });
  });

  it('a turn in progress is cut, its prompt goes back to the queue and the new Executor answers it', async () => {
    await withLeavingDaemon(
      { extra: rolesConfig(['one', 'two']) },
      async ({ harness, stateDir }) => {
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.send(scenarioId, '#ot-director-hang\n#ot-chat hello');
        await waitFor('the Director turn to hang', () =>
          Promise.resolve(existsSync(join(stateDir(), 'director-hang.count'))),
        );

        const removed = await harness.daemon.profiles.remove('fake/one', { timeoutMs: 0 });
        expect(removed.profile.state).toBe('removed');

        // The play is not lost: the prompt in progress is answered by the second Executor.
        await waitForReply(harness, scenarioId, 'answer: hello');
        expect(await directorExecutors(harness)).toEqual([entry('one'), entry('two')]);
        const notice = await waitFor('the failover notice', async () =>
          (await notices(harness, scenarioId)).find((item) => item.outcome === 'switched'),
        );
        expect(notice).toMatchObject({
          cause: 'profile_removed',
          fromExecutor: entry('one'),
          toExecutor: entry('two'),
        });
        expect(notice.requeued).not.toBeNull();
        const queue = await harness.daemon.store.promptQueue.list({ scenarioId });
        expect(queue.filter((item) => item.state === 'pending')).toEqual([]);
      },
    );
  });

  it('with profiles.drain.director: wait the Director holds the profile, as before', async () => {
    await withLeavingDaemon(
      { extra: rolesConfig(['one', 'two'], DRAIN_WAIT) },
      async ({ harness }) => {
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.send(scenarioId, '#ot-chat first');
        await waitForReply(harness, scenarioId, 'answer: first');

        await expect(harness.daemon.profiles.remove('fake/one', { timeoutMs: 0 })).rejects.toThrow(
          /still has running sessions/,
        );
        expect((await harness.daemon.store.profiles.get('fake/one'))?.state).toBe('draining');
        expect(await notices(harness, scenarioId)).toEqual([]);
        expect(await directorExecutors(harness)).toEqual([entry('one')]);
      },
    );
  });

  it('with no Executor to go to, the notice says so, the prompt is kept and the removal is not held', async () => {
    await withLeavingDaemon({ extra: rolesConfig(['one']) }, async ({ harness }) => {
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-chat first');
      await waitForReply(harness, scenarioId, 'answer: first');

      const removed = await harness.daemon.profiles.remove('fake/one', { timeoutMs: 0 });
      expect(removed.profile.state).toBe('removed');

      const unavailable = await waitFor('the unavailable notice', async () =>
        (await notices(harness, scenarioId)).find((item) => item.outcome === 'unavailable'),
      );
      expect(unavailable).toMatchObject({
        cause: 'profile_removed',
        fromExecutor: entry('one'),
        toExecutor: null,
      });
      // The prompt that comes next waits in the queue, kept.
      await harness.producer.send(scenarioId, '#ot-chat later');
      await waitFor('the prompt in the queue', async () =>
        (await harness.daemon.store.promptQueue.list({ scenarioId })).some(
          (item) => item.state === 'pending',
        ),
      );
      expect(await repliesOf(harness, scenarioId)).not.toContain('answer: later');
    });
  });

  it('with Executors that are only waiting for their quota the Director waits (P16b) and the removal is not held', async () => {
    await withLeavingDaemon({ extra: rolesConfig(['one', 'two']) }, async ({ harness, clock }) => {
      const resetsAt = clock.now() + HOUR;
      await harness.daemon.quota.ingestLimitHit(
        { client: 'fake', profile: 'two' },
        { source: 'limit_hit:test', resetsAt },
      );
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-chat first');
      await waitForReply(harness, scenarioId, 'answer: first');
      expect(await directorExecutors(harness)).toEqual([entry('one')]);

      const removed = await harness.daemon.profiles.remove('fake/one', { timeoutMs: 0 });
      expect(removed.profile.state).toBe('removed');
      const waiting = await waitFor('the wait notice', async () =>
        (await notices(harness, scenarioId)).find((item) => item.outcome === 'waiting'),
      );
      expect(waiting).toMatchObject({
        cause: 'profile_removed',
        fromExecutor: entry('one'),
        toExecutor: null,
      });

      // The prompt waits; when `two` is back the Director goes on with it.
      await harness.producer.send(scenarioId, '#ot-chat later');
      await clock.advance(HOUR + 1);
      await harness.daemon.wakeups.reconcile('fake/two');
      await waitForReply(harness, scenarioId, 'answer: later');
      expect(await directorExecutors(harness)).toEqual([entry('one'), entry('two')]);
    });
  });
});
