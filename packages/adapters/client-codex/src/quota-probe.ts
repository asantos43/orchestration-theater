// SPDX-License-Identifier: MPL-2.0
import {
  AdapterUnavailable,
  InvalidInput,
  OTheaterError,
  QUOTA_PROBE_PORT_VERSION,
  Transient,
  type AdapterImplements,
  type Disposable,
  type ProcessLauncher,
  type ProfileRef,
  type QuotaCapabilities,
  type QuotaProbe,
  type QuotaReading,
} from '@otheater/core';
import {
  AppServerRpcError,
  AppServerSession,
  looksLikeAuthFailure,
  type AppServerLaunch,
} from './app-server-session.js';
import { APP_SERVER_METHODS, type CodexGetRateLimitsParams } from './app-server-types.js';
import {
  mergeUpdate,
  readingOf,
  viewOfReadResult,
  viewOfUpdate,
  type RateLimitView,
} from './rate-limits.js';

/** `clients.codex.quota.command`: what starts the app-server. Default `codex app-server`. */
export const DEFAULT_QUOTA_COMMAND = {
  cmd: 'codex',
  args: ['app-server'] as readonly string[],
} as const;

/** `clients.codex.quota.timeout`: a read that takes longer is ended with its tree. Default 15 s (a read took 0.4 to 0.7 s [V]). */
export const DEFAULT_QUOTA_TIMEOUT_MS = 15_000;

/** `clients.codex.quota.watch`: `off` (default) or `resident`. */
export const QUOTA_WATCH_MODES = ['off', 'resident'] as const;
export type QuotaWatchMode = (typeof QUOTA_WATCH_MODES)[number];

/** What the app-server is told about the client that talks to it. */
const CLIENT_INFO = { name: 'otheater', title: 'OTheater', version: '0.0.0' } as const;

export interface CodexQuotaProbeOptions {
  /** Starts the process. The launcher's `killTree` ends it, so no read leaves an orphan. */
  readonly launcher: ProcessLauncher;
  /** The environment of the daemon, without the profile's variable (it is added per profile). */
  readonly baseEnv: Readonly<Record<string, string>>;
  /** The directory of a profile: `CODEX_HOME` of its app-server, and its working directory. */
  profileDir(profile: ProfileRef): string;
  /** `CODEX_HOME` of a profile directory. Default `{ CODEX_HOME: dir }`. */
  profileEnv?(dir: string): Record<string, string>;
  /** Runs before the app-server starts: the adapter writes `config.toml` here. Never reads credentials. */
  prepare?(profile: ProfileRef, dir: string): Promise<void>;
  /** `clients.codex.quota.command`. */
  readonly command?: { readonly cmd: string; readonly args: readonly string[] };
  /** `clients.codex.quota.timeout`, in ms. */
  readonly timeoutMs?: number;
  /**
   * `clients.codex.quota.watch`. `off` (default): every reading is a `read` that starts the
   * app-server, asks once and ends it; the delivery is `poll`. `resident`: `watch` keeps one
   * app-server per watched profile and takes its `account/rateLimits/updated`; the delivery is `both`.
   */
  readonly watch?: QuotaWatchMode;
  /** The windows the probe promises to report (`capabilities().windows`). Default none: it reports those the account has. */
  readonly windows?: readonly string[];
  /** The clock of `observedAt`, epoch ms. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * The quota probe of Codex (architecture 5.6). The numbers come from `account/rateLimits/read` of
 * the official app-server, started inside the profile (`CODEX_HOME`) [V: Phase 0, `spikes/quota-probes`]:
 * a window in percent, its length and its reset. The probe only asks and translates; the
 * `QuotaService` decides freshness and state.
 *
 * - `read`: starts `codex app-server`, `initialize`, `account/rateLimits/read`, ends the tree.
 *   A profile with no login ends in `AdapterUnavailable`, which the service keeps as `unknown`; it is
 *   never read as `exhausted`. No file of the profile is opened: the client reads its own login.
 * - `watch` (only with `watch: 'resident'`): the same conversation kept open; each
 *   `account/rateLimits/updated` is merged into the last view and delivered. [V] Phase 0 saw no
 *   `updated` without a model turn, so the polling stays the base and the push only brings the
 *   change sooner; what `updated` carries during real turns is [N].
 *
 * What the app-server costs: ~114 MB of memory while it lives [V], which is why the default
 * does not keep it.
 */
export class CodexQuotaProbe implements QuotaProbe {
  readonly id = 'codex';
  readonly implements: AdapterImplements = {
    port: 'QuotaProbe',
    range: `^${QUOTA_PROBE_PORT_VERSION}`,
  };

  readonly #options: CodexQuotaProbeOptions;
  readonly #command: { readonly cmd: string; readonly args: readonly string[] };
  readonly #timeoutMs: number;
  readonly #watch: QuotaWatchMode;
  readonly #now: () => number;

