// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the answers of the API are read as loose JSON */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { itWithLauncher } from '../launcher-fixture.js';
import { dataPaths } from '../paths.js';
import { assertFakeAgentBuilt, waitFor, withPlayDaemon, type PlayHarness } from './e2e-fixture.js';

/**
 * Pause and resume of a play and of an Actor (Phase 7, P2, N176), end to end with the fake agent
 * through the routes of the REST API. The first Actor of the play (`alpha`) does not end by itself
 * (`#actor-hang`), so the test has all the time it needs to pause the play while the attempt is in
 * flight; the clock is a fake one, so no timer of the daemon fires.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

type Send = (
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number; headers: Headers; json: any }>;

interface Rig {
  readonly harness: PlayHarness;
  readonly send: Send;
  readonly playId: string;
  readonly attemptPath: (verb: string) => string;
  readonly attemptsOf: () => Promise<
    readonly { attemptId: string; state: string; cause: string | null }[]
  >;
  readonly eventTypes: () => Promise<string[]>;
}

/** The daemon with a play whose first Actor hangs, started and waiting in `EXECUTING`. */
async function withHangingPlay(
  options: { readonly extra?: string },
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  await withPlayDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    { ...(options.extra === undefined ? {} : { extra: options.extra }) },
    async (harness) => {
      const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
      const send: Send = async (path, payload, headers = {}) => {
        const response = await fetch(`${harness.daemon.api.url}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers,
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        return { status: response.status, headers: response.headers, json: await response.json() };
      };
      const scenarioId = await harness.openChat();
      await harness.producer.send(scenarioId, '#ot-play write alpha #actor-hang:alpha@1');
      const play = await waitFor(
        'the play to exist',
        async () => (await harness.plays(scenarioId))[0],
      );
      const attemptId = `${play.id}/alpha/1`;
      const attemptsOf = async () =>
        (await harness.daemon.store.attempts.list())
          .filter((attempt) => attempt.playId === play.id && attempt.demandId === 'alpha')
          .map(({ attemptId: id, state, cause }) => ({ attemptId: id, state, cause }));
      // the first Actor is in flight, with its session open
      await waitFor('alpha to be executing', async () =>
        (await harness.daemon.store.attempts.get(attemptId))?.state === 'executing' &&
        (await harness.daemon.store.attempts.get(attemptId))?.sessionId !== null
          ? true
          : undefined,
      );
      await body({
        harness,
        send,
        playId: play.id,
        attemptPath: (verb) => `/v1/attempts/${encodeURIComponent(attemptId)}/${verb}`,
        attemptsOf,
        eventTypes: async () => (await harness.eventsOf(play.id)).map((event) => event.type),
      });
    },
  );
}

describe('pause and resume, end to end with the fake agent', { timeout: 180_000 }, () => {
  itWithLauncher(
    'pausing the play interrupts the Actor with the cause paused, opens nothing, and RESUME goes on from the same point',
    async () => {
      await withHangingPlay({}, async ({ harness, send, playId, attemptsOf, eventTypes }) => {
        const attemptId = `${playId}/alpha/1`;
        const paused = await send(`/v1/plays/${playId}/pause`, { mode: 'interrupt' });
        expect(paused.status, JSON.stringify(paused.json)).toBe(200);

        // the attempt was interrupted and its checkpoint kept: nothing else opened
        await waitFor('alpha to be paused', async () =>
          (await harness.daemon.store.attempts.get(attemptId))?.state === 'awaiting_resume'
            ? true
            : undefined,
        );
        expect(await attemptsOf()).toEqual([
          { attemptId, state: 'awaiting_resume', cause: 'paused' },
        ]);
        const types = await eventTypes();
        expect(types).toContain('attempt.paused');
        expect(types.filter((type) => type === 'attempt.paused')).toHaveLength(1);
        const stored = await harness.daemon.store.plays.get(playId);
        expect(stored?.state).toBe('EXECUTING');
        expect(
          (stored?.snapshot as { context: { paused: unknown } }).context.paused,
        ).not.toBeNull();
        const transition = (await harness.eventsOf(playId))
          .filter((event) => event.type === 'play.transitioned')
          .at(-1);
        expect(transition?.payload).toMatchObject({ event: 'PAUSE' });

        // still paused a moment later: no new attempt, no new stage
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await attemptsOf()).toHaveLength(1);
        expect(await harness.pathOf(playId)).not.toContain('CRITIQUING');

        // a second pause is a conflict, and an Actor paused by the play is not resumed by itself
        expect((await send(`/v1/plays/${playId}/pause`)).status).toBe(409);
        expect((await send(`/v1/attempts/${encodeURIComponent(attemptId)}/resume`)).status).toBe(
          409,
        );

        const resumed = await send(`/v1/plays/${playId}/resume`);
        expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);
        await waitFor('the play to finish', async () =>
          (await harness.daemon.store.plays.get(playId))?.state === 'DONE' ? true : undefined,
        );
        // alpha went on in the same attempt, with the same conversation: no second attempt of it
        const alpha = (await attemptsOf()).filter((attempt) => attempt.attemptId.includes('alpha'));
        expect(alpha).toHaveLength(1);
        expect(alpha[0]?.state).toBe('completed');
        expect(await harness.daemon.store.attempts.get(attemptId)).toMatchObject({
          resumes: 0,
        });
        const after = await eventTypes();
        expect(after).toContain('attempt.resumed');
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
      });
    },
  );

  itWithLauncher(
    'drain: the Actor in flight is not touched, and the play is paused with the stage still running',
    async () => {
      await withHangingPlay({}, async ({ harness, send, playId, attemptsOf, eventTypes }) => {
        const attemptId = `${playId}/alpha/1`;
        expect((await send(`/v1/plays/${playId}/pause`, { mode: 'drain' })).status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 500));
        // nothing was interrupted: the work in flight is left to finish
        expect(await attemptsOf()).toEqual([{ attemptId, state: 'executing', cause: null }]);
        expect(await eventTypes()).not.toContain('attempt.paused');
        const snapshot = (await harness.daemon.store.plays.get(playId))?.snapshot as {
          context: { paused: { mode: string } | null };
        };
        expect(snapshot.context.paused).toMatchObject({ mode: 'drain' });

        expect((await send(`/v1/plays/${playId}/resume`)).status).toBe(200);
        const resumedSnapshot = (await harness.daemon.store.plays.get(playId))?.snapshot as {
          context: { paused: unknown };
        };
        expect(resumedSnapshot.context.paused).toBeNull();
        expect(await attemptsOf()).toEqual([{ attemptId, state: 'executing', cause: null }]);
      });
    },
  );

  itWithLauncher(
    'pausing one Actor leaves the play running, and the resume follows the policy of the cause',
    async () => {
      await withHangingPlay({}, async ({ harness, send, playId, attemptPath, attemptsOf }) => {
        const attemptId = `${playId}/alpha/1`;
        const paused = await send(attemptPath('pause'));
        expect(paused.status, JSON.stringify(paused.json)).toBe(200);
        expect(paused.json.attempt).toMatchObject({
          attemptId,
          state: 'awaiting_resume',
          cause: 'paused',
        });
        const stored = await harness.daemon.store.plays.get(playId);
        expect(
          (stored?.snapshot as { context: { paused?: unknown } }).context.paused ?? null,
        ).toBeNull();
        const interruptions = await harness.daemon.store.interruptions.list();
        expect(interruptions).toMatchObject([
          { cause: 'paused', resumeForm: 'native', countedAsAttempt: false },
        ]);

        // a second pause of the same Actor is a conflict
        expect((await send(attemptPath('pause'))).status).toBe(409);

        const resumed = await send(attemptPath('resume'));
        expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);
        await waitFor('the play to finish', async () =>
          (await harness.daemon.store.plays.get(playId))?.state === 'DONE' ? true : undefined,
        );
        expect(
          (await attemptsOf()).find((attempt) => attempt.attemptId === attemptId),
        ).toMatchObject({ state: 'completed' });
        const resumedEvent = (await harness.eventsOf(playId)).find(
          (event) => event.type === 'session.resumed',
        );
        expect(resumedEvent?.payload).toMatchObject({ form: 'native', cause: 'paused' });
      });
    },
  );

  itWithLauncher(
    'cancelling an Actor ends the attempt as cancelled and the Director judges',
    async () => {
      await withHangingPlay(
        {},
        async ({ harness, send, playId, attemptPath, attemptsOf, eventTypes }) => {
          const attemptId = `${playId}/alpha/1`;
          const cancelled = await send(attemptPath('cancel'));
          expect(cancelled.status, JSON.stringify(cancelled.json)).toBe(200);
          expect(cancelled.json.attempt).toMatchObject({ attemptId, state: 'cancelled' });
          expect(await eventTypes()).toContain('attempt.cancelled');
          // the Director judges the cancel (point 2) and hands the demand to a new attempt
          await waitFor('the play to finish', async () =>
            (await harness.daemon.store.plays.get(playId))?.state === 'DONE' ? true : undefined,
          );
          expect(await attemptsOf()).toMatchObject([
            { attemptId, state: 'cancelled' },
            { attemptId: `${playId}/alpha/2`, state: 'completed' },
          ]);
        },
      );
    },
  );

  itWithLauncher('the same Idempotency-Key does not pause the play twice', async () => {
    await withHangingPlay({}, async ({ harness, send, playId, eventTypes }) => {
      const key = { 'idempotency-key': 'pause-once' };
      const first = await send(`/v1/plays/${playId}/pause`, { mode: 'drain' }, key);
      const again = await send(`/v1/plays/${playId}/pause`, { mode: 'drain' }, key);
      expect(first.status).toBe(200);
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotency-replayed')).toBe('true');
      const pauses = (await harness.eventsOf(playId)).filter(
        (event) =>
          event.type === 'play.transitioned' &&
          (event.payload as { event: string }).event === 'PAUSE',
      );
      expect(pauses).toHaveLength(1);
      expect(await eventTypes()).not.toContain('attempt.paused');
    });
  });
});
