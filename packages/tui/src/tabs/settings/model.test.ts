// SPDX-License-Identifier: MPL-2.0
import type { ApiQuotaStatus, ApiRoles } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { fieldStep } from './field.js';
import {
  LIMIT_KEYS,
  alignColumns,
  flatten,
  formatSpan,
  limitEdit,
  limitUnsetEdit,
  moveRoleCursor,
  moved,
  nextChoice,
  addLoginModeOf,
  parseLimit,
  quotaLine,
  reorderEdit,
  roleItems,
  ruleEdit,
  settingsFolded,
  windowCell,
  windowColumns,
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

/** The tab in columns (the owner's "Seções de hoje, em tabela", 2026-11-26). */
describe('the columns of the tab', () => {
  it('aligns the cells, leaves the last one and the empty tail alone, and cuts a wide row', () => {
    expect(
      alignColumns([
        ['account', 'kind'],
        ['claude-code/main', 'Subscription'],
      ]),
    ).toEqual(['account           kind', 'claude-code/main  Subscription']);
    expect(
      alignColumns([
        ['a', ''],
        ['bb', 'x'],
      ]),
    ).toEqual(['a', 'bb  x']);
    expect(alignColumns([['key', '= 3']], 1)).toEqual(['key = 3']);
    expect(alignColumns([['abcdef', 'ghijkl']], 2, 8)).toEqual(['abcdef …']);
  });

  it('starts Limits folded or open by ui.settingsTab.limits, and Enter flips it', () => {
    expect([...settingsFolded(new Set(), 'folded')]).toEqual(['settings.limits']);
    expect([...settingsFolded(new Set(['settings.limits']), 'folded')]).toEqual([]);
    expect([...settingsFolded(new Set(), 'open')]).toEqual([]);
    expect([...settingsFolded(new Set(['settings.roles']), 'open')]).toEqual(['settings.roles']);
  });

  it('puts 5h and 7d first, then the other windows by name, and `—` with no reading', () => {
    const quota = (windows: { window: string; usedPercent: number }[]): ApiQuotaStatus =>
      ({ windows }) as unknown as ApiQuotaStatus;
    const read = quota([
      { window: 'weekly_opus', usedPercent: 12.4 },
      { window: '5h', usedPercent: 40 },
    ]);
    expect(windowColumns([null, read, undefined])).toEqual(['5h', '7d', 'weekly_opus']);
    expect(windowColumns([])).toEqual(['5h', '7d']);
    expect(windowCell(read, 'weekly_opus')).toBe('12%');
    expect(windowCell(read, '7d')).toBe('—');
    expect(windowCell(null, '5h')).toBe('—');
  });
});

describe('the roles on one line each', () => {
  const roles = {
    roles: [
      { role: 'director', executors: [{ id: 'a' }, { id: 'b' }] },
      { role: 'author', executors: [{ id: 'c' }] },
    ],
  } as unknown as ApiRoles;

  it('lists every role whole with no view, and only the open one with a view', () => {
    expect(roleItems(roles)).toHaveLength(5);
    expect(roleItems(roles, { open: null })).toEqual([
      { kind: 'rule', role: 'director' },
      { kind: 'rule', role: 'author' },
    ]);
    expect(roleItems(roles, { open: 'author' })).toEqual([
      { kind: 'rule', role: 'director' },
      { kind: 'rule', role: 'author' },
      { kind: 'executor', role: 'author', index: 0 },
    ]);
  });

  it('opens the role of the line the cursor lands on and keeps the cursor on that line', () => {
    // director open: director, a, b, author. Down from b lands on author, which opens.
    expect(moveRoleCursor(roles, 'director', 2, 1)).toEqual({ open: 'author', at: 1 });
    // author open: director, author, c. Up from author lands on director, which opens.
    expect(moveRoleCursor(roles, 'author', 1, -1)).toEqual({ open: 'director', at: 0 });
    expect(moveRoleCursor(roles, 'director', 0, 1)).toEqual({ open: 'director', at: 1 });
    // At the edges the cursor stays.
    expect(moveRoleCursor(roles, 'director', 0, -1)).toEqual({ open: 'director', at: 0 });
    expect(moveRoleCursor(roles, 'author', 2, 1)).toEqual({ open: 'author', at: 2 });
  });
});
