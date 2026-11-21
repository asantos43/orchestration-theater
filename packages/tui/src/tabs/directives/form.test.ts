// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  editForm,
  fieldsOf,
  moveField,
  openForm,
  problemOf,
  requestOf,
  ruleValueOf,
  textOf,
  validityOf,
  type FormState,
} from './form.js';

const SCENARIOS = [
  { id: 'S1', name: 'alpha' },
  { id: 'S2', name: 'beta' },
];

function type(form: FormState, text: string): FormState {
  return editForm(form, { combo: undefined, data: text });
}

function press(form: FormState, combo: string): FormState {
  return editForm(form, { combo, data: '' });
}

describe('the form to give an order', () => {
  it('starts on the text, with a global instruction and no validity', () => {
    const form = openForm('new', { scenarios: SCENARIOS });
    expect(form.active).toBe('text');
    expect(fieldsOf(form)).toEqual(['text', 'scope', 'kind', 'from', 'until', 'for']);
    expect(problemOf(form)).toBe('textRequired');
    const filled = type(form, '  Reply in Portuguese  ');
    expect(problemOf(filled)).toBeUndefined();
    expect(requestOf(filled)).toEqual({
      action: 'new',
      body: { text: 'Reply in Portuguese', scope: 'global', kind: 'instruction' },
    });
  });

  it('shows the scenario only for a local order, and drops it when the scope goes back', () => {
    let form = type(openForm('new', { scenarios: SCENARIOS }), 'only here');
    form = press(moveField(form, 1), 'Right');
    expect(form.choices.scope).toBe('local');
    expect(fieldsOf(form)).toContain('scenario');
    form = moveField(form, 1);
    expect(form.active).toBe('scenario');
    form = press(form, 'Right');
    expect(requestOf(form)).toMatchObject({
      body: { scope: 'local', scenarioId: 'S2', text: 'only here' },
    });
    form = press(moveField(form, -1), 'Left');
    expect(form.choices.scope).toBe('global');
    expect(fieldsOf(form)).not.toContain('scenario');
    expect(requestOf(form)).toMatchObject({ body: { scope: 'global' } });
    expect(JSON.stringify(requestOf(form))).not.toContain('scenarioId');
  });

  it('refuses a local order when there is no scenario to give it to', () => {
    let form = type(openForm('new', { scenarios: [] }), 'text');
    form = press(moveField(form, 1), 'Right');
    expect(problemOf(form)).toBe('scenarioRequired');
  });

  it('asks for the key and the value of a rule, and reads the value as JSON when it is JSON', () => {
    let form = type(openForm('new', { scenarios: SCENARIOS }), 'review everything');
    form = moveField(moveField(form, 1), 1);
    expect(form.active).toBe('kind');
    form = press(form, 'Space');
    expect(fieldsOf(form)).toEqual([
      'text',
      'scope',
      'kind',
      'ruleKey',
      'ruleValue',
      'from',
      'until',
      'for',
    ]);
    expect(problemOf(form)).toBe('ruleKeyRequired');
    form = type(moveField(form, 1), 'roles.actor.effort');
    expect(problemOf(form)).toBe('ruleValueRequired');
    form = type(moveField(form, 1), '"high"');
    expect(requestOf(form)).toMatchObject({
      body: { kind: 'rule', ruleKey: 'roles.actor.effort', ruleValue: 'high' },
    });
    expect(ruleValueOf('true')).toBe(true);
    expect(ruleValueOf('3')).toBe(3);
    expect(ruleValueOf('high')).toBe('high');
  });

  it('sends the validity as typed', () => {
    let form = type(openForm('new'), 'x');
    // text, scope and kind come first; then from, until and for.
    for (let i = 0; i < 3; i += 1) form = moveField(form, 1);
    expect(form.active).toBe('from');
    form = type(form, '2026-12-01 18:00');
    form = type(moveField(moveField(form, 1), 1), '3d');
    expect(form.active).toBe('for');
    expect(validityOf(form)).toEqual({ from: '2026-12-01 18:00', for: '3d' });
  });
});

describe('the other forms', () => {
  it('extends: the end, a span, or until revoked', () => {
    let form = openForm('extend', { orderId: 'O4' });
    expect(fieldsOf(form)).toEqual(['from', 'until', 'for', 'forever']);
    expect(requestOf(form)).toEqual({ action: 'extend', orderId: 'O4', validity: {} });
    form = type(moveField(moveField(form, 1), 1), '2d');
    expect(requestOf(form)).toEqual({ action: 'extend', orderId: 'O4', validity: { for: '2d' } });
    form = press(moveField(form, 1), 'Space');
    expect(requestOf(form)).toEqual({
      action: 'extend',
      orderId: 'O4',
      validity: { until: null, for: '2d' },
    });
  });

  it('suspends for one scenario, with an optional text and validity', () => {
    let form = openForm('suspend', { orderId: 'O2', scenarios: SCENARIOS });
    expect(form.active).toBe('scenario');
    expect(requestOf(form)).toEqual({
      action: 'suspend',
      orderId: 'O2',
      body: { scenarioId: 'S1' },
    });
    form = press(form, 'Right');
    form = type(moveField(form, 1), 'not in this one');
    form = type(moveField(moveField(moveField(form, 1), 1), 1), '1d');
    expect(requestOf(form)).toEqual({
      action: 'suspend',
      orderId: 'O2',
      body: { scenarioId: 'S2', text: 'not in this one', validity: { for: '1d' } },
    });
    expect(problemOf(openForm('suspend', { orderId: 'O2', scenarios: [] }))).toBe(
      'scenarioRequired',
    );
  });

  it('revokes with a reason', () => {
    let form = openForm('revoke', { orderId: 'O3' });
    expect(problemOf(form)).toBe('reasonRequired');
    form = type(form, 'no longer true');
    expect(requestOf(form)).toEqual({ action: 'revoke', orderId: 'O3', reason: 'no longer true' });
  });

  it('walks the fields with Tab, Down, Up and Shift+Tab, and stops at the ends', () => {
    let form = openForm('suspend', { orderId: 'O2', scenarios: SCENARIOS });
    form = press(form, 'Tab');
    expect(form.active).toBe('text');
    form = press(press(form, 'Down'), 'Shift+Tab');
    expect(form.active).toBe('text');
    expect(press(openForm('revoke', { orderId: 'O1' }), 'Up').active).toBe('reason');
    expect(textOf(openForm('revoke'), 'reason').value).toBe('');
  });

  it('gives back the same form for a key a field does not take', () => {
    const form = openForm('new');
    const choice = moveField(form, 1);
    expect(press(choice, 'F5')).toBe(choice);
    expect(type(choice, 'x')).toBe(choice);
  });
});
