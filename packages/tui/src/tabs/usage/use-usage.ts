// SPDX-License-Identifier: MPL-2.0
import {
  ApiClientError,
  ApiRequestError,
  budgetView,
  usageView,
  type ApiClient,
  type BudgetView,
  type UsageView,
} from '@otheater/client';
import { API_ROUTES } from '@otheater/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageGroup } from '../settings.js';

export type UsageLoad =
  | { readonly status: 'loading' }
  /** The last read failed; `kept` is what the screen had before, if anything. */
  | {
      readonly status: 'error';
      readonly code: string;
      readonly kept:
        { readonly usage: UsageView; readonly budget: BudgetView; readonly at: number } | undefined;
    }
  | {
      readonly status: 'ready';
      readonly usage: UsageView;
      readonly budget: BudgetView;
      /** When the reading was made (epoch ms). */
      readonly at: number;
    };

export interface UsageReader {
  readonly load: UsageLoad;
  /** Reads the two routes again now. */
  readonly refresh: () => void;
}

/**
 * Reads `/v1/usage` and `/v1/budget` (P13 of docs/18): when the tab opens, when `groupBy` changes,
 * on the refresh key and every `refreshSeconds` while the tab is mounted (`0` turns the timer
 * off). These two routes have no event in the stream, so reading them is the only way to follow
 * them; the Overview, which has events, never reads. An answer that comes after a newer request
 * is dropped.
 */
export function useUsage(
  client: Pick<ApiClient, 'call'> | undefined,
  groupBy: UsageGroup,
  refreshSeconds: number,
  clock: () => number,
): UsageReader {
  const [load, setLoad] = useState<UsageLoad>({ status: 'loading' });
  const latest = useRef(0);
  const last = useRef<Extract<UsageLoad, { status: 'ready' }> | undefined>(undefined);

  const read = useCallback((): void => {
    if (client === undefined) return;
    latest.current += 1;
    const mine = latest.current;
    void Promise.all([
      client.call(API_ROUTES.getUsage, { query: groupBy === 'none' ? {} : { by: groupBy } }),
      client.call(API_ROUTES.getBudget),
    ]).then(
      ([usage, budget]) => {
        if (mine !== latest.current) return;
        const ready = {
          status: 'ready',
          usage: usageView(usage),
          budget: budgetView(budget),
          at: clock(),
        } as const;
        last.current = ready;
        setLoad(ready);
      },
      (error: unknown) => {
        if (mine !== latest.current) return;
        const code =
          error instanceof ApiRequestError
            ? error.code
            : error instanceof ApiClientError
              ? 'network'
              : 'internal';
        const kept = last.current;
        setLoad({ status: 'error', code, kept });
      },
    );
  }, [client, groupBy, clock]);

  useEffect(() => {
    read();
    if (refreshSeconds <= 0) return undefined;
    const timer = setInterval(read, refreshSeconds * 1000);
    return () => {
      clearInterval(timer);
      // An answer in flight belongs to a screen that no longer asks.
      latest.current += 1;
    };
  }, [read, refreshSeconds]);

  return { load, refresh: read };
}
