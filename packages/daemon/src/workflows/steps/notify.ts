// SPDX-License-Identifier: MPL-2.0
import { buildDaemonEvent } from '@otheater/protocol';
import { runEffect } from '../../workspace/effects.js';
import { WORKFLOW_EFFECT_TYPES, verifyNotify } from '../effects.js';
import { NO_STEP_OUTPUT, type StepContext, type StepResult, type StepRunner } from './types.js';

/**
 * `notify` (docs/24 §4): tells the Producer something. It writes a `workflow.notified` event in the
 * log, which is the channel the chat and the plugins read (a plugin hears it as any event).
 * [proposta] There is no other channel in P2: a client that shows notices shows this event.
 *
 * It is an effect (`workflow.notify`, key `<run>:<node>:<ordinal>`), so a restart in the middle of
 * the step does not tell the Producer twice: the journal finds the record, and the verifier
 * (`verifyNotify`) looks in the log for the event after the position the step noted when it began.
 */
export const notifyStep: StepRunner = {
  type: 'notify',
  async run(ctx: StepContext): Promise<StepResult> {
    const { store } = ctx.deps;
    const message = String(ctx.params.message);
    let since = ctx.memo.get('since');
    if (typeof since !== 'number') {
      since = await store.events.lastId();
      await ctx.memo.set('since', since);
    }
    const outcome = await runEffect(store.sideEffects, {
      key: ctx.key,
      type: WORKFLOW_EFFECT_TYPES.notify,
      target: ctx.node,
      params: { run: ctx.runId, node: ctx.node, since },
      execute: async () => {
        const event = await store.events.append({
          ...buildDaemonEvent('workflow.notified', { node: ctx.node, message }),
          scenarioId: ctx.scenarioId,
          playId: ctx.runId,
        });
        return { event_id: event.id };
      },
      verify: (record) => verifyNotify(store, record),
    });
    if (outcome.kind === 'ambiguous') {
      return { kind: 'failed', reason: 'effect_ambiguous', detail: outcome.reason };
    }
    return { kind: 'done', output: NO_STEP_OUTPUT, effect: outcome.origin };
  },
};
