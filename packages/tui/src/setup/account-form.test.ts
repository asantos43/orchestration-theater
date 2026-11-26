// SPDX-License-Identifier: MPL-2.0
import { ApiRequestError } from '@otheater/client';
import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_DEFAULT_NAME,
  accountBody,
  accountFields,
  accountFormKey,
  accountFormLines,
  accountFormStart,
  accountProblem,
  type AccountForm,
  unknownClientText,
} from './account-form.js';

/** A `t` that shows the key and its values, so a test reads what the screen would ask for. */
const t = ((key: string, values?: Record<string, unknown>) =>
  values === undefined ? key : `${key} ${JSON.stringify(values)}`) as unknown as TFunction;

function start(ready: readonly string[], preferred?: string): AccountForm {
  const form = accountFormStart(ready, preferred);
  if (form === undefined) throw new Error('no form');
  return form;
}

/** The form after the keys, each `[combo, data]`; a bare string is typed text. */
function keys(form: AccountForm, ...steps: readonly (string | readonly [string, string?])[]) {
  let current = form;
  for (const step of steps) {
    const [combo, data] = typeof step === 'string' ? [undefined, step] : [step[0], step[1] ?? ''];
    current = accountFormKey(current, combo, data).form;
  }
  return current;
}

describe('accountFormStart', () => {
  it('opens nothing when no client is ready', () => {
    expect(accountFormStart([])).toBeUndefined();
  });

  it('starts on the client with several, on the name with one', () => {
    expect(start(['claude-code', 'codex']).field).toBe('client');
    const one = start(['codex']);
    expect(one.field).toBe('name');
    expect(one.client).toBe('codex');
    expect(one.name).toBe(ACCOUNT_DEFAULT_NAME);
    expect(one.kind).toBe('token_plan');
  });

  it('takes the preferred client when it is ready, and drops repeated ones', () => {
    expect(start(['claude-code', 'codex'], 'codex').client).toBe('codex');
    expect(start(['claude-code', 'codex'], 'opencode').client).toBe('claude-code');
    expect(start(['codex', 'codex']).clients).toEqual(['codex']);
  });
});

