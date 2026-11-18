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
import type { SituationSink } from '../situations.js';
import { recordProbeFailed, recordSignalDropped } from './notices.js';
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
  /**
   * Where a signal that was dropped and a probe that failed are also written as events
   * (`quota.signal_dropped`, `quota.probe_failed`; P24, N146). Without it only the log tells.
   */
  readonly situations?: SituationSink | undefined;
}

/** What a limit error says: when the quota comes back (if some source says), and who said it. */
export interface LimitHit {
  /** Epoch ms, or the text the signal carries (an ISO date, or epoch seconds or milliseconds). */
  readonly resetsAt?: number | string | undefined;
  readonly source: string;
  /** `quota` (default): the plan window; `budget`: the spending cap of an API key. */
  readonly cause?: QuotaCause | undefined;
}

/** The source a recheck of P9 gives its readings and its release of a limit (`quota.restored.reason`). */
export const RECHECK_SOURCE = 'recheck';

/**
 * The source a release of a spending cap gives its readings when the configuration changed
 * (P11b, `budget.on_cap_change: release`): it is `budget.restored.reason` `config`.
 */
export const CONFIG_SOURCE = 'config';

/** What a listener hears when a profile's announced state changes (P9 uses it for its wakeups). */
export interface QuotaChange {
  /** Complete id `<client>/<profile>`. */
  readonly profile: string;
  readonly status: QuotaStatus;
  /** What was announced before; `undefined` the first time. */
  readonly before: Pick<Announced, 'state' | 'cause' | 'untilReset'> | undefined;
  readonly source: string;
}

export type QuotaChangeListener = (change: QuotaChange) => void;
/** The `usage` update of the normalized stream of a session. */
export type UsageUpdate = Extract<NormalizedUpdate, { kind: 'usage' }>;

/**
 * Optional, duck-typed on a probe (P8): a probe that counts consumption itself (the local ledger of
 * OpenCode, which has no quota API) takes the `usage` updates of the sessions of its client here.
 * Synchronous and cheap: it only writes down what it was told; the reading comes from `read` or
 * from `watch`. [proposta]
 */
export interface UsageSink {
  recordUsage(profile: ProfileRef, sessionId: string, usage: UsageUpdate): void;
}

/**
 * Optional, duck-typed on a probe (P8): a client whose profiles are not all read the same way (the
 * profiles of OpenCode with a MiniMax key and the ones with another provider) names the windows
 * each profile reports, so a profile is not left `unknown` for a window its probe never reads.
 * Without it the windows of `capabilities()` count for every profile of the client. [proposta]
 */
