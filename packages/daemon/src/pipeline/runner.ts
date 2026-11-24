// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  InvalidInput,
  NotFound,
  hasErrorCode,
  isOTheaterError,
  type Clock,
  type PlayRecord,
  type Store,
  type StoreTransaction,
} from '@otheater/core';
import type { JsonObject } from '@otheater/core';
import { z } from 'zod';
import { createActor, initialTransition, transition, type SnapshotFrom } from 'xstate';
import type { PlayNoticeKind } from '@otheater/protocol';
import type { PlayLimits } from '../config.js';
import { situationText, writeSituation } from '../situations.js';
import type { PausedPlay, PlayContext, PlayFlowRef } from './context.js';
import { PLAY_FLOW_ID, PLAY_FLOW_VERSION, isFinalState, type PlayState } from './definitions.js';
import {
  entryEffects,
  type PlayEffect,
  type PlayEffects,
  type PlayEffectScope,
} from './effects.js';
import {
  PLAY_CREATED_EVENT,
  PLAY_TRANSITIONED_EVENT,
  PlayEventSchema,
  type MachineEvent,
} from './events.js';
import { playMachine, type PlayDecision } from './machine.js';

type PlaySnapshot = SnapshotFrom<typeof playMachine>;

/** What the runner needs from a logger (pino fits). */
export interface PlayRunnerLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  /** Where a `play.notice` that could not be written is logged; a logger without it uses `warn`. */
  error?(fields: Record<string, unknown>, message: string): void;
}

export interface PlayRunnerOptions {
  readonly store: Store;
  /** Stamps the events and arms the deadlines of the demands. */
  readonly clock: Clock;
  /** Starts the long work the machine asks for (wired by the step that runs the sessions, P8). */
  readonly effects: PlayEffects;
  readonly logger?: PlayRunnerLogger;
  /**
   * Told, once the transition is saved, that a play reached a final state (`DONE` or `CANCELLED`).
   * The idea queue (5.20) hears it to link the ideas to the play and its PR, or to take them back
   * to the queue. It must not wait for long work (start it and return); an error is logged.
   */
  readonly onFinish?: (play: PlayRecord) => void;
  /**
   * Told when a full disk hit a play (Phase 11, P5): a transition that could not be saved (`send`
   * rejects with `DiskFull`, the play stays in the state it had) or an effect that could not start.
   * The disk guard keeps the id and calls `resume` when the space is back. Must not throw.
   */
  readonly onDiskFull?: ((playId: string) => void) | undefined;
}

export interface NewPlayInput {
  readonly playId: string;
  readonly scenarioId: string;
  readonly need: string;
  readonly limits: PlayLimits;
  /**
   * [proposta] The flow of the configuration (P12), already resolved: its limits are in `limits`
   * and the play keeps this reference in its snapshot. Absent: the official `play`.
   */
  readonly flow?: PlayFlowRef | undefined;
  readonly parentPlayId?: string | null;
}

const NO_LOGGER: PlayRunnerLogger = { warn: () => undefined };

