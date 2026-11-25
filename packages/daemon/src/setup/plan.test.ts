// SPDX-License-Identifier: MPL-2.0
import type { ProfileFact } from '@otheater/core';
import type { SetupExecutor } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { buildPlan, type PlanInput } from './plan.js';

const SETTINGS = {
  suggestedBudget: { dailyUsd: 20, monthlyUsd: 200 },
  roleLists: 'explicit',
} as const;

const PROFILES: ProfileFact[] = [
  { id: 'claude-code/main', kind: 'token_plan', state: 'active' },
  { id: 'opencode/key', kind: 'api', state: 'active' },
];

function executor(
  id: string,
  profileId: string,
  model: string,
  effort: string | null,
): SetupExecutor {
  return {
    id,
    profileId,
    model,
    alias: model,
    effort,
    provider: 'anthropic',
    source: 'discovered',
    presetExpand: true,
    local: null,
  };
}

const OPUS = executor(
  'claude-opus-high@claude-code/main',
  'claude-code/main',
  'claude-opus',
  'high',
);
const API = executor('minimax-m2-medium@opencode/key', 'opencode/key', 'minimax-m2', 'medium');

function input(over: Partial<PlanInput> & { yaml?: string } = {}): PlanInput {
  const { yaml = '', ...rest } = over;
  return {
    flow: 'first_run',
    config: parseConfig(yaml),
    profiles: PROFILES,
    preset: 'quality',
    discovered: [OPUS],
    registered: [API],
    givenBudgets: [],
    carriedNotes: [],
    settings: SETTINGS,
    ...rest,
  };
}

describe('the plan of the assistant', () => {
  it('lists what the plan writes as dotted keys, and drops the Executors that do not exist', () => {
    const { plan, apply } = buildPlan(input());
    expect(plan.writes).toContain('roles.preset');
    expect(plan.writes).toContain(`executors.${OPUS.id}`);
    expect(plan.writes).toContain('roles.author.executors');
    expect(plan.writes).toContain('profiles.opencode/key.budget');
    const author = plan.roles.find((role) => role.role === 'author');
    // The `codex-sol-high` of the preset has no account here, so it is not in the list.
    expect(author?.executors).toEqual([OPUS.id, API.id]);
    expect(apply.lists.find((list) => list.role === 'author')?.executors).toEqual([
      OPUS.id,
      API.id,
    ]);
    expect(plan.notes.map((note) => note.code)).toContain('no_account');
    // The note names the head of the preset, so the screen can fold a family into one line (N324).
    expect(plan.notes).toContainEqual(
      expect.objectContaining({ code: 'no_account', role: 'author', head: 'codex-sol-high' }),
    );
    expect(
      plan.notes.filter((note) => note.code !== 'no_account').every((n) => !('head' in n)),
    ).toBe(true);
  });

  it('proposes the suggested cap for an API account with no cap, and not when the file has one', () => {
    expect(buildPlan(input()).plan.budgets).toEqual([
      { profileId: 'opencode/key', dailyUsd: 20, monthlyUsd: 200 },
    ]);
    const kept = buildPlan(
      input({ yaml: 'profiles:\n  opencode/key:\n    budget:\n      daily_usd: 3\n' }),
    );
    expect(kept.plan.budgets).toEqual([]);
    expect(kept.plan.notes.map((note) => note.code)).not.toContain('budget_suggested');
  });

  it('the given cap replaces the suggested one', () => {
    const given = { profileId: 'opencode/key', dailyUsd: null, monthlyUsd: 50 };
    const { plan } = buildPlan(input({ givenBudgets: [given] }));
    expect(plan.budgets).toEqual([given]);
  });

  it('warns that the lists of the file and the old format are replaced', () => {
    const { plan } = buildPlan(
      input({
        yaml: [
          'roles:',
          '  author:',
          '    executors: [claude-sonnet-medium@claude-code/main]',
          'orchestration:',
          '  executor:',
          '    client: claude-code',
          '    profile: main',
          '    model: claude-opus',
          '    effort: high',
          '',
        ].join('\n'),
      }),
    );
    const codes = plan.notes.map((note) => note.code);
    expect(codes).toContain('lists_replaced');
    expect(codes).toContain('legacy_executors');
  });

  it('with role_lists: preset, writes no list at all', () => {
    const { plan, apply } = buildPlan(input({ settings: { ...SETTINGS, roleLists: 'preset' } }));
    expect(apply.lists).toEqual([]);
    expect(plan.writes.filter((key) => key.startsWith('roles.') && key !== 'roles.preset')).toEqual(
      [],
    );
    // The plan still shows the lists the preset resolves to.
    expect(plan.roles.find((role) => role.role === 'author')?.executors).toContain(OPUS.id);
  });

  it('adding an account keeps the lists of the file and inserts where the preset says', () => {
    const { apply, plan } = buildPlan(
      input({
        flow: 'add_account',
        preset: null,
        discovered: [],
        registered: [API],
        yaml: [
          'roles:',
          '  preset: quality',
          '  actor:',
          '    executors: [codex-sol-high@codex/main, claude-sonnet-medium@claude-code/main]',
          '',
        ].join('\n'),
      }),
    );
    expect(plan.preset).toBeNull();
    expect(apply.preset).toBeNull();
    expect(apply.lists).toEqual([]);
    // The preset names `minimax-m2-medium` as the last Actor.
    expect(apply.insertions).toEqual([{ role: 'actor', position: 2, id: API.id }]);
  });

  it("an Executor the file already has is the Producer's: it is not written again", () => {
    const yaml = `${OPUS.id}:\n    client: claude-code\n    profile: main\n    model: claude-opus\n    effort: high\n    provider: anthropic\n`;
    const { plan } = buildPlan(input({ yaml: `executors:\n  ${yaml}` }));
    expect(plan.executors.map((item) => item.id)).toEqual([API.id]);
  });

  it('no account is a warning, not an error', () => {
    const { plan } = buildPlan(input({ profiles: [], discovered: [], registered: [] }));
    expect(plan.notes.map((note) => note.code)).toContain('no_accounts');
    expect(plan.roles.every((role) => role.executors.length === 0)).toBe(true);
  });
});
