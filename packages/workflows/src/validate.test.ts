// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from './definition.js';
import {
  engineInRange,
  formatPath,
  validateWorkflow,
  VALIDATION_CODES,
  type ValidateOptions,
} from './validate.js';

/** A small sound definition: read the issue, ask, comment, end. */
function base(): WorkflowDefinition {
  return {
    id: 'triage',
    version: '1.0.0',
    engine: '>=1 <2',
    inputs: { strict: { type: 'boolean', default: false } },
    nodes: {
      read: { step: 'fetch_issue' },
      ask: { step: 'approval', params: { prompt: 'Comment?' } },
      answer: { step: 'comment', params: { target: 'issue', body: 'Thanks' } },
    },
    edges: [
      'read -> ask when output.state == "open"',
      'read -> done',
      'ask -> answer when output.approved',
      'ask -> cancelled',
      'answer -> done',
    ],
  };
}

function codes(input: unknown, options?: ValidateOptions): string[] {
  const result = validateWorkflow(input, options);
  return result.errors.map((e) => e.code);
}

function errorsOf(input: unknown, options?: ValidateOptions) {
  return validateWorkflow(input, options).errors;
}

describe('validateWorkflow: what passes', () => {
  it('accepts a sound definition and resolves it', () => {
    const result = validateWorkflow(base());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { workflow } = result;
    expect(workflow.start).toBe('read');
    expect(workflow.nodes.read?.edges.map((e) => e.to)).toEqual(['ask', 'done']);
    expect(workflow.nodes.ask?.role).toBeNull();
    expect(workflow.nodes.answer?.params).toEqual({ target: 'issue', body: 'Thanks' });
    expect(workflow.edges[0]?.condition).toBeDefined();
  });

  it('gives the default role of a step type', () => {
    const def: WorkflowDefinition = {
      ...base(),
      nodes: { think: { step: 'plan' } },
      edges: ['think -> done'],
    };
    const result = validateWorkflow(def);
    expect(result.ok && result.workflow.nodes.think?.role).toBe('director');
  });

  it('accepts a bounded cycle and keeps the counters apart from the reserved limits', () => {
    const def: WorkflowDefinition = {
      ...base(),
      nodes: { read: { step: 'fetch_issue' }, check: { step: 'critique' } },
      edges: [
        'read -> check',
        'check -> done when output.approved',
        { from: 'check', to: 'read', limit: 'redo' },
      ],
      limits: { redo: 2, budget_usd: 5, max_duration: '4h', max_steps: 50 },
    };
    const result = validateWorkflow(def);
    expect(result.errors).toEqual([]);
    expect(result.ok && result.workflow.counters).toEqual({ redo: 2 });
  });

  it('warns about a limit no edge uses', () => {
    const result = validateWorkflow({ ...base(), limits: { spare: 3 } });
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      {
        path: 'limits.spare',
        segments: ['limits', 'spare'],
        code: 'unused_limit',
        message: 'no edge has limit spare',
      },
    ]);
  });

  it('reads the YAML form of an edge with a condition', () => {
    const def = {
      ...base(),
      edges: [{ 'read -> ask when': 'output.state == "open"' }, ...base().edges.slice(1)],
    };
    expect(codes(def)).toEqual([]);
  });
});

