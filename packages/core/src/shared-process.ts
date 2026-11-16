// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from './errors.js';
import type {
  KillOptions,
  KillReport,
  LaunchedProcess,
  LaunchOptions,
  ProcessLauncher,
} from './ports/process-launcher.js';

/** Sessions per client process when nobody says otherwise. [proposta] The same default as `pool.sessions_per_process` of the daemon. */
export const DEFAULT_SESSIONS_PER_PROCESS = 4;

const NOT_KILLED: KillReport = { found: 0, forced: false, remaining: [] };

/**
 * What decides that two sessions may share one process: the profile, the command and the WHOLE
 * environment (`baseEnv` plus `profileEnv`). The environment is one per process, so a session whose
 * policy changes it (OpenCode puts the permission rules in `OPENCODE_PERMISSION`) never lands on
 * a process started for another policy. The working directory is left out: every session names its
 * own in `session/new`. [proposta] Exact comparison of the canonical text, no hash, so two
 * different environments can never collide.
 */
export function sharedProcessKey(
  profile: { readonly id: string; readonly dir: string },
  spec: LaunchOptions,
): string {
  const env = Object.entries(spec.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([profile.id, profile.dir, spec.cmd, spec.args, env]);
}

interface SharedEntry {
  /** Settled once the launcher answered; the lease views are built on it. */
  readonly ready: Promise<LaunchedProcess>;
  /** Leases held now, counting the ones still waiting for the launch. */
  count: number;
  /** The process ended or the entry was emptied: no new session may join. */
  closed: boolean;
}

/**
 * One client process shared by several sessions (`processModel: 'multi-session'`), when no pool
 * above the adapter owns the processes. Each session gets a lease: a {@link LaunchedProcess} view
 * of the same process (same streams, same `exited`) whose `killTree` only gives the lease back.
 * The real tree is killed when the LAST lease leaves, and its report is the one that lease gets;
 * a lease that leaves with others still holding the process gets an empty report. If the process
 * dies, `exited` settles for every lease, so every session sees the end at once.
 *
 * Processes are grouped by a key (see {@link sharedProcessKey}) and hold up to `sessionsPerProcess`
 * leases; another process starts above that, or when the caller asks for an `own` one. The class
 * starts processes only through the injected {@link ProcessLauncher} and reads nothing from the
 * environment.
 */
export class SharedProcessRegistry {
  readonly #launcher: ProcessLauncher;
  readonly #limit: number;
  readonly #entries = new Map<string, SharedEntry[]>();

  constructor(
    launcher: ProcessLauncher,
    sessionsPerProcess: number = DEFAULT_SESSIONS_PER_PROCESS,
  ) {
    if (!Number.isSafeInteger(sessionsPerProcess) || sessionsPerProcess < 1) {
      throw new InvalidInput('sessionsPerProcess must be a positive integer');
    }
    this.#launcher = launcher;
    this.#limit = sessionsPerProcess;
  }

  /** Number of processes alive (or starting) that hold at least one lease. For tests and diagnostics. */
  get processes(): number {
    let total = 0;
    for (const list of this.#entries.values()) total += list.length;
    return total;
  }

  /**
   * A lease on a process for `key`. `shared` joins one that has room and starts another when none
   * has; `own` always starts a new process that no other lease joins. Rejects with whatever the
   * launcher rejects with, and then leaves no entry behind.
   */
  async acquire(
    key: string,
    spec: LaunchOptions,
    mode: 'shared' | 'own' = 'shared',
  ): Promise<LaunchedProcess> {
    const entry = mode === 'shared' ? this.#joinable(key) : undefined;
    if (entry !== undefined) {
      entry.count += 1;
      // If the launch this lease waits for fails, the entry is dropped by the call that started it.
      return this.#lease(key, entry, await entry.ready);
    }
    const fresh: SharedEntry = {
      ready: this.#launcher.launch(spec),
      count: 1,
      closed: false,
    };
    if (mode === 'shared') this.#add(key, fresh);
    let process: LaunchedProcess;
    try {
      process = await fresh.ready;
    } catch (error) {
      this.#drop(key, fresh);
      throw error;
    }
    void process.exited.then(() => {
      this.#drop(key, fresh);
    });
    return this.#lease(key, fresh, process);
  }

  #joinable(key: string): SharedEntry | undefined {
    return this.#entries.get(key)?.find((entry) => !entry.closed && entry.count < this.#limit);
  }

  #add(key: string, entry: SharedEntry): void {
    const list = this.#entries.get(key);
    if (list === undefined) this.#entries.set(key, [entry]);
    else list.push(entry);
  }

  #drop(key: string, entry: SharedEntry): void {
    entry.closed = true;
    const list = this.#entries.get(key);
    if (list === undefined) return;
    const rest = list.filter((candidate) => candidate !== entry);
    if (rest.length === 0) this.#entries.delete(key);
    else this.#entries.set(key, rest);
  }

  #lease(key: string, entry: SharedEntry, process: LaunchedProcess): LaunchedProcess {
    let released: Promise<KillReport> | undefined;
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
      killTree: (options?: KillOptions): Promise<KillReport> => {
        released ??= (() => {
          entry.count -= 1;
          if (entry.count > 0) return Promise.resolve(NOT_KILLED);
          // The last one out: nobody may join a process that is about to be killed.
          this.#drop(key, entry);
          return process.killTree(options);
        })();
        return released;
      },
    };
  }
}
