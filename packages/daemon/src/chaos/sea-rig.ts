// SPDX-License-Identifier: MPL-2.0
// Part of the chaos harness (Phase 11, P12): test only, excluded from the build of the package.
import { spawn, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { aliveEntries, PID_DIR_NAME, takeCensus, type Census } from './census.js';
import {
  checkI1,
  checkI2,
  checkI3,
  checkI5,
  checkI7,
  checkI8,
  CommitLedger,
  type InvariantResult,
  type LedgerEntry,
} from './invariants.js';

/**
 * The chaos rig over the single executable of Phase 10 (Phase 11, P12; docs/23). The executable is
 * started as a user would start it (`otheater daemon --data-dir <dir>`), on a temporary home, with
 * an empty `PATH`, the file vault and no scheduled backup: the product configuration and nothing
 * else, because a compiled executable cannot take code from the test (no fake clock, vault, code
 * host or client, and `faults.inject` is always off in a release build). What the rig can do is what
 * a kill can do from the outside: `SIGKILL` at an instant, a restart, and the invariants that read
 * the files the daemon left. It never starts a client, and it touches nothing outside its folder.
 */

/** What the daemon prints when it is ready (the same line the smoke of `tools/release` waits for). */
export const SEA_READY_LINE = 'daemon running';

/**
 * The config of the daemon in the data folder (as `SMOKE_CONFIG` of `tools/release`): the file vault
 * with light scrypt (no keyring, no prompt) and no scheduled backup. `faults.inject` stays off.
 */
export const SEA_CHAOS_CONFIG = `ui:
  locale: en
adapters:
  vault: encrypted-file
vault:
  scrypt: { N: 16384, r: 8, p: 1 }
backup:
  when: manual
  content: store_only
`;

export interface SeaDaemon {
  readonly process: ChildProcess;
  readonly pid: number;
  /** Resolves when the ready line came; rejects when the process ended first or `timeoutMs` passed. */
  ready(timeoutMs: number): Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Everything the child wrote so far (stdout, then stderr). */
  output(): string;
}

function watchDaemon(child: ChildProcess): SeaDaemon {
  let out = '';
  let err = '';
  const waiting: (() => void)[] = [];
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    out += chunk;
    for (const wake of waiting) wake();
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    err += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => {
      for (const wake of waiting) wake();
      resolve({ code, signal });
    });
  });
  return {
    process: child,
    pid: child.pid ?? 0,
    exited,
    output: () => `${out}${err}`,
    ready: (timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`No "${SEA_READY_LINE}" in ${String(timeoutMs)} ms.\n${out}\n${err}`));
        }, timeoutMs);
        const check = (): void => {
          if (out.includes(SEA_READY_LINE)) {
            clearTimeout(timer);
            resolve();
          } else if (child.exitCode !== null || child.signalCode !== null) {
            clearTimeout(timer);
            reject(new Error(`The daemon ended before it was ready.\n${out}\n${err}`));
          }
        };
        waiting.push(check);
        check();
      }),
  };
}

/** What a restart of the daemon over a store a kill left behind showed. */
export interface SeaStart {
  readonly daemon: SeaDaemon;
  /** Milliseconds from the spawn to the ready line. */
  readonly readyMs: number;
}

export class SeaRig {
  readonly runDir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly ledger: CommitLedger;
  readonly executable: string;
  readonly #home: string;
  readonly #emptyPath: string;
  readonly #children: SeaDaemon[] = [];
  #starts = 0;
  #poller: NodeJS.Timeout | undefined;
  #polling = false;
  #lastEventId = 0;
  readonly #seenEffects = new Set<string>();

  private constructor(runDir: string, executable: string) {
    this.runDir = runDir;
    this.executable = executable;
    this.dataDir = join(runDir, 'data');
    this.stateDir = join(runDir, 'state');
    this.#home = join(runDir, 'home');
    this.#emptyPath = join(runDir, 'empty-path');
    this.ledger = new CommitLedger(join(runDir, 'ledger.jsonl'));
  }

