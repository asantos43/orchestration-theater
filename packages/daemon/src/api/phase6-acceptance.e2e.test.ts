// SPDX-License-Identifier: MPL-2.0
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  ApiClient,
  ApiRequestError,
  DaemonIdMismatchError,
  DaemonStores,
  applyEvents,
  createLayoutStore,
  initialPlays,
  layoutSettingsFromConfig,
  parseScenarioRefKey,
  reducePlays,
  scenarioRefKey,
  type EventStream,
  type FetchLike,
  type WebSocketConstructor,
} from '@otheater/client';
import {
  FileLayoutStore,
  clientLayoutFile,
  createNodeDaemonDirectory,
} from '@otheater/client/node';
import {
  API_ROUTES,
  PlayCreatedPayloadSchema,
  PlayTransitionedPayloadSchema,
  defaultLayout,
  type ApiSseMessage,
  type ChatServerMessage,
} from '@otheater/protocol';
import {
  FakeClientAdapter,
  FakeClock,
  FakeCodeHost,
  InMemorySecretVault,
} from '@otheater/core/testing';
import { disposeTestGitIsolation } from '@otheater/sdk';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { EXIT_OK } from '../commands.js';
import { runChatCommand } from '../chat-command.js';
import { createTranslator } from '../i18n.js';
import { describeWithLauncher } from '../launcher-fixture.js';
import {
  assertFakeAgentBuilt,
  waitFor,
  withPlayDaemon as withDaemon,
  type PlayHarness,
} from '../orchestration/e2e-fixture.js';
import { dataPaths } from '../paths.js';

/**
 * The acceptance of Phase 6 (P13 of docs/17) [proposta]: the test client of `@otheater/client` (the
 * ApiClient, the EventStream, the ChatSocket, the DaemonDirectory, the stores and the layout
 * store) against the real daemon with the fake agent in every role. Nothing real runs (N57): the
 * daemon is in a temporary folder, on loopback, with a fake clock, a fake code host and a SQLite
 * file of its own; no test reads a credential.
 *
 * The tests live here and not in `packages/client` because the client may not import the daemon
 * (rule `client-never-daemon`, tests included); the daemon already depends on the client (`ot chat`).
 * Timings are real-time and tolerant (the reconnection delays are short, every wait has a
 * generous deadline), and no path or port is fixed, so the suite runs on Linux, macOS and Windows.
 * The client is the compiled `dist/cli.js` of the fake agent, so `pnpm build` comes first.
 */

beforeAll(assertFakeAgentBuilt);
afterAll(disposeTestGitIsolation);

/** The play that goes all the way: a plan, two demands, the critique and the delivery as a PR. */
const APPROVED_PLAY = '#ot-play write alpha and beta #outcome:approved';
/** The play that runs out of attempts and waits for the Producer (`attempts_per_demand: 2`). */
const EXHAUSTED_PLAY = '#ot-play write alpha #outcome:exhausted';

/** The transport timers of the chat run on real time, short here (the same as `chat-socket.e2e`). */
const CHAT_CONFIG = `api:
  chat:
    resume_window: 50ms
    heartbeat: 30s
    state_interval: 100ms
    close_grace: 200ms
`;

/** A clock that moves a millisecond at every reading: what a real clock does between two writes. */
class TickingClock extends FakeClock {
  #ticks = 0;

  override now(): number {
    return super.now() + this.#ticks++;
  }
}

interface DaemonOptions {
  readonly clock?: FakeClock;
  readonly limits?: string;
  readonly extra?: string;
}

function withFakeDaemon(
  options: DaemonOptions,
  body: (harness: PlayHarness, client: ApiClient) => Promise<void>,
): Promise<void> {
  return withDaemon(
    {
      codeHost: new FakeCodeHost(),
      clock: options.clock ?? new FakeClock(),
      vault: new InMemorySecretVault(),
      client: (launcher, command, env) =>
        new FakeClientAdapter({ launcher, baseEnv: {}, env, adapterVersion: '1.0.0', command }),
    },
    {
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      extra: `${CHAT_CONFIG}${options.extra ?? ''}`,
    },
    async (harness) => {
      await body(harness, await clientOf(harness));
    },
  );
}

const tokenOf = async (harness: PlayHarness): Promise<string> =>
  (await readFile(dataPaths(harness.dataDir).apiToken, 'utf8')).trim();

async function clientOf(harness: PlayHarness, fetch?: FetchLike): Promise<ApiClient> {
  return new ApiClient({
    url: harness.daemon.api.url,
    token: await tokenOf(harness),
    daemonId: harness.daemon.daemonId,
    ...(fetch === undefined ? {} : { fetch }),
  });
}

const logOf = (harness: PlayHarness): Promise<readonly ApiEventEnvelopeLike[]> =>
  harness.daemon.store.events.readFrom(0, 100_000);

/** What the log and the stream have in common: the part of the envelope the tests compare. */
interface ApiEventEnvelopeLike {
  readonly id: number;
  readonly type: string;
  readonly scenarioId?: string | undefined;
  readonly playId?: string | undefined;
  readonly timestamp: number;
  readonly payload: unknown;
}

