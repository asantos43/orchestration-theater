// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PlayRecord, Store } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
  InMemoryStore,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import {
  assertFakeAgentBuilt,
  FAKE_AGENT_CLI,
  RealHeadCodeHost,
  waitFor,
} from '../orchestration/e2e-fixture.js';
import { makeTempDataDir } from '../test-helpers.js';
import { makeWorkspaceRig } from '../workspace/workspace-fixture.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * `resume.on_restart` (architecture 5.21): a daemon stopped while the Actor of `alpha/1` works, and
 * started again on the same data folder. With `native` (the default) the play resumes that attempt
 * in its own session (`session/load`) and no `alpha/2` is opened; with `handoff` the attempt is
 * parked and the play opens `alpha/2`. The fake agent replays the first prompt after the load
 * (`FAKE_AGENT_HISTORY=1`), as a client that keeps its conversation.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const BASE = `
backup:
  when: manual
security:
  unenforced: warn
limits:
  submit_retries: 1
orchestration:
  executor:
    client: fake
    profile: one
    model: fake-model
`;

async function attemptsOf(store: Store, playId: string, demandId: string) {
  return (await store.attempts.list())
    .filter((a) => a.playId === playId && a.demandId === demandId)
    .sort((a, b) => a.attempt - b.attempt);
}

async function restartWhileAlphaWorks(extra: string) {
  const tmp = await makeTempDataDir();
  const stateDir = await mkdtemp(join(tmpdir(), 'otheater-restart-native-'));
  const clock = new FakeClock();
  const vault = new InMemorySecretVault();
  const fake = new FakeCodeHost();
  const codeHost = new RealHeadCodeHost(fake);
  const rig = await makeWorkspaceRig({ store: new InMemoryStore({ clock }), codeHost });
  fake.seedRemote(rig.repo, 'main');
  const launcher = defaultLauncher();
  if (launcher === undefined) throw new Error('this platform has no process launcher');
  const config = parseConfig(`${BASE}${extra}`);
  const start = (): Promise<DaemonHandle> =>
    startDaemon({
      dataDir: tmp.dir,
      config,
      overrides: { clock, vault, launcher, codeHost },
      clients: (parts) => [
        ...productionClients(config)(parts),
        new FakeClientAdapter({
          launcher: parts.launcher,
          baseEnv: {},
          env: {
            FAKE_AGENT_SCRIPT: 'role-play',
            FAKE_AGENT_STATE_DIR: stateDir,
          },
          adapterVersion: '1.0.0',
          command: { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
        }),
      ],
      logger: createSilentLogger(),
      version: '0.0.0-test',
    });
  let daemon: DaemonHandle | undefined;
  try {
    daemon = await start();
    const first = daemon;
    const producer = first.producer;
    if (producer === undefined) throw new Error('the daemon has no Producer channel');
    const { scenarioId } = await producer.openChat({ repo: rig.repo });
    await producer.send(
      scenarioId,
      '#ot-play write alpha and beta #actor-hang:alpha@1 #outcome:approved',
    );
    const play: PlayRecord = await waitFor('the play to exist', async () => {
      return (await first.store.plays.list({ scenarioId }))[0];
    });
    await waitFor('the Actor of alpha/1 to be working', async () => {
      const [one] = await attemptsOf(first.store, play.id, 'alpha');
      if (one?.state !== 'executing' || one.sessionId === null) return false;
      // the fake agent counts the hang when its turn reaches it (role-play.ts, `#actor-hang`)
      return (
        (await readFile(join(stateDir, 'actor-hang-alpha-1.count'), 'utf8').catch(() => '0')) !==
        '0'
      );
    });
    await first.stop();

    daemon = await start();
    const second = daemon;
    await waitFor(
      'DONE after the restart',
      async () => (await second.store.plays.get(play.id))?.state === 'DONE',
    );
    const events = await second.store.events.readFrom(0, 100_000);
    return {
      play,
      events,
      alpha: await attemptsOf(second.store, play.id, 'alpha'),
      pullRequests: fake.pullRequests().length,
    };
  } finally {
    await daemon?.stop();
    await rig.dispose();
    await rm(stateDir, { recursive: true, force: true });
    await tmp.dispose();
  }
}

describeWithLauncher('resume.on_restart', { timeout: 180_000 }, () => {
  it('native (default): the play resumes alpha/1 in its session and opens no alpha/2', async () => {
    const { play, events, alpha, pullRequests } = await restartWhileAlphaWorks('');
    expect(alpha.map((a) => [a.attempt, a.state])).toEqual([[1, 'completed']]);
    const [one] = alpha;
    const resumed = events.filter(
      (event) =>
        event.type === 'session.resumed' &&
        (event.payload as { attemptId?: string }).attemptId === one?.attemptId,
    );
    expect(resumed.map((event) => event.payload)).toEqual([
      expect.objectContaining({ form: 'native', cause: 'daemon_restart' }),
    ]);
    expect(
      events.filter((event) => event.type === 'delivery.completed' && event.playId === play.id),
    ).toHaveLength(1);
    expect(pullRequests).toBe(1);
  });

  it('handoff: alpha/1 is parked at the start and the play opens alpha/2', async () => {
    const { play, events, alpha, pullRequests } = await restartWhileAlphaWorks(
      'resume:\n  on_restart: handoff\n',
    );
    expect(alpha.map((a) => [a.attempt, a.state])).toEqual([
      [1, 'interrupted'],
      [2, 'completed'],
    ]);
    expect(
      events.filter(
        (event) =>
          event.type === 'session.resumed' &&
          (event.payload as { attemptId?: string }).attemptId === alpha[0]?.attemptId,
      ),
    ).toEqual([]);
    expect(
      events.filter((event) => event.type === 'delivery.completed' && event.playId === play.id),
    ).toHaveLength(1);
    expect(pullRequests).toBe(1);
  });
});
