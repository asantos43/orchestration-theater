// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { ApiClient, DaemonStores, type EventStream, type FetchLike } from '@otheater/client';
import { API_ROUTES, type ApiSseMessage } from '@otheater/protocol';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeWithLauncher } from '../launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayHarness,
} from '../orchestration/e2e-fixture.js';
import { createSilentLogger } from '../logger.js';
import { recordFeedStore } from '../orchestration/record-feed.js';
import { dataPaths } from '../paths.js';

/**
 * The events of the records (P1 of docs/18, N173) against the real daemon with the fake agent in
 * every role: `decision.created`, `decision.answered`, `demand.transitioned` and
 * `scenario.archived` reach the log and the stream of their scenario, and the stores of the client
 * built from the events alone equal what REST says (the check of P13, now for the decisions, the
 * demands and the scenarios). Nothing real runs (N57): temporary folders, loopback, fake clock,
 * fake code host. The client is the compiled `dist/cli.js` of the fake agent, so `pnpm build`
 * comes first.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

/** The play that runs out of attempts and waits for the Producer (`attempts_per_demand: 2`). */
const EXHAUSTED_PLAY = '#ot-play write alpha #outcome:exhausted';
/** The play that goes all the way. */
const APPROVED_PLAY = '#ot-play write alpha and beta #outcome:approved';

const RECORD_EVENTS = [
  'decision.created',
  'decision.answered',
  'scenario.archived',
  'demand.transitioned',
];

function withFakeDaemon(
  limits: string | undefined,
  body: (
    harness: PlayHarness,
    client: ApiClient,
    watched: ApiClient,
    fetchLog: string[],
  ) => Promise<void>,
): Promise<void> {
  return withDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    {
      ...(limits === undefined ? {} : { limits }),
      extra: 'api:\n  chat:\n    resume_window: 50ms\n    state_interval: 100ms\n',
    },
    async (harness) => {
      const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
      const fetchLog: string[] = [];
      const counting: FetchLike = (url, init) => {
        fetchLog.push(`${init.method ?? 'GET'} ${new URL(url).pathname}`);
        return fetch(url, init);
      };
      const make = (fetchLike?: FetchLike) =>
        new ApiClient({
          url: harness.daemon.api.url,
          token,
          daemonId: harness.daemon.daemonId,
          ...(fetchLike === undefined ? {} : { fetch: fetchLike }),
        });
      // `watched` is the client of the stores: its reads are the ones counted. The test's own
      // reads (`client`) are not.
      const client = make();
      const watched = make(counting);
      await body(harness, client, watched, fetchLog);
    },
  );
}

/**
 * Nothing in the daemon archives a scenario yet, so the archive is written the way the daemon would
 * write it: through the decorator of the records over the store of the daemon (the handle holds
 * the store as the adapter built it, whose events the hub already announces).
 */
const archive = (harness: PlayHarness, scenarioId: string) =>
  recordFeedStore(harness.daemon.store, createSilentLogger()).scenarios.update(scenarioId, {
    state: 'archived',
  });

const logOf = (harness: PlayHarness) => harness.daemon.store.events.readFrom(0, 100_000);

async function headOf(harness: PlayHarness): Promise<number> {
  return (await logOf(harness)).at(-1)?.id ?? 0;
}

function follow(stream: EventStream): ApiSseMessage[] {
  const messages: ApiSseMessage[] = [];
  stream.onMessage((message) => {
    messages.push(message);
  });
  stream.start();
  return messages;
}

const reads = (fetchLog: readonly string[], pattern: RegExp): number =>
  fetchLog.filter((line) => line.startsWith('GET') && pattern.test(line)).length;

function waitForPlay(harness: PlayHarness, scenarioId: string, state: string) {
  return waitFor(`the play of the scenario in ${state}`, async () => {
    const play = (await harness.plays(scenarioId))[0];
    return play?.state === state ? play : undefined;
  });
}

