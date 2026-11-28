// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { labelsFit, parseBindingTriggers, runIdPrefix, triggerRunId } from './types.js';

describe('parseBindingTriggers', () => {
  it('keeps the valid triggers with their place and reports the others', () => {
    const { valid, invalid } = parseBindingTriggers({
      triggers: [
        { type: 'code_host.issue_opened', filter: { labels: ['bug'] } },
        { type: 'code_host.issue_labeled' },
        { type: 'code_host.pr_opened' },
        { type: 'event', filter: { name: 'demo.ping' } },
        { type: 'cron', filter: { every: '1h' } },
        { type: 'event', filter: { name: 'demo.ping', extra: true } },
      ],
    });
    expect(valid.map((t) => [t.index, t.trigger.type])).toEqual([
      [0, 'code_host.issue_opened'],
      [2, 'code_host.pr_opened'],
      [3, 'event'],
    ]);
    expect(invalid.map((t) => [t.index, t.type])).toEqual([
      [1, 'code_host.issue_labeled'],
      [4, 'cron'],
      [5, 'event'],
    ]);
    expect(invalid.every((t) => t.detail.length > 0)).toBe(true);
  });
});

describe('triggerRunId', () => {
  it('is a function of the binding and the item, with the prefix of the binding', () => {
    const id = triggerRunId('b1', 'issue_opened:1');
    expect(id).toBe(triggerRunId('b1', 'issue_opened:1'));
    expect(id).not.toBe(triggerRunId('b1', 'issue_opened:2'));
    expect(id).not.toBe(triggerRunId('b2', 'issue_opened:1'));
    expect(id.startsWith(runIdPrefix('b1'))).toBe(true);
  });
});

describe('labelsFit', () => {
  it('needs every label of `labels` and one of `labels_any`, ignoring the case', () => {
    expect(labelsFit(['Bug', 'ready'], undefined)).toBe(true);
    expect(labelsFit(['bug'], { labels: ['BUG'] })).toBe(true);
    expect(labelsFit(['bug'], { labels: ['bug', 'ready'] })).toBe(false);
    expect(labelsFit(['bug'], { labels_any: ['ready', 'bug'] })).toBe(true);
    expect(labelsFit(['bug'], { labels_any: ['ready'] })).toBe(false);
    expect(labelsFit(['bug', 'ready'], { labels: ['bug'], labels_any: ['ready'] })).toBe(true);
  });
});
