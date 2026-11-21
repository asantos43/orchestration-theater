// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { decodeReport, sgrReport, SgrMouseParser } from './sgr.js';

describe('decodeReport', () => {
  it('reads the button, the modifiers and the 0-based cell', () => {
    expect(decodeReport(0, 13, 6, 'M')).toEqual({
      action: 'press',
      button: 'left',
      col: 12,
      row: 5,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(decodeReport(2 | 4 | 16, 1, 1, 'm')).toMatchObject({
      action: 'release',
      button: 'right',
      shift: true,
      ctrl: true,
      alt: false,
    });
  });

  it('reads the wheel, the drag and the move', () => {
    expect(decodeReport(64, 1, 1, 'M')).toMatchObject({ action: 'wheel', wheel: 'up' });
    expect(decodeReport(65, 1, 1, 'M')).toMatchObject({ action: 'wheel', wheel: 'down' });
    expect(decodeReport(32, 4, 2, 'M')).toMatchObject({ action: 'drag', button: 'left' });
    expect(decodeReport(35, 4, 2, 'M')).toMatchObject({ action: 'move', button: 'none' });
  });
});

describe('SgrMouseParser', () => {
  const press = sgrReport({ action: 'press', col: 12, row: 5 });
  const release = sgrReport({ action: 'release', col: 12, row: 5 });

  it('turns whole reports into events and none of their bytes into text', () => {
    const parser = new SgrMouseParser();
    const feed = parser.push(`${press}${release}`);
    expect(feed.text).toBe('');
    expect(feed.events.map((event) => event.action)).toEqual(['press', 'release']);
    expect(feed.events[0]).toMatchObject({ col: 12, row: 5, button: 'left' });
  });

  it('keeps the keys around a report in order', () => {
    const parser = new SgrMouseParser();
    const feed = parser.push(`ab${press}cd`);
    expect(feed.text).toBe('abcd');
    expect(feed.events).toHaveLength(1);
  });

  it('holds a report cut at any byte until the rest comes', () => {
    const wheel = sgrReport({ action: 'wheel', wheel: 'down', col: 40, row: 9 });
    for (let cut = 1; cut < wheel.length; cut += 1) {
      const parser = new SgrMouseParser();
      const first = parser.push(`x${wheel.slice(0, cut)}`);
      expect(first.text).toBe('x');
      expect(first.events).toEqual([]);
      expect(parser.holding).toBe(true);
      const second = parser.push(`${wheel.slice(cut)}y`);
      expect(second.text).toBe('y');
      expect(second.events).toEqual([
        expect.objectContaining({ action: 'wheel', wheel: 'down', col: 40, row: 9 }),
      ]);
      expect(parser.holding).toBe(false);
    }
  });

  it('handles a stream cut in many small pieces', () => {
    const parser = new SgrMouseParser();
    const stream = `${press}k${release}`;
    let text = '';
    let events = 0;
    for (const char of stream) {
      const feed = parser.push(char);
      text += feed.text;
      events += feed.events.length;
    }
    expect(text).toBe('k');
    expect(events).toBe(2);
  });

  it('lets other escape sequences through as text', () => {
    const parser = new SgrMouseParser();
    expect(parser.push('\x1b[A').text).toBe('\x1b[A');
    expect(parser.push('\x1b[200~').text).toBe('\x1b[200~');
  });

  it('holds a lone Esc and gives it back on flush', () => {
    const parser = new SgrMouseParser();
    expect(parser.push('\x1b')).toEqual({ events: [], text: '' });
    expect(parser.holding).toBe(true);
    expect(parser.flush()).toBe('\x1b');
    expect(parser.holding).toBe(false);
  });

  it('does not read a paste as a report', () => {
    const parser = new SgrMouseParser();
    const feed = parser.push(`\x1b[200~${press}\x1b[201~${release}`);
    expect(feed.text).toBe(`\x1b[200~${press}\x1b[201~`);
    expect(feed.events).toHaveLength(1);
    expect(feed.events[0]?.action).toBe('release');
  });

  it('knows a paste end cut between chunks', () => {
    const parser = new SgrMouseParser();
    const a = parser.push(`\x1b[200~${press}\x1b[20`);
    const b = parser.push(`1~${release}`);
    expect(a.text + b.text).toBe(`\x1b[200~${press}\x1b[201~`);
    expect(b.events).toHaveLength(1);
  });
});
