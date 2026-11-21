// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  Conflict,
  InvalidInput,
  NotFound,
  PermissionDenied,
  QuotaExhausted,
  hasErrorCode,
  type Clock,
  type Disposable,
  type NormalizedUpdate,
  type PermissionOutcome,
  type Registries,
  type RolePolicy,
  type SessionCommand,
  type Store,
  type Vcs,
} from '@otheater/core';
import {
  DIRECT_TEXT_MAX,
  buildDaemonEvent,
  type ApiDirectCommand,
  type ApiDirectItem,
  type ApiDirectSession,
  type ApiDirectSessionDetail,
  type DaemonEventPayloads,
  type DaemonEventType,
  type DirectCloseResult,
  type DirectPromoteResult,
  type DirectPromoteTarget,
  type DirectWorkspace,
  type OpenDirectResult,
} from '@otheater/protocol';
import type { DaemonConfig } from '../config.js';
import { resolveExistingPath } from '../execution/permission-log.js';
import type { SessionLease, SessionPool } from '../execution/pool.js';
import type { IdeaQueueService } from '../ideas/service.js';
import type { Logger } from '../logger.js';
import { openPlayFromNeed, type PlayOpening } from '../orchestration/open-play.js';
import { resolveRolePolicy } from '../orchestration/role-policy.js';
import type { RoleSelection } from '../orchestration/role-selection.js';
import { sweepDirectOrphans, type OrphanSweepResult } from './orphans.js';
import { situationSubject, situationText, writeSituation } from '../situations.js';
import { bareCommandName, clientPrefixOf, parseSlashLine } from '../slash/parse.js';

/**
 * The direct session with an Actor (Phase 7, P19; N44, N190; architecture 5.20). [proposta] The
 * Producer picks an Executor of the list of the Actor and talks to it without the Director in
 * between. The service holds the sessions of the daemon: each one is a lease of the pool (so the
 * launcher, the sandbox and the quota of the profile apply as for any Actor), a conversation the
 * clients read back whole, and a folder (`direct_session.workspace`).
 *
 * The Director never reads a direct session: nothing here goes to its prompt queue. What happens
 * is in the event log (`direct.session.*`), which is where a trajectory is read from.
 */

/** The role whose list of Executors and whose policy a direct session takes. */
export const DIRECT_ROLE = 'actor';

/** How long a closing waits for a turn that was cancelled to end before it goes on. */
const CANCEL_GRACE_MS = 5000;

export interface DirectSessionServiceOptions {
  readonly store: Pick<Store, 'events' | 'scenarios' | 'scenarioRepos'>;
  readonly config: DaemonConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly pool: Pick<SessionPool, 'acquire' | 'adapterOf'>;
  readonly selection: Pick<RoleSelection, 'once'>;
  readonly registries: Registries;
  readonly vcs: Vcs;
  /** `<data>/worktrees`: the worktree of a session is `<worktrees>/direct/<id>`. */
  readonly worktreeRoot: string;
  readonly ideas: Pick<IdeaQueueService, 'add'>;
  readonly opening: PlayOpening;
}

/** One session the daemon holds, open or closed. */
interface Live {
  readonly id: string;
  readonly scenarioId: string;
  readonly executor: string;
  readonly profile: string;
  readonly client: string;
  readonly model: string | null;
  readonly workspace: DirectWorkspace;
  readonly branch: string | null;
  /** The worktree of a `worktree` session; `null` for the other two. */
  readonly worktree: string | null;
  /** The repository (or folder) the worktree was cut from. */
  readonly repo: string;
  /** The commit the worktree started at: what its changes are measured against. */
  readonly base: string | null;
  readonly lease: SessionLease;
  readonly subscription: Disposable;
  readonly openedAt: number;
  readonly items: ApiDirectItem[];
  commands: readonly SessionCommand[];
  turn: number;
  state: 'idle' | 'running' | 'closed';
  lastActivityAt: number;
  closedAt: number | null;
  /** The turn that runs now, until it ends. */
  running: Promise<void> | undefined;
  /** The message of the Actor that is being written in the turn that runs. */
  streaming: Extract<ApiDirectItem, { kind: 'message' }> | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  closing: Promise<DirectCloseResult> | undefined;
  result: DirectCloseResult | undefined;
}

