// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { InvalidInput } from '../errors.js';
import { dependencyGraph, findDependencyCycles, topologicalLayers } from './dag.js';
import { demand, need, script } from './fixtures.js';
import type { Demand, Script } from './schema.js';
import { validateScript } from './validate.js';

describe('topologicalLayers', () => {
  it('camada 0 sem dependencias, depois cada demanda uma camada apos a mais funda das suas', () => {
    const s = script([
      demand('d', { dependsOn: ['b', 'c'] }),
      demand('c', { dependsOn: ['a'] }),
      demand('b'),
      demand('a'),
      demand('e', { dependsOn: ['d'] }),
    ]);
    expect(topologicalLayers(s)).toEqual([['b', 'a'], ['c'], ['d'], ['e']]);
  });

  it('dentro da camada a ordem e a do roteiro, e o resultado se repete', () => {
    const s = script([demand('z'), demand('m'), demand('a')]);
    expect(topologicalLayers(s)).toEqual([['z', 'm', 'a']]);
    expect(topologicalLayers(s)).toEqual(topologicalLayers(s));
  });

  it('roteiro vazio nao tem camadas', () => {
    expect(topologicalLayers(script([]))).toEqual([]);
  });

  it('dependencia repetida nao atrapalha', () => {
    const s = script([demand('a'), demand('b', { dependsOn: ['a', 'a'] })]);
    expect(topologicalLayers(s)).toEqual([['a'], ['b']]);
  });

  it('lanca InvalidInput com ciclo, dependencia desconhecida e id repetido', () => {
    const cyclic = script([demand('a', { dependsOn: ['b'] }), demand('b', { dependsOn: ['a'] })]);
    expect(() => topologicalLayers(cyclic)).toThrow(InvalidInput);
    expect(() => topologicalLayers(cyclic)).toThrow('a -> b -> a');
    expect(() => topologicalLayers(script([demand('a', { dependsOn: ['x'] })]))).toThrow(
      'Demand "a" depends on "x", which does not exist.',
    );
    expect(() => topologicalLayers(script([demand('a'), demand('a')]))).toThrow(
      'two demands with the id "a"',
    );
  });
});

describe('findDependencyCycles', () => {
  it('nao acha ciclo em um DAG, mesmo com losango', () => {
    const graph = dependencyGraph(
      script([
        demand('a'),
        demand('b', { dependsOn: ['a'] }),
        demand('c', { dependsOn: ['a'] }),
        demand('d', { dependsOn: ['b', 'c'] }),
      ]),
    );
    expect(findDependencyCycles(graph)).toEqual([]);
  });

  it('mostra so o ciclo, nao as demandas que dependem dele', () => {
    const graph = dependencyGraph(
      script([
        demand('a', { dependsOn: ['b'] }),
        demand('b', { dependsOn: ['a'] }),
        demand('c', { dependsOn: ['a'] }),
      ]),
    );
    expect(findDependencyCycles(graph)).toEqual([['a', 'b', 'a']]);
  });
});

// -- property test -------------------------------------------------------------------------------

/** mulberry32: a tiny PRNG with a 32-bit seed, so the "random" scripts are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomScript(rand: () => number): Script {
  const int = (n: number) => Math.floor(rand() * n);
  const n = 1 + int(10);
  const ids = Array.from({ length: n }, (_, i) => `d${String(i)}`);
  // Mostly a real DAG over a random permutation; sometimes an edge in any direction, which
  // can create cycles or self-dependencies.
  const order = [...ids].sort(() => rand() - 0.5);
  const pool = Array.from({ length: 4 + int(8) }, (_, i) => `src/f${String(i)}.ts`);
  const demands: Demand[] = ids.map((id) => {
    const position = order.indexOf(id);
    const dependsOn: string[] = [];
    for (const other of ids) {
      const earlier = order.indexOf(other) < position;
      const chance = earlier ? 0.3 : 0.03;
      if (rand() < chance) dependsOn.push(other);
    }
    const expectedFiles = Array.from({ length: 1 + int(3) }, () => need(pool[int(pool.length)]));
    return demand(id, { dependsOn, expectedFiles });
  });
  // Shuffle the script order too, so dependencies often point forward in the array.
  demands.sort(() => rand() - 0.5);
  return script(demands);
}

/** Reference answer, written differently from the code under test: Floyd-Warshall reachability. */
function reachability(s: Script): Map<string, Set<string>> {
  const ids = s.demands.map((d) => d.id);
  const reach = new Set<string>();
  for (const d of s.demands) for (const dep of d.dependsOn) reach.add(`${d.id}>${dep}`);
  for (const k of ids)
    for (const i of ids)
      for (const j of ids)
        if (reach.has(`${i}>${k}`) && reach.has(`${k}>${j}`)) reach.add(`${i}>${j}`);
  return new Map(ids.map((i) => [i, new Set(ids.filter((j) => reach.has(`${i}>${j}`)))]));
}

