// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import type { EventEnvelope, JsonValue, TelemetrySpan, TelemetryStore } from '@otheater/core';
import { FakeClock } from '@otheater/core/testing';
import { DAEMON_SPANS_CURSOR, DaemonSpans, RETRY_AFTER_MS } from './daemon-spans.js';
import { OT, SPAN_NAME, WAIT_KIND } from './span-conventions.js';
import { MemoryTelemetryStore } from './telemetry-fixture.js';

const T0 = 1_800_000_000_000;
const EXECUTOR = { client: 'fake', profile: 'one', model: 'fake-model' };
const PLAY = { playId: 'p1', scenarioId: 's1' };
const ATTEMPT = { ...PLAY, attemptId: 'p1/alpha/1' };

/** The event log and the hub in memory: history first, then what is appended, until aborted. */
class MemoryLog {
  readonly events: EventEnvelope[] = [];
  #wake: (() => void) | undefined;

  append(
    type: string,
    payload: Record<string, JsonValue>,
    ids: { playId?: string; attemptId?: string; scenarioId?: string } = {},
  ): void {
    const id = this.events.length + 1;
    this.events.push({ id, timestamp: T0 + id * 10, type, payload, ...ids } as EventEnvelope);
    this.#wake?.();
  }

  lastId(): Promise<number> {
    return Promise.resolve(this.events.at(-1)?.id ?? 0);
  }

