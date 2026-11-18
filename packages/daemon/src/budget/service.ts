// SPDX-License-Identifier: MPL-2.0
import {
  tryParseExecutorId,
  type Clock,
  type Disposable,
  type Store,
  type UsageRecord,
} from '@otheater/core';
import {
  buildDaemonEvent,
  BudgetExceededPayloadSchema,
  BudgetWarningPayloadSchema,
  type BudgetExceededPayload,
  type BudgetPeriod,
  type BudgetWarningPayload,
} from '@otheater/protocol';
import type { BudgetInFlight, BudgetOnExceeded } from '../budget-config.js';
import type { Logger } from '../logger.js';
import type { QuotaService } from '../quota/service.js';
import { hitWindowOf } from '../quota/state.js';
import type { UsageService } from '../usage/service.js';
import { periodBounds } from './calendar.js';
import type { BudgetSettings } from './settings.js';

/** The periods a cap has, in the order the events and the readings list them. */
const PERIODS: readonly BudgetPeriod[] = ['day', 'month'];

/** US$ are compared as whole nano-dollars, as `UsageService` sums them. */
const NANO = 1_000_000_000;
const nano = (usd: number): number => Math.round(usd * NANO);

export interface BudgetServiceOptions {
  readonly store: Pick<Store, 'events' | 'quotaSnapshots'>;
  readonly clock: Clock;
  readonly settings: BudgetSettings;
  readonly logger: Logger;
  /**
   * Where a spent cap becomes `exhausted(budget)`, where the state is read back, and where a cap
   * that was raised or removed lets the profile go (`budget.on_cap_change: release`).
   */
  readonly quota: Pick<QuotaService, 'ingestLimitHit' | 'statusOf' | 'releaseBudgetHit'>;
  /** Where the spending is summed, and the turns come from. */
  readonly usage: Pick<UsageService, 'totals' | 'onRecorded'>;
  /** Whoever answers `on_exceeded: ask`. Without one, nobody is watching: `ask` becomes `skip`. */
  readonly asker?: BudgetAsker | undefined;
}

/** The cap a reading comes from: a profile's, an Executor's, or the run budget of 5.15. */
export type BudgetCapScope = 'profile' | 'executor' | 'run';

/** One cap against its spending. */
export interface BudgetCapReading {
  readonly scope: BudgetCapScope;
  /** The profile id or the Executor name; null for the run budget. */
  readonly id: string | null;
  readonly period: BudgetPeriod | 'run';
  readonly limitUsd: number;
  /** The `real` cost of the period, in US$ (a lower bound when `unknownCostTurns` is above 0). */
  readonly spentUsd: number;
  /** `limitUsd - spentUsd`, never below 0. */
  readonly remainingUsd: number;
  /** When the period turns and the count starts over; null for the run budget. */
  readonly endsAt: number | null;
  /** Turns of the period whose cost nobody knew. */
  readonly unknownCostTurns: number;
  /** True when `budget.unknown_cost: block` made the cap spent because of such a turn. */
  readonly blockedByUnknownCost: boolean;
}

/** What is left of the money for one Executor: the most restrictive cap decides (5.6). */
export interface BudgetHeadroom {
  readonly executorId: string;
  /** Every cap that applies, profile first. */
  readonly caps: readonly BudgetCapReading[];
  /** The cap with the least left; null when nothing is capped. */
  readonly binding: BudgetCapReading | null;
  /** What the binding cap leaves; null when nothing is capped. */
  readonly remainingUsd: number | null;
  /** False when the binding cap leaves nothing. */
  readonly allowed: boolean;
}

/** A turn's `run` budget (5.15): what the run may spend and what it has spent. */
export interface RunBudget {
  readonly limitUsd: number;
  readonly spentUsd: number;
}