  constructor(options: CodexQuotaProbeOptions) {
    this.#options = options;
    this.#command = options.command ?? DEFAULT_QUOTA_COMMAND;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_QUOTA_TIMEOUT_MS;
    this.#watch = options.watch ?? 'off';
    this.#now = options.now ?? (() => Date.now());
    if (!QUOTA_WATCH_MODES.includes(this.#watch)) {
      throw new InvalidInput(`codex: quota watch ${this.#watch} is not supported`);
    }
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new InvalidInput('codex: the quota timeout must be a positive number');
    }
  }

  capabilities(): QuotaCapabilities {
    return {
      windows: [...(this.#options.windows ?? [])],
      delivery: this.#watch === 'resident' ? 'both' : 'poll',
      precision: 'approximate',
    };
  }

  async read(profile: ProfileRef): Promise<QuotaReading> {
    const session = await this.#start(profile);
    try {
      const view = await within(this.#timeoutMs, session, () => this.#handshakeAndRead(session));
      return readingOf(view, this.#now());
    } finally {
      await session.close();
    }
  }

  watch(profile: ProfileRef, onChange: (reading: QuotaReading) => void): Disposable {
    if (this.#watch !== 'resident') return { dispose: () => undefined };
    const flags = { disposed: false };
    const isDisposed = (): boolean => flags.disposed;
    let session: AppServerSession | undefined;
    const deliver = (view: RateLimitView): void => {
      try {
        onChange(readingOf(view, this.#now()));
      } catch {
        // A view with no window is not a reading; the last one stays, and the service ages it.
      }
    };
    void (async () => {
      try {
        const opened = await this.#start(profile);
        if (isDisposed()) {
          await opened.close();
          return;
        }
        session = opened;
        const state: { last?: RateLimitView } = {};
        opened.onNotification((method, params) => {
          if (method !== APP_SERVER_METHODS.rateLimitsUpdated || state.last === undefined) return;
          const update = viewOfUpdate(params);
          if (update === undefined) return;
          state.last = mergeUpdate(state.last, update);
          deliver(state.last);
        });
        const first = await within(this.#timeoutMs, opened, () => this.#handshakeAndRead(opened));
        state.last = first;
        if (!isDisposed()) deliver(first);
        await opened.closed;
      } catch {
        // No login, no client or an app-server that ended: the polling of the service goes on.
      } finally {
        await session?.close();
      }
    })();
    return {
      dispose: () => {
        flags.disposed = true;
        void session?.close();
      },
    };
  }

  async #start(profile: ProfileRef): Promise<AppServerSession> {
    const dir = this.#options.profileDir(profile);
    try {
      await this.#options.prepare?.(profile, dir);
    } catch (error) {
      if (error instanceof OTheaterError) throw error;
      throw new Transient(`codex: cannot prepare the profile for the quota read`, {
        cause: error,
      });
    }
    const where: AppServerLaunch = {
      launcher: this.#options.launcher,
      cmd: this.#command.cmd,
      args: this.#command.args,
      cwd: dir,
      env: {
        ...this.#options.baseEnv,
        ...(this.#options.profileEnv?.(dir) ?? { CODEX_HOME: dir }),
      },
    };
    return AppServerSession.open(where);
  }

  /** `initialize`, `initialized`, then the read of the rate limits. The only requests the probe ever makes. */
  async #handshakeAndRead(session: AppServerSession): Promise<RateLimitView> {
    try {
      await session.request(APP_SERVER_METHODS.initialize, { clientInfo: CLIENT_INFO });
      await session.notify(APP_SERVER_METHODS.initialized);
      const params: CodexGetRateLimitsParams = { excludeResetCreditDetails: true };
      return viewOfReadResult(await session.request(APP_SERVER_METHODS.readRateLimits, params));
    } catch (error) {
      throw classify(error);
    }
  }
}

/** Errors of the conversation as the port says them: no login and no source are `AdapterUnavailable`, the rest `Transient`. */
function classify(error: unknown): Error {
  if (error instanceof OTheaterError) return error;
  if (error instanceof AppServerRpcError) {
    const text = `codex app-server: ${error.message}`;
    return looksLikeAuthFailure(error.message)
      ? new AdapterUnavailable(`${text} (the profile has no login)`, { cause: error })
      : new Transient(text, { cause: error });
  }
  return new Transient('codex: the quota read failed', { cause: error });
}

/**
 * Runs `work` for at most `ms`. On the deadline the process is ended with its whole tree and the
 * call rejects with `Transient`; the caller's `finally` closes it again, harmlessly.
 */
async function within<T>(
  ms: number,
  session: AppServerSession,
  work: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void session.close();
      reject(new Transient(`codex app-server did not answer in ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
