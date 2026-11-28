// SPDX-License-Identifier: MPL-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginAggregator } from '../plugins/aggregate.js';
import { PluginProcessPool } from '../plugins/process-pool.js';
import { DEFAULT_PLUGIN_RUNTIME } from '../plugins/runtime-config.js';
import { fixturePlugin, StaticPluginSource } from '../plugins/test-plugin-fixture.js';
import { captureLogger } from '../test-helpers.js';
import { createPluginToolCaller, toolResultOf } from './plugin-tool-caller.js';

const stops: (() => Promise<void>)[] = [];
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'ot-wf-caller-'));
  homes.push(home);
  const { logger } = captureLogger();
  const pool = new PluginProcessPool({
    clock: new FakeClock(),
    logger,
    runtime: () => ({ ...DEFAULT_PLUGIN_RUNTIME, startTimeoutMs: 20_000 }),
    homeRoot: home,
    onNotice: () => undefined,
  });
  const aggregator = new PluginAggregator({
    source: new StaticPluginSource({ p1: [fixturePlugin()] }),
    pool,
    logger,
    reservedNames: () => [],
    onNotice: () => undefined,
  });
  stops.push(() => aggregator.stop());
  return createPluginToolCaller(aggregator);
}

describe('toolResultOf', () => {
  it('takes the structured content when there is one, else the text', () => {
    expect(toolResultOf({ structuredContent: { a: 1 }, content: [] })).toEqual({
      ok: true,
      result: { a: 1 },
    });
    expect(
      toolResultOf({
        content: [
          { type: 'text', text: 'one' },
          { type: 'image', data: 'x' },
          { type: 'text', text: 'two' },
        ],
      }),
    ).toEqual({ ok: true, result: 'one\ntwo' });
    expect(toolResultOf({})).toEqual({ ok: true, result: '' });
  });

  it('an error carries the code the tool gave, or tool_error', () => {
    expect(
      toolResultOf({ isError: true, structuredContent: { error: 'plugin_timeout' }, content: [] }),
    ).toEqual({ ok: false, result: { error: 'plugin_timeout' }, code: 'plugin_timeout' });
    expect(toolResultOf({ isError: true, content: [{ type: 'text', text: 'boom' }] })).toEqual({
      ok: false,
      result: 'boom',
      code: 'tool_error',
    });
  });
});

describe('createPluginToolCaller', () => {
  it('finds a tool by its public name, with its effects, and calls it in the plugin process', async () => {
    const caller = setup();
    const ref = caller.find('p1', 'demo__echo');
    expect(ref).toMatchObject({ plugin: 'demo', tool: 'echo', effects: 'read' });
    if (ref === undefined) throw new Error('tool not found');
    const result = await caller.call('p1', ref, { text: 'hi' }, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.result)).toContain('echo:hi');
  });

  it('does not find a tool of another project or a name that does not exist', () => {
    const caller = setup();
    expect(caller.find('other', 'demo__echo')).toBeUndefined();
    expect(caller.find('p1', 'demo__nothing')).toBeUndefined();
  });

  it('a reference this caller did not hand out is tool_unavailable, not an exception', async () => {
    const caller = setup();
    const result = await caller.call(
      'p1',
      { plugin: 'demo', tool: 'echo', effects: 'read' },
      {},
      new AbortController().signal,
    );
    expect(result).toMatchObject({ ok: false, code: 'tool_unavailable' });
  });
});
