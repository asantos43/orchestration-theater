// SPDX-License-Identifier: MPL-2.0
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { PluginManifest, PluginToolManifest } from '@otheater/core';
import type { Logger } from '../logger.js';
import type { PluginServerTool } from './mcp-client.js';
import { PluginCallError, type PluginProcessPool } from './process-pool.js';
import type { PluginNoticeSink } from './runtime-config.js';

/** A plugin active in a project, as the registry of the plugins (P4) hands it over. */
export interface ActivePlugin {
  readonly id: string;
  readonly version: string;
  readonly manifest: PluginManifest;
  /** The folder the plugin was installed in. */
  readonly dir: string;
  /** Changes when the manifest does. */
  readonly manifestHash: string;
}

/** Where the aggregator learns which plugins are active in which project (the registry of P4). */
export interface ActivePluginSource {
  activeFor(project: string): readonly ActivePlugin[];
  /** Calls `listener` when the active plugins of any project change; returns how to stop it. */
  onChange?(listener: () => void): () => void;
}

/** What separates the id of the plugin from the name of its tool: `<id>__<tool>` (N234, [proposta]). */
export const PLUGIN_TOOL_SEPARATOR = '__';

/**
 * The longest name a tool may have in the `otheater` server. [proposta] 64 is what the clients of
 * the three Executors accept (`^[a-zA-Z0-9_-]{1,64}$`); a longer `<id>__<tool>` leaves the tool out
 * with a notice instead of being cut, which could make two names the same.
 */
export const PLUGIN_TOOL_NAME_MAX = 64;

/** One tool of a plugin, as the `otheater` server lists it for a role. */
export interface PluginToolBinding {
  /** The name in the server: `<id>__<tool>`. */
  readonly name: string;
  readonly plugin: ActivePlugin;
  readonly project: string;
  readonly tool: PluginToolManifest;
  readonly description: string;
  /** The JSON Schema the server of the plugin gave; the server is who validates the arguments. */
  readonly inputSchema: Record<string, unknown>;
}

interface Reconciled {
  readonly generation: number;
  /** What the manifest declares and the server exposes, by name of the tool. */
  readonly available: ReadonlyMap<string, PluginServerTool>;
}

export interface PluginAggregatorOptions {
  readonly source: ActivePluginSource;
  readonly pool: PluginProcessPool;
  readonly logger: Logger;
  /** Names of the tools of the framework, which a plugin tool must not take. */
  readonly reservedNames: () => Iterable<string>;
  /** Where the notices go besides the log (P8). */
  readonly onNotice?: PluginNoticeSink;
}

/**
 * The plugins the session of a grant sees: the active ones of its project at the first request,
 * and the name of each of their tools. A session in course keeps this snapshot, even when a plugin
 * is activated or removed after it (N235), except that a plugin that could not be reached is tried
 * again on a later request.
 */
export class PluginSnapshot {
  /** The public name of every declared tool of the snapshot, in a fixed order, to its owner. */
  readonly names: ReadonlyMap<string, { plugin: ActivePlugin; tool: PluginToolManifest }>;
  readonly #resolved = new Map<string, Reconciled>();

  constructor(
    readonly project: string,
    readonly plugins: readonly ActivePlugin[],
    names: ReadonlyMap<string, { plugin: ActivePlugin; tool: PluginToolManifest }>,
  ) {
    this.names = names;
  }

  resolved(id: string): Reconciled | undefined {
    return this.#resolved.get(id);
  }

  setResolved(id: string, value: Reconciled): void {
    this.#resolved.set(id, value);
  }
}

/** Whether the role of the session is one of the roles the manifest gives the tool. */
function sees(tool: PluginToolManifest, role: string): boolean {
  return (tool.roles as readonly string[]).includes(role);
}

/** The result a call gives when it did not reach one of the server: a tool error, by name. */
function failure(error: string, message: string, extra: object = {}): CallToolResult {
  const body = { error, message, ...extra };
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  };
}

