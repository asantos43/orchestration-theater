// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment -- the answers of the API are read as loose JSON */
import { readFile } from 'node:fs/promises';
import {
  ApiClient,
  DaemonStores,
  actorRows,
  demandRows,
  eventRows,
  pipelineView,
  runControl,
  type ActorActivity,
  type FetchLike,
} from '@otheater/client';
import { API_ROUTES } from '@otheater/protocol';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { itWithLauncher } from '../launcher-fixture.js';
import { dataPaths } from '../paths.js';
import { assertFakeAgentBuilt, waitFor, withPlayDaemon, type PlayHarness } from './e2e-fixture.js';

/**
 * The Overview and Usage tabs (Phase 7, P13), end to end with the fake agent. The tab reads the
 * stores of the client and nothing else, so what is checked here is what the tab stands on:
 * - the stores built from the events follow a whole play (pipeline, demands with their
 *   dependencies, the Actors in flight with the time they have left, the recent events) with no
 *   read of the REST API per event; the reads are counted at the `fetch` of the client;
 * - pausing and resuming from the tab (`runControl`, the call the tab makes) writes the same
 *   events as `/pause` and `/resume`, and the Actor controls move the activity store.
 * Nothing real runs (N57): temporary folders, loopback, fake clock, fake code host.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const APPROVED_PLAY = '#ot-play write alpha and beta #outcome:approved';
const HANGING_PLAY = '#ot-play write alpha #actor-hang:alpha@1';

interface Rig {
  readonly harness: PlayHarness;
  readonly client: ApiClient;
  /** The client of the stores: its `fetch` is logged. */
  readonly watched: ApiClient;
  readonly fetchLog: string[];
  readonly send: (path: string, body: unknown) => Promise<{ status: number; json: any }>;
}

