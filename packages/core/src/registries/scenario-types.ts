// SPDX-License-Identifier: MPL-2.0
import { reportDuplicates, type ProblemCollector } from './problems.js';

/** The scenario types of architecture 5.20. */
export const SCENARIO_TYPE_IDS = ['project', 'task', 'chat'] as const;
export type ScenarioTypeId = (typeof SCENARIO_TYPE_IDS)[number];

/** A scenario type and the flow it starts with (architecture 5.20, 5.18). */
export interface ScenarioTypeDefinition {
  readonly id: string;
  /** Id of the flow in the flow registry a new scenario of this type starts with. */
  readonly defaultFlow: string;
  /** Flows the type may run, the default included. */
  readonly flows: readonly string[];
}

/**
 * [proposta] Project starts with the play; a task starts by defining itself (`task.define`) and
 * runs with `task.run`; a chat runs `chat`.
 */
export const OFFICIAL_SCENARIO_TYPES: readonly ScenarioTypeDefinition[] = [
  { id: 'project', defaultFlow: 'play', flows: ['play'] },
  { id: 'task', defaultFlow: 'task.define', flows: ['task.define', 'task.run'] },
  { id: 'chat', defaultFlow: 'chat', flows: ['chat'] },
];

export function validateScenarioTypes(
  types: readonly ScenarioTypeDefinition[],
  flowIds: ReadonlySet<string>,
  collector: ProblemCollector,
): void {
  reportDuplicates(
    collector,
    types.map((type) => type.id),
    'Scenario type',
  );
  for (const type of types) {
    const { id } = type;
    if (!flowIds.has(type.defaultFlow)) {
      collector.report(
        id,
        'unknown_flow',
        `Scenario type "${id}" has the unknown default flow "${type.defaultFlow}"`,
      );
    }
    for (const flow of type.flows) {
      if (!flowIds.has(flow)) {
        collector.report(
          id,
          'unknown_flow',
          `Scenario type "${id}" names the unknown flow "${flow}"`,
        );
      }
    }
    if (!type.flows.includes(type.defaultFlow)) {
      collector.report(
        id,
        'default_flow_not_accepted',
        `Scenario type "${id}" has the default flow "${type.defaultFlow}" outside its own flow list`,
      );
    }
  }
}
