// SPDX-License-Identifier: MPL-2.0
import { buildRegistries, officialRegistryEntries } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { DAEMON_EVENT_DEFINITIONS, DAEMON_EVENT_TYPES, isDaemonEventType } from './events.js';

describe('the event types of the daemon, derived from the registry definitions', () => {
  it('export the same 80 names, in the same order, from the definitions', () => {
    expect(Object.keys(DAEMON_EVENT_TYPES)).toEqual(DAEMON_EVENT_DEFINITIONS.map((d) => d.type));
    expect(DAEMON_EVENT_DEFINITIONS).toHaveLength(80);
    for (const definition of DAEMON_EVENT_DEFINITIONS) {
      const entry = DAEMON_EVENT_TYPES[definition.type];
      expect(entry.schemaVersion).toBe(definition.schemaVersion);
      expect(entry.payload).toBe(definition.payload);
      expect(isDaemonEventType(definition.type)).toBe(true);
    }
  });

  it('build a valid event registry together with the official entries of core', () => {
    const registries = buildRegistries(officialRegistryEntries(DAEMON_EVENT_DEFINITIONS));
    expect(registries.events.keys()).toEqual(Object.keys(DAEMON_EVENT_TYPES));
    expect(
      registries.events.checkEvent('daemon.stopped', 1, { reason: 'signal', uptimeMs: 1 }).ok,
    ).toBe(true);
    expect(
      registries.events.checkEvent('daemon.stopped', 1, { reason: 'bad', uptimeMs: 1 }).ok,
    ).toBe(false);
  });
});
