// SPDX-License-Identifier: MPL-2.0
import { DEFAULT_UI_REGISTRY, resolveKeymapFromConfig } from '@otheater/client';
import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { actionOf, comboOf, typedText } from './keys.js';

const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const key = (flags: Partial<Key> = {}): Key => ({ ...NO_KEY, ...flags });

const keymapOf = (
  preset: 'agents' | 'classic',
  overrides: Record<string, string | string[]> = {},
) =>
  resolveKeymapFromConfig(
    DEFAULT_UI_REGISTRY,
    { preset, environment: 'auto', overrides },
    { platform: 'other', tmux: false, vscode: false },
  ).keymap;

describe('from a key of Ink to a combination', () => {
  it.each<[string, string, Key, string]>([
    ['Enter', '\r', key({ return: true }), 'Enter'],
    ['Shift+Enter', '\r', key({ return: true, shift: true }), 'Shift+Enter'],
    ['Alt+Enter', '\r', key({ return: true, meta: true }), 'Alt+Enter'],
    ['Ctrl+J, the line feed', '\n', key(), 'Ctrl+J'],
    ['Up', '', key({ upArrow: true }), 'Up'],
    ['Down', '', key({ downArrow: true }), 'Down'],
    ['Left', '', key({ leftArrow: true }), 'Left'],
    ['Ctrl+Left', '', key({ leftArrow: true, ctrl: true }), 'Ctrl+Left'],
    ['Ctrl+Right', '', key({ rightArrow: true, ctrl: true }), 'Ctrl+Right'],
    ['Home', '', key({ home: true }), 'Home'],
    ['End', '', key({ end: true }), 'End'],
    ['Esc', '', key({ escape: true }), 'Esc'],
    ['Backspace', '', key({ backspace: true }), 'Backspace'],
    ['Delete', '', key({ delete: true }), 'Delete'],
    ['Alt+Backspace', '', key({ backspace: true, meta: true }), 'Alt+Backspace'],
    ['Ctrl+K', 'k', key({ ctrl: true }), 'Ctrl+K'],
    ['Ctrl+R', 'r', key({ ctrl: true }), 'Ctrl+R'],
    ['Ctrl+G', 'g', key({ ctrl: true }), 'Ctrl+G'],
    ['Ctrl+V', 'v', key({ ctrl: true }), 'Ctrl+V'],
    ['Alt+D', 'd', key({ meta: true }), 'Alt+D'],
    ['Alt+B', 'b', key({ meta: true }), 'Alt+B'],
  ])('%s', (_name, input, flags, expected) => {
    expect(comboOf(input, flags)).toBe(expected);
  });

  it('does not make a combination of a plain character, of a capital letter or of a release', () => {
    expect(comboOf('a', key())).toBeUndefined();
    expect(comboOf('A', key({ shift: true }))).toBeUndefined();
    expect(comboOf('k', key({ ctrl: true, eventType: 'release' }))).toBeUndefined();
    expect(comboOf('', key({ return: true, eventType: 'release' }))).toBeUndefined();
  });
});

describe('from a key to an action of the box', () => {
  const agents = keymapOf('agents');

  it.each<[string, string, Key, string]>([
    ['input.submit', '\r', key({ return: true }), 'input.submit'],
    ['input.newline by Ctrl+J', '\n', key(), 'input.newline'],
    ['input.newline by Shift+Enter', '\r', key({ return: true, shift: true }), 'input.newline'],
    ['input.newline by Alt+Enter', '\r', key({ return: true, meta: true }), 'input.newline'],
    ['input.up', '', key({ upArrow: true }), 'input.up'],
    ['input.killToEnd', 'k', key({ ctrl: true }), 'input.killToEnd'],
    ['input.historySearch', 'r', key({ ctrl: true }), 'input.historySearch'],
    ['input.externalEditor', 'g', key({ ctrl: true }), 'input.externalEditor'],
    ['input.pasteImage', 'v', key({ ctrl: true }), 'input.pasteImage'],
    ['input.cancel', '', key({ escape: true }), 'input.cancel'],
  ])('%s', (_name, input, flags, expected) => {
    expect(actionOf(agents, DEFAULT_UI_REGISTRY, input, flags)).toBe(expected);
  });

  it('follows the preset and the overrides', () => {
    expect(
      actionOf(keymapOf('classic'), DEFAULT_UI_REGISTRY, 'k', key({ ctrl: true })),
    ).toBeUndefined();
    const moved = keymapOf('agents', { 'input.newline': 'Ctrl+T' });
    expect(actionOf(moved, DEFAULT_UI_REGISTRY, 't', key({ ctrl: true }))).toBe('input.newline');
    expect(actionOf(moved, DEFAULT_UI_REGISTRY, '\n', key())).toBeUndefined();
  });
});

describe('the text a key types', () => {
  it('is the character, and nothing for shortcuts, for the line feed and for named keys', () => {
    expect(typedText('a', key())).toBe('a');
    expect(typedText('A', key({ shift: true }))).toBe('A');
    expect(typedText('ç', key())).toBe('ç');
    expect(typedText('k', key({ ctrl: true }))).toBeUndefined();
    expect(typedText('d', key({ meta: true }))).toBeUndefined();
    expect(typedText('\n', key())).toBeUndefined();
    expect(typedText('', key({ upArrow: true }))).toBeUndefined();
    expect(typedText('a', key({ eventType: 'release' }))).toBeUndefined();
  });
});
