// SPDX-License-Identifier: MPL-2.0
import { z } from 'zod';
import { CRITICAL_EXCEPTIONS, FAILURE_KINDS } from './definitions.js';

/**
 * The judgment points of the Director (architecture 5.4): the only places where its model decides,
 * each with a schema. The list is closed and comes from the code. A point names the flows it
 * belongs to; the play machine only opens the ones of `play`.
 */
export const JUDGMENT_POINT_IDS = [
  'classify_critique',
  'actor_timeout',
  'consult_producer',
  'chat_consult',
  'task_step_failed',
  'refusal_or_permission',
  'resumes_exceeded',
  'dependency_redone',
] as const;
export type JudgmentPointId = (typeof JUDGMENT_POINT_IDS)[number];

/** One failure the Director found in a critique. */
export const CritiqueFailureSchema = z
  .strictObject({
    kind: z.enum(FAILURE_KINDS),
    /** The demands the failure is about (needed for an `execution` failure). */
    demandIds: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Required when kind is "execution": the affected demands, taken from the "demandIds" of the decision input.',
      ),
    /** The critical exception (needed for a `critical_exception` failure). */
    exception: z
      .enum(CRITICAL_EXCEPTIONS)
      .optional()
      .describe('Required when kind is "critical_exception".'),
    note: z.string().optional().describe('What failed; it goes on as context of the next cycle.'),
  })
  .superRefine((failure, ctx) => {
    if (failure.kind === 'execution' && (failure.demandIds?.length ?? 0) === 0) {
      ctx.addIssue({ code: 'custom', message: 'an execution failure lists the affected demands' });
    }
    if (failure.kind === 'critical_exception' && failure.exception === undefined) {
      ctx.addIssue({ code: 'custom', message: 'a critical exception names the exception' });
    }
  });
export type CritiqueFailure = z.infer<typeof CritiqueFailureSchema>;

