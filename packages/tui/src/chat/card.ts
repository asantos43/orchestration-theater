// SPDX-License-Identifier: MPL-2.0
import { clip, wrapText } from '../layout/text.js';
import type { PendingAsk } from './model.js';
import { SHELL_KEEP_LABEL, SHELL_SEND_LABEL, type ShellAsk } from './shell.js';

/**
 * The decision card (P12 of docs/18): a pending decision of the Producer (`ask` frame) as a list to
 * walk with the arrows or a number, to mark with Space on a multiple choice and to answer with
 * Enter. This file is pure: `buildCard` reads the `input` of the ask (the same shapes the CLI chat
 * reads, `chat-command.ts`), `cardKey` is the reducer of one key press and `cardLines` draws it.
 */

/** What an option asks the Producer to type after choosing it. */
export type OptionText = 'none' | 'required' | 'optional';

export interface CardOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly text: OptionText;
}

export interface CardStep {
  readonly prompt: string;
  /** Context lines under the prompt (the reason, the ideas...). */
  readonly lines: readonly string[];
  readonly options: readonly CardOption[];
  readonly multi: boolean;
  /** No list: the answer is typed. */
  readonly freeText: boolean;
}

export interface StepPick {
  readonly optionIds: readonly string[];
  readonly text: string;
}

export interface CardAnswer {
  readonly answer: Record<string, unknown>;
  /** What the conversation shows as the Producer's own line. */
  readonly summary: string;
}

/** The words the card needs from the catalog; the ones that depend on the ask are made by the caller. */
export interface CardTexts {
  readonly title: string;
  readonly other: string;
  readonly keepPrompt: string;
  readonly option: (id: string) => string;
  readonly idea: (id: string, text: string) => string;
  readonly leftOut: (id: string, reason: string, question: string) => string;
  readonly need: (need: string) => string;
  /** The words of the question of `chat.shell_command.context: ask` (P18), for the command it is about. */
  readonly shell: (ask: ShellAsk) => ShellTexts;
}

/** What the card of a `!` command shows in place of the English question of the daemon. */
export interface ShellTexts {
  readonly prompt: string;
  /** Context lines under the prompt (how the command ended). */
  readonly lines: readonly string[];
  readonly send: string;
  readonly sendDescription: string;
  readonly keep: string;
  readonly keepDescription: string;
}

export interface CardModel {
  readonly decisionId: string;
  readonly shape: 'questions' | 'menu' | 'ideas';
  /** How many steps the card has when the choices do not add any (the questions of the ask). */
  readonly total: number;
  /** The step `index` given the picks of the steps before it, or `undefined` past the last. */
  readonly stepAt: (index: number, picks: readonly StepPick[]) => CardStep | undefined;
  /** The answer once the picks are enough; `undefined` while another step is needed. */
  readonly complete: (picks: readonly StepPick[]) => CardAnswer | undefined;
}

const OTHER = 'other';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

interface Question {
  readonly question: string;
  readonly options: readonly { label: string; description: string }[];
  readonly multi: boolean;
}

function questionsOf(input: Readonly<Record<string, unknown>>): Question[] {
  return recordsOf(input.questions).flatMap((item) =>
    typeof item.question === 'string'
      ? [
          {
            question: item.question,
            options: recordsOf(item.options).map((option) => ({
              label: textOf(option.label),
              description: textOf(option.description),
            })),
            multi: item.multi_select === true,
          },
        ]
      : [],
  );
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((option): option is string => typeof option === 'string')
    : [];
}

function questionModel(ask: PendingAsk, texts: CardTexts): CardModel {
  const questions = questionsOf(ask.input);
  // A question the daemon sent with no field `questions` still gets a free-text answer.
  const list: Question[] =
    questions.length > 0 ? questions : [{ question: texts.title, options: [], multi: false }];
  const stepOf = (index: number): CardStep | undefined => {
    const question = list[index];
    if (question === undefined) return undefined;
    const options: CardOption[] = question.options.map((option, at) => ({
      id: String(at),
      label: option.label,
      description: option.description,
      text: 'none',
    }));
    if (options.length > 0) {
      options.push({ id: OTHER, label: texts.other, description: '', text: 'required' });
    }
    return {
      prompt: question.question,
      lines: [],
      options,
      multi: question.multi,
      freeText: options.length === 0,
    };
  };
  const answerOf = (pick: StepPick, question: Question): string => {
    const parts = pick.optionIds.map((id) =>
      id === OTHER ? pick.text : (question.options[Number(id)]?.label ?? ''),
    );
    return parts.filter((part) => part !== '').join(', ');
  };
  return {
    decisionId: ask.decisionId,
    shape: 'questions',
    total: list.length,
    stepAt: (index) => stepOf(index),
    complete: (picks) => {
      if (picks.length < list.length) return undefined;
      const answers = list.map((question, at) => {
        const pick = picks[at];
        return pick === undefined ? '' : answerOf(pick, question);
      });
      return { answer: { answers }, summary: answers.join(' / ') };
    },
  };
}

