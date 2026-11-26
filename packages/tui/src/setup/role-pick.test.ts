// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { ROLE_IDS, rolePickKey, rolePickLines, rolePickStart, type RolePick } from './role-pick.js';

const t = ((key: string, options?: { executor?: string }) =>
  options?.executor === undefined ? key : `${key}:${options.executor}`) as never;

function press(pick: RolePick, ...combos: string[]): RolePick {
  return combos.reduce((current, combo) => rolePickKey(current, combo).pick, pick);
}

describe('the list of roles of the review (N333)', () => {
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
    const start = rolePickStart('x@a/b');
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
    const start = rolePickStart('x@a/b');
    expect(rolePickKey(start, 'Enter').done).toBe('cancel');
    expect(rolePickKey(start, 'Esc').done).toBe('cancel');
    expect(rolePickKey(press(start, 'Space'), 'Enter').done).toBe('confirm');
    expect(rolePickKey(start, 'x').done).toBeUndefined();
    expect(rolePickKey(start, undefined).pick).toBe(start);
  });

  it('draws a title, a line per role with its mark, and the keys', () => {
    const lines = rolePickLines(press(rolePickStart('x@a/b'), 'Down', 'Space'), 'the-name', t);
    expect(lines).toHaveLength(ROLE_IDS.length + 2);
    expect(lines[0]?.text).toBe('setup.roles.title:the-name');
    expect(lines[2]).toMatchObject({ text: '[x] consultant', selected: true });
    expect(lines[1]).toMatchObject({ text: '[ ] director', selected: false });
    expect(lines.at(-1)?.text).toBe('setup.roles.keys');
  });
});
