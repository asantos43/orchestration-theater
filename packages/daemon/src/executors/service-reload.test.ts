// SPDX-License-Identifier: MPL-2.0
import { join } from 'node:path';
import type { ModelCatalog } from '@otheater/core';
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { createConfigReloader } from '../config-reload.js';
import { createSilentLogger } from '../logger.js';
import { makeTempDataDir } from '../test-helpers.js';
import { fixtureOpenCodeCatalog } from './opencode-catalog-fixture.js';
import { ExecutorService } from './service.js';

const MINIMAX = 'minimax/MiniMax-M2';
const MINIMAX_ID = 'minimax-m2-medium@opencode/local';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** An Executor service wired to the reload of a running configuration, as the daemon wires it. */
async function rig() {
  const dir = await makeTempDataDir();
  cleanups.push(dir.dispose);
  const store = new InMemoryStore({ clock: new FakeClock() });
  await store.profiles.create({
    client: 'opencode',
    name: 'local',
    kind: 'token_plan',
    provider: 'minimax',
    dir: '/profiles/opencode/local',
    secretRef: null,
  });
  const live = parseConfig('');
  const reloader = createConfigReloader({
    config: live,
    events: store.events,
    logger: createSilentLogger(),
  });
  const opencode = fixtureOpenCodeCatalog({ profileRoot: join(dir.dir, 'profiles') });
  const catalogs: Record<string, ModelCatalog> = { opencode: opencode.catalog };
  const make = (withReload: boolean) =>
    new ExecutorService({
      store,
      clock: new FakeClock(),
      logger: createSilentLogger(),
      configPath: join(dir.dir, 'config.yaml'),
      catalogs: (client) => catalogs[client],
      ...(withReload ? { reload: reloader.reload } : {}),
    });
  const changed = async () =>
    (await store.events.readFrom(0, 100)).filter((event) => event.type === 'config.changed');
  return { live, make, changed };
}

describe('the cadastro of an Executor takes the write into the running configuration (P23)', () => {
  it('adds the Executor, its roles and its local block at once, with config.changed', async () => {
    const { live, make, changed } = await rig();
    const result = await make(true).add({
      profileId: 'opencode/local',
      model: MINIMAX,
      roles: [{ role: 'critic' }],
    });
    expect(result.status).toBe('registered');
    expect(live.executors.entries[MINIMAX_ID]).toMatchObject({
      client: 'opencode',
      model: MINIMAX,
    });
    expect(live.roles.critic?.executors).toEqual([MINIMAX_ID]);
    const events = await changed();
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { hot: string[]; restart: string[] };
    expect(payload.hot).toEqual(
      expect.arrayContaining([`executors.${MINIMAX_ID}`, 'roles.critic.executors']),
    );
    expect(payload.restart).toEqual([]);
  });

  it('removes the Executor and takes it out of the lists at once, with config.changed', async () => {
    const { live, make, changed } = await rig();
    const service = make(true);
    await service.add({ profileId: 'opencode/local', model: MINIMAX, roles: [{ role: 'critic' }] });
    expect(live.executors.entries[MINIMAX_ID]).toBeDefined();
    await service.remove(MINIMAX_ID);
    expect(live.executors.entries[MINIMAX_ID]).toBeUndefined();
    expect(live.roles.critic?.executors).toBeUndefined();
    const events = await changed();
    expect(events).toHaveLength(2);
    expect((events[1]?.payload as { hot: string[] }).hot).toEqual(
      expect.arrayContaining([`executors.${MINIMAX_ID}`, 'roles.critic.executors']),
    );
  });

  it('a dry run changes nothing and writes no event', async () => {
    const { live, make, changed } = await rig();
    await make(true).add({ profileId: 'opencode/local', model: MINIMAX, dryRun: true });
    expect(live.executors.entries).toEqual({});
    expect(await changed()).toHaveLength(0);
  });

  it('without a reload (an ot command with no daemon) the file is written and nothing else moves', async () => {
    const { live, make, changed } = await rig();
    await make(false).add({ profileId: 'opencode/local', model: MINIMAX });
    expect(live.executors.entries).toEqual({});
    expect(await changed()).toHaveLength(0);
  });
});
