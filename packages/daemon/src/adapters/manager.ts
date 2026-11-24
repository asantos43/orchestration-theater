// SPDX-License-Identifier: MPL-2.0
import { isAbsolute } from 'node:path';
import { AdapterUnavailable } from '@otheater/core';
import type { FindExecutable } from '../clients.js';
import { ADAPTER_SOURCES, type AdapterInstallMode, type ClientId } from '../config.js';
import type { Logger } from '../logger.js';
import { resolveAdapterCommand, type SelfCommandDeps } from '../sea/self-command.js';
import { situationSubject, situationText, type SituationSink } from '../situations.js';
import {
  adapterDir,
  adapterEntry,
  AdapterInstallError,
  DEFAULT_REGISTRY,
  installAdapter,
  isInstalledSync,
  type InstallEvent,
  type InstallResult,
} from './install.js';
import {
  adapterLock,
  hostPlatform,
  type AdapterId,
  type AdapterLock,
  type InstallPlatform,
} from './lock.js';

/**
 * The managed ACP adapters at run time (Phase 10, P13; N254 revised): where each is installed,
 * what command starts it, what the daemon does when it is missing. One place for the three callers
 * (the `ClientFactory` in `compose.ts`, `ot init` and `ot adapters`).
 */

/** The clients that have an ACP adapter OTheater can install (OpenCode speaks ACP by itself). */
export const MANAGED_CLIENT_IDS = ['claude-code', 'codex'] as const satisfies readonly ClientId[];
export type ManagedClientId = (typeof MANAGED_CLIENT_IDS)[number];

export function isManagedClient(id: string): id is ManagedClientId {
  return (MANAGED_CLIENT_IDS as readonly string[]).includes(id);
}

export interface ManagedClientSpec {
  readonly adapter: AdapterId;
  /** The official client, which the adapter drives and which stays the user's own install. */
  readonly official: string;
  /** What the adapter is called in `PATH` when the user installed it by hand. */
  readonly pathCommand: string;
  /** The variable that tells the adapter which official client to use (so it never needs its bundled one). */
  readonly officialEnv: string;
}

export const MANAGED_CLIENTS: Readonly<Record<ManagedClientId, ManagedClientSpec>> = {
  'claude-code': {
    adapter: 'claude-agent-acp',
    official: 'claude',
    pathCommand: 'claude-agent-acp',
    officialEnv: 'CLAUDE_CODE_EXECUTABLE',
  },
  codex: {
    adapter: 'codex-acp',
    official: 'codex',
    pathCommand: 'codex-acp',
    officialEnv: 'CODEX_PATH',
  },
};

/** What starts an adapter, in the shape `ClientAdapter` takes. */
export interface AdapterCommand {
  readonly cmd: string;
  readonly args: readonly string[];
}

/** What `ot adapters status` and `ot init` show for one client. */
export interface AdapterStatus {
  readonly client: ManagedClientId;
  readonly adapter: AdapterId;
  /** The pinned version OTheater installs. */
  readonly version: string;
  readonly installed: boolean;
  /** `<data>/adapters/<id>/<version>`. */
  readonly dir: string;
  /** The adapter's entry script inside `dir`. */
  readonly entry: string;
  /** The official client found in `PATH`. */
  readonly officialPath: string | undefined;
  /** The adapter found in `PATH` (installed by hand). */
  readonly pathAdapter: string | undefined;
  /** An install is running now. */
  readonly installing: boolean;
  /** Why the last install of this process failed. */
  readonly failure: string | undefined;
}

export interface AdapterManagerOptions {
  /** `<data>/adapters`. */
  readonly adaptersDir: string;
  /** `clients.adapters.install`. */
  readonly install: AdapterInstallMode;
  /** `clients.adapters.registry`. Default {@link DEFAULT_REGISTRY}. */
  readonly registry?: string | undefined;
  /** `clients.adapters.redirect_hosts`, `redirect_max` and `tar_max_entries`. */
  readonly redirectHosts?: readonly string[] | undefined;
  readonly redirectMax?: number | undefined;
  readonly tarMaxEntries?: number | undefined;
  readonly find: FindExecutable;
  readonly logger?: Pick<Logger, 'info' | 'warn'> | undefined;
  /** Where the notices go as `daemon.notice`. Absent: only the log. */
  readonly situations?: SituationSink | undefined;
  /** Default the global `fetch`. Tests point it at a fake registry. */
  readonly fetch?: typeof fetch | undefined;
  /** Default the host's. */
  readonly platform?: InstallPlatform | undefined;
  /** How the program starts itself (the single executable or the checkout). Default the real one. */
  readonly self?: SelfCommandDeps | undefined;
  /** The pinned lock of each adapter. Default the shipped ones; tests hand over a small fixture. */
  readonly lockOf?: ((id: AdapterId) => AdapterLock) | undefined;
  /** Passed to the installer (tests shorten the waits). */
  readonly installOptions?:
    | { readonly retryDelayMs?: number; readonly retries?: number; readonly lockWaitMs?: number }
    | undefined;
}

