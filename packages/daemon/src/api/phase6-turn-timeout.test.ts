// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  checkTurnTimeoutRun,
  measurementSettled,
  readTurnTimeoutSetting,
  summarizeTurnTimeouts,
  turnTimeoutsOf,
  type TurnTimeoutSetting,
} from './phase6-turn-timeout.js';
import type { SummarizableEvent } from './phase6-update-summary.js';

let nextId = 1;
function event(
  type: string,
  timestamp: number,
  payload: Record<string, unknown>,
  envelope: { playId?: string; attemptId?: string } = {},
): SummarizableEvent {
  return { id: nextId++, type, timestamp, payload, ...envelope };
}

const cancel: TurnTimeoutSetting = { text: '20s', ms: 20_000, action: 'cancel' };
const notice: TurnTimeoutSetting = { text: '20s', ms: 20_000, action: 'notice' };
const off: TurnTimeoutSetting = { text: '20s', ms: 20_000, action: 'off' };

const SECRET = 'SEGREDO-do-modelo';

/** A run cut in the Actor: the cut, the close of its session and the pipeline reacting. */
function cutRun(action = 'cancel'): SummarizableEvent[] {
  nextId = 1;
  return [
    event('executor.selected', 1000, { role: 'actor', playId: 'play-1', outcome: 'selected' }),
    event('session.opened', 1100, { sessionId: 'ses_actor', playId: 'play-1', attemptId: 'att-1' }),
    event(
      'session.turn_timeout',
      21_100,
      { sessionId: 'ses_actor', limitMs: 20_000, elapsedMs: 20_003, action, attemptId: 'att-1' },
      { attemptId: 'att-1', playId: 'play-1' },
    ),
    event('session.closed', 21_500, { sessionId: 'ses_actor', reason: 'cancelled' }),
    event('play.transitioned', 21_600, {
      event: 'ACTOR_TIMED_OUT',
      from: 'EXECUTING',
      to: 'JUDGING',
      text: SECRET,
    }),
  ];
}

