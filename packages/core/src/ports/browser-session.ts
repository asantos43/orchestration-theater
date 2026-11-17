// SPDX-License-Identifier: MPL-2.0
import type { Adapter } from './adapter.js';

/** Semver of the `BrowserSession` port contract (architecture 5.18, "Versão dos contratos"). */
export const BROWSER_SESSION_PORT_VERSION = '0.1.0';

/**
 * The profiles an adapter can run (architecture 5.19, N40): `shared` is one profile of OTheater for
 * every scenario, `per_scenario` is one isolated profile for each. `extension` and `import` are
 * profile modes of the configuration that no adapter of this phase has; they are not here.
 */
export const BROWSER_PROFILE_MODES = ['shared', 'per_scenario'] as const;
export type BrowserProfileMode = (typeof BROWSER_PROFILE_MODES)[number];

/** One request of a page, as the guard sees it before it leaves the browser. */
export interface BrowserRequest {
  /** The absolute URL, as the browser is about to ask for it (redirects and sub-resources included). */
  readonly url: string;
  /** The request loads a document in a frame (a page, an iframe, a popup); false for an image, a script... */
  readonly navigation: boolean;
}

export type BrowserVerdict =
  | { readonly allow: true }
  /** `reason` goes to the log and to the error the agent reads. */
  | { readonly allow: false; readonly reason: string };

/**
 * The rule of a scenario for what its page may load (architecture 5.19, "Como o `file://` é
 * aplicado"). The DAEMON owns the rule and the adapter calls it for EVERY request of the pages of
 * the scope, so a redirect, a popup or an image obeys it too, not only the URL the agent typed.
 * It must not throw: a throw counts as a refusal.
 */
export type BrowserGuard = (request: BrowserRequest) => BrowserVerdict | Promise<BrowserVerdict>;

/** What every call tells the adapter: whose session, which profile, and the rule of the moment. */
export interface BrowserScope {
  readonly scenarioId: string;
  readonly profile: BrowserProfileMode;
  /** Replaces the guard of the scenario's pages: the latest call wins (the configuration may change). */
  readonly guard: BrowserGuard;
}

/** Where the page is. */
export interface BrowserPageState {
  readonly url: string;
  readonly title: string;
}

export interface BrowserReadOptions {
  /** A `ref` of the last `read`: only that element. Omitted: the whole page. */
  readonly ref?: string | undefined;
  /** The longest `text` and `tree` the adapter returns, each, in characters. */
  readonly maxChars: number;
}

/** The page as data: the visible text and the accessibility tree with a `ref` for each element. */
export interface BrowserRead extends BrowserPageState {
  readonly text: string;
  /** Roles, names and `[ref=...]`; the value of a password field is never in it. */
  readonly tree: string;
  /** `text` or `tree` was cut at `maxChars`. */
  readonly truncated: boolean;
}

export interface BrowserShot extends BrowserPageState {
  readonly mimeType: 'image/png';
  readonly data: Uint8Array;
}

export interface BrowserCapabilities {
  readonly profiles: readonly BrowserProfileMode[];
  /** The adapter drives the browser of the Producer (`browser.profile: extension`). Phase 12. */
  readonly extension: boolean;
}

/**
 * The browser the agent works in (architecture 5.19): one page for each scenario, in a browser
 * that belongs to the daemon. The Playwright adapter runs Chromium as a child of the daemon, under
 * the process launcher and the RAM admission (5.9); an adapter for the Producer's own browser
 * (extension, Phase 12) implements the same port.
 *
 * Contract:
 * - Every call carries the {@link BrowserScope}; the session of a scenario starts with its first
 *   call and ends with {@link closeScenario}.
 * - Every request of the pages of a scope goes through its guard first. A page that the guard
 *   refuses fails to load; a refused `open` rejects with `PermissionDenied`. The `file:` scheme is
 *   never loaded by an adapter, with or without a guard: the daemon serves files on its own origin.
 * - `read` never returns a cookie or the value of a password field.
 * - `ref` is valid until the next `read`; an unknown or stale one rejects with `NotFound` (read
 *   again), never a click somewhere else.
 * - `AdapterUnavailable`: no browser on this machine, or not enough free RAM to start one.
 * - `Transient`: the page did not answer within the adapter's time limit.
 */
export interface BrowserSession extends Adapter {
  capabilities(): BrowserCapabilities;
  open(scope: BrowserScope, url: string): Promise<BrowserPageState>;
  read(scope: BrowserScope, options: BrowserReadOptions): Promise<BrowserRead>;
  screenshot(scope: BrowserScope, ref?: string): Promise<BrowserShot>;
  click(scope: BrowserScope, ref: string): Promise<BrowserPageState>;
  fill(scope: BrowserScope, ref: string, value: string): Promise<BrowserPageState>;
  pressKey(scope: BrowserScope, key: string): Promise<BrowserPageState>;
  /** Where the scenario's page is, without starting a browser for it; `undefined` when it has none. */
  state(scenarioId: string): Promise<BrowserPageState | undefined>;
  /** Ends the page of a scenario and, in `per_scenario`, its browser. Idempotent. */
  closeScenario(scenarioId: string): Promise<void>;
  /** Ends every browser. Idempotent; never rejects. */
  close(): Promise<void>;
}
