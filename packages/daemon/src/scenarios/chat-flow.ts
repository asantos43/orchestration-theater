// SPDX-License-Identifier: MPL-2.0
import type { EventEnvelope, Store } from '@otheater/core';
import { buildDaemonEvent, CHAT_FLOW_STATES, type ChatFlowState } from '@otheater/protocol';
import type { Logger } from '../logger.js';

/** The flow id of the generic chat (architecture 5.20; the registry entry is `chat`). */
export const CHAT_FLOW = 'chat';

/**
 * [proposta] The kinds of decision the `chat` flow adds to the ones of the play: a consultation
 * the Director opened with `consult`. `producer_question` and `producer_menu` are the play's own
 * ({@link DECISION_KINDS}); they put the chat in AWAITING_PRODUCER too.
 */
export const CHAT_DECISION_KINDS = { consult: 'chat.consult' } as const;

const PRODUCER_KINDS: ReadonlySet<string> = new Set(['producer_question', 'producer_menu']);

export interface ChatFlowOptions {
  readonly store: Pick<Store, 'decisions' | 'events' | 'scenarios'>;
  readonly logger: Logger;
}

/** Why the flow moved, and the facts a consultation adds. */
export interface ChatTransitionDetail {
  readonly decisionId?: string;
  readonly executor?: string;
  readonly reason?: string;
}

/**
 * The state machine of the `chat` flow (architecture 5.20): IDLE (the Director answers by itself),
 * CONSULTING (a `consult` call is running a Consultant) and AWAITING_PRODUCER (the Director asked
 * the Producer something and waits). [proposta] The state is not a stored field: it is derived from
 * the decisions that are pending, so a restarted daemon reads it back from the store with no extra
 * step (P9 only has to call {@link ChatFlow.stateOf}). `scenario.chat_transitioned` is the
 * record of each move; the last one is what {@link ChatFlow.sync} compares with.
 * A scenario of another flow is never touched.
 */
export class ChatFlow {
  readonly #options: ChatFlowOptions;
  readonly #last = new Map<string, ChatFlowState>();
  readonly #queue = new Map<string, Promise<unknown>>();

  constructor(options: ChatFlowOptions) {
    this.#options = options;
  }

  /** The state the store says the flow is in now. */
  async stateOf(scenarioId: string): Promise<ChatFlowState> {
    const pending = await this.#options.store.decisions.list({ scenarioId, states: ['pending'] });
    if (pending.some((decision) => decision.kind === CHAT_DECISION_KINDS.consult)) {
      return 'CONSULTING';
    }
    if (pending.some((decision) => PRODUCER_KINDS.has(decision.kind))) return 'AWAITING_PRODUCER';
    return 'IDLE';
  }

  /**
   * Compares the state in the store with the last one recorded and, when it changed, appends
   * `scenario.chat_transitioned`. Calls for one scenario run one after the other. Returns the
   * state; for a scenario that does not run the `chat` flow, `IDLE` and nothing is written.
   */
  sync(
    scenarioId: string,
    cause: string,
    detail: ChatTransitionDetail = {},
  ): Promise<ChatFlowState> {
    const previous = this.#queue.get(scenarioId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.#sync(scenarioId, cause, detail));
    this.#queue.set(scenarioId, next);
    return next;
  }

  async #sync(
    scenarioId: string,
    cause: string,
    detail: ChatTransitionDetail,
  ): Promise<ChatFlowState> {
    const { store, logger } = this.#options;
    const scenario = await store.scenarios.get(scenarioId);
    if (scenario?.flowId !== CHAT_FLOW) return 'IDLE';
    const to = await this.stateOf(scenarioId);
    const from = this.#last.get(scenarioId) ?? (await this.#recorded(scenarioId));
    this.#last.set(scenarioId, to);
    if (from === to) return to;
    try {
      await store.events.append({
        ...buildDaemonEvent('scenario.chat_transitioned', {
          scenarioId,
          from,
          to,
          decisionId: detail.decisionId ?? null,
          cause,
          executor: detail.executor ?? null,
          reason: detail.reason ?? null,
        }),
        scenarioId,
      });
    } catch (error) {
      logger.error({ err: error, scenarioId }, 'the chat flow move could not be recorded');
    }
    return to;
  }

  /** The `to` of the last recorded move of the scenario (IDLE when there is none). */
  async #recorded(scenarioId: string): Promise<ChatFlowState> {
    const { events } = this.#options.store;
    let after = 0;
    let state: ChatFlowState = 'IDLE';
    for (;;) {
      const page: readonly EventEnvelope[] = await events.readFrom(after, 500);
      if (page.length === 0) return state;
      for (const event of page) {
        after = event.id;
        if (event.type !== 'scenario.chat_transitioned') continue;
        const payload = event.payload as { scenarioId?: unknown; to?: unknown };
        if (payload.scenarioId !== scenarioId) continue;
        const to = CHAT_FLOW_STATES.find((candidate) => candidate === payload.to);
        if (to !== undefined) state = to;
      }
    }
  }
}
