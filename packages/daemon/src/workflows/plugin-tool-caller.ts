// SPDX-License-Identifier: MPL-2.0
import type { JsonValue } from '@otheater/core';
import type { ActivePlugin, PluginAggregator } from '../plugins/aggregate.js';
import { toJsonValue } from './steps/support.js';
import type { ToolCaller, ToolCallResult, ToolRef } from './steps/call-tool.js';

/** The text of a result of a tool: its text blocks, joined. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block: unknown) =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? [(block as { text: string }).text]
        : [],
    )
    .join('\n');
}

/**
 * What a `CallToolResult` of the aggregator gives the engine: the structured content when there is
 * one, else the text of the answer. An error (`isError`) carries its code (`structuredContent.error`:
 * `plugin_unavailable`, `plugin_timeout`, `plugin_failed`, `tool_unavailable`, or whatever the tool
 * itself called it). [proposta]
 */
export function toolResultOf(raw: {
  isError?: boolean | undefined;
  structuredContent?: unknown;
  content?: unknown;
}): ToolCallResult {
  const structured: JsonValue | undefined =
    raw.structuredContent === undefined ? undefined : toJsonValue(raw.structuredContent);
  const result: JsonValue = structured ?? textOf(raw.content);
  if (raw.isError !== true) return { ok: true, result };
  const code =
    typeof structured === 'object' &&
    structured !== null &&
    !Array.isArray(structured) &&
    typeof structured.error === 'string'
      ? structured.error
      : 'tool_error';
  return { ok: false, result, code };
}

/**
 * The adapter of `call_tool` over the plugin aggregator (N292: the call goes to the process of the
 * plugin, by MCP, with the deadline of the plugins). [proposta] The name in the node is the public
 * name of the aggregator, `<plugin>__<tool>`, looked up in the snapshot of the project of the run.
 */
export function createPluginToolCaller(aggregator: PluginAggregator): ToolCaller {
  const owners = new WeakMap<ToolRef, ActivePlugin>();
  return {
    find(project, name) {
      const found = aggregator.snapshot(project).names.get(name);
      if (found === undefined) return undefined;
      const ref: ToolRef = {
        plugin: found.plugin.id,
        tool: found.tool.name,
        effects: found.tool.effects,
      };
      owners.set(ref, found.plugin);
      return ref;
    },
    async call(project, ref, args, signal) {
      const plugin = owners.get(ref);
      if (plugin === undefined) {
        return {
          ok: false,
          result: { error: 'tool_unavailable', message: 'The tool was not found by this caller' },
          code: 'tool_unavailable',
        };
      }
      const raw = await aggregator.callTool(plugin, project, ref.tool, args, signal);
      return toolResultOf(raw);
    },
  };
}
