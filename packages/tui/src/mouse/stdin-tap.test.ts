// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { sgrReport, type MouseEvent } from './sgr.js';
import { tapStdin, type TappableStdin } from './stdin-tap.js';

/** A stream that serves the chunks it was given, one `read()` each, as Ink reads them. */
class FakeStream implements TappableStdin {
  chunks: string[] = [];
  readable = 0;
  read(): string | null {
    return this.chunks.shift() ?? null;
  }
  emit(): boolean {
    this.readable += 1;
    return true;
  }
}

function readAll(stream: TappableStdin): string {
  let text = '';
  for (;;) {
    const chunk = stream.read();
    if (chunk === null) return text;
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
}

const timers = (): {
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  fire: () => void;
  pending: () => number;
} => {
  const queue = new Map<number, () => void>();
  let next = 0;
  return {
    setTimer: (run) => {
      next += 1;
      queue.set(next, run);
      return next;
    },
    clearTimer: (handle) => {
      queue.delete(handle as number);
    },
    fire: () => {
      const runs = [...queue.values()];
      queue.clear();
      for (const run of runs) run();
    },
    pending: () => queue.size,
  };
};

describe('tapStdin', () => {
  it('takes the reports out of what Ink reads and hands them over as events', () => {
    const stream = new FakeStream();
    const events: MouseEvent[] = [];
    const timer = timers();
    tapStdin(stream, (event) => events.push(event), timer);
    stream.chunks = [`a${sgrReport({ action: 'press', col: 3, row: 2 })}b`];
    expect(readAll(stream)).toBe('ab');
    expect(events).toEqual([expect.objectContaining({ action: 'press', col: 3, row: 2 })]);
  });

  it('serves nothing for a chunk that is only a report', () => {
    const stream = new FakeStream();
    const events: MouseEvent[] = [];
    tapStdin(stream, (event) => events.push(event), timers());
    stream.chunks = [sgrReport({ action: 'wheel', wheel: 'up', col: 1, row: 1 }), 'z'];
    expect(readAll(stream)).toBe('z');
    expect(events).toHaveLength(1);
  });

  it('joins a report cut between two reads', () => {
    const stream = new FakeStream();
    const events: MouseEvent[] = [];
    tapStdin(stream, (event) => events.push(event), timers());
    const report = sgrReport({ action: 'press', col: 30, row: 8 });
    stream.chunks = [report.slice(0, 5)];
    expect(readAll(stream)).toBe('');
    stream.chunks = [report.slice(5)];
    expect(readAll(stream)).toBe('');
    expect(events).toEqual([expect.objectContaining({ col: 30, row: 8 })]);
  });

  it('lets a lone Esc go on to Ink when nothing completes it', () => {
    const stream = new FakeStream();
    const timer = timers();
    tapStdin(stream, () => undefined, timer);
    stream.chunks = ['\x1b'];
    expect(readAll(stream)).toBe('');
    expect(timer.pending()).toBe(1);
    timer.fire();
    expect(stream.readable).toBe(1);
    expect(readAll(stream)).toBe('\x1b');
  });

  it('cancels the hold when the rest arrives', () => {
    const stream = new FakeStream();
    const timer = timers();
    tapStdin(stream, () => undefined, timer);
    const report = sgrReport({ action: 'press', col: 1, row: 1 });
    stream.chunks = [report.slice(0, 3)];
    readAll(stream);
    stream.chunks = [report.slice(3)];
    readAll(stream);
    expect(timer.pending()).toBe(0);
  });

  it('puts read back', () => {
    const stream = new FakeStream();
    const before = (stream as { read: unknown }).read;
    const restore = tapStdin(stream, () => undefined, timers());
    expect((stream as { read: unknown }).read).not.toBe(before);
    restore();
    expect((stream as { read: unknown }).read).toBe(before);
    expect(Object.hasOwn(stream, 'read')).toBe(false);
  });
});
