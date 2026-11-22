// SPDX-License-Identifier: MPL-2.0
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../cli.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import type { McpGrant } from '../mcp/index.js';
import { makeTempDataDir, NO_CLIENTS } from '../test-helpers.js';
import { isolatedEnv } from './plugin-fixture.js';
import { FIXTURE_SERVER_PATH } from './test-plugin-fixture.js';

/** What the tests read of an event of the log. */
interface Logged {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly scenarioId?: string | undefined;
}

/**
 * A daemon with the plugin `echoer` installed (its server is the MCP server of the tests, with
 * `--events`) and turned on in the project `sc1`. The manifest declares the event `build.done`.
 */
async function withPlugin(
  configText: string,
  body: (context: {
    daemon: DaemonHandle;
    ot: (...argv: string[]) => Promise<number>;
    logged: (type?: string) => Promise<Logged[]>;
    call: (tool: string, args?: Record<string, unknown>) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const data = await makeTempDataDir();
  const work = await makeTempDataDir();
  try {
    const clock = new FakeClock(Date.UTC(2026, 10, 21, 15));
    const daemon = await startDaemon({
      dataDir: data.dir,
      clientSearch: NO_CLIENTS,
      config: parseConfig(`backup:\n  when: manual\n${configText}`),
      overrides: { clock, store: new InMemoryStore({ clock }), vault: new InMemorySecretVault() },
      logger: createSilentLogger(),
    });
    try {
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
          `  command: ${JSON.stringify([process.execPath, FIXTURE_SERVER_PATH, '--events'])}`,
          'tools:',
          '  - name: publish_events',
          '    roles: [author]',
          '    effects: read',
          '  - name: publish',
          '    roles: [author]',
          '    effects: read',
          'events: [build.done, tick]',
          '',
        ].join('\n'),
      );
      expect(await ot('plugin', 'install', folder)).toBe(0);
      expect(await ot('plugin', 'enable', 'echoer', '--project', 'sc1', '--yes')).toBe(0);
      await vi.waitFor(() => {
        expect(daemon.plugins.activeFor('sc1')).toHaveLength(1);
      });

      const grant: McpGrant = daemon.mcp.grant({
        attemptId: 'play-1/d1/author',
        role: 'author',
        correlation: { playId: 'play-1', demandId: 'd1', attemptId: 'play-1/d1/author' },
        record: () => Promise.resolve(),
      });
      const call = async (tool: string, args: Record<string, unknown> = {}): Promise<void> => {
        const response = await fetch(daemon.mcpUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...grant.server.headers,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: `echoer__${tool}`, arguments: args },
          }),
        });
        expect(await response.text()).toContain('published');
      };
      const logged = async (type?: string): Promise<Logged[]> => {
        const all = (await daemon.store.events.readFrom(0, 10_000)) as readonly Logged[];
        return all.filter((event) => type === undefined || event.type === type);
      };
      await body({ daemon, ot, logged, call });
    } finally {
      await daemon.stop();
    }
  } finally {
    await data.dispose();
    await work.dispose();
  }
}

describe('the events of the plugins in a running daemon (P8)', () => {
  it('writes the declared event with the prefix, reaches the subscribers, and refuses the undeclared one', async () => {
    await withPlugin('', async ({ daemon, logged, call }) => {
      const controller = new AbortController();
      const seen: string[] = [];
      const reader = (async () => {
        for await (const event of daemon.eventHub.follow({
          afterId: 0,
          signal: controller.signal,
        })) {
          seen.push(event.type);
        }
      })();

      await call('publish_events');
      await vi.waitFor(async () => {
        expect(await logged('plugin.echoer.build.done')).toHaveLength(1);
        expect(await logged('plugin.event_rejected')).toHaveLength(1);
      });
      const [event] = await logged('plugin.echoer.build.done');
      expect(event).toMatchObject({ payload: { n: 1 }, scenarioId: 'sc1' });
      const [rejected] = await logged('plugin.event_rejected');
      expect(rejected?.payload).toEqual({
        plugin: 'echoer',
        project: 'sc1',
        name: 'not.declared',
        reason: 'not_declared',
      });
      // The undeclared event never reached the log under its own name.
      expect(await logged('plugin.echoer.not.declared')).toEqual([]);
      // The subscribers of the hub hear the event of the plugin, like any other.
      await vi.waitFor(() => {
        expect(seen).toContain('plugin.echoer.build.done');
      });
      controller.abort();
      await reader;
    });
  }, 60_000);

  it('refuses a payload over plugins.event_max_bytes and a name the plugin made up', async () => {
    await withPlugin('plugins:\n  event_max_bytes: 100\n', async ({ logged, call }) => {
      await call('publish', { name: 'tick', payload: { a: 1 } });
      await call('publish', { name: 'tick', bytes: 300 });
      await call('publish', { name: 'tick', raw: { nothing: 'to see' } });
      await vi.waitFor(async () => {
        expect(await logged('plugin.event_rejected')).toHaveLength(2);
      });
      expect(await logged('plugin.echoer.tick')).toHaveLength(1);
      const reasons = (await logged('plugin.event_rejected')).map((event) => event.payload.reason);
      expect(reasons).toEqual(['too_large', 'invalid']);
      const [tooLarge] = await logged('plugin.event_rejected');
      expect(tooLarge?.payload).toMatchObject({ bytes: 310, limit: 100 });
    });
  }, 60_000);

  it('plugins.events: off refuses every event of a plugin', async () => {
    await withPlugin('plugins:\n  events: off\n', async ({ logged, call }) => {
      await call('publish_events');
      await vi.waitFor(async () => {
        expect(await logged('plugin.event_rejected')).toHaveLength(2);
      });
      expect(await logged('plugin.echoer.build.done')).toEqual([]);
      const reasons = (await logged('plugin.event_rejected')).map((event) => event.payload.reason);
      expect(reasons).toEqual(['off', 'off']);
    });
  }, 60_000);

  it('writes the events of the life of the plugin: install, turn on, server, turn off, remove', async () => {
    await withPlugin('', async ({ ot, logged, call }) => {
      await vi.waitFor(async () => {
        expect((await logged('plugin.installed')).length).toBeGreaterThan(0);
        expect((await logged('plugin.enabled')).length).toBeGreaterThan(0);
      });
      expect((await logged('plugin.installed'))[0]?.payload).toEqual({
        plugin: 'echoer',
        version: '1.0.0',
        update: false,
      });
      expect((await logged('plugin.enabled'))[0]).toMatchObject({
        payload: { plugin: 'echoer', project: 'sc1' },
        scenarioId: 'sc1',
      });

      await call('publish_events');
      await vi.waitFor(async () => {
        expect(await logged('plugin.server_started')).toHaveLength(1);
      });
      expect((await logged('plugin.server_started'))[0]).toMatchObject({
        payload: { plugin: 'echoer', project: 'sc1' },
        scenarioId: 'sc1',
      });

      expect(await ot('plugin', 'disable', 'echoer', '--project', 'sc1')).toBe(0);
      await vi.waitFor(async () => {
        expect(await logged('plugin.disabled')).toHaveLength(1);
      });
      expect((await logged('plugin.disabled'))[0]?.payload).toEqual({
        plugin: 'echoer',
        project: 'sc1',
        reason: 'producer',
      });

      expect(await ot('plugin', 'remove', 'echoer')).toBe(0);
      await vi.waitFor(async () => {
        expect(await logged('plugin.removed')).toHaveLength(1);
      });
      expect((await logged('plugin.removed'))[0]?.payload).toEqual({
        plugin: 'echoer',
        version: '1.0.0',
      });
    });
  }, 60_000);
});