function toJson(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/**
 * Restores the machine from what the store holds. A play saved by another version of the flow is
 * refused with a clear error and is not touched (architecture 5.4: the snapshot is only restored
 * on the same version).
 */
export function restorePlay(record: PlayRecord): PlaySnapshot {
  if (record.flowId !== PLAY_FLOW_ID || record.flowVersion !== PLAY_FLOW_VERSION) {
    throw new Conflict(
      `Play ${record.id} was saved by version ${String(record.flowVersion)} of the flow ` +
        `"${record.flowId}", and this daemon runs version ${String(PLAY_FLOW_VERSION)} of ` +
        `"${PLAY_FLOW_ID}": the snapshot is not restored`,
    );
  }
  if (record.snapshot === null) {
    throw new Conflict(`Play ${record.id} has no snapshot to restore`);
  }
  const savedVersion = (record.snapshot as { context?: { flowVersion?: unknown } }).context
    ?.flowVersion;
  if (savedVersion !== PLAY_FLOW_VERSION) {
    throw new Conflict(
      `The snapshot of play ${record.id} says version ${String(savedVersion)}, but the record says ` +
        `${String(record.flowVersion)}: the snapshot is not restored`,
    );
  }
  // The input only matters for a new actor; a restored one takes everything from the snapshot.
  return createActor(playMachine, {
    snapshot: record.snapshot as never,
    input: undefined as never,
  }).getSnapshot();
}

interface ArmedDeadline {
  readonly at: number;
  readonly abort: AbortController;
}

/**
 * Drives the play machine (architecture 5.4). It is the only place that writes the state of a
 * play:
 *
 * - `send` runs the pure `transition()`, and in ONE `store.transaction` writes the decisions the
 *   transition records, the `getPersistedSnapshot()` with the state and the counters (PlayRegistry
 *   `update`) and the `play.transitioned` event. Only after the commit does it arm the deadlines
 *   and start the effects the transition asked for (a transactional outbox: if the daemon dies
 *   in between, `resume` asks for the effects of the state again, so a handler must be idempotent).
 * - Events of one play are serialized; different plays run in parallel.
 * - Deadlines are in `context.deadlines`; the runner arms a timer for each through the core
 *   `Clock` and, when it fires, sends `ACTOR_TIMED_OUT`. A timer is cancelled when the demand
 *   leaves the map and re-armed from the snapshot on `resume`.
 */
export class PlayRunner {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #effects: PlayEffects;
  readonly #logger: PlayRunnerLogger;
  readonly #onFinish: ((play: PlayRecord) => void) | undefined;
  readonly #onDiskFull: ((playId: string) => void) | undefined;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #timers = new Map<string, Map<string, ArmedDeadline>>();
  readonly #fired = new Set<Promise<void>>();
  readonly #notices = new Set<Promise<void>>();
  /**
   * N176: the effects of the state a play was in when the daemon restarted while it was paused:
   * `resume` did not dispatch them, `RESUME` does. In memory only; a restart computes them again.
   */
  readonly #restartHeld = new Map<string, PlayEffect[]>();
  #closed = false;

  constructor(options: PlayRunnerOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#effects = options.effects;
    this.#logger = options.logger ?? NO_LOGGER;
    this.#onFinish = options.onFinish;
    this.#onDiskFull = options.onDiskFull;
  }

  /** Creates the play in NEED, with its first snapshot, and writes `play.created`. */
  async create(input: NewPlayInput): Promise<PlayRecord> {
    const [snapshot] = initialTransition(playMachine, {
      playId: input.playId,
      need: input.need,
      limits: input.limits,
      flow: input.flow,
    });
    return this.#store.transaction(async (tx) => {
      const record = await tx.plays.create({
        id: input.playId,
        scenarioId: input.scenarioId,
        need: input.need,
        flowId: PLAY_FLOW_ID,
        flowVersion: PLAY_FLOW_VERSION,
        state: 'NEED',
        snapshot: toJson(playMachine.getPersistedSnapshot(snapshot)),
        counters: {},
        parentPlayId: input.parentPlayId ?? null,
      });
      await tx.events.append({
        type: PLAY_CREATED_EVENT.type,
        schemaVersion: PLAY_CREATED_EVENT.schemaVersion,
        payload: {
          flowId: PLAY_FLOW_ID,
          flowVersion: PLAY_FLOW_VERSION,
          need: input.need,
          parentPlayId: input.parentPlayId ?? null,
        },
        scenarioId: input.scenarioId,
        playId: input.playId,
      });
      return record;
    });
  }

  /**
   * Gives the machine an event. Rejects with `InvalidInput` when the event does not fit its schema,
   * `NotFound` when the play does not exist, and `Conflict` when the play is finished, was saved
   * by another version of the flow, or does not take the event in its state (a late or repeated
   * event: the caller decides what to do with it).
   */
  send(playId: string, event: unknown): Promise<PlayRecord> {
    const parsed = PlayEventSchema.safeParse(event);
    if (!parsed.success) {
      return Promise.reject(
        new InvalidInput(`Invalid play event: ${z.prettifyError(parsed.error)}`, {
          cause: parsed.error,
        }),
      );
    }
    const sent = this.#enqueue(playId, async () => {
      if (this.#closed) throw new Conflict('The play runner is closed');
      const record = await this.#load(playId);
      if (isFinalState(record.state)) {
        throw new Conflict(`Play ${playId} is finished (${record.state}) and takes no event`);
      }
      const snapshot = restorePlay(record);
      const machineEvent: MachineEvent = { ...parsed.data, at: this.#clock.now() };
      if (!snapshot.can(machineEvent)) {
        throw new Conflict(`Play ${playId} in ${record.state} does not take ${machineEvent.type}`);
      }
      const [next, actions] = transition(playMachine, snapshot, machineEvent);
      const decisions: PlayDecision[] = [];
      const effects: PlayEffect[] = [];
      for (const action of actions) {
        const params = action.params as
          { effects?: PlayEffect[]; decision?: PlayDecision } | undefined;
        if (action.type === 'emit' && params?.effects !== undefined)
          effects.push(...params.effects);
        if (action.type === 'record' && params?.decision !== undefined) {
          decisions.push(params.decision);
        }
      }
      const to = next.value;
      const finished = next.status === 'done';
      const scope = { playId, scenarioId: record.scenarioId };
      const before = snapshot.context.paused ?? null;
      const pausedNow = finished ? null : (next.context.paused ?? null);
      // N176: while the play is paused the effects are held, except the ones that stop work or
      // that talk about the pause itself; they are saved in the snapshot and RESUME dispatches them.
      const held =
        pausedNow === null ? [] : effects.filter((effect) => !BYPASSES_PAUSE.has(effect.type));
      const dispatchNow =
        pausedNow === null ? effects : effects.filter((effect) => BYPASSES_PAUSE.has(effect.type));
      const persisted = toJson(playMachine.getPersistedSnapshot(next));
      if (pausedNow !== null && before !== null) {
        // an abort or a new state makes what was held stale (it was for the work that is gone)
        const stale = record.state !== to || effects.some((effect) => effect.type === 'abort_work');
        setHeld(persisted, [...(stale ? [] : heldEffects(before)), ...held]);
      } else if (pausedNow !== null) {
        setHeld(persisted, held);
      }
      if (record.state !== to) this.#restartHeld.delete(playId);
      const updated = await this.#store.transaction(async (tx) => {
        await this.#writeDecisions(tx, record, decisions);
        const saved = await tx.plays.update(playId, {
          state: to,
          snapshot: persisted,
          counters: { ...next.context.counters },
          // The instant of the transaction: the one of `updatedAt` and of the event (N177).
          ...(finished ? { finishedAt: tx.now() } : {}),
        });
        await tx.events.append({
          type: PLAY_TRANSITIONED_EVENT.type,
          schemaVersion: PLAY_TRANSITIONED_EVENT.schemaVersion,
          payload: {
            event: machineEvent.type,
            from: record.state,
            to,
            counters: { ...next.context.counters },
            effects: effects.map((effect) => effect.type),
            ...('reason' in machineEvent && typeof machineEvent.reason === 'string'
              ? { reason: machineEvent.reason }
              : {}),
            ...(held.length > 0 ? { held: held.map((effect) => effect.type) } : {}),
          },
          scenarioId: record.scenarioId,
          playId,
        });
        return saved;
      });
      const frozen = pausedNow?.mode === 'interrupt';
      this.#reconcileDeadlines(playId, finished || frozen ? {} : next.context.deadlines);
      if (before !== null && pausedNow === null) {
        // RESUME (or a cancel): what was held starts, after the effect that wakes the paused work
        const carried = finished ? [] : this.#heldOf(playId, before);
        this.#restartHeld.delete(playId);
        await this.#dispatch([...dispatchNow, ...carried], scope);
      } else {
        await this.#dispatch(dispatchNow, scope);
      }
      if (finished) this.#notifyFinish(updated);
      return updated;
    });
    return sent.catch((error: unknown) => {
      this.#diskFull(playId, error);
      throw error;
    });
  }

  /**
   * After a restart: restores the play, arms the deadlines of its demands again and asks for the
   * effects of the state it is in (and of its open judgments) once more. A play saved by another
   * version rejects with `Conflict` and stays as it is.
   */
  resume(playId: string): Promise<void> {
    return this.#enqueue(playId, async () => {
      if (this.#closed) throw new Conflict('The play runner is closed');
      const record = await this.#load(playId);
      if (isFinalState(record.state)) return;
      const snapshot = restorePlay(record);
      const context = snapshot.context;
      const scope = { playId, scenarioId: record.scenarioId };
      const paused = context.paused ?? null;
      const effects = [
        ...entryEffects(record.state as PlayState, context),
        ...context.openJudgments.map((judgment) => judgmentEffect(judgment)),
      ];
      if (paused !== null) {
        // N176: a paused play stays paused after a restart. Nothing starts: what the state asks for
        // waits for RESUME, and `interrupt` keeps its deadlines frozen.
        this.#reconcileDeadlines(playId, paused.mode === 'interrupt' ? {} : context.deadlines);
        this.#restartHeld.set(
          playId,
          effects.filter((effect) => !heldEffects(paused).some((held) => sameEffect(held, effect))),
        );
        await this.#dispatch([{ type: 'pause_work', mode: paused.mode }], scope);
        return;
      }
      this.#reconcileDeadlines(playId, context.deadlines);
      await this.#dispatch(effects, scope);
    });
  }

  /**
   * Resumes every play that is not finished. A play that cannot be restored (another version) is
   * logged and skipped, and the others go on; the ids that failed come back in `refused`.
   */
  async resumeAll(): Promise<{ resumed: string[]; refused: string[] }> {
    const open = await this.#store.plays.list({ open: true });
    const resumed: string[] = [];
    const refused: string[] = [];
    await Promise.all(
      open.map(async (play) => {
        try {
          await this.resume(play.id);
          resumed.push(play.id);
        } catch (error) {
          refused.push(play.id);
          this.#logger.warn({ playId: play.id, err: error }, 'play not resumed');
          this.#notice('play_not_resumed', play.id, play.scenarioId, null, error);
        }
      }),
    );
    return { resumed: resumed.sort(), refused: refused.sort() };
  }

  /** The deadlines armed now, by play: `{demand id: epoch ms}`. For diagnostics and tests. */
  armedDeadlines(playId: string): Record<string, number> {
    return Object.fromEntries(
      [...(this.#timers.get(playId) ?? [])].map(([demandId, armed]) => [demandId, armed.at]),
    );
  }

  /** Resolves when no event of any play is being processed and no fired deadline is pending. */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.#queues.values(), ...this.#fired, ...this.#notices];
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  /** Stops the timers. The state of the plays stays in the store; `resume` picks it up. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const playId of [...this.#timers.keys()]) this.#reconcileDeadlines(playId, {});
    await this.idle();
  }

  /** The effects that wait for `RESUME`: the ones held in the snapshot, then the ones of a restart. */
  #heldOf(playId: string, paused: PausedPlay): PlayEffect[] {
    const all = [...heldEffects(paused), ...(this.#restartHeld.get(playId) ?? [])];
    return all.filter(
      (effect, index) => all.findIndex((other) => sameEffect(other, effect)) === index,
    );
  }

  async #load(playId: string): Promise<PlayRecord> {
    const record = await this.#store.plays.get(playId);
    if (record === undefined) throw new NotFound(`Play ${playId} does not exist`);
    return record;
  }

  async #writeDecisions(
    tx: StoreTransaction,
    record: PlayRecord,
    decisions: readonly PlayDecision[],
  ): Promise<void> {
    for (const decision of decisions) {
      await tx.decisions.create({
        id: decision.id,
        scenarioId: record.scenarioId,
        playId: record.id,
        kind: decision.kind,
        input: decision.input,
      });
      await tx.decisions.decide(decision.id, {
        answer: decision.answer,
        decidedBy: decision.decidedBy,
      });
    }
  }

  #enqueue<T>(playId: string, work: () => Promise<T>): Promise<T> {
    const tail = this.#queues.get(playId) ?? Promise.resolve();
    const run = tail.then(work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(playId, settled);
    void settled.then(() => {
      if (this.#queues.get(playId) === settled) this.#queues.delete(playId);
    });
    return run;
  }

  async #dispatch(effects: readonly PlayEffect[], scope: PlayEffectScope): Promise<void> {
    for (const effect of effects) {
      try {
        await this.#effects.dispatch(effect, scope);
      } catch (error) {
        // The state is already saved: the failure of a handler does not undo it (`resume` asks again).
        this.#logger.warn(
          { playId: scope.playId, effect: effect.type, err: error },
          'play effect not started',
        );
        this.#notice('effect_not_started', scope.playId, scope.scenarioId, effect.type, error);
        this.#diskFull(scope.playId, error);
      }
    }
  }

  /** A `DiskFull` that hit the play: the disk guard resumes it when the space is back. */
  #diskFull(playId: string, error: unknown): void {
    if (!hasErrorCode(error, 'DISK_FULL')) return;
    try {
      this.#onDiskFull?.(playId);
    } catch (told) {
      this.#logger.warn({ playId, err: told }, 'the full disk was not told about the play');
    }
  }

  #notifyFinish(play: PlayRecord): void {
    try {
      this.#onFinish?.(play);
    } catch (error) {
      this.#logger.warn({ playId: play.id, err: error }, 'the end of the play was not handled');
      this.#notice('finish_not_handled', play.id, play.scenarioId, null, error);
    }
  }

  /**
   * Writes a `play.notice` next to a warning of the runner (P24, N146). It never waits and never
   * rejects: the runner does not change because an event could not be written. `subject` (an effect
   * type, a demand id) opens the `detail`, and the cause follows, masked and cut.
   */
  #notice(
    kind: PlayNoticeKind,
    playId: string,
    scenarioId: string | null,
    subject: string | null,
    error: unknown,
  ): void {
    const why = situationText(error, 400);
    const detail = [subject, why].filter((part) => part !== null).join(': ');
    const task = writeSituation(
      this.#store.events,
      {
        error: (fields, message) => {
          if (this.#logger.error === undefined) this.#logger.warn(fields, message);
          else this.#logger.error(fields, message);
        },
      },
      'play.notice',
      { scenarioId, playId, kind, detail: detail === '' ? null : detail.slice(0, 500) },
      scenarioId === null ? { playId } : { scenarioId, playId },
    ).finally(() => this.#notices.delete(task));
    this.#notices.add(task);
  }

  /** Makes the timers of a play match `deadlines`: arms the new ones, drops the ones that left. */
  #reconcileDeadlines(playId: string, deadlines: Readonly<Record<string, number>>): void {
    const armed = this.#timers.get(playId) ?? new Map<string, ArmedDeadline>();
    for (const [demandId, timer] of armed) {
      if (deadlines[demandId] !== timer.at) {
        timer.abort.abort();
        armed.delete(demandId);
      }
    }
    if (!this.#closed) {
      for (const [demandId, at] of Object.entries(deadlines)) {
        if (!armed.has(demandId)) armed.set(demandId, this.#arm(playId, demandId, at));
      }
    }
    if (armed.size === 0) this.#timers.delete(playId);
    else this.#timers.set(playId, armed);
  }

  #arm(playId: string, demandId: string, at: number): ArmedDeadline {
    const abort = new AbortController();
    const wait = Math.max(0, at - this.#clock.now());
    void this.#clock.sleep(wait, abort.signal).then(
      () => {
        const task = this.#fire(playId, demandId, at).finally(() => this.#fired.delete(task));
        this.#fired.add(task);
      },
      () => undefined, // cancelled: the demand left the map, or the runner closed
    );
    return { at, abort };
  }

  async #fire(playId: string, demandId: string, at: number): Promise<void> {
    if (this.#timers.get(playId)?.get(demandId)?.at !== at) return;
    this.#timers.get(playId)?.delete(demandId);
    try {
      await this.send(playId, { type: 'ACTOR_TIMED_OUT', demandId });
    } catch (error) {
      // A late deadline (the demand finished, the play left EXECUTING) is not an error.
      if (!(isOTheaterError(error) && error.code === 'CONFLICT')) {
        this.#logger.warn({ playId, demandId, err: error }, 'deadline not delivered');
        const scenarioId = (await this.#store.plays.get(playId).catch(() => undefined))?.scenarioId;
        this.#notice('deadline_not_delivered', playId, scenarioId ?? null, demandId, error);
      }
    }
  }
}

/** The effects that keep running or that tell the work about the pause: the pause never holds them. */
const BYPASSES_PAUSE: ReadonlySet<PlayEffect['type']> = new Set([
  'abort_work',
  'pause_work',
  'resume_work',
]);

/** Writes the held effects into the persisted snapshot (the machine does not know them). */
function setHeld(persisted: JsonObject, held: readonly PlayEffect[]): void {
  const context = persisted.context as { paused?: { held?: unknown } | null } | undefined;
  if (context?.paused != null) context.paused.held = toJson(held.length === 0 ? [] : held);
}

/** `PausedPlay.held` is typed loosely (see its doc); what the runner holds there is `PlayEffect`s. */
function heldEffects(paused: PausedPlay): readonly PlayEffect[] {
  return paused.held as readonly PlayEffect[];
}

function sameEffect(a: PlayEffect, b: PlayEffect): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function judgmentEffect(judgment: PlayContext['openJudgments'][number]): PlayEffect {
  return {
    type: 'judge',
    point: judgment.point,
    demandId: judgment.demandId,
    dependentIds: judgment.dependentIds,
  };
}
