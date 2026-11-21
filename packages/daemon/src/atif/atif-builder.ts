// SPDX-License-Identifier: MPL-2.0
import {
  findPrice,
  type AttemptRecord,
  type DemandRecord,
  type PlayRecord,
  type PricingTable,
  type SessionRecord,
  type UsageRecord,
} from '@otheater/core';
import {
  ATIF_VERSION,
  ChatDirectorReplyPayloadSchema,
  DecisionAnsweredPayloadSchema,
  DecisionCreatedPayloadSchema,
  OTHEATER_EXTRA_SCHEMA,
  REDACTED_VALUE,
  buildTrajectory,
  isTrajectoryEvent,
  type AtifCostKind,
  type AtifExportContent,
  type AtifFidelityNote,
  type AtifFinalMetrics,
  type AtifMetrics,
  type AtifObservationResult,
  type AtifStep,
  type AtifToolCall,
  type AtifTrajectory,
  type OtheaterRootExtra,
  type OtheaterStepExtra,
  type Trajectory,
  type TrajectoryAttempt,
  type TrajectoryEntry,
  type TrajectoryEvent,
} from '@otheater/protocol';
import { redactTree } from '../api/routes/redact.js';

/**
 * The fold of a play into ATIF v1.8 (Phase 8, P5; architecture 5.11, N219). [proposta] Pure: it
 * takes what the exporter read (the play, the events, the registries, the usage) and returns the
 * trajectories, with no I/O. The play is the unit: the root is the Director's trajectory and each
 * attempt is a trajectory of its own, which the root points at with a dispatch step
 * (`source: agent`, `llm_call_count: 0`, `subagent_trajectory_ref`).
 *
 * What the log does not carry is not invented: the arguments and the output of a tool call are not
 * in the normalized stream (only the title, the paths, the status and the outcome are), and the
 * text of the prompt of an attempt is derived from its demand. `extra.otheater.fidelity` of the
 * root lists those limits.
 */

export type Masker = (text: string) => string;

/** What the exporter read to build one play. */
export interface AtifSource {
  readonly play: PlayRecord;
  /** The events of the play: the trajectory ones, `chat.director_reply` and `decision.*`. */
  readonly events: readonly TrajectoryEvent[];
  readonly attempts: readonly AttemptRecord[];
  readonly demands: readonly DemandRecord[];
  readonly sessions: readonly SessionRecord[];
  /** Every usage record of the play. */
  readonly usage: readonly UsageRecord[];
}

/** How the root points at an attempt: embedded, or in a file of its own. */
export interface AtifAttemptRef {
  readonly trajectory_id?: string;
  readonly trajectory_path?: string;
}

export interface AtifBuildOptions {
  readonly content: AtifExportContent;
  /** Epoch ms of the export. */
  readonly exportedAt: number;
  /** The version of the daemon: the version of the Director's agent. */
  readonly version: string;
  readonly pricing: PricingTable;
  /** Masks the secrets of a text; applied to every string of the output. */
  readonly mask: Masker;
  readonly refOf: (attemptId: string) => AtifAttemptRef;
}

export interface AtifPlayTrajectories {
  /** The Director's trajectory, with a dispatch step per attempt. */
  readonly root: AtifTrajectory;
  /** The trajectory of each attempt, by attempt id, in the order the attempts began. */
  readonly attempts: ReadonlyMap<string, AtifTrajectory>;
}

const SCHEMA = OTHEATER_EXTRA_SCHEMA;

type StepInit = Omit<AtifStep, 'step_id'>;

