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

  it('names the Executor and the account a note is about (2026-11-26)', () => {
    const { plan } = buildPlan(
      input({
        preset: null,
        yaml: 'roles:\n  director:\n    executors: [ghost-low@claude-code/main]\n',
      }),
    );
    expect(plan.notes).toContainEqual(
      expect.objectContaining({
        code: 'not_registered',
        role: 'director',
        executorId: 'ghost-low@claude-code/main',
        profileId: 'claude-code/main',
      }),
    );
    expect(plan.notes).toContainEqual(
      expect.objectContaining({ code: 'budget_suggested', profileId: 'opencode/key' }),
    );
    // A note about no Executor carries neither.
    expect(
      plan.notes
        .filter((note) => note.code === 'no_account')
        .every((note) => !('executorId' in note) && !('profileId' in note)),
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

  describe('the roles given at the review (N333)', () => {
    const EXTRA = executor('mystery-medium@opencode/key', 'opencode/key', 'mystery', 'medium');

    it('puts the Executor at the end of the list of each role, and writes the lists (explicit)', () => {
      const without = buildPlan(input({ registered: [API, EXTRA] }));
      // The preset names no `mystery`: the Executor has no role.
      expect(without.plan.roles.every((role) => !role.executors.includes(EXTRA.id))).toBe(true);
      const { plan, apply } = buildPlan(
        input({
          registered: [API, EXTRA],
          placements: [{ executorId: EXTRA.id, roles: ['critic', 'author'] }],
        }),
      );
      for (const role of ['critic', 'author'] as const) {
        const ids = plan.roles.find((entry) => entry.role === role)?.executors ?? [];
        expect(ids.at(-1)).toBe(EXTRA.id);
        expect(apply.lists.find((list) => list.role === role)?.executors.at(-1)).toBe(EXTRA.id);
      }
      expect(plan.roles.find((entry) => entry.role === 'actor')?.executors).not.toContain(EXTRA.id);
    });

    it('with role_lists: preset, only the role that was given is written, whole', () => {
      const { plan, apply } = buildPlan(
        input({
          registered: [API, EXTRA],
          settings: { ...SETTINGS, roleLists: 'preset' },
          placements: [{ executorId: EXTRA.id, roles: ['critic'] }],
        }),
      );
      expect(plan.roles.find((entry) => entry.role === 'critic')?.executors.at(-1)).toBe(EXTRA.id);
      // The preset cannot hold the choice: that one role is written, as the plan shows it.
      expect(apply.lists).toEqual([
        {
          role: 'critic',
          executors: plan.roles.find((entry) => entry.role === 'critic')?.executors,
        },
      ]);
    });

    it('keeping the lists of the file: inserts at the end of a list, and writes a role with no list whole', () => {
      const { plan, apply } = buildPlan(
        input({
          flow: 'add_account',
          preset: null,
          discovered: [],
          registered: [EXTRA],
          yaml: [
            'roles:',
            '  preset: quality',
            '  actor:',
            '    executors: [codex-sol-high@codex/main, claude-sonnet-medium@claude-code/main]',
            '',
          ].join('\n'),
          placements: [{ executorId: EXTRA.id, roles: ['actor', 'critic'] }],
        }),
      );
      // The list of the file takes an insertion at the end.
      expect(apply.insertions).toEqual([{ role: 'actor', position: 2, id: EXTRA.id }]);
      expect(plan.roles.find((entry) => entry.role === 'actor')?.executors.at(-1)).toBe(EXTRA.id);
      // The Critic has no list in the file: it is written whole, with the Executor last.
      const critic = apply.lists.find((list) => list.role === 'critic');
      expect(critic?.executors.at(-1)).toBe(EXTRA.id);
      expect(critic?.executors).toEqual(
        plan.roles.find((entry) => entry.role === 'critic')?.executors,
      );
      expect(plan.writes).toContain('roles.critic.executors');
      expect(plan.writes).toContain('roles.actor.executors');
    });

    it('ignores an Executor the plan does not have, and a role whose list already holds it', () => {
      const { plan } = buildPlan(
        input({
          placements: [
            { executorId: 'ghost-high@claude-code/main', roles: ['critic'] },
            { executorId: OPUS.id, roles: ['author'] },
          ],
        }),
      );
      const author = plan.roles.find((entry) => entry.role === 'author')?.executors ?? [];
      expect(author.filter((id) => id === OPUS.id)).toHaveLength(1);
      for (const role of plan.roles)
        expect(role.executors).not.toContain('ghost-high@claude-code/main');
    });
  });

  it('no account is a warning, not an error', () => {
    const { plan } = buildPlan(input({ profiles: [], discovered: [], registered: [] }));
    expect(plan.notes.map((note) => note.code)).toContain('no_accounts');
    expect(plan.roles.every((role) => role.executors.length === 0)).toBe(true);
  });
});

describe('the plan and the layers of guarantee (N334, [proposta])', () => {
  const security = (
    over: Partial<NonNullable<PlanInput['security']>> = {},
  ): NonNullable<PlanInput['security']> => ({
    layer3: false,
    unenforced: 'refuse',
    answer: 'none',
    ...over,
  });
  const codes = (result: ReturnType<typeof buildPlan>): string[] =>
    result.plan.notes.map((note) => note.code);

  it('writes security.unenforced: warn only on a yes', () => {
    const yes = buildPlan(input({ security: security({ answer: 'warn' }) }));
    expect(yes.apply.unenforced).toBe('warn');
    expect(yes.plan.writes).toContain('security.unenforced');
    expect(codes(yes)).toContain('unenforced_warn');
    expect(codes(yes)).not.toContain('director_will_not_open');

    for (const answer of ['keep', 'none'] as const) {
      const no = buildPlan(input({ security: security({ answer }) }));
      expect(no.apply.unenforced).toBeNull();
      expect(no.plan.writes).not.toContain('security.unenforced');
      // A "no" changes nothing, and the review says the Director will not open here.
      expect(codes(no)).toContain('director_will_not_open');
      expect(codes(no)).not.toContain('unenforced_warn');
    }
  });

  it('writes nothing, and says nothing, with layer 3 or when the value is already warn or allow', () => {
    for (const over of [
      { layer3: true, answer: 'warn' as const },
      { unenforced: 'warn' as const, answer: 'warn' as const },
      { unenforced: 'allow' as const, answer: 'none' as const },
    ]) {
      const result = buildPlan(input({ security: security(over) }));
      expect(result.apply.unenforced).toBeNull();
      expect(result.plan.writes).not.toContain('security.unenforced');
      expect(codes(result)).not.toContain('director_will_not_open');
      expect(codes(result)).not.toContain('unenforced_warn');
    }
  });

  it('says nothing of the layers when the plan is built without them, and in the other flows', () => {
    expect(codes(buildPlan(input()))).not.toContain('director_will_not_open');
    const other = buildPlan(
      input({ flow: 'change_preset', security: security({ answer: 'warn' }) }),
    );
    expect(codes(other)).not.toContain('director_will_not_open');
    expect(codes(other)).not.toContain('unenforced_warn');
  });
});
