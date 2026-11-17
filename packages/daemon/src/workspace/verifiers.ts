// SPDX-License-Identifier: MPL-2.0
import {
  type CodeHost,
  DEFAULT_REMOTE,
  IDEMPOTENCY_TRAILER,
  type JsonObject,
  type SideEffectRecord,
  type Vcs,
  type VcsHistory,
  hasErrorCode,
} from '@otheater/core';
import type { EffectVerdict } from './effects.js';

/**
 * Side-effect types of the workspace and the delivery (architecture 5.21: "cada ferramenta com
 * efeito colateral registra uma intenção... e tem um verificador"). [proposta] The names.
 */
export const GIT_COMMIT_EFFECT = 'git_commit';
export const GIT_PUSH_EFFECT = 'git_push';
export const OPEN_PR_EFFECT = 'open_pr';
export const MERGE_BASE_EFFECT = 'merge_base';

export interface VerifierDeps {
  readonly vcs: Vcs & VcsHistory;
  readonly codeHost: CodeHost;
}

function text(params: JsonObject | null, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function malformed(record: SideEffectRecord, field: string): EffectVerdict {
  return {
    verdict: 'ambiguous',
    reason: `The ${record.type} record ${record.idempotencyKey} has no usable "${field}" parameter`,
  };
}

/** A verifier that cannot reach what it checks answers `ambiguous`, never `not_done`. */
function unreachable(record: SideEffectRecord, error: unknown): EffectVerdict {
  const why = error instanceof Error ? error.message : String(error);
  return {
    verdict: 'ambiguous',
    reason: `Could not check ${record.type} ${record.idempotencyKey}: ${why}`,
  };
}

/**
 * `git_commit`: is there a commit with the idempotency key as a trailer on the branch? The
 * integration merge carries it ({@link IDEMPOTENCY_TRAILER}), so the history says whether it
 * happened. Params `{ repo, branch }`.
 */
export async function verifyGitCommit(
  deps: VerifierDeps,
  record: SideEffectRecord,
): Promise<EffectVerdict> {
  const repo = text(record.params, 'repo');
  if (repo === undefined) return malformed(record, 'repo');
  const branch = text(record.params, 'branch');
  if (branch === undefined) return malformed(record, 'branch');
  try {
    const sha = await deps.vcs.findCommitByTrailer(
      repo,
      branch,
      IDEMPOTENCY_TRAILER,
      record.idempotencyKey,
    );
    return sha === undefined
      ? { verdict: 'not_done' }
      : { verdict: 'done', result: { outcome: 'merged', sha } };
  } catch (error) {
    // The branch was never created: the commit cannot be on it.
    if (hasErrorCode(error, 'NOT_FOUND')) return { verdict: 'not_done' };
    return unreachable(record, error);
  }
}

/**
 * `git_push`: is the remote branch at the sha that was to be pushed? Missing or at another sha is
 * `not_done`: a push is never forced, so it can simply be asked again. Params
 * `{ repo, branch, remote, sha }`.
 */
export async function verifyGitPush(
  deps: VerifierDeps,
  record: SideEffectRecord,
): Promise<EffectVerdict> {
  const repo = text(record.params, 'repo');
  if (repo === undefined) return malformed(record, 'repo');
  const branch = text(record.params, 'branch');
  if (branch === undefined) return malformed(record, 'branch');
  const sha = text(record.params, 'sha');
  if (sha === undefined) return malformed(record, 'sha');
  const remote = text(record.params, 'remote') ?? DEFAULT_REMOTE;
  try {
    const found = await deps.codeHost.remoteRef({ repo, branch, remote });
    return found === sha ? { verdict: 'done', result: { sha } } : { verdict: 'not_done' };
  } catch (error) {
    return unreachable(record, error);
  }
}

/**
 * `open_pr`: is there a PR for head into base? An open one is the effect (whoever opened it). One
 * that is already closed or merged counts only when it was created after the intent was recorded
 * (so it is the one this effect opened, and not an old one). Params `{ repo, head, base, remote }`.
 */
export async function verifyOpenPr(
  deps: VerifierDeps,
  record: SideEffectRecord,
): Promise<EffectVerdict> {
  const repo = text(record.params, 'repo');
  if (repo === undefined) return malformed(record, 'repo');
  const head = text(record.params, 'head');
  if (head === undefined) return malformed(record, 'head');
  const base = text(record.params, 'base');
  if (base === undefined) return malformed(record, 'base');
  const remote = text(record.params, 'remote') ?? DEFAULT_REMOTE;
  try {
    const pr = await deps.codeHost.findPullRequest({
      repo,
      head,
      base,
      remote,
      states: ['open', 'closed', 'merged'],
    });
    if (pr === undefined) return { verdict: 'not_done' };
    if (pr.state !== 'open' && pr.createdAt < record.createdAt) return { verdict: 'not_done' };
    return {
      verdict: 'done',
      result: { number: pr.number, url: pr.url, state: pr.state },
    };
  } catch (error) {
    return unreachable(record, error);
  }
}

/**
 * `merge_base`: is the head already in the base on the remote? Params
 * `{ repo, head, base, remote }`.
 */
export async function verifyMergeBase(
  deps: VerifierDeps,
  record: SideEffectRecord,
): Promise<EffectVerdict> {
  const repo = text(record.params, 'repo');
  if (repo === undefined) return malformed(record, 'repo');
  const head = text(record.params, 'head');
  if (head === undefined) return malformed(record, 'head');
  const base = text(record.params, 'base');
  if (base === undefined) return malformed(record, 'base');
  const remote = text(record.params, 'remote') ?? DEFAULT_REMOTE;
  try {
    if (!(await deps.codeHost.isBranchMerged({ repo, head, base, remote }))) {
      return { verdict: 'not_done' };
    }
    const sha = await deps.codeHost.remoteRef({ repo, branch: base, remote });
    return sha === undefined ? { verdict: 'not_done' } : { verdict: 'done', result: { sha } };
  } catch (error) {
    return unreachable(record, error);
  }
}

/**
 * The verifier of a record, by its type (what the reconciliation of a restart uses for the
 * `pending` and `ambiguous` records of the workspace). A type that is not the workspace's is
 * `ambiguous`: the verifier of another tool owns it.
 */
export function verifySideEffect(
  deps: VerifierDeps,
  record: SideEffectRecord,
): Promise<EffectVerdict> {
  switch (record.type) {
    case GIT_COMMIT_EFFECT:
      return verifyGitCommit(deps, record);
    case GIT_PUSH_EFFECT:
      return verifyGitPush(deps, record);
    case OPEN_PR_EFFECT:
      return verifyOpenPr(deps, record);
    case MERGE_BASE_EFFECT:
      return verifyMergeBase(deps, record);
    default:
      return Promise.resolve({
        verdict: 'ambiguous',
        reason: `No workspace verifier for the side effect type ${record.type}`,
      });
  }
}
