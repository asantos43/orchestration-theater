// SPDX-License-Identifier: MPL-2.0
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import {
  AdapterUnavailable,
  Conflict,
  InvalidInput,
  NotFound,
  type JsonObject,
} from '@otheater/core';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { RecoveryGate } from '../recovery/gate.js';
import type { ChatPoll, OpenChatInput, ProducerChannel } from './channel.js';

/** Where the channel listens: the loopback only, like the MCP server. */
export const CHANNEL_HOST = '127.0.0.1';

/** What a running daemon publishes in `channel.json` so `ot chat` can find it. */
export const ChannelInfoSchema = z.strictObject({
  url: z.string().min(1),
  token: z.string().min(1),
  pid: z.int().min(1),
});
export type ChannelInfo = z.infer<typeof ChannelInfoSchema>;

const OpenBody = z.strictObject({
  repo: z.string().min(1),
  base: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
});
const SendBody = z.strictObject({ scenarioId: z.string().min(1), text: z.string() });
const AnswerBody = z.strictObject({
  decisionId: z.string().min(1),
  answer: z.record(z.string(), z.json()),
});

function sameToken(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function statusOf(error: unknown): 400 | 404 | 409 | 503 | 500 {
  if (error instanceof InvalidInput) return 400;
  if (error instanceof NotFound) return 404;
  if (error instanceof Conflict) return 409;
  if (error instanceof AdapterUnavailable) return 503;
  return 500;
}

export interface ProducerChannelServerOptions {
  readonly channel: ProducerChannel;
  /** `auto` lets the system pick a free port. */
  readonly port: number | 'auto';
  readonly logger: Logger;
  /** Requests wait here while the reconciliation of the start-up runs (5.21). Default: no wait. */
  readonly gate?: Pick<RecoveryGate, 'wait'>;
}

/**
 * The HTTP face of {@link ProducerChannel}, for `ot chat`: loopback only and a bearer token that
 * lives only in `channel.json` (mode 0600) and in the memory of the daemon. [proposta] Small JSON
 * routes with polling: the Producer's terminal needs nothing more for the minimal chat (N78).
 */
export class ProducerChannelServer {
  readonly #http: HttpServer;
  readonly #info: ChannelInfo;
  #stopped: Promise<void> | undefined;

  private constructor(http: HttpServer, info: ChannelInfo) {
    this.#http = http;
    this.#info = info;
  }

  static async start(options: ProducerChannelServerOptions): Promise<ProducerChannelServer> {
    const { channel, logger, gate } = options;
    const token = randomBytes(32).toString('base64url');
    const app = new Hono();
    app.use('*', async (c, next) => {
      const header = c.req.header('authorization');
      const given = header?.startsWith('Bearer ') === true ? header.slice(7) : undefined;
      if (!sameToken(given, token)) return c.json({ error: 'unauthorized' }, 401 as const);
      // The reconciliation of the start-up (5.21) holds the commands until it ends.
      await gate?.wait();
      await next();
      return undefined;
    });
    app.onError((error, c) => {
      const status = statusOf(error);
      if (status === 500) logger.error({ err: error }, 'the producer channel failed a request');
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        status as 400,
      );
    });
    app.post('/chat/open', async (c) => {
      const body = OpenBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) throw new InvalidInput(body.error.message);
      const input: OpenChatInput = {
        repo: body.data.repo,
        ...(body.data.base === undefined ? {} : { base: body.data.base }),
        ...(body.data.name === undefined ? {} : { name: body.data.name }),
      };
      return c.json(await channel.openChat(input));
    });
    app.post('/chat/send', async (c) => {
      const body = SendBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) throw new InvalidInput(body.error.message);
      await channel.send(body.data.scenarioId, body.data.text);
      return c.json({ ok: true });
    });
    app.get('/chat/poll', async (c) => {
      const scenarioId = c.req.query('scenario');
      const since = Number(c.req.query('since') ?? '0');
      if (scenarioId === undefined || !Number.isInteger(since) || since < 0) {
        throw new InvalidInput('poll needs "scenario" and a "since" that is a whole number');
      }
      return c.json(await channel.poll(scenarioId, since));
    });
    app.post('/chat/answer', async (c) => {
      const body = AnswerBody.safeParse(await c.req.json().catch(() => undefined));
      if (!body.success) throw new InvalidInput(body.error.message);
      await channel.answer(body.data.decisionId, body.data.answer);
      return c.json({ ok: true });
    });
    const http = await new Promise<HttpServer>((resolve, reject) => {
      const server = serve(
        {
          fetch: app.fetch,
          hostname: CHANNEL_HOST,
          port: options.port === 'auto' ? 0 : options.port,
        },
        () => {
          server.off('error', onError);
          resolve(server);
        },
      ) as HttpServer;
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(
          new AdapterUnavailable(
            `The Producer channel could not listen on ${CHANNEL_HOST}: ${error.message}`,
          ),
        );
      };
      server.once('error', onError);
    });
    const { port } = http.address() as AddressInfo;
    logger.info({ port }, 'Producer channel listening');
    return new ProducerChannelServer(http, {
      url: `http://${CHANNEL_HOST}:${String(port)}`,
      token,
      pid: process.pid,
    });
  }

  get info(): ChannelInfo {
    return this.#info;
  }

  /** Publishes the address and the token where `ot chat` looks (atomically, mode 0600). */
  async publish(path: string): Promise<void> {
    const temporary = `${path}.${String(process.pid)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#info)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  /** Stops listening and removes the file. Idempotent. */
  stop(path: string): Promise<void> {
    this.#stopped ??= (async () => {
      await rm(path, { force: true });
      await new Promise<void>((resolve) => {
        this.#http.close(() => {
          resolve();
        });
        this.#http.closeAllConnections();
      });
    })();
    return this.#stopped;
  }
}

/** Reads `channel.json`; `undefined` when no daemon published one (or it is unreadable). */
export async function readChannelInfo(path: string): Promise<ChannelInfo | undefined> {
  try {
    return ChannelInfoSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return undefined;
  }
}

/** The client of `ot chat`: the routes above as methods. */
export class ChannelClient {
  readonly #info: ChannelInfo;
  readonly #fetch: typeof fetch;

  constructor(info: ChannelInfo, fetchImpl: typeof fetch = fetch) {
    this.#info = info;
    this.#fetch = fetchImpl;
  }

  async #call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#info.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#info.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      throw new Error(parsed.error ?? `The daemon answered ${String(response.status)}`);
    }
    return parsed as T;
  }

  open(input: OpenChatInput): Promise<{ scenarioId: string; cursor: number }> {
    return this.#call('POST', '/chat/open', input);
  }

  async send(scenarioId: string, text: string): Promise<void> {
    await this.#call('POST', '/chat/send', { scenarioId, text });
  }

  poll(scenarioId: string, since: number): Promise<ChatPoll> {
    return this.#call(
      'GET',
      `/chat/poll?scenario=${encodeURIComponent(scenarioId)}&since=${String(since)}`,
    );
  }

  async answer(decisionId: string, answer: JsonObject): Promise<void> {
    await this.#call('POST', '/chat/answer', { decisionId, answer });
  }
}
