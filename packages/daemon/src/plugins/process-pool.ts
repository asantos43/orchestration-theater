// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '@otheater/core';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { Logger } from '../logger.js';
import {
  connectPluginServer,
  PluginStartRefused,
  type PluginConnection,
  type PluginConnector,
  type PluginServerSpec,
  type PluginServerTool,
} from './mcp-client.js';
import type { PluginNotice, PluginNoticeSink, PluginRuntimeConfig } from './runtime-config.js';

/** What the pool needs to know of an active plugin: `ActivePlugin` has all of it. */
export interface PluginProcessSpec {
  readonly id: string;
  readonly manifest: {
    readonly server: PluginServerSpec;
    /** The names of the secrets the manifest declares (P7 reads them from the vault). */
    readonly secrets?: readonly string[];
  };
  /** The folder the plugin was installed in. */
  readonly dir: string;
  /** Changes when the manifest does: a process of an older manifest is not reused. */
  readonly manifestHash: string;
}

/** Why a call to a plugin did not give a result of the server. */
export type PluginCallErrorCode = 'unavailable' | 'timeout' | 'failed' | 'cancelled';

/** A call that did not reach a result: the server is down, too slow or the connection broke. */
export class PluginCallError extends Error {
  override readonly name = 'PluginCallError';
  constructor(
    readonly code: PluginCallErrorCode,
    message: string,
    /** Set when the plugin is waiting to be started again: how long is left, in ms. */
    readonly retryInMs?: number,
  ) {
    super(message);
  }
}

/** The tools of one run of the process of a plugin. */
export interface PluginStarted {
  /** Counts the starts of this plugin in this project: two lists with the same value are one run. */
  readonly generation: number;
  readonly tools: readonly PluginServerTool[];
}

export interface PluginProcessStatus {
  readonly phase: 'stopped' | 'starting' | 'running' | 'given_up';
  /** Failures in a row; a result of the server (even a tool error) sets it back to zero. */
  readonly failures: number;
  /** Clock time (ms) before which a start is not tried again; `0` when there is no wait. */
  readonly retryAt: number;
  readonly pid: number | undefined;
  readonly generation: number;
}

export interface PluginPoolOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Read at each use, so a change of `plugins.*` applies without restarting the daemon. */
  readonly runtime: () => PluginRuntimeConfig;
  /**
   * The folder the processes get their `HOME` from: `<homeRoot>/<id>/<project>`, made on demand.
   * It is the plugin's own place to write; it is never the home of the daemon's user.
   */
  readonly homeRoot: string;
  /**
   * Extra variables of the process. The point P7 binds to hand the secrets of the plugin (read
   * from the vault) to its server and to nothing else. Default: none. The base variables win over
   * these, so a plugin cannot be given another `PATH` or `HOME` this way.
   */
  readonly extraEnv?: (
    plugin: PluginProcessSpec,
    project: string,
  ) => Promise<Readonly<Record<string, string>>>;
  /** Where the notices go besides the log (P8). */
  readonly onNotice?: PluginNoticeSink;
  /** Opens the connection; tests hand in a double. Default: the MCP client of the SDK. */
  readonly connector?: PluginConnector;
}

interface Entry {
  readonly project: string;
  readonly id: string;
  hash: string;
  connection: PluginConnection | undefined;
  starting: Promise<PluginStarted> | undefined;
  /** What the server exposed the last time it ran; kept across stops, dropped with the manifest. */
  tools: readonly PluginServerTool[] | undefined;
  generation: number;
  failures: number;
  retryAt: number;
  givenUp: boolean;
  inflight: number;
  idle: AbortController | undefined;
}

/** The environment a plugin process gets from the daemon: nothing but these. */
const INHERITED_ENV: readonly string[] = ['PATH', 'LANG', 'TZ'];

/** A name that is safe as a folder name; a name that had to change gets a short digest. */
function folderName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '_');
  if (safe === name && safe !== '') return safe;
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `${safe}-${digest}`;
}

/**
 * The environment of the process of a plugin (architecture 5.14): `PATH`, `LANG` and `TZ` of the
 * daemon, a `HOME` of the plugin's own, and nothing else. [proposta] The environment of the daemon
 * is never inherited: it may hold tokens, keys and the paths of the user. The secrets of the plugin
 * come in `extra` (P7), and never override these.
 */
