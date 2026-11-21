// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * The `extra.otheater` block of an ATIF trajectory (architecture 5.11, N219). ATIF leaves every
 * `extra` open (`dict[str, Any]` in Harbor); OTheater puts what the format has no field for under
 * one key, `otheater`, with `schema: 1` so a reader knows which shape it is. The blocks are strict:
 * a key that is not below is a mistake of the exporter, not a free field. [proposta] Every field
 * name and the levels they sit at are the exporter's own (the architecture only lists the levels:
 * root, `agent`, `step`, `tool_calls`, the observation results, `metrics`, `final_metrics` and
 * `subagent_trajectory_ref`).
 */

/** The version of the shape of every block below. */
export const OTHEATER_EXTRA_SCHEMA = 1;

const schemaField = z.literal(OTHEATER_EXTRA_SCHEMA);
const isoTimestamp = z.iso.datetime({ offset: true });
const tokens = z.int().min(0).nullable();
const usd = z.number().min(0).nullable();

/** What the exporter could not take from the event log, so a reader does not look for it. */
export const ATIF_FIDELITY_NOTES = [
  /** The normalized stream of the client carries the title and the paths of a tool call, not its raw input. */
  'tool_arguments_not_in_event_log',
  /** ...nor its raw output: the observation holds the status and the outcome. */
  'tool_output_not_in_event_log',
  /** The text of a prompt is not in the event log: the user step of an attempt comes from its demand. */
  'attempt_prompt_derived_from_demand',
  /** The Director's own turns come from `chat.director_reply`; no `session.update` stream exists for it. */
  'director_turns_from_replies',
  /** The content was replaced by placeholders (`atif.export.content: redacted`). */
  'content_redacted',
] as const;
export type AtifFidelityNote = (typeof ATIF_FIDELITY_NOTES)[number];

/** How the cost of a trajectory was worked out: what the account was charged, or what the API would charge. */
export const ATIF_COST_KINDS = ['real', 'api_equivalent', 'mixed', 'unknown'] as const;
export type AtifCostKind = (typeof ATIF_COST_KINDS)[number];

/** The tokens the plan counts, whatever the account. Null: the client did not report it. */
export const AtifQuotaUsageSchema = z.strictObject({
  inputTokens: tokens,
  outputTokens: tokens,
  cachedTokens: tokens,
});
export type AtifQuotaUsage = z.infer<typeof AtifQuotaUsageSchema>;

export const ATIF_TRAJECTORY_KINDS = ['play', 'attempt'] as const;

/** Root: which play (or attempt) the file is, how it was written and how far it can be trusted. */
export const OtheaterRootExtraSchema = z.strictObject({
  schema: schemaField,
  /** `play`: the Director's trajectory; `attempt`: the work of one Executor on one demand. */
  kind: z.enum(ATIF_TRAJECTORY_KINDS),
  playId: z.string().min(1),
  scenarioId: z.string().min(1).nullable(),
  attemptId: z.string().min(1).nullable(),
  demandId: z.string().min(1).nullable(),
  /** The state of the play machine (`DONE`, `CANCELLED`, `RUNNING`...) when the file was written. */
  state: z.string().min(1).nullable(),
  contentMode: z.enum(['full', 'redacted']),
  exportedAt: isoTimestamp,
  /** The last event of the log the file reflects. */
  lastEventId: z.int().min(0).nullable(),
  fidelity: z.array(z.enum(ATIF_FIDELITY_NOTES)),
});
export type OtheaterRootExtra = z.infer<typeof OtheaterRootExtraSchema>;

/** `agent`: who the trajectory is of, as the OTheater roles name it. */
export const OtheaterAgentExtraSchema = z.strictObject({
  schema: schemaField,
  /** `director` for the root of a play; `actor`, `reviewer`... for an attempt. */
  role: z.string().min(1),
  /** The Executor id (`<model>-<effort>@<client>/<profile>`), when the trajectory has one. */
  executor: z.string().min(1).nullable(),
  client: z.string().min(1).nullable(),
  profile: z.string().min(1).nullable(),
  attemptId: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
});
export type OtheaterAgentExtra = z.infer<typeof OtheaterAgentExtraSchema>;

/** Where a step comes from in the event log. */
export const ATIF_STEP_ORIGINS = [
  'need',
  'demand',
  'director_reply',
  'decision',
  'dispatch',
  'turn',
  'system_message',
] as const;

