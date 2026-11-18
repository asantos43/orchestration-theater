// SPDX-License-Identifier: MPL-2.0
import {
  CROSS_CHECK_ROLES,
  type ProfileFact,
  type ResolvedRoles,
  type RoleId,
  type SelectionSettings,
  type Store,
} from '@otheater/core';
import type { DaemonConfig } from '../config.js';
import { selectionSettingsOf } from './executor-selection.js';
import { resolveScenarioRoleExecutors } from './role-executors.js';

/**
 * The notice at load of a strict cross-review that cannot be met (architecture 5.7; Phase 5, P15b,
 * N150): with `selection.cross_check: require_other_provider` the list of the Reviewer or of the
 * Critic needs Executors of more than one provider, and with `other_model` of more than one model.
 * A list that has only one never gets a Reviewer different from the one that did the work, however
 * long it waits, so the selection falls to the provider of the work at once
 * (`crossCheck.noneConfigured`); this tells the Producer when the configuration is loaded, instead
 * of at the first review.
 *
 * [proposta] The rules of the count:
 * - it counts every Executor of the resolved list, valid or not: the warning is about the shape of
 *   the configuration, and a profile that is not registered yet is the Producer's to fix, not a
 *   reason to hide the problem;
 * - providers, not accounts: two accounts of Claude Code are one provider, and with `other_model`
 *   two accounts of the same model are one model (N150);
 * - the provider `unknown` counts as different from every other (5.7), so a list with an `unknown`
 *   Executor can be met;
 * - only the lists of the daemon configuration are read: the override of a scenario is not.
 */

export interface CrossCheckNotice {
  readonly role: RoleId;
  /** In English, for the log and for the `detail` of the event. */
  readonly message: string;
}

/** The notices of the roles of `roles` that the settings make impossible to cross-check. */
export function crossCheckNotices(
  settings: Pick<SelectionSettings, 'crossCheck' | 'sameProviderFallback'>,
  roles: ResolvedRoles['roles'],
): CrossCheckNotice[] {
  const { crossCheck } = settings;
  if (crossCheck !== 'require_other_provider' && crossCheck !== 'other_model') return [];
  const out: CrossCheckNotice[] = [];
  for (const id of CROSS_CHECK_ROLES) {
    const executors = roles[id].executors;
    if (executors.length === 0) continue;
    const what = crossCheck === 'other_model' ? 'model' : 'provider';
    const names = new Set(
      executors.map((item) =>
        (what === 'model' ? item.entry.model : item.entry.provider).toLowerCase(),
      ),
    );
    // `unknown` differs from every provider, itself included.
    if (names.size !== 1 || (what === 'provider' && names.has('unknown'))) continue;
    const only = [...names][0] ?? '';
    out.push({
      role: id,
      message: `selection.cross_check is ${crossCheck} and the list of ${id} has Executors of one ${what} only (${only}): a different ${what} never becomes available, so the review falls back to the ${what} of the work at once (selection.same_provider_fallback: ${settings.sameProviderFallback})`,
    });
  }
  return out;
}

/**
 * The notices of the configuration as the daemon loaded it: resolves the lists of the roles over
 * the profiles of the registry (a preset needs the accounts to expand) and checks the Reviewer and
 * the Critic. Rejects when the resolution does (a list `roles.capability_check: block` refuses);
 * the caller logs that and goes on, since the first selection reports it again.
 */
export async function loadCrossCheckNotices(
  config: DaemonConfig,
  store: Pick<Store, 'profiles' | 'scenarios'>,
): Promise<CrossCheckNotice[]> {
  const settings = selectionSettingsOf(config);
  if (settings.crossCheck !== 'require_other_provider' && settings.crossCheck !== 'other_model') {
    return [];
  }
  const profiles: ProfileFact[] = (await store.profiles.list()).map((record) => ({
    id: record.id,
    kind: record.kind,
    state: record.state,
  }));
  const resolved = await resolveScenarioRoleExecutors(
    { config, scenarios: store.scenarios },
    { profiles },
  );
  return crossCheckNotices(settings, resolved.roles);
}
