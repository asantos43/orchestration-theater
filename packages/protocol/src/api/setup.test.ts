// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import {
  SETUP_FLOW_STEPS,
  SetupExecutorsInputSchema,
  SetupPromptSchema,
  SetupResultSchema,
  SetupRolePlacementSchema,
  SetupSecurityInputSchema,
} from './setup.js';

describe('the roles given to an Executor at the executors step (N333)', () => {
  it('defaults to none, so an older client answers the step as before', () => {
    expect(SetupExecutorsInputSchema.parse({})).toEqual({
      executors: [],
      budgets: [],
      exclude: [],
      roles: [],
    });
  });

  it('takes an Executor with one or more roles', () => {
    const parsed = SetupExecutorsInputSchema.parse({
      roles: [{ executorId: 'codex-sol-high@codex/main', roles: ['author', 'reviewer'] }],
    });
    expect(parsed.roles).toEqual([
      { executorId: 'codex-sol-high@codex/main', mode: 'add', roles: ['author', 'reviewer'] },
    ]);
  });

  it('refuses an empty list of roles, an unknown role and an extra field', () => {
    expect(SetupRolePlacementSchema.safeParse({ executorId: 'a@b/c', roles: [] }).success).toBe(
      false,
    );
    expect(
      SetupRolePlacementSchema.safeParse({ executorId: 'a@b/c', roles: ['judge'] }).success,
    ).toBe(false);
    expect(
      SetupRolePlacementSchema.safeParse({ executorId: 'a@b/c', roles: ['actor'], extra: 1 })
        .success,
    ).toBe(false);
  });

  it('mode add is the default, and exact is the exact set of roles (N335, [proposta])', () => {
    expect(SetupRolePlacementSchema.parse({ executorId: 'a@b/c', roles: ['actor'] }).mode).toBe(
      'add',
    );
    expect(
      SetupRolePlacementSchema.parse({ executorId: 'a@b/c', mode: 'exact', roles: ['actor'] }).mode,
    ).toBe('exact');
    expect(
      SetupRolePlacementSchema.safeParse({ executorId: 'a@b/c', mode: 'merge', roles: ['actor'] })
        .success,
    ).toBe(false);
  });

  it('exact may take the Executor out of every role; add may not', () => {
    expect(
      SetupRolePlacementSchema.safeParse({ executorId: 'a@b/c', mode: 'exact', roles: [] }).success,
    ).toBe(true);
    expect(
      SetupRolePlacementSchema.safeParse({ executorId: 'a@b/c', mode: 'add', roles: [] }).success,
    ).toBe(false);
  });

  it('names the Executor by id or by the index of the request, never both or neither', () => {
    const byRequest = SetupRolePlacementSchema.parse({ request: 1, roles: ['critic'] });
    expect(byRequest).toEqual({ request: 1, mode: 'add', roles: ['critic'] });
    expect(
      SetupRolePlacementSchema.safeParse({ executorId: 'a@b/c', request: 0, roles: ['critic'] })
        .success,
    ).toBe(false);
    expect(SetupRolePlacementSchema.safeParse({ roles: ['critic'] }).success).toBe(false);
    expect(SetupRolePlacementSchema.safeParse({ request: -1, roles: ['critic'] }).success).toBe(
      false,
    );
    expect(SetupRolePlacementSchema.safeParse({ request: 32, roles: ['critic'] }).success).toBe(
      false,
    );
    expect(SetupRolePlacementSchema.safeParse({ request: 1.5, roles: ['critic'] }).success).toBe(
      false,
    );
  });
});

describe('the security step of the assistant (N334, [proposta])', () => {
  it('is in the first run only, before the Executors', () => {
    expect(SETUP_FLOW_STEPS.first_run).toEqual([
      'detect',
      'preset',
      'security',
      'executors',
      'review',
    ]);
    expect(SETUP_FLOW_STEPS.add_account).not.toContain('security');
    expect(SETUP_FLOW_STEPS.change_preset).not.toContain('security');
  });

  it('takes a yes or a no and nothing else', () => {
    expect(SetupSecurityInputSchema.parse({ warn: true })).toEqual({ warn: true });
    expect(SetupSecurityInputSchema.safeParse({}).success).toBe(false);
    expect(SetupSecurityInputSchema.safeParse({ warn: 'yes' }).success).toBe(false);
    expect(SetupSecurityInputSchema.safeParse({ warn: true, extra: 1 }).success).toBe(false);
  });

  it('prompts with layer 3 and the effective value, and a result may say what needs a restart', () => {
    const prompt = { step: 'security', layer3: false, unenforced: 'refuse' };
    expect(SetupPromptSchema.parse(prompt)).toEqual(prompt);
    expect(SetupPromptSchema.safeParse({ ...prompt, unenforced: 'off' }).success).toBe(false);
    const result = { preset: null, executors: [], written: ['security.unenforced'] };
    expect(SetupResultSchema.parse(result).restart).toBeUndefined();
    expect(
      SetupResultSchema.parse({ ...result, restart: ['security.unenforced'] }).restart,
    ).toEqual(['security.unenforced']);
  });
});