/**
 * Puts the tools of the active plugins in the `otheater` server (N234 (a), no 1MCP), under the
 * name `<id>__<tool>`, filtered by role as the framework tools are. The call goes to the process of
 * the plugin (`PluginProcessPool`), with the deadline `plugins.call_timeout`, and the result comes
 * back as the server gave it.
 *
 * - The list the server exposes is checked against the manifest. A tool the server exposes and the
 *   manifest does not declare stays out, with a notice; one the manifest declares and the server
 *   does not expose is unavailable (listed nowhere, and a call answers `tool_unavailable`).
 * - Listing starts the process of a plugin only the first time (to know the schemas); after it
 *   stops idle, the listing comes from what it last exposed and never waits for a start. A plugin
 *   that never ran, and is waiting to be started again or was given up on, is left out of the
 *   listing; one that ran keeps its tools listed, and a call to it answers `plugin_unavailable`.
 * - [proposta] A tool with `roles: []` is for the panel only (P11) and no Executor sees it.
 * - The permissions of layers 1 and 2 generated from the manifest are P6; here the filter is the
 *   role, and the allow-list of the policy (`RolePolicy.mcpTools`), as for the framework tools.
 */
export class PluginAggregator {
  readonly #options: PluginAggregatorOptions;
  readonly #reconciled = new Map<string, Reconciled>();
  readonly #warned = new Set<string>();
  readonly #unsubscribe: (() => void) | undefined;

