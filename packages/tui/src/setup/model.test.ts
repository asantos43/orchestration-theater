// SPDX-License-Identifier: MPL-2.0
import type { SetupPrompt, SetupRunView } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { profileOf } from './fake-api.test-support.js';
import {
  accountClients,
  accountsCursorMoved,
  accountsCursorStart,
  atFirstStep,
  draftKey,
  executorsItem,
  initialDraft,
  isFinished,
  itemCount,
  loginCommandOf,
  parseBudgetLine,
  parseExecutorLine,
  reconciledDraft,
  reordered,
  stepNumber,
  submissionOf,
  toggled,
  withBudget,
  withCursor,
  withExecutor,
  withoutExecutor,
  type Draft,
} from './model.js';

const DETECT: SetupPrompt = {
  step: 'detect',
  clients: [],
  profiles: [
    profileOf('claude-code/a'),
    profileOf('codex/b', { usable: false }),
    profileOf('codex/c'),
  ],
};
const PRESET: SetupPrompt = {
  step: 'preset',
  current: null,
  options: ['quality', 'balanced', 'economical'],
};
const EXECUTORS: SetupPrompt = {
  step: 'executors',
  apiProfiles: [profileOf('x/one', { kind: 'api' }), profileOf('x/two', { kind: 'api' })],
  suggestedBudget: { dailyUsd: 5, monthlyUsd: 50 },
};

function run(
  step: SetupRunView['step'],
  steps: SetupRunView['steps'],
  state: SetupRunView['state'] = 'active',
): SetupRunView {
  return {
    id: 'setup_a',
    flow: 'first_run',
    state,
    step,
    steps,
    done: [],
    prompt: null,
    result: null,
    createdAt: 0,
    updatedAt: 0,
    finishedAt: null,
  };
}

describe('the draft of each step', () => {
  it('detection starts with the usable accounts taken in, in the daemon order', () => {
    const draft = initialDraft(DETECT);
    expect(draft).toEqual({
      kind: 'detect',
      rows: [
        { profileId: 'claude-code/a', on: true },
        { profileId: 'codex/b', on: false },
        { profileId: 'codex/c', on: true },
      ],
      cursor: 0,
    });
    expect(submissionOf(draft, DETECT)).toEqual({
      step: 'detect',
      input: { accounts: ['claude-code/a', 'codex/c'] },
    });
  });

  it('the account step starts on the first usable account', () => {
    const prompt: SetupPrompt = {
      step: 'account',
      profiles: [profileOf('a/x', { usable: false }), profileOf('a/y')],
    };
    const draft = initialDraft(prompt);
    expect(draft).toEqual({ kind: 'account', cursor: 1 });
    expect(submissionOf(draft, prompt)).toEqual({ step: 'account', input: { profileId: 'a/y' } });
    expect(initialDraft({ step: 'account', profiles: [] })).toEqual({ kind: 'account', cursor: 0 });
    expect(
      submissionOf({ kind: 'account', cursor: 0 }, { step: 'account', profiles: [] }),
    ).toBeUndefined();
  });

  it('the preset starts on the one in force, or on the middle one', () => {
    expect(initialDraft(PRESET)).toEqual({ kind: 'preset', cursor: 1 });
    expect(initialDraft({ ...PRESET, current: 'economical' })).toEqual({
      kind: 'preset',
      cursor: 2,
    });
    expect(submissionOf({ kind: 'preset', cursor: 2 }, PRESET)).toEqual({
      step: 'preset',
      input: { preset: 'economical' },
    });
  });

  it('the Executors step starts empty and the review has no draft', () => {
    expect(initialDraft(EXECUTORS)).toEqual({
      kind: 'executors',
      executors: [],
      budgets: {},
      cursor: 0,
    });
    expect(initialDraft(null)).toEqual({ kind: 'review' });
    expect(submissionOf({ kind: 'review' }, null)).toBeUndefined();
    expect(submissionOf(initialDraft(PRESET), null)).toBeUndefined();
  });

  it('a draft of one step never answers another step', () => {
    expect(submissionOf({ kind: 'preset', cursor: 0 }, DETECT)).toBeUndefined();
    expect(submissionOf({ kind: 'account', cursor: 0 }, PRESET)).toBeUndefined();
  });
});

