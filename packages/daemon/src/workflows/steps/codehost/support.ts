// SPDX-License-Identifier: MPL-2.0
import { hasErrorCode } from '@otheater/core';
import { buildDaemonEvent } from '@otheater/protocol';
import type { PublicWrite } from '@otheater/workflows';
import { situationText } from '../../../situations.js';
import {
  markUntrusted,
  type MarkedText,
  type UntrustedKeep,
  type UntrustedSource,
} from '../../untrusted.js';
import type { WorkflowSecuritySettings } from '../../security-config.js';
import type { StepContext, StepResult } from '../types.js';
import type { CodeHostStepDeps } from './deps.js';

export type { CodeHostStepDeps, CommentFinder, FoundComment } from './deps.js';

/**
 * What the code host steps share (plan of Phase 11b, P8). [proposta] All of it: the plan fixes the
 * five step types and that `comment` and `label` go through the effect journal.
 */

/** The deps of a step that needs the code host, or the failure to return. */
export function codeHostOf(
  ctx: StepContext,
):
  | { readonly ok: true; readonly deps: CodeHostStepDeps }
  | { readonly ok: false; readonly result: StepResult } {
  const deps = ctx.deps.codeHost;
  if (deps === undefined) {
    return { ok: false, result: { kind: 'failed', reason: 'code_host_unavailable' } };
  }
  return { ok: true, deps };
}

/** What a failure of a port becomes: `not_found` for a number that is not there, else `code_host_error`. */
export function portFailure(error: unknown): StepResult {
  const detail = situationText(error, 400) ?? undefined;
  const reason = hasErrorCode(error, 'NOT_FOUND') ? 'not_found' : 'code_host_error';
  return { kind: 'failed', reason, ...(detail === undefined ? {} : { detail }) };
}

/**
 * The number of the issue or pull request: `params.number`, else the input of the run named by
 * `inputName` (`issue` or `pr`, what a trigger gives). [proposta] There is no interpolation of
 * params yet, so these two are the ways a node learns which one to act on.
 */
export function numberOf(ctx: StepContext, inputName: 'issue' | 'pr'): number | undefined {
  const candidates = [ctx.params.number, ctx.inputs[inputName]];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return value;
  }
  return undefined;
}

/**
 * The second line of the rule `workflows.security.require_approval` (the first is the validator of
 * P1): a step that writes in public does not write when the setting names that write and the run has
 * no approved `approval` so far (`ctx.approvals`). Returns the failure to return, or `undefined` when
 * the write may go on. A refusal is also an event (`workflow.write.refused`). [proposta] One approved
 * `approval` anywhere before the write covers it, as it does for the validator, which only looks at
 * the path. P3 uses the same guard before the `push` of a `deliver`.
 */
export async function guardPublicWrite(
  ctx: StepContext,
  security: Pick<WorkflowSecuritySettings, 'requireApproval'>,
  write: PublicWrite,
): Promise<StepResult | undefined> {
  if (!security.requireApproval.includes(write) || ctx.approvals > 0) return undefined;
  await ctx.deps.store.events.append({
    ...buildDaemonEvent('workflow.write.refused', {
      node: ctx.node,
      step: ctx.step,
      write,
      reason: 'approval_missing',
    }),
    scenarioId: ctx.scenarioId,
    playId: ctx.runId,
  });
  return {
    kind: 'failed',
    reason: 'approval_required',
    detail: `${write} needs an approved approval first (workflows.security.require_approval)`,
  };
}

/**
 * Marks external text as not trusted and, when the mode cuts it, tells the protocol (a
 * `workflow.untrusted.truncated` event, which is also what would only be a log line).
 */
export async function markExternalText(
  ctx: StepContext,
  security: WorkflowSecuritySettings,
  source: UntrustedSource,
  text: string,
  keep: UntrustedKeep = 'head',
): Promise<MarkedText> {
  const marked = markUntrusted(text, {
    source,
    mode: security.untrustedText,
    maxChars: security.untrustedMaxChars,
    keep,
  });
  if (marked.truncated) {
    await ctx.deps.store.events.append({
      ...buildDaemonEvent('workflow.untrusted.truncated', {
        node: ctx.node,
        step: ctx.step,
        source,
        chars: marked.originalChars,
        kept: marked.keptChars,
      }),
      scenarioId: ctx.scenarioId,
      playId: ctx.runId,
    });
  }
  return marked;
}

/** The hidden marker a comment ends with, so its verifier can find it. */
export function commentMarker(key: string): string {
  return `<!-- otheater-effect: ${key} -->`;
}
