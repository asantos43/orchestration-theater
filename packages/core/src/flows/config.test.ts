// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  canonicalFlowJson,
  describeFlowProblems,
  flowLimitOverrides,
  parseFlowConfig,
  parseFlowsConfig,
  skippedSteps,
} from './config.js';
import { FLOW_STEP_IDS, FLOW_STEPS, OPTIONAL_FLOW_STEP_IDS } from './steps.js';

function ok(id: string, input: unknown) {
  const result = parseFlowConfig(id, input);
  if (!result.ok) throw new Error(describeFlowProblems(result.problems));
  return result.flow;
}

function problems(id: string, input: unknown): string {
  const result = parseFlowConfig(id, input);
  if (result.ok) throw new Error('the flow was accepted');
  return describeFlowProblems(result.problems);
}

describe('the steps of the registry', () => {
  it('keeps the order of the play and turns only the review of the plan and the critique optional', () => {
    expect(FLOW_STEP_IDS[0]).toBe('planning');
    expect(FLOW_STEP_IDS.at(-1)).toBe('delivery');
    expect(OPTIONAL_FLOW_STEP_IDS).toEqual(['plan_review', 'critique']);
  });

  it('gives every limit key to exactly one step', () => {
    const owners = FLOW_STEP_IDS.flatMap((id) => FLOW_STEPS[id].limits);
    expect(new Set(owners).size).toBe(owners.length);
  });
});

describe('parseFlowConfig', () => {
  it('accepts the play with no change and spells out every step', () => {
    const flow = ok('plain', { version: 1 });
    expect(flow.steps.map((step) => step.id)).toEqual([...FLOW_STEP_IDS]);
    expect(flow.steps.every((step) => step.enabled)).toBe(true);
    expect(skippedSteps(flow)).toEqual([]);
    expect(flowLimitOverrides(flow)).toEqual({});
  });

  it('accepts a flow with no review of the plan, a lower limit and the role of the step', () => {
    const flow = ok('hotfix', {
      version: 1,
      description: 'small fixes',
      steps: {
        plan_review: { enabled: false },
        critique: { role: 'critic', limits: { critic_rejections: 1 } },
        execution: { limits: { attempts_per_demand: 2 } },
      },
    });
    expect(skippedSteps(flow)).toEqual(['plan_review']);
    expect(flowLimitOverrides(flow)).toEqual({ critic_rejections: 1, attempts_per_demand: 2 });
  });

  it('refuses to turn a mandatory step off, pointing at the field', () => {
    for (const step of ['planning', 'scripting', 'execution', 'integration', 'delivery']) {
      const text = problems('bad', { version: 1, steps: { [step]: { enabled: false } } });
      expect(text).toContain(`flows.bad.steps.${step}.enabled`);
      expect(text).toContain('mandatory');
    }
  });

  it('refuses a step that is not in the registry', () => {
    expect(problems('bad', { version: 1, steps: { lunch: { enabled: true } } })).toBe(
      'flows.bad.steps.lunch: "lunch" is not a step of the registry (steps: planning, clarifying, plan_review, scripting, script_review, execution, integration, critique, delivery)',
    );
  });

  it('refuses a role that is not the one of the step, so a flow releases no permission', () => {
    expect(problems('bad', { version: 1, steps: { execution: { role: 'critic' } } })).toContain(
      'flows.bad.steps.execution.role',
    );
    expect(problems('bad', { version: 1, steps: { delivery: { role: 'actor' } } })).toContain(
      'has no role',
    );
    expect(ok('same', { version: 1, steps: { execution: { role: 'actor' } } }).id).toBe('same');
  });

  it('refuses a permission or a tool: the format has no such field', () => {
    expect(problems('bad', { version: 1, permissions: 'allow' })).toContain(
      'flows.bad.permissions: is not a field of a flow',
    );
    expect(problems('bad', { version: 1, steps: { execution: { tools: ['x'] } } })).toContain(
      'flows.bad.steps.execution.tools',
    );
  });

  it('refuses a limit on a step that is off, on the wrong step or out of range', () => {
    expect(
      problems('bad', {
        version: 1,
        steps: { plan_review: { enabled: false, limits: { plan_reviews: 1 } } },
      }),
    ).toContain('flows.bad.steps.plan_review.limits.plan_reviews: "plan_review" is off');
    expect(
      problems('bad', { version: 1, steps: { critique: { limits: { plan_reviews: 1 } } } }),
    ).toContain('it belongs to "plan_review"');
    expect(
      problems('bad', { version: 1, steps: { execution: { limits: { attempts_per_demand: 0 } } } }),
    ).toContain('must be at least 1');
    expect(
      problems('bad', { version: 1, steps: { plan_review: { limits: { plan_reviews: -1 } } } }),
    ).toContain('flows.bad.steps.plan_review.limits.plan_reviews');
  });

  it('refuses a version other than 1 and an id of an official flow or with a dot', () => {
    expect(problems('bad', { version: 2 })).toContain('flows.bad.version');
    expect(problems('play', { version: 1 })).toContain('official flow');
    expect(problems('task.run', { version: 1 })).toContain('not a valid flow id');
    expect(problems('Bad', { version: 1 })).toContain('not a valid flow id');
    expect(ok('docs-only', { version: 1 }).id).toBe('docs-only');
  });

  it('reports every problem of every flow of the map together', () => {
    const result = parseFlowsConfig({
      a: { version: 1, steps: { planning: { enabled: false } } },
      b: { version: 1, steps: { delivery: { enabled: false } } },
      c: { version: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.map((problem) => problem.path)).toEqual([
        'flows.a.steps.planning.enabled',
        'flows.b.steps.delivery.enabled',
      ]);
    }
    expect(parseFlowsConfig(undefined)).toEqual({ ok: true, flows: new Map() });
  });
});

describe('canonicalFlowJson', () => {
  it('is the same for two spellings of the same flow and changes with the content', () => {
    const a = ok('x', { version: 1, steps: { plan_review: { enabled: false } } });
    const b = ok('x', {
      description: 'other words',
      steps: { plan_review: { enabled: false }, critique: { enabled: true } },
      version: 1,
    });
    const c = ok('x', { version: 1, steps: { critique: { enabled: false } } });
    expect(canonicalFlowJson(a)).toBe(canonicalFlowJson(b));
    expect(canonicalFlowJson(a)).not.toBe(canonicalFlowJson(c));
    expect(canonicalFlowJson(a)).not.toBe(
      canonicalFlowJson(ok('y', { version: 1, steps: { plan_review: { enabled: false } } })),
    );
  });
});