export interface ProfileWindows {
  windowsOf(profile: ProfileRef): readonly string[];
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

/** How deep `limitHitOf` follows the `cause` chain (typed error, normalized error, raw error). */
const LIMIT_CAUSE_DEPTH = 3;

/**
 * Reads a limit error: the `-32001` of the agent shells, a normalized error, or a `QuotaExhausted`.
 * The typed `QuotaExhausted` carries the `NormalizedError` in its `cause` (`typedErrorOf`), and that
 * one carries the raw error; the reset time and the source are read down that chain (P8). The
 * source is `limit_hit:<where>` (`429`, `message`, `structured`, `rate_limit_event`) when the
 * adapter said where the limit came from, else the shape of the error that was read.
 */
export function limitHitOf(error: unknown, depth = LIMIT_CAUSE_DEPTH): LimitHit | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const fields = error as {
    kind?: unknown;
    code?: unknown;
    resetsAt?: unknown;
    data?: unknown;
    limitSource?: unknown;
    cause?: unknown;
  };
  const inner = depth > 0 ? limitHitOf(fields.cause, depth - 1) : undefined;
  if (hasErrorCode(error, 'QUOTA_EXHAUSTED')) {
    return inner ?? { source: 'error:QuotaExhausted' };
  }
  if (fields.kind === 'quota_exhausted') {
    const known = typeof fields.limitSource === 'string' && fields.limitSource !== '';
    const resetsAt = typeof fields.resetsAt === 'number' ? fields.resetsAt : inner?.resetsAt;
    return {
      source: known ? `limit_hit:${String(fields.limitSource)}` : 'error:quota_exhausted',
      ...(resetsAt === undefined ? {} : { resetsAt }),
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
  readonly #listeners = new Set<QuotaChangeListener>();
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

  /** The probe of a client, if the daemon gave it one (P9 reads it again, without cost). */
  probeOf(clientId: string): QuotaProbe | undefined {
    return this.#probes.get(clientId);
  }

  /**
   * Hears every change of the announced state of a profile (after its events were written). The
   * listener runs inside the service's own turn: it must not call the service and wait for it, only
   * note the change and go (P9 queues its work). A listener that throws is logged and ignored.
   */
  onChange(listener: QuotaChangeListener): Disposable {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
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
      recordSignalDropped(this.#options.situations, 'invalid_signal', {
        detail: `${String(parsed.error.issues.length)} issue(s) in the signal`,
      });
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
      recordSignalDropped(this.#options.situations, 'no_profile', { sessionId });
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
    if (update.kind === 'usage') return this.ingestUsage(sessionId, update);
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
   * A `usage` update of a session (P8). It does not move the state by itself: it goes to the probe
   * of the client when that probe counts consumption (`UsageSink`), and that probe tells the
   * service the new reading. Resolves `false` when the session has no profile or its probe counts
   * nothing.
   */
  async ingestUsage(sessionId: string, usage: UsageUpdate): Promise<boolean> {
    const profile = await this.#profileOfSession(sessionId);
    if (profile === undefined) return false;
    const ref = parseProfileId(profile);
    const probe = this.#probes.get(ref.client) as Partial<UsageSink> | undefined;
    if (typeof probe?.recordUsage !== 'function') return false;
    try {
      probe.recordUsage(ref, sessionId, usage);
    } catch (error) {
      this.#options.logger.warn({ err: error, profile }, 'a quota probe could not take a usage');
      recordSignalDropped(this.#options.situations, 'usage_not_taken', {
        profile,
        sessionId,
        detail: error,
      });
      return false;
    }
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
      recordSignalDropped(this.#options.situations, 'no_profile', {
        sessionId,
        detail: 'a limit error',
      });
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

  /**
   * Lets go of a limit that no source gave an end to (P9, "Consulta sem horário"): the recheck
   * interval passed and nothing that costs no tokens said it is over or still on, so the profile
   * stops being `exhausted` and becomes what the readings say (usually `unknown`); the next real
   * session is the test. A hit that has an end, or that is not there, is left alone.
   */
  async releaseLimit(target: ProfileTarget, cause: QuotaCause): Promise<QuotaStatus> {
    const profile = formatProfileId(refOf(target));
    const window = hitWindowOf(cause);
    return this.#exclusive(async () => {
      const now = this.#now;
      const hit = await this.#options.store.quotaSnapshots.get(profile, window);
      if (hit?.resetsAt === null) {
        await this.#options.store.quotaSnapshots.put({
          profileId: profile,
          window,
          usedPercent: 100,
          resetsAt: now,
          source: RECHECK_SOURCE,
          observedAt: now,
        });
        this.#poke();
      }
      return this.#settle(profile, RECHECK_SOURCE);
    });
  }

  /**
   * Lets go of a spending-cap hit before the period ends, because the cap was raised or removed in
   * the configuration (P11b, `budget.on_cap_change: release`). The profile becomes what the other
   * readings say (usually `unknown`) and `budget.restored` says it with the reason `config`; the
   * hooks of P9 run as at any other restore. Nothing happens when the profile has no such hit.
   */
  async releaseBudgetHit(target: ProfileTarget): Promise<QuotaStatus> {
    const profile = formatProfileId(refOf(target));
    return this.#exclusive(async () => {
      const now = this.#now;
      const hit = await this.#options.store.quotaSnapshots.get(profile, hitWindowOf('budget'));
      if (hit !== undefined && (hit.resetsAt === null || hit.resetsAt > now)) {
        await this.#options.store.quotaSnapshots.put({
          profileId: profile,
          window: hitWindowOf('budget'),
          usedPercent: 100,
          resetsAt: now,
          source: CONFIG_SOURCE,
          observedAt: now,
        });
        this.#poke();
      }
      return this.#settle(profile, CONFIG_SOURCE);
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
      recordSignalDropped(this.#options.situations, 'bad_reading', {
        profile,
        detail: `${String(parsed.error.issues.length)} issue(s) in the reading from ${source}`,
      });
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
      const own = (probe as Partial<ProfileWindows>).windowsOf;
      if (typeof own === 'function') return own.call(probe, parseProfileId(profile));
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
      const reason = timeCame ? 'reset' : source === RECHECK_SOURCE ? 'recheck' : 'reading';
      // The spending cap has its own name (P9): `budget.restored`, not `quota.restored`.
      if (before.cause === 'budget') {
        await events.append(
          buildDaemonEvent('budget.restored', {
            profile,
            state: status.state,
            reason: source === CONFIG_SOURCE && !timeCame ? 'config' : reason,
          }),
        );
      } else {
        await events.append(
          buildDaemonEvent('quota.restored', {
            profile,
            cause: before.cause ?? 'quota',
            state: status.state,
            reason,
          }),
        );
      }
    }
    for (const listener of this.#listeners) {
      try {
        listener({ profile, status, before, source });
      } catch (error) {
        this.#options.logger.warn({ err: error, profile }, 'a quota change listener failed');
      }
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
        } else if (
          (event.type === 'quota.restored' || event.type === 'budget.restored') &&
          typeof event.payload.profile === 'string'
        ) {
          // The spending cap has its own name for the same end (P9, P11).
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
          recordProbeFailed(this.#options.situations, id, 'push_unsupported');
        }
      } else {
        try {
          this.#watching.set(
            id,
            probe.watch(ref, (reading) => {
              this.ingestReading(id, reading, 'probe').catch((error: unknown) => {
                this.#options.logger.warn({ err: error, profile: id }, 'a pushed reading failed');
                recordSignalDropped(this.#options.situations, 'missed_update', {
                  profile: id,
                  detail: error,
                });
              });
            }),
          );
        } catch (error) {
          this.#options.logger.warn({ err: error, profile: id }, 'a quota probe could not watch');
          recordProbeFailed(this.#options.situations, id, 'watch_failed', { detail: error });
        }
      }
    }
    if (delivery !== 'push') {
      void this.refresh(ref).catch((error: unknown) => {
        this.#options.logger.warn({ err: error, profile: id }, 'the first quota read failed');
        recordProbeFailed(this.#options.situations, id, 'read_failed', { detail: error });
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
            recordProbeFailed(this.#options.situations, formatProfileId(ref), 'read_failed', {
              detail: error,
            });
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