/** The id of the newest event of the log: the cursor a client starts from to see only what follows. */
async function headOf(harness: PlayHarness): Promise<number> {
  return (await logOf(harness)).at(-1)?.id ?? 0;
}

/** Opens a stream and keeps what it delivers (the listeners come before `start()`). */
function follow(stream: EventStream): {
  readonly messages: ApiSseMessage[];
  readonly states: string[];
} {
  const messages: ApiSseMessage[] = [];
  const states: string[] = [];
  stream.onMessage((message) => {
    messages.push(message);
  });
  stream.onState((state) => {
    states.push(state);
  });
  stream.start();
  return { messages, states };
}

const payloadOf = (event: { readonly payload: unknown }): Record<string, unknown> =>
  event.payload as Record<string, unknown>;

/** True for the `play.transitioned` of the play that goes to `to`. */
const transitionedTo =
  (to: string) =>
  (event: { readonly type: string; readonly payload: unknown }): boolean =>
    event.type === 'play.transitioned' && payloadOf(event).to === to;

/** The play of the scenario that is in `state`, once it is. */
function waitForPlay(harness: PlayHarness, scenarioId: string, state: string, which = 0) {
  return waitFor(`play ${String(which)} of the scenario in ${state}`, async () => {
    const play = (await harness.plays(scenarioId))[which];
    return play?.state === state ? play : undefined;
  });
}

// ---- fetch that can be cut, and sockets that can be dropped -------------------------------------

/**
 * A `fetch` whose streams of events can be cut from outside, as a network that falls would do:
 * the body fails in the middle, and the client has to come back with `Last-Event-ID`. It records
 * the header of every request of the stream.
 */
class CuttableFetch {
  readonly requests: { readonly url: string; readonly lastEventId: string | null }[] = [];
  readonly #open = new Set<AbortController>();

  readonly fetch: FetchLike = (url, init) => {
    if (!url.includes('/v1/events')) return fetch(url, init);
    const controller = new AbortController();
    const headers = new Headers(init.headers);
    this.requests.push({ url, lastEventId: headers.get('last-event-id') });
    const signal =
      init.signal === undefined || init.signal === null
        ? controller.signal
        : AbortSignal.any([init.signal, controller.signal]);
    this.#open.add(controller);
    return fetch(url, { ...init, signal });
  };

