// SPDX-License-Identifier: MPL-2.0
/* eslint-disable @typescript-eslint/no-non-null-assertion -- the tests look up what they just built */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Clock, EventEnvelope, TelemetrySpan } from '@otheater/core';
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
import { DaemonSpans } from './daemon-spans.js';
import { OT, SPAN_NAME } from './span-conventions.js';
import { attemptSpanId, playSpanId, sessionSpanId, traceIdForPlay } from './span-ids.js';
import { MemoryTelemetryStore } from './telemetry-fixture.js';

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

async function openPlay(harness: PlayHarness): Promise<string> {
  const scenarioId = await harness.openChat();
  await harness.producer.send(scenarioId, '#ot-play write alpha and beta #outcome:approved');
  const play = await waitFor('the play to exist', async () => (await harness.plays(scenarioId))[0]);
  return play.id;
}

/** The ids, times and names of the spans the log decides. */
function shape(spans: readonly TelemetrySpan[]): string[] {
  return spans
    .map(
      (span) =>
        `${span.traceId}/${span.spanId}<-${span.parentSpanId ?? '-'} ${span.name} ` +
        `${String(span.startTimeUnixNano)}-${String(span.endTimeUnixNano)}`,
    )
    .sort();
}

/** Projects the whole log of the daemon again, on a telemetry base that is new. */
async function projectAgain(harness: PlayHarness): Promise<MemoryTelemetryStore> {
  const events: readonly EventEnvelope[] = await harness.daemon.store.events.readFrom(0, 100_000);
  const memory = {
    events,
    lastId: () => Promise.resolve(events.at(-1)?.id ?? 0),

    follow: async function* (options: { afterId?: number; signal?: AbortSignal }) {
      for (const event of events) if (event.id > (options.afterId ?? 0)) yield event;
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        ),
      );
    },
  };
  const fresh = new MemoryTelemetryStore();
  const again = new DaemonSpans({
    telemetry: fresh,
    hub: memory,
    events: memory,
    clock: new FakeClock(),
    logger: { warn: () => undefined, debug: () => undefined },
    waits: 'all',
  });
  again.start();
  await again.settle();
  await again.stop();
  await fresh.flush();
  return fresh;
}

