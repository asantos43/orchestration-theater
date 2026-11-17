// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { checkIdeaGroup, ideaGroupOutput } from './idea-group.js';

const answer = {
  group: { ideaIds: ['I1', 'I2'], need: 'Do I1 and I2 together', rationale: 'same area' },
  leftOut: [{ ideaId: 'I3', reason: 'depends on a decision', question: 'Which database?' }],
  discarded: [{ ideaId: 'I4', reason: 'duplicate of I1' }],
  deferred: [],
  split: [],
};

describe('group_ideas output (architecture 5.20)', () => {
  it('accepts a group with leftOut, discarded and deferred, and fills the empty lists', () => {
    const parsed = ideaGroupOutput.parse({ ...answer, deferred: undefined, split: undefined });
    expect(parsed.deferred).toEqual([]);
    expect(parsed.split).toEqual([]);
    expect(parsed.group.ideaIds).toEqual(['I1', 'I2']);
  });

  it('always asks for the reason of an idea left out, discarded or deferred', () => {
    for (const list of ['leftOut', 'discarded', 'deferred'] as const) {
      const bad = { ...answer, [list]: [{ ideaId: 'I9' }] };
      expect(ideaGroupOutput.safeParse(bad).success, list).toBe(false);
      const blank = { ...answer, [list]: [{ ideaId: 'I9', reason: '  ' }] };
      expect(ideaGroupOutput.safeParse(blank).success, list).toBe(false);
    }
  });

  it('a split needs a reason and at least two parts', () => {
    const split = { ideaId: 'I5', reason: 'two features in one', parts: ['a', 'b'] };
    expect(ideaGroupOutput.safeParse({ ...answer, split: [split] }).success).toBe(true);
    expect(
      ideaGroupOutput.safeParse({ ...answer, split: [{ ...split, parts: ['a'] }] }).success,
    ).toBe(false);
    expect(
      ideaGroupOutput.safeParse({ ...answer, split: [{ ...split, reason: '' }] }).success,
    ).toBe(false);
  });

  it('a group with ideas needs the need and the rationale; an empty group needs neither', () => {
    const noNeed = { ...answer, group: { ...answer.group, need: '' } };
    expect(ideaGroupOutput.safeParse(noNeed).success).toBe(false);
    const noWhy = { ...answer, group: { ...answer.group, rationale: ' ' } };
    expect(ideaGroupOutput.safeParse(noWhy).success).toBe(false);
    const empty = { ...answer, group: { ideaIds: [], need: '', rationale: '' } };
    expect(ideaGroupOutput.safeParse(empty).success).toBe(true);
  });

  it('rejects an id that is not I<n> and an idea in two lists', () => {
    expect(
      ideaGroupOutput.safeParse({ ...answer, group: { ...answer.group, ideaIds: ['3'] } }).success,
    ).toBe(false);
    const twice = { ...answer, discarded: [{ ideaId: 'I1', reason: 'x' }] };
    const result = ideaGroupOutput.safeParse(twice);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('I1 appears twice');
  });

  it('checkIdeaGroup compares the answer with the queue and the limit', () => {
    const parsed = ideaGroupOutput.parse(answer);
    expect(checkIdeaGroup(parsed, ['I1', 'I2', 'I3', 'I4'], 5)).toEqual([]);
    expect(checkIdeaGroup(parsed, ['I1', 'I2', 'I3'], 5)).toEqual(['I4 is not in the queue']);
    expect(checkIdeaGroup(parsed, ['I1', 'I2', 'I3', 'I4', 'I6'], 5)).toEqual([
      'I6 was not placed in any list',
    ]);
    expect(checkIdeaGroup(parsed, ['I1', 'I2', 'I3', 'I4'], 1)).toEqual([
      'the group has 2 ideas; the limit is 1',
    ]);
  });
});
