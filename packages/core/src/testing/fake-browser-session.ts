// SPDX-License-Identifier: MPL-2.0
import { NotFound, PermissionDenied } from '../errors.js';
import type { AdapterImplements } from '../ports/adapter.js';
import {
  BROWSER_SESSION_PORT_VERSION,
  type BrowserCapabilities,
  type BrowserPageState,
  type BrowserRead,
  type BrowserReadOptions,
  type BrowserScope,
  type BrowserSession,
  type BrowserShot,
} from '../ports/browser-session.js';

/** What a made-up page holds: the text and the tree `read` returns. */
export interface FakePage {
  readonly title?: string;
  readonly text?: string;
  /** Lines with `[ref=eN]`; the fake accepts the refs it finds in it. */
  readonly tree?: string;
}

export type BrowserMethod =
  'open' | 'read' | 'screenshot' | 'click' | 'fill' | 'pressKey' | 'closeScenario' | 'close';

/** One call the fake received, for the assertions of a test. */
export interface BrowserCall {
  readonly method: BrowserMethod;
  readonly scenarioId: string;
  readonly args: readonly unknown[];
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A browser in memory: no Chromium. Pages are made up with {@link addPage}; `open` asks the
 * guard of the scope for the URL, like a real adapter does, and a URL nobody made up opens as an
 * empty page. Every call is recorded in {@link calls}.
 */
export class FakeBrowserSession implements BrowserSession {
  readonly id = 'fake';
  readonly implements: AdapterImplements = {
    port: 'BrowserSession',
    range: `^${BROWSER_SESSION_PORT_VERSION}`,
  };

  readonly calls: BrowserCall[] = [];

  readonly #pages = new Map<string, FakePage>();
  readonly #current = new Map<string, { url: string; page: FakePage }>();
  #closed = false;

  /** Makes up the page `url` serves. */
  addPage(url: string, page: FakePage): void {
    this.#pages.set(url, page);
  }

  /** How many times `method` was called. */
  callCount(method: BrowserMethod): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  capabilities(): BrowserCapabilities {
    return { profiles: ['shared', 'per_scenario'], extension: false };
  }

  async open(scope: BrowserScope, url: string): Promise<BrowserPageState> {
    this.#record('open', scope, url);
    const verdict = await scope.guard({ url, navigation: true });
    if (!verdict.allow) throw new PermissionDenied(`Page refused: ${verdict.reason}`);
    const page = this.#pages.get(url) ?? {};
    this.#current.set(scope.scenarioId, { url, page });
    return stateOf(url, page);
  }

  read(scope: BrowserScope, options: BrowserReadOptions): Promise<BrowserRead> {
    this.#record('read', scope, options);
    try {
      const { url, page } = this.#need(scope);
      const text = page.text ?? '';
      const tree = page.tree ?? '';
      const max = options.maxChars;
      return Promise.resolve({
        ...stateOf(url, page),
        text: text.slice(0, max),
        tree: tree.slice(0, max),
        truncated: text.length > max || tree.length > max,
      });
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  screenshot(scope: BrowserScope, ref?: string): Promise<BrowserShot> {
    this.#record('screenshot', scope, ref);
    try {
      const { url, page } = this.#need(scope);
      if (ref !== undefined) this.#needRef(page, ref);
      return Promise.resolve({
        ...stateOf(url, page),
        mimeType: 'image/png',
        data: PNG_SIGNATURE,
      });
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  click(scope: BrowserScope, ref: string): Promise<BrowserPageState> {
    return this.#act('click', scope, ref);
  }

  fill(scope: BrowserScope, ref: string, value: string): Promise<BrowserPageState> {
    return this.#act('fill', scope, ref, value);
  }

  pressKey(scope: BrowserScope, key: string): Promise<BrowserPageState> {
    this.#record('pressKey', scope, key);
    try {
      const { url, page } = this.#need(scope);
      return Promise.resolve(stateOf(url, page));
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  state(scenarioId: string): Promise<BrowserPageState | undefined> {
    const current = this.#current.get(scenarioId);
    return Promise.resolve(current === undefined ? undefined : stateOf(current.url, current.page));
  }

  closeScenario(scenarioId: string): Promise<void> {
    this.calls.push({ method: 'closeScenario', scenarioId, args: [] });
    this.#current.delete(scenarioId);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.calls.push({ method: 'close', scenarioId: '', args: [] });
    this.#closed = true;
    this.#current.clear();
    return Promise.resolve();
  }

  #act(
    method: 'click' | 'fill',
    scope: BrowserScope,
    ref: string,
    ...rest: unknown[]
  ): Promise<BrowserPageState> {
    this.#record(method, scope, ref, ...rest);
    try {
      const { url, page } = this.#need(scope);
      this.#needRef(page, ref);
      return Promise.resolve(stateOf(url, page));
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  #record(method: BrowserMethod, scope: BrowserScope, ...args: unknown[]): void {
    this.calls.push({ method, scenarioId: scope.scenarioId, args });
  }

  #need(scope: BrowserScope): { url: string; page: FakePage } {
    const current = this.#current.get(scope.scenarioId);
    if (current === undefined) throw new NotFound('No page is open: use open first');
    return current;
  }

  #needRef(page: FakePage, ref: string): void {
    if (!(page.tree ?? '').includes(`[ref=${ref}]`)) {
      throw new NotFound(`Unknown ref ${ref}: read the page again`);
    }
  }
}

function stateOf(url: string, page: FakePage): BrowserPageState {
  return { url, title: page.title ?? '' };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
