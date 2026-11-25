// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  checkCondition,
  ConditionSyntaxError,
  evaluateCondition,
  parseCondition,
} from './condition.js';
import type { FieldType } from './field-types.js';

const output: FieldType = {
  object: {
    approved: 'boolean',
    verdict: { enum: ['ok', 'redo'] },
    score: 'number',
    title: 'string',
    labels: { list: 'string' },
    extra: 'unknown',
    nested: { object: { deep: 'boolean' } },
  },
};
const inputs: FieldType = { object: { limit: 'number', skip: 'boolean', mode: 'string' } };
const scope = { output, inputs };

const values = {
  output: {
    approved: true,
    verdict: 'redo',
    score: 7,
    title: 'Fix it',
    labels: ['bug', 'ui'],
    extra: null,
    nested: { deep: false },
  },
  inputs: { limit: 5, skip: false, mode: 'pr' },
};

const run = (text: string): boolean => evaluateCondition(parseCondition(text), values);
const problems = (text: string): readonly string[] => checkCondition(parseCondition(text), scope);

describe('the condition language: each operator', () => {
  it.each([
    ['output.verdict == "redo"', true],
    ['output.verdict == "ok"', false],
    ['output.verdict != "ok"', true],
    ['output.score < 8', true],
    ['output.score <= 7', true],
    ['output.score > 7', false],
    ['output.score >= 7', true],
    ['output.score > inputs.limit', true],
    ['output.verdict in ["ok", "redo"]', true],
    ['output.verdict in ["ok"]', false],
    ['"bug" in output.labels', true],
    ['"docs" in output.labels', false],
    ['output.title in output.labels', false],
    ['output.approved', true],
    ['not output.approved', false],
    ['output.approved and output.score > 5', true],
    ['output.approved and inputs.skip', false],
    ['inputs.skip or output.approved', true],
    ['not (inputs.skip or output.approved)', false],
    ['output.extra == null', true],
    ['output.nested.deep', false],
    ['true', true],
    ['false', false],
    ["output.title == 'Fix it'", true],
  ])('%s is %s', (text, expected) => {
    expect(run(text)).toBe(expected);
  });

  it('gives and a higher precedence than or', () => {
    // false or (true and true)
    expect(run('inputs.skip or output.approved and output.score == 7')).toBe(true);
    // (false or true) and false
    expect(run('(inputs.skip or output.approved) and inputs.skip')).toBe(false);
  });

  it('reads a missing field as null and a bare non-boolean as false', () => {
    expect(evaluateCondition(parseCondition('output.missing == null'), values)).toBe(true);
    expect(evaluateCondition(parseCondition('output.title'), values)).toBe(false);
    expect(
      evaluateCondition(parseCondition('output.score < 9'), { output: { score: '1' }, inputs: {} }),
    ).toBe(false);
  });

  it('never reads the prototype', () => {
    expect(evaluateCondition(parseCondition('output.constructor == null'), values)).toBe(true);
    expect(checkCondition(parseCondition('output.constructor == null'), scope)).toEqual([
      'output.constructor does not exist',
    ]);
  });
});

describe('the condition language: syntax', () => {
  it.each([
    ['', 'empty condition'],
    ['output.x ==', 'expected a value'],
    ['output.x = 1', 'unexpected "="'],
    ['foo.bar', 'a path starts with output or inputs'],
    ['output.', 'expected a field name'],
    ['(output.approved', 'expected ")"'],
    ['output.approved output.x', 'unexpected text'],
    ['"open', 'unterminated string'],
    ['"a\\nb" == output.title', 'escapes'],
    ['output.f(1)', 'unexpected text'],
    ['output.x == 1 + 2', 'unexpected "+"'],
    ['[1, 2', 'expected "]"'],
  ])('refuses %j', (text, message) => {
    expect(() => parseCondition(text)).toThrow(ConditionSyntaxError);
    expect(() => parseCondition(text)).toThrow(message);
  });

  it('gives the position of the error', () => {
    try {
      parseCondition('output.approved and = 1');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConditionSyntaxError);
      expect((error as ConditionSyntaxError).position).toBe(20);
    }
  });

  it('bounds the length and the depth, by options', () => {
    expect(() => parseCondition(`output.approved${' '.repeat(600)}`)).toThrow('longer than 500');
    expect(() => parseCondition('not '.repeat(40) + 'output.approved')).toThrow('nested deeper');
    expect(() =>
      parseCondition('not not output.approved', { maxLength: 500, maxDepth: 1 }),
    ).toThrow('nested deeper than 1');
    expect(parseCondition('output.approved', { maxLength: 15, maxDepth: 1 })).toEqual({
      kind: 'test',
      operand: { kind: 'path', root: 'output', path: ['approved'] },
    });
  });

  it('reads negative and decimal numbers', () => {
    expect(run('output.score > -1.5')).toBe(true);
  });
});

describe('the condition language: types', () => {
  it('accepts what fits', () => {
    expect(problems('output.verdict == "ok" and output.score >= inputs.limit')).toEqual([]);
    expect(problems('output.verdict in ["ok", "redo"] or "bug" in output.labels')).toEqual([]);
    expect(problems('output.extra == null and output.nested.deep')).toEqual([]);
  });

  it.each([
    ['output.nope', 'output.nope does not exist'],
    ['inputs.nope == 1', 'inputs.nope does not exist'],
    ['output.verdict == "maybe"', 'is not one of ok, redo'],
    ['output.score == "7"', 'number compared with string'],
    ['output.title < "b"', 'needs numbers'],
    ['output.score', 'is number, not boolean'],
    ['"x"', 'a bare value must be true or false'],
    ['1 == 1', 'is constant'],
    ['output.score == output.title', 'output.score (number) == output.title (string)'],
    ['output.verdict in output.score', 'not a list'],
    ['output.verdict in "ok"', 'the right of in must be a list'],
    ['"ok" in ["ok"]', 'the left of in must be a field'],
    ['output.score in ["a"]', 'number compared with string'],
    ['[1] == output.score', 'a list can only be on the right of in'],
    ['output.extra == 1', 'unknown type can only be compared with null'],
    ['output.labels == "bug"', 'cannot compare list(string)'],
    ['output.score in output.labels', 'output.score (number) in output.labels (list(string))'],
    ['1 in output.labels', 'output.labels: string compared with number'],
    ['"x" in output.title', 'output.title is string, not a list'],
  ])('refuses %j', (text, message) => {
    const found = problems(text);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join(' | ')).toContain(message);
  });
});
