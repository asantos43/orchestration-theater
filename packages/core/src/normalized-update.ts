// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * The normalized conversation of an Executor (architecture 5.2, "Casca de agente"): what the shell
 * of each client turns the ACP stream into, so the rest of the daemon (Director, pipeline, TUI,
 * telemetry, quota) never sees the client behind it. Names follow ACP 2.7.0 (`@agentclientprotocol/sdk`,
 * stable `v1` schema) where a counterpart exists, but nothing here imports that SDK.
 *
 * [proposta] The schemas live in core, not in `@otheater/protocol`, because the `AgentSession` port
 * (core) hands out these values and the dependency rule forbids core from importing the protocol.
 * `@otheater/protocol` re-exports them, so wire consumers import them from there.
 *
 * Every object is strict: an unknown field is an error, so a normalizer that forgets to drop a
 * client-specific field fails loudly. Times are epoch milliseconds (integers), like the `Clock`.
 */

/** Why a prompt turn ended, normalized (ACP `StopReason`). */
export const STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
] as const;
export const StopReasonSchema = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReasonSchema>;

const nonEmpty = z.string().min(1).max(256);

/**
 * A piece of content, in a prompt or in an agent message (ACP `ContentBlock`). `image` and `audio`
 * carry base64 `data`. `resource` is an embedded resource: text or a base64 blob.
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string().min(1),
    uri: z.string().min(1).optional(),
  }),
  z.strictObject({ type: z.literal('audio'), data: z.string(), mimeType: z.string().min(1) }),
  z.strictObject({
    type: z.literal('resource_link'),
    uri: z.string().min(1),
    name: z.string().min(1),
    mimeType: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('resource'),
    resource: z.union([
      z.strictObject({
        uri: z.string().min(1),
        text: z.string(),
        mimeType: z.string().min(1).optional(),
      }),
      z.strictObject({
        uri: z.string().min(1),
        blob: z.string(),
        mimeType: z.string().min(1).optional(),
      }),
    ]),
  }),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/** Kind of a tool call (ACP `ToolKind`). */
export const TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
] as const;
export const ToolKindSchema = z.enum(TOOL_KINDS);
export type ToolKind = z.infer<typeof ToolKindSchema>;

/** Status of a tool call (ACP `ToolCallStatus`). */
export const TOOL_CALL_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const;
export const ToolCallStatusSchema = z.enum(TOOL_CALL_STATUSES);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

/** A file a tool call touches (ACP `ToolCallLocation`). */
export const ToolLocationSchema = z.strictObject({
  path: z.string().min(1),
  line: z.int().min(0).optional(),
});
export type ToolLocation = z.infer<typeof ToolLocationSchema>;

export const PLAN_PRIORITIES = ['high', 'medium', 'low'] as const;
export const PLAN_ENTRY_STATUSES = ['pending', 'in_progress', 'completed'] as const;

export const PlanEntrySchema = z.strictObject({
  content: z.string(),
  priority: z.enum(PLAN_PRIORITIES),
  status: z.enum(PLAN_ENTRY_STATUSES),
});
export type PlanEntry = z.infer<typeof PlanEntrySchema>;

/** Categories of session config options (ACP `SessionConfigOptionCategory`, the known ones). */
export const CONFIG_CATEGORIES = ['model', 'thought_level', 'mode', 'model_config'] as const;
export type ConfigCategory = (typeof CONFIG_CATEGORIES)[number];

/** Value of a session config option: a select value id or a boolean (ACP `SessionConfigBoolean`). */
export const ConfigValueSchema = z.union([z.string(), z.boolean()]);
export type ConfigValue = z.infer<typeof ConfigValueSchema>;

export const RATE_LIMIT_STATUSES = ['allowed', 'warning', 'rejected'] as const;

const messageChunk = {
  content: ContentBlockSchema,
  messageId: nonEmpty.optional(),
};

