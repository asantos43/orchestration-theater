// SPDX-License-Identifier: MPL-2.0
// Part of the chaos harness (Phase 11, P1): test only, excluded from the build of the package.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFileSync, mkdirSync, realpathSync, mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { testGit } from '@otheater/sdk';
import { CRASH_CHILD_SCRIPT } from '../recovery/crash-child-fixture.js';
import { CRASHPOINT_LINE, type CrashInfo } from './crash-points.js';
import { aliveEntries, censusPids, PID_DIR_NAME, takeCensus, type Census } from './census.js';
import { CRASH_AT_VARIABLE } from './faults.js';
import {
  checkI1,
  checkI2,
  checkI3,
  checkI4,
  checkI5,
  checkI6,
  checkI7,
  checkI8,
  CommitLedger,
  readCodeHostJournal,
  type InvariantResult,
  type RunReportView,
} from './invariants.js';

/**
 * The chaos harness (Phase 11, P1; docs/23). It starts the daemon as a child process on temporary
 * data (with the fake agent as the client and the fake code host with a journal), kills it at a
 * named point (`crashAt`) or after a number of milliseconds, starts another on the same folder, and
 * checks the invariants I1 to I8 as functions. The test says WHERE to kill; the harness does the
 * rest. Linux only (the census reads `/proc`).
 *
 * Randomness is seeded: {@link resolveSeed} takes `OT_CHAOS_SEED` or draws a seed and prints it, and
 * {@link SeededRandom} turns the seed into the point and the instant. The same seed gives the same
 * plan; the verdict of the invariants is what a run must repeat (the wall clock of the machine is
 * not part of the seed).
 */

const DAEMON_DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const CORE_TESTING = pathToFileURL(
  fileURLToPath(new URL('../../../core/dist/testing/index.js', import.meta.url)),
).href;
const FAKE_AGENT_CLI = fileURLToPath(new URL('../../../fake-agent/dist/cli.js', import.meta.url));

/** Throws if `pnpm build` has not run (the child imports the compiled packages). */
export function assertHarnessBuilt(): void {
  for (const path of [join(DAEMON_DIST, 'daemon.js'), FAKE_AGENT_CLI]) {
    if (!existsSync(path))
      throw new Error(`${path} does not exist: run "pnpm build" before the tests`);
  }
}

// --- the seed -------------------------------------------------------------------------------

/** A small seeded generator (mulberry32): the same seed gives the same sequence on any machine. */
export class SeededRandom {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** A number in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick() of an empty list');
    return item;
  }
}

/**
 * The seed of a run: `OT_CHAOS_SEED` if set (to repeat a failure), else a random one. It is printed
 * to stderr either way, so a failed run says how to repeat itself.
 */
export function resolveSeed(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback?: number,
): number {
  const fromEnv = Number(env.OT_CHAOS_SEED);
  const seed =
    env.OT_CHAOS_SEED !== undefined && Number.isInteger(fromEnv)
      ? fromEnv >>> 0
      : (fallback ?? Math.floor(Math.random() * 0xffffffff));
  process.stderr.write(
    `[chaos] seed=${String(seed)} (repeat with OT_CHAOS_SEED=${String(seed)})\n`,
  );
  return seed;
}

export interface InstantPlan {
  readonly seed: number;
  /** Milliseconds after the daemon says `STARTED` at which it gets `SIGKILL`. */
  readonly delayMs: number;
}

/** The instant of a random kill, from the seed. */
export function planInstant(seed: number, range: { minMs: number; maxMs: number }): InstantPlan {
  return { seed, delayMs: new SeededRandom(seed).int(range.minMs, range.maxMs) };
}

/** The point of a random kill at a named point, from the seed. */
export function planPoint(seed: number, names: readonly string[]): string {
  return new SeededRandom(seed).pick(names);
}

// --- the child daemon -----------------------------------------------------------------------

