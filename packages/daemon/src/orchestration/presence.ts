// SPDX-License-Identifier: MPL-2.0
import type { Clock } from '@otheater/core';
import type { ChatPresenceMode } from '../config.js';

export interface ChatPresenceOptions {
  readonly clock: Pick<Clock, 'now'>;
  /** `chat.presence`. */
  readonly mode: ChatPresenceMode;
  /** `chat.presence_window`, in milliseconds. */
  readonly windowMs: number;
}

/**
 * Who is watching (decision of P15a, [proposta]): an `ot chat` is connected to a scenario while it
 * polls it, or while its chat WebSocket is open (`hold`, P7). Every poll of the channel marks the
 * scenario; the scenario counts as watched for `windowMs` after the last one. The presence is in memory: after a restart nobody is there until
 * the chat polls again (it does so every few hundred milliseconds).
 */
export class ChatPresence {
  readonly #options: ChatPresenceOptions;
  readonly #seen = new Map<string, number>();
  readonly #held = new Map<string, number>();

  constructor(options: ChatPresenceOptions) {
    this.#options = options;
  }

  /** A chat polled the scenario just now. */
  touch(scenarioId: string): void {
    this.#seen.set(scenarioId, this.#options.clock.now());
  }

  /**
   * A chat WebSocket opened on the scenario (P7 of docs/17): the scenario counts as watched for as
   * long as the socket is open, with no polling, until the returned function is called (once; a
   * second call does nothing). [proposta] The mode `never` still says nobody watches.
   */
  hold(scenarioId: string): () => void {
    this.#held.set(scenarioId, (this.#held.get(scenarioId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#held.get(scenarioId) ?? 1) - 1;
      if (left > 0) this.#held.set(scenarioId, left);
      else this.#held.delete(scenarioId);
      // The last socket that goes away leaves the scenario watched for the window, like a poll.
      this.touch(scenarioId);
    };
  }

  /** Whether someone watches the scenario now. */
  attended(scenarioId: string): boolean {
    const { mode, clock, windowMs } = this.#options;
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    if ((this.#held.get(scenarioId) ?? 0) > 0) return true;
    const last = this.#seen.get(scenarioId);
    return last !== undefined && clock.now() - last <= windowMs;
  }
}
