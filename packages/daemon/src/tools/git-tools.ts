// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import {
  playBranch,
  supportsDiff,
  supportsHistory,
  truncateText,
  withIdempotencyTrailer,
  type CodeHost,
  type JsonObject,
  type SideEffectRecord,
  type Vcs,
  type VcsHistory,
} from '@otheater/core';
import { ToolFailure, type ToolCall, type ToolHandler } from '../mcp/handlers.js';
import { runEffect, type EffectVerdict } from '../workspace/effects.js';
import { GIT_COMMIT_EFFECT, verifyGitCommit } from '../workspace/verifiers.js';
import type { ToolDone, ToolsContext } from './context.js';
import type { ToolSettings } from './settings.js';

/**
 * `verifyGitCommit` reads the history of the branch only; the code host belongs to the verifiers
 * of the push and the PR. A stand-in that fails loudly keeps this one honest if that ever changes.
 */
const NO_CODE_HOST = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`the git_commit verifier does not use the code host (${String(property)})`);
    },
  },
) as CodeHost;

function worktreeOf(call: ToolCall): string {
  const { worktree } = call.caller;
  if (worktree === undefined) {
    throw new ToolFailure(
      'no_worktree',
      `${call.tool.name} works on the worktree of an attempt, and this session has none.`,
    );
  }
  return worktree;
}

