// SPDX-License-Identifier: MPL-2.0

/**
 * The normalized conversation (architecture 5.2, "Casca de agente"). The schemas live in
 * `@otheater/core` because the `AgentSession` port hands these values out and core cannot import
 * the protocol; this module is where wire consumers (daemon API, SDK, interfaces) import them.
 */
export {
  CONFIG_CATEGORIES,
  ConfigValueSchema,
  ContentBlockSchema,
  NORMALIZED_UPDATE_KINDS,
  NormalizedUpdateSchema,
  PLAN_ENTRY_STATUSES,
  PLAN_PRIORITIES,
  PlanEntrySchema,
  RATE_LIMIT_STATUSES,
  STOP_REASONS,
  StopReasonSchema,
  TOOL_CALL_STATUSES,
  TOOL_KINDS,
  ToolCallStatusSchema,
  ToolKindSchema,
  ToolLocationSchema,
} from '@otheater/core';
export type {
  ConfigCategory,
  ConfigValue,
  ContentBlock,
  NormalizedUpdate,
  NormalizedUpdateKind,
  PlanEntry,
  StopReason,
  ToolCallStatus,
  ToolKind,
  ToolLocation,
} from '@otheater/core';
