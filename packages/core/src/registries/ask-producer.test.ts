// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { askProducerInput, OFFICIAL_TOOLS } from './index.js';

const options = [
  { label: 'pr', description: 'Open a pull request' },
  { label: 'merge', description: 'Merge into the base branch' },
];

describe('the ask_producer schema (5.3)', () => {
  it('is the schema the registry holds', () => {
    expect(OFFICIAL_TOOLS.find((t) => t.name === 'ask_producer')?.input).toBe(askProducerInput);
  });

  it('accepts 1 to 4 questions with 2 to 4 options, a recommended label and the flags', () => {
    const parsed = askProducerInput.parse({
      questions: [
        { question: 'Deliver how?', options, recommended: 'pr', multi_select: true },
        { question: 'Project name?', open: true },
      ],
    });
    expect(parsed.questions[0]?.multi_select).toBe(true);
    expect(parsed.questions[1]).toEqual({
      question: 'Project name?',
      multi_select: false,
      open: true,
    });
  });

  it('refuses 0 or 5 questions, 1 or 5 options and unknown keys', () => {
    const q = { question: 'x', options };
    expect(askProducerInput.safeParse({ questions: [] }).success).toBe(false);
    expect(askProducerInput.safeParse({ questions: [q, q, q, q, q] }).success).toBe(false);
    expect(
      askProducerInput.safeParse({ questions: [{ ...q, options: options.slice(0, 1) }] }).success,
    ).toBe(false);
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `o${String(i)}`, description: '' }));
    expect(askProducerInput.safeParse({ questions: [{ ...q, options: five }] }).success).toBe(
      false,
    );
    expect(askProducerInput.safeParse({ questions: [{ ...q, extra: 1 }] }).success).toBe(false);
  });

  it('refuses a recommended label that is not an option, duplicate labels and multi_select without options', () => {
    const q = { question: 'x', options };
    expect(askProducerInput.safeParse({ questions: [{ ...q, recommended: 'nope' }] }).success).toBe(
      false,
    );
    expect(
      askProducerInput.safeParse({ questions: [{ ...q, options: [options[0], options[0]] }] })
        .success,
    ).toBe(false);
    expect(
      askProducerInput.safeParse({ questions: [{ question: 'x', multi_select: true }] }).success,
    ).toBe(false);
  });
});
