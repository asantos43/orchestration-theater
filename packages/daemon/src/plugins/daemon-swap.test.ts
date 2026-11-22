// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../cli.js';
import { parseConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir, NO_CLIENTS } from '../test-helpers.js';
import { isolatedEnv, manifestText, writePluginFolder } from './plugin-fixture.js';
import { FIXTURE_SERVER_PATH } from './test-plugin-fixture.js';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import type { McpGrant } from '../mcp/index.js';

describe('a running daemon and `ot plugin` (N235 (a))', () => {
  it('swaps the snapshot when a plugin is turned on or its manifest changes; an open snapshot stays', async () => {
    const data = await makeTempDataDir();
    const work = await makeTempDataDir();
    try {
      const clock = new FakeClock(Date.UTC(2026, 10, 21, 15));
      const daemon = await startDaemon({
        dataDir: data.dir,
        clientSearch: NO_CLIENTS,
        config: parseConfig('backup:\n  when: manual\n'),
        overrides: {
          clock,
          store: new InMemoryStore({ clock }),
          vault: new InMemorySecretVault(),
        },
        logger: createSilentLogger(),
      });
      const ot = async (...argv: string[]): Promise<number> =>
        await main([...argv, '--data-dir', data.dir], {
          env: isolatedEnv(work.dir),
          platform: 'linux',
          homedir: work.dir,
          cwd: work.dir,
          out: () => undefined,
          err: () => undefined,
          systemLocale: 'en',
          version: '1.2.3',
          overrides: { clock },
        });
      try {
        const folder = await writePluginFolder(join(work.dir, 'demo-db'));
        const session = daemon.registryHolder.current(); // a session that is already open
        expect(session.plugins.size).toBe(0);

        expect(await ot('plugin', 'install', folder)).toBe(0);
        // Installing turns nothing on: no swap that matters yet.
        expect(await ot('plugin', 'enable', 'demo-db', '--project', 'p1', '--yes')).toBe(0);
        await vi.waitFor(() => {
          expect(daemon.registryHolder.current().plugins.get('p1')?.[0]?.id).toBe('demo-db');
        });
        const withPlugin = daemon.registryHolder.current();
        expect(withPlugin.generation).toBeGreaterThan(session.generation);
        // The open session keeps the snapshot it read.
        expect(session.plugins.size).toBe(0);
        expect(daemon.plugins.activeFor('p1')[0]?.dir).toBe(await realpath(folder));

        // The manifest of the local folder is edited: the plugin goes off for the new snapshot.
        await writeFile(join(folder, 'plugin.yaml'), manifestText({ variant: 'changed' }));
        await daemon.plugins.refresh();
        expect(daemon.registryHolder.current().plugins.size).toBe(0);
        expect(withPlugin.plugins.get('p1')).toHaveLength(1);
      } finally {
        await daemon.stop();
      }
    } finally {
      await data.dispose();
      await work.dispose();
    }
  });
  it('serves the tools of an installed plugin through the real MCP server, by role', async () => {
    const data = await makeTempDataDir();
    const work = await makeTempDataDir();
    try {
      const clock = new FakeClock(Date.UTC(2026, 10, 21, 15));
      const store = new InMemoryStore({ clock });
      const daemon = await startDaemon({
        dataDir: data.dir,
        clientSearch: NO_CLIENTS,
        config: parseConfig('backup:\n  when: manual\n'),
        overrides: { clock, store, vault: new InMemorySecretVault() },
        logger: createSilentLogger(),
      });
      const ot = async (...argv: string[]): Promise<number> =>
        await main([...argv, '--data-dir', data.dir], {
          env: isolatedEnv(work.dir),
          platform: 'linux',
          homedir: work.dir,
          cwd: work.dir,
          out: () => undefined,
          err: () => undefined,
          systemLocale: 'en',
          version: '1.2.3',
          overrides: { clock },
        });
      try {
        await daemon.store.scenarios.create({
          id: 'sc1',
          kind: 'project',
          flowId: 'software',
          name: 'Scenario',
          folder: work.dir,
          profile: 'software',
          conventions: {},
          configOverride: {},
        });
        await daemon.store.plays.create({
          id: 'play-1',
          scenarioId: 'sc1',
          need: 'something',
          flowId: 'software',
          flowVersion: 1,
          state: 'PLANNING',
        });
        // A plugin whose server is the MCP server of the tests of P5 (a JSON array is a YAML list).
        const folder = join(work.dir, 'echoer');
        await mkdir(folder, { recursive: true });
        await writeFile(
          join(folder, 'plugin.yaml'),
          [
            'manifest_version: 1',
            'id: echoer',
            'version: 1.0.0',
            'server:',
            '  type: stdio',
            `  command: ${JSON.stringify([process.execPath, FIXTURE_SERVER_PATH])}`,
            'tools:',
            '  - name: echo',
            '    roles: [author, reviewer]',
            '    effects: read',
            '',
          ].join('\n'),
        );
        expect(await ot('plugin', 'install', folder)).toBe(0);

        const open = (role: string): McpGrant =>
          daemon.mcp.grant({
            attemptId: `play-1/d1/${role}`,
            role,
            correlation: { playId: 'play-1', demandId: 'd1', attemptId: `play-1/d1/${role}` },
            record: () => Promise.resolve(),
          });
        const rpc = async (grant: McpGrant, method: string, params: unknown) => {
          const response = await fetch(daemon.mcpUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              ...grant.server.headers,
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          });
          const text = await response.text();
          const data = text.startsWith('{')
            ? text
            : (text
                .split('\n')
                .find((line) => line.startsWith('data:'))
                ?.slice(5)
                .trim() ?? '{}');
          return JSON.parse(data) as {
            result?: {
              tools?: { name: string }[];
              content?: { text: string }[];
              isError?: boolean;
            };
          };
        };
        const names = async (role: string): Promise<string[]> =>
          ((await rpc(open(role), 'tools/list', {})).result?.tools ?? []).map((tool) => tool.name);

        // Installed but not turned on in the project: no tool.
        expect(await names('author')).not.toContain('echoer__echo');

        expect(await ot('plugin', 'enable', 'echoer', '--project', 'sc1', '--yes')).toBe(0);
        await vi.waitFor(async () => {
          expect(await names('author')).toContain('echoer__echo');
        });
        // The right roles see it; the others do not.
        expect(await names('reviewer')).toContain('echoer__echo');
        expect(await names('critic')).not.toContain('echoer__echo');

        // The call goes to the process of the plugin and its answer comes back.
        const call = await rpc(open('reviewer'), 'tools/call', {
          name: 'echoer__echo',
          arguments: { text: 'hi' },
        });
        expect(call.result?.isError ?? false).toBe(false);
        expect(call.result?.content?.[0]?.text).toBe('echo:hi');
      } finally {
        await daemon.stop();
      }
    } finally {
      await data.dispose();
      await work.dispose();
    }
  }, 60_000);
});
