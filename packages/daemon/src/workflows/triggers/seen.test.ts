// SPDX-License-Identifier: MPL-2.0
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { InvalidInput } from '@otheater/core';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTempFolders, tempFolder } from '../packages/packages.test-support.js';
import { PENDING_LIMIT, SeenLedger, workflowTriggersFile } from './seen.js';

afterEach(removeTempFolders);

async function ledger(): Promise<{ file: string; make: () => SeenLedger }> {
  const dir = await tempFolder('ottrg-seen-');
  const file = workflowTriggersFile(dir);
  return { file, make: () => new SeenLedger(file) };
}

function pendingEvent(n: number): {
  key: string;
  eventId: number;
  triggerIndex: number;
  queuedAt: number;
} {
  return { key: `event:${String(n)}`, eventId: n, triggerIndex: 0, queuedAt: n };
}

describe('SeenLedger', () => {
  it('is empty without a file', async () => {
    const { make } = await ledger();
    const seen = make();
    expect(await seen.has('b1', 'issue_opened:1')).toBe(false);
    expect(await seen.eventCursor()).toBeNull();
    expect(await seen.pending('b1')).toEqual([]);
  });

  it('keeps what was marked across instances, per binding', async () => {
    const { make } = await ledger();
    const first = make();
    await first.mark('b1', 'issue_opened:1', 10);
    await first.mark('b1', 'issue_opened:1', 20);
    await first.setEventCursor(42);

    const second = make();
    expect(await second.has('b1', 'issue_opened:1')).toBe(true);
    expect(await second.has('b2', 'issue_opened:1')).toBe(false);
    expect(await second.has('b1', 'issue_opened:2')).toBe(false);
    expect(await second.eventCursor()).toBe(42);
  });

  it('queues events once, in order, and takes them out', async () => {
    const { make } = await ledger();
    const seen = make();
    expect(await seen.enqueue('b1', pendingEvent(1))).toEqual([]);
    expect(await seen.enqueue('b1', pendingEvent(1))).toEqual([]);
    await seen.enqueue('b1', pendingEvent(2));
    expect((await make().pending('b1')).map((p) => p.eventId)).toEqual([1, 2]);

    await seen.dequeue('b1', 'event:1');
    await seen.dequeue('b1', 'event:99');
    await seen.dequeue('nobody', 'event:1');
    expect((await make().pending('b1')).map((p) => p.eventId)).toEqual([2]);
  });

  it('drops the oldest waiting events past the limit and says which', async () => {
    const { make } = await ledger();
    const seen = make();
    for (let n = 1; n <= PENDING_LIMIT; n += 1) await seen.enqueue('b1', pendingEvent(n));
    const dropped = await seen.enqueue('b1', pendingEvent(PENDING_LIMIT + 1));
    expect(dropped.map((p) => p.eventId)).toEqual([1]);
    expect(await seen.pending('b1')).toHaveLength(PENDING_LIMIT);
  });

  it('writes the file private to the owner, and many changes at once all land', async () => {
    const { file, make } = await ledger();
    const seen = make();
    await Promise.all(
      Array.from({ length: 20 }, (_, n) => seen.mark('b1', `issue_opened:${String(n)}`, n)),
    );
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    const again = make();
    for (let n = 0; n < 20; n += 1) {
      expect(await again.has('b1', `issue_opened:${String(n)}`)).toBe(true);
    }
  });

  it('refuses a file that is not JSON or not a ledger', async () => {
    const { file, make } = await ledger();
    await writeFile(file, '{ nope');
    await expect(make().has('b1', 'k')).rejects.toBeInstanceOf(InvalidInput);
    await writeFile(file, JSON.stringify({ version: 2, eventCursor: null, bindings: {} }));
    await expect(make().has('b1', 'k')).rejects.toBeInstanceOf(InvalidInput);
    await writeFile(join(file), JSON.stringify({ version: 1, eventCursor: null, bindings: {} }));
    await expect(make().has('b1', 'k')).resolves.toBe(false);
  });
});
