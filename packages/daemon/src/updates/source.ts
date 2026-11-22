// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import type { UpdateChannel } from '@otheater/protocol';
import { z } from 'zod';
import { isLoopbackHost } from '../config.js';
import { UpdateStop } from './errors.js';
import { MAX_MANIFEST_BYTES, MAX_SIGNATURE_BYTES } from './manifest.js';

/**
 * Where a release comes from (Phase 10, P7; architecture 5.21). Two origins: the releases of the
 * public repository on GitHub (`github`, with no credential of any kind: only what an anonymous
 * browser reads) and a base address of the owner's choice (`url`: `<base>/manifest.json`,
 * `<base>/manifest.json.sig` and the files the manifest names). What an origin serves is never
 * trusted: the signature and the hashes are checked by the checker, whatever the origin.
 *
 * [proposta] The rules of every request, so that a wrong origin or a man in the middle gets
 * nothing: `https://` (or `http://` on the loopback, for tests); a redirect is followed up to 5
 * times and never from `https://` to `http://`; no `Authorization` header and no cookies; the
 * manifest and the signature have a size cap; a download stops as soon as it is bigger than the
 * manifest says; every request has a time limit. The `fetch` is injected, so the tests never use
 * the network.
 */

export type FetchFunction = typeof fetch;

/** The repository the releases of OTheater are published in (public). */
export const GITHUB_REPOSITORY = 'asantos43/orchestration-theater';

const MAX_REDIRECTS = 5;
const MAX_RELEASE_LIST_BYTES = 2 * 1024 * 1024;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** What an origin gives for one release: the two small files and where the big ones are. */
export interface ReleaseFiles {
  /** The exact bytes of `manifest.json`. */
  readonly manifest: Uint8Array;
  /** The text of `manifest.json.sig` (base64). */
  readonly signature: string;
  /** The address of a file of the release (an asset of the manifest). */
  readonly fileUrl: (name: string) => string;
}

export interface UpdateSource {
  readonly kind: 'github' | 'url';
  /**
   * The newest release of the channel, or `undefined` when the origin has none yet (GitHub with no
   * release, or no prerelease). It throws {@link UpdateStop}: `no_network` and `bad_response`.
   */
  fetchRelease(channel: UpdateChannel, signal?: AbortSignal): Promise<ReleaseFiles | undefined>;
  /**
   * Writes a file of the release to `destination` (new; it fails when it exists) and says what it
   * got. It stops, with `size`, when the file is bigger than `maxBytes`.
   */
  download(
    url: string,
    destination: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ readonly size: number; readonly sha256: string }>;
}

export interface UpdateSourceOptions {
  readonly fetch?: FetchFunction | undefined;
  /** For one small request, in ms (default 30 s). */
  readonly requestTimeoutMs?: number | undefined;
  /** For one download, in ms (default 20 min). */
  readonly downloadTimeoutMs?: number | undefined;
}

export type UpdateSourceSpec =
  | { readonly kind: 'github'; readonly repository?: string | undefined }
  | { readonly kind: 'url'; readonly url: string };

/** `https://`, or `http://` on the loopback. */
export function isAllowedUpdateUrl(url: URL): boolean {
  if (url.username !== '' || url.password !== '') return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
}

function stopOf(error: unknown): UpdateStop {
  if (error instanceof UpdateStop) return error;
  return new UpdateStop('no_network', error instanceof Error ? error.message : String(error));
}

class HttpClient {
  readonly #fetch: FetchFunction;
  readonly #timeout: number;
  readonly #downloadTimeout: number;

  constructor(options: UpdateSourceOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeout = options.requestTimeoutMs ?? 30_000;
    this.#downloadTimeout = options.downloadTimeoutMs ?? 20 * 60_000;
  }