export function pluginEnvironment(
  home: string,
  extra: Readonly<Record<string, string>> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = { ...extra };
  for (const key of INHERITED_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.HOME = home;
  return env;
}

/**
 * The processes of the plugins (N238 (a)): one per plugin and project, started on first use and
 * stopped when idle (`plugins.idle_timeout`).
 *
 * - A process that dies, or a start that fails, is a failure. The next use after a wait that grows
 *   (`plugins.restart_backoff`: doubles from `initial` up to `max`) starts it again; a use during
 *   the wait is refused at once with `unavailable`, and never blocks. After `plugins.max_restarts`
 *   failures in a row it stays stopped (`given_up`) until `reset`. A result of the server, even a
 *   tool error, sets the count to zero. [proposta] `max_restarts: 0` gives up at the first failure.
 * - A call that outlives `plugins.call_timeout` ends with `timeout`, the request is cancelled in
 *   the server, and the process keeps running: a slow call is not a failure of the process.
 * - Everything time-related goes through the `Clock`, so the tests drive it.
 * - The pool never reads or logs arguments and results of a call.
 */
export class PluginProcessPool {
  readonly #options: PluginPoolOptions;
  readonly #connector: PluginConnector;
  readonly #entries = new Map<string, Entry>();
  #stopped = false;

  constructor(options: PluginPoolOptions) {
    this.#options = options;
    this.#connector = options.connector ?? connectPluginServer;
  }

  /** The processes running now. */
  get running(): number {
    let count = 0;
    for (const entry of this.#entries.values()) if (entry.connection !== undefined) count += 1;
    return count;
  }

  /** The projects the pool has seen a plugin of (the aggregator re-checks them on a change). */
  projects(): readonly string[] {
    return [...new Set([...this.#entries.values()].map((entry) => entry.project))];
  }

  status(project: string, id: string): PluginProcessStatus {
    const entry = this.#entries.get(keyOf(project, id));
    if (entry === undefined) {
      return { phase: 'stopped', failures: 0, retryAt: 0, pid: undefined, generation: 0 };
    }
    return {
      phase: entry.givenUp
        ? 'given_up'
        : entry.connection !== undefined
          ? 'running'
          : entry.starting !== undefined
            ? 'starting'
            : 'stopped',
      failures: entry.failures,
      retryAt: entry.retryAt,
      pid: entry.connection?.pid,
      generation: entry.generation,
    };
  }

  /**
   * What the server of this plugin exposed the last time it ran, without starting it; `undefined`
   * when it never ran for this manifest. The listing of tools uses it to not start a process.
   */
  known(plugin: PluginProcessSpec, project: string): PluginStarted | undefined {
    const entry = this.#entries.get(keyOf(project, plugin.id));
    if (entry?.tools === undefined || entry.hash !== plugin.manifestHash) return undefined;
    return { generation: entry.generation, tools: entry.tools };
  }

  /**
   * Makes sure the process runs (starting it on the first use) and gives what it exposes.
   * Rejects with {@link PluginCallError} `unavailable` when it is waiting to be started again, was
   * given up on, or does not start.
   */
  async ensure(plugin: PluginProcessSpec, project: string): Promise<PluginStarted> {
    const { started } = await this.#open(plugin, project, false);
    return started;
  }

  /**
   * One call to a tool of the server. Starts the process on the first use. The result is the one
   * the server gave. Rejects with {@link PluginCallError}: `unavailable`, `timeout`, `failed` (the
   * connection broke) or `cancelled` (the `signal` aborted).
   */
  async call(
    plugin: PluginProcessSpec,
    project: string,
    tool: string,
    args: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const { entry, started } = await this.#open(plugin, project, true);
    const connection = entry.connection;
    const timeoutMs = this.#options.runtime().callTimeoutMs;
    const abort = new AbortController();
    const onOuter = (): void => {
      abort.abort();
    };
    signal?.addEventListener('abort', onOuter, { once: true });
    if (signal?.aborted === true) abort.abort();
    const state = { timedOut: false };
    const timer = this.#options.clock.sleep(timeoutMs, abort.signal).then(
      () => {
        state.timedOut = true;
        abort.abort();
      },
      () => undefined,
    );
    try {
      if (connection === undefined || started.generation !== entry.generation) {
        throw new PluginCallError('failed', 'The server of the plugin stopped before the call.');
      }
      const result = await connection.callTool(tool, args, {
        signal: abort.signal,
        timeoutMs: timeoutMs + 5_000,
      });
      if (entry.connection === connection) entry.failures = 0;
      return result;
    } catch (error) {
      if (error instanceof PluginCallError) throw error;
      if (state.timedOut) {
        throw new PluginCallError(
          'timeout',
          `The tool did not answer in ${String(timeoutMs)} ms (plugins.call_timeout).`,
        );
      }
      if (signal?.aborted === true)
        throw new PluginCallError('cancelled', 'The call was cancelled.');
      throw new PluginCallError(
        'failed',
        `The call to the server of the plugin failed: ${reasonOf(error)}`,
      );
    } finally {
      signal?.removeEventListener('abort', onOuter);
      abort.abort();
      await timer;
      entry.inflight -= 1;
      this.#armIdle(entry);
    }
  }

  /**
   * Clears the failures and the wait of a plugin that was given up on, so the next use starts it.
   * The activation of the plugin in the project (P4) is what calls it.
   */
  reset(project: string, id: string): void {
    const entry = this.#entries.get(keyOf(project, id));
    if (entry === undefined) return;
    entry.failures = 0;
    entry.retryAt = 0;
    entry.givenUp = false;
  }

  /**
   * Keeps the processes of `project` the list says are active, with the manifest they started
   * with, and stops the others. Called when the active plugins change.
   */
  async retain(
    project: string,
    active: readonly { readonly id: string; readonly manifestHash: string }[],
  ): Promise<void> {
    const stops: Promise<void>[] = [];
    for (const [key, entry] of this.#entries) {
      if (entry.project !== project) continue;
      const current = active.find((plugin) => plugin.id === entry.id);
      if (current?.manifestHash === entry.hash) continue;
      this.#entries.delete(key);
      stops.push(this.#close(entry, current === undefined ? 'inactive' : 'replaced'));
    }
    await Promise.all(stops);
  }

  /** Stops every process and refuses new starts. Idempotent. */
  async stop(): Promise<void> {
    this.#stopped = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map((entry) => this.#close(entry, 'shutdown')));
  }

  // ---- internals ----

  async #open(
    plugin: PluginProcessSpec,
    project: string,
    hold: boolean,
  ): Promise<{ entry: Entry; started: PluginStarted }> {
    if (this.#stopped) throw new PluginCallError('unavailable', 'The daemon is stopping.');
    const key = keyOf(project, plugin.id);
    let entry = this.#entries.get(key);
    if (entry !== undefined && entry.hash !== plugin.manifestHash) {
      this.#entries.delete(key);
      await this.#close(entry, 'replaced');
      entry = undefined;
    }
    if (entry === undefined) {
      entry = {
        project,
        id: plugin.id,
        hash: plugin.manifestHash,
        connection: undefined,
        starting: undefined,
        tools: undefined,
        generation: 0,
        failures: 0,
        retryAt: 0,
        givenUp: false,
        inflight: 0,
        idle: undefined,
      };
      this.#entries.set(key, entry);
    }
    if (entry.connection === undefined) {
      if (entry.givenUp) {
        throw new PluginCallError(
          'unavailable',
          'The server of the plugin was given up on after repeated failures.',
        );
      }
      const wait = entry.retryAt - this.#options.clock.now();
      if (entry.starting === undefined && wait > 0) {
        throw new PluginCallError(
          'unavailable',
          `The server of the plugin failed and starts again in ${String(wait)} ms.`,
          wait,
        );
      }
      const target = entry;
      entry.starting ??= this.#start(target, plugin).finally(() => {
        target.starting = undefined;
      });
      const started = await entry.starting;
      return this.#held(entry, started, hold);
    }
    return this.#held(entry, { generation: entry.generation, tools: entry.tools ?? [] }, hold);
  }

  #held(
    entry: Entry,
    started: PluginStarted,
    hold: boolean,
  ): { entry: Entry; started: PluginStarted } {
    if (hold) {
      entry.inflight += 1;
      entry.idle?.abort();
    } else {
      this.#armIdle(entry);
    }
    return { entry, started };
  }

  async #start(entry: Entry, plugin: PluginProcessSpec): Promise<PluginStarted> {
    const { logger } = this.#options;
    const runtime = this.#options.runtime();
    let connection: PluginConnection | undefined;
    try {
      const home = join(this.#options.homeRoot, folderName(plugin.id), folderName(entry.project));
      await mkdir(home, { recursive: true });
      const extra = (await this.#options.extraEnv?.(plugin, entry.project)) ?? {};
      connection = await this.#connector({
        server: plugin.manifest.server,
        dir: plugin.dir,
        env: pluginEnvironment(home, extra),
        // What `extraEnv` gave is secret by definition: the log of the server must not repeat it.
        secretValues: Object.values(extra),
        startTimeoutMs: runtime.startTimeoutMs,
        http: runtime.http,
        logger: logger.child({ plugin: plugin.id, project: entry.project }),
      });
      const tools = await connection.listTools();
      if (this.#stopped || this.#entries.get(keyOf(entry.project, entry.id)) !== entry) {
        await connection.close();
        throw new PluginCallError('unavailable', 'The plugin was deactivated while it started.');
      }
      entry.connection = connection;
      entry.tools = tools;
      entry.generation += 1;
      entry.retryAt = 0;
      const live = connection;
      connection.onUnexpectedClose((reason) => {
        this.#died(entry, live, reason);
      });
      logger.info(
        { plugin: entry.id, project: entry.project, pid: connection.pid, tools: tools.length },
        'plugin server started',
      );
      this.#notify({
        kind: 'process_started',
        plugin: entry.id,
        project: entry.project,
        pid: connection.pid,
      });
      return { generation: entry.generation, tools };
    } catch (error) {
      await connection?.close();
      if (error instanceof PluginCallError) throw error;
      const reason = reasonOf(error);
      const retryInMs = this.#fail(entry, reason, error instanceof PluginStartRefused);
      throw new PluginCallError(
        'unavailable',
        `The server of the plugin did not start: ${reason}`,
        retryInMs,
      );
    }
  }

  #died(entry: Entry, connection: PluginConnection, reason: string): void {
    if (entry.connection !== connection) return;
    entry.connection = undefined;
    entry.idle?.abort();
    this.#fail(entry, reason, false);
  }

  /** Counts a failure; gives up at the limit, or sets the wait before the next start. */
  #fail(entry: Entry, reason: string, fatal: boolean): number {
    const runtime = this.#options.runtime();
    entry.failures += 1;
    const base = { plugin: entry.id, project: entry.project, failures: entry.failures, reason };
    if (fatal || entry.failures >= Math.max(1, runtime.maxRestarts)) {
      entry.givenUp = true;
      this.#options.logger.error(
        { ...base },
        'plugin server given up on: it stays stopped until it is reset',
      );
      this.#notify({ kind: 'process_given_up', ...base });
      return 0;
    }
    const { initialMs, maxMs } = runtime.restartBackoff;
    const retryInMs = Math.min(maxMs, initialMs * 2 ** (entry.failures - 1));
    entry.retryAt = this.#options.clock.now() + retryInMs;
    this.#options.logger.warn({ ...base, retryInMs }, 'plugin server failed');
    this.#notify({ kind: 'process_failed', ...base, retryInMs });
    return retryInMs;
  }

  #armIdle(entry: Entry): void {
    entry.idle?.abort();
    const idleMs = this.#options.runtime().idleTimeoutMs;
    const connection = entry.connection;
    if (idleMs === null || connection === undefined || entry.inflight > 0) return;
    const abort = new AbortController();
    entry.idle = abort;
    void this.#options.clock.sleep(idleMs, abort.signal).then(
      () => {
        if (entry.connection !== connection || entry.inflight > 0) return;
        entry.connection = undefined;
        void this.#closeConnection(entry, connection, 'idle');
      },
      () => undefined,
    );
  }

  async #close(entry: Entry, reason: 'inactive' | 'replaced' | 'shutdown'): Promise<void> {
    entry.idle?.abort();
    const connection = entry.connection;
    entry.connection = undefined;
    if (connection !== undefined) await this.#closeConnection(entry, connection, reason);
  }

  async #closeConnection(
    entry: Entry,
    connection: PluginConnection,
    reason: 'idle' | 'inactive' | 'replaced' | 'shutdown',
  ): Promise<void> {
    await connection.close();
    this.#options.logger.info(
      { plugin: entry.id, project: entry.project, reason },
      'plugin server stopped',
    );
    this.#notify({ kind: 'process_stopped', plugin: entry.id, project: entry.project, reason });
  }

  #notify(notice: PluginNotice): void {
    try {
      this.#options.onNotice?.(notice);
    } catch (error) {
      this.#options.logger.warn({ err: error, kind: notice.kind }, 'plugin notice sink failed');
    }
  }
}

function keyOf(project: string, id: string): string {
  return `${project}\u0000${id}`;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
