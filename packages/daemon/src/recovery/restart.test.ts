// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlayRecord } from '@otheater/core';
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

/**
 * A daemon that is stopped in the middle of a play and started again on the same data folder (the
 * clean half of architecture 5.21): the machine comes back from its snapshot, the reconciliation
 * writes `daemon.recovered`, and the play reaches its end with one pull request.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const CONFIG = `
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

describe('a restart in the middle of a play (P9)', { timeout: 180_000 }, () => {
  it('resumes the play from its snapshot and takes it to the end', async () => {
    const tmp = await makeTempDataDir();
    const stateDir = await mkdtemp(join(tmpdir(), 'otheater-restart-'));
    const clock = new FakeClock();
    const vault = new InMemorySecretVault();
    const fake = new FakeCodeHost();
    const codeHost = new RealHeadCodeHost(fake);
    const rig = await makeWorkspaceRig({ store: new InMemoryStore({ clock }), codeHost });
    fake.seedRemote(rig.repo, 'main');
    const launcher = defaultLauncher();
    if (launcher === undefined) throw new Error('this platform has no process launcher');
    const config = parseConfig(CONFIG);
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
            env: { FAKE_AGENT_SCRIPT: 'role-play', FAKE_AGENT_STATE_DIR: stateDir },
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
      await producer.send(scenarioId, '#ot-play write alpha and beta #outcome:approved');
      const play: PlayRecord = await waitFor('the play to exist', async () => {
        return (await first.store.plays.list({ scenarioId }))[0];
      });
      await waitFor(
        'the play to be executing',
        async () => (await first.store.plays.get(play.id))?.state === 'EXECUTING',
      );
      await first.stop();

      daemon = await start();
      const second = daemon;
      await waitFor(
        'DONE after the restart',
        async () => (await second.store.plays.get(play.id))?.state === 'DONE',
      );

      const events = await second.store.events.readFrom(0, 100_000);
      const recovered = events.filter((event) => event.type === 'daemon.recovered');
      expect(recovered).toHaveLength(2);
      expect(recovered[1]?.payload).toMatchObject({ playsResumed: [play.id], playsRefused: [] });
      expect(
        events.filter((event) => event.type === 'delivery.completed' && event.playId === play.id),
      ).toHaveLength(1);
      expect(fake.pullRequests()).toHaveLength(1);
    } finally {
      await daemon?.stop();
      await rig.dispose();
      await rm(stateDir, { recursive: true, force: true });
      await tmp.dispose();
    }
  });
});
