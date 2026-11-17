// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { IDEMPOTENCY_TRAILER, withIdempotencyTrailer, type SideEffectRecord } from '@otheater/core';
import { testGit } from '@otheater/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_COMMIT_EFFECT } from '../workspace/verifiers.js';
import {
  ATTEMPT_ID,
  DEMAND_ID,
  eventsOf,
  makeToolsRig,
  realClock,
  PLAY_ID,
  type ToolsRig,
  type ToolsRigOptions,
} from './tools-fixture.js';
import { InMemoryStore } from '@otheater/core/testing';

const rigs: ToolsRig[] = [];

async function rigOf(options: ToolsRigOptions = {}): Promise<ToolsRig> {
  const rig = await makeToolsRig(options, {
    store: new InMemoryStore({ clock: realClock }),
    clock: realClock,
  });
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
});

async function recordsOf(rig: ToolsRig): Promise<readonly SideEffectRecord[]> {
  return await rig.store.sideEffects.list({ types: [GIT_COMMIT_EFFECT], attemptId: ATTEMPT_ID });
}

describe('git_commit', () => {
  it('commits the worktree, carries the key as a trailer and records the effect as done', async () => {
    const rig = await rigOf();
    await rig.write('a.txt', 'a\n');
    const reply = (await rig.call('git_commit', { message: 'Add a' })) as {
      sha: string;
      reused: boolean;
    };
    expect(reply.reused).toBe(false);
    expect(reply.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await rig.deps.vcs.headOf(rig.worktree)).toBe(reply.sha);

    const message = await testGit(rig.worktree, 'log', '-1', '--format=%B');
    expect(message).toContain('Add a');
    expect(message).toContain(IDEMPOTENCY_TRAILER);
    expect(message).toContain(`${PLAY_ID}:${GIT_COMMIT_EFFECT}:${ATTEMPT_ID}:1`);

    const records = await recordsOf(rig);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: 'done', type: GIT_COMMIT_EFFECT });
    expect(records[0]?.result).toMatchObject({ sha: reply.sha });
  });

  it('answers nothing_to_commit for a worktree with no change', async () => {
    const rig = await rigOf();
    const failure = await rig.fail('git_commit', { message: 'Nothing' });
    expect(failure.code).toBe('nothing_to_commit');
    expect(eventsOf(rig, 'tool.finished')[0]?.payload).toMatchObject({
      outcome: 'error',
      errorCode: 'nothing_to_commit',
    });
  });

  it('commits again with the same message once there is new work, as a new step', async () => {
    const rig = await rigOf();
    await rig.write('a.txt', '1\n');
    const first = (await rig.call('git_commit', { message: 'Work' })) as { sha: string };
    await rig.write('a.txt', '2\n');
    const second = (await rig.call('git_commit', { message: 'Work' })) as {
      sha: string;
      reused: boolean;
    };
    expect(second.sha).not.toBe(first.sha);
    expect(second.reused).toBe(false);
    expect(await recordsOf(rig)).toHaveLength(2);
  });

  it('gives the same commit back when the same message is asked again with nothing changed', async () => {
    const rig = await rigOf();
    await rig.write('a.txt', 'a\n');
    const first = (await rig.call('git_commit', { message: 'Add a' })) as { sha: string };
    const again = (await rig.call('git_commit', { message: 'Add a' })) as {
      sha: string;
      reused: boolean;
    };
    expect(again).toEqual({ sha: first.sha, reused: true });
    // A different message with nothing to commit is not a replay.
    expect((await rig.fail('git_commit', { message: 'Something else' })).code).toBe(
      'nothing_to_commit',
    );
  });

  it('settles an open record by the verifier: the commit that was made before the crash is found', async () => {
    const rig = await rigOf();
    await rig.write('a.txt', 'a\n');
    const key = `${PLAY_ID}:${GIT_COMMIT_EFFECT}:${ATTEMPT_ID}:1`;
    // What a call that died after `commitAll` and before `resolve` leaves behind: the commit with
    // its trailer, and a record that is still pending.
    const sha = await rig.deps.vcs.commitAll(rig.worktree, withIdempotencyTrailer('Add a', key));
    expect(sha).toBeDefined();
    await rig.store.sideEffects.intend({
      idempotencyKey: key,
      type: GIT_COMMIT_EFFECT,
      target: rig.branch,
      attemptId: ATTEMPT_ID,
      params: { repo: rig.worktree, branch: rig.branch, messageHash: hashOf('Add a') },
    });

    const reply = (await rig.call('git_commit', { message: 'Add a' })) as {
      sha: string;
      reused: boolean;
    };
    expect(reply).toEqual({ sha, reused: true });
    // Still one commit past the play branch, and the record is done.
    const log = await testGit(rig.worktree, 'rev-list', '--count', `play/${PLAY_ID}/base..HEAD`);
    expect(log.trim()).toBe('1');
    expect((await recordsOf(rig)).map((record) => record.state)).toEqual(['done']);
  });

  it('answers no_attempt and no_worktree for a session that is not an attempt', async () => {
    const rig = await rigOf({ withoutAttempt: true });
    await rig.write('a.txt', 'a\n');
    expect((await rig.fail('git_commit', { message: 'x' })).code).toBe('no_attempt');
    expect((await rig.fail('git_commit', { message: 'x' }, { worktree: undefined })).code).toBe(
      'no_worktree',
    );
  });

  it('is not an escape hatch: the restricted shell still cannot commit or push', async () => {
    const rig = await rigOf();
    await rig.write('a.txt', 'a\n');
    expect((await rig.fail('restricted_shell', { argv: ['git', 'commit', '-am', 'x'] })).code).toBe(
      'program_not_allowed',
    );
    expect((await rig.fail('restricted_shell', { argv: ['git', 'add', '-A'] })).code).toBe(
      'program_not_allowed',
    );
  });
});

