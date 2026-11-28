// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { supervisionKey, type JsonValue, type Store } from '@otheater/core';
import {
  SUPERVISION_NOTICE_KINDS,
  type DaemonEventPayloads,
  type DaemonEventType,
  SUPERVISION_TEXT_MAX,
  type SupervisionNoticeKind,
} from '@otheater/protocol';
import type { SituationSink } from '../situations.js';
import type { SupervisionSettings } from './config.js';

/**
 * The channel that carries the Director's messages to the Actors (N309, D8; plan of Phase 11b,
 * P14). A message is a {@link Notice}. [proposta] The rules of this module:
 *
 * - a notice is a version of the blackboard key `supervision/<demand>`, written when it is queued
 *   and again each time its state changes, so a pending notice survives a restart and a resume
 *   (architecture 5.16): the latest version of each `noticeId` is its state;
 * - a notice is for one attempt and is delivered once, in the reply of the next MCP tool that
 *   attempt calls ({@link SupervisionChannel.take}); with `supervision.delivery: next_turn` only
 *   from the turn after the one that was running when it was queued;
 * - a notice still queued when the attempt ends is dropped, with `supervision.warning`
 *   `delivered: false` (`attempt_ended`);
 * - a `redirect` is never put in a tool reply: it rides the cancel of the attempt.
 */

export type NoticeState = 'queued' | 'delivered' | 'dropped';

export interface Notice {
  readonly noticeId: string;
  readonly playId: string;
  readonly demandId: string;
  readonly attemptId: string;
  readonly kind: SupervisionNoticeKind;
  readonly text: string;
  state: NoticeState;
  /** The turn of the attempt that was running when the notice was queued. */
  readonly turn: number;
}

/** What the channel needs of the store. */
export type ChannelStore = Pick<Store, 'blackboard' | 'plays'>;

export interface ChannelDeps {
  readonly store: ChannelStore;
  readonly situations: SituationSink | undefined;
  readonly settings: () => SupervisionSettings;
  readonly newId?: () => string;
}

/** The notices that count against `max_warnings_per_demand`. */
const WARNING_KINDS: ReadonlySet<SupervisionNoticeKind> = new Set(['warn', 'redirect', 'contract']);

function isKind(value: unknown): value is SupervisionNoticeKind {
  return (SUPERVISION_NOTICE_KINDS as readonly unknown[]).includes(value);
}

function parseNotice(playId: string, demandId: string, value: unknown): Notice | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const { noticeId, attemptId, kind, text, state, turn } = v;
  if (
    typeof noticeId !== 'string' ||
    typeof attemptId !== 'string' ||
    typeof text !== 'string' ||
    !isKind(kind) ||
    (state !== 'queued' && state !== 'delivered' && state !== 'dropped')
  ) {
    return undefined;
  }
  return {
    noticeId,
    playId,
    demandId,
    attemptId,
    kind,
    text,
    state,
    turn: typeof turn === 'number' ? turn : 0,
  };
}

/** `text` clipped to what an event of the supervision carries. */
export function clipText(text: string): string {
  return text.length <= SUPERVISION_TEXT_MAX ? text : `${text.slice(0, SUPERVISION_TEXT_MAX - 1)}…`;
}

/**
 * The words that mark a notice as the Director's, in a tool reply. [proposta] The Actor's prompt
 * says that a message so marked comes from the Director of the scenario, not from the tool and not
 * from the user.
 */
export function noticeLabel(kind: SupervisionNoticeKind): string {
  switch (kind) {
    case 'warn':
      return 'warning';
    case 'redirect':
      return 'redirect';
    case 'broadcast':
      return 'broadcast to every Actor of the play';
    case 'contract':
      return 'contract change';
    case 'status_request':
      return 'status request';
  }
}

export class SupervisionChannel {
  readonly #deps: ChannelDeps;
  /** The notices of each demand, by `playId/demandId`, loaded from the blackboard on first use. */
  readonly #demands = new Map<string, Map<string, Notice>>();
  readonly #loading = new Map<string, Promise<Map<string, Notice>>>();
  readonly #turns = new Map<string, number>();
  readonly #broadcasts = new Map<string, number>();
  readonly #scenarios = new Map<string, string | undefined>();

  constructor(deps: ChannelDeps) {
    this.#deps = deps;
  }

  /** The turns the attempt finished so far (fed by `session.prompt_finished`). */
  turnFinished(attemptId: string): void {
    this.#turns.set(attemptId, (this.#turns.get(attemptId) ?? 0) + 1);
  }

  turnOf(attemptId: string): number {
    return this.#turns.get(attemptId) ?? 0;
  }

  /** How many warnings (`warn`, `redirect`, `contract`) the demand got, whatever the attempt. */
  async warnings(playId: string, demandId: string): Promise<number> {
    const notices = await this.#notices(playId, demandId);
    return [...notices.values()].filter((notice) => WARNING_KINDS.has(notice.kind)).length;
  }

  /** How many status requests the demand got. */
  async statusRequests(playId: string, demandId: string): Promise<number> {
    const notices = await this.#notices(playId, demandId);
    return [...notices.values()].filter((notice) => notice.kind === 'status_request').length;
  }

  /** How many broadcasts the play got (counted in memory: not kept over a restart). */
  broadcasts(playId: string): number {
    return this.#broadcasts.get(playId) ?? 0;
  }

