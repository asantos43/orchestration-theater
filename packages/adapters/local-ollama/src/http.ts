// SPDX-License-Identifier: MPL-2.0
import { AdapterUnavailable, InvalidInput } from '@otheater/core';

/** Largest answer read from the server. The endpoints used here answer a few KB at most. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Status and text body of one answer. */
export interface HttpAnswer {
  readonly status: number;
  readonly body: string;
}

/**
 * Turns the configured base URL into the URL of one endpoint (`path` is relative, no leading
 * slash). Only `http:` and `https:` are accepted, with no credentials in the URL (they would be
 * a secret sitting in the configuration file). A path prefix in the base is kept, so a server
 * behind a reverse proxy at `http://host/ollama/` is reached at `http://host/ollama/api/version`.
 *
 * @throws InvalidInput when the URL is not usable. The message never echoes the URL itself.
 */
export function endpointUrl(base: string, path: string): URL {
  let url: URL;
  try {
    url = new URL(base);
  } catch (error) {
    throw new InvalidInput('The server URL is not a valid URL', { cause: error });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidInput(`The server URL must use http: or https:, got ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidInput('The server URL must not carry credentials');
  }
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return new URL(path, url);
}

/** Short reason of a failed `fetch`, from the error code of the connection when there is one. */
function describeFailure(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `no answer within ${String(timeoutMs)} ms`;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') {
    return cause.code;
  }
  return error instanceof Error ? error.message : 'unknown error';
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
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new AdapterUnavailable(`The server answered more than ${String(MAX_BODY_BYTES)} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * GET with a deadline that covers the connection, the headers and the body. Redirects are not
 * followed (a local server has no reason to send the client elsewhere).
 *
 * @throws AdapterUnavailable when the server cannot be reached, does not answer in `timeoutMs`
 *   or answers more than {@link MAX_BODY_BYTES}.
 */
export async function getText(url: URL, timeoutMs: number): Promise<HttpAnswer> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await readCapped(response) };
  } catch (error) {
    if (error instanceof AdapterUnavailable) throw error;
    throw new AdapterUnavailable(
      `Ollama at ${url.origin} did not answer ${url.pathname}: ${describeFailure(error, timeoutMs)}`,
      { cause: error },
    );
  }
}