  /** Cuts every stream that is open now. */
  cut(): void {
    for (const controller of this.#open) controller.abort();
    this.#open.clear();
  }
}

/** The sockets a client opened, so a test can drop the connection and see what the client sent. */
interface SocketRecorder {
  readonly Socket: WebSocketConstructor;
  readonly sockets: { readonly url: string; readonly sent: string[]; drop(): void }[];
}

function recordSockets(): SocketRecorder {
  const sockets: SocketRecorder['sockets'][number][] = [];
  class RecordingSocket extends WebSocket {
    constructor(url: string) {
      super(url);
      const sent: string[] = [];
      const send = super.send.bind(this);
      this.send = (data) => {
        if (typeof data === 'string') sent.push(data);
        send(data);
      };
      sockets.push({
        url,
        sent,
        drop: () => {
          this.close(1000);
        },
      });
    }
  }
  return { Socket: RecordingSocket, sockets };
}

// ---- 1. a whole play over SSE --------------------------------------------------------------------

describeWithLauncher('the test client against the real daemon (P13)', { timeout: 120_000 }, () => {
  it('follows a whole play over SSE, from the need to the delivery', async () => {
    await withFakeDaemon({}, async (harness, client) => {
      const scenarioId = await harness.openChat();
      const head = await headOf(harness);
      // Two readers of the same daemon: one sees everything, the other only the scenario.
      const all = client.events({ since: head, initialDelayMs: 10 });
      const scoped = client.events({ scenario: scenarioId, since: head, initialDelayMs: 10 });
      const { messages } = follow(all);
      const { messages: ofScenario } = follow(scoped);
      try {
        await harness.producer.send(scenarioId, APPROVED_PLAY);
        await waitFor('the DONE of the play', () =>
          Promise.resolve(messages.find((message) => transitionedTo('DONE')(message.data))),
        );
        await waitFor('the delivery', () =>
          Promise.resolve(messages.find((message) => message.data.type === 'delivery.completed')),
        );
        // What the stream has is what the log has after the cursor, in the same order.
        const log = await waitFor('the stream to reach the log', async () => {
          const events = (await logOf(harness)).filter((event) => event.id > head);
          return messages.length === events.length ? events : undefined;
        });
        expect(messages.map((message) => message.data.id)).toEqual(log.map((event) => event.id));
        expect(messages.map((message) => message.id)).toEqual(
          messages.map((message) => String(message.data.id)),
        );
        const ids = messages.map((message) => message.data.id);
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
        for (const message of messages) {
          expect(message.data.daemonId).toBe(harness.daemon.daemonId);
          expect(typeof message.data.type).toBe('string');
          expect(typeof message.data.payload).toBe('object');
        }

        // The whole play is there: the need, the transitions up to DONE, the delivery.
        const created = messages.find((message) => message.data.type === 'play.created');
        expect(JSON.stringify(created?.data.payload)).toContain('alpha');
        const playId = created?.data.playId;
        if (playId === undefined) throw new Error('play.created carries no play id');
        const path = messages
          .filter((message) => message.data.type === 'play.transitioned')
          .map((message) => payloadOf(message.data).to);
        expect(path).toEqual(await harness.pathOf(playId));
        expect(path.at(-1)).toBe('DONE');
        const delivered = messages.find((message) => message.data.type === 'delivery.completed');
        expect(delivered?.data.playId).toBe(playId);
        expect(harness.codeHost.pullRequests()).toHaveLength(1);
        expect(all.lastEventId).toBe(ids.at(-1));

        // The filter by scenario gives what the log says belongs to the scenario, no more, no less.
        // [N] The events the daemon writes with a `playId` and no `scenarioId` (the delivery is one)
        // are not in it: see docs/17, P13.
        const scenarioIds = log.filter((event) => event.scenarioId === scenarioId).map((e) => e.id);
        await waitFor('the filtered stream', () =>
          Promise.resolve(ofScenario.length === scenarioIds.length || undefined),
        );
        expect(ofScenario.map((message) => message.data.id)).toEqual(scenarioIds);
        expect(ofScenario.every((message) => message.data.scenarioId === scenarioId)).toBe(true);
        expect(ofScenario.some((message) => message.data.type === 'play.created')).toBe(true);
      } finally {
        all.close();
        scoped.close();
      }
    });
  });

  // ---- 2. the connection drops in the middle of the stream ---------------------------------------

  it('reconnects after a drop with Last-Event-ID and the ids it got are the ids of the log, once each', async () => {
    await withFakeDaemon({}, async (harness) => {
      const cutting = new CuttableFetch();
      const client = await clientOf(harness, cutting.fetch);
      const scenarioId = await harness.openChat();
      // `dropRepeated: false` so a repeat of the daemon would show instead of being hidden.
      const stream = client.events({
        since: 0,
        dropRepeated: false,
        initialDelayMs: 10,
        maxDelayMs: 50,
        jitter: 0,
      });
      const { messages, states } = follow(stream);
      // Cut every time something new arrived since the last cut: the stream always moves forward,
      // and every reconnection has a cursor to send.
      let cutAt = 0;
      let cuts = 0;
      const cutter = setInterval(() => {
        if (messages.length > cutAt) {
          cutAt = messages.length;
          cuts += 1;
          cutting.cut();
        }
      }, 15);
      try {
        await harness.producer.send(scenarioId, APPROVED_PLAY);
        await waitForPlay(harness, scenarioId, 'DONE');
        clearInterval(cutter);
        const log = await waitFor('the stream to reach the log', async () => {
          const ids = (await logOf(harness)).map((event) => event.id);
          return messages.length === ids.length ? ids : undefined;
        });
        expect(messages.map((message) => message.data.id)).toEqual(log);
        expect(new Set(log).size).toBe(log.length);
        // It did drop, more than once, and it came back with the cursor, not from the start.
        expect(cuts).toBeGreaterThanOrEqual(2);
        expect(states).toContain('retrying');
        const resumed = cutting.requests.filter((request) => request.lastEventId !== null);
        expect(resumed.length).toBeGreaterThanOrEqual(2);
        for (const request of resumed) {
          expect(Number(request.lastEventId)).toBeGreaterThan(0);
          expect(Number(request.lastEventId)).toBeLessThanOrEqual(log.at(-1) ?? 0);
          expect(request.url).not.toContain('since=');
        }
      } finally {
        clearInterval(cutter);
        stream.close();
      }
    });
  });

  // ---- 3. the chat with the Orchestrator over the WebSocket ---------------------------------------

  it('chats over the WebSocket: a question answered, a drop, and the resume brings what was missed once', async () => {
    await withFakeDaemon({}, async (harness, client) => {
      const scenarioId = await harness.openGenericChat('talk');
      const { Socket, sockets } = recordSockets();
      // A long first delay: the Director speaks while the client is waiting to come back.
      const chat = client.chat(scenarioId, {
        webSocket: Socket,
        initialDelayMs: 400,
        maxDelayMs: 400,
        jitter: 0,
      });
      const frames: ChatServerMessage[] = [];
      const states: string[] = [];
      chat.onMessage((frame) => {
        frames.push(frame);
      });
      chat.onState((state) => {
        states.push(state);
      });
      const replyWith = (text: string) =>
        waitFor(`a reply with "${text}"`, () =>
          Promise.resolve(
            frames.find(
              (frame): frame is DirectorReply =>
                frame.type === 'director_reply' && frame.text.includes(text),
            ),
          ),
        );
      chat.start();
      try {
        await waitFor('the chat to open', () =>
          Promise.resolve(chat.state === 'open' || undefined),
        );
        // A first connection sends no `resume`: it has no cursor yet.
        expect(sockets).toHaveLength(1);

        // A question of the Director, answered by the client.
        chat.send({ type: 'message', text: '#ot-ask What color is the sky?' });
        const ask = await waitFor('the question', () =>
          Promise.resolve(
            frames.find(
              (frame): frame is Extract<ChatServerMessage, { type: 'ask' }> => frame.type === 'ask',
            ),
          ),
        );
        expect(ask.kind).toBe('producer_question');
        chat.send({ type: 'answer', decisionId: ask.decisionId, answer: { answers: ['blue'] } });
        const answered = await replyWith('answer:');
        expect(answered.final).toBe(true);
        expect(await harness.daemon.store.decisions.get(ask.decisionId)).toMatchObject({
          state: 'decided',
        });

        chat.send({ type: 'message', text: '#ot-chat one' });
        await replyWith('one');
        const cursor = chat.lastEventId ?? 0;
        expect(cursor).toBeGreaterThan(0);

        // The connection drops. The client waits to come back; meanwhile the Director says two.
        sockets[0]?.drop();
        await waitFor('the client to see the drop', () =>
          Promise.resolve(states.includes('retrying') || undefined),
        );
        await harness.producer.send(scenarioId, '#ot-chat two');
        await waitFor('the second connection', () =>
          Promise.resolve((chat.state === 'open' && sockets.length === 2) || undefined),
        );
        await replyWith('two');
        chat.send({ type: 'message', text: '#ot-chat three' });
        await replyWith('three');

        // The first thing the second connection said was where the first one had stopped.
        const first = JSON.parse(sockets[1]?.sent[0] ?? 'null') as {
          type: string;
          lastEventId: number;
        };
        expect(first.type).toBe('resume');
        expect(first.lastEventId).toBeGreaterThanOrEqual(cursor);
        expect(sockets[0]?.sent.some((text) => text.includes('"resume"'))).toBe(false);
        expect(states).toEqual(['connecting', 'open', 'retrying', 'connecting', 'open']);

        // No loss and no repeat: every reply once, in order, each with the id of its event.
        const heard = frames.filter(
          (frame): frame is DirectorReply => frame.type === 'director_reply',
        );
        expect(
          heard.map((frame) => frame.text.replace(/\s+/g, ' ')).map((text) => text.slice(-12)),
        ).toHaveLength(4);
        const marks = ['answer:', 'one', 'two', 'three'];
        marks.forEach((mark, index) => {
          expect(heard[index]?.text).toContain(mark);
        });
        const ids = frames.flatMap((frame) =>
          frame.type === 'director_reply' || frame.type === 'ask' ? [frame.eventId] : [],
        );
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
        const logged = new Set(
          (await logOf(harness))
            .filter((event) => event.type === 'chat.director_reply' || event.type === 'chat.ask')
            .map((event) => event.id),
        );
        for (const id of ids) expect(logged.has(id)).toBe(true);
      } finally {
        chat.close();
      }
    });
  });

  // ---- 4. the scenarios of two daemons at once -----------------------------------------------------

  it('sees the scenarios of two real daemons at once, each one under its own id (N134, N168)', async () => {
    await withFakeDaemon({}, async (a) => {
      await withFakeDaemon({}, async (b) => {
        const configDir = await mkdtemp(join(tmpdir(), 'otheater-client-config-'));
        try {
          // The first is the local one (found through `api.json` and the token of its folder), the
          // second is enrolled by URL and token: the daemon says its own id.
          const directory = createNodeDaemonDirectory({ dataDir: a.dataDir, configDir });
          const enrolled = await directory.enroll({
            name: 'second',
            url: b.daemon.api.url,
            token: await tokenOf(b),
          });
          expect(enrolled.daemonId).toBe(b.daemon.daemonId);
          const outcomes = await directory.connectAll();
          expect(outcomes.map((outcome) => outcome.entry.name)).toEqual(['local', 'second']);
          const [local, second] = outcomes.map((outcome) => {
            if (!outcome.ok) throw new Error(`could not connect to ${outcome.entry.name}`);
            return outcome.connected;
          }) as [ConnectedLike, ConnectedLike];
          expect(local.status.daemonId).toBe(a.daemon.daemonId);
          expect(second.status.daemonId).toBe(b.daemon.daemonId);
          expect(a.daemon.daemonId).not.toBe(b.daemon.daemonId);
          // The list is on disk: another directory of the same folder finds both.
          const again = createNodeDaemonDirectory({ dataDir: a.dataDir, configDir });
          expect((await again.list()).map((entry) => entry.name)).toEqual(['local', 'second']);

          // One scenario in each daemon, each in its own repository, with a play running in both.
          const stores = [local, second].map(
            ({ client }) => new DaemonStores(client, { plays: 'all', refreshDebounceMs: 10 }),
          ) as [DaemonStores, DaemonStores];
          const raw = [local, second].map(({ client }) => {
            const stream = client.events({ since: 0, initialDelayMs: 10 });
            return { stream, ...follow(stream) };
          });
          try {
            await Promise.all(stores.map((store) => store.start()));
            const sa = await a.openChat();
            const sb = await b.openChat();
            await Promise.all([
              a.producer.send(sa, APPROVED_PLAY),
              b.producer.send(sb, APPROVED_PLAY),
            ]);
            await Promise.all([waitForPlay(a, sa, 'DONE'), waitForPlay(b, sb, 'DONE')]);

            // Each daemon knows only its own scenario, with its own repository.
            for (const [daemon, harness, id] of [
              [local, a, sa],
              [second, b, sb],
            ] as const) {
              const page = await daemon.client.call(API_ROUTES.listScenarios, { query: {} });
              expect(page.items.map((item) => item.id)).toEqual([id]);
              const detail = await daemon.client.call(API_ROUTES.getScenario, {
                params: { scenarioId: id },
              });
              expect(detail.repos.map((repo) => repo.path)).toEqual([harness.rig.repo]);
              await expect(
                daemon.client.call(API_ROUTES.getScenario, { params: { scenarioId: 'nope' } }),
              ).rejects.toMatchObject({ status: 404 });
            }
            expect(a.rig.repo).not.toBe(b.rig.repo);

            // The global reference (N168): both parts, so two scenarios never share a key, even
            // when the two daemons gave them the same local id.
            const refA = local.client.scenarioRef(sa);
            const refB = second.client.scenarioRef(sb);
            expect(refA).toEqual({ daemonId: a.daemon.daemonId, scenarioId: sa });
            expect(refB).toEqual({ daemonId: b.daemon.daemonId, scenarioId: sb });
            expect(scenarioRefKey(refA)).not.toBe(scenarioRefKey(refB));
            expect(parseScenarioRefKey(scenarioRefKey(refB))).toEqual(refB);

            // The combined view of a client that follows both: one entry per play, keyed by the daemon.
            await Promise.all(
              stores.map((store, index) =>
                waitFor(`the play of daemon ${String(index)} in its store`, () =>
                  Promise.resolve(
                    Object.values(store.plays.getState().byId).every((p) => p.state === 'DONE') &&
                      Object.keys(store.plays.getState().byId).length === 1
                      ? true
                      : undefined,
                  ),
                ),
              ),
            );
            const combined = new Map<string, string>();
            for (const [store, daemon] of [
              [stores[0], local],
              [stores[1], second],
            ] as const) {
              for (const play of Object.values(store.plays.getState().byId)) {
                combined.set(`${daemon.status.daemonId}/${play.id}`, play.state);
              }
              for (const scenario of Object.values(store.scenarios.getState().byId)) {
                expect(scenario.id).toBe(daemon === local ? sa : sb);
              }
            }
            expect([...combined.values()]).toEqual(['DONE', 'DONE']);
            expect(combined.size).toBe(2);

            // Every event a daemon sends carries the id of that daemon, and only of that one.
            await waitFor('the events of both', () =>
              Promise.resolve(raw.every((r) => r.messages.length > 5) || undefined),
            );
            expect(raw[0]?.messages.every((m) => m.data.daemonId === a.daemon.daemonId)).toBe(true);
            expect(raw[1]?.messages.every((m) => m.data.daemonId === b.daemon.daemonId)).toBe(true);
          } finally {
            for (const store of stores) store.close();
            for (const r of raw) r.stream.close();
          }

          // The checks of the connection: the id the entry has, and the token of the other daemon.
          const wrongId = new ApiClient({
            url: b.daemon.api.url,
            token: await tokenOf(b),
            daemonId: a.daemon.daemonId,
          });
          await expect(wrongId.connect()).rejects.toBeInstanceOf(DaemonIdMismatchError);
          const wrongToken = new ApiClient({ url: b.daemon.api.url, token: await tokenOf(a) });
          const refused = await wrongToken.connect().catch((error: unknown) => error);
          expect(refused).toBeInstanceOf(ApiRequestError);
          expect((refused as ApiRequestError).status).toBe(401);
          // An entry that is gone from the list takes its daemon with it, and not the local one.
          await directory.remove('second');
          expect((await directory.list()).map((entry) => entry.name)).toEqual(['local']);
        } finally {
          await rm(configDir, { recursive: true, force: true });
        }
      });
    });
  });

  // ---- 5. the stores of the client against the events of the daemon (P11) --------------------------

  /** Everything the stores and the REST say about the play at the end, once the stores caught up. */
  async function caughtUp(harness: PlayHarness, stores: DaemonStores): Promise<void> {
    await waitFor('the stores to reach the log', async () =>
      stores.status.getState().cursor === (await headOf(harness)) ? true : undefined,
    );
    await stores.whenIdle();
  }

  it('the stores kept by the events equal what REST says, and the stamps are the stamps of the records', async () => {
    await withFakeDaemon({}, async (harness, client) => {
      const stores = new DaemonStores(client, { plays: 'all', refreshDebounceMs: 10 });
      await stores.start();
      const raw = client.events({ since: await headOf(harness), initialDelayMs: 10 });
      const { messages } = follow(raw);
      try {
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, APPROVED_PLAY);
        const play = await waitForPlay(harness, scenarioId, 'DONE');
        await caughtUp(harness, stores);
        await waitFor('the stream to reach the log', async () =>
          messages.at(-1)?.data.id === (await headOf(harness)) ? true : undefined,
        );

        const detail = await client.call(API_ROUTES.getPlay, { params: { playId: play.id } });
        const scenario = await client.call(API_ROUTES.getScenario, { params: { scenarioId } });

        // The play: built from `play.created` and `play.transitioned` alone, it is the REST record,
        // stamps included (the clock is frozen: the event and the record read the same instant).
        const events = messages.map((message) => message.data);
        const reduced = applyEvents(initialPlays(), events, reducePlays);
        expect(reduced.stale).toEqual({});
        expect(reduced.byId[play.id]).toEqual(detail.play);
        expect(stores.plays.getState().stale).toEqual({});
        expect(stores.plays.getState().byId[play.id]).toEqual(detail.play);
        expect(detail.play.state).toBe('DONE');
        expect(detail.play.finishedAt).not.toBeNull();

        // What the events cannot keep is read by REST, and the read gives the same as REST.
        expect(stores.demands.getState().byPlay[play.id]).toEqual({
          demands: detail.demands,
          stages: detail.stages,
        });
        expect(detail.demands.length).toBeGreaterThan(0);
        expect(stores.scenarios.getState().byId[scenarioId]).toEqual(scenario.scenario);
        expect(stores.decisions.getState().byScenario[scenarioId] ?? []).toEqual([]);
        expect(
          (
            await client.call(API_ROUTES.listScenarioDecisions, {
              params: { scenarioId },
              query: { state: 'pending' },
            })
          ).items,
        ).toEqual([]);
        expect(stores.status.getState()).toMatchObject({ phase: 'live', error: undefined });

        // The one schema of each event (in the protocol, shared by the daemon and the client) takes
        // every payload the daemon wrote.
        const created = events.filter((event) => event.type === 'play.created');
        const moved = events.filter((event) => event.type === 'play.transitioned');
        expect(created).toHaveLength(1);
        expect(moved.length).toBeGreaterThanOrEqual(3);
        for (const event of created) {
          expect(() => PlayCreatedPayloadSchema.parse(event.payload)).not.toThrow();
        }
        for (const event of moved) {
          expect(() => PlayTransitionedPayloadSchema.parse(event.payload)).not.toThrow();
        }

        // The stamp of every event is the stamp of the record it carries.
        const first = created[0];
        const last = moved.at(-1);
        expect(first?.timestamp).toBe(detail.play.createdAt);
        expect(last?.timestamp).toBe(detail.play.updatedAt);
        expect(last?.timestamp).toBe(detail.play.finishedAt);
      } finally {
        raw.close();
        stores.close();
      }
    });
  });

  it('with a clock that moves, the play built from the events equals the REST record, stamps included (N177)', async () => {
    await withFakeDaemon({ clock: new TickingClock() }, async (harness, client) => {
      const stores = new DaemonStores(client, { plays: 'all', refreshDebounceMs: 10 });
      await stores.start();
      const raw = client.events({ since: await headOf(harness), initialDelayMs: 10 });
      const { messages } = follow(raw);
      try {
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, APPROVED_PLAY);
        const play = await waitForPlay(harness, scenarioId, 'DONE');
        await caughtUp(harness, stores);
        await waitFor('the stream to reach the log', async () =>
          messages.at(-1)?.data.id === (await headOf(harness)) ? true : undefined,
        );
        const rest = (await client.call(API_ROUTES.getPlay, { params: { playId: play.id } })).play;
        const events = messages.map((message) => message.data);
        // The record and the event of one change are written in one transaction, which reads the
        // clock once: field by field, with no tolerance, the events say what REST says.
        expect(applyEvents(initialPlays(), events, reducePlays).byId[play.id]).toEqual(rest);
        expect(stores.plays.getState().stale).toEqual({});
        expect(stores.plays.getState().byId[play.id]).toEqual(rest);
        expect(rest.finishedAt).not.toBeNull();
        expect(events.find((event) => event.type === 'play.created')?.timestamp).toBe(
          rest.createdAt,
        );
        expect(events.filter((event) => event.type === 'play.transitioned').at(-1)?.timestamp).toBe(
          rest.finishedAt,
        );
      } finally {
        raw.close();
        stores.close();
      }
    });
  });

