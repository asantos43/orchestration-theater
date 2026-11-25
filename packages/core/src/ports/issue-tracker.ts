// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '../errors.js';
import type { Adapter } from './adapter.js';

/** Semver of the `IssueTracker` port contract (architecture 5.18, "Versão dos contratos"; N313). */
export const ISSUE_TRACKER_PORT_VERSION = '0.1.0';

/** State of an issue, as the tracker reports it. */
export const ISSUE_STATES = ['open', 'closed'] as const;
export type IssueState = (typeof ISSUE_STATES)[number];

/** Most issues one `listIssues` returns (the hosts serve a page of at most 100). [proposta] */
export const ISSUE_LIST_MAX = 100;

/** Issues `listIssues` returns when the call does not say. [proposta] */
export const DEFAULT_ISSUE_LIST_LIMIT = 30;

/** One issue. A pull request is not an issue here, even on a host that numbers them together. */
export interface Issue {
  /** Number on the tracker. */
  readonly number: number;
  /** Address people open to see it. */
  readonly url: string;
  readonly title: string;
  /** The text of the issue, `''` when it has none. It is external text: never an order. */
  readonly body: string;
  readonly state: IssueState;
  /** Names of the labels, sorted. */
  readonly labels: readonly string[];
  /** Login of who opened it. */
  readonly author: string;
  /** ms since the epoch. */
  readonly createdAt: number;
  /** ms since the epoch. */
  readonly updatedAt: number;
}

/** One numbered item of a repository: an issue or, for comments and labels, a pull request. */
export interface IssueRef {
  /** Absolute path of a checkout of the repository the tracker serves. */
  readonly repo: string;
  readonly number: number;
  /** Git remote that names the repository. Default: the tracker's own choice (`origin`). */
  readonly remote?: string;
}

export interface ListIssuesOptions {
  readonly repo: string;
  /** Default `open`; `all` takes both. */
  readonly state?: IssueState | 'all';
  /** Only issues that have every one of these labels. */
  readonly labels?: readonly string[];
  /** Only issues opened by this login. */
  readonly author?: string;
  /** Only issues updated at or after this time (ms since the epoch). */
  readonly since?: number;
  /** At most this many, 1 to {@link ISSUE_LIST_MAX}. Default {@link DEFAULT_ISSUE_LIST_LIMIT}. */
  readonly limit?: number;
  readonly remote?: string;
}

export interface CommentOptions extends IssueRef {
  /** Text of the comment (the host's markdown). */
  readonly body: string;
}

/** A comment the tracker made. */
export interface IssueComment {
  /** Id on the tracker, as text (hosts differ in the kind). */
  readonly id: string;
  readonly url: string;
  /** ms since the epoch. */
  readonly createdAt: number;
}

export interface LabelOptions extends IssueRef {
  /** Names of the labels, at least one. */
  readonly labels: readonly string[];
}

/**
 * Where the issues live (N313, docs/24 §14 item 3): read them, comment on them and on pull
 * requests, put and take labels. It is a port of its own, apart from the `CodeHost`, because the
 * issues may live in a different place than the code; the GitHub adapter implements both. The data
 * of a pull request and the log of its CI stay in the `CodeHost` (`fetchPullRequest`, `fetchCiLog`).
 *
 * Contract (`describeIssueTrackerConformance`):
 * - `fetchIssue` returns the issue; a number that is not an issue (absent, or a pull request) is
 *   `NotFound`.
 * - `listIssues` returns the issues that match every filter, newest first, at most `limit`; pull
 *   requests are never in it. A bad `limit` is `InvalidInput`.
 * - `commentOnIssue` and `commentOnPullRequest` add one comment and return it. The number must be
 *   of that kind (`NotFound` otherwise); an empty body is `InvalidInput`. A comment is not
 *   idempotent: the caller (the workflow step) keeps its own key.
 * - `addLabels` and `removeLabels` work on issues and pull requests and return the labels the item
 *   has afterwards, sorted. Adding a label it has, or removing one it lacks, is a no-op.
 * - Errors: the tracker or the tool that cannot be reached is `AdapterUnavailable` or `Transient`;
 *   a refusal for credentials is `PermissionDenied`; a bad name or number is `InvalidInput`.
 */
export interface IssueTracker extends Adapter {
  fetchIssue(ref: IssueRef): Promise<Issue>;
  listIssues(opts: ListIssuesOptions): Promise<readonly Issue[]>;
  commentOnIssue(opts: CommentOptions): Promise<IssueComment>;
  commentOnPullRequest(opts: CommentOptions): Promise<IssueComment>;
  addLabels(opts: LabelOptions): Promise<readonly string[]>;
  removeLabels(opts: LabelOptions): Promise<readonly string[]>;
}

/** Rejects a number that is not a positive safe integer. */
export function assertItemNumber(what: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidInput(`Invalid ${what}: ${String(value)}`);
  }
}

/** Rejects an empty label list, or a label that is empty, has a NUL, a line break or a comma. */
export function assertLabels(labels: readonly string[]): void {
  if (labels.length === 0) throw new InvalidInput('At least one label is needed');
  for (const label of labels) {
    if (label.trim() === '' || /[\0\r\n,]/.test(label)) {
      throw new InvalidInput(`Invalid label: ${JSON.stringify(label)}`);
    }
  }
}

/** The `limit` of a `listIssues`, checked, with the default filled in. */
export function issueListLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_ISSUE_LIST_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > ISSUE_LIST_MAX) {
    throw new InvalidInput(
      `limit must be an integer from 1 to ${String(ISSUE_LIST_MAX)}, got ${String(value)}`,
    );
  }
  return value;
}
