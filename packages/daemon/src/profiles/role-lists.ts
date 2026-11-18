// SPDX-License-Identifier: MPL-2.0
import { formatProfileId, type ProfileFact, type Store } from '@otheater/core';
import type { DaemonConfig } from '../config.js';
import { resolveScenarioRoleExecutors } from '../orchestration/role-executors.js';
import type { RoleListFact } from './service.js';

/**
 * The lists of the roles as the daemon configuration gives them, with the profiles read from the
 * store at the moment of the call (so a profile just removed shows as `invalid`). The hook of
 * `ProfileService` for the removal (Phase 5, P21). [proposta] Only the configuration-level lists:
 * the override of a scenario is a layer of that scenario's own, and a removal that empties it is
 * seen when the scenario selects.
 */
export function roleListsOf(
  config: Pick<DaemonConfig, 'roles' | 'executors' | 'orchestration'>,
  store: Pick<Store, 'profiles' | 'scenarios'>,
): () => Promise<readonly RoleListFact[]> {
  return async () => {
    const profiles: ProfileFact[] = (await store.profiles.list()).map((record) => ({
      id: record.id,
      kind: record.kind,
      state: record.state,
    }));
    const resolved = await resolveScenarioRoleExecutors(
      { config, scenarios: store.scenarios },
      { profiles },
    );
    return Object.values(resolved.roles).map((role) => ({
      role: role.role,
      executors: role.executors.map((executor) => ({
        profileId: formatProfileId({
          client: executor.entry.client,
          profile: executor.entry.profile,
        }),
        valid: executor.validity === 'valid',
      })),
    }));
  };
}