/** The text an event carries, cut at the schema's limit. */
function cut(text: string): { readonly text: string; readonly truncated: boolean } {
  return text.length > DIRECT_TEXT_MAX
    ? { text: text.slice(0, DIRECT_TEXT_MAX), truncated: true }
    : { text, truncated: false };
}

/** A line of a title, as the events carry it. */
function titleOf(outcome: PermissionOutcome): string {
  const { request } = outcome;
  const name = request.title ?? request.toolName ?? request.toolKind ?? 'unknown';
  return (name === '' ? 'unknown' : name).replaceAll(/\s+/g, ' ').slice(0, 500);
}

/**
 * The policy of a direct session: the Actor's, with no daemon MCP server (the shells of the
 * daemon need an attempt to bind to) and no shell of the client. `readonly` also drops `edit` and
 * `write`, sends any edit to layer 2 and answers every request with a rejection, so a write is
 * barred even in the folder of the scenario.
 */
export function directPolicyOf(base: RolePolicy, workspace: DirectWorkspace): RolePolicy {
  const common = { ...base, nativeShell: 'none', mcpServers: [], mcpTools: {} } as const;
  if (workspace !== 'readonly') return common;
  return {
    ...common,
    nativeTools: base.nativeTools.filter((tool) => tool === 'read' || tool === 'search'),
    editInWorktree: 'ask',
    onAsk: 'reject',
    rules: [],
  };
}

export class DirectSessionService {
  readonly #o: DirectSessionServiceOptions;
  readonly #sessions = new Map<string, Live>();
  /** Openings under way, by scenario, so `max_open` counts them. */
  readonly #opening = new Map<string, number>();
  #closing = false;

  constructor(options: DirectSessionServiceOptions) {
    this.#o = options;
  }

