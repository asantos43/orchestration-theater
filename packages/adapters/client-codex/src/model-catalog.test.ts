// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, PermissionDenied, type Executor } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { CONFIG_OPTIONS } from './fixtures/config-options.js';
import { CODEX_FAMILY, CodexModelCatalog, modelsFromConfigOptions } from './model-catalog.js';

const profile = { client: 'codex', profile: 'work' };
const executor = (extra: Partial<Executor> = {}): Executor => ({
  profile,
  model: 'model-a',
  ...extra,
});

function catalog(calls: string[] = []) {
  return new CodexModelCatalog({
    source: (ref) => {
      calls.push(ref.profile);
      return Promise.resolve(CONFIG_OPTIONS);
    },
  });
}

describe('modelsFromConfigOptions', () => {
  it('reads models flat and grouped, and gives each the efforts of the session', () => {
    expect(modelsFromConfigOptions(CONFIG_OPTIONS)).toEqual([
      {
        id: 'model-a',
        name: 'Model A',
        family: 'openai',
        efforts: ['low', 'medium', 'high'],
        local: false,
      },
      {
        id: 'model-b',
        name: 'Model B',
        family: 'openai',
        efforts: ['low', 'medium', 'high'],
        local: false,
      },
    ]);
  });

  it('gives an empty catalog when the options are not there', () => {
    expect(modelsFromConfigOptions([])).toEqual([]);
    expect(modelsFromConfigOptions([{ id: 'model' }])).toEqual([]);
  });
});

describe('CodexModelCatalog', () => {
  it('is automatic and lists through the source, without calling the model', async () => {
    const calls: string[] = [];
    const models = catalog(calls);
    expect(models.discovery).toBe('automatic');
    expect((await models.list(profile)).map((model) => model.id)).toEqual(['model-a', 'model-b']);
    expect(calls).toEqual(['work']);
  });

  it('rejects with AdapterUnavailable when it has no source', async () => {
    await expect(new CodexModelCatalog().list(profile)).rejects.toBeInstanceOf(AdapterUnavailable);
  });

  it('suggests the family, a cloud model and the preferred effort when the model has it', async () => {
    const [model] = await catalog().list(profile);
    if (model === undefined) throw new Error('the fixture has models');
    expect(catalog().suggest(model)).toEqual({
      family: CODEX_FAMILY,
      local: false,
      effort: 'high',
    });
    const medium = new CodexModelCatalog({ suggestedEffort: 'medium' });
    expect(medium.suggest(model).effort).toBe('medium');
    expect(
      medium.suggest({ id: 'x', efforts: ['xhigh'], local: false, contextWindow: 10 }),
    ).toEqual({
      family: 'openai',
      local: false,
      effort: 'xhigh',
      contextWindow: 10,
    });
    expect(medium.suggest({ id: 'x', efforts: [], local: false })).toEqual({
      family: 'openai',
      local: false,
    });
  });

  it('validates a known model and effort', async () => {
    expect(await catalog().validate(executor({ effort: 'low' }))).toEqual({ ok: true, issues: [] });
    expect(await catalog().validate(executor())).toEqual({ ok: true, issues: [] });
  });

  it('flags an unknown model, an effort the model does not take, and a foreign profile', async () => {
    const unknown = await catalog().validate(executor({ model: 'nope' }));
    expect(unknown.ok).toBe(false);
    expect(unknown.issues.map((issue) => issue.code)).toEqual(['model_not_found']);

    const effort = await catalog().validate(executor({ effort: 'extreme' }));
    expect(effort.issues.map((issue) => issue.code)).toEqual(['effort_not_accepted']);
    expect(effort.ok).toBe(false);

    const foreign = await catalog().validate(
      executor({ profile: { client: 'claude-code', profile: 'p' } }),
    );
    expect(foreign.issues.map((issue) => issue.code)).toEqual(['profile_invalid']);
  });

  it('reports a profile with no login as profile_invalid, and lets other failures through', async () => {
    const noLogin = new CodexModelCatalog({
      source: () => Promise.reject(new PermissionDenied('Authentication required')),
    });
    const result = await noLogin.validate(executor());
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe('profile_invalid');
    await expect(new CodexModelCatalog().validate(executor())).rejects.toBeInstanceOf(
      AdapterUnavailable,
    );
  });
});
