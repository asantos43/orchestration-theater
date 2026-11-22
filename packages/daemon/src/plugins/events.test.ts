// SPDX-License-Identifier: MPL-2.0
import { type NewEvent } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { buildDaemonRegistries, defaultRegistryEntries, RegistryHolder } from '../registries.js';
import { captureLogger, RecordingSituations } from '../test-helpers.js';
import {
  createPluginEventHandler,
  LiveEventRegistry,
  pluginEventContributor,
  pluginEventType,
  recordPluginNotice,
  recordRegistryNotice,
} from './events.js';
import type { PluginNotice as RegistryNotice } from './registry.js';
import { DEFAULT_PLUGIN_RUNTIME, type PluginNotice } from './runtime-config.js';
import { fixturePlugin, StaticPluginSource } from './test-plugin-fixture.js';

describe('recordPluginNotice (the pool and the aggregator)', () => {
  const cases: readonly [PluginNotice, string, unknown][] = [
    [
      { kind: 'tool_not_declared', plugin: 'demo', project: 'p1', tool: 'extra' },
      'plugin.tool_rejected',
      { plugin: 'demo', project: 'p1', tool: 'extra', reason: 'not_declared' },
    ],
    [
      { kind: 'tool_not_exposed', plugin: 'demo', project: 'p1', tool: 'echo' },
      'plugin.tool_rejected',
      { plugin: 'demo', project: 'p1', tool: 'echo', reason: 'not_exposed' },
    ],
    [
      { kind: 'tool_name_rejected', plugin: 'demo', project: 'p1', tool: 'x', reason: 'too_long' },
      'plugin.tool_rejected',
      { plugin: 'demo', project: 'p1', tool: 'x', reason: 'name_too_long' },
    ],
    [
      { kind: 'tool_name_rejected', plugin: 'demo', project: 'p1', tool: 'x', reason: 'taken' },
      'plugin.tool_rejected',
      { plugin: 'demo', project: 'p1', tool: 'x', reason: 'name_taken' },
    ],
    [
      { kind: 'process_started', plugin: 'demo', project: 'p1', pid: 77 },
      'plugin.server_started',
      { plugin: 'demo', project: 'p1', pid: 77 },
    ],
    [
      { kind: 'process_started', plugin: 'demo', project: 'p1', pid: undefined },
      'plugin.server_started',
      { plugin: 'demo', project: 'p1' },
    ],
    [
      { kind: 'process_stopped', plugin: 'demo', project: 'p1', reason: 'idle' },
      'plugin.server_stopped',
      { plugin: 'demo', project: 'p1', reason: 'idle' },
    ],
    [
      {
        kind: 'process_failed',
        plugin: 'demo',
        project: 'p1',
        failures: 2,
        retryInMs: 2000,
        reason: 'exit 1',
      },
      'plugin.server_failed',
      {
        plugin: 'demo',
        project: 'p1',
        failures: 2,
        givenUp: false,
        retryInMs: 2000,
        reason: 'exit 1',
      },
    ],
    [
      { kind: 'process_given_up', plugin: 'demo', project: 'p1', failures: 3, reason: 'exit 1' },
      'plugin.server_failed',
      { plugin: 'demo', project: 'p1', failures: 3, givenUp: true, reason: 'exit 1' },
    ],
    [
      {
        kind: 'tool_refused',
        plugin: 'demo',
        project: 'p1',
        tool: 'add_note',
        role: 'critic',
        reason: 'not_allowed',
      },
      'plugin.tool_rejected',
      { plugin: 'demo', project: 'p1', tool: 'add_note', reason: 'not_allowed', role: 'critic' },
    ],
    [
      { kind: 'secret_missing', plugin: 'demo', project: 'p1', secrets: ['PG_URL', 'API_KEY'] },
      'plugin.secret_missing',
      { plugin: 'demo', project: 'p1', secrets: ['PG_URL', 'API_KEY'] },
    ],
  ];

  it.each(cases)('%j becomes %s', (notice, type, payload) => {
    const situations = new RecordingSituations();
    recordPluginNotice(situations, notice);
    expect(situations.recorded).toEqual([{ type, payload, correlation: { scenarioId: 'p1' } }]);
  });

  it('masks the secrets in the reason of a failure and never leaves it empty', () => {
    const situations = new RecordingSituations();
    recordPluginNotice(situations, {
      kind: 'process_failed',
      plugin: 'demo',
      project: 'p1',
      failures: 1,
      retryInMs: 1000,
      reason: 'cannot start: token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 refused',
    });
    recordPluginNotice(situations, {
      kind: 'process_given_up',
      plugin: 'demo',
      project: 'p1',
      failures: 3,
      reason: '',
    });
    const [failed, givenUp] = situations.of('plugin.server_failed') as { reason: string }[];
    expect(failed?.reason).not.toContain('sk-ant-api03');
    expect(givenUp?.reason).toBe('unknown');
  });
});

