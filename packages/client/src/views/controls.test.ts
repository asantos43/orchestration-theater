// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it, vi } from 'vitest';
import { ApiNetworkError, ApiRequestError } from '../errors.js';
import type { ActorActivity } from '../stores/activity.js';
import { play } from '../stores/fixtures.test-support.js';
import { actorControls, playControls, runControl } from './controls.js';

const ACTOR: ActorActivity = {
  key: 'P1/D1/1',
  sessionId: 's1',
  attemptId: 'P1/D1/1',
  playId: 'P1',
  demandId: 'D1',
  executor: { client: 'claude', profile: 'main', model: 'sonnet' },
  startedAt: 1,
  paused: undefined,
};

describe('what the controls offer', () => {
  it('pauses an open play and resumes it once paused; a finished play has neither', () => {
    const open = play('P1', 'S1', { state: 'EXECUTING' });
    expect(playControls(open, new Set())).toEqual({ pause: true, resume: false });
    expect(playControls(open, new Set(['P1']))).toEqual({ pause: false, resume: true });
    // The flag of the record says it too (a play paused before this client connected, P25).
    expect(playControls({ ...open, paused: true }, new Set())).toEqual({
      pause: false,
      resume: true,
    });
    expect(playControls({ ...open, finishedAt: 5 }, new Set())).toEqual({
      pause: false,
      resume: false,
    });
    expect(playControls(undefined, new Set())).toEqual({ pause: false, resume: false });
  });

  it('pauses a running Actor and resumes a paused one', () => {
    expect(actorControls(ACTOR)).toEqual({ pause: true, resume: false });
    expect(actorControls({ ...ACTOR, paused: 'actor' })).toEqual({ pause: false, resume: true });
    expect(actorControls({ ...ACTOR, attemptId: undefined })).toEqual({
      pause: false,
      resume: false,
    });
    expect(actorControls(undefined)).toEqual({ pause: false, resume: false });
  });
});

describe('runControl', () => {
  function fakeClient() {
    return {
      pausePlay: vi.fn().mockResolvedValue({}),
      resumePlay: vi.fn().mockResolvedValue({}),
      pauseAttempt: vi.fn().mockResolvedValue({}),
      resumeAttempt: vi.fn().mockResolvedValue({}),
    };
  }

  it('calls the route of the target and the action, with no pause mode', async () => {
    const client = fakeClient();
    await expect(
      runControl(client as never, { kind: 'play', playId: 'P1' }, 'pause'),
    ).resolves.toEqual({
      ok: true,
    });
    await runControl(client, { kind: 'play', playId: 'P1' }, 'resume');
    await runControl(client, { kind: 'actor', attemptId: 'P1/D1/1' }, 'pause');
    await runControl(client, { kind: 'actor', attemptId: 'P1/D1/1' }, 'resume');
    expect(client.pausePlay).toHaveBeenCalledWith('P1');
    expect(client.resumePlay).toHaveBeenCalledWith('P1');
    expect(client.pauseAttempt).toHaveBeenCalledWith('P1/D1/1');
    expect(client.resumeAttempt).toHaveBeenCalledWith('P1/D1/1');
  });

  it('turns a refusal of the daemon into its code and never throws', async () => {
    const client = fakeClient();
    client.pausePlay.mockRejectedValue(
      new ApiRequestError({ status: 409, body: { code: 'conflict', message: 'no' } }),
    );
    client.resumePlay.mockRejectedValue(
      new ApiNetworkError({ reason: 'connection', origin: 'http://127.0.0.1:9' }),
    );
    client.pauseAttempt.mockRejectedValue(new Error('odd'));
    await expect(
      runControl(client as never, { kind: 'play', playId: 'P1' }, 'pause'),
    ).resolves.toEqual({
      ok: false,
      code: 'conflict',
    });
    await expect(
      runControl(client as never, { kind: 'play', playId: 'P1' }, 'resume'),
    ).resolves.toEqual({
      ok: false,
      code: 'network',
    });
    await expect(
      runControl(client as never, { kind: 'actor', attemptId: 'a' }, 'pause'),
    ).resolves.toEqual({ ok: false, code: 'invalid' });
  });
});
