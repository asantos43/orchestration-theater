// SPDX-License-Identifier: MPL-2.0
import { afterEach, describe, expect, it } from 'vitest';
import {
  armFaults,
  CRASH_POINT_NAMES,
  CRASH_POINTS,
  crashPoint,
  disarmFaults,
  failPoint,
  faultsArmed,
  storeCommitHooks,
  type CrashInfo,
} from './crash-points.js';
import { EMPTY_FAULT_PLAN, resolveFaultPlan } from './faults.js';

afterEach(disarmFaults);

function collect(): { infos: CrashInfo[]; onCrash: (info: CrashInfo) => void } {
  const infos: CrashInfo[] = [];
  return { infos, onCrash: (info) => void infos.push(info) };
}

describe('the catalogue', () => {
  it('has unique names of the form area.place', () => {
    expect(new Set(CRASH_POINT_NAMES).size).toBe(CRASH_POINT_NAMES.length);
    for (const name of CRASH_POINT_NAMES) expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
    expect(CRASH_POINT_NAMES).toHaveLength(
      CRASH_POINTS.effects.length + CRASH_POINTS.reconcile.length + CRASH_POINTS.store.length,
    );
  });
});

describe('crashPoint', () => {
  it('does nothing while nothing is armed (faults.inject: off)', async () => {
    expect(faultsArmed()).toBe(false);
    await crashPoint('effects.after_execute', 'open_pr');
    failPoint('fs.write', 'log');
    expect(storeCommitHooks()).toBeUndefined();
  });

  it('an empty plan, such as the one `off` and the release build give, arms nothing', async () => {
    const plan = await resolveFaultPlan({ mode: 'off', env: {}, releaseBuild: false });
    armFaults(plan);
    expect(faultsArmed()).toBe(false);
    armFaults({ crash: [{ point: 'store.before_commit', nth: 1 }], fail: [] });
    expect(faultsArmed()).toBe(true);
    armFaults(EMPTY_FAULT_PLAN);
    expect(faultsArmed()).toBe(false);
  });

  it('fires on the nth matching hit only', async () => {
    const { infos, onCrash } = collect();
    armFaults({ crash: [{ point: 'effects.after_intend', nth: 2 }], fail: [] }, { onCrash });
    await crashPoint('effects.after_intend', 'git_push');
    await crashPoint('effects.after_execute', 'git_push');
    expect(infos).toEqual([]);
    await crashPoint('effects.after_intend', 'open_pr');
    expect(infos).toEqual([{ point: 'effects.after_intend', detail: 'open_pr', hit: 2 }]);
    await crashPoint('effects.after_intend', 'open_pr');
    expect(infos).toHaveLength(1);
  });

  it('a rule with a detail counts and fires only for that detail', async () => {
    const { infos, onCrash } = collect();
    armFaults(
      { crash: [{ point: 'effects.after_execute', detail: 'open_pr', nth: 1 }], fail: [] },
      { onCrash },
    );
    await crashPoint('effects.after_execute', 'git_push');
    await crashPoint('effects.after_execute');
    expect(infos).toEqual([]);
    await crashPoint('effects.after_execute', 'open_pr');
    expect(infos).toEqual([{ point: 'effects.after_execute', detail: 'open_pr', hit: 1 }]);
  });

  it('disarmFaults puts everything back to doing nothing', async () => {
    const { infos, onCrash } = collect();
    armFaults({ crash: [{ point: 'store.before_commit', nth: 1 }], fail: [] }, { onCrash });
    disarmFaults();
    await crashPoint('store.before_commit');
    expect(infos).toEqual([]);
    expect(faultsArmed()).toBe(false);
  });
});

describe('failPoint', () => {
  it('throws the injected error on the hits asked for, and no other', () => {
    armFaults({
      crash: [],
      fail: [{ point: 'fs.write', detail: 'log', code: 'ENOSPC', nth: 2, times: 2 }],
    });
    expect(() => {
      failPoint('fs.write', 'log');
    }).not.toThrow();
    expect(() => {
      failPoint('fs.write', 'other');
    }).not.toThrow();
    for (let i = 0; i < 2; i += 1) {
      expect(() => {
        failPoint('fs.write', 'log');
      }).toThrow(expect.objectContaining({ code: 'ENOSPC', injected: true }) as Error);
    }
    expect(() => {
      failPoint('fs.write', 'log');
    }).not.toThrow();
  });

  it('times 0 fails every hit from nth on', () => {
    armFaults({ crash: [], fail: [{ point: 'fs.rename', code: 'EIO', nth: 1, times: 0 }] });
    for (let i = 0; i < 5; i += 1) {
      expect(() => {
        failPoint('fs.rename');
      }).toThrow(/EIO/);
    }
  });
});

describe('storeCommitHooks', () => {
  it('are there only while armed, and call the two store points', async () => {
    const { infos, onCrash } = collect();
    armFaults({ crash: [{ point: 'store.after_commit', nth: 1 }], fail: [] }, { onCrash });
    const hooks = storeCommitHooks();
    expect(hooks).toBeDefined();
    await hooks?.beforeCommit();
    expect(infos).toEqual([]);
    await hooks?.afterCommit();
    expect(infos).toEqual([{ point: 'store.after_commit', detail: undefined, hit: 1 }]);
  });
});
