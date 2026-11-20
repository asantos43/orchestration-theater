// SPDX-License-Identifier: MPL-2.0
import {
  ROLE_IDS,
  formatProfileId,
  type ExecutorRecord,
  type ProfileFact,
  type RoleId,
} from '@otheater/core';
import type { ApiExecutor, ApiRole, ApiRoleExecutor, ApiRoles } from '@otheater/protocol';
import { REMOVED_REASON } from '../../executors/service.js';
import { authorizes } from '../../quota/state.js';
import { resolveScenarioRoleExecutors } from '../../orchestration/role-executors.js';
import type { ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';
import { paginate } from './paging.js';

export function registerExecutorRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { store, config, quota, budget } = deps;

  async function resolve(): Promise<Awaited<ReturnType<typeof resolveScenarioRoleExecutors>>> {
    const profiles: ProfileFact[] = (await store.profiles.list()).map((record) => ({
      id: record.id,
      kind: record.kind,
      state: record.state,
    }));
    return resolveScenarioRoleExecutors({ config, scenarios: store.scenarios }, { profiles });
  }

  handlers.register('listExecutors', async ({ query }) => {
    const resolved = await resolve();
    const entries = config.executors.entries;
    const rolesHolding = (id: string): RoleId[] =>
      ROLE_IDS.filter((role) => resolved.roles[role].executors.some((item) => item.id === id));
    const rows: readonly ExecutorRecord[] = await store.executors.list();
    const out: ApiExecutor[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      if (row.invalidReason === REMOVED_REASON) continue;
      const [client = '', profile = ''] = row.profileId.split('/');
      out.push({
        id: row.id,
        profileId: row.profileId,
        client,
        profile,
        model: entries[row.id]?.model ?? row.model,
        effort: row.effort,
        provider: row.provider,
        validity: row.validity,
        invalidReason: row.invalidReason,
        configured: entries[row.id] !== undefined,
        roles: rolesHolding(row.id),
      });
    }
    // In the configuration and not in the table yet (a hand-written entry).
    for (const entry of Object.values(entries)) {
      if (seen.has(entry.id)) continue;
      out.push({
        id: entry.id,
        profileId: formatProfileId({ client: entry.client, profile: entry.profile }),
        client: entry.client,
        profile: entry.profile,
        model: entry.model,
        effort: entry.effort,
        provider: entry.provider,
        validity: 'valid',
        invalidReason: null,
        configured: true,
        roles: rolesHolding(entry.id),
      });
    }
    const wanted = out.filter(
      (item) =>
        (query.profileId === undefined || item.profileId === query.profileId) &&
        (query.validity === undefined || item.validity === query.validity),
    );
    return paginate(wanted, (item) => [item.id], query);
  });

  handlers.register('listRoles', async () => {
    const resolved = await resolve();
    const rows = new Map((await store.executors.list()).map((row) => [row.id, row]));
    const quotaOk = new Map<string, boolean>();
    const quotaAllows = async (profileId: string): Promise<boolean> => {
      const known = quotaOk.get(profileId);
      if (known !== undefined) return known;
      const status = await quota.statusOf(profileId);
      const allowed =
        authorizes(status) ||
        (status.state === 'unknown' && config.selection.unknown_quota === 'allow');
      quotaOk.set(profileId, allowed);
      return allowed;
    };

    const roles: ApiRole[] = [];
    for (const roleId of ROLE_IDS) {
      const role = resolved.roles[roleId];
      const executors: ApiRoleExecutor[] = [];
      for (const item of role.executors) {
        const row = rows.get(item.id);
        // The table knows more than the configuration: a model the catalog dropped is `invalid`.
        const invalid = item.validity === 'invalid' || row?.validity === 'invalid';
        const profileId = formatProfileId({
          client: item.entry.client,
          profile: item.entry.profile,
        });
        let blockedBy: ApiRoleExecutor['blockedBy'] = null;
        if (invalid) blockedBy = 'invalid';
        else if (!(await quotaAllows(profileId))) blockedBy = 'quota';
        else if (!(await budget.headroom(item.id)).allowed) blockedBy = 'budget';
        executors.push({
          id: item.id,
          profileId,
          model: item.entry.model,
          effort: item.entry.effort,
          provider: item.entry.provider,
          validity: invalid ? 'invalid' : 'valid',
          invalidReason:
            item.validity === 'invalid' ? item.invalidReason : (row?.invalidReason ?? null),
          origin: item.origin,
          blockedBy,
          shortfalls: item.shortfalls.map((shortfall) => shortfall.kind),
        });
      }
      roles.push({
        role: roleId,
        source: role.source,
        whenExhausted: role.whenExhausted,
        executors,
        next: executors.find((item) => item.blockedBy === null)?.id ?? null,
      });
    }
    const body: ApiRoles = {
      preset: resolved.preset,
      capabilityCheck: resolved.capabilityCheck,
      allowedProfiles: resolved.allowedProfiles === null ? null : [...resolved.allowedProfiles],
      roles,
      notes: resolved.notes.map((note) => ({ ...note })),
    };
    return body;
  });
}
