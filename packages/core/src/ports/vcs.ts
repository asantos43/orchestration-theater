// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '../errors.js';
import type { Adapter } from './adapter.js';

/** Semver of the `Vcs` port contract (architecture 5.18, "Versão dos contratos"). */
export const VCS_PORT_VERSION = '0.1.0';

/** Prefix of the checkpoint commits (architecture 5.16, "Checkpoints"). */
export const CHECKPOINT_PREFIX = 'wip(checkpoint): ';

/** One worktree of a repository, as `listWorktrees` reports it. */
export interface WorktreeInfo {
  /** Absolute path of the worktree directory. */
  readonly path: string;
  /** Branch checked out; `undefined` for a detached HEAD. */
  readonly branch: string | undefined;
  /** Commit the worktree is at (full sha). */
  readonly head: string;
  /** This is the main worktree of the repository (the one that cannot be removed). */
  readonly main: boolean;
}

export interface CreateWorktreeOptions {
  /** Absolute path of the repository (any of its worktrees). */
  readonly repo: string;
  /** Absolute path where the new worktree is created; must not exist yet. */
  readonly path: string;
  /** New branch to create and check out there. */
  readonly branch: string;
  /** Ref the new branch starts from: a branch name or a sha. */
  readonly base: string;
}

export interface RemoveWorktreeOptions {
  /** Remove even with uncommitted changes. Default false: those make it reject with `Conflict`. */
  readonly force?: boolean;
  /** Also delete the branch of the worktree. Default false (checkpoints stay reachable). */
  readonly deleteBranch?: boolean;
}

export interface CommitOptions {
  /** Create a commit even when nothing changed. Default false. */
  readonly allowEmpty?: boolean;
}

/** One file of a {@link DiffStat}; counts are `undefined` for a binary file. */
export interface DiffStatFile {
  readonly path: string;
  readonly insertions: number | undefined;
  readonly deletions: number | undefined;
}

/** Summary of the difference between a worktree and a base (`git diff --numstat`). */
export interface DiffStat {
  readonly filesChanged: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly files: readonly DiffStatFile[];
}

/**
 * Version control of a local repository, as the Workspace needs it (architecture 5.5, 5.16). The
 * default adapter wraps the `git` CLI.
 *
 * Out of this version, on purpose: merge (`INTEGRATING`), push and the pull request (`CodeHost`).
 * They come with the phases that need them, and adding them is a new, optional capability
 * (an interface of its own plus a guard), not a change to this one.
 *
 * Errors: a missing repository, worktree or ref is `NotFound`; an existing branch or path, or a
 * dirty worktree on a non-forced removal, is `Conflict`; `git` that cannot run is
 * `AdapterUnavailable`; a bad name is `InvalidInput`.
 */
export interface Vcs extends Adapter {
  /** Creates `branch` from `base` and checks it out in a new worktree at `path`. */
  createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeInfo>;
  removeWorktree(worktree: string, opts?: RemoveWorktreeOptions): Promise<void>;
  listWorktrees(repo: string): Promise<readonly WorktreeInfo[]>;
  /**
   * Stages everything (new, changed and deleted files) and commits. Returns the sha of the new
   * commit, or `undefined` when there was nothing to commit and `allowEmpty` is not set.
   */
  commitAll(worktree: string, message: string, opts?: CommitOptions): Promise<string | undefined>;
  /**
   * `commitAll` with the message {@link checkpointMessage}`(label)`. `undefined` when the worktree
   * has no change (the last checkpoint is still the head).
   */
  checkpoint(worktree: string, label: string): Promise<string | undefined>;
  /** Full sha of the commit the worktree is at. */
  headOf(worktree: string): Promise<string>;
  /** Changes of the worktree (committed and not) relative to `base` (a ref or a sha). */
  diffStat(worktree: string, base: string): Promise<DiffStat>;
}

/**
 * Ids that go into branch names: lowercase alphanumerics and `-`, starting and ending with an
 * alphanumeric, at most {@link MAX_BRANCH_ID_LENGTH} characters. [proposta]
 */
export const BRANCH_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const MAX_BRANCH_ID_LENGTH = 64;

/**
 * Every branch of a play lives under `play/<id>/` (N59). git cannot hold a ref and another ref
 * below it (`play/42` and `play/42/d1/1`), so the play branch itself is `play/<id>/base`, and the
 * attempts sit under their own `attempts/` segment, which leaves every demand id free.
 */
export const PLAY_BASE_SEGMENT = 'base';
export const PLAY_ATTEMPTS_SEGMENT = 'attempts';
export const PLAY_INTEGRATION_SEGMENT = 'integration';

function assertBranchId(kind: string, value: string): void {
  if (value.length > MAX_BRANCH_ID_LENGTH || !BRANCH_ID_PATTERN.test(value)) {
    throw new InvalidInput(
      `Invalid ${kind} for a branch name (lowercase a-z, 0-9 and '-', at most ${String(MAX_BRANCH_ID_LENGTH)} characters): ${JSON.stringify(value)}`,
    );
  }
}

/**
 * `play/<id>/`: the prefix of every branch of a play (N59). Listing or removing a whole play
 * goes through this one prefix (`refs/heads/play/<id>/`).
 */
export function playBranchPrefix(playId: string): string {
  assertBranchId('play id', playId);
  return `play/${playId}/`;
}

/** `play/<id>/base`: the branch of a play, from the project base (architecture 5.5, N59). */
export function playBranch(playId: string): string {
  return `${playBranchPrefix(playId)}${PLAY_BASE_SEGMENT}`;
}

/**
 * `play/<id>/attempts/<demand>/<attempt>`: branch of one attempt (architecture 5.5, N59).
 * `attempt` is >= 1.
 */
export function attemptBranch(playId: string, demandId: string, attempt: number): string {
  const prefix = playBranchPrefix(playId);
  assertBranchId('demand id', demandId);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new InvalidInput(`Invalid attempt number: ${String(attempt)}`);
  }
  return `${prefix}${PLAY_ATTEMPTS_SEGMENT}/${demandId}/${String(attempt)}`;
}

/** `play/<id>/integration`: where the finished demands are merged (architecture 5.5, N59). */
export function integrationBranch(playId: string): string {
  return `${playBranchPrefix(playId)}${PLAY_INTEGRATION_SEGMENT}`;
}

/** First line of a checkpoint commit. `label` is one line, 1 to 200 characters. */
export function checkpointMessage(label: string): string {
  if (label.length === 0 || label.length > 200 || /[\r\n\0]/.test(label)) {
    throw new InvalidInput('A checkpoint label must be one line of 1 to 200 characters');
  }
  return `${CHECKPOINT_PREFIX}${label}`;
}

/** True when a commit message is a checkpoint (the integration squashes those, 5.16). */
export function isCheckpointMessage(message: string): boolean {
  return message.startsWith(CHECKPOINT_PREFIX);
}
