// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
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