/**
 * The question of `context: ask` (P18): the daemon asks it in English with the two labels `Send` and
 * `Keep`, which are also what it reads back, so the card shows the words of the catalog and answers
 * with the labels.
 */
function shellModel(ask: PendingAsk, shell: ShellAsk, texts: CardTexts): CardModel {
  const words = texts.shell(shell);
  const step: CardStep = {
    prompt: words.prompt,
    lines: words.lines,
    options: [
      { id: '0', label: words.send, description: words.sendDescription, text: 'none' },
      { id: '1', label: words.keep, description: words.keepDescription, text: 'none' },
    ],
    multi: false,
    freeText: false,
  };
  const labels = [SHELL_SEND_LABEL, SHELL_KEEP_LABEL];
  return {
    decisionId: ask.decisionId,
    shape: 'questions',
    total: 1,
    stepAt: (index) => (index === 0 ? step : undefined),
    complete: (picks) => {
      const id = picks[0]?.optionIds[0];
      const label = id === undefined ? undefined : labels[Number(id)];
      if (label === undefined) return undefined;
      return {
        answer: { answers: [label] },
        summary: id === '0' ? words.send : words.keep,
      };
    },
  };
}

function menuModel(ask: PendingAsk, texts: CardTexts): CardModel {
  const options = stringsOf(ask.input.options).map((id): CardOption => ({
    id,
    label: texts.option(id),
    description: '',
    text: id === 'redefine_need' ? 'required' : 'none',
  }));
  const reason = textOf(ask.input.reason);
  const step: CardStep = {
    prompt: texts.title,
    lines: reason === '' ? [] : [reason],
    options,
    multi: false,
    freeText: false,
  };
  return {
    decisionId: ask.decisionId,
    shape: 'menu',
    total: 1,
    stepAt: (index) => (index === 0 ? step : undefined),
    complete: (picks) => {
      const pick = picks[0];
      const id = pick?.optionIds[0];
      if (pick === undefined || id === undefined) return undefined;
      const text = pick.text.trim();
      return {
        answer: {
          option: id,
          ...(text === '' ? {} : id === 'redefine_need' ? { need: text } : { reason: text }),
        },
        summary: text === '' ? texts.option(id) : `${texts.option(id)}: ${text}`,
      };
    },
  };
}

function ideasModel(ask: PendingAsk, texts: CardTexts): CardModel {
  const ideas = recordsOf(ask.input.ideas);
  const lines = [
    textOf(ask.input.rationale),
    ...(textOf(ask.input.need) === '' ? [] : [texts.need(textOf(ask.input.need))]),
    ...ideas.map((item) => texts.idea(textOf(item.id), textOf(item.text))),
    ...recordsOf(ask.input.leftOut).map((item) =>
      texts.leftOut(textOf(item.ideaId), textOf(item.reason), textOf(item.question)),
    ),
  ].filter((line) => line !== '');
  const first: CardStep = {
    prompt: texts.title,
    lines,
    options: [
      { id: 'approve', label: texts.option('approve'), description: '', text: 'none' },
      { id: 'refuse', label: texts.option('refuse'), description: '', text: 'optional' },
      { id: 'edit', label: texts.option('edit'), description: '', text: 'required' },
      ...(ideas.length > 1
        ? [{ id: 'keep', label: texts.option('keep'), description: '', text: 'none' as const }]
        : []),
    ],
    multi: false,
    freeText: false,
  };
  const second: CardStep = {
    prompt: texts.keepPrompt,
    lines: [],
    options: ideas.map((item) => ({
      id: textOf(item.id),
      label: texts.idea(textOf(item.id), textOf(item.text)),
      description: '',
      text: 'none',
    })),
    multi: true,
    freeText: false,
  };
  return {
    decisionId: ask.decisionId,
    shape: 'ideas',
    total: 1,
    stepAt: (index, picks) => {
      if (index === 0) return first;
      return index === 1 && picks[0]?.optionIds[0] === 'keep' ? second : undefined;
    },
    complete: (picks) => {
      const choice = picks[0]?.optionIds[0];
      if (choice === undefined) return undefined;
      const text = (picks[0]?.text ?? '').trim();
      if (choice === 'approve') {
        return { answer: { option: 'approve' }, summary: texts.option('approve') };
      }
      if (choice === 'refuse') {
        return {
          answer: { option: 'refuse', ...(text === '' ? {} : { reason: text }) },
          summary: text === '' ? texts.option('refuse') : `${texts.option('refuse')}: ${text}`,
        };
      }
      if (choice === 'edit') {
        return {
          answer: { option: 'edit', need: text },
          summary: `${texts.option('edit')}: ${text}`,
        };
      }
      const kept = picks[1];
      if (kept === undefined) return undefined;
      return {
        answer: { option: 'edit', ideaIds: [...kept.optionIds] },
        summary: `${texts.option('keep')}: ${kept.optionIds.join(', ')}`,
      };
    },
  };
}