describe('validateWorkflow: one failure per code', () => {
  const cases: [string, (d: WorkflowDefinition) => unknown, ValidateOptions?][] = [
    ['schema', (d) => ({ ...d, version: 'one' })],
    ['engine', (d) => ({ ...d, engine: '>=2' })],
    ['start', (d) => ({ ...d, start: 'nowhere' })],
    ['input_default', (d) => ({ ...d, inputs: { strict: { type: 'boolean', default: 'yes' } } })],
    ['unknown_step', (d) => ({ ...d, nodes: { ...d.nodes, read: { step: 'teleport' } } })],
    [
      'unknown_role',
      (d) => ({ ...d, nodes: { ...d.nodes, read: { step: 'plan', role: 'wizard' } } }),
    ],
    [
      'role_not_allowed',
      (d) => ({ ...d, nodes: { ...d.nodes, read: { step: 'plan', role: 'critic' } } }),
    ],
    [
      'params',
      (d) => ({
        ...d,
        nodes: { ...d.nodes, answer: { step: 'comment', params: { target: 'wall' } } },
      }),
    ],
    ['unknown_source', (d) => ({ ...d, edges: [...d.edges, 'ghost -> done'] })],
    ['unknown_target', (d) => ({ ...d, edges: ['read -> nowhere', ...d.edges] })],
    ['shadowed_edge', (d) => ({ ...d, edges: ['read -> done', ...d.edges] })],
    [
      'no_out_edge',
      (d) => ({
        ...d,
        edges: d.edges.filter((e) => typeof e !== 'string' || !e.startsWith('answer')),
      }),
    ],
    [
      'condition_syntax',
      (d) => ({ ...d, edges: ['read -> ask when output.state ==', ...d.edges.slice(1)] }),
    ],
    [
      'condition_type',
      (d) => ({ ...d, edges: ['read -> ask when output.state == "lost"', ...d.edges.slice(1)] }),
    ],
    [
      'unknown_limit',
      (d) => ({ ...d, edges: [{ from: 'read', to: 'ask', limit: 'nope' }, ...d.edges.slice(1)] }),
    ],
    [
      'unreachable',
      (d) => ({
        ...d,
        nodes: { ...d.nodes, lost: { step: 'notify', params: { message: 'hi' } } },
        edges: [...d.edges, 'lost -> done'],
      }),
    ],
    [
      'no_terminal',
      (d) => ({
        ...d,
        nodes: { ...d.nodes, spin: { step: 'branch' } },
        edges: [
          ...d.edges.slice(0, 3),
          'ask -> spin',
          { from: 'spin', to: 'spin', limit: 'turns' },
          'answer -> done',
        ],
        limits: { turns: 3 },
      }),
    ],
    [
      'unbounded_cycle',
      (d) => ({
        ...d,
        edges: [
          'read -> ask when output.state == "open"',
          'read -> done',
          'ask -> answer when output.approved',
          'ask -> read',
          'answer -> done',
        ],
      }),
    ],
    [
      'unknown_trigger',
      (d) => ({ ...d, triggers: [{ type: 'carrier_pigeon' }] }),
      { triggerTypes: ['issue.labeled'] },
    ],
    [
      'missing_plugin',
      (d) => ({ ...d, requires: { plugins: ['github'] } }),
      { installed: { plugins: [] } },
    ],
    [
      'missing_tool',
      (d) => ({ ...d, requires: { tools: ['lint'] } }),
      { installed: { tools: [] } },
    ],
    [
      'approval_missing',
      (d) => ({
        ...d,
        edges: [
          'read -> answer when output.state == "open"',
          'read -> done',
          'ask -> answer',
          'answer -> done',
        ],
      }),
    ],
  ];

  it('covers every code', () => {
    expect(cases.map(([code]) => code).sort()).toEqual([...VALIDATION_CODES].sort());
  });

  it.each(cases)('%s', (code, change, options) => {
    expect(codes(change(base()), options)).toContain(code);
  });
});

