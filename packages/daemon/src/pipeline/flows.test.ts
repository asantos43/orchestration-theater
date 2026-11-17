// SPDX-License-Identifier: MPL-2.0
import { buildRegistries, InvalidInput, type Registries } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { defaultRegistryEntries } from '../registries.js';
import { PLAY_FLOW_ID, PLAY_FLOW_VERSION } from './definitions.js';
import { PLAY_EVENT_DEFINITIONS } from './events.js';
import { assertPlayFlowLinked } from './flows.js';

const entries = defaultRegistryEntries();

function problemsOf(registries: Registries): string {
  try {
    assertPlayFlowLinked(registries);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidInput);
    return (error as Error).message;
  }
  throw new Error('the registries were accepted');
}

describe('assertPlayFlowLinked', () => {
  it('accepts the official registries', () => {
    expect(() => {
      assertPlayFlowLinked(buildRegistries(entries));
    }).not.toThrow();
  });

  it('the official flow entry matches the machine: same version, the roles it runs', () => {
    const flow = buildRegistries(entries).flows.get(PLAY_FLOW_ID);
    expect(flow?.version).toBe(PLAY_FLOW_VERSION);
    expect(flow?.roles).toEqual(expect.arrayContaining(['author', 'director', 'reviewer']));
  });

  it('refuses a registry whose flow has another version', () => {
    const registries = buildRegistries({
      ...entries,
      flows: entries.flows.map((flow) =>
        flow.id === PLAY_FLOW_ID ? { ...flow, version: PLAY_FLOW_VERSION + 1 } : flow,
      ),
    });
    expect(problemsOf(registries)).toMatch(/has version 2 and the machine is version 1/);
  });

  it('refuses a registry whose flow does not list a role the machine runs', () => {
    const registries = buildRegistries({
      ...entries,
      flows: entries.flows.map((flow) =>
        flow.id === PLAY_FLOW_ID
          ? { ...flow, roles: flow.roles.filter((role) => role !== 'reviewer') }
          : flow,
      ),
    });
    expect(problemsOf(registries)).toMatch(/role "reviewer"/);
  });

  it('refuses registries without the event types of the machine, and names each one', () => {
    const missing: string[] = PLAY_EVENT_DEFINITIONS.map((definition) => definition.type);
    const registries = buildRegistries({
      ...entries,
      events: entries.events.filter((definition) => !missing.includes(definition.type)),
    });
    const message = problemsOf(registries);
    for (const type of missing) expect(message).toContain(`events/${type}`);
  });

  it('refuses registries with no play flow at all', () => {
    const real = buildRegistries(entries);
    const without = { ...real, flows: { ...real.flows, get: () => undefined } } as Registries;
    expect(problemsOf(without)).toMatch(
      /flows\/play: the flow of the play machine is not registered/,
    );
  });

  it('lists every difference in one error', () => {
    const registries = buildRegistries({
      ...entries,
      flows: entries.flows.map((flow) =>
        flow.id === PLAY_FLOW_ID ? { ...flow, version: 7 } : flow,
      ),
      events: entries.events.filter((definition) => definition.type !== 'play.created'),
    });
    const message = problemsOf(registries);
    expect(message).toMatch(/version 7/);
    expect(message).toMatch(/events\/play\.created/);
  });
});
