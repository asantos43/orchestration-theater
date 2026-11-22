// SPDX-License-Identifier: MPL-2.0
import {
  buildDaemonEvent,
  type ChatDirectorSilentPayload,
  type ChatToolCall,
  type DirectorSwitchForm,
  type InterruptionCause,
  type ScenarioDirectorFailoverNotice,
  type ScenarioDirectorSwitchedPayload,
  type ScenarioDirectorSwitchNotice,
} from '@otheater/protocol';
import {
  AdapterUnavailable,
  assemblePrefix,
  Conflict,
  type ExecutorConfig,
  InvalidInput,
  mcpToolsOf,
  type Clock,
  type Disposable,
  NotFound,
  type ResolvedExecutor,
  type SessionConfigChoice,
  type SessionConfigOption,
  type NormalizedUpdate,
  type PromptQueueItem,
  type PromptSource,
  type Registries,
  renderStateSummary,
  stateSummaryOf,
  type SessionCommand,
  type Store,
} from '@otheater/core';
import type { DaemonConfig } from '../config.js';
import type { SessionLease } from '../execution/pool.js';
import type { Execution } from '../execution/service.js';
import type { Logger } from '../logger.js';
import { FRAMEWORK_MCP_NAME, type McpAccess, type McpGrant } from '../mcp/access.js';
import type { DataPaths } from '../paths.js';
import type { PromptDispatcher } from '../prompt-dispatcher.js';
import type { QuotaService } from '../quota/service.js';
import type { QuotaStatus } from '../quota/state.js';
import { situationText } from '../situations.js';
import {
  directorFailureOf,
  failoverApplies,
  PROFILE_REMOVED,
  type DirectorFailure,
} from './director-failover.js';
import { silentReplyText, TurnTools } from './director-silence.js';
import {
  matchExecutor,
  readDirectorOverride,
  writeDirectorOverride,
  type DirectorOverride,
  type DirectorSwitchChange,
  type DirectorSwitchResult,
  type DirectorView,
  type DirectorViewExecutor,
  type DirectorViewModel,
} from './director-switch.js';
import { resolveRolePolicy } from './role-policy.js';
import type { RoleSelection, SelectedExecutor } from './role-selection.js';

/** The role the session of the Director plays. */
export const DIRECTOR_ROLE = 'director';

/** The id of the MCP grant of a Director session: the scenario is part of it. */
export function directorAttemptId(scenarioId: string): string {
  return `director/${scenarioId}`;
}

/** One reply of the Director, as the chat shows it. */
export interface DirectorReply {
  /** 1, 2, 3... per scenario, in the order the turns ended. */
  readonly seq: number;
  /** Who put the prompt this reply answers in the queue. */
  readonly to: PromptQueueItem['source'];
  readonly text: string;
  /**
   * Set when the daemon wrote the reply because the turn ended with no text (N183,
   * `chat.silent_turn: notice`); absent from what the Director itself said.
   */
  readonly generated?: GeneratedReply;
}

/** What a reply the daemon generated for a silent turn is made from (N183). */
export interface GeneratedReply {
  /** The tools the turn called, in the order they started. */
  readonly tools: readonly ChatToolCall[];
  /** The play the turn opened (a `play.created` of the scenario during it), if there was one. */
  readonly playId: string | null;
}

export interface DirectorSessionsOptions {
  readonly store: Store;
  readonly execution: Execution;
  readonly mcp: McpAccess;
  readonly dispatcher: PromptDispatcher;
  readonly prompts: PromptSource;
  readonly registries: Registries;
  /** The choice of the Director's Executor (P16); it replaces `orchestration.executor`. */
  readonly selection: RoleSelection;
  readonly config: DaemonConfig;
  readonly paths: Pick<DataPaths, 'profiles'>;
  readonly logger: Logger;
  /**
   * Drives the idle timer. Without it a Director never sleeps (the tests that do not care about
   * time, and the daemon of the previous steps, keep the old behaviour).
   */
  readonly clock?: Clock;
  /**
   * What the failover tells the quota service about a limit error, so the next selection leaves the
   * exhausted profile out (P20). Without it the Executor that failed is excluded by the failover
   * itself until a turn succeeds.
   */
  readonly quota?:
    (Pick<QuotaService, 'ingestLimitHit'> & Partial<Pick<QuotaService, 'statusOf'>>) | undefined;
  /**
   * The `director_failover` notice for the chat of the Producer (P20), called after the
   * `scenario.system_message` event is written. The daemon hands it to the Producer channel.
   */
  readonly onNotice?:
    ((notice: ScenarioDirectorFailoverNotice | ScenarioDirectorSwitchNotice) => void) | undefined;
  /**
   * Called for every reply kept for the chat, after it is in memory (P7 of docs/17): the daemon
   * records the `chat.director_reply` event here, the record the chat WebSocket reads and resumes
   * from. It must not throw; what it throws is logged.
   */
  readonly onReply?: ((scenarioId: string, reply: DirectorReply) => void) | undefined;
  /**
   * Called when a turn ends without error and without any text (N183), whatever `chat.silent_turn`
   * says: the daemon records the `chat.director_silent` event here. It is called before the
   * generated reply goes to `onReply`. It must not throw; what it throws is logged.
   */
  readonly onSilent?: ((scenarioId: string, silent: ChatDirectorSilentPayload) => void) | undefined;
}

/** The failover of a Director session that is being replaced (P20). */
interface PendingFailover {
  /** The Executor of the session that failed; null when no Executor was on record. */
  readonly from: string | null;
  readonly cause: InterruptionCause;
  /** When the limit comes back, if the quota service knows. */
  readonly resetsAt: number | null;
  readonly detail: string | null;
  /** The prompt of the queue that was in progress and went back to it; null when none was. */
  readonly requeued: string | null;
  /** The `waiting` notice was already written. */
  announcedWaiting: boolean;
}

