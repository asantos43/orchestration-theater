// SPDX-License-Identifier: MPL-2.0
import {
  InvalidInput,
  type JsonObject,
  type RolePolicy,
  type ScenarioRecord,
  type ScenarioRegistry,
  type ToolDefinition,
} from '@otheater/core';
import { describeZodError, type DaemonConfig } from '../config.js';
import { FRAMEWORK_MCP_NAME } from '../mcp/access.js';
import {
  RolesConfigSchema,
  type POLICY_NATIVE_TOOLS,
  type RolePolicySettings,
} from '../role-policy-config.js';

/**
 * The tool policy of a role, from the configuration (architecture 5.2 and 5.8; Phase 4, P1; N99).
 * `policyOf` of the earlier steps was fixed in code; this is the same policy as the default and
 * the keys `roles.<role>.policy` change it.
 *
 * Layers, from the weakest to the strongest [proposta]:
 * 1. the default of the role;
 * 2. `roles.<role>.policy` of the daemon configuration;
 * 3. the `configOverride` of the scenario the role works for, after the one of the scenario it was
 *    promoted from (`originScenarioId`, a project for a task that came out of it), oldest first.
 * A layer replaces the keys it names (a list replaces the list) and leaves the rest alone.
 */

/** What a policy settles on after the layers: every key has a value. */
export interface PolicySettings {
  readonly nativeTools: readonly (typeof POLICY_NATIVE_TOOLS)[number][];
  readonly nativeShell: 'none' | 'shells';
  readonly network: { readonly allow: readonly string[] };
  readonly onAsk: 'reject' | 'rules';
}

/** Roles that write in their worktree; every other role only reads (5.4, "Fronteira de cada papel"). */
const WRITING_ROLES: ReadonlySet<string> = new Set(['actor']);

/**
 * Tools of the framework server that open the network. [proposta] They are listed for a role only
 * while `network.allow` has a domain, so a role with an empty list has no tool that reaches out.
 */
export const NETWORK_TOOLS: ReadonlySet<string> = new Set(['http_get']);

/** The policy of a role with no configuration: the one the daemon used before it had keys. */
export function defaultPolicySettings(role: string): PolicySettings {
  return {
    nativeTools: WRITING_ROLES.has(role) ? ['read', 'search', 'edit', 'write'] : ['read', 'search'],
    nativeShell: 'none',
    network: { allow: [] },
    onAsk: 'reject',
  };
}

