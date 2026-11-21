// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { TelemetrySessions, type TelemetrySessionEntry } from './sessions.js';

function entry(
  sessionId: string,
  extra: Partial<TelemetrySessionEntry> = {},
): TelemetrySessionEntry {
  return {
    sessionId,
    client: 'codex',
    profile: 'p1',
    scenarioId: 'sc-1',
    playId: 'play-1',
    stageId: 'stage-a',
    attemptId: `play-1/stage-a/${sessionId}`,
    ...extra,
  };
}

describe('TelemetrySessions.correlate', () => {
  it('finds the work of a session by the id the record carries (Codex: conversation.id)', () => {
    const sessions = new TelemetrySessions();
    sessions.open(entry('s1'));
    expect(sessions.correlate({ 'conversation.id': 's1' }, {})).toEqual({
      scenarioId: 'sc-1',
      playId: 'play-1',
      attemptId: 'play-1/stage-a/s1',
      sessionId: 's1',
    });
    expect(sessions.correlate({ 'session.id': 's1' }, {})).toMatchObject({ sessionId: 's1' });
  });

  it('tells two sessions of one shared process apart', () => {
    const sessions = new TelemetrySessions();
    sessions.open(entry('s1'));
    sessions.open(entry('s2', { playId: 'play-2', scenarioId: 'sc-2' }));
    const resource = { 'otheater.client': 'codex', 'otheater.profile': 'p1' };
    expect(sessions.correlate({ 'conversation.id': 's2' }, resource)).toMatchObject({
      playId: 'play-2',
      scenarioId: 'sc-2',
      sessionId: 's2',
    });
    expect(sessions.correlate({ 'conversation.id': 's1' }, resource)).toMatchObject({
      playId: 'play-1',
      sessionId: 's1',
    });
  });

  it('falls back to the ids of the resource, and to the session of the attempt it names', () => {
    const sessions = new TelemetrySessions();
    sessions.open(entry('s1'));
    expect(
      sessions.correlate(
        {},
        { 'otheater.play_id': 'play-9', 'otheater.attempt_id': 'play-9/stage-b/1' },
      ),
    ).toEqual({
      scenarioId: null,
      playId: 'play-9',
      attemptId: 'play-9/stage-b/1',
      sessionId: null,
    });
    expect(sessions.correlate({}, { 'otheater.attempt_id': 'play-1/stage-a/s1' })).toEqual({
      scenarioId: 'sc-1',
      playId: 'play-1',
      attemptId: 'play-1/stage-a/s1',
      sessionId: 's1',
    });
    expect(
      sessions.correlate({}, { 'otheater.session_id': 's1', 'otheater.scenario_id': 'sc-x' }),
    ).toMatchObject({ sessionId: 's1', scenarioId: 'sc-1' });
  });

  it('leaves everything null for a record nothing identifies', () => {
    const sessions = new TelemetrySessions();
    expect(sessions.correlate({ 'conversation.id': 'unknown' }, {})).toEqual({
      scenarioId: null,
      playId: null,
      attemptId: null,
      sessionId: null,
    });
  });
});

describe('TelemetrySessions lifetime', () => {
  it('keeps a closed session for the grace period, then forgets it', () => {
    let now = 1_000;
    const sessions = new TelemetrySessions({ graceMs: 100, now: () => now });
    sessions.open(entry('s1'));
    sessions.close('s1');
    now += 99;
    expect(sessions.get('s1')).toBeDefined();
    now += 2;
    expect(sessions.get('s1')).toBeUndefined();
    expect(sessions.ofAttempt('play-1/stage-a/s1')).toBeUndefined();
    expect(sessions.size).toBe(0);
  });

  it('never forgets an open session', () => {
    let now = 0;
    const sessions = new TelemetrySessions({ graceMs: 1, now: () => now });
    sessions.open(entry('s1'));
    now += 1_000_000;
    expect(sessions.get('s1')).toBeDefined();
  });

  it('drops the oldest closed sessions when over the ceiling, never an open one', () => {
    let now = 0;
    const sessions = new TelemetrySessions({ graceMs: 1_000_000, max: 2, now: () => now });
    sessions.open(entry('open'));
    for (const id of ['a', 'b', 'c']) {
      now += 1;
      sessions.open(entry(id));
      sessions.close(id);
    }
    expect(sessions.get('open')).toBeDefined();
    expect(sessions.get('a')).toBeUndefined();
    expect(sessions.size).toBeLessThanOrEqual(3);
  });

  it('opens a session again after a close (a reload with the same id)', () => {
    let now = 0;
    const sessions = new TelemetrySessions({ graceMs: 10, now: () => now });
    sessions.open(entry('s1'));
    sessions.close('s1');
    sessions.open(entry('s1'));
    now += 1_000;
    expect(sessions.get('s1')).toBeDefined();
  });
});
