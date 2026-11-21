// SPDX-License-Identifier: MPL-2.0
import type { CreateOrderBody, OrderValidity } from '@otheater/protocol';
import { EMPTY_LINE, editLine, type LineKey, type LineState } from './line-input.js';

/**
 * The forms of the tab Directives: give an order, extend it, suspend it for one scenario, revoke
 * it. Pure: a form is a value, keys change it, and `requestOf` turns it into what goes to the
 * daemon. The daemon has the last word on the validity (dates in the zone of the order,
 * `for` from the start or from the current end), so the fields here are the words the Producer
 * writes (`2026-12-01 18:00`, `3d`) and are sent as typed.
 */

export type FormAction = 'new' | 'extend' | 'suspend' | 'revoke';

export type FieldId =
  | 'text'
  | 'scope'
  | 'scenario'
  | 'kind'
  | 'ruleKey'
  | 'ruleValue'
  | 'from'
  | 'until'
  | 'for'
  | 'forever'
  | 'reason';

/** The fields that pick one of a few values (Left, Right and Space change them). */
const CHOICES: Readonly<Partial<Record<FieldId, readonly string[]>>> = {
  scope: ['global', 'local'],
  kind: ['instruction', 'rule'],
  forever: ['no', 'yes'],
};

export interface ScenarioChoice {
  readonly id: string;
  readonly name: string;
}

export interface FormState {
  readonly action: FormAction;
  /** The order extended, suspended or revoked. */
  readonly orderId?: string | undefined;
  /** What the order is called in the title of the form (its id, and the start of its text). */
  readonly subject?: string | undefined;
  readonly scenarios: readonly ScenarioChoice[];
  readonly texts: Readonly<Partial<Record<FieldId, LineState>>>;
  readonly choices: Readonly<Partial<Record<FieldId, string>>>;
  readonly active: FieldId;
}

export interface OpenFormOptions {
  readonly orderId?: string | undefined;
  readonly subject?: string | undefined;
  readonly scenarios?: readonly ScenarioChoice[] | undefined;
}

/** The fields the form shows now, top to bottom (some depend on the choices). */
export function fieldsOf(form: FormState): readonly FieldId[] {
  switch (form.action) {
    case 'new':
      return [
        'text',
        'scope',
        ...(form.choices.scope === 'local' ? (['scenario'] as const) : []),
        'kind',
        ...(form.choices.kind === 'rule' ? (['ruleKey', 'ruleValue'] as const) : []),
        'from',
        'until',
        'for',
      ];
    case 'extend':
      return ['from', 'until', 'for', 'forever'];
    case 'suspend':
      return ['scenario', 'text', 'from', 'until', 'for'];
    case 'revoke':
      return ['reason'];
  }
}

export function choiceOptions(form: FormState, field: FieldId): readonly string[] {
  if (field === 'scenario') return form.scenarios.map((scenario) => scenario.id);
  return CHOICES[field] ?? [];
}

export function isChoice(field: FieldId): boolean {
  return field === 'scenario' || CHOICES[field] !== undefined;
}

export function openForm(action: FormAction, options: OpenFormOptions = {}): FormState {
  const scenarios = options.scenarios ?? [];
  const form: FormState = {
    action,
    orderId: options.orderId,
    subject: options.subject,
    scenarios,
    texts: {},
    choices: {
      scope: 'global',
      kind: 'instruction',
      forever: 'no',
      ...(scenarios[0] === undefined ? {} : { scenario: scenarios[0].id }),
    },
    active: 'text',
  };
  return { ...form, active: fieldsOf(form)[0] ?? 'text' };
}

export function textOf(form: FormState, field: FieldId): LineState {
  return form.texts[field] ?? EMPTY_LINE;
}

/** Moves to the next (`1`) or the previous (`-1`) field, stopping at the ends. */
export function moveField(form: FormState, delta: 1 | -1): FormState {
  const fields = fieldsOf(form);
  const at = Math.max(0, fields.indexOf(form.active));
  const next = fields[Math.min(fields.length - 1, Math.max(0, at + delta))] ?? form.active;
  return next === form.active ? form : { ...form, active: next };
}

function cycle(form: FormState, field: FieldId, delta: 1 | -1): FormState {
  const options = choiceOptions(form, field);
  if (options.length === 0) return form;
  const current = Math.max(0, options.indexOf(form.choices[field] ?? ''));
  const next = options[(current + delta + options.length) % options.length];
  if (next === undefined) return form;
  const changed: FormState = { ...form, choices: { ...form.choices, [field]: next } };
  // A field that went away (the scenario after "global") cannot stay the active one.
  return fieldsOf(changed).includes(changed.active) ? changed : moveField(changed, -1);
}

/**
 * One key in the active field. Tab and Down go to the next field, Shift+Tab and Up to the
 * previous one; in a choice, Left, Right and Space change the value; in a text, the key edits it.
 * The same form comes back for a key the field does not take.
 */
