// SPDX-License-Identifier: MPL-2.0

/**
 * The `ui.overview.*` and `ui.usage.*` settings of the Overview and Usage tabs (P13 of docs/18).
 * The schemas of `@otheater/protocol` are the source of truth. Like `../settings.ts`, this reads the
 * objects tolerantly: a missing or invalid value falls back to the default here and nothing throws.
 * The defaults repeat the schemas' on purpose, and a test compares them.
 */

export const CONFIRM_MODES = ['always', 'off'] as const;
export const USAGE_GROUPS = ['profile', 'executor', 'play', 'session', 'none'] as const;

export type ConfirmMode = (typeof CONFIRM_MODES)[number];
export type UsageGroup = (typeof USAGE_GROUPS)[number];

export interface OverviewSettings {
  readonly confirm: ConfirmMode;
  readonly recentEvents: number;
  readonly hiddenEvents: readonly string[];
}

export interface UsageSettings {
  readonly groupBy: UsageGroup;
  /** Seconds between two reads while the tab is open; 0 reads on open and on the key only. */
  readonly refreshSeconds: number;
}

export const DEFAULT_OVERVIEW_SETTINGS: OverviewSettings = {
  confirm: 'always',
  recentEvents: 8,
  hiddenEvents: ['session.update'],
};

export const DEFAULT_USAGE_SETTINGS: UsageSettings = { groupBy: 'profile', refreshSeconds: 30 };

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const items: unknown[] = value;
  return items.every((item) => typeof item === 'string' && item !== '')
    ? (items as string[])
    : fallback;
}

/** Reads `ui.overview` (the object under the `overview` key of `ui`), never throwing. */
export function parseOverviewSettings(input: unknown): OverviewSettings {
  const source = record(input);
  const d = DEFAULT_OVERVIEW_SETTINGS;
  const keep = source.recentEvents;
  return {
    confirm: oneOf(source.confirm, CONFIRM_MODES, d.confirm),
    recentEvents:
      typeof keep === 'number' && Number.isInteger(keep) && keep >= 1 && keep <= 100
        ? keep
        : d.recentEvents,
    hiddenEvents: stringList(source.hiddenEvents, d.hiddenEvents),
  };
}

/** Reads `ui.usage`, never throwing. */
export function parseUsageSettings(input: unknown): UsageSettings {
  const source = record(input);
  const every = source.refreshSeconds;
  return {
    groupBy: oneOf(source.groupBy, USAGE_GROUPS, DEFAULT_USAGE_SETTINGS.groupBy),
    refreshSeconds:
      typeof every === 'number' && Number.isInteger(every) && every >= 0 && every <= 3600
        ? every
        : DEFAULT_USAGE_SETTINGS.refreshSeconds,
  };
}
