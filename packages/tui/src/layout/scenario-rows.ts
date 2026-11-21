// SPDX-License-Identifier: MPL-2.0
import type { ApiPlay, ApiQuotaStatus, ApiScenario } from '@otheater/protocol';

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

export interface QuotaRow {
  readonly profile: string;
  readonly state: ApiQuotaStatus['state'];
  /** Percent used in the five-hour window; `undefined` when the account has none. */
  readonly fiveHour: number | undefined;
  /** Percent used in the weekly window. */
  readonly week: number | undefined;
}

function percentOf(status: ApiQuotaStatus, window: string): number | undefined {
  const found = status.windows.find((item) => item.window === window);
  return found === undefined
    ? undefined
    : Math.max(0, Math.min(100, Math.round(found.usedPercent)));
}

export function quotaRows(byProfile: Readonly<Record<string, ApiQuotaStatus>>): QuotaRow[] {
  return Object.values(byProfile)
    .sort((a, b) => a.profile.localeCompare(b.profile))
    .map((status) => ({
      profile: status.profile,
      state: status.state,
      fiveHour: percentOf(status, '5h'),
      week: percentOf(status, '7d'),
    }));
}

/** `█████░░░` of `cells` cells with `percent` filled. */
export function fillBar(cells: number, percent: number, full = '█', empty = '░'): string {
  const filled = Math.max(0, Math.min(cells, Math.round((cells * percent) / 100)));
  return full.repeat(filled) + empty.repeat(cells - filled);
}
