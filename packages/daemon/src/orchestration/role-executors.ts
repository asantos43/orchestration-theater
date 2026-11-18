// SPDX-License-Identifier: MPL-2.0
import {
  ROLE_IDS,
  resolveRoleExecutors,
  type ExecutorCapabilities,
  type ExecutorEntry,
  type JsonObject,
  type LegacyExecutor,
  type ProfileFact,
  type ResolvedRoles,
  type RoleId,
  type RolesLayer,
  type ScenarioRegistry,
} from '@otheater/core';
import type { DaemonConfig } from '../config.js';
import { parseRolesOverride, scenarioChain } from './role-policy.js';

/**
 * The Executors of each role for the work of a scenario (architecture 5.7; Phase 5, P13): the
 * layers of configuration read like the tool policy of the role (`role-policy.ts`), and the pure
 * resolution of `@otheater/core` (`resolveRoleExecutors`). Nothing calls it yet: the Director and
 * the pipeline still run the Executor of `orchestration.executor` until P16, and the selection
 * (P15) and the account service (P2) join the facts below.
 *
 * Layers, from the weakest to the strongest: the daemon configuration, then the `configOverride`
 * of each scenario along the `originScenarioId` chain, oldest first (a project is a scenario, and
 * its override is the project's own configuration; a task promoted from it comes after), then the
 * override of a scheduled task. The scheduler (Phase 6) does not exist yet, so the task layer is an
 * argument.
 */

/** What the resolution needs besides the configuration; the caller reads it from the store. */
export interface RoleExecutorFacts {
  /** The Executors found by the catalogs (Claude Code, Codex), besides `executors.<id>`. */
  readonly discovered?: readonly ExecutorEntry[] | undefined;
  /** The profiles, in the order of the confirmed accounts. */
  readonly profiles: readonly ProfileFact[];
  readonly capabilities?: ReadonlyMap<string, ExecutorCapabilities> | undefined;
}

/** What `resolveScenarioRoleExecutors` reads. */
export interface RoleExecutorResolver {
  readonly config: Pick<DaemonConfig, 'roles' | 'executors' | 'orchestration'>;
  readonly scenarios: Pick<ScenarioRegistry, 'get'>;
}

/**
 * The old format as one Executor per role: `orchestration.roles.<role>` wins over
 * `orchestration.executor`, which every other role uses. A name of `orchestration.roles` that is
 * not a role is left out.
 */
export function legacyExecutorsOf(
  orchestration: DaemonConfig['orchestration'],
): Partial<Record<RoleId, LegacyExecutor>> {
  const out: Partial<Record<RoleId, LegacyExecutor>> = {};
  for (const role of ROLE_IDS) {
    const own = orchestration.roles[role] ?? orchestration.executor;
    if (own !== undefined) {
      out[role] = {
        client: own.client,
        profile: own.profile,
        model: own.model,
        effort: own.effort,
      };
    }
  }
  return out;
}

/**
 * The deprecation notices of the old format (Phase 5, P13, [proposta]): one line per old key in
 * use. The old keys keep working, as a list of one Executor, until P16 changes the pipeline.
 */
export function deprecationWarnings(orchestration: DaemonConfig['orchestration']): string[] {
  const out: string[] = [];
  if (orchestration.executor !== undefined) {
    out.push(
      'orchestration.executor is deprecated: name the Executors of each role in roles.<role>.executors (a list, 5.7); it keeps working as a list of one item until the pipeline reads the lists',
    );
  }
  for (const role of Object.keys(orchestration.roles)) {
    out.push(
      `orchestration.roles.${role} is deprecated: use roles.${role}.executors (a list, 5.7); it keeps working as a list of one item until the pipeline reads the lists`,
    );
  }
  return out;
}

/** `executors.<id>` of the configuration plus the discovered ones; the configuration wins on an id. */
export function executorCatalogOf(
  config: Pick<DaemonConfig, 'executors'>,
  discovered: readonly ExecutorEntry[] = [],
): ExecutorEntry[] {
  const own = Object.values(config.executors.entries);
  const ids = new Set(own.map((entry) => entry.id));
  return [...own, ...discovered.filter((entry) => !ids.has(entry.id))];
}

/**
 * The Executors of every role for `scenarioId` (none: the daemon configuration alone), with an
 * optional scheduled-task override on top. Rejects with `InvalidInput` when an override is
 * malformed (naming the scenario and the key) or when `roles.capability_check: block` refuses an
 * Executor of a list somebody wrote.
 */
export async function resolveScenarioRoleExecutors(
  resolver: RoleExecutorResolver,
  facts: RoleExecutorFacts,
  scenarioId?: string,
  taskOverride?: JsonObject,
): Promise<ResolvedRoles> {
  const layers: RolesLayer[] = [resolver.config.roles];
  if (scenarioId !== undefined) {
    for (const record of await scenarioChain(resolver.scenarios, scenarioId)) {
      layers.push(
        parseRolesOverride(record.configOverride, `scenario "${record.id}" configOverride`),
      );
    }
  }
  if (taskOverride !== undefined) {
    layers.push(parseRolesOverride(taskOverride, 'scheduled task override'));
  }
  return resolveRoleExecutors({
    layers,
    legacy: legacyExecutorsOf(resolver.config.orchestration),
    catalog: executorCatalogOf(resolver.config, facts.discovered),
    profiles: facts.profiles,
    capabilities: facts.capabilities,
    crossClient: resolver.config.executors.cross_client,
  });
}
