// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  Cancelled,
  InvalidInput,
  type AgentSession,
  type ClientAdapter,
  type Clock,
  type KillOptions,
  type KillReport,
  type LaunchOptions,
  type LaunchedProcess,
  type McpServerRef,
  type ProcessLauncher,
  type Profile,
  type RolePolicy,
  type SessionStartOptions,
  type SessionTransport,
  endsSharedProcess,
  sharedProcessKey,
} from '@otheater/core';
import { type PoolSettings, sessionsPerProcessFor } from './settings.js';

/** What a caller asks the pool for: one session of one `(client, profile)`. */
export interface PoolRequest {
  /** Id of the `ClientAdapter` (`claude-code`, `codex`, `opencode`...). */
  readonly client: string;
  readonly profile: Profile;
  readonly policy: RolePolicy;
  /** The worktree the session works in. */
  readonly cwd: string;
  /** Reload this conversation (`session/load`) instead of opening a new one. */
  readonly resumeSessionId?: string;
  /**
   * MCP servers of this session alone, with the address and the token of the attempt (the
   * framework server, architecture 5.3). Each name must be in `policy.mcpServers`. [proposta]
   */
  readonly mcpServers?: readonly McpServerRef[];
  /** Aborts the wait for admission. */
  readonly signal?: AbortSignal;
}

/** A session the pool admitted. `release()` is the only way back; it is idempotent. */
export interface SessionLease {
  readonly session: AgentSession;
  readonly client: string;
  readonly profileId: string;
  /** Id of the transport the session speaks (`acp`...), for the `session.opened` event. */
  readonly via: string;
  /** Pid of the adapter process that runs the session. */
  readonly pid: number;
  /** The process runs other sessions too (`multi-session`). */
  readonly shared: boolean;
  /**
   * Set when the cancel of this session ended the shared process (`pool.shared_cancel`): the
   * process id and how many other sessions fell with it. The caller tells the event log.
   */
  readonly escalation: PoolEscalation | undefined;
  /**
   * True when the process of this session was ended by the cancel of another session. Its loss of
   * connection is not a failure of the client, so the caller does not charge the resume quota.
   */
  readonly casualty: boolean;
  /** Closes the session and frees its slot. A process left with no session starts its idle timer. */
  release(): Promise<void>;
  /**
   * Ends the adapter process of this session, with every session on it: the other leases see a
   * lost connection and the caller puts them back in the queue. For a stuck process.
   */
  kill(): Promise<KillReport>;
}

/** A cancel that ended a shared process (`pool.shared_cancel`). */
export interface PoolEscalation {
  readonly pid: number;
  /** Sessions of the same process that fell with it. */
  readonly siblings: number;
}

export interface PoolStats {
  readonly processes: number;
  readonly sessions: number;
  readonly queued: number;
}

export interface SessionPoolOptions {
  /** The adapters by id (the registry the daemon was composed with). */
  readonly clients: readonly ClientAdapter[];
  readonly launcher: ProcessLauncher;
  /** The transport an adapter speaks (`acp` in production). */
  readonly transport: (adapter: ClientAdapter) => SessionTransport;
  readonly clock: Clock;
  readonly settings: PoolSettings;
}

const NO_KILL: KillReport = { found: 0, forced: false, remaining: [] };

/**
 * A shared process being launched, with the sessions that already took a slot on it. When the
 * launch ends, `tokens` becomes the `sessions` of the new `PoolProcess`.
 */
interface PendingLaunch {
  readonly ready: Promise<PoolProcess>;
  readonly tokens: Set<symbol>;
}

/** A process of the pool and the sessions on it. */
interface PoolProcess {
  readonly key: string;
  readonly process: LaunchedProcess;
  readonly shared: boolean;
  readonly sessions: Set<symbol>;
  alive: boolean;
  /** Aborts the idle timer. */
  idle: AbortController | undefined;
  /** Set when the cancel of one session ended the process on purpose. */
  escalation: { readonly by: symbol; readonly info: PoolEscalation } | undefined;
}

