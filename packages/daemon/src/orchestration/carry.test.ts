// SPDX-License-Identifier: MPL-2.0
import type { Demand, Script } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { demandOf } from '../workspace/workspace-fixture.js';
import { CarrySchema, carryKey, keptDemands, sameWork } from './carry.js';
import { stagePrompt, type CarriedWork } from './prompts.js';

function scriptOf(...demands: Demand[]): Script {
  return { contracts: [], demands };
}

const alpha = demandOf('alpha');
const beta = demandOf('beta', ['alpha']);
const gamma = demandOf('gamma', ['beta']);
const marked = (demand: Demand): Demand => ({ ...demand, unchanged: true });

describe('sameWork', () => {
  it('is true for the same demand, whatever the title, and false for any change of the work', () => {
    expect(sameWork(alpha, { ...alpha, title: 'Another title' })).toBe(true);
    expect(sameWork(alpha, { ...alpha, description: 'Do it differently.' })).toBe(false);
    expect(sameWork(alpha, { ...alpha, expectedFiles: ['other.txt'] })).toBe(false);
    expect(sameWork(alpha, { ...alpha, contract: { inputs: ['x'], outputs: ['c-alpha'] } })).toBe(
      false,
    );
    expect(sameWork(alpha, { ...alpha, dependsOn: ['beta'] })).toBe(false);
    expect(sameWork(alpha, { ...alpha, verify: [] })).toBe(false);
    expect(sameWork(alpha, { ...alpha, verifyWaiver: 'none' })).toBe(false);
  });
});

describe('keptDemands (N84)', () => {
  const previous = scriptOf(alpha, beta, gamma);
  const approved = new Set(['alpha', 'beta', 'gamma']);

  it('keep_unchanged: keeps the demands the Scriptwriter marked, the daemon found equal and were approved', () => {
    const next = scriptOf(marked(alpha), { ...beta, description: 'Changed.' }, gamma);
    expect(keptDemands({ mode: 'keep_unchanged', previous, next, approved })).toEqual(['alpha']);
  });

  it('from_previous keeps the same demands: the difference is where the changed ones start', () => {
    const next = scriptOf(marked(alpha), { ...beta, description: 'Changed.' }, gamma);
    expect(keptDemands({ mode: 'from_previous', previous, next, approved })).toEqual(['alpha']);
  });

  it('redo_all keeps nothing, and neither does a first script', () => {
    const next = scriptOf(marked(alpha), marked(beta), marked(gamma));
    expect(keptDemands({ mode: 'redo_all', previous, next, approved })).toEqual([]);
    expect(keptDemands({ mode: 'keep_unchanged', previous: undefined, next, approved })).toEqual(
      [],
    );
  });

  it('does not trust the mark alone: a demand that changed but was marked is redone', () => {
    const next = scriptOf(marked({ ...alpha, description: 'Changed but marked.' }), beta);
    expect(keptDemands({ mode: 'keep_unchanged', previous, next, approved })).toEqual([]);
  });

  it('does not keep what was not approved, or a demand that is not in the old script', () => {
    const next = scriptOf(marked(alpha), marked(beta), marked(demandOf('delta')));
    expect(
      keptDemands({ mode: 'keep_unchanged', previous, next, approved: new Set(['alpha']) }),
    ).toEqual(['alpha']);
    expect(keptDemands({ mode: 'keep_unchanged', previous, next, approved })).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('drops a demand whose dependency is not kept, down the whole chain', () => {
    const next = scriptOf({ ...alpha, description: 'Changed.' }, marked(beta), marked(gamma));
    expect(keptDemands({ mode: 'keep_unchanged', previous, next, approved })).toEqual([]);
    const half = scriptOf(marked(alpha), { ...beta, description: 'Changed.' }, marked(gamma));
    expect(keptDemands({ mode: 'keep_unchanged', previous, next: half, approved })).toEqual([
      'alpha',
    ]);
  });
});

describe('the note of a carried attempt', () => {
  it('is keyed by demand and checked by a strict schema', () => {
    expect(carryKey('alpha')).toBe('carry:alpha');
    const carry = {
      fromAttempt: 1,
      kind: 'rescript',
      branch: 'play/p/alpha/1',
      oldBase: null,
      resolve: false,
      startFromBranch: false,
      mergeIn: null,
      files: [],
    };
    expect(CarrySchema.safeParse(carry).success).toBe(true);
    expect(CarrySchema.safeParse({ ...carry, extra: 1 }).success).toBe(false);
    expect(CarrySchema.safeParse({ ...carry, fromAttempt: 0 }).success).toBe(false);
  });
});

describe('the prompt of an attempt that takes over earlier work', () => {
  const base = {
    stage: 'EXECUTING',
    role: 'actor',
    playId: 'p',
    need: 'build it',
    feedback: null,
    restart: false,
    demand: beta,
    attempt: 2,
  };
  const work = (extra: Partial<CarriedWork>): CarriedWork => ({
    kind: 'rebase_conflict',
    branch: 'play/p/beta/1',
    resolve: false,
    mergeIn: null,
    files: ['a.txt'],
    startsFromBranch: false,
    ...extra,
  });

  it('redo: asks for the demand again and shows the old diff', () => {
    const text = stagePrompt({ ...base, carried: work({ diff: '+beta line' }) });
    expect(text).toContain('## Work of the earlier attempt');
    expect(text).toContain('conflicts in: a.txt');
    expect(text).toContain('Redo the demand');
    expect(text).toContain('```diff\n+beta line\n```');
  });

  it('says when the diff was cut', () => {
    const text = stagePrompt({ ...base, carried: work({ diff: '+x', truncated: true }) });
    expect(text).toContain('the diff was cut');
  });

  it('resolve_attempt: asks only for the merge of the new branch, and nothing else', () => {
    const text = stagePrompt({
      ...base,
      carried: work({ resolve: true, startsFromBranch: true, mergeIn: 'play/p/alpha/2' }),
    });
    expect(text).toContain('Only resolve the conflict: merge `play/p/alpha/2`');
    expect(text).toContain('Change nothing else');
    expect(text).not.toContain('```diff');
  });

  it('from_previous: starts on the old branch and asks for the change only', () => {
    const text = stagePrompt({
      ...base,
      carried: work({ kind: 'rescript', startsFromBranch: true, files: [] }),
    });
    expect(text).toContain('The script was rewritten');
    expect(text).toContain('starts from that branch: change what the demand now asks for');
  });

  it('an attempt without carried work has no such section', () => {
    expect(stagePrompt(base)).not.toContain('Work of the earlier attempt');
  });

  it('the Scriptwriter gets the previous script and the note about the unchanged mark', () => {
    const text = stagePrompt({
      stage: 'SCRIPTING',
      role: 'scriptwriter',
      playId: 'p',
      need: 'x',
      feedback: 'why',
      restart: false,
      previousScript: '{"demands":[]}',
    });
    expect(text).toContain('## Previous script');
    expect(text).toContain('"unchanged": true');
  });
});
