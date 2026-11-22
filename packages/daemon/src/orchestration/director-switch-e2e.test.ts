// SPDX-License-Identifier: MPL-2.0
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import type {
  ScenarioDirectorSwitchedPayload,
  ScenarioSystemMessagePayload,
} from '@otheater/protocol';
import {
  FAKE_AGENT_CLI,
  RealHeadCodeHost,
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayFakes,
  type PlayHarness,
  type PlayHarnessOptions,
} from './e2e-fixture.js';
import { defaultLauncher, productionClients } from '../compose.js';
import { parseConfig } from '../config.js';
import { startDaemon, type DaemonHandle } from '../daemon.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths } from '../paths.js';
import { describeWithLauncher } from '../launcher-fixture.js';
import { readDirectorOverride } from './director-switch.js';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the answers of the API are read as loose JSON */
/**
 * The manual switch of the Director (Phase 9, P14, owner's decision N242), with the compiled fake
 * agent and a fake clock: another Executor opens a new session whose first prompt carries the
 * state summary; only the effort changes the open session; the override outlives the sleep and a
 * restart of the daemon and "default" removes it; a switch in a turn waits for the turn to end.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

const ROLES = ['director', 'consultant', 'author', 'reviewer', 'scriptwriter', 'actor', 'critic'];
const entry = (profile: string): string => `fake-model@fake/${profile}`;
const IDLE = 15 * 60_000;

/** The roles file of the daemon: the Director takes `one`, then `two`; the other roles take `three`. */
function rolesConfig(rest = ''): string {
  const registry = ['one', 'two', 'three']
    .map(
      (profile) =>
        `  ${entry(profile)}:\n    client: fake\n    profile: ${profile}\n    model: fake-model\n`,
    )
    .join('');
  const roles = ROLES.map(
    (role) =>
      `  ${role}:\n    executors: [${(role === 'director' ? ['one', 'two'] : ['three']).map(entry).join(', ')}]\n`,
  ).join('');
  return `executors:\n${registry}roles:\n${roles}selection:\n  recheck_every: off\n${rest}`;
}

const INTERRUPT = 'scenarios:\n  director_switch:\n    in_turn: interrupt\n';

interface Rig {
  readonly harness: PlayHarness;
  readonly clock: FakeClock;
  readonly fakes: PlayFakes;
  /** The state directory the fake agents of the test share. */
  readonly stateDir: () => string;
}

async function withSwitchDaemon(
  options: PlayHarnessOptions,
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  let stateDir = '';
  const clock = new FakeClock();
  const fakes: PlayFakes = {
    codeHost: new FakeCodeHost(),
    clock,
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) => {
      stateDir = env.FAKE_AGENT_STATE_DIR ?? stateDir;
      return new FakeClientAdapter({
        launcher,
        baseEnv: {},
        env,
        adapterVersion: '1.0.0',
        command,
      });
    },
  };
  await withDaemon(fakes, options, async (harness) => {
    for (const name of ['one', 'two', 'three']) {
      await harness.daemon.store.profiles.create({
        client: 'fake',
        name,
        kind: 'token_plan',
        provider: 'fake',
        dir: `${harness.dataDir}/profiles/fake/${name}`,
        secretRef: null,
      });
    }
    await body({ harness, clock, fakes, stateDir: () => stateDir });
  });
}

/** A second daemon on the same state directory of the first one (which was stopped): a restart. */
async function restart(rig: Rig, extra: string): Promise<DaemonHandle> {
  const launcher = defaultLauncher();
  if (launcher === undefined) throw new Error('this platform has no process launcher');
  const config = parseConfig(`
backup:
  when: manual
security:
  unenforced: warn
limits:
  submit_retries: 1
project:
  conventions: detect
orchestration:
  executor:
    client: fake
    profile: one
    model: fake-model
${extra}
`);
  return startDaemon({
    dataDir: rig.harness.dataDir,
    config,
    overrides: {
      clock: rig.clock,
      vault: rig.fakes.vault,
      launcher,
      codeHost: new RealHeadCodeHost(rig.fakes.codeHost),
    },
    clients: (parts) => [
      ...productionClients(config)(parts),
      ...[
        rig.fakes.client(
          parts.launcher,
          { cmd: process.execPath, args: [FAKE_AGENT_CLI] },
          { FAKE_AGENT_SCRIPT: 'role-play', FAKE_AGENT_STATE_DIR: rig.stateDir() },
        ),
      ].flat(),
    ],
    logger: createSilentLogger(),
    version: '0.0.0-test',
  });
}

