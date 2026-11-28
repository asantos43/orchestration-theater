// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * Payloads of the events of the triggers of the workflow bindings and of the poll loop (docs/24
 * section 8, D3 and D6; plan of Phase 11b, P6). Registered in `DAEMON_EVENT_DEFINITIONS`
 * (events.ts) at `schemaVersion` 1; strict objects.
 * [proposta] The names of the fields, of the trigger types and of the reasons. The trigger type is
 * a free word here (`event`, `code_host.issue_opened`...): the daemon owns the list
 * (`WORKFLOW_TRIGGER_TYPES`), so a new type does not need a new protocol version.
 */

const TriggerTypeSchema = z.string().min(1).max(64);

/** What one firing is about: the same words the log and the run use to tell it from the others. */
const TriggerKeySchema = z.string().min(1).max(512);

/**
 * `workflow.trigger.fired`: a trigger of a binding started a run. `key` is what identifies the
 * item (`issue:12`, `pr:7`, `ci:7:<sha>`, `event:<id>`): the same key never fires twice for the
 * same binding. `number` is the issue or pull request number (`null` for an event). `replaced`
 * lists the runs the binding cancelled to make room (`workflows.binding.on_busy: replace`).
 */
export const WorkflowTriggerFiredPayloadSchema = z.strictObject({
  bindingId: z.string().min(1),
  scenarioId: z.string().min(1),
  workflowId: z.string().min(1),
  triggerType: TriggerTypeSchema,
  key: TriggerKeySchema,
  runId: z.string().min(1),
  number: z.int().min(1).nullable(),
  replaced: z.array(z.string().min(1)),
});

/** Why a trigger did not fire (`workflow.trigger.skipped`). */
export const WORKFLOW_TRIGGER_SKIP_REASONS = [
  /** The author is not allowed by `workflows.triggers.authors`. */
  'author',
  /** The binding is at its `concurrency` and `workflows.binding.on_busy` is `queue` or `skip`. */
  'busy',
  /** The Producer paused the binding. */
  'paused',
  /** The budget of the period ran out and the binding is paused or stopped. */
  'budget',
  /** A plugin event that the manifest does not declare as a trigger. */
  'undeclared',
  /** A plugin event of a plugin that is not installed or not active in the scenario. */
  'plugin_inactive',
  /** `workflows.triggers.plugin_events` is `off`. */
  'plugin_events_off',
  /** The runtime refused to start the run (the definition or the inputs do not fit). */
  'refused',
  /** No definition in the library answers the binding any more. */
  'no_workflow',
  /** The trigger of the binding is not one this daemon knows (a typo, or a newer type). */
  'invalid',
] as const;

export type WorkflowTriggerSkipReason = (typeof WORKFLOW_TRIGGER_SKIP_REASONS)[number];

/**
 * `workflow.trigger.skipped`: an item reached a trigger and did not start a run. `retry` is `true`
 * when the item is kept for the next poll (a `queue` binding that is busy) and `false` when it is
 * dropped for good (it is marked as seen). `detail` is a short text for the Producer.
 */
export const WorkflowTriggerSkippedPayloadSchema = z.strictObject({
  bindingId: z.string().min(1),
  scenarioId: z.string().min(1),
  workflowId: z.string().min(1),
  triggerType: TriggerTypeSchema,
  key: TriggerKeySchema,
  reason: z.enum(WORKFLOW_TRIGGER_SKIP_REASONS),
  retry: z.boolean(),
  detail: z.string().max(400).optional(),
});

/**
 * `workflow.poll.failed`: one look at a source failed (the code host could not be reached, the
 * token was refused...). `action` is what `workflows.triggers.poll.on_error` did: `backoff` waits
 * longer before the next look (`retryInMs`), `pause_binding` paused the binding (`retryInMs` is
 * `null`: the Producer resumes it). `failures` counts the failures in a row of this source. The
 * three ids are `null` when the source is not a binding: the look at the event log, which every
 * `event` trigger shares.
 */
export const WorkflowPollFailedPayloadSchema = z.strictObject({
  bindingId: z.string().min(1).nullable(),
  scenarioId: z.string().min(1).nullable(),
  workflowId: z.string().min(1).nullable(),
  triggerType: TriggerTypeSchema,
  error: z.string().min(1).max(400),
  failures: z.int().min(1),
  action: z.enum(['backoff', 'pause_binding']),
  retryInMs: z.int().min(0).nullable(),
});
