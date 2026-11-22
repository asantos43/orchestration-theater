// SPDX-License-Identifier: MPL-2.0
import type { ApiQuotaStatus } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { fieldStep } from './field.js';
import {
  LIMIT_KEYS,
  flatten,
  formatSpan,
  limitEdit,
  limitUnsetEdit,
  moved,
  nextChoice,
  addLoginModeOf,
  parseAddForm,
  parseLimit,
  quotaLine,
  reorderEdit,
  ruleEdit,
} from './model.js';

function spec(key: string): (typeof LIMIT_KEYS)[number] {
  const found = LIMIT_KEYS.find((item) => item.key === key);
  if (found === undefined) throw new Error(`no limit ${key}`);
  return found;
}

describe('the model of the tab Settings', () => {
  it('writes spans as the two largest units', () => {
    expect(formatSpan(45_000)).toBe('45s');
    expect(formatSpan(7_500_000)).toBe('2h 5m');
    expect(formatSpan(3 * 86_400_000 + 4 * 3_600_000)).toBe('3d 4h');
    expect(formatSpan(-5)).toBe('0s');
  });

  it('reads the most used window and the time to the reset of an account', () => {
    const quota = {
      state: 'near_limit',
      untilReset: null,
      windows: [
        { window: '5h', usedPercent: 40.4, resetsAt: 5_000 },
        { window: '7d', usedPercent: 83.6, resetsAt: 9_000 },
      ],
    } as unknown as ApiQuotaStatus;
    expect(quotaLine(quota, 1_000)).toEqual({ state: 'near_limit', percent: 84, resetsIn: 8_000 });
    expect(quotaLine(null, 0)).toEqual({
      state: 'unknown',
      percent: undefined,
      resetsIn: undefined,
    });
    const exhausted = {
      ...quota,
      state: 'exhausted',
      untilReset: 2_000,
    } as unknown as ApiQuotaStatus;
    expect(quotaLine(exhausted, 1_500).resetsIn).toBe(500);
  });

  it('moves an item of a list by one place and refuses to leave it', () => {
    expect(moved(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b', 'c'], 0, -1)).toBeUndefined();
    expect(moved(['a', 'b', 'c'], 2, 1)).toBeUndefined();
  });

  it('builds the edits of the configuration', () => {
    expect(reorderEdit('author', ['x', 'y'])).toEqual({
      set: [{ path: ['roles', 'author', 'executors'], value: ['x', 'y'] }],
    });
    expect(ruleEdit('critic', 'wait')).toEqual({
      set: [{ path: ['roles', 'critic', 'when_exhausted'], value: 'wait' }],
    });
    expect(limitEdit('preset', 'economical')).toEqual({
      set: [{ path: ['limits', 'preset'], value: 'economical' }],
    });
    expect(limitUnsetEdit('turn_timeout')).toEqual({ remove: [['limits', 'turn_timeout']] });
  });

  it('parses the values of the limits by their kind', () => {
    expect(parseLimit(spec('plan_reviews'), ' 4 ')).toBe(4);
    expect(parseLimit(spec('plan_reviews'), '-1')).toBeUndefined();
    expect(parseLimit(spec('attempts_per_demand'), '0')).toBeUndefined();
    expect(parseLimit(spec('attempts_per_demand'), '1')).toBe(1);
    expect(parseLimit(spec('demand_timeout'), '30 m')).toBe('30m');
    expect(parseLimit(spec('demand_timeout'), 'soon')).toBeUndefined();
    expect(parseLimit(spec('on_turn_timeout'), 'notice')).toBe('notice');
    expect(parseLimit(spec('on_turn_timeout'), 'x')).toBeUndefined();
  });

  it('cycles a choice and wraps around', () => {
    expect(nextChoice(['next', 'wait'], 'next')).toBe('wait');
    expect(nextChoice(['next', 'wait'], 'wait')).toBe('next');
    expect(nextChoice(['next', 'wait'], undefined)).toBe('next');
  });

  it('flattens an override to sorted path = value rows', () => {
    expect(
      flatten({ roles: { author: { executors: ['a', 'b'] } }, limits: { plan_reviews: 5 } }),
    ).toEqual([
      ['limits.plan_reviews', '5'],
      ['roles.author.executors', 'a, b'],
    ]);
  });

  it('reads the form of a new account', () => {
    expect(parseAddForm('codex alt token_plan codex')).toEqual({
      client: 'codex',
      name: 'alt',
      kind: 'token_plan',
      provider: 'codex',
    });
    expect(parseAddForm('codex alt')).toBeUndefined();
    expect(parseAddForm('codex alt other codex')).toBeUndefined();
    expect(parseAddForm('a b api c d')).toBeUndefined();
  });
});

describe('addLoginModeOf', () => {
  it('reads profiles.add.login and takes ask for what is missing or unknown', () => {
    expect(addLoginModeOf({ profiles: { add: { login: 'auto' } } })).toBe('auto');
    expect(addLoginModeOf({ profiles: { add: { login: 'off' } } })).toBe('off');
    expect(addLoginModeOf({ profiles: { add: { login: 'ask' } } })).toBe('ask');
    expect(addLoginModeOf({ profiles: { add: { login: 'sometimes' } } })).toBe('ask');
    expect(addLoginModeOf({ profiles: {} })).toBe('ask');
    expect(addLoginModeOf({})).toBe('ask');
  });
});

describe('the one-line field', () => {
  it('appends text, deletes, clears, and ends on Enter or Esc', () => {
    expect(fieldStep('ab', undefined, 'c')).toEqual({ value: 'abc' });
    expect(fieldStep('abc', 'Backspace', '\x7f')).toEqual({ value: 'ab' });
    expect(fieldStep('abc', 'Ctrl+U', '\x15')).toEqual({ value: '' });
    expect(fieldStep('abc', 'Enter', '\r')).toEqual({ value: 'abc', done: 'submit' });
    expect(fieldStep('abc', 'Esc', '\x1b')).toEqual({ value: 'abc', done: 'cancel' });
  });

  it('takes a paste without its marks and line breaks, and ignores control bytes', () => {
    expect(fieldStep('', undefined, '\x1b[200~sk-1\n23\x1b[201~').value).toBe('sk-123');
    expect(fieldStep('x', undefined, '\x01').value).toBe('x');
  });
});
