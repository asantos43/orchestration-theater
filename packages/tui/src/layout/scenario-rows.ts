// SPDX-License-Identifier: MPL-2.0
import type { ApiPlay, ApiQuotaStatus, ApiScenario } from '@otheater/protocol';
import type { QuotaShowMode } from '../settings.js';

/**
 * What the side bar lists, worked out from the stores of the client. Pure. [proposta] The marker of
 * a scenario: `!` when a decision waits for the person, `●` while a play runs, `✓` when the last
 * play is done, `○` otherwise. There is no failure marker: the stores carry no play that failed.
 */

export type ScenarioMark = 'decision' | 'running' | 'done' | 'idle';

export interface ScenarioRow {
  readonly id: string;
  readonly name: string;
  readonly mark: ScenarioMark;
}

export function scenarioRows(
  scenarios: Readonly<Record<string, ApiScenario>>,
  plays: Readonly<Record<string, ApiPlay>>,
  decisions: Readonly<Record<string, readonly unknown[]>>,
): ScenarioRow[] {
  const byScenario = new Map<string, ApiPlay[]>();
  for (const play of Object.values(plays)) {
    const list = byScenario.get(play.scenarioId);
    if (list === undefined) byScenario.set(play.scenarioId, [play]);
    else list.push(play);
  }
  return Object.values(scenarios)
    .filter((scenario) => scenario.state === 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    .map((scenario): ScenarioRow => {
      const own = byScenario.get(scenario.id) ?? [];
      let mark: ScenarioMark = 'idle';
      if ((decisions[scenario.id]?.length ?? 0) > 0) mark = 'decision';
      else if (own.some((play) => play.finishedAt === null)) mark = 'running';
      else {
        const last = own.reduce<ApiPlay | undefined>(
          (best, play) => (best === undefined || play.updatedAt > best.updatedAt ? play : best),
          undefined,
        );
        if (last?.state === 'DONE') mark = 'done';
      }
      return { id: scenario.id, name: scenario.name, mark };
    });
}

/** One finished play of the "Terminadas" section of the side bar (P11 of docs/19). */
export interface FinishedRow {
  readonly id: string;
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly need: string;
  /** `DONE` is `done`; any other final state (`CANCELLED`) is `cancelled`. */
  readonly outcome: 'done' | 'cancelled';
  readonly finishedAt: number;
}

/**
 * The finished plays of the active scenarios, the most recent first, at most `limit`. A play
 * whose scenario is not active (or unknown) is left out, as its scenario is not in the list.
 */
export function finishedRows(
  scenarios: Readonly<Record<string, ApiScenario>>,
  plays: Readonly<Record<string, ApiPlay>>,
  limit: number,
): FinishedRow[] {
  const rows: FinishedRow[] = [];
  for (const play of Object.values(plays)) {
    if (play.finishedAt === null) continue;
    const scenario = scenarios[play.scenarioId];
    if (scenario?.state !== 'active') continue;
    rows.push({
      id: play.id,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      need: play.need,
      outcome: play.state === 'DONE' ? 'done' : 'cancelled',
      finishedAt: play.finishedAt,
    });
  }
  return rows
    .sort((a, b) => b.finishedAt - a.finishedAt || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit));
}

export interface QuotaRow {
  readonly profile: string;
  readonly state: ApiQuotaStatus['state'];
  /**
   * Percent of the five-hour window, left or used as `ui.quota.show` says (N330); `undefined` when
   * the account has none.
   */
  readonly fiveHour: number | undefined;
  /** Percent of the weekly window, the same way. */
  readonly week: number | undefined;
}

/**
 * The percent a quota window shows (`ui.quota.show`, N330): what is left of it (`remaining`, 100
 * minus the used part) or the part used; whole, from 0 to 100.
 */
export function shownQuotaPercent(usedPercent: number, show: QuotaShowMode): number {
  const used = Math.max(0, Math.min(100, Math.round(usedPercent)));
  return show === 'used' ? used : 100 - used;
}

function percentOf(
  status: ApiQuotaStatus,
  window: string,
  show: QuotaShowMode,
): number | undefined {
  const found = status.windows.find((item) => item.window === window);
  return found === undefined ? undefined : shownQuotaPercent(found.usedPercent, show);
}

export function quotaRows(
  byProfile: Readonly<Record<string, ApiQuotaStatus>>,
  show: QuotaShowMode = 'used',
): QuotaRow[] {
  return Object.values(byProfile)
    .sort((a, b) => a.profile.localeCompare(b.profile))
    .map((status) => ({
      profile: status.profile,
      state: status.state,
      fiveHour: percentOf(status, '5h', show),
      week: percentOf(status, '7d', show),
    }));
}

/**
 * The clients whose quota is read only after the first answer of a session (the statusline of
 * Claude Code, architecture 5.6). [proposta] (N328, 2026-11-26): an account of theirs with no
 * reading says when the reading comes, instead of only "no reading".
 */
export const READ_AT_FIRST_SESSION_CLIENTS: readonly string[] = ['claude-code'];

/** The catalog key for an account (`client/name`) with no reading. */
export function noReadingKey(profile: string): 'noReading' | 'firstSession' {
  const client = profile.split('/')[0] ?? '';
  return READ_AT_FIRST_SESSION_CLIENTS.includes(client) ? 'firstSession' : 'noReading';
}

/** `█████░░░` of `cells` cells with `percent` filled. */
export function fillBar(cells: number, percent: number, full = '█', empty = '░'): string {
  const filled = Math.max(0, Math.min(cells, Math.round((cells * percent) / 100)));
  return full.repeat(filled) + empty.repeat(cells - filled);
}