  constructor(options: PluginAggregatorOptions) {
    this.#options = options;
    this.#unsubscribe = options.source.onChange?.(() => {
      void this.#sync();
    });
  }

  /** Takes the snapshot of a project: its active plugins now, and the names of their tools. */
  snapshot(project: string): PluginSnapshot {
    const plugins = [...this.#options.source.activeFor(project)].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const taken = new Set(this.#options.reservedNames());
    const names = new Map<string, { plugin: ActivePlugin; tool: PluginToolManifest }>();
    for (const plugin of plugins) {
      for (const tool of plugin.manifest.tools) {
        const name = `${plugin.id}${PLUGIN_TOOL_SEPARATOR}${tool.name}`;
        const reason =
          name.length > PLUGIN_TOOL_NAME_MAX ? 'too_long' : taken.has(name) ? 'taken' : undefined;
        if (reason !== undefined) {
          this.#warnOnce(`${project}\u0000${name}\u0000${reason}`, () => {
            this.#options.logger.warn(
              { plugin: plugin.id, project, tool: tool.name, reason },
              'plugin tool left out: its name in the server is not usable',
            );
            this.#notify({
              kind: 'tool_name_rejected',
              plugin: plugin.id,
              project,
              tool: tool.name,
              reason,
            });
          });
          continue;
        }
        taken.add(name);
        names.set(name, { plugin, tool });
      }
    }
    return new PluginSnapshot(project, plugins, names);
  }

  /**
   * The tools of the snapshot the role sees (and the allow-list of its policy, when there is
   * one), with the schema the server gave. Starts the process of a plugin the first time.
   */
  async tools(
    snapshot: PluginSnapshot,
    role: string,
    allow?: readonly string[],
  ): Promise<readonly PluginToolBinding[]> {
    const wanted = new Map<string, ActivePlugin>();
    for (const { plugin, tool } of snapshot.names.values()) {
      if (sees(tool, role)) wanted.set(plugin.id, plugin);
    }
    const resolved = await Promise.all(
      [...wanted.values()].map(async (plugin) => ({
        plugin,
        state: await this.#resolve(snapshot, plugin),
      })),
    );
    const available = new Map(resolved.map(({ plugin, state }) => [plugin.id, state]));
    const bindings: PluginToolBinding[] = [];
    for (const [name, { plugin, tool }] of snapshot.names) {
      if (!sees(tool, role)) continue;
      if (allow !== undefined && !allow.includes(name)) continue;
      const exposed = available.get(plugin.id)?.available.get(tool.name);
      if (exposed === undefined) continue;
      bindings.push({
        name,
        plugin,
        project: snapshot.project,
        tool,
        description:
          tool.description ??
          exposed.description ??
          `Tool ${tool.name} of the plugin ${plugin.id}.`,
        inputSchema: exposed.inputSchema,
      });
    }
    return bindings;
  }

  /**
   * One call to a tool of a plugin. The result of the server goes back as it came; a call that did
   * not reach one is a tool error (`isError`) with a code: `plugin_unavailable`, `plugin_timeout`,
   * `plugin_failed` or `tool_unavailable`. Never rejects.
   */
  async call(
    binding: PluginToolBinding,
    args: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    return await this.callTool(binding.plugin, binding.project, binding.tool.name, args, signal);
  }

  /**
   * The same call, by the name of a tool the manifest declares, with no role: the panel of a
   * project (P10) reads its blocks and runs its actions this way, for the Producer. It is the same
   * door as {@link call}, so the answers are the same; who may call, and whether the Producer is
   * asked, is the caller's to decide (`PluginPanelService`).
   */
  async callTool(
    plugin: ActivePlugin,
    project: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    try {
      const started = await this.#options.pool.ensure(plugin, project);
      const reconciled = this.#reconcile(plugin, project, started);
      if (!reconciled.available.has(toolName)) {
        return failure(
          'tool_unavailable',
          `The server of the plugin ${plugin.id} does not expose the tool ${toolName}.`,
        );
      }
      return await this.#options.pool.call(plugin, project, toolName, args, signal);
    } catch (error) {
      if (!(error instanceof PluginCallError)) throw error;
      this.#options.logger.warn(
        { plugin: plugin.id, project, tool: toolName, code: error.code },
        'plugin tool call did not reach a result',
      );
      return failure(`plugin_${error.code}`, error.message, {
        ...(error.retryInMs === undefined || error.retryInMs === 0
          ? {}
          : { retry_in_ms: error.retryInMs }),
      });
    }
  }

  /** Stops listening to the source and stops every process. */
  async stop(): Promise<void> {
    this.#unsubscribe?.();
    await this.#options.pool.stop();
  }

  // ---- internals ----

  async #resolve(snapshot: PluginSnapshot, plugin: ActivePlugin): Promise<Reconciled | undefined> {
    const known = snapshot.resolved(plugin.id);
    if (known !== undefined) return known;
    const { pool } = this.#options;
    try {
      const started =
        pool.known(plugin, snapshot.project) ?? (await pool.ensure(plugin, snapshot.project));
      const value = this.#reconcile(plugin, snapshot.project, started);
      snapshot.setResolved(plugin.id, value);
      return value;
    } catch (error) {
      if (!(error instanceof PluginCallError)) throw error;
      return undefined;
    }
  }

  /** Checks what the server exposes against the manifest; says so once per run of the process. */
  #reconcile(
    plugin: ActivePlugin,
    project: string,
    started: { readonly generation: number; readonly tools: readonly PluginServerTool[] },
  ): Reconciled {
    const key = `${project}\u0000${plugin.id}\u0000${plugin.manifestHash}`;
    const before = this.#reconciled.get(key);
    if (before?.generation === started.generation) return before;
    const declared = new Set(plugin.manifest.tools.map((tool) => tool.name));
    const available = new Map<string, PluginServerTool>();
    for (const tool of started.tools) {
      if (declared.has(tool.name)) {
        available.set(tool.name, tool);
        continue;
      }
      this.#options.logger.warn(
        { plugin: plugin.id, project, tool: tool.name },
        'plugin server exposes a tool its manifest does not declare: left out',
      );
      this.#notify({ kind: 'tool_not_declared', plugin: plugin.id, project, tool: tool.name });
    }
    for (const name of declared) {
      if (available.has(name)) continue;
      this.#options.logger.warn(
        { plugin: plugin.id, project, tool: name },
        'plugin manifest declares a tool its server does not expose: unavailable',
      );
      this.#notify({ kind: 'tool_not_exposed', plugin: plugin.id, project, tool: name });
    }
    const value: Reconciled = { generation: started.generation, available };
    this.#reconciled.set(key, value);
    return value;
  }

  /** The active plugins changed: stop the processes of what is no longer active, or changed. */
  async #sync(): Promise<void> {
    const { pool, source, logger } = this.#options;
    for (const project of pool.projects()) {
      try {
        await pool.retain(project, source.activeFor(project));
      } catch (error) {
        logger.warn({ err: error, project }, 'plugin processes could not be synced');
      }
    }
  }

  #warnOnce(key: string, run: () => void): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    run();
  }

  #notify(notice: Parameters<PluginNoticeSink>[0]): void {
    try {
      this.#options.onNotice?.(notice);
    } catch (error) {
      this.#options.logger.warn({ err: error, kind: notice.kind }, 'plugin notice sink failed');
    }
  }
}
