// SPDX-License-Identifier: MPL-2.0
import {
  formatProfileId,
  parseProfileId,
  priceTokens,
  type Clock,
  type NormalizedUpdate,
  type ProfileKind,
  type ProfileRef,
  type Store,
  type UsageCost,
  type UsageListFilter,
  type UsageRecord,
} from '@otheater/core';
import {
  buildDaemonEvent,
  quotaSignalParamsSchema,
  type QuotaSignal,
  type UsageRecordedPayload,
} from '@otheater/protocol';
import type { Logger } from '../logger.js';
import { TRACKED_PROFILE } from '../recovery/tracking-launcher.js';
import type { UsageSettings } from './settings.js';

export type UsageProfileTarget = string | ProfileRef;

export interface UsageServiceOptions {
  readonly store: Pick<Store, 'transaction' | 'usage' | 'sessions' | 'profiles' | 'attempts'>;
  readonly clock: Clock;
  readonly settings: UsageSettings;
  readonly logger: Logger;
}

/** What the service needs to know about a session to write its consumption. */
export interface UsageBinding {
  readonly profile: UsageProfileTarget;
  /** The Executor name (`<model>-<effort>@<client>/<profile>`). */
  readonly executorId: string;
  /** The play the session works for, when it is one of a play. */
  readonly playId?: string | undefined;
}

/** The model of a turn the client never named: the row needs one, and it has no price. */
export const UNKNOWN_MODEL = 'unknown';

/** The sums of a set of turns. Money is in US$; a cost nobody knew is counted, never added as 0. */
export interface UsageTotals {
  readonly turns: number;
  /** Sums of the counts that were reported; a turn that did not report one adds nothing. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  /** What the accounts were charged (profiles of API): the only figure that is spending. */
  readonly realUsd: number;
  /** What the tokens would cost by API on a subscription: an estimate, never part of `realUsd`. */
  readonly apiEquivalentUsd: number;
  /** Turns whose cost is unknown. Both sums above leave them out. */
  readonly unknownCostTurns: number;
  /** False when `unknownCostTurns` is above zero: the sums are then a lower bound. */
  readonly complete: boolean;
}

export const USAGE_GROUPS = ['session', 'play', 'profile', 'executor'] as const;
export type UsageGroup = (typeof USAGE_GROUPS)[number];

export interface UsageGroupTotals {
  /** The session id, play id, profile id or Executor name; `null` for the turns of no play. */
  readonly key: string | null;
  readonly totals: UsageTotals;
}

/** What the screens show of a subscription profile beside its quota (`usage.subscription_display`). */
export interface SubscriptionView {
  readonly profileId: string;
  readonly display: UsageSettings['subscriptionDisplay'];
  /** The API equivalent of the period; null when the display is `quota`. */
  readonly apiEquivalentUsd: number | null;
  /** The turns of the period whose equivalent is unknown (the figure above is then a lower bound). */
  readonly unknownCostTurns: number;
  /** Only with `prorated`: the plan's monthly price and the share of it the period carries. */
  readonly prorated: {
    readonly monthlyPriceUsd: number;
    /** The price times the period's share of the month's equivalent; null while the month has no use. */
    readonly periodUsd: number | null;
  } | null;
}

/** US$ are summed as whole nano-dollars, so any grouping of the same turns gives the same figure. */
const NANO = 1_000_000_000;
const nano = (usd: number): number => Math.round(usd * NANO);

interface Draft {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  realNano: number;
  equivalentNano: number;
  unknown: number;
}

const emptyDraft = (): Draft => ({
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  realNano: 0,
  equivalentNano: 0,
  unknown: 0,
});

function addRow(draft: Draft, row: UsageRecord): void {
  draft.turns += 1;
  draft.inputTokens += row.inputTokens ?? 0;
  draft.outputTokens += row.outputTokens ?? 0;
  draft.cachedTokens += row.cachedTokens ?? 0;
  if (row.costUsd === null || row.costKind === null) {
    draft.unknown += 1;
  } else if (row.costKind === 'real') {
    draft.realNano += nano(row.costUsd);
  } else {
    draft.equivalentNano += nano(row.costUsd);
  }
}

function totalsOf(draft: Draft): UsageTotals {
  return {
    turns: draft.turns,
    inputTokens: draft.inputTokens,
    outputTokens: draft.outputTokens,
    cachedTokens: draft.cachedTokens,
    realUsd: draft.realNano / NANO,
    apiEquivalentUsd: draft.equivalentNano / NANO,
    unknownCostTurns: draft.unknown,
    complete: draft.unknown === 0,
  };
}

/** What one report of consumption carries, whichever way it arrived. */
interface Consumption {
  readonly model?: string | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
  readonly costUsd?: number | undefined;
}

