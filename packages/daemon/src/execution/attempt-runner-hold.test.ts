// SPDX-License-Identifier: MPL-2.0
import {
  FakeClientAdapter,
  FakeClock,
  FakeProcessLauncher,
  FakeSessionTransport,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { editsPrompt } from '../test-helpers.js';
import { eventsOf, makeRig, specOf, until, type Rig, type RigParts } from './attempt-fixture.js';

/**
 * The hold of the update (Phase 10, P8; `updates.apply_when: idle`): while it is on, an attempt that
 * has not begun waits; the ones in progress go on to their end; the release lets the waiting ones in.
 */

const TEST_TIMEOUT_MS = 30_000;

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

type TestRig = Rig<ReturnType<typeof fakes>>;

const rigs: TestRig[] = [];
async function rig(): Promise<TestRig> {
  const made = await makeRig(fakes());
  rigs.push(made);
  return made;
}
afterEach(async () => {
  for (const made of rigs.splice(0)) await made.dispose();
});
afterAll(disposeTestGitIsolation);

describe('AttemptRunner, the hold of the update', () => {
  it(
    'keeps a new attempt from beginning until the release, and then lets it run',
    async () => {
      const r = await rig();
      expect(r.runner.held).toBe(false);
      r.runner.hold();
      r.runner.hold();
      expect(r.runner.held).toBe(true);

      const waiting = r.runner.run(specOf(r, editsPrompt({ 'a.txt': 'a\n' }, 'done')));
      await new Promise((done) => setTimeout(done, 50));
      expect(await eventsOf(r)).toEqual([]);
      expect(r.runner.active).toBe(0);

      r.runner.release();
      r.runner.release();
      expect(r.runner.held).toBe(false);
      expect(await waiting).toMatchObject({ state: 'completed' });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not touch an attempt that is already running',
    async () => {
      const r = await rig();
      const running = r.runner.run(specOf(r, '#script:hang'));
      await until(async () => (await eventsOf(r, 'session.update')).length > 0, 'the attempt');
      r.runner.hold();
      expect(r.runner.active).toBe(1);
      r.runner.release();
      const outcome = await r.runner.cancelAttempt('play-1/demand-1/1');
      expect(outcome.state).toBe('cancelled');
      await running;
      expect(r.runner.active).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a stop releases the hold, so nothing waits for a daemon that is going away',
    async () => {
      const r = await rig();
      r.runner.hold();
      const waiting = r.runner.run(specOf(r, 'done')).then(
        () => 'ran',
        () => 'refused',
      );
      await new Promise((done) => setTimeout(done, 20));
      await r.runner.stop();
      expect(r.runner.held).toBe(false);
      // A runner that stopped does not begin a new attempt: the waiting one ends, and does not hang.
      expect(await waiting).toBe('refused');
    },
    TEST_TIMEOUT_MS,
  );
});
