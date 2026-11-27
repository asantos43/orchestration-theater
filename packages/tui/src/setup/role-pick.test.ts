// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  ROLE_IDS,
  rolePickChanged,
  rolePickKey,
  rolePickLines,
  rolePickStart,
  type RolePick,
  type RolePickTarget,
} from './role-pick.js';

const REVIEW: RolePickTarget = { kind: 'review', executorId: 'x@a/b' };
const ROW: RolePickTarget = { kind: 'row', index: 2 };

const t = ((key: string, options?: { executor?: string }) =>
  options?.executor === undefined ? key : `${key}:${options.executor}`) as never;

function press(pick: RolePick, ...combos: string[]): RolePick {
  return combos.reduce((current, combo) => rolePickKey(current, combo).pick, pick);
}

describe('the list of roles (N333, N335)', () => {
  it('has the seven roles, in the order of the schema', () => {
    expect(ROLE_IDS).toEqual([
      'director',
      'consultant',
      'author',
      'reviewer',
      'scriptwriter',
      'actor',
      'critic',
    ]);
  });

  it('walks inside the list and checks in the order of the roles, whatever the order of the keys', () => {
    const start = rolePickStart(REVIEW, 'x@a/b');
    expect(press(start, 'Up').cursor).toBe(0);
    expect(press(start, ...Array<string>(20).fill('Down')).cursor).toBe(ROLE_IDS.length - 1);
    // Check the reviewer (3 down), then the author (up one): they are kept in the order of the roles.
    expect(press(start, 'Down', 'Down', 'Down', 'Space', 'Up', 'Space').checked).toEqual([
      'author',
      'reviewer',
    ]);
    expect(press(start, 'Space', 'Space').checked).toEqual([]);
  });

  it('Enter takes the choice, and Esc or Enter with none checked leaves it', () => {
    const start = rolePickStart(REVIEW, 'x@a/b');
    expect(rolePickKey(start, 'Enter').done).toBe('cancel');
    expect(rolePickKey(start, 'Esc').done).toBe('cancel');
    expect(rolePickKey(press(start, 'Space'), 'Enter').done).toBe('confirm');
    expect(rolePickKey(start, 'x').done).toBeUndefined();
    expect(rolePickKey(start, undefined).pick).toBe(start);
  });

  it('draws a title, a line per role with its mark, and the keys', () => {
    const lines = rolePickLines(press(rolePickStart(ROW, 'the-name'), 'Down', 'Space'), t);
    expect(lines).toHaveLength(ROLE_IDS.length + 2);
    expect(lines[0]?.text).toBe('setup.roles.title:the-name');
    expect(lines[2]).toMatchObject({ text: '[x] consultant', selected: true });
    expect(lines[1]).toMatchObject({ text: '[ ] director', selected: false });
    expect(lines.at(-1)?.text).toBe('setup.roles.keys');
  });

  it('opens with the roles of the Executor checked, in the order of the registry', () => {
    const start = rolePickStart(ROW, 'm', ['reviewer', 'author']);
    expect(start.checked).toEqual(['author', 'reviewer']);
    expect(start.initial).toEqual(['author', 'reviewer']);
    expect(rolePickChanged(start)).toBe(false);
    expect(start.target).toBe(ROW);
  });

  it('Enter with the same set leaves it, with another set (even empty) confirms', () => {
    const start = rolePickStart(ROW, 'm', ['author']);
    expect(rolePickKey(start, 'Enter').done).toBe('cancel');
    // Uncheck the director? it is not checked: Down x2 is author, Space unchecks it -> empty set.
    const emptied = press(start, 'Down', 'Down', 'Space');
    expect(emptied.checked).toEqual([]);
    expect(rolePickKey(emptied, 'Enter').done).toBe('confirm');
    // Check and uncheck again: same set as the start.
    expect(rolePickKey(press(start, 'Space', 'Space'), 'Enter').done).toBe('cancel');
  });

  it('shows the roles checked at the start', () => {
    const lines = rolePickLines(rolePickStart(REVIEW, 'x', ['critic']), t);
    expect(lines.find((line) => line.key === 'rp.critic')?.text).toBe('[x] critic');
  });
});
