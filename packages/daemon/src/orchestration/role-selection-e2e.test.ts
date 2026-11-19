// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
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
 * The selection in the pipeline (P16): a whole play with the fake agent, two profiles of the same
 * client, and the quota signal simulated through the service (`ingestLimitHit`), the same door the
 * clients' limit errors use. The client is the compiled `dist/cli.js` of the fake agent.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const ROLES = ['director', 'consultant', 'author', 'reviewer', 'scriptwriter', 'actor', 'critic'];
const entry = (profile: string): string => `fake-model@fake/${profile}`;

/** The registry of the three profiles and the lists of the roles. `lists[role]` defaults to `[one, two]`. */
function rolesConfig(lists: Readonly<Record<string, readonly string[]>>, selection = ''): string {
  const registry = ['one', 'two', 'three']
    .map(
      (profile) =>
        `  ${entry(profile)}:\n    client: fake\n    profile: ${profile}\n    model: fake-model\n`,
    )
    .join('');
  const roles = ROLES.map(
    (role) =>
      `  ${role}:\n    executors: [${(lists[role] ?? ['one', 'two']).map(entry).join(', ')}]\n`,
  ).join('');
  return `executors:\n${registry}roles:\n${roles}selection:\n  recheck_every: off\n${selection}`;
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
}

async function withSelectionDaemon(
  options: PlayHarnessOptions,
  body: (harness: PlayHarness, clock: FakeClock) => Promise<void>,
): Promise<void> {
  const set = fakes();
  await withDaemon(set, options, async (harness) => {
    await registerProfiles(harness);
    await body(harness, set.clock);
  });
}

interface Selected {
  readonly role: string;
  readonly playId: string | null;
  readonly outcome: string;
  readonly executor: string | null;
  readonly profile: string | null;
  readonly skipped: readonly { readonly profile: string; readonly reason: string }[];
  readonly waiting: { readonly on: readonly string[] } | null;
}

/** Every `executor.selected` of the play (or of the daemon), in order. */
async function selections(harness: PlayHarness, role?: string): Promise<Selected[]> {
  const events = await harness.daemon.store.events.readFrom(0, 100_000);
  return events
    .filter((event) => event.type === 'executor.selected')
    .map((event) => event.payload as unknown as Selected)
    .filter((payload) => role === undefined || payload.role === role);
}

async function openPlay(
  harness: PlayHarness,
  outcome: string,
): Promise<{ scenarioId: string; playId: string }> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, `#ot-play write alpha and beta #outcome:${outcome}`);
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  return { scenarioId, playId: play.id };
}

async function stateOf(harness: PlayHarness, playId: string): Promise<string | undefined> {
  return (await harness.daemon.store.plays.get(playId))?.state;
}

const HOUR = 3_600_000;

