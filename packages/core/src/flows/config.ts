// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { OFFICIAL_FLOWS } from '../registries/flows.js';
import {
  FLOW_LIMIT_KEYS,
  FLOW_STEP_IDS,
  FLOW_STEPS,
  type FlowLimitKey,
  type FlowStepId,
} from './steps.js';

/**
 * A flow of the configuration, `flows.<id>` (architecture 5.4 and 5.18; plan of Phase 9, P12; N133
 * and N241). It is the official `play` with the optional steps on or off, plus the limits of each
 * step. The validator follows the one of the plugin manifest (P3): zod for the structure, a
 * message that points at the field, and the rules beyond the schema in {@link parseFlowConfig}.
 * The module is pure: the hash of the flow (sha256) is taken by the daemon over
 * {@link canonicalFlowJson}.
 */

/** The version of the format of a flow (own version, [proposta]). A new shape is a new number. */
export const FLOW_CONFIG_VERSION = 1;

/**
 * Pattern of the id of a flow of the configuration [proposta]: lowercase, digits, `_` and `-`
 * (`docs-only`, the examples of N133), no dot. The dot is kept for the official flows
 * (`task.define`), so a configured flow never looks like one.
 */
export const FLOW_CONFIG_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** The ids a configured flow cannot take: the ones of the official flows. */
export const RESERVED_FLOW_IDS: readonly string[] = OFFICIAL_FLOWS.map((flow) => flow.id);

/** The roles a step can name (the ones of the play); the validator then demands the step's own. */
const STEP_ROLES = ['director', 'author', 'reviewer', 'scriptwriter', 'actor', 'critic'] as const;

/** A limit of a step: an integer. `attempts_per_demand` is at least 1 (the rule is in the parser). */
const LimitValueSchema = z.number().int().min(0).max(1000);

const LimitsSchema = z.strictObject({
  plan_reviews: LimitValueSchema.optional(),
  critic_rejections: LimitValueSchema.optional(),
  attempts_per_demand: LimitValueSchema.optional(),
  script_validations: LimitValueSchema.optional(),
  script_vetoes: LimitValueSchema.optional(),
  script_returns: LimitValueSchema.optional(),
  structural_restarts: LimitValueSchema.optional(),
});

const StepSchema = z.strictObject({
  /** `false` turns an optional step off. Default `true`. */
  enabled: z.boolean().default(true),
  /** Only the role the step already has (a flow never changes a permission). */
  role: z.enum(STEP_ROLES).optional(),
  limits: LimitsSchema.optional(),
});

const StepsSchema = z.strictObject(
  Object.fromEntries(FLOW_STEP_IDS.map((id) => [id, StepSchema.optional()])) as Record<
    FlowStepId,
    z.ZodOptional<typeof StepSchema>
  >,
);

export const FlowConfigSchema = z.strictObject({
  /** The version of the format: only 1. */
  version: z.literal(FLOW_CONFIG_VERSION),
  description: z.string().min(1).max(500).optional(),
  /** The steps by id; the order is the one of the play. A step left out keeps its default. */
  steps: StepsSchema.default({}),
});
export type FlowConfig = z.infer<typeof FlowConfigSchema>;

/** A problem of a flow, with the path of the field (`flows.hotfix.steps.planning.enabled`). */
export interface FlowProblem {
  readonly path: string;
  /** The same path as segments, for a caller that builds its own issues (the daemon config). */
  readonly segments: readonly PropertyKey[];
  readonly message: string;
}

/** A flow after validation: every step spelled out, so the hash does not depend on how it was written. */
export interface ResolvedFlow {
  readonly id: string;
  readonly version: number;
  readonly description: string | null;
  /** Every step of the play, in order. */
  readonly steps: readonly ResolvedFlowStep[];
}

export interface ResolvedFlowStep {
  readonly id: FlowStepId;
  readonly enabled: boolean;
  /** The limits the flow sets for the step; absent keys keep the `limits` of the scenario. */
  readonly limits: Readonly<Partial<Record<FlowLimitKey, number>>>;
}

export type FlowConfigResult =
  | { readonly ok: true; readonly flow: ResolvedFlow }
  | { readonly ok: false; readonly problems: readonly FlowProblem[] };

