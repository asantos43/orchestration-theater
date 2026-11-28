// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the bindings of the scenarios (N296; plan of Phase 11b, P5).
 * Registered in `DAEMON_EVENT_DEFINITIONS` (events.ts) at `schemaVersion` 1; strict objects.
 * [proposta] The names of the fields. The states and reasons mirror `WORKFLOW_BINDING_STATES` and
 * `WORKFLOW_BINDING_REASONS` of `@otheater/core` (the protocol does not import it).
 */

const BindingStateSchema = z.enum(['active', 'paused', 'stopped', 'expired']);
const BindingReasonSchema = z.enum(['producer', 'budget', 'deadline']);

/**
 * `workflow.binding.changed`: a binding was created (`from` is `null`) or moved to another state:
 * the Producer paused, resumed or stopped it, the budget of the period paused or stopped it, or
 * its deadline passed. `reason` is `null` when it became `active`.
 */
export const WorkflowBindingChangedPayloadSchema = z.strictObject({
  bindingId: z.string().min(1),
  scenarioId: z.string().min(1),
  workflowId: z.string().min(1),
  from: BindingStateSchema.nullable(),
  to: BindingStateSchema,
  reason: BindingReasonSchema.nullable(),
});

/**
 * `workflow.budget_exhausted`: the spend of a binding reached the budget of its period. `action`
 * is what `workflows.budget.on_exhausted` did with the binding (`pause` or `stop`); the
 * Producer sees a warning in the chat. The amounts are in USD.
 */
export const WorkflowBudgetExhaustedPayloadSchema = z.strictObject({
  bindingId: z.string().min(1),
  scenarioId: z.string().min(1),
  workflowId: z.string().min(1),
  budgetUsd: z.number().positive(),
  spentUsd: z.number().min(0),
  period: z.enum(['day', 'week', 'month']),
  /** When the period that ran out started (epoch ms). */
  periodStartedAt: z.int().min(0),
  action: z.enum(['pause', 'stop']),
});
