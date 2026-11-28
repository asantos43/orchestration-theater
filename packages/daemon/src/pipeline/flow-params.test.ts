// SPDX-License-Identifier: MPL-2.0
import { parseFlowConfig } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { PLAY_SKIPPABLE_STEPS, playDefinition } from '../workflows/definitions/play-definition.js';
import { flowRefOf, flowsAsPlayParams, playParamsOfFlow } from './flow-selection.js';
import { Model, limitsOf } from './model-fixture.js';

/**
 * Phase 11b, P3 (N243): `flows.<id>` is the parameter `skip` of the `play` 2.0, with the effect it
 * always had. The play keeps `skip` in its context and the guards of the machine read it.
 */

const YAML = `
flows:
  quick:
    version: 1
    steps:
      plan_review: { enabled: false }
      critique: { enabled: false, limits: {} }
  light:
    version: 1
    steps:
      plan_review: { enabled: false }
      execution: { limits: { attempts_per_demand: 5 } }
`;

function resolved(id: string) {
  const config = parseConfig(YAML);
  const result = parseFlowConfig(id, config.flows[id], []);
  if (!result.ok) throw new Error('flow does not validate');
  return result.flow;
}

describe('flows.<id> as the parameters of the play 2.0', () => {
  it('shows the flow as the play with skip and the limits it sets', () => {
    expect(playParamsOfFlow(resolved('quick'))).toEqual({
      workflow: 'play',
      params: { skip: ['plan_review', 'critique'], limits: {} },
    });
    expect(playParamsOfFlow(resolved('light'))).toEqual({
      workflow: 'play',
      params: { skip: ['plan_review'], limits: { attempts_per_demand: 5 } },
    });
  });

  it('lists every flow of the configuration in the new form', () => {
    expect(Object.keys(flowsAsPlayParams(parseConfig(YAML).flows)).sort()).toEqual([
      'light',
      'quick',
    ]);
    expect(flowsAsPlayParams({})).toEqual({});
  });

  it('only skips steps that the definition lets skip', () => {
    for (const flow of [resolved('quick'), resolved('light')]) {
      for (const step of playParamsOfFlow(flow).params.skip) {
        expect(PLAY_SKIPPABLE_STEPS).toContain(step);
      }
    }
    const input = playDefinition().definition.inputs?.skip;
    expect(input).toMatchObject({ default: [] });
  });

  it('keeps the reference of the play the same as the skip of the parameters', () => {
    const flow = resolved('quick');
    expect(flowRefOf(flow).skip).toEqual([...playParamsOfFlow(flow).params.skip]);
  });

  it('has the same effect on the machine as before: the skipped steps are left out', () => {
    const ref = flowRefOf(resolved('quick'));
    const model = new Model(limitsOf('moderate'), 'a need', ref);
    model.send({ type: 'START' });
    model.send({ type: 'PLAN_SUBMITTED', hasOpenQuestions: false });
    expect(model.state).toBe('SCRIPTING');
    model.send({ type: 'SCRIPT_VALIDATED', valid: true, demandIds: ['d1'] });
    model.send({ type: 'SCRIPT_REVIEWED', approved: true });
    model.send({ type: 'DEMAND_APPROVED', demandId: 'd1' });
    expect(model.state).toBe('INTEGRATING');
    model.send({ type: 'INTEGRATED', ok: true });
    expect(model.state).toBe('DELIVERING');
  });
});
