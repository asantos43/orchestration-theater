// SPDX-License-Identifier: MPL-2.0
import type { SetupPlan, SetupPrompt, SetupRunView } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { profileOf } from './fake-api.test-support.js';
import {
  accountClients,
  accountsCursorMoved,
  accountsCursorStart,
  atFirstStep,
  columnMoved,
  columnOf,
  draftKey,
  executorsItem,
  initialDraft,
  isFinished,
  isTable,
  itemCount,
  loginCommandOf,
  parseBudgetLine,
  parseExecutorLine,
  reconciledDraft,
  reordered,
  reviewExecutors,
  reviewStart,
  stepNumber,
  submissionOf,
  tableRowUnderCursor,
  toggled,
  withBudget,
  withCursor,
  withExecutor,
  withoutExecutor,
  withRowEffort,
  withRowRoles,
  type Draft,
} from './model.js';
import type { ExecutorRow } from './executor-list.js';

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

describe('the security step (N334, [proposta])', () => {
  const SECURITY: SetupPrompt = { step: 'security', layer3: false, unenforced: 'refuse' };

  it('starts on no, moves between the two options and answers with a boolean', () => {
    const draft = initialDraft(SECURITY);
    expect(draft).toEqual({ kind: 'security', cursor: 0 });
    expect(itemCount(draft, SECURITY)).toBe(2);
    expect(submissionOf(draft, SECURITY)).toEqual({ step: 'security', input: { warn: false } });
    const yes = withCursor(draft, SECURITY, 1);
    expect(yes).toEqual({ kind: 'security', cursor: 1 });
    expect(submissionOf(yes, SECURITY)).toEqual({ step: 'security', input: { warn: true } });
    // The cursor stays inside the two options.
    expect(withCursor(yes, SECURITY, 1)).toEqual({ kind: 'security', cursor: 1 });
    expect(withCursor(draft, SECURITY, -1)).toEqual({ kind: 'security', cursor: 0 });
  });
});

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

