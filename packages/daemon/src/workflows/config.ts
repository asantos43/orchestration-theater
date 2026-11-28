// SPDX-License-Identifier: MPL-2.0
import {
  WORKFLOW_LEGACY_SNAPSHOT_MODES,
  type WorkflowLegacySnapshotMode,
} from '@otheater/protocol';
import {
  WORKFLOW_BUDGET_PERIODS,
  WORKFLOW_ON_BUSY,
  type WorkflowBudgetPeriod,
  type WorkflowOnBusy,
} from '@otheater/core';

/**
 * The keys `workflows.default`, `workflows.allowed`, `workflows.budget.*` and
 * `workflows.binding.*` (docs/24 section 7 and 12, N296; plan of Phase 11b, P5). The first five are
 * the ones of the plan; `budget.period` is [proposta] (the plan fixes "budget per period" but not
 * the length of the period, so it is a key with three modes).
 *
 * - `default`: the workflow a play is born in when nobody chose one (`play`, or the id of a
 *   definition of the library).
 * - `allowed`: `all_installed` (default) lets any definition of the library be chosen; a list of ids
 *   limits the choice to those.
 * - `budget.on_exhausted`: what a binding does when the budget of the period is used up. `pause`
 *   (default) pauses it, and it resumes in the next period; `stop` ends it.
 * - `budget.period`: the length of the period of a new binding: `day` (default), `week` or
 *   `month` (24 h, 7 d and 30 d from the creation of the binding).
 * - `binding.concurrency`: how many runs of one binding may be live at once (default 1).
 * - `binding.on_busy`: what a trigger does when the binding is at its concurrency: `queue`
 *   (default), `skip` or `replace`.
 * - `legacy_snapshot` (P3, D2/N311, [proposta] the modes): what the daemon does, at start-up, with a
 *   play saved by version 1 of the hand-written machine. There is no migration of 1.x. `reject`
 *   (default) leaves the record as it is, writes `workflow.snapshot_rejected` and warns in the
 *   chat; `cancel` cancels the play, records it and writes the same event.
 */
export const WORKFLOW_BUDGET_ON_EXHAUSTED_MODES = ['pause', 'stop'] as const;
export type WorkflowBudgetOnExhausted = (typeof WORKFLOW_BUDGET_ON_EXHAUSTED_MODES)[number];

/** The value of `workflows.allowed` that lets every installed definition be chosen. */
export const WORKFLOWS_ALL_INSTALLED = 'all_installed';

export { WORKFLOW_BUDGET_PERIODS, WORKFLOW_ON_BUSY, WORKFLOW_LEGACY_SNAPSHOT_MODES };
export type { WorkflowLegacySnapshotMode };

/** `workflows` as the library and the bindings read it. */
export interface WorkflowsSettings {
  readonly default: string;
  readonly allowed: typeof WORKFLOWS_ALL_INSTALLED | readonly string[];
  readonly budget: {
    readonly on_exhausted: WorkflowBudgetOnExhausted;
    readonly period: WorkflowBudgetPeriod;
  };
  readonly binding: {
    readonly concurrency: number;
    readonly on_busy: WorkflowOnBusy;
  };
  /** P3: what becomes of a play saved by the hand-written machine (1.x). */
  readonly legacy_snapshot: WorkflowLegacySnapshotMode;
}

/** The defaults of `workflows`, for a service built without a configuration. */
export const DEFAULT_WORKFLOWS_SETTINGS: WorkflowsSettings = {
  default: 'play',
  allowed: WORKFLOWS_ALL_INSTALLED,
  budget: { on_exhausted: 'pause', period: 'day' },
  binding: { concurrency: 1, on_busy: 'queue' },
  legacy_snapshot: 'reject',
};