/** A step before the order of the trajectory fixes its id. */
interface Draft {
  readonly init: StepInit;
  /** Epoch ms. */
  readonly at: number;
  /** The id of the event in the log, or an index that keeps the order of the source. */
  readonly seq: number;
  /** An LLM call produced it: it can carry metrics. */
  readonly llm: boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const round = (usd: number): number => Math.round(usd * 1e9) / 1e9;

function sumOrNull(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

function onlyValue<Value>(values: readonly (Value | null)[]): Value | null {
  const known = [...new Set(values.filter((value): value is Value => value !== null))];
  return known.length === 1 ? (known[0] ?? null) : null;
}

function mostFrequent(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** ATIF counts the cached tokens inside `prompt_tokens`; a client that counts them apart is added up. */
function promptTokensOf(record: UsageRecord, pricing: PricingTable): number | null {
  if (record.inputTokens === null) return null;
  const cachedInInput = findPrice(pricing, record.model)?.entry.price.cachedInInput === true;
  return cachedInInput ? record.inputTokens : record.inputTokens + (record.cachedTokens ?? 0);
}

function costKindOf(records: readonly UsageRecord[]): AtifCostKind {
  const kinds = new Set(records.map((record) => record.costKind));
  const known = [...kinds].filter((kind) => kind !== null);
  if (known.length === 0) return 'unknown';
  if (kinds.size > 1) return 'mixed';
  return known[0] ?? 'unknown';
}

/** The sums of a group of usage records, as ATIF and `extra.otheater` carry them. */
function usageSums(records: readonly UsageRecord[], pricing: PricingTable) {
  const real = records.filter((record) => record.costKind === 'real');
  const equivalent = records.filter((record) => record.costKind === 'api_equivalent');
  const sumUsd = (list: readonly UsageRecord[]): number | null => {
    const total = sumOrNull(list.map((record) => record.costUsd));
    return total === null ? null : round(total);
  };
  return {
    prompt: sumOrNull(records.map((record) => promptTokensOf(record, pricing))),
    completion: sumOrNull(records.map((record) => record.outputTokens)),
    cached: sumOrNull(records.map((record) => record.cachedTokens)),
    realUsd: sumUsd(real),
    equivalentUsd: sumUsd(equivalent),
    costKind: costKindOf(records),
    quota: {
      inputTokens: sumOrNull(records.map((record) => record.inputTokens)),
      outputTokens: sumOrNull(records.map((record) => record.outputTokens)),
      cachedTokens: sumOrNull(records.map((record) => record.cachedTokens)),
    },
  };
}

function metricsOf(records: readonly UsageRecord[], pricing: PricingTable): AtifMetrics {
  const sums = usageSums(records, pricing);
  return {
    prompt_tokens: sums.prompt,
    completion_tokens: sums.completion,
    cached_tokens: sums.cached,
    // Only what the account was charged: on a subscription the cost is the one the API would charge.
    cost_usd: sums.realUsd,
    extra: {
      otheater: {
        schema: SCHEMA,
        costKind: sums.costKind,
        costSource: onlyValue(records.map((record) => record.costSource)),
        pricingVersion: onlyValue(records.map((record) => record.pricingVersion)),
        apiEquivalentCostUsd: sums.equivalentUsd,
        quota: sums.quota,
        usageIds: records.map((record) => record.id),
      },
    },
  };
}

function finalMetricsOf(
  records: readonly UsageRecord[],
  steps: number,
  scope: 'play' | 'attempt',
  pricing: PricingTable,
): AtifFinalMetrics {
  const sums = usageSums(records, pricing);
  return {
    total_prompt_tokens: sums.prompt,
    total_completion_tokens: sums.completion,
    total_cached_tokens: sums.cached,
    total_cost_usd: sums.realUsd,
    total_steps: steps,
    extra: {
      otheater: {
        schema: SCHEMA,
        scope,
        costKind: sums.costKind,
        realCostUsd: sums.realUsd,
        apiEquivalentCostUsd: sums.equivalentUsd,
        quota: sums.quota,
        usageRecords: records.length,
      },
    },
  };
}

/**
 * Sorts the drafts, numbers them from 1 and gives each usage record to the step of the turn it ended:
 * the last LLM step that began at or before `occurredAt`, else the first one. A record with no LLM
 * step to take it is left out of the steps and stays in the sums.
 */
function finishSteps(
  drafts: readonly Draft[],
  records: readonly UsageRecord[],
  model: string | null,
  pricing: PricingTable,
): AtifStep[] {
  const sorted = drafts
    .map((draft, index) => ({ draft, index }))
    .sort((a, b) => a.draft.at - b.draft.at || a.draft.seq - b.draft.seq || a.index - b.index)
    .map(({ draft }) => draft);
  const llm = sorted.filter((draft) => draft.llm);
  const given = new Map<Draft, UsageRecord[]>();
  for (const record of [...records].sort((a, b) => a.occurredAt - b.occurredAt)) {
    const owner =
      [...llm].reverse().find((draft) => draft.at <= record.occurredAt) ?? llm[0] ?? undefined;
    if (owner === undefined) continue;
    given.set(owner, [...(given.get(owner) ?? []), record]);
  }
  return sorted.map((draft, index) => {
    const mine = given.get(draft);
    const step: AtifStep = { step_id: index + 1, ...draft.init };
    if (draft.llm && model !== null) step.model_name = model;
    if (mine !== undefined) step.metrics = metricsOf(mine, pricing);
    return step;
  });
}

/** The state a step of the trajectory has when it came from something other than a turn. */
function plainExtra(origin: OtheaterStepExtra['origin'], eventId: number | null): StepExtra {
  return {
    schema: SCHEMA,
    origin,
    turnIndex: null,
    stopReason: null,
    eventIds: eventId === null ? null : [eventId, eventId],
    permissions: [],
    plan: [],
    terminal: [],
  };
}
type StepExtra = OtheaterStepExtra;

interface CallDraft {
  readonly id: string;
  readonly functionName: string;
  readonly args: Record<string, unknown>;
  readonly source: 'client' | 'daemon';
  readonly toolKind: string | null;
  status: string | null;
  readonly paths: readonly string[];
  content: string | null;
  outcome: string | null;
  exitCode: number | null;
  durationMs: number | null;
}

interface TurnStepDraft {
  at: number;
  readonly texts: string[];
  readonly reasoning: string[];
  readonly calls: Map<string, CallDraft>;
  readonly permissions: StepExtra['permissions'];
  plan: StepExtra['plan'];
  readonly terminal: string[];
}

const newTurnStep = (at: number): TurnStepDraft => ({
  at,
  texts: [],
  reasoning: [],
  calls: new Map(),
  permissions: [],
  plan: [],
  terminal: [],
});

const isEmpty = (step: TurnStepDraft): boolean =>
  step.texts.length === 0 &&
  step.reasoning.length === 0 &&
  step.calls.size === 0 &&
  step.permissions.length === 0 &&
  step.plan.length === 0 &&
  step.terminal.length === 0;

/** The Director's reply, as the log carries it. */
interface DirectorReply {
  readonly eventId: number;
  readonly at: number;
  readonly text: string;
}

export function buildAtifPlay(source: AtifSource, options: AtifBuildOptions): AtifPlayTrajectories {
  const { play } = source;
  const redacted = options.content === 'redacted';
  const { mask, pricing } = options;
  /** The text of the conversation: masked when the content is full, replaced when it is redacted. */
  const shown = (text: string): string => (redacted ? REDACTED_VALUE : mask(text));
  const shownOrNull = (text: string | null): string | null => (text === null ? null : shown(text));

  const trajectory: Trajectory = buildTrajectory(
    play.id,
    source.events.filter((event) => isTrajectoryEvent(event.type)),
  );
  const lastEventId = source.events.reduce((last, event) => Math.max(last, event.id), 0);
  const sessionsOf = (attempt: AttemptRecord): ReadonlySet<string> =>
    new Set([
      ...(attempt.sessionId === null ? [] : [attempt.sessionId]),
      ...source.sessions.filter((s) => s.attemptId === attempt.attemptId).map((s) => s.id),
    ]);
  const attemptSessions = new Set<string>();
  for (const attempt of source.attempts)
    for (const id of sessionsOf(attempt)) attemptSessions.add(id);
  const fidelity: AtifFidelityNote[] = [
    'tool_arguments_not_in_event_log',
    'tool_output_not_in_event_log',
    'attempt_prompt_derived_from_demand',
    'director_turns_from_replies',
    ...(redacted ? (['content_redacted'] as const) : []),
  ];

  const rootExtra = (
    kind: 'play' | 'attempt',
    attempt: AttemptRecord | undefined,
    state: string | null,
  ): { otheater: OtheaterRootExtra } => ({
    otheater: {
      schema: SCHEMA,
      kind,
      playId: play.id,
      scenarioId: play.scenarioId,
      attemptId: attempt?.attemptId ?? null,
      demandId: attempt?.demandId ?? null,
      state,
      contentMode: options.content,
      exportedAt: iso(options.exportedAt),
      lastEventId: lastEventId === 0 ? null : lastEventId,
      fidelity,
    },
  });

  // ---- the attempts ----
  const attempts = new Map<string, AtifTrajectory>();
  const ordered = [...source.attempts].sort(
    (a, b) => a.createdAt - b.createdAt || a.attemptId.localeCompare(b.attemptId),
  );
  for (const record of ordered) {
    const folded = trajectory.attempts.find((entry) => entry.attemptId === record.attemptId);
    const mine = sessionsOf(record);
    const records = source.usage.filter((usage) => mine.has(usage.sessionId));
    const session = source.sessions.find((s) => mine.has(s.id) && s.role !== null);
    const model = mostFrequent(records.map((usage) => usage.model));
    const demand = source.demands.find((entry) => entry.id === record.demandId);
    const drafts = attemptDrafts(record, folded, demand, { shown, shownOrNull, redacted });
    const steps = finishSteps(drafts, records, model, pricing);
    const sessionId = record.sessionId ?? record.attemptId;
    attempts.set(record.attemptId, {
      schema_version: ATIF_VERSION,
      session_id: sessionId,
      trajectory_id: record.attemptId,
      agent: {
        name: record.client,
        version: 'unknown',
        model_name: model,
        extra: {
          otheater: {
            schema: SCHEMA,
            role: session?.role ?? 'actor',
            executor: mostFrequent(records.map((usage) => usage.executorId)),
            client: record.client,
            profile: record.profile,
            attemptId: record.attemptId,
            sessionId: record.sessionId,
          },
        },
      },
      steps,
      final_metrics: finalMetricsOf(records, steps.length, 'attempt', pricing),
      extra: rootExtra('attempt', record, record.state),
    });
  }

  // ---- the Director ----
  const directorRecords = source.usage.filter((usage) => !attemptSessions.has(usage.sessionId));
  const directorSession = source.sessions.find(
    (s) => s.attemptId === null && directorRecords.some((usage) => usage.sessionId === s.id),
  );
  const directorModel = mostFrequent(directorRecords.map((usage) => usage.model));
  const drafts: Draft[] = [];
  drafts.push({
    init: {
      timestamp: iso(play.createdAt),
      source: 'user',
      message: shown(play.need),
      extra: { otheater: plainExtra('need', null) },
    },
    at: play.createdAt,
    seq: 0,
    llm: false,
  });
  for (const event of source.events) {
    if (event.type === 'chat.director_reply') {
      const reply = replyOf(event);
      if (reply === undefined) continue;
      drafts.push({
        init: {
          timestamp: iso(reply.at),
          source: 'agent',
          message: shown(reply.text),
          extra: { otheater: plainExtra('director_reply', reply.eventId) },
        },
        at: reply.at,
        seq: reply.eventId,
        llm: true,
      });
    } else if (event.type === 'decision.created' || event.type === 'decision.answered') {
      const text = decisionText(event);
      if (text === undefined) continue;
      drafts.push({
        init: {
          timestamp: iso(event.timestamp),
          source: 'system',
          message: mask(text),
          extra: { otheater: plainExtra('decision', event.id) },
        },
        at: event.timestamp,
        seq: event.id,
        llm: false,
      });
    }
  }
  for (const record of ordered) {
    const first = source.events.find((event) => event.attemptId === record.attemptId);
    const demand = source.demands.find((entry) => entry.id === record.demandId);
    const at = first?.timestamp ?? record.createdAt;
    const role = attempts.get(record.attemptId)?.agent.extra?.otheater?.role ?? 'actor';
    const label = redacted ? '' : ` "${mask(demand?.title ?? record.demandId)}"`;
    drafts.push({
      init: {
        timestamp: iso(at),
        source: 'agent',
        message: `Dispatched demand ${record.demandId}${label} to the ${role} (attempt ${String(record.attempt)}).`,
        llm_call_count: 0,
        observation: {
          results: [
            {
              subagent_trajectory_ref: [
                {
                  ...options.refOf(record.attemptId),
                  session_id: record.sessionId ?? record.attemptId,
                  extra: {
                    otheater: {
                      schema: SCHEMA,
                      attemptId: record.attemptId,
                      demandId: record.demandId,
                      attempt: record.attempt,
                      state: record.state,
                      role,
                    },
                  },
                },
              ],
            },
          ],
        },
        extra: { otheater: plainExtra('dispatch', first?.id ?? null) },
      },
      at,
      seq: first?.id ?? Number.MAX_SAFE_INTEGER,
      llm: false,
    });
  }
  const steps = finishSteps(drafts, directorRecords, directorModel, pricing);
  const root: AtifTrajectory = {
    schema_version: ATIF_VERSION,
    session_id: play.id,
    trajectory_id: play.id,
    agent: {
      name: 'otheater-director',
      version: options.version,
      model_name: directorModel,
      extra: {
        otheater: {
          schema: SCHEMA,
          role: 'director',
          executor: mostFrequent(directorRecords.map((usage) => usage.executorId)),
          client: directorSession?.client ?? null,
          profile: directorSession?.profile ?? onlyValue(directorRecords.map((u) => u.profileId)),
          attemptId: null,
          sessionId: directorSession?.id ?? null,
        },
      },
    },
    steps,
    // The sums cover the whole play (the attempts too); `total_steps` counts the Director's steps.
    final_metrics: finalMetricsOf(source.usage, steps.length, 'play', pricing),
    extra: rootExtra('play', undefined, play.state),
  };
  return { root: maskTree(root, mask), attempts: mapValues(attempts, (t) => maskTree(t, mask)) };
}

function mapValues<Key, Value>(
  map: ReadonlyMap<Key, Value>,
  fn: (value: Value) => Value,
): Map<Key, Value> {
  return new Map([...map].map(([key, value]) => [key, fn(value)]));
}

/** Every string of the tree through the masker: the net under the fields that were masked one by one. */
function maskTree<Value>(value: Value, mask: Masker): Value {
  if (typeof value === 'string') return mask(value) as Value;
  if (Array.isArray(value))
    return (value as unknown[]).map((item) => maskTree(item, mask)) as Value;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, maskTree(child, mask)]),
    ) as Value;
  }
  return value;
}

