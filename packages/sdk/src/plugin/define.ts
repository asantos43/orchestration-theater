// SPDX-License-Identifier: MPL-2.0
import {
  describeManifestProblems,
  parsePluginManifest,
  type PluginManifest,
  type PluginManifestInput,
  type PluginManifestOptions,
} from '@otheater/core';
import { z } from 'zod';
import { PluginManifestError } from './manifest-file.js';

/** What a tool handler gets besides the arguments. */
export interface PluginToolContext {
  /** The tool being called (its name in the manifest). */
  readonly tool: string;
  /**
   * Publishes the event `name` of the manifest, with a small JSON payload; the daemon makes it
   * `plugin.<id>.<name>`. It throws a `PluginEventError` for an undeclared name or a payload over
   * 16 KB, which the call reports to the caller as a tool error.
   */
  readonly emit: (name: string, payload?: Record<string, unknown>) => Promise<void>;
}

/** One tool of the plugin: the schema of its arguments and the code that runs. */
export interface PluginTool<Input extends z.ZodObject = z.ZodObject> {
  /** The arguments, as a zod object; a tool with no arguments leaves it out. */
  readonly input?: Input;
  /** What the model reads about the tool; the `description` of the manifest wins over it. */
  readonly description?: string;
  /**
   * Runs the tool. The value it returns (any JSON value) goes back as the text of the result; a
   * throw becomes a tool error with the message of the exception. A method, so that a plugin can
   * hold tools with different arguments in one map.
   */
  handler(args: z.output<Input>, context: PluginToolContext): unknown;
}

/** Writes a tool with the type of its arguments inferred from `input`. */
export function pluginTool<Input extends z.ZodObject>(tool: PluginTool<Input>): PluginTool<Input> {
  return tool;
}

export interface DefinePluginOptions {
  /** The manifest, read with `readPluginManifest` or written in code; it is validated again. */
  readonly manifest: PluginManifestInput;
  /** The code of each tool of the manifest, by name. */
  readonly tools: Readonly<Record<string, PluginTool>>;
  /** Options of the manifest validator (the names of the framework's tools, for the daemon). */
  readonly validation?: PluginManifestOptions;
}

/** A plugin: its validated manifest and the code that backs each tool of it. */
export interface PluginDefinition {
  readonly manifest: PluginManifest;
  readonly tools: ReadonlyMap<string, PluginTool>;
}

/** The code does not match the manifest: a tool without code, or code without a tool. */
export class PluginDefinitionError extends Error {
  override readonly name = 'PluginDefinitionError';
}

/**
 * Ties the manifest to the code of the tools. The manifest is checked by the validator of
 * `@otheater/core` (so a manifest the daemon would refuse on install fails here, in the author's
 * terminal), and then each tool of the manifest must have its code, and each code a tool of the
 * manifest: what the plugin does and what the Producer approved on activation cannot drift apart.
 */
export function definePlugin(options: DefinePluginOptions): PluginDefinition {
  const parsed = parsePluginManifest(options.manifest, options.validation);
  if (!parsed.ok) throw new PluginManifestError('(definePlugin)', parsed.problems);
  const { manifest } = parsed;

  const declared = new Set(manifest.tools.map((tool) => tool.name));
  const problems: string[] = [];
  for (const name of declared) {
    if (!Object.hasOwn(options.tools, name)) {
      problems.push(`tools.${name}: the manifest declares "${name}" and there is no code for it`);
    }
  }
  for (const name of Object.keys(options.tools)) {
    if (!declared.has(name)) {
      problems.push(
        `tools.${name}: there is code for "${name}", which the manifest does not declare (add it to tools in plugin.yaml, with its roles and effects)`,
      );
    }
  }
  if (problems.length > 0) {
    throw new PluginDefinitionError(
      `plugin "${manifest.id}" does not match its manifest:\n${describeManifestProblems(
        problems.map((message) => ({ path: '', message })),
      )}`,
    );
  }
  return { manifest, tools: new Map(Object.entries(options.tools)) };
}