  it('the decisions store follows the menu of a stopped play and the question of a chat, by the transitions', async () => {
    await withFakeDaemon({ limits: '  attempts_per_demand: 2' }, async (harness, client) => {
      const stores = new DaemonStores(client, { plays: 'all', refreshDebounceMs: 10 });
      await stores.start();
      try {
        const scenarioId = await harness.openChat();
        await harness.producer.send(scenarioId, EXHAUSTED_PLAY);
        const play = await waitForPlay(harness, scenarioId, 'AWAITING_PRODUCER');
        const pending = (id: string) =>
          client
            .call(API_ROUTES.listScenarioDecisions, {
              params: { scenarioId: id },
              query: { state: 'pending' },
            })
            .then((page) => page.items);
        const menu = await waitFor('the menu in REST', async () => {
          const items = await pending(scenarioId);
          return items.length === 1 ? items[0] : undefined;
        });
        // The play moved, and that is the event that marks the decisions: the store has the menu.
        await waitFor('the menu in the store', () =>
          Promise.resolve(
            stores.decisions.getState().byScenario[scenarioId]?.some((d) => d.id === menu.id) ??
              undefined,
          ),
        );
        await caughtUp(harness, stores);
        expect(stores.decisions.getState().byScenario[scenarioId]).toEqual(
          await pending(scenarioId),
        );

        // Answered through REST: the play is cancelled, and the store drops the decision.
        await client.call(API_ROUTES.answerDecision, {
          params: { decisionId: menu.id },
          body: { answer: { option: 'cancel', reason: 'not worth it' } },
        });
        await waitForPlay(harness, scenarioId, 'CANCELLED');
        await caughtUp(harness, stores);
        expect(stores.decisions.getState().byScenario[scenarioId] ?? []).toEqual([]);
        expect(await pending(scenarioId)).toEqual([]);
        const detail = await client.call(API_ROUTES.getPlay, { params: { playId: play.id } });
        expect(stores.plays.getState().byId[play.id]).toEqual(detail.play);

        // A question of the Director in a chat is a decision too. No event of the log says that a
        // decision was created or answered: the store learns it from the `scenario.chat_transitioned`
        // that comes with the question and with the answer (the chat stops and moves again).
        // [N] docs/17 (P13): `decision.created` / `decision.answered` events would not depend on that.
        const chatId = await harness.openGenericChat('talk');
        await caughtUp(harness, stores);
        await waitFor('the scenario in the store', () =>
          Promise.resolve(
            stores.scenarios.getState().byId[chatId] === undefined ? undefined : true,
          ),
        );
        await stores.whenIdle();
        await harness.producer.send(chatId, '#ot-ask What color is the sky?');
        const question = await waitFor('the question in REST', async () => {
          const items = await pending(chatId);
          return items.length === 1 ? items[0] : undefined;
        });
        await waitFor('the question in the store', () =>
          Promise.resolve(
            stores.decisions.getState().byScenario[chatId]?.some((d) => d.id === question.id) ??
              false,
          ),
        );
        const chatTypes = (await logOf(harness))
          .filter((event) => event.scenarioId === chatId)
          .map((event) => event.type);
        expect(chatTypes).toContain('chat.ask');
        expect(chatTypes).toContain('scenario.chat_transitioned');
        expect(chatTypes.some((type) => type.startsWith('decision.'))).toBe(false);

        await client.call(API_ROUTES.answerDecision, {
          params: { decisionId: question.id },
          body: { answer: { answers: ['blue'] } },
        });
        await waitFor('the store to drop the question', async () => {
          await stores.whenIdle();
          return (stores.decisions.getState().byScenario[chatId] ?? []).length === 0 || undefined;
        });
        expect(await pending(chatId)).toEqual([]);
        // A full read gives the same as the events did.
        await stores.resync();
        expect(stores.decisions.getState().byScenario[chatId] ?? []).toEqual([]);
      } finally {
        stores.close();
      }
    });
  });

