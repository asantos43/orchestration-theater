// SPDX-License-Identifier: MPL-2.0
import type { SideEffectRecord, Store } from '@otheater/core';
import { WORKFLOW_NOTIFIED_EVENT } from '@otheater/protocol';
import type { PluginEffectRegistry } from '../workspace/plugin-effects.js';
import type { EffectVerdict } from '../workspace/effects.js';

/**
 * The effects of the engine itself (plan of Phase 11b, P2). They go through `runEffect` like any
 * other, and the boot recovery (`reconcile`) judges the ones left open with the verifiers below,
 * through the same `PluginEffectRegistry` the plugins use: `registerWorkflowEffects` puts them
 * there under the name `workflow`. [proposta] The types and the way they are verified.
 *
 * The type of the effect of a `call_tool` is `<plugin>.<tool>`, the one of its plugin, and it is
 * the plugin that declares its verifier (docs/24 §4; `PluginEffectRegistry.register`).
 */
export const WORKFLOW_EFFECT_TYPES = {
  /** A `notify` wrote its `workflow.notified`. */
  notify: 'workflow.notify',
  /** An `approval` opened its question to the Producer. */
  approval: 'workflow.approval',
} as const;

/** The name the engine registers its verifiers under. */
export const WORKFLOW_EFFECT_OWNER = 'workflow';

/** How many events of the log a verifier reads at a time. */
const READ_BATCH = 200;

function paramsOf(
  record: SideEffectRecord,
): { run: string; node: string; since: number } | undefined {
  const { run, node, since } = record.params ?? {};
  return typeof run === 'string' && typeof node === 'string' && typeof since === 'number'
    ? { run, node, since }
    : undefined;
}

/**
 * Whether the `workflow.notified` of an open `notify` is in the log: an event of that type, of that
 * run and node, after the position the step noted when it began. `done` with its id, or `not_done`.
 */
export async function verifyNotify(
  store: Pick<Store, 'events'>,
  record: SideEffectRecord,
): Promise<EffectVerdict> {
  const params = paramsOf(record);
  if (params === undefined) {
    return {
      verdict: 'ambiguous',
      reason: 'The record of the notice has no run, node or position',
    };
  }
  let cursor = params.since;
  for (;;) {
    const batch = await store.events.readFrom(cursor, READ_BATCH);
    for (const event of batch) {
      cursor = event.id;
      if (
        event.type === WORKFLOW_NOTIFIED_EVENT &&
        event.playId === params.run &&
        event.payload.node === params.node
      ) {
        return { verdict: 'done', result: { event_id: event.id } };
      }
    }
    if (batch.length < READ_BATCH) return { verdict: 'not_done' };
  }
}

/**
 * An `approval` that was open when the daemon stopped: its question can no longer be answered (the
 * prompt queue lives in the process), so what the step needs is to ask again. [proposta] `not_done`
 * always: the step cancels the question it knows of (its memo) and takes a new key.
 */
export function verifyApproval(): EffectVerdict {
  return { verdict: 'not_done' };
}

/** Puts the verifiers of the effects of the engine in the registry the recovery reads. */
export function registerWorkflowEffects(
  registry: PluginEffectRegistry,
  store: Pick<Store, 'events'>,
): void {
  registry.register(WORKFLOW_EFFECT_OWNER, {
    type: WORKFLOW_EFFECT_TYPES.notify,
    verify: (record) => verifyNotify(store, record),
  });
  registry.register(WORKFLOW_EFFECT_OWNER, {
    type: WORKFLOW_EFFECT_TYPES.approval,
    verify: () => Promise.resolve(verifyApproval()),
  });
}