describe('validateWorkflow: the details', () => {
  it('points at the place in the document', () => {
    const def = {
      ...base(),
      edges: ['read -> ask when output.state == "lost"', ...base().edges.slice(1)],
    };
    expect(errorsOf(def)).toEqual([
      {
        path: 'edges[0].when',
        segments: ['edges', 0, 'when'],
        code: 'condition_type',
        message: 'output.state: "lost" is not one of open, closed',
      },
    ]);
    const params = errorsOf({
      ...base(),
      nodes: { ...base().nodes, answer: { step: 'comment', params: { target: 'wall' } } },
    });
    expect(params[0]?.path).toBe('nodes.answer.params.target');
  });

  it('says that no edge leaves an end', () => {
    expect(errorsOf({ ...base(), edges: [...base().edges, 'done -> read'] })[0]?.message).toBe(
      'done is an end: no edge leaves it',
    );
  });

  it('reserves the ends as node ids', () => {
    const errors = errorsOf({ ...base(), nodes: { ...base().nodes, done: { step: 'branch' } } });
    expect(errors.map((e) => [e.code, e.path])).toEqual([['schema', 'nodes.done']]);
  });

  it('refuses a step that takes no role and names one', () => {
    const errors = errorsOf({
      ...base(),
      nodes: { ...base().nodes, read: { step: 'fetch_issue', role: 'critic' } },
    });
    expect(errors.map((e) => e.message)).toEqual(['fetch_issue takes no role']);
  });

  it('refuses a reserved limit or on_limit without a limit on an edge', () => {
    const reserved = errorsOf({
      ...base(),
      edges: [{ from: 'read', to: 'ask', limit: 'budget_usd' }, ...base().edges.slice(1)],
      limits: { budget_usd: 3 },
    });
    expect(reserved.map((e) => e.message)).toContain('budget_usd is not a loop counter');
    const lonely = errorsOf({
      ...base(),
      edges: [{ from: 'read', to: 'ask', on_limit: 'done' }, ...base().edges.slice(1)],
    });
    expect(lonely.map((e) => e.message)).toContain('on_limit without a limit');
  });

  it('refuses bad limit values', () => {
    const errors = errorsOf({
      ...base(),
      limits: { redo: 0, budget_usd: -1, max_duration: '4 hours' },
    });
    expect(errors.map((e) => e.path).sort()).toEqual([
      'limits.budget_usd',
      'limits.max_duration',
      'limits.redo',
    ]);
  });

  it('counts the way to on_limit as unbounded in a cycle', () => {
    const def: WorkflowDefinition = {
      ...base(),
      nodes: { a: { step: 'critique' }, b: { step: 'branch' }, c: { step: 'branch' } },
      edges: [
        'a -> done when output.approved',
        { from: 'a', to: 'b', limit: 'x', on_limit: 'c' },
        'b -> a',
        'c -> a',
      ],
      limits: { x: 2 },
    };
    const errors = errorsOf(def);
    expect(errors.map((e) => e.code)).toEqual(['unbounded_cycle']);
    expect(errors[0]?.message).toBe('the cycle a -> c -> a has no edge with a limit');
  });

  it('reports a self loop with no limit', () => {
    const def: WorkflowDefinition = {
      ...base(),
      nodes: { a: { step: 'critique' } },
      edges: ['a -> done when output.approved', 'a -> a'],
    };
    expect(errorsOf(def).map((e) => e.message)).toEqual([
      'the cycle a -> a has no edge with a limit',
    ]);
  });

  it('checks the tool of call_tool against what is installed', () => {
    const def: WorkflowDefinition = {
      ...base(),
      nodes: { run: { step: 'call_tool', params: { tool: 'lint' } } },
      edges: ['run -> done when output.ok', 'run -> failed'],
    };
    expect(codes(def)).toEqual([]);
    expect(codes(def, { installed: { tools: ['lint'] } })).toEqual([]);
    expect(errorsOf(def, { installed: { tools: [] } }).map((e) => e.path)).toEqual([
      'nodes.run.params.tool',
    ]);
  });

  it('follows workflows.security.require_approval', () => {
    const noApproval: WorkflowDefinition = {
      ...base(),
      nodes: {
        read: { step: 'fetch_issue' },
        tag: { step: 'label', params: { target: 'issue', add: ['triaged'] } },
      },
      edges: ['read -> tag', 'tag -> done'],
    };
    expect(errorsOf(noApproval).map((e) => e.message)).toEqual([
      'tag can label with no approval before it (workflows.security.require_approval)',
    ]);
    expect(codes(noApproval, { requireApproval: ['push', 'comment'] })).toEqual([]);
    expect(codes(noApproval, { requireApproval: [] })).toEqual([]);
  });

  it('finds the public write on a way around the approval', () => {
    // read -> ask -> answer is fine, but read -> answer goes around it.
    const def = {
      ...base(),
      edges: [
        'read -> ask when output.state == "open"',
        'read -> answer',
        'ask -> answer',
        'answer -> done',
      ],
    };
    expect(errorsOf(def).map((e) => e.path)).toEqual(['nodes.answer']);
  });

  it('lets a delivery by the rules stand for its approval, but not a fixed mode', () => {
    const deliver = (params: Record<string, unknown>): WorkflowDefinition => ({
      ...base(),
      nodes: { ship: { step: 'deliver', params } },
      edges: ['ship -> done'],
    });
    expect(codes(deliver({}))).toEqual([]);
    expect(codes(deliver({ mode: 'ask' }))).toEqual([]);
    expect(codes(deliver({ mode: 'pr' }))).toEqual(['approval_missing']);
    expect(codes(deliver({ mode: 'direct_merge' }))).toEqual(['approval_missing']);
  });

  it('takes the step types and the engine version by option', () => {
    expect(codes(base(), { engineVersion: 2 })).toEqual(['engine']);
    expect(codes({ ...base(), engine: 'latest' })).toEqual(['engine']);
    expect(codes(base(), { stepTypes: [] })).toEqual([
      'unknown_step',
      'unknown_step',
      'unknown_step',
    ]);
  });

  it('takes the condition limits by option', () => {
    expect(codes(base(), { conditionLimits: { maxLength: 5, maxDepth: 32 } })).toEqual([
      'condition_syntax',
      'condition_syntax',
    ]);
  });
});

describe('the helpers', () => {
  it.each([
    ['>=1 <2', 1, true],
    ['>=1 <2', 2, false],
    ['1', 1, true],
    ['=1', 2, false],
    ['<3', 2, true],
    ['>1', 1, false],
    ['<=1', 1, true],
    ['>=1.0', 1, null],
    ['', 1, null],
    ['^1', 1, null],
  ])('engineInRange(%j, %d) is %s', (range, version, expected) => {
    expect(engineInRange(range, version)).toBe(expected);
  });

  it('formats a path', () => {
    expect(formatPath(['edges', 3, 'when'])).toBe('edges[3].when');
    expect(formatPath(['nodes', 'a', 'params'])).toBe('nodes.a.params');
    expect(formatPath([])).toBe('');
  });
});
