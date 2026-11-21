// SPDX-License-Identifier: MPL-2.0
import {
  actorRows,
  demandRows,
  eventRows,
  pipelineView,
  type ActorActivity,
  type ActorRow,
  type DemandRow,
  type DaemonStores,
  type EventRow,
  type PipelineView,
} from '@otheater/client';
import type { ApiPlay } from '@otheater/protocol';
import { useMemo } from 'react';
import { useQuotaRows } from '../../layout/data.js';
import type { QuotaRow } from '../../layout/scenario-rows.js';
import { useStoreValue } from '../../use-store-value.js';
import type { OverviewSettings } from '../settings.js';

/** Everything the Overview shows of one scenario, worked out from the stores of the client. */
export interface OverviewData {
  /** The play the tab is about: the newest open one, or the last one that finished. */
  readonly play: ApiPlay | undefined;
  readonly pipeline: PipelineView | undefined;
  readonly demands: readonly DemandRow[];
  readonly actors: readonly ActorRow[];
  /** The Actors as the activity store keeps them, by the key of {@link ActorRow}. */
  readonly activity: Readonly<Record<string, ActorActivity>>;
  readonly events: readonly EventRow[];
  readonly quotas: readonly QuotaRow[];
  /** The ids of the plays paused now (as far as this client saw). */
  readonly pausedPlays: ReadonlySet<string>;
}

/**
 * [proposta] The play of a scenario the tab follows: the newest open one; with none open, the
 * last one that moved, so the pipeline of a finished play stays on screen.
 */
export function currentPlay(plays: readonly ApiPlay[]): ApiPlay | undefined {
  let open: ApiPlay | undefined;
  let last: ApiPlay | undefined;
  for (const play of plays) {
    if (play.finishedAt === null && (open === undefined || play.createdAt > open.createdAt)) {
      open = play;
    }
    if (last === undefined || play.updatedAt > last.updatedAt) last = play;
  }
  return open ?? last;
}

/**
 * Reads the stores of the client and nothing else: no REST call is made here, so the tab follows a
 * whole play on the events the stores already apply (P13 of docs/18). `now` is the clock of the
 * time left of the Actors.
 */
export function useOverviewData(
  stores: DaemonStores,
  scenarioId: string | undefined,
  settings: OverviewSettings,
  now: number,
): OverviewData {
  const plays = useStoreValue(stores.plays, (s) => s.byId);
  const byPlay = useStoreValue(stores.demands, (s) => s.byPlay);
  const waiting = useStoreValue(stores.demands, (s) => s.waiting);
  const actors = useStoreValue(stores.activity, (s) => s.actors);
  const paused = useStoreValue(stores.activity, (s) => s.pausedPlays);
  const events = useStoreValue(stores.events, (s) => s.events);
  const quotas = useQuotaRows(stores);

  const own = useMemo(
    () =>
      scenarioId === undefined
        ? []
        : Object.values(plays).filter((play) => play.scenarioId === scenarioId),
    [plays, scenarioId],
  );
  const play = useMemo(() => currentPlay(own), [own]);
  const playIds = useMemo(() => new Set(own.map((item) => item.id)), [own]);
  const pausedPlays = useMemo(() => new Set(Object.keys(paused)), [paused]);

  const pipeline = useMemo(
    () => (play === undefined ? undefined : pipelineView(play, pausedPlays.has(play.id))),
    [play, pausedPlays],
  );
  const demands = useMemo(() => {
    const parts = play === undefined ? undefined : byPlay[play.id];
    return play === undefined || parts === undefined
      ? []
      : demandRows(play.id, parts.demands, waiting);
  }, [play, byPlay, waiting]);
  const demandsByPlay = useMemo(
    () => Object.fromEntries(Object.entries(byPlay).map(([id, parts]) => [id, parts.demands])),
    [byPlay],
  );
  const actorList = useMemo(
    () => actorRows(actors, demandsByPlay, playIds, now),
    [actors, demandsByPlay, playIds, now],
  );
  const eventList = useMemo(
    () =>
      scenarioId === undefined
        ? []
        : eventRows(
            events,
            { id: scenarioId, playIds },
            settings.hiddenEvents,
            settings.recentEvents,
          ),
    [events, scenarioId, playIds, settings.hiddenEvents, settings.recentEvents],
  );

  return {
    play,
    pipeline,
    demands,
    actors: actorList,
    activity: actors,
    events: eventList,
    quotas,
    pausedPlays,
  };
}