  /** The response of a GET after the redirects; the caller reads (or cancels) the body. */
  async get(
    address: string,
    accept: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    let url = parseUrl(address);
    const secure = url.protocol === 'https:';
    const limit = AbortSignal.timeout(timeoutMs);
    const both = signal === undefined ? limit : AbortSignal.any([signal, limit]);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          headers: { accept, 'user-agent': 'otheater-updater' },
          signal: both,
        });
      } catch (error) {
        throw new UpdateStop(
          'no_network',
          `the origin could not be reached (${error instanceof Error ? error.name : 'error'})`,
        );
      }
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (location === null) throw new UpdateStop('bad_response', 'a redirect with no location');
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new UpdateStop('bad_response', 'a redirect to an address that is not one');
      }
      if (!isAllowedUpdateUrl(next) || (secure && next.protocol !== 'https:')) {
        throw new UpdateStop('bad_response', 'a redirect to an address that is not allowed');
      }
      url = next;
    }
    throw new UpdateStop('bad_response', 'too many redirects');
  }

  /** A body up to `maxBytes`; more is `bad_response`. */
  async bytes(
    address: string,
    accept: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly status: number; readonly body: Uint8Array }> {
    const response = await this.get(address, accept, signal, this.#timeout);
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, body: new Uint8Array() };
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpdateStop('bad_response', 'an answer bigger than the limit');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      if (response.body !== null) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            throw new UpdateStop('bad_response', 'an answer bigger than the limit');
          }
          chunks.push(chunk);
        }
      }
    } catch (error) {
      throw error instanceof UpdateStop
        ? error
        : new UpdateStop('no_network', 'the answer was cut before its end');
    }
    return { status: 200, body: Buffer.concat(chunks) };
  }

  async download(
    address: string,
    destination: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly size: number; readonly sha256: string }> {
    const response = await this.get(
      address,
      'application/octet-stream',
      signal,
      this.#downloadTimeout,
    );
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new UpdateStop('bad_response', `the origin answered ${String(response.status)}`);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) {
      await response.body.cancel().catch(() => undefined);
      throw new UpdateStop('size', 'the file is bigger than the manifest says');
    }
    let file: FileHandle;
    try {
      file = await open(destination, 'wx', 0o600);
    } catch (error) {
      await response.body.cancel().catch(() => undefined);
      throw new UpdateStop('storage', `the download could not be started (${errorCode(error)})`);
    }
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maxBytes)
          throw new UpdateStop('size', 'the file is bigger than the manifest says');
        hash.update(chunk);
        try {
          await file.write(chunk);
        } catch (error) {
          throw new UpdateStop(
            'storage',
            `the download could not be written (${errorCode(error)})`,
          );
        }
      }
    } catch (error) {
      if (error instanceof UpdateStop) throw error;
      throw new UpdateStop('no_network', 'the download was cut before its end');
    } finally {
      await file.close().catch(() => undefined);
    }
    return { size, sha256: hash.digest('hex') };
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'error';
}

function parseUrl(address: string): URL {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new UpdateStop('bad_response', 'an address that is not one');
  }
  if (!isAllowedUpdateUrl(url))
    throw new UpdateStop('bad_response', 'an address that is not allowed');
  return url;
}

const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ReleaseListSchema = z.array(
  z.object({
    tag_name: z.string().regex(TAG),
    prerelease: z.boolean(),
    draft: z.boolean().optional(),
  }),
);

function decodeSignature(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function releaseAt(
  http: HttpClient,
  base: string,
  signal: AbortSignal | undefined,
  missingIsEmpty: boolean,
): Promise<ReleaseFiles | undefined> {
  const manifest = await http.bytes(
    `${base}manifest.json`,
    'application/json',
    MAX_MANIFEST_BYTES,
    signal,
  );
  if (manifest.status === 404 && missingIsEmpty) return undefined;
  if (manifest.status !== 200) {
    throw new UpdateStop('bad_response', `the manifest answered ${String(manifest.status)}`);
  }
  const signature = await http.bytes(
    `${base}manifest.json.sig`,
    'text/plain',
    MAX_SIGNATURE_BYTES,
    signal,
  );
  if (signature.status !== 200) {
    throw new UpdateStop('bad_response', `the signature answered ${String(signature.status)}`);
  }
  return {
    manifest: manifest.body,
    signature: decodeSignature(signature.body),
    fileUrl: (name) => `${base}${encodeURIComponent(name)}`,
  };
}

/** The origin the configuration names. */
export function createUpdateSource(
  spec: UpdateSourceSpec,
  options: UpdateSourceOptions = {},
): UpdateSource {
  const http = new HttpClient(options);
  const download: UpdateSource['download'] = async (url, destination, maxBytes, signal) => {
    try {
      return await http.download(url, destination, maxBytes, signal);
    } catch (error) {
      throw stopOf(error);
    }
  };

  if (spec.kind === 'url') {
    const base = spec.url.endsWith('/') ? spec.url : `${spec.url}/`;
    return {
      kind: 'url',
      fetchRelease: async (_channel, signal) => {
        try {
          return await releaseAt(http, base, signal, false);
        } catch (error) {
          throw stopOf(error);
        }
      },
      download,
    };
  }

  const repository = spec.repository ?? GITHUB_REPOSITORY;
  return {
    kind: 'github',
    fetchRelease: async (channel, signal) => {
      try {
        if (channel === 'stable') {
          return await releaseAt(
            http,
            `https://github.com/${repository}/releases/latest/download/`,
            signal,
            true,
          );
        }
        const list = await http.bytes(
          `https://api.github.com/repos/${repository}/releases?per_page=30`,
          'application/vnd.github+json',
          MAX_RELEASE_LIST_BYTES,
          signal,
        );
        if (list.status !== 200) {
          throw new UpdateStop(
            'bad_response',
            `the list of releases answered ${String(list.status)}`,
          );
        }
        let parsed: z.infer<typeof ReleaseListSchema>;
        try {
          parsed = ReleaseListSchema.parse(JSON.parse(new TextDecoder().decode(list.body)));
        } catch {
          throw new UpdateStop('bad_response', 'the list of releases is not what was expected');
        }
        const first = parsed.find((release) => release.prerelease && release.draft !== true);
        if (first === undefined) return undefined;
        return await releaseAt(
          http,
          `https://github.com/${repository}/releases/download/${first.tag_name}/`,
          signal,
          false,
        );
      } catch (error) {
        throw stopOf(error);
      }
    },
    download,
  };
}
