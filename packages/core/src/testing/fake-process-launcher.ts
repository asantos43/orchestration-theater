// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable } from '../errors.js';
import {
  assertLaunchOptions,
  LAUNCH_MARKER_ENV,
  PROCESS_LAUNCHER_PORT_VERSION,
  type KillReport,
  type LauncherCapabilities,
  type LaunchedProcess,
  type LaunchOptions,
  type MarkedProcess,
  type MarkerScanner,
  type OrphanKillReport,
  type OrphanReaper,
  type OrphanTarget,
  type ProcessExit,
  type ProcessLauncher,
} from '../ports/process-launcher.js';
import type { AdapterImplements } from '../ports/adapter.js';

/** First pid the fake hands out; far from any real one, so a test never mistakes it for a live process. */
const FIRST_FAKE_PID = 4_000_000;
/** The start instant of the first fake process; each launch starts one second later. */
const FIRST_FAKE_START = 1_700_000_000_000;

function emptyReadable(): { stream: ReadableStream<Uint8Array>; end: () => void } {
  let end = (): void => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      end = () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
    },
  });
  return { stream, end };
}

/**
 * A process that exists only in memory: streams that carry nothing, an `exited` promise, and a
 * record of what `killTree` did. It ends when the test says so (`exit`) or when `killTree` is called.
 */
export class FakeLaunchedProcess implements LaunchedProcess {
  readonly pid: number;
  /** The instant the fake process "started" (epoch ms); what `processStartedAt` reports. */
  readonly startedAt: number;
  readonly options: LaunchOptions;
  readonly stdin = new WritableStream<Uint8Array>({ write: () => undefined });
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<ProcessExit>;
  /** How many times `killTree` was called. */
  killTreeCalls = 0;
  /** Pids `killTree` will report as still alive (to test a cancel that does not clean up). */
  leaveBehind: readonly number[] = [];
  #alive = true;
  readonly #endStreams: () => void;
  #settle: (exit: ProcessExit) => void = () => undefined;

  constructor(pid: number, options: LaunchOptions, startedAt = FIRST_FAKE_START) {
    this.pid = pid;
    this.startedAt = startedAt;
    this.options = options;
    const out = emptyReadable();
    const err = emptyReadable();
    this.stdout = out.stream;
    this.stderr = err.stream;
    this.#endStreams = () => {
      out.end();
      err.end();
    };
    this.exited = new Promise<ProcessExit>((resolve) => {
      this.#settle = resolve;
    });
  }

  /** The root process is still running. */
  get alive(): boolean {
    return this.#alive;
  }

  /** The process ends by itself (a crash, a normal exit). */
  exit(code: number | null = 0, signal: string | null = null): void {
    if (!this.#alive) return;
    this.#alive = false;
    this.#endStreams();
    this.#settle({ code, signal });
  }

  killTree(): Promise<KillReport> {
    this.killTreeCalls += 1;
    const found = this.#alive ? 1 : 0;
    this.exit(null, 'SIGTERM');
    return Promise.resolve({ found, forced: false, remaining: this.leaveBehind });
  }
}

/**
 * A `ProcessLauncher` that starts no process: it records every launch and hands out
 * {@link FakeLaunchedProcess}. For tests of what sits above the launcher (the `ClientAdapter`, a
 * session pool); the real behaviour belongs to the adapters of the port.
 */
export class FakeProcessLauncher implements ProcessLauncher, OrphanReaper, MarkerScanner {
  readonly id = 'fake';
  readonly implements: AdapterImplements = {
    port: 'ProcessLauncher',
    range: `^${PROCESS_LAUNCHER_PORT_VERSION}`,
  };
  /** Every process launched, in order. */
  readonly launched: FakeLaunchedProcess[] = [];
  /** When set, the next launches reject with it (`AdapterUnavailable` when it is not a typed error). */
  failWith: Error | undefined;
  /** Every `killOrphan` call, in order, with what it found. */
  readonly orphanKills: { readonly target: OrphanTarget; readonly matched: boolean }[] = [];
  #nextPid = FIRST_FAKE_PID;
  /** Processes of a "previous daemon": alive, owned by nobody here, until `killOrphan` ends them. */
  readonly #ghosts = new Map<number, number>();
  /** The launch marker of each planted orphan (see `plantOrphan`). */
  readonly #ghostMarkers = new Map<number, string>();

  capabilities(): LauncherCapabilities {
    return { treeKill: 'process-group', memoryLimit: false, suspendedStart: false };
  }

  launch(opts: LaunchOptions): Promise<LaunchedProcess> {
    try {
      assertLaunchOptions(opts);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if (this.failWith !== undefined) {
      return Promise.reject(
        new AdapterUnavailable(`cannot start ${opts.cmd}: ${this.failWith.message}`, {
          cause: this.failWith,
        }),
      );
    }
    const process = new FakeLaunchedProcess(
      this.#nextPid,
      opts,
      FIRST_FAKE_START + this.launched.length * 1000,
    );
    this.#nextPid += 1;
    this.launched.push(process);
    return Promise.resolve(process);
  }

  /** Processes still running (a test that ends with a non-zero count leaked one). */
  get running(): readonly FakeLaunchedProcess[] {
    return this.launched.filter((process) => process.alive);
  }

  /** Plants a live process this launcher did not start, as a dead daemon would leave one. */
  plantOrphan(pid: number, startedAt: number, marker?: string): void {
    this.#ghosts.set(pid, startedAt);
    if (marker !== undefined) this.#ghostMarkers.set(pid, marker);
  }

  /** The live processes that carry a launch marker: the planted orphans and what this launcher started with one. */
  findMarked(): Promise<readonly MarkedProcess[]> {
    const marked: MarkedProcess[] = [];
    for (const [pid, marker] of this.#ghostMarkers) {
      const startedAt = this.#ghosts.get(pid);
      if (startedAt !== undefined) marked.push({ marker, pid, startedAt });
    }
    for (const process of this.launched) {
      const marker = process.options.env[LAUNCH_MARKER_ENV];
      if (process.alive && marker !== undefined) {
        marked.push({ marker, pid: process.pid, startedAt: process.startedAt });
      }
    }
    return Promise.resolve(marked);
  }

  /** Whether the planted orphan `pid` is still alive. */
  orphanAlive(pid: number): boolean {
    return this.#ghosts.has(pid);
  }

  processStartedAt(pid: number): Promise<number | undefined> {
    const ghost = this.#ghosts.get(pid);
    if (ghost !== undefined) return Promise.resolve(ghost);
    const own = this.launched.find((process) => process.pid === pid && process.alive);
    return Promise.resolve(own?.startedAt);
  }

  async killOrphan(target: OrphanTarget): Promise<OrphanKillReport> {
    const startedAt = await this.processStartedAt(target.pid);
    const matched = startedAt === target.startedAt;
    this.orphanKills.push({ target, matched });
    if (!matched) return { matched: false, report: { found: 0, forced: false, remaining: [] } };
    if (this.#ghosts.delete(target.pid)) {
      this.#ghostMarkers.delete(target.pid);
      return { matched: true, report: { found: 1, forced: false, remaining: [] } };
    }
    const own = this.launched.find((process) => process.pid === target.pid);
    const report = own === undefined ? undefined : await own.killTree();
    return { matched: true, report: report ?? { found: 0, forced: false, remaining: [] } };
  }
}
