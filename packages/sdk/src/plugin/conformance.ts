// SPDX-License-Identifier: MPL-2.0
import {
  parsePluginManifest,
  type PluginManifest,
  type PluginManifestOptions,
  type PluginToolManifest,
} from '@otheater/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterFactory, Disposable } from '../harness.js';
import { PLUGIN_EVENT_MAX_BYTES, PLUGIN_EVENT_METHOD } from './events.js';
import { readPluginManifest } from './manifest-file.js';
import {
  PluginStdioClient,
  type PluginProcessSpec,
  type PluginToolDescription,
} from './stdio-client.js';

/** One call the suite makes, to see that the tool answers and publishes only declared events. */
export interface PluginConformanceCall {
  readonly tool: string;
  readonly arguments?: Record<string, unknown>;
  /** The call must come back as a tool error (a bad argument, say). False by default. */
  readonly isError?: boolean;
  /** Event names (as in the manifest) the call must publish. */
  readonly emits?: readonly string[];
}

export interface PluginHarness extends Disposable {
  /** The manifest, or the path of the `plugin.yaml` to read with the validator of the core. */
  readonly manifest: PluginManifest | string;
  /** How to start the server: the `server.command` of the manifest, in a prepared folder. */
  readonly server: PluginProcessSpec;
  /**
   * Calls to make once the list is checked. They must leave the plugin in a state the next test
   * can use (the suite starts a new server process for each test, but a plugin that writes a
   * file keeps it: give the harness a temporary project folder and remove it in `dispose`).
   */
  readonly calls?: readonly PluginConformanceCall[];
  /** Options of the validator, like the framework tool names of the daemon. */
  readonly validation?: PluginManifestOptions;
  /** Deadline of each request and of the end of the process, in ms. Default 10 000. */
  readonly timeoutMs?: number;
}

/** What differs between the `tools/list` of a server and the tools of its manifest. */
export interface PluginToolProblems {
  /** Declared in the manifest and not exposed by the server. */
  readonly missing: readonly string[];
  /** Exposed by the server and not declared in the manifest. */
  readonly undeclared: readonly string[];
  /** Exposed more than once. */
  readonly duplicated: readonly string[];
  /** A declared tool with no description or with no object schema of arguments. */
  readonly shape: readonly string[];
  /** A declared tool whose MCP annotations disagree with its `effects`. */
  readonly annotations: readonly string[];
}

/**
 * The effects a tool claims in the MCP annotations of the SDK, against the manifest [proposta]:
 * a `read` tool is `readOnlyHint: true`, nothing else is, and an `external_write` tool is not
 * annotated `destructiveHint: false`.
 */
function annotationProblem(
  manifest: PluginToolManifest,
  described: PluginToolDescription,
): string | undefined {
  const annotations = described.annotations ?? {};
  if (manifest.effects === 'read') {
    return annotations.readOnlyHint === true
      ? undefined
      : 'the manifest says effects: read, so the tool must be annotated readOnlyHint: true';
  }
  if (annotations.readOnlyHint === true) {
    return `the tool is annotated readOnlyHint: true, and the manifest says effects: ${manifest.effects}`;
  }
  if (manifest.effects === 'external_write' && annotations.destructiveHint === false) {
    return 'the manifest says effects: external_write, and the tool is annotated destructiveHint: false';
  }
  return undefined;
}

/** Compares what a server lists with the tools of the manifest; every list empty means it agrees. */
export function findPluginToolProblems(
  manifest: PluginManifest,
  listed: readonly PluginToolDescription[],
): PluginToolProblems {
  const names = listed.map((tool) => tool.name);
  const declared = manifest.tools.map((tool) => tool.name);
  const shape: string[] = [];
  const annotations: string[] = [];
  for (const tool of manifest.tools) {
    const described = listed.find((entry) => entry.name === tool.name);
    if (described === undefined) continue;
    if ((described.description ?? '').trim() === '') {
      shape.push(`${tool.name}: no description`);
    }
    if (described.inputSchema?.type !== 'object') {
      shape.push(`${tool.name}: inputSchema.type is not "object"`);
    }
    const problem = annotationProblem(tool, described);
    if (problem !== undefined) annotations.push(`${tool.name}: ${problem}`);
  }
  return {
    missing: declared.filter((name) => !names.includes(name)),
    undeclared: names.filter((name) => !declared.includes(name)),
    duplicated: names.filter((name, index) => names.indexOf(name) !== index),
    shape,
    annotations,
  };
}

