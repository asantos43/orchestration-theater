// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { type Profile } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  eventsOf,
  makeRig,
  specOf,
  until,
  type Rig,
  type RigParts,
} from '../execution/attempt-fixture.js';
import type { HandoffPort } from '../execution/handoff.js';
import { dataPaths } from '../paths.js';
import {
  captureLogger,
  makeTempDataDir,
  RecordingSituations,
  TEST_POLICY,
} from '../test-helpers.js';
import { liveProfileSessions } from './live-sessions.js';
import { ProfileService } from './service.js';

/**
 * P21, acceptance: a profile removed with two sessions in progress. One finishes by itself, the
 * other is still running at the timeout and takes the baton to another profile; the demand is not
 * lost, the logout and the directory come after, and the Executors of the profile are `invalid`.
 */

const TEST_TIMEOUT_MS = 30_000;
const ID_TWO = 'fake-model@fake/two';
const TWO: Profile = { client: 'fake', profile: 'two', id: 'fake/two', dir: '/profiles/fake/two' };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(disposeTestGitIsolation);

function fakes() {
  const clock = new FakeClock();
  const launcher = new FakeProcessLauncher();
  return {
    clock,
    store: new InMemoryStore({ clock }),
    launcher,
    transport: new FakeSessionTransport(),
    adapter: new FakeClientAdapter({
      launcher,
      baseEnv: {},
      adapterVersion: '1.0.0',
      command: { cmd: 'fake-client', args: [] },
    }),
  } satisfies RigParts;
}

const toTwo: HandoffPort = {
  prefixOf: () => 'ROLE PREFIX',
  choose: (request) =>
    Promise.resolve(
      request.used.includes(ID_TWO)
        ? { kind: 'none', reason: 'no_other_executor' }
        : {
            kind: 'selected',
            target: {
              executorId: ID_TWO,
              profile: TWO,
              executor: { model: 'fake-model' },
              policy: TEST_POLICY,
            },
          },
    ),
  announce: () => undefined,
  secretPaths: [],
};

describe('removing a profile with sessions in progress (P21)', () => {
  it(
    'one session ends by itself, the other takes the baton after the timeout, then the directory goes',
    async () => {
      const rig: Rig<ReturnType<typeof fakes>> = await makeRig(
        fakes(),
        {},
        undefined,
        undefined,
        toTwo,
      );
      cleanups.push(() => rig.dispose());
      const data = await makeTempDataDir();
      cleanups.push(data.dispose);
      const { logger } = captureLogger();
      const service = new ProfileService({
        store: rig.store,
        vault: new InMemorySecretVault(),
        vaultBackend: 'encrypted-file',
        clock: rig.clock,
        logger,
        situations: new RecordingSituations(),
        paths: dataPaths(data.dir),
        settings: {
          sameProviderNotice: 'off',
          drain: {
            timeoutMs: 600_000,
            onTimeout: 'handoff',
            removedDir: 'delete',
            director: 'failover',
          },
        },
        adapters: () => rig.adapter,
        transport: () => rig.transport,
        sessions: liveProfileSessions({ pool: rig.pool, runner: rig.runner }),
        pollMs: 1000,
      });
      const added = await service.add({
        client: 'fake',
        name: 'one',
        kind: 'token_plan',
        provider: 'anthropic',
        acceptNotice: true,
      });
      if (added.status !== 'added') throw new Error('expected the profile to be added');
      await rig.store.executors.create({
        profileId: 'fake/one',
        model: 'fake-model',
        effort: null,
        provider: 'anthropic',
      });
      expect(existsSync(added.profile.dir)).toBe(true);

      // The profile of the specs is the one the service created.
      const profile: Profile = {
        client: 'fake',
        profile: 'one',
        id: 'fake/one',
        dir: added.profile.dir,
      };
      const quick = rig.runner.run(
        specOf(rig, '#script:echo', { role: 'actor', demandId: 'demand-1', profile }),
      );
      const slow = rig.runner.run(
        specOf(rig, '#script:hang', { role: 'actor', demandId: 'demand-2', profile }),
      );
      await until(
        async () =>
          (await eventsOf(rig, 'session.update')).some((event) =>
            JSON.stringify(event.payload).includes('hanging until session/cancel'),
          ),
        'the slow session hanging',
      );
      expect((await quick).state).toBe('completed');
      expect(await service.acceptsSessions('fake/one')).toBe(true);

      // The removal: it waits out the timeout on the fake clock, then the slow one leaves.
      const removing = service.remove('fake/one');
      const state = { done: false };
      const isDone = (): boolean => state.done;
      const finished = removing.finally(() => {
        state.done = true;
      });
      finished.catch(() => undefined);
      for (let i = 0; i < 5000 && !isDone(); i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!isDone() && rig.clock.pendingSleeps > 0) await rig.clock.advance(60_000);
      }
      const removed = await finished;

      expect(removed.profile.state).toBe('removed');
      expect(await service.acceptsSessions('fake/one')).toBe(false);
      const outcome = await slow;
      expect(outcome.state).toBe('completed');
      expect(outcome).toMatchObject({
        handoffs: [{ cause: 'profile_removed', to: ID_TWO, countedAsAttempt: false }],
      });
      expect(await rig.store.attempts.get(outcome.attemptId)).toMatchObject({
        profile: 'two',
        state: 'completed',
        attempt: 1,
      });
      const [drained] = await eventsOf(rig, 'profile.drained');
      expect(drained?.payload).toMatchObject({ outcome: 'handoff', sessions: 1 });
      expect(existsSync(added.profile.dir)).toBe(false);
      const executors = await rig.store.executors.list({ profileId: 'fake/one' });
      expect(executors.map((executor) => executor.validity)).toEqual(['invalid']);
      expect(rig.launcher.running).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );
});
