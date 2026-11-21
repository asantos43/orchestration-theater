// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import type { AttemptRecord } from '@otheater/core';
import type { DaemonId } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttemptRunner } from '../../execution/attempt-runner.js';
import { createSilentLogger } from '../../logger.js';
import { makeTempDataDir, RecordingSituations } from '../../test-helpers.js';
import { generateApiToken } from '../files.js';
import { ApiServer } from '../server.js';
import { registerAttemptRoutes } from './attempts.js';
import type { ReadRouteDeps } from './deps.js';

/**
 * The route that lists the attempts of a play (P25, N200 item 1): the registry says the state, the
 * runner adds the model and who paused the attempt, and a pause the runner no longer holds is read
 * from the parked record. The runner is a stub that knows the live attempts by id.
 */

const DAEMON_ID = '3f2b8a52-6a9a-4a0e-9c7e-7d3e0f6a1b11' as DaemonId;

let dir: string;
let dispose: () => Promise<void>;
let server: ApiServer;
let token: string;
let store: InMemoryStore;
let clock: FakeClock;
let live: Map<string, { model: string; paused: 'actor' | 'play' | undefined }>;

type AttemptState = AttemptRecord['state'];

async function seedAttempt(
  playId: string,
  demandId: string,
  attempt: number,
  state: AttemptState,
  cause: AttemptRecord['cause'] = null,
): Promise<string> {
  const attemptId = `${playId}/${demandId}/${String(attempt)}`;
  await store.attempts.put({
    attemptId,
    playId,
    demandId,
    attempt,
    client: 'fake',
    profile: 'one',
    state,
    cause,
    sessionId: 'session-1',
    worktree: '/never/shown',
    branch: `attempt/${demandId}`,
    lastCheckpoint: null,
    lastCheckpointAt: null,
    lastEventAt: null,
    resumes: 0,
    freeResumes: 0,
  });
  await clock.advance(10);
  return attemptId;
}

async function seedPlay(id: string, paused: boolean, finished = false): Promise<void> {
  await store.plays.create({
    id,
    scenarioId: 's1',
    need: 'Do it',
    flowId: 'software',
    flowVersion: 1,
    state: 'EXECUTING',
  });
  if (paused) {
    await store.plays.update(id, { snapshot: { context: { paused: { mode: 'drain', at: 1 } } } });
  }
  if (finished) await store.plays.update(id, { state: 'DONE', finishedAt: 5 });
}

beforeEach(async () => {
  const tmp = await makeTempDataDir();
  dir = tmp.dir;
  dispose = tmp.dispose;
  token = generateApiToken();
  clock = new FakeClock();
  store = new InMemoryStore({ clock });
  live = new Map();
  await store.scenarios.create({
    id: 's1',
    kind: 'project',
    flowId: 'software',
    name: 'Scenario',
    folder: dir,
    profile: 'software',
    conventions: {},
    configOverride: {},
  });
  server = await ApiServer.start({
    port: 'auto',
    token,
    tokenMode: 'persistent',
    tokenFile: join(dir, 'api-token'),
    discoveryFile: join(dir, 'api.json'),
    daemonId: DAEMON_ID,
    maxBodyBytes: 1024,
    rejectionWindowMs: 10_000,
    now: () => 1_000_000,
    logger: createSilentLogger(),
    situations: new RecordingSituations(),
  });
  const attempts = {
    liveAttempt: (id: string) => live.get(id),
  } as unknown as AttemptRunner;
  registerAttemptRoutes(server.handlers, { store, attempts } as unknown as ReadRouteDeps);
});

afterEach(async () => {
  await server.stop();
  await dispose();
});

interface Item {
  readonly attemptId: string;
  readonly state: string;
  readonly model: string | null;
  readonly paused: 'actor' | 'play' | null;
  readonly worktree?: unknown;
}