/** The settings after one more layer: the keys the layer names win. */
export function applyPolicyLayer(base: PolicySettings, layer: RolePolicySettings): PolicySettings {
  return {
    nativeTools: layer.native_tools === undefined ? base.nativeTools : unique(layer.native_tools),
    nativeShell: layer.native_shell ?? base.nativeShell,
    network: layer.network === undefined ? base.network : { allow: unique(layer.network.allow) },
    onAsk: layer.on_ask ?? base.onAsk,
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * The tools of the framework server a role may call (architecture 5.3, "filtrado pelo registro"):
 * the ones the registry gives the role, minus the daemon's shells (effect `worktree`) unless
 * `native_shell` is `shells`, minus the tools that open the network unless `network.allow` has a
 * domain. [proposta] That the shells are the tools with effect `worktree` is the reading of the
 * registry of this step; P3 owns the registry and can change it.
 */
export function frameworkToolsOf(
  role: string,
  settings: PolicySettings,
  tools: readonly ToolDefinition[],
): string[] {
  return tools
    .filter((tool) => tool.roles.includes(role))
    .filter((tool) => settings.nativeShell === 'shells' || tool.effect !== 'worktree')
    .filter((tool) => settings.network.allow.length > 0 || !NETWORK_TOOLS.has(tool.name))
    .map((tool) => tool.name);
}

/** The neutral policy of a role for the settings the layers settled on. */
export function buildRolePolicy(
  role: string,
  settings: PolicySettings,
  tools: readonly ToolDefinition[],
): RolePolicy {
  return {
    nativeTools: settings.nativeTools,
    nativeShell: settings.nativeShell,
    mcpServers: [FRAMEWORK_MCP_NAME],
    mcpTools: { [FRAMEWORK_MCP_NAME]: frameworkToolsOf(role, settings, tools) },
    onAsk: settings.onAsk,
    bypass: 'forbidden',
    writeScope: 'worktree',
    network: { allow: settings.network.allow },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Puts `value` at `path`; an object lands key by key, so it merges with what is there. */
function setDeep(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = target;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (isObject(next)) {
      node = next;
    } else {
      const fresh: Record<string, unknown> = {};
      node[key] = fresh;
      node = fresh;
    }
  }
  const last = path.at(-1);
  if (last === undefined) return;
  if (isObject(value)) {
    for (const [key, inner] of Object.entries(value)) setDeep(node, [last, key], inner);
    if (Object.keys(value).length === 0 && !isObject(node[last])) node[last] = {};
  } else {
    node[last] = value;
  }
}

/**
 * The `roles` part of a `configOverride`, checked like the `roles` of the configuration: a key
 * written as a dotted path (`roles.actor.policy.native_shell`) or as nested objects both count, and
 * the opening N99 forbids is refused, here as in the daemon configuration. Keys that do not start
 * with `roles` are the business of other readers and are left alone.
 */
export function rolesOverrideOf(configOverride: JsonObject, source: string): RolePolicyLayers {
  const tree: Record<string, unknown> = {};
  // The shorter paths first, so `roles.actor.policy.native_shell` refines a `roles` object next to it.
  const entries = Object.entries(configOverride).sort(
    ([a], [b]) => a.split('.').length - b.split('.').length,
  );
  for (const [key, value] of entries) {
    if (key === 'roles' || key.startsWith('roles.')) setDeep(tree, key.split('.'), value);
  }
  const raw = tree.roles ?? {};
  const parsed = RolesConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidInput(`${source}: roles: ${describeZodError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data as RolePolicyLayers;
}

/** `roles` as the configuration and an override carry it. */
export type RolePolicyLayers = Readonly<
  Record<string, { readonly policy?: RolePolicySettings } | undefined>
>;

/** What `resolveRolePolicy` reads. */
export interface RolePolicyResolver {
  readonly config: Pick<DaemonConfig, 'roles'>;
  readonly scenarios: Pick<ScenarioRegistry, 'get'>;
  /** The registry of tools (`registries.tools.list()`). */
  readonly tools: () => readonly ToolDefinition[];
}

/** How far up the `originScenarioId` chain the layers go; a longer one is a loop or a mistake. */
const MAX_ORIGIN_DEPTH = 8;

/** The scenario and the ones it came from, oldest first. */
async function scenarioChain(
  scenarios: Pick<ScenarioRegistry, 'get'>,
  scenarioId: string,
): Promise<ScenarioRecord[]> {
  const chain: ScenarioRecord[] = [];
  const seen = new Set<string>();
  let next: string | null = scenarioId;
  while (next !== null && !seen.has(next) && chain.length < MAX_ORIGIN_DEPTH) {
    seen.add(next);
    const record = await scenarios.get(next);
    if (record === undefined) break;
    chain.unshift(record);
    next = record.originScenarioId;
  }
  return chain;
}

/**
 * The policy of `role` for the work of `scenarioId` (none: the daemon configuration alone). Rejects
 * with `InvalidInput` when a `configOverride` tries to open what N99 forbids.
 */
export async function resolveRolePolicy(
  resolver: RolePolicyResolver,
  role: string,
  scenarioId?: string,
): Promise<RolePolicy> {
  let settings = defaultPolicySettings(role);
  const global = (resolver.config.roles as RolePolicyLayers)[role]?.policy;
  if (global !== undefined) settings = applyPolicyLayer(settings, global);
  if (scenarioId !== undefined) {
    for (const record of await scenarioChain(resolver.scenarios, scenarioId)) {
      const layer = rolesOverrideOf(
        record.configOverride,
        `scenario "${record.id}" configOverride`,
      )[role]?.policy;
      if (layer !== undefined) settings = applyPolicyLayer(settings, layer);
    }
  }
  return buildRolePolicy(role, settings, resolver.tools());
}
