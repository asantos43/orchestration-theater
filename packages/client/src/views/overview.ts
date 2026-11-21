// SPDX-License-Identifier: MPL-2.0
import {
  PLAY_STATES,
  PlayTransitionedPayloadSchema,
  DemandTransitionedPayloadSchema,
  type ApiEventEnvelope,
  type ApiPlay,
  type ApiPlayDetail,
} from '@otheater/protocol';
import type { ActorActivity } from '../stores/activity.js';
import { waitKey, type DemandWait } from '../stores/demands.js';

/**
 * What the Overview tab shows, worked out from the stores of the client (P13 of docs/18). Pure:
 * no React, no clock (the caller passes `now`), no network, so the TUI and the tests share it.
 * The text on the screen is the interface's business; this module returns facts and state names.
 */

/** One demand of a play, as the record the stores keep. */
export type DemandRecord = ApiPlayDetail['demands'][number];

// ---- the pipeline ---------------------------------------------------------------------------

/**
 * [proposta] The line of the play, left to right. The states that sit beside it (`CLARIFYING`,
 * `AWAITING_PRODUCER`, `CANCELLED`) show up only while the play is in one of them, at their place
 * in the order of `PLAY_STATES`. The machine loops (a review sends the play back), so `done` means
 * "earlier in the line than the current state", not "was visited".
 */
const MAIN_LINE: ReadonlySet<string> = new Set([
  'NEED',
  'PLANNING',
  'REVIEWING_PLAN',
  'SCRIPTING',
  'REVIEWING_SCRIPT',
  'EXECUTING',
  'INTEGRATING',
  'CRITIQUING',
  'DECIDING',
  'DELIVERING',
  'DONE',
]);

export type PipelineMark = 'done' | 'current' | 'todo';

export interface PipelineStep {
  readonly state: string;
  readonly mark: PipelineMark;
}

export interface PipelineView {
  readonly steps: readonly PipelineStep[];
  readonly current: string;
  /** The play was paused (a `PAUSE` with no `RESUME` yet, as far as this client saw). */
  readonly paused: boolean;
  readonly finished: boolean;
}

export function pipelineView(play: ApiPlay, paused: boolean): PipelineView {
  const order = (PLAY_STATES as readonly string[]).indexOf(play.state);
  const cancelled = play.state === 'CANCELLED';
  const steps = PLAY_STATES.filter((state) => MAIN_LINE.has(state) || state === play.state).map(
    (state): PipelineStep => {
      const at = (PLAY_STATES as readonly string[]).indexOf(state);
      if (state === play.state) return { state, mark: 'current' };
      return { state, mark: !cancelled && at < order ? 'done' : 'todo' };
    },
  );
  return { steps, current: play.state, paused, finished: play.finishedAt !== null };
}

// ---- demands --------------------------------------------------------------------------------

export interface DemandRow {
  readonly id: string;
  readonly title: string;
  readonly state: DemandRecord['state'];
  /** The ids it depends on, in the order the script wrote them (`D4 ← D2, D3`). */
  readonly dependsOn: readonly string[];
  /** The dependencies that are not approved yet. */
  readonly pendingDeps: readonly string[];
  /** The demand waits for an Executor (`demand.waiting`, not yet `demand.resumed`). */
  readonly waiting: boolean;
}

export function demandRows(
  playId: string,
  demands: readonly DemandRecord[],
  waiting: Readonly<Record<string, DemandWait>> = {},
): DemandRow[] {
  const byId = new Map(demands.map((demand) => [demand.id, demand]));
  return [...demands]
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((demand): DemandRow => ({
      id: demand.id,
      title: demand.title,
      state: demand.state,
      dependsOn: demand.dependsOn,
      pendingDeps: demand.dependsOn.filter((id) => byId.get(id)?.state !== 'approved'),
      waiting: waitKey(playId, demand.id) in waiting,
    }));
}

// ---- actors ---------------------------------------------------------------------------------

