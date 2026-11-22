// SPDX-License-Identifier: MPL-2.0
import type { CardModel, CardOption, CardStep } from './card.js';
import type { Translate } from './lines.js';

/**
 * The footer and the picker of the Director (Phase 9, P14, owner's decision N242). The footer shows
 * the Executor, the model and the effort the Director of the scenario runs with; the picker lists
 * the Executors of the role, the models and the efforts the client announces and the way back to
 * the default. Both read what `/director` answers (`data.director`) and act through the same
 * commands (`/director`, `/model`, `/effort`), so the TUI and the command give the same result.
 * This file is pure: the panel fetches the view and sends the commands.
 */

/** One Executor of the list of the role, as `/director` answers it (the part the TUI reads). */
export interface DirectorPickExecutor {
  readonly id: string;
  readonly validity: 'valid' | 'invalid';
  readonly invalidReason: string | null;
  readonly quota: string | null;
  readonly current: boolean;
  readonly isDefault: boolean;
}

/** The view of the Director of a scenario, as `/director` answers it (the part the TUI reads). */
export interface DirectorPickView {
  readonly session: 'open' | 'asleep' | 'opening' | 'none';
  readonly inTurn: boolean;
  readonly pending: boolean;
  readonly current: {
    readonly executor: string;
    readonly model: string;
    readonly effort: string | null;
  } | null;
  readonly overridden: boolean;
  readonly executors: readonly DirectorPickExecutor[];
  readonly models: readonly string[];
  readonly efforts: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function executorOf(raw: unknown): DirectorPickExecutor | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    validity: raw.validity === 'valid' ? 'valid' : 'invalid',
    invalidReason: typeof raw.invalidReason === 'string' ? raw.invalidReason : null,
    quota: typeof raw.quota === 'string' ? raw.quota : null,
    current: raw.current === true,
    isDefault: raw.isDefault === true,
  };
}

/** The view out of the `data` of the result of `/director`; `undefined` when it is not one. */
export function directorViewOf(data: unknown): DirectorPickView | undefined {
  if (!isRecord(data) || !isRecord(data.director)) return undefined;
  const raw = data.director;
  const session = raw.session;
  if (session !== 'open' && session !== 'asleep' && session !== 'opening' && session !== 'none') {
    return undefined;
  }
  const current = raw.current;
  return {
    session,
    inTurn: raw.inTurn === true,
    pending: raw.pending === true,
    current:
      isRecord(current) && typeof current.executor === 'string'
        ? {
            executor: current.executor,
            model: typeof current.model === 'string' ? current.model : '',
            effort: typeof current.effort === 'string' ? current.effort : null,
          }
        : null,
    overridden: raw.override !== null && raw.override !== undefined,
    executors: Array.isArray(raw.executors)
      ? raw.executors
          .map(executorOf)
          .filter((item): item is DirectorPickExecutor => item !== undefined)
      : [],
    models: Array.isArray(raw.models)
      ? raw.models.flatMap((item) =>
          isRecord(item) && typeof item.id === 'string' ? [item.id] : [],
        )
      : [],
    efforts: strings(raw.efforts),
  };
}

/** The line of the footer: what the Director runs with, where it comes from and the key of the picker. */
export function directorFooter(view: DirectorPickView, key: string, t: Translate): string {
  const { current } = view;
  if (current === null) return t('layout.chat.directorFooter.none', { key });
  const settings = [current.model, current.effort]
    .filter((item): item is string => item !== null && item !== '')
    .join(' / ');
  const wait = view.pending ? t('layout.chat.directorFooter.pending') : '';
  return t('layout.chat.directorFooter.line', {
    executor: current.executor,
    settings: settings === '' ? '' : ` [${settings}]`,
    source: t(`layout.chat.directorFooter.source.${view.overridden ? 'override' : 'default'}`),
    wait,
    key,
  });
}

/** What a pick of the picker asks of the daemon: a line of `/director`, `/model` or `/effort`. */
export function directorCommandOf(optionId: string): string | undefined {
  if (optionId === 'default') return '/director default';
  const at = optionId.indexOf(':');
  if (at < 0) return undefined;
  const kind = optionId.slice(0, at);
  const value = optionId.slice(at + 1);
  if (value === '') return undefined;
  if (kind === 'executor') return `/director ${value}`;
  if (kind === 'model') return `/model ${value}`;
  if (kind === 'effort') return `/effort ${value}`;
  return undefined;
}

/**
 * The picker as a card of one step (the card engine gives it the keys, the numbers and the clicks of
 * the decision card). The id of an option says what it is: `executor:<id>`, `model:<id>`,
 * `effort:<id>` or `default`.
 */
export function directorPickerModel(view: DirectorPickView, t: Translate): CardModel {
  const options: CardOption[] = [];
  const add = (id: string, label: string): void => {
    options.push({ id, label, description: '', text: 'none' });
  };
  for (const item of view.executors) {
    const flags = [
      item.current ? t('layout.chat.directorPicker.current') : '',
      item.isDefault ? t('layout.chat.directorPicker.isDefault') : '',
      item.validity === 'valid'
        ? ''
        : t('layout.chat.directorPicker.invalid', { reason: item.invalidReason ?? '' }),
      item.quota === null ? '' : t('layout.chat.directorPicker.quota', { state: item.quota }),
    ].filter((flag) => flag !== '');
    add(`executor:${item.id}`, `${item.id}${flags.length === 0 ? '' : `  (${flags.join('; ')})`}`);
  }
  for (const model of view.models) {
    add(`model:${model}`, t('layout.chat.directorPicker.model', { model }));
  }
  for (const effort of view.efforts) {
    add(`effort:${effort}`, t('layout.chat.directorPicker.effort', { effort }));
  }
  add('default', t('layout.chat.directorPicker.default'));
  const step: CardStep = {
    prompt: t('layout.chat.directorPicker.title'),
    lines: [],
    options,
    multi: false,
    freeText: false,
  };
  return {
    decisionId: 'director-picker',
    shape: 'menu',
    total: 1,
    stepAt: (index) => (index === 0 ? step : undefined),
    complete: (picks) => {
      const id = picks[0]?.optionIds[0];
      if (id === undefined) return undefined;
      return { answer: { option: id }, summary: id };
    },
  };
}
