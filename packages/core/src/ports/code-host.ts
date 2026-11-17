// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '../errors.js';
import type { Adapter } from './adapter.js';

/** Semver of the `CodeHost` port contract (architecture 5.18, "Versão dos contratos"). */
export const CODE_HOST_PORT_VERSION = '0.1.0';

/** Remote used when a call does not name one. [proposta] */
export const DEFAULT_REMOTE = 'origin';

/** State of a pull request, as the host reports it. */
export const PULL_REQUEST_STATES = ['open', 'closed', 'merged'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/** A branch of a repository, on the remote the host serves. */
export interface BranchTarget {
  /** Absolute path of a checkout of the repository (any of its worktrees). */
  readonly repo: string;
  /** Branch name, without `refs/heads/`. */
  readonly branch: string;
  /** Git remote that points at the host. Default {@link DEFAULT_REMOTE}. */
  readonly remote?: string;
}

/** One pull request (or the equivalent of the host). */
export interface PullRequest {
  /** Number on the host. */
  readonly number: number;
  /** Address people open to see it. */
  readonly url: string;
  readonly state: PullRequestState;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly title: string;
  readonly draft: boolean;
  /** Creation time on the host, ms since the epoch. */
  readonly createdAt: number;
}

export interface OpenPullRequestOptions {
  readonly repo: string;
  /** Branch with the changes. It must be on the remote already (`pushRef`). */
  readonly head: string;
  /** Branch the changes go into. */
  readonly base: string;
  readonly title: string;
  readonly body: string;
  /** Open as a draft. Default false. */
  readonly draft?: boolean;
  readonly remote?: string;
}

export interface FindPullRequestOptions {
  readonly repo: string;
  readonly head: string;
  /** Only PRs into this base. Default: any. */
  readonly base?: string;
  /** States to look at. Default `['open']`. */
  readonly states?: readonly PullRequestState[];
  readonly remote?: string;
}

export interface MergeBranchOptions {
  readonly repo: string;
  /** Branch merged into `base`, on the remote. */
  readonly head: string;
  readonly base: string;
  /** First line of the merge commit. Default: the host's own. */
  readonly message?: string;
  readonly remote?: string;
}

/** Sha of the commit `base` is at on the remote after a merge. */
export interface MergeBranchResult {
  readonly sha: string;
}

/**
 * Where the code lives and where it is delivered: pushes, pull requests and, when the project
 * allows it, a direct merge (architecture 5.5, 5.18). The default adapter wraps `gh`; GitLab, Gitea
 * and a "local merge" come as other adapters of this same port.
 *
 * Contract (`describeCodeHostConformance`):
 * - `pushRef` is never forced: it creates the ref or fast-forwards it, and returns the sha the
 *   remote has now. A push of what the remote already has is a no-op that returns the same sha. A
 *   ref that cannot be fast-forwarded rejects with `Conflict`; a branch that does not exist in the
 *   checkout is `NotFound`.
 * - `remoteRef` is a question, not an action: it returns the sha or `undefined` when the branch is
 *   not on the remote.
 * - `openPullRequest` creates one PR. When one is already open for the same head and base it rejects
 *   with `Conflict` (the caller adopts that one with `findPullRequest`); a head that is not on the
 *   remote is `NotFound`.
 * - `findPullRequest` returns the newest PR that matches, or `undefined`.
 * - `mergeBranch` merges on the remote, with no PR (the `direct_merge` delivery). A conflict is
 *   `Conflict`; a branch that is not on the remote is `NotFound`.
 * - `isBranchMerged` says whether everything of `head` is already in `base` on the remote.
 * - Errors: the host or the tool that cannot be reached is `AdapterUnavailable` or `Transient`; a
 *   refusal for credentials is `PermissionDenied`; a bad name is `InvalidInput`.
 */
export interface CodeHost extends Adapter {
  pushRef(target: BranchTarget): Promise<string>;
  remoteRef(target: BranchTarget): Promise<string | undefined>;
  openPullRequest(opts: OpenPullRequestOptions): Promise<PullRequest>;
  findPullRequest(opts: FindPullRequestOptions): Promise<PullRequest | undefined>;
  mergeBranch(opts: MergeBranchOptions): Promise<MergeBranchResult>;
  isBranchMerged(opts: Omit<MergeBranchOptions, 'message'>): Promise<boolean>;
}

/** Rejects a branch name that is empty, has a NUL or a line break, or starts with `-` (an option). */
export function assertBranchName(what: string, value: string): void {
  if (value === '' || /[\0\r\n]/.test(value) || value.startsWith('-')) {
    throw new InvalidInput(`Invalid ${what}: ${JSON.stringify(value)}`);
  }
}

/** Rejects an empty or NUL-carrying text. */
export function assertNonEmptyText(what: string, value: string): void {
  if (value.trim() === '' || value.includes('\0')) {
    throw new InvalidInput(`Invalid ${what}: it is empty or has a NUL character`);
  }
}