  /**
   * The start-up sweep of the worktrees of sessions that are gone (P27, N206): see `orphans.ts` and
   * `direct_session.orphans`. Called once, before the daemon takes requests; it never throws.
   */
  sweepOrphans(): Promise<OrphanSweepResult> {
    const { store, config, logger, vcs, worktreeRoot } = this.#o;
    return sweepDirectOrphans({
      vcs,
      events: store.events,
      logger,
      worktreeRoot,
      mode: config.direct_session.orphans,
      onClose: config.direct_session.on_close,
      live: new Set(
        [...this.#sessions.values()]
          .filter((live) => live.state !== 'closed')
          .map((live) => live.id),
      ),
    });
  }

  // ---- reads ----

  /** The sessions of a scenario: the open ones, then the closed, newest first. */
  async list(scenarioId: string): Promise<ApiDirectSession[]> {
    await this.#scenario(scenarioId);
    return [...this.#sessions.values()]
      .filter((live) => live.scenarioId === scenarioId)
      .sort((a, b) => {
        const open = Number(b.state !== 'closed') - Number(a.state !== 'closed');
        return open !== 0 ? open : b.openedAt - a.openedAt;
      })
      .map((live) => this.#summary(live));
  }

  /** One session with its conversation. */
  get(sessionId: string): ApiDirectSessionDetail {
    return this.#detail(this.#live(sessionId));
  }

  /** How many sessions of the scenario are open. */
  openIn(scenarioId: string): number {
    let count = 0;
    for (const live of this.#sessions.values()) {
      if (live.scenarioId === scenarioId && live.state !== 'closed') count += 1;
    }
    return count;
  }

  /**
   * The commands of the client a session announced, filtered by `chat.client_commands`; none when
   * they are off or the session is closed.
   */
  commandsOf(sessionId: string): ApiDirectCommand[] {
    return this.#commands(this.#live(sessionId));
  }

  // ---- opening ----

  /**
   * Opens a session. `executor` is an id of the list of the Actor; absent, the first that can take
   * it. A session that writes in the folder of the scenario returns `{ status: 'confirm' }` and
   * does nothing until the same request comes with `confirm: true` (`direct_session.confirm_scenario`).
   * Refusals are core errors, each also an event (`direct.session.refused`): `Conflict` at
   * `direct_session.max_open`, `InvalidInput` for an Executor that is not in the list,
   * `QuotaExhausted` while the profile has no quota, money or slot, `AdapterUnavailable` when
   * nobody can ever take it.
   */
  async open(
    scenarioId: string,
    input: {
      readonly executor?: string | undefined;
      readonly workspace?: DirectWorkspace | undefined;
      readonly confirm?: boolean | undefined;
    } = {},
  ): Promise<OpenDirectResult> {
    const { config } = this.#o;
    if (this.#closing) throw new AdapterUnavailable('The daemon is stopping');
    const scenario = await this.#scenario(scenarioId);
    if (scenario.state !== 'active') throw new Conflict(`Scenario "${scenarioId}" is archived`);
    const workspace = input.workspace ?? config.direct_session.workspace;
    if (
      workspace === 'scenario' &&
      config.direct_session.confirm_scenario === 'ask' &&
      input.confirm !== true
    ) {
      return { status: 'confirm', workspace };
    }
    const reserved = this.openIn(scenarioId) + (this.#opening.get(scenarioId) ?? 0);
    if (reserved >= config.direct_session.max_open) {
      const reason = `The scenario already has ${String(reserved)} direct sessions open (direct_session.max_open)`;
      await this.#refused(scenarioId, null, workspace, 'too_many', reason);
      throw new Conflict(reason);
    }
    this.#opening.set(scenarioId, (this.#opening.get(scenarioId) ?? 0) + 1);
    try {
      return {
        status: 'opened',
        workspace,
        session: await this.#open(scenario.id, workspace, input),
      };
    } finally {
      const left = (this.#opening.get(scenarioId) ?? 1) - 1;
      if (left <= 0) this.#opening.delete(scenarioId);
      else this.#opening.set(scenarioId, left);
    }
  }

  async #open(
    scenarioId: string,
    workspace: DirectWorkspace,
    input: { readonly executor?: string | undefined },
  ): Promise<ApiDirectSessionDetail> {
    const { selection, store, config, registries, pool, vcs, worktreeRoot } = this.#o;
    const wanted = input.executor;
    const once = await selection.once({
      role: DIRECT_ROLE,
      scenarioId,
      ...(wanted === undefined
        ? {}
        : {
            refuse: (item: { readonly id: string }) => (item.id === wanted ? null : 'direct_other'),
          }),
    });
    if (once.kind !== 'selected') {
      const known = once.result.skipped.some((item) => item.executor === wanted);
      if (wanted !== undefined && !known) {
        const reason = `"${wanted}" is not an Executor of the Actor list`;
        await this.#refused(scenarioId, null, workspace, 'not_available', reason);
        throw new InvalidInput(reason);
      }
      const profile = once.result.skipped.find((item) => item.executor === wanted)?.profile ?? null;
      if (once.kind === 'waiting') {
        await this.#refused(scenarioId, profile, workspace, 'waiting', once.reason);
        throw new QuotaExhausted(once.reason);
      }
      await this.#refused(scenarioId, profile, workspace, 'no_executor', once.reason);
      throw new AdapterUnavailable(once.reason);
    }

    const { profile, settings, executor } = once;
    const scenario = await this.#scenario(scenarioId);
    const repos = await store.scenarioRepos.list(scenarioId);
    const folder = repos[0]?.path ?? scenario.folder;
    const id = `direct-${randomUUID().slice(0, 8)}`;
    const branch = workspace === 'worktree' ? `direct/${id}` : null;
    const worktree = workspace === 'worktree' ? join(worktreeRoot, 'direct', id) : null;
    let base: string | null = null;
    const fail = async (error: unknown, wasCreated: boolean): Promise<never> => {
      if (wasCreated && worktree !== null) {
        await vcs
          .removeWorktree(worktree, { force: true, deleteBranch: true })
          .catch(() => undefined);
      }
      if (error instanceof QuotaExhausted || error instanceof AdapterUnavailable) {
        await this.#refused(scenarioId, profile.id, workspace, 'waiting', error.message);
      } else {
        await this.#refused(
          scenarioId,
          profile.id,
          workspace,
          'failed',
          situationText(error) ?? 'unknown',
        );
      }
      throw error;
    };

    let created = false;
    try {
      if (worktree !== null && branch !== null) {
        base = await vcs.headOf(folder);
        await vcs.createWorktree({ repo: folder, path: worktree, branch, base });
        created = true;
      }
    } catch (error) {
      return fail(error, created);
    }

    const actorPolicy = await resolveRolePolicy(
      { config, scenarios: store.scenarios, tools: () => registries.tools.list() },
      DIRECT_ROLE,
      scenarioId,
    );
    const policy = directPolicyOf(actorPolicy, workspace);
    // The notifications of the session reach `live` once it exists; the lease is needed first.
    const pending: { live: Live | undefined; early: NormalizedUpdate[] } = {
      live: undefined,
      early: [],
    };
    let lease: SessionLease;
    let subscription: Disposable;
    try {
      lease = await pool.acquire({
        client: profile.client,
        profile,
        policy,
        cwd: worktree ?? folder,
        permissions: {
          onDecision: (outcome) => {
            if (pending.live !== undefined) this.#decided(pending.live, outcome);
          },
          resolvePath: resolveExistingPath,
        },
      });
    } catch (error) {
      return fail(error, created);
    }
    try {
      const adapter = pool.adapterOf(profile.client);
      for (const [key, value] of Object.entries(adapter.configOptionsFor(settings))) {
        await lease.session.setConfig(key, value);
      }
      subscription = lease.session.onUpdate((update) => {
        if (pending.live === undefined) pending.early.push(update);
        else this.#updated(pending.live, update);
      });
    } catch (error) {
      await lease.release().catch(() => undefined);
      return fail(error, created);
    }

    const now = this.#o.clock.now();
    const live: Live = {
      id,
      scenarioId,
      executor: executor.id,
      profile: profile.id,
      client: profile.client,
      model: settings.model === '' ? null : settings.model,
      workspace,
      branch,
      worktree,
      repo: folder,
      base,
      lease,
      subscription,
      openedAt: now,
      items: [],
      commands: lease.session.availableCommands ?? [],
      turn: 0,
      state: 'idle',
      lastActivityAt: now,
      closedAt: null,
      running: undefined,
      streaming: undefined,
      idleTimer: undefined,
      closing: undefined,
      result: undefined,
    };
    pending.live = live;
    for (const update of pending.early) this.#updated(live, update);
    this.#sessions.set(id, live);
    this.#arm(live);
    await this.#emit(scenarioId, 'direct.session.opened', {
      sessionId: id,
      profile: profile.id,
      client: profile.client,
      workspace,
      branch,
      model: live.model,
    });
    return this.#detail(live);
  }

  // ---- the conversation ----

  /** Writes to the Actor and starts a turn; it runs on and the events tell its end. */
  async say(sessionId: string, text: string): Promise<{ turn: number }> {
    const live = this.#writable(sessionId);
    const body = text.trim();
    if (body === '') throw new InvalidInput('The message is empty');
    const turn = this.#begin(live);
    const kept = cut(body);
    this.#push(live, {
      kind: 'message',
      from: 'producer',
      turn,
      at: this.#o.clock.now(),
      text: body,
      streaming: false,
    });
    await this.#emit(live.scenarioId, 'direct.session.message', {
      sessionId,
      turn,
      from: 'producer',
      text: kept.text,
      truncated: kept.truncated,
    });
    this.#run(live, turn, body);
    return { turn };
  }

  /**
   * Runs a command of the client (`/claude:compact`): the same filters as the chat
   * (`chat.client_commands`, `chat.client_commands_allow`, `chat.slash_access`) and the commands the
   * session announced. It goes to the client as the text `/compact args`, as a turn.
   */
  async command(sessionId: string, line: string): Promise<{ turn: number }> {
    const { config } = this.#o;
    const live = this.#writable(sessionId);
    const parsed = parseSlashLine(line);
    if (parsed === undefined) throw new InvalidInput(`"${line.trim()}" is not a command`);
    if (config.chat.client_commands === 'off') {
      throw new PermissionDenied('The commands of the client are off (chat.client_commands: off)');
    }
    if (config.chat.slash_access === 'read_only') {
      throw new PermissionDenied('The commands change things and chat.slash_access is read_only');
    }
    const entry = this.#entries(live).find(
      (item) => item.id.toLowerCase() === parsed.name.toLowerCase(),
    );
    if (entry === undefined) {
      if (config.chat.client_commands === 'allowlist' && parsed.name.includes(':')) {
        throw new PermissionDenied(`"${parsed.name}" is not in chat.client_commands_allow`);
      }
      throw new InvalidInput(`The session has no command "${parsed.name}"`);
    }
    const turn = this.#begin(live);
    const sent = parsed.text === '' ? `/${entry.native}` : `/${entry.native} ${parsed.text}`;
    this.#push(live, {
      kind: 'command',
      turn,
      at: this.#o.clock.now(),
      command: `/${entry.id}${parsed.text === '' ? '' : ` ${parsed.text}`}`.slice(0, 200),
    });
    await this.#emit(live.scenarioId, 'direct.session.command', {
      sessionId,
      turn,
      command: `/${entry.id}`,
    });
    this.#run(live, turn, sent);
    return { turn };
  }

  /** Stops the turn that runs; `false` when none runs. */
  async cancel(sessionId: string): Promise<{ cancelled: boolean }> {
    const live = this.#live(sessionId);
    if (live.state !== 'running') return { cancelled: false };
    await live.lease.session.cancel();
    return { cancelled: true };
  }

  /** Waits for the turn that runs to end (for the tests and the shutdown). */
  async settled(sessionId: string): Promise<void> {
    await this.#live(sessionId).running;
  }

  #begin(live: Live): number {
    if (live.state === 'running') {
      throw new Conflict('The Actor is still answering: wait for the turn to end or cancel it');
    }
    live.turn += 1;
    live.state = 'running';
    live.lastActivityAt = this.#o.clock.now();
    this.#disarm(live);
    return live.turn;
  }

  /** Runs one turn in the background; never rejects. */
  #run(live: Live, turn: number, text: string): void {
    live.running = (async () => {
      let stopReason: string;
      let error: string | undefined;
      let lost = false;
      try {
        const outcome = await live.lease.session.prompt([{ type: 'text', text }]);
        stopReason = outcome.stopReason;
      } catch (failure) {
        stopReason = 'error';
        error = situationText(failure) ?? 'The turn failed';
        lost =
          failure instanceof AdapterUnavailable || hasErrorCode(failure, 'ADAPTER_UNAVAILABLE');
        this.#o.logger.warn({ err: failure, sessionId: live.id, turn }, 'a direct turn failed');
        this.#push(live, {
          kind: 'notice',
          turn,
          at: this.#o.clock.now(),
          level: 'error',
          text: error,
        });
      }
      await this.#finishMessage(live, turn);
      live.state = live.state === 'closed' ? 'closed' : 'idle';
      live.lastActivityAt = this.#o.clock.now();
      await this.#emit(live.scenarioId, 'direct.session.turn_finished', {
        sessionId: live.id,
        turn,
        stopReason,
        ...(error === undefined ? {} : { error: error.slice(0, 1000) }),
      });
      live.running = undefined;
      if (live.state === 'idle') {
        if (lost) void this.#close(live, 'failed');
        else this.#arm(live);
      }
    })().catch((failure: unknown) => {
      this.#o.logger.error({ err: failure, sessionId: live.id }, 'a direct turn could not be told');
      live.state = live.state === 'closed' ? 'closed' : 'idle';
      live.running = undefined;
    });
  }

  /** The message the Actor wrote in the turn is whole: it goes to the log. */
  async #finishMessage(live: Live, turn: number): Promise<void> {
    const message = live.streaming;
    live.streaming = undefined;
    if (message === undefined) return;
    this.#replace(live, message, { ...message, streaming: false });
    const kept = cut(message.text);
    await this.#emit(live.scenarioId, 'direct.session.message', {
      sessionId: live.id,
      turn,
      from: 'actor',
      text: kept.text,
      truncated: kept.truncated,
    });
  }

  // ---- what the session tells ----

  #updated(live: Live, update: NormalizedUpdate): void {
    const now = this.#o.clock.now();
    live.lastActivityAt = now;
    if (update.kind === 'agent_message_chunk') {
      if (update.content.type !== 'text') return;
      const current = live.streaming;
      if (current === undefined) {
        const fresh: Extract<ApiDirectItem, { kind: 'message' }> = {
          kind: 'message',
          from: 'actor',
          turn: Math.max(live.turn, 1),
          at: now,
          text: update.content.text,
          streaming: true,
        };
        live.streaming = fresh;
        this.#push(live, fresh);
      } else {
        const next = { ...current, text: current.text + update.content.text };
        live.streaming = next;
        this.#replace(live, current, next);
      }
      return;
    }
    if (update.kind === 'tool_call') {
      this.#tool(live, update.toolCallId, update.title, update.status);
      return;
    }
    if (update.kind === 'tool_call_update') {
      const known = live.items.find(
        (item) => item.kind === 'tool' && item.toolCallId === update.toolCallId,
      );
      if (known?.kind !== 'tool') return;
      this.#tool(
        live,
        update.toolCallId,
        update.title ?? known.title,
        update.status ?? known.status,
      );
      return;
    }
    if (update.kind === 'available_commands') {
      live.commands = update.commands;
    }
  }

  #tool(
    live: Live,
    toolCallId: string,
    title: string,
    status: 'pending' | 'in_progress' | 'completed' | 'failed',
  ): void {
    // The message of the Actor ends where a tool call begins: the next text is a new message.
    const message = live.streaming;
    if (message !== undefined) {
      live.streaming = undefined;
      this.#replace(live, message, { ...message, streaming: false });
    }
    const item: Extract<ApiDirectItem, { kind: 'tool' }> = {
      kind: 'tool',
      turn: Math.max(live.turn, 1),
      at: this.#o.clock.now(),
      toolCallId,
      title: title.slice(0, 500),
      status,
    };
    const index = live.items.findIndex(
      (entry) => entry.kind === 'tool' && entry.toolCallId === toolCallId,
    );
    if (index === -1) this.#push(live, item);
    else live.items[index] = { ...item, at: (live.items[index] as typeof item).at };
    void this.#emit(live.scenarioId, 'direct.session.tool', {
      sessionId: live.id,
      turn: item.turn,
      toolCallId,
      title: item.title,
      status,
    });
  }

  /** Layer 2 answered a request of the Actor: the tab shows the answer, the log keeps it. */
  #decided(live: Live, outcome: PermissionOutcome): void {
    const title = titleOf(outcome);
    this.#push(live, {
      kind: 'decision',
      turn: live.turn,
      at: this.#o.clock.now(),
      title,
      answered: outcome.answered,
      rule: outcome.rule,
      reason: outcome.reason,
    });
    void this.#emit(live.scenarioId, 'direct.session.permission', {
      sessionId: live.id,
      turn: live.turn,
      title,
      decision: outcome.decision,
      answered: outcome.answered,
      rule: outcome.rule,
      reason: outcome.reason,
    });
  }

  // ---- closing ----

  /**
   * Closes a session: the client ends, and the worktree is committed and removed. The branch stays
   * or goes by `direct_session.on_close`; nothing is merged anywhere (the Producer promotes it).
   * Idempotent: a session already closed answers what its closing found.
   */
  close(sessionId: string): Promise<DirectCloseResult> {
    return this.#close(this.#live(sessionId), 'closed');
  }

  /** The shutdown of the daemon: every open session is closed, with the reason `shutdown`. */
  async shutdown(): Promise<void> {
    this.#closing = true;
    const open = [...this.#sessions.values()].filter((live) => live.state !== 'closed');
    await Promise.all(open.map((live) => this.#close(live, 'shutdown').catch(() => undefined)));
  }

  #close(
    live: Live,
    reason: 'closed' | 'failed' | 'shutdown' | 'idle',
  ): Promise<DirectCloseResult> {
    if (live.result !== undefined) return Promise.resolve(live.result);
    live.closing ??= this.#end(live, reason);
    return live.closing;
  }

  async #end(
    live: Live,
    reason: 'closed' | 'failed' | 'shutdown' | 'idle',
  ): Promise<DirectCloseResult> {
    const { logger, clock } = this.#o;
    this.#disarm(live);
    if (live.state === 'running') {
      await live.lease.session.cancel().catch(() => undefined);
      await Promise.race([
        live.running,
        new Promise<void>((resolve) => setTimeout(resolve, CANCEL_GRACE_MS).unref()),
      ]);
    }
    live.state = 'closed';
    live.subscription.dispose();
    await live.lease.release().catch((error: unknown) => {
      logger.warn({ err: error, sessionId: live.id }, 'a direct session did not release cleanly');
    });
    const result = await this.#takeWork(live);
    live.closedAt = clock.now();
    live.result = result;
    await this.#emit(live.scenarioId, 'direct.session.closed', {
      sessionId: live.id,
      reason,
      turns: live.turn,
      work: result.work,
      branch: result.branch,
    });
    this.#forget(live.scenarioId);
    return result;
  }

  /** Commits what the Actor wrote in its worktree, then removes the worktree. Never throws. */
  async #takeWork(live: Live): Promise<DirectCloseResult> {
    const { vcs, config, logger, store } = this.#o;
    const { worktree, branch, base } = live;
    if (worktree === null || branch === null || base === null) {
      return { work: 'not_applicable', branch: null };
    }
    const drop = async (deleteBranch: boolean): Promise<boolean> => {
      try {
        await vcs.removeWorktree(worktree, { force: true, deleteBranch });
        return true;
      } catch (error) {
        logger.warn({ err: error, sessionId: live.id, worktree }, 'the direct worktree stayed');
        await writeSituation(
          store.events,
          logger,
          'scenario.notice',
          {
            scenarioId: live.scenarioId,
            kind: 'direct_worktree_stayed',
            subject: situationSubject(branch),
            detail: situationText(error),
          },
          { scenarioId: live.scenarioId },
        );
        return false;
      }
    };
    try {
      await vcs.commitAll(worktree, `direct: ${live.id}`);
      const stat = await vcs.diffStat(worktree, base);
      if (stat.files.length === 0) {
        await drop(true);
        return { work: 'none', branch: null };
      }
      if (config.direct_session.on_close === 'discard') {
        await drop(true);
        return { work: 'discarded', branch: null };
      }
      await drop(false);
      return { work: 'kept', branch };
    } catch (error) {
      logger.error(
        { err: error, sessionId: live.id },
        'the direct session work could not be taken',
      );
      await drop(false);
      return { work: 'kept', branch };
    }
  }

  // ---- promotion ----

  /**
   * Sends the result of a session on (5.20): `demand` adds it to the idea queue of the scenario;
   * `piece` opens a play from it. `text` is what to send; absent, the last message of the Actor.
   * A branch the session kept is named in the text, so the Director finds the work.
   */
  async promote(
    sessionId: string,
    input: { readonly target: DirectPromoteTarget; readonly text?: string | undefined },
  ): Promise<DirectPromoteResult> {
    const { ideas, opening } = this.#o;
    const live = this.#live(sessionId);
    const last = [...live.items]
      .reverse()
      .find((item) => item.kind === 'message' && item.from === 'actor' && !item.streaming);
    const said = input.text?.trim() ?? (last?.kind === 'message' ? last.text : undefined);
    if (said === undefined || said.trim() === '') {
      throw new InvalidInput('There is nothing to promote: the Actor has not answered yet');
    }
    const kept = live.result?.branch ?? null;
    const text = `${said.trim()}${kept === null ? '' : `\n\nThe work of the Actor is on the branch ${kept}.`}`;
    let ref: string;
    if (input.target === 'demand') {
      ref = (await ideas.add(live.scenarioId, { text, source: 'tui' })).id;
    } else {
      const opened = await openPlayFromNeed(opening, live.scenarioId, text);
      if (!opened.ok) throw new Conflict(opened.message);
      ref = opened.playId;
    }
    await this.#emit(live.scenarioId, 'direct.session.promoted', {
      sessionId,
      target: input.target,
      ref,
    });
    return { target: input.target, ref };
  }

  // ---- the shape of the answers ----

  #summary(live: Live): ApiDirectSession {
    return {
      id: live.id,
      scenarioId: live.scenarioId,
      executor: live.executor,
      profile: live.profile,
      client: live.client,
      model: live.model,
      workspace: live.workspace,
      branch: live.branch,
      state: live.state,
      turns: live.turn,
      openedAt: live.openedAt,
      lastActivityAt: live.lastActivityAt,
      closedAt: live.closedAt,
      commands: this.#commands(live),
    };
  }

  #detail(live: Live): ApiDirectSessionDetail {
    return { ...this.#summary(live), items: live.items.map((item) => ({ ...item })) };
  }

  /** The commands of the client the Producer may run, with the name the Producer types. */
  #entries(live: Live): readonly (ApiDirectCommand & { readonly native: string })[] {
    const { config } = this.#o;
    const mode = config.chat.client_commands;
    if (mode === 'off' || live.state === 'closed') return [];
    const prefix = clientPrefixOf(live.client);
    const allowed = new Set(config.chat.client_commands_allow.map(bareCommandName));
    return live.commands
      .map((command) => {
        const native = bareCommandName(command.name);
        const id = `${prefix}:${native}`;
        return {
          id,
          native,
          name: `/${id}`,
          description: command.description,
          args: command.inputHint ?? '',
        };
      })
      .filter((entry) => mode === 'on' || allowed.has(entry.id));
  }

  #commands(live: Live): ApiDirectCommand[] {
    return this.#entries(live).map(({ id, name, description, args }) => ({
      id,
      name,
      description,
      args,
    }));
  }

  // ---- the books ----

  async #scenario(
    scenarioId: string,
  ): Promise<NonNullable<Awaited<ReturnType<Store['scenarios']['get']>>>> {
    const scenario = await this.#o.store.scenarios.get(scenarioId);
    if (scenario === undefined) throw new NotFound(`There is no scenario "${scenarioId}"`);
    return scenario;
  }

  #live(sessionId: string): Live {
    const live = this.#sessions.get(sessionId);
    if (live === undefined) throw new NotFound(`There is no direct session "${sessionId}"`);
    return live;
  }

  #writable(sessionId: string): Live {
    const live = this.#live(sessionId);
    if (live.state === 'closed') throw new Conflict(`The direct session "${sessionId}" is closed`);
    return live;
  }

  /** Adds an item, dropping the oldest past `direct_session.history_max`. */
  #push(live: Live, item: ApiDirectItem): void {
    live.items.push(item);
    const excess = live.items.length - this.#o.config.direct_session.history_max;
    if (excess > 0) live.items.splice(0, excess);
  }

  #replace(live: Live, from: ApiDirectItem, to: ApiDirectItem): void {
    const index = live.items.lastIndexOf(from);
    if (index !== -1) live.items[index] = to;
  }

  /** Forgets the oldest closed sessions of a scenario past `direct_session.closed_kept`. */
  #forget(scenarioId: string): void {
    const closed = [...this.#sessions.values()]
      .filter((live) => live.scenarioId === scenarioId && live.state === 'closed')
      .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
    for (const old of closed.slice(this.#o.config.direct_session.closed_kept)) {
      this.#sessions.delete(old.id);
    }
  }

  /** (Re)starts the idle timer of a session with no turn running. */
  #arm(live: Live): void {
    this.#disarm(live);
    const after = this.#o.config.direct_session.idle_timeout;
    if (after === null || live.state === 'closed') return;
    live.idleTimer = setTimeout(() => {
      live.idleTimer = undefined;
      if (live.state === 'idle') void this.#close(live, 'idle').catch(() => undefined);
    }, after);
    live.idleTimer.unref();
  }

  #disarm(live: Live): void {
    if (live.idleTimer !== undefined) clearTimeout(live.idleTimer);
    live.idleTimer = undefined;
  }

  async #refused(
    scenarioId: string,
    profile: string | null,
    workspace: DirectWorkspace,
    code: DaemonEventPayloads['direct.session.refused']['code'],
    reason: string,
  ): Promise<void> {
    this.#o.logger.warn({ scenarioId, profile, code, reason }, 'a direct session did not open');
    await this.#emit(scenarioId, 'direct.session.refused', {
      profile,
      workspace,
      code,
      reason: reason.slice(0, 1000),
    });
  }

  async #emit<T extends DaemonEventType>(
    scenarioId: string,
    type: T,
    payload: DaemonEventPayloads[T],
  ): Promise<void> {
    try {
      await this.#o.store.events.append({ ...buildDaemonEvent(type, payload), scenarioId });
    } catch (error) {
      this.#o.logger.error({ err: error, type, scenarioId }, 'a direct session event was lost');
    }
  }
}
