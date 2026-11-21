// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  buildCard,
  cardKey,
  cardKeyOf,
  cardLines,
  createCardState,
  type CardAnswer,
  type CardKey,
  type CardKeymap,
  type CardModel,
  type CardState,
  type CardTexts,
} from './card.js';
import type { PendingAsk } from './model.js';

const texts: CardTexts = {
  title: 'Decision',
  other: 'Other',
  keepPrompt: 'Which ideas?',
  option: (id) => `opt:${id}`,
  idea: (id, text) => `${id} ${text}`,
  leftOut: (id, reason) => `out ${id} ${reason}`,
  need: (need) => `need ${need}`,
  shell: (shell) => ({
    prompt: `Send ! ${shell.command}?`,
    lines: [`code ${String(shell.exitCode)}, ${String(shell.lines)} lines`],
    send: 'Send it',
    sendDescription: 'The Director reads it',
    keep: 'Keep it here',
    keepDescription: 'Only the chat',
  }),
};

const down: CardKey = { kind: 'down' };
const up: CardKey = { kind: 'up' };
const enter: CardKey = { kind: 'enter' };
const space: CardKey = { kind: 'space' };
const type = (text: string): CardKey => ({ kind: 'text', text });

/** Plays the keys; returns the state and the answer, when the keys gave one. */
function play(
  model: CardModel,
  keys: readonly CardKey[],
): { state: CardState; done: CardAnswer | undefined; aside: boolean } {
  let state = createCardState(model);
  let done: CardAnswer | undefined;
  let aside = false;
  for (const key of keys) {
    const result = cardKey(model, state, key);
    state = result.state;
    if (result.done !== undefined) done = result.done;
    if (result.aside === true) aside = true;
  }
  return { state, done, aside };
}

const ask = (kind: string, input: Record<string, unknown>): PendingAsk => ({
  decisionId: 'D1',
  kind,
  playId: null,
  input,
});

const question = (options: string[], multi = false): PendingAsk =>
  ask('producer_question', {
    questions: [
      {
        question: 'Which one?',
        options: options.map((label) => ({ label, description: `about ${label}` })),
        multi_select: multi,
      },
    ],
  });

describe('a question with a list', () => {
  const model = buildCard(question(['red', 'blue']), texts);

  it('answers with Enter on the option under the cursor', () => {
    expect(play(model, [down, enter]).done?.answer).toEqual({ answers: ['blue'] });
  });

  it('answers with a number key', () => {
    expect(play(model, [type('1')]).done?.answer).toEqual({ answers: ['red'] });
  });

  it('wraps the cursor around the list', () => {
    expect(play(model, [up]).state.cursor).toBe(2);
    expect(play(model, [up, down]).state.cursor).toBe(0);
  });

  it('ignores a number past the list', () => {
    const result = play(model, [type('9')]);
    expect(result.done).toBeUndefined();
  });

  it('takes the text of "other" before it answers', () => {
    const typed = play(model, [type('3')]);
    expect(typed.state.typing).toBe(true);
    // Enter with no text does nothing yet.
    expect(play(model, [type('3'), enter]).done).toBeUndefined();
    const done = play(model, [type('3'), type('g'), type('o'), space, type('x'), enter]).done;
    expect(done?.answer).toEqual({ answers: ['go x'] });
  });

  it('goes back out of the text with Esc and edits it with Backspace', () => {
    const out = play(model, [type('3'), { kind: 'esc' }]);
    expect(out.state.typing).toBe(false);
    const edited = play(model, [type('3'), type('a'), type('b'), { kind: 'backspace' }, enter]);
    expect(edited.done?.answer).toEqual({ answers: ['a'] });
  });

  it('sets the card aside with Esc when nothing is typed', () => {
    expect(play(model, [{ kind: 'esc' }]).aside).toBe(true);
  });
});

describe('a multiple choice', () => {
  const model = buildCard(question(['a', 'b', 'c'], true), texts);

  it('marks with Space or a number and answers with Enter', () => {
    const done = play(model, [space, down, down, space, enter]).done;
    expect(done?.answer).toEqual({ answers: ['a, c'] });
    expect(play(model, [type('2'), type('3'), enter]).done?.answer).toEqual({ answers: ['b, c'] });
  });

  it('unmarks with a second Space and takes the option under the cursor when none is marked', () => {
    expect(play(model, [space, space, enter]).done?.answer).toEqual({ answers: ['a'] });
  });
});