interface Resolved {
  readonly profileId: string;
  readonly executorId: string;
  readonly playId: string | null;
}

const isCount = (value: number | undefined): value is number =>
  value !== undefined && Number.isInteger(value) && value >= 0;

/**
 * Consumption and cost in money (architecture 5.6; Phase 5, P10). It takes what a session reports
 * about its use (the `usage` signal and the `usage` update, which is the ACP `usage_update` of the
 * client), works out the cost of each turn, writes it to `usage` and announces `usage.recorded`.
 * [proposta] Everything below, except the sources and the event of the architecture.
 *
 * How a report becomes a turn:
 * - A report with token counts is one model call: its `costUsd`, when it has one, is the cost of
 *   that call. A report with a cost and no tokens is the ACP `usage_update`, whose `cost.amount` is
 *   the cumulative cost of the session (the `Cost` type of `@agentclientprotocol/sdk` [V]): the
 *   turn costs what the amount grew since the last one, and a report that grew nothing writes no
 *   turn. A report with only context counters writes nothing.
 * - `usage.cost_source` says where the cost comes from. `client_then_pricing` takes the cost the
 *   client reports and prices the tokens when it reports none; `pricing_table` always prices the
 *   tokens (a report with no tokens writes nothing, there is nothing to price); `provider_billing`
 *   has no adapter yet and works as `client_then_pricing`, with a warning at the first use.
 * - A cost nobody can work out (no price for the model, tokens missing) is recorded as unknown,
 *   never as US$ 0.
 * - The kind of a cost is `real` on a profile of API and `api_equivalent` on a subscription (the
 *   estimate of what the same tokens would cost by API); a session whose profile the store does not
 *   know is taken as a subscription, so an estimate never becomes spending.
 *
 * Where it does not reach: a client that reports both a cumulative cost and per-call tokens would
 * be counted twice [N]; the table has no price for a cache write the client does not count apart.
 */
export class UsageService {
  readonly #options: UsageServiceOptions;
  readonly #bound = new Map<string, UsageBinding>();
  /** The cumulative cost last seen per session, to turn an ACP `usage_update` into a turn. */
  readonly #cumulative = new Map<string, number>();
  readonly #models = new Map<string, string>();
  #queue: Promise<unknown> = Promise.resolve();
  #warnedProviderBilling = false;

  constructor(options: UsageServiceOptions) {
    this.#options = options;
  }

  // ---- what the daemon tells it ----

  /**
   * Ties a session (its id, or the id the client gave it) to a profile and an Executor, so what it
   * reports is written under them. [proposta] The pool binds a session when it opens one (P15);
   * until then the service falls back to the `sessions` row of the store, with the Executor name
   * `<model>@<client>/<profile>`.
   */
  bindSession(sessionId: string, binding: UsageBinding): void {
    this.#bound.set(sessionId, binding);
  }

  unbindSession(sessionId: string): void {
    this.#bound.delete(sessionId);
    this.#cumulative.delete(sessionId);
    this.#models.delete(sessionId);
  }

  // ---- what the sessions tell it ----

  /** The params of a `_otheater/quota/signal` notification; only a `usage` signal is of its business. */
  async ingestNotification(params: unknown): Promise<UsageRecord | undefined> {
    const parsed = quotaSignalParamsSchema.safeParse(params);
    if (!parsed.success) return undefined;
    return this.ingestSignal(parsed.data.sessionId, parsed.data.signal);
  }

