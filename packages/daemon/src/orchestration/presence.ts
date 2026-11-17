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
 * polls it. Every poll of the channel marks the scenario; the scenario counts as watched for
 * `windowMs` after the last one. The presence is in memory: after a restart nobody is there until
 * the chat polls again (it does so every few hundred milliseconds).
 */
export class ChatPresence {
  readonly #options: ChatPresenceOptions;
  readonly #seen = new Map<string, number>();

  constructor(options: ChatPresenceOptions) {
    this.#options = options;
  }

  /** A chat polled the scenario just now. */
  touch(scenarioId: string): void {
    this.#seen.set(scenarioId, this.#options.clock.now());
  }

  /** Whether someone watches the scenario now. */
  attended(scenarioId: string): boolean {
    const { mode, clock, windowMs } = this.#options;
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    const last = this.#seen.get(scenarioId);
    return last !== undefined && clock.now() - last <= windowMs;
  }
}
