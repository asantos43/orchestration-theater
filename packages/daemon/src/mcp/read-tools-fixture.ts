// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of the read tools only (excluded from the build of the package).
import { contractKey, type Store } from '@otheater/core';

/**
 * Two scenarios: `s1` with the plays `p1` and `p2`, `s2` with `p3`. The blackboard of `p1` has the
 * key `script` in two versions and the contract `c1` in two versions; `p2` has its own `script`.
 * Decisions: `D-own` (play `p1`), `D-scenario` (scenario `s1`, no play), `D-sibling` (play `p2`)
 * and `D-foreign` (scenario `s2`).
 */
export async function seedReadTools(store: Store): Promise<void> {
  for (const scenarioId of ['s1', 's2']) {
    await store.scenarios.create({
      id: scenarioId,
      kind: 'project',
      flowId: 'play.default',
      name: scenarioId,
      folder: `/work/${scenarioId}`,
      baseBranch: 'main',
    });
  }
  for (const [id, scenarioId] of [
    ['p1', 's1'],
    ['p2', 's1'],
    ['p3', 's2'],
  ] as const) {
    await store.plays.create({
      id,
      scenarioId,
      need: 'need',
      flowId: 'play.default',
      flowVersion: 1,
      state: 'EXECUTING',
      counters: {},
    });
  }
  await store.blackboard.put({
    playId: 'p1',
    key: 'script',
    value: { v: 1 },
    author: 'scriptwriter',
  });
  await store.blackboard.put({
    playId: 'p1',
    key: 'script',
    value: { v: 2 },
    author: 'scriptwriter',
  });
  await store.blackboard.put({ playId: 'p1', key: contractKey('c1'), value: { fn: 'f()' } });
  await store.blackboard.put({ playId: 'p1', key: contractKey('c1'), value: { fn: 'f(a)' } });
  await store.blackboard.put({ playId: 'p2', key: 'script', value: { other: 'play' } });
  await store.decisions.create({
    id: 'D-own',
    scenarioId: 's1',
    playId: 'p1',
    kind: 'script_review',
    input: { q: 'ok?' },
  });
  await store.decisions.create({
    id: 'D-scenario',
    scenarioId: 's1',
    playId: null,
    kind: 'plan_review',
    input: {},
  });
  await store.decisions.create({
    id: 'D-sibling',
    scenarioId: 's1',
    playId: 'p2',
    kind: 'script_review',
    input: {},
  });
  await store.decisions.create({
    id: 'D-foreign',
    scenarioId: 's2',
    playId: null,
    kind: 'plan_review',
    input: {},
  });
}
