// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  it('lets up to the limit run and queues the rest in order', async () => {
    const semaphore = new Semaphore(2);
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const take = async (name: string): Promise<void> => {
      releases.push(await semaphore.acquire());
      order.push(name);
    };
    const all = [take('a'), take('b'), take('c'), take('d')];
    await Promise.resolve();
    await Promise.resolve();
    expect(semaphore.active).toBe(2);
    expect(semaphore.waiting).toBe(2);
    expect(order).toEqual(['a', 'b']);

    releases[0]?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a', 'b', 'c']);
    releases[1]?.();
    await Promise.all(all.slice(0, 4));
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    expect(semaphore.active).toBe(2);
  });

  it('frees a permit once, however many times release is called', async () => {
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();
    release();
    release();
    expect(semaphore.active).toBe(0);
    const second = await semaphore.acquire();
    expect(semaphore.active).toBe(1);
    second();
    expect(semaphore.active).toBe(0);
  });

  it('does not let a newcomer jump a queue', async () => {
    const semaphore = new Semaphore(1);
    const first = await semaphore.acquire();
    const order: string[] = [];
    const waiting = semaphore.acquire().then((release) => {
      order.push('waiting');
      return release;
    });
    first();
    // The permit is free for an instant, but it already belongs to the one that waited.
    const late = semaphore.acquire().then((release) => {
      order.push('late');
      return release;
    });
    (await waiting)();
    (await late)();
    expect(order).toEqual(['waiting', 'late']);
  });

  it('takes a new limit: a larger one wakes the queue, a smaller one waits for the running ones', async () => {
    const semaphore = new Semaphore(1);
    const first = await semaphore.acquire();
    const second = semaphore.acquire();
    expect(semaphore.waiting).toBe(1);
    semaphore.setLimit(2);
    const release2 = await second;
    expect(semaphore.active).toBe(2);
    semaphore.setLimit(1);
    expect(semaphore.active).toBe(2);
    first();
    expect(semaphore.active).toBe(1);
    release2();
    expect(semaphore.active).toBe(0);
  });

  it('refuses a limit that is not an integer of at least 1', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
    expect(() => new Semaphore(Number.NaN)).toThrow(RangeError);
  });
});
