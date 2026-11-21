// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Secret, type Clock, type EventEnvelope } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayFakes,
  type PlayHarness,
} from '../orchestration/e2e-fixture.js';
import { describeWithLauncher } from '../launcher-fixture.js';
import { createSilentLogger } from '../logger.js';
import { dataPaths } from '../paths.js';
import { Redactor } from './redaction.js';
import { MemoryTelemetryStore } from './telemetry-fixture.js';
import { TelemetryReceiver } from './receiver.js';
import { TelemetrySessions } from './sessions.js';
import { SPAN_NAME } from './span-conventions.js';
import { traceIdForPlay } from './span-ids.js';

/**
 * Phase 8, P7, the acceptance of the export: a play of the fake agent, with `telemetry.export`
 * `both`, reaches a test OTLP receiver (the receiver of P2, on a port of its own) and `/metrics`
 * answers; with the destination down the play ends and the event says why; with `off` nothing
 * leaves and `/metrics` is a 404. The clock of the fixture is frozen, so the interval of the
 * exporter never fires: what was not sent yet leaves in the last pass, when the daemon stops.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

class TickingClock implements Clock {
  readonly #base = new FakeClock();
  #ticks = 0;
  now(): number {
    this.#ticks += 1;
    return this.#base.now() + this.#ticks;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.#base.sleep(ms, signal);
  }
}

function fakes(vault: InMemorySecretVault): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new TickingClock(),
    vault,
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

async function openPlay(harness: PlayHarness): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, '#ot-play write alpha and beta #outcome:approved');
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  return play.id;
}

/** A TCP port nothing listens on: it was free a moment ago and is closed again. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** The destination: the receiver of P2 on a test port, writing to a store the test can read. */
async function startDestination(): Promise<{
  receiver: TelemetryReceiver;
  store: MemoryTelemetryStore;
}> {
  const store = new MemoryTelemetryStore();
  const receiver = await TelemetryReceiver.start({
    store,
    sessions: new TelemetrySessions(),
    redactor: new Redactor({ mode: 'default' }),
    port: 'auto',
    maxBody: 8 * 1024 * 1024,
    logger: createSilentLogger(),
  });
  return { receiver, store };
}

function exportConfig(mode: string, endpoint: string): string {
  return `
telemetry:
  export: ${mode}
  otlp:
    endpoint: ${endpoint}
    headers:
      Authorization: otlp/destination-token
    retry:
      retries: 0
`;
}

async function scrape(harness: PlayHarness, authorized = true): Promise<Response> {
  const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
  return fetch(`${harness.daemon.api.url}/metrics`, {
    headers: authorized ? { authorization: `Bearer ${token}` } : {},
  });
}

/** Follows the events of the telemetry export until `stop()`; what it saw is in `events`. */
function watchExport(harness: PlayHarness): { events: EventEnvelope[]; stop: () => Promise<void> } {
  const controller = new AbortController();
  const events: EventEnvelope[] = [];
  const done = (async () => {
    for await (const event of harness.daemon.eventHub.follow({
      filter: { typePrefixes: ['telemetry.export'] },
      signal: controller.signal,
    })) {
      events.push(event);
    }
  })();
  return {
    events,
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

describeWithLauncher('the export of the telemetry of a play (P7)', { timeout: 120_000 }, () => {
  it('both: the trace of the play reaches the OTLP destination and /metrics answers', async () => {
    const destination = await startDestination();
    const vault = new InMemorySecretVault();
    await vault.set('otlp/destination-token', new Secret(`Bearer ${destination.receiver.token}`));
    let playId = '';
    try {
      await withPlayDaemon(
        fakes(vault),
        { extra: exportConfig('both', destination.receiver.url) },
        async (harness) => {
          playId = await openPlay(harness);
          await waitFor(
            'DONE',
            async () => (await harness.daemon.store.plays.get(playId))?.state === 'DONE',
          );
          const response = await scrape(harness);
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(text).toContain('# TYPE otheater_attempts_total counter');
          expect(text).toMatch(/otheater_attempts_total\{executor="[^"]+",role="[^"]+",outcome="/u);
          // The same rules as the rest of the API: no token, no metrics.
          expect((await scrape(harness, false)).status).toBe(401);
        },
      );
      // The daemon stopped: its last pass sent what the frozen clock never let the interval send.
      const spans = await destination.store.readSpans();
      const trace = spans.filter((span) => span.traceId === traceIdForPlay(playId));
      expect(trace.some((span) => span.name === SPAN_NAME.play)).toBe(true);
      expect(trace.some((span) => span.name === SPAN_NAME.stage)).toBe(true);
    } finally {
      await destination.receiver.stop();
    }
  });

  it('with the destination down the play ends and the event says that the export failed', async () => {
    const port = await closedPort();
    const vault = new InMemorySecretVault();
    await vault.set('otlp/destination-token', new Secret('Bearer not-needed'));
    let watched: ReturnType<typeof watchExport> | undefined;
    let state: string | undefined;
    await withPlayDaemon(
      fakes(vault),
      { extra: exportConfig('both', `http://127.0.0.1:${String(port)}`) },
      async (harness) => {
        watched = watchExport(harness);
        const playId = await openPlay(harness);
        await waitFor(
          'DONE',
          async () => (await harness.daemon.store.plays.get(playId))?.state === 'DONE',
        );
        state = (await harness.daemon.store.plays.get(playId))?.state;
        // The local writing never stopped: the spans are in the base the play wrote.
        // Stopping here lets the last pass run and tell what it could not send.
        await harness.daemon.stop();
      },
    );
    expect(state).toBe('DONE');
    await watched?.stop();
    const failed = (watched?.events ?? []).filter(
      (event) => event.type === 'telemetry.export_failed',
    );
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]?.payload).toHaveProperty('reason');
  });

  it('off: nothing leaves and /metrics is a 404', async () => {
    const destination = await startDestination();
    const vault = new InMemorySecretVault();
    try {
      await withPlayDaemon(
        fakes(vault),
        { extra: exportConfig('off', destination.receiver.url) },
        async (harness) => {
          const playId = await openPlay(harness);
          await waitFor(
            'DONE',
            async () => (await harness.daemon.store.plays.get(playId))?.state === 'DONE',
          );
          expect((await scrape(harness)).status).toBe(404);
        },
      );
      expect(await destination.store.readSpans()).toEqual([]);
    } finally {
      await destination.receiver.stop();
    }
  });
});
