// SPDX-License-Identifier: MPL-2.0
import type { SetupExecutor, SetupModel, SetupModels, SetupRunView } from '@otheater/protocol';
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  choiceOf,
  modelPickKey,
  modelPickLines,
  modelPickStart,
  seedOfChoices,
  type ModelPick,
} from './model-pick.js';

const ACCOUNT = 'claude-code/work';

function must(pick: ModelPick | undefined): ModelPick {
  if (pick === undefined) throw new Error('no list');
  return pick;
}

function model(id: string, extra: Partial<SetupModel> = {}): SetupModel {
  return {
    id,
    name: null,
    family: null,
    efforts: [],
    local: false,
    contextWindow: null,
    floating: null,
    preset: [],
    registered: [],
    ...extra,
  };
}

function found(models: readonly SetupModel[], extra: Partial<SetupModels> = {}): SetupModels {
  return {
    profileId: ACCOUNT,
    kind: 'token_plan',
    login: 'logged_in',
    preset: 'balanced',
    catalog: 'listed',
    reason: null,
    models: [...models],
    notes: [],
    ...extra,
  };
}

const MODELS = [
  model('old', { registered: [`old@${ACCOUNT}`] }),
  model('opus', { name: 'Opus', preset: [{ id: `opus@${ACCOUNT}`, effort: null }] }),
  model('haiku'),
];

function executor(id: string, modelId: string, profileId = ACCOUNT): SetupExecutor {
  return {
    id,
    profileId,
    model: modelId,
    alias: modelId,
    effort: null,
    provider: 'anthropic',
    source: 'discovered',
    presetExpand: true,
    local: null,
  };
}

function runWith(accounts: readonly string[], discovered: readonly SetupExecutor[]): SetupRunView {
  return {
    id: 'setup_run1',
    flow: 'first_run',
    state: 'active',
    step: 'executors',
    steps: ['detect', 'preset', 'executors', 'review'],
    done: [
      {
        step: 'detect',
        input: { accounts: [...accounts] },
        output: { clients: [], profiles: [], accounts: [...accounts] },
      },
      {
        step: 'preset',
        input: { preset: 'balanced' },
        output: { preset: 'balanced', discovered: [...discovered], roles: [], notes: [] },
      },
    ],
    prompt: null,
    result: null,
    createdAt: 0,
    updatedAt: 0,
    finishedAt: null,
  } as unknown as SetupRunView;
}

const t = ((key: string, options?: Record<string, unknown>) =>
  options === undefined ? key : `${key} ${JSON.stringify(options)}`) as unknown as TFunction;

describe('the start of the list (ui.setup.modelPick)', () => {
  it('checks the models of the preset, all of them, or none, and never a registered one', () => {
    expect(modelPickStart(found(MODELS), 'preset')?.checked).toEqual(['opus']);
    expect(modelPickStart(found(MODELS), 'all')?.checked).toEqual(['opus', 'haiku']);
    expect(modelPickStart(found(MODELS), 'none')?.checked).toEqual([]);
  });

  it('starts the cursor on the first model that is not registered', () => {
    expect(modelPickStart(found(MODELS), 'preset')?.cursor).toBe(1);
  });

  it('gives no list when there is nothing to choose', () => {
    expect(modelPickStart(found([], { catalog: 'none' }), 'preset')).toBeUndefined();
    expect(modelPickStart(found(MODELS, { catalog: 'unavailable' }), 'preset')).toBeUndefined();
    expect(modelPickStart(found(MODELS.slice(0, 1)), 'all')).toBeUndefined();
  });
});

describe('the keys of the list', () => {
  const start = must(modelPickStart(found(MODELS), 'preset'));

  it('walks inside the list and toggles the model under the cursor', () => {
    const down = modelPickKey(start, 'Down').pick;
    expect(down.cursor).toBe(2);
    expect(modelPickKey(down, 'Down').pick.cursor).toBe(2);
    expect(modelPickKey(modelPickKey(start, 'Up').pick, 'Up').pick.cursor).toBe(0);
    expect(modelPickKey(down, 'Space').pick.checked).toEqual(['opus', 'haiku']);
    expect(modelPickKey(start, 'Space').pick.checked).toEqual([]);
  });

  it('leaves a registered model as it is', () => {
    const onOld = { ...start, cursor: 0 };
    expect(modelPickKey(onOld, 'Space').pick.checked).toEqual(['opus']);
  });

  it('ends with Enter or Esc, and other keys do nothing', () => {
    expect(modelPickKey(start, 'Enter').done).toBe('confirm');
    expect(modelPickKey(start, 'Esc').done).toBe('cancel');
    expect(modelPickKey(start, 'x')).toEqual({ pick: start });
    expect(choiceOf(start)).toEqual({
      profileId: ACCOUNT,
      offered: ['opus', 'haiku'],
      checked: ['opus'],
    });
  });

  it('draws the marks, the name and the tags', () => {
    const lines = modelPickLines(start, t).map((line) => line.text);
    expect(lines[0]).toContain('setup.models.title');
    expect(lines[1]).toBe('[=] old  setup.models.registered');
    expect(lines[2]).toBe('[x] opus (Opus)  setup.models.inPreset');
    expect(lines[3]).toBe('[ ] haiku');
    expect(lines.at(-1)).toBe('setup.models.keys');
    expect(modelPickLines(start, t)[2]?.selected).toBe(true);
  });

  it('says which ids are aliases the client resolves (N324)', () => {
    const pick = must(
      modelPickStart(
        found([
          model('default', { name: 'Default (recommended)', floating: 'account' }),
          model('opus', { floating: 'family', preset: [{ id: `opus@${ACCOUNT}`, effort: null }] }),
          model('claude-opus-5'),
        ]),
        'preset',
      ),
    );
    const lines = modelPickLines(pick, t).map((line) => line.text);
    expect(lines[1]).toBe('[ ] default (Default (recommended))  setup.models.floating.account');
    expect(lines[2]).toBe('[x] opus  setup.models.floating.family, setup.models.inPreset');
    expect(lines[3]).toBe('[ ] claude-opus-5');
  });
});

describe('what the choices give the step of the Executors [proposta]', () => {
  const discovered = [executor('opus-x', 'opus'), executor('sonnet-x', 'sonnet')];

  it('requests a checked model the preset did not find, and excludes an unchecked one it found', () => {
    const seed = seedOfChoices(runWith([ACCOUNT], discovered), {
      [ACCOUNT]: {
        profileId: ACCOUNT,
        offered: ['opus', 'sonnet', 'haiku'],
        checked: ['sonnet', 'haiku'],
      },
    });
    expect(seed).toEqual({
      executors: [{ profileId: ACCOUNT, model: 'haiku' }],
      exclude: ['opus-x'],
    });
  });

  it('gives nothing for an account the detection left out', () => {
    const seed = seedOfChoices(runWith(['codex/main'], discovered), {
      [ACCOUNT]: { profileId: ACCOUNT, offered: ['opus', 'haiku'], checked: ['haiku'] },
    });
    expect(seed).toEqual({ executors: [], exclude: [] });
  });

  it('does not touch what another account found', () => {
    const other = [executor('opus-y', 'opus', 'claude-code/main')];
    const seed = seedOfChoices(runWith([ACCOUNT, 'claude-code/main'], other), {
      [ACCOUNT]: { profileId: ACCOUNT, offered: ['opus'], checked: [] },
    });
    expect(seed).toEqual({ executors: [], exclude: [] });
  });
});
