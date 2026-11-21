// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the answers of the API are read as loose JSON */
import { join } from 'node:path';
import { Conflict } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import type { DaemonId } from '@otheater/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AttemptRunner } from '../../execution/attempt-runner.js';
import { createSilentLogger } from '../../logger.js';
import type { PlayRunner } from '../../pipeline/runner.js';
import { RecoveryGate } from '../../recovery/gate.js';
import { makeTempDataDir, RecordingSituations } from '../../test-helpers.js';
import type { DirectiveService } from '../../directives/index.js';
import type { LayoutPreferencesStore } from '../../layout/preferences.js';
import type { ProfileLoginService } from '../../profiles/login.js';
import type { ProfileService } from '../../profiles/service.js';
import { generateApiToken } from '../files.js';
import { ApiServer } from '../server.js';
import { registerCommandRoutes } from './index.js';

/**
 * The routes that pause and resume a play and pause, resume and cancel an Actor (Phase 7, P2,
 * N176). The runners are stubs that count what reaches them: what matters here is what the routes
 * do with the request (the mode, the `Idempotency-Key`, the id of the attempt with its slashes,
 * the errors) and WHEN the command runs (after the reconciliation of the start-up).
 */

const DAEMON_ID = '3f2b8a52-6a9a-4a0e-9c7e-7d3e0f6a1b11' as DaemonId;
const ATTEMPT = 'play-1/alpha/1';
const ENCODED = encodeURIComponent(ATTEMPT);

let dir: string;
let dispose: () => Promise<void>;
let server: ApiServer;
let token: string;
let gate: RecoveryGate;
let store: InMemoryStore;
let sent: { playId: string; event: Record<string, unknown> }[];
let calls: string[];
let paused: boolean;
let defaultMode: 'drain' | 'interrupt';

const play = {
  id: 'play-1',
  scenarioId: 's1',
  need: 'Do it',
  flowId: 'software',
  flowVersion: 1,
  state: 'EXECUTING',
};

beforeEach(async () => {
  const tmp = await makeTempDataDir();
  dir = tmp.dir;
  dispose = tmp.dispose;
  token = generateApiToken();
  gate = new RecoveryGate();
  sent = [];
  calls = [];
  paused = false;
  defaultMode = 'drain';
  const clock = new FakeClock();
  store = new InMemoryStore({ clock });
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
  await store.plays.create(play);
  await store.attempts.put({
    attemptId: ATTEMPT,
    playId: 'play-1',
    demandId: 'alpha',
    attempt: 1,
    client: 'fake',
    profile: 'one',
    state: 'executing',
    cause: null,
    sessionId: 'session-1',
    worktree: '/never/shown',
    branch: 'attempt/alpha',
    lastCheckpoint: null,
    lastCheckpointAt: null,
    lastEventAt: null,
    resumes: 0,
    freeResumes: 0,
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
    gate,
  });
  const runner = {
    send: async (playId: string, event: Record<string, unknown>) => {
      const record = await store.plays.get(playId);
      if (record === undefined) throw new Error('no play');
      sent.push({ playId, event });
      if (event.type === 'PAUSE') {
        if (paused) throw new Conflict('The play is already paused.');
        paused = true;
      } else if (event.type === 'RESUME') {
        if (!paused) throw new Conflict('The play is not paused.');
        paused = false;
      }
      return record;
    },
  } as unknown as PlayRunner;
  const attempts = {
    pauseAttempt: (id: string, origin: string) => {
      calls.push(`pause ${id} ${origin}`);
      return Promise.resolve(true);
    },
    resumeAttempt: (id: string, origin: string) => {
      calls.push(`resume ${id} ${origin}`);
      return true;
    },
    cancelAttempt: (id: string) => {
      calls.push(`cancel ${id}`);
      return Promise.resolve({});
    },
  } as unknown as AttemptRunner;
  registerCommandRoutes(server.handlers, {
    store,
    clock,
    logger: createSilentLogger(),
    directives: {} as DirectiveService,
    profiles: {} as ProfileService,
    logins: {} as ProfileLoginService,
    configPath: join(dir, 'config.yaml'),
    idempotencyTtlMs: () => 60_000,
    layout: {} as LayoutPreferencesStore,
    runner,
    attempts,
    pauseMode: () => defaultMode,
  });
});

afterEach(async () => {
  await server.stop();
  await dispose();
});

async function post(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, json: await response.json() };
}

