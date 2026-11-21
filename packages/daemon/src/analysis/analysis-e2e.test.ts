// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-non-null-assertion -- the tests look up what they just built */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Clock } from '@otheater/core';
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
import { SPAN_NAME } from '../telemetry/span-conventions.js';
import { MemoryTelemetryStore } from '../telemetry/telemetry-fixture.js';
import { AnalysisConfigSchema } from './analysis-config.js';
import { AnalysisService } from './analysis-service.js';

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

/** The day of the frozen clock of the fixture (2026-01-01 UTC): the whole play happens in it. */
const DAY = '2026-01-01';

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

async function finishedPlay(
  harness: PlayHarness,
  telemetry: MemoryTelemetryStore,
): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, '#ot-play write alpha and beta #outcome:approved');
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  await waitFor(
    'DONE',
    async () => (await harness.daemon.store.plays.get(play.id))?.state === 'DONE',
  );
  await waitFor('the play span', async () => {
    const all = await telemetry.readSpans();
    return all.some((span) => span.name === SPAN_NAME.play) ? all : undefined;
  });
  await telemetry.flush();
  return play.id;
}

describeWithLauncher(
  'the analysis of a play with the fake agent (P9)',
  { timeout: 120_000 },
  () => {
    it('shows the stages and attempts of the play, a client without telemetry as a gap, and the same day when built again', async () => {
      const telemetry = new MemoryTelemetryStore();
      await withPlayDaemon(fakes(), { telemetry }, async (harness) => {
        const playId = await finishedPlay(harness, telemetry);
        const service = new AnalysisService({
          clock: new FakeClock(Date.UTC(2026, 0, 3, 12, 0, 0)),
          telemetry,
          events: harness.daemon.store.events,
          usage: harness.daemon.store.usage,
          settings: () => AnalysisConfigSchema.parse({ day_boundary: 'utc' }),
          situations: { record: () => undefined },
          logger: { warn: () => undefined, info: () => undefined },
        });

        // The schedule builds the days up to yesterday, so the day of the play is built by it.
        await service.catchUp();
        expect(await service.readyThrough()).toBe('2026-01-02');
        const first = await service.report({ from: DAY, to: DAY, groupBy: 'role' });

        // The stages are the states of the machine the play went through.
        const path = await harness.pathOf(playId);
        const { summary } = first.period;
        for (const state of new Set(path.slice(0, -1))) {
          const stat = summary.stages[state];
          expect(stat, `the stage ${state}`).toBeDefined();
          expect(stat!.count).toBeGreaterThanOrEqual(1);
          expect(stat!.sumMs).toBeGreaterThan(0);
        }
        expect(summary.attempts.total).toBeGreaterThanOrEqual(7);
        expect(summary.rejections).toBe(0);
        expect(first.groups.length).toBeGreaterThan(1);

        // The fake agent exports no telemetry of its own: partial coverage, never a zero.
        expect(summary.coverage.attempts).toBe(summary.attempts.total);
        expect(summary.coverage.attemptsWithClientTelemetry).toBe(0);
        expect(summary.coverage.attemptCoverage).toBe(0);
        expect(summary.tokens.input === null || summary.tokens.input >= 0).toBe(true);
        if (summary.coverage.usageTurns === 0) {
          expect(summary.tokens.input).toBeNull();
          expect(summary.cost.realUsd).toBeNull();
          expect(summary.coverage.tokenCoverage).toBeNull();
        }

        // Building the same day again gives the same aggregates, row by row.
        const rowsBefore = await telemetry.readRollups({ fromDay: DAY, toDay: DAY });
        expect(rowsBefore.length).toBeGreaterThan(0);
        await service.aggregateDay(DAY);
        await service.aggregateDay(DAY);
        expect(await telemetry.readRollups({ fromDay: DAY, toDay: DAY })).toEqual(rowsBefore);
        expect(await service.report({ from: DAY, to: DAY, groupBy: 'role' })).toEqual(first);
      });
    });
  },
);
