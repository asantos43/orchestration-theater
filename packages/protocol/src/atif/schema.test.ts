// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- the trajectories are mutated as loose JSON to break one rule at a time */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AtifTrajectorySchema, OtheaterRootExtraSchema } from './index.js';

function fixture(name: string): Record<string, unknown> {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
}

const FIXTURES = ['rfc-0001-stock-price.json', 'harbor-hello-claude-code.json'] as const;

/** A small valid trajectory the cases below break one rule at a time. */
function sample(): Record<string, unknown> {
  return {
    schema_version: 'ATIF-v1.8',
    session_id: 'play-1',
    agent: { name: 'otheater', version: '0.0.0' },
    steps: [
      { step_id: 1, source: 'user', message: 'hello' },
      {
        step_id: 2,
        source: 'agent',
        message: 'working',
        tool_calls: [{ tool_call_id: 'c1', function_name: 'read', arguments: {} }],
        observation: { results: [{ source_call_id: 'c1', content: 'done' }] },
      },
    ],
  };
}

function issues(input: unknown): string[] {
  const result = AtifTrajectorySchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('ATIF schema: what other producers write', () => {
  it.each(FIXTURES)('accepts the fixture %s', (name) => {
    expect(issues(fixture(name))).toEqual([]);
  });

  it('accepts the small sample', () => {
    expect(issues(sample())).toEqual([]);
  });

  it.each(FIXTURES)(
    'rejects a loose field in %s at the root, in a step and in the agent',
    (name) => {
      const root = { ...fixture(name), loose: 1 };
      expect(issues(root)).not.toEqual([]);
      const base = fixture(name) as { steps: Record<string, unknown>[]; agent: object };
      expect(
        issues({ ...base, steps: [{ ...base.steps[0], loose: 1 }, ...base.steps.slice(1)] }),
      ).not.toEqual([]);
      expect(issues({ ...base, agent: { ...base.agent, loose: 1 } })).not.toEqual([]);
    },
  );
});

describe('ATIF schema: the strictness at every level', () => {
  const withLoose = (mutate: (t: Record<string, any>) => void): string[] => {
    const t = sample() as Record<string, any>;
    mutate(t);
    return issues(t);
  };

  it('rejects a loose field in a tool call, an observation result, metrics and final metrics', () => {
    expect(withLoose((t) => (t.steps[1].tool_calls[0].loose = 1))).not.toEqual([]);
    expect(withLoose((t) => (t.steps[1].observation.results[0].loose = 1))).not.toEqual([]);
    expect(withLoose((t) => (t.steps[1].metrics = { prompt_tokens: 1, loose: 1 }))).not.toEqual([]);
    expect(withLoose((t) => (t.final_metrics = { total_steps: 2, loose: 1 }))).not.toEqual([]);
    expect(withLoose((t) => (t.steps[1].observation.loose = 1))).not.toEqual([]);
  });

  it('keeps `extra` open, but `extra.otheater` strict at every level', () => {
    expect(withLoose((t) => (t.extra = { anything: [1, 2] }))).toEqual([]);
    expect(withLoose((t) => (t.extra = { otheater: { schema: 1 } }))).not.toEqual([]);
    expect(withLoose((t) => (t.agent.extra = { otheater: { schema: 2 } }))).not.toEqual([]);
    expect(
      withLoose(
        (t) =>
          (t.steps[1].tool_calls[0].extra = {
            otheater: {
              schema: 1,
              source: 'client',
              toolKind: null,
              status: null,
              paths: [],
              x: 1,
            },
          }),
      ),
    ).not.toEqual([]);
    expect(
      withLoose(
        (t) =>
          (t.steps[1].tool_calls[0].extra = {
            otheater: { schema: 1, source: 'client', toolKind: null, status: null, paths: [] },
          }),
      ),
    ).toEqual([]);
  });

  it('requires the root block to say what the file is', () => {
    expect(OtheaterRootExtraSchema.safeParse({ schema: 1 }).success).toBe(false);
  });
});

describe('ATIF schema: the rules of the Harbor models', () => {
  const run = (mutate: (t: Record<string, any>) => void): string[] => {
    const t = sample() as Record<string, any>;
    mutate(t);
    return issues(t);
  };

  it('needs steps, sequential from 1', () => {
    expect(run((t) => (t.steps = []))).not.toEqual([]);
    expect(run((t) => (t.steps[1].step_id = 3))).not.toEqual([]);
  });

  it('keeps the agent-only fields out of a user or system step', () => {
    for (const [field, value] of [
      ['model_name', 'm'],
      ['reasoning_effort', 'low'],
      ['reasoning_content', 'why'],
      ['tool_calls', []],
      ['metrics', { prompt_tokens: 1 }],
    ] as const) {
      expect(run((t) => (t.steps[0][field] = value))).not.toEqual([]);
    }
  });

  it('forbids metrics and reasoning on a dispatch with llm_call_count 0', () => {
    expect(run((t) => (t.steps[1].llm_call_count = 0))).toEqual([]);
    expect(run((t) => ((t.steps[1].llm_call_count = 0), (t.steps[1].metrics = {})))).not.toEqual(
      [],
    );
    expect(
      run((t) => ((t.steps[1].llm_call_count = 0), (t.steps[1].reasoning_content = 'x'))),
    ).not.toEqual([]);
    expect(run((t) => (t.steps[1].llm_call_count = -1))).not.toEqual([]);
  });

  it('needs a source_call_id that is a tool call of the same step', () => {
    expect(run((t) => (t.steps[1].observation.results[0].source_call_id = 'nope'))).not.toEqual([]);
    expect(run((t) => delete t.steps[1].observation.results[0].source_call_id)).toEqual([]);
  });

  it('needs the embedded trajectories to carry unique ids, at any depth', () => {
    const sub = (id?: string): Record<string, unknown> => ({
      ...sample(),
      ...(id === undefined ? {} : { trajectory_id: id }),
    });
    expect(run((t) => (t.subagent_trajectories = [sub('a'), sub('b')]))).toEqual([]);
    expect(run((t) => (t.subagent_trajectories = [sub()]))).not.toEqual([]);
    expect(run((t) => (t.subagent_trajectories = [sub('a'), sub('a')]))).not.toEqual([]);
    expect(
      run((t) => {
        const inner = { ...sub('a'), subagent_trajectories: [sub('x'), sub('x')] };
        t.subagent_trajectories = [inner];
      }),
    ).not.toEqual([]);
  });

  it('needs a reference to be resolvable', () => {
    const ref = (value: Record<string, unknown>) => (t: Record<string, any>) => {
      t.steps[1].observation.results[0].subagent_trajectory_ref = [value];
    };
    expect(run(ref({ trajectory_id: 'a' }))).toEqual([]);
    expect(run(ref({ trajectory_path: 'a.json' }))).toEqual([]);
    expect(run(ref({ session_id: 's' }))).not.toEqual([]);
  });

  it('checks the timestamp, the schema version and the content parts', () => {
    expect(run((t) => (t.steps[0].timestamp = '2026-11-21T10:00:00.000Z'))).toEqual([]);
    expect(run((t) => (t.steps[0].timestamp = 'yesterday'))).not.toEqual([]);
    expect(run((t) => (t.schema_version = 'ATIF-v2.0'))).not.toEqual([]);
    expect(run((t) => (t.steps[0].message = [{ type: 'text', text: 'a' }]))).toEqual([]);
    expect(run((t) => (t.steps[0].message = [{ type: 'text' }]))).not.toEqual([]);
    expect(
      run(
        (t) =>
          (t.steps[0].message = [
            { type: 'image', source: { media_type: 'audio/wav', path: 'a' } },
          ]),
      ),
    ).not.toEqual([]);
    expect(
      run(
        (t) =>
          (t.steps[0].message = [
            { type: 'audio', source: { media_type: 'audio/mp3', path: 'a' } },
          ]),
      ),
    ).toEqual([]);
  });
});
