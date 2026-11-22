// SPDX-License-Identifier: MPL-2.0
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePluginManifest, type PluginManifest } from '@otheater/core';
import { describePluginConformance, findPluginToolProblems } from './conformance.js';
import { PLUGIN_EVENT_MAX_BYTES, PLUGIN_EVENT_METHOD } from './events.js';
import { PluginStdioClient, type PluginProcessSpec } from './stdio-client.js';

// These tests start the server of a small plugin in a child process, over stdio, the way the
// daemon does. The child runs the build output of the SDK (`dist/plugin/index.js`), so they need
// `pnpm build` first, like the other tests that run built code.
const SDK_ROOT = resolve(import.meta.dirname, '../..');
const SDK_PLUGIN_ENTRY = pathToFileURL(resolve(SDK_ROOT, 'dist/plugin/index.js')).href;

const MANIFEST: PluginManifest = (() => {
  const parsed = parsePluginManifest({
    manifest_version: 1,
    id: 'echo',
    version: '1.0.0',
    server: { type: 'stdio', command: ['node', 'server.js'] },
    tools: [
      { name: 'echo', roles: ['actor'], effects: 'read', description: 'Echoes the text.' },
      { name: 'save', roles: [], effects: 'local_write' },
      { name: 'wipe', roles: [], effects: 'external_write', requires_producer_approval: true },
      { name: 'boom', roles: [], effects: 'read' },
      { name: 'undeclared_event', roles: [], effects: 'read' },
      { name: 'big_event', roles: [], effects: 'read' },
    ],
    events: ['saved'],
  });
  if (!parsed.ok) throw new Error('the fixture manifest is invalid');
  return parsed.manifest;
})();

const SERVER_SCRIPT = `
import { z } from 'zod';
import { definePlugin, pluginTool, servePlugin } from ${JSON.stringify(SDK_PLUGIN_ENTRY)};
const manifest = JSON.parse(process.env.PLUGIN_MANIFEST);
const noop = () => 'ok';
servePlugin(definePlugin({
  manifest,
  tools: {
    echo: pluginTool({ input: z.object({ text: z.string() }), handler: ({ text }) => ({ text }) }),
    save: pluginTool({
      input: z.object({ n: z.number().optional() }),
      handler: async ({ n }, { emit }) => { await emit('saved', { n: n ?? 0 }); return null; },
    }),
    wipe: pluginTool({ handler: noop }),
    boom: pluginTool({ handler: () => { throw new Error('it broke'); } }),
    undeclared_event: pluginTool({ handler: (_a, { emit }) => emit('nope', {}) }),
    big_event: pluginTool({
      handler: (_a, { emit }) => emit('saved', { text: 'x'.repeat(${String(PLUGIN_EVENT_MAX_BYTES)}) }),
    }),
  },
}));
`;

function serverSpec(): PluginProcessSpec {
  return {
    command: process.execPath,
    args: ['--input-type=module', '-e', SERVER_SCRIPT],
    cwd: SDK_ROOT,
    env: { PATH: process.env.PATH ?? '', PLUGIN_MANIFEST: JSON.stringify(MANIFEST) },
  };
}

describePluginConformance('echo fixture (SDK)', () => ({
  manifest: MANIFEST,
  server: serverSpec(),
  calls: [
    { tool: 'echo', arguments: { text: 'hi' } },
    { tool: 'echo', arguments: { text: 5 }, isError: true },
    { tool: 'save', arguments: { n: 3 }, emits: ['saved'] },
    { tool: 'boom', isError: true },
    { tool: 'undeclared_event', isError: true },
    { tool: 'big_event', isError: true },
  ],
}));