function replyOf(event: TrajectoryEvent): DirectorReply | undefined {
  const parsed = ChatDirectorReplyPayloadSchema.safeParse(event.payload);
  return parsed.success
    ? { eventId: event.id, at: event.timestamp, text: parsed.data.text }
    : undefined;
}

function decisionText(event: TrajectoryEvent): string | undefined {
  if (event.type === 'decision.created') {
    const parsed = DecisionCreatedPayloadSchema.safeParse(event.payload);
    return parsed.success
      ? `Decision ${parsed.data.decision.id} asked: ${parsed.data.decision.kind}.`
      : undefined;
  }
  const parsed = DecisionAnsweredPayloadSchema.safeParse(event.payload);
  if (!parsed.success) return undefined;
  const by = parsed.data.decidedBy === null ? '' : ` by ${parsed.data.decidedBy}`;
  return `Decision ${parsed.data.decisionId} (${parsed.data.kind}) ${parsed.data.state}${by}.`;
}

interface Display {
  readonly shown: (text: string) => string;
  readonly shownOrNull: (text: string | null) => string | null;
  readonly redacted: boolean;
}

/** The steps of one attempt: the prompt (from the demand), the turns of the agent and the notices. */
function attemptDrafts(
  record: AttemptRecord,
  folded: TrajectoryAttempt | undefined,
  demand: DemandRecord | undefined,
  display: Display,
): Draft[] {
  const { shown } = display;
  const drafts: Draft[] = [];
  const startedAt = folded?.startedAt ?? record.createdAt;
  const prompt =
    demand === undefined
      ? `Demand ${record.demandId}`
      : [
          demand.title,
          demand.description,
          ...(demand.acceptanceCriteria.length === 0
            ? []
            : ['Acceptance criteria:', ...demand.acceptanceCriteria.map((item) => `- ${item}`)]),
        ]
          .filter((part) => part !== '')
          .join('\n\n');
  drafts.push({
    init: {
      timestamp: iso(startedAt),
      source: 'user',
      message: shown(prompt),
      extra: { otheater: plainExtra('demand', null) },
    },
    at: startedAt,
    seq: 0,
    llm: false,
  });
  let seq = 1;
  for (const turn of folded?.turns ?? []) {
    const stepsOfTurn: { draft: TurnStepDraft; extra: StepExtra }[] = [];
    const holder: { current: TurnStepDraft | undefined } = { current: undefined };
    const open = (at: number): TurnStepDraft => {
      const fresh = newTurnStep(at);
      holder.current = fresh;
      stepsOfTurn.push({
        draft: fresh,
        extra: { ...plainExtra('turn', null), turnIndex: turn.index },
      });
      return fresh;
    };
    for (const entry of turn.entries) {
      const now = holder.current;
      // A thought or a message that comes after tool calls opens the next step: a new LLM call.
      const startsStep =
        now === undefined ||
        ((entry.kind === 'message' || entry.kind === 'thought') && now.calls.size > 0);
      addEntry(startsStep ? open(entry.at) : now, entry, display);
    }
    stepsOfTurn.forEach(({ draft, extra }, index) => {
      if (isEmpty(draft)) return;
      const last = index === stepsOfTurn.length - 1;
      drafts.push({
        init: turnStep(draft, {
          ...extra,
          stopReason: last ? (turn.stopReason ?? null) : null,
          permissions: draft.permissions,
          plan: draft.plan,
          terminal: draft.terminal,
        }),
        at: draft.at,
        seq: seq++,
        llm: true,
      });
    });
  }
  for (const notice of folded?.notices ?? []) {
    const text = display.redacted
      ? notice.type
      : display.shown(
          notice.detail === undefined ? notice.type : `${notice.type}: ${notice.detail}`,
        );
    drafts.push({
      init: {
        timestamp: iso(notice.at),
        source: 'system',
        message: text,
        extra: { otheater: { ...plainExtra('system_message', notice.eventId) } },
      },
      at: notice.at,
      seq: Number.MAX_SAFE_INTEGER - 1,
      llm: false,
    });
  }
  return drafts;
}

