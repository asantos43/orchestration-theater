// SPDX-License-Identifier: MPL-2.0
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { AdapterUnavailable } from '@otheater/core';
import type { BrowserFileUrlMode } from '../config.js';
import type { Logger } from '../logger.js';

/**
 * Says whether a path is a secret (`security.secret_paths`, owned by P4). It must say `true` when
 * it cannot tell; a throw is read as `true`.
 */
export type IsSecretPath = (path: string) => boolean | Promise<boolean>;

/** What one scenario may reach through `file://`, as `browser.file_urls` says. */
export interface FileGrant {
  readonly mode: BrowserFileUrlMode;
  /** The folders of the scenario (`file_urls: scenario`). */
  readonly roots: readonly string[];
}

export type FileCheck =
  | { readonly ok: true; readonly real: string }
  | {
      readonly ok: false;
      readonly kind: 'refused' | 'not_found';
      readonly code: string;
      readonly reason: string;
    };

export interface FileRefusal {
  readonly scenarioId: string;
  readonly path: string;
  readonly code: string;
  readonly reason: string;
}

export interface FileOriginOptions {
  readonly isSecret?: IsSecretPath | undefined;
  /** A request of a page the origin refused (the call that opened the page never saw it). */
  readonly onRefused?: ((refusal: FileRefusal) => void) | undefined;
  readonly logger?: Logger | undefined;
}

const FILES_PREFIX = '/files/';
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  // Plain text a person may want to read in the browser.
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
};

function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * The local origin the daemon serves files on (architecture 5.19, "Como o `file://` é aplicado").
 * The browser never loads `file:`: `browser_open file:///x` is turned into
 * `http://127.0.0.1:<port>/files/<token>/x`, so the DAEMON decides, request by request, what the
 * page may read, and a link, a script or an image of the page obeys the same rule as the page.
 *
 * - The token belongs to ONE scenario (the guard of another scenario refuses its URLs) and is not
 *   in any event or reply: the agent and the log see `file:///x`, see {@link presentUrl}.
 * - Every request goes through {@link check}: the path as written and the path after the links
 *   are followed must both pass the secret list, and `file_urls: scenario` also confines them to
 *   the folders of the scenario. A path that cannot be checked is refused.
 * - Only `GET` and `HEAD`, only the names of this machine in `Host` (a DNS rebinding cannot talk to
 *   it), no CORS headers, `nosniff`, no cache. A directory is not listed.
 *
 * [N] Windows and macOS paths (drive letters, case folding) follow the code but were not tried.
 */
export class FileOrigin {
  readonly #server: Server;
  readonly #port: number;
  readonly #isSecret: IsSecretPath | undefined;
  readonly #onRefused: ((refusal: FileRefusal) => void) | undefined;
  readonly #logger: Logger | undefined;
  readonly #byScenario = new Map<string, { token: string; grant: FileGrant }>();
  readonly #byToken = new Map<string, string>();
  #stopped = false;

  private constructor(server: Server, port: number, options: FileOriginOptions) {
    this.#server = server;
    this.#port = port;
    this.#isSecret = options.isSecret;
    this.#onRefused = options.onRefused;
    this.#logger = options.logger;
  }

