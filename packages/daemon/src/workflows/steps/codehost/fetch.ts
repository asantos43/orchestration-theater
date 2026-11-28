// SPDX-License-Identifier: MPL-2.0
import { isFailedCiRun } from '@otheater/core';
import { codeHostOf, markExternalText, numberOf, portFailure } from './support.js';
import type { StepContext, StepResult, StepRunner } from '../types.js';

/**
 * The three steps that only read the code host (docs/24 §4; plan of Phase 11b, P8). They have no
 * effect to journal: a restart runs them again, and the answer may be newer.
 *
 * The typed fields of the output (`title`, `state`, `labels`, `author`...) are for the conditions of
 * the edges. The text that goes to the prompt of an Actor is `text` (and `log`): it is external text,
 * so it comes marked as not trusted and, by `workflows.security.untrusted_text`, cut (docs/24 §9;
 * `untrusted.ts`). [proposta] The names `text`, `log`, `url` and `head_sha`: the spec of the step
 * type declares only the typed fields.
 */

/** `fetch_issue`: the issue of `params.number`, else of the input `issue` of the run. */
export const fetchIssueStep: StepRunner = {
  type: 'fetch_issue',
  async run(ctx: StepContext): Promise<StepResult> {
    const host = codeHostOf(ctx);
    if (!host.ok) return host.result;
    const { deps } = host;
    const number = numberOf(ctx, 'issue');
    if (number === undefined) return { kind: 'failed', reason: 'number_missing' };
    try {
      const repo = await deps.repoOf(ctx.scenarioId);
      const issue = await deps.issueTracker.fetchIssue({ repo, number });
      const text = await markExternalText(
        ctx,
        deps.security,
        'issue',
        `${issue.title}\n\n${issue.body}`,
      );
      return {
        kind: 'done',
        output: {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          labels: [...issue.labels],
          author: issue.author,
          url: issue.url,
          text: text.text,
        },
      };
    } catch (error) {
      return portFailure(error);
    }
  },
};

/** `fetch_pr`: the pull request of `params.number`, else of the input `pr` of the run. */
export const fetchPrStep: StepRunner = {
  type: 'fetch_pr',
  async run(ctx: StepContext): Promise<StepResult> {
    const host = codeHostOf(ctx);
    if (!host.ok) return host.result;
    const { deps } = host;
    const number = numberOf(ctx, 'pr');
    if (number === undefined) return { kind: 'failed', reason: 'number_missing' };
    try {
      const repo = await deps.repoOf(ctx.scenarioId);
      const pr = await deps.codeHost.fetchPullRequest({ repo, number });
      const text = await markExternalText(
        ctx,
        deps.security,
        'pull_request',
        `${pr.title}\n\n${pr.body}`,
      );
      return {
        kind: 'done',
        output: {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          labels: [...pr.labels],
          author: pr.author,
          url: pr.url,
          head_sha: pr.headSha,
          text: text.text,
        },
      };
    } catch (error) {
      return portFailure(error);
    }
  },
};

/**
 * `fetch_ci_log`: the log of the failed checks of the pull request of the input `pr` of the run.
 * `failed` is whether any run of the head failed; `checks` the names of the failed ones. [proposta]
 * `params.max_bytes` is read as a number of characters (the port counts characters; a character is
 * at least one byte, so the log is never longer in bytes than asked); the end of the log is what
 * stays, where the error is (the port and the cut of `mark_and_truncate` both keep the tail).
 */
export const fetchCiLogStep: StepRunner = {
  type: 'fetch_ci_log',
  async run(ctx: StepContext): Promise<StepResult> {
    const host = codeHostOf(ctx);
    if (!host.ok) return host.result;
    const { deps } = host;
    const number = numberOf(ctx, 'pr');
    if (number === undefined) return { kind: 'failed', reason: 'number_missing' };
    const maxBytes = ctx.params.max_bytes;
    try {
      const repo = await deps.repoOf(ctx.scenarioId);
      const ci = await deps.codeHost.fetchCiLog({
        repo,
        number,
        ...(typeof maxBytes === 'number' ? { maxChars: maxBytes } : {}),
      });
      const failedRuns = ci.runs.filter(isFailedCiRun);
      const log = await markExternalText(ctx, deps.security, 'ci_log', ci.log, 'tail');
      return {
        kind: 'done',
        output: {
          failed: failedRuns.length > 0,
          checks: failedRuns.map((run) => run.name),
          head_sha: ci.headSha,
          truncated: ci.truncated || log.truncated,
          log: log.text,
        },
      };
    } catch (error) {
      return portFailure(error);
    }
  },
};
