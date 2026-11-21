// SPDX-License-Identifier: MPL-2.0
import type { EventEnvelope, JsonValue, TelemetrySpan, TelemetrySpanStatus } from '@otheater/core';
import { isFinalPlayState } from '@otheater/protocol';
import {
  CLOSED_BY,
  DAEMON_SPAN_RESOURCE,
  GEN_AI,
  GEN_AI_OPERATION,
  OT,
  SPAN_KIND,
  SPAN_NAME,
  WAIT_KIND,
  providerNameOf,
  type WaitKind,
} from './span-conventions.js';
import {
  attemptSpanId,
  playSpanId,
  sessionSpanId,
  stageSpanId,
  toolSpanId,
  traceIdForAttempt,
  traceIdForKey,
  traceIdForPlay,
  waitSpanId,
} from './span-ids.js';

/**
 * The fold from the event log to the spans of the daemon (Phase 8, P4, N214 (a); architecture
 * 5.11). [proposta] Pure and synchronous: it reads events in id order and returns the spans each
 * one **closes**, so nothing here touches a clock, a store or a file.
 *
 * - A span opens on an event and closes on another, with the time of each event (the clock of the
 *   daemon that wrote it), so a span is only known whole and is written when it closes. A span
 *   still open when the daemon stops is not written; the next run opens it again (see
 *   {@link SpanProjection.watermark}).
 * - Every id comes from ids of the log (`span-ids.ts`), so reading the same events again gives the
 *   same spans.
 * - There are no `attempt.started`, `session.started` or `stage.*` events (the plan of the phase
 *   named them, the log has other names): the attempt opens on the first event that carries its id
 *   and ends with `attempt.submitted | cancelled | aborted`; the session is `session.opened` to
 *   `session.closed`; a stage is a visit of a state of the play machine, from the
 *   `play.transitioned` that entered it to the one that left it.
 * - The text of a prompt, a message or a tool call never goes in an attribute: the tool summary,
 *   the output of `submit`, the paths and the errors stay in the log.
 * - What ends with the play (its attempts, sessions and tool calls still open when the machine
 *   reaches `DONE` or `CANCELLED`) is closed with the time of that transition, and says so in
 *   `otheater.closed_by`.
 */

const NS_PER_MS = 1_000_000n;

function ns(ms: number): bigint {
  return BigInt(ms) * NS_PER_MS;
}

