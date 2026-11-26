// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { SetupExecutorsInputSchema, SetupRolePlacementSchema } from './setup.js';

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
      { executorId: 'codex-sol-high@codex/main', roles: ['author', 'reviewer'] },
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
});