function hashOf(message: string): string {
  return createHash('sha256').update(message).digest('hex').slice(0, 16);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Step {
  readonly step: number;
  readonly records: readonly SideEffectRecord[];
}

/** The records of an attempt, grouped by the step of their key (`<base>:<n>` and `<base>:<n>~k`). */
function stepsOf(records: readonly SideEffectRecord[], base: string): Step[] {
  const pattern = new RegExp(`^${escapeRegExp(base)}:(\\d+)(?:~\\d+)?$`);
  const byStep = new Map<number, SideEffectRecord[]>();
  for (const record of records) {
    const match = pattern.exec(record.idempotencyKey);
    if (match === null) continue;
    const step = Number(match[1]);
    byStep.set(step, [...(byStep.get(step) ?? []), record]);
  }
  return [...byStep.entries()]
    .sort(([a], [b]) => a - b)
    .map(([step, list]) => ({ step, records: list }));
}

function messageHashOf(record: SideEffectRecord): string | undefined {
  const value = record.params?.messageHash;
  return typeof value === 'string' ? value : undefined;
}

function isOpen(step: Step): boolean {
  return (
    !step.records.some((record) => record.state === 'done') &&
    step.records.some((record) => record.state === 'pending' || record.state === 'ambiguous')
  );
}

function committedSha(step: Step): string | undefined {
  for (const record of step.records) {
    const sha = record.result?.sha;
    if (record.state === 'done' && typeof sha === 'string') return sha;
  }
  return undefined;
}

/**
 * The step of this call. The same message calling again while an earlier call of it is still
 * open (a crash, a timeout of the client, an ambiguous verifier) is the same step, so the verifier
 * decides whether the commit already happened. Anything else is a new step.
 */
function stepFor(steps: readonly Step[], hash: string): number {
  const open = steps.find(
    (step) => isOpen(step) && step.records.some((record) => messageHashOf(record) === hash),
  );
  if (open !== undefined) return open.step;
  return (steps[steps.length - 1]?.step ?? 0) + 1;
}

async function gitCommit(context: ToolsContext, call: ToolCall): Promise<ToolDone> {
  const { store, vcs } = context.deps;
  const worktree = worktreeOf(call);
  const { message } = call.input as { message: string };
  const { attemptId } = call.caller;
  const attempt = await store.attempts.get(attemptId);
  if (attempt === undefined) {
    throw new ToolFailure('no_attempt', 'This session is not tied to an attempt of the store.');
  }
  if (!supportsHistory(vcs)) {
    throw new ToolFailure(
      'unavailable',
      'The version control adapter cannot look at the history, so git_commit cannot be verified.',
    );
  }
  const history: Vcs & VcsHistory = vcs;
  const base = `${attempt.playId}:${GIT_COMMIT_EFFECT}:${attemptId}`;
  const hash = hashOf(message);
  const steps = stepsOf(
    await store.sideEffects.list({ types: [GIT_COMMIT_EFFECT], attemptId }),
    base,
  );
  const step = stepFor(steps, hash);
  const previousSha = [...steps]
    .reverse()
    .find(
      (entry) =>
        entry.step < step &&
        committedSha(entry) !== undefined &&
        entry.records.some((record) => messageHashOf(record) === hash),
    )
    ?.records.map((record) => record.result?.sha)
    .find((sha) => typeof sha === 'string');

  const outcome = await runEffect(store.sideEffects, {
    key: `${base}:${String(step)}`,
    type: GIT_COMMIT_EFFECT,
    target: attempt.branch,
    attemptId,
    params: { repo: worktree, branch: attempt.branch, messageHash: hash },
    execute: async (key): Promise<JsonObject> => {
      const sha = await history.commitAll(worktree, withIdempotencyTrailer(message, key));
      if (sha !== undefined) return { outcome: 'committed', sha };
      // Nothing changed. The same message right after its own commit is the call asked again
      // (the answer got lost): it gets that commit back. Anything else has nothing to commit.
      const head = await history.headOf(worktree);
      if (previousSha === head) return { outcome: 'reused', sha: head };
      return { outcome: 'empty' };
    },
    verify: (record): Promise<EffectVerdict> =>
      verifyGitCommit({ vcs: history, codeHost: context.deps.codeHost ?? NO_CODE_HOST }, record),
  });

  if (outcome.kind === 'ambiguous') {
    throw new ToolFailure(
      'ambiguous',
      `An earlier git_commit of this attempt may or may not have happened: ${outcome.reason}. ` +
        'Look at the history with restricted_shell (git log) and call again.',
    );
  }
  const sha = outcome.result.sha;
  if (outcome.result.outcome === 'empty' || typeof sha !== 'string') {
    throw new ToolFailure('nothing_to_commit', 'The worktree has no change to commit.');
  }
  return {
    reply: { sha, reused: outcome.origin !== 'executed' || outcome.result.outcome === 'reused' },
    outcome: 'ok',
  };
}

/** The branch whose work `view_diff` shows: the named demand's latest attempt, or the caller's own. */
async function headBranchOf(
  context: ToolsContext,
  call: ToolCall,
  playId: string,
  demand: string | undefined,
): Promise<string> {
  const { attempts } = context.deps.store;
  if (demand === undefined) {
    const own = await attempts.get(call.caller.attemptId);
    if (own === undefined) {
      throw new ToolFailure('no_attempt', 'This session is not tied to an attempt of the store.');
    }
    return own.branch;
  }
  const mine = (await attempts.list()).filter(
    (record) => record.playId === playId && record.demandId === demand,
  );
  const latest = mine.reduce<(typeof mine)[number] | undefined>(
    (best, record) => (best === undefined || record.attempt > best.attempt ? record : best),
    undefined,
  );
  if (latest === undefined) {
    throw new ToolFailure('not_found', `The demand "${demand}" has no attempt in this play.`);
  }
  return latest.branch;
}

async function viewDiff(
  context: ToolsContext,
  call: ToolCall,
  settings: ToolSettings,
): Promise<ToolDone> {
  const { vcs, store } = context.deps;
  const worktree = worktreeOf(call);
  if (!supportsDiff(vcs)) {
    throw new ToolFailure('unavailable', 'The version control adapter cannot show a diff.');
  }
  const { demand } = call.input as { demand?: string };
  const attempt = await store.attempts.get(call.caller.attemptId);
  const playId = call.caller.correlation.playId ?? attempt?.playId;
  if (playId === undefined) {
    throw new ToolFailure(
      'no_play',
      'view_diff compares a branch with its play, and this session has none.',
    );
  }
  const head = await headBranchOf(context, call, playId, demand);
  const { output_max_bytes, truncate } = settings.config;
  // The adapter clips by characters; a character is at most 4 bytes, so this never cuts early.
  const diff = await vcs.diffBetween(worktree, playBranch(playId), head, output_max_bytes * 4);
  const cut = truncateText(diff.text, output_max_bytes, truncate);
  const truncated = cut.truncated || diff.truncated;
  return {
    reply: { diff: cut.text, truncated, originalBytes: cut.originalBytes },
    outcome: 'ok',
    outputBytes: cut.originalBytes,
    truncated,
  };
}

/**
 * `git_commit {message}` and `view_diff {demand?}` (architecture 5.8 and 5.21).
 *
 * `git_commit` commits the whole worktree through the `Vcs` port, under the side-effect protocol:
 * the key `<play>:git_commit:<attempt>:<step>` is recorded before the commit and carried in the
 * commit as a trailer, and the effect verifier of the workspace (`verifyGitCommit`) says whether a
 * call that was cut short (a crash, a lost reply) already committed. The same message asked again
 * returns the same commit (`reused`). A worktree with no change answers `nothing_to_commit`.
 *
 * `view_diff` shows what an attempt did since the branch of the play (`play/<id>/base`), cut to
 * `tools.output_max_bytes`. [proposta] The base is the play branch, not the base of the project:
 * it includes the demands already integrated, so the diff is only the attempt's own work.
 */
export function gitToolHandlers(context: ToolsContext): Record<string, ToolHandler> {
  return {
    git_commit: (call) => {
      const { message } = call.input as { message: string };
      return context.track(call, message.split('\n')[0] ?? '', () => gitCommit(context, call));
    },
    view_diff: (call) => {
      const { demand } = call.input as { demand?: string };
      return context.track(
        call,
        demand === undefined ? 'view_diff' : `view_diff ${demand}`,
        (settings) => viewDiff(context, call, settings),
      );
    },
  };
}
