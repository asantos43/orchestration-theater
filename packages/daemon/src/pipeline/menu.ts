// SPDX-License-Identifier: MPL-2.0
import type { PlayContext } from './context.js';
import { MENU_OPTIONS, type MenuOption } from './definitions.js';

/**
 * The options of the fixed menu that hold for the play now, in the fixed order (5.4): the list is
 * closed and comes from the code, and the interface shows every option that applies.
 *
 * - `raise_limit` only when a counter ran out (not for a critical exception);
 * - `deliver_ready` only when at least one demand was approved;
 * - `accept_as_is` only after a rejection of the Critic, and only while the Critic still counts;
 * - `redefine_need` and `cancel` always;
 * - [proposta] when the base drifted (`delivery.base_drift: ask`, N83) only `redo_on_new_base`,
 *   `deliver_with_conflict` and `cancel` hold.
 */
export function availableMenu(context: PlayContext): MenuOption[] {
  return MENU_OPTIONS.filter((option) => isAvailable(option, context));
}

export function isAvailable(option: MenuOption, context: PlayContext): boolean {
  const drifted = context.producerReason?.kind === 'base_drift';
  switch (option) {
    case 'cancel':
      return true;
    case 'redefine_need':
      return !drifted;
    case 'raise_limit':
      return context.producerReason?.kind === 'limit';
    case 'deliver_ready':
      return !drifted && context.approvedDemands.length > 0;
    case 'accept_as_is':
      return !drifted && context.criticRejected && !context.criticWaived;
    case 'redo_on_new_base':
    case 'deliver_with_conflict':
      return drifted;
  }
}