/**
 * Registers the conformance tests of a plugin server in the calling Vitest file (plan of Phase 9,
 * P9). They start the server by stdio, as the daemon does, do `tools/list` and check what comes
 * back against the manifest: the tools it exposes are the ones it declares, no more and no fewer,
 * each with a description and a schema of arguments, annotated in agreement with its effects, and
 * the events it publishes are only declared ones. Call it at the top level of a test file.
 *
 * ```ts
 * describePluginConformance('plugin-notes', async () => {
 *   const project = await mkdtemp(join(tmpdir(), 'notes-'));
 *   return {
 *     manifest: 'plugin.yaml',
 *     server: { command: 'node', args: ['dist/server.js'], env: { PATH, OTHEATER_PROJECT_DIR: project } },
 *     dispose: () => rm(project, { recursive: true }),
 *   };
 * });
 * ```
 */
export function describePluginConformance(
  name: string,
  factory: AdapterFactory<PluginHarness>,
): void {
  describe(`Plugin conformance: ${name}`, () => {
    let harness: PluginHarness | undefined;
    let client: PluginStdioClient | undefined;
    let manifest: PluginManifest | undefined;

    beforeEach(async () => {
      harness = await factory();
      manifest =
        typeof harness.manifest === 'string'
          ? readPluginManifest(harness.manifest, harness.validation)
          : harness.manifest;
    });
    afterEach(async () => {
      const current = client;
      client = undefined;
      try {
        await current?.close();
      } finally {
        const used = harness;
        harness = undefined;
        await used?.dispose?.();
      }
    });

    const started = async (): Promise<PluginStdioClient> => {
      if (harness === undefined) throw new Error('Plugin conformance harness used outside a test');
      client = await PluginStdioClient.start(harness.server, {
        timeoutMs: harness.timeoutMs ?? 10_000,
      });
      return client;
    };
    const current = (): PluginManifest => {
      if (manifest === undefined) throw new Error('Plugin conformance harness used outside a test');
      return manifest;
    };

    it('the manifest is valid for the validator of the core', () => {
      const result = parsePluginManifest(current(), harness?.validation);
      expect(result.ok ? [] : result.problems).toEqual([]);
    });

    it('starts over stdio, answers initialize and writes nothing but protocol to stdout', async () => {
      const running = await started();
      expect(running.serverInfo?.name).toEqual(expect.any(String));
      await running.listTools();
      expect(running.strayOutput).toEqual([]);
    });

    it('tools/list exposes exactly the tools of the manifest', async () => {
      const problems = findPluginToolProblems(current(), await (await started()).listTools());
      expect({
        missing: problems.missing,
        undeclared: problems.undeclared,
        duplicated: problems.duplicated,
      }).toEqual({ missing: [], undeclared: [], duplicated: [] });
    });

    it('every tool has a description and an object schema of arguments', async () => {
      const problems = findPluginToolProblems(current(), await (await started()).listTools());
      expect(problems.shape).toEqual([]);
    });

    it('the annotations of each tool agree with its effects', async () => {
      const problems = findPluginToolProblems(current(), await (await started()).listTools());
      expect(problems.annotations).toEqual([]);
    });

    it('answers the calls of the harness, and publishes only declared events', async () => {
      const calls = harness?.calls ?? [];
      const running = await started();
      const declared = new Set(current().events);
      for (const call of calls) {
        const before = running.notifications.length;
        const result = await running.callTool(call.tool, call.arguments ?? {});
        expect(result.isError ?? false, `${call.tool}: isError`).toBe(call.isError ?? false);
        const published = running
          .notificationsOf(PLUGIN_EVENT_METHOD, before)
          .map((entry) => entry.params as { name?: unknown; payload?: unknown });
        for (const event of published) {
          expect(typeof event.name, `${call.tool}: event name`).toBe('string');
          expect(declared.has(event.name as string), `${call.tool}: "${String(event.name)}"`).toBe(
            true,
          );
          expect(
            typeof event.payload === 'object' &&
              event.payload !== null &&
              !Array.isArray(event.payload),
            `${call.tool}: payload of "${String(event.name)}" is an object`,
          ).toBe(true);
          expect(
            Buffer.byteLength(JSON.stringify(event.payload), 'utf8'),
            `${call.tool}: payload of "${String(event.name)}"`,
          ).toBeLessThanOrEqual(PLUGIN_EVENT_MAX_BYTES);
        }
        for (const name of call.emits ?? []) {
          expect(
            published.map((event) => event.name),
            `${call.tool}: must publish "${name}"`,
          ).toContain(name);
        }
      }
      expect(running.strayOutput).toEqual([]);
    });

    it('refuses a tool that the manifest does not declare', async () => {
      const running = await started();
      const result = await running
        .callTool('this_tool_is_not_in_the_manifest')
        .catch((error: unknown) => ({ failed: error }));
      const refused = 'failed' in result || result.isError === true;
      expect(refused).toBe(true);
    });

    it('ends by itself when the client closes stdin', async () => {
      const running = await started();
      await running.listTools();
      const ended = await running.close();
      expect(ended.graceful).toBe(true);
    });
  });
}
