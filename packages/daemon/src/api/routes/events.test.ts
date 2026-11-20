// SPDX-License-Identifier: MPL-2.0
import { FakeClock, InMemoryStore } from '@otheater/core/testing';
import type { DaemonId } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../config.js';
import { createEventHub } from '../../events/event-hub.js';
import { createSilentLogger } from '../../logger.js';
import { RecordingSituations } from '../../test-helpers.js';
import { ApiFailure, ApiHandlers } from '../handlers.js';
import { SseReader } from '../sse-reader-fixture.js';
import { cursorFrame, eventFrame, registerEventRoutes, retryFrame } from './events.js';

/** The handler of `streamEvents` on its own, over a real hub and the in-memory store (P4 of docs/17). */

const DAEMON_ID = '3f2b8a52-6a9a-4a0e-9c7e-7d3e0f6a1b11' as DaemonId;

function setup(yaml = '') {
  const clock = new FakeClock();
  const memory = new InMemoryStore({ clock });
  const config = parseConfig(`backup:\n  when: manual\n${yaml}`).api.sse;
  const hub = createEventHub(memory, {
    bufferEvents: config.buffer_events,
    logger: createSilentLogger(),
  });
  const handlers = new ApiHandlers();
  const situations = new RecordingSituations();
  const rotation: (() => void)[] = [];
  const streams = registerEventRoutes({
    handlers,
    onTokenRotated: (listener) => {
      rotation.push(listener);
      return () => undefined;
    },
    daemonId: DAEMON_ID,
    hub,
    lastId: () => hub.store.events.lastId(),
    clock,
    config,
    logger: createSilentLogger(),
    situations,
  });
  const controllers: AbortController[] = [];
  const call = async (
    query: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    const controller = new AbortController();
    controllers.push(controller);
    const entry = handlers.get('streamEvents');
    if (entry === undefined) throw new Error('no handler');
    const result = await entry.handler({
      params: undefined,
      query,
      headers,
      body: undefined,
      request: new Request('http://127.0.0.1/v1/events'),
      signal: controller.signal,
    });
    if (!(result instanceof Response)) throw new Error('not a Response');
    return result;
  };
  const write = async (n: number, scenarioId = 'S1'): Promise<number> =>
    (
      await hub.store.events.append({
        type: 'test.tick',
        schemaVersion: 1,
        payload: { n },
        scenarioId,
      })
    ).id;
  const readerOf = (response: Response): SseReader =>
    new SseReader(response.body ?? new ReadableStream());
  return {
    clock,
    hub,
    handlers,
    situations,
    rotation,
    streams,
    call,
    write,
    readerOf,
    controllers,
  };
}

describe('the frames', () => {
  it('writes the id of the log, the type and the whole envelope', () => {
    const frame = eventFrame(
      {
        id: 7,
        at: 1000,
        type: 'play.created',
        schemaVersion: 1,
        payload: { text: 'a\nb' },
        scenarioId: 'S1',
      } as never,
      DAEMON_ID,
    );
    expect(frame).toMatch(/^id: 7\nevent: play\.created\ndata: \{.*\}\n\n$/);
    // A newline of the payload is escaped inside the JSON, so the frame never breaks in the middle.
    expect(frame.split('\n')).toHaveLength(5);
    expect(JSON.parse(frame.split('\n')[2]?.slice(6) ?? '')).toMatchObject({
      id: 7,
      daemonId: DAEMON_ID,
      payload: { text: 'a\nb' },
    });
    expect(cursorFrame(12)).toBe('id: 12\n\n');
    expect(retryFrame(2000)).toBe('retry: 2000\n\n');
  });
});

