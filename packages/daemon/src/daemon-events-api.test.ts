// SPDX-License-Identifier: MPL-2.0
import { readFile } from 'node:fs/promises';
import { FakeClock, InMemorySecretVault, InMemoryStore } from '@otheater/core/testing';
import { buildDaemonEvent } from '@otheater/protocol';
import { describe, expect, it } from 'vitest';
import { frameData, SseReader, type SseFrame } from './api/sse-reader-fixture.js';
import { parseConfig } from './config.js';
import { startDaemon, type DaemonHandle } from './daemon.js';
import { createSilentLogger } from './logger.js';
import { dataPaths } from './paths.js';
import { makeTempDataDir, NO_CLIENTS } from './test-helpers.js';

/** `GET /v1/events` against the daemon with the fake clock and the in-memory store (P4 of docs/17). */

const BASE = 'backup:\n  when: manual\n';

interface Fixture {
  readonly daemon: DaemonHandle;
  readonly clock: FakeClock;
  readonly token: string;
  readonly dir: string;
  readonly open: (options?: {
    query?: string;
    lastEventId?: string;
    token?: string;
  }) => Promise<{ response: Response; reader: SseReader }>;
  /** Appends a `daemon.notice` (or a `recovery.notice`) of a scenario to the log. */
  readonly write: (
    scenarioId: string | undefined,
    n: number,
    type?: 'daemon' | 'recovery',
  ) => Promise<number>;
}

async function withDaemon(
  yamlExtra: string,
  body: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const tmp = await makeTempDataDir();
  const clock = new FakeClock();
  let daemon: DaemonHandle | undefined;
  const readers: SseReader[] = [];
  try {
    daemon = await startDaemon({
      dataDir: tmp.dir,
      clientSearch: NO_CLIENTS,
      config: parseConfig(BASE + yamlExtra),
      overrides: {
        clock,
        vault: new InMemorySecretVault(),
        store: new InMemoryStore({ clock }),
      },
      logger: createSilentLogger(),
      version: '0.0.0-test',
    });
    const running = daemon;
    const token = (await readFile(dataPaths(tmp.dir).apiToken, 'utf8')).trim();
    await body({
      daemon: running,
      clock,
      token,
      dir: tmp.dir,
      open: async (options = {}) => {
        const response = await fetch(`${running.api.url}/v1/events${options.query ?? ''}`, {
          headers: {
            authorization: `Bearer ${options.token ?? token}`,
            ...(options.lastEventId === undefined ? {} : { 'last-event-id': options.lastEventId }),
          },
        });
        const reader = new SseReader(
          response.ok && response.body !== null ? response.body : new ReadableStream(),
        );
        readers.push(reader);
        return { response, reader };
      },
      write: async (scenarioId, n, type = 'daemon') => {
        const base =
          type === 'daemon'
            ? buildDaemonEvent('daemon.notice', {
                kind: 'client_warning',
                subject: `n${String(n)}`,
                detail: null,
              })
            : buildDaemonEvent('recovery.notice', {
                kind: 'backup_rotation_failed',
                subject: `n${String(n)}`,
                detail: null,
              });
        const stored = await running.store.events.append({
          ...base,
          ...(scenarioId === undefined ? {} : { scenarioId }),
        });
        return stored.id;
      },
    });
  } finally {
    for (const reader of readers) await reader.close();
    await daemon?.stop('shutdown').catch(() => undefined);
    await tmp.dispose();
  }
}

const idOf = (frame: SseFrame): number => Number(frame.id);

/** A value that must exist, failing loudly instead of a non-null assertion. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

/** The item at an index, failing loudly instead of a non-null assertion. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at index ${String(index)}`);
  return item;
}

/** Reads frames until one with the event id `target` was read; returns the ids of the events. */
async function readUntil(reader: SseReader, target: number): Promise<number[]> {
  const ids: number[] = [];
  for (;;) {
    const frame = await reader.next(10_000);
    if (frame === undefined) throw new Error('the stream ended');
    if (frame.data === undefined) continue;
    ids.push(idOf(frame));
    if (idOf(frame) >= target) return ids;
  }
}

