// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import {
  PROMPT_PRIORITY,
  type Clock,
  type Disposable,
  type JsonObject,
  type PromptOrderMode,
  type PromptOrigin,
  type PromptQueueItem,
  type Store,
} from '@otheater/core';
import { WAIT_KIND, OT } from './telemetry/span-conventions.js';
import type { WaitRecorder } from './telemetry/wait-recorder.js';

/** What the dispatcher needs of the store. */
export type PromptDispatcherStore = Pick<Store, 'promptQueue'>;

/**
 * Hands one prompt to the Director's session and resolves when the turn has ended
 * (`session/prompt` returned). A rejection means the prompt was not delivered.
 */
export type PromptSender = (item: PromptQueueItem) => Promise<void>;

export interface PromptDispatcherOptions {
  readonly store: PromptDispatcherStore;
  /** `prompt_queue.order`. Default `producer_first`. */
  readonly order?: PromptOrderMode;
  /** New item ids. Default: random UUIDs. */
  readonly newId?: () => string;
  /**
   * Called when a sender rejects (with the item, which stays in the queue) or when the store
   * fails (without one). The pump of that scenario stops.
   */
  readonly onError?: (error: unknown, item: PromptQueueItem | undefined) => void;
  /**
   * Called after an item is written to the queue (P7 of docs/17): the daemon records the
   * `prompt.queued` event here. What it throws goes to `onError` and does not undo the submit.
   */
  readonly onQueued?: (item: PromptQueueItem) => void;
  /**
   * Phase 8, P4 (N217 (a)): told when a prompt leaves the queue for the Director, with the time it
   * waited and why. Needs `clock`. It never throws and never waits; the log has no event for this
   * wait, so the span is made here. [proposta]
   */
  readonly onWait?: WaitRecorder;
  /** The clock of `onWait`. */
  readonly clock?: Pick<Clock, 'now'>;
}

/** Why a prompt waited (`otheater.wait.reason` of the `prompt_queue` spans). */
export const PROMPT_WAIT_REASON = {
  /** A turn of the Director was going on: one prompt at a time. */
  directorBusy: 'director_busy',
  /** Nobody was attached to receive it. */
  noDirector: 'no_director',
  /** It was written and delivered with nothing in the way but the store. */
  queued: 'queued',
  /** It was found in the queue after a restart. */
  restart: 'restart',
} as const;

export interface SubmitPrompt {
  readonly scenarioId: string;
  readonly source: PromptOrigin;
  readonly text: string;
  /** More fields of the prompt content, beside `text` (an attachment reference, say). */
  readonly extra?: JsonObject;
  /** Only with `producer_first`; the default is the one of the source (`PROMPT_PRIORITY`). */
  readonly priority?: number;
}

interface ScenarioLane {
  sender: PromptSender | undefined;
  /** The pump running now, if any. */
  running: Promise<void> | undefined;
  /** A prompt was submitted (or a sender attached) while the pump ran. */
  again: boolean;
}

/**
 * The single prompt queue of the Director (architecture 5.4, 5.21; P7). Messages of the Producer
 * and notices of the daemon go through `submit`; they reach the Director's session one at a time.
 *
 * - **Written before delivered.** `submit` resolves after the item is in the store (`pending`);
 *   only then is the pump kicked. A crash between the two loses nothing: a new dispatcher over the
 *   same store finds the item still `pending` and delivers it when a sender is attached.
 * - **One at a time.** Per scenario, the pump sends an item and waits for the turn to end before
 *   it asks the store for the next one, so there are never two concurrent `session/prompt`.
 * - **The Producer goes first.** The next item is the store's `next`: highest priority, then
 *   arrival. With `producer_first` (default) the Producer's message is ahead of the Director's own
 *   follow-ups and the notices of the daemon that are waiting; with `fifo` every item is written
 *   with the same priority, so the order is arrival only. A message already being sent is never
 *   interrupted.
 * - **At least once.** The item is marked `delivered` after its turn ends. If the daemon dies
 *   during the turn, the item is sent again after the restart (the Director wakes by the state
 *   summary, so a repeated prompt is harmless). [proposta]
 * - **A failing sender stops the pump** for that scenario and leaves the item in the queue; the
 *   next `submit`, `attach` or `resume` tries again. Nothing is retried in a loop. [proposta]
 *
 * It is not tied to the flow of a play: whoever owns the Director session attaches a sender (P8,
 * P12).
 */
export class PromptDispatcher {
  readonly #store: PromptDispatcherStore;
  readonly #order: PromptOrderMode;
  readonly #newId: () => string;
  readonly #onError: PromptDispatcherOptions['onError'];
  readonly #onQueued: PromptDispatcherOptions['onQueued'];
  readonly #onWait: PromptDispatcherOptions['onWait'];
  readonly #clock: PromptDispatcherOptions['clock'];
  /** Why each prompt submitted here waited, by item id; read when it is handed over. */
  readonly #reasons = new Map<string, string>();
  readonly #lanes = new Map<string, ScenarioLane>();

