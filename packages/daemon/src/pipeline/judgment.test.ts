// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  answerGuide,
  answerProblems,
  JUDGMENT_POINT_IDS,
  JUDGMENT_POINTS,
  judgmentPoint,
  parseAnswer,
  pointBelongsTo,
} from './judgment.js';

describe('the 8 judgment points of the Director', () => {
  it('are closed, numbered 1 to 8 in the order of the architecture', () => {
    expect(JUDGMENT_POINTS.map((point) => point.id)).toEqual([...JUDGMENT_POINT_IDS]);
    expect(JUDGMENT_POINTS.map((point) => point.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(judgmentPoint('invented')).toBeUndefined();
  });

  it('the play opens points 1, 2, 3, 6, 7 and 8; chat and task.run have the others', () => {
    const ofPlay = JUDGMENT_POINT_IDS.filter((id) => pointBelongsTo(id, 'play'));
    expect(ofPlay).toEqual([
      'classify_critique',
      'actor_timeout',
      'consult_producer',
      'refusal_or_permission',
      'resumes_exceeded',
      'dependency_redone',
    ]);
    expect(pointBelongsTo('chat_consult', 'chat')).toBe(true);
    expect(pointBelongsTo('task_step_failed', 'task.run')).toBe(true);
    expect(pointBelongsTo('task_step_failed', 'play')).toBe(false);
  });

  describe('answers', () => {
    it.each([
      ['classify_critique', { failures: [{ kind: 'script' }] }],
      ['classify_critique', { failures: [{ kind: 'execution', demandIds: ['d1'] }] }],
      [
        'classify_critique',
        { failures: [{ kind: 'critical_exception', exception: 'safety_risk' }] },
      ],
      ['actor_timeout', { action: 'accept_partial' }],
      ['actor_timeout', { action: 'reassign' }],
      ['consult_producer', { ask: true, question: 'which database?' }],
      ['consult_producer', { ask: false }],
      ['chat_consult', { consult: true }],
      ['task_step_failed', { action: 'skip' }],
      ['refusal_or_permission', { action: 'switch_executor' }],
      ['resumes_exceeded', { action: 'fail_attempt' }],
      ['dependency_redone', { action: 'rebase' }],
    ] as const)('%s accepts %j', (id, answer) => {
      expect(parseAnswer(id, answer)).toEqual(answer);
    });

    it.each([
      ['classify_critique', { failures: [] }],
      ['classify_critique', { failures: [{ kind: 'execution' }] }],
      ['classify_critique', { failures: [{ kind: 'critical_exception' }] }],
      ['classify_critique', { failures: [{ kind: 'critical_exception', exception: 'invented' }] }],
      ['classify_critique', { failures: [{ kind: 'script', extra: 1 }] }],
      ['actor_timeout', { action: 'reformulate' }],
      ['actor_timeout', {}],
      ['consult_producer', { ask: 'yes' }],
      ['refusal_or_permission', { action: 'rebase' }],
      ['resumes_exceeded', { action: 'redo' }],
      ['dependency_redone', { action: 'rebase', extra: true }],
    ] as const)('%s refuses %j', (id, answer) => {
      expect(parseAnswer(id, answer)).toBeUndefined();
    });
  });
});

describe('the guide of an answer (what the Director reads in next_action)', () => {
  const input = { demandIds: ['d1', 'd2'] };

  it.each(JUDGMENT_POINT_IDS)('the example of %s fits its own schema', (id) => {
    const guide = answerGuide(id, input);
    expect(guide?.schema).toMatchObject({ type: 'object' });
    expect(guide?.schema).not.toHaveProperty('$schema');
    expect(answerProblems(id, guide?.example, input)).toEqual([]);
    expect(parseAnswer(id, guide?.example)).toBeDefined();
  });

  it('the example of point 1 names the first demand, or a placeholder when there is none', () => {
    expect(answerGuide('classify_critique', input)?.example).toMatchObject({
      failures: [{ kind: 'execution', demandIds: ['d1'] }],
    });
    expect(answerGuide('classify_critique', {})?.example).toMatchObject({
      failures: [{ demandIds: ['<a demand id from demandIds>'] }],
    });
  });

  it('the schema of point 1 says when demandIds and exception are needed', () => {
    const text = JSON.stringify(answerGuide('classify_critique', input)?.schema);
    expect(text).toContain('Required when kind is \\"execution\\"');
    expect(text).toContain('Required when kind is \\"critical_exception\\"');
  });

  it('lists the problems with their paths, and the demands the script does not have', () => {
    expect(answerProblems('classify_critique', { failures: [] }, input)).toEqual([
      expect.stringMatching(/^failures: /),
    ]);
    expect(
      answerProblems(
        'classify_critique',
        { failures: [{ kind: 'execution', demandIds: ['x'] }] },
        input,
      ),
    ).toEqual(['failures.0.demandIds: "x" is not a demand of the script (d1, d2)']);
    expect(answerProblems('actor_timeout', { action: 'wait' }, {})).toEqual([
      expect.stringMatching(/^action: /),
    ]);
  });
});
