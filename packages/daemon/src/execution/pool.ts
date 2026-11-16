// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  Cancelled,
  InvalidInput,
  type AgentSession,
  type ClientAdapter,
  type Clock,
  type KillReport,
  type LaunchedProcess,
  type ProcessLauncher,
  type Profile,
  type RolePolicy,
  type SessionTransport,
} from '@otheater/core';
import type { PoolSettings } from './settings.js';

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
  /** Aborts the wait for admission. */
  readonly signal?: AbortSignal;
}

/** A session the pool admitted. `release()` is the only way back; it is idempotent. */
export interface SessionLease {
  readonly session: AgentSession;
  readonly client: string;
  readonly profileId: string;
  /** Pid of the adapter process that runs the session. */
  readonly pid: number;
  /** The process runs other sessions too (`multi-session`). */
  readonly shared: boolean;
  /** Closes the session and frees its slot. A process left with no session starts its idle timer. */
  release(): Promise<void>;
  /**
   * Ends the adapter process of this session, with every session on it: the other leases see a
   * lost connection and the caller puts them back in the queue. For a stuck process.
   */
  kill(): Promise<KillReport>;
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

/** A process of the pool and the sessions on it. */
interface PoolProcess {
  readonly key: string;
  readonly process: LaunchedProcess;
  readonly shared: boolean;
  readonly sessions: Set<symbol>;
  alive: boolean;
  /** Aborts the idle timer. */
  idle: AbortController | undefined;
}

/**
 * A view of a pooled process for one session: the same pipes, but `killTree` only detaches. The
 * session (`ManagedAgentSession`) ends the tree on `close` and `cancel`, which would take the other
 * sessions of a shared process down with it; the pool owns the real process instead.
 */
function lendProcess(process: LaunchedProcess, onDetach: () => void): LaunchedProcess {
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
    killTree() {
      onDetach();
      return Promise.resolve(NO_KILL);
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
 * pool starts with `launchSpec` and lends to the sessions (`openSessionOn`). [proposta] The ACP
 * transport of this version cannot multiplex sessions on one process, so a `multi-session` adapter
 * needs a transport that can (the fake transport can).
 */
export class SessionPool {
  readonly #adapters = new Map<string, ClientAdapter>();
  readonly #launcher: ProcessLauncher;
  readonly #transport: (adapter: ClientAdapter) => SessionTransport;
  readonly #clock: Clock;
  readonly #settings: PoolSettings;
  readonly #processes = new Map<string, PoolProcess[]>();
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
    if (adapter.processModel === 'process-per-session') {
      const session =
        resumeSessionId === undefined
          ? await adapter.openSession(profile, policy, cwd, via)
          : await adapter.loadSession(profile, policy, cwd, resumeSessionId, via);
      return this.#lease(session, adapter.id, profileId, undefined, undefined);
    }
    const entry = await this.#processFor(adapter, request, via);
    const token = Symbol(`${adapter.id}/${profileId}`);
    entry.sessions.add(token);
    this.#stopIdle(entry);
    try {
      const lent = lendProcess(entry.process, () => {
        entry.sessions.delete(token);
      });
      const session =
        resumeSessionId === undefined
          ? await adapter.openSessionOn(lent, policy, cwd, via)
          : await adapter.loadSessionOn(lent, policy, cwd, resumeSessionId, via);
      return this.#lease(session, adapter.id, profileId, entry, token);
    } catch (error) {
      entry.sessions.delete(token);
      this.#startIdleIfEmpty(entry);
      throw error;
    }
  }

  async #processFor(
    adapter: ClientAdapter,
    request: PoolRequest,
    via: SessionTransport,
  ): Promise<PoolProcess> {
    const key = `${adapter.id}/${request.profile.id}`;
    const list = this.#processes.get(key) ?? [];
    const found = list.find(
      (entry) => entry.alive && entry.sessions.size < this.#settings.sessionsPerProcess,
    );
    if (found !== undefined) return found;
    const spec = await adapter.launchSpec(request.profile, request.policy, request.cwd, via.id);
    const process = await this.#launcher.launch(spec);
    const entry: PoolProcess = {
      key,
      process,
      shared: true,
      sessions: new Set(),
      alive: true,
      idle: undefined,
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

  #lease(
    session: AgentSession,
    client: string,
    profileId: string,
    entry: PoolProcess | undefined,
    token: symbol | undefined,
  ): SessionLease {
    let released = false;
    const pid = entry?.process.pid ?? 0;
    return {
      session,
      client,
      profileId,
      pid,
      shared: entry !== undefined,
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