/** What a profile's cap breach tells the listeners (the pool, the scheduler, the chat). */
export interface BudgetExceeded {
  readonly profile: string;
  /** The profile caps that are spent. */
  readonly caps: readonly BudgetCapReading[];
  /** When the profile is usable again: the latest end of the caps that are spent. */
  readonly resetsAt: number;
  readonly onExceeded: BudgetOnExceeded;
  readonly inFlight: BudgetInFlight;
}

export type BudgetExceededListener = (event: BudgetExceeded) => void;

/** The system message of a warning: the same payload the `budget.warning` event carries. */
export type BudgetWarningListener = (warning: BudgetWarningPayload) => void;

/** The question of `on_exceeded: ask`. */
export interface BudgetQuestion {
  readonly profile: string;
  readonly caps: readonly BudgetCapReading[];
  readonly resetsAt: number;
}

/**
 * The Producer, as the cap asks it (`on_exceeded: ask`): `skip` the profile until the reset, or
 * `wait` for it. `undefined` means nobody answered (nobody is watching). The signal aborts when
 * `budget.ask_timeout` ends. [proposta] Wiring it to the chat is P15/P18.
 */
export interface BudgetAsker {
  ask(question: BudgetQuestion, signal: AbortSignal): Promise<'skip' | 'wait' | undefined>;
}

/** What a demand does while the profile's cap is spent, and how that was settled. */
export interface BudgetChoice {
  /** `skip` takes the next Executor (`whenExhausted: next`); `wait` waits for the reset. */
  readonly choice: 'skip' | 'wait';
  /**
   * `config`: `on_exceeded` said so; `asked`: the Producer answered; `unattended`: `ask` with
   * nobody to answer, so `skip`; `timeout`: the Producer did not answer in time, so `skip`.
   */
  readonly via: 'config' | 'asked' | 'unattended' | 'timeout';
}

/** The `whenExhausted` of a role for a {@link BudgetChoice} (`skip` is `next`). */
export function whenExhaustedOf(choice: BudgetChoice['choice']): 'next' | 'wait' {
  return choice === 'wait' ? 'wait' : 'next';
}

interface Cap {
  readonly scope: 'profile' | 'executor';
  readonly id: string;
  readonly period: BudgetPeriod;
  readonly limitUsd: number;
  readonly warnAt: readonly number[];
}

interface Reading extends BudgetCapReading {
  readonly scope: 'profile' | 'executor';
  readonly id: string;
  readonly period: BudgetPeriod;
  readonly warnAt: readonly number[];
}

const DEFAULT_ON_EXCEEDED: BudgetOnExceeded = 'skip';
const DEFAULT_IN_FLIGHT: BudgetInFlight = 'handoff';

/**
 * The spending cap of an API profile and of its Executors (architecture 5.6, "Teto de gasto em
 * API"; Phase 5, P11). [proposta] Everything that is not a key or a mode of the architecture.
 *
 * - The spending is the sum of `real` cost in the `usage` table (P10), over the calendar day or
 *   month in `budget.timezone`. It re-reads on every turn that is written. A subscription never
 *   reaches a cap: its cost is `api_equivalent`.
 * - The caps are the profile's `daily_usd` and `monthly_usd` and the Executor's own (inside its
 *   profile's). The most restrictive one wins, and so does the per-run budget of 5.15 when one is
 *   given to {@link headroom}.
 * - Each `warn_at` fraction that a cap passes is announced once, with `budget.warning`, per period.
 * - A profile cap that is spent puts the profile in `exhausted(budget)` through
 *   `QuotaService.ingestLimitHit`, with the end of the period as the reset. From there the machinery
 *   of P5, P9 and P17 is the same as for a quota: the selection skips it, the wakeup of P9 is set
 *   to the turn of the day or month, `budget.restored` says it is back, and an attempt that meets
 *   the limit is a `spend_cap` for the policy of 5.16 (`in_flight`).
 * - An Executor cap that is spent changes no state: {@link headroom} says it, and the selection
 *   skips that Executor only.
 *
 * Where it does not reach [N]: the cap cannot stop a turn that is already running (a session only
 * reports its cost after the turn), so the spending can pass the cap by what one turn costs; the
 * `in_flight` mode of a running session is decided by the policy of 5.16 when its client meets the
 * limit, and the pool (P15) is who would interrupt a session before that.
 */
