// SPDX-License-Identifier: MPL-2.0
import { parseProfileId } from '@otheater/core';
import { LocalConfigSchema, type LocalConfig } from '@otheater/protocol';
import { z } from 'zod';
import { ProfileBudgetSchema, type ProfileBudgetConfig } from './budget-config.js';

/**
 * `profiles.<client>/<profile>` (architecture 5.6 and 5.9; Phase 5, P11 and P14): the block of one
 * profile. `budget` is the spending cap of an API profile (P11, see `budget-config.ts`); `local` is
 * the local model server behind the profile. The cadastro of an OpenCode
 * Executor whose model runs on this machine writes it (5.7, step 2); nothing reads it yet (the
 * admission and the pool still take the instance from the resolver they are given).
 */
export const ProfileEntrySchema = z.strictObject({
  budget: ProfileBudgetSchema.optional(),
  local: LocalConfigSchema.optional(),
});
export interface ProfileEntry {
  readonly budget?: ProfileBudgetConfig | undefined;
  readonly local?: LocalConfig | undefined;
}

/**
 * Widens the `profiles` block: besides its own keys (`known`, parsed by `base` as before), every
 * other key must be a profile id (`opencode/local`) with a {@link ProfileEntrySchema} block. The
 * result is what `base` gives plus `entries`, the profile blocks by id. A key that is neither is
 * refused with the keys it could have been.
 */
export function withProfileEntries<O extends object>(base: z.ZodType<O>, known: readonly string[]) {
  return z
    .record(z.string(), z.unknown())
    .transform((raw, ctx): O & { entries: Record<string, ProfileEntry> } => {
      const issue = (path: (string | number)[], message: string): void => {
        ctx.addIssue({ code: 'custom', path, message });
      };
      const own: Record<string, unknown> = {};
      const entries: Record<string, ProfileEntry> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (known.includes(key)) {
          own[key] = value;
          continue;
        }
        try {
          parseProfileId(key);
        } catch {
          issue(
            [key],
            `${JSON.stringify(key)} is neither a key of profiles (${known.join(', ')}) nor a profile; a profile is written <client>/<profile>`,
          );
          continue;
        }
        const parsed = ProfileEntrySchema.safeParse(value);
        if (!parsed.success) {
          for (const inner of parsed.error.issues) {
            issue([key, ...inner.path.map(String)], inner.message);
          }
          continue;
        }
        entries[key] = parsed.data;
      }
      const parsedBase = base.safeParse(own);
      if (!parsedBase.success) {
        for (const inner of parsedBase.error.issues) issue(inner.path.map(String), inner.message);
        return z.NEVER;
      }
      return { ...parsedBase.data, entries };
    });
}
