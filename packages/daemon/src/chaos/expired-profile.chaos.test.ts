// SPDX-License-Identifier: MPL-2.0
import {
  FakeClientAdapter,
  FakeClock,
  InMemorySecretVault,
  normalizeFakeError,
} from '@otheater/core/testing';
import type { NormalizedError } from '@otheater/core';
import { describe, expect, it } from 'vitest';
import { aliveEntries } from './census.js';
import {
  eventsOf,
  installExecutorFakes,
  scriptPrompt,
  withExecutorRig,
} from './executor-fixture.js';

/** JSON-RPC code of "authentication required" in the three ACP adapters. [S] (see `normalize-*`) */
const AUTH_REQUIRED_CODE = -32000;

/**
 * The fake client with the normalization the three real adapters share for a login that lapsed:
 * the code `-32000` (or the text of `/login`) is `auth_required`. The base fake adapter has no such
 * case (it reads the error as `unknown`), so without this class the chaos would test the fake, not
 * the daemon. The daemon never sees the raw error: it sees what the adapter makes of it.
 */
class AuthAwareFakeAdapter extends FakeClientAdapter {
  protected override normalizeError(raw: unknown): NormalizedError {
    const code = (raw as { code?: unknown } | null)?.code;
    if (code === AUTH_REQUIRED_CODE) {
      const message = (raw as { message?: unknown }).message;
      return {
        kind: 'auth_required',
        message: typeof message === 'string' ? message : 'authentication required',
        cause: raw,
      };
    }
    return normalizeFakeError(raw);
  }
}

installExecutorFakes({
  clock: () => new FakeClock(),
  vault: () => new InMemorySecretVault(),
  client: ({ parts, unenforced, enforcement, command, env }) =>
    new AuthAwareFakeAdapter({
      launcher: parts.launcher,
      baseEnv: {},
      env,
      adapterVersion: '1.0.0',
      enforcement,
      unenforced,
      command,
    }),
});

/**
 * Chaos B, the expired profile (docs/23, P4; table "Como cada falha é simulada", line "Perfil
 * expirado"). The login of the profile lapsed: the first prompt is answered with the error the
 * clients normalize to `auth_required`. What is measured is how the daemon treats it: a login does
 * not come back by waiting, so the attempt must not loop (a tight loop would burn the attempt
 * ceiling and spam the client), and it must end in a decision, not in a hang.
 *
 * Today the cause list has no `profile_expired`: `auth_required` becomes `PermissionDenied`, so the
 * attempt ends as `permission` (the same cause as a denied tool). The test pins what is safe about
 * that (one launch, a decision for the Director, nothing alive) and not the name of the cause more
 * than needed; the proposal for a distinct cause is in docs/23 ("Como ficou", P4).
 */
describe('chaos B: the expired profile', () => {
  it('fail-auth: one launch, no wait on the clock, and a decision for the Director', async () => {
    await withExecutorRig({}, async (rig) => {
      // The daemon's own services (quota poll, update check...) already sleep on the clock: the
      // count at the start is the base, and an attempt that arms a backoff would raise it.
      const sleeping = rig.clock.pendingSleeps;
      const outcome = await rig.attempt(scriptPrompt('fail-auth', {}));
      expect(outcome).toMatchObject({
        state: 'interrupted',
        cause: 'permission',
        needsDecision: true,
        resumes: 0,
        decision: { action: 'director_judgment' },
      });
      // No backoff was armed: the attempt left no new wait on the clock ("try again later").
      expect(rig.clock.pendingSleeps).toBe(sleeping);
      const events = await rig.events();
      expect(eventsOf(events, 'session.opened')).toHaveLength(1);
      expect(eventsOf(events, 'session.interrupted')).toHaveLength(1);
      expect(eventsOf(events, 'session.processes_left')).toHaveLength(0);
      expect(aliveEntries(rig.census())).toEqual([]);
    });
  });

  it('fail-auth on every prompt: each attempt launches once, so the ceiling is the attempts asked for', async () => {
    await withExecutorRig({ script: 'fail-auth' }, async (rig) => {
      // Nothing marks the profile as expired (role-selection: `health: () => true`), so the same
      // profile can be asked again by the Director; what must hold is that each ask costs exactly
      // one launch and ends in a decision (no inner loop of resumes).
      const sleeping = rig.clock.pendingSleeps;
      const first = await rig.attempt('one');
      const second = await rig.attempt('two');
      for (const outcome of [first, second]) {
        expect(outcome).toMatchObject({ state: 'interrupted', cause: 'permission', resumes: 0 });
      }
      const events = await rig.events();
      expect(eventsOf(events, 'session.opened')).toHaveLength(2);
      expect(rig.clock.pendingSleeps).toBe(sleeping);
      expect(aliveEntries(rig.census())).toEqual([]);
    });
  });
});
