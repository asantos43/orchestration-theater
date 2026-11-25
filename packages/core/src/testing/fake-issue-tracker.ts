// SPDX-License-Identifier: MPL-2.0
import { NotFound } from '../errors.js';
import type { AdapterImplements } from '../ports/adapter.js';
import { assertNonEmptyText } from '../ports/code-host.js';
import {
  assertItemNumber,
  assertLabels,
  ISSUE_TRACKER_PORT_VERSION,
  issueListLimit,
  type CommentOptions,
  type Issue,
  type IssueComment,
  type IssueRef,
  type IssueState,
  type IssueTracker,
  type LabelOptions,
  type ListIssuesOptions,
} from '../ports/issue-tracker.js';

/** Methods of the port a test can make fail with {@link FakeIssueTracker.failNext}. */
export type IssueTrackerMethod =
  | 'fetchIssue'
  | 'listIssues'
  | 'commentOnIssue'
  | 'commentOnPullRequest'
  | 'addLabels'
  | 'removeLabels';

/** One call the fake received, for the assertions of a test. */
export interface IssueTrackerCall {
  readonly method: IssueTrackerMethod;
  readonly args: unknown;
}

/** An issue a test puts on the tracker ({@link FakeIssueTracker.seedIssue}). */
export interface FakeIssueInput {
  readonly title: string;
  readonly body?: string;
  /** Default `open`. */
  readonly state?: IssueState;
  readonly labels?: readonly string[];
  /** Default {@link FAKE_ISSUE_AUTHOR}. */
  readonly author?: string;
  /** ms since the epoch. Default: the clock. */
  readonly createdAt?: number;
  /** ms since the epoch. Default: `createdAt`. */
  readonly updatedAt?: number;
}

/** A comment the fake keeps, as the tests read it back. */
export interface FakeComment extends IssueComment {
  readonly number: number;
  readonly kind: 'issue' | 'pull_request';
  readonly body: string;
}

/** Login of who opens the issues of the fake, when the seed does not say. */
export const FAKE_ISSUE_AUTHOR = 'fake-user';

export interface FakeIssueTrackerOptions {
  /** Source of the times. Default: the system time. */
  readonly clock?: { now(): number };
}

interface Item {
  readonly kind: 'issue' | 'pull_request';
  issue: Issue;
}

/**
 * An issue tracker in memory: issues and pull requests share one numbering, as on GitHub. Pull
 * requests exist here only as numbers that take comments and labels ({@link seedPullRequest}).
 * Meant for the tests of the workflow steps (P8 of Phase 11b) and for the conformance suite
 * (`describeIssueTrackerConformance`).
 *
 * Every call is recorded in {@link calls}; `failNext` makes the next call of a method reject.
 */
export class FakeIssueTracker implements IssueTracker {
  readonly id = 'fake';
  readonly implements: AdapterImplements = {
    port: 'IssueTracker',
    range: `^${ISSUE_TRACKER_PORT_VERSION}`,
  };

  /** Every call received, in order. */
  readonly calls: IssueTrackerCall[] = [];

  readonly #now: () => number;
  readonly #items = new Map<number, Item>();
  readonly #comments: FakeComment[] = [];
  readonly #failures = new Map<IssueTrackerMethod, Error[]>();
  #counter = 0;
  #commentCounter = 0;

  constructor(options: FakeIssueTrackerOptions = {}) {
    const clock = options.clock;
    this.#now = clock === undefined ? () => Date.now() : () => clock.now();
  }

  // -- Test setup ---------------------------------------------------------------------------

  /** Opens an issue with the next number. Returns it. */
  seedIssue(input: FakeIssueInput): Issue {
    const number = this.#next();
    const createdAt = input.createdAt ?? this.#now();
    const issue: Issue = {
      number,
      url: `https://issues.invalid/issues/${String(number)}`,
      title: input.title,
      body: input.body ?? '',
      state: input.state ?? 'open',
      labels: sortedLabels(input.labels ?? []),
      author: input.author ?? FAKE_ISSUE_AUTHOR,
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
    };
    this.#items.set(number, { kind: 'issue', issue });
    return issue;
  }