describe('accountFormKey', () => {
  it('replaces the default name at the first key, then adds to it', () => {
    const form = keys(start(['codex']), 'w', 'ork');
    expect(form.name).toBe('work');
    expect(form.nameDefault).toBe(false);
    // Backspace on the untouched default clears it too.
    expect(keys(start(['codex']), ['Backspace']).name).toBe('');
    expect(keys(start(['codex']), 'ab', ['Backspace']).name).toBe('a');
  });

  it('keeps the default name when the person goes past it', () => {
    const form = keys(start(['codex']), ['Tab'], ['Shift+Tab']);
    expect(form.name).toBe(ACCOUNT_DEFAULT_NAME);
    expect(accountBody(form)).toEqual({
      client: 'codex',
      name: 'main',
      kind: 'token_plan',
      provider: 'openai',
    });
  });

  it('cycles a choice with Space, Left and Right', () => {
    const form = start(['claude-code', 'codex', 'opencode']);
    expect(keys(form, ['Space']).client).toBe('codex');
    expect(keys(form, ['Left']).client).toBe('opencode');
    expect(keys(form, ['Right'], ['Right'], ['Right']).client).toBe('claude-code');
    const kind = keys(form, ['Tab'], ['Tab']);
    expect(kind.field).toBe('kind');
    expect(keys(kind, ['Space']).kind).toBe('api');
    expect(keys(kind, ['Space'], ['Space']).kind).toBe('token_plan');
  });

  it('asks the provider only of OpenCode, and the key only of an API account', () => {
    expect(accountFields(start(['codex']))).toEqual(['client', 'name', 'kind']);
    expect(accountFields(start(['opencode']))).toEqual(['client', 'name', 'kind', 'provider']);
    const api = keys(start(['codex']), ['Tab'], ['Space']);
    expect(accountFields(api)).toEqual(['client', 'name', 'kind', 'apiKey']);
  });

  it('moves the cursor off a provider the new client does not ask', () => {
    const form = keys(start(['opencode', 'codex']), ['Tab'], ['Tab'], ['Tab']);
    expect(form.field).toBe('provider');
    const back = keys(form, ['Shift+Tab'], ['Shift+Tab'], ['Shift+Tab'], ['Space']);
    expect(back.client).toBe('codex');
    expect(keys(back, ['Tab'], ['Tab'], ['Tab']).field).toBe('kind');
  });

  it('takes no blanks and no control characters in a text field', () => {
    const form = keys(start(['codex']), 'my work', '\u001b[200~x\u001b[201~');
    expect(form.name).toBe('myworkx');
    expect(keys(form, '\u0007').name).toBe('myworkx');
    expect(keys(form, ['Ctrl+U']).name).toBe('');
  });

  it('puts the cursor on the first wrong field at Enter, and sends a right form', () => {
    const wrong = keys(start(['codex']), 'Work');
    const step = accountFormKey(wrong, 'Enter', '');
    expect(step.done).toBeUndefined();
    expect(step.form.problem).toBe('name');
    const noProvider = accountFormKey(keys(start(['opencode'])), 'Enter', '');
    expect(noProvider.form.problem).toBe('provider');
    expect(noProvider.form.field).toBe('provider');
    const noKey = accountFormKey(keys(start(['codex']), ['Tab'], ['Space']), 'Enter', '');
    expect(noKey.form.problem).toBe('apiKey');
    const api = keys(start(['codex']), ['Tab'], ['Space'], ['Tab'], 'sk-fake');
    const sent = accountFormKey(api, 'Enter', '');
    expect(sent.done).toBe('submit');
    expect(sent.done === 'submit' ? sent.body : undefined).toEqual({
      client: 'codex',
      name: 'main',
      kind: 'api',
      provider: 'openai',
      apiKey: 'sk-fake',
    });
  });

  it('clears the problem at the next edit, and Esc drops the form', () => {
    const wrong = accountFormKey(keys(start(['codex']), 'Work'), 'Enter', '').form;
    expect(keys(wrong, ['Backspace']).problem).toBeUndefined();
    expect(accountFormKey(wrong, 'Esc', '').done).toBe('cancel');
  });

  it('refuses a client that is not one of the ready ones', () => {
    expect(accountProblem({ ...start(['codex']), client: 'other' })).toBe('client');
  });
});

describe('accountFormLines', () => {
  it('shows one choice with its options, the caret and the masked key', () => {
    const form = keys(start(['claude-code', 'codex']), ['Tab'], ['Tab'], ['Space'], ['Tab'], 'abc');
    const text = accountFormLines(form, t, { login: true }).map((line) => line.text);
    expect(text[0]).toBe('accountForm.title');
    expect(text).toContain('accountForm.field.client: [claude-code]  codex ');
    expect(text).toContain('accountForm.field.apiKey: •••▏');
    expect(text.at(-1)).toBe('accountForm.keys');
  });

  it('says the login opens only for a subscription with the login on', () => {
    const lines = (login: boolean) =>
      accountFormLines(start(['codex']), t, { login }).map((line) => line.text);
    expect(lines(true).at(-1)).toBe('accountForm.keysLogin');
    expect(lines(false).at(-1)).toBe('accountForm.keys');
    expect(lines(true)).toContain('accountForm.providerOwn {"provider":"openai"}');
  });
});

describe('unknownClientText', () => {
  it('reads the details of the daemon, and nothing else', () => {
    const error = new ApiRequestError({
      status: 400,
      body: {
        code: 'invalid_input',
        message: 'unknown client',
        details: { reason: 'unknown_client', client: 'other', known: ['claude-code', 'codex'] },
      },
    });
    expect(unknownClientText(error, t)).toBe(
      'accountForm.unknownClient {"client":"other","known":"claude-code, codex"}',
    );
    const other = new ApiRequestError({
      status: 400,
      body: { code: 'invalid_input', message: 'x' },
    });
    expect(unknownClientText(other, t)).toBeUndefined();
    expect(unknownClientText(new Error('x'), t)).toBeUndefined();
  });
});
