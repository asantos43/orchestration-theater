// SPDX-License-Identifier: MPL-2.0
import type { ApiQuotaStatus, ApiRoles, ConfigEditBody } from '@otheater/protocol';

/**
 * The pure part of the tab Settings (P16 of Phase 7): what its rows say and what its commands
 * write. Nothing here draws or calls the daemon.
 */

/** The ids of the sections the `LayoutStore` keeps folded; the tab name keeps them apart from the other tabs. */
export const SECTION_IDS = [
  'settings.subscriptions',
  'settings.executors',
  'settings.roles',
  'settings.limits',
] as const;
export type SettingsSection = (typeof SECTION_IDS)[number];

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `7_500_000` as `2h 5m`: the two largest units that are not zero (`45s` when under a minute). */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  if (total < 60) return `${String(total)}s`;
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)}d`);
  if (hours > 0) parts.push(`${String(hours)}h`);
  if (minutes > 0 && days === 0) parts.push(`${String(minutes)}m`);
  return parts.slice(0, 2).join(' ');
}

/** What the quota of an account says on a line: its state, how much it used and when it comes back. */
export interface QuotaLine {
  readonly state: ApiQuotaStatus['state'];
  /** The window the account used most, in percent; `undefined` with no reading. */
  readonly percent: number | undefined;
  /** Milliseconds until the reset (never negative); `undefined` when no source says. */
  readonly resetsIn: number | undefined;
}

export function quotaLine(quota: ApiQuotaStatus | null | undefined, now: number): QuotaLine {
  if (quota === null || quota === undefined) {
    return { state: 'unknown', percent: undefined, resetsIn: undefined };
  }
  let worst: ApiQuotaStatus['windows'][number] | undefined;
  for (const window of quota.windows) {
    if (worst === undefined || window.usedPercent > worst.usedPercent) worst = window;
  }
  const until =
    quota.state === 'exhausted' && quota.untilReset !== null
      ? quota.untilReset
      : (worst?.resetsAt ?? undefined);
  return {
    state: quota.state,
    percent: worst === undefined ? undefined : Math.round(worst.usedPercent),
    resetsIn: until === undefined ? undefined : Math.max(0, until - now),
  };
}

/** One line of the section Roles: the rule of the role, or one Executor of its list. */
export type RoleItem =
  | { readonly kind: 'rule'; readonly role: string }
  | { readonly kind: 'executor'; readonly role: string; readonly index: number };

export function roleItems(roles: ApiRoles): readonly RoleItem[] {
  const items: RoleItem[] = [];
  for (const role of roles.roles) {
    items.push({ kind: 'rule', role: role.role });
    role.executors.forEach((_executor, index) => {
      items.push({ kind: 'executor', role: role.role, index });
    });
  }
  return items;
}

/** The ids of a list with the one at `index` moved by `delta`; `undefined` when it would leave the list. */
export function moved(ids: readonly string[], index: number, delta: -1 | 1): string[] | undefined {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return undefined;
  const next = [...ids];
  const [item] = next.splice(index, 1);
  if (item === undefined) return undefined;
  next.splice(target, 0, item);
  return next;
}

/** The edit that writes the order of a role: the whole list, because the key is one list. */
export function reorderEdit(role: string, ids: readonly string[]): ConfigEditBody {
  return { set: [{ path: ['roles', role, 'executors'], value: [...ids] }] };
}

/** The edit that writes the rule of a role. */
export function ruleEdit(role: string, rule: 'next' | 'wait'): ConfigEditBody {
  return { set: [{ path: ['roles', role, 'when_exhausted'], value: rule }] };
}

export const WHEN_EXHAUSTED_CHOICES = ['next', 'wait'] as const;

/** How a key of `limits` is changed: cycled among choices, or typed. */
export type LimitKind = 'choice' | 'count' | 'duration';

export interface LimitKey {
  readonly key: string;
  readonly kind: LimitKind;
  readonly choices?: readonly string[];
  /** The smallest whole number a `count` takes. */
  readonly min?: number;
}

export const LIMIT_PRESET_CHOICES = ['moderate', 'economical', 'persistent'] as const;
export const TURN_TIMEOUT_CHOICES = ['cancel', 'notice', 'off'] as const;

/** The keys of `limits`, in the order of the configuration. */
export const LIMIT_KEYS: readonly LimitKey[] = [
  { key: 'preset', kind: 'choice', choices: LIMIT_PRESET_CHOICES },
  { key: 'plan_reviews', kind: 'count', min: 0 },
  { key: 'critic_rejections', kind: 'count', min: 0 },
  { key: 'attempts_per_demand', kind: 'count', min: 1 },
  { key: 'script_validations', kind: 'count', min: 0 },
  { key: 'script_vetoes', kind: 'count', min: 0 },
  { key: 'script_returns', kind: 'count', min: 0 },
  { key: 'structural_restarts', kind: 'count', min: 0 },
  { key: 'submit_retries', kind: 'count', min: 0 },
  { key: 'demand_timeout', kind: 'duration' },
  { key: 'demand_timeout_max', kind: 'duration' },
  { key: 'turn_timeout', kind: 'duration' },
  { key: 'on_turn_timeout', kind: 'choice', choices: TURN_TIMEOUT_CHOICES },
];

/** A duration in milliseconds as the text the configuration takes (`15m`, `90s`, `500ms`). */
export function durationText(ms: number): string {
  const units: readonly (readonly [string, number])[] = [
    ['d', DAY],
    ['h', HOUR],
    ['m', MINUTE],
    ['s', SECOND],
  ];
  for (const [suffix, size] of units) {
    if (ms >= size && ms % size === 0) return `${String(ms / size)}${suffix}`;
  }
  return `${String(ms)}ms`;
}

/** What a value of `limits` shows on its row. */
export function limitValueText(spec: LimitKey, value: unknown): string {
  if (value === undefined || value === null) return '-';
  if (spec.kind === 'duration' && typeof value === 'number') return durationText(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** A typed value of a limit, or `undefined` when it is not one (the screen says which kind it takes). */
export function parseLimit(spec: LimitKey, text: string): string | number | undefined {
  const trimmed = text.trim();
  if (spec.kind === 'count') {
    if (!/^\d+$/.test(trimmed)) return undefined;
    const value = Number(trimmed);
    return Number.isSafeInteger(value) && value >= (spec.min ?? 0) ? value : undefined;
  }
  if (spec.kind === 'duration') {
    return /^\d+\s*(ms|s|m|h|d)$/i.test(trimmed) ? trimmed.replace(/\s+/g, '') : undefined;
  }
  return spec.choices?.includes(trimmed) === true ? trimmed : undefined;
}

/** The choice that comes after `current` in `choices`, wrapping around. */
export function nextChoice(choices: readonly string[], current: unknown): string {
  const at = typeof current === 'string' ? choices.indexOf(current) : -1;
  return choices[(at + 1) % choices.length] ?? choices[0] ?? '';
}

/** The edit of one key of `limits`. */
export function limitEdit(key: string, value: string | number): ConfigEditBody {
  return { set: [{ path: ['limits', key], value }] };
}

/** The edit that takes a key of `limits` out of the file. */
export function limitUnsetEdit(key: string): ConfigEditBody {
  return { remove: [['limits', key]] };
}

/** A configuration object as `path = value` lines in alphabetical order (the override of a project). */
export function flatten(
  value: Readonly<Record<string, unknown>>,
  prefix = '',
): readonly (readonly [path: string, value: string])[] {
  const rows: (readonly [string, string])[] = [];
  for (const [name, item] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      rows.push(...flatten(item as Record<string, unknown>, path));
    } else {
      rows.push([path, Array.isArray(item) ? item.map(String).join(', ') : String(item)]);
    }
  }
  return rows;
}

/** The four words of the form `<client> <name> <kind> <provider>`; `undefined` when it is not that. */
export function parseAddForm(text: string):
  | {
      readonly client: string;
      readonly name: string;
      readonly kind: 'token_plan' | 'api';
      readonly provider: string;
    }
  | undefined {
  const [client, name, kind, provider, ...rest] = text.trim().split(/\s+/);
  if (client === undefined || name === undefined || provider === undefined || rest.length > 0) {
    return undefined;
  }
  if (kind !== 'token_plan' && kind !== 'api') return undefined;
  return { client, name, kind, provider };
}

/**
 * `profiles.add.login` [proposta] (2026-11-22): what adding a subscription account does about its
 * login: `ask` (default) asks "log in now?", `auto` logs in at once, `off` never offers it. A value
 * the tab does not know (an older or newer daemon) is read as the default.
 */
export type AddLoginMode = 'ask' | 'auto' | 'off';

export function addLoginModeOf(config: Readonly<Record<string, unknown>>): AddLoginMode {
  const profiles = config.profiles;
  const add =
    typeof profiles === 'object' && profiles !== null
      ? (profiles as Record<string, unknown>).add
      : undefined;
  const login =
    typeof add === 'object' && add !== null ? (add as Record<string, unknown>).login : undefined;
  return login === 'auto' || login === 'off' ? login : 'ask';
}
