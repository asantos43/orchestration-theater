// SPDX-License-Identifier: MPL-2.0
import { canListComments, type IssueTracker } from '@otheater/core';
import type { CommentFinder } from './steps/codehost/index.js';

/**
 * The finder of comments of the daemon (Phase 11b, P10b; [proposta]): it settles a `comment` that a
 * crash cut off, by looking for the marker of its idempotency key in the comments of the issue or
 * the pull request, instead of ending `effect_ambiguous`. It exists only when the issue tracker also
 * lists comments (`IssueCommentLister`, a port of its own so the contract of the tracker did not
 * change); without one the daemon wires none, and an open `comment` stays ambiguous as before.
 *
 * `CommentFinder` has no way to say "I could not look at everything", so a thread that has as many
 * comments as the limit and no marker in them is an error, not an absence: the verifier then
 * answers `ambiguous` (the registry of the effects turns a throw into that), and a second comment
 * is never posted on a guess.
 */

/** The comments read of a thread: the marker of an old comment of a very long thread is out of reach. [proposta] */
export const COMMENT_FINDER_LIMIT = 1000;

export function commentFinderOf(
  tracker: IssueTracker,
  limit: number = COMMENT_FINDER_LIMIT,
): CommentFinder | undefined {
  if (!canListComments(tracker)) return undefined;
  return async (query) => {
    const comments = await tracker.listComments({
      repo: query.repo,
      number: query.number,
      limit,
    });
    const found = comments.find((comment) => comment.body.includes(query.marker));
    if (found !== undefined) return { id: found.id, url: found.url };
    if (comments.length >= limit) {
      throw new Error(
        `the thread has ${String(comments.length)} comments or more, more than the finder reads (${String(limit)})`,
      );
    }
    return undefined;
  };
}
