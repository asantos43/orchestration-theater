// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { createActor, createMachine } from 'xstate';
import {
  chooseEdge,
  compileWorkflow,
  evaluateGuard,
  WORKFLOW_ACTIONS,
  WORKFLOW_EVENTS,
  WORKFLOW_GUARDS,
  type GuardRef,
  type MachineConfig,
} from './compile.js';
import type { WorkflowDefinition } from './definition.js';
import { PLAY_WORKFLOW } from './definitions/play.js';
import { validateWorkflow, type ValidWorkflow } from './validate.js';

const LOOP: WorkflowDefinition = {
  id: 'loop',
  version: '1.0.0',
  engine: '>=1 <2',
  inputs: { lenient: { type: 'boolean', default: false } },
  nodes: { read: { step: 'fetch_issue' }, check: { step: 'critique' } },
  edges: [
    'read -> check when output.state == "open"',
    'read -> cancelled when output.state == "closed"',
    'check -> done when output.approved or inputs.lenient',
    { from: 'check', to: 'read', limit: 'redo', on_limit: 'cancelled' },
  ],
  limits: { redo: 2 },
};

function valid(definition: WorkflowDefinition): ValidWorkflow {
  const result = validateWorkflow(definition);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.workflow;
}

interface Run {
  send(event: { type: string; output?: unknown }): void;
  state(): string;
  done(): boolean;
  counts: Record<string, number>;
  log: string[];
}

/**
 * The runtime of the daemon in small (P2): the guards are `evaluateGuard`, the actions count and
 * log. Here it is a test of the compiled config with the real XState.
 */
function run(workflow: ValidWorkflow, inputs: Record<string, unknown> = {}): Run {
  const counts: Record<string, number> = {};
  const log: string[] = [];
  const config = compileWorkflow(workflow);
  interface Args {
    readonly event: { readonly output?: unknown };
  }
  type Params = GuardRef['params'];
  const guard = (type: string) => (args: Args, params: Params) =>
    evaluateGuard(workflow, { type, params }, { output: args.event.output, inputs, counts });
  const text = (params: Params, key: string): string => String(params[key]);
  const implementations = {
    guards: {
      [WORKFLOW_GUARDS.edge]: guard(WORKFLOW_GUARDS.edge),
      [WORKFLOW_GUARDS.limitReached]: guard(WORKFLOW_GUARDS.limitReached),
    },
    actions: {
      [WORKFLOW_ACTIONS.count]: (_: unknown, params: Params) => {
        const limit = text(params, 'limit');
        counts[limit] = (counts[limit] ?? 0) + 1;
      },
      [WORKFLOW_ACTIONS.limitHit]: (_: unknown, params: Params) =>
        log.push(`limit ${text(params, 'limit')}`),
      [WORKFLOW_ACTIONS.noEdge]: (_: unknown, params: Params) =>
        log.push(`no edge ${text(params, 'node')}`),
      [WORKFLOW_ACTIONS.stepFailed]: (_: unknown, params: Params) =>
        log.push(`failed ${text(params, 'node')}`),
    },
  };
  // The config is plain data, typed by this package; XState takes it as its own config.
  const machine = createMachine(
    config as unknown as Parameters<typeof createMachine>[0],
    implementations as never,
  );
  const actor = createActor(machine).start();
  return {
    send: (event) => {
      actor.send(event);
    },
    state: () => JSON.stringify(actor.getSnapshot().value).replaceAll('"', ''),
    done: () => actor.getSnapshot().status === 'done',
    counts,
    log,
  };
}

const done = (output: unknown) => ({ type: WORKFLOW_EVENTS.stepDone, output });

describe('compileWorkflow', () => {
  it('gives a state per node with its meta, and the ends as final states', () => {
    const config: MachineConfig = compileWorkflow(valid(LOOP));
    expect(config.id).toBe('loop@1.0.0');
    expect(config.initial).toBe('read');
    expect(Object.keys(config.states)).toEqual(['read', 'check', 'done', 'cancelled', 'failed']);
    expect(config.states.check?.meta).toEqual({
      step: 'critique',
      role: 'critic',
      params: {},
      safePoint: true,
    });
    expect(config.states.done).toEqual({ type: 'final' });
    const check = config.states.check?.on?.[WORKFLOW_EVENTS.stepDone] ?? [];
    expect(check.map((t) => [t.target, t.guard?.type ?? null])).toEqual([
      ['done', WORKFLOW_GUARDS.edge],
      ['cancelled', WORKFLOW_GUARDS.limitReached],
      ['read', WORKFLOW_GUARDS.edge],
      ['failed', null],
    ]);
  });

  it('is the same for the same workflow', () => {
    expect(compileWorkflow(valid(LOOP))).toEqual(compileWorkflow(valid(LOOP)));
  });

  it('compiles the play', () => {
    const config = compileWorkflow(valid(PLAY_WORKFLOW));
    expect(() =>
      createMachine(config as unknown as Parameters<typeof createMachine>[0]),
    ).not.toThrow();
  });
});

