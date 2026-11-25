// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseWorkflowYaml, validateWorkflowYaml } from './yaml.js';

const TEXT = `id: github-issues
version: 1.0.0
engine: ">=1 <2"
inputs:
  repo: { type: code_host_repo }
nodes:
  read:  { step: fetch_issue }
  check: { step: critique }
edges:
  - read -> check
  - check -> done when: output.approved
  - { from: check, to: read, when: not output.approved, limit: redo }
limits: { redo: 2, budget_usd: 5, max_duration: 4h }
`;

describe('the YAML of a definition', () => {
  it('reads the example of docs/24, with the edge forms of YAML', () => {
    const result = validateWorkflowYaml(TEXT);
    expect(result.stage).toBe('definition');
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.stage !== 'definition' || !result.ok) return;
    expect(result.workflow.edges.map((e) => [e.from, e.to, e.when ?? null])).toEqual([
      ['read', 'check', null],
      ['check', 'done', 'output.approved'],
      ['check', 'read', 'not output.approved'],
    ]);
  });

  it('gives each error its line and column', () => {
    const text = TEXT.replace('check: { step: critique }', 'check: { step: critque }');
    const result = validateWorkflowYaml(text);
    expect(result.ok).toBe(false);
    if (result.stage !== 'definition') throw new Error('expected a definition error');
    const [error] = result.errors;
    if (error === undefined) throw new Error('expected an error');
    expect(error.code).toBe('unknown_step');
    expect(result.positions.get(error)).toEqual({ line: 8, column: 18 });
  });

  it('points at the edge of a bad condition', () => {
    const text = TEXT.replace('when: output.approved', 'when: output.aproved');
    const result = validateWorkflowYaml(text);
    if (result.stage !== 'definition') throw new Error('expected a definition error');
    const [error] = result.errors;
    if (error === undefined) throw new Error('expected an error');
    expect(error.path).toBe('edges[1].when');
    // The nearest node that exists in the text: the edge itself, on line 11.
    expect(result.positions.get(error)?.line).toBe(11);
  });

  it('refuses a broken text, duplicate keys and custom tags', () => {
    expect(validateWorkflowYaml('id: [open').stage).toBe('yaml');
    const dup = parseWorkflowYaml('id: a\nid: b\n');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors[0]?.position).toEqual({ line: 2, column: 1 });
    const tag = parseWorkflowYaml('id: !!js/function "x"\n');
    expect(tag.ok).toBe(false);
  });

  it('bounds the size and the aliases, by options', () => {
    const big = validateWorkflowYaml(TEXT, { yaml: { maxBytes: 100, maxAliases: 50 } });
    expect(big.stage).toBe('yaml');
    expect(big.ok || big.stage !== 'yaml' ? [] : big.errors.map((e) => e.message)).toEqual([
      `the definition has ${String(new TextEncoder().encode(TEXT).length)} bytes; the limit is 100`,
    ]);
    const bomb = ['a: &a [x, x]', 'b: &b [*a, *a]', 'c: &c [*b, *b]', 'd: [*c, *c]'].join('\n');
    expect(parseWorkflowYaml(bomb, { maxBytes: 1024, maxAliases: 2 }).ok).toBe(false);
    expect(parseWorkflowYaml(bomb).ok).toBe(true);
  });
});