describe('the draft brought up to date with the accounts (2026-11-26)', () => {
  const remembered: Draft = {
    kind: 'detect',
    rows: [
      { profileId: 'codex/c', on: true },
      { profileId: 'claude-code/a', on: false },
      { profileId: 'codex/gone', on: true },
    ],
    cursor: 2,
  };

  it('keeps the marks and the order, drops what left and adds what came, checked when usable', () => {
    const prompt: SetupPrompt = {
      step: 'detect',
      clients: [],
      profiles: [
        profileOf('claude-code/a'),
        profileOf('codex/b', { usable: false }),
        profileOf('codex/c'),
        profileOf('codex/new'),
      ],
    };
    expect(reconciledDraft(remembered, prompt, [])).toEqual({
      kind: 'detect',
      rows: [
        { profileId: 'codex/c', on: true },
        { profileId: 'claude-code/a', on: false },
        { profileId: 'codex/b', on: false },
        { profileId: 'codex/new', on: true },
      ],
      cursor: 2,
    });
  });

  it('checks an account added in this run, when usable', () => {
    const rows = reconciledDraft(remembered, DETECT, ['claude-code/a', 'codex/b']);
    expect(rows.kind === 'detect' ? rows.rows : []).toEqual([
      { profileId: 'codex/c', on: true },
      { profileId: 'claude-code/a', on: true },
      { profileId: 'codex/b', on: false },
    ]);
  });

  it('leaves any other step as it was', () => {
    const preset: Draft = { kind: 'preset', cursor: 1 };
    expect(reconciledDraft(preset, PRESET, ['codex/c'])).toBe(preset);
    expect(reconciledDraft(remembered, PRESET, [])).toBe(remembered);
  });
});

describe('moving in the draft', () => {
  it('keeps the cursor inside the rows', () => {
    const draft = initialDraft(DETECT);
    expect(itemCount(draft, DETECT)).toBe(3);
    expect(withCursor(draft, DETECT, -1)).toEqual(draft);
    expect(withCursor(draft, DETECT, 9)).toMatchObject({ cursor: 2 });
    expect(withCursor({ kind: 'review' }, null, 1)).toEqual({ kind: 'review' });
  });

  it('takes an account in and out of the run', () => {
    const draft = toggled(withCursor(initialDraft(DETECT), DETECT, 1));
    expect(draft.kind === 'detect' && draft.rows.map((row) => row.on)).toEqual([true, true, true]);
    expect(toggled(toggled(draft))).toEqual(draft);
    expect(toggled({ kind: 'preset', cursor: 0 })).toEqual({ kind: 'preset', cursor: 0 });
  });

  it('reorders the account under the cursor and the cursor follows it', () => {
    const draft = initialDraft(DETECT);
    const down = reordered(draft, 1);
    expect(down.kind === 'detect' && down.rows.map((row) => row.profileId)).toEqual([
      'codex/b',
      'claude-code/a',
      'codex/c',
    ]);
    expect(down).toMatchObject({ cursor: 1 });
    // Past either end nothing moves.
    expect(reordered(draft, -1)).toEqual(draft);
    const last = withCursor(draft, DETECT, 2);
    expect(reordered(last, 1)).toEqual(last);
  });
});

describe('the Executors and the caps', () => {
  it('adds, walks and removes the rows, then the caps follow them', () => {
    let draft: Draft = initialDraft(EXECUTORS);
    draft = withExecutor(draft, { profileId: 'x/one', model: 'm1' });
    draft = withExecutor(draft, { profileId: 'x/two', model: 'm2', effort: 'high' });
    expect(itemCount(draft, EXECUTORS)).toBe(4);
    expect(executorsItem(draft, EXECUTORS)).toEqual({ kind: 'executor', index: 1 });
    draft = withCursor(draft, EXECUTORS, 1);
    expect(executorsItem(draft, EXECUTORS)).toEqual({ kind: 'budget', profileId: 'x/one' });
    draft = withCursor(draft, EXECUTORS, 5);
    expect(executorsItem(draft, EXECUTORS)).toEqual({ kind: 'budget', profileId: 'x/two' });
    draft = withBudget(draft, { profileId: 'x/two', dailyUsd: 1, monthlyUsd: null });
    expect(submissionOf(draft, EXECUTORS)).toEqual({
      step: 'executors',
      input: {
        executors: [
          { profileId: 'x/one', model: 'm1' },
          { profileId: 'x/two', model: 'm2', effort: 'high' },
        ],
        budgets: [{ profileId: 'x/two', dailyUsd: 1, monthlyUsd: null }],
      },
    });
    draft = withoutExecutor(draft, 0);
    expect(draft).toMatchObject({ executors: [{ profileId: 'x/two' }] });
    expect(withoutExecutor(initialDraft(EXECUTORS), 0)).toMatchObject({ executors: [], cursor: 0 });
  });

  it('has no item to act on outside the Executors step', () => {
    expect(executorsItem(initialDraft(PRESET), PRESET)).toBeUndefined();
    expect(executorsItem(initialDraft(EXECUTORS), null)).toBeUndefined();
    expect(withExecutor({ kind: 'review' }, { profileId: 'a', model: 'b' })).toEqual({
      kind: 'review',
    });
    expect(withBudget({ kind: 'review' }, { profileId: 'a', dailyUsd: 1, monthlyUsd: 1 })).toEqual({
      kind: 'review',
    });
    expect(withoutExecutor({ kind: 'review' }, 0)).toEqual({ kind: 'review' });
  });
});

