// SPDX-License-Identifier: MPL-2.0
import { parseDuration, TURN_TIMEOUT_MODES, type TurnTimeoutMode } from '../config.js';
import { createRoleResolver, type SummarizableEvent } from './phase6-update-summary.js';

/**
 * The "turn timeout measurement" mode of the real acceptance of Phase 6 (`phase6-acceptance.real
 * .test.ts`): with `OT_TEST_TURN_TIMEOUT` set (`limits.turn_timeout`, N184), the test does not wait
 * for the play to reach DONE. It waits for the first `session.turn_timeout`, lets the consequences
 * settle, and then checks what the log shows. All of it is a pure function over the events of the
 * log, so it is tested with made-up events and no client.
 *
 * Privacy: the lines carry ids, roles, numbers and event names, never the payload of a message.
 */

/** How the measurement is set: the duration as written (it goes into the yaml), in ms, and the action. */
export interface TurnTimeoutSetting {
  readonly text: string;
  readonly ms: number;
  readonly action: TurnTimeoutMode;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads `OT_TEST_TURN_TIMEOUT` (a duration as `limits.turn_timeout` takes it, `20s`, `500ms`, `2m`)
 * and `OT_TEST_ON_TURN_TIMEOUT` (`cancel`, the default, `notice` or `off`). `undefined` when the
 * measurement is off. Throws on a value the schema would refuse, and on the action alone: it would
 * do nothing, and a run that spends quota must not go on with a setting that was ignored.
 */
export function readTurnTimeoutSetting(env: Env): TurnTimeoutSetting | undefined {
  const text = env.OT_TEST_TURN_TIMEOUT ?? '';
  const rawAction = env.OT_TEST_ON_TURN_TIMEOUT ?? '';
  if (text === '') {
    if (rawAction !== '') {
      throw new Error('OT_TEST_ON_TURN_TIMEOUT needs OT_TEST_TURN_TIMEOUT to be set');
    }
    return undefined;
  }
  const ms = parseDuration(text);
  if (ms === undefined || ms <= 0) {
    throw new Error(
      `OT_TEST_TURN_TIMEOUT must be a duration such as 20s, 500ms or 2m, got "${text}"`,
    );
  }
  const action = rawAction === '' ? 'cancel' : rawAction;
  if (!(TURN_TIMEOUT_MODES as readonly string[]).includes(action)) {
    throw new Error(
      `OT_TEST_ON_TURN_TIMEOUT must be one of ${TURN_TIMEOUT_MODES.join(', ')}, got "${rawAction}"`,
    );
  }
  return { text, ms, action: action as TurnTimeoutMode };
}

/** One `session.turn_timeout` of the log. */
export interface TurnTimeoutRecord {
  readonly eventId: number;
  readonly timestamp: number;
  readonly sessionId: string;
  readonly attemptId: string | undefined;
  readonly playId: string | undefined;
  readonly limitMs: number;
  readonly elapsedMs: number;
  readonly action: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The `session.turn_timeout` events, in the order of the log. */
export function turnTimeoutsOf(events: readonly SummarizableEvent[]): TurnTimeoutRecord[] {
  const found: TurnTimeoutRecord[] = [];
  for (const event of events) {
    if (event.type !== 'session.turn_timeout') continue;
    const payload = asRecord(event.payload);
    const sessionId = asString(payload?.sessionId);
    const limitMs = asNumber(payload?.limitMs);
    const elapsedMs = asNumber(payload?.elapsedMs);
    const action = asString(payload?.action);
    if (
      payload === undefined ||
      sessionId === undefined ||
      limitMs === undefined ||
      elapsedMs === undefined ||
      action === undefined
    ) {
      continue;
    }
    found.push({
      eventId: event.id,
      timestamp: event.timestamp,
      sessionId,
      attemptId: asString(payload.attemptId) ?? event.attemptId,
      playId: asString(payload.playId) ?? event.playId,
      limitMs,
      elapsedMs,
      action,
    });
  }
  return found;
}

const TERMINAL_STATES = new Set(['DONE', 'CANCELLED', 'FAILED']);

/**
 * Whether the measurement can stop: some `session.turn_timeout` is in the log and either the
 * consequences had `settleMs` to show (the clock is the one of the events, `nowMs` the same one)
 * or a play reached a final state after it.
 */
export function measurementSettled(
  events: readonly SummarizableEvent[],
  nowMs: number,
  settleMs: number,
): boolean {
  const first = turnTimeoutsOf(events)[0];
  if (first === undefined) return false;
  if (nowMs - first.timestamp >= settleMs) return true;
  return events.some(
    (event) =>
      event.id > first.eventId &&
      event.type === 'play.transitioned' &&
      TERMINAL_STATES.has(String(asRecord(event.payload)?.to)),
  );
}

/**
 * What the log must show after a measurement run, as problems (empty: all good):
 * - `cancel` and `notice`: at least one `session.turn_timeout`, every one with that action and
 *   with the limit that was set (so the setting did reach the daemon);
 * - `cancel`: the session of every attempt that was cut has a `session.closed` after the cut (a
 *   turn of the Director has no attempt and no `session.closed`: the test checks that no process
 *   of it is left alive);
 * - `off`: no `session.turn_timeout` at all.
 */
export function checkTurnTimeoutRun(
  events: readonly SummarizableEvent[],
  setting: TurnTimeoutSetting,
): string[] {
  const timeouts = turnTimeoutsOf(events);
  const problems: string[] = [];
  if (setting.action === 'off') {
    if (timeouts.length > 0) {
      problems.push(
        `limits.on_turn_timeout is off but the log has ${String(timeouts.length)} session.turn_timeout`,
      );
    }
    return problems;
  }
  if (timeouts.length === 0) {
    problems.push(
      `no session.turn_timeout in the log (limit ${String(setting.ms)} ms, action ${setting.action}): no turn lasted that long, or the limit did not reach the daemon`,
    );
  }
  for (const timeout of timeouts) {
    if (timeout.action !== setting.action) {
      problems.push(
        `session.turn_timeout of ${timeout.sessionId} has action ${timeout.action}, expected ${setting.action}`,
      );
    }
    if (timeout.limitMs !== setting.ms) {
      problems.push(
        `session.turn_timeout of ${timeout.sessionId} has limitMs ${String(timeout.limitMs)}, expected ${String(setting.ms)}`,
      );
    }
    if (setting.action === 'cancel' && timeout.attemptId !== undefined) {
      const closed = events.some(
        (event) =>
          event.type === 'session.closed' &&
          event.id > timeout.eventId &&
          asRecord(event.payload)?.sessionId === timeout.sessionId,
      );
      if (!closed) {
        problems.push(
          `the session ${timeout.sessionId} was cut by the turn limit but has no session.closed after it`,
        );
      }
    }
  }
  return problems;
}

/** The events that say what the cut caused: the session closing, the attempt ending, the play moving. */
const AFTER_EVENTS = new Set([
  'session.closed',
  'attempt.aborted',
  'attempt.submit_failed',
  'attempt.submitted',
  'play.transitioned',
  'chat.director_silent',
]);

export interface TurnTimeoutSummaryOptions {
  /** Prefix of every line. */
  readonly prefix?: string;
  /** The time the run started, to print the time of each event since then. */
  readonly startedAt?: number;
  /** How many lines of consequences. */
  readonly maxAfter?: number;
}

/**
 * The lines about the turn limit for the log of the run: each `session.turn_timeout` (session,
 * role, limit, elapsed, action) and what followed the first one in the log (`session.closed`, the
 * end of the attempt and each `play.transitioned` with the event of the machine, such as
 * `ACTOR_TIMED_OUT` or `SUBMIT_FAILED`). The role is `director` for a session with no attempt.
 */
export function summarizeTurnTimeouts(
  events: readonly SummarizableEvent[],
  options: TurnTimeoutSummaryOptions = {},
): string[] {
  const { prefix = '', startedAt = 0, maxAfter = 20 } = options;
  const timeouts = turnTimeoutsOf(events);
  const at = (timestamp: number): string => `${((timestamp - startedAt) / 1000).toFixed(1)}s`;
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  if (timeouts.length === 0) return [`${prefix}turn_timeout: none in the log`];
  const resolveRole = createRoleResolver(events);
  const lines = [`${prefix}turn_timeout: ${String(timeouts.length)} in the log`];
  for (const timeout of timeouts) {
    const role =
      timeout.attemptId === undefined
        ? 'director'
        : (resolveRole({
            attemptId: timeout.attemptId,
            playId: timeout.playId,
            beforeEventId: timeout.eventId,
          }) ?? 'unknown');
    lines.push(
      `${prefix}turn_timeout ${timeout.sessionId} (${role}): limit ${seconds(timeout.limitMs)}, elapsed ${seconds(timeout.elapsedMs)}, action ${timeout.action}@${at(timeout.timestamp)}`,
    );
  }
  const first = timeouts[0];
  if (first === undefined) return lines;
  const after = events.filter((event) => event.id > first.eventId && AFTER_EVENTS.has(event.type));
  for (const event of after.slice(0, maxAfter)) {
    const payload = asRecord(event.payload) ?? {};
    let detail = '';
    if (event.type === 'play.transitioned') {
      detail = ` ${String(payload.event)} ${String(payload.from)} > ${String(payload.to)}`;
    } else if (event.type === 'session.closed') {
      detail = ` ${String(payload.sessionId)} (${String(payload.reason)})`;
    } else if (event.type === 'attempt.submit_failed') {
      detail = ` tool ${String(payload.tool)}`;
    }
    lines.push(
      `${prefix}after the first turn_timeout: ${event.type}${detail}@${at(event.timestamp)}`,
    );
  }
  if (after.length > maxAfter) {
    lines.push(
      `${prefix}after the first turn_timeout: ${String(after.length - maxAfter)} more events`,
    );
  }
  return lines;
}
