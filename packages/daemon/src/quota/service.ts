// SPDX-License-Identifier: MPL-2.0
import {
  formatProfileId,
  hasErrorCode,
  parseProfileId,
  QuotaReadingSchema,
  type Clock,
  type Disposable,
  type NewQuotaSnapshot,
  type NormalizedUpdate,
  type ProfileRef,
  type QuotaProbe,
  type QuotaReading,
  type Store,
} from '@otheater/core';
import {
  buildDaemonEvent,
  QUOTA_EXHAUSTED_CODE,
  quotaExhaustedDataSchema,
  quotaSignalParamsSchema,
  type QuotaCause,
  type QuotaSignal,
  type QuotaState,
} from '@otheater/protocol';
import type { Logger } from '../logger.js';
import { TRACKED_PROFILE } from '../recovery/tracking-launcher.js';
import type { QuotaSettings } from './settings.js';
import { authorizes, evaluateQuota, hitWindowOf, signatureOf, type QuotaStatus } from './state.js';

/** The longest the watcher sleeps, so a clock jump is noticed within the hour. [proposta] */
export const QUOTA_WATCH_MAX_SLEEP_MS = 3_600_000;

/** The shortest it sleeps, so a boundary that is already past cannot make the loop spin. */
export const QUOTA_WATCH_MIN_SLEEP_MS = 1000;

/** A profile as the callers name it: the complete id `<client>/<profile>`, or the pair. */
export type ProfileTarget = string | ProfileRef;

export interface QuotaServiceOptions {
  readonly store: Pick<Store, 'events' | 'quotaSnapshots' | 'sessions'>;
  readonly clock: Clock;
  readonly settings: QuotaSettings;
  readonly logger: Logger;
}

/** What a limit error says: when the quota comes back (if some source says), and who said it. */
export interface LimitHit {
  /** Epoch ms, or the text the signal carries (an ISO date, or epoch seconds or milliseconds). */
  readonly resetsAt?: number | string | undefined;
  readonly source: string;
  /** `quota` (default): the plan window; `budget`: the spending cap of an API key. */
  readonly cause?: QuotaCause | undefined;
}

/** What the service remembers of the last state it announced for a profile. */
interface Announced {
  readonly signature: string;
  readonly state: QuotaState;
  readonly cause: QuotaCause | null;
  readonly untilReset: number | null;
}

/**
 * A reset time as a signal writes it: an ISO date, or a number (epoch seconds below 10^12,
 * milliseconds above). `null` when there is none or it cannot be read. [N] The text the real
 * clients send was not measured.
 */
export function parseResetsAt(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const fromNumber = (n: number): number | null =>
    Number.isFinite(n) && n > 0 ? Math.round(n < 1e12 ? n * 1000 : n) : null;
  if (typeof value === 'number') return fromNumber(value);
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+(\.\d+)?$/.test(text)) return fromNumber(Number(text));
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Reads a limit error: the `-32001` of the agent shells, a normalized error, or a `QuotaExhausted`. */
export function limitHitOf(error: unknown): LimitHit | undefined {
  if (hasErrorCode(error, 'QUOTA_EXHAUSTED')) return { source: 'error:QuotaExhausted' };
  if (typeof error !== 'object' || error === null) return undefined;
  const fields = error as { kind?: unknown; code?: unknown; resetsAt?: unknown; data?: unknown };
  if (fields.kind === 'quota_exhausted') {
    return {
      source: 'error:quota_exhausted',
      ...(typeof fields.resetsAt === 'number' ? { resetsAt: fields.resetsAt } : {}),
    };
  }
  if (fields.code === QUOTA_EXHAUSTED_CODE) {
    const data = quotaExhaustedDataSchema.safeParse(fields.data);
    return {
      source: `error:${String(QUOTA_EXHAUSTED_CODE)}`,
      ...(data.success && data.data.resetsAt !== undefined ? { resetsAt: data.data.resetsAt } : {}),
    };
  }
  return undefined;
}

