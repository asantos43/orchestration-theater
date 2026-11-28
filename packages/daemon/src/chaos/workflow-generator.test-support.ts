// SPDX-License-Identifier: MPL-2.0
// Part of the chaos harness (Phase 11b, P4): test only, excluded from the build of the package.
import { SeededRandom } from './harness.js';

/**
 * A generator of small workflow definitions for the chaos tests of the migration (N295; docs/24 §6).
 * From one seed it makes a PAIR: a version 1.0.0 (a chain of `notify` and `call_tool` steps, with one
 * read-only "gate" step in the middle) and a version 1.1.0 of the same workflow that renames every
 * node, changes what the steps write and inserts one step, and says in `migrate_from` where each node
 * of 1.0.0 goes. The same seed gives the same pair on any machine.
 *
 * The run the test drives is born in 1.0.0, asks its own migration to 1.1.0 from inside the gate step,
 * and is moved at the next safe point: the nodes before the gate run in 1.0.0, the ones after it in
 * 1.1.0. So the pair also says what the world must hold when the run ends, whatever was killed on
 * the way (`expectedWrites`, `expectedMessages`), and in which order the effects happen (`effects`),
 * which is what a test needs to pick "the n-th write" as a point to kill at.
 *
 * Only generic step types, and a chain with no branch: the point is the version change and the
 * journal, not the routing of the steps.
 */

export const GENERATED_WORKFLOW_ID = 'chaos-gen';
export const GENERATED_FROM_VERSION = '1.0.0';
export const GENERATED_TO_VERSION = '1.1.0';
/** The read-only tool of the gate step. A test that runs the pair provides it (and `demo__write`). */
export const GENERATED_GATE_TOOL = 'demo__status';
export const GENERATED_WRITE_TOOL = 'demo__write';

export type GeneratedEffectType = 'demo.write' | 'workflow.notify';

export interface GeneratedEffect {
  /** The `type` of the effect in the journal (the `detail` of an `effects.*` crash point). */
  readonly type: GeneratedEffectType;
  /** The id written, or the message told: unique among the effects of the pair. */
  readonly token: string;
  /** The version the node that does it belongs to. */
  readonly version: typeof GENERATED_FROM_VERSION | typeof GENERATED_TO_VERSION;
  /** Which of its type this is on the path of the run, from 1 (the `nth` of a crash rule). */
  readonly nth: number;
}

type Definition = Record<string, unknown>;

export interface GeneratedWorkflowPair {
  readonly seed: number;
  readonly from: Definition;
  readonly to: Definition;
  /** The node of `from` whose step asks the migration. */
  readonly gate: string;
  /** The node of `from` the run enters when the gate ends, and the node of `to` it is mapped to. */
  readonly landing: { readonly from: string; readonly to: string };
  /** The effects a run migrated at the gate does, in order. */
  readonly effects: readonly GeneratedEffect[];
  /** What the world holds at the end (ids written, in order). */
  readonly expectedWrites: readonly string[];
  /** What the Producer was told at the end (messages, in order). */
  readonly expectedMessages: readonly string[];
}

type Kind = 'notify' | 'write' | 'gate';

const gateStep = (): Definition => ({
  step: 'call_tool',
  params: { tool: GENERATED_GATE_TOOL, args: { id: 'gate' } },
});

function stepOf(kind: 'notify' | 'write', token: string): Definition {
  return kind === 'notify'
    ? { step: 'notify', params: { message: token } }
    : { step: 'call_tool', params: { tool: GENERATED_WRITE_TOOL, args: { id: token } } };
}