describe('recordRegistryNotice (`ot plugin ...`)', () => {
  it('turns installed, updated and removed into events with no project', () => {
    const situations = new RecordingSituations();
    const notices: RegistryNotice[] = [
      { kind: 'installed', id: 'demo', version: '1.0.0' },
      { kind: 'updated', id: 'demo', version: '1.1.0' },
      { kind: 'removed', id: 'demo', version: '1.1.0' },
    ];
    for (const notice of notices) recordRegistryNotice(situations, notice);
    expect(situations.recorded).toEqual([
      {
        type: 'plugin.installed',
        payload: { plugin: 'demo', version: '1.0.0', update: false },
        correlation: {},
      },
      {
        type: 'plugin.installed',
        payload: { plugin: 'demo', version: '1.1.0', update: true },
        correlation: {},
      },
      {
        type: 'plugin.removed',
        payload: { plugin: 'demo', version: '1.1.0' },
        correlation: {},
      },
    ]);
  });

  it('turns enabled, disabled and needs_approval into events of the project', () => {
    const situations = new RecordingSituations();
    recordRegistryNotice(situations, { kind: 'enabled', id: 'demo', project: 'p1' });
    recordRegistryNotice(situations, { kind: 'disabled', id: 'demo', project: 'p1' });
    recordRegistryNotice(situations, {
      kind: 'needs_approval',
      id: 'demo',
      projects: ['p1', 'p2'],
    });
    expect(situations.recorded).toEqual([
      {
        type: 'plugin.enabled',
        payload: { plugin: 'demo', project: 'p1' },
        correlation: { scenarioId: 'p1' },
      },
      {
        type: 'plugin.disabled',
        payload: { plugin: 'demo', project: 'p1', reason: 'producer' },
        correlation: { scenarioId: 'p1' },
      },
      {
        type: 'plugin.disabled',
        payload: { plugin: 'demo', project: 'p1', reason: 'needs_approval' },
        correlation: { scenarioId: 'p1' },
      },
      {
        type: 'plugin.disabled',
        payload: { plugin: 'demo', project: 'p2', reason: 'needs_approval' },
        correlation: { scenarioId: 'p2' },
      },
    ]);
  });

  it('leaves a broken folder to the log', () => {
    const situations = new RecordingSituations();
    recordRegistryNotice(situations, {
      kind: 'broken',
      id: 'demo',
      problem: 'plugin.yaml is gone',
    });
    expect(situations.recorded).toEqual([]);
  });
});

/** The sink of the situations with the raw events of the plugins the handler writes. */
class Recording extends RecordingSituations {
  readonly events: { event: NewEvent; scenarioId: string | undefined }[] = [];
  recordEvent(event: NewEvent, correlation: { scenarioId?: string | undefined } = {}): void {
    this.events.push({ event, scenarioId: correlation.scenarioId });
  }
}

function handlerSetup(runtime: Partial<typeof DEFAULT_PLUGIN_RUNTIME> = {}) {
  const situations = new Recording();
  const { logger, lines } = captureLogger();
  const source = new StaticPluginSource({
    p1: [fixturePlugin({ events: ['build.done', 'tick'] })],
  });
  const handle = createPluginEventHandler({
    source,
    runtime: () => ({ ...DEFAULT_PLUGIN_RUNTIME, ...runtime }),
    situations,
    logger,
  });
  const send = (params: unknown, plugin = 'demo', project = 'p1'): void => {
    handle({ plugin, project, params });
  };
  return { situations, lines, send, source };
}

