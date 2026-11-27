// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the answers of the API are read as loose JSON */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeWithLauncher } from '../../launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayHarness,
} from '../../orchestration/e2e-fixture.js';
import { dataPaths } from '../../paths.js';

/**
 * The commands of the REST API (P6 of docs/17) that need the plays, against the daemon with the
 * fake agent in every role (nothing real runs): open a scenario, attach, queue ideas, answer a
 * decision of the Producer and cancel a play. The client is the compiled `dist/cli.js` of the fake
 * agent, so `pnpm build` comes first.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

function withPlayDaemon(
  options: { limits?: string; extra?: string },
  body: (harness: PlayHarness, send: Send) => Promise<void>,
): Promise<void> {
  return withDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    options,
    async (harness) => {
      const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
      await body(harness, async (method, path, body, headers = {}) => {
        const response = await fetch(`${harness.daemon.api.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        return { status: response.status, headers: response.headers, text, json: JSON.parse(text) };
      });
    },
  );
}

type Send = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number; headers: Headers; text: string; json: any }>;

describeWithLauncher(
  'the commands of the REST API with the fake agent (P6)',
  { timeout: 120_000 },
  () => {
    it('opens a scenario once per key, attaches a text and a file, and records each as an event', async () => {
      await withPlayDaemon({ extra: 'ideas:\n  drain: manual' }, async (harness, send) => {
        const { store } = harness.daemon;
        const key = { 'idempotency-key': 'open-1' };
        const opened = await send('POST', '/v1/scenarios', { repo: harness.rig.repo }, key);
        expect(opened.status, opened.text).toBe(200);
        const again = await send('POST', '/v1/scenarios', { repo: harness.rig.repo }, key);
        expect(again.headers.get('idempotency-replayed')).toBe('true');
        expect(again.text).toBe(opened.text);
        expect(await store.scenarios.list({})).toHaveLength(1);

        const scenarioId = opened.json.scenario.id as string;
        expect(opened.json.scenario.kind).toBe('project');
        expect(typeof opened.json.cursor).toBe('number');
        expect(opened.json.scenario).not.toHaveProperty('conventions');

        const pasted = await send(
          'POST',
          `/v1/scenarios/${scenarioId}/attachments`,
          { text: 'a note for the Director', name: 'note.txt' },
          { 'idempotency-key': 'attach-1' },
        );
        expect(pasted.status, pasted.text).toBe(200);
        expect(pasted.json).toMatchObject({ scenarioId, name: 'note.txt' });
        const repeat = await send(
          'POST',
          `/v1/scenarios/${scenarioId}/attachments`,
          { text: 'a note for the Director', name: 'note.txt' },
          { 'idempotency-key': 'attach-1' },
        );
        expect(repeat.headers.get('idempotency-replayed')).toBe('true');
        expect(await store.attachments.list(scenarioId)).toHaveLength(1);

        const missing = await send('POST', '/v1/scenarios/nope/attachments', { text: 'x' });
        expect(missing.status).toBe(404);

        const events = (await store.events.readFrom(0, 100_000)).map((event) => event.type);
        expect(events.filter((type) => type === 'scenario.created')).toHaveLength(1);
        expect(events.filter((type) => type === 'scenario.attachment_added')).toHaveLength(1);
      });
    });

    it('opens a project on a folder with files only when the Producer chooses how to start it (N332)', async () => {
      await withPlayDaemon({ extra: 'ideas:\n  drain: manual' }, async (harness, send) => {
        const folder = await mkdtemp(join(tmpdir(), 'otheater-open-init-'));
        try {
          await writeFile(join(folder, 'a.txt'), 'a\n');
          const asked = await send(
            'POST',
            '/v1/scenarios',
            { repo: folder },
            { 'idempotency-key': 'init-1' },
          );
          expect(asked.status, asked.text).toBe(400);
          expect(asked.json.error.code).toBe('invalid_input');
          expect(asked.json.error.details).toEqual({
            reason: 'needs_init',
            choices: ['commit_all', 'empty_commit'],
            state: 'files',
          });
          const both = await send(
            'POST',
            '/v1/scenarios',
            { repo: folder, newProject: true, init: 'commit_all' },
            { 'idempotency-key': 'init-2' },
          );
          expect(both.status, both.text).toBe(400);
          const opened = await send(
            'POST',
            '/v1/scenarios',
            { repo: folder, init: 'commit_all' },
            { 'idempotency-key': 'init-3' },
          );
          expect(opened.status, opened.text).toBe(200);
          expect(opened.json.scenario.kind).toBe('project');
          const types = (await harness.daemon.store.events.readFrom(0, 10_000)).map(
            (event) => event.type,
          );
          expect(types.filter((type) => type === 'project.repo_initialized')).toHaveLength(1);
        } finally {
          await rm(folder, { recursive: true, force: true });
        }
      });
    });

    it('queues, defers, requeues and discards an idea, and runs a pass of an empty queue', async () => {
      await withPlayDaemon({ extra: 'ideas:\n  drain: manual' }, async (harness, send) => {
        const scenarioId = await harness.openChat();
        const added = await send('POST', `/v1/scenarios/${scenarioId}/ideas`, {
          text: 'Add a dark mode',
          area: 'ui',
        });
        expect(added.status, added.text).toBe(200);
        expect(added.json.idea).toMatchObject({
          state: 'queued',
          source: 'tui',
          text: 'Add a dark mode',
        });
        const ideaId = added.json.idea.id as string;

        const requeueEarly = await send('POST', `/v1/ideas/${ideaId}/requeue`);
        expect(requeueEarly.status).toBe(409);
        const deferred = await send('POST', `/v1/ideas/${ideaId}/defer`, { reason: 'later' });
        expect(deferred.json.idea.state).toBe('deferred');
        const requeued = await send('POST', `/v1/ideas/${ideaId}/requeue`);
        expect(requeued.json.idea.state).toBe('queued');
        const discarded = await send('POST', `/v1/ideas/${ideaId}/discard`, { reason: 'no' });
        expect(discarded.json.idea.state).toBe('discarded');

        const missing = await send('POST', '/v1/ideas/nope/discard', { reason: 'no' });
        expect(missing.status).toBe(404);
        const invalid = await send('POST', `/v1/scenarios/${scenarioId}/ideas`, { text: '' });
        expect(invalid.status).toBe(400);
        expect(invalid.json.error.details.issues[0].path).toEqual(['text']);

        const drained = await send('POST', `/v1/scenarios/${scenarioId}/ideas/drain`);
        expect(drained.status, drained.text).toBe(200);
        expect(drained.json).toEqual({
          groups: 0,
          stopped: expect.toSatisfy((v: unknown) => v === null || typeof v === 'string'),
        });

        const types = (await harness.daemon.store.events.readFrom(0, 100_000)).map((e) => e.type);
        for (const type of ['idea.added', 'idea.deferred', 'idea.returned', 'idea.discarded']) {
          expect(types, type).toContain(type);
        }
      });
    });

    it('acts on an idea for one scenario only when it belongs to it, and answers 404 otherwise', async () => {
      await withPlayDaemon({ extra: 'ideas:\n  drain: manual' }, async (harness, send) => {
        const mine = await harness.openChat();
        const other = await harness.openGenericChat('other');
        const added = await send('POST', `/v1/scenarios/${other}/ideas`, { text: 'not yours' });
        const ideaId = added.json.idea.id as string;
        const query = `?scenarioId=${mine}`;
        const types = async (): Promise<string[]> =>
          (await harness.daemon.store.events.readFrom(0, 100_000)).map(
            (event): string => event.type,
          );

        // The answer is the one of an idea that does not exist, so it does not tell it exists.
        const gone = await send('POST', '/v1/ideas/nope/discard?scenarioId=' + mine, {
          reason: 'no',
        });
        expect(gone.status).toBe(404);
        for (const [path, body] of [
          [`/v1/ideas/${ideaId}/discard${query}`, { reason: 'no' }],
          [`/v1/ideas/${ideaId}/defer${query}`, { reason: 'later' }],
          [`/v1/ideas/${ideaId}/requeue${query}`, undefined],
        ] as const) {
          const refused = await send('POST', path, body);
          expect(refused.status, path).toBe(404);
          expect(refused.json.error.code).toBe('not_found');
          expect(refused.json.error.message).toBe(`There is no idea "${ideaId}"`);
        }
        // Nothing changed: the idea is still queued and no event says otherwise.
        expect((await harness.daemon.store.ideas.get(ideaId))?.state).toBe('queued');
        expect(await types()).not.toContain('idea.discarded');
        expect(await types()).not.toContain('idea.deferred');

        // With its own scenario, or with none (the id alone, as before), the command goes through.
        const deferred = await send('POST', `/v1/ideas/${ideaId}/defer?scenarioId=${other}`, {
          reason: 'later',
        });
        expect(deferred.json.idea.state).toBe('deferred');
        const requeued = await send('POST', `/v1/ideas/${ideaId}/requeue?scenarioId=${other}`);
        expect(requeued.json.idea.state).toBe('queued');
        const discarded = await send('POST', `/v1/ideas/${ideaId}/discard`, { reason: 'no' });
        expect(discarded.json.idea.state).toBe('discarded');
      });
    });

    it('answers the menu of a stopped play and cancels another, each one an event', async () => {
      await withPlayDaemon({ limits: '  attempts_per_demand: 2' }, async (harness, send) => {
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, '#ot-play write alpha #outcome:exhausted');
        const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);
        const menu = await waitFor('the menu', async () =>
          (await harness.producer.poll(scenarioId, 0)).asks.find(
            (ask) => ask.kind === 'producer_menu',
          ),
        );

        const wrong = await send('POST', `/v1/decisions/${menu.id}/answer`, {
          answer: { option: 'nonsense' },
        });
        expect(wrong.status, wrong.text).toBeGreaterThanOrEqual(400);
        expect((await harness.daemon.store.decisions.get(menu.id))?.state).toBe('pending');

        const missing = await send('POST', '/v1/decisions/nope/answer', {
          answer: { option: 'cancel' },
        });
        expect(missing.status).toBe(404);
        const noAnswer = await send('POST', `/v1/decisions/${menu.id}/answer`, {
          option: 'cancel',
        });
        expect(noAnswer.status).toBe(400);

        const answered = await send(
          'POST',
          `/v1/decisions/${menu.id}/answer`,
          { answer: { option: 'cancel', reason: 'not worth it' } },
          { 'idempotency-key': 'answer-1' },
        );
        expect(answered.status, answered.text).toBe(200);
        expect(answered.json.decision).toMatchObject({ id: menu.id, state: 'decided' });
        const again = await send(
          'POST',
          `/v1/decisions/${menu.id}/answer`,
          { answer: { option: 'cancel', reason: 'not worth it' } },
          { 'idempotency-key': 'answer-1' },
        );
        expect(again.headers.get('idempotency-replayed')).toBe('true');
        await waitFor(
          'CANCELLED',
          async () => (await harness.daemon.store.plays.get(play.id))?.state === 'CANCELLED',
        );

        const answers = (await harness.daemon.store.events.readFrom(0, 100_000)).filter(
          (event) => event.type === 'scenario.decision_answered',
        );
        expect(answers).toHaveLength(1);
        expect(answers[0]).toMatchObject({
          scenarioId,
          playId: play.id,
          payload: { decisionId: menu.id, playId: play.id },
        });
        // The text of the answer is in the decision, not in the event.
        expect(JSON.stringify(answers[0])).not.toContain('not worth it');

        // A play that is over cannot be cancelled again.
        const late = await send('POST', `/v1/plays/${play.id}/cancel`);
        expect(late.status).toBe(409);
      });
    });

    it('cancels a play that waits for the Producer, with and without a reason', async () => {
      await withPlayDaemon({ limits: '  attempts_per_demand: 2' }, async (harness, send) => {
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, '#ot-play write alpha #outcome:exhausted');
        const play = await waitFor('the play', async () => (await harness.plays(scenarioId))[0]);
        await waitFor(
          'AWAITING_PRODUCER',
          async () =>
            (await harness.daemon.store.plays.get(play.id))?.state === 'AWAITING_PRODUCER',
        );

        const cancelled = await send(
          'POST',
          `/v1/plays/${play.id}/cancel`,
          { reason: 'changed my mind' },
          { 'idempotency-key': 'cancel-1' },
        );
        expect(cancelled.status, cancelled.text).toBe(200);
        expect(cancelled.json.play).toMatchObject({ id: play.id, state: 'CANCELLED' });
        expect(cancelled.json.play).not.toHaveProperty('snapshot');
        const again = await send(
          'POST',
          `/v1/plays/${play.id}/cancel`,
          { reason: 'changed my mind' },
          { 'idempotency-key': 'cancel-1' },
        );
        expect(again.headers.get('idempotency-replayed')).toBe('true');
        expect(again.text).toBe(cancelled.text);

        const missing = await send('POST', '/v1/plays/nope/cancel');
        expect(missing.status).toBe(404);
        expect((await harness.pathOf(play.id)).at(-1)).toBe('CANCELLED');
      });
    });
  },
);
