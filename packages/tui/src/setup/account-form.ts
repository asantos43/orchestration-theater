// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import type { AddProfileBody } from '@otheater/protocol';
import type { TFunction } from 'i18next';

/**
 * The form "Adicionar conta" (N326, the owner on 2026-11-25: one form, the line of one row leaves
 * the TUI). The same pure form serves the tab Settings (the key A) and the setup assistant (its
 * step that adds an account, and Enter there while no account was added): what each key does to
 * it, what it sends and what it shows. Nothing here draws or calls the daemon.
 *
 * Its fields, in order: the client (only the ones ready on the machine; chosen already when there
 * is one), the name (`main` by default), the kind (subscription or API, swapped with Space), the
 * provider (asked only of OpenCode: the other clients have one possible provider) and the API key
 * (only for an API account, never shown). Enter adds; Esc drops the form.
 */

export type AccountKind = AddProfileBody['kind'];
export type AccountField = 'client' | 'name' | 'kind' | 'provider' | 'apiKey';

/** [proposta] The provider of a client that has only one (as `ot profile add`). */
export const ACCOUNT_DEFAULT_PROVIDER: Readonly<Record<string, string>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
};

/** [proposta] The name a new account takes unless the person writes another. */
export const ACCOUNT_DEFAULT_NAME = 'main';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PASTE_MARKS = new RegExp(String.raw`\u001b\[20[01]~`, 'g');

export interface AccountForm {
  /** The clients ready on the machine, in the order given (never empty). */
  readonly clients: readonly string[];
  readonly client: string;
  readonly name: string;
  /** The name is still the default, untouched: the first key typed replaces it instead of adding. */
  readonly nameDefault: boolean;
  readonly kind: AccountKind;
  /** What the person wrote as the provider (OpenCode only; the others take their own). */
  readonly provider: string;
  readonly apiKey: string;
  readonly field: AccountField;
  /** The field the last Enter found wrong, so the screen says why. */
  readonly problem: AccountField | undefined;
}

/**
 * A fresh form over the clients ready on the machine, with the cursor on the first field to fill;
 * `undefined` when no client is ready (the screen says so and opens nothing).
 */
export function accountFormStart(
  ready: readonly string[],
  preferred?: string,
): AccountForm | undefined {
  const clients = [...new Set(ready)];
  const first = clients[0];
  if (first === undefined) return undefined;
  const client = preferred !== undefined && clients.includes(preferred) ? preferred : first;
  return {
    clients,
    client,
    name: ACCOUNT_DEFAULT_NAME,
    nameDefault: true,
    kind: 'token_plan',
    provider: '',
    apiKey: '',
    // One client is chosen already: the cursor starts on the name.
    field: clients.length > 1 ? 'client' : 'name',
    problem: undefined,
  };
}

/** Whether the client takes a provider written by the person (no single provider of its own). */
export function asksProvider(client: string): boolean {
  return ACCOUNT_DEFAULT_PROVIDER[client] === undefined;
}

/** The fields the form shows now, in order: the provider and the key appear only where they apply. */
export function accountFields(form: AccountForm): readonly AccountField[] {
  const fields: AccountField[] = ['client', 'name', 'kind'];
  if (asksProvider(form.client)) fields.push('provider');
  if (form.kind === 'api') fields.push('apiKey');
  return fields;
}

/** The provider the account gets: the one written, or the client's own. */
export function accountProvider(form: AccountForm): string {
  return asksProvider(form.client) ? form.provider : (ACCOUNT_DEFAULT_PROVIDER[form.client] ?? '');
}

/** The first field that is wrong, or `undefined` when the form can be sent. */
export function accountProblem(form: AccountForm): AccountField | undefined {
  if (!form.clients.includes(form.client)) return 'client';
  if (!NAME_PATTERN.test(form.name)) return 'name';
  if (!PROVIDER_PATTERN.test(accountProvider(form))) return 'provider';
  if (form.kind === 'api' && form.apiKey.trim() === '') return 'apiKey';
  return undefined;
}

/** What the daemon is sent; `undefined` while a field is wrong. */
export function accountBody(form: AccountForm): AddProfileBody | undefined {
  if (accountProblem(form) !== undefined) return undefined;
  return {
    client: form.client,
    name: form.name,
    kind: form.kind,
    provider: accountProvider(form),
    ...(form.kind === 'api' ? { apiKey: form.apiKey.trim() } : {}),
  };
}

export type AccountFormStep =
  | { readonly form: AccountForm; readonly done?: undefined }
  | { readonly form: AccountForm; readonly done: 'submit'; readonly body: AddProfileBody }
  | { readonly form: AccountForm; readonly done: 'cancel' };

function cycle(list: readonly string[], current: string, delta: number): string {
  const at = list.indexOf(current);
  const next = ((((at < 0 ? 0 : at) + delta) % list.length) + list.length) % list.length;
  return list[next] ?? current;
}

function moved(form: AccountForm, delta: number): AccountForm {
  const fields = accountFields(form);
  const at = Math.max(0, fields.indexOf(form.field));
  const next = fields[Math.min(fields.length - 1, Math.max(0, at + delta))] ?? form.field;
  return { ...form, field: next };
}

/** The field the cursor stays on after a change hid it (a provider of a client that has its own). */
function kept(form: AccountForm): AccountForm {
  return accountFields(form).includes(form.field) ? form : { ...form, field: 'kind' };
}