describe('a question with no list', () => {
  const model = buildCard(ask('producer_question', { questions: [{ question: 'Name?' }] }), texts);

  it('starts typing and answers with the text', () => {
    expect(createCardState(model).typing).toBe(true);
    expect(play(model, [type('A'), type('d'), type('a'), enter]).done?.answer).toEqual({
      answers: ['Ada'],
    });
  });
});

describe('a question with two steps', () => {
  const model = buildCard(
    ask('producer_question', {
      questions: [
        { question: 'One?', options: [{ label: 'x', description: '' }] },
        { question: 'Two?', options: [{ label: 'y', description: '' }] },
      ],
    }),
    texts,
  );

  it('moves to the second step and answers with both', () => {
    const first = play(model, [enter]);
    expect(first.done).toBeUndefined();
    expect(first.state.step).toBe(1);
    expect(play(model, [enter, enter]).done?.answer).toEqual({ answers: ['x', 'y'] });
  });
});

describe('the menu of a play', () => {
  const model = buildCard(
    ask('producer_menu', { options: ['redefine_need', 'cancel'], reason: 'Attempts ran out' }),
    texts,
  );

  it('answers an option that needs no text at once', () => {
    expect(play(model, [down, enter]).done?.answer).toEqual({ option: 'cancel' });
  });

  it('asks the new need for redefine_need and sends it as `need`', () => {
    expect(play(model, [enter]).done).toBeUndefined();
    const done = play(model, [enter, type('n'), type('2'), enter]).done;
    expect(done?.answer).toEqual({ option: 'redefine_need', need: 'n2' });
  });
});

describe('the ideas of a group', () => {
  const model = buildCard(
    ask('ideas.group', {
      rationale: 'they go together',
      ideas: [
        { id: 'I1', text: 'one' },
        { id: 'I2', text: 'two' },
      ],
    }),
    texts,
  );

  it('approves, refuses with an optional reason and edits with a required need', () => {
    expect(play(model, [enter]).done?.answer).toEqual({ option: 'approve' });
    expect(play(model, [down, enter, enter]).done?.answer).toEqual({ option: 'refuse' });
    expect(play(model, [down, enter, type('n'), enter]).done?.answer).toEqual({
      option: 'refuse',
      reason: 'n',
    });
    expect(play(model, [down, down, enter, enter]).done).toBeUndefined();
  });

  it('keeps some of the ideas on a second step', () => {
    const done = play(model, [type('4'), down, space, enter]).done;
    expect(done?.answer).toEqual({ option: 'edit', ideaIds: ['I2'] });
  });
});

describe('cardKeyOf', () => {
  /** The default keys of the registry, as `TuiKeymap.match` would answer for the two contexts. */
  const defaults: CardKeymap = {
    decision: (combo) =>
      ({
        Up: 'decision.up',
        Down: 'decision.down',
        Space: 'decision.mark',
        Enter: 'decision.answer',
        Esc: 'decision.aside',
      })[combo],
    textBox: (combo) => (combo === 'Backspace' ? 'input.backspace' : undefined),
  };

  it('maps the combos of the card and printable text, and drops control bytes', () => {
    expect(cardKeyOf({ combo: 'Up', data: '\x1b[A' }, defaults, false)).toEqual({ kind: 'up' });
    expect(cardKeyOf({ combo: 'Backspace', data: '\x7f' }, defaults, true)).toEqual({
      kind: 'backspace',
    });
    expect(cardKeyOf({ combo: undefined, data: 'a' }, defaults, false)).toEqual({
      kind: 'text',
      text: 'a',
    });
    expect(cardKeyOf({ combo: undefined, data: '\x01' }, defaults, false)).toBeUndefined();
  });

  it('reads the keys from the keymap: a remapped key acts and the old one does not (N203)', () => {
    // `ui.keymap.overrides`: decision.down on J, decision.answer on Ctrl+Y, decision.up taken away.
    const remapped: CardKeymap = {
      decision: (combo) =>
        ({ J: 'decision.down', 'Ctrl+Y': 'decision.answer', Space: 'decision.mark' })[combo],
      textBox: () => undefined,
    };
    expect(cardKeyOf({ combo: 'J', data: 'j' }, remapped, false)).toEqual({ kind: 'down' });
    expect(cardKeyOf({ combo: 'Ctrl+Y', data: '\x19' }, remapped, false)).toEqual({
      kind: 'enter',
    });
    expect(cardKeyOf({ combo: 'Enter', data: '\r' }, remapped, false)).toBeUndefined();
    expect(cardKeyOf({ combo: 'Up', data: '\x1b[A' }, remapped, false)).toBeUndefined();
    // a digit still picks an option
    expect(cardKeyOf({ combo: '2', data: '2' }, remapped, false)).toEqual({
      kind: 'text',
      text: '2',
    });
  });

  it('keeps a letter bound to a key as text on the typing line', () => {
    const remapped: CardKeymap = {
      decision: (combo) => ({ J: 'decision.down' })[combo],
      textBox: () => undefined,
    };
    expect(cardKeyOf({ combo: 'J', data: 'j' }, remapped, true)).toEqual({
      kind: 'text',
      text: 'j',
    });
    expect(cardKeyOf({ combo: 'Space', data: ' ' }, remapped, true)).toEqual({
      kind: 'text',
      text: ' ',
    });
  });
});

