// SPDX-License-Identifier: MPL-2.0
import { parseWorkflowYaml, PLAY_WORKFLOW } from '@otheater/workflows';
import { describe, expect, it } from 'vitest';
import { READY_WORKFLOWS } from './definitions/ready-workflows.js';
import { sampleOf, simulateWorkflow, type SimulateOptions } from './simulate.js';

const OPTIONS: SimulateOptions = { maxSteps: 50, onLimit: 'truncate' };

/** An issue is read, approved and answered; `read` is the node with the typed output. */
const LOOP = {
  id: 'loop',
  version: '1.0.0',
  engine: '>=1 <2',
  inputs: { issue: { type: 'number' } },
  limits: { redo: 2 },
  nodes: {
    read: { step: 'fetch_issue' },
    ask: { step: 'approval', params: { prompt: 'ok?' } },
    say: { step: 'notify', params: { message: 'done' } },
  },
  edges: [
    'read -> ask when output.state == "open"',
    'read -> done',
    { from: 'ask', to: 'read', when: 'not output.approved', limit: 'redo', on_limit: 'failed' },
    'ask -> say when output.approved',
    'say -> done',
  ],
};

describe('sampleOf', () => {
  it('makes the same value of each type every time', () => {
    expect(sampleOf('string')).toBe('');
    expect(sampleOf('number')).toBe(0);
    expect(sampleOf('boolean')).toBe(false);
    expect(sampleOf('unknown')).toBeNull();
    expect(sampleOf({ enum: ['b', 'a'] })).toBe('b');
    expect(sampleOf({ list: 'string' })).toEqual([]);
    expect(sampleOf({ object: { a: 'number', b: { enum: ['x'] } } })).toEqual({ a: 0, b: 'x' });
  });
});

describe('simulateWorkflow', () => {
  it('walks the first path with the made up outputs and lists what each node could cause', () => {
    const result = simulateWorkflow(LOOP, { ...OPTIONS, inputs: { issue: 7 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // fetch_issue gives state "open" (the first of its enum); the approval is `false` by default.
    expect(result.path.map((step) => `${step.node}>${step.to}`)).toEqual([
      'read>ask',
      'ask>read',
      'read>ask',
      'ask>read',
      'read>ask',
      'ask>failed',
    ]);
    expect(result.status).toBe('failed');
    expect(result.counts).toEqual({ redo: 2 });
    expect(result.path[0]).toMatchObject({
      step: 'fetch_issue',
      via: 'edge',
      effects: ['read_code_host'],
    });
    expect(result.path.at(-1)).toMatchObject({ via: 'limit', to: 'failed' });
  });

  it('follows the outputs the caller sets, by node and by visit', () => {
    const result = simulateWorkflow(LOOP, {
      ...OPTIONS,
      inputs: { issue: 7 },
      outputs: { ask: [{ approved: false }, { approved: true }] },
    });
    expect(result.ok && result.status).toBe('done');
    if (!result.ok) return;
    expect(result.path.map((step) => step.node)).toEqual(['read', 'ask', 'read', 'ask', 'say']);
    expect(result.counts).toEqual({ redo: 1 });
  });

  it('ends at once when a node is told to fail', () => {
    const result = simulateWorkflow(LOOP, { ...OPTIONS, inputs: { issue: 1 }, fail: ['ask'] });
    expect(result.ok && result.status).toBe('failed');
    if (!result.ok) return;
    expect(result.path.at(-1)).toMatchObject({ node: 'ask', via: 'step_failed', to: 'failed' });
  });

  it('stops at max_steps and says it was cut, or fails when on_limit is fail', () => {
    const cut = simulateWorkflow(LOOP, { maxSteps: 3, onLimit: 'truncate', inputs: { issue: 1 } });
    expect(cut.ok && cut.status).toBe('truncated');
    if (cut.ok) {
      expect(cut.path).toHaveLength(3);
      expect(cut.ended).toBe('ask');
    }
    const failed = simulateWorkflow(LOOP, { maxSteps: 3, onLimit: 'fail', inputs: { issue: 1 } });
    expect(failed).toMatchObject({ ok: false, reason: 'step_limit' });
  });

  it('refuses a definition that does not validate, naming the place', () => {
    const result = simulateWorkflow({ ...LOOP, start: 'nowhere' }, OPTIONS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid_definition');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('refuses inputs that do not fit and nodes the definition does not have', () => {
    expect(simulateWorkflow(LOOP, OPTIONS)).toMatchObject({ ok: false, reason: 'invalid_inputs' });
    expect(
      simulateWorkflow(LOOP, { ...OPTIONS, inputs: { issue: 1 }, fail: ['zzz'] }),
    ).toMatchObject({ ok: false, reason: 'invalid_outputs' });
  });

  it('walks the play to an end', () => {
    const play = simulateWorkflow(PLAY_WORKFLOW, OPTIONS);
    expect(play.ok).toBe(true);
  });

  it('walks the ready workflows with their inputs filled', () => {
    for (const ready of READY_WORKFLOWS) {
      const parsed = parseWorkflowYaml(ready.yaml);
      expect(parsed.ok, ready.id).toBe(true);
      if (!parsed.ok) continue;
      const declared =
        (parsed.value as { inputs?: Record<string, { type: unknown }> }).inputs ?? {};
      const inputs = Object.fromEntries(
        Object.entries(declared).map(([name, spec]) => [name, spec.type === 'number' ? 1 : 'x']),
      );
      const result = simulateWorkflow(parsed.value, { ...OPTIONS, inputs });
      expect(result.ok, ready.id).toBe(true);
    }
  });
});
