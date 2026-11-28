// SPDX-License-Identifier: MPL-2.0
import type { SideEffectRecord } from '@otheater/core';
import type { EffectVerdict } from '../../../workspace/effects.js';
import type { PluginEffectRegistry } from '../../../workspace/plugin-effects.js';
import { WORKFLOW_EFFECT_OWNER } from '../../effects.js';
import { commentMarker, type CodeHostStepDeps } from './support.js';

/**
 * The effects of `comment` and `label` (`external_write`; plan of Phase 11b, P8). They go through
 * `runEffect` like any other, and `registerCodeHostEffects` puts their verifiers where the boot
 * recovery (`reconcile`) reads them, next to the ones of the engine (`registerWorkflowEffects`).
 * [proposta] The types and the way each is verified.
 */
export const CODE_HOST_EFFECT_TYPES = {
  /** A `comment` posted its comment on the issue or the pull request. */
  comment: 'workflow.comment',
  /** A `label` added and removed its labels. */
  label: 'workflow.label',
} as const;

/** What the effect of a `comment` keeps in its record, so its verifier can look for the comment. */
export function commentEffectParams(input: {
  run: string;
  node: string;
  repo: string;
  number: number;
  target: 'issue' | 'pr';
  marked: boolean;
}): { run: string; node: string; repo: string; number: number; target: string; marked: boolean } {
  return { ...input };
}

function commentParams(
  record: SideEffectRecord,
): { repo: string; number: number; target: 'issue' | 'pr'; marked: boolean } | undefined {
  const { repo, number, target, marked } = record.params ?? {};
  return typeof repo === 'string' &&
    typeof number === 'number' &&
    (target === 'issue' || target === 'pr') &&
    typeof marked === 'boolean'
    ? { repo, number, target, marked }
    : undefined;
}

/**
 * Whether the comment of an open `comment` is on the tracker: a comment that carries the marker of
 * the key of the record. `done` with its id and url, `not_done` when there is none, `ambiguous` when
 * nobody can look (no `findComment`, or the comment was posted without a marker): the step then
 * fails with `effect_ambiguous` and never posts a second comment on a guess.
 */
export async function verifyComment(
  deps: Pick<CodeHostStepDeps, 'findComment'>,
  record: SideEffectRecord,
): Promise<EffectVerdict> {
  const params = commentParams(record);
  if (params === undefined) {
    return { verdict: 'ambiguous', reason: 'The record of the comment has no issue or target' };
  }
  if (!params.marked) {
    return {
      verdict: 'ambiguous',
      reason: 'The comment was posted without a marker (workflows.codehost.comment_marker: off)',
    };
  }
  if (deps.findComment === undefined) {
    return {
      verdict: 'ambiguous',
      reason: 'The issue tracker cannot list comments, so the comment cannot be looked for',
    };
  }
  const found = await deps.findComment({
    repo: params.repo,
    number: params.number,
    target: params.target,
    marker: commentMarker(record.idempotencyKey),
  });
  return found === undefined
    ? { verdict: 'not_done' }
    : { verdict: 'done', result: { id: found.id, url: found.url } };
}

/**
 * A `label` that was open at a crash: adding and removing a label is idempotent on the trackers, so
 * the step may run again. `not_done` always. [proposta]
 */
export function verifyLabel(): EffectVerdict {
  return { verdict: 'not_done' };
}

/** Puts the verifiers of `comment` and `label` in the registry the recovery reads. */
export function registerCodeHostEffects(
  registry: PluginEffectRegistry,
  deps: Pick<CodeHostStepDeps, 'findComment'>,
): void {
  registry.register(WORKFLOW_EFFECT_OWNER, {
    type: CODE_HOST_EFFECT_TYPES.comment,
    verify: (record) => verifyComment(deps, record),
  });
  registry.register(WORKFLOW_EFFECT_OWNER, {
    type: CODE_HOST_EFFECT_TYPES.label,
    verify: () => Promise.resolve(verifyLabel()),
  });
}
