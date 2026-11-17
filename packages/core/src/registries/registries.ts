// SPDX-License-Identifier: MPL-2.0
import {
  createEventRegistry,
  validateEventTypes,
  type EventRegistry,
  type EventTypeDefinition,
} from './events.js';
import { validateFlows, OFFICIAL_FLOWS, type FlowDefinition } from './flows.js';
import {
  assertNoRegistryProblems,
  createRegistry,
  ProblemCollector,
  type Registry,
  type RegistryProblem,
} from './problems.js';
import { OFFICIAL_ROLES, validateRoles, type RoleDefinition } from './roles.js';
import { OFFICIAL_RULE_KEYS, validateRuleKeys, type RuleKeyDefinition } from './rule-keys.js';
import {
  OFFICIAL_SCENARIO_TYPES,
  validateScenarioTypes,
  type ScenarioTypeDefinition,
} from './scenario-types.js';
import { OFFICIAL_TOOLS, validateTools, type ToolDefinition } from './tools.js';

/** Everything the registries are built from: plain lists of definitions. */
export interface RegistryEntries {
  readonly roles: readonly RoleDefinition[];
  readonly tools: readonly ToolDefinition[];
  readonly ruleKeys: readonly RuleKeyDefinition[];
  readonly events: readonly EventTypeDefinition[];
  readonly flows: readonly FlowDefinition[];
  readonly scenarioTypes: readonly ScenarioTypeDefinition[];
}

/** The validated, immutable registries (architecture 5.18, "Registros"). */
export interface Registries {
  readonly roles: Registry<RoleDefinition>;
  readonly tools: Registry<ToolDefinition>;
  readonly ruleKeys: Registry<RuleKeyDefinition>;
  readonly events: EventRegistry;
  readonly flows: Registry<FlowDefinition>;
  readonly scenarioTypes: Registry<ScenarioTypeDefinition>;
}

/**
 * The official entries of everything but the event types. The event types of the daemon live in
 * `@otheater/protocol` (core cannot import it), so the caller hands them in.
 */
export function officialRegistryEntries(
  events: readonly EventTypeDefinition[] = [],
): RegistryEntries {
  return {
    roles: OFFICIAL_ROLES,
    tools: OFFICIAL_TOOLS,
    ruleKeys: OFFICIAL_RULE_KEYS,
    events,
    flows: OFFICIAL_FLOWS,
    scenarioTypes: OFFICIAL_SCENARIO_TYPES,
  };
}

/**
 * Checks every registry and the references between them, and returns ALL the problems (an empty
 * list means valid):
 * - a name appears once per registry;
 * - a tool names roles that exist; a flow names roles and tools that exist;
 * - a scenario type names flows that exist;
 * - every event type and every rule key has a schema;
 * - an `external_write` tool has an idempotency key.
 */
export function validateRegistries(entries: RegistryEntries): readonly RegistryProblem[] {
  const roles = new ProblemCollector('roles');
  const tools = new ProblemCollector('tools');
  const ruleKeys = new ProblemCollector('ruleKeys');
  const events = new ProblemCollector('events');
  const flows = new ProblemCollector('flows');
  const scenarioTypes = new ProblemCollector('scenarioTypes');

  const roleIds = new Set(entries.roles.map((role) => role.id));
  const toolNames = new Set(entries.tools.map((tool) => tool.name));
  const flowIds = new Set(entries.flows.map((flow) => flow.id));

  validateRoles(entries.roles, roles);
  validateTools(entries.tools, roleIds, tools);
  validateRuleKeys(entries.ruleKeys, ruleKeys);
  validateEventTypes(entries.events, events);
  validateFlows(entries.flows, roleIds, toolNames, flows);
  validateScenarioTypes(entries.scenarioTypes, flowIds, scenarioTypes);

  return [
    ...roles.problems,
    ...tools.problems,
    ...ruleKeys.problems,
    ...events.problems,
    ...flows.problems,
    ...scenarioTypes.problems,
  ];
}

/**
 * Validates the entries and builds the immutable registries. Throws `InvalidInput` listing every
 * problem (registry and entry named) when there is one.
 */
export function buildRegistries(entries: RegistryEntries): Registries {
  assertNoRegistryProblems('Invalid registries', validateRegistries(entries));
  return Object.freeze({
    roles: createRegistry(entries.roles, (role) => role.id),
    tools: createRegistry(entries.tools, (tool) => tool.name),
    ruleKeys: createRegistry(entries.ruleKeys, (entry) => entry.key),
    events: createEventRegistry(entries.events),
    flows: createRegistry(entries.flows, (flow) => flow.id),
    scenarioTypes: createRegistry(entries.scenarioTypes, (type) => type.id),
  });
}
