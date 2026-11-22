// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { FakeClock } from '@otheater/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureLogger } from '../test-helpers.js';
import { PluginAggregator } from './aggregate.js';
import { PluginProcessPool } from './process-pool.js';
import {
  DEFAULT_PLUGIN_RUNTIME,
  type PluginNotice,
  type PluginRuntimeConfig,
} from './runtime-config.js';
import { fixturePlugin, StaticPluginSource } from './test-plugin-fixture.js';

const stops: (() => Promise<void>)[] = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup(
  initial: Record<string, ReturnType<typeof fixturePlugin>[]>,
  runtime: Partial<PluginRuntimeConfig> = {},
  reserved: string[] = [],
) {
  const home = mkdtempSync(join(tmpdir(), 'ot-agg-'));
  homes.push(home);
  const clock = new FakeClock();
  const { logger, lines } = captureLogger();
  const source = new StaticPluginSource(initial);
  const notices: PluginNotice[] = [];
  const pool = new PluginProcessPool({
    clock,
    logger,
    runtime: () => ({ ...DEFAULT_PLUGIN_RUNTIME, startTimeoutMs: 20_000, ...runtime }),
    homeRoot: home,
    onNotice: (notice) => notices.push(notice),
  });
  const aggregator = new PluginAggregator({
    source,
    pool,
    logger,
    reservedNames: () => reserved,
    onNotice: (notice) => notices.push(notice),
  });
  stops.push(() => aggregator.stop());
  return { aggregator, pool, source, clock, lines, notices };
}

/** The notices about the tools, apart from those of the life of the process. */
const toolNotices = (notices: readonly PluginNotice[]): PluginNotice[] =>
  notices.filter((notice) => notice.kind.startsWith('tool_'));

const textOf = (result: CallToolResult): string =>
  result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

