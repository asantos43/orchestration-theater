// SPDX-License-Identifier: MPL-2.0
import type { DaemonStores } from '@otheater/client';
import { useMemo } from 'react';
import { useStoreValue } from '../use-store-value.js';
import {
  finishedRows,
  quotaRows,
  scenarioRows,
  type FinishedRow,
  type QuotaRow,
  type ScenarioRow,
} from './scenario-rows.js';

/** The scenarios of the side bar, each with its marker, from the stores of the client. */
export function useScenarioRows(stores: DaemonStores): ScenarioRow[] {
  const scenarios = useStoreValue(stores.scenarios, (s) => s.byId);
  const plays = useStoreValue(stores.plays, (s) => s.byId);
  const decisions = useStoreValue(stores.decisions, (s) => s.byScenario);
  return useMemo(() => scenarioRows(scenarios, plays, decisions), [scenarios, plays, decisions]);
}

/** The finished plays of the "Terminadas" section (P11 of docs/19), the most recent `limit`. */
export function useFinishedRows(stores: DaemonStores, limit: number): FinishedRow[] {
  const scenarios = useStoreValue(stores.scenarios, (s) => s.byId);
  const plays = useStoreValue(stores.plays, (s) => s.byId);
  return useMemo(() => finishedRows(scenarios, plays, limit), [scenarios, plays, limit]);
}

/** One row per account with a reading of its quota. */
export function useQuotaRows(stores: DaemonStores): QuotaRow[] {
  const byProfile = useStoreValue(stores.quotas, (s) => s.byProfile);
  return useMemo(() => quotaRows(byProfile), [byProfile]);
}

/** Pending decisions of one scenario (or of all, with no id). */
export function usePendingDecisions(stores: DaemonStores, scenarioId?: string): number {
  return useStoreValue(stores.decisions, (s) =>
    scenarioId === undefined
      ? Object.values(s.byScenario).reduce((total, list) => total + list.length, 0)
      : (s.byScenario[scenarioId]?.length ?? 0),
  );
}

export type Link = 'live' | 'syncing' | 'lost';

/** The state of the link with the daemon: live, still reading, or the stream was lost. */
export function useLink(stores: DaemonStores): Link {
  return useStoreValue(stores.status, (s): Link => {
    if (s.phase === 'live' && s.connection === 'open') return 'live';
    if (s.phase === 'failed' || s.phase === 'closed') return 'lost';
    if (s.connection === 'retrying' || s.connection === 'closed') return 'lost';
    return 'syncing';
  });
}
