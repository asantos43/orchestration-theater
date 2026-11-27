// SPDX-License-Identifier: MPL-2.0
import type {
  SetupDoneStep,
  SetupExecutorRequest,
  SetupModel,
  SetupModels,
  SetupRunView,
} from '@otheater/protocol';
import type { TFunction } from 'i18next';
import type { SetupModelPickMode } from '../settings.js';
import { discoveredOfRun } from './executor-list.js';
import type { ExecutorsSeed } from './model.js';

/**
 * The list of models after the login of an account (N324, item 2; the owner on 2026-11-26). The
 * daemon says which models the client lists and which of them the preset uses
 * (`GET /v1/setup/models/:client/:name`). The person checks the ones that enter, and the choice
 * goes into the step of the Executors: a checked model the preset does not use becomes a request,
 * and an unchecked model the preset uses goes in `exclude`. This module is pure: what each key does
 * to the list, what it draws and what it gives the step. Nothing here calls the daemon.
 *
 * A model that already runs as an Executor of the account (`registered`) is shown but does not
 * take part: it is there already.
 */

export interface ModelPick {
  readonly profileId: string;
  readonly models: readonly SetupModel[];
  /** The ids of the models checked. */
  readonly checked: readonly string[];
  readonly cursor: number;
}

/** What the person chose for one account, kept until the step of the Executors opens. */
export interface ModelChoice {
  readonly profileId: string;
  /** The ids of the models offered (not the registered ones). */
  readonly offered: readonly string[];
  readonly checked: readonly string[];
}

function offeredModels(models: readonly SetupModel[]): readonly SetupModel[] {
  return models.filter((model) => model.registered.length === 0);
}

/**
 * The list a login opens, with the models checked as `ui.setup.modelPick` says (`preset`: the ones
 * the preset uses; `all`; `none`). `undefined` when there is nothing to choose: no catalog, a
 * catalog that could not be read, or every listed model already registered.
 */
export function modelPickStart(
  found: SetupModels,
  mode: SetupModelPickMode,
): ModelPick | undefined {
  if (found.catalog === 'none' || found.catalog === 'unavailable') return undefined;
  const offered = offeredModels(found.models);
  if (offered.length === 0) return undefined;
  const checked = offered
    .filter((model) => mode === 'all' || (mode === 'preset' && model.preset.length > 0))
    .map((model) => model.id);
  const cursor = Math.max(
    0,
    found.models.findIndex((model) => model.registered.length === 0),
  );
  return { profileId: found.profileId, models: found.models, checked, cursor };
}

export interface ModelPickStep {
  readonly pick: ModelPick;
  /** `confirm`: Enter took the choice; `cancel`: Esc left it, and the daemon's default stands. */
  readonly done?: 'confirm' | 'cancel';
}

/** One key on the list: ↑/↓ walk it, Space checks or unchecks, Enter takes it, Esc leaves it. */
export function modelPickKey(pick: ModelPick, combo: string | undefined): ModelPickStep {
  const last = Math.max(0, pick.models.length - 1);
  switch (combo) {
    case 'Esc':
      return { pick, done: 'cancel' };
    case 'Enter':
      return { pick, done: 'confirm' };
    case 'Up':
      return { pick: { ...pick, cursor: Math.max(0, pick.cursor - 1) } };
    case 'Down':
      return { pick: { ...pick, cursor: Math.min(last, pick.cursor + 1) } };
    case 'Space': {
      const model = pick.models[pick.cursor];
      if (model === undefined || model.registered.length > 0) return { pick };
      const checked = pick.checked.includes(model.id)
        ? pick.checked.filter((id) => id !== model.id)
        : [...pick.checked, model.id];
      return { pick: { ...pick, checked } };
    }
    default:
      return { pick };
  }
}

/** What the list keeps once Enter took it. */
export function choiceOf(pick: ModelPick): ModelChoice {
  return {
    profileId: pick.profileId,
    offered: offeredModels(pick.models).map((model) => model.id),
    checked: [...pick.checked],
  };
}

/** One line of the list as a screen draws it. */
export interface ModelPickLine {
  readonly key: string;
  readonly text: string;
  readonly selected?: boolean;
  readonly dim?: boolean;
  readonly tone?: 'accent';
}

/**
 * The lines of the list. `keys` is the key of the text of the hint (the assistant's by default):
 * the tab Settings has its own, since there Esc writes nothing.
 */
export function modelPickLines(
  pick: ModelPick,
  t: TFunction,
  keys = 'setup.models.keys',
): readonly ModelPickLine[] {
  const lines: ModelPickLine[] = [
    { key: 'mp.title', text: t('setup.models.title', { profile: pick.profileId }), tone: 'accent' },
  ];
  pick.models.forEach((model, index) => {
    const registered = model.registered.length > 0;
    const box = registered ? '[=]' : pick.checked.includes(model.id) ? '[x]' : '[ ]';
    const name = model.name !== null && model.name !== model.id ? ` (${model.name})` : '';
    const tags = [
      ...(model.floating === null ? [] : [t(`setup.models.floating.${model.floating}`)]),
      ...(model.preset.length > 0 ? [t('setup.models.inPreset')] : []),
      ...(registered ? [t('setup.models.registered')] : []),
    ];
    lines.push({
      key: `mp.${String(index)}`,
      text: `${box} ${model.id}${name}${tags.length > 0 ? `  ${tags.join(', ')}` : ''}`,
      selected: index === pick.cursor,
      ...(registered ? { dim: true } : {}),
    });
  });
  lines.push({ key: 'mp.keys', text: t(keys), dim: true });
  return lines;
}

/** The accounts the run took in so far: the ones the detection kept, or the one of the flow. */
function accountsOf(done: readonly SetupDoneStep[]): ReadonlySet<string> {
  const accounts = new Set<string>();
  for (const step of done) {
    if (step.step === 'detect') for (const id of step.input.accounts ?? []) accounts.add(id);
    if (step.step === 'account') accounts.add(step.input.profileId);
  }
  return accounts;
}

/**
 * What the choices give the step of the Executors (N324). [proposta] The marks are matched by the
 * model id against what the run discovered, and not by the ids of the list: the preset chosen in
 * the run may not be the one in force when the list was read. An account the detection left out
 * gives nothing.
 */
export function seedOfChoices(
  run: SetupRunView,
  choices: Readonly<Record<string, ModelChoice>>,
): ExecutorsSeed {
  const accounts = accountsOf(run.done);
  const discovered = discoveredOfRun(run.done);
  const executors: SetupExecutorRequest[] = [];
  const exclude: string[] = [];
  for (const choice of Object.values(choices)) {
    if (!accounts.has(choice.profileId)) continue;
    for (const model of choice.offered) {
      const covered = discovered.filter(
        (executor) => executor.profileId === choice.profileId && executor.model === model,
      );
      const checked = choice.checked.includes(model);
      if (checked && covered.length === 0) executors.push({ profileId: choice.profileId, model });
      if (!checked) {
        for (const executor of covered) {
          if (!exclude.includes(executor.id)) exclude.push(executor.id);
        }
      }
    }
  }
  return { executors, exclude };
}
