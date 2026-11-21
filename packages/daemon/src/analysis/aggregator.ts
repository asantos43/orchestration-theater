// SPDX-License-Identifier: MPL-2.0
import type {
  EventEnvelope,
  EventLog,
  RollupRow,
  TelemetryReadFilter,
  TelemetrySpan,
  TelemetryStore,
  UsageRecord,
} from '@otheater/core';
import { DAEMON_SPAN_RESOURCE, GEN_AI, OT, SPAN_NAME } from '../telemetry/span-conventions.js';
import { NO_DIMS, RollupAccumulator, type RollupDims } from './rollup-accumulator.js';

/**
 * The metrics of `rollups_daily` (Phase 8, P9; architecture 5.11). [proposta] Every name below is
 * a `metric`; `facet` splits one metric in the way the comment says. The origin of a number is one
 * of `daemon` (derived from the event log and the daemon spans), `client` (what the client
 * reported to the daemon, in `usage`), `otlp` (what the client itself exported) and
 * `pricing_table` (a cost the daemon priced from the tokens).
 */
export const ROLLUP_METRIC = {
  /** Time in a state of the play (facet: the state). Milliseconds. */
  stageMs: 'stage_ms',
  /** The time of a play from its start to its end (facet: the final state). */
  playMs: 'play_ms',
  /** The time of an attempt. */
  attemptMs: 'attempt_ms',
  /** Attempts that ended (counter; facet: how: `submitted`, `cancelled`, `aborted`, `unknown`). */
  attempts: 'attempts',
  /** Reviews that sent the play back (counter; facet: the machine event). */
  rejections: 'rejections',
  /** Interrupted sessions (counter; facet: the cause). */
  interruptions: 'interruptions',
  /** Demands that were approved (counter). */
  approvedDemands: 'approved_demands',
  /** A wait (facet: the kind of wait, or `producer`). Milliseconds. */
  waitMs: 'wait_ms',
  tokensIn: 'tokens_in',
  tokensOut: 'tokens_out',
  tokensCached: 'tokens_cached',
  /** Cost in dollars (facet: `real` or `api_equivalent`; origin: `client` or `pricing_table`). */
  costUsd: 'cost_usd',
  /** Counters of what is known (facets: `total`, `tokens_known`, `cost_known`). */
  usageTurns: 'usage_turns',
  /** Counters of the attempts and of those with client telemetry (facets: `total`, `with_client_telemetry`). */
  coverageAttempts: 'coverage_attempts',
} as const;

export const ROLLUP_ORIGIN = {
  daemon: 'daemon',
  client: 'client',
  otlp: 'otlp',
  pricingTable: 'pricing_table',
} as const;

/** How many records a read of the base may return at most (the ceiling of the port). */
export const READ_PAGE = 10_000;

/** The review events and where a rejection sends the play back to. */
const REJECTED_BY: Readonly<Record<string, string>> = {
  PLAN_REVIEWED: 'PLANNING',
  SCRIPT_REVIEWED: 'SCRIPTING',
  CRITIQUED: 'DECIDING',
};

export interface AggregatorDeps {
  readonly telemetry: Pick<TelemetryStore, 'readSpans' | 'readMetrics' | 'readLogs'>;
  /** The events with `fromMs <= timestamp < toMs`. */
  readonly events: (fromMs: number, toMs: number) => Promise<readonly EventEnvelope[]>;
  /** The usage turns with `fromMs <= occurredAt < toMs`. */
  readonly usage: (fromMs: number, toMs: number) => Promise<readonly UsageRecord[]>;
  /** The states of the play whose time counts as a wait for the Producer. */
  readonly producerWaitStates: () => readonly string[];
}

const NS_PER_MS = 1_000_000n;

function toNs(ms: number): bigint {
  return BigInt(ms) * NS_PER_MS;
}