describe('the compiled machine in XState', () => {
  it('follows the edges to the end', () => {
    const r = run(valid(LOOP));
    expect(r.state()).toBe('read');
    r.send(done({ state: 'open' }));
    expect(r.state()).toBe('check');
    r.send(done({ approved: true }));
    expect(r.state()).toBe('done');
    expect(r.done()).toBe(true);
  });

  it('reads the inputs of the run', () => {
    const r = run(valid(LOOP), { lenient: true });
    r.send(done({ state: 'open' }));
    r.send(done({ approved: false }));
    expect(r.state()).toBe('done');
  });

  it('counts a limited edge and goes to on_limit when it is used up', () => {
    const r = run(valid(LOOP), { lenient: false });
    for (let i = 0; i < 2; i += 1) {
      r.send(done({ state: 'open' }));
      r.send(done({ approved: false }));
      expect(r.state()).toBe('read');
    }
    expect(r.counts).toEqual({ redo: 2 });
    r.send(done({ state: 'open' }));
    r.send(done({ approved: false }));
    expect(r.state()).toBe('cancelled');
    expect(r.log).toEqual(['limit redo']);
  });

  it('fails when no edge matches the output, or when the step fails', () => {
    const r = run(valid(LOOP));
    r.send(done({ state: 'merged' }));
    expect(r.state()).toBe('failed');
    expect(r.log).toEqual(['no edge read']);
    const s = run(valid(LOOP));
    s.send({ type: WORKFLOW_EVENTS.stepFailed });
    expect(s.state()).toBe('failed');
    expect(s.log).toEqual(['failed read']);
  });

  it('cancels from any state', () => {
    const r = run(valid(LOOP));
    r.send(done({ state: 'open' }));
    r.send({ type: WORKFLOW_EVENTS.cancel });
    expect(r.state()).toBe('cancelled');
    expect(r.done()).toBe(true);
  });
});

describe('chooseEdge and evaluateGuard agree with the machine', () => {
  const workflow = valid(LOOP);
  const inputs = { lenient: false };

  it('takes the first edge that matches', () => {
    expect(
      chooseEdge(workflow, 'read', { output: { state: 'closed' }, inputs, counts: {} }),
    ).toMatchObject({
      kind: 'edge',
      target: 'cancelled',
    });
    expect(
      chooseEdge(workflow, 'read', { output: { state: 'merged' }, inputs, counts: {} }),
    ).toEqual({
      kind: 'none',
      target: 'failed',
    });
    expect(chooseEdge(workflow, 'nowhere', { output: {}, inputs, counts: {} }).kind).toBe('none');
  });

  it('turns a used-up limit into on_limit', () => {
    const scope = { output: { approved: false }, inputs, counts: { redo: 2 } };
    expect(chooseEdge(workflow, 'check', scope)).toMatchObject({
      kind: 'limit',
      target: 'cancelled',
    });
    const edge = workflow.nodes.check?.edges[1]?.index;
    expect(
      evaluateGuard(workflow, { type: WORKFLOW_GUARDS.limitReached, params: { edge } }, scope),
    ).toBe(true);
    expect(evaluateGuard(workflow, { type: WORKFLOW_GUARDS.edge, params: { edge } }, scope)).toBe(
      false,
    );
    expect(evaluateGuard(workflow, { type: 'other', params: { edge } }, scope)).toBe(false);
    expect(
      evaluateGuard(workflow, { type: WORKFLOW_GUARDS.edge, params: { edge: 99 } }, scope),
    ).toBe(false);
  });

  it('sends a limited edge with no on_limit to failed', () => {
    const def = {
      ...LOOP,
      edges: [...LOOP.edges.slice(0, 3), { from: 'check', to: 'read', limit: 'redo' }],
    };
    const w = valid(def);
    expect(
      chooseEdge(w, 'check', { output: { approved: false }, inputs, counts: { redo: 2 } }),
    ).toMatchObject({
      kind: 'limit',
      target: 'failed',
    });
  });
});
