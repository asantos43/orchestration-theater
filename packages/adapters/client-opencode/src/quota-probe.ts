// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  QUOTA_PROBE_PORT_VERSION,
  formatProfileId,
  type AdapterImplements,
  type Clock,
  type Disposable,
  type NormalizedUpdate,
  type ProfileRef,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';

/** The usage update a session emits; what the ledger adds up. */
export type OpenCodeUsage = Extract<NormalizedUpdate, { kind: 'usage' }>;

/** The window names of the ledger. They are the daemon's own accounts, not a provider's windows. */
export const LEDGER_WINDOW_TOKENS = 'ledger_tokens';
export const LEDGER_WINDOW_USD = 'ledger_usd';

/** The most events the ledger keeps per profile; past it the oldest go (a bound on memory). */
const MAX_EVENTS = 20_000;
/** The most (profile, session) cost marks kept; past it the oldest go. */
const MAX_SESSION_MARKS = 5000;

export interface OpenCodeLedgerOptions {
  readonly clock: Pick<Clock, 'now'>;
  /** The length of the rolling window, in ms. */
  readonly windowMs: number;
  /** Tokens (input plus output) the window may hold before it counts as full; `null`: no such limit. */
  readonly limitTokens: number | null;
  /** Dollars the window may hold; `null`: no such limit. */
  readonly limitUsd: number | null;
}

interface LedgerEvent {
  readonly at: number;
  readonly tokens: number;
  readonly usd: number;
}

interface Watcher {
  readonly onChange: (reading: QuotaReading) => void;
  lastKey: string;
}

/**
 * The quota probe of OpenCode (P8, architecture 5.6). OpenCode has no quota of its own: the limit
 * belongs to the provider behind the model, and the one source Phase 0 found is the `cost` of
 * `usage_update` [V], which is spending, not a window. So this probe is LOCAL ACCOUNTING: it adds
 * up the usage events the daemon hands it (`recordUsage`, fed by the sessions of the profile) in a
 * rolling window, and compares the sum with limits the OWNER configures
 * (`quota.opencode.limit_tokens`, `quota.opencode.limit_usd`). It reads no file of OpenCode: not
 * its database, not its auth file (the owner's rule).
 *
 * What it is, so nobody trusts it too far:
 * - [proposta] The ledger sees only the sessions of THIS daemon, since it started: it is in
 *   memory, so a restart zeroes it, and use of the same account outside the daemon is invisible.
 *   Its precision is `approximate`.
 * - [proposta] The tokens are the input plus the output of each usage update (an update is taken
 *   as incremental); the cost is taken as CUMULATIVE per session (the `cost` of `usage_update`
 *   is [V] cumulative), so each update adds the difference from the last one of that session.
 * - [proposta] A rolling window: `resetsAt` is the instant the oldest event leaves it, the first
 *   moment room opens, not a full reset.
 * - With no limit configured the probe has nothing to compare with: no windows, and `read`
 *   refuses, exactly as before this step.
 *
 * `watch` pushes a reading only when the whole percentage of a window changes, so a long session
 * does not write a snapshot per token.
 */
