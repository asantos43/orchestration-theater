// SPDX-License-Identifier: MPL-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../cli.js';
import { parseConfig } from '../config.js';
import { startDaemon } from '../daemon.js';
import type { McpGrant } from '../mcp/index.js';
import { captureLogger, makeTempDataDir, NO_CLIENTS } from '../test-helpers.js';
import { isolatedEnv } from './plugin-fixture.js';
import type { PluginNotice } from './runtime-config.js';
import { FIXTURE_SERVER_PATH } from './test-plugin-fixture.js';

const TOKEN = 'tok-daemon-0123456789-abcdef';

describe('the secrets of a plugin in a running daemon (N239)', () => {
  it('the plugin does not start without its secret, the warning goes out, and `secret set` makes it start without the value leaking', async () => {
    const data = await makeTempDataDir();
    const work = await makeTempDataDir();
    try {
      const clock = new FakeClock(Date.UTC(2026, 10, 21, 15));
      const store = new InMemoryStore({ clock });
      const vault = new InMemorySecretVault();
      const { logger, lines } = captureLogger();
      const notices: PluginNotice[] = [];
      const daemon = await startDaemon({
        dataDir: data.dir,
        clientSearch: NO_CLIENTS,
        config: parseConfig('backup:\n  when: manual\n'),
        overrides: { clock, store, vault },
        logger,
        pluginNotices: (notice) => notices.push(notice),
      });
      const ot = async (input?: string, ...argv: string[]): Promise<number> =>
        await main([...argv, '--data-dir', data.dir], {
          env: isolatedEnv(work.dir),
          platform: 'linux',
          homedir: work.dir,
          cwd: work.dir,
          out: () => undefined,
          err: () => undefined,
          systemLocale: 'en',
          version: '1.2.3',
          ...(input === undefined ? {} : { input: Readable.from([input]) }),
          overrides: { clock, vault },
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
        const folder = join(work.dir, 'vaulted');
        await mkdir(folder, { recursive: true });
        await writeFile(
          join(folder, 'plugin.yaml'),
          [
            'manifest_version: 1',
            'id: vaulted',
            'version: 1.0.0',
            'server:',
            '  type: stdio',
            `  command: ${JSON.stringify([process.execPath, FIXTURE_SERVER_PATH])}`,
            'tools:',
            '  - name: echo',
            '    roles: [author]',
            '    effects: read',
            '  - name: env_report',
            '    roles: [author]',
            '    effects: read',
            'secrets: [API_TOKEN]',
            '',
          ].join('\n'),
        );
        expect(await ot(undefined, 'plugin', 'install', folder)).toBe(0);
        expect(
          await ot(undefined, 'plugin', 'enable', 'vaulted', '--project', 'sc1', '--yes'),
        ).toBe(0);

        const recorded: unknown[] = [];
        const open = (): McpGrant =>
          daemon.mcp.grant({
            attemptId: 'play-1/d1/author',
            role: 'author',
            correlation: { playId: 'play-1', demandId: 'd1', attemptId: 'play-1/d1/author' },
            record: (entry: unknown) => {
              recorded.push(entry);
              return Promise.resolve();
            },
          });
        const rpc = async (method: string, params: unknown) => {
          const grant = open();
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
          const body = text.startsWith('{')
            ? text
            : (text
                .split('\n')
                .find((line) => line.startsWith('data:'))
                ?.slice(5)
                .trim() ?? '{}');
          return {
            raw: body,
            ...(JSON.parse(body) as {
              result?: { content?: { text: string }[]; isError?: boolean };
            }),
          };
        };
        await vi.waitFor(() => {
          expect(daemon.registryHolder.current().plugins.get('sc1')?.[0]?.id).toBe('vaulted');
        });

        // Without the secret the server does not start: its tools are listed nowhere (as for any
        // plugin that never ran), the call is not found, and the warning goes out.
        const names = async (): Promise<string[]> =>
          (
            JSON.parse((await rpc('tools/list', {})).raw) as {
              result?: { tools?: { name: string }[] };
            }
          ).result?.tools?.map((tool) => tool.name) ?? [];
        expect(await names()).not.toContain('vaulted__echo');
        const before = await rpc('tools/call', {
          name: 'vaulted__echo',
          arguments: { text: 'hi' },
        });
        expect(before.result?.content).toBeUndefined();
        expect(notices).toContainEqual({
          kind: 'secret_missing',
          plugin: 'vaulted',
          project: 'sc1',
          secrets: ['API_TOKEN'],
        });
        expect(notices.some((notice) => notice.kind === 'process_started')).toBe(false);
        expect(notices.some((notice) => notice.kind === 'process_failed')).toBe(false);
        expect(
          lines.some((line) => line.level === 'warn' && line.fields.plugin === 'vaulted'),
        ).toBe(true);

        // The value comes from the standard input and is stored for the project.
        expect(
          await ot(
            `${TOKEN}\n`,
            'plugin',
            'secret',
            'set',
            'vaulted',
            'API_TOKEN',
            '--project',
            'sc1',
          ),
        ).toBe(0);
        expect((await vault.get('plugin/vaulted/sc1/API_TOKEN'))?.reveal()).toBe(TOKEN);

        // Now it starts, and what the Executor sees has the variable names only.
        const seen = await rpc('tools/call', { name: 'vaulted__env_report', arguments: {} });
        expect(seen.result?.isError ?? false).toBe(false);
        const report = JSON.parse(seen.result?.content?.[0]?.text ?? '{}') as { keys: string[] };
        expect(report.keys).toContain('API_TOKEN');
        expect(await names()).toContain('vaulted__echo');
        const tools = await rpc('tools/list', {});

        // The value is in no notice, no log line, no event, no record and no listing.
        expect(notices.some((notice) => notice.kind === 'process_started')).toBe(true);
        const everything = JSON.stringify({
          notices,
          lines,
          recorded,
          tools: tools.raw,
          seen: seen.raw,
          events: await daemon.store.events.readFrom(0, 10_000),
        });
        expect(everything).not.toContain(TOKEN);

        // The server did get it, as an environment variable (and the daemon did not).
        expect(process.env.API_TOKEN).toBeUndefined();
        const asked = await rpc('tools/call', {
          name: 'vaulted__env_report',
          arguments: { name: 'API_TOKEN' },
        });
        expect(JSON.parse(asked.result?.content?.[0]?.text ?? '{}')).toMatchObject({
          value: TOKEN,
        });
      } finally {
        await daemon.stop();
      }
    } finally {
      await data.dispose();
      await work.dispose();
    }
  }, 60_000);
});