function turnStep(draft: TurnStepDraft, extra: StepExtra): StepInit {
  const calls = [...draft.calls.values()];
  const init: StepInit = {
    timestamp: iso(draft.at),
    source: 'agent',
    message: draft.texts.join(''),
    extra: { otheater: extra },
  };
  if (draft.reasoning.length > 0) init.reasoning_content = draft.reasoning.join('');
  if (calls.length > 0) {
    const toolCalls: AtifToolCall[] = calls.map((call) => ({
      tool_call_id: call.id,
      function_name: call.functionName,
      arguments: call.args,
      extra: {
        otheater: {
          schema: SCHEMA,
          source: call.source,
          toolKind: call.toolKind,
          status: call.status,
          paths: [...call.paths],
        },
      },
    }));
    const results: AtifObservationResult[] = calls.map((call) => ({
      source_call_id: call.id,
      content: call.content,
      extra: {
        otheater: {
          schema: SCHEMA,
          status: call.status,
          outcome: call.outcome,
          exitCode: call.exitCode,
          durationMs: call.durationMs,
        },
      },
    }));
    init.tool_calls = toolCalls;
    init.observation = { results };
  }
  return init;
}

function addEntry(step: TurnStepDraft, entry: TrajectoryEntry, display: Display): void {
  const { shown, redacted } = display;
  switch (entry.kind) {
    case 'message':
      step.texts.push(shown(entry.text));
      return;
    case 'thought':
      step.reasoning.push(shown(entry.text));
      return;
    case 'tool_call': {
      const known = step.calls.get(entry.toolCallId);
      if (known !== undefined) {
        known.status = entry.status;
        return;
      }
      step.calls.set(entry.toolCallId, {
        id: entry.toolCallId,
        functionName: entry.toolKind === '' ? 'tool' : entry.toolKind,
        args: redacted ? {} : redactTree({ title: shown(entry.title) }).value,
        source: 'client',
        toolKind: entry.toolKind,
        status: entry.status,
        paths: redacted ? [] : entry.paths.map((path) => shown(path)),
        content: null,
        outcome: null,
        exitCode: null,
        durationMs: null,
      });
      return;
    }
    case 'tool': {
      const known = step.calls.get(entry.callId);
      const outcome = entry.outcome ?? null;
      if (known !== undefined) {
        known.outcome = outcome;
        known.exitCode = entry.exitCode ?? null;
        known.durationMs = entry.durationMs ?? null;
        return;
      }
      step.calls.set(entry.callId, {
        id: entry.callId,
        functionName: entry.tool,
        args: {},
        source: 'daemon',
        toolKind: null,
        status: null,
        paths: [],
        content: entry.summary === '' ? null : shown(entry.summary),
        outcome,
        exitCode: entry.exitCode ?? null,
        durationMs: entry.durationMs ?? null,
      });
      return;
    }
    case 'permission':
      step.permissions.push({
        tool: entry.tool,
        toolCallId: entry.toolCallId ?? null,
        answer: entry.answer ?? null,
        rule: entry.rule ?? null,
        reason: redacted || entry.reason === undefined ? null : shown(entry.reason),
        paths: redacted ? [] : entry.paths.map((path) => shown(path)),
      });
      return;
    case 'plan':
      step.plan = entry.entries.map((item) => ({
        content: shown(item.content),
        status: item.status,
      }));
      return;
    case 'terminal':
      step.terminal.push(shown(entry.text));
      return;
  }
}