function str(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function record(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
}

/** The kinds of wait that `wait.started` can carry (P15). */
function waitKindOf(value: JsonValue | undefined): WaitKind | undefined {
  if (value === WAIT_KIND.promptQueue) return WAIT_KIND.promptQueue;
  if (value === WAIT_KIND.poolAdmission) return WAIT_KIND.poolAdmission;
  return undefined;
}

function reasonsOf(value: JsonValue | undefined): Set<string> {
  const reasons = new Set<string>();
  for (const entry of Array.isArray(value) ? value : []) {
    const reason = str(entry);
    if (reason !== undefined) reasons.add(reason);
  }
  return reasons;
}

/** What the payload of `wait.started` says about who waited. */
function waitExtra(event: EventEnvelope): Record<string, JsonValue | undefined> {
  const { payload } = event;
  return {
    [OT.client]: str(payload.client),
    [OT.profile]: str(payload.profile),
    [OT.role]: str(payload.role),
    [OT.waitSource]: str(payload.promptSource),
    [OT.waitPriority]: num(payload.promptPriority),
  };
}

/** An attribute bag without the keys whose value is `undefined`. */
function attrs(input: Readonly<Record<string, JsonValue | undefined>>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** The ids of an event: the envelope first, then the payload (an old row may carry only one). */
interface Ids {
  readonly scenarioId: string | undefined;
  readonly playId: string | undefined;
  readonly attemptId: string | undefined;
}

function idsOf(event: EventEnvelope): Ids {
  return {
    scenarioId: event.scenarioId ?? str(event.payload.scenarioId),
    playId: event.playId ?? str(event.payload.playId),
    attemptId: event.attemptId ?? str(event.payload.attemptId),
  };
}

interface ExecutorInfo {
  readonly client: string | undefined;
  readonly profile: string | undefined;
  readonly model: string | undefined;
}

function executorOf(value: JsonValue | undefined): ExecutorInfo {
  const executor = record(value);
  return {
    client: str(executor?.client),
    profile: str(executor?.profile),
    model: str(executor?.model),
  };
}

function executorKey(executor: ExecutorInfo): string {
  return `${executor.client ?? ''}/${executor.profile ?? ''}/${executor.model ?? ''}`;
}

interface PlayState {
  readonly playId: string;
  readonly scenarioId: string | undefined;
  readonly startId: number;
  readonly startTs: number;
  flow: string | undefined;
  stage: { state: string; enteredId: number; enteredTs: number } | undefined;
}

interface AttemptState {
  readonly attemptId: string;
  readonly ids: Ids;
  readonly startId: number;
  readonly startTs: number;
  /** The stage (or the play) it started in: the span it hangs from. */
  readonly parentSpanId: string | null;
  role: string | undefined;
  executor: ExecutorInfo | undefined;
  /** The session the attempt is in now: what a tool call hangs from. */
  activeSessionId: string | undefined;
  /**
   * `attempt.submitted | cancelled | aborted` was read while a session of the attempt was still
   * open. The runner writes `session.closed` after it, so the attempt span ends with its last
   * session and no child outlives its parent.
   */
  ending: string | undefined;
}

interface SessionState {
  readonly sessionId: string;
  readonly ids: Ids;
  readonly startId: number;
  readonly startTs: number;
  readonly executor: ExecutorInfo;
  readonly via: string | undefined;
  readonly role: string | undefined;
  turns: number;
  stopReason: string | undefined;
}

interface ToolState {
  readonly key: string;
  readonly ids: Ids;
  readonly startId: number;
  readonly startTs: number;
  readonly tool: string | undefined;
  readonly callId: string;
  readonly role: string | undefined;
  readonly heavy: boolean | undefined;
}

interface WaitState {
  readonly key: string;
  readonly ids: Ids;
  readonly startId: number;
  readonly startTs: number;
  readonly kind: WaitKind;
  /** What it hangs from when it has no attempt: the stage (or the play) it started in. */
  readonly parentSpanId: string | null;
  /** A wait with no play or attempt (a prompt in the queue) has a trace of its own, from this key. */
  readonly traceKey?: string;
  readonly reasons: Set<string>;
  readonly extra: Record<string, JsonValue | undefined>;
}

/** What a span needs before it is a `TelemetrySpan`. */
interface SpanInput {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly kind: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly status?: TelemetrySpanStatus;
  readonly statusMessage?: string | null;
  readonly attributes: Record<string, JsonValue>;
  readonly ids: Ids;
  readonly sessionId?: string | undefined;
}

function buildSpan(input: SpanInput): TelemetrySpan {
  const start = ns(input.startMs);
  const end = ns(Math.max(input.startMs, input.endMs));
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId,
    name: input.name,
    kind: input.kind,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    status: input.status ?? 'unset',
    statusMessage: input.statusMessage ?? null,
    attributes: {
      ...(input.ids.scenarioId === undefined ? {} : { [OT.scenarioId]: input.ids.scenarioId }),
      ...(input.ids.playId === undefined ? {} : { [OT.playId]: input.ids.playId }),
      ...(input.ids.attemptId === undefined ? {} : { [OT.attemptId]: input.ids.attemptId }),
      ...(input.sessionId === undefined ? {} : { [OT.sessionId]: input.sessionId }),
      ...input.attributes,
    },
    resource: DAEMON_SPAN_RESOURCE,
    scenarioId: input.ids.scenarioId ?? null,
    playId: input.ids.playId ?? null,
    attemptId: input.ids.attemptId ?? null,
    sessionId: input.sessionId ?? null,
  };
}

function pushSpan(out: TelemetrySpan[], span: TelemetrySpan | undefined): void {
  if (span !== undefined) out.push(span);
}

/** The events that never start an attempt: they only end or report on one that exists. */
const NEVER_STARTS_AN_ATTEMPT: ReadonlySet<string> = new Set([
  'attempt.submitted',
  'attempt.cancelled',
  'attempt.aborted',
  'attempt.reset_wait_ended',
  'session.closed',
  'session.prompt_finished',
  'session.update',
  'tool.finished',
  'permission.answered',
]);

function startsAnAttempt(type: string): boolean {
  if (NEVER_STARTS_AN_ATTEMPT.has(type)) return false;
  return (
    type.startsWith('session.') ||
    type.startsWith('attempt.') ||
    type.startsWith('permission.') ||
    type.startsWith('tool.')
  );
}

/** How many selections of a play are kept to tell the role of a session (the newest). */
const SELECTIONS_PER_PLAY = 16;

export class SpanProjection {
  readonly #plays = new Map<string, PlayState>();
  readonly #attempts = new Map<string, AttemptState>();
  readonly #sessions = new Map<string, SessionState>();
  readonly #tools = new Map<string, ToolState>();
  readonly #resetWaits = new Map<string, WaitState>();
  readonly #demandWaits = new Map<string, WaitState>();
  /** `wait.started` of the prompt queue and the pool (P15), by kind and id of the wait. */
  readonly #eventWaits = new Map<string, WaitState>();
  /** `executor.selected` of each play, to give a session the role it was chosen for. */
  readonly #selections = new Map<string, { role: string; key: string }[]>();

  /** Reads one event, in id order; returns the spans it closed (none, most of the time). */
  apply(event: EventEnvelope): TelemetrySpan[] {
    const out: TelemetrySpan[] = [];
    switch (event.type) {
      case 'play.created':
        this.#playCreated(event);
        break;
      case 'play.transitioned':
        this.#playTransitioned(event, out);
        break;
      case 'executor.selected':
        this.#selected(event);
        break;
      case 'session.opened':
        this.#sessionOpened(event);
        break;
      case 'session.prompt_finished':
        this.#promptFinished(event);
        break;
      case 'session.closed':
        this.#sessionClosed(event, out);
        break;
      case 'tool.called':
        this.#toolCalled(event);
        break;
      case 'tool.finished':
        this.#toolFinished(event, out);
        break;
      case 'attempt.reset_wait_started':
        this.#resetWaitStarted(event);
        break;
      case 'attempt.reset_wait_ended':
        this.#resetWaitEnded(event, out);
        break;
      case 'demand.waiting':
        this.#demandWaiting(event);
        break;
      case 'demand.resumed':
        this.#demandResumed(event, out);
        break;
      case 'wait.started':
        this.#waitStarted(event);
        break;
      case 'wait.ended':
        this.#waitEnded(event, out);
        break;
      case 'daemon.started':
        this.#daemonStarted(event, out);
        break;
      case 'attempt.submitted':
      case 'attempt.cancelled':
      case 'attempt.aborted':
        this.#attemptEnded(event, out);
        return out;
      default:
        break;
    }
    // Anything else that carries an attempt id may be the first one it has.
    if (startsAnAttempt(event.type)) this.#ensureAttempt(event);
    return out;
  }

  /**
   * The id of the last event that can be left behind for good: every event up to it only closed
   * spans that were already returned, and none of the spans still open started at or before it.
   * Read the log again after this id and every open span is rebuilt. With nothing open it is the
   * id of the last event read (`lastReadId`).
   */
  watermark(lastReadId: number): number {
    let lowest = Number.POSITIVE_INFINITY;
    const consider = (startId: number): void => {
      if (startId < lowest) lowest = startId;
    };
    for (const play of this.#plays.values()) consider(play.startId);
    for (const attempt of this.#attempts.values()) consider(attempt.startId);
    for (const session of this.#sessions.values()) consider(session.startId);
    for (const tool of this.#tools.values()) consider(tool.startId);
    for (const wait of this.#resetWaits.values()) consider(wait.startId);
    for (const wait of this.#demandWaits.values()) consider(wait.startId);
    for (const wait of this.#eventWaits.values()) consider(wait.startId);
    return Number.isFinite(lowest) ? Math.min(lowest - 1, lastReadId) : lastReadId;
  }

  /** How many spans are open now (a play, its stage, an attempt, a session, a call, a wait). */
  get open(): number {
    let stages = 0;
    for (const play of this.#plays.values()) if (play.stage !== undefined) stages += 1;
    return (
      this.#plays.size +
      stages +
      this.#attempts.size +
      this.#sessions.size +
      this.#tools.size +
      this.#resetWaits.size +
      this.#demandWaits.size +
      this.#eventWaits.size
    );
  }

  // ---- the play and its stages ------------------------------------------------------------------

  #playCreated(event: EventEnvelope): void {
    const { playId, scenarioId } = idsOf(event);
    if (playId === undefined || this.#plays.has(playId)) return;
    this.#plays.set(playId, {
      playId,
      scenarioId,
      startId: event.id,
      startTs: event.timestamp,
      flow: str(event.payload.flowId),
      // The play exists in `NEED` before its first transition.
      stage: { state: 'NEED', enteredId: event.id, enteredTs: event.timestamp },
    });
  }

  #playTransitioned(event: EventEnvelope, out: TelemetrySpan[]): void {
    const { playId, scenarioId } = idsOf(event);
    if (playId === undefined) return;
    const from = str(event.payload.from);
    const to = str(event.payload.to);
    if (to === undefined) return;
    let play = this.#plays.get(playId);
    if (play === undefined) {
      // The log has no `play.created` for it (an old log): the play starts where it is first seen.
      play = {
        playId,
        scenarioId,
        startId: event.id,
        startTs: event.timestamp,
        flow: undefined,
        stage:
          from === undefined
            ? undefined
            : { state: from, enteredId: event.id, enteredTs: event.timestamp },
      };
      this.#plays.set(playId, play);
    }
    const ids: Ids = { scenarioId: play.scenarioId ?? scenarioId, playId, attemptId: undefined };
    const left = play.stage;
    if (left !== undefined) {
      out.push(
        buildSpan({
          traceId: traceIdForPlay(playId),
          spanId: stageSpanId(playId, left.enteredId),
          parentSpanId: playSpanId(playId),
          name: SPAN_NAME.stage,
          kind: SPAN_KIND.internal,
          startMs: left.enteredTs,
          endMs: event.timestamp,
          attributes: attrs({
            [OT.stage]: left.state,
            [OT.stageId]: stageSpanId(playId, left.enteredId),
            [OT.stageEvent]: str(event.payload.event),
            [OT.stageReason]: str(event.payload.reason),
          }),
          ids,
        }),
      );
    }
    if (isFinalPlayState(to)) {
      this.#playEnded(play, to, event, out);
      return;
    }
    play.stage = { state: to, enteredId: event.id, enteredTs: event.timestamp };
  }

  #playEnded(
    play: PlayState,
    finalState: string,
    event: EventEnvelope,
    out: TelemetrySpan[],
  ): void {
    const { playId } = play;
    // What the play leaves open ends with it.
    for (const attempt of [...this.#attempts.values()]) {
      if (attempt.ids.playId === playId) this.#closeAttempt(attempt, event, CLOSED_BY.playEnd, out);
    }
    for (const [key, wait] of [...this.#demandWaits]) {
      if (wait.ids.playId !== playId) continue;
      this.#demandWaits.delete(key);
      pushSpan(
        out,
        this.#waitSpan(wait, event.timestamp, undefined, { [OT.closedBy]: CLOSED_BY.playEnd }),
      );
    }
    for (const [key, wait] of [...this.#eventWaits]) {
      if (wait.ids.playId !== playId) continue;
      this.#eventWaits.delete(key);
      pushSpan(
        out,
        this.#waitSpan(wait, event.timestamp, undefined, { [OT.closedBy]: CLOSED_BY.playEnd }),
      );
    }
    this.#selections.delete(playId);
    this.#plays.delete(playId);
    out.push(
      buildSpan({
        traceId: traceIdForPlay(playId),
        spanId: playSpanId(playId),
        parentSpanId: null,
        name: SPAN_NAME.play,
        kind: SPAN_KIND.internal,
        startMs: play.startTs,
        endMs: event.timestamp,
        status: finalState === 'DONE' ? 'ok' : 'unset',
        attributes: attrs({
          [OT.playFinalState]: finalState,
          [OT.playFlow]: play.flow,
        }),
        ids: { scenarioId: play.scenarioId, playId, attemptId: undefined },
      }),
    );
  }

  /** The span an attempt of a play hangs from: the stage it started in, else the play. */
  #parentOfAttempt(playId: string | undefined): string | null {
    if (playId === undefined) return null;
    const play = this.#plays.get(playId);
    return play?.stage === undefined
      ? playSpanId(playId)
      : stageSpanId(playId, play.stage.enteredId);
  }

  // ---- selection, session ------------------------------------------------------------------------

  #selected(event: EventEnvelope): void {
    if (event.payload.outcome !== 'selected') return;
    const { playId } = idsOf(event);
    const role = str(event.payload.role);
    if (playId === undefined || role === undefined) return;
    const list = this.#selections.get(playId) ?? [];
    list.push({ role, key: executorKey(executorOf(event.payload.executor)) });
    if (list.length > SELECTIONS_PER_PLAY) list.shift();
    this.#selections.set(playId, list);
  }

  #ensureAttempt(event: EventEnvelope): AttemptState | undefined {
    const ids = idsOf(event);
    if (ids.attemptId === undefined) return undefined;
    const known = this.#attempts.get(ids.attemptId);
    if (known !== undefined) {
      known.role ??= str(event.payload.role);
      return known;
    }
    const attempt: AttemptState = {
      attemptId: ids.attemptId,
      ids,
      startId: event.id,
      startTs: event.timestamp,
      parentSpanId: this.#parentOfAttempt(ids.playId),
      role: str(event.payload.role),
      executor: undefined,
      activeSessionId: undefined,
      ending: undefined,
    };
    this.#attempts.set(ids.attemptId, attempt);
    return attempt;
  }

  #sessionOpened(event: EventEnvelope): void {
    const sessionId = str(event.payload.sessionId);
    if (sessionId === undefined) return;
    const ids = idsOf(event);
    const executor = executorOf(event.payload.executor);
    const attempt = this.#ensureAttempt(event);
    if (attempt !== undefined) {
      attempt.executor ??= executor;
      attempt.activeSessionId = sessionId;
    }
    // The role: the selection of the play that chose this very Executor, oldest first.
    let role: string | undefined;
    if (ids.playId !== undefined) {
      const list = this.#selections.get(ids.playId);
      const at = list?.findIndex((entry) => entry.key === executorKey(executor)) ?? -1;
      if (list !== undefined && at >= 0) role = list.splice(at, 1)[0]?.role;
    }
    this.#sessions.set(sessionId, {
      sessionId,
      ids,
      startId: event.id,
      startTs: event.timestamp,
      executor,
      via: str(event.payload.via),
      role: role ?? attempt?.role,
      turns: 0,
      stopReason: undefined,
    });
  }

  #promptFinished(event: EventEnvelope): void {
    const session = this.#sessions.get(str(event.payload.sessionId) ?? '');
    if (session === undefined) return;
    session.turns += 1;
    session.stopReason = str(event.payload.stopReason);
  }

  #sessionClosed(event: EventEnvelope, out: TelemetrySpan[]): void {
    const session = this.#sessions.get(str(event.payload.sessionId) ?? '');
    if (session === undefined) return;
    this.#closeSession(session, event.timestamp, str(event.payload.reason), undefined, out);
    // The end of the attempt waited for this session: the last one to close ends it.
    const attemptId = session.ids.attemptId;
    const attempt = attemptId === undefined ? undefined : this.#attempts.get(attemptId);
    if (attempt?.ending !== undefined && !this.#hasOpenSession(attempt.attemptId)) {
      this.#closeAttempt(attempt, event, undefined, out, attempt.ending);
    }
  }

  #hasOpenSession(attemptId: string): boolean {
    for (const session of this.#sessions.values()) {
      if (session.ids.attemptId === attemptId) return true;
    }
    return false;
  }

  #closeSession(
    session: SessionState,
    endMs: number,
    reason: string | undefined,
    closedBy: string | undefined,
    out: TelemetrySpan[],
  ): void {
    this.#sessions.delete(session.sessionId);
    const attempt =
      session.ids.attemptId === undefined ? undefined : this.#attempts.get(session.ids.attemptId);
    if (attempt?.activeSessionId === session.sessionId) attempt.activeSessionId = undefined;
    const traceId = traceIdForAttempt({ ...session.ids, sessionId: session.sessionId });
    if (traceId === undefined) return;
    const agent = session.role ?? attempt?.role;
    const { client, profile, model } = session.executor;
    const status: TelemetrySpanStatus =
      reason === 'completed' ? 'ok' : reason === 'failed' ? 'error' : 'unset';
    out.push(
      buildSpan({
        traceId,
        spanId: sessionSpanId(session.sessionId),
        parentSpanId:
          session.ids.attemptId === undefined ? null : attemptSpanId(session.ids.attemptId),
        name: SPAN_NAME.invokeAgent(agent),
        kind: SPAN_KIND.client,
        startMs: session.startTs,
        endMs,
        status,
        statusMessage: status === 'error' ? (reason ?? null) : null,
        attributes: attrs({
          [GEN_AI.operationName]: GEN_AI_OPERATION.invokeAgent,
          [GEN_AI.agentName]: agent,
          [GEN_AI.requestModel]: model,
          [GEN_AI.providerName]: client === undefined ? undefined : providerNameOf(client),
          [GEN_AI.conversationId]: session.sessionId,
          [OT.role]: agent,
          [OT.client]: client,
          [OT.profile]: profile,
          [OT.sessionVia]: session.via,
          [OT.sessionCloseReason]: reason,
          [OT.sessionTurns]: session.turns,
          [OT.sessionStopReason]: session.stopReason,
          [OT.closedBy]: closedBy,
        }),
        ids: session.ids,
        sessionId: session.sessionId,
      }),
    );
  }

  // ---- the attempt --------------------------------------------------------------------------------

  #attemptEnded(event: EventEnvelope, out: TelemetrySpan[]): void {
    const attempt = this.#ensureAttempt({ ...event, type: 'attempt.checkpoint' });
    if (attempt === undefined) return;
    const end = event.type.slice('attempt.'.length);
    if (this.#hasOpenSession(attempt.attemptId)) {
      // The calls and the waits end with the attempt; the session, and so the span, on its close.
      attempt.ending = end;
      this.#closeCallsAndWaits(attempt, event.timestamp, CLOSED_BY.attemptEnd, out);
      return;
    }
    this.#closeAttempt(attempt, event, undefined, out, end);
  }

  #closeCallsAndWaits(
    attempt: AttemptState,
    endMs: number,
    closing: string,
    out: TelemetrySpan[],
  ): void {
    for (const [key, tool] of [...this.#tools]) {
      if (tool.ids.attemptId !== attempt.attemptId) continue;
      this.#tools.delete(key);
      pushSpan(out, this.#toolSpan(tool, endMs, undefined, closing));
    }
    const reset = this.#resetWaits.get(attempt.attemptId);
    if (reset !== undefined) {
      this.#resetWaits.delete(attempt.attemptId);
      pushSpan(out, this.#waitSpan(reset, endMs, undefined, { [OT.closedBy]: closing }));
    }
    for (const [key, wait] of [...this.#eventWaits]) {
      if (wait.ids.attemptId !== attempt.attemptId) continue;
      this.#eventWaits.delete(key);
      pushSpan(out, this.#waitSpan(wait, endMs, undefined, { [OT.closedBy]: closing }));
    }
  }

  #closeAttempt(
    attempt: AttemptState,
    event: EventEnvelope,
    closedBy: string | undefined,
    out: TelemetrySpan[],
    end?: string,
  ): void {
    // What the attempt leaves open ends with it.
    const closing = closedBy ?? CLOSED_BY.attemptEnd;
    for (const session of [...this.#sessions.values()]) {
      if (session.ids.attemptId === attempt.attemptId) {
        this.#closeSession(session, event.timestamp, undefined, closing, out);
      }
    }
    this.#closeCallsAndWaits(attempt, event.timestamp, closing, out);
    this.#attempts.delete(attempt.attemptId);
    attempt.role ??= str(event.payload.role);
    const ended = end ?? attempt.ending;
    const traceId = traceIdForAttempt(attempt.ids);
    if (traceId === undefined) return;
    const { client, profile, model } = attempt.executor ?? executorOf(undefined);
    const status: TelemetrySpanStatus =
      ended === 'submitted' ? 'ok' : ended === 'aborted' ? 'error' : 'unset';
    out.push(
      buildSpan({
        traceId,
        spanId: attemptSpanId(attempt.attemptId),
        parentSpanId: attempt.parentSpanId,
        name: SPAN_NAME.invokeAgent(attempt.role),
        kind: SPAN_KIND.internal,
        startMs: attempt.startTs,
        endMs: event.timestamp,
        status,
        statusMessage: status === 'error' ? 'aborted' : null,
        attributes: attrs({
          [GEN_AI.operationName]: GEN_AI_OPERATION.invokeAgent,
          [GEN_AI.agentName]: attempt.role,
          [GEN_AI.requestModel]: model,
          [GEN_AI.providerName]: client === undefined ? undefined : providerNameOf(client),
          [GEN_AI.agentId]: attempt.attemptId,
          [OT.role]: attempt.role,
          [OT.client]: client,
          [OT.profile]: profile,
          [OT.demandId]: undefined,
          [OT.attemptEnd]: ended,
          [OT.closedBy]: closedBy,
        }),
        ids: attempt.ids,
      }),
    );
  }

  // ---- tool calls ---------------------------------------------------------------------------------

  #toolKey(ids: Ids, callId: string): string {
    return `${ids.attemptId ?? ids.playId ?? ''}|${callId}`;
  }

  #toolCalled(event: EventEnvelope): void {
    const callId = str(event.payload.callId);
    if (callId === undefined) return;
    const ids = idsOf(event);
    const attempt = this.#ensureAttempt(event);
    if (attempt !== undefined) attempt.role ??= str(event.payload.role);
    const key = this.#toolKey(ids, callId);
    if (this.#tools.has(key)) return;
    this.#tools.set(key, {
      key,
      ids,
      startId: event.id,
      startTs: event.timestamp,
      tool: str(event.payload.tool),
      callId,
      role: str(event.payload.role),
      heavy: typeof event.payload.heavy === 'boolean' ? event.payload.heavy : undefined,
    });
  }

  #toolFinished(event: EventEnvelope, out: TelemetrySpan[]): void {
    const callId = str(event.payload.callId);
    if (callId === undefined) return;
    const key = this.#toolKey(idsOf(event), callId);
    const tool = this.#tools.get(key);
    if (tool === undefined) return;
    this.#tools.delete(key);
    pushSpan(out, this.#toolSpan(tool, event.timestamp, event, undefined));
    // The wait for the semaphore is inside the call: it ends where the run starts.
    const queuedMs = num(event.payload.queuedMs) ?? 0;
    const durationMs = num(event.payload.durationMs) ?? 0;
    if (queuedMs > 0) {
      const runStart = event.timestamp - durationMs;
      const waitStart = Math.max(tool.startTs, runStart - queuedMs);
      const traceId = traceIdForAttempt(tool.ids);
      if (traceId !== undefined) {
        out.push(
          buildSpan({
            traceId,
            spanId: waitSpanId(WAIT_KIND.toolSemaphore, tool.key),
            parentSpanId: toolSpanId(tool.key, tool.callId),
            name: SPAN_NAME.wait,
            kind: SPAN_KIND.internal,
            startMs: waitStart,
            endMs: Math.max(waitStart, runStart),
            attributes: attrs({
              [OT.waitKind]: WAIT_KIND.toolSemaphore,
              [OT.waitReason]: 'heavy_concurrency',
              [OT.waitMs]: queuedMs,
              [OT.waitOrigin]: 'log',
              [GEN_AI.toolName]: tool.tool,
              [GEN_AI.toolCallId]: tool.callId,
            }),
            ids: tool.ids,
            sessionId: this.#sessionOfAttempt(tool.ids.attemptId),
          }),
        );
      }
    }
  }

  #sessionOfAttempt(attemptId: string | undefined): string | undefined {
    return attemptId === undefined ? undefined : this.#attempts.get(attemptId)?.activeSessionId;
  }

  #toolSpan(
    tool: ToolState,
    endMs: number,
    finished: EventEnvelope | undefined,
    closedBy: string | undefined,
  ): TelemetrySpan | undefined {
    const outcome = str(finished?.payload.outcome);
    const status: TelemetrySpanStatus =
      finished === undefined ? 'unset' : outcome === 'ok' ? 'ok' : 'error';
    const attempt =
      tool.ids.attemptId === undefined ? undefined : this.#attempts.get(tool.ids.attemptId);
    const sessionId = attempt?.activeSessionId;
    const parent =
      sessionId !== undefined
        ? sessionSpanId(sessionId)
        : tool.ids.attemptId !== undefined
          ? attemptSpanId(tool.ids.attemptId)
          : this.#parentOfAttempt(tool.ids.playId);
    const traceId = traceIdForAttempt(tool.ids);
    if (traceId === undefined) return undefined;
    return buildSpan({
      traceId,
      spanId: toolSpanId(tool.key, tool.callId),
      parentSpanId: parent,
      name: SPAN_NAME.executeTool(tool.tool),
      kind: SPAN_KIND.internal,
      startMs: tool.startTs,
      endMs,
      status,
      statusMessage: status === 'error' ? (outcome ?? null) : null,
      attributes: attrs({
        [GEN_AI.operationName]: GEN_AI_OPERATION.executeTool,
        [GEN_AI.toolName]: tool.tool,
        [GEN_AI.toolCallId]: tool.callId,
        [OT.role]: tool.role ?? attempt?.role,
        [OT.toolHeavy]: tool.heavy,
        [OT.toolOutcome]: outcome,
        [OT.toolDurationMs]: num(finished?.payload.durationMs),
        [OT.toolQueuedMs]: num(finished?.payload.queuedMs),
        [OT.toolExitCode]: num(finished?.payload.exitCode),
        [OT.toolErrorCode]: str(finished?.payload.errorCode),
        [OT.closedBy]: closedBy,
      }),
      ids: tool.ids,
      sessionId,
    });
  }

  // ---- waits that the log already tells -----------------------------------------------------------

  #resetWaitStarted(event: EventEnvelope): void {
    const ids = idsOf(event);
    if (ids.attemptId === undefined || this.#resetWaits.has(ids.attemptId)) return;
    const executor = executorOf(event.payload.executor);
    const attempt = this.#ensureAttempt(event);
    if (attempt !== undefined) attempt.executor ??= executor;
    this.#resetWaits.set(ids.attemptId, {
      key: `${ids.attemptId}|${String(event.id)}`,
      ids,
      startId: event.id,
      startTs: event.timestamp,
      kind: WAIT_KIND.quota,
      parentSpanId: null,
      reasons: new Set([str(event.payload.cause) ?? 'quota_exhausted']),
      extra: {
        [OT.client]: executor.client,
        [OT.profile]: executor.profile,
        [OT.role]: str(event.payload.role),
        [OT.waitResetsAt]: num(event.payload.resetsAt),
        [OT.sessionId]: str(event.payload.sessionId),
      },
    });
  }

  #resetWaitEnded(event: EventEnvelope, out: TelemetrySpan[]): void {
    const { attemptId } = idsOf(event);
    if (attemptId === undefined) return;
    const wait = this.#resetWaits.get(attemptId);
    if (wait === undefined) return;
    this.#resetWaits.delete(attemptId);
    pushSpan(
      out,
      this.#waitSpan(wait, event.timestamp, str(event.payload.outcome), {
        [OT.waitMs]: num(event.payload.waitedMs),
      }),
    );
  }

  #demandWaiting(event: EventEnvelope): void {
    const ids = idsOf(event);
    const demandId = str(event.payload.demandId);
    if (ids.playId === undefined || demandId === undefined) return;
    const reasons = new Set<string>();
    const on = event.payload.on;
    for (const entry of Array.isArray(on) ? on : []) {
      const reason = str(record(entry)?.reason);
      if (reason !== undefined) reasons.add(reason);
    }
    const open = this.#demandWaits.get(demandId);
    if (open !== undefined) {
      // The same wait told again with other candidates set aside: one span, every reason.
      for (const reason of reasons) open.reasons.add(reason);
      return;
    }
    this.#demandWaits.set(demandId, {
      key: `${demandId}|${String(event.id)}`,
      ids,
      startId: event.id,
      startTs: Math.min(event.timestamp, num(event.payload.since) ?? event.timestamp),
      kind: WAIT_KIND.executorSelection,
      parentSpanId: this.#parentOfAttempt(ids.playId),
      reasons,
      extra: {
        [OT.demandId]: demandId,
        [OT.role]: str(event.payload.role),
      },
    });
  }

  #demandResumed(event: EventEnvelope, out: TelemetrySpan[]): void {
    const demandId = str(event.payload.demandId);
    if (demandId === undefined) return;
    const wait = this.#demandWaits.get(demandId);
    if (wait === undefined) return;
    this.#demandWaits.delete(demandId);
    pushSpan(
      out,
      this.#waitSpan(wait, event.timestamp, str(event.payload.outcome), {
        [OT.waitMs]: num(event.payload.waitedMs),
      }),
    );
  }

  /**
   * `wait.started` (P15): a wait of the prompt queue or of the pool that went past
   * `events.wait_threshold`. Told again for an open wait (a restart found the prompt still queued),
   * it changes nothing: the wait is one span, from the first `since`.
   */
  #waitStarted(event: EventEnvelope): void {
    const waitId = str(event.payload.waitId);
    const kind = waitKindOf(event.payload.kind);
    if (waitId === undefined || kind === undefined) return;
    const key = `${kind}|${waitId}`;
    if (this.#eventWaits.has(key)) return;
    const ids = idsOf(event);
    this.#eventWaits.set(key, {
      key: `${waitId}|${String(event.id)}`,
      ids,
      startId: event.id,
      startTs: Math.min(event.timestamp, num(event.payload.since) ?? event.timestamp),
      kind,
      parentSpanId: null,
      traceKey: waitId,
      reasons: reasonsOf(event.payload.reasons),
      extra: waitExtra(event),
    });
  }

  #waitEnded(event: EventEnvelope, out: TelemetrySpan[]): void {
    const waitId = str(event.payload.waitId);
    const kind = waitKindOf(event.payload.kind);
    if (waitId === undefined || kind === undefined) return;
    const key = `${kind}|${waitId}`;
    const wait = this.#eventWaits.get(key);
    // An end with no start is a wait that stayed under the threshold: nothing to close.
    if (wait === undefined) return;
    this.#eventWaits.delete(key);
    for (const reason of reasonsOf(event.payload.reasons)) wait.reasons.add(reason);
    pushSpan(
      out,
      this.#waitSpan(wait, event.timestamp, str(event.payload.outcome), {
        [OT.waitMs]: num(event.payload.waitedMs),
      }),
    );
  }

  /**
   * A new run of the daemon: the sessions waiting in the pool of the last run are gone and their
   * `wait.ended` will not come, so those spans end here. A prompt still queued is kept: the
   * dispatcher tells it again and delivers it.
   */
  #daemonStarted(event: EventEnvelope, out: TelemetrySpan[]): void {
    for (const [key, wait] of [...this.#eventWaits]) {
      if (wait.kind !== WAIT_KIND.poolAdmission) continue;
      this.#eventWaits.delete(key);
      pushSpan(
        out,
        this.#waitSpan(wait, event.timestamp, undefined, {
          [OT.closedBy]: CLOSED_BY.daemonRestart,
        }),
      );
    }
  }

  #waitSpan(
    wait: WaitState,
    endMs: number,
    outcome: string | undefined,
    extra: Readonly<Record<string, JsonValue | undefined>>,
  ): TelemetrySpan | undefined {
    const { ids } = wait;
    const attempt = ids.attemptId === undefined ? undefined : this.#attempts.get(ids.attemptId);
    const parent = ids.attemptId !== undefined ? attemptSpanId(ids.attemptId) : wait.parentSpanId;
    const traceId =
      traceIdForAttempt(ids) ??
      (wait.traceKey === undefined ? undefined : traceIdForKey(wait.kind, wait.traceKey));
    if (traceId === undefined) return undefined;
    return buildSpan({
      traceId,
      spanId: waitSpanId(wait.kind, wait.key),
      parentSpanId: parent,
      name: SPAN_NAME.wait,
      kind: SPAN_KIND.internal,
      startMs: wait.startTs,
      endMs,
      attributes: attrs({
        [OT.waitKind]: wait.kind,
        [OT.waitReason]: [...wait.reasons].sort().join(','),
        [OT.waitOutcome]: outcome,
        [OT.waitOrigin]: 'log',
        ...wait.extra,
        ...extra,
        [OT.sessionId]: undefined,
      }),
      ids,
      sessionId: attempt?.activeSessionId ?? str(wait.extra[OT.sessionId]),
    });
  }
}