function durationMs(span: TelemetrySpan): number {
  return Number(span.endTimeUnixNano - span.startTimeUnixNano) / 1e6;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A span written by the daemon itself, as against one a client exported. */
function isDaemonSpan(span: TelemetrySpan): boolean {
  return span.resource['service.name'] === DAEMON_SPAN_RESOURCE['service.name'];
}

function executorOf(client: string | undefined, profile: string | undefined): string {
  if (profile === undefined) return '';
  if (profile.includes('/')) return profile;
  return client === undefined ? '' : `${client}/${profile}`;
}

/**
 * Reads everything a window holds when one read is capped: a read that comes back full is split in
 * two halves of the window and each half is read again. The records come back in the order of the
 * windows, so the result does not depend on how the base paged it.
 */
export async function readWindowed<T>(
  read: (fromNs: bigint, toNs: bigint) => Promise<readonly T[]>,
  fromNs: bigint,
  toNsExclusive: bigint,
  page = READ_PAGE,
): Promise<T[]> {
  const first = await read(fromNs, toNsExclusive);
  if (first.length < page || toNsExclusive - fromNs <= 1n) return [...first];
  const mid = fromNs + (toNsExclusive - fromNs) / 2n;
  return [
    ...(await readWindowed(read, fromNs, mid, page)),
    ...(await readWindowed(read, mid, toNsExclusive, page)),
  ];
}

/**
 * The events of a window of time. The log has no index by time, only by id, and its timestamps
 * grow with the ids in practice (not by contract), so the first id of the window is found by
 * bisection and the log is read from there until the window ends. [proposta]
 */
export async function readEventsBetween(
  log: Pick<EventLog, 'readFrom' | 'lastId'>,
  fromMs: number,
  toMs: number,
  batch = 1000,
): Promise<EventEnvelope[]> {
  let lo = 0;
  let hi = await log.lastId();
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const [next] = await log.readFrom(mid, 1);
    if (next === undefined || next.timestamp >= fromMs) hi = mid;
    else lo = mid + 1;
  }
  const out: EventEnvelope[] = [];
  let after = lo;
  for (;;) {
    const events = await log.readFrom(after, batch);
    if (events.length === 0) return out;
    for (const event of events) {
      if (event.timestamp >= toMs) return out;
      if (event.timestamp >= fromMs) out.push(event);
      after = event.id;
    }
  }
}

/** Who an attempt or a session was, as far as the spans say. */
interface Actor {
  readonly scenarioId: string;
  readonly executor: string;
  readonly role: string;
}

/**
 * The aggregation of one day (Phase 8, P9): the spans that ended in it, the events and the usage
 * turns that happened in it, folded into the rows of `rollups_daily`. It only reads; the same
 * base and the same window always give the same rows, which is what makes the reprocessing of a
 * day idempotent.
 */
export class DayAggregator {
  readonly #deps: AggregatorDeps;

  constructor(deps: AggregatorDeps) {
    this.#deps = deps;
  }

  async aggregate(day: string, startMs: number, endMs: number): Promise<RollupRow[]> {
    const { telemetry } = this.#deps;
    const acc = new RollupAccumulator(day);
    const endedFrom = toNs(startMs);
    const endedTo = toNs(endMs);

    const spans = await readWindowed(
      (from, to) =>
        telemetry.readSpans({ endedFromUnixNano: from, endedToUnixNano: to, limit: READ_PAGE }),
      endedFrom,
      endedTo,
    );
    const resolver = new ActorResolver(telemetry, spans);
    const clientAttempts = await this.#clientAttempts(spans, startMs, endMs);
    this.#spanRows(acc, spans, clientAttempts);

    const events = await this.#deps.events(startMs, endMs);
    await this.#eventRows(acc, events, resolver);

    const usage = await this.#deps.usage(startMs, endMs);
    await this.#usageRows(acc, usage, resolver);
    return acc.rows();
  }

