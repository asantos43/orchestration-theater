// SPDX-License-Identifier: MPL-2.0
import { InvalidInput } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import {
  BUDGET_IN_FLIGHT_MODES,
  BUDGET_ON_CAP_CHANGE_MODES,
  BUDGET_ON_EXCEEDED_MODES,
  BUDGET_UNKNOWN_COST_MODES,
} from './budget-config.js';
import { budgetSettingsOf } from './budget/settings.js';
import { parseConfig } from './config.js';

const FULL = `
profiles:
  claude-code/api:
    budget:
      daily_usd: 5
      monthly_usd: 100
      warn_at: [0.9, 0.5, 0.9]
      on_exceeded: ask
      in_flight: finish
executors:
  "claude-opus-high@claude-code/api":
    client: claude-code
    profile: api
    model: claude-opus
    effort: high
    budget:
      daily_usd: 2
budget:
  timezone: UTC
  unknown_cost: block
  on_cap_change: keep
  ask_timeout: 5m
`;

describe('profiles.<id>.budget, executors.<id>.budget and budget.* of the config (Phase 5, P11)', () => {
  it('[proposta] has no cap and the proposed defaults when nothing is written', () => {
    const config = parseConfig('');
    expect(config.profiles.entries).toEqual({});
    expect(config.executors.budgets).toEqual({});
    expect(config.budget).toEqual({
      timezone: 'America/Sao_Paulo',
      unknown_cost: 'ignore',
      on_cap_change: 'release',
      ask_timeout: 600_000,
    });
  });

  it('gives a cap the defaults of the architecture: warn at 80%, skip, handoff', () => {
    const config = parseConfig('profiles:\n  claude-code/api:\n    budget:\n      daily_usd: 5\n');
    expect(config.profiles.entries['claude-code/api']?.budget).toEqual({
      daily_usd: 5,
      warn_at: [0.8],
      on_exceeded: 'skip',
      in_flight: 'handoff',
    });
  });

  it('reads the caps of a profile and of an Executor, sorting warn_at without repeats', () => {
    const config = parseConfig(FULL);
    expect(config.profiles.entries['claude-code/api']?.budget).toEqual({
      daily_usd: 5,
      monthly_usd: 100,
      warn_at: [0.5, 0.9],
      on_exceeded: 'ask',
      in_flight: 'finish',
    });
    expect(config.executors.budgets['claude-opus-high@claude-code/api']).toEqual({
      daily_usd: 2,
      warn_at: [0.8],
    });
    expect(config.budget).toEqual({
      timezone: 'UTC',
      unknown_cost: 'block',
      on_cap_change: 'keep',
      ask_timeout: 300_000,
    });
  });

  it('keeps the fixed keys of profiles working beside the profiles', () => {
    const config = parseConfig(
      'profiles:\n  same_provider_notice: always\n  claude-code/api:\n    budget:\n      daily_usd: 1\n',
    );
    expect(config.profiles.same_provider_notice).toBe('always');
    expect(Object.keys(config.profiles.entries)).toEqual(['claude-code/api']);
  });

  it('takes every mode of on_exceeded, in_flight, unknown_cost and on_cap_change', () => {
    for (const mode of BUDGET_ON_EXCEEDED_MODES) {
      const text = `profiles:\n  codex/api:\n    budget:\n      daily_usd: 1\n      on_exceeded: ${mode}\n`;
      expect(parseConfig(text).profiles.entries['codex/api']?.budget?.on_exceeded).toBe(mode);
    }
    for (const mode of BUDGET_IN_FLIGHT_MODES) {
      const text = `profiles:\n  codex/api:\n    budget:\n      daily_usd: 1\n      in_flight: ${mode}\n`;
      expect(parseConfig(text).profiles.entries['codex/api']?.budget?.in_flight).toBe(mode);
    }
    for (const mode of BUDGET_UNKNOWN_COST_MODES) {
      expect(parseConfig(`budget:\n  unknown_cost: ${mode}\n`).budget.unknown_cost).toBe(mode);
    }
    for (const mode of BUDGET_ON_CAP_CHANGE_MODES) {
      expect(parseConfig(`budget:\n  on_cap_change: ${mode}\n`).budget.on_cap_change).toBe(mode);
    }
  });

  it('refuses a mode it does not know, a cap that is not a positive number and a warn_at out of range', () => {
    const profile = (body: string): string =>
      `profiles:\n  claude-code/api:\n    budget:\n${body
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n')}\n`;
    expect(() => parseConfig(profile('on_exceeded: pause'))).toThrow(InvalidInput);
    expect(() => parseConfig(profile('in_flight: drop'))).toThrow(InvalidInput);
    expect(() => parseConfig(profile('daily_usd: 0'))).toThrow(InvalidInput);
    expect(() => parseConfig(profile('daily_usd: -3'))).toThrow(InvalidInput);
    expect(() => parseConfig(profile('monthly_usd: lots'))).toThrow(InvalidInput);
    expect(() => parseConfig(profile('warn_at: [1.5]'))).toThrow(InvalidInput);
    expect(() => parseConfig(profile('warn_at: [0]'))).toThrow(InvalidInput);
    expect(() => parseConfig(profile('weekly_usd: 3'))).toThrow(InvalidInput);
    expect(() => parseConfig('budget:\n  unknown_cost: guess\n')).toThrow(InvalidInput);
    expect(() => parseConfig('budget:\n  on_cap_change: maybe\n')).toThrow(InvalidInput);
    expect(() => parseConfig('budget:\n  timezone: Mars/Olympus\n')).toThrow(InvalidInput);
    expect(() => parseConfig('budget:\n  ask_timeout: soon\n')).toThrow(InvalidInput);
  });

  it('refuses a key of profiles that is neither a fixed key nor <client>/<profile>', () => {
    expect(() => parseConfig('profiles:\n  api:\n    budget:\n      daily_usd: 1\n')).toThrow(
      InvalidInput,
    );
  });

  it('lets warn_at be empty to turn the warning off', () => {
    const config = parseConfig(
      'profiles:\n  claude-code/api:\n    budget:\n      daily_usd: 1\n      warn_at: []\n',
    );
    expect(config.profiles.entries['claude-code/api']?.budget?.warn_at).toEqual([]);
  });

  it('hands the service its settings: caps by profile id and by Executor name', () => {
    const settings = budgetSettingsOf(parseConfig(FULL));
    expect(settings).toMatchObject({
      timezone: 'UTC',
      unknownCost: 'block',
      onCapChange: 'keep',
      askTimeoutMs: 300_000,
    });
    expect(settings.profiles.get('claude-code/api')).toEqual({
      dailyUsd: 5,
      monthlyUsd: 100,
      warnAt: [0.5, 0.9],
      onExceeded: 'ask',
      inFlight: 'finish',
    });
    expect(settings.executors.get('claude-opus-high@claude-code/api')).toEqual({
      dailyUsd: 2,
      monthlyUsd: undefined,
      warnAt: [0.8],
    });
  });
});