  countBroadcast(playId: string): void {
    this.#broadcasts.set(playId, this.broadcasts(playId) + 1);
  }

  /** The notices of the attempt that wait for a tool reply. */
  async pending(playId: string, demandId: string, attemptId: string): Promise<readonly Notice[]> {
    const notices = await this.#notices(playId, demandId);
    return [...notices.values()].filter(
      (notice) => notice.attemptId === attemptId && notice.state === 'queued',
    );
  }

  /** Queues a notice for an attempt; it writes the blackboard and the event `queued`. */
  async queue(input: {
    readonly playId: string;
    readonly demandId: string;
    readonly attemptId: string;
    readonly kind: SupervisionNoticeKind;
    readonly text: string;
  }): Promise<Notice> {
    const notices = await this.#notices(input.playId, input.demandId);
    const notice: Notice = {
      noticeId: (this.#deps.newId ?? (() => randomUUID().slice(0, 8)))(),
      ...input,
      state: 'queued',
      turn: this.turnOf(input.attemptId),
    };
    notices.set(notice.noticeId, notice);
    await this.#persist(notice);
    await this.#warningEvent(notice, false, 'queued');
    return notice;
  }

  /**
   * The notices to put in the reply of a tool call of the attempt, now marked delivered. The
   * mark is made before anything is awaited, so two calls at once never carry the same notice.
   */
  async take(context: {
    readonly playId: string;
    readonly demandId: string;
    readonly attemptId: string;
  }): Promise<readonly Notice[]> {
    const notices = await this.#notices(context.playId, context.demandId);
    const turn = this.turnOf(context.attemptId);
    const nextTurn = this.#deps.settings().delivery === 'next_turn';
    const taken = [...notices.values()].filter(
      (notice) =>
        notice.attemptId === context.attemptId &&
        notice.state === 'queued' &&
        notice.kind !== 'redirect' &&
        (!nextTurn || notice.turn < turn),
    );
    for (const notice of taken) notice.state = 'delivered';
    for (const notice of taken) {
      await this.#persist(notice);
      await this.#warningEvent(notice, true, 'delivered');
    }
    return taken;
  }

  /** The attempt ended: what it never got is dropped and told. */
  async endAttempt(playId: string, demandId: string, attemptId: string): Promise<void> {
    this.#turns.delete(attemptId);
    const notices = await this.#notices(playId, demandId);
    const lost = [...notices.values()].filter(
      (notice) => notice.attemptId === attemptId && notice.state === 'queued',
    );
    // a redirect is carried by the relaunch of the attempt (its reason), so it is not lost
    for (const notice of lost) notice.state = notice.kind === 'redirect' ? 'delivered' : 'dropped';
    for (const notice of lost) {
      await this.#persist(notice);
      if (notice.kind !== 'redirect') await this.#warningEvent(notice, false, 'attempt_ended');
    }
  }

  async #notices(playId: string, demandId: string): Promise<Map<string, Notice>> {
    const id = `${playId}/${demandId}`;
    const loaded = this.#demands.get(id);
    if (loaded !== undefined) return loaded;
    let loading = this.#loading.get(id);
    if (loading === undefined) {
      loading = this.#load(playId, demandId).then((notices) => {
        this.#demands.set(id, notices);
        this.#loading.delete(id);
        return notices;
      });
      loading.catch(() => this.#loading.delete(id));
      this.#loading.set(id, loading);
    }
    return loading;
  }

  async #load(playId: string, demandId: string): Promise<Map<string, Notice>> {
    const history = await this.#deps.store.blackboard.history(playId, supervisionKey(demandId));
    const notices = new Map<string, Notice>();
    for (const entry of history) {
      const notice = parseNotice(playId, demandId, entry.value);
      if (notice !== undefined) notices.set(notice.noticeId, notice);
    }
    return notices;
  }

  async #persist(notice: Notice): Promise<void> {
    const value: JsonValue = {
      noticeId: notice.noticeId,
      attemptId: notice.attemptId,
      kind: notice.kind,
      text: notice.text,
      state: notice.state,
      turn: notice.turn,
    };
    await this.#deps.store.blackboard.put({
      playId: notice.playId,
      key: supervisionKey(notice.demandId),
      value,
      author: 'supervision',
    });
  }

  async #warningEvent(
    notice: Notice,
    delivered: boolean,
    reason: 'queued' | 'delivered' | 'attempt_ended',
  ): Promise<void> {
    await this.record(
      'supervision.warning',
      {
        kind: notice.kind,
        noticeId: notice.noticeId,
        demandId: notice.demandId,
        delivered,
        reason,
        text: clipText(notice.text),
      },
      notice.playId,
      notice.attemptId,
    );
  }

  /** Records an event of the supervision with the ids of its scenario, play and attempt. */
  async record<T extends DaemonEventType>(
    type: T,
    payload: DaemonEventPayloads[T],
    playId: string,
    attemptId?: string,
  ): Promise<void> {
    const sink = this.#deps.situations;
    if (sink === undefined) return;
    let scenarioId = this.#scenarios.get(playId);
    if (!this.#scenarios.has(playId)) {
      try {
        scenarioId = (await this.#deps.store.plays.get(playId))?.scenarioId;
      } catch {
        scenarioId = undefined;
      }
      this.#scenarios.set(playId, scenarioId);
    }
    sink.record(type, payload, { scenarioId, playId, attemptId });
  }
}
