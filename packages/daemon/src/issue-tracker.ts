// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  DEFAULT_REMOTE,
  ISSUE_TRACKER_PORT_VERSION,
  type AdapterImplements,
  type CodeHost,
  type CommentOptions,
  type Issue,
  type IssueComment,
  type IssueRef,
  type IssueTracker,
  type LabelOptions,
  type ListIssuesOptions,
} from '@otheater/core';

/**
 * The issue trackers of the daemon that are not an adapter (Phase 11b, P7, N313). `compose.ts` is
 * the only file that imports adapters, so the tracker of `adapters.issue_tracker: none` and the
 * one that follows the code host of each repository live here, over the ports.
 */

const IMPLEMENTS: AdapterImplements = {
  port: 'IssueTracker',
  range: `^${ISSUE_TRACKER_PORT_VERSION}`,
};

/**
 * No issue tracker: every call is `AdapterUnavailable`, with the reason (`adapters.issue_tracker`
 * is `none`, or the repository has no GitHub host). The workflow step that needs issues reports
 * it; nothing is read or written anywhere. [proposta]
 */
export class NoIssueTracker implements IssueTracker {
  readonly id = 'none';
  readonly implements = IMPLEMENTS;

  readonly #reason: (repo: string) => string;

  constructor(reason: (repo: string) => string = () => 'adapters.issue_tracker is none') {
    this.#reason = reason;
  }

  fetchIssue(ref: IssueRef): Promise<Issue> {
    return this.#refuse(ref.repo);
  }

  listIssues(opts: ListIssuesOptions): Promise<readonly Issue[]> {
    return this.#refuse(opts.repo);
  }

  commentOnIssue(opts: CommentOptions): Promise<IssueComment> {
    return this.#refuse(opts.repo);
  }

  commentOnPullRequest(opts: CommentOptions): Promise<IssueComment> {
    return this.#refuse(opts.repo);
  }

  addLabels(opts: LabelOptions): Promise<readonly string[]> {
    return this.#refuse(opts.repo);
  }

  removeLabels(opts: LabelOptions): Promise<readonly string[]> {
    return this.#refuse(opts.repo);
  }

  #refuse<T>(repo: string): Promise<T> {
    return Promise.reject(
      new AdapterUnavailable(`There is no issue tracker for ${repo}: ${this.#reason(repo)}`),
    );
  }
}

export interface SameHostIssueTrackerOptions {
  /** The host choice of `adapters.code_host: auto`, per `(repo, remote)`. */
  readonly hostFor: (repo: string, remote: string) => Promise<CodeHost>;
  /** The GitHub code host `hostFor` may answer with; `undefined` when it was not built. */
  readonly githubHost: CodeHost | undefined;
  /** The tracker used where the code host is GitHub. */
  readonly github: IssueTracker | undefined;
  /** The tracker used everywhere else. */
  readonly none: IssueTracker;
}

/**
 * `adapters.issue_tracker: same_as_code_host` with `adapters.code_host: auto`: the issues of a
 * repository are on GitHub when its code host is, and there is no tracker otherwise. It asks the
 * code host, so the two never disagree about a repository. [proposta]
 */
export class SameHostIssueTracker implements IssueTracker {
  readonly id = 'same_as_code_host';
  readonly implements = IMPLEMENTS;

  readonly #options: SameHostIssueTrackerOptions;

  constructor(options: SameHostIssueTrackerOptions) {
    this.#options = options;
  }

  fetchIssue(ref: IssueRef): Promise<Issue> {
    return this.#pick(ref).then((tracker) => tracker.fetchIssue(ref));
  }

  listIssues(opts: ListIssuesOptions): Promise<readonly Issue[]> {
    return this.#pick(opts).then((tracker) => tracker.listIssues(opts));
  }

  commentOnIssue(opts: CommentOptions): Promise<IssueComment> {
    return this.#pick(opts).then((tracker) => tracker.commentOnIssue(opts));
  }

  commentOnPullRequest(opts: CommentOptions): Promise<IssueComment> {
    return this.#pick(opts).then((tracker) => tracker.commentOnPullRequest(opts));
  }

  addLabels(opts: LabelOptions): Promise<readonly string[]> {
    return this.#pick(opts).then((tracker) => tracker.addLabels(opts));
  }

  removeLabels(opts: LabelOptions): Promise<readonly string[]> {
    return this.#pick(opts).then((tracker) => tracker.removeLabels(opts));
  }

  async #pick(ref: { readonly repo: string; readonly remote?: string }): Promise<IssueTracker> {
    const { hostFor, githubHost, github, none } = this.#options;
    if (github === undefined || githubHost === undefined) return none;
    const host = await hostFor(ref.repo, ref.remote ?? DEFAULT_REMOTE);
    return host === githubHost ? github : none;
  }
}