  /** Starts listening on `127.0.0.1`, on a port the system picks. */
  static async start(options: FileOriginOptions = {}): Promise<FileOrigin> {
    const hook: { dispatch?: (request: IncomingMessage, response: ServerResponse) => void } = {};
    const server = createServer((request, response) => {
      if (hook.dispatch === undefined) {
        response.writeHead(503).end();
        return;
      }
      hook.dispatch(request, response);
    });
    server.keepAliveTimeout = 1000;
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', fail);
        done();
      });
    }).catch((cause: unknown) => {
      throw new AdapterUnavailable('The file origin could not listen on 127.0.0.1.', { cause });
    });
    const origin = new FileOrigin(server, (server.address() as AddressInfo).port, options);
    hook.dispatch = (request, response) => {
      origin.#handle(request, response).catch((error: unknown) => {
        origin.#logger?.warn({ err: error }, 'the file origin failed on a request');
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    };
    return origin;
  }

  get port(): number {
    return this.#port;
  }

  /** `http://127.0.0.1:<port>`, with no token: the browser reaches the files only under it. */
  get origin(): string {
    return `http://127.0.0.1:${String(this.#port)}`;
  }

  /**
   * Sets what `scenarioId` may reach and returns its token (the same one for as long as the
   * scenario lives: a page that is open keeps working, under the new rule, when the configuration
   * changes).
   */
  grant(scenarioId: string, grant: FileGrant): string {
    const known = this.#byScenario.get(scenarioId);
    if (known !== undefined) {
      known.grant = grant;
      return known.token;
    }
    const token = randomBytes(24).toString('base64url');
    this.#byScenario.set(scenarioId, { token, grant });
    this.#byToken.set(token, scenarioId);
    return token;
  }

  /** Takes the token of a scenario back: its served pages stop answering. */
  revoke(scenarioId: string): void {
    const known = this.#byScenario.get(scenarioId);
    if (known === undefined) return;
    this.#byScenario.delete(scenarioId);
    this.#byToken.delete(known.token);
  }

  /** The URL the browser opens for the file `path` of a scenario; `suffix` is `?query#fragment`. */
  urlFor(scenarioId: string, path: string, suffix = ''): string {
    const known = this.#byScenario.get(scenarioId);
    if (known === undefined) throw new Error(`the scenario ${scenarioId} has no file grant`);
    const segments = path
      .split(/[\\/]+/)
      .filter((segment) => segment !== '')
      .map((segment) => encodeURIComponent(segment));
    return `${this.origin}${FILES_PREFIX}${known.token}/${segments.join('/')}${suffix}`;
  }

  #isOurs(url: URL): boolean {
    return (
      url.protocol === 'http:' &&
      LOCAL_NAMES.has(url.hostname.toLowerCase()) &&
      Number(url.port) === this.#port
    );
  }

  /**
   * How a request of the page of `scenarioId` stands for the guard: `foreign` (not this origin: the
   * other rules decide), `allowed` (a file of the scenario's own token: {@link check} decides when
   * the request arrives), `refused` (this origin, but not the scenario's own files).
   */
  judge(scenarioId: string, url: URL): 'foreign' | 'allowed' | 'refused' {
    if (!this.#isOurs(url)) return 'foreign';
    const known = this.#byScenario.get(scenarioId);
    if (known === undefined) return 'refused';
    return url.pathname.startsWith(`${FILES_PREFIX}${known.token}/`) ? 'allowed' : 'refused';
  }

  /** The URL as the agent and the log should see it: `file:///x` for a served file, else as it is. */
  presentUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return raw;
    }
    if (!this.#isOurs(url) || !url.pathname.startsWith(FILES_PREFIX)) return raw;
    const rest = url.pathname.slice(FILES_PREFIX.length);
    const slash = rest.indexOf('/');
    const path = slash === -1 ? '' : rest.slice(slash);
    return `file://${path}${url.search}${url.hash}`;
  }

  /** Text of a page with every served-file URL written back as `file:///...` (no token in it). */
  scrub(text: string): string {
    const origin = this.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`${origin}${FILES_PREFIX}[A-Za-z0-9_-]+/`, 'g'), 'file:///');
  }

  /** The filesystem path a URL of this origin names, for a scenario's own token. */
  #pathOf(url: URL): { scenarioId: string; path: string } | undefined {
    if (!url.pathname.startsWith(FILES_PREFIX)) return undefined;
    const rest = url.pathname.slice(FILES_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash === -1) return undefined;
    const scenarioId = this.#byToken.get(rest.slice(0, slash));
    if (scenarioId === undefined) return undefined;
    const segments = rest
      .slice(slash + 1)
      .split('/')
      .filter((segment) => segment !== '');
    const decoded: string[] = [];
    for (const segment of segments) {
      let value: string;
      try {
        value = decodeURIComponent(segment);
      } catch {
        return undefined;
      }
      if (
        value === '.' ||
        value === '..' ||
        value.includes('/') ||
        value.includes('\\') ||
        value.includes('\0')
      ) {
        return undefined;
      }
      decoded.push(value);
    }
    const first = decoded[0];
    const path =
      sep === '\\' && first !== undefined && /^[A-Za-z]:$/.test(first)
        ? decoded.join('\\')
        : `${sep}${decoded.join(sep)}`;
    return { scenarioId, path };
  }

  /**
   * Whether the scenario may read `path`, by its `file_urls` rule. The secret check comes first
   * and on the path as written, so a refused path does not tell whether the file exists; then the
   * links are followed and the real path is checked again (a link in the worktree that points at
   * `~/.ssh` is the way around a list of names).
   */
  async check(scenarioId: string, path: string): Promise<FileCheck> {
    const known = this.#byScenario.get(scenarioId);
    if (known === undefined) {
      return refused('file_not_granted', 'This scenario has no access to files.');
    }
    const { mode, roots } = known.grant;
    if (mode === 'deny') {
      return refused('file_urls_denied', 'browser.file_urls is "deny": no file is opened.');
    }
    if (!isAbsolute(path)) return refused('invalid_path', 'A file URL needs an absolute path.');
    const written = resolve(path);

    const secret = await this.#secret(mode, written);
    if (secret !== undefined) return secret;

    let real: string;
    try {
      real = await realpath(written);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return {
          ok: false,
          kind: 'not_found',
          code: 'file_not_found',
          reason: `There is no file at ${written}.`,
        };
      }
      return refused('file_unreadable', `The file ${written} cannot be read.`);
    }
    if (real !== written) {
      const secretReal = await this.#secret(mode, real);
      if (secretReal !== undefined) return secretReal;
    }

    if (mode === 'scenario') {
      let inside = false;
      for (const root of roots) {
        const realRoot = await realpath(root).catch(() => undefined);
        if (realRoot !== undefined && isInside(real, realRoot)) inside = true;
      }
      if (!inside) {
        return refused(
          'outside_scenario',
          'browser.file_urls is "scenario": only the folders of the scenario are opened.',
        );
      }
    }

    try {
      if (!(await stat(real)).isFile()) {
        return refused('not_a_file', `${written} is not a file (folders are not listed).`);
      }
    } catch {
      return refused('file_unreadable', `The file ${written} cannot be read.`);
    }
    return { ok: true, real };
  }

  /** `undefined` when `path` may be read; else the refusal. */
  async #secret(mode: BrowserFileUrlMode, path: string): Promise<FileCheck | undefined> {
    if (mode === 'any') return undefined;
    if (this.#isSecret === undefined) {
      // `except_secrets` is a promise about a list: without one nothing is let through. `scenario`
      // confines to folders, which is its own rule.
      return mode === 'except_secrets'
        ? refused(
            'secret_list_unavailable',
            'The list of secret paths is not available, so no file is opened.',
          )
        : undefined;
    }
    try {
      if (await this.#isSecret(path)) {
        return refused('secret_path', 'This path is on the list of secret paths.');
      }
    } catch {
      return refused('secret_check_failed', 'The list of secret paths could not be checked.');
    }
    return undefined;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body = ''): void => {
      response.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      response.end(body);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply(405);
      return;
    }
    const host = (request.headers.host ?? '').toLowerCase();
    if (!LOCAL_NAMES.has(host.replace(/:\d+$/, '')) || !host.endsWith(`:${String(this.#port)}`)) {
      reply(403);
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? '/', this.origin);
    } catch {
      reply(400);
      return;
    }
    const target = this.#pathOf(url);
    if (target === undefined) {
      reply(404);
      return;
    }
    const checked = await this.check(target.scenarioId, target.path);
    if (!checked.ok) {
      if (checked.kind === 'not_found') {
        reply(404);
        return;
      }
      this.#onRefused?.({
        scenarioId: target.scenarioId,
        path: target.path,
        code: checked.code,
        reason: checked.reason,
      });
      reply(403, checked.reason);
      return;
    }
    response.writeHead(200, {
      'content-type': contentTypeOf(target.path),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    await pipeline(createReadStream(checked.real), response);
  }

  /** Stops listening and takes every token back. Idempotent. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#byScenario.clear();
    this.#byToken.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((done) => {
      this.#server.close(() => {
        done();
      });
    });
  }
}

function refused(code: string, reason: string): FileCheck {
  return { ok: false, kind: 'refused', code, reason };
}
