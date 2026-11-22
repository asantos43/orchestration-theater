// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { DAEMON_EVENT_TYPES } from './events.js';
import {
  PluginDisabledPayloadSchema,
  PluginEnabledPayloadSchema,
  PluginEventRejectedPayloadSchema,
  PluginInstalledPayloadSchema,
  PluginRemovedPayloadSchema,
  PluginServerFailedPayloadSchema,
  PluginServerStartedPayloadSchema,
  PluginServerStoppedPayloadSchema,
  PluginToolRejectedPayloadSchema,
} from './plugin-events.js';

const valid = {
  'plugin.installed': [
    PluginInstalledPayloadSchema,
    { plugin: 'pg', version: '1.0.0', update: false },
  ],
  'plugin.removed': [PluginRemovedPayloadSchema, { plugin: 'pg', version: '1.0.0' }],
  'plugin.enabled': [PluginEnabledPayloadSchema, { plugin: 'pg', project: 's1' }],
  'plugin.disabled': [
    PluginDisabledPayloadSchema,
    { plugin: 'pg', project: 's1', reason: 'needs_approval' },
  ],
  'plugin.server_started': [
    PluginServerStartedPayloadSchema,
    { plugin: 'pg', project: 's1', pid: 42 },
  ],
  'plugin.server_stopped': [
    PluginServerStoppedPayloadSchema,
    { plugin: 'pg', project: 's1', reason: 'idle' },
  ],
  'plugin.server_failed': [
    PluginServerFailedPayloadSchema,
    { plugin: 'pg', project: 's1', failures: 1, givenUp: false, retryInMs: 1000, reason: 'exit 3' },
  ],
  'plugin.tool_rejected': [
    PluginToolRejectedPayloadSchema,
    { plugin: 'pg', project: 's1', tool: 'extra', reason: 'not_declared' },
  ],
  'plugin.event_rejected': [
    PluginEventRejectedPayloadSchema,
    { plugin: 'pg', project: 's1', name: 'x', reason: 'too_large', bytes: 20000, limit: 16384 },
  ],
} as const;

describe('the plugin events of the daemon (P8)', () => {
  it.each(Object.entries(valid))(
    '%s is registered with a strict payload',
    (type, [schema, sample]) => {
      expect(DAEMON_EVENT_TYPES[type as keyof typeof DAEMON_EVENT_TYPES].payload).toBe(schema);
      expect(schema.parse(sample)).toEqual(sample);
      expect(schema.safeParse({ ...sample, extra: 1 }).success).toBe(false);
      expect(schema.safeParse({ ...sample, plugin: '' }).success).toBe(false);
    },
  );

  it('takes rate_limited with the limit, the window and the count dropped', () => {
    const sample = {
      plugin: 'pg',
      project: 's1',
      reason: 'rate_limited',
      limit: 100,
      windowMs: 10_000,
      dropped: 37,
    };
    expect(PluginEventRejectedPayloadSchema.parse(sample)).toEqual(sample);
    expect(PluginEventRejectedPayloadSchema.safeParse({ ...sample, dropped: 0 }).success).toBe(
      false,
    );
    expect(PluginEventRejectedPayloadSchema.safeParse({ ...sample, windowMs: 0 }).success).toBe(
      false,
    );
  });

  it('refuse a reason outside the list and leave the optional fields out', () => {
    expect(
      PluginToolRejectedPayloadSchema.safeParse({
        plugin: 'pg',
        project: 's1',
        tool: 't',
        reason: 'other',
      }).success,
    ).toBe(false);
    expect(
      PluginEventRejectedPayloadSchema.safeParse({ plugin: 'pg', project: 's1', reason: 'invalid' })
        .success,
    ).toBe(true);
    expect(
      PluginServerStartedPayloadSchema.safeParse({ plugin: 'pg', project: 's1' }).success,
    ).toBe(true);
  });
});