  /** A quota signal of a session: the `usage` kind (tokens of a call and, maybe, its cost). */
  ingestSignal(sessionId: string, signal: QuotaSignal): Promise<UsageRecord | undefined> {
    if (signal.kind !== 'usage') return Promise.resolve(undefined);
    return this.#ingest(sessionId, {
      model: signal.model,
      inputTokens: signal.inputTokens,
      outputTokens: signal.outputTokens,
      costUsd: signal.costUsd,
    });
  }

  /** A `usage` update of the normalized stream of a session (the ACP `usage_update` among them). */
  ingestUpdate(sessionId: string, update: NormalizedUpdate): Promise<UsageRecord | undefined> {
    if (update.kind !== 'usage') return Promise.resolve(undefined);
    return this.#ingest(sessionId, update);
  }

  /** Resolves when everything taken in so far has been written. */
  async flush(): Promise<void> {
    await this.#queue;
  }

  // ---- what it answers ----

  /** The sums of the turns that match `filter` (a session, a play, a profile, an Executor, a period). */
  async totals(filter: UsageListFilter = {}): Promise<UsageTotals> {
    await this.#queue;
    const draft = emptyDraft();
    for (const row of await this.#options.store.usage.list(filter)) addRow(draft, row);
    return totalsOf(draft);
  }

  /** The same sums split by `by`: the groups add up to {@link totals} of the same filter. */
  async breakdown(by: UsageGroup, filter: UsageListFilter = {}): Promise<UsageGroupTotals[]> {
    await this.#queue;
    const groups = new Map<string | null, Draft>();
    for (const row of await this.#options.store.usage.list(filter)) {
      const key = keyOf(by, row);
      const draft = groups.get(key) ?? emptyDraft();
      addRow(draft, row);
      groups.set(key, draft);
    }
    return [...groups].map(([key, draft]) => ({ key, totals: totalsOf(draft) }));
  }

  /**
   * What to show of a subscription profile in the period, by `usage.subscription_display`: the API
   * equivalent beside the quota (`quota_and_equivalent`), nothing but the quota (`quota`), or the
   * monthly price shared by use (`prorated`). The month is `month` (default: the calendar month,
   * in UTC, of the end of the period) [proposta]; the price is `usage.monthly_price_usd`.
   */
  async subscriptionView(
    target: UsageProfileTarget,
    period: { readonly since?: number; readonly until?: number } = {},
    month?: { readonly since: number; readonly until: number },
  ): Promise<SubscriptionView> {
    const profileId = formatProfileId(refOf(target));
    const { subscriptionDisplay: display, monthlyPriceUsd } = this.#options.settings;
    const inPeriod = await this.totals({ profileId, ...period });
    const base = { profileId, display, unknownCostTurns: inPeriod.unknownCostTurns };
    if (display === 'quota') return { ...base, apiEquivalentUsd: null, prorated: null };
    const apiEquivalentUsd = inPeriod.apiEquivalentUsd;
    if (display === 'quota_and_equivalent') return { ...base, apiEquivalentUsd, prorated: null };
    const price = monthlyPriceUsd.get(profileId);
    if (price === undefined) return { ...base, apiEquivalentUsd, prorated: null };
    const window = month ?? monthOf(period.until ?? this.#options.clock.now());
    const whole = await this.totals({ profileId, since: window.since, until: window.until });
    const periodUsd =
      whole.apiEquivalentUsd > 0 ? (price * apiEquivalentUsd) / whole.apiEquivalentUsd : null;
    return { ...base, apiEquivalentUsd, prorated: { monthlyPriceUsd: price, periodUsd } };
  }

  // ---- the work ----

  #ingest(sessionId: string, report: Consumption): Promise<UsageRecord | undefined> {
    const run = this.#queue.then(() => this.#take(sessionId, report));
    // The chain goes on after a failure; the caller of this report still sees it.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #take(sessionId: string, report: Consumption): Promise<UsageRecord | undefined> {
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = report;
    const counts = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens];
    if (counts.some((count) => count !== undefined && !isCount(count))) {
      this.#options.logger.warn({ sessionId }, 'a usage report had a bad token count; ignored');
      return undefined;
    }
    if (report.costUsd !== undefined && !(Number.isFinite(report.costUsd) && report.costUsd >= 0)) {
      this.#options.logger.warn({ sessionId }, 'a usage report had a bad cost; ignored');
      return undefined;
    }
    const hasTokens = counts.some((count) => count !== undefined);
    const hasCost = report.costUsd !== undefined;
    if (!hasTokens && !hasCost) return undefined; // only context counters: not a turn

    const resolved = await this.#resolve(sessionId, report.model);
    if (resolved === undefined) {
      this.#options.logger.warn({ sessionId }, 'usage came from a session with no profile');
      return undefined;
    }
    if (report.model !== undefined) this.#models.set(sessionId, report.model);
    const model = report.model ?? this.#models.get(sessionId) ?? UNKNOWN_MODEL;

    const source = this.#sourceMode();
    let clientUsd: number | undefined;
    if (hasCost && !hasTokens) {
      // A cost with no tokens is the cumulative `usage_update` of ACP: only its growth is new.
      const growth = this.#growth(sessionId, report.costUsd as number);
      if (source === 'pricing_table' || growth === 0) return undefined; // nothing to price, or nothing grew
      clientUsd = growth;
    } else {
      clientUsd = report.costUsd;
    }

    const kind = await this.#kindOf(resolved.profileId);
    const cost = this.#costOf(model, report, clientUsd, source, kind);
    return this.#write(sessionId, resolved, model, report, cost);
  }

  /** The growth of a cumulative cost since the last report of the session (a lower one starts over). */
  #growth(sessionId: string, amount: number): number {
    const before = this.#cumulative.get(sessionId) ?? 0;
    this.#cumulative.set(sessionId, amount);
    return amount >= before ? amount - before : amount;
  }

  #sourceMode(): 'client_then_pricing' | 'pricing_table' {
    const { costSource } = this.#options.settings;
    if (costSource === 'provider_billing') {
      if (!this.#warnedProviderBilling) {
        this.#warnedProviderBilling = true;
        this.#options.logger.warn(
          {},
          'usage.cost_source provider_billing has no adapter yet; working as client_then_pricing',
        );
      }
      return 'client_then_pricing';
    }
    return costSource;
  }

  #costOf(
    model: string,
    report: Consumption,
    clientUsd: number | undefined,
    source: 'client_then_pricing' | 'pricing_table',
    kind: UsageCost['kind'],
  ): UsageCost | undefined {
    if (source === 'client_then_pricing' && clientUsd !== undefined) {
      return { usd: clientUsd, kind, source: 'client' };
    }
    const priced = priceTokens(this.#options.settings.pricing, model, {
      inputTokens: report.inputTokens,
      outputTokens: report.outputTokens,
      cacheReadTokens: report.cacheReadTokens,
      cacheWriteTokens: report.cacheWriteTokens,
    });
    if (priced === undefined) return undefined;
    return {
      usd: priced.usd,
      kind,
      source: 'pricing_table',
      pricingVersion: priced.pricingVersion,
    };
  }

  async #write(
    sessionId: string,
    resolved: Resolved,
    model: string,
    report: Consumption,
    cost: UsageCost | undefined,
  ): Promise<UsageRecord> {
    const occurredAt = this.#options.clock.now();
    return this.#options.store.transaction(async (tx) => {
      const row = await tx.usage.record({
        sessionId,
        ...(resolved.playId === null ? {} : { playId: resolved.playId }),
        profileId: resolved.profileId,
        executorId: resolved.executorId,
        model,
        ...(report.inputTokens === undefined ? {} : { inputTokens: report.inputTokens }),
        ...(report.outputTokens === undefined ? {} : { outputTokens: report.outputTokens }),
        ...(report.cacheReadTokens === undefined ? {} : { cachedTokens: report.cacheReadTokens }),
        ...(cost === undefined ? {} : { cost }),
        occurredAt,
      });
      const payload: UsageRecordedPayload = {
        usageId: row.id,
        sessionId: row.sessionId,
        playId: row.playId,
        profile: row.profileId,
        executor: row.executorId,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cachedTokens: row.cachedTokens,
        costUsd: row.costUsd,
        costKind: row.costKind,
        costSource: row.costSource,
        pricingVersion: row.pricingVersion,
        occurredAt: row.occurredAt,
      };
      await tx.events.append(buildDaemonEvent('usage.recorded', payload));
      return row;
    });
  }

  // ---- sessions ----

  async #kindOf(profileId: string): Promise<UsageCost['kind']> {
    const profile = await this.#options.store.profiles.get(profileId);
    const kind: ProfileKind | undefined = profile?.kind;
    if (kind === undefined) {
      this.#options.logger.warn(
        { profile: profileId },
        'usage of a profile the store does not know; taken as a subscription',
      );
    }
    return kind === 'api' ? 'real' : 'api_equivalent';
  }

  /** The profile, the Executor and the play of a session: the binding, else the `sessions` row. */
  async #resolve(sessionId: string, model: string | undefined): Promise<Resolved | undefined> {
    const bound = this.#bound.get(sessionId);
    if (bound !== undefined) {
      return {
        profileId: formatProfileId(refOf(bound.profile)),
        executorId: bound.executorId,
        playId: bound.playId ?? null,
      };
    }
    const { sessions, attempts } = this.#options.store;
    try {
      const row =
        (await sessions.get(sessionId)) ??
        (await sessions.list()).find((r) => r.clientSessionId === sessionId);
      if (row === undefined || row.profile === TRACKED_PROFILE) return undefined;
      const profileId = row.profile.includes('/') ? row.profile : `${row.client}/${row.profile}`;
      parseProfileId(profileId);
      const attempt = row.attemptId === null ? undefined : await attempts.get(row.attemptId);
      const named = model ?? this.#models.get(sessionId) ?? UNKNOWN_MODEL;
      return {
        profileId,
        executorId: `${named}@${profileId}`,
        playId: attempt?.playId ?? null,
      };
    } catch {
      return undefined;
    }
  }
}

function refOf(target: UsageProfileTarget): ProfileRef {
  return typeof target === 'string' ? parseProfileId(target) : target;
}

function keyOf(by: UsageGroup, row: UsageRecord): string | null {
  switch (by) {
    case 'session':
      return row.sessionId;
    case 'play':
      return row.playId;
    case 'profile':
      return row.profileId;
    case 'executor':
      return row.executorId;
  }
}

/** The calendar month (UTC) that holds `at`, as `[since, until]` in epoch ms. */
function monthOf(at: number): { since: number; until: number } {
  const date = new Date(at);
  const since = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const until = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1;
  return { since, until };
}
