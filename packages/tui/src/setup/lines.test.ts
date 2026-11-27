// SPDX-License-Identifier: MPL-2.0
import type { SetupDoneStep, SetupExecutor, SetupPlan, SetupRunView } from '@otheater/protocol';
import type { TFunction } from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTuiI18n, loadTuiCatalogs } from '../locale.js';
import { profileOf } from './fake-api.test-support.js';
import type { ExecutorRow } from './executor-list.js';
import { setupLines, type SetupLine } from './lines.js';
import type { Draft } from './model.js';

/** The review and the finished screen (2026-11-26, the owner's "Por conta" and "Resumo igual"). */

let t: TFunction;
beforeAll(async () => {
  t = (await createTuiI18n('en', loadTuiCatalogs())).t;
});

function executor(id: string): SetupExecutor {
  const [head = '', profileId = ''] = id.split('@');
  return {
    id,
    profileId,
    model: head,
    alias: head,
    effort: null,
    provider: 'anthropic',
    source: 'discovered',
    presetExpand: true,
    local: null,
  };
}

function plan(options: Partial<SetupPlan> = {}): SetupPlan {
  return {
    flow: 'first_run',
    preset: 'balanced',
    roles: [],
    executors: [],
    budgets: [],
    writes: [],
    notes: [],
    ...options,
  };
}

function detected(
  accounts: string[],
  profiles = accounts.map((id) => profileOf(id)),
): SetupDoneStep {
  return { step: 'detect', input: { accounts }, output: { clients: [], profiles, accounts } };
}

function run(
  prompt: SetupPlan | null,
  done: SetupDoneStep[],
  extra: Partial<SetupRunView> = {},
): SetupRunView {
  return {
    id: 'run-1',
    flow: 'first_run',
    state: 'active',
    step: 'review',
    steps: ['detect', 'preset', 'executors', 'review'],
    done,
    prompt: prompt === null ? null : { step: 'review', plan: prompt },
    result: null,
    createdAt: 0,
    updatedAt: 0,
    finishedAt: null,
    ...extra,
  };
}

function texts(lines: readonly SetupLine[]): string[] {
  return lines.map((line) => line.text);
}

function review(shown: SetupPlan, done: SetupDoneStep[], all = false): string[] {
  return texts(
    setupLines({
      run: run(shown, done),
      draft: { kind: 'review' },
      t,
      closeKey: 'Esc',
      reviewNotes: { all, key: 'D' },
    }),
  );
}

describe('the review by account', () => {
  it('drops the account from the names when one account takes part', () => {
    const id = 'claude-haiku-low@claude-code/work';
    const lines = review(
      plan({
        executors: [executor(id)],
        roles: [
          { role: 'director', executors: [id], whenExhausted: 'next' },
          { role: 'author', executors: [], whenExhausted: 'wait' },
        ],
        writes: ['roles.preset', `executors.${id}`],
      }),
      [detected(['claude-code/work'])],
    );
    expect(lines).toContain('Accounts');
    expect(lines.some((line) => /^claude-code\/work +1 new Executor$/.test(line))).toBe(true);
    expect(lines.some((line) => /^claude-haiku-low +director$/.test(line))).toBe(true);
    expect(lines.some((line) => /^Roles +when exhausted$/.test(line))).toBe(true);
    expect(lines.some((line) => /^director +claude-haiku-low +go to the next$/.test(line))).toBe(
      true,
    );
    expect(lines.some((line) => /^author +no Executor +wait for the reset$/.test(line))).toBe(true);
    expect(lines).toContain('2 keys written · D shows the details');
  });

  it('keeps the full ids when two accounts take part', () => {
    const a = 'claude-haiku-low@claude-code/work';
    const b = 'gpt-mini-low@codex/home';
    const lines = review(
      plan({
        executors: [executor(a), executor(b)],
        roles: [{ role: 'director', executors: [a, b], whenExhausted: 'next' }],
      }),
      [detected(['claude-code/work', 'codex/home'])],
    );
    expect(lines.some((line) => line.includes(`${a}, ${b}`))).toBe(true);
    expect(lines.some((line) => /^codex\/home +1 new Executor$/.test(line))).toBe(true);
    expect(lines).toContain('nothing is written');
  });

  it('says why an account found is left out', () => {
    const lines = review(plan(), [
      detected(
        ['claude-code/work'],
        [
          profileOf('claude-code/work'),
          profileOf('codex/home'),
          profileOf('claude-code/old', { usable: false, login: 'logged_out' }),
          profileOf('opencode/api', { usable: false, kind: 'api', hasSecret: false }),
        ],
      ),
    ]);
    expect(lines.some((line) => /^codex\/home +out: not marked in Accounts$/.test(line))).toBe(
      true,
    );
    expect(lines.some((line) => /^claude-code\/old +out: logged out$/.test(line))).toBe(true);
    expect(lines.some((line) => /^opencode\/api +out: no API key$/.test(line))).toBe(true);
  });

  it('shows the cap of an API account under it', () => {
    const id = 'claude-haiku-low@claude-code/api';
    const lines = review(
      plan({
        executors: [executor(id)],
        budgets: [{ profileId: 'claude-code/api', dailyUsd: 5, monthlyUsd: 50 }],
      }),
      [detected(['claude-code/api'])],
    );
    expect(lines.some((line) => line.startsWith('cap: day'))).toBe(true);
  });

  it('unfolds the keys with D', () => {
    const lines = review(plan({ writes: ['roles.preset', 'roles.director.executors'] }), [], true);
    expect(lines).toContain('Keys written to the configuration');
    expect(lines).toContain('roles.director.executors');
    expect(lines.some((line) => line.includes('shows the details'))).toBe(false);
  });

  it('shows the message of the daemon for a code it cannot word', () => {
    const lines = review(
      plan({
        notes: [
          { severity: 'warning', code: 'something_new', role: null, message: 'a new kind of note' },
        ],
      }),
      [],
    );
    expect(lines).toContain('⚠ a new kind of note');
  });

  it('words a note by its code, with the short name of the Executor', () => {
    const lines = review(
      plan({
        notes: [
          {
            severity: 'warning',
            code: 'not_registered',
            role: 'author',
            executorId: 'gpt-mini-low@codex/home',
            profileId: 'codex/home',
            message: 'gpt-mini-low@codex/home is not registered',
          },
        ],
      }),
      [detected(['codex/home'])],
    );
    expect(lines).toContain(
      '⚠ gpt-mini-low is neither registered nor in a catalog: left out of author',
    );
  });
});

