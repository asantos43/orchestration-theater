// SPDX-License-Identifier: MPL-2.0
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describePluginConformance, PluginStdioClient } from '@otheater/sdk';
import { describe, expect, it } from 'vitest';

// The suite starts `node dist/server.js`, the way the daemon starts the plugin, so it needs
// `pnpm build` first (as the tests of other built code do).
const PLUGIN_DIR = resolve(import.meta.dirname, '..');

async function startProject(): Promise<{ project: string; spec: ReturnType<typeof specFor> }> {
  const project = await mkdtemp(join(tmpdir(), 'plugin-notes-project-'));
  return { project, spec: specFor(project) };
}

function specFor(project: string) {
  return {
    command: process.execPath,
    args: ['dist/server.js'],
    cwd: PLUGIN_DIR,
    env: { PATH: process.env.PATH ?? '', OTHEATER_PROJECT_DIR: project },
  };
}

describePluginConformance('plugin-notes', async () => {
  const { project, spec } = await startProject();
  return {
    manifest: join(PLUGIN_DIR, 'plugin.yaml'),
    server: spec,
    calls: [
      { tool: 'list_notes' },
      { tool: 'add_note', arguments: { text: 'remember the milk' }, emits: ['note_added'] },
      { tool: 'add_note', arguments: { text: '   ' }, isError: true },
      { tool: 'add_note', arguments: {}, isError: true },
      { tool: 'clear_notes' },
    ],
    dispose: () => rm(project, { recursive: true, force: true }),
  };
});

describe('plugin-notes over stdio', () => {
  it('keeps the notes in the project folder and tells the panel what it needs', async () => {
    const { project, spec } = await startProject();
    const client = await PluginStdioClient.start(spec);
    try {
      const added = await client.callTool('add_note', { text: 'first' });
      expect(JSON.parse(PluginStdioClient.textOf(added))).toMatchObject({ id: 1, text: 'first' });
      expect(client.notificationsOf('notifications/otheater/event')).toEqual([
        {
          method: 'notifications/otheater/event',
          params: { name: 'note_added', payload: { id: 1, length: 5 } },
        },
      ]);
      const rows = JSON.parse(PluginStdioClient.textOf(await client.callTool('list_notes'))) as {
        text: string;
        created_at: string;
      }[];
      expect(rows.map((row) => row.text)).toEqual(['first']);
      expect(Number.isNaN(Date.parse(rows[0]?.created_at ?? ''))).toBe(false);
      const cleared = await client.callTool('clear_notes');
      expect(JSON.parse(PluginStdioClient.textOf(cleared))).toEqual({ deleted: 1 });
    } finally {
      await client.close();
      await rm(project, { recursive: true, force: true });
    }
  });

  it('falls back to the working directory when the variable is not set', async () => {
    const project = await mkdtemp(join(tmpdir(), 'plugin-notes-cwd-'));
    await mkdir(project, { recursive: true });
    const client = await PluginStdioClient.start({
      command: process.execPath,
      args: [join(PLUGIN_DIR, 'dist/server.js')],
      cwd: project,
      env: { PATH: process.env.PATH ?? '' },
    });
    try {
      await client.callTool('add_note', { text: 'here' });
      const rows = JSON.parse(
        PluginStdioClient.textOf(await client.callTool('list_notes')),
      ) as unknown[];
      expect(rows).toHaveLength(1);
    } finally {
      await client.close();
      await rm(project, { recursive: true, force: true });
    }
  });

  it('refuses a relative OTHEATER_PROJECT_DIR and exits with an error', async () => {
    await expect(
      PluginStdioClient.start({ ...specFor('relative/dir'), cwd: PLUGIN_DIR }, { timeoutMs: 5000 }),
    ).rejects.toThrow();
  });
});
