// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-template-expressions -- the answers of the API are read as loose JSON */
import { readFile } from 'node:fs/promises';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { buildTrajectory, type TrajectoryEvent } from '@otheater/protocol';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeWithLauncher } from '../launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayHarness,
} from '../orchestration/e2e-fixture.js';
import { dataPaths } from '../paths.js';

/**
 * The trajectory of a play of the fake agent (P14, architecture 5.11): the read route returns the
 * events of the play, the folded view shows every turn of every attempt and the diff route and
 * `/trajectory` answer for a demand. Nothing real runs; the clock is a fake one.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

function withPlay(
  body: (
    harness: PlayHarness,
    get: (path: string, body?: unknown) => Promise<any>,
  ) => Promise<void>,
) {
  return withDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    {},
    async (harness) => {
      const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
      const get = async (path: string, body?: unknown): Promise<any> => {
        const response = await fetch(`${harness.daemon.api.url}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        return { status: response.status, json: JSON.parse(text), text };
      };
      await body(harness, get);
    },
  );
}

describeWithLauncher('the trajectory of a play (P14)', { timeout: 180_000 }, () => {
  it('shows every turn of the attempts of a finished play, and answers for the diff of a demand', async () => {
    await withPlay(async (harness, get) => {
      const scenarioId = await harness.openChat();
      await harness.producer.send(scenarioId, '#ot-play write alpha and beta');
      const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);
      await waitFor(
        'DONE',
        async () => (await harness.daemon.store.plays.get(play.id))?.state === 'DONE',
      );

      const items: TrajectoryEvent[] = [];
      let cursor: string | null = null;
      do {
        const page = await get(
          `/v1/plays/${play.id}/trajectory?limit=200${cursor === null ? '' : `&after=${cursor}`}`,
        );
        expect(page.status, page.text).toBe(200);
        items.push(...page.json.items);
        cursor = page.json.nextCursor;
      } while (cursor !== null);
      const types = items.map((event) => event.type);
      expect(types).toContain('session.update');
      expect(types).toContain('attempt.submitted');
      expect(items.every((event) => event.playId === play.id)).toBe(true);

      // the whole trajectory is the fold of those events: a turn per prompt of each attempt
      const folded = buildTrajectory(play.id, items);
      expect(folded.attempts.length).toBeGreaterThan(0);
      const prompts = items.filter((e) => e.type === 'session.prompt_finished');
      const turns = folded.attempts.flatMap((attempt) => attempt.turns);
      expect(turns.length).toBeGreaterThanOrEqual(prompts.length);
      expect(turns.some((turn) => turn.entries.length > 0)).toBe(true);

      // the daemon folds the same
      const attempts = await harness.daemon.store.attempts.list();
      const mine = attempts.filter((record) => record.playId === play.id);
      expect(mine.length).toBeGreaterThan(0);
      const withDemand = mine[0];
      expect(withDemand).toBeDefined();
      const diff = await get(`/v1/plays/${play.id}/demands/${withDemand?.demandId}/diff`);
      expect(diff.status, diff.text).toBe(200);
      expect(diff.json).toMatchObject({ playId: play.id, demandId: withDemand?.demandId });
      expect(diff.json.available).toBe(true);
      expect(diff.json.diff).toContain('written by the fake Actor');
      expect(diff.json.diff).toContain(`${withDemand?.demandId}.txt`);

      // every attempt closed with its turns and the steps of each
      expect(folded.attempts).toHaveLength(mine.length);
      for (const attempt of folded.attempts) {
        expect(attempt.state).toBe('closed');
        expect(attempt.turns.length).toBeGreaterThan(0);
      }

      // `/trajectory` summarises the same, and with a demand it prints the diff
      const url = `/v1/scenarios/${scenarioId}/commands`;
      const summary = await get(url, { text: '/trajectory' });
      expect(summary.status, summary.text).toBe(200);
      expect(summary.json.text).toContain(play.id);
      expect(summary.json.text).toContain(mine[0]?.attemptId);
      const shown = await get(url, {
        text: `/trajectory ${play.id} ${withDemand?.demandId}`,
      });
      expect(shown.json.text).toContain('written by the fake Actor');

      const missing = await get(`/v1/plays/${play.id}/demands/nope/diff`);
      expect(missing.status).toBe(404);
      const noPlay = await get('/v1/plays/nope/trajectory');
      expect(noPlay.status).toBe(404);
    });
  });
});
