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

/**
 * [proposta] The notes board of a play (N308, option 1; plan of Phase 11b, P13): the notes of the
 * Actor of a demand are the versions of the key `notes/<demand>`, one version per note, with the
 * attempt as the author. The board is data for the other Actors, never an order: the contract of
 * the demand stays the interface.
 */
export const NOTES_KEY_PREFIX = 'notes/';

/** The blackboard key of the notes of the demand `demandId`. */
export function notesKey(demandId: string): string {
  return `${NOTES_KEY_PREFIX}${demandId}`;
}

/**
 * [proposta] The messages of the Director's supervision to the Actors of a demand (N309, D8; plan
 * of Phase 11b, P14): each message is a version of `supervision/<demand>`, written when it is
 * queued and again when its state changes (`delivered`, `dropped`), so a pending message survives
 * a restart of the daemon (architecture 5.16). The latest version of each `noticeId` is its state.
 */
export const SUPERVISION_KEY_PREFIX = 'supervision/';

/** The blackboard key of the supervision messages of the demand `demandId`. */
export function supervisionKey(demandId: string): string {
  return `${SUPERVISION_KEY_PREFIX}${demandId}`;
}