describe('streamEvents handler', () => {
  it('answers a Response of text/event-stream and counts the open streams', async () => {
    const { call, streams, controllers } = setup();
    const response = await call();
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(streams.openCount()).toBe(1);
    controllers[0]?.abort();
    for (let i = 0; i < 20 && streams.openCount() > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(streams.openCount()).toBe(0);
  });

  it('refuses above the ceiling with unavailable, Retry-After and the ceiling in the details', async () => {
    const { call, streams } = setup('api:\n  sse:\n    max_streams: 1\n    retry: 3500ms\n');
    await call();
    const refused = await call().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiFailure);
    expect(refused).toMatchObject({
      code: 'unavailable',
      details: { maxStreams: 1 },
      headers: { 'retry-after': '4' },
    });
    expect(streams.openCount()).toBe(1);
  });

  it('does not let a burst of requests pass the ceiling', async () => {
    const { call, streams } = setup('api:\n  sse:\n    max_streams: 3\n');
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => call()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(7);
    expect(streams.openCount()).toBe(3);
  });

  it('closes every stream when the token is rotated', async () => {
    const { call, rotation, readerOf, streams } = setup();
    const a = readerOf(await call());
    const b = readerOf(await call());
    await a.next();
    await b.next();
    for (const listener of rotation) listener();
    expect(await a.endsWithin()).toBe(true);
    expect(await b.endsWithin()).toBe(true);
    expect(streams.openCount()).toBe(0);
  });

  it('ends the stream when the hub closes', async () => {
    const { call, hub, readerOf } = setup();
    const reader = readerOf(await call());
    await reader.next();
    hub.close();
    expect(await reader.endsWithin()).toBe(true);
  });

  it('holds a client that does not read: the memory stays bounded, the log keeps the rest, and the events come once it reads', async () => {
    const { call, write, readerOf, situations, hub } = setup(
      'api:\n  sse:\n    buffer_events: 5\n',
    );
    const response = await call({ since: 0 });
    // Nobody reads: the stream fills its queue and the writer waits.
    const ids: number[] = [];
    for (let n = 0; n < 200; n += 1) ids.push(await write(n));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hub.subscriberCount).toBe(1);

    const lagged = situations.recorded.filter((item) => item.type === 'api.stream_lagged');
    expect(lagged.map((item) => (item.payload as { reason: string }).reason).sort()).toEqual([
      'backpressure',
      'buffer_overflow',
    ]);
    for (const item of lagged) {
      expect(item.payload).toMatchObject({ suppressed: 0 });
      expect((item.payload as { behind: number }).behind).toBeGreaterThan(0);
    }

    // The client comes back and reads all of it: no event lost, none repeated, same stream.
    const reader = readerOf(response);
    expect((await reader.next())?.retry).toBe(2000);
    const received: number[] = [];
    while (received.length < ids.length) {
      const [frame] = await reader.events(1);
      received.push(Number(frame?.id));
    }
    expect(received).toEqual(ids);
    // Still one episode per reason: the rate limit keeps the log of events short.
    expect(situations.of('api.stream_lagged')).toHaveLength(2);
    await reader.close();
  });

  it('rate-limits api.stream_lagged per reason on the clock, and counts what it held back', async () => {
    const { call, write, clock, situations } = setup(
      'api:\n  sse:\n    buffer_events: 2\n    lagged_events:\n      every: 30s\n',
    );
    const overflow = (): unknown[] =>
      situations
        .of('api.stream_lagged')
        .filter((p) => (p as { reason: string }).reason === 'buffer_overflow');
    await call({ since: 0 });
    for (let n = 0; n < 10; n += 1) await write(n);
    await call({ since: 0 });
    for (let n = 0; n < 10; n += 1) await write(n);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Two streams overflowed in the same window: one event, one held back.
    expect(overflow()).toHaveLength(1);
    await clock.advance(31_000);
    await call({ since: 0 });
    for (let n = 0; n < 10; n += 1) await write(n);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const all = overflow();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.at(-1)).toMatchObject({ reason: 'buffer_overflow' });
    expect((all.at(-1) as { suppressed: number }).suppressed).toBeGreaterThanOrEqual(1);
  });
});

describe('the keys api.sse.*', () => {
  it('have the proposed defaults', () => {
    expect(parseConfig('').api.sse).toEqual({
      buffer_events: 1000,
      heartbeat: 15_000,
      retry: 2000,
      max_streams: 32,
      lagged_events: { every: 10_000 },
    });
  });

  it('take a duration, 0 for no heartbeat, and refuse what makes no sense', () => {
    expect(parseConfig('api:\n  sse:\n    heartbeat: 0\n').api.sse.heartbeat).toBe(0);
    expect(parseConfig('api:\n  sse:\n    heartbeat: 1m\n').api.sse.heartbeat).toBe(60_000);
    expect(() => parseConfig('api:\n  sse:\n    retry: 0\n')).toThrow();
    expect(() => parseConfig('api:\n  sse:\n    max_streams: 0\n')).toThrow();
    expect(() => parseConfig('api:\n  sse:\n    heartbeat: soon\n')).toThrow();
    expect(() => parseConfig('api:\n  sse:\n    lagged_events:\n      often: 1\n')).toThrow();
  });
});