/**
 * The quota of the profiles (architecture 5.6, 5.18; P5). One manager in the daemon that:
 * - takes the readings of the probes (`read` on a timer, `watch` when the probe pushes; see
 *   `quota.probe.delivery`), the quota signals of the sessions and the limit errors, ties each
 *   signal to its profile by the session, and writes everything to `quota_snapshots`;
 * - keeps the state of each profile (`ok`, `near_limit`, `exhausted`, `unknown`) as a pure
 *   function of those rows and the clock (`evaluateQuota`), so a restart gets the same answer;
 * - never lets an old reading authorize a route (`canUse`), and counts a missing window as
 *   `unknown`;
 * - writes `quota.updated`, `quota.near_limit`, `quota.exhausted` and `quota.restored` as the
 *   state moves, including the moves the clock makes alone (a reset, a stale reading): a watcher
 *   wakes the service at the next boundary, and a restart settles what it missed.
 *
 * The selection that uses it (P15) and the real probes (P6 to P8) are not here.
 */
export class QuotaService {
  readonly #options: QuotaServiceOptions;
  readonly #probes = new Map<string, QuotaProbe>();
  readonly #tracked = new Map<string, ProfileRef>();
  readonly #watching = new Map<string, Disposable>();
  readonly #bound = new Map<string, string>();
  readonly #announced = new Map<string, Announced>();
  readonly #planTypes = new Map<string, string>();
  readonly #stop = new AbortController();
  #wake = new AbortController();
  #queue: Promise<unknown> = Promise.resolve();
  #loops: Promise<void>[] = [];
  #started = false;

  constructor(options: QuotaServiceOptions) {
    this.#options = options;
  }

