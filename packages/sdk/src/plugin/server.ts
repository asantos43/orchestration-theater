// SPDX-License-Identifier: MPL-2.0
import { McpServer, type ToolAnnotations } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { PluginToolManifest } from '@otheater/core';
import { z } from 'zod';
import type { PluginDefinition, PluginTool, PluginToolContext } from './define.js';
import {
  createEventPublisher,
  PLUGIN_EVENT_METHOD,
  PLUGIN_EVENT_MAX_BYTES,
  type PluginEventPublisher,
} from './events.js';

export interface PluginServerOptions {
  /** The `version` the server reports in `initialize`; the version of the manifest by default. */
  readonly version?: string;
  /** Limit of an event payload in bytes (16 KB by default). */
  readonly eventMaxBytes?: number;
  /** Called with the errors of the transport. The default writes to stderr, never to stdout. */
  readonly onerror?: (error: Error) => void;
}

/** A running server of a plugin over stdio. */
export interface PluginServerHandle {
  /** Publishes an event of the manifest from outside a tool call (a timer, a file watcher). */
  readonly events: PluginEventPublisher;
  /** Closes the connection; the process then ends by itself if nothing else holds it. */
  close(): Promise<void>;
}

/**
 * What the manifest says about a tool, as the MCP annotations the server exposes [proposta]:
 * `readOnlyHint` for `read`, `destructiveHint` for `external_write` (the MCP default of a tool
 * that is not read-only is destructive, so it is always said), and `openWorldHint` for the tools
 * that reach outside the machine. The conformance suite checks them against the manifest.
 */
export function toolAnnotations(tool: PluginToolManifest): ToolAnnotations {
  return {
    readOnlyHint: tool.effects === 'read',
    destructiveHint: tool.effects === 'external_write',
    openWorldHint: tool.effects === 'network' || tool.effects === 'external_write',
  };
}

const NO_ARGUMENTS = z.object({});

function reply(value: unknown): { content: { type: 'text'; text: string }[] } {
  // `undefined` has no JSON text: it goes back as `null`, so the result always parses.
  const text = (JSON.stringify(value) as string | undefined) ?? 'null';
  return { content: [{ type: 'text', text }] };
}

function failure(error: unknown): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Builds the MCP server of a plugin, with its tools registered, for one connection. */
function buildServer(
  plugin: PluginDefinition,
  events: PluginEventPublisher,
  options: PluginServerOptions,
): McpServer {
  const { manifest } = plugin;
  const server = new McpServer({
    name: manifest.id,
    version: options.version ?? manifest.version,
  });
  for (const toolManifest of manifest.tools) {
    const tool: PluginTool | undefined = plugin.tools.get(toolManifest.name);
    if (tool === undefined) continue; // definePlugin already refused this
    const context: PluginToolContext = {
      tool: toolManifest.name,
      emit: (name, payload) => events.publish(name, payload),
    };
    server.registerTool(
      toolManifest.name,
      {
        description: toolManifest.description ?? tool.description ?? toolManifest.name,
        inputSchema: tool.input ?? NO_ARGUMENTS,
        annotations: toolAnnotations(toolManifest),
      },
      async (args: unknown) => {
        try {
          return reply(await tool.handler(args as Record<string, unknown>, context));
        } catch (error) {
          return failure(error);
        }
      },
    );
  }
  return server;
}

/**
 * Serves the plugin over stdio, the transport of the `stdio` server of the manifest. Standard
 * output belongs to the protocol: the plugin must never write to it, and logs go to stderr.
 *
 * When the daemon closes the pipe (stdin ends), the transport closes and the process ends.
 */
export function servePlugin(
  plugin: PluginDefinition,
  options: PluginServerOptions = {},
): PluginServerHandle {
  let connected: McpServer | undefined;
  const events = createEventPublisher({
    declared: plugin.manifest.events,
    maxBytes: options.eventMaxBytes ?? PLUGIN_EVENT_MAX_BYTES,
    send: async (params) => {
      if (connected === undefined) {
        throw new Error('the plugin server is not connected: no client to receive the event');
      }
      await connected.server.notification({ method: PLUGIN_EVENT_METHOD, params: { ...params } });
    },
  });
  const handle = serveStdio(
    () => {
      connected = buildServer(plugin, events, options);
      return connected;
    },
    {
      onerror:
        options.onerror ??
        ((error) => {
          process.stderr.write(`plugin ${plugin.manifest.id}: ${error.message}\n`);
        }),
    },
  );
  return {
    events,
    close: async () => {
      await handle.close();
      connected = undefined;
    },
  };
}
