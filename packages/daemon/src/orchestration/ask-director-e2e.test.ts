// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { questionsKey } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation, testGit } from '@otheater/sdk';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayFakes,
  type PlayHarness,
} from './e2e-fixture.js';
import { itWithLauncher } from '../launcher-fixture.js';

/**
 * `ask_director` (N308, option 2; P15 of Phase 11b), end to end with the fake agent. The Actor of
 * `alpha` asks (`#actor-ask`); the fake Director answers with `answer_actor`, or relays the question
 * to the Actor of `beta` (`relay beta ...`), which answers with `submit` (state `answer`). The clock
 * is frozen, so the deadline passes only when the test advances it.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

function fakes(clock: FakeClock): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock,
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

async function openedPlay(harness: PlayHarness, need: string): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, need);
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  return play.id;
}

async function delivered(harness: PlayHarness, need: string): Promise<string> {
  const playId = await openedPlay(harness, need);
  await waitFor(
    'DONE',
    async () => (await harness.daemon.store.plays.get(playId))?.state === 'DONE',
  );
  return playId;
}

async function typesOf(harness: PlayHarness, playId: string): Promise<string[]> {
  return (await harness.eventsOf(playId)).map((event) => event.type);
}

function file(harness: PlayHarness, playId: string, name: string): Promise<string> {
  return testGit(harness.rig.repo, 'show', `play/${playId}/integration:${name}`);
}

describe('ask_director, end to end with the fake agent', { timeout: 180_000 }, () => {
  itWithLauncher('the Director answers the question and the Actor goes on', async () => {
    await withPlayDaemon(fakes(new FakeClock()), {}, async (harness) => {
      const playId = await delivered(harness, '#ot-play write alpha #actor-ask:alpha=which-name');
      expect(await file(harness, playId, 'alpha.txt')).toContain(
        'asked: answered by director: director says: which name',
      );
      const types = await typesOf(harness, playId);
      expect(types).toContain('actor.question');
      expect(types).toContain('actor.answer');
      expect(types).not.toContain('actor.question_timeout');
      const events = await harness.eventsOf(playId);
      expect(events.find((event) => event.type === 'actor.answer')?.payload).toMatchObject({
        source: 'director',
        demandId: 'alpha',
      });
      const kept = await harness.daemon.store.blackboard.history(playId, questionsKey('alpha'));
      expect(kept).toHaveLength(1);
      expect(harness.codeHost.pullRequests()).toHaveLength(1);
    });
  });

  itWithLauncher('on_timeout continue: the deadline passes and the Actor goes on', async () => {
    const clock = new FakeClock();
    await withPlayDaemon(
      fakes(clock),
      { extra: 'collab:\n  ask_director:\n    timeout: 5s\n    on_timeout: continue' },
      async (harness) => {
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, '#ot-play write alpha #actor-ask:alpha=silent');
        const play = await waitFor(
          'the play to exist',
          async () => (await harness.plays(scenarioId))[0],
        );
        await waitFor('the question', async () =>
          (await typesOf(harness, play.id)).includes('actor.question'),
        );
        // the deadline is on the Clock: nothing happens until it is advanced
        await clock.advance(5_000);
        await waitFor(
          'DONE',
          async () => (await harness.daemon.store.plays.get(play.id))?.state === 'DONE',
        );
        expect(await file(harness, play.id, 'alpha.txt')).toContain('asked: no answer');
        const types = await typesOf(harness, play.id);
        expect(types).toContain('actor.question_timeout');
        expect(types).not.toContain('actor.answer');
        const events = await harness.eventsOf(play.id);
        expect(
          events.find((event) => event.type === 'actor.question_timeout')?.payload,
        ).toMatchObject({ onTimeout: 'continue', demandId: 'alpha' });
      },
    );
  });

  itWithLauncher('on_timeout blocked: the demand ends as blocked, as today', async () => {
    const clock = new FakeClock();
    await withPlayDaemon(
      fakes(clock),
      { extra: 'collab:\n  ask_director:\n    timeout: 5s\n    on_timeout: blocked' },
      async (harness) => {
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, '#ot-play write alpha #actor-ask:alpha=silent');
        const play = await waitFor(
          'the play to exist',
          async () => (await harness.plays(scenarioId))[0],
        );
        await waitFor('the question', async () =>
          (await typesOf(harness, play.id)).includes('actor.question'),
        );
        await clock.advance(5_000);
        await waitFor('the timeout', async () =>
          (await typesOf(harness, play.id)).includes('actor.question_timeout'),
        );
        const events = await harness.eventsOf(play.id);
        const blocked = events.find(
          (event) =>
            event.type === 'attempt.submitted' &&
            JSON.stringify(event.payload).includes('"state":"blocked"'),
        );
        expect(blocked).toBeDefined();
        expect(
          events.find((event) => event.type === 'actor.question_timeout')?.payload,
        ).toMatchObject({ onTimeout: 'blocked' });
        // the Actor ended its turn: it wrote nothing, so the demand did not deliver `alpha.txt`
        expect((await typesOf(harness, play.id)).includes('actor.answer')).toBe(false);
        expect((await harness.daemon.store.plays.get(play.id))?.state).not.toBe('DONE');
      },
    );
  });

  itWithLauncher('relay: the Director passes the question to the Actor that knows', async () => {
    await withPlayDaemon(
      fakes(new FakeClock()),
      { extra: 'collab:\n  ask_director:\n    mode: relay' },
      async (harness) => {
        const playId = await delivered(
          harness,
          '#ot-play write alpha #independent #actor-ask:alpha=relay-beta-what-name #actor-answer:beta=the-name-is-beta',
        );
        expect(await file(harness, playId, 'alpha.txt')).toContain(
          'asked: answered by actor: the name is beta',
        );
        expect(await file(harness, playId, 'beta.txt')).toContain('relayed: answered');
        const events = await harness.eventsOf(playId);
        expect(events.find((event) => event.type === 'actor.question')?.payload).toMatchObject({
          mode: 'relay',
        });
        expect(events.find((event) => event.type === 'actor.answer')?.payload).toMatchObject({
          source: 'actor',
        });
        expect(
          events.some(
            (event) =>
              event.type === 'supervision.warning' &&
              (event.payload as { kind?: string }).kind === 'question',
          ),
        ).toBe(true);
      },
    );
  });

  itWithLauncher('past max_per_demand the question is refused, with the limit event', async () => {
    await withPlayDaemon(
      fakes(new FakeClock()),
      { extra: 'collab:\n  ask_director:\n    max_per_demand: 1' },
      async (harness) => {
        const playId = await delivered(harness, '#ot-play write alpha #actor-ask:alpha=first*2');
        const text = await file(harness, playId, 'alpha.txt');
        expect(text).toContain('asked: answered by director: director says: first');
        expect(text).toContain('asked: refused');
        const events = await harness.eventsOf(playId);
        expect(events.filter((event) => event.type === 'actor.question')).toHaveLength(1);
        expect(
          events.find((event) => event.type === 'collab.limit_reached')?.payload,
        ).toMatchObject({ feature: 'ask_director', limit: 'max_per_demand', max: 1 });
      },
    );
  });

  itWithLauncher('with mode off the tool is not offered, and the play still delivers', async () => {
    await withPlayDaemon(
      fakes(new FakeClock()),
      { extra: 'collab:\n  ask_director:\n    mode: off' },
      async (harness) => {
        const playId = await delivered(harness, '#ot-play write alpha #actor-ask:alpha=anything');
        expect(await file(harness, playId, 'alpha.txt')).toContain('asked: refused');
        const types = await typesOf(harness, playId);
        expect(types).not.toContain('actor.question');
        expect(types).not.toContain('actor.answer');
      },
    );
  });
});
