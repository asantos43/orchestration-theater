// SPDX-License-Identifier: MPL-2.0
import { runEffect } from '../../../workspace/effects.js';
import {
  CODE_HOST_EFFECT_TYPES,
  commentEffectParams,
  verifyComment,
  verifyLabel,
} from './effects.js';
import { codeHostOf, commentMarker, guardPublicWrite, numberOf, portFailure } from './support.js';
import { NO_STEP_OUTPUT, type StepContext, type StepResult, type StepRunner } from '../types.js';

/**
 * The two steps that write in public (docs/24 §4 and §9; plan of Phase 11b, P8). Both:
 * 1. check `workflows.security.require_approval` again (`guardPublicWrite`): without an approved
 *    `approval` earlier in the run the step fails with `approval_required` and the tracker is not
 *    called at all;
 * 2. go through the effect journal (`runEffect`, `external_write`) with the key of the visit
 *    `<run>:<node>:<ordinal>`, so a restart in the middle of the step does not write twice.
 */

function targetOf(ctx: StepContext): 'issue' | 'pr' {
  return ctx.params.target === 'pr' ? 'pr' : 'issue';
}

/**
 * `comment`: posts `params.body` (else the input `body` of the run) on the issue or the pull
 * request. Output `{url}`. [proposta]
 * - With `workflows.codehost.comment_marker: on` (default) the body ends with a hidden marker
 *   (`<!-- otheater-effect: <key> -->`), which is what the verifier looks for after a crash (see
 *   `verifyComment` and `CommentFinder`).
 * - The body is a literal text: params are not interpolated yet.
 */
export const commentStep: StepRunner = {
  type: 'comment',
  async run(ctx: StepContext): Promise<StepResult> {
    const host = codeHostOf(ctx);
    if (!host.ok) return host.result;
    const { deps } = host;
    const refused = await guardPublicWrite(ctx, deps.security, 'comment');
    if (refused !== undefined) return refused;

    const target = targetOf(ctx);
    const number = numberOf(ctx, target);
    if (number === undefined) return { kind: 'failed', reason: 'number_missing' };
    const body = typeof ctx.params.body === 'string' ? ctx.params.body : ctx.inputs.body;
    if (typeof body !== 'string' || body.trim() === '') {
      return { kind: 'failed', reason: 'comment_body_missing' };
    }
    const marked = deps.security.commentMarker === 'on';

    try {
      const repo = await deps.repoOf(ctx.scenarioId);
      const outcome = await runEffect(ctx.deps.store.sideEffects, {
        key: ctx.key,
        type: CODE_HOST_EFFECT_TYPES.comment,
        target: `${target}#${String(number)}`,
        params: commentEffectParams({
          run: ctx.runId,
          node: ctx.node,
          repo,
          number,
          target,
          marked,
        }),
        execute: async (key) => {
          const text = marked ? `${body}\n\n${commentMarker(key)}` : body;
          const options = { repo, number, body: text };
          const comment =
            target === 'issue'
              ? await deps.issueTracker.commentOnIssue(options)
              : await deps.issueTracker.commentOnPullRequest(options);
          return { id: comment.id, url: comment.url };
        },
        verify: (record) => verifyComment(deps, record),
      });
      if (outcome.kind === 'ambiguous') {
        return { kind: 'failed', reason: 'effect_ambiguous', detail: outcome.reason };
      }
      const { url } = outcome.result;
      return {
        kind: 'done',
        output: { url: typeof url === 'string' ? url : '' },
        effect: outcome.origin,
      };
    } catch (error) {
      return portFailure(error);
    }
  },
};

function labelsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * `label`: adds `params.add` and removes `params.remove` on the issue or the pull request. A node
 * with neither fails with `label_nothing_to_do` (the validator does not catch it). [proposta] An
 * add and a remove of the same label cancel out in the order add, then remove.
 */
export const labelStep: StepRunner = {
  type: 'label',
  async run(ctx: StepContext): Promise<StepResult> {
    const host = codeHostOf(ctx);
    if (!host.ok) return host.result;
    const { deps } = host;
    const refused = await guardPublicWrite(ctx, deps.security, 'label');
    if (refused !== undefined) return refused;

    const target = targetOf(ctx);
    const number = numberOf(ctx, target);
    if (number === undefined) return { kind: 'failed', reason: 'number_missing' };
    const add = labelsOf(ctx.params.add);
    const remove = labelsOf(ctx.params.remove);
    if (add.length === 0 && remove.length === 0) {
      return { kind: 'failed', reason: 'label_nothing_to_do' };
    }

    try {
      const repo = await deps.repoOf(ctx.scenarioId);
      const outcome = await runEffect(ctx.deps.store.sideEffects, {
        key: ctx.key,
        type: CODE_HOST_EFFECT_TYPES.label,
        target: `${target}#${String(number)}`,
        params: { run: ctx.runId, node: ctx.node, repo, number, target, add, remove },
        execute: async () => {
          let labels: readonly string[] = [];
          if (add.length > 0)
            labels = await deps.issueTracker.addLabels({ repo, number, labels: add });
          if (remove.length > 0) {
            labels = await deps.issueTracker.removeLabels({ repo, number, labels: remove });
          }
          return { labels: [...labels] };
        },
        verify: () => Promise.resolve(verifyLabel()),
      });
      if (outcome.kind === 'ambiguous') {
        return { kind: 'failed', reason: 'effect_ambiguous', detail: outcome.reason };
      }
      return { kind: 'done', output: NO_STEP_OUTPUT, effect: outcome.origin };
    } catch (error) {
      return portFailure(error);
    }
  },
};