/** A choice field (client, kind) moved by one, in either direction. */
function chosen(form: AccountForm, delta: number): AccountForm {
  if (form.field === 'client') {
    return kept({ ...form, client: cycle(form.clients, form.client, delta), problem: undefined });
  }
  if (form.field === 'kind') {
    return kept({
      ...form,
      kind: form.kind === 'token_plan' ? 'api' : 'token_plan',
      problem: undefined,
    });
  }
  return form;
}

type TextField = 'name' | 'provider' | 'apiKey';

function isText(field: AccountField): field is TextField {
  return field === 'name' || field === 'provider' || field === 'apiKey';
}

/**
 * What one key press does to the form. Tab and Down go to the next field, Shift+Tab and Up to the
 * one before; Space, Left and Right change a choice; a text field takes what is typed (no blank:
 * no name, provider or key has one), Backspace and Ctrl+U. Enter sends a form with every field
 * right, or puts the cursor on the first wrong one; Esc drops it.
 */
export function accountFormKey(
  form: AccountForm,
  combo: string | undefined,
  data: string,
): AccountFormStep {
  switch (combo) {
    case 'Esc':
      return { form, done: 'cancel' };
    case 'Enter': {
      const problem = accountProblem(form);
      const body = accountBody(form);
      if (problem !== undefined || body === undefined) {
        return { form: { ...form, field: problem ?? form.field, problem } };
      }
      return { form: { ...form, problem: undefined }, done: 'submit', body };
    }
    case 'Tab':
    case 'Down':
      return { form: moved(form, 1) };
    case 'Shift+Tab':
    case 'Up':
      return { form: moved(form, -1) };
    case 'Left':
      return { form: chosen(form, -1) };
    case 'Right':
      return { form: chosen(form, 1) };
    case 'Space':
      if (!isText(form.field)) return { form: chosen(form, 1) };
      return { form };
    default:
      break;
  }
  if (!isText(form.field)) return { form };
  const field = form.field;
  // The default name goes away whole at the first key that edits it.
  const fresh = field === 'name' && form.nameDefault;
  const value = fresh ? '' : form[field];
  const edited = { problem: undefined, ...(field === 'name' ? { nameDefault: false } : {}) };
  if (combo === 'Backspace') {
    return { form: { ...form, [field]: Array.from(value).slice(0, -1).join(''), ...edited } };
  }
  if (combo === 'Ctrl+U') return { form: { ...form, [field]: '', ...edited } };
  const text = data.replace(PASTE_MARKS, '').replace(/\s+/g, '');
  // Anything left that is a control character is a key, not text.
  // eslint-disable-next-line no-control-regex
  if (text === '' || /[\x00-\x1f\x7f]/.test(text)) return { form };
  return { form: { ...form, [field]: value + text, ...edited } };
}

/**
 * What the screen says when the daemon refused the client as one it cannot run (N326), in the
 * language of the screen; `undefined` for any other failure (the screen shows the daemon's text).
 */
export function unknownClientText(error: unknown, t: TFunction): string | undefined {
  if (!(error instanceof ApiRequestError)) return undefined;
  const details = error.details as
    { readonly reason?: unknown; readonly client?: unknown; readonly known?: unknown } | undefined;
  if (details?.reason !== 'unknown_client') return undefined;
  const known = Array.isArray(details.known) ? details.known.map(String).join(', ') : '';
  return t('accountForm.unknownClient', {
    client: typeof details.client === 'string' ? details.client : '',
    known,
  });
}

/** One line of the form as a screen draws it. */
export interface AccountFormLine {
  readonly key: string;
  readonly text: string;
  readonly selected?: boolean;
  readonly dim?: boolean;
  readonly tone?: 'accent' | 'warn';
}

/**
 * The lines of the form: a title, one line per field (the one under the cursor marked, a choice
 * with its options, a text with its caret), what the last Enter found wrong, and the keys.
 * `login` says whether Enter opens the login of a subscription right after adding it.
 */
export function accountFormLines(
  form: AccountForm,
  t: TFunction,
  options: { readonly login: boolean },
): readonly AccountFormLine[] {
  const lines: AccountFormLine[] = [
    { key: 'f.title', text: t('accountForm.title'), tone: 'accent' },
  ];
  const label = (field: AccountField): string => t(`accountForm.field.${field}`);
  const choice = (options: readonly string[], current: string): string =>
    options.map((option) => (option === current ? `[${option}]` : ` ${option} `)).join(' ');
  for (const field of accountFields(form)) {
    const here = form.field === field;
    let value: string;
    switch (field) {
      case 'client':
        value = form.clients.length > 1 ? choice(form.clients, form.client) : form.client;
        break;
      case 'kind':
        value = choice(
          [t('accountForm.kind.token_plan'), t('accountForm.kind.api')],
          t(`accountForm.kind.${form.kind}`),
        );
        break;
      case 'apiKey':
        value = '•'.repeat(Array.from(form.apiKey).length);
        break;
      default:
        value = form[field];
        break;
    }
    lines.push({
      key: `f.${field}`,
      text: `${label(field)}: ${value}${here && isText(field) ? '▏' : ''}`,
      selected: here,
    });
  }
  if (!asksProvider(form.client)) {
    lines.push({
      key: 'f.providerOwn',
      text: t('accountForm.providerOwn', { provider: accountProvider(form) }),
      dim: true,
    });
  }
  if (form.problem !== undefined) {
    lines.push({ key: 'f.problem', text: t(`accountForm.problem.${form.problem}`), tone: 'warn' });
  }
  lines.push({
    key: 'f.keys',
    text: t(
      form.kind === 'token_plan' && options.login ? 'accountForm.keysLogin' : 'accountForm.keys',
    ),
    dim: true,
  });
  return lines;
}