/** N335: the table of the models. */
describe('the table of the Executors (N335)', () => {
  function row(model: string, extra: Partial<ExecutorRow> = {}): ExecutorRow {
    return {
      profileId: 'codex/work',
      model,
      name: null,
      floating: null,
      efforts: ['low', 'high'],
      effort: 'low',
      on: false,
      seed: null,
      registered: false,
      ...extra,
    };
  }

  function table(
    extra: Partial<Extract<Draft, { kind: 'executors' }>> = {},
  ): Extract<Draft, { kind: 'executors' }> {
    return {
      kind: 'executors',
      executors: [],
      budgets: {},
      cursor: 0,
      layout: 'table',
      list: 'ready',
      rows: [row('a'), row('b', { registered: true })],
      ...extra,
    };
  }

  it('is a table only with the layout and with rows', () => {
    expect(isTable(table())).toBe(true);
    expect(isTable(table({ layout: 'list' }))).toBe(false);
    expect(isTable(table({ rows: [] }))).toBe(false);
    expect(isTable({ kind: 'review' })).toBe(false);
  });

  it('walks the rows and the caps, and has no item that goes on after them', () => {
    const prompt: SetupPrompt = { ...EXECUTORS, step: 'executors' };
    const draft = table();
    // 2 rows, 2 API accounts: Enter goes on from any of them, so there is no last item for it.
    expect(itemCount(draft, prompt)).toBe(4);
    expect(itemCount(table({ layout: 'list' }), prompt)).toBe(4);
    expect(executorsItem({ ...draft, cursor: 1 }, prompt)).toEqual({ kind: 'row', index: 1 });
    expect(executorsItem({ ...draft, cursor: 2 }, prompt)).toEqual({
      kind: 'budget',
      profileId: 'x/one',
    });
    expect(executorsItem({ ...draft, cursor: 4 }, prompt)).toBeUndefined();
    expect(executorsItem(table({ layout: 'list', cursor: 4 }), prompt)).toBeUndefined();
  });

  it('moves the cell among Mark, Effort and Roles, and stops at the ends', () => {
    let draft: Draft = table();
    expect(columnOf(draft)).toBe('mark');
    expect(columnOf(columnMoved(draft, -1))).toBe('mark');
    draft = columnMoved(draft, 1);
    expect(columnOf(draft)).toBe('effort');
    draft = columnMoved(draft, 1);
    expect(columnOf(draft)).toBe('roles');
    expect(columnOf(columnMoved(draft, 1))).toBe('roles');
    expect(columnOf(columnMoved(draft, -1))).toBe('effort');
    // Off the table nothing moves.
    const list = table({ layout: 'list' });
    expect(columnMoved(list, 1)).toBe(list);
  });

  it('names the row under the cursor only when a person can change it', () => {
    expect(tableRowUnderCursor(table({ cursor: 0 }))).toBe(0);
    // The registered row is shown, not edited; the cursor past the rows is not on a row.
    expect(tableRowUnderCursor(table({ cursor: 1 }))).toBeUndefined();
    expect(tableRowUnderCursor(table({ cursor: 2 }))).toBeUndefined();
    expect(tableRowUnderCursor(table({ layout: 'list' }))).toBeUndefined();
  });

  it('sets the effort and the roles of a row, and an edit gives up the roles given at the review', () => {
    const placed = table({
      placements: [{ executorId: 'x@codex/work', mode: 'add', roles: ['actor'] }],
    });
    const efforted = withRowEffort(placed, 0, 'high');
    expect(efforted.kind === 'executors' && efforted.rows?.[0]?.effort).toBe('high');
    expect(efforted.kind === 'executors' && efforted.placements).toBeUndefined();
    const roled = withRowRoles(placed, 0, ['author'], ['reviewer']);
    expect(roled.kind === 'executors' && roled.rows?.[0]?.roles).toEqual(['author']);
    expect(roled.kind === 'executors' && roled.placements).toBeUndefined();
    // Back to the roles the preset gives: the row keeps no roles of its own.
    const back = withRowRoles(roled, 0, ['reviewer'], ['reviewer']);
    expect(back.kind === 'executors' && back.rows?.[0]?.roles).toBeUndefined();
  });

  it('sends the roles of the rows as exact, then the ones given at the review to another Executor', () => {
    const listing = {
      kind: 'executors' as const,
      executors: [],
      budgets: {},
      cursor: 0,
      layout: 'table' as const,
      list: 'ready' as const,
      rows: [row('a', { on: true, roles: ['author'] }), row('c', { on: true })],
      placements: [{ executorId: 'z@codex/work', mode: 'add' as const, roles: ['actor' as const] }],
    };
    const sent = submissionOf(listing, EXECUTORS);
    expect(sent).toMatchObject({
      step: 'executors',
      input: {
        executors: [
          { profileId: 'codex/work', model: 'a', effort: 'low' },
          { profileId: 'codex/work', model: 'c', effort: 'low' },
        ],
        roles: [
          { request: 0, mode: 'exact', roles: ['author'] },
          { executorId: 'z@codex/work', mode: 'add', roles: ['actor'] },
        ],
      },
    });
  });
});

describe('the Executors of the review (N335)', () => {
  const plan = (roles: SetupPlan['roles']): SetupPlan => ({
    flow: 'first_run',
    preset: 'balanced',
    roles,
    executors: ['a@p/x', 'b@p/x', 'c@p/x'].map((id) => ({
      id,
      profileId: 'p/x',
      model: id,
      alias: id,
      effort: null,
      provider: 'anthropic',
      source: 'discovered' as const,
      presetExpand: true,
      local: null,
    })),
    budgets: [],
    writes: [],
    notes: [],
  });

  it('walks every Executor of the plan and starts on the first one with no role', () => {
    const shown = plan([
      { role: 'author', executors: ['a@p/x'], whenExhausted: 'next' },
      { role: 'critic', executors: ['a@p/x', 'c@p/x'], whenExhausted: 'next' },
    ]);
    expect(reviewExecutors(shown)).toEqual(['a@p/x', 'b@p/x', 'c@p/x']);
    expect(reviewStart(shown)).toBe(1);
    // Every Executor has a role: the cursor starts on the first.
    expect(
      reviewStart(
        plan([{ role: 'author', executors: ['a@p/x', 'b@p/x', 'c@p/x'], whenExhausted: 'next' }]),
      ),
    ).toBe(0);
    expect(reviewExecutors(undefined)).toEqual([]);
    expect(reviewStart(undefined)).toBe(0);
  });
});