describe('the routes that pause and resume a play', () => {
  beforeEach(() => {
    gate.open();
  });

  it('pauses with the mode of the configuration, and the request may name another', async () => {
    defaultMode = 'interrupt';
    const first = await post('/v1/plays/play-1/pause');
    expect(first.status).toBe(200);
    expect(first.json.play).toMatchObject({ id: 'play-1', state: 'EXECUTING' });
    expect(first.json.play.snapshot).toBeUndefined();
    expect(sent[0]?.event).toEqual({ type: 'PAUSE', mode: 'interrupt' });

    expect((await post('/v1/plays/play-1/resume', { reason: 'back' })).status).toBe(200);
    expect(sent[1]?.event).toEqual({ type: 'RESUME', reason: 'back' });

    await post('/v1/plays/play-1/pause', { mode: 'drain', reason: 'coffee' });
    expect(sent[2]?.event).toEqual({ type: 'PAUSE', mode: 'drain', reason: 'coffee' });
  });

  it('answers conflict for a second pause and for a resume of a play that is not paused', async () => {
    expect((await post('/v1/plays/play-1/resume')).json.error.code).toBe('conflict');
    expect((await post('/v1/plays/play-1/pause')).status).toBe(200);
    const again = await post('/v1/plays/play-1/pause');
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('conflict');
  });

  it('refuses a mode that does not exist and a body with more fields', async () => {
    expect((await post('/v1/plays/play-1/pause', { mode: 'now' })).status).toBe(400);
    expect((await post('/v1/plays/play-1/pause', { extra: 1 })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('does not repeat the effect with the same Idempotency-Key', async () => {
    const key = { 'idempotency-key': 'pause-1' };
    const first = await post('/v1/plays/play-1/pause', undefined, key);
    expect(first.status).toBe(200);
    expect(first.headers.get('idempotency-replayed')).toBeNull();
    const again = await post('/v1/plays/play-1/pause', undefined, key);
    expect(again.status).toBe(200);
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect(again.json).toEqual(first.json);
    // one PAUSE reached the machine; without the key, the second would be a conflict
    expect(sent).toHaveLength(1);
  });
});

describe('the routes that pause, resume and cancel an Actor', () => {
  beforeEach(() => {
    gate.open();
  });

  it('carries the id of the attempt, with its slashes, percent-encoded', async () => {
    const paused = await post(`/v1/attempts/${ENCODED}/pause`);
    expect(paused.status).toBe(200);
    expect(calls).toEqual([`pause ${ATTEMPT} actor`]);
    expect(paused.json.attempt).toMatchObject({ attemptId: ATTEMPT, playId: 'play-1' });
    // the worktree is a path of the machine: it is not part of the answer
    expect(paused.json.attempt.worktree).toBeUndefined();

    expect((await post(`/v1/attempts/${ENCODED}/resume`)).status).toBe(200);
    expect((await post(`/v1/attempts/${ENCODED}/cancel`)).status).toBe(200);
    expect(calls).toEqual([
      `pause ${ATTEMPT} actor`,
      `resume ${ATTEMPT} actor`,
      `cancel ${ATTEMPT}`,
    ]);
  });

  it('answers not_found for an attempt that does not exist, without calling the runner', async () => {
    for (const verb of ['pause', 'resume', 'cancel']) {
      const answer = await post(`/v1/attempts/${encodeURIComponent('play-1/zeta/1')}/${verb}`);
      expect(answer.status).toBe(404);
      expect(answer.json.error.code).toBe('not_found');
    }
    expect(calls).toEqual([]);
  });

  it('does not repeat the effect with the same Idempotency-Key', async () => {
    const key = { 'idempotency-key': 'cancel-1' };
    await post(`/v1/attempts/${ENCODED}/cancel`, undefined, key);
    const again = await post(`/v1/attempts/${ENCODED}/cancel`, undefined, key);
    expect(again.headers.get('idempotency-replayed')).toBe('true');
    expect(calls).toEqual([`cancel ${ATTEMPT}`]);
  });
});

describe('the routes and the recovery gate', () => {
  it('holds every one of them until the reconciliation is over, then runs each once', async () => {
    const answered: string[] = [];
    const paths = [
      '/v1/plays/play-1/pause',
      `/v1/attempts/${ENCODED}/pause`,
      `/v1/attempts/${ENCODED}/cancel`,
    ];
    const answers = paths.map((path) =>
      post(path).then((answer) => {
        answered.push(path);
        return answer;
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(answered).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(calls).toEqual([]);

    gate.open();
    const done = await Promise.all(answers);
    expect(done.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(sent).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});
