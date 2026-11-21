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
  type MemoryProbe,
  type ProcessLauncher,
  type Profile,
  type RolePolicy,
  type SessionPermissions,
  type SessionStartOptions,
  type SessionTransport,
  endsSharedProcess,
  sharedProcessKey,
} from '@otheater/core';
import {
  ALWAYS_ADMIT,
  DEFAULT_ADMISSION,
  defaultSessionMb,
  slotFree,
  type AdmissionSettings,
  type CanAdmit,
  type LocalInstanceResolver,
  type ProfileLoad,
} from './admission.js';
import type {
  PreparedTelemetry,
  SessionTelemetry,
  TelemetryContext,
} from '../telemetry/client-telemetry.js';
import { type PoolSettings, sessionsPerProcessFor } from './settings.js';
import { WAIT_KIND } from '../telemetry/span-conventions.js';
import type { WaitCorrelation, WaitHandle, WaitTracker } from '../telemetry/wait-events.js';

/** Why a session waited in the queue of the pool (`otheater.wait.reason` of the spans). */
export const POOL_WAIT_REASON = {
  /** `pool.max_sessions` is reached. */
  maxSessions: 'max_sessions',
  /** The local instance behind the profile has no vacancy for it. */
  localSlot: 'local_slot',
  /** `ram_and_quota`: the quota of the profile says no. */
  quota: 'quota',
  /** `ram` modes: the free RAM does not fit it. */
  ram: 'ram',
  /** The RAM could not be read and `pool.admission.unknown_ram` is `wait`. */
  ramUnknown: 'ram_unknown',
} as const;
type PoolWaitReason = (typeof POOL_WAIT_REASON)[keyof typeof POOL_WAIT_REASON];

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
  /**
   * What the base of the adapter tells the caller about every permission request it answers, and
   * how it resolves links (Phase 4, P2). Absent means nobody listens. [proposta]
   */
  readonly permissions?: SessionPermissions;
  /**
   * The session is the Director's (or a short judgement of it): on a local instance it may use the
   * slots reserved for it (`reserve_for_director`), which any other session may not. [proposta]
   */
  readonly director?: boolean;
  /**
   * The work the session is for (play, stage, attempt): what ties the telemetry its client sends to
   * the attempt (Phase 8, P2). Absent: a session with no work behind it (a catalog probe, a direct
   * session) still sends telemetry, with the profile and client only. [proposta]
   */
  readonly telemetry?: TelemetryContext;
  /**
   * The ids of the log this session is for (Phase 8, P4, P15): a wait in the queue of the pool is
   * told with them (`wait.started`, `wait.ended`) and is a span of this attempt. Absent, the wait
   * is told with no attempt. [proposta]
   */
  readonly correlation?: WaitCorrelation;
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
  /**
   * Reads the free RAM for the admission by `pool.admission.mode: ram | ram_and_quota` and measures
   * the process tree for `session_mb: auto`. Required by those two modes; `slots` never reads it.
   */
  readonly memory?: MemoryProbe;
  /** The quota hook of `ram_and_quota` (P15 wires it to the `QuotaService`). Default: always yes. */
  readonly canAdmit?: CanAdmit;
  /** The `local` instance behind a profile, whose slots are the vacancies of that profile (5.9). */
  readonly localInstance?: LocalInstanceResolver;
  /**
   * Where the clients send their telemetry (Phase 8, P2). Absent (`telemetry.enabled: off`, or the
   * receiver is not up): the sessions start as before and no `OTEL_*` variable reaches them.
   */
  readonly telemetry?: SessionTelemetry;
  /**
   * Phase 8, P15 (N222 (a)): told when a session is held back in the queue and when it leaves it;
   * the tracker writes `wait.started` and `wait.ended` for a wait that lasts the threshold. It never
   * throws and never waits.
   */
  readonly waits?: WaitTracker;
}