/**
 * A view of a pooled process for one session: the same pipes, but `killTree` only detaches. The
 * session (`ManagedAgentSession`) ends the tree on `close` and `cancel`, which would take the other
 * sessions of a shared process down with it; the pool owns the real process instead. `onKill`
 * decides, from how the cancel went (`KillOptions.cancel`) and `pool.shared_cancel`, whether the
 * whole process ends after all.
 */
function lendProcess(
  process: LaunchedProcess,
  onKill: (options: KillOptions | undefined) => Promise<KillReport>,
): LaunchedProcess {
  return {
    get pid() {
      return process.pid;
    },
    get stdin() {
      return process.stdin;
    },
    get stdout() {
      return process.stdout;
    },
    get stderr() {
      return process.stderr;
    },
    get exited() {
      return process.exited;
    },
    killTree(options) {
      return onKill(options);
    },
  };
}

/**
 * The sessions of the daemon, grouped in processes per `(client, profile)` (architecture 5.2,
 * "Pools por (client, profile)"):
 * - up to `K` sessions per adapter process, another process above that;
 * - a process with no session for `idleMs` is closed;
 * - a stuck process is killed with `lease.kill()`, and the caller queues its sessions again;
 * - the admission semaphore counts sessions, not processes (in Claude Code the RAM is per session).
 *
 * A client whose `processModel` is `process-per-session` gets one process per session, started by
 * the adapter itself (`openSession`). A `multi-session` client gets the shared process, which the
 * pool starts with `launchSpec` and lends to the sessions (`openSessionOn`). Sessions share a
 * process only when `adapter.id` and `sharedProcessKey(profile, launchSpec)` agree, so two policies
 * that launch the client differently (OpenCode puts the permission in the environment) never meet.
 * The ACP transport multiplexes the sessions of a process (since P9a).
 *
 * `pool.shared_cancel` says what cancelling a session does to a shared process: `escalate` ends it
 * when the client did not honour `session/cancel` within the grace, `always_kill` on every cancel,
 * `release` never. The sessions that fall with it are `casualty` leases.
 */
export class SessionPool {
  readonly #adapters = new Map<string, ClientAdapter>();
  readonly #launcher: ProcessLauncher;
  readonly #transport: (adapter: ClientAdapter) => SessionTransport;
  readonly #clock: Clock;
  readonly #settings: PoolSettings;
  readonly #processes = new Map<string, PoolProcess[]>();
  /** Shared processes still being launched, by the same key as `#processes`. */
  readonly #launching = new Map<string, PendingLaunch[]>();
  readonly #waiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  #sessions = 0;
  #closed = false;

  constructor(options: SessionPoolOptions) {
    for (const adapter of options.clients) {
      if (this.#adapters.has(adapter.id)) {
        throw new InvalidInput(`two client adapters share the id ${adapter.id}`);
      }
      this.#adapters.set(adapter.id, adapter);
    }
    this.#launcher = options.launcher;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#settings = options.settings;
  }

  /** The adapter of a client id, or `AdapterUnavailable`. */
  adapterOf(client: string): ClientAdapter {
    const adapter = this.#adapters.get(client);
    if (adapter === undefined) throw new AdapterUnavailable(`no client adapter ${client}`);
    return adapter;
  }

