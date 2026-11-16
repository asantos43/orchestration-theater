// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable } from '../errors.js';
import {
  assertLaunchOptions,
  PROCESS_LAUNCHER_PORT_VERSION,
  type KillReport,
  type LauncherCapabilities,
  type LaunchedProcess,
  type LaunchOptions,
  type ProcessExit,
  type ProcessLauncher,
} from '../ports/process-launcher.js';
import type { AdapterImplements } from '../ports/adapter.js';

/** First pid the fake hands out; far from any real one, so a test never mistakes it for a live process. */
const FIRST_FAKE_PID = 4_000_000;

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

  constructor(pid: number, options: LaunchOptions) {
    this.pid = pid;
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
export class FakeProcessLauncher implements ProcessLauncher {
  readonly id = 'fake';
  readonly implements: AdapterImplements = {
    port: 'ProcessLauncher',
    range: `^${PROCESS_LAUNCHER_PORT_VERSION}`,
  };
  /** Every process launched, in order. */
  readonly launched: FakeLaunchedProcess[] = [];
  /** When set, the next launches reject with it (`AdapterUnavailable` when it is not a typed error). */
  failWith: Error | undefined;
  #nextPid = FIRST_FAKE_PID;

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
    const process = new FakeLaunchedProcess(this.#nextPid, opts);
    this.#nextPid += 1;
    this.launched.push(process);
    return Promise.resolve(process);
  }

  /** Processes still running (a test that ends with a non-zero count leaked one). */
  get running(): readonly FakeLaunchedProcess[] {
    return this.launched.filter((process) => process.alive);
  }
}