/** The text the person reads when an adapter is missing and nothing installs it by itself. */
export function missingAdapterHint(client: ManagedClientId): string {
  const { adapter } = MANAGED_CLIENTS[client];
  return `the ACP adapter ${adapter} is not installed: run "ot adapters install" (or set clients.adapters.install to auto)`;
}

export class AdapterManager {
  readonly #o: AdapterManagerOptions;
  readonly #running = new Map<ManagedClientId, Promise<InstallResult>>();
  readonly #failed = new Map<ManagedClientId, string>();
  readonly #told = new Set<string>();

  constructor(options: AdapterManagerOptions) {
    this.#o = options;
  }

  #lock(id: AdapterId): AdapterLock {
    return (this.#o.lockOf ?? adapterLock)(id);
  }

  get mode(): AdapterInstallMode {
    return this.#o.install;
  }

  /** Whether the daemon installs by itself, in the background, what is missing. */
  get installsByItself(): boolean {
    return this.#o.install === 'auto';
  }

  status(client: ManagedClientId): AdapterStatus {
    const spec = MANAGED_CLIENTS[client];
    const lock = this.#lock(spec.adapter);
    const dir = adapterDir(this.#o.adaptersDir, lock);
    return {
      client,
      adapter: spec.adapter,
      version: lock.version,
      installed: isInstalledSync(dir, lock),
      dir,
      entry: adapterEntry(dir, lock),
      officialPath: this.#o.find(spec.official),
      pathAdapter: this.#o.find(spec.pathCommand),
      installing: this.#running.has(client),
      failure: this.#failed.get(client),
    };
  }

  /**
   * The environment that points the adapter at the user's own official client, found in `PATH`
   * (the bundled copy the adapters carry is never installed). Empty when it was not found.
   */
  officialEnv(client: ManagedClientId): Readonly<Record<string, string>> {
    const spec = MANAGED_CLIENTS[client];
    const found = this.#o.find(spec.official);
    return found === undefined ? {} : { [spec.officialEnv]: found };
  }

  /**
   * What starts the adapter of `client` now, for `clients.<id>.adapter` = `source` (synchronous: the
   * adapter asks it every time a process starts). `managed` is the installed one, else the one in
   * `PATH` with a warning and an event, else {@link AdapterUnavailable} saying what is missing.
   */
  commandFor(client: ManagedClientId, source: string): AdapterCommand {
    const spec = MANAGED_CLIENTS[client];
    if (isAbsolute(source)) return { cmd: source, args: [] };
    if (source === 'path') {
      if (this.#o.find(spec.pathCommand) === undefined) {
        throw new AdapterUnavailable(
          `clients.${client}.adapter is "path" but ${spec.pathCommand} is not in PATH: install it, or set the key to "managed" and run "ot adapters install"`,
        );
      }
      return { cmd: spec.pathCommand, args: [] };
    }
    if (source !== 'managed') {
      throw new AdapterUnavailable(
        `clients.${client}.adapter must be one of ${ADAPTER_SOURCES.join(', ')} or an absolute path`,
      );
    }
    const status = this.status(client);
    if (status.installed) {
      const { command, args } = resolveAdapterCommand(status.entry, this.#o.self);
      return { cmd: command, args };
    }
    const reason = this.#whyNotManaged(status);
    if (status.pathAdapter !== undefined) {
      this.#tell(
        'adapter_fallback',
        status.adapter,
        `${reason}; ${status.pathAdapter} runs instead`,
      );
      return { cmd: spec.pathCommand, args: [] };
    }
    throw new AdapterUnavailable(`${reason}; ${spec.pathCommand} is not in PATH either`);
  }

  #whyNotManaged(status: AdapterStatus): string {
    if (status.installing) {
      return `the ACP adapter ${status.adapter} is being installed, try again in a moment`;
    }
    if (status.failure !== undefined) {
      return `the ACP adapter ${status.adapter} could not be installed (${status.failure}); run "ot adapters install" to try again`;
    }
    return missingAdapterHint(status.client);
  }