/**
 * One normalized update of a session, discriminated by `kind` (architecture 5.2 and 5.11). It is
 * what `AgentSession.onUpdate` delivers and what the `session.update` event carries.
 *
 * - `agent_message_chunk`, `agent_thought_chunk`: streamed text (ACP `agent_message_chunk` and
 *   `agent_thought_chunk`).
 * - `tool_call`, `tool_call_update`: a tool call starts, then changes (ACP `tool_call`,
 *   `tool_call_update`). The update carries only what changed.
 * - `plan`: the agent's plan, always the full list (ACP `plan`).
 * - `usage`: tokens and cost of a turn or a model call. [proposta] Besides the token counters it
 *   may carry the context window use (`contextUsed`, `contextSize`), which is what the ACP
 *   `usage_update` reports; at least one numeric field is required.
 * - `available_commands`: the `/` commands of the client (ACP `available_commands_update`).
 * - `config_changed`: the session config options that now have another value (ACP
 *   `config_option_update` and `current_mode_update`, which the normalizer turns into this).
 * - `rate_limit`: the client's own rate-limit signal (the `rate_limit_event` of Claude). It comes
 *   with `resetsAt` as epoch ms when the client says it.
 */
export const NormalizedUpdateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('agent_message_chunk'), ...messageChunk }),
  z.strictObject({ kind: z.literal('agent_thought_chunk'), ...messageChunk }),
  z.strictObject({
    kind: z.literal('tool_call'),
    toolCallId: nonEmpty,
    title: z.string(),
    toolKind: ToolKindSchema,
    status: ToolCallStatusSchema,
    locations: z.array(ToolLocationSchema).optional(),
  }),
  z.strictObject({
    kind: z.literal('tool_call_update'),
    toolCallId: nonEmpty,
    title: z.string().optional(),
    toolKind: ToolKindSchema.optional(),
    status: ToolCallStatusSchema.optional(),
    locations: z.array(ToolLocationSchema).optional(),
  }),
  z.strictObject({ kind: z.literal('plan'), entries: z.array(PlanEntrySchema) }),
  z
    .strictObject({
      kind: z.literal('usage'),
      model: nonEmpty.optional(),
      inputTokens: z.int().min(0).optional(),
      outputTokens: z.int().min(0).optional(),
      cacheReadTokens: z.int().min(0).optional(),
      cacheWriteTokens: z.int().min(0).optional(),
      contextUsed: z.int().min(0).optional(),
      contextSize: z.int().min(0).optional(),
      costUsd: z.number().min(0).optional(),
    })
    .refine(
      (u) =>
        u.inputTokens !== undefined ||
        u.outputTokens !== undefined ||
        u.cacheReadTokens !== undefined ||
        u.cacheWriteTokens !== undefined ||
        u.contextUsed !== undefined ||
        u.contextSize !== undefined ||
        u.costUsd !== undefined,
      { message: 'A usage update needs at least one numeric field' },
    ),
  z.strictObject({
    kind: z.literal('available_commands'),
    commands: z.array(
      z.strictObject({
        name: z.string().min(1),
        description: z.string(),
        inputHint: z.string().optional(),
      }),
    ),
  }),
  z.strictObject({
    kind: z.literal('config_changed'),
    options: z
      .array(
        z.strictObject({
          id: nonEmpty,
          /** One of {@link CONFIG_CATEGORIES} or a client-specific category. */
          category: z.string().min(1).optional(),
          value: ConfigValueSchema,
        }),
      )
      .min(1),
  }),
  z.strictObject({
    kind: z.literal('rate_limit'),
    status: z.enum(RATE_LIMIT_STATUSES),
    /**
     * The window, in the name the daemon uses (`5h`, `7d`), not the client's own (`five_hour`,
     * `seven_day`): the quota service keeps it as it comes, and a probe's windows are these names.
     */
    window: z.string().min(1).optional(),
    usedPercent: z.number().min(0).optional(),
    resetsAt: z.int().min(0).optional(),
  }),
]);
export type NormalizedUpdate = z.infer<typeof NormalizedUpdateSchema>;
export type NormalizedUpdateKind = NormalizedUpdate['kind'];

/** Every `kind` of {@link NormalizedUpdate}, in the order of the schema. */
export const NORMALIZED_UPDATE_KINDS = [
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'plan',
  'usage',
  'available_commands',
  'config_changed',
  'rate_limit',
] as const satisfies readonly NormalizedUpdateKind[];
