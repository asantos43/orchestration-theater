// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { chooseEdge, compileWorkflow } from './compile.js';
import { PLAY_WORKFLOW } from './definitions/play.js';
import { validateWorkflow, type ValidWorkflow } from './validate.js';

function play(): ValidWorkflow {
  const result = validateWorkflow(PLAY_WORKFLOW);
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result.workflow;
}

const inputs = { skip_plan_review: false, skip_critique: false };
const counts = {};

describe('the play as a definition', () => {
  it('validates with no error nor warning', () => {
    const result = validateWorkflow(PLAY_WORKFLOW);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('has the states of the machine of today and the counters of the moderate preset', () => {
    const workflow = play();
    expect(Object.keys(workflow.nodes)).toEqual([
      'planning',
      'clarifying',
      'reviewing_plan',
      'scripting',
      'reviewing_script',
      'executing',
      'integrating',
      'critiquing',
      'deciding',
      'delivering',
      'awaiting_producer',
    ]);
    expect(workflow.counters).toMatchObject({
      plan_reviews: 2,
      critic_rejections: 2,
      script_validations: 3,
      script_vetoes: 2,
      script_returns: 2,
      structural_restarts: 1,
    });
    expect(workflow.nodes.executing?.safePoint).toBe(false);
    expect(workflow.nodes.reviewing_plan?.role).toBe('reviewer');
  });

  it('walks the happy way', () => {
    const workflow = play();
    const walk: [string, unknown, string][] = [
      ['planning', { has_open_questions: false }, 'reviewing_plan'],
      ['reviewing_plan', { approved: true }, 'scripting'],
      ['scripting', { valid: true }, 'reviewing_script'],
      ['reviewing_script', { approved: true }, 'executing'],
      ['executing', { outcome: 'completed' }, 'integrating'],
      ['integrating', { ok: true }, 'critiquing'],
      ['critiquing', { approved: true }, 'delivering'],
      ['delivering', { outcome: 'delivered' }, 'done'],
    ];
    for (const [node, output, target] of walk) {
      expect(chooseEdge(workflow, node, { output, inputs, counts }).target, node).toBe(target);
    }
  });

  it('skips the optional steps by its inputs', () => {
    const workflow = play();
    const skip = { skip_plan_review: true, skip_critique: true };
    expect(
      chooseEdge(workflow, 'planning', {
        output: { has_open_questions: false },
        inputs: skip,
        counts,
      }).target,
    ).toBe('scripting');
    expect(
      chooseEdge(workflow, 'integrating', { output: { ok: true }, inputs: skip, counts }).target,
    ).toBe('delivering');
  });

  it('sends a used-up counter to the Producer, and the Producer choices are bounded', () => {
    const workflow = play();
    const rejected = { output: { approved: false }, inputs };
    expect(
      chooseEdge(workflow, 'reviewing_plan', { ...rejected, counts: { plan_reviews: 1 } }).target,
    ).toBe('planning');
    expect(
      chooseEdge(workflow, 'reviewing_plan', { ...rejected, counts: { plan_reviews: 2 } }),
    ).toMatchObject({
      kind: 'limit',
      target: 'awaiting_producer',
    });
    const choice = { output: { choice: 'script' }, inputs };
    expect(chooseEdge(workflow, 'awaiting_producer', { ...choice, counts: {} }).target).toBe(
      'scripting',
    );
    expect(
      chooseEdge(workflow, 'awaiting_producer', { ...choice, counts: { producer_rounds: 20 } })
        .target,
    ).toBe('cancelled');
    expect(
      chooseEdge(workflow, 'awaiting_producer', { output: { choice: 'cancel' }, inputs, counts })
        .target,
    ).toBe('cancelled');
  });

  it('compiles to a machine whose id carries the version', () => {
    const config = compileWorkflow(play());
    expect(config.id).toBe('play@2.0.0');
    expect(config.initial).toBe('planning');
  });
});
