// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  FakeClock,
  FakeCodeHost,
  FakeProcessLauncher,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { openComposedStore } from '../compose.js';
import { createSilentLogger } from '../logger.js';
import { reconcileBeforeResume } from '../recovery/reconcile.js';
import { effectKey, runEffect, type EffectSpec } from '../workspace/effects.js';
import { makeWorkspaceRig } from '../workspace/workspace-fixture.js';
import {
  armFaults,
  CRASH_POINT_NAMES,
  disarmFaults,
  type CrashInfo,
  type CrashPointName,
} from './crash-points.js';

/**
 * One test per crash point of the catalogue (Phase 11, P1): each arms a rule for the point, runs the
 * code it sits in with the kill replaced by a recorder, and asserts the rule fired there. The last
 * test fails when a point is added to `CRASH_POINT_NAMES` without a test here.
 */

afterAll(disposeTestGitIsolation);
afterEach(disarmFaults);

const triggered = new Set<string>();

function arm(
  point: CrashPointName,
  detail?: string,
  also?: (info: CrashInfo) => Promise<void>,
): CrashInfo[] {
  const infos: CrashInfo[] = [];
  armFaults(
    { crash: [{ point, ...(detail === undefined ? {} : { detail }), nth: 1 }], fail: [] },
    {
      onCrash: async (info) => {
        infos.push(info);
        triggered.add(info.point);
        await also?.(info);
      },
    },
  );
  return infos;
}

function spec(overrides: Partial<EffectSpec> = {}): EffectSpec {
  return {
    key: 'k',
    type: 'git_commit',
    target: 't',
    params: {},
    execute: () => Promise.resolve({ sha: 'abc' }),
    verify: () => Promise.resolve({ verdict: 'done', result: { sha: 'abc' } }),
    ...overrides,
  };
}

function memory(): InMemoryStore {
  return new InMemoryStore({ clock: new FakeClock() });
}

describe('effects.* (the boundaries of runEffect)', () => {
  it.each([
    'effects.before_intend',
    'effects.after_intend',
    'effects.after_execute',
    'effects.after_resolve',
  ] as const)('%s fires with the effect type as detail', async (point) => {
    const infos = arm(point);
    const store = memory();
    await runEffect(store.sideEffects, spec());
    expect(infos).toEqual([{ point, detail: 'git_commit', hit: 1 }]);
  });

  it('effects.before_intend fires before the intent is written', async () => {
    let seen: unknown = 'unset';
    const store = memory();
    arm('effects.before_intend', undefined, async () => {
      seen = await store.sideEffects.get('k');
    });
    await runEffect(store.sideEffects, spec());
    expect(seen).toBeUndefined();
  });

  it('effects.after_execute fires with the effect done in the world and the record still pending', async () => {
    let executed = false;
    let state: string | undefined;
    const store = memory();
    arm('effects.after_execute', undefined, async () => {
      state = (await store.sideEffects.get('k'))?.state;
    });
    await runEffect(
      store.sideEffects,
      spec({
        execute: () => {
          executed = true;
          return Promise.resolve({});
        },
      }),
    );
    expect(executed).toBe(true);
    expect(state).toBe('pending');
  });

  it('effects.after_verify fires when the verifier found the effect done, before it is resolved', async () => {
    const store = memory();
    await store.sideEffects.intend({
      idempotencyKey: effectKey('k', 1),
      type: 'git_commit',
      target: 't',
    });
    let state: string | undefined;
    arm('effects.after_verify', 'git_commit', async () => {
      state = (await store.sideEffects.get('k'))?.state;
    });
    const outcome = await runEffect(store.sideEffects, spec());
    expect(outcome).toMatchObject({ kind: 'done', origin: 'verified' });
    expect(state).toBe('pending');
  });
});

describe('reconcile.* (the steps of the reconciliation)', () => {
  async function rigOf() {
    const clock = new FakeClock();
    const store = new InMemoryStore({ clock });
    const fake = new FakeCodeHost({ clock });
    const workspace = await makeWorkspaceRig({ store, codeHost: fake });
    const deps = {
      store,
      vcs: workspace.vcs,
      codeHost: fake,
      launcher: new FakeProcessLauncher(),
      logger: createSilentLogger(),
    };
    return { store, fake, workspace, deps };
  }

  it.each([
    'reconcile.before_orphans',
    'reconcile.after_orphans',
    'reconcile.before_worktrees',
    'reconcile.after_worktrees',
    'reconcile.before_effects',
    'reconcile.after_effects',
  ] as const)('%s fires once per reconciliation', async (point) => {
    const rig = await rigOf();
    try {
      const infos = arm(point);
      await reconcileBeforeResume(rig.deps);
      expect(infos).toEqual([{ point, detail: undefined, hit: 1 }]);
    } finally {
      await rig.workspace.dispose();
    }
  });

  it('reconcile.before_effect_resolve fires per effect with a verdict, with its type as detail', async () => {
    const rig = await rigOf();
    try {
      const branch = 'play/play-1/delivery';
      await rig.store.scenarios.create({
        id: 'scenario-1',
        kind: 'project',
        flowId: 'play',
        name: 'scenario',
        folder: rig.workspace.repo,
        baseBranch: 'main',
      });
      await rig.store.plays.create({
        id: 'play-1',
        scenarioId: 'scenario-1',
        need: 'need',
        flowId: 'play',
        flowVersion: 1,
        state: 'DELIVERING',
        counters: {},
      });
      rig.fake.seedRemote(rig.workspace.repo, 'main');
      rig.fake.commitLocal(rig.workspace.repo, branch);
      await rig.fake.pushRef({ repo: rig.workspace.repo, branch });
      await rig.store.sideEffects.intend({
        idempotencyKey: `play-1:pr:${branch}:main`,
        type: 'open_pr',
        target: `${branch} -> main`,
        params: { repo: rig.workspace.repo, head: branch, base: 'main', remote: 'origin' },
      });
      const infos = arm('reconcile.before_effect_resolve', 'open_pr');
      await reconcileBeforeResume(rig.deps);
      expect(infos).toEqual([
        { point: 'reconcile.before_effect_resolve', detail: 'open_pr', hit: 1 },
      ]);
    } finally {
      await rig.workspace.dispose();
    }
  });
});

describe('store.* (the commit of a transaction)', () => {
  it.each(['store.before_commit', 'store.after_commit'] as const)(
    '%s fires on each transaction',
    async (point) => {
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const dir = await mkdtemp(join(tmpdir(), 'ot-points-'));
      try {
        const infos = arm(point);
        const store = await openComposedStore(
          {
            path: join(dir, 'otheater.db'),
            driver: 'node-sqlite',
            synchronous: 'full',
            busyTimeoutMs: 5000,
          },
          new FakeClock(),
        );
        try {
          await store.events.append({ type: 'test.happened', schemaVersion: 1, payload: {} });
        } finally {
          await store.close();
        }
        expect(infos).toEqual([{ point, detail: undefined, hit: 1 }]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('the catalogue', () => {
  it('has a test that triggers every point', () => {
    expect([...triggered].sort()).toEqual([...CRASH_POINT_NAMES].sort());
  });
});
