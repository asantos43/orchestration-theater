// SPDX-License-Identifier: MPL-2.0
import type { SetupExecutor, SetupModel, SetupModels, SetupRoleList } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import {
  listOf,
  presetIdOf,
  rolesOfId,
  rowEffortMoved,
  rowsSubmission,
  rowToggled,
  seededRows,
  type ExecutorRow,
} from './executor-list.js';

function model(id: string, extra: Partial<SetupModel> = {}): SetupModel {
  return {
    id,
    name: null,
    family: null,
    efforts: [],
    local: false,
    contextWindow: null,
    floating: null,
    preset: [],
    registered: [],
    ...extra,
  };
}

function catalog(models: SetupModel[], extra: Partial<SetupModels> = {}): SetupModels {
  return {
    profileId: 'codex/work',
    kind: 'token_plan',
    login: 'logged_in',
    preset: 'balanced',
    reason: null,
    notes: [],
    catalog: 'listed',
    models,
    ...extra,
  };
}

const SOL = model('gpt-sol', {
  efforts: ['low', 'medium', 'high', 'xhigh'],
  preset: [{ id: 'codex-sol-high@codex/work', effort: 'high' }],
});

function rowsOf(models: SetupModel[]): ExecutorRow[] {
  return listOf([{ profileId: 'codex/work', found: catalog(models) }]).rows;
}

describe('the rows of the list of models (N333)', () => {
  it('checks what the preset uses at its effort, and starts the others off at medium', () => {
    const rows = rowsOf([SOL, model('gpt-mini')]);
    expect(rows.map((row) => [row.model, row.on, row.effort])).toEqual([
      ['gpt-sol', true, 'high'],
      ['gpt-mini', false, 'medium'],
    ]);
    expect(rows[0]?.seed).toEqual({
      id: 'codex-sol-high@codex/work',
      effort: 'high',
      alias: 'codex-sol',
    });
    expect(rows[1]?.efforts).toEqual(['low', 'medium', 'high']);
    expect(rows.map((row) => presetIdOf(row))).toEqual(['codex-sol-high@codex/work', undefined]);
  });

  it('starts at the first effort when the model has no medium, and shows a registered model aside', () => {
    const rows = rowsOf([
      model('odd', { efforts: ['minimal', 'high'] }),
      model('known', { registered: ['known-medium@codex/work'] }),
    ]);
    expect(rows[0]?.effort).toBe('minimal');
    expect(rows[1]).toMatchObject({ registered: true, on: false });
    expect(rowsSubmission(rowToggled(rows, 1))).toEqual({ executors: [], exclude: [] });
  });

  it('starts the rows as the Executors of the run, not of the preset the route read', () => {
    // The route read the preset in force (`quality`: sonnet at medium); the run chose `balanced`,
    // which has sonnet at high and at medium. A row seeded by the route alone, moved to high, would
    // ask for an Executor the run already has (refused as "given twice").
    const found = (id: string, effort: string): SetupExecutor => ({
      id,
      profileId: 'codex/work',
      model: 'sonnet',
      alias: 'claude-sonnet',
      effort,
      provider: 'anthropic',
      source: 'discovered',
      presetExpand: true,
      local: null,
    });
    const sonnet = model('sonnet', {
      efforts: ['low', 'medium', 'high'],
      preset: [{ id: 'claude-sonnet-medium@codex/work', effort: 'medium' }],
    });
    const { rows } = listOf(
      [{ profileId: 'codex/work', found: catalog([sonnet]) }],
      [
        found('claude-sonnet-high@codex/work', 'high'),
        found('claude-sonnet-medium@codex/work', 'medium'),
      ],
    );
    expect(rows.map((row) => [row.on, row.effort, row.seed?.id])).toEqual([
      [true, 'high', 'claude-sonnet-high@codex/work'],
      [true, 'medium', 'claude-sonnet-medium@codex/work'],
    ]);
    expect(rowsSubmission(rows)).toEqual({ executors: [], exclude: [] });
    // The effort of one row skips the one the other holds.
    expect(rowEffortMoved(rows, 1, 1)[1]?.effort).toBe('medium');
    // A model the run did not discover starts off, whatever the route said.
    const none = listOf([{ profileId: 'codex/work', found: catalog([sonnet]) }], []).rows;
    expect(none.map((row) => [row.on, row.seed])).toEqual([[false, null]]);
  });

  it('gives a group per account, and no rows to a catalog that is not listed or failed', () => {
    const { rows, groups } = listOf([
      { profileId: 'a/one', found: catalog([SOL], { profileId: 'a/one' }) },
      { profileId: 'b/two', found: catalog([], { profileId: 'b/two', catalog: 'none' }) },
      { profileId: 'c/three', failure: 'no answer' },
    ]);
    expect(rows).toHaveLength(1);
    expect(groups.map((group) => [group.profileId, group.catalog])).toEqual([
      ['a/one', 'listed'],
      ['b/two', 'none'],
      ['c/three', 'failed'],
    ]);
    expect(groups[2]?.reason).toBe('no answer');
  });

  it('a row that is checked at its preset effort asks for nothing; a change asks for it with the preset name', () => {
    const rows = rowsOf([SOL, model('gpt-mini')]);
    expect(rowsSubmission(rows)).toEqual({ executors: [], exclude: [] });
    const moved = rowEffortMoved(rows, 0, 1);
    expect(moved[0]?.effort).toBe('xhigh');
    expect(rowsSubmission(moved)).toEqual({
      executors: [
        { profileId: 'codex/work', model: 'gpt-sol', effort: 'xhigh', alias: 'codex-sol' },
      ],
      exclude: ['codex-sol-high@codex/work'],
    });
    const off = rowToggled(rows, 0);
    expect(rowsSubmission(off)).toEqual({ executors: [], exclude: ['codex-sol-high@codex/work'] });
    const on = rowToggled(rows, 1);
    expect(rowsSubmission(on).executors).toEqual([
      { profileId: 'codex/work', model: 'gpt-mini', effort: 'medium' },
    ]);
  });

  it('the effort stops at the ends and skips one another row of the model holds', () => {
    const twin = model('gpt-sol', {
      efforts: ['low', 'medium', 'high'],
      preset: [
        { id: 'codex-sol-low@codex/work', effort: 'low' },
        { id: 'codex-sol-high@codex/work', effort: 'high' },
      ],
    });
    const rows = rowsOf([twin]);
    expect(rows.map((row) => row.effort)).toEqual(['low', 'high']);
    // Low goes up to medium, and from there the next one (high) is held: it stays.
    const medium = rowEffortMoved(rows, 0, 1);
    expect(medium[0]?.effort).toBe('medium');
    expect(rowEffortMoved(medium, 0, 1)[0]?.effort).toBe('medium');
    expect(rowEffortMoved(rows, 0, -1)[0]?.effort).toBe('low');
  });

  it('a preset Executor with no effort cycles through none first', () => {
    const plain = model('claude-sonnet', {
      efforts: ['low', 'high'],
      preset: [{ id: 'claude-sonnet@codex/work', effort: null }],
    });
    const rows = rowsOf([plain]);
    expect(rows[0]?.effort).toBeNull();
    expect(rowEffortMoved(rows, 0, 1)[0]?.effort).toBe('low');
    expect(rowEffortMoved(rowEffortMoved(rows, 0, 1), 0, -1)[0]?.effort).toBeNull();
  });
});