  stats(): PoolStats {
    let processes = 0;
    for (const list of this.#processes.values()) processes += list.length;
    return { processes, sessions: this.#sessions, queued: this.#waiters.length };
  }

  /**
   * Waits for a free slot (first in, first out), then opens or reloads the session. The slot is
   * given back if the open fails.
   */
  async acquire(request: PoolRequest): Promise<SessionLease> {
    if (this.#closed) throw new AdapterUnavailable('the session pool is closed');
    const adapter = this.adapterOf(request.client);
    await this.#admit(request.signal);
    try {
      return await this.#open(adapter, request);
    } catch (error) {
      this.#free();
      throw error;
    }
  }

  /** Ends every process of the pool; sessions on them lose their connection. */
  async shutdown(): Promise<void> {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(new AdapterUnavailable('the session pool is closed'));
    }
    const all = [...this.#processes.values()].flat();
    this.#processes.clear();
    await Promise.all(all.map((entry) => this.#end(entry)));
  }

  // ---- admission ----

  #admit(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(cancelledBy(signal));
    if (this.#sessions < this.#settings.maxSessions && this.#waiters.length === 0) {
      this.#sessions += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(cancelledBy(signal));
      };
      waiter.resolve = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      this.#waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** The slot passes straight to the first waiter, so `#sessions` stays the same. */
  #free(): void {
    const next = this.#waiters.shift();
    if (next === undefined) this.#sessions -= 1;
    else next.resolve();
  }

  // ---- opening ----

  async #open(adapter: ClientAdapter, request: PoolRequest): Promise<SessionLease> {
    const via = this.#transport(adapter);
    const { profile, policy, cwd, resumeSessionId } = request;
    const profileId = profile.id;
    // Only a session with its own MCP servers gets an `options`; the others call as before.
    const extra: [SessionStartOptions] | [] =
      request.mcpServers === undefined ? [] : [{ mcpServers: request.mcpServers }];
    if (adapter.processModel === 'process-per-session') {
      const session =
        resumeSessionId === undefined
          ? await adapter.openSession(profile, policy, cwd, via, ...extra)
          : await adapter.loadSession(profile, policy, cwd, resumeSessionId, via, ...extra);
      return this.#lease(session, adapter.id, profileId, via.id, undefined, undefined);
    }
    const { entry, token } = await this.#slotFor(adapter, request, via);
    try {
      const lent = lendProcess(entry.process, (options) => this.#detach(entry, token, options));
      const session =
        resumeSessionId === undefined
          ? await adapter.openSessionOn(lent, policy, cwd, via, ...extra)
          : await adapter.loadSessionOn(lent, policy, cwd, resumeSessionId, via, ...extra);
      return this.#lease(session, adapter.id, profileId, via.id, entry, token);
    } catch (error) {
      entry.sessions.delete(token);
      this.#startIdleIfEmpty(entry);
      throw error;
    }
  }

  /**
   * Takes a slot on a shared process: a live one with fewer than `K` sessions, else one being
   * launched with fewer than `K` slots taken, else a new launch. The slot is taken with no `await`
   * between the search and the claim, so `acquire`s at the same time split a process up to `K` and
   * only launch another above that. A launch that fails rejects every session waiting on it, and
   * their slots go with it.
   */
  async #slotFor(
    adapter: ClientAdapter,
    request: PoolRequest,
    via: SessionTransport,
  ): Promise<{ entry: PoolProcess; token: symbol }> {
    const spec = await adapter.launchSpec(request.profile, request.policy, request.cwd, via.id);
    const key = `${adapter.id}|${sharedProcessKey(request.profile, spec)}`;
    const k = sessionsPerProcessFor(this.#settings, adapter.id);
    const token = Symbol(`${adapter.id}/${request.profile.id}`);
    const found = this.#processes.get(key)?.find((entry) => entry.alive && entry.sessions.size < k);
    if (found !== undefined) {
      found.sessions.add(token);
      this.#stopIdle(found);
      return { entry: found, token };
    }
    const pending = this.#launching.get(key)?.find((launch) => launch.tokens.size < k);
    if (pending !== undefined) {
      pending.tokens.add(token);
      return { entry: await pending.ready, token };
    }
    const tokens = new Set([token]);
    const launch: PendingLaunch = { ready: this.#launch(key, spec, tokens), tokens };
    this.#launching.set(key, [...(this.#launching.get(key) ?? []), launch]);
    const settled = (): void => {
      this.#launched(key, launch);
    };
    void launch.ready.then(settled, settled);
    return { entry: await launch.ready, token };
  }

  async #launch(key: string, spec: LaunchOptions, sessions: Set<symbol>): Promise<PoolProcess> {
    const process = await this.#launcher.launch(spec);
    const entry: PoolProcess = {
      key,
      process,
      shared: true,
      sessions,
      alive: true,
      idle: undefined,
      escalation: undefined,
    };
    // A crash of the process: the entry leaves the pool, the sessions see the lost connection.
    void process.exited.then(() => {
      entry.alive = false;
      this.#forget(entry);
    });
    const current = this.#processes.get(key) ?? [];
    current.push(entry);
    this.#processes.set(key, current);
    if (this.#closed) {
      await this.#end(entry);
      throw new AdapterUnavailable('the session pool is closed');
    }
    return entry;
  }

  /** A launch ended, well or not: new sessions no longer join it. */
  #launched(key: string, launch: PendingLaunch): void {
    const rest = (this.#launching.get(key) ?? []).filter((candidate) => candidate !== launch);
    if (rest.length === 0) this.#launching.delete(key);
    else this.#launching.set(key, rest);
  }

  #lease(
    session: AgentSession,
    client: string,
    profileId: string,
    via: string,
    entry: PoolProcess | undefined,
    token: symbol | undefined,
  ): SessionLease {
    let released = false;
    const pid = entry?.process.pid ?? 0;
    return {
      session,
      client,
      profileId,
      via,
      pid,
      shared: entry !== undefined,
      get escalation() {
        const escalation = entry?.escalation;
        return escalation !== undefined && escalation.by === token ? escalation.info : undefined;
      },
      get casualty() {
        return entry?.escalation !== undefined && entry.escalation.by !== token;
      },
      release: async () => {
        if (released) return;
        released = true;
        try {
          await session.close();
        } catch {
          // A session that cannot close is already gone; the slot goes back all the same.
        } finally {
          if (entry !== undefined && token !== undefined) {
            entry.sessions.delete(token);
            this.#startIdleIfEmpty(entry);
          }
          this.#free();
        }
      },
      kill: async () => {
        if (entry === undefined) {
          // One process per session: ending the session ends its tree.
          await session.cancel();
          return NO_KILL;
        }
        return this.#end(entry);
      },
    };
  }

  // ---- processes ----

  /**
   * A session gave its view of the process back, on `close` (no `cancel` in the options) or on
   * `cancel` (how it went). The process goes down when `pool.shared_cancel` says so, with the
   * sessions still on it; otherwise only the slot of this session on the process is dropped.
   */
  async #detach(
    entry: PoolProcess,
    token: symbol,
    options: KillOptions | undefined,
  ): Promise<KillReport> {
    const had = entry.sessions.delete(token);
    if (!had || !entry.alive || !endsSharedProcess(this.#settings.sharedCancel, options?.cancel)) {
      return NO_KILL;
    }
    if (entry.sessions.size > 0) {
      entry.escalation = {
        by: token,
        info: { pid: entry.process.pid, siblings: entry.sessions.size },
      };
    }
    return this.#end(entry);
  }

  #startIdleIfEmpty(entry: PoolProcess): void {
    if (!entry.alive || entry.sessions.size > 0 || entry.idle !== undefined) return;
    const idle = new AbortController();
    entry.idle = idle;
    void this.#clock.sleep(this.#settings.idleMs, idle.signal).then(
      () => {
        entry.idle = undefined;
        if (entry.sessions.size === 0) void this.#end(entry);
      },
      () => undefined,
    );
  }

  #stopIdle(entry: PoolProcess): void {
    entry.idle?.abort();
    entry.idle = undefined;
  }

  async #end(entry: PoolProcess): Promise<KillReport> {
    entry.alive = false;
    this.#stopIdle(entry);
    this.#forget(entry);
    try {
      return await entry.process.killTree();
    } catch {
      return NO_KILL;
    }
  }

  #forget(entry: PoolProcess): void {
    const list = this.#processes.get(entry.key);
    if (list === undefined) return;
    const rest = list.filter((candidate) => candidate !== entry);
    if (rest.length === 0) this.#processes.delete(entry.key);
    else this.#processes.set(entry.key, rest);
  }
}

function cancelledBy(signal: AbortSignal | undefined): Cancelled {
  return new Cancelled('the wait for a session slot was cancelled', { cause: signal?.reason });
}
