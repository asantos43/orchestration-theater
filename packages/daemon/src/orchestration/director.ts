// SPDX-License-Identifier: MPL-2.0
import { buildDaemonEvent } from '@otheater/protocol';
import {
  AdapterUnavailable,
  assemblePrefix,
  type Clock,
  type Disposable,
  NotFound,
  type NormalizedUpdate,
  type PromptQueueItem,
  type PromptSource,
  type Registries,
  renderStateSummary,
  stateSummaryOf,
  type Store,
} from '@otheater/core';
import type { DaemonConfig } from '../config.js';
import type { SessionLease } from '../execution/pool.js';
import type { Execution } from '../execution/service.js';
import type { Logger } from '../logger.js';
import type { McpAccess, McpGrant } from '../mcp/access.js';
import type { DataPaths } from '../paths.js';
import type { PromptDispatcher } from '../prompt-dispatcher.js';
import { executorOf, policyOf, sessionSettingsOf } from './roles.js';

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
}

export interface DirectorSessionsOptions {
  readonly store: Store;
  readonly execution: Execution;
  readonly mcp: McpAccess;
  readonly dispatcher: PromptDispatcher;
  readonly prompts: PromptSource;
  readonly registries: Registries;
  readonly config: DaemonConfig;
  readonly paths: Pick<DataPaths, 'profiles'>;
  readonly logger: Logger;
  /**
   * Drives the idle timer. Without it a Director never sleeps (the tests that do not care about
   * time, and the daemon of the previous steps, keep the old behaviour).
   */
  readonly clock?: Clock;
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
  /** Opening the session again (single flight). */
  waking: Promise<void> | undefined;
  /** Cancels the idle wait. */
  idleTimer: AbortController | undefined;
  attachment: Disposable | undefined;
  readonly replies: DirectorReply[];
  seq: number;
  /** A turn is running. */
  active: boolean;
  /** The last turn failed: the queue does not move until the session is opened again. */
  failed: boolean;
  /** The prefix of the role goes into the first prompt of the session. */
  prefixed: boolean;
  /** The session was opened again after a sleep: its first prompt carries the state summary. */
  summaryNeeded: boolean;
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
 */
export class DirectorSessions {
  readonly #options: DirectorSessionsOptions;
  readonly #sessions = new Map<string, Promise<DirectorSession>>();
  readonly #opened = new Map<string, DirectorSession>();

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
    if (session.active) return true;
    if (session.failed) return false;
    const pending = await this.#options.store.promptQueue.list({
      scenarioId,
      states: ['pending'],
    });
    return pending.length > 0;
  }

  /** Ends every session. Idempotent. */
  async close(): Promise<void> {
    const opened = [...this.#opened.values()];
    this.#opened.clear();
    this.#sessions.clear();
    for (const session of opened) {
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
    await store.scenarios.update(session.scenarioId, { directorState: 'asleep' });
    await store.events.append({
      ...buildDaemonEvent('scenario.director_slept', {
        scenarioId: session.scenarioId,
        idleMs,
      }),
      scenarioId: session.scenarioId,
    });
  }

  /** Opens a session again for a sleeping Director (single flight). */
  #wake(session: DirectorSession): Promise<void> {
    if (session.lease !== undefined) return Promise.resolve();
    session.waking ??= (async () => {
      try {
        const { store } = this.#options;
        const { lease, grant } = await this.#acquire(session.scenarioId);
        session.lease = lease;
        session.grant = grant;
        const sleptAt = session.sleptAt ?? null;
        session.sleptAt = undefined;
        await store.scenarios.update(session.scenarioId, { directorState: 'active' });
        await store.events.append({
          ...buildDaemonEvent('scenario.director_woke', {
            scenarioId: session.scenarioId,
            sleptAt,
          }),
          scenarioId: session.scenarioId,
        });
      } finally {
        session.waking = undefined;
      }
    })();
    return session.waking;
  }

  /** The pool lease and the MCP grant of the Director of a scenario. */
  async #acquire(scenarioId: string): Promise<{ lease: SessionLease; grant: McpGrant }> {
    const { store, execution, mcp, config, paths } = this.#options;
    const scenario = await store.scenarios.get(scenarioId);
    if (scenario === undefined) throw new NotFound(`There is no scenario "${scenarioId}"`);
    const executor = executorOf(config, DIRECTOR_ROLE);
    if (executor === undefined) {
      throw new AdapterUnavailable(
        'No Executor is configured for the Director: set orchestration.executor (client, profile and model).',
      );
    }
    const repos = await store.scenarioRepos.list(scenarioId);
    const cwd = repos[0]?.path ?? scenario.folder;
    const { profile, executor: settings } = sessionSettingsOf(paths, executor);
    const policy = policyOf(DIRECTOR_ROLE);
    const grant = mcp.grant({
      attemptId: directorAttemptId(scenarioId),
      role: DIRECTOR_ROLE,
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
      });
      try {
        grant.bind(lease.session.sessionId);
        const adapter = execution.pool.adapterOf(profile.client);
        for (const [id, value] of Object.entries(adapter.configOptionsFor(settings))) {
          await lease.session.setConfig(id, value);
        }
      } catch (error) {
        await lease.release().catch(() => undefined);
        throw error;
      }
      return { lease, grant };
    } catch (error) {
      grant.revoke();
      throw error;
    }
  }

  async #open(scenarioId: string): Promise<DirectorSession> {
    const { dispatcher, logger } = this.#options;
    const { lease, grant } = await this.#acquire(scenarioId);
    const prefix = assemblePrefix({
      role: DIRECTOR_ROLE,
      rolePrompt: await this.#options.prompts.get(DIRECTOR_ROLE),
      tools: this.#options.registries.tools.list(),
    });
    const session: DirectorSession = {
      scenarioId,
      lease,
      grant,
      prefix,
      sleptAt: undefined,
      waking: undefined,
      idleTimer: undefined,
      attachment: undefined,
      replies: [],
      seq: 0,
      active: false,
      failed: false,
      prefixed: false,
      summaryNeeded: false,
    };
    // Registered before the sender is attached: a prompt already in the queue starts at once.
    this.#opened.set(scenarioId, session);
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
    // A prompt can arrive for a sleeping Director (nobody called `ensure`): it wakes first.
    await this.#wake(session);
    session.idleTimer?.abort();
    session.idleTimer = undefined;
    const { lease } = session;
    if (lease === undefined) throw new AdapterUnavailable('The Director session is not open.');
    const { text: raw } = item.content as { text?: unknown };
    const body = typeof raw === 'string' ? raw : '';
    let text = body;
    if (!session.prefixed) {
      const state = session.summaryNeeded
        ? `${renderStateSummary(await stateSummaryOf(this.#options.store, session.scenarioId))}\n`
        : '';
      text = `${session.prefix}\n${state}${body}`;
    }
    let reply = '';
    session.active = true;
    const subscription = lease.session.onUpdate((update) => {
      reply += textOf(update);
    });
    try {
      await lease.session.prompt([{ type: 'text', text }]);
      session.prefixed = true;
      session.summaryNeeded = false;
      session.failed = false;
    } catch (error) {
      session.failed = true;
      reply = `${reply}\n[${error instanceof Error ? error.message : String(error)}]`;
      throw error;
    } finally {
      subscription.dispose();
      session.active = false;
      if (reply.trim() !== '') {
        session.seq += 1;
        session.replies.push({ seq: session.seq, to: item.source, text: reply.trim() });
        const limit = this.#options.config.chat.history;
        if (session.replies.length > limit)
          session.replies.splice(0, session.replies.length - limit);
      }
      this.#arm(session);
    }
  }
}
