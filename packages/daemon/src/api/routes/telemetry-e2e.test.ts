// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import type { Clock } from '@otheater/core';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { PlaySpansSchema, TelemetryStatusSchema } from '@otheater/protocol';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeWithLauncher } from '../../launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon,
  type PlayFakes,
} from '../../orchestration/e2e-fixture.js';
import { dataPaths } from '../../paths.js';
import { SPAN_NAME } from '../../telemetry/span-conventions.js';
import { MemoryTelemetryStore } from '../../telemetry/telemetry-fixture.js';

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

/** The frozen clock of the fixture, moving one millisecond at each reading: times are coherent. */
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

function fakes(): PlayFakes {
  return {
    codeHost: new FakeCodeHost(),
    clock: new TickingClock(),
    vault: new InMemorySecretVault(),
    client: (launcher, command, env) =>
      new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
  };
}

describeWithLauncher(
  'the spans of a play and the state of the telemetry, with the fake agent (P10)',
  { timeout: 120_000 },
  () => {
    it('lists the stages, attempts and tools of the finished play and answers the state', async () => {
      const telemetry = new MemoryTelemetryStore();
      await withPlayDaemon(fakes(), { telemetry }, async (harness) => {
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, '#ot-play write alpha and beta #outcome:approved');
        const play = await waitFor(
          'the play to exist',
          async () => (await harness.plays(scenarioId))[0],
        );
        await waitFor(
          'DONE',
          async () => (await harness.daemon.store.plays.get(play.id))?.state === 'DONE',
        );
        await waitFor('the play span', async () => {
          const all = await telemetry.readSpans();
          return all.some((span) => span.name === SPAN_NAME.play) ? all : undefined;
        });
        await telemetry.flush();

        const token = (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();
        const get = (path: string): Promise<Response> =>
          fetch(`${harness.daemon.api.url}${path}`, {
            headers: { authorization: `Bearer ${token}` },
          });

        const spansResponse = await get(`/v1/plays/${play.id}/spans`);
        expect(spansResponse.status).toBe(200);
        const tree = PlaySpansSchema.parse(await spansResponse.json());
        expect(tree.playClosed).toBe(true);
        expect(tree.truncated).toBe(false);
        const kinds = new Set(tree.spans.map((span) => span.kind));
        expect(kinds.has('play')).toBe(true);
        expect(kinds.has('stage')).toBe(true);
        expect(kinds.has('attempt')).toBe(true);
        // The play is the one root and everything hangs from it, in a tree.
        expect(tree.spans[0]).toMatchObject({ kind: 'play', depth: 0, parentSpanId: null });
        const stages = tree.spans.filter((span) => span.kind === 'stage');
        const path = await harness.pathOf(play.id);
        for (const state of new Set(path.slice(0, -1))) {
          expect(
            stages.some((stage) => stage.label === state),
            `the stage ${state}`,
          ).toBe(true);
        }
        for (const stage of stages) expect(stage.durationMs).toBeGreaterThan(0);
        for (const span of tree.spans.filter((s) => s.kind === 'attempt')) {
          expect(span.attemptId).not.toBeNull();
          expect(span.depth).toBeGreaterThan(stages[0]?.depth ?? 0);
        }

        const statusResponse = await get('/v1/telemetry');
        expect(statusResponse.status).toBe(200);
        const status = TelemetryStatusSchema.parse(await statusResponse.json());
        expect(status.daemonSpans).toBe(true);
        expect(status.base?.state).toBe('ok');
        expect(status.export.otlp).toBeNull();
      });
    });
  },
);
