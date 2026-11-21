// SPDX-License-Identifier: MPL-2.0
import { NormalizedUpdateSchema, type EventEnvelope } from '@otheater/core';

/**
 * The trajectory of a play (architecture 5.11 and 5.13, P14 of docs/18): the events of the play
 * folded into attempts (the work of one Executor on one demand), turns inside each attempt (one
 * prompt, up to `session.prompt_finished`) and the entries of a turn (what the agent said, the
 * tool calls, the permissions, the output of a terminal). [proposta] Pure: the daemon (`/trajectory`)
 * and the clients (the Trajectories tab) build it from the same events, so both say the same.
 *
 * Only the events of {@link isTrajectoryEvent} take part; another one is ignored. A payload that
 * does not read is skipped, never thrown: a trajectory is a view and must survive an old row.
 * The ATIF export is Phase 8 and builds on the same events, not on this view.
 */

/**
 * The events of a direct session with an Actor that the trajectory of the session is made of
 * (P27 of docs/18, N206). [proposta] `direct.session.refused` is left out: a session that did not
 * open has no id, so there is nothing to fold it into; it stays in the log.
 */
export function isDirectTrajectoryEvent(type: string): boolean {
  return type.startsWith('direct.session.') && type !== 'direct.session.refused';
}

/** The events the trajectory is made of, as `GET /v1/plays/:playId/trajectory` selects them. */
export function isTrajectoryEvent(type: string): boolean {
  return (
    isDirectTrajectoryEvent(type) ||
    type.startsWith('session.') ||
    type.startsWith('attempt.') ||
    type.startsWith('permission.') ||
    type.startsWith('tool.') ||
    type.startsWith('terminal.') ||
    type === 'demand.transitioned'
  );
}

/** The event that carries the output of a terminal of the Actor, when the client sends it. [proposta] */
export const TERMINAL_OUTPUT_EVENT = 'terminal.output';

/** What the builder reads of an event: the envelope of the log, with or without `daemonId`. */
export type TrajectoryEvent = Pick<
  EventEnvelope,
  'id' | 'type' | 'timestamp' | 'payload' | 'playId' | 'attemptId'
>;

export type TrajectoryEntry =
  | { readonly kind: 'message'; readonly at: number; readonly text: string }
  /** What the Producer wrote to the Actor in a direct session, or the command of the client it ran. [proposta] */
  | {
      readonly kind: 'prompt';
      readonly at: number;
      readonly text: string;
      readonly command: boolean;
    }
  | { readonly kind: 'thought'; readonly at: number; readonly text: string }
  | {
      readonly kind: 'tool_call';
      readonly at: number;
      readonly toolCallId: string;
      readonly title: string;
      readonly toolKind: string;
      readonly status: string;
      readonly paths: readonly string[];
    }
  | {
      readonly kind: 'tool';
      readonly at: number;
      readonly callId: string;
      readonly tool: string;
      readonly summary: string;
      /** `undefined` while the call runs. */
      readonly outcome: string | undefined;
      readonly exitCode: number | null | undefined;
      readonly durationMs: number | undefined;
    }
  | {
      readonly kind: 'permission';
      readonly at: number;
      readonly tool: string;
      readonly toolCallId: string | undefined;
      readonly paths: readonly string[];
      /** `undefined` while the request waits for its answer. */
      readonly answer: string | undefined;
      readonly rule: string | undefined;
      readonly reason: string | undefined;
    }
  | {
      readonly kind: 'plan';
      readonly at: number;
      readonly entries: readonly { readonly content: string; readonly status: string }[];
    }
  | {
      readonly kind: 'terminal';
      readonly at: number;
      readonly toolCallId: string | undefined;
      readonly text: string;
    };

export interface TrajectoryTurn {
  /** From 1, in the attempt. */
  readonly index: number;
  readonly startedAt: number;
  /** `undefined` while the turn runs. */
  readonly endedAt: number | undefined;
  readonly stopReason: string | undefined;
  readonly entries: readonly TrajectoryEntry[];
}

