// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import {
  OtheaterAgentExtraSchema,
  OtheaterFinalMetricsExtraSchema,
  OtheaterMetricsExtraSchema,
  OtheaterObservationExtraSchema,
  OtheaterRootExtraSchema,
  OtheaterStepExtraSchema,
  OtheaterSubagentRefExtraSchema,
  OtheaterToolCallExtraSchema,
} from './otheater-extra.js';

/**
 * ATIF v1.8, the Agent Trajectory Interchange Format of Harbor (RFC 0001), as zod schemas
 * (architecture 5.11, Q11, N219). Source: RFC 0001 and the pydantic models of Harbor
 * (`src/harbor/models/trajectories/*.py`, read with `gh api` on 2026-11-21). Every object is strict,
 * like the `extra="forbid"` of the models: a field the format does not have is an error. The
 * `extra` of each object stays open as in the format, except its `otheater` key, which has a
 * shape of its own (`otheater-extra.ts`). The rules the pydantic validators add across fields and
 * steps are in `validateAtifTrajectory` below.
 */

export const ATIF_SCHEMA_VERSIONS = [
  'ATIF-v1.0',
  'ATIF-v1.1',
  'ATIF-v1.2',
  'ATIF-v1.3',
  'ATIF-v1.4',
  'ATIF-v1.5',
  'ATIF-v1.6',
  'ATIF-v1.7',
  'ATIF-v1.8',
] as const;
/** The version the exporter writes. */
export const ATIF_VERSION = 'ATIF-v1.8';

/** `extra` of an ATIF object: open (`dict[str, Any]`), but `otheater`, when there, has its own shape. */
function extraOf<Block extends z.ZodType>(block: Block) {
  return z.looseObject({ otheater: block.optional() }).optional();
}

const jsonDict = z.record(z.string(), z.unknown());

/** The audio types ATIF accepts, and the spellings it folds into them (`audio/mp3` is `audio/mpeg`). */
export const ATIF_AUDIO_MEDIA_TYPES = [
  'audio/wav',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/webm',
  'audio/aiff',
] as const;
const AUDIO_ALIASES: Readonly<Record<string, string>> = {
  'audio/mp3': 'audio/mpeg',
  'audio/mpga': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-aac': 'audio/aac',
  'audio/x-flac': 'audio/flac',
  'audio/x-aiff': 'audio/aiff',
};

export const AtifImageSourceSchema = z.strictObject({
  media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
  path: z.string(),
});

export const AtifAudioSourceSchema = z.strictObject({
  media_type: z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    return AUDIO_ALIASES[normalized] ?? normalized;
  }, z.enum(ATIF_AUDIO_MEDIA_TYPES)),
  path: z.string(),
  duration_sec: z.number().min(0).nullable().optional(),
});

/** A part of a multimodal message: `text`, or an `image` or `audio` with its `source`. */
export const AtifContentPartSchema = z
  .strictObject({
    type: z.enum(['text', 'image', 'audio']),
    text: z.string().nullable().optional(),
    source: z.union([AtifImageSourceSchema, AtifAudioSourceSchema]).nullable().optional(),
  })
  .superRefine((part, ctx) => {
    const hasText = part.text !== undefined && part.text !== null;
    const hasSource = part.source !== undefined && part.source !== null;
    if (part.type === 'text') {
      if (!hasText)
        ctx.addIssue({ code: 'custom', message: "'text' is required when type='text'" });
      if (hasSource)
        ctx.addIssue({ code: 'custom', message: "'source' is not allowed when type='text'" });
      return;
    }
    if (!hasSource)
      ctx.addIssue({ code: 'custom', message: `'source' is required when type='${part.type}'` });
    if (hasText)
      ctx.addIssue({ code: 'custom', message: `'text' is not allowed when type='${part.type}'` });
    if (hasSource) {
      const isAudio = part.source?.media_type.startsWith('audio/') === true;
      if (isAudio !== (part.type === 'audio'))
        ctx.addIssue({
          code: 'custom',
          message: `type='${part.type}' needs a source of its own kind, not ${String(part.source?.media_type)}`,
        });
    }
  });

