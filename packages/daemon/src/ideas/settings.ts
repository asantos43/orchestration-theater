// SPDX-License-Identifier: MPL-2.0
import type { JsonObject } from '@otheater/core';
import { z } from 'zod';

/**
 * The keys `ideas.*` (architecture 5.20, "Fila de ideias"; decision N91):
 * - `drain`: `auto` (default) moves the queue by itself until it is empty; `manual` only moves
 *   by command (`/idea drain`); `scheduled` would move it by the scheduler (5.15), which does not
 *   exist yet, so this daemon refuses it with a clear message instead of ignoring it;
 * - `grouping_approval`: `ask` (default) shows the group to the Producer, who approves, edits or
 *   refuses before the play starts; `auto` opens the play at once and the grouping stays in the
 *   history;
 * - `max_per_play` [proposta, 5]: the largest group;
 * - `parallel_plays` [proposta, 1]: how many plays of the queue run at once in a scenario.
 */
export const IDEA_DRAIN_MODES = ['auto', 'manual', 'scheduled'] as const;
export type IdeaDrainMode = (typeof IDEA_DRAIN_MODES)[number];
export const IDEA_APPROVAL_MODES = ['ask', 'auto'] as const;
export type IdeaApprovalMode = (typeof IDEA_APPROVAL_MODES)[number];

export const SCHEDULED_REFUSED =
  'ideas.drain: "scheduled" needs the task scheduler (architecture 5.15), which this daemon does not have yet. Use "auto" or "manual".';

const drain = z.enum(IDEA_DRAIN_MODES).refine((mode) => mode !== 'scheduled', SCHEDULED_REFUSED);
const approval = z.enum(IDEA_APPROVAL_MODES);
const maxPerPlay = z.int().min(1);
const parallelPlays = z.int().min(1);

/** The `ideas` section of the configuration. */
export const IdeasConfigSchema = z.strictObject({
  drain: drain.default('auto'),
  grouping_approval: approval.default('ask'),
  max_per_play: maxPerPlay.default(5),
  parallel_plays: parallelPlays.default(1),
});

export type IdeaSettings = z.output<typeof IdeasConfigSchema>;

const OVERRIDE_KEYS = {
  'ideas.drain': drain,
  'ideas.grouping_approval': approval,
  'ideas.max_per_play': maxPerPlay,
  'ideas.parallel_plays': parallelPlays,
} as const;

export interface ResolvedIdeaSettings {
  readonly settings: IdeaSettings;
  /** What in the override of the scenario was not used, and why. */
  readonly problems: readonly string[];
}

/**
 * The settings of one scenario: the global `ideas` section, then the keys of the override of the
 * scenario (`configOverride`, written as dotted keys: `ideas.drain`). A project is a scenario of
 * the kind `project`, so its override is this same one. A value that does not fit its key is not
 * used, and the problem comes back for the caller to log.
 */
export function ideaSettingsOf(
  global: IdeaSettings,
  override: JsonObject | undefined,
): ResolvedIdeaSettings {
  const settings: Record<string, unknown> = { ...global };
  const problems: string[] = [];
  for (const [key, schema] of Object.entries(OVERRIDE_KEYS)) {
    const given = override?.[key];
    if (given === undefined) continue;
    const parsed = schema.safeParse(given);
    if (!parsed.success) {
      problems.push(`${key}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      continue;
    }
    settings[key.slice('ideas.'.length)] = parsed.data;
  }
  return { settings: settings as IdeaSettings, problems };
}