/** `flows.hotfix.steps.critique.limits.critic_rejections`. */
export function formatFlowPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${String(part)}]`;
    else out += out === '' ? String(part) : `.${String(part)}`;
  }
  return out;
}

function problemAt(segments: readonly PropertyKey[], message: string): FlowProblem {
  return { path: formatFlowPath(segments), segments, message };
}

function problemsOf(error: z.ZodError, prefix: readonly PropertyKey[]): FlowProblem[] {
  const problems: FlowProblem[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const inSteps = issue.path.length === 1 && issue.path[0] === 'steps';
        problems.push(
          problemAt(
            [...prefix, ...issue.path, key],
            inSteps
              ? `"${key}" is not a step of the registry (steps: ${FLOW_STEP_IDS.join(', ')})`
              : 'is not a field of a flow',
          ),
        );
      }
    } else {
      problems.push(problemAt([...prefix, ...issue.path], issue.message));
    }
  }
  return problems;
}

/**
 * Validates one flow of `flows.<id>`, already read from YAML. Returns the resolved flow or every
 * problem found, each with the path of its field. Nothing throws. The rules beyond the schema:
 * the id, a mandatory step cannot be off, a role is the step's own, a limit belongs to its step
 * and to an enabled one, `attempts_per_demand` is at least 1.
 */
export function parseFlowConfig(
  id: string,
  input: unknown,
  pathPrefix: readonly PropertyKey[] = ['flows'],
): FlowConfigResult {
  const root = [...pathPrefix, id];
  const problems: FlowProblem[] = [];
  if (!FLOW_CONFIG_ID_PATTERN.test(id)) {
    problems.push(
      problemAt(
        root,
        `"${id}" is not a valid flow id (lowercase, digits, "_" and "-", up to 64 characters, no dot)`,
      ),
    );
  } else if (RESERVED_FLOW_IDS.includes(id)) {
    problems.push(problemAt(root, `"${id}" is the id of an official flow: choose another id`));
  }
  const parsed = FlowConfigSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, problems: [...problems, ...problemsOf(parsed.error, root)] };
  const config = parsed.data;
  const steps: ResolvedFlowStep[] = [];
  for (const stepId of FLOW_STEP_IDS) {
    const definition = FLOW_STEPS[stepId];
    const given = config.steps[stepId];
    const at = [...root, 'steps', stepId];
    const enabled = given?.enabled ?? true;
    if (!enabled && !definition.optional) {
      problems.push(
        problemAt(
          [...at, 'enabled'],
          `"${stepId}" is a mandatory step (loop counters, code verification and delivery cannot be removed)`,
        ),
      );
    }
    if (given?.role !== undefined && given.role !== definition.role) {
      problems.push(
        problemAt(
          [...at, 'role'],
          definition.role === null
            ? `"${stepId}" has no role: it is run by the daemon`
            : `"${stepId}" is run by the role "${definition.role}"; a flow does not change it (it would change the permissions of the stage)`,
        ),
      );
    }
    const limits: Partial<Record<FlowLimitKey, number>> = {};
    for (const key of FLOW_LIMIT_KEYS) {
      const value = given?.limits?.[key];
      if (value === undefined) continue;
      const here = [...at, 'limits', key];
      if (!definition.limits.includes(key)) {
        problems.push(
          problemAt(here, `"${key}" is not a limit of the step "${stepId}"${limitOwnerHint(key)}`),
        );
      } else if (!enabled) {
        problems.push(problemAt(here, `"${stepId}" is off, so it has no limit`));
      } else if (key === 'attempts_per_demand' && value < 1) {
        problems.push(problemAt(here, 'must be at least 1'));
      } else {
        limits[key] = value;
      }
    }
    steps.push({ id: stepId, enabled, limits });
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    flow: {
      id,
      version: config.version,
      description: config.description ?? null,
      steps,
    },
  };
}

function limitOwnerHint(key: FlowLimitKey): string {
  const owner = FLOW_STEP_IDS.find((id) => FLOW_STEPS[id].limits.includes(key));
  return owner === undefined ? '' : ` (it belongs to "${owner}")`;
}

/** Validates the whole `flows` map; the problems of every flow come together. */
export function parseFlowsConfig(
  input: unknown,
  pathPrefix: readonly PropertyKey[] = ['flows'],
):
  | { readonly ok: true; readonly flows: ReadonlyMap<string, ResolvedFlow> }
  | { readonly ok: false; readonly problems: readonly FlowProblem[] } {
  if (input === undefined || input === null) return { ok: true, flows: new Map() };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      problems: [problemAt(pathPrefix, 'must be a map of flow id to flow')],
    };
  }
  const flows = new Map<string, ResolvedFlow>();
  const problems: FlowProblem[] = [];
  for (const [id, value] of Object.entries(input)) {
    const result = parseFlowConfig(id, value, pathPrefix);
    if (result.ok) flows.set(id, result.flow);
    else problems.push(...result.problems);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, flows };
}

/** The problems as lines, `flows.hotfix.steps.planning.enabled: message`. */
export function describeFlowProblems(problems: readonly FlowProblem[]): string {
  return problems
    .map((problem) =>
      problem.path === '' ? problem.message : `${problem.path}: ${problem.message}`,
    )
    .join('\n');
}

/**
 * The text the hash of the flow is taken over: the id, the version and every step with its
 * limits, in the order of the play and with the keys sorted, so two spellings of the same flow
 * give the same text. The description is not part of it (it does not change how the play runs).
 */
export function canonicalFlowJson(flow: ResolvedFlow): string {
  return JSON.stringify({
    id: flow.id,
    version: flow.version,
    steps: flow.steps.map((step) => ({
      id: step.id,
      enabled: step.enabled,
      limits: Object.fromEntries(
        Object.entries(step.limits).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    })),
  });
}

/** The optional steps the flow turns off, in the order of the play. */
export function skippedSteps(flow: ResolvedFlow): FlowStepId[] {
  return flow.steps.filter((step) => !step.enabled).map((step) => step.id);
}

/** The limits the flow sets, all steps together. */
export function flowLimitOverrides(flow: ResolvedFlow): Partial<Record<FlowLimitKey, number>> {
  const out: Partial<Record<FlowLimitKey, number>> = {};
  for (const step of flow.steps) Object.assign(out, step.limits);
  return out;
}