export interface ChildDaemon {
  readonly process: ChildProcess;
  readonly pid: number;
  /** Resolves with the JSON after `prefix` on the first line that starts with it. */
  line(prefix: string, timeoutMs: number): Promise<unknown>;
  /** Everything the child wrote to stdout so far. */
  output(): string;
  /** The exit signal (`SIGKILL` for a kill), or `null` and the code for a normal exit. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function watch(child: ChildProcess): ChildDaemon {
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
    output: () => out,
    line: (prefix, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`No "${prefix}" line in ${String(timeoutMs)} ms.\n${out}\n${err}`));
        }, timeoutMs);
        const check = (): boolean => {
          const found = out.split('\n').find((candidate) => candidate.startsWith(prefix));
          if (found === undefined) return false;
          clearTimeout(timer);
          const rest = found.slice(prefix.length).trim();
          resolve(rest === '' ? null : JSON.parse(rest));
          return true;
        };
        if (check()) return;
        waiting.push(() => {
          if (child.exitCode !== null || child.signalCode !== null) {
            if (!out.includes(prefix)) {
              clearTimeout(timer);
              reject(new Error(`The child exited before "${prefix}".\n${out}\n${err}`));
              return;
            }
          }
          check();
        });
      }),
  };
}

// --- the rig --------------------------------------------------------------------------------

export interface StartOptions {
  /** `first` opens a chat and sends the Producer's message; `resume` only starts and waits for the play to end. */
  readonly mode: 'first' | 'resume';
  /** `<point>[:<detail>][#<n>]`: the daemon kills itself there (`OT_TEST_CRASH_AT`, `faults.inject: env`). */
  readonly crashAt?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** The crash line a killed daemon wrote, with the data the fixture added. */
export interface CrashLine extends CrashInfo {
  readonly pids?: readonly number[];
}

export interface KillResult {
  readonly how: 'point' | 'instant';
  /** For `point`: what the daemon wrote before the kill. */
  readonly crash?: CrashLine | undefined;
  /** For `instant`: the delay that was used. */
  readonly delayMs?: number | undefined;
  readonly signal: NodeJS.Signals | null;
  /** The census taken right after the kill, before the next start. */
  readonly census: Census;
}

/** What the child prints at the end of a run; a superset of what I6 reads (the tests add to it). */
export interface RunReport extends RunReportView {
  readonly recovered: readonly {
    readonly orphansKilled: number;
    readonly sessionsInterrupted: number;
    readonly effectsResolved: number;
    readonly playsResumed: readonly string[];
    readonly pending: readonly unknown[];
  }[];
  readonly events: readonly { readonly type: string; readonly playId: string | null }[];
  readonly sideEffects: readonly {
    readonly key: string;
    readonly type: string;
    readonly state: string;
    readonly verifier: string | null;
  }[];
  readonly decisions: readonly { readonly kind: string; readonly state: string }[];
  readonly pulls: number;
}

export interface RigOptions {
  /** The program of the child daemon. Default: the one of `recovery/crash-child-fixture.ts`. */
  readonly script?: string | undefined;
  /** Waits, in ms, for each line of the child. */
  readonly lineTimeoutMs?: number | undefined;
}

export class ChaosRig {
  /** The unique folder of the run: everything is inside it, and the census searches for it. */
  readonly runDir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly repo: string;
  readonly journalPath: string;
  readonly ledger: CommitLedger;
  readonly #script: string;
  readonly #lineTimeoutMs: number;
  readonly #children: ChildDaemon[] = [];
  #starts = 0;

  private constructor(runDir: string, options: RigOptions) {
    this.runDir = runDir;
    this.dataDir = join(runDir, 'data');
    this.stateDir = join(runDir, 'state');
    this.repo = join(runDir, 'repo');
    this.journalPath = join(runDir, 'code-host.jsonl');
    this.ledger = new CommitLedger(join(runDir, 'ledger.jsonl'));
    this.#script = join(runDir, 'child.mjs');
    this.#lineTimeoutMs = options.lineTimeoutMs ?? 120_000;
  }