function withRig(extra: string, body: (rig: Rig) => Promise<void>): Promise<void> {
  return withPlayDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    { extra },
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
      const send: Rig['send'] = async (path, payload) => {
        const response = await fetch(`${harness.daemon.api.url}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return { status: response.status, json: await response.json() };
      };
      await body({ harness, client: make(), watched: make(counting), fetchLog, send });
    },
  );
}

const logOf = (harness: PlayHarness) => harness.daemon.store.events.readFrom(0, 100_000);

async function headOf(harness: PlayHarness): Promise<number> {
  return (await logOf(harness)).at(-1)?.id ?? 0;
}

function waitForPlay(harness: PlayHarness, scenarioId: string, state: string) {
  return waitFor(`the play of the scenario in ${state}`, async () => {
    const play = (await harness.plays(scenarioId))[0];
    return play?.state === state ? play : undefined;
  });
}

/** What the tab would show of a play, worked out from the stores alone. */
function overviewOf(stores: DaemonStores, scenarioId: string, playId: string, now: number) {
  const plays = Object.values(stores.plays.getState().byId).filter(
    (play) => play.scenarioId === scenarioId,
  );
  const play = stores.plays.getState().byId[playId];
  const parts = stores.demands.getState().byPlay[playId];
  const playIds = new Set(plays.map((item) => item.id));
  const paused = new Set(Object.keys(stores.activity.getState().pausedPlays));
  return {
    pipeline: play === undefined ? undefined : pipelineView(play, paused.has(playId)),
    demands: demandRows(playId, parts?.demands ?? [], stores.demands.getState().waiting),
    actors: actorRows(
      stores.activity.getState().actors,
      Object.fromEntries(
        Object.entries(stores.demands.getState().byPlay).map(([id, p]) => [id, p.demands]),
      ),
      playIds,
      now,
    ),
    events: eventRows(
      stores.events.getState().events,
      { id: scenarioId, playIds },
      ['session.update'],
      8,
    ),
  };
}

describe('the Overview tab, end to end with the fake agent', { timeout: 180_000 }, () => {
  itWithLauncher(
    'follows a whole play from the events, with no read of the REST API per event',
    async () => {
      await withRig('', async ({ harness, client, watched, fetchLog }) => {
        const stores = new DaemonStores(watched, { plays: 'all', refreshDebounceMs: 10 });
        await stores.start();
        const snapshot = fetchLog.length;
        const headBefore = await headOf(harness);
        // The Actors that were in flight at some point, as the activity store listed them.
        const listed = new Map<string, ActorActivity>();
        const unsubscribe = stores.activity.subscribe((state) => {
          for (const actor of Object.values(state.actors)) listed.set(actor.key, actor);
        });
        try {
          const scenarioId = await harness.openChat();
          await harness.producer.send(scenarioId, APPROVED_PLAY);
          const play = await waitForPlay(harness, scenarioId, 'DONE');
          await waitFor('the stores to reach the log', async () =>
            stores.status.getState().cursor === (await headOf(harness)) ? true : undefined,
          );
          await stores.whenIdle();

          const now = stores.events.getState().events.at(-1)?.timestamp ?? 0;
          const view = overviewOf(stores, scenarioId, play.id, now);
          const detail = await client.call(API_ROUTES.getPlay, { params: { playId: play.id } });

          // The pipeline reached the end, and the demands are the ones REST lists, with their dependencies.
          expect(view.pipeline).toMatchObject({ current: 'DONE', finished: true, paused: false });
          expect(detail.demands.length).toBeGreaterThanOrEqual(2);
          expect(
            view.demands.map((row) => ({ id: row.id, deps: row.dependsOn, st: row.state })),
          ).toEqual(
            [...detail.demands]
              .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
              .map((row) => ({ id: row.id, deps: row.dependsOn, st: row.state })),
          );
          expect(view.demands.every((row) => row.state === 'approved')).toBe(true);

          // The Actors were listed while they worked (each with the time left), and none is left.
          expect(listed.size).toBeGreaterThanOrEqual(2);
          // The time left, as the tab shows it: the timeout of the demand from the opening of the session.
          const byPlay = Object.fromEntries(
            Object.entries(stores.demands.getState().byPlay).map(([id, p]) => [id, p.demands]),
          );
          const rows = actorRows(Object.fromEntries(listed), byPlay, new Set([play.id]), 0);
          expect(rows.length).toBe(listed.size);
          // Stage Actors (the critic, the integrator) belong to no demand: no time left is shown.
          let withDemand = 0;
          for (const row of rows) {
            const demand = detail.demands.find((item) => item.id === row.demandId);
            if (demand === undefined) {
              expect(row.remainingMs).toBeUndefined();
              continue;
            }
            withDemand += 1;
            const actor = listed.get(row.key);
            expect(row.remainingMs).toBe((actor?.startedAt ?? 0) + demand.timeoutMin * 60_000);
          }
          expect(withDemand).toBeGreaterThanOrEqual(2);
          expect(Object.keys(stores.activity.getState().actors)).toEqual([]);
          expect(view.actors).toEqual([]);

          // The recent events, newest first, and none of the flood type.
          expect(view.events).toHaveLength(8);
          expect(view.events.every((row) => row.type !== 'session.update')).toBe(true);
          expect(view.events.map((row) => row.id)).toEqual(
            [...view.events.map((row) => row.id)].sort((a, b) => b - a),
          );

          // The reads after the snapshot: none per event (a play and its demands are never read
          // again; the only read of a scenario is the one `scenario.created` asks for).
          const after = fetchLog.slice(snapshot);
          const events = (await logOf(harness)).filter((event) => event.id > headBefore);
          expect(events.length).toBeGreaterThan(20);
          expect(after.filter((line) => line.startsWith('GET /v1/plays/'))).toEqual([]);
          expect(after.filter((line) => /demands|stages/.test(line))).toEqual([]);
          expect(after.filter((line) => line.startsWith('GET')).length).toBeLessThanOrEqual(3);
        } finally {
          unsubscribe();
          stores.close();
        }
      });
    },
  );
});

/** The events a control wrote after `head`, with the ids of the play and the volatile fields out. */
async function controlEvents(
  harness: PlayHarness,
  playId: string,
  head: number,
): Promise<string[]> {
  const kinds = new Set([
    'play.transitioned',
    'attempt.paused',
    'attempt.resumed',
    'session.resumed',
    'session.closed',
  ]);
  return (await logOf(harness))
    .filter((event) => event.id > head && event.playId === playId && kinds.has(event.type))
    .map((event) => {
      const volatile = new Set(['sessionId', 'timestamp', 'at', 'durationMs', 'counters']);
      const payload = Object.fromEntries(
        Object.entries(
          JSON.parse(JSON.stringify(event.payload).split(playId).join('<play>')) as Record<
            string,
            unknown
          >,
        ).filter(([key]) => !volatile.has(key)),
      );
      return `${event.type} ${JSON.stringify(payload)}`;
    });
}

describe('pausing from the tab, end to end with the fake agent', { timeout: 180_000 }, () => {
  /** A play whose first Actor hangs, paused and resumed by `how`; returns what the controls wrote. */
  async function pauseAndResume(how: 'tab' | 'slash'): Promise<string[]> {
    let written: string[] = [];
    await withRig('pause:\n  mode: interrupt\n', async ({ harness, client, send }) => {
      const scenarioId = await harness.openChat();
      await harness.producer.send(scenarioId, HANGING_PLAY);
      const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);
      const attemptId = `${play.id}/alpha/1`;
      await waitFor('alpha to be executing', async () =>
        (await harness.daemon.store.attempts.get(attemptId))?.state === 'executing' &&
        (await harness.daemon.store.attempts.get(attemptId))?.sessionId !== null
          ? true
          : undefined,
      );
      const head = await headOf(harness);

      if (how === 'tab') {
        expect(await runControl(client, { kind: 'play', playId: play.id }, 'pause')).toEqual({
          ok: true,
        });
      } else {
        const answer = await send(`/v1/scenarios/${scenarioId}/commands`, { text: '/pause' });
        expect(answer.status, JSON.stringify(answer.json)).toBe(200);
      }
      await waitFor('alpha to be paused', async () =>
        (await harness.daemon.store.attempts.get(attemptId))?.state === 'awaiting_resume'
          ? true
          : undefined,
      );
      if (how === 'tab') {
        expect(await runControl(client, { kind: 'play', playId: play.id }, 'resume')).toEqual({
          ok: true,
        });
      } else {
        const answer = await send(`/v1/scenarios/${scenarioId}/commands`, { text: '/resume' });
        expect(answer.status, JSON.stringify(answer.json)).toBe(200);
      }
      await waitForPlay(harness, scenarioId, 'DONE');
      written = await controlEvents(harness, play.id, head);
    });
    return written;
  }

  itWithLauncher(
    'pausing and resuming the play from the tab writes the same events as /pause and /resume',
    async () => {
      const fromTab = await pauseAndResume('tab');
      const fromSlash = await pauseAndResume('slash');
      expect(fromTab.some((line) => line.includes('"event":"PAUSE"'))).toBe(true);
      expect(fromTab.some((line) => line.startsWith('attempt.paused'))).toBe(true);
      expect(fromTab.some((line) => line.includes('"event":"RESUME"'))).toBe(true);
      expect(fromTab).toEqual(fromSlash);
    },
  );

  itWithLauncher(
    'pausing and resuming an Actor from the tab moves the activity store and refuses a repeat',
    async () => {
      await withRig('', async ({ harness, client, watched }) => {
        const stores = new DaemonStores(watched, { plays: 'all', refreshDebounceMs: 10 });
        await stores.start();
        try {
          const scenarioId = await harness.openChat();
          await harness.producer.send(scenarioId, HANGING_PLAY);
          const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);
          const attemptId = `${play.id}/alpha/1`;
          const caughtUp = async (): Promise<void> => {
            await waitFor('the stores to reach the log', async () =>
              stores.status.getState().cursor === (await headOf(harness)) ? true : undefined,
            );
          };
          await waitFor('alpha to be executing', async () =>
            (await harness.daemon.store.attempts.get(attemptId))?.sessionId != null
              ? true
              : undefined,
          );
          await caughtUp();
          expect(stores.activity.getState().actors[attemptId]).toMatchObject({
            attemptId,
            paused: undefined,
          });

          const target = { kind: 'actor', attemptId } as const;
          expect(await runControl(client, target, 'pause')).toEqual({ ok: true });
          await caughtUp();
          expect(stores.activity.getState().actors[attemptId]?.paused).toBe('actor');
          // A second pause is a conflict, and the tab says so instead of throwing.
          expect(await runControl(client, target, 'pause')).toEqual({
            ok: false,
            code: 'conflict',
          });

          expect(await runControl(client, target, 'resume')).toEqual({ ok: true });
          await caughtUp();
          await waitForPlay(harness, scenarioId, 'DONE');
          await caughtUp();
          expect(stores.activity.getState().actors[attemptId]).toBeUndefined();
        } finally {
          stores.close();
        }
      });
    },
  );
});