describe('the seed of the list of models (N324)', () => {
  it('opens the step of the Executors with the requests and the exclusions of the list', () => {
    const draft = initialDraft(EXECUTORS, {
      executors: [{ profileId: 'a/x', model: 'm-2' }],
      exclude: ['m-1@a/x'],
    });
    expect(draft).toEqual({
      kind: 'executors',
      executors: [{ profileId: 'a/x', model: 'm-2' }],
      budgets: {},
      cursor: 0,
      exclude: ['m-1@a/x'],
    });
    expect(submissionOf(draft, EXECUTORS)).toEqual({
      step: 'executors',
      input: { executors: [{ profileId: 'a/x', model: 'm-2' }], budgets: [], exclude: ['m-1@a/x'] },
    });
  });

  it('sends no exclude when the list left nothing out', () => {
    const draft = initialDraft(EXECUTORS, { executors: [], exclude: [] });
    expect(draft).not.toHaveProperty('exclude');
    expect(submissionOf(draft, EXECUTORS)).toEqual({
      step: 'executors',
      input: { executors: [], budgets: [] },
    });
  });
});

describe('the lines the person types', () => {
  it('reads <account> <model> [effort]', () => {
    expect(parseExecutorLine('a/b m')).toEqual({ profileId: 'a/b', model: 'm' });
    expect(parseExecutorLine('  a/b   m   high ')).toEqual({
      profileId: 'a/b',
      model: 'm',
      effort: 'high',
    });
    expect(parseExecutorLine('a/b')).toBeUndefined();
    expect(parseExecutorLine('')).toBeUndefined();
    expect(parseExecutorLine('a b c d')).toBeUndefined();
  });

  it('reads <day> <month> with a comma, a dot or a dash', () => {
    expect(parseBudgetLine('p', '5 50')).toEqual({ profileId: 'p', dailyUsd: 5, monthlyUsd: 50 });
    expect(parseBudgetLine('p', '2,5 -')).toEqual({
      profileId: 'p',
      dailyUsd: 2.5,
      monthlyUsd: null,
    });
    expect(parseBudgetLine('p', '- -')).toEqual({
      profileId: 'p',
      dailyUsd: null,
      monthlyUsd: null,
    });
    expect(parseBudgetLine('p', '0 5')).toBeUndefined();
    expect(parseBudgetLine('p', '5')).toBeUndefined();
    expect(parseBudgetLine('p', '5 6 7')).toBeUndefined();
    expect(parseBudgetLine('p', 'a b')).toBeUndefined();
    expect(parseBudgetLine('p', '-1 5')).toBeUndefined();
  });
});

describe('the place in the run', () => {
  const steps: SetupRunView['steps'] = ['detect', 'preset', 'review'];

  it('numbers the step from 1 and knows the first one', () => {
    expect(stepNumber(run('detect', steps))).toBe(1);
    expect(stepNumber(run('review', steps))).toBe(3);
    expect(atFirstStep(run('detect', steps))).toBe(true);
    expect(atFirstStep(run('preset', steps))).toBe(false);
  });

  it('tells a finished run and keys a draft by run and step', () => {
    expect(isFinished(run('review', steps))).toBe(false);
    expect(isFinished(run('review', steps, 'confirmed'))).toBe(true);
    expect(isFinished(run('review', steps, 'cancelled'))).toBe(true);
    expect(draftKey(run('preset', steps))).toBe('setup_a/preset');
  });
});

describe('the step that adds an account (N274)', () => {
  const detect: SetupPrompt = {
    step: 'detect',
    clients: [
      { client: 'claude-code', installed: false },
      { client: 'codex', installed: true },
    ],
    profiles: [],
  };

  it('lists the clients of the detection, or the three known ones when it names none', () => {
    expect(accountClients(detect).map((entry) => entry.client)).toEqual(['claude-code', 'codex']);
    expect(accountClients(null).map((entry) => entry.client)).toEqual([
      'claude-code',
      'codex',
      'opencode',
    ]);
    expect(accountClients({ ...detect, clients: [] }).map((entry) => entry.client)).toEqual([
      'claude-code',
      'codex',
      'opencode',
    ]);
  });

  it('starts the cursor on the first client found, and keeps it inside the list', () => {
    expect(accountsCursorStart(detect)).toBe(1);
    expect(accountsCursorStart(null)).toBe(0);
    expect(accountsCursorMoved(0, detect, -1)).toBe(0);
    expect(accountsCursorMoved(0, detect, 1)).toBe(1);
    expect(accountsCursorMoved(1, detect, 1)).toBe(1);
  });

  it('names the command that logs in to an account in a terminal', () => {
    expect(loginCommandOf('claude-code/work')).toBe('ot profile exec claude-code/work login');
  });
});