export function editForm(form: FormState, key: LineKey): FormState {
  switch (key.combo) {
    case 'Tab':
    case 'Down':
      return moveField(form, 1);
    case 'Shift+Tab':
    case 'Up':
      return moveField(form, -1);
    default:
      break;
  }
  if (isChoice(form.active)) {
    if (key.combo === 'Right' || key.combo === 'Space') return cycle(form, form.active, 1);
    if (key.combo === 'Left') return cycle(form, form.active, -1);
    return form;
  }
  const line = textOf(form, form.active);
  const edited = editLine(line, key);
  return edited === line ? form : { ...form, texts: { ...form.texts, [form.active]: edited } };
}

/** What is wrong with the form, as a key of the catalog, or `undefined` when it can go. */
export type FormProblem =
  'textRequired' | 'scenarioRequired' | 'ruleKeyRequired' | 'ruleValueRequired' | 'reasonRequired';

function trimmed(form: FormState, field: FieldId): string {
  return textOf(form, field).value.trim();
}

export function problemOf(form: FormState): FormProblem | undefined {
  switch (form.action) {
    case 'new':
      if (trimmed(form, 'text') === '') return 'textRequired';
      if (form.choices.scope === 'local' && form.choices.scenario === undefined)
        return 'scenarioRequired';
      if (form.choices.kind === 'rule') {
        if (trimmed(form, 'ruleKey') === '') return 'ruleKeyRequired';
        if (trimmed(form, 'ruleValue') === '') return 'ruleValueRequired';
      }
      return undefined;
    case 'suspend':
      return form.choices.scenario === undefined ? 'scenarioRequired' : undefined;
    case 'revoke':
      return trimmed(form, 'reason') === '' ? 'reasonRequired' : undefined;
    case 'extend':
      return undefined;
  }
}

/** The value of a rule as the Producer typed it: JSON when it is JSON (`true`, `3`, `"a"`), the text otherwise. */
export function ruleValueOf(text: string): CreateOrderBody['ruleValue'] {
  const value = text.trim();
  try {
    return JSON.parse(value) as CreateOrderBody['ruleValue'];
  } catch {
    return value;
  }
}

/** The validity the fields say, or `undefined` when they are all empty. */
export function validityOf(form: FormState): OrderValidity | undefined {
  const from = trimmed(form, 'from');
  const until = trimmed(form, 'until');
  const span = trimmed(form, 'for');
  const validity: OrderValidity = {
    ...(from === '' ? {} : { from }),
    ...(form.choices.forever === 'yes' ? { until: null } : until === '' ? {} : { until }),
    ...(span === '' ? {} : { for: span }),
  };
  return Object.keys(validity).length === 0 ? undefined : validity;
}

export type OrderRequest =
  | { readonly action: 'new'; readonly body: CreateOrderBody }
  | { readonly action: 'extend'; readonly orderId: string; readonly validity: OrderValidity }
  | {
      readonly action: 'suspend';
      readonly orderId: string;
      readonly body: {
        readonly scenarioId: string;
        readonly text?: string;
        readonly validity?: OrderValidity;
      };
    }
  | { readonly action: 'revoke'; readonly orderId: string; readonly reason: string };

/** What goes to the daemon. Call it only when `problemOf` found nothing. */
export function requestOf(form: FormState): OrderRequest | undefined {
  const validity = validityOf(form);
  switch (form.action) {
    case 'new': {
      const local = form.choices.scope === 'local';
      const rule = form.choices.kind === 'rule';
      return {
        action: 'new',
        body: {
          text: trimmed(form, 'text'),
          scope: local ? 'local' : 'global',
          ...(local && form.choices.scenario !== undefined
            ? { scenarioId: form.choices.scenario }
            : {}),
          kind: rule ? 'rule' : 'instruction',
          ...(rule
            ? {
                ruleKey: trimmed(form, 'ruleKey'),
                ruleValue: ruleValueOf(trimmed(form, 'ruleValue')),
              }
            : {}),
          ...(validity === undefined ? {} : { validity }),
        },
      };
    }
    case 'extend':
      if (form.orderId === undefined) return undefined;
      // An empty form is no change: the daemon refuses it with its own words.
      return { action: 'extend', orderId: form.orderId, validity: validity ?? {} };
    case 'suspend': {
      if (form.orderId === undefined || form.choices.scenario === undefined) return undefined;
      const text = trimmed(form, 'text');
      return {
        action: 'suspend',
        orderId: form.orderId,
        body: {
          scenarioId: form.choices.scenario,
          ...(text === '' ? {} : { text }),
          ...(validity === undefined ? {} : { validity }),
        },
      };
    }
    case 'revoke':
      if (form.orderId === undefined) return undefined;
      return { action: 'revoke', orderId: form.orderId, reason: trimmed(form, 'reason') };
  }
}