  /** The attempts that have a record of the client itself (a span, a metric or a log) in the window. */
  async #clientAttempts(
    spans: readonly TelemetrySpan[],
    startMs: number,
    endMs: number,
  ): Promise<ReadonlySet<string>> {
    const { telemetry } = this.#deps;
    const found = new Set<string>();
    for (const span of spans) {
      if (!isDaemonSpan(span) && span.attemptId !== null) found.add(span.attemptId);
    }
    const window = (filter: TelemetryReadFilter): TelemetryReadFilter => ({
      ...filter,
      limit: READ_PAGE,
    });
    const from = toNs(startMs);
    const to = toNs(endMs);
    const metrics = await readWindowed(
      (f, t) => telemetry.readMetrics(window({ fromUnixNano: f, toUnixNano: t })),
      from,
      to,
    );
    for (const point of metrics) if (point.attemptId !== null) found.add(point.attemptId);
    const logs = await readWindowed(
      (f, t) => telemetry.readLogs(window({ fromUnixNano: f, toUnixNano: t })),
      from,
      to,
    );
    for (const record of logs) if (record.attemptId !== null) found.add(record.attemptId);
    return found;
  }

  #spanRows(
    acc: RollupAccumulator,
    spans: readonly TelemetrySpan[],
    clientAttempts: ReadonlySet<string>,
  ): void {
    const producerStates = new Set(this.#deps.producerWaitStates());
    const origin = ROLLUP_ORIGIN.daemon;
    for (const span of spans) {
      if (!isDaemonSpan(span)) continue;
      const attrs = span.attributes;
      const scenarioId = span.scenarioId ?? '';
      const agentId = str(attrs[GEN_AI.agentId]);
      if (span.name === SPAN_NAME.stage) {
        const state = str(attrs[OT.stage]);
        if (state === undefined) continue;
        const dims = { ...NO_DIMS, scenarioId };
        acc.sample(dims, ROLLUP_METRIC.stageMs, state, origin, durationMs(span));
        if (producerStates.has(state)) {
          acc.sample(dims, ROLLUP_METRIC.waitMs, 'producer', origin, durationMs(span));
        }
      } else if (span.name === SPAN_NAME.play) {
        const final = str(attrs[OT.playFinalState]) ?? 'unknown';
        const dims = { ...NO_DIMS, scenarioId };
        acc.sample(dims, ROLLUP_METRIC.playMs, final, origin, durationMs(span));
      } else if (span.name === SPAN_NAME.wait) {
        const kind = str(attrs[OT.waitKind]);
        if (kind === undefined) continue;
        const dims: RollupDims = {
          scenarioId,
          executor: executorOf(str(attrs[OT.client]), str(attrs[OT.profile])),
          role: str(attrs[OT.role]) ?? '',
        };
        acc.sample(
          dims,
          ROLLUP_METRIC.waitMs,
          kind,
          origin,
          num(attrs[OT.waitMs]) ?? durationMs(span),
        );
      } else if (agentId !== undefined && span.name.startsWith('invoke_agent')) {
        const attemptId = agentId;
        const dims: RollupDims = {
          scenarioId,
          executor: executorOf(str(attrs[OT.client]), str(attrs[OT.profile])),
          role: str(attrs[OT.role]) ?? '',
        };
        acc.sample(dims, ROLLUP_METRIC.attemptMs, '', origin, durationMs(span));
        acc.count(dims, ROLLUP_METRIC.attempts, str(attrs[OT.attemptEnd]) ?? 'unknown', origin);
        acc.count(dims, ROLLUP_METRIC.coverageAttempts, 'total', origin);
        if (clientAttempts.has(attemptId)) {
          acc.count(
            dims,
            ROLLUP_METRIC.coverageAttempts,
            'with_client_telemetry',
            ROLLUP_ORIGIN.otlp,
          );
        }
      }
    }
  }

  async #eventRows(
    acc: RollupAccumulator,
    events: readonly EventEnvelope[],
    resolver: ActorResolver,
  ): Promise<void> {
    const origin = ROLLUP_ORIGIN.daemon;
    for (const event of events) {
      const payload = event.payload as Readonly<Record<string, unknown>>;
      if (event.type === 'play.transitioned') {
        const machineEvent = str(payload.event);
        if (machineEvent !== undefined && REJECTED_BY[machineEvent] === str(payload.to)) {
          const dims = { ...NO_DIMS, scenarioId: event.scenarioId ?? '' };
          acc.count(dims, ROLLUP_METRIC.rejections, machineEvent, origin);
        }
      } else if (event.type === 'demand.transitioned') {
        if (str(payload.to) === 'approved') {
          const dims = { ...NO_DIMS, scenarioId: event.scenarioId ?? '' };
          acc.count(dims, ROLLUP_METRIC.approvedDemands, '', origin);
        }
      } else if (event.type === 'session.interrupted') {
        const cause = str(payload.cause) ?? 'unknown';
        const actor = await resolver.session(str(payload.sessionId), event.attemptId);
        const dims: RollupDims = {
          scenarioId: event.scenarioId ?? actor?.scenarioId ?? '',
          executor: actor?.executor ?? '',
          role: actor?.role ?? '',
        };
        acc.count(dims, ROLLUP_METRIC.interruptions, cause, origin);
      }
    }
  }

  async #usageRows(
    acc: RollupAccumulator,
    records: readonly UsageRecord[],
    resolver: ActorResolver,
  ): Promise<void> {
    for (const record of records) {
      const actor = await resolver.session(record.sessionId, undefined);
      const dims: RollupDims = {
        scenarioId: actor?.scenarioId ?? (await resolver.playScenario(record.playId)) ?? '',
        executor: record.profileId,
        role: actor?.role ?? '',
      };
      const client = ROLLUP_ORIGIN.client;
      acc.count(dims, ROLLUP_METRIC.usageTurns, 'total', ROLLUP_ORIGIN.daemon);
      const tokens: readonly [string, number | null][] = [
        [ROLLUP_METRIC.tokensIn, record.inputTokens],
        [ROLLUP_METRIC.tokensOut, record.outputTokens],
        [ROLLUP_METRIC.tokensCached, record.cachedTokens],
      ];
      for (const [metric, value] of tokens) {
        if (value === null) acc.gap(dims, metric, '', client);
        else acc.sample(dims, metric, '', client, value);
      }
      if (record.inputTokens !== null || record.outputTokens !== null) {
        acc.count(dims, ROLLUP_METRIC.usageTurns, 'tokens_known', client);
      }
      if (record.costUsd !== null && record.costKind !== null && record.costSource !== null) {
        acc.sample(dims, ROLLUP_METRIC.costUsd, record.costKind, record.costSource, record.costUsd);
        acc.count(dims, ROLLUP_METRIC.usageTurns, 'cost_known', record.costSource);
      }
    }
  }
}

