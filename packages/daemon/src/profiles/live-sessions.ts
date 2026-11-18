// SPDX-License-Identifier: MPL-2.0
import type { AttemptRunner } from '../execution/attempt-runner.js';
import type { SessionPool } from '../execution/pool.js';
import type { ProfileSessions } from './service.js';

export interface LiveProfileSessionsOptions {
  readonly pool: Pick<SessionPool, 'sessionsOf' | 'endProcessesOf'>;
  readonly runner: Pick<AttemptRunner, 'attemptsOf' | 'leasedOn' | 'releaseProfile'>;
}

/**
 * {@link ProfileSessions} over the live sessions of the daemon (Phase 5, P21), in place of the
 * rows of the `sessions` table: what the pool and the attempt runner hold now.
 *
 * - `count`: the attempts that work on the profile (a go between two sessions counts, so a resume
 *   in its backoff does not slip through) plus the sessions of the pool that no attempt owns (the
 *   Director's lease, a Consultant). A session of an attempt is in both numbers once.
 * - `release('handoff')`: every attempt on the profile ends its session, takes its checkpoint and
 *   passes the baton to the next Executor of the role (P18), with no attempt of the demand spent;
 *   it resolves when they have let go of the profile. A demand with nobody to take it stays
 *   parked with its reason, never dropped.
 * - `release('force')`: the same attempts stop the way a daemon stop does (`awaiting_resume`),
 *   and every client process of the profile is ended, the sessions the pool holds for others too.
 * - `settle`: ends the client processes the profile still has (the idle ones the pool keeps for
 *   the next session) before its logout and its directory go.
 */
export function liveProfileSessions(options: LiveProfileSessionsOptions): ProfileSessions {
  const { pool, runner } = options;
  return {
    count: (profileId) =>
      Promise.resolve(
        runner.attemptsOf(profileId) +
          Math.max(0, pool.sessionsOf(profileId) - runner.leasedOn(profileId)),
      ),
    release: async (profileId, how) => {
      const touched = await runner.releaseProfile(profileId, how);
      if (how === 'force') await pool.endProcessesOf(profileId);
      return touched;
    },
    settle: async (profileId) => {
      await pool.endProcessesOf(profileId);
    },
  };
}
