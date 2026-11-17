// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { freemem } from 'node:os';
import { join } from 'node:path';
import {
  AdapterUnavailable,
  BROWSER_SESSION_PORT_VERSION,
  InvalidInput,
  NotFound,
  OTheaterError,
  PermissionDenied,
  Transient,
  type AdapterImplements,
  type BrowserCapabilities,
  type BrowserGuard,
  type BrowserPageState,
  type BrowserRead,
  type BrowserReadOptions,
  type BrowserScope,
  type BrowserSession,
  type BrowserVerdict,
  type BrowserShot,
  type LaunchedProcess,
  type ProcessLauncher,
} from '@otheater/core';
import {
  chromium,
  errors as playwrightErrors,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Route,
} from 'playwright-core';
import { admitBrowser } from './admission.js';
import {
  assertChromiumInstalled,
  chromiumPath,
  launchChromium,
  type RunningChromium,
} from './chromium.js';
import { redactPasswordValues } from './redact.js';

/** Defaults of {@link PlaywrightBrowserOptions}; the daemon's `browser` block overrides each of them. */
export const DEFAULT_MIN_FREE_MEMORY_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_MAX_INSTANCES = 2;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;
/** Popups of one scenario that may be open at once; one more is closed at once. */
const MAX_PAGES_PER_SCENARIO = 8;
/** After a navigation was refused the next one may race the error page (measured: ~300 ms). */
const BLOCKED_SETTLE_MS = 300;
/** What an action waits for the page (or the popup) it started to show up. */
const SETTLE_MS = 150;
/** How long an action waits for a popup it saw coming (a first request with no frame). */
const POPUP_WAIT_MS = 3000;
const REF_PATTERN = /^[a-z0-9]+$/;

export interface PlaywrightBrowserOptions {
  /** Chromium is a child of this launcher (5.9): the daemon's, so a shutdown ends the whole tree. */
  readonly launcher: ProcessLauncher;
  /** Absolute directory where the profiles and the private `HOME` of the browsers live. */
  readonly profilesDir: string;
  /** The Chromium to run; none: the one `playwright-core` expects for its revision. */
  readonly executablePath?: string | undefined;
  /** False adds `--no-sandbox`. Default true. */
  readonly sandbox?: boolean | undefined;
  /** A browser is not started with less free RAM than this. Default 1 GiB. */
  readonly minFreeMemoryBytes?: number | undefined;
  /** Browsers at once. Default 2. */
  readonly maxInstances?: number | undefined;
  /** Time limit of a navigation or an action, in ms. Default 30000. */
  readonly timeoutMs?: number | undefined;
  /** Time limit of the start of a browser, in ms. Default 30000. */
  readonly launchTimeoutMs?: number | undefined;
  /** Free RAM in bytes; default `os.freemem()`. Injectable for the tests. */
  readonly freeMemoryBytes?: (() => number) | undefined;
  /** Memory ceiling of one browser tree, when the launcher can enforce it. */
  readonly memoryLimitBytes?: number | undefined;
  /** Where the adapter says something went wrong without failing the call. */
  readonly onWarning?: ((message: string) => void) | undefined;
}

/** One Chromium, and the scenarios that have a page in it. */
interface Instance {
  readonly key: string;
  readonly process: LaunchedProcess;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly scenarios: Set<string>;
  /** Which scenario owns a page (a popup is owned by the scenario of its opener). */
  readonly owners: WeakMap<Page, ScenarioState>;
  closed: boolean;
}

/** The page of one scenario, with the rule it must obey. */
interface ScenarioState {
  readonly scenarioId: string;
  readonly instance: Instance;
  guard: BrowserGuard;
  page: Page;
  /** The page and its popups: closed together with the scenario. */
  readonly pages: Set<Page>;
  /** A popup opened since the last action, to become the page of the scenario. */
  popup: Page | undefined;
  /** A popup was allowed through the gate and has not shown up as a page yet. */
  popupPending: boolean;
  /** Calls of this scenario running now (0 or 1: they are serialized). */
  acting: number;
  /** Why the guard refused the last request, for the error of a navigation that failed. */
  lastRefusal: string | undefined;
  blockedAt: number | undefined;
  /** Calls of one scenario run one after the other. */
  chain: Promise<unknown>;
}

