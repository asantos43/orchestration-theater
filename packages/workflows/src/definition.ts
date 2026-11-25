// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';

/**
 * The schema of a workflow definition (docs/24, §4; plan of Phase 11b, P1). A definition is data,
 * never code: it names step types from the official registry, joins them by edges with closed
 * conditions, and bounds every cycle by a key of `limits`. The shape below is a [proposta].
 *
 * ```yaml
 * id: github-issues
 * version: 1.0.0
 * engine: ">=1 <2"
 * inputs:
 *   repo: { type: code_host_repo }
 * nodes:
 *   read:  { step: fetch_issue }
 *   check: { step: critique }
 * edges:
 *   - read -> check
 *   - check -> done when output.approved
 *   - { from: check, to: read, when: not output.approved, limit: redo }
 * limits: { redo: 2, budget_usd: 5, max_duration: 4h }
 * ```
 */

/** The ends of a workflow: reserved node ids, targets of an edge, never sources. */
export const TERMINALS = ['done', 'cancelled', 'failed'] as const;
export type Terminal = (typeof TERMINALS)[number];

export function isTerminal(id: string): id is Terminal {
  return (TERMINALS as readonly string[]).includes(id);
}

/** Lowercase snake case, like the role and tool ids. */
const ID_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** A definition id may use `-` too (`github-issues`). */
const DEFINITION_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** Semantic version without build metadata: `1.0.0`, `2.1.0-rc.1`. */
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
/** A duration: a positive integer and a unit (`30s`, `15m`, `4h`, `2d`). */
export const DURATION_PATTERN = /^[1-9]\d*(s|m|h|d)$/;

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Milliseconds of a duration that matched {@link DURATION_PATTERN}. */
export function durationMs(text: string): number {
  const unit = text.slice(-1) as keyof typeof UNIT_MS;
  return Number(text.slice(0, -1)) * UNIT_MS[unit];
}

export const NodeIdSchema = z
  .string()
  .regex(ID_PATTERN, 'a node id is lowercase snake case')
  .refine((id) => !isTerminal(id), 'done, cancelled and failed are reserved');

/**
 * The types an input can declare. The scalar ones are the field types of the conditions; the
 * named ones (`code_host_repo`, `duration`) read as strings in a condition and carry their own
 * check where the run starts. [proposta]
 */
export const INPUT_SCALAR_TYPES = ['string', 'number', 'boolean'] as const;
export const INPUT_NAMED_TYPES = ['code_host_repo', 'duration'] as const;

const InputScalarSchema = z.enum([...INPUT_SCALAR_TYPES, ...INPUT_NAMED_TYPES]);

const InputTypeSchema = z.union([
  InputScalarSchema,
  z.strictObject({ enum: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ list: z.enum(INPUT_SCALAR_TYPES) }),
]);
export type InputType = z.infer<typeof InputTypeSchema>;

export const InputSchema = z.strictObject({
  type: InputTypeSchema,
  /** Default `false` when there is a `default`, `true` otherwise. */
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().max(500).optional(),
});
export type WorkflowInput = z.infer<typeof InputSchema>;

export const TriggerSchema = z.strictObject({
  /** A type of the trigger registry (architecture 5.20), checked by the validator. */
  type: z.string().min(1),
  filter: z.record(z.string(), z.unknown()).optional(),
});
export type WorkflowTrigger = z.infer<typeof TriggerSchema>;

export const NodeSchema = z.strictObject({
  /** A type of the step registry: the validator checks it and the params. */
  step: z.string().regex(ID_PATTERN, 'a step type is lowercase snake case'),
  /** The role, when the step type takes one; default: the role the step type declares. */
  role: z.string().regex(ID_PATTERN).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  description: z.string().max(500).optional(),
});
export type WorkflowNode = z.infer<typeof NodeSchema>;

/** The edge as written: `a -> b`, `a -> b when <condition>`, `{ "a -> b when": <condition> }`, or the object. */
export const EdgeObjectSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  when: z.string().min(1).optional(),
  /** A key of `limits`: how many times the edges with this key may be taken in one run. */
  limit: z.string().regex(ID_PATTERN).optional(),
  /**
   * Where the run goes when the edge would be taken once more than its limit allows; default
   * `failed`. The play sends it to the Producer. [proposta]
   */
  on_limit: z.string().min(1).optional(),
});
export type EdgeObject = z.infer<typeof EdgeObjectSchema>;