describe('servePlugin over stdio', () => {
  let client: PluginStdioClient | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('lists the tools with the annotations of their effects', async () => {
    client = await PluginStdioClient.start(serverSpec());
    expect(client.serverInfo).toMatchObject({ name: 'echo', version: '1.0.0' });
    const tools = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('echo')?.description).toBe('Echoes the text.');
    expect(byName.get('save')?.description).toBe('save');
    expect(byName.get('echo')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(byName.get('save')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(byName.get('wipe')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(findPluginToolProblems(MANIFEST, tools)).toEqual({
      missing: [],
      undeclared: [],
      duplicated: [],
      shape: [],
      annotations: [],
    });
  });

  it('returns the value of the handler as JSON text, and a throw as a tool error', async () => {
    client = await PluginStdioClient.start(serverSpec());
    const ok = await client.callTool('echo', { text: 'hello' });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(PluginStdioClient.textOf(ok))).toEqual({ text: 'hello' });
    const saved = await client.callTool('save');
    expect(JSON.parse(PluginStdioClient.textOf(saved))).toBeNull();
    const failed = await client.callTool('boom');
    expect(failed.isError).toBe(true);
    expect(PluginStdioClient.textOf(failed)).toBe('it broke');
    const invalid = await client.callTool('echo', { text: 1 });
    expect(invalid.isError).toBe(true);
    expect(PluginStdioClient.textOf(invalid)).toMatch(/text/);
  });

  it('publishes an event as the notification the daemon reads', async () => {
    client = await PluginStdioClient.start(serverSpec());
    await client.callTool('save', { n: 4 });
    expect(client.notificationsOf(PLUGIN_EVENT_METHOD)).toEqual([
      { method: PLUGIN_EVENT_METHOD, params: { name: 'saved', payload: { n: 4 } } },
    ]);
  });

  it('refuses on its side an undeclared event and an oversized payload, and sends nothing', async () => {
    client = await PluginStdioClient.start(serverSpec());
    const undeclared = await client.callTool('undeclared_event');
    expect(undeclared.isError).toBe(true);
    expect(PluginStdioClient.textOf(undeclared)).toContain('"nope" is not declared');
    const big = await client.callTool('big_event');
    expect(big.isError).toBe(true);
    expect(PluginStdioClient.textOf(big)).toContain('over the limit');
    expect(client.notificationsOf(PLUGIN_EVENT_METHOD)).toEqual([]);
  });

  it('writes nothing but protocol to stdout, and ends when stdin closes', async () => {
    client = await PluginStdioClient.start(serverSpec());
    await client.callTool('echo', { text: 'x' });
    expect(client.strayOutput).toEqual([]);
    expect(await client.close()).toEqual({ exitCode: 0, graceful: true });
  });
});

describe('findPluginToolProblems', () => {
  const listed = (
    overrides: Record<string, Record<string, unknown> | null> = {},
  ): Parameters<typeof findPluginToolProblems>[1] =>
    MANIFEST.tools.flatMap((tool) => {
      const override = overrides[tool.name];
      if (override === null) return [];
      return [
        {
          name: tool.name,
          description: 'd',
          inputSchema: { type: 'object' },
          annotations: {
            readOnlyHint: tool.effects === 'read',
            destructiveHint: tool.effects === 'external_write',
          },
          ...override,
        },
      ];
    });

  it('finds nothing when the server lists what the manifest declares', () => {
    expect(findPluginToolProblems(MANIFEST, listed())).toEqual({
      missing: [],
      undeclared: [],
      duplicated: [],
      shape: [],
      annotations: [],
    });
  });

  it('finds a declared tool the server does not list, and one it lists and the manifest lacks', () => {
    const problems = findPluginToolProblems(MANIFEST, [
      ...listed({ save: null }),
      { name: 'extra', description: 'd', inputSchema: { type: 'object' } },
    ]);
    expect(problems.missing).toEqual(['save']);
    expect(problems.undeclared).toEqual(['extra']);
  });

  it('finds a tool listed twice', () => {
    const [first] = listed();
    if (first === undefined) throw new Error('empty');
    expect(findPluginToolProblems(MANIFEST, [...listed(), first]).duplicated).toEqual([first.name]);
  });

  it('finds a missing description and a schema that is not an object', () => {
    const problems = findPluginToolProblems(
      MANIFEST,
      listed({ echo: { description: ' ' }, save: { inputSchema: { type: 'string' } } }),
    );
    expect(problems.shape).toEqual([
      'echo: no description',
      'save: inputSchema.type is not "object"',
    ]);
  });

  it('finds annotations that disagree with the effects', () => {
    const problems = findPluginToolProblems(
      MANIFEST,
      listed({
        echo: { annotations: { readOnlyHint: false } },
        save: { annotations: { readOnlyHint: true } },
        wipe: { annotations: { destructiveHint: false } },
      }),
    );
    expect(problems.annotations).toEqual([
      expect.stringContaining('echo: the manifest says effects: read'),
      expect.stringContaining('save: the tool is annotated readOnlyHint: true'),
      expect.stringContaining('wipe: the manifest says effects: external_write'),
    ]);
  });
});
