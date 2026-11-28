// SPDX-License-Identifier: MPL-2.0
import type { ListCommentsOptions, ListedComment, SideEffectRecord } from '@otheater/core';
import { FakeIssueTracker } from '@otheater/core/testing';
import { describe, expect, it } from 'vitest';
import { commentFinderOf } from './comment-finder.js';
import { commentMarker, verifyComment } from './steps/codehost/index.js';

const REPO = '/repo';

/** A tracker that also lists comments, as the GitHub one does. */
class ListingTracker extends FakeIssueTracker {
  asked: ListCommentsOptions[] = [];

  listComments(opts: ListCommentsOptions): Promise<readonly ListedComment[]> {
    this.asked.push(opts);
    return Promise.resolve(
      this.comments(opts.number)
        .slice(0, opts.limit)
        .map((comment) => ({
          id: comment.id,
          url: comment.url,
          createdAt: comment.createdAt,
          body: comment.body,
        })),
    );
  }
}

function recordOf(key: string, number: number): SideEffectRecord {
  return {
    idempotencyKey: key,
    params: { repo: REPO, number, target: 'issue', marked: true },
  } as unknown as SideEffectRecord;
}

describe('commentFinderOf', () => {
  it('is absent for a tracker that cannot list comments', () => {
    expect(commentFinderOf(new FakeIssueTracker())).toBeUndefined();
  });

  it('finds the comment that carries the marker, and says none when there is not one', async () => {
    const tracker = new ListingTracker();
    const issue = tracker.seedIssue({ title: 'bug' });
    await tracker.commentOnIssue({ repo: REPO, number: issue.number, body: 'first' });
    const marker = commentMarker('key-1');
    const posted = await tracker.commentOnIssue({
      repo: REPO,
      number: issue.number,
      body: `done\n\n${marker}`,
    });
    const find = commentFinderOf(tracker);
    expect(find).toBeDefined();
    const query = { repo: REPO, number: issue.number, target: 'issue' as const, marker };
    expect(await find?.(query)).toEqual({ id: posted.id, url: posted.url });
    expect(await find?.({ ...query, marker: commentMarker('key-2') })).toBeUndefined();
  });

  it('refuses to say "none" when the thread is longer than it reads', async () => {
    const tracker = new ListingTracker();
    const issue = tracker.seedIssue({ title: 'bug' });
    for (let index = 0; index < 3; index += 1) {
      await tracker.commentOnIssue({ repo: REPO, number: issue.number, body: `c${String(index)}` });
    }
    const find = commentFinderOf(tracker, 3);
    await expect(
      find?.({ repo: REPO, number: issue.number, target: 'issue', marker: commentMarker('x') }),
    ).rejects.toThrow(/more than the finder reads/);
  });

  it('settles a comment a crash cut off: done when it got there, not_done when it did not', async () => {
    const tracker = new ListingTracker();
    const issue = tracker.seedIssue({ title: 'bug' });
    const key = 'run-1:say:1';
    const deps = { findComment: commentFinderOf(tracker) };
    expect(await verifyComment(deps, recordOf(key, issue.number))).toEqual({ verdict: 'not_done' });
    const posted = await tracker.commentOnIssue({
      repo: REPO,
      number: issue.number,
      body: `hello\n\n${commentMarker(key)}`,
    });
    expect(await verifyComment(deps, recordOf(key, issue.number))).toEqual({
      verdict: 'done',
      result: { id: posted.id, url: posted.url },
    });
  });

  it('stays ambiguous without a finder', async () => {
    const verdict = await verifyComment({ findComment: undefined }, recordOf('k', 1));
    expect(verdict.verdict).toBe('ambiguous');
  });
});
