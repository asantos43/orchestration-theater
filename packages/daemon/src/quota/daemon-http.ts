// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, InvalidInput } from '@otheater/core';
import { hostAllowed } from '../tools/http-get.js';

/**
 * The network policy of the daemon for the calls it makes itself (P8; architecture 5.6: layer 3 of
 * the permissions does not apply to them, the daemon is the one calling). [proposta] There was no
 * such policy before; this is its first and only user, the MiniMax quota probe. The rules:
 * - the host must be in the allowlist the caller passes (`quota.minimax.allow_hosts`), the same
 *   matching as `network.allow` of a role (`hostAllowed`);
 * - `https:` only, except for a loopback host (`127.0.0.1`, `[::1]`, `localhost`), where `http:` is
 *   accepted so a test can use a fake server on an ephemeral port;
 * - no credentials in the URL, no redirect followed, a deadline that covers connection, headers and
 *   body, and a cap on the size of the body;
 * - the headers (the `Authorization` of a key) go only to that one request: they are never put in
 *   an error, a log or the URL.
 */

/** Largest body the daemon reads from one of its own calls. */
export const DAEMON_HTTP_MAX_BYTES = 256 * 1024;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** Why a call of the daemon did not give an answer. */
export type DaemonHttpFailure = 'timeout' | 'unreachable' | 'too_large';

/** The call failed before an HTTP answer: no connection, no answer in time, or a body too big. */
export class DaemonHttpError extends AdapterUnavailable {
  readonly reason: DaemonHttpFailure;

  constructor(reason: DaemonHttpFailure, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

export interface DaemonNetworkPolicy {
  /** Hosts the daemon may call (`hostAllowed` patterns: exact, or `*.suffix`). */
  readonly allowHosts: readonly string[];
  /** Deadline of the whole call, in ms. */
  readonly timeoutMs: number;
}

/** What came back: the status, the text of the body and the `Retry-After` header, if any. */
export interface DaemonHttpAnswer {
  readonly status: number;
  readonly body: string;
  /** `Retry-After` in ms (seconds or an HTTP date), when the answer carries a readable one. */
  readonly retryAfterMs?: number;
}

/**
 * Checks `raw` against the policy and returns the URL to call.
 *
 * @throws InvalidInput when the URL is not one the daemon may call. The message names the host
 *   and the rule, never the query or any header.
 */
export function checkedUrl(
  raw: string | URL,
  policy: Pick<DaemonNetworkPolicy, 'allowHosts'>,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new InvalidInput('The address is not a valid URL', { cause: error });
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidInput('The address must not carry credentials');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new InvalidInput(
      `The daemon calls only https addresses (http only for a loopback host), not ${url.protocol}//${url.hostname}`,
    );
  }
  if (!hostAllowed(url.hostname, policy.allowHosts)) {
    throw new InvalidInput(
      `The host ${url.hostname} is not in the network allowlist of the daemon` +
        (policy.allowHosts.length === 0 ? ' (the list is empty)' : ''),
    );
  }
  return url;
}

/** `Retry-After` as ms: a number of seconds, or an HTTP date. `undefined` when it is neither. */
export function retryAfterMsOf(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > DAEMON_HTTP_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new DaemonHttpError(
        'too_large',
        `The answer is larger than ${String(DAEMON_HTTP_MAX_BYTES)} bytes`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * GET under the policy. Resolves with the status and the body of whatever the server answered
 * (a 429 or a 500 is an answer, not a failure); rejects with `InvalidInput` when the policy
 * refuses the address, and with {@link DaemonHttpError} when there is no answer.
 *
 * `now` is only used to read a `Retry-After` given as a date.
 */
export async function daemonGet(
  raw: string | URL,
  policy: DaemonNetworkPolicy,
  headers: Readonly<Record<string, string>> = {},
  now: () => number = Date.now,
): Promise<DaemonHttpAnswer> {
  const url = checkedUrl(raw, policy);
  const where = `${url.protocol}//${url.host}${url.pathname}`;
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(policy.timeoutMs),
    });
    const body = await readCapped(response);
    const retryAfterMs = retryAfterMsOf(response.headers.get('retry-after'), now());
    return {
      status: response.status,
      body,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  } catch (error) {
    if (error instanceof DaemonHttpError) throw error;
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new DaemonHttpError(
        'timeout',
        `No answer from ${where} within ${String(policy.timeoutMs)} ms`,
        { cause: error },
      );
    }
    // The cause of a failed fetch is the connection error; keep its code, drop the rest.
    const cause = error instanceof Error ? error.cause : undefined;
    const code =
      cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : 'connection failed';
    throw new DaemonHttpError('unreachable', `Could not reach ${where}: ${code}`, {
      cause: error,
    });
  }
}
