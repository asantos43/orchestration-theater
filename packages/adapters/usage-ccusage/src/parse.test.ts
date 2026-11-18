// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { isCalendarDay, parseCcusageOutput } from './index.js';
import { dailyJson } from './testing/fake-ccusage.js';

describe('parseCcusageOutput', () => {
  it('reads one entry per day and model, keeping only figures and the model name', () => {
    const text = dailyJson([
      {
        date: '2026-11-17',
        models: [
          { name: 'model-a', input: 100, output: 20, cacheRead: 5, cacheWrite: 7, cost: 0.5 },
          { name: 'model-b', input: 1, output: 2 },
        ],
      },
    ]);
    expect(parseCcusageOutput(text)).toEqual([
      {
        day: '2026-11-17',
        model: 'model-a',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
        costUsd: 0.5,
      },
      {
        day: '2026-11-17',
        model: 'model-b',
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
    ]);
  });

  it('never returns fields it does not know (a path, a session, a text)', () => {
    const text = JSON.stringify({
      daily: [
        {
          date: '2026-11-17',
          inputTokens: 3,
          outputTokens: 4,
          totalCost: 0.1,
          project: '/some/where',
          conversation: 'secret words',
        },
      ],
      totals: { note: 'secret words' },
    });
    const entries = parseCcusageOutput(text);
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('secret');
    expect(JSON.stringify(entries)).not.toContain('/some/where');
    expect(entries[0]).toEqual({
      day: '2026-11-17',
      model: null,
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: 0.1,
    });
  });

  it('accepts the Codex spellings and a models object', () => {
    const text = JSON.stringify({
      daily: [
        {
          date: '2026-11-17',
          models: {
            'gpt-x': { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, costUSD: 1 },
          },
        },
      ],
    });
    expect(parseCcusageOutput(text)).toEqual([
      {
        day: '2026-11-17',
        model: 'gpt-x',
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 4,
        cacheWriteTokens: null,
        costUsd: 1,
      },
    ]);
  });

  it('accepts a root list, and an empty output as no data', () => {
    expect(parseCcusageOutput('[]')).toEqual([]);
    expect(parseCcusageOutput('  \n')).toEqual([]);
    expect(parseCcusageOutput('{"daily":[]}')).toEqual([]);
  });

  it.each([
    ['not json', 'oops secret words'],
    ['no daily list', '{"weekly":[]}'],
    ['bad date', '{"daily":[{"date":"yesterday"}]}'],
    ['negative count', '{"daily":[{"date":"2026-11-17","inputTokens":-1}]}'],
    ['fractional count', '{"daily":[{"date":"2026-11-17","inputTokens":1.5}]}'],
    ['count as text', '{"daily":[{"date":"2026-11-17","inputTokens":"9"}]}'],
    ['nameless model', '{"daily":[{"date":"2026-11-17","modelBreakdowns":[{"inputTokens":1}]}]}'],
  ])('rejects %s without echoing the output', (_name, text) => {
    expect(() => parseCcusageOutput(text)).toThrow(AdapterUnavailable);
    try {
      parseCcusageOutput(text);
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });
});

describe('isCalendarDay', () => {
  it('accepts real days only', () => {
    expect(isCalendarDay('2026-02-28')).toBe(true);
    expect(isCalendarDay('2026-02-30')).toBe(false);
    expect(isCalendarDay('2026-2-3')).toBe(false);
    expect(isCalendarDay('')).toBe(false);
  });
});
