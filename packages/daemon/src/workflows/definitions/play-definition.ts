// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { validateWorkflowYaml, workflowHash, type ValidWorkflow } from '@otheater/workflows';
import {
  COUNTER_KEYS,
  PLAY_FLOW_ID,
  PLAY_FLOW_VERSION,
  FINAL_PLAY_STATES,
  PLAY_STATES,
} from '../../pipeline/definitions.js';
import { playStepModule, stateOfNode } from '../steps/play/modules.js';
import { PLAY_DEFINITION_YAML } from './play-yaml.js';

/**
 * The `play` 2.0 as the daemon loads it (plan of Phase 11b, P3; decision D2/N311). The text is
 * `play.yaml` (embedded, see `play-yaml.ts`); it is read by the validator of `@otheater/workflows`
 * with the step registry of the engine, so a definition that does not validate stops the daemon at
 * start-up (`assertPlayFlowLinked`). The machine of the play is the one of `pipeline/machine.ts`:
 * the definition is the descriptor it is checked against, state by state. [proposta]
 */

/** The optional steps of the official play that `skip` may name (`flows.<id>`, N243). */
export const PLAY_SKIPPABLE_STEPS = ['plan_review', 'critique'] as const;

/** The counter the definition adds to the ones of the machine: it only bounds the Producer's menu. */
export const PLAY_DEFINITION_ONLY_LIMITS = ['producer_rounds'] as const;

export type PlayDefinitionLoad =
  | { readonly ok: true; readonly workflow: ValidWorkflow; readonly problems: readonly [] }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Validates a text as the play definition: the schema, the validator and what the machine needs. */
export function loadPlayDefinition(text: string = PLAY_DEFINITION_YAML): PlayDefinitionLoad {
  const result = validateWorkflowYaml(text);
  if (result.stage === 'yaml') {
    return {
      ok: false,
      problems: result.errors.map((error) => `play definition: ${error.message}`),
    };
  }
  if (!result.ok) {
    return {
      ok: false,
      problems: result.errors.map((error) => `play definition ${error.path}: ${error.message}`),
    };
  }
  const problems = playDefinitionProblems(result.workflow);
  return problems.length === 0
    ? { ok: true, workflow: result.workflow, problems: [] }
    : { ok: false, problems };
}

let cached: ValidWorkflow | undefined;
let cachedHash: Promise<string> | undefined;

/** The definition of the play; it throws `InvalidInput` listing what is wrong with it. */
export function playDefinition(): ValidWorkflow {
  if (cached !== undefined) return cached;
  const loaded = loadPlayDefinition();
  if (!loaded.ok) {
    throw new InvalidInput(`The play definition is not valid:\n${loaded.problems.join('\n')}`);
  }
  cached = loaded.workflow;
  return cached;
}

/** `sha256:<hex>` of the canonical definition (`workflowHash`): stable across the order of the keys. */
export function playDefinitionHash(): Promise<string> {
  cachedHash ??= workflowHash(playDefinition().definition);
  return cachedHash;
}

/** The part of the version of the definition that the machine's version follows: its major. */
export function playDefinitionMajor(workflow: ValidWorkflow): number {
  return Number.parseInt(workflow.version.split('.')[0] ?? '', 10);
}

/**
 * What a definition has that the machine of `pipeline/machine.ts` does not (or the other way
 * round): the id and the major version, the nodes against the states, the step type of each node
 * against the module that wraps the state, the start, the counters and the `skip` input. Empty
 * when they agree.
 */
export function playDefinitionProblems(workflow: ValidWorkflow): string[] {
  const problems: string[] = [];
  const at = (text: string): void => {
    problems.push(`play definition: ${text}`);
  };
  if (workflow.id !== PLAY_FLOW_ID) at(`the id is "${workflow.id}", not "${PLAY_FLOW_ID}"`);
  const major = playDefinitionMajor(workflow);
  if (major !== PLAY_FLOW_VERSION) {
    at(
      `version ${workflow.version} is major ${String(major)}, the machine is ${String(PLAY_FLOW_VERSION)}`,
    );
  }
  // NEED is folded into the start of the definition; the final states are the terminals.
  const wanted = PLAY_STATES.filter(
    (state) => state !== 'NEED' && !(FINAL_PLAY_STATES as readonly string[]).includes(state),
  );
  const states = new Set(Object.keys(workflow.nodes).map(stateOfNode));
  for (const state of wanted) {
    if (!states.has(state))
      at(`the machine has the state ${state} and the definition has no node for it`);
  }
  for (const [id, node] of Object.entries(workflow.nodes)) {
    const state = stateOfNode(id);
    if (!(wanted as readonly string[]).includes(state)) {
      at(`the node "${id}" is not a state of the machine`);
      continue;
    }
    const module = playStepModule(node.step);
    if (module === undefined)
      at(`the node "${id}" uses the step type ${node.step}, which is not of the play`);
    else if (!module.states.includes(state)) {
      at(`the step type ${node.step} does not stand for the state ${state} (node "${id}")`);
    }
  }
  if (stateOfNode(workflow.start) !== 'PLANNING') {
    at(`it starts at "${workflow.start}", and the machine goes from NEED to PLANNING`);
  }
  const known: readonly string[] = [...COUNTER_KEYS, ...PLAY_DEFINITION_ONLY_LIMITS];
  for (const counter of Object.keys(workflow.counters)) {
    if (!known.includes(counter)) at(`the counter "${counter}" is not one of the machine`);
  }
  const skip = workflow.definition.inputs?.skip;
  if (skip === undefined || typeof skip.type !== 'object' || !('list' in skip.type)) {
    at('the input "skip" (a list) is missing');
  }
  return problems;
}
