// SPDX-License-Identifier: MPL-2.0
import { spawn, type ChildProcess } from 'node:child_process';

/** How to start the server of a plugin: the `command` of its manifest, run with no shell. */
export interface PluginProcessSpec {
  readonly command: string;
  readonly args?: readonly string[];
  /** Working directory; the folder of the plugin when the manifest says nothing else. */
  readonly cwd?: string;
  /**
   * The whole environment of the process. The default is only `PATH`, like the minimal
   * environment the daemon gives a plugin; nothing is inherited.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface PluginToolDescription {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: { readonly type?: string; readonly [key: string]: unknown };
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly openWorldHint?: boolean;
    readonly [key: string]: unknown;
  };
}

export interface PluginToolResult {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
}

/** A notification the server sent: an event of the plugin is `notifications/otheater/event`. */
export interface PluginNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface PluginStdioClientOptions {
  /** Deadline of each request, and of the end of the process, in ms. Default 10 000. */
  readonly timeoutMs?: number;
}

/** The protocol revision the client claims; the server answers with the one it supports. */
const CLIENT_PROTOCOL_VERSION = '2025-06-18';

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * A minimal MCP client over stdio, for testing the server of a plugin: it starts the process,
 * does the handshake and speaks `tools/list` and `tools/call`. It is not the client of the daemon
 * (P5): it only keeps what the conformance suite and the tests of a plugin need, and it records
 * the notifications and the stdout lines that were not JSON-RPC, which a plugin must not write.
 */
export class PluginStdioClient {
  /** Every notification the server sent, in order. */
  readonly notifications: PluginNotification[] = [];
  /** Lines of stdout that were not a JSON-RPC message: standard output belongs to the protocol. */
  readonly strayOutput: string[] = [];
  /** What the server wrote to stderr. */
  stderr = '';

  readonly #child: ChildProcess;
  readonly #timeoutMs: number;
  readonly #pending = new Map<number, Pending>();
  readonly #exited: Promise<number | null>;
  #buffer = '';
  #nextId = 1;
  #spawnError: Error | undefined;

  private constructor(child: ChildProcess, timeoutMs: number) {
    this.#child = child;
    this.#timeoutMs = timeoutMs;
    this.#exited = new Promise((resolve) => {
      child.once('close', (code) => {
        resolve(code);
      });
    });
    child.once('error', (error) => {
      this.#spawnError = error;
      this.#failAll(error);
    });
    child.once('close', () => {
      this.#failAll(new Error(`the plugin process ended${this.#tail()}`));
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.#buffer += chunk;
      let newline = this.#buffer.indexOf('\n');
      while (newline >= 0) {
        this.#line(this.#buffer.slice(0, newline).replace(/\r$/, ''));
        this.#buffer = this.#buffer.slice(newline + 1);
        newline = this.#buffer.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
  }

  /** Starts the process and does the MCP handshake (`initialize`, `notifications/initialized`). */
  static async start(
    spec: PluginProcessSpec,
    options: PluginStdioClientOptions = {},
  ): Promise<PluginStdioClient> {
    const child = spawn(spec.command, [...(spec.args ?? [])], {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: { ...(spec.env ?? { PATH: process.env.PATH ?? '' }) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const client = new PluginStdioClient(child, options.timeoutMs ?? 10_000);
    try {
      const result = (await client.request('initialize', {
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'otheater-plugin-conformance', version: '0.0.0' },
      })) as { serverInfo?: { name?: string; version?: string } };
      client.serverInfo = result.serverInfo;
      client.notify('notifications/initialized');
    } catch (error) {
      await client.close();
      throw error;
    }
    return client;
  }

  /** What the server said about itself in `initialize`. */
  serverInfo: { name?: string; version?: string } | undefined;

  /** Sends a request and resolves with its `result`; a JSON-RPC error or a timeout rejects. */
  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (this.#spawnError !== undefined) {
        reject(this.#spawnError);
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(`${method} got no answer in ${String(this.#timeoutMs)} ms${this.#tail()}`),
        );
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.#write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  async listTools(): Promise<PluginToolDescription[]> {
    const tools: PluginToolDescription[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.request('tools/list', cursor === undefined ? {} : { cursor })) as {
        tools: PluginToolDescription[];
        nextCursor?: string;
      };
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<PluginToolResult> {
    return (await this.request('tools/call', { name, arguments: args })) as PluginToolResult;
  }

  /** The text of the first text block of a result. */
  static textOf(result: PluginToolResult): string {
    return result.content.find((block) => block.type === 'text')?.text ?? '';
  }

  /** The notifications of `method` received after the first `from` ones. */
  notificationsOf(method: string, from = 0): PluginNotification[] {
    return this.notifications.slice(from).filter((entry) => entry.method === method);
  }

  /**
   * Closes stdin, as the daemon does to stop a plugin, and waits for the process to end. If it
   * does not end in time, it is killed (its own pid only) and the result says so.
   */
  async close(): Promise<{ readonly exitCode: number | null; readonly graceful: boolean }> {
    this.#child.stdin?.end();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, this.#timeoutMs);
    });
    const outcome = await Promise.race([this.#exited, timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.#child.kill('SIGKILL');
      return { exitCode: await this.#exited, graceful: false };
    }
    return { exitCode: outcome, graceful: true };
  }

  #write(message: Record<string, unknown>): void {
    this.#child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  #line(line: string): void {
    if (line.trim() === '') return;
    let message: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.strayOutput.push(line);
      return;
    }
    if (typeof message !== 'object' || (message as unknown) === null) {
      this.strayOutput.push(line);
      return;
    }
    if (typeof message.id === 'number' && message.method === undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(
          new Error(`${message.error.message ?? 'error'} (code ${String(message.error.code)})`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string' && message.id === undefined) {
      this.notifications.push({ method: message.method, params: message.params });
    }
  }

  #failAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  #tail(): string {
    const tail = this.stderr.trim().split('\n').slice(-5).join('\n');
    return tail === '' ? '' : `; stderr:\n${tail}`;
  }
}