/** A session waiting for admission, and what it costs. */
interface Waiter {
  readonly request: PoolRequest;
  readonly mb: number;
  /** When it entered the queue (the clock of the pool). */
  readonly since: number;
  readonly key: string;
  /** The wait that holds it back (reasons: `POOL_WAIT_REASON`); absent while nothing did. */
  wait: WaitHandle | undefined;
  readonly resolve: (slot: Slot) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * What an admitted session holds: a vacancy (`#sessions`, the load of its profile) and, until its
 * open ends, the RAM it is about to take (`#startingMb`). Both go back through `#free` and
 * `#started`, each at most once.
 */
interface Slot {
  readonly profileId: string;
  readonly director: boolean;
  /** MB reserved while the session starts; `0` when the mode does not reserve RAM. */
  readonly reservedMb: number;
  starting: boolean;
  freed: boolean;
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
  /** The profile whose directory the process runs in (a shared process never serves two profiles). */
  readonly profileId: string;
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
  /** Sessions waiting for admission, first in, first out. */
  readonly #waiters: Waiter[] = [];
  readonly #memory: MemoryProbe | undefined;
  readonly #canAdmit: CanAdmit;
  readonly #localInstance: LocalInstanceResolver | undefined;
  readonly #telemetry: SessionTelemetry | undefined;
  readonly #waits: WaitTracker | undefined;
  #waitSeq = 0;
  /** Sessions holding a slot of their local instance, by profile id. */
  readonly #load = new Map<string, ProfileLoad>();
  /** What `session_mb: auto` learned per client: the largest share of a process tree seen. */
  readonly #learnedMb = new Map<string, number>();
  /** RAM promised to sessions that are still opening (MemAvailable has not dropped for them yet). */
  #startingMb = 0;
  #sessions = 0;
  #pumping = false;
  #again = false;
  /** Aborts the timer that looks at the queue again while a session waits for RAM or quota. */
  #recheck: AbortController | undefined;
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
    this.#memory = options.memory;
    this.#canAdmit = options.canAdmit ?? ALWAYS_ADMIT;
    this.#localInstance = options.localInstance;
    this.#telemetry = options.telemetry;
    this.#waits = options.waits;
    if (this.#admission.mode !== 'slots' && this.#memory === undefined) {
      throw new InvalidInput(
        `pool.admission.mode ${this.#admission.mode} needs a MemoryProbe to read the free RAM`,
      );
    }
  }

  get #admission(): AdmissionSettings {
    return this.#settings.admission ?? DEFAULT_ADMISSION;
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
   * Waits for admission (first in, first out), then opens or reloads the session. What admission
   * asks depends on `pool.admission.mode`: always a free vacancy (`pool.max_sessions`, and the
   * slots of the local instance of the profile); in `ram` the free RAM too; in `ram_and_quota` the
   * quota hook as well. A session that does not fit waits in the queue, with no error. The slot is
   * given back if the open fails.
   */
  async acquire(request: PoolRequest): Promise<SessionLease> {
    if (this.#closed) throw new AdapterUnavailable('the session pool is closed');
    const adapter = this.adapterOf(request.client);
    const slot = await this.#admit(request);
    try {
      return await this.#open(adapter, request, slot);
    } catch (error) {
      this.#free(slot);
      throw error;
    } finally {
      this.#started(slot);
    }
  }

  /**
   * Looks at the queue again. Whoever changes what admission reads (the quota service after a reset,
   * a test after it raised the RAM) calls this; the pool itself looks again when a session ends and
   * every `pool.admission.recheck` while one waits.
   */
  wake(): void {
    this.#pump();
  }

  /**
   * Sessions that hold a slot for the profile now (the Director's and the Actors', opening ones
   * included). The profile service (P21) reads it to know when a draining profile is idle.
   */
  sessionsOf(profileId: string): number {
    const load = this.#load.get(profileId);
    return load === undefined ? 0 : load.directors + load.actors;
  }

  /**
   * Ends every shared process of a profile that left (P21; a process of its own per session ends
   * with its session): the idle ones, and the busy ones too, whose sessions lose their connection.
   * Returns how many processes it ended. A process still being launched for the profile is not here
   * yet; it ends when its sessions do, by the idle timer.
   */
  async endProcessesOf(profileId: string): Promise<number> {
    const mine = [...this.#processes.values()]
      .flat()
      .filter((entry) => entry.profileId === profileId);
    await Promise.all(mine.map((entry) => this.#end(entry)));
    return mine.length;
  }

  /** Ends every process of the pool; sessions on them lose their connection. */
  async shutdown(): Promise<void> {
    this.#closed = true;
    this.#recheck?.abort();
    this.#recheck = undefined;
    for (const waiter of this.#waiters.splice(0)) {
      this.#reportWait(waiter, 'pool_closed');
      waiter.reject(new AdapterUnavailable('the session pool is closed'));
    }
    const all = [...this.#processes.values()].flat();
    this.#processes.clear();
    await Promise.all(all.map((entry) => this.#end(entry)));
  }

  // ---- admission ----

  #admit(request: PoolRequest): Promise<Slot> {
    const { signal } = request;
    if (signal?.aborted === true) return Promise.reject(cancelledBy(signal));
    return new Promise<Slot>((resolve, reject) => {
      const since = this.#clock.now();
      this.#waitSeq += 1;
      const waiter: Waiter = {
        request,
        mb: this.#costOf(request.client),
        since,
        key: `${request.correlation?.attemptId ?? request.profile.id}|${String(since)}|${String(this.#waitSeq)}`,
        wait: undefined,
        resolve: (slot) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(slot);
        },
        reject,
      };
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
          this.#reportWait(waiter, 'cancelled');
        }
        reject(cancelledBy(signal));
        // Whoever was behind a session that waited for RAM may fit now.
        this.#pump();
      };
      this.#waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pump();
    });
  }

  /**
   * Something holds the session back: the first reason opens the wait (`wait.started` follows when
   * it lasts the threshold), the others are added to it. A session admitted at its first look never
   * gets here and says nothing.
   */
  #hold(waiter: Waiter, reason: PoolWaitReason): void {
    if (this.#waits === undefined) return;
    if (waiter.wait !== undefined) {
      waiter.wait.hold(reason);
      return;
    }
    const { request } = waiter;
    try {
      waiter.wait = this.#waits.begin({
        kind: WAIT_KIND.poolAdmission,
        id: waiter.key,
        since: waiter.since,
        reason,
        correlation: {
          ...request.correlation,
          client: request.client,
          profile: request.profile.id,
        },
      });
    } catch {
      // A tracker that throws must not hold the pool.
    }
  }

  /** A session left the queue: the wait it was in, if any, ends (N222 (a)). */
  #reportWait(waiter: Waiter, outcome: 'admitted' | 'cancelled' | 'pool_closed'): void {
    try {
      waiter.wait?.end(outcome);
    } catch {
      // A tracker that throws must not hold the pool.
    }
  }