export class BudgetService {
  readonly #options: BudgetServiceOptions;
  readonly #listeners = new Set<BudgetExceededListener>();
  readonly #warningListeners = new Set<BudgetWarningListener>();
  /** What the service reads: `applySettings` replaces it when the configuration is read again. */
  #settings: BudgetSettings;
  /** The warnings already written: key to the end of the period they belong to. */
  readonly #warned = new Map<string, number>();
  /** The `budget.exceeded` already written: key to the end of the period they belong to. */
  readonly #exceededSent = new Map<string, number>();
  /** The models whose unknown cost was already said in the log (once per life of the daemon). */
  readonly #unknownCostModels = new Set<string>();
  /** The profiles whose cap is spent now, with the reset the last hit gave. */
  readonly #breached = new Map<string, BudgetExceeded>();
  readonly #answers = new Map<string, Promise<BudgetChoice>>();
  #queue: Promise<unknown> = Promise.resolve();
  #subscription: Disposable | undefined;
  #started = false;

  constructor(options: BudgetServiceOptions) {
    this.#options = options;
    this.#settings = options.settings;
  }

  // ---- settings ----

  /** What `profiles.<id>.budget` says for a profile; the defaults when it has no cap. */
  settingsOf(profile: string): { onExceeded: BudgetOnExceeded; inFlight: BudgetInFlight } {
    const own = this.#settings.profiles.get(profile);
    return {
      onExceeded: own?.onExceeded ?? DEFAULT_ON_EXCEEDED,
      inFlight: own?.inFlight ?? DEFAULT_IN_FLIGHT,
    };
  }

