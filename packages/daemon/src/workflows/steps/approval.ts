// SPDX-License-Identifier: MPL-2.0
import type { JsonValue } from '@otheater/core';
import { buildDaemonEvent } from '@otheater/protocol';
import { durationMs } from '@otheater/workflows';
import { APPROVE_LABEL, DENY_LABEL, isApproval } from '../../browser/approval.js';
import { runEffect } from '../../workspace/effects.js';
import { WORKFLOW_EFFECT_TYPES, verifyApproval } from '../effects.js';
import type { WorkflowApprovalOnTimeout } from '../runtime-config.js';
import { sleepOrAbort } from './support.js';
import type { StepContext, StepResult, StepRunner } from './types.js';

/** A question that was opened in the prompt queue. */
interface Opened {
  readonly decisionId: string;
  readonly answer: Promise<JsonValue>;
}

/** What the wait for the answer ended with. */
type Waited =
  | { readonly kind: 'answered'; readonly answer: JsonValue }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' };

/** Thrown inside the effect when the prompt queue has nobody to ask. */
class NoOneToAsk extends Error {}

function savedNumber(ctx: StepContext, name: string): number | undefined {
  const value = ctx.memo.get(name);
  return typeof value === 'number' ? value : undefined;
}

function savedText(ctx: StepContext, name: string): string | undefined {
  const value = ctx.memo.get(name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * `approval` (docs/24 §4): asks the Producer for a yes or a no through the prompt queue of the
 * project, the one of `ask_producer`, and waits for the answer with a deadline. Output
 * `{approved}`: only an exact `Allow` is a yes (`isApproval`); anything else is a no.
 *
 * [proposta]
 * - Nobody to ask (no channel, or the daemon is still starting) is a failure of the step
 *   (`approval_unavailable`), never a yes.
 * - The question is an effect (`workflow.approval`) and goes through the journal, with the key
 *   `<run>:<node>:<ordinal>:ask<n>`. The prompt queue lives in the process: after a restart the old
 *   question can no longer be answered, so the step cancels it (it knows its id from the memo) and
 *   asks again with the next `n`. A restart does not give the Producer more time: the deadline is
 *   an absolute instant saved in the memo when the step begins.
 * - At the deadline the question is cancelled, and `on_timeout` (the node, else
 *   `workflows.runtime.approval.on_timeout`) decides: `stop` ends the run as cancelled, `reject`
 *   gives `approved: false` and the edges decide. With no timeout (the node and
 *   `workflows.runtime.approval.timeout` say none) it waits for ever.
 */
export const approvalStep: StepRunner = {
  type: 'approval',
  async run(ctx: StepContext): Promise<StepResult> {
    const { store, clock, ask, settings } = ctx.deps;
    if (ask === undefined) return { kind: 'failed', reason: 'approval_unavailable' };

    const timeoutText = ctx.params.timeout;
    const timeoutMs =
      typeof timeoutText === 'string' ? durationMs(timeoutText) : settings.approvalTimeoutMs;
    const onTimeout: WorkflowApprovalOnTimeout =
      ctx.params.on_timeout === 'stop' || ctx.params.on_timeout === 'reject'
        ? ctx.params.on_timeout
        : settings.approvalOnTimeout;

    let deadline: number | null = savedNumber(ctx, 'deadline') ?? null;
    if (deadline === null && timeoutMs !== null) {
      deadline = clock.now() + timeoutMs;
      await ctx.memo.set('deadline', deadline);
    }

    const question =
      typeof ctx.params.prompt === 'string'
        ? ctx.params.prompt
        : `The workflow ${ctx.workflow.id} (${ctx.workflow.version}) asks to go on at "${ctx.node}".`;

    // A question of an earlier run of the daemon can no longer be answered: it is withdrawn.
    const stale = savedText(ctx, 'decision');
    if (stale !== undefined) await store.decisions.cancel(stale).catch(() => undefined);

    let asks = savedNumber(ctx, 'asks') ?? 0;
    for (;;) {
      asks += 1;
      const holder: { opened?: Opened } = {};
      const outcome = await runEffect(store.sideEffects, {
        key: `${ctx.key}:ask${String(asks)}`,
        type: WORKFLOW_EFFECT_TYPES.approval,
        target: ctx.node,
        params: { run: ctx.runId, node: ctx.node },
        execute: async () => {
          const opened = await ask(ctx.scenarioId, {
            questions: [
              {
                question,
                options: [
                  { label: APPROVE_LABEL, description: 'Go on with the workflow.' },
                  { label: DENY_LABEL, description: 'Do not go on.' },
                ],
                multi_select: false,
                open: false,
                recommended: DENY_LABEL,
              },
            ],
          });
          if (opened === undefined) throw new NoOneToAsk('nobody can be asked');
          holder.opened = opened;
          return { decision_id: opened.decisionId };
        },
        verify: () => Promise.resolve(verifyApproval()),
      }).catch((error: unknown) => {
        if (error instanceof NoOneToAsk) return undefined;
        throw error;
      });
      if (outcome === undefined) return { kind: 'failed', reason: 'approval_unavailable' };
      if (outcome.kind === 'ambiguous') {
        return { kind: 'failed', reason: 'effect_ambiguous', detail: outcome.reason };
      }
      await ctx.memo.set('asks', asks);
      const { opened } = holder;
      if (opened === undefined) {
        // Replayed or verified: an earlier run of the daemon asked, and nobody holds the answer.
        const old = outcome.result.decision_id;
        if (typeof old === 'string') await store.decisions.cancel(old).catch(() => undefined);
        continue;
      }
      await ctx.memo.set('decision', opened.decisionId);
      await emitApproval(ctx, 'workflow.approval.requested', {
        node: ctx.node,
        ordinal: ctx.ordinal,
        prompt: question.slice(0, 500),
      });
      const waited = await waitFor(ctx, opened.answer, deadline);
      await ctx.memo.set('decision', null);
      if (waited.kind === 'answered') {
        const approved = isApproval(waited.answer);
        await emitApproval(ctx, 'workflow.approval.resolved', {
          node: ctx.node,
          ordinal: ctx.ordinal,
          approved,
          by: 'answered',
        });
        return { kind: 'done', output: { approved }, effect: outcome.origin };
      }
      if (waited.kind === 'aborted') return { kind: 'cancelled', reason: 'aborted' };
      if (waited.kind === 'cancelled') {
        await emitApproval(ctx, 'workflow.approval.resolved', {
          node: ctx.node,
          ordinal: ctx.ordinal,
          approved: false,
          by: 'cancelled',
        });
        return { kind: 'failed', reason: 'approval_cancelled' };
      }
      // The deadline: the question is withdrawn, so a late answer finds nothing to answer.
      await store.decisions.cancel(opened.decisionId).catch(() => undefined);
      await emitApproval(ctx, 'workflow.approval.resolved', {
        node: ctx.node,
        ordinal: ctx.ordinal,
        approved: false,
        by: 'timeout',
      });
      if (onTimeout === 'stop') return { kind: 'cancelled', reason: 'approval_timeout' };
      return { kind: 'done', output: { approved: false }, effect: outcome.origin };
    }
  },
};

/** The events of the question and of its end, for hooks and plugins (P8). [proposta] */
async function emitApproval<T extends 'workflow.approval.requested' | 'workflow.approval.resolved'>(
  ctx: StepContext,
  type: T,
  payload: Parameters<typeof buildDaemonEvent<T>>[1],
): Promise<void> {
  await ctx.deps.store.events.append({
    ...buildDaemonEvent(type, payload),
    scenarioId: ctx.scenarioId,
    playId: ctx.runId,
  });
}

/** The first of the answer, the deadline and the abort of the run. */
async function waitFor(
  ctx: StepContext,
  answer: Promise<JsonValue>,
  deadline: number | null,
): Promise<Waited> {
  if (ctx.signal.aborted) return { kind: 'aborted' };
  const { clock } = ctx.deps;
  const release = new AbortController();
  const aborted = new Promise<Waited>((resolve) => {
    ctx.signal.addEventListener(
      'abort',
      () => {
        resolve({ kind: 'aborted' });
      },
      { once: true, signal: release.signal },
    );
  });
  const racers: Promise<Waited>[] = [
    aborted,
    answer.then(
      (value): Waited => ({ kind: 'answered', answer: value }),
      (): Waited => (ctx.signal.aborted ? { kind: 'aborted' } : { kind: 'cancelled' }),
    ),
  ];
  if (deadline !== null) {
    racers.push(
      sleepOrAbort(clock, deadline - clock.now(), release.signal).then((slept): Waited =>
        slept ? { kind: 'timeout' } : { kind: 'aborted' },
      ),
    );
  }
  try {
    return await Promise.race(racers);
  } finally {
    release.abort();
  }
}