describe('propriedades sobre roteiros aleatorios (PRNG com semente fixa)', () => {
  const cases = 600;
  const stats = { valid: 0, cycle: 0, overlap: 0 };

  it('a ordem respeita dependsOn e demandas da mesma camada nao dividem arquivos quando o roteiro e valido', () => {
    const rand = mulberry32(0x0badc0de);
    for (let i = 0; i < cases; i++) {
      const s = randomScript(rand);
      const issues = validateScript(s);
      const codes = new Set(issues.map((x) => x.code));
      const reach = reachability(s);
      const hasCycle = s.demands.some((d) => need(reach.get(d.id)).has(d.id));

      // The validator agrees with the reference on cycles.
      expect(codes.has('DEPENDENCY_CYCLE'), `case ${String(i)}`).toBe(hasCycle);

      // ... and on parallel overlap (compared by the exact path: the pool has no directories).
      let expectedOverlap = false;
      for (const a of s.demands) {
        for (const b of s.demands) {
          if (a.id >= b.id) continue;
          if (need(reach.get(a.id)).has(b.id) || need(reach.get(b.id)).has(a.id)) continue;
          if (a.expectedFiles.some((f) => b.expectedFiles.includes(f))) expectedOverlap = true;
        }
      }
      expect(codes.has('PARALLEL_FILE_OVERLAP'), `case ${String(i)}`).toBe(expectedOverlap);

      if (hasCycle) {
        stats.cycle++;
        expect(() => topologicalLayers(s)).toThrow(InvalidInput);
        continue;
      }

      // Any acyclic script has layers, valid or not, and they respect dependsOn.
      const layers = topologicalLayers(s);
      const layerOf = new Map<string, number>();
      for (const [index, layer] of layers.entries()) {
        for (const id of layer) layerOf.set(id, index);
      }
      expect(layerOf.size, `case ${String(i)}`).toBe(s.demands.length);
      for (const d of s.demands) {
        for (const dep of d.dependsOn) {
          expect(need(layerOf.get(dep)), `case ${String(i)}: ${dep} before ${d.id}`).toBeLessThan(
            need(layerOf.get(d.id)),
          );
        }
        // Tight layering: a demand sits right after its deepest dependency.
        const depth =
          d.dependsOn.length === 0
            ? 0
            : Math.max(...d.dependsOn.map((x) => need(layerOf.get(x)))) + 1;
        expect(layerOf.get(d.id), `case ${String(i)}: ${d.id} depth`).toBe(depth);
      }
      // Stable order inside a layer: script order.
      const position = new Map(s.demands.map((d, index) => [d.id, index]));
      for (const layer of layers) {
        const positions = layer.map((id) => need(position.get(id)));
        expect(positions, `case ${String(i)}`).toEqual([...positions].sort((x, y) => x - y));
      }
      expect(topologicalLayers(s)).toEqual(layers);

      if (issues.length === 0) {
        stats.valid++;
        for (const layer of layers) {
          const seen = new Set<string>();
          for (const id of layer) {
            // A demand may list the same file twice; two demands of the layer may not share one.
            const own = new Set(need(s.demands.find((d) => d.id === id)).expectedFiles);
            for (const f of own) {
              expect(seen.has(f), `case ${String(i)}: ${f} shared inside a layer`).toBe(false);
              seen.add(f);
            }
          }
        }
      } else if (codes.has('PARALLEL_FILE_OVERLAP')) {
        stats.overlap++;
      }
    }
    // The generator is useful only if it hits all three situations.
    expect(stats.valid).toBeGreaterThan(30);
    expect(stats.cycle).toBeGreaterThan(30);
    expect(stats.overlap).toBeGreaterThan(30);
  });
});
