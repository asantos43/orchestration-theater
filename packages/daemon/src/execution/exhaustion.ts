// SPDX-License-Identifier: MPL-2.0
import type { Profile, WhenExhausted } from '@otheater/core';
import type { InFlightMode } from './interruption-policy.js';

/**
 * What the role and the budget of a profile say when it runs out (architecture 5.6, 5.7 and 5.16;
 * Phase 5, P19). The policy of an interruption (`decideInterruption`) reads them as facts; the
 * runner does not know the roles or the budget, so it asks this port, and the daemon answers.
 */
export interface ExhaustionRules {
  /** `roles.<role>.when_exhausted`: `wait` waits for a near reset, `next` hands off. */
  readonly whenExhausted?: WhenExhausted;
  /** `profiles.<id>.budget.in_flight`. */
  readonly inFlight?: InFlightMode;
  /**
   * `profiles.<id>.budget.on_exceeded` settled to `wait` (the answer the Producer gave, when it
   * was `ask`): with `in_flight: handoff` a cap that comes back soon is waited for.
   */
  readonly waitForCap?: boolean;
}

/** What the port is asked about: the attempt, its role and the profile that ran out. */
export interface ExhaustionRequest {
  readonly playId: string;
  readonly role: string | undefined;
  readonly profile: Profile;
}

export interface ExhaustionPort {
  /** May reject: the runner then goes on with the defaults and writes a `play.notice` (`exhaustion_not_read`). */
  rulesOf(request: ExhaustionRequest): Promise<ExhaustionRules>;
}

/** A port the runner holds from the start, bound to the real one when the budget exists. */
export interface LateExhaustion {
  readonly port: ExhaustionPort;
  /** Binds the real port; `undefined` unbinds it (the daemon is stopping). */
  bind(port: ExhaustionPort | undefined): void;
}

/** Until it is bound the answer is "nothing is known": the defaults (`next`, `handoff`) hold. */
export function createLateExhaustion(): LateExhaustion {
  let bound: ExhaustionPort | undefined;
  return {
    port: {
      rulesOf: async (request) => (bound === undefined ? {} : bound.rulesOf(request)),
    },
    bind: (next) => {
      bound = next;
    },
  };
}
