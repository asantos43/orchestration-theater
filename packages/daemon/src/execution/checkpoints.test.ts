// SPDX-License-Identifier: MPL-2.0
import type { Vcs } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { CheckpointTracker } from './checkpoints.js';
import type { AttemptJournal } from './journal.js';

type Written = NonNullable<Parameters<AttemptJournal['write']>[0]>;

/** The tracker only writes and reads `record`: a journal that keeps what it was given is enough. */
function journalOf(written: Written[]): AttemptJournal {
  return {
    record: { lastCheckpoint: null },
    write: (event: Written) => {
      written.push(event);
      return Promise.resolve();
    },
  } as unknown as AttemptJournal;
}

function trackerOf(vcs: Partial<Vcs>, written: Written[]): CheckpointTracker {
  return new CheckpointTracker({
    vcs: vcs as Vcs,
    clock: new FakeClock(),
    journal: journalOf(written),
    worktree: '/wt',
    branch: 'play/p1/a1',
    correlation: { playId: 'p1', demandId: 'd1', attemptId: 'a1' },
    editBatch: 0,
    everyMs: 0,
    onError: () => undefined,
  });
}

describe('CheckpointTracker, a commit that fails (P18b)', () => {
  it('writes attempt.checkpoint_failed with a masked error and still rejects', async () => {
    const written: Written[] = [];
    const key = 'sk-abcdefghijklmnopqrstuvwx';
    const tracker = trackerOf(
      { checkpoint: () => Promise.reject(new Error(`git said no, token ${key}`)) },
      written,
    );
    await expect(tracker.take('interval')).rejects.toThrow('git said no');
    expect(written).toHaveLength(1);
    const event = written[0];
    expect(event?.type).toBe('attempt.checkpoint_failed');
    const payload = event?.payload as { error: string };
    expect(payload).toMatchObject({
      reason: 'interval',
      branch: 'play/p1/a1',
      playId: 'p1',
      demandId: 'd1',
      attemptId: 'a1',
    });
    expect(payload.error).toContain('git said no');
    expect(payload.error).not.toContain(key);
  });

  it('writes attempt.checkpoint on success and nothing when there is nothing to commit', async () => {
    const written: Written[] = [];
    const tracker = trackerOf({ checkpoint: () => Promise.resolve('abc123') }, written);
    expect(await tracker.take('interruption')).toBe('abc123');
    expect(written.map((event) => event.type)).toEqual(['attempt.checkpoint']);

    const idle: Written[] = [];
    const quiet = trackerOf({ checkpoint: () => Promise.resolve(undefined) }, idle);
    expect(await quiet.take('interval')).toBeUndefined();
    expect(idle).toHaveLength(0);
  });
});
