// SPDX-License-Identifier: MPL-2.0
import {
  API_ROUTES,
  type ApiDecision,
  type ApiEventEnvelope,
  type ApiOrder,
  type ApiPlay,
  type ApiQuotaStatus,
  type ApiScenario,
} from '@otheater/protocol';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ApiClient } from '../client.js';
import { systemClock, type Clock, type ConnectionState } from '../connection.js';
import { ApiRequestError } from '../errors.js';
import type { EventStream, EventStreamOptions } from '../event-stream.js';
import { applyEvent, type EventReducer, type SyncFields } from './core.js';
import {
  initialActivity,
  installActivity,
  reduceActivity,
  type ActivityState,
} from './activity.js';
import {
  createDemandsReducer,
  initialDemands,
  installDemands,
  settleDemands,
  trackPlay,
  type DemandsState,
  type PlayParts,
} from './demands.js';
import {
  initialDecisions,
  installDecisions,
  reduceDecisions,
  settleDecisions,
  type DecisionsState,
} from './decisions.js';
import {
  initialOrders,
  installOrders,
  reduceOrders,
  settleOrder,
  type OrdersState,
} from './orders.js';
import { initialPlays, installPlays, reducePlays, settlePlay, type PlaysState } from './plays.js';
import {
  DEFAULT_EVENTS_KEEP,
  createRecentEventsReducer,
  initialRecentEvents,
  installRecentEvents,
  type RecentEventsState,
} from './recent-events.js';
import {
  DEFAULT_TRAJECTORY_KEEP,
  failDiff,
  failTrajectory,
  initialTrajectories,
  openDiff,
  openTrajectory,
  reduceTrajectories,
  settleDiff,
  settleTrajectory,
  type TrajectoriesState,
} from './trajectories.js';
import {
  initialQuotas,
  installQuotas,
  reduceQuotas,
  settleQuota,
  type QuotasState,
} from './quotas.js';
import {
  initialScenarios,
  installScenarios,
  reduceScenarios,
  settleScenario,
  type ScenariosState,
} from './scenarios.js';

/**
 * The stores of one daemon and what keeps them right (plan docs/17 P11): {@link DaemonStores}
 * reads the REST snapshots, follows the {@link EventStream}, and reads again, by REST, what the
 * events cannot keep. One hub per daemon; combine daemons by their `daemonId` (refs.ts).
 *
 * The order that loses no event, [proposta]:
 * 1. open the stream (no `since`) and buffer what it delivers;
 * 2. the first frame says the head `H` of the log (`id: <newest>`, `0` if empty; with no such
 *    frame, the id of the first message): the events that come after are above `H`, and what is up
 *    to `H` was committed before it was sent, so the snapshot below has it;
 * 3. read the snapshots by REST, which now include everything up to `H` (and maybe more);
 * 4. install them with `lastEventId = H`;
 * 5. apply the buffered events above `H`, in order, then apply live ones as they come.
 * An event above `H` that the snapshot already includes is applied again over it. That is safe:
 * every reducer sets a value or marks a key stale, never adds to one, so the replay ends in the
 * state the daemon is in (the events that matter are the last ones, and they are all in the
 * buffer). A subscriber may see the older value for the length of one synchronous replay.
 */

/** Where the hub is. */
export const SYNC_PHASES = ['idle', 'starting', 'live', 'failed', 'closed'] as const;
export type SyncPhase = (typeof SYNC_PHASES)[number];

export interface SyncStatus {
  readonly phase: SyncPhase;
  /** The state of the event stream. */
  readonly connection: ConnectionState;
  /** The id of the last event the hub took (the head `H` until the first one). */
  readonly cursor: number;
  /** Why the hub failed (`phase: 'failed'`), or the last problem to read something again. */
  readonly error: Error | undefined;
}

/** A refresh that gave up, or a stream that closed for good. */
export interface SyncProblem {
  readonly kind: 'refresh_failed' | 'stream_closed';
  readonly store?: string | undefined;
  readonly key?: string | undefined;
  readonly error: Error | undefined;
}