/**
 * The `BrowserSession` over `playwright-core` and a Chromium of the daemon (architecture 5.19).
 *
 * - Chromium is a child of the process launcher, started headless with `--remote-debugging-port=0`
 *   (the port is read from its stderr) and driven by `connectOverCDP`. Playwright never spawns it.
 * - RAM admission (5.9) happens before a start: free memory and the number of browsers.
 * - Profiles: `shared` is one browser for every scenario (a page each), `per_scenario` is one
 *   browser and one profile directory for each. The browser of the `shared` profile ends with its
 *   last scenario; the profile stays on disk.
 * - Guard: ONE `context.route('**\/*')` sends every request of every page to the guard of the scenario
 *   that owns the page (a popup belongs to the scenario of its opener; a page nobody owns is refused).
 *   `file:` is aborted before the guard is asked: the daemon serves files on its own origin.
 * - Refs: the `ref` of an element is the one `ariaSnapshot({mode: 'ai'})` printed on the last `read`.
 * - Nothing here reads a cookie or returns the value of a password field.
 */
export class PlaywrightBrowserSession implements BrowserSession {
  readonly id = 'playwright';
  readonly implements: AdapterImplements = {
    port: 'BrowserSession',
    range: `^${BROWSER_SESSION_PORT_VERSION}`,
  };

  readonly #options: PlaywrightBrowserOptions;
  readonly #instances = new Map<string, Instance>();
  readonly #launching = new Map<string, Promise<Instance>>();
  readonly #states = new Map<string, ScenarioState>();
  #closed = false;

  constructor(options: PlaywrightBrowserOptions) {
    this.#options = options;
  }

  capabilities(): BrowserCapabilities {
    return { profiles: ['shared', 'per_scenario'], extension: false };
  }

  /** Browsers running now (the tests and the admission look at it). */
  get instanceCount(): number {
    return this.#instances.size + this.#launching.size;
  }

  async open(scope: BrowserScope, url: string): Promise<BrowserPageState> {
    const target = parseNavigable(url);
    const state = await this.#sessionFor(scope);
    return this.#serial(state, async () => {
      state.guard = scope.guard;
      state.lastRefusal = undefined;
      if (state.blockedAt !== undefined) {
        const wait = BLOCKED_SETTLE_MS - (Date.now() - state.blockedAt);
        if (wait > 0) await sleep(wait);
        state.blockedAt = undefined;
      }
      const page = state.page;
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.#timeout() });
        await page
          .waitForLoadState('load', { timeout: Math.min(5000, this.#timeout()) })
          .catch(() => undefined);
      } catch (error) {
        throw this.#failure(state, error, `open ${target}`);
      }
      return stateOf(page);
    });
  }