  /** Hears every time a profile's cap becomes spent (or is spent to a later end). */
  onExceeded(listener: BudgetExceededListener): Disposable {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  /**
   * Hears every warning right after `budget.warning` is written: it is the system message of the
   * cap, for whoever shows messages to the Producer. [N] The chat has no channel for a message that
   * belongs to a profile and not to a scenario yet, so nothing is plugged in here by default.
   */
  onWarning(listener: BudgetWarningListener): Disposable {
    this.#warningListeners.add(listener);
    return {
      dispose: () => {
        this.#warningListeners.delete(listener);
      },
    };
  }

  // ---- life ----

  /**
   * Reads the warnings the log already holds (so a restart does not repeat them), listens to the
   * turns of `UsageService` and re-reads every capped profile, which catches what was spent while
   * the daemon was stopped, or what a lowered cap now makes spent.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#seedFromLog();
    this.#subscription = this.#options.usage.onRecorded((row) => {
      this.#noteUnknownCost(row);
      void this.#enqueue(() => this.#evaluate(row.profileId, [row.executorId]));
    });
    await this.#evaluateAll();
    await this.flush();
  }

  /**
   * The configuration was read again (P11b): the service takes the new caps and reads every capped
   * profile against them. With `budget.on_cap_change: release`, a profile that is
   * `exhausted(budget)` and whose cap now leaves room (or is gone) is released at once, with
   * `budget.restored` and the reason `config`. [N] The daemon reads its configuration only on
   * start-up today, where the same reading is `start`; this is the hook a reload plugs into.
   */
  async applySettings(settings: BudgetSettings): Promise<void> {
    this.#settings = settings;
    await this.#evaluateAll();
    await this.flush();
  }

  async stop(): Promise<void> {
    this.#subscription?.dispose();
    this.#subscription = undefined;
    await this.flush();
  }

  /** Resolves when every turn heard so far has been read against the caps. */
  async flush(): Promise<void> {
    await this.#queue;
  }

  /** Reads one profile (and the Executors given) against its caps now; for a caller that has no turn. */
  evaluate(profile: string, ...executors: readonly string[]): Promise<void> {
    return this.#enqueue(() => this.#evaluate(profile, executors));
  }

  // ---- what the selection asks ----

  /**
   * What an Executor may still spend: the profile's day and month, its own day and month, and the
   * per-run budget of 5.15 when `run` is given. The cap with the least left binds; one that is
   * spent leaves `allowed` false. Nothing capped is `allowed` with no number.
   */
  async headroom(executorId: string, run?: RunBudget): Promise<BudgetHeadroom> {
    const parsed = tryParseExecutorId(executorId);
    const profile = typeof parsed === 'string' ? undefined : parsed.profileId;
    const caps: BudgetCapReading[] = [...(await this.#read(profile, executorId))];
    if (run !== undefined) {
      caps.push({
        scope: 'run',
        id: null,
        period: 'run',
        limitUsd: run.limitUsd,
        spentUsd: run.spentUsd,
        remainingUsd: Math.max(0, (nano(run.limitUsd) - nano(run.spentUsd)) / NANO),
        endsAt: null,
        unknownCostTurns: 0,
        blockedByUnknownCost: false,
      });
    }
    let binding: BudgetCapReading | null = null;
    for (const cap of caps) {
      // A tie keeps the first: the profile's cap is listed before the Executor's.
      if (binding === null || cap.remainingUsd < binding.remainingUsd) binding = cap;
    }
    return {
      executorId,
      caps,
      binding,
      remainingUsd: binding?.remainingUsd ?? null,
      allowed: binding === null || binding.remainingUsd > 0,
    };
  }

  /**
   * What a demand does while the profile's cap is spent: `on_exceeded` (`skip` or `wait`), or, for
   * `ask`, what the Producer answers. With nobody to ask, or no answer within `budget.ask_timeout`,
   * `ask` is `skip`. One answer holds until the profile's reset. `undefined` when the profile's cap
   * is not spent.
   */
  resolveExceeded(profile: string): Promise<BudgetChoice> | undefined {
    const breach = this.exceededOf(profile);
    if (breach === undefined) return undefined;
    const key = `${profile}|${String(breach.resetsAt)}`;
    let answer = this.#answers.get(key);
    if (answer === undefined) {
      answer = this.#choose(breach);
      this.#answers.set(key, answer);
    }
    return answer;
  }

  /** The profile caps that are spent now, or undefined (a period that has turned is not spent). */
  exceededOf(profile: string): BudgetExceeded | undefined {
    const breach = this.#breached.get(profile);
    if (breach !== undefined && breach.resetsAt <= this.#options.clock.now()) {
      this.#breached.delete(profile);
      return undefined;
    }
    return breach;
  }

  async #choose(breach: BudgetExceeded): Promise<BudgetChoice> {
    if (breach.onExceeded !== 'ask') return { choice: breach.onExceeded, via: 'config' };
    const { asker, clock, logger } = this.#options;
    const settings = this.#settings;
    if (asker === undefined) return { choice: 'skip', via: 'unattended' };
    const abort = new AbortController();
    const timeout = clock.sleep(settings.askTimeoutMs, abort.signal).then(
      () => 'timeout' as const,
      () => undefined,
    );
    try {
      const answer = await Promise.race([
        asker
          .ask(
            { profile: breach.profile, caps: breach.caps, resetsAt: breach.resetsAt },
            abort.signal,
          )
          .then((value) => value ?? ('unattended' as const)),
        timeout,
      ]);
      if (answer === 'timeout') return { choice: 'skip', via: 'timeout' };
      if (answer === 'unattended' || answer === undefined)
        return { choice: 'skip', via: 'unattended' };
      return { choice: answer, via: 'asked' };
    } catch (error) {
      logger.warn({ err: error, profile: breach.profile }, 'asking about the spending cap failed');
      return { choice: 'skip', via: 'unattended' };
    } finally {
      abort.abort();
    }
  }

  // ---- the work ----

  #enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(work).catch((error: unknown) => {
      this.#options.logger.error({ err: error }, 'reading the spending against the caps failed');
    });
    this.#queue = run;
    return run;
  }

  /** Queues the reading of every subject; a failure of one is logged and the others go on. */
  async #evaluateAll(): Promise<void> {
    try {
      for (const [profile, executors] of await this.#subjects()) {
        void this.#enqueue(() => this.#evaluate(profile, executors));
      }
    } catch (error) {
      this.#options.logger.error({ err: error }, 'listing the profiles with a spending cap failed');
    }
  }

  /**
   * The profiles that have a cap, with the Executors of those that have one of their own; and,
   * under `on_cap_change: release`, those that are `exhausted(budget)` with no cap left (the cap
   * was removed while the daemon was stopped), so that they are released too.
   */
  async #subjects(): Promise<Map<string, string[]>> {
    const subjects = new Map<string, string[]>();
    for (const profile of this.#settings.profiles.keys()) subjects.set(profile, []);
    for (const executor of this.#settings.executors.keys()) {
      const parsed = tryParseExecutorId(executor);
      if (typeof parsed === 'string') continue;
      const list = subjects.get(parsed.profileId) ?? [];
      list.push(executor);
      subjects.set(parsed.profileId, list);
    }
    if (this.#settings.onCapChange === 'release') {
      const now = this.#options.clock.now();
      for (const row of await this.#options.store.quotaSnapshots.list()) {
        if (row.window !== hitWindowOf('budget')) continue;
        if (row.resetsAt !== null && row.resetsAt <= now) continue;
        if (!subjects.has(row.profileId)) subjects.set(row.profileId, []);
      }
    }
    return subjects;
  }

  /** The caps that apply to a profile and, when given, to one Executor of it. */
  #capsOf(profile: string | undefined, executorId: string | undefined): Cap[] {
    const { profiles, executors } = this.#settings;
    const caps: Cap[] = [];
    const add = (
      scope: Cap['scope'],
      id: string,
      limits: {
        dailyUsd?: number | undefined;
        monthlyUsd?: number | undefined;
        warnAt: readonly number[];
      },
    ): void => {
      const byPeriod = { day: limits.dailyUsd, month: limits.monthlyUsd };
      for (const period of PERIODS) {
        const limitUsd = byPeriod[period];
        if (limitUsd !== undefined)
          caps.push({ scope, id, period, limitUsd, warnAt: limits.warnAt });
      }
    };
    const own = profile === undefined ? undefined : profiles.get(profile);
    if (profile !== undefined && own !== undefined) add('profile', profile, own);
    const executor = executorId === undefined ? undefined : executors.get(executorId);
    if (executorId !== undefined && executor !== undefined) add('executor', executorId, executor);
    return caps;
  }

  async #read(profile: string | undefined, executorId: string | undefined): Promise<Reading[]> {
    const { clock, usage } = this.#options;
    const settings = this.#settings;
    const now = clock.now();
    const readings: Reading[] = [];
    for (const cap of this.#capsOf(profile, executorId)) {
      const bounds = periodBounds(cap.period, now, settings.timezone);
      const totals = await usage.totals({
        ...(cap.scope === 'profile' ? { profileId: cap.id } : { executorId: cap.id }),
        since: bounds.start,
        until: bounds.end - 1,
      });
      const blocked =
        cap.scope === 'profile' && settings.unknownCost === 'block' && totals.unknownCostTurns > 0;
      readings.push({
        scope: cap.scope,
        id: cap.id,
        period: cap.period,
        limitUsd: cap.limitUsd,
        spentUsd: totals.realUsd,
        remainingUsd: blocked ? 0 : Math.max(0, (nano(cap.limitUsd) - nano(totals.realUsd)) / NANO),
        endsAt: bounds.end,
        unknownCostTurns: totals.unknownCostTurns,
        blockedByUnknownCost: blocked,
        warnAt: cap.warnAt,
      });
    }
    return readings;
  }

  async #evaluate(profile: string, list: readonly string[]): Promise<void> {
    const profileReadings = (await this.#read(profile, undefined)).filter(
      (r) => r.scope === 'profile',
    );
    const readings = [...profileReadings];
    for (const executorId of list) {
      const own = await this.#read(undefined, executorId);
      readings.push(...own.filter((r) => r.scope === 'executor'));
    }
    this.#prune();
    await this.#warn(profile, readings);
    await this.#announceExceeded(profile, readings);
    await this.#enforce(profile, profileReadings);
  }

  /** Forgets the warnings and the overruns of periods that have turned. */
  #prune(): void {
    const now = this.#options.clock.now();
    for (const sent of [this.#warned, this.#exceededSent]) {
      for (const [key, endsAt] of sent) {
        if (endsAt <= now) sent.delete(key);
      }
    }
  }

  /**
   * [proposta] `budget.unknown_cost: ignore` leaves the turn out of the sum, so the cap is blind to
   * it: the log says so once per model per life of the daemon, with the way out (`pricing.<model>`).
   * Only a turn of a profile or Executor that has a cap matters; `block` has its own effect.
   */
  #noteUnknownCost(row: UsageRecord): void {
    if (this.#settings.unknownCost !== 'ignore') return;
    if (row.costUsd !== null && row.costKind !== null) return;
    const { profiles, executors } = this.#settings;
    if (!profiles.has(row.profileId) && !executors.has(row.executorId)) return;
    if (this.#unknownCostModels.has(row.model)) return;
    this.#unknownCostModels.add(row.model);
    this.#options.logger.warn(
      { model: row.model, profile: row.profileId, executor: row.executorId },
      `a turn of the model "${row.model}" has no known cost, so the spending cap does not count it (budget.unknown_cost: ignore); set pricing.${row.model} in the configuration to give the model a price`,
    );
  }

  /**
   * `budget.exceeded` (P11b, [proposta]): once per cap, period and limit. An Executor cap says it
   * here and in the log; a profile cap also becomes `exhausted(budget)` in {@link #enforce}.
   */
  async #announceExceeded(profile: string, readings: readonly Reading[]): Promise<void> {
    for (const reading of readings) {
      if (reading.endsAt === null || reading.remainingUsd > 0) continue;
      const key = `${reading.scope}|${reading.id}|${reading.period}|${String(reading.endsAt)}|${String(reading.limitUsd)}`;
      if (this.#exceededSent.has(key)) continue;
      this.#exceededSent.set(key, reading.endsAt);
      const payload: BudgetExceededPayload = {
        profile,
        executor: reading.scope === 'executor' ? reading.id : null,
        period: reading.period,
        spentUsd: reading.spentUsd,
        limitUsd: reading.limitUsd,
        endsAt: reading.endsAt,
      };
      try {
        await this.#options.store.events.append(buildDaemonEvent('budget.exceeded', payload));
      } catch (error) {
        // Written again on the next turn.
        this.#exceededSent.delete(key);
        throw error;
      }
      if (reading.scope === 'executor') {
        this.#options.logger.info(
          { executor: reading.id, period: reading.period },
          'the spending cap of an Executor is spent; the selection skips it until the period turns',
        );
      }
    }
  }

  async #warn(profile: string, readings: readonly Reading[]): Promise<void> {
    for (const reading of readings) {
      if (reading.endsAt === null) continue;
      for (const fraction of reading.warnAt) {
        if (nano(reading.spentUsd) < nano(reading.limitUsd * fraction)) continue;
        const key = `${reading.scope}|${reading.id}|${reading.period}|${String(reading.endsAt)}|${String(fraction)}`;
        if (this.#warned.has(key)) continue;
        this.#warned.set(key, reading.endsAt);
        const payload: BudgetWarningPayload = {
          profile,
          executor: reading.scope === 'executor' ? reading.id : null,
          period: reading.period,
          thresholdFraction: fraction,
          spentUsd: reading.spentUsd,
          limitUsd: reading.limitUsd,
          periodEndsAt: reading.endsAt,
        };
        try {
          await this.#options.store.events.append(buildDaemonEvent('budget.warning', payload));
        } catch (error) {
          // Written again on the next turn.
          this.#warned.delete(key);
          throw error;
        }
        for (const listener of this.#warningListeners) {
          try {
            listener(payload);
          } catch (error) {
            this.#options.logger.warn({ err: error, profile }, 'a budget warning listener failed');
          }
        }
      }
    }
  }

  async #enforce(profile: string, readings: readonly Reading[]): Promise<void> {
    const spent = readings.filter((r) => r.remainingUsd === 0);
    if (spent.length === 0) {
      this.#breached.delete(profile);
      await this.#release(profile);
      return;
    }
    const resetsAt = Math.max(...spent.map((r) => r.endsAt ?? 0));
    await this.#options.quota.ingestLimitHit(profile, {
      source: `budget:${spent.map((r) => r.period).join('+')}`,
      resetsAt,
      cause: 'budget',
    });
    const before = this.#breached.get(profile);
    const settings = this.settingsOf(profile);
    const event: BudgetExceeded = { profile, caps: spent, resetsAt, ...settings };
    this.#breached.set(profile, event);
    if (before?.resetsAt === resetsAt) return;
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#options.logger.warn({ err: error, profile }, 'a budget listener failed');
      }
    }
  }

  /**
   * `budget.on_cap_change: release` (P11b): no cap of the profile is spent any more. A profile that
   * is still `exhausted(budget)` can only be so because the cap was raised or removed (the period
   * has not turned, or the quota would say so), so it is let go now. `keep` waits for the turn.
   */
  async #release(profile: string): Promise<void> {
    if (this.#settings.onCapChange !== 'release') return;
    const { quota, logger } = this.#options;
    const status = await quota.statusOf(profile);
    if (status.state !== 'exhausted' || status.cause !== 'budget') return;
    await quota.releaseBudgetHit(profile);
    logger.info(
      { profile },
      'the spending cap was raised or removed in the configuration: the profile is released before the period turns (budget.on_cap_change: release)',
    );
  }

  async #seedFromLog(): Promise<void> {
    const { events } = this.#options.store;
    const now = this.#options.clock.now();
    let after = 0;
    for (;;) {
      const batch = await events.readFrom(after, 500);
      if (batch.length === 0) break;
      for (const event of batch) {
        after = event.id;
        if (event.type === 'budget.exceeded') {
          const parsed = BudgetExceededPayloadSchema.safeParse(event.payload);
          if (!parsed.success || parsed.data.endsAt <= now) continue;
          const { executor, profile, period, endsAt, limitUsd } = parsed.data;
          const scope = executor === null ? 'profile' : 'executor';
          this.#exceededSent.set(
            `${scope}|${executor ?? profile}|${period}|${String(endsAt)}|${String(limitUsd)}`,
            endsAt,
          );
          continue;
        }
        if (event.type !== 'budget.warning') continue;
        const parsed = BudgetWarningPayloadSchema.safeParse(event.payload);
        if (!parsed.success || parsed.data.periodEndsAt <= now) continue;
        const { executor, profile, period, periodEndsAt, thresholdFraction } = parsed.data;
        const scope = executor === null ? 'profile' : 'executor';
        this.#warned.set(
          `${scope}|${executor ?? profile}|${period}|${String(periodEndsAt)}|${String(thresholdFraction)}`,
          periodEndsAt,
        );
      }
    }
  }
}