  async *follow(options: {
    afterId?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<EventEnvelope> {
    let cursor = options.afterId ?? 0;
    for (;;) {
      if (options.signal?.aborted === true) return;
      const next = this.events.find((event) => event.id > cursor);
      if (next !== undefined) {
        cursor = next.id;
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.#wake = undefined;
          options.signal?.removeEventListener('abort', done);
          resolve();
        };
        this.#wake = done;
        options.signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
}

/** A play with an attempt, a session and a tool call, then the quota wait of a second attempt. */
function fillLog(log: MemoryLog): void {
  log.append('play.created', { flowId: 'play' }, PLAY);
  log.append('play.transitioned', { event: 'START', from: 'NEED', to: 'EXECUTING' }, PLAY);
  log.append('executor.selected', { outcome: 'selected', role: 'actor', executor: EXECUTOR }, PLAY);
  log.append('session.opened', { sessionId: 'sess-1', executor: EXECUTOR }, ATTEMPT);
  log.append('tool.called', { callId: 'c1', tool: 'submit', role: 'actor' }, ATTEMPT);
  log.append('tool.finished', { callId: 'c1', outcome: 'ok', durationMs: 5, queuedMs: 0 }, ATTEMPT);
  log.append('attempt.submitted', {}, ATTEMPT);
  log.append('session.closed', { sessionId: 'sess-1', reason: 'completed' }, ATTEMPT);
}

function finishPlay(log: MemoryLog): void {
  log.append('play.transitioned', { event: 'DONE', from: 'EXECUTING', to: 'DONE' }, PLAY);
}

interface Rig {
  readonly clock: FakeClock;
  open(): MemoryTelemetryStore;
}

function makeRig(): Rig {
  const clock = new FakeClock();
  const store = new MemoryTelemetryStore();
  return { clock, open: () => store };
}

function spansOf(
  telemetry: TelemetryStore,
  clock: FakeClock,
  log: MemoryLog,
  over: Partial<ConstructorParameters<typeof DaemonSpans>[0]> = {},
): DaemonSpans {
  return new DaemonSpans({
    telemetry,
    hub: log,
    events: log,
    clock,
    logger: { warn: () => undefined, debug: () => undefined },
    waits: 'all',
    ...over,
  });
}

/** What a projection of the log means, whatever the order the base returned it in. */
function shape(spans: readonly TelemetrySpan[]): string[] {
  return spans
    .filter((span) => span.attributes[OT.waitOrigin] !== 'direct')
    .map(
      (span) =>
        `${span.traceId}/${span.spanId}<-${span.parentSpanId ?? '-'} ${span.name} ` +
        `${String(span.startTimeUnixNano)}-${String(span.endTimeUnixNano)}`,
    )
    .sort();
}

describe('the projector of the spans of the daemon (P4)', () => {
  it('writes the spans of a log it finds, and the ones of what is appended after', async () => {
    const rig = makeRig();
    const telemetry = rig.open();
    const log = new MemoryLog();
    fillLog(log);
    const spans = spansOf(telemetry, rig.clock, log);
    spans.start();
    await spans.settle();
    // The stage NEED, the session and the call closed; the play, the stage and the attempt did not.
    expect((await telemetry.readSpans()).map((span) => span.name).sort()).toEqual(
      [
        SPAN_NAME.stage,
        SPAN_NAME.invokeAgent('actor'),
        SPAN_NAME.invokeAgent('actor'),
        SPAN_NAME.executeTool('submit'),
      ].sort(),
    );
    finishPlay(log);
    await spans.settle();
    const all = await telemetry.readSpans();
    expect(all.filter((span) => span.name === SPAN_NAME.play)).toHaveLength(1);
    expect(spans.openSpans).toBe(0);
    expect(await telemetry.readCursor(DAEMON_SPANS_CURSOR)).toBe(log.events.length);
    await spans.stop();
  });

  it('gives the same spans after the base is deleted and the log is read again', async () => {
    const rig = makeRig();
    const log = new MemoryLog();
    fillLog(log);
    finishPlay(log);
    const first = rig.open();
    const one = spansOf(first, rig.clock, log);
    one.start();
    await one.settle();
    await one.stop();
    const before = shape(await first.readSpans());
    expect(before.length).toBeGreaterThan(5);
    // The base is deleted and made again: empty, no cursor.
    first.reset();
    const second = first;
    expect(await second.readCursor(DAEMON_SPANS_CURSOR)).toBeNull();
    const two = spansOf(second, rig.clock, log);
    two.start();
    await two.settle();
    await two.stop();
    expect(shape(await second.readSpans())).toEqual(before);
  });

  it('writes nothing twice when it starts again on a base that has the cursor, or when asked to reproject', async () => {
    const rig = makeRig();
    const log = new MemoryLog();
    fillLog(log);
    const telemetry = rig.open();
    const one = spansOf(telemetry, rig.clock, log);
    one.start();
    await one.settle();
    await one.stop();
    const open = await telemetry.readCursor(DAEMON_SPANS_CURSOR);
    // The play is still open: the cursor stays before the oldest open span, not at the last event.
    expect(open).toBe(0);
    const count = (await telemetry.readSpans()).length;

    const two = spansOf(telemetry, rig.clock, log);
    two.start();
    await two.settle();
    two.reproject();
    await two.settle();
    finishPlay(log);
    await two.settle();
    await two.stop();
    const all = await telemetry.readSpans();
    expect(new Set(all.map((span) => `${span.traceId}/${span.spanId}`)).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(count);
    expect(await telemetry.readCursor(DAEMON_SPANS_CURSOR)).toBe(log.events.length);
  });

  it('records the waits of the places that wait only with waits: all, and drops the ones of the log with off', async () => {
    const wait = {
      kind: WAIT_KIND.promptQueue,
      key: 'prompt-1',
      startMs: T0,
      endMs: T0 + 20,
      reason: 'queued',
      outcome: 'delivered',
      correlation: { scenarioId: 's1' },
    } as const;
    for (const mode of ['all', 'log', 'off'] as const) {
      const rig = makeRig();
      const telemetry = rig.open();
      const log = new MemoryLog();
      const spans = spansOf(telemetry, rig.clock, log, { waits: mode });
      spans.recordWait(wait);
      await telemetry.flush();
      const direct = (await telemetry.readSpans()).filter((span) => span.name === SPAN_NAME.wait);
      expect(direct.length).toBe(mode === 'all' ? 1 : 0);
    }

    const log = new MemoryLog();
    log.append('play.created', { flowId: 'play' }, PLAY);
    log.append('session.opened', { sessionId: 'q', executor: EXECUTOR }, ATTEMPT);
    log.append(
      'attempt.reset_wait_started',
      { executor: EXECUTOR, cause: 'quota_exhausted' },
      ATTEMPT,
    );
    log.append('attempt.reset_wait_ended', { outcome: 'resumed', waitedMs: 10 }, ATTEMPT);
    for (const mode of ['log', 'off'] as const) {
      const other = makeRig();
      const store = other.open();
      const spans = spansOf(store, other.clock, log, { waits: mode });
      spans.start();
      await spans.settle();
      await spans.stop();
      const waits = (await store.readSpans()).filter((span) => span.name === SPAN_NAME.wait);
      expect(waits.length).toBe(mode === 'log' ? 1 : 0);
    }
  });

  it('tells a failure once as a situation and tries again after a while', async () => {
    const rig = makeRig();
    const real = rig.open();
    let failing = true;
    const telemetry = new Proxy(real, {
      get(target, key) {
        if (key === 'readCursor') {
          return (name: string) =>
            failing ? Promise.reject(new Error('the base is away')) : target.readCursor(name);
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    }) as TelemetryStore;
    const notices: unknown[] = [];
    const log = new MemoryLog();
    fillLog(log);
    finishPlay(log);
    const spans = spansOf(telemetry, rig.clock, log, {
      situations: {
        record: (type, payload) => {
          notices.push({ type, payload });
        },
      },
    });
    spans.start();
    await waitUntil(() => notices.length === 1);
    await rig.clock.advance(RETRY_AFTER_MS);
    await waitUntil(() => rig.clock.pendingSleeps === 1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      type: 'daemon.notice',
      payload: { kind: 'daemon_spans_failed', subject: 'read' },
    });
    failing = false;
    await rig.clock.advance(RETRY_AFTER_MS);
    await spans.settle();
    expect((await real.readSpans()).some((span) => span.name === SPAN_NAME.play)).toBe(true);
    await spans.stop();
  });

  it('starts again from the first event when the base is recreated while it runs', async () => {
    const rig = makeRig();
    const log = new MemoryLog();
    fillLog(log);
    const real = rig.open();
    let resets = (await real.health()).resets;
    const telemetry = new Proxy(real, {
      get(target, key) {
        if (key === 'health') {
          return async () => ({ ...(await target.health()), resets });
        }
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    }) as TelemetryStore;
    const spans = spansOf(telemetry, rig.clock, log);
    spans.start();
    await spans.settle();
    const first = (await real.readSpans()).length;
    // The base was replaced behind its back: the cursor says "read", the base holds nothing.
    resets += 1;
    finishPlay(log);
    await spans.settle();
    await waitUntil(async () =>
      (await real.readSpans()).some((span) => span.name === SPAN_NAME.play),
    );
    expect((await real.readSpans()).length).toBeGreaterThan(first);
    expect(await real.readCursor(DAEMON_SPANS_CURSOR)).toBe(log.events.length);
    await spans.stop();
  });
});

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const limit = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > limit) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
