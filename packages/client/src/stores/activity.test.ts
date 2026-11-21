// SPDX-License-Identifier: MPL-2.0
import type { ApiEventEnvelope } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { applyEvents, initialActivity, installActivity, reduceActivity } from './index.js';
import { event } from './fixtures.test-support.js';

const EXECUTOR = { client: 'claude', profile: 'main', model: 'sonnet' };

function opened(id: number, attempt: string | undefined, session = 's1'): ApiEventEnvelope {
  const env = event(
    id,
    'session.opened',
    {
      sessionId: session,
      executor: EXECUTOR,
      via: 'acp',
      canLoad: true,
      playId: 'P1',
      demandId: 'D1',
      ...(attempt === undefined ? {} : { attemptId: attempt }),
    },
    { playId: 'P1' },
  );
  return attempt === undefined ? env : { ...env, attemptId: attempt };
}

function onAttempt(
  id: number,
  type: string,
  payload: ApiEventEnvelope['payload'],
  attempt = 'P1/D1/1',
): ApiEventEnvelope {
  return { ...event(id, type, payload, { playId: 'P1' }), attemptId: attempt };
}

function transition(id: number, name: string, from: string, to: string): ApiEventEnvelope {
  return event(
    id,
    'play.transitioned',
    { event: name, from, to, counters: {}, effects: [] },
    { scenarioId: 'S1', playId: 'P1' },
  );
}

const run = (events: ApiEventEnvelope[]) =>
  applyEvents(initialActivity(), events, reduceActivity);

describe('the activity store', () => {
  it('starts empty and an install sets the cursor', () => {
    expect(initialActivity()).toMatchObject({ loaded: false, actors: {}, pausedPlays: {} });
    expect(installActivity(7)).toMatchObject({ loaded: true, lastEventId: 7, actors: {} });
  });

  it('keeps an Actor from session.opened to session.closed, keyed by the attempt', () => {
    const open = run([opened(1, 'P1/D1/1')]);
    expect(Object.keys(open.actors)).toEqual(['P1/D1/1']);
    expect(open.actors['P1/D1/1']).toMatchObject({
      sessionId: 's1',
      playId: 'P1',
      demandId: 'D1',
      executor: EXECUTOR,
      startedAt: 1_700_000_000_001,
      paused: undefined,
    });
    const closed = applyEvents(
      open,
      [onAttempt(2, 'session.closed', { sessionId: 's1', reason: 'completed' })],
      reduceActivity,
    );
    expect(closed.actors).toEqual({});
  });

  it('a session of no attempt is keyed by the session id', () => {
    const state = run([opened(1, undefined, 'chat-1')]);
    expect(Object.keys(state.actors)).toEqual(['chat-1']);
  });

  it('ignores the close of a session that is no longer the one of the attempt', () => {
    const state = run([
      opened(1, 'P1/D1/1', 's1'),
      opened(2, 'P1/D1/1', 's2'),
      onAttempt(3, 'session.closed', { sessionId: 's1', reason: 'interrupted' }),
    ]);
    expect(state.actors['P1/D1/1']?.sessionId).toBe('s2');
    // the attempt keeps the stamp of its first session
    expect(state.actors['P1/D1/1']?.startedAt).toBe(1_700_000_000_001);
  });

  it('a paused attempt stays on the list after its session closes, until it resumes', () => {
    const paused = run([
      opened(1, 'P1/D1/1'),
      onAttempt(2, 'attempt.paused', { origin: 'actor', checkpointed: true }),
      onAttempt(3, 'session.closed', { sessionId: 's1', reason: 'interrupted' }),
    ]);
    expect(paused.actors['P1/D1/1']?.paused).toBe('actor');
    const resumed = applyEvents(
      paused,
      [onAttempt(4, 'attempt.resumed', { strategy: 'native' })],
      reduceActivity,
    );
    expect(resumed.actors['P1/D1/1']?.paused).toBeUndefined();
    // the new session of the resume replaces the old one
    const again = applyEvents(
      resumed,
      [opened(5, 'P1/D1/1', 's2'), onAttempt(6, 'session.closed', { sessionId: 's2', reason: 'completed' })],
      reduceActivity,
    );
    expect(again.actors).toEqual({});
  });

  it('cancel, abort and submit end the attempt', () => {
    for (const type of ['attempt.cancelled', 'attempt.aborted', 'attempt.submitted']) {
      const payload = type === 'attempt.aborted' ? { error: 'x' } : {};
      const state = run([opened(1, 'P1/D1/1'), onAttempt(2, type, payload)]);
      expect(state.actors, type).toEqual({});
    }
  });

  it('a pause of an attempt this store never saw changes nothing', () => {
    const before = initialActivity();
    const after = applyEvents(
      before,
      [onAttempt(1, 'attempt.paused', { origin: 'play', checkpointed: false })],
      reduceActivity,
    );
    expect(after.actors).toEqual({});
  });

  it('follows the pause and the resume of a play, and clears both when the play ends', () => {
    const pause = transition(2, 'PAUSE', 'EXECUTING', 'EXECUTING');
    const state = run([opened(1, 'P1/D1/1'), pause]);
    expect(Object.keys(state.pausedPlays)).toEqual(['P1']);
    const resumed = applyEvents(
      state,
      [transition(3, 'RESUME', 'EXECUTING', 'EXECUTING')],
      reduceActivity,
    );
    expect(resumed.pausedPlays).toEqual({});
    const paused = applyEvents(resumed, [{ ...pause, id: 4 }], reduceActivity);
    expect(paused.pausedPlays).toHaveProperty('P1');
    const done = applyEvents(
      paused,
      [transition(5, 'FINISH', 'DELIVERING', 'DONE')],
      reduceActivity,
    );
    expect(done.pausedPlays).toEqual({});
    expect(done.actors).toEqual({});
  });

  it('is not woken by an event that is not its business', () => {
    const state = initialActivity();
    expect(reduceActivity(state, event(1, 'session.update', {}))).toBe(state);
  });
});