/** The pair of a seed. A chain of 4 to 7 nodes; the gate is never the first nor the last node. */
export function generateWorkflowPair(seed: number): GeneratedWorkflowPair {
  const random = new SeededRandom(seed);
  const count = random.int(4, 7);
  const gateIndex = random.int(1, count - 2);
  const kinds: Kind[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index === gateIndex) kinds.push('gate');
    else if (index === count - 1) kinds.push('write');
    else kinds.push(random.pick(['notify', 'write'] as const));
  }
  // At least one notify, so the journal has both types of effect in it.
  if (!kinds.includes('notify')) {
    const candidates = kinds.flatMap((kind, index) =>
      kind === 'write' && index !== count - 1 ? [index] : [],
    );
    kinds[random.pick(candidates)] = 'notify';
  }
  const insertAfter = random.int(gateIndex + 1, count - 1);

  const tag = (index: number, version: 'a' | 'b'): string =>
    `${String(seed)}-${String(index)}${version === 'b' ? 'b' : ''}`;
  const tokenOf = (kind: 'notify' | 'write', index: number, version: 'a' | 'b'): string =>
    `${kind === 'notify' ? 'm' : 'w'}${tag(index, version)}`;

  // ---- 1.0.0: s0 -> s1 -> ... -> done
  const fromNodes: Record<string, Definition> = {};
  const fromEdges: string[] = [];
  for (const [index, kind] of kinds.entries()) {
    fromNodes[`s${String(index)}`] =
      kind === 'gate' ? gateStep() : stepOf(kind, tokenOf(kind, index, 'a'));
    fromEdges.push(
      `s${String(index)} -> ${index === count - 1 ? 'done' : `s${String(index + 1)}`}`,
    );
  }

  // ---- 1.1.0: every node renamed, new tokens, one notify inserted after `insertAfter`
  const toNodes: Record<string, Definition> = {};
  const toEdges: string[] = [];
  const toOrder: string[] = [];
  const mapping: Record<string, string> = {};
  const toEffects: Omit<GeneratedEffect, 'nth'>[] = [];
  for (const [index, kind] of kinds.entries()) {
    const name = `t${String(index)}`;
    mapping[`s${String(index)}`] = name;
    toOrder.push(name);
    if (kind === 'gate') toNodes[name] = gateStep();
    else {
      const token = tokenOf(kind, index, 'b');
      toNodes[name] = stepOf(kind, token);
      if (index > gateIndex) {
        toEffects.push({
          type: kind === 'notify' ? 'workflow.notify' : 'demo.write',
          token,
          version: GENERATED_TO_VERSION,
        });
      }
    }
    if (index === insertAfter) {
      const token = `m${String(seed)}-extra`;
      toNodes.extra = stepOf('notify', token);
      toOrder.push('extra');
      toEffects.push({ type: 'workflow.notify', token, version: GENERATED_TO_VERSION });
    }
  }
  for (const [index, name] of toOrder.entries()) {
    toEdges.push(
      `${name} -> ${index === toOrder.length - 1 ? 'done' : (toOrder[index + 1] ?? 'done')}`,
    );
  }

  const fromEffects: Omit<GeneratedEffect, 'nth'>[] = [];
  for (const [index, kind] of kinds.entries()) {
    if (index >= gateIndex || kind === 'gate') continue;
    fromEffects.push({
      type: kind === 'notify' ? 'workflow.notify' : 'demo.write',
      token: tokenOf(kind, index, 'a'),
      version: GENERATED_FROM_VERSION,
    });
  }
  // The effects of `to` must come in the order of its chain: `toEffects` was built in that order
  // (the inserted node follows the node it was inserted after).
  const seen: Record<GeneratedEffectType, number> = { 'demo.write': 0, 'workflow.notify': 0 };
  const effects: GeneratedEffect[] = [...fromEffects, ...toEffects].map((effect) => {
    seen[effect.type] += 1;
    return { ...effect, nth: seen[effect.type] };
  });

  const base = { id: GENERATED_WORKFLOW_ID, engine: '>=1 <2' };
  return {
    seed,
    from: {
      ...base,
      version: GENERATED_FROM_VERSION,
      nodes: fromNodes,
      edges: fromEdges,
    },
    to: {
      ...base,
      version: GENERATED_TO_VERSION,
      migrate_from: { [GENERATED_FROM_VERSION]: mapping },
      nodes: toNodes,
      edges: toEdges,
    },
    gate: `s${String(gateIndex)}`,
    landing: { from: `s${String(gateIndex + 1)}`, to: `t${String(gateIndex + 1)}` },
    effects,
    expectedWrites: effects.filter((e) => e.type === 'demo.write').map((e) => e.token),
    expectedMessages: effects.filter((e) => e.type === 'workflow.notify').map((e) => e.token),
  };
}
