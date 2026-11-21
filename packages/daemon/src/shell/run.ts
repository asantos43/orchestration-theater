// SPDX-License-Identifier: MPL-2.0
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Clock, LaunchOptions, ProcessLauncher } from '@otheater/core';
import { DRAIN_MS } from '../tools/run-command.js';

export interface ShellRunSpec {
  /** The program and its arguments (the shell and `-c <line>`). */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The COMPLETE environment of the child (the launcher inherits nothing). */
  readonly env: Readonly<Record<string, string>>;
  /** `null`: no deadline (`chat.shell_command.timeout: off`). */
  readonly timeoutMs: number | null;
  /** Where stdout and stderr go, merged in the order they arrive. */
  readonly logPath: string;
  /** The log stops growing past this many bytes. */
  readonly logMaxBytes: number;
}

export interface ShellRunResult {
  /** `null` when a signal ended the process: the timeout, most of the time. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** Time the process ran. */
  readonly durationMs: number;
  /** Bytes the process wrote (the log keeps up to `logMaxBytes` of them). */
  readonly outputBytes: number;
  readonly logTruncated: boolean;
}

export interface ShellRun {
  /** Settles when the process, and its pipes, are done. Rejects only if the log cannot be written. */
  readonly done: Promise<ShellRunResult>;
  /** Ends the whole tree now (the daemon is stopping). Never rejects. */
  kill(): Promise<void>;
}

/** Writes what the pipes give, one chunk after the other, up to the cap of the log. */
class LogSink {
  readonly #file: FileHandle;
  readonly #max: number;
  #written = 0;
  #seen = 0;
  #chain: Promise<void> = Promise.resolve();
  #failure: Error | undefined;

  constructor(file: FileHandle, max: number) {
    this.#file = file;
    this.#max = max;
  }

  get seen(): number {
    return this.#seen;
  }

  get truncated(): boolean {
    return this.#seen > this.#max;
  }

  push(chunk: Uint8Array): void {
    this.#seen += chunk.length;
    const room = this.#max - this.#written;
    if (room <= 0) return;
    const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
    this.#written += part.length;
    this.#chain = this.#chain.then(async () => {
      if (this.#failure !== undefined) return;
      try {
        await this.#file.write(part);
      } catch (error) {
        this.#failure = error instanceof Error ? error : new Error(String(error));
      }
    });
  }

  /** Waits for the writes and closes the file; throws what the writes hit. */
  async close(): Promise<void> {
    await this.#chain;
    await this.#file.close();
    if (this.#failure !== undefined) throw this.#failure;
  }
}

/** Reads a stream into the sink until it ends, errors or is cancelled. Never rejects. */
function pump(stream: ReadableStream<Uint8Array>, sink: LogSink) {
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) return;
        sink.push(value);
      }
    } catch {
      // A pipe that breaks ends the output where it was.
    }
  })();
  return { done, cancel: () => reader.cancel().catch(() => undefined) };
}

/**
 * Starts one `!` command under the `ProcessLauncher` (architecture 5.13): stdin closed (a program
 * that waits for input sees the end of the file; there is no terminal), stdout and stderr merged
 * into the log file as they arrive (the memory of the daemon never holds the output), and, when
 * `timeoutMs` is set, a deadline that ends the whole process tree through `killTree`. A non-zero
 * exit and a timeout are results, not errors. A launcher that cannot start the process rejects
 * (`AdapterUnavailable`), and with `confine` a sandbox that cannot wrap rejects too, so the
 * command never runs unconfined by accident.
 */
export async function startShell(
  launcher: ProcessLauncher,
  clock: Clock,
  spec: ShellRunSpec,
  confine?: (launch: LaunchOptions) => Promise<LaunchOptions>,
): Promise<ShellRun> {
  const [cmd, ...args] = spec.argv;
  if (cmd === undefined) throw new RangeError('startShell needs a non-empty argv');
  const startedAt = clock.now();
  const launch: LaunchOptions = { cmd, args, cwd: spec.cwd, env: spec.env };
  const wrapped = confine === undefined ? launch : await confine(launch);
  await mkdir(dirname(spec.logPath), { recursive: true });
  // The output may hold what the Producer would not paste: the log is for them alone.
  const file = await open(spec.logPath, 'w', 0o600);
  let proc;
  try {
    proc = await launcher.launch(wrapped);
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
  const sink = new LogSink(file, spec.logMaxBytes);
  const pumps = [pump(proc.stdout, sink), pump(proc.stderr, sink)];
  void proc.stdin
    .getWriter()
    .close()
    .catch(() => undefined);

  const state = { timedOut: false };
  const timer = new AbortController();
  if (spec.timeoutMs !== null) {
    void clock.sleep(spec.timeoutMs, timer.signal).then(
      () => {
        state.timedOut = true;
        void proc.killTree().catch(() => undefined);
      },
      () => undefined,
    );
  }
  const running = proc;

  const done = (async (): Promise<ShellRunResult> => {
    let exit;
    try {
      exit = await running.exited;
    } finally {
      timer.abort();
    }
    const drain = new AbortController();
    const drained = await Promise.race([
      Promise.all(pumps.map((p) => p.done)).then(() => true),
      clock.sleep(DRAIN_MS, drain.signal).then(
        () => false,
        () => true,
      ),
    ]);
    drain.abort();
    if (!drained) {
      // A descendant still holds a pipe: end the tree and keep what was read.
      await running.killTree({ graceMs: 0 }).catch(() => undefined);
      await Promise.all(pumps.map((p) => p.cancel()));
    }
    await sink.close();
    return {
      exitCode: state.timedOut ? null : exit.code,
      timedOut: state.timedOut,
      durationMs: Math.max(0, clock.now() - startedAt),
      outputBytes: sink.seen,
      logTruncated: sink.truncated,
    };
  })();
  return {
    done,
    kill: async () => {
      timer.abort();
      await running.killTree({ graceMs: 0 }).catch(() => undefined);
    },
  };
}