export class OpenCodeQuotaProbe implements QuotaProbe {
  readonly id = 'opencode-quota';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };
  readonly #ledger: OpenCodeLedgerOptions | undefined;
  readonly #events = new Map<string, LedgerEvent[]>();
  readonly #marks = new Map<string, number>();
  readonly #watchers = new Map<string, Set<Watcher>>();

  constructor(ledger?: OpenCodeLedgerOptions) {
    const on = ledger !== undefined && (ledger.limitTokens !== null || ledger.limitUsd !== null);
    this.#ledger = on ? ledger : undefined;
  }

  /** The windows it can report: one per configured limit, none without a limit. */
  capabilities(): QuotaCapabilities {
    const windows: string[] = [];
    if (this.#ledger?.limitTokens != null) windows.push(LEDGER_WINDOW_TOKENS);
    if (this.#ledger?.limitUsd != null) windows.push(LEDGER_WINDOW_USD);
    return {
      windows,
      delivery: this.#ledger === undefined ? 'poll' : 'both',
      precision: 'approximate',
    };
  }

  /**
   * Adds one usage update of a session of `profile` to the ledger. Never throws: a malformed
   * number is skipped. Synchronous, so the sum is right the moment it returns.
   */
  recordUsage(profile: ProfileRef, sessionId: string, usage: OpenCodeUsage): void {
    const ledger = this.#ledger;
    if (ledger === undefined) return;
    const id = formatProfileId(profile);
    const tokens = nonNegative(usage.inputTokens) + nonNegative(usage.outputTokens);
    let usd = 0;
    if (usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
      const mark = `${id}\u0000${sessionId}`;
      const last = this.#marks.get(mark);
      // A cost below the last mark is a session that started over: count it whole.
      usd = last === undefined || usage.costUsd < last ? usage.costUsd : usage.costUsd - last;
      this.#marks.delete(mark);
      this.#marks.set(mark, usage.costUsd);
      if (this.#marks.size > MAX_SESSION_MARKS) {
        const oldest = this.#marks.keys().next();
        if (oldest.done !== true) this.#marks.delete(oldest.value);
      }
    }
    if (tokens === 0 && usd === 0) return;
    const now = ledger.clock.now();
    const events = this.#events.get(id) ?? [];
    events.push({ at: now, tokens, usd });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    this.#events.set(id, events);
    this.#notify(id, profile);
  }

  read(profile: ProfileRef): Promise<QuotaReading> {
    if (this.#ledger === undefined) {
      return Promise.reject(
        new AdapterUnavailable(
          `no usage ledger configured for the OpenCode quota (no reading for ${profile.client}/${profile.profile})`,
        ),
      );
    }
    return Promise.resolve(this.#reading(profile));
  }

  watch(profile: ProfileRef, onChange: (reading: QuotaReading) => void): Disposable {
    const id = formatProfileId(profile);
    const watcher: Watcher = { onChange, lastKey: this.#keyOf(this.#reading(profile)) };
    const set = this.#watchers.get(id) ?? new Set<Watcher>();
    set.add(watcher);
    this.#watchers.set(id, set);
    return {
      dispose: () => {
        set.delete(watcher);
        if (set.size === 0) this.#watchers.delete(id);
      },
    };
  }

  #reading(profile: ProfileRef): QuotaReading {
    const ledger = this.#ledger;
    if (ledger === undefined) return { observedAt: 0, windows: [] };
    const id = formatProfileId(profile);
    const now = ledger.clock.now();
    const cutoff = now - ledger.windowMs;
    const kept = (this.#events.get(id) ?? []).filter((event) => event.at > cutoff);
    if (kept.length === 0) this.#events.delete(id);
    else this.#events.set(id, kept);
    const oldest = kept[0]?.at;
    const resetsAt = oldest === undefined ? undefined : oldest + ledger.windowMs;
    const windows: QuotaReading['windows'][number][] = [];
    const add = (window: string, sum: number, limit: number | null): void => {
      if (limit === null) return;
      windows.push({
        window,
        usedPercent: Math.round((sum / limit) * 10_000) / 100,
        ...(resetsAt === undefined ? {} : { resetsAt }),
      });
    };
    add(
      LEDGER_WINDOW_TOKENS,
      kept.reduce((sum, event) => sum + event.tokens, 0),
      ledger.limitTokens,
    );
    add(
      LEDGER_WINDOW_USD,
      kept.reduce((sum, event) => sum + event.usd, 0),
      ledger.limitUsd,
    );
    return { observedAt: now, windows };
  }

  #keyOf(reading: QuotaReading): string {
    return reading.windows.map((w) => `${w.window}=${String(Math.floor(w.usedPercent))}`).join('|');
  }

  #notify(id: string, profile: ProfileRef): void {
    const watchers = this.#watchers.get(id);
    if (watchers === undefined || watchers.size === 0) return;
    const reading = this.#reading(profile);
    const key = this.#keyOf(reading);
    for (const watcher of [...watchers]) {
      if (watcher.lastKey === key) continue;
      watcher.lastKey = key;
      try {
        watcher.onChange(reading);
      } catch {
        // A listener that fails must not break the session that was being counted.
      }
    }
  }
}

function nonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}