describe('what the list after a login already chose (N324 seed)', () => {
  it('checks the row of a typed request and unchecks the row of an excluded id; the rest stays', () => {
    const rows = rowsOf([SOL, model('gpt-mini')]);
    const seeded = seededRows(
      rows,
      [
        { profileId: 'codex/work', model: 'gpt-mini', effort: 'high' },
        { profileId: 'codex/work', model: 'elsewhere' },
      ],
      ['codex-sol-high@codex/work', 'ghost@codex/work'],
    );
    expect(seeded.rows.map((row) => [row.model, row.on, row.effort])).toEqual([
      ['gpt-sol', false, 'high'],
      ['gpt-mini', true, 'high'],
    ]);
    expect(seeded.executors).toEqual([{ profileId: 'codex/work', model: 'elsewhere' }]);
    expect(seeded.exclude).toEqual(['ghost@codex/work']);
  });
});

describe('the roles beside a row', () => {
  it('lists the roles of the preset that hold the id, in the order of the roles', () => {
    const roles: SetupRoleList[] = [
      { role: 'author', executors: ['a@x/y'], whenExhausted: 'next' },
      { role: 'reviewer', executors: ['b@x/y', 'a@x/y'], whenExhausted: 'next' },
    ];
    expect(rolesOfId(roles, 'a@x/y')).toEqual(['author', 'reviewer']);
    expect(rolesOfId(roles, 'c@x/y')).toEqual([]);
    expect(rolesOfId(roles, undefined)).toEqual([]);
  });
});