  /** Writes a log line and a `daemon.notice`, once per kind and subject and detail. */
  #tell(
    kind:
      | 'adapter_installing'
      | 'adapter_installed'
      | 'adapter_install_failed'
      | 'adapter_missing'
      | 'adapter_fallback',
    subject: string,
    detail: string,
  ): void {
    const key = `${kind}\0${subject}\0${detail}`;
    if (this.#told.has(key)) return;
    this.#told.add(key);
    const log = kind === 'adapter_install_failed' || kind === 'adapter_fallback' ? 'warn' : 'info';
    this.#o.logger?.[log]({ adapter: subject, kind }, detail);
    this.#o.situations?.record('daemon.notice', {
      kind,
      subject: situationSubject(subject),
      detail: situationText(detail),
    });
  }

  /**
   * Installs the adapter of `client` (the pinned version, from `clients.adapters.registry`), once at
   * a time per client: a second call waits for the first. Writes the notices of the progress.
   * Rejects with {@link AdapterInstallError} (and remembers why, for {@link status}).
   */
  ensure(client: ManagedClientId): Promise<InstallResult> {
    const running = this.#running.get(client);
    if (running !== undefined) return running;
    const spec = MANAGED_CLIENTS[client];
    const lock = this.#lock(spec.adapter);
    const registry = this.#o.registry ?? DEFAULT_REGISTRY;
    const attempt = (async (): Promise<InstallResult> => {
      try {
        const result = await installAdapter({
          lock,
          adaptersDir: this.#o.adaptersDir,
          registry,
          ...(this.#o.redirectHosts === undefined ? {} : { redirectHosts: this.#o.redirectHosts }),
          ...(this.#o.redirectMax === undefined ? {} : { redirectMax: this.#o.redirectMax }),
          ...(this.#o.tarMaxEntries === undefined ? {} : { tarMaxEntries: this.#o.tarMaxEntries }),
          platform: this.#o.platform ?? hostPlatform(),
          ...(this.#o.fetch === undefined ? {} : { fetch: this.#o.fetch }),
          ...this.#o.installOptions,
          onEvent: (event) => {
            this.#onInstall(event, registry);
          },
        });
        this.#failed.delete(client);
        return result;
      } catch (error) {
        this.#failed.set(
          client,
          error instanceof AdapterInstallError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.message
              : String(error),
        );
        throw error;
      } finally {
        this.#running.delete(client);
      }
    })();
    this.#running.set(client, attempt);
    return attempt;
  }

  #onInstall(event: InstallEvent, registry: string): void {
    if (event.phase === 'start') {
      this.#told.delete(`adapter_installed\0${event.id}\0${event.version}`);
      this.#tell(
        'adapter_installing',
        event.id,
        `downloading ${event.id} ${event.version} (${String(event.packages)} packages) from ${registry}`,
      );
    } else if (event.phase === 'done') {
      this.#tell('adapter_installed', event.id, `${event.id} ${event.version} is installed`);
    } else {
      // A new attempt may fail with the same text again: it is told again.
      this.#told.delete(`adapter_install_failed\0${event.id}\0${event.code}: ${event.message}`);
      this.#tell('adapter_install_failed', event.id, `${event.code}: ${event.message}`);
    }
  }

  /**
   * What the daemon does at start for each managed client that is on and needs its adapter:
   * with `install: auto` it installs in the background (never blocks, never throws); with another
   * mode it only says what is missing (`adapter_missing`) so `ot init` or the person can act.
   */
  prepare(clients: readonly ManagedClientId[]): void {
    for (const client of clients) {
      const status = this.status(client);
      if (status.installed || status.officialPath === undefined) continue;
      if (this.#o.install === 'auto') {
        this.ensure(client).catch(() => {
          // Told by the notice and kept in `failure`; the start of a session says it again.
        });
      } else if (status.pathAdapter === undefined) {
        this.#tell(
          'adapter_missing',
          status.adapter,
          this.#o.install === 'off'
            ? `${status.adapter} is not installed and clients.adapters.install is off; install it yourself and set clients.${client}.adapter to "path"`
            : missingAdapterHint(client),
        );
      }
    }
  }

  /** Resolves when the installs started by {@link prepare} or {@link ensure} have ended. For tests and shutdown. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#running.values()]);
  }
}
