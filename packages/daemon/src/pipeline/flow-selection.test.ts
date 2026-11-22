// SPDX-License-Identifier: MPL-2.0
import type { ScenarioRecord } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { selectFlow } from './flow-selection.js';
import { limitsOf } from './model-fixture.js';

function scenario(id: string, patch: Partial<ScenarioRecord> = {}): ScenarioRecord {
  return {
    id,
    kind: 'project',
    flowId: 'play',
    name: id,
    folder: '/work',
    profile: null,
    conventions: null,
    baseBranch: null,
    configOverride: {},
    originScenarioId: null,
    directorState: 'active',
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function deps(yaml: string, records: readonly ScenarioRecord[] = [scenario('s1')]) {
  const byId = new Map(records.map((record) => [record.id, record]));
  return {
    config: parseConfig(yaml),
    scenarios: { get: (id: string) => Promise.resolve(byId.get(id)) },
  };
}

const BASE = limitsOf('moderate');
const FLOWS = `
flows:
  quick:
    version: 1
    steps:
      plan_review: { enabled: false }
      critique: { limits: { critic_rejections: 1 } }
  strict:
    version: 1
    steps:
      execution: { limits: { attempts_per_demand: 5 } }
`;

describe('selectFlow', () => {
  it('runs the official play when no key names a flow, with the limits untouched', async () => {
    expect(await selectFlow(deps(''), 's1', BASE)).toEqual({
      ok: true,
      flow: undefined,
      limits: BASE,
    });
    expect(await selectFlow(deps(FLOWS), 's1', BASE)).toEqual({
      ok: true,
      flow: undefined,
      limits: BASE,
    });
    expect(await selectFlow(deps(`${FLOWS}\nscenario:\n  flow: play`), 's1', BASE)).toMatchObject({
      ok: true,
      flow: undefined,
    });
  });

  it('takes the flow of scenario.flow, with its steps off, its limits on top and a hash', async () => {
    const selection = await selectFlow(deps(`${FLOWS}\nscenario:\n  flow: quick`), 's1', BASE);
    if (!selection.ok || selection.flow === undefined) throw new Error('expected a flow');
    expect(selection.flow).toMatchObject({ id: 'quick', version: 1, skip: ['plan_review'] });
    expect(selection.flow.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(selection.limits).toEqual({ ...BASE, critic_rejections: 1 });
  });

  it('gives the same hash for the same content and another for another content', async () => {
    const hashOf = async (yaml: string) => {
      const selection = await selectFlow(deps(yaml), 's1', BASE);
      if (!selection.ok || selection.flow === undefined) throw new Error('expected a flow');
      return selection.flow.hash;
    };
    const quick = `${FLOWS}\nscenario:\n  flow: quick`;
    const reordered = `
scenario:
  flow: quick
flows:
  quick:
    steps:
      critique: { limits: { critic_rejections: 1 } }
      plan_review: { enabled: false }
    version: 1
`;
    const changed = quick.replace('critic_rejections: 1', 'critic_rejections: 2');
    expect(await hashOf(reordered)).toBe(await hashOf(quick));
    expect(await hashOf(changed)).not.toBe(await hashOf(quick));
  });

  it('lets the configOverride of the scenario win, the one it came from first', async () => {
    const yaml = `${FLOWS}\nscenario:\n  flow: quick`;
    const records = [
      scenario('project', { configOverride: { 'scenario.flow': 'strict' } }),
      scenario('task', { originScenarioId: 'project' }),
      scenario('nested', {
        originScenarioId: 'project',
        configOverride: { scenario: { flow: 'quick' } },
      }),
      scenario('back', { configOverride: { 'scenario.flow': 'play' } }),
    ];
    const idOf = async (scenarioId: string) => {
      const selection = await selectFlow(deps(yaml, records), scenarioId, BASE);
      if (!selection.ok) throw new Error(selection.message);
      return selection.flow?.id ?? 'play';
    };
    expect(await idOf('project')).toBe('strict');
    expect(await idOf('task')).toBe('strict');
    expect(await idOf('nested')).toBe('quick');
    expect(await idOf('back')).toBe('play');
    expect(await idOf('s1-unknown')).toBe('quick');
  });

  it('refuses a choice that names no flow, instead of falling back to the official play', async () => {
    const selection = await selectFlow(
      deps(FLOWS, [scenario('s1', { configOverride: { 'scenario.flow': 'ghost' } })]),
      's1',
      BASE,
    );
    expect(selection).toMatchObject({ ok: false });
    expect(selection.ok ? '' : selection.message).toContain('"ghost"');
    const wrongType = await selectFlow(
      deps(FLOWS, [scenario('s1', { configOverride: { scenario: { flow: 3 } } })]),
      's1',
      BASE,
    );
    expect(wrongType.ok ? '' : wrongType.message).toContain('scenario "s1" configOverride');
  });
});