  /** A new run: a folder of its own, a git repository with a bare `origin`, and the program of the child. */
  static async create(options: RigOptions = {}): Promise<ChaosRig> {
    assertHarnessBuilt();
    const runDir = realpathSync(mkdtempSync(join(tmpdir(), 'otheater-chaos-')));
    const rig = new ChaosRig(runDir, options);
    mkdirSync(rig.dataDir, { recursive: true });
    mkdirSync(join(rig.stateDir, PID_DIR_NAME), { recursive: true });
    const remote = join(runDir, 'remote.git');
    await testGit(runDir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
    await testGit(runDir, 'init', '--quiet', '--initial-branch=main', rig.repo);
    await writeFile(join(rig.repo, 'shared.txt'), 'base\n');
    await testGit(rig.repo, 'add', 'shared.txt');
    await testGit(rig.repo, 'commit', '--quiet', '-m', 'initial commit');
    await testGit(rig.repo, 'remote', 'add', 'origin', remote);
    await testGit(rig.repo, 'push', '--quiet', 'origin', 'main');
    await writeFile(rig.#script, options.script ?? CRASH_CHILD_SCRIPT);
    return rig;
  }

  get storePath(): string {
    return join(this.dataDir, 'store.sqlite');
  }

  /** Starts a daemon on the folder of the run. Its pid is written to the state directory (census, source 2). */
  start(options: StartOptions): ChildDaemon {
    this.#starts += 1;
    const child = spawn(process.execPath, [this.#script], {
      env: {
        ...process.env,
        OT_CHILD_MODE: options.mode,
        OT_CHILD_DATA_DIR: this.dataDir,
        OT_CHILD_REPO: this.repo,
        OT_CHILD_JOURNAL: this.journalPath,
        OT_CHILD_STATE_DIR: this.stateDir,
        OT_CHILD_LEDGER: this.ledger.path,
        OT_CHILD_DAEMON_DIST: DAEMON_DIST,
        OT_CHILD_CORE_TESTING: CORE_TESTING,
        OT_CHILD_FAKE_AGENT: FAKE_AGENT_CLI,
        OT_CHAOS_RUN: this.runDir,
        ...(options.crashAt === undefined ? {} : { [CRASH_AT_VARIABLE]: options.crashAt }),
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const watched = watch(child);
    this.#children.push(watched);
    appendFileSync(
      join(this.stateDir, PID_DIR_NAME, `daemon-${String(this.#starts)}.pid`),
      `${String(watched.pid)}\n`,
    );
    return watched;
  }

  /** The census of the run now: `sessions` rows, the pid files and the scan of `/proc`. */
  census(exclude: readonly number[] = []): Census {
    return takeCensus({
      runDir: this.runDir,
      stateDir: this.stateDir,
      storePath: this.storePath,
      exclude,
    });
  }

  /**
   * Starts a daemon that kills itself at the named point and waits for it to. The first start
   * (`mode: first`) is the usual way; a `resume` start with a point of the reconciliation kills
   * the recovery itself.
   */
  async killAtPoint(spec: string, mode: StartOptions['mode'] = 'first'): Promise<KillResult> {
    const child = this.start({ mode, crashAt: spec });
    const crash = (await child.line(CRASHPOINT_LINE, this.#lineTimeoutMs)) as CrashLine;
    const exit = await this.#reap(child);
    return { how: 'point', crash, signal: exit.signal, census: this.census() };
  }

  /**
   * Starts a daemon and sends it `SIGKILL` `delayMs` after it said `STARTED`, a plain wall-clock
   * instant. With `hold` the instant is measured from a signal instead: the fixture's test gate
   * (`OT_CHILD_HOLD_LAUNCH`) lets the first `hold.allow` client launches through (the Producer's)
   * and holds the next one, writing a `.held` marker; the kill comes `delayMs` after that marker.
   * No client is spawned between the marker and the kill, so the outcome does not depend on how
   * fast the machine is.
   */
  async killAfter(
    delayMs: number,
    mode: StartOptions['mode'] = 'first',
    hold?: { readonly allow: number },
  ): Promise<KillResult> {
    const gate = join(this.runDir, 'hold-launch');
    const child = this.start({
      mode,
      ...(hold === undefined
        ? {}
        : { env: { OT_CHILD_HOLD_LAUNCH: gate, OT_CHILD_HOLD_AFTER: String(hold.allow) } }),
    });
    await child.line('STARTED', this.#lineTimeoutMs);
    if (hold !== undefined) {
      const deadline = Date.now() + this.#lineTimeoutMs;
      while (!existsSync(`${gate}.held`)) {
        if (Date.now() > deadline) throw new Error('The test gate never held a client launch.');
        await sleep(10);
      }
    }
    await sleep(delayMs);
    child.process.kill('SIGKILL');
    const exit = await child.exited;
    return { how: 'instant', delayMs, signal: exit.signal, census: this.census() };
  }

  /** Starts another daemon on the same folder and waits for its report (the play ended and it stopped). */
  async restart(options: { crashAt?: string } = {}): Promise<RunReport> {
    const child = this.start({ mode: 'resume', crashAt: options.crashAt });
    const report = (await child.line('REPORT ', this.#lineTimeoutMs)) as RunReport;
    await child.exited;
    return report;
  }

  /** Waits for the self-kill; if the daemon is still there after a grace period it gets `SIGKILL`. */
  async #reap(child: ChildDaemon): Promise<{ signal: NodeJS.Signals | null }> {
    const grace = sleep(10_000).then(() => 'late' as const);
    const outcome = await Promise.race([child.exited, grace]);
    if (outcome === 'late') {
      child.process.kill('SIGKILL');
      return child.exited;
    }
    return outcome;
  }

  /**
   * The invariants after a kill and a restart. `census` is the one taken after the kill (I3 asks
   * that none of it is alive after the recovery), `boots` how many starts the report covers.
   */
  evaluate(input: {
    readonly census: Census;
    readonly report: RunReport;
    readonly boots: number;
    readonly explainedStates?: readonly string[];
  }): InvariantResult[] {
    return [
      checkI1({ dataDir: this.dataDir }),
      checkI2({ storePath: this.storePath, ledger: this.ledger }),
      checkI3(input.census),
      checkI4(readCodeHostJournal(this.journalPath)),
      checkI5({ storePath: this.storePath }),
      checkI6(input.report, {
        boots: input.boots,
        ...(input.explainedStates === undefined ? {} : { explainedStates: input.explainedStates }),
      }),
      checkI7({ root: this.runDir }),
      checkI8({ storePath: this.storePath, ledger: this.ledger }),
    ];
  }

  /** Ends everything the run left alive (by the census, never by a pattern) and removes the folder. */
  async dispose(): Promise<void> {
    for (const child of this.#children) {
      if (child.process.exitCode === null && child.process.signalCode === null) {
        child.process.kill('SIGKILL');
      }
    }
    for (const entry of aliveEntries(this.census())) {
      try {
        process.kill(entry.pid, 'SIGKILL');
      } catch {
        // Gone in the meantime.
      }
    }
    // A process that was just killed may still hold a file for an instant.
    await rm(this.runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** The pids of the census that are alive now (for a test to name them in a message). */
export function alivePids(census: Census): number[] {
  const alive = new Set(aliveEntries(census).map((entry) => entry.pid));
  return censusPids(census).filter((pid) => alive.has(pid));
}
