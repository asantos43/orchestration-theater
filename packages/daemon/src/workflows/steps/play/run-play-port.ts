// SPDX-License-Identifier: MPL-2.0
import { integrationBranch, type CodeHost, type Store } from '@otheater/core';
import { isFinalPlayState } from '@otheater/protocol';
import { openPlayFromNeed, type PlayOpening } from '../../../orchestration/open-play.js';
import type { PlayRunOutcome, PlayRunPort } from './run-play.js';

/**
 * The adapter of `run_play` over the orchestration of today (P12): it opens the play by the same
 * function the Director's `open_play` uses (`openPlayFromNeed`, with the id the step derived), and
 * reads the play from the store. The flow is the scenario's own (`selectFlow`).
 */
export interface RunPlayPortDeps {
  readonly opening: PlayOpening;
  readonly store: Pick<Store, 'plays' | 'scenarioRepos'>;
  readonly codeHost: Pick<CodeHost, 'findPullRequest' | 'remoteRef'>;
}

export function createPlayRunPort(deps: RunPlayPortDeps): PlayRunPort {
  return {
    async exists(playId) {
      return (await deps.store.plays.get(playId)) !== undefined;
    },
    async open({ playId, scenarioId, need }) {
      const opened = await openPlayFromNeed(deps.opening, scenarioId, need, playId);
      return opened.ok ? { ok: true } : { ok: false, code: opened.code, message: opened.message };
    },
    async cancel(playId, reason) {
      const play = await deps.store.plays.get(playId);
      if (play === undefined) return 'not_found';
      if (isFinalPlayState(play.state)) return 'already_final';
      await deps.opening.runner.send(playId, { type: 'CANCEL', reason });
      return 'cancelled';
    },
    async outcome(playId): Promise<PlayRunOutcome | undefined> {
      const play = await deps.store.plays.get(playId);
      if (play === undefined || !isFinalPlayState(play.state)) return undefined;
      const state = play.state === 'DONE' ? 'DONE' : 'CANCELLED';
      const repo = (await deps.store.scenarioRepos.list(play.scenarioId))[0];
      const head = integrationBranch(playId);
      let branch = '';
      let pullRequest: PlayRunOutcome['pullRequest'] = null;
      if (state === 'DONE' && repo !== undefined) {
        const found = await deps.codeHost.findPullRequest({
          repo: repo.path,
          head,
          states: ['open', 'closed', 'merged'],
        });
        if (found !== undefined) {
          pullRequest = { number: found.number, url: found.url };
          branch = head;
        } else if (
          (await deps.codeHost.remoteRef({ repo: repo.path, branch: head })) !== undefined
        ) {
          branch = head;
        }
      }
      const feedback = (play.snapshot as { context?: { feedback?: unknown } } | null)?.context
        ?.feedback;
      const parts = [`Play ${playId} ended ${state}.`];
      if (branch !== '') parts.push(`Branch ${branch}.`);
      if (pullRequest !== null)
        parts.push(`Pull request #${String(pullRequest.number)}: ${pullRequest.url}`);
      if (typeof feedback === 'string' && feedback !== '') parts.push(`Last reason: ${feedback}`);
      return { state, branch, pullRequest, summary: parts.join(' ') };
    },
  };
}