/**
 * Who an attempt or a session was: read from the spans of the day, and from the base (by id) for
 * what ended on another day. What nobody knows is `undefined`, and its dimension is left empty.
 */
class ActorResolver {
  readonly #telemetry: Pick<TelemetryStore, 'readSpans'>;
  readonly #bySession = new Map<string, Actor | undefined>();
  readonly #byAttempt = new Map<string, Actor | undefined>();
  readonly #byPlay = new Map<string, string | undefined>();

  constructor(telemetry: Pick<TelemetryStore, 'readSpans'>, spans: readonly TelemetrySpan[]) {
    this.#telemetry = telemetry;
    for (const span of spans) this.#index(span);
  }

  #index(span: TelemetrySpan): void {
    if (!isDaemonSpan(span)) return;
    const attrs = span.attributes;
    const actor: Actor = {
      scenarioId: span.scenarioId ?? '',
      executor: executorOf(str(attrs[OT.client]), str(attrs[OT.profile])),
      role: str(attrs[OT.role]) ?? '',
    };
    const session = str(attrs[GEN_AI.conversationId]);
    const attempt = str(attrs[GEN_AI.agentId]);
    if (session !== undefined) this.#bySession.set(session, actor);
    if (attempt !== undefined) this.#byAttempt.set(attempt, actor);
    if (span.playId !== null && span.scenarioId !== null) {
      this.#byPlay.set(span.playId, span.scenarioId);
    }
  }

  async session(
    sessionId: string | undefined,
    attemptId: string | undefined,
  ): Promise<Actor | undefined> {
    if (sessionId !== undefined) {
      if (!this.#bySession.has(sessionId)) {
        const spans = await this.#telemetry.readSpans({ sessionId, limit: 50 });
        for (const span of spans) this.#index(span);
        if (!this.#bySession.has(sessionId)) this.#bySession.set(sessionId, undefined);
      }
      const found = this.#bySession.get(sessionId);
      if (found !== undefined) return found;
    }
    if (attemptId !== undefined) {
      if (!this.#byAttempt.has(attemptId)) {
        const spans = await this.#telemetry.readSpans({ attemptId, limit: 50 });
        for (const span of spans) this.#index(span);
        if (!this.#byAttempt.has(attemptId)) this.#byAttempt.set(attemptId, undefined);
      }
      return this.#byAttempt.get(attemptId);
    }
    return undefined;
  }

  async playScenario(playId: string | null): Promise<string | undefined> {
    if (playId === null) return undefined;
    if (!this.#byPlay.has(playId)) {
      const spans = await this.#telemetry.readSpans({ playId, limit: 50 });
      for (const span of spans) this.#index(span);
      if (!this.#byPlay.has(playId)) this.#byPlay.set(playId, undefined);
    }
    return this.#byPlay.get(playId);
  }
}