  get #now(): number {
    return this.#options.clock.now();
  }

  #isStopped(): boolean {
    return this.#stop.signal.aborted;
  }

  // ---- what the daemon tells it ----

  /** The probe of a client (`ClientAdapter.quota`). A client has one; the last call wins. */
  addProbe(clientId: string, probe: QuotaProbe): void {
    this.#probes.set(clientId, probe);
    if (!this.#started) return;
    for (const ref of this.#tracked.values()) {
      if (ref.client === clientId) this.#startProbing(ref);
    }
  }

  /** Starts to read the quota of a profile (it is known to the daemon). Idempotent. */
  track(target: ProfileTarget): void {
    const ref = refOf(target);
    const id = formatProfileId(ref);
    if (this.#tracked.has(id)) return;
    this.#tracked.set(id, ref);
    if (this.#started) this.#startProbing(ref);
  }

  /**
   * Ties a session (its id, or the id the client gave it) to a profile, so the signals it sends
   * count for that profile. [proposta] The pool binds a session when it opens one (P15); until
   * then the service falls back to the `sessions` row of the store (`client` and `profile`).
   */
  bindSession(sessionId: string, target: ProfileTarget): void {
    this.#bound.set(sessionId, formatProfileId(refOf(target)));
    this.track(target);
  }

  unbindSession(sessionId: string): void {
    this.#bound.delete(sessionId);
  }

  // ---- what the sessions and the probes tell it ----

  /**
   * The params of a `_otheater/quota/signal` notification. Resolves `false` when they are not a
   * valid signal, or the session belongs to no known profile; it never throws for those.
   */
  async ingestNotification(params: unknown): Promise<boolean> {
    const parsed = quotaSignalParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.#options.logger.warn(
        { issues: parsed.error.issues.length },
        'a quota signal was not valid; ignored',
      );
      return false;
    }
    return this.ingestSignal(parsed.data.sessionId, parsed.data.signal);
  }

  /** A quota signal of a session: a window, a usage (no effect on the state yet) or a limit hit. */
  async ingestSignal(sessionId: string, signal: QuotaSignal): Promise<boolean> {
    const profile = await this.#profileOfSession(sessionId);
    if (profile === undefined) {
      this.#options.logger.warn(
        { sessionId },
        'a quota signal came from a session with no profile',
      );
      return false;
    }
    if (signal.kind === 'usage') {
      // [proposta] Tokens and cost do not move the state; the spending cap (cause `budget`) is fed
      // by whoever knows the cap, through `ingestLimitHit`.
      return true;
    }
    if (signal.kind === 'limit_hit') {
      await this.ingestLimitHit(profile, {
        source: `limit_hit:${signal.source}`,
        resetsAt: signal.resetsAt,
      });
      return true;
    }
    if (signal.usedPercent < 0) return false;
    await this.#record(
      profile,
      [
        {
          profileId: profile,
          window: signal.window,
          usedPercent: signal.usedPercent,
          resetsAt: parseResetsAt(signal.resetsAt),
          source: 'client_signal',
          observedAt: this.#now,
        },
      ],
      'client_signal',
    );
    return true;
  }

  /** A `rate_limit` update of the normalized stream of a session (the `-32001`-free path). */
  async ingestUpdate(sessionId: string, update: NormalizedUpdate): Promise<boolean> {
    if (update.kind !== 'rate_limit') return false;
    const profile = await this.#profileOfSession(sessionId);
    if (profile === undefined) return false;
    const resetsAt = update.resetsAt ?? undefined;
    if (update.status === 'rejected') {
      await this.ingestLimitHit(profile, { source: 'limit_hit:rate_limit', resetsAt });
      return true;
    }
    if (update.window === undefined || update.usedPercent === undefined) return false;
    await this.#record(
      profile,
      [
        {
          profileId: profile,
          window: update.window,
          usedPercent: update.usedPercent,
          resetsAt: parseResetsAt(resetsAt),
          source: 'client_signal',
          observedAt: this.#now,
        },
      ],
      'client_signal',
    );
    return true;
  }

  /**
   * The error a prompt failed with (the `-32001` code, a `quota_exhausted` normalized error or a
   * `QuotaExhausted`). Resolves `true` when it was a limit error and was taken in; any other error
   * is not the quota's business and gives `false`.
   */
  async ingestError(sessionId: string, error: unknown): Promise<boolean> {
    const hit = limitHitOf(error);
    if (hit === undefined) return false;
    const profile = await this.#profileOfSession(sessionId);
    if (profile === undefined) {
      this.#options.logger.warn({ sessionId }, 'a limit error came from a session with no profile');
      return false;
    }
    await this.ingestLimitHit(profile, hit);
    return true;
  }

  /**
   * A limit that was hit. With a reset time the profile is `exhausted` until then; without one it
   * stays `exhausted` until a fresh reading with room says otherwise (P9 re-queries it).
   */
  async ingestLimitHit(target: ProfileTarget, hit: LimitHit): Promise<QuotaStatus> {
    const profile = formatProfileId(refOf(target));
    const cause = hit.cause ?? 'quota';
    const window = hitWindowOf(cause);
    return this.#exclusive(async () => {
      const now = this.#now;
      let resetsAt = parseResetsAt(hit.resetsAt);
      if (resetsAt === null) {
        // The hit that told the time and the one that did not are the same limit: keep the time.
        const before = await this.#options.store.quotaSnapshots.get(profile, window);
        if (before?.resetsAt != null && before.resetsAt > now) resetsAt = before.resetsAt;
      }
      await this.#options.store.quotaSnapshots.put({
        profileId: profile,
        window,
        usedPercent: 100,
        resetsAt,
        source: hit.source,
        observedAt: now,
      });
      this.#poke();
      return this.#settle(profile, hit.source);
    });
  }

  /** A reading of a probe (`read` or `watch`). One that does not fit the schema is dropped. */
  async ingestReading(
    target: ProfileTarget,
    reading: QuotaReading,
    source = 'probe',
  ): Promise<QuotaStatus> {
    const profile = formatProfileId(refOf(target));
    const parsed = QuotaReadingSchema.safeParse(reading);
    if (!parsed.success) {
      this.#options.logger.warn({ profile }, 'a probe gave a reading that does not fit; dropped');
      return this.statusOf(profile);
    }
    const { windows, observedAt, planType } = parsed.data;
    if (planType !== undefined) this.#planTypes.set(profile, planType);
    return this.#record(
      profile,
      windows.map((w) => ({
        profileId: profile,
        window: w.window,
        usedPercent: w.usedPercent,
        resetsAt: w.resetsAt ?? null,
        source,
        observedAt,
      })),
      source,
    );
  }

  /**
   * Reads the probe of the profile now. A probe that cannot answer (no source yet, a transient
   * failure) leaves the state alone: the stored readings simply get older.
   */
  async refresh(target: ProfileTarget): Promise<QuotaStatus> {
    const ref = refOf(target);
    const profile = formatProfileId(ref);
    const probe = this.#probes.get(ref.client);
    if (probe === undefined) return this.statusOf(profile);
    let reading: QuotaReading;
    try {
      reading = await probe.read(ref);
    } catch (error) {
      this.#options.logger.debug({ err: error, profile }, 'the quota probe could not read');
      return this.statusOf(profile);
    }
    return this.ingestReading(profile, reading, 'probe');
  }

  // ---- what the selection asks ----

  /** The state of the profile now. Settles it first, so a reset or a stale reading shows. */
  statusOf(target: ProfileTarget): Promise<QuotaStatus> {
    const profile = formatProfileId(refOf(target));
    return this.#exclusive(() => this.#settle(profile, 'time'));
  }

  /**
   * Whether a route may use the profile: `ok` and `near_limit` may. `unknown` may not, and neither
   * may `exhausted`; a stale reading never authorizes, and a window with no reading is `unknown`.
   */
  async canUse(target: ProfileTarget): Promise<boolean> {
    return authorizes(await this.statusOf(target));
  }

  /**
   * Brings every profile up to the clock: what ended (a reset) or went stale since the last look
   * gets its event. Safe to call at any time.
   */
  sync(): Promise<void> {
    return this.#exclusive(() => this.#sync());
  }

  // ---- life ----

  /**
   * Settles what happened while the daemon was stopped (a limit that ended gets its
   * `quota.restored`), then starts the probes and the watcher. Resolves once the catch-up is done.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#exclusive(() => this.#catchUp());
    for (const ref of this.#tracked.values()) this.#startProbing(ref);
    this.#loops.push(this.#guard('watcher', () => this.#watch()));
    if (this.#options.settings.delivery !== 'push') {
      this.#loops.push(this.#guard('poller', () => this.#poll()));
    }
  }

  async stop(): Promise<void> {
    this.#stop.abort(new Error('quota service stopped'));
    for (const watching of this.#watching.values()) {
      try {
        watching.dispose();
      } catch (error) {
        this.#options.logger.warn({ err: error }, 'a quota probe did not stop watching cleanly');
      }
    }
    this.#watching.clear();
    await Promise.all(this.#loops);
    await this.#queue;
  }

  // ---- inside the queue ----

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #poke(): void {
    this.#wake.abort(new Error('woken'));
    this.#wake = new AbortController();
  }

  #guard(name: string, loop: () => Promise<void>): Promise<void> {
    return loop().catch((error: unknown) => {
      this.#options.logger.error({ err: error }, `the quota ${name} stopped by itself`);
    });
  }

  /** Writes rows of one profile, then settles it. */
  #record(
    profile: string,
    rows: readonly NewQuotaSnapshot[],
    source: string,
  ): Promise<QuotaStatus> {
    return this.#exclusive(async () => {
      for (const row of rows) await this.#options.store.quotaSnapshots.put(row);
      this.#poke();
      return this.#settle(profile, source);
    });
  }

  #expectedWindows(profile: string): readonly string[] {
    const probe = this.#probes.get(parseProfileId(profile).client);
    if (probe === undefined) return [];
    try {
      return probe.capabilities().windows;
    } catch {
      return [];
    }
  }

  async #statusNow(profile: string): Promise<QuotaStatus> {
    const rows = await this.#options.store.quotaSnapshots.list({ profileId: profile });
    return evaluateQuota(profile, rows, this.#now, {
      nearLimitAt: this.#options.settings.nearLimitAt,
      staleAfterMs: this.#options.settings.staleAfterMs,
      expectedWindows: this.#expectedWindows(profile),
    });
  }

  /**
   * Computes the state of a profile and writes the events its change calls for: `quota.updated`
   * when the readings or the state changed, then `near_limit`, `exhausted` or `restored` for the
   * crossing.
   */
  async #settle(profile: string, source: string): Promise<QuotaStatus> {
    const status = await this.#statusNow(profile);
    const before = this.#announced.get(profile);
    const signature = signatureOf(status);
    if (before?.signature === signature) return status;
    this.#announced.set(profile, {
      signature,
      state: status.state,
      cause: status.cause,
      untilReset: status.untilReset,
    });
    // A profile nobody has read yet is not news.
    if (before === undefined && status.windows.length === 0 && status.state === 'unknown') {
      return status;
    }
    await this.#announce(profile, status, before, source);
    return status;
  }

  async #announce(
    profile: string,
    status: QuotaStatus,
    before: Announced | undefined,
    source: string,
  ): Promise<void> {
    const { events } = this.#options.store;
    const planType = this.#planTypes.get(profile);
    await events.append(
      buildDaemonEvent('quota.updated', {
        profile,
        state: status.state,
        source,
        windows: status.windows.map((w) => ({
          window: w.window,
          usedPercent: w.usedPercent,
          resetsAt: w.resetsAt,
          observedAt: w.observedAt,
        })),
        ...(planType === undefined ? {} : { planType }),
      }),
    );
    const was = before?.state;
    const near = status.nearLimitWindow;
    if (status.state === 'near_limit' && was !== 'near_limit' && near !== null) {
      await events.append(
        buildDaemonEvent('quota.near_limit', {
          profile,
          window: near.window,
          usedPercent: near.usedPercent,
          resetsAt: near.resetsAt,
          thresholdPercent: this.#options.settings.nearLimitAt * 100,
        }),
      );
    }
    if (
      status.state === 'exhausted' &&
      status.cause !== null &&
      (was !== 'exhausted' ||
        before?.cause !== status.cause ||
        before.untilReset !== status.untilReset)
    ) {
      await events.append(
        buildDaemonEvent('quota.exhausted', {
          profile,
          cause: status.cause,
          untilReset: status.untilReset,
          source,
        }),
      );
    }
    if (was === 'exhausted' && status.state !== 'exhausted' && before !== undefined) {
      const timeCame = before.untilReset !== null && this.#now >= before.untilReset;
      await events.append(
        buildDaemonEvent('quota.restored', {
          profile,
          cause: before.cause ?? 'quota',
          state: status.state,
          reason: timeCame ? 'reset' : 'reading',
        }),
      );
    }
  }

  async #sync(): Promise<void> {
    const rows = await this.#options.store.quotaSnapshots.list();
    const profiles = new Set<string>([...rows.map((r) => r.profileId), ...this.#announced.keys()]);
    for (const profile of profiles) {
      await this.#settle(profile, 'time');
    }
  }

  /**
   * On start: what the log says is still exhausted is the previous state of that profile, so a
   * limit that ended while the daemon was down gets its `quota.restored`, and one that goes on
   * does not announce itself again. Every other profile is taken as it is, in silence.
   */
  async #catchUp(): Promise<void> {
    const { events, quotaSnapshots } = this.#options.store;
    const open = new Map<string, { cause: QuotaCause; untilReset: number | null }>();
    let after = 0;
    for (;;) {
      const batch = await events.readFrom(after, 500);
      if (batch.length === 0) break;
      for (const event of batch) {
        after = event.id;
        if (event.type === 'quota.exhausted') {
          const { profile, cause, untilReset } = event.payload;
          if (typeof profile === 'string' && (cause === 'quota' || cause === 'budget')) {
            open.set(profile, {
              cause,
              untilReset: typeof untilReset === 'number' ? untilReset : null,
            });
          }
        } else if (event.type === 'quota.restored' && typeof event.payload.profile === 'string') {
          open.delete(event.payload.profile);
        }
      }
    }
    const rows = await quotaSnapshots.list();
    const profiles = new Set<string>([...rows.map((r) => r.profileId), ...open.keys()]);
    for (const profile of profiles) {
      let ref: ProfileRef;
      try {
        ref = parseProfileId(profile);
      } catch {
        continue;
      }
      this.#tracked.set(profile, ref);
      const status = await this.#statusNow(profile);
      const exhausted = open.get(profile);
      // Still the same limit: nothing to say. Another one, or none: the settle below says it.
      const same =
        exhausted === undefined ||
        (status.state === 'exhausted' &&
          status.cause === exhausted.cause &&
          status.untilReset === exhausted.untilReset);
      this.#announced.set(profile, {
        signature: same ? signatureOf(status) : '',
        state: exhausted === undefined ? status.state : 'exhausted',
        cause: exhausted?.cause ?? status.cause,
        untilReset: exhausted === undefined ? status.untilReset : exhausted.untilReset,
      });
      if (exhausted !== undefined) await this.#settle(profile, 'time');
    }
  }

  // ---- the probes ----

  /** Starts to take the readings of one profile, as `quota.probe.delivery` says. */
  #startProbing(ref: ProfileRef): void {
    if (this.#isStopped()) return;
    const probe = this.#probes.get(ref.client);
    if (probe === undefined) return;
    const { delivery } = this.#options.settings;
    const id = formatProfileId(ref);
    if (delivery !== 'poll' && !this.#watching.has(id)) {
      if (probe.watch === undefined) {
        if (delivery === 'push') {
          this.#options.logger.warn(
            { profile: id },
            'quota.probe.delivery is "push" but this probe cannot watch; it is not used',
          );
        }
      } else {
        try {
          this.#watching.set(
            id,
            probe.watch(ref, (reading) => {
              this.ingestReading(id, reading, 'probe').catch((error: unknown) => {
                this.#options.logger.warn({ err: error, profile: id }, 'a pushed reading failed');
              });
            }),
          );
        } catch (error) {
          this.#options.logger.warn({ err: error, profile: id }, 'a quota probe could not watch');
        }
      }
    }
    if (delivery !== 'push') {
      void this.refresh(ref).catch((error: unknown) => {
        this.#options.logger.warn({ err: error, profile: id }, 'the first quota read failed');
      });
    }
  }

  /** Reads every tracked profile on a timer (`quota.probe.delivery` `poll` or `both`). */
  async #poll(): Promise<void> {
    const { clock, settings } = this.#options;
    while (!this.#isStopped()) {
      try {
        await clock.sleep(settings.pollEveryMs, this.#stop.signal);
      } catch (error) {
        if (!hasErrorCode(error, 'CANCELLED')) throw error;
        return;
      }
      await Promise.all(
        [...this.#tracked.values()].map((ref) =>
          this.refresh(ref).catch((error: unknown) => {
            this.#options.logger.warn({ err: error }, 'a quota read failed');
          }),
        ),
      );
    }
  }

  // ---- the clock ----

  async #watch(): Promise<void> {
    const { clock } = this.#options;
    while (!this.#isStopped()) {
      const wake = this.#wake.signal;
      const wait = await this.#nextWait();
      try {
        await clock.sleep(wait, AbortSignal.any([this.#stop.signal, wake]));
      } catch (error) {
        if (!hasErrorCode(error, 'CANCELLED')) throw error;
        if (this.#isStopped()) return;
        continue;
      }
      try {
        await this.sync();
      } catch (error) {
        this.#options.logger.error({ err: error }, 'the quota watcher could not sync');
        await clock.sleep(QUOTA_WATCH_MAX_SLEEP_MS, this.#stop.signal).catch(() => undefined);
      }
    }
  }

  /** Until the next instant a stored reading changes meaning: a reset, or the end of its freshness. */
  async #nextWait(): Promise<number> {
    const now = this.#now;
    const rows = await this.#options.store.quotaSnapshots.list();
    let next = now + QUOTA_WATCH_MAX_SLEEP_MS;
    for (const row of rows) {
      const staleAt = row.observedAt + this.#options.settings.staleAfterMs + 1;
      for (const boundary of [row.resetsAt, staleAt]) {
        if (boundary !== null && boundary > now && boundary < next) next = boundary;
      }
    }
    return Math.max(QUOTA_WATCH_MIN_SLEEP_MS, next - now);
  }

  // ---- sessions ----

  /** The profile a session belongs to: the one it was bound to, else the `sessions` row. */
  async #profileOfSession(sessionId: string): Promise<string | undefined> {
    const bound = this.#bound.get(sessionId);
    if (bound !== undefined) return bound;
    const { sessions } = this.#options.store;
    try {
      const row =
        (await sessions.get(sessionId)) ??
        (await sessions.list()).find((r) => r.clientSessionId === sessionId);
      if (row === undefined || row.profile === TRACKED_PROFILE) return undefined;
      const id = row.profile.includes('/') ? row.profile : `${row.client}/${row.profile}`;
      parseProfileId(id);
      return id;
    } catch {
      return undefined;
    }
  }
}

function refOf(target: ProfileTarget): ProfileRef {
  return typeof target === 'string' ? parseProfileId(target) : target;
}
