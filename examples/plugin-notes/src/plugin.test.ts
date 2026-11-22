// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeManifestProblems, parsePluginManifestText } from '@otheater/core';
import { PLUGIN_EVENT_METHOD } from '@otheater/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { MANIFEST_URL, notesPlugin } from './plugin.js';

const MANIFEST_TEXT = readFileSync(MANIFEST_URL, 'utf8');

describe('plugin.yaml of the example', () => {
  it('is valid for the manifest validator of the core (the one the install of P4 runs)', () => {
    const result = parsePluginManifestText(MANIFEST_TEXT, parseYaml);
    if (!result.ok) throw new Error(describeManifestProblems(result.problems));
    expect(result.manifest.id).toBe('notes');
    expect(result.manifest.server).toEqual({ type: 'stdio', command: ['node', 'dist/server.js'] });
  });

  it('declares the tools with the roles, effects and approval of N240', () => {
    const result = parsePluginManifestText(MANIFEST_TEXT, parseYaml);
    if (!result.ok) throw new Error(describeManifestProblems(result.problems));
    const tools = Object.fromEntries(result.manifest.tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(tools)).toEqual(['list_notes', 'add_note', 'clear_notes']);
    expect(tools.list_notes).toMatchObject({ roles: [], effects: 'read' });
    expect(tools.add_note).toMatchObject({ roles: ['actor'], effects: 'local_write' });
    expect(tools.clear_notes).toMatchObject({
      roles: [],
      effects: 'local_write',
      requires_producer_approval: true,
    });
    expect(result.manifest.events).toEqual(['note_added']);
  });

  it('has a table panel on the read tool and an action panel on the approved tool', () => {
    const result = parsePluginManifestText(MANIFEST_TEXT, parseYaml);
    if (!result.ok) throw new Error(describeManifestProblems(result.problems));
    expect(result.manifest.panel).toEqual([
      expect.objectContaining({ type: 'table', source: 'list_notes' }),
      expect.objectContaining({ type: 'action', tool: 'clear_notes' }),
    ]);
  });

  it('has the same i18n keys in en and pt-BR', () => {
    const result = parsePluginManifestText(MANIFEST_TEXT, parseYaml);
    if (!result.ok) throw new Error(describeManifestProblems(result.problems));
    const i18n: Record<string, Record<string, string> | undefined> = result.manifest.i18n ?? {};
    const en = Object.keys(i18n.en ?? {});
    expect(en.length).toBeGreaterThan(0);
    expect(Object.keys(i18n['pt-BR'] ?? {}).sort()).toEqual(en.sort());
  });

  it('is shipped in the package together with dist', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { files: string[] };
    expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'plugin.yaml']));
  });
});

describe('notesPlugin', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-notes-def-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('has code for every tool of the manifest', () => {
    expect([...notesPlugin(dir).tools.keys()].sort()).toEqual(
      ['add_note', 'clear_notes', 'list_notes'].sort(),
    );
  });

  it('uses the event method of the SDK contract', () => {
    expect(PLUGIN_EVENT_METHOD).toBe('notifications/otheater/event');
  });
});