describe('createPluginEventHandler', () => {
  it('writes a declared event as plugin.<id>.<name>, in the project of the plugin', () => {
    const { situations, send } = handlerSetup();
    send({ name: 'build.done', payload: { n: 1 } });
    send({ name: 'tick' });
    expect(situations.events).toEqual([
      {
        event: { type: 'plugin.demo.build.done', schemaVersion: 1, payload: { n: 1 } },
        scenarioId: 'p1',
      },
      { event: { type: 'plugin.demo.tick', schemaVersion: 1, payload: {} }, scenarioId: 'p1' },
    ]);
    expect(situations.recorded).toEqual([]);
  });

  it('refuses an event the manifest does not declare, with a warning and plugin.event_rejected', () => {
    const { situations, lines, send } = handlerSetup();
    send({ name: 'not.declared', payload: { secret: 'x' } });
    expect(situations.events).toEqual([]);
    expect(situations.of('plugin.event_rejected')).toEqual([
      { plugin: 'demo', project: 'p1', name: 'not.declared', reason: 'not_declared' },
    ]);
    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1);
    // What the plugin put in the payload is never copied into the rejection.
    expect(JSON.stringify(situations.recorded)).not.toContain('secret');
  });

  it('refuses a name with the prefix of the daemon', () => {
    const { situations, send } = handlerSetup();
    send({ name: 'plugin.demo.build.done' });
    expect(situations.events).toEqual([]);
    expect(situations.of('plugin.event_rejected')).toHaveLength(1);
  });

  it('refuses a payload over plugins.event_max_bytes, with the size and the limit', () => {
    const { situations, send } = handlerSetup({ eventMaxBytes: 100 });
    send({ name: 'tick', payload: { pad: 'x'.repeat(200) } });
    expect(situations.events).toEqual([]);
    expect(situations.of('plugin.event_rejected')).toEqual([
      { plugin: 'demo', project: 'p1', name: 'tick', reason: 'too_large', bytes: 210, limit: 100 },
    ]);
  });

  it('takes a payload exactly at the limit', () => {
    const { situations, send } = handlerSetup({ eventMaxBytes: 13 });
    send({ name: 'tick', payload: { a: 'bcdef' } });
    expect(situations.events).toHaveLength(1);
  });

  it.each([
    ['a string', 'build.done'],
    ['null', null],
    ['no name', { payload: {} }],
    ['a name that is not a string', { name: 4 }],
    ['a payload that is an array', { name: 'tick', payload: [1] }],
    ['a payload that is a scalar', { name: 'tick', payload: 3 }],
  ])('refuses %s as invalid', (_label, params) => {
    const { situations, send } = handlerSetup();
    send(params);
    expect(situations.events).toEqual([]);
    const rejected = situations.of('plugin.event_rejected') as { reason: string }[];
    expect(rejected.map((item) => item.reason)).toEqual(['invalid']);
  });

  it('refuses an event of a plugin that is not active in the project', () => {
    const { situations, send } = handlerSetup();
    send({ name: 'tick' }, 'demo', 'other-project');
    send({ name: 'tick' }, 'stranger', 'p1');
    expect(situations.events).toEqual([]);
    const rejected = situations.of('plugin.event_rejected') as { reason: string }[];
    expect(rejected.map((item) => item.reason)).toEqual(['inactive', 'inactive']);
  });

  it('refuses everything with plugins.events: off', () => {
    const { situations, send } = handlerSetup({ events: 'off' });
    send({ name: 'tick' });
    expect(situations.events).toEqual([]);
    expect(situations.of('plugin.event_rejected')).toEqual([
      { plugin: 'demo', project: 'p1', name: 'tick', reason: 'off' },
    ]);
  });

  it('cuts and masks the name it reports', () => {
    const { situations, send } = handlerSetup();
    send({ name: 'x'.repeat(500) });
    const [rejected] = situations.of('plugin.event_rejected') as { name: string }[];
    expect(rejected?.name.length).toBeLessThanOrEqual(128);
  });
});

describe('pluginEventContributor and LiveEventRegistry', () => {
  it('adds the types of the active plugins once, owned by their plugin', () => {
    const plugin = fixturePlugin({ events: ['build.done', 'tick'] });
    const entries = pluginEventContributor(
      new Map([
        ['p1', [plugin]],
        ['p2', [plugin]],
      ]),
    );
    expect(entries.events?.map((entry) => [entry.type, entry.plugin])).toEqual([
      ['plugin.demo.build.done', 'demo'],
      ['plugin.demo.tick', 'demo'],
    ]);
    expect(pluginEventContributor(new Map())).toEqual({ events: [] });
  });

  it('passes the validation of the registries next to the official types', () => {
    const holder = new RegistryHolder(buildDaemonRegistries(), { base: defaultRegistryEntries() });
    const before = holder.current().registries.events.size;
    holder.contribute(pluginEventContributor);
    holder.swap(new Map([['p1', [fixturePlugin({ events: ['build.done'] })]]]));
    const events = holder.current().registries.events;
    expect(events.size).toBe(before + 1);
    expect(events.checkEvent('plugin.demo.build.done', 1, { n: 1 }).ok).toBe(true);
    expect(events.checkEvent('plugin.demo.build.done', 1, { n: undefined, f: () => 1 }).ok).toBe(
      false,
    );
    expect(events.checkEvent('plugin.demo.other', 1, {}).ok).toBe(false);
    holder.swap(new Map());
    expect(holder.current().registries.events.has('plugin.demo.build.done')).toBe(false);
  });

  it('answers from the registry it is bound to', () => {
    const holder = new RegistryHolder(buildDaemonRegistries(), { base: defaultRegistryEntries() });
    holder.contribute(pluginEventContributor);
    const live = new LiveEventRegistry(holder.current().registries.events);
    live.bind(() => holder.current().registries.events);
    expect(live.checkEvent(pluginEventType('demo', 'tick'), 1, {}).ok).toBe(false);
    holder.swap(new Map([['p1', [fixturePlugin({ events: ['tick'] })]]]));
    expect(live.checkEvent(pluginEventType('demo', 'tick'), 1, {}).ok).toBe(true);
    expect(live.has('plugin.demo.tick')).toBe(true);
    expect(live.get('plugin.demo.tick')?.plugin).toBe('demo');
    expect(live.size).toBe(holder.current().registries.events.size);
    expect(live.keys()).toContain('plugin.demo.tick');
    expect(live.list().length).toBe(live.size);
    expect(live.parseEvent('plugin.demo.tick', 1, { a: 1 })).toEqual({ a: 1 });
  });
});