describeWithLauncher('the spans of a play with the fake agent (P4)', { timeout: 120_000 }, () => {
  it('leaves the whole tree with the right parents and coherent times, and the same one when projected again', async () => {
    const telemetry = new MemoryTelemetryStore();
    await withPlayDaemon(fakes(), { telemetry }, async (harness) => {
      const playId = await openPlay(harness);
      await waitFor(
        'DONE',
        async () => (await harness.daemon.store.plays.get(playId))?.state === 'DONE',
      );
      const spans = await waitFor('the play span', async () => {
        const all = await telemetry.readSpans();
        return all.some((span) => span.name === SPAN_NAME.play) ? all : undefined;
      });
      const byId = new Map(spans.map((span) => [span.spanId, span]));
      const play = spans.find((span) => span.name === SPAN_NAME.play)!;
      expect(play.spanId).toBe(playSpanId(playId));
      expect(play.parentSpanId).toBeNull();
      expect(play.attributes[OT.playFinalState]).toBe('DONE');

      // One trace for the play; the only span outside it is a wait of the queue of prompts.
      const inTrace = spans.filter((span) => span.traceId === traceIdForPlay(playId));
      const outside = spans.filter((span) => span.traceId !== traceIdForPlay(playId));
      expect(outside.every((span) => span.name === SPAN_NAME.wait)).toBe(true);

      for (const span of inTrace) {
        expect(span.endTimeUnixNano).toBeGreaterThanOrEqual(span.startTimeUnixNano);
        expect(span.attributes[OT.playId]).toBe(playId);
        if (span.parentSpanId === null) continue;
        const parent = byId.get(span.parentSpanId);
        expect(parent, `the parent of ${span.name}`).toBeDefined();
        if (parent === undefined) continue;
        expect(span.startTimeUnixNano).toBeGreaterThanOrEqual(parent.startTimeUnixNano);
        expect(span.endTimeUnixNano).toBeLessThanOrEqual(parent.endTimeUnixNano);
      }

      // The stages are the states of the machine, in the order it went through them.
      const stages = inTrace
        .filter((span) => span.name === SPAN_NAME.stage)
        .sort((a, b) => Number(a.startTimeUnixNano - b.startTimeUnixNano));
      const path = await harness.pathOf(playId);
      expect(stages.map((stage) => stage.attributes[OT.stage])).toEqual([
        'NEED',
        ...path.slice(0, -1),
      ]);
      for (const stage of stages) expect(stage.parentSpanId).toBe(play.spanId);
      expect(new Set(stages.map((stage) => stage.spanId)).size).toBe(stages.length);

      // Each attempt hangs from a stage, its session from the attempt, and times are not all equal.
      const attempts = inTrace.filter(
        (span) =>
          span.name.startsWith('invoke_agent') && span.attributes[OT.sessionId] === undefined,
      );
      expect(attempts.length).toBeGreaterThanOrEqual(7);
      for (const attempt of attempts) {
        const attemptId = attempt.attributes[OT.attemptId] as string;
        expect(attempt.spanId).toBe(attemptSpanId(attemptId));
        expect(byId.get(attempt.parentSpanId ?? '')?.name).toBe(SPAN_NAME.stage);
        expect(attempt.endTimeUnixNano).toBeGreaterThan(attempt.startTimeUnixNano);
        expect(attempt.attributes[OT.role]).toBeTypeOf('string');
        expect(attempt.attributes[OT.profile]).toBe('one');
        expect(attempt.attributes[OT.client]).toBe('fake');
      }
      // The fake agent numbers its sessions from 1 in every process, so they share one id and
      // one span (the base keeps the first): what counts is how that one hangs.
      const sessions = inTrace.filter(
        (span) =>
          span.name.startsWith('invoke_agent') && span.attributes[OT.sessionId] !== undefined,
      );
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      for (const span of sessions) {
        expect(span.spanId).toBe(sessionSpanId(span.attributes[OT.sessionId] as string));
        expect(byId.get(span.parentSpanId ?? '')?.attributes[OT.attemptId]).toBe(
          span.attributes[OT.attemptId],
        );
      }
      expect(new Set(inTrace.map((span) => span.endTimeUnixNano)).size).toBeGreaterThan(5);
      // Nothing was left open for the end of the play to close.
      expect(inTrace.filter((span) => span.attributes[OT.closedBy] !== undefined)).toEqual([]);

      // Projecting the log again, on a base that is new, gives the same spans.
      const fresh = await projectAgain(harness);
      expect(shape(await fresh.readSpans())).toEqual(shape(spans));
      await fresh.close();
    });
  });

  it('tells the wait of the prompt for the Director as events and as otheater.wait, and gets the same span back on a new base', async () => {
    const telemetry = new MemoryTelemetryStore();
    // The threshold is `always` so that the wait of the frozen clock is told at all.
    await withPlayDaemon(
      fakes(),
      { telemetry, extra: 'events:\n  wait_threshold: always' },
      async (harness) => {
        await openPlay(harness);
        const waits = await waitFor('the wait of the prompt', async () => {
          const found = (await telemetry.readSpans()).filter(
            (span) =>
              span.name === SPAN_NAME.wait && span.attributes[OT.waitKind] === 'prompt_queue',
          );
          return found.length > 0 ? found : undefined;
        });
        expect(waits[0]?.attributes).toMatchObject({
          [OT.waitOrigin]: 'log',
          [OT.waitOutcome]: 'delivered',
        });
        expect(waits[0]?.attributes[OT.waitReason]).toBeTypeOf('string');

        const events = await harness.daemon.store.events.readFrom(0, 100_000);
        const started = events.filter((event) => event.type === 'wait.started');
        const ended = events.filter((event) => event.type === 'wait.ended');
        expect(started.length).toBeGreaterThanOrEqual(1);
        expect(started[0]?.payload).toMatchObject({ kind: 'prompt_queue', thresholdMs: 0 });
        expect(ended.map((event) => event.payload.waitId)).toContain(started[0]?.payload.waitId);

        await telemetry.flush();
        const fresh = await projectAgain(harness);
        const waitsOf = (list: readonly TelemetrySpan[]): string[] =>
          shape(list.filter((span) => span.name === SPAN_NAME.wait));
        expect(waitsOf(await fresh.readSpans())).toEqual(waitsOf(await telemetry.readSpans()));
        await fresh.close();
      },
    );
  });
});
