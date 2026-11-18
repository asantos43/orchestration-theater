// SPDX-License-Identifier: MPL-2.0
import type {
  Clock,
  ProfileRecord,
  Store,
  UsageSource,
  UsageSourceEntry,
  UsageSourceStatus,
} from '@otheater/core';
import type { Logger } from '../logger.js';
import { situationText, type SituationSink } from '../situations.js';
import type { UsageTotals } from './service.js';
import type { UsageAuditSettings } from './settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The part of the `UsageService` the check reads. */
export interface UsageTotalsReader {
  totals(filter: { profileId: string; since: number; until: number }): Promise<UsageTotals>;
}

export interface UsageAuditOptions {
  readonly source: UsageSource;
  readonly usage: UsageTotalsReader;
  readonly store: Pick<Store, 'profiles'>;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly settings: UsageAuditSettings;
  /** Where the situations are also written as `usage.notice` (P24, N146). */
  readonly situations?: SituationSink | undefined;
}

/** What one comparison of a profile found. */
export interface UsageAuditResult {
  readonly profile: string;
  /** The first and last UTC day read (`YYYY-MM-DD`). */
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly ccusage: { readonly tokens: number; readonly costUsd: number | null };
  readonly signals: { readonly tokens: number; readonly costUsd: number | null };
  /** What disagrees: `tokens` and, with `compare: tokens_and_cost`, `cost`. Empty means they agree. */
  readonly diverged: readonly ('tokens' | 'cost')[];
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Input plus output tokens of the entries; what the client did not report counts as 0. */
function tokensOf(entries: readonly UsageSourceEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.inputTokens ?? 0) + (e.outputTokens ?? 0), 0);
}

/** The cost of the entries, or `null` when any entry has none (a lower bound is not a figure). */
function costOf(entries: readonly UsageSourceEntry[]): number | null {
  let total = 0;
  for (const entry of entries) {
    if (entry.costUsd === null) return null;
    total += entry.costUsd;
  }
  return total;
}

/**
 * Whether two figures disagree: the gap is at or above the floor AND above `tolerance` times the
 * larger of the two. Two zeros agree.
 */
export function diverges(a: number, b: number, tolerance: number, floor: number): boolean {
  const gap = Math.abs(a - b);
  const larger = Math.max(a, b);
  if (larger === 0 || gap < floor || gap === 0) return false;
  return gap / larger > tolerance;
}

const pct = (a: number, b: number): string =>
  String(Math.round((Math.abs(a - b) / Math.max(a, b, 1)) * 100));

/**
 * The `ccusage` check (Phase 5, P12, N118): sets the consumption `ccusage` reads from the log
 * directory of each profile against what the `UsageService` recorded from the signals, and tells
 * when they disagree by more than the tolerance (a log warning and a `usage.notice`). It is an
 * audit only: nothing it reads changes a figure the daemon uses, and the daemon works with the
 * signals alone when it is off, absent or failing.
 *
 * [proposta] The rules:
 * - the adapter is checked once at start-up (`--version`); if it is missing or the wrong version the
 *   check stays off, with a warning and a `usage.notice` (`ccusage_unavailable` or
 *   `ccusage_wrong_version`);
 * - a profile is compared by UTC days (`windowDays`, today included), on input plus output tokens
 *   and, with `compare: tokens_and_cost`, on the cost when both sides know it completely;
 * - a divergence is told once when a profile enters it, and again after it has agreed in between;
 *   the same goes for a failing read (`ccusage_failed`);
 * - `ccusage` reads the clients' own logs, and the `UsageService` only the turns bound to a session
 *   (P15); a profile used outside the daemon, or before the sessions are bound, will diverge [N].
 */
export class UsageAudit {
  readonly #o: UsageAuditOptions;
  readonly #diverging = new Set<string>();
  readonly #failing = new Set<string>();
  readonly #abort = new AbortController();
  #active = false;
  #running: Promise<void> = Promise.resolve();

  constructor(options: UsageAuditOptions) {
    this.#o = options;
  }

  /** Whether the check passed at start-up and is comparing. */
  get active(): boolean {
    return this.#active;
  }