describe('PluginAggregator', () => {
  it('lists the declared tools by role, as <id>__<tool>, with the schema of the server', async () => {
    const { aggregator } = setup({ p1: [fixturePlugin()] });
    const snapshot = aggregator.snapshot('p1');
    const names = async (role: string): Promise<string[]> =>
      (await aggregator.tools(snapshot, role)).map((tool) => tool.name);
    expect(await names('author')).toEqual([
      'demo__echo',
      'demo__env_report',
      'demo__slow',
      'demo__crash',
      'demo__pid',
    ]);
    expect(await names('reviewer')).toEqual(['demo__echo']);
    expect(await names('critic')).toEqual(['demo__pid']);
    expect(await names('consultant')).toEqual([]);
    const echo = (await aggregator.tools(snapshot, 'reviewer'))[0];
    expect(echo?.inputSchema).toMatchObject({ type: 'object', properties: { text: {} } });
  });

  it('respects the allow-list of the policy of the role', async () => {
    const { aggregator } = setup({ p1: [fixturePlugin()] });
    const tools = await aggregator.tools(aggregator.snapshot('p1'), 'author', ['demo__echo']);
    expect(tools.map((tool) => tool.name)).toEqual(['demo__echo']);
  });

  it('a role that sees no tool of a plugin never starts it', async () => {
    const { aggregator, pool } = setup({ p1: [fixturePlugin()] });
    await aggregator.tools(aggregator.snapshot('p1'), 'consultant');
    expect(pool.running).toBe(0);
  });

  it('a project without active plugins has no tools', async () => {
    const { aggregator } = setup({ p1: [fixturePlugin()] });
    expect(await aggregator.tools(aggregator.snapshot('other'), 'author')).toEqual([]);
  });

  it('the call goes to the plugin and the result comes back', async () => {
    const { aggregator, pool } = setup({ p1: [fixturePlugin()] });
    const [echo] = await aggregator.tools(aggregator.snapshot('p1'), 'reviewer');
    if (echo === undefined) throw new Error('no echo');
    const result = await aggregator.call(echo, { text: 'ping' });
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toBe('echo:ping');
    expect(pool.running).toBe(1);
  });

  it('a tool error of the server comes back as the server gave it', async () => {
    const { aggregator } = setup({ p1: [fixturePlugin({ args: ['--no-exit'] })] });
    const tools = await aggregator.tools(aggregator.snapshot('p1'), 'author');
    const crash = tools.find((tool) => tool.name === 'demo__crash');
    if (crash === undefined) throw new Error('no crash');
    const result = await aggregator.call(crash, {});
    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toBe('failed');
  });

  it('a tool the server exposes and the manifest does not declare stays out, with a notice', async () => {
    const { aggregator, notices, lines } = setup({ p1: [fixturePlugin({ args: ['--extra'] })] });
    const tools = await aggregator.tools(aggregator.snapshot('p1'), 'author');
    expect(tools.map((tool) => tool.name)).not.toContain('demo__extra_tool');
    expect(toolNotices(notices)).toEqual([
      { kind: 'tool_not_declared', plugin: 'demo', project: 'p1', tool: 'extra_tool' },
    ]);
    expect(
      lines.some((line) => line.level === 'warn' && line.msg.includes('does not declare')),
    ).toBe(true);
  });

  it('a declared tool the server does not expose is unavailable, with a notice', async () => {
    const { aggregator, notices } = setup({ p1: [fixturePlugin({ args: ['--missing'] })] });
    const snapshot = aggregator.snapshot('p1');
    const tools = await aggregator.tools(snapshot, 'author');
    expect(tools.map((tool) => tool.name)).not.toContain('demo__echo');
    expect(tools.map((tool) => tool.name)).toContain('demo__pid');
    expect(toolNotices(notices)).toEqual([
      { kind: 'tool_not_exposed', plugin: 'demo', project: 'p1', tool: 'echo' },
    ]);
    // A call by a binding that was listed before the server changed answers `tool_unavailable`.
    const pid = tools.find((tool) => tool.name === 'demo__pid');
    if (pid === undefined) throw new Error('no pid');
    const missing = await aggregator.call(
      { ...pid, tool: { ...pid.tool, name: 'echo' } },
      { text: 'x' },
    );
    expect(missing).toMatchObject({
      isError: true,
      structuredContent: { error: 'tool_unavailable' },
    });
  });

  it('says it once per run of the process, not on every listing', async () => {
    const { aggregator, notices } = setup({ p1: [fixturePlugin({ args: ['--extra'] })] });
    await aggregator.tools(aggregator.snapshot('p1'), 'author');
    await aggregator.tools(aggregator.snapshot('p1'), 'author');
    expect(toolNotices(notices)).toHaveLength(1);
  });

  it('leaves out a tool whose name is too long or already taken, with a notice', async () => {
    const long = 'x'.repeat(60);
    const { aggregator, notices } = setup(
      { p1: [fixturePlugin(), fixturePlugin({ id: long })] },
      {},
      ['demo__echo'],
    );
    const tools = await aggregator.tools(aggregator.snapshot('p1'), 'author');
    expect(tools.map((tool) => tool.name)).not.toContain('demo__echo');
    expect(tools.some((tool) => tool.name.startsWith(long))).toBe(false);
    const reasons = notices
      .filter((notice) => notice.kind === 'tool_name_rejected')
      .map((notice) => `${notice.plugin === 'demo' ? 'demo' : 'long'}:${notice.reason}`);
    expect(reasons).toContain('demo:taken');
    expect(reasons).toContain('long:too_long');
  });

  it('a call that outlives plugins.call_timeout is a tool error, and the plugin stays available', async () => {
    const { aggregator, clock, pool } = setup(
      { p1: [fixturePlugin()] },
      { callTimeoutMs: 500, idleTimeoutMs: null },
    );
    const tools = await aggregator.tools(aggregator.snapshot('p1'), 'author');
    const slow = tools.find((tool) => tool.name === 'demo__slow');
    if (slow === undefined) throw new Error('no slow');
    const pending = aggregator.call(slow, { ms: 30_000 });
    await vi.waitFor(
      () => {
        expect(clock.pendingSleeps).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    await clock.advance(500);
    const result = await pending;
    expect(result).toMatchObject({ isError: true, structuredContent: { error: 'plugin_timeout' } });
    expect(pool.status('p1', 'demo').phase).toBe('running');
    const echo = tools.find((tool) => tool.name === 'demo__echo');
    if (echo === undefined) throw new Error('no echo');
    expect(textOf(await aggregator.call(echo, { text: 'after' }))).toBe('echo:after');
  });

  it('falls and returns: the crash is a tool error, the next call waits, then it is served again', async () => {
    const { aggregator, clock, pool, notices } = setup(
      { p1: [fixturePlugin()] },
      { idleTimeoutMs: null, maxRestarts: 3, restartBackoff: { initialMs: 1_000, maxMs: 4_000 } },
    );
    const tools = await aggregator.tools(aggregator.snapshot('p1'), 'author');
    const get = (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`no ${name}`);
      return tool;
    };
    const before = textOf(await aggregator.call(get('demo__pid'), {}));
    const crashed = await aggregator.call(get('demo__crash'), {});
    expect(crashed).toMatchObject({ isError: true });
    await vi.waitFor(() => {
      expect(pool.status('p1', 'demo').phase).toBe('stopped');
    });
    const refused = await aggregator.call(get('demo__pid'), {});
    expect(refused).toMatchObject({
      isError: true,
      structuredContent: { error: 'plugin_unavailable', retry_in_ms: 1_000 },
    });
    await clock.advance(1_000);
    const after = textOf(await aggregator.call(get('demo__pid'), {}));
    expect(after).not.toBe(before);
    expect(pool.status('p1', 'demo')).toMatchObject({ phase: 'running', failures: 0 });
    expect(notices.some((notice) => notice.kind === 'process_failed')).toBe(true);
  });

  it('stops for good after plugins.max_restarts failures in a row', async () => {
    const { aggregator, clock, pool, notices } = setup(
      { p1: [fixturePlugin({ args: ['--crash-on-start'] })] },
      { maxRestarts: 2, restartBackoff: { initialMs: 10, maxMs: 10 } },
    );
    const snapshot = aggregator.snapshot('p1');
    expect(await aggregator.tools(snapshot, 'author')).toEqual([]);
    expect(pool.status('p1', 'demo')).toMatchObject({ phase: 'stopped', failures: 1 });
    await clock.advance(10);
    // Another snapshot (a new session) tries again, and the second failure is the last.
    expect(await aggregator.tools(aggregator.snapshot('p1'), 'author')).toEqual([]);
    expect(pool.status('p1', 'demo').phase).toBe('given_up');
    expect(notices.filter((notice) => notice.kind === 'process_given_up')).toHaveLength(1);
    await clock.advance(60_000);
    expect(await aggregator.tools(aggregator.snapshot('p1'), 'author')).toEqual([]);
    expect(notices.filter((notice) => notice.kind === 'process_failed')).toHaveLength(1);
  });

  it('stops the process when it is idle, and lists from what it exposed without starting it', async () => {
    const { aggregator, clock, pool } = setup({ p1: [fixturePlugin()] }, { idleTimeoutMs: 1_000 });
    await aggregator.tools(aggregator.snapshot('p1'), 'author');
    expect(pool.running).toBe(1);
    await clock.advance(1_000);
    expect(pool.running).toBe(0);
    const again = await aggregator.tools(aggregator.snapshot('p1'), 'author');
    expect(again).toHaveLength(5);
    expect(pool.running).toBe(0);
    const echo = again.find((tool) => tool.name === 'demo__echo');
    if (echo === undefined) throw new Error('no echo');
    expect(textOf(await aggregator.call(echo, { text: 'back' }))).toBe('echo:back');
    expect(pool.running).toBe(1);
  });

  it('the process of a plugin does not see the environment of the daemon', async () => {
    vi.stubEnv('OTHEATER_DAEMON_SECRET', 'do-not-leak');
    try {
      const { aggregator } = setup({ p1: [fixturePlugin()] });
      const tools = await aggregator.tools(aggregator.snapshot('p1'), 'author');
      const report = tools.find((tool) => tool.name === 'demo__env_report');
      if (report === undefined) throw new Error('no env_report');
      const result = await aggregator.call(report, { name: 'OTHEATER_DAEMON_SECRET' });
      const body = JSON.parse(textOf(result)) as { keys: string[]; value: string | null };
      expect(body.value).toBeNull();
      expect(body.keys).not.toContain('OTHEATER_DAEMON_SECRET');
      expect(body.keys).toContain('HOME');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a session keeps its snapshot; a new one sees the plugin activated meanwhile', async () => {
    const { aggregator, source } = setup({ p1: [] });
    const first = aggregator.snapshot('p1');
    source.set('p1', [fixturePlugin()]);
    expect(await aggregator.tools(first, 'author')).toEqual([]);
    expect((await aggregator.tools(aggregator.snapshot('p1'), 'author')).length).toBe(5);
  });

  it('stops the process of a plugin that is deactivated', async () => {
    const { aggregator, source, pool } = setup({ p1: [fixturePlugin()] });
    await aggregator.tools(aggregator.snapshot('p1'), 'author');
    expect(pool.running).toBe(1);
    source.set('p1', []);
    await vi.waitFor(() => {
      expect(pool.running).toBe(0);
    });
  });

  it('a call by a plugin whose process cannot start is a tool error, never a rejection', async () => {
    const { aggregator } = setup({ p1: [fixturePlugin()] }, { maxRestarts: 1 });
    const [echo] = await aggregator.tools(aggregator.snapshot('p1'), 'reviewer');
    if (echo === undefined) throw new Error('no echo');
    const broken = fixturePlugin({ args: ['--crash-on-start'], hash: 'broken' });
    const result = await aggregator.call({ ...echo, plugin: broken }, { text: 'x' });
    expect(result).toMatchObject({ isError: true });
  });
});
