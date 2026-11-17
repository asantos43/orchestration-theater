// SPDX-License-Identifier: MPL-2.0
import {
  OutputCollector,
  type Clock,
  type ProcessLauncher,
  type TruncatedOutput,
  type TruncateMode,
} from '@otheater/core';

/**
 * After the root process ends, how long its pipes get to drain. A grandchild that keeps a pipe
 * open (a daemonised helper) would hold the call forever otherwise; at the end of this time the
 * tree is killed and what was read so far is the output. [proposta] Not a config key: it is a
 * guard against a hung pipe, not a limit of the work.
 */
export const DRAIN_MS = 2000;

export interface CommandSpec {
  /** The program and its arguments; `argv[0]` is the executable. No shell is involved. */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The COMPLETE environment of the child (the launcher inherits nothing). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly outputMaxBytes: number;
  readonly truncate: TruncateMode;
}

export interface CommandResult {
  /** `null` when a signal ended the process: the timeout, most of the time. */
  readonly exitCode: number | null;
  readonly stdout: TruncatedOutput;
  readonly stderr: TruncatedOutput;
  readonly timedOut: boolean;
  /** Time the process ran, not counting the wait for the semaphore. */
  readonly durationMs: number;
}

interface Pump {
  readonly done: Promise<void>;
  cancel(): Promise<void>;
}

/** Reads a stream into a collector until it ends, errors or is cancelled. Never rejects. */
function pump(stream: ReadableStream<Uint8Array>, collector: OutputCollector): Pump {
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) return;
        collector.push(value);
      }
    } catch {
      // A pipe that breaks ends the output where it was.
    }
  })();
  return {
    done,
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

/**
 * Runs one command under the `ProcessLauncher` (architecture 5.8 and 5.9): no shell, stdin
 * closed, stdout and stderr cut to `outputMaxBytes` each as they arrive (the memory of the daemon
 * never holds more), and a timeout that ends the whole process tree through `killTree`.
 *
 * A non-zero exit is a normal result, not an error; so is a timeout (`timedOut`, `exitCode`
 * `null`). A launcher that cannot start the process rejects (`AdapterUnavailable`).
 */
export async function runCommand(
  launcher: ProcessLauncher,
  clock: Clock,
  spec: CommandSpec,
): Promise<CommandResult> {
  const [cmd, ...args] = spec.argv;
  if (cmd === undefined) throw new RangeError('runCommand needs a non-empty argv');
  const startedAt = clock.now();
  const proc = await launcher.launch({ cmd, args, cwd: spec.cwd, env: spec.env });

  const stdout = new OutputCollector(spec.outputMaxBytes, spec.truncate);
  const stderr = new OutputCollector(spec.outputMaxBytes, spec.truncate);
  const pumps = [pump(proc.stdout, stdout), pump(proc.stderr, stderr)];
  // The command gets no input: a program that waits for stdin sees the end of the file.
  void proc.stdin
    .getWriter()
    .close()
    .catch(() => undefined);

  const state = { timedOut: false };
  const timer = new AbortController();
  void clock.sleep(spec.timeoutMs, timer.signal).then(
    () => {
      state.timedOut = true;
      void proc.killTree().catch(() => undefined);
    },
    () => undefined,
  );

  let exit;
  try {
    exit = await proc.exited;
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
    await proc.killTree({ graceMs: 0 }).catch(() => undefined);
    await Promise.all(pumps.map((p) => p.cancel()));
  }

  return {
    exitCode: state.timedOut ? null : exit.code,
    stdout: stdout.result(),
    stderr: stderr.result(),
    timedOut: state.timedOut,
    durationMs: Math.max(0, clock.now() - startedAt),
  };
}
