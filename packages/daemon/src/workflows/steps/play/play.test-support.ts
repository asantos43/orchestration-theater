// SPDX-License-Identifier: MPL-2.0
// Shared by the tests of `run_play` and of the ready workflows only (excluded from the build).
import type { PlayRunOpen, PlayRunOutcome, PlayRunPort } from './run-play.js';

/** One play the fake knows: what it was opened for and, once it ended, what it left. */
export interface FakePlay {
  readonly playId: string;
  readonly scenarioId: string;
  readonly need: string;
  outcome: PlayRunOutcome | undefined;
}

/** What a play that delivered leaves: the branch, a pull request and a summary. */
export function deliveredOutcome(overrides: Partial<PlayRunOutcome> = {}): PlayRunOutcome {
  return {
    state: 'DONE',
    branch: 'otheater/play-x',
    pullRequest: { number: 9, url: 'https://code-host.invalid/pull/9' },
    summary: 'Play ended DONE. Pull request #9: https://code-host.invalid/pull/9',
    ...overrides,
  };
}

/**
 * A `PlayRunPort` in memory: no orchestration, no client. A play stays open until the test ends it
 * (`finish`, `finishAll`) or until `autoFinish` is set, in which case it ends the moment it opens.
 * The object outlives a runtime, as the store of plays outlives a daemon.
 */
export class FakePlayRunPort implements PlayRunPort {
  readonly plays = new Map<string, FakePlay>();
  /** Every `open` that reached the port, in order. */
  readonly opened: FakePlay[] = [];
  /** When set, `open` refuses with this answer. */
  refuseWith: Extract<PlayRunOpen, { ok: false }> | undefined;
  /** When set, a play ends with this outcome as soon as it opens. */
  autoFinish: PlayRunOutcome | undefined;

  exists(playId: string): Promise<boolean> {
    return Promise.resolve(this.plays.has(playId));
  }

  open(request: {
    readonly playId: string;
    readonly scenarioId: string;
    readonly need: string;
  }): Promise<PlayRunOpen> {
    if (this.refuseWith !== undefined) return Promise.resolve(this.refuseWith);
    const play: FakePlay = { ...request, outcome: this.autoFinish };
    this.plays.set(request.playId, play);
    this.opened.push(play);
    return Promise.resolve({ ok: true });
  }

  outcome(playId: string): Promise<PlayRunOutcome | undefined> {
    return Promise.resolve(this.plays.get(playId)?.outcome);
  }

  /** Ends a play, as the machine would. */
  finish(playId: string, outcome: PlayRunOutcome = deliveredOutcome()): void {
    const play = this.plays.get(playId);
    if (play === undefined) throw new Error(`no such play ${playId}`);
    play.outcome = outcome;
  }

  /** Ends every play that is still open. */
  finishAll(outcome: PlayRunOutcome = deliveredOutcome()): void {
    for (const play of this.plays.values()) play.outcome ??= outcome;
  }
}