interface DirectorSession {
  readonly scenarioId: string;
  /** `undefined` while the Director sleeps: the lease went back to the pool. */
  lease: SessionLease | undefined;
  grant: McpGrant | undefined;
  /** The role prefix, kept so a session opened again after a sleep gets it too. */
  readonly prefix: string;
  /** Epoch ms the Director fell asleep at; `undefined` while awake. */
  sleptAt: number | undefined;
  /** Opening the session (or opening it again after a sleep): single flight. */
  waking: Promise<void> | undefined;
  /**
   * Settled when the opening holds for an Executor (`selection.director_wait: wait`) or ends: the
   * callers of `ensure` do not stay behind the wait.
   */
  parked: Deferred | undefined;
  /** Stops a wait for an Executor when the sessions close. */
  readonly abort: AbortController;
  /** Cancels the idle wait. */
  idleTimer: AbortController | undefined;
  attachment: Disposable | undefined;
  readonly replies: DirectorReply[];
  seq: number;
  /** A turn is running. */
  active: boolean;
  /** The last turn failed: the queue does not move until the session is opened again. */
  failed: boolean;
  /** The Executor the open session runs with (complete name); `undefined` while it sleeps. */
  executor: string | undefined;
  /**
   * The Executors whose session failed since the last turn that worked (P20), for the causes the
   * quota does not explain (a provider error, a drop): the opening leaves them out, so a failover
   * never goes back to what just failed. Cleared by a turn that works and when nobody is left.
   */
  readonly failedExecutors: Set<string>;
  /** The failover the opening in course belongs to; `undefined` for an ordinary wake. */
  failover: PendingFailover | undefined;
  /**
   * The profile of the open session is leaving (P21b, N153): whatever ends the turn in course is
   * the removal, and the session is replaced by the failover with the cause `profile_removed`.
   */
  leaving: boolean;
  /** Settled when the session that was on the leaving profile has let go of its lease. */
  left: Deferred | undefined;
  /** The settings (model, effort) the open session runs with; `undefined` while it sleeps (P14). */
  settings: ExecutorConfig | undefined;
  /**
   * A manual switch waits for the end of the turn (or of the opening) in course (P14,
   * `scenarios.director_switch.in_turn`); settled when it was carried out.
   */
  pendingSwitch: Deferred | undefined;
  /** The prefix of the role goes into the first prompt of the session. */
  prefixed: boolean;
  /** The session was opened again after a sleep: its first prompt carries the state summary. */
  summaryNeeded: boolean;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** How the opening of a session reports that it holds for an Executor. */
interface ParkingHooks {
  readonly signal: AbortSignal;
  readonly parked: () => void;
}

/** What the notice and the log say about a failover caused by the removal of the profile (P21b). */
const LEAVING_ERROR = new Error('The profile of the Director session is being removed.');

/** The turn of the Director outlived `limits.turn_timeout` and was cancelled (N184). */
class TurnTimeoutError extends Error {
  constructor(limitMs: number) {
    super(`The turn of the Director took longer than limits.turn_timeout (${String(limitMs)} ms).`);
    this.name = 'TurnTimeoutError';
  }
}

/** The choices of the first select option of a category (`model`, `thought_level`), groups flattened. */
function optionChoices(
  options: readonly SessionConfigOption[],
  category: string,
): readonly SessionConfigChoice[] {
  const option = options.find((item) => item.category === category && item.type === 'select');
  if (option?.options === undefined) return [];
  return option.options.flatMap((entry) => ('options' in entry ? entry.options : [entry]));
}

function textOf(update: NormalizedUpdate): string {
  return update.kind === 'agent_message_chunk' && update.content.type === 'text'
    ? update.content.text
    : '';
}

/**
 * The session of the Director of each scenario (architecture 5.4, "Fila única de prompts"; N78).
 * The daemon opens it, hands it the tools of the role through the framework MCP server and sends
 * it, one turn at a time, what the single queue delivers. What the Director says in a turn is kept
 * as one reply, so the chat of the Producer can show it.
 *
 * [proposta] The session is a lease of the pool, like the one of an attempt. It is held while the
 * Director works and for `scenarios.director_idle_after` after the last turn; then the Director
 * sleeps (5.20): the lease goes back, the MCP grant is revoked and `scenario.director_slept` is
 * written. Whoever needs the Director calls `ensure` (or the queue delivers a prompt), which wakes
 * it: a new session opens and its first prompt carries the role prefix and the state summary of
 * the scenario (P7), so nothing the Director knew is lost: it lives in the store. No reload after
 * a crash: that is the reconciliation (P9). The replies live in memory, bounded by `chat.history`;
 * the queue and the events are what survives a restart.
 *
 * P16b (N141) With no Executor available and `selection.director_wait: wait` (the default), the
 * opening is parked, not blocked: `ensure` returns, the prompts the Producer sends stay in the
 * queue, and the session opens by itself when the wake of P9 or the recheck of the selection finds
 * an Executor, and then takes the prompts. `scenario.director_waiting` and
 * `scenario.director_resumed` mark both ends of the wait.
 */
export class DirectorSessions {
  readonly #options: DirectorSessionsOptions;
  readonly #sessions = new Map<string, Promise<DirectorSession>>();
  readonly #opened = new Map<string, DirectorSession>();
  /** One manual switch at a time for each scenario (P14). */
  readonly #switching = new Map<string, Promise<unknown>>();

  constructor(options: DirectorSessionsOptions) {
    this.#options = options;
  }

  /** The scenario a Director grant belongs to (what the MCP handlers need to know). */
  scenarioOf(attemptId: string): string | undefined {
    for (const session of this.#opened.values()) {
      if (directorAttemptId(session.scenarioId) === attemptId) return session.scenarioId;
    }
    return undefined;
  }

  /**
   * Opens the session of the scenario, once; later calls get the same one. A sleeping Director
   * wakes. Counts as activity: the idle wait starts again.
   */
  async ensure(scenarioId: string): Promise<void> {
    let opening = this.#sessions.get(scenarioId);
    if (opening === undefined) {
      opening = this.#open(scenarioId);
      this.#sessions.set(scenarioId, opening);
      opening.catch(() => this.#sessions.delete(scenarioId));
    }
    const session = await opening;
    await this.#wake(session);
    this.#arm(session);
  }

  /** Whether the Director of the scenario has a session opened and is asleep. */
  isAsleep(scenarioId: string): boolean {
    const session = this.#opened.get(scenarioId);
    return session !== undefined && session.lease === undefined;
  }

  /** The replies after `since` (a `seq`; 0 for all), oldest first. */
  replies(scenarioId: string, since: number): readonly DirectorReply[] {
    const session = this.#opened.get(scenarioId);
    return session === undefined ? [] : session.replies.filter((reply) => reply.seq > since);
  }

  /** Whether the Director has a turn running, or a prompt that will still be delivered. */
  async busy(scenarioId: string): Promise<boolean> {
    const session = this.#opened.get(scenarioId);
    if (session === undefined) return false;
    if (session.active || session.waking !== undefined) return true;
    if (session.failed) return false;
    const pending = await this.#options.store.promptQueue.list({
      scenarioId,
      states: ['pending'],
    });
    return pending.length > 0;
  }

  /**
   * Stops the reply the Director is giving (Phase 7, P12: Esc of the TUI, `/stop`). The turn is
   * cancelled the way the client's protocol has it (`session/cancel`): it ends with what was said
   * so far, which stays as the reply, and the prompt counts as delivered. Nothing else is touched:
   * the plays go on, and the queue moves to its next message. Resolves `false` when there is no
   * turn running (a sleeping Director, an idle one, one that is still opening).
   */
  async interrupt(scenarioId: string): Promise<boolean> {
    const session = this.#opened.get(scenarioId);
    const lease = session?.lease;
    if (session === undefined || lease === undefined || !session.active) return false;
    await lease.session.cancel().catch(() => undefined);
    return true;
  }

  /**
   * The `/` commands the client of the open session announced (Phase 7, P3), the id of that client
   * (`claude-code`, `codex`, `opencode`) and whether the Director is in a turn (a turn running, a
   * session opening, or a prompt of the queue still to be delivered: `busy`). `undefined` when
   * there is no open session to ask: no Director yet, or it sleeps.
   */
  async clientCommands(scenarioId: string): Promise<
    | {
        readonly client: string;
        readonly commands: readonly SessionCommand[];
        readonly inTurn: boolean;
        /** Whether the Director had its first turn: until then the prompt carries the prefix, and a `/` in it is no command. */
        readonly started: boolean;
      }
    | undefined
  > {
    const session = this.#opened.get(scenarioId);
    const lease = session?.lease;
    if (session === undefined || lease === undefined) return undefined;
    return {
      client: lease.client,
      commands: lease.session.availableCommands ?? [],
      inTurn: await this.busy(scenarioId),
      started: session.prefixed,
    };
  }