function hashOf(message: string): string {
  return createHash('sha256').update(message).digest('hex').slice(0, 16);
}

describe('view_diff', () => {
  it('shows what the attempt did since the branch of the play', async () => {
    const rig = await rigOf();
    await rig.write('new.txt', 'brand new\n');
    await rig.call('git_commit', { message: 'Add new' });
    const reply = (await rig.call('view_diff', {})) as {
      diff: string;
      truncated: boolean;
      originalBytes: number;
    };
    expect(reply.diff).toContain('new.txt');
    expect(reply.diff).toContain('+brand new');
    expect(reply.truncated).toBe(false);
  });

  it('shows the latest attempt of a named demand, from another session', async () => {
    const rig = await rigOf();
    await rig.write('new.txt', 'brand new\n');
    await rig.call('git_commit', { message: 'Add new' });
    const critic = {
      role: 'critic',
      attemptId: 'p1/review/1',
      correlation: { playId: PLAY_ID, demandId: 'review', attemptId: 'p1/review/1' },
    };
    const reply = (await rig.call('view_diff', { demand: DEMAND_ID }, critic)) as { diff: string };
    expect(reply.diff).toContain('+brand new');
    expect((await rig.fail('view_diff', { demand: 'nope' }, critic)).code).toBe('not_found');
  });

  it('cuts the diff to output_max_bytes', async () => {
    const rig = await rigOf({ tools: '  output_max_bytes: 300' });
    await rig.write('big.txt', 'line of text\n'.repeat(500));
    await rig.call('git_commit', { message: 'Add big' });
    const reply = (await rig.call('view_diff', {})) as {
      diff: string;
      truncated: boolean;
      originalBytes: number;
    };
    expect(reply.truncated).toBe(true);
    expect(reply.originalBytes).toBeGreaterThan(300);
    expect(Buffer.byteLength(reply.diff)).toBeLessThan(900);
    expect(eventsOf(rig, 'tool.finished').at(-1)?.payload).toMatchObject({ truncated: true });
  });

  it('answers an empty diff for an attempt that changed nothing', async () => {
    const rig = await rigOf();
    expect(await rig.call('view_diff', {})).toMatchObject({ diff: '', truncated: false });
  });
});
