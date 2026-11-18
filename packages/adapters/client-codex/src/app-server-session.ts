// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, Transient } from '@otheater/core';
import type { LaunchedProcess, ProcessLauncher } from '@otheater/core';

/** How much of what the process says on its error stream is kept, only to explain a failure. */
const STDERR_CAP = 4 * 1024;
/** One answer line is never this long; a longer unfinished line is dropped, not buffered forever. */
const LINE_CAP = 4 * 1024 * 1024;
/** How long after the process ended the end of its output is waited for (a grandchild may hold the pipe). */
const END_GRACE_MS = 100;

/** An error object of the JSON-RPC answer. */
export class AppServerRpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'AppServerRpcError';
  }
}

/** Where the app-server runs: the command, the directory, and the COMPLETE environment. */
export interface AppServerLaunch {
  readonly launcher: ProcessLauncher;
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type NotificationHandler = (method: string, params: unknown) => void;

/** Text of an error that says "nobody is logged in", as far as the client's messages are known [N]. */
const AUTH_PATTERN =
  /authentication required|not logged in|log ?in required|please log ?in|sign ?in|unauthori[sz]ed|\b401\b|no (?:auth|credentials)/iu;

/** Whether a failure text means the profile has no login (an expected state, not an incident). */
export function looksLikeAuthFailure(text: string): boolean {
  return AUTH_PATTERN.test(text);
}

/**
 * A JSON-RPC conversation with `codex app-server` over the standard streams, one JSON object per
 * line (the shape Phase 0 measured, `spikes/quota-probes`) [V]. It only sends and receives lines:
 * it opens no file, and the credentials of the profile stay where the client keeps them.
 *
 * Every request is answered, rejected by the server, or rejected because the process ended; the
 * session never leaves a promise hanging. `close()` ends the whole process tree through the
 * launcher and is idempotent.
 */
export class AppServerSession {
  readonly #process: LaunchedProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  readonly #handlers = new Set<NotificationHandler>();
  readonly #encoder = new TextEncoder();
  #next = 1;
  #stderr = '';
  #ended = false;
  #exit: string | undefined;
  #onEnd: (() => void)[] = [];
  /** Resolves when the process is gone and nothing more will arrive. */
  readonly closed: Promise<void>;

  private constructor(process: LaunchedProcess) {
    this.#process = process;
    this.#writer = process.stdin.getWriter();
    const stdout = this.#pump(process.stdout, (text) => {
      this.#onStdout(text);
    });
    void this.#pump(process.stderr, (text) => {
      this.#stderr = (this.#stderr + text).slice(-STDERR_CAP);
    });
    let endedByExit: ReturnType<typeof setTimeout> | undefined;
    void process.exited.then((exit) => {
      this.#exit =
        exit.code === null ? `signal ${exit.signal ?? 'unknown'}` : `code ${String(exit.code)}`;
      endedByExit = setTimeout(() => {
        this.#finish();
      }, END_GRACE_MS);
      endedByExit.unref();
    });
    void stdout.then(() => {
      clearTimeout(endedByExit);
      this.#finish();
    });
    this.closed = new Promise<void>((resolve) => {
      this.#onEnd.push(resolve);
    });
  }

  /** Starts the process. The launcher decides how (process group, memory limit); the session only talks. */
  static async open(where: AppServerLaunch): Promise<AppServerSession> {
    const process = await where.launcher.launch({
      cmd: where.cmd,
      args: [...where.args],
      cwd: where.cwd,
      env: where.env,
    });
    return new AppServerSession(process);
  }

  /** The tail of what the process said on its error stream. For messages only. */
  get stderrTail(): string {
    return this.#stderr;
  }

  /** Whether the process has ended and nothing more will arrive. */
  get ended(): boolean {
    return this.#ended;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  /** Sends a request and waits for its answer. Rejects with `AppServerRpcError`, or `Transient` if the process ends. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#ended) return Promise.reject(this.#endError());
    const id = this.#next++;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }).catch(
      (error: unknown) => {
        const entry = this.#pending.get(id);
        if (entry === undefined) return;
        this.#pending.delete(id);
        entry.reject(this.#endError(error));
      },
    );
    return answer;
  }

  /** Sends a notification (no answer). */
  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#ended) throw this.#endError();
    await this.#send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }).catch(
      (error: unknown) => {
        throw this.#endError(error);
      },
    );
  }

  /** Ends the process and its whole tree; rejects what is pending. Idempotent, never throws. */
  async close(): Promise<void> {
    await this.#process.killTree().catch(() => undefined);
    this.#writer.close().catch(() => undefined);
    this.#finish();
    await this.closed;
  }

  #send(message: object): Promise<void> {
    return this.#writer.write(this.#encoder.encode(`${JSON.stringify(message)}\n`));
  }

  /** The error that explains why the process cannot answer: no login if its own words say so. */
  #endError(cause?: unknown): Error {
    const said = this.#stderr.trim().slice(-400);
    const how = this.#exit === undefined ? 'closed its streams' : `ended with ${this.#exit}`;
    const text = `codex app-server ${how}${said === '' ? '' : `: ${said}`}`;
    if (looksLikeAuthFailure(said)) {
      return new AdapterUnavailable(text, cause === undefined ? undefined : { cause });
    }
    return new Transient(text, cause === undefined ? undefined : { cause });
  }

  #finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    const error = this.#endError();
    for (const entry of this.#pending.values()) entry.reject(error);
    this.#pending.clear();
    for (const done of this.#onEnd) done();
    this.#onEnd = [];
  }

  async #pump(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        onText(decoder.decode(value, { stream: true }));
      }
    } catch {
      // The stream broke with the process: whatever it said is all there is.
    }
  }

  #buffer = '';

  #onStdout(text: string): void {
    this.#buffer += text;
    for (;;) {
      const at = this.#buffer.indexOf('\n');
      if (at < 0) break;
      const line = this.#buffer.slice(0, at).trim();
      this.#buffer = this.#buffer.slice(at + 1);
      if (line !== '') this.#onLine(line);
    }
    if (this.#buffer.length > LINE_CAP) this.#buffer = '';
  }

  #onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Not protocol (a log line on stdout): ignored, never an answer.
    }
    if (typeof message !== 'object' || message === null) return;
    const record = message as Record<string, unknown>;
    const id = record.id;
    const method = record.method;
    if (typeof method === 'string') {
      if (id === undefined) {
        for (const handler of this.#handlers) {
          try {
            handler(method, record.params);
          } catch {
            // A faulty listener must not stop the conversation.
          }
        }
      } else {
        // A request from the server: this session offers no method, so say so instead of leaving it waiting.
        this.#send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'method not found' },
        }).catch(() => undefined);
      }
      return;
    }
    if (typeof id !== 'number') return;
    const entry = this.#pending.get(id);
    if (entry === undefined) return;
    this.#pending.delete(id);
    const error = record.error;
    if (typeof error === 'object' && error !== null) {
      const { code, message: text } = error as { code?: unknown; message?: unknown };
      entry.reject(
        new AppServerRpcError(
          typeof code === 'number' ? code : undefined,
          typeof text === 'string' ? text : 'the app-server refused the request',
        ),
      );
      return;
    }
    entry.resolve(record.result);
  }
}