  /**
   * Makes a pull request exist on the tracker, with the next number or with `number` (one the
   * `CodeHost` of the test gave). Returns its number.
   */
  seedPullRequest(number?: number): number {
    const value = number ?? this.#next();
    assertItemNumber('pull request number', value);
    if (this.#items.has(value)) throw new Error(`Number ${String(value)} is already taken`);
    this.#counter = Math.max(this.#counter, value);
    const now = this.#now();
    this.#items.set(value, {
      kind: 'pull_request',
      issue: {
        number: value,
        url: `https://issues.invalid/pull/${String(value)}`,
        title: `pull request ${String(value)}`,
        body: '',
        state: 'open',
        labels: [],
        author: FAKE_ISSUE_AUTHOR,
        createdAt: now,
        updatedAt: now,
      },
    });
    return value;
  }

  /** The next call of `method` rejects with `error` (queued: one error per call). */
  failNext(method: IssueTrackerMethod, error: Error): void {
    const queue = this.#failures.get(method) ?? [];
    queue.push(error);
    this.#failures.set(method, queue);
  }

  // -- Inspection ---------------------------------------------------------------------------

  /** The comments made, oldest first; with `number`, only those on that item. */
  comments(number?: number): readonly FakeComment[] {
    return number === undefined
      ? [...this.#comments]
      : this.#comments.filter((comment) => comment.number === number);
  }

  /** The labels of an issue or pull request, sorted. */
  labelsOf(number: number): readonly string[] {
    return this.#items.get(number)?.issue.labels ?? [];
  }

  /** How many calls of `method` were made. */
  callCount(method: IssueTrackerMethod): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  // -- The port -----------------------------------------------------------------------------

  fetchIssue(ref: IssueRef): Promise<Issue> {
    return this.#run('fetchIssue', ref, () => this.#item(ref.number, 'issue').issue);
  }

  listIssues(opts: ListIssuesOptions): Promise<readonly Issue[]> {
    return this.#run('listIssues', opts, () => {
      const limit = issueListLimit(opts.limit);
      const state = opts.state ?? 'open';
      const wanted = opts.labels ?? [];
      if (wanted.length > 0) assertLabels(wanted);
      return [...this.#items.values()]
        .filter((item) => item.kind === 'issue')
        .map((item) => item.issue)
        .filter((issue) => state === 'all' || issue.state === state)
        .filter((issue) => wanted.every((label) => issue.labels.includes(label)))
        .filter((issue) => opts.author === undefined || issue.author === opts.author)
        .filter((issue) => opts.since === undefined || issue.updatedAt >= opts.since)
        .sort((a, b) => b.createdAt - a.createdAt || b.number - a.number)
        .slice(0, limit);
    });
  }

  commentOnIssue(opts: CommentOptions): Promise<IssueComment> {
    return this.#run('commentOnIssue', opts, () => this.#comment(opts, 'issue'));
  }

  commentOnPullRequest(opts: CommentOptions): Promise<IssueComment> {
    return this.#run('commentOnPullRequest', opts, () => this.#comment(opts, 'pull_request'));
  }

  addLabels(opts: LabelOptions): Promise<readonly string[]> {
    return this.#run('addLabels', opts, () => {
      assertLabels(opts.labels);
      const item = this.#item(opts.number);
      const labels = sortedLabels([...item.issue.labels, ...opts.labels]);
      this.#touch(item, labels);
      return labels;
    });
  }

  removeLabels(opts: LabelOptions): Promise<readonly string[]> {
    return this.#run('removeLabels', opts, () => {
      assertLabels(opts.labels);
      const item = this.#item(opts.number);
      const labels = item.issue.labels.filter((label) => !opts.labels.includes(label));
      this.#touch(item, labels);
      return labels;
    });
  }

  // -- Internals ----------------------------------------------------------------------------

  #next(): number {
    this.#counter += 1;
    return this.#counter;
  }

  #item(number: number, kind?: Item['kind']): Item {
    assertItemNumber(kind === 'pull_request' ? 'pull request number' : 'issue number', number);
    const item = this.#items.get(number);
    if (item === undefined || (kind !== undefined && item.kind !== kind)) {
      const what = kind === 'pull_request' ? 'pull request' : kind === 'issue' ? 'issue' : 'item';
      throw new NotFound(`No ${what} #${String(number)}`);
    }
    return item;
  }

  #comment(opts: CommentOptions, kind: Item['kind']): IssueComment {
    const item = this.#item(opts.number, kind);
    assertNonEmptyText('comment body', opts.body);
    this.#commentCounter += 1;
    const id = String(this.#commentCounter);
    const comment: FakeComment = {
      id,
      url: `${item.issue.url}#comment-${id}`,
      createdAt: this.#now(),
      number: opts.number,
      kind,
      body: opts.body,
    };
    this.#comments.push(comment);
    item.issue = { ...item.issue, updatedAt: comment.createdAt };
    return { id: comment.id, url: comment.url, createdAt: comment.createdAt };
  }

  #touch(item: Item, labels: readonly string[]): void {
    const same =
      labels.length === item.issue.labels.length &&
      labels.every((label, index) => label === item.issue.labels[index]);
    if (!same) item.issue = { ...item.issue, labels, updatedAt: this.#now() };
  }

  #run<T>(method: IssueTrackerMethod, args: unknown, fn: () => T): Promise<T> {
    try {
      this.calls.push({ method, args });
      const error = this.#failures.get(method)?.shift();
      if (error !== undefined) throw error;
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function sortedLabels(labels: readonly string[]): readonly string[] {
  return [...new Set(labels)].sort();
}
