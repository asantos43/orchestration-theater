// SPDX-License-Identifier: MPL-2.0

/** What the REST client and the streaming clients share about HTTP. Browser-safe. */

/** The part of `fetch` the clients use; tests and other runtimes pass their own. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** `Retry-After` as seconds (the HTTP date form is not used by the daemon). */
export function retryAfterSeconds(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

/** What the failure of `fetch` says, short: the error code of the socket, or its message. */
export function networkDetail(cause: unknown): { detail?: string } {
  const inner = (cause as { cause?: unknown } | undefined)?.cause ?? cause;
  const code = (inner as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string') return { detail: code };
  if (inner instanceof Error) return { detail: inner.message };
  return {};
}

/** An empty body is `undefined`; anything else must be JSON. */
export function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
