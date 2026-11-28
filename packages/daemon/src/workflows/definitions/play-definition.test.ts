// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workflowHash } from '@otheater/workflows';
import { describe, expect, it } from 'vitest';
import { PLAY_FLOW_ID, PLAY_FLOW_VERSION } from '../../pipeline/definitions.js';
import { playMachine } from '../../pipeline/machine.js';
import { PLAY_STEP_MODULES, stateOfNode } from '../steps/play/modules.js';
import {
  PLAY_SKIPPABLE_STEPS,
  loadPlayDefinition,
  playDefinition,
  playDefinitionHash,
  playDefinitionMajor,
  playDefinitionProblems,
} from './play-definition.js';
import { PLAY_DEFINITION_YAML } from './play-yaml.js';

/** Phase 11b, P3: `play.yaml` is the 2.0 of the play, checked against the machine state by state. */

const YAML_PATH = fileURLToPath(new URL('./play.yaml', import.meta.url));

describe('play.yaml', () => {
  it('is the text the daemon embeds (play-yaml.ts)', () => {
    expect(PLAY_DEFINITION_YAML).toBe(readFileSync(YAML_PATH, 'utf8'));
  });

  it('validates with the validator of the engine and matches the machine', () => {
    const loaded = loadPlayDefinition();
    expect(loaded.problems).toEqual([]);
    expect(loaded.ok).toBe(true);
  });

  it('is the play, version 2.x, as the machine is version 2', () => {
    const workflow = playDefinition();
    expect(workflow.id).toBe(PLAY_FLOW_ID);
    expect(playDefinitionMajor(workflow)).toBe(PLAY_FLOW_VERSION);
    expect(PLAY_FLOW_VERSION).toBe(2);
  });

  it('has a node for each state of the machine, except NEED and the final ones', () => {
    const states = Object.keys(playDefinition().nodes).map(stateOfNode).sort();
    expect(states).toEqual(
      [
        'PLANNING',
        'CLARIFYING',
        'REVIEWING_PLAN',
        'SCRIPTING',
        'REVIEWING_SCRIPT',
        'EXECUTING',
        'INTEGRATING',
        'CRITIQUING',
        'DECIDING',
        'DELIVERING',
        'AWAITING_PRODUCER',
      ].sort(),
    );
  });

  it('has the step types of the plan, each one wrapped by a module', () => {
    const types = new Set(Object.values(playDefinition().nodes).map((node) => node.step));
    expect([...types].sort()).toEqual(
      [
        'plan',
        'clarify',
        'review',
        'script',
        'execute_dag',
        'integrate',
        'critique',
        'decide',
        'deliver',
        'await_producer',
      ].sort(),
    );
    expect(PLAY_STEP_MODULES.map((module) => module.type).sort()).toEqual([...types].sort());
  });

  it('keeps the optional steps that skip may name', () => {
    expect(PLAY_SKIPPABLE_STEPS).toEqual(['plan_review', 'critique']);
    const edges = JSON.stringify(playDefinition().definition.edges);
    expect(edges).toContain('\\"plan_review\\" in inputs.skip');
    expect(edges).toContain('\\"critique\\" in inputs.skip');
  });

  it('has a hash that does not depend on the order of the keys', async () => {
    const hash = await playDefinitionHash();
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const definition = playDefinition().definition;
    const shuffled = Object.fromEntries(Object.entries(definition).reverse());
    expect(await workflowHash(shuffled as typeof definition)).toBe(hash);
  });
});

/** Every static target of the transitions of a state of the machine. */
function machineTargets(state: string): Set<string> {
  const states = playMachine.config.states as Record<string, { on?: Record<string, unknown> }>;
  const out = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'string') {
      out.add(value);
      return;
    }
    if (typeof value === 'object' && value !== null && 'target' in value) {
      visit(value.target);
    }
  };
  for (const transition of Object.values(states[state]?.on ?? {})) visit(transition);
  return out;
}