  /**
   * P21b (N153, `profiles.drain.director: failover`): the Director of every scenario whose open
   * session stands on `profileId` moves to the next Executor of its list, through the failover of
   * P20 (cause `profile_removed`), so the removal of the profile is not held by it. A turn in
   * course is cut with the session (the adapter process is ended) and its prompt stays in the
   * queue; an idle Director just changes session. Resolves, with the number of sessions moved,
   * once each one has let go of its lease on the profile; it does not wait for the new session,
   * which may hold for an Executor (`selection.director_wait`). A sleeping Director has no lease
   * and holds nothing: its next wake picks an Executor of a profile that is not leaving.
   */
  async leaveProfile(profileId: string): Promise<number> {
    const standing = [...this.#opened.values()].filter(
      (session) => session.lease?.profileId === profileId,
    );
    await Promise.all(standing.map((session) => this.#leave(session)));
    return standing.length;
  }

  async #leave(session: DirectorSession): Promise<void> {
    const { lease } = session;
    if (lease === undefined) return;
    if (session.left !== undefined) {
      await session.left.promise;
      return;
    }
    const left = deferred();
    session.left = left;
    session.leaving = true;
    try {
      if (session.active) {
        // The turn fails with the session; `#turn` replaces it and puts the prompt back.
        await lease.kill().catch((error: unknown) => {
          this.#options.logger.warn(
            { err: error, scenarioId: session.scenarioId },
            'the Director process did not end',
          );
        });
      } else {
        await this.#failover(session, undefined, PROFILE_REMOVED, LEAVING_ERROR);
      }
    } finally {
      // A turn that ended meanwhile did the replacing; a failover that did not run lets go too.
      if (!session.active && session.lease === lease) this.#letGo(session);
    }
    await left.promise;
  }

