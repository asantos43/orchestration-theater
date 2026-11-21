// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { tabBarHit, panelBarRight, type PanelBarKeys } from './tab-bar-hit.js';

const tabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'settings', label: 'Settings' },
];
const keys: PanelBarKeys = { add: 'Alt+A', toggle: 'Alt+J' };

/** The bar as the panel draws it: ` Overview ✕ │ Settings ✕ `, blanks, then the right part. */
describe('the click on the tab bar', () => {
  const inner = 60;
  const hit = (x: number) => tabBarHit(tabs, 'overview', keys, inner, x);

  it('lands on a tab by its label and on its close mark by the cells at its end', () => {
    expect(hit(1)).toEqual({ kind: 'tab', id: 'overview' });
    // ` Overview ✕ ` is 12 cells: the three at the end are the mark and its blanks.
    expect(hit(8)).toEqual({ kind: 'tab', id: 'overview' });
    expect(hit(10)).toEqual({ kind: 'close', id: 'overview' });
    expect(hit(11)).toEqual({ kind: 'close', id: 'overview' });
  });

  it('skips the separator and finds the next tab', () => {
    expect(hit(12)).toBeUndefined();
    expect(hit(14)).toEqual({ kind: 'tab', id: 'settings' });
  });

  it('lands on the plus and on the arrow of the right part, and on nothing between them', () => {
    const start = inner - panelBarRight(keys).length;
    expect(hit(start)).toEqual({ kind: 'add' });
    expect(hit(start + 6)).toEqual({ kind: 'add' });
    expect(hit(start + 7)).toBeUndefined();
    expect(hit(start + 8)).toBeUndefined();
    expect(hit(start + 9)).toEqual({ kind: 'toggle' });
    expect(hit(inner - 1)).toEqual({ kind: 'toggle' });
  });

  it('leaves the blanks between the tabs and the right part without an answer', () => {
    expect(hit(40)).toBeUndefined();
  });

  it('draws the right part with no key when the keymap has none', () => {
    expect(panelBarRight({ add: undefined, toggle: undefined })).toBe('+  ⟩ ');
    expect(tabBarHit(tabs, 'overview', { add: undefined, toggle: undefined }, 30, 29)).toEqual({
      kind: 'toggle',
    });
  });
});