describe('the finished screen', () => {
  it('repeats the summary of the review that was confirmed, with the next step', () => {
    const id = 'claude-haiku-low@claude-code/work';
    const confirmed = plan({
      executors: [executor(id)],
      roles: [{ role: 'director', executors: [id], whenExhausted: 'next' }],
    });
    const lines = texts(
      setupLines({
        run: run(null, [detected(['claude-code/work'])], {
          state: 'confirmed',
          result: {
            preset: 'balanced',
            executors: [id],
            written: ['roles.preset', `executors.${id}`],
          },
        }),
        draft: { kind: 'review' },
        t,
        closeKey: 'Esc',
        confirmedPlan: confirmed,
      }),
    );
    expect(lines).toContain('✓ Done. The configuration was written.');
    expect(lines).toContain('Preset: balanced');
    expect(lines.some((line) => /^director +claude-haiku-low +go to the next$/.test(line))).toBe(
      true,
    );
    expect(lines).toContain('✓ 2 keys written');
    expect(lines).toContain(
      'Next step: close the assistant to see the panel, or run `ot status` in a terminal.',
    );
  });

  it('falls back to the result without the plan', () => {
    const lines = texts(
      setupLines({
        run: run(null, [], {
          state: 'confirmed',
          result: { preset: null, executors: ['a@b/c'], written: [] },
        }),
        draft: { kind: 'review' },
        t,
        closeKey: 'Esc',
      }),
    );
    expect(lines).toContain('Executors registered: a@b/c');
    expect(lines).toContain('nothing is written');
  });
});

describe('the security step and the restart line (N334, [proposta])', () => {
  it('says the risk and lists the two options, the chosen one selected', () => {
    const prompt = { step: 'security', layer3: false, unenforced: 'refuse' } as const;
    for (const cursor of [0, 1]) {
      const lines = setupLines({
        run: run(null, [], { step: 'security', prompt }),
        draft: { kind: 'security', cursor },
        t,
        closeKey: 'Esc',
      });
      const risk = lines.find((line) => line.key === 's.risk')?.text;
      expect(risk).toContain('security.unenforced is refuse');
      expect(risk).toContain('the Director will not open');
      const options = lines.filter((line) => line.key === 's.no' || line.key === 's.yes');
      expect(options.map((line) => line.selected)).toEqual([cursor === 0, cursor === 1]);
      expect(options[0]?.text).toContain('No:');
      expect(options[1]?.text).toContain('security.unenforced: warn');
    }
  });

  it('the finished screen says the daemon has to restart for a key that was written', () => {
    const base = { state: 'confirmed', prompt: null } as const;
    const lines = (restart?: string[]): string[] =>
      texts(
        setupLines({
          run: run(null, [], {
            ...base,
            result: {
              preset: null,
              executors: [],
              written: ['security.unenforced'],
              ...(restart === undefined ? {} : { restart }),
            },
          }),
          draft: { kind: 'review' },
          t,
          closeKey: 'Esc',
        }),
      );
    expect(lines(['security.unenforced'])).toContain(
      '⚠ Restart the daemon for it to apply: security.unenforced',
    );
    expect(lines().some((line) => line.includes('Restart the daemon'))).toBe(false);
    expect(lines([]).some((line) => line.includes('Restart the daemon'))).toBe(false);
  });
});

