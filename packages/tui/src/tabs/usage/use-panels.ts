// SPDX-License-Identifier: MPL-2.0
import { ApiClientError, ApiRequestError, type ApiClient } from '@otheater/client';
import {
  API_ROUTES,
  type AnalysisReport,
  type PlaySpans,
  type TelemetryStatus,
} from '@otheater/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { trendWindow } from './panels-model.js';

/**
 * The state of one source of a panel. `off` is a source nobody asked for (the section is not in
 * `ui.usage.sections`); `error` keeps what the screen had before, as the totals of the tab do.
 */
export type SourceLoad<T> =
  | { readonly status: 'off' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'error';
      readonly code: string;
      readonly kept: { readonly value: T; readonly at: number } | undefined;
    }
  | { readonly status: 'ready'; readonly value: T; readonly at: number };

/** What the panels read, by the sections `ui.usage.sections` turned on. */
export interface PanelsPlan {
  /** The analysis (trend and bottlenecks share the one read). */
  readonly analysis: boolean;
  readonly trendDays: number;
  /** The spans of this play; `undefined` reads nothing. */
  readonly spansOf: string | undefined;
  readonly spanLimit: number;
  readonly telemetry: boolean;
}

export interface PanelsReader {
  readonly analysis: SourceLoad<AnalysisReport>;
  readonly spans: SourceLoad<PlaySpans>;
  readonly telemetry: SourceLoad<TelemetryStatus>;
  /** Reads what the plan asks for, now. */
  readonly refresh: () => void;
}

function codeOf(error: unknown): string {
  return error instanceof ApiRequestError
    ? error.code
    : error instanceof ApiClientError
      ? 'network'
      : 'internal';
}

/** One source: its state, and a way to run a read whose answer is dropped when a newer one started. */
function useSource<T>(
  clock: () => number,
): readonly [SourceLoad<T>, (read: Promise<T> | undefined) => void, () => void] {
  const [load, setLoad] = useState<SourceLoad<T>>({ status: 'loading' });
  const latest = useRef(0);
  const last = useRef<{ readonly value: T; readonly at: number } | undefined>(undefined);
  const run = useCallback(
    (read: Promise<T> | undefined): void => {
      latest.current += 1;
      const mine = latest.current;
      if (read === undefined) {
        last.current = undefined;
        setLoad({ status: 'off' });
        return;
      }
      void read.then(
        (value) => {
          if (mine !== latest.current) return;
          const ready = { value, at: clock() };
          last.current = ready;
          setLoad({ status: 'ready', ...ready });
        },
        (error: unknown) => {
          if (mine !== latest.current) return;
          setLoad({ status: 'error', code: codeOf(error), kept: last.current });
        },
      );
    },
    [clock],
  );
  // An answer in flight belongs to a screen that no longer asks.
  const drop = useCallback((): void => {
    latest.current += 1;
  }, []);
  return [load, run, drop];
}

/**
 * Reads what the telemetry panels of the Usage tab show (P10): `GET /v1/analysis` (by day, for the
 * trend and the bottlenecks), `GET /v1/plays/:id/spans` and `GET /v1/telemetry`. One read of each
 * source the plan names, when the tab opens, when the plan changes, on the refresh key and on one
 * timer (`ui.usage.refreshSeconds`, `0` turns it off). A source the plan leaves out is never read.
 * [proposta] None of these routes has an event in the stream, so reading is the only way to follow
 * them, like the totals and the budget.
 */
export function usePanels(
  client: Pick<ApiClient, 'call'> | undefined,
  plan: PanelsPlan,
  refreshSeconds: number,
  clock: () => number,
): PanelsReader {
  const [analysis, runAnalysis, dropAnalysis] = useSource<AnalysisReport>(clock);
  const [spans, runSpans, dropSpans] = useSource<PlaySpans>(clock);
  const [telemetry, runTelemetry, dropTelemetry] = useSource<TelemetryStatus>(clock);
  const { analysis: wantAnalysis, trendDays, spansOf, spanLimit, telemetry: wantTelemetry } = plan;

  const read = useCallback((): void => {
    if (client === undefined) return;
    if (wantAnalysis) {
      const window = trendWindow(clock(), trendDays);
      runAnalysis(
        client.call(API_ROUTES.getAnalysis, {
          query: { from: window.from, to: window.to, groupBy: 'day' },
        }),
      );
    } else runAnalysis(undefined);
    runSpans(
      spansOf === undefined
        ? undefined
        : client.call(API_ROUTES.getPlaySpans, {
            params: { playId: spansOf },
            query: { limit: spanLimit },
          }),
    );
    runTelemetry(wantTelemetry ? client.call(API_ROUTES.getTelemetryStatus) : undefined);
  }, [
    client,
    clock,
    wantAnalysis,
    trendDays,
    spansOf,
    spanLimit,
    wantTelemetry,
    runAnalysis,
    runSpans,
    runTelemetry,
  ]);

  useEffect(() => {
    read();
    if (refreshSeconds <= 0) return undefined;
    const timer = setInterval(read, refreshSeconds * 1000);
    return () => {
      clearInterval(timer);
      dropAnalysis();
      dropSpans();
      dropTelemetry();
    };
  }, [read, refreshSeconds, dropAnalysis, dropSpans, dropTelemetry]);

  return { analysis, spans, telemetry, refresh: read };
}