/** The card of one pending decision. */
export function buildCard(ask: PendingAsk, texts: CardTexts): CardModel {
  if (ask.kind === 'producer_question') {
    return ask.shell === undefined ? questionModel(ask, texts) : shellModel(ask, ask.shell, texts);
  }
  if (ask.kind === 'ideas.group') return ideasModel(ask, texts);
  return menuModel(ask, texts);
}

// ---- The state of the card ---------------------------------------------------------------------

export interface CardState {
  readonly step: number;
  readonly cursor: number;
  /** The ids marked on a multiple choice. */
  readonly marked: readonly string[];
  /** The Producer is typing the text of the pending choice. */
  readonly typing: boolean;
  /** The ids chosen while the text is typed. */
  readonly pending: readonly string[];
  readonly text: string;
  readonly picks: readonly StepPick[];
}

export function createCardState(model: CardModel): CardState {
  return enterStep(model, [], 0);
}

function enterStep(model: CardModel, picks: readonly StepPick[], step: number): CardState {
  const free = model.stepAt(step, picks)?.freeText === true;
  return {
    step,
    cursor: 0,
    marked: [],
    typing: free,
    pending: free ? [OTHER] : [],
    text: '',
    picks,
  };
}

/** What a key press of the card is. */
export type CardKey =
  | { readonly kind: 'up' | 'down' | 'space' | 'enter' | 'esc' | 'backspace' }
  | { readonly kind: 'text'; readonly text: string };

/** The key of the card a raw key press is, or `undefined` for what the card ignores. */
export function cardKeyOf(event: {
  readonly combo: string | undefined;
  readonly data: string;
}): CardKey | undefined {
  switch (event.combo) {
    case 'Up':
      return { kind: 'up' };
    case 'Down':
      return { kind: 'down' };
    case 'Space':
      return { kind: 'space' };
    case 'Enter':
      return { kind: 'enter' };
    case 'Esc':
      return { kind: 'esc' };
    case 'Backspace':
      return { kind: 'backspace' };
    default:
      break;
  }
  // eslint-disable-next-line no-control-regex -- what is not printable is not text
  return event.data !== '' && !/[\x00-\x1f\x7f]/u.test(event.data)
    ? { kind: 'text', text: event.data }
    : undefined;
}

export interface CardStepResult {
  readonly state: CardState;
  /** The decision is answered: send this. */
  readonly done?: CardAnswer | undefined;
  /** The Producer set the card aside (Esc), to write in the box. */
  readonly aside?: boolean | undefined;
}

function optionNeedsText(step: CardStep, ids: readonly string[]): OptionText {
  let need: OptionText = 'none';
  for (const id of ids) {
    const option = step.options.find((candidate) => candidate.id === id);
    if (option?.text === 'required') return 'required';
    if (option?.text === 'optional') need = 'optional';
  }
  return need;
}

function commit(
  model: CardModel,
  state: CardState,
  ids: readonly string[],
  text: string,
): CardStepResult {
  const picks = [...state.picks.slice(0, state.step), { optionIds: ids, text }];
  const done = model.complete(picks);
  if (done !== undefined) return { state: { ...state, picks }, done };
  if (model.stepAt(state.step + 1, picks) === undefined) return { state: { ...state, picks } };
  return { state: enterStep(model, picks, state.step + 1) };
}

/** Chooses `ids` on the current step: asks for the text when an option wants one. */
function choose(
  model: CardModel,
  state: CardState,
  step: CardStep,
  ids: readonly string[],
): CardStepResult {
  const need = optionNeedsText(step, ids);
  if (need === 'none') return commit(model, state, ids, '');
  return { state: { ...state, typing: true, pending: ids, text: '' } };
}

function toggle(marked: readonly string[], id: string): string[] {
  return marked.includes(id) ? marked.filter((item) => item !== id) : [...marked, id];
}