describe('the table of the models (N335)', () => {
  function row(model: string, extra: Partial<ExecutorRow> = {}): ExecutorRow {
    return {
      profileId: 'codex/work',
      model,
      name: null,
      floating: null,
      efforts: ['low', 'high'],
      effort: 'high',
      on: true,
      seed: null,
      registered: false,
      ...extra,
    };
  }

  const rows = [
    row('gpt-sol', {
      seed: { id: 'gpt-sol-high@codex/work', effort: 'high' } as ExecutorRow['seed'],
    }),
    row('gpt-old', { on: false, registered: true, effort: null }),
  ];

  function draftOf(extra: Partial<Extract<Draft, { kind: 'executors' }>> = {}): Draft {
    return {
      kind: 'executors',
      executors: [],
      budgets: {},
      cursor: 0,
      layout: 'table',
      list: 'ready',
      rows,
      groups: [{ profileId: 'codex/work', catalog: 'listed', reason: null }],
      ...extra,
    };
  }

  function table(width: number, draft: Draft = draftOf()): SetupLine[] {
    const executors: SetupRunView['prompt'] = {
      step: 'executors',
      apiProfiles: [],
      suggestedBudget: { dailyUsd: 5, monthlyUsd: 50 },
    };
    return setupLines({
      run: { ...run(null, []), step: 'executors', prompt: executors },
      draft,
      t,
      closeKey: 'Enter',
      width,
    });
  }

  it('draws the head, the rows as raw lines, and the item that goes on', () => {
    const lines = table(120);
    const head = lines.find((line) => line.key === 'h.table');
    expect(head?.raw).toBe(true);
    expect(head?.text).toMatch(/Mark +Model +Effort +Roles +Position +Status/);
    const first = lines.find((line) => line.key === 'r.0');
    expect(first?.raw).toBe(true);
    expect(first?.selected).toBe(true);
    expect(first?.text).toMatch(/\[x\] +gpt-sol +high/);
    // The registered row is dim, marks `[=]` and has no effort.
    const second = lines.find((line) => line.key === 'r.1');
    expect(second?.dim).toBe(true);
    expect(second?.text).toMatch(/\[=\] +gpt-old/);
    expect(lines.find((line) => line.key === 'e.next')?.text).toBe('Enter goes on to the review');
  });

  it('puts the focus on the cell of the column, and on no cell of a registered row', () => {
    const mark = table(120).find((line) => line.key === 'r.0');
    const effort = table(120, draftOf({ column: 'effort' })).find((line) => line.key === 'r.0');
    expect(mark?.focus).toBeDefined();
    expect(effort?.focus).toBeDefined();
    expect(effort?.focus?.[0]).toBeGreaterThan(mark?.focus?.[1] ?? 0);
    const registered = table(120, draftOf({ cursor: 1 })).find((line) => line.key === 'r.1');
    expect(registered?.focus).toBeUndefined();
  });

  it('drops Status, then Position, on a narrow terminal [proposta], and keeps every line inside it', () => {
    const wide = table(120).find((line) => line.key === 'h.table')?.text ?? '';
    expect(wide).toContain('Status');
    expect(wide).toContain('Position');
    for (const width of [60, 40, 32]) {
      const lines = table(width).filter((line) => line.raw === true);
      for (const line of lines) expect(line.text.length).toBeLessThan(width);
    }
    const narrow = table(36).find((line) => line.key === 'h.table')?.text ?? '';
    expect(narrow).not.toContain('Status');
    expect(narrow).not.toContain('Position');
    expect(narrow).toContain('Mark');
    expect(narrow).toContain('Effort');
    expect(narrow).toContain('Roles');
  });

  it('keeps the rows of before with the layout list', () => {
    const lines = table(120, draftOf({ layout: 'list' }));
    expect(lines.some((line) => line.key === 'h.table')).toBe(false);
    expect(lines.some((line) => line.key === 'e.next')).toBe(false);
  });
});