describe('the turn limit measurement of the phase 6 real acceptance', () => {
  describe('readTurnTimeoutSetting', () => {
    it('is off with no variable', () => {
      expect(readTurnTimeoutSetting({})).toBeUndefined();
      expect(readTurnTimeoutSetting({ OT_TEST_TURN_TIMEOUT: '' })).toBeUndefined();
    });

    it('reads the duration as limits.turn_timeout does, with cancel as the default', () => {
      expect(readTurnTimeoutSetting({ OT_TEST_TURN_TIMEOUT: '20s' })).toEqual(cancel);
      expect(readTurnTimeoutSetting({ OT_TEST_TURN_TIMEOUT: '2m' })).toEqual({
        text: '2m',
        ms: 120_000,
        action: 'cancel',
      });
      expect(readTurnTimeoutSetting({ OT_TEST_TURN_TIMEOUT: '500ms' })?.ms).toBe(500);
    });

    it('takes the three actions', () => {
      for (const action of ['cancel', 'notice', 'off'] as const) {
        expect(
          readTurnTimeoutSetting({ OT_TEST_TURN_TIMEOUT: '20s', OT_TEST_ON_TURN_TIMEOUT: action })
            ?.action,
        ).toBe(action);
      }
    });

    it('refuses what the schema refuses, and the action with no limit', () => {
      for (const bad of ['20', 'abc', '0s', '-5s', '1.5m', '20 s']) {
        expect(() => readTurnTimeoutSetting({ OT_TEST_TURN_TIMEOUT: bad }), bad).toThrow(
          /OT_TEST_TURN_TIMEOUT/,
        );
      }
      expect(() =>
        readTurnTimeoutSetting({ OT_TEST_TURN_TIMEOUT: '20s', OT_TEST_ON_TURN_TIMEOUT: 'kill' }),
      ).toThrow(/OT_TEST_ON_TURN_TIMEOUT/);
      expect(() => readTurnTimeoutSetting({ OT_TEST_ON_TURN_TIMEOUT: 'cancel' })).toThrow(
        /needs OT_TEST_TURN_TIMEOUT/,
      );
    });
  });

  describe('checkTurnTimeoutRun', () => {
    it('accepts a cancelled attempt whose session was closed', () => {
      expect(checkTurnTimeoutRun(cutRun(), cancel)).toEqual([]);
    });

    it('asks for at least one session.turn_timeout', () => {
      const problems = checkTurnTimeoutRun([event('play.created', 1, {})], cancel);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('no session.turn_timeout');
      expect(checkTurnTimeoutRun([], notice)).toHaveLength(1);
    });

    it('needs the session.closed of a cut attempt, after the cut', () => {
      const without = cutRun().filter((item) => item.type !== 'session.closed');
      expect(checkTurnTimeoutRun(without, cancel).join('\n')).toContain('no session.closed');
      // A close that came before the cut does not count.
      const early = cutRun();
      const closed = early.splice(3, 1);
      early.unshift(...closed);
      const renumbered = early.map((item, index) => ({ ...item, id: index + 1 }));
      expect(checkTurnTimeoutRun(renumbered, cancel).join('\n')).toContain('no session.closed');
    });

    it('does not ask for a session.closed of the Director (no attempt)', () => {
      nextId = 1;
      const director = [
        event('session.turn_timeout', 5000, {
          sessionId: 'ses_director',
          limitMs: 20_000,
          elapsedMs: 20_000,
          action: 'cancel',
        }),
      ];
      expect(checkTurnTimeoutRun(director, cancel)).toEqual([]);
    });

    it('notice does not ask for a close, but the action and the limit must match', () => {
      const noticed = cutRun('notice').filter((item) => item.type !== 'session.closed');
      expect(checkTurnTimeoutRun(noticed, notice)).toEqual([]);
      expect(checkTurnTimeoutRun(noticed, cancel).join('\n')).toContain('action notice');
      expect(checkTurnTimeoutRun(cutRun(), { ...cancel, ms: 30_000 }).join('\n')).toContain(
        'limitMs 20000, expected 30000',
      );
    });

    it('with off, there must be none', () => {
      expect(checkTurnTimeoutRun([event('play.created', 1, {})], off)).toEqual([]);
      expect(checkTurnTimeoutRun(cutRun(), off)).toHaveLength(1);
    });
  });

  describe('measurementSettled', () => {
    it('waits for a cut, then for the settle time or the end of the play', () => {
      const run = cutRun();
      expect(measurementSettled([], 99_999_999, 60_000)).toBe(false);
      expect(measurementSettled(run.slice(0, 2), 99_999_999, 60_000)).toBe(false);
      expect(measurementSettled(run, 22_000, 60_000)).toBe(false);
      expect(measurementSettled(run, 21_100 + 60_000, 60_000)).toBe(true);
      const ended = [
        ...run,
        event('play.transitioned', 22_000, { event: 'CANCEL', from: 'JUDGING', to: 'CANCELLED' }),
      ];
      expect(measurementSettled(ended, 22_001, 60_000)).toBe(true);
    });

    it('does not take a final state from before the cut', () => {
      nextId = 1;
      const events = [
        event('play.transitioned', 1, { event: 'X', from: 'A', to: 'DONE' }),
        event('session.turn_timeout', 2, {
          sessionId: 's',
          limitMs: 1,
          elapsedMs: 1,
          action: 'notice',
        }),
      ];
      expect(measurementSettled(events, 3, 60_000)).toBe(false);
    });
  });

  describe('summarizeTurnTimeouts', () => {
    it('says there was none', () => {
      expect(summarizeTurnTimeouts([], { prefix: 'm: ' })).toEqual([
        'm: turn_timeout: none in the log',
      ]);
    });

    it('lists each cut with its role and what followed, with no payload text', () => {
      const lines = summarizeTurnTimeouts(cutRun(), { prefix: 'm: ', startedAt: 1000 });
      expect(lines).toEqual([
        'm: turn_timeout: 1 in the log',
        'm: turn_timeout ses_actor (actor?): limit 20.0s, elapsed 20.0s, action cancel@20.1s',
        'm: after the first turn_timeout: session.closed ses_actor (cancelled)@20.5s',
        'm: after the first turn_timeout: play.transitioned ACTOR_TIMED_OUT EXECUTING > JUDGING@20.6s',
      ]);
      expect(lines.join('\n')).not.toContain(SECRET);
    });

    it('names the session of a cut with no attempt as the Director', () => {
      nextId = 1;
      const lines = summarizeTurnTimeouts([
        event('session.turn_timeout', 5000, {
          sessionId: 'ses_director',
          limitMs: 20_000,
          elapsedMs: 20_010,
          action: 'notice',
        }),
      ]);
      expect(lines[1]).toBe(
        'turn_timeout ses_director (director): limit 20.0s, elapsed 20.0s, action notice@5.0s',
      );
    });

    it('bounds the consequences', () => {
      const run = cutRun();
      for (let index = 0; index < 5; index += 1) {
        run.push(event('attempt.submit_failed', 30_000 + index, { tool: 'submitPlan' }));
      }
      const lines = summarizeTurnTimeouts(run, { maxAfter: 3 });
      expect(
        lines.filter((line) => line.startsWith('after the first turn_timeout: ')),
      ).toHaveLength(4);
      expect(lines.at(-1)).toBe('after the first turn_timeout: 4 more events');
    });
  });

  it('ignores a session.turn_timeout that does not have the shape of the schema', () => {
    nextId = 1;
    expect(
      turnTimeoutsOf([event('session.turn_timeout', 1, { sessionId: 's' }), event('x', 2, {})]),
    ).toEqual([]);
  });
});