  /** The session is no longer on the leaving profile (or never will be): `leaveProfile` goes on. */
  #letGo(session: DirectorSession): void {
    session.leaving = false;
    session.left?.resolve();
    session.left = undefined;
  }

  /** Ends every session. Idempotent. */
  async close(): Promise<void> {
    const opened = [...this.#opened.values()];
    this.#opened.clear();
    this.#sessions.clear();
    for (const session of opened) {
      session.abort.abort();
      session.idleTimer?.abort();
      session.attachment?.dispose();
      await session.lease?.release().catch(() => undefined);
      session.grant?.revoke();
    }
  }

  /** The Director has nothing running and nothing waiting: it may fall asleep. */
  async #sleepable(session: DirectorSession): Promise<boolean> {
    if (session.lease === undefined || session.active || session.waking !== undefined) return false;
    return !(await this.busy(session.scenarioId));
  }

  /** Starts (again) the wait after which an idle Director sleeps. */
  #arm(session: DirectorSession): void {
    const { clock, config } = this.#options;
    session.idleTimer?.abort();
    session.idleTimer = undefined;
    const idle = config.scenarios.director_idle_after;
    if (clock === undefined || idle === 0 || session.lease === undefined) return;
    const timer = new AbortController();
    session.idleTimer = timer;
    clock.sleep(idle, timer.signal).then(
      () => {
        if (session.idleTimer === timer) session.idleTimer = undefined;
        void this.#sleep(session, idle).catch((error: unknown) => {
          this.#options.logger.error(
            { err: error, scenarioId: session.scenarioId },
            'the Director could not fall asleep',
          );
        });
      },
      () => undefined,
    );
  }

  async #sleep(session: DirectorSession, idleMs: number): Promise<void> {
    const { store, clock, logger } = this.#options;
    if (!(await this.#sleepable(session))) {
      // Busy: the end of the turn (or the next `ensure`) starts the wait again.
      return;
    }
    const { lease, grant } = session;
    if (lease === undefined || session.idleTimer !== undefined || session.active) return;
    session.lease = undefined;
    session.grant = undefined;
    session.sleptAt = clock?.now() ?? 0;
    session.prefixed = false;
    session.summaryNeeded = true;
    await lease.release().catch((error: unknown) => {
      logger.warn({ err: error, scenarioId: session.scenarioId }, 'the Director lease did not go');
    });
    grant?.revoke();
    // One transaction: the record and the event carry the same stamp (N177).
    await store.transaction(async (tx) => {
      await tx.scenarios.update(session.scenarioId, { directorState: 'asleep' });
      await tx.events.append({
        ...buildDaemonEvent('scenario.director_slept', {
          scenarioId: session.scenarioId,
          idleMs,
        }),
        scenarioId: session.scenarioId,
      });
    });
  }

  /**
   * Opens a session again for a sleeping Director (single flight). It settles when the session is
   * open or, with `selection.director_wait: wait` and no Executor, when the opening starts to wait:
   * `#awake` is the one that stays until the session is open.
   */
  #wake(session: DirectorSession): Promise<void> {
    if (session.lease !== undefined) return Promise.resolve();
    if (session.waking === undefined) {
      const parked = deferred();
      session.parked = parked;
      session.waking = this.#reopen(session, parked.resolve).finally(() => {
        session.waking = undefined;
        session.parked = undefined;
        parked.resolve();
      });
      // A manual switch that came while the session was opening is carried out once it is open (P14).
      void session.waking.then(
        () => this.#applyPendingSwitch(session),
        () => undefined,
      );
    }
    const { waking, parked } = session;
    return parked === undefined ? waking : Promise.race([waking, parked.promise]);
  }

  /** Waits until the session is open, however long the Director waits for an Executor. */
  async #awake(session: DirectorSession): Promise<void> {
    await this.#wake(session);
    await session.waking;
  }

  async #reopen(session: DirectorSession, parked: () => void): Promise<void> {
    const { store, logger } = this.#options;
    const park = { held: false };
    try {
      const { lease, grant, picked, settings } = await this.#acquire(session, {
        signal: session.abort.signal,
        parked: () => {
          park.held = true;
          parked();
          this.#announceWaiting(session);
        },
      });
      session.lease = lease;
      session.grant = grant;
      session.executor = picked.executor.id;
      session.settings = settings;
      const sleptAt = session.sleptAt ?? null;
      const slept = session.sleptAt !== undefined;
      session.sleptAt = undefined;
      if (slept) {
        await store.transaction(async (tx) => {
          await tx.scenarios.update(session.scenarioId, { directorState: 'active' });
          await tx.events.append({
            ...buildDaemonEvent('scenario.director_woke', {
              scenarioId: session.scenarioId,
              sleptAt,
            }),
            scenarioId: session.scenarioId,
          });
        });
      }
      const failing = session.failover !== undefined;
      await this.#settleFailover(session, 'switched', picked.executor.id);
      if (park.held || slept || failing) this.#arm(session);
    } catch (error) {
      // A caller of `ensure` that stayed behind the opening sees the error; one that was released
      // when the wait began cannot, so the log keeps it.
      if (park.held) {
        logger.error(
          { err: error, scenarioId: session.scenarioId },
          'the Director did not open after its wait',
        );
      }
      await this.#settleFailover(session, 'unavailable', null, error);
      throw error;
    }
  }

  /**
   * The Executor of the Director of a scenario (P16). With nobody available the opening fails
   * with the reason ("waiting for quota of ...", `selection.director_wait: fail`) or holds until
   * somebody is (`wait`, N141): `hooks.parked` says the wait began, and the events
   * `scenario.director_waiting` and `scenario.director_resumed` are its two ends. The Director
   * session that is already open keeps the Executor it has.
   */
  async #pick(
    session: DirectorSession,
    hooks: ParkingHooks | undefined,
    override: DirectorOverride | null,
  ): Promise<SelectedExecutor> {
    const { selection, config, store } = this.#options;
    const { scenarioId, failedExecutors } = session;
    const leaving = session.failover?.from ?? null;
    // P20: a failover never goes back to the Executor that just failed (a provider error, a drop).
    const request = {
      role: DIRECTOR_ROLE,
      scenarioId,
      ...(failedExecutors.size === 0
        ? {}
        : {
            refuse: (item: { readonly id: string }) =>
              failedExecutors.has(item.id) ? 'director_failed' : null,
          }),
      // P14 (N242): the Executor the Producer chose goes first; the failover follows the list from it.
      ...(override === null ? {} : { startAt: override.executor }),
      // P26 (N157): the Executor the failover leaves holds the other accounts of its provider when
      // its account ran out and `profiles.rotate_on_exhaustion.<provider>` is `off`.
      ...(leaving === null ? {} : { earlier: [leaving] }),
    };
    if (config.selection.director_wait === 'wait') {
      const acquired = await selection.acquire(request, {
        ...(hooks === undefined ? {} : { signal: hooks.signal }),
        watch: {
          started: async (wait) => {
            await store.events.append({
              ...buildDaemonEvent('scenario.director_waiting', {
                scenarioId,
                on: wait.on.map((item) => ({ ...item })),
                until: wait.until,
                message: wait.message,
                since: wait.since,
              }),
              scenarioId,
            });
            hooks?.parked();
          },
          ended: async (end) => {
            await store.events.append({
              ...buildDaemonEvent('scenario.director_resumed', {
                scenarioId,
                outcome: end.outcome,
                executor: end.executor,
                waitedMs: end.waitedMs,
              }),
              scenarioId,
            });
          },
        },
      });
      if (acquired === undefined) {
        throw new AdapterUnavailable('The daemon is stopping: the Director did not open.');
      }
      if (acquired.kind === 'unavailable') throw new AdapterUnavailable(acquired.reason);
      return acquired;
    }
    const once = await selection.once(request);
    if (once.kind === 'selected') return once;
    throw new AdapterUnavailable(once.reason);
  }

  /** The pool lease and the MCP grant of the Director of a scenario. */
  async #acquire(
    session: DirectorSession,
    hooks?: ParkingHooks,
  ): Promise<{
    lease: SessionLease;
    grant: McpGrant;
    picked: SelectedExecutor;
    /** What the session runs with: the settings of the Executor plus the override that was applied. */
    settings: ExecutorConfig;
  }> {
    const { store, execution, mcp, config, registries } = this.#options;
    const { scenarioId } = session;
    const scenario = await store.scenarios.get(scenarioId);
    if (scenario === undefined) throw new NotFound(`There is no scenario "${scenarioId}"`);
    const override = readDirectorOverride(scenario.configOverride);
    const picked = await this.#pick(session, hooks, override);
    const repos = await store.scenarioRepos.list(scenarioId);
    const cwd = repos[0]?.path ?? scenario.folder;
    const { profile, settings } = picked;
    const policy = await resolveRolePolicy(
      { config, scenarios: store.scenarios, tools: () => registries.tools.list() },
      DIRECTOR_ROLE,
      scenarioId,
    );
    const tools = mcpToolsOf(policy, FRAMEWORK_MCP_NAME);
    const grant = mcp.grant({
      attemptId: directorAttemptId(scenarioId),
      role: DIRECTOR_ROLE,
      ...(tools === 'all' ? {} : { tools }),
      correlation: {},
      record: async (event) => {
        await store.events.append(event);
      },
    });
    try {
      const lease = await execution.pool.acquire({
        client: profile.client,
        profile,
        policy,
        cwd,
        mcpServers: [grant.server],
        director: true,
        telemetry: { scenarioId, attemptId: directorAttemptId(scenarioId) },
        correlation: { scenarioId, attemptId: directorAttemptId(scenarioId), role: DIRECTOR_ROLE },
      });
      let applied: ExecutorConfig = settings;
      try {
        grant.bind(lease.session.sessionId);
        const adapter = execution.pool.adapterOf(profile.client);
        const base = adapter.configOptionsFor(settings);
        for (const [id, value] of Object.entries(base)) {
          await lease.session.setConfig(id, value);
        }
        // P14 (N242): the model and the effort the Producer chose, for the Executor they were chosen for.
        if (override?.executor === picked.executor.id) {
          const wanted: ExecutorConfig = {
            ...settings,
            ...(override.model === undefined ? {} : { model: override.model }),
            ...(override.effort === undefined ? {} : { effort: override.effort }),
          };
          try {
            for (const [id, value] of Object.entries(adapter.configOptionsFor(wanted))) {
              if (base[id] !== value) await lease.session.setConfig(id, value);
            }
            applied = wanted;
          } catch (error) {
            // The client does not take what was chosen (the model went away, say): the session runs
            // with the settings of the list, and the log tells it.
            this.#options.logger.warn(
              { err: error, scenarioId, executor: picked.executor.id },
              'the client refused the model or effort chosen for the Director: using the ones of the list',
            );
          }
        }
      } catch (error) {
        await lease.release().catch(() => undefined);
        throw error;
      }
      return { lease, grant, picked, settings: applied };
    } catch (error) {
      grant.revoke();
      throw error;
    }
  }

  async #open(scenarioId: string): Promise<DirectorSession> {
    const { dispatcher, logger } = this.#options;
    const prefix = assemblePrefix({
      role: DIRECTOR_ROLE,
      rolePrompt: await this.#options.prompts.get(DIRECTOR_ROLE),
      tools: this.#options.registries.tools.list(),
    });
    const session: DirectorSession = {
      scenarioId,
      lease: undefined,
      grant: undefined,
      prefix,
      sleptAt: undefined,
      waking: undefined,
      parked: undefined,
      abort: new AbortController(),
      idleTimer: undefined,
      attachment: undefined,
      replies: [],
      seq: 0,
      active: false,
      failed: false,
      executor: undefined,
      failedExecutors: new Set(),
      failover: undefined,
      leaving: false,
      left: undefined,
      settings: undefined,
      pendingSwitch: undefined,
      prefixed: false,
      summaryNeeded: false,
    };
    // Registered before the opening, so `close` reaches a Director that is still waiting.
    this.#opened.set(scenarioId, session);
    try {
      // Settles when the session is open or, under `director_wait: wait`, when it holds for an Executor.
      await this.#wake(session);
    } catch (error) {
      this.#opened.delete(scenarioId);
      throw error;
    }
    // Attached before the Director has an Executor: a prompt already in the queue waits in
    // `#turn` for the opening, and goes in the moment the session is open.
    session.attachment = dispatcher.attach(scenarioId, (item) =>
      this.#turn(session, item).catch((error: unknown) => {
        logger.error({ err: error, scenarioId }, 'the Director session failed a turn');
        throw error;
      }),
    );
    this.#arm(session);
    return session;
  }

  async #turn(session: DirectorSession, item: PromptQueueItem): Promise<void> {
    // A prompt can arrive for a sleeping Director (nobody called `ensure`): it wakes first, and
    // stays here while the Director waits for an Executor (N141).
    await this.#awake(session);
    // A manual switch (P14) may have taken the session between the wake and here: wait for the new one.
    await this.#applyPendingSwitch(session);
    for (let again = 0; again < 3 && session.lease === undefined; again += 1) {
      await this.#awake(session);
    }
    session.idleTimer?.abort();
    session.idleTimer = undefined;
    const { lease } = session;
    if (lease === undefined) throw new AdapterUnavailable('The Director session is not open.');
    // Set before anything awaits, so a switch that arrives now waits for the end of this turn.
    session.active = true;
    const { text: raw } = item.content as { text?: unknown };
    const body = typeof raw === 'string' ? raw : '';
    let text = body;
    let startedAt: number | undefined;
    try {
      if (!session.prefixed) {
        const state = session.summaryNeeded
          ? `${renderStateSummary(await stateSummaryOf(this.#options.store, session.scenarioId))}\n`
          : '';
        text = `${session.prefix}\n${state}${body}`;
      }
      // Where the log stood when the turn began: a `play.created` after it may be the play it opened.
      startedAt = await this.#lastEventId();
    } catch (error) {
      session.active = false;
      throw error;
    }
    let reply = '';
    let failure: DirectorFailure | undefined;
    let failedWith: unknown;
    let ended = false;
    const tools = new TurnTools();
    const subscription = lease.session.onUpdate((update) => {
      reply += textOf(update);
      tools.note(update);
    });
    const limit = this.#turnLimit(session, lease);
    try {
      const prompt = lease.session.prompt([{ type: 'text', text }]);
      await (limit === undefined ? prompt : Promise.race([prompt, limit.expired]));
      // A turn cut by the removal of its profile (P21b) may come back as if it had ended: what it
      // said is not the answer, so the prompt goes back to the queue like after an error.
      if (session.leaving) throw LEAVING_ERROR;
      session.prefixed = true;
      session.summaryNeeded = false;
      session.failed = false;
      session.failedExecutors.clear();
      ended = true;
    } catch (error) {
      session.failed = true;
      reply = `${reply}\n[${error instanceof Error ? error.message : String(error)}]`;
      // The profile leaving is what ended the turn (P21b), whatever error the session ended with.
      failure = session.leaving ? PROFILE_REMOVED : directorFailureOf(error);
      failedWith = session.leaving ? LEAVING_ERROR : error;
      throw error;
    } finally {
      limit?.stop();
      subscription.dispose();
      session.active = false;
      if (reply.trim() !== '') {
        this.#keep(session, item, reply.trim());
      } else if (ended) {
        // N183: a turn that worked and said nothing. A failed turn always has its error in `reply`.
        await this.#silent(session, item, tools.list(), startedAt);
      }
      // P20: replaced once the reply is kept; the error still goes up, so the prompt stays in the
      // queue and the pump stops (`PromptDispatcher`): the new session restarts it.
      if (failure !== undefined && this.#answers(failure)) {
        await this.#failover(session, item, failure, failedWith).catch((error: unknown) => {
          this.#options.logger.error(
            { err: error, scenarioId: session.scenarioId },
            'the Director could not be replaced',
          );
        });
      }
      // Whatever came of it, a leave waiting for this turn is not kept waiting.
      if (session.leaving && session.lease === undefined) this.#letGo(session);
      await this.#applyPendingSwitch(session);
      this.#arm(session);
    }
  }

  /**
   * `limits.turn_timeout` for a turn of the Director (N184), the same key the attempts use. It
   * needs the clock; without one, or with `limits.on_turn_timeout: off`, there is no limit. `cancel`:
   * `expired` rejects after the event is written (and the session is cancelled), so the turn fails
   * like any other failed turn (its error is the reply `[...]` of the chat); `notice`: only the
   * event `session.turn_timeout`, and the turn goes on. `stop` ends the timer with the turn.
   */
  #turnLimit(
    session: DirectorSession,
    lease: SessionLease,
  ): { readonly expired: Promise<never>; readonly stop: () => void } | undefined {
    const { clock, config, store, logger } = this.#options;
    const { turn_timeout: limitMs, on_turn_timeout: action } = config.limits;
    if (clock === undefined || action === 'off') return undefined;
    const started = clock.now();
    const timer = new AbortController();
    const expired = new Promise<never>((_, reject) => {
      clock.sleep(limitMs, timer.signal).then(
        async () => {
          try {
            await store.events.append({
              ...buildDaemonEvent('session.turn_timeout', {
                sessionId: lease.session.sessionId,
                limitMs,
                elapsedMs: clock.now() - started,
                action,
              }),
              scenarioId: session.scenarioId,
            });
          } catch (error) {
            logger.warn(
              { err: error, scenarioId: session.scenarioId },
              'the turn timeout of the Director could not be recorded',
            );
          }
          if (action !== 'cancel') return;
          // The turn fails first: the cancel makes the prompt come back as `cancelled`, which must
          // not be taken for an answer.
          reject(new TurnTimeoutError(limitMs));
          await lease.session.cancel().catch(() => undefined);
        },
        () => undefined,
      );
    });
    // Nobody may be waiting on `expired` any more when it rejects: never an unhandled rejection.
    expired.catch(() => undefined);
    return {
      expired,
      stop: () => {
        timer.abort();
      },
    };
  }

  /** Keeps a reply for the chat, in memory and as `onReply`, bounded by `chat.history`. */
  #keep(
    session: DirectorSession,
    item: PromptQueueItem,
    text: string,
    generated?: GeneratedReply,
  ): void {
    session.seq += 1;
    const kept: DirectorReply = {
      seq: session.seq,
      to: item.source,
      text,
      ...(generated === undefined ? {} : { generated }),
    };
    session.replies.push(kept);
    try {
      this.#options.onReply?.(session.scenarioId, kept);
    } catch (error) {
      this.#options.logger.warn(
        { err: error, scenarioId: session.scenarioId },
        'the reply of the Director could not be announced',
      );
    }
    const limit = this.#options.config.chat.history;
    if (session.replies.length > limit) session.replies.splice(0, session.replies.length - limit);
  }

  /**
   * N183: the turn ended without error and without text. The situation is always an event
   * (`chat.director_silent`); `chat.silent_turn: notice` (default) also keeps a short reply the
   * daemon generates from the tools the turn called, so the Producer is never left without an
   * answer, and `none` leaves the chat as it was.
   */
  async #silent(
    session: DirectorSession,
    item: PromptQueueItem,
    tools: readonly ChatToolCall[],
    startedAt: number | undefined,
  ): Promise<void> {
    const { scenarioId } = session;
    const mode = this.#options.config.chat.silent_turn;
    const playId = await this.#playOpenedSince(scenarioId, startedAt);
    this.#options.logger.warn(
      { scenarioId, tools: tools.map((tool) => tool.name), playId, mode },
      'the Director ended the turn without a reply',
    );
    try {
      this.#options.onSilent?.(scenarioId, { tools: [...tools], playId, mode });
    } catch (error) {
      this.#options.logger.warn(
        { err: error, scenarioId },
        'the silent turn of the Director could not be announced',
      );
    }
    if (mode === 'none') return;
    this.#keep(session, item, silentReplyText(tools, playId), { tools, playId });
  }

  async #lastEventId(): Promise<number | undefined> {
    try {
      return await this.#options.store.events.lastId();
    } catch (error) {
      this.#options.logger.warn({ err: error }, 'the position of the event log could not be read');
      return undefined;
    }
  }

  /**
   * The play the turn opened: the last `play.created` of the scenario after `afterId`. [proposta]
   * The ACP updates do not carry what a tool returned, so the id is read from the event the play
   * machine writes when it creates the play; a play another source creates in the same scenario
   * during the turn (the idea queue) could be taken for it. `null` when none, or when the log
   * could not be read.
   */
  async #playOpenedSince(scenarioId: string, afterId: number | undefined): Promise<string | null> {
    if (afterId === undefined) return null;
    const PAGE = 500;
    // A bounded read: a turn does not span an unbounded part of the log.
    const MAX_PAGES = 20;
    let found: string | null = null;
    let cursor = afterId;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const events = await this.#options.store.events.readFrom(cursor, PAGE);
        for (const event of events) {
          if (
            event.type === 'play.created' &&
            event.scenarioId === scenarioId &&
            event.playId !== undefined
          ) {
            found = event.playId;
          }
        }
        if (events.length < PAGE) break;
        cursor = events[events.length - 1]?.id ?? cursor;
      }
    } catch (error) {
      this.#options.logger.warn(
        { err: error, scenarioId },
        'the log could not be read for the play',
      );
    }
    return found;
  }

  /** Whether `scenarios.director_failover` replaces the session for this failure. */
  #answers(failure: DirectorFailure): boolean {
    // The removal of the profile is governed by `profiles.drain.director`, which only calls
    // `leaveProfile` when it is `failover`; `scenarios.director_failover` is for errors.
    if (failure.cause === PROFILE_REMOVED.cause) return true;
    return failoverApplies(this.#options.config.scenarios.director_failover, failure.cause);
  }

  /**
   * P20 (architecture 5.4, "Failover do Orquestrador"): the session of the Director failed for a
   * cause a new session can answer. The failed session goes back to the pool and a new one opens
   * with the next Executor of the `director` role (the same opening as the wake of P9, so the
   * `selection.director_wait` wait of P16b applies: with nobody available the queue waits and the
   * Producer is told). Its first prompt carries the role prefix and the state summary, so the
   * directives in force come with it. The prompt in progress stays in the queue, in its place;
   * when the session is open the pump goes on with it.
   */
  async #failover(
    session: DirectorSession,
    item: PromptQueueItem | undefined,
    failure: DirectorFailure,
    error: unknown,
  ): Promise<void> {
    try {
      await this.#replace(session, item, failure, error);
    } finally {
      // The lease of the leaving profile is gone, or the Director is closing: `leaveProfile` goes on.
      if (session.leaving && session.lease === undefined) this.#letGo(session);
    }
  }

  async #replace(
    session: DirectorSession,
    item: PromptQueueItem | undefined,
    failure: DirectorFailure,
    error: unknown,
  ): Promise<void> {
    const { quota, logger } = this.#options;
    session.idleTimer?.abort();
    session.idleTimer = undefined;
    if (session.abort.signal.aborted || session.waking !== undefined) return;
    const { lease, grant } = session;
    const from = session.executor ?? null;
    const profile = lease?.profileId;
    let cause = failure.cause;
    let resetsAt: number | null = null;
    let explained = false;
    if (failure.cause === 'quota_exhausted' && profile !== undefined && quota !== undefined) {
      try {
        const status = await quota.ingestLimitHit(
          profile,
          failure.limitHit ?? { source: 'error:QuotaExhausted' },
        );
        explained = status.state === 'exhausted';
        resetsAt = status.untilReset;
        if (explained && status.cause === 'budget') cause = 'spend_cap';
      } catch (quotaError) {
        logger.warn(
          { err: quotaError, scenarioId: session.scenarioId },
          'the quota service did not answer the failover of the Director',
        );
      }
    }
    // What the quota explains the selection already leaves out; the rest is left out by the failover.
    if (from !== null && !explained) session.failedExecutors.add(from);
    session.lease = undefined;
    session.grant = undefined;
    session.executor = undefined;
    session.prefixed = false;
    session.summaryNeeded = true;
    session.failed = false;
    session.failover = {
      from,
      cause,
      resetsAt,
      detail: situationText(error),
      requeued: item?.id ?? null,
      announcedWaiting: false,
    };
    logger.warn(
      { scenarioId: session.scenarioId, cause, from, prompt: item?.id ?? null },
      'the Director session failed: opening another',
    );
    await lease?.release().catch((releaseError: unknown) => {
      logger.warn({ err: releaseError, scenarioId: session.scenarioId }, 'the lease did not go');
    });
    grant?.revoke();
    // The leaving profile is let go of before the new session starts to open: that is all the
    // removal waits for, never for an Executor to be found.
    if (session.leaving) this.#letGo(session);
    // Not awaited: the failed turn ends first, so the pump stops and `dispatcher.resume` can start
    // it again once the session is open. A failure of the opening is told by `#settleFailover`.
    this.#wake(session).catch(() => undefined);
  }

  // ---- the manual switch of the Director (P14, N242) ----

  /** The Executors of the `director` role of the scenario, in the order of the list. */
  async #directorList(scenarioId: string): Promise<readonly ResolvedExecutor[]> {
    const { roles } = await this.#options.selection.selectorInputs(scenarioId);
    const role = (
      roles as Readonly<
        Record<string, { readonly executors: readonly ResolvedExecutor[] } | undefined>
      >
    )[DIRECTOR_ROLE];
    return role?.executors ?? [];
  }

  async #quotaOf(executor: ResolvedExecutor): Promise<QuotaStatus | null> {
    const { quota, logger } = this.#options;
    if (quota?.statusOf === undefined) return null;
    try {
      return await quota.statusOf(`${executor.entry.client}/${executor.entry.profile}`);
    } catch (error) {
      logger.warn({ err: error, executor: executor.id }, 'the quota of an Executor was not read');
      return null;
    }
  }

  /**
   * The Director of a scenario as the Producer sees it (the footer and the picker of the TUI, and
   * `/director`): what it runs with, the Executors of its list with validity and quota, and the
   * models and efforts the open session announced. Opens nothing: a Director that sleeps shows
   * what it would wake with, and its models are not listed (no session to ask) [proposta].
   */
  async view(scenarioId: string): Promise<DirectorView> {
    const { store, config } = this.#options;
    const scenario = await store.scenarios.get(scenarioId);
    if (scenario === undefined) throw new NotFound(`There is no scenario "${scenarioId}"`);
    const list = await this.#directorList(scenarioId);
    const override = readDirectorOverride(scenario.configOverride);
    const session = this.#opened.get(scenarioId);
    const first = list.find((item) => item.validity === 'valid');
    const pinned =
      override === null
        ? undefined
        : list.find((item) => item.id === override.executor && item.validity === 'valid');
    const running =
      session?.lease !== undefined && session.executor !== undefined
        ? list.find((item) => item.id === session.executor)
        : undefined;
    const current = running ?? pinned ?? first;
    const options = session?.lease?.session.configOptions ?? [];
    const quotas = await Promise.all(list.map((item) => this.#quotaOf(item)));
    const settings = running === undefined ? undefined : session?.settings;
    const model =
      settings?.model ?? (current === pinned ? override?.model : undefined) ?? current?.entry.model;
    const effort =
      settings === undefined
        ? ((current === pinned ? override?.effort : undefined) ?? current?.entry.effort ?? null)
        : (settings.effort ?? null);
    const efforts = optionChoices(options, 'thought_level').map((choice) => choice.value);
    let state: DirectorView['session'] = 'none';
    if (session !== undefined) {
      if (session.lease !== undefined) state = 'open';
      else state = session.waking !== undefined ? 'opening' : 'asleep';
    }
    return {
      scenarioId,
      session: state,
      inTurn: session !== undefined && (session.active || session.waking !== undefined),
      pending: session?.pendingSwitch !== undefined,
      current:
        current === undefined || model === undefined
          ? null
          : {
              executor: current.id,
              client: current.entry.client,
              profile: current.entry.profile,
              model,
              effort,
            },
      override,
      default: first?.id ?? null,
      executors: list.map((item, index): DirectorViewExecutor => ({
        index: index + 1,
        id: item.id,
        client: item.entry.client,
        profile: item.entry.profile,
        model: item.entry.model,
        effort: item.entry.effort,
        validity: item.validity,
        invalidReason: item.invalidReason ?? null,
        quota: quotas[index]?.state ?? null,
        quotaResetsAt: quotas[index]?.untilReset ?? null,
        current: item.id === current?.id,
        isDefault: item.id === first?.id,
      })),
      models: optionChoices(options, 'model').map((choice): DirectorViewModel => ({
        id: choice.value,
        name: choice.name ?? null,
        efforts,
      })),
      efforts,
      inTurnMode: config.scenarios.director_switch.in_turn,
    };
  }

  /**
   * Switches the Director of the scenario by hand, or takes it back to the default (P14, N242). The
   * choice is stored in the scenario (it outlives the sleep and the daemon) until the default is
   * asked for. With the session open and idle the switch is carried out now (`switchForm`); in a
   * turn it waits for the turn to end (`scenarios.director_switch.in_turn: wait`) or cancels the
   * turn first (`interrupt`). One switch at a time for each scenario.
   */
  async switchDirector(
    scenarioId: string,
    change: DirectorSwitchChange,
  ): Promise<DirectorSwitchResult> {
    const before = this.#switching.get(scenarioId) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(() => this.#switch(scenarioId, change));
    this.#switching.set(scenarioId, run);
    try {
      return await run;
    } finally {
      if (this.#switching.get(scenarioId) === run) this.#switching.delete(scenarioId);
    }
  }

  async #switch(scenarioId: string, change: DirectorSwitchChange): Promise<DirectorSwitchResult> {
    const { store, config } = this.#options;
    const scenario = await store.scenarios.get(scenarioId);
    if (scenario === undefined) throw new NotFound(`There is no scenario "${scenarioId}"`);
    if (scenario.state !== 'active') {
      throw new Conflict(
        `The scenario "${scenarioId}" is archived: its Director cannot be switched.`,
      );
    }
    const list = await this.#directorList(scenarioId);
    const session = this.#opened.get(scenarioId);
    const current = readDirectorOverride(scenario.configOverride);
    const wanted = this.#wantedOverride(session, list, current, change);
    await store.scenarios.update(scenarioId, {
      configOverride: writeDirectorOverride(scenario.configOverride, wanted),
    });
    const mode = config.scenarios.director_switch.in_turn;
    // A session that is open, in a turn or opening: the switch waits for it (or cancels the turn).
    if (session !== undefined && (session.active || session.waking !== undefined)) {
      const waiting = session.pendingSwitch ?? deferred();
      session.pendingSwitch = waiting;
      if (mode === 'interrupt' && session.active) {
        await this.interrupt(scenarioId);
        await waiting.promise;
        return this.#resultOf(scenarioId, wanted, 'applied');
      }
      return this.#resultOf(scenarioId, wanted, 'pending');
    }
    const outcome =
      session?.lease === undefined
        ? ({ form: 'stored' } as const)
        : await this.#reconcile(session, list, wanted);
    if (outcome === 'busy') {
      // A turn began in the meantime: it ends the wait.
      const waiting = session?.pendingSwitch ?? deferred();
      if (session !== undefined) session.pendingSwitch = waiting;
      return this.#resultOf(scenarioId, wanted, 'pending');
    }
    await this.#announceSwitch(
      scenarioId,
      session,
      outcome.form,
      wanted,
      outcome.from ?? null,
      false,
    );
    return this.#resultOf(scenarioId, wanted, 'applied', outcome.form);
  }

  async #resultOf(
    scenarioId: string,
    override: DirectorOverride | null,
    status: DirectorSwitchResult['status'],
    form: DirectorSwitchForm | null = null,
  ): Promise<DirectorSwitchResult> {
    return { status, form, override, view: await this.view(scenarioId) };
  }

  /** The override a change asks for, checked against the list of the role and what the client announced. */
  #wantedOverride(
    session: DirectorSession | undefined,
    list: readonly ResolvedExecutor[],
    current: DirectorOverride | null,
    change: DirectorSwitchChange,
  ): DirectorOverride | null {
    if (change.kind === 'default') return null;
    const first = list.find((item) => item.validity === 'valid');
    let target: ResolvedExecutor | undefined;
    if (change.executor !== undefined && change.executor.trim() !== '') {
      const found = matchExecutor(list, change.executor);
      if (found === 'ambiguous') {
        throw new InvalidInput(
          `More than one Executor of the Director starts with "${change.executor}".`,
        );
      }
      if (found === undefined) {
        throw new InvalidInput(`"${change.executor}" is not an Executor of the Director list.`);
      }
      target = found;
    } else {
      const running = session?.lease === undefined ? undefined : session.executor;
      const id = running ?? current?.executor ?? first?.id;
      target = list.find((item) => item.id === id);
      if (target === undefined) throw new InvalidInput('The Director has no Executor to change.');
    }
    if (target.validity !== 'valid') {
      throw new Conflict(
        `The Executor "${target.id}" is not valid${target.invalidReason === null ? '' : `: ${target.invalidReason}`}.`,
      );
    }
    // The model and the effort of the previous override belong to the Executor it named.
    const kept = current?.executor === target.id ? current : null;
    const model = change.model ?? kept?.model;
    const effort = change.effort ?? kept?.effort;
    const options = session?.lease?.session.configOptions ?? [];
    if (change.model !== undefined && session?.executor === target.id) {
      this.#assertAnnounced(options, 'model', change.model);
    }
    if (change.effort !== undefined && session?.executor === target.id) {
      this.#assertAnnounced(options, 'thought_level', change.effort);
    }
    return {
      executor: target.id,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    };
  }

  /** A value the client announced a list for must be on it; with no list there is nothing to check. */
  #assertAnnounced(options: readonly SessionConfigOption[], category: string, value: string): void {
    const choices = optionChoices(options, category);
    if (choices.length > 0 && !choices.some((choice) => choice.value === value)) {
      throw new InvalidInput(
        `"${value}" is not one the client offers (${choices.map((choice) => choice.value).join(', ')}).`,
      );
    }
  }

  /**
   * Brings the open session to the override of the scenario (`null`: the default). Called with
   * the session open and idle; `busy` when that stopped being true. The Executor and the settings
   * the session runs with are compared with the target:
   * - the same, `unchanged`;
   * - the same Executor with another model or effort that the client lets the session change,
   *   `live` (the config option of the open session);
   * - the same Executor with an option the client does not announce, `baton`: a new session of the
   *   same Executor; another Executor, `new_session`. Either way the first prompt of the new
   *   session carries the role prefix and the state summary.
   */
  async #reconcile(
    session: DirectorSession,
    list: readonly ResolvedExecutor[],
    wanted: DirectorOverride | null,
  ): Promise<
    'busy' | { readonly form: DirectorSwitchForm; readonly from?: string | null | undefined }
  > {
    const { execution, selection } = this.#options;
    const target = await this.#targetOf(list, wanted);
    const { lease } = session;
    if (session.active || session.waking !== undefined || lease === undefined) {
      return session.active || session.waking !== undefined ? 'busy' : { form: 'stored' };
    }
    if (target === undefined) return { form: 'stored' };
    const from = session.executor ?? null;
    const base = selection.sessionOf(DIRECTOR_ROLE, target).settings;
    const want: ExecutorConfig = {
      ...base,
      ...(wanted?.executor === target.id && wanted.model !== undefined
        ? { model: wanted.model }
        : {}),
      ...(wanted?.executor === target.id && wanted.effort !== undefined
        ? { effort: wanted.effort }
        : {}),
    };
    const have = session.settings;
    if (target.id === session.executor && have !== undefined) {
      if (have.model === want.model && have.effort === want.effort)
        return { form: 'unchanged', from };
      const adapter = execution.pool.adapterOf(target.entry.client);
      const now = adapter.configOptionsFor(have);
      const next = adapter.configOptionsFor(want);
      const changes = Object.entries(next).filter(([id, value]) => now[id] !== value);
      const announced = lease.session.configOptions;
      if (changes.every(([id]) => announced.some((option) => option.id === id))) {
        try {
          for (const [id, value] of changes) await lease.session.setConfig(id, value);
          session.settings = want;
          return { form: 'live', from };
        } catch (error) {
          this.#options.logger.warn(
            { err: error, scenarioId: session.scenarioId },
            'the client did not take the new model or effort: passing the baton',
          );
          if (this.#inTurn(session) || session.lease !== lease) return 'busy';
        }
      }
      await this.#restart(session);
      return { form: 'baton', from };
    }
    await this.#restart(session);
    return { form: 'new_session', from };
  }

  /** The Executor the Director goes by for an override: the chosen one or, for the default, the first one that can take it. */
  async #targetOf(
    list: readonly ResolvedExecutor[],
    wanted: DirectorOverride | null,
  ): Promise<ResolvedExecutor | undefined> {
    if (wanted !== null) return list.find((item) => item.id === wanted.executor);
    for (const item of list) {
      if (item.validity !== 'valid') continue;
      const status = await this.#quotaOf(item);
      // Only an exhausted profile is passed over (as the selection does): an unknown quota can serve.
      if (status?.state !== 'exhausted') return item;
    }
    return undefined;
  }

  /**
   * Gives the open session back and opens another one (the sleep, without the sleeping): the new
   * session reads the override of the scenario, and its first prompt carries the role prefix and
   * the state summary. Resolves when it is open, or when the opening holds for an Executor.
   */
  async #restart(session: DirectorSession): Promise<void> {
    const { lease, grant } = session;
    session.idleTimer?.abort();
    session.idleTimer = undefined;
    session.lease = undefined;
    session.grant = undefined;
    session.executor = undefined;
    session.settings = undefined;
    session.prefixed = false;
    session.summaryNeeded = true;
    await lease?.release().catch((error: unknown) => {
      this.#options.logger.warn(
        { err: error, scenarioId: session.scenarioId },
        'the lease of the Director did not go',
      );
    });
    grant?.revoke();
    await this.#wake(session);
    if (this.#leased(session)) this.#arm(session);
  }

  /** A turn is running or the session is opening (read again after every await: TS cannot see it change). */
  #inTurn(session: DirectorSession): boolean {
    return session.active || session.waking !== undefined;
  }

  /** The session holds a lease now. */
  #leased(session: DirectorSession): boolean {
    return session.lease !== undefined;
  }

  /** Carries out the switch that waited for the end of a turn or of an opening. Never throws. */
  async #applyPendingSwitch(session: DirectorSession): Promise<void> {
    const pending = session.pendingSwitch;
    if (pending === undefined || session.active || session.waking !== undefined) return;
    // Taken at once: the end of a turn can call this twice, and the switch is carried out once.
    session.pendingSwitch = undefined;
    if (session.abort.signal.aborted) {
      pending.resolve();
      return;
    }
    const { store, logger } = this.#options;
    try {
      const scenario = await store.scenarios.get(session.scenarioId);
      const wanted = scenario === undefined ? null : readDirectorOverride(scenario.configOverride);
      const list = await this.#directorList(session.scenarioId);
      const outcome =
        session.lease === undefined
          ? ({ form: 'stored' } as const)
          : await this.#reconcile(session, list, wanted);
      if (outcome === 'busy') {
        // A turn began in the meantime: its end carries the switch out.
        session.pendingSwitch ??= pending;
        return;
      }
      await this.#announceSwitch(
        session.scenarioId,
        session,
        outcome.form,
        wanted,
        outcome.from ?? null,
        true,
      );
      pending.resolve();
    } catch (error) {
      logger.error(
        { err: error, scenarioId: session.scenarioId },
        'the switch of the Director that waited could not be carried out',
      );
      pending.resolve();
    }
  }

  /** The `scenario.director_switched` event and the notice of the chat. Never throws. */
  async #announceSwitch(
    scenarioId: string,
    session: DirectorSession | undefined,
    form: DirectorSwitchForm,
    wanted: DirectorOverride | null,
    from: string | null,
    waited: boolean,
  ): Promise<void> {
    const { store, logger, onNotice } = this.#options;
    const running = session?.lease === undefined ? undefined : session;
    const payload: ScenarioDirectorSwitchedPayload = {
      scenarioId,
      form,
      fromExecutor: from,
      toExecutor: running?.executor ?? null,
      model: running?.settings?.model ?? wanted?.model ?? null,
      effort: running?.settings?.effort ?? wanted?.effort ?? null,
      override: wanted !== null,
      waited,
    };
    const notice: ScenarioDirectorSwitchNotice = { ...payload, kind: 'director_switch' };
    try {
      await store.transaction(async (tx) => {
        await tx.events.append({
          ...buildDaemonEvent('scenario.director_switched', payload),
          scenarioId,
        });
        await tx.events.append({
          ...buildDaemonEvent('scenario.system_message', notice),
          scenarioId,
        });
      });
      onNotice?.(notice);
    } catch (error) {
      logger.warn({ err: error, scenarioId }, 'the switch notice of the Director was lost');
    }
  }

  /** The `waiting` notice of the failover in course: nobody is free, the queue waits (P16b). */
  #announceWaiting(session: DirectorSession): void {
    const { failover } = session;
    if (failover === undefined || failover.announcedWaiting) return;
    failover.announcedWaiting = true;
    void this.#announce(session, failover, 'waiting', null);
  }

  /**
   * Closes the failover in course: the new session is open (`switched`, and the queue goes on) or
   * the opening failed (`unavailable`: the prompt waits for the next one to try again).
   */
  async #settleFailover(
    session: DirectorSession,
    outcome: 'switched' | 'unavailable',
    to: string | null,
    error?: unknown,
  ): Promise<void> {
    const { failover } = session;
    if (failover === undefined) return;
    session.failover = undefined;
    if (session.abort.signal.aborted) return;
    if (outcome === 'unavailable') {
      session.failed = true;
      session.failedExecutors.clear();
    }
    await this.#announce(session, failover, outcome, to, error);
    if (outcome === 'switched') {
      const { dispatcher } = this.#options;
      void dispatcher.idle(session.scenarioId).then(() => {
        dispatcher.resume(session.scenarioId);
      });
    }
  }

  /** The `scenario.system_message` of the failover, in the log and in the chat. Never throws. */
  async #announce(
    session: DirectorSession,
    failover: PendingFailover,
    outcome: ScenarioDirectorFailoverNotice['outcome'],
    to: string | null,
    error?: unknown,
  ): Promise<void> {
    const { store, logger, onNotice } = this.#options;
    const { scenarioId } = session;
    const detail =
      error === undefined ? failover.detail : (situationText(error) ?? failover.detail);
    const notice: ScenarioDirectorFailoverNotice = {
      scenarioId,
      kind: 'director_failover',
      outcome,
      cause: failover.cause,
      fromExecutor: failover.from,
      toExecutor: to,
      requeued: failover.requeued,
      resetsAt: failover.resetsAt,
      detail,
    };
    try {
      await store.events.append({
        ...buildDaemonEvent('scenario.system_message', notice),
        scenarioId,
      });
      onNotice?.(notice);
    } catch (announceError) {
      logger.warn(
        { err: announceError, scenarioId },
        'the failover notice of the Director was lost',
      );
    }
  }
}