describe('GET /v1/events', () => {
  it('answers 401 without a token and with a wrong one', async () => {
    await withDaemon('', async ({ daemon, open }) => {
      expect((await fetch(`${daemon.api.url}/v1/events`)).status).toBe(401);
      const wrong = await open({ token: 'not-the-token' });
      expect(wrong.response.status).toBe(401);
    });
  });

  it('opens with retry, then a frame with only the id of the newest event, then the live ones', async () => {
    await withDaemon('', async ({ daemon, open, write }) => {
      const head = await daemon.store.events.lastId();
      expect(head).toBeGreaterThan(0);
      const { response, reader } = await open();
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(await reader.next()).toMatchObject({ retry: 2000, comments: [] });
      const cursor = await reader.next();
      expect(cursor).toEqual({ id: String(head), comments: [] });
      expect(cursor?.data).toBeUndefined();
      expect(cursor?.event).toBeUndefined();

      const id = await write('S1', 1);
      const [live] = await reader.events(1);
      expect(live).toMatchObject({ id: String(id), event: 'daemon.notice' });
      const envelope = frameData(required(live));
      expect(envelope).toMatchObject({
        id,
        type: 'daemon.notice',
        scenarioId: 'S1',
        daemonId: daemon.daemonId,
      });
    });
  });

  it('does not write the cursor frame when the client brings its own cursor', async () => {
    await withDaemon('', async ({ daemon, open, write }) => {
      const head = await daemon.store.events.lastId();
      const id = await write(undefined, 1);
      const { reader } = await open({ lastEventId: String(head) });
      expect((await reader.next())?.retry).toBe(2000);
      const next = await reader.next();
      expect(next).toMatchObject({ id: String(id), event: 'daemon.notice' });
    });
  });

  it('resumes after a stream that dropped in the middle of a play: every later event once', async () => {
    await withDaemon('', async ({ daemon, open, write }) => {
      const head = await daemon.store.events.lastId();
      const first = await open();
      await first.reader.next(); // retry
      await first.reader.next(); // cursor
      const written: number[] = [];
      for (let n = 1; n <= 10; n += 1) written.push(await write('S1', n));
      const seen = await first.reader.events(4);
      const lastSeen = idOf(at(seen, 3));
      expect(lastSeen).toBe(written[3]);
      // The connection drops in the middle of the play; more events come while the client is away.
      await first.reader.close();
      for (let n = 11; n <= 15; n += 1) written.push(await write('S1', n));

      const second = await open({ lastEventId: String(lastSeen) });
      const rest = await readUntil(second.reader, at(written, 14));
      expect(rest).toEqual(written.slice(4));
      // And the live part goes on after the history, with no repetition.
      const live = await write('S1', 16);
      expect(await readUntil(second.reader, live)).toEqual([live]);
      expect(head).toBeLessThan(at(written, 0));
    });
  });

  it('lets Last-Event-ID win over since', async () => {
    await withDaemon('', async ({ open, write }) => {
      const ids: number[] = [];
      for (let n = 1; n <= 6; n += 1) ids.push(await write('S1', n));
      const header = await open({ query: `?since=${String(ids[0])}`, lastEventId: String(ids[3]) });
      expect(await readUntil(header.reader, at(ids, 5))).toEqual(ids.slice(4));
      const since = await open({ query: `?since=${String(ids[1])}` });
      expect(await readUntil(since.reader, at(ids, 5))).toEqual(ids.slice(2));
      // Not a number: 400 in the format of the contract, never a silent restart.
      const bad = await open({ lastEventId: 'abc' });
      expect(bad.response.status).toBe(400);
      expect(await bad.response.json()).toMatchObject({ error: { code: 'invalid_input' } });
    });
  });

  it('moves a cursor that is ahead of the log back to the newest event and says so', async () => {
    await withDaemon('', async ({ daemon, open, write }) => {
      const head = await daemon.store.events.lastId();
      const { reader } = await open({ lastEventId: String(head + 1000) });
      expect((await reader.next())?.retry).toBe(2000);
      expect(await reader.next()).toEqual({ id: String(head), comments: [] });
      const id = await write(undefined, 1);
      expect(await readUntil(reader, id)).toEqual([id]);
    });
  });

  it('with a thousand events written while the history turns live, none is missing or repeated', async () => {
    await withDaemon('', async ({ daemon, open, write }) => {
      for (let n = 0; n < 300; n += 1) await write('S1', n);
      const { reader } = await open({ lastEventId: '0' });
      // A thousand writes, concurrent with the reading of the history.
      const writes = Promise.all(Array.from({ length: 1000 }, (_, n) => write('S1', 300 + n)));
      const head = (await writes).reduce((a, b) => Math.max(a, b), 0);
      const received = await readUntil(reader, head);
      const log = (await daemon.store.events.readFrom(0, 10_000)).map((event) => event.id);
      expect(received).toEqual(log);
      expect(new Set(received).size).toBe(received.length);
      expect(received.length).toBeGreaterThanOrEqual(1300);
    });
  });

  it('only lets the events of the asked scenarios through, and the asked type prefixes', async () => {
    await withDaemon('', async ({ open, write }) => {
      const mine = await open({ query: '?scenario=S1' });
      const two = await open({ query: '?scenario=S1&scenario=S3' });
      const typed = await open({ query: '?scenario=S2&types=recovery.' });
      const wanted: number[] = [];
      const both: number[] = [];
      let recovery = 0;
      for (let n = 1; n <= 12; n += 1) {
        const scenario = `S${String((n % 3) + 1)}`;
        const type = n % 4 === 0 ? 'recovery' : 'daemon';
        const id = await write(scenario, n, type);
        if (scenario === 'S1') wanted.push(id);
        if (scenario === 'S1' || scenario === 'S3') both.push(id);
        if (scenario === 'S2' && type === 'recovery') recovery = id;
      }
      const sees = async (reader: SseReader, ids: number[]): Promise<void> => {
        const frames = await reader.events(ids.length);
        expect(frames.map(idOf)).toEqual(ids);
        for (const frame of frames) {
          expect(['S1', 'S3']).toContain(frameData(frame).scenarioId);
        }
      };
      await sees(mine.reader, wanted);
      await sees(two.reader, both);
      const [frame] = await typed.reader.events(1);
      expect(idOf(required(frame))).toBe(recovery);
      expect(frameData(required(frame))).toMatchObject({
        scenarioId: 'S2',
        type: 'recovery.notice',
      });
    });
  });

  it('keeps the cursor on the global id when a filter drops events, so the resume is the same', async () => {
    await withDaemon('', async ({ open, write }) => {
      const a = await write('S1', 1);
      await write('S2', 2);
      await write('S2', 3);
      const b = await write('S1', 4);
      const first = await open({ query: '?scenario=S1', lastEventId: '0' });
      expect((await first.reader.events(2)).map(idOf)).toEqual([a, b]);
      await first.reader.close();
      const c = await write('S1', 5);
      const second = await open({ query: '?scenario=S1', lastEventId: String(b) });
      expect((await second.reader.events(1)).map(idOf)).toEqual([c]);
    });
  });

  it('writes the heartbeat on the clock of the daemon, with the fake clock', async () => {
    await withDaemon('', async ({ clock, open }) => {
      const { reader } = await open();
      await reader.next(); // retry
      await reader.next(); // cursor
      await clock.advance(14_000);
      await expect(reader.next(150)).rejects.toThrow(/no frame/);
      await clock.advance(1_000);
      expect(await reader.next()).toEqual({ comments: ['heartbeat'] });
      await clock.advance(15_000);
      expect(await reader.next()).toEqual({ comments: ['heartbeat'] });
    });
  });

  it('takes the heartbeat and the retry from the configuration, and 0 turns the heartbeat off', async () => {
    await withDaemon(
      'api:\n  sse:\n    heartbeat: 5s\n    retry: 7s\n',
      async ({ clock, open }) => {
        const { reader } = await open();
        expect((await reader.next())?.retry).toBe(7000);
        await reader.next();
        await clock.advance(5_000);
        expect(await reader.next()).toEqual({ comments: ['heartbeat'] });
      },
    );
    await withDaemon('api:\n  sse:\n    heartbeat: 0\n', async ({ clock, open }) => {
      const { reader } = await open();
      await reader.next();
      await reader.next();
      await clock.advance(120_000);
      await expect(reader.next(150)).rejects.toThrow(/no frame/);
    });
  });

  it('refuses a stream above api.sse.max_streams with 503 unavailable and Retry-After, and frees the room', async () => {
    await withDaemon('api:\n  sse:\n    max_streams: 2\n', async ({ open, write }) => {
      const a = await open();
      const b = await open();
      expect(a.response.status).toBe(200);
      expect(b.response.status).toBe(200);
      const third = await open();
      expect(third.response.status).toBe(503);
      expect(third.response.headers.get('retry-after')).toBe('2');
      expect(await third.response.json()).toMatchObject({
        error: { code: 'unavailable', details: { maxStreams: 2 } },
      });
      // A stream that goes away gives its place back.
      await a.reader.close();
      let again = await open();
      for (let i = 0; i < 50 && again.response.status === 503; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        again = await open();
      }
      expect(again.response.status).toBe(200);
      const id = await write(undefined, 1);
      expect(await readUntil(again.reader, id)).toEqual([id]);
    });
  });

  it('ends the stream when the daemon stops', async () => {
    await withDaemon('', async ({ daemon, open }) => {
      const { reader } = await open();
      await reader.next();
      await reader.next();
      const stopped = daemon.stop('shutdown');
      expect(await reader.endsWithin(5000)).toBe(true);
      await stopped;
    });
  });

  it('ends the streams when the token is rotated, and a new stream asks for the new token', async () => {
    await withDaemon('', async ({ daemon, dir, open, write }) => {
      const a = await open();
      const b = await open();
      await a.reader.next();
      await b.reader.next();
      await daemon.api.rotateToken();
      expect(await a.reader.endsWithin(5000)).toBe(true);
      expect(await b.reader.endsWithin(5000)).toBe(true);
      expect((await open()).response.status).toBe(401);
      const fresh = (await readFile(dataPaths(dir).apiToken, 'utf8')).trim();
      const again = await open({ token: fresh });
      expect(again.response.status).toBe(200);
      const id = await write(undefined, 1);
      expect(await readUntil(again.reader, id)).toEqual([id]);
    });
  });

  it('does not leave a subscriber behind when the clients go away', async () => {
    await withDaemon('', async ({ daemon, open }) => {
      const streams = await Promise.all([open(), open(), open()]);
      await Promise.all(streams.map(({ reader }) => reader.next()));
      // The daemon follows its own log too (the spans projector, P4 of Phase 8): count the clients.
      const during = daemon.eventHub.subscriberCount;
      expect(during).toBeGreaterThanOrEqual(streams.length);
      await Promise.all(streams.map(({ reader }) => reader.close()));
      const left = during - streams.length;
      for (let i = 0; i < 100 && daemon.eventHub.subscriberCount > left; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(daemon.eventHub.subscriberCount).toBe(left);
    });
  });
});