/** Text, or the parts of a multimodal content (ATIF-v1.6). */
export const AtifContentSchema = z.union([z.string(), z.array(AtifContentPartSchema)]);

export const AtifAgentSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  model_name: z.string().nullable().optional(),
  tool_definitions: z.array(jsonDict).nullable().optional(),
  extra: extraOf(OtheaterAgentExtraSchema),
});

export const AtifToolCallSchema = z.strictObject({
  tool_call_id: z.string(),
  function_name: z.string(),
  arguments: jsonDict,
  extra: extraOf(OtheaterToolCallExtraSchema),
});

/** A reference to a delegated trajectory: embedded (`trajectory_id`) or in another file (`trajectory_path`). */
export const AtifSubagentTrajectoryRefSchema = z
  .strictObject({
    trajectory_id: z.string().nullable().optional(),
    session_id: z.string().nullable().optional(),
    trajectory_path: z.string().nullable().optional(),
    extra: extraOf(OtheaterSubagentRefExtraSchema),
  })
  .refine((ref) => ref.trajectory_id != null || ref.trajectory_path != null, {
    message: 'a reference must be resolvable: set trajectory_id or trajectory_path',
  });

export const AtifObservationResultSchema = z.strictObject({
  source_call_id: z.string().nullable().optional(),
  content: AtifContentSchema.nullable().optional(),
  subagent_trajectory_ref: z.array(AtifSubagentTrajectoryRefSchema).nullable().optional(),
  extra: extraOf(OtheaterObservationExtraSchema),
});

export const AtifObservationSchema = z.strictObject({
  results: z.array(AtifObservationResultSchema),
});

export const AtifMetricsSchema = z.strictObject({
  prompt_tokens: z.int().nullable().optional(),
  completion_tokens: z.int().nullable().optional(),
  cached_tokens: z.int().nullable().optional(),
  cost_usd: z.number().nullable().optional(),
  prompt_token_ids: z.array(z.int()).nullable().optional(),
  completion_token_ids: z.array(z.int()).nullable().optional(),
  logprobs: z.array(z.number()).nullable().optional(),
  extra: extraOf(OtheaterMetricsExtraSchema),
});

export const AtifFinalMetricsSchema = z.strictObject({
  total_prompt_tokens: z.int().nullable().optional(),
  total_completion_tokens: z.int().nullable().optional(),
  total_cached_tokens: z.int().nullable().optional(),
  total_cost_usd: z.number().nullable().optional(),
  total_steps: z.int().min(0).nullable().optional(),
  extra: extraOf(OtheaterFinalMetricsExtraSchema),
});

/** ISO 8601, as Python's `datetime.fromisoformat` reads it (with `Z` taken as UTC). */
const AtifTimestampSchema = z
  .string()
  .refine(
    (text) =>
      /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(text) &&
      !Number.isNaN(Date.parse(text)),
    {
      message: 'expected an ISO 8601 timestamp',
    },
  );

const AGENT_ONLY_STEP_FIELDS = [
  'model_name',
  'reasoning_effort',
  'reasoning_content',
  'tool_calls',
  'metrics',
] as const;

export const AtifStepSchema = z
  .strictObject({
    step_id: z.int().min(1),
    timestamp: AtifTimestampSchema.nullable().optional(),
    source: z.enum(['system', 'user', 'agent']),
    model_name: z.string().nullable().optional(),
    reasoning_effort: z.union([z.string(), z.number()]).nullable().optional(),
    message: AtifContentSchema,
    reasoning_content: z.string().nullable().optional(),
    tool_calls: z.array(AtifToolCallSchema).nullable().optional(),
    observation: AtifObservationSchema.nullable().optional(),
    metrics: AtifMetricsSchema.nullable().optional(),
    is_copied_context: z.boolean().nullable().optional(),
    llm_call_count: z.int().min(0).nullable().optional(),
    extra: extraOf(OtheaterStepExtraSchema),
  })
  .superRefine((step, ctx) => {
    if (step.source !== 'agent') {
      for (const field of AGENT_ONLY_STEP_FIELDS) {
        if (step[field] != null)
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `'${field}' is only applicable when source is 'agent', not '${step.source}'`,
          });
      }
    }
    if (step.llm_call_count === 0 && step.source === 'agent') {
      for (const field of ['metrics', 'reasoning_content'] as const) {
        if (step[field] != null)
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `'${field}' must be absent when llm_call_count is 0 (a dispatch with no LLM call)`,
          });
      }
    }
  });