  /** A new run: a folder of its own with a home, a data folder with the config, and an empty PATH. */
  static create(executable: string): SeaRig {
    const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'otheater-chaos-sea-')));
    const rig = new SeaRig(runDir, executable);
    for (const dir of [rig.dataDir, join(rig.stateDir, PID_DIR_NAME), rig.#home, rig.#emptyPath]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(rig.dataDir, 'config.yaml'), SEA_CHAOS_CONFIG);
    return rig;
  }

  get storePath(): string {
    return join(this.dataDir, 'store.sqlite');
  }

  /** The folder the executable extracts its native addons to (`<data>/native/<sha256>/<name>`). */
  get nativeDir(): string {
    return join(this.dataDir, 'native');
  }

  /** How many daemons this rig started. */
  get starts(): number {
    return this.#starts;
  }

  /** Starts the executable as the daemon on the folder of the run; its pid goes to the pid files (census, source 2). */
  start(): SeaDaemon {
    this.#starts += 1;
    const child = spawn(this.executable, ['daemon', '--data-dir', this.dataDir], {
      env: {
        PATH: this.#emptyPath,
        HOME: this.#home,
        XDG_CONFIG_HOME: join(this.#home, 'config'),
        XDG_DATA_HOME: join(this.#home, 'share'),
        XDG_STATE_HOME: join(this.#home, 'state'),
        OT_CLIENT_CONFIG_DIR: join(this.runDir, 'client'),
        LANG: 'C.UTF-8',
        // The census finds a process by this folder in its environment, too.
        OT_CHAOS_RUN: this.runDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const watched = watchDaemon(child);
    this.#children.push(watched);
    appendFileSync(
      join(this.stateDir, PID_DIR_NAME, `daemon-${String(this.#starts)}.pid`),
      `${String(watched.pid)}\n`,
    );
    return watched;
  }

  /** Starts the daemon and waits for its ready line. */
  async startReady(timeoutMs = 90_000): Promise<SeaStart> {
    const started = Date.now();
    const daemon = this.start();
    await daemon.ready(timeoutMs);
    return { daemon, readyMs: Date.now() - started };
  }

  /** Starts the daemon and sends it `SIGKILL` `delayMs` after the spawn, whatever it is doing. */
  async killAfter(
    delayMs: number,
  ): Promise<{ signal: NodeJS.Signals | null; readyBeforeKill: boolean; census: Census }> {
    const daemon = this.start();
    await sleep(delayMs);
    const readyBeforeKill = daemon.output().includes(SEA_READY_LINE);
    daemon.process.kill('SIGKILL');
    const exit = await daemon.exited;
    return { signal: exit.signal, readyBeforeKill, census: this.census() };
  }

  /** `SIGKILL` for a daemon that is running. */
  async kill(daemon: SeaDaemon): Promise<Census> {
    daemon.process.kill('SIGKILL');
    await daemon.exited;
    return this.census();
  }

  /** A clean stop (`SIGTERM`): the exit code of the daemon. */
  async stop(daemon: SeaDaemon, timeoutMs = 30_000): Promise<number | null> {
    daemon.process.kill('SIGTERM');
    const timer = setTimeout(() => daemon.process.kill('SIGKILL'), timeoutMs);
    const exit = await daemon.exited;
    clearTimeout(timer);
    return exit.code;
  }

  /** Reads `GET /v1/status` of the running daemon through `api.json` and `api-token`. */
  async status(): Promise<{ state?: string; version?: string }> {
    const info = JSON.parse(readFileSync(join(this.dataDir, 'api.json'), 'utf8')) as {
      url: string;
    };
    const token = readFileSync(join(this.dataDir, 'api-token'), 'utf8').trim();
    const response = await fetch(`${info.url}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200)
      throw new Error(`GET /v1/status answered ${String(response.status)}`);
    return (await response.json()) as { state?: string; version?: string };
  }

  /** The census of the run now: the pid files and the scan of `/proc` (the executable has no `sessions` rows). */
  census(exclude: readonly number[] = []): Census {
    return takeCensus({
      runDir: this.runDir,
      stateDir: this.stateDir,
      storePath: this.storePath,
      exclude,
    });
  }

  /**
   * Starts watching the store from the outside: every 20 ms the events and side effects it can read
   * are written to the ledger of I2 and I8, with `fsync`, before anything counts them. Only what is
   * committed is visible to a reader, so a kill never leaves a confirmed row out of the ledger. The
   * store being created or locked at that instant is not an error: the next poll tries again.
   */
  watchStore(): void {
    if (this.#poller !== undefined) return;
    this.#poller = setInterval(() => {
      this.pollLedger();
    }, 20);
    this.#poller.unref();
  }

  /** One poll of the ledger (public so a test can take a last one after a stop). */
  pollLedger(): void {
    if (this.#polling || !existsSync(this.storePath)) return;
    this.#polling = true;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.storePath);
      db.exec('PRAGMA query_only = ON');
      const entries: LedgerEntry[] = [];
      const events = db
        .prepare('SELECT id, type FROM events WHERE id > ? ORDER BY id')
        .all(this.#lastEventId) as { id: number; type: string }[];
      for (const row of events) {
        entries.push({ kind: 'event', id: row.id, type: row.type });
        this.#lastEventId = row.id;
      }
      const effects = db.prepare('SELECT idempotency_key FROM side_effects').all() as {
        idempotency_key: string;
      }[];
      for (const row of effects) {
        if (this.#seenEffects.has(row.idempotency_key)) continue;
        this.#seenEffects.add(row.idempotency_key);
        entries.push({ kind: 'side_effect', key: row.idempotency_key });
      }
      this.ledger.confirm(entries);
    } catch {
      // The store is not there yet, is busy, or a kill left it mid-way: try again at the next tick.
    } finally {
      db?.close();
      this.#polling = false;
    }
  }

  /** How many `daemon.recovered` events the store holds (one per start that finished its reconciliation). */
  recoveredCount(): number {
    if (!existsSync(this.storePath)) return 0;
    const db = new DatabaseSync(this.storePath);
    try {
      db.exec('PRAGMA query_only = ON');
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'daemon.recovered'")
        .get() as {
        n: number;
      };
      return row.n;
    } finally {
      db.close();
    }
  }

  /**
   * The invariants that can be read from the outside of an executable. I4 (the code host journal) and
   * the play half of I6 need a play, and a play needs a client: neither exists here, and the test
   * says so instead of passing them in silence. `allowedLeftovers` is what I7 may let stay.
   */
  evaluate(input: {
    readonly census: Census;
    readonly allowedLeftovers?: readonly RegExp[] | undefined;
  }): InvariantResult[] {
    return [
      checkI1({ dataDir: this.dataDir }),
      checkI2({ storePath: this.storePath, ledger: this.ledger }),
      checkI3(input.census),
      checkI5({ storePath: this.storePath }),
      checkI7({
        root: this.runDir,
        ...(input.allowedLeftovers === undefined ? {} : { allowed: input.allowedLeftovers }),
      }),
      checkI8({ storePath: this.storePath, ledger: this.ledger }),
    ];
  }

  /** Ends everything the run left alive (by the census, never by a pattern) and removes the folder. */
  async dispose(): Promise<void> {
    if (this.#poller !== undefined) clearInterval(this.#poller);
    for (const child of this.#children) {
      if (child.process.exitCode === null && child.process.signalCode === null) {
        child.process.kill('SIGKILL');
      }
    }
    const census = this.census();
    for (const entry of aliveEntries(census)) {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // Gone in the meantime.
      }
    }
    const deadline = Date.now() + 5_000;
    while (aliveEntries(census).length > 0 && Date.now() < deadline) await sleep(25);
    await rm(this.runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}
