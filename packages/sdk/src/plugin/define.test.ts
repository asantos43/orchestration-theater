// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { definePlugin, PluginDefinitionError, pluginTool } from './define.js';
import { PluginManifestError } from './manifest-file.js';
import type { PluginManifestInput } from '@otheater/core';

function manifest(): PluginManifestInput {
  return {
    manifest_version: 1,
    id: 'echo',
    version: '1.0.0',
    server: { type: 'stdio', command: ['node', 'dist/server.js'] },
    tools: [
      { name: 'echo', roles: ['actor'], effects: 'read' },
      { name: 'save', roles: [], effects: 'local_write' },
    ],
    events: ['saved'],
  };
}

const echo = pluginTool({
  input: z.object({ text: z.string() }),
  handler: ({ text }) => text,
});
const save = pluginTool({ handler: () => 'ok' });

describe('definePlugin', () => {
  it('ties the manifest to the code of its tools', () => {
    const plugin = definePlugin({ manifest: manifest(), tools: { echo, save } });
    expect(plugin.manifest.id).toBe('echo');
    expect([...plugin.tools.keys()]).toEqual(['echo', 'save']);
  });

  it('accepts a manifest the validator has already parsed', () => {
    const first = definePlugin({ manifest: manifest(), tools: { echo, save } });
    expect(definePlugin({ manifest: first.manifest, tools: { echo, save } }).manifest).toEqual(
      first.manifest,
    );
  });

  it('refuses an invalid manifest with the path of the field', () => {
    const bad = { ...manifest(), tools: [{ name: 'Echo', roles: ['actor'], effects: 'read' }] };
    let error: unknown;
    try {
      definePlugin({ manifest: bad as never, tools: { echo } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PluginManifestError);
    expect((error as PluginManifestError).problems.map((problem) => problem.path)).toContain(
      'tools[0].name',
    );
    expect((error as PluginManifestError).message).toContain('tools[0].name');
  });

  it('refuses a tool of the manifest that has no code', () => {
    expect(() => definePlugin({ manifest: manifest(), tools: { echo } })).toThrow(
      PluginDefinitionError,
    );
    expect(() => definePlugin({ manifest: manifest(), tools: { echo } })).toThrow(
      /declares "save" and there is no code for it/,
    );
  });

  it('refuses code for a tool the manifest does not declare', () => {
    expect(() => definePlugin({ manifest: manifest(), tools: { echo, save, drop: save } })).toThrow(
      /code for "drop", which the manifest does not declare/,
    );
  });

  it('refuses a tool named like a tool of the framework', () => {
    const bad = {
      ...manifest(),
      tools: [{ name: 'submit_idea', roles: ['actor'], effects: 'read' }],
    };
    expect(() =>
      definePlugin({
        manifest: bad as never,
        tools: { submit_idea: save },
        validation: { frameworkToolNames: ['submit_idea'] },
      }),
    ).toThrow(/tools\[0\]\.name/);
  });
});
