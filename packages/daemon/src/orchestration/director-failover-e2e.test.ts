// SPDX-License-Identifier: MPL-2.0
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
 * The failover of the Director (P20): the fake agent ends the first turn of the Director with a
 * quota error (`#ot-director-fail:quota`), the daemon opens a new session with the next Executor
 * of the `director` role, with the state summary, and the prompt that was in progress is answered
 * by it. The client is the compiled `dist/cli.js` of the fake agent; the clock is a fake one.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const ROLES = ['director', 'consultant', 'author', 'reviewer', 'scriptwriter', 'actor', 'critic'];
const entry = (profile: string): string => `fake-model@fake/${profile}`;
const HOUR = 3_600_000;

/** The registry of the profiles and the lists of the roles (the Director's is `director`). */
function rolesConfig(director: readonly string[], rest = '', scenarios = ''): string {
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
  return (
    `executors:\n${registry}roles:\n${roles}selection:\n  recheck_every: off\n${rest}` +
    (scenarios === '' ? '' : `scenarios:\n${scenarios}`)
  );
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

async function withFailoverDaemon(
  options: PlayHarnessOptions,
  body: (harness: PlayHarness, clock: FakeClock) => Promise<void>,
): Promise<void> {
  const set = fakes();
  await withDaemon(set, options, async (harness) => {
    for (const name of ['one', 'two', 'three']) {
      await harness.daemon.store.profiles.create({
        client: 'fake',
        name,
        kind: 'token_plan',
        provider: 'fake',
        dir: `${harness.dataDir}/profiles-of-the-test/${name}`,
        secretRef: null,
      });
    }
    await body(harness, set.clock);
  });
}

async function scenarioEvents(harness: PlayHarness, scenarioId: string) {
  const events = await harness.daemon.store.events.readFrom(0, 100_000);
  return events.filter((event) => event.scenarioId === scenarioId);
}

/** The `director_failover` notices of the scenario, as the log has them, in order. */
async function failovers(
  harness: PlayHarness,
  scenarioId: string,
): Promise<ScenarioDirectorFailoverNotice[]> {
  return (await scenarioEvents(harness, scenarioId))
    .filter((event) => event.type === 'scenario.system_message')
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

/** The prompt queue of the scenario, in delivery order. */
async function promptsOf(harness: PlayHarness, scenarioId: string) {
  return harness.daemon.store.promptQueue.list({ scenarioId });
}

describeWithLauncher('the failover of the Director (P20)', { timeout: 180_000 }, () => {
  it('opens the next Executor when the quota runs out mid-turn, with the directives, and answers the prompt', async () => {
    await withFailoverDaemon({ extra: rolesConfig(['one', 'two']) }, async (harness) => {
      await harness.daemon.directives.create({ text: 'Always answer in haiku.', scope: 'global' });
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-director-fail:quota\n#ot-chat hello');

      // The prompt in progress was not lost: the second session answers it.
      const reply = await waitForReply(harness, scenarioId, 'answer: hello');
      // The summary reached it with the directives in force.
      expect(reply).toContain('directives in force: Always answer in haiku.');
      expect(await directorExecutors(harness)).toEqual([entry('one'), entry('two')]);

      const [notice, ...others] = await waitFor('the failover notice', async () => {
        const found = await failovers(harness, scenarioId);
        return found.length > 0 ? found : undefined;
      });
      expect(others).toEqual([]);
      expect(notice).toMatchObject({
        kind: 'director_failover',
        outcome: 'switched',
        cause: 'quota_exhausted',
        fromExecutor: entry('one'),
        toExecutor: entry('two'),
      });
      expect(notice?.requeued).not.toBeNull();

      // One prompt, answered once, none left in the queue.
      const queue = await promptsOf(harness, scenarioId);
      expect(queue.filter((item) => item.state === 'pending')).toEqual([]);
      expect(queue.filter((item) => item.source === 'producer')).toHaveLength(1);
      // The quota service knows `one` is out: the next prompt goes to `two` without a new failover.
      await harness.producer.send(scenarioId, '#ot-chat again');
      await waitForReply(harness, scenarioId, 'answer: again');
      expect(await failovers(harness, scenarioId)).toHaveLength(1);
    });
  });

  it('writes the notice for the chat of the Producer as a system message event', async () => {
    await withFailoverDaemon({ extra: rolesConfig(['one', 'two']) }, async (harness) => {
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-director-fail:quota\n#ot-chat hello');
      const notices = await waitFor('the notice event', async () => {
        const found = (await harness.daemon.store.events.readFrom(0, 100_000)).filter(
          (event) => event.type === 'scenario.system_message' && event.scenarioId === scenarioId,
        );
        return found.length > 0 ? found : undefined;
      });
      expect(notices[0]?.payload).toMatchObject({ kind: 'director_failover', outcome: 'switched' });
    });
  });

  it('waits with no Executor, tells the Producer and goes on at quota.restored (P16b)', async () => {
    await withFailoverDaemon({ extra: rolesConfig(['one', 'two']) }, async (harness, clock) => {
      const resetsAt = clock.now() + HOUR;
      // `two` is already out; `one` runs out in the turn.
      await harness.daemon.quota.ingestLimitHit(
        { client: 'fake', profile: 'two' },
        { source: 'limit_hit:test', resetsAt },
      );
      const scenarioId = await harness.openGenericChat('talk');
      const fail = `#ot-director-fail:quota\n#ot-director-fail-resets:${new Date(resetsAt).toISOString()}`;
      await harness.producer.send(scenarioId, `${fail}\n#ot-chat hello`);

      const waiting = await waitFor('the wait notice', async () =>
        (await failovers(harness, scenarioId)).find((item) => item.outcome === 'waiting'),
      );
      expect(waiting).toMatchObject({
        cause: 'quota_exhausted',
        fromExecutor: entry('one'),
        toExecutor: null,
      });
      await waitFor('scenario.director_waiting', async () =>
        (await scenarioEvents(harness, scenarioId)).find(
          (event) => event.type === 'scenario.director_waiting',
        ),
      );
      expect(await repliesOf(harness, scenarioId)).not.toContain('answer: hello');
      expect(
        (await promptsOf(harness, scenarioId)).filter((item) => item.state === 'pending'),
      ).toHaveLength(1);

      await clock.advance(HOUR + 1);
      await harness.daemon.wakeups.reconcile('fake/one');
      await harness.daemon.wakeups.reconcile('fake/two');
      const resumed = await waitFor('scenario.director_resumed', async () =>
        (await scenarioEvents(harness, scenarioId)).find(
          (event) => event.type === 'scenario.director_resumed',
        ),
      );
      expect(resumed.payload).toMatchObject({ scenarioId, outcome: 'selected' });
      await waitForReply(harness, scenarioId, 'answer: hello');
      const switched = await waitFor('the switched notice', async () =>
        (await failovers(harness, scenarioId)).find((item) => item.outcome === 'switched'),
      );
      expect(switched.fromExecutor).toBe(entry('one'));
      expect(switched.toExecutor).not.toBeNull();
      expect(
        (await promptsOf(harness, scenarioId)).filter((item) => item.state === 'pending'),
      ).toEqual([]);
    });
  });

  it('says it is unavailable with selection.director_wait: fail, and the next prompt tries again', async () => {
    await withFailoverDaemon(
      { extra: rolesConfig(['one', 'two'], '  director_wait: fail\n') },
      async (harness, clock) => {
        const resetsAt = clock.now() + HOUR;
        await harness.daemon.quota.ingestLimitHit(
          { client: 'fake', profile: 'two' },
          { source: 'limit_hit:test', resetsAt },
        );
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.send(scenarioId, '#ot-director-fail:quota\n#ot-chat hello');
        const unavailable = await waitFor('the unavailable notice', async () =>
          (await failovers(harness, scenarioId)).find((item) => item.outcome === 'unavailable'),
        );
        expect(unavailable).toMatchObject({ cause: 'quota_exhausted', toExecutor: null });
        expect(
          (await scenarioEvents(harness, scenarioId)).some(
            (event) => event.type === 'scenario.director_waiting',
          ),
        ).toBe(false);
        // The prompt was not lost: it is still in the queue.
        expect(
          (await promptsOf(harness, scenarioId)).filter((item) => item.state === 'pending'),
        ).toHaveLength(1);
      },
    );
  });

  it('says why when the first opening fails, and does not stay in turn (N331)', async () => {
    await withFailoverDaemon(
      { extra: rolesConfig(['one', 'two'], '  director_wait: fail\n') },
      async (harness, clock) => {
        const resetsAt = clock.now() + HOUR;
        for (const profile of ['one', 'two']) {
          await harness.daemon.quota.ingestLimitHit(
            { client: 'fake', profile },
            { source: 'limit_hit:test', resetsAt },
          );
        }
        // No Executor can open the Director: the chat opens and the notice says why (N331).
        const scenarioId = await harness.openGenericChat('talk');
        const unavailable = await waitFor('the unavailable notice', async () =>
          (await failovers(harness, scenarioId)).find((item) => item.outcome === 'unavailable'),
        );
        expect(unavailable).toMatchObject({ fromExecutor: null, toExecutor: null });
        expect(unavailable.detail).not.toBeNull();
        expect((await harness.producer.state(scenarioId)).busy).toBe(false);
        // The next prompt is kept in the queue, tries again and says why again.
        await harness.producer.send(scenarioId, '#ot-chat hello');
        await waitFor('the second notice', async () =>
          (await failovers(harness, scenarioId)).filter((item) => item.outcome === 'unavailable')
            .length >= 2
            ? true
            : undefined,
        );
        expect(
          (await promptsOf(harness, scenarioId)).filter((item) => item.state === 'pending'),
        ).toHaveLength(1);
        await waitFor('the chat out of turn', async () =>
          (await harness.producer.state(scenarioId)).busy ? undefined : true,
        );
      },
    );
  });

  it('keeps the old behaviour with scenarios.director_failover: off', async () => {
    await withFailoverDaemon(
      { extra: rolesConfig(['one', 'two'], '', '  director_failover: off\n') },
      async (harness) => {
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.send(scenarioId, '#ot-director-fail:quota\n#ot-chat hello');
        await waitFor('the failed turn', async () =>
          (await promptsOf(harness, scenarioId)).length > 0 ? true : undefined,
        );
        await waitFor('the error in the reply', async () =>
          (await repliesOf(harness, scenarioId)).find((reply) => reply.startsWith('[')),
        );
        expect(await failovers(harness, scenarioId)).toEqual([]);
        expect(await directorExecutors(harness)).toEqual([entry('one')]);
        // N183: a turn that failed keeps its `[error]` reply and is not a silent turn.
        const replies = await waitFor('the reply event', async () => {
          const found = (await scenarioEvents(harness, scenarioId)).filter(
            (event) => event.type === 'chat.director_reply',
          );
          return found.length > 0 ? found : undefined;
        });
        expect(replies).toHaveLength(1);
        expect(replies[0]?.payload).not.toHaveProperty('generated');
        const events = await scenarioEvents(harness, scenarioId);
        expect(events.filter((event) => event.type === 'chat.director_silent')).toEqual([]);
      },
    );
  });
});

describeWithLauncher(
  'the failover of the Director and profiles.rotate_on_exhaustion (P26, N157)',
  { timeout: 180_000 },
  () => {
    /** `one` and `two` are two OpenAI accounts, `three` is another provider. */
    function rotationConfig(rest = ''): string {
      const providers: Record<string, string> = {
        one: 'openai',
        two: 'openai',
        three: 'anthropic',
      };
      const registry = Object.entries(providers)
        .map(
          ([profile, provider]) =>
            `  ${entry(profile)}:\n    client: fake\n    profile: ${profile}\n    model: fake-model\n    provider: ${provider}\n`,
        )
        .join('');
      const roles = ROLES.map(
        (role) =>
          `  ${role}:\n    executors: [${(role === 'director' ? ['one', 'two', 'three'] : ['three']).map(entry).join(', ')}]\n`,
      ).join('');
      return `executors:\n  cross_client: any\n${registry}roles:\n${roles}selection:\n  recheck_every: off\n${rest}`;
    }

    async function notices(harness: PlayHarness) {
      return (await harness.daemon.store.events.readFrom(0, 100_000))
        .filter((event) => event.type === 'daemon.notice')
        .map(
          (event) =>
            event.payload as { kind: string; subject: string | null; detail: string | null },
        )
        .filter((payload) => payload.kind === 'account_rotated');
    }

    it('off (the default): the Director skips the other OpenAI account and goes to another provider', async () => {
      await withFailoverDaemon({ extra: rotationConfig() }, async (harness) => {
        const scenarioId = await harness.openGenericChat('talk');
        await harness.producer.send(scenarioId, '#ot-director-fail:quota\n#ot-chat hello');
        await waitForReply(harness, scenarioId, 'answer: hello');
        const switched = await waitFor('the switched notice', async () =>
          (await failovers(harness, scenarioId)).find((item) => item.outcome === 'switched'),
        );
        expect(switched).toMatchObject({ fromExecutor: entry('one'), toExecutor: entry('three') });
        expect(await directorExecutors(harness)).toEqual([entry('one'), entry('three')]);
        expect(await notices(harness)).toEqual([]);
      });
    });

    it('on: the Director rotates to the other OpenAI account, and a daemon.notice says so', async () => {
      await withFailoverDaemon(
        { extra: rotationConfig('profiles:\n  rotate_on_exhaustion:\n    openai: on\n') },
        async (harness) => {
          const scenarioId = await harness.openGenericChat('talk');
          await harness.producer.send(scenarioId, '#ot-director-fail:quota\n#ot-chat hello');
          await waitForReply(harness, scenarioId, 'answer: hello');
          const switched = await waitFor('the switched notice', async () =>
            (await failovers(harness, scenarioId)).find((item) => item.outcome === 'switched'),
          );
          expect(switched).toMatchObject({ fromExecutor: entry('one'), toExecutor: entry('two') });
          const [rotated] = await waitFor('the account_rotated notice', async () => {
            const found = await notices(harness);
            return found.length > 0 ? found : undefined;
          });
          expect(rotated).toMatchObject({ kind: 'account_rotated', subject: 'director' });
          expect(rotated?.detail).toContain('fake/one ran out, so fake/two');
        },
      );
    });
  },
);
