// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  findInterpolations,
  parseInterpolation,
  referencedNodes,
  resolveInterpolations,
} from './interpolation.js';

const scope = {
  inputs: { issue: 7, label: 'bug' },
  outputs: { work: { summary: 'Done in a branch', delivered: true, pr_number: 12, list: ['a'] } },
};

describe('parseInterpolation', () => {
  it('splits text and references', () => {
    const parsed = parseInterpolation('PR ${nodes.work.pr_number}: ${nodes.work.summary}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.parts.map((p) => (typeof p === 'string' ? p : p.text))).toEqual([
      'PR ',
      'nodes.work.pr_number',
      ': ',
      'nodes.work.summary',
    ]);
  });

  it.each([
    ['${nodes.work}', 'names a node but not a field'],
    ['${other.x}', 'must start with nodes. or inputs.'],
    ['${inputs.a.b}', 'an input is read whole'],
    ['${nodes.work.summary', 'not closed'],
    ['${nodes..x}', 'no valid name'],
  ])('refuses %s', (text, message) => {
    const parsed = parseInterpolation(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(message);
  });
});

describe('resolveInterpolations', () => {
  it('gives the value as it is when the string is one reference', () => {
    const result = resolveInterpolations(
      { number: '${nodes.work.pr_number}', flag: '${nodes.work.delivered}' },
      scope,
    );
    expect(result).toEqual({ ok: true, value: { number: 12, flag: true } });
  });

  it('builds a text when there is text around, in lists and objects too', () => {
    const result = resolveInterpolations(
      { body: 'Done: ${nodes.work.summary} (#${inputs.issue})', labels: ['${inputs.label}', 'x'] },
      scope,
    );
    expect(result).toEqual({
      ok: true,
      value: { body: 'Done: Done in a branch (#7)', labels: ['bug', 'x'] },
    });
  });

  it('writes a doubled dollar as a literal and does not change the input', () => {
    const params = { body: 'use $${nodes.work.summary}' };
    expect(resolveInterpolations(params, scope)).toEqual({
      ok: true,
      value: { body: 'use ${nodes.work.summary}' },
    });
    expect(params.body).toBe('use $${nodes.work.summary}');
  });

  it('fails, never writes an empty text, when a value is missing or is not a scalar', () => {
    expect(resolveInterpolations({ body: '${nodes.later.summary}' }, scope)).toMatchObject({
      ok: false,
      detail: 'nodes.later.summary has no value',
    });
    expect(resolveInterpolations({ body: '${nodes.work.nope}' }, scope).ok).toBe(false);
    expect(resolveInterpolations({ body: 'x ${nodes.work.list}' }, scope)).toMatchObject({
      ok: false,
      detail: 'nodes.work.list is not a text, a number or a boolean',
    });
  });

  it('leaves what has no reference as it was', () => {
    const params = { a: 1, b: null, c: ['x', { d: true }] };
    expect(resolveInterpolations(params, scope)).toEqual({ ok: true, value: params });
  });
});

describe('findInterpolations and referencedNodes', () => {
  it('walk the whole params and name the nodes read', () => {
    const params = {
      body: '${nodes.b.x} ${nodes.a.y}',
      list: ['${inputs.i}', { deep: '${nodes.a.z}' }],
    };
    expect(findInterpolations(params).map((f) => f.segments)).toEqual([
      ['body'],
      ['list', 0],
      ['list', 1, 'deep'],
    ]);
    expect(referencedNodes(params)).toEqual(['a', 'b']);
  });
});
