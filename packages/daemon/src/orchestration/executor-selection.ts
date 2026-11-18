// SPDX-License-Identifier: MPL-2.0
import type { QuotaFact, SelectionResult, SelectionSettings } from '@otheater/core';
import type { ExecutorSelectedPayload } from '@otheater/protocol';
import type { DaemonConfig } from '../config.js';
import type { QuotaStatus } from '../quota/state.js';

/**
 * The daemon side of the selection of an Executor (architecture 5.7; Phase 5, P15): the pure
 * selector lives in `@otheater/core` (`selectExecutor`); here are the three small bridges to the
 * daemon. Nothing calls the selector from the pipeline yet (P16).
 */

/** The `selection` block of the configuration as the settings of the selector. */
export function selectionSettingsOf(config: Pick<DaemonConfig, 'selection'>): SelectionSettings {
  const selection = config.selection;
  return {
    strategy: selection.strategy,
    crossCheck: selection.cross_check,
    unknownQuota: selection.unknown_quota,
    nearLimit: selection.near_limit,
    retryDiversity: selection.retry_diversity,
    strictUnavailable: selection.strict_unavailable,
    contextReserve: selection.context_reserve,
  };
}

/**
 * What the selector asks of the `QuotaService` (`statusOf`): the state, the cause, the end of an
 * exhaustion, and the headroom of the fullest fresh window (`most_headroom`). A profile with no
 * fresh window has no headroom to compare (null).
 */
export function quotaFactOf(status: QuotaStatus): QuotaFact {
  const fresh = status.windows.filter((window) => window.fresh);
  const fullest = fresh.reduce<number | null>(
    (max, window) => (max === null || window.usedPercent > max ? window.usedPercent : max),
    null,
  );
  return {
    state: status.state,
    cause: status.cause,
    untilReset: status.untilReset,
    headroom: fullest === null ? null : Math.max(0, 1 - fullest / 100),
  };
}

/** The `executor.selected` event of one selection (5.7, step 5). */
export function executorSelectedPayload(
  result: SelectionResult,
  context: { readonly playId: string | null; readonly now: number },
): ExecutorSelectedPayload {
  const { selected, wait } = result;
  return {
    role: result.role,
    playId: context.playId,
    outcome: selected === null ? 'waiting' : 'selected',
    executor: selected?.id ?? null,
    profile: selected === null ? null : `${selected.entry.client}/${selected.entry.profile}`,
    strategy: result.strategy,
    retriedAfter: result.retriedAfter,
    crossCheck: {
      mode: result.crossCheck.mode,
      applied: result.crossCheck.applied,
      workedProvider: result.crossCheck.workedProvider,
      fellBack: result.crossCheck.fellBack,
      blocked: result.crossCheck.blocked,
    },
    skipped: result.skipped.map((skipped) => ({
      executor: skipped.executor,
      profile: skipped.profile,
      reason: skipped.reason,
      detail: skipped.detail,
      untilReset: skipped.untilReset,
    })),
    waiting:
      wait === null
        ? null
        : { mode: wait.mode, on: [...wait.on], until: wait.until, notify: wait.notify },
    occurredAt: context.now,
  };
}
