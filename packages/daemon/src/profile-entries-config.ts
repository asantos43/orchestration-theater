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
  codex_link: z.string().min(1).optional(),
});
export interface ProfileEntry {
  readonly budget?: ProfileBudgetConfig | undefined;
  readonly local?: LocalConfig | undefined;
  /**
   * P25 (N156): the Codex profile (its name, `chatgpt` for `codex/chatgpt`) of the same ChatGPT
   * account as this OpenCode profile. With `quota.opencode.mode` `auto` or `codex_link`, the quota
   * of this profile is read through the probe of Codex for that profile, and the selector takes
   * the two as one account. Only an `opencode/...` profile may have it. What the owner declares
   * is trusted: the daemon does not check that the two are the same account.
   */
  readonly codex_link?: string | undefined;
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
        if (parsed.data.codex_link !== undefined) {
          if (parseProfileId(key).client !== 'opencode') {
            issue([key, 'codex_link'], 'codex_link is only for an opencode/<profile> profile');
            continue;
          }
          try {
            parseProfileId(`codex/${parsed.data.codex_link}`);
          } catch {
            issue(
              [key, 'codex_link'],
              'codex_link is the name of a Codex profile (chatgpt for codex/chatgpt)',
            );
            continue;
          }
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