export interface ActorRow {
  readonly key: string;
  readonly attemptId: string | undefined;
  readonly playId: string | undefined;
  readonly demandId: string | undefined;
  readonly profile: string;
  readonly client: string;
  readonly model: string;
  readonly paused: ActorActivity['paused'];
  /**
   * [proposta] Time left, in ms: the timeout of the demand (`timeoutMin`) counted from the first
   * `session.opened` of the attempt. An estimate: the daemon's own timer is the one that decides,
   * and a paused attempt does not stop this count. `undefined` when the demand is unknown. Negative
   * once the estimate ran out.
   */
  readonly remainingMs: number | undefined;
}

export function actorRows(
  actors: Readonly<Record<string, ActorActivity>>,
  demandsByPlay: Readonly<Record<string, readonly DemandRecord[]>>,
  playIds: ReadonlySet<string>,
  now: number,
): ActorRow[] {
  return Object.values(actors)
    .filter((actor) => actor.playId !== undefined && playIds.has(actor.playId))
    .sort((a, b) => a.startedAt - b.startedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((actor): ActorRow => {
      const demand =
        actor.playId === undefined || actor.demandId === undefined
          ? undefined
          : demandsByPlay[actor.playId]?.find((item) => item.id === actor.demandId);
      return {
        key: actor.key,
        attemptId: actor.attemptId,
        playId: actor.playId,
        demandId: actor.demandId,
        profile: actor.executor.profile,
        client: actor.executor.client,
        model: actor.executor.model,
        paused: actor.paused,
        remainingMs:
          demand === undefined ? undefined : actor.startedAt + demand.timeoutMin * 60_000 - now,
      };
    });
}

// ---- recent events --------------------------------------------------------------------------

export interface EventRow {
  readonly id: number;
  readonly timestamp: number;
  readonly type: string;
  readonly playId: string | undefined;
  /** `PLANNING → SCRIPTING` or `D2 → running`, for the two types that carry a transition. */
  readonly detail: string | undefined;
}

function detailOf(event: ApiEventEnvelope): string | undefined {
  if (event.type === 'play.transitioned') {
    const parsed = PlayTransitionedPayloadSchema.safeParse(event.payload);
    return parsed.success ? `${parsed.data.from} → ${parsed.data.to}` : undefined;
  }
  if (event.type === 'demand.transitioned') {
    const parsed = DemandTransitionedPayloadSchema.safeParse(event.payload);
    return parsed.success ? `${parsed.data.demandId} → ${parsed.data.to}` : undefined;
  }
  return undefined;
}

/** The newest events of one scenario, newest first, without the types that come in floods. */
export function eventRows(
  events: readonly ApiEventEnvelope[],
  scenario: { readonly id: string; readonly playIds: ReadonlySet<string> },
  hidden: readonly string[],
  limit: number,
): EventRow[] {
  const rows: EventRow[] = [];
  for (let index = events.length - 1; index >= 0 && rows.length < limit; index -= 1) {
    const event = events[index];
    if (event === undefined || hidden.includes(event.type)) continue;
    const own =
      event.scenarioId === scenario.id ||
      (event.playId !== undefined && scenario.playIds.has(event.playId));
    if (!own) continue;
    rows.push({
      id: event.id,
      timestamp: event.timestamp,
      type: event.type,
      playId: event.playId,
      detail: detailOf(event),
    });
  }
  return rows;
}

// ---- time -----------------------------------------------------------------------------------

/** `12m05s`, `45s`, `-3m00s` (a negative number: the estimate ran out), `1h02m`. */
export function formatRemaining(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const total = Math.floor(Math.abs(ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number): string => String(value).padStart(2, '0');
  if (hours > 0) return `${sign}${String(hours)}h${two(minutes)}m`;
  if (minutes > 0) return `${sign}${String(minutes)}m${two(seconds)}s`;
  return `${sign}${String(seconds)}s`;
}
