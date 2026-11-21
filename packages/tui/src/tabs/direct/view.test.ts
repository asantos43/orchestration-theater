// SPDX-License-Identifier: MPL-2.0
import type { ApiDirectItem } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import {
  chosenExecutor,
  chosenWorkspace,
  conversationLines,
  editNew,
  itemLines,
  lastActorText,
  openBody,
  openNew,
  tailLines,
} from './view.js';

const say = (key: string, params?: Readonly<Record<string, string | number>>): string =>
  params === undefined ? key : `${key}${JSON.stringify(params)}`;

const message = (from: 'producer' | 'actor', text: string, streaming = false): ApiDirectItem => ({
  kind: 'message',
  turn: 1,
  at: 0,
  from,
  text,
  streaming,
});

describe('the form that opens a direct session', () => {
  it('starts on "the first that can take it" and the configured folder, so the body is empty', () => {
    const state = openNew(['a@x/one', 'b@x/two']);
    expect(chosenExecutor(state)).toBeUndefined();
    expect(chosenWorkspace(state)).toBeUndefined();
    expect(openBody(state)).toEqual({});
  });

  it('cycles the Executors and the folders with Left and Right, and changes field with Tab', () => {
    let state = openNew(['a@x/one', 'b@x/two']);
    state = editNew(state, 'Right');
    expect(chosenExecutor(state)).toBe('a@x/one');
    state = editNew(state, 'Right');
    expect(chosenExecutor(state)).toBe('b@x/two');
    state = editNew(state, 'Right');
    expect(chosenExecutor(state)).toBeUndefined();
    state = editNew(state, 'Left');
    expect(chosenExecutor(state)).toBe('b@x/two');
    state = editNew(state, 'Tab');
    expect(state.field).toBe('workspace');
    state = editNew(state, 'Right');
    state = editNew(state, 'Right');
    expect(chosenWorkspace(state)).toBe('readonly');
    expect(openBody(state)).toEqual({ executor: 'b@x/two', workspace: 'readonly' });
    expect(openBody(state, true)).toMatchObject({ confirm: true });
    state = editNew(state, 'Left');
    state = editNew(state, 'Left');
    state = editNew(state, 'Left');
    expect(chosenWorkspace(state)).toBe('scenario');
  });

  it('ignores a key it does not know and a form without Executors still cycles the folder', () => {
    const state = openNew([]);
    expect(editNew(state, 'x')).toBe(state);
    expect(editNew(state, undefined)).toBe(state);
    expect(editNew(state, 'Right').executorAt).toBe(-1);
  });
});

describe('the lines of the conversation', () => {
  it('indents the continuation of a message and marks the text still being written', () => {
    const lines = itemLines(message('actor', 'one two three four five six', true), 20, say);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]?.text.startsWith('direct.who.actor › ')).toBe(true);
    expect(lines[1]?.text.startsWith(' ')).toBe(true);
    expect(lines.at(-1)?.text.endsWith('▌')).toBe(true);
  });

  it('draws a barred decision as a warning and a failed tool as an error', () => {
    const decision = itemLines(
      {
        kind: 'decision',
        turn: 1,
        at: 0,
        title: 'Write a file',
        answered: 'reject',
        rule: 'readonly',
        reason: 'read only',
      },
      80,
      say,
    );
    expect(decision[0]?.tone).toBe('warn');
    expect(decision[0]?.text).toContain('direct.item.decision.reject');
    const tool = itemLines(
      { kind: 'tool', turn: 1, at: 0, toolCallId: 't', title: 'Edit', status: 'failed' },
      80,
      say,
    );
    expect(tool[0]).toMatchObject({ tone: 'error' });
    expect(tool[0]?.text).toContain('✗');
  });

  it('follows the end of the conversation and finds the last text of the Actor', () => {
    const items = [message('producer', 'hi'), message('actor', 'first'), message('actor', ' ')];
    expect(lastActorText(items)).toBe('first');
    expect(lastActorText([message('producer', 'hi')])).toBeUndefined();
    const lines = conversationLines(items, 40, say);
    expect(tailLines(lines, 2)).toEqual(lines.slice(-2));
    expect(tailLines(lines, 0)).toEqual([]);
    expect(tailLines(lines, 99)).toEqual(lines);
  });
});
