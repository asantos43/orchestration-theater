// SPDX-License-Identifier: MPL-2.0
import { MENU_OPTIONS, type MenuOption } from './definitions.js';

/**
 * What the menu reads from the context. It is a structural subset of `PlayContext`, so this file
 * does not import `context.ts` (which names `PlayEffect`, and `effects.ts` imports this file).
 */
export interface MenuContext {
  readonly producerReason: { readonly kind: string } | null;
  readonly approvedDemands: readonly string[];
  readonly criticRejected: boolean;
  readonly criticWaived: boolean;
}

/**
 * The options of the fixed menu that hold for the play now, in the fixed order (5.4): the list is
 * closed and comes from the code, and the interface shows every option that applies.
 *
 * - `raise_limit` only when a counter ran out (not for a critical exception);
 * - `deliver_ready` only when at least one demand was approved;
 * - `accept_as_is` only after a rejection of the Critic, and only while the Critic still counts;
 * - `redefine_need` and `cancel` always;
 * - [proposta] when the base drifted (`delivery.base_drift: ask`, N83) only `redo_on_new_base`,
 *   `deliver_with_conflict` and `cancel` hold;
 * - [proposta] when the delivery asks (`delivery.mode: ask`, N89) only `deliver_pr`,
 *   `deliver_merge` and `cancel` hold.
 */
export function availableMenu(context: MenuContext): MenuOption[] {
  return MENU_OPTIONS.filter((option) => isAvailable(option, context));
}

export function isAvailable(option: MenuOption, context: MenuContext): boolean {
  const drifted = context.producerReason?.kind === 'base_drift';
  const delivering = context.producerReason?.kind === 'delivery_ask';
  const special = drifted || delivering;
  switch (option) {
    case 'cancel':
      return true;
    case 'redefine_need':
      return !special;
    case 'raise_limit':
      return context.producerReason?.kind === 'limit';
    case 'deliver_ready':
      return !special && context.approvedDemands.length > 0;
    case 'accept_as_is':
      return !special && context.criticRejected && !context.criticWaived;
    case 'redo_on_new_base':
    case 'deliver_with_conflict':
      return drifted;
    case 'deliver_pr':
    case 'deliver_merge':
      return delivering;
  }
}
