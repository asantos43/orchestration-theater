// SPDX-License-Identifier: MPL-2.0
import {
  Conflict,
  formatProfileId,
  hasErrorCode,
  parseProfileId,
  type Clock,
  type Disposable,
  type ProfileRef,
  type QuotaReading,
  type Store,
  type WakeupRecord,
} from '@otheater/core';
import type { QuotaCause } from '@otheater/protocol';
import type { DaemonConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { QuotaChange, QuotaService } from './service.js';
import { hitWindowOf, type QuotaStatus } from './state.js';

/**
 * Wakeups and the recheck (architecture 5.6, "Retomada quando a cota ou o teto voltam"; P9).
 *
 * When a profile is exhausted the daemon writes a wakeup (`wakeups`): the moment it must look at the
 * profile again. At that moment the profile is settled (back to `ok`, or to `unknown` while nobody
 * has read it), the service says `quota.restored` or `budget.restored`, and the hooks of whatever
 * waited for the profile run. Everything lives in the store, so a restart keeps it and what came
 * due while the daemon was stopped runs at start-up (architecture 5.21).
 */

/**
 * The `at` of a wakeup that waits for a signal and has no time: no end is known and
 * `quota.recheck_every` is `off`. [proposta] It never comes due.
 */
export const WAKEUP_NEVER = Number.MAX_SAFE_INTEGER;

/** The longest the watcher sleeps, so a clock jump is noticed within the hour. */
export const WAKEUP_WATCH_MAX_SLEEP_MS = 3_600_000;

/** The shortest it sleeps, so a moment that is already past cannot make the loop spin. */
export const WAKEUP_WATCH_MIN_SLEEP_MS = 1000;

/**
 * [proposta] A way to look at the quota of a profile that **never calls the model**: the probe of
 * the Codex, the one of the MiniMax, the last JSON of the Claude statusline. A `QuotaProbe` is one
 * (the port reads "outside any conversation", architecture 5.18), and the daemon hands them over
 * through {@link WakeupManager}'s `probes`. It rejects with `AdapterUnavailable` when there is no
 * signal for the profile (the Claude statusline before the first reply, the OpenCode), and with
 * anything else for a failure that may pass.
 */
export interface CostFreeProbe {
  read(profile: ProfileRef): Promise<QuotaReading>;
}

/** What the manager takes of the `quota` section about wakeups. */
export interface WakeupSettings {
  /** `quota.recheck_every` in ms; `null` is `off`: no profile is looked at again without a time. */
  readonly recheckEveryMs: number | null;
}

export function wakeupSettingsOf(config: Pick<DaemonConfig, 'quota'>): WakeupSettings {
  return { recheckEveryMs: config.quota.recheck_every };
}

/**
 * The things that wait for a profile to come back (architecture 5.6, steps 2 to 4). The hooks of
 * P19, P15 and the scheduler (Phase 9b) plug in here; this step only calls them.
 * - `awaiting_resume`: the attempts in `AWAITING_RESUME` that waited for the profile (P19);
 * - `queued_demands`: the demands in the queue with no Executor available go through the selection
 *   again (P15);
 * - `scheduled_tasks`: the scheduled tasks postponed by quota (`quota_exhausted: postpone`, 5.15;
 *   Phase 9b). [proposta]
 */
export const RESTORE_HOOK_KINDS = ['awaiting_resume', 'queued_demands', 'scheduled_tasks'] as const;
export type RestoreHookKind = (typeof RESTORE_HOOK_KINDS)[number];

/** What a hook is told. */
export interface RestoredProfile {
  /** Complete id `<client>/<profile>`. */
  readonly profile: string;
  /** Why it had been exhausted (more than one when both a quota and a cap were on). */
  readonly causes: readonly QuotaCause[];
  /** Where the profile stands: `unknown` means nobody has read it since, the next session tests it. */
  readonly state: QuotaStatus['state'];
  /** The wakeups this restoration settled. */
  readonly wakeupIds: readonly string[];
}

/** A hook may run more than once for the same restoration (a crash in between): keep it idempotent. */
export type RestoreHook = (restored: RestoredProfile) => Promise<void> | void;

export interface WakeupManagerOptions {
  readonly store: Pick<Store, 'wakeups' | 'quotaSnapshots'>;
  readonly clock: Clock;
  readonly quota: QuotaService;
  readonly settings: WakeupSettings;
  readonly logger: Logger;
  /** The probe that costs nothing, by client id; `undefined` is a client without one. */
  readonly probes?: (clientId: string) => CostFreeProbe | undefined;
}

/** What a look at the signals that cost nothing found. */
type FreeRead = 'none' | 'failed' | 'stale' | 'fresh';

export class WakeupManager {
  readonly #options: WakeupManagerOptions;
  readonly #hooks = new Map<RestoreHookKind, RestoreHook>();
  readonly #stop = new AbortController();
  #wake = new AbortController();
  #queue: Promise<unknown> = Promise.resolve();
  #listening: Disposable | undefined;
  #loop: Promise<void> | undefined;
  #started = false;

  constructor(options: WakeupManagerOptions) {
    this.#options = options;
  }

  get #now(): number {
    return this.#options.clock.now();
  }

  // ---- what the daemon tells it ----

  /** Plugs in what waits for a profile (one hook per kind; the last call wins). */
  setHook(kind: RestoreHookKind, hook: RestoreHook): Disposable {
    this.#hooks.set(kind, hook);
    return {
      dispose: () => {
        if (this.#hooks.get(kind) === hook) this.#hooks.delete(kind);
      },
    };
  }

  /** Whether the manager is running (after `start`, before `stop`). */
  get running(): boolean {
    return this.#started && !this.#stop.signal.aborted;
  }

  // ---- life ----

  /**
   * Settles the wakeups the store holds (those that came due while the daemon was stopped run
   * now), then listens to the quota service and starts the watcher. Call it once the hooks are in.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#listening = this.#options.quota.onChange((change) => {
      this.#onChange(change);
    });
    await this.#serial(async () => {
      const profiles = new Set<string>();
      for (const row of await this.#options.store.wakeups.list({ states: ['scheduled'] })) {
        profiles.add(row.profileId);
      }
      // An exhaustion whose wakeup the last daemon did not get to write.
      for (const row of await this.#options.store.quotaSnapshots.list()) {
        if (row.window === hitWindowOf('quota') || row.window === hitWindowOf('budget')) {
          profiles.add(row.profileId);
        }
      }
      for (const profile of profiles) await this.#reconcile(profile);
    });
    this.#loop = this.#guard(() => this.#watch());
  }

  async stop(): Promise<void> {
    this.#stop.abort(new Error('wakeup manager stopped'));
    this.#listening?.dispose();
    this.#listening = undefined;
    await this.#loop;
    await this.#queue;
  }

  /** Resolves when the work queued so far is done. For tests and for a quiet shutdown. */
  async idle(): Promise<void> {
    let seen: Promise<unknown>;
    do {
      seen = this.#queue;
      await seen;
    } while (seen !== this.#queue);
  }

  /** Looks at one profile now: writes or moves its wakeup, or settles it if it is back. */
  reconcile(target: string | ProfileRef): Promise<void> {
    const profile = typeof target === 'string' ? target : formatProfileId(target);
    return this.#serial(() => this.#reconcile(profile));
  }

  // ---- inside the queue ----

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #poke(): void {
    this.#wake.abort(new Error('woken'));
    this.#wake = new AbortController();
  }

  #guard(loop: () => Promise<void>): Promise<void> {
    return loop().catch((error: unknown) => {
      this.#options.logger.error({ err: error }, 'the wakeup watcher stopped by itself');
    });
  }

  /** A change of state of a profile: only an exhaustion that begins, moves or ends matters here. */
  #onChange(change: QuotaChange): void {
    if (!this.running) return;
    if (change.status.state !== 'exhausted' && change.before?.state !== 'exhausted') return;
    this.#serial(() => this.#reconcile(change.profile)).catch((error: unknown) => {
      this.#options.logger.error(
        { err: error, profile: change.profile },
        'a wakeup could not be settled',
      );
    });
  }

  /**
   * The whole step for a profile. While it is exhausted there is one scheduled wakeup for its
   * cause, at the end of the limit (or after the recheck interval when no end is known); when it
   * is not any more, the wakeups of the profile are settled and the hooks run.
   */
  async #reconcile(profile: string): Promise<void> {
    const { wakeups } = this.#options.store;
    let status = await this.#options.quota.statusOf(profile);
    let rows = await wakeups.list({ profileId: profile, states: ['scheduled'] });
    if (status.state === 'exhausted' && status.cause !== null) {
      const { cause } = status;
      // The state reports one cause at a time (the quota before the cap). The wakeup of the other
      // cause that came due while this one still holds is over: its limit ended, and the profile
      // goes on waiting for this one. Left `scheduled`, it would keep the watcher awake for nothing.
      for (const stale of rows.filter((r) => r.cause !== cause && r.at <= this.#now)) {
        await this.#cancel(stale);
      }
      rows = rows.filter((r) => r.cause === cause || r.at > this.#now);
      const row = rows.find((r) => r.cause === cause);
      if (status.untilReset !== null) {
        await this.#place(profile, cause, row, status.untilReset);
      } else {
        const every = this.#options.settings.recheckEveryMs;
        if (every === null) {
          await this.#place(profile, cause, row, WAKEUP_NEVER);
        } else if (row === undefined || row.at === WAKEUP_NEVER) {
          await this.#place(profile, cause, row, this.#now + every);
        } else if (row.at <= this.#now) {
          status = await this.#recheck(profile, cause, row, every);
          // This cause let go and the other one still holds: start over with that one.
          if (status.state === 'exhausted' && status.cause !== cause)
            return this.#reconcile(profile);
          rows = await wakeups.list({ profileId: profile, states: ['scheduled'] });
          // A reading that says when the limit ends gives the wakeup its time.
          if (
            status.state === 'exhausted' &&
            status.cause === cause &&
            status.untilReset !== null
          ) {
            await this.#place(
              profile,
              cause,
              rows.find((r) => r.cause === cause),
              status.untilReset,
            );
          }
        }
      }
      if (status.state === 'exhausted') return;
    }
    if (rows.length === 0) return;
    await this.#restore(profile, rows, status);
  }

  async #cancel(row: WakeupRecord): Promise<void> {
    try {
      await this.#options.store.wakeups.update(row.id, { state: 'cancelled' });
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
    }
  }

  /** Writes the wakeup of a profile and cause at `at`, or moves the one that is there. */
  async #place(
    profile: string,
    cause: QuotaCause,
    row: WakeupRecord | undefined,
    at: number,
  ): Promise<void> {
    const { wakeups } = this.#options.store;
    if (row !== undefined) {
      if (row.at !== at) await wakeups.update(row.id, { at });
    } else {
      try {
        await wakeups.create({ profileId: profile, cause, at });
      } catch (error) {
        // The unique key: there is one already (another turn wrote it); move that one.
        if (!(error instanceof Conflict)) throw error;
        const [existing] = await wakeups.list({
          profileId: profile,
          cause,
          states: ['scheduled'],
        });
        if (existing !== undefined && existing.at !== at) {
          await wakeups.update(existing.id, { at });
        }
      }
    }
    this.#poke();
  }

  /**
   * A profile exhausted with no end, and the interval came: look at the signals that cost nothing.
   * A fresh reading settles it (room: back; full: exhausted with the reset it gives). With no
   * signal at all, or one that is not newer than the limit error, the profile is let go to
   * `unknown`, and the next real session tests it. A probe that only failed is tried again later.
   */
  async #recheck(
    profile: string,
    cause: QuotaCause,
    row: WakeupRecord,
    every: number,
  ): Promise<QuotaStatus> {
    const { quota } = this.#options;
    const outcome = await this.#readFree(profile, cause);
    const next = await quota.statusOf(profile);
    // Settled by the reading, or given an end: nothing is left to guess.
    if (next.state !== 'exhausted' || next.cause !== cause || next.untilReset !== null) return next;
    if (outcome === 'none' || outcome === 'stale') return quota.releaseLimit(profile, cause);
    await this.#place(profile, cause, row, this.#now + every);
    return next;
  }

  /**
   * Reads the probe that costs nothing, if the client has one, and gives the reading to the
   * service. `fresh` is a reading taken after the limit error: it says something new.
   */
  async #readFree(profile: string, cause: QuotaCause): Promise<FreeRead> {
    const ref = parseProfileId(profile);
    const probe = this.#options.probes?.(ref.client);
    if (probe === undefined) return 'none';
    let reading: QuotaReading;
    try {
      reading = await probe.read(ref);
    } catch (error) {
      if (hasErrorCode(error, 'ADAPTER_UNAVAILABLE')) return 'none';
      this.#options.logger.debug({ err: error, profile }, 'the free quota read failed');
      return 'failed';
    }
    const hit = await this.#options.store.quotaSnapshots.get(profile, hitWindowOf(cause));
    await this.#options.quota.ingestReading(profile, reading, 'probe_recheck');
    return hit === undefined || reading.observedAt > hit.observedAt ? 'fresh' : 'stale';
  }

  /**
   * The profile is not exhausted any more: let the probe that costs nothing say how it stands (the
   * wakeup that came due has the reset behind it), run the hooks, and close the wakeups.
   * The hooks run before the wakeups are marked `fired`, so a crash in between runs them again.
   */
  async #restore(
    profile: string,
    rows: readonly WakeupRecord[],
    status: QuotaStatus,
  ): Promise<void> {
    let state = status;
    if (rows.some((row) => row.at <= this.#now) && state.state !== 'ok') {
      const first = rows[0];
      if (first !== undefined) {
        await this.#readFree(profile, first.cause);
        state = await this.#options.quota.statusOf(profile);
      }
    }
    if (state.state === 'exhausted') return;
    const restored: RestoredProfile = {
      profile,
      causes: [...new Set(rows.map((row) => row.cause))],
      state: state.state,
      wakeupIds: rows.map((row) => row.id),
    };
    for (const kind of RESTORE_HOOK_KINDS) {
      const hook = this.#hooks.get(kind);
      if (hook === undefined) continue;
      try {
        await hook(restored);
      } catch (error) {
        this.#options.logger.error({ err: error, profile, hook: kind }, 'a restore hook failed');
      }
    }
    for (const row of rows) {
      try {
        await this.#options.store.wakeups.update(row.id, { state: 'fired' });
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
    }
    this.#poke();
  }

  // ---- the clock ----

  async #watch(): Promise<void> {
    const { clock } = this.#options;
    while (!this.#stop.signal.aborted) {
      const wake = this.#wake.signal;
      const wait = await this.#nextWait();
      try {
        await clock.sleep(wait, AbortSignal.any([this.#stop.signal, wake]));
      } catch (error) {
        if (!hasErrorCode(error, 'CANCELLED')) throw error;
        continue; // stopped: the loop condition ends it; poked: look again
      }
      try {
        await this.#serial(() => this.#tick());
      } catch (error) {
        this.#options.logger.error({ err: error }, 'the wakeup watcher could not run a wakeup');
        await clock.sleep(WAKEUP_WATCH_MAX_SLEEP_MS, this.#stop.signal).catch(() => undefined);
      }
    }
  }

  /** Until the next wakeup, never more than an hour and never less than a second. */
  async #nextWait(): Promise<number> {
    const now = this.#now;
    const rows = await this.#options.store.wakeups.list({ states: ['scheduled'] });
    let next = now + WAKEUP_WATCH_MAX_SLEEP_MS;
    for (const row of rows) {
      if (row.at !== WAKEUP_NEVER && row.at < next) next = row.at;
    }
    return Math.max(WAKEUP_WATCH_MIN_SLEEP_MS, next - now);
  }

  /** The wakeups that came due. */
  async #tick(): Promise<void> {
    const due = await this.#options.store.wakeups.list({
      states: ['scheduled'],
      dueBy: this.#now,
    });
    for (const profile of new Set(due.map((row) => row.profileId))) {
      try {
        await this.#reconcile(profile);
      } catch (error) {
        this.#options.logger.error({ err: error, profile }, 'a due wakeup could not be settled');
      }
    }
  }
}
