// SPDX-License-Identifier: MPL-2.0
import type { ResolvedRole, Store } from '@otheater/core';
import type { BudgetService } from '../budget/index.js';
import type {
  ExhaustionPort,
  ExhaustionRequest,
  ExhaustionRules,
} from '../execution/exhaustion.js';
import type { Logger } from '../logger.js';
import type { RoleSelection } from './role-selection.js';

export interface DaemonExhaustionDeps {
  readonly store: Pick<Store, 'plays'>;
  readonly selection: Pick<RoleSelection, 'selectorInputs'>;
  readonly budget: Pick<BudgetService, 'settingsOf' | 'resolveExceeded'>;
  readonly logger: Logger;
}

/**
 * What the role and the budget of a profile say when it runs out (Phase 5, P19): the pipeline does
 * not copy `when_exhausted` or `in_flight` into the spec of an attempt, so the runner asks here, at
 * the moment of the interruption, and reads the configuration as it is then.
 *
 * - `when_exhausted` is the one of the role of the attempt, in the scenario of its play.
 * - `in_flight` is the one of `profiles.<id>.budget`.
 * - `waitForCap` is whether the answer about the spent cap is `wait` (`on_exceeded: wait`, or `ask`
 *   answered with `wait`); a cap that is not spent says no.
 *
 * Each part is read on its own: one that fails does not hide the others, and it is the caller that
 * writes the `play.notice` when this rejects (nothing is swallowed here).
 */
export function createDaemonExhaustion(deps: DaemonExhaustionDeps): ExhaustionPort {
  return {
    async rulesOf(request: ExhaustionRequest): Promise<ExhaustionRules> {
      const { inFlight } = deps.budget.settingsOf(request.profile.id);
      const pending = deps.budget.resolveExceeded(request.profile.id);
      const choice = pending === undefined ? undefined : (await pending).choice;
      const base = { inFlight, waitForCap: choice === 'wait' };
      if (request.role === undefined) return base;
      const play = await deps.store.plays.get(request.playId);
      const inputs = await deps.selection.selectorInputs(play?.scenarioId);
      const roles = inputs.roles as Readonly<Record<string, ResolvedRole | undefined>>;
      const whenExhausted = roles[request.role]?.whenExhausted;
      return whenExhausted === undefined ? base : { ...base, whenExhausted };
    },
  };
}
