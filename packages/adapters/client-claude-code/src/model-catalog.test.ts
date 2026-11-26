// SPDX-License-Identifier: MPL-2.0
import type { Executor, ProfileRef } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { GROUPED_CONFIG_OPTIONS, SESSION_NEW_CONFIG_OPTIONS } from './fixtures/config-options.js';
import {
  ClaudeModelCatalog,
  floatingOf,
  readConfigOptions,
  RESERVE_SNAPSHOT,
  type ConfigOptionsReader,
} from './model-catalog.js';

const profile: ProfileRef = { client: 'claude-code', profile: 'p' };
const executor = (model: string, effort?: string): Executor => ({
  profile,
  model,
  ...(effort === undefined ? {} : { effort }),
});

function counting(value: unknown): { reader: ConfigOptionsReader; calls: () => number } {
  let calls = 0;
  return {
    reader: () => {
      calls += 1;
      return Promise.resolve(value);
    },
    calls: () => calls,
  };
}

const failing: ConfigOptionsReader = () => Promise.reject(new Error('the client did not start'));

describe('readConfigOptions', () => {
  it('reads the models and the efforts of the session/new answer', () => {
    const snapshot = readConfigOptions(SESSION_NEW_CONFIG_OPTIONS);
    expect(snapshot?.models.map((model) => model.id)).toEqual([
      'default',
      'opus',
      'claude-fable-5-2[1m]',
      'sonnet',
      'haiku',
    ]);
    expect(snapshot?.efforts).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('flattens grouped values', () => {
    expect(readConfigOptions(GROUPED_CONFIG_OPTIONS)?.models.map((model) => model.id)).toEqual([
      'opus',
      'sonnet',
      'claude-haiku-5-5',
    ]);
  });

  it('answers undefined when there is no model option, or nothing usable', () => {
    expect(readConfigOptions([{ id: 'mode', type: 'select', options: [] }])).toBeUndefined();
    expect(readConfigOptions(undefined)).toBeUndefined();
    expect(readConfigOptions('nope')).toBeUndefined();
    expect(readConfigOptions([{ id: 'model', options: [] }])).toBeUndefined();
  });
});

describe('ClaudeModelCatalog.list', () => {
  it('lists what the session announced, with the family and the context window', async () => {
    const catalog = new ClaudeModelCatalog({ reader: counting(SESSION_NEW_CONFIG_OPTIONS).reader });
    const models = await catalog.list(profile);
    const fable = models.find((model) => model.id === 'claude-fable-5-2[1m]');
    expect(fable).toMatchObject({
      family: 'anthropic',
      local: false,
      toolCalls: true,
      contextWindow: 1_000_000,
    });
    expect(models.find((model) => model.id === 'sonnet')?.contextWindow).toBeUndefined();
    expect(models.every((model) => model.efforts.includes('xhigh'))).toBe(true);
  });

  it('marks the aliases the client resolves, and leaves the full ids fixed (N324)', async () => {
    const catalog = new ClaudeModelCatalog({ reader: counting(SESSION_NEW_CONFIG_OPTIONS).reader });
    const models = await catalog.list(profile);
    expect(models.find((model) => model.id === 'default')?.floating).toBe('account');
    expect(models.find((model) => model.id === 'sonnet')?.floating).toBe('family');
    expect(models.find((model) => model.id === 'claude-fable-5-2[1m]')).not.toHaveProperty('floating');
  });

  it('tells the kind of an alias by its id', () => {
    expect(floatingOf('default')).toBe('account');
    expect(['opus', 'sonnet', 'haiku', 'fable', 'sonnet[1m]'].map(floatingOf)).toEqual(
      Array<string>(5).fill('family'),
    );
    expect(['claude-opus-5', 'opusplan', 'opus-x', 'Default'].map(floatingOf)).toEqual(
      Array<undefined>(4).fill(undefined),
    );
  });

  it('has automatic discovery', () => {
    expect(new ClaudeModelCatalog().discovery).toBe('automatic');
  });

  it('uses the reserve in reserve mode and never calls the reader', async () => {
    const { reader, calls } = counting(SESSION_NEW_CONFIG_OPTIONS);
    const models = await new ClaudeModelCatalog({ source: 'reserve', reader }).list(profile);
    expect(models.map((model) => model.id)).toEqual(RESERVE_SNAPSHOT.models.map((m) => m.id));
    expect(calls()).toBe(0);
  });

  it('falls back to the reserve when there is no reader or the reader fails', async () => {
    const ids = RESERVE_SNAPSHOT.models.map((model) => model.id);
    expect((await new ClaudeModelCatalog().list(profile)).map((m) => m.id)).toEqual(ids);
    const failed = new ClaudeModelCatalog({ reader: failing });
    expect((await failed.list(profile)).map((m) => m.id)).toEqual(ids);
  });

  it('rejects in session mode when the reader fails or announces no model', async () => {
    await expect(
      new ClaudeModelCatalog({ source: 'session', reader: failing }).list(profile),
    ).rejects.toThrow('did not start');
    await expect(new ClaudeModelCatalog({ source: 'session' }).list(profile)).rejects.toThrow();
    const empty = counting([]).reader;
    await expect(
      new ClaudeModelCatalog({ source: 'session', reader: empty }).list(profile),
    ).rejects.toThrow();
  });

  it('caches a listing of the session for cacheMs, per profile', async () => {
    let now = 1000;
    const { reader, calls } = counting(SESSION_NEW_CONFIG_OPTIONS);
    const catalog = new ClaudeModelCatalog({ reader, cacheMs: 500, now: () => now });
    await catalog.list(profile);
    await catalog.list(profile);
    expect(calls()).toBe(1);
    await catalog.list({ client: 'claude-code', profile: 'other' });
    expect(calls()).toBe(2);
    now += 600;
    await catalog.list(profile);
    expect(calls()).toBe(3);
  });

  it('caches nothing with cacheMs 0, and never caches a fallback', async () => {
    const { reader, calls } = counting(SESSION_NEW_CONFIG_OPTIONS);
    const none = new ClaudeModelCatalog({ reader, cacheMs: 0 });
    await none.list(profile);
    await none.list(profile);
    expect(calls()).toBe(2);
    let attempts = 0;
    const flaky: ConfigOptionsReader = () => {
      attempts += 1;
      return Promise.reject(new Error('down'));
    };
    const fallback = new ClaudeModelCatalog({ reader: flaky });
    await fallback.list(profile);
    await fallback.list(profile);
    expect(attempts).toBe(2);
  });
});

describe('ClaudeModelCatalog.suggest', () => {
  const catalog = new ClaudeModelCatalog();

  it('proposes the family, the local flag, the high effort and the window', async () => {
    const models = await new ClaudeModelCatalog({
      reader: counting(SESSION_NEW_CONFIG_OPTIONS).reader,
    }).list(profile);
    const fable = models.find((model) => model.id === 'claude-fable-5-2[1m]');
    if (fable === undefined) throw new Error('the fixture lost the fable model');
    expect(catalog.suggest(fable)).toEqual({
      family: 'anthropic',
      local: false,
      effort: 'high',
      contextWindow: 1_000_000,
    });
  });

  it('proposes no effort when the model does not accept high', () => {
    expect(catalog.suggest({ id: 'x', efforts: ['low'], local: false, toolCalls: true })).toEqual({
      family: 'anthropic',
      local: false,
    });
  });
});

describe('ClaudeModelCatalog.validate', () => {
  const session = (): ClaudeModelCatalog =>
    new ClaudeModelCatalog({ reader: counting(SESSION_NEW_CONFIG_OPTIONS).reader });

  it('accepts a model and an effort of the session list', async () => {
    expect(await session().validate(executor('sonnet', 'high'))).toEqual({ ok: true, issues: [] });
  });

  it('refuses an unknown model and an unknown effort as errors when the list is the account', async () => {
    const result = await session().validate(executor('gpt-9', 'turbo'));
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => [issue.code, issue.severity])).toEqual([
      ['model_not_found', 'error'],
      ['effort_not_accepted', 'error'],
    ]);
  });

  it('only warns about an unknown model when the list is the reserve', async () => {
    const result = await new ClaudeModelCatalog({ source: 'reserve' }).validate(
      executor('claude-fable-5-2[1m]'),
    );
    expect(result.ok).toBe(true);
    expect(result.issues).toMatchObject([{ code: 'model_not_found', severity: 'warning' }]);
  });

  it('says why the reserve was used when a reader failed', async () => {
    const result = await new ClaudeModelCatalog({ reader: failing }).validate(executor('sonnet'));
    expect(result.ok).toBe(true);
    expect(result.issues).toMatchObject([{ code: 'profile_invalid', severity: 'warning' }]);
  });

  it('is an error, not a warning, when session mode cannot read the list', async () => {
    const result = await new ClaudeModelCatalog({ source: 'session', reader: failing }).validate(
      executor('sonnet'),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toMatchObject([{ code: 'profile_invalid', severity: 'error' }]);
  });
});