  // ---- 6. the layout preferences (P12) --------------------------------------------------------------

  it('a layout saved by one client comes back in a new one, in the daemon and in the file', async () => {
    await withFakeDaemon(
      { extra: 'ui:\n  layout:\n    write_delay: 20ms\n' },
      async (harness, client) => {
        const { config } = await client.call(API_ROUTES.getConfig, {});
        const settings = layoutSettingsFromConfig(config);
        expect(settings).toEqual({ store: 'daemon', writeDelayMs: 20 });

        const tui = createLayoutStore({ client, interface: 'tui', settings });
        await tui.load();
        expect(tui.layout).toEqual(defaultLayout('tui'));
        tui.setChatWidth(72);
        tui.openTab('plays');
        tui.setSidebarCollapsed(true);
        tui.setSectionCollapsed('quota', true);
        // The change is written after the delay of the config, with no `flush()`.
        await waitFor('the layout to be saved', () =>
          Promise.resolve(tui.state.getState().dirty ? undefined : true),
        );
        await tui.whenSaved();
        expect(tui.state.getState().error).toBeUndefined();
        const saved = tui.layout;
        expect(saved).toMatchObject({
          sidebarCollapsed: true,
          chatWidth: 72,
          openTabs: ['overview', 'plays'],
          collapsedSections: ['quota'],
        });
        tui.close();

        // Another client of the same user (a new one, with its own connection) finds it.
        const other = await clientOf(harness);
        const again = createLayoutStore({ client: other, interface: 'tui', settings });
        await again.load();
        expect(again.layout).toEqual(saved);
        // The web interface has its own record, still the default.
        const web = createLayoutStore({ client: other, interface: 'web', settings });
        await web.load();
        expect(web.layout).toEqual(defaultLayout('web'));
        web.setChatWidth(640);
        await web.flush();
        expect(web.layout.chatWidth).toBe(640);
        expect(again.layout.chatWidth).toBe(72);
        again.close();
        web.close();

        // The daemon keeps one file for each interface, in its own folder.
        const file = JSON.parse(
          await readFile(join(dataPaths(harness.dataDir).layout, 'tui.json'), 'utf8'),
        ) as unknown;
        expect(file).toEqual(saved);
        const raw = await client.call(API_ROUTES.getLayout, { params: { interface: 'web' } });
        expect(raw.chatWidth).toBe(640);
      },
    );
  });

