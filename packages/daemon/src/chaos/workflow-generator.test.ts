// SPDX-License-Identifier: MPL-2.0
import { validateWorkflow, type ValidWorkflow } from '@otheater/workflows';
import { afterEach, describe, expect, it } from 'vitest';
import { mappingOf } from '../workflows/migrate.js';
import {
  makeRuntime,
  makeWorld,
  publish,
  SCENARIO,
  type World,
} from '../workflows/runtime.test-support.js';
import type { WorkflowRuntime } from '../workflows/runtime.js';
import {
  GENERATED_FROM_VERSION,
  GENERATED_TO_VERSION,
  GENERATED_WORKFLOW_ID,
  generateWorkflowPair,
  type GeneratedWorkflowPair,
} from './workflow-generator.test-support.js';

const SEEDS = Array.from({ length: 40 }, (_, index) => index * 7919 + 1);

function valid(definition: Record<string, unknown>): ValidWorkflow {
  const result = validateWorkflow(definition);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.workflow;
}

describe('generateWorkflowPair', () => {
  it('gives the same pair for the same seed, and other pairs for other seeds', () => {
    expect(generateWorkflowPair(12345)).toEqual(generateWorkflowPair(12345));
    const shapes = new Set(
      SEEDS.map((seed) => JSON.stringify(generateWorkflowPair(seed).from.edges)),
    );
    expect(shapes.size).toBeGreaterThan(1);
    const writes = new Set(SEEDS.map((seed) => generateWorkflowPair(seed).expectedWrites.length));
    expect(writes.size).toBeGreaterThan(1);
  });

  it.each(SEEDS)(
    'seed %i: both versions are valid and the second maps every node of the first',
    (seed) => {
      const pair = generateWorkflowPair(seed);
      const from = valid(pair.from);
      const to = valid(pair.to);
      expect([from.id, from.version]).toEqual([GENERATED_WORKFLOW_ID, GENERATED_FROM_VERSION]);
      expect([to.id, to.version]).toEqual([GENERATED_WORKFLOW_ID, GENERATED_TO_VERSION]);
      expect(Object.keys(to.nodes)).toHaveLength(Object.keys(from.nodes).length + 1);

      const mapping = mappingOf(from, to);
      expect(mapping.ok).toBe(true);
      if (!mapping.ok) return;
      expect(Object.keys(mapping.map).sort()).toEqual(Object.keys(from.nodes).sort());
      expect(mapping.map[pair.landing.from]).toBe(pair.landing.to);
      expect(from.nodes[pair.gate]).toBeDefined();
    },
  );

  it.each(SEEDS)(
    'seed %i: the effects are unique, counted by type, and both types appear',
    (seed) => {
      const pair = generateWorkflowPair(seed);
      const tokens = pair.effects.map((effect) => effect.token);
      expect(new Set(tokens).size).toBe(tokens.length);
      for (const type of ['demo.write', 'workflow.notify'] as const) {
        const ofType = pair.effects.filter((effect) => effect.type === type);
        expect(ofType.map((effect) => effect.nth)).toEqual(ofType.map((_, index) => index + 1));
      }
      expect(pair.expectedWrites.length).toBeGreaterThan(0);
      expect(pair.expectedMessages.length).toBeGreaterThan(0);
      // The last node of the chain is a write of the new version.
      expect(pair.effects.at(-1)?.version).toBe(GENERATED_TO_VERSION);
    },
  );
});

/**
 * The expectations of the generator are the ones of the engine: a run of the pair on the real runtime
 * (in memory), migrated from inside the gate, leaves exactly what `expectedWrites` and
 * `expectedMessages` say. The chaos test relies on this, and so runs it in `pnpm test`, not only
 * over the build.
 */
const stoppers: WorkflowRuntime[] = [];
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((runtime) => runtime.stop()));
});

async function runPair(pair: GeneratedWorkflowPair): Promise<World> {
  const world = makeWorld();
  const runtime = makeRuntime(world);
  stoppers.push(runtime);
  publish(world, pair.from as { id: string; version: string });
  publish(world, pair.to as { id: string; version: string });
  const original = world.tools.call.bind(world.tools);
  world.tools.call = async (project, ref, args) => {
    if (ref.tool === 'status') await runtime.requestMigration('run-1', GENERATED_TO_VERSION);
    return original(project, ref, args);
  };
  const started = await runtime.start({
    runId: 'run-1',
    scenarioId: SCENARIO,
    definition: pair.from,
  });
  expect(started.ok).toBe(true);
  await runtime.idle();
  return world;
}

describe('a generated pair on the engine', () => {
  it.each(SEEDS.slice(0, 12))(
    'seed %i: ends in the new version with what the pair says',
    async (seed) => {
      const pair = generateWorkflowPair(seed);
      const world = await runPair(pair);

      const play = await world.store.plays.get('run-1');
      expect(play?.state).toBe('done');
      const saved = play?.snapshot as unknown as {
        workflow: { version: string };
        born: { version: string };
      };
      expect(saved.born.version).toBe(GENERATED_FROM_VERSION);
      expect(saved.workflow.version).toBe(GENERATED_TO_VERSION);

      expect(world.tools.world).toEqual(pair.expectedWrites);
      const events = await world.store.events.readFrom(0, 10_000);
      const told = events
        .filter((event) => event.type === 'workflow.notified')
        .map((event) => (event.payload as { message: string }).message);
      expect(told).toEqual(pair.expectedMessages);
      const migrated = events.filter((event) => event.type === 'workflow.migrated');
      expect(migrated).toHaveLength(1);
      expect(migrated[0]?.payload).toMatchObject({
        fromState: pair.landing.from,
        toState: pair.landing.to,
      });
    },
  );
});