export const OtheaterPermissionSchema = z.strictObject({
  tool: z.string(),
  toolCallId: z.string().nullable(),
  /** The answer (`allow`, `deny`...), or null while the request waited. */
  answer: z.string().nullable(),
  rule: z.string().nullable(),
  reason: z.string().nullable(),
  paths: z.array(z.string()),
});

/** One step of the plan the agent published in its turn. */
export const OtheaterPlanEntrySchema = z.strictObject({ content: z.string(), status: z.string() });

/** `step`: the event the step stands on, the permissions asked in it, the plan and the stop reason. */
export const OtheaterStepExtraSchema = z.strictObject({
  schema: schemaField,
  origin: z.enum(ATIF_STEP_ORIGINS),
  turnIndex: z.int().min(1).nullable(),
  stopReason: z.string().nullable(),
  /** The first and the last event of the log the step was built from. */
  eventIds: z.tuple([z.int().min(0), z.int().min(0)]).nullable(),
  permissions: z.array(OtheaterPermissionSchema),
  plan: z.array(OtheaterPlanEntrySchema),
  /** The output of a terminal of the Actor, when the client sent it (masked like the rest). */
  terminal: z.array(z.string()),
});
export type OtheaterStepExtra = z.infer<typeof OtheaterStepExtraSchema>;

/** `tool_calls[]`: what the normalized stream says of the call. */
export const OtheaterToolCallExtraSchema = z.strictObject({
  schema: schemaField,
  /** `client`: a tool call of the client's own tools; `daemon`: a tool the daemon served (MCP). */
  source: z.enum(['client', 'daemon']),
  toolKind: z.string().nullable(),
  status: z.string().nullable(),
  paths: z.array(z.string()),
});
export type OtheaterToolCallExtra = z.infer<typeof OtheaterToolCallExtraSchema>;

/** `observation.results[]`: how the call ended. */
export const OtheaterObservationExtraSchema = z.strictObject({
  schema: schemaField,
  status: z.string().nullable(),
  outcome: z.string().nullable(),
  exitCode: z.int().nullable(),
  durationMs: z.int().min(0).nullable(),
});
export type OtheaterObservationExtra = z.infer<typeof OtheaterObservationExtraSchema>;

/**
 * `metrics`: the cost is real only on an account that is charged per token. On a subscription
 * `cost_usd` is null and the API-equivalent cost sits here, with the tokens the quota counted.
 */
export const OtheaterMetricsExtraSchema = z.strictObject({
  schema: schemaField,
  costKind: z.enum(ATIF_COST_KINDS),
  /** `client` (the client reported it) or `pricing_table` (the daemon priced the tokens). */
  costSource: z.enum(['client', 'pricing_table']).nullable(),
  pricingVersion: z.string().nullable(),
  /** What the tokens would cost by API; null where the cost is real or unknown. */
  apiEquivalentCostUsd: usd,
  quota: AtifQuotaUsageSchema,
  usageIds: z.array(z.string()),
});
export type OtheaterMetricsExtra = z.infer<typeof OtheaterMetricsExtraSchema>;

/** `final_metrics`: the sums, and the scope they were taken over. */
export const OtheaterFinalMetricsExtraSchema = z.strictObject({
  schema: schemaField,
  /** `play`: every session of the play (the Director's too); `attempt`: the one attempt. */
  scope: z.enum(ATIF_TRAJECTORY_KINDS),
  costKind: z.enum(ATIF_COST_KINDS),
  realCostUsd: usd,
  apiEquivalentCostUsd: usd,
  quota: AtifQuotaUsageSchema,
  usageRecords: z.int().min(0),
});
export type OtheaterFinalMetricsExtra = z.infer<typeof OtheaterFinalMetricsExtraSchema>;

/** `subagent_trajectory_ref`: the attempt the Director's step dispatched. */
export const OtheaterSubagentRefExtraSchema = z.strictObject({
  schema: schemaField,
  attemptId: z.string().min(1),
  demandId: z.string().min(1).nullable(),
  /** The `attempt` number of the demand (1, 2...). */
  attempt: z.int().min(1).nullable(),
  state: z.string().nullable(),
  role: z.string().nullable(),
});
export type OtheaterSubagentRefExtra = z.infer<typeof OtheaterSubagentRefExtraSchema>;
