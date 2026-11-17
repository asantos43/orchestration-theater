// SPDX-License-Identifier: MPL-2.0
import type { Contract, Demand, Script } from './schema.js';

/** Test fixtures for the script tests: a ready demand and a script around it. */
export function contract(id: string): Contract {
  return { id, kind: 'file', title: `Contract ${id}`, description: `What ${id} promises.` };
}

/** A demand that passes every readiness rule, with `overrides` on top. */
export function demand(id: string, overrides: Partial<Demand> = {}): Demand {
  return {
    id,
    title: `Demand ${id}`,
    description: `Implement ${id}.`,
    dependsOn: [],
    contract: { inputs: [], outputs: [`c-${id}`] },
    expectedFiles: [`src/${id}.ts`],
    complexity: 'low',
    timeoutMin: 20,
    acceptanceCriteria: [`${id} works`],
    verify: [{ name: 'tests', command: 'pnpm', args: ['vitest', 'run', id] }],
    ...overrides,
  };
}

/** A script with the given demands and one contract `c-<id>` for each of them (plus `extra`). */
export function script(demands: Demand[], extraContracts: string[] = []): Script {
  const ids = new Set([...demands.map((d) => `c-${d.id}`), ...extraContracts]);
  return { contracts: [...ids].map(contract), demands };
}

/** Narrows `T | undefined` in tests without a non-null assertion. */
export function need<T>(value: T | undefined, what = 'value'): T {
  if (value === undefined) throw new Error(`Expected ${what} to be defined`);
  return value;
}
