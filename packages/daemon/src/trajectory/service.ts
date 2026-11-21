// SPDX-License-Identifier: MPL-2.0
import {
  NotFound,
  playBranch,
  supportsDiff,
  truncateText,
  type EventEnvelope,
  type Store,
  type Vcs,
} from '@otheater/core';
import {
  buildTrajectory,
  isTrajectoryEvent,
  type ApiDemandDiff,
  type Page,
  type Trajectory,
} from '@otheater/protocol';
import type { DaemonConfig } from '../config.js';

/**
 * The trajectory of a play, read from the event log and the registries (architecture 5.11, P14 of
 * docs/18). [proposta] The log has no index by play on its port, so the events are read in blocks
 * from the cursor and filtered; a read of the whole trajectory is one pass over the log, which the
 * cursor keeps from repeating. The diff of a demand is the one of its latest attempt against the
 * branch of its play, as `view_diff` shows it to an Executor.
 */

/** Events read from the log at a time, while a page of the trajectory fills. */
const SCAN_BLOCK = 1000;

export interface TrajectoryServiceDeps {
  readonly store: Store;
  readonly config: () => Pick<DaemonConfig, 'tools'>;
  /** The version control adapter; absent: a diff is `unavailable`. */
  readonly vcs?: Vcs | undefined;
}

export class TrajectoryService {
  readonly #deps: TrajectoryServiceDeps;

  constructor(deps: TrajectoryServiceDeps) {
    this.#deps = deps;
  }

  async #assertPlay(playId: string): Promise<void> {
    if ((await this.#deps.store.plays.get(playId)) === undefined) {
      throw new NotFound(`There is no play "${playId}"`);
    }
  }

  /**
   * The events of the trajectory of a play after `afterId`, oldest first, at most `limit`.
   * `nextId` is the cursor of the next read: the id of the last event examined, `null` when the
   * log has no more.
   */
  async events(
    playId: string,
    afterId: number,
    limit: number,
  ): Promise<{ readonly items: EventEnvelope[]; readonly nextId: number | null }> {
    await this.#assertPlay(playId);
    const { events } = this.#deps.store;
    const items: EventEnvelope[] = [];
    let cursor = afterId;
    for (;;) {
      const block = await events.readFrom(cursor, SCAN_BLOCK);
      if (block.length === 0) return { items, nextId: null };
      for (const event of block) {
        cursor = event.id;
        if (event.playId !== playId || !isTrajectoryEvent(event.type)) continue;
        items.push(event);
        if (items.length >= limit) return { items, nextId: cursor };
      }
      if (block.length < SCAN_BLOCK) return { items, nextId: null };
    }
  }

  /** The whole trajectory of a play, folded. */
  async trajectory(playId: string): Promise<Trajectory> {
    const all: EventEnvelope[] = [];
    let after = 0;
    for (;;) {
      const page = await this.events(playId, after, 1000);
      all.push(...page.items);
      if (page.nextId === null) break;
      after = page.nextId;
    }
    return buildTrajectory(playId, all);
  }

  /** The diff of a demand: its latest attempt against the branch of the play. */
  async diff(playId: string, demandId: string): Promise<ApiDemandDiff> {
    const { store, vcs } = this.#deps;
    await this.#assertPlay(playId);
    if ((await store.demands.get(playId, demandId)) === undefined) {
      throw new NotFound(`The play "${playId}" has no demand "${demandId}"`);
    }
    const base = { playId, demandId, diff: '', truncated: false };
    const mine = (await store.attempts.list()).filter(
      (record) => record.playId === playId && record.demandId === demandId,
    );
    const latest = mine.reduce<(typeof mine)[number] | undefined>(
      (best, record) => (best === undefined || record.attempt > best.attempt ? record : best),
      undefined,
    );
    if (latest === undefined) {
      return { ...base, attemptId: null, available: false, unavailable: 'no_attempt' };
    }
    const found = { ...base, attemptId: latest.attemptId };
    if (vcs === undefined || !supportsDiff(vcs)) {
      return { ...found, available: false, unavailable: 'no_vcs' };
    }
    const { output_max_bytes, truncate } = this.#deps.config().tools;
    try {
      // The adapter clips by characters; a character is at most 4 bytes, so this never cuts early.
      const diff = await vcs.diffBetween(
        latest.worktree,
        playBranch(playId),
        latest.branch,
        output_max_bytes * 4,
      );
      const cut = truncateText(diff.text, output_max_bytes, truncate);
      return {
        ...found,
        available: true,
        unavailable: null,
        diff: cut.text,
        truncated: cut.truncated || diff.truncated,
      };
    } catch (error) {
      if (error instanceof NotFound) {
        return { ...found, available: false, unavailable: 'no_branch' };
      }
      throw error;
    }
  }
}

export type TrajectoryEventsPage = Page<EventEnvelope>;
