// SPDX-License-Identifier: MPL-2.0
import { OutputCollector } from '@otheater/core';
import { ToolFailure, type ToolCall, type ToolHandler } from '../mcp/handlers.js';
import { ToolRefusal, ToolTimeout, type ToolDone, type ToolsContext } from './context.js';
import type { ToolSettings } from './settings.js';

/**
 * The most bytes of a body `http_get` reads, whatever `tools.output_max_bytes` says: past it the
 * rest is not even downloaded. [proposta] A guard of the daemon's memory and bandwidth, not a
 * setting the Executor can feel.
 */
export const HTTP_READ_CAP_BYTES = 16 * 1024 * 1024;

/** How many redirects `tools.http.redirects: follow_allowed` follows. [proposta] */
export const HTTP_MAX_REDIRECTS = 5;

function normalizeHost(host: string): string {
  let out = host.trim().toLowerCase();
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  return out.endsWith('.') ? out.slice(0, -1) : out;
}

/**
 * True when `hostname` is one of the `allow` entries: a host (`example.com`, `127.0.0.1`) matches
 * itself only, `*.example.com` matches every subdomain but not `example.com` itself, and a bare
 * `*` matches nothing (there is no way to say "everything"; the sandbox is for that).
 */
export function hostAllowed(hostname: string, allow: readonly string[]): boolean {
  const host = normalizeHost(hostname);
  if (host === '') return false;
  return allow.some((entry) => {
    const pattern = normalizeHost(entry);
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      return suffix.length > 1 && host.length > suffix.length && host.endsWith(suffix);
    }
    return pattern !== '' && !pattern.includes('*') && pattern === host;
  });
}

function checkedUrl(raw: string | URL, allow: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolRefusal('invalid_url', `${String(raw)} is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolRefusal(
      'invalid_url',
      `Only http and https URLs are fetched, not ${url.protocol}`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new ToolRefusal('invalid_url', 'A URL with credentials is not fetched.');
  }
  if (!hostAllowed(url.hostname, allow)) {
    throw new ToolRefusal(
      'domain_not_allowed',
      `The host ${url.hostname} is not in the network.allow of this role.` +
        (allow.length === 0 ? ' The role may reach no domain.' : ` Allowed: ${allow.join(', ')}.`),
    );
  }
  return url;
}

async function readBody(
  response: Response,
  collector: OutputCollector,
): Promise<{ capped: boolean }> {
  const { body } = response;
  if (body === null) return { capped: false };
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { capped: false };
      collector.push(value);
      if (collector.totalBytes >= HTTP_READ_CAP_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { capped: true };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function httpGet(
  context: ToolsContext,
  call: ToolCall,
  settings: ToolSettings,
): Promise<ToolDone> {
  const { clock } = context.deps;
  const fetcher = context.deps.fetch ?? globalThis.fetch;
  const { url: asked } = call.input as { url: string };
  const allow = call.caller.networkAllow ?? [];
  const { timeout_ms, redirects } = settings.config.http;
  const { output_max_bytes, truncate } = settings.config;

  let current = checkedUrl(asked, allow);
  const request = new AbortController();
  const timer = new AbortController();
  const state = { timedOut: false };
  void clock.sleep(timeout_ms, timer.signal).then(
    () => {
      state.timedOut = true;
      request.abort();
    },
    () => undefined,
  );

  try {
    for (let hop = 0; ; hop += 1) {
      const response = await fetcher(current, {
        redirect: 'manual',
        signal: request.signal,
        headers: { accept: '*/*', 'user-agent': 'OTheater-http_get' },
      });
      const location = response.headers.get('location');
      if (
        redirects === 'follow_allowed' &&
        response.status >= 300 &&
        response.status < 400 &&
        location !== null
      ) {
        await response.body?.cancel().catch(() => undefined);
        if (hop >= HTTP_MAX_REDIRECTS) {
          throw new ToolFailure(
            'too_many_redirects',
            `More than ${String(HTTP_MAX_REDIRECTS)} redirects from ${asked}.`,
          );
        }
        current = checkedUrl(new URL(location, current), allow);
        continue;
      }
      const collector = new OutputCollector(output_max_bytes, truncate);
      const { capped } = await readBody(response, collector);
      const cut = collector.result();
      const truncated = cut.truncated || capped;
      return {
        reply: {
          url: current.href,
          status: response.status,
          contentType: response.headers.get('content-type'),
          body: cut.text,
          truncated,
          originalBytes: cut.originalBytes,
          untrusted: true,
        },
        outcome: 'ok',
        outputBytes: cut.originalBytes,
        truncated,
      };
    }
  } catch (error) {
    if (state.timedOut) {
      throw new ToolTimeout('timeout', `${asked} did not answer within ${String(timeout_ms)} ms.`);
    }
    if (error instanceof ToolFailure) throw error;
    const why = error instanceof Error ? error.message : String(error);
    throw new ToolFailure('fetch_failed', `Could not fetch ${asked}: ${why}`);
  } finally {
    timer.abort();
  }
}

/**
 * `http_get {url}` (architecture 5.8): a GET of a page the role may read, for the roles that have
 * the tool (the actor and the consultant).
 *
 * - Only `http` and `https`, no credentials in the URL, and only a host of the `network.allow` of
 *   the role (`domain_not_allowed` otherwise). The check is on the name; resolving a name to a
 *   private address is the sandbox's business (P4).
 * - A redirect is NOT followed by default (`tools.http.redirects: refuse`: the answer is the 3xx
 *   itself); `follow_allowed` follows up to 5, each target checked again.
 * - The body is cut to `tools.output_max_bytes` and goes back marked `untrusted: true`: it is data
 *   from the network, never instructions for the Executor.
 */
export function httpToolHandlers(context: ToolsContext): Record<string, ToolHandler> {
  return {
    http_get: (call) =>
      context.track(call, (call.input as { url: string }).url, (settings) =>
        httpGet(context, call, settings),
      ),
  };
}
