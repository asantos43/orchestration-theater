// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '../errors.js';
import type { Script } from './schema.js';

/**
 * Graph helpers over the `dependsOn` edges of a script. Pure and deterministic: whenever there is a
 * choice, the order of `script.demands` decides.
 *
 * They tolerate an invalid script (duplicate ids, unknown dependencies, cycles) so that
 * `validateScript` can describe every problem; `topologicalLayers` is the strict one.
 */

/**
 * Direct dependencies per demand id, in script order. Unknown ids are dropped and repeated ones
 * collapsed. With duplicate demand ids the first occurrence wins.
 */
export function dependencyGraph(script: Pick<Script, 'demands'>): Map<string, string[]> {
  const known = new Set(script.demands.map((d) => d.id));
  const graph = new Map<string, string[]>();
  for (const demand of script.demands) {
    if (graph.has(demand.id)) continue;
    graph.set(
      demand.id,
      [...new Set(demand.dependsOn)].filter((id) => known.has(id)),
    );
  }
  return graph;
}

function depsOf(graph: ReadonlyMap<string, readonly string[]>, id: string): readonly string[] {
  return graph.get(id) ?? [];
}

/**
 * Cycles of the graph, each as a closed path (`['a', 'b', 'a']` means a -> b -> a, where "->" reads
 * "depends on"). One cycle per round of peeling, found in script order, until none is left.
 */
export function findDependencyCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const remaining = new Set(graph.keys());
  const cycles: string[][] = [];
  for (;;) {
    // Peel what can be ordered: a node whose dependencies are all outside `remaining`.
    let peeled = true;
    while (peeled) {
      peeled = false;
      for (const id of [...remaining]) {
        if (depsOf(graph, id).every((dep) => !remaining.has(dep))) {
          remaining.delete(id);
          peeled = true;
        }
      }
    }
    const start = remaining.values().next();
    if (start.done === true) return cycles;
    // Every remaining node has a dependency in `remaining`, so a walk must eventually repeat a node.
    const walk: string[] = [];
    let current: string | undefined = start.value;
    while (current !== undefined && !walk.includes(current)) {
      walk.push(current);
      current = depsOf(graph, current).find((dep) => remaining.has(dep));
    }
    if (current === undefined) return cycles; // unreachable: see above
    const cycle = walk.slice(walk.indexOf(current));
    cycles.push([...cycle, current]);
    for (const id of cycle) remaining.delete(id);
  }
}

/**
 * For each demand id, every demand it depends on directly or transitively (never itself, unless it
 * sits on a cycle).
 */
export function transitiveDependencies(
  graph: ReadonlyMap<string, readonly string[]>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const id of graph.keys()) {
    const seen = new Set<string>();
    const stack = [...depsOf(graph, id)];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...depsOf(graph, next));
    }
    result.set(id, seen);
  }
  return result;
}

/**
 * The parallel layers of the DAG: layer 0 has the demands with no dependency, and every other demand
 * sits one layer after the deepest of its dependencies. Demands in the same layer never depend on
 * each other, so the Director can release a whole layer at once (limited by admission control, 5.9).
 * Inside a layer the order is the script order; the result is the same for the same script.
 *
 * Throws `InvalidInput` for a script with duplicate ids, unknown dependencies or a cycle: run
 * `validateScript` first.
 */
export function topologicalLayers(script: Pick<Script, 'demands'>): string[][] {
  const ids = script.demands.map((d) => d.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) {
    throw new InvalidInput(`Script has two demands with the id "${duplicate}".`);
  }
  const known = new Set(ids);
  for (const demand of script.demands) {
    const unknown = demand.dependsOn.find((dep) => !known.has(dep));
    if (unknown !== undefined) {
      throw new InvalidInput(
        `Demand "${demand.id}" depends on "${unknown}", which does not exist.`,
      );
    }
  }
  const graph = dependencyGraph(script);
  const placed = new Set<string>();
  const layers: string[][] = [];
  while (placed.size < ids.length) {
    const layer = ids.filter(
      (id) => !placed.has(id) && depsOf(graph, id).every((dep) => placed.has(dep)),
    );
    if (layer.length === 0) {
      const cycle = findDependencyCycles(graph)[0] ?? [];
      throw new InvalidInput(`Script has a dependency cycle: ${cycle.join(' -> ')}.`);
    }
    for (const id of layer) placed.add(id);
    layers.push(layer);
  }
  return layers;
}