describe('cardLines', () => {
  const model = buildCard(question(['red', 'blue']), texts);
  const view = { typingPrompt: '> ', progress: '' };

  it('draws the prompt, the numbered options and the cursor', () => {
    const lines = cardLines(model, createCardState(model), 40, 10, view).map((line) => line.text);
    expect(lines[0]).toBe('Which one?');
    expect(lines.some((line) => line.includes('1. red'))).toBe(true);
    expect(lines.some((line) => line.startsWith('›'))).toBe(true);
  });

  it('keeps within the rows it was given, around the cursor', () => {
    const big = buildCard(question(Array.from({ length: 30 }, (_, i) => `o${String(i)}`)), texts);
    const state = { ...createCardState(big), cursor: 25 };
    const lines = cardLines(big, state, 40, 6, view);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.some((line) => line.text.includes('o25'))).toBe(true);
  });

  it('shows what is typed with a cursor block', () => {
    const state = play(model, [type('3'), type('h')]).state;
    const lines = cardLines(model, state, 40, 10, view).map((line) => line.text);
    expect(lines.at(-1)).toBe('> h█');
  });
});

describe('the question of context: ask (P18)', () => {
  const shellAsk: PendingAsk = {
    ...ask('producer_question', {
      questions: [
        {
          question: 'Send the result of "ls" (exit code 0, 2 lines) to the Director?',
          options: [{ label: 'Send' }, { label: 'Keep' }],
          multi_select: false,
        },
      ],
    }),
    shell: { command: 'ls', exitCode: 0, lines: 2 },
  };
  const model = buildCard(shellAsk, texts);

  it('shows the words of the catalog, with the two options and no "other"', () => {
    const step = model.stepAt(0, []);
    expect(step?.prompt).toBe('Send ! ls?');
    expect(step?.lines).toEqual(['code 0, 2 lines']);
    expect(step?.options.map((option) => option.label)).toEqual(['Send it', 'Keep it here']);
    expect(step?.freeText).toBe(false);
  });

  it('answers with the labels the daemon reads, whatever language it shows', () => {
    expect(play(model, [enter]).done).toEqual({
      answer: { answers: ['Send'] },
      summary: 'Send it',
    });
    expect(play(model, [down, enter]).done).toEqual({
      answer: { answers: ['Keep'] },
      summary: 'Keep it here',
    });
    expect(play(model, [type('2')]).done?.answer).toEqual({ answers: ['Keep'] });
  });

  it('draws the prompt, how the command ended and the options', () => {
    const lines = cardLines(model, createCardState(model), 80, 10, {
      typingPrompt: '> ',
      progress: '',
    }).map((line) => line.text);
    expect(lines[0]).toBe('Send ! ls?');
    expect(lines).toContain('code 0, 2 lines');
    expect(lines.join('\n')).toContain('1. Send it');
  });

  it('is an ordinary question when the ask carries no command', () => {
    const plain = buildCard({ ...shellAsk, shell: undefined }, texts);
    expect(plain.stepAt(0, [])?.prompt).toContain('Send the result of');
  });
});