  it('with `ui.layout.store: local` the layout goes to the file of the client and the daemon keeps none', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'otheater-layout-'));
    try {
      await withFakeDaemon(
        { extra: 'ui:\n  layout:\n    store: local\n    write_delay: 20ms\n' },
        async (harness, client) => {
          const { config } = await client.call(API_ROUTES.getConfig, {});
          const settings = layoutSettingsFromConfig(config);
          expect(settings).toEqual({ store: 'local', writeDelayMs: 20 });
          const file = new FileLayoutStore(clientLayoutFile(configDir, 'tui'));
          const store = createLayoutStore({ client, interface: 'tui', settings, file });
          await store.load();
          store.setChatWidth(90);
          await store.flush();
          store.close();
          const next = createLayoutStore({ client, interface: 'tui', settings, file });
          await next.load();
          expect(next.layout.chatWidth).toBe(90);
          next.close();
          // The daemon was not asked to keep it.
          expect(
            (await client.call(API_ROUTES.getLayout, { params: { interface: 'tui' } })).chatWidth,
          ).toBe(defaultLayout('tui').chatWidth);
        },
      );
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  // ---- 7. `ot chat` after a drop of the socket (P8) -------------------------------------------------

  it('`ot chat` comes back by itself after a drop of the socket and prints each reply once', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'otheater-ot-chat-'));
    const previousConfigDir = process.env.OT_CLIENT_CONFIG_DIR;
    const RealWebSocket = globalThis.WebSocket;
    process.env.OT_CLIENT_CONFIG_DIR = configDir;
    try {
      await withFakeDaemon({}, async (harness) => {
        const { Socket, sockets } = recordSockets();
        globalThis.WebSocket = Socket as unknown as typeof WebSocket;
        const t = await createTranslator('en');
        const out: string[] = [];
        const err: string[] = [];
        const input = new PassThrough();
        let code: number | undefined;
        const running = runChatCommand(
          {
            dataDir: harness.dataDir,
            t,
            out: (line) => out.push(line),
            err: (line) => err.push(line),
          },
          {
            type: 'chat',
            name: 'talk',
            input,
            quietMs: 800,
            reconnect: { initialDelayMs: 10, maxDelayMs: 50, maxRetries: 2, jitter: 0 },
          },
        ).then((exit) => {
          code = exit;
        });
        try {
          await waitFor('the chat to open', () =>
            Promise.resolve(sockets.length === 1 && out.length > 0 ? true : undefined),
          );
          input.write('#ot-chat one\n');
          await waitFor('the first reply', () =>
            Promise.resolve(out.some((line) => /\bone\b/.test(line)) || undefined),
          );
          sockets[0]?.drop();
          await waitFor('the notice of the drop', () =>
            Promise.resolve(err.some((line) => line.includes('Trying again')) || undefined),
          );
          input.write('#ot-chat two\n');
          input.end();
          await waitFor('the command to end', () => Promise.resolve(code), 90_000);
          await running;
        } finally {
          input.destroy();
        }
        expect(code).toBe(EXIT_OK);
        expect(sockets.length).toBeGreaterThanOrEqual(2);
        const resume = JSON.parse(sockets[1]?.sent[0] ?? 'null') as { type: string };
        expect(resume.type).toBe('resume');
        // Each reply once: nothing is printed again because of the resume.
        expect(out.filter((line) => /\bone\b/.test(line))).toHaveLength(1);
        expect(out.filter((line) => /\btwo\b/.test(line))).toHaveLength(1);
        expect(err.filter((line) => line.includes('Trying again'))).toHaveLength(1);
        expect(err.filter((line) => /lost|failed/i.test(line))).toEqual([]);
      });
    } finally {
      globalThis.WebSocket = RealWebSocket;
      if (previousConfigDir === undefined) delete process.env.OT_CLIENT_CONFIG_DIR;
      else process.env.OT_CLIENT_CONFIG_DIR = previousConfigDir;
      await rm(configDir, { recursive: true, force: true });
    }
  });
});

/** What the tests read of a connected daemon of the directory. */
type ConnectedLike = Awaited<ReturnType<ReturnType<typeof createNodeDaemonDirectory>['connect']>>;
type DirectorReply = Extract<ChatServerMessage, { type: 'director_reply' }>;