export interface DaemonStoresOptions {
  /** `client.events.*`. */
  readonly events?: {
    /** How many recent events to keep. Default {@link DEFAULT_EVENTS_KEEP} (500). */
    readonly keep?: number | undefined;
  };
  /** `client.trajectories.*`. */
  readonly trajectories?: {
    /** How many events of one play to keep. Default {@link DEFAULT_TRAJECTORY_KEEP} (5000). */
    readonly keep?: number | undefined;
  };
  /** Which plays the snapshot reads: `open` (default) the ones not finished, `all` every one. */
  readonly plays?: 'open' | 'all' | undefined;
  /**
   * Which plays have their demands and stages read: `open` (default) the open plays and every new
   * one, `none` only those asked for with {@link DaemonStores.trackPlay}.
   */
  readonly demands?: 'open' | 'none' | undefined;
  /** Reconnection of the stream (`since`, `scenario` and `types` are not for the hub). */
  readonly stream?: Omit<EventStreamOptions, 'since' | 'scenario' | 'types'> | undefined;
  readonly clock?: Clock | undefined;
  /** Wait before reading a stale key, so the events of one burst cost one read. Default 250. */
  readonly refreshDebounceMs?: number | undefined;
  /** Wait after a failed read, times the attempt. Default 2000. */
  readonly refreshRetryMs?: number | undefined;
  /** Reads of one key before giving up until the next event marks it again. Default 3. */
  readonly refreshAttempts?: number | undefined;
  /** REST reads in flight at once. Default 4. */
  readonly concurrency?: number | undefined;
  /** Items per page of the lists. Default 200 (the most the API allows). */
  readonly pageLimit?: number | undefined;
  /** How long to wait for the head of the log before going on without it. Default 5000. */
  readonly headTimeoutMs?: number | undefined;
  readonly onProblem?: ((problem: SyncProblem) => void) | undefined;
}

export const DEFAULT_SYNC = {
  refreshDebounceMs: 250,
  refreshRetryMs: 2000,
  refreshAttempts: 3,
  concurrency: 4,
  pageLimit: 200,
  headTimeoutMs: 5000,
} as const;

/** One kind of key that is read again: how to read it and where the answer goes. */
interface RefreshTarget {
  readonly name: string;
  stale(): Readonly<Record<string, number>>;
  refresh(key: string, revision: number, signal: AbortSignal): Promise<void>;
}

class Semaphore {
  readonly #limit: number;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  async run<Value>(task: () => Promise<Value>): Promise<Value> {
    if (this.#running >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#running += 1;
    try {
      return await task();
    } finally {
      this.#running -= 1;
      this.#waiting.shift()?.();
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}

export class DaemonStores {
  readonly scenarios: StoreApi<ScenariosState> = createStore<ScenariosState>(() =>
    initialScenarios(),
  );
  readonly plays: StoreApi<PlaysState> = createStore<PlaysState>(() => initialPlays());
  readonly demands: StoreApi<DemandsState> = createStore<DemandsState>(() => initialDemands());
  readonly decisions: StoreApi<DecisionsState> = createStore<DecisionsState>(() =>
    initialDecisions(),
  );
  readonly quotas: StoreApi<QuotasState> = createStore<QuotasState>(() => initialQuotas());
  /** The orders of the Producer (P15 of docs/18), kept by the `directive.*` events. */
  readonly orders: StoreApi<OrdersState> = createStore<OrdersState>(() => initialOrders());
  readonly events: StoreApi<RecentEventsState> = createStore<RecentEventsState>(() =>
    initialRecentEvents(),
  );
  /** The trajectories of the plays a screen follows (P14): see {@link DaemonStores.loadTrajectory}. */
  readonly trajectories: StoreApi<TrajectoriesState> = createStore<TrajectoriesState>(() =>
    initialTrajectories(),
  );
  /** Who is working and what is paused, from the events alone (P13). */
  readonly activity: StoreApi<ActivityState> = createStore<ActivityState>(() => initialActivity());
  readonly status: StoreApi<SyncStatus> = createStore<SyncStatus>(() => ({
    phase: 'idle',
    connection: 'connecting',
    cursor: 0,
    error: undefined,
  }));

  readonly #client: ApiClient;
  readonly #options: DaemonStoresOptions;
  #keepOverride: number | undefined;
  readonly #clock: Clock;
  readonly #limit: Semaphore;
  readonly #reduceDemands: EventReducer<DemandsState>;
  readonly #reduceEvents: EventReducer<RecentEventsState>;
  readonly #targets: readonly RefreshTarget[];
  readonly #abort = new AbortController();
  readonly #inflight = new Set<string>();
  readonly #idle: (() => void)[] = [];
  #stream: EventStream | undefined;
  #starting: Promise<void> | undefined;
  /** Events held while a snapshot is being read (`undefined` when live). */
  #buffer: ApiEventEnvelope[] | undefined;
  #recentLoaded = false;

  constructor(client: ApiClient, options: DaemonStoresOptions = {}) {
    this.#client = client;
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#limit = new Semaphore(options.concurrency ?? DEFAULT_SYNC.concurrency);
    this.#reduceDemands = createDemandsReducer({
      followNewPlays: (options.demands ?? 'open') === 'open',
    });
    this.#reduceEvents = createRecentEventsReducer(options.events?.keep ?? DEFAULT_EVENTS_KEEP);
    this.#targets = this.#makeTargets();
  }