const EDGE_TEXT = /^\s*([a-z][a-z0-9_]*)\s*->\s*([a-z][a-z0-9_]*)\s*(?:\bwhen\b\s*(.*?))?\s*$/s;
const EDGE_KEY = /^\s*([a-z][a-z0-9_]*)\s*->\s*([a-z][a-z0-9_]*)\s+when\s*$/;

/** Turns every written form of an edge into the object form, or says why it cannot. */
export function normalizeEdge(
  raw: unknown,
): { ok: true; edge: EdgeObject } | { ok: false; message: string } {
  if (typeof raw === 'string') {
    const match = EDGE_TEXT.exec(raw);
    if (match === null)
      return { ok: false, message: 'an edge reads "from -> to" or "from -> to when <condition>"' };
    const [, from = '', to = '', when] = match;
    if (when?.trim() === '') return { ok: false, message: 'when without a condition' };
    return { ok: true, edge: when === undefined ? { from, to } : { from, to, when } };
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    const only = keys.length === 1 ? keys[0] : undefined;
    if (only !== undefined && EDGE_KEY.test(only)) {
      // The YAML of `- a -> b when: output.x` reads as the map { "a -> b when": "output.x" }.
      const value = (raw as Record<string, unknown>)[only];
      const match = EDGE_KEY.exec(only);
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, message: 'when without a condition' };
      }
      return { ok: true, edge: { from: match?.[1] ?? '', to: match?.[2] ?? '', when: value } };
    }
    const parsed = EdgeObjectSchema.safeParse(raw);
    if (parsed.success) return { ok: true, edge: parsed.data };
    return { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  return { ok: false, message: 'an edge is a text or an object' };
}

// The union is for the JSON Schema (the three written forms); the refinement is the real check.
const EdgeSchema = z
  .union([z.string(), EdgeObjectSchema, z.record(z.string(), z.string())])
  .superRefine((raw, ctx) => {
    const result = normalizeEdge(raw);
    if (!result.ok) ctx.addIssue({ code: 'custom', message: result.message });
  });

/** The limits that are not loop counters. Every other key of `limits` bounds an edge. */
export const RESERVED_LIMITS = ['budget_usd', 'max_duration', 'max_steps'] as const;

export const LimitsSchema = z
  .record(z.string().regex(ID_PATTERN, 'a limit is lowercase snake case'), z.unknown())
  .superRefine((limits, ctx) => {
    for (const [key, value] of Object.entries(limits)) {
      const path = [key];
      if (key === 'budget_usd') {
        if (typeof value !== 'number' || !(value > 0)) {
          ctx.addIssue({ code: 'custom', path, message: 'budget_usd is a positive number' });
        }
      } else if (key === 'max_duration') {
        if (typeof value !== 'string' || !DURATION_PATTERN.test(value)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: 'max_duration is a duration like 30m or 4h',
          });
        }
      } else if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        ctx.addIssue({ code: 'custom', path, message: `${key} is a positive integer` });
      }
    }
  });

export const RequiresSchema = z.strictObject({
  plugins: z.array(z.string().min(1)).optional(),
  tools: z.array(z.string().min(1)).optional(),
});

export const WorkflowDefinitionSchema = z.strictObject({
  id: z.string().regex(DEFINITION_ID_PATTERN, 'an id is lowercase, with _ or -'),
  version: z.string().regex(SEMVER_PATTERN, 'a version is semver (1.0.0)'),
  /** The range of engine versions the definition accepts, like `>=1 <2`. */
  engine: z.string().min(1),
  description: z.string().max(2000).optional(),
  inputs: z.record(z.string().regex(ID_PATTERN), InputSchema).optional(),
  triggers: z.array(TriggerSchema).optional(),
  nodes: z.record(z.string(), NodeSchema).superRefine((nodes, ctx) => {
    for (const id of Object.keys(nodes)) {
      const parsed = NodeIdSchema.safeParse(id);
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          path: [id],
          message: parsed.error.issues[0]?.message ?? 'bad id',
        });
      }
    }
    if (Object.keys(nodes).length === 0) ctx.addIssue({ code: 'custom', message: 'no nodes' });
  }),
  /** The first node; default: the first key of `nodes`. */
  start: z.string().optional(),
  edges: z.array(EdgeSchema),
  limits: LimitsSchema.optional(),
  requires: RequiresSchema.optional(),
});

/** A definition as written (the edges in any of their forms). */
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

/** The first node of a definition. */
export function startNode(
  definition: Pick<WorkflowDefinition, 'nodes' | 'start'>,
): string | undefined {
  return definition.start ?? Object.keys(definition.nodes)[0];
}