async function list(
  path: string,
): Promise<{ status: number; json: { items: Item[]; nextCursor: string | null } }> {
  const response = await fetch(`${server.url}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, json: (await response.json()) as never };
}

describe('the attempts of a play', () => {
  it('answers not_found for a play that does not exist', async () => {
    const answer = await list('/v1/plays/none/attempts');
    expect(answer.status).toBe(404);
    expect((answer.json as unknown as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('lists only the attempts of that play, without the worktree, oldest first', async () => {
    await seedPlay('play-1', false);
    await seedPlay('play-2', false);
    const a = await seedAttempt('play-1', 'alpha', 1, 'executing');
    await seedAttempt('play-2', 'alpha', 1, 'executing');
    const b = await seedAttempt('play-1', 'beta', 1, 'completed');
    const answer = await list('/v1/plays/play-1/attempts');
    expect(answer.status).toBe(200);
    expect(answer.json.items.map((item) => item.attemptId)).toEqual([a, b]);
    expect(answer.json.items.every((item) => item.worktree === undefined)).toBe(true);
    expect(answer.json.nextCursor).toBeNull();
  });

  it('filters the open and the recent ones, and walks the pages by cursor', async () => {
    await seedPlay('play-1', false);
    const ids = [
      await seedAttempt('play-1', 'a', 1, 'executing'),
      await seedAttempt('play-1', 'b', 1, 'completed'),
      await seedAttempt('play-1', 'c', 1, 'awaiting_resume', 'quota'),
      await seedAttempt('play-1', 'd', 1, 'failed'),
    ];
    const open = await list('/v1/plays/play-1/attempts?open=true');
    expect(open.json.items.map((item) => item.attemptId)).toEqual([ids[0], ids[2]]);
    const recent = await list('/v1/plays/play-1/attempts?open=false');
    expect(recent.json.items.map((item) => item.attemptId)).toEqual([ids[1], ids[3]]);

    const first = await list('/v1/plays/play-1/attempts?limit=3');
    expect(first.json.items).toHaveLength(3);
    expect(first.json.nextCursor).not.toBeNull();
    const second = await list(
      `/v1/plays/play-1/attempts?limit=3&after=${encodeURIComponent(first.json.nextCursor ?? '')}`,
    );
    expect([...first.json.items, ...second.json.items].map((item) => item.attemptId)).toEqual(ids);
    expect(second.json.nextCursor).toBeNull();
  });

  it('takes the model and who paused from the runner while it holds the attempt', async () => {
    await seedPlay('play-1', false);
    const running = await seedAttempt('play-1', 'a', 1, 'executing');
    const held = await seedAttempt('play-1', 'b', 1, 'awaiting_resume', 'paused');
    live.set(running, { model: 'gpt-5', paused: undefined });
    live.set(held, { model: 'sonnet', paused: 'play' });
    const items = (await list('/v1/plays/play-1/attempts')).json.items;
    expect(items[0]).toMatchObject({ model: 'gpt-5', paused: null });
    expect(items[1]).toMatchObject({ model: 'sonnet', paused: 'play' });
  });

  it('reads a pause the runner no longer holds from the record: the play, or a person', async () => {
    // The daemon restarted: no live attempt, only the parked records.
    await seedPlay('play-1', true);
    await seedPlay('play-2', false);
    await seedAttempt('play-1', 'a', 1, 'awaiting_resume', 'paused');
    await seedAttempt('play-2', 'a', 1, 'awaiting_resume', 'paused');
    await seedAttempt('play-2', 'b', 1, 'awaiting_resume', 'quota');
    const ofPaused = (await list('/v1/plays/play-1/attempts')).json.items;
    expect(ofPaused).toMatchObject([{ model: null, paused: 'play' }]);
    const ofRunning = (await list('/v1/plays/play-2/attempts')).json.items;
    expect(ofRunning).toMatchObject([
      { model: null, paused: 'actor' },
      { model: null, paused: null },
    ]);
  });

  it('works with no runner (a daemon with no executor)', async () => {
    await seedPlay('play-1', false);
    await seedAttempt('play-1', 'a', 1, 'executing');
    const bare = await ApiServer.start({
      port: 'auto',
      token,
      tokenMode: 'persistent',
      tokenFile: join(dir, 'api-token-2'),
      discoveryFile: join(dir, 'api-2.json'),
      daemonId: DAEMON_ID,
      maxBodyBytes: 1024,
      rejectionWindowMs: 10_000,
      now: () => 1_000_000,
      logger: createSilentLogger(),
      situations: new RecordingSituations(),
    });
    try {
      registerAttemptRoutes(bare.handlers, { store } as unknown as ReadRouteDeps);
      const response = await fetch(`${bare.url}/v1/plays/play-1/attempts`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as { items: Item[] };
      expect(body.items).toMatchObject([{ model: null, paused: null }]);
    } finally {
      await bare.stop();
    }
  });
});
