// SPDX-License-Identifier: MPL-2.0
import {
  InvalidInput,
  Transient,
  type LaunchedProcess,
  type ProcessLauncher,
} from '@otheater/core';
import { DEFAULT_GITHUB_TIMEOUT_MS, DEFAULT_INHERITED_ENV } from './config.js';

/** Largest output kept from one command; what is past it is dropped. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** How long the streams may take to end after the process did (a grandchild may hold them). */
const STREAM_DRAIN_MS = 2000;

export interface ToolRunnerOptions {
  readonly launcher: ProcessLauncher;
  readonly timeoutMs?: number;
  /** Names of the parent's variables passed on, besides {@link DEFAULT_INHERITED_ENV}. */
  readonly inheritEnv?: readonly string[];
  /** Variables set for the tools, over the inherited ones. */
  readonly env?: Readonly<Record<string, string>>;
  /** The environment the inherited variables come from. Default: `process.env`. */
  readonly parentEnv?: NodeJS.ProcessEnv;
}

export interface ToolResult {
  readonly stdout: string;
  readonly stderr: string;
  /** Exit code; `-1` when a signal ended the process. */
  readonly code: number;
}

/**
 * Runs `gh` and `git` through the `ProcessLauncher` port (architecture 5.9): an argument array,
 * never a shell, a complete and short environment, a time ceiling that kills the whole tree. The
 * output is read to the end; the exit code is returned, not thrown, so each caller reads the
 * stderr of its own failures.
 */
export class ToolRunner {
  readonly timeoutMs: number;
  readonly #launcher: ProcessLauncher;
  readonly #env: Record<string, string>;

  constructor(options: ToolRunnerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new InvalidInput(`timeoutMs must be a positive integer, got ${String(this.timeoutMs)}`);
    }
    this.#launcher = options.launcher;
    const parent = options.parentEnv ?? process.env;
    const env: Record<string, string> = {};
    for (const key of [...DEFAULT_INHERITED_ENV, ...(options.inheritEnv ?? [])]) {
      const value = parent[key];
      if (value !== undefined) env[key] = value;
    }
    this.#env = {
      ...env,
      // Nothing may wait for a person: no prompt, no pager, no color, no update check.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
      GH_SPINNER_DISABLED: '1',
      NO_COLOR: '1',
      GH_PAGER: 'cat',
      GIT_PAGER: 'cat',
      LC_ALL: 'C',
      LANG: 'C',
      ...options.env,
    };
  }

  async run(binary: string, args: readonly string[], cwd: string): Promise<ToolResult> {
    const child = await this.#launcher.launch({ cmd: binary, args, cwd, env: this.#env });
    const out = readAll(child.stdout);
    const err = readAll(child.stderr);
    // The tools never read a line from us.
    child.stdin.close().catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, this.timeoutMs);
    });
    try {
      const winner = await Promise.race([child.exited, timeout]);
      if (winner === 'timeout') {
        throw new Transient(`${binary} did not finish within ${String(this.timeoutMs)} ms`);
      }
      const [stdout, stderr] = await Promise.all([drained(out), drained(err)]);
      return { stdout, stderr, code: winner.code ?? -1 };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await endTree(child);
    }
  }
}

/** Kills what is left of the tree (idempotent); a failure to kill is not the caller's concern. */
async function endTree(child: LaunchedProcess): Promise<void> {
  try {
    await child.killTree();
  } catch {
    // Already gone.
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes <= MAX_OUTPUT_BYTES) text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return text;
  }
}

function drained(read: Promise<string>): Promise<string> {
  return Promise.race([
    read,
    new Promise<string>((resolve) => {
      setTimeout(() => {
        resolve('');
      }, STREAM_DRAIN_MS).unref();
    }),
  ]);
}