  /**
   * Starts: opens the stream, reads the snapshots and goes live (the order is in the comment of
   * this file). Resolves when the stores are installed; rejects if the stream or a read fails
   * (the hub is then `failed` and `start()` may be called again). Calling it again while it runs,
   * or when live, returns the same promise.
   */
  start(): Promise<void> {
    if (this.#abort.signal.aborted) {
      return Promise.reject(new Error('These stores are closed'));
    }
    this.#starting ??= this.#start().catch((error: unknown) => {
      this.#starting = undefined;
      this.#fail(error);
      throw error;
    });
    return this.#starting;
  }

  /**
   * Reads every snapshot again and installs it: for a daemon that went back in time (a restored
   * backup) or when the screen wants to be sure. Events that come while it reads are held and
   * applied after. Needs a live hub.
   */
  async resync(): Promise<void> {
    if (this.status.getState().phase !== 'live') throw new Error('The stores are not live');
    const head = this.status.getState().cursor;
    this.#buffer = [];
    try {
      await this.#loadAndInstall(head);
    } catch (error) {
      this.#drain(head);
      throw error;
    }
    this.#drain(head);
  }

  /** The client of this daemon, for the commands a screen sends (the stores only read). */
  get client(): ApiClient {
    return this.#client;
  }

  /** Follows a play: its demands and stages are read at the next refresh and kept after. */
  trackPlay(playId: string): void {
    this.demands.setState((state) => trackPlay(state, playId), true);
    this.#pump();
  }

  /**
   * Opens the trajectory of a play: reads its history by REST once (paged) and, from then on, keeps
   * it with the events of the stream. Calling it again for a play already loaded does nothing,
   * unless `force`. Resolves when the history is installed; the failure is in the store.
   */
  async loadTrajectory(playId: string, options: { readonly force?: boolean } = {}): Promise<void> {
    const held = this.trajectories.getState().plays[playId];
    if (held !== undefined && held.load !== 'failed' && options.force !== true) return;
    const keep = this.#trajectoryKeep();
    this.trajectories.setState((state) => openTrajectory(state, playId), true);
    try {
      const signal = this.#abort.signal;
      const history = await this.#readAll((query) =>
        this.#client.call(API_ROUTES.listPlayTrajectory, { params: { playId }, query, signal }),
      );
      this.trajectories.setState((state) => settleTrajectory(state, playId, history, keep), true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.trajectories.setState((state) => failTrajectory(state, playId, message), true);
    }
  }

  /**
   * `client.trajectories.keep` for a client that reads its settings after the stores exist (the
   * TUI): from now on the trajectories keep at most this many events per play.
   */
  setTrajectoryKeep(keep: number): void {
    this.#keepOverride = Math.max(1, Math.floor(keep));
  }

  #trajectoryKeep(): number {
    return this.#keepOverride ?? this.#options.trajectories?.keep ?? DEFAULT_TRAJECTORY_KEEP;
  }

  /** Reads the diff of a demand (the latest attempt against the play branch) and keeps it. */
  async loadDemandDiff(playId: string, demandId: string): Promise<void> {
    this.trajectories.setState((state) => openDiff(state, playId, demandId), true);
    try {
      const value = await this.#client.call(API_ROUTES.getDemandDiff, {
        params: { playId, demandId },
        signal: this.#abort.signal,
      });
      this.trajectories.setState((state) => settleDiff(state, value), true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.trajectories.setState((state) => failDiff(state, playId, demandId, message), true);
    }
  }

  /** Resolves when no read is in flight (those that gave up stay stale). For tests and screens. */
  whenIdle(): Promise<void> {
    this.#pump();
    if (this.#inflight.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#idle.push(resolve));
  }

  /** Stops for good: the stream closes and nothing is read again. */
  close(): void {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort();
    this.#stream?.close();
    this.status.setState({ phase: 'closed' });
    this.#notifyIdle(true);
  }

  async #start(): Promise<void> {
    const signal = this.#abort.signal;
    this.status.setState({ phase: 'starting', error: undefined });
    const stream = this.#client.events({
      clock: this.#clock,
      ...this.#options.stream,
      invalidMessages: 'skip',
    });
    this.#stream = stream;
    this.#buffer = [];
    let head: number | undefined;
    let gotHead: () => void = () => undefined;
    const headKnown = new Promise<void>((resolve) => {
      gotHead = resolve;
    });
    stream.onCursor((id) => {
      if (head !== undefined) return;
      head = id;
      gotHead();
    });
    stream.onMessage((message) => {
      const event = message.data;
      if (this.#buffer !== undefined) this.#buffer.push(event);
      else this.#applyLive(event);
    });
    stream.onState((state, detail) => {
      this.status.setState({ connection: state });
      if (state === 'closed' && !signal.aborted) {
        // The stream gave up (a 401, `maxRetries`): nothing will keep the stores right now.
        if (this.status.getState().phase === 'live') {
          this.status.setState({ phase: 'failed', error: detail.error });
        }
        this.#options.onProblem?.({ kind: 'stream_closed', error: detail.error });
      }
    });
    stream.start();

    const closed = stream.done.then(() => {
      throw (
        stream.detail.error ??
        new Error(signal.aborted ? 'These stores were closed' : 'The event stream closed')
      );
    });
    closed.catch(() => undefined);
    const timeoutMs = this.#options.headTimeoutMs ?? DEFAULT_SYNC.headTimeoutMs;
    const waiting = new AbortController();
    const stopWaiting = (): void => {
      waiting.abort();
    };
    signal.addEventListener('abort', stopWaiting, { once: true });
    try {
      await Promise.race([headKnown, this.#clock.sleep(timeoutMs, waiting.signal), closed]);
    } finally {
      signal.removeEventListener('abort', stopWaiting);
      waiting.abort();
    }
    // No frame and no message in time: the snapshot is read at `0` and every event that comes
    // is applied; the reducers set values, so a replay over the snapshot is harmless.
    const base = head ?? 0;
    if (signal.aborted) throw new Error('These stores were closed');
    await Promise.race([this.#loadAndInstall(base), closed]);
    this.#drain(base);
    this.status.setState({ phase: 'live', cursor: Math.max(base, this.status.getState().cursor) });
    this.#pump();
  }

  /** Reads the snapshots and installs them with `lastEventId = head`. */
  async #loadAndInstall(head: number): Promise<void> {
    const signal = this.#abort.signal;
    const scenarios = await this.#readAll((query) =>
      this.#client.call(API_ROUTES.listScenarios, { query, signal }),
    );
    const active = scenarios.filter((scenario) => scenario.state === 'active');
    const playsOption = this.#options.plays ?? 'open';
    const [perScenarioPlays, perScenarioDecisions, quotas, orders] = await Promise.all([
      Promise.all(
        active.map((scenario) =>
          this.#limit.run(() =>
            this.#readAll((query) =>
              this.#client.call(API_ROUTES.listScenarioPlays, {
                params: { scenarioId: scenario.id },
                query: { ...query, ...(playsOption === 'open' ? { open: 'true' as const } : {}) },
                signal,
              }),
            ),
          ),
        ),
      ),
      Promise.all(
        active.map((scenario) =>
          this.#limit.run(async () => ({
            scenarioId: scenario.id,
            decisions: await this.#readAll((query) =>
              this.#client.call(API_ROUTES.listScenarioDecisions, {
                params: { scenarioId: scenario.id },
                query: { ...query, state: 'pending' as const },
                signal,
              }),
            ),
          })),
        ),
      ),
      this.#readQuotas(),
      this.#readAll((query) => this.#client.call(API_ROUTES.listOrders, { query, signal })),
    ]);
    const plays = perScenarioPlays.flat();
    const details: { playId: string; parts: PlayParts }[] =
      (this.#options.demands ?? 'open') === 'none'
        ? []
        : await Promise.all(
            plays
              .filter((play) => play.finishedAt === null)
              .map((play) =>
                this.#limit.run(async () => ({
                  playId: play.id,
                  parts: await this.#readParts(play.id),
                })),
              ),
          );

    // Everything is in hand: install it all at once, with no await in between.
    this.scenarios.setState(installScenarios(scenarios, head), true);
    this.plays.setState(installPlays(plays, head), true);
    this.demands.setState(installDemands(details, head), true);
    this.decisions.setState(installDecisions(perScenarioDecisions, head), true);
    this.quotas.setState(installQuotas(quotas, head), true);
    this.orders.setState(installOrders(orders, head), true);
    if (!this.#recentLoaded) {
      this.events.setState(installRecentEvents(head), true);
      this.activity.setState(installActivity(head), true);
      this.#recentLoaded = true;
    }
  }

  async #readParts(playId: string): Promise<PlayParts> {
    const detail = await this.#client.call(API_ROUTES.getPlay, {
      params: { playId },
      signal: this.#abort.signal,
    });
    return { demands: detail.demands, stages: detail.stages };
  }

  async #readQuotas(): Promise<ApiQuotaStatus[]> {
    const signal = this.#abort.signal;
    const profiles = await this.#readAll((query) =>
      this.#client.call(API_ROUTES.listProfiles, { query, signal }),
    );
    return profiles.flatMap((profile) => (profile.quota === null ? [] : [profile.quota]));
  }

  /** Every page of a list, in order. */
  async #readAll<Item>(
    page: (query: { limit: number; after?: string }) => Promise<{
      items: Item[];
      nextCursor: string | null;
    }>,
  ): Promise<Item[]> {
    const limit = this.#options.pageLimit ?? DEFAULT_SYNC.pageLimit;
    const items: Item[] = [];
    let after: string | undefined;
    for (;;) {
      const answer = await page({ limit, ...(after === undefined ? {} : { after }) });
      items.push(...answer.items);
      if (answer.nextCursor === null) return items;
      after = answer.nextCursor;
    }
  }

  /** Applies what was held, above `head`, in order, and goes live. */
  #drain(head: number): void {
    const held = this.#buffer ?? [];
    this.#buffer = undefined;
    for (const event of held.sort((a, b) => a.id - b.id)) {
      if (event.id > head) this.#apply(event);
    }
    this.#pump();
  }

  #applyLive(event: ApiEventEnvelope): void {
    this.#apply(event);
    this.#pump();
  }

  /** One event, to every store. An event not above the cursor was taken already. */
  #apply(event: ApiEventEnvelope): void {
    if (event.id <= this.status.getState().cursor) return;
    this.scenarios.setState((s) => applyEvent(s, event, reduceScenarios), true);
    this.plays.setState((s) => applyEvent(s, event, reducePlays), true);
    this.demands.setState((s) => applyEvent(s, event, this.#reduceDemands), true);
    this.decisions.setState((s) => applyEvent(s, event, reduceDecisions), true);
    this.quotas.setState((s) => applyEvent(s, event, reduceQuotas), true);
    this.orders.setState((s) => applyEvent(s, event, reduceOrders), true);
    this.events.setState((s) => applyEvent(s, event, this.#reduceEvents), true);
    const keep = this.#trajectoryKeep();
    this.trajectories.setState((s) => reduceTrajectories(s, event, keep), true);
    this.activity.setState((s) => applyEvent(s, event, reduceActivity), true);
    this.status.setState({ cursor: event.id });
  }

  #fail(error: unknown): void {
    this.#stream?.close();
    this.#buffer = undefined;
    this.status.setState({
      phase: this.#abort.signal.aborted ? 'closed' : 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  // ---- reading again what the events cannot keep ----------------------------------------------

  #makeTargets(): readonly RefreshTarget[] {
    const call = this.#client.call.bind(this.#client);
    const notFound = async <Value>(read: () => Promise<Value>): Promise<Value | null> => {
      try {
        return await read();
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    };
    return [
      target<ApiScenario>({
        name: 'scenarios',
        store: this.scenarios,
        read: async (key, signal) =>
          (
            await notFound(() =>
              call(API_ROUTES.getScenario, { params: { scenarioId: key }, signal }),
            )
          )?.scenario ?? null,
        settle: (key, revision, value) => {
          this.scenarios.setState((s) => settleScenario(s, key, revision, value), true);
        },
      }),
      target<ApiPlay>({
        name: 'plays',
        store: this.plays,
        read: async (key, signal) =>
          (await notFound(() => call(API_ROUTES.getPlay, { params: { playId: key }, signal })))
            ?.play ?? null,
        settle: (key, revision, value) => {
          this.plays.setState((s) => settlePlay(s, key, revision, value), true);
        },
      }),
      target<PlayParts>({
        name: 'demands',
        store: this.demands,
        read: async (key, signal) => {
          const detail = await notFound(() =>
            call(API_ROUTES.getPlay, { params: { playId: key }, signal }),
          );
          return detail === null ? null : { demands: detail.demands, stages: detail.stages };
        },
        settle: (key, revision, value) => {
          this.demands.setState((s) => settleDemands(s, key, revision, value), true);
        },
      }),
      target<readonly ApiDecision[]>({
        name: 'decisions',
        store: this.decisions,
        read: async (key, signal) =>
          (await notFound(() =>
            this.#readAll((query) =>
              call(API_ROUTES.listScenarioDecisions, {
                params: { scenarioId: key },
                query: { ...query, state: 'pending' as const },
                signal,
              }),
            ),
          )) ?? [],
        settle: (key, revision, value) => {
          this.decisions.setState((s) => settleDecisions(s, key, revision, value ?? []), true);
        },
      }),
      target<ApiQuotaStatus>({
        name: 'quotas',
        store: this.quotas,
        read: async (key, signal) => {
          const at = key.indexOf('/');
          if (at < 0) return null;
          const profile = await notFound(() =>
            call(API_ROUTES.getProfile, {
              params: { client: key.slice(0, at), name: key.slice(at + 1) },
              signal,
            }),
          );
          return profile?.quota ?? null;
        },
        settle: (key, revision, value) => {
          this.quotas.setState((s) => settleQuota(s, key, revision, value), true);
        },
      }),
      target<ApiOrder>({
        name: 'orders',
        store: this.orders,
        read: (key, signal) =>
          notFound(() => call(API_ROUTES.getOrder, { params: { orderId: key }, signal })),
        settle: (key, revision, value) => {
          this.orders.setState((s) => settleOrder(s, key, revision, value), true);
        },
      }),
    ];
  }

  /** Starts a read for every stale key that has none in flight. */
  #pump(): void {
    if (this.#abort.signal.aborted || this.status.getState().phase !== 'live') {
      this.#notifyIdle();
      return;
    }
    for (const target of this.#targets) {
      for (const key of Object.keys(target.stale())) {
        const id = `${target.name}\u0000${key}`;
        if (this.#inflight.has(id)) continue;
        this.#inflight.add(id);
        void this.#refresh(target, key, id);
      }
    }
    this.#notifyIdle();
  }

  async #refresh(target: RefreshTarget, key: string, id: string): Promise<void> {
    const signal = this.#abort.signal;
    const attempts = this.#options.refreshAttempts ?? DEFAULT_SYNC.refreshAttempts;
    const outcome = { gaveUp: false };
    try {
      // The wait lets the events of one burst count as one read; the revision is taken after it.
      await this.#clock.sleep(
        this.#options.refreshDebounceMs ?? DEFAULT_SYNC.refreshDebounceMs,
        signal,
      );
      for (let attempt = 1; !signal.aborted; attempt += 1) {
        const revision = target.stale()[key];
        if (revision === undefined) return;
        try {
          await this.#limit.run(() => target.refresh(key, revision, signal));
          return;
        } catch (error) {
          if (this.#abort.signal.aborted) return;
          if (attempt >= attempts) {
            outcome.gaveUp = true;
            const problem = error instanceof Error ? error : new Error(String(error));
            this.status.setState({ error: problem });
            this.#options.onProblem?.({
              kind: 'refresh_failed',
              store: target.name,
              key,
              error: problem,
            });
            return;
          }
          await this.#clock.sleep(
            (this.#options.refreshRetryMs ?? DEFAULT_SYNC.refreshRetryMs) * attempt,
            signal,
          );
        }
      }
    } finally {
      this.#inflight.delete(id);
      // A mark that came during the read is read now; a key that gave up waits for its next event.
      if (outcome.gaveUp) this.#notifyIdle();
      else this.#pump();
    }
  }

  #notifyIdle(force = false): void {
    if (!force && this.#inflight.size > 0) return;
    for (const resolve of this.#idle.splice(0)) resolve();
  }
}

function target<Value>(input: {
  readonly name: string;
  readonly store: StoreApi<SyncFields>;
  read(key: string, signal: AbortSignal): Promise<Value | null>;
  settle(key: string, revision: number, value: Value | null): void;
}): RefreshTarget {
  return {
    name: input.name,
    stale: () => input.store.getState().stale,
    async refresh(key, revision, signal) {
      input.settle(key, revision, await input.read(key, signal));
    },
  };
}
