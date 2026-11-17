// SPDX-License-Identifier: MPL-2.0
import { reportDuplicates, type ProblemCollector } from './problems.js';

/**
 * A flow of the registry (architecture 5.18): registered by id and version. This is only the
 * descriptor the start-up validates (the roles and the tools the flow uses); the XState machine
 * itself comes with the step that builds it.
 */
export interface FlowDefinition {
  /** Dotted or snake-case lowercase id (`play`, `task.define`). */
  readonly id: string;
  /** Version of the flow, an integer >= 1. A change of the machine bumps it. */
  readonly version: number;
  /** Roles the flow runs. */
  readonly roles: readonly string[];
  /** Tools the flow relies on, by name. */
  readonly tools: readonly string[];
}

/** Pattern of a flow id. */
export const FLOW_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/**
 * [proposta] The four flows of version 1: the play (5.4, the default flow) and `task.define`,
 * `task.run` and `chat` (5.20). The role and tool lists are the ones the architecture names for
 * each; they get refined as the machines are built.
 */
export const OFFICIAL_FLOWS: readonly FlowDefinition[] = [
  {
    id: 'play',
    version: 1,
    roles: ['director', 'author', 'reviewer', 'scriptwriter', 'actor', 'critic'],
    tools: [
      'next_action',
      'status',
      'decide',
      'ask_producer',
      'open_pr',
      'submit_plan',
      'submit_plan_review',
      'submit_script',
      'submit_script_review',
      'submit_critique',
      'run_tests',
      'git_commit',
      'view_diff',
      'submit',
    ],
  },
  {
    id: 'task.define',
    version: 1,
    roles: ['director', 'author', 'reviewer'],
    tools: ['next_action', 'decide', 'ask_producer', 'submit_plan', 'submit_plan_review'],
  },
  {
    id: 'task.run',
    version: 1,
    roles: ['director', 'actor'],
    tools: ['next_action', 'decide', 'run_task', 'submit'],
  },
  {
    id: 'chat',
    version: 1,
    roles: ['director', 'consultant'],
    tools: ['ask_producer', 'consult', 'submit'],
  },
];

export function validateFlows(
  flows: readonly FlowDefinition[],
  roleIds: ReadonlySet<string>,
  toolNames: ReadonlySet<string>,
  collector: ProblemCollector,
): void {
  reportDuplicates(
    collector,
    flows.map((flow) => flow.id),
    'Flow',
  );
  for (const flow of flows) {
    const { id } = flow;
    if (!FLOW_ID_PATTERN.test(id)) {
      collector.report(id, 'invalid_name', `Flow id "${id}" is not a lowercase dotted id`);
    }
    if (!Number.isInteger(flow.version) || flow.version < 1) {
      collector.report(
        id,
        'invalid_version',
        `Flow "${id}" has version ${String(flow.version)}; it must be an integer >= 1`,
      );
    }
    if (flow.roles.length === 0) {
      collector.report(id, 'empty_list', `Flow "${id}" names no role`);
    }
    for (const role of flow.roles) {
      if (!roleIds.has(role)) {
        collector.report(id, 'unknown_role', `Flow "${id}" names the unknown role "${role}"`);
      }
    }
    for (const tool of flow.tools) {
      if (!toolNames.has(tool)) {
        collector.report(id, 'unknown_tool', `Flow "${id}" names the unknown tool "${tool}"`);
      }
    }
  }
}