describeWithLauncher('the events of the records (P1 of docs/18)', { timeout: 120_000 }, () => {
  it('writes the four events in the log and in the stream of their scenario, and in no other', async () => {
    await withFakeDaemon('  attempts_per_demand: 2', async (harness, client) => {
      const other = await harness.openGenericChat('other');
      const scenarioId = await harness.openChat();
      const head = await headOf(harness);
      const scoped = client.events({ scenario: scenarioId, since: head, initialDelayMs: 10 });
      const elsewhere = client.events({ scenario: other, since: head, initialDelayMs: 10 });
      const seen = follow(scoped);
      const unseen = follow(elsewhere);
      try {
        await harness.producer.send(scenarioId, EXHAUSTED_PLAY);
        const play = await waitForPlay(harness, scenarioId, 'AWAITING_PRODUCER');
        const pending = async () =>
          (
            await client.call(API_ROUTES.listScenarioDecisions, {
              params: { scenarioId },
              query: { state: 'pending' },
            })
          ).items;
        const menu = await waitFor('the menu', async () => (await pending())[0]);
        await client.call(API_ROUTES.answerDecision, {
          params: { decisionId: menu.id },
          body: { answer: { option: 'cancel', reason: 'not worth it' } },
        });
        await waitForPlay(harness, scenarioId, 'CANCELLED');
        await archive(harness, scenarioId);
        const archived = await client.call(API_ROUTES.getScenario, { params: { scenarioId } });
        expect(archived.scenario.state).toBe('archived');

        const log = (await logOf(harness)).filter((event) => event.id > head);
        const of = (type: string) => log.filter((event) => event.type === type);

        // decision.created: the whole record, pending, with the play in the envelope.
        const created = of('decision.created').find(
          (event) => (event.payload as { decision: { id: string } }).decision.id === menu.id,
        );
        expect(created).toMatchObject({
          scenarioId,
          playId: play.id,
          payload: { decision: { ...menu, state: 'pending' } },
          timestamp: menu.createdAt,
        });
        // decision.answered: after it, with the state and who decided; the REST command still
        // writes its own `scenario.decision_answered`.
        const answered = of('decision.answered').find(
          (event) => (event.payload as { decisionId: string }).decisionId === menu.id,
        );
        expect(answered).toMatchObject({
          scenarioId,
          playId: play.id,
          payload: { kind: menu.kind, state: 'decided', decidedBy: 'producer' },
        });
        expect(answered?.id).toBeGreaterThan(created?.id ?? Infinity);
        expect(of('scenario.decision_answered')).toHaveLength(1);

        // demand.transitioned: born with the record, then a chain of moves that ends where REST is.
        const detail = await client.call(API_ROUTES.getPlay, { params: { playId: play.id } });
        expect(detail.demands.length).toBeGreaterThan(0);
        const moves = of('demand.transitioned');
        for (const demand of detail.demands) {
          const own = moves.filter(
            (event) => (event.payload as { demandId: string }).demandId === demand.id,
          );
          const payloads = own.map(
            (event) => event.payload as { from: string | null; to: string; demand?: unknown },
          );
          expect(payloads[0]).toMatchObject({ from: null, to: 'pending' });
          expect(payloads[0]?.demand).toMatchObject({ id: demand.id, playId: play.id });
          for (const [index, payload] of payloads.entries()) {
            if (index === 0) continue;
            expect(payload.from).toBe(payloads[index - 1]?.to);
            expect(payload).not.toHaveProperty('demand');
          }
          expect(payloads.at(-1)?.to).toBe(demand.state);
          expect(own.at(-1)?.timestamp).toBe(demand.updatedAt);
          for (const event of own) expect(event).toMatchObject({ scenarioId, playId: play.id });
        }

        // scenario.archived: once, with the stamp of the record.
        expect(of('scenario.archived')).toHaveLength(1);
        expect(of('scenario.archived')[0]).toMatchObject({
          scenarioId,
          payload: { scenarioId },
          timestamp: archived.scenario.updatedAt,
        });

        // The stream of the scenario sees all four; the stream of another scenario sees none.
        const lastId = await headOf(harness);
        await waitFor('the stream to reach the log', () =>
          Promise.resolve(seen.at(-1)?.data.id === lastId ? true : undefined),
        );
        const seenTypes = new Set(seen.map((message) => message.data.type));
        for (const type of RECORD_EVENTS) expect(seenTypes.has(type)).toBe(true);
        expect(unseen.filter((message) => RECORD_EVENTS.includes(message.data.type))).toEqual([]);
      } finally {
        scoped.close();
        elsewhere.close();
      }
    });
  });

  it('the decisions, demands and scenarios stores built from the events equal REST, with no read per transition', async () => {
    await withFakeDaemon('  attempts_per_demand: 2', async (harness, client, watched, fetchLog) => {
      const stores = new DaemonStores(watched, { plays: 'all', refreshDebounceMs: 10 });
      await stores.start();
      const snapshot = fetchLog.length;
      const caughtUp = async (): Promise<void> => {
        await waitFor('the stores to reach the log', async () =>
          stores.status.getState().cursor === (await headOf(harness)) ? true : undefined,
        );
        await stores.whenIdle();
      };
      try {
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, EXHAUSTED_PLAY);
        const play = await waitForPlay(harness, scenarioId, 'AWAITING_PRODUCER');
        const pending = async (id: string) =>
          (
            await client.call(API_ROUTES.listScenarioDecisions, {
              params: { scenarioId: id },
              query: { state: 'pending' },
            })
          ).items;
        const menu = await waitFor('the menu', async () => (await pending(scenarioId))[0]);
        await caughtUp();
        expect(stores.decisions.getState().byScenario[scenarioId]).toEqual(
          await pending(scenarioId),
        );
        expect(stores.decisions.getState().byScenario[scenarioId]?.map((d) => d.id)).toEqual([
          menu.id,
        ]);

        await client.call(API_ROUTES.answerDecision, {
          params: { decisionId: menu.id },
          body: { answer: { option: 'cancel', reason: 'not worth it' } },
        });
        await waitForPlay(harness, scenarioId, 'CANCELLED');
        await caughtUp();
        expect(stores.decisions.getState().byScenario[scenarioId] ?? []).toEqual([]);
        expect(await pending(scenarioId)).toEqual([]);

        // A question of the Director in a chat: a decision of another scenario.
        const chatId = await harness.openGenericChat('talk');
        await harness.producer.send(chatId, '#ot-ask What color is the sky?');
        const question = await waitFor('the question', async () => (await pending(chatId))[0]);
        await caughtUp();
        expect(stores.decisions.getState().byScenario[chatId]).toEqual([question]);
        await client.call(API_ROUTES.answerDecision, {
          params: { decisionId: question.id },
          body: { answer: { answers: ['blue'] } },
        });
        await waitFor('the question to be answered', async () =>
          (await pending(chatId)).length === 0 ? true : undefined,
        );
        await caughtUp();
        expect(stores.decisions.getState().byScenario[chatId] ?? []).toEqual([]);

        // The demands of the play.
        const detail = await client.call(API_ROUTES.getPlay, { params: { playId: play.id } });
        expect(detail.demands.length).toBeGreaterThan(0);
        expect(stores.demands.getState().byPlay[play.id]).toEqual({
          demands: detail.demands,
          stages: detail.stages,
        });

        // The archive.
        await archive(harness, scenarioId);
        await caughtUp();
        const rest = await client.call(API_ROUTES.getScenario, { params: { scenarioId } });
        expect(rest.scenario.state).toBe('archived');
        expect(stores.scenarios.getState().byId[scenarioId]).toEqual(rest.scenario);
        expect(stores.scenarios.getState().stale).toEqual({});
        expect(stores.demands.getState().stale).toEqual({});
        expect(stores.decisions.getState().stale).toEqual({});

        // After the snapshot the stores read no list of decisions and no play: the only read of a
        // scenario is the one `scenario.created` asks (it does not carry the record), never one
        // per transition or for the archive.
        const after = fetchLog.slice(snapshot);
        expect(reads(after, /\/decisions$/)).toBe(0);
        expect(reads(after, /^GET \/v1\/plays\/[^/]+$/)).toBe(0);
        expect(reads(after, /^GET \/v1\/scenarios\/[^/]+$/)).toBeLessThanOrEqual(2);
      } finally {
        stores.close();
      }
    });
  });

  it('a play that goes all the way: every demand ends where REST says, from the events alone', async () => {
    await withFakeDaemon(undefined, async (harness, client) => {
      const stores = new DaemonStores(client, { plays: 'all', refreshDebounceMs: 10 });
      await stores.start();
      try {
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, APPROVED_PLAY);
        const play = await waitForPlay(harness, scenarioId, 'DONE');
        await waitFor('the stores to reach the log', async () =>
          stores.status.getState().cursor === (await headOf(harness)) ? true : undefined,
        );
        await stores.whenIdle();
        const detail = await client.call(API_ROUTES.getPlay, { params: { playId: play.id } });
        expect(detail.demands.length).toBeGreaterThanOrEqual(2);
        expect(stores.demands.getState().byPlay[play.id]?.demands).toEqual(detail.demands);
        expect(detail.demands.every((demand) => demand.state === 'approved')).toBe(true);
      } finally {
        stores.close();
      }
    });
  });
});
