// SPDX-License-Identifier: MPL-2.0
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { main } from '../cli.js';
import { makeTempDataDir } from '../test-helpers.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayFakes,
  type PlayHarness,
  type PlayHarnessOptions,
} from './e2e-fixture.js';

/**
 * A whole play (architecture 5.4) with the fake agent in every role and the fake code host: the
 * Producer's message goes through the single queue to the Director, the Director opens the play
 * with `open_play`, and the daemon runs the stages, the Actors, the integration and the delivery.
 * The client is the compiled `dist/cli.js` of the fake agent, so `pnpm build` comes first.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

function fakes(): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new FakeClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

function withPlayDaemon(
  options: PlayHarnessOptions,
  body: (harness: PlayHarness) => Promise<void>,
): Promise<void> {
  return withDaemon(fakes(), options, body);
}

/** Sends the Producer's message and waits for the play it opens; returns its id. */
async function openPlay(harness: PlayHarness, outcome: string): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, `#ot-play write alpha and beta #outcome:${outcome}`);
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  return play.id;
}

async function stateOf(harness: PlayHarness, playId: string): Promise<string | undefined> {
  return (await harness.daemon.store.plays.get(playId))?.state;
}

describe('a play with the fake agent (P8)', { timeout: 120_000 }, () => {
  it('reaches DONE on the approved outcome, with a pull request on the code host', async () => {
    await withPlayDaemon({}, async (harness) => {
      const playId = await openPlay(harness, 'approved');
      await waitFor('DONE', async () => (await stateOf(harness, playId)) === 'DONE');

      const path = await harness.pathOf(playId);
      expect(path).toContain('PLANNING');
      expect(path).toContain('EXECUTING');
      expect(path).toContain('CRITIQUING');
      expect(path.at(-1)).toBe('DONE');
      const pulls = harness.codeHost.pullRequests();
      expect(pulls).toHaveLength(1);
      expect(pulls[0]).toMatchObject({ baseBranch: 'main', state: 'open' });
      const events = (await harness.eventsOf(playId)).map((event) => event.type);
      expect(events).toContain('delivery.completed');
      const demands = await harness.daemon.store.demands.list({ playId });
      expect(demands.map((demand) => [demand.id, demand.state])).toEqual([
        ['alpha', 'approved'],
        ['beta', 'approved'],
      ]);
    });
  });

  it.each([
    ['execution_failure', 'EXECUTING'],
    ['script_failure', 'SCRIPTING'],
    ['structural_failure', 'PLANNING'],
  ] as const)(
    'goes back to %s of the machine when the critique rejects, and still ends in DONE',
    async (outcome, returnsTo) => {
      await withPlayDaemon({}, async (harness) => {
        const playId = await openPlay(harness, outcome);
        await waitFor('DONE', async () => (await stateOf(harness, playId)) === 'DONE');
        const path = await harness.pathOf(playId);
        const firstCritique = path.indexOf('CRITIQUING');
        const back = path.indexOf('DECIDING', firstCritique);
        expect(back).toBeGreaterThan(firstCritique);
        expect(path[back + 1]).toBe(returnsTo);
        expect(path.indexOf('CRITIQUING', back)).toBeGreaterThan(back);
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
      });
    },
  );

  it('stops at AWAITING_PRODUCER when a counter runs out, and the Producer can cancel it', async () => {
    await withPlayDaemon({ limits: '  attempts_per_demand: 2' }, async (harness) => {
      const scenarioId = await harness.openChat();
      await harness.producer.send(scenarioId, '#ot-play write alpha #outcome:exhausted');
      const play = await waitFor(
        'the play to exist',
        async () => (await harness.plays(scenarioId))[0],
      );
      await waitFor(
        'AWAITING_PRODUCER',
        async () => (await stateOf(harness, play.id)) === 'AWAITING_PRODUCER',
      );
      const menu = await waitFor('the menu', async () =>
        (await harness.producer.poll(scenarioId, 0)).asks.find(
          (ask) => ask.kind === 'producer_menu',
        ),
      );
      expect(menu.playId).toBe(play.id);
      expect(menu.input.options).toContain('cancel');
      expect(harness.codeHost.pullRequests()).toHaveLength(0);

      await harness.producer.answer(menu.id, { option: 'cancel', reason: 'not worth it' });
      await waitFor('the cancellation', async () => {
        const after = await harness.daemon.store.plays.get(play.id);
        return after?.finishedAt !== null && after?.finishedAt !== undefined;
      });
      expect(await stateOf(harness, play.id)).toBe('CANCELLED');
      const decision = await harness.daemon.store.decisions.get(menu.id);
      expect(decision).toMatchObject({ state: 'decided' });
    });
  });
});

describe('ot chat with the fake Director (P8)', { timeout: 120_000 }, () => {
  it('fails clearly when no daemon runs on the data directory', async () => {
    const tmp = await makeTempDataDir();
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(['chat', '--repo', tmp.dir, '--data-dir', tmp.dir], {
        env: {},
        platform: process.platform,
        homedir: tmp.dir,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        systemLocale: 'en',
        input: new PassThrough(),
      });
      expect(code).not.toBe(0);
      expect(err.join('\n')).toContain('No daemon is running');
    } finally {
      await tmp.dispose();
    }
  });

  it('sends messages, shows replies, answers a question and takes the menu of a stopped play', async () => {
    await withPlayDaemon({ limits: '  attempts_per_demand: 2' }, async (harness) => {
      const input = new PassThrough();
      const out: string[] = [];
      const err: string[] = [];
      const finished = main(['chat', '--repo', harness.rig.repo, '--data-dir', harness.dataDir], {
        env: {},
        platform: process.platform,
        homedir: harness.dataDir,
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        systemLocale: 'en',
        input,
      });
      const seen = (text: string) => () => Promise.resolve(out.some((line) => line.includes(text)));

      // A question of the Director, answered by the Producer through the chat.
      input.write('#ot-ask What color is the sky?\n');
      await waitFor('the question', seen('The Director asks: What color is the sky?'));
      input.write('blue\n');
      await waitFor('the reply that carries the answer', seen('Director: answer:'));

      // A play that runs out of a counter: the menu comes to the chat.
      input.write('#ot-play write alpha #outcome:exhausted\n');
      await waitFor('the menu', seen('needs you'));
      expect(out.some((line) => /Play play-[0-9a-f]{8}: EXECUTING/.test(line))).toBe(true);
      input.write('nonsense\n');
      await waitFor('the refusal', seen('That is not one of the options'));
      input.write('cancel not worth it\n');
      await waitFor('the end of the play', seen('ended.'));

      input.end();
      const code = await finished;
      expect(code).toBe(0);
      expect(err).toEqual([]);
      expect(out[0]).toContain('Chat open on scenario');
      const [scenarioId] = (await harness.daemon.store.scenarios.list()).map((s) => s.id);
      const plays = await harness.plays(scenarioId ?? '');
      expect(plays.map((play) => play.state)).toEqual(['CANCELLED']);
      expect(harness.codeHost.pullRequests()).toHaveLength(0);
    });
  });
});
