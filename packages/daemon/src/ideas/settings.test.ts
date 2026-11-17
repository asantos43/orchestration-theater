// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { IdeasConfigSchema, SCHEDULED_REFUSED, ideaSettingsOf } from './settings.js';

describe('the ideas.* keys (5.20)', () => {
  it('have the defaults of the architecture', () => {
    expect(parseConfig('').ideas).toEqual({
      drain: 'auto',
      grouping_approval: 'ask',
      max_per_play: 5,
      parallel_plays: 1,
    });
  });

  it('are read from the config file', () => {
    const { ideas } = parseConfig(
      'ideas:\n  drain: manual\n  grouping_approval: auto\n  max_per_play: 3\n  parallel_plays: 2\n',
    );
    expect(ideas).toEqual({
      drain: 'manual',
      grouping_approval: 'auto',
      max_per_play: 3,
      parallel_plays: 2,
    });
  });

  it('refuse `scheduled` with a clear message: there is no scheduler yet', () => {
    const parsed = IdeasConfigSchema.safeParse({ drain: 'scheduled' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(SCHEDULED_REFUSED);
    expect(() => parseConfig('ideas:\n  drain: scheduled\n')).toThrow(/scheduler/);
  });

  it('refuse unknown modes, unknown keys and sizes below one', () => {
    expect(IdeasConfigSchema.safeParse({ drain: 'sometimes' }).success).toBe(false);
    expect(IdeasConfigSchema.safeParse({ grouping_approval: 'maybe' }).success).toBe(false);
    expect(IdeasConfigSchema.safeParse({ max_per_play: 0 }).success).toBe(false);
    expect(IdeasConfigSchema.safeParse({ parallel_plays: 0 }).success).toBe(false);
    expect(IdeasConfigSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });
});

describe('the settings of a scenario', () => {
  const global = IdeasConfigSchema.parse({});

  it('are the global ones when the scenario overrides nothing', () => {
    expect(ideaSettingsOf(global, undefined)).toEqual({ settings: global, problems: [] });
    expect(ideaSettingsOf(global, { 'limits.attempts': 3 })).toEqual({
      settings: global,
      problems: [],
    });
  });

  it('take each key of the override as a dotted key, and keep the rest', () => {
    const resolved = ideaSettingsOf(global, {
      'ideas.drain': 'manual',
      'ideas.grouping_approval': 'auto',
      'ideas.max_per_play': 2,
      'ideas.parallel_plays': 3,
    });
    expect(resolved.problems).toEqual([]);
    expect(resolved.settings).toEqual({
      drain: 'manual',
      grouping_approval: 'auto',
      max_per_play: 2,
      parallel_plays: 3,
    });
    expect(ideaSettingsOf(global, { 'ideas.max_per_play': 2 }).settings).toEqual({
      ...global,
      max_per_play: 2,
    });
  });

  it('ignore a value that does not fit its key and say why', () => {
    const resolved = ideaSettingsOf(global, {
      'ideas.drain': 'scheduled',
      'ideas.max_per_play': 0,
      'ideas.grouping_approval': 'auto',
    });
    expect(resolved.settings).toEqual({ ...global, grouping_approval: 'auto' });
    expect(resolved.problems).toHaveLength(2);
    expect(resolved.problems[0]).toContain('ideas.drain');
    expect(resolved.problems[0]).toContain('scheduler');
    expect(resolved.problems[1]).toContain('ideas.max_per_play');
  });
});
