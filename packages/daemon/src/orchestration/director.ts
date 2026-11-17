// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  assemblePrefix,
  type Disposable,
  NotFound,
  type NormalizedUpdate,
  type PromptQueueItem,
  type PromptSource,
  type Registries,
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
}

interface DirectorSession {
  readonly scenarioId: string;
  readonly lease: SessionLease;
  readonly grant: McpGrant;
  attachment: Disposable | undefined;
  readonly replies: DirectorReply[];
  seq: number;
  /** A turn is running. */
  active: boolean;
  /** The last turn failed: the queue does not move until the session is opened again. */
  failed: boolean;
  /** The prefix of the role goes into the first prompt of the session. */
  prefixed: boolean;
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
 * [proposta] The session is a lease of the pool, like the one of an attempt, held until the daemon
 * stops (no idle timer, no reload after a crash: that is the reconciliation, P9). The replies
 * live in memory, bounded by `chat.history`; the queue and the events are what survives a restart.
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
      if (session.grant.attemptId === attemptId) return session.scenarioId;
    }
    return undefined;
  }

  /** Opens the session of the scenario, once; later calls get the same one. */
  ensure(scenarioId: string): Promise<void> {
    let opening = this.#sessions.get(scenarioId);
    if (opening === undefined) {
      opening = this.#open(scenarioId);
      this.#sessions.set(scenarioId, opening);
      opening.catch(() => this.#sessions.delete(scenarioId));
    }
    return opening.then(() => undefined);
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
      session.attachment?.dispose();
      await session.lease.release().catch(() => undefined);
      session.grant.revoke();
    }
  }

  async #open(scenarioId: string): Promise<DirectorSession> {
    const { store, execution, mcp, dispatcher, config, paths, logger } = this.#options;
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
    let lease: SessionLease;
    try {
      lease = await execution.pool.acquire({
        client: profile.client,
        profile,
        policy,
        cwd,
        mcpServers: [grant.server],
      });
      grant.bind(lease.session.sessionId);
      const adapter = execution.pool.adapterOf(profile.client);
      for (const [id, value] of Object.entries(adapter.configOptionsFor(settings))) {
        await lease.session.setConfig(id, value);
      }
    } catch (error) {
      grant.revoke();
      throw error;
    }
    const prefix = assemblePrefix({
      role: DIRECTOR_ROLE,
      rolePrompt: await this.#options.prompts.get(DIRECTOR_ROLE),
      tools: this.#options.registries.tools.list(),
    });
    const session: DirectorSession = {
      scenarioId,
      lease,
      grant,
      attachment: undefined,
      replies: [],
      seq: 0,
      active: false,
      failed: false,
      prefixed: false,
    };
    // Registered before the sender is attached: a prompt already in the queue starts at once.
    this.#opened.set(scenarioId, session);
    session.attachment = dispatcher.attach(scenarioId, (item) =>
      this.#turn(session, prefix, item).catch((error: unknown) => {
        logger.error({ err: error, scenarioId }, 'the Director session failed a turn');
        throw error;
      }),
    );
    return session;
  }

  async #turn(session: DirectorSession, prefix: string, item: PromptQueueItem): Promise<void> {
    const { text: raw } = item.content as { text?: unknown };
    const body = typeof raw === 'string' ? raw : '';
    const text = session.prefixed ? body : `${prefix}\n${body}`;
    let reply = '';
    session.active = true;
    const subscription = session.lease.session.onUpdate((update) => {
      reply += textOf(update);
    });
    try {
      await session.lease.session.prompt([{ type: 'text', text }]);
      session.prefixed = true;
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
    }
  }
}
