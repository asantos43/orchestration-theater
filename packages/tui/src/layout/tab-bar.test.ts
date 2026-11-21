// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { layoutTabBar } from './tab-bar.js';

const tabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'trajectories', label: 'Trajectories' },
  { id: 'usage', label: 'Usage' },
  { id: 'directives', label: 'Directives' },
];

describe('layoutTabBar', () => {
  it('draws every tab with a mark under the active one when they fit', () => {
    const bar = layoutTabBar(tabs.slice(0, 2), 'trajectories', 60);
    expect(bar.segments.map((segment) => segment.text)).toEqual([
      ' Overview ✕ ',
      '│',
      ' Trajectories ✕ ',
    ]);
    expect(bar.segments.filter((segment) => segment.active).map((segment) => segment.id)).toEqual([
      'trajectories',
    ]);
    expect(bar.underline).toBe('─'.repeat(12) + '─' + '━'.repeat(16));
    expect(bar.hidden).toEqual({ before: 0, after: 0 });
  });

  it('keeps the active tab and the ones nearest to it when they do not fit', () => {
    const bar = layoutTabBar(tabs, 'usage', 30);
    const ids = bar.segments
      .filter((segment) => !segment.id.startsWith('sep-'))
      .map((segment) => segment.id);
    expect(ids).toContain('usage');
    expect(ids.length).toBeLessThan(tabs.length);
    expect(bar.hidden.before + bar.hidden.after + ids.length).toBe(tabs.length);
    const width = bar.segments.reduce((sum, segment) => sum + segment.text.length, 0);
    expect(width).toBeLessThanOrEqual(30);
    expect(bar.underline.length).toBe(width);
  });

  it('cuts the label of a single tab wider than the room', () => {
    const bar = layoutTabBar(tabs, 'trajectories', 8);
    const text = bar.segments.map((segment) => segment.text).join('');
    expect(text.length).toBeLessThanOrEqual(8);
    expect(bar.segments.some((segment) => segment.id === 'trajectories')).toBe(true);
  });

  it('has nothing to draw with no tab', () => {
    const bar = layoutTabBar([], undefined, 40);
    expect(bar.segments).toEqual([]);
    expect(bar.underline).toBe('');
    expect(bar.hidden).toEqual({ before: 0, after: 0 });
  });
});