async function eventsOf(daemon: DaemonHandle, scenarioId: string, type: string) {
  return (await daemon.store.events.readFrom(0, 100_000)).filter(
    (event) => event.scenarioId === scenarioId && event.type === type,
  );
}

async function switched(
  daemon: DaemonHandle,
  scenarioId: string,
): Promise<ScenarioDirectorSwitchedPayload[]> {
  return (await eventsOf(daemon, scenarioId, 'scenario.director_switched')).map(
    (event) => event.payload as unknown as ScenarioDirectorSwitchedPayload,
  );
}

async function switchNotices(daemon: DaemonHandle, scenarioId: string) {
  return (await eventsOf(daemon, scenarioId, 'scenario.system_message'))
    .map((event) => event.payload as unknown as ScenarioSystemMessagePayload)
    .filter((payload) => payload.kind === 'director_switch');
}

async function repliesOf(daemon: DaemonHandle, scenarioId: string): Promise<string[]> {
  const producer = daemon.producer;
  if (producer === undefined) throw new Error('the daemon has no Producer channel');
  return (await producer.poll(scenarioId, 0)).replies.map((reply) => reply.text);
}

async function waitForReply(
  daemon: DaemonHandle,
  scenarioId: string,
  text: string,
): Promise<string> {
  return waitFor(`a reply with "${text}"`, async () =>
    (await repliesOf(daemon, scenarioId)).find((reply) => reply.includes(text)),
  );
}

async function directorExecutors(daemon: DaemonHandle): Promise<string[]> {
  return (await daemon.store.events.readFrom(0, 100_000))
    .filter((event) => event.type === 'executor.selected')
    .map((event) => event.payload as unknown as { role: string; executor: string | null })
    .filter((payload) => payload.role === 'director' && payload.executor !== null)
    .map((payload) => String(payload.executor));
}

async function sleepDirector(rig: Rig, scenarioId: string): Promise<void> {
  await waitFor('the Director to sleep', async () => {
    await rig.clock.advance(IDLE);
    const scenario = await rig.harness.daemon.store.scenarios.get(scenarioId);
    return scenario?.directorState === 'asleep' ? true : undefined;
  });
}

/** What the route of the commands answers (`SlashCommandResult`, read as loose JSON). */
interface Answer {
  readonly status: string;
  readonly text: string;
  readonly data: any;
}

let counter = 0;

/** A command of the chat through the route of the API, the way the TUI sends it. */
async function command(
  rig: { readonly dataDir: string },
  daemon: DaemonHandle,
  scenarioId: string,
  text: string,
): Promise<Answer> {
  const token = (await readFile(dataPaths(rig.dataDir).apiToken, 'utf8')).trim();
  counter += 1;
  const response = await fetch(`${daemon.api.url}/v1/scenarios/${scenarioId}/commands`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': `p14-${String(counter)}`,
    },
    body: JSON.stringify({ text }),
  });
  const body = (await response.json()) as Answer;
  if (response.status !== 200)
    throw new Error(`${text}: ${String(response.status)} ${JSON.stringify(body)}`);
  return body;
}