describe('play.yaml against the transitions of the machine', () => {
  /** The pairs the definition can go through: the target of each edge and its `on_limit`. */
  const definitionPairs = (): { from: string; to: string }[] =>
    playDefinition().edges.flatMap((edge) => [
      { from: edge.from, to: edge.to },
      ...(edge.onLimit === undefined ? [] : [{ from: edge.from, to: edge.onLimit }]),
    ]);

  const asState = (id: string): string =>
    id === 'done' ? 'DONE' : id === 'cancelled' ? 'CANCELLED' : stateOfNode(id);

  /**
   * [proposta] What the definition says and the machine does not do with a static target: the
   * restart of the plan from EXECUTING. Pinned, so a change on either side shows here.
   */
  const DEFINITION_ONLY = ['EXECUTING -> PLANNING'];

  /**
   * [proposta] What the machine does and the definition leaves out: the restarts of the plan from
   * the critique and from the decision, the base that moved (DELIVERING -> SCRIPTING), the demands
   * all kept from a previous script (REVIEWING_SCRIPT -> INTEGRATING) and the planning that could
   * not submit. They need outputs the step types do not have yet.
   */
  const MACHINE_ONLY = [
    'CRITIQUING -> PLANNING',
    'DECIDING -> PLANNING',
    'DELIVERING -> SCRIPTING',
    'PLANNING -> AWAITING_PRODUCER',
    'REVIEWING_SCRIPT -> INTEGRATING',
  ];

  // The Producer's menu (AWAITING_PRODUCER) is a set of events of the machine, not of static targets.
  const sorted = (items: string[]): string[] => [...new Set(items)].sort();

  it('every edge of the definition is a transition of the machine, but the pinned ones', () => {
    const missing: string[] = [];
    for (const edge of definitionPairs()) {
      const from = asState(edge.from);
      const to = asState(edge.to);
      if (from === 'AWAITING_PRODUCER') continue;
      if (!machineTargets(from).has(to)) missing.push(`${from} -> ${to}`);
    }
    expect(sorted(missing)).toEqual(DEFINITION_ONLY);
  });

  it('every transition of the machine between the states of the play is an edge, but the pinned ones', () => {
    const workflow = playDefinition();
    const edges = new Set(
      definitionPairs().map((edge) => `${asState(edge.from)}>${asState(edge.to)}`),
    );
    const extra: string[] = [];
    for (const node of Object.keys(workflow.nodes)) {
      const from = stateOfNode(node);
      if (from === 'AWAITING_PRODUCER') continue;
      for (const to of machineTargets(from)) {
        if (!edges.has(`${from}>${to}`)) extra.push(`${from} -> ${to}`);
      }
    }
    expect(sorted(extra)).toEqual(MACHINE_ONLY);
  });
});

describe('playDefinitionProblems', () => {
  function problemsOfText(text: string): string[] {
    const loaded = loadPlayDefinition(text);
    return loaded.ok ? [] : [...loaded.problems];
  }

  it('says why a text that is not a definition is refused', () => {
    expect(problemsOfText('id: [')[0]).toMatch(/^play definition/);
    expect(problemsOfText('id: play')[0]).toMatch(/^play definition/);
  });

  it('refuses another id, another major version and a missing node', () => {
    const other = PLAY_DEFINITION_YAML.replace(/^id: play$/m, 'id: not-play').replace(
      /^version: 2\.0\.0$/m,
      'version: 3.0.0',
    );
    const problems = problemsOfText(other);
    expect(problems.join('\n')).toMatch(/the id is "not-play"/);
    expect(problems.join('\n')).toMatch(/version 3\.0\.0 is major 3, the machine is 2/);
  });

  it('refuses a definition without the skip input', () => {
    const text = PLAY_DEFINITION_YAML.replace(
      /^inputs:\n {2}skip:.*$/m,
      'inputs:\n  other: { type: string, default: x }',
    );
    const problems = problemsOfText(text);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('is empty for the official definition', () => {
    expect(playDefinitionProblems(playDefinition())).toEqual([]);
  });
});
