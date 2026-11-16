// SPDX-License-Identifier: MPL-2.0
import {
  assertLaunchOptions,
  PROCESS_LAUNCHER_PORT_VERSION,
  type AdapterImplements,
  type KillReport,
  type LauncherCapabilities,
  type LaunchedProcess,
  type LaunchOptions,
  type ProcessExit,
  type ProcessLauncher,
} from '@otheater/core';

/** What a scripted process prints and how it ends. */
export interface Script {
  readonly stdout?: string;
  readonly stderr?: string;
  /** Default 0. `null` ends the process as a signal does. */
  readonly code?: number | null;
  /** When true the process never ends and prints nothing, until `killTree`. */
  readonly hang?: boolean;
  /** Prints `stdout` in this many pieces (default 1), to test reads that span chunks. */
  readonly chunks?: number;
}

function streamOf(text: string, chunks: number, keepOpen: boolean) {
  const bytes = new TextEncoder().encode(text);
  const size = Math.max(1, Math.ceil(bytes.length / Math.max(1, chunks)));
  let close = (): void => undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += size) {
        controller.enqueue(bytes.slice(at, at + size));
      }
      close = () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      if (!keepOpen) close();
    },
  });
  return {
    stream,
    close: () => {
      close();
    },
  };
}

/** A process that prints a script and ends; it records what was written to its stdin and the kills. */
export class ScriptedProcess implements LaunchedProcess {
  readonly pid: number;
  readonly options: LaunchOptions;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<ProcessExit>;
  killTreeCalls = 0;
  stdinClosed = false;
  readonly #closeStreams: () => void;
  readonly #settle: (exit: ProcessExit) => void;
  #ended = false;

  constructor(pid: number, options: LaunchOptions, script: Script) {
    this.pid = pid;
    this.options = options;
    const hang = script.hang === true;
    const out = streamOf(script.stdout ?? '', script.chunks ?? 1, hang);
    const err = streamOf(script.stderr ?? '', 1, hang);
    this.stdout = out.stream;
    this.stderr = err.stream;
    this.#closeStreams = () => {
      out.close();
      err.close();
    };
    this.stdin = new WritableStream<Uint8Array>({
      close: () => {
        this.stdinClosed = true;
      },
    });
    let settle: (exit: ProcessExit) => void = () => undefined;
    this.exited = new Promise<ProcessExit>((resolve) => {
      settle = resolve;
    });
    this.#settle = settle;
    if (!hang) this.#end(script.code === undefined ? 0 : script.code, null);
  }

  #end(code: number | null, signal: string | null): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#closeStreams();
    this.#settle({ code, signal });
  }

  killTree(): Promise<KillReport> {
    this.killTreeCalls += 1;
    this.#end(null, 'SIGTERM');
    return Promise.resolve({ found: 1, forced: false, remaining: [] });
  }
}

/** A `ProcessLauncher` that runs a script per launch (the last one repeats) and records every launch. */
export class ScriptedLauncher implements ProcessLauncher {
  readonly id = 'scripted';
  readonly implements: AdapterImplements = {
    port: 'ProcessLauncher',
    range: `^${PROCESS_LAUNCHER_PORT_VERSION}`,
  };
  readonly launched: ScriptedProcess[] = [];
  readonly #scripts: readonly Script[];
  #nextPid = 5_000_000;

  constructor(...scripts: readonly Script[]) {
    this.#scripts = scripts.length === 0 ? [{}] : scripts;
  }

  capabilities(): LauncherCapabilities {
    return { treeKill: 'process-group', memoryLimit: false, suspendedStart: false };
  }

  launch(options: LaunchOptions): Promise<LaunchedProcess> {
    try {
      assertLaunchOptions(options);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const script = this.#scripts[Math.min(this.launched.length, this.#scripts.length - 1)] ?? {};
    const process = new ScriptedProcess(this.#nextPid, options, script);
    this.#nextPid += 1;
    this.launched.push(process);
    return Promise.resolve(process);
  }
}
