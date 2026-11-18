// SPDX-License-Identifier: MPL-2.0
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InvalidInput } from '@otheater/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_HTTP_MAX_BYTES,
  DaemonHttpError,
  checkedUrl,
  daemonGet,
  retryAfterMsOf,
} from './daemon-http.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const servers: Server[] = [];

/** A fake server on 127.0.0.1 with an ephemeral port. Nothing leaves the machine. */
async function serve(handler: Handler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

const LOCAL = { allowHosts: ['127.0.0.1'], timeoutMs: 2000 };

describe('checkedUrl', () => {
  it('accepts https for an allowed host and refuses another host', () => {
    const policy = { allowHosts: ['api.minimax.io', '*.example.com'] };
    expect(checkedUrl('https://api.minimax.io/v1/x', policy).hostname).toBe('api.minimax.io');
    expect(checkedUrl('https://a.example.com/', policy).hostname).toBe('a.example.com');
    expect(() => checkedUrl('https://evil.test/', policy)).toThrow(InvalidInput);
    expect(() => checkedUrl('https://api.minimax.io.evil.test/', policy)).toThrow(InvalidInput);
  });

  it('refuses everything when the allowlist is empty', () => {
    expect(() => checkedUrl('https://api.minimax.io/', { allowHosts: [] })).toThrow(/empty/);
  });

  it('accepts http only for a loopback host, and still asks the allowlist', () => {
    expect(checkedUrl('http://127.0.0.1:9/', { allowHosts: ['127.0.0.1'] }).port).toBe('9');
    expect(() => checkedUrl('http://127.0.0.1:9/', { allowHosts: [] })).toThrow(InvalidInput);
    expect(() => checkedUrl('http://api.minimax.io/', { allowHosts: ['api.minimax.io'] })).toThrow(
      /https/,
    );
    expect(() => checkedUrl('ftp://127.0.0.1/', { allowHosts: ['127.0.0.1'] })).toThrow(/https/);
  });

  it('refuses credentials in the address and an address that is not a URL', () => {
    const policy = { allowHosts: ['api.minimax.io'] };
    expect(() => checkedUrl('https://user:pw@api.minimax.io/', policy)).toThrow(/credentials/);
    expect(() => checkedUrl('not a url', policy)).toThrow(InvalidInput);
  });
});

describe('retryAfterMsOf', () => {
  it('reads seconds, a date and nothing', () => {
    const now = Date.UTC(2026, 10, 18, 12, 0, 0);
    expect(retryAfterMsOf('30', now)).toBe(30_000);
    expect(retryAfterMsOf(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
    expect(retryAfterMsOf(new Date(now - 90_000).toUTCString(), now)).toBe(0);
    expect(retryAfterMsOf('soon', now)).toBeUndefined();
    expect(retryAfterMsOf(null, now)).toBeUndefined();
  });
});

describe('daemonGet', () => {
  it('returns the status and the body, and sends the headers only to that request', async () => {
    let seen = '';
    const base = await serve((req, res) => {
      seen = String(req.headers.authorization);
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    const answer = await daemonGet(`${base}/x`, LOCAL, { authorization: 'Bearer k' });
    expect(answer).toEqual({ status: 200, body: '{"ok":true}' });
    expect(seen).toBe('Bearer k');
  });

  it('gives a 429 with its Retry-After as an answer, not a failure', async () => {
    const base = await serve((_req, res) => {
      res.statusCode = 429;
      res.setHeader('retry-after', '7');
      res.end('slow down');
    });
    expect(await daemonGet(base, LOCAL)).toEqual({
      status: 429,
      body: 'slow down',
      retryAfterMs: 7000,
    });
  });

  it('does not follow a redirect', async () => {
    let hits = 0;
    const base = await serve((req, res) => {
      hits += 1;
      if (req.url === '/target') {
        res.end('reached');
        return;
      }
      res.statusCode = 302;
      res.setHeader('location', '/target');
      res.end();
    });
    await expect(daemonGet(`${base}/start`, LOCAL)).rejects.toBeInstanceOf(DaemonHttpError);
    expect(hits).toBe(1);
  });

  it('stops reading a body above the cap', async () => {
    const base = await serve((_req, res) => {
      res.end('x'.repeat(DAEMON_HTTP_MAX_BYTES + 10));
    });
    await expect(daemonGet(base, LOCAL)).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('fails with a timeout when the server does not answer in time', async () => {
    const base = await serve(() => {
      // never answers
    });
    await expect(daemonGet(base, { ...LOCAL, timeoutMs: 80 })).rejects.toMatchObject({
      reason: 'timeout',
    });
  });

  it('fails as unreachable when nothing listens, without the headers in the message', async () => {
    const base = await serve((_req, res) => res.end());
    const server = servers[0];
    await new Promise<void>((resolve) => {
      server?.closeAllConnections();
      server?.close(() => {
        resolve();
      });
    });
    const error = await daemonGet(base, LOCAL, { authorization: 'Bearer SECRET-KEY' }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DaemonHttpError);
    expect((error as DaemonHttpError).reason).toBe('unreachable');
    expect((error as DaemonHttpError).message).not.toContain('SECRET-KEY');
  });

  it('refuses a host outside the policy before any connection', async () => {
    let hits = 0;
    const base = await serve((_req, res) => {
      hits += 1;
      res.end();
    });
    await expect(
      daemonGet(base, { allowHosts: ['api.minimax.io'], timeoutMs: 500 }),
    ).rejects.toBeInstanceOf(InvalidInput);
    expect(hits).toBe(0);
  });
});