  /** A slot goes back: the vacancy and the load of its profile, then the queue gets its turn. */
  #free(slot: Slot): void {
    if (slot.freed) return;
    slot.freed = true;
    this.#sessions -= 1;
    const load = this.#load.get(slot.profileId);
    if (load !== undefined) {
      if (slot.director) load.directors -= 1;
      else load.actors -= 1;
      if (load.directors + load.actors === 0) this.#load.delete(slot.profileId);
    }
    this.#started(slot);
    this.#pump();
  }

  /** The open of the session ended, well or not: its RAM is in `MemAvailable` now, or never was. */
  #started(slot: Slot): void {
    if (!slot.starting) return;
    slot.starting = false;
    this.#startingMb -= slot.reservedMb;
  }

  /** `session_mb` of a client: the number written, or what `auto` learned, or the measured default. */
  #costOf(client: string): number {
    const written = this.#settings.sessionMbByClient?.[client];
    if (typeof written === 'number') return written;
    const base = defaultSessionMb(client);
    return written === 'auto' ? (this.#learnedMb.get(client) ?? base) : base;
  }

  /**
   * A side-effect-free look at the slot of a profile on its local instance (the `admission` port of
   * the selector, P16). `full` when the instance has no slot for one more session of that kind; a
   * profile with no local instance always has one. RAM and `max_sessions` are not asked here: the
   * queue of the pool already holds a session blocked by them without freezing the others, so the
   * selector does not turn them into a wait of its own.
   */
  slotOf(profile: Profile, director = false): 'free' | 'full' {
    const instance = this.#localInstance?.(profile);
    if (instance === undefined) return 'free';
    const load = this.#load.get(profile.id) ?? { directors: 0, actors: 0 };
    return slotFree(instance, load, director, this.#listedForDirector(profile.id))
      ? 'free'
      : 'full';
  }

  /** Whether `profile` is in the Director's list (`reserve_when: listed`). */
  #listedForDirector(profileId: string): boolean {
    return this.#settings.directorProfiles?.includes(profileId) ?? false;
  }

  /**
   * Gives slots to the waiters that fit, in the order they arrived. A waiter blocked only by its
   * own profile (no free slot on its local instance, or the quota says no) does not hold the others
   * back; one blocked by RAM does, so a big session is not starved by small ones behind it.
   * `available` is the free RAM, `undefined` when RAM is not asked (`slots`) or the probe cannot
   * tell (`ramUnknown`); `quota` holds the verdict of `canAdmit` for each profile in the queue
   * (`ram_and_quota` only).
   */
  #scan(
    available: number | undefined,
    ramUnknown: boolean,
    quota: ReadonlyMap<string, boolean> | undefined,
  ): void {
    const { mode, minFreeMb, unknownRam } = this.#admission;
    let headroom = available === undefined ? 0 : available - this.#startingMb - minFreeMb;
    let ramBlocked = false;
    for (let index = 0; index < this.#waiters.length;) {
      if (this.#sessions >= this.#settings.maxSessions) {
        for (const held of this.#waiters.slice(index)) {
          this.#hold(held, POOL_WAIT_REASON.maxSessions);
        }
        return;
      }
      const waiter = this.#waiters[index];
      if (waiter === undefined) return;
      const { request } = waiter;
      const profileId = request.profile.id;
      const director = request.director === true;
      const instance = this.#localInstance?.(request.profile);
      const load = this.#load.get(profileId) ?? { directors: 0, actors: 0 };
      if (
        instance !== undefined &&
        !slotFree(instance, load, director, this.#listedForDirector(profileId))
      ) {
        this.#hold(waiter, POOL_WAIT_REASON.localSlot);
        index += 1;
        continue;
      }
      if (quota?.get(profileId) === false) {
        this.#hold(waiter, POOL_WAIT_REASON.quota);
        index += 1;
        continue;
      }
      let reservedMb = 0;
      if (mode !== 'slots') {
        if (ramUnknown) {
          if (unknownRam === 'wait') {
            this.#hold(waiter, POOL_WAIT_REASON.ramUnknown);
            index += 1;
            continue;
          }
        } else {
          if (ramBlocked || headroom < waiter.mb) {
            ramBlocked = true;
            this.#hold(waiter, POOL_WAIT_REASON.ram);
            index += 1;
            continue;
          }
          headroom -= waiter.mb;
          reservedMb = waiter.mb;
        }
      }
      this.#waiters.splice(index, 1);
      this.#reportWait(waiter, 'admitted');
      this.#sessions += 1;
      this.#startingMb += reservedMb;
      if (director) load.directors += 1;
      else load.actors += 1;
      this.#load.set(profileId, load);
      waiter.resolve({
        profileId,
        director,
        reservedMb,
        starting: reservedMb > 0,
        freed: false,
      });
    }
  }

  /**
   * Runs the admission. In `slots` it needs nothing asynchronous and the queue is served before
   * this returns. In the other modes it reads the RAM (and asks the quota) first; a call that
   * arrives while that runs makes it run once more.
   */
  #pump(): void {
    if (this.#closed) return;
    if (this.#admission.mode === 'slots') {
      this.#scan(undefined, false, undefined);
      return;
    }
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    void this.#pumpAsync();
  }

  /** `#closed` read afresh after an await (the flow analysis cannot see `shutdown` change it). */
  #isClosed(): boolean {
    return this.#closed;
  }

  /** `#again` read afresh after an await (`#pump` may set it while a round is in flight). */
  #runAgain(): boolean {
    return this.#again;
  }

  async #pumpAsync(): Promise<void> {
    try {
      do {
        this.#again = false;
        if (this.#waiters.length === 0) break;
        const available = await this.#readAvailable();
        const quota =
          this.#admission.mode === 'ram_and_quota' ? await this.#quotaVerdicts() : undefined;
        if (this.#isClosed()) break;
        this.#scan(available, available === undefined, quota);
      } while (this.#runAgain());
    } finally {
      this.#pumping = false;
      this.#armRecheck();
    }
  }

  async #readAvailable(): Promise<number | undefined> {
    try {
      return await this.#memory?.availableMb();
    } catch {
      return undefined;
    }
  }

  /** `canAdmit` for each profile in the queue, asked once per round. A rejection is a "no". */
  async #quotaVerdicts(): Promise<ReadonlyMap<string, boolean>> {
    const profiles = new Map<string, Profile>();
    for (const waiter of this.#waiters) {
      profiles.set(waiter.request.profile.id, waiter.request.profile);
    }
    const verdicts = new Map<string, boolean>();
    await Promise.all(
      [...profiles].map(async ([id, profile]) => {
        try {
          verdicts.set(id, await this.#canAdmit(profile));
        } catch {
          verdicts.set(id, false);
        }
      }),
    );
    return verdicts;
  }

  /** While anybody waits, RAM and quota change with no event of ours: look again after a while. */
  #armRecheck(): void {
    if (this.#recheck !== undefined || this.#closed || this.#waiters.length === 0) return;
    const timer = new AbortController();
    this.#recheck = timer;
    void this.#clock.sleep(this.#admission.recheckMs, timer.signal).then(
      () => {
        if (this.#recheck === timer) this.#recheck = undefined;
        this.#pump();
      },
      () => undefined,
    );
  }

  /**
   * `session_mb: auto`: after a shared process took a session, the tree of that process shared by
   * its sessions is the cost of one. The largest share seen stands, so the estimate errs on the
   * side of waiting. [N] A client that starts one process per session gives no pid to the pool,
   * and the measure at the open comes before the first prompt, so it is a lower bound.
   */
  async #learn(client: string, entry: PoolProcess): Promise<void> {
    if (this.#settings.sessionMbByClient?.[client] !== 'auto') return;
    const probe = this.#memory;
    if (probe?.treeMb === undefined) return;
    try {
      const mb = await probe.treeMb(entry.process.pid);
      if (mb === undefined || !entry.alive) return;
      const share = Math.ceil(mb / Math.max(1, entry.sessions.size));
      if (share > (this.#learnedMb.get(client) ?? 0)) this.#learnedMb.set(client, share);
    } catch {
      // Never measured: the default of the client stands.
    }
  }

  // ---- opening ----

  async #open(adapter: ClientAdapter, request: PoolRequest, slot: Slot): Promise<SessionLease> {
    const via = this.#transport(adapter);
    const { profile, policy, cwd, resumeSessionId } = request;
    const profileId = profile.id;
    const prepared = await this.#telemetry?.prepare(adapter.id, profileId, request.telemetry);
    // Only a session with its own MCP servers (or telemetry) gets an `options`; the others call as before.
    const options: SessionStartOptions = {
      ...(request.mcpServers === undefined ? {} : { mcpServers: request.mcpServers }),
      ...(request.permissions === undefined ? {} : { permissions: request.permissions }),
      ...(prepared === undefined ? {} : { otel: prepared.session }),
    };
    const extra: [SessionStartOptions] | [] = Object.keys(options).length === 0 ? [] : [options];
    if (adapter.processModel === 'process-per-session') {
      const session =
        resumeSessionId === undefined
          ? await adapter.openSession(profile, policy, cwd, via, ...extra)
          : await adapter.loadSession(profile, policy, cwd, resumeSessionId, via, ...extra);
      return this.#lease(
        session,
        adapter.id,
        profileId,
        via.id,
        undefined,
        undefined,
        slot,
        this.#track(session, prepared),
      );
    }
    const { entry, token } = await this.#slotFor(adapter, request, via, prepared);
    try {
      const lent = lendProcess(entry.process, (options) => this.#detach(entry, token, options));
      const session =
        resumeSessionId === undefined
          ? await adapter.openSessionOn(lent, policy, cwd, via, ...extra)
          : await adapter.loadSessionOn(lent, policy, cwd, resumeSessionId, via, ...extra);
      void this.#learn(adapter.id, entry);
      return this.#lease(
        session,
        adapter.id,
        profileId,
        via.id,
        entry,
        token,
        slot,
        this.#track(session, prepared),
      );
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
    prepared: PreparedTelemetry | undefined,
  ): Promise<{ entry: PoolProcess; token: symbol }> {
    // The process-level telemetry has only what is stable for the profile (see `ClientTelemetry`),
    // so sessions of different attempts keep sharing one process: `sharedProcessKey` hashes the env.
    const spec = await adapter.launchSpec(
      request.profile,
      request.policy,
      request.cwd,
      via.id,
      'work',
      prepared?.process,
    );
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
    const launch: PendingLaunch = {
      ready: this.#launch(key, request.profile.id, spec, tokens),
      tokens,
    };
    this.#launching.set(key, [...(this.#launching.get(key) ?? []), launch]);
    const settled = (): void => {
      this.#launched(key, launch);
    };
    void launch.ready.then(settled, settled);
    return { entry: await launch.ready, token };
  }

  async #launch(
    key: string,
    profileId: string,
    spec: LaunchOptions,
    sessions: Set<symbol>,
  ): Promise<PoolProcess> {
    const process = await this.#launcher.launch(spec);
    const entry: PoolProcess = {
      key,
      profileId,
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

  /**
   * Tells the telemetry table that the session exists, so the records its client sends can be tied
   * to the work; returns what to call when the lease is released. Never throws.
   */
  #track(session: AgentSession, prepared: PreparedTelemetry | undefined): (() => void) | undefined {
    const telemetry = this.#telemetry;
    if (telemetry === undefined || prepared === undefined) return undefined;
    telemetry.opened(session.sessionId, prepared);
    return () => {
      telemetry.closed(session.sessionId);
    };
  }

  #lease(
    session: AgentSession,
    client: string,
    profileId: string,
    via: string,
    entry: PoolProcess | undefined,
    token: symbol | undefined,
    slot: Slot,
    onRelease?: () => void,
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
        onRelease?.();
        try {
          await session.close();
        } catch {
          // A session that cannot close is already gone; the slot goes back all the same.
        } finally {
          if (entry !== undefined && token !== undefined) {
            entry.sessions.delete(token);
            this.#startIdleIfEmpty(entry);
          }
          this.#free(slot);
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
