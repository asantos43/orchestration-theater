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

/** The events the trajectory is made of, as `GET /v1/plays/:playId/trajectory` selects them. */
export function isTrajectoryEvent(type: string): boolean {
  return (
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
 * Folds the events of one play, in the order of the log, into its trajectory. The events of other
 * plays are skipped. Folding the same events twice gives the same trajectory, so a history read
 * and the live stream may overlap.
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
    if (event.playId !== undefined && event.playId !== playId) continue;
    if (event.playId === undefined && text(event.payload.playId) !== playId) continue;
    if (!isTrajectoryEvent(event.type)) continue;
    lastEventId = Math.max(lastEventId, event.id);
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
