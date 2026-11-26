// SPDX-License-Identifier: MPL-2.0
import type { ApiQuotaStatus, ApiRoles, ConfigEditBody } from '@otheater/protocol';
import { shownQuotaPercent } from '../../layout/scenario-rows.js';
import { cellWidth, clip } from '../../layout/text.js';
import type { QuotaShowMode } from '../../settings.js';

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

/**
 * The folded set the sections take: the default of `ui.settingsTab.limits` [proposta] (Limits
 * folded), flipped by the sections the person toggled (`LayoutStore.collapsedSections`), as the
 * tab Trajectories does. The ids of other tabs in `toggled` are left out.
 */
export function settingsFolded(
  toggled: ReadonlySet<string>,
  limits: 'folded' | 'open',
): ReadonlySet<string> {
  const folded = new Set<string>();
  for (const id of SECTION_IDS) {
    const starts = id === 'settings.limits' && limits === 'folded';
    if (starts !== toggled.has(id)) folded.add(id);
  }
  return folded;
}

/**
 * Rows of cells in columns `gap` cells apart; the last cell is not padded, nor a row's empty tail.
 * A row wider than `maxWidth` is cut with `…`, so a narrow tab keeps one line per row.
 */
export function alignColumns(
  rows: readonly (readonly string[])[],
  gap = 2,
  maxWidth = Number.POSITIVE_INFINITY,
): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cellWidth(cell));
    });
  }
  const space = ' '.repeat(gap);
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1
            ? cell
            : cell + ' '.repeat((widths[index] ?? 0) - cellWidth(cell)),
        )
        .join(space)
        .trimEnd(),
    )
    .map((line) => (cellWidth(line) <= maxWidth ? line : `${clip(line, maxWidth - 1)}…`));
}

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
  /**
   * The window the account used most, in percent, left or used as `ui.quota.show` says (N330);
   * `undefined` with no reading.
   */
  readonly percent: number | undefined;
  /** Milliseconds until the reset (never negative); `undefined` when no source says. */
  readonly resetsIn: number | undefined;
}

export function quotaLine(
  quota: ApiQuotaStatus | null | undefined,
  now: number,
  show: QuotaShowMode = 'used',
): QuotaLine {
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
    percent: worst === undefined ? undefined : shownQuotaPercent(worst.usedPercent, show),
    resetsIn: until === undefined ? undefined : Math.max(0, until - now),
  };
}

/** The windows every account shows (`5h`, `7d`), then the others the accounts read, by name. */
export const QUOTA_COLUMNS = ['5h', '7d'] as const;

export function windowColumns(
  quotas: readonly (ApiQuotaStatus | null | undefined)[],
): readonly string[] {
  const others = new Set<string>();
  for (const quota of quotas) {
    for (const window of quota?.windows ?? []) {
      if (!(QUOTA_COLUMNS as readonly string[]).includes(window.window)) others.add(window.window);
    }
  }
  return [...QUOTA_COLUMNS, ...[...others].sort()];
}

/**
 * The percent of a window, rounded (`88%`), left or used as `ui.quota.show` says (N330), or `—`
 * when the account has no reading of it.
 */
export function windowCell(
  quota: ApiQuotaStatus | null | undefined,
  name: string,
  show: QuotaShowMode = 'used',
): string {
  const window = quota?.windows.find((candidate) => candidate.window === name);
  return window === undefined ? '—' : `${String(shownQuotaPercent(window.usedPercent, show))}%`;
}

/** One line of the section Roles: the rule of the role, or one Executor of its list. */
export type RoleItem =
  | { readonly kind: 'rule'; readonly role: string }
  | { readonly kind: 'executor'; readonly role: string; readonly index: number };

/**
 * The lines of the section Roles. With no `open` (`ui.settingsTab.roles: list`) every role shows
 * its rule and its whole list; with `open` (`line` [proposta]) every role is one line and only the
 * role named shows its list, to reorder it (`null`: none).
 */
export function roleItems(
  roles: ApiRoles,
  view?: { readonly open: string | null },
): readonly RoleItem[] {
  const items: RoleItem[] = [];
  for (const role of roles.roles) {
    items.push({ kind: 'rule', role: role.role });
    if (view !== undefined && view.open !== role.role) continue;
    role.executors.forEach((_executor, index) => {
      items.push({ kind: 'executor', role: role.role, index });
    });
  }
  return items;
}

/**
 * The cursor of the section Roles on one line per role, moved by `delta`: the role of the line it
 * lands on opens, the one it leaves closes, and the cursor stays on the same line.
 */
export function moveRoleCursor(
  roles: ApiRoles,
  open: string | null,
  at: number,
  delta: -1 | 1,
): { readonly open: string | null; readonly at: number } {
  const items = roleItems(roles, { open });
  const last = items.length - 1;
  const target = items[Math.min(last, Math.max(0, Math.min(at, last) + delta))];
  if (target === undefined) return { open, at: 0 };
  const next = roleItems(roles, { open: target.role });
  const index = next.findIndex(
    (item) =>
      item.kind === target.kind &&
      item.role === target.role &&
      (item.kind === 'rule' || target.kind === 'rule' || item.index === target.index),
  );
  return { open: target.role, at: Math.max(0, index) };
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

/**
 * `profiles.add.login` [proposta] (2026-11-22): what adding a subscription account does about its
 * login: `ask` (default) asks "log in now?", `auto` logs in at once, `off` never offers it. In the
 * TUI the Enter of the form that adds the account is the yes (N326), so `ask` logs in at once
 * there too. A value the tab does not know (an older or newer daemon) is read as the default.
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
