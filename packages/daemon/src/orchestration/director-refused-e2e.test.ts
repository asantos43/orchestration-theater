// SPDX-License-Identifier: MPL-2.0
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import pino from 'pino';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import type { Enforcement } from '@otheater/core';
import { disposeTestGitIsolation } from '@otheater/sdk';
import type {
  ScenarioDirectorFailoverNotice,
  ScenarioSystemMessagePayload,
} from '@otheater/protocol';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayHarness,
} from './e2e-fixture.js';
import { describeWithLauncher } from '../launcher-fixture.js';

/**
 * The Director that the security policy refuses (N334): a machine with no layer 3 and
 * `security.unenforced: refuse` (the Windows default) makes the opening throw `PermissionDenied`.
 * The chat has to hear it once per try, with the cause `permission`; the prompt stays in the queue.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

/** No layer for the two fields only the sandbox guarantees. */
const SHORT = {
  nativeTools: ['client'],
  nativeShell: ['client'],
  mcpServers: ['client'],
  mcpTools: ['client'],
  onAsk: ['client'],
  bypass: ['client'],
  writeScope: [],
  network: [],
} as unknown as Enforcement;

async function failovers(
  harness: PlayHarness,
  scenarioId: string,
): Promise<ScenarioDirectorFailoverNotice[]> {
  const events = await harness.daemon.store.events.readFrom(0, 100_000);
  return events
    .filter((event) => event.scenarioId === scenarioId && event.type === 'scenario.system_message')
    .map((event) => event.payload as unknown as ScenarioSystemMessagePayload)
    .filter((payload): payload is ScenarioDirectorFailoverNotice => {
      return payload.kind === 'director_failover';
    });
}

async function withRefusingDaemon(
  body: (harness: PlayHarness, logged: string[]) => Promise<void>,
): Promise<void> {
  const logged: string[] = [];
  const logger = pino(
    { level: 'warn' },
    {
      write: (line: string) => {
        logged.push(line);
      },
    },
  );
  await withDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: new FakeClock(),
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({
          launcher,
          baseEnv: {},
          env,
          adapterVersion: '1.0.0',
          command,
          enforcement: SHORT,
          unenforced: 'refuse',
        }),
    },
    { logger },
    async (harness) => {
      await body(harness, logged);
    },
  );
}

describeWithLauncher(
  'the Director refused by the security policy (N334)',
  { timeout: 120_000 },
  () => {
    it('tells the chat once per try, with the cause permission, and keeps the prompt', async () => {
      await withRefusingDaemon(async (harness, logged) => {
        const scenarioId = await harness.openGenericChat('talk');
        await waitFor('the unavailable notice', async () =>
          (await failovers(harness, scenarioId)).find((item) => item.outcome === 'unavailable'),
        );
        // Let anything that would repeat the notice run.
        await sleep(1500);
        const first = (await failovers(harness, scenarioId)).filter(
          (item) => item.outcome === 'unavailable',
        );
        // The opening of the chat: one try, one notice, one warning.
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ cause: 'permission', fromExecutor: null });
        expect(first[0]?.detail).toContain('security.unenforced is refuse');
        const opens = (): number =>
          logged.filter((line) => line.includes('the Director session did not open')).length;
        expect(opens()).toBe(1);

        // The next prompt tries again: one more notice, and the prompt waits in the queue.
        await harness.producer.send(scenarioId, '#ot-chat hello');
        await waitFor('the second notice', async () =>
          (await failovers(harness, scenarioId)).filter((item) => item.outcome === 'unavailable')
            .length >= 2
            ? true
            : undefined,
        );
        await sleep(1500);
        const all = (await failovers(harness, scenarioId)).filter(
          (item) => item.outcome === 'unavailable',
        );
        expect(all).toHaveLength(2);
        expect(all.every((item) => item.cause === 'permission')).toBe(true);
        expect(opens()).toBe(2);
        expect(
          (await harness.daemon.store.promptQueue.list({ scenarioId })).filter(
            (item) => item.state === 'pending',
          ),
        ).toHaveLength(1);
        expect((await harness.producer.state(scenarioId)).busy).toBe(false);
      });
    });
  },
);