  async read(scope: BrowserScope, options: BrowserReadOptions): Promise<BrowserRead> {
    return this.#act(scope, async (state) => {
      const page = state.page;
      const target = options.ref === undefined ? undefined : await locate(page, options.ref);
      const timeout = this.#timeout();
      const rawText =
        target === undefined
          ? await page
              .locator('body')
              .innerText({ timeout: Math.min(5000, timeout) })
              .catch(() => '')
          : await target.innerText({ timeout });
      const rawTree =
        target === undefined
          ? await page.ariaSnapshot({ mode: 'ai', timeout })
          : await target.ariaSnapshot({ mode: 'ai', timeout });
      const { tree } = await redactPasswordValues(rawTree, (ref) =>
        isPasswordField(page, ref, Math.min(2000, timeout)),
      );
      const max = options.maxChars;
      return {
        ...(await stateOf(page)),
        text: rawText.slice(0, max),
        tree: tree.slice(0, max),
        truncated: rawText.length > max || tree.length > max,
      };
    });
  }

  async screenshot(scope: BrowserScope, ref?: string): Promise<BrowserShot> {
    return this.#act(scope, async (state) => {
      const page = state.page;
      const timeout = this.#timeout();
      const data =
        ref === undefined
          ? await page.screenshot({ type: 'png', timeout })
          : await (await locate(page, ref)).screenshot({ type: 'png', timeout });
      return {
        ...(await stateOf(page)),
        mimeType: 'image/png' as const,
        data: new Uint8Array(data),
      };
    });
  }

  async click(scope: BrowserScope, ref: string): Promise<BrowserPageState> {
    return this.#act(scope, async (state) => {
      const target = await locate(state.page, ref);
      state.popup = undefined;
      await target.click({ timeout: this.#timeout() });
      return this.#settle(state);
    });
  }

  async fill(scope: BrowserScope, ref: string, value: string): Promise<BrowserPageState> {
    return this.#act(scope, async (state) => {
      const target = await locate(state.page, ref);
      await target.fill(value, { timeout: this.#timeout() });
      return this.#settle(state);
    });
  }

  async pressKey(scope: BrowserScope, key: string): Promise<BrowserPageState> {
    return this.#act(scope, async (state) => {
      state.popup = undefined;
      try {
        await state.page.keyboard.press(key);
      } catch (error) {
        if (error instanceof Error && /unknown key/i.test(error.message)) {
          throw new InvalidInput(`"${key}" is not a key name Chromium knows.`, { cause: error });
        }
        throw error;
      }
      return this.#settle(state);
    });
  }

  async state(scenarioId: string): Promise<BrowserPageState | undefined> {
    const state = this.#states.get(scenarioId);
    if (state === undefined || state.instance.closed) return undefined;
    try {
      return await stateOf(state.page);
    } catch {
      return undefined;
    }
  }

  async closeScenario(scenarioId: string): Promise<void> {
    const state = this.#states.get(scenarioId);
    if (state === undefined) return;
    this.#states.delete(scenarioId);
    await state.chain.catch(() => undefined);
    const { instance } = state;
    instance.scenarios.delete(scenarioId);
    for (const page of state.pages) {
      instance.owners.delete(page);
      await page.close({ runBeforeUnload: false }).catch(() => undefined);
    }
    state.pages.clear();
    if (instance.key !== 'shared' || instance.scenarios.size === 0) {
      await this.#stop(instance);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const pending = [...this.#launching.values()];
    const settled = await Promise.allSettled(pending);
    const all = new Set<Instance>(this.#instances.values());
    for (const result of settled) {
      if (result.status === 'fulfilled') all.add(result.value);
    }
    this.#states.clear();
    await Promise.all([...all].map((instance) => this.#stop(instance)));
  }

  // ---- internals -----------------------------------------------------------------------------

  #timeout(): number {
    return this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Runs `body` for the open page of a scenario; there is no page to act on until `open`. */
  async #act<T>(scope: BrowserScope, body: (state: ScenarioState) => Promise<T>): Promise<T> {
    if (this.#closed) throw new AdapterUnavailable('The browser adapter is closed.');
    const state = this.#states.get(scope.scenarioId);
    if (state === undefined || state.instance.closed) {
      throw new NotFound('No page is open for this scenario: call browser_open first.');
    }
    return this.#serial(state, async () => {
      state.guard = scope.guard;
      try {
        return await body(state);
      } catch (error) {
        throw this.#failure(state, error, 'browser action');
      }
    });
  }

  /** Calls of one scenario run one after the other; `acting` says one is running (see `#route`). */
  #serial<T>(state: ScenarioState, body: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      state.acting += 1;
      try {
        return await body();
      } finally {
        state.acting -= 1;
      }
    };
    const run = state.chain.then(guarded, guarded);
    state.chain = run.catch(() => undefined);
    return run;
  }

  /** The state after an action: the load a click started (and the popup it opened) has begun. */
  async #settle(state: ScenarioState): Promise<BrowserPageState> {
    await sleep(SETTLE_MS);
    // A popup announces itself late (its first request has no frame, see `#route`): wait for it.
    const deadline = Date.now() + POPUP_WAIT_MS;
    while (state.popupPending && state.popup === undefined && Date.now() < deadline) {
      await sleep(50);
    }
    state.popupPending = false;
    if (state.popup !== undefined && !state.popup.isClosed()) {
      state.page = state.popup;
      state.popup = undefined;
    }
    const page = state.page;
    await page
      .waitForLoadState('domcontentloaded', { timeout: Math.min(5000, this.#timeout()) })
      .catch(() => undefined);
    return stateOf(page);
  }

  /** The error the port promises for what Playwright threw. */
  #failure(state: ScenarioState, error: unknown, what: string): Error {
    if (error instanceof OTheaterError) return error;
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
    if (message.includes('ERR_BLOCKED_BY_CLIENT')) {
      state.blockedAt = Date.now();
      return new PermissionDenied(
        state.lastRefusal === undefined
          ? `The page was refused by the browser rules (${what}).`
          : `The page was refused: ${state.lastRefusal}`,
        { cause: error },
      );
    }
    if (error instanceof playwrightErrors.TimeoutError) {
      return new Transient(`The page did not answer in time (${what}): ${message}`, {
        cause: error,
      });
    }
    if (
      /target (page, context or browser )?has been closed|browser has been closed|connection closed/i.test(
        message,
      )
    ) {
      state.instance.closed = true;
      return new Transient(`The browser closed during the call (${what}). Open the page again.`, {
        cause: error,
      });
    }
    if (message.includes('net::ERR_')) {
      return new Transient(`The page did not load (${what}): ${message}`, { cause: error });
    }
    if (error instanceof Error) return error;
    return new Error(message);
  }

  /** The state of the scenario, with its page: creates the page (and the browser) on the first call. */
  async #sessionFor(scope: BrowserScope): Promise<ScenarioState> {
    if (this.#closed) throw new AdapterUnavailable('The browser adapter is closed.');
    const known = this.#states.get(scope.scenarioId);
    if (known !== undefined && !known.instance.closed) {
      known.guard = scope.guard;
      return known;
    }
    if (known !== undefined) this.#states.delete(scope.scenarioId);
    const instance = await this.#instanceFor(scope);
    const again = this.#states.get(scope.scenarioId);
    if (again?.instance === instance && !instance.closed) return again;
    const first = instance.context.pages()[0];
    const page =
      scope.profile === 'per_scenario' && first !== undefined
        ? first
        : await instance.context.newPage();
    page.setDefaultTimeout(this.#timeout());
    page.setDefaultNavigationTimeout(this.#timeout());
    const state: ScenarioState = {
      scenarioId: scope.scenarioId,
      instance,
      guard: scope.guard,
      page,
      pages: new Set([page]),
      popup: undefined,
      popupPending: false,
      acting: 0,
      lastRefusal: undefined,
      blockedAt: undefined,
      chain: Promise.resolve(),
    };
    instance.owners.set(page, state);
    instance.scenarios.add(scope.scenarioId);
    page.on('close', () => state.pages.delete(page));
    this.#states.set(scope.scenarioId, state);
    return state;
  }

  #instanceFor(scope: BrowserScope): Promise<Instance> {
    const key = scope.profile === 'shared' ? 'shared' : `scenario:${scope.scenarioId}`;
    const live = this.#instances.get(key);
    if (live !== undefined && !live.closed) return Promise.resolve(live);
    const launching = this.#launching.get(key);
    if (launching !== undefined) return launching;
    const start = this.#start(key, scope).finally(() => this.#launching.delete(key));
    this.#launching.set(key, start);
    return start;
  }

  async #start(key: string, scope: BrowserScope): Promise<Instance> {
    const options = this.#options;
    admitBrowser({
      running: this.#instances.size + this.#launching.size,
      maxInstances: options.maxInstances ?? DEFAULT_MAX_INSTANCES,
      freeMemoryBytes: (options.freeMemoryBytes ?? freemem)(),
      minFreeMemoryBytes: options.minFreeMemoryBytes ?? DEFAULT_MIN_FREE_MEMORY_BYTES,
    });
    const executablePath = chromiumPath(options.executablePath);
    await assertChromiumInstalled(executablePath);
    const name = scope.profile === 'shared' ? 'shared' : `scenario-${slug(scope.scenarioId)}`;
    const base = join(options.profilesDir, name);
    const homeDir = join(base, 'home');
    const userDataDir = join(base, 'profile');
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    await mkdir(userDataDir, { recursive: true, mode: 0o700 });

    const limited = options.launcher.capabilities().memoryLimit;
    const running = await launchChromium(options.launcher, {
      executablePath,
      userDataDir,
      homeDir,
      sandbox: options.sandbox ?? true,
      launchTimeoutMs: options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
      cwd: base,
      ...(limited && options.memoryLimitBytes !== undefined
        ? { memoryLimitBytes: options.memoryLimitBytes }
        : {}),
    });
    try {
      const instance = await this.#connect(key, running);
      this.#instances.set(key, instance);
      return instance;
    } catch (cause) {
      await running.process.killTree({ graceMs: 1000 }).catch(() => undefined);
      throw new AdapterUnavailable(
        `Chromium started but the adapter could not drive it: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  }

  async #connect(key: string, running: RunningChromium): Promise<Instance> {
    const browser = await chromium.connectOverCDP(running.wsUrl, {
      timeout: this.#options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const instance: Instance = {
      key,
      process: running.process,
      browser,
      context,
      scenarios: new Set(),
      owners: new WeakMap(),
      closed: false,
    };
    browser.on('disconnected', () => {
      this.#dropped(instance);
    });
    void running.process.exited.then(() => {
      this.#dropped(instance);
    });
    await this.#denyDownloads(browser);
    await context.route('**/*', (route, request) => this.#route(instance, route, request));
    context.on('page', (page) => void this.#adopt(instance, page));
    return instance;
  }

  /** Downloads are refused at the browser: a page must not write a file on the machine. */
  async #denyDownloads(browser: Browser): Promise<void> {
    try {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    } catch (error) {
      this.#options.onWarning?.(
        `Downloads could not be turned off in Chromium: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The browser went away (it crashed or was closed): its scenarios have no page any more. */
  #dropped(instance: Instance): void {
    instance.closed = true;
    if (this.#instances.get(instance.key) === instance) this.#instances.delete(instance.key);
    for (const [id, state] of this.#states) {
      if (state.instance === instance) this.#states.delete(id);
    }
  }

  /** A page that appeared in the browser: a popup of a page of ours belongs to the same scenario. */
  async #adopt(instance: Instance, page: Page): Promise<void> {
    if (instance.owners.has(page)) return;
    const owner = await ownerOfPage(instance, page);
    if (owner === undefined) return;
    if (owner.pages.size >= MAX_PAGES_PER_SCENARIO) {
      await page.close().catch(() => undefined);
      return;
    }
    instance.owners.set(page, owner);
    owner.pages.add(page);
    owner.popup = page;
    owner.popupPending = false;
    page.setDefaultTimeout(this.#timeout());
    page.on('close', () => owner.pages.delete(page));
  }

  /** The one gate: every request of every page of the browser is decided here. */
  async #route(instance: Instance, route: Route, request: Request): Promise<void> {
    const url = request.url();
    const navigation = request.isNavigationRequest();
    let judges: ScenarioState[] = [];
    let reason: string | undefined;
    if (url.startsWith('file:')) {
      reason =
        'file: URLs are never loaded by the browser; the daemon serves files on its own origin';
    } else {
      judges = await this.#judges(instance, request, navigation);
      if (judges.length === 0) reason = 'the request comes from a page no scenario owns';
    }
    // Every judge must allow (a popup with no known opener has more than one).
    for (const judge of reason === undefined ? judges : []) {
      let verdict: BrowserVerdict;
      try {
        verdict = await judge.guard({ url, navigation });
      } catch {
        verdict = {
          allow: false,
          reason: 'the rule of the browser failed, so the request was refused',
        };
      }
      if (!verdict.allow) {
        reason = verdict.reason;
        judge.lastRefusal = verdict.reason;
        break;
      }
    }
    if (reason !== undefined) {
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    if (!hasFrame(request)) for (const judge of judges) judge.popupPending = true;
    await route.continue().catch(() => undefined);
  }

  /**
   * The scenarios whose guard decides a request: the owner of the page it comes from. [V] The first
   * request of a popup has NO frame yet (Playwright throws on `request.frame()`), so nobody can say
   * which page opened it: the guards of EVERY scenario of the browser that has a call running (a
   * click, a key) all must allow it, and a popup that opens while nobody acts is refused. Once the
   * popup exists, its requests are owned through its opener like any other page.
   */
  async #judges(
    instance: Instance,
    request: Request,
    navigation: boolean,
  ): Promise<ScenarioState[]> {
    if (hasFrame(request)) {
      const owner = await ownerOfPage(instance, request.frame().page());
      return owner === undefined ? [] : [owner];
    }
    if (!navigation) return [];
    const acting: ScenarioState[] = [];
    for (const id of instance.scenarios) {
      const state = this.#states.get(id);
      if (state?.instance === instance && state.acting > 0) acting.push(state);
    }
    return acting;
  }

  async #stop(instance: Instance): Promise<void> {
    instance.closed = true;
    if (this.#instances.get(instance.key) === instance) this.#instances.delete(instance.key);
    await Promise.race([instance.browser.close().catch(() => undefined), sleep(3000)]);
    await instance.process.killTree({ graceMs: 2000 }).catch(() => undefined);
  }
}

/** The scenario that owns `page`: its own, or the one of the page that opened it (up the chain). */
async function ownerOfPage(instance: Instance, page: Page): Promise<ScenarioState | undefined> {
  let current: Page | null = page;
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    const owner = instance.owners.get(current);
    if (owner !== undefined) return owner;
    current = await current.opener().catch(() => null);
  }
  return undefined;
}

/** Only `http` and `https` are opened by `open`; `file:` is the daemon's to serve (never here). */
function parseNavigable(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new InvalidInput(`"${url}" is not an absolute URL.`, { cause });
  }
  if (parsed.protocol === 'file:') {
    throw new PermissionDenied(
      'file: URLs are never opened by the browser adapter; the daemon serves files on its own origin.',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PermissionDenied(`Only http and https pages are opened (got "${parsed.protocol}").`);
  }
  return parsed.href;
}

async function stateOf(page: Page): Promise<BrowserPageState> {
  return { url: page.url(), title: await page.title().catch(() => '') };
}

/** The element behind a `ref` of the last `read`; a ref the page does not know is `NotFound`. */
async function locate(page: Page, ref: string): Promise<Locator> {
  if (!REF_PATTERN.test(ref)) {
    throw new InvalidInput(`"${ref}" is not a ref: use one from the last browser_read.`);
  }
  const locator = page.locator(`aria-ref=${ref}`);
  const count = await locator.count().catch(() => 0);
  if (count !== 1) {
    throw new NotFound(`The ref "${ref}" is not on the page (any more): read the page again.`);
  }
  return locator;
}

/** True when the element is a password field, or when that cannot be told (fails closed). */
async function isPasswordField(page: Page, ref: string, timeout: number): Promise<boolean> {
  try {
    return await page
      .locator(`aria-ref=${ref}`)
      .evaluate(
        (el) => el instanceof HTMLInputElement && el.type.toLowerCase() === 'password',
        undefined,
        {
          timeout,
        },
      );
  } catch {
    return true;
  }
}

/** A directory name for a scenario id: readable part plus a hash, so no id can climb out of the folder. */
function slug(scenarioId: string): string {
  const readable = scenarioId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const hash = createHash('sha256').update(scenarioId).digest('hex').slice(0, 12);
  return `${readable}-${hash}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Playwright throws on `request.frame()` for the first request of a popup (the frame does not exist yet). */
function hasFrame(request: Request): boolean {
  try {
    request.frame();
    return true;
  } catch {
    return false;
  }
}
