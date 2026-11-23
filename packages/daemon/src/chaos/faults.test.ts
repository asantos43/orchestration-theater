// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  CRASH_AT_VARIABLE,
  EMPTY_FAULT_PLAN,
  FAULT_VARIABLE,
  faultError,
  faultPlanPath,
  isReleaseBuild,
  parseCrashSpec,
  parseFailSpec,
  parseFaultPlan,
  resolveFaultPlan,
} from './faults.js';

describe('parseCrashSpec', () => {
  it('takes a point, a detail and the nth hit', () => {
    expect(parseCrashSpec('effects.after_execute')).toEqual({
      point: 'effects.after_execute',
      nth: 1,
    });
    expect(parseCrashSpec('effects.after_execute:open_pr')).toEqual({
      point: 'effects.after_execute',
      detail: 'open_pr',
      nth: 1,
    });
    expect(parseCrashSpec('store.before_commit#3')).toEqual({
      point: 'store.before_commit',
      nth: 3,
    });
    expect(parseCrashSpec('effects.after_intend:git_push#2')).toEqual({
      point: 'effects.after_intend',
      detail: 'git_push',
      nth: 2,
    });
  });

  it('refuses a bad name and a bad hit number, naming the variable', () => {
    expect(() => parseCrashSpec('Not A Point')).toThrow(CRASH_AT_VARIABLE);
    expect(() => parseCrashSpec('store.before_commit#0')).toThrow(CRASH_AT_VARIABLE);
    expect(() => parseCrashSpec('store.before_commit#x')).toThrow(CRASH_AT_VARIABLE);
    expect(() => parseCrashSpec('')).toThrow(CRASH_AT_VARIABLE);
  });
});

describe('parseFailSpec', () => {
  it('takes a point, a detail, a code and the hits that fail', () => {
    expect(parseFailSpec('fs.write=ENOSPC')).toEqual({
      point: 'fs.write',
      code: 'ENOSPC',
      nth: 1,
      times: 1,
    });
    expect(parseFailSpec('fs.write:log=EIO#2x3')).toEqual({
      point: 'fs.write',
      detail: 'log',
      code: 'EIO',
      nth: 2,
      times: 3,
    });
    expect(parseFailSpec('fs.write=SQLITE_FULL#1x0').times).toBe(0);
  });

  it('refuses an unknown code and an entry without a code', () => {
    expect(() => parseFailSpec('fs.write=EBOOM')).toThrow(FAULT_VARIABLE);
    expect(() => parseFailSpec('fs.write')).toThrow(FAULT_VARIABLE);
  });
});

describe('parseFaultPlan', () => {
  it('takes a plan file with defaults', () => {
    expect(
      parseFaultPlan(
        '{"crash":[{"point":"store.after_commit"}],"fail":[{"point":"fs.write","code":"EIO"}]}',
      ),
    ).toEqual({
      crash: [{ point: 'store.after_commit', nth: 1 }],
      fail: [{ point: 'fs.write', code: 'EIO', nth: 1, times: 1 }],
    });
    expect(parseFaultPlan('{}')).toEqual(EMPTY_FAULT_PLAN);
  });

  it('rejects what is not JSON, an unknown key and a bad rule', () => {
    expect(() => parseFaultPlan('not json')).toThrow(/not JSON/);
    expect(() => parseFaultPlan('{"crash":[],"oops":1}')).toThrow(/Invalid fault plan/);
    expect(() => parseFaultPlan('{"crash":[{"point":"X"}]}')).toThrow(/Invalid fault plan/);
  });
});

describe('resolveFaultPlan', () => {
  const env = {
    [CRASH_AT_VARIABLE]: 'effects.after_execute:open_pr',
    [FAULT_VARIABLE]: 'fs.write:log=ENOSPC, fs.rename=EIO#2x2',
  };

  it('off: no plan, whatever the environment and the file say', async () => {
    const plan = await resolveFaultPlan({
      mode: 'off',
      env,
      planFile: '/plan.json',
      releaseBuild: false,
      readFile: () => Promise.resolve('{"crash":[{"point":"store.before_commit"}]}'),
    });
    expect(plan).toEqual(EMPTY_FAULT_PLAN);
  });

  it('env: reads both variables', async () => {
    const plan = await resolveFaultPlan({ mode: 'env', env, releaseBuild: false });
    expect(plan.crash).toEqual([{ point: 'effects.after_execute', detail: 'open_pr', nth: 1 }]);
    expect(plan.fail).toEqual([
      { point: 'fs.write', detail: 'log', code: 'ENOSPC', nth: 1, times: 1 },
      { point: 'fs.rename', code: 'EIO', nth: 2, times: 2 },
    ]);
  });

  it('env: empty variables give an empty plan, and a malformed one rejects', async () => {
    expect(await resolveFaultPlan({ mode: 'env', env: {}, releaseBuild: false })).toEqual(
      EMPTY_FAULT_PLAN,
    );
    await expect(
      resolveFaultPlan({
        mode: 'env',
        env: { [CRASH_AT_VARIABLE]: 'bad point' },
        releaseBuild: false,
      }),
    ).rejects.toThrow(CRASH_AT_VARIABLE);
  });

  it('plan: reads the file; a missing file is an empty plan, another error is raised', async () => {
    const read = (text: string) => () => Promise.resolve(text);
    const plan = await resolveFaultPlan({
      mode: 'plan',
      env: {},
      planFile: '/p.json',
      releaseBuild: false,
      readFile: read('{"crash":[{"point":"store.before_commit","nth":2}]}'),
    });
    expect(plan.crash).toEqual([{ point: 'store.before_commit', nth: 2 }]);
    const missing = Object.assign(new Error('gone'), { code: 'ENOENT' });
    expect(
      await resolveFaultPlan({
        mode: 'plan',
        env: {},
        planFile: '/p.json',
        releaseBuild: false,
        readFile: () => Promise.reject(missing),
      }),
    ).toEqual(EMPTY_FAULT_PLAN);
    await expect(
      resolveFaultPlan({
        mode: 'plan',
        env: {},
        planFile: '/p.json',
        releaseBuild: false,
        readFile: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
      }),
    ).rejects.toThrow('denied');
  });

  it('the release build ignores the key: every mode gives an empty plan and the file is not read', async () => {
    let reads = 0;
    for (const mode of ['off', 'env', 'plan'] as const) {
      const plan = await resolveFaultPlan({
        mode,
        env,
        planFile: '/plan.json',
        releaseBuild: true,
        readFile: () => {
          reads += 1;
          return Promise.resolve('{"crash":[{"point":"store.before_commit"}]}');
        },
      });
      expect(plan).toEqual(EMPTY_FAULT_PLAN);
    }
    expect(reads).toBe(0);
  });

  it('a test run is not the release build', () => {
    expect(isReleaseBuild()).toBe(false);
  });
});

describe('helpers', () => {
  it('faultPlanPath puts a relative file inside the data directory', () => {
    expect(faultPlanPath('/data', 'fault-plan.json')).toBe('/data/fault-plan.json');
    expect(faultPlanPath('/data', '/elsewhere/plan.json')).toBe('/elsewhere/plan.json');
  });

  it('faultError carries the system code and says it was injected', () => {
    const error = faultError('ENOSPC', 'fs.write:log');
    expect(error).toMatchObject({ code: 'ENOSPC', injected: true });
    expect(error.message).toContain('fs.write:log');
  });
});