describeWithLauncher('the selection in the pipeline (P16)', { timeout: 180_000 }, () => {
  it('sends the new demands to the other profile when one runs out midway, and says why', async () => {
    await withSelectionDaemon({ extra: rolesConfig({}) }, async (harness) => {
      const { playId } = await openPlay(harness, 'execution_failure');
      // The first Actor was picked: from here on `one` is out of cota.
      await waitFor('the first selection of an Actor', async () => {
        const [first] = await selections(harness, 'actor');
        return first;
      });
      const cut = Date.now();
      await harness.daemon.quota.ingestLimitHit(
        { client: 'fake', profile: 'one' },
        { source: 'limit_hit:test', resetsAt: cut + HOUR },
      );
      await waitFor('DONE', async () => (await stateOf(harness, playId)) === 'DONE');

      const actors = await selections(harness, 'actor');
      expect(actors.length).toBeGreaterThanOrEqual(3);
      expect(actors[0]).toMatchObject({ outcome: 'selected', profile: 'fake/one', playId });
      // The retry round after the critique came after the cut: every selection that saw `one`
      // exhausted went to `two`, and the event says so.
      const after = actors.filter((item) =>
        item.skipped.some((skip) => skip.profile === 'fake/one'),
      );
      expect(after.length).toBeGreaterThanOrEqual(1);
      for (const item of after) {
        expect(item).toMatchObject({ outcome: 'selected', profile: 'fake/two' });
        expect(item.skipped).toContainEqual(
          expect.objectContaining({ profile: 'fake/one', reason: 'quota' }),
        );
      }
      // Nobody took `one` once it was out.
      const firstSkip = actors.findIndex((item) => item.skipped.length > 0);
      for (const item of actors.slice(firstSkip)) expect(item.profile).toBe('fake/two');
      // The record of the attempt is on the blackboard of the play, tied to the attempt id.
      const kept = await harness.daemon.store.blackboard.get(playId, 'selection/alpha/1');
      expect(kept?.value).toMatchObject({ executor: entry('one') });
    });
  });

  it('holds the demand with the reason when no profile is available, and goes on at quota.restored', async () => {
    await withSelectionDaemon(
      {
        extra: rolesConfig({
          actor: ['one', 'two'],
          director: ['three'],
          consultant: ['three'],
          author: ['three'],
          reviewer: ['three'],
          scriptwriter: ['three'],
          critic: ['three'],
        }),
      },
      async (harness, clock) => {
        const resetsAt = clock.now() + HOUR;
        for (const profile of ['one', 'two']) {
          await harness.daemon.quota.ingestLimitHit(
            { client: 'fake', profile },
            { source: 'limit_hit:test', resetsAt },
          );
        }
        const { scenarioId, playId } = await openPlay(harness, 'approved');
        // The demand is not lost: it waits, and the Producer's chat and the Director see why.
        const poll = await waitFor('the wait to show', async () => {
          const view = await harness.producer.poll(scenarioId, 0);
          return view.waits.length > 0 ? view : undefined;
        });
        expect(poll.waits[0]).toMatchObject({ role: 'actor', playId });
        expect(poll.waits[0]?.on.map((on) => [on.profile, on.reason]).sort()).toEqual([
          ['fake/one', 'quota'],
          ['fake/two', 'quota'],
        ]);
        const waiting = (await selections(harness, 'actor')).filter(
          (item) => item.outcome === 'waiting',
        );
        expect(waiting.length).toBeGreaterThanOrEqual(1);
        expect([...(waiting[0]?.waiting?.on ?? [])].sort()).toEqual([entry('one'), entry('two')]);
        expect(waiting[0]?.skipped.map((skip) => skip.reason)).toEqual(['quota', 'quota']);
        expect(await stateOf(harness, playId)).toBe('EXECUTING');
        const demands = await harness.daemon.store.demands.list({ playId });
        expect(demands.every((demand) => demand.state === 'pending')).toBe(true);
        // P16b: the wait is an event too, and the demand does not hold a slot while it waits (N142).
        const waitEvents = (await harness.eventsOf(playId)).filter(
          (event) => event.type === 'demand.waiting',
        );
        expect(waitEvents.length).toBeGreaterThanOrEqual(1);
        expect(waitEvents[0]?.payload).toMatchObject({
          playId,
          role: 'actor',
          holdsSlot: false,
          scenarioId,
        });
        expect((await harness.eventsOf(playId)).some((e) => e.type === 'demand.resumed')).toBe(
          false,
        );

        // The window ends: P9 settles the profiles (`quota.restored`) and wakes the demands.
        await clock.advance(HOUR + 1);
        await harness.daemon.wakeups.reconcile('fake/one');
        await harness.daemon.wakeups.reconcile('fake/two');
        await waitFor('DONE', async () => (await stateOf(harness, playId)) === 'DONE');
        const events = (await harness.eventsOf(playId)).map((event) => event.type);
        expect(events).toContain('delivery.completed');
        const picked = (await selections(harness, 'actor')).filter(
          (item) => item.outcome === 'selected',
        );
        expect(picked.length).toBeGreaterThanOrEqual(2);
        expect(await waitingNow(harness, scenarioId)).toBe(0);
        const resumed = (await harness.eventsOf(playId)).filter(
          (event) => event.type === 'demand.resumed',
        );
        expect(resumed.length).toBeGreaterThanOrEqual(1);
        expect(resumed[0]?.payload).toMatchObject({ outcome: 'selected', role: 'actor', playId });
      },
    );
  });

  it('parks the Director with no Executor, says so in events, and opens it at quota.restored (N141)', async () => {
    await withSelectionDaemon(
      {
        extra: rolesConfig({
          director: ['one', 'two'],
          consultant: ['three'],
          author: ['three'],
          reviewer: ['three'],
          scriptwriter: ['three'],
          actor: ['three'],
          critic: ['three'],
        }),
      },
      async (harness, clock) => {
        const resetsAt = clock.now() + HOUR;
        for (const profile of ['one', 'two']) {
          await harness.daemon.quota.ingestLimitHit(
            { client: 'fake', profile },
            { source: 'limit_hit:test', resetsAt },
          );
        }
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, 'hello');
        const waiting = await waitFor('the Director to wait', async () =>
          (await scenarioEvents(harness, scenarioId)).find(
            (event) => event.type === 'scenario.director_waiting',
          ),
        );
        expect(waiting.payload).toMatchObject({ scenarioId });
        expect(
          (await scenarioEvents(harness, scenarioId)).some(
            (event) => event.type === 'scenario.director_resumed',
          ),
        ).toBe(false);

        await clock.advance(HOUR + 1);
        await harness.daemon.wakeups.reconcile('fake/one');
        await harness.daemon.wakeups.reconcile('fake/two');
        const resumed = await waitFor('the Director to resume', async () =>
          (await scenarioEvents(harness, scenarioId)).find(
            (event) => event.type === 'scenario.director_resumed',
          ),
        );
        expect(resumed.payload).toMatchObject({ scenarioId, outcome: 'selected' });
      },
    );
  });

  it('answers at once with the reason when selection.director_wait is fail (N141)', async () => {
    await withSelectionDaemon(
      {
        extra: rolesConfig(
          {
            director: ['one', 'two'],
            consultant: ['three'],
            author: ['three'],
            reviewer: ['three'],
            scriptwriter: ['three'],
            actor: ['three'],
            critic: ['three'],
          },
          '  director_wait: fail\n',
        ),
      },
      async (harness, clock) => {
        const resetsAt = clock.now() + HOUR;
        for (const profile of ['one', 'two']) {
          await harness.daemon.quota.ingestLimitHit(
            { client: 'fake', profile },
            { source: 'limit_hit:test', resetsAt },
          );
        }
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, 'hello').catch(() => undefined);
        await waitFor(
          'the Director to be asked for',
          async () => (await selections(harness, 'director'))[0],
        );
        const types = (await scenarioEvents(harness, scenarioId)).map((event) => event.type);
        expect(types).not.toContain('scenario.director_waiting');
        expect(types).not.toContain('scenario.director_resumed');
      },
    );
  });

  it('keeps the old accounting of the slot with selection.waiting_holds_slot: true (N142)', async () => {
    await withSelectionDaemon(
      {
        extra: rolesConfig(
          {
            actor: ['one', 'two'],
            director: ['three'],
            consultant: ['three'],
            author: ['three'],
            reviewer: ['three'],
            scriptwriter: ['three'],
            critic: ['three'],
          },
          '  waiting_holds_slot: true\n',
        ),
      },
      async (harness, clock) => {
        const resetsAt = clock.now() + HOUR;
        for (const profile of ['one', 'two']) {
          await harness.daemon.quota.ingestLimitHit(
            { client: 'fake', profile },
            { source: 'limit_hit:test', resetsAt },
          );
        }
        const { playId } = await openPlay(harness, 'approved');
        const waiting = await waitFor('the demand to wait', async () =>
          (await harness.eventsOf(playId)).find((event) => event.type === 'demand.waiting'),
        );
        expect(waiting.payload).toMatchObject({ role: 'actor', holdsSlot: true });
        await clock.advance(HOUR + 1);
        await harness.daemon.wakeups.reconcile('fake/one');
        await harness.daemon.wakeups.reconcile('fake/two');
        await waitFor('DONE', async () => (await stateOf(harness, playId)) === 'DONE');
        const resumed = (await harness.eventsOf(playId)).find(
          (event) => event.type === 'demand.resumed',
        );
        expect(resumed?.payload).toMatchObject({ outcome: 'selected', holdsSlot: true });
      },
    );
  });

  it('does not touch a session in progress when the configuration changes', async () => {
    await withSelectionDaemon({ extra: rolesConfig({}) }, async (harness) => {
      const { scenarioId, playId } = await openPlay(harness, 'approved');
      await waitFor(
        'the Director to be picked',
        async () => (await selections(harness, 'director'))[0],
      );
      const [director] = await selections(harness, 'director');
      expect(director).toMatchObject({ profile: 'fake/one' });
      // The scenario now prefers `two` for every role (the P13 override), and `one` is out of quota.
      await harness.daemon.store.scenarios.update(scenarioId, {
        configOverride: {
          roles: Object.fromEntries(
            ROLES.map((role) => [role, { executors: [entry('two'), entry('one')] }]),
          ),
        },
      });
      await harness.daemon.quota.ingestLimitHit(
        { client: 'fake', profile: 'one' },
        { source: 'limit_hit:test', resetsAt: Date.now() + HOUR },
      );
      await waitFor('DONE', async () => (await stateOf(harness, playId)) === 'DONE');
      // The Director's session was opened once, with the profile of that moment, and kept it.
      const directors = await selections(harness, 'director');
      expect(directors.map((item) => item.profile)).toEqual(['fake/one']);
      // What began after the change reads the new configuration.
      const critics = await selections(harness, 'critic');
      expect(critics.length).toBeGreaterThanOrEqual(1);
      expect(critics.at(-1)?.profile).toBe('fake/two');
      expect(await waitingNow(harness, scenarioId)).toBe(0);
    });
  });
});

async function waitingNow(harness: PlayHarness, scenarioId: string): Promise<number> {
  return (await harness.producer.poll(scenarioId, 0)).waits.length;
}

async function scenarioEvents(harness: PlayHarness, scenarioId: string) {
  const events = await harness.daemon.store.events.readFrom(0, 100_000);
  return events.filter((event) => event.scenarioId === scenarioId);
}