/** One key press of the card. */
export function cardKey(model: CardModel, state: CardState, key: CardKey): CardStepResult {
  const step = model.stepAt(state.step, state.picks);
  if (step === undefined) return { state };
  if (state.typing) {
    switch (key.kind) {
      case 'text':
        return { state: { ...state, text: state.text + key.text } };
      case 'space':
        return { state: { ...state, text: `${state.text} ` } };
      case 'backspace':
        return { state: { ...state, text: Array.from(state.text).slice(0, -1).join('') } };
      case 'esc':
        return step.freeText ? { state, aside: true } : { state: { ...state, typing: false } };
      case 'enter': {
        const required = optionNeedsText(step, state.pending) === 'required';
        if (required && state.text.trim() === '') return { state };
        return commit(model, state, state.pending, state.text.trim());
      }
      default:
        return { state };
    }
  }
  const count = step.options.length;
  const at = (index: number): CardOption | undefined => step.options[index];
  const select = (index: number): CardStepResult => {
    const option = at(index);
    if (option === undefined) return { state };
    if (step.multi) {
      return { state: { ...state, cursor: index, marked: toggle(state.marked, option.id) } };
    }
    return choose(model, { ...state, cursor: index }, step, [option.id]);
  };
  switch (key.kind) {
    case 'up':
      return count === 0
        ? { state }
        : { state: { ...state, cursor: (state.cursor - 1 + count) % count } };
    case 'down':
      return count === 0 ? { state } : { state: { ...state, cursor: (state.cursor + 1) % count } };
    case 'space':
      return select(state.cursor);
    case 'enter': {
      if (!step.multi) return select(state.cursor);
      const under = at(state.cursor);
      const ids = state.marked.length > 0 ? state.marked : under === undefined ? [] : [under.id];
      return ids.length === 0 ? { state } : choose(model, state, step, ids);
    }
    case 'esc':
      return { state, aside: true };
    case 'text': {
      const digit = /^[1-9]$/u.test(key.text) ? Number(key.text) - 1 : -1;
      if (digit < 0 || digit >= count) return { state };
      return select(digit);
    }
    default:
      return { state };
  }
}

// ---- Drawing ------------------------------------------------------------------------------------

export interface CardLine {
  readonly text: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly color?: string;
  readonly inverse?: boolean;
}

export interface CardView {
  /** Label of the line the Producer is typing (`> `), already translated. */
  readonly typingPrompt: string;
  /** `n/m` of the steps, when there is more than one; empty otherwise. */
  readonly progress: string;
}

/**
 * The lines of the card within `width` and at most `rows` rows. The list is windowed around the
 * cursor; the prompt and the typing line always stay.
 */
export function cardLines(
  model: CardModel,
  state: CardState,
  width: number,
  rows: number,
  view: CardView,
): CardLine[] {
  const step = model.stepAt(state.step, state.picks);
  if (step === undefined) return [];
  const head: CardLine[] = [];
  const prompt = view.progress === '' ? step.prompt : `${step.prompt} (${view.progress})`;
  for (const line of wrapText(prompt, width)) head.push({ text: line, bold: true });
  for (const context of step.lines) {
    for (const line of wrapText(context, width)) head.push({ text: line, dim: true });
  }
  const tail: CardLine[] = [];
  if (state.typing) {
    const typed = `${view.typingPrompt}${state.text}`;
    const shown = wrapText(`${typed}█`, width);
    for (const line of shown.slice(-2)) tail.push({ text: line, color: 'cyan' });
  }
  const options: CardLine[][] = step.options.map((option, index) => {
    const here = !state.typing && index === state.cursor;
    const mark = step.multi ? (state.marked.includes(option.id) ? '[x] ' : '[ ] ') : '';
    const lead = `${here ? '›' : ' '} ${String(index + 1)}. ${mark}`;
    const label = clip(`${lead}${option.label}`, width);
    const out: CardLine[] = [{ text: label, ...(here ? { inverse: true } : {}) }];
    if (option.description !== '' && here) {
      for (const line of wrapText(option.description, Math.max(1, width - 5))) {
        out.push({ text: `     ${line}`, dim: true });
      }
    }
    return out;
  });
  const room = Math.max(1, rows - head.length - tail.length);
  // Window the options around the cursor, keeping its own lines whole.
  const flat = options.flat();
  if (flat.length <= room) return [...head, ...flat, ...tail].slice(0, Math.max(1, rows));
  let start = 0;
  for (let index = 0; index < state.cursor; index += 1) start += options[index]?.length ?? 0;
  const own = options[state.cursor]?.length ?? 1;
  const top = Math.max(0, Math.min(start + own - room, flat.length - room));
  const window = flat.slice(top, top + room);
  return [...head, ...window, ...tail].slice(0, Math.max(1, rows));
}
