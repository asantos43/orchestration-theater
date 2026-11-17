// SPDX-License-Identifier: MPL-2.0
import type { JsonObject } from '@otheater/core';
import { InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import {
  ATTEMPT_ID,
  PLAY_ID,
  makeToolsRig,
  realClock,
  type ToolsRig,
} from '../tools/tools-fixture.js';
import { browserOverrideOf, effectiveProfile, resolveBrowserSettings } from './settings.js';

const rigs: ToolsRig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()));
});

async function rig(configOverride?: JsonObject): Promise<ToolsRig> {
  const made = await makeToolsRig(configOverride === undefined ? {} : { configOverride }, {
    store: new InMemoryStore({ clock: realClock }),
    clock: realClock,
  });
  rigs.push(made);
  return made;
}

const base = parseConfig('').browser;

describe('browserOverrideOf', () => {
  it('takes the keys about what the agent may do, under either spelling', () => {
    expect(browserOverrideOf({ browser: { domains: 'allowlist' } })).toEqual({
      domains: 'allowlist',
    });
    expect(browserOverrideOf({ 'browser.write_approval': 'always' })).toEqual({
      write_approval: 'always',
    });
    expect(browserOverrideOf({})).toEqual({});
  });

  it('refuses the keys of the machine and unknown values', () => {
    for (const bad of [
      { browser: { sandbox: false } },
      { browser: { max_instances: 9 } },
      { browser: { executable_path: '/x' } },
      { browser: { domains: 'everything' } },
    ]) {
      expect(() => browserOverrideOf(bad)).toThrow(/invalid/);
    }
  });
});

describe('resolveBrowserSettings', () => {
  it('is the global block when the scenario overrides nothing', async () => {
    const r = await rig();
    const got = await resolveBrowserSettings(base, r.store, ATTEMPT_ID, PLAY_ID);
    expect(got.config).toEqual(base);
    expect(got.playId).toBe(PLAY_ID);
    expect(got.scenario.id).toBe('s1');
  });

  it('applies the override of the scenario over the global block', async () => {
    const r = await rig({ browser: { write_approval: 'always', blocked_domains: ['x.test'] } });
    const got = await resolveBrowserSettings(base, r.store, ATTEMPT_ID, undefined);
    expect(got.config.write_approval).toBe('always');
    expect(got.config.blocked_domains).toEqual(['x.test']);
    expect(got.config.domains).toBe(base.domains);
  });

  it('refuses a call that is not tied to a scenario, and a broken override', async () => {
    const r = await rig();
    await expect(
      resolveBrowserSettings(base, r.store, 'no/such/attempt', undefined),
    ).rejects.toMatchObject({ code: 'no_scenario' });
    const broken = await rig({ browser: { read_max_chars: 0 } });
    await expect(
      resolveBrowserSettings(base, broken.store, ATTEMPT_ID, PLAY_ID),
    ).rejects.toMatchObject({ code: 'invalid_config' });
  });
});

describe('effectiveProfile', () => {
  it('runs shared and per_scenario as they are', () => {
    expect(effectiveProfile({ profile: 'shared', fallback: 'fail' })).toBe('shared');
    expect(effectiveProfile({ profile: 'per_scenario', fallback: 'fail' })).toBe('per_scenario');
  });

  it('extension falls to the shared profile only when browser.fallback says shared', () => {
    expect(effectiveProfile({ profile: 'extension', fallback: 'shared' })).toBe('shared');
    for (const fallback of ['wait', 'fail'] as const) {
      expect(() => effectiveProfile({ profile: 'extension', fallback })).toThrow(/extension/);
    }
  });

  it('import is refused in every fallback', () => {
    expect(() => effectiveProfile({ profile: 'import', fallback: 'shared' })).toThrow(/import/);
  });
});