/** A line of the life of an attempt: the session opened, a checkpoint, an interruption... */
export interface TrajectoryNotice {
  readonly at: number;
  readonly eventId: number;
  /** The type of the event (`session.interrupted`, `attempt.checkpoint`...). */
  readonly type: string;
  /** The facts the line shows (cause, form, sha, state), already short. */
  readonly detail: string | undefined;
}

export const TRAJECTORY_ATTEMPT_STATES = ['running', 'closed', 'interrupted', 'ended'] as const;
export type TrajectoryAttemptState = (typeof TRAJECTORY_ATTEMPT_STATES)[number];

export interface TrajectoryAttempt {
  readonly attemptId: string;
  readonly demandId: string | undefined;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly state: TrajectoryAttemptState;
  readonly turns: readonly TrajectoryTurn[];
  readonly notices: readonly TrajectoryNotice[];
}

export interface DemandTransition {
  readonly at: number;
  readonly demandId: string;
  readonly from: string | null;
  readonly to: string;
}

export interface Trajectory {
  readonly playId: string;
  readonly attempts: readonly TrajectoryAttempt[];
  /** The moves of the demands of the play, in order. */
  readonly transitions: readonly DemandTransition[];
  /** The id of the last event folded in (0 when there was none). */
  readonly lastEventId: number;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * What an event belongs to: the play it names, or, for an event of a direct session, the id of the
 * session. [proposta] A trajectory is built per "subject": a play, or a direct session, and a
 * session id (`direct-<hex>`) never collides with a play id. `undefined` for an event of neither.
 */
export function trajectorySubjectOf(
  event: Pick<TrajectoryEvent, 'type' | 'playId' | 'payload'>,
): string | undefined {
  if (event.playId !== undefined) return event.playId;
  if (isDirectTrajectoryEvent(event.type)) return text(event.payload.sessionId);
  return text(event.payload.playId);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

interface MutableTurn {
  index: number;
  startedAt: number;
  endedAt: number | undefined;
  stopReason: string | undefined;
  entries: TrajectoryEntry[];
}

interface MutableAttempt {
  attemptId: string;
  demandId: string | undefined;
  startedAt: number;
  endedAt: number | undefined;
  state: TrajectoryAttemptState;
  turns: MutableTurn[];
  notices: TrajectoryNotice[];
}

function openTurn(attempt: MutableAttempt, at: number): MutableTurn {
  const last = attempt.turns[attempt.turns.length - 1];
  if (last !== undefined && last.endedAt === undefined) return last;
  const turn: MutableTurn = {
    index: attempt.turns.length + 1,
    startedAt: at,
    endedAt: undefined,
    stopReason: undefined,
    entries: [],
  };
  attempt.turns.push(turn);
  return turn;
}

/** A short line with the facts of a lifecycle event. */
function detailOf(type: string, payload: Readonly<Record<string, unknown>>): string | undefined {
  const parts: string[] = [];
  const add = (label: string, value: unknown): void => {
    const shown = text(value);
    if (shown !== undefined) parts.push(`${label}=${shown.slice(0, 80)}`);
  };
  switch (type) {
    case 'session.interrupted':
      add('cause', payload.cause);
      add('form', payload.form);
      break;
    case 'session.resumed':
      add('form', payload.form);
      add('cause', payload.cause);
      break;
    case 'session.handoff':
      add('cause', payload.cause);
      break;
    case 'session.closed':
      add('reason', payload.reason);
      break;
    case 'attempt.checkpoint':
      add('sha', typeof payload.sha === 'string' ? payload.sha.slice(0, 10) : undefined);
      add('reason', payload.reason);
      break;
    case 'attempt.submitted':
      add('branch', payload.branch);
      break;
    case 'direct.session.opened':
      add('client', payload.client);
      add('workspace', payload.workspace);
      add('branch', payload.branch);
      break;
    case 'direct.session.closed':
      add('reason', payload.reason);
      add('work', payload.work);
      add('branch', payload.branch);
      break;
    case 'direct.session.promoted':
      add('target', payload.target);
      add('ref', payload.ref);
      break;
    case 'attempt.paused':
    case 'attempt.cancelled':
    case 'attempt.aborted':
      add('cause', payload.cause);
      add('reason', payload.reason);
      break;
    default:
      break;
  }
  return parts.length === 0 ? undefined : parts.join(' ');
}

function lifecycleState(
  type: string,
  current: TrajectoryAttemptState,
): TrajectoryAttemptState | undefined {
  switch (type) {
    case 'session.opened':
    case 'session.resumed':
    case 'attempt.resumed':
      return 'running';
    case 'session.interrupted':
    case 'attempt.paused':
      return 'interrupted';
    case 'session.closed':
      return current === 'interrupted' ? current : 'closed';
    case 'attempt.submitted':
    case 'attempt.cancelled':
    case 'attempt.aborted':
      return 'ended';
    default:
      return undefined;
  }
}

/**
 * The turn `number` of a direct session, created when the first event of it arrives. A session
 * counts its turns from 1; an event of turn 0 (nothing said yet) goes to the first one.
 */
function directTurn(attempt: MutableAttempt, number: number, at: number): MutableTurn {
  const index = Math.max(1, number);
  let turn = attempt.turns.find((item) => item.index === index);
  if (turn === undefined) {
    turn = { index, startedAt: at, endedAt: undefined, stopReason: undefined, entries: [] };
    attempt.turns.push(turn);
    attempt.turns.sort((a, b) => a.index - b.index);
  }
  return turn;
}

/**
 * Folds one `direct.session.*` event into the single attempt of its session. [proposta] A direct
 * session is drawn as one attempt (the session) with no demand, whose turns are the turns of the
 * conversation: what the Producer wrote or ran, what the Actor said, its tool calls and the
 * answers of the policy.
 */
function foldDirect(attempt: MutableAttempt, event: TrajectoryEvent): void {
  const { payload } = event;
  const at = event.timestamp;
  const turnNumber = typeof payload.turn === 'number' ? payload.turn : 1;
  switch (event.type) {
    case 'direct.session.message': {
      const body = text(payload.text) ?? '';
      const entries = directTurn(attempt, turnNumber, at).entries;
      if (payload.from === 'producer') {
        entries.push({ kind: 'prompt', at, text: body, command: false });
      } else {
        entries.push({ kind: 'message', at, text: body });
      }
      return;
    }
    case 'direct.session.command':
      directTurn(attempt, turnNumber, at).entries.push({
        kind: 'prompt',
        at,
        text: text(payload.command) ?? '',
        command: true,
      });
      return;
    case 'direct.session.tool': {
      const toolCallId = text(payload.toolCallId);
      if (toolCallId === undefined) return;
      const entries = directTurn(attempt, turnNumber, at).entries;
      const index = entries.findLastIndex(
        (entry) => entry.kind === 'tool_call' && entry.toolCallId === toolCallId,
      );
      const old = entries[index];
      const title = text(payload.title) ?? 'tool';
      const status = text(payload.status) ?? 'pending';
      if (old?.kind === 'tool_call') {
        entries[index] = { ...old, title, status };
      } else {
        entries.push({
          kind: 'tool_call',
          at,
          toolCallId,
          title,
          toolKind: 'tool',
          status,
          paths: [],
        });
      }
      return;
    }
    case 'direct.session.permission':
      directTurn(attempt, turnNumber, at).entries.push({
        kind: 'permission',
        at,
        tool: text(payload.title) ?? 'unknown',
        toolCallId: undefined,
        paths: [],
        answer: text(payload.answered),
        rule: text(payload.rule),
        reason: text(payload.reason),
      });
      return;
    case 'direct.session.turn_finished': {
      const turn = directTurn(attempt, turnNumber, at);
      turn.endedAt = at;
      turn.stopReason = text(payload.stopReason);
      const error = text(payload.error);
      if (error !== undefined) {
        attempt.notices.push({
          at,
          eventId: event.id,
          type: event.type,
          detail: `turn=${String(turnNumber)} error=${error.slice(0, 80)}`,
        });
      }
      return;
    }
    default: {
      // opened, closed and promoted: the life of the session.
      if (event.type === 'direct.session.closed') {
        attempt.state = 'closed';
        attempt.endedAt = at;
      }
      attempt.notices.push({
        at,
        eventId: event.id,
        type: event.type,
        detail: detailOf(event.type, payload),
      });
    }
  }
}

/**
 * Folds the events of one play, in the order of the log, into its trajectory. The events of other
 * plays are skipped. Folding the same events twice gives the same trajectory, so a history read
 * and the live stream may overlap. [proposta] `playId` may also be the id of a direct session
 * (P27 of docs/18): then the `direct.session.*` events of that session are folded into one
 * attempt with no demand (see {@link foldDirect}).
 */
export function buildTrajectory(playId: string, events: readonly TrajectoryEvent[]): Trajectory {
  const attempts = new Map<string, MutableAttempt>();
  const transitions: DemandTransition[] = [];
  let lastEventId = 0;

  const attemptOf = (
    event: TrajectoryEvent,
    demandId: string | undefined,
  ): MutableAttempt | undefined => {
    const key = event.attemptId;
    if (key === undefined) return undefined;
    let found = attempts.get(key);
    if (found === undefined) {
      found = {
        attemptId: key,
        demandId,
        startedAt: event.timestamp,
        endedAt: undefined,
        state: 'running',
        turns: [],
        notices: [],
      };
      attempts.set(key, found);
    } else if (found.demandId === undefined && demandId !== undefined) {
      found.demandId = demandId;
    }
    return found;
  };

  for (const event of events) {
    if (trajectorySubjectOf(event) !== playId) continue;
    if (!isTrajectoryEvent(event.type)) continue;
    lastEventId = Math.max(lastEventId, event.id);
    if (isDirectTrajectoryEvent(event.type)) {
      let session = attempts.get(playId);
      if (session === undefined) {
        session = {
          attemptId: playId,
          demandId: undefined,
          startedAt: event.timestamp,
          endedAt: undefined,
          state: 'running',
          turns: [],
          notices: [],
        };
        attempts.set(playId, session);
      }
      foldDirect(session, event);
      continue;
    }
    const payload = event.payload;
    const demandId = text(payload.demandId);

    if (event.type === 'demand.transitioned') {
      const to = text(payload.to);
      const id = text(payload.demandId);
      if (to !== undefined && id !== undefined) {
        const from = typeof payload.from === 'string' ? payload.from : null;
        transitions.push({ at: event.timestamp, demandId: id, from, to });
      }
      continue;
    }

    const attempt = attemptOf(event, demandId);
    if (attempt === undefined) continue;
    const at = event.timestamp;

    switch (event.type) {
      case 'session.update': {
        const update = NormalizedUpdateSchema.safeParse(payload.update);
        if (!update.success) break;
        const value = update.data;
        const turn = (): MutableTurn => openTurn(attempt, at);
        switch (value.kind) {
          case 'agent_message_chunk':
          case 'agent_thought_chunk': {
            if (value.content.type !== 'text') break;
            const kind = value.kind === 'agent_message_chunk' ? 'message' : 'thought';
            const entries = turn().entries;
            const last = entries[entries.length - 1];
            if (last?.kind === kind) {
              entries[entries.length - 1] = {
                kind,
                at: last.at,
                text: last.text + value.content.text,
              };
            } else {
              entries.push({ kind, at, text: value.content.text });
            }
            break;
          }
          case 'tool_call':
            turn().entries.push({
              kind: 'tool_call',
              at,
              toolCallId: value.toolCallId,
              title: value.title,
              toolKind: value.toolKind,
              status: value.status,
              paths: (value.locations ?? []).map((location) => location.path),
            });
            break;
          case 'tool_call_update': {
            const entries = turn().entries;
            const index = entries.findLastIndex(
              (entry) => entry.kind === 'tool_call' && entry.toolCallId === value.toolCallId,
            );
            const old = entries[index];
            if (old?.kind === 'tool_call') {
              entries[index] = {
                ...old,
                title: value.title ?? old.title,
                toolKind: value.toolKind ?? old.toolKind,
                status: value.status ?? old.status,
                paths:
                  value.locations === undefined ? old.paths : value.locations.map((l) => l.path),
              };
            }
            break;
          }
          case 'plan': {
            const entries = turn().entries;
            const plan = {
              kind: 'plan' as const,
              at,
              entries: value.entries.map((entry) => ({
                content: entry.content,
                status: entry.status,
              })),
            };
            const index = entries.findLastIndex((entry) => entry.kind === 'plan');
            if (index >= 0) entries[index] = plan;
            else entries.push(plan);
            break;
          }
          default:
            break;
        }
        break;
      }
      case 'session.prompt_finished': {
        const turn = openTurn(attempt, at);
        turn.endedAt = at;
        turn.stopReason = text(payload.stopReason);
        break;
      }
      case 'tool.called': {
        const callId = text(payload.callId);
        if (callId === undefined) break;
        openTurn(attempt, at).entries.push({
          kind: 'tool',
          at,
          callId,
          tool: text(payload.tool) ?? 'unknown',
          summary: text(payload.summary) ?? '',
          outcome: undefined,
          exitCode: undefined,
          durationMs: undefined,
        });
        break;
      }
      case 'tool.finished': {
        const callId = text(payload.callId);
        const turn = openTurn(attempt, at);
        const index = turn.entries.findLastIndex(
          (entry) => entry.kind === 'tool' && entry.callId === callId,
        );
        const old = turn.entries[index];
        if (old?.kind === 'tool') {
          turn.entries[index] = {
            ...old,
            outcome: text(payload.outcome) ?? 'ok',
            exitCode:
              typeof payload.exitCode === 'number' || payload.exitCode === null
                ? payload.exitCode
                : undefined,
            durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : undefined,
          };
        }
        break;
      }
      case 'permission.asked':
        openTurn(attempt, at).entries.push({
          kind: 'permission',
          at,
          tool: text(payload.tool) ?? 'unknown',
          toolCallId: text(payload.toolCallId),
          paths: strings(payload.paths),
          answer: undefined,
          rule: undefined,
          reason: undefined,
        });
        break;
      case 'permission.answered': {
        const turn = openTurn(attempt, at);
        const toolCallId = text(payload.toolCallId);
        const tool = text(payload.tool);
        const index = turn.entries.findLastIndex(
          (entry) =>
            entry.kind === 'permission' &&
            entry.answer === undefined &&
            (toolCallId !== undefined ? entry.toolCallId === toolCallId : entry.tool === tool),
        );
        const old = turn.entries[index];
        const answered = {
          answer: text(payload.answer),
          rule: text(payload.rule),
          reason: text(payload.reason),
        };
        if (old?.kind === 'permission') {
          turn.entries[index] = { ...old, ...answered };
        } else {
          turn.entries.push({
            kind: 'permission',
            at,
            tool: tool ?? 'unknown',
            toolCallId,
            paths: strings(payload.paths),
            ...answered,
          });
        }
        break;
      }
      case TERMINAL_OUTPUT_EVENT: {
        const output = text(payload.text);
        if (output === undefined) break;
        openTurn(attempt, at).entries.push({
          kind: 'terminal',
          at,
          toolCallId: text(payload.toolCallId),
          text: output,
        });
        break;
      }
      default: {
        const state = lifecycleState(event.type, attempt.state);
        if (state !== undefined) {
          attempt.state = state;
          if (state === 'ended' || state === 'closed') attempt.endedAt = at;
        }
        attempt.notices.push({
          at,
          eventId: event.id,
          type: event.type,
          detail: detailOf(event.type, payload),
        });
        break;
      }
    }
  }

  return {
    playId,
    attempts: [...attempts.values()].sort((a, b) => a.startedAt - b.startedAt),
    transitions,
    lastEventId,
  };
}