export type AtifStep = z.infer<typeof AtifStepSchema>;

/**
 * One trajectory. The recursion (`subagent_trajectories`) is a getter, so the type is inferred; the
 * rules across steps and subagents are applied by {@link AtifTrajectorySchema}.
 */
export const AtifTrajectoryShapeSchema = z.strictObject({
  schema_version: z.enum(ATIF_SCHEMA_VERSIONS).default(ATIF_VERSION),
  session_id: z.string().nullable().optional(),
  trajectory_id: z.string().nullable().optional(),
  agent: AtifAgentSchema,
  steps: z.array(AtifStepSchema).min(1),
  notes: z.string().nullable().optional(),
  final_metrics: AtifFinalMetricsSchema.nullable().optional(),
  continued_trajectory_ref: z.string().nullable().optional(),
  extra: extraOf(OtheaterRootExtraSchema),
  get subagent_trajectories() {
    return z.array(AtifTrajectoryShapeSchema).nullable().optional();
  },
});

/**
 * The inferred type of a schema that refers to itself leaves the embedded trajectories as
 * `unknown`, so the recursion is written out here.
 */
export type AtifTrajectory = Omit<
  z.infer<typeof AtifTrajectoryShapeSchema>,
  'subagent_trajectories'
> & { subagent_trajectories?: AtifTrajectory[] | null | undefined };
type ShapeTrajectory = AtifTrajectory;

/** The rules the pydantic validators of `Trajectory` add: sequential step ids, resolvable calls, unique subagent ids. */
function checkTrajectory(
  trajectory: ShapeTrajectory,
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const issue = (at: readonly (string | number)[], message: string): void => {
    ctx.addIssue({ code: 'custom', path: [...path, ...at], message });
  };
  trajectory.steps.forEach((step, index) => {
    if (step.step_id !== index + 1)
      issue(
        ['steps', index, 'step_id'],
        `expected ${String(index + 1)} (sequential from 1), got ${String(step.step_id)}`,
      );
    const callIds = new Set((step.tool_calls ?? []).map((call) => call.tool_call_id));
    (step.observation?.results ?? []).forEach((result, at) => {
      const id = result.source_call_id;
      if (id != null && !callIds.has(id))
        issue(
          ['steps', index, 'observation', 'results', at, 'source_call_id'],
          `'${id}' is not a tool_call_id of the tool_calls of step ${String(step.step_id)}`,
        );
    });
  });
  const seen = new Set<string>();
  (trajectory.subagent_trajectories ?? []).forEach((sub, index) => {
    const id = sub.trajectory_id;
    if (id == null)
      issue(
        ['subagent_trajectories', index, 'trajectory_id'],
        'required on an embedded trajectory',
      );
    else if (seen.has(id))
      issue(['subagent_trajectories', index, 'trajectory_id'], `'${id}' is not unique`);
    else seen.add(id);
    checkTrajectory(sub, [...path, 'subagent_trajectories', index], ctx);
  });
}

/** An ATIF v1.8 trajectory: strict, with the cross-field rules of Harbor's `Trajectory`. */
export const AtifTrajectorySchema = AtifTrajectoryShapeSchema.superRefine((trajectory, ctx) => {
  checkTrajectory(trajectory, [], ctx);
});
export type AtifToolCall = z.infer<typeof AtifToolCallSchema>;
export type AtifObservationResult = z.infer<typeof AtifObservationResultSchema>;
export type AtifMetrics = z.infer<typeof AtifMetricsSchema>;
export type AtifFinalMetrics = z.infer<typeof AtifFinalMetricsSchema>;
export type AtifContentPart = z.infer<typeof AtifContentPartSchema>;
export type AtifSubagentTrajectoryRef = z.infer<typeof AtifSubagentTrajectoryRefSchema>;