  /**
   * Checks the adapter and, when it is fine, starts comparing (the first comparison at once, in the
   * background, then every `interval`). Never rejects: a failure is the returned status.
   */
  async start(): Promise<UsageSourceStatus> {
    const status = await this.#o.source.check().catch((error: unknown): UsageSourceStatus => ({
      ok: false,
      reason: 'failed',
      detail: situationText(error, 200) ?? 'the check failed',
    }));
    if (!status.ok) {
      this.#o.logger.warn(
        { reason: status.reason, detail: status.detail },
        'ccusage is enabled but cannot be used: the daemon works with the signals alone',
      );
      this.#o.situations?.record('usage.notice', {
        kind: status.reason === 'wrong_version' ? 'ccusage_wrong_version' : 'ccusage_unavailable',
        sessionId: null,
        profile: null,
        ...detailOf(status.detail),
      });
      return status;
    }
    this.#active = true;
    this.#o.logger.info({ version: status.version }, 'ccusage check on');
    this.#running = this.#loop();
    return status;
  }

  /** Stops the loop and waits for the comparison in progress. */
  async stop(): Promise<void> {
    this.#abort.abort();
    this.#active = false;
    await this.#running;
  }

  /** Resolves when the loop has ended (with `interval: 0`, after the first comparison). */
  settled(): Promise<void> {
    return this.#running;
  }

  /** Compares every profile that has a `ccusage` source. Never rejects. */
  async compareAll(): Promise<UsageAuditResult[]> {
    const results: UsageAuditResult[] = [];
    let profiles: readonly ProfileRecord[];
    try {
      profiles = await this.#o.store.profiles.list({ states: ['active', 'draining'] });
    } catch (error) {
      this.#o.logger.warn({ err: situationText(error, 200) }, 'ccusage check: profiles not read');
      return results;
    }
    for (const profile of profiles) {
      if (this.#abort.signal.aborted) break;
      const result = await this.compareProfile(profile);
      if (result !== undefined) results.push(result);
    }
    return results;
  }

  /**
   * Compares one profile over the window. `undefined` when the read failed (told as
   * `ccusage_failed`) or the client has no `ccusage` source.
   */
  async compareProfile(profile: ProfileRecord): Promise<UsageAuditResult | undefined> {
    const { settings, clock } = this.#o;
    const now = clock.now();
    const untilDay = dayOf(now);
    const startMs = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );
    const sinceMs = startMs - (settings.windowDays - 1) * DAY_MS;
    const sinceDay = dayOf(sinceMs);
    let entries: readonly UsageSourceEntry[];
    try {
      entries = await this.#o.source.read({
        clientId: profile.client,
        profileDir: profile.dir,
        sinceDay,
        untilDay,
      });
    } catch (error) {
      if (!this.#failing.has(profile.id)) {
        this.#failing.add(profile.id);
        const detail = situationText(error, 400);
        this.#o.logger.warn(
          { profile: profile.id, detail },
          'ccusage check: the read of a profile failed; the signals stay as they are',
        );
        this.#o.situations?.record('usage.notice', {
          kind: 'ccusage_failed',
          sessionId: null,
          profile: profile.id,
          ...detailOf(detail ?? undefined),
        });
      }
      return undefined;
    }
    this.#failing.delete(profile.id);
    const totals = await this.#o.usage.totals({
      profileId: profile.id,
      since: sinceMs,
      until: startMs + DAY_MS - 1,
    });
    const ccusage = { tokens: tokensOf(entries), costUsd: costOf(entries) };
    const signals = {
      tokens: totals.inputTokens + totals.outputTokens,
      costUsd: totals.complete ? totals.realUsd + totals.apiEquivalentUsd : null,
    };
    const diverged: ('tokens' | 'cost')[] = [];
    if (diverges(ccusage.tokens, signals.tokens, settings.tolerance, settings.minTokens)) {
      diverged.push('tokens');
    }
    if (
      settings.compare === 'tokens_and_cost' &&
      ccusage.costUsd !== null &&
      signals.costUsd !== null &&
      diverges(ccusage.costUsd, signals.costUsd, settings.tolerance, settings.minUsd)
    ) {
      diverged.push('cost');
    }
    const result: UsageAuditResult = {
      profile: profile.id,
      sinceDay,
      untilDay,
      ccusage,
      signals,
      diverged,
    };
    this.#tell(result);
    return result;
  }

  #tell(result: UsageAuditResult): void {
    if (result.diverged.length === 0) {
      this.#diverging.delete(result.profile);
      return;
    }
    if (this.#diverging.has(result.profile)) return;
    this.#diverging.add(result.profile);
    const { ccusage, signals } = result;
    const parts = [
      `${result.sinceDay}..${result.untilDay}`,
      `tokens ccusage ${String(ccusage.tokens)} vs signals ${String(signals.tokens)} (${pct(ccusage.tokens, signals.tokens)}% apart)`,
    ];
    if (result.diverged.includes('cost')) {
      parts.push(
        `cost ccusage ${String(ccusage.costUsd)} vs signals ${String(signals.costUsd)} US$`,
      );
    }
    const detail = parts.join('; ');
    this.#o.logger.warn(
      { profile: result.profile, diverged: result.diverged, ccusage, signals },
      `ccusage and the signals disagree on a profile: ${detail}`,
    );
    this.#o.situations?.record('usage.notice', {
      kind: 'ccusage_divergence',
      sessionId: null,
      profile: result.profile,
      ...detailOf(detail),
    });
  }

  async #loop(): Promise<void> {
    const { clock, settings, logger } = this.#o;
    for (;;) {
      if (this.#abort.signal.aborted) return;
      try {
        await this.compareAll();
      } catch (error) {
        logger.warn({ err: situationText(error, 200) }, 'ccusage check: a comparison failed');
      }
      if (settings.intervalMs <= 0) return;
      try {
        await clock.sleep(settings.intervalMs, this.#abort.signal);
      } catch {
        return;
      }
    }
  }
}

function detailOf(text: string | null | undefined): { detail?: string } {
  const masked = text === null || text === undefined ? null : situationText(text);
  return masked === null ? {} : { detail: masked };
}
