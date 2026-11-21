// SPDX-License-Identifier: MPL-2.0
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { plain } from '../ink.test-support.js';
import { ScrollList, type ListLine } from './scroll-list.js';

describe('ScrollList', () => {
  it('asks for the lines of only the items the window touches, out of 5,000', () => {
    const lines = vi.fn((index: number): readonly ListLine[] => [
      { text: `row ${String(index)}a` },
      { text: `row ${String(index)}b` },
    ]);
    const view = render(
      <ScrollList count={5000} width={20} height={10} offset={0} lines={lines} />,
    );
    const frame = plain(view.lastFrame() ?? '');
    expect(frame.split('\n')).toHaveLength(10);
    expect(frame).toContain('row 4999b');
    expect(frame).not.toContain('row 4990');
    expect(lines.mock.calls.length).toBeLessThanOrEqual(10);
    view.unmount();
  });

  it('shows the marks of more above and below, and the top when scrolled to it', () => {
    const lines = (index: number): readonly ListLine[] => [{ text: `item ${String(index)}` }];
    const view = render(<ScrollList count={100} width={20} height={5} offset={10} lines={lines} />);
    const rows = plain(view.lastFrame() ?? '').split('\n');
    expect(rows).toHaveLength(5);
    expect(rows[0]?.endsWith('▲')).toBe(true);
    expect(rows[4]?.endsWith('▼')).toBe(true);
    view.unmount();
  });
});
