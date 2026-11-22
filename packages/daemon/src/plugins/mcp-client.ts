// SPDX-License-Identifier: MPL-2.0
import { isAbsolute, relative, resolve } from 'node:path';
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Transport,
} from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { PluginManifest } from '@otheater/core';
import type { Logger } from '../logger.js';

/** The `server` block of a plugin manifest: how the daemon reaches its MCP server (N232). */
export type PluginServerSpec = PluginManifest['server'];

/** One tool as the server of the plugin exposes it in `tools/list`. */
export interface PluginServerTool {
  readonly name: string;
  readonly description?: string | undefined;
  /** The JSON Schema of the arguments, as the server gave it; the server is who validates them. */
  readonly inputSchema: Record<string, unknown>;
}

/** What it takes to reach the server of one plugin in one project. */
export interface PluginConnectSpec {
  readonly server: PluginServerSpec;
  /** The folder the plugin was installed in: where `stdio` runs, unless `cwd` says otherwise. */
  readonly dir: string;
  /**
   * The whole environment of the process, and nothing else: the SDK would add the `HOME`, `PATH`,
   * `SHELL`, `USER`... of the daemon, so the connector masks the ones this record does not set.
   * Unused by `http`, where the process is not the daemon's to start.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Wait for the process to answer `initialize` and `tools/list` at most this long, in ms. */
  readonly startTimeoutMs: number;
  /** `plugins.http`: `off` refuses a server of type `http`. */
  readonly http: 'loopback' | 'off';
  readonly logger: Logger;
}

/** The connection to one server, however it was reached. */
export interface PluginConnection {
  /** The pid of the process, for `stdio`; `undefined` for `http`. */
  readonly pid: number | undefined;
  /** The tools the server exposes (all pages). */
  listTools(): Promise<readonly PluginServerTool[]>;
  /** One call. The result goes back as the server gave it. Rejects on a transport error. */
  callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    options: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ): Promise<CallToolResult>;
  /** Ends the connection and the process. Idempotent; never rejects. */
  close(): Promise<void>;
  /**
   * Hands over what runs when the connection ends without `close()` having been called (the
   * process died, the pipe closed). Runs at most once.
   */
  onUnexpectedClose(listener: (reason: string) => void): void;
}

/** Opens the connection to a plugin server. The pool depends on this, so tests hand in a double. */
export type PluginConnector = (spec: PluginConnectSpec) => Promise<PluginConnection>;

/** A start that cannot work however many times it is tried (the pool stays stopped at once). */
export class PluginStartRefused extends Error {
  override readonly name = 'PluginStartRefused';
}

/** The names the SDK adds to the environment of a stdio server, which the plugin must not get. */
const SDK_INHERITED_KEYS: readonly string[] = Object.keys(getDefaultEnvironment());

/** `127.0.0.1`, `localhost` and `[::1]`: where an `http` server of a plugin may live (v1). */
function isLoopbackUrl(url: URL): boolean {
  if (url.hostname === 'localhost' || url.hostname === '[::1]') return true;
  return /^127(\.\d{1,3}){3}$/.test(url.hostname);
}

function transportFor(spec: PluginConnectSpec): {
  transport: Transport;
  pid: () => number | undefined;
} {
  const { server } = spec;
  if (server.type === 'http') {
    if (spec.http === 'off') {
      throw new PluginStartRefused('the plugin has an http server and plugins.http is "off"');
    }
    const url = new URL(server.url);
    if (!isLoopbackUrl(url)) {
      throw new PluginStartRefused(
        `the http server must be in the loopback, not "${url.hostname}"`,
      );
    }
    return { transport: new StreamableHTTPClientTransport(url), pid: () => undefined };
  }
  const cwd = resolve(spec.dir, server.cwd ?? '.');
  const inside = relative(resolve(spec.dir), cwd);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new PluginStartRefused('the cwd of the server is outside the folder of the plugin');
  }
  const [command, ...rest] = server.command;
  if (command === undefined) throw new PluginStartRefused('the server command is empty');
  // `env` merges over the default environment of the SDK: an `undefined` hides the key. The type
  // of the SDK says string, but `spawn` leaves out a key whose value is `undefined`.
  const env: Record<string, string> = { ...spec.env };
  for (const key of SDK_INHERITED_KEYS) {
    if (!(key in env)) (env as Record<string, string | undefined>)[key] = undefined;
  }
  const stdio = new StdioClientTransport({
    command,
    args: [...rest, ...(server.args ?? [])],
    env,
    cwd,
    stderr: 'pipe',
  });
  return { transport: stdio, pid: () => stdio.pid ?? undefined };
}

/** Writes what the process says on stderr in the log, a line at a time, cut short. */
function relayStderr(transport: Transport, logger: Logger): void {
  const stderr = transport instanceof StdioClientTransport ? transport.stderr : null;
  if (stderr === null) return;
  let pending = '';
  stderr.on('data', (chunk: Buffer | string) => {
    pending += chunk.toString();
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() !== '') logger.debug({ line: line.slice(0, 500) }, 'plugin stderr');
    }
    if (pending.length > 4096) pending = pending.slice(-4096);
  });
}

/** Connects with the MCP client of the SDK (N232 (a)): `stdio`, or `http` in the loopback. */
export const connectPluginServer: PluginConnector = async (spec) => {
  const { transport, pid } = transportFor(spec);
  relayStderr(transport, spec.logger);
  const client = new Client({ name: 'otheater', version: '0.0.0' });
  let closing = false;
  let listener: ((reason: string) => void) | undefined;
  let ended = false;
  const reasonOf: { value: string } = { value: 'the connection closed' };
  const fire = (): void => {
    if (closing || ended) return;
    ended = true;
    listener?.(reasonOf.value);
  };
  client.onerror = (error) => {
    reasonOf.value = error.message;
  };
  client.onclose = fire;

  const abort = new AbortController();
  const startTimer = setTimeout(() => {
    abort.abort();
  }, spec.startTimeoutMs);
  startTimer.unref();
  const close = async (): Promise<void> => {
    closing = true;
    await client.close().catch(() => undefined);
  };
  try {
    await client.connect(transport, { signal: abort.signal, timeout: spec.startTimeoutMs });
  } catch (error) {
    await close();
    throw abort.signal.aborted
      ? new Error(`the server did not start in ${String(spec.startTimeoutMs)} ms`)
      : error;
  } finally {
    clearTimeout(startTimer);
  }
  return {
    get pid() {
      return pid();
    },
    async listTools() {
      const result = await client.listTools(undefined, { timeout: spec.startTimeoutMs });
      return result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },
    callTool: (name, args, options) =>
      client.callTool(
        { name, ...(args === undefined ? {} : { arguments: args }) },
        {
          signal: options.signal,
          timeout: options.timeoutMs,
        },
      ),
    close,
    onUnexpectedClose(next) {
      listener = next;
      // A process that died before the listener was given is reported at once.
      if (ended) next(reasonOf.value);
    },
  };
};
