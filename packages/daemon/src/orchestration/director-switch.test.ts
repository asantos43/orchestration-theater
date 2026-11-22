// SPDX-License-Identifier: MPL-2.0
import type { ResolvedExecutor } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  DIRECTOR_OVERRIDE_KEY,
  directorOverrideKey,
  directorWhat,
  matchExecutor,
  readDirectorOverride,
  writeDirectorOverride,
} from './director-switch.js';

const list = (...ids: string[]): ResolvedExecutor[] =>
  ids.map((id) => ({ id }) as unknown as ResolvedExecutor);

describe('the override of the Director in the configOverride of the scenario (P14)', () => {
  it('reads nothing where there is no override or what is there is not one', () => {
    expect(readDirectorOverride({})).toBeNull();
    expect(readDirectorOverride({ [DIRECTOR_OVERRIDE_KEY]: 'x' })).toBeNull();
    expect(readDirectorOverride({ [DIRECTOR_OVERRIDE_KEY]: [] })).toBeNull();
    expect(readDirectorOverride({ [DIRECTOR_OVERRIDE_KEY]: { executor: '' } })).toBeNull();
    expect(readDirectorOverride({ [DIRECTOR_OVERRIDE_KEY]: { model: 'm' } })).toBeNull();
  });

  it('writes and reads back the override, and keeps the other keys', () => {
    const base = { other: 1 };
    const written = writeDirectorOverride(base, { executor: 'a@c/p', effort: 'high' });
    expect(written).toEqual({
      other: 1,
      [DIRECTOR_OVERRIDE_KEY]: { executor: 'a@c/p', effort: 'high' },
    });
    expect(readDirectorOverride(written)).toEqual({ executor: 'a@c/p', effort: 'high' });
    expect(writeDirectorOverride(written, null)).toEqual({ other: 1 });
    expect(base).toEqual({ other: 1 });
  });

  it('ignores an empty model or effort', () => {
    expect(
      readDirectorOverride({ [DIRECTOR_OVERRIDE_KEY]: { executor: 'a', model: '', effort: '' } }),
    ).toEqual({ executor: 'a' });
  });

  it('gives equal keys to equal overrides only', () => {
    expect(directorOverrideKey(null)).toBe('');
    expect(directorOverrideKey({ executor: 'a' })).toBe(directorOverrideKey({ executor: 'a' }));
    expect(directorOverrideKey({ executor: 'a' })).not.toBe(
      directorOverrideKey({ executor: 'a', effort: 'low' }),
    );
  });
});

describe('matchExecutor', () => {
  const executors = list('m-high@c/one', 'm-low@c/one', 'other@d/two');

  it('takes the complete name, the position (from 1) or a single prefix', () => {
    expect(matchExecutor(executors, 'other@d/two')).toBe(executors[2]);
    expect(matchExecutor(executors, '2')).toBe(executors[1]);
    expect(matchExecutor(executors, ' other ')).toBe(executors[2]);
  });

  it('says ambiguous for a prefix of several and nothing for the rest', () => {
    expect(matchExecutor(executors, 'm-')).toBe('ambiguous');
    expect(matchExecutor(executors, 'zzz')).toBeUndefined();
    expect(matchExecutor(executors, '9')).toBeUndefined();
    expect(matchExecutor(executors, '0')).toBeUndefined();
    expect(matchExecutor(executors, '  ')).toBeUndefined();
  });
});

describe('directorWhat', () => {
  it('writes the Executor with its model and effort', () => {
    expect(directorWhat('a@c/p', 'm', 'high')).toBe('a@c/p [m / high]');
    expect(directorWhat('a@c/p', 'm', null)).toBe('a@c/p [m]');
    expect(directorWhat('a@c/p', null, null)).toBe('a@c/p');
    expect(directorWhat(null, null, null)).toBe('-');
  });
});
