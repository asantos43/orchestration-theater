// SPDX-License-Identifier: MPL-2.0

/**
 * [proposta] The keys of the blackboard of a play (architecture 5.4 and section 7: plan, script,
 * contracts and decisions). The plan and the script are one key each; a contract is the key
 * `contract/<id>`. A decision is not a blackboard key: it lives in the `decisions` registry and
 * `read_decision` reads it from there.
 */
export const PLAN_KEY = 'plan';
export const SCRIPT_KEY = 'script';
export const CONTRACT_KEY_PREFIX = 'contract/';

/** The blackboard key of the contract `id`. */
export function contractKey(id: string): string {
  return `${CONTRACT_KEY_PREFIX}${id}`;
}