export interface JudgmentPoint {
  readonly id: JudgmentPointId;
  /** 1 to 8, as numbered in 5.4. */
  readonly number: number;
  /** The flows that open this point. */
  readonly flows: readonly string[];
  /** Schema of the answer of the Director. */
  readonly answer: z.ZodType;
  /**
   * One valid answer, shown to the Director next to the schema. It reads the input of the decision
   * (the demands of the script, for point 1) so that the example names what exists.
   */
  readonly example: (input: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}

function firstDemandOf(input: Readonly<Record<string, unknown>>): string {
  const ids = input.demandIds;
  const first = Array.isArray(ids)
    ? (ids as unknown[]).find((id) => typeof id === 'string')
    : undefined;
  return typeof first === 'string' ? first : '<a demand id from demandIds>';
}

/**
 * [proposta] The architecture names the 8 points; the shape of the answers, and the options of
 * points 6 to 8, are this module's.
 */
export const JUDGMENT_POINTS: readonly JudgmentPoint[] = [
  {
    id: 'classify_critique',
    number: 1,
    flows: ['play'],
    answer: z.strictObject({ failures: z.array(CritiqueFailureSchema).min(1) }),
    example: (input) => ({
      failures: [
        { kind: 'execution', demandIds: [firstDemandOf(input)], note: 'what failed and why' },
      ],
    }),
  },
  {
    id: 'actor_timeout',
    number: 2,
    flows: ['play'],
    answer: z.strictObject({ action: z.enum(['accept_partial', 'reassign']) }),
    example: () => ({ action: 'reassign' }),
  },
  {
    id: 'consult_producer',
    number: 3,
    flows: ['play', 'task.define', 'task.run', 'chat'],
    answer: z.strictObject({ ask: z.boolean(), question: z.string().min(1).optional() }),
    example: () => ({ ask: false }),
  },
  {
    id: 'chat_consult',
    number: 4,
    flows: ['chat'],
    answer: z.strictObject({ consult: z.boolean() }),
    example: () => ({ consult: false }),
  },
  {
    id: 'task_step_failed',
    number: 5,
    flows: ['task.run'],
    answer: z.strictObject({ action: z.enum(['fix_definition', 'retry', 'skip', 'stop']) }),
    example: () => ({ action: 'retry' }),
  },
  {
    id: 'refusal_or_permission',
    number: 6,
    flows: ['play'],
    answer: z.strictObject({ action: z.enum(['reformulate', 'switch_executor', 'ask_producer']) }),
    example: () => ({ action: 'reformulate' }),
  },
  {
    id: 'resumes_exceeded',
    number: 7,
    flows: ['play'],
    answer: z.strictObject({ action: z.enum(['handoff', 'fail_attempt', 'ask_producer']) }),
    example: () => ({ action: 'handoff' }),
  },
  {
    id: 'dependency_redone',
    number: 8,
    flows: ['play'],
    answer: z.strictObject({ action: z.enum(['rebase', 'redo']) }),
    example: () => ({ action: 'rebase' }),
  },
];

const POINTS_BY_ID = new Map<string, JudgmentPoint>(JUDGMENT_POINTS.map((p) => [p.id, p]));

export function judgmentPoint(id: string): JudgmentPoint | undefined {
  return POINTS_BY_ID.get(id);
}

/** True when the point belongs to the flow. */
export function pointBelongsTo(id: JudgmentPointId, flow: string): boolean {
  return judgmentPoint(id)?.flows.includes(flow) === true;
}

/** What the Director needs to answer a point: the JSON Schema of the answer and one valid answer. */
export interface AnswerGuide {
  readonly schema: Record<string, unknown>;
  readonly example: Record<string, unknown>;
}

const SCHEMAS = new Map<JudgmentPointId, Record<string, unknown>>();

function jsonSchemaOf(point: JudgmentPoint): Record<string, unknown> {
  const cached = SCHEMAS.get(point.id);
  if (cached !== undefined) return cached;
  const json = z.toJSONSchema(point.answer, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
  delete json.$schema;
  SCHEMAS.set(point.id, json);
  return json;
}

/** The schema and an example of the answer of a point, for the input of one decision. */
export function answerGuide(
  id: JudgmentPointId,
  input: Readonly<Record<string, unknown>>,
): AnswerGuide | undefined {
  const point = judgmentPoint(id);
  if (point === undefined) return undefined;
  return { schema: jsonSchemaOf(point), example: point.example(input) };
}

/**
 * Why an answer does not fit a point, one line per problem (`path: message`); empty when it fits.
 * For point 1 it also checks that the demands named are among `demandIds` of the input: the
 * machine refuses a classification that names a demand the script does not have.
 */
export function answerProblems(
  id: JudgmentPointId,
  answer: unknown,
  input: Readonly<Record<string, unknown>>,
): string[] {
  const point = judgmentPoint(id);
  if (point === undefined) return [`"${id}" is not a judgment point`];
  const result = point.answer.safeParse(answer);
  if (!result.success) {
    return result.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    });
  }
  if (id !== 'classify_critique' || !Array.isArray(input.demandIds)) return [];
  const known = new Set((input.demandIds as unknown[]).filter((d) => typeof d === 'string'));
  const { failures } = result.data as { failures: CritiqueFailure[] };
  return failures.flatMap((failure, index) =>
    (failure.demandIds ?? [])
      .filter((demand) => !known.has(demand))
      .map(
        (demand) =>
          `failures.${String(index)}.demandIds: "${demand}" is not a demand of the script (${[...known].join(', ') || 'none'})`,
      ),
  );
}

/** Parses the answer of a point; `undefined` when it does not fit the schema. */
export function parseAnswer(id: JudgmentPointId, answer: unknown): unknown {
  const result = judgmentPoint(id)?.answer.safeParse(answer);
  return result?.success === true ? result.data : undefined;
}
