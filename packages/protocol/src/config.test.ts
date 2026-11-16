// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRANSIENT_BACKOFF_MS,
  LocalConfigSchema,
  parseDurationText,
  PoolConfigSchema,
  RESUME_PRESETS,
  ResumeConfigSchema,
} from './config.js';

describe('parseDurationText', () => {
  it('reads the units of the architecture', () => {
    expect(parseDurationText('500ms')).toBe(500);
    expect(parseDurationText('45s')).toBe(45_000);
    expect(parseDurationText('30m')).toBe(1_800_000);
    expect(parseDurationText('2h')).toBe(7_200_000);
    expect(parseDurationText('1d')).toBe(86_400_000);
  });

  it('refuses text that is not a duration', () => {
    for (const text of ['', '30', 'm', '1.5h', '-1m', '30 min', '1w']) {
      expect(parseDurationText(text), text).toBeUndefined();
    }
  });
});

describe('LocalConfigSchema', () => {
  it('fills the defaults of architecture 5.9', () => {
    expect(LocalConfigSchema.parse({ url: 'http://127.0.0.1:8080' })).toEqual({
      server: 'llama-cpp',
      url: 'http://127.0.0.1:8080',
      slots: 'auto',
      reserve_for_director: 1,
      reserve_when: 'listed',
    });
  });

  it('accepts the full form', () => {
    const full = {
      server: 'ollama',
      url: 'https://models.internal:11434',
      slots: 4,
      reserve_for_director: 'all',
      reserve_when: 'always',
    };
    expect(LocalConfigSchema.parse(full)).toEqual(full);
    expect(LocalConfigSchema.safeParse({ url: 'http://h', reserve_for_director: 0 }).success).toBe(
      true,
    );
  });

  it('refuses bad values', () => {
    const bad: unknown[] = [
      {},
      { url: 'not a url' },
      { url: 'ftp://host/x' },
      { url: 'http://h', server: 'lm-studio' },
      { url: 'http://h', slots: 0 },
      { url: 'http://h', slots: 'many' },
      { url: 'http://h', slots: 1.5 },
      { url: 'http://h', reserve_for_director: -1 },
      { url: 'http://h', reserve_for_director: 'some' },
      { url: 'http://h', reserve_when: 'sometimes' },
      { url: 'http://h', extra: true },
      { url: 'http://h', slots: 2, reserve_for_director: 3 },
    ];
    for (const value of bad) {
      expect(LocalConfigSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('PoolConfigSchema', () => {
  it('gives every client its defaults, OpenCode per_profile (N56)', () => {
    const pool = PoolConfigSchema.parse({});
    expect(pool['claude-code']).toEqual({ k: 3, idle_ms: 300_000 });
    expect(pool.codex).toEqual({ k: 3, idle_ms: 300_000 });
    expect(pool.opencode).toEqual({ k: 3, idle_ms: 300_000, process_model: 'per_profile' });
  });

  it('takes per-client overrides', () => {
    const pool = PoolConfigSchema.parse({
      codex: { k: 5 },
      opencode: { process_model: 'per_session', idle_ms: 0 },
    });
    expect(pool.codex.k).toBe(5);
    expect(pool.opencode).toEqual({ k: 3, idle_ms: 0, process_model: 'per_session' });
  });

  it('refuses process_model outside opencode, bad values and unknown clients', () => {
    const bad: unknown[] = [
      { codex: { process_model: 'per_profile' } },
      { opencode: { process_model: 'shared' } },
      { codex: { k: 0 } },
      { codex: { idle_ms: -1 } },
      { codex: { k: 1.5 } },
      { cursor: {} },
    ];
    for (const value of bad) {
      expect(PoolConfigSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('ResumeConfigSchema', () => {
  it('defaults to balanced, the table of architecture 5.16', () => {
    expect(ResumeConfigSchema.parse({})).toEqual({
      preset: 'balanced',
      max_resumes: 5,
      quota_wait_max: 1_800_000,
      checkpoint_every: 600_000,
      stuck: { no_event_for: 600_000, same_error_times: 3 },
      transient_backoff: [30_000, 120_000, 600_000],
    });
  });

  it('applies each preset', () => {
    const patient = ResumeConfigSchema.parse({ preset: 'patient' });
    expect(patient).toMatchObject({ max_resumes: 8, quota_wait_max: 7_200_000 });
    expect(patient.stuck).toEqual({ no_event_for: 1_200_000, same_error_times: 5 });
    const agile = ResumeConfigSchema.parse({ preset: 'agile' });
    expect(agile).toMatchObject({
      max_resumes: 3,
      quota_wait_max: 600_000,
      checkpoint_every: 300_000,
    });
    expect(agile.stuck).toEqual({ no_event_for: 300_000, same_error_times: 2 });
    expect(RESUME_PRESETS.balanced.max_resumes).toBe(5);
  });

  it('lets an individual key override only its own value', () => {
    const resume = ResumeConfigSchema.parse({
      preset: 'agile',
      quota_wait_max: '1h',
      stuck: { same_error_times: 4 },
      transient_backoff: ['10s', '1m'],
    });
    expect(resume).toEqual({
      preset: 'agile',
      max_resumes: 3,
      quota_wait_max: 3_600_000,
      checkpoint_every: 300_000,
      stuck: { no_event_for: 300_000, same_error_times: 4 },
      transient_backoff: [10_000, 60_000],
    });
  });

  it('keeps the backoff across presets', () => {
    for (const preset of ['balanced', 'patient', 'agile']) {
      expect(ResumeConfigSchema.parse({ preset }).transient_backoff).toEqual([
        ...DEFAULT_TRANSIENT_BACKOFF_MS,
      ]);
    }
  });

  it('allows zero resumes and zero wait, refuses the rest', () => {
    expect(ResumeConfigSchema.safeParse({ max_resumes: 0, quota_wait_max: '0s' }).success).toBe(
      true,
    );
    const bad: unknown[] = [
      { preset: 'lazy' },
      { max_resumes: -1 },
      { quota_wait_max: 30 },
      { quota_wait_max: 'soon' },
      { checkpoint_every: '0m' },
      { stuck: { no_event_for: '0s' } },
      { stuck: { same_error_times: 0 } },
      { stuck: { other: 1 } },
      { transient_backoff: [] },
      { transient_backoff: ['0s'] },
      { unknown_key: 1 },
    ];
    for (const value of bad) {
      expect(ResumeConfigSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});
