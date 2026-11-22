// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { FakeClock } from '@otheater/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureLogger } from '../test-helpers.js';
import {
  PluginStartRefused,
  type PluginConnection,
  type PluginConnectSpec,
  type PluginConnector,
} from './mcp-client.js';
import { PluginCallError, PluginProcessPool, pluginEnvironment } from './process-pool.js';
import {
  DEFAULT_PLUGIN_RUNTIME,
  type PluginEventSink,
  type PluginNotice,
  type PluginRuntimeConfig,
} from './runtime-config.js';
import { fixturePlugin } from './test-plugin-fixture.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A connection the test drives: what it calls, when it dies, how long a call takes. */
class FakeConnection implements PluginConnection {
  readonly pid = 4242;
  calls: { name: string; args: Record<string, unknown> | undefined }[] = [];
  closed = false;
  hang = false;
  failCall = false;
  #listener: ((reason: string) => void) | undefined;
  #eventListener: ((params: unknown) => void) | undefined;
  constructor(readonly spec: PluginConnectSpec) {}
  listTools() {
    return Promise.resolve([
      { name: 'echo', inputSchema: { type: 'object' } },
      { name: 'pid', inputSchema: { type: 'object' } },
    ]);
  }
  callTool(
    name: string,
    args: Record<string, unknown> | undefined,
    options: { signal: AbortSignal },
  ): Promise<CallToolResult> {
    this.calls.push({ name, args });
    if (this.failCall) return Promise.reject(new Error('pipe closed'));
    if (!this.hang) return Promise.resolve({ content: [{ type: 'text', text: `ok:${name}` }] });
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  onUnexpectedClose(listener: (reason: string) => void): void {
    this.#listener = listener;
  }
  onEvent(listener: (params: unknown) => void): void {
    this.#eventListener = listener;
  }
  emit(params: unknown): void {
    this.#eventListener?.(params);
  }
  die(reason = 'exit 1'): void {
    this.closed = true;
    this.#listener?.(reason);
  }
}

function setup(
  runtime: Partial<PluginRuntimeConfig> = {},
  connect?: PluginConnector,
  onEvent?: PluginEventSink,
) {
  const home = mkdtempSync(join(tmpdir(), 'ot-pool-'));
  homes.push(home);
  const clock = new FakeClock();
  const { logger, lines } = captureLogger();
  const connections: FakeConnection[] = [];
  const notices: PluginNotice[] = [];
  const failNext: { error?: Error } = {};
  const pool = new PluginProcessPool({
    clock,
    logger,
    runtime: () => ({ ...DEFAULT_PLUGIN_RUNTIME, ...runtime }),
    homeRoot: home,
    onNotice: (notice) => notices.push(notice),
    ...(onEvent === undefined ? {} : { onEvent }),
    connector:
      connect ??
      ((spec) => {
        if (failNext.error !== undefined) {
          const error = failNext.error;
          return Promise.reject(error);
        }
        const connection = new FakeConnection(spec);
        connections.push(connection);
        return Promise.resolve(connection);
      }),
  });
  return { pool, clock, lines, connections, notices, failNext, home };
}

const plugin = fixturePlugin();

describe('PluginProcessPool, events (P8)', () => {
  it('hands the event notifications to the sink with the plugin and the project of the process', async () => {
    const heard: unknown[] = [];
    const { pool, connections } = setup({}, undefined, (event) => heard.push(event));
    await pool.ensure(plugin, 'p1');
    await pool.ensure(plugin, 'p2');
    connections[0]?.emit({ name: 'tick' });
    connections[1]?.emit({ name: 'tock', payload: { a: 1 } });
    expect(heard).toEqual([
      { plugin: 'demo', project: 'p1', params: { name: 'tick' } },
      { plugin: 'demo', project: 'p2', params: { name: 'tock', payload: { a: 1 } } },
    ]);
  });

  it('drops what a replaced process says and what comes after the pool stopped', async () => {
    const heard: unknown[] = [];
    const { pool, connections } = setup({}, undefined, (event) => heard.push(event));
    await pool.ensure(plugin, 'p1');
    const first = connections[0];
    await pool.ensure(fixturePlugin({ hash: 'another' }), 'p1');
    expect(connections).toHaveLength(2);
    first?.emit({ name: 'late' });
    expect(heard).toEqual([]);
    await pool.stop();
    connections[1]?.emit({ name: 'after' });
    expect(heard).toEqual([]);
  });

  it('survives a sink that throws, and tells the log', async () => {
    const { pool, connections, lines } = setup({}, undefined, () => {
      throw new Error('sink broke');
    });
    await pool.ensure(plugin, 'p1');
    expect(() => connections[0]?.emit({ name: 'tick' })).not.toThrow();
    expect(
      lines.some((line) => line.level === 'warn' && line.msg.includes('event sink failed')),
    ).toBe(true);
  });
});

describe('PluginProcessPool', () => {
  it('starts on the first use, once, and reuses the process', async () => {
    const { pool, connections, notices } = setup();
    expect(pool.running).toBe(0);
    const [a, b] = await Promise.all([pool.ensure(plugin, 'p1'), pool.ensure(plugin, 'p1')]);
    expect(a).toEqual(b);
    const result = await pool.call(plugin, 'p1', 'echo', { text: 'hi' });
    expect(result.content).toEqual([{ type: 'text', text: 'ok:echo' }]);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.calls).toEqual([{ name: 'echo', args: { text: 'hi' } }]);
    expect(pool.running).toBe(1);
    expect(notices.map((notice) => notice.kind)).toEqual(['process_started']);
    expect(pool.status('p1', 'demo')).toMatchObject({ phase: 'running', pid: 4242, generation: 1 });
  });

  it('keeps one process per project', async () => {
    const { pool, connections } = setup();
    await pool.ensure(plugin, 'p1');
    await pool.ensure(plugin, 'p2');
    expect(connections).toHaveLength(2);
    expect([...pool.projects()].sort()).toEqual(['p1', 'p2']);
  });

  it('gives the process a minimal environment and a home of its own', async () => {
    const { pool, connections, home } = setup();
    await pool.ensure(plugin, 'p1');
    const env = connections[0]?.spec.env ?? {};
    expect(Object.keys(env).sort()).toEqual(
      ['HOME', ...['PATH', 'LANG', 'TZ'].filter((key) => process.env[key] !== undefined)].sort(),
    );
    expect(env.HOME).toBe(join(home, 'demo', 'p1'));
    expect(env.HOME).not.toBe(process.env.HOME);
  });

  it('stops the process after plugins.idle_timeout without a use, and starts it again', async () => {
    const { pool, clock, connections, notices } = setup({ idleTimeoutMs: 1_000 });
    await pool.call(plugin, 'p1', 'echo', undefined);
    await clock.advance(999);
    expect(pool.running).toBe(1);
    await clock.advance(1);
    expect(pool.running).toBe(0);
    expect(connections[0]?.closed).toBe(true);
    expect(notices.at(-1)).toMatchObject({ kind: 'process_stopped', reason: 'idle' });
    await pool.call(plugin, 'p1', 'echo', undefined);
    expect(connections).toHaveLength(2);
    expect(pool.status('p1', 'demo').generation).toBe(2);
  });

  it('counts the idle time from the last use, not from the start', async () => {
    const { pool, clock } = setup({ idleTimeoutMs: 1_000 });
    await pool.call(plugin, 'p1', 'echo', undefined);
    await clock.advance(800);
    await pool.call(plugin, 'p1', 'echo', undefined);
    await clock.advance(800);
    expect(pool.running).toBe(1);
    await clock.advance(200);
    expect(pool.running).toBe(0);
  });

  it('does not stop a process that is in the middle of a call', async () => {
    const { pool, clock, connections } = setup({ idleTimeoutMs: 1_000, callTimeoutMs: 60_000 });
    await pool.ensure(plugin, 'p1');
    const connection = connections[0];
    if (connection === undefined) throw new Error('no connection');
    connection.hang = true;
    const pending = pool.call(plugin, 'p1', 'echo', undefined);
    pending.catch(() => undefined);
    await vi.waitFor(() => {
      expect(connection.calls).toHaveLength(1);
    });
    await clock.advance(5_000);
    expect(pool.running).toBe(1);
    await clock.advance(60_000);
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });

  it('lives until the daemon stops with idle_timeout off', async () => {
    const { pool, clock } = setup({ idleTimeoutMs: null });
    await pool.ensure(plugin, 'p1');
    await clock.advance(24 * 3_600_000);
    expect(pool.running).toBe(1);
    await pool.stop();
    expect(pool.running).toBe(0);
  });

  it('ends a call that outlives plugins.call_timeout, with the process still running', async () => {
    const { pool, clock, connections } = setup({ callTimeoutMs: 500 });
    await pool.ensure(plugin, 'p1');
    const connection = connections[0];
    if (connection === undefined) throw new Error('no connection');
    connection.hang = true;
    const pending = pool.call(plugin, 'p1', 'echo', undefined);
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.waitFor(() => {
      expect(connection.calls).toHaveLength(1);
    });
    await clock.advance(500);
    const error = await outcome;
    expect(error).toBeInstanceOf(PluginCallError);
    expect(error).toMatchObject({ code: 'timeout' });
    // A slow call is not a failure of the process.
    expect(pool.status('p1', 'demo')).toMatchObject({ phase: 'running', failures: 0 });
    connection.hang = false;
    await expect(pool.call(plugin, 'p1', 'echo', undefined)).resolves.toBeDefined();
  });

  it('cancels a call when the signal aborts', async () => {
    const { pool, connections } = setup();
    await pool.ensure(plugin, 'p1');
    const connection = connections[0];
    if (connection === undefined) throw new Error('no connection');
    connection.hang = true;
    const abort = new AbortController();
    const pending = pool.call(plugin, 'p1', 'echo', undefined, abort.signal);
    await vi.waitFor(() => {
      expect(connection.calls).toHaveLength(1);
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  describe('failures', () => {
    it('restarts after a wait that grows, and a use during the wait is refused at once', async () => {
      const { pool, clock, connections, notices } = setup({
        maxRestarts: 5,
        restartBackoff: { initialMs: 1_000, maxMs: 3_000 },
      });
      await pool.ensure(plugin, 'p1');
      connections[0]?.die('segfault');
      expect(pool.status('p1', 'demo')).toMatchObject({ phase: 'stopped', failures: 1 });
      const refused = await pool.ensure(plugin, 'p1').catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: 'unavailable', retryInMs: 1_000 });
      await clock.advance(1_000);
      await pool.ensure(plugin, 'p1');
      expect(connections).toHaveLength(2);
      // It dies again before any call went well: the wait doubles, then stops at the maximum.
      connections[1]?.die();
      await expect(pool.ensure(plugin, 'p1')).rejects.toMatchObject({ retryInMs: 2_000 });
      await clock.advance(2_000);
      await pool.ensure(plugin, 'p1');
      connections[2]?.die();
      await expect(pool.ensure(plugin, 'p1')).rejects.toMatchObject({ retryInMs: 3_000 });
      expect(notices.filter((notice) => notice.kind === 'process_failed')).toHaveLength(3);
      expect(notices.find((notice) => notice.kind === 'process_failed')).toMatchObject({
        reason: 'segfault',
        retryInMs: 1_000,
      });
    });

    it('stays stopped after plugins.max_restarts failures in a row, until it is reset', async () => {
      const { pool, clock, connections, notices, lines } = setup({ maxRestarts: 3 });
      for (let round = 0; round < 3; round += 1) {
        await clock.advance(60_000);
        await pool.ensure(plugin, 'p1');
        connections[round]?.die('boom');
      }
      expect(pool.status('p1', 'demo')).toMatchObject({ phase: 'given_up', failures: 3 });
      const given = notices.filter((notice) => notice.kind === 'process_given_up');
      expect(given).toEqual([
        { kind: 'process_given_up', plugin: 'demo', project: 'p1', failures: 3, reason: 'boom' },
      ]);
      expect(lines.some((line) => line.level === 'error' && line.msg.includes('given up'))).toBe(
        true,
      );
      await clock.advance(24 * 3_600_000);
      await expect(pool.ensure(plugin, 'p1')).rejects.toMatchObject({ code: 'unavailable' });
      expect(connections).toHaveLength(3);
      pool.reset('p1', 'demo');
      await pool.ensure(plugin, 'p1');
      expect(connections).toHaveLength(4);
    });

    it('a result of the server, even a tool error, sets the failures back to zero', async () => {
      const { pool, clock, connections } = setup({ maxRestarts: 2 });
      await pool.ensure(plugin, 'p1');
      connections[0]?.die();
      await clock.advance(1_000);
      await pool.call(plugin, 'p1', 'echo', undefined);
      expect(pool.status('p1', 'demo').failures).toBe(0);
      connections[1]?.die();
      await clock.advance(1_000);
      await pool.ensure(plugin, 'p1');
      expect(pool.status('p1', 'demo').phase).toBe('running');
    });

    it('counts a start that fails, and gives up at once on a start that cannot work', async () => {
      const { pool, clock, failNext, notices } = setup({ maxRestarts: 3 });
      failNext.error = new Error('spawn ENOENT');
      await expect(pool.ensure(plugin, 'p1')).rejects.toThrow(/did not start: spawn ENOENT/);
      expect(pool.status('p1', 'demo')).toMatchObject({ phase: 'stopped', failures: 1 });
      await clock.advance(1_000);
      failNext.error = new PluginStartRefused('plugins.http is off');
      await expect(pool.ensure(plugin, 'p1')).rejects.toMatchObject({ code: 'unavailable' });
      expect(pool.status('p1', 'demo').phase).toBe('given_up');
      expect(notices.map((notice) => notice.kind)).toEqual(['process_failed', 'process_given_up']);
    });

    it('max_restarts 0 gives up at the first failure', async () => {
      const { pool, connections } = setup({ maxRestarts: 0 });
      await pool.ensure(plugin, 'p1');
      connections[0]?.die();
      expect(pool.status('p1', 'demo').phase).toBe('given_up');
    });

    it('a call whose connection breaks is a `failed` call and a failure of the process', async () => {
      const { pool, connections } = setup();
      await pool.ensure(plugin, 'p1');
      const connection = connections[0];
      if (connection === undefined) throw new Error('no connection');
      connection.failCall = true;
      await expect(pool.call(plugin, 'p1', 'echo', undefined)).rejects.toMatchObject({
        code: 'failed',
      });
    });
  });

  describe('changes', () => {
    it('a plugin with a new manifest does not reuse the old process', async () => {
      const { pool, connections } = setup();
      await pool.ensure(plugin, 'p1');
      await pool.ensure(fixturePlugin({ hash: 'other' }), 'p1');
      expect(connections).toHaveLength(2);
      expect(connections[0]?.closed).toBe(true);
    });

    it('retain stops what is no longer active in the project, and nothing else', async () => {
      const { pool, connections, notices } = setup();
      const second = fixturePlugin({ id: 'other' });
      await pool.ensure(plugin, 'p1');
      await pool.ensure(second, 'p1');
      await pool.ensure(plugin, 'p2');
      await pool.retain('p1', [{ id: 'other', manifestHash: second.manifestHash }]);
      expect(connections.map((connection) => connection.closed)).toEqual([true, false, false]);
      expect(notices.at(-1)).toMatchObject({ kind: 'process_stopped', reason: 'inactive' });
      expect(pool.running).toBe(2);
    });

    it('known() gives what the server exposed, without starting it', async () => {
      const { pool, clock, connections } = setup({ idleTimeoutMs: 100 });
      expect(pool.known(plugin, 'p1')).toBeUndefined();
      await pool.ensure(plugin, 'p1');
      await clock.advance(100);
      expect(pool.running).toBe(0);
      expect(pool.known(plugin, 'p1')?.tools.map((tool) => tool.name)).toEqual(['echo', 'pid']);
      expect(pool.known(fixturePlugin({ hash: 'other' }), 'p1')).toBeUndefined();
      expect(connections).toHaveLength(1);
    });

    it('stop() refuses new starts', async () => {
      const { pool } = setup();
      await pool.ensure(plugin, 'p1');
      await pool.stop();
      await expect(pool.ensure(plugin, 'p1')).rejects.toMatchObject({ code: 'unavailable' });
      await pool.stop();
    });
  });

  it('a throw of the notice sink does not break the pool', async () => {
    const { logger, lines } = captureLogger();
    const pool = new PluginProcessPool({
      clock: new FakeClock(),
      logger,
      runtime: () => DEFAULT_PLUGIN_RUNTIME,
      homeRoot: mkdtempSync(join(tmpdir(), 'ot-pool-')),
      onNotice: () => {
        throw new Error('sink bug');
      },
      connector: (spec) => Promise.resolve(new FakeConnection(spec)),
    });
    homes.push();
    await expect(pool.ensure(plugin, 'p1')).resolves.toBeDefined();
    expect(lines.some((line) => line.msg.includes('notice sink failed'))).toBe(true);
    await pool.stop();
  });
});

describe('pluginEnvironment', () => {
  it('has PATH, LANG and TZ of the daemon, a HOME of its own, and nothing else', () => {
    const env = pluginEnvironment(
      '/plugin/home',
      {},
      {
        PATH: '/bin',
        LANG: 'C',
        TZ: 'UTC',
        HOME: '/home/someone',
        OTHEATER_TOKEN: 'secret',
        SHELL: '/bin/zsh',
      },
    );
    expect(env).toEqual({ PATH: '/bin', LANG: 'C', TZ: 'UTC', HOME: '/plugin/home' });
  });

  it('adds the extra variables (the secrets of P7) but never lets them replace the base', () => {
    const env = pluginEnvironment(
      '/h',
      { TOKEN: 'x', PATH: '/evil', HOME: '/evil' },
      { PATH: '/bin' },
    );
    expect(env).toEqual({ TOKEN: 'x', PATH: '/bin', HOME: '/h' });
  });
});