  constructor(options: PromptDispatcherOptions) {
    this.#store = options.store;
    this.#order = options.order ?? 'producer_first';
    this.#newId = options.newId ?? randomUUID;
    this.#onError = options.onError;
    this.#onQueued = options.onQueued;
    this.#onWait = options.onWait;
    this.#clock = options.clock;
  }

  /** Writes the prompt to the queue and, once it is written, starts delivering. */
  async submit(input: SubmitPrompt): Promise<PromptQueueItem> {
    const priority = this.#order === 'fifo' ? 0 : (input.priority ?? PROMPT_PRIORITY[input.source]);
    const item = await this.#store.promptQueue.enqueue({
      id: this.#newId(),
      scenarioId: input.scenarioId,
      source: input.source,
      priority,
      content: { ...input.extra, text: input.text },
    });
    if (this.#onWait !== undefined) {
      const lane = this.#lanes.get(input.scenarioId);
      this.#reasons.set(
        item.id,
        lane?.running !== undefined
          ? PROMPT_WAIT_REASON.directorBusy
          : lane?.sender === undefined
            ? PROMPT_WAIT_REASON.noDirector
            : PROMPT_WAIT_REASON.queued,
      );
    }
    try {
      this.#onQueued?.(item);
    } catch (error) {
      this.#onError?.(error, undefined);
    }
    this.resume(input.scenarioId);
    return item;
  }

  /**
   * Sets who receives the prompts of a scenario and starts delivering what is waiting (what a
   * restart left in the queue included). One sender per scenario; `dispose()` of the result
   * detaches it, and the items wait.
   */
  attach(scenarioId: string, sender: PromptSender): Disposable {
    const lane = this.#lane(scenarioId);
    lane.sender = sender;
    this.resume(scenarioId);
    return {
      dispose: () => {
        if (lane.sender === sender) lane.sender = undefined;
      },
    };
  }

  /** Delivers what is waiting, if a sender is attached and the pump is not already running. */
  resume(scenarioId: string): void {
    const lane = this.#lane(scenarioId);
    if (lane.running !== undefined) {
      lane.again = true;
      return;
    }
    if (lane.sender === undefined) return;
    lane.running = this.#pump(scenarioId, lane);
  }

  /** Resolves when the pump of the scenario has nothing to do (the queue is empty or stopped). */
  async idle(scenarioId: string): Promise<void> {
    for (let lane = this.#lanes.get(scenarioId); lane?.running !== undefined;) {
      await lane.running;
      lane = this.#lanes.get(scenarioId);
    }
  }

  #lane(scenarioId: string): ScenarioLane {
    let lane = this.#lanes.get(scenarioId);
    if (lane === undefined) {
      lane = { sender: undefined, running: undefined, again: false };
      this.#lanes.set(scenarioId, lane);
    }
    return lane;
  }

  /** The prompt leaves the queue: the wait ends here. */
  #reportWait(item: PromptQueueItem): void {
    const reason = this.#reasons.get(item.id) ?? PROMPT_WAIT_REASON.restart;
    this.#reasons.delete(item.id);
    if (this.#onWait === undefined || this.#clock === undefined) return;
    try {
      this.#onWait({
        kind: WAIT_KIND.promptQueue,
        key: item.id,
        startMs: item.createdAt,
        endMs: this.#clock.now(),
        reason,
        outcome: 'delivered',
        correlation: { scenarioId: item.scenarioId },
        attributes: { [OT.waitSource]: item.source, [OT.waitPriority]: item.priority },
      });
    } catch {
      // A recorder that throws must not stop the prompt.
    }
  }

  /** Whether a `submit`, `attach` or `resume` came in while the pump was awaiting the store. */
  #woken(lane: ScenarioLane): boolean {
    return lane.again;
  }

  async #pump(scenarioId: string, lane: ScenarioLane): Promise<void> {
    try {
      for (;;) {
        lane.again = false;
        const sender = lane.sender;
        if (sender === undefined) return;
        const item = await this.#store.promptQueue.next(scenarioId);
        if (item === undefined) {
          // Between this check and the end of the function nothing awaits, so a `submit` that
          // lands after it sees `running` cleared and starts a new pump.
          if (this.#woken(lane)) continue;
          return;
        }
        this.#reportWait(item);
        try {
          await sender(item);
        } catch (error) {
          this.#onError?.(error, item);
          return;
        }
        await this.#store.promptQueue.markDelivered(item.id);
      }
    } catch (error) {
      // The store failed (it was closed, say): stop, and say so; the items stay where they are.
      this.#onError?.(error, undefined);
    } finally {
      lane.running = undefined;
    }
  }
}