describeWithLauncher('the manual switch of the Director (P14)', { timeout: 180_000 }, () => {
  it('another Executor opens a new session and its first prompt carries the state summary', async () => {
    await withSwitchDaemon({ extra: rolesConfig() }, async ({ harness }) => {
      const { daemon } = harness;
      const run = (text: string) => command(harness, daemon, scenarioId, text);
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-chat first');
      await waitForReply(daemon, scenarioId, 'answer: first');
      expect(await directorExecutors(daemon)).toEqual([entry('one')]);
      expect(await repliesOf(daemon, scenarioId)).not.toContainEqual(
        expect.stringContaining('woke with the state of'),
      );

      const result = await run(`/director ${entry('two')}`);
      expect(result.status).toBe('done');
      expect(result.data).toMatchObject({
        status: 'applied',
        form: 'new_session',
        override: { executor: entry('two') },
      });
      expect(result.data.view.current.executor).toBe(entry('two'));

      await harness.producer.send(scenarioId, '#ot-chat second');
      await waitForReply(daemon, scenarioId, 'answer: second');
      // The new session was told the state of the scenario in its first prompt.
      await waitForReply(daemon, scenarioId, `woke with the state of ${scenarioId}`);
      expect(await directorExecutors(daemon)).toEqual([entry('one'), entry('two')]);

      const events = await switched(daemon, scenarioId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        scenarioId,
        form: 'new_session',
        fromExecutor: entry('one'),
        toExecutor: entry('two'),
        override: true,
        waited: false,
      });
      const notices = await switchNotices(daemon, scenarioId);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ kind: 'director_switch', form: 'new_session' });
    });
  });

  it('only the effort changes the open session: no new session, no summary', async () => {
    await withSwitchDaemon({ extra: rolesConfig() }, async ({ harness }) => {
      const { daemon } = harness;
      const run = (text: string) => command(harness, daemon, scenarioId, text);
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-chat first');
      await waitForReply(daemon, scenarioId, 'answer: first');

      const listed = (await run('/director')).data.director as {
        session: string;
        efforts: string[];
        models: { id: string }[];
        executors: { id: string; isDefault: boolean; current: boolean }[];
      };
      expect(listed.session).toBe('open');
      expect(listed.efforts).toEqual(['low', 'medium', 'high']);
      expect(listed.models.map((model) => model.id)).toEqual(['fake-model', 'fake-model-2']);
      expect(listed.executors.map((item) => [item.id, item.isDefault, item.current])).toEqual([
        [entry('one'), true, true],
        [entry('two'), false, false],
      ]);

      const result = await run('/effort high');
      expect(result.data).toMatchObject({ status: 'applied', form: 'live' });
      expect(result.data.view.current).toMatchObject({ executor: entry('one'), effort: 'high' });

      await harness.producer.send(scenarioId, '#ot-chat second');
      await waitForReply(daemon, scenarioId, 'answer: second');
      expect(await directorExecutors(daemon)).toEqual([entry('one')]);
      expect(await repliesOf(daemon, scenarioId)).not.toContainEqual(
        expect.stringContaining('woke with the state of'),
      );
      expect(await switched(daemon, scenarioId)).toMatchObject([{ form: 'live' }]);

      // The same choice again changes nothing.
      expect((await run('/effort high')).data).toMatchObject({
        status: 'applied',
        form: 'unchanged',
      });
    });
  });

  it('the override outlives the sleep and a restart of the daemon, and "default" removes it', async () => {
    await withSwitchDaemon({ extra: rolesConfig() }, async (rig) => {
      const { harness } = rig;
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-chat first');
      await waitForReply(harness.daemon, scenarioId, 'answer: first');

      await command(harness, harness.daemon, scenarioId, '/director 2');

      // The sleep: the override is still there and the Director wakes on `two`.
      await sleepDirector(rig, scenarioId);
      const asleep = await harness.daemon.store.scenarios.get(scenarioId);
      expect(readDirectorOverride(asleep?.configOverride ?? {})).toEqual({
        executor: entry('two'),
      });
      const view = (await command(harness, harness.daemon, scenarioId, '/director')).data.director;
      expect(view).toMatchObject({ session: 'asleep', current: { executor: entry('two') } });
      await harness.producer.send(scenarioId, '#ot-chat second');
      await waitForReply(harness.daemon, scenarioId, 'answer: second');
      expect((await directorExecutors(harness.daemon)).at(-1)).toBe(entry('two'));

      // The restart: a new daemon on the same data directory reads the override from the store.
      await harness.daemon.stop();
      const daemon = await restart(rig, rolesConfig());
      try {
        const run = (text: string) => command(harness, daemon, scenarioId, text);
        const stored = await daemon.store.scenarios.get(scenarioId);
        expect(readDirectorOverride(stored?.configOverride ?? {})).toEqual({
          executor: entry('two'),
        });
        expect((await run('/director')).data.director.override).toEqual({
          executor: entry('two'),
        });
        const producer = daemon.producer;
        if (producer === undefined) throw new Error('the daemon has no Producer channel');
        await producer.send(scenarioId, '#ot-chat third');
        await waitForReply(daemon, scenarioId, 'answer: third');
        expect((await directorExecutors(daemon)).at(-1)).toBe(entry('two'));

        // "default" takes the override away; the Director goes back to the first of the list.
        const back = await run('/director default');
        expect(back.data).toMatchObject({ status: 'applied', form: 'new_session', override: null });
        const after = await daemon.store.scenarios.get(scenarioId);
        expect(readDirectorOverride(after?.configOverride ?? {})).toBeNull();
        await producer.send(scenarioId, '#ot-chat fourth');
        await waitForReply(daemon, scenarioId, 'answer: fourth');
        expect((await directorExecutors(daemon)).at(-1)).toBe(entry('one'));
      } finally {
        await daemon.stop();
      }
    });
  });

  it('a switch during a turn waits for the turn to end (in_turn: wait)', async () => {
    await withSwitchDaemon({ extra: rolesConfig() }, async ({ harness, stateDir }) => {
      const { daemon } = harness;
      const run = (text: string) => command(harness, daemon, scenarioId, text);
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-director-hang\n#ot-chat hello');
      await waitFor('the Director turn to hang', () =>
        Promise.resolve(existsSync(join(stateDir(), 'director-hang.count'))),
      );

      const result = await run(`/director ${entry('two')}`);
      expect(result.data).toMatchObject({ status: 'pending', form: null });
      expect(result.data.view).toMatchObject({ inTurn: true, pending: true });
      // The choice is stored at once, but nothing was done to the session.
      const stored = await daemon.store.scenarios.get(scenarioId);
      expect(readDirectorOverride(stored?.configOverride ?? {})).toEqual({
        executor: entry('two'),
      });
      expect(await switched(daemon, scenarioId)).toEqual([]);
      expect(await directorExecutors(daemon)).toEqual([entry('one')]);

      // The turn ends (the Producer stops it): the switch is carried out and announced.
      expect((await run('/stop')).data).toMatchObject({ stopped: true });
      const events = await waitFor('the switch event', async () => {
        const found = await switched(daemon, scenarioId);
        return found.length > 0 ? found : undefined;
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        form: 'new_session',
        waited: true,
        toExecutor: entry('two'),
      });
      expect((await switchNotices(daemon, scenarioId))[0]).toMatchObject({ form: 'new_session' });

      // The prompt that comes next opens the new session, told the state of the scenario.
      await harness.producer.send(scenarioId, '#ot-chat after');
      await waitForReply(daemon, scenarioId, `woke with the state of ${scenarioId}`);
      expect(await directorExecutors(daemon)).toEqual([entry('one'), entry('two')]);
    });
  });

  it('with in_turn: interrupt the turn is cut and the switch is carried out at once', async () => {
    await withSwitchDaemon({ extra: rolesConfig(INTERRUPT) }, async ({ harness, stateDir }) => {
      const { daemon } = harness;
      const run = (text: string) => command(harness, daemon, scenarioId, text);
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-director-hang\n#ot-chat hello');
      await waitFor('the Director turn to hang', () =>
        Promise.resolve(existsSync(join(stateDir(), 'director-hang.count'))),
      );

      const result = await run(`/director ${entry('two')}`);
      expect(result.data.status).toBe('applied');
      expect(await switched(daemon, scenarioId)).toMatchObject([
        { form: 'new_session', toExecutor: entry('two') },
      ]);

      await harness.producer.send(scenarioId, '#ot-chat after');
      await waitForReply(daemon, scenarioId, `woke with the state of ${scenarioId}`);
      expect((await directorExecutors(daemon)).at(-1)).toBe(entry('two'));
    });
  });

  it('refuses an Executor that is not in the list of the Director and keeps what was there', async () => {
    await withSwitchDaemon({ extra: rolesConfig() }, async ({ harness }) => {
      const { daemon } = harness;
      const scenarioId = await harness.openGenericChat('talk');
      await harness.producer.send(scenarioId, '#ot-chat first');
      await waitForReply(daemon, scenarioId, 'answer: first');
      await expect(
        command(harness, daemon, scenarioId, `/director ${entry('three')}`),
      ).rejects.toThrow(/4\d\d/);
      const stored = await daemon.store.scenarios.get(scenarioId);
      expect(readDirectorOverride(stored?.configOverride ?? {})).toBeNull();
      expect(await switched(daemon, scenarioId)).toEqual([]);
    });
  });
});
