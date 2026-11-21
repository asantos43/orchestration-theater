// SPDX-License-Identifier: MPL-2.0
import { ACTIVE_ATTEMPT_STATES, NotFound, type AttemptRecord } from '@otheater/core';
import type { ApiPlayAttempt } from '@otheater/protocol';
import type { ApiHandlers } from '../handlers.js';
import type { ReadRouteDeps } from './deps.js';
import { paginate } from './paging.js';
import { isPausedPlay } from './projections.js';

/**
 * The read route of the attempts of a play (P25 of docs/18, N200 item 1): what an interface that
 * connected after the play began needs to know who works and who is paused. The registry says the
 * state; the runner, when it holds the attempt in memory, adds the model and who paused it.
 */
export function registerAttemptRoutes(handlers: ApiHandlers, deps: ReadRouteDeps): void {
  const { store, attempts } = deps;

  handlers.register('listPlayAttempts', async ({ params, query }) => {
    const play = await store.plays.get(params.playId);
    if (play === undefined) throw new NotFound(`There is no play "${params.playId}"`);
    const rows = await store.attempts.list(
      query.open === undefined
        ? {}
        : {
            states:
              query.open === 'true'
                ? ACTIVE_ATTEMPT_STATES
                : ([
                    'completed',
                    'failed',
                    'timed_out',
                    'cancelled',
                  ] as const satisfies readonly AttemptRecord['state'][]),
          },
    );
    const playPaused = play.finishedAt === null && isPausedPlay(play);
    const items = rows
      .filter((row) => row.playId === play.id)
      .map((row): ApiPlayAttempt => {
        const live = attempts?.liveAttempt(row.attemptId);
        const rest: Partial<AttemptRecord> = { ...row };
        delete rest.worktree;
        // A pause the runner no longer holds (the daemon restarted) leaves the attempt waiting to be
        // resumed with the cause `paused`: it was the play's if the play is paused, else a person's.
        const parked = row.state === 'awaiting_resume' && row.cause === 'paused';
        return {
          ...(rest as Omit<AttemptRecord, 'worktree'>),
          model: live?.model ?? null,
          paused: live?.paused ?? (parked ? (playPaused ? 'play' : 'actor') : null),
        };
      });
    return paginate(items, (item) => [item.createdAt, item.attemptId], query);
  });
}
